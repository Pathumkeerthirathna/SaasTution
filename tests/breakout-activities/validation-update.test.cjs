/*
 * Teacher update schemas (lib/breakout-activities/validation.ts): a PATCH is
 * either a state action or DRAFT field edits, never both; edits reuse the
 * create limits; the existing create schemas are unchanged.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const v = require(path.join(root, "lib/breakout-activities/validation.ts"));

const ok = (schema, value) => {
  const r = schema.safeParse(value);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues ?? value));
  return r.data;
};
const bad = (schema, value) => assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));

const question = { kind: "true_false", prompt: "Is 2 even?", marks: 1, correct: true };

test("actions: publish and close only", () => {
  assert.deepEqual(ok(v.activityActionSchema, { action: "publish" }), { action: "publish" });
  assert.deepEqual(ok(v.activityActionSchema, { action: "close" }), { action: "close" });
  for (const value of [{}, { action: "reopen" }, { action: "delete" }, { action: "PUBLISH" }, { action: "close", extra: 1 }]) {
    bad(v.activityActionSchema, value);
  }
});

test("assignment edits: title / instructions with the create limits; at least one; strict", () => {
  assert.deepEqual(ok(v.assignmentUpdateSchema, { title: "  Essay  " }), { title: "Essay" });
  assert.deepEqual(ok(v.assignmentUpdateSchema, { instructions: "" }), { instructions: "" }, "instructions may be emptied (brief rule: service)");
  ok(v.assignmentUpdateSchema, { instructions: "x".repeat(20_000) });
  bad(v.assignmentUpdateSchema, { instructions: "x".repeat(20_001) });
  bad(v.assignmentUpdateSchema, { title: "x".repeat(201) });
  bad(v.assignmentUpdateSchema, { title: "   " });
  bad(v.assignmentUpdateSchema, {});
  bad(v.assignmentUpdateSchema, { title: undefined });
  for (const field of ["state", "targets", "briefFilePath", "teacherId", "publishGroupId", "status"]) {
    bad(v.assignmentUpdateSchema, { title: "x", [field]: "y" });
  }
});

test("brief replacement text fields: optional (the brief alone is a change), strict", () => {
  assert.deepEqual(ok(v.assignmentBriefUpdateFieldsSchema, {}), {});
  ok(v.assignmentBriefUpdateFieldsSchema, { title: "New", instructions: "Read it" });
  bad(v.assignmentBriefUpdateFieldsSchema, { title: "" });
  bad(v.assignmentBriefUpdateFieldsSchema, { brief: "x" });
});

test("quiz edits: the create limits; questions replace the definition; strict; at least one", () => {
  assert.deepEqual(ok(v.quizUpdateSchema, { timeLimitSeconds: null }), { timeLimitSeconds: null });
  ok(v.quizUpdateSchema, { timeLimitSeconds: 60 });
  ok(v.quizUpdateSchema, { timeLimitSeconds: 14_400 });
  bad(v.quizUpdateSchema, { timeLimitSeconds: 59 });
  bad(v.quizUpdateSchema, { timeLimitSeconds: 14_401 });
  ok(v.quizUpdateSchema, { questions: [question] });
  bad(v.quizUpdateSchema, { questions: [] });
  bad(v.quizUpdateSchema, { questions: [{ ...question, id: "q1" }] }, "input questions carry no ids");
  bad(v.quizUpdateSchema, {});
  bad(v.quizUpdateSchema, { title: "x", totalMarks: 5 });
  bad(v.quizUpdateSchema, { title: "x", targets: [{ type: "MAIN" }] });
});

test("PATCH bodies: an action or edits, never both", () => {
  assert.deepEqual(ok(v.assignmentPatchSchema, { action: "close" }), { action: "close" });
  assert.deepEqual(ok(v.assignmentPatchSchema, { title: "x" }), { title: "x" });
  bad(v.assignmentPatchSchema, { action: "close", title: "x" });
  bad(v.assignmentPatchSchema, {});
  assert.deepEqual(ok(v.quizPatchSchema, { action: "publish" }), { action: "publish" });
  ok(v.quizPatchSchema, { questions: [question] });
  bad(v.quizPatchSchema, { action: "publish", questions: [question] });
  bad(v.quizPatchSchema, { action: "grade" });
});

test("the existing create schemas still behave as before", () => {
  ok(v.assignmentCreateSchema, { title: "Essay", instructions: "", targets: [{ type: "MAIN" }], publish: false });
  bad(v.assignmentCreateSchema, { title: "Essay", instructions: "", targets: [{ type: "MAIN" }], publish: false, brief: "x" });
  ok(v.quizCreateSchema, { title: "Quiz", questions: [question], targets: [{ type: "MAIN" }], publish: true });
  bad(v.quizCreateSchema, { title: "Quiz", questions: [question], targets: [], publish: true });
});

test("stored grading: valid and matching the definition, or null", async () => {
  const marking = await import(require("node:url").pathToFileURL(path.join(root, "lib/breakout-activities/marking.mjs")).href);
  const def = v.assignServerIds([question, { kind: "true_false", prompt: "Is 3 even?", marks: 2.5, correct: false }]);
  const [q1, q2] = def.questions.map((q) => q.id);
  const graded = marking.gradeAttempt(def, { [q1]: { kind: "true_false", value: true } });
  assert.deepEqual(v.parseStoredGrading(def, graded), graded);
  const overridden = marking.applyOverrides(graded, [{ questionId: q2, marks: 2.5, note: "ok" }], def, { teacherId: "t1", now: new Date() });
  assert.deepEqual(v.parseStoredGrading(def, overridden), overridden);
  assert.equal(v.parseStoredGrading(def, { ...graded, questions: { ...graded.questions, [q2]: { auto: 2.5, result: "correct" } } }).questions[q2].auto, 2.5, "exactly the marks is fine");
  for (const bad of [
    null,
    [],
    { schemaVersion: 1, questions: { [q1]: graded.questions[q1] } },
    { schemaVersion: 1, questions: { ...graded.questions, [q2]: { auto: 2.51, result: "partial" } } },
    { schemaVersion: 1, questions: { ...graded.questions, [q2]: { auto: 1.005, result: "partial" } } },
    { schemaVersion: 1, questions: { ...graded.questions }, extra: true },
    JSON.parse(`{"schemaVersion":1,"questions":{"${q1}":${JSON.stringify(graded.questions[q1])},"__proto__":${JSON.stringify(graded.questions[q2])}}}`),
  ]) {
    assert.equal(v.parseStoredGrading(def, bad), null, JSON.stringify(bad));
  }
});

test("D5 merge: sent answers replace those questions only; the rest is kept; validated against the quiz", () => {
  const def = v.assignServerIds([
    { kind: "single", prompt: "2 + 2?", marks: 1, options: [{ text: "3" }, { text: "4", correct: true }] },
    question,
    { kind: "short", prompt: "Capital?", marks: 1, acceptedAnswers: ["Kotte"] },
  ]);
  const [single, tf, short] = def.questions;
  const stored = {
    [single.id]: { kind: "single", optionId: single.options[0].id },
    [tf.id]: { kind: "true_false", value: false },
  };

  const merged = v.mergeQuizAnswers(def, stored, { [tf.id]: { kind: "true_false", value: true }, [short.id]: { kind: "short", text: "Kotte" } });
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.answers, {
    [single.id]: { kind: "single", optionId: single.options[0].id },
    [tf.id]: { kind: "true_false", value: true },
    [short.id]: { kind: "short", text: "Kotte" },
  });
  assert.equal(stored[tf.id].value, false, "the stored object is not mutated");

  const cleared = v.mergeQuizAnswers(def, stored, { [single.id]: { kind: "single", optionId: null } });
  assert.deepEqual(cleared.answers[single.id], { kind: "single", optionId: null }, "clear one answer with its empty form");
  assert.deepEqual(cleared.answers[tf.id], stored[tf.id]);

  assert.deepEqual(v.mergeQuizAnswers(def, null, { [tf.id]: { kind: "true_false", value: true } }).answers, { [tf.id]: { kind: "true_false", value: true } }, "first save");

  for (const [label, incoming] of [
    ["empty", {}],
    ["not an object", "x"],
    ["array", [1]],
    ["unknown question", { qffffffffffffffff: { kind: "true_false", value: true } }],
    ["wrong kind", { [tf.id]: { kind: "short", text: "x" } }],
    ["unknown option", { [single.id]: { kind: "single", optionId: "offffffffffffffff" } }],
    ["__proto__", JSON.parse(`{"__proto__":{"kind":"true_false","value":true}}`)],
    ["short too long", { [short.id]: { kind: "short", text: "x".repeat(1001) } }],
  ]) {
    const result = v.mergeQuizAnswers(def, stored, incoming);
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, "INVALID_ANSWERS", label);
  }
  const corrupt = v.mergeQuizAnswers(def, { qffffffffffffffff: { kind: "true_false", value: true } }, { [tf.id]: { kind: "true_false", value: true } });
  assert.equal(corrupt.ok, false, "corrupt stored answers are refused, never silently dropped");
  assert.equal(corrupt.reason, "STORED_ANSWERS_CORRUPT");
});

test("merge failure reasons are stable codes, distinct for the request and for the stored answers", () => {
  const def = v.assignServerIds([question]);
  const [tf] = def.questions;
  const valid = { [tf.id]: { kind: "true_false", value: true } };
  const corruptStored = { qffffffffffffffff: { kind: "true_false", value: false } };
  const badIncoming = { qeeeeeeeeeeeeeeee: { kind: "true_false", value: true } };

  assert.deepEqual(v.mergeQuizAnswers(def, {}, valid), { ok: true, answers: valid });
  assert.equal(v.mergeQuizAnswers(def, {}, badIncoming).reason, "INVALID_ANSWERS");
  assert.equal(v.mergeQuizAnswers(def, corruptStored, valid).reason, "STORED_ANSWERS_CORRUPT");
  // Both wrong: the request is reported first (a client error), as before.
  assert.equal(v.mergeQuizAnswers(def, corruptStored, badIncoming).reason, "INVALID_ANSWERS");
  // Stored values that are not even an object are corrupt too.
  for (const stored of ["text", [1], 7]) {
    assert.equal(v.mergeQuizAnswers(def, stored, valid).reason, "STORED_ANSWERS_CORRUPT", JSON.stringify(stored));
  }
  // The reason, not the message, is the contract: every failure carries both.
  for (const result of [v.mergeQuizAnswers(def, {}, {}), v.mergeQuizAnswers(def, corruptStored, valid)]) {
    assert.equal(result.ok, false);
    assert.ok(["INVALID_ANSWERS", "STORED_ANSWERS_CORRUPT"].includes(result.reason));
    assert.equal(typeof result.error, "string");
  }
});
