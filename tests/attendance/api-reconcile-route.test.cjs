/*
 * POST /api/lectures/[id]/attendance/reconcile (Stage 5.5c), in-process with
 * the real route, reconciliation service, error handler and same-origin
 * check; faked edges: session and Prisma (helpers/attendance-route-env.cjs).
 * No database.
 *
 *   npm run test:attendance-api
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const env = require("./helpers/attendance-route-env.cjs");
const { state, reset, student, visit, at, NOW, T2, L1, ctx, post, attendanceState, assertNoStore, BAD_IDS, withEnv, root, APP_ORIGIN } = env;

const route = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "reconcile", "route.ts"));

test.mock.timers.enable({ apis: ["Date"], now: NOW });

const POST = (body, { id = L1, headers } = {}) => route.POST(post(`/api/lectures/${id}/attendance/reconcile`, { body, headers }), ctx(id));
const json = async (response) => ({ status: response.status, body: await response.json() });
const ZERO = { processed: 0, applied: 0, duplicates: 0, ineligible: 0, unknown: 0, inactive: 0, finalizedWithoutRecord: 0, busy: 0, skipped: 0 };

function students(n) {
  for (let i = 0; i < n; i += 1) {
    const id = `s${String(i).padStart(4, "0")}`;
    student(id);
    visit(id, at(3));
  }
}

test("default page of 100 (D1); nextCursor continues the pass; the service's counts returned unchanged", async () => {
  reset();
  students(101);
  const first = await json(await POST(undefined));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data, { lectureId: L1, ...ZERO, processed: 100, applied: 100, nextCursor: "s0099", stoppedBecause: null });
  const second = await json(await POST({ cursor: first.body.data.nextCursor }));
  assert.deepEqual([second.body.data.processed, second.body.data.nextCursor], [1, null]);
  // An empty JSON object is the same as no body.
  reset();
  students(3);
  assert.equal((await json(await POST({}))).body.data.processed, 3);
});

test("explicit limits 1 and 500 accepted; 0, 501, fractional, string, null rejected (400 VALIDATION_ERROR, field limit)", async () => {
  reset();
  students(3);
  const one = await json(await POST({ limit: 1 }));
  assert.deepEqual([one.body.data.processed, one.body.data.nextCursor], [1, "s0000"]);
  reset();
  students(501);
  const max = await json(await POST({ limit: 500 }));
  assert.deepEqual([max.body.data.processed, max.body.data.nextCursor], [500, "s0499"]);

  for (const limit of [0, 501, 1.5, "10", null, -1]) {
    const response = await POST({ limit });
    assert.equal(response.status, 400, JSON.stringify(limit));
    assertNoStore(assert, response);
    assert.deepEqual((await response.json()).error, { message: "Invalid request.", code: "VALIDATION_ERROR", details: { field: "limit" } });
  }
});

test("invalid cursor, unknown fields, invalid JSON and non-object bodies are 400; null cursor is the first page", async () => {
  reset();
  students(2);
  for (const cursor of ["", "   ", "x".repeat(192), 5, {}, ["s1"]]) {
    const { status, body } = await json(await POST({ cursor }));
    assert.equal(status, 400, JSON.stringify(cursor));
    assert.deepEqual(body.error.details, { field: "cursor" });
  }
  const unknown = await json(await POST({ limit: 10, teacherId: T2 }));
  assert.deepEqual([unknown.status, unknown.body.error.code, unknown.body.error.details], [400, "VALIDATION_ERROR", { field: "body" }]);
  for (const raw of ["{not json", "[1,", "{\"limit\": }"]) {
    const { status, body } = await json(await POST(raw));
    assert.deepEqual([status, body.error.code], [400, "INVALID_JSON"], raw);
  }
  for (const raw of ["[]", "\"text\"", "5"]) assert.equal((await POST(raw)).status, 400, raw);
  assert.equal((await json(await POST({ cursor: null }))).body.data.processed, 2);
  assert.equal(state.calls.session > 0, true);
});

test("same-origin (CSRF): cross-site, foreign or missing Origin is 403 before authentication, nothing written", async () => {
  reset();
  students(2);
  const before = attendanceState();
  for (const headers of [
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
    { Origin: "https://evil.example" },
    { Origin: "http://app.example.test" },
    { Origin: "null" },
    { Origin: "" },
  ]) {
    const request = new Request(`${APP_ORIGIN}/api/lectures/${L1}/attendance/reconcile`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", Origin: APP_ORIGIN, ...headers },
      body: "{}",
    });
    if (headers.Origin === "") request.headers.delete("origin");
    const response = await route.POST(request, ctx(L1));
    assert.equal(response.status, 403, JSON.stringify(headers));
    assertNoStore(assert, response);
    assert.equal((await response.json()).error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  assert.equal(state.calls.session, 0, "rejected before authentication");
  assert.equal(attendanceState(), before);
  assert.equal(state.pg.transactions.length, 0);
});

test("authentication and ownership: 401 without a teacher; 404 another teacher's / missing / deleted; bad ids 400", async () => {
  reset();
  students(1);
  state.session = null;
  assert.equal((await POST({})).status, 401);
  state.session = { role: "STUDENT", userId: "s0000" };
  assert.equal((await POST({})).status, 401);
  state.session = { role: "TEACHER", userId: T2 };
  assert.equal((await json(await POST({}))).body.error.code, "LECTURE_NOT_FOUND");
  state.session = { role: "TEACHER", userId: "teacher-1" };
  assert.equal((await POST({}, { id: "missing" })).status, 404);
  for (const id of BAD_IDS) assert.equal((await POST({}, { id })).status, 400, JSON.stringify(id));
  state.pg.committed.lectures[L1].status = 1;
  assert.equal((await POST({})).status, 404);
  assert.equal(state.pg.transactions.length, 0);
});

test("lecture state: cancelled 409, historical 409, missing configuration 503 (setting and status only)", async () => {
  reset();
  students(1);
  state.pg.committed.lectures[L1].classStatus = "CANCELLED";
  assert.deepEqual([(await POST({})).status], [409]);
  state.pg.committed.lectures[L1].classStatus = "COMPLETED";
  state.pg.committed.lectures[L1].date = new Date("2026-08-10T12:30:00Z");
  state.pg.committed.lectures[L1].endDate = null;
  const historical = await json(await POST({}));
  assert.deepEqual([historical.status, historical.body.error.code], [409, "ATTENDANCE_LECTURE_HISTORICAL"]);

  reset();
  students(1);
  await withEnv({ ATTENDANCE_EVIDENCE_STARTED_AT: undefined }, async () => {
    const { status, body } = await json(await POST({}));
    assert.equal(status, 503);
    assert.deepEqual(body.error, {
      message: "Automatic attendance evidence is not configured on this server.",
      code: "ATTENDANCE_EVIDENCE_NOT_CONFIGURED",
      details: { setting: "ATTENDANCE_EVIDENCE_STARTED_AT", status: "MISSING" },
    });
  });
});

test("busy students are counted (the page continues); a fresh pass without a cursor catches up; repeats are safe", async () => {
  reset();
  students(3);
  state.pg.held.push({ row: "student:s0001", owner: "approval-decision", mode: "NO_KEY_UPDATE" });
  state.pg.failWhenBlocked = true;
  const page = await json(await POST({}));
  assert.deepEqual(page.body.data, { lectureId: L1, ...ZERO, processed: 3, applied: 2, busy: 1, nextCursor: null, stoppedBecause: null });

  state.pg.failWhenBlocked = false;
  state.model.locks.release("approval-decision");
  const fresh = await json(await POST({}));
  assert.deepEqual([fresh.body.data.applied, fresh.body.data.duplicates, fresh.body.data.busy], [1, 2, 0]);
  const after = attendanceState();
  const again = await json(await POST({}));
  assert.deepEqual([again.body.data.applied, again.body.data.duplicates], [0, 3]);
  assert.equal(attendanceState(), after, "a repeated pass writes nothing");
});
