/*
 * Student quiz service, read paths (services/breakout-student-quiz-service.ts,
 * Stage 3.2.1): the default resolver failing closed, enrolment / session (D2),
 * room matching (D6), metadata only without an attempt (Q1, also when
 * CLOSED), the questions without answer keys with an attempt, the score only
 * before CLOSED and the review after it, raw grading never sent, other
 * students' attempts never used, and no writes from reads. Also the fake
 * database's createMany({ skipDuplicates }) for the later start step.
 *
 * Real service module; lib/prisma.ts is an in-memory fake, lib/server-clock.ts
 * a fixed clock, the room resolver injected. No database is contacted.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeBreakoutDb } = require("./helpers/fake-breakout-db.cjs");

let db;
let clock = new Date("2026-11-06T09:00:00.000Z");
function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
fake("lib/prisma.ts", { prisma: new Proxy({}, { get: (_, key) => db.client[key] }) });
fake("lib/server-clock.ts", { serverNow: async () => new Date(clock), serverNowSync: () => new Date(clock), resetServerClock() {} });

const service = require(path.join(root, "services/breakout-student-quiz-service.ts"));
const v = require(path.join(root, "lib/breakout-activities/validation.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";
const S2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const S3 = "1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b";
const ST1 = "a1111111-1111-4111-8111-111111111111"; // MAIN
const ST2 = "a2222222-2222-4222-8222-222222222222"; // room r1
const ST3 = "a3333333-3333-4333-8333-333333333333"; // not enrolled
const Q = {
  MAIN: "d0000000-0000-4000-8000-000000000001",
  R1: "d0000000-0000-4000-8000-000000000002",
  DRAFT: "d0000000-0000-4000-8000-000000000003",
  CLOSED: "d0000000-0000-4000-8000-000000000004",
  DELETED: "d0000000-0000-4000-8000-000000000005",
  OTHER_SESSION: "d0000000-0000-4000-8000-000000000006",
};

const DEFINITION = v.assignServerIds([
  { kind: "single", prompt: "2 + 2?", marks: 2, options: [{ text: "3" }, { text: "4", correct: true }] },
  { kind: "multiple", prompt: "Primes?", marks: 3, options: [{ text: "2", correct: true }, { text: "3", correct: true }, { text: "4" }] },
  { kind: "true_false", prompt: "Sky blue?", marks: 1, correct: true },
  { kind: "short", prompt: "Capital?", marks: 1, acceptedAnswers: ["Kotte"] },
]);
const [SINGLE, MULTIPLE, TF] = DEFINITION.questions;

let rooms;
const resolver = { resolveStudentRoom: async ({ studentId }) => rooms[studentId] ?? null };
const opts = () => ({ roomResolver: resolver });

function quiz(id, extra = {}) {
  return {
    id, classSessionId: S1, teacherId: "t1", publishGroupId: "g1", targetRoomType: "MAIN", targetRoomId: null, targetRoomName: "Main room",
    title: `Quiz ${id.slice(-1)}`, instructions: "Answer all", questions: structuredClone(DEFINITION), totalMarks: 7, timeLimitSeconds: 600,
    state: "PUBLISHED", publishedAt: clock, closedAt: null, status: 0, createdAt: new Date(clock.getTime() + Number(id.slice(-1))), updatedAt: clock, ...extra,
  };
}
let attemptSeq = 0;
async function attempt(quizId, studentId, attemptStatus, answers = {}, extra = {}) {
  const marking = await import(pathToFileURL(path.join(root, "lib/breakout-activities/marking.mjs")).href);
  const grading = attemptStatus === "IN_PROGRESS" ? null : marking.gradeAttempt(DEFINITION, answers);
  const scores = grading ? marking.computeScores(grading) : null;
  const row = {
    id: `e${String(++attemptSeq).padStart(7, "0")}-0000-4000-8000-000000000000`, quizId, classSessionId: S1, studentId, attemptStatus,
    answers, revision: 3, startedAt: clock, deadlineAt: new Date(clock.getTime() + 600_000), lastSavedAt: clock,
    submittedAt: grading ? clock : null, grading, autoScore: scores?.autoScore ?? null, finalScore: scores?.finalScore ?? null, overriddenAt: null, updatedAt: clock, ...extra,
  };
  db.tables.breakoutQuizSubmission.push(row);
  return row;
}

test.beforeEach(() => {
  clock = new Date("2026-11-06T09:00:00.000Z");
  rooms = { [ST1]: { type: "MAIN" }, [ST2]: { type: "BREAKOUT", id: "r1" } };
  db = createFakeBreakoutDb();
  db.tables.class.push({ id: "class-1", teacherId: "t1" }, { id: "class-2", teacherId: "t1" });
  db.tables.classSession.push({ id: S1, classId: "class-1", isActive: true }, { id: S2, classId: "class-2", isActive: true }, { id: S3, classId: "class-1", isActive: false });
  db.tables.student.push({ id: ST1, status: 0 }, { id: ST2, status: 0 }, { id: ST3, status: 0 });
  db.tables.classStudent.push({ studentId: ST1, classId: "class-1", isActive: true }, { studentId: ST2, classId: "class-1", isActive: true });
  db.tables.breakoutQuiz.push(
    quiz(Q.MAIN),
    quiz(Q.R1, { targetRoomType: "BREAKOUT", targetRoomId: "r1", targetRoomName: "Room 1" }),
    quiz(Q.DRAFT, { state: "DRAFT", publishedAt: null }),
    quiz(Q.CLOSED, { state: "CLOSED", closedAt: clock }),
    quiz(Q.DELETED, { status: 1 }),
    quiz(Q.OTHER_SESSION, { classSessionId: S2 })
  );
});

const appError = (status, code) => (e) => {
  assert.ok(e instanceof AppError, String(e?.stack ?? e));
  assert.equal(e.statusCode, status, `${e.code}: ${e.message}`);
  assert.equal(e.code, code);
  return true;
};
const ANSWER_KEYS = ["correct", "correctOptionId", "correctOptionIds", "acceptedAnswers"];
const ALWAYS_FORBIDDEN = ["grading", "autoScore", "studentId", "classSessionId", "teacherId", "publishGroupId", "status", "targetRoomId", "idempotencyKey"];
function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((x) => keysDeep(x, out));
  else if (value && typeof value === "object") for (const [k, x] of Object.entries(value)) { out.add(k); keysDeep(x, out); }
  return out;
}
function assertNoLeak(view, { keysAllowed = false } = {}) {
  const keys = keysDeep(view);
  for (const k of ALWAYS_FORBIDDEN) assert.equal(keys.has(k), false, `leaked ${k}`);
  if (!keysAllowed) for (const k of ANSWER_KEYS) assert.equal(keys.has(k), false, `leaked answer key ${k}`);
}
const get = (quizId, studentId = ST1, o = opts()) => service.getQuizForStudent({ studentId, sessionId: S1, quizId }, o);
const list = (studentId = ST1, o = opts()) => service.listQuizzesForStudent({ studentId, sessionId: S1 }, o);

// ---- Fake database: createMany({ skipDuplicates }) for the start step ------------

test("fake createMany: skipDuplicates honours the unique (quizId, studentId); without it a duplicate is P2002", async () => {
  const row = { id: "x1", quizId: Q.MAIN, classSessionId: S1, studentId: ST1, attemptStatus: "IN_PROGRESS", answers: {}, revision: 0, startedAt: clock, updatedAt: clock };
  assert.deepEqual(await db.client.breakoutQuizSubmission.createMany({ data: [row], skipDuplicates: true }), { count: 1 });
  assert.deepEqual(await db.client.breakoutQuizSubmission.createMany({ data: [{ ...row, id: "x2" }], skipDuplicates: true }), { count: 0 });
  await assert.rejects(db.client.breakoutQuizSubmission.createMany({ data: [{ ...row, id: "x3" }] }), (e) => e.code === "P2002");
  assert.deepEqual(await db.client.breakoutQuizSubmission.createMany({ data: { ...row, id: "x4", studentId: ST2 }, skipDuplicates: true }), { count: 1 });
  assert.deepEqual(db.tables.breakoutQuizSubmission.map((r) => r.id), ["x1", "x4"]);
  assert.equal(db.tables.breakoutQuizSubmission[0].updatedAt.toISOString(), clock.toISOString(), "an explicit updatedAt is kept");
});

// ---- Fail closed, access, room --------------------------------------------------

test("the DEFAULT resolver fails closed: list and get are 404, nothing read about quizzes", async () => {
  await assert.rejects(list(ST1, {}), appError(404, "NOT_FOUND"));
  await assert.rejects(get(Q.MAIN, ST1, {}), appError(404, "NOT_FOUND"));
  assert.equal(db.calls.filter((c) => c.model === "breakoutQuiz" || c.model === "breakoutQuizSubmission").length, 0);
});

test("D2: not enrolled, ended session, other session, inactive enrolment: the same 404", async () => {
  rooms[ST3] = { type: "MAIN" };
  for (const [studentId, sessionId] of [[ST3, S1], [ST1, S3], [ST1, S2]]) {
    await assert.rejects(service.listQuizzesForStudent({ studentId, sessionId }, opts()), appError(404, "NOT_FOUND"));
    await assert.rejects(service.getQuizForStudent({ studentId, sessionId, quizId: Q.MAIN }, opts()), appError(404, "NOT_FOUND"));
  }
  db.tables.classStudent[0].isActive = false;
  await assert.rejects(list(), appError(404, "NOT_FOUND"));
});

test("list: only PUBLISHED / CLOSED, non-deleted quizzes of the CURRENT room in this session; metadata only", async () => {
  const main = await list();
  assert.deepEqual(main.room, { type: "MAIN" });
  assert.deepEqual(main.quizzes.map((q) => q.id), [Q.MAIN, Q.CLOSED]);
  assert.deepEqual((await list(ST2)).quizzes.map((q) => q.id), [Q.R1]);
  rooms[ST2] = { type: "BREAKOUT", id: "r9" };
  assert.deepEqual((await list(ST2)).quizzes, [], "another room: the previous room's quizzes are hidden");
  const item = main.quizzes[0];
  assert.deepEqual(Object.keys(item).sort(), ["closedAt", "id", "instructions", "mine", "publishedAt", "questionCount", "room", "state", "timeLimitSeconds", "title", "totalMarks"]);
  assert.equal(item.questionCount, 4);
  assert.equal(item.totalMarks, 7);
  assert.equal(item.timeLimitSeconds, 600);
  assert.deepEqual(item.mine, { attemptStatus: null });
  assert.equal(keysDeep(main).has("questions"), false, "no questions in the list");
  assert.equal(keysDeep(main).has("prompt"), false);
  assertNoLeak(main);
});

test("another room's quiz, a DRAFT, a deleted one, another session's, a bad id: 404 QUIZ_NOT_FOUND", async () => {
  for (const quizId of [Q.R1, Q.DRAFT, Q.DELETED, Q.OTHER_SESSION, "f0000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    await assert.rejects(get(quizId), appError(404, "QUIZ_NOT_FOUND"), quizId);
  }
});

// ---- Q1: metadata only without an attempt ---------------------------------------

test("Q1: without an attempt, a PUBLISHED quiz is metadata only: no questions, no prompts, no keys", async () => {
  const res = await get(Q.MAIN);
  assert.deepEqual(res.attempt, { attemptStatus: null });
  assert.equal(res.serverNow, clock.toISOString());
  assert.equal(res.quiz.questionCount, 4);
  assert.equal("questions" in res.quiz, false);
  assert.equal(keysDeep(res).has("prompt"), false);
  assert.equal(keysDeep(res).has("options"), false);
  assertNoLeak(res);
});

test("Q1: a CLOSED quiz the student never attempted is still metadata only: no questions, no answer keys", async () => {
  const res = await get(Q.CLOSED);
  assert.equal(res.quiz.state, "CLOSED");
  assert.deepEqual(res.attempt, { attemptStatus: null });
  assert.equal("questions" in res.quiz, false);
  assert.equal(keysDeep(res).has("review"), false);
  assertNoLeak(res);
});

test("another student's attempt never counts: they see the questions, this student still only metadata", async () => {
  await attempt(Q.MAIN, ST2, "SUBMITTED", { [TF.id]: { kind: "true_false", value: true } });
  rooms[ST2] = { type: "MAIN" };
  assert.ok(Array.isArray((await get(Q.MAIN, ST2)).quiz.questions));
  const mine = await get(Q.MAIN, ST1);
  assert.deepEqual(mine.attempt, { attemptStatus: null });
  assert.equal("questions" in mine.quiz, false);
  assert.deepEqual((await list(ST1)).quizzes[0].mine, { attemptStatus: null });
});

// ---- With an attempt --------------------------------------------------------------

test("in progress: the questions (projection, no keys) and the student's own answers to resume", async () => {
  const answers = { [SINGLE.id]: { kind: "single", optionId: SINGLE.options[0].id } };
  await attempt(Q.MAIN, ST1, "IN_PROGRESS", answers);
  const res = await get(Q.MAIN);
  assert.equal(res.quiz.questions.length, 4);
  assert.deepEqual(Object.keys(res.quiz.questions[0]).sort(), ["id", "kind", "marks", "options", "prompt"]);
  assert.deepEqual(res.attempt, {
    attemptStatus: "IN_PROGRESS",
    answers,
    revision: 3,
    startedAt: clock.toISOString(),
    deadlineAt: new Date(clock.getTime() + 600_000).toISOString(),
    lastSavedAt: clock.toISOString(),
  });
  assertNoLeak(res);
  assert.deepEqual((await list()).quizzes[0].mine, {
    attemptStatus: "IN_PROGRESS",
    startedAt: clock.toISOString(),
    deadlineAt: new Date(clock.getTime() + 600_000).toISOString(),
    lastSavedAt: clock.toISOString(),
  }, "the list summary has no answers");
});

test("submitted, quiz not CLOSED: the total score only (no review, no per-question results, no keys)", async () => {
  for (const status of ["SUBMITTED", "AUTO_SUBMITTED"]) {
    db.tables.breakoutQuizSubmission = [];
    await attempt(Q.MAIN, ST1, status, {
      [SINGLE.id]: { kind: "single", optionId: SINGLE.options[1].id },
      [MULTIPLE.id]: { kind: "multiple", optionIds: [MULTIPLE.options[0].id] },
    });
    const res = await get(Q.MAIN);
    assert.deepEqual(res.attempt, { attemptStatus: status, finalScore: 3.5, totalMarks: 7, submittedAt: clock.toISOString() });
    assert.equal(keysDeep(res).has("review"), false);
    assert.equal(keysDeep(res).has("result"), false);
    assertNoLeak(res);
    assert.deepEqual((await list()).quizzes[0].mine, { attemptStatus: status, finalScore: 3.5, totalMarks: 7, submittedAt: clock.toISOString() });
  }
});

test("quiz CLOSED with an attempt: the review (correct answers, own answers, results); never raw grading", async () => {
  await attempt(Q.CLOSED, ST1, "AUTO_SUBMITTED", { [TF.id]: { kind: "true_false", value: false } });
  const res = await get(Q.CLOSED);
  assert.equal(res.attempt.finalScore, 0);
  assert.equal(res.attempt.review.length, 4);
  const tf = res.attempt.review.find((r) => r.id === TF.id);
  assert.equal(tf.correct, true, "the key, after CLOSED");
  assert.deepEqual(tf.answer, { kind: "true_false", value: false });
  assert.equal(tf.result, "incorrect");
  assertNoLeak(res, { keysAllowed: true });
  const listed = (await list()).quizzes.find((q) => q.id === Q.CLOSED);
  assert.deepEqual(Object.keys(listed.mine).sort(), ["attemptStatus", "finalScore", "submittedAt", "totalMarks"], "the list never carries the review");
});

test("a teacher override shows in the student's final score (still no grading object)", async () => {
  const row = await attempt(Q.MAIN, ST1, "SUBMITTED", {});
  row.grading.questions[TF.id].override = { marks: 1, teacherId: "t1", at: clock.toISOString(), note: "ok" };
  row.finalScore = 1;
  const res = await get(Q.MAIN);
  assert.equal(res.attempt.finalScore, 1);
  assertNoLeak(res);
});

// ---- Reads never write ----------------------------------------------------------------

test("reads use no transaction and write nothing; a corrupt stored definition fails loudly (never half-shown)", async () => {
  await attempt(Q.MAIN, ST1, "IN_PROGRESS", {});
  await list();
  await get(Q.MAIN);
  assert.equal(db.transactions.length, 0);
  assert.equal(db.calls.filter((c) => ["create", "createMany", "update", "updateMany"].includes(c.method)).length, 0);
  db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).questions = { schemaVersion: 1, questions: [{ id: "q1", kind: "nope" }] };
  await assert.rejects(get(Q.MAIN), (e) => !(e instanceof AppError));
  await assert.rejects(list(), (e) => !(e instanceof AppError));
});

// ---- Start (Stage 3.2.2) ------------------------------------------------------------

const { BREAKOUT_TRANSACTION_OPTIONS } = require(path.join(root, "lib/breakout-activities/locks.ts"));
const start = (quizId = Q.MAIN, studentId = ST1, o = opts()) => service.startQuizAttempt({ studentId, sessionId: S1, quizId }, o);
const attemptsOf = (quizId = Q.MAIN, studentId = ST1) => db.tables.breakoutQuizSubmission.filter((a) => a.quizId === quizId && a.studentId === studentId);

test("first start: exactly one attempt; one timestamp for startedAt, deadlineAt (+ time limit) and updatedAt; questions now visible", async () => {
  const res = await start();
  const rows = attemptsOf();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.classSessionId, S1);
  assert.equal(row.studentId, ST1);
  assert.equal(row.attemptStatus, "IN_PROGRESS");
  assert.deepEqual(row.answers, {});
  assert.equal(row.revision, 0);
  assert.equal(row.startedAt.toISOString(), clock.toISOString());
  assert.equal(row.deadlineAt.toISOString(), new Date(clock.getTime() + 600_000).toISOString(), "startedAt + timeLimitSeconds");
  assert.equal(row.updatedAt.toISOString(), clock.toISOString(), "explicit updatedAt from the database clock");
  assert.equal(row.submittedAt ?? null, null);
  assert.equal(row.grading ?? null, null);

  assert.equal(res.started, true);
  assert.equal(res.serverNow, clock.toISOString());
  assert.equal(res.quiz.questions.length, 4, "Q1: the questions once the attempt exists");
  assert.deepEqual(res.attempt, {
    attemptStatus: "IN_PROGRESS",
    answers: {},
    revision: 0,
    startedAt: clock.toISOString(),
    deadlineAt: new Date(clock.getTime() + 600_000).toISOString(),
    lastSavedAt: null,
  });
  assertNoLeak(res);

  const insert = db.calls.find((c) => c.model === "breakoutQuizSubmission" && c.method === "createMany");
  assert.equal(insert.args.skipDuplicates, true);
  assert.equal(new Date(insert.args.data[0].updatedAt).toISOString(), clock.toISOString());
  assert.equal(new Date(insert.args.data[0].startedAt).getTime(), new Date(insert.args.data[0].updatedAt).getTime(), "one timestamp");
  assert.deepEqual(db.transactions, [BREAKOUT_TRANSACTION_OPTIONS]);
});

test("starting again returns the SAME attempt: no second row, no insert, started: false", async () => {
  const first = await start();
  clock = new Date("2026-11-06T09:03:00.000Z");
  const insertsBefore = db.calls.filter((c) => c.method === "createMany").length;
  const again = await start();
  assert.equal(again.started, false);
  assert.equal(attemptsOf().length, 1);
  assert.equal(db.calls.filter((c) => c.method === "createMany").length, insertsBefore, "no insert for an existing attempt");
  assert.equal(again.attempt.startedAt, first.attempt.startedAt, "the original start time, not the new clock");
  assert.equal(again.attempt.deadlineAt, first.attempt.deadlineAt);
});

test("concurrent start: another request commits the attempt first; skipDuplicates does nothing; both get that one attempt", async () => {
  const realTransaction = db.client.$transaction;
  const competitorId = "e9999999-0000-4000-8000-000000000000";
  db.client.$transaction = (fn, options) =>
    realTransaction(async (tx) => {
      const createMany = tx.breakoutQuizSubmission.createMany;
      const wrapped = {
        ...tx,
        breakoutQuizSubmission: {
          ...tx.breakoutQuizSubmission,
          // The other tab's insert lands between this request's check and its insert.
          createMany: async (args) => {
            db.tables.breakoutQuizSubmission.push({ ...args.data[0], id: competitorId, startedAt: new Date(clock.getTime() - 1000) });
            return createMany(args);
          },
        },
      };
      return fn(wrapped);
    }, options);
  try {
    const res = await start();
    assert.equal(res.started, false, "this insert was skipped as a duplicate");
    assert.equal(attemptsOf().length, 1, "never two attempts");
    assert.equal(attemptsOf()[0].id, competitorId);
    assert.equal(res.attempt.startedAt, new Date(clock.getTime() - 1000).toISOString(), "the competing attempt is returned");
  } finally {
    db.client.$transaction = realTransaction;
  }
});

test("an untimed quiz starts with a null deadline", async () => {
  db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).timeLimitSeconds = null;
  const res = await start();
  assert.equal(attemptsOf()[0].deadlineAt, null);
  assert.equal(res.attempt.deadlineAt, null);
});

test("CLOSED with no attempt: 409 QUIZ_CLOSED, nothing created", async () => {
  await assert.rejects(start(Q.CLOSED), appError(409, "QUIZ_CLOSED"));
  assert.equal(attemptsOf(Q.CLOSED).length, 0);
  assert.equal(db.calls.filter((c) => c.method === "createMany").length, 0);
});

test("CLOSED with an existing attempt: that student's safe result (the review), no new attempt", async () => {
  await attempt(Q.CLOSED, ST1, "SUBMITTED", { [TF.id]: { kind: "true_false", value: true } });
  const res = await start(Q.CLOSED);
  assert.equal(res.started, false);
  assert.equal(attemptsOf(Q.CLOSED).length, 1);
  assert.equal(res.attempt.attemptStatus, "SUBMITTED");
  assert.equal(res.attempt.finalScore, 1);
  assert.equal(res.attempt.review.find((r) => r.id === TF.id).result, "correct");
  assertNoLeak(res, { keysAllowed: true });
});

test("a PUBLISHED quiz with a submitted attempt: start returns the score only (no review, no keys)", async () => {
  await attempt(Q.MAIN, ST1, "SUBMITTED", { [TF.id]: { kind: "true_false", value: true } });
  const res = await start();
  assert.deepEqual(res.attempt, { attemptStatus: "SUBMITTED", finalScore: 1, totalMarks: 7, submittedAt: clock.toISOString() });
  assertNoLeak(res);
});

test("inaccessible: default resolver, wrong room, not enrolled, inactive enrolment, ended session, DRAFT, deleted, other session", async () => {
  await assert.rejects(start(Q.MAIN, ST1, {}), appError(404, "NOT_FOUND"), "default resolver");
  await assert.rejects(start(Q.R1), appError(404, "QUIZ_NOT_FOUND"), "another room");
  for (const quizId of [Q.DRAFT, Q.DELETED, Q.OTHER_SESSION, "f0000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    await assert.rejects(start(quizId), appError(404, "QUIZ_NOT_FOUND"), quizId);
  }
  rooms[ST3] = { type: "MAIN" };
  await assert.rejects(start(Q.MAIN, ST3), appError(404, "NOT_FOUND"), "not enrolled");
  db.tables.classStudent[0].isActive = false;
  await assert.rejects(start(), appError(404, "NOT_FOUND"), "inactive enrolment");
  db.tables.classStudent[0].isActive = true;
  db.tables.classSession.find((s) => s.id === S1).isActive = false;
  await assert.rejects(start(), appError(404, "NOT_FOUND"), "ended session");
  assert.equal(db.tables.breakoutQuizSubmission.length, 0, "nothing created");
});

test("start: exact lock order: session, enrolment, quiz FOR KEY SHARE, own attempt FOR UPDATE, insert, attempt again", async () => {
  await start();
  const order = db.calls
    .filter((c) => c.tx === db.lastTx())
    .map((c) => (c.kind === "raw" ? c.sql.replace(/ WHERE .*(FOR KEY SHARE|FOR UPDATE)$/, " … $1") : `${c.model}.${c.method}`));
  assert.deepEqual(order, [
    "classSession.findFirst",
    "student.findFirst",
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" … FOR KEY SHARE',
    "student.findFirst",
    'SELECT "id", "classSessionId", "state"::text AS "state", "status", "targetRoomType"::text AS "targetRoomType", "targetRoomId" FROM "BreakoutQuiz" … FOR KEY SHARE',
    "breakoutQuiz.findUniqueOrThrow",
    'SELECT "id" FROM "BreakoutQuizSubmission" … FOR UPDATE',
    "breakoutQuizSubmission.createMany",
    'SELECT "id" FROM "BreakoutQuizSubmission" … FOR UPDATE',
    "breakoutQuizSubmission.findUniqueOrThrow",
  ]);
  const quizLockAt = order.findIndex((o) => o.includes('"BreakoutQuiz" … FOR KEY SHARE'));
  const attemptLockAt = order.findIndex((o) => o.includes('"BreakoutQuizSubmission" … FOR UPDATE'));
  assert.ok(quizLockAt >= 0 && quizLockAt < attemptLockAt, "the quiz is locked before the attempt, never after");
  assert.equal(order.slice(attemptLockAt).some((o) => o.includes('"BreakoutQuiz" …')), false, "no quiz lock after an attempt lock");
});

// ---- Save answers (Stage 3.2.3) -------------------------------------------------------

const [, , , SHORT] = DEFINITION.questions;
const save = (answers, revision = 0, studentId = ST1, quizId = Q.MAIN, o = opts()) =>
  service.saveQuizAnswers({ studentId, sessionId: S1, quizId, revision, answers }, o);
const ownAttempt = (quizId = Q.MAIN, studentId = ST1) => db.tables.breakoutQuizSubmission.find((a) => a.quizId === quizId && a.studentId === studentId);
const ans = {
  single: (i) => ({ [SINGLE.id]: { kind: "single", optionId: SINGLE.options[i].id } }),
  tf: (value) => ({ [TF.id]: { kind: "true_false", value } }),
  short: (text) => ({ [SHORT.id]: { kind: "short", text } }),
};

test("save: a partial save replaces only those questions; the others are kept; revision + 1 exactly once", async () => {
  await start();
  const first = await save({ ...ans.single(0), ...ans.tf(true) }, 0);
  assert.equal(first.attempt.revision, 1);
  clock = new Date("2026-11-06T09:01:00.000Z");
  const second = await save(ans.single(1), 1);
  assert.equal(second.attempt.revision, 2);
  assert.deepEqual(ownAttempt().answers, { ...ans.single(1), ...ans.tf(true) }, "true/false kept, single replaced");
  assert.deepEqual(second.attempt.answers, ownAttempt().answers);
  assert.equal(ownAttempt().lastSavedAt.toISOString(), clock.toISOString());
  assert.equal(ownAttempt().updatedAt.toISOString(), clock.toISOString(), "explicit updatedAt");
  assertNoLeak(second);
  const updates = db.calls.filter((c) => c.model === "breakoutQuizSubmission" && c.method === "update");
  assert.equal(updates.length, 2, "one update per save");
  assert.ok(updates.every((u) => u.args.data.updatedAt && u.args.data.lastSavedAt));
});

test("save: an empty answer clears just that question", async () => {
  await start();
  await save({ ...ans.single(0), ...ans.tf(true), ...ans.short("Kotte") }, 0);
  await save({ [SINGLE.id]: { kind: "single", optionId: null }, [SHORT.id]: { kind: "short", text: "" } }, 1);
  assert.deepEqual(ownAttempt().answers, {
    [SINGLE.id]: { kind: "single", optionId: null },
    ...ans.tf(true),
    [SHORT.id]: { kind: "short", text: "" },
  });
});

test("save: unknown question, wrong kind, unknown option, __proto__, empty save: 400, nothing changes", async () => {
  await start();
  await save(ans.tf(true), 0);
  const before = structuredClone(ownAttempt());
  for (const [label, answers] of [
    ["unknown question", { qffffffffffffffff: { kind: "true_false", value: true } }],
    ["wrong kind", { [TF.id]: { kind: "short", text: "yes" } }],
    ["unknown option", { [SINGLE.id]: { kind: "single", optionId: "offffffffffffffff" } }],
    ["an option of another question", { [SINGLE.id]: { kind: "single", optionId: MULTIPLE.options[0].id } }],
    ["__proto__", JSON.parse('{"__proto__":{"kind":"true_false","value":true}}')],
    ["empty", {}],
    ["not an object", "answers"],
    ["short answer too long", ans.short("x".repeat(1001))],
  ]) {
    await assert.rejects(save(answers, 1), appError(400, "VALIDATION_ERROR"), label);
  }
  assert.deepEqual(ownAttempt(), before, "the attempt is unchanged");
});

test("save: corrupt stored answers are refused (500), never overwritten", async () => {
  await start();
  ownAttempt().answers = { qffffffffffffffff: { kind: "true_false", value: true } };
  const before = structuredClone(ownAttempt());
  await assert.rejects(save(ans.tf(true), 0), (e) => {
    assert.ok(!(e instanceof AppError), "a server fault, not a client error");
    assert.match(e.message, /Stored answers .* are invalid/);
    return true;
  });
  assert.deepEqual(ownAttempt(), before);
  // The two failures stay distinct: an invalid request is still the client's 400, even over corrupt stored answers.
  await assert.rejects(save({ qeeeeeeeeeeeeeeee: { kind: "true_false", value: true } }, 0), appError(400, "VALIDATION_ERROR"));
  assert.deepEqual(ownAttempt(), before, "never overwritten");
});

test("save: a stale revision is 409 REVISION_CONFLICT with the saved answers and revision; nothing changes", async () => {
  await start();
  await save(ans.tf(true), 0);
  const before = structuredClone(ownAttempt());
  await assert.rejects(save(ans.tf(false), 0), (e) => {
    appError(409, "REVISION_CONFLICT")(e);
    assert.deepEqual(e.details, { answers: ans.tf(true), revision: 1 });
    assertNoLeak(e.details);
    return true;
  });
  await assert.rejects(save(ans.tf(false), 7), appError(409, "REVISION_CONFLICT"));
  await assert.rejects(save(ans.tf(false), -1), appError(400, "VALIDATION_ERROR"));
  assert.deepEqual(ownAttempt(), before);
});

test("save without an attempt: 409 QUIZ_NOT_STARTED; submitted or auto-submitted: 409 QUIZ_ALREADY_SUBMITTED", async () => {
  await assert.rejects(save(ans.tf(true), 0), appError(409, "QUIZ_NOT_STARTED"));
  assert.equal(db.tables.breakoutQuizSubmission.length, 0, "a save never creates an attempt");
  for (const status of ["SUBMITTED", "AUTO_SUBMITTED"]) {
    db.tables.breakoutQuizSubmission = [];
    await attempt(Q.MAIN, ST1, status, ans.tf(false));
    const before = structuredClone(ownAttempt());
    await assert.rejects(save(ans.tf(true), 3), appError(409, "QUIZ_ALREADY_SUBMITTED"), status);
    assert.deepEqual(ownAttempt(), before);
  }
});

test("deadline: saves at the deadline, +1 s and exactly +5 s succeed; +5.001 s auto-submits", async () => {
  await start(); // deadlineAt = 09:00:00 + 600 s = 09:10:00
  const deadline = ownAttempt().deadlineAt.getTime();
  let revision = 0;
  for (const offset of [0, 1_000, 5_000]) {
    clock = new Date(deadline + offset);
    const res = await save(ans.tf(offset % 2 === 0), revision);
    revision = res.attempt.revision;
    assert.equal(res.attempt.attemptStatus, "IN_PROGRESS", `+${offset} ms`);
  }
  assert.equal(revision, 3);
  clock = new Date(deadline + 5_001);
  await assert.rejects(save(ans.single(1), revision), appError(409, "QUIZ_TIME_UP"));
  assert.equal(ownAttempt().attemptStatus, "AUTO_SUBMITTED");
});

test("past the grace: the auto-submit is COMMITTED with the saved answers, then 409 QUIZ_TIME_UP with the safe result", async () => {
  await start();
  await save({ ...ans.single(1), ...ans.tf(true) }, 0); // 2 + 1 = 3 marks saved
  const deadline = ownAttempt().deadlineAt.getTime();
  clock = new Date(deadline + 6_000);
  await assert.rejects(save(ans.tf(false), 1), (e) => {
    appError(409, "QUIZ_TIME_UP")(e);
    assert.deepEqual(e.details, { attempt: { attemptStatus: "AUTO_SUBMITTED", finalScore: 3, totalMarks: 7, submittedAt: new Date(deadline + 5_000).toISOString() } });
    assertNoLeak(e.details);
    return true;
  });
  const row = ownAttempt();
  assert.equal(row.attemptStatus, "AUTO_SUBMITTED", "kept: the transaction committed");
  assert.deepEqual(row.answers, { ...ans.single(1), ...ans.tf(true) }, "the SAVED answers, not the late ones");
  assert.equal(row.revision, 1, "no revision bump for the refused save");
  assert.equal(row.submittedAt.toISOString(), new Date(deadline + 5_000).toISOString(), "L3: when the time ran out, not when found");
  assert.equal(row.updatedAt.toISOString(), clock.toISOString());
  assert.equal(row.autoScore, 3);
  assert.equal(row.finalScore, 3);
  assert.ok(row.grading && row.grading.schemaVersion === 1, "graded with the approved marking");
  await assert.rejects(save(ans.tf(false), 1), appError(409, "QUIZ_ALREADY_SUBMITTED"), "and stays submitted");
});

test("defensive: a CLOSED quiz with a left-over IN_PROGRESS attempt is auto-submitted (kept), never saved: 409 QUIZ_CLOSED", async () => {
  await attempt(Q.CLOSED, ST1, "IN_PROGRESS", ans.tf(true), { revision: 0 });
  await assert.rejects(save(ans.tf(false), 0, ST1, Q.CLOSED), (e) => {
    appError(409, "QUIZ_CLOSED")(e);
    assert.equal(e.details.attempt.attemptStatus, "AUTO_SUBMITTED");
    assert.ok(Array.isArray(e.details.attempt.review), "CLOSED: the review is allowed");
    assert.equal(keysDeep(e.details).has("grading"), false);
    return true;
  });
  const row = ownAttempt(Q.CLOSED);
  assert.equal(row.attemptStatus, "AUTO_SUBMITTED");
  assert.deepEqual(row.answers, ans.tf(true), "the saved answers, not the late save");
});

test("an untimed quiz saves at any time", async () => {
  db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).timeLimitSeconds = null;
  await start();
  clock = new Date("2026-11-07T09:00:00.000Z");
  const res = await save(ans.tf(true), 0);
  assert.equal(res.attempt.attemptStatus, "IN_PROGRESS");
  assert.equal(res.attempt.revision, 1);
});

test("save: access, room and visibility as for every write (nothing changes)", async () => {
  await start();
  const before = structuredClone(ownAttempt());
  await assert.rejects(save(ans.tf(true), 0, ST1, Q.MAIN, {}), appError(404, "NOT_FOUND"), "default resolver");
  rooms[ST1] = { type: "BREAKOUT", id: "r1" };
  await assert.rejects(save(ans.tf(true), 0), appError(404, "QUIZ_NOT_FOUND"), "moved to another room");
  rooms[ST1] = { type: "MAIN" };
  await assert.rejects(save(ans.tf(true), 0, ST1, Q.DRAFT), appError(404, "QUIZ_NOT_FOUND"));
  await assert.rejects(save(ans.tf(true), 0, ST1, "bad"), appError(404, "QUIZ_NOT_FOUND"));
  db.tables.classStudent[0].isActive = false;
  await assert.rejects(save(ans.tf(true), 0), appError(404, "NOT_FOUND"));
  assert.deepEqual(ownAttempt(), before);
});

test("save: exact lock order (quiz before attempt, never after) and no answer keys or grading in the response", async () => {
  await start();
  const res = await save(ans.tf(true), 0);
  assertNoLeak(res);
  const order = db.calls
    .filter((c) => c.tx === db.lastTx())
    .map((c) => (c.kind === "raw" ? c.sql.replace(/ WHERE .*(FOR KEY SHARE|FOR UPDATE)$/, " … $1") : `${c.model}.${c.method}`));
  assert.deepEqual(order, [
    "classSession.findFirst",
    "student.findFirst",
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" … FOR KEY SHARE',
    "student.findFirst",
    'SELECT "id", "classSessionId", "state"::text AS "state", "status", "targetRoomType"::text AS "targetRoomType", "targetRoomId" FROM "BreakoutQuiz" … FOR KEY SHARE',
    "breakoutQuiz.findUniqueOrThrow",
    'SELECT "id" FROM "BreakoutQuizSubmission" … FOR UPDATE',
    "breakoutQuizSubmission.findUniqueOrThrow",
    "breakoutQuizSubmission.update",
  ]);
});

// ---- Submit (Stage 3.2.4) --------------------------------------------------------------

const submitQuiz = (revision, studentId = ST1, quizId = Q.MAIN, o = opts()) =>
  service.submitQuizAttempt({ studentId, sessionId: S1, quizId, revision }, o);

test("submit: grades the saved answers (single, multiple partial, true/false, short normalized) and persists it", async () => {
  await start();
  await save({
    ...ans.single(1), // correct: 2
    [MULTIPLE.id]: { kind: "multiple", optionIds: [MULTIPLE.options[0].id, MULTIPLE.options[2].id] }, // 1 of 2 correct, 2 selected: 1.5
    ...ans.tf(true), // correct: 1
    ...ans.short("   KOTTE  "), // normalized: correct, 1
  }, 0);
  clock = new Date("2026-11-06T09:05:00.000Z");
  const res = await submitQuiz(1);
  assert.equal(res.replayed, false);
  assert.deepEqual(res.attempt, { attemptStatus: "SUBMITTED", finalScore: 5.5, totalMarks: 7, submittedAt: clock.toISOString() });
  const row = ownAttempt();
  assert.equal(row.attemptStatus, "SUBMITTED");
  assert.equal(row.submittedAt.toISOString(), clock.toISOString());
  assert.equal(row.updatedAt.toISOString(), clock.toISOString(), "explicit updatedAt, the same value");
  assert.equal(row.autoScore, 5.5);
  assert.equal(row.finalScore, 5.5);
  assert.equal(row.revision, 1, "submitting does not change the revision");
  assert.deepEqual(
    Object.fromEntries(Object.entries(row.grading.questions).map(([id, g]) => [id, [g.auto, g.result]])),
    { [SINGLE.id]: [2, "correct"], [MULTIPLE.id]: [1.5, "partial"], [TF.id]: [1, "correct"], [SHORT.id]: [1, "correct"] }
  );
  const update = db.calls.filter((c) => c.model === "breakoutQuizSubmission" && c.method === "update").at(-1);
  assert.ok(update.args.data.updatedAt && update.args.data.submittedAt);
  assertNoLeak(res);
});

test("submit: multiple-answer option A edge cases and an unanswered quiz", async () => {
  await start();
  await save({ [MULTIPLE.id]: { kind: "multiple", optionIds: MULTIPLE.options.map((o) => o.id) } }, 0); // 3 selected > 2 correct: 0
  const res = await submitQuiz(1);
  assert.equal(res.attempt.finalScore, 0);
  assert.equal(ownAttempt().grading.questions[MULTIPLE.id].auto, 0);
  db.tables.breakoutQuizSubmission = [];
  await start();
  assert.equal((await submitQuiz(0)).attempt.finalScore, 0, "nothing answered: 0, still submitted");
  assert.equal(ownAttempt().attemptStatus, "SUBMITTED");
});

test("submit: short answers keep Sinhala ZWJ and Tamil ZWNJ (no false match without them)", async () => {
  const SINHALA = "ශ්‍රී ලංකාව"; // Sri Lanka, with ZWJ
  const TAMIL = "க்‌ஷ"; // with ZWNJ
  const def = v.assignServerIds([
    { kind: "short", prompt: "Sinhala", marks: 1, acceptedAnswers: [SINHALA] },
    { kind: "short", prompt: "Tamil", marks: 1, acceptedAnswers: [TAMIL] },
  ]);
  const [si, ta] = def.questions;
  const run = async (sinhalaText, tamilText) => {
    db.tables.breakoutQuizSubmission = [];
    db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).questions = structuredClone(def);
    db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).totalMarks = 2;
    await start();
    await save({ [si.id]: { kind: "short", text: sinhalaText }, [ta.id]: { kind: "short", text: tamilText } }, 0);
    await submitQuiz(1);
    const g = ownAttempt().grading.questions;
    return [g[si.id].result, g[ta.id].result];
  };
  assert.deepEqual(await run(SINHALA, TAMIL), ["correct", "correct"]);
  assert.deepEqual(await run(`  ${SINHALA}  `, ` ${TAMIL}`), ["correct", "correct"], "surrounding whitespace ignored");
  assert.deepEqual(await run(SINHALA.replace("‍", ""), TAMIL.replace("‌", "")), ["incorrect", "incorrect"], "joiners are significant");
});

test("submit: a stale revision is 409 REVISION_CONFLICT with the saved answers; the attempt is unchanged", async () => {
  await start();
  await save(ans.tf(true), 0);
  const before = structuredClone(ownAttempt());
  await assert.rejects(submitQuiz(0), (e) => {
    appError(409, "REVISION_CONFLICT")(e);
    assert.deepEqual(e.details, { answers: ans.tf(true), revision: 1 });
    assertNoLeak(e.details);
    return true;
  });
  await assert.rejects(submitQuiz(5), appError(409, "REVISION_CONFLICT"));
  await assert.rejects(submitQuiz(-1), appError(400, "VALIDATION_ERROR"));
  assert.deepEqual(ownAttempt(), before);
});

test("submit without an attempt: 409 QUIZ_NOT_STARTED and nothing created", async () => {
  await assert.rejects(submitQuiz(0), appError(409, "QUIZ_NOT_STARTED"));
  assert.equal(db.tables.breakoutQuizSubmission.length, 0);
});

test("repeated submit returns the existing result: no second grading, no write (SUBMITTED and AUTO_SUBMITTED)", async () => {
  await start();
  await save(ans.tf(true), 0);
  const first = await submitQuiz(1);
  const stored = structuredClone(ownAttempt());
  const writes = () => db.calls.filter((c) => c.model === "breakoutQuizSubmission" && ["update", "updateMany", "createMany"].includes(c.method)).length;
  const writesBefore = writes();
  clock = new Date("2026-11-06T09:30:00.000Z");
  for (const revision of [1, 0, 99]) {
    const again = await submitQuiz(revision);
    assert.equal(again.replayed, true, `revision ${revision} ignored on a repeat`);
    assert.deepEqual(again.attempt, first.attempt);
  }
  assert.equal(writes(), writesBefore, "no write");
  assert.deepEqual(ownAttempt(), stored);
  db.tables.breakoutQuizSubmission = [];
  await attempt(Q.MAIN, ST1, "AUTO_SUBMITTED", ans.tf(false));
  assert.equal((await submitQuiz(3)).attempt.attemptStatus, "AUTO_SUBMITTED");
});

test("deadline: submit at the deadline, +1 s and exactly +5 s is SUBMITTED; +5.001 s auto-submits (200)", async () => {
  for (const offset of [0, 1_000, 5_000]) {
    db.tables.breakoutQuizSubmission = [];
    clock = new Date("2026-11-06T09:00:00.000Z");
    await start();
    await save(ans.tf(true), 0);
    clock = new Date(ownAttempt().deadlineAt.getTime() + offset);
    const res = await submitQuiz(1);
    assert.equal(res.attempt.attemptStatus, "SUBMITTED", `+${offset} ms`);
  }
  db.tables.breakoutQuizSubmission = [];
  clock = new Date("2026-11-06T09:00:00.000Z");
  await start();
  await save(ans.tf(true), 0);
  clock = new Date(ownAttempt().deadlineAt.getTime() + 5_001);
  const late = await submitQuiz(1);
  assert.equal(late.attempt.attemptStatus, "AUTO_SUBMITTED", "200, not an error");
  assert.equal(ownAttempt().attemptStatus, "AUTO_SUBMITTED");
});

test("too late: the SAVED answers are auto-submitted, whatever revision the late submit carries", async () => {
  await start();
  await save({ ...ans.single(1), ...ans.tf(false) }, 0); // 2 + 0
  const lateDeadline = ownAttempt().deadlineAt.getTime();
  clock = new Date(lateDeadline + 60_000);
  const res = await submitQuiz(0); // stale revision: still auto-submitted, not a conflict
  const endedAt = new Date(lateDeadline + 5_000).toISOString();
  assert.deepEqual(res.attempt, { attemptStatus: "AUTO_SUBMITTED", finalScore: 2, totalMarks: 7, submittedAt: endedAt });
  const row = ownAttempt();
  assert.deepEqual(row.answers, { ...ans.single(1), ...ans.tf(false) }, "the saved answers only");
  assert.equal(row.submittedAt.toISOString(), endedAt, "L3: deadline + 5 s, not the late submit's time");
  assert.equal(row.updatedAt.toISOString(), clock.toISOString());
  assertNoLeak(res);
});

test("an untimed quiz can be submitted at any time", async () => {
  db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).timeLimitSeconds = null;
  await start();
  await save(ans.tf(true), 0);
  clock = new Date("2026-11-08T09:00:00.000Z");
  assert.equal((await submitQuiz(1)).attempt.attemptStatus, "SUBMITTED");
});

test("teacher overrides survive: a later submit call never re-grades, and finalScore shows the override", async () => {
  await start();
  await save(ans.tf(false), 0);
  await submitQuiz(1);
  const row = ownAttempt();
  row.grading.questions[TF.id].override = { marks: 1, teacherId: "t1", at: clock.toISOString(), note: "Accepted" };
  row.finalScore = 1;
  const again = await submitQuiz(1);
  assert.equal(again.attempt.finalScore, 1);
  assert.equal(ownAttempt().grading.questions[TF.id].override.marks, 1, "override kept");
  assert.equal(ownAttempt().autoScore, 0, "auto score kept");
});

test("privacy: before CLOSED the score only; after CLOSED the review; never raw grading", async () => {
  await start();
  await save(ans.tf(true), 0);
  const res = await submitQuiz(1);
  assert.deepEqual(Object.keys(res.attempt).sort(), ["attemptStatus", "finalScore", "submittedAt", "totalMarks"]);
  assertNoLeak(res);
  db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).state = "CLOSED";
  const closed = await submitQuiz(1);
  assert.equal(closed.replayed, true);
  const tf = closed.attempt.review.find((r) => r.id === TF.id);
  assert.equal(tf.correct, true);
  assert.equal(tf.result, "correct");
  assertNoLeak(closed, { keysAllowed: true });
});

test("submit: access, room, visibility; nothing changes", async () => {
  await start();
  const before = structuredClone(ownAttempt());
  await assert.rejects(submitQuiz(0, ST1, Q.MAIN, {}), appError(404, "NOT_FOUND"), "default resolver");
  rooms[ST1] = { type: "BREAKOUT", id: "r1" };
  await assert.rejects(submitQuiz(0), appError(404, "QUIZ_NOT_FOUND"));
  rooms[ST1] = { type: "MAIN" };
  await assert.rejects(submitQuiz(0, ST1, Q.DELETED), appError(404, "QUIZ_NOT_FOUND"));
  db.tables.classStudent[0].isActive = false;
  await assert.rejects(submitQuiz(0), appError(404, "NOT_FOUND"));
  assert.deepEqual(ownAttempt(), before);
});

test("submit: exact lock order (quiz FOR KEY SHARE before the attempt FOR UPDATE, never after)", async () => {
  await start();
  await submitQuiz(0);
  const order = db.calls
    .filter((c) => c.tx === db.lastTx())
    .map((c) => (c.kind === "raw" ? c.sql.replace(/ WHERE .*(FOR KEY SHARE|FOR UPDATE)$/, " … $1") : `${c.model}.${c.method}`));
  assert.deepEqual(order, [
    "classSession.findFirst",
    "student.findFirst",
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" … FOR KEY SHARE',
    "student.findFirst",
    'SELECT "id", "classSessionId", "state"::text AS "state", "status", "targetRoomType"::text AS "targetRoomType", "targetRoomId" FROM "BreakoutQuiz" … FOR KEY SHARE',
    "breakoutQuiz.findUniqueOrThrow",
    'SELECT "id" FROM "BreakoutQuizSubmission" … FOR UPDATE',
    "breakoutQuizSubmission.findUniqueOrThrow",
    "breakoutQuizSubmission.update",
  ]);
  assert.deepEqual(db.transactions.at(-1), { maxWait: 5000, timeout: 15000 });
});

// ---- Lazy auto-submit on reads (Stage 3.2.5) -----------------------------------------------

const attemptWrites = () => db.calls.filter((c) => c.model === "breakoutQuizSubmission" && ["update", "updateMany", "createMany"].includes(c.method)).length;
async function startedWithSavedAnswers() {
  clock = new Date("2026-11-06T09:00:00.000Z");
  await start();
  await save({ ...ans.single(1), ...ans.tf(true) }, 0); // 2 + 1 = 3
  return ownAttempt().deadlineAt.getTime();
}

test("lazy: the quiz detail auto-submits an attempt past deadline + 5 s, grading the SAVED answers unchanged", async () => {
  const deadline = await startedWithSavedAnswers();
  const savedAnswers = structuredClone(ownAttempt().answers);
  clock = new Date(deadline + 5_001);
  const res = await get(Q.MAIN);
  assert.deepEqual(res.attempt, { attemptStatus: "AUTO_SUBMITTED", finalScore: 3, totalMarks: 7, submittedAt: new Date(deadline + 5_000).toISOString() });
  const row = ownAttempt();
  assert.equal(row.attemptStatus, "AUTO_SUBMITTED");
  assert.deepEqual(row.answers, savedAnswers, "answers never replaced");
  assert.equal(row.revision, 1);
  assert.equal(row.submittedAt.toISOString(), new Date(deadline + 5_000).toISOString(), "L3: deadline + 5 s (earlier than now)");
  assert.equal(row.updatedAt.toISOString(), clock.toISOString(), "explicit updatedAt");
  assert.equal(row.autoScore, 3);
  assert.equal(row.finalScore, 3);
  assert.equal(row.grading.questions[SINGLE.id].result, "correct");
  assertNoLeak(res);
});

test("lazy: the quiz list auto-submits an expired attempt too (score only before CLOSED)", async () => {
  const deadline = await startedWithSavedAnswers();
  clock = new Date(deadline + 60_000);
  const listed = await list();
  assert.deepEqual(listed.quizzes.find((q) => q.id === Q.MAIN).mine, {
    attemptStatus: "AUTO_SUBMITTED",
    finalScore: 3,
    totalMarks: 7,
    submittedAt: new Date(deadline + 5_000).toISOString(),
  });
  assert.equal(ownAttempt().attemptStatus, "AUTO_SUBMITTED");
  assert.equal(ownAttempt().updatedAt.toISOString(), clock.toISOString(), "updatedAt: the database clock of the write");
  assertNoLeak(listed);
});

test("lazy: exactly +5 s is NOT expired; +5.001 s is (strict boundary); untimed attempts never are", async () => {
  const deadline = await startedWithSavedAnswers();
  clock = new Date(deadline + 5_000);
  const before = attemptWrites();
  const txBefore = db.transactions.length;
  assert.equal((await get(Q.MAIN)).attempt.attemptStatus, "IN_PROGRESS");
  assert.equal((await list()).quizzes[0].mine.attemptStatus, "IN_PROGRESS");
  assert.equal(attemptWrites(), before, "no write at exactly +5 s");
  assert.equal(db.transactions.length, txBefore, "and no transaction");
  clock = new Date(deadline + 5_001);
  assert.equal((await get(Q.MAIN)).attempt.attemptStatus, "AUTO_SUBMITTED");

  db.tables.breakoutQuizSubmission = [];
  db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).timeLimitSeconds = null;
  clock = new Date("2026-11-06T09:00:00.000Z");
  await start();
  clock = new Date("2026-11-09T09:00:00.000Z");
  const txUntimed = db.transactions.length;
  assert.equal((await get(Q.MAIN)).attempt.attemptStatus, "IN_PROGRESS", "untimed: never auto-submitted by a read");
  assert.equal((await list()).quizzes[0].mine.attemptStatus, "IN_PROGRESS");
  assert.equal(db.transactions.length, txUntimed);
});

test("lazy: already submitted attempts are never updated again by reads", async () => {
  const deadline = await startedWithSavedAnswers();
  await submitQuiz(1);
  const stored = structuredClone(ownAttempt());
  const before = attemptWrites();
  const txBefore = db.transactions.length;
  clock = new Date(deadline + 3_600_000);
  await get(Q.MAIN);
  await list();
  assert.equal(attemptWrites(), before);
  assert.equal(db.transactions.length, txBefore, "no transaction for a submitted attempt");
  assert.deepEqual(ownAttempt(), stored);
});

test("lazy: concurrent reads auto-submit ONCE: a read that saw a stale IN_PROGRESS re-checks under the lock and writes nothing", async () => {
  const deadline = await startedWithSavedAnswers();
  const stale = structuredClone(ownAttempt()); // what the second read saw, lock-free, before the first committed
  clock = new Date(deadline + 10_000);
  await get(Q.MAIN); // the first read auto-submits
  assert.equal(attemptWrites(), 3, "start, save, one auto-submit"); // createMany, update (save), update (auto)
  const firstResult = structuredClone(ownAttempt());

  const realFindFirst = db.client.breakoutQuizSubmission.findFirst;
  const realFindMany = db.client.breakoutQuizSubmission.findMany;
  db.client.breakoutQuizSubmission.findFirst = async () => structuredClone(stale);
  db.client.breakoutQuizSubmission.findMany = async () => [structuredClone(stale)];
  try {
    clock = new Date(deadline + 11_000);
    const second = await get(Q.MAIN);
    const third = await list();
    assert.equal(second.attempt.attemptStatus, "AUTO_SUBMITTED", "the committed result is returned");
    assert.equal(third.quizzes[0].mine.attemptStatus, "AUTO_SUBMITTED");
  } finally {
    db.client.breakoutQuizSubmission.findFirst = realFindFirst;
    db.client.breakoutQuizSubmission.findMany = realFindMany;
  }
  assert.equal(attemptWrites(), 3, "no second auto-submit write");
  assert.deepEqual(ownAttempt(), firstResult, "submittedAt / scores from the first auto-submit kept");
});

test("lazy: a normal read with nothing expired is read-only: no transaction, no lock, no write", async () => {
  await startedWithSavedAnswers();
  clock = new Date("2026-11-06T09:05:00.000Z");
  const tx = db.transactions.length;
  const callsBefore = db.calls.length;
  await get(Q.MAIN);
  await list();
  const newCalls = db.calls.slice(callsBefore);
  assert.equal(db.transactions.length, tx);
  assert.equal(newCalls.filter((c) => c.kind === "raw").length, 0, "no lock statement");
  assert.equal(newCalls.filter((c) => ["create", "createMany", "update", "updateMany"].includes(c.method)).length, 0);
});

test("lazy: exact lock order: session, enrolment, quiz FOR KEY SHARE, then the attempt FOR UPDATE; never a quiz lock after it", async () => {
  const deadline = await startedWithSavedAnswers();
  clock = new Date(deadline + 6_000);
  await get(Q.MAIN);
  const order = db.calls
    .filter((c) => c.tx === db.lastTx())
    .map((c) => (c.kind === "raw" ? c.sql.replace(/ WHERE .*(FOR KEY SHARE|FOR UPDATE)$/, " … $1") : `${c.model}.${c.method}`));
  assert.deepEqual(order, [
    "classSession.findFirst",
    "student.findFirst",
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" … FOR KEY SHARE',
    "student.findFirst",
    'SELECT "id", "classSessionId", "state"::text AS "state", "status", "targetRoomType"::text AS "targetRoomType", "targetRoomId" FROM "BreakoutQuiz" … FOR KEY SHARE',
    "breakoutQuiz.findUniqueOrThrow",
    'SELECT "id" FROM "BreakoutQuizSubmission" … FOR UPDATE',
    "breakoutQuizSubmission.findUniqueOrThrow",
    "breakoutQuizSubmission.update",
  ]);
  const attemptLockAt = order.findIndex((o) => o.includes('"BreakoutQuizSubmission" … FOR UPDATE'));
  assert.equal(order.slice(attemptLockAt).some((o) => o.includes('"BreakoutQuiz" …')), false);
  assert.deepEqual(db.transactions.at(-1), { maxWait: 5000, timeout: 15000 });
});

test("lazy: privacy after CLOSED (review, no raw grading); a closed quiz never attempted stays metadata only", async () => {
  const deadline = await startedWithSavedAnswers();
  db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).state = "CLOSED";
  clock = new Date(deadline + 7_000);
  const res = await get(Q.MAIN);
  assert.equal(res.attempt.attemptStatus, "AUTO_SUBMITTED");
  assert.ok(Array.isArray(res.attempt.review));
  assertNoLeak(res, { keysAllowed: true });
  const never = await get(Q.CLOSED);
  assert.deepEqual(never.attempt, { attemptStatus: null });
  assert.equal("questions" in never.quiz, false);
});

test("lazy: the default resolver still fails closed and the previous room stays hidden (nothing auto-submitted)", async () => {
  const deadline = await startedWithSavedAnswers();
  clock = new Date(deadline + 9_000);
  await assert.rejects(get(Q.MAIN, ST1, {}), appError(404, "NOT_FOUND"));
  await assert.rejects(list(ST1, {}), appError(404, "NOT_FOUND"));
  rooms[ST1] = { type: "BREAKOUT", id: "r1" };
  await assert.rejects(get(Q.MAIN), appError(404, "QUIZ_NOT_FOUND"));
  assert.deepEqual((await list()).quizzes.map((q) => q.id), [Q.R1]);
  assert.equal(ownAttempt().attemptStatus, "IN_PROGRESS", "a hidden quiz is not touched by reads");
});

test("full flow: start, save, stale save, submit, repeated submit, teacher override, close: privacy at every step", async () => {
  const s = await start();
  assert.equal(s.started, true);
  assertNoLeak(s);
  const saved = await save({ ...ans.single(1), [MULTIPLE.id]: { kind: "multiple", optionIds: [MULTIPLE.options[1].id] } }, 0);
  assert.equal(saved.attempt.revision, 1);
  await assert.rejects(save(ans.tf(true), 0), appError(409, "REVISION_CONFLICT"));
  const submitted = await submitQuiz(1);
  assert.deepEqual(submitted.attempt, { attemptStatus: "SUBMITTED", finalScore: 3.5, totalMarks: 7, submittedAt: clock.toISOString() });
  assert.equal((await submitQuiz(1)).replayed, true);
  await assert.rejects(save(ans.tf(true), 1), appError(409, "QUIZ_ALREADY_SUBMITTED"));
  const row = ownAttempt();
  row.grading.questions[TF.id].override = { marks: 1, teacherId: "t1", at: clock.toISOString() };
  row.finalScore = 4.5;
  assert.equal((await get(Q.MAIN)).attempt.finalScore, 4.5, "the override shows");
  assertNoLeak(await get(Q.MAIN));
  db.tables.breakoutQuiz.find((q) => q.id === Q.MAIN).state = "CLOSED";
  const review = (await get(Q.MAIN)).attempt.review;
  assert.equal(review.find((r) => r.id === TF.id).awarded, 1);
  assert.equal(review.find((r) => r.id === MULTIPLE.id).result, "partial");
});

// ---- Audit fixes L3 / L4 -------------------------------------------------------------------

const txOrder = () =>
  db.calls
    .filter((c) => c.tx === db.lastTx())
    .map((c) => (c.kind === "raw" ? c.sql.replace(/ WHERE .*(FOR KEY SHARE|FOR UPDATE)$/, " … $1") : `${c.model}.${c.method}`));

test("L3: a save at exactly +5 s is SAVED (no submittedAt); at +5.001 s the auto-submit's submittedAt is capped at +5 s", async () => {
  await start();
  const deadline = ownAttempt().deadlineAt.getTime();
  clock = new Date(deadline + 5_000);
  const saved = await save(ans.tf(true), 0);
  assert.equal(saved.attempt.attemptStatus, "IN_PROGRESS");
  assert.equal(ownAttempt().submittedAt ?? null, null);
  clock = new Date(deadline + 5_001);
  await assert.rejects(save(ans.tf(false), 1), appError(409, "QUIZ_TIME_UP"));
  const row = ownAttempt();
  assert.equal(row.submittedAt.toISOString(), new Date(deadline + 5_000).toISOString());
  assert.equal(row.updatedAt.toISOString(), clock.toISOString());
  assert.ok(row.lastSavedAt.getTime() <= row.submittedAt.getTime(), "never earlier than the last accepted save");
});

test("L3: a manual submit inside the grace is SUBMITTED at now (unchanged)", async () => {
  await start();
  const deadline = ownAttempt().deadlineAt.getTime();
  clock = new Date(deadline + 4_000);
  const res = await submitQuiz(0);
  assert.equal(res.attempt.attemptStatus, "SUBMITTED");
  assert.equal(ownAttempt().submittedAt.toISOString(), clock.toISOString());
});

test("L3: a leftover IN_PROGRESS attempt on a CLOSED quiz found before its deadline records now", async () => {
  await attempt(Q.CLOSED, ST1, "IN_PROGRESS", ans.tf(true), { revision: 0 }); // deadline = clock + 600 s
  clock = new Date(clock.getTime() + 60_000);
  await assert.rejects(save(ans.tf(false), 0, ST1, Q.CLOSED), appError(409, "QUIZ_CLOSED"));
  assert.equal(ownAttempt(Q.CLOSED).submittedAt.toISOString(), clock.toISOString(), "min(now, deadline + 5 s) = now");
});

test("L4: start on a CLOSED quiz with no attempt: still 409 QUIZ_CLOSED, nothing created", async () => {
  await assert.rejects(start(Q.CLOSED), appError(409, "QUIZ_CLOSED"));
  assert.equal(db.tables.breakoutQuizSubmission.length, 0);
});

test("L4: start on a CLOSED quiz with a SUBMITTED / AUTO_SUBMITTED attempt: the stored result as it is (overrides kept), no write", async () => {
  for (const status of ["SUBMITTED", "AUTO_SUBMITTED"]) {
    db.tables.breakoutQuizSubmission.length = 0;
    clock = new Date("2026-11-06T09:00:00.000Z");
    const row = await attempt(Q.CLOSED, ST1, status, ans.tf(false));
    row.grading.questions[TF.id].override = { marks: 1, teacherId: "t1", at: clock.toISOString(), note: "Accepted" };
    row.finalScore = 1;
    row.overriddenAt = clock;
    const before = structuredClone(row);
    const writesBefore = attemptWrites();
    clock = new Date(clock.getTime() + 3_600_000);
    const res = await start(Q.CLOSED);
    assert.equal(res.started, false);
    assert.equal(res.attempt.attemptStatus, status);
    assert.equal(res.attempt.finalScore, 1, "the teacher's override counts");
    const tf = res.attempt.review.find((r) => r.id === TF.id);
    assert.deepEqual([tf.awarded, tf.result, tf.note], [1, "correct", "Accepted"]);
    assert.deepEqual(ownAttempt(Q.CLOSED), before, "the stored row is unchanged");
    assert.equal(attemptWrites(), writesBefore, "no write");
    assert.equal(db.tables.breakoutQuizSubmission.length, 1);
    assertNoLeak(res, { keysAllowed: true });
  }
});

test("L4: start on a CLOSED quiz with an IN_PROGRESS attempt: auto-submitted with its SAVED answers, in the lock order", async () => {
  const saved = { ...ans.single(1), ...ans.tf(true) }; // 2 + 1 marks
  await attempt(Q.CLOSED, ST1, "IN_PROGRESS", saved);
  const deadline = ownAttempt(Q.CLOSED).deadlineAt.getTime();
  clock = new Date(deadline + 60_000);
  const res = await start(Q.CLOSED);
  assert.equal(res.started, false);
  assert.equal(res.attempt.attemptStatus, "AUTO_SUBMITTED");
  assert.equal(res.attempt.finalScore, 3);
  assert.ok(Array.isArray(res.attempt.review), "CLOSED: the review");
  const row = ownAttempt(Q.CLOSED);
  assert.equal(row.attemptStatus, "AUTO_SUBMITTED");
  assert.deepEqual(row.answers, saved, "the saved answers, unchanged");
  assert.equal(row.autoScore, 3);
  assert.equal(row.submittedAt.toISOString(), new Date(deadline + 5_000).toISOString(), "the L3 rule");
  assert.equal(row.updatedAt.toISOString(), clock.toISOString());
  assert.equal(db.tables.breakoutQuizSubmission.length, 1, "no second attempt");
  assert.equal(db.calls.filter((c) => c.method === "createMany").length, 0, "no insert attempted");
  assertNoLeak(res, { keysAllowed: true });

  const order = txOrder();
  const sessionLockAt = order.findIndex((o) => o.includes('"ClassSession" … FOR KEY SHARE'));
  const quizLockAt = order.findIndex((o) => o.includes('"BreakoutQuiz" … FOR KEY SHARE'));
  const attemptLockAt = order.findIndex((o) => o.includes('"BreakoutQuizSubmission" … FOR UPDATE'));
  assert.ok(sessionLockAt >= 0 && sessionLockAt < quizLockAt && quizLockAt < attemptLockAt, "session -> quiz -> attempt");
  assert.equal(order.slice(attemptLockAt).some((o) => o.includes('"BreakoutQuiz" …')), false, "no quiz lock after the attempt lock");
  const readAt = order.indexOf("breakoutQuizSubmission.findUniqueOrThrow", attemptLockAt);
  const writeAt = order.indexOf("breakoutQuizSubmission.update");
  assert.ok(attemptLockAt < readAt && readAt < writeAt, "re-read under the attempt lock, then the write");

  // A repeat returns the same result without a second grading or write.
  const writes = attemptWrites();
  const again = await start(Q.CLOSED);
  assert.deepEqual(again.attempt, res.attempt);
  assert.equal(attemptWrites(), writes);
});

test("L4: the re-check under the lock wins: an attempt submitted concurrently is returned, not re-graded", async () => {
  const row = await attempt(Q.CLOSED, ST1, "IN_PROGRESS", ans.tf(true));
  const realTransaction = db.client.$transaction;
  db.client.$transaction = async (fn, o) =>
    realTransaction.call(
      db.client,
      async (tx) => {
        // A concurrent submit committed before this transaction read the attempt.
        row.attemptStatus = "SUBMITTED";
        row.submittedAt = new Date("2026-11-06T09:01:00.000Z");
        row.grading = { schemaVersion: 1, questions: {} };
        row.finalScore = 7;
        return fn(tx);
      },
      o
    );
  try {
    const writes = attemptWrites();
    const res = await start(Q.CLOSED);
    assert.equal(res.attempt.attemptStatus, "SUBMITTED");
    assert.equal(res.attempt.finalScore, 7, "the concurrent result, untouched");
    assert.equal(attemptWrites(), writes, "no auto-submit write");
  } finally {
    db.client.$transaction = realTransaction;
  }
});
