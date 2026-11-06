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

// ---- L2: the shown result follows a teacher override ---------------------------------

const overrideOn = (questionId, auto, result, marks, note) => {
  const s = submission();
  s.grading = structuredClone(s.grading);
  s.grading.questions[questionId] = { auto, result, override: { marks, teacherId: "t-1", at: "2026-11-05T08:00:00.000Z", ...(note ? { note } : {}) } };
  return s;
};
const reviewOf = async (s) => {
  const { buildStudentResult } = await load();
  return buildStudentResult({ quizState: "CLOSED", definition, totalMarks: 5, submission: s }).review;
};

test("L2: a full-mark override shows correct (was incorrect / unanswered), awarded = the override", async () => {
  // q2: 2 marks, auto 0 "incorrect" -> override 2
  let q = (await reviewOf(overrideOn("q2", 0, "incorrect", 2))).find((x) => x.id === "q2");
  assert.equal(q.result, "correct");
  assert.equal(q.awarded, 2);
  // q3: 1 mark, never answered -> override 1
  q = (await reviewOf(overrideOn("q3", 0, "unanswered", 1))).find((x) => x.id === "q3");
  assert.equal(q.result, "correct");
  assert.equal(q.awarded, 1);
});

test("L2: a partial-mark override shows partial, from either direction", async () => {
  let q = (await reviewOf(overrideOn("q2", 0, "incorrect", 0.5))).find((x) => x.id === "q2");
  assert.deepEqual([q.result, q.awarded], ["partial", 0.5]);
  q = (await reviewOf(overrideOn("q1", 1, "correct", 0.25))).find((x) => x.id === "q1");
  assert.deepEqual([q.result, q.awarded], ["partial", 0.25], "a correct answer marked down");
  // The existing fixture: q4 (1 mark) auto 0 incorrect, override 0.5 -> partial.
  q = (await reviewOf(submission())).find((x) => x.id === "q4");
  assert.deepEqual([q.result, q.awarded, q.note], ["partial", 0.5, "Half"]);
  // Hundredths: 1.99 of 2 is partial, not rounded up to correct.
  q = (await reviewOf(overrideOn("q2", 2, "correct", 1.99))).find((x) => x.id === "q2");
  assert.equal(q.result, "partial");
});

test("L2: a zero-mark override shows incorrect; an unanswered question overridden to 0 stays unanswered", async () => {
  let q = (await reviewOf(overrideOn("q1", 1, "correct", 0, "Copied"))).find((x) => x.id === "q1");
  assert.deepEqual([q.result, q.awarded, q.note], ["incorrect", 0, "Copied"]);
  q = (await reviewOf(overrideOn("q2", 1, "partial", 0))).find((x) => x.id === "q2");
  assert.deepEqual([q.result, q.awarded], ["incorrect", 0]);
  q = (await reviewOf(overrideOn("q3", 0, "unanswered", 0))).find((x) => x.id === "q3");
  assert.deepEqual([q.result, q.awarded], ["unanswered", 0]);
});

test("L2: without an override the stored automatic result is shown unchanged; the grading object is not modified or sent", async () => {
  const s = submission();
  const before = structuredClone(s.grading);
  const review = await reviewOf(s);
  assert.deepEqual(review.map((x) => x.result), ["correct", "unanswered", "unanswered", "partial"]);
  assert.deepEqual(s.grading, before, "the stored grading is untouched (automatic result kept)");
  const text = JSON.stringify(review);
  assert.equal(text.includes("t-1") || text.includes('"override"') || text.includes('"auto"') || text.includes('"grading"'), false);
});

test("L2: a malformed stored override falls back to the stored automatic result (no crash)", async () => {
  const q = (await reviewOf(overrideOn("q1", 1, "correct", "abc"))).find((x) => x.id === "q1");
  assert.equal(q.result, "correct");
});
