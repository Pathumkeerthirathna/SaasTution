/*
 * Student views (lib/breakout-activities/serialize.ts, student section):
 * allow-listed fields only; no file paths, idempotency keys, ids of other
 * people or groups; quizzes through the projection (no answer keys); results
 * through buildStudentResult (score only until CLOSED, then the review);
 * raw grading never sent.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const s = require(path.join(root, "lib/breakout-activities/serialize.ts"));
const v = require(path.join(root, "lib/breakout-activities/validation.ts"));
const { Decimal } = require("@prisma/client/runtime/library");

const AT = new Date("2026-11-05T10:00:00.123Z");
const FORBIDDEN_KEYS = [
  "briefFilePath", "filePath", "idempotencyKey", "status", "teacherId", "classSessionId", "publishGroupId",
  "studentId", "targetRoomId", "grading", "correct", "correctOptionId", "correctOptionIds", "acceptedAnswers", "secret",
];

function walk(value, keys = new Set(), strings = []) {
  if (Array.isArray(value)) value.forEach((x) => walk(x, keys, strings));
  else if (value && typeof value === "object") {
    for (const [k, x] of Object.entries(value)) {
      keys.add(k);
      walk(x, keys, strings);
    }
  } else if (typeof value === "string") strings.push(value);
  return { keys, strings };
}
function assertClean(view, allowed = []) {
  const { keys, strings } = walk(view);
  for (const k of FORBIDDEN_KEYS) if (!allowed.includes(k)) assert.equal(keys.has(k), false, `leaked ${k}`);
  assert.equal(strings.some((x) => x.includes("breakout-activities/")), false, "leaked a stored path");
}

const activity = {
  id: "a1", classSessionId: "s1", teacherId: "t1", publishGroupId: "g1", status: 0, secret: "added later",
  targetRoomType: "BREAKOUT", targetRoomId: "room-1@breakout", targetRoomName: "Room 1",
  title: "Essay", state: "PUBLISHED", publishedAt: AT, closedAt: null, createdAt: AT, updatedAt: AT,
};

test("assignment: title, instructions, room name and brief metadata only", () => {
  const view = s.serializeAssignmentForStudent({
    ...activity, instructions: "Write", briefFileName: "brief.pdf", briefFilePath: "breakout-activities/s1/briefs/g1/x.pdf", briefFileSize: 10,
  });
  assert.deepEqual(view, {
    id: "a1",
    room: { type: "BREAKOUT", name: "Room 1" },
    title: "Essay",
    state: "PUBLISHED",
    publishedAt: AT.toISOString(),
    closedAt: null,
    instructions: "Write",
    brief: { fileName: "brief.pdf", fileSize: 10 },
  });
  assertClean(view);
});

test("draft: own text and revision; none yet = empty at revision 0", () => {
  assert.deepEqual(s.serializeDraftForStudent(null), { answerText: "", revision: 0, updatedAt: null });
  const view = s.serializeDraftForStudent({ id: "d1", studentId: "st1", classSessionId: "s1", answerText: "Hi", revision: 3, updatedAt: AT });
  assert.deepEqual(view, { answerText: "Hi", revision: 3, updatedAt: AT.toISOString() });
});

test("submission: no idempotency key, file path or student id; replayed flag only when set", () => {
  const row = {
    id: "sub1", assignmentId: "a1", classSessionId: "s1", studentId: "st1", version: 2, isLatest: true, answerText: "A",
    fileName: "answer.pdf", filePath: "breakout-activities/s1/submissions/a1/x.pdf", fileSize: 99, idempotencyKey: "secret-key", submittedAt: AT,
  };
  const view = s.serializeSubmissionForStudent(row);
  assert.deepEqual(view, { id: "sub1", version: 2, isLatest: true, submittedAt: AT.toISOString(), answerText: "A", file: { fileName: "answer.pdf", fileSize: 99 } });
  assert.equal(s.serializeSubmissionForStudent(row, { replayed: true }).replayed, true);
  assert.ok(!JSON.stringify(view).includes("secret-key"));
  assertClean(view);
});

async function sampleQuiz() {
  const marking = await import(pathToFileURL(path.join(root, "lib/breakout-activities/marking.mjs")).href);
  const definition = v.assignServerIds([
    { kind: "single", prompt: "2 + 2?", marks: 2, options: [{ text: "3" }, { text: "4", correct: true }] },
    { kind: "multiple", prompt: "Primes?", marks: 3, options: [{ text: "2", correct: true }, { text: "3", correct: true }, { text: "4" }] },
    { kind: "true_false", prompt: "Sky blue?", marks: 1, correct: true },
    { kind: "short", prompt: "Capital?", marks: 1, acceptedAnswers: ["Kotte"] },
  ]);
  const [single, multiple, tf, short] = definition.questions;
  const answers = {
    [single.id]: { kind: "single", optionId: single.options[1].id },
    [multiple.id]: { kind: "multiple", optionIds: [multiple.options[0].id] },
    [tf.id]: { kind: "true_false", value: false },
  };
  const grading = marking.gradeAttempt(definition, answers);
  const scores = marking.computeScores(grading);
  return { definition, answers, grading, scores, short };
}

test("quiz: the projection only (prompts, options, marks), never an answer key", async () => {
  const { definition } = await sampleQuiz();
  const view = s.serializeQuizForStudent({ ...activity, instructions: null, totalMarks: new Decimal("7.00"), timeLimitSeconds: 600, questions: definition }, definition);
  assert.equal(view.totalMarks, 7);
  assert.equal(view.timeLimitSeconds, 600);
  assert.equal(view.questions.length, 4);
  assert.deepEqual(Object.keys(view.questions[0]).sort(), ["id", "kind", "marks", "options", "prompt"]);
  assert.deepEqual(Object.keys(view.questions[2]).sort(), ["id", "kind", "marks", "prompt"]);
  assertClean(view);
});

test("attempt in progress: own answers, revision and deadline to resume; nothing graded", async () => {
  const { definition, answers } = await sampleQuiz();
  const view = s.serializeAttemptForStudent({
    quizState: "PUBLISHED",
    definition,
    totalMarks: 7,
    attempt: { attemptStatus: "IN_PROGRESS", answers, revision: 4, grading: { x: 1 }, finalScore: null, startedAt: AT, deadlineAt: AT, lastSavedAt: AT, submittedAt: null },
  });
  assert.equal(view.attemptStatus, "IN_PROGRESS");
  assert.deepEqual(view.answers, answers);
  assert.equal(view.revision, 4);
  assert.equal(view.deadlineAt, AT.toISOString());
  assertClean(view);
  assert.deepEqual(s.serializeAttemptForStudent({ quizState: "PUBLISHED", definition, totalMarks: 7, attempt: null }), { attemptStatus: null });
});

test("submitted, quiz not CLOSED: the total score only; no review, keys or raw grading", async () => {
  const { definition, answers, grading, scores } = await sampleQuiz();
  for (const attemptStatus of ["SUBMITTED", "AUTO_SUBMITTED"]) {
    const view = s.serializeAttemptForStudent({
      quizState: "PUBLISHED",
      definition,
      totalMarks: new Decimal("7.00"),
      attempt: { attemptStatus, answers, revision: 5, grading, finalScore: new Decimal(String(scores.finalScore)), startedAt: AT, deadlineAt: null, lastSavedAt: AT, submittedAt: AT },
    });
    assert.deepEqual(view, { attemptStatus, finalScore: scores.finalScore, totalMarks: 7, submittedAt: AT.toISOString() });
    assertClean(view);
  }
});

test("quiz CLOSED: the review appears (correct answers, own answers, per-question results); still no raw grading", async () => {
  const { definition, answers, grading, scores } = await sampleQuiz();
  const view = s.serializeAttemptForStudent({
    quizState: "CLOSED",
    definition,
    totalMarks: 7,
    attempt: { attemptStatus: "SUBMITTED", answers, revision: 5, grading, finalScore: scores.finalScore, startedAt: AT, deadlineAt: null, lastSavedAt: AT, submittedAt: AT },
  });
  assert.equal(view.review.length, 4);
  assert.equal(view.review[0].result, "correct");
  assert.equal(typeof view.review[0].correctOptionId, "string", "keys only after CLOSED");
  assert.equal(view.review[3].result, "unanswered");
  assertClean(view, ["correct", "correctOptionId", "correctOptionIds", "acceptedAnswers"]);
});
