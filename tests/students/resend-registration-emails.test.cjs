/*
 * Teacher "Resend Login Details" through the common email outbox:
 * a FRESH temporary password is queued (encrypted), the background worker
 * sends it, and ONLY after the provider accepted it is the new password
 * activated (old password and sessions end). No confirmation code, no old
 * registration email.
 *
 *   npm run test:students
 *
 * Runs the real code through tsx: the resend service and route, the outbox
 * service (services/student-email-delivery-service.ts: worker pass,
 * activation, retries), the payload encryption, the real student login
 * (services/auth-service.ts loginStudent) to prove which password works, the
 * real rate limiters and the same-origin check, and the registration paths.
 *
 * Only the edges are faked: Prisma (tests/students/helpers/fake-prisma.cjs),
 * the teacher session and the mailer (records sends, can be made to fail).
 * No database or email server is contacted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const bcrypt = require("bcryptjs");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "resend-registration-"));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");
process.env.APP_URL = "http://localhost";
const TEST_KEY = "a1".repeat(32);
process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = TEST_KEY;

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

const T1 = "teacher-pathum";
const T2 = "teacher-other";
const CLASS = "class-1";
const OLD_PASSWORD = "OldPassw0rdX";
const OLD_HASH = bcrypt.hashSync(OLD_PASSWORD, 4);

// ---- Fake database --------------------------------------------------------

const { createFakePrisma } = require("./helpers/fake-prisma.cjs");
const { db, prisma: basePrisma, reset } = createFakePrisma();

const faults = { transaction: 0 };
const fakePrisma = new Proxy(
  {},
  {
    get(_, prop) {
      if (prop === "$transaction") {
        return async (arg) => {
          if (faults.transaction > 0) {
            faults.transaction -= 1;
            throw new Error("connection terminated");
          }
          return Array.isArray(arg) ? Promise.all(arg) : arg(fakePrisma);
        };
      }
      return basePrisma[prop];
    },
  }
);

const REGISTERED_AT = new Date("2026-10-01T08:00:00.000Z");

function student(overrides) {
  return {
    teacherId: T1,
    gradeId: 6,
    status: 0,
    sessionVersion: 3,
    password: OLD_HASH,
    passwordSetupPending: false,
    emailConfirmed: false,
    confirmationStatus: "APPROVED",
    registrationSource: "TEACHER",
    registeredAt: REGISTERED_AT,
    publicClass: null,
    teacher: { name: "Pathum Kumara" },
    ...overrides,
  };
}

function resetDb() {
  reset({
    teacher: [
      { id: T1, name: "Pathum Kumara", email: "pathum@mail.com" },
      { id: T2, name: "Other Teacher", email: "other.teacher@mail.com" },
    ],
    student: [
      student({ id: "s-main", name: "Nimal Perera", registrationNumber: "PK-001", email: "nimal@mail.com" }),
      student({ id: "s-pending-setup", name: "Setup Pending", registrationNumber: "PK-002", email: "new@mail.com", passwordSetupPending: true }),
      student({ id: "s-verified", name: "Verified", registrationNumber: "PK-003", email: "verified@mail.com", emailConfirmed: true }),
      student({ id: "s-deleted", name: "Deleted", registrationNumber: "PK-004", email: "deleted@mail.com", status: 2 }),
      student({ id: "s-inactive", name: "Inactive", registrationNumber: "PK-005", email: "inactive@mail.com", status: 1 }),
      student({ id: "s-declined", name: "Declined", registrationNumber: "PK-006", email: "declined@mail.com", confirmationStatus: "REJECTED" }),
      student({ id: "s-noemail", name: "No Email", registrationNumber: "PK-007", email: "  " }),
      student({ id: "s-nopassword", name: "Legacy", registrationNumber: "PK-008", email: "legacy@mail.com", password: null }),
      student({ id: "s-other", name: "Other", registrationNumber: "OT-001", email: "other@mail.com", teacherId: T2, teacher: { name: "Other Teacher" } }),
    ],
    studentDevice: [
      { id: "d-1", studentId: "s-main", status: "APPROVED", deviceHash: "hash-a" },
      { id: "d-2", studentId: "s-main", status: "PENDING", deviceHash: "hash-b" },
      { id: "d-3", studentId: "s-main", status: "REJECTED", deviceHash: "hash-c" },
    ],
    classStudent: [{ id: "e-1", studentId: "s-main", classId: CLASS }],
    passwordResetToken: [
      { id: "t-1", role: "STUDENT", userId: "s-main", usedAt: null },
      { id: "t-2", role: "STUDENT", userId: "s-other", usedAt: null },
    ],
    class: [{ id: CLASS, teacherId: T1, status: 0, name: "Grade 6 Maths" }],
    grade: [{ id: 6 }],
    teacherProfile: [{ teacherId: T1, phone: null, whatsapp: null, teacher: { name: "Pathum Kumara" } }],
    emailVerificationCode: [],
    emailDelivery: [],
  });
}

// ---- Fakes for the edges ----------------------------------------------------

const sent = []; // { kind, ...input }
/** Failures for the next sends, in order: "rejected" | "timeout" | "network" | "temporary". */
const failures = [];
/** Runs inside the send, before it returns (simulates a concurrent change). */
let duringSend = null;
let login = { role: "TEACHER", id: T1 };

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

function mailError(kind) {
  if (kind === "timeout") return Object.assign(new Error("Sender.net request timed out after 15s."), { code: "SENDER_TIMEOUT" });
  if (kind === "network") return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  if (kind === "temporary") return Object.assign(new Error("421 4.7.0 Try again later"), { code: "EENVELOPE", responseCode: 421 });
  return Object.assign(new Error("Sender.net rejected the email (HTTP 422): to.email nimal@mail.com is invalid"), { code: "SENDER_VALIDATION_FAILED" });
}

fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!login) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    if (login.role !== "TEACHER") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { teacherId: login.id, name: "Teacher", email: "t@mail.com", role: "TEACHER" };
  },
});
fake("lib/mailer.ts", {
  buildPasswordResetLink: () => "https://slclassroom.live/reset",
  buildStudentLoginLink: () => "https://slclassroom.live/login",
  sendStudentWelcomeCredentialsEmail: async (input) => {
    if (duringSend) await duringSend();
    const failure = failures.shift();
    if (failure) throw mailError(failure);
    sent.push({ kind: "credentials", ...input });
    return { messageId: `msg-${sent.length}` };
  },
  sendPasswordResetEmail: async () => {},
  sendPasswordChangedEmail: async () => {},
  sendEmail: async () => {},
  sendStudentRegistrationEmail: async (input) => sent.push({ kind: "old-registration", ...input }),
  sendEmailVerificationCodeEmail: async (input) => sent.push({ kind: "code", ...input }),
});

const RESEND = require(path.join(root, "services", "student-registration-email-resend-service.ts"));
const OUTBOX = require(path.join(root, "services", "student-email-delivery-service.ts"));
const route = require(path.join(root, "app", "api", "students", "[id]", "resend-registration-emails", "route.ts"));
const { createStudent, RegisterStudentViaPublicClasses } = require(path.join(root, "services", "student-service.ts"));
const { loginStudent } = require(path.join(root, "services", "auth-service.ts"));
const { setStudentLoginRateLimiterForTests } = require(path.join(root, "lib", "student-login-rate-limit.ts"));
const {
  setTeacherStudentPasswordResetRateLimiterForTests,
  createTeacherStudentPasswordResetRateLimiter,
} = require(path.join(root, "lib", "teacher-student-password-reset-rate-limit.ts"));

const logs = [];
const originalLog = console.log;
const originalError = console.error;
// One hour AHEAD of the real clock: registration and route paths queue rows with
// the real time, which the worker (run on this clock) must see as due.
let clock = new Date(Date.now() + 60 * 60_000);
const now = () => clock;
const advance = (seconds) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

function setup() {
  resetDb();
  RESEND.resetRegistrationEmailResendStateForTests();
  setStudentLoginRateLimiterForTests();
  setTeacherStudentPasswordResetRateLimiterForTests();
  sent.length = 0;
  logs.length = 0;
  failures.length = 0;
  duringSend = null;
  faults.transaction = 0;
  login = { role: "TEACHER", id: T1 };
  process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = TEST_KEY;
  clock = new Date(Date.now() + 60 * 60_000);
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
}

test.afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const appError = (code, status) => (error) => error.code === code && error.statusCode === status;
const row = (id) => db.student.find((s) => s.id === id);
const deliveries = (studentId) => db.emailDelivery.filter((d) => d.studentId === studentId);
const resend = (studentId, teacherId = T1) => RESEND.resendStudentRegistrationEmails(teacherId, studentId, { now });
/** One worker pass at the test clock. */
const work = () => OUTBOX.processEmailDeliveries({ now });

async function callRoute(studentId, headers = { origin: "http://localhost" }) {
  const request = new Request(`http://localhost/api/students/${studentId}/resend-registration-emails`, { method: "POST", headers });
  const response = await route.POST(request, { params: { id: studentId } });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** "OK" or the AppError code of a real student login. */
async function tryLogin(registrationNumber, password) {
  try {
    await loginStudent(registrationNumber, password);
    return "OK";
  } catch (error) {
    return error.code ?? error.message;
  }
}

function assertNoSecretsLogged(password) {
  for (const line of logs) {
    assert.ok(!line.includes(password), "the temporary password is never logged");
    assert.ok(!/\$2[aby]\$/.test(line), "no password hash is logged");
    assert.ok(!/v1\.[A-Za-z0-9_-]{20,}/.test(line), "no ciphertext is logged");
  }
}

// ---- Queue, then activate only after acceptance ---------------------------------

test("the request only QUEUES: the old password keeps working, the new one is stored encrypted and pending", async () => {
  setup();
  const result = await resend("s-main");

  assert.equal(result.outcome, "QUEUED");
  assert.equal(result.email, "nimal@mail.com");
  assert.equal(typeof result.deliveryId, "string");
  assert.equal(sent.length, 0, "nothing is sent by the request itself");

  const [delivery] = deliveries("s-main");
  assert.equal(delivery.emailType, "STUDENT_CREDENTIAL_RESEND");
  assert.equal(delivery.status, "PENDING");
  assert.equal(delivery.initiatedBy, "TEACHER_RESEND");
  assert.match(delivery.encryptedPayload, /^v1\./);
  assert.ok(delivery.pendingPasswordHash.startsWith("$2"));
  assert.equal(delivery.activeOperationKey, "resend:s-main");

  // The account is untouched until the provider accepts the email.
  assert.equal(row("s-main").password, OLD_HASH);
  assert.equal(row("s-main").sessionVersion, 3);
  assert.equal(await tryLogin("PK-001", OLD_PASSWORD), "OK");
});

test("after the provider accepts: the emailed password works, the old one does not, sessions end, reset links retired", async () => {
  setup();
  await resend("s-main");
  const report = await work();
  assert.equal(report.sent, 1);
  assert.equal(report.activated, 0, "activated inline, not by the sweep");

  assert.equal(sent.length, 1);
  const [mail] = sent;
  assert.equal(mail.kind, "credentials");
  assert.equal(mail.to, "nimal@mail.com");
  assert.equal(mail.registrationNumber, "PK-001");
  assert.match(mail.temporaryPassword, /^[A-HJ-NP-Za-km-np-z2-9]{12}$/);

  assert.equal(await tryLogin("PK-001", OLD_PASSWORD), "INVALID_CREDENTIALS");
  assert.equal(await tryLogin("PK-001", mail.temporaryPassword), "OK");
  assert.equal(row("s-main").sessionVersion, 4);
  assert.ok(db.passwordResetToken.find((t) => t.id === "t-1").usedAt instanceof Date);
  assert.equal(db.passwordResetToken.find((t) => t.id === "t-2").usedAt, null);

  const [delivery] = deliveries("s-main");
  assert.equal(delivery.status, "SENT");
  assert.equal(delivery.providerMessageId, "msg-1");
  assert.ok(delivery.activatedAt instanceof Date);
  assert.equal(delivery.encryptedPayload, null, "ciphertext removed after acceptance");
  assert.equal(delivery.pendingPasswordHash, null);
  assert.equal(delivery.activeOperationKey, null);
  assertNoSecretsLogged(mail.temporaryPassword);
});

test("a transient failure keeps the old password; the automatic retry sends the SAME password, then activates", async () => {
  setup();
  await resend("s-main");
  failures.push("temporary");
  const first = await work();
  assert.equal(first.retryScheduled, 1);

  const [delivery] = deliveries("s-main");
  assert.equal(delivery.status, "PENDING");
  assert.equal(delivery.attemptCount, 1);
  assert.equal(delivery.lastErrorCode, "SMTP_421");
  assert.equal(delivery.lastOutcomeAmbiguous, false);
  assert.equal(delivery.nextRetryAt.getTime(), clock.getTime() + 60_000, "first backoff = base");
  assert.equal(await tryLogin("PK-001", OLD_PASSWORD), "OK", "old password still valid");

  // Not due yet: nothing happens.
  assert.equal((await work()).claimed, 0);
  advance(61);
  await work();
  assert.equal(sent.length, 1);
  assert.equal(await tryLogin("PK-001", sent[0].temporaryPassword), "OK");
  assert.ok(await bcrypt.compare(sent[0].temporaryPassword, row("s-main").password));
});

test("ambiguous outcomes (timeout, connection lost) are retried with the same credentials; a duplicate never carries a different password", async () => {
  setup();
  await resend("s-main");
  failures.push("timeout", "network");
  await work();
  assert.equal(deliveries("s-main")[0].lastOutcomeAmbiguous, true);
  assert.equal(deliveries("s-main")[0].lastErrorCode, "SENDER_TIMEOUT");
  advance(61);
  await work();
  assert.equal(deliveries("s-main")[0].lastErrorCode, "ECONNRESET");
  assert.equal(deliveries("s-main")[0].nextRetryAt.getTime(), clock.getTime() + 120_000, "exponential backoff");
  advance(121);
  await work();
  assert.equal(sent.length, 1);
  assert.equal(deliveries("s-main")[0].attemptCount, 3);
  assert.equal(await tryLogin("PK-001", sent[0].temporaryPassword), "OK");
});

test("provider rejection fails at once (no automatic retry); the old password stays valid; the stored message is sanitized", async () => {
  setup();
  await resend("s-main");
  failures.push("rejected");
  const report = await work();
  assert.equal(report.failed, 1);

  const [delivery] = deliveries("s-main");
  assert.equal(delivery.status, "FAILED");
  assert.equal(delivery.lastErrorCode, "SENDER_VALIDATION_FAILED");
  assert.doesNotMatch(delivery.lastErrorMessage, /nimal@mail\.com/, "no address in the stored error");
  assert.match(delivery.encryptedPayload, /^v1\./, "kept for a manual retry");
  assert.equal(delivery.activeOperationKey, null, "a new resend may be requested");
  assert.equal(row("s-main").password, OLD_HASH);
  assert.equal(await tryLogin("PK-001", OLD_PASSWORD), "OK");
});

test("manual retry of a failed resend sends the SAME password (no new credentials) and then activates it", async () => {
  setup();
  await resend("s-main");
  failures.push("rejected");
  await work();
  const [delivery] = deliveries("s-main");
  const pendingHash = delivery.pendingPasswordHash;

  await OUTBOX.retryEmailDeliveryByTeacher({ teacherId: T1, deliveryId: delivery.id, now: clock });
  assert.equal(delivery.status, "PENDING");
  assert.equal(delivery.pendingPasswordHash, pendingHash, "same new credentials");
  assert.equal(delivery.attemptCount, 1, "history kept");
  await work();
  assert.equal(sent.length, 1);
  assert.ok(await bcrypt.compare(sent[0].temporaryPassword, pendingHash));
  assert.equal(await tryLogin("PK-001", sent[0].temporaryPassword), "OK");
});

test("maximum attempts: terminal FAILED, old password still valid, a new resend can be requested", async () => {
  setup();
  await resend("s-main");
  failures.push("temporary", "temporary", "temporary", "temporary", "temporary");
  for (let i = 0; i < 5; i += 1) {
    await work();
    advance(7 * 3600);
  }
  const [delivery] = deliveries("s-main");
  assert.equal(delivery.status, "FAILED");
  assert.equal(delivery.attemptCount, 5);
  assert.equal(delivery.maxAttempts, 5);
  assert.equal(sent.length, 0);
  assert.equal(await tryLogin("PK-001", OLD_PASSWORD), "OK");
  assert.equal((await resend("s-main")).outcome, "QUEUED");
});

test("account changed while the email was being sent: accepted but NOT activated (recorded); the student's own password is kept", async () => {
  setup();
  const ownHash = bcrypt.hashSync("StudentChose1", 4);
  await resend("s-main");
  duringSend = async () => {
    row("s-main").password = ownHash; // e.g. the student set their own password meanwhile
  };
  await work();
  const [delivery] = deliveries("s-main");
  assert.equal(delivery.status, "SENT");
  assert.equal(delivery.activatedAt ?? null, null);
  assert.equal(delivery.activationErrorCode, "ACCOUNT_CHANGED");
  assert.equal(delivery.pendingPasswordHash, null);
  assert.equal(delivery.activeOperationKey, null);
  assert.equal(row("s-main").password, ownHash);
  assert.equal(await tryLogin("PK-001", sent[0].temporaryPassword), "INVALID_CREDENTIALS");
});

test("account changed BEFORE the send: nothing is sent (the queued password could never be activated)", async () => {
  setup();
  await resend("s-main");
  row("s-main").sessionVersion = 4; // e.g. a teacher reset meanwhile
  await work();
  const [delivery] = deliveries("s-main");
  assert.equal(delivery.status, "FAILED");
  assert.equal(delivery.lastErrorCode, "ACCOUNT_CHANGED");
  assert.equal(delivery.encryptedPayload, null);
  assert.equal(sent.length, 0);
  await assert.rejects(OUTBOX.retryEmailDeliveryByTeacher({ teacherId: T1, deliveryId: delivery.id, now: clock }), appError("EMAIL_RETRY_CREDENTIALS_UNUSABLE", 409));
});

test("activation failure after acceptance is recorded and recovered by the next pass; the old password works until then", async () => {
  setup();
  await resend("s-main");
  faults.transaction = 2; // activation fails inline AND in the same pass's sweep (database down)
  await work();
  const [delivery] = deliveries("s-main");
  assert.equal(delivery.status, "SENT");
  assert.equal(delivery.activatedAt ?? null, null);
  assert.equal(delivery.activationErrorCode ?? null, null, "not a conflict: activation pending");
  assert.ok(delivery.pendingPasswordHash, "kept until activated");
  assert.equal(await tryLogin("PK-001", OLD_PASSWORD), "OK", "not invalidated prematurely");

  const report = await work();
  assert.equal(report.activated, 1);
  assert.equal(await tryLogin("PK-001", sent[0].temporaryPassword), "OK");
  assert.equal(await tryLogin("PK-001", OLD_PASSWORD), "INVALID_CREDENTIALS");
  // Idempotent: another pass changes nothing.
  assert.equal((await work()).activated, 0);
  assert.equal(row("s-main").sessionVersion, 4);
});

test("activation supersedes the student's older open credential emails (they would carry a dead password)", async () => {
  setup();
  db.emailDelivery.push({
    id: "old-welcome",
    emailType: "STUDENT_WELCOME",
    status: "FAILED",
    studentId: "s-main",
    teacherId: T1,
    recipientEmail: "nimal@mail.com",
    idempotencyKey: "student-welcome:s-main",
    attemptCount: 5,
    maxAttempts: 5,
    encryptedPayload: "v1.placeholder",
    payloadExpiresAt: new Date(clock.getTime() + 3600_000),
    lastErrorCode: "SMTP_550",
    lastOutcomeAmbiguous: false,
    createdAt: new Date(clock.getTime() - 60_000),
  });
  await resend("s-main");
  await work();
  const old = db.emailDelivery.find((d) => d.id === "old-welcome");
  assert.equal(old.lastErrorCode, "CREDENTIALS_SUPERSEDED");
  assert.match(old.lastErrorMessage, /previous error: SMTP_550/);
  assert.equal(old.encryptedPayload, null);
});

// ---- What must not change -------------------------------------------------------

test("devices, approvals, enrolment, account approval, the teacher link and the first-login flag are untouched", async () => {
  setup();
  const before = JSON.parse(JSON.stringify({ devices: db.studentDevice, enrolments: db.classStudent }));
  const s = row("s-main");
  const keep = { teacherId: s.teacherId, confirmationStatus: s.confirmationStatus, status: s.status, emailConfirmed: s.emailConfirmed, registrationNumber: s.registrationNumber, email: s.email };

  await resend("s-main");
  await resend("s-pending-setup");
  await work();

  assert.deepEqual(JSON.parse(JSON.stringify({ devices: db.studentDevice, enrolments: db.classStudent })), before);
  const after = row("s-main");
  assert.deepEqual(
    { teacherId: after.teacherId, confirmationStatus: after.confirmationStatus, status: after.status, emailConfirmed: after.emailConfirmed, registrationNumber: after.registrationNumber, email: after.email },
    keep
  );
  assert.equal(row("s-pending-setup").passwordSetupPending, true, "not answered yet: still offered");
  assert.equal(row("s-main").passwordSetupPending, false, "already answered: not asked again");

  for (const file of ["student-registration-email-resend-service.ts", "student-email-delivery-service.ts"]) {
    const source = fs.readFileSync(path.join(root, "services", file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.doesNotMatch(source, /passwordSetupPending|studentDevice|classStudent\b/, `${file} never writes these`);
  }
});

test("only the credentials email is sent: no confirmation code, no old registration email", async () => {
  setup();
  await resend("s-main");
  await work();
  assert.deepEqual(sent.map((s) => s.kind), ["credentials"]);
  assert.equal(db.emailVerificationCode.length, 0);
});

test("a legacy student with no password and a verified-email student can both be sent new details", async () => {
  setup();
  await resend("s-nopassword");
  await resend("s-verified");
  await resend("s-inactive");
  await work();
  assert.equal(sent.length, 3);
  assert.ok(await bcrypt.compare(sent.find((m) => m.to === "legacy@mail.com").temporaryPassword, row("s-nopassword").password));
});

// ---- Refusals and repeated requests ------------------------------------------------

test("deleted, declined, no email and another teacher's student are refused before anything is queued", async () => {
  setup();
  await assert.rejects(resend("s-deleted"), appError("STUDENT_NOT_FOUND", 404));
  await assert.rejects(resend("s-declined"), appError("STUDENT_REGISTRATION_DECLINED", 409));
  await assert.rejects(resend("s-noemail"), appError("STUDENT_EMAIL_MISSING", 400));
  await assert.rejects(resend("s-other"), appError("STUDENT_NOT_FOUND", 404));
  await assert.rejects(resend("missing"), appError("STUDENT_NOT_FOUND", 404));
  assert.equal(db.emailDelivery.length, 0);
});

test("missing encryption key: 503, nothing queued, nothing changed", async () => {
  setup();
  delete process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY;
  await assert.rejects(resend("s-main"), appError("EMAIL_ENCRYPTION_NOT_CONFIGURED", 503));
  assert.equal(db.emailDelivery.length, 0);
  assert.equal(row("s-main").password, OLD_HASH);
});

test("one request per minute per student (429), and only one unresolved resend per student (409)", async () => {
  setup();
  await resend("s-main");
  await assert.rejects(resend("s-main"), appError("RESEND_THROTTLED", 429));
  advance(61);
  await assert.rejects(resend("s-main"), appError("RESEND_IN_PROGRESS", 409), "the first is still queued");
  assert.equal(deliveries("s-main").length, 1);
  await work();
  advance(61);
  assert.equal((await resend("s-main")).outcome, "QUEUED", "allowed once the first was resolved");
});

test("concurrent duplicate requests: exactly one is queued", async () => {
  setup();
  const results = await Promise.allSettled([resend("s-main"), resend("s-main")]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "RESEND_IN_PROGRESS");
  assert.equal(deliveries("s-main").length, 1);
});

// ---- Route -------------------------------------------------------------------------

test("route: no session / student session 401, another teacher's student 404; nothing queued", async () => {
  setup();
  login = null;
  assert.equal((await callRoute("s-main")).status, 401);
  login = { role: "STUDENT", id: "s-main" };
  assert.equal((await callRoute("s-main")).status, 401);
  login = { role: "TEACHER", id: T2 };
  const other = await callRoute("s-main");
  assert.equal(other.status, 404);
  assert.equal(db.emailDelivery.length, 0);
});

test("route: a cross-site or origin-less request is refused (403)", async () => {
  setup();
  for (const headers of [{}, { origin: "https://evil.example" }, { origin: "http://localhost", "sec-fetch-site": "cross-site" }]) {
    const { status, body } = await callRoute("s-main", headers);
    assert.equal(status, 403);
    assert.equal(body.error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  assert.equal(db.emailDelivery.length, 0);
});

test("route: success says queued (not delivered) and never returns the password, hash or ciphertext", async () => {
  setup();
  const { status, body } = await callRoute("s-main");
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.data).sort(), ["deliveryId", "email", "outcome"]);
  assert.equal(body.data.outcome, "QUEUED");
  assert.match(body.message, /queued/);
  assert.match(body.message, /current password keeps working/);
  assert.doesNotMatch(body.message, /\bdelivered\b/);
  const raw = JSON.stringify(body);
  assert.ok(!/\$2[aby]\$/.test(raw));
  assert.ok(!raw.includes("v1."));
  await work();
  assert.ok(!raw.includes(sent[0].temporaryPassword));
});

test("route: the teacher password-reset rate limit applies (429 + Retry-After)", async () => {
  setup();
  setTeacherStudentPasswordResetRateLimiterForTests(createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 1 }));
  assert.equal((await callRoute("s-main")).status, 200);
  const limited = await callRoute("s-pending-setup");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "RESEND_RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(deliveries("s-pending-setup").length, 0);
});

// ---- Registration: one queued welcome email, sent by the worker ----------------------

test("teacher-added registration queues ONE welcome email (in the creating transaction) and sends no confirmation code", async () => {
  setup();
  const created = await createStudent(T1, { registrationNumber: "PK-050", name: "New Student", gradeId: 6, contact01: "0771234567", email: "new.student@mail.com" });
  const queued = deliveries(created.id);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].emailType, "STUDENT_WELCOME");
  assert.equal(queued[0].initiatedBy, "TEACHER_ADD");
  assert.equal(queued[0].idempotencyKey, `student-welcome:${created.id}`);
  assert.equal(sent.length, 0, "registration never waits for the email");

  await work();
  assert.deepEqual(sent.map((s) => s.kind), ["credentials"]);
  assert.equal(sent[0].registrationNumber, "PK-050");
  assert.equal(db.emailVerificationCode.length, 0);
});

test("public-class registration queues ONE welcome email; the worker sends it", async () => {
  setup();
  const { student } = await RegisterStudentViaPublicClasses({
    classId: CLASS,
    studentName: "Public Student",
    email: "Public.Student@mail.com",
    mobileNumber: "0771234567",
    parentMobileNumber: "0777654321",
    gradeId: 6,
  });
  const queued = deliveries(student.id);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].initiatedBy, "PUBLIC_REGISTRATION");
  await work();
  assert.equal(sent[0].to, "public.student@mail.com");
  assert.equal(sent[0].registrationNumber, student.registrationNumber);
});

test("a newly registered student's resend keeps the first-login offer and replaces the registration password after acceptance", async () => {
  setup();
  await createStudent(T1, { registrationNumber: "PK-060", name: "Late Student", gradeId: 6, contact01: "0771234567", email: "late@mail.com" });
  const created = db.student.find((s) => s.email === "late@mail.com");
  created.sessionVersion ??= 0; // the fake does not apply @default(0)
  await work();
  const firstPassword = sent[0].temporaryPassword;
  assert.equal(created.passwordSetupPending, true);

  await resend(created.id);
  assert.equal(await tryLogin("PK-060", firstPassword), "OK", "still valid before acceptance");
  await work();
  assert.equal(created.passwordSetupPending, true);
  assert.equal(await tryLogin("PK-060", firstPassword), "INVALID_CREDENTIALS");
  assert.equal(await tryLogin("PK-060", sent[1].temporaryPassword), "OK");
});
