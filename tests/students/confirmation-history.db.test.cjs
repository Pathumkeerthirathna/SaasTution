/*
 * Approval decisions and StudentConfirmationHistory against a REAL, THROWAWAY
 * PostgreSQL: row locks, READ COMMITTED re-checks, the CHECK constraints and
 * the append-only trigger only exist there.
 *
 *   CONFIRMATION_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55433/confirmation_test npm run test:confirmation-db
 *
 * Not run by default (npm run test:confirmation does not include it). The
 * database must be a throwaway local one that already has the project schema,
 * including migration 20261110130000_add_student_confirmation_history (for
 * example: createdb confirmation_test, then
 * DATABASE_URL=<that url> npx prisma migrate deploy — with that URL set
 * explicitly in the shell, never the project's .env database).
 *
 * Safety: the whole file is SKIPPED unless CONFIRMATION_TEST_DATABASE_URL is
 * set, and refuses any host other than localhost / 127.0.0.1 and any database
 * whose name does not contain "test". DATABASE_URL is overwritten before
 * Prisma loads, so the project's .env database is never used. Every row it
 * creates has the "cftest-" id prefix and is removed afterwards (history rows
 * by briefly disabling the append-only trigger inside one transaction, which
 * only the table owner can do — another reason to use a throwaway database).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const url = process.env.CONFIRMATION_TEST_DATABASE_URL;
let skip = "set CONFIRMATION_TEST_DATABASE_URL to a throwaway local database to run these tests";
if (url) {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("Refusing to run: CONFIRMATION_TEST_DATABASE_URL must point at localhost.");
  }
  if (!/test/i.test(dbName)) {
    throw new Error('Refusing to run: the test database name must contain "test".');
  }
  skip = false;
  process.env.DATABASE_URL = url; // before Prisma loads: .env never overrides it
}

const PREFIX = "cftest-";
const TEACHER = `${PREFIX}teacher-${process.pid}`;

let prisma;
let service;
let history;

if (!skip) {
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
  // Only the background fee-waiver recalculation is faked; Prisma is real.
  fake("services/fee-waiver-events.ts", { recalculateAfterStudentDecision: async () => {} });

  ({ prisma } = require(path.join(root, "lib", "prisma.ts")));
  service = require(path.join(root, "services", "student-service.ts"));
  history = require(path.join(root, "lib", "student-confirmation-history.ts"));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "StudentConfirmationHistory" DISABLE TRIGGER "StudentConfirmationHistory_no_update_delete"`);
    await tx.$executeRaw`DELETE FROM "StudentConfirmationHistory" WHERE "studentId" LIKE ${PREFIX + "%"}`;
    await tx.$executeRawUnsafe(`ALTER TABLE "StudentConfirmationHistory" ENABLE TRIGGER "StudentConfirmationHistory_no_update_delete"`);
  });
  await prisma.$executeRaw`DELETE FROM "Student" WHERE "id" LIKE ${PREFIX + "%"}`;
  await prisma.$executeRaw`DELETE FROM "Teacher" WHERE "id" LIKE ${PREFIX + "%"}`;
}

let seq = 0;
async function student(over = {}) {
  seq += 1;
  const id = `${PREFIX}s${seq}-${process.pid}`;
  const s = { status: 0, confirmationStatus: "PENDING", ...over };
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Student" ("id", "name", "teacherId", "contact", "status", "confirmationStatus") VALUES ($1, $1, $2, '', $3, $4::"StudentConfirmationStatus")`,
    id,
    TEACHER,
    s.status,
    s.confirmationStatus
  );
  return id;
}

const historyOf = (studentId) =>
  prisma.studentConfirmationHistory.findMany({ where: { studentId }, orderBy: [{ decidedAt: "asc" }, { id: "asc" }] });

async function assertTruthfulChain(studentId) {
  const s = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
    select: { confirmationStatus: true, confirmedAt: true, approvedAt: true },
  });
  // A test value: the chain checks do not depend on the feature start.
  const context = { approvalFeatureStartedAt: new Date("2026-07-28T00:00:00.000Z") };
  assert.notEqual(history.confirmationTimeline(s, await historyOf(studentId), context), null);
}

/** Holds FOR NO KEY UPDATE on a student until `release` resolves; `then` runs before the commit. */
function holdLock(studentId, release, then = async () => {}) {
  const locked = deferred();
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Student" WHERE "id" = ${studentId} FOR NO KEY UPDATE`;
      locked.resolve();
      await release;
      await then(tx);
    },
    { maxWait: 5000, timeout: 30000 }
  );
  return { locked: locked.promise, done };
}

/** Resolves once `count` backends wait on a lock held by this test. */
async function untilWaiting(count) {
  for (let i = 0; i < 100; i += 1) {
    const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
    if (n >= count) return;
    await sleep(20);
  }
  assert.fail(`expected ${count} backend(s) waiting on a lock`);
}

const appError = (status, code) => (error) => error.name === "AppError" && error.statusCode === status && error.code === code;

test("confirmation history against real PostgreSQL", { skip }, async (t) => {
  await cleanup();
  await prisma.$executeRaw`INSERT INTO "Teacher" ("id", "name", "email", "password") VALUES (${TEACHER}, ${TEACHER}, ${TEACHER + "@example.test"}, 'x')`;
  t.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  await t.test("CHECK constraints refuse untruthful rows; the trigger refuses UPDATE / DELETE", async () => {
    const id = await student();
    const base = { studentId: id, decidedByTeacherId: TEACHER, decidedAt: new Date(), previousConfirmedAt: null };
    const bad = [
      { ...base, fromStatus: "APPROVED", toStatus: "APPROVED", source: "INDIVIDUAL" },
      { ...base, fromStatus: "APPROVED", toStatus: "PENDING", source: "INDIVIDUAL" },
      { ...base, fromStatus: "PENDING", toStatus: "APPROVED", source: "BULK", batchId: null },
      { ...base, fromStatus: "PENDING", toStatus: "APPROVED", source: "INDIVIDUAL", batchId: "x" },
      { ...base, fromStatus: "PENDING", toStatus: "REJECTED", source: "BULK", batchId: "x" },
      { ...base, fromStatus: "PENDING", toStatus: "APPROVED", source: "INDIVIDUAL", previousConfirmedAt: base.decidedAt },
    ];
    for (const data of bad) {
      await assert.rejects(prisma.studentConfirmationHistory.create({ data }), /check constraint/i, JSON.stringify(data));
    }

    await service.confirmStudent(TEACHER, id);
    const [row] = await historyOf(id);
    await assert.rejects(prisma.$executeRaw`UPDATE "StudentConfirmationHistory" SET "batchId" = 'x' WHERE "id" = ${row.id}`, /append-only/);
    await assert.rejects(prisma.$executeRaw`DELETE FROM "StudentConfirmationHistory" WHERE "id" = ${row.id}`, /append-only/);
    await assert.rejects(prisma.$executeRaw`DELETE FROM "Student" WHERE "id" = ${id}`, /foreign key/i, "RESTRICT");
  });

  await t.test("opposite decisions queued behind a lock run one after the other; history stays a true chain", async () => {
    const id = await student();
    const release = deferred();
    const holder = holdLock(id, release.promise);
    await holder.locked;
    const approve = service.confirmStudent(TEACHER, id);
    await untilWaiting(1);
    const decline = service.declineStudent(TEACHER, id);
    await untilWaiting(2);
    release.resolve();
    await holder.done;
    const results = await Promise.allSettled([approve, decline]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
    const rows = await historyOf(id);
    assert.equal(rows.length, 2);
    await assertTruthfulChain(id);
  });

  await t.test("a lock held longer than 3 s: 409 STUDENT_DECISION_BUSY, nothing written", async () => {
    const id = await student();
    const release = deferred();
    const holder = holdLock(id, release.promise);
    await holder.locked;
    await assert.rejects(service.confirmStudent(TEACHER, id), appError(409, "STUDENT_DECISION_BUSY"));
    release.resolve();
    await holder.done;
    assert.equal((await historyOf(id)).length, 0);
    const s = await prisma.student.findUniqueOrThrow({ where: { id } });
    assert.equal(s.confirmationStatus, "PENDING");
  });

  await t.test("bulk waits for a student being declined, then skips it (no approvedAt); inactive students untouched", async () => {
    const a = await student();
    const b = await student();
    const inactive = await student({ status: 1 });
    const release = deferred();
    const holder = holdLock(b, release.promise, (tx) =>
      tx.$executeRaw`UPDATE "Student" SET "confirmationStatus" = 'REJECTED', "confirmedAt" = now() WHERE "id" = ${b}`
    );
    await holder.locked;
    const bulk = service.confirmAllPendingStudents(TEACHER);
    await untilWaiting(1);
    release.resolve();
    await holder.done;
    const count = await bulk;

    assert.ok(count >= 1);
    const rows = await prisma.student.findMany({ where: { id: { in: [a, b, inactive] } } });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[a].confirmationStatus, "APPROVED");
    assert.equal(byId[b].confirmationStatus, "REJECTED");
    assert.equal(byId[b].approvedAt, null);
    assert.equal(byId[inactive].confirmationStatus, "PENDING");
    assert.equal((await historyOf(b)).length, 0);
    assert.equal((await historyOf(a))[0].source, "BULK");
  });
});
