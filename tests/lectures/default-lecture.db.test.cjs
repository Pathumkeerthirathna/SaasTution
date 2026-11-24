/*
 * The default lecture against a REAL, THROWAWAY PostgreSQL: the column and
 * the partial unique index of migration 20261129120000, class creation's
 * transaction (services/class-service.ts createClassForTeacher) and the
 * manual backfill script (docs/sql/default-lecture-backfill.sql).
 *
 *   DEFAULT_LECTURE_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55434/slc_attendance_test \
 *   DEFAULT_LECTURE_PRISMA_CLIENT=<a client generated from the current schema> \
 *   npm run test:default-lecture-db
 *
 * The database must already contain the project schema with this migration.
 * DEFAULT_LECTURE_PRISMA_CLIENT is optional: without it the project's
 * @prisma/client is used, which must have been generated from the current
 * schema (the file refuses to run with a client that has no Lecture.isDefault).
 *
 * Safety: SKIPPED unless DEFAULT_LECTURE_TEST_DATABASE_URL is set; refuses
 * any host other than localhost / 127.0.0.1 and any database whose name does
 * not contain "test". The project's .env database is never used. Every row it
 * creates has the "dltest-" prefix (or belongs to such a class) and is
 * deleted afterwards. The backfill test runs the script's INSERT, which
 * gives EVERY class of the throwaway database a default lecture.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const url = process.env.DEFAULT_LECTURE_TEST_DATABASE_URL;
let skip = "set DEFAULT_LECTURE_TEST_DATABASE_URL to a throwaway local database to run these tests";
if (url) {
  const target = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Refusing to run: DEFAULT_LECTURE_TEST_DATABASE_URL must point at localhost.");
  if (!/test/i.test(target.pathname.replace(/^\//, ""))) throw new Error('Refusing to run: the test database name must contain "test".');
  skip = false;
}

const root = path.resolve(__dirname, "..", "..");
const PREFIX = "dltest-";
const TEACHER = `${PREFIX}teacher-${process.pid}`;
const CLASS_A = `${PREFIX}class-a-${process.pid}`;
const CLASS_B = `${PREFIX}class-b-${process.pid}`;

let prisma;
let classService;

function fake(relativePath, exports) {
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
  const clientPath = process.env.DEFAULT_LECTURE_PRISMA_CLIENT;
  const { PrismaClient, Prisma } = require(clientPath ? path.resolve(clientPath) : "@prisma/client");
  if (!("isDefault" in Prisma.LectureScalarFieldEnum)) {
    throw new Error("Refusing to run: this Prisma client has no Lecture.isDefault (run prisma generate, or set DEFAULT_LECTURE_PRISMA_CLIENT).");
  }
  prisma = new PrismaClient({ datasources: { db: { url } } });
  fake("lib/prisma.ts", { prisma });
  fake("lib/session-events.ts", { emitStudentDataChange: () => {}, emitLiveChange: () => {} });
  classService = require(path.join(root, "services", "class-service.ts"));
}

async function testClassIds() {
  const rows = await prisma.class.findMany({ where: { teacherId: TEACHER }, select: { id: true } });
  return rows.map((r) => r.id);
}

async function cleanup() {
  const ids = await testClassIds();
  await prisma.lecture.deleteMany({ where: { classId: { in: ids } } });
  await prisma.classSchedule.deleteMany({ where: { classId: { in: ids } } });
  await prisma.classFee.deleteMany({ where: { classId: { in: ids } } });
  await prisma.class.deleteMany({ where: { id: { in: ids } } });
  await prisma.teacher.deleteMany({ where: { id: TEACHER } });
}

const CLASS_INPUT = { name: `${PREFIX}Chemistry`, monthlyFee: 1500, paymentDueWeek: 1, startDate: "2026-12-01", schedules: [{ dayOfWeek: "MONDAY", startTime: "08:00", endTime: "10:00" }] };
const defaultsOf = (classId) => prisma.lecture.findMany({ where: { classId, isDefault: true } });

test.describe("default lecture on PostgreSQL", { skip }, () => {
  test.before(async () => {
    await cleanup();
    await prisma.$executeRaw`INSERT INTO "Teacher" ("id", "name", "email", "password") VALUES (${TEACHER}, 'Test', ${`${TEACHER}@example.test`}, 'x')`;
  });
  test.after(async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS dltest_fail_default ON "Lecture"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS dltest_fail_default()`);
    await cleanup();
    await prisma.$disconnect();
  });

  test("the column is NOT NULL DEFAULT false; the partial unique index is exactly the migration's", async () => {
    const [column] = await prisma.$queryRaw`SELECT is_nullable, column_default, data_type FROM information_schema.columns WHERE table_name = 'Lecture' AND column_name = 'isDefault'`;
    assert.deepEqual(column, { is_nullable: "NO", column_default: "false", data_type: "boolean" });
    const [index] = await prisma.$queryRaw`SELECT indexdef FROM pg_indexes WHERE tablename = 'Lecture' AND indexname = 'Lecture_one_default_per_class'`;
    assert.equal(index.indexdef, 'CREATE UNIQUE INDEX "Lecture_one_default_per_class" ON public."Lecture" USING btree ("classId") WHERE ("isDefault" = true)');
  });

  test("new class creation: the class and exactly one default lecture (valid columns)", async () => {
    const before = Date.now();
    const created = await classService.createClassForTeacher(TEACHER, CLASS_INPUT);
    const lectures = await prisma.lecture.findMany({ where: { classId: created.id } });
    assert.equal(lectures.length, 1);
    const [lecture] = lectures;
    assert.equal(lecture.isDefault, true);
    assert.equal(lecture.title, "General Notes");
    assert.equal(lecture.endDate, null);
    assert.equal(lecture.status, 0);
    assert.equal(lecture.classStatus, "SCHEDULED");
    assert.ok(Math.abs(lecture.date.getTime() - before) < 60_000, "the creation instant (real UTC)");
  });

  test("atomic: a failing default lecture INSERT rolls the class (schedules, fee) back", async () => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION dltest_fail_default() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dltest: default lecture refused'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER dltest_fail_default BEFORE INSERT ON "Lecture" FOR EACH ROW WHEN (NEW."isDefault") EXECUTE FUNCTION dltest_fail_default()`);
    const before = await testClassIds();
    try {
      await assert.rejects(classService.createClassForTeacher(TEACHER, { ...CLASS_INPUT, name: `${PREFIX}Rolled back` }), /dltest: default lecture refused/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS dltest_fail_default ON "Lecture"`);
    }
    assert.deepEqual((await testClassIds()).sort(), before.sort(), "no class left behind");
    assert.equal(await prisma.class.count({ where: { name: `${PREFIX}Rolled back` } }), 0);
  });

  test("the unique index: a second default lecture for one class is refused; other classes and normal lectures are unaffected", async () => {
    await prisma.$executeRaw`INSERT INTO "Class" ("id", "name", "teacherId") VALUES (${CLASS_A}, 'A', ${TEACHER}), (${CLASS_B}, 'B', ${TEACHER})`;
    await prisma.lecture.create({ data: { classId: CLASS_A, title: "General Notes", date: new Date(), isDefault: true } });
    await assert.rejects(prisma.lecture.create({ data: { classId: CLASS_A, title: "Another", date: new Date(), isDefault: true } }), (error) => error.code === "P2002");
    await assert.rejects(
      prisma.$executeRawUnsafe(`INSERT INTO "Lecture" ("id", "title", "date", "classId", "isDefault") VALUES ('${PREFIX}raw-${process.pid}', 'x', now(), '${CLASS_A}', true)`),
      /Lecture_one_default_per_class|23505|Unique constraint/
    );
    await prisma.lecture.create({ data: { classId: CLASS_B, title: "General Notes", date: new Date(), isDefault: true } });
    for (const title of ["Kinematics", "Optics"]) {
      const normal = await prisma.lecture.create({ data: { classId: CLASS_A, title, date: new Date() } });
      assert.equal(normal.isDefault, false, "normal lectures default to false");
    }
    await prisma.$executeRawUnsafe(`INSERT INTO "Lecture" ("id", "title", "date", "classId") VALUES ('${PREFIX}raw-normal-${process.pid}', 'Raw', now(), '${CLASS_A}')`);
    assert.equal((await prisma.lecture.findUnique({ where: { id: `${PREFIX}raw-normal-${process.pid}` } })).isDefault, false, "the column default (raw SQL)");
    assert.equal((await defaultsOf(CLASS_A)).length, 1);
    assert.equal((await defaultsOf(CLASS_B)).length, 1);
  });

  test("the manual backfill: one default lecture per existing class that lacks one; running it again changes nothing", async () => {
    const without = [`${PREFIX}old-1-${process.pid}`, `${PREFIX}old-2-${process.pid}`];
    for (const id of without) {
      // createdAt as UTC digits, exactly as Prisma's model API stores it (a bound JS Date would be
      // converted through the server's TimeZone into this timestamp-without-time-zone column).
      await prisma.$executeRaw`INSERT INTO "Class" ("id", "name", "teacherId", "createdAt", "status") VALUES (${id}, 'Old', ${TEACHER}, ${"2026-03-10 04:15:00"}::timestamp(3), ${id.includes("old-2") ? 1 : 0})`;
      await prisma.lecture.create({ data: { classId: id, title: "A normal lecture", date: new Date() } });
    }
    const script = fs.readFileSync(path.join(root, "docs", "sql", "default-lecture-backfill.sql"), "utf8");
    const insert = script.slice(script.indexOf("INSERT INTO"), script.indexOf(";", script.indexOf("INSERT INTO")));
    const run = () => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
      return tx.$executeRawUnsafe(insert);
    });

    const firstRun = await run();
    assert.ok(firstRun >= 2, "at least the two classes without one");
    for (const id of without) {
      const [lecture, ...more] = await defaultsOf(id);
      assert.equal(more.length, 0, "exactly one");
      assert.deepEqual(
        { title: lecture.title, endDate: lecture.endDate, status: lecture.status, classStatus: lecture.classStatus, date: lecture.date.toISOString() },
        { title: "General Notes", endDate: null, status: 0, classStatus: "SCHEDULED", date: "2026-03-10T04:15:00.000Z" },
        "dated at the class's creation instant (deactivated classes included)"
      );
      assert.ok(Math.abs(lecture.createdAt.getTime() - Date.now()) < 120_000, "createdAt: now, as UTC digits");
      assert.equal(await prisma.lecture.count({ where: { classId: id, isDefault: false } }), 1, "existing lectures untouched");
    }
    assert.equal((await defaultsOf(CLASS_A)).length, 1, "a class that already had one is skipped");

    assert.equal(await run(), 0, "idempotent: nothing inserted the second time");
    const [{ missing }] = await prisma.$queryRaw`SELECT count(*)::int AS missing FROM "Class" c WHERE NOT EXISTS (SELECT 1 FROM "Lecture" l WHERE l."classId" = c."id" AND l."isDefault")`;
    assert.equal(missing, 0, "every class has one");
  });
});
