/*
 * Class-scoped notes (services/class-notes-service.ts) against a REAL,
 * THROWAWAY PostgreSQL: Prisma's orderBy with NULLS LAST and the relation
 * sort, the default lecture lookup and the class / enrolment filters.
 *
 *   NOTES_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55435/slc_default_lecture_test npm run test:notes-db
 *
 * The database must already contain the project schema (with Lecture.isDefault)
 * and the project's Prisma client must be generated from it. Safety: SKIPPED
 * unless NOTES_TEST_DATABASE_URL is set; refuses any host other than
 * localhost / 127.0.0.1 and any database whose name does not contain "test";
 * the project's .env database is never used. Every row it creates has the
 * "cntest-" prefix and is deleted afterwards.
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
const P = `cntest-${process.pid}-`;
const TEACHER = `${P}teacher`;
const STUDENT = `${P}student`;
const CLASS = `${P}class`;
const OTHER_CLASS = `${P}other-class`;
const DEFAULT = `${P}default`;
const LECTURE = `${P}lecture`;
const OTHER_LECTURE = `${P}other-lecture`;

let prisma;
let service;

if (!skip) {
  process.env.DATABASE_URL = url; // before anything can load the project's .env
  require("../helpers/server-only.cjs");
  require("tsx/cjs/api").register();
  const { PrismaClient, Prisma } = require("@prisma/client");
  if (!("isDefault" in Prisma.LectureScalarFieldEnum)) throw new Error("Refusing to run: the Prisma client has no Lecture.isDefault (run prisma generate).");
  prisma = new PrismaClient({ datasources: { db: { url } } });
  const filename = path.join(root, "lib", "prisma.ts");
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = { prisma };
  require.cache[filename] = mod;
  service = require(path.join(root, "services", "class-notes-service.ts"));
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM "Note" WHERE "id" LIKE '${P}%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "ClassStudent" WHERE "id" LIKE '${P}%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Lecture" WHERE "id" LIKE '${P}%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Class" WHERE "id" LIKE '${P}%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Student" WHERE "id" LIKE '${P}%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Teacher" WHERE "id" LIKE '${P}%'`);
}

/** A note row; uploadedAt as UTC digits (or NULL: a legacy note). */
async function note(id, lectureId, uploadedAt) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Note" ("id", "title", "fileUrl", "lectureId", "mimeType", "sizeBytes", "uploadedAt") VALUES ($1, $1, 'x', $2, 'application/pdf', 1, ${uploadedAt ? "$3::timestamp(3)" : "NULL"})`,
    ...(uploadedAt ? [`${P}${id}`, lectureId, uploadedAt] : [`${P}${id}`, lectureId])
  );
}

test.describe("class notes on PostgreSQL", { skip }, () => {
  test.before(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(`INSERT INTO "Teacher" ("id", "name", "email", "password") VALUES ($1, 'T', $2, 'x')`, TEACHER, `${TEACHER}@example.test`);
    // gradeId NULL: the column default (Grade 6) needs seeded Grade rows, which a schema built by migrate diff has not.
    await prisma.$executeRawUnsafe(`INSERT INTO "Student" ("id", "name", "teacherId", "contact", "gradeId") VALUES ($1, 'S', $2, '0700000000', NULL)`, STUDENT, TEACHER);
    await prisma.$executeRawUnsafe(`INSERT INTO "Class" ("id", "name", "teacherId") VALUES ($1, 'A', $3), ($2, 'B', $3)`, CLASS, OTHER_CLASS, TEACHER);
    await prisma.$executeRawUnsafe(`INSERT INTO "ClassStudent" ("id", "classId", "studentId", "isActive") VALUES ($1, $2, $3, true)`, `${P}enrolment`, CLASS, STUDENT);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Lecture" ("id", "title", "date", "classId", "isDefault") VALUES ($1, 'General Notes', '2026-01-05 00:00:00', $4, true), ($2, 'Kinematics', '2026-10-10 03:30:00', $4, false), ($3, 'Other', '2026-10-11 03:30:00', $5, false)`,
      DEFAULT, LECTURE, OTHER_LECTURE, CLASS, OTHER_CLASS
    );
    await note("oct", DEFAULT, "2026-10-20 10:00:00");
    await note("legacy-1", DEFAULT, null);
    await note("nov-a", DEFAULT, "2026-11-20 10:00:00");
    await note("nov-b", DEFAULT, "2026-11-20 10:00:00");
    await note("legacy-2", DEFAULT, null);
    await note("lecture", LECTURE, "2026-10-10 05:00:00");
  });
  test.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test("General Notes: uploadedAt DESC, NULLs last, id DESC breaking ties (PostgreSQL would put NULLs FIRST for DESC by default)", async () => {
    const teacher = await service.listClassNotesForTeacher(TEACHER, CLASS);
    assert.equal(teacher.section, "GENERAL");
    assert.equal(teacher.lecture.id, DEFAULT);
    assert.deepEqual(teacher.notes.map((n) => n.id), ["nov-b", "nov-a", "oct", "legacy-2", "legacy-1"].map((id) => `${P}${id}`));
    assert.equal(teacher.notes[0].uploadedAt.toISOString(), "2026-11-20T10:00:00.000Z");
    const student = await service.listClassNotesForStudent(STUDENT, CLASS);
    assert.deepEqual(student.notes.map((n) => n.id), teacher.notes.map((n) => n.id), "the same order for students");
  });

  test("lecture notes; another class's lecture and the default lecture's id are refused; a missing default lecture is 409", async () => {
    assert.deepEqual((await service.listClassNotesForTeacher(TEACHER, CLASS, { lectureId: LECTURE })).notes.map((n) => n.id), [`${P}lecture`]);
    await assert.rejects(service.listClassNotesForTeacher(TEACHER, CLASS, { lectureId: OTHER_LECTURE }), (e) => e.code === "LECTURE_NOT_FOUND");
    await assert.rejects(service.listClassNotesForStudent(STUDENT, CLASS, { lectureId: DEFAULT }), (e) => e.code === "LECTURE_NOT_FOUND");
    await assert.rejects(service.listClassNotesForTeacher(TEACHER, OTHER_CLASS), (e) => e.code === "DEFAULT_LECTURE_MISSING");
    await assert.rejects(service.listClassNotesForStudent(STUDENT, OTHER_CLASS, { lectureId: OTHER_LECTURE }), (e) => e.code === "CLASS_NOT_FOUND", "not enrolled");
    assert.equal(await prisma.lecture.count({ where: { classId: OTHER_CLASS, isDefault: true } }), 0, "nothing created");
  });

  test("an inactive enrolment or a deactivated class hides the class from the student", async () => {
    await prisma.classStudent.update({ where: { id: `${P}enrolment` }, data: { isActive: false } });
    await assert.rejects(service.listClassNotesForStudent(STUDENT, CLASS), (e) => e.code === "CLASS_NOT_FOUND");
    await prisma.classStudent.update({ where: { id: `${P}enrolment` }, data: { isActive: true } });
    await prisma.class.update({ where: { id: CLASS }, data: { status: 1 } });
    await assert.rejects(service.listClassNotesForStudent(STUDENT, CLASS), (e) => e.code === "CLASS_NOT_FOUND");
    await assert.rejects(service.listClassNotesForTeacher(TEACHER, CLASS), (e) => e.code === "CLASS_NOT_FOUND");
    await prisma.class.update({ where: { id: CLASS }, data: { status: 0 } });
  });
});
