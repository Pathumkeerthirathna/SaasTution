/*
 * Student access (lib/breakout-activities/student-access.ts): an active
 * session and an active, enrolled student (status 0, active ClassStudent);
 * every other case is the same 404 NOT_FOUND (approved decision D2), also
 * when the session ends or the enrolment goes away between the check and the
 * lock. The in-memory fake database answers the queries; no database is
 * contacted.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const access = require(path.join(root, "lib/breakout-activities/student-access.ts"));
const { runBreakoutTransaction } = require(path.join(root, "lib/breakout-activities/locks.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));
const { createFakeBreakoutDb } = require("./helpers/fake-breakout-db.cjs");

const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";
const S2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const S3 = "1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b";
const ST = "a1111111-1111-4111-8111-111111111111";
const OTHER = "a2222222-2222-4222-8222-222222222222";

function seed() {
  const db = createFakeBreakoutDb();
  db.tables.class.push({ id: "class-1", teacherId: "t1" }, { id: "class-2", teacherId: "t1" });
  db.tables.classSession.push(
    { id: S1, classId: "class-1", isActive: true },
    { id: S2, classId: "class-2", isActive: true },
    { id: S3, classId: "class-1", isActive: false }
  );
  db.tables.student.push({ id: ST, status: 0 }, { id: OTHER, status: 0 });
  db.tables.classStudent.push({ studentId: ST, classId: "class-1", isActive: true }, { studentId: OTHER, classId: "class-1", isActive: false });
  return db;
}

const notFound = (e) => {
  assert.ok(e instanceof AppError, String(e?.stack ?? e));
  assert.equal(e.statusCode, 404);
  assert.equal(e.code, "NOT_FOUND");
  assert.equal(e.message, "Not found.", "the same message for every case");
  return true;
};

test("an enrolled student in an active session: access granted", async () => {
  const db = seed();
  assert.deepEqual(await access.requireEnrolledStudentSessionAccess(db.client, ST, S1), { sessionId: S1, classId: "class-1" });
  assert.deepEqual(await access.requireEnrolledStudentSessionAccess(db.client, ST, S1.toUpperCase()), { sessionId: S1, classId: "class-1" });
});

test("D2: missing, ended, other class, inactive enrolment, inactive student, bad ids: all the same 404", async () => {
  const db = seed();
  db.tables.student.push({ id: "a3333333-3333-4333-8333-333333333333", status: 1 });
  db.tables.classStudent.push({ studentId: "a3333333-3333-4333-8333-333333333333", classId: "class-1", isActive: true });
  const cases = [
    [ST, "f0000000-0000-4000-8000-000000000000", "missing session"],
    [ST, S3, "ended session"],
    [ST, S2, "not enrolled in that class"],
    [OTHER, S1, "enrolment no longer active"],
    ["a3333333-3333-4333-8333-333333333333", S1, "student inactive (status 1)"],
    ["f1111111-1111-4111-8111-111111111111", S1, "unknown student"],
    [ST, "not-a-uuid", "invalid session id"],
    ["", S1, "no student id"],
    [undefined, S1, "no student id"],
  ];
  for (const [studentId, sessionId, label] of cases) {
    await assert.rejects(access.requireEnrolledStudentSessionAccess(db.client, studentId, sessionId), notFound, label);
  }
});

test("write lock: access first, then FOR KEY SHARE on the session, then enrolment again; inside a transaction only", async () => {
  const db = seed();
  const lock = await runBreakoutTransaction(db.client, (tx) => access.lockEnrolledActiveSession(tx, ST, S1));
  assert.deepEqual({ ...lock }, { id: S1, classId: "class-1", isActive: true });
  const txCalls = db.calls.filter((c) => c.tx === db.lastTx());
  const order = txCalls.map((c) => (c.kind === "raw" ? c.sql : `${c.model}.${c.method}`));
  assert.deepEqual(order, [
    "classSession.findFirst",
    "student.findFirst",
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ? FOR KEY SHARE',
    "student.findFirst",
  ]);
  await assert.rejects(access.lockEnrolledActiveSession(db.client, ST, S1), /inside an interactive transaction/);
});

test("write lock: failures are the same 404 (never SESSION_NOT_ACTIVE), nothing else is sent", async () => {
  const db = seed();
  for (const [studentId, sessionId] of [[ST, S3], [ST, S2], [OTHER, S1]]) {
    await assert.rejects(runBreakoutTransaction(db.client, (tx) => access.lockEnrolledActiveSession(tx, studentId, sessionId)), notFound);
    assert.equal(db.calls.filter((c) => c.tx === db.lastTx() && c.kind === "raw").length, 0, "refused before any lock");
  }
});

test("race: the session ends between the check and the lock -> 404, not 409", async () => {
  const db = seed();
  await assert.rejects(
    runBreakoutTransaction(
      {
        $transaction: (fn, options) =>
          db.client.$transaction(async (tx) => {
            const wrapped = { ...tx, classSession: { ...tx.classSession, findFirst: async (args) => {
              const row = await tx.classSession.findFirst(args);
              db.tables.classSession.find((s) => s.id === S1).isActive = false; // ends right after the check
              return row;
            } } };
            return fn(wrapped);
          }, options),
      },
      (tx) => access.lockEnrolledActiveSession(tx, ST, S1)
    ),
    notFound
  );
});

test("race: the enrolment is removed between the check and the lock -> 404", async () => {
  const db = seed();
  let checks = 0;
  await assert.rejects(
    runBreakoutTransaction(
      {
        $transaction: (fn, options) =>
          db.client.$transaction(async (tx) => {
            const wrapped = { ...tx, student: { ...tx.student, findFirst: async (args) => {
              checks += 1;
              const row = await tx.student.findFirst(args);
              if (checks === 1) db.tables.classStudent[0].isActive = false; // unenrolled after the first check
              return row;
            } } };
            return fn(wrapped);
          }, options),
      },
      (tx) => access.lockEnrolledActiveSession(tx, ST, S1)
    ),
    notFound
  );
  assert.equal(checks, 2, "enrolment checked again on the locked session");
});
