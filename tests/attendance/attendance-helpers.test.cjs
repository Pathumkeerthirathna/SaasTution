/*
 * Pure attendance helpers (lib/attendance/*): enrolment, eligibility,
 * lateness, the evidence / review rule and finalization.
 *
 *   npm run test:attendance-helpers
 *
 * Deterministic instants; no database, no clock, no environment. The approval
 * feature start used here is a test value, not a real environment's.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const attendance = require(path.join(root, "lib", "attendance", "index.ts"));
const {
  enrolledAt,
  explainEnrolmentAt,
  attendanceEligibilityAt,
  assertApprovalContext,
  isAutomaticAttendanceAllowed,
  scanResultForEligibility,
  presentUntil,
  evidenceStatusAt,
  autoStatusFor,
  isValidGraceMinutes,
  DEFAULT_ATTENDANCE_GRACE_MINUTES,
  evidenceRequiresReview,
  planEvidence,
  teacherDecisionRequiresReason,
  scheduledEndPassed,
  requiresExplicitCompletion,
  finalizationReadiness,
  planFinalizationAbsences,
} = attendance;
const { approvalHistoryContextFromSetting } = require(path.join(root, "lib", "student-confirmation-history.ts"));

// ---- Fixtures ---------------------------------------------------------------

const at = (iso) => new Date(`${iso}Z`);
const ms = (date, delta) => new Date(date.getTime() + delta);
const SL_OFFSET_MS = (5 * 60 + 30) * 60_000;
/** Sri Lankan wall-clock digits of a real instant (how ClassStudent stores times). */
const digits = (instant) => new Date(instant.getTime() + SL_OFFSET_MS);

const FEATURE = at("2026-07-28T00:00:00.000");
const CONTEXT = { approvalFeatureStartedAt: FEATURE };
const CLASS = "class-1";
const OTHER_CLASS = "class-2";

const APPROVED_AT = at("2026-08-01T00:00:00.000");
const DECLINED_AT = at("2026-08-20T00:00:00.000");
const LECTURE_START = at("2026-09-01T12:30:00.000"); // 18:00 in Sri Lanka
const LECTURE_END = at("2026-09-01T14:30:00.000");

const approvedStudent = () => ({
  student: { confirmationStatus: "APPROVED", confirmedAt: APPROVED_AT, approvedAt: APPROVED_AT, status: 0 },
  history: [{ id: "h1", fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: APPROVED_AT, previousConfirmedAt: null }],
});

const pendingStudent = () => ({
  student: { confirmationStatus: "PENDING", confirmedAt: null, approvedAt: null, status: 0 },
  history: [],
});

const declinedStudent = () => ({
  student: { confirmationStatus: "REJECTED", confirmedAt: DECLINED_AT, approvedAt: APPROVED_AT, status: 0 },
  history: [
    { id: "h1", fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: APPROVED_AT, previousConfirmedAt: null },
    { id: "h2", fromStatus: "APPROVED", toStatus: "REJECTED", decidedAt: DECLINED_AT, previousConfirmedAt: APPROVED_AT },
  ],
});

const enrolment = (id, assigned, removed = null, extra = {}) => ({
  id,
  classId: CLASS,
  assignedAt: digits(assigned),
  removedAt: removed === null ? null : digits(removed),
  isActive: removed === null,
  ...extra,
});

const ENROLLED = [enrolment("e1", at("2026-07-01T00:00:00.000"))];

const eligibility = (who, instant, enrolments = ENROLLED, context = CONTEXT) =>
  attendanceEligibilityAt({ ...who, enrolments, classId: CLASS, instant, context });

const REGISTER = { scheduledStartAt: LECTURE_START, graceMinutes: 10, finalizedAt: null };
const BOUNDARY = ms(LECTURE_START, 10 * 60_000);
const FINALIZED = { ...REGISTER, finalizedAt: at("2026-09-01T15:00:00.000") };
const NOW = at("2026-09-01T16:00:00.000");

const record = (fields = {}) => ({
  status: "PRESENT",
  statusSource: "AUTO",
  firstOnlineAt: null,
  firstQrAt: null,
  autoStatus: null,
  teacherStatus: null,
  pendingReviewSince: null,
  ...fields,
});

const evidence = (channel, serverRecordedAt, overrides = {}) =>
  planEvidence({
    register: REGISTER,
    record: null,
    evidence: { channel, serverRecordedAt },
    eligibility: "ELIGIBLE",
    now: NOW,
    ...overrides,
  });

// ---- A. Enrolment -----------------------------------------------------------

test("enrolment: assignedAt is inclusive, removedAt exclusive (converted from Sri Lankan digits)", () => {
  const assigned = at("2026-08-15T00:00:00.000");
  const removed = at("2026-08-25T00:00:00.000");
  const rows = [enrolment("e1", assigned, removed)];

  assert.equal(enrolledAt(rows, CLASS, ms(assigned, -1)), false);
  assert.equal(enrolledAt(rows, CLASS, assigned), true);
  assert.equal(enrolledAt(rows, CLASS, ms(removed, -1)), true);
  assert.equal(enrolledAt(rows, CLASS, removed), false);
});

test("enrolment: the stored digits are Sri Lankan wall-clock time, not real instants", () => {
  // Stored 2026-08-15T05:30 digits = real 2026-08-15T00:00Z.
  const rows = [{ id: "e1", classId: CLASS, assignedAt: at("2026-08-15T05:30:00.000"), removedAt: null, isActive: true }];
  assert.equal(enrolledAt(rows, CLASS, at("2026-08-15T00:00:00.000")), true);
  assert.equal(enrolledAt(rows, CLASS, at("2026-08-14T23:59:59.999")), false);
});

test("enrolment: not removed means open-ended", () => {
  assert.equal(enrolledAt([enrolment("e1", at("2026-08-15T00:00:00.000"))], CLASS, at("2030-01-01T00:00:00.000")), true);
});

test("enrolment: removed and re-enrolled through a separate row", () => {
  const rows = [
    enrolment("e1", at("2026-08-01T00:00:00.000"), at("2026-08-10T00:00:00.000")),
    enrolment("e2", at("2026-08-20T00:00:00.000")),
  ];

  assert.deepEqual(explainEnrolmentAt(rows, CLASS, at("2026-08-05T00:00:00.000")), { enrolled: true, enrolmentId: "e1" });
  assert.equal(enrolledAt(rows, CLASS, at("2026-08-10T00:00:00.000")), false); // the gap starts at removal
  assert.equal(enrolledAt(rows, CLASS, at("2026-08-19T23:59:59.999")), false);
  assert.deepEqual(explainEnrolmentAt(rows, CLASS, at("2026-08-20T00:00:00.000")), { enrolled: true, enrolmentId: "e2" });
});

test("enrolment: removed and re-added at the same instant has no gap", () => {
  const switchAt = at("2026-08-10T00:00:00.000");
  const rows = [enrolment("e1", at("2026-08-01T00:00:00.000"), switchAt), enrolment("e2", switchAt)];
  assert.deepEqual(explainEnrolmentAt(rows, CLASS, ms(switchAt, -1)), { enrolled: true, enrolmentId: "e1" });
  assert.deepEqual(explainEnrolmentAt(rows, CLASS, switchAt), { enrolled: true, enrolmentId: "e2" });
});

test("enrolment: rows of other classes never count", () => {
  const rows = [{ ...enrolment("e1", at("2026-08-01T00:00:00.000")), classId: OTHER_CLASS }];
  assert.equal(enrolledAt(rows, CLASS, at("2026-09-01T00:00:00.000")), false);
  assert.equal(enrolledAt(rows, OTHER_CLASS, at("2026-09-01T00:00:00.000")), true);
});

test("enrolment: rows that cannot be placed in time never count (fail closed) and are reported", () => {
  const instant = at("2026-09-01T00:00:00.000");
  const rows = [
    { id: "a", classId: CLASS, assignedAt: new Date(NaN), removedAt: null, isActive: true },
    { id: "b", classId: CLASS, assignedAt: digits(at("2026-08-10T00:00:00.000")), removedAt: digits(at("2026-08-01T00:00:00.000")), isActive: false },
    { id: "c", classId: CLASS, assignedAt: digits(at("2026-08-01T00:00:00.000")), removedAt: null, isActive: false },
  ];

  assert.deepEqual(explainEnrolmentAt(rows, CLASS, instant), {
    enrolled: false,
    enrolmentId: null,
    unusable: [
      { enrolmentId: "a", reason: "INVALID_TIMESTAMP" },
      { enrolmentId: "b", reason: "REMOVED_BEFORE_ASSIGNED" },
      { enrolmentId: "c", reason: "INACTIVE_WITHOUT_REMOVAL_TIME" },
    ],
  });
});

test("enrolment: removed in the same instant it was assigned covers nothing", () => {
  const t = at("2026-08-10T00:00:00.000");
  assert.equal(enrolledAt([enrolment("e1", t, t)], CLASS, t), false);
});

test("enrolment: an invalid instant throws", () => {
  assert.throws(() => enrolledAt(ENROLLED, CLASS, new Date(NaN)), RangeError);
});

// ---- B / D. Approval and eligibility ----------------------------------------

test("eligibility: approved and enrolled at the instant is ELIGIBLE", () => {
  const result = eligibility(approvedStudent(), LECTURE_START);
  assert.equal(result.outcome, "ELIGIBLE");
  assert.equal(result.reason, "ELIGIBLE");
  assert.deepEqual(result.approval, { result: "APPROVED", reason: "KNOWN_APPROVED" });
  assert.equal(isAutomaticAttendanceAllowed(result), true);
});

test("eligibility: approval boundary is exact (approved from the decision instant)", () => {
  assert.equal(eligibility(approvedStudent(), ms(APPROVED_AT, -1)).outcome, "NOT_ELIGIBLE");
  assert.equal(eligibility(approvedStudent(), ms(APPROVED_AT, -1)).reason, "NOT_APPROVED");
  assert.equal(eligibility(approvedStudent(), APPROVED_AT).outcome, "ELIGIBLE");
});

test("eligibility: NOT_APPROVED (pending, or declined before the instant) is NOT_ELIGIBLE", () => {
  const pending = eligibility(pendingStudent(), LECTURE_START);
  assert.equal(pending.outcome, "NOT_ELIGIBLE");
  assert.equal(pending.reason, "NOT_APPROVED");
  assert.equal(pending.approval.reason, "KNOWN_NOT_APPROVED");

  assert.equal(eligibility(declinedStudent(), ms(DECLINED_AT, -1)).outcome, "ELIGIBLE");
  assert.equal(eligibility(declinedStudent(), DECLINED_AT).reason, "NOT_APPROVED");
});

test("eligibility: UNKNOWN approval is UNKNOWN (manual review), never eligible", () => {
  const before = at("2026-07-15T12:30:00.000"); // before the approval feature started
  const result = eligibility(approvedStudent(), before);
  assert.equal(result.outcome, "UNKNOWN");
  assert.equal(result.reason, "APPROVAL_UNKNOWN");
  assert.equal(result.approval.reason, "BEFORE_APPROVAL_FEATURE");
  assert.equal(isAutomaticAttendanceAllowed(result), false);
});

test("eligibility: a broken history is UNKNOWN", () => {
  const who = approvedStudent();
  who.student = { ...who.student, confirmedAt: at("2026-08-02T00:00:00.000") }; // does not match the history
  const result = eligibility(who, LECTURE_START);
  assert.equal(result.outcome, "UNKNOWN");
  assert.equal(result.approval.reason, "BROKEN_HISTORY");
});

test("eligibility: not enrolled is NOT_ELIGIBLE even when approval is unknown or approved", () => {
  const before = at("2026-07-15T12:30:00.000");
  const late = [enrolment("e1", at("2026-08-15T00:00:00.000"))];
  assert.equal(eligibility(approvedStudent(), before, late).reason, "NOT_ENROLLED");
  assert.equal(eligibility(approvedStudent(), before, late).outcome, "NOT_ELIGIBLE");
  assert.equal(eligibility(approvedStudent(), at("2026-08-14T00:00:00.000"), late).reason, "NOT_ENROLLED");
});

test("eligibility: a soft-deleted student is NOT_ELIGIBLE", () => {
  const who = approvedStudent();
  who.student = { ...who.student, status: 1 };
  const result = eligibility(who, LECTURE_START);
  assert.equal(result.outcome, "NOT_ELIGIBLE");
  assert.equal(result.reason, "STUDENT_INACTIVE");
});

test("eligibility: a missing or invalid approval context throws, with no fallback", () => {
  for (const context of [undefined, null, {}, { approvalFeatureStartedAt: null }, { approvalFeatureStartedAt: new Date(NaN) }, { approvalFeatureStartedAt: "2026-07-28T00:00:00Z" }]) {
    assert.throws(
      () => attendanceEligibilityAt({ ...approvedStudent(), enrolments: ENROLLED, classId: CLASS, instant: LECTURE_START, context }),
      TypeError
    );
    assert.throws(() => assertApprovalContext(context), TypeError);
  }
  // Also for inactive students: a misconfiguration never looks like "not eligible".
  const deleted = approvedStudent();
  deleted.student = { ...deleted.student, status: 1 };
  assert.throws(
    () => attendanceEligibilityAt({ ...deleted, enrolments: ENROLLED, classId: CLASS, instant: LECTURE_START, context: undefined }),
    TypeError
  );
});

test("eligibility: the context comes from the existing setting parser (no default value)", () => {
  assert.throws(() => approvalHistoryContextFromSetting(undefined));
  assert.throws(() => approvalHistoryContextFromSetting("2026-07-28T05:30:00")); // no offset
  const context = approvalHistoryContextFromSetting("2026-07-28T05:30:00+05:30");
  assert.equal(context.approvalFeatureStartedAt.getTime(), FEATURE.getTime());
  assert.equal(eligibility(approvedStudent(), LECTURE_START, ENROLLED, context).outcome, "ELIGIBLE");
});

test("eligibility: an invalid instant throws", () => {
  assert.throws(() => eligibility(approvedStudent(), new Date(NaN)), RangeError);
});

test("scan mapping matches the scan-event CHECK constraints", () => {
  const APPROVED_REASONS = ["KNOWN_APPROVED", "APPROVED_AT_EVIDENCE"];
  const UNKNOWN_REASONS = ["BEFORE_APPROVAL_FEATURE", "BEFORE_RECORDED_DECISIONS", "APPROVED_AT_CONFLICT", "BROKEN_HISTORY"];

  const valid = scanResultForEligibility(eligibility(approvedStudent(), LECTURE_START));
  assert.equal(valid.result, "VALID");
  assert.ok(APPROVED_REASONS.includes(valid.eligibilityReason));

  const unknown = scanResultForEligibility(eligibility(approvedStudent(), at("2026-07-15T12:30:00.000")));
  assert.equal(unknown.result, "ELIGIBILITY_UNKNOWN");
  assert.ok(UNKNOWN_REASONS.includes(unknown.eligibilityReason));

  // Approved but not enrolled: NOT_ELIGIBLE with an approved reason (allowed).
  const notEnrolled = scanResultForEligibility(eligibility(approvedStudent(), LECTURE_START, []));
  assert.deepEqual(notEnrolled, { result: "NOT_ELIGIBLE", eligibilityReason: "KNOWN_APPROVED" });

  const deleted = approvedStudent();
  deleted.student = { ...deleted.student, status: 1 };
  assert.deepEqual(scanResultForEligibility(eligibility(deleted, LECTURE_START)), {
    result: "NOT_ELIGIBLE",
    eligibilityReason: null,
  });
});

// ---- C. Lateness ------------------------------------------------------------

test("lateness: PRESENT up to and including start + grace, LATE one millisecond after", () => {
  assert.equal(presentUntil(REGISTER).getTime(), BOUNDARY.getTime());
  assert.equal(evidenceStatusAt(ms(LECTURE_START, -60 * 60_000), REGISTER), "PRESENT"); // early
  assert.equal(evidenceStatusAt(LECTURE_START, REGISTER), "PRESENT");
  assert.equal(evidenceStatusAt(BOUNDARY, REGISTER), "PRESENT");
  assert.equal(evidenceStatusAt(ms(BOUNDARY, 1), REGISTER), "LATE");
});

test("lateness: grace 0 makes the start itself the boundary", () => {
  const schedule = { scheduledStartAt: LECTURE_START, graceMinutes: 0 };
  assert.equal(evidenceStatusAt(LECTURE_START, schedule), "PRESENT");
  assert.equal(evidenceStatusAt(ms(LECTURE_START, 1), schedule), "LATE");
});

test("lateness: grace 240 (maximum) boundary", () => {
  const schedule = { scheduledStartAt: LECTURE_START, graceMinutes: 240 };
  const boundary = ms(LECTURE_START, 240 * 60_000);
  assert.equal(evidenceStatusAt(boundary, schedule), "PRESENT");
  assert.equal(evidenceStatusAt(ms(boundary, 1), schedule), "LATE");
});

test("lateness: grace must be a whole number 0–240; times must be valid", () => {
  assert.equal(DEFAULT_ATTENDANCE_GRACE_MINUTES, 10);
  for (const grace of [0, 10, 240]) assert.equal(isValidGraceMinutes(grace), true);
  for (const grace of [-1, 241, 1.5, NaN, "10", null]) {
    assert.equal(isValidGraceMinutes(grace), false);
    assert.throws(() => evidenceStatusAt(LECTURE_START, { scheduledStartAt: LECTURE_START, graceMinutes: grace }), RangeError);
  }
  assert.throws(() => evidenceStatusAt(new Date(NaN), REGISTER), RangeError);
  assert.throws(() => evidenceStatusAt(LECTURE_START, { scheduledStartAt: new Date(NaN), graceMinutes: 10 }), RangeError);
});

test("autoStatus is the status of the earliest evidence of either channel", () => {
  const late = ms(BOUNDARY, 60_000);
  assert.equal(autoStatusFor({ firstOnlineAt: null, firstQrAt: null }, REGISTER), null);
  assert.equal(autoStatusFor({ firstOnlineAt: late, firstQrAt: null }, REGISTER), "LATE");
  assert.equal(autoStatusFor({ firstOnlineAt: late, firstQrAt: BOUNDARY }, REGISTER), "PRESENT");
  assert.equal(autoStatusFor({ firstOnlineAt: LECTURE_START, firstQrAt: late }, REGISTER), "PRESENT");
});

// ---- E. Evidence and review -------------------------------------------------

test("review matrix: only evidence stronger than the current status", () => {
  const expected = {
    ABSENT: { PRESENT: true, LATE: true },
    EXCUSED: { PRESENT: true, LATE: true },
    LATE: { PRESENT: true, LATE: false },
    PRESENT: { PRESENT: false, LATE: false },
  };
  for (const [current, row] of Object.entries(expected)) {
    for (const [evidenceStatus, review] of Object.entries(row)) {
      assert.equal(evidenceRequiresReview(current, evidenceStatus), review, `${current} vs ${evidenceStatus}`);
    }
  }
});

test("evidence: first eligible evidence on an open register creates an AUTO record", () => {
  const plan = evidence("QR", BOUNDARY);
  assert.equal(plan.effect, "STATUS_UPDATED");
  assert.equal(plan.write, "CREATE");
  assert.equal(plan.auditAction, "CREATED_AUTO");
  assert.equal(plan.afterFinalization, false);
  assert.deepEqual(plan.fields, {
    status: "PRESENT",
    statusSource: "AUTO",
    firstOnlineAt: null,
    firstQrAt: BOUNDARY,
    autoStatus: "PRESENT",
    pendingReviewSince: null,
  });

  const late = evidence("ONLINE", ms(BOUNDARY, 1));
  assert.equal(late.fields.status, "LATE");
  assert.equal(late.fields.firstOnlineAt.getTime(), ms(BOUNDARY, 1).getTime());
});

test("evidence: NOT_ELIGIBLE and UNKNOWN never create or change attendance", () => {
  for (const outcome of ["NOT_ELIGIBLE", "UNKNOWN"]) {
    for (const rec of [null, record({ firstOnlineAt: ms(BOUNDARY, 1), autoStatus: "LATE", status: "LATE" })]) {
      for (const register of [REGISTER, FINALIZED]) {
        const plan = evidence("QR", LECTURE_START, { eligibility: outcome, record: rec, register });
        assert.deepEqual(
          { effect: plan.effect, write: plan.write, fields: plan.fields, auditAction: plan.auditAction },
          { effect: "NONE", write: "NONE", fields: null, auditAction: null }
        );
      }
    }
  }
});

test("evidence: duplicates (same or later time on the same channel) change nothing", () => {
  const rec = record({ firstQrAt: LECTURE_START, autoStatus: "PRESENT" });
  for (const time of [LECTURE_START, ms(LECTURE_START, 1), ms(BOUNDARY, 60_000)]) {
    const plan = evidence("QR", time, { record: rec });
    assert.equal(plan.effect, "DUPLICATE");
    assert.equal(plan.write, "NONE");
  }
  // Also after finalization and with a teacher decision: no review raised again.
  const decided = record({ status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", firstQrAt: LECTURE_START, autoStatus: "PRESENT", pendingReviewSince: null });
  assert.equal(evidence("QR", ms(LECTURE_START, 5), { record: decided, register: FINALIZED }).effect, "DUPLICATE");
});

test("evidence: another channel on an AUTO record records evidence without changing a PRESENT status", () => {
  const rec = record({ firstOnlineAt: LECTURE_START, autoStatus: "PRESENT" });
  const plan = evidence("QR", ms(BOUNDARY, 60_000), { record: rec });
  assert.equal(plan.effect, "EVIDENCE_ONLY");
  assert.equal(plan.auditAction, "EVIDENCE_RECORDED");
  assert.equal(plan.fields.status, "PRESENT");
  assert.equal(plan.fields.autoStatus, "PRESENT");
  assert.equal(plan.fields.firstOnlineAt.getTime(), LECTURE_START.getTime());
  assert.equal(plan.evidenceStatus, "LATE");
});

test("evidence: earlier evidence upgrades an open AUTO record from LATE to PRESENT", () => {
  const rec = record({ status: "LATE", firstOnlineAt: ms(BOUNDARY, 60_000), autoStatus: "LATE" });
  const plan = evidence("ONLINE", LECTURE_START, { record: rec });
  assert.equal(plan.effect, "STATUS_UPDATED");
  assert.equal(plan.auditAction, "AUTO_UPDATED");
  assert.equal(plan.fields.status, "PRESENT");
  assert.equal(plan.fields.statusSource, "AUTO");
  assert.equal(plan.fields.pendingReviewSince, null);
});

test("teacher decisions stay authoritative: stronger evidence raises a review, the status never changes", () => {
  for (const decided of ["ABSENT", "EXCUSED", "LATE"]) {
    const rec = record({ status: decided, statusSource: "TEACHER", teacherStatus: decided });
    const plan = evidence("QR", LECTURE_START, { record: rec });
    assert.equal(plan.effect, "REVIEW_REQUIRED", decided);
    assert.equal(plan.auditAction, "EVIDENCE_RECORDED");
    assert.equal(plan.fields.status, decided);
    assert.equal(plan.fields.statusSource, "TEACHER");
    assert.equal(plan.fields.autoStatus, "PRESENT");
    assert.equal(plan.fields.pendingReviewSince.getTime(), NOW.getTime());
    assert.equal("teacherStatus" in plan.fields, false); // never written by evidence
  }
});

test("teacher decisions: weaker or equal evidence creates no review", () => {
  const cases = [
    ["PRESENT", LECTURE_START],
    ["PRESENT", ms(BOUNDARY, 1)],
    ["LATE", ms(BOUNDARY, 1)],
  ];
  for (const [decided, time] of cases) {
    const rec = record({ status: decided, statusSource: "TEACHER", teacherStatus: decided });
    const plan = evidence("ONLINE", time, { record: rec });
    assert.equal(plan.effect, "EVIDENCE_ONLY", `${decided} @ ${time.toISOString()}`);
    assert.equal(plan.fields.status, decided);
    assert.equal(plan.fields.pendingReviewSince, null);
  }
});

test("teacher decisions: the review rule uses this evidence, not an older stronger one", () => {
  // Teacher LATE; online PRESENT evidence already reviewed and dismissed; a new QR channel arrives LATE.
  const rec = record({ status: "LATE", statusSource: "TEACHER", teacherStatus: "LATE", firstOnlineAt: LECTURE_START, autoStatus: "PRESENT" });
  const plan = evidence("QR", ms(BOUNDARY, 1), { record: rec });
  assert.equal(plan.effect, "EVIDENCE_ONLY");
  assert.equal(plan.fields.pendingReviewSince, null);
});

test("an open review keeps its original time", () => {
  const since = at("2026-09-01T12:40:00.000");
  const rec = record({ status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", firstOnlineAt: BOUNDARY, autoStatus: "PRESENT", pendingReviewSince: since });
  const plan = evidence("QR", LECTURE_START, { record: rec });
  assert.equal(plan.effect, "REVIEW_REQUIRED");
  assert.equal(plan.fields.pendingReviewSince.getTime(), since.getTime());
});

test("after finalization: no record is ever created by evidence", () => {
  const plan = evidence("QR", LECTURE_START, { register: FINALIZED });
  assert.equal(plan.effect, "RECORDED_ONLY");
  assert.equal(plan.write, "NONE");
  assert.equal(plan.afterFinalization, true);
  assert.equal(plan.evidenceStatus, "PRESENT");
});

test("after finalization: evidence never changes the effective status, even of AUTO records", () => {
  // AUTO LATE, then an earlier online visit is reconciled after finalization.
  const auto = record({ status: "LATE", firstQrAt: ms(BOUNDARY, 60_000), autoStatus: "LATE" });
  const plan = evidence("ONLINE", LECTURE_START, { register: FINALIZED, record: auto });
  assert.equal(plan.effect, "REVIEW_REQUIRED");
  assert.equal(plan.afterFinalization, true);
  assert.equal(plan.fields.status, "LATE");
  assert.equal(plan.fields.statusSource, "AUTO");
  assert.equal(plan.fields.autoStatus, "PRESENT");

  // Finalization ABSENT + evidence: review, still ABSENT.
  const absent = record({ status: "ABSENT", statusSource: "FINALIZATION" });
  const late = evidence("QR", ms(BOUNDARY, 1), { register: FINALIZED, record: absent });
  assert.equal(late.effect, "REVIEW_REQUIRED");
  assert.equal(late.fields.status, "ABSENT");
  assert.equal(late.fields.statusSource, "FINALIZATION");

  // Teacher decision after finalization: same rule.
  const excused = record({ status: "EXCUSED", statusSource: "TEACHER", teacherStatus: "EXCUSED" });
  const scan = evidence("QR", LECTURE_START, { register: FINALIZED, record: excused });
  assert.equal(scan.effect, "REVIEW_REQUIRED");
  assert.equal(scan.fields.status, "EXCUSED");
});

test("backfill PRESENT is never turned into LATE by evidence", () => {
  const backfill = record({ status: "PRESENT", statusSource: "BACKFILL", firstOnlineAt: ms(BOUNDARY, 60_000), autoStatus: "LATE" });
  const plan = evidence("QR", ms(BOUNDARY, 30_000), { record: backfill });
  assert.equal(plan.effect, "EVIDENCE_ONLY");
  assert.equal(plan.fields.status, "PRESENT");
  assert.equal(plan.fields.statusSource, "BACKFILL");
});

test("evidence: inconsistent records and invalid times throw", () => {
  assert.throws(() => evidence("QR", LECTURE_START, { record: record({ status: "PRESENT", statusSource: "TEACHER", teacherStatus: "ABSENT" }) }));
  assert.throws(() => evidence("QR", LECTURE_START, { record: record({ statusSource: "AUTO", teacherStatus: "PRESENT" }) }));
  assert.throws(() => evidence("QR", new Date(NaN)), RangeError);
  assert.throws(() => evidence("QR", LECTURE_START, { now: new Date(NaN) }), RangeError);
});

test("teacher decisions need a reason when overriding a status or after finalization", () => {
  assert.equal(teacherDecisionRequiresReason({ action: "TEACHER_SET", previousStatus: null, afterFinalization: false }), false);
  assert.equal(teacherDecisionRequiresReason({ action: "TEACHER_SET", previousStatus: "PRESENT", afterFinalization: false }), true);
  assert.equal(teacherDecisionRequiresReason({ action: "TEACHER_SET", previousStatus: null, afterFinalization: true }), true);
  assert.equal(teacherDecisionRequiresReason({ action: "EVIDENCE_ACCEPTED", previousStatus: "ABSENT", afterFinalization: false }), true);
  assert.equal(teacherDecisionRequiresReason({ action: "EVIDENCE_DISMISSED", previousStatus: "ABSENT", afterFinalization: true }), false);
});

// ---- F. Finalization --------------------------------------------------------

const OPEN = { scheduledStartAt: LECTURE_START, scheduledEndAt: LECTURE_END, finalizedAt: null };
const NO_END = { ...OPEN, scheduledEndAt: null };

test("finalization: the scheduled end has passed from the end instant itself", () => {
  assert.equal(scheduledEndPassed(OPEN, ms(LECTURE_END, -1)), false);
  assert.equal(scheduledEndPassed(OPEN, LECTURE_END), true);
  assert.equal(scheduledEndPassed(NO_END, at("2030-01-01T00:00:00.000")), false);
  assert.equal(requiresExplicitCompletion(NO_END), true);
  assert.equal(requiresExplicitCompletion(OPEN), false);
});

test("finalization readiness", () => {
  const ready = (register, lectureStatus, now) => finalizationReadiness({ register, lectureStatus, now });

  assert.deepEqual(ready(OPEN, "SCHEDULED", ms(LECTURE_END, -1)), { allowed: false, reason: "SCHEDULED_END_NOT_PASSED" });
  assert.deepEqual(ready(OPEN, "LIVE", ms(LECTURE_END, -1)), { allowed: false, reason: "SCHEDULED_END_NOT_PASSED" });
  assert.deepEqual(ready(OPEN, "SCHEDULED", LECTURE_END), { allowed: true, basis: "SCHEDULED_END_PASSED" });
  assert.deepEqual(ready(OPEN, "COMPLETED", ms(LECTURE_END, -1)), { allowed: true, basis: "LECTURE_COMPLETED" });
  assert.deepEqual(ready(NO_END, "SCHEDULED", at("2030-01-01T00:00:00.000")), { allowed: false, reason: "COMPLETION_REQUIRED" });
  assert.deepEqual(ready(NO_END, "COMPLETED", LECTURE_START), { allowed: true, basis: "LECTURE_COMPLETED" });
  assert.deepEqual(ready(OPEN, "CANCELLED", LECTURE_END), { allowed: false, reason: "LECTURE_CANCELLED" });
  assert.deepEqual(ready({ ...OPEN, finalizedAt: LECTURE_END }, "COMPLETED", NOW), { allowed: false, reason: "ALREADY_FINALIZED" });
  assert.throws(() => ready(OPEN, "SCHEDULED", new Date(NaN)), RangeError);
  assert.throws(() => ready({ ...OPEN, scheduledEndAt: new Date(NaN) }, "SCHEDULED", NOW), RangeError);
});

test("finalization: absence decisions come only from the plan (eligibility at the scheduled start)", () => {
  const plan = planFinalizationAbsences({
    register: OPEN,
    classId: CLASS,
    context: CONTEXT,
    candidates: [
      { studentId: "eligible", ...approvedStudent(), enrolments: ENROLLED, hasRecord: false },
      { studentId: "eligible-recorded", ...approvedStudent(), enrolments: ENROLLED, hasRecord: true },
      { studentId: "pending", ...pendingStudent(), enrolments: ENROLLED, hasRecord: false },
    ],
  });

test("finalization plan: eligibility at the scheduled start; UNKNOWN never becomes ABSENT", () => {
  const candidate = (studentId, who, enrolments = ENROLLED, hasRecord = false) => ({ studentId, ...who, enrolments, hasRecord });
  const plan = planFinalizationAbsences({
    register: OPEN,
    classId: CLASS,
    context: CONTEXT,
    candidates: [
      candidate("absent", approvedStudent()),
      candidate("recorded", approvedStudent(), ENROLLED, true),
      candidate("pending", pendingStudent()),
      // Declined after the start: still approved AT the start.
      candidate("declined-later", { ...declinedStudent(), student: { ...declinedStudent().student, confirmedAt: at("2026-09-01T13:00:00.000") }, history: [declinedStudent().history[0], { ...declinedStudent().history[1], decidedAt: at("2026-09-01T13:00:00.000") }] }),
      // Enrolled one millisecond after the start: not eligible.
      candidate("enrolled-after", approvedStudent(), [enrolment("e9", ms(LECTURE_START, 1))]),
      // Removed exactly at the start: not eligible.
      candidate("removed-at-start", approvedStudent(), [enrolment("e8", at("2026-08-01T00:00:00.000"), LECTURE_START)]),
      candidate("broken", { ...approvedStudent(), student: { ...approvedStudent().student, confirmedAt: at("2026-08-02T00:00:00.000") } }),
    ],
  });

  assert.deepEqual(
    plan.roster.map((r) => [r.studentId, r.decision]),
    [
      ["absent", "CREATE_ABSENT"],
      ["recorded", "HAS_RECORD"],
      ["pending", "NOT_ELIGIBLE"],
      ["declined-later", "CREATE_ABSENT"],
      ["enrolled-after", "NOT_ELIGIBLE"],
      ["removed-at-start", "NOT_ELIGIBLE"],
      ["broken", "MANUAL_REVIEW"],
    ]
  );
  assert.deepEqual(plan.absentStudentIds, ["absent", "declined-later"]);
  assert.deepEqual(plan.manualReviewStudentIds, ["broken"]);
  assert.equal(plan.eligibleCount, 3);
  assert.equal(plan.unknownEligibilityCount, 1);
  assert.equal(plan.absentCreatedCount, 2);
});

test("finalization plan: a lecture before the approval feature makes everyone UNKNOWN, nobody ABSENT", () => {
  const early = { scheduledStartAt: at("2026-07-15T12:30:00.000"), scheduledEndAt: null, finalizedAt: null };
  const plan = planFinalizationAbsences({
    register: early,
    classId: CLASS,
    context: CONTEXT,
    candidates: [{ studentId: "s1", ...approvedStudent(), enrolments: ENROLLED, hasRecord: false }],
  });
  assert.deepEqual(plan.absentStudentIds, []);
  assert.deepEqual(plan.manualReviewStudentIds, ["s1"]);
  assert.equal(plan.absentCreatedCount, 0);
});

test("finalization plan: requires a valid context (even for an empty roster) and unique students", () => {
  for (const context of [undefined, {}, { approvalFeatureStartedAt: new Date(NaN) }]) {
    assert.throws(() => planFinalizationAbsences({ register: OPEN, classId: CLASS, candidates: [], context }), TypeError);
  }
  const c = { studentId: "s1", ...approvedStudent(), enrolments: ENROLLED, hasRecord: false };
  assert.throws(() => planFinalizationAbsences({ register: OPEN, classId: CLASS, candidates: [c, c], context: CONTEXT }), /more than once/);
  assert.throws(() => planFinalizationAbsences({ register: { ...OPEN, scheduledStartAt: new Date(NaN) }, classId: CLASS, candidates: [], context: CONTEXT }), RangeError);
});

  assert.deepEqual(
    plan.roster.map((r) => [r.studentId, r.decision]),
    [
      ["eligible", "CREATE_ABSENT"],
      ["eligible-recorded", "HAS_RECORD"],
      ["pending", "NOT_ELIGIBLE"],
    ]
  );
});

test("W2: no general absence helper is exported; planFinalizationAbsences is the only absence planner", () => {
  const finalization = require(path.join(root, "lib", "attendance", "finalization.ts"));
  assert.equal("absenceDecision" in attendance, false);
  assert.equal("absenceDecision" in finalization, false);
  assert.equal(typeof attendance.planFinalizationAbsences, "function");
  const absencePlanners = Object.keys(attendance).filter((name) => /absen/i.test(name));
  assert.deepEqual(absencePlanners, ["planFinalizationAbsences"]);
});

// ---- Correction pass: approval reasons through eligibility ------------------

test("eligibility: APPROVED_AT_EVIDENCE is eligible only at the approvedAt instant (inherited approvalAt rule)", () => {
  const legacyApprovedAt = at("2026-07-10T00:00:00.000"); // before the approval feature started
  const who = { student: { confirmationStatus: "APPROVED", confirmedAt: null, approvedAt: legacyApprovedAt, status: 0 }, history: [] };

  const exact = eligibility(who, legacyApprovedAt);
  assert.equal(exact.outcome, "ELIGIBLE");
  assert.equal(exact.approval.reason, "APPROVED_AT_EVIDENCE");
  assert.deepEqual(scanResultForEligibility(exact), { result: "VALID", eligibilityReason: "APPROVED_AT_EVIDENCE" });

  const later = eligibility(who, ms(legacyApprovedAt, 1));
  assert.equal(later.outcome, "UNKNOWN");
  assert.equal(later.approval.reason, "BEFORE_APPROVAL_FEATURE");

  // From the feature start the APPROVED starting status is known.
  assert.equal(eligibility(who, FEATURE).approval.reason, "KNOWN_APPROVED");
});

test("eligibility: BEFORE_RECORDED_DECISIONS is UNKNOWN; the known period after it is decided", () => {
  const rejectedAt = at("2026-08-05T00:00:00.000");
  const reapprovedAt = at("2026-08-10T00:00:00.000");
  const who = {
    student: { confirmationStatus: "APPROVED", confirmedAt: reapprovedAt, approvedAt: APPROVED_AT, status: 0 },
    history: [{ id: "h1", fromStatus: "REJECTED", toStatus: "APPROVED", decidedAt: reapprovedAt, previousConfirmedAt: rejectedAt }],
  };

  const before = eligibility(who, ms(rejectedAt, -1));
  assert.equal(before.outcome, "UNKNOWN");
  assert.equal(before.approval.reason, "BEFORE_RECORDED_DECISIONS");
  assert.deepEqual(scanResultForEligibility(before), { result: "ELIGIBILITY_UNKNOWN", eligibilityReason: "BEFORE_RECORDED_DECISIONS" });

  assert.equal(eligibility(who, rejectedAt).reason, "NOT_APPROVED");
  assert.equal(eligibility(who, reapprovedAt).outcome, "ELIGIBLE");
});

test("eligibility: APPROVED_AT_CONFLICT is UNKNOWN (approvedAt contradicts a known PENDING period)", () => {
  const decidedAt = at("2026-08-10T00:00:00.000");
  const who = {
    student: { confirmationStatus: "APPROVED", confirmedAt: decidedAt, approvedAt: at("2026-08-03T00:00:00.000"), status: 0 },
    history: [{ id: "h1", fromStatus: "PENDING", toStatus: "APPROVED", decidedAt, previousConfirmedAt: null }],
  };

  const conflict = eligibility(who, at("2026-08-04T00:00:00.000"));
  assert.equal(conflict.outcome, "UNKNOWN");
  assert.equal(conflict.approval.reason, "APPROVED_AT_CONFLICT");
  assert.deepEqual(scanResultForEligibility(conflict), { result: "ELIGIBILITY_UNKNOWN", eligibilityReason: "APPROVED_AT_CONFLICT" });
  assert.equal(eligibility(who, decidedAt).outcome, "ELIGIBLE");
});

test("eligibility for evidence uses enrolment at the evidence time, not at some point of the lecture", () => {
  const removedAt = ms(LECTURE_START, 5 * 60_000);
  const rows = [enrolment("e1", at("2026-08-01T00:00:00.000"), removedAt)];

  assert.equal(eligibility(approvedStudent(), ms(removedAt, -1), rows).outcome, "ELIGIBLE");
  const afterRemoval = eligibility(approvedStudent(), removedAt, rows);
  assert.equal(afterRemoval.reason, "NOT_ENROLLED");
  assert.equal(evidence("QR", removedAt, { eligibility: afterRemoval.outcome }).effect, "NONE");

  // Enrolled after the start but before the scan: evidence counts, an automatic ABSENT would not.
  const joinedLate = [enrolment("e2", ms(LECTURE_START, 1))];
  assert.equal(eligibility(approvedStudent(), ms(LECTURE_START, 60_000), joinedLate).outcome, "ELIGIBLE");
  assert.equal(eligibility(approvedStudent(), LECTURE_START, joinedLate).reason, "NOT_ENROLLED");
});

// ---- Correction pass W1: dismissed reviews and same-channel reconciliation ---

const teacherAbsent = (fields = {}) =>
  record({ status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", ...fields });

test("W1: a dismissed review is not recreated by same-channel reconciliation with the same status", () => {
  // Online PRESENT at start + 5 min raised a review; the teacher dismissed it (pendingReviewSince null).
  const dismissed = teacherAbsent({ firstOnlineAt: ms(LECTURE_START, 5 * 60_000), autoStatus: "PRESENT" });
  const plan = evidence("ONLINE", ms(LECTURE_START, -60_000), { record: dismissed });

  assert.equal(plan.effect, "EVIDENCE_ONLY");
  assert.equal(plan.write, "UPDATE");
  assert.equal(plan.fields.firstOnlineAt.getTime(), ms(LECTURE_START, -60_000).getTime()); // still the earliest
  assert.equal(plan.fields.status, "ABSENT");
  assert.equal(plan.fields.pendingReviewSince, null);
});

test("W1: same-channel LATE reconciliation of a dismissed LATE review raises nothing", () => {
  const dismissed = teacherAbsent({ firstOnlineAt: ms(BOUNDARY, 30 * 60_000), autoStatus: "LATE" });
  const plan = evidence("ONLINE", ms(BOUNDARY, 1), { record: dismissed });
  assert.equal(plan.effect, "EVIDENCE_ONLY");
  assert.equal(plan.fields.pendingReviewSince, null);
});

test("W1: same-channel reconciliation that is genuinely stronger still raises a review", () => {
  // The channel showed LATE (dismissed); an earlier visit shows PRESENT.
  const dismissed = teacherAbsent({ firstOnlineAt: ms(BOUNDARY, 30 * 60_000), autoStatus: "LATE" });
  const plan = evidence("ONLINE", LECTURE_START, { record: dismissed });
  assert.equal(plan.effect, "REVIEW_REQUIRED");
  assert.equal(plan.fields.pendingReviewSince.getTime(), NOW.getTime());

  // Teacher LATE: online LATE (no review), then an earlier PRESENT visit.
  const late = record({ status: "LATE", statusSource: "TEACHER", teacherStatus: "LATE", firstOnlineAt: ms(BOUNDARY, 60_000), autoStatus: "LATE" });
  assert.equal(evidence("ONLINE", LECTURE_START, { record: late }).effect, "REVIEW_REQUIRED");
});

test("W1: a genuinely new channel still raises a review after a dismissal", () => {
  const dismissed = teacherAbsent({ firstOnlineAt: ms(LECTURE_START, 5 * 60_000), autoStatus: "PRESENT" });
  const plan = evidence("QR", ms(BOUNDARY, 60_000), { record: dismissed });
  assert.equal(plan.effect, "REVIEW_REQUIRED");
  assert.equal(plan.evidenceStatus, "LATE");
  assert.equal(plan.fields.pendingReviewSince.getTime(), NOW.getTime());
});

test("W1: an open review keeps its original time through same-channel reconciliation", () => {
  const since = at("2026-09-01T12:40:00.000");
  const open = teacherAbsent({ firstOnlineAt: ms(LECTURE_START, 5 * 60_000), autoStatus: "PRESENT", pendingReviewSince: since });

  const same = evidence("ONLINE", LECTURE_START, { record: open });
  assert.equal(same.effect, "EVIDENCE_ONLY");
  assert.equal(same.fields.pendingReviewSince.getTime(), since.getTime());

  const lateOpen = teacherAbsent({ firstOnlineAt: ms(BOUNDARY, 30 * 60_000), autoStatus: "LATE", pendingReviewSince: since });
  const stronger = evidence("ONLINE", LECTURE_START, { record: lateOpen });
  assert.equal(stronger.effect, "REVIEW_REQUIRED");
  assert.equal(stronger.fields.pendingReviewSince.getTime(), since.getTime());
});

test("W1: after finalization the same rules apply and the status never changes", () => {
  const absent = record({ status: "ABSENT", statusSource: "FINALIZATION", firstOnlineAt: ms(BOUNDARY, 30 * 60_000), autoStatus: "LATE" });
  const sameStrength = evidence("ONLINE", ms(BOUNDARY, 1), { register: FINALIZED, record: absent });
  assert.equal(sameStrength.effect, "EVIDENCE_ONLY");
  assert.equal(sameStrength.fields.status, "ABSENT");

  const stronger = evidence("ONLINE", LECTURE_START, { register: FINALIZED, record: absent });
  assert.equal(stronger.effect, "REVIEW_REQUIRED");
  assert.equal(stronger.fields.status, "ABSENT");
  assert.equal(stronger.fields.statusSource, "FINALIZATION");

  const newChannel = evidence("QR", ms(BOUNDARY, 60_000), { register: FINALIZED, record: absent });
  assert.equal(newChannel.effect, "REVIEW_REQUIRED");
});

test("W1: open AUTO records are unaffected (status follows the earliest evidence, no review)", () => {
  const rec = record({ status: "LATE", firstOnlineAt: ms(BOUNDARY, 60_000), autoStatus: "LATE" });
  const plan = evidence("ONLINE", LECTURE_START, { record: rec });
  assert.equal(plan.effect, "STATUS_UPDATED");
  assert.equal(plan.fields.status, "PRESENT");
  assert.equal(plan.fields.pendingReviewSince, null);
});

test("BACKFILL exception: stays PRESENT and never raises a review, open or finalized", () => {
  const backfill = record({ status: "PRESENT", statusSource: "BACKFILL", firstOnlineAt: ms(BOUNDARY, 60_000), autoStatus: "LATE" });
  for (const register of [REGISTER, FINALIZED]) {
    for (const [channel, time] of [["QR", ms(BOUNDARY, 30_000)], ["ONLINE", LECTURE_START], ["QR", LECTURE_START]]) {
      const plan = evidence(channel, time, { register, record: backfill });
      assert.equal(plan.effect, "EVIDENCE_ONLY");
      assert.equal(plan.fields.status, "PRESENT");
      assert.equal(plan.fields.statusSource, "BACKFILL");
      assert.equal(plan.fields.pendingReviewSince, null);
    }
  }
});

// ---- Correction pass W3: evidence time against the server time --------------

test("W3: evidence at or before the server time is accepted", () => {
  assert.equal(evidence("QR", NOW, { now: NOW }).write, "CREATE"); // equal
  assert.equal(evidence("QR", ms(NOW, -1), { now: NOW }).write, "CREATE"); // past
  assert.equal(evidence("ONLINE", LECTURE_START, { now: NOW }).fields.status, "PRESENT"); // reconciliation of an old visit
});

test("W3: evidence later than the server time is rejected on every path", () => {
  const future = ms(NOW, 1);
  const existing = record({ firstQrAt: LECTURE_START, autoStatus: "PRESENT" });
  const variants = [
    {},
    { register: FINALIZED },
    { record: existing }, // would otherwise be a duplicate
    { eligibility: "NOT_ELIGIBLE" },
    { eligibility: "UNKNOWN" },
  ];
  for (const overrides of variants) {
    assert.throws(() => evidence("QR", future, { now: NOW, ...overrides }), /later than the server time/);
  }
});

// ---- Correction pass D1: start boundary ---------------------------------------

test("D1: finalization is refused before the scheduled start, even when COMPLETED", () => {
  const ready = (register, lectureStatus, now) => finalizationReadiness({ register, lectureStatus, now });
  const before = ms(LECTURE_START, -1);

  for (const status of ["SCHEDULED", "LIVE", "COMPLETED"]) {
    assert.deepEqual(ready(OPEN, status, before), { allowed: false, reason: "LECTURE_NOT_STARTED" }, status);
    assert.deepEqual(ready(NO_END, status, before), { allowed: false, reason: "LECTURE_NOT_STARTED" }, status);
  }
  assert.deepEqual(ready(OPEN, "COMPLETED", ms(LECTURE_START, -24 * 60 * 60_000)), { allowed: false, reason: "LECTURE_NOT_STARTED" });

  // Earlier checks keep their precedence.
  assert.deepEqual(ready(OPEN, "CANCELLED", before), { allowed: false, reason: "LECTURE_CANCELLED" });
  assert.deepEqual(ready({ ...OPEN, finalizedAt: LECTURE_END }, "COMPLETED", before), { allowed: false, reason: "ALREADY_FINALIZED" });
});

test("D1: from the scheduled start itself, the other rules decide", () => {
  const ready = (register, lectureStatus, now) => finalizationReadiness({ register, lectureStatus, now });

  assert.deepEqual(ready(OPEN, "COMPLETED", LECTURE_START), { allowed: true, basis: "LECTURE_COMPLETED" });
  assert.deepEqual(ready(NO_END, "COMPLETED", LECTURE_START), { allowed: true, basis: "LECTURE_COMPLETED" });
  assert.deepEqual(ready(OPEN, "SCHEDULED", LECTURE_START), { allowed: false, reason: "SCHEDULED_END_NOT_PASSED" });
  assert.deepEqual(ready(NO_END, "LIVE", LECTURE_START), { allowed: false, reason: "COMPLETION_REQUIRED" });
  assert.deepEqual(ready(OPEN, "LIVE", LECTURE_END), { allowed: true, basis: "SCHEDULED_END_PASSED" });
});

// ---- Purity -----------------------------------------------------------------

test("the helpers are pure: no database, clock, environment or client time", () => {
  const dir = path.join(root, "lib", "attendance");
  // Stage 5.7b-3h: percentage.ts (the shared attendance percentage rule) is pure too.
  const PURE = ["eligibility.ts", "enrolment.ts", "evidence.ts", "finalization.ts", "finalization-fingerprint.ts", "index.ts", "percentage.ts", "status.ts"];
  // Stage 5.4 service-side modules live next to them but are NOT pure (they
  // read the environment or use Prisma) and are never exported by index.ts.
  // Stage 5.7b-3b: qr-scan-rate-limit.ts (the scan route's in-memory limiter; it reads the clock).
  const SERVICE_SIDE = ["config.ts", "locks.ts", "qr-scan-rate-limit.ts", "service-errors.ts"];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.deepEqual(files.sort(), [...PURE, ...SERVICE_SIDE].sort());

  const index = fs.readFileSync(path.join(dir, "index.ts"), "utf8");
  for (const file of SERVICE_SIDE) assert.ok(!index.includes(file.replace(/\.ts$/, "")), `index.ts must not export ${file}`);

  for (const file of PURE) {
    const source = fs.readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(source, /prisma|@prisma\/client|\$transaction|\$queryRaw/i, file);
    assert.doesNotMatch(source, /Date\.now\(\)|new Date\(\)|nowInSriLanka|serverNow/, file);
    assert.doesNotMatch(source, /process\.env/, file);
    assert.doesNotMatch(source, /clientScannedAt/, file);
    assert.doesNotMatch(source, /from "@\/services|from "@\/lib\/(fee-waiver|prisma|server-clock)"/, file);
  }
});
