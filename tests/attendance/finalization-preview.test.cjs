/*
 * Stage 5.5a: read-only finalization preview and fingerprint
 * (services/lecture-attendance-finalization-preview-service.ts).
 *
 *   npm run test:attendance-finalization-preview
 *
 * No database: the real service (and the real getRegister it reads through)
 * runs via tsx against the in-memory PostgreSQL model
 * (tests/attendance/helpers/attendance-pg-model.cjs), behind a recorder that
 * fails the test on any write, transaction or raw query. NOT a
 * real-PostgreSQL validation (postponed).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { createPgModel } = require("./helpers/attendance-pg-model.cjs");

const root = path.resolve(__dirname, "..", "..");

let currentPrisma = null;
const fakeModule = (relativePath, exports) => {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
};
fakeModule("lib/prisma.ts", { prisma: new Proxy({}, { get: (_, key) => currentPrisma[key] }) });

const preview = require(path.join(root, "services", "lecture-attendance-finalization-preview-service.ts"));
const attendanceService = require(path.join(root, "services", "lecture-attendance-service.ts"));

// ---- Clock and fixtures ----------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z"); // LIVE
const at = (minutes) => new Date(START.getTime() + minutes * 60_000);
const NOW = at(200); // after the scheduled end (at(120))
test.mock.timers.enable({ apis: ["Date"], now: NOW });

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "class-1";
const L1 = "lecture-1";
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const ENV = { APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z", ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z" };
const local = (date) => new Date(date.getTime() + (5 * 60 + 30) * 60_000);

let model;
let pg;
let calls;
let visitSeq = 0;
const READS = new Set(["findMany", "findFirst", "findUnique"]);

function recordingPrisma(inner) {
  return new Proxy(inner, {
    get(target, modelName) {
      if (typeof modelName === "string" && modelName.startsWith("$")) {
        return () => {
          calls.push(modelName);
          throw new Error(`preview used ${modelName}`);
        };
      }
      const delegate = target[modelName];
      if (!delegate) return undefined;
      return new Proxy(delegate, {
        get(d, method) {
          return async (...args) => {
            calls.push(`${String(modelName)}.${String(method)}`);
            if (!READS.has(method)) throw new Error(`preview wrote: ${String(modelName)}.${String(method)}`);
            return d[method](...args);
          };
        },
      });
    },
  });
}

function reset({ date = START, endDate = at(120), classStatus = "SCHEDULED", grace = 10 } = {}) {
  model = createPgModel();
  pg = model.pg;
  calls = [];
  visitSeq = 0;
  currentPrisma = recordingPrisma(model.prisma);
  test.mock.timers.setTime(NOW.getTime());
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: grace };
  pg.committed.lectures[L1] = { id: L1, classId: C1, title: "Kinematics", status: 0, classStatus, date, endDate, createdAt: at(-1000) };
  pg.committed.sessions["sess-a"] = { id: "sess-a", lectureId: L1, isActive: false, startedAt: at(-5) };
  pg.committed.sessions["sess-b"] = { id: "sess-b", lectureId: L1, isActive: false, startedAt: at(30) };
}

function student(id, { teacherId = T1, status = 0, confirmationStatus = "APPROVED", broken = false, approvedAt = APPROVED_AT,
  enrolledAt = new Date("2026-08-05T00:00:00Z"), removedAt = null } = {}) {
  pg.committed.students[id] = {
    id, name: `Name of ${id}`, registrationNumber: `REG-${id}`, teacherId, status, confirmationStatus,
    confirmedAt: confirmationStatus === "PENDING" ? null : broken ? new Date(approvedAt.getTime() + 86_400_000) : approvedAt,
    approvedAt: confirmationStatus === "PENDING" ? null : approvedAt,
  };
  if (confirmationStatus !== "PENDING") {
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: confirmationStatus, decidedAt: approvedAt, previousConfirmedAt: null });
  }
  if (enrolledAt) {
    pg.committed.enrolments.push({ id: `e-${id}`, studentId: id, classId: C1, assignedAt: local(enrolledAt), removedAt: removedAt ? local(removedAt) : null, isActive: !removedAt });
  }
}

function visit(studentId, joinedAt, session = "sess-a") {
  const id = `visit-${String(++visitSeq).padStart(4, "0")}`;
  pg.committed.visits[id] = { id, studentId, joinedAt, classSessionId: session };
  return id;
}

function register(extra = {}) {
  const l = pg.committed.lectures[L1];
  pg.committed.registers[L1] = {
    lectureId: L1, classId: C1, scheduledStartAt: l.date, scheduledEndAt: l.endDate, graceMinutes: 10,
    finalizedAt: null, finalizedByTeacherId: null, version: 1, createdAt: at(-30), updatedAt: at(-30), ...extra,
  };
}

function seedRecord(studentId, fields) {
  const row = {
    id: `rec-${studentId}`, lectureId: L1, classId: C1, studentId, firstOnlineAt: null, firstQrAt: null, autoStatus: null,
    teacherStatus: null, teacherDecidedAt: null, teacherDecidedById: null, pendingReviewSince: null, version: 1,
    createdAt: at(1), updatedAt: at(1), ...fields,
  };
  model.checkRecord(row);
  pg.committed.records[`${L1}:${studentId}`] = row;
  pg.committed.recordAudits.push({ id: `seed-${studentId}`, lectureAttendanceId: row.id, version: 1, lectureId: L1, studentId, action: "CREATED_AUTO", toStatus: row.status });
  return row;
}

const teacherRecord = (status, extra = {}) => ({ status, statusSource: "TEACHER", teacherStatus: status, teacherDecidedAt: at(130), teacherDecidedById: T1, ...extra });
const autoRecord = (status, at_) => ({ status, statusSource: "AUTO", firstOnlineAt: at_, autoStatus: status });

const run = (extra = {}, env = ENV) => preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1, ...extra }, { env });
const snapshot = () => JSON.stringify(pg.committed);
const fp = async () => (await run()).fingerprint;

/** A mixed class: every partition entry and record status present. */
function mixedClass() {
  register();
  student("s-present"); seedRecord("s-present", autoRecord("PRESENT", at(2))); visit("s-present", at(2));
  student("s-late"); seedRecord("s-late", autoRecord("LATE", at(30))); visit("s-late", at(30));
  student("s-absent"); seedRecord("s-absent", teacherRecord("ABSENT"));
  student("s-excused"); seedRecord("s-excused", teacherRecord("EXCUSED"));
  student("s-no-show-1");
  student("s-no-show-2");
  student("s-unknown", { broken: true });
  student("s-pending", { confirmationStatus: "PENDING" });
  student("s-removed", { removedAt: at(-60 * 24) });
  student("s-deleted", { status: 2 });
  student("s-inactive", { status: 1 });
  student("s-late-enrol", { enrolledAt: at(60) });
}

// ---- 1-5, 7-9, 11. The preview of an open, live lecture ------------------------------------

test("1. a new register: effective schedule and grace from the lecture and class (as ensureRegister); nothing created", async () => {
  reset({ grace: 7 });
  student("s1");
  const p = await run();
  assert.deepEqual(p.register, { exists: false, version: 0, scheduledStartAt: START, scheduledEndAt: at(120), graceMinutes: 7, finalized: false, finalizedAt: null });
  assert.deepEqual(p.lecture, { lectureId: L1, status: 0, classStatus: "SCHEDULED", date: START, endDate: at(120) });
  assert.equal(p.classification, "LIVE");
  assert.deepEqual(p.summary, {
    rosterSize: 1, eligibleStudents: 1, unknownEligibilityStudents: 0, studentsWithRecord: 0, automaticAbsent: 1, manualReview: 0,
    notEligibleWithoutRecord: 0, recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 },
  });
  assert.deepEqual(p.readiness, {
    ready: true, schedule: { allowed: true, basis: "SCHEDULED_END_PASSED" }, blockers: [], activeSessions: { active: false, count: 0 },
    rosterLimit: 500, rosterLimitExceeded: false, evidenceComplete: true,
  });
  assert.match(p.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(p.fingerprintVersion, 1);
  assert.deepEqual(pg.committed.registers, {}, "27. no register created");
});

test("2, 4, 5, 7, 8, 9, 11. an open register: counts partition the roster exactly once; record statuses; automatic ABSENT", async () => {
  reset();
  mixedClass();
  const p = await run();
  assert.equal(p.register.exists, true);
  assert.equal(p.register.version, 1);
  assert.equal(p.classification, "LIVE");
  assert.deepEqual(p.summary, {
    rosterSize: 12,
    // ELIGIBLE at the start: the 4 recorded students and the 2 no-shows.
    eligibleStudents: 6,
    unknownEligibilityStudents: 1,
    studentsWithRecord: 4,
    automaticAbsent: 2, // s-no-show-1, s-no-show-2 (never the existing ABSENT record)
    manualReview: 1, // s-unknown
    // NOT_APPROVED, removed before the start, deleted, inactive, enrolled after the start.
    notEligibleWithoutRecord: 5,
    recordStatus: { PRESENT: 1, LATE: 1, ABSENT: 1, EXCUSED: 1 },
  });
  const s = p.summary;
  assert.equal(s.studentsWithRecord + s.automaticAbsent + s.manualReview + s.notEligibleWithoutRecord, s.rosterSize);
  assert.equal(p.readiness.ready, true);

  // The same numbers as the register view's own absence preview.
  const view = await attendanceService.getRegister(T1, L1, { env: ENV, now: NOW });
  assert.equal(view.absencePreview.absentStudentIds.length, s.automaticAbsent);
  assert.equal(view.absencePreview.manualReviewStudentIds.length, s.manualReview);
  assert.equal(view.absencePreview.eligibleCount, s.eligibleStudents);
});

test("3. a finalized register: its frozen schedule and grace (not the lecture's), ALREADY_FINALIZED only", async () => {
  reset({ grace: 10 });
  student("s1");
  register({ scheduledStartAt: at(-15), scheduledEndAt: at(90), graceMinutes: 3, finalizedAt: at(150), finalizedByTeacherId: T1, version: 2 });
  pg.committed.sessions["sess-a"].isActive = true; // not reported as a blocker once finalized
  const p = await run();
  assert.deepEqual(p.register, { exists: true, version: 2, scheduledStartAt: at(-15), scheduledEndAt: at(90), graceMinutes: 3, finalized: true, finalizedAt: at(150) });
  assert.deepEqual(p.readiness.blockers, ["ALREADY_FINALIZED"]);
  assert.equal(p.readiness.ready, false);
  assert.deepEqual([p.summary.automaticAbsent, p.summary.manualReview, p.summary.notEligibleWithoutRecord], [0, 0, 0]);
});

// ---- 6, 10. UNKNOWN and historical ----------------------------------------------------------

test("6. UNKNOWN approval at the start is manual review, never automatic ABSENT, and does not block by itself", async () => {
  reset();
  student("s-unknown", { broken: true });
  const p = await run();
  assert.deepEqual([p.summary.manualReview, p.summary.automaticAbsent, p.summary.unknownEligibilityStudents], [1, 0, 1]);
  assert.equal(p.readiness.ready, true);
});

test("10. a historical lecture is previewed with the historical representation rule (D2)", async () => {
  reset({ date: new Date("2026-08-10T12:30:00Z"), endDate: new Date("2026-08-10T14:30:00Z") });
  student("s-backfilled");
  student("s-visit-only");
  visit("s-backfilled", new Date("2026-08-10T12:35:00Z"));
  visit("s-visit-only", new Date("2026-08-10T12:35:00Z"));
  register({ scheduledStartAt: new Date("2026-08-10T12:30:00Z"), scheduledEndAt: new Date("2026-08-10T14:30:00Z") });
  seedRecord("s-backfilled", { status: "PRESENT", statusSource: "BACKFILL", firstOnlineAt: new Date("2026-08-10T12:40:00Z"), autoStatus: "PRESENT" });
  const p = await run();
  assert.equal(p.classification, "HISTORICAL");
  // BACKFILL represents (historical rule) even with a later firstOnlineAt; the visit-only student is pending.
  assert.deepEqual([p.evidence.pendingOnlineEvidence, p.evidence.complete], [1, false]);
  assert.deepEqual(p.readiness.blockers, ["EVIDENCE_PENDING"]);
});

// ---- 12-17. Blockers -----------------------------------------------------------------------------

test("12. an active session blocks (D3) and is reported as a count only", async () => {
  reset();
  student("s1");
  pg.committed.sessions["sess-b"].isActive = true;
  const p = await run();
  assert.deepEqual(p.readiness.activeSessions, { active: true, count: 1 });
  assert.deepEqual(p.readiness.blockers, ["SESSION_ACTIVE"]);
  assert.ok(!JSON.stringify(p).includes("sess-b"));
});

test("13. pending teacher reviews are counted and never block (D1)", async () => {
  reset();
  register();
  student("s1");
  seedRecord("s1", teacherRecord("ABSENT", { firstQrAt: at(20), autoStatus: "LATE", pendingReviewSince: at(21) }));
  const p = await run();
  assert.equal(p.evidence.pendingReviews, 1);
  assert.equal(p.readiness.ready, true);
  assert.deepEqual(p.readiness.blockers, []);
});

test("14, 15. pending eligible evidence and unknown-approval evidence block readiness", async () => {
  reset();
  register();
  student("s-pending-evidence");
  visit("s-pending-evidence", at(3)); // no record: not represented
  student("s-unknown-visit", { broken: true });
  visit("s-unknown-visit", at(3));
  const p = await run();
  assert.deepEqual(p.evidence, { pendingOnlineEvidence: 1, unknownApprovalEvidence: 1, pendingReviews: 0, complete: false });
  assert.deepEqual(p.readiness.blockers, ["EVIDENCE_PENDING", "UNKNOWN_EVIDENCE"]);
  assert.equal(p.readiness.evidenceComplete, false);
  assert.equal(p.readiness.ready, false);
});

test("readiness reasons from finalizationReadiness: not started, end not passed, completion required, cancelled", async () => {
  reset();
  test.mock.timers.setTime(at(-1).getTime());
  assert.deepEqual((await run()).readiness.blockers, ["LECTURE_NOT_STARTED"]);
  test.mock.timers.setTime(at(60).getTime());
  assert.deepEqual((await run()).readiness.blockers, ["SCHEDULED_END_NOT_PASSED"]);
  pg.committed.lectures[L1].classStatus = "COMPLETED";
  assert.deepEqual((await run()).readiness.schedule, { allowed: true, basis: "LECTURE_COMPLETED" });
  pg.committed.lectures[L1].classStatus = "SCHEDULED";
  pg.committed.lectures[L1].endDate = null;
  assert.deepEqual((await run()).readiness.blockers, ["COMPLETION_REQUIRED"]);
  pg.committed.lectures[L1].classStatus = "CANCELLED";
  assert.deepEqual((await run()).readiness.blockers, ["LECTURE_CANCELLED"]);
});

test("16. missing or invalid configuration fails closed (503) before any read; invalid ids 400; missing / deleted / foreign lecture 404", async () => {
  reset();
  const original = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(run({}, { ATTENDANCE_EVIDENCE_STARTED_AT: ENV.ATTENDANCE_EVIDENCE_STARTED_AT }), (e) => e.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED" && e.statusCode === 503);
    await assert.rejects(run({}, { APPROVAL_FEATURE_STARTED_AT: ENV.APPROVAL_FEATURE_STARTED_AT }), (e) => e.code === "ATTENDANCE_EVIDENCE_NOT_CONFIGURED" && e.statusCode === 503);
    await assert.rejects(run({}, { ...ENV, APPROVAL_FEATURE_STARTED_AT: "2026-07-28" }), (e) => e.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED");
  } finally {
    console.warn = original;
  }
  assert.deepEqual(calls, []);
  for (const [field, value] of [["teacherId", ""], ["lectureId", "  "], ["lectureId", "x".repeat(192)], ["teacherId", 5]]) {
    await assert.rejects(run({ [field]: value }), (e) => e.code === "VALIDATION_ERROR" && e.details.field === field);
  }
  await assert.rejects(preview.getLectureAttendanceFinalizationPreview({ teacherId: T2, lectureId: L1 }, { env: ENV }), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
  pg.committed.lectures[L1].status = 1;
  await assert.rejects(run(), (e) => e.code === "LECTURE_NOT_FOUND");
  await assert.rejects(run({ lectureId: "missing" }), (e) => e.code === "LECTURE_NOT_FOUND");
});

test("17. more than 500 candidates blocks readiness (500 does not)", async () => {
  reset();
  for (let i = 0; i < 500; i += 1) student(`s${String(i).padStart(4, "0")}`);
  let p = await run();
  assert.deepEqual([p.summary.rosterSize, p.readiness.rosterLimitExceeded, p.readiness.ready], [500, false, true]);
  student("s0500");
  p = await run();
  assert.deepEqual([p.summary.rosterSize, p.readiness.rosterLimitExceeded, p.readiness.ready], [501, true, false]);
  assert.deepEqual(p.readiness.blockers, ["ROSTER_LIMIT_EXCEEDED"]);
  assert.equal(preview.FINALIZATION_ROSTER_LIMIT, 500);
});

// ---- 18-25. Fingerprint through the service ----------------------------------------------------

test("18. the fingerprint is deterministic for identical inputs and independent of row order", async () => {
  reset();
  mixedClass();
  const a = await fp();
  assert.equal(await fp(), a);
  // Reinsert the same rows in reverse order.
  pg.committed.students = Object.fromEntries(Object.entries(pg.committed.students).reverse());
  pg.committed.enrolments.reverse();
  pg.committed.history.reverse();
  pg.committed.records = Object.fromEntries(Object.entries(pg.committed.records).reverse());
  assert.equal(await fp(), a);
});

test("19-24. the fingerprint changes with each decision-relevant input", async () => {
  const change = async (label, mutate, { before } = {}) => {
    reset();
    mixedClass();
    if (before) before();
    const a = await fp();
    mutate();
    assert.notEqual(await fp(), a, label);
  };
  await change("19. lecture start", () => { pg.committed.lectures[L1].date = at(-1); });
  await change("19. lecture end", () => { pg.committed.lectures[L1].endDate = at(110); });
  await change("19. register start", () => { pg.committed.registers[L1].scheduledStartAt = at(-1); });
  await change("19. register end", () => { pg.committed.registers[L1].scheduledEndAt = at(119); });
  await change("20. register version", () => { pg.committed.registers[L1].version = 2; });
  await change("21. grace", () => { pg.committed.registers[L1].graceMinutes = 11; });
  await change("21. class grace without a register", () => { pg.committed.classes[C1].attendanceGraceMinutes = 11; }, { before: () => { delete pg.committed.registers[L1]; } });
  await change("22. record status", () => { Object.assign(pg.committed.records[`${L1}:s-absent`], { status: "EXCUSED", teacherStatus: "EXCUSED" }); });
  await change("22. record version", () => { pg.committed.records[`${L1}:s-late`].version = 2; });
  await change("22. a new record", () => { seedRecord("s-no-show-1", teacherRecord("PRESENT")); });
  await change("23. eligibility: enrolment removed before the start", () => { pg.committed.enrolments.find((e) => e.studentId === "s-no-show-1").removedAt = local(at(-10)); });
  await change("23. eligibility: approval becomes unknown", () => { pg.committed.students["s-no-show-2"].confirmedAt = new Date("2026-08-03T00:00:00Z"); });
  await change("23. eligibility: student deleted", () => { pg.committed.students["s-no-show-2"].status = 2; });
  await change("24. pending evidence appears", () => { visit("s-no-show-1", at(5)); });
  await change("24. unknown evidence appears", () => { visit("s-unknown", at(5)); });
  await change("24. earlier pending visit", () => { visit("s-no-show-1", at(1)); }, { before: () => { visit("s-no-show-1", at(5)); } });
  await change("readiness: lecture completed", () => { pg.committed.lectures[L1].classStatus = "COMPLETED"; });
  await change("active session", () => { pg.committed.sessions["sess-a"].isActive = true; });
  await change("lecture cancelled", () => { pg.committed.lectures[L1].classStatus = "CANCELLED"; });
});

test("25. QR closure and display-only data do not change the fingerprint", async () => {
  reset();
  mixedClass();
  const a = await fp();
  pg.committed.qrClosures[L1] = { lectureId: L1, closedAt: at(100), closedByTeacherId: T1 };
  assert.equal(await fp(), a, "QR closure (D7)");
  pg.committed.lectures[L1].title = "Renamed";
  pg.committed.students["s-no-show-1"].name = "Another name";
  pg.committed.students["s-no-show-1"].registrationNumber = "REG-CHANGED";
  pg.committed.sessions["sess-b"].startedAt = at(31);
  assert.equal(await fp(), a, "title, names, registration numbers, inactive session times");
  // A visit that changes nothing (later than the represented one).
  visit("s-present", at(50));
  assert.equal(await fp(), a, "a later duplicate visit");
});

// ---- 26-29. Read only and sanitized ----------------------------------------------------------------

test("26, 27, 28. read only: zero writes, no transaction or lock, no register, records / audits / reviews unchanged", async () => {
  reset();
  student("s1");
  student("s2");
  visit("s1", at(3));
  const before = snapshot();
  await run();
  assert.equal(snapshot(), before);
  assert.equal(pg.transactions.length, 0);
  assert.deepEqual(pg.held, []);
  assert.deepEqual(pg.committed.registers, {});
  assert.ok(calls.length > 0 && calls.every((c) => /^\w+\.(findMany|findFirst|findUnique)$/.test(c)), calls.join(","));
  assert.ok(!pg.log.some((e) => /^tx\d|insert:|update:|audit:|lock:/.test(e)), pg.log.join(","));

  reset();
  register();
  student("s1");
  seedRecord("s1", teacherRecord("ABSENT", { firstQrAt: at(20), autoStatus: "LATE", pendingReviewSince: at(21) }));
  const withReview = snapshot();
  await run();
  assert.equal(snapshot(), withReview, "the review and its record untouched");
});

test("29. sanitized: no names, registration numbers, student / record / session / visit ids in the response; nothing logged", async () => {
  reset();
  mixedClass();
  pg.committed.sessions["sess-a"].isActive = true;
  visit("s-no-show-1", at(4));
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...args) => lines.push(args.join(" "));
  let p;
  try {
    p = await run();
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(lines, []);
  const json = JSON.stringify(p);
  for (const secret of ["Name of", "REG-", "s-no-show", "s-present", "rec-", "sess-a", "visit-", T1, "teacher"]) assert.ok(!json.includes(secret), secret);
  assert.deepEqual(Object.keys(p).sort(), ["classification", "evidence", "fingerprint", "fingerprintVersion", "lecture", "readiness", "register", "summary"]);
});

test("static guard: the preview reads only through getRegister; no write, lock, transaction, raw SQL, reconciliation, backfill or finalization write", () => {
  const raw = fs.readFileSync(path.join(root, "services/lecture-attendance-finalization-preview-service.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of [
    /\bprisma\b/, /runAttendanceTransaction/, /\$transaction|\$queryRaw|\$executeRaw/, /ensureRegister/, /insert\w*IfAbsent/, /\block[A-Z]\w*\(/,
    /beginWrites/, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/, /applyEvidence|writeEvidenceAudit|recordOnlineEvidence/,
    /reconcile|backfill/i, /finalizedAt\s*:\s*(new Date|now\b|options|input)/, /finalizedByTeacherId/, /FINALIZE_ABSENT|FINALIZED"/, /console\./,
    /setTeacherAttendanceStatus|acceptEvidence|dismissEvidence|closeQrAttendance|recordQrScan/,
  ]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, [
    "@/lib/attendance/config", "@/lib/attendance/finalization", "@/lib/attendance/finalization-fingerprint",
    "@/lib/attendance/service-errors", "@/services/lecture-attendance-service",
  ]);
  const fromService = code.match(/import\s*\{([^}]*)\}\s*from\s+"@\/services\/lecture-attendance-service"/)[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(fromService, ["getRegister", "type RegisterView"]);
  const fingerprint = fs.readFileSync(path.join(root, "lib/attendance/finalization-fingerprint.ts"), "utf8");
  assert.doesNotMatch(fingerprint.replace(/\/\*[\s\S]*?\*\//g, ""), /prisma|process\.env|Date\.now|new Date\(|console\./);
});
