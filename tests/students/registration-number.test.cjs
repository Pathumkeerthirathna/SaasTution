/*
 * Student registration numbers: global uniqueness among non-deleted students,
 * reuse of deleted students' numbers, the shared lowest-available generator,
 * normalisation, and the database-conflict handling of every write path.
 *
 *   npm run test:students
 *
 * Runs the real code through tsx: services/student-service.ts (generator,
 * isRegistrationNumberTaken, createStudent, updateStudentForTeacher,
 * RegisterStudentViaPublicClasses, checkIfRegNoExists), the routes
 * GET /api/student/next-registration-number,
 * GET /api/students/check-registration-number and POST /api/students/import,
 * and services/auth-service.ts (findStudentByRegistrationNumber, loginStudent).
 * Only the edges are faked: Prisma (tests/students/helpers/fake-prisma.cjs, which
 * also enforces the partial unique index like PostgreSQL), the teacher session,
 * the mailer and the monthly-fee helper. No database or SMTP server is contacted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const bcrypt = require("bcryptjs");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const Y = new Date().getFullYear();

// Teachers: "Pathum" and "Patricia" share the PAT prefix; "Pathum Kumara" is PK.
const PATHUM = "t-pathum";
const PATRICIA = "t-patricia";
const PK = "t-pathum-kumara";
const CLASS = "class-1";

const { createFakePrisma } = require("./helpers/fake-prisma.cjs");
const { db, prisma: fakePrisma, state, reset } = createFakePrisma();

let sessionTeacher = PATHUM;

const PASSWORD = "secret-pass";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

let seq = 0;
function student(teacherId, registrationNumber, status = 0, extra = {}) {
  seq += 1;
  return {
    id: `s-${seq}`,
    teacherId,
    name: `Student ${seq}`,
    gradeId: 6,
    registrationNumber,
    email: `student${seq}@mail.com`,
    status,
    password: PASSWORD_HASH,
    emailConfirmed: true,
    confirmationStatus: "APPROVED",
    ...extra,
  };
}

function setup(students = []) {
  sessionTeacher = PATHUM;
  reset({
    teacher: [
      { id: PATHUM, name: "Pathum", email: "pathum@mail.com" },
      { id: PATRICIA, name: "Patricia", email: "patricia@mail.com" },
      { id: PK, name: "Pathum Kumara", email: "pk@mail.com" },
    ],
    guardian: [],
    class: [{ id: CLASS, teacherId: PATHUM, status: 0, name: "Grade 6 Maths" }],
    grade: [{ id: 6 }],
    student: students,
  });
}

const pat = (n) => `PAT-${Y}-${String(n).padStart(3, "0")}`;

// ---- Fakes for the edges ----------------------------------------------------

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
  requireTeacherSession: async () => {
    const teacher = db.teacher.find((t) => t.id === sessionTeacher);
    return { teacherId: teacher.id, name: teacher.name, email: teacher.email, role: "TEACHER" };
  },
});
fake("lib/mailer.ts", {
  buildPasswordResetLink: () => "",
  sendPasswordResetEmail: async () => {},
  sendEmailVerificationCodeEmail: async () => {},
  sendEmail: async () => {},
  sendStudentRegistrationEmail: async () => {},
});
fake("services/class-student-fee-service.ts", { ensureCurrentMonthFeeForClassStudent: async () => {} });

const service = require(path.join(root, "services", "student-service.ts"));
const auth = require(path.join(root, "services", "auth-service.ts"));
const nextNumberRoute = require(path.join(root, "app", "api", "student", "next-registration-number", "route.ts"));
const checkRoute = require(path.join(root, "app", "api", "students", "check-registration-number", "route.ts"));
const importRoute = require(path.join(root, "app", "api", "students", "import", "route.ts"));

async function quiet(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

const taken = (e) => e.statusCode === 409 && e.code === "DUPLICATE_REGISTRATION_NUMBER";

/** Simulates another registration saving `number` between our check and our write. */
function concurrentlyTake(number, { table = "student", method, times = 1 } = {}) {
  let left = times;
  state.beforeWrite = (t, m) => {
    if (t === table && (!method || m === method) && left > 0) {
      left -= 1;
      db.student.push(student(PATRICIA, number));
    }
  };
}

// ---- Generator ----------------------------------------------------------------

test("generator: prefix from buildShortCode (one word: first letters; several: initials), sequence from 001", async () => {
  setup();
  assert.equal(await service.generateStudentRegistrationNumber("Pathum"), pat(1));
  assert.equal(await service.generateStudentRegistrationNumber("Pathum Kumara"), `PK-${Y}-001`);
});

test("generator: lowest free number; deleted students' numbers are free", async () => {
  setup([student(PATHUM, pat(1)), student(PATHUM, pat(2), 2), student(PATHUM, pat(3)), student(PATHUM, pat(4), 2)]);
  assert.equal(await service.generateStudentRegistrationNumber("Pathum"), pat(2));
});

test("generator: a number held by ANY teacher's active or inactive student is never generated", async () => {
  setup([student(PATHUM, pat(1)), student(PATRICIA, pat(2)), student(PATRICIA, pat(3), 1), student(PATHUM, pat(4), 2)]);
  assert.equal(await service.generateStudentRegistrationNumber("Pathum"), pat(4));
  assert.equal(await service.generateStudentRegistrationNumber("Patricia"), pat(4), "same rule for every teacher with the prefix");
});

test("generator: other years, other prefixes and NULL numbers are ignored; legacy lower case still counts", async () => {
  setup([
    student(PATHUM, `PAT-${Y - 1}-001`),
    student(PK, `PK-${Y}-001`),
    student(PATHUM, null),
    student(PATHUM, `pat-${Y}-001`),
  ]);
  assert.equal(await service.generateStudentRegistrationNumber("Pathum"), pat(2));
});

test("generator: grows past 999 and can hand out several numbers skipping reserved ones", async () => {
  setup(Array.from({ length: 999 }, (_, i) => student(PATHUM, pat(i + 1))));
  assert.equal(await service.generateStudentRegistrationNumber("Pathum"), `PAT-${Y}-1000`);

  setup([student(PATHUM, pat(1)), student(PATHUM, pat(3), 2)]);
  assert.deepEqual(await service.generateAvailableRegistrationNumbers("Pathum", 3, [pat(2), " pat-" + Y + "-004 "]), [pat(3), pat(5), pat(6)]);
});

test("next-registration-number route returns the generated number", async () => {
  setup([student(PATHUM, pat(1)), student(PATHUM, pat(2), 2)]);
  const response = await nextNumberRoute.GET();
  assert.deepEqual(await response.json(), { registrationNumber: pat(2) });
});

// ---- Availability / live check --------------------------------------------------

test("availability: global across teachers, active and inactive taken, deleted free, case-insensitive", async () => {
  setup([student(PATRICIA, pat(1)), student(PATRICIA, pat(2), 1), student(PATRICIA, pat(3), 2)]);
  assert.equal(await service.isRegistrationNumberTaken(pat(1)), true, "another teacher's active student");
  assert.equal(await service.isRegistrationNumberTaken(pat(2)), true, "another teacher's inactive student");
  assert.equal(await service.isRegistrationNumberTaken(pat(3)), false, "only a deleted student");
  assert.equal(await service.isRegistrationNumberTaken(` pat-${Y}-001 `), true, "trimmed and case-insensitive");
  assert.equal(await service.isRegistrationNumberTaken(pat(9)), false);
});

test("check-registration-number route: the form's live check uses the global rule and excludes the edited student", async () => {
  setup([student(PATRICIA, pat(1)), student(PATHUM, pat(2), 2)]);
  const holder = db.student[0].id;
  const check = async (number, studentId = "") => {
    const url = `http://localhost/api/students/check-registration-number?registrationNumber=${encodeURIComponent(number)}&studentId=${studentId}`;
    return (await (await checkRoute.GET(new Request(url))).json()).exists;
  };
  assert.equal(await check(pat(1)), true, "another teacher's student: Already exists");
  assert.equal(await check(pat(2)), false, "deleted only: available");
  assert.equal(await check(pat(1), holder), false, "the student's own number while editing");
});

// ---- Add student ----------------------------------------------------------------

const addInput = (registrationNumber) => ({
  registrationNumber,
  name: `New ${registrationNumber}`,
  gradeId: 6,
  contact01: "0771234567",
  email: `new-${registrationNumber.trim().toLowerCase()}@mail.com`,
});

test("add: a deleted student's number is reused; history stays on the deleted student's id", async () => {
  setup([student(PATHUM, pat(1)), student(PATHUM, pat(2), 2)]);
  const deletedId = db.student[1].id;
  db.attendance = [{ id: "att-1", studentId: deletedId }];
  db.classPayment = [{ id: "pay-1", studentId: deletedId }];

  const created = await quiet(() => service.createStudent(PATHUM, addInput(pat(2))));
  assert.equal(created.registrationNumber, pat(2));
  assert.notEqual(created.id, deletedId);
  assert.equal(db.student.find((s) => s.id === deletedId).registrationNumber, pat(2), "the deleted row is untouched");
  assert.equal(db.student.find((s) => s.id === deletedId).status, 2);
  assert.deepEqual(db.attendance.map((a) => a.studentId), [deletedId]);
  assert.deepEqual(db.classPayment.map((p) => p.studentId), [deletedId]);
});

test("add: another teacher's active or inactive number is rejected (409)", async () => {
  setup([student(PATRICIA, pat(1)), student(PATRICIA, pat(2), 1)]);
  await assert.rejects(quiet(() => service.createStudent(PATHUM, addInput(pat(1)))), taken);
  await assert.rejects(quiet(() => service.createStudent(PATHUM, addInput(pat(2)))), taken);
  assert.equal(db.student.length, 2);
});

test("add: the number is stored trimmed and upper case; a case variant of a taken number is rejected", async () => {
  setup([student(PATRICIA, pat(1))]);
  const created = await quiet(() => service.createStudent(PATHUM, addInput(`  pat-${Y}-007 `)));
  assert.equal(created.registrationNumber, pat(7));
  await assert.rejects(quiet(() => service.createStudent(PATHUM, addInput(`pat-${Y}-001`))), taken);
});

test("add: a concurrent registration taking the number first gives 409, not a 500 or a retry with the same number", async () => {
  setup();
  concurrentlyTake(pat(1), { method: "create" });
  await assert.rejects(quiet(() => service.createStudent(PATHUM, addInput(pat(1)))), taken);
  assert.equal(db.student.filter((s) => s.registrationNumber === pat(1)).length, 1, "only the other registration's row");
});

// ---- Edit student ----------------------------------------------------------------

const editInput = (registrationNumber, name = "Edited") => ({
  registrationNumber,
  name,
  gradeId: 6,
  contact01: "0771234567",
  email: "edited@mail.com",
});

test("edit: another teacher's number is rejected; a deleted student's number and the student's own are accepted", async () => {
  setup([student(PATHUM, pat(1)), student(PATRICIA, pat(2)), student(PATRICIA, pat(3), 2)]);
  const id = db.student[0].id;
  await quiet(async () => {
    await assert.rejects(service.updateStudentForTeacher(PATHUM, id, editInput(pat(2))), taken);
    const own = await service.updateStudentForTeacher(PATHUM, id, editInput(` pat-${Y}-001 `));
    assert.equal(own.registrationNumber, pat(1));
    const reused = await service.updateStudentForTeacher(PATHUM, id, editInput(`pat-${Y}-003`));
    assert.equal(reused.registrationNumber, pat(3), "stored normalised");
  });
});

test("edit: a concurrent registration taking the number first gives 409", async () => {
  setup([student(PATHUM, pat(1))]);
  concurrentlyTake(pat(5), { method: "update" });
  await assert.rejects(quiet(() => service.updateStudentForTeacher(PATHUM, db.student[0].id, editInput(pat(5)))), taken);
  assert.equal(db.student[0].registrationNumber, pat(1), "unchanged");
});

// ---- Public registration ---------------------------------------------------------

const publicRequest = (email) => ({
  classId: CLASS,
  studentName: "Public Student",
  mobileNumber: "0771234567",
  parentMobileNumber: "0777654321",
  school: "",
  gradeId: 6,
  email,
});

test("public registration: gets the lowest free number (deleted reused, other teachers' skipped)", async () => {
  setup([student(PATHUM, pat(1)), student(PATHUM, pat(2), 2), student(PATRICIA, pat(3))]);
  const result = await quiet(() => service.RegisterStudentViaPublicClasses(publicRequest("public1@mail.com")));
  assert.equal(result.registrationNumber, pat(2));
  assert.equal(result.student.registrationNumber, pat(2));
});

test("public registration: a concurrent registration taking the number makes it retry with the next free one", async () => {
  setup([student(PATHUM, pat(1))]);
  concurrentlyTake(pat(2), { method: "create" });
  const result = await quiet(() => service.RegisterStudentViaPublicClasses(publicRequest("public2@mail.com")));
  assert.equal(result.registrationNumber, pat(3));
  assert.equal(db.student.filter((s) => s.registrationNumber === pat(2)).length, 1);
});

// ---- CSV import ----------------------------------------------------------------

async function runImport(rows) {
  const request = new Request("http://localhost/api/students/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registrationSource: "IMPORT", students: rows }),
  });
  const response = await importRoute.POST(request);
  return { status: response.status, body: await response.json() };
}

const row = (studentName, registrationNumber) => ({
  studentName,
  registrationNumber,
  gradeId: 6,
  primaryContact: "0771234567",
  email: `${studentName.replace(/\s+/g, ".").toLowerCase()}@mail.com`,
});

test("CSV import: generated numbers use the same buildShortCode prefix and lowest free numbers, skipping typed ones", async () => {
  setup([student(PATHUM, pat(1)), student(PATHUM, pat(2), 2), student(PATRICIA, pat(4))]);
  const { status, body } = await runImport([row("Row One"), row("Row Two", `pat-${Y}-003`), row("Row Three"), row("Row Four")]);
  assert.equal(status, 200, JSON.stringify(body));
  const imported = db.student.filter((s) => s.name.startsWith("Row "));
  assert.deepEqual(
    imported.map((s) => [s.name, s.registrationNumber]),
    [
      ["Row One", pat(2)],
      ["Row Two", pat(3)],
      ["Row Three", pat(5)],
      ["Row Four", pat(6)],
    ]
  );
});

test("CSV import: a deleted student's number is accepted; any teacher's active / inactive number and in-file duplicates are rejected", async () => {
  setup([student(PATHUM, pat(1), 2), student(PATRICIA, pat(2)), student(PATRICIA, pat(3), 1)]);
  const before = db.student.length;
  const { status, body } = await runImport([
    row("Row One", pat(1)),
    row("Row Two", pat(2)),
    row("Row Three", pat(3)),
    row("Row Four", pat(8)),
    row("Row Five", `pat-${Y}-008`),
  ]);
  assert.equal(status, 400);
  const regErrors = body.errors.filter((e) => e.field === "registrationNumber");
  assert.deepEqual(regErrors.map((e) => e.row).sort(), [3, 4, 6], JSON.stringify(regErrors));
  assert.match(regErrors.find((e) => e.row === 3).message, /already exists/);
  assert.match(regErrors.find((e) => e.row === 6).message, /Duplicate registration number in uploaded file/);
  assert.equal(db.student.length, before, "nothing was created");
});

test("CSV import: a concurrent registration taking a number gives 409 with a row error; nothing is imported", async () => {
  setup();
  concurrentlyTake(pat(1), { method: "createMany" });
  const { status, body } = await runImport([row("Row One"), row("Row Two")]);
  assert.equal(status, 409);
  assert.equal(body.success, false);
  assert.equal(body.errors[0].field, "registrationNumber");
  assert.equal(db.student.filter((s) => s.name.startsWith("Row ")).length, 0);
});

// ---- Login with a reused number ----------------------------------------------------

test("login: a reused number reaches the new student, never the deleted record", async () => {
  // The deleted row comes first, as an older row would.
  setup([student(PATHUM, pat(1), 2), student(PATHUM, pat(1))]);
  const [deleted, current] = db.student;
  assert.equal((await auth.findStudentByRegistrationNumber(pat(1))).id, current.id);
  assert.equal((await auth.loginStudent(`pat-${Y}-001`, PASSWORD)).id, current.id);
  assert.notEqual(current.id, deleted.id);
});

test("login: a number held only by a deleted student cannot log in", async () => {
  setup([student(PATHUM, pat(1), 2)]);
  await assert.rejects(auth.loginStudent(pat(1), PASSWORD), (e) => e.statusCode === 401 && e.code === "INVALID_CREDENTIALS");
});
