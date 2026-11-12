/*
 * The session-start lecture lock (services/session-service.ts
 * createSessionUnderLectureLock) against a REAL, THROWAWAY PostgreSQL: row
 * lock conflicts, READ COMMITTED visibility and rollback only exist there.
 *
 *   SESSION_START_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55433/sessionstart_test npm run test:session-start-db
 *
 * The database must already contain the project schema (all migrations).
 * Safety: the whole file is SKIPPED unless SESSION_START_TEST_DATABASE_URL is
 * set, and refuses any host other than localhost / 127.0.0.1 and any database
 * whose name does not contain "test". DATABASE_URL is overwritten before
 * Prisma loads, so the project's .env database is never used. Every row it
 * creates has the "sstest-" id prefix and is deleted afterwards, together
 * with the test triggers it installs.
 *
 * "Finalization" is the planned protocol (it does not exist yet): in one
 * transaction, SELECT ... FOR SHARE on the lecture, then (a later statement)
 * check there is no active session, then commit.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const url = process.env.SESSION_START_TEST_DATABASE_URL;
let skip = "set SESSION_START_TEST_DATABASE_URL to a throwaway local database to run these tests";
if (url) {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("Refusing to run: SESSION_START_TEST_DATABASE_URL must point at localhost.");
  }
  if (!/test/i.test(dbName)) {
    throw new Error('Refusing to run: the test database name must contain "test".');
  }
  skip = false;
  process.env.DATABASE_URL = url; // before Prisma loads: .env never overrides it
}

const PREFIX = "sstest-";
const TEACHER = `${PREFIX}teacher-${process.pid}`;
const CLASS = `${PREFIX}class-${process.pid}`;
const LECTURE = `${PREFIX}lecture-${process.pid}`;

let prisma;
let service;

if (!skip) {
  require("../helpers/server-only.cjs");
  require("tsx/cjs/api").register();
  const root = path.resolve(__dirname, "..", "..");

  // Only network / background edges are faked; Prisma is real.
  const fake = (relativePath, exports) => {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);
    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
  };
  fake("lib/youtube-feature-lifecycle.ts", {
    endYouTubeFeaturesForLecture: async () => ({ status: "none", closed: 0 }),
    reconcileYouTubeFeaturesForNewSession: async () => ({ status: "none", closed: 0 }),
  });
  fake("services/fee-waiver-events.ts", { recalculateAfterLectureChange: async () => {} });
  fake("lib/mailer.ts", { buildLiveSessionInviteLoginLink: () => "", sendLiveSessionInviteEmail: async () => {} });
  fake("lib/jitsi-auth.ts", { generateJitsiToken: async () => "token" });

  ({ prisma } = require(path.join(root, "lib", "prisma.ts")));
  service = require(path.join(root, "services", "session-service.ts"));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function dropTriggers() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS sstest_slow_session_insert ON "ClassSession"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS sstest_slow_session_insert()`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS sstest_fail_lecture_live ON "Lecture"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS sstest_fail_lecture_live()`);
}

async function cleanup() {
  await dropTriggers();
  await prisma.$executeRaw`DELETE FROM "ClassSession" WHERE "classId" LIKE ${PREFIX + "%"}`;
  await prisma.$executeRaw`DELETE FROM "Lecture" WHERE "id" LIKE ${PREFIX + "%"}`;
  await prisma.$executeRaw`DELETE FROM "Class" WHERE "id" LIKE ${PREFIX + "%"}`;
  await prisma.$executeRaw`DELETE FROM "Teacher" WHERE "id" LIKE ${PREFIX + "%"}`;
}

async function resetFixtures() {
  await dropTriggers();
  await prisma.$executeRaw`DELETE FROM "ClassSession" WHERE "classId" = ${CLASS}`;
  await prisma.$executeRaw`UPDATE "Lecture" SET "classStatus" = 'SCHEDULED', "status" = 0 WHERE "id" = ${LECTURE}`;
}

const activeSessions = () =>
  prisma.classSession.count({ where: { lectureId: LECTURE, isActive: true } });

/**
 * The planned finalization: FOR SHARE, check, wait for `beforeCommit`, then
 * record how many active sessions are committed right before committing.
 */
async function finalize({ beforeCommit } = {}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Lecture" WHERE "id" = ${LECTURE} FOR SHARE`;
    const [{ count: atCheck }] = await tx.$queryRaw`
      SELECT count(*)::int AS count FROM "ClassSession" WHERE "lectureId" = ${LECTURE} AND "isActive" = true`;
    if (atCheck > 0) return { finalized: false, atCheck };
    if (beforeCommit) await beforeCommit();
    const [{ count: atCommit }] = await tx.$queryRaw`
      SELECT count(*)::int AS count FROM "ClassSession" WHERE "lectureId" = ${LECTURE} AND "isActive" = true`;
    return { finalized: true, atCheck, atCommit };
  }, { maxWait: 5_000, timeout: 30_000 });
}

const start = () => service.startClassSessionForTeacher(TEACHER, CLASS, LECTURE);

test.describe("session start lecture lock (real PostgreSQL)", { skip }, () => {
  test.before(async () => {
    await cleanup();
    await prisma.$executeRaw`
      INSERT INTO "Teacher" ("id", "name", "email", "password") VALUES (${TEACHER}, ${TEACHER}, ${TEACHER + "@example.test"}, 'x')`;
    await prisma.$executeRaw`
      INSERT INTO "Class" ("id", "name", "teacherId") VALUES (${CLASS}, 'Session start test', ${TEACHER})`;
    await prisma.$executeRaw`
      INSERT INTO "Lecture" ("id", "title", "date", "classId") VALUES (${LECTURE}, 'Lock test', now(), ${CLASS})`;
  });
  test.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  test.beforeEach(resetFixtures);

  test("start: one session, lecture LIVE", async () => {
    const result = await start();

    assert.equal(result.session.lectureId, LECTURE);
    assert.equal(await activeSessions(), 1);
    const lecture = await prisma.lecture.findUnique({ where: { id: LECTURE }, select: { classStatus: true } });
    assert.equal(lecture.classStatus, "LIVE");
  });

  test("finalization first: the start waits; no session is committed before finalization commits", async () => {
    const hold = deferred();
    const finalization = finalize({ beforeCommit: () => hold.promise });
    await sleep(300); // finalization holds FOR SHARE and has checked

    const starting = start();
    await sleep(700);
    assert.equal(await activeSessions(), 0, "the start is blocked on the lecture lock");

    hold.resolve();
    const finalized = await finalization;
    await starting;

    assert.equal(finalized.finalized, true);
    assert.equal(finalized.atCheck, 0);
    assert.equal(finalized.atCommit, 0, "no session appeared between the check and the commit");
    assert.equal(await activeSessions(), 1, "the start completes after finalization");
  });

  test("start first: finalization waits, then its check sees the session and refuses", async () => {
    // Slow down the session INSERT so the start holds the lecture lock a while.
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION sstest_slow_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."classId" LIKE 'sstest-%' THEN PERFORM pg_sleep(1.5); END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER sstest_slow_session_insert BEFORE INSERT ON "ClassSession"
      FOR EACH ROW EXECUTE FUNCTION sstest_slow_session_insert()`);

    const starting = start();
    await sleep(500); // the start holds FOR NO KEY UPDATE and sleeps in its INSERT
    const finalized = await finalize();
    await starting;

    assert.equal(finalized.finalized, false);
    assert.equal(finalized.atCheck, 1);
  });

  test("control: a bare INSERT (the pre-fix order) is NOT blocked by finalization's FOR SHARE", async () => {
    const hold = deferred();
    const finalization = finalize({ beforeCommit: () => hold.promise });
    await sleep(300);

    // Its foreign key takes only FOR KEY SHARE on the lecture.
    await prisma.classSession.create({
      data: { classId: CLASS, lectureId: LECTURE, roomName: `${PREFIX}control-${Date.now()}`, jitsiDomain: "meet.jit.si", isActive: true },
    });

    hold.resolve();
    const finalized = await finalization;
    assert.equal(finalized.finalized, true);
    assert.equal(finalized.atCommit, 1, "without the lecture lock a session slips in before the commit");
  });

  test("rollback: a failing LIVE update leaves no session row", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION sstest_fail_lecture_live() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."id" LIKE 'sstest-%' AND NEW."classStatus" = 'LIVE' THEN
          RAISE EXCEPTION 'sstest: simulated failure';
        END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER sstest_fail_lecture_live BEFORE UPDATE ON "Lecture"
      FOR EACH ROW EXECUTE FUNCTION sstest_fail_lecture_live()`);

    await assert.rejects(start());

    assert.equal(await activeSessions(), 0);
    const lecture = await prisma.lecture.findUnique({ where: { id: LECTURE }, select: { classStatus: true } });
    assert.equal(lecture.classStatus, "SCHEDULED");
  });

  test("lock timeout: a lecture held longer than the lock timeout gives 409 LECTURE_BUSY", async () => {
    const hold = deferred();
    const finalization = finalize({ beforeCommit: () => hold.promise });
    await sleep(300);

    await assert.rejects(start(), (error) => error.statusCode === 409 && error.code === "LECTURE_BUSY");
    assert.equal(await activeSessions(), 0);

    hold.resolve();
    await finalization;
  });
});
