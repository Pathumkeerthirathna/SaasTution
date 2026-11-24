/*
 * Notes redesign Stage 4: the student dashboard's notes against a REAL,
 * THROWAWAY PostgreSQL:
 *  - GET /api/student/dashboard/notes (the unviewed notes widget): General
 *    Notes included, newest upload first, notes without uploadedAt last,
 *    uploadedAt / isGeneral / classId returned;
 *  - services/student-dashboard-counts-service.ts: notes counted per note with
 *    the widget's eligibility (active enrolment, active class), the range on
 *    the Sri Lankan month of uploadedAt (else the lecture's date), late
 *    enrolments counted as unviewed, nothing counted twice.
 *
 *   NOTES_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55435/slc_default_lecture_test npm run test:notes-db
 *
 * Same safety rules as tests/notes/class-notes.db.test.cjs (localhost only, a
 * database name containing "test", the project's .env never used); every row
 * has the "dntest-" prefix and is deleted afterwards. The clock is fixed at
 * 25 Nov 2026 11:30 in Sri Lanka.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const url = process.env.NOTES_TEST_DATABASE_URL;
let skip = "set NOTES_TEST_DATABASE_URL to a throwaway local database to run these tests";
if (url) {
  const target = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Refusing to run: NOTES_TEST_DATABASE_URL must point at localhost.");
  if (!/test/i.test(target.pathname.replace(/^\//, ""))) throw new Error('Refusing to run: the test database name must contain "test".');
  skip = false;
}

const root = path.resolve(__dirname, "..", "..");
const P = `dntest-${process.pid}-`;
const TEACHER = `${P}teacher`;
const STUDENT = `${P}student`;
const CLASS_A = `${P}class-a`;
const CLASS_B = `${P}class-b`; // the student was removed from it
const DEFAULT_A = `${P}default-a`;
const LECTURE_A = `${P}lecture-a`; // 10 Oct 2026
const LECTURE_B = `${P}lecture-b`;
const id = (name) => `${P}${name}`;

let prisma;
let route;
let counts;

function fakeModule(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

if (!skip) {
  process.env.DATABASE_URL = url; // before anything can load the project's .env
  require("../helpers/server-only.cjs");
  require("tsx/cjs/api").register();
  const { PrismaClient } = require("@prisma/client");
  prisma = new PrismaClient({ datasources: { db: { url } } });
  fakeModule("lib/prisma.ts", { prisma });
  fakeModule("lib/auth-session.ts", {
    requireStudentSession: async () => ({ studentId: STUDENT, role: "STUDENT" }),
    requireTeacherSession: async () => { throw new Error("not used"); },
    requireAppSession: async () => { throw new Error("not used"); },
    requireAdminSession: async () => { throw new Error("not used"); },
    getOptionalSession: async () => null,
  });
  route = require(path.join(root, "app", "api", "student", "dashboard", "notes", "route.ts"));
  counts = require(path.join(root, "services", "student-dashboard-counts-service.ts"));
}

async function cleanup() {
  for (const table of ["NoteStudent", "Note", "ClassStudent", "Lecture", "Class", "Student", "Teacher"]) {
    const column = table === "NoteStudent" ? '"noteId"' : '"id"';
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${column} LIKE '${P}%'`);
  }
}

async function note(name, lectureId, uploadedAt, { kind = "NOTE", status = 0, viewed } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Note" ("id", "title", "fileUrl", "lectureId", "mimeType", "sizeBytes", "kind", "status", "uploadedAt") VALUES ($1, $1, 'x', $2, 'application/pdf', 1, $3::"NoteKind", $4, ${uploadedAt ? "$5::timestamp(3)" : "NULL"})`,
    ...[id(name), lectureId, kind, status, ...(uploadedAt ? [uploadedAt] : [])]
  );
  if (viewed !== undefined) {
    await prisma.$executeRawUnsafe(`INSERT INTO "NoteStudent" ("id", "noteId", "studentId", "viewed", "updatedAt") VALUES ($1, $2, $3, $4, now())`, id(`ns-${name}`), id(name), STUDENT, viewed);
  }
}

test.describe("student dashboard notes on PostgreSQL", { skip }, () => {
  test.before(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(`INSERT INTO "Teacher" ("id", "name", "email", "password") VALUES ($1, 'T', $2, 'x')`, TEACHER, `${TEACHER}@example.test`);
    await prisma.$executeRawUnsafe(`INSERT INTO "Student" ("id", "name", "teacherId", "contact", "gradeId") VALUES ($1, 'S', $2, '0700000000', NULL)`, STUDENT, TEACHER);
    await prisma.$executeRawUnsafe(`INSERT INTO "Class" ("id", "name", "teacherId") VALUES ($1, 'Physics', $3), ($2, 'Chemistry', $3)`, CLASS_A, CLASS_B, TEACHER);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ClassStudent" ("id", "classId", "studentId", "isActive") VALUES ($1, $2, $4, true), ($3, $5, $4, false)`,
      id("enrol-a"), CLASS_A, id("enrol-b"), STUDENT, CLASS_B
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Lecture" ("id", "title", "date", "classId", "isDefault") VALUES ($1, 'General Notes', '2026-01-05 00:00:00', $4, true), ($2, 'Kinematics', '2026-10-10 03:30:00', $4, false), ($3, 'Organic', '2026-11-10 03:30:00', $5, false)`,
      DEFAULT_A, LECTURE_A, LECTURE_B, CLASS_A, CLASS_B
    );
    // General Notes of class A.
    await note("g-nov", DEFAULT_A, "2026-11-20 10:00:00"); // uploaded before the student enrolled: no NoteStudent row
    await note("g-oct-viewed", DEFAULT_A, "2026-10-05 10:00:00", { viewed: true });
    await note("g-nov-viewed", DEFAULT_A, "2026-11-21 10:00:00", { viewed: true });
    // Lecture notes of class A.
    await note("l-nov", LECTURE_A, "2026-11-22 10:00:00", { viewed: false });
    await note("l-legacy", LECTURE_A, null); // no uploadedAt: the lecture's date (10 Oct) decides
    await note("l-supporting", LECTURE_A, "2026-11-23 10:00:00", { kind: "SUPPORTING_MATERIAL" });
    await note("l-edge-nov", LECTURE_A, "2026-10-31 19:00:00"); // 1 Nov 00:30 in Sri Lanka
    await note("l-edge-oct", LECTURE_A, "2026-10-31 18:00:00"); // 31 Oct 23:30 in Sri Lanka
    await note("l-removed", LECTURE_A, "2026-11-22 11:00:00", { status: 1 });
    // A class the student was removed from: a leftover unviewed row.
    await note("b-nov", LECTURE_B, "2026-11-22 12:00:00", { viewed: false });
  });
  test.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test("widget: General Notes included; newest upload first, no uploadedAt last; viewed, removed, supporting and other-class notes excluded", async () => {
    const response = await route.GET(new Request("http://localhost/api/student/dashboard/notes"));
    assert.equal(response.status, 200);
    const { data } = await response.json();
    const mine = data.notes.filter((n) => n.id.startsWith(P));
    assert.deepEqual(mine.map((n) => n.id), ["l-nov", "g-nov", "l-edge-nov", "l-edge-oct", "l-legacy"].map(id));
    const general = mine.find((n) => n.id === id("g-nov"));
    assert.deepEqual(
      { isGeneral: general.isGeneral, classId: general.classId, uploadedAt: general.uploadedAt, lectureId: general.lectureId },
      { isGeneral: true, classId: CLASS_A, uploadedAt: "2026-11-20T10:00:00.000Z", lectureId: DEFAULT_A }
    );
    const legacy = mine.find((n) => n.id === id("l-legacy"));
    assert.deepEqual([legacy.isGeneral, legacy.uploadedAt, legacy.date], [false, null, "2026-10-10T03:30:00.000Z"]);
    assert.ok("resourceAccess" in general, "the lock information is unchanged");
  });

  test("counts: per note, by the Sri Lankan month of uploadedAt (else the lecture's date); late enrolments unviewed; removed enrolments not counted", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-25T06:00:00.000Z") });
    const notesOf = async (range) => (await counts.getStudentDashboardCounts(STUDENT, range)).notes;
    // November (Sri Lanka): g-nov, g-nov-viewed, l-nov, l-supporting, l-edge-nov.
    assert.deepEqual(await notesOf("month"), { total: 5, unviewed: 4 });
    // October–December: + g-oct-viewed, l-legacy (lecture 10 Oct), l-edge-oct.
    assert.deepEqual(await notesOf("quarter"), { total: 8, unviewed: 6 });
    assert.deepEqual(await notesOf("year"), { total: 8, unviewed: 6 });
    assert.deepEqual(await notesOf("all"), { total: 8, unviewed: 6 });
  });

  test("counts: viewing a late-enrolled note moves it from unviewed to viewed without changing the total (no double counting)", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-25T06:00:00.000Z") });
    await prisma.$executeRawUnsafe(`INSERT INTO "NoteStudent" ("id", "noteId", "studentId", "viewed", "viewedAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())`, id("ns-g-nov"), id("g-nov"), STUDENT);
    assert.deepEqual((await counts.getStudentDashboardCounts(STUDENT, "month")).notes, { total: 5, unviewed: 3 });
    const { data } = await (await route.GET(new Request("http://localhost/api/student/dashboard/notes"))).json();
    assert.equal(data.notes.some((n) => n.id === id("g-nov")), false, "gone from the widget");
    await prisma.$executeRawUnsafe(`DELETE FROM "NoteStudent" WHERE "id" = $1`, id("ns-g-nov"));
  });
});
