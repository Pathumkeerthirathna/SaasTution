/*
 * Student email reuse after a student is deleted (status 2).
 *
 *   npm run test:students
 *
 * Runs the real code through tsx: lib/email-uniqueness.ts (assertEmailAvailable),
 * services/student-service.ts (createStudent, updateStudentForTeacher,
 * RegisterStudentViaPublicClasses), POST app/api/students/import/route.ts and
 * services/auth-service.ts (requestPasswordReset, confirmPasswordReset,
 * loginStudent, loginByLoginId): deleted students can neither reset their
 * password nor log in. Only the edges are faked:
 * Prisma (tests/students/helpers/fake-prisma.cjs), the teacher session and the
 * mailer. No database or SMTP server is contacted.
 *
 * Add / edit / public registration do much more after the email check (hashing,
 * creating, emailing). Those tests stop at a database call that follows the
 * email check (`state.stopOn`): reaching it means the email was accepted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

const T1 = "teacher-pathum";
const T2 = "teacher-other";
const CLASS = "class-1";

// ---- Fake database --------------------------------------------------------

const { createFakePrisma, STOP } = require("./helpers/fake-prisma.cjs");
const { db, prisma: fakePrisma, state, reset } = createFakePrisma();

function resetDb() {
  reset({
    teacher: [
      { id: T1, name: "Pathum Kumara", email: "pathum@mail.com" },
      { id: T2, name: "Other Teacher", email: "other.teacher@mail.com" },
    ],
    guardian: [{ id: "g-1", email: "guardian@mail.com" }],
    student: [
      { id: "s-a", teacherId: T1, name: "Student A", gradeId: 6, registrationNumber: "PK-2026-1", email: "abc@mail.com", status: 0 },
      { id: "s-b", teacherId: T1, name: "Student B", gradeId: 6, registrationNumber: "PK-2026-2", email: "def@gmail.com", status: 2 },
      { id: "s-c", teacherId: T1, name: "Student C", gradeId: 6, registrationNumber: "PK-2026-3", email: "inactive@mail.com", status: 1 },
      { id: "s-d", teacherId: T2, name: "Student D", gradeId: 6, registrationNumber: "OT-2026-1", email: "shared@mail.com", status: 0 },
    ],
    class: [{ id: CLASS, teacherId: T1, status: 0, name: "Grade 6 Maths" }],
    grade: [{ id: 6 }],
    passwordResetToken: [],
  });
}

// ---- Fakes for the edges ----------------------------------------------------

const resetEmails = [];

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => ({ teacherId: T1, name: "Pathum Kumara", email: "pathum@mail.com", role: "TEACHER" }),
});
const resetTokens = [];

fake("lib/mailer.ts", {
  buildPasswordResetLink: (token) => {
    resetTokens.push(token);
    return `https://slclassroom.live/reset-password/confirm?token=${token}`;
  },
  sendPasswordResetEmail: async (input) => resetEmails.push(input),
  sendEmailVerificationCodeEmail: async () => {},
  sendEmail: async () => {},
  sendStudentRegistrationEmail: async () => {},
});

const { assertEmailAvailable } = require(path.join(root, "lib", "email-uniqueness.ts"));
const { createStudent, updateStudentForTeacher, RegisterStudentViaPublicClasses } = require(path.join(root, "services", "student-service.ts"));
const { requestPasswordReset, confirmPasswordReset, loginStudent, loginByLoginId } = require(path.join(root, "services", "auth-service.ts"));
const importRoute = require(path.join(root, "app", "api", "students", "import", "route.ts"));

const bcrypt = require("bcryptjs");
const PASSWORD = "secret-pass";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

function setup() {
  resetDb();
  resetEmails.length = 0;
  resetTokens.length = 0;
  // Login-ready fixtures: every student has the same password, a confirmed
  // email and an approved registration.
  for (const s of db.student) Object.assign(s, { password: PASSWORD_HASH, emailConfirmed: true, confirmationStatus: "APPROVED" });
}

const conflict = (pattern) => (error) => error.statusCode === 409 && pattern.test(error.message);
const past = (error) => error.message === STOP;

async function quiet(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

// ---- Add student (assertEmailAvailable via createStudent) -------------------

// registrationNumber is required by createStudentSchema, as the add form sends it.
const newStudent = (email) => ({ registrationNumber: "PK-2026-9", name: "New Student", gradeId: 6, contact01: "0771234567", email });

test("add: a deleted student's email can be reused by the same teacher", async () => {
  setup();
  await assert.doesNotReject(assertEmailAvailable("def@gmail.com", { type: "STUDENT", teacherId: T1 }));
  state.stopOn = "student.create"; // the save, after every check
  await assert.rejects(createStudent(T1, newStudent("DEF@gmail.com")), past);
});

test("add: an active student's email is still rejected", async () => {
  setup();
  state.stopOn = "student.create";
  await assert.rejects(createStudent(T1, newStudent("abc@mail.com")), conflict(/Another student already uses this email/));
});

test("add: an inactive student's email is still rejected", async () => {
  setup();
  state.stopOn = "student.create";
  await assert.rejects(createStudent(T1, newStudent("inactive@mail.com")), conflict(/Another student already uses this email/));
});

// ---- Edit student -----------------------------------------------------------

const edit = (email) => ({ name: "Student A", gradeId: 6, registrationNumber: "PK-2026-1", contact01: "0771234567", email });

test("edit: changing to a deleted student's email is accepted; an active one is rejected; keeping one's own is accepted", async () => {
  setup();
  state.stopOn = "student.update";
  await quiet(async () => {
    await assert.rejects(updateStudentForTeacher(T1, "s-a", edit("def@gmail.com")), past);
    await assert.rejects(updateStudentForTeacher(T1, "s-a", edit("inactive@mail.com")), conflict(/Another student already uses this email/));
    await assert.rejects(updateStudentForTeacher(T1, "s-a", edit("abc@mail.com")), past);
  });
});

// ---- Unchanged rules ----------------------------------------------------------

test("cross-teacher rule unchanged: another teacher's student may share an email", async () => {
  setup();
  await assert.doesNotReject(assertEmailAvailable("shared@mail.com", { type: "STUDENT", teacherId: T1 }));
  await assert.rejects(assertEmailAvailable("shared@mail.com", { type: "STUDENT", teacherId: T2 }), conflict(/Another student/));
});

test("teacher and guardian rules unchanged", async () => {
  setup();
  // A student may not use a teacher's or a guardian's email.
  await assert.rejects(assertEmailAvailable("other.teacher@mail.com", { type: "STUDENT", teacherId: T1 }), conflict(/teacher account/));
  await assert.rejects(assertEmailAvailable("guardian@mail.com", { type: "STUDENT", teacherId: T1 }), conflict(/another account/));
  // Teacher / guardian emails stay globally unique against every student, deleted ones included.
  await assert.rejects(assertEmailAvailable("abc@mail.com", { type: "TEACHER" }), conflict(/another account/));
  await assert.rejects(assertEmailAvailable("def@gmail.com", { type: "TEACHER" }), conflict(/another account/));
  await assert.rejects(assertEmailAvailable("def@gmail.com", { type: "GUARDIAN" }), conflict(/another account/));
  await assert.rejects(assertEmailAvailable("pathum@mail.com", { type: "TEACHER" }), conflict(/teacher account already exists/));
  await assert.doesNotReject(assertEmailAvailable("free@mail.com", { type: "GUARDIAN" }));
});

// ---- Public registration ---------------------------------------------------

const publicRequest = (email) => ({
  classId: CLASS,
  studentName: "Public Student",
  mobileNumber: "0771234567",
  parentMobileNumber: "0777654321",
  gradeId: 6,
  email,
});

test("public registration: a deleted student's email is accepted; active / inactive ones are rejected", async () => {
  setup();
  state.stopOn = "teacher.findUnique"; // the first call after the email checks
  await assert.rejects(RegisterStudentViaPublicClasses(publicRequest("def@gmail.com")), past);
  await assert.rejects(
    RegisterStudentViaPublicClasses(publicRequest("abc@mail.com")),
    conflict(/already registered with this email/)
  );
  await assert.rejects(
    RegisterStudentViaPublicClasses(publicRequest("inactive@mail.com")),
    conflict(/already registered with this email/)
  );
});

// ---- CSV import -------------------------------------------------------------

async function runImport(rows) {
  const request = new Request("http://localhost/api/students/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registrationSource: "TEACHER", students: rows }),
  });
  const response = await importRoute.POST(request);
  return { status: response.status, body: await response.json() };
}

const row = (studentName, email) => ({ studentName, gradeId: 6, primaryContact: "0771234567", email });

test("CSV import: a deleted student's email is imported", async () => {
  setup();
  const { status, body } = await runImport([row("Imported One", "def@gmail.com")]);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(db.student.filter((s) => s.email === "def@gmail.com" && s.status === 0).length, 1);
});

test("CSV import: active / inactive emails and in-file duplicates are still rejected", async () => {
  setup();
  const { status, body } = await runImport([
    row("Imported One", "abc@mail.com"),
    row("Imported Two", "inactive@mail.com"),
    row("Imported Three", "dup@mail.com"),
    row("Imported Four", "DUP@mail.com"),
    row("Imported Five", "def@gmail.com"),
  ]);
  assert.equal(status, 400);
  const emailErrors = body.errors.filter((e) => e.field === "email");
  assert.deepEqual(
    emailErrors.map((e) => e.row).sort(),
    [2, 3, 5],
    JSON.stringify(emailErrors)
  );
  assert.match(emailErrors.find((e) => e.row === 2).message, /Another student already uses this email/);
  assert.match(emailErrors.find((e) => e.row === 3).message, /Another student already uses this email/);
  assert.match(emailErrors.find((e) => e.row === 5).message, /Duplicate email in uploaded file/);
  assert.equal(db.student.length, 4, "nothing was created");
});

// ---- Password reset ---------------------------------------------------------

test("password reset by email resolves the current student, not the deleted record", async () => {
  setup();
  // The new student reusing Student B's email; the deleted row comes first.
  db.student.push({ id: "s-new", teacherId: T1, name: "New B", gradeId: 6, registrationNumber: "PK-2026-5", email: "def@gmail.com", status: 0 });

  await requestPasswordReset("DEF@gmail.com");
  assert.equal(db.passwordResetToken.length, 1);
  assert.equal(db.passwordResetToken[0].userId, "s-new");
  assert.equal(resetEmails.length, 1);
  assert.equal(resetEmails[0].to, "def@gmail.com");
});

test("password reset by email: an email held only by a deleted student sends nothing", async () => {
  setup();
  await requestPasswordReset("def@gmail.com");
  assert.equal(db.passwordResetToken.length, 0);
  assert.equal(resetEmails.length, 0);
});

test("password reset: active students can still reset by email and by registration number", async () => {
  setup();
  await requestPasswordReset("abc@mail.com");
  await requestPasswordReset("pk-2026-1");
  assert.deepEqual(db.passwordResetToken.map((t) => t.userId), ["s-a", "s-a"]);
  assert.equal(resetEmails.length, 2);
});

test("password reset: a deleted student cannot reset by registration number (no token, no email, same quiet success)", async () => {
  setup();
  await assert.doesNotReject(requestPasswordReset("PK-2026-2"));
  assert.equal(db.passwordResetToken.length, 0);
  assert.equal(resetEmails.length, 0);
});

test("password reset: an inactive student's reset request is unchanged (still sent)", async () => {
  setup();
  await requestPasswordReset("PK-2026-3");
  assert.equal(db.passwordResetToken.at(-1).userId, "s-c");
});

test("password reset: a link issued before the student was deleted no longer works", async () => {
  setup();
  await requestPasswordReset("PK-2026-1");
  const token = resetTokens.at(-1);
  db.student.find((s) => s.id === "s-a").status = 2;

  // The token itself is valid: the refusal comes from the deleted-student check.
  const original = fakePrisma.student.updateMany;
  let studentUpdateTried = false;
  fakePrisma.student.updateMany = async (args) => {
    studentUpdateTried = true;
    return original(args);
  };
  try {
    await assert.rejects(confirmPasswordReset(token, "new-password-1"), (e) => e.code === "INVALID_RESET_TOKEN");
  } finally {
    fakePrisma.student.updateMany = original;
  }
  assert.equal(studentUpdateTried, true, "reached the student update");
  assert.equal(db.student.find((s) => s.id === "s-a").password, PASSWORD_HASH, "password unchanged");
  assert.equal(db.passwordResetToken[0].usedAt, undefined, "token not consumed");
});

test("password reset: an active student's link still sets the new password", async () => {
  setup();
  await requestPasswordReset("abc@mail.com");
  await confirmPasswordReset(resetTokens.at(-1), "new-password-1");
  assert.ok(bcrypt.compareSync("new-password-1", db.student.find((s) => s.id === "s-a").password));
  assert.ok(db.passwordResetToken[0].usedAt instanceof Date);
});

// ---- Student login ------------------------------------------------------------

const invalidCredentials = (e) => e.statusCode === 401 && e.code === "INVALID_CREDENTIALS";

test("login: a deleted student is rejected like an unknown account, even with the right password", async () => {
  setup();
  await assert.rejects(loginStudent("PK-2026-2", PASSWORD), invalidCredentials);
  await assert.rejects(loginByLoginId("PK-2026-2", PASSWORD), invalidCredentials);
  // Same error as an unknown registration number: deletion is not revealed.
  const unknown = await loginStudent("PK-2026-99", PASSWORD).catch((e) => e);
  const deleted = await loginStudent("PK-2026-2", PASSWORD).catch((e) => e);
  assert.equal(deleted.message, unknown.message);
});

test("login: an active student logs in as before", async () => {
  setup();
  const student = await loginStudent("pk-2026-1", PASSWORD);
  assert.equal(student.id, "s-a");
  assert.equal(student.status, 0);
  const result = await loginByLoginId("PK-2026-1", PASSWORD);
  assert.equal(result.role, "STUDENT");
  assert.equal(result.studentStatus.isActive, true);
  await assert.rejects(loginStudent("PK-2026-1", "wrong"), invalidCredentials);
});

test("login: an inactive student keeps the existing deactivated restriction", async () => {
  setup();
  db.student.find((s) => s.id === "s-c").deactivationReason = "Fees unpaid";
  await assert.rejects(
    loginStudent("PK-2026-3", PASSWORD),
    (e) => e.statusCode === 403 && e.code === "STUDENT_DEACTIVATED" && /Fees unpaid/.test(e.message)
  );
});
