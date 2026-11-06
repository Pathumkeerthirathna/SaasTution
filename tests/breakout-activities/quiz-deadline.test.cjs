/*
 * Breakout quiz deadlines (lib/breakout-activities/quiz-deadline.ts, audit fix
 * L3): the unchanged 5 s grace and strict expiry comparison, and the one rule
 * for the submittedAt of an AUTOMATIC submission: min(now, deadlineAt + 5 s),
 * untimed: now.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { QUIZ_DEADLINE_GRACE_MS, isPastGrace, autoSubmittedAt } = require(path.join(root, "lib/breakout-activities/quiz-deadline.ts"));

const deadline = new Date("2026-11-06T09:10:00.000Z");
const at = (ms) => new Date(deadline.getTime() + ms);

test("the grace is still exactly 5 s", () => {
  assert.equal(QUIZ_DEADLINE_GRACE_MS, 5_000);
});

test("expiry is unchanged: strictly after deadlineAt + 5 s; +5 s exactly is not expired; untimed never", () => {
  assert.equal(isPastGrace(deadline, at(-1)), false);
  assert.equal(isPastGrace(deadline, at(0)), false);
  assert.equal(isPastGrace(deadline, at(4_999)), false);
  assert.equal(isPastGrace(deadline, at(5_000)), false, "inclusive grace");
  assert.equal(isPastGrace(deadline, at(5_001)), true);
  assert.equal(isPastGrace(null, new Date("2030-01-01T00:00:00.000Z")), false, "untimed");
});

test("autoSubmittedAt: the earlier of now and deadlineAt + 5 s", () => {
  assert.equal(autoSubmittedAt(deadline, at(-60_000)).toISOString(), at(-60_000).toISOString(), "before the deadline (teacher close): now");
  assert.equal(autoSubmittedAt(deadline, at(0)).toISOString(), at(0).toISOString());
  assert.equal(autoSubmittedAt(deadline, at(5_000)).toISOString(), at(5_000).toISOString(), "at the boundary: both equal");
  assert.equal(autoSubmittedAt(deadline, at(5_001)).toISOString(), at(5_000).toISOString(), "1 ms late: capped");
  assert.equal(autoSubmittedAt(deadline, at(3_600_000)).toISOString(), at(5_000).toISOString(), "an hour late: still deadline + 5 s");
});

test("autoSubmittedAt: untimed attempts keep now; the inputs are never mutated", () => {
  const now = new Date("2026-11-08T12:00:00.000Z");
  const result = autoSubmittedAt(null, now);
  assert.equal(result.toISOString(), now.toISOString());
  assert.notEqual(result, now, "a new Date");
  const d = new Date(deadline);
  autoSubmittedAt(d, at(9_999_999));
  assert.equal(d.toISOString(), deadline.toISOString());
});
