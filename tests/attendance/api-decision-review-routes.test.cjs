/*
 * POST /api/lectures/[id]/attendance/students/[studentId]/decision and
 * .../review (Stage 5.6a), in-process with the real routes, decision and
 * evidence services, error handler, same-origin check and middleware; faked
 * edges: session and Prisma (helpers/attendance-route-env.cjs, the in-memory
 * PostgreSQL model, which also enforces the audit CHECK constraints). No
 * database; the lock tests show the order and waits of the in-memory model,
 * not a real-PostgreSQL concurrency validation.
 *
 *   npm run test:attendance-api
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { NextRequest } = require("next/server");

const env = require("./helpers/attendance-route-env.cjs");
const { state, reset, student, register, seedRecord, teacherRecord, at, NOW, T1, T2, L1, post, attendanceState, assertNoStore, BAD_IDS, root, APP_ORIGIN } = env;

const decisionRoute = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "students", "[studentId]", "decision", "route.ts"));
const reviewRoute = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "students", "[studentId]", "review", "route.ts"));
const { middleware } = require(path.join(root, "middleware.ts"));

test.mock.timers.enable({ apis: ["Date"], now: NOW });

const sctx = (id, studentId) => ({ params: { id, studentId } });
const decisionUrl = (id, studentId) => `/api/lectures/${id}/attendance/students/${studentId}/decision`;
const reviewUrl = (id, studentId) => `/api/lectures/${id}/attendance/students/${studentId}/review`;
const DECIDE = (studentId, body, { id = L1, headers } = {}) => decisionRoute.POST(post(decisionUrl(id, studentId), { body, headers }), sctx(id, studentId));
const REVIEW = (studentId, body, { id = L1, headers } = {}) => reviewRoute.POST(post(reviewUrl(id, studentId), { body, headers }), sctx(id, studentId));
const json = async (response) => ({ status: response.status, body: await response.json(), response });
const tick = () => new Promise((resolve) => setImmediate(resolve));

const record = (studentId) => state.pg.committed.records[`${L1}:${studentId}`] ?? null;
const auditsOf = (studentId) => state.pg.committed.recordAudits.filter((a) => a.studentId === studentId);
const lastAudit = (studentId) => auditsOf(studentId).at(-1);

/** The fixture: the teacher's active student s1, inactive / deleted / another teacher's students, all enrolled in C1. */
function fixture() {
  reset();
  student("s1");
  student("s2");
  student("s-inactive", { status: 1 });
  student("s-deleted", { status: 2 });
  student("s-other", { teacherId: T2 });
}

/** A teacher ABSENT decision with stronger QR evidence waiting for review (version 2). */
const PENDING = () => teacherRecord("ABSENT", { firstQrAt: at(20), autoStatus: "LATE", pendingReviewSince: at(21), version: 2 });

async function refusedWithoutWrites(promise, status, code, field) {
  const before = attendanceState();
  const { status: actual, body, response } = await json(await promise);
  assert.deepEqual([actual, body.success, body.error.code], [status, false, code], JSON.stringify(body));
  if (field) assert.deepEqual(body.error.details, { field });
  assertNoStore(assert, response);
  assert.equal(attendanceState(), before, "nothing written");
  return body;
}

const DECISION_KEYS = ["afterFinalization", "autoStatus", "changed", "lectureId", "pendingReview", "status", "statusSource", "studentId", "teacherStatus", "version"];
const REVIEW_KEYS = ["action", "autoStatus", "lectureId", "pendingReview", "status", "statusSource", "studentId", "teacherStatus", "version"];

// ======================================================================================
// Decision
// ======================================================================================

test("decision: first manual mark without a reason (200); every status; the contract; no record id; no-store", async () => {
  for (const status of ["PRESENT", "LATE", "ABSENT", "EXCUSED"]) {
    fixture();
    const { status: code, body, response } = await json(await DECIDE("s1", { status, expectedVersion: null }));
    assert.equal(code, 200, JSON.stringify(body));
    assertNoStore(assert, response);
    assert.deepEqual(body.data, {
      lectureId: L1, studentId: "s1", status, statusSource: "TEACHER", teacherStatus: status, autoStatus: null,
      pendingReview: false, version: 1, afterFinalization: false, changed: true,
    });
    assert.deepEqual(Object.keys(body.data).sort(), DECISION_KEYS);
    const row = record("s1");
    assert.deepEqual([row.status, row.statusSource, row.teacherDecidedById, row.version], [status, "TEACHER", T1, 1]);
    assert.ok(!JSON.stringify(body).includes(row.id), "the record's row id is never returned");
    assert.deepEqual([lastAudit("s1").action, lastAudit("s1").actorId, lastAudit("s1").reason], ["TEACHER_SET", T1, null]);
  }
});

test("decision: replacing an existing status needs a reason (400 ATTENDANCE_REASON_REQUIRED); with one it succeeds", async () => {
  fixture();
  register();
  seedRecord("s1", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(2), autoStatus: "PRESENT" });
  await refusedWithoutWrites(DECIDE("s1", { status: "ABSENT", expectedVersion: 1 }), 400, "ATTENDANCE_REASON_REQUIRED");
  await refusedWithoutWrites(DECIDE("s1", { status: "ABSENT", expectedVersion: 1, reason: "   " }), 400, "ATTENDANCE_REASON_REQUIRED", undefined);
  const { status, body } = await json(await DECIDE("s1", { status: "ABSENT", expectedVersion: 1, reason: "  Left before the lecture started.  " }));
  assert.equal(status, 200);
  assert.deepEqual([body.data.status, body.data.autoStatus, body.data.version, body.data.changed], ["ABSENT", "PRESENT", 2, true]);
  assert.equal(lastAudit("s1").reason, "Left before the lecture started.", "trimmed by the service");
});

test("decision: confirming an automatic status with the same value still needs a reason (existing rule)", async () => {
  fixture();
  register();
  seedRecord("s1", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(2), autoStatus: "PRESENT" });
  await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: 1 }), 400, "ATTENDANCE_REASON_REQUIRED");
  const ok = await json(await DECIDE("s1", { status: "PRESENT", expectedVersion: 1, reason: "Confirmed." }));
  assert.deepEqual([ok.status, ok.body.data.statusSource, ok.body.data.version], [200, "TEACHER", 2]);
  // The same teacher decision again: a no-op (changed false, nothing written).
  const before = attendanceState();
  const again = await json(await DECIDE("s1", { status: "PRESENT", expectedVersion: 2 }));
  assert.deepEqual([again.status, again.body.data.changed, again.body.data.version], [200, false, 2]);
  assert.equal(attendanceState(), before);
});

test("decision: after finalization even a first mark needs a reason; the finalized register is untouched", async () => {
  fixture();
  register({ finalizedAt: at(150), finalizedByTeacherId: T1, version: 2 });
  const frozen = JSON.stringify(state.pg.committed.registers[L1]);
  await refusedWithoutWrites(DECIDE("s1", { status: "EXCUSED", expectedVersion: null }), 400, "ATTENDANCE_REASON_REQUIRED");
  const { status, body } = await json(await DECIDE("s1", { status: "EXCUSED", expectedVersion: null, reason: "Medical note." }));
  assert.equal(status, 200);
  assert.deepEqual([body.data.afterFinalization, body.data.status], [true, "EXCUSED"]);
  assert.equal(lastAudit("s1").afterFinalization, true);
  assert.equal(JSON.stringify(state.pg.committed.registers[L1]), frozen, "never reopened or changed");
});

test("decision: stale or mismatched expectedVersion is 409 ATTENDANCE_RECORD_CHANGED (never retried)", async () => {
  fixture();
  register();
  seedRecord("s1", teacherRecord("ABSENT", { version: 3 }));
  for (const expectedVersion of [2, 4, null]) {
    await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion, reason: "x" }), 409, "ATTENDANCE_RECORD_CHANGED");
  }
  // No record yet, but the client sent a version.
  await refusedWithoutWrites(DECIDE("s2", { status: "PRESENT", expectedVersion: 1 }), 409, "ATTENDANCE_RECORD_CHANGED");
  assert.equal(state.pg.transactions.filter((t) => t.outcome === "commit").length, 0);
});

test("decision: a record changed by reconciliation / evidence first makes the teacher's request 409 (the version moved)", async () => {
  fixture();
  register();
  seedRecord("s1", { status: "LATE", statusSource: "AUTO", firstOnlineAt: at(15), autoStatus: "LATE" });
  // The teacher saw version 1; evidence (e.g. a reconciliation page) moves the record to version 2 first.
  Object.assign(state.pg.committed.records[`${L1}:s1`], { status: "PRESENT", autoStatus: "PRESENT", firstOnlineAt: at(2), version: 2 });
  await refusedWithoutWrites(DECIDE("s1", { status: "ABSENT", expectedVersion: 1, reason: "x" }), 409, "ATTENDANCE_RECORD_CHANGED");
});

test("decision: invalid status, expectedVersion, reason and body are 400; nothing written", async () => {
  fixture();
  for (const [body, code, field] of [
    [{ status: "HERE", expectedVersion: null }, "VALIDATION_ERROR", "status"],
    [{ status: "present", expectedVersion: null }, "VALIDATION_ERROR", "status"],
    [{ expectedVersion: null }, "VALIDATION_ERROR", "status"],
    [{ status: "PRESENT" }, "VALIDATION_ERROR", "expectedVersion"],
    [{ status: "PRESENT", expectedVersion: -1 }, "VALIDATION_ERROR", "expectedVersion"],
    [{ status: "PRESENT", expectedVersion: 1.5 }, "VALIDATION_ERROR", "expectedVersion"],
    [{ status: "PRESENT", expectedVersion: "1" }, "VALIDATION_ERROR", "expectedVersion"],
    [{ status: "PRESENT", expectedVersion: 0 }, "VALIDATION_ERROR", "expectedVersion"], // the service: versions start at 1
    [{ status: "PRESENT", expectedVersion: null, reason: 5 }, "VALIDATION_ERROR", "reason"],
    [{ status: "PRESENT", expectedVersion: null, reason: "x".repeat(501) }, "VALIDATION_ERROR", "reason"],
    [{ status: "PRESENT", expectedVersion: null, teacherId: T2 }, "VALIDATION_ERROR", "body"],
    [{ status: "PRESENT", expectedVersion: null, studentId: "s2" }, "VALIDATION_ERROR", "body"],
    ["[]", "VALIDATION_ERROR", "body"],
    ["null", "VALIDATION_ERROR", "body"],
    ["{bad", "INVALID_JSON"],
    ["", "INVALID_JSON"],
  ]) {
    await refusedWithoutWrites(DECIDE("s1", body), 400, code, field);
  }
  const noBody = await json(await decisionRoute.POST(post(decisionUrl(L1, "s1")), sctx(L1, "s1")));
  assert.deepEqual([noBody.status, noBody.body.error.code], [400, "INVALID_JSON"]);
});

test("decision: inactive (1) and deleted (2) students are refused with the not-found 404; nothing written", async () => {
  fixture();
  for (const id of ["s-inactive", "s-deleted"]) {
    await refusedWithoutWrites(DECIDE(id, { status: "PRESENT", expectedVersion: null }), 404, "STUDENT_NOT_FOUND");
    await refusedWithoutWrites(DECIDE(id, { status: "PRESENT", expectedVersion: null, reason: "Has a reason." }), 404, "STUDENT_NOT_FOUND");
  }
  // With an existing record (deactivated after it was recorded): still refused.
  register();
  seedRecord("s-inactive", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(2), autoStatus: "PRESENT" });
  await refusedWithoutWrites(DECIDE("s-inactive", { status: "ABSENT", expectedVersion: 1, reason: "x" }), 404, "STUDENT_NOT_FOUND");
  assert.deepEqual(state.pg.committed.registers[L1].version, 1);
});

test("decision: another teacher's student, an unknown student, another teacher's lecture are 404; cancelled 409; deleted lecture 404", async () => {
  fixture();
  await refusedWithoutWrites(DECIDE("s-other", { status: "PRESENT", expectedVersion: null }), 404, "STUDENT_NOT_FOUND");
  await refusedWithoutWrites(DECIDE("missing", { status: "PRESENT", expectedVersion: null }), 404, "STUDENT_NOT_FOUND");
  state.session = { role: "TEACHER", userId: T2 };
  // Another teacher's lecture: the lecture's 404 (it keeps its precedence over the student checks).
  await refusedWithoutWrites(DECIDE("s-other", { status: "PRESENT", expectedVersion: null }), 404, "LECTURE_NOT_FOUND");
  await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: null }), 404, "LECTURE_NOT_FOUND");
  state.session = { role: "TEACHER", userId: T1 };
  state.pg.committed.lectures[L1].classStatus = "CANCELLED";
  await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: null }), 409, "LECTURE_CANCELLED");
  state.pg.committed.lectures[L1].classStatus = "SCHEDULED";
  state.pg.committed.lectures[L1].status = 1;
  await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: null }), 404, "LECTURE_NOT_FOUND");
  assert.deepEqual(state.pg.committed.registers, {}, "no register created by a refused request");
});

test("decision: a never-enrolled active student keeps the existing 409 ATTENDANCE_STUDENT_NOT_ENROLLED", async () => {
  fixture();
  student("s-never", { enrolledAt: null });
  await refusedWithoutWrites(DECIDE("s-never", { status: "PRESENT", expectedVersion: null }), 409, "ATTENDANCE_STUDENT_NOT_ENROLLED");
});

// ======================================================================================
// Review
// ======================================================================================

test("review: ACCEPT with a reason (200): the evidence status becomes the teacher's decision; the contract; no record id", async () => {
  fixture();
  register();
  seedRecord("s1", PENDING());
  const { status, body, response } = await json(await REVIEW("s1", { action: "ACCEPT", expectedVersion: 2, reason: "Verified the QR scan." }));
  assert.equal(status, 200, JSON.stringify(body));
  assertNoStore(assert, response);
  assert.deepEqual(body.data, {
    lectureId: L1, studentId: "s1", action: "ACCEPT", status: "LATE", statusSource: "TEACHER", teacherStatus: "LATE",
    autoStatus: "LATE", pendingReview: false, version: 3,
  });
  assert.deepEqual(Object.keys(body.data).sort(), REVIEW_KEYS);
  assert.ok(!JSON.stringify(body).includes(record("s1").id), "the record's row id is never returned");
  assert.deepEqual([record("s1").pendingReviewSince, record("s1").version], [null, 3]);
  assert.deepEqual([lastAudit("s1").action, lastAudit("s1").fromStatus, lastAudit("s1").toStatus, lastAudit("s1").actorId, lastAudit("s1").reason], ["EVIDENCE_ACCEPTED", "ABSENT", "LATE", T1, "Verified the QR scan."]);
});

test("review: ACCEPT without a reason is 400 ATTENDANCE_REASON_REQUIRED (blank too); nothing written", async () => {
  fixture();
  register();
  seedRecord("s1", PENDING());
  for (const reason of [undefined, null, "", "   "]) {
    await refusedWithoutWrites(REVIEW("s1", { action: "ACCEPT", expectedVersion: 2, ...(reason === undefined ? {} : { reason }) }), 400, "ATTENDANCE_REASON_REQUIRED");
  }
});

test("review: DISMISS without a reason, and with one (200): the status stays; the review is cleared", async () => {
  for (const reason of [undefined, "The scan was a mistake."]) {
    fixture();
    register();
    seedRecord("s1", PENDING());
    const { status, body } = await json(await REVIEW("s1", { action: "DISMISS", expectedVersion: 2, ...(reason ? { reason } : {}) }));
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data, {
      lectureId: L1, studentId: "s1", action: "DISMISS", status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT",
      autoStatus: "LATE", pendingReview: false, version: 3,
    });
    assert.deepEqual([lastAudit("s1").action, lastAudit("s1").fromStatus, lastAudit("s1").toStatus, lastAudit("s1").reason], ["EVIDENCE_DISMISSED", "ABSENT", "ABSENT", reason ?? null]);
  }
});

test("review: nothing pending (no review, no record, no register) is 409 ATTENDANCE_NO_PENDING_REVIEW", async () => {
  fixture();
  await refusedWithoutWrites(REVIEW("s1", { action: "DISMISS", expectedVersion: 1 }), 409, "ATTENDANCE_NO_PENDING_REVIEW"); // no register
  register();
  await refusedWithoutWrites(REVIEW("s1", { action: "DISMISS", expectedVersion: 1 }), 409, "ATTENDANCE_NO_PENDING_REVIEW"); // no record
  seedRecord("s1", teacherRecord("ABSENT", { firstQrAt: at(20), autoStatus: "LATE" }));
  for (const action of ["ACCEPT", "DISMISS"]) {
    await refusedWithoutWrites(REVIEW("s1", { action, expectedVersion: 1, reason: "x" }), 409, "ATTENDANCE_NO_PENDING_REVIEW");
  }
});

test("review: stale expectedVersion is 409 ATTENDANCE_RECORD_CHANGED (also when evidence moved the record first)", async () => {
  fixture();
  register();
  seedRecord("s1", PENDING());
  for (const expectedVersion of [1, 3]) {
    for (const action of ["ACCEPT", "DISMISS"]) {
      await refusedWithoutWrites(REVIEW("s1", { action, expectedVersion, reason: "x" }), 409, "ATTENDANCE_RECORD_CHANGED");
    }
  }
  // Reconciliation records earlier evidence first (version 3): the teacher's version-2 answer is stale.
  Object.assign(state.pg.committed.records[`${L1}:s1`], { firstOnlineAt: at(1), autoStatus: "PRESENT", version: 3 });
  await refusedWithoutWrites(REVIEW("s1", { action: "ACCEPT", expectedVersion: 2, reason: "x" }), 409, "ATTENDANCE_RECORD_CHANGED");
});

test("review: inactive and deleted students are refused (404) even with a pending review on the teacher's lecture", async () => {
  fixture();
  register();
  for (const id of ["s-inactive", "s-deleted"]) {
    seedRecord(id, PENDING());
    for (const action of ["ACCEPT", "DISMISS"]) {
      await refusedWithoutWrites(REVIEW(id, { action, expectedVersion: 2, reason: "x" }), 404, "STUDENT_NOT_FOUND");
    }
    assert.notEqual(record(id).pendingReviewSince, null, "the review stays");
  }
});

test("review: another teacher's student on the teacher's own lecture is refused (404); unknown student 404", async () => {
  fixture();
  register();
  seedRecord("s-other", PENDING());
  for (const action of ["ACCEPT", "DISMISS"]) {
    await refusedWithoutWrites(REVIEW("s-other", { action, expectedVersion: 2, reason: "x" }), 404, "STUDENT_NOT_FOUND");
  }
  await refusedWithoutWrites(REVIEW("missing", { action: "DISMISS", expectedVersion: 2 }), 404, "STUDENT_NOT_FOUND");
});

test("review: another teacher's lecture 404 (precedence over the student check); cancelled 409; deleted lecture 404", async () => {
  fixture();
  register();
  seedRecord("s1", PENDING());
  state.session = { role: "TEACHER", userId: T2 };
  await refusedWithoutWrites(REVIEW("s1", { action: "DISMISS", expectedVersion: 2 }), 404, "LECTURE_NOT_FOUND");
  await refusedWithoutWrites(REVIEW("s-other", { action: "DISMISS", expectedVersion: 2 }), 404, "LECTURE_NOT_FOUND");
  state.session = { role: "TEACHER", userId: T1 };
  state.pg.committed.lectures[L1].classStatus = "CANCELLED";
  await refusedWithoutWrites(REVIEW("s1", { action: "DISMISS", expectedVersion: 2 }), 409, "LECTURE_CANCELLED");
  state.pg.committed.lectures[L1].classStatus = "SCHEDULED";
  state.pg.committed.lectures[L1].status = 1;
  await refusedWithoutWrites(REVIEW("s1", { action: "DISMISS", expectedVersion: 2 }), 404, "LECTURE_NOT_FOUND");
});

test("review: after finalization ACCEPT is allowed with a reason (audited after finalization); the register is untouched", async () => {
  fixture();
  register({ finalizedAt: at(150), finalizedByTeacherId: T1, version: 2 });
  const frozen = JSON.stringify(state.pg.committed.registers[L1]);
  seedRecord("s1", PENDING());
  await refusedWithoutWrites(REVIEW("s1", { action: "ACCEPT", expectedVersion: 2 }), 400, "ATTENDANCE_REASON_REQUIRED");
  const ok = await json(await REVIEW("s1", { action: "ACCEPT", expectedVersion: 2, reason: "Late QR scan verified." }));
  assert.equal(ok.status, 200);
  assert.equal(lastAudit("s1").afterFinalization, true);
  assert.equal(JSON.stringify(state.pg.committed.registers[L1]), frozen);
});

test("review: invalid action, expectedVersion, reason and body are 400; nothing written", async () => {
  fixture();
  register();
  seedRecord("s1", PENDING());
  for (const [body, code, field] of [
    [{ action: "ACCEPTED", expectedVersion: 2, reason: "x" }, "VALIDATION_ERROR", "action"],
    [{ action: "accept", expectedVersion: 2, reason: "x" }, "VALIDATION_ERROR", "action"],
    [{ action: "SET", expectedVersion: 2 }, "VALIDATION_ERROR", "action"],
    [{ expectedVersion: 2 }, "VALIDATION_ERROR", "action"],
    [{ action: "DISMISS" }, "VALIDATION_ERROR", "expectedVersion"],
    [{ action: "DISMISS", expectedVersion: null }, "VALIDATION_ERROR", "expectedVersion"],
    [{ action: "DISMISS", expectedVersion: -1 }, "VALIDATION_ERROR", "expectedVersion"],
    [{ action: "DISMISS", expectedVersion: 2.5 }, "VALIDATION_ERROR", "expectedVersion"],
    [{ action: "DISMISS", expectedVersion: 0 }, "VALIDATION_ERROR", "expectedVersion"],
    [{ action: "DISMISS", expectedVersion: 2, reason: ["x"] }, "VALIDATION_ERROR", "reason"],
    [{ action: "ACCEPT", expectedVersion: 2, reason: "x".repeat(501) }, "VALIDATION_ERROR", "reason"],
    [{ action: "DISMISS", expectedVersion: 2, teacherId: T1 }, "VALIDATION_ERROR", "body"],
    [{ action: "DISMISS", expectedVersion: 2, status: "PRESENT" }, "VALIDATION_ERROR", "body"],
    ["[]", "VALIDATION_ERROR", "body"],
    ["{bad", "INVALID_JSON"],
    ["", "INVALID_JSON"],
  ]) {
    await refusedWithoutWrites(REVIEW("s1", body), 400, code, field);
  }
});

// ======================================================================================
// Shared: identifiers, authentication, same-origin, teacher identity
// ======================================================================================

test("both routes: invalid lecture and student ids are 400 (field lectureId / studentId) before any transaction", async () => {
  fixture();
  for (const id of BAD_IDS) {
    await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: null }, { id }), 400, "VALIDATION_ERROR", "lectureId");
    await refusedWithoutWrites(REVIEW("s1", { action: "DISMISS", expectedVersion: 1 }, { id }), 400, "VALIDATION_ERROR", "lectureId");
    await refusedWithoutWrites(DECIDE(id, { status: "PRESENT", expectedVersion: null }), 400, "VALIDATION_ERROR", "studentId");
    await refusedWithoutWrites(REVIEW(id, { action: "DISMISS", expectedVersion: 1 }), 400, "VALIDATION_ERROR", "studentId");
  }
  assert.equal(state.pg.transactions.length, 0);
  // A padded id is trimmed (the existing lecture-id convention).
  const padded = await json(await decisionRoute.POST(post(decisionUrl(L1, "s1"), { body: { status: "PRESENT", expectedVersion: null } }), sctx(` ${L1} `, " s1 ")));
  assert.equal(padded.status, 200);
  assert.equal(padded.body.data.studentId, "s1");
});

test("both routes: 401 without a teacher session (middleware and route); nothing written", async () => {
  fixture();
  for (const url of [decisionUrl(L1, "s1"), reviewUrl(L1, "s1")]) {
    for (const headers of [{}, { cookie: "teacher_session=not-a-jwt" }]) {
      const response = await middleware(new NextRequest(`${APP_ORIGIN}${url}`, { method: "POST", headers }));
      assert.equal(response.status, 401, url);
    }
  }
  for (const session of [null, { role: "STUDENT", userId: "s1" }, { role: "ADMIN", userId: "a1" }]) {
    state.session = session;
    await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: null }), 401, "UNAUTHORIZED");
    await refusedWithoutWrites(REVIEW("s1", { action: "DISMISS", expectedVersion: 1 }), 401, "UNAUTHORIZED");
  }
});

test("both routes: cross-origin requests are 403 before authentication and before the body is read", async () => {
  fixture();
  const sessions = state.calls.session;
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.example" }, { Origin: "null" }]) {
    await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: null }, { headers }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
    await refusedWithoutWrites(REVIEW("s1", { action: "DISMISS", expectedVersion: 1 }, { headers }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
    await refusedWithoutWrites(DECIDE("s1", "{bad", { headers }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  for (const [route, url] of [[decisionRoute, decisionUrl(L1, "s1")], [reviewRoute, reviewUrl(L1, "s1")]]) {
    const noOrigin = new Request(`${APP_ORIGIN}${url}`, { method: "POST", body: JSON.stringify({}) });
    assert.equal((await route.POST(noOrigin, sctx(L1, "s1"))).status, 403, "missing Origin");
  }
  assert.equal(state.calls.session, sessions, "rejected before authentication");
});

test("both routes: the teacher comes only from the session (a teacherId in the body is refused; T2 cannot act on T1's data)", async () => {
  fixture();
  register();
  seedRecord("s2", PENDING());
  await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: null, teacherId: T1 }), 400, "VALIDATION_ERROR", "body");
  await refusedWithoutWrites(REVIEW("s2", { action: "DISMISS", expectedVersion: 2, teacherId: T1 }), 400, "VALIDATION_ERROR", "body");
  state.session = { role: "TEACHER", userId: T2 };
  await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: null }), 404, "LECTURE_NOT_FOUND");
  await refusedWithoutWrites(REVIEW("s2", { action: "DISMISS", expectedVersion: 2 }), 404, "LECTURE_NOT_FOUND");
  state.session = { role: "TEACHER", userId: T1 };
  const ok = await json(await DECIDE("s1", { status: "PRESENT", expectedVersion: null }));
  assert.equal(ok.status, 200);
  assert.equal(record("s1").teacherDecidedById, T1, "the session's teacher");
});

test("errors are sanitized: no stack, SQL, record or row ids in any refusal", async () => {
  fixture();
  register();
  seedRecord("s1", PENDING());
  const responses = [
    await DECIDE("s1", { status: "PRESENT", expectedVersion: 9, reason: "x" }),
    await REVIEW("s1", { action: "ACCEPT", expectedVersion: 2 }),
    await REVIEW("s-other", { action: "DISMISS", expectedVersion: 2 }),
    await DECIDE("s-deleted", { status: "PRESENT", expectedVersion: null }),
  ];
  for (const response of responses) {
    const text = await response.text();
    for (const secret of [record("s1").id, "rec-", "stack", "SELECT", "prisma", "teacher-2", "Name of"]) {
      assert.ok(!text.includes(secret), `${secret} in ${text}`);
    }
  }
});

// ======================================================================================
// Transaction-safe student checks (in-memory model: order and waits, not real PostgreSQL)
// ======================================================================================

test("both services lock the Student row FOR SHARE first (before the Lecture), and never read the student unlocked", async () => {
  fixture();
  await DECIDE("s1", { status: "PRESENT", expectedVersion: null });
  register();
  seedRecord("s2", PENDING());
  await REVIEW("s2", { action: "DISMISS", expectedVersion: 2 });
  assert.equal(state.pg.transactions.length, 2);
  for (const tx of state.pg.transactions) {
    assert.equal(tx.statements[0], "SET");
    assert.equal(tx.statements[1], "lock:student", JSON.stringify(tx.statements));
    assert.ok(tx.statements.indexOf("lock:student") < tx.statements.indexOf("lock:lecture"));
    assert.ok(!tx.statements.includes("read:student"), JSON.stringify(tx.statements));
    assert.equal(tx.outcome, "commit");
  }
});

test("a deactivation / deletion holding the Student row blocks the action (409 ATTENDANCE_BUSY on timeout); nothing written", async () => {
  fixture();
  register();
  seedRecord("s2", PENDING());
  state.pg.held.push({ row: "student:s1", owner: "deactivation", mode: "NO_KEY_UPDATE" });
  state.pg.held.push({ row: "student:s2", owner: "deletion", mode: "UPDATE" });
  state.pg.failWhenBlocked = true;
  await refusedWithoutWrites(DECIDE("s1", { status: "PRESENT", expectedVersion: null }), 409, "ATTENDANCE_BUSY");
  await refusedWithoutWrites(REVIEW("s2", { action: "DISMISS", expectedVersion: 2 }), 409, "ATTENDANCE_BUSY");
  assert.ok(state.pg.transactions.every((t) => t.outcome === "rollback"));
});

test("a deactivation waits for an action holding the Student lock; one committed first is seen under the lock (404)", async () => {
  fixture();
  const model = state.model;
  let release;
  const gate = new Promise((r) => { release = r; });
  state.pg.beforeStatement = async (label, op) => {
    if (op === "lock:lecture") await gate;
  };
  const deciding = DECIDE("s1", { status: "PRESENT", expectedVersion: null });
  // Bounded: a decision that never locks the Student row fails here instead of hanging.
  for (let i = 0; i < 200 && !state.pg.transactions[0]?.statements.includes("lock:student"); i += 1) await tick();
  if (!state.pg.transactions[0]?.statements.includes("lock:student")) {
    release();
    await deciding;
    assert.fail("the Student row must be locked before the Lecture");
  }
  let deactivated = false;
  const deactivation = model.locks.acquire("student:s1", "deactivation", "NO_KEY_UPDATE").then(() => { deactivated = true; });
  await tick();
  assert.equal(deactivated, false, "the deactivation waits for the decision");
  release();
  state.pg.beforeStatement = null;
  assert.equal((await deciding).status, 200);
  await deactivation;
  assert.equal(deactivated, true, "granted after the commit");
  state.pg.committed.students.s1.status = 1; // the deactivation commits
  model.locks.release("deactivation");
  await refusedWithoutWrites(DECIDE("s1", { status: "ABSENT", expectedVersion: 1, reason: "x" }), 404, "STUDENT_NOT_FOUND");
});
