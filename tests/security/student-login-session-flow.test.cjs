/*
 * Student Profile SP-5.5: login -> JWT -> central session validation, end to end.
 *
 *   npm run test:security
 *
 * The real login route (app/api/auth/login) signs the cookie; the same token
 * then goes through the real requireStudentSession (lib/auth-session.ts ->
 * lib/student-session.ts), the student portal layout, /api/auth/me and a real
 * student API (GET /api/students/me/profile). One stateful fake Prisma backs
 * all of them, so a session-version increment or a status change "in the
 * database" is seen by every step. Teacher, admin and guardian flows are
 * checked for compatibility.
 *
 * No database: lib/prisma.ts, next/headers (the cookie) and next/navigation
 * (redirect) are fakes; JWT_SECRET is a throwaway value set here.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "sp-5-5-test-secret-not-a-real-one-0123456789";
process.env.APP_URL = "http://localhost:3000";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();
globalThis.React = require("react"); // the layout's JSX compiles to React.createElement here

const jose = require("jose");
const bcrypt = require("bcryptjs");

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

// ---- One stateful fake database -------------------------------------------------------------

const PASSWORD = "correct-horse-1";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const CREATED = new Date("2026-07-25T09:00:00.000Z");

const state = {
  cookie: null,
  students: new Map(),
  teachers: new Map(),
  guardians: new Map(),
  failStudentReads: null,
  loginQueries: [],
  validationQueries: [],
  device: null, // a DeviceApprovalException to throw, or null
  resetTokens: [],
  deviceCalls: [],
};

const pick = (row, select) => {
  const out = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
};

const prisma = {
  student: {
    // loginStudent (findStudentByRegistrationNumber): the full row, as Prisma returns it.
    findFirst: async (args) => {
      state.loginQueries.push(args);
      if (state.failStudentReads) throw state.failStudentReads;
      const row = [...state.students.values()].find((s) => s.registrationNumber === args.where.registrationNumber && s.status !== 2);
      return row ? { ...row } : null;
    },
    // Central validator, layout, /api/auth/me, profile service: selected fields only.
    findUnique: async (args) => {
      if (args.select && "sessionVersion" in args.select) state.validationQueries.push(args);
      if (state.failStudentReads) throw state.failStudentReads;
      const row = state.students.get(args.where.id);
      return row ? pick(row, args.select) : null;
    },
    // SP-5.6 password change: the conditional update (id, status, expected version).
    updateMany: async ({ where, data }) => {
      const row = state.students.get(where.id);
      if (!row || row.status !== where.status || row.sessionVersion !== where.sessionVersion) return { count: 0 };
      row.password = data.password;
      row.sessionVersion += data.sessionVersion.increment;
      return { count: 1 };
    },
  },
  passwordResetToken: {
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const token of state.resetTokens) {
        if (token.role === where.role && token.userId === where.userId && token.usedAt === where.usedAt) {
          token.usedAt = data.usedAt;
          count += 1;
        }
      }
      return { count };
    },
  },
  $transaction: async (fn) => fn(prisma),
  teacher: {
    findUnique: async (args) => {
      const row = args.where.email
        ? [...state.teachers.values()].find((t) => t.email === args.where.email)
        : state.teachers.get(args.where.id);
      if (!row) return null;
      return args.select ? pick(row, args.select) : { ...row };
    },
  },
  teacherProfile: { findUnique: async () => null },
  guardian: {
    findUnique: async (args) => {
      const row = [...state.guardians.values()].find((g) => g.email === args.where.email);
      return row ? pick(row, args.select) : null;
    },
  },
};

fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (name === "teacher_session" && state.cookie ? { name, value: state.cookie } : undefined) }),
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
fake("lib/prisma.ts", { prisma });
fake("lib/mailer.ts", {
  buildPasswordResetLink: () => "",
  sendPasswordResetEmail: async () => {},
  sendEmailVerificationCodeEmail: async () => {},
  buildGuardianLoginLink: () => "",
  sendGuardianRegistrationEmail: async () => {},
});
fake("lib/email-verification.ts", { createEmailVerificationCode: async () => "000000", verifyEmailConfirmationCode: async () => {} });
fake("lib/email-uniqueness.ts", { assertEmailAvailable: async () => {} });
fake("services/teacher-profile-section-service.ts", { defaultProfileSectionsCreateInput: () => ({}) });
fake("services/student-device.service.ts", {
  validateStudentDevice: async (input) => {
    state.deviceCalls.push(input.studentId);
    if (state.device) throw state.device;
  },
});
fake("lib/login-tracker.ts", { markTeacherLoggedIn: () => {} });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
fake("components/student-portal/student-shell.tsx", { StudentShell: (props) => ({ shell: true, ...props }) });

const auth = require(path.join(root, "lib", "auth.ts"));
const guardianAuth = require(path.join(root, "lib", "guardian-auth.ts"));
const authSession = require(path.join(root, "lib", "auth-session.ts"));
const loginLimits = require(path.join(root, "lib", "student-login-rate-limit.ts"));
const { DeviceApprovalException } = require(path.join(root, "app", "exceptions", "DeviceApprovalException.ts"));
const loginRoute = require(path.join(root, "app", "api", "auth", "login", "route.ts"));
const guardianLoginRoute = require(path.join(root, "app", "api", "guardian-auth", "login", "route.ts"));
const meRoute = require(path.join(root, "app", "api", "auth", "me", "route.ts"));
const profileRoute = require(path.join(root, "app", "api", "students", "me", "profile", "route.ts"));
const StudentLayout = require(path.join(root, "app", "student", "layout.tsx")).default;
const passwordRoute = require(path.join(root, "app", "api", "auth", "password", "update", "route.ts"));

// ---- Helpers ----------------------------------------------------------------------------

function reset() {
  Object.assign(state, { cookie: null, failStudentReads: null, loginQueries: [], validationQueries: [], device: null, deviceCalls: [], resetTokens: [] });
  loginLimits.setStudentLoginRateLimiterForTests(); // a fresh student login limiter per test (SP-6D)
  state.students = new Map();
  state.teachers = new Map([["t-1", { id: "t-1", name: "Teacher", email: "teacher@example.test", password: HASH, emailConfirmed: true, isBlocked: false, isRejected: false, createdAt: CREATED }]]);
  state.guardians = new Map([["g-1", { id: "g-1", fullName: "Guardian", email: "guardian@example.test", phone: "0770000000", password: HASH }]]);
}
function student(id, patch = {}) {
  state.students.set(id, {
    id,
    teacherId: "t-1",
    name: `Name ${id}`,
    registrationNumber: `REG-${id.toUpperCase()}`,
    email: `${id}@example.test`,
    emailConfirmed: true,
    password: HASH,
    status: 0,
    confirmationStatus: "APPROVED",
    contact01: "0771234567",
    createdAt: CREATED,
    sessionVersion: 0,
    ...patch,
  });
}
const db = (id) => state.students.get(id);

async function login(body, route = loginRoute, cookieName = "teacher_session") {
  const response = await route.POST(
    new Request("http://localhost:3000/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  );
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return { status: response.status, body: await response.json(), token: match ? match[1] : null, setCookie };
}

/** Every student entry point, with the current cookie. */
async function access() {
  const outcome = {};
  try {
    await authSession.requireStudentSession();
    outcome.session = "OK";
  } catch (error) {
    outcome.session = error.code ?? error.message;
  }
  try {
    await StudentLayout({ children: null });
    outcome.layout = "RENDERED";
  } catch (error) {
    outcome.layout = error instanceof Redirect ? error.url : `THREW ${error.message}`;
  }
  const me = await meRoute.GET(new Request("http://localhost:3000/api/auth/me"));
  outcome.me = me.status;
  const profile = await profileRoute.GET(new Request("http://localhost:3000/api/students/me/profile"));
  outcome.profile = profile.status;
  return outcome;
}
const ALLOWED = { session: "OK", layout: "RENDERED", me: 200, profile: 200 };
const REVOKED = { session: "UNAUTHORIZED", layout: "/login", me: 401, profile: 401 };
const INACTIVE = { session: "STUDENT_ACCOUNT_INACTIVE", layout: "/login", me: 403, profile: 403 };

// ---- Student login -> portal --------------------------------------------------------------

test("student login: the token's sv is the database version, the cookie is the existing session cookie, and the portal and APIs accept it", async () => {
  reset();
  student("s1");
  const result = await login({ loginId: "reg-s1", password: PASSWORD, device: { deviceId: "d-1" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(jose.decodeJwt(result.token).sv, 0);
  assert.match(result.setCookie, /teacher_session=.+; Path=\/; .*HttpOnly/i);
  assert.match(result.setCookie, /Max-Age=604800/);
  assert.deepEqual(result.body.data.user, { id: "s1", name: "Name s1", email: "s1@example.test", role: "STUDENT" }, "no version in the response body");
  assert.equal(result.body.data.redirectTo, "/student/dashboard");
  assert.deepEqual(state.loginQueries, [{ where: { registrationNumber: "REG-S1", status: { not: 2 } } }], "the login query is unchanged");
  assert.deepEqual(state.deviceCalls, ["s1"], "device check still runs");

  state.cookie = result.token;
  assert.deepEqual(await access(), ALLOWED);
  assert.ok(state.validationQueries.every((q) => q.where.id === "s1" && Object.keys(q.select).join() === "status,sessionVersion"));
});

test("student login reads the actual database version (4); a version in the request is ignored", async () => {
  reset();
  student("s1", { sessionVersion: 4 });
  const result = await login({ loginId: "REG-S1", password: PASSWORD, sv: 0, sessionVersion: 0 });
  assert.equal(jose.decodeJwt(result.token).sv, 4);
  state.cookie = result.token;
  assert.deepEqual(await access(), ALLOWED);
});

test("version increment: the earlier session is rejected everywhere; a new login gets the new version and works", async () => {
  reset();
  student("s1");
  const first = await login({ loginId: "REG-S1", password: PASSWORD });
  state.cookie = first.token;
  assert.deepEqual(await access(), ALLOWED);

  db("s1").sessionVersion = 1; // what a password change will do (SP-5.6)
  assert.deepEqual(await access(), REVOKED, "old session");

  const second = await login({ loginId: "REG-S1", password: PASSWORD });
  assert.equal(jose.decodeJwt(second.token).sv, 1);
  state.cookie = second.token;
  assert.deepEqual(await access(), ALLOWED, "new session");
  state.cookie = first.token;
  assert.deepEqual(await access(), REVOKED, "the old one stays rejected");
});

test("an old JWT without `sv` works while the database version is 0 and is rejected once it rises", async () => {
  reset();
  student("s1");
  state.cookie = await new jose.SignJWT({ email: "s1@example.test", role: "STUDENT", name: "Name s1" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("s1")
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  assert.deepEqual(await access(), ALLOWED);
  db("s1").sessionVersion = 1;
  assert.deepEqual(await access(), REVOKED);
});

test("a login that races a version increment yields a token that is already rejected (fails closed)", async () => {
  reset();
  student("s1", { sessionVersion: 2 });
  const result = await login({ loginId: "REG-S1", password: PASSWORD }); // read 2
  db("s1").sessionVersion = 3; // bumped before the token is used
  state.cookie = result.token;
  assert.deepEqual(await access(), REVOKED);
});

// ---- Inactive / deleted ------------------------------------------------------------------------

test("inactive and deleted students cannot log in (existing errors, no cookie); existing sessions are stopped when the status changes", async () => {
  reset();
  student("off", { status: 1, deactivationReason: "Fees" });
  student("gone", { status: 2 });
  const off = await login({ loginId: "REG-OFF", password: PASSWORD });
  assert.deepEqual([off.status, off.body.error.code, off.token], [403, "STUDENT_DEACTIVATED", null]);
  const gone = await login({ loginId: "REG-GONE", password: PASSWORD });
  assert.deepEqual([gone.status, gone.body.error.code, gone.token], [401, "INVALID_CREDENTIALS", null]);

  student("s1");
  state.cookie = (await login({ loginId: "REG-S1", password: PASSWORD })).token;
  db("s1").status = 1;
  assert.deepEqual(await access(), INACTIVE);
  db("s1").status = 2;
  assert.deepEqual(await access(), REVOKED);
  db("s1").status = 0;
  assert.deepEqual(await access(), ALLOWED, "reactivation restores the same session (version unchanged)");
  state.students.delete("s1");
  assert.deepEqual(await access(), REVOKED);
});

// ---- Existing login rules -------------------------------------------------------------------------

test("existing login validation is unchanged: wrong password, email, approval, device and payload errors never set a cookie", async () => {
  reset();
  student("s1");
  student("noemail", { email: null });
  student("unconfirmed", { emailConfirmed: false });
  student("pending", { confirmationStatus: "PENDING" });
  student("rejected", { confirmationStatus: "REJECTED" });
  const cases = [
    [{ loginId: "REG-S1", password: "wrong-password" }, 401, "INVALID_CREDENTIALS"],
    [{ loginId: "REG-UNKNOWN", password: PASSWORD }, 401, "INVALID_CREDENTIALS"],
    [{ loginId: "REG-NOEMAIL", password: PASSWORD }, 403, "STUDENT_EMAIL_MISSING"],
    [{ loginId: "REG-PENDING", password: PASSWORD }, 403, "STUDENT_PENDING_APPROVAL"],
    [{ loginId: "REG-REJECTED", password: PASSWORD }, 403, "STUDENT_REGISTRATION_REJECTED"],
    [{ loginId: "", password: PASSWORD }, 400, "VALIDATION_ERROR"],
    [{ loginId: "REG-S1" }, 400, "VALIDATION_ERROR"],
  ];
  for (const [body, status, code] of cases) {
    const result = await login(body);
    assert.deepEqual([result.status, result.body.error.code, result.token], [status, code, null], JSON.stringify(body));
  }
  // Simplified registration: an unconfirmed email no longer blocks a student (the approved device of
  // this fake still decides; teachers keep their email confirmation step).
  const unconfirmed = await login({ loginId: "REG-UNCONFIRMED", password: PASSWORD });
  assert.equal(unconfirmed.status, 200);
  assert.ok(unconfirmed.token, "signed in");
  state.device = new DeviceApprovalException("DEVICE_PENDING", "Waiting for approval.", 403, { requestId: "r-1" });
  const device = await login({ loginId: "REG-S1", password: PASSWORD });
  assert.deepEqual([device.status, device.body.error.code, device.token], [403, "DEVICE_PENDING", null]);
});

test("a database error during login or validation never authenticates", async () => {
  reset();
  student("s1");
  state.failStudentReads = new Error("connection refused");
  const failed = await login({ loginId: "REG-S1", password: PASSWORD });
  assert.deepEqual([failed.status, failed.body.success, failed.token], [500, false, null]);

  state.failStudentReads = null;
  state.cookie = (await login({ loginId: "REG-S1", password: PASSWORD })).token;
  state.failStudentReads = new Error("connection refused");
  const outcome = await access();
  assert.equal(outcome.session, "connection refused");
  assert.equal(outcome.layout, "THREW connection refused");
  assert.equal(outcome.me, 500);
  assert.equal(outcome.profile, 500);
});

// ---- Non-student compatibility ---------------------------------------------------------------------

test("teacher login is unchanged: no `sv`, teacher session works, no student validation query", async () => {
  reset();
  const result = await login({ loginId: "Teacher@Example.test", password: PASSWORD, sv: 3 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const claims = jose.decodeJwt(result.token);
  assert.deepEqual(Object.keys(claims).sort(), ["email", "exp", "iat", "name", "role", "sub"]);
  assert.equal(result.body.data.redirectTo, "/dashboard");
  state.cookie = result.token;
  assert.deepEqual(await authSession.requireTeacherSession(), { teacherId: "t-1", email: "teacher@example.test", name: "Teacher", role: "TEACHER" });
  assert.equal((await meRoute.GET(new Request("http://localhost:3000/api/auth/me"))).status, 200);
  await assert.rejects(authSession.requireStudentSession(), (e) => e.code === "UNAUTHORIZED");
  assert.equal(state.validationQueries.length, 0);
  const wrong = await login({ loginId: "teacher@example.test", password: "nope-nope" });
  assert.deepEqual([wrong.status, wrong.body.error.code, wrong.token], [401, "INVALID_CREDENTIALS", null]);
});

test("admin sessions are unchanged: the admin branch signs no version; admin tokens never reach student validation", async () => {
  reset();
  // The admin login is a fixed-credential branch of the route; it is checked by source
  // (the credentials are not repeated in tests) and through its token.
  const source = fs.readFileSync(path.join(root, "app", "api", "auth", "login", "route.ts"), "utf8").replace(/\r\n/g, "\n");
  const adminBranch = source.slice(source.indexOf("if (normalizedLoginId === ADMIN_LOGIN_ID"), source.indexOf("const loginResult"));
  assert.match(adminBranch, /signAuthToken\(\{\s*sub: ADMIN_USER\.id,\s*email: ADMIN_USER\.email,\s*role: ADMIN_USER\.role,\s*name: ADMIN_USER\.name,\s*\}\)/);
  assert.doesNotMatch(adminBranch, /sessionVersion|\bsv\b/);

  state.cookie = await auth.signAuthToken({ sub: "admin-pathum", email: "pathum@admin.local", role: "ADMIN", name: "Pathum" });
  assert.deepEqual(await authSession.requireAdminSession(), { adminId: "admin-pathum", email: "pathum@admin.local", name: "Pathum", role: "ADMIN" });
  assert.equal((await meRoute.GET(new Request("http://localhost:3000/api/auth/me"))).status, 200);
  assert.equal(state.validationQueries.length, 0);
});

test("guardian login is unchanged: its own cookie and claims, no `sv`, not an app session", async () => {
  reset();
  const result = await login({ email: "guardian@example.test", password: PASSWORD }, guardianLoginRoute, "guardian_session");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.doesNotMatch(result.setCookie, /teacher_session=/);
  assert.deepEqual(Object.keys(jose.decodeJwt(result.token)).sort(), ["email", "exp", "iat", "name", "role", "sub"]);
  assert.deepEqual(await guardianAuth.verifyGuardianToken(result.token), { sub: "g-1", email: "guardian@example.test", role: "GUARDIAN", name: "Guardian" });
  state.cookie = result.token; // even if presented as the app cookie
  await assert.rejects(authSession.requireAppSession(), (e) => e.code === "UNAUTHORIZED");
  assert.equal(state.validationQueries.length, 0);
  const wrong = await login({ email: "guardian@example.test", password: "nope-nope" }, guardianLoginRoute, "guardian_session");
  assert.deepEqual([wrong.status, wrong.body.error.code, wrong.token], [401, "INVALID_CREDENTIALS", null]);
});

// ---- SP-5.6: login -> password change -> other sessions revoked -> new session -> new password -----

async function changePassword(body) {
  const response = await passwordRoute.POST(
    new Request("http://localhost:3000/api/auth/password/update", {
      method: "POST",
      headers: { Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  const match = (response.headers.get("set-cookie") ?? "").match(/teacher_session=([^;]+)/);
  return { status: response.status, body: await response.json(), token: match ? match[1] : null };
}

test("full flow: two devices log in; a password change on one revokes the other, keeps the changer signed in, and only the new password logs in", async () => {
  reset();
  student("s1");
  state.resetTokens = [{ role: "STUDENT", userId: "s1", usedAt: null }];
  const deviceA = (await login({ loginId: "REG-S1", password: PASSWORD })).token;
  const deviceB = (await login({ loginId: "REG-S1", password: PASSWORD })).token;
  state.cookie = deviceB;
  assert.deepEqual(await access(), ALLOWED);

  state.cookie = deviceA;
  const changed = await changePassword({ currentPassword: PASSWORD, newPassword: "new-horse-22", confirmPassword: "new-horse-22" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(jose.decodeJwt(changed.token).sv, 1);
  assert.equal(db("s1").sessionVersion, 1);
  assert.ok(state.resetTokens[0].usedAt instanceof Date, "the outstanding reset link is spent");

  state.cookie = deviceB;
  assert.deepEqual(await access(), REVOKED, "the other device is signed out");
  state.cookie = deviceA;
  assert.deepEqual(await access(), REVOKED, "the pre-change cookie of this device is replaced");
  state.cookie = changed.token;
  assert.deepEqual(await access(), ALLOWED, "the reissued session works");

  const oldPassword = await login({ loginId: "REG-S1", password: PASSWORD });
  assert.deepEqual([oldPassword.status, oldPassword.body.error.code, oldPassword.token], [401, "INVALID_CREDENTIALS", null]);
  const newPassword = await login({ loginId: "REG-S1", password: "new-horse-22" });
  assert.equal(newPassword.status, 200);
  assert.equal(jose.decodeJwt(newPassword.token).sv, 1);
  state.cookie = newPassword.token;
  assert.deepEqual(await access(), ALLOWED);
});

// ---- SP-6C: the registration number is never accepted as a password ----------------------------

test("a correct password that IS the registration number is refused exactly like a wrong password (no cookie, no device check, no later checks)", async () => {
  reset();
  student("d1", { password: bcrypt.hashSync("REG-D1", 4) });
  student("w1");
  const wrong = await login({ loginId: "REG-W1", password: "not-the-password" });
  const refused = await login({ loginId: "REG-D1", password: "REG-D1", device: { deviceId: "dev-1" } });
  assert.deepEqual([refused.status, refused.token], [401, null]);
  assert.deepEqual(refused.body, wrong.body, "byte-for-byte the wrong-password answer");
  assert.equal(refused.body.error.code, "INVALID_CREDENTIALS");
  assert.deepEqual(state.deviceCalls, [], "device approval is never reached");

  // Not even an unconfirmed email or pending approval is revealed for it.
  student("d2", { password: bcrypt.hashSync("REG-D2", 4), emailConfirmed: false, confirmationStatus: "PENDING" });
  const quiet = await login({ loginId: "REG-D2", password: "REG-D2" });
  assert.deepEqual([quiet.status, quiet.body.error.code], [401, "INVALID_CREDENTIALS"]);
});

test("the comparison ignores letter case and surrounding spaces", async () => {
  reset();
  for (const [id, stored] of [["c1", "reg-c1"], ["c2", "  REG-C2  "], ["c3", "Reg-C3"], ["c4", "\tREG-C4\n"]]) {
    student(id, { password: bcrypt.hashSync(stored, 4) });
    const result = await login({ loginId: `REG-${id.toUpperCase()}`, password: stored });
    assert.deepEqual([result.status, result.body.error?.code, result.token], [401, "INVALID_CREDENTIALS", null], JSON.stringify(stored));
  }
});

test("ordinary passwords still work, including ones that merely contain or resemble the registration number", async () => {
  reset();
  for (const [id, password] of [["o1", "REG-O1-mine!"], ["o2", "my REG-O2 pass"], ["o3", "REG-O30"], ["o4", "REG-OTHER-9"], ["o5", "correct-horse-1"]]) {
    student(id, { password: bcrypt.hashSync(password, 4) });
    const result = await login({ loginId: `REG-${id.toUpperCase()}`, password });
    assert.equal(result.status, 200, `${password}: ${JSON.stringify(result.body)}`);
    assert.equal(jose.decodeJwt(result.token).sv, 0);
  }
});

test("teacher login is unaffected: a teacher password shaped like a registration number still works", async () => {
  reset();
  state.teachers.get("t-1").password = bcrypt.hashSync("PAT-2026-001", 4);
  const result = await login({ loginId: "teacher@example.test", password: "PAT-2026-001" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal("sv" in jose.decodeJwt(result.token), false);
});
