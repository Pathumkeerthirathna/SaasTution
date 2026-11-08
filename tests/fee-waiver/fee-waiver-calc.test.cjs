/*
 * Automatic joining fee waiver — pure calculation (lib/fee-waiver.ts).
 *
 *   npm run test:fee-waiver
 *
 * No database. Expectations are fixed instants, so the suite passes in any
 * process timezone (also run with TZ=Europe/Berlin).
 *
 * Conventions in these tests:
 *   digits("2026-12-05T10:00") = Sri Lankan wall-clock digits, as
 *       ClassStudent.assignedAt / removedAt are stored (nowInSriLanka()).
 *   sl("2026-12-05T10:00")     = the REAL instant of that Sri Lankan time, as
 *       Student.approvedAt and Lecture.date are stored.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const fw = require(path.join(root, "lib", "fee-waiver.ts"));

const digits = (wall) => new Date(`${wall}:00.000Z`);
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const iso = (d) => d.toISOString();
const DEC = { year: 2026, month: 12 };
const NOV = { year: 2026, month: 11 };

const CLASS = "class-maths";
const OTHER = "class-physics";

const teacherStudent = (over = {}) => ({
  status: 0,
  registrationSource: "TEACHER",
  publicClassId: null,
  confirmationStatus: "APPROVED",
  approvedAt: null,
  ...over,
});

const publicStudent = (over = {}) => ({
  status: 0,
  registrationSource: "PUBLIC_CLASS",
  publicClassId: CLASS,
  confirmationStatus: "APPROVED",
  approvedAt: null,
  ...over,
});

const row = (id, assigned, removed = null, classId = CLASS) => ({
  id,
  classId,
  assignedAt: digits(assigned),
  removedAt: removed ? digits(removed) : null,
});

const RULES = [
  { id: "r1", sequence: 1, type: "PERCENTAGE", value: 10 },
  { id: "r2", sequence: 2, type: "PERCENTAGE", value: 20 },
  { id: "r3", sequence: 3, type: "PERCENTAGE", value: 40 },
];

// December 2026 Maths lectures (real instants of Sri Lankan 18:00).
const DEC_LECTURES = [sl("2026-12-05T18:00"), sl("2026-12-12T18:00"), sl("2026-12-19T18:00"), sl("2026-12-26T18:00")];

function waiver({ student = teacherStudent(), enrolments, enrolmentId, month = DEC, lectures = DEC_LECTURES, rules = RULES, base = 2000 }) {
  return fw.computeJoinWaiver({
    student,
    enrolments,
    enrolmentId,
    month,
    completedLectureDates: lectures,
    rules,
    baseAmount: base,
  });
}

// ---- Rule selection and amounts --------------------------------------------

test("rule N for N lectures; more lectures than rules -> last rule; none for 0 or no rules", () => {
  assert.equal(fw.selectRule(RULES, 0), null);
  assert.equal(fw.selectRule(RULES, 1).id, "r1");
  assert.equal(fw.selectRule(RULES, 2).id, "r2");
  assert.equal(fw.selectRule(RULES, 3).id, "r3");
  assert.equal(fw.selectRule(RULES, 4).id, "r3");
  assert.equal(fw.selectRule([], 2), null);
  assert.equal(fw.selectRule([RULES[2], RULES[0], RULES[1]], 2).id, "r2", "ordered by sequence");
});

test("the business example: joined 20 Dec after 5, 12, 19 Dec -> rule 3 only (never added)", () => {
  const result = waiver({ enrolments: [row("e1", "2026-12-20T09:00")], enrolmentId: "e1" });
  assert.equal(result.kind, "AUTO");
  assert.equal(result.lecturesBefore, 3);
  assert.equal(result.sequence, 3);
  assert.equal(result.deduction, 800, "40% of 2000, not 10+20+40");

  const twoRules = waiver({ enrolments: [row("e1", "2026-12-20T09:00")], enrolmentId: "e1", rules: RULES.slice(0, 2) });
  assert.equal(twoRules.sequence, 2);
  assert.equal(twoRules.deduction, 400);

  const oneRule = waiver({ enrolments: [row("e1", "2026-12-20T09:00")], enrolmentId: "e1", rules: RULES.slice(0, 1) });
  assert.equal(oneRule.deduction, 200);

  assert.equal(waiver({ enrolments: [row("e1", "2026-12-20T09:00")], enrolmentId: "e1", rules: [] }).kind, "NONE");
});

test("joined before the first lecture -> no waiver", () => {
  assert.equal(waiver({ enrolments: [row("e1", "2026-12-02T09:00")], enrolmentId: "e1" }).kind, "NONE");
});

test("percentage rounding (half up, whole LKR) and fixed amounts capped at the fee", () => {
  assert.equal(fw.computeDeduction({ type: "PERCENTAGE", value: 10 }, 1250), 125);
  assert.equal(fw.computeDeduction({ type: "PERCENTAGE", value: 15 }, 333), 50); // 49.95
  assert.equal(fw.computeDeduction({ type: "PERCENTAGE", value: 15 }, 330), 50); // 49.5 -> 50
  assert.equal(fw.computeDeduction({ type: "PERCENTAGE", value: 15 }, 329), 49); // 49.35
  assert.equal(fw.computeDeduction({ type: "PERCENTAGE", value: 50 }, 1005), 503); // 502.5
  assert.equal(fw.computeDeduction({ type: "PERCENTAGE", value: 100 }, 1500), 1500);
  assert.equal(fw.computeDeduction({ type: "FIXED_AMOUNT", value: 500 }, 2000), 500);
  assert.equal(fw.computeDeduction({ type: "FIXED_AMOUNT", value: 5000 }, 2000), 2000);
  assert.equal(fw.computeDeduction({ type: "FIXED_AMOUNT", value: 500 }, 0), 0);
});

// ---- Lecture timing ---------------------------------------------------------

test("only lectures strictly earlier than joining count (same minute excluded)", () => {
  const at = (wall) => waiver({ enrolments: [row("e1", wall)], enrolmentId: "e1" });
  assert.equal(at("2026-12-05T18:00").kind, "NONE", "joined at the lecture's start: not before");
  assert.equal(at("2026-12-05T18:01").lecturesBefore, 1);
  assert.equal(at("2026-12-12T17:59").lecturesBefore, 1);
});

test("lectures of the previous month never count, even at 23:30 on its last day", () => {
  const result = waiver({
    enrolments: [row("e1", "2026-12-01T00:15")],
    enrolmentId: "e1",
    lectures: [sl("2026-11-30T23:30"), sl("2026-11-28T18:00")],
  });
  assert.equal(result.kind, "NONE");

  const withDec = waiver({
    enrolments: [row("e1", "2026-12-01T09:00")],
    enrolmentId: "e1",
    lectures: [sl("2026-11-30T23:30"), sl("2026-12-01T00:15")],
  });
  assert.equal(withDec.lecturesBefore, 1, "only the 00:15 1 Dec lecture");
});

test("year rollover: January 2027 window", () => {
  const { start, end } = fw.sriLankaMonthWindow({ year: 2027, month: 1 });
  assert.equal(iso(start), "2026-12-31T18:30:00.000Z");
  assert.equal(iso(end), "2027-01-31T18:30:00.000Z");
  const result = waiver({
    month: { year: 2027, month: 1 },
    enrolments: [row("e1", "2027-01-10T10:00")],
    enrolmentId: "e1",
    lectures: [sl("2026-12-31T23:59"), sl("2027-01-01T00:00"), sl("2027-01-08T18:00")],
  });
  assert.equal(result.lecturesBefore, 2);
});

test("shifted assignedAt digits are never treated as real UTC", () => {
  // Joined 13 Dec 03:00 Sri Lanka (= 12 Dec 21:30 UTC). The 12 Dec 18:00 SL
  // lecture (12:30 UTC) is before; read as UTC digits 13 Dec 03:00 would also
  // include nothing more — but a lecture at 13 Dec 01:00 SL (12 Dec 19:30 UTC)
  // is before the real join, while a naive digits-as-UTC reading (13 Dec 03:00Z)
  // would wrongly count a lecture at 13 Dec 05:00 SL (12 Dec 23:30 UTC) too.
  const result = waiver({
    enrolments: [row("e1", "2026-12-13T03:00")],
    enrolmentId: "e1",
    lectures: [sl("2026-12-05T18:00"), sl("2026-12-13T01:00"), sl("2026-12-13T05:00")],
  });
  assert.equal(result.lecturesBefore, 2);
  assert.equal(iso(result.enrolledAt), "2026-12-12T21:30:00.000Z");
});

// ---- Launch gate ------------------------------------------------------------

test("launch month = first full Sri Lankan month after deployment (30 Nov / 1 Dec)", () => {
  assert.deepEqual(fw.firstFullSriLankaMonthAfter(new Date("2026-11-15T06:00:00.000Z")), { year: 2026, month: 12 });
  assert.deepEqual(fw.firstFullSriLankaMonthAfter(new Date("2026-11-30T18:29:59.999Z")), { year: 2026, month: 12 }); // 30 Nov 23:59:59 SL
  assert.deepEqual(fw.firstFullSriLankaMonthAfter(new Date("2026-11-30T18:30:00.000Z")), { year: 2027, month: 1 }); // 1 Dec 00:00 SL
  assert.deepEqual(fw.firstFullSriLankaMonthAfter(new Date("2026-12-31T18:30:00.000Z")), { year: 2027, month: 2 }); // 1 Jan 00:00 SL
});

test("settings validation fails safe; gate compares months", () => {
  assert.deepEqual(fw.parseFeeWaiverStart({ startYear: 2026, startMonth: 12 }), DEC);
  for (const bad of [null, undefined, { startYear: 2026, startMonth: 13 }, { startYear: 2026, startMonth: 0 }, { startYear: 2025, startMonth: 5 }, { startYear: "2026", startMonth: 12 }, { startYear: 2026.5, startMonth: 1 }]) {
    assert.equal(fw.parseFeeWaiverStart(bad), null, JSON.stringify(bad));
  }
  assert.equal(fw.isWaiverMonth(DEC, NOV), false);
  assert.equal(fw.isWaiverMonth(DEC, DEC), true);
  assert.equal(fw.isWaiverMonth(DEC, { year: 2027, month: 1 }), true);
  assert.equal(fw.isWaiverMonth(null, DEC), false, "not configured -> off");
});

test("joining at 30 Nov 23:59 SL belongs to November; 1 Dec 00:00 SL to December", () => {
  assert.deepEqual(fw.billingMonthOf(sl("2026-11-30T23:59")), NOV);
  assert.deepEqual(fw.billingMonthOf(sl("2026-12-01T00:00")), DEC);
  assert.equal(waiver({ enrolments: [row("e1", "2026-11-30T23:59")], enrolmentId: "e1" }).kind, "NONE", "not a December joiner");
});

// ---- Enrolment types and approval ---------------------------------------------

test("public registration: original enrolment counts from the FIRST approval", () => {
  // Registered 28 Nov, first approved 10 Dec 09:00 SL.
  const student = publicStudent({ approvedAt: sl("2026-12-10T09:00") });
  const result = waiver({ student, enrolments: [row("p1", "2026-11-28T15:00")], enrolmentId: "p1" });
  assert.equal(result.kind, "AUTO", "approval month (December) decides, not registration month");
  assert.equal(result.lecturesBefore, 1, "only 5 Dec is before the 10 Dec approval");
  assert.equal(iso(result.enrolledAt), iso(sl("2026-12-10T09:00")));

  assert.equal(
    waiver({ student, month: NOV, enrolments: [row("p1", "2026-11-28T15:00")], enrolmentId: "p1", lectures: [sl("2026-11-20T18:00")] }).kind,
    "NONE",
    "no November waiver for a November registration approved in December"
  );
});

test("public registration approved before it was assigned uses assignedAt (the later one)", () => {
  const student = publicStudent({ approvedAt: sl("2026-12-01T08:00") });
  const result = waiver({ student, enrolments: [row("p1", "2026-12-13T10:00")], enrolmentId: "p1" });
  assert.equal(result.lecturesBefore, 2);
});

test("pending / rejected / never-approved / inactive students get no waiver on ANY enrolment", () => {
  const enrolments = [row("p1", "2026-12-20T10:00"), row("t1", "2026-12-20T10:00", null, OTHER)];
  for (const student of [
    publicStudent({ confirmationStatus: "PENDING" }),
    publicStudent({ confirmationStatus: "REJECTED", approvedAt: sl("2026-12-20T11:00") }),
    publicStudent({ approvedAt: null }),
    teacherStudent({ status: 1 }),
    teacherStudent({ status: 2 }),
  ]) {
    assert.equal(waiver({ student, enrolments: enrolments.slice(0, 1), enrolmentId: "p1" }).kind, "NONE");
  }
  // Rejected public student's teacher-created enrolment in another class: also none.
  assert.equal(
    waiver({
      student: publicStudent({ confirmationStatus: "REJECTED", approvedAt: sl("2026-12-01T09:00") }),
      enrolments: [row("t1", "2026-12-20T10:00", null, OTHER)],
      enrolmentId: "t1",
    }).kind,
    "NONE"
  );
});

test("re-approved after rejection: the FIRST approvedAt still decides (gate passes again)", () => {
  // First approved 13 Dec, rejected 15 Dec, re-approved 22 Dec: approvedAt
  // stays 13 Dec (the service never overwrites it), so two lectures count, not three.
  const firstApproval = sl("2026-12-13T09:00");
  const student = publicStudent({ approvedAt: firstApproval, confirmationStatus: "APPROVED" });
  const result = waiver({ student, enrolments: [row("p1", "2026-12-01T10:00")], enrolmentId: "p1" });
  assert.equal(result.kind, "AUTO");
  assert.equal(iso(result.enrolledAt), iso(firstApproval));
  assert.equal(result.lecturesBefore, 2);
});

test("teacher-created enrolment of a public student in another class uses its own assignedAt", () => {
  const student = publicStudent({ approvedAt: sl("2026-11-02T09:00") });
  const result = waiver({
    student,
    enrolments: [row("t2", "2026-12-20T10:00", null, OTHER)],
    enrolmentId: "t2",
  });
  assert.equal(result.lecturesBefore, 3);
  assert.equal(iso(result.enrolledAt), iso(sl("2026-12-20T10:00")));
});

test("a teacher re-add to the public class after removal uses its own assignedAt", () => {
  const student = publicStudent({ approvedAt: sl("2026-09-05T09:00") });
  const enrolments = [row("p1", "2026-09-01T10:00", "2026-10-10T12:00"), row("t9", "2026-12-20T10:00")];
  const result = waiver({ student, enrolments, enrolmentId: "t9" });
  assert.equal(result.kind, "AUTO");
  assert.equal(iso(result.enrolledAt), iso(sl("2026-12-20T10:00")));
});

// ---- Rejoining ----------------------------------------------------------------

test("left in October, rejoined in December -> eligible", () => {
  const enrolments = [row("e1", "2026-09-01T10:00", "2026-10-15T10:00"), row("e2", "2026-12-20T10:00")];
  assert.equal(waiver({ enrolments, enrolmentId: "e2" }).sequence, 3);
});

test("enrolled when the month began -> no joining waiver, even after a mid-month rejoin", () => {
  const enrolments = [row("e1", "2026-09-01T10:00", "2026-12-08T10:00"), row("e2", "2026-12-20T10:00")];
  assert.equal(waiver({ enrolments, enrolmentId: "e2" }).kind, "NONE");
  assert.equal(waiver({ enrolments, enrolmentId: "e1" }).kind, "NONE");
});

test("removed exactly at the start of the month still counts as enrolled then", () => {
  const enrolments = [row("e1", "2026-09-01T10:00", "2026-12-01T00:00"), row("e2", "2026-12-20T10:00")];
  assert.equal(waiver({ enrolments, enrolmentId: "e2" }).kind, "NONE");
});

test("two enrolments in the same month -> one waiver, on the earliest", () => {
  const enrolments = [row("e1", "2026-12-06T10:00", "2026-12-10T10:00"), row("e2", "2026-12-20T10:00")];
  const first = waiver({ enrolments, enrolmentId: "e1" });
  assert.equal(first.kind, "AUTO");
  assert.equal(first.lecturesBefore, 1);
  assert.equal(waiver({ enrolments, enrolmentId: "e2" }).kind, "NONE");
});

test("legacy (pre-September) rows only matter for the month-start check, where 5h30 cannot change the answer", () => {
  // A legacy row stored as real UTC and removed in August: never active at 1 Dec.
  const enrolments = [row("legacy", "2026-06-01T10:00", "2026-08-01T10:00"), row("e2", "2026-12-20T10:00")];
  assert.equal(waiver({ enrolments, enrolmentId: "e2" }).kind, "AUTO");
  // A legacy row still active: blocks, whichever convention it used.
  assert.equal(waiver({ enrolments: [row("legacy", "2026-06-01T10:00"), row("e2", "2026-12-20T10:00")], enrolmentId: "e2" }).kind, "NONE");
});

// ---- Storage --------------------------------------------------------------------

test("columns: AUTO stores a full snapshot; NONE clears it and the deduction", () => {
  const at = new Date("2026-12-21T00:00:00.000Z");
  const auto = waiver({ enrolments: [row("e1", "2026-12-20T09:00")], enrolmentId: "e1" });
  assert.deepEqual(fw.joinWaiverColumns(auto, at), {
    lateJoinDeduct: 800,
    joinWaiverRuleId: "r3",
    joinWaiverSequence: 3,
    joinWaiverType: "PERCENTAGE",
    joinWaiverValue: 40,
    joinWaiverLecturesBefore: 3,
    joinWaiverEnrolledAt: sl("2026-12-20T09:00"),
    joinWaiverBaseAmount: 2000,
    joinWaiverComputedAt: at,
  });
  const none = fw.joinWaiverColumns({ kind: "NONE" }, at);
  assert.equal(none.lateJoinDeduct, 0);
  assert.ok(Object.entries(none).every(([k, v]) => k === "lateJoinDeduct" || v === null));
});
