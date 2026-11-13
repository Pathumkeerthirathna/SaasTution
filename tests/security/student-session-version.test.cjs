/*
 * Student Profile SP-5.3: student JWT session versioning (claim `sv`).
 *
 *   npm run test:security
 *
 * lib/auth.ts signs `sv` into STUDENT tokens only and reads it back (absent =
 * 0, invalid = token rejected); teacher, admin, guardian and session-invite
 * tokens are unchanged. The login flow carries the version from the
 * authenticated student record (no new query, nothing from the request).
 *
 * No database: lib/prisma.ts and the other edges are fakes in require.cache;
 * JWT_SECRET is a throwaway test value set here (no .env is read).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "sp-5-3-test-secret-not-a-real-one-0123456789";

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const jose = require("jose");
const bcrypt = require("bcryptjs");

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

// ---- Fake database (only what the login flow touches) ----------------------

const PASSWORD = "correct-horse-1";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const db = { students: [], teachers: [], studentQueries: [] };

const prisma = {
  student: {
    findFirst: async (args) => {
      db.studentQueries.push(args);
      const reg = args.where.registrationNumber;
      return db.students.find((s) => s.registrationNumber === reg && s.status !== 2) ?? null;
    },
  },
  teacher: { findUnique: async ({ where }) => db.teachers.find((t) => t.email === where.email) ?? null },
  teacherProfile: { findUnique: async () => null },
};

fake("lib/prisma.ts", { prisma });
fake("lib/mailer.ts", {
  buildPasswordResetLink: () => "",
  sendPasswordResetEmail: async () => {},
  sendEmailVerificationCodeEmail: async () => {},
});
fake("lib/email-verification.ts", { createEmailVerificationCode: async () => "000000", verifyEmailConfirmationCode: async () => {} });
fake("lib/email-uniqueness.ts", { assertEmailAvailable: async () => {} });
fake("services/teacher-profile-section-service.ts", { defaultProfileSectionsCreateInput: () => ({}) });
fake("services/student-device.service.ts", { validateStudentDevice: async () => {} });
fake("lib/login-tracker.ts", { markTeacherLoggedIn: () => {} });

const auth = require(path.join(root, "lib", "auth.ts"));
const guardianAuth = require(path.join(root, "lib", "guardian-auth.ts"));
const invite = require(path.join(root, "lib", "session-invite.ts"));
const { loginStudent, loginByLoginId } = require(path.join(root, "services", "auth-service.ts"));
const loginRoute = require(path.join(root, "app", "api", "auth", "login", "route.ts"));

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const SEVEN_DAYS = 7 * 24 * 60 * 60;
const STUDENT = { sub: "stu-1", email: "stu@example.test", role: "STUDENT", name: "Student One" };
const TEACHER = { sub: "tea-1", email: "tea@example.test", role: "TEACHER", name: "Teacher One" };
const ADMIN = { sub: "admin-1", email: "admin@example.test", role: "ADMIN", name: "Admin" };

/** A token signed like the app does, with arbitrary claims (old tokens, tampered values). */
function rawToken(claims, { sub = "stu-1", exp = "7d", secret = SECRET } = {}) {
  const jwt = new jose.SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
  if (sub !== null) jwt.setSubject(sub);
  if (exp !== null) jwt.setExpirationTime(exp);
  return jwt.sign(secret);
}
const studentClaims = (extra = {}) => ({ email: STUDENT.email, role: "STUDENT", name: STUDENT.name, ...extra });

// ---- Student claim ----------------------------------------------------------------

test("student token with sv 0: signed as the `sv` claim and read back as sessionVersion 0", async () => {
  const token = await auth.signAuthToken({ ...STUDENT, sessionVersion: 0 });
  const claims = jose.decodeJwt(token);
  assert.equal(claims.sv, 0);
  assert.deepEqual(Object.keys(claims).sort(), ["email", "exp", "iat", "name", "role", "sub", "sv"]);
  assert.deepEqual(await auth.verifyAuthToken(token), { ...STUDENT, sessionVersion: 0 });
  assert.equal(auth.STUDENT_SESSION_VERSION_CLAIM, "sv");
});

test("student token with a positive version (including the INTEGER maximum)", async () => {
  for (const version of [1, 7, 2_147_483_647]) {
    const token = await auth.signAuthToken({ ...STUDENT, sessionVersion: version });
    assert.equal(jose.decodeJwt(token).sv, version);
    assert.deepEqual(await auth.verifyAuthToken(token), { ...STUDENT, sessionVersion: version });
  }
});

test("an existing student token without `sv` is valid and read as version 0", async () => {
  const legacy = await rawToken(studentClaims());
  assert.equal("sv" in jose.decodeJwt(legacy), false);
  assert.deepEqual(await auth.verifyAuthToken(legacy), { ...STUDENT, sessionVersion: 0 });
});

test("a present but invalid `sv` rejects the student token (negative, fractional, string, malformed, too large)", async () => {
  for (const sv of [-1, -0.5, 1.5, 0.1, "0", "1", "", null, true, false, {}, [], [1], 2_147_483_648, 1e21, Number.MAX_SAFE_INTEGER + 2]) {
    const token = await rawToken(studentClaims({ sv }));
    assert.equal(await auth.verifyAuthToken(token), null, `sv = ${JSON.stringify(sv)}`);
  }
});

test("signing refuses a student token without a valid version, and a teacher / admin token with one", async () => {
  for (const sessionVersion of [undefined, -1, 1.5, "1", null, Number.NaN, Infinity]) {
    await assert.rejects(auth.signAuthToken({ ...STUDENT, sessionVersion }), /valid session version/, String(sessionVersion));
  }
  for (const base of [TEACHER, ADMIN]) {
    await assert.rejects(auth.signAuthToken({ ...base, sessionVersion: 0 }), /Only student tokens/);
  }
});

test("studentSessionVersionOf: absent (column not migrated yet) is 0; a valid value is kept; an invalid one throws", () => {
  assert.equal(auth.studentSessionVersionOf({ id: "s" }), 0);
  assert.equal(auth.studentSessionVersionOf({ sessionVersion: 0 }), 0);
  assert.equal(auth.studentSessionVersionOf({ sessionVersion: 5 }), 5);
  for (const sessionVersion of [null, -1, 1.5, "2"]) {
    assert.throws(() => auth.studentSessionVersionOf({ sessionVersion }), /Invalid student session version/);
  }
});

// ---- Other tokens unchanged -----------------------------------------------------

test("teacher and admin tokens are unchanged: same claims, no `sv`, verified to the same shape", async () => {
  for (const base of [TEACHER, ADMIN]) {
    const token = await auth.signAuthToken(base);
    const claims = jose.decodeJwt(token);
    assert.deepEqual(Object.keys(claims).sort(), ["email", "exp", "iat", "name", "role", "sub"]);
    assert.equal(claims.exp - claims.iat, SEVEN_DAYS);
    const verified = await auth.verifyAuthToken(token);
    assert.deepEqual(verified, base);
    assert.equal("sessionVersion" in verified, false);
  }
  // A teacher token carrying an `sv` (never issued) is read exactly as before: the claim is ignored.
  const odd = await rawToken({ email: TEACHER.email, role: "TEACHER", name: TEACHER.name, sv: "x" }, { sub: TEACHER.sub });
  assert.deepEqual(await auth.verifyAuthToken(odd), TEACHER);
});

test("guardian tokens are unchanged and stay separate from app tokens", async () => {
  const guardian = { sub: "g-1", email: "g@example.test", role: "GUARDIAN", name: "Guardian" };
  const token = await guardianAuth.signGuardianToken(guardian);
  const claims = jose.decodeJwt(token);
  assert.deepEqual(Object.keys(claims).sort(), ["email", "exp", "iat", "name", "role", "sub"]);
  assert.equal(claims.exp - claims.iat, SEVEN_DAYS);
  assert.deepEqual(await guardianAuth.verifyGuardianToken(token), guardian);
  assert.equal(await auth.verifyAuthToken(token), null, "a guardian token is not an app session");
  const studentToken = await auth.signAuthToken({ ...STUDENT, sessionVersion: 2 });
  assert.equal(await guardianAuth.verifyGuardianToken(studentToken), null, "a student token is not a guardian session");
  assert.deepEqual(guardianAuth.buildGuardianSessionCookieConfig(), { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: SEVEN_DAYS });
});

test("session invite tokens are unchanged and never accepted as a session", async (t) => {
  t.mock.method(console, "log", () => {}); // verifySessionInviteToken logs (pre-existing)
  const payload = { sessionId: "sess-1", classId: "class-1", studentId: "stu-1", role: "STUDENT" };
  const token = await invite.signSessionInviteToken(payload);
  const claims = jose.decodeJwt(token);
  assert.deepEqual(Object.keys(claims).sort(), ["classId", "exp", "iat", "role", "sessionId", "studentId", "type"]);
  assert.equal("sv" in claims, false);
  assert.deepEqual(await invite.verifySessionInviteToken(token), payload);
  assert.equal(await auth.verifyAuthToken(token), null);
});

test("expiry, signature and cookie behaviour unchanged", async () => {
  const student = jose.decodeJwt(await auth.signAuthToken({ ...STUDENT, sessionVersion: 1 }));
  assert.equal(student.exp - student.iat, SEVEN_DAYS, "seven days, as before");

  const expired = await rawToken(studentClaims({ sv: 0 }), { exp: Math.floor(Date.now() / 1000) - 60 });
  assert.equal(await auth.verifyAuthToken(expired), null, "expired");
  const otherSecret = await rawToken(studentClaims({ sv: 0 }), { secret: new TextEncoder().encode("another-secret-another-secret-12") });
  assert.equal(await auth.verifyAuthToken(otherSecret), null, "wrong key");

  const good = await auth.signAuthToken({ ...STUDENT, sessionVersion: 1 });
  const [header, , signature] = good.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ ...jose.decodeJwt(good), sv: 0 })).toString("base64url");
  assert.equal(await auth.verifyAuthToken(`${header}.${forgedBody}.${signature}`), null, "a changed sv breaks the signature");
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${forgedBody}.`;
  assert.equal(await auth.verifyAuthToken(unsigned), null, "alg none");
  for (const garbage of ["", "abc", "a.b.c"]) assert.equal(await auth.verifyAuthToken(garbage), null);

  assert.deepEqual(auth.buildSessionCookieConfig(), { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: SEVEN_DAYS });
  assert.equal(auth.AUTH_COOKIE_NAME, "teacher_session");
});

// ---- Login integration --------------------------------------------------------------

function seed() {
  db.studentQueries = [];
  db.students = [
    { id: "s-1", teacherId: "t-1", name: "Stu One", registrationNumber: "REG-1", email: "s1@example.test", emailConfirmed: true, password: HASH, status: 0, confirmationStatus: "APPROVED", createdAt: new Date() },
    { id: "s-3", teacherId: "t-1", name: "Stu Three", registrationNumber: "REG-3", email: "s3@example.test", emailConfirmed: true, password: HASH, status: 0, confirmationStatus: "APPROVED", createdAt: new Date(), sessionVersion: 3 },
    { id: "s-bad", teacherId: "t-1", name: "Stu Bad", registrationNumber: "REG-BAD", email: "sb@example.test", emailConfirmed: true, password: HASH, status: 0, confirmationStatus: "APPROVED", createdAt: new Date(), sessionVersion: -1 },
    { id: "s-off", teacherId: "t-1", name: "Stu Off", registrationNumber: "REG-OFF", email: "so@example.test", emailConfirmed: true, password: HASH, status: 1, confirmationStatus: "APPROVED", createdAt: new Date(), sessionVersion: 2 },
  ];
  db.teachers = [{ id: "t-1", name: "Teacher", email: "teacher@example.test", password: HASH, emailConfirmed: true, isBlocked: false, isRejected: false, createdAt: new Date() }];
}

test("loginStudent / loginByLoginId carry the version from the authenticated record, with the same query as before", async () => {
  seed();
  assert.equal((await loginStudent("reg-3", PASSWORD)).sessionVersion, 3);
  assert.equal((await loginStudent("REG-1", PASSWORD)).sessionVersion, 0, "a record without the (unmigrated) column is version 0");
  const result = await loginByLoginId("REG-3", PASSWORD);
  assert.equal(result.role, "STUDENT");
  assert.equal(result.sessionVersion, 3);
  assert.deepEqual(db.studentQueries.at(-1), { where: { registrationNumber: "REG-3", status: { not: 2 } } }, "no select added: the existing query, untouched");
  await assert.rejects(loginStudent("REG-BAD", PASSWORD), /Invalid student session version/, "a corrupt stored version never becomes a token");
  await assert.rejects(loginStudent("REG-3", "wrong-password"), (e) => e.code === "INVALID_CREDENTIALS");
});

async function login(body) {
  const response = await loginRoute.POST(
    new Request("http://localhost:3000/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  );
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/teacher_session=([^;]+)/);
  return { status: response.status, body: await response.json(), token: match ? match[1] : null };
}

test("login route: a student's token carries the record's version; any version in the request is ignored", async () => {
  seed();
  const three = await login({ loginId: "REG-3", password: PASSWORD, sv: 99, sessionVersion: 99 });
  assert.equal(three.status, 200, JSON.stringify(three.body));
  assert.equal(jose.decodeJwt(three.token).sv, 3);
  assert.deepEqual(await auth.verifyAuthToken(three.token), { sub: "s-3", email: "s3@example.test", role: "STUDENT", name: "Stu Three", sessionVersion: 3 });

  const zero = await login({ loginId: "REG-1", password: PASSWORD });
  assert.equal(jose.decodeJwt(zero.token).sv, 0);
});

test("login route: teacher tokens have no `sv`; existing login errors are unchanged", async () => {
  seed();
  const teacher = await login({ loginId: "teacher@example.test", password: PASSWORD, sv: 5 });
  assert.equal(teacher.status, 200, JSON.stringify(teacher.body));
  assert.equal("sv" in jose.decodeJwt(teacher.token), false);
  assert.deepEqual(await auth.verifyAuthToken(teacher.token), { sub: "t-1", email: "teacher@example.test", role: "TEACHER", name: "Teacher" });

  const wrong = await login({ loginId: "REG-3", password: "wrong-password" });
  assert.deepEqual([wrong.status, wrong.body.error.code, wrong.token], [401, "INVALID_CREDENTIALS", null]);
  const inactive = await login({ loginId: "REG-OFF", password: PASSWORD });
  assert.deepEqual([inactive.status, inactive.body.error.code, inactive.token], [403, "STUDENT_DEACTIVATED", null]);
  const invalid = await login({ loginId: "", password: PASSWORD });
  assert.deepEqual([invalid.status, invalid.body.error.code, invalid.token], [400, "VALIDATION_ERROR", null]);
});
