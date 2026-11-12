/*
 * Stage 5.4f-3: online attendance gap report
 * (services/lecture-attendance-gap-report-service.ts). Read only.
 *
 *   npm run test:attendance-gap-report
 *
 * No database: the real service runs through tsx against the in-memory
 * PostgreSQL model (tests/attendance/helpers/attendance-pg-model.cjs), wrapped
 * in a recorder that fails the test on any write, transaction or raw query.
 * NOT a real-PostgreSQL validation (postponed).
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

const gap = require(path.join(root, "services", "lecture-attendance-gap-report-service.ts"));
const service = require(path.join(root, "services", "lecture-attendance-service.ts"));

// ---- Clock and fixtures ----------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z"); // LIVE: after the evidence start
const at = (minutes) => new Date(START.getTime() + minutes * 60_000);
const NOW = new Date("2026-09-02T08:00:00.000Z");
test.mock.timers.enable({ apis: ["Date"], now: NOW });

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "class-1";
const C2 = "class-2";
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const E = new Date("2026-08-15T00:00:00Z");
const ENV = { APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z", ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z" };
const local = (date) => new Date(date.getTime() + (5 * 60 + 30) * 60_000);

let model;
let pg;
let calls;
let inFlightVisitReads;
let maxInFlightVisitReads;
let visitSeq = 0;

const READS = new Set(["findMany", "findFirst", "findUnique"]);

/** The model's client behind a recorder: every call is logged; anything but a read fails the test. */
function recordingPrisma(inner) {
  return new Proxy(inner, {
    get(target, modelName) {
      if (typeof modelName === "string" && modelName.startsWith("$")) {
        return () => {
          calls.push(modelName);
          throw new Error(`gap report used ${modelName}`);
        };
      }
      const delegate = target[modelName];
      if (!delegate) return undefined;
      return new Proxy(delegate, {
        get(d, method) {
          return async (...args) => {
            calls.push(`${String(modelName)}.${String(method)}`);
            if (!READS.has(method)) throw new Error(`gap report wrote: ${String(modelName)}.${String(method)}`);
            const isVisitRead = modelName === "attendance";
            if (isVisitRead) maxInFlightVisitReads = Math.max(maxInFlightVisitReads, ++inFlightVisitReads);
            try {
              return await d[method](...args);
            } finally {
              if (isVisitRead) inFlightVisitReads -= 1;
            }
          };
        },
      });
    },
  });
}

function reset() {
  model = createPgModel();
  pg = model.pg;
  calls = [];
  inFlightVisitReads = 0;
  maxInFlightVisitReads = 0;
  visitSeq = 0;
  currentPrisma = recordingPrisma(model.prisma);
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.classes[C2] = { id: C2, teacherId: T2, status: 0, attendanceGraceMinutes: 10 };
}

function lecture(id, { classId = C1, date = START, status = 0, classStatus = "COMPLETED" } = {}) {
  pg.committed.lectures[id] = { id, classId, title: id, status, classStatus, date, endDate: null, createdAt: at(-1000) };
  pg.committed.sessions[`sess-${id}`] = { id: `sess-${id}`, lectureId: id };
  pg.committed.sessions[`sess2-${id}`] = { id: `sess2-${id}`, lectureId: id }; // a restart
}

function register(lectureId, extra = {}) {
  const l = pg.committed.lectures[lectureId];
  pg.committed.registers[lectureId] = {
    lectureId, classId: l.classId, scheduledStartAt: l.date, scheduledEndAt: null, graceMinutes: 10,
    finalizedAt: null, finalizedByTeacherId: null, version: 1, createdAt: at(-30), updatedAt: at(-30), ...extra,
  };
}

function student(id, { teacherId = T1, classId = C1, status = 0, confirmationStatus = "APPROVED", broken = false, enrolledAt = new Date("2026-08-05T00:00:00Z") } = {}) {
  pg.committed.students[id] = {
    id, name: `Name of ${id}`, registrationNumber: `REG-${id}`, teacherId, status, confirmationStatus,
    confirmedAt: confirmationStatus === "PENDING" ? null : broken ? new Date("2026-08-02T00:00:00Z") : APPROVED_AT,
    approvedAt: confirmationStatus === "PENDING" ? null : APPROVED_AT,
  };
  if (confirmationStatus !== "PENDING") {
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: confirmationStatus, decidedAt: APPROVED_AT, previousConfirmedAt: null });
  }
  if (enrolledAt) {
    pg.committed.enrolments.push({ id: `e-${id}-${classId}`, studentId: id, classId, assignedAt: local(enrolledAt), removedAt: null, isActive: true });
  }
}

function visit(studentId, lectureId, joinedAt, session = "sess") {
  const id = `visit-${String(++visitSeq).padStart(5, "0")}`;
  pg.committed.visits[id] = { id, studentId, joinedAt, classSessionId: `${session}-${lectureId}` };
  return id;
}

function seedRecord(lectureId, studentId, fields) {
  const l = pg.committed.lectures[lectureId];
  const row = {
    id: `rec-${lectureId}-${studentId}`, lectureId, classId: l.classId, studentId, firstOnlineAt: null, firstQrAt: null, autoStatus: null,
    teacherStatus: null, teacherDecidedAt: null, teacherDecidedById: null, pendingReviewSince: null, version: 1,
    createdAt: at(1), updatedAt: at(1), ...fields,
  };
  model.checkRecord(row);
  pg.committed.records[`${lectureId}:${studentId}`] = row;
  pg.committed.recordAudits.push({ id: `seed-${lectureId}-${studentId}`, lectureAttendanceId: row.id, version: 1, lectureId, studentId,
    action: fields.statusSource === "TEACHER" ? "TEACHER_SET" : "CREATED_AUTO", fromStatus: null, toStatus: row.status });
  return row;
}

const report = (extra = {}, env = ENV, teacherId = T1) => gap.getOnlineAttendanceGapReport({ teacherId, ...extra }, { env });
const ids = (r) => r.lectures.map((l) => l.lectureId);
const byId = (r, id) => r.lectures.find((l) => l.lectureId === id);
const snapshot = () => JSON.stringify(pg.committed);

/** getRegister's own online-evidence check on the same data (its prisma reads, adapted to the model). */
async function registerView(lectureId) {
  const inner = model.prisma;
  const saved = currentPrisma;
  currentPrisma = {
    ...inner,
    lecture: { findFirst: inner.lecture.findFirst },
    classSession: { findMany: async () => [] },
    student: {
      findMany: async ({ where }) =>
        where.id.in.map((id) => pg.committed.students[id]).filter((st) => st && st.teacherId === where.teacherId).map((st) => ({ ...st })),
    },
    classStudent: {
      findMany: async ({ where }) =>
        pg.committed.enrolments.filter((e) => e.classId === where.classId && pg.committed.students[e.studentId]?.teacherId === where.student.teacherId),
    },
    lectureAttendance: { findMany: async ({ where }) => Object.values(pg.committed.records).filter((r) => r.lectureId === where.lectureId) },
  };
  try {
    return await service.getRegister(pg.committed.classes[pg.committed.lectures[lectureId].classId].teacherId, lectureId, { env: ENV, now: NOW });
  } finally {
    currentPrisma = saved;
  }
}

// ---- 1-6. Lecture selection -----------------------------------------------------------------

test("1-6. only the teacher's live, open lectures: deleted, cancelled, historical and finalized excluded", async () => {
  reset();
  lecture("L-live"); // no register yet
  lecture("L-live-open-register");
  register("L-live-open-register");
  lecture("L-scheduled", { classStatus: "SCHEDULED", date: at(60 * 24 * 10) });
  lecture("L-in-progress", { classStatus: "LIVE" });
  lecture("L-at-boundary", { date: E }); // exactly the evidence start: LIVE
  lecture("L-other-teacher", { classId: C2 });
  lecture("L-deleted", { status: 1 });
  lecture("L-cancelled", { classStatus: "CANCELLED" });
  lecture("L-historical", { date: new Date("2026-08-14T23:59:59.999Z") });
  lecture("L-finalized");
  register("L-finalized", { finalizedAt: at(200), finalizedByTeacherId: T1, version: 2 });
  // The register's start decides, not the lecture date.
  lecture("L-register-historical");
  register("L-register-historical", { scheduledStartAt: new Date("2026-08-10T12:30:00Z") });
  lecture("L-register-live", { date: new Date("2026-08-10T12:30:00Z") });
  register("L-register-live", { scheduledStartAt: START });

  const r = await report();
  assert.deepEqual(ids(r), ["L-at-boundary", "L-in-progress", "L-live", "L-live-open-register", "L-register-live", "L-scheduled"]);
  assert.equal(r.nextCursor, null);

  const other = await report({}, ENV, T2);
  assert.deepEqual(ids(other), ["L-other-teacher"]);
  assert.deepEqual((await report({}, ENV, "teacher-none")).lectures, []);
});

test("6. a live lecture with no visits is included with zero counts", async () => {
  reset();
  lecture("L1");
  const r = await report();
  assert.deepEqual(r.lectures, [{ lectureId: "L1", visits: 0, studentsWithVisits: 0, eligibleStudents: 0, representedStudents: 0, pendingStudents: 0, unknownEligibilityStudents: 0 }]);
  assert.deepEqual(r.totals, { lectures: 1, lecturesWithGaps: 0, pendingStudents: 0, unknownEligibilityStudents: 0 });
});

// ---- 7-10. Gap calculation -------------------------------------------------------------------

test("7, 8. pending vs represented, by the evidenceRepresentation rule (record firstOnlineAt <= earliest eligible visit)", async () => {
  reset();
  lecture("L1");
  register("L1");
  for (const id of ["s-none", "s-later", "s-equal", "s-earlier", "s-qr-only", "s-teacher"]) student(id);
  for (const id of ["s-none", "s-later", "s-equal", "s-earlier", "s-qr-only", "s-teacher"]) visit(id, "L1", at(5));
  seedRecord("L1", "s-later", { status: "LATE", statusSource: "AUTO", firstOnlineAt: at(30), autoStatus: "LATE" }); // later than V: pending
  seedRecord("L1", "s-equal", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(5), autoStatus: "PRESENT" }); // = V: represented
  seedRecord("L1", "s-earlier", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(2), autoStatus: "PRESENT" }); // < V: represented
  seedRecord("L1", "s-qr-only", { status: "PRESENT", statusSource: "AUTO", firstQrAt: at(1), autoStatus: "PRESENT" }); // no online evidence: pending
  seedRecord("L1", "s-teacher", { status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", teacherDecidedAt: at(1), teacherDecidedById: T1 }); // LIVE: a decision alone does not represent

  const l = byId(await report(), "L1");
  assert.deepEqual(l, { lectureId: "L1", visits: 6, studentsWithVisits: 6, eligibleStudents: 6, representedStudents: 2, pendingStudents: 4, unknownEligibilityStudents: 0 });

  const view = await registerView("L1");
  assert.equal(view.onlineEvidence.pending.length, l.pendingStudents, "the same answer as the register view");
});

test("9. multiple visits: each student counted once from the earliest eligible visit; every visit counted in `visits`", async () => {
  reset();
  lecture("L1");
  register("L1");
  student("s1", { enrolledAt: at(10) }); // the 5-minute visit is before the enrolment
  visit("s1", "L1", at(5));
  visit("s1", "L1", at(12), "sess2"); // V (a restart session)
  visit("s1", "L1", at(40));
  seedRecord("L1", "s1", { status: "LATE", statusSource: "AUTO", firstOnlineAt: at(12), autoStatus: "LATE" });
  student("s2");
  visit("s2", "L1", at(3));
  visit("s2", "L1", at(3), "sess2");
  const l = byId(await report(), "L1");
  assert.deepEqual(l, { lectureId: "L1", visits: 5, studentsWithVisits: 2, eligibleStudents: 2, representedStudents: 1, pendingStudents: 1, unknownEligibilityStudents: 0 });
});

test("10. eligibility rules preserved: NOT_APPROVED, never enrolled, deleted, UNKNOWN (with and without a record), other teachers' students", async () => {
  reset();
  lecture("L1");
  register("L1");
  student("s-ok");
  student("s-pending", { confirmationStatus: "PENDING" });
  student("s-never", { enrolledAt: null });
  student("s-deleted", { status: 2 });
  student("s-unknown", { broken: true });
  student("s-unknown-recorded", { broken: true });
  student("s-foreign", { teacherId: T2, classId: C2 });
  for (const id of ["s-ok", "s-pending", "s-never", "s-deleted", "s-unknown", "s-unknown-recorded", "s-foreign"]) visit(id, "L1", at(4));
  seedRecord("L1", "s-unknown-recorded", { status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", teacherDecidedAt: at(1), teacherDecidedById: T1 });

  const l = byId(await report(), "L1");
  assert.deepEqual(l, { lectureId: "L1", visits: 6, studentsWithVisits: 6, eligibleStudents: 1, representedStudents: 0, pendingStudents: 1, unknownEligibilityStudents: 1 });

  const view = await registerView("L1");
  assert.equal(view.onlineEvidence.pending.length, l.pendingStudents);
  assert.equal(view.onlineEvidence.unknownVisits.length, l.unknownEligibilityStudents);
});

test("every lecture's counts equal the register view's online-evidence check (no separate algorithm)", async () => {
  reset();
  for (let i = 0; i < 6; i += 1) {
    lecture(`L${i}`);
    if (i % 2) register(`L${i}`);
  }
  const kinds = [{}, { confirmationStatus: "PENDING" }, { broken: true }, { enrolledAt: at(20) }, { status: 1 }, {}];
  for (let s = 0; s < 24; s += 1) {
    student(`s${s}`, kinds[s % kinds.length]);
    for (let i = 0; i < 6; i += 1) {
      if ((s + i) % 3 === 0) continue;
      visit(`s${s}`, `L${i}`, at(((s * 7 + i * 11) % 50) - 10));
      if ((s + i) % 4 === 0) visit(`s${s}`, `L${i}`, at(25), "sess2");
      if ((s * i) % 5 === 1 && pg.committed.registers[`L${i}`] && !pg.committed.records[`L${i}:s${s}`]) {
        seedRecord(`L${i}`, `s${s}`, { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at((s % 3) * 10 - 5), autoStatus: "PRESENT" });
      }
    }
  }
  const r = await report();
  assert.equal(r.lectures.length, 6);
  let sawPending = false;
  for (const l of r.lectures) {
    const view = await registerView(l.lectureId);
    assert.equal(l.pendingStudents, view.onlineEvidence.pending.length, l.lectureId);
    assert.equal(l.unknownEligibilityStudents, view.onlineEvidence.unknownVisits.length, l.lectureId);
    assert.equal(l.representedStudents + l.pendingStudents, l.eligibleStudents);
    if (l.pendingStudents > 0) sawPending = true;
  }
  assert.ok(sawPending, "the fixture exercises pending students");
});

// ---- 11. Configuration -----------------------------------------------------------------------------

test("11. missing or invalid configuration fails closed (503) before any read", async () => {
  reset();
  lecture("L1");
  const original = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(report({}, { ATTENDANCE_EVIDENCE_STARTED_AT: ENV.ATTENDANCE_EVIDENCE_STARTED_AT }), (e) => e.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED" && e.statusCode === 503);
    await assert.rejects(report({}, { APPROVAL_FEATURE_STARTED_AT: ENV.APPROVAL_FEATURE_STARTED_AT }), (e) => e.code === "ATTENDANCE_EVIDENCE_NOT_CONFIGURED" && e.statusCode === 503);
    await assert.rejects(report({}, { ...ENV, ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15" }), (e) => e.code === "ATTENDANCE_EVIDENCE_NOT_CONFIGURED");
  } finally {
    console.warn = original;
  }
  assert.deepEqual(calls, []);
});

// ---- 12-14. Pagination and validation --------------------------------------------------------------

test("12. pagination: lecture-id order, strict continuation, no duplicates or gaps; excluded lectures never take a slot", async () => {
  reset();
  for (const id of ["L5", "L3", "L1", "L4", "L2"]) lecture(id);
  lecture("L2a", { status: 1 }); // deleted, between included ids
  lecture("L3a");
  register("L3a", { finalizedAt: at(200), finalizedByTeacherId: T1, version: 2 });
  lecture("L1a");
  register("L1a", { scheduledStartAt: new Date("2026-08-10T12:30:00Z") }); // HISTORICAL by its register
  lecture("L4a", { date: new Date("2026-08-10T12:30:00Z") }); // HISTORICAL, no register
  lecture("L4b", { classStatus: "CANCELLED" });
  const pages = [];
  let cursor = null;
  do {
    const r = await report({ cursor, limit: 2 });
    pages.push(ids(r));
    cursor = r.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(pages, [["L1", "L2"], ["L3", "L4"], ["L5"]]);
  assert.deepEqual(ids(await report({ cursor: "L3" })), ["L4", "L5"]);
  assert.deepEqual(ids(await report({ cursor: "L5" })), []);
  // Exactly `limit` remaining: no cursor (the extra row is what signals another page).
  const last = await report({ cursor: "L3", limit: 2 });
  assert.deepEqual([ids(last), last.nextCursor], [["L4", "L5"], null]);
});

test("13. default limit 100, maximum 500", async () => {
  reset();
  for (let i = 0; i < 501; i += 1) lecture(`L${String(i).padStart(4, "0")}`);
  const first = await report();
  assert.equal(first.lectures.length, 100);
  assert.equal(first.nextCursor, "L0099");
  const max = await report({ limit: 500 });
  assert.equal(max.lectures.length, 500);
  assert.equal(max.nextCursor, "L0499");
  assert.deepEqual(ids(await report({ cursor: max.nextCursor, limit: 500 })), ["L0500"]);
  assert.deepEqual([gap.GAP_REPORT_DEFAULT_LIMIT, gap.GAP_REPORT_MAX_LIMIT], [100, 500]);
});

test("14. invalid arguments are rejected (400) before any read", async () => {
  reset();
  lecture("L1");
  for (const limit of [0, 501, 1.5, "10", -1, NaN, Infinity]) {
    await assert.rejects(report({ limit }), (e) => e.code === "VALIDATION_ERROR" && e.statusCode === 400 && e.details.field === "limit", String(limit));
  }
  for (const cursor of ["", "   ", "x".repeat(192), 5, {}]) {
    await assert.rejects(report({ cursor }), (e) => e.code === "VALIDATION_ERROR" && e.details.field === "cursor", String(cursor));
  }
  for (const teacherId of ["", undefined, null, 7]) {
    await assert.rejects(gap.getOnlineAttendanceGapReport({ teacherId }, { env: ENV }), (e) => e.code === "VALIDATION_ERROR" && e.details.field === "teacherId", String(teacherId));
  }
  assert.deepEqual(calls, []);
  assert.equal((await report({ limit: null, cursor: null })).lectures.length, 1, "null means the defaults");
});

// ---- 15-17. Read-only guarantee --------------------------------------------------------------------

test("15, 16, 17. read only: zero writes, no transaction, no lock, no register, records / audits / reviews untouched", async () => {
  reset();
  lecture("L-no-register");
  lecture("L-open");
  register("L-open");
  student("s1");
  student("s2");
  visit("s1", "L-no-register", at(3));
  visit("s1", "L-open", at(3));
  visit("s2", "L-open", at(4));
  seedRecord("L-open", "s2", { status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", teacherDecidedAt: at(1), teacherDecidedById: T1,
    firstQrAt: at(20), autoStatus: "LATE", pendingReviewSince: at(21) });
  const before = snapshot();

  const r = await report();
  assert.equal(byId(r, "L-no-register").pendingStudents, 1);
  assert.equal(byId(r, "L-open").pendingStudents, 2);

  assert.equal(snapshot(), before, "committed state byte-identical");
  assert.equal(pg.transactions.length, 0, "no attendance transaction");
  assert.deepEqual(pg.held, [], "no row lock held");
  assert.ok(!pg.log.some((e) => /^tx\d|insert:|update:|audit:|lock:/.test(e)), pg.log.join(","));
  assert.equal(pg.committed.registers["L-no-register"], undefined, "no register created");
  assert.equal(pg.committed.registerAudits.length, 0);
  assert.equal(pg.committed.records["L-open:s2"].pendingReviewSince.toISOString(), at(21).toISOString());
  assert.ok(calls.length > 0 && calls.every((c) => /^\w+\.(findMany|findFirst|findUnique)$/.test(c)), calls.join(","));
});

test("static guard: the service imports no write, lock, transaction, reconciliation or backfill helper", () => {
  const raw = fs.readFileSync(path.join(root, "services/lecture-attendance-gap-report-service.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of [
    /runAttendanceTransaction/, /\$transaction/, /\$queryRaw/, /\$executeRaw/, /ensureRegister/, /insert\w*IfAbsent/,
    /\block[A-Z]\w*\(/, /beginWrites/, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
    /applyEvidence|writeEvidenceAudit|recordOnlineEvidence|dispatchOnlineEvidence/, /reconcile|backfill/i,
    /setTeacherAttendanceStatus|acceptEvidence|dismissEvidence|closeQrAttendance|recordQrScan/, /console\./, /FOR (UPDATE|SHARE|NO KEY|KEY)/,
  ]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["@/lib/attendance/config", "@/lib/attendance/service-errors", "@/lib/prisma", "@/lib/student-confirmation-history", "@/services/lecture-attendance-service"]);
  const fromService = code.match(/import\s*\{([^}]*)\}\s*from\s+"@\/services\/lecture-attendance-service"/)[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(fromService, ["evidenceRepresentation", "type RepresentationStudent"]);
  const prismaCalls = [...code.matchAll(/prisma\.(\w+)\.(\w+)\(/g)].map((m) => m[2]);
  assert.ok(prismaCalls.length >= 6 && prismaCalls.every((m) => m === "findMany"), prismaCalls.join(","));
});

// ---- 18. Sanitized output ---------------------------------------------------------------------------

test("18. sanitized: counts and lecture ids only; nothing logged", async () => {
  reset();
  lecture("L1");
  student("s-secret");
  student("s-unknown", { broken: true });
  const v = visit("s-secret", "L1", at(3));
  visit("s-unknown", "L1", at(3));
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...args) => lines.push(args.join(" "));
  let r;
  try {
    r = await report();
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(lines, []);
  assert.deepEqual(Object.keys(r).sort(), ["lectures", "nextCursor", "totals"]);
  assert.deepEqual(Object.keys(r.lectures[0]).sort(), ["eligibleStudents", "lectureId", "pendingStudents", "representedStudents", "studentsWithVisits", "unknownEligibilityStudents", "visits"]);
  const json = JSON.stringify(r);
  for (const secret of ["s-secret", "s-unknown", "Name of", "REG-", v, "2026-", "T12:", "hash", "token"]) assert.ok(!json.includes(secret), secret);
  assert.deepEqual(r.totals, { lectures: 1, lecturesWithGaps: 1, pendingStudents: 1, unknownEligibilityStudents: 1 });
});

// ---- 19. Large lecture lists -----------------------------------------------------------------------

test("19. large lists: one bounded page query (limit + 1), lectures processed one at a time, visits read only for the page", async () => {
  reset();
  for (let i = 0; i < 1200; i += 1) lecture(`L${String(i).padStart(4, "0")}`);
  student("s1");
  for (let i = 0; i < 1200; i += 1) visit("s1", `L${String(i).padStart(4, "0")}`, at(3));

  let lectureQuery = null;
  const inner = model.prisma.lecture.findMany;
  model.prisma.lecture.findMany = async (args) => {
    lectureQuery = args;
    const rows = await inner(args);
    assert.ok(rows.length <= args.take);
    return rows;
  };
  const r = await report({ limit: 500 });
  assert.equal(r.lectures.length, 500);
  assert.equal(lectureQuery.take, 501);
  assert.deepEqual(lectureQuery.orderBy, { id: "asc" });
  assert.equal(calls.filter((c) => c === "lecture.findMany").length, 1);
  assert.equal(calls.filter((c) => c === "attendance.findMany").length, 500, "one visit read per lecture of the page, none beyond it");
  assert.equal(maxInFlightVisitReads, 1, "never more than one lecture's visits in flight");
  assert.equal(r.totals.pendingStudents, 500);
});
