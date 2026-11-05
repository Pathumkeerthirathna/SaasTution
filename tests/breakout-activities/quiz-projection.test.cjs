/*
 * What students see of a breakout quiz (lib/breakout-activities/quiz-projection.mjs).
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const load = () => import(pathToFileURL(path.join(root, "lib/breakout-activities/quiz-projection.mjs")).href);

const opts = [{ id: "oa", text: "Kandy" }, { id: "ob", text: "Colombo" }, { id: "oc", text: "Galle" }];
const definition = {
  schemaVersion: 1,
  questions: [
    { id: "q1", kind: "single", prompt: "Capital?", marks: 1, options: opts, correctOptionId: "ob" },
    { id: "q2", kind: "multiple", prompt: "Coastal?", marks: 2, options: opts, correctOptionIds: ["ob", "oc"] },
    { id: "q3", kind: "true_false", prompt: "Island?", marks: 1, correct: true },
    { id: "q4", kind: "short", prompt: "Hill capital?", marks: 1, acceptedAnswers: ["SECRET-ANSWER"] },
  ],
};
const KEY_FIELDS = ["correctOptionId", "correctOptionIds", "correct", "acceptedAnswers"];

const submission = (over = {}) => ({
  attemptStatus: "SUBMITTED",
  answers: { q1: { kind: "single", optionId: "ob" }, q4: { kind: "short", text: "Kandy" } },
  grading: {
    schemaVersion: 1,
    questions: {
      q1: { auto: 1, result: "correct" },
      q2: { auto: 0, result: "unanswered" },
      q3: { auto: 0, result: "unanswered" },
      q4: { auto: 0, result: "incorrect", override: { marks: 0.5, teacherId: "t-1", at: "2026-11-05T08:00:00.000Z", note: "Half" } },
    },
  },
  finalScore: "1.50",
  submittedAt: new Date("2026-11-05T08:10:00.000Z"),
  ...over,
});

test("the student view carries no answer keys anywhere", async () => {
  const { projectQuizForStudent } = await load();
  const view = projectQuizForStudent(definition);
  const text = JSON.stringify(view);
  for (const field of KEY_FIELDS) assert.equal(text.includes(`"${field}"`), false, field);
  assert.equal(text.includes("SECRET-ANSWER"), false);
});

test("the student view keeps question and option order, ids, prompts and marks", async () => {
  const { projectQuizForStudent } = await load();
  const view = projectQuizForStudent(definition);
  assert.deepEqual(view.questions.map((q) => q.id), ["q1", "q2", "q3", "q4"]);
  assert.deepEqual(view.questions[0], { id: "q1", kind: "single", prompt: "Capital?", marks: 1, options: opts });
  assert.deepEqual(view.questions[2], { id: "q3", kind: "true_false", prompt: "Island?", marks: 1 });
  assert.equal("options" in view.questions[3], false);
});

test("the student view is an allow-list: unexpected fields never pass through", async () => {
  const { projectQuizForStudent } = await load();
  const tampered = structuredClone(definition);
  tampered.questions[0].explanation = "LEAK";
  tampered.questions[0].options[0].isCorrect = true;
  const text = JSON.stringify(projectQuizForStudent(tampered));
  assert.equal(text.includes("LEAK"), false);
  assert.equal(text.includes("isCorrect"), false);
});

test("not started / in progress: no result", async () => {
  const { buildStudentResult } = await load();
  assert.deepEqual(buildStudentResult({ quizState: "PUBLISHED", definition, totalMarks: 5, submission: null }), { attemptStatus: null });
  const r = buildStudentResult({ quizState: "CLOSED", definition, totalMarks: 5, submission: submission({ attemptStatus: "IN_PROGRESS" }) });
  assert.deepEqual(r, { attemptStatus: "IN_PROGRESS" });
});

test("submitted while the quiz is open: the score only", async () => {
  const { buildStudentResult } = await load();
  for (const attemptStatus of ["SUBMITTED", "AUTO_SUBMITTED"]) {
    const r = buildStudentResult({ quizState: "PUBLISHED", definition, totalMarks: "5.00", submission: submission({ attemptStatus }) });
    assert.deepEqual(r, { attemptStatus, finalScore: 1.5, totalMarks: 5, submittedAt: "2026-11-05T08:10:00.000Z" });
    const text = JSON.stringify(r);
    for (const field of KEY_FIELDS) assert.equal(text.includes(`"${field}"`), false, field);
  }
});

test("after CLOSED: keys, own answers, results and teacher notes", async () => {
  const { buildStudentResult } = await load();
  const r = buildStudentResult({ quizState: "CLOSED", definition, totalMarks: 5, submission: submission() });
  assert.equal(r.finalScore, 1.5);
  assert.equal(r.review.length, 4);
  assert.deepEqual(r.review[0], { id: "q1", kind: "single", prompt: "Capital?", marks: 1, options: opts, correctOptionId: "ob", answer: { kind: "single", optionId: "ob" }, result: "correct", awarded: 1 });
  assert.deepEqual(r.review[1].correctOptionIds, ["ob", "oc"]);
  assert.equal(r.review[1].answer, null);
  assert.equal(r.review[2].correct, true);
  assert.deepEqual(r.review[3].acceptedAnswers, ["SECRET-ANSWER"]);
  assert.equal(r.review[3].awarded, 0.5, "the override is what counts");
  assert.equal(r.review[3].note, "Half");
  assert.equal(JSON.stringify(r).includes("t-1"), false, "the teacher id is not shown");
});

test("after CLOSED without grading: everything unanswered, 0 awarded", async () => {
  const { buildStudentResult } = await load();
  const r = buildStudentResult({ quizState: "CLOSED", definition, totalMarks: 5, submission: submission({ grading: null, answers: null, finalScore: null }) });
  assert.equal(r.finalScore, null);
  assert.ok(r.review.every((q) => q.result === "unanswered" && q.awarded === 0 && q.answer === null));
});
