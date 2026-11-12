/*
 * GET /api/lectures/[id]/attendance (Stage 5.5c), in-process with the real
 * route, getRegister, error handler and middleware; faked edges: session and
 * Prisma (helpers/attendance-route-env.cjs). Also: the middleware's 401 for
 * all four attendance routes. No database.
 *
 *   npm run test:attendance-api
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const env = require("./helpers/attendance-route-env.cjs");
const { state, reset, student, visit, register, seedRecord, teacherRecord, at, NOW, T2, L1, ctx, get, attendanceState, assertNoStore, BAD_IDS, withEnv, root, APP_ORIGIN } = env;

const { NextRequest } = require("next/server");
const route = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "route.ts"));
const { middleware } = require(path.join(root, "middleware.ts"));

test.mock.timers.enable({ apis: ["Date"], now: NOW });

const GET = (id = L1, headers) => route.GET(get(`/api/lectures/${id}/attendance`, headers), ctx(id));

// ---- Middleware (all four attendance routes) ----------------------------------------------

test("middleware: no cookie or an invalid token is 401 for every attendance route", async () => {
  const routes = [
    ["GET", `/api/lectures/${L1}/attendance`],
    ["POST", `/api/lectures/${L1}/attendance/reconcile`],
    ["GET", `/api/lectures/${L1}/attendance/finalization`],
    ["POST", `/api/lectures/${L1}/attendance/finalize`],
  ];
  for (const [method, url] of routes) {
    const none = await middleware(new NextRequest(`${APP_ORIGIN}${url}`, { method }));
    assert.equal(none.status, 401, url);
    assert.equal((await none.json()).error.code, "UNAUTHORIZED");
    const bad = await middleware(new NextRequest(`${APP_ORIGIN}${url}`, { method, headers: { cookie: "teacher_session=not-a-jwt" } }));
    assert.equal(bad.status, 401, url);
  }
});

// ---- Authentication, ownership, ids ---------------------------------------------------------

test("401 without a teacher session (none, student, admin); 404 for another teacher's, missing or deleted lecture", async () => {
  reset();
  student("s1");
  for (const session of [null, { role: "STUDENT", userId: "s1" }, { role: "ADMIN", userId: "a1" }]) {
    state.session = session;
    const response = await GET();
    assert.equal(response.status, 401);
    assertNoStore(assert, response);
    assert.equal((await response.json()).error.code, "UNAUTHORIZED");
  }
  state.session = { role: "TEACHER", userId: T2 };
  const foreign = await GET();
  assert.equal(foreign.status, 404);
  assert.deepEqual((await foreign.json()).error, { message: "Lecture not found.", code: "LECTURE_NOT_FOUND" });

  state.session = { role: "TEACHER", userId: "teacher-1" };
  assert.equal((await GET("missing-lecture")).status, 404);
  state.pg.committed.lectures[L1].status = 1;
  assert.equal((await GET()).status, 404);
});

test("lecture id (D2): blank, whitespace or over 191 characters is 400 before any read; any other non-empty id reaches the service", async () => {
  reset();
  for (const id of BAD_IDS) {
    const response = await GET(id);
    assert.equal(response.status, 400, JSON.stringify(id));
    assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
  }
  assert.ok(!state.pg.log.length);
  // A non-UUID id (the fixture's) and a UUID both pass the route's check; the service decides.
  assert.equal((await GET(L1)).status, 200);
  assert.equal((await GET("6f1c2a3e-1b2c-4d5e-8f90-123456789abc")).status, 404);
  assert.equal((await GET(`  ${L1}  `)).status, 200, "trimmed");
});

// ---- The teacher-facing contract (D4) ----------------------------------------------------------

test("the trimmed contract: every field, names and registration numbers included, ISO dates", async () => {
  reset();
  register();
  student("s-present");
  seedRecord("s-present", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(2), autoStatus: "PRESENT" });
  visit("s-present", at(2));
  student("s-review");
  seedRecord("s-review", teacherRecord("ABSENT", { firstQrAt: at(20), autoStatus: "LATE", pendingReviewSince: at(21) }));
  student("s-no-show");
  student("s-unknown", { broken: true });
  visit("s-unknown", at(3));
  state.pg.committed.sessions["sess-a"].isActive = true;

  const response = await GET();
  assert.equal(response.status, 200);
  assertNoStore(assert, response);
  const { success, data } = await response.json();
  assert.equal(success, true);

  assert.deepEqual(Object.keys(data).sort(), ["absencePreview", "activeSessions", "classification", "configuration", "finalization", "lecture", "onlineEvidence", "qr", "register", "students", "summary"]);
  assert.deepEqual(data.lecture, { id: L1, classId: "class-1", title: "Kinematics", classStatus: "SCHEDULED", date: "2026-09-01T12:30:00.000Z", endDate: "2026-09-01T14:30:00.000Z" });
  assert.deepEqual(data.register, {
    lectureId: L1, exists: true, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: "2026-09-01T14:30:00.000Z",
    graceMinutes: 10, version: 1, finalized: false, finalizedAt: null,
  });
  assert.deepEqual(data.configuration, { approval: "OK", evidence: "OK" });
  assert.equal(data.classification, "LIVE");
  assert.deepEqual(data.activeSessions, { active: true, count: 1 });
  assert.deepEqual(data.finalization, { readiness: { allowed: true, basis: "SCHEDULED_END_PASSED" }, configured: true });
  // Stage 5.7b-3b: this environment has no STUDENT_QR_SECRET, so a scan would be 503: the window shows CLOSED (not closed by the teacher).
  assert.deepEqual(data.qr, { closed: false, closedAt: null, opensAt: at(-30).toISOString(), window: "CLOSED" });
  assert.deepEqual(data.summary, { students: 4, withRecord: 2, recordStatus: { PRESENT: 1, LATE: 0, ABSENT: 1, EXCUSED: 0 }, pendingReviews: 1 });
  assert.deepEqual(data.absencePreview, { automaticAbsentStudentIds: ["s-no-show"], manualReviewStudentIds: ["s-unknown"], eligibleCount: 3, unknownEligibilityCount: 1, absentCreatedCount: 1 });
  assert.deepEqual(data.onlineEvidence, { complete: false, pending: [], unknownVisits: [{ studentId: "s-unknown", earliestUnknownVisitAt: at(3).toISOString() }] });

  const byId = Object.fromEntries(data.students.map((s) => [s.studentId, s]));
  assert.deepEqual(Object.keys(byId).sort(), ["s-no-show", "s-present", "s-review", "s-unknown"]);
  assert.deepEqual(byId["s-review"], {
    studentId: "s-review", name: "Name of s-review", registrationNumber: "REG-s-review",
    eligibility: { outcome: "ELIGIBLE", reason: "ELIGIBLE", approvalReason: "KNOWN_APPROVED" },
    absenceDecision: "HAS_RECORD",
    record: { status: "ABSENT", statusSource: "TEACHER", autoStatus: "LATE", teacherStatus: "ABSENT", firstOnlineAt: null, firstQrAt: at(20).toISOString(), teacherDecidedAt: at(130).toISOString(), version: 1 },
    review: { pending: true, since: at(21).toISOString() },
  });
  assert.deepEqual(byId["s-no-show"].record, null);
  assert.deepEqual(byId["s-no-show"].review, { pending: false, since: null });
  assert.equal(byId["s-no-show"].absenceDecision, "CREATE_ABSENT");
  assert.equal(byId["s-unknown"].eligibility.outcome, "UNKNOWN");
});

test("excluded internal fields are never returned (allowlist of every key at every depth)", async () => {
  reset();
  register({ finalizedAt: at(150), finalizedByTeacherId: "teacher-1", version: 2 });
  student("s1");
  seedRecord("s1", teacherRecord("PRESENT", { firstOnlineAt: at(1), autoStatus: "PRESENT", pendingReviewSince: null }));
  visit("s1", at(1));
  state.pg.committed.sessions["sess-a"].isActive = true;
  const response = await GET();
  const text = await response.text();
  const { data } = JSON.parse(text);
  for (const secret of ["sess-a", "rec-s1", "visit-", "finalizedByTeacherId", "teacherDecidedById", "createdAt", "updatedAt", "startedAt", "roster", "records", "reviewQueue", "enrolment"]) {
    assert.ok(!text.includes(secret), secret);
  }
  const allowed = new Set([
    "lecture", "id", "classId", "title", "classStatus", "date", "endDate", "register", "lectureId", "exists", "scheduledStartAt", "scheduledEndAt",
    "graceMinutes", "version", "finalized", "finalizedAt", "configuration", "approval", "evidence", "classification", "students", "studentId",
    "name", "registrationNumber", "eligibility", "outcome", "reason", "approvalReason", "absenceDecision", "record", "status", "statusSource",
    "autoStatus", "teacherStatus", "firstOnlineAt", "firstQrAt", "teacherDecidedAt", "review", "pending", "since", "summary", "withRecord",
    "recordStatus", "PRESENT", "LATE", "ABSENT", "EXCUSED", "pendingReviews", "absencePreview", "onlineEvidence", "complete", "unknownVisits",
    "earliestEligibleVisitAt", "earliestUnknownVisitAt", "activeSessions", "active", "count", "finalization", "readiness", "allowed", "basis",
    "configured", "automaticAbsentStudentIds", "manualReviewStudentIds", "eligibleCount", "unknownEligibilityCount", "absentCreatedCount",
    "qr", "closed", "closedAt", "opensAt", "window",
  ]);
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        assert.ok(allowed.has(key), `unexpected key ${key}`);
        walk(inner);
      }
    }
  };
  walk(data);
  assert.equal(data.register.finalized, true);
  assert.equal(data.absencePreview, null, "finalized: no absence preview");
});

test("configuration missing: still 200, the dependent fields are null and the configuration says why", async () => {
  reset();
  student("s1");
  await withEnv({ APPROVAL_FEATURE_STARTED_AT: undefined, ATTENDANCE_EVIDENCE_STARTED_AT: "invalid" }, async () => {
    const response = await GET();
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.configuration, { approval: "MISSING", evidence: "INVALID" });
    assert.equal(data.classification, null);
    assert.equal(data.absencePreview, null);
    assert.equal(data.onlineEvidence, null);
    assert.equal(data.students[0].eligibility, null);
    assert.equal(data.students[0].absenceDecision, null);
    assert.equal(data.finalization.configured, false);
    assert.equal(data.qr.window, "CLOSED");
    for (const value of ["2026-07-28", "invalid"]) assert.ok(!JSON.stringify(data).includes(value), "no setting values");
  });
});

test("read only: no transaction, no lock, no register created, nothing written", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  const before = attendanceState();
  assert.equal((await GET()).status, 200);
  assert.equal(attendanceState(), before);
  assert.deepEqual(state.pg.committed.registers, {});
  assert.equal(state.pg.transactions.length, 0);
});
