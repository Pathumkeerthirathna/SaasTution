/*
 * POST /api/lectures/[id]/attendance/grace (Stage 5.7b-2b-2), in-process with
 * the real route, grace service, error handler, same-origin check and
 * middleware; faked edges: session and Prisma (helpers/attendance-route-env.cjs,
 * the in-memory PostgreSQL model). No database; not a real-PostgreSQL
 * validation.
 *
 *   npm run test:attendance-api
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { NextRequest } = require("next/server");

const env = require("./helpers/attendance-route-env.cjs");
const { state, reset, student, register, seedRecord, at, NOW, T1, T2, L1, ctx, post, attendanceState, assertNoStore, BAD_IDS, root, APP_ORIGIN } = env;

const route = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "grace", "route.ts"));
const { middleware } = require(path.join(root, "middleware.ts"));

test.mock.timers.enable({ apis: ["Date"], now: NOW });

const url = (id) => `/api/lectures/${id}/attendance/grace`;
const GRACE = (body, { id = L1, headers } = {}) => route.POST(post(url(id), { body, headers }), ctx(id));
const json = async (response) => ({ status: response.status, body: await response.json(), response });

async function refusedWithoutWrites(promise, status, code, field) {
  const before = attendanceState();
  const { status: actual, body, response } = await json(await promise);
  assert.deepEqual([actual, body.success, body.error.code], [status, false, code], JSON.stringify(body));
  if (field) assert.deepEqual(body.error.details, { field });
  assertNoStore(assert, response);
  assert.equal(attendanceState(), before, "nothing written");
  return body;
}

/** An open register (grace 10, version 1) with one AUTO LATE record (+20 minutes). */
function withRecord() {
  reset();
  student("s1");
  register();
  seedRecord("s1", { status: "LATE", statusSource: "AUTO", firstOnlineAt: at(20), autoStatus: "LATE" });
}

const KEYS = ["changed", "graceMinutes", "lectureId", "recalculatedCount", "registerCreated", "registerVersion"];

test("success: the mapped contract; recalculation reported; no audit or record ids; no-store", async () => {
  withRecord();
  const { status, body, response } = await json(await GRACE({ graceMinutes: 30, expectedVersion: 1, reason: " Late bus. " }));
  assert.equal(status, 200, JSON.stringify(body));
  assertNoStore(assert, response);
  assert.deepEqual(body.data, { lectureId: L1, graceMinutes: 30, registerVersion: 2, changed: true, registerCreated: false, recalculatedCount: 1 });
  assert.deepEqual(Object.keys(body.data).sort(), KEYS);
  const text = JSON.stringify(body);
  for (const id of state.pg.committed.registerAudits.map((a) => a.id).concat(state.pg.committed.recordAudits.map((a) => a.id), ["rec-s1"])) {
    assert.ok(!text.includes(id), `${id} is never returned`);
  }
  const graceAudit = state.pg.committed.registerAudits.find((a) => a.action === "GRACE_CHANGED");
  assert.deepEqual([graceAudit.actorId, graceAudit.reason, graceAudit.fromGraceMinutes, graceAudit.toGraceMinutes], [T1, "Late bus.", 10, 30]);
});

test("no-ops: the stored value, and the class default with no register (nothing created)", async () => {
  withRecord();
  const same = await json(await GRACE({ graceMinutes: 10, expectedVersion: 1 }));
  assert.deepEqual(same.body.data, { lectureId: L1, graceMinutes: 10, registerVersion: 1, changed: false, registerCreated: false, recalculatedCount: 0 });
  reset();
  const before = attendanceState();
  const none = await json(await GRACE({ graceMinutes: 10, expectedVersion: 0 }));
  assert.deepEqual(none.body.data, { lectureId: L1, graceMinutes: 10, registerVersion: 0, changed: false, registerCreated: false, recalculatedCount: 0 });
  assert.equal(attendanceState(), before);
  const created = await json(await GRACE({ graceMinutes: 20, expectedVersion: 0 }));
  assert.deepEqual([created.status, created.body.data.registerCreated, created.body.data.registerVersion], [200, true, 2]);
});

test("error mappings: reason 400, 404, cancelled / finalized / stale / busy 409; nothing written", async () => {
  withRecord();
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 1 }), 400, "ATTENDANCE_REASON_REQUIRED");
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 1, reason: "   " }), 400, "ATTENDANCE_REASON_REQUIRED");
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 2, reason: "x" }), 409, "ATTENDANCE_REGISTER_CHANGED");
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 0, reason: "x" }), 409, "ATTENDANCE_REGISTER_CHANGED");
  state.session = { role: "TEACHER", userId: T2 };
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 1, reason: "x" }), 404, "LECTURE_NOT_FOUND");
  state.session = { role: "TEACHER", userId: T1 };
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 0, reason: "x" }, { id: "no-such-lecture" }), 404, "LECTURE_NOT_FOUND");
  state.pg.held.push({ row: `register:${L1}`, owner: "elsewhere", mode: "KEY_SHARE" });
  state.pg.failWhenBlocked = true;
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 1, reason: "x" }), 409, "ATTENDANCE_BUSY");
  state.pg.held = [];
  state.pg.failWhenBlocked = false;
  state.pg.committed.lectures[L1].classStatus = "CANCELLED";
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 1, reason: "x" }), 409, "LECTURE_CANCELLED");
  state.pg.committed.lectures[L1].status = 1;
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 1, reason: "x" }), 404, "LECTURE_NOT_FOUND");

  reset();
  register({ finalizedAt: at(150), finalizedByTeacherId: T1, version: 2 });
  await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 2, reason: "x" }), 409, "ATTENDANCE_REGISTER_FINALIZED");
});

test("strict body: unknown fields (teacherId included), invalid values and bad JSON are 400; nothing written", async () => {
  withRecord();
  for (const [body, code, field] of [
    [{ graceMinutes: 30, expectedVersion: 1, reason: "x", teacherId: T1 }, "VALIDATION_ERROR", "body"],
    [{ graceMinutes: 30, expectedVersion: 1, classId: "class-1" }, "VALIDATION_ERROR", "body"],
    [{ expectedVersion: 1 }, "VALIDATION_ERROR", "graceMinutes"],
    [{ graceMinutes: -1, expectedVersion: 1 }, "VALIDATION_ERROR", "graceMinutes"],
    [{ graceMinutes: 241, expectedVersion: 1 }, "VALIDATION_ERROR", "graceMinutes"],
    [{ graceMinutes: 10.5, expectedVersion: 1 }, "VALIDATION_ERROR", "graceMinutes"],
    [{ graceMinutes: "30", expectedVersion: 1 }, "VALIDATION_ERROR", "graceMinutes"],
    [{ graceMinutes: null, expectedVersion: 1 }, "VALIDATION_ERROR", "graceMinutes"],
    [{ graceMinutes: 30 }, "VALIDATION_ERROR", "expectedVersion"],
    [{ graceMinutes: 30, expectedVersion: -1 }, "VALIDATION_ERROR", "expectedVersion"],
    [{ graceMinutes: 30, expectedVersion: null }, "VALIDATION_ERROR", "expectedVersion"],
    [{ graceMinutes: 30, expectedVersion: 1, reason: 7 }, "VALIDATION_ERROR", "reason"],
    [{ graceMinutes: 30, expectedVersion: 1, reason: "x".repeat(501) }, "VALIDATION_ERROR", "reason"],
    ["[]", "VALIDATION_ERROR", "body"],
    ["{bad", "INVALID_JSON"],
    ["", "INVALID_JSON"],
  ]) {
    await refusedWithoutWrites(GRACE(body), 400, code, field);
  }
  for (const id of BAD_IDS) await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 1 }, { id }), 400, "VALIDATION_ERROR", "lectureId");
});

test("same-origin before authentication (403); 401 without a teacher session (middleware and route)", async () => {
  withRecord();
  const sessions = state.calls.session;
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.example" }, { Origin: "null" }]) {
    await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 1, reason: "x" }, { headers }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  const noOrigin = new Request(`${APP_ORIGIN}${url(L1)}`, { method: "POST", body: JSON.stringify({ graceMinutes: 30, expectedVersion: 1 }) });
  assert.equal((await route.POST(noOrigin, ctx(L1))).status, 403);
  assert.equal(state.calls.session, sessions, "refused before authentication");
  for (const headers of [{}, { cookie: "teacher_session=not-a-jwt" }]) {
    assert.equal((await middleware(new NextRequest(`${APP_ORIGIN}${url(L1)}`, { method: "POST", headers }))).status, 401);
  }
  for (const session of [null, { role: "STUDENT", userId: "s1" }]) {
    state.session = session;
    await refusedWithoutWrites(GRACE({ graceMinutes: 30, expectedVersion: 1, reason: "x" }), 401, "UNAUTHORIZED");
  }
});
