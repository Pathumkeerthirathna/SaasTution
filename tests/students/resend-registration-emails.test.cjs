/*
 * Teacher "Resend Registration Emails" for students whose email is not
 * verified yet.
 *
 *   npm run test:students
 *
 * Runs the real code through tsx:
 * services/student-registration-email-resend-service.ts, the route
 * app/api/students/[id]/resend-registration-emails/route.ts, and the real
 * services/auth-service.ts (sendEmailConfirmationCode) and
 * lib/email-verification.ts (code creation + its throttle). Also runs the
 * original registration paths (createStudent, RegisterStudentViaPublicClasses)
 * to prove they still send the same two emails.
 *
 * Only the edges are faked: Prisma (tests/students/helpers/fake-prisma.cjs),
 * the teacher session and the mailer (records sends, can be made to fail).
 * No database or SMTP server is contacted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "resend-registration-"));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

const T1 = "teacher-pathum";
const T2 = "teacher-other";
const CLASS = "class-1";

// ---- Fake database --------------------------------------------------------

const { createFakePrisma } = require("./helpers/fake-prisma.cjs");
const { db, prisma: basePrisma, reset } = createFakePrisma();

// lib/email-verification.ts uses the array form of $transaction, and its
// throttle reads EmailVerificationCode.createdAt (@default(now()) in the schema).
const codeDelegate = {
  ...basePrisma.emailVerificationCode,
  create: (args) => basePrisma.emailVerificationCode.create({ ...args, data: { createdAt: new Date(), ...args.data } }),
  // The wrong-code counter uses { attempts: { increment: 1 } }.
  async update(args) {
    const row = db.emailVerificationCode.find((r) => r.id === args.where.id);
    const data = { ...args.data };
    if (data.attempts?.increment) data.attempts = (row?.attempts ?? 0) + data.attempts.increment;
    return basePrisma.emailVerificationCode.update({ ...args, data });
  },
};
const fakePrisma = new Proxy(
  {},
  {
    get(_, prop) {
      if (prop === "$transaction") {
        return async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(fakePrisma));
      }
      if (prop === "emailVerificationCode") return codeDelegate;
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
    emailConfirmed: false,
    confirmationStatus: "PENDING",
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
      student({ id: "s-unverified", name: "Nimal Perera", registrationNumber: "PK-001", email: "nimal@mail.com" }),
      student({
        id: "s-public",
        name: "Kamal Silva",
        registrationNumber: "PK-002",
        email: "kamal@mail.com",
        registrationSource: "PUBLIC_CLASS",
        publicClassId: CLASS,
        publicClass: { name: "Grade 6 Maths" },
      }),
      student({ id: "s-verified", name: "Verified", registrationNumber: "PK-003", email: "verified@mail.com", emailConfirmed: true }),
      student({ id: "s-deleted", name: "Deleted", registrationNumber: "PK-004", email: "deleted@mail.com", status: 2 }),
      student({ id: "s-inactive", name: "Inactive", registrationNumber: "PK-005", email: "inactive@mail.com", status: 1 }),
      student({ id: "s-declined", name: "Declined", registrationNumber: "PK-006", email: "declined@mail.com", confirmationStatus: "REJECTED" }),
      student({ id: "s-noemail", name: "No Email", registrationNumber: "PK-007", email: "  " }),
      student({ id: "s-other", name: "Other", registrationNumber: "OT-001", email: "other@mail.com", teacherId: T2, teacher: { name: "Other Teacher" } }),
    ],
    class: [{ id: CLASS, teacherId: T1, status: 0, name: "Grade 6 Maths" }],
    grade: [{ id: 6 }],
    emailVerificationCode: [],
  });
}

// ---- Fakes for the edges ----------------------------------------------------

const sent = []; // { kind: "welcome" | "code", ...input }
const failing = { welcome: false, code: false };
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
  sendPasswordResetEmail: async () => {},
  sendEmail: async () => {},
  sendStudentRegistrationEmail: async (input) => {
    if (failing.welcome) throw new Error("SMTP 550 welcome rejected");
    sent.push({ kind: "welcome", ...input });
  },
  sendEmailVerificationCodeEmail: async (input) => {
    if (failing.code) throw new Error("SMTP 421 try later");
    sent.push({ kind: "code", ...input });
  },
});

const { resendStudentRegistrationEmails, RESEND_COOLDOWN_SECONDS } = require(path.join(
  root,
  "services",
  "student-registration-email-resend-service.ts"
));
const route = require(path.join(root, "app", "api", "students", "[id]", "resend-registration-emails", "route.ts"));
const { createStudent, RegisterStudentViaPublicClasses } = require(path.join(root, "services", "student-service.ts"));
const { verifyEmailConfirmationCode } = require(path.join(root, "lib", "email-verification.ts"));
const { resendEmailConfirmationCode } = require(path.join(root, "services", "auth-service.ts"));

const logs = [];
const originalLog = console.log;
const originalError = console.error;

function setup() {
  resetDb();
  sent.length = 0;
  logs.length = 0;
  failing.welcome = false;
  failing.code = false;
  login = { role: "TEACHER", id: T1 };
  console.log = (...args) => logs.push(args.join(" "));
  console.error = () => {};
}

test.afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const appError = (code, status) => (error) => error.code === code && error.statusCode === status;

function expireCooldown() {
  const past = new Date(Date.now() - (RESEND_COOLDOWN_SECONDS + 5) * 1000);
  for (const row of db.emailVerificationCode) row.createdAt = past;
}

async function callRoute(studentId) {
  const request = new Request(`http://localhost/api/students/${studentId}/resend-registration-emails`, { method: "POST" });
  const response = await route.POST(request, { params: { id: studentId } });
  return { status: response.status, body: await response.json() };
}

// ---- Eligibility --------------------------------------------------------------

test("an unverified student gets both original registration emails", async () => {
  setup();
  const result = await resendStudentRegistrationEmails(T1, "s-unverified");

  assert.deepEqual(result, {
    email: "nimal@mail.com",
    outcome: "SENT",
    registrationEmailSent: true,
    confirmationCodeSent: true,
  });
  assert.deepEqual(sent.map((s) => s.kind), ["welcome", "code"]);

  const [welcome, code] = sent;
  assert.deepEqual(welcome, {
    kind: "welcome",
    to: "nimal@mail.com",
    studentName: "Nimal Perera",
    registrationNumber: "PK-001",
    teacherName: "Pathum Kumara",
    className: "No classes assigned yet",
    registrationDate: REGISTERED_AT.toLocaleDateString(),
  });
  assert.equal(code.to, "nimal@mail.com");
  assert.match(code.code, /^\d{6}$/);

  // The code is a real, stored confirmation code for this student.
  assert.equal(db.emailVerificationCode.length, 1);
  assert.equal(db.emailVerificationCode[0].role, "STUDENT");
  assert.equal(db.emailVerificationCode[0].userId, "s-unverified");
  // Resending never marks the email verified.
  assert.equal(db.student.find((s) => s.id === "s-unverified").emailConfirmed, false);
});

test("a public-class student's welcome email names their registration class", async () => {
  setup();
  await resendStudentRegistrationEmails(T1, "s-public");
  assert.equal(sent[0].className, "Grade 6 Maths");
});

test("an inactive (not deleted) unverified student is still eligible", async () => {
  setup();
  const result = await resendStudentRegistrationEmails(T1, "s-inactive");
  assert.equal(result.outcome, "SENT");
});

test("a verified student is refused and nothing is sent", async () => {
  setup();
  await assert.rejects(resendStudentRegistrationEmails(T1, "s-verified"), appError("EMAIL_ALREADY_VERIFIED", 409));
  assert.equal(sent.length, 0);
  assert.equal(db.emailVerificationCode.length, 0);
});

test("a deleted student is refused (not found) and nothing is sent", async () => {
  setup();
  await assert.rejects(resendStudentRegistrationEmails(T1, "s-deleted"), appError("STUDENT_NOT_FOUND", 404));
  assert.equal(sent.length, 0);
});

test("a declined student and a student without an email are refused", async () => {
  setup();
  await assert.rejects(resendStudentRegistrationEmails(T1, "s-declined"), appError("STUDENT_REGISTRATION_DECLINED", 409));
  await assert.rejects(resendStudentRegistrationEmails(T1, "s-noemail"), appError("STUDENT_EMAIL_MISSING", 400));
  assert.equal(sent.length, 0);
});

// ---- Authorization ------------------------------------------------------------

test("route: no session is 401 and nothing is sent", async () => {
  setup();
  login = null;
  const { status, body } = await callRoute("s-unverified");
  assert.equal(status, 401);
  assert.equal(body.success, false);
  assert.equal(sent.length, 0);
});

test("route: a student session is 401 and nothing is sent", async () => {
  setup();
  login = { role: "STUDENT", id: "s-unverified" };
  const { status } = await callRoute("s-unverified");
  assert.equal(status, 401);
  assert.equal(sent.length, 0);
});

test("route: another teacher's student is 404 and nothing is sent", async () => {
  setup();
  login = { role: "TEACHER", id: T2 };
  const { status, body } = await callRoute("s-unverified");
  assert.equal(status, 404);
  assert.equal(body.error.code, "STUDENT_NOT_FOUND");
  assert.equal(sent.length, 0);
});

test("route: success returns the outcome and a message naming the email", async () => {
  setup();
  const { status, body } = await callRoute("s-unverified");
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.outcome, "SENT");
  assert.match(body.message, /Both registration emails were resent to nimal@mail\.com/);
});

test("route: a verified student is rejected on the server (409)", async () => {
  setup();
  const { status, body } = await callRoute("s-verified");
  assert.equal(status, 409);
  assert.equal(body.error.code, "EMAIL_ALREADY_VERIFIED");
});

// ---- Delivery failures --------------------------------------------------------

test("welcome email fails: the code is still sent, outcome PARTIAL", async () => {
  setup();
  failing.welcome = true;
  const result = await resendStudentRegistrationEmails(T1, "s-unverified");
  assert.equal(result.outcome, "PARTIAL");
  assert.equal(result.registrationEmailSent, false);
  assert.equal(result.confirmationCodeSent, true);
  assert.deepEqual(sent.map((s) => s.kind), ["code"]);
  assert.ok(logs.some((l) => l.includes("outcome=PARTIAL") && l.includes("registrationEmailError")));
});

test("confirmation code email fails: the welcome is still sent, outcome PARTIAL", async () => {
  setup();
  failing.code = true;
  const result = await resendStudentRegistrationEmails(T1, "s-unverified");
  assert.equal(result.outcome, "PARTIAL");
  assert.equal(result.registrationEmailSent, true);
  assert.equal(result.confirmationCodeSent, false);

  const { body } = await (async () => {
    expireCooldown();
    return callRoute("s-unverified");
  })();
  assert.equal(body.data.outcome, "PARTIAL");
  assert.match(body.message, /confirmation code email could not be sent/);
});

test("both emails fail: 502 with a clear message, attempt logged", async () => {
  setup();
  failing.welcome = true;
  failing.code = true;
  const { status, body } = await callRoute("s-unverified");
  assert.equal(status, 502);
  assert.equal(body.error.code, "REGISTRATION_EMAILS_FAILED");
  assert.ok(logs.some((l) => l.includes("[REGISTRATION_EMAIL_RESEND]") && l.includes("outcome=FAILED")));
  // The log never contains the student's address.
  assert.ok(!logs.some((l) => l.includes("[REGISTRATION_EMAIL_RESEND]") && l.includes("nimal@mail.com")));
});

// ---- Repeated requests --------------------------------------------------------

test("a concurrent duplicate request is refused while the first is running", async () => {
  setup();
  const results = await Promise.allSettled([
    resendStudentRegistrationEmails(T1, "s-unverified"),
    resendStudentRegistrationEmails(T1, "s-unverified"),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "RESEND_IN_PROGRESS");
  assert.equal(results[1].reason.statusCode, 409);
  assert.deepEqual(sent.map((s) => s.kind), ["welcome", "code"]);
});

test("a repeat within the cooldown is refused (429) before any email is sent", async () => {
  setup();
  await resendStudentRegistrationEmails(T1, "s-unverified");
  sent.length = 0;

  await assert.rejects(resendStudentRegistrationEmails(T1, "s-unverified"), appError("RESEND_THROTTLED", 429));
  assert.equal(sent.length, 0, "no duplicate welcome email");

  expireCooldown();
  const again = await resendStudentRegistrationEmails(T1, "s-unverified");
  assert.equal(again.outcome, "SENT");
  // The earlier code is invalidated; only the newest is usable.
  assert.equal(db.emailVerificationCode.filter((c) => !c.usedAt).length, 1);
});

test("the in-flight guard is released after a refused request", async () => {
  setup();
  await assert.rejects(resendStudentRegistrationEmails(T1, "s-verified"));
  db.student.find((s) => s.id === "s-verified").emailConfirmed = false;
  const result = await resendStudentRegistrationEmails(T1, "s-verified");
  assert.equal(result.outcome, "SENT");
});

// ---- Original registration emails are unchanged -------------------------------

test("teacher-added registration still sends the welcome email and a code", async () => {
  setup();
  const created = await createStudent(T1, {
    registrationNumber: "PK-050",
    name: "New Student",
    gradeId: 6,
    contact01: "0771234567",
    email: "new.student@mail.com",
  });

  assert.deepEqual(sent.map((s) => s.kind), ["welcome", "code"]);
  assert.equal(sent[0].to, "new.student@mail.com");
  assert.equal(sent[0].studentName, "New Student");
  assert.equal(sent[0].teacherName, "Pathum Kumara");
  assert.equal(sent[0].className, "No classes assigned yet");
  assert.equal(sent[1].to, "new.student@mail.com");
  assert.equal(db.emailVerificationCode.at(-1).userId, created.id);
});

test("public-class registration still sends the welcome email and a code", async () => {
  setup();
  const { student } = await RegisterStudentViaPublicClasses({
    classId: CLASS,
    studentName: "Public Student",
    email: "Public.Student@mail.com",
    mobileNumber: "0771234567",
    parentMobileNumber: "0777654321",
    gradeId: 6,
  });

  assert.deepEqual(sent.map((s) => s.kind), ["welcome", "code"]);
  assert.equal(sent[0].studentName, "Public Student");
  assert.equal(sent[0].className, "Grade 6 Maths");
  assert.equal(sent[1].to, "public.student@mail.com");
  assert.equal(db.emailVerificationCode.at(-1).userId, student.id);
});

test("the resend reuses the existing senders and creates no email template", () => {
  const source = fs.readFileSync(path.join(root, "services", "student-registration-email-resend-service.ts"), "utf8");
  assert.match(source, /import \{ sendStudentRegistrationEmail \} from "@\/lib\/mailer"/);
  assert.match(source, /import \{ sendEmailConfirmationCode \} from "@\/services\/auth-service"/);
  assert.doesNotMatch(source, /@\/emails\//);
  assert.doesNotMatch(source, /sendEmail\(/);
});

// ---- The resent code works with the existing verification rules ---------------

const verify = (userId, code) => verifyEmailConfirmationCode({ role: "STUDENT", userId, code });
const codesSentTo = (to) => sent.filter((s) => s.kind === "code" && s.to === to).map((s) => s.code);

test("the resent code verifies the email; the registration-time code no longer does", async () => {
  setup();
  // A code from registration, as createStudent would have stored it.
  await createStudent(T1, { registrationNumber: "PK-060", name: "Late Student", gradeId: 6, contact01: "0771234567", email: "late@mail.com" });
  const id = db.student.find((s) => s.email === "late@mail.com").id;
  const [oldCode] = codesSentTo("late@mail.com");

  expireCooldown();
  await resendStudentRegistrationEmails(T1, id);
  const [, newCode] = codesSentTo("late@mail.com");
  assert.notEqual(oldCode, newCode);

  if (oldCode !== newCode) {
    await assert.rejects(verify(id, oldCode), appError("INVALID_VERIFICATION_CODE", 400));
  }
  await verify(id, newCode);
  assert.equal(db.student.find((s) => s.id === id).emailConfirmed, true);

  // Once verified, the server refuses any further resend.
  expireCooldown();
  await assert.rejects(resendStudentRegistrationEmails(T1, id), appError("EMAIL_ALREADY_VERIFIED", 409));
});

test("the resent code keeps the existing 30-minute expiry and 5-attempt limit", async () => {
  setup();
  await resendStudentRegistrationEmails(T1, "s-unverified");
  const [row] = db.emailVerificationCode;
  const ttlMinutes = (row.expiresAt - row.createdAt) / 60000;
  assert.ok(Math.abs(ttlMinutes - 30) < 0.1, `ttl ${ttlMinutes}`);

  const [code] = codesSentTo("nimal@mail.com");
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(verify("s-unverified", wrong), appError("INVALID_VERIFICATION_CODE", 400));
  }
  // After 5 wrong tries even the right code is locked out, as before.
  await assert.rejects(verify("s-unverified", code), appError("VERIFICATION_CODE_LOCKED", 429));

  // An expired code is refused by the existing rule.
  setup();
  await resendStudentRegistrationEmails(T1, "s-unverified");
  db.emailVerificationCode[0].expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(verify("s-unverified", codesSentTo("nimal@mail.com")[0]), appError("INVALID_VERIFICATION_CODE", 400));
});

// ---- Retrying after a partial failure -----------------------------------------

test("code email failed: retry is held for the cooldown, then sends a fresh working code", async () => {
  setup();
  failing.code = true;
  assert.equal((await resendStudentRegistrationEmails(T1, "s-unverified")).outcome, "PARTIAL");
  failing.code = false;

  await assert.rejects(resendStudentRegistrationEmails(T1, "s-unverified"), appError("RESEND_THROTTLED", 429));
  assert.equal(sent.filter((s) => s.kind === "welcome").length, 1, "no extra welcome during the cooldown");

  expireCooldown();
  assert.equal((await resendStudentRegistrationEmails(T1, "s-unverified")).outcome, "SENT");
  assert.equal(db.emailVerificationCode.filter((c) => !c.usedAt).length, 1, "one live code");
  await verify("s-unverified", codesSentTo("nimal@mail.com")[0]);
});

test("welcome failed: the delivered code works; a later retry's code replaces it", async () => {
  setup();
  failing.welcome = true;
  await resendStudentRegistrationEmails(T1, "s-unverified");
  failing.welcome = false;
  const [first] = codesSentTo("nimal@mail.com");

  expireCooldown();
  await resendStudentRegistrationEmails(T1, "s-unverified");
  const [, second] = codesSentTo("nimal@mail.com");

  if (first !== second) {
    await assert.rejects(verify("s-unverified", first));
  }
  await verify("s-unverified", second);
});

// ---- The cooldown and the existing code flows ---------------------------------

test("the cooldown only reads codes: it never blocks registration and matches the existing throttle", async () => {
  setup();
  // A resend for one student does not affect registering another.
  await resendStudentRegistrationEmails(T1, "s-unverified");
  sent.length = 0;
  await createStudent(T1, { registrationNumber: "PK-070", name: "Brand New", gradeId: 6, contact01: "0771234567", email: "brand.new@mail.com" });
  assert.deepEqual(sent.map((s) => s.kind), ["welcome", "code"]);

  // The student's own "resend code" is throttled by the existing rule exactly as
  // after registration, and works again once the window has passed.
  await assert.rejects(resendEmailConfirmationCode("PK-001"), appError("VERIFICATION_CODE_THROTTLED", 429));
  expireCooldown();
  await resendEmailConfirmationCode("PK-001");

  // A student who just requested their own code makes the teacher's resend wait
  // (rather than resend the welcome and then fail on the code).
  sent.length = 0;
  await assert.rejects(resendStudentRegistrationEmails(T1, "s-unverified"), appError("RESEND_THROTTLED", 429));
  assert.equal(sent.length, 0);
});
