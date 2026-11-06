/*
 * Student name duplicates (same teacher, same grade): active and inactive
 * students hold their name, deleted students (status 2) do not.
 *
 *   npm run test:students
 *
 * Runs the real code through tsx: services/student-service.ts (checkIfNameExists,
 * createStudent, updateStudentForTeacher), GET /api/students/check-name and
 * POST /api/students/import. Only the edges are faked: Prisma
 * (tests/students/helpers/fake-prisma.cjs), the teacher session, the mailer and
 * the monthly-fee helper. No database or SMTP server is contacted.
 *
 * The comparison rules are pinned as they are: the live check is trimmed and
 * case-insensitive, the add / edit checks compare the (trimmed) name exactly,
 * and the CSV import compares trimmed, space-collapsed, lower-cased names.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const Y = new Date().getFullYear();

const T1 = "t-pathum";
const T2 = "t-other";
const GRADE = 6;
const OTHER_GRADE = 7;

const { createFakePrisma } = require("./helpers/fake-prisma.cjs");
const { db, prisma: fakePrisma, reset } = createFakePrisma();

let seq = 0;
function student(name, { status = 0, teacherId = T1, gradeId = GRADE } = {}) {
  seq += 1;
  return {
    id: `s-${seq}`,
    teacherId,
    name,
    gradeId,
    registrationNumber: `PAT-${Y}-${String(100 + seq).padStart(3, "0")}`,
    email: `student${seq}@mail.com`,
    status,
  };
}

function setup(students = []) {
  reset({
    teacher: [
      { id: T1, name: "Pathum", email: "pathum@mail.com" },
      { id: T2, name: "Other Teacher", email: "other@mail.com" },
    ],
    guardian: [],
    grade: [{ id: GRADE }, { id: OTHER_GRADE }],
    student: students,
  });
}

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
  requireTeacherSession: async () => ({ teacherId: T1, name: "Pathum", email: "pathum@mail.com", role: "TEACHER" }),
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
const checkNameRoute = require(path.join(root, "app", "api", "students", "check-name", "route.ts"));
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

const duplicateName = (e) => e.statusCode === 409 && e.code === "DUPLICATE_STUDENT_NAME";

/** The form's live check through the real route (name travels as `registrationNumber`). */
async function liveCheck(name, { gradeId = GRADE, studentId = "" } = {}) {
  const url = `http://localhost/api/students/check-name?registrationNumber=${encodeURIComponent(name)}&studentId=${studentId}&gradeId=${gradeId}`;
  return (await (await checkNameRoute.GET(new Request(url))).json()).exists;
}

let regSeq = 0;
const addInput = (name, gradeId = GRADE) => {
  regSeq += 1;
  return {
    registrationNumber: `PAT-${Y}-${String(500 + regSeq).padStart(3, "0")}`,
    name,
    gradeId,
    contact01: "0771234567",
    email: `new${regSeq}@mail.com`,
  };
};

const editInput = (current, name) => ({
  registrationNumber: current.registrationNumber,
  name,
  gradeId: current.gradeId,
  contact01: "0771234567",
  email: current.email,
});

// ---- Live check -------------------------------------------------------------------

test("live check: active and inactive students hold the name; a deleted student does not", async () => {
  setup([student("Nimal Perera"), student("Kamal Silva", { status: 1 }), student("Sunil Fernando", { status: 2 })]);
  assert.equal(await liveCheck("Nimal Perera"), true, "active");
  assert.equal(await liveCheck("Kamal Silva"), true, "inactive");
  assert.equal(await liveCheck("Sunil Fernando"), false, "deleted only");
});

test("live check: a deleted AND an active student with the name: still taken", async () => {
  setup([student("Nimal Perera", { status: 2 }), student("Nimal Perera")]);
  assert.equal(await liveCheck("Nimal Perera"), true);
});

test("live check: scope unchanged (other grade, other teacher, own record are not clashes)", async () => {
  setup([student("Nimal Perera", { gradeId: OTHER_GRADE }), student("Kamal Silva", { teacherId: T2 }), student("Sunil Fernando")]);
  assert.equal(await liveCheck("Nimal Perera"), false, "same name, other grade");
  assert.equal(await liveCheck("Nimal Perera", { gradeId: OTHER_GRADE }), true, "same name, same grade");
  assert.equal(await liveCheck("Kamal Silva"), false, "another teacher's student");
  assert.equal(await liveCheck("Sunil Fernando", { studentId: db.student[2].id }), false, "the edited student's own name");
});

test("live check: comparison unchanged (trimmed, case-insensitive)", async () => {
  setup([student("Nimal Perera")]);
  assert.equal(await liveCheck("  nimal PERERA "), true);
  assert.equal(await service.checkIfNameExists("NIMAL perera", undefined, T1, GRADE).then((r) => r.exists), true);
});

// ---- Add student ----------------------------------------------------------------

test("add: a deleted student's name in the same grade is accepted", async () => {
  setup([student("Sunil Fernando", { status: 2 })]);
  const created = await quiet(() => service.createStudent(T1, addInput("Sunil Fernando")));
  assert.equal(created.name, "Sunil Fernando");
  assert.equal(db.student.filter((s) => s.name === "Sunil Fernando").length, 2, "the deleted row is kept");
});

test("add: an active or inactive student's name in the same grade is rejected (409)", async () => {
  setup([student("Nimal Perera"), student("Kamal Silva", { status: 1 })]);
  await assert.rejects(quiet(() => service.createStudent(T1, addInput("Nimal Perera"))), duplicateName);
  await assert.rejects(quiet(() => service.createStudent(T1, addInput("Kamal Silva"))), duplicateName);
  assert.equal(db.student.length, 2);
});

test("add: scope unchanged (other grade and other teacher's students do not clash)", async () => {
  setup([student("Nimal Perera", { gradeId: OTHER_GRADE }), student("Kamal Silva", { teacherId: T2 })]);
  await quiet(() => service.createStudent(T1, addInput("Nimal Perera")));
  await quiet(() => service.createStudent(T1, addInput("Kamal Silva")));
  assert.equal(db.student.length, 4);
});

test("add: comparison unchanged (exact match, case-sensitive)", async () => {
  setup([student("Nimal Perera")]);
  const created = await quiet(() => service.createStudent(T1, addInput("nimal perera")));
  assert.equal(created.name, "nimal perera", "a different letter case is not a server-side clash, as before");
});

// ---- Edit student ---------------------------------------------------------------

test("edit: renaming to a deleted student's name is accepted; to an active / inactive one is rejected; keeping one's own name is accepted", async () => {
  setup([student("Nimal Perera"), student("Kamal Silva", { status: 1 }), student("Sunil Fernando", { status: 2 }), student("Amal Jayasinghe")]);
  const editing = db.student[3];
  await quiet(async () => {
    await assert.rejects(service.updateStudentForTeacher(T1, editing.id, editInput(editing, "Nimal Perera")), duplicateName);
    await assert.rejects(service.updateStudentForTeacher(T1, editing.id, editInput(editing, "Kamal Silva")), duplicateName);
    const same = await service.updateStudentForTeacher(T1, editing.id, editInput(editing, "Amal Jayasinghe"));
    assert.equal(same.name, "Amal Jayasinghe");
    const renamed = await service.updateStudentForTeacher(T1, editing.id, editInput(editing, "Sunil Fernando"));
    assert.equal(renamed.name, "Sunil Fernando");
  });
});

// ---- CSV import (unchanged; already excluded deleted students) ----------------------

async function runImport(rows) {
  const request = new Request("http://localhost/api/students/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registrationSource: "IMPORT", students: rows }),
  });
  const response = await importRoute.POST(request);
  return { status: response.status, body: await response.json() };
}

let rowSeq = 0;
const row = (studentName, gradeId = GRADE) => {
  rowSeq += 1;
  return { studentName, gradeId, primaryContact: "0771234567", email: `row${rowSeq}@mail.com` };
};

test("CSV import: a deleted student's name is imported", async () => {
  setup([student("Sunil Fernando", { status: 2 })]);
  const { status, body } = await runImport([row("Sunil Fernando")]);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(db.student.filter((s) => s.name === "Sunil Fernando").length, 2);
});

test("CSV import: active / inactive names and in-file duplicates are still rejected", async () => {
  setup([student("Nimal Perera"), student("Kamal Silva", { status: 1 })]);
  const { status, body } = await runImport([
    row("nimal  perera"),
    row("Kamal Silva"),
    row("New Student"),
    row("NEW student"),
    row("Nimal Perera", OTHER_GRADE),
  ]);
  assert.equal(status, 400);
  const nameErrors = body.errors.filter((e) => e.field === "studentName");
  assert.deepEqual(nameErrors.map((e) => e.row).sort(), [2, 3, 5], JSON.stringify(nameErrors));
  assert.match(nameErrors.find((e) => e.row === 2).message, /already exists in database/);
  assert.match(nameErrors.find((e) => e.row === 5).message, /Duplicate student detected/);
  assert.equal(db.student.length, 2, "nothing was created");
});
