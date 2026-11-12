/*
 * approvalDuring / explainApprovalDuring / confirmationTimeline
 * (lib/student-confirmation-history.ts): was a student approved at any moment
 * of a [start, end) window, from StudentConfirmationHistory, given when the
 * approval feature started (APPROVAL_FEATURE_STARTED_AT)?
 *
 *   npm run test:confirmation
 *
 * Pure functions; no database, no environment. The feature start used here is
 * a test value, not a real environment's.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const lib = require(path.join(root, "lib", "student-confirmation-history.ts"));
const {
  approvalDuring,
  explainApprovalDuring,
  approvalAt,
  explainApprovalAt,
  confirmationTimeline,
  approvalHistoryContextFromSetting,
  isAutomaticallyEligible,
  needsManualApprovalReview,
  APPROVAL_FEATURE_STARTED_AT_SETTING,
  MAX_JS_DATE_MS,
} = lib;

const at = (iso) => new Date(`${iso}Z`);
const win = (start, end) => ({ start: at(start), end: at(end) });

const FEATURE = at("2026-07-28T00:00:00.000");
const CTX = { approvalFeatureStartedAt: FEATURE };

const during = (student, history, window, ctx = CTX) => approvalDuring(student, history, window, ctx);
const explain = (student, history, window, ctx = CTX) => explainApprovalDuring(student, history, window, ctx);

/** approvalDuring and explainApprovalDuring agree, and give exactly this. */
function expectBoth(student, history, window, result, reason, ctx = CTX, message) {
  if (typeof ctx === "string") {
    message = ctx;
    ctx = CTX;
  }
  assert.deepEqual(explain(student, history, window, ctx), { result, reason }, message);
  assert.equal(during(student, history, window, ctx), result, message);
}

/** Builds a consistent chain: the student's current state follows the last row. */
function chain(decisions, { startStatus = "PENDING", startAt = null, approvedAt } = {}) {
  let status = startStatus;
  let previous = startAt;
  const history = decisions.map(([to, when], i) => {
    const row = {
      id: `h${i + 1}`,
      fromStatus: status,
      toStatus: to,
      decidedAt: at(when),
      previousConfirmedAt: previous,
    };
    status = to;
    previous = row.decidedAt;
    return row;
  });
  const firstApproval =
    approvedAt !== undefined ? approvedAt : history.find((h) => h.toStatus === "APPROVED")?.decidedAt ?? null;
  return {
    student: { confirmationStatus: status, confirmedAt: previous, approvedAt: firstApproval },
    history,
  };
}

const LECTURE = win("2026-11-10T04:00:00.000", "2026-11-10T06:00:00.000");
const JUNE = win("2026-06-10T04:00:00.000", "2026-06-10T06:00:00.000");
const AUGUST = win("2026-08-10T04:00:00.000", "2026-08-10T06:00:00.000");

// ---- Context: required, validated, fail closed ------------------------------------------

test("a missing or invalid context throws (fail closed), for every entry point", () => {
  const { student, history } = chain([]);
  for (const ctx of [undefined, null, {}, { approvalFeatureStartedAt: null }, { approvalFeatureStartedAt: "2026-07-28" }, { approvalFeatureStartedAt: new Date(Number.NaN) }]) {
    assert.throws(() => approvalDuring(student, history, LECTURE, ctx), TypeError, JSON.stringify(ctx));
    assert.throws(() => explainApprovalDuring(student, history, LECTURE, ctx), TypeError);
    assert.throws(() => confirmationTimeline(student, history, ctx), TypeError);
  }
  assert.throws(() => approvalDuring(student, history, LECTURE), TypeError, "no fourth argument");
});

test("the context error names the setting, never a value", () => {
  const { student, history } = chain([]);
  assert.throws(
    () => approvalDuring(student, history, LECTURE, { approvalFeatureStartedAt: new Date(Number.NaN) }),
    (error) => error.message.includes(APPROVAL_FEATURE_STARTED_AT_SETTING) && !/NaN|Invalid Date/.test(error.message)
  );
});

test("APPROVAL_FEATURE_STARTED_AT parsing: ISO instants with an explicit offset only, no fallback", () => {
  assert.equal(APPROVAL_FEATURE_STARTED_AT_SETTING, "APPROVAL_FEATURE_STARTED_AT");
  const parsed = (raw) => approvalHistoryContextFromSetting(raw).approvalFeatureStartedAt.toISOString();
  assert.equal(parsed("2026-07-28T10:00:00+05:30"), "2026-07-28T04:30:00.000Z");
  assert.equal(parsed("2026-07-28T04:30:00Z"), "2026-07-28T04:30:00.000Z");
  assert.equal(parsed("2026-07-28T04:30Z"), "2026-07-28T04:30:00.000Z");
  assert.equal(parsed("2026-07-28T04:30:00.5Z"), "2026-07-28T04:30:00.500Z");
  assert.equal(parsed("  2026-07-28T00:00:00-03:00  "), "2026-07-28T03:00:00.000Z");
  assert.equal(parsed("2028-02-29T00:00:00Z"), "2028-02-29T00:00:00.000Z", "leap day");

  for (const raw of [undefined, null, "", "   "]) {
    assert.throws(() => approvalHistoryContextFromSetting(raw), /APPROVAL_FEATURE_STARTED_AT is not configured\./);
  }
  const secretLooking = "2026-07-28T10:00:00"; // no offset: refused, and never echoed
  for (const raw of [
    secretLooking,
    "2026-07-28",
    "2026-02-30T00:00:00Z",
    "2027-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-07-28T24:00:00Z",
    "2026-07-28T10:60:00Z",
    "2026-07-28T10:00:60Z",
    "2026-07-28T10:00:00+15:00",
    "2026-07-28T10:00:00+05:60",
    "28/07/2026 10:00",
    "1785180249000",
    "now",
  ]) {
    assert.throws(
      () => approvalHistoryContextFromSetting(raw),
      (error) => error.message.startsWith("APPROVAL_FEATURE_STARTED_AT must be") && !error.message.includes(raw),
      raw
    );
  }
});

test("APPROVAL_FEATURE_STARTED_AT offsets: -14:00 to +14:00 inclusive, Z and +00:00 accepted, -00:00 refused", () => {
  const parsed = (offset) =>
    approvalHistoryContextFromSetting(`2026-07-28T10:00:00${offset}`).approvalFeatureStartedAt.toISOString();

  const accepted = {
    "+14:00": "2026-07-27T20:00:00.000Z",
    "-14:00": "2026-07-29T00:00:00.000Z",
    "+13:59": "2026-07-27T20:01:00.000Z",
    "-13:59": "2026-07-28T23:59:00.000Z",
    "-12:00": "2026-07-28T22:00:00.000Z",
    "+05:30": "2026-07-28T04:30:00.000Z",
    "+05:45": "2026-07-28T04:15:00.000Z",
    "-03:30": "2026-07-28T13:30:00.000Z",
    "+00:00": "2026-07-28T10:00:00.000Z",
    "Z": "2026-07-28T10:00:00.000Z",
    "+00:01": "2026-07-28T09:59:00.000Z",
    "-00:01": "2026-07-28T10:01:00.000Z",
  };
  for (const [offset, iso] of Object.entries(accepted)) {
    assert.equal(parsed(offset), iso, offset);
  }

  for (const offset of ["+14:01", "-14:01", "+14:59", "-14:59", "+15:00", "-15:00", "+23:59", "-23:59", "+05:60", "-00:00", "+5:30", "+0530", "+05", "z"]) {
    const raw = `2026-07-28T10:00:00${offset}`;
    assert.throws(
      () => approvalHistoryContextFromSetting(raw),
      (error) => error.message.startsWith("APPROVAL_FEATURE_STARTED_AT must be") && !error.message.includes(raw),
      offset
    );
  }
});

// ---- approvalAt: one instant (point in time) ---------------------------------------------

test("approvalAt: a decision applies at exactly its instant; the moment before is the previous period", () => {
  const { student, history } = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-05T00:00:00.000"],
  ]);
  const atInstant = (iso, ctx = CTX) => explainApprovalAt(student, history, at(iso), ctx);

  assert.deepEqual(atInstant("2026-10-31T23:59:59.999"), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" }, "just before the approval: PENDING");
  assert.deepEqual(atInstant("2026-11-01T00:00:00.000"), { result: "APPROVED", reason: "KNOWN_APPROVED" }, "at the start of the APPROVED period");
  assert.deepEqual(atInstant("2026-11-01T00:00:00.001"), { result: "APPROVED", reason: "KNOWN_APPROVED" });
  assert.deepEqual(atInstant("2026-11-04T23:59:59.999"), { result: "APPROVED", reason: "KNOWN_APPROVED" }, "just before the decline");
  assert.deepEqual(atInstant("2026-11-05T00:00:00.000"), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" }, "the decline applies at its instant");
  assert.deepEqual(atInstant("2026-11-05T00:00:00.001"), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" });

  for (const iso of ["2026-10-31T23:59:59.999", "2026-11-01T00:00:00.000", "2026-11-05T00:00:00.000"]) {
    assert.equal(approvalAt(student, history, at(iso), CTX), atInstant(iso).result, iso);
  }
});

test("approvalAt agrees with approvalDuring on the one-millisecond window, and the partial-lecture example differs as intended", () => {
  const { student, history } = chain([
    ["APPROVED", "2026-11-10T10:00:00.000"],
    ["REJECTED", "2026-11-10T11:00:00.000"],
  ]);
  for (const iso of ["2026-11-10T09:59:59.999", "2026-11-10T10:00:00.000", "2026-11-10T10:30:00.000", "2026-11-10T10:59:59.999", "2026-11-10T11:00:00.000", "2026-11-10T12:00:00.000"]) {
    const instant = at(iso);
    assert.deepEqual(
      explainApprovalAt(student, history, instant, CTX),
      explainApprovalDuring(student, history, { start: instant, end: new Date(instant.getTime() + 1) }, CTX),
      iso
    );
  }
  // Lecture 10:30–12:00: approved at some moment (information), approved at its start (roster / ABSENT) …
  assert.equal(approvalDuring(student, history, win("2026-11-10T10:30:00.000", "2026-11-10T12:00:00.000"), CTX), "APPROVED");
  assert.equal(approvalAt(student, history, at("2026-11-10T10:30:00.000"), CTX), "APPROVED");
  // … but a scan at 11:30 is after the decline.
  assert.equal(approvalAt(student, history, at("2026-11-10T11:30:00.000"), CTX), "NOT_APPROVED");
  // Approved at 11:55 during an 10:30–12:00 lecture: not approved at its start.
  const late = chain([["APPROVED", "2026-11-10T11:55:00.000"]]);
  assert.equal(approvalDuring(late.student, late.history, win("2026-11-10T10:30:00.000", "2026-11-10T12:00:00.000"), CTX), "APPROVED");
  assert.equal(approvalAt(late.student, late.history, at("2026-11-10T10:30:00.000"), CTX), "NOT_APPROVED");
});

test("approvalAt inside UNKNOWN periods keeps the reason; approvedAt is evidence only at its exact instant", () => {
  const legacy = chain([]);
  assert.deepEqual(explainApprovalAt(legacy.student, legacy.history, at("2026-06-10T04:00:00.000"), CTX), { result: "UNKNOWN", reason: "BEFORE_APPROVAL_FEATURE" });
  assert.deepEqual(explainApprovalAt(legacy.student, legacy.history, at("2026-07-27T23:59:59.999"), CTX), { result: "UNKNOWN", reason: "BEFORE_APPROVAL_FEATURE" });
  assert.deepEqual(explainApprovalAt(legacy.student, legacy.history, FEATURE, CTX), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" }, "the feature start is known");

  const backfilled = {
    confirmationStatus: "REJECTED",
    confirmedAt: at("2026-10-20T00:00:00.000"),
    approvedAt: at("2026-09-15T12:00:00.000"),
  };
  assert.deepEqual(explainApprovalAt(backfilled, [], at("2026-09-15T11:59:59.999"), CTX), { result: "UNKNOWN", reason: "BEFORE_RECORDED_DECISIONS" });
  assert.deepEqual(explainApprovalAt(backfilled, [], at("2026-09-15T12:00:00.000"), CTX), { result: "APPROVED", reason: "APPROVED_AT_EVIDENCE" });
  assert.deepEqual(explainApprovalAt(backfilled, [], at("2026-09-15T12:00:00.001"), CTX), { result: "UNKNOWN", reason: "BEFORE_RECORDED_DECISIONS" });
  assert.deepEqual(explainApprovalAt(backfilled, [], at("2026-10-20T00:00:00.000"), CTX), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" });
});

test("approvalAt inside an APPROVED_AT_CONFLICT period is UNKNOWN, even at the approvedAt instant", () => {
  const victim = {
    confirmationStatus: "REJECTED",
    confirmedAt: at("2026-10-15T03:59:59.800"),
    approvedAt: at("2026-10-15T04:00:00.000"),
  };
  for (const iso of ["2026-10-15T03:59:59.800", "2026-10-15T04:00:00.000", "2026-11-10T04:00:00.000"]) {
    assert.deepEqual(explainApprovalAt(victim, [], at(iso), CTX), { result: "UNKNOWN", reason: "APPROVED_AT_CONFLICT" }, iso);
    assert.equal(isAutomaticallyEligible(approvalAt(victim, [], at(iso), CTX)), false);
  }
  assert.deepEqual(explainApprovalAt(victim, [], at("2026-10-15T03:59:59.799"), CTX), { result: "UNKNOWN", reason: "BEFORE_RECORDED_DECISIONS" });
});

test("approvalAt with broken history is UNKNOWN (BROKEN_HISTORY)", () => {
  const { student, history } = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-05T00:00:00.000"],
  ]);
  history[1].fromStatus = "PENDING";
  assert.deepEqual(explainApprovalAt(student, history, at("2026-11-02T00:00:00.000"), CTX), { result: "UNKNOWN", reason: "BROKEN_HISTORY" });
  assert.deepEqual(
    explainApprovalAt({ confirmationStatus: "REJECTED", confirmedAt: null, approvedAt: null }, [], at("2026-11-02T00:00:00.000"), CTX),
    { result: "UNKNOWN", reason: "BROKEN_HISTORY" }
  );
});

test("approvalAt: missing or invalid context, or an invalid instant, throws", () => {
  const { student, history } = chain([]);
  const instant = at("2026-11-10T04:00:00.000");
  for (const ctx of [undefined, null, {}, { approvalFeatureStartedAt: "2026-07-28" }, { approvalFeatureStartedAt: new Date(Number.NaN) }]) {
    assert.throws(() => approvalAt(student, history, instant, ctx), TypeError);
    assert.throws(() => explainApprovalAt(student, history, instant, ctx), TypeError);
  }
  for (const bad of [undefined, null, "2026-11-10T04:00:00Z", Date.parse("2026-11-10T04:00:00Z"), new Date(Number.NaN)]) {
    assert.throws(() => approvalAt(student, history, bad, CTX), RangeError, String(bad));
  }
});

test("approvalAt: the maximum valid JavaScript Date is outside the supported range", () => {
  assert.equal(MAX_JS_DATE_MS, 8.64e15);
  assert.ok(!Number.isNaN(new Date(MAX_JS_DATE_MS).getTime()), "the maximum itself is a valid Date");
  assert.ok(Number.isNaN(new Date(MAX_JS_DATE_MS + 1).getTime()), "the next millisecond is not");

  const approved = { confirmationStatus: "APPROVED", confirmedAt: null, approvedAt: null };
  for (const fn of [approvalAt, explainApprovalAt]) {
    assert.throws(
      () => fn(approved, [], new Date(MAX_JS_DATE_MS), CTX),
      (error) => error instanceof RangeError && error.message === "approvalAt: the instant is outside the supported range."
    );
  }
  // A missing context is still reported first.
  assert.throws(() => approvalAt(approved, [], new Date(MAX_JS_DATE_MS), undefined), TypeError);
});

test("approvalAt: the maximum Date minus 1 ms and the minimum valid Date evaluate normally", () => {
  const approved = { confirmationStatus: "APPROVED", confirmedAt: null, approvedAt: null };
  const pending = chain([]).student;
  const beforeMax = new Date(MAX_JS_DATE_MS - 1);
  const min = new Date(-MAX_JS_DATE_MS);
  assert.ok(!Number.isNaN(min.getTime()));

  assert.deepEqual(explainApprovalAt(approved, [], beforeMax, CTX), { result: "APPROVED", reason: "KNOWN_APPROVED" });
  assert.deepEqual(explainApprovalAt(pending, [], beforeMax, CTX), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" });
  assert.deepEqual(explainApprovalAt(approved, [], min, CTX), { result: "UNKNOWN", reason: "BEFORE_APPROVAL_FEATURE" });
  assert.deepEqual(explainApprovalAt(pending, [], min, CTX), { result: "UNKNOWN", reason: "BEFORE_APPROVAL_FEATURE" });
  assert.equal(approvalAt(approved, [], beforeMax, CTX), "APPROVED");
});

test("approvalAt: every UNKNOWN reason is never automatically eligible and always needs manual review", () => {
  const cases = [
    ["BEFORE_APPROVAL_FEATURE", chain([]).student, [], at("2026-06-10T04:00:00.000")],
    [
      "BEFORE_RECORDED_DECISIONS",
      { confirmationStatus: "APPROVED", confirmedAt: at("2026-10-01T00:00:00.000"), approvedAt: null },
      [],
      at("2026-09-01T00:00:00.000"),
    ],
    [
      "APPROVED_AT_CONFLICT",
      { confirmationStatus: "REJECTED", confirmedAt: at("2026-10-15T03:59:59.800"), approvedAt: at("2026-10-15T04:00:00.000") },
      [],
      at("2026-10-15T04:00:00.000"),
    ],
    ["BROKEN_HISTORY", { confirmationStatus: "REJECTED", confirmedAt: null, approvedAt: null }, [], at("2026-11-10T04:00:00.000")],
  ];
  for (const [reason, student, history, instant] of cases) {
    assert.deepEqual(explainApprovalAt(student, history, instant, CTX), { result: "UNKNOWN", reason }, reason);
    const result = approvalAt(student, history, instant, CTX);
    assert.equal(result, "UNKNOWN", reason);
    assert.equal(isAutomaticallyEligible(result), false, reason);
    assert.equal(needsManualApprovalReview(result), true, reason);
  }
});

test("approvalAt at the H1 boundary: a genuine decision earlier than the configured start is known from that decision", () => {
  const late = { approvalFeatureStartedAt: at("2026-08-01T00:00:00.000") };
  const approved = chain([["APPROVED", "2026-07-20T00:00:00.000"]]);
  assert.deepEqual(explainApprovalAt(approved.student, approved.history, at("2026-07-19T23:59:59.999"), late), { result: "UNKNOWN", reason: "BEFORE_APPROVAL_FEATURE" });
  assert.deepEqual(explainApprovalAt(approved.student, approved.history, at("2026-07-20T00:00:00.000"), late), { result: "APPROVED", reason: "KNOWN_APPROVED" });
  assert.deepEqual(explainApprovalAt(approved.student, approved.history, at("2026-07-31T23:59:59.999"), late), { result: "APPROVED", reason: "KNOWN_APPROVED" });
  assert.deepEqual(explainApprovalAt(approved.student, approved.history, at("2026-08-01T00:00:00.000"), late), { result: "APPROVED", reason: "KNOWN_APPROVED" });

  const declined = chain([["REJECTED", "2026-07-20T00:00:00.000"]]);
  assert.deepEqual(explainApprovalAt(declined.student, declined.history, at("2026-07-19T23:59:59.999"), late), { result: "UNKNOWN", reason: "BEFORE_APPROVAL_FEATURE" });
  assert.deepEqual(explainApprovalAt(declined.student, declined.history, at("2026-07-20T00:00:00.000"), late), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" });
});

test("approvalAt with a decision exactly at the configured feature start (no empty starting period)", () => {
  const approved = chain([["APPROVED", "2026-07-28T00:00:00.000"]]);
  assert.deepEqual(explainApprovalAt(approved.student, approved.history, new Date(FEATURE.getTime() - 1), CTX), { result: "UNKNOWN", reason: "BEFORE_APPROVAL_FEATURE" });
  assert.deepEqual(explainApprovalAt(approved.student, approved.history, FEATURE, CTX), { result: "APPROVED", reason: "KNOWN_APPROVED" });
  assert.deepEqual(
    confirmationTimeline(approved.student, approved.history, CTX).map((s) => [s.from && s.from.toISOString(), s.to && s.to.toISOString(), s.status]),
    [
      [null, "2026-07-28T00:00:00.000Z", "UNKNOWN"],
      ["2026-07-28T00:00:00.000Z", null, "APPROVED"],
    ]
  );

  const declined = chain([["REJECTED", "2026-07-28T00:00:00.000"]]);
  assert.deepEqual(explainApprovalAt(declined.student, declined.history, new Date(FEATURE.getTime() - 1), CTX), { result: "UNKNOWN", reason: "BEFORE_APPROVAL_FEATURE" });
  assert.deepEqual(explainApprovalAt(declined.student, declined.history, FEATURE, CTX), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" });
});

test("approvalAt at K - 1 ms and K for a pre-history decision without an approvedAt conflict", () => {
  const K = at("2026-10-01T00:00:00.000");
  const justBefore = new Date(K.getTime() - 1);

  // No history rows: approved at K by the old code (backfilled approvedAt = K is consistent).
  for (const approvedAt of [null, K]) {
    const student = { confirmationStatus: "APPROVED", confirmedAt: K, approvedAt };
    assert.deepEqual(explainApprovalAt(student, [], justBefore, CTX), { result: "UNKNOWN", reason: "BEFORE_RECORDED_DECISIONS" });
    assert.deepEqual(explainApprovalAt(student, [], K, CTX), { result: "APPROVED", reason: "KNOWN_APPROVED" });
    assert.ok(confirmationTimeline(student, [], CTX).every((s) => s.reason !== "APPROVED_AT_CONFLICT"));
  }

  // With a later recorded decision: K comes from previousConfirmedAt.
  const { student, history } = chain([["REJECTED", "2026-11-01T00:00:00.000"]], { startStatus: "APPROVED", startAt: K });
  assert.equal(student.approvedAt, null);
  assert.deepEqual(explainApprovalAt(student, history, justBefore, CTX), { result: "UNKNOWN", reason: "BEFORE_RECORDED_DECISIONS" });
  assert.deepEqual(explainApprovalAt(student, history, K, CTX), { result: "APPROVED", reason: "KNOWN_APPROVED" });
  assert.deepEqual(explainApprovalAt(student, history, at("2026-11-01T00:00:00.000"), CTX), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" });

  // A declined student decided at K by the old code.
  const rejected = { confirmationStatus: "REJECTED", confirmedAt: K, approvedAt: null };
  assert.deepEqual(explainApprovalAt(rejected, [], justBefore, CTX), { result: "UNKNOWN", reason: "BEFORE_RECORDED_DECISIONS" });
  assert.deepEqual(explainApprovalAt(rejected, [], K, CTX), { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" });
});

// ---- H1: students without a recorded decision, before / after the feature start -----------

test("H1: a legacy PENDING student (never decided): UNKNOWN before the feature start, NOT_APPROVED after", () => {
  const { student, history } = chain([]);
  expectBoth(student, history, JUNE, "UNKNOWN", "BEFORE_APPROVAL_FEATURE");
  expectBoth(student, history, AUGUST, "NOT_APPROVED", "KNOWN_NOT_APPROVED");
  expectBoth(student, history, LECTURE, "NOT_APPROVED", "KNOWN_NOT_APPROVED");
});

test("H1: windows crossing or touching the feature start (half-open)", () => {
  const { student, history } = chain([]);
  expectBoth(student, history, win("2026-07-27T23:00:00.000", "2026-07-28T01:00:00.000"), "UNKNOWN", "BEFORE_APPROVAL_FEATURE");
  expectBoth(student, history, win("2026-07-27T23:00:00.000", "2026-07-28T00:00:00.000"), "UNKNOWN", "BEFORE_APPROVAL_FEATURE", "ends exactly at the start");
  expectBoth(student, history, win("2026-07-27T23:00:00.000", "2026-07-28T00:00:00.001"), "UNKNOWN", "BEFORE_APPROVAL_FEATURE");
  expectBoth(student, history, win("2026-07-28T00:00:00.000", "2026-07-28T01:00:00.000"), "NOT_APPROVED", "KNOWN_NOT_APPROVED", "starts exactly at the start");
  expectBoth(student, history, win("2020-01-01T00:00:00.000", "2030-01-01T00:00:00.000"), "UNKNOWN", "BEFORE_APPROVAL_FEATURE");
});

test("H1: created already approved (teacher / import / admin; never decided): APPROVED from the feature start, UNKNOWN before", () => {
  const student = { confirmationStatus: "APPROVED", confirmedAt: null, approvedAt: null };
  expectBoth(student, [], LECTURE, "APPROVED", "KNOWN_APPROVED");
  expectBoth(student, [], JUNE, "UNKNOWN", "BEFORE_APPROVAL_FEATURE");
  expectBoth(student, [], win("2026-07-27T23:00:00.000", "2026-07-28T01:00:00.000"), "APPROVED", "KNOWN_APPROVED", "any approved moment counts");
});

test("H1: a genuine recorded decision earlier than the configured start is preserved (known from that decision)", () => {
  // The configured start is (safely) later than the real go-live: a decision
  // on 20 July proves the feature existed then.
  const late = { approvalFeatureStartedAt: at("2026-08-01T00:00:00.000") };
  const { student, history } = chain([["APPROVED", "2026-07-20T00:00:00.000"]]);
  expectBoth(student, history, win("2026-07-25T00:00:00.000", "2026-07-26T00:00:00.000"), "APPROVED", "KNOWN_APPROVED", late);
  expectBoth(student, history, win("2026-07-10T00:00:00.000", "2026-07-11T00:00:00.000"), "UNKNOWN", "BEFORE_APPROVAL_FEATURE", late);

  const declined = chain([["REJECTED", "2026-07-20T00:00:00.000"]]);
  expectBoth(declined.student, declined.history, win("2026-07-25T00:00:00.000", "2026-07-26T00:00:00.000"), "NOT_APPROVED", "KNOWN_NOT_APPROVED", late);

  const timeline = confirmationTimeline(student, history, late);
  assert.deepEqual(
    timeline.map((s) => [s.from && s.from.toISOString(), s.to && s.to.toISOString(), s.status, s.reason]),
    [
      [null, "2026-07-20T00:00:00.000Z", "UNKNOWN", "BEFORE_APPROVAL_FEATURE"],
      ["2026-07-20T00:00:00.000Z", null, "APPROVED", undefined],
    ],
    "no empty PENDING period between the decision and the later configured start"
  );
});

test("H1: with a previous decision time (K), the timeline is known from K whatever the feature start", () => {
  const approved = { confirmationStatus: "APPROVED", confirmedAt: at("2026-07-25T00:00:00.000"), approvedAt: null };
  const late = { approvalFeatureStartedAt: at("2026-09-01T00:00:00.000") };
  expectBoth(approved, [], AUGUST, "APPROVED", "KNOWN_APPROVED", late);
  expectBoth(approved, [], win("2026-07-20T00:00:00.000", "2026-07-21T00:00:00.000"), "UNKNOWN", "BEFORE_RECORDED_DECISIONS", late);
});

test("H1: the feature start does not change results for students with recorded decisions after it", () => {
  const { student, history } = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-05T00:00:00.000"],
  ]);
  for (const start of ["2026-07-28T00:00:00.000", "2026-10-31T00:00:00.000"]) {
    const ctx = { approvalFeatureStartedAt: at(start) };
    expectBoth(student, history, win("2026-11-02T00:00:00.000", "2026-11-03T00:00:00.000"), "APPROVED", "KNOWN_APPROVED", ctx);
    expectBoth(student, history, LECTURE, "NOT_APPROVED", "KNOWN_NOT_APPROVED", ctx);
    expectBoth(student, history, win("2026-10-31T12:00:00.000", "2026-11-01T00:00:00.000"), "NOT_APPROVED", "KNOWN_NOT_APPROVED", ctx);
  }
  expectBoth(student, history, JUNE, "UNKNOWN", "BEFORE_APPROVAL_FEATURE");
});

// ---- Complete histories (every decision recorded) --------------------------------------

test("approved before, during or after the window", () => {
  const before = chain([["APPROVED", "2026-11-09T00:00:00.000"]]);
  expectBoth(before.student, before.history, LECTURE, "APPROVED", "KNOWN_APPROVED");

  const duringIt = chain([["APPROVED", "2026-11-10T05:00:00.000"]]);
  expectBoth(duringIt.student, duringIt.history, LECTURE, "APPROVED", "KNOWN_APPROVED");

  const after = chain([["APPROVED", "2026-11-11T00:00:00.000"]]);
  expectBoth(after.student, after.history, LECTURE, "NOT_APPROVED", "KNOWN_NOT_APPROVED");
});

test("half-open boundaries: approved exactly at start counts, exactly at end does not; declined exactly at start does not count", () => {
  const atStart = chain([["APPROVED", "2026-11-10T04:00:00.000"]]);
  assert.equal(during(atStart.student, atStart.history, LECTURE), "APPROVED");

  const atEnd = chain([["APPROVED", "2026-11-10T06:00:00.000"]]);
  assert.equal(during(atEnd.student, atEnd.history, LECTURE), "NOT_APPROVED");

  const lastMs = chain([["APPROVED", "2026-11-10T05:59:59.999"]]);
  assert.equal(during(lastMs.student, lastMs.history, LECTURE), "APPROVED");

  const declinedAtStart = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-10T04:00:00.000"],
  ]);
  expectBoth(declinedAtStart.student, declinedAtStart.history, LECTURE, "NOT_APPROVED", "KNOWN_NOT_APPROVED");

  const declinedOneMsIn = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-10T04:00:00.001"],
  ]);
  expectBoth(declinedOneMsIn.student, declinedOneMsIn.history, LECTURE, "APPROVED", "KNOWN_APPROVED");
});

test("approved then declined inside the window → APPROVED; declined before the window → NOT_APPROVED", () => {
  const inside = chain([
    ["APPROVED", "2026-11-10T04:30:00.000"],
    ["REJECTED", "2026-11-10T05:00:00.000"],
  ]);
  assert.equal(during(inside.student, inside.history, LECTURE), "APPROVED");

  const before = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-09T00:00:00.000"],
  ]);
  assert.equal(during(before.student, before.history, LECTURE), "NOT_APPROVED");
});

test("declined, then confirmed again: only the approved periods count; approvedAt (first approval) stays consistent", () => {
  const { student, history } = chain([
    ["REJECTED", "2026-11-01T00:00:00.000"],
    ["APPROVED", "2026-11-12T00:00:00.000"],
  ]);
  assert.equal(during(student, history, LECTURE), "NOT_APPROVED");
  assert.equal(during(student, history, win("2026-11-12T00:00:00.000", "2026-11-12T01:00:00.000")), "APPROVED");

  const back = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-05T00:00:00.000"],
    ["APPROVED", "2026-11-09T00:00:00.000"],
  ]);
  expectBoth(back.student, back.history, win("2026-11-06T00:00:00.000", "2026-11-07T00:00:00.000"), "NOT_APPROVED", "KNOWN_NOT_APPROVED");
  expectBoth(back.student, back.history, LECTURE, "APPROVED", "KNOWN_APPROVED");
  assert.ok(confirmationTimeline(back.student, back.history, CTX).every((s) => s.reason !== "APPROVED_AT_CONFLICT"));
});

test("history in any order is sorted by decidedAt, then id", () => {
  const { student, history } = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-05T00:00:00.000"],
  ]);
  assert.equal(during(student, [...history].reverse(), LECTURE), "NOT_APPROVED");
});

// ---- Incomplete histories (decisions made before history was recorded) ----------------

test("decided before Stage 4, no history: known only from confirmedAt; earlier windows are UNKNOWN", () => {
  const approved = { confirmationStatus: "APPROVED", confirmedAt: at("2026-10-01T00:00:00.000"), approvedAt: null };
  expectBoth(approved, [], LECTURE, "APPROVED", "KNOWN_APPROVED");
  expectBoth(approved, [], win("2026-09-01T00:00:00.000", "2026-09-02T00:00:00.000"), "UNKNOWN", "BEFORE_RECORDED_DECISIONS");
  expectBoth(approved, [], win("2026-09-30T23:00:00.000", "2026-10-01T01:00:00.000"), "APPROVED", "KNOWN_APPROVED");

  const rejected = { confirmationStatus: "REJECTED", confirmedAt: at("2026-10-01T00:00:00.000"), approvedAt: null };
  expectBoth(rejected, [], LECTURE, "NOT_APPROVED", "KNOWN_NOT_APPROVED");
  expectBoth(rejected, [], win("2026-09-01T00:00:00.000", "2026-09-02T00:00:00.000"), "UNKNOWN", "BEFORE_RECORDED_DECISIONS");
  expectBoth(rejected, [], win("2026-09-30T23:00:00.000", "2026-10-01T01:00:00.000"), "UNKNOWN", "BEFORE_RECORDED_DECISIONS");
});

test("decided before Stage 4, then decided again: previousConfirmedAt extends what is known by one step", () => {
  const { student, history } = chain([["REJECTED", "2026-11-01T00:00:00.000"]], {
    startStatus: "APPROVED",
    startAt: at("2026-10-01T00:00:00.000"),
  });
  assert.equal(during(student, history, win("2026-10-10T00:00:00.000", "2026-10-11T00:00:00.000")), "APPROVED");
  assert.equal(during(student, history, LECTURE), "NOT_APPROVED");
  assert.equal(during(student, history, win("2026-09-10T00:00:00.000", "2026-09-11T00:00:00.000")), "UNKNOWN");
});

// ---- M1: approvedAt as evidence, never against known history --------------------------

test("M1: approvedAt inside an unknown period is evidence only for windows containing that instant", () => {
  const backfilled = {
    confirmationStatus: "REJECTED",
    confirmedAt: at("2026-10-20T00:00:00.000"),
    approvedAt: at("2026-09-15T12:00:00.000"),
  };
  expectBoth(backfilled, [], win("2026-09-15T00:00:00.000", "2026-09-16T00:00:00.000"), "APPROVED", "APPROVED_AT_EVIDENCE");
  expectBoth(backfilled, [], win("2026-09-16T00:00:00.000", "2026-09-17T00:00:00.000"), "UNKNOWN", "BEFORE_RECORDED_DECISIONS");
  expectBoth(backfilled, [], win("2026-09-15T12:00:00.000", "2026-09-15T13:00:00.000"), "APPROVED", "APPROVED_AT_EVIDENCE", "start included");
  expectBoth(backfilled, [], win("2026-09-15T11:00:00.000", "2026-09-15T12:00:00.000"), "UNKNOWN", "BEFORE_RECORDED_DECISIONS", "end excluded");
  expectBoth(backfilled, [], LECTURE, "NOT_APPROVED", "KNOWN_NOT_APPROVED");

  // Before the feature start (a legacy student with a real approval).
  const legacy = chain([["REJECTED", "2026-09-01T00:00:00.000"]], { startStatus: "APPROVED", startAt: at("2026-08-20T00:00:00.000") });
  legacy.student.approvedAt = at("2026-08-02T00:00:00.000");
  expectBoth(legacy.student, legacy.history, win("2026-08-02T00:00:00.000", "2026-08-02T01:00:00.000"), "APPROVED", "APPROVED_AT_EVIDENCE");
});

test("M1: backfilled approvedAt equal to confirmedAt (currently approved) is consistent", () => {
  const student = { confirmationStatus: "APPROVED", confirmedAt: at("2026-10-01T00:00:00.000"), approvedAt: at("2026-10-01T00:00:00.000") };
  expectBoth(student, [], LECTURE, "APPROVED", "KNOWN_APPROVED");
  expectBoth(student, [], win("2026-09-01T00:00:00.000", "2026-09-02T00:00:00.000"), "UNKNOWN", "BEFORE_RECORDED_DECISIONS");
  assert.ok(confirmationTimeline(student, [], CTX).every((s) => s.reason !== "APPROVED_AT_CONFLICT"));

  // ... and stays consistent once later decisions are recorded.
  const later = chain([["REJECTED", "2026-11-01T00:00:00.000"]], { startStatus: "APPROVED", startAt: at("2026-10-01T00:00:00.000") });
  later.student.approvedAt = at("2026-10-01T00:00:00.000");
  expectBoth(later.student, later.history, win("2026-10-05T00:00:00.000", "2026-10-06T00:00:00.000"), "APPROVED", "KNOWN_APPROVED");
  expectBoth(later.student, later.history, LECTURE, "NOT_APPROVED", "KNOWN_NOT_APPROVED");
});

test("M1: approvedAt in a known REJECTED period (the old bulk race) → that period is UNKNOWN, approvedAt is not evidence", () => {
  // Declined at 03:59:59.800 (no history rows); the old bulk approval still set approvedAt = 04:00.
  const victim = {
    confirmationStatus: "REJECTED",
    confirmedAt: at("2026-10-15T03:59:59.800"),
    approvedAt: at("2026-10-15T04:00:00.000"),
  };
  expectBoth(victim, [], win("2026-10-15T04:00:00.000", "2026-10-15T06:00:00.000"), "UNKNOWN", "APPROVED_AT_CONFLICT");
  expectBoth(victim, [], LECTURE, "UNKNOWN", "APPROVED_AT_CONFLICT", "a currently rejected student's later lectures: manual review");
  expectBoth(victim, [], win("2026-10-14T00:00:00.000", "2026-10-15T00:00:00.000"), "UNKNOWN", "BEFORE_RECORDED_DECISIONS");
  assert.equal(isAutomaticallyEligible(during(victim, [], LECTURE)), false);
  assert.deepEqual(
    confirmationTimeline(victim, [], CTX).map((s) => [s.status, s.reason]),
    [
      ["UNKNOWN", "BEFORE_RECORDED_DECISIONS"],
      ["UNKNOWN", "APPROVED_AT_CONFLICT"],
    ]
  );
});

test("M1: approvedAt in a known PENDING period → UNKNOWN (APPROVED_AT_CONFLICT)", () => {
  // Never decided, still pending, yet an approvedAt after the feature start.
  const student = { confirmationStatus: "PENDING", confirmedAt: null, approvedAt: at("2026-09-01T00:00:00.000") };
  expectBoth(student, [], LECTURE, "UNKNOWN", "APPROVED_AT_CONFLICT");
  expectBoth(student, [], win("2026-09-01T00:00:00.000", "2026-09-01T01:00:00.000"), "UNKNOWN", "APPROVED_AT_CONFLICT", "not evidence even at that instant");
  expectBoth(student, [], JUNE, "UNKNOWN", "BEFORE_APPROVAL_FEATURE");

  // Recorded: pending until a decline; approvedAt inside the PENDING period.
  const { student: s2, history } = chain([["REJECTED", "2026-11-05T00:00:00.000"]], { approvedAt: at("2026-10-01T00:00:00.000") });
  expectBoth(s2, history, win("2026-10-01T00:00:00.000", "2026-10-02T00:00:00.000"), "UNKNOWN", "APPROVED_AT_CONFLICT");
  expectBoth(s2, history, LECTURE, "NOT_APPROVED", "KNOWN_NOT_APPROVED", "the later REJECTED period is not affected");
});

test("M1: approvedAt exactly on a period boundary belongs to the period that starts there", () => {
  // approvedAt == the decline instant: it lies in the REJECTED period → conflict.
  const atDecline = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-05T00:00:00.000"],
  ]);
  atDecline.student.approvedAt = at("2026-11-05T00:00:00.000");
  expectBoth(atDecline.student, atDecline.history, LECTURE, "UNKNOWN", "APPROVED_AT_CONFLICT");
  expectBoth(atDecline.student, atDecline.history, win("2026-11-02T00:00:00.000", "2026-11-03T00:00:00.000"), "APPROVED", "KNOWN_APPROVED");

  // approvedAt == the approval instant: consistent.
  const atApproval = chain([["APPROVED", "2026-11-01T00:00:00.000"]]);
  assert.deepEqual(atApproval.student.approvedAt, at("2026-11-01T00:00:00.000"));
  expectBoth(atApproval.student, atApproval.history, win("2026-11-01T00:00:00.000", "2026-11-01T01:00:00.000"), "APPROVED", "KNOWN_APPROVED");
  expectBoth(atApproval.student, atApproval.history, win("2026-10-31T23:00:00.000", "2026-11-01T00:00:00.000"), "NOT_APPROVED", "KNOWN_NOT_APPROVED");
});

test("M1: a conflicting period next to a clean APPROVED period: windows touching the clean one are APPROVED", () => {
  const { student, history } = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-05T00:00:00.000"],
    ["APPROVED", "2026-11-20T00:00:00.000"],
  ]);
  student.approvedAt = at("2026-11-08T00:00:00.000"); // inside the REJECTED period
  expectBoth(student, history, win("2026-11-04T00:00:00.000", "2026-11-06T00:00:00.000"), "APPROVED", "KNOWN_APPROVED");
  expectBoth(student, history, LECTURE, "UNKNOWN", "APPROVED_AT_CONFLICT");
  expectBoth(student, history, win("2026-11-19T00:00:00.000", "2026-11-21T00:00:00.000"), "APPROVED", "KNOWN_APPROVED");
  expectBoth(student, history, win("2026-11-25T00:00:00.000", "2026-11-26T00:00:00.000"), "APPROVED", "KNOWN_APPROVED");
  expectBoth(student, history, win("2026-10-20T00:00:00.000", "2026-10-21T00:00:00.000"), "NOT_APPROVED", "KNOWN_NOT_APPROVED", "the earlier PENDING period is not affected");
});

test("M1: an invalid approvedAt makes the history unusable (BROKEN_HISTORY)", () => {
  const { student, history } = chain([["APPROVED", "2026-11-01T00:00:00.000"]]);
  student.approvedAt = new Date(Number.NaN);
  expectBoth(student, history, LECTURE, "UNKNOWN", "BROKEN_HISTORY");
});

// ---- Broken or impossible histories → UNKNOWN (BROKEN_HISTORY) -----------------------

test("broken chains are UNKNOWN (BROKEN_HISTORY)", () => {
  const good = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-05T00:00:00.000"],
  ]);
  assert.notEqual(confirmationTimeline(good.student, good.history, CTX), null);

  const broken = (mutate) => {
    const copy = structuredClone(good);
    mutate(copy);
    return copy;
  };

  const cases = {
    wrongFrom: broken((c) => (c.history[1].fromStatus = "PENDING")),
    wrongPrevious: broken((c) => (c.history[1].previousConfirmedAt = at("2026-11-01T00:00:00.001"))),
    statusMismatch: broken((c) => (c.student.confirmationStatus = "APPROVED")),
    confirmedAtMismatch: broken((c) => (c.student.confirmedAt = at("2026-11-06T00:00:00.000"))),
  };
  for (const [name, c] of Object.entries(cases)) {
    expectBoth(c.student, c.history, LECTURE, "UNKNOWN", "BROKEN_HISTORY");
    assert.equal(confirmationTimeline(c.student, c.history, CTX), null, name);
  }

  const missingMiddle = chain([
    ["APPROVED", "2026-11-01T00:00:00.000"],
    ["REJECTED", "2026-11-05T00:00:00.000"],
    ["APPROVED", "2026-11-12T00:00:00.000"],
  ]);
  missingMiddle.history.splice(1, 1);
  expectBoth(missingMiddle.student, missingMiddle.history, LECTURE, "UNKNOWN", "BROKEN_HISTORY");

  const noChange = chain([["APPROVED", "2026-11-01T00:00:00.000"]]);
  noChange.history[0].fromStatus = "APPROVED";
  expectBoth(noChange.student, noChange.history, LECTURE, "UNKNOWN", "BROKEN_HISTORY");

  const unordered = chain([["APPROVED", "2026-11-01T00:00:00.000"]], {
    startStatus: "REJECTED",
    startAt: at("2026-11-01T00:00:00.000"),
  });
  expectBoth(unordered.student, unordered.history, LECTURE, "UNKNOWN", "BROKEN_HISTORY");
});

test("impossible starting points are UNKNOWN: PENDING with a previous decision time, REJECTED without one", () => {
  expectBoth({ confirmationStatus: "PENDING", confirmedAt: at("2026-10-01T00:00:00.000"), approvedAt: null }, [], LECTURE, "UNKNOWN", "BROKEN_HISTORY");
  expectBoth({ confirmationStatus: "REJECTED", confirmedAt: null, approvedAt: null }, [], LECTURE, "UNKNOWN", "BROKEN_HISTORY");

  const pendingWithTime = chain([["APPROVED", "2026-11-01T00:00:00.000"]], { startStatus: "PENDING", startAt: at("2026-10-01T00:00:00.000") });
  expectBoth(pendingWithTime.student, pendingWithTime.history, LECTURE, "UNKNOWN", "BROKEN_HISTORY");

  const rejectedWithoutTime = chain([["APPROVED", "2026-11-01T00:00:00.000"]], { startStatus: "REJECTED" });
  expectBoth(rejectedWithoutTime.student, rejectedWithoutTime.history, LECTURE, "UNKNOWN", "BROKEN_HISTORY");
});

test("an invalid window is a programming error", () => {
  const { student, history } = chain([]);
  assert.throws(() => during(student, history, win("2026-11-10T06:00:00.000", "2026-11-10T06:00:00.000")), RangeError);
  assert.throws(() => during(student, history, win("2026-11-10T06:00:00.000", "2026-11-10T04:00:00.000")), RangeError);
  assert.throws(() => during(student, history, { start: new Date(Number.NaN), end: at("2026-11-10T06:00:00.000") }), RangeError);
});

// ---- Every registration source; registeredAt / createdAt never used ------------------

test("all registration sources follow the same history rules; registeredAt / createdAt are ignored", () => {
  for (const registrationSource of ["TEACHER", "PUBLIC_CLASS", "IMPORT", "ADMIN"]) {
    const { student, history } = chain([["REJECTED", "2026-11-01T00:00:00.000"]], { startStatus: "APPROVED" });
    const withNoise = {
      ...student,
      registrationSource,
      // Misleading values: must make no difference.
      registeredAt: at("2020-01-01T00:00:00.000"),
      createdAt: at("2020-01-01T00:00:00.000"),
    };
    assert.equal(during(withNoise, history, win("2026-10-01T00:00:00.000", "2026-10-02T00:00:00.000")), "APPROVED", registrationSource);
    assert.equal(during(withNoise, history, LECTURE), "NOT_APPROVED", registrationSource);
    assert.equal(during(withNoise, history, JUNE), "UNKNOWN", registrationSource);
  }

  const source = fs.readFileSync(path.join(root, "lib", "student-confirmation-history.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /registeredAt|createdAt|registrationSource/);
  assert.doesNotMatch(code, /process\.env|Date\.now\(\)|new Date\(\)/, "pure: no environment, no clock");
});

// ---- UNKNOWN never decides anything automatically --------------------------------------

test("only APPROVED is automatically eligible; UNKNOWN goes to manual review, never to automatic absence or QR attendance", () => {
  assert.equal(isAutomaticallyEligible("APPROVED"), true);
  assert.equal(isAutomaticallyEligible("NOT_APPROVED"), false);
  assert.equal(isAutomaticallyEligible("UNKNOWN"), false);
  assert.equal(needsManualApprovalReview("UNKNOWN"), true);
  assert.equal(needsManualApprovalReview("APPROVED"), false);
  assert.equal(needsManualApprovalReview("NOT_APPROVED"), false);

  const { student, history } = chain([]);
  for (const result of [during(student, history, JUNE), explain(student, history, JUNE).result]) {
    assert.equal(result, "UNKNOWN");
    assert.equal(isAutomaticallyEligible(result), false);
    assert.equal(needsManualApprovalReview(result), true);
  }
});

// Who may call the approval-history functions. Services, routes and UI must
// go through lib/attendance, never call them directly.
const HISTORY_FUNCTIONS = [
  "approvalDuring",
  "explainApprovalDuring",
  "approvalAt",
  "explainApprovalAt",
  "confirmationTimeline",
  "approvalHistoryContextFromSetting",
];
const HISTORY_CONSUMERS = {
  // The library itself (any of its functions).
  [path.join("lib", "student-confirmation-history.ts")]: HISTORY_FUNCTIONS,
  // Stage 5.3: eligibility evaluates approval at an instant.
  [path.join("lib", "attendance", "eligibility.ts")]: HISTORY_FUNCTIONS,
  // Stage 5.4a: configuration only PARSES the settings with the existing parser.
  [path.join("lib", "attendance", "config.ts")]: ["approvalHistoryContextFromSetting"],
};

/** Calls of history functions in `text` that `file` may not make. */
function forbiddenHistoryCalls(file, text) {
  const allowedFile = Object.keys(HISTORY_CONSUMERS).find((key) => file.endsWith(key));
  const allowed = new Set(allowedFile ? HISTORY_CONSUMERS[allowedFile] : []);
  const pattern = new RegExp(`\\b(${HISTORY_FUNCTIONS.join("|")})\\(`, "g");
  return [...text.matchAll(pattern)].map((m) => m[1]).filter((name) => !allowed.has(name));
}

test("approval-history guard: config.ts may only call the setting parser", () => {
  const config = path.join(root, "lib", "attendance", "config.ts");
  assert.deepEqual(forbiddenHistoryCalls(config, "approvalHistoryContextFromSetting(raw)"), []);
  for (const call of ["approvalAt(", "explainApprovalAt(", "approvalDuring(", "explainApprovalDuring(", "confirmationTimeline("]) {
    assert.deepEqual(forbiddenHistoryCalls(config, `x = ${call}student, history, instant, context)`), [call.slice(0, -1)], call);
  }
  // Any other file: every call is forbidden; the allowed library files may call all of them.
  assert.deepEqual(forbiddenHistoryCalls(path.join(root, "services", "x.ts"), "approvalHistoryContextFromSetting(raw)"), ["approvalHistoryContextFromSetting"]);
  assert.deepEqual(forbiddenHistoryCalls(path.join(root, "lib", "attendance", "eligibility.ts"), "explainApprovalAt(a)"), []);
});

test("only lib/attendance consumes approval history (eligibility.ts; config.ts only parses the setting); the old publicApprovalDuring name exists nowhere", () => {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (/publicApprovalDuring/.test(text)) hits.push(`publicApprovalDuring: ${full}`);
        for (const name of forbiddenHistoryCalls(full, text)) hits.push(`consumer (${name}): ${full}`);
      }
    }
  };
  for (const dir of ["app", "services", "lib", "components", "scripts"]) {
    if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  }
  assert.deepEqual(hits, []);
});
