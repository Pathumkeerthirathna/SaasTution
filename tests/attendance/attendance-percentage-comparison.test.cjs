/*
 * Stage 5.7b-3i: attendance percentage comparison mode
 * (services/attendance-percentage-comparison.ts). The REAL legacy functions
 * (services/student-service.ts, unchanged) and the REAL new service run over
 * one fake Prisma that answers both (and records every call, so writes and
 * query counts are visible). No database. Internal only: no route, page or
 * consumer uses the comparison (guarded below).
 *
 *   node --test tests/attendance/attendance-percentage-comparison.test.cjs   (part of npm run test:attendance)
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
function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
fake("lib/prisma.ts", { prisma: new Proxy({}, { get: (_, key) => db.prisma[key] }) });

const comparison = require(path.join(root, "services", "attendance-percentage-comparison.ts"));
const studentService = require(path.join(root, "services", "student-service.ts"));

const T = (iso) => new Date(iso);
const ENV = { APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z", ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z" };
const NOW = T("2026-10-01T00:00:00.000Z");
const APPROVED_AT = T("2026-08-01T00:00:00.000Z");
const T1 = "teacher-1";
const T2 = "teacher-2";
const local = (instant) => new Date(instant.getTime() + (5 * 60 + 30) * 60_000);

// ---- One fake Prisma for the legacy and the new calculation ----------------------------------

function createDb() {
  const data = { students: [], history: [], enrolments: [], classes: [], lectures: [], registers: [], records: [], visits: [], sessions: [] };
  const calls = [];
  const inOrEq = (cond, value) => (cond === undefined ? true : cond !== null && typeof cond === "object" && "in" in cond ? cond.in.includes(value) : cond === value);
  const pick = (row, select) => {
    if (!select) return { ...row };
    const out = {};
    for (const [key, value] of Object.entries(select)) if (value === true) out[key] = row[key];
    return out;
  };
  const classOf = (id) => data.classes.find((c) => c.id === id);
  const studentOf = (id) => data.students.find((s) => s.id === id);
  const sessionsOf = (lectureId) => data.sessions.filter((s) => s.lectureId === lectureId);
  const visitsOf = (sessionId) => data.visits.filter((v) => v.sessionId === sessionId);
  const lectureMatches = (l, where) => {
    if (!inOrEq(where.classId, l.classId) || (where.status !== undefined && l.status !== where.status)) return false;
    if (where.sessions?.some?.attendance?.some?.studentId) {
      const sid = where.sessions.some.attendance.some.studentId;
      return sessionsOf(l.id).some((s) => visitsOf(s.id).some((v) => v.studentId === sid));
    }
    return true;
  };
  const record = (name) => (fn) => async (args = {}) => {
    calls.push(name);
    return fn(args);
  };
  const forbidden = (name) => async () => {
    calls.push(name);
    throw new Error(`write attempted: ${name}`);
  };
  const writes = {};
  for (const op of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) writes[op] = forbidden(op);

  const prisma = {
    student: {
      ...writes,
      findUnique: record("student.findUnique")(({ where, select }) => {
        const s = studentOf(where.id);
        return s ? pick(s, select) : null;
      }),
    },
    studentConfirmationHistory: {
      ...writes,
      findMany: record("history.findMany")(({ where, select }) => data.history.filter((h) => inOrEq(where.studentId, h.studentId)).map((h) => pick(h, select))),
    },
    class: {
      ...writes,
      findFirst: record("class.findFirst")(({ where, select }) => {
        const c = data.classes.find((x) => x.id === where.id && x.teacherId === where.teacherId && x.status === where.status);
        return c ? pick(c, select) : null;
      }),
    },
    classStudent: {
      ...writes,
      findMany: record("classStudent.findMany")(({ where, select }) =>
        data.enrolments
          .filter((e) => inOrEq(where.studentId, e.studentId) && inOrEq(where.classId, e.classId))
          .filter((e) => where.isActive === undefined || e.isActive === where.isActive)
          .filter((e) => !where.student || studentOf(e.studentId).status === where.student.status)
          .filter((e) => {
            if (!where.class) return true;
            const c = classOf(e.classId);
            return c.status === where.class.status && (where.class.teacherId === undefined || c.teacherId === where.class.teacherId);
          })
          .map((e) => ({
            ...pick(e, select),
            ...(select.class ? { class: pick(classOf(e.classId), select.class.select) } : {}),
            ...(select.student ? { student: pick(studentOf(e.studentId), select.student.select) } : {}),
          }))
      ),
    },
    lecture: {
      ...writes,
      findMany: record("lecture.findMany")(({ where, select }) =>
        data.lectures
          .filter((l) => lectureMatches(l, where))
          .map((l) => ({
            ...pick(l, select),
            ...(select.sessions
              ? {
                  sessions: sessionsOf(l.id).map((s) => ({
                    attendance: visitsOf(s.id)
                      .filter((v) => !select.sessions.select.attendance.where || v.studentId === select.sessions.select.attendance.where.studentId)
                      .map((v) => ({ studentId: v.studentId, id: v.id })),
                  })),
                }
              : {}),
          }))
      ),
      count: record("lecture.count")(({ where }) => data.lectures.filter((l) => lectureMatches(l, where)).length),
    },
    lectureAttendanceRegister: {
      ...writes,
      findMany: record("register.findMany")(({ where, select }) => data.registers.filter((r) => inOrEq(where.lectureId, r.lectureId)).map((r) => pick(r, select))),
    },
    lectureAttendance: {
      ...writes,
      findMany: record("record.findMany")(({ where, select }) => data.records.filter((r) => inOrEq(where.lectureId, r.lectureId) && inOrEq(where.studentId, r.studentId)).map((r) => pick(r, select))),
    },
    attendance: {
      ...writes,
      findMany: record("visit.findMany")(({ where }) =>
        data.visits
          .filter((v) => !v.hiddenFromFlatReads)
          .filter((v) => inOrEq(where.studentId, v.studentId))
          .map((v) => ({ studentId: v.studentId, joinedAt: v.joinedAt, classSession: { lectureId: data.sessions.find((s) => s.id === v.sessionId).lectureId } }))
          .filter((v) => inOrEq(where.classSession.lectureId, v.classSession.lectureId))
      ),
    },
    $transaction: forbidden("$transaction"),
    $executeRaw: forbidden("$executeRaw"),
    $queryRaw: forbidden("$queryRaw"),
  };
  return { data, prisma, calls };
}

// ---- Fixtures ---------------------------------------------------------------------------------

function reset() {
  db = createDb();
}
function student(id, { teacherId = T1, status = 0, approvedAt = APPROVED_AT } = {}) {
  db.data.students.push({ id, name: `Name ${id}`, status, teacherId, confirmationStatus: "APPROVED", confirmedAt: approvedAt, approvedAt });
  db.data.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: approvedAt, previousConfirmedAt: null });
}
function klass(id, { teacherId = T1 } = {}) {
  db.data.classes.push({ id, name: `Class ${id}`, teacherId, status: 0 });
}
let seq = 0;
function enrol(studentId, classId, { from = T("2026-08-05T00:00:00Z"), to = null } = {}) {
  db.data.enrolments.push({ id: `e-${++seq}`, studentId, classId, assignedAt: local(from), removedAt: to ? local(to) : null, isActive: to === null });
}
function lecture(classId, { start = T("2026-09-01T12:30:00Z"), end = T("2026-09-01T14:30:00Z"), classStatus = "COMPLETED" } = {}) {
  const id = `lec-${++seq}`;
  db.data.lectures.push({ id, classId, status: 0, classStatus, date: start, endDate: end });
  db.data.sessions.push({ id: `sess-${id}`, lectureId: id, classId });
  return id;
}
function register(lectureId, { finalized = false } = {}) {
  const l = db.data.lectures.find((x) => x.id === lectureId);
  if (db.data.registers.some((r) => r.lectureId === lectureId)) {
    if (finalized) db.data.registers.find((r) => r.lectureId === lectureId).finalizedAt = T("2026-09-02T00:00:00Z");
    return;
  }
  db.data.registers.push({ lectureId, scheduledStartAt: l.date, scheduledEndAt: l.endDate, finalizedAt: finalized ? T("2026-09-02T00:00:00Z") : null });
}
function rec(lectureId, studentId, status, { statusSource = "AUTO", online = false, qr = false } = {}) {
  register(lectureId);
  const l = db.data.lectures.find((x) => x.id === lectureId);
  db.data.records.push({ lectureId, studentId, status, statusSource, firstOnlineAt: online ? l.date : null, firstQrAt: qr ? l.date : null });
}
function visit(lectureId, studentId, joinedAt) {
  const l = db.data.lectures.find((x) => x.id === lectureId);
  db.data.visits.push({ id: `v-${++seq}`, sessionId: `sess-${lectureId}`, studentId, joinedAt: joinedAt ?? new Date(l.date.getTime() + 60_000) });
}

const compareClass = (classId = "c1", teacherId = T1) => comparison.compareClassAttendanceForTeacher({ teacherId, classId }, { now: NOW, env: ENV });
const compareStudent = (studentId, teacherId = T1) => comparison.compareStudentAttendanceForTeacher({ teacherId, studentId }, { now: NOW, env: ENV });
const rowOf = (result, studentId) => result.rows.find((r) => r.studentId === studentId);

// ======================================================================================
// Scenarios
// ======================================================================================

test("identical: online attendance recorded canonically and in the legacy table gives the same counts and percentage", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const a = lecture("c1");
  const b = lecture("c1");
  rec(a, "s1", "PRESENT", { online: true });
  visit(a, "s1");
  rec(b, "s1", "ABSENT", { statusSource: "FINALIZATION" });
  register(b, { finalized: true });
  const r = rowOf(await compareClass(), "s1");
  assert.deepEqual(r.legacy, { attended: 1, total: 2, percentage: 50 });
  assert.deepEqual(r.current, { attended: 1, missed: 1, excused: 0, pending: 0, unresolved: 0, eligibleLectures: 2, countedLectures: 2, percentage: 50 });
  assert.deepEqual([r.kind, r.percentageDifference, r.reasons], ["IDENTICAL", 0, {}]);
});

test("QR-only attendance: missed in legacy, attended now (QR_ONLY_ATTENDANCE); online + QR counts once", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const qrOnly = lecture("c1");
  const both = lecture("c1");
  rec(qrOnly, "s1", "PRESENT", { qr: true });
  rec(both, "s1", "LATE", { online: true, qr: true });
  visit(both, "s1");
  visit(both, "s1"); // two visits, one lecture
  const r = rowOf(await compareClass(), "s1");
  assert.deepEqual([r.legacy.attended, r.legacy.total, r.legacy.percentage], [1, 2, 50]);
  assert.deepEqual([r.current.attended, r.current.countedLectures, r.current.percentage], [2, 2, 100]);
  assert.deepEqual(r.reasons, { QR_ONLY_ATTENDANCE: 1 }, "the online + QR lecture contributes identically (once)");
  assert.deepEqual([r.kind, r.percentageDifference], ["COUNTS_DIFFER", 50]);
});

test("teacher decisions, EXCUSED and finalization ABSENT are attributed from the record (only where they change the contribution)", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const absentDespiteVisit = lecture("c1");
  const presentWithoutVisit = lecture("c1");
  const excused = lecture("c1");
  const finalAbsentWithVisit = lecture("c1");
  const teacherAgrees = lecture("c1");
  rec(absentDespiteVisit, "s1", "ABSENT", { statusSource: "TEACHER" });
  visit(absentDespiteVisit, "s1");
  rec(presentWithoutVisit, "s1", "PRESENT", { statusSource: "TEACHER" });
  rec(excused, "s1", "EXCUSED", { statusSource: "TEACHER" });
  rec(finalAbsentWithVisit, "s1", "ABSENT", { statusSource: "FINALIZATION" });
  register(finalAbsentWithVisit, { finalized: true });
  visit(finalAbsentWithVisit, "s1", T("2026-08-02T00:00:00Z")); // a stray visit outside the lecture time
  rec(teacherAgrees, "s1", "PRESENT", { statusSource: "TEACHER" });
  visit(teacherAgrees, "s1");
  const r = rowOf(await compareClass(), "s1");
  assert.deepEqual(r.reasons, { TEACHER_DECISION: 2, EXCUSED: 1, FINALIZATION_ABSENT: 1 }, "the agreeing teacher decision is not a difference");
  assert.deepEqual([r.legacy.attended, r.legacy.total], [3, 5]);
  assert.deepEqual([r.current.attended, r.current.missed, r.current.excused, r.current.countedLectures, r.current.percentage], [2, 2, 1, 4, 50]);
});

test("pending (no record, open register) and unresolved (finalized, no record) leave the denominator; a historical gap is told apart", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  lecture("c1"); // pending: no register, no visit
  const unresolved = lecture("c1");
  register(unresolved, { finalized: true });
  lecture("c1", { start: T("2026-08-10T04:00:00Z"), end: T("2026-08-10T06:00:00Z") }); // historical gap: no record, no visit
  const historicalFallback = lecture("c1", { start: T("2026-08-11T04:00:00Z"), end: T("2026-08-11T06:00:00Z") });
  visit(historicalFallback, "s1");
  const r = rowOf(await compareClass(), "s1");
  assert.deepEqual(r.reasons, { PENDING_NOT_FINALIZED: 1, UNRESOLVED_FINALIZED: 1, HISTORICAL_BACKFILL_GAP: 1 }, "the historical lecture with an eligible visit is the same in both (legacy fallback)");
  assert.deepEqual([r.current.pending, r.current.unresolved, r.current.attended, r.current.countedLectures, r.current.percentage], [2, 1, 1, 1, 100]);
  assert.deepEqual([r.legacy.attended, r.legacy.total, r.legacy.percentage], [1, 4, 25]);
});

test("ineligible visits (before approval) count in legacy, not now: INELIGIBLE_VISIT", async () => {
  reset();
  student("late", { approvedAt: T("2026-09-15T00:00:00Z") });
  klass("c1");
  enrol("late", "c1");
  const l1 = lecture("c1");
  visit(l1, "late");
  const r = rowOf(await compareClass(), "late");
  assert.deepEqual(r.reasons, { INELIGIBLE_VISIT: 1 });
  assert.deepEqual([r.legacy.percentage, r.current.percentage, r.current.pending], [100, 0, 1]);
});

test("cancelled, future and in-progress lectures and enrolment boundaries: counted by legacy, excluded now", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1", { from: T("2026-08-20T00:00:00Z") });
  const held = lecture("c1");
  rec(held, "s1", "PRESENT", { online: true });
  visit(held, "s1");
  const cancelledWithVisit = lecture("c1", { classStatus: "CANCELLED" });
  visit(cancelledWithVisit, "s1");
  lecture("c1", { start: T("2026-10-05T12:30:00Z"), end: T("2026-10-05T14:30:00Z"), classStatus: "SCHEDULED" });
  lecture("c1", { start: T("2026-09-30T23:00:00Z"), end: T("2026-10-01T01:00:00Z"), classStatus: "LIVE" });
  lecture("c1", { start: T("2026-08-18T12:30:00Z"), end: T("2026-08-18T14:30:00Z") }); // before the enrolment
  const r = rowOf(await compareClass(), "s1");
  assert.deepEqual(r.reasons, { CANCELLED_LECTURE: 1, FUTURE_LECTURE: 1, LECTURE_NOT_HELD: 1, ENROLMENT_BOUNDARY: 1 });
  assert.deepEqual([r.legacy.attended, r.legacy.total, r.legacy.percentage], [2, 5, 40]);
  assert.deepEqual([r.current.attended, r.current.countedLectures, r.current.percentage], [1, 1, 100]);
});

test("rounding only: identical counts, different rounding (the profile's two decimals vs whole number half up)", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  for (let i = 0; i < 3; i += 1) {
    const id = lecture("c1", { start: new Date(T("2026-09-01T12:30:00Z").getTime() + i * 86_400_000), end: new Date(T("2026-09-01T14:30:00Z").getTime() + i * 86_400_000) });
    if (i < 2) {
      rec(id, "s1", "PRESENT", { online: true });
      visit(id, "s1");
    } else {
      rec(id, "s1", "ABSENT", { statusSource: "FINALIZATION" });
      register(id, { finalized: true });
    }
  }
  const s = await compareStudent("s1");
  assert.deepEqual(s.rows[0].legacy, { attended: 2, total: 3, percentage: 66.67 });
  assert.deepEqual([s.rows[0].current.percentage, s.rows[0].kind, s.rows[0].percentageDifference, s.rows[0].reasons], [67, "ROUNDING_ONLY", 0.33, {}]);
  const c = rowOf(await compareClass(), "s1");
  assert.deepEqual([c.legacy.percentage, c.current.percentage, c.kind], [67, 67, "IDENTICAL"], "the class summary already rounds to whole numbers");
});

test("multiple classes and students: one row per rostered student; the student comparison covers the teacher's classes only", async () => {
  reset();
  for (const id of ["s1", "s2", "s3"]) student(id);
  student("s-removed");
  klass("c1");
  klass("c2");
  klass("c-other", { teacherId: T2 });
  for (const id of ["s1", "s2", "s3"]) enrol(id, "c1");
  enrol("s1", "c2");
  enrol("s1", "c-other");
  enrol("s-removed", "c1", { to: T("2026-09-20T00:00:00Z") });
  const c1a = lecture("c1");
  const c1b = lecture("c1");
  const c2a = lecture("c2");
  const other = lecture("c-other");
  rec(c1a, "s1", "PRESENT", { qr: true });
  visit(c1b, "s2");
  rec(c2a, "s1", "EXCUSED", { statusSource: "TEACHER" });
  rec(other, "s1", "PRESENT", { qr: true });

  const cls = await compareClass("c1");
  assert.deepEqual(cls.rows.map((r) => r.studentId), ["s1", "s2", "s3"], "the active roster only (no removed student)");
  assert.deepEqual(rowOf(cls, "s1").reasons, { QR_ONLY_ATTENDANCE: 1, PENDING_NOT_FINALIZED: 1 });
  assert.deepEqual(rowOf(cls, "s2").reasons, { PENDING_NOT_FINALIZED: 1 });
  assert.deepEqual(rowOf(cls, "s3").reasons, { PENDING_NOT_FINALIZED: 2 });

  const st = await compareStudent("s1");
  assert.deepEqual(st.rows.map((r) => r.classId), ["c1", "c2"], "never another teacher's class");
  assert.deepEqual(st.classesOnlyInNew, []);
  assert.deepEqual(st.rows[1].reasons, { EXCUSED: 1 });
  const summary = comparison.summarizeComparisons(cls.rows);
  assert.deepEqual(summary, { rows: 3, kinds: { IDENTICAL: 0, ROUNDING_ONLY: 0, COUNTS_DIFFER: 3 }, reasons: { QR_ONLY_ATTENDANCE: 1, PENDING_NOT_FINALIZED: 4 } });
  assert.ok(!JSON.stringify(summary).includes("s1"), "the operator summary holds counts only");
});

test("ownership isolation: another teacher's class or student is 404 before any legacy read; outputs never carry names", async () => {
  reset();
  student("s1");
  student("s-foreign", { teacherId: T2 });
  klass("c1");
  klass("c-other", { teacherId: T2 });
  enrol("s1", "c1");
  enrol("s-foreign", "c-other");
  lecture("c1");
  await assert.rejects(compareClass("c-other"), (e) => e.code === "CLASS_NOT_FOUND" && e.statusCode === 404);
  assert.ok(!db.calls.includes("lecture.findMany"), "nothing read after the ownership refusal");
  await assert.rejects(compareStudent("s-foreign"), (e) => e.code === "STUDENT_NOT_FOUND");
  assert.ok(!db.calls.includes("lecture.count"), "the legacy per-class counts never ran for another teacher's student");
  const ok = await compareClass("c1");
  assert.ok(!JSON.stringify(ok).includes("Name s1"), "no names in the comparison");
});

test("read only: no writes, transactions or raw SQL; nothing logged; a bounded number of queries", async () => {
  reset();
  for (let s = 0; s < 20; s += 1) {
    student(`s${s}`);
    enrol(`s${s}`, "c1");
  }
  klass("c1");
  for (let l = 0; l < 15; l += 1) {
    const id = lecture("c1", { start: new Date(T("2026-09-01T12:30:00Z").getTime() + l * 86_400_000), end: new Date(T("2026-09-01T14:30:00Z").getTime() + l * 86_400_000) });
    for (let s = 0; s < 20; s += 1) {
      if ((s + l) % 2 === 0) rec(id, `s${s}`, "PRESENT", { qr: true });
      else visit(id, `s${s}`);
    }
  }
  const logs = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(saved)) console[k] = (...a) => logs.push(a.join(" "));
  try {
    await compareClass();
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(logs, [], "nothing logged");
  const forbidden = db.calls.filter((c) => /^(create|createMany|update|updateMany|upsert|delete|deleteMany|\$)/.test(c));
  assert.deepEqual(forbidden, []);
  // New service: 7; legacy class summary: 3; attribution: 2 — independent of the 20 students × 15 lectures.
  assert.equal(db.calls.length, 12, db.calls.join(", "));
});

test("attribution needs evidence: a record with both channels but no legacy visit is OTHER (not QR-only); an inconsistent snapshot is OTHER", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const bothChannelsNoVisit = lecture("c1");
  rec(bothChannelsNoVisit, "s1", "PRESENT", { online: true, qr: true });
  const r = rowOf(await compareClass(), "s1");
  assert.deepEqual(r.reasons, { OTHER: 1 }, "online evidence without its legacy visit row: no cause is inferred");

  // A visit the legacy read sees but the attribution read does not (committed between the reads).
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const l1 = lecture("c1");
  visit(l1, "s1");
  db.data.visits[0].hiddenFromFlatReads = true;
  const inconsistent = rowOf(await compareClass(), "s1");
  assert.equal(inconsistent.legacy.attended, 1);
  assert.ok((inconsistent.reasons.OTHER ?? 0) >= 1, "reported as unexplained, never attributed to a cause");
});

// ======================================================================================
// Unchanged visible behaviour
// ======================================================================================

test("legacy outputs are untouched: the functions the screens call return exactly what they did, and no consumer imports the comparison", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const a = lecture("c1");
  rec(a, "s1", "PRESENT", { qr: true }); // QR-only: invisible to the legacy calculation (unchanged behaviour)
  lecture("c1", { classStatus: "CANCELLED" });
  assert.deepEqual(await studentService.getClassAttendanceSummaryForTeacher({ teacherId: T1, classId: "c1" }), [
    { studentId: "s1", name: "Name s1", attendedLectures: 0, totalLectures: 2, attendancePercentage: 0 },
  ]);
  assert.deepEqual(await studentService.getStudentAttendanceSummary("s1"), [
    { classId: "c1", className: "Class c1", totalLectures: 2, attendedLectures: 0, missedLectures: 2, attendancePercentage: 0 },
  ]);

  const consumers = [
    "services/student-service.ts",
    "app/api/student/dashboard/performance/route.ts",
    "services/student-dashboard-counts-service.ts",
    "app/api/student/lectures/route.ts",
    "services/guardian-portal-service.ts",
    "app/api/classes/[id]/attendance-summary/route.ts",
    "app/api/student/Profile/[StudentId]/attendance/route.ts",
    "app/api/student/Profile/[StudentId]/attendance/analytics/route.ts",
    "app/api/guardian/students/[studentId]/attendance/route.ts",
    "app/api/guardian/students/[studentId]/overview/route.ts",
    "components/Jitsi/classroom/sidebar/AttendancePanel.tsx",
    "components/guardian/GuardianPortal.tsx",
  ];
  for (const file of consumers) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /attendance-percentage-(comparison|service)|lib\/attendance\/percentage/, file);
  }
  // Nothing outside the services and tests imports the comparison (no route, page or component).
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
  for (const top of ["app", "components", "lib"]) {
    for (const file of walk(path.join(root, top)).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))) {
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /attendance-percentage-comparison/, path.relative(root, file));
    }
  }
  const code = fs.readFileSync(path.join(root, "services", "attendance-percentage-comparison.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Stage 5.7b-3j: the labelled legacy replica of the dashboard route is the one allowed copy of a legacy expression.
  const outsideReplica = code.slice(0, code.indexOf("export async function legacyDashboardAttendanceReplica")) + code.slice(code.indexOf("export async function compareDashboardAttendanceForTeacher"));
  assert.doesNotMatch(outsideReplica, /console\.|Math\.round\(\(?\w+ \/ \w+\)? \* 100\)|toFixed/, "no logging; no percentage formula of its own");
});
