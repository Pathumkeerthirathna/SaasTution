/*
 * Breakout quiz marking, multiple-answer questions (option A):
 * lib/breakout-activities/marking.mjs
 *
 *   npm run test:breakout
 *
 * Rule: none selected -> 0; more selected than there are correct options -> 0;
 * otherwise min(marks, round2(marks x correctSelected / totalCorrect)).
 * Wrong selections within the limit do not deduct. Never negative.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const load = () => import(pathToFileURL(path.join(root, "lib/breakout-activities/marking.mjs")).href);

const options = ["A", "B", "C", "D", "E"].map((id) => ({ id, text: `Option ${id}` }));
const question = (marks, correctOptionIds, opts = options) => ({
  id: "q1",
  kind: "multiple",
  prompt: "Pick all that apply",
  marks,
  options: opts,
  correctOptionIds,
});
const pick = (...optionIds) => ({ kind: "multiple", optionIds });

test("approved examples: 4 marks, correct = {A, B, C}", async () => {
  const { markQuestion } = await load();
  const q = question(4, ["A", "B", "C"]);
  const cases = [
    [["A", "B", "C"], 4, "correct"],
    [["A", "B"], 2.67, "partial"],
    [["A"], 1.33, "partial"],
    [["A", "D"], 1.33, "partial"],
    [["A", "B", "D"], 2.67, "partial"],
    [["A", "B", "C", "D"], 0, "incorrect"],
    [["D"], 0, "incorrect"],
    [["D", "E"], 0, "incorrect"],
  ];
  for (const [selected, auto, result] of cases) {
    assert.deepEqual(markQuestion(q, pick(...selected)), { auto, result }, `selected ${selected.join(",")}`);
  }
});

test("nothing selected is unanswered (0)", async () => {
  const { markQuestion } = await load();
  const q = question(4, ["A", "B"]);
  assert.deepEqual(markQuestion(q, pick()), { auto: 0, result: "unanswered" });
  assert.deepEqual(markQuestion(q, undefined), { auto: 0, result: "unanswered" });
  assert.deepEqual(markQuestion(q, null), { auto: 0, result: "unanswered" });
});

test("selecting every option never earns full marks unless every option is correct", async () => {
  const { markQuestion } = await load();
  assert.equal(markQuestion(question(5, ["A", "B"]), pick("A", "B", "C", "D", "E")).auto, 0);
  assert.deepEqual(markQuestion(question(5, ["A", "B", "C", "D", "E"]), pick("A", "B", "C", "D", "E")), { auto: 5, result: "correct" });
});

test("duplicate selections count once", async () => {
  const { markQuestion } = await load();
  const q = question(4, ["A", "B"]);
  assert.deepEqual(markQuestion(q, pick("A", "A", "A")), { auto: 2, result: "partial" });
  assert.deepEqual(markQuestion(q, pick("A", "B", "A", "B")), { auto: 4, result: "correct" });
});

test("one correct option out of ten", async () => {
  const { markQuestion } = await load();
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, text: `${i}` }));
  const q = question(3, ["o7"], ten);
  assert.deepEqual(markQuestion(q, pick("o7")), { auto: 3, result: "correct" });
  assert.deepEqual(markQuestion(q, pick("o1")), { auto: 0, result: "incorrect" });
  assert.equal(markQuestion(q, pick("o7", "o1")).auto, 0, "two selected, one correct exists");
});

test("rounding is to 2 decimals, half up, and never exceeds the marks", async () => {
  const { markQuestion } = await load();
  // 1 mark x 1/8 = 0.125 -> 0.13
  const eight = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, text: `${i}` }));
  const q8 = question(1, ["o0", "o1", "o2", "o3", "o4", "o5", "o6", "o7"], eight);
  assert.equal(markQuestion(q8, pick("o0")).auto, 0.13);
  assert.equal(markQuestion(q8, pick("o0", "o1", "o2")).auto, 0.38); // 0.375
  // 0.01 marks x 1/3 = 0.0033 -> 0
  assert.deepEqual(markQuestion(question(0.01, ["A", "B", "C"]), pick("A")), { auto: 0, result: "incorrect" });
  // 100 marks x 2/3 = 66.666 -> 66.67
  assert.equal(markQuestion(question(100, ["A", "B", "C"]), pick("A", "C")).auto, 66.67);
  for (let n = 1; n <= 5; n += 1) {
    const all = ["A", "B", "C", "D", "E"].slice(0, n);
    for (let k = 1; k <= n; k += 1) {
      const auto = markQuestion(question(7.77, all), pick(...all.slice(0, k))).auto;
      assert.ok(auto >= 0 && auto <= 7.77, `${k}/${n} -> ${auto}`);
    }
  }
});

test("a selection of an unknown option counts toward the selection limit and is never correct", async () => {
  const { markQuestion } = await load();
  const q = question(4, ["A", "B"]);
  assert.equal(markQuestion(q, pick("A", "ZZ")).auto, 2);
  assert.equal(markQuestion(q, pick("A", "B", "ZZ")).auto, 0);
});

test("an answer of another kind is unanswered", async () => {
  const { markQuestion } = await load();
  assert.deepEqual(markQuestion(question(4, ["A"]), { kind: "single", optionId: "A" }), { auto: 0, result: "unanswered" });
});

test("a multiple-answer question with no correct option is refused", async () => {
  const { markQuestion, BreakoutMarkingError } = await load();
  assert.throws(() => markQuestion(question(4, []), pick("A")), BreakoutMarkingError);
});
