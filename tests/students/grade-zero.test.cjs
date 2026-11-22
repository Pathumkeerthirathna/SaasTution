/*
 * Grade 0 (lib/grade.ts): the grade of a student with no school grade, a real
 * Grade row with the fixed id 0.
 *
 *   node --test tests/students/grade-zero.test.cjs
 *
 * Pinned:
 *  - Every creation path (teacher add form / POST /api/students, public class
 *    registration, bulk import): no grade -> Grade 0; explicit Grade 0 kept;
 *    an explicit valid grade kept; an invalid grade refused (nothing created).
 *  - Grade 0 is never treated as "no grade": list / export filters, the live
 *    name check and the add / edit / import duplicate-name checks.
 *  - Student / family-facing displays (guardian portal) never show Grade 0;
 *    teacher screens list it (/api/Grade, first).
 *
 * Real code through tsx; only the edges are faked: Prisma
 * (tests/students/helpers/fake-prisma.cjs), the teacher session, the mailer,
 * the monthly-fee helper and the email worker wake-up. No database or email
 * server is contacted; payload key / URLs are throwaway in-process values.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grade-zero-"));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");
process.env.APP_URL = "http://localhost:3000";
process.env.TRUSTED_PROXY_COUNT = "1";
process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = "c4".repeat(32);
const APP = "http://localhost:3000";

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const Y = new Date().getFullYear();

const T1 = "t-pathum";
const CLASS = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

const { createFakePrisma } = require("./helpers/fake-prisma.cjs");
const { db, prisma: fakePrisma, reset } = createFakePrisma();

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
  buildStudentLoginLink: () => "https://slclassroom.live/login",
  buildPasswordResetLink: () => "",
  sendEmail: async () => {},
  sendPasswordResetEmail: async () => {},
  sendPasswordChangedEmail: async () => {},
  sendEmailVerificationCodeEmail: async () => {},
  sendStudentRegistrationEmail: async () => {},
  sendStudentWelcomeCredentialsEmail: async () => {},
});
fake("services/class-student-fee-service.ts", { ensureCurrentMonthFeeForClassStudent: async () => {} });
fake("services/email-delivery-worker.ts", { wakeEmailDeliveryWorker: () => {} });

const grade = require(path.join(root, "lib", "grade.ts"));
const validation = require(path.join(root, "lib", "student-validation.ts"));
const service = require(path.join(root, "services", "student-service.ts"));
const studentsRoute = require(path.join(root, "app", "api", "students", "route.ts"));
const exportRoute = require(path.join(root, "app", "api", "students", "export", "route.ts"));
const checkNameRoute = require(path.join(root, "app", "api", "students", "check-name", "route.ts"));
const importRoute = require(path.join(root, "app", "api", "students", "import", "route.ts"));
const registerRoute = require(path.join(root, "app", "api", "students", "public", "Register", "route.ts"));
const LIMIT = require(path.join(root, "lib", "public-registration-rate-limit.ts"));
const guardianPortal = require(path.join(root, "services", "guardian-portal-service.ts"));

let seq = 0;
function student(name, gradeId, { status = 0 } = {}) {
  seq += 1;
  return {
    id: `s-${seq}`,
    teacherId: T1,
    name,
    gradeId,
    registrationNumber: `PAT-${Y}-${String(100 + seq).padStart(3, "0")}`,
    email: `student${seq}@mail.com`,
    status,
  };
}

function setup(students = []) {
  reset({
    teacher: [{ id: T1, name: "Pathum", email: "pathum@mail.com" }],
    guardian: [],
    grade: [
      { id: 0, GradeDesc: "Grade 0", Status: 1 },
      { id: 6, GradeDesc: "Grade 6", Status: 1 },
      { id: 7, GradeDesc: "Grade 7", Status: 1 },
    ],
    class: [{ id: CLASS, teacherId: T1, status: 0, name: "Maths" }],
    student: students,
    emailDelivery: [],
  });
  LIMIT.setPublicRegistrationRateLimiterForTests(undefined);
}

async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const invalidGrade = (e) => e.statusCode === 400 && e.code === "VALIDATION_ERROR";
const duplicateName = (e) => e.statusCode === 409 && e.code === "DUPLICATE_STUDENT_NAME";

// ---- lib/grade.ts ---------------------------------------------------------------------

test("lib/grade: Grade 0 is the fixed id 0", () => {
  assert.equal(grade.GRADE_ZERO_ID, 0);
  assert.equal(grade.GRADE_ZERO_DESC, "Grade 0");
  assert.equal(grade.isGradeZero(0), true);
  for (const value of [6, null, undefined]) assert.equal(grade.isGradeZero(value), false);
});

test("lib/grade resolveOptionalGradeId: blank -> Grade 0, whole numbers >= 0 kept, anything else refused", () => {
  for (const blank of [undefined, null, "", "   "]) {
    assert.deepEqual(grade.resolveOptionalGradeId(blank), { ok: true, gradeId: 0 }, JSON.stringify(blank));
  }
  assert.deepEqual(grade.resolveOptionalGradeId(0), { ok: true, gradeId: 0 });
  assert.deepEqual(grade.resolveOptionalGradeId(6), { ok: true, gradeId: 6 });
  assert.deepEqual(grade.resolveOptionalGradeId(" 13 "), { ok: true, gradeId: 13 });
  assert.deepEqual(grade.resolveOptionalGradeId("0"), { ok: true, gradeId: 0 });
  for (const bad of [-1, 1.5, NaN, Infinity, "Grade 15", "-1", "1.5", true, {}, []]) {
    assert.deepEqual(grade.resolveOptionalGradeId(bad), { ok: false }, String(bad));
  }
});

test("lib/grade parseGradeFilter: absent / blank -> no filter; \"0\" is Grade 0", () => {
  for (const none of [null, undefined, "", "  ", "abc", "-1", "1.5"]) assert.equal(grade.parseGradeFilter(none), undefined, String(none));
  assert.equal(grade.parseGradeFilter("0"), 0);
  assert.equal(grade.parseGradeFilter("7"), 7);
});

test("lib/grade displayGradeForStudent: hides Grade 0 and a missing grade, shows every other grade", () => {
  assert.equal(grade.displayGradeForStudent({ id: 0, GradeDesc: "Grade 0" }), null);
  assert.equal(grade.displayGradeForStudent(null), null);
  assert.equal(grade.displayGradeForStudent(undefined), null);
  assert.equal(grade.displayGradeForStudent({ id: 6, GradeDesc: "Grade 6" }), "Grade 6");
});

// ---- Request schemas -------------------------------------------------------------------

const addBody = (overrides = {}) => ({
  registrationNumber: `PAT-${Y}-900`,
  name: "New Student",
  contact01: "0771234567",
  email: "new@mail.com",
  ...overrides,
});

test("createStudentSchema: no grade -> Grade 0; Grade 0 and a valid grade kept; invalid refused", () => {
  const parse = (overrides) => validation.createStudentSchema.safeParse(addBody(overrides));
  assert.equal(parse({}).data.gradeId, 0, "missing");
  assert.equal(parse({ gradeId: null }).data.gradeId, 0, "null");
  assert.equal(parse({ gradeId: 0 }).data.gradeId, 0, "explicit Grade 0");
  assert.equal(parse({ gradeId: 6 }).data.gradeId, 6);
  for (const bad of [-1, 1.5, "6", "", true]) {
    const result = parse({ gradeId: bad });
    assert.equal(result.success, false, JSON.stringify(bad));
    assert.equal(result.error.issues[0].path[0], "gradeId");
  }
});

test("updateStudentSchema: Grade 0 is a valid grade; an edit must still send one", () => {
  const parse = (overrides) => validation.updateStudentSchema.safeParse(addBody(overrides));
  assert.equal(parse({ gradeId: 0 }).data.gradeId, 0);
  assert.equal(parse({ gradeId: 7 }).data.gradeId, 7);
  for (const bad of [undefined, null, -1, 1.5, "6"]) assert.equal(parse({ gradeId: bad }).success, false, String(bad));
});

// ---- Teacher add form (POST /api/students -> createStudent) ------------------------------

async function teacherPost(body) {
  const response = await studentsRoute.POST(
    new Request(`${APP}/api/students`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  );
  return { status: response.status, body: await response.json() };
}

test("teacher add: no grade -> Grade 0; Grade 0 kept; a valid grade kept", async () => {
  setup();
  await quiet(async () => {
    const cases = [
      [{ email: "a@mail.com", registrationNumber: `PAT-${Y}-901` }, 0],
      [{ email: "b@mail.com", registrationNumber: `PAT-${Y}-902`, name: "Other One", gradeId: null }, 0],
      [{ email: "c@mail.com", registrationNumber: `PAT-${Y}-903`, name: "Third One", gradeId: 0 }, 0],
      [{ email: "d@mail.com", registrationNumber: `PAT-${Y}-904`, name: "Fourth One", gradeId: 6 }, 6],
    ];
    for (const [overrides, expected] of cases) {
      const { status, body } = await teacherPost(addBody(overrides));
      assert.equal(status, 201, JSON.stringify(body));
      const created = db.student.find((s) => s.email === overrides.email);
      assert.equal(created.gradeId, expected, JSON.stringify(overrides));
    }
  });
});

test("teacher add: a grade that is no Grade row is 400 (never a foreign-key 500) and creates nothing", async () => {
  setup();
  await quiet(async () => {
    const { status, body } = await teacherPost(addBody({ gradeId: 999 }));
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.equal(db.student.length, 0);
    const negative = await teacherPost(addBody({ gradeId: -1 }));
    assert.equal(negative.status, 400);
    assert.equal(db.student.length, 0);
  });
});

test("teacher add / edit: the duplicate-name check applies within Grade 0 too", async () => {
  setup([student("Nimal Perera", 0), student("Kamal Silva", 6)]);
  await quiet(async () => {
    const zero = validation.createStudentSchema.parse(addBody({ name: "Nimal Perera" }));
    assert.equal(zero.gradeId, 0);
    await assert.rejects(service.createStudent(T1, zero), duplicateName);

    const other = validation.createStudentSchema.parse(addBody({ name: "Nimal Perera", gradeId: 6, email: "x@mail.com" }));
    const created = await service.createStudent(T1, other);
    assert.equal(created.name, "Nimal Perera", "same name, other grade");

    const editing = db.student.find((s) => s.name === "Kamal Silva");
    const move = (gradeId) => ({ registrationNumber: editing.registrationNumber, name: "Nimal Perera", gradeId, contact01: "0771234567", email: editing.email });
    await assert.rejects(service.updateStudentForTeacher(T1, editing.id, move(0)), duplicateName);
    await assert.rejects(service.updateStudentForTeacher(T1, editing.id, move(999)), invalidGrade);
  });
});

test("teacher edit: moving a student to Grade 0 is kept as Grade 0", async () => {
  setup([student("Kamal Silva", 6)]);
  await quiet(async () => {
    const editing = db.student[0];
    const input = validation.updateStudentSchema.parse({ registrationNumber: editing.registrationNumber, name: "Kamal Silva", gradeId: 0, contact01: "0771234567", email: editing.email });
    await service.updateStudentForTeacher(T1, editing.id, input);
    assert.equal(db.student[0].gradeId, 0);
  });
});

// ---- Live name check (GET /api/students/check-name) ---------------------------------------

async function liveCheck(name, gradeIdParam) {
  const query = gradeIdParam === undefined ? "" : `&gradeId=${gradeIdParam}`;
  const url = `${APP}/api/students/check-name?registrationNumber=${encodeURIComponent(name)}&studentId=${query}`;
  return (await (await checkNameRoute.GET(new Request(url))).json()).exists;
}

test("live name check: gradeId=0 checks within Grade 0 only (never ignored as \"no grade\")", async () => {
  setup([student("Nimal Perera", 6), student("Sunil Fernando", 0)]);
  assert.equal(await liveCheck("Nimal Perera", 0), false, "the Grade 6 student is not a Grade 0 clash");
  assert.equal(await liveCheck("Sunil Fernando", 0), true);
  assert.equal(await liveCheck("Sunil Fernando", 6), false);
  assert.equal(await service.checkIfNameExists("Sunil Fernando", undefined, T1, 0).then((r) => r.exists), true);
  assert.equal(await service.checkIfNameExists("Nimal Perera", undefined, T1, 0).then((r) => r.exists), false);
});

// ---- Public class registration -------------------------------------------------------------

let ipCounter = 0;
async function register(overrides) {
  ipCounter += 1;
  const body = {
    classId: CLASS,
    studentName: `Public Student ${ipCounter}`,
    mobileNumber: "0771234567",
    email: `public${ipCounter}@mail.com`,
    ...overrides,
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  const response = await registerRoute.POST(
    new Request(`${APP}/api/students/public/Register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP, "sec-fetch-site": "same-origin", "x-forwarded-for": `198.51.100.${ipCounter % 250}` },
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, body: await response.json(), email: body.email };
}

test("public registration: no grade / \"No specific grade\" (null) -> Grade 0; Grade 0 and a valid grade kept", async () => {
  setup();
  await quiet(async () => {
    for (const [overrides, expected] of [[{ gradeId: undefined }, 0], [{ gradeId: null }, 0], [{ gradeId: 0 }, 0], [{ gradeId: 7 }, 7]]) {
      const { status, body, email } = await register(overrides);
      assert.equal(status, 201, JSON.stringify({ overrides, body }));
      assert.equal(db.student.find((s) => s.email === email).gradeId, expected, JSON.stringify(overrides));
    }
  });
});

test("public registration: an invalid grade is 400 (field gradeId) and creates nothing", async () => {
  setup();
  await quiet(async () => {
    for (const bad of [999, -1, 1.5, "6", ""]) {
      const { status, body } = await register({ gradeId: bad });
      assert.equal(status, 400, JSON.stringify(bad));
      assert.equal(body.error.code, "VALIDATION_ERROR");
      assert.equal(body.error.details.field, "gradeId", JSON.stringify(bad));
    }
    assert.equal(db.student.length, 0);
  });
});

test("public registration: no grade still needs Grade 0 to exist (an unmigrated database refuses, creates nothing)", async () => {
  setup();
  db.grade = db.grade.filter((g) => g.id !== 0);
  await quiet(async () => {
    const { status, body } = await register({ gradeId: undefined });
    assert.equal(status, 400);
    assert.equal(body.error.details.field, "gradeId");
    assert.equal(db.student.length, 0);
  });
});

// ---- Bulk import ---------------------------------------------------------------------------

async function runImport(rows) {
  const response = await importRoute.POST(
    new Request(`${APP}/api/students/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationSource: "IMPORT", students: rows }),
    })
  );
  return { status: response.status, body: await response.json() };
}

let rowSeq = 0;
const row = (studentName, gradeId) => {
  rowSeq += 1;
  const r = { studentName, primaryContact: "0771234567", email: `row${rowSeq}@mail.com` };
  if (gradeId !== "omit") r.gradeId = gradeId;
  return r;
};

test("import: blank grade (missing / null / \"\") -> Grade 0; Grade 0 and a valid grade kept", async () => {
  setup();
  await quiet(async () => {
    const rows = [row("Row Missing", "omit"), row("Row Null", null), row("Row Empty", ""), row("Row Zero", 0), row("Row Six", 6)];
    const { status, body } = await runImport(rows);
    assert.equal(status, 200, JSON.stringify(body));
    const gradeOf = (name) => db.student.find((s) => s.name === name).gradeId;
    assert.deepEqual(
      ["Row Missing", "Row Null", "Row Empty", "Row Zero", "Row Six"].map(gradeOf),
      [0, 0, 0, 0, 6]
    );
  });
});

test("import: an invalid grade is refused per row (\"Invalid grade.\") and nothing is imported", async () => {
  setup();
  await quiet(async () => {
    const { status, body } = await runImport([row("Good Row", 6), row("Unknown Id", 999), row("Text", "Grade 15"), row("Negative", -1), row("Fraction", 1.5)]);
    assert.equal(status, 400, JSON.stringify(body));
    const gradeErrors = body.errors.filter((e) => e.field === "gradeId");
    assert.deepEqual(gradeErrors.map((e) => e.row).sort(), [3, 4, 5, 6]);
    for (const e of gradeErrors) assert.equal(e.message, "Invalid grade.");
    assert.equal(db.student.length, 0);
  });
});

test("import: duplicate names are checked within Grade 0 (file and database), not across grades", async () => {
  setup([student("Nimal Perera", 0)]);
  await quiet(async () => {
    const { status, body } = await runImport([row("nimal perera", null), row("Kamal Silva", 0), row("kamal  silva", "")]);
    assert.equal(status, 400);
    const nameErrors = body.errors.filter((e) => e.field === "studentName").map((e) => e.row).sort();
    assert.deepEqual(nameErrors, [2, 4], JSON.stringify(body.errors));

    const ok = await runImport([row("Nimal Perera", 6)]);
    assert.equal(ok.status, 200, "the same name in another grade is fine");
  });
});

// ---- List / export filters ----------------------------------------------------------------

async function captureStudentQuery(run) {
  const saved = { findMany: fakePrisma.student.findMany, count: fakePrisma.student.count };
  const seen = [];
  fakePrisma.student.findMany = async (args) => {
    seen.push(args.where);
    return [];
  };
  fakePrisma.student.count = async () => 0;
  try {
    await run();
  } finally {
    Object.assign(fakePrisma.student, saved);
  }
  return seen;
}

test("student list: ?grade=0 filters to Grade 0; no / blank grade lists every grade", async () => {
  setup();
  const list = (query) => captureStudentQuery(() => studentsRoute.GET(new Request(`${APP}/api/students${query}`)));
  assert.equal((await list("?grade=0"))[0].gradeId, 0);
  assert.equal((await list("?grade=7"))[0].gradeId, 7);
  assert.equal("gradeId" in (await list(""))[0], false);
  assert.equal("gradeId" in (await list("?grade="))[0], false);
});

test("student export: ?grade=0 filters to Grade 0; no grade exports every grade", async () => {
  setup();
  const exportWhere = (query) => captureStudentQuery(() => exportRoute.GET(new Request(`${APP}/api/students/export${query}`)));
  assert.equal((await exportWhere("?grade=0"))[0].gradeId, 0);
  assert.equal("gradeId" in (await exportWhere(""))[0], false);
});

// ---- Student / family-facing display -------------------------------------------------------

test("guardian portal: Grade 0 is never shown; other grades are", async () => {
  // The fake cannot join; the linked rows are returned as Prisma would select them.
  const delegate = fakePrisma.guardianStudent;
  const savedFindMany = delegate.findMany;
  const link = (id, g) => ({ relation: "MOTHER", student: { id, name: id, registrationNumber: `REG-${id}`, grade: g, _count: { classes: 1 } } });
  delegate.findMany = async () => [link("a", { id: 0, GradeDesc: "Grade 0" }), link("b", { id: 6, GradeDesc: "Grade 6" }), link("c", null)];
  try {
    const students = await guardianPortal.getGuardianStudents("g-1");
    assert.deepEqual(students.map((s) => s.grade), [null, "Grade 6", null]);
  } finally {
    delegate.findMany = savedFindMany;
  }
  assert.match(read("services", "guardian-portal-service.ts"), /grade: \{ select: \{ id: true, GradeDesc: true \} \}/);
});

// ---- Source guards: Grade 0 is never "empty" ------------------------------------------------

test("source: no grade-id truthiness checks left in the creation, filter and duplicate paths", () => {
  const files = {
    "app/api/students/route.ts": read("app", "api", "students", "route.ts"),
    "app/api/students/export/route.ts": read("app", "api", "students", "export", "route.ts"),
    "app/api/students/check-name/route.ts": read("app", "api", "students", "check-name", "route.ts"),
    "app/api/students/import/route.ts": read("app", "api", "students", "import", "route.ts"),
    "app/api/students/public/Register/route.ts": read("app", "api", "students", "public", "Register", "route.ts"),
    "services/student-service.ts": read("services", "student-service.ts"),
    "lib/student-validation.ts": read("lib", "student-validation.ts"),
    "components/student-guardian-management-panel.tsx": read("components", "student-guardian-management-panel.tsx"),
  };
  const truthy = [
    /gradeId\s*\|\|/,
    /!\s*(?:student\.|params\.|input\.)?gradeId\b(?!\s*[=!]==?)/,
    /\(\s*(?:params\.)?gradeId\s*\?/,
    /\$\{?\s*student\.gradeId\s*\?\s*""/,
    /gradeId\)\s*\n?\s*\.filter\(Boolean\)/,
    /Number\([^)]*\)\s*\|\|\s*null/,
    /gradeId:\s*0,/,
    /\.positive\(/,
  ];
  for (const [file, source] of Object.entries(files)) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const pattern of truthy) assert.doesNotMatch(code, pattern, `${file}: ${pattern}`);
  }
});

test("source: the public form hides Grade 0 and offers \"No specific grade\" (sent as no grade)", () => {
  const card = read("components", "teacherProfile", "classLanding", "ClassRegisterCard.tsx");
  assert.match(card, />No specific grade</);
  assert.match(card, /grades\.filter\(\(grade\) => !isGradeZero\(Number\(grade\.id\)\)\)/);
  assert.match(card, /gradeId: selectedGrade === NO_SPECIFIC_GRADE \? null : parseInt\(selectedGrade, 10\)/);
});

test("source: teacher screens list Grade 0 (/api/Grade lists every grade, id order; the add form's grade is optional)", () => {
  const route = read("app", "api", "Grade", "route.ts");
  assert.match(route, /findMany\(\{\s*orderBy: \{ id: "asc" \},\s*\}\)/);
  assert.doesNotMatch(route, /where:/, "no grade is filtered out for teachers");
  assert.doesNotMatch(route, /console\.log/);

  const panel = read("components", "student-guardian-management-panel.tsx");
  assert.match(panel, /<option value="">No grade selected \(Grade 0\)<\/option>/);
  assert.match(panel, /studentForm\.gradeId \?\? GRADE_ZERO_ID/);
  assert.match(panel, /gradeId: importedGradeId\(/);
});

test("source: the database default and the relation are unchanged (the server assigns Grade 0 itself)", () => {
  const schema = read("prisma", "schema.prisma");
  assert.match(schema, /gradeId\s+Int\?\s+@default\(6\)/);
  assert.match(schema, /model Grade \{\s*id\s+Int\s+@id @default\(autoincrement\(\)\)\s*GradeDesc\s+String\s*Status\s+Int\s+@default\(0\)\s*students\s+Student\[\]\s*\}/);
});
