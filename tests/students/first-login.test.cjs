/*
 * Simplified student registration & first login:
 *   - the temporary password generator, the welcome email (template, one send,
 *     no credentials in logs), the bulk send;
 *   - the real login route: registration number + temporary password, the
 *     optional "Secure Your Account" step (set / skip), and that NEITHER answer
 *     bypasses the teacher's device approval (no session before approval);
 *   - existing students, teachers and email confirmation.
 *
 *   npm run test:students
 *
 * FAKES (no database, no email provider): lib/prisma.ts is a stateful fake;
 * the device approval check (services/student-device.service.ts) is a fake
 * keyed by student whose answers mirror the real service's exceptions; the
 * mailer records sends. The real device service has its own suites.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "first-login-test-secret-not-a-real-one-0123456789";
process.env.APP_URL = "http://localhost:3000";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();
const bcrypt = require("bcryptjs");

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

// ---- Fakes -----------------------------------------------------------------------------------------------------

const state = { students: new Map(), teachers: new Map(), devices: new Map(), deviceCalls: [], mails: [], resetTokens: [] };
const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });
const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);

const prisma = {
  student: {
    findFirst: async (args) => {
      const row = [...state.students.values()].find((s) => s.registrationNumber === args.where.registrationNumber && s.status !== 2);
      return row ? { ...row } : null;
    },
    findUnique: async (args) => {
      const row = state.students.get(args.where.id);
      return row ? pick(row, args.select) : null;
    },
    updateMany: async ({ where, data }) => {
      const rows = [...state.students.values()].filter((s) => matches(s, where));
      for (const row of rows) {
        for (const [key, value] of Object.entries(data)) {
          row[key] = value && typeof value === "object" && "increment" in value ? row[key] + value.increment : value;
        }
      }
      return { count: rows.length };
    },
  },
  passwordResetToken: { updateMany: async () => ({ count: 0 }) },
  $transaction: async (fn) => fn(prisma),
  teacher: {
    findUnique: async (args) => {
      const row = args.where.email ? [...state.teachers.values()].find((t) => t.email === args.where.email) : state.teachers.get(args.where.id);
      return row ? (args.select ? pick(row, args.select) : { ...row }) : null;
    },
  },
  teacherProfile: { findUnique: async () => null },
};
fake("lib/prisma.ts", { prisma });
fake("lib/mailer.ts", {
  buildPasswordResetLink: () => "",
  buildStudentLoginLink: () => "https://slclassroom.live/login",
  sendPasswordResetEmail: async () => {},
  sendEmailVerificationCodeEmail: async (input) => state.mails.push({ kind: "code", ...input }),
  sendPasswordChangedEmail: async (input) => state.mails.push({ kind: "password-changed", ...input }),
  sendStudentWelcomeCredentialsEmail: async (input) => {
    if (state.failWelcome) throw new Error(`SMTP rejected ${input.to} ${input.temporaryPassword}`);
    state.mails.push({ kind: "welcome", ...input });
  },
});
fake("lib/email-verification.ts", { createEmailVerificationCode: async () => "000000", verifyEmailConfirmationCode: async () => {} });
fake("lib/email-uniqueness.ts", { assertEmailAvailable: async () => {} });
fake("services/teacher-profile-section-service.ts", { defaultProfileSectionsCreateInput: () => ({}) });
fake("lib/login-tracker.ts", { markTeacherLoggedIn: () => {} });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });

const { DeviceApprovalException } = require(path.join(root, "app", "exceptions", "DeviceApprovalException.ts"));
// The teacher's device approval: APPROVED passes; PENDING / BLOCKED throw like the real service.
fake("services/student-device.service.ts", {
  validateStudentDevice: async (input) => {
    state.deviceCalls.push(input.studentId);
    const status = state.devices.get(input.studentId) ?? "PENDING";
    if (status === "PENDING") throw new DeviceApprovalException("DEVICE_PENDING", "Waiting for your teacher to approve this device.", 403, { currentDevice: { status: "PENDING" } });
    if (status === "BLOCKED") throw new DeviceApprovalException("DEVICE_REJECTED", "This device was rejected.", 403, { currentDevice: { status: "BLOCKED" } });
  },
});

const loginLimits = require(path.join(root, "lib", "student-login-rate-limit.ts"));
const loginRoute = require(path.join(root, "app", "api", "auth", "login", "route.ts"));
const TEMP = require(path.join(root, "lib", "student-temporary-password.ts"));
const WELCOME = require(path.join(root, "services", "student-welcome-credentials-service.ts"));
const TEMPLATE = require(path.join(root, "emails", "StudentWelcomeCredentialsEmail.ts"));

// ---- Helpers ----------------------------------------------------------------------------------------------------

const TEMPORARY = "Tmp7Pass2Word";
const TEACHER_PASSWORD = "Teacher-pass-1";

function reset() {
  Object.assign(state, { students: new Map(), devices: new Map(), deviceCalls: [], mails: [], failWelcome: false });
  loginLimits.setStudentLoginRateLimiterForTests();
  state.teachers = new Map([
    ["t-1", { id: "t-1", name: "Teacher", email: "teacher@example.test", password: bcrypt.hashSync(TEACHER_PASSWORD, 4), emailConfirmed: true, isBlocked: false, isRejected: false, createdAt: new Date() }],
    ["t-2", { id: "t-2", name: "New Teacher", email: "new.teacher@example.test", password: bcrypt.hashSync(TEACHER_PASSWORD, 4), emailConfirmed: false, isBlocked: false, isRejected: false, createdAt: new Date() }],
  ]);
}
function student(id, patch = {}) {
  state.students.set(id, {
    id,
    teacherId: "t-1",
    name: `Name ${id}`,
    registrationNumber: `PAT-2026-${id.toUpperCase()}`,
    email: `${id}@example.test`,
    emailConfirmed: false, // new students never confirm their email any more
    password: bcrypt.hashSync(TEMPORARY, 4),
    passwordSetupPending: true,
    status: 0,
    confirmationStatus: "APPROVED",
    createdAt: new Date(),
    sessionVersion: 0,
    ...patch,
  });
}
async function login(body) {
  const response = await loginRoute.POST(
    new Request("http://localhost:3000/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: { deviceId: "device-1" }, ...body }) })
  );
  const setCookie = response.headers.get("set-cookie") ?? "";
  return { status: response.status, body: await response.json(), cookie: /teacher_session=[^;]+/.test(setCookie) };
}
const reg = (id) => `PAT-2026-${id.toUpperCase()}`;

/** Captures every console line written during fn. */
async function captureLogs(fn) {
  const lines = [];
  const saved = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    saved[level] = console[level];
    console[level] = (...args) => lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}

test.beforeEach(() => reset());

// ==== 1. Credentials and the welcome email ============================================================================

test("temporary passwords: 12 characters from an unambiguous alphabet, always upper + lower + digit, never a registration number, unique", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const value = TEMP.generateTemporaryStudentPassword();
    assert.match(value, /^[A-HJ-NP-Za-km-z2-9]{12}$/);
    assert.match(value, /[A-Z]/);
    assert.match(value, /[a-z]/);
    assert.match(value, /[2-9]/);
    assert.doesNotMatch(value, /-/, "registration numbers contain '-'");
    seen.add(value);
  }
  assert.equal(seen.size, 2000);
  const source = fs.readFileSync(path.join(root, "lib", "student-temporary-password.ts"), "utf8");
  assert.match(source, /randomInt\(ALPHABET\.length\)/, "CSPRNG (crypto.randomInt), never Math.random");
  assert.doesNotMatch(source, /Math\.random/);
});

test("issued credentials: only a bcrypt hash is kept; the plain password verifies against it", async () => {
  const issued = await WELCOME.issueTemporaryStudentPassword();
  assert.match(issued.passwordHash, /^\$2[aby]\$10\$/);
  assert.equal(await bcrypt.compare(issued.temporaryPassword, issued.passwordHash), true);
});

test("welcome email: the requested content (registration number, temporary password, login URL, first-login and device notes), HTML-escaped, with a text version", () => {
  const props = { registrationNumber: "PAT-2026-001", temporaryPassword: "Ab3<script>x", loginUrl: "https://slclassroom.live/login" };
  const html = TEMPLATE.getStudentWelcomeCredentialsEmail(props);
  const text = TEMPLATE.getStudentWelcomeCredentialsText(props);
  assert.equal(TEMPLATE.STUDENT_WELCOME_SUBJECT, "Welcome to SLClassroom – Your Login Credentials");
  assert.match(html, /PAT-2026-001/);
  assert.match(html, /Ab3&lt;script&gt;x/);
  assert.doesNotMatch(html, /<script>/);
  for (const body of [html, text]) {
    assert.match(body, /Registration Number/);
    assert.match(body, /Temporary Password/);
    assert.match(body, /https:\/\/slclassroom\.live\/login/);
    assert.match(body, /You can change your password during your first login or later through your account settings\./);
    assert.match(body, /your teacher must approve your device before you can access your classroom/);
    assert.doesNotMatch(body, /confirmation code|Forgot Password/i, "no email-confirmation or reset-first instructions");
  }
  assert.match(text, /Registration Number: PAT-2026-001/);
  assert.match(text, /Temporary Password: Ab3<script>x/);
});

test("welcome emails are no longer sent inline: the shared module only issues credentials (delivery: the email outbox)", () => {
  assert.deepEqual(Object.keys(WELCOME).filter((k) => typeof WELCOME[k] === "function").sort(), ["issueTemporaryStudentPassword"]);
  // Sending, retries and their logging are covered by tests/students/email-delivery.test.cjs.
});

// ==== 2. First login ===================================================================================================

test("first login: registration number + temporary password are accepted; the optional step is offered; NO session and no device request yet", async () => {
  student("s1");
  const first = await login({ loginId: reg("s1"), password: TEMPORARY });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.passwordSetupOffered, true);
  assert.equal(first.cookie, false, "no session before the device is approved");
  assert.equal(first.body.data.redirectTo, undefined);
  assert.deepEqual(state.deviceCalls, []);
  // Lower-case registration numbers keep working as before (the lookup upper-cases).
  assert.equal((await login({ loginId: reg("s1").toLowerCase(), password: TEMPORARY })).body.data.passwordSetupOffered, true);
});

test("set new password: the student rules are enforced (nothing changes on a refusal), then the device approval still decides", async () => {
  student("s1");
  for (const [setup, field] of [
    [{ action: "set", newPassword: "short", confirmPassword: "short" }, "newPassword"],
    [{ action: "set", newPassword: "LongEnough1", confirmPassword: "Different1" }, "confirmPassword"],
    [{ action: "set", newPassword: reg("s1"), confirmPassword: reg("s1") }, "newPassword"],
    [{ action: "set", newPassword: TEMPORARY, confirmPassword: TEMPORARY }, "newPassword"],
  ]) {
    const refused = await login({ loginId: reg("s1"), password: TEMPORARY, passwordSetup: setup });
    assert.equal(refused.status, 400, JSON.stringify(setup));
    assert.equal(refused.body.error.code, "VALIDATION_ERROR");
    assert.equal(refused.body.error.details.field, field);
    assert.equal(refused.cookie, false);
  }
  assert.equal(await bcrypt.compare(TEMPORARY, state.students.get("s1").password), true, "unchanged");
  assert.equal(state.students.get("s1").passwordSetupPending, true);
  assert.deepEqual(state.deviceCalls, []);

  // A valid new password is saved (cost 12) - and the device is still pending: no session.
  const set = await login({ loginId: reg("s1"), password: TEMPORARY, passwordSetup: { action: "set", newPassword: "MyOwnPassword9", confirmPassword: "MyOwnPassword9" } });
  assert.deepEqual([set.status, set.body.error.code, set.cookie], [403, "DEVICE_PENDING", false]);
  const row = state.students.get("s1");
  assert.match(row.password, /^\$2[aby]\$12\$/);
  assert.equal(await bcrypt.compare("MyOwnPassword9", row.password), true);
  assert.equal(row.passwordSetupPending, false);
  assert.deepEqual(state.deviceCalls, ["s1"]);
  assert.deepEqual(state.mails.map((m) => m.kind), ["password-changed"]);

  // The temporary password no longer works; the new one does, once the teacher approves the device.
  assert.equal((await login({ loginId: reg("s1"), password: TEMPORARY })).status, 401);
  assert.equal((await login({ loginId: reg("s1"), password: "MyOwnPassword9" })).body.error.code, "DEVICE_PENDING");
  state.devices.set("s1", "APPROVED");
  const approved = await login({ loginId: reg("s1"), password: "MyOwnPassword9" });
  assert.deepEqual([approved.status, approved.cookie, approved.body.data.redirectTo], [200, true, "/student/dashboard"]);
  assert.equal(approved.body.data.passwordSetupOffered, undefined, "never offered again");
});

test("skip: the temporary password stays valid, the step is not offered again, and the device approval still decides", async () => {
  student("s2");
  const skipped = await login({ loginId: reg("s2"), password: TEMPORARY, passwordSetup: { action: "skip" } });
  assert.deepEqual([skipped.status, skipped.body.error.code, skipped.cookie], [403, "DEVICE_PENDING", false]);
  assert.equal(state.students.get("s2").passwordSetupPending, false);
  assert.equal(await bcrypt.compare(TEMPORARY, state.students.get("s2").password), true);

  const again = await login({ loginId: reg("s2"), password: TEMPORARY });
  assert.equal(again.body.error.code, "DEVICE_PENDING", "straight to the device check: not offered again");
  state.devices.set("s2", "APPROVED");
  const approved = await login({ loginId: reg("s2"), password: TEMPORARY });
  assert.deepEqual([approved.status, approved.cookie], [200, true]);
});

test("device rejection still applies after either answer; a wrong password applies nothing", async () => {
  student("s3");
  state.devices.set("s3", "BLOCKED");
  const rejected = await login({ loginId: reg("s3"), password: TEMPORARY, passwordSetup: { action: "skip" } });
  assert.deepEqual([rejected.status, rejected.body.error.code, rejected.cookie], [403, "DEVICE_REJECTED", false]);

  student("s4");
  const wrong = await login({ loginId: reg("s4"), password: "WrongPassword1", passwordSetup: { action: "set", newPassword: "MyOwnPassword9", confirmPassword: "MyOwnPassword9" } });
  assert.equal(wrong.status, 401);
  assert.equal(state.students.get("s4").passwordSetupPending, true);
  assert.equal(await bcrypt.compare(TEMPORARY, state.students.get("s4").password), true);
  assert.deepEqual(state.deviceCalls.filter((id) => id === "s4"), []);
});

test("account checks come first: a registration still waiting for the teacher is refused before any setup or device step", async () => {
  student("p1", { confirmationStatus: "PENDING" });
  const pending = await login({ loginId: reg("p1"), password: TEMPORARY, passwordSetup: { action: "skip" } });
  assert.deepEqual([pending.status, pending.body.error.code, pending.cookie], [403, "STUDENT_PENDING_APPROVAL", false]);
  assert.equal(state.students.get("p1").passwordSetupPending, true, "nothing applied");
  assert.deepEqual(state.deviceCalls, []);
});

// ==== 3. Existing accounts, teachers, logs ==============================================================================

test("existing students (no pending step): never offered; their passwords and approved devices work as before; unconfirmed email no longer blocks", async () => {
  student("old", { passwordSetupPending: false, password: bcrypt.hashSync("OldPassword1", 4), emailConfirmed: true });
  student("old2", { passwordSetupPending: undefined, password: bcrypt.hashSync("OldPassword1", 4) }); // a row read before the migration
  state.devices.set("old", "APPROVED");
  state.devices.set("old2", "APPROVED");
  for (const id of ["old", "old2"]) {
    const ok = await login({ loginId: reg(id), password: "OldPassword1", passwordSetup: { action: "set", newPassword: "Ignored12345", confirmPassword: "Ignored12345" } });
    assert.deepEqual([ok.status, ok.cookie, ok.body.data.passwordSetupOffered], [200, true, undefined], id);
    assert.equal(await bcrypt.compare("OldPassword1", state.students.get(id).password), true, "a setup answer is ignored when nothing is pending");
  }
});

test("teachers: unchanged - never offered the student step, and an unconfirmed teacher email still needs confirmation", async () => {
  const ok = await login({ loginId: "teacher@example.test", password: TEACHER_PASSWORD });
  assert.deepEqual([ok.status, ok.cookie, ok.body.data.redirectTo, ok.body.data.passwordSetupOffered], [200, true, "/dashboard", undefined]);
  const unconfirmed = await login({ loginId: "new.teacher@example.test", password: TEACHER_PASSWORD });
  assert.equal(unconfirmed.body.error.code, "EMAIL_NOT_CONFIRMED");
  assert.deepEqual(state.deviceCalls, []);
});

test("no temporary or new password appears in any log line during the whole first-login journey", async () => {
  student("s9");
  const logs = await captureLogs(async () => {
    await login({ loginId: reg("s9"), password: TEMPORARY });
    await login({ loginId: reg("s9"), password: TEMPORARY, passwordSetup: { action: "set", newPassword: "short", confirmPassword: "short" } });
    await login({ loginId: reg("s9"), password: TEMPORARY, passwordSetup: { action: "set", newPassword: "SecretNew123", confirmPassword: "SecretNew123" } });
    state.devices.set("s9", "APPROVED");
    await login({ loginId: reg("s9"), password: "SecretNew123" });
  });
  assert.doesNotMatch(logs, new RegExp(`${TEMPORARY}|SecretNew123`));
});

test("source: one shared credential behaviour for all three registration paths; no confirmation code at registration", () => {
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const service = stripComments(fs.readFileSync(path.join(root, "services", "student-service.ts"), "utf8"));
  const importRoute = fs.readFileSync(path.join(root, "app", "api", "students", "import", "route.ts"), "utf8");
  assert.equal((service.match(/issueTemporaryStudentPassword\(\)/g) || []).length, 2, "Add Student + public registration");
  // One welcome email per created account, queued in the creating transaction (outbox).
  assert.equal((service.match(/queueStudentWelcomeEmails\(tx, /g) || []).length, 2);
  assert.doesNotMatch(service, /sendEmailConfirmationCode\(/, "no student email-confirmation code at registration");
  assert.doesNotMatch(service, /sendStudentRegistrationEmail\(/);
  assert.match(importRoute, /issueTemporaryStudentPassword\(\)/);
  // Import: the welcome emails are queued in the same transaction as the all-or-nothing createMany.
  assert.ok(importRoute.indexOf("queueStudentWelcomeEmails(") > importRoute.indexOf("tx.student.createMany"));
  assert.doesNotMatch(importRoute, /sendStudentWelcomeCredentials/);
  const login = fs.readFileSync(path.join(root, "app", "api", "auth", "login", "route.ts"), "utf8");
  assert.ok(login.indexOf("passwordSetupOffered: true") < login.indexOf("validateStudentDevice({"), "the step comes before the device check");
  // (The first cookies.set is the pre-existing admin branch; the student / teacher session is the last one.)
  assert.ok(login.indexOf("validateStudentDevice({") < login.lastIndexOf("response.cookies.set(AUTH_COOKIE_NAME"), "the session only after the device check");
});
