/*
 * Breakout quiz short answers: normalization and matching
 * (lib/breakout-activities/marking.mjs).
 *
 *   npm run test:breakout
 *
 * Normalization: Unicode NFKC, whitespace runs -> one space, trimmed,
 * lower-cased (locale-independent). Punctuation is kept. ZWJ / ZWNJ are kept
 * (Sinhala and Tamil spellings depend on them).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const load = () => import(pathToFileURL(path.join(root, "lib/breakout-activities/marking.mjs")).href);

const short = (acceptedAnswers, marks = 2) => ({ id: "q1", kind: "short", prompt: "Capital of France?", marks, acceptedAnswers });
const says = (text) => ({ kind: "short", text });

test("normalization: trim, collapse whitespace, lower-case", async () => {
  const { normalizeShortAnswer } = await load();
  assert.equal(normalizeShortAnswer("  Paris  "), "paris");
  assert.equal(normalizeShortAnswer("New\t\tDelhi"), "new delhi");
  assert.equal(normalizeShortAnswer("New \n\r\n Delhi"), "new delhi");
  assert.equal(normalizeShortAnswer("NEW DELHI"), "new delhi", "no-break space");
  assert.equal(normalizeShortAnswer("New　Delhi"), "new delhi", "ideographic space");
});

test("normalization: NFKC folds compatibility forms", async () => {
  const { normalizeShortAnswer } = await load();
  assert.equal(normalizeShortAnswer("１２"), "12", "full-width digits");
  assert.equal(normalizeShortAnswer("ﬁsh"), "fish", "fi ligature");
  assert.equal(normalizeShortAnswer("Café"), normalizeShortAnswer("Café"), "combining accent vs precomposed");
  assert.equal(normalizeShortAnswer("H₂O"), "h2o", "subscript two");
});

test("normalization: punctuation is kept", async () => {
  const { normalizeShortAnswer } = await load();
  assert.equal(normalizeShortAnswer("Paris."), "paris.");
  assert.equal(normalizeShortAnswer("3,5"), "3,5");
});

test("normalization: non-strings and blanks are empty", async () => {
  const { normalizeShortAnswer } = await load();
  for (const v of [undefined, null, 5, {}, [], "", "   ", "\n\t"]) assert.equal(normalizeShortAnswer(v), "");
});

test("Sinhala and Tamil text keeps ZWJ / ZWNJ", async () => {
  const { normalizeShortAnswer } = await load();
  const withZwj = "යන්ත්‍ර"; // යන්ත්‍ර
  const withoutZwj = "යන්ත්ර";
  assert.equal(normalizeShortAnswer(withZwj), withZwj);
  assert.notEqual(normalizeShortAnswer(withZwj), normalizeShortAnswer(withoutZwj), "different spellings stay different");
  const tamil = "சென்னை"; // சென்னை
  assert.equal(normalizeShortAnswer(` ${tamil} `), tamil);
  assert.equal(normalizeShortAnswer("a‌b"), "a‌b");
});

test("matching: any accepted answer gives full marks", async () => {
  const { markQuestion } = await load();
  const q = short(["Paris", "Paree"]);
  assert.deepEqual(markQuestion(q, says("paris")), { auto: 2, result: "correct" });
  assert.deepEqual(markQuestion(q, says("  PAREE ")), { auto: 2, result: "correct" });
  assert.deepEqual(markQuestion(q, says("London")), { auto: 0, result: "incorrect" });
  assert.deepEqual(markQuestion(q, says("Paris.")), { auto: 0, result: "incorrect" }, "punctuation matters");
  assert.deepEqual(markQuestion(q, says("Pari")), { auto: 0, result: "incorrect" }, "no partial matching");
});

test("matching: accepted answers are normalized the same way", async () => {
  const { markQuestion } = await load();
  assert.equal(markQuestion(short(["  New   Delhi "]), says("new delhi")).auto, 2);
  assert.equal(markQuestion(short(["１２"]), says("12")).auto, 2);
});

test("matching: blank answers are unanswered, never matched", async () => {
  const { markQuestion } = await load();
  const q = short(["Paris", "   "]);
  assert.deepEqual(markQuestion(q, says("")), { auto: 0, result: "unanswered" });
  assert.deepEqual(markQuestion(q, says("   ")), { auto: 0, result: "unanswered" });
});

test("matching: a Sinhala answer matches itself", async () => {
  const { markQuestion } = await load();
  const answer = "කොළඹ"; // කොළඹ
  assert.equal(markQuestion(short([answer]), says(`  ${answer}`)).auto, 2);
});
