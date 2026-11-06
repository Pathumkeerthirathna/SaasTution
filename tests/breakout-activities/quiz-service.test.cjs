/*
 * Teacher quiz service (services/breakout-quiz-service.ts): server-built
 * definitions (ids, keys, totalMarks), all-or-nothing creation, state changes
 * per activity, close auto-submitting only IN_PROGRESS attempts (graded from
 * their saved answers), DRAFT-only edits and deletes, and grading overrides
 * under the approved restrictions, with the lock order session -> quiz ->
 * attempts and database-clock timestamps.
 *
 * Real service module; lib/prisma.ts is an in-memory fake (rolls back on
 * error) and lib/server-clock.ts a fixed clock. No database is contacted.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeBreakoutDb } = require("./helpers/fake-breakout-db.cjs");

let db;
let clock = new Date("2026-11-05T10:00:00.000Z");
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

const service = require(path.join(root, "services/breakout-quiz-service.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));
const { BREAKOUT_TRANSACTION_OPTIONS } = require(path.join(root, "lib/breakout-activities/locks.ts"));

const T1 = "teacher-1";
const T2 = "teacher-2";
const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";
const S2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const S3 = "1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b";
const ST1 = "a1111111-1111-4111-8111-111111111111";
const ST2 = "a2222222-2222-4222-8222-222222222222";
const ST3 = "a3333333-3333-4333-8333-333333333333";
const MAIN = { type: "MAIN" };

const QUESTIONS = [
  { kind: "true_false", prompt: "Is 2 even?", marks: 2, correct: true },
  { kind: "multiple", prompt: "Primes?", marks: 3, options: [{ text: "2", correct: true }, { text: "3", correct: true }, { text: "4" }] },
  { kind: "short", prompt: "Capital of Sri Lanka?", marks: 1.5, acceptedAnswers: ["Sri Jayawardenepura Kotte", "Kotte"] },
];

test.beforeEach(() => {
  clock = new Date("2026-11-05T10:00:00.000Z");
  db = createFakeBreakoutDb(); // @updatedAt fallback = an app clock far from the database clock
  db.tables.class.push({ id: "class-1", teacherId: T1 }, { id: "class-2", teacherId: T2 }, { id: "class-3", teacherId: T1 });
  db.tables.classSession.push(
    { id: S1, classId: "class-1", isActive: true },
    { id: S2, classId: "class-2", isActive: true },
    { id: S3, classId: "class-3", isActive: false }
  );
  db.tables.student.push(
    { id: ST1, name: "Nimal", registrationNumber: "R-1" },
    { id: ST2, name: "Kamala", registrationNumber: null },
    { id: ST3, name: "Ravi", registrationNumber: "R-3" }
  );
});

const appError = (status, code) => (e) => {
  assert.ok(e instanceof AppError, String(e?.stack ?? e));
  assert.equal(e.statusCode, status);
  assert.equal(e.code, code);
  return true;
};
const create = (overrides = {}, options = {}) =>
  service.createQuizzes({ teacherId: T1, sessionId: S1, title: "Quiz", questions: QUESTIONS, targets: [MAIN], publish: false, ...overrides }, options);
const quizRow = (id) => db.tables.breakoutQuiz.find((r) => r.id === id);
const setQuizState = (quizId, action, overrides = {}) => service.setQuizState({ teacherId: T1, sessionId: S1, quizId, action, ...overrides });

// ---- Create -----------------------------------------------------------------

test("create: server ids and answer keys by id, totalMarks computed, timestamps explicit, instructions '' stored as null", async () => {
  const result = await create({ instructions: "", timeLimitSeconds: 600 });
  const row = quizRow(result.quizzes[0].id);
  const def = row.questions;
  assert.equal(def.schemaVersion, 1);
  assert.equal(def.questions.length, 3);
  assert.ok(def.questions.every((q) => /^q[0-9a-f]{16}$/.test(q.id)));
  const multiple = def.questions[1];
  assert.equal(multiple.correctOptionIds.length, 2);
  assert.ok(multiple.options.every((o) => !("correct" in o)), "option texts carry no key");
  assert.equal(row.totalMarks, 6.5);
  assert.equal(row.instructions, null);
  assert.equal(row.timeLimitSeconds, 600);
  assert.equal(row.createdAt.toISOString(), clock.toISOString());
  assert.equal(row.teacherId, T1);
  assert.equal(result.quizzes[0].totalMarks, 6.5);
  assert.equal("questions" in result.quizzes[0], false, "the create response has no answer keys");
  assert.deepEqual(db.transactions, [BREAKOUT_TRANSACTION_OPTIONS]);
});

test("create + publish to several rooms: one group, one definition, all published together; ROOM_UNKNOWN refuses all", async () => {
  const roomDirectory = { listBreakoutRooms: async () => [{ id: "r1", name: "Room One" }] };
  const result = await create({ targets: [MAIN, { type: "BREAKOUT", id: "r1" }], publish: true }, { roomDirectory });
  const rows = db.tables.breakoutQuiz;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.publishGroupId === result.publishGroupId && r.state === "PUBLISHED" && r.publishedAt.toISOString() === clock.toISOString()));
  assert.deepEqual(rows[0].questions, rows[1].questions);
  await assert.rejects(create({ targets: [MAIN, { type: "BREAKOUT", id: "r2" }], publish: true }, { roomDirectory }), appError(409, "ROOM_UNKNOWN"));
  await assert.rejects(create({ targets: [MAIN, { type: "BREAKOUT", id: "r1" }] }), appError(409, "ROOM_UNKNOWN"), "default directory");
  assert.equal(db.tables.breakoutQuiz.length, 2, "nothing more was created");
});

test("ownership and session state", async () => {
  await assert.rejects(create({ sessionId: S2 }), appError(404, "SESSION_NOT_FOUND"));
  await assert.rejects(create({ teacherId: T2, sessionId: S3 }), appError(404, "SESSION_NOT_FOUND"));
  await assert.rejects(create({ sessionId: S3 }), appError(409, "SESSION_NOT_ACTIVE"));
});

// ---- State changes and close auto-submit ----------------------------------------

async function publishedQuiz() {
  const { quizzes } = await create({ publish: true });
  return quizzes[0].id;
}
function addAttempt(quizId, studentId, attemptStatus, answers, extra = {}) {
  const id = `e${String(db.tables.breakoutQuizSubmission.length).padStart(7, "0")}-0000-4000-8000-000000000000`;
  db.tables.breakoutQuizSubmission.push({
    id,
    quizId,
    classSessionId: S1,
    studentId,
    attemptStatus,
    answers,
    revision: 1,
    startedAt: new Date("2026-11-05T09:50:00.000Z"),
    deadlineAt: null,
    lastSavedAt: null,
    submittedAt: null,
    grading: null,
    autoScore: null,
    finalScore: null,
    overriddenAt: null,
    ...extra,
  });
  return id;
}
const attempt = (id) => db.tables.breakoutQuizSubmission.find((r) => r.id === id);
const answersFor = (quizId, picks) => {
  const def = quizRow(quizId).questions;
  const [tf, multi, short] = def.questions;
  const answers = {};
  if (picks.tf !== undefined) answers[tf.id] = { kind: "true_false", value: picks.tf };
  if (picks.multi) answers[multi.id] = { kind: "multiple", optionIds: picks.multi.map((i) => multi.options[i].id) };
  if (picks.short !== undefined) answers[short.id] = { kind: "short", text: picks.short };
  return answers;
};

test("close: auto-submits IN_PROGRESS attempts with grades from saved answers; submitted attempts untouched", async () => {
  const quizId = await publishedQuiz();
  const inProgressA = addAttempt(quizId, ST1, "IN_PROGRESS", answersFor(quizId, { tf: true, multi: [0, 1], short: "  kotte " }));
  const inProgressB = addAttempt(quizId, ST2, "IN_PROGRESS", answersFor(quizId, { tf: false, multi: [0] }));
  const submitted = addAttempt(quizId, ST3, "SUBMITTED", answersFor(quizId, { tf: true }), {
    submittedAt: new Date("2026-11-05T09:55:00.000Z"),
    grading: { schemaVersion: 1, questions: {} },
    autoScore: 2,
    finalScore: 2,
  });
  const before = structuredClone(attempt(submitted));

  clock = new Date("2026-11-05T10:30:00.000Z");
  const result = await setQuizState(quizId, "close");
  assert.equal(result.autoSubmitted, 2);
  assert.equal(quizRow(quizId).state, "CLOSED");
  assert.equal(quizRow(quizId).closedAt.toISOString(), clock.toISOString());

  const a = attempt(inProgressA);
  assert.equal(a.attemptStatus, "AUTO_SUBMITTED");
  assert.equal(a.submittedAt.toISOString(), clock.toISOString());
  assert.equal(a.autoScore, 6.5, "all correct (short answer normalized)");
  assert.equal(a.finalScore, 6.5);
  const b = attempt(inProgressB);
  assert.equal(b.attemptStatus, "AUTO_SUBMITTED");
  assert.equal(b.autoScore, 1.5, "tf wrong 0, multiple 1 of 2 correct = 1.5, short unanswered 0");
  assert.deepEqual(attempt(submitted), before, "an already submitted attempt is not modified");

  assert.deepEqual(db.rawSql(), [
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ? FOR KEY SHARE',
    'SELECT "id", "state"::text AS "state", "status" FROM "BreakoutQuiz" WHERE "id" = ? AND "classSessionId" = ? FOR UPDATE',
    `SELECT "id" FROM "BreakoutQuizSubmission" WHERE "quizId" = ? AND "classSessionId" = ? AND "attemptStatus" = 'IN_PROGRESS' ORDER BY "id" FOR UPDATE`,
  ], "session -> quiz -> attempts (id order)");
});

test("close only touches attempts of this quiz in this session", async () => {
  const quizId = await publishedQuiz();
  const otherQuiz = await publishedQuiz();
  const other = addAttempt(otherQuiz, ST1, "IN_PROGRESS", {});
  const foreign = addAttempt(quizId, ST2, "IN_PROGRESS", {}, { classSessionId: S2 });
  const result = await setQuizState(quizId, "close");
  assert.equal(result.autoSubmitted, 0);
  assert.equal(attempt(other).attemptStatus, "IN_PROGRESS");
  assert.equal(attempt(foreign).attemptStatus, "IN_PROGRESS");
});

test("transitions: per activity, repeats change nothing, invalid ones are 409", async () => {
  const roomDirectory = { listBreakoutRooms: async () => [{ id: "r1", name: "Room One" }] };
  const { quizzes } = await create({ targets: [MAIN, { type: "BREAKOUT", id: "r1" }] }, { roomDirectory });
  const [q1, q2] = quizzes.map((q) => q.id);
  await assert.rejects(setQuizState(q1, "close"), appError(409, "ACTIVITY_NOT_PUBLISHED"));
  clock = new Date("2026-11-05T10:05:00.000Z");
  await setQuizState(q1, "publish");
  assert.equal(quizRow(q1).publishedAt.toISOString(), clock.toISOString());
  assert.equal(quizRow(q2).state, "DRAFT", "the rest of the group is unchanged");
  const snapshot = structuredClone(quizRow(q1));
  assert.equal((await setQuizState(q1, "publish")).changed, false);
  assert.deepEqual(quizRow(q1), snapshot);
  await setQuizState(q1, "close");
  assert.equal((await setQuizState(q1, "close")).changed, false);
  await assert.rejects(setQuizState(q1, "publish"), appError(409, "QUIZ_CLOSED"));
  await assert.rejects(setQuizState("f0000000-0000-4000-8000-000000000000", "publish"), appError(404, "QUIZ_NOT_FOUND"));
  await assert.rejects(setQuizState(q2, "publish", { teacherId: T2 }), appError(404, "SESSION_NOT_FOUND"));
});

test("a failure during close rolls back the quiz and every attempt", async () => {
  const quizId = await publishedQuiz();
  const a = addAttempt(quizId, ST1, "IN_PROGRESS", {});
  const b = addAttempt(quizId, ST2, "IN_PROGRESS", {});
  db.failOn("breakoutQuizSubmission.update", 2);
  await assert.rejects(setQuizState(quizId, "close"), /injected failure/);
  assert.equal(quizRow(quizId).state, "PUBLISHED");
  assert.equal(attempt(a).attemptStatus, "IN_PROGRESS");
  assert.equal(attempt(b).attemptStatus, "IN_PROGRESS");
});

// ---- Edits and delete -------------------------------------------------------

test("edits: DRAFT only; new questions replace the definition and totalMarks; '' clears instructions", async () => {
  const { quizzes } = await create({ instructions: "Read carefully" });
  const quizId = quizzes[0].id;
  const edit = (changes) => service.editQuiz({ teacherId: T1, sessionId: S1, quizId, ...changes });
  const oldIds = quizRow(quizId).questions.questions.map((q) => q.id);
  await edit({ questions: [{ kind: "true_false", prompt: "Sky is blue?", marks: 4, correct: true }], instructions: "", timeLimitSeconds: null });
  const row = quizRow(quizId);
  assert.equal(row.totalMarks, 4);
  assert.equal(row.questions.questions.length, 1);
  assert.ok(!oldIds.includes(row.questions.questions[0].id));
  assert.equal(row.instructions, null);
  assert.equal(row.timeLimitSeconds, null);
  await assert.rejects(edit({}), appError(400, "VALIDATION_ERROR"));
  await setQuizState(quizId, "publish");
  await assert.rejects(edit({ title: "x" }), appError(409, "ACTIVITY_NOT_DRAFT"));
  await setQuizState(quizId, "close");
  await assert.rejects(edit({ title: "x" }), appError(409, "QUIZ_CLOSED"));
});

test("delete: DRAFT only, soft", async () => {
  const { quizzes } = await create();
  const quizId = quizzes[0].id;
  const del = () => service.deleteQuiz({ teacherId: T1, sessionId: S1, quizId });
  assert.deepEqual(await del(), { id: quizId, status: 1 });
  assert.equal(quizRow(quizId).status, 1);
  await assert.rejects(del(), appError(404, "QUIZ_NOT_FOUND"));
  const published = await publishedQuiz();
  await assert.rejects(service.deleteQuiz({ teacherId: T1, sessionId: S1, quizId: published }), appError(409, "ACTIVITY_NOT_DRAFT"));
  await setQuizState(published, "close");
  await assert.rejects(service.deleteQuiz({ teacherId: T1, sessionId: S1, quizId: published }), appError(409, "QUIZ_CLOSED"));
});

// ---- Grading overrides -------------------------------------------------------

async function submittedAttempt(status = "SUBMITTED") {
  const quizId = await publishedQuiz();
  const answers = answersFor(quizId, { tf: true, multi: [0], short: "Colombo" });
  const id = addAttempt(quizId, ST1, status, answers, { submittedAt: new Date("2026-11-05T10:01:00.000Z") });
  // Graded as at submission (what Step 3 will store).
  const marking = await import(require("node:url").pathToFileURL(path.join(root, "lib/breakout-activities/marking.mjs")).href);
  const grading = marking.gradeAttempt(quizRow(quizId).questions, answers);
  const scores = marking.computeScores(grading);
  Object.assign(attempt(id), { grading, autoScore: scores.autoScore, finalScore: scores.finalScore });
  return { quizId, id, def: quizRow(quizId).questions };
}
const override = (quizId, submissionId, overrides, extra = {}) =>
  service.overrideQuizGrading({ teacherId: T1, sessionId: S1, quizId, submissionId, overrides, ...extra });

test("override: SUBMITTED or AUTO_SUBMITTED; finalScore recomputed, autoScore kept, overriddenAt from the clock; lock order", async () => {
  for (const status of ["SUBMITTED", "AUTO_SUBMITTED"]) {
    const { quizId, id, def } = await submittedAttempt(status);
    const shortId = def.questions[2].id;
    assert.equal(attempt(id).autoScore, 3.5, "tf 2 + multiple 1.5 + short 0");
    clock = new Date("2026-11-05T11:00:00.000Z");
    const result = await override(quizId, id, [{ questionId: shortId, marks: 1.5, note: " spelling accepted " }]);
    assert.equal(result.autoScore, 3.5);
    assert.equal(result.finalScore, 5);
    assert.equal(attempt(id).finalScore, 5);
    assert.equal(attempt(id).overriddenAt.toISOString(), clock.toISOString());
    const stored = attempt(id).grading.questions[shortId].override;
    assert.deepEqual(stored, { marks: 1.5, teacherId: T1, at: clock.toISOString(), note: "spelling accepted" });
    assert.deepEqual(db.rawSql(), [
      "SET LOCAL lock_timeout = '3000ms'",
      'SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ? FOR KEY SHARE',
      'SELECT "id" FROM "BreakoutQuizSubmission" WHERE "id" = ? AND "quizId" = ? AND "classSessionId" = ? FOR UPDATE',
    ]);
  }
});

test("override on a CLOSED quiz is allowed; null removes an override", async () => {
  const { quizId, id, def } = await submittedAttempt();
  const shortId = def.questions[2].id;
  await override(quizId, id, [{ questionId: shortId, marks: 1 }]);
  await setQuizState(quizId, "close");
  const removed = await override(quizId, id, [{ questionId: shortId, marks: null }]);
  assert.equal(removed.finalScore, 3.5);
});

test("override restrictions: IN_PROGRESS 409 QUIZ_NOT_SUBMITTED; DRAFT quiz 409; ended session 409; scoping 404", async () => {
  const { quizId, id, def } = await submittedAttempt();
  const qid = def.questions[0].id;
  const inProgress = addAttempt(quizId, ST2, "IN_PROGRESS", {});
  await assert.rejects(override(quizId, inProgress, [{ questionId: qid, marks: 1 }]), appError(409, "QUIZ_NOT_SUBMITTED"));
  assert.equal(attempt(inProgress).grading, null, "nothing written");

  const { quizzes } = await create();
  const draftQuiz = quizzes[0].id;
  const draftAttempt = addAttempt(draftQuiz, ST3, "SUBMITTED", {});
  await assert.rejects(override(draftQuiz, draftAttempt, [{ questionId: qid, marks: 1 }]), appError(409, "ACTIVITY_NOT_PUBLISHED"));

  const otherQuiz = await publishedQuiz();
  await assert.rejects(override(otherQuiz, id, [{ questionId: qid, marks: 1 }]), appError(404, "NOT_FOUND"), "attempt of another quiz");
  await assert.rejects(override(quizId, "bad-id", [{ questionId: qid, marks: 1 }]), appError(404, "NOT_FOUND"));
  await assert.rejects(override(quizId, id, [{ questionId: qid, marks: 1 }], { teacherId: T2 }), appError(404, "SESSION_NOT_FOUND"));

  db.tables.classSession.find((s) => s.id === S1).isActive = false;
  await assert.rejects(override(quizId, id, [{ questionId: qid, marks: 1 }]), appError(409, "SESSION_NOT_ACTIVE"));
});

test("override marks are checked by the marking rules (400, nothing written)", async () => {
  const { quizId, id, def } = await submittedAttempt();
  const before = structuredClone(attempt(id));
  await assert.rejects(override(quizId, id, [{ questionId: def.questions[0].id, marks: 2.5 }]), appError(400, "OVERRIDE_OUT_OF_RANGE"));
  await assert.rejects(override(quizId, id, [{ questionId: "qffffffffffffffff", marks: 1 }]), appError(400, "UNKNOWN_QUESTION"));
  await assert.rejects(
    override(quizId, id, [{ questionId: def.questions[0].id, marks: 1 }, { questionId: def.questions[0].id, marks: 2 }]),
    appError(400, "DUPLICATE_OVERRIDE")
  );
  assert.deepEqual(attempt(id), before);
});

// ---- Reads ------------------------------------------------------------------

test("reads: list (no keys) with counts, full definition for the teacher, attempts with students; scoped", async () => {
  const quizId = await publishedQuiz();
  addAttempt(quizId, ST1, "IN_PROGRESS", {});
  addAttempt(quizId, ST2, "SUBMITTED", {}, { autoScore: 1, finalScore: 1 });
  const list = await service.listQuizzesForTeacher(T1, S1);
  assert.deepEqual(list.quizzes[0].counts, { attempts: 2, inProgress: 1, submitted: 1 });
  assert.equal("questions" in list.quizzes[0], false);

  const full = await service.getQuizForTeacher({ teacherId: T1, sessionId: S1, quizId });
  assert.equal(full.quiz.questions.questions[0].correct, true, "the teacher sees the answer keys");

  const attempts = await service.listQuizAttemptsForTeacher({ teacherId: T1, sessionId: S1, quizId });
  assert.equal(attempts.attempts.length, 2);
  assert.deepEqual(attempts.attempts[0].student, { id: ST1, name: "Nimal", registrationNumber: "R-1" });
  assert.equal(attempts.attempts[1].finalScore, 1);

  await assert.rejects(service.getQuizForTeacher({ teacherId: T2, sessionId: S1, quizId }), appError(404, "SESSION_NOT_FOUND"));
  await assert.rejects(service.getQuizForTeacher({ teacherId: T1, sessionId: S1, quizId: "f0000000-0000-4000-8000-000000000000" }), appError(404, "QUIZ_NOT_FOUND"));
});

// ---- F1: explicit updatedAt; F5: stored grading validated ----------------------

test("F1: every quiz and attempt write passes updatedAt explicitly from the database clock", async () => {
  const actions = [
    ["create", () => create()],
    ["edit", (q) => service.editQuiz({ teacherId: T1, sessionId: S1, quizId: q, title: "Edited" })],
    ["publish", (q) => setQuizState(q, "publish")],
    ["close (+ auto-submit)", (q) => setQuizState(q, "close")],
    ["override", (q) => override(q, overrideTarget, [{ questionId: quizRow(q).questions.questions[0].id, marks: 1 }])],
  ];
  let quizId;
  let overrideTarget;
  for (const [i, [name, run]] of actions.entries()) {
    clock = new Date(Date.UTC(2026, 10, 5, 11, i));
    if (name === "close (+ auto-submit)") {
      addAttempt(quizId, ST1, "IN_PROGRESS", {});
      overrideTarget = addAttempt(quizId, ST2, "IN_PROGRESS", {});
    }
    const result = await run(quizId);
    if (name === "create") quizId = result.quizzes[0].id;
    const writes = db.calls.filter((c) => c.tx === db.lastTx() && (c.method === "create" || c.method === "update"));
    assert.ok(writes.length > 0, name);
    for (const w of writes) {
      assert.ok(w.args.data.updatedAt, `${name}: updatedAt passed explicitly (${w.model})`);
      assert.equal(new Date(w.args.data.updatedAt).toISOString(), clock.toISOString(), `${name}: from the database clock`);
    }
  }
  const { quizzes } = await create();
  clock = new Date(Date.UTC(2026, 10, 5, 12, 0));
  await service.deleteQuiz({ teacherId: T1, sessionId: S1, quizId: quizzes[0].id });
  assert.equal(quizRow(quizzes[0].id).updatedAt.toISOString(), clock.toISOString(), "delete too");
  for (const r of [...db.tables.breakoutQuiz, ...db.tables.breakoutQuizSubmission.filter((s) => s.attemptStatus !== "IN_PROGRESS")]) {
    assert.notEqual(r.updatedAt?.getUTCFullYear(), 1999, "no write was left to the app clock");
  }
});

test("F5: a valid stored grading is used; a corrupt or mismatched one refuses the override (500 path, nothing written)", async () => {
  const { quizId, id, def } = await submittedAttempt();
  const qid = def.questions[2].id;
  const good = structuredClone(attempt(id).grading);

  const corrupt = [
    ["not an object", "garbage"],
    ["wrong schema version", { ...good, schemaVersion: 2 }],
    ["a question missing", { schemaVersion: 1, questions: Object.fromEntries(Object.entries(good.questions).slice(1)) }],
    ["an extra question", { schemaVersion: 1, questions: { ...good.questions, qffffffffffffffff: { auto: 0, result: "unanswered" } } }],
    ["auto above the question's marks", { schemaVersion: 1, questions: { ...good.questions, [qid]: { auto: 99, result: "correct" } } }],
    ["negative auto", { schemaVersion: 1, questions: { ...good.questions, [qid]: { auto: -1, result: "incorrect" } } }],
    ["unknown result", { schemaVersion: 1, questions: { ...good.questions, [qid]: { auto: 0, result: "maybe" } } }],
    ["unknown field", { schemaVersion: 1, questions: { ...good.questions, [qid]: { auto: 0, result: "unanswered", bonus: 5 } } }],
    ["override above marks", { schemaVersion: 1, questions: { ...good.questions, [qid]: { auto: 0, result: "unanswered", override: { marks: 9, teacherId: T1, at: clock.toISOString() } } } }],
    ["override without a teacher", { schemaVersion: 1, questions: { ...good.questions, [qid]: { auto: 0, result: "unanswered", override: { marks: 1, at: clock.toISOString() } } } }],
  ];
  for (const [label, grading] of corrupt) {
    attempt(id).grading = grading;
    const before = structuredClone(attempt(id));
    await assert.rejects(override(quizId, id, [{ questionId: qid, marks: 1 }]), (e) => {
      assert.ok(!(e instanceof AppError), `${label}: a server fault, not a client error`);
      assert.match(e.message, /Stored grading .* is invalid/);
      return true;
    }, label);
    assert.deepEqual(attempt(id), before, `${label}: nothing written, nothing re-graded`);
  }

  attempt(id).grading = good;
  const ok = await override(quizId, id, [{ questionId: qid, marks: 1 }]);
  assert.equal(ok.finalScore, 4.5);

  attempt(id).grading = null; // never graded: graded now from the saved answers
  const regraded = await override(quizId, id, [{ questionId: qid, marks: 1 }]);
  assert.equal(regraded.autoScore, 3.5);
  assert.equal(regraded.finalScore, 4.5);
});

// ---- Audit fix L3: submittedAt of attempts auto-submitted by the close ------------------

test("L3 close: submittedAt = min(close time, deadlineAt + 5 s); untimed = close time; updatedAt = close time", async () => {
  const quizId = await publishedQuiz();
  const answers = answersFor(quizId, { tf: true });
  const notYet = addAttempt(quizId, ST1, "IN_PROGRESS", answers, { deadlineAt: new Date("2026-11-05T10:20:00.000Z") });
  const expired = addAttempt(quizId, ST2, "IN_PROGRESS", answers, { deadlineAt: new Date("2026-11-05T10:00:00.000Z") });
  const untimed = addAttempt(quizId, ST3, "IN_PROGRESS", answers, { deadlineAt: null });
  clock = new Date("2026-11-05T10:15:00.000Z"); // before ST1's deadline, long after ST2's
  assert.equal((await setQuizState(quizId, "close")).autoSubmitted, 3);
  assert.equal(attempt(notYet).submittedAt.toISOString(), clock.toISOString(), "cut short by the close: the close time");
  assert.equal(attempt(expired).submittedAt.toISOString(), "2026-11-05T10:00:05.000Z", "already expired: deadline + 5 s");
  assert.equal(attempt(untimed).submittedAt.toISOString(), clock.toISOString(), "untimed: the close time");
  for (const id of [notYet, expired, untimed]) {
    assert.equal(attempt(id).attemptStatus, "AUTO_SUBMITTED");
    assert.equal(attempt(id).updatedAt.toISOString(), clock.toISOString(), "updatedAt: the database clock of the write");
  }
  assert.equal(quizRow(quizId).closedAt.toISOString(), clock.toISOString());
});

test("L3 close boundary: a close at exactly deadline + 5 s records it; 1 ms later is capped at deadline + 5 s", async () => {
  const deadline = new Date("2026-11-05T10:20:00.000Z");
  const quizA = await publishedQuiz();
  const inGrace = addAttempt(quizA, ST1, "IN_PROGRESS", {}, { deadlineAt: deadline });
  clock = new Date(deadline.getTime() + 5_000);
  await setQuizState(quizA, "close");
  assert.equal(attempt(inGrace).submittedAt.toISOString(), "2026-11-05T10:20:05.000Z");

  const quizB = await publishedQuiz();
  const late = addAttempt(quizB, ST2, "IN_PROGRESS", {}, { deadlineAt: deadline });
  clock = new Date(deadline.getTime() + 5_001);
  await setQuizState(quizB, "close");
  assert.equal(attempt(late).submittedAt.toISOString(), "2026-11-05T10:20:05.000Z", "capped, not 10:20:05.001");
  assert.equal(attempt(late).updatedAt.toISOString(), "2026-11-05T10:20:05.001Z");
});
