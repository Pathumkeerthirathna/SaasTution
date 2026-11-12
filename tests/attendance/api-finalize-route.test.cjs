/*
 * POST /api/lectures/[id]/attendance/finalize (Stage 5.5c), in-process with
 * the real routes, preview and finalization services, error handler and
 * same-origin check; faked edges: session and Prisma
 * (helpers/attendance-route-env.cjs). No database; not a real-PostgreSQL
 * concurrency validation.
 *
 *   npm run test:attendance-api
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const env = require("./helpers/attendance-route-env.cjs");
const { state, errorLog, reset, student, visit, register, seedRecord, at, NOW, T1, T2, L1, ctx, get, post, attendanceState, assertNoStore, BAD_IDS, withEnv, root, APP_ORIGIN } = env;

const previewRoute = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "finalization", "route.ts"));
const finalizeRoute = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "finalize", "route.ts"));
const { FINALIZATION_INTEGRITY_EVENT } = require(path.join(root, "lib", "attendance-http.ts"));

test.mock.timers.enable({ apis: ["Date"], now: NOW });

const PREVIEW = (id = L1) => previewRoute.GET(get(`/api/lectures/${id}/attendance/finalization`), ctx(id));
const FINALIZE = (body, { id = L1, headers } = {}) => finalizeRoute.POST(post(`/api/lectures/${id}/attendance/finalize`, { body, headers }), ctx(id));
const json = async (response) => ({ status: response.status, body: await response.json() });
const fingerprint = async () => (await json(await PREVIEW())).body.data.fingerprint;
const HEX = "b".repeat(64);
const recordAuditsOf = (action) => state.pg.committed.recordAudits.filter((a) => a.action === action);

/** Captures console.error lines during `fn`. */
async function capturingErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

function mixedClass() {
  register();
  student("s-present");
  seedRecord("s-present", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(2), autoStatus: "PRESENT" });
  visit("s-present", at(2));
  student("s-no-show-1");
  student("s-no-show-2");
  student("s-unknown", { broken: true });
}

// ---- Finalize POST ---------------------------------------------------------------------------------

test("finalize: success (200), the result contract; a repeated confirmation is idempotent (200, alreadyFinalized)", async () => {
  reset();
  mixedClass();
  const fp = await fingerprint();
  const first = await FINALIZE({ fingerprint: fp });
  assert.equal(first.status, 200);
  assertNoStore(assert, first);
  const created = (await first.json()).data;
  assert.deepEqual(created, {
    lectureId: L1, alreadyFinalized: false, finalizedAt: NOW.toISOString(), registerVersion: 2, eligibleStudents: 3,
    unknownEligibilityStudents: 1, absentCreated: 2,
    details: { rosterSize: 4, studentsWithRecord: 1, manualReview: 1, notEligibleWithoutRecord: 0, recordStatusBefore: { PRESENT: 1, LATE: 0, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 0 },
  });
  const after = attendanceState();
  for (const again of [fp, HEX]) {
    const repeat = await json(await FINALIZE({ fingerprint: again }));
    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.body.data, { ...created, alreadyFinalized: true, details: null });
  }
  assert.equal(attendanceState(), after, "nothing written by the repeats");
  assert.equal(recordAuditsOf("FINALIZE_ABSENT").length, 2);
});

test("finalize: stale 409, malformed 400, blockers 409 (session, evidence, roster), configuration 503; nothing written", async () => {
  const refused = async (body, code, status) => {
    const before = attendanceState();
    const response = await FINALIZE(body);
    assertNoStore(assert, response);
    const { error } = await response.json();
    assert.deepEqual([response.status, error.code], [status, code], JSON.stringify(body));
    assert.equal(attendanceState(), before);
    return error;
  };

  reset();
  mixedClass();
  await refused({ fingerprint: HEX }, "FINALIZATION_PREVIEW_STALE", 409);
  for (const bad of ["", "B".repeat(64), "a".repeat(63), "zz"]) {
    assert.deepEqual((await refused({ fingerprint: bad }, "VALIDATION_ERROR", 400)).details, { field: "fingerprint" });
  }
  assert.deepEqual((await refused({ fingerprint: 5 }, "VALIDATION_ERROR", 400)).details, { field: "fingerprint" });

  reset();
  student("s1");
  state.pg.committed.sessions["sess-a"].isActive = true;
  await refused({ fingerprint: await fingerprint() }, "FINALIZATION_SESSION_ACTIVE", 409);

  reset();
  register();
  student("s1");
  visit("s1", at(3));
  const pending = await refused({ fingerprint: await fingerprint() }, "FINALIZATION_EVIDENCE_PENDING", 409);
  assert.deepEqual(pending.details, { pendingOnlineEvidence: 1, unknownApprovalEvidence: 0 });

  reset();
  for (let i = 0; i < 501; i += 1) student(`s${String(i).padStart(4, "0")}`);
  assert.deepEqual((await refused({ fingerprint: HEX }, "FINALIZATION_ROSTER_LIMIT_EXCEEDED", 409)).details, { limit: 500, rosterSize: 501 });

  reset();
  student("s1");
  const fp = await fingerprint();
  await withEnv({ APPROVAL_FEATURE_STARTED_AT: undefined }, async () => {
    const error = await refused({ fingerprint: fp }, "ATTENDANCE_APPROVAL_NOT_CONFIGURED", 503);
    assert.deepEqual(error.details, { setting: "APPROVAL_FEATURE_STARTED_AT", status: "MISSING" });
  });
});

test("finalize: invalid JSON, empty body, unknown fields and teacherId in the body are 400; cross-origin 403 before authentication", async () => {
  reset();
  student("s1");
  const fp = await fingerprint();
  for (const [body, code, field] of [
    ["{bad", "INVALID_JSON"],
    ["", "INVALID_JSON"],
    [{ fingerprint: fp, teacherId: T2 }, "VALIDATION_ERROR", "body"],
    [{}, "VALIDATION_ERROR", "fingerprint"],
    ["[]", "VALIDATION_ERROR", "body"],
  ]) {
    const { status, body: out } = await json(await FINALIZE(body));
    assert.deepEqual([status, out.error.code], [400, code], JSON.stringify(body));
    if (field) assert.deepEqual(out.error.details, { field });
  }
  const sessions = state.calls.session;
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.example" }, { Origin: "null" }]) {
    const response = await FINALIZE({ fingerprint: fp }, { headers });
    assert.equal(response.status, 403);
    assertNoStore(assert, response);
    assert.equal((await response.json()).error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  const noOrigin = new Request(`${APP_ORIGIN}/api/lectures/${L1}/attendance/finalize`, { method: "POST", body: JSON.stringify({ fingerprint: fp }) });
  assert.equal((await finalizeRoute.POST(noOrigin, ctx(L1))).status, 403, "missing Origin");
  assert.equal(state.calls.session, sessions, "rejected before authentication");
  assert.deepEqual(state.pg.committed.registers, {});
});

test("finalize: authentication and ownership (401 / 404); the teacher id comes only from the session", async () => {
  reset();
  student("s1");
  const fp = await fingerprint();
  state.session = null;
  assert.equal((await FINALIZE({ fingerprint: fp })).status, 401);
  state.session = { role: "STUDENT", userId: "s1" };
  assert.equal((await FINALIZE({ fingerprint: fp })).status, 401);
  state.session = { role: "TEACHER", userId: T2 };
  assert.equal((await FINALIZE({ fingerprint: fp })).status, 404);
  for (const id of BAD_IDS) assert.equal((await FINALIZE({ fingerprint: fp }, { id })).status, 400);
  assert.deepEqual(state.pg.committed.registers, {});
});

// ---- Integrity logging (D3) --------------------------------------------------------------------------

test("FINALIZATION_INTEGRITY_ERROR: one sanitized structured log line, a generic 500; other errors add no new logging", async () => {
  reset();
  student("s-secret");
  await FINALIZE({ fingerprint: await fingerprint() });
  state.pg.committed.registerAudits = state.pg.committed.registerAudits.filter((a) => a.action !== "FINALIZED");
  errorLog.length = 0;

  const { result: response, lines } = await capturingErrors(() => FINALIZE({ fingerprint: HEX }, { headers: { "x-request-id": "req-123.abc" } }));
  assert.equal(response.status, 500);
  assertNoStore(assert, response);
  const body = await response.json();
  assert.deepEqual(body, {
    success: false,
    error: { message: "The finalized attendance register is inconsistent. Contact support.", code: "FINALIZATION_INTEGRITY_ERROR" },
  });
  assert.equal(lines.length, 1, "exactly one log line");
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry).sort(), ["at", "code", "event", "lectureId", "level", "requestId", "teacherId"]);
  assert.deepEqual([entry.event, entry.code, entry.lectureId, entry.teacherId, entry.requestId], [FINALIZATION_INTEGRITY_EVENT, "FINALIZATION_INTEGRITY_ERROR", L1, T1, "req-123.abc"]);
  for (const secret of ["s-secret", "Name of", "REG-", "SELECT", "postgres", "teacher_session", "fingerprint", HEX, "APPROVAL_FEATURE", "stack"]) {
    assert.ok(!lines[0].includes(secret), secret);
  }
  assert.equal(errorLog.length, 0, "not also written by the generic handler");

  // An unsafe request id is not logged.
  for (const bad of ["bad id; injected=1", "<script>", "x".repeat(129)]) {
    const unsafe = await capturingErrors(() => FINALIZE({ fingerprint: HEX }, { headers: { "x-request-id": bad } }));
    assert.equal(unsafe.lines.length, 1);
    assert.equal(JSON.parse(unsafe.lines[0]).requestId, null, bad);
  }
  const absent = await capturingErrors(() => FINALIZE({ fingerprint: HEX }));
  assert.equal(JSON.parse(absent.lines[0]).requestId, null, "no header: null");

  // Other AppErrors (409, 400, 404) produce no log line.
  reset();
  student("s1");
  const others = await capturingErrors(async () => {
    await FINALIZE({ fingerprint: HEX });
    await FINALIZE({ fingerprint: "x" });
    state.session = { role: "TEACHER", userId: T2 };
    await FINALIZE({ fingerprint: HEX });
  });
  assert.deepEqual(others.lines, []);
  assert.equal(errorLog.length, 0);
});

// ---- Concurrency (in-memory model) ---------------------------------------------------------------------

test("two concurrent finalize requests: exactly one finalization, the other the idempotent result; no duplicate records or audits", async () => {
  reset();
  register();
  student("s1");
  student("s2");
  const fp = await fingerprint();
  let release;
  const gate = new Promise((r) => { release = r; });
  state.pg.beforeStatement = async (label, op) => {
    if (label === "tx1" && op === "insert:records") await gate;
  };
  const first = FINALIZE({ fingerprint: fp });
  while (!state.pg.transactions[0]?.statements.includes("insert:records")) await new Promise((r) => setImmediate(r));
  const second = FINALIZE({ fingerprint: fp });
  while (!state.pg.log.some((e) => e.startsWith("tx2:waits:register"))) await new Promise((r) => setImmediate(r));
  release();
  const [a, b] = await Promise.all([json(await first), json(await second)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual([a.body.data.alreadyFinalized, b.body.data.alreadyFinalized], [false, true]);
  assert.equal(b.body.data.absentCreated, 2);
  assert.equal(Object.keys(state.pg.committed.records).length, 2);
  assert.equal(recordAuditsOf("FINALIZE_ABSENT").length, 2);
  assert.equal(state.pg.committed.registerAudits.filter((x) => x.action === "FINALIZED").length, 1);
});
