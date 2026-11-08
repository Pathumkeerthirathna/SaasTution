/*
 * Teacher QR API routes (app/api/students/[id]/qr/*), end to end in-process
 * with the REAL ownership guard (lib/teacher-student-access.ts), T4 service,
 * T3 crypto and PNG rendering, plus the student /me routes for the shared
 * regeneration limit. Faked edges: session and Prisma (helpers/qr-route-env).
 *
 *   npm run test:student-qr
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const { root, state, seedStudents } = require("./helpers/qr-route-env.cjs");

const jsQR = require("jsqr");
const { PNG } = require(require.resolve("pngjs", { paths: [path.dirname(require.resolve("qrcode"))] }));
const { NextRequest } = require("next/server");

const teacherImage = require(path.join(root, "app", "api", "students", "[id]", "qr", "route.ts"));
const teacherStatus = require(path.join(root, "app", "api", "students", "[id]", "qr", "status", "route.ts"));
const teacherRegenerate = require(path.join(root, "app", "api", "students", "[id]", "qr", "regenerate", "route.ts"));
const teacherIssue = require(path.join(root, "app", "api", "students", "[id]", "qr", "issue", "route.ts"));
const studentImage = require(path.join(root, "app", "api", "students", "me", "qr", "route.ts"));
const studentRegenerate = require(path.join(root, "app", "api", "students", "me", "qr", "regenerate", "route.ts"));
const { middleware } = require(path.join(root, "middleware.ts"));

const APP_ORIGIN = "https://app.example.test";
const SECRET = crypto.createHash("sha512").update("teacher qr route tests").digest("base64");

const T1 = "teacher-1";
const T2 = "teacher-2";
const OWNED = "student-owned";
const OTHERS = "student-of-t2";
const DELETED = "student-deleted";

const asTeacher = (id = T1) => {
  state.session = { role: "TEACHER", userId: id };
};
const asStudent = (id = OWNED) => {
  state.session = { role: "STUDENT", userId: id };
};

const ctx = (id) => ({ params: { id } });
const get = (url) => new Request(`${APP_ORIGIN}${url}`);
const post = (url, { headers = {}, body } = {}) =>
  new Request(`${APP_ORIGIN}${url}`, {
    method: "POST",
    headers: { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-origin", ...headers },
    body,
  });

const image = (id, query = "") => teacherImage.GET(get(`/api/students/${id}/qr${query}`), ctx(id));
const status = (id) => teacherStatus.GET(get(`/api/students/${id}/qr/status`), ctx(id));
const regenerate = (id, init) => teacherRegenerate.POST(post(`/api/students/${id}/qr/regenerate`, init), ctx(id));
const issueRaw = (id, init) => teacherIssue.POST(post(`/api/students/${id}/qr/issue`, init), ctx(id));
/** Explicit, same-origin issuance by the current teacher (must succeed). */
const issue = async (id) => {
  const response = await issueRaw(id);
  assert.equal(response.status, 200, `issue ${id}`);
  return response;
};

async function decodeQr(response) {
  const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(result, "the PNG decodes as a QR code");
  return result.data;
}

const assertNoStore = (response) => {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
  assert.equal(response.headers.get("vary"), "Cookie");
};

const sensitive = () => state.tokens.flatMap((t) => [t.nonce, t.tokenHash]).concat(SECRET);

const originalWarn = console.warn;
test.before(() => {
  console.warn = () => {};
});
test.after(() => {
  console.warn = originalWarn;
});
test.beforeEach(() => {
  seedStudents([
    { id: OWNED, teacherId: T1, name: "Amaya Perera", registrationNumber: "SLC-1" },
    { id: OTHERS, teacherId: T2, name: "Kasun Fernando", registrationNumber: "SLC-2" },
    { id: DELETED, teacherId: T1, name: "Removed Student", registrationNumber: "SLC-3", status: 2 },
  ]);
  asTeacher(T1);
  process.env.STUDENT_QR_SECRET = SECRET;
  process.env.APP_URL = APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

// ---------------------------------------------------------------- authentication

test("no cookie: middleware answers 401 for every teacher QR route", async () => {
  for (const [url, method] of [
    [`/api/students/${OWNED}/qr`, "GET"],
    [`/api/students/${OWNED}/qr/status`, "GET"],
    [`/api/students/${OWNED}/qr/regenerate`, "POST"],
    [`/api/students/${OWNED}/qr/issue`, "POST"],
  ]) {
    const response = await middleware(new NextRequest(`${APP_ORIGIN}${url}`, { method }));
    assert.equal(response.status, 401, url);
  }
});

test("routes answer 401 without a teacher session (none, student, admin) and write nothing", async () => {
  for (const session of [null, { role: "STUDENT", userId: OWNED }, { role: "ADMIN", userId: "a1" }]) {
    state.session = session;
    for (const response of [await image(OWNED), await status(OWNED), await regenerate(OWNED), await issueRaw(OWNED)]) {
      assert.equal(response.status, 401);
      assertNoStore(response);
      assert.equal((await response.json()).error.code, "UNAUTHORIZED");
    }
  }
  assert.equal(state.tokens.length, 0);
});

// ---------------------------------------------------------------- ownership

test("another teacher's student and unknown ids: 404 without student data, nothing issued", async () => {
  for (const id of [OTHERS, "does-not-exist", "   ", ""]) {
    for (const response of [await image(id), await status(id), await regenerate(id), await issueRaw(id)]) {
      assert.equal(response.status, 404, `id=${JSON.stringify(id)}`);
      assertNoStore(response);
      const text = await response.text();
      assert.match(text, /STUDENT_NOT_FOUND/);
      assert.doesNotMatch(text, /Kasun|Fernando|SLC-2|teacher-2/);
    }
  }
  assert.equal(state.tokens.length, 0, "no QR issued for any of them");

  // T2 owns OTHERS; T2 cannot reach T1's student either.
  asTeacher(T2);
  assert.equal((await image(OWNED)).status, 404);
  assert.equal((await regenerate(OWNED)).status, 404);
  assert.equal((await issueRaw(OWNED)).status, 404);
  assert.equal(state.tokens.length, 0, "T2 issued nothing for T1's student");
  await issue(OTHERS);
  assert.equal((await image(OTHERS)).status, 200);
});

test("an owned but deleted student (status 2) gets no QR: 404", async () => {
  for (const response of [await image(DELETED), await status(DELETED), await regenerate(DELETED), await issueRaw(DELETED)]) {
    assert.equal(response.status, 404);
  }
  assert.equal(state.tokens.length, 0);
});

// ---------------------------------------------------------------- image + status

test("owning teacher: GET is 404 until POST /issue, then a decodable PNG with the teacher recorded, no-store", async () => {
  const none = await image(OWNED);
  assert.equal(none.status, 404);
  assertNoStore(none);
  assert.equal((await none.json()).error.code, "QR_TOKEN_NOT_FOUND");
  assert.equal(state.tokens.length, 0, "GET created nothing");

  await issue(OWNED);
  const response = await image(OWNED);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="student-qr-code.png"');
  assertNoStore(response);
  const payload = await decodeQr(response);
  assert.match(payload, /^SLCQR1:[A-Za-z0-9_-]{43}$/);

  assert.equal(state.tokens.length, 1);
  assert.equal(state.tokens[0].studentId, OWNED);
  assert.equal(state.tokens[0].createdByRole, "TEACHER");
  assert.equal(state.tokens[0].createdById, T1);
  assert.equal(state.tokens[0].reason, "ISSUE");

  // Teacher and student see the same QR.
  assert.equal(await decodeQr(await image(OWNED)), payload);
  asStudent(OWNED);
  assert.equal(await decodeQr(await studentImage.GET(get("/api/students/me/qr"))), payload);
  assert.equal(state.tokens.length, 1);
});

test("download=1 is an attachment (no token in the URL)", async () => {
  await issue(OWNED);
  const response = await image(OWNED, "?download=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="student-qr-code.png"');
  await decodeQr(response);
});

test("status returns only the safe fields", async () => {
  await issue(OWNED);
  const response = await status(OWNED);
  assert.equal(response.status, 200);
  assertNoStore(response);
  const body = await response.json();
  assert.deepEqual(body.data, {
    configured: true,
    hasActiveToken: true,
    regenerationLimit: 5,
    regenerationsRemaining: 5,
    nextRegenerationAt: null,
  });
  const text = JSON.stringify(body);
  for (const value of sensitive()) assert.ok(!text.includes(value));
});

test("missing STUDENT_QR_SECRET: 503 for image and regeneration, status says not configured", async () => {
  delete process.env.STUDENT_QR_SECRET;
  const img = await image(OWNED);
  assert.equal(img.status, 503);
  assertNoStore(img);
  assert.equal((await img.json()).error.code, "STUDENT_QR_NOT_CONFIGURED");
  assert.equal((await regenerate(OWNED)).status, 503);
  assert.equal((await issueRaw(OWNED)).status, 503);
  assert.equal((await (await status(OWNED)).json()).data.configured, false);
  assert.equal(state.tokens.length, 0);
});

// ---------------------------------------------------------------- regeneration

test("owning teacher regenerates: new QR, audit fields name the teacher, JSON has status only", async () => {
  await issue(OWNED);
  const before = await decodeQr(await image(OWNED));
  const response = await regenerate(OWNED);
  assert.equal(response.status, 200);
  assertNoStore(response);
  const body = await response.json();
  assert.equal(body.data.regenerationsRemaining, 4);
  const after = await decodeQr(await image(OWNED));
  assert.notEqual(after, before);
  const text = JSON.stringify(body);
  for (const value of sensitive().concat(before.slice(7), after.slice(7))) assert.ok(!text.includes(value));

  const old = state.tokens.find((t) => t.revokedAt !== null);
  assert.equal(old.revokedByRole, "TEACHER");
  assert.equal(old.revokedById, T1);
  assert.equal(old.revokedReason, "REGENERATE");
  const current = state.tokens.find((t) => t.revokedAt === null);
  assert.equal(current.createdByRole, "TEACHER");
  assert.equal(current.createdById, T1);
});

test("a studentId in the body is ignored: only the URL's owned student changes", async () => {
  asTeacher(T2);
  await issue(OTHERS);
  asTeacher(T1);
  await issue(OWNED);
  const othersBefore = JSON.stringify(state.tokens.filter((t) => t.studentId === OTHERS));
  const response = await regenerate(OWNED, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ studentId: OTHERS, teacherId: T2 }),
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(state.tokens.filter((t) => t.studentId === OTHERS)), othersBefore);
  assert.equal(state.tokens.filter((t) => t.studentId === OWNED).length, 2);
});

test("limit is shared: 3 student + 2 teacher regenerations, then both get 429 with Retry-After", async () => {
  await issue(OWNED);
  asStudent(OWNED);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await studentRegenerate.POST(post("/api/students/me/qr/regenerate"))).status, 200);
  }
  asTeacher(T1);
  for (let i = 0; i < 2; i += 1) assert.equal((await regenerate(OWNED)).status, 200);

  const refused = await regenerate(OWNED);
  assert.equal(refused.status, 429);
  assertNoStore(refused);
  const retryAfter = Number(refused.headers.get("retry-after"));
  assert.ok(retryAfter > 23 * 3600 && retryAfter <= 24 * 3600, String(retryAfter));
  const body = await refused.json();
  assert.equal(body.error.code, "QR_REGENERATION_LIMIT");
  assert.equal(body.error.details.limit, 5);

  asStudent(OWNED);
  assert.equal((await studentRegenerate.POST(post("/api/students/me/qr/regenerate"))).status, 429);

  asTeacher(T1);
  const st = await (await status(OWNED)).json();
  assert.equal(st.data.regenerationsRemaining, 0);
  assert.equal(st.data.nextRegenerationAt, body.error.details.retryAt);
  const roles = state.tokens.filter((t) => t.reason === "REGENERATE").map((t) => t.createdByRole).sort();
  assert.deepEqual(roles, ["STUDENT", "STUDENT", "STUDENT", "TEACHER", "TEACHER"]);
});

// ---------------------------------------------------------------- CSRF

test("cross-origin regeneration: 403 before the session or ownership is checked, no writes", async () => {
  await issue(OWNED);
  const tokensBefore = JSON.stringify(state.tokens);
  const sessionCalls = state.calls.session;
  for (const headers of [
    { "Sec-Fetch-Site": "cross-site", Origin: APP_ORIGIN },
    { "Sec-Fetch-Site": "same-site", Origin: APP_ORIGIN },
    { Origin: "https://evil.example" },
    { Origin: "http://app.example.test" },
    { Origin: "null" },
    {},
    { Host: "evil.example", Origin: "https://evil.example" },
  ]) {
    const response = await teacherRegenerate.POST(
      new Request(`${APP_ORIGIN}/api/students/${OWNED}/qr/regenerate`, { method: "POST", headers }),
      ctx(OWNED)
    );
    assert.equal(response.status, 403, JSON.stringify(headers));
    assertNoStore(response);
    assert.equal((await response.json()).error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  assert.equal(state.calls.session, sessionCalls, "rejected before authentication");
  assert.equal(JSON.stringify(state.tokens), tokensBefore, "no write");
});

// ---------------------------------------------------------------- explicit issuance (GET is read-only)

test("GET never creates a token: owner, other teacher, deleted, inline and download", async () => {
  for (const [teacher, id] of [
    [T1, OWNED],
    [T1, OTHERS],
    [T1, DELETED],
    [T2, OTHERS],
  ]) {
    asTeacher(teacher);
    for (const query of ["", "?download=1", ""]) {
      const response = await image(id, query);
      assert.equal(response.status, 404, `${teacher} ${id}${query}`);
      assertNoStore(response);
    }
  }
  asStudent(OWNED);
  assert.equal((await studentImage.GET(get("/api/students/me/qr"))).status, 404);
  assert.equal(state.tokens.length, 0);

  // After issuance, GETs read the same row and add none.
  asTeacher(T1);
  await issue(OWNED);
  for (let i = 0; i < 3; i += 1) assert.equal((await image(OWNED)).status, 200);
  assert.equal(state.tokens.length, 1);
});

test("POST /issue: ISSUE row by the teacher, idempotent, shared with the student, not counted towards the limit", async () => {
  const response = await issue(OWNED);
  assertNoStore(response);
  const body = await response.json();
  assert.equal(body.data.hasActiveToken, true);
  assert.equal(body.data.regenerationsRemaining, 5);
  const text = JSON.stringify(body);
  for (const value of sensitive()) assert.ok(!text.includes(value));
  assert.equal(state.tokens.length, 1);
  assert.equal(state.tokens[0].reason, "ISSUE");
  assert.equal(state.tokens[0].createdByRole, "TEACHER");
  assert.equal(state.tokens[0].createdById, T1);

  const payload = await decodeQr(await image(OWNED));
  await issue(OWNED);
  assert.equal(state.tokens.length, 1, "idempotent");

  // The student's own issue returns the same QR (no second ISSUE).
  asStudent(OWNED);
  const studentIssue = require(path.join(root, "app", "api", "students", "me", "qr", "issue", "route.ts"));
  assert.equal((await studentIssue.POST(post("/api/students/me/qr/issue"))).status, 200);
  assert.equal(await decodeQr(await studentImage.GET(get("/api/students/me/qr"))), payload);
  assert.equal(state.tokens.length, 1);

  asTeacher(T1);
  await regenerate(OWNED);
  const after = await (await issue(OWNED)).json();
  assert.equal(after.data.regenerationsRemaining, 4, "only the REGENERATE counts");
  assert.equal(state.tokens.filter((t) => t.reason === "ISSUE").length, 1);
});

test("POST /issue: another teacher's or unknown student → 404 without writes; body ignored", async () => {
  for (const id of [OTHERS, "does-not-exist"]) {
    const response = await issueRaw(id);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /Kasun|Fernando|SLC-2/);
  }
  assert.equal(state.tokens.length, 0);

  const response = await issueRaw(OWNED, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ studentId: OTHERS, teacherId: T2 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(state.tokens.map((t) => t.studentId), [OWNED]);
});

test("cross-origin issuance: 403 before the session or ownership is checked, no writes", async () => {
  const sessionCalls = state.calls.session;
  for (const headers of [
    { "Sec-Fetch-Site": "cross-site", Origin: APP_ORIGIN },
    { "Sec-Fetch-Site": "same-site", Origin: APP_ORIGIN },
    { Origin: "https://evil.example" },
    { Origin: "http://app.example.test" },
    { Origin: "null" },
    {},
    { Host: "evil.example", Origin: "https://evil.example" },
  ]) {
    const response = await teacherIssue.POST(
      new Request(`${APP_ORIGIN}/api/students/${OWNED}/qr/issue`, { method: "POST", headers }),
      ctx(OWNED)
    );
    assert.equal(response.status, 403, JSON.stringify(headers));
    assertNoStore(response);
    assert.equal((await response.json()).error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  assert.equal(state.calls.session, sessionCalls, "rejected before authentication");
  assert.equal(state.tokens.length, 0, "no write");
});
