/*
 * Student QR API routes (app/api/students/me/qr/*), end to end in-process:
 * the REAL routes, T4 service, T3 crypto and PNG rendering. Faked edges: the
 * session (lib/auth-session.ts, mirroring its 401 rules) and Prisma (a small
 * in-memory store). Every PNG is decoded with jsQR.
 *
 *   npm run test:student-qr
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const jsQR = require("jsqr");
const { PNG } = require(require.resolve("pngjs", { paths: [path.dirname(require.resolve("qrcode"))] }));
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

const APP_ORIGIN = "https://app.example.test";
const SECRET = crypto.createHash("sha512").update("student qr route tests").digest("base64");

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

// ---------------------------------------------------------------- fake session

let session = null; // { role, userId }
const calls = { requireStudentSession: 0 };
fake("lib/auth-session.ts", {
  requireStudentSession: async () => {
    calls.requireStudentSession += 1;
    if (!session) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    if (session.role !== "STUDENT") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { studentId: session.userId, email: "s@example.test", name: "S", role: "STUDENT" };
  },
  requireTeacherSession: async () => {
    throw new Error("not used");
  },
  requireAppSession: async () => {
    throw new Error("not used");
  },
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

// ---------------------------------------------------------------- fake prisma

const store = { students: new Map(), tokens: [] };
const pick = (row, select) => {
  if (!select) return { ...row };
  const out = {};
  for (const [key, value] of Object.entries(select)) {
    if (!value) continue;
    if (key === "student") {
      out.student = pick(store.students.get(row.studentId), value.select);
    } else out[key] = row[key];
  }
  return out;
};
const tokenMatches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("gt" in cond) return row[key] > cond.gt;
      throw new Error(`unsupported condition on ${key}`);
    }
    return row[key] === cond;
  });
const client = {
  student: {
    findFirst: async ({ where, select }) => {
      const s = store.students.get(where.id);
      if (!s) return null;
      if (where.status && "not" in where.status && s.status === where.status.not) return null;
      return pick(s, select);
    },
  },
  studentQrToken: {
    findFirst: async ({ where, select }) => {
      const row = store.tokens.find((t) => tokenMatches(t, where));
      return row ? pick(row, select) : null;
    },
    findMany: async ({ where, select }) =>
      store.tokens
        .filter((t) => tokenMatches(t, where))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((t) => pick(t, select)),
    findUnique: async ({ where, select }) => {
      const row = store.tokens.find((t) => t.tokenHash === where.tokenHash);
      return row ? pick(row, select) : null;
    },
    updateMany: async ({ where, data }) => {
      const rows = store.tokens.filter((t) => tokenMatches(t, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
    create: async ({ data, select }) => {
      if (store.tokens.some((t) => t.studentId === data.studentId && t.revokedAt === null)) {
        throw new Error("fake: second active token");
      }
      const row = { revokedAt: null, revokedByRole: null, revokedById: null, revokedReason: null, createdById: null, ...data };
      store.tokens.push(row);
      return pick(row, select);
    },
  },
  $queryRaw: async (strings, ...values) => {
    assert.match(strings.join("?"), /FROM "Student" WHERE "id" = \? FOR NO KEY UPDATE/);
    const s = store.students.get(values[0]);
    return s ? [{ id: s.id, teacherId: s.teacherId, status: s.status }] : [];
  },
  $transaction: async (fn) => fn(client),
};
fake("lib/prisma.ts", { prisma: client });

const qrRoute = require(path.join(root, "app", "api", "students", "me", "qr", "route.ts"));
const statusRoute = require(path.join(root, "app", "api", "students", "me", "qr", "status", "route.ts"));
const regenerateRoute = require(path.join(root, "app", "api", "students", "me", "qr", "regenerate", "route.ts"));
const issueRoute = require(path.join(root, "app", "api", "students", "me", "qr", "issue", "route.ts"));
const { middleware } = require(path.join(root, "middleware.ts"));

// ---------------------------------------------------------------- helpers

const S1 = "student-one";
const S2 = "student-two";

function reset() {
  store.students = new Map([
    [S1, { id: S1, teacherId: "t1", status: 0, name: "Student One", registrationNumber: "REG-1" }],
    [S2, { id: S2, teacherId: "t1", status: 0, name: "Student Two", registrationNumber: "REG-2" }],
  ]);
  store.tokens = [];
  session = { role: "STUDENT", userId: S1 };
  process.env.STUDENT_QR_SECRET = SECRET;
  process.env.APP_URL = APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
}

const get = (url, headers = {}) => new Request(`${APP_ORIGIN}${url}`, { headers });
const sameOriginPost = (url, extra = {}) =>
  new Request(`${APP_ORIGIN}${url}`, {
    method: "POST",
    headers: { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-origin", ...extra.headers },
    body: extra.body,
  });

async function decodeQr(response) {
  const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(result, "the PNG decodes as a QR code");
  return { text: result.data, width: png.width };
}

const assertNoStore = (response) => {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
  assert.equal(response.headers.get("vary"), "Cookie");
};

/** Explicit, same-origin issuance of the signed-in student's first QR. */
const issue = async () => {
  const response = await issueRoute.POST(sameOriginPost("/api/students/me/qr/issue"));
  assert.equal(response.status, 200, "issue");
  return response;
};

const sensitiveValues = () => store.tokens.flatMap((t) => [t.nonce, t.tokenHash]).concat(SECRET);

// Silence the expected operator warnings ([student-qr] ...).
const originalWarn = console.warn;
const warnings = [];
test.before(() => {
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
});
test.after(() => {
  console.warn = originalWarn;
});
test.beforeEach(reset);

// ---------------------------------------------------------------- authentication

test("unauthenticated: middleware answers 401 for every QR route (no cookie)", async () => {
  for (const [url, method] of [
    ["/api/students/me/qr", "GET"],
    ["/api/students/me/qr/status", "GET"],
    ["/api/students/me/qr/regenerate", "POST"],
    ["/api/students/me/qr/issue", "POST"],
  ]) {
    const { NextRequest } = require("next/server");
    const response = await middleware(new NextRequest(`${APP_ORIGIN}${url}`, { method }));
    assert.equal(response.status, 401, url);
  }
});

test("routes themselves answer 401 without a student session (teacher or none), with no-store", async () => {
  for (const s of [null, { role: "TEACHER", userId: "t1" }, { role: "ADMIN", userId: "a1" }]) {
    session = s;
    for (const response of [
      await qrRoute.GET(get("/api/students/me/qr")),
      await statusRoute.GET(get("/api/students/me/qr/status")),
      await regenerateRoute.POST(sameOriginPost("/api/students/me/qr/regenerate")),
      await issueRoute.POST(sameOriginPost("/api/students/me/qr/issue")),
    ]) {
      assert.equal(response.status, 401);
      assertNoStore(response);
      assert.equal((await response.json()).error.code, "UNAUTHORIZED");
    }
  }
  assert.equal(store.tokens.length, 0, "nothing issued");
});

// ---------------------------------------------------------------- PNG

test("GET /qr: 404 before issuance; after POST /issue a decodable PNG, private no-store", async () => {
  const none = await qrRoute.GET(get("/api/students/me/qr"));
  assert.equal(none.status, 404);
  assertNoStore(none);
  assert.equal((await none.json()).error.code, "QR_TOKEN_NOT_FOUND");
  assert.equal(store.tokens.length, 0, "GET created nothing");

  await issue();
  const response = await qrRoute.GET(get("/api/students/me/qr"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="my-qr-code.png"');
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assertNoStore(response);

  const { text, width } = await decodeQr(response);
  assert.match(text, /^SLCQR1:[A-Za-z0-9_-]{43}$/);
  assert.equal(width, 512);
  assert.equal(store.tokens.length, 1);
  assert.equal(store.tokens[0].studentId, S1);
  assert.equal(store.tokens[0].createdByRole, "STUDENT");
  assert.equal(store.tokens[0].createdById, S1);
  assert.equal(store.tokens[0].tokenHash, crypto.createHash("sha256").update(text.slice(7)).digest("hex"));

  // Same QR on the next view (idempotent).
  const again = await decodeQr(await qrRoute.GET(get("/api/students/me/qr")));
  assert.equal(again.text, text);
  assert.equal(store.tokens.length, 1);
});

test("GET /qr?download=1 is an attachment; the URL never carries the token", async () => {
  await issue();
  const response = await qrRoute.GET(get("/api/students/me/qr?download=1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="my-qr-code.png"');
  assertNoStore(response);
  await decodeQr(response);
});

test("identity comes only from the session: a studentId in the URL or body is ignored", async () => {
  await issue();
  const mine = await decodeQr(await qrRoute.GET(get(`/api/students/me/qr?studentId=${S2}&id=${S2}`)));
  session = { role: "STUDENT", userId: S2 };
  await issue();
  const theirs = await decodeQr(await qrRoute.GET(get("/api/students/me/qr")));
  assert.notEqual(mine.text, theirs.text);
  assert.deepEqual(store.tokens.map((t) => t.studentId).sort(), [S1, S2]);

  // Student 2 regenerating with S1 in the body only touches S2.
  const s1Before = store.tokens.find((t) => t.studentId === S1).id;
  const response = await regenerateRoute.POST(
    sameOriginPost("/api/students/me/qr/regenerate", { body: JSON.stringify({ studentId: S1 }), headers: { "Content-Type": "application/json" } })
  );
  assert.equal(response.status, 200);
  const s1Rows = store.tokens.filter((t) => t.studentId === S1);
  assert.equal(s1Rows.length, 1);
  assert.equal(s1Rows[0].id, s1Before);
  assert.equal(s1Rows[0].revokedAt, null);
  assert.equal(store.tokens.filter((t) => t.studentId === S2).length, 2);
});

test("missing or invalid STUDENT_QR_SECRET: 503 fail-closed, nothing issued, no secret detail leaked", async () => {
  for (const bad of [undefined, "short", "A".repeat(64)]) {
    reset();
    if (bad === undefined) delete process.env.STUDENT_QR_SECRET;
    else process.env.STUDENT_QR_SECRET = bad;

    const image = await qrRoute.GET(get("/api/students/me/qr"));
    assert.equal(image.status, 503);
    assertNoStore(image);
    const body = await image.json();
    assert.equal(body.error.code, "STUDENT_QR_NOT_CONFIGURED");
    assert.ok(!JSON.stringify(body).includes("STUDENT_QR_SECRET"), "operator detail stays server-side");
    if (bad) assert.ok(!JSON.stringify(body).includes(bad));

    const regenerate = await regenerateRoute.POST(sameOriginPost("/api/students/me/qr/regenerate"));
    assert.equal(regenerate.status, 503);
    const issued = await issueRoute.POST(sameOriginPost("/api/students/me/qr/issue"));
    assert.equal(issued.status, 503);
    assertNoStore(issued);

    const status = await statusRoute.GET(get("/api/students/me/qr/status"));
    assert.equal(status.status, 200);
    assert.equal((await status.json()).data.configured, false);
    assert.equal(store.tokens.length, 0);
  }
  assert.ok(warnings.some((w) => /^\[student-qr\] QR codes are unavailable: STUDENT_QR_SECRET/.test(w)));
  assert.ok(warnings.every((w) => !w.includes(SECRET)));
});

// ---------------------------------------------------------------- status

test("GET /status returns only safe fields", async () => {
  let body = await (await statusRoute.GET(get("/api/students/me/qr/status"))).json();
  assert.deepEqual(body.data, {
    configured: true,
    hasActiveToken: false,
    regenerationLimit: 5,
    regenerationsRemaining: 5,
    nextRegenerationAt: null,
  });
  await issue();
  const response = await statusRoute.GET(get("/api/students/me/qr/status"));
  assertNoStore(response);
  body = await response.json();
  assert.equal(body.data.hasActiveToken, true);
  const text = JSON.stringify(body);
  for (const value of sensitiveValues()) assert.ok(!text.includes(value));
  assert.doesNotMatch(text, /"token"|nonce|hash|SLCQR1/i);
});

// ---------------------------------------------------------------- regeneration

test("regeneration: new decodable QR, old one revoked, JSON has status only", async () => {
  await issue();
  const first = await decodeQr(await qrRoute.GET(get("/api/students/me/qr")));
  const response = await regenerateRoute.POST(sameOriginPost("/api/students/me/qr/regenerate"));
  assert.equal(response.status, 200);
  assertNoStore(response);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.data).sort(), [
    "configured",
    "hasActiveToken",
    "nextRegenerationAt",
    "regenerationLimit",
    "regenerationsRemaining",
  ]);
  assert.equal(body.data.regenerationsRemaining, 4);
  const text = JSON.stringify(body);
  for (const value of sensitiveValues()) assert.ok(!text.includes(value), "no nonce / hash / secret in JSON");

  const second = await decodeQr(await qrRoute.GET(get("/api/students/me/qr")));
  assert.notEqual(second.text, first.text);
  assert.ok(!text.includes(second.text.slice(7)), "the new token is not in the JSON");
  const old = store.tokens.find((t) => t.tokenHash === crypto.createHash("sha256").update(first.text.slice(7)).digest("hex"));
  assert.ok(old.revokedAt instanceof Date);
  assert.equal(old.revokedByRole, "STUDENT");
  assert.equal(old.revokedById, S1);
  assert.equal(old.revokedReason, "REGENERATE");
});

test("regeneration limit: the 6th within 24h is 429 with Retry-After and retry details", async () => {
  await issue();
  for (let i = 0; i < 5; i += 1) {
    const ok = await regenerateRoute.POST(sameOriginPost("/api/students/me/qr/regenerate"));
    assert.equal(ok.status, 200);
  }
  const before = await decodeQr(await qrRoute.GET(get("/api/students/me/qr")));
  const refused = await regenerateRoute.POST(sameOriginPost("/api/students/me/qr/regenerate"));
  assert.equal(refused.status, 429);
  assertNoStore(refused);
  const retryAfter = Number(refused.headers.get("retry-after"));
  assert.ok(retryAfter > 23 * 3600 && retryAfter <= 24 * 3600, String(retryAfter));
  const body = await refused.json();
  assert.equal(body.error.code, "QR_REGENERATION_LIMIT");
  assert.equal(body.error.details.limit, 5);
  assert.ok(Date.parse(body.error.details.retryAt) > Date.now());

  const after = await decodeQr(await qrRoute.GET(get("/api/students/me/qr")));
  assert.equal(after.text, before.text, "a refused regeneration changes nothing");

  const status = await (await statusRoute.GET(get("/api/students/me/qr/status"))).json();
  assert.equal(status.data.regenerationsRemaining, 0);
  assert.equal(status.data.nextRegenerationAt, body.error.details.retryAt);
});

// ---------------------------------------------------------------- CSRF

test("cross-origin regeneration is rejected before authentication or any write", async () => {
  await issue();
  const tokensBefore = JSON.stringify(store.tokens);
  const sessionCalls = calls.requireStudentSession;
  const cases = [
    { "Sec-Fetch-Site": "cross-site", Origin: APP_ORIGIN },
    { "Sec-Fetch-Site": "same-site", Origin: APP_ORIGIN },
    { "Sec-Fetch-Site": "none", Origin: APP_ORIGIN },
    { Origin: "https://evil.example" },
    { Origin: "https://app.example.test.evil.example" },
    { Origin: "http://app.example.test" }, // scheme differs
    { Origin: "https://app.example.test:8443" }, // port differs
    { Origin: "null" },
    { Origin: "not a url" },
    {}, // no Origin at all
    { Host: "evil.example", Origin: "https://evil.example" }, // Host is never trusted
    { "X-Forwarded-Host": "evil.example", Origin: "https://evil.example" },
  ];
  for (const headers of cases) {
    const response = await regenerateRoute.POST(
      new Request(`${APP_ORIGIN}/api/students/me/qr/regenerate`, { method: "POST", headers })
    );
    assert.equal(response.status, 403, JSON.stringify(headers));
    assertNoStore(response);
    assert.equal((await response.json()).error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  assert.equal(calls.requireStudentSession, sessionCalls, "rejected before the session was even read");
  assert.equal(JSON.stringify(store.tokens), tokensBefore, "no write");

  // Older browsers without Sec-Fetch-Site: Origin alone decides.
  const legacy = await regenerateRoute.POST(
    new Request(`${APP_ORIGIN}/api/students/me/qr/regenerate`, { method: "POST", headers: { Origin: APP_ORIGIN } })
  );
  assert.equal(legacy.status, 200);
});

test("same-origin check uses only configured origins (APP_URL / NEXT_PUBLIC_APP_URL), failing closed", async () => {
  await issue();
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  const unconfigured = await regenerateRoute.POST(sameOriginPost("/api/students/me/qr/regenerate"));
  assert.equal(unconfigured.status, 403);
  assert.ok(warnings.some((w) => /set APP_URL or NEXT_PUBLIC_APP_URL/.test(w)));

  process.env.NEXT_PUBLIC_APP_URL = `${APP_ORIGIN}/some/path`;
  const viaPublic = await regenerateRoute.POST(sameOriginPost("/api/students/me/qr/regenerate"));
  assert.equal(viaPublic.status, 200);
});

// ---------------------------------------------------------------- hygiene

test("QR routes and helpers never log or echo token material", () => {
  for (const file of [
    "app/api/students/me/qr/route.ts",
    "app/api/students/me/qr/status/route.ts",
    "app/api/students/me/qr/regenerate/route.ts",
    "app/api/students/me/qr/issue/route.ts",
    "app/api/students/[id]/qr/issue/route.ts",
    "lib/student-qr-http.ts",
    "lib/same-origin.ts",
    "components/student-portal/student-qr-panel.tsx",
    "components/qr/qr-identity-card.tsx",
    "app/student/Components/StudentQrIdentity.tsx",
    "app/api/students/[id]/qr/route.ts",
    "app/api/students/[id]/qr/status/route.ts",
    "app/api/students/[id]/qr/regenerate/route.ts",
  ]) {
    const code = fs.readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, /console\.(log|info|debug|error)\(/, file);
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB/, file);
    // Routes only ever use the payload to draw the PNG; the token never goes into JSON.
    assert.doesNotMatch(code, /qr\.token|token:/, file);
  }
  // The shared card shows the PNG through an in-memory blob: URL.
  const card = fs.readFileSync(path.join(root, "components/qr/qr-identity-card.tsx"), "utf8");
  assert.match(card, /URL\.createObjectURL/);
  for (const file of [
    "components/qr/qr-identity-card.tsx",
    "components/student-portal/student-qr-panel.tsx",
    "app/student/Components/StudentQrIdentity.tsx",
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /student-qr-token|student-qr-service/, `${file}: the client never imports server QR code`);
  }
});

// ---------------------------------------------------------------- explicit issuance (GET is read-only)

test("GET never creates a token: image (inline / download / repeated) and status leave the store empty", async () => {
  for (const url of ["/api/students/me/qr", "/api/students/me/qr?download=1", "/api/students/me/qr", "/api/students/me/qr?issue=1"]) {
    const response = await qrRoute.GET(get(url));
    assert.equal(response.status, 404, url);
    assertNoStore(response);
    assert.equal((await response.json()).error.code, "QR_TOKEN_NOT_FOUND");
  }
  const status = await (await statusRoute.GET(get("/api/students/me/qr/status"))).json();
  assert.equal(status.data.hasActiveToken, false);
  assert.equal(store.tokens.length, 0);

  // After issuance and a regeneration, GET still only reads: no extra rows.
  await issue();
  await regenerateRoute.POST(sameOriginPost("/api/students/me/qr/regenerate"));
  const rows = store.tokens.length;
  for (let i = 0; i < 3; i += 1) assert.equal((await qrRoute.GET(get("/api/students/me/qr"))).status, 200);
  assert.equal(store.tokens.length, rows);
});

test("POST /issue: ISSUE row by the student, idempotent, not counted towards the limit, status-only JSON", async () => {
  const first = await issue();
  assertNoStore(first);
  const body = await first.json();
  assert.deepEqual(body.data, {
    configured: true,
    hasActiveToken: true,
    regenerationLimit: 5,
    regenerationsRemaining: 5,
    nextRegenerationAt: null,
  });
  assert.equal(store.tokens.length, 1);
  assert.equal(store.tokens[0].reason, "ISSUE");
  assert.equal(store.tokens[0].createdByRole, "STUDENT");
  assert.equal(store.tokens[0].createdById, S1);
  const text = JSON.stringify(body);
  for (const value of sensitiveValues()) assert.ok(!text.includes(value));

  const payload = (await decodeQr(await qrRoute.GET(get("/api/students/me/qr")))).text;
  assert.ok(!text.includes(payload.slice(7)), "no token in the JSON");
  await issue();
  await issue();
  assert.equal(store.tokens.length, 1, "idempotent");
  assert.equal((await decodeQr(await qrRoute.GET(get("/api/students/me/qr")))).text, payload, "same QR");

  // After a regeneration, issue keeps the current (regenerated) QR.
  await regenerateRoute.POST(sameOriginPost("/api/students/me/qr/regenerate"));
  const regenerated = (await decodeQr(await qrRoute.GET(get("/api/students/me/qr")))).text;
  const again = await (await issue()).json();
  assert.equal(again.data.regenerationsRemaining, 4, "ISSUE never counts; one REGENERATE does");
  assert.equal((await decodeQr(await qrRoute.GET(get("/api/students/me/qr")))).text, regenerated);
  assert.equal(store.tokens.length, 2);
});

test("POST /issue ignores any studentId in the body", async () => {
  const response = await issueRoute.POST(
    sameOriginPost("/api/students/me/qr/issue", { body: JSON.stringify({ studentId: S2 }), headers: { "Content-Type": "application/json" } })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(store.tokens.map((t) => t.studentId), [S1]);
});

test("cross-origin issuance is rejected before authentication or any write", async () => {
  const sessionCalls = calls.requireStudentSession;
  for (const headers of [
    { "Sec-Fetch-Site": "cross-site", Origin: APP_ORIGIN },
    { "Sec-Fetch-Site": "same-site", Origin: APP_ORIGIN },
    { Origin: "https://evil.example" },
    { Origin: "http://app.example.test" },
    { Origin: "null" },
    {},
    { Host: "evil.example", Origin: "https://evil.example" },
  ]) {
    const response = await issueRoute.POST(new Request(`${APP_ORIGIN}/api/students/me/qr/issue`, { method: "POST", headers }));
    assert.equal(response.status, 403, JSON.stringify(headers));
    assertNoStore(response);
    assert.equal((await response.json()).error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  assert.equal(calls.requireStudentSession, sessionCalls, "rejected before the session was read");
  assert.equal(store.tokens.length, 0, "no write");
});
