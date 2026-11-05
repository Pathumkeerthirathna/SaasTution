/*
 * Breakout activity validation: quiz definitions, answers, requests and
 * their boundaries (lib/breakout-activities/validation.ts).
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

const ok = (schema, value) => assert.equal(schema.safeParse(value).success, true, `expected valid: ${JSON.stringify(value).slice(0, 120)}`);
const bad = (schema, value) => assert.equal(schema.safeParse(value).success, false, `expected invalid: ${JSON.stringify(value).slice(0, 120)}`);

const opt = (text, correct) => (correct === undefined ? { text } : { text, correct });
const single = (over = {}) => ({ kind: "single", prompt: "Pick one", marks: 1, options: [opt("A", true), opt("B")], ...over });
const multiple = (over = {}) => ({ kind: "multiple", prompt: "Pick some", marks: 2, options: [opt("A", true), opt("B", true), opt("C")], ...over });
const tf = (over = {}) => ({ kind: "true_false", prompt: "True?", marks: 1, correct: true, ...over });
const short = (over = {}) => ({ kind: "short", prompt: "Capital?", marks: 1, acceptedAnswers: ["Colombo"], ...over });

let counter = 0;
const ids = () => `id${(counter += 1)}`;

test("question count: 1 to 100", () => {
  bad(v.quizDefinitionInputSchema, []);
  ok(v.quizDefinitionInputSchema, [tf()]);
  ok(v.quizDefinitionInputSchema, Array.from({ length: 100 }, () => tf()));
  bad(v.quizDefinitionInputSchema, Array.from({ length: 101 }, () => tf()));
});

test("prompt: required, at most 2 000 characters", () => {
  ok(v.quizDefinitionInputSchema, [tf({ prompt: "x".repeat(2000) })]);
  bad(v.quizDefinitionInputSchema, [tf({ prompt: "x".repeat(2001) })]);
  bad(v.quizDefinitionInputSchema, [tf({ prompt: "   " })]);
});

test("marks: > 0, <= 100, at most 2 decimals", () => {
  for (const marks of [0.01, 1, 2.5, 99.99, 100]) ok(v.quizDefinitionInputSchema, [tf({ marks })]);
  for (const marks of [0, -1, 100.01, 0.005, 1.234, Number.NaN, Number.POSITIVE_INFINITY, "1"]) bad(v.quizDefinitionInputSchema, [tf({ marks })]);
});

test("options: 2 to 10, each 1 to 500 characters", () => {
  bad(v.quizDefinitionInputSchema, [single({ options: [opt("A", true)] })]);
  ok(v.quizDefinitionInputSchema, [single({ options: Array.from({ length: 10 }, (_, i) => opt(`O${i}`, i === 0)) })]);
  bad(v.quizDefinitionInputSchema, [single({ options: Array.from({ length: 11 }, (_, i) => opt(`O${i}`, i === 0)) })]);
  ok(v.quizDefinitionInputSchema, [single({ options: [opt("x".repeat(500), true), opt("B")] })]);
  bad(v.quizDefinitionInputSchema, [single({ options: [opt("x".repeat(501), true), opt("B")] })]);
  bad(v.quizDefinitionInputSchema, [single({ options: [opt("  ", true), opt("B")] })]);
});

test("correct options: single needs exactly one, multiple at least one", () => {
  bad(v.quizDefinitionInputSchema, [single({ options: [opt("A"), opt("B")] })]);
  bad(v.quizDefinitionInputSchema, [single({ options: [opt("A", true), opt("B", true)] })]);
  bad(v.quizDefinitionInputSchema, [multiple({ options: [opt("A"), opt("B")] })]);
  ok(v.quizDefinitionInputSchema, [multiple({ options: [opt("A", true), opt("B", true)] })], "every option correct is allowed");
});

test("accepted answers: 1 to 20, none blank", () => {
  bad(v.quizDefinitionInputSchema, [short({ acceptedAnswers: [] })]);
  ok(v.quizDefinitionInputSchema, [short({ acceptedAnswers: Array.from({ length: 20 }, (_, i) => `a${i}`) })]);
  bad(v.quizDefinitionInputSchema, [short({ acceptedAnswers: Array.from({ length: 21 }, (_, i) => `a${i}`) })]);
  bad(v.quizDefinitionInputSchema, [short({ acceptedAnswers: ["ok", "   "] })]);
});

test("unknown fields and kinds are refused", () => {
  bad(v.quizDefinitionInputSchema, [tf({ extra: 1 })]);
  bad(v.quizDefinitionInputSchema, [{ kind: "essay", prompt: "x", marks: 1 }]);
  bad(v.quizDefinitionInputSchema, [single({ correctOptionId: "A" })], "teachers do not send ids");
});

test("assignServerIds: ids are generated, keys refer to ids, and the result re-validates", () => {
  const stored = v.assignServerIds([single(), multiple(), tf({ correct: false }), short({ acceptedAnswers: ["  Colombo "] })], ids);
  assert.equal(stored.schemaVersion, 1);
  const [s, m, t, sh] = stored.questions;
  assert.match(s.id, /^q/);
  assert.ok(s.options.every((o) => /^o/.test(o.id) && !("correct" in o)), "options carry no correct flag");
  assert.equal(s.correctOptionId, s.options[0].id);
  assert.deepEqual(m.correctOptionIds, [m.options[0].id, m.options[1].id]);
  assert.equal(t.correct, false);
  assert.deepEqual(sh.acceptedAnswers, ["Colombo"]);
  const all = [...stored.questions.map((q) => q.id), ...stored.questions.flatMap((q) => (q.options ?? []).map((o) => o.id))];
  assert.equal(new Set(all).size, all.length, "ids are unique");
  ok(v.storedQuizDefinitionSchema, stored);
});

test("assignServerIds: a generator that repeats itself is retried, then refused", () => {
  let n = 0;
  const repeating = () => (n++ % 2 === 0 ? "same" : `fresh${n}`);
  assert.doesNotThrow(() => v.assignServerIds([tf(), tf()], repeating));
  assert.throws(() => v.assignServerIds([tf(), tf()], () => "same"));
});

test("stored definitions: keys must refer to the question's own options", () => {
  const stored = v.assignServerIds([single(), multiple()], ids);
  ok(v.storedQuizDefinitionSchema, stored);
  const broken = structuredClone(stored);
  broken.questions[0].correctOptionId = "o-missing";
  bad(v.storedQuizDefinitionSchema, broken);
  const broken2 = structuredClone(stored);
  broken2.questions[1].correctOptionIds.push("o-missing");
  bad(v.storedQuizDefinitionSchema, broken2);
  const dupOptions = structuredClone(stored);
  dupOptions.questions[0].options[1].id = dupOptions.questions[0].options[0].id;
  bad(v.storedQuizDefinitionSchema, dupOptions);
  const dupQuestions = structuredClone(stored);
  dupQuestions.questions[1].id = dupQuestions.questions[0].id;
  bad(v.storedQuizDefinitionSchema, dupQuestions);
  bad(v.storedQuizDefinitionSchema, { ...stored, schemaVersion: 2 });
});

test("ids: reserved prototype names are refused", () => {
  const stored = v.assignServerIds([tf()], ids);
  for (const id of ["__proto__", "constructor", "prototype", "has space", "", "x".repeat(65)]) {
    const copy = structuredClone(stored);
    copy.questions[0].id = id;
    bad(v.storedQuizDefinitionSchema, copy);
  }
});

test("answers: checked against the quiz", () => {
  const def = v.assignServerIds([single(), multiple(), tf(), short()], ids);
  const [s, m, t, sh] = def.questions;
  const check = (answers) => v.validateAnswersAgainstDefinition(def, answers);

  assert.equal(check({}).ok, true, "no answers yet");
  const good = check({
    [s.id]: { kind: "single", optionId: s.options[1].id },
    [m.id]: { kind: "multiple", optionIds: [m.options[0].id, m.options[0].id] },
    [t.id]: { kind: "true_false", value: null },
    [sh.id]: { kind: "short", text: "x".repeat(1000) },
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.answers[m.id].optionIds, [m.options[0].id], "duplicates removed");

  assert.equal(check({ [s.id]: { kind: "single", optionId: null } }).ok, true, "cleared answer");
  assert.equal(check({ qUnknown: { kind: "true_false", value: true } }).ok, false, "unknown question");
  assert.equal(check({ [s.id]: { kind: "true_false", value: true } }).ok, false, "kind mismatch");
  assert.equal(check({ [s.id]: { kind: "single", optionId: m.options[0].id } }).ok, false, "option of another question");
  assert.equal(check({ [m.id]: { kind: "multiple", optionIds: ["oNope"] } }).ok, false, "unknown option");
  assert.equal(check({ [sh.id]: { kind: "short", text: "x".repeat(1001) } }).ok, false, "short answer too long");
  assert.equal(check({ [t.id]: { kind: "true_false", value: true, extra: 1 } }).ok, false, "unknown field");
  assert.equal(check(null).ok, false);
  assert.equal(check([]).ok, false);
  assert.equal(check(JSON.parse('{"__proto__": {"kind": "true_false", "value": true}}')).ok, false, "__proto__ key");
});

test("targets: 1 to 50 distinct rooms, MAIN or BREAKOUT with an id", () => {
  ok(v.targetsSchema, [{ type: "MAIN" }]);
  ok(v.targetsSchema, [{ type: "MAIN" }, { type: "BREAKOUT", id: "0abad041-1c2d@breakout.meet.example.live" }]);
  bad(v.targetsSchema, []);
  bad(v.targetsSchema, [{ type: "MAIN" }, { type: "MAIN" }]);
  bad(v.targetsSchema, [{ type: "BREAKOUT", id: "r1" }, { type: "BREAKOUT", id: "r1" }]);
  bad(v.targetsSchema, [{ type: "BREAKOUT" }]);
  bad(v.targetsSchema, [{ type: "BREAKOUT", id: "bad id" }]);
  bad(v.targetsSchema, [{ type: "MAIN", id: "x" }]);
  ok(v.targetsSchema, Array.from({ length: 50 }, (_, i) => ({ type: "BREAKOUT", id: `room${i}` })));
  bad(v.targetsSchema, Array.from({ length: 51 }, (_, i) => ({ type: "BREAKOUT", id: `room${i}` })));
});

test("assignment create: title 1-200, instructions up to 20 000", () => {
  const base = { title: "Essay", instructions: "Write", targets: [{ type: "MAIN" }], publish: true };
  ok(v.assignmentCreateSchema, base);
  ok(v.assignmentCreateSchema, { ...base, title: "x".repeat(200), instructions: "x".repeat(20000) });
  ok(v.assignmentCreateSchema, { ...base, instructions: "" });
  bad(v.assignmentCreateSchema, { ...base, title: "x".repeat(201) });
  bad(v.assignmentCreateSchema, { ...base, title: "   " });
  bad(v.assignmentCreateSchema, { ...base, instructions: "x".repeat(20001) });
  bad(v.assignmentCreateSchema, { ...base, publish: "true" });
  bad(v.assignmentCreateSchema, { ...base, classSessionId: "x" }, "the session comes from the URL, never the body");
});

test("quiz create: time limit 60 to 14 400 seconds, or none", () => {
  const base = { title: "Quiz", questions: [tf()], targets: [{ type: "MAIN" }], publish: false };
  ok(v.quizCreateSchema, base);
  ok(v.quizCreateSchema, { ...base, timeLimitSeconds: null });
  for (const s of [60, 14400]) ok(v.quizCreateSchema, { ...base, timeLimitSeconds: s });
  for (const s of [59, 14401, 90.5, 0]) bad(v.quizCreateSchema, { ...base, timeLimitSeconds: s });
});

test("draft save: revision >= 0, text up to 50 000", () => {
  ok(v.draftSaveSchema, { revision: 0, answerText: "" });
  ok(v.draftSaveSchema, { revision: 7, answerText: "x".repeat(50000) });
  bad(v.draftSaveSchema, { revision: -1, answerText: "" });
  bad(v.draftSaveSchema, { revision: 1.5, answerText: "" });
  bad(v.draftSaveSchema, { revision: 0, answerText: "x".repeat(50001) });
});

test("grading overrides: 1 to 100 entries, marks >= 0 with 2 decimals or null, note up to 500", () => {
  ok(v.gradingOverridesSchema, { overrides: [{ questionId: "q1", marks: 0 }] });
  ok(v.gradingOverridesSchema, { overrides: [{ questionId: "q1", marks: null }] });
  ok(v.gradingOverridesSchema, { overrides: [{ questionId: "q1", marks: 1.25, note: "x".repeat(500) }] });
  bad(v.gradingOverridesSchema, { overrides: [] });
  bad(v.gradingOverridesSchema, { overrides: [{ questionId: "q1", marks: -0.01 }] });
  bad(v.gradingOverridesSchema, { overrides: [{ questionId: "q1", marks: 1.005 }] });
  bad(v.gradingOverridesSchema, { overrides: [{ questionId: "q1", marks: 1, note: "x".repeat(501) }] });
  bad(v.gradingOverridesSchema, { overrides: Array.from({ length: 101 }, (_, i) => ({ questionId: `q${i}`, marks: 0 })) });
});

test("idempotency key schema matches the submission rules", () => {
  ok(v.idempotencyKeySchema, "2f1c9a4e-7b1d-4c2a-9f0e-3b5d6c7a8e9f");
  bad(v.idempotencyKeySchema, "");
  bad(v.idempotencyKeySchema, "x".repeat(65));
});
