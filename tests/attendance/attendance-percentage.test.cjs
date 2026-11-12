/*
 * Stage 5.7b-3h: the shared attendance percentage rule
 * (lib/attendance/percentage.ts, pure) and service
 * (services/attendance-percentage-service.ts, read only) over a fake Prisma
 * that implements exactly the reads the service makes and counts them. No
 * database. No consumer uses the service yet: the last tests guard that.
 *
 *   node --test tests/attendance/attendance-percentage.test.cjs   (part of npm run test:attendance)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

let db = null;
{
  const filename = path.join(root, "lib/prisma.ts");
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = { prisma: new Proxy({}, { get: (_, key) => db.prisma[key] }) };
  require.cache[filename] = mod;
}

const rule = require(path.join(root, "lib", "attendance", "percentage.ts"));
const service = require(path.join(root, "services", "attendance-percentage-service.ts"));

// =========================================================================================
// 1. The pure rule
// =========================================================================================

const T = (iso) => new Date(iso);
const START = T("2026-09-01T12:30:00.000Z");
const END = T("2026-09-01T14:30:00.000Z");

test("held: from the start, once the scheduled end passed (the end instant included) or the lecture is COMPLETED", () => {
  const held = (now, classStatus = "SCHEDULED", end = END) => rule.lectureHeld({ classStatus, scheduledStartAt: START, scheduledEndAt: end, now });
  assert.equal(held(T("2026-09-01T12:29:59.999Z"), "COMPLETED"), false, "before the start, even COMPLETED");
  assert.equal(held(T("2026-09-01T13:00:00.000Z")), false, "in progress");
  assert.equal(held(T("2026-09-01T13:00:00.000Z"), "LIVE"), false);
  assert.equal(held(T("2026-09-01T13:00:00.000Z"), "COMPLETED"), true, "completed early");
  assert.equal(held(END), true, "the end instant itself");
  assert.equal(held(T("2026-09-02T00:00:00.000Z"), "LIVE"), true, "a LIVE lecture past its end is held");
  assert.equal(held(T("2026-09-05T00:00:00.000Z"), "SCHEDULED", null), false, "no end time: needs COMPLETED");
  assert.equal(held(T("2026-09-05T00:00:00.000Z"), "COMPLETED", null), true);
  assert.throws(() => rule.lectureHeld({ classStatus: "SCHEDULED", scheduledStartAt: START, scheduledEndAt: END, now: new Date("x") }), RangeError);
});

test("scope: deleted, cancelled, not held, not enrolled — in that order; otherwise considered", () => {
  const base = { deleted: false, classStatus: "COMPLETED", scheduledStartAt: START, scheduledEndAt: END, enrolledAtStart: true, now: T("2026-10-01T00:00:00Z") };
  assert.deepEqual(rule.lectureScope(base), { considered: true });
  assert.deepEqual(rule.lectureScope({ ...base, deleted: true, classStatus: "CANCELLED" }), { considered: false, reason: "DELETED" });
  assert.deepEqual(rule.lectureScope({ ...base, classStatus: "CANCELLED" }), { considered: false, reason: "CANCELLED" });
  assert.deepEqual(rule.lectureScope({ ...base, now: T("2026-08-01T00:00:00Z"), enrolledAtStart: false }), { considered: false, reason: "NOT_HELD" });
  assert.deepEqual(rule.lectureScope({ ...base, enrolledAtStart: false }), { considered: false, reason: "NOT_ENROLLED" });
});

test("outcome: canonical status alone decides; no record → UNRESOLVED (finalized), legacy ATTENDED or PENDING; excluded counts nowhere", () => {
  const considered = { considered: true };
  const o = (canonicalStatus, registerFinalized = false, eligibleLegacyVisit = false, scope = considered) =>
    rule.lectureOutcome({ scope, canonicalStatus, registerFinalized, eligibleLegacyVisit });
  assert.deepEqual(o("PRESENT"), { outcome: "ATTENDED", source: "CANONICAL" });
  assert.deepEqual(o("LATE"), { outcome: "ATTENDED", source: "CANONICAL" });
  assert.deepEqual(o("ABSENT"), { outcome: "MISSED", source: "CANONICAL" });
  assert.deepEqual(o("EXCUSED"), { outcome: "EXCUSED", source: "CANONICAL" });
  assert.deepEqual(o("ABSENT", false, true), { outcome: "MISSED", source: "CANONICAL" }, "a legacy visit never overrides a record");
  assert.deepEqual(o("ABSENT", true, true), { outcome: "MISSED", source: "CANONICAL" });
  assert.deepEqual(o(null, true, true), { outcome: "UNRESOLVED", source: null }, "finalized without a record: never inferred");
  assert.deepEqual(o(null, false, true), { outcome: "ATTENDED", source: "LEGACY_VISIT" });
  assert.deepEqual(o(null, false, false), { outcome: "PENDING", source: null });
  assert.deepEqual(o("PRESENT", false, true, { considered: false, reason: "CANCELLED" }), { outcome: "EXCLUDED", source: null });
  assert.throws(() => o("MAYBE"), RangeError);
});

test("percentage: attended / (attended + missed) × 100, half up to a whole number, exact; 0 without a denominator", () => {
  const p = rule.attendancePercentage;
  assert.equal(p(0, 0), 0);
  assert.equal(p(0, 5), 0);
  assert.equal(p(5, 0), 100);
  assert.equal(p(2, 1), 67, "66.67");
  assert.equal(p(1, 2), 33, "33.33");
  assert.equal(p(1, 7), 13, "12.5 rounds up");
  assert.equal(p(5, 3), 63, "62.5 rounds up");
  assert.equal(p(1, 199), 1, "0.5 rounds up");
  assert.equal(p(1, 200), 0, "0.497...");
  assert.equal(p(199, 1), 100, "99.5 rounds up");
  assert.equal(p(1999, 1), 100);
  assert.equal(p(29, 41), 41, "41.43");
  for (const [a, m] of [[-1, 0], [1.5, 1], [Number.NaN, 0]]) assert.throws(() => p(a, m), RangeError);
});

test("summary: PRESENT / LATE attended, ABSENT missed; EXCUSED, PENDING, UNRESOLVED outside the percentage; combine re-computes, never averages", () => {
  const A = { outcome: "ATTENDED", source: "CANONICAL" };
  const L = { outcome: "ATTENDED", source: "LEGACY_VISIT" };
  const M = { outcome: "MISSED", source: "CANONICAL" };
  const E = { outcome: "EXCUSED", source: "CANONICAL" };
  const P = { outcome: "PENDING", source: null };
  const U = { outcome: "UNRESOLVED", source: null };
  const X = { outcome: "EXCLUDED", source: null };
  const s = rule.summarizeAttendance([A, L, M, E, P, U, X, X]);
  assert.deepEqual(s, { eligibleLectures: 6, countedLectures: 3, attended: 2, missed: 1, excused: 1, pending: 1, unresolved: 1, excluded: 2, attendedFromLegacy: 1, percentage: 67 });
  assert.equal(rule.summarizeAttendance([A, M, P, P, U, U, E]).percentage, 50, "pending / unresolved / excused change nothing");
  const excusedOnly = rule.summarizeAttendance([E, E]);
  assert.deepEqual([excusedOnly.countedLectures, excusedOnly.percentage, excusedOnly.excused], [0, 0, 2]);
  assert.deepEqual(rule.summarizeAttendance([]), rule.EMPTY_ATTENDANCE_SUMMARY);
  const classA = rule.summarizeAttendance([A]);
  const classB = rule.summarizeAttendance([A, M, M]);
  const overall = rule.combineAttendanceSummaries([classA, classB]);
  assert.deepEqual([overall.attended, overall.missed, overall.percentage], [2, 2, 50], "2 of 4, not the average of 100 and 33");
});

// =========================================================================================
// 2. The service, over a fake Prisma
// =========================================================================================

const ENV = { APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z" };
const NOW = T("2026-10-01T00:00:00.000Z");
const APPROVED_AT = T("2026-08-01T00:00:00.000Z");
const T1 = "teacher-1";
const T2 = "teacher-2";
/** ClassStudent times hold Sri Lankan wall-clock digits. */
const local = (instant) => new Date(instant.getTime() + (5 * 60 + 30) * 60_000);

function createDb() {
  const data = { students: [], history: [], enrolments: [], classes: [], lectures: [], registers: [], records: [], visits: [], sessions: [] };
  const queries = [];
  const inOrEq = (cond, value) => (cond === undefined ? true : typeof cond === "object" && cond !== null && "in" in cond ? cond.in.includes(value) : cond === value);
  const classById = (id) => data.classes.find((c) => c.id === id);
  const pick = (row, select) => {
    const out = {};
    for (const [key, value] of Object.entries(select)) {
      if (value === true) out[key] = row[key];
    }
    return out;
  };
  const prisma = {
    student: {
      findUnique: async ({ where, select }) => {
        queries.push("student.findUnique");
        const s = data.students.find((x) => x.id === where.id);
        return s ? pick(s, select) : null;
      },
    },
    studentConfirmationHistory: {
      findMany: async ({ where, select }) => {
        queries.push("history.findMany");
        return data.history.filter((h) => inOrEq(where.studentId, h.studentId)).map((h) => pick(h, select));
      },
    },
    classStudent: {
      findMany: async ({ where, select }) => {
        queries.push("classStudent.findMany");
        return data.enrolments
          .filter((e) => inOrEq(where.studentId, e.studentId) && inOrEq(where.classId, e.classId))
          .filter((e) => {
            if (!where.class) return true;
            const c = classById(e.classId);
            return c && c.status === where.class.status && (where.class.teacherId === undefined || c.teacherId === where.class.teacherId);
          })
          .map((e) => ({
            ...pick(e, select),
            ...(select.class ? { class: pick(classById(e.classId), select.class.select) } : {}),
            ...(select.student ? { student: pick(data.students.find((s) => s.id === e.studentId), select.student.select) } : {}),
          }));
      },
    },
    class: {
      findFirst: async ({ where, select }) => {
        queries.push("class.findFirst");
        const c = data.classes.find((x) => x.id === where.id && x.teacherId === where.teacherId && x.status === where.status);
        return c ? pick(c, select) : null;
      },
    },
    lecture: {
      findMany: async ({ where, select }) => {
        queries.push("lecture.findMany");
        return data.lectures.filter((l) => inOrEq(where.classId, l.classId) && l.status === where.status).map((l) => pick(l, select));
      },
    },
    lectureAttendanceRegister: {
      findMany: async ({ where, select }) => {
        queries.push("register.findMany");
        return data.registers.filter((r) => inOrEq(where.lectureId, r.lectureId)).map((r) => pick(r, select));
      },
    },
    lectureAttendance: {
      findMany: async ({ where, select }) => {
        queries.push("record.findMany");
        return data.records.filter((r) => inOrEq(where.lectureId, r.lectureId) && inOrEq(where.studentId, r.studentId)).map((r) => pick(r, select));
      },
    },
    attendance: {
      findMany: async ({ where }) => {
        queries.push("visit.findMany");
        db.visitQueries.push(where);
        return data.visits
          .filter((v) => inOrEq(where.studentId, v.studentId))
          .map((v) => ({ studentId: v.studentId, joinedAt: v.joinedAt, classSession: { lectureId: data.sessions.find((s) => s.id === v.sessionId)?.lectureId ?? null } }))
          .filter((v) => v.classSession.lectureId !== null && inOrEq(where.classSession.lectureId, v.classSession.lectureId));
      },
    },
  };
  return { data, prisma, queries, visitQueries: [] };
}

function student(id, { teacherId = T1, status = 0, approvedAt = APPROVED_AT, broken = false } = {}) {
  // broken: confirmedAt disagrees with the history (approval UNKNOWN, as in the register tests).
  const confirmedAt = broken ? new Date(approvedAt.getTime() + 86_400_000) : approvedAt;
  db.data.students.push({ id, name: `Name ${id}`, status, teacherId, confirmationStatus: "APPROVED", confirmedAt, approvedAt });
  db.data.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: approvedAt, previousConfirmedAt: null });
}
function klass(id, { teacherId = T1, status = 0 } = {}) {
  db.data.classes.push({ id, name: `Class ${id}`, teacherId, status });
}
let enrolSeq = 0;
function enrol(studentId, classId, { from = T("2026-08-05T00:00:00Z"), to = null, isActive = to === null } = {}) {
  db.data.enrolments.push({ id: `e-${++enrolSeq}`, studentId, classId, assignedAt: local(from), removedAt: to ? local(to) : null, isActive });
}
let lectureSeq = 0;
/** A lecture (default: 1 Sep, held); returns its id. */
function lecture(classId, { id = `lec-${++lectureSeq}`, start = START, end = END, classStatus = "COMPLETED", status = 0 } = {}) {
  db.data.lectures.push({ id, classId, status, classStatus, date: start, endDate: end });
  db.data.sessions.push({ id: `sess-${id}`, lectureId: id });
  return id;
}
function register(lectureId, { finalized = false, start, end } = {}) {
  const l = db.data.lectures.find((x) => x.id === lectureId);
  db.data.registers.push({ lectureId, scheduledStartAt: start ?? l.date, scheduledEndAt: end === undefined ? l.endDate : end, finalizedAt: finalized ? T("2026-09-02T00:00:00Z") : null });
}
function record(lectureId, studentId, status, extra = {}) {
  if (!db.data.registers.some((r) => r.lectureId === lectureId)) register(lectureId);
  db.data.records.push({ lectureId, studentId, status, statusSource: "AUTO", pendingReviewSince: null, ...extra });
}
let visitSeq = 0;
function visit(lectureId, studentId, joinedAt) {
  db.data.visits.push({ id: `v-${++visitSeq}`, sessionId: `sess-${lectureId}`, studentId, joinedAt });
}

function reset() {
  db = createDb();
}

const forStudent = (studentId, extra = {}) => service.getStudentAttendancePercentages({ studentId, includeLectures: true, ...extra }, { now: NOW, env: ENV });
const outcomeOf = (result, lectureId) => result.lectures.find((l) => l.lectureId === lectureId);

test("canonical: PRESENT, LATE, ABSENT, EXCUSED, teacher override, BACKFILL, FINALIZATION ABSENT, pending review, QR-only, online-only, both channels", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const ids = {
    qrOnly: lecture("c1"),
    late: lecture("c1"),
    absentFinal: lecture("c1"),
    excused: lecture("c1"),
    teacherOverride: lecture("c1"),
    backfill: lecture("c1", { start: T("2026-08-10T04:00:00Z"), end: T("2026-08-10T06:00:00Z") }),
    review: lecture("c1"),
    onlineOnly: lecture("c1"),
    both: lecture("c1"),
  };
  record(ids.qrOnly, "s1", "PRESENT", { firstQrAt: START });
  record(ids.late, "s1", "LATE");
  register(ids.absentFinal, { finalized: true });
  record(ids.absentFinal, "s1", "ABSENT", { statusSource: "FINALIZATION" });
  record(ids.excused, "s1", "EXCUSED", { statusSource: "TEACHER" });
  record(ids.teacherOverride, "s1", "ABSENT", { statusSource: "TEACHER", autoStatus: "PRESENT" });
  record(ids.backfill, "s1", "PRESENT", { statusSource: "BACKFILL" });
  record(ids.review, "s1", "ABSENT", { statusSource: "TEACHER", pendingReviewSince: START, autoStatus: "PRESENT" });
  record(ids.onlineOnly, "s1", "PRESENT", { firstOnlineAt: START });
  record(ids.both, "s1", "PRESENT", { firstOnlineAt: START, firstQrAt: END });
  visit(ids.both, "s1", START); // a legacy visit as well: never added on top
  visit(ids.both, "s1", END);
  visit(ids.teacherOverride, "s1", START); // the visit never undoes the teacher's ABSENT

  const r = await forStudent("s1");
  const expect = {
    qrOnly: "ATTENDED", late: "ATTENDED", absentFinal: "MISSED", excused: "EXCUSED", teacherOverride: "MISSED",
    backfill: "ATTENDED", review: "MISSED", onlineOnly: "ATTENDED", both: "ATTENDED",
  };
  for (const [name, outcome] of Object.entries(expect)) {
    assert.deepEqual([outcomeOf(r, ids[name]).outcome, outcomeOf(r, ids[name]).source], [outcome, "CANONICAL"], name);
  }
  assert.deepEqual(
    pickCounts(r.overall),
    { eligibleLectures: 9, countedLectures: 8, attended: 5, missed: 3, excused: 1, pending: 0, unresolved: 0, excluded: 0, attendedFromLegacy: 0, percentage: 63 }
  );
  assert.equal(db.queries.filter((q) => q === "visit.findMany").length, 0, "no legacy read at all when every lecture has a record");
});

const pickCounts = (s) => ({ ...s });

test("legacy fallback: eligible visit (once, however many visits) → attended; none → pending; finalized without record → unresolved; ineligible visits ignored", async () => {
  reset();
  student("s1");
  student("late-approved", { approvedAt: T("2026-09-15T00:00:00Z") });
  klass("c1");
  enrol("s1", "c1");
  enrol("late-approved", "c1");
  const visited = lecture("c1"); // no register at all
  const openRegister = lecture("c1");
  register(openRegister);
  const nothing = lecture("c1");
  const finalizedMissing = lecture("c1");
  register(finalizedMissing, { finalized: true });
  const historical = lecture("c1", { start: T("2026-08-06T04:00:00Z"), end: T("2026-08-06T06:00:00Z") });
  visit(visited, "s1", T("2026-09-01T12:31:00Z"));
  visit(visited, "s1", T("2026-09-01T12:50:00Z"));
  visit(visited, "s1", T("2026-09-01T13:20:00Z"));
  visit(openRegister, "s1", T("2026-09-01T12:35:00Z"));
  visit(finalizedMissing, "s1", T("2026-09-01T12:35:00Z"));
  visit(historical, "s1", T("2026-08-06T04:05:00Z"));
  for (const id of [visited, openRegister, nothing, finalizedMissing]) visit(id, "late-approved", T("2026-09-01T12:40:00Z"));

  const r = await forStudent("s1");
  assert.deepEqual([outcomeOf(r, visited).outcome, outcomeOf(r, visited).source], ["ATTENDED", "LEGACY_VISIT"]);
  assert.deepEqual([outcomeOf(r, openRegister).outcome, outcomeOf(r, openRegister).source], ["ATTENDED", "LEGACY_VISIT"]);
  assert.equal(outcomeOf(r, nothing).outcome, "PENDING");
  assert.equal(outcomeOf(r, finalizedMissing).outcome, "UNRESOLVED");
  assert.deepEqual([outcomeOf(r, historical).outcome, outcomeOf(r, historical).source], ["ATTENDED", "LEGACY_VISIT"], "a historical lecture without a record: the eligible visit");
  assert.deepEqual([r.overall.attended, r.overall.attendedFromLegacy, r.overall.pending, r.overall.unresolved, r.overall.countedLectures, r.overall.percentage], [3, 3, 1, 1, 3, 100]);
  assert.equal(db.visitQueries.length, 1, "one legacy read");
  assert.deepEqual(db.visitQueries[0].classSession.lectureId.in.sort(), [visited, openRegister, nothing, historical].sort(), "never for the finalized register");

  // Not approved at the visit time (approved on 15 Sep): the visits do not count.
  const late = await forStudent("late-approved");
  for (const id of [visited, openRegister, nothing]) assert.equal(outcomeOf(late, id).outcome, "PENDING", id);
  assert.equal(outcomeOf(late, finalizedMissing).outcome, "UNRESOLVED");
  assert.equal(late.overall.attended, 0);
});

test("legacy fallback: a visit before the enrolment, by an inactive student, with UNKNOWN approval, or by another teacher's student never counts", async () => {
  reset();
  student("s-unknown", { broken: true });
  student("s-inactive", { status: 1 });
  student("s-foreign", { teacherId: T2 });
  student("s-early");
  klass("c1");
  enrol("s-unknown", "c1");
  enrol("s-inactive", "c1");
  enrol("s-foreign", "c1");
  enrol("s-early", "c1", { from: T("2026-09-01T13:00:00Z") }); // enrolled 30 min after the start
  const l1 = lecture("c1");
  for (const s of ["s-unknown", "s-inactive", "s-foreign"]) visit(l1, s, T("2026-09-01T12:35:00Z"));
  for (const s of ["s-unknown", "s-inactive", "s-foreign"]) assert.equal(outcomeOf(await forStudent(s), l1).outcome, "PENDING", s);
  const early = await forStudent("s-early");
  assert.deepEqual([outcomeOf(early, l1).outcome, outcomeOf(early, l1).excludedBecause], ["EXCLUDED", "NOT_ENROLLED"], "not enrolled at the scheduled start");
});

test("denominator: future, in progress, cancelled, deleted, deleted class, before enrolment, after removal; removal boundary; completed without end", async () => {
  reset();
  student("s1");
  klass("c1");
  klass("c-deleted", { status: 1 });
  enrol("s1", "c1", { from: T("2026-08-05T00:00:00Z"), to: T("2026-09-10T12:00:00Z") });
  enrol("s1", "c1", { from: T("2026-09-20T00:00:00Z") }); // re-enrolled: a gap from 10 Sep 12:00 to 20 Sep
  enrol("s1", "c-deleted");
  const ids = {
    held: lecture("c1"),
    future: lecture("c1", { start: T("2026-10-05T12:30:00Z"), end: T("2026-10-05T14:30:00Z"), classStatus: "SCHEDULED" }),
    inProgress: lecture("c1", { start: T("2026-09-30T23:00:00Z"), end: T("2026-10-01T01:00:00Z"), classStatus: "LIVE" }),
    cancelled: lecture("c1", { classStatus: "CANCELLED" }),
    deleted: lecture("c1", { status: 1 }),
    beforeEnrolment: lecture("c1", { start: T("2026-08-01T12:30:00Z"), end: T("2026-08-01T14:30:00Z") }),
    atRemoval: lecture("c1", { start: T("2026-09-10T12:00:00Z"), end: T("2026-09-10T14:00:00Z") }),
    justBeforeRemoval: lecture("c1", { start: T("2026-09-10T11:59:59.999Z"), end: T("2026-09-10T14:00:00Z") }),
    inGap: lecture("c1", { start: T("2026-09-15T12:30:00Z"), end: T("2026-09-15T14:30:00Z") }),
    afterReEnrol: lecture("c1", { start: T("2026-09-25T12:30:00Z"), end: T("2026-09-25T14:30:00Z") }),
    noEndCompleted: lecture("c1", { start: T("2026-09-26T12:30:00Z"), end: null, classStatus: "COMPLETED" }),
    noEndOpen: lecture("c1", { start: T("2026-09-27T12:30:00Z"), end: null, classStatus: "LIVE" }),
    inDeletedClass: lecture("c-deleted"),
  };
  for (const id of Object.values(ids)) record(id, "s1", "PRESENT"); // a record everywhere: scope still decides

  const r = await forStudent("s1");
  const excluded = (name) => outcomeOf(r, ids[name])?.excludedBecause ?? "NOT_LOADED";
  assert.equal(outcomeOf(r, ids.held).outcome, "ATTENDED");
  assert.equal(excluded("future"), "NOT_HELD");
  assert.equal(excluded("inProgress"), "NOT_HELD");
  assert.equal(excluded("cancelled"), "CANCELLED");
  assert.equal(excluded("deleted"), "NOT_LOADED", "deleted lectures are never read");
  assert.equal(excluded("inDeletedClass"), "NOT_LOADED", "a deleted class is never read");
  assert.equal(excluded("beforeEnrolment"), "NOT_ENROLLED");
  assert.equal(excluded("atRemoval"), "NOT_ENROLLED", "[assignedAt, removedAt): not enrolled at the removal instant");
  assert.equal(outcomeOf(r, ids.justBeforeRemoval).outcome, "ATTENDED", "enrolled one millisecond before the removal");
  assert.equal(excluded("inGap"), "NOT_ENROLLED");
  assert.equal(outcomeOf(r, ids.afterReEnrol).outcome, "ATTENDED");
  assert.equal(outcomeOf(r, ids.noEndCompleted).outcome, "ATTENDED", "no end time but COMPLETED: held");
  assert.equal(excluded("noEndOpen"), "NOT_HELD");
  assert.deepEqual([r.overall.attended, r.overall.excluded, r.overall.percentage], [4, 7, 100]);
  assert.deepEqual(r.classes.map((c) => [c.classId, c.currentlyEnrolled]), [["c1", true]], "the deleted class is left out");
});

test("the register's schedule decides (a frozen or synced start), not the lecture's", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1", { from: T("2026-09-01T13:00:00Z") });
  const moved = lecture("c1"); // lecture says 12:30 (before the enrolment); the register says 13:30
  register(moved, { start: T("2026-09-01T13:30:00Z"), end: T("2026-09-01T15:30:00Z") });
  record(moved, "s1", "LATE");
  const r = await forStudent("s1");
  assert.equal(outcomeOf(r, moved).outcome, "ATTENDED");
});

test("zero eligible lectures, EXCUSED only, and no classes all give 0%", async () => {
  reset();
  student("s1");
  student("s2");
  student("s3");
  klass("c1");
  enrol("s1", "c1");
  enrol("s2", "c1");
  const only = lecture("c1");
  record(only, "s2", "EXCUSED", { statusSource: "TEACHER" });
  lecture("c1", { start: T("2026-12-01T12:30:00Z"), end: T("2026-12-01T14:30:00Z"), classStatus: "SCHEDULED" });

  const none = await forStudent("s1");
  assert.deepEqual([none.overall.percentage, none.overall.countedLectures, none.overall.pending], [0, 0, 1]);
  const excused = await forStudent("s2");
  assert.deepEqual([excused.overall.percentage, excused.overall.excused, excused.overall.countedLectures], [0, 1, 0]);
  const noClasses = await forStudent("s3");
  assert.deepEqual([noClasses.classes, noClasses.overall.percentage, noClasses.lectures], [[], 0, []]);
});

test("per class and overall; teacherId restricts to that teacher's classes and students", async () => {
  reset();
  student("s1");
  klass("c1");
  klass("c2");
  klass("c-other", { teacherId: T2 });
  enrol("s1", "c1");
  enrol("s1", "c2", { from: T("2026-08-05T00:00:00Z"), to: T("2026-09-20T00:00:00Z") });
  enrol("s1", "c-other");
  record(lecture("c1"), "s1", "PRESENT");
  record(lecture("c2"), "s1", "ABSENT");
  record(lecture("c2"), "s1", "ABSENT");
  record(lecture("c-other"), "s1", "PRESENT");

  const all = await forStudent("s1");
  assert.deepEqual(all.classes.map((c) => [c.classId, c.summary.percentage, c.currentlyEnrolled]), [["c-other", 100, true], ["c1", 100, true], ["c2", 0, false]], "ordered by class name");
  assert.deepEqual([all.overall.attended, all.overall.missed, all.overall.percentage], [2, 2, 50]);

  const mine = await forStudent("s1", { teacherId: T1 });
  assert.deepEqual(mine.classes.map((c) => c.classId), ["c1", "c2"]);
  assert.deepEqual([mine.overall.attended, mine.overall.missed, mine.overall.percentage], [1, 2, 33]);
  await assert.rejects(forStudent("s1", { teacherId: T2 }), (e) => e.code === "STUDENT_NOT_FOUND", "another teacher's student");
  await assert.rejects(forStudent("nobody"), (e) => e.code === "STUDENT_NOT_FOUND" && e.statusCode === 404);
  await assert.rejects(forStudent(""), (e) => e.code === "VALIDATION_ERROR");
});

test("class for the teacher: roster (active, not deleted), ownership 404, per-student summaries", async () => {
  reset();
  for (const id of ["s1", "s2", "s-removed", "s-deleted"]) student(id, { status: id === "s-deleted" ? 1 : 0 });
  klass("c1");
  klass("c-other", { teacherId: T2 });
  enrol("s1", "c1");
  enrol("s2", "c1");
  enrol("s-removed", "c1", { to: T("2026-09-20T00:00:00Z") });
  enrol("s-deleted", "c1");
  const l1 = lecture("c1");
  const l2 = lecture("c1");
  record(l1, "s1", "PRESENT");
  record(l2, "s1", "LATE");
  record(l1, "s2", "ABSENT");
  visit(l2, "s2", T("2026-09-01T12:40:00Z")); // fallback for s2 on l2

  const result = await service.getClassAttendancePercentagesForTeacher({ teacherId: T1, classId: "c1" }, { now: NOW, env: ENV });
  assert.deepEqual(result.students.map((s) => [s.studentId, s.summary.attended, s.summary.missed, s.summary.percentage]), [["s1", 2, 0, 100], ["s2", 1, 1, 50]]);
  assert.equal(result.students[1].summary.attendedFromLegacy, 1);
  await assert.rejects(service.getClassAttendancePercentagesForTeacher({ teacherId: T1, classId: "c-other" }, { now: NOW, env: ENV }), (e) => e.code === "CLASS_NOT_FOUND" && e.statusCode === 404);
  await assert.rejects(service.getClassAttendancePercentagesForTeacher({ teacherId: T1, classId: "missing" }, { now: NOW, env: ENV }), (e) => e.code === "CLASS_NOT_FOUND");
});

test("configuration: without APPROVAL_FEATURE_STARTED_AT it fails closed (503) before any read", async () => {
  reset();
  student("s1");
  await assert.rejects(service.getStudentAttendancePercentages({ studentId: "s1" }, { now: NOW, env: {} }), (e) => e.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED" && e.statusCode === 503);
  await assert.rejects(service.getClassAttendancePercentagesForTeacher({ teacherId: T1, classId: "c1" }, { now: NOW, env: { APPROVAL_FEATURE_STARTED_AT: "nope" } }), (e) => e.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED");
  assert.deepEqual(db.queries, []);
});

// =========================================================================================
// 3. Query efficiency
// =========================================================================================

function bigDataset({ classes, lecturesPerClass, students }) {
  reset();
  for (let c = 0; c < classes; c += 1) klass(`c${c}`);
  for (let s = 0; s < students; s += 1) {
    student(`s${s}`);
    for (let c = 0; c < classes; c += 1) enrol(`s${s}`, `c${c}`);
  }
  for (let c = 0; c < classes; c += 1) {
    for (let l = 0; l < lecturesPerClass; l += 1) {
      const id = lecture(`c${c}`, { start: new Date(START.getTime() + l * 86_400_000), end: new Date(END.getTime() + l * 86_400_000) });
      for (let s = 0; s < students; s += 1) {
        if ((s + l) % 3 === 0) record(id, `s${s}`, "PRESENT");
        else if ((s + l) % 3 === 1) visit(id, `s${s}`, new Date(START.getTime() + l * 86_400_000 + 60_000));
      }
    }
  }
}

test("queries: a fixed number per call (7 at most), independent of classes, lectures and students; no N+1", async () => {
  const counts = [];
  // Both sizes include pairs that need the legacy fallback (otherwise that one read is skipped: 6 queries).
  for (const size of [{ classes: 1, lecturesPerClass: 2, students: 2 }, { classes: 6, lecturesPerClass: 12, students: 25 }]) {
    bigDataset(size);
    await service.getStudentAttendancePercentages({ studentId: "s0" }, { now: NOW, env: ENV });
    const studentQueries = db.queries.length;
    db.queries.length = 0;
    await service.getClassAttendancePercentagesForTeacher({ teacherId: T1, classId: "c0" }, { now: NOW, env: ENV });
    counts.push([studentQueries, db.queries.length]);
  }
  assert.deepEqual(counts[0], counts[1], "the same number of queries for 1 and for 6 classes × 12 lectures × 25 students");
  assert.deepEqual(counts[1], [7, 7], JSON.stringify(counts));
  bigDataset({ classes: 6, lecturesPerClass: 12, students: 25 });
  const r = await service.getClassAttendancePercentagesForTeacher({ teacherId: T1, classId: "c0" }, { now: NOW, env: ENV });
  assert.equal(r.students.length, 25);
  for (const s of r.students) assert.equal(s.summary.eligibleLectures, 12);
  assert.deepEqual(new Set(db.queries).size, db.queries.length, "each read once");
});

// =========================================================================================
// 4. Regression protection: no consumer uses the service; the rule is the only formula
// =========================================================================================

test("no existing consumer imports the new service or rule in this stage", () => {
  const consumers = [
    "services/student-service.ts",
    "app/api/student/dashboard/performance/route.ts",
    "services/student-dashboard-counts-service.ts",
    "app/api/student/lectures/route.ts",
    "services/guardian-portal-service.ts",
    "app/api/classes/[id]/attendance-summary/route.ts",
    "components/Jitsi/classroom/sidebar/AttendancePanel.tsx",
    "components/guardian/GuardianPortal.tsx",
  ];
  for (const file of consumers) {
    const code = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(code, /attendance-percentage-service|lib\/attendance\/percentage/, file);
  }
  const serviceCode = fs.readFileSync(path.join(root, "services", "attendance-percentage-service.ts"), "utf8");
  assert.doesNotMatch(serviceCode, /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|\$transaction|\$queryRaw|\$executeRaw/, "read only");
  assert.doesNotMatch(serviceCode, /Math\.round|toFixed|\* 100/, "the percentage formula lives only in lib/attendance/percentage.ts");
  assert.doesNotMatch(serviceCode, /firstOnlineAt|firstQrAt|autoStatus|attendanceScanEvent|AuditLog/, "no evidence column or event is used as attendance");
});
