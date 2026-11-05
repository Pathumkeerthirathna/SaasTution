/*
 * Breakout quiz scores: single / true-false marking, whole-attempt grading,
 * totals and teacher overrides (lib/breakout-activities/marking.mjs).
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const load = () => import(pathToFileURL(path.join(root, "lib/breakout-activities/marking.mjs")).href);

const opts = [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }];
const definition = {
  schemaVersion: 1,
  questions: [
    { id: "q1", kind: "single", prompt: "1", marks: 0.1, options: opts, correctOptionId: "b" },
    { id: "q2", kind: "true_false", prompt: "2", marks: 0.2, correct: false },
    { id: "q3", kind: "multiple", prompt: "3", marks: 3, options: opts, correctOptionIds: ["a", "c"] },
    { id: "q4", kind: "short", prompt: "4", marks: 1.5, acceptedAnswers: ["Colombo"] },
  ],
};
const allRight = {
  q1: { kind: "single", optionId: "b" },
  q2: { kind: "true_false", value: false },
  q3: { kind: "multiple", optionIds: ["a", "c"] },
  q4: { kind: "short", text: "colombo" },
};
const teacher = { teacherId: "t-1", now: new Date("2026-11-05T08:00:00.000Z") };

test("single and true/false: right, wrong, unanswered", async () => {
  const { markQuestion } = await load();
  const [single, tf] = definition.questions;
  assert.deepEqual(markQuestion(single, { kind: "single", optionId: "b" }), { auto: 0.1, result: "correct" });
  assert.deepEqual(markQuestion(single, { kind: "single", optionId: "a" }), { auto: 0, result: "incorrect" });
  assert.deepEqual(markQuestion(single, { kind: "single", optionId: null }), { auto: 0, result: "unanswered" });
  assert.deepEqual(markQuestion(tf, { kind: "true_false", value: false }), { auto: 0.2, result: "correct" });
  assert.deepEqual(markQuestion(tf, { kind: "true_false", value: true }), { auto: 0, result: "incorrect" });
  assert.deepEqual(markQuestion(tf, { kind: "true_false", value: null }), { auto: 0, result: "unanswered" });
});

test("total marks add up exactly (0.1 + 0.2 + 3 + 1.5 = 4.8)", async () => {
  const { computeTotalMarks } = await load();
  assert.equal(computeTotalMarks(definition), 4.8);
  const tenths = { schemaVersion: 1, questions: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, kind: "true_false", prompt: "x", marks: 0.1, correct: true })) };
  assert.equal(computeTotalMarks(tenths), 1, "10 x 0.1 is exactly 1");
});

test("a fully correct attempt scores the total", async () => {
  const { gradeAttempt, computeScores, computeTotalMarks } = await load();
  const grading = gradeAttempt(definition, allRight);
  assert.equal(grading.schemaVersion, 1);
  assert.deepEqual(Object.keys(grading.questions), ["q1", "q2", "q3", "q4"]);
  assert.deepEqual(computeScores(grading), { autoScore: 4.8, finalScore: 4.8 });
  assert.equal(computeScores(grading).finalScore, computeTotalMarks(definition));
});

test("an empty attempt scores 0 with every question unanswered", async () => {
  const { gradeAttempt, computeScores } = await load();
  for (const answers of [{}, null, undefined]) {
    const grading = gradeAttempt(definition, answers);
    assert.ok(Object.values(grading.questions).every((g) => g.result === "unanswered" && g.auto === 0));
    assert.deepEqual(computeScores(grading), { autoScore: 0, finalScore: 0 });
  }
});

test("a mixed attempt adds partial marks exactly", async () => {
  const { gradeAttempt, computeScores } = await load();
  const grading = gradeAttempt(definition, {
    q1: { kind: "single", optionId: "b" },
    q3: { kind: "multiple", optionIds: ["a"] },
    q4: { kind: "short", text: "Kandy" },
  });
  assert.equal(grading.questions.q3.auto, 1.5);
  assert.equal(grading.questions.q3.result, "partial");
  assert.deepEqual(computeScores(grading), { autoScore: 1.6, finalScore: 1.6 });
});

test("answers for unknown questions and inherited keys are ignored", async () => {
  const { gradeAttempt } = await load();
  const answers = Object.create({ q1: { kind: "single", optionId: "b" } });
  answers.zz = { kind: "short", text: "x" };
  const grading = gradeAttempt(definition, answers);
  assert.equal(grading.questions.q1.result, "unanswered", "a prototype property is not an answer");
  assert.equal("zz" in grading.questions, false);
});

test("overrides change finalScore, not autoScore; null removes one", async () => {
  const { gradeAttempt, applyOverrides, computeScores } = await load();
  const graded = gradeAttempt(definition, { q4: { kind: "short", text: "Colombo city" } });
  assert.deepEqual(computeScores(graded), { autoScore: 0, finalScore: 0 });

  const overridden = applyOverrides(graded, [{ questionId: "q4", marks: 1.25, note: "  Close enough  " }], definition, teacher);
  assert.deepEqual(overridden.questions.q4.override, { marks: 1.25, teacherId: "t-1", at: "2026-11-05T08:00:00.000Z", note: "Close enough" });
  assert.deepEqual(computeScores(overridden), { autoScore: 0, finalScore: 1.25 });
  assert.equal(graded.questions.q4.override, undefined, "the input grading is not changed");

  const lowered = applyOverrides(gradeAttempt(definition, allRight), [{ questionId: "q3", marks: 0 }], definition, teacher);
  assert.deepEqual(computeScores(lowered), { autoScore: 4.8, finalScore: 1.8 }, "an override can lower marks to 0");

  const removed = applyOverrides(overridden, [{ questionId: "q4", marks: null }], definition, teacher);
  assert.equal("override" in removed.questions.q4, false);
  assert.deepEqual(computeScores(removed), { autoScore: 0, finalScore: 0 });
});

test("override boundaries: 0 and full marks allowed; outside or > 2 decimals refused", async () => {
  const { gradeAttempt, applyOverrides, BreakoutMarkingError } = await load();
  const graded = gradeAttempt(definition, {});
  assert.equal(applyOverrides(graded, [{ questionId: "q3", marks: 0 }], definition, teacher).questions.q3.override.marks, 0);
  assert.equal(applyOverrides(graded, [{ questionId: "q3", marks: 3 }], definition, teacher).questions.q3.override.marks, 3);
  for (const marks of [-0.01, 3.01, 1.005, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => applyOverrides(graded, [{ questionId: "q3", marks }], definition, teacher), BreakoutMarkingError, String(marks));
  }
});

test("overrides are all-or-nothing and refuse unknown or repeated questions", async () => {
  const { gradeAttempt, applyOverrides, BreakoutMarkingError } = await load();
  const graded = gradeAttempt(definition, {});
  const attempt = (overrides) => () => applyOverrides(graded, overrides, definition, teacher);
  assert.throws(attempt([{ questionId: "nope", marks: 1 }]), (e) => e instanceof BreakoutMarkingError && e.code === "UNKNOWN_QUESTION");
  assert.throws(attempt([{ questionId: "q1", marks: 0.1 }, { questionId: "q1", marks: 0 }]), (e) => e.code === "DUPLICATE_OVERRIDE");
  assert.throws(attempt([{ questionId: "q1", marks: 0.1 }, { questionId: "q3", marks: 99 }]), (e) => e.code === "OVERRIDE_OUT_OF_RANGE");
  assert.equal(graded.questions.q1.override, undefined, "nothing applied after a failure");
  assert.throws(attempt([]), BreakoutMarkingError);
  assert.throws(attempt([{ questionId: "q1", marks: 0.1, note: "x".repeat(501) }]), BreakoutMarkingError);
  assert.throws(() => applyOverrides(graded, [{ questionId: "q1", marks: 0 }], definition, { teacherId: "", now: new Date() }), TypeError);
});

test("the largest quiz (100 x 100 marks) totals 10 000, which fits Decimal(7,2)", async () => {
  const { computeTotalMarks, gradeAttempt, computeScores } = await load();
  const big = { schemaVersion: 1, questions: Array.from({ length: 100 }, (_, i) => ({ id: `q${i}`, kind: "true_false", prompt: "x", marks: 100, correct: true })) };
  const answers = Object.fromEntries(big.questions.map((q) => [q.id, { kind: "true_false", value: true }]));
  assert.equal(computeTotalMarks(big), 10000);
  assert.equal(computeScores(gradeAttempt(big, answers)).finalScore, 10000);
  assert.ok(10000 <= 99999.99);
});

test("hundredths helpers refuse more than 2 decimals and non-finite values", async () => {
  const { toHundredths, BreakoutMarkingError } = await load();
  assert.equal(toHundredths(0.07), 7);
  assert.equal(toHundredths(2.67), 267);
  for (const bad of [1.005, 0.001, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
    assert.throws(() => toHundredths(bad), BreakoutMarkingError, String(bad));
  }
});

test("a question with zero marks is refused", async () => {
  const { markQuestion, BreakoutMarkingError } = await load();
  assert.throws(() => markQuestion({ ...definition.questions[1], marks: 0 }, { kind: "true_false", value: false }), BreakoutMarkingError);
});
