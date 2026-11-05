/*
 * Breakout assignment submissions: versioning and latest-submission rules
 * (lib/breakout-activities/submission-rules.mjs).
 *
 *   npm run test:breakout
 *
 * The database backstop for "one latest" (the partial unique index) is
 * checked statically in migration-guard.test.cjs; it is not exercised against
 * a database here.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const load = () => import(pathToFileURL(path.join(root, "lib/breakout-activities/submission-rules.mjs")).href);

test("next version is max + 1, starting at 1", async () => {
  const { planNextVersion } = await load();
  assert.deepEqual(planNextVersion([]), { ok: true, version: 1 });
  assert.deepEqual(planNextVersion([1]), { ok: true, version: 2 });
  assert.deepEqual(planNextVersion([3, 1, 2]), { ok: true, version: 4 });
  assert.deepEqual(planNextVersion([1, 3]), { ok: true, version: 4 }, "a gap is never refilled");
});

test("the 20-version limit: the 20th is accepted, the 21st refused", async () => {
  const { planNextVersion, MAX_SUBMISSION_VERSIONS } = await load();
  assert.equal(MAX_SUBMISSION_VERSIONS, 20);
  const nineteen = Array.from({ length: 19 }, (_, i) => i + 1);
  assert.deepEqual(planNextVersion(nineteen), { ok: true, version: 20 });
  assert.deepEqual(planNextVersion([...nineteen, 20]), { ok: false, code: "SUBMISSION_LIMIT_REACHED" });
  assert.deepEqual(planNextVersion([1, 2], 2), { ok: false, code: "SUBMISSION_LIMIT_REACHED" });
});

test("invalid version lists are refused", async () => {
  const { planNextVersion } = await load();
  for (const bad of [[0], [-1], [1.5], [Number.NaN], ["1"], [1, 1]]) {
    assert.throws(() => planNextVersion(bad), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => planNextVersion(null), TypeError);
  assert.throws(() => planNextVersion([], 0), RangeError);
});

test("decision order: replay first, then state, then limit", async () => {
  const { decideSubmission } = await load();
  const full = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.deepEqual(decideSubmission({ assignmentState: "PUBLISHED", replayFound: false, existingVersions: [1, 2] }), { action: "insert", version: 3 });
  assert.deepEqual(decideSubmission({ assignmentState: "PUBLISHED", replayFound: true, existingVersions: full }), { action: "replay" }, "a replay works at the limit");
  assert.deepEqual(decideSubmission({ assignmentState: "CLOSED", replayFound: true, existingVersions: [1] }), { action: "replay" }, "a replay works after closing");
  assert.deepEqual(decideSubmission({ assignmentState: "CLOSED", replayFound: false, existingVersions: [] }), { action: "reject", code: "ASSIGNMENT_CLOSED" });
  assert.deepEqual(decideSubmission({ assignmentState: "DRAFT", replayFound: false, existingVersions: [] }), { action: "reject", code: "ASSIGNMENT_NOT_FOUND" });
  assert.deepEqual(decideSubmission({ assignmentState: "PUBLISHED", replayFound: false, existingVersions: full }), { action: "reject", code: "SUBMISSION_LIMIT_REACHED" });
  assert.deepEqual(decideSubmission({ assignmentState: "CLOSED", replayFound: false, existingVersions: full }), { action: "reject", code: "ASSIGNMENT_CLOSED" }, "closed is reported before the limit");
  assert.throws(() => decideSubmission({ assignmentState: "ARCHIVED", replayFound: false, existingVersions: [] }), RangeError);
});

test("content: text, PDF or both is required", async () => {
  const { checkSubmissionContent } = await load();
  assert.deepEqual(checkSubmissionContent({ answerText: "My answer", hasFile: false }), { ok: true, answerText: "My answer" });
  assert.deepEqual(checkSubmissionContent({ answerText: null, hasFile: true }), { ok: true, answerText: null });
  assert.deepEqual(checkSubmissionContent({ hasFile: true }), { ok: true, answerText: null });
  assert.deepEqual(checkSubmissionContent({ answerText: "Both", hasFile: true }), { ok: true, answerText: "Both" });
  assert.deepEqual(checkSubmissionContent({ answerText: "  \n\t ", hasFile: true }), { ok: true, answerText: null }, "blank text is stored as null");
  for (const answerText of [null, undefined, "", "   ", "\n"]) {
    assert.deepEqual(checkSubmissionContent({ answerText, hasFile: false }), { ok: false, code: "SUBMISSION_EMPTY" });
  }
  assert.throws(() => checkSubmissionContent({ answerText: 5, hasFile: true }), TypeError);
});

test("content: text length boundary is 50 000 characters", async () => {
  const { checkSubmissionContent, MAX_ANSWER_TEXT_LENGTH } = await load();
  assert.equal(MAX_ANSWER_TEXT_LENGTH, 50000);
  assert.equal(checkSubmissionContent({ answerText: "x".repeat(50000), hasFile: false }).ok, true);
  assert.deepEqual(checkSubmissionContent({ answerText: "x".repeat(50001), hasFile: true }), { ok: false, code: "ANSWER_TEXT_TOO_LONG" });
});

test("latest rule: exactly one latest, and it is the highest version", async () => {
  const { assertSingleLatest, pickLatest } = await load();
  assert.doesNotThrow(() => assertSingleLatest([]));
  assert.equal(pickLatest([]), null);
  const good = [{ version: 1, isLatest: false }, { version: 3, isLatest: true }, { version: 2, isLatest: false }];
  assert.deepEqual(pickLatest(good), { version: 3, isLatest: true });
  assert.throws(() => assertSingleLatest([{ version: 1, isLatest: false }, { version: 2, isLatest: false }]), /found 0/);
  assert.throws(() => assertSingleLatest([{ version: 1, isLatest: true }, { version: 2, isLatest: true }]), /found 2/);
  assert.throws(() => assertSingleLatest([{ version: 1, isLatest: false }, { version: 2, isLatest: true }, { version: 3, isLatest: false }]), /not the highest/);
  assert.throws(() => assertSingleLatest([{ version: 2, isLatest: true }, { version: 2, isLatest: false }]), RangeError);
});

test("latest rule across a resubmission: flip, then insert", async () => {
  const { assertSingleLatest, planNextVersion } = await load();
  let rows = [{ version: 1, isLatest: true }];
  for (let i = 0; i < 5; i += 1) {
    const next = planNextVersion(rows.map((r) => r.version));
    assert.equal(next.ok, true);
    rows = rows.map((r) => ({ ...r, isLatest: false }));
    rows.push({ version: next.version, isLatest: true });
    assertSingleLatest(rows);
  }
  assert.equal(rows.filter((r) => r.isLatest).length, 1);
  assert.equal(rows.find((r) => r.isLatest).version, 6);
});

test("idempotency keys: 1-64 characters of A-Z a-z 0-9 _ -", async () => {
  const { isIdempotencyKey } = await load();
  for (const ok of ["a", "2f1c9a4e-7b1d-4c2a-9f0e-3b5d6c7a8e9f", "x".repeat(64), "A_b-9"]) assert.equal(isIdempotencyKey(ok), true, ok);
  for (const bad of ["", "x".repeat(65), "has space", "semi;colon", "ü", null, 12]) assert.equal(isIdempotencyKey(bad), false, String(bad));
});
