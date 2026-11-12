/*
 * Stage 5.7b-3j: comparison coverage for the student-wide percentage
 * consumers — student analytics (P4), the student dashboard card (P5) and
 * the guardian Overview — in services/attendance-percentage-comparison.ts.
 * The REAL legacy analytics (services/student-service.ts) and the REAL
 * dashboard route (for the replica's parity test) run, unchanged, next to
 * the REAL new service, over one fake Prisma that records every call. The
 * global clock is fixed (the legacy analytics reads it). No database.
 *
 *   node --test tests/attendance/attendance-percentage-comparison-student.test.cjs   (part of npm run test:attendance)
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
let sessionStudentId = null;
function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
fake("lib/prisma.ts", { prisma: new Proxy({}, { get: (_, key) => db.prisma[key] }) });
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
fake("lib/auth-session.ts", {
  requireStudentSession: async () => {
    if (!sessionStudentId) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    return { role: "STUDENT", studentId: sessionStudentId, userId: sessionStudentId };
  },
  requireTeacherSession: async () => {
    throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
  },
});

const NOW = new Date("2026-10-15T06:00:00.000Z"); // October in Colombo
test.mock.timers.enable({ apis: ["Date"], now: NOW });

const comparison = require(path.join(root, "services", "attendance-percentage-comparison.ts"));
const studentService = require(path.join(root, "services", "student-service.ts"));
const dashboardRoute = require(path.join(root, "app", "api", "student", "dashboard", "performance", "route.ts"));

const T = (iso) => new Date(iso);
const ENV = { APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z", ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z" };
const APPROVED_AT = T("2026-08-01T00:00:00.000Z");
const T1 = "teacher-1";
const T2 = "teacher-2";
const local = (instant) => new Date(instant.getTime() + (5 * 60 + 30) * 60_000);

// ---- Fake Prisma: the legacy analytics, the dashboard route and the new service ----------------

function createDb() {
  const data = { students: [], history: [], enrolments: [], classes: [], lectures: [], registers: [], records: [], visits: [], sessions: [] };
  const calls = [];
  const inOrEq = (cond, value) => (cond === undefined ? true : cond !== null && typeof cond === "object" && "in" in cond ? cond.in.includes(value) : cond === value);
  const notNull = (cond, value) => (cond && typeof cond === "object" && "not" in cond ? value !== null : true);
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
    if (where.class) {
      const c = classOf(l.classId);
      if (c.status !== where.class.status) return false;
      const some = where.class.students?.some;
      if (some && !data.enrolments.some((e) => e.classId === l.classId && e.studentId === some.studentId && e.isActive === some.isActive)) return false;
    }
    return true;
  };
  const read = (name, fn) => async (args = {}) => {
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
    student: { ...writes, findUnique: read("student.findUnique", ({ where, select }) => (studentOf(where.id) ? pick(studentOf(where.id), select) : null)) },
    studentConfirmationHistory: { ...writes, findMany: read("history.findMany", ({ where, select }) => data.history.filter((h) => inOrEq(where.studentId, h.studentId)).map((h) => pick(h, select))) },
    class: { ...writes, findFirst: read("class.findFirst", ({ where, select }) => { const c = data.classes.find((x) => x.id === where.id && x.teacherId === where.teacherId && x.status === where.status); return c ? pick(c, select) : null; }) },
    classStudent: {
      ...writes,
      findMany: read("classStudent.findMany", ({ where, select }) =>
        data.enrolments
          .filter((e) => inOrEq(where.studentId, e.studentId) && inOrEq(where.classId, e.classId))
          .filter((e) => where.isActive === undefined || e.isActive === where.isActive)
          .filter((e) => {
            if (!where.class) return true;
            const c = classOf(e.classId);
            return c.status === where.class.status && (where.class.teacherId === undefined || c.teacherId === where.class.teacherId);
          })
          .map((e) => ({ ...pick(e, select), ...(select.class ? { class: pick(classOf(e.classId), select.class.select) } : {}) }))
      ),
    },
    lecture: {
      ...writes,
      findMany: read("lecture.findMany", ({ where, select }) =>
        data.lectures
          .filter((l) => lectureMatches(l, where))
          .map((l) => ({
            ...pick(l, select),
            ...(select.sessions
              ? {
                  sessions: sessionsOf(l.id).map((s) => {
                    const att = select.sessions.select.attendance;
                    let rows = visitsOf(s.id).filter((v) => !att.where || v.studentId === att.where.studentId);
                    if (att.take) rows = rows.slice(0, att.take);
                    return { attendance: rows.map((v) => ({ id: v.id, studentId: v.studentId })) };
                  }),
                }
              : {}),
          }))
      ),
      count: read("lecture.count", ({ where }) => data.lectures.filter((l) => lectureMatches(l, where)).length),
    },
    lectureAttendanceRegister: { ...writes, findMany: read("register.findMany", ({ where, select }) => data.registers.filter((r) => inOrEq(where.lectureId, r.lectureId)).map((r) => pick(r, select))) },
    lectureAttendance: { ...writes, findMany: read("record.findMany", ({ where, select }) => data.records.filter((r) => inOrEq(where.lectureId, r.lectureId) && inOrEq(where.studentId, r.studentId)).map((r) => pick(r, select))) },
    attendance: {
      ...writes,
      findMany: read("visit.findMany", ({ where, select }) =>
        data.visits
          .filter((v) => inOrEq(where.studentId, v.studentId) && inOrEq(where.classId, v.classId) && notNull(where.leftAt, v.leftAt))
          .map((v) => ({ v, s: data.sessions.find((x) => x.id === v.sessionId) }))
          .filter(({ s }) => (where.classSession?.lectureId ? inOrEq(where.classSession.lectureId, s.lectureId) : true) && notNull(where.classSession?.endedAt, s.endedAt))
          .filter(({ v }) => !(v.hiddenFromLectureReads && where.classSession?.lectureId))
          .map(({ v, s }) =>
            select.classSessionId
              ? { classSessionId: s.id, joinedAt: v.joinedAt, leftAt: v.leftAt, classSession: { startedAt: s.startedAt, endedAt: s.endedAt } }
              : { studentId: v.studentId, joinedAt: v.joinedAt, classSession: { lectureId: s.lectureId } }
          )
      ),
    },
    quizSubmission: { ...writes, findMany: read("quiz.findMany", () => []) },
    $transaction: forbidden("$transaction"),
    $executeRaw: forbidden("$executeRaw"),
    $queryRaw: forbidden("$queryRaw"),
  };
  return { data, prisma, calls };
}

function reset() {
  db = createDb();
  sessionStudentId = null;
}
function student(id, { teacherId = T1, approvedAt = APPROVED_AT } = {}) {
  db.data.students.push({ id, name: `Name ${id}`, status: 0, teacherId, confirmationStatus: "APPROVED", confirmedAt: approvedAt, approvedAt });
  db.data.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: approvedAt, previousConfirmedAt: null });
}
function klass(id, { teacherId = T1, status = 0 } = {}) {
  db.data.classes.push({ id, name: `Class ${id}`, teacherId, status });
}
let seq = 0;
function enrol(studentId, classId, { from = T("2026-08-05T00:00:00Z"), to = null } = {}) {
  db.data.enrolments.push({ id: `e-${++seq}`, studentId, classId, assignedAt: local(from), removedAt: to ? local(to) : null, isActive: to === null });
}
function lecture(classId, { start = T("2026-09-01T12:30:00Z"), end, classStatus = "COMPLETED" } = {}) {
  const id = `lec-${++seq}`;
  const endDate = end === undefined ? new Date(start.getTime() + 2 * 3_600_000) : end;
  db.data.lectures.push({ id, classId, status: 0, classStatus, date: start, endDate });
  db.data.sessions.push({ id: `sess-${id}`, lectureId: id, classId, startedAt: start, endedAt: endDate });
  return id;
}
function finalize(lectureId) {
  const l = db.data.lectures.find((x) => x.id === lectureId);
  const r = db.data.registers.find((x) => x.lectureId === lectureId);
  if (r) r.finalizedAt = T("2026-10-01T00:00:00Z");
  else db.data.registers.push({ lectureId, scheduledStartAt: l.date, scheduledEndAt: l.endDate, finalizedAt: T("2026-10-01T00:00:00Z") });
}
function rec(lectureId, studentId, status, { statusSource = "AUTO", online = false, qr = false } = {}) {
  const l = db.data.lectures.find((x) => x.id === lectureId);
  if (!db.data.registers.some((r) => r.lectureId === lectureId)) db.data.registers.push({ lectureId, scheduledStartAt: l.date, scheduledEndAt: l.endDate, finalizedAt: null });
  db.data.records.push({ lectureId, studentId, status, statusSource, firstOnlineAt: online ? l.date : null, firstQrAt: qr ? l.date : null });
}
function visit(lectureId, studentId, { minutes = 90 } = {}) {
  const l = db.data.lectures.find((x) => x.id === lectureId);
  const joinedAt = new Date(l.date.getTime() + 60_000);
  db.data.visits.push({ id: `v-${++seq}`, sessionId: `sess-${lectureId}`, classId: l.classId, studentId, joinedAt, leftAt: new Date(joinedAt.getTime() + minutes * 60_000) });
}
const day = (n, hour = "12:30") => T(`2026-${n}T${hour}:00Z`);

const analytics = (studentId, teacherId = T1, months) => comparison.compareStudentAnalyticsForTeacher({ teacherId, studentId, months }, { env: ENV });
const dashboard = (studentId, teacherId = T1) => comparison.compareDashboardAttendanceForTeacher({ teacherId, studentId }, { env: ENV });
const guardian = (studentId, teacherId = T1) => comparison.compareGuardianOverviewAttendanceForTeacher({ teacherId, studentId }, { env: ENV });

// ======================================================================================
// Analytics (P4)
// ======================================================================================

test("analytics: all enrolment rows (former included) on both sides; QR-only, teacher decision, EXCUSED, pending, unresolved, deleted class", async () => {
  reset();
  student("s1");
  klass("c1");
  klass("c-former");
  klass("c-deleted", { status: 1 });
  enrol("s1", "c1");
  enrol("s1", "c-former", { to: T("2026-09-20T00:00:00Z") });
  enrol("s1", "c-deleted");
  const qrOnly = lecture("c1", { start: day("09-01") });
  rec(qrOnly, "s1", "PRESENT", { qr: true });
  const online = lecture("c1", { start: day("09-02") });
  rec(online, "s1", "PRESENT", { online: true });
  visit(online, "s1");
  const teacherAbsent = lecture("c1", { start: day("09-03") });
  rec(teacherAbsent, "s1", "ABSENT", { statusSource: "TEACHER" });
  visit(teacherAbsent, "s1");
  const excused = lecture("c1", { start: day("09-04") });
  rec(excused, "s1", "EXCUSED", { statusSource: "TEACHER" });
  lecture("c1", { start: day("09-05") }); // pending
  const unresolved = lecture("c1", { start: day("09-06") });
  finalize(unresolved);
  const former = lecture("c-former", { start: day("09-10") }); // inside the former enrolment
  rec(former, "s1", "PRESENT", { online: true });
  visit(former, "s1");
  lecture("c-former", { start: day("09-25") }); // after the removal: legacy counts it, new does not
  lecture("c-deleted", { start: day("09-11") });

  const r = await analytics("s1");
  assert.equal(r.overall.scope, "ANALYTICS_ALL_ENROLMENTS");
  assert.deepEqual(r.overall.legacy, { attended: 3, total: 9, percentage: 33 }, "6 + 2 + 1 lectures; visits on 3");
  assert.deepEqual(
    [r.overall.current.attended, r.overall.current.missed, r.overall.current.excused, r.overall.current.pending, r.overall.current.unresolved, r.overall.current.countedLectures, r.overall.current.percentage],
    [3, 1, 1, 1, 1, 4, 75]
  );
  assert.deepEqual(r.overall.reasons, {
    QR_ONLY_ATTENDANCE: 1, TEACHER_DECISION: 1, EXCUSED: 1, PENDING_NOT_FINALIZED: 1, UNRESOLVED_FINALIZED: 1, ENROLMENT_BOUNDARY: 1, CLASS_DELETED: 1,
  });
  assert.equal(r.overall.kind, "COUNTS_DIFFER");
  assert.deepEqual(r.health, { legacy: "Poor", current: "Good", changed: true });
});

test("analytics: monthly buckets by the lecture date's Colombo month, legacy and new side by side; the trend compared", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  // 31 Aug 19:00 UTC is 1 Sep 00:30 in Colombo: September on both sides.
  const boundary = lecture("c1", { start: T("2026-08-31T19:00:00Z") });
  rec(boundary, "s1", "PRESENT", { qr: true });
  const aug = lecture("c1", { start: day("08-20") });
  rec(aug, "s1", "PRESENT", { online: true });
  visit(aug, "s1");
  const oct1 = lecture("c1", { start: day("10-02") });
  rec(oct1, "s1", "PRESENT", { qr: true });
  const oct2 = lecture("c1", { start: day("10-03") });
  visit(oct2, "s1");
  lecture("c1", { start: day("10-30"), classStatus: "SCHEDULED" }); // future: legacy counts it in October

  const r = await analytics("s1", T1, 3); // Aug, Sep, Oct
  assert.deepEqual(r.monthly.map((m) => m.key), ["2026-08", "2026-09", "2026-10"]);
  const [augM, sepM, octM] = r.monthly;
  assert.deepEqual([augM.legacy, augM.current.percentage, augM.kind], [{ attended: 1, total: 1, percent: 100 }, 100, "IDENTICAL"]);
  assert.deepEqual([sepM.legacy, sepM.current.attended, sepM.current.percentage, sepM.reasons], [{ attended: 0, total: 1, percent: 0 }, 1, 100, { QR_ONLY_ATTENDANCE: 1 }], "the Colombo-midnight lecture is September's");
  assert.deepEqual([octM.legacy, octM.current.attended, octM.current.countedLectures, octM.current.percentage], [{ attended: 1, total: 3, percent: 33 }, 2, 2, 100]);
  assert.deepEqual(octM.reasons, { QR_ONLY_ATTENDANCE: 1, FUTURE_LECTURE: 1 });
  assert.deepEqual(r.trend, { legacy: 33, current: 0, difference: -33 }, "Oct − Sep: legacy 33 − 0, new 100 − 100");
  // The legacy side is exactly the legacy function's output.
  const legacy = await studentService.getStudentAttendanceAnalytics("s1", { months: 3 });
  assert.deepEqual(r.monthly.map((m) => m.legacy), legacy.monthly.map((m) => ({ attended: m.attended, total: m.total, percent: m.percent })));
  assert.equal(r.trend.legacy, legacy.trendDelta);
});

test("health labels: the same classifyAttendance thresholds (90 / 75 / 60) on both sides, boundaries included", async () => {
  const c = studentService.classifyAttendance;
  assert.deepEqual([c(100), c(90), c(89), c(75), c(74), c(60), c(59), c(0)], ["Excellent", "Excellent", "Good", "Good", "At Risk", "At Risk", "Poor", "Poor"]);
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  // Legacy 9 / 10 = 90 (Excellent); new: one of the attended lectures was overruled to ABSENT → 8 / 10 = 80 (Good).
  for (let i = 0; i < 10; i += 1) {
    const id = lecture("c1", { start: T(`2026-09-${String(i + 1).padStart(2, "0")}T12:30:00Z`) });
    if (i < 9) {
      rec(id, "s1", i === 0 ? "ABSENT" : "PRESENT", { online: true, statusSource: i === 0 ? "TEACHER" : "AUTO" });
      visit(id, "s1");
    } else {
      rec(id, "s1", "ABSENT", { statusSource: "FINALIZATION" });
      finalize(id);
    }
  }
  const r = await analytics("s1");
  assert.deepEqual([r.overall.legacy.percentage, r.overall.current.percentage], [90, 80]);
  assert.deepEqual(r.health, { legacy: "Excellent", current: "Good", changed: true });
  assert.equal(r.health.current, c(r.overall.current.percentage));
});

test("rounding only: identical counts where the legacy floating-point rounding differs from exact half up (23 of 40 = 57.5)", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  for (let i = 0; i < 40; i += 1) {
    const id = lecture("c1", { start: new Date(T("2026-08-20T12:30:00Z").getTime() + i * 86_400_000 / 2) });
    if (i < 23) {
      rec(id, "s1", "PRESENT", { online: true });
      visit(id, "s1");
    } else {
      rec(id, "s1", "ABSENT", { statusSource: "FINALIZATION" });
      finalize(id);
    }
  }
  const r = await analytics("s1");
  assert.deepEqual([r.overall.legacy.attended, r.overall.legacy.total, r.overall.legacy.percentage], [23, 40, 57], "Math.round(23 / 40 × 100) = 57 in floating point");
  assert.deepEqual([r.overall.current.attended, r.overall.current.countedLectures, r.overall.current.percentage], [23, 40, 58], "exact 57.5 rounds half up to 58");
  assert.deepEqual([r.overall.kind, r.overall.percentageDifference, r.overall.reasons], ["ROUNDING_ONLY", 1, {}]);
  const d = await dashboard("s1");
  assert.deepEqual([d.legacy.percentage, d.current.percentage, d.kind], [57, 58, "ROUNDING_ONLY"]);
});

test("average time present stays visit-based: the legacy value, unchanged by canonical-only (QR) attendance", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const a = lecture("c1", { start: day("09-01") }); // 2-hour session
  rec(a, "s1", "PRESENT", { online: true });
  visit(a, "s1", { minutes: 60 }); // half of the session
  const qr = lecture("c1", { start: day("09-02") });
  rec(qr, "s1", "PRESENT", { qr: true }); // no visit: no duration
  const r = await analytics("s1");
  const legacy = await studentService.getStudentAttendanceAnalytics("s1", { months: 6 });
  assert.deepEqual(r.averageDuration, { value: 50, source: "SESSION_VISITS" });
  assert.equal(r.averageDuration.value, legacy.averageDuration);
  const code = fs.readFileSync(path.join(root, "services", "attendance-percentage-comparison.ts"), "utf8");
  assert.match(code, /averageDuration: \{ value: legacy\.averageDuration, source: "SESSION_VISITS" \}/, "taken from the legacy analytics");
  assert.doesNotMatch(code, /attendedMs|leftAt|joinedAt/, "never recomputed from visits or canonical statuses");
});

test("analytics: an inconsistent read (a visit committed between the reads) is OTHER, overall and in its month, never attributed", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const a = lecture("c1", { start: day("09-01") });
  visit(a, "s1");
  db.data.visits[0].hiddenFromLectureReads = true; // the legacy analytics sees it; the attribution read does not
  const r = await analytics("s1");
  assert.equal(r.overall.legacy.attended, 1);
  assert.ok((r.overall.reasons.OTHER ?? 0) >= 1);
  const sep = r.monthly.find((m) => m.key === "2026-09");
  assert.ok((sep.reasons.OTHER ?? 0) >= 1, "the month reports it too");
});

// ======================================================================================
// Dashboard (P5)
// ======================================================================================

test("dashboard: active enrolments only on both sides (a former class is out); the replica equals the real route", async () => {
  reset();
  student("s1");
  klass("c1");
  klass("c-former");
  enrol("s1", "c1");
  enrol("s1", "c-former", { to: T("2026-09-20T00:00:00Z") });
  const a = lecture("c1", { start: day("09-01") });
  rec(a, "s1", "PRESENT", { qr: true });
  const b = lecture("c1", { start: day("09-02") });
  visit(b, "s1");
  const formerLecture = lecture("c-former", { start: day("09-05") });
  visit(formerLecture, "s1");

  sessionStudentId = "s1";
  const response = await dashboardRoute.GET(new Request("http://localhost/api/student/dashboard/performance"));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const replica = await comparison.legacyDashboardAttendanceReplica("s1");
  assert.deepEqual(replica, body.data.attendance, "the replica is the route's attendance, exactly");
  assert.deepEqual(replica, { percent: 50, attended: 1, total: 2 }, "the former class is not in the dashboard's scope");

  const r = await dashboard("s1");
  assert.equal(r.scope, "DASHBOARD_ACTIVE_ENROLMENTS");
  assert.deepEqual(r.legacy, { attended: 1, total: 2, percentage: 50 });
  assert.deepEqual([r.current.attended, r.current.countedLectures, r.current.percentage], [2, 2, 100]);
  assert.deepEqual(r.reasons, { QR_ONLY_ATTENDANCE: 1 }, "the former class's lecture is in neither side");
});

test("dashboard replica parity over varied data (several classes, deleted class, inactive enrolment, multiple visits)", async () => {
  reset();
  student("s1");
  klass("c1");
  klass("c2");
  klass("c-del", { status: 1 });
  enrol("s1", "c1");
  enrol("s1", "c2");
  enrol("s1", "c-del");
  for (let i = 0; i < 7; i += 1) {
    const id = lecture(i % 3 === 0 ? "c2" : i % 3 === 1 ? "c-del" : "c1", { start: T(`2026-09-${String(i + 1).padStart(2, "0")}T12:30:00Z`) });
    if (i % 2 === 0) {
      visit(id, "s1");
      visit(id, "s1");
    }
  }
  sessionStudentId = "s1";
  const body = await (await dashboardRoute.GET(new Request("http://localhost/api/student/dashboard/performance"))).json();
  assert.deepEqual(await comparison.legacyDashboardAttendanceReplica("s1"), body.data.attendance);
});

// ======================================================================================
// Guardian overview
// ======================================================================================

test("guardian overview: the analytics with months 6 (rate, trendDelta, months), side by side; the service still maps exactly these", async () => {
  reset();
  student("s1");
  klass("c1");
  enrol("s1", "c1");
  const a = lecture("c1", { start: day("09-01") });
  rec(a, "s1", "PRESENT", { qr: true });
  const b = lecture("c1", { start: day("10-01") });
  visit(b, "s1");
  const r = await guardian("s1");
  assert.equal(r.monthsBack, 6);
  assert.deepEqual(r.monthly.map((m) => m.key), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(r.overview.legacy, { rate: 50, trendDelta: 100, months: r.monthly.map((m) => ({ label: m.label, percent: m.legacy.percent })) });
  assert.deepEqual(r.overview.current, { rate: 100, trendDelta: 0, months: r.monthly.map((m) => ({ label: m.label, percent: m.current.percentage })) });
  const legacy = await studentService.getStudentAttendanceAnalytics("s1", { months: 6 });
  assert.deepEqual(r.overview.legacy.months, legacy.monthly.map((m) => ({ label: m.label, percent: m.percent })));
  const guardianSource = fs.readFileSync(path.join(root, "services", "guardian-portal-service.ts"), "utf8");
  assert.match(guardianSource, /getStudentAttendanceAnalytics\(studentId, \{ months: 6 \}\)/);
  assert.match(guardianSource, /rate: attendance\.attendanceRate,\s*trendDelta: attendance\.trendDelta,\s*months: attendance\.monthly\.map\(\(m\) => \(\{\s*label: m\.label,\s*percent: m\.percent,/);
});

// ======================================================================================
// Ownership, privacy, queries, unchanged legacy
// ======================================================================================

test("ownership: another teacher's student is 404; a student with any class of another teacher is withheld before any legacy read", async () => {
  reset();
  student("s-foreign", { teacherId: T2 });
  student("s-mixed");
  klass("c1");
  klass("c-other", { teacherId: T2 });
  enrol("s-foreign", "c-other");
  enrol("s-mixed", "c1");
  enrol("s-mixed", "c-other");
  lecture("c1");
  lecture("c-other");
  for (const fn of [analytics, dashboard, guardian]) {
    await assert.rejects(fn("s-foreign"), (e) => e.code === "STUDENT_NOT_FOUND" && e.statusCode === 404);
  }
  db.calls.length = 0;
  for (const fn of [analytics, dashboard, guardian]) {
    const r = await fn("s-mixed");
    assert.deepEqual(r, { studentId: "s-mixed", withheld: "OTHER_TEACHER_CLASSES" });
  }
  assert.ok(!db.calls.includes("lecture.count") && db.calls.filter((c) => c === "visit.findMany").length <= 3, "no legacy analytics / dashboard read for a withheld student");
  assert.ok(!db.calls.some((c) => c === "lecture.findMany" && false));
});

test("read only, nothing logged, a fixed number of queries whatever the size", async () => {
  const sizes = [];
  for (const n of [2, 30]) {
    reset();
    student("s1");
    for (let c = 0; c < 4; c += 1) {
      klass(`c${c}`);
      enrol("s1", `c${c}`, c === 3 ? { to: T("2026-09-20T00:00:00Z") } : {});
      for (let l = 0; l < n; l += 1) {
        const id = lecture(`c${c}`, { start: new Date(T("2026-08-20T12:30:00Z").getTime() + l * 86_400_000) });
        if (l % 3 === 0) rec(id, "s1", "PRESENT", { qr: true });
        else if (l % 3 === 1) visit(id, "s1");
      }
    }
    const logs = [];
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    for (const k of Object.keys(saved)) console[k] = (...a) => logs.push(a.join(" "));
    let analyticsQueries;
    let dashboardQueries;
    try {
      db.calls.length = 0;
      await analytics("s1");
      analyticsQueries = db.calls.length;
      db.calls.length = 0;
      await dashboard("s1");
      dashboardQueries = db.calls.length;
    } finally {
      Object.assign(console, saved);
    }
    assert.deepEqual(logs, []);
    sizes.push([analyticsQueries, dashboardQueries]);
  }
  assert.deepEqual(sizes[0], sizes[1], "independent of 4 classes × 2 or × 30 lectures");
  // analytics: new 7 + enrolment scope 1 + legacy analytics 3 + legacy lectures 1 + attribution 2 = 14;
  // dashboard: new 7 + enrolment scope 1 + replica 1 + legacy lectures 1 + attribution 2 = 12.
  assert.deepEqual(sizes[1], [14, 12]);
  assert.ok(!db.calls.some((c) => /^(create|update|upsert|delete|\$)/.test(c)));
});

test("unchanged: no consumer imports the comparison or the new service; the comparison's only formula is the labelled legacy replica", () => {
  const consumers = [
    "services/student-service.ts",
    "services/guardian-portal-service.ts",
    "app/api/student/dashboard/performance/route.ts",
    "app/api/student/Profile/[StudentId]/attendance/analytics/route.ts",
    "app/api/guardian/students/[studentId]/overview/route.ts",
    "app/api/guardian/students/[studentId]/attendance/route.ts",
    "app/student/Components/StudentOverview.tsx",
    "app/dashboard/students/[id]/page.tsx",
    "components/student-portal/dashboard-performance.tsx",
    "components/guardian/GuardianPortal.tsx",
  ];
  for (const file of consumers) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /attendance-percentage-(comparison|service)|lib\/attendance\/percentage/, file);
  }
  const code = fs.readFileSync(path.join(root, "services", "attendance-percentage-comparison.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const replicaStart = code.indexOf("export async function legacyDashboardAttendanceReplica");
  const replicaEnd = code.indexOf("export async function compareDashboardAttendanceForTeacher");
  const outsideReplica = code.slice(0, replicaStart) + code.slice(replicaEnd);
  assert.doesNotMatch(outsideReplica, /\(\w+ \/ \w+\) \* 100|\w+ \* 100 \/ \w+|toFixed|console\./, "no percentage formula or logging outside the replica");
  assert.match(code.slice(replicaStart, replicaEnd), /Math\.round\(\(attendedLectures \/ totalLectures\) \* 100\)/, "the replica keeps the route's exact expression");
});
