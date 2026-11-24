/*
 * The Attendance page's lecture creation
 * (services/attendance-lecture-create-service.ts) against a REAL, THROWAWAY
 * PostgreSQL: the advisory lock, lock_timeout, READ COMMITTED visibility,
 * rollback and Prisma's transaction timeout only exist there.
 *
 *   ATTENDANCE_LECTURE_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55434/slc_attendance_test npm run test:attendance-lecture-db
 *
 * The database must already contain the project schema. Safety: the whole
 * file is SKIPPED unless ATTENDANCE_LECTURE_TEST_DATABASE_URL is set, and
 * refuses any host other than localhost / 127.0.0.1 and any database whose
 * name does not contain "test". DATABASE_URL is overwritten before Prisma
 * loads, so the project's .env database is never used. Every row it creates
 * has the "alctest-" id prefix (lectures: that class) and is deleted
 * afterwards.
 *
 * Remote latency is imitated by a local TCP proxy that delays every packet
 * (half the round trip each way): at a 700 ms round trip each statement
 * costs about 1.4 s, as on the remote, pooled testing database where the
 * original P2028 (5 s default timeout) happened.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const Module = require("node:module");

const url = process.env.ATTENDANCE_LECTURE_TEST_DATABASE_URL;
let skip = "set ATTENDANCE_LECTURE_TEST_DATABASE_URL to a throwaway local database to run these tests";
let target = null;
if (url) {
  target = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(target.hostname)) {
    throw new Error("Refusing to run: ATTENDANCE_LECTURE_TEST_DATABASE_URL must point at localhost.");
  }
  if (!/test/i.test(target.pathname.replace(/^\//, ""))) {
    throw new Error('Refusing to run: the test database name must contain "test".');
  }
  skip = false;
}

// ---- Latency proxy: the service's Prisma connects through it -----------------------------------------

let rttMs = 0;
const PROXY_PORT = 56100 + (process.pid % 500);
function delayedPipe(from, to) {
  let chain = Promise.resolve();
  from.on("data", (chunk) => {
    const delay = rttMs / 2;
    chain = chain.then(() => (delay ? new Promise((resolve) => setTimeout(resolve, delay)) : null)).then(() => to.write(chunk));
  });
  from.on("end", () => chain.then(() => to.end()));
  from.on("error", () => to.destroy());
}
const proxy = net.createServer((socket) => {
  const upstream = net.connect(Number(target.port || 5432), target.hostname);
  delayedPipe(socket, upstream);
  delayedPipe(upstream, socket);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

const PREFIX = "alctest-";
const TEACHER = `${PREFIX}teacher-${process.pid}`;
const OTHER_TEACHER = `${PREFIX}other-${process.pid}`;
const CLASS = `${PREFIX}class-${process.pid}`;

let prisma; // the service's client (through the proxy)
let direct; // test set-up and checks (no proxy)
let service;
const emitted = [];

if (!skip) {
  const proxied = new URL(url);
  proxied.port = String(PROXY_PORT);
  process.env.DATABASE_URL = proxied.toString(); // before Prisma loads: .env never overrides it

  require("../helpers/server-only.cjs");
  require("tsx/cjs/api").register();
  const root = path.resolve(__dirname, "..", "..");
  const fake = (relativePath, exports) => {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);
    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
  };
  // Only the live-update edge is faked (recorded); Prisma is real.
  fake("lib/session-events.ts", { emitStudentDataChange: (event) => emitted.push({ ...event, at: Date.now() }), emitLiveChange: () => {} });
  fake("services/fee-waiver-events.ts", { readLectureWaiverState: async () => null, recalculateAfterLectureChange: async () => {} });

  ({ prisma } = require(path.join(root, "lib", "prisma.ts")));
  const { PrismaClient } = require("@prisma/client");
  direct = new PrismaClient({ datasourceUrl: url });
  service = require(path.join(root, "services", "attendance-lecture-create-service.ts"));
}

const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60_000);
const input = (over = {}) => ({
  classId: CLASS,
  title: "Physics – 23 Nov 2026",
  date: sl("2026-11-23T09:00"),
  endDate: sl("2026-11-23T11:00"),
  allowAdditionalSession: false,
  ...over,
});
const lectureCount = () => direct.lecture.count({ where: { classId: CLASS } });

async function cleanLectures() {
  await direct.lecture.deleteMany({ where: { classId: CLASS } });
  emitted.length = 0;
  rttMs = 0;
}

test.before(async () => {
  if (skip) return;
  await new Promise((resolve) => proxy.listen(PROXY_PORT, "127.0.0.1", resolve));
  for (const id of [TEACHER, OTHER_TEACHER]) {
    await direct.$executeRaw`INSERT INTO "Teacher" ("id", "name", "email", "password") VALUES (${id}, 'Test', ${`${id}@example.test`}, 'x') ON CONFLICT DO NOTHING`;
  }
  await direct.$executeRaw`INSERT INTO "Class" ("id", "name", "teacherId") VALUES (${CLASS}, 'Physics', ${TEACHER}) ON CONFLICT DO NOTHING`;
});

test.after(async () => {
  if (skip) return;
  await direct.lecture.deleteMany({ where: { classId: CLASS } });
  await direct.$executeRaw`DELETE FROM "Class" WHERE "id" = ${CLASS}`;
  await direct.$executeRaw`DELETE FROM "Teacher" WHERE "id" IN (${TEACHER}, ${OTHER_TEACHER})`;
  await prisma.$disconnect();
  await direct.$disconnect();
  await new Promise((resolve) => proxy.close(resolve));
});

test("a creation whose transaction takes longer than 5 s succeeds (700 ms round trips); the event follows the commit", { skip, timeout: 60_000 }, async () => {
  await cleanLectures();
  await prisma.$queryRaw`SELECT 1`; // connection set-up is not transaction time
  rttMs = 700;
  const started = Date.now();
  const created = await service.createAttendanceLectureForTeacher(TEACHER, input());
  const finished = Date.now();
  rttMs = 0;
  assert.ok(finished - started > 5_000, `the transaction ran ${finished - started} ms (must exceed Prisma's old 5 s default)`);
  assert.equal(await lectureCount(), 1);
  assert.equal(created.class.id, CLASS);
  assert.equal(emitted.length, 1, "emitted once, after the transaction returned (the order is pinned in attendance-take.test.cjs)");
  const row = await direct.lecture.findUnique({ where: { id: created.id } });
  assert.equal(row.date.toISOString(), sl("2026-11-23T09:00").toISOString());
});

test("concurrent overlapping requests (real advisory lock, 200 ms round trips): exactly one lecture, the other 409", { skip, timeout: 60_000 }, async () => {
  await cleanLectures();
  rttMs = 200;
  const results = await Promise.allSettled([
    service.createAttendanceLectureForTeacher(TEACHER, input()),
    service.createAttendanceLectureForTeacher(TEACHER, input()),
    service.createAttendanceLectureForTeacher(TEACHER, input({ date: sl("2026-11-23T10:00"), endDate: sl("2026-11-23T12:00") })),
  ]);
  rttMs = 0;
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(results.map((r) => r.status)));
  for (const r of results.filter((x) => x.status === "rejected")) assert.equal(r.reason.code, "ATTENDANCE_LECTURE_EXISTS");
  assert.equal(await lectureCount(), 1);
  assert.equal(emitted.length, 1, "only the committed creation emits");
});

test("a duplicate is 409 (nothing created, no event); a confirmed additional session is created", { skip, timeout: 60_000 }, async () => {
  await cleanLectures();
  await service.createAttendanceLectureForTeacher(TEACHER, input());
  emitted.length = 0;
  await assert.rejects(service.createAttendanceLectureForTeacher(TEACHER, input()), (error) => error.statusCode === 409 && error.code === "ATTENDANCE_LECTURE_EXISTS");
  assert.equal(await lectureCount(), 1);
  assert.equal(emitted.length, 0);
  await service.createAttendanceLectureForTeacher(TEACHER, input({ allowAdditionalSession: true }));
  assert.equal(await lectureCount(), 2);
  assert.equal(emitted.length, 1);
  // Another time of the day is never blocked.
  await service.createAttendanceLectureForTeacher(TEACHER, input({ date: sl("2026-11-23T14:00"), endDate: sl("2026-11-23T16:00") }));
  assert.equal(await lectureCount(), 3);
});

test("a held (class, day) lock: the waiter stops at lock_timeout with 409 ATTENDANCE_BUSY, nothing created, no event", { skip, timeout: 60_000 }, async () => {
  await cleanLectures();
  const key = service.attendanceLectureLockKey(CLASS, "2026-11-23");
  let releaseHolder;
  const holderDone = direct.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      await new Promise((resolve) => (releaseHolder = resolve));
    },
    { timeout: 60_000 }
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const started = Date.now();
  await assert.rejects(service.createAttendanceLectureForTeacher(TEACHER, input()), (error) => error.statusCode === 409 && error.code === "ATTENDANCE_BUSY");
  const waited = Date.now() - started;
  releaseHolder();
  await holderDone;
  assert.ok(waited >= service.ATTENDANCE_LECTURE_LOCK_TIMEOUT_MS - 200 && waited < service.ATTENDANCE_LECTURE_TRANSACTION_OPTIONS.timeout, `waited ${waited} ms`);
  assert.equal(await lectureCount(), 0);
  assert.equal(emitted.length, 0);
});

test("a short hold: the waiter gets the lock and sees the holder's committed lecture (409 EXISTS), not BUSY", { skip, timeout: 60_000 }, async () => {
  await cleanLectures();
  const key = service.attendanceLectureLockKey(CLASS, "2026-11-23");
  const holderDone = direct.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      await tx.lecture.create({ data: { classId: CLASS, title: "First", date: sl("2026-11-23T09:00"), endDate: sl("2026-11-23T11:00") } });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    },
    { timeout: 60_000 }
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(service.createAttendanceLectureForTeacher(TEACHER, input()), (error) => error.code === "ATTENDANCE_LECTURE_EXISTS");
  await holderDone;
  assert.equal(await lectureCount(), 1);
});

test("another teacher's class: 404 CLASS_NOT_FOUND, nothing created, no event", { skip, timeout: 60_000 }, async () => {
  await cleanLectures();
  await assert.rejects(service.createAttendanceLectureForTeacher(OTHER_TEACHER, input()), (error) => error.statusCode === 404 && error.code === "CLASS_NOT_FOUND");
  assert.equal(await lectureCount(), 0);
  assert.equal(emitted.length, 0);
});

test("lock_timeout is transaction-local: it never leaks to the pooled connection after the commit", { skip, timeout: 60_000 }, async () => {
  await cleanLectures();
  const single = new (require("@prisma/client").PrismaClient)({ datasourceUrl: `${url}${url.includes("?") ? "&" : "?"}connection_limit=1` });
  try {
    await single.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"alctest-leak"}, 0)) FROM (SELECT set_config('lock_timeout', '8000ms', true) OFFSET 0) AS bounded`;
      const inside = await tx.$queryRaw`SELECT current_setting('lock_timeout') AS v`;
      assert.equal(inside[0].v, "8s");
    });
    const after = await single.$queryRaw`SELECT current_setting('lock_timeout') AS v`;
    assert.equal(after[0].v, "0");
  } finally {
    await single.$disconnect();
  }
});
