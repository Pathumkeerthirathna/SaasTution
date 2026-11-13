/*
 * Student Profile SP-5.6: hardened student password change
 * (POST /api/auth/password/update, STUDENT branch: lib/student-password-change-http.ts,
 * services/student-password-change-service.ts), the shared /account/security
 * page, and the unchanged teacher / admin / guardian behaviour.
 *
 *   npm run test:security
 *
 * No database: lib/prisma.ts is a stateful fake whose $transaction snapshots
 * and restores on failure; bcryptjs is wrapped to record each call (the real
 * library hashes at cost 4 for speed, the requested cost is recorded);
 * next/headers (cookies) and next/navigation (redirect) are fakes.
 * JWT_SECRET is a throwaway value set here.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "sp-5-6-test-secret-not-a-real-one-0123456789";
process.env.APP_URL = "http://localhost:3000";
const APP = "http://localhost:3000";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();
globalThis.React = require("react");

const jose = require("jose");
const realBcrypt = require("bcryptjs");

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

// ---- State and fakes -----------------------------------------------------------------------------

const OLD = "old-password-1";
const OLD_HASH = realBcrypt.hashSync(OLD, 4);
const state = {
  cookie: null,
  guardianCookie: null,
  students: new Map(),
  teachers: new Map(),
  guardians: new Map(),
  tokens: [],
  log: [],
  transactions: [],
  failTokens: false,
  failStudentReads: false,
  concurrentCommit: null,
  skipUpdate: false,
  afterCommit: null,
};

const log = (entry) => state.log.push(entry);

fakeAt(require.resolve("bcryptjs", { paths: [root] }), {
  ...realBcrypt,
  hash: async (password, rounds) => {
    log({ op: "hash", rounds });
    return realBcrypt.hash(password, 4);
  },
  compare: async (password, hash) => {
    log({ op: "compare" });
    return realBcrypt.compare(password, hash);
  },
});

fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({
    get: (name) => {
      if (name === "teacher_session" && state.cookie) return { name, value: state.cookie };
      if (name === "guardian_session" && state.guardianCookie) return { name, value: state.guardianCookie };
      return undefined;
    },
  }),
});
class Redirect extends Error {
  constructor(url) {
    super(`redirect ${url}`);
    this.url = url;
  }
}
fakeAt(require.resolve("next/navigation", { paths: [root] }), {
  redirect: (url) => {
    throw new Redirect(url);
  },
});

const pick = (row, select) => Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
const snapshot = () => ({
  students: new Map([...state.students].map(([k, v]) => [k, { ...v }])),
  tokens: state.tokens.map((t) => ({ ...t })),
});
const restore = (snap) => {
  state.students = snap.students;
  state.tokens = snap.tokens;
};

const prisma = {
  student: {
    findUnique: async (args) => {
      log({ op: "student.findUnique", select: Object.keys(args.select).join(",") });
      if (state.failStudentReads) throw new Error("db down");
      const row = state.students.get(args.where.id);
      return row ? pick(row, args.select) : null;
    },
    updateMany: async ({ where, data, viaTx = false }) => {
      log({ op: "student.updateMany", viaTx, where, data: { ...data, password: typeof data.password === "string" ? "<hash>" : data.password } });
      if (state.skipUpdate) {
        state.skipUpdate = false;
        return { count: 0 }; // matched nothing although the student still looks active
      }
      const row = state.students.get(where.id);
      if (!row || row.status !== where.status || row.sessionVersion !== where.sessionVersion) return { count: 0 };
      row.password = data.password;
      row.sessionVersion += data.sessionVersion.increment;
      return { count: 1 };
    },
  },
  passwordResetToken: {
    updateMany: async ({ where, data, viaTx = false }) => {
      log({ op: "passwordResetToken.updateMany", viaTx, where });
      if (state.failTokens) throw new Error("token update failed");
      let count = 0;
      for (const token of state.tokens) {
        if (token.role === where.role && token.userId === where.userId && token.usedAt === where.usedAt) {
          token.usedAt = data.usedAt;
          count += 1;
        }
      }
      return { count };
    },
  },
  $transaction: async (fn, options) => {
    state.transactions.push(options);
    if (state.concurrentCommit) {
      // Another request's change, committed just before ours (outside our transaction: never rolled back).
      const commit = state.concurrentCommit;
      state.concurrentCommit = null;
      commit();
    }
    const snap = snapshot();
    // A distinct transaction client: every write through it is tagged, so a write that
    // bypasses `tx` (and would escape the rollback in a real database) is visible.
    const tx = {
      student: { updateMany: (args) => prisma.student.updateMany({ ...args, viaTx: true }) },
      passwordResetToken: { updateMany: (args) => prisma.passwordResetToken.updateMany({ ...args, viaTx: true }) },
    };
    try {
      const result = await fn(tx);
      if (state.afterCommit) state.afterCommit();
      return result;
    } catch (error) {
      restore(snap);
      throw error;
    }
  },
  teacher: {
    findUnique: async ({ where, select }) => {
      const row = state.teachers.get(where.id);
      return row ? pick(row, select) : null;
    },
    update: async ({ where, data }) => {
      log({ op: "teacher.update", data: Object.keys(data) });
      state.teachers.get(where.id).password = data.password;
    },
  },
  guardian: {
    findUnique: async ({ where, select }) => {
      const row = state.guardians.get(where.id);
      return row ? pick(row, select) : null;
    },
    update: async ({ where, data }) => {
      log({ op: "guardian.update", data: Object.keys(data) });
      state.guardians.get(where.id).password = data.password;
    },
  },
};

fake("lib/prisma.ts", { prisma });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
fake("lib/mailer.ts", { buildPasswordResetLink: () => "", sendPasswordResetEmail: async () => {}, sendEmailVerificationCodeEmail: async () => {} });
fake("lib/email-verification.ts", { createEmailVerificationCode: async () => "000000", verifyEmailConfirmationCode: async () => {} });
fake("lib/email-uniqueness.ts", { assertEmailAvailable: async () => {} });
fake("services/teacher-profile-section-service.ts", { defaultProfileSectionsCreateInput: () => ({}) });

const auth = require(path.join(root, "lib", "auth.ts"));
const guardianAuth = require(path.join(root, "lib", "guardian-auth.ts"));
const authSession = require(path.join(root, "lib", "auth-session.ts"));
const validation = require(path.join(root, "lib", "student-password-validation.ts"));
const { updatePasswordForAuthenticatedUser } = require(path.join(root, "services", "auth-service.ts"));
const route = require(path.join(root, "app", "api", "auth", "password", "update", "route.ts"));
const AccountSecurityPage = require(path.join(root, "app", "account", "security", "page.tsx")).default;

// ---- Helpers ------------------------------------------------------------------------------------

let seq = 0;
function reset() {
  Object.assign(state, { cookie: null, guardianCookie: null, log: [], transactions: [], failTokens: false, failStudentReads: false, concurrentCommit: null, skipUpdate: false, afterCommit: null });
  state.students = new Map();
  state.tokens = [];
  state.teachers = new Map([["t-1", { id: "t-1", password: OLD_HASH }]]);
  state.guardians = new Map([["g-1", { id: "g-1", password: OLD_HASH }]]);
}
/** A fresh active student (the rate limiter is per student and per process) with a session cookie. */
async function freshStudent(patch = {}) {
  const id = `stu-${++seq}`;
  state.students.set(id, { id, name: `Fresh Name ${id}`, email: `fresh-${id}@example.test`, registrationNumber: `REG-${id.toUpperCase()}`, password: OLD_HASH, status: 0, sessionVersion: 0, contact01: "0771234567", ...patch });
  state.cookie = await tokenFor(id, state.students.get(id).sessionVersion);
  state.log = [];
  return id;
}
const tokenFor = (id, sessionVersion) => auth.signAuthToken({ sub: id, email: "old@example.test", role: "STUDENT", name: "Old Name", sessionVersion });

const SAME_ORIGIN = { Origin: APP, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
const valid = (patch = {}) => ({ currentPassword: OLD, newPassword: "brand-new-pass", confirmPassword: "brand-new-pass", ...patch });

async function change(body, { origin = true, headers = {} } = {}) {
  const response = await route.POST(
    new Request(`${APP}/api/auth/password/update`, {
      method: "POST",
      headers: { ...(origin ? SAME_ORIGIN : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    })
  );
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/teacher_session=([^;]*)/);
  return { status: response.status, body: await response.json(), response, setCookie, token: match ? match[1] : null };
}

function assertNoStore(response) {
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
}
const ops = (name) => state.log.filter((e) => e.op === name);
const bcryptOps = () => state.log.filter((e) => e.op === "hash" || e.op === "compare").map((e) => e.op);

async function sessionStillValid(token) {
  const saved = state.cookie;
  state.cookie = token;
  try {
    await authSession.requireStudentSession();
    return true;
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 403) return false;
    throw error;
  } finally {
    state.cookie = saved;
  }
}

async function refused(promise, status, code, field) {
  const result = await promise;
  assert.deepEqual([result.status, result.body.success, result.body.error?.code], [status, false, code], JSON.stringify(result.body));
  if (field !== undefined) assert.deepEqual(result.body.error.details, { field });
  assert.equal(result.token, null, "no cookie on a refusal");
  return result;
}

// ---- Success ----------------------------------------------------------------------------------------

test("success: verify, then hash (cost 12), one transaction (password + sessionVersion + 1, unused reset tokens used), fresh JWT in the existing cookie", async () => {
  reset();
  const id = await freshStudent({ sessionVersion: 2 });
  state.cookie = await tokenFor(id, 2);
  state.tokens = [
    { id: "r1", role: "STUDENT", userId: id, usedAt: null, expiresAt: new Date(Date.now() + 60_000) },
    { id: "r2", role: "STUDENT", userId: id, usedAt: null, expiresAt: new Date(Date.now() - 60_000) },
    { id: "r3", role: "STUDENT", userId: id, usedAt: new Date("2026-01-01T00:00:00Z") },
    { id: "r4", role: "STUDENT", userId: "someone-else", usedAt: null },
    { id: "r5", role: "TEACHER", userId: id, usedAt: null },
  ];
  const before = { ...state.students.get(id) };
  const oldToken = state.cookie;
  const startedAt = Date.now();

  const result = await change(valid());
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.data, { updated: true });
  assert.equal(result.body.message, "Your password was changed. You have been signed out on your other devices.");
  assertNoStore(result.response);

  assert.deepEqual(bcryptOps(), ["compare", "hash"], "the current password is verified before any hashing");
  assert.equal(ops("hash")[0].rounds, 12);
  assert.deepEqual(ops("student.updateMany")[0].where, { id, status: 0, sessionVersion: 2 });
  assert.deepEqual(ops("student.updateMany")[0].data, { password: "<hash>", sessionVersion: { increment: 1 } });
  assert.deepEqual(ops("passwordResetToken.updateMany")[0].where, { role: "STUDENT", userId: id, usedAt: null });
  assert.deepEqual(state.transactions, [{ maxWait: 5_000, timeout: 15_000 }]);
  assert.deepEqual([ops("student.updateMany")[0].viaTx, ops("passwordResetToken.updateMany")[0].viaTx], [true, true], "both writes inside the transaction");

  const after = state.students.get(id);
  assert.equal(after.sessionVersion, 3);
  assert.equal(await realBcrypt.compare("brand-new-pass", after.password), true);
  for (const key of Object.keys(before)) if (key !== "password" && key !== "sessionVersion") assert.deepEqual(after[key], before[key], key);
  const used = Object.fromEntries(state.tokens.map((t) => [t.id, t.usedAt === null ? null : t.usedAt.getTime() >= startedAt ? "NOW" : "OLD"]));
  assert.deepEqual(used, { r1: "NOW", r2: "NOW", r3: "OLD", r4: null, r5: null });

  const claims = jose.decodeJwt(result.token);
  assert.equal(claims.sv, 3);
  assert.equal(claims.exp - claims.iat, 7 * 24 * 60 * 60);
  assert.deepEqual([claims.sub, claims.role, claims.name, claims.email], [id, "STUDENT", `Fresh Name ${id}`, `fresh-${id}@example.test`], "fresh name / email from the database");
  assert.match(result.setCookie, /Path=\//);
  assert.match(result.setCookie, /HttpOnly/i);
  assert.match(result.setCookie, /SameSite=lax/i);
  assert.match(result.setCookie, /Max-Age=604800/);

  assert.equal(await sessionStillValid(oldToken), false, "the previous session is revoked");
  assert.equal(await sessionStillValid(result.token), true, "the reissued session works");
  const reuse = await (async () => {
    state.cookie = oldToken;
    return change(valid({ currentPassword: "brand-new-pass", newPassword: "another-pass-9", confirmPassword: "another-pass-9" }));
  })();
  assert.deepEqual([reuse.status, reuse.body.error.code], [401, "UNAUTHORIZED"], "the old cookie can no longer change the password");
});

test("a student whose email was removed keeps a valid reissued session (the session's verified email is used)", async () => {
  reset();
  const id = await freshStudent({ email: null });
  const result = await change(valid());
  assert.equal(result.status, 200);
  assert.equal(jose.decodeJwt(result.token).email, "old@example.test");
  assert.equal(await sessionStillValid(result.token), true);
});

// ---- Wrong password and validation ---------------------------------------------------------------

test("wrong current password: 400 INVALID_CURRENT_PASSWORD, no hashing, nothing written, sessions unaffected", async () => {
  reset();
  const id = await freshStudent();
  const token = state.cookie;
  await refused(change(valid({ currentPassword: "not-my-password" })), 400, "INVALID_CURRENT_PASSWORD");
  assert.deepEqual(bcryptOps(), ["compare"], "no hash after a failed verification");
  assert.equal(ops("student.updateMany").length + ops("passwordResetToken.updateMany").length + state.transactions.length, 0);
  assert.equal(state.students.get(id).password, OLD_HASH);
  assert.equal(state.students.get(id).sessionVersion, 0);
  assert.equal(await sessionStillValid(token), true);
});

test("validation (400 VALIDATION_ERROR with the field): confirmation, length 7 / 8 / 64 / 65, 72 UTF-8 bytes, same password, unknown fields; no bcrypt, no writes", async () => {
  reset();
  const sinhala24 = "අ".repeat(24); // 24 characters, 72 bytes
  const sinhala25 = "අ".repeat(25); // 25 characters, 75 bytes
  const cases = [
    [valid({ confirmPassword: "different-pass" }), "confirmPassword", "Passwords do not match."],
    [valid({ newPassword: "a".repeat(7), confirmPassword: "a".repeat(7) }), "newPassword", "Password must be at least 8 characters long."],
    [valid({ newPassword: "a".repeat(65), confirmPassword: "a".repeat(65) }), "newPassword", "Password must be at most 64 characters long."],
    [valid({ newPassword: sinhala25, confirmPassword: sinhala25 }), "newPassword", "Password is too long. Use fewer special or non-English characters."],
    [valid({ newPassword: OLD, confirmPassword: OLD }), "newPassword", "Your new password must be different from your current password."],
    [valid({ currentPassword: "" }), "currentPassword", "Enter your current password."],
    [valid({ currentPassword: "x".repeat(257) }), "currentPassword", "Current password is too long."],
    [{ currentPassword: OLD, newPassword: "brand-new-pass" }, "confirmPassword", "Confirm your new password."],
    [valid({ newPassword: 12345678 }), "newPassword", "Enter a new password."],
    [valid({ name: "x" }), "body", null],
    [valid({ studentId: "victim" }), "body", null],
    [[], "body", null],
  ];
  let i = 0;
  for (const [body, field, message] of cases) {
    if (i++ % 8 === 0) await freshStudent(); // stay under the 10-attempt budget
    const result = await refused(change(body), 400, "VALIDATION_ERROR", field);
    if (message) assert.equal(result.body.error.message, message, JSON.stringify(body).slice(0, 80));
    assertNoStore(result.response);
  }
  assert.deepEqual(bcryptOps(), [], "no bcrypt work for invalid input");
  assert.equal(ops("student.updateMany").length, 0);

  for (const ok of ["a".repeat(8), "a".repeat(64), sinhala24]) {
    await freshStudent();
    const result = await change(valid({ newPassword: ok, confirmPassword: ok }));
    assert.equal(result.status, 200, `${ok.length} characters accepted`);
  }
});

test("the 72-byte rule is exactly bcrypt's truncation rule", () => {
  for (const value of ["a".repeat(64), "අ".repeat(24), "අ".repeat(25), `${"a".repeat(62)}é`, `${"a".repeat(63)}😀`, "é".repeat(36), "é".repeat(37)]) {
    assert.equal(validation.utf8ByteLength(value) > 72, realBcrypt.truncates(value), value);
  }
});

test("oversized and malformed bodies are refused (413 / 400) and still count as attempts", async () => {
  reset();
  await freshStudent();
  await refused(change(JSON.stringify({ ...valid(), pad: "x".repeat(2_000) })), 413, "REQUEST_TOO_LARGE");
  await refused(change(valid(), { headers: { "Content-Length": "99999" } }), 413, "REQUEST_TOO_LARGE");
  await refused(change("{not json"), 400, "INVALID_JSON");
  await refused(change(undefined), 400, "INVALID_JSON");
  for (let i = 0; i < 6; i += 1) await refused(change("{"), 400, "INVALID_JSON");
  // 10 malformed requests used the whole budget: a valid one is now refused.
  const limited = await refused(change(valid()), 429, "PASSWORD_CHANGE_RATE_LIMITED");
  assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
  assert.deepEqual(bcryptOps(), []);
});

// ---- Sessions and origin -----------------------------------------------------------------------------

test("sessions: missing, invalid, stale, inactive, deleted and unknown students are refused before any bcrypt or write", async () => {
  reset();
  state.cookie = null;
  await refused(change(valid()), 401, "UNAUTHORIZED"); // no app cookie: the unchanged fallback branch
  state.cookie = "not-a-jwt";
  await refused(change(valid()), 401, "UNAUTHORIZED");

  const stale = await freshStudent({ sessionVersion: 3 });
  state.cookie = await tokenFor(stale, 2);
  await refused(change(valid()), 401, "UNAUTHORIZED");
  const inactive = await freshStudent({ status: 1 });
  void inactive;
  await refused(change(valid()), 403, "STUDENT_ACCOUNT_INACTIVE");
  await freshStudent({ status: 2 });
  await refused(change(valid()), 401, "UNAUTHORIZED");
  state.cookie = await tokenFor("nobody", 0);
  await refused(change(valid()), 401, "UNAUTHORIZED");

  assert.deepEqual(bcryptOps(), []);
  assert.equal(ops("student.updateMany").length, 0);
});

test("same-origin is checked first: a cross-site / foreign / missing origin is 403 with no database access at all", async () => {
  reset();
  await freshStudent();
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.example" }, {}]) {
    const result = await refused(change(valid(), { origin: false, headers }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
    assertNoStore(result.response);
  }
  assert.deepEqual(state.log, [], "no database read and no bcrypt");
});

// ---- Rate limits ----------------------------------------------------------------------------------------

test("attempt limit: the 11th authenticated request in 15 minutes is 429 with Retry-After; nothing is checked or written", async () => {
  reset();
  await freshStudent();
  for (let i = 0; i < 10; i += 1) await refused(change(valid({ confirmPassword: "nope-nope" })), 400, "VALIDATION_ERROR");
  const limited = await refused(change(valid()), 429, "PASSWORD_CHANGE_RATE_LIMITED");
  const retry = Number(limited.response.headers.get("retry-after"));
  assert.ok(retry > 890 && retry <= 900, String(retry));
  assert.equal(limited.body.error.message, "Too many password change attempts. Please wait and try again.");
  assertNoStore(limited.response);
  assert.deepEqual(bcryptOps(), []);
});

test("wrong-password limit: after 5 wrong passwords even the right one is 429, refused before bcrypt", async () => {
  reset();
  await freshStudent();
  for (let i = 0; i < 5; i += 1) await refused(change(valid({ currentPassword: `wrong-${i}` })), 400, "INVALID_CURRENT_PASSWORD");
  state.log = [];
  const limited = await refused(change(valid()), 429, "PASSWORD_CHANGE_RATE_LIMITED");
  assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
  assert.deepEqual(bcryptOps(), [], "no compare once the budget is spent");
});

test("a successful change does not clear the wrong-password count", async () => {
  reset();
  const id = await freshStudent();
  for (let i = 0; i < 4; i += 1) await refused(change(valid({ currentPassword: `wrong-${i}` })), 400, "INVALID_CURRENT_PASSWORD");
  const ok = await change(valid());
  assert.equal(ok.status, 200);
  state.cookie = ok.token;
  await refused(change(valid({ currentPassword: "wrong-again", newPassword: "third-pass-1", confirmPassword: "third-pass-1" })), 400, "INVALID_CURRENT_PASSWORD");
  await refused(change(valid({ currentPassword: "brand-new-pass", newPassword: "third-pass-1", confirmPassword: "third-pass-1" })), 429, "PASSWORD_CHANGE_RATE_LIMITED");
  assert.equal(state.students.get(id).sessionVersion, 1);
});

// ---- Transaction and concurrency ----------------------------------------------------------------------------

test("reset-token failure rolls the whole change back: 500, no cookie, password and version unchanged, old session valid", async () => {
  reset();
  const id = await freshStudent();
  const token = state.cookie;
  state.tokens = [{ id: "r1", role: "STUDENT", userId: id, usedAt: null }];
  state.failTokens = true;
  const result = await refused(change(valid()), 500, "INTERNAL_SERVER_ERROR");
  assertNoStore(result.response);
  assert.equal(state.students.get(id).password, OLD_HASH);
  assert.equal(state.students.get(id).sessionVersion, 0);
  assert.equal(state.tokens[0].usedAt, null);
  state.failTokens = false;
  assert.equal(await sessionStillValid(token), true);
});

test("zero rows updated: 401 when the session was revoked (or student deleted), 403 when inactive, 409 when unexpectedly still active", async () => {
  reset();
  let id = await freshStudent();
  state.concurrentCommit = () => {
    state.students.get(id).sessionVersion += 1; // another change won
  };
  await refused(change(valid()), 401, "UNAUTHORIZED");
  assert.equal(state.students.get(id).password, OLD_HASH);

  id = await freshStudent();
  state.concurrentCommit = () => {
    state.students.get(id).status = 2;
  };
  await refused(change(valid()), 401, "UNAUTHORIZED");

  id = await freshStudent();
  state.concurrentCommit = () => {
    state.students.get(id).status = 1;
  };
  await refused(change(valid()), 403, "STUDENT_ACCOUNT_INACTIVE");

  id = await freshStudent();
  state.skipUpdate = true;
  const conflict = await refused(change(valid()), 409, "PASSWORD_CHANGE_CONFLICT");
  assert.equal(conflict.body.error.message, "Your password could not be changed. Please try again.");
  assert.equal(state.students.get(id).sessionVersion, 0);
  assert.equal(ops("passwordResetToken.updateMany").length, 0, "the transaction stopped at the student update");
});

test("two concurrent changes with the same session: exactly one succeeds; the version rises once", async () => {
  reset();
  const id = await freshStudent();
  const [a, b] = await Promise.all([
    change(valid({ newPassword: "winner-pass-a", confirmPassword: "winner-pass-a" })),
    change(valid({ newPassword: "winner-pass-b", confirmPassword: "winner-pass-b" })),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 401]);
  const winner = a.status === 200 ? "winner-pass-a" : "winner-pass-b";
  assert.equal(state.students.get(id).sessionVersion, 1);
  assert.equal(await realBcrypt.compare(winner, state.students.get(id).password), true);
  assert.equal([a, b].filter((r) => r.token).length, 1, "one replacement cookie");
});

test("JWT signing failure after the commit: the change stands, the cookie is cleared, the student signs in again", async () => {
  reset();
  const id = await freshStudent();
  const secret = process.env.JWT_SECRET;
  state.afterCommit = () => {
    delete process.env.JWT_SECRET;
  };
  let result;
  try {
    result = await change(valid());
  } finally {
    process.env.JWT_SECRET = secret;
  }
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { updated: true, reauthenticate: true });
  assert.equal(result.body.message, "Your password was changed. Please sign in again.");
  assert.match(result.setCookie, /teacher_session=;/);
  assert.match(result.setCookie, /Max-Age=0/);
  assert.equal(state.students.get(id).sessionVersion, 1);
});

// ---- Teacher / admin / guardian unchanged ----------------------------------------------------------------------

test("teacher: unchanged (no origin requirement, no confirmation enforcement, hash before verify as before, no cookie)", async () => {
  reset();
  state.cookie = await auth.signAuthToken({ sub: "t-1", email: "t@example.test", role: "TEACHER", name: "Teacher" });
  const ok = await change({ currentPassword: OLD, newPassword: "teacher-new-1", confirmPassword: "does-not-match" }, { origin: false, headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.data, { updated: true });
  assert.equal(ok.body.message, "Password updated successfully.");
  assert.equal(ok.setCookie, "", "no cookie for teachers");
  assert.deepEqual(bcryptOps(), ["hash", "compare"], "teacher order unchanged");
  assert.deepEqual(ops("teacher.update")[0].data, ["password"]);
  assert.equal(await realBcrypt.compare("teacher-new-1", state.teachers.get("t-1").password), true);

  const wrong = await change({ currentPassword: "nope", newPassword: "teacher-new-2" }, { origin: false });
  assert.deepEqual([wrong.status, wrong.body.error.code], [400, "INVALID_CURRENT_PASSWORD"]);
  const invalid = await change({ currentPassword: "x", newPassword: "short" }, { origin: false });
  assert.deepEqual([invalid.status, invalid.body.error.code], [400, "VALIDATION_ERROR"]);
  assert.equal(state.students.size, 0);
});

test("admin: still 403 FORBIDDEN", async () => {
  reset();
  state.cookie = await auth.signAuthToken({ sub: "admin-pathum", email: "a@example.test", role: "ADMIN", name: "Admin" });
  const result = await change(valid());
  assert.deepEqual([result.status, result.body.error.code, result.body.error.message], [403, "FORBIDDEN", "Admin password cannot be changed from this endpoint."]);
});

test("guardian: the existing branch is unchanged (reached here without middleware; see the report on its middleware limitation)", async () => {
  reset();
  state.guardianCookie = await guardianAuth.signGuardianToken({ sub: "g-1", email: "g@example.test", role: "GUARDIAN", name: "G" });
  const result = await change({ currentPassword: OLD, newPassword: "guardian-new-1" }, { origin: false });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(ops("guardian.update")[0].data, ["password"]);
  assert.equal(result.setCookie, "");
});

test("the shared service no longer changes student passwords", async () => {
  reset();
  state.students.set("s-x", { id: "s-x", password: OLD_HASH, status: 0, sessionVersion: 0 });
  await assert.rejects(
    updatePasswordForAuthenticatedUser({ role: "STUDENT", userId: "s-x", currentPassword: OLD, newPassword: "sneaky-pass-1" }),
    (error) => error.code === "ROLE_NOT_SUPPORTED"
  );
  assert.deepEqual(state.log, []);
  assert.equal(state.students.get("s-x").password, OLD_HASH);
});

// ---- The page ------------------------------------------------------------------------------------------------------------------

async function page() {
  try {
    return { element: await AccountSecurityPage() };
  } catch (error) {
    if (error instanceof Redirect) return { redirect: error.url };
    throw error;
  }
}

test("/account/security: students are checked centrally; the form gets the role (role-aware navigation)", async () => {
  reset();
  await freshStudent();
  assert.equal((await page()).element.props.role, "STUDENT");
  const id = await freshStudent({ sessionVersion: 1 });
  state.cookie = await tokenFor(id, 0);
  assert.deepEqual(await page(), { redirect: "/login" }, "stale session");
  await freshStudent({ status: 1 });
  assert.deepEqual(await page(), { redirect: "/login" }, "inactive");
  state.cookie = null;
  assert.deepEqual(await page(), { redirect: "/login" });
  state.cookie = await auth.signAuthToken({ sub: "t-1", email: "t@example.test", role: "TEACHER", name: "Teacher" });
  assert.equal((await page()).element.props.role, "TEACHER");
  state.cookie = await auth.signAuthToken({ sub: "admin-pathum", email: "a@example.test", role: "ADMIN", name: "Admin" });
  assert.equal((await page()).element.props.role, "ADMIN");
  await freshStudent();
  state.failStudentReads = true;
  await assert.rejects(AccountSecurityPage(), /db down/, "a database error is never a rendered form");
});

// ---- SP-6C: the registration number is never a new password --------------------------------------

test("a new password equal to the registration number (any case, surrounding spaces) is refused before any bcrypt work", async () => {
  reset();
  let id = await freshStudent();
  const reg = `REG-${id.toUpperCase()}`;
  for (const candidate of [reg, reg.toLowerCase(), `  ${reg}  `, `Reg-${id.toUpperCase()}`]) {
    const result = await refused(change(valid({ newPassword: candidate, confirmPassword: candidate })), 400, "VALIDATION_ERROR", "newPassword");
    assert.equal(result.body.error.message, "Your new password must not be your registration number.", JSON.stringify(candidate));
    assertNoStore(result.response);
  }
  assert.deepEqual(bcryptOps(), [], "no compare and no hash");
  assert.equal(ops("student.updateMany").length, 0);
  assert.equal(state.students.get(id).password, OLD_HASH);

  // The number comes from the student's own record: another student's number is just a password.
  const other = `REG-${id.toUpperCase()}`;
  id = await freshStudent();
  const ok = await change(valid({ newPassword: other, confirmPassword: other }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("passwords that only contain or resemble the registration number are accepted", async () => {
  reset();
  for (const make of [(reg) => `${reg}-mine!`, (reg) => `my ${reg} pass`, (reg) => `${reg}0`]) {
    const id = await freshStudent();
    const candidate = make(`REG-${id.toUpperCase()}`);
    const result = await change(valid({ newPassword: candidate, confirmPassword: candidate }));
    assert.equal(result.status, 200, `${candidate}: ${JSON.stringify(result.body)}`);
  }
});

test("the registration number cannot be supplied by the client (strict body); a student without one is unaffected", async () => {
  reset();
  await freshStudent();
  await refused(change({ ...valid(), registrationNumber: "brand-new-pass" }), 400, "VALIDATION_ERROR", "body");
  await freshStudent({ registrationNumber: null });
  assert.equal((await change(valid())).status, 200);
});

test("isRegistrationNumberPassword: whole-value equality only, trimmed and case-insensitive", () => {
  const same = validation.isRegistrationNumberPassword;
  assert.equal(same("PAT-2026-001", "PAT-2026-001"), true);
  assert.equal(same(" pat-2026-001\t", "PAT-2026-001"), true);
  assert.equal(same("PAT-2026-001", "  pat-2026-001 "), true);
  for (const password of ["PAT-2026-0011", "PAT-2026-01", "xPAT-2026-001", "PAT 2026 001", "PAT-2026-001!", ""]) {
    assert.equal(same(password, "PAT-2026-001"), false, password);
  }
  assert.equal(same("anything", null), false);
  assert.equal(same("", ""), false, "an empty number never matches");
  assert.equal(same("   ", "   "), false);
});
