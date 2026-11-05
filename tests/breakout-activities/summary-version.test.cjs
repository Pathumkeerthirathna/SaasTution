/*
 * Breakout summaryVersion (lib/breakout-activities/summary-version.ts): the
 * fingerprint the End Session confirmation is checked against.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const s = require(path.join(root, "lib/breakout-activities/summary-version.ts"));

const rows = () => ({
  assignments: { count: 2, lastChangedAt: new Date("2026-11-05T08:00:00.000Z") },
  drafts: { count: BigInt(3), lastChangedAt: "2026-11-05T08:01:00.000Z", revisionSum: BigInt(9) },
  submissions: { count: "4", lastChangedAt: new Date("2026-11-05T08:02:00.000Z") },
  quizzes: { count: 1, lastChangedAt: new Date("2026-11-05T08:03:00.000Z") },
  quizSubmissions: { count: 5, lastChangedAt: new Date("2026-11-05T08:04:00.123Z"), revisionSum: 17 },
});
const empty = () => ({
  assignments: { count: 0, lastChangedAt: null },
  drafts: { count: 0, lastChangedAt: null, revisionSum: null },
  submissions: { count: 0, lastChangedAt: null },
  quizzes: { count: 0, lastChangedAt: null },
  quizSubmissions: { count: 0, lastChangedAt: null, revisionSum: null },
});

test("64 lowercase hex characters, deterministic", () => {
  const v1 = s.computeSummaryVersion(rows());
  assert.match(v1, /^[0-9a-f]{64}$/);
  assert.equal(s.computeSummaryVersion(rows()), v1);
  assert.equal(s.isSummaryVersion(v1), true);
  assert.equal(s.isSummaryVersion(v1.toUpperCase()), false);
  assert.equal(s.isSummaryVersion("abc"), false);
});

test("same data in other forms gives the same version", () => {
  const base = s.computeSummaryVersion(rows());
  const reordered = rows();
  const shuffled = { quizSubmissions: reordered.quizSubmissions, quizzes: reordered.quizzes, submissions: reordered.submissions, drafts: reordered.drafts, assignments: reordered.assignments };
  assert.equal(s.computeSummaryVersion(shuffled), base, "key order");
  const forms = rows();
  forms.assignments.count = BigInt(2);
  forms.drafts.count = "003";
  forms.drafts.lastChangedAt = new Date("2026-11-05T08:01:00.000Z");
  forms.quizSubmissions.revisionSum = "17";
  assert.equal(s.computeSummaryVersion(forms), base, "bigint / string / Date forms");
});

test("any change changes the version", () => {
  const base = s.computeSummaryVersion(rows());
  const changes = [
    (r) => { r.assignments.count = 3; },
    (r) => { r.submissions.count = "5"; },
    (r) => { r.drafts.lastChangedAt = "2026-11-05T08:01:00.001Z"; },
    (r) => { r.quizSubmissions.revisionSum = 18; },
    (r) => { r.drafts.revisionSum = BigInt(10); },
    (r) => { r.quizzes.lastChangedAt = null; },
  ];
  const seen = new Set([base]);
  for (const change of changes) {
    const r = rows();
    change(r);
    const version = s.computeSummaryVersion(r);
    assert.notEqual(version, base, change.toString());
    seen.add(version);
  }
  assert.equal(seen.size, changes.length + 1);
});

test("a missing revision sum (no rows) is 0", () => {
  const a = empty();
  const b = empty();
  b.drafts.revisionSum = 0;
  b.quizSubmissions.revisionSum = BigInt(0);
  assert.equal(s.computeSummaryVersion(a), s.computeSummaryVersion(b));
});

test("malformed input is refused", () => {
  const cases = [
    (r) => { delete r.quizzes; },
    (r) => { r.extra = { count: 0, lastChangedAt: null }; },
    (r) => { r.assignments.count = -1; },
    (r) => { r.assignments.count = 1.5; },
    (r) => { r.assignments.count = "1e3"; },
    (r) => { r.assignments.count = BigInt(-1); },
    (r) => { r.assignments.lastChangedAt = "yesterday"; },
    (r) => { r.drafts.revisionSum = "x"; },
  ];
  for (const c of cases) {
    const r = rows();
    c(r);
    assert.throws(() => s.computeSummaryVersion(r), RangeError, c.toString());
  }
  assert.throws(() => s.computeSummaryVersion(null), TypeError);
});

test("counts and emptiness", () => {
  assert.deepEqual(s.summaryCounts(rows()), { assignments: 2, drafts: 3, submissions: 4, quizzes: 1, attempts: 5 });
  assert.equal(s.summaryIsEmpty(rows()), false);
  assert.equal(s.summaryIsEmpty(empty()), true);
  const one = empty();
  one.drafts.count = 1;
  assert.equal(s.summaryIsEmpty(one), false, "a draft alone is data to export");
});
