/*
 * Physical QR attendance API (Stage 5.7b-3b), in-process with the real
 * routes, QR services, QR-state module, rate limiter, error handler,
 * same-origin check and middleware; faked edges: session and Prisma
 * (helpers/attendance-route-env.cjs, the in-memory PostgreSQL model).
 *
 *   POST /api/lectures/[id]/attendance/qr/scans
 *   POST /api/lectures/[id]/attendance/qr/close
 *   GET  /api/lectures/[id]/attendance   (the `qr` state)
 *
 * No database; not a real-PostgreSQL validation. STUDENT_QR_SECRET is a
 * test value generated here (never a real secret).
 *
 *   npm run test:attendance-api
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const env = require("./helpers/attendance-route-env.cjs");
const { state, errorLog, reset, student, register, seedRecord, at, NOW, T1, T2, L1, ctx, get, post, attendanceState, assertNoStore, BAD_IDS, withEnv, root, APP_ORIGIN } = env;

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
process.env.STUDENT_QR_SECRET = SECRET.toString("base64");

const { NextRequest } = require("next/server");
const scansRoute = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "qr", "scans", "route.ts"));
const closeRoute = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "qr", "close", "route.ts"));
const registerRoute = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "route.ts"));
const { middleware } = require(path.join(root, "middleware.ts"));
const qrToken = require(path.join(root, "lib", "student-qr-token.ts"));
const rateLimit = require(path.join(root, "lib", "attendance", "qr-scan-rate-limit.ts"));
const qrState = require(path.join(root, "services", "lecture-attendance-qr-state.ts"));
const http = require(path.join(root, "lib", "attendance-http.ts"));
const qrService = require(path.join(root, "services", "lecture-attendance-qr-service.ts"));

test.mock.timers.enable({ apis: ["Date"], now: NOW });

const scansUrl = (id) => `/api/lectures/${id}/attendance/qr/scans`;
const closeUrl = (id) => `/api/lectures/${id}/attendance/qr/close`;
const SCAN = (body, { id = L1, headers } = {}) => scansRoute.POST(post(scansUrl(id), { body, headers }), ctx(id));
const CLOSE = (body = {}, { id = L1, headers } = {}) => closeRoute.POST(post(closeUrl(id), { body, headers }), ctx(id));
const REGISTER = (id = L1) => registerRoute.GET(get(`/api/lectures/${id}/attendance`), ctx(id));
const json = async (response) => ({ status: response.status, body: await response.json(), response });

let scanSeq = 0;
const scanId = () => `route-scan-${String(++scanSeq).padStart(8, "0")}`;

function token(n, studentId) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const nonce = Buffer.alloc(32, n).toString("base64url");
  const value = qrToken.deriveStudentQrToken(SECRET, id, nonce);
  state.pg.committed.tokens[id] = { id, studentId, nonce, tokenHash: qrToken.hashStudentQrToken(value), revokedAt: null };
  return qrToken.buildStudentQrPayload(value);
}

const qrSnapshot = () => JSON.stringify([attendanceState(), state.pg.committed.scans, state.pg.committed.qrClosures]);

async function refused(promise, status, code, field) {
  const before = qrSnapshot();
  const { status: actual, body, response } = await json(await promise);
  assert.deepEqual([actual, body.success, body.error.code], [status, false, code], JSON.stringify(body));
  if (field) assert.deepEqual(body.error.details, { field });
  assertNoStore(assert, response);
  assert.equal(qrSnapshot(), before, "nothing written");
  return { body, response };
}

/** Captures console output and the error log while `fn` runs. */
async function captured(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...args) => lines.push(args.map(String).join(" "));
  const logStart = errorLog.length;
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n") + JSON.stringify(errorLog.slice(logStart));
}

/** One approved, enrolled student with a valid token; an open lecture (NOW = start + 200 min). */
function scenario() {
  reset();
  student("s1");
  return token(1, "s1");
}

const SCAN_KEYS = ["afterFinalization", "attendance", "effect", "receivedAt", "replayed", "result", "student"];

// ---- Scans: success, mapping, replay ---------------------------------------------------------

test("scan: VALID, the explicit contract (no scan event, token, hash or record ids; no payload); no-store", async () => {
  const payload = scenario();
  const id = scanId();
  const { status, body, response } = await json(await SCAN({ clientScanId: id, payload }));
  assert.equal(status, 200, JSON.stringify(body));
  assertNoStore(assert, response);
  assert.deepEqual(Object.keys(body.data).sort(), SCAN_KEYS);
  assert.equal(body.data.result, "VALID");
  assert.equal(body.data.effect, "STATUS_UPDATED");
  assert.equal(body.data.replayed, false);
  assert.equal(body.data.afterFinalization, false);
  assert.equal(body.data.receivedAt, NOW.toISOString());
  assert.deepEqual(body.data.student, { studentId: "s1", name: "Name of s1", registrationNumber: "REG-s1" });
  assert.deepEqual(Object.keys(body.data.attendance).sort(), ["pendingReview", "status", "statusSource"]);
  assert.deepEqual(body.data.attendance, { status: "LATE", statusSource: "AUTO", pendingReview: false });

  const text = JSON.stringify(body);
  const scan = state.pg.committed.scans[0];
  const record = state.pg.committed.records[`${L1}:s1`];
  for (const secret of [payload, payload.slice(7), scan.id, scan.qrTokenId, scan.scannedTokenHash, record.id, T1, "scanEventId", "version", "Hash"]) {
    assert.ok(secret && !text.includes(secret), `never returned: ${secret}`);
  }
  assert.equal(state.pg.committed.scans.length, 1);
  assert.equal(scan.scannedByTeacherId, T1, "the teacher came from the session");
});

test("scan: the same clientScanId is a replay (200 replayed, nothing new written); a different scan under it is 409", async () => {
  const payload = scenario();
  const id = scanId();
  const first = await json(await SCAN({ clientScanId: id, payload }));
  const before = qrSnapshot();
  const again = await json(await SCAN({ clientScanId: id, payload }));
  assert.equal(again.status, 200);
  assert.equal(again.body.data.replayed, true);
  assert.deepEqual({ ...again.body.data, replayed: false }, first.body.data, "the stored outcome");
  assert.equal(qrSnapshot(), before, "nothing new written");

  student("s2");
  const other = token(2, "s2");
  await refused(SCAN({ clientScanId: id, payload: other }), 409, "ATTENDANCE_SCAN_ID_REUSED");
});

test("scan: an unrecognized payload is recorded as INVALID_QR (200), never echoed", async () => {
  scenario();
  const payload = "SLCQR1:not-a-real-token-but-looks-like-one-0123456";
  const { status, body } = await json(await SCAN({ clientScanId: scanId(), payload }));
  assert.equal(status, 200);
  assert.deepEqual([body.data.result, body.data.effect, body.data.student, body.data.attendance], ["INVALID_QR", "NONE", null, null]);
  assert.ok(!JSON.stringify(body).includes(payload));
  assert.equal(state.pg.committed.scans.length, 1);
});

test("scan: another teacher's student is WRONG_TEACHER with no student details", async () => {
  scenario();
  student("s-foreign", { teacherId: T2, classId: "class-2" });
  const payload = token(9, "s-foreign");
  const { status, body } = await json(await SCAN({ clientScanId: scanId(), payload }));
  assert.equal(status, 200);
  assert.deepEqual([body.data.result, body.data.student, body.data.attendance], ["WRONG_TEACHER", null, null]);
  assert.ok(!JSON.stringify(body).includes("s-foreign"));
});

test("scan: a cancelled lecture is recorded as LECTURE_UNAVAILABLE (no attendance)", async () => {
  reset({ classStatus: "CANCELLED" });
  student("s1");
  const { status, body } = await json(await SCAN({ clientScanId: scanId(), payload: token(1, "s1") }));
  assert.equal(status, 200);
  assert.deepEqual([body.data.result, body.data.effect, body.data.attendance], ["LECTURE_UNAVAILABLE", "NONE", null]);
  assert.deepEqual(state.pg.committed.records, {});
});

test("scan after finalization: afterFinalization true, mapped without ids", async () => {
  reset();
  student("s1");
  register({ finalizedAt: at(150), finalizedByTeacherId: T1, version: 2 });
  seedRecord("s1", { status: "ABSENT", statusSource: "FINALIZATION" });
  const { status, body } = await json(await SCAN({ clientScanId: scanId(), payload: token(1, "s1") }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.afterFinalization, true);
  assert.equal(body.data.result, "VALID");
  assert.ok(!JSON.stringify(body).includes("rec-s1"));
});

// ---- Scans: validation, origin, authentication -----------------------------------------------

test("scan body: strict, clientScanId format, payload type and length (≤ 128); invalid JSON; the field only", async () => {
  const payload = scenario();
  await refused(SCAN({ clientScanId: scanId(), payload, teacherId: T2 }), 400, "VALIDATION_ERROR", "body");
  await refused(SCAN({ clientScanId: scanId(), payload, extra: 1 }), 400, "VALIDATION_ERROR", "body");
  for (const bad of [undefined, null, 7, "", "short", "x".repeat(15), "x".repeat(65), "bad id with spaces!!", "ä".repeat(20)]) {
    await refused(SCAN({ clientScanId: bad, payload }), 400, "VALIDATION_ERROR", "clientScanId");
  }
  for (const id of ["a".repeat(16), "A_b-0".repeat(12) + "abcd"]) {
    assert.equal(http.QR_CLIENT_SCAN_ID_PATTERN.test(id), true, id);
  }
  const long = "SLCQR1:" + "z".repeat(122); // 129
  for (const bad of [undefined, null, 42, { token: "x" }, ["SLCQR1:x"], long]) {
    const { body } = await refused(SCAN({ clientScanId: scanId(), payload: bad }), 400, "VALIDATION_ERROR", "payload");
    if (typeof bad === "string") assert.ok(!JSON.stringify(body).includes(bad), "payload never echoed");
  }
  const max = await json(await SCAN({ clientScanId: scanId(), payload: "q".repeat(128) }));
  assert.equal(max.status, 200, "128 characters accepted (recorded as INVALID_QR)");
  assert.equal(max.body.data.result, "INVALID_QR");
  await refused(SCAN(undefined), 400, "INVALID_JSON");
  await refused(SCAN("{not json"), 400, "INVALID_JSON");
  await refused(SCAN([]), 400, "VALIDATION_ERROR");
  for (const id of BAD_IDS) await refused(SCAN({ clientScanId: scanId(), payload }, { id }), 400, "VALIDATION_ERROR", "lectureId");
});

test("the route pattern matches the service's own clientScanId pattern", () => {
  assert.equal(http.QR_CLIENT_SCAN_ID_PATTERN.source, qrService.CLIENT_SCAN_ID_PATTERN.source);
  assert.equal(http.QR_CLIENT_SCAN_ID_PATTERN.flags, qrService.CLIENT_SCAN_ID_PATTERN.flags);
});

test("scan: same-origin before authentication and before the body (403); 401 (middleware and route); 404 not owned", async () => {
  const payload = scenario();
  const sessions = state.calls.session;
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.example" }, { Origin: "null" }]) {
    await refused(SCAN({ clientScanId: scanId(), payload }, { headers }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  const noOrigin = new Request(`${APP_ORIGIN}${scansUrl(L1)}`, { method: "POST", body: JSON.stringify({ clientScanId: scanId(), payload }) });
  assert.equal((await scansRoute.POST(noOrigin, ctx(L1))).status, 403);
  assert.equal(state.calls.session, sessions, "refused before authentication");
  for (const url of [scansUrl(L1), closeUrl(L1)]) {
    for (const headers of [{}, { cookie: "teacher_session=not-a-jwt" }]) {
      assert.equal((await middleware(new NextRequest(`${APP_ORIGIN}${url}`, { method: "POST", headers }))).status, 401, url);
    }
  }
  for (const session of [null, { role: "STUDENT", userId: "s1" }, { role: "ADMIN", userId: "a1" }]) {
    state.session = session;
    await refused(SCAN({ clientScanId: scanId(), payload }), 401, "UNAUTHORIZED");
  }
  state.session = { role: "TEACHER", userId: T2 };
  await refused(SCAN({ clientScanId: scanId(), payload }), 404, "LECTURE_NOT_FOUND");
  state.session = { role: "TEACHER", userId: T1 };
  await refused(SCAN({ clientScanId: scanId(), payload }, { id: "no-such-lecture" }), 404, "LECTURE_NOT_FOUND");
  // A deleted lecture of the teacher's: the service's documented rule, recorded as LECTURE_UNAVAILABLE.
  state.pg.committed.lectures[L1].status = 1;
  const deleted = await json(await SCAN({ clientScanId: scanId(), payload }));
  assert.equal(deleted.status, 200);
  assert.deepEqual([deleted.body.data.result, deleted.body.data.attendance], ["LECTURE_UNAVAILABLE", null]);
});

// ---- Scans: every service refusal ------------------------------------------------------------

test("scan: 503 for each missing setting (approval, evidence, QR secret); no setting value returned", async () => {
  const payload = scenario();
  await withEnv({ APPROVAL_FEATURE_STARTED_AT: undefined }, () => refused(SCAN({ clientScanId: scanId(), payload }), 503, "ATTENDANCE_APPROVAL_NOT_CONFIGURED"));
  await withEnv({ ATTENDANCE_EVIDENCE_STARTED_AT: "invalid" }, () => refused(SCAN({ clientScanId: scanId(), payload }), 503, "ATTENDANCE_EVIDENCE_NOT_CONFIGURED"));
  const secret = process.env.STUDENT_QR_SECRET;
  try {
    delete process.env.STUDENT_QR_SECRET;
    const { body } = await refused(SCAN({ clientScanId: scanId(), payload }), 503, "STUDENT_QR_NOT_CONFIGURED");
    assert.ok(!JSON.stringify(body).includes(secret));
    process.env.STUDENT_QR_SECRET = "too-short";
    await refused(SCAN({ clientScanId: scanId(), payload }), 503, "STUDENT_QR_NOT_CONFIGURED");
  } finally {
    process.env.STUDENT_QR_SECRET = secret;
  }
});

test("scan: 409 HISTORICAL, NOT_OPEN (with opensAt), CLOSED and BUSY; nothing recorded", async () => {
  reset({ date: new Date("2026-08-01T10:00:00.000Z"), endDate: new Date("2026-08-01T12:00:00.000Z") });
  student("s1");
  await refused(SCAN({ clientScanId: scanId(), payload: token(1, "s1") }), 409, "ATTENDANCE_LECTURE_HISTORICAL");

  reset({ date: at(300), endDate: at(400) });
  student("s1");
  const { body } = await refused(SCAN({ clientScanId: scanId(), payload: token(1, "s1") }), 409, "ATTENDANCE_QR_NOT_OPEN");
  assert.deepEqual(body.error.details, { opensAt: at(270).toISOString() });

  const payload = scenario();
  assert.equal((await CLOSE()).status, 200);
  await refused(SCAN({ clientScanId: scanId(), payload }), 409, "ATTENDANCE_QR_CLOSED");

  scenario();
  register();
  state.pg.held.push({ row: `register:${L1}`, owner: "elsewhere", mode: "UPDATE" });
  state.pg.failWhenBlocked = true;
  const busyId = scanId();
  await refused(SCAN({ clientScanId: busyId, payload: token(1, "s1") }), 409, "ATTENDANCE_BUSY");
  state.pg.held = [];
  state.pg.failWhenBlocked = false;
  const retry = await json(await SCAN({ clientScanId: busyId, payload: token(1, "s1") }));
  assert.equal(retry.status, 200, "the same id succeeds once the lock is free");
  assert.equal(retry.body.data.replayed, false);
});

test("the payload is never logged (console or error log), on success, refusal or a server error", async () => {
  const payload = scenario();
  const output = await captured(async () => {
    await SCAN({ clientScanId: scanId(), payload });
    await SCAN({ clientScanId: scanId(), payload: payload + "x".repeat(100) });
    await SCAN({ clientScanId: "bad", payload });
    state.pg.failOn = (_label, op) => (op === "create:scan" ? new Error("simulated database failure") : null);
    const failed = await SCAN({ clientScanId: scanId(), payload });
    state.pg.failOn = null;
    assert.equal(failed.status, 500);
    assert.ok(!JSON.stringify(await failed.json()).includes(payload));
  });
  assert.ok(!output.includes(payload) && !output.includes(payload.slice(7)), "no payload or token in any log line");
});

// ---- Rate limit ----------------------------------------------------------------------------

test("rate limiter: distinct scan ids per teacher; repeats use the replay budget; window reset; global limit; bounded memory", () => {
  let time = 0;
  const limiter = rateLimit.createQrScanRateLimiter({ perTeacher: 3, global: 5, perTeacherReplays: 100, windowMs: 10_000, maxRememberedScanIds: 4, now: () => time });
  const ok = (t, id) => limiter.check(t, id).allowed;
  assert.deepEqual([ok("A", "1"), ok("A", "2"), ok("A", "3")], [true, true, true]);
  assert.deepEqual(limiter.check("A", "4"), { allowed: false, kind: "NEW", retryAfterSeconds: 10 });
  assert.equal(ok("A", "1"), true, "a remembered id is a replay (separate budget)");
  assert.equal(ok("A", "4"), false, "a refused id was not remembered");
  assert.equal(ok("B", "1"), true, "per teacher");
  assert.equal(ok("B", "2"), true);
  assert.equal(ok("C", "1"), false, "global limit (5)");
  time = 10_000;
  assert.equal(ok("A", "4"), true, "new window");
  // Bounded: 4 remembered at most; the oldest are forgotten and count again.
  assert.equal(ok("A", "5"), true);
  time = 20_000;
  for (const id of ["6", "7", "8"]) assert.equal(ok("D", id), true);
  assert.equal(ok("D", "9"), false);
  assert.equal(ok("D", "8"), true, "recent id still remembered");
  // A1 was evicted: it counts again. Global so far 3 (D6–D8); A1 = 4, A2 = 5, A3 refused (global 5).
  assert.equal(ok("A", "1"), true);
  assert.equal(ok("A", "2"), true);
  assert.equal(ok("A", "3"), false, "evicted ids were counted toward the global limit");
});

test("rate limiter defaults: 120 new per teacher, 2000 new global, 600 replays per teacher, 60 s window", () => {
  assert.deepEqual({ ...rateLimit.QR_SCAN_RATE_LIMIT }, { perTeacher: 120, global: 2000, perTeacherReplays: 600, windowMs: 60_000, maxRememberedScanIds: 20_000 });
});

test("scan route: 429 ATTENDANCE_SCAN_RATE_LIMITED with Retry-After after 120 distinct scans; same-id retries pass; nothing recorded", async () => {
  scenario();
  // A teacher with no lectures: each allowed scan reaches the service (404) and records nothing.
  state.session = { role: "TEACHER", userId: "teacher-rate" };
  const ids = Array.from({ length: 120 }, () => scanId());
  for (const id of ids) {
    const r = await SCAN({ clientScanId: id, payload: "SLCQR1:x" });
    assert.equal(r.status, 404);
  }
  const extra = scanId();
  const { response, body } = await refused(SCAN({ clientScanId: extra, payload: "SLCQR1:x" }), 429, "ATTENDANCE_SCAN_RATE_LIMITED");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(body.error.message, "Too many scans. Wait a moment, then scan again.");
  assert.equal((await SCAN({ clientScanId: ids[0], payload: "SLCQR1:x" })).status, 404, "a repeated id is not rate limited");
  assert.equal((await SCAN({ clientScanId: extra, payload: "SLCQR1:x" })).status, 429, "the refused id still counts as new");
  state.session = { role: "TEACHER", userId: T1 };
  const own = await SCAN({ clientScanId: scanId(), payload: token(1, "s1") });
  assert.equal(own.status, 200, "another teacher is unaffected");
  // Invalid bodies are refused before the limiter (never counted, never 429).
  state.session = { role: "TEACHER", userId: "teacher-rate" };
  await refused(SCAN({ clientScanId: "bad", payload: "x" }), 400, "VALIDATION_ERROR", "clientScanId");
});

// ---- Closure -----------------------------------------------------------------------------

test("close: {} only; closes once (closedByYou, no teacher id); a repeat is alreadyClosed and writes nothing", async () => {
  scenario();
  const first = await json(await CLOSE());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assertNoStore(assert, first.response);
  assert.deepEqual(first.body.data, { lectureId: L1, closedAt: NOW.toISOString(), alreadyClosed: false, closedByYou: true });
  assert.ok(!JSON.stringify(first.body).includes(T1));
  assert.equal(state.pg.committed.qrClosures[L1].closedByTeacherId, T1);

  const before = qrSnapshot();
  const again = await json(await CLOSE());
  assert.deepEqual(again.body.data, { lectureId: L1, closedAt: NOW.toISOString(), alreadyClosed: true, closedByYou: true });
  assert.equal(qrSnapshot(), before);

  // A closure by someone else (for instance a former owner): closedByYou false, no id.
  state.pg.committed.qrClosures[L1].closedByTeacherId = "teacher-previous";
  const foreign = await json(await CLOSE());
  assert.equal(foreign.body.data.closedByYou, false);
  assert.ok(!JSON.stringify(foreign.body).includes("teacher-previous"));
});

test("close: strict body, ids, origin first, 401, 404, cancelled, busy; closure allowed after finalization", async () => {
  scenario();
  for (const body of [{ x: 1 }, { id: 1 }]) await refused(CLOSE(body), 400, "VALIDATION_ERROR", "body");
  // Stage 5.7b-3c: anything over 16 bytes is refused by size before the strict schema.
  for (const body of [{ teacherId: T1 }, { lectureId: L1 }]) await refused(CLOSE(body), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  for (const body of [[], "null", "5", '"x"']) await refused(CLOSE(body), 400, "VALIDATION_ERROR");
  await refused(closeRoute.POST(post(closeUrl(L1), {}), ctx(L1)), 400, "INVALID_JSON");
  await refused(CLOSE(""), 400, "INVALID_JSON");
  await refused(CLOSE("{oops"), 400, "INVALID_JSON");
  for (const id of BAD_IDS) await refused(CLOSE({}, { id }), 400, "VALIDATION_ERROR", "lectureId");
  const sessions = state.calls.session;
  await refused(CLOSE({}, { headers: { Origin: "https://evil.example" } }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  assert.equal(state.calls.session, sessions);
  state.session = null;
  await refused(CLOSE(), 401, "UNAUTHORIZED");
  state.session = { role: "TEACHER", userId: T2 };
  await refused(CLOSE(), 404, "LECTURE_NOT_FOUND");
  state.session = { role: "TEACHER", userId: T1 };
  await refused(CLOSE({}, { id: "no-such-lecture" }), 404, "LECTURE_NOT_FOUND");
  register();
  state.pg.held.push({ row: `register:${L1}`, owner: "elsewhere", mode: "KEY_SHARE" });
  state.pg.failWhenBlocked = true;
  await refused(CLOSE(), 409, "ATTENDANCE_BUSY");
  state.pg.held = [];
  state.pg.failWhenBlocked = false;

  reset({ classStatus: "CANCELLED" });
  await refused(CLOSE(), 409, "LECTURE_CANCELLED");

  reset();
  register({ finalizedAt: at(150), finalizedByTeacherId: T1, version: 2 });
  assert.equal((await CLOSE()).status, 200);

  // No setting is needed.
  reset();
  await withEnv({ APPROVAL_FEATURE_STARTED_AT: undefined, ATTENDANCE_EVIDENCE_STARTED_AT: undefined }, async () => {
    assert.equal((await CLOSE()).status, 200);
  });
});

// ---- Register QR state -------------------------------------------------------------------

const qrOf = async (id = L1) => {
  const { status, body } = await json(await REGISTER(id));
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(Object.keys(body.data.qr).sort(), ["closed", "closedAt", "opensAt", "window"]);
  return body.data.qr;
};

test("register qr: OPEN with no register yet (computed, nothing created), and with a register", async () => {
  scenario();
  const before = qrSnapshot();
  assert.deepEqual(await qrOf(), { closed: false, closedAt: null, opensAt: at(-30).toISOString(), window: "OPEN" });
  assert.equal(qrSnapshot(), before, "read only");
  assert.deepEqual(state.pg.committed.registers, {});
  assert.equal(state.pg.transactions.length, 0, "no transaction");
  register();
  assert.equal((await qrOf()).window, "OPEN");
});

test("register qr: NOT_OPEN before start - 30 min; OPEN exactly at it; opensAt from the register's (frozen) start", async () => {
  reset({ date: at(300), endDate: at(400) });
  assert.deepEqual(await qrOf(), { closed: false, closedAt: null, opensAt: at(270).toISOString(), window: "NOT_OPEN" });
  reset({ date: at(230), endDate: at(400) }); // opens at(200) = NOW
  assert.equal((await qrOf()).window, "OPEN");
  reset({ date: at(230), endDate: at(400) });
  register({ scheduledStartAt: at(240), finalizedAt: at(150), finalizedByTeacherId: T1, version: 2 });
  assert.deepEqual(await qrOf(), { closed: false, closedAt: null, opensAt: at(210).toISOString(), window: "NOT_OPEN" });
});

test("register qr: CLOSED and closed after the closure (authoritative), whatever the time", async () => {
  scenario();
  await CLOSE();
  assert.deepEqual(await qrOf(), { closed: true, closedAt: NOW.toISOString(), opensAt: at(-30).toISOString(), window: "CLOSED" });
  // Even before the window would open.
  reset({ date: at(300), endDate: at(400) });
  await CLOSE();
  assert.deepEqual(await qrOf(), { closed: true, closedAt: NOW.toISOString(), opensAt: at(270).toISOString(), window: "CLOSED" });
  const text = JSON.stringify(await (await REGISTER()).json());
  assert.ok(!text.includes("closedByTeacherId") && !text.includes(`"${T1}"`), "no teacher id");
});

test("register qr: cancelled and historical lectures are never available (CLOSED, not closed)", async () => {
  reset({ classStatus: "CANCELLED" });
  assert.deepEqual(await qrOf(), { closed: false, closedAt: null, opensAt: at(-30).toISOString(), window: "CLOSED" });
  reset({ classStatus: "CANCELLED", date: at(300), endDate: at(400) });
  assert.equal((await qrOf()).window, "CLOSED", "cancelled, even before the window");
  reset({ date: new Date("2026-08-01T10:00:00.000Z"), endDate: new Date("2026-08-01T12:00:00.000Z") });
  assert.deepEqual(await qrOf(), { closed: false, closedAt: null, opensAt: "2026-08-01T09:30:00.000Z", window: "CLOSED" });
});

test("register qr: CLOSED while a setting the scan needs is missing (never a 503)", async () => {
  scenario();
  await withEnv({ APPROVAL_FEATURE_STARTED_AT: undefined }, async () => assert.equal((await qrOf()).window, "CLOSED"));
  await withEnv({ ATTENDANCE_EVIDENCE_STARTED_AT: undefined }, async () => assert.equal((await qrOf()).window, "CLOSED"));
  const secret = process.env.STUDENT_QR_SECRET;
  try {
    delete process.env.STUDENT_QR_SECRET;
    const qr = await qrOf();
    assert.deepEqual(qr, { closed: false, closedAt: null, opensAt: at(-30).toISOString(), window: "CLOSED" });
  } finally {
    process.env.STUDENT_QR_SECRET = secret;
  }
  assert.equal((await qrOf()).window, "OPEN");
});

test("register qr: authorization unchanged (404 another teacher's lecture before any closure read)", async () => {
  scenario();
  state.session = { role: "TEACHER", userId: T2 };
  state.pg.log.length = 0;
  assert.equal((await REGISTER()).status, 404);
  assert.ok(!state.pg.log.includes("read:closure"), "the closure is read only after getRegister authorized the lecture");
});

test("registerQrState (pure): every branch", () => {
  const base = { scheduledStartAt: at(0), classStatus: "SCHEDULED", classification: "LIVE", approvalConfigured: true, qrSecretConfigured: true, closedAt: null, now: at(-30) };
  const w = (patch) => qrState.registerQrState({ ...base, ...patch }).window;
  assert.equal(w({}), "OPEN");
  assert.equal(w({ now: new Date(at(-30).getTime() - 1) }), "NOT_OPEN");
  assert.equal(w({ closedAt: at(5) }), "CLOSED");
  assert.equal(w({ closedAt: at(5), now: at(-100) }), "CLOSED");
  assert.equal(w({ classStatus: "CANCELLED" }), "CLOSED");
  assert.equal(w({ classification: "HISTORICAL" }), "CLOSED");
  assert.equal(w({ classification: null }), "CLOSED");
  assert.equal(w({ approvalConfigured: false }), "CLOSED");
  assert.equal(w({ qrSecretConfigured: false }), "CLOSED");
  assert.deepEqual(qrState.registerQrState({ ...base, closedAt: at(5) }), { closed: true, closedAt: at(5).toISOString(), opensAt: at(-30).toISOString(), window: "CLOSED" });
  assert.equal(qrState.studentQrSecretConfigured({}), false);
  assert.equal(qrState.studentQrSecretConfigured({ STUDENT_QR_SECRET: SECRET.toString("base64") }), true);
});

// ---- Client bundle safety --------------------------------------------------------------------

test("client safety: the register contract module and attendance UI never import the QR token or state modules", () => {
  const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
  const contract = read("lib", "attendance-register-response.ts");
  assert.ok(!/from\s+["']@\/lib\/student-qr-token["']/.test(contract));
  assert.ok(!/from\s+["']@\/services\/lecture-attendance-qr-state["']/.test(contract));
  const dir = path.join(root, "components", "attendance");
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!/student-qr-token|lecture-attendance-qr-state|qr-scan-rate-limit/.test(text), file);
  }
  const imports = (text) => [...text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gms)].map((m) => ({ typeOnly: Boolean(m[1]), from: m[2] }));
  for (const i of imports(read("services", "lecture-attendance-qr-state.ts"))) {
    if (i.from === "@/lib/attendance-register-response") assert.ok(i.typeOnly, "type-only import of the contract");
  }
});

// ---- Request body size limits (Stage 5.7b-3c) ----------------------------------------------

const enc = (text) => new TextEncoder().encode(text);
const SAME_ORIGIN = { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };

/** A POST with an exact body (string / bytes / stream) and headers; nothing added unless asked. */
function raw(url, { body, headers = {}, origin = true } = {}) {
  const init = { method: "POST", headers: { ...(origin ? SAME_ORIGIN : {}), ...headers } };
  if (body !== undefined) init.body = body;
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request(`${APP_ORIGIN}${url}`, init);
}

/** An endless body: `chunk` bytes per pull (never pulled until read: highWaterMark 0). */
function endless(chunk = 256) {
  const stats = { pulls: 0, cancelled: false };
  const stream = new ReadableStream(
    {
      pull(controller) {
        stats.pulls += 1;
        controller.enqueue(new Uint8Array(chunk).fill(0x20));
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, stats };
}

const scanRaw = (opts) => scansRoute.POST(raw(scansUrl(L1), opts), ctx(L1));
const closeRaw = (opts) => closeRoute.POST(raw(closeUrl(L1), opts), ctx(L1));

test("limits: the exact caps (scan 1024 bytes, closure 16); the worst-case valid scan encoding fits", () => {
  assert.equal(http.QR_SCAN_MAX_BODY_BYTES, 1024);
  assert.equal(http.QR_CLOSE_MAX_BODY_BYTES, 16);
  const u = (s) => [...s].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const worst = `{"${u("clientScanId")}":"${"a".repeat(64)}","${u("payload")}":"${u("一".repeat(128))}"}`;
  assert.equal(enc(worst).byteLength, 959);
  assert.deepEqual(Object.keys(JSON.parse(worst)), ["clientScanId", "payload"]);
  assert.equal(JSON.parse(worst).payload.length, 128);
  assert.ok(enc(worst).byteLength <= http.QR_SCAN_MAX_BODY_BYTES);
});

test("scan body: a valid body at exactly 1024 bytes is accepted; 1025 bytes is 413 (no Content-Length); nothing written", async () => {
  const payload = scenario();
  const base = JSON.stringify({ clientScanId: scanId(), payload });
  const exact = base + " ".repeat(1024 - enc(base).byteLength);
  assert.equal(enc(exact).byteLength, 1024);
  assert.equal((await scanRaw({ body: exact })).status, 200);

  const next = JSON.stringify({ clientScanId: scanId(), payload });
  const over = next + " ".repeat(1025 - enc(next).byteLength);
  assert.equal(enc(over).byteLength, 1025);
  const { body } = await refused(scanRaw({ body: over }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  assert.deepEqual(body.error, { message: "The request is too large.", code: "ATTENDANCE_REQUEST_TOO_LARGE" });
  assert.ok(!JSON.stringify(body).includes(payload));
  // A huge payload string (the schema would say 400) is refused by size first.
  await refused(scanRaw({ body: JSON.stringify({ clientScanId: scanId(), payload: "SLCQR1:" + "z".repeat(5000) }) }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
});

test("scan body: a declared Content-Length over the cap is 413 before a byte is read", async () => {
  scenario();
  const { stream, stats } = endless();
  await refused(scanRaw({ body: stream, headers: { "Content-Length": "1025" } }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  assert.equal(stats.pulls, 0, "the body was never read");
  await refused(scanRaw({ body: "{}", headers: { "Content-Length": "999999999999999" } }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
});

test("scan body: a streamed / chunked body without Content-Length is abandoned once past the cap (cancelled, bounded reads)", async () => {
  scenario();
  const { stream, stats } = endless(256);
  await refused(scanRaw({ body: stream }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  assert.ok(stats.pulls <= 6, `bounded reads (${stats.pulls})`);
  assert.equal(stats.cancelled, true, "the stream was cancelled");
});

test("scan body: a false Content-Length cannot smuggle a larger body (413 over the cap, else 400)", async () => {
  const payload = scenario();
  const { stream, stats } = endless(256);
  await refused(scanRaw({ body: stream, headers: { "Content-Length": "10" } }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  assert.equal(stats.cancelled, true);
  const body = JSON.stringify({ clientScanId: scanId(), payload });
  await refused(scanRaw({ body, headers: { "Content-Length": "10" } }), 400, "VALIDATION_ERROR", "content-length");
  await refused(scanRaw({ body, headers: { "Content-Length": String(enc(body).byteLength + 5) } }), 400, "VALIDATION_ERROR", "content-length");
  const ok = await json(await scanRaw({ body, headers: { "Content-Length": String(enc(body).byteLength) } }));
  assert.equal(ok.status, 200, "a correct Content-Length is accepted");
});

test("scan body: malformed Content-Length values are 400 (field content-length), never parsed loosely", async () => {
  const payload = scenario();
  const body = JSON.stringify({ clientScanId: scanId(), payload });
  for (const value of ["abc", "-1", "+50", "1e3", "0x40", "50, 50", "5 0", "", "1.5", "9".repeat(16)]) {
    await refused(scanRaw({ body, headers: { "Content-Length": value } }), 400, "VALIDATION_ERROR", "content-length");
  }
});

test("scan / close body: malformed JSON, invalid UTF-8 and empty bodies are 400 INVALID_JSON", async () => {
  scenario();
  for (const body of ["{", "{\"clientScanId\":", "nope", "", "   ", new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])]) {
    await refused(scanRaw({ body }), 400, "INVALID_JSON");
  }
  await refused(scanRaw({}), 400, "INVALID_JSON");
  // Well-formed JSON around one invalid UTF-8 byte in the payload: refused, never decoded to U+FFFD and recorded.
  const prefix = enc(`{"clientScanId":"${scanId()}","payload":"SLCQR1:`);
  const suffix = enc(`"}`);
  const smuggled = new Uint8Array([...prefix, 0xff, ...suffix]);
  await refused(scanRaw({ body: smuggled }), 400, "INVALID_JSON");
  for (const body of ["{", "", new Uint8Array([0xc3, 0x28])]) await refused(closeRaw({ body }), 400, "INVALID_JSON");
});

test("close body: {} with a little whitespace is accepted (at most 16 bytes); 17 bytes, a declared 17 or a stream is 413", async () => {
  scenario();
  assert.equal((await closeRaw({ body: "{ }\r\n" })).status, 200);
  reset();
  assert.equal((await closeRaw({ body: "{}" + " ".repeat(14), headers: { "Content-Length": "16" } })).status, 200);
  reset();
  await refused(closeRaw({ body: "{}" + " ".repeat(15) }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  await refused(closeRaw({ body: "{\"padding\":\"x\"}  " }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  const declared = endless();
  await refused(closeRaw({ body: declared.stream, headers: { "Content-Length": "17" } }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  assert.equal(declared.stats.pulls, 0);
  const streamed = endless(8);
  await refused(closeRaw({ body: streamed.stream }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  assert.ok(streamed.stats.pulls <= 3 && streamed.stats.cancelled);
  await refused(closeRaw({ body: "{}", headers: { "Content-Length": "x" } }), 400, "VALIDATION_ERROR", "content-length");
  assert.deepEqual(state.pg.committed.qrClosures, {});
});

test("order: same-origin first (403, body never read, no session), then authentication (401, body never read), then size", async () => {
  scenario();
  for (const [route, url] of [[scansRoute, scansUrl(L1)], [closeRoute, closeUrl(L1)]]) {
    const sessions = state.calls.session;
    for (const headers of [{}, { Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
      const { stream, stats } = endless();
      const request = raw(url, { body: stream, origin: false, headers: { ...headers, "Content-Length": "99999" } });
      const response = await route.POST(request, ctx(L1));
      assert.equal(response.status, 403, url);
      assert.equal((await response.json()).error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
      assert.equal(stats.pulls, 0, "body never read");
    }
    assert.equal(state.calls.session, sessions, "session never consulted");
    state.session = null;
    const { stream, stats } = endless();
    const response = await route.POST(raw(url, { body: stream, headers: { "Content-Length": "99999" } }), ctx(L1));
    assert.equal(response.status, 401, "authentication before the size check");
    assert.equal(stats.pulls, 0, "an unauthenticated body is never read");
    state.session = { role: "TEACHER", userId: T1 };
  }
});

test("size refusals do not count toward the rate limit and keep replay intact", async () => {
  const payload = scenario();
  state.session = { role: "TEACHER", userId: "teacher-size" };
  for (let i = 0; i < 130; i += 1) {
    assert.equal((await scanRaw({ body: "x".repeat(2000) })).status, 413);
  }
  assert.equal((await SCAN({ clientScanId: scanId(), payload: "SLCQR1:x" })).status, 404, "not rate limited by 413s");
  state.session = { role: "TEACHER", userId: T1 };
  const id = scanId();
  const first = await json(await SCAN({ clientScanId: id, payload }));
  const again = await json(await scanRaw({ body: JSON.stringify({ clientScanId: id, payload }) }));
  assert.equal(first.status, 200);
  assert.equal(again.body.data.replayed, true);
});

test("no payload, body text or internal ids in 413 / 400 responses or any log line", async () => {
  const payload = scenario();
  const marker = "SECRET-MARKER-7f3a";
  const output = await captured(async () => {
    const bodies = [
      JSON.stringify({ clientScanId: scanId(), payload: payload + marker.repeat(100) }),
      `{"clientScanId":"${marker}", ${payload}`,
      JSON.stringify({ clientScanId: scanId(), payload, marker }),
    ];
    for (const body of bodies) {
      for (const headers of [{}, { "Content-Length": "7" }, { "Content-Length": marker }]) {
        const response = await scanRaw({ body, headers });
        assert.ok([400, 413].includes(response.status), String(response.status));
        const text = await response.text();
        for (const secret of [payload, marker, T1, L1, "scanEventId"]) assert.ok(!text.includes(secret), secret);
      }
    }
  });
  assert.ok(!output.includes(payload) && !output.includes(marker));
  assert.equal(state.pg.committed.scans.length, 0);
});

// ---- Replay rate limit (Stage 5.7b-3c-1) ---------------------------------------------------

/**
 * The route limiter is one per process (real clock), so a budget test needs a
 * teacher no other test has used: the fixture class (and student s1) is
 * reassigned to `teacherId`, who becomes the session. Returns s1's payload.
 */
function scenarioFor(teacherId) {
  reset();
  state.pg.committed.classes["class-1"].teacherId = teacherId;
  student("s1", { teacherId });
  state.session = { role: "TEACHER", userId: teacherId };
  return token(1, "s1");
}

/** A limiter with a controllable clock and the production limits unless overridden. */
function clockLimiter(overrides = {}) {
  const clock = { time: 0 };
  const limiter = rateLimit.createQrScanRateLimiter({ now: () => clock.time, ...overrides });
  return { limiter, clock };
}

test("replay limiter: the first submission is NEW, repeats are REPLAY; 600 replays allowed, the 601st refused with retryAfter", () => {
  const { limiter } = clockLimiter();
  assert.deepEqual(limiter.check("A", "id-1"), { allowed: true, kind: "NEW" });
  for (let i = 1; i <= 600; i += 1) {
    assert.deepEqual(limiter.check("A", "id-1"), { allowed: true, kind: "REPLAY" }, `replay ${i}`);
  }
  assert.deepEqual(limiter.check("A", "id-1"), { allowed: false, kind: "REPLAY", retryAfterSeconds: 60 });
  assert.deepEqual(limiter.check("A", "id-1"), { allowed: false, kind: "REPLAY", retryAfterSeconds: 60 }, "still refused");
});

test("replay limiter: replays never consume the new-scan budget, and new scans never consume the replay budget", () => {
  const { limiter } = clockLimiter();
  limiter.check("A", "id-0");
  for (let i = 0; i < 600; i += 1) limiter.check("A", "id-0");
  assert.equal(limiter.check("A", "id-0").allowed, false, "replay budget spent");
  for (let i = 1; i < 120; i += 1) {
    assert.deepEqual(limiter.check("A", `new-${i}`), { allowed: true, kind: "NEW" }, `new ${i}`);
  }
  assert.deepEqual(limiter.check("A", "new-120"), { allowed: false, kind: "NEW", retryAfterSeconds: 60 }, "120 NEW in total (id-0 included)");

  const other = clockLimiter().limiter;
  for (let i = 0; i < 120; i += 1) other.check("B", `n-${i}`);
  assert.equal(other.check("B", "n-120").allowed, false, "new-scan budget spent");
  for (let i = 0; i < 600; i += 1) assert.deepEqual(other.check("B", `n-${i % 120}`), { allowed: true, kind: "REPLAY" });
  assert.equal(other.check("B", "n-0").allowed, false);
});

test("replay limiter: separate budgets per teacher; the same clientScanId under another teacher is NEW for that teacher", () => {
  const { limiter } = clockLimiter({ perTeacherReplays: 3 });
  limiter.check("A", "shared-id");
  for (let i = 0; i < 3; i += 1) limiter.check("A", "shared-id");
  assert.equal(limiter.check("A", "shared-id").allowed, false);
  assert.deepEqual(limiter.check("B", "shared-id"), { allowed: true, kind: "NEW" }, "keyed by (teacher, id)");
  for (let i = 0; i < 3; i += 1) assert.deepEqual(limiter.check("B", "shared-id"), { allowed: true, kind: "REPLAY" });
  assert.equal(limiter.check("B", "shared-id").allowed, false);
  assert.deepEqual(limiter.check("C", "x"), { allowed: true, kind: "NEW" });
});

test("replay limiter: the window resets both budgets; the 2,000 global new-scan limit is unchanged and replays are not global", () => {
  const { limiter, clock } = clockLimiter({ perTeacherReplays: 2 });
  limiter.check("A", "id");
  limiter.check("A", "id");
  limiter.check("A", "id");
  assert.equal(limiter.check("A", "id").allowed, false);
  clock.time = 59_999;
  assert.equal(limiter.check("A", "id").allowed, false, "same window");
  clock.time = 60_000;
  assert.deepEqual(limiter.check("A", "id"), { allowed: true, kind: "REPLAY" }, "new window");

  const global = clockLimiter().limiter;
  let allowed = 0;
  for (let t = 0; t < 20; t += 1) for (let i = 0; i < 120; i += 1) if (global.check(`T${t}`, `g-${i}`).allowed) allowed += 1;
  assert.equal(allowed, 2000, "2,000 NEW scans server-wide per window");
  assert.equal(global.check("T99", "fresh").allowed, false, "global NEW limit reached");
  // Replays of remembered ids still pass (per-teacher budget only).
  assert.deepEqual(global.check("T0", "g-0"), { allowed: true, kind: "REPLAY" });
});

test("replay limiter: memory stays bounded; an evicted id is NEW again; refused ids are never remembered", () => {
  const { limiter, clock } = clockLimiter({ maxRememberedScanIds: 10, perTeacher: 1_000, global: 5_000 });
  for (let i = 0; i < 1_000; i += 1) {
    limiter.check(`T${i % 7}`, `id-${i}`);
    assert.ok(limiter.rememberedCount() <= 10, `bounded (${limiter.rememberedCount()})`);
  }
  assert.deepEqual(limiter.check("T0", "id-0"), { allowed: true, kind: "NEW" }, "evicted long ago: NEW again");
  assert.deepEqual(limiter.check("T3", "id-997"), { allowed: true, kind: "REPLAY" }, "recent: still a replay");

  const small = clockLimiter({ perTeacher: 1 }).limiter;
  small.check("A", "first");
  assert.equal(small.check("A", "refused").allowed, false);
  assert.equal(small.rememberedCount(), 1, "the refused NEW id was not remembered");
  assert.deepEqual(small.check("A", "refused"), { allowed: false, kind: "NEW", retryAfterSeconds: 60 }, "still NEW");
  assert.equal(clock.time, 0);
});

test("scan route: 600 same-id retries are accepted (each answered by the service), the 601st is 429 with Retry-After; nothing re-recorded", async () => {
  const payload = scenarioFor("teacher-replay-600");
  const id = scanId();
  const first = await json(await SCAN({ clientScanId: id, payload }));
  assert.equal(first.status, 200);
  assert.equal(first.body.data.replayed, false);
  const before = qrSnapshot();
  for (let i = 1; i <= 600; i += 1) {
    const again = await SCAN({ clientScanId: id, payload });
    if (again.status !== 200) assert.fail(`retry ${i}: ${again.status}`);
    if (i === 600) assert.equal((await again.json()).data.replayed, true);
  }
  assert.equal(qrSnapshot(), before, "replays write nothing");
  const { response, body } = await refused(SCAN({ clientScanId: id, payload }), 429, "ATTENDANCE_SCAN_RATE_LIMITED");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.ok(!JSON.stringify(body).includes(payload) && !JSON.stringify(body).includes(id));
  // The new-scan budget is untouched by the 600 replays.
  const fresh = await json(await SCAN({ clientScanId: scanId(), payload }));
  assert.equal(fresh.status, 200, "a different clientScanId still uses the new-scan budget");
  assert.equal(fresh.body.data.replayed, false);
});

test("scan route: a reused clientScanId with a different payload reaches the service (409 SCAN_ID_REUSED) within the replay budget", async () => {
  const payload = scenario();
  state.session = { role: "TEACHER", userId: "teacher-reuse" };
  // This teacher owns a class and lecture of their own for the test.
  state.pg.committed.classes["class-reuse"] = { id: "class-reuse", teacherId: "teacher-reuse", status: 0, attendanceGraceMinutes: 10 };
  state.pg.committed.lectures["lecture-reuse"] = { ...state.pg.committed.lectures[L1], id: "lecture-reuse", classId: "class-reuse" };
  student("s-reuse-1", { teacherId: "teacher-reuse", classId: "class-reuse" });
  student("s-reuse-2", { teacherId: "teacher-reuse", classId: "class-reuse" });
  const p1 = token(41, "s-reuse-1");
  const p2 = token(42, "s-reuse-2");
  const id = scanId();
  const reuseScan = (p) => scansRoute.POST(post(scansUrl("lecture-reuse"), { body: { clientScanId: id, payload: p } }), ctx("lecture-reuse"));
  assert.equal((await reuseScan(p1)).status, 200);
  for (let i = 0; i < 3; i += 1) {
    const { status, body } = await json(await reuseScan(p2));
    assert.deepEqual([status, body.error.code], [409, "ATTENDANCE_SCAN_ID_REUSED"], "the service decides, not the limiter");
  }
  const replay = await json(await reuseScan(p1));
  assert.equal(replay.body.data.replayed, true, "the original outcome is preserved");
  assert.ok(!JSON.stringify(replay.body).includes(payload));
});

test("scan route: a remembered id the service refused is retried through the replay budget and recorded once accepted", async () => {
  const payload = scenarioFor("teacher-busy-retry");
  register();
  const id = scanId();
  state.pg.held.push({ row: `register:${L1}`, owner: "elsewhere", mode: "UPDATE" });
  state.pg.failWhenBlocked = true;
  await refused(SCAN({ clientScanId: id, payload }), 409, "ATTENDANCE_BUSY");
  state.pg.held = [];
  state.pg.failWhenBlocked = false;
  const retry = await json(await SCAN({ clientScanId: id, payload }));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.replayed, false, "remembered by the limiter, but nothing was stored: the service records it now");
  assert.equal(state.pg.committed.scans.length, 1);
});

test("replay budget: per teacher at the route (another teacher is unaffected), body limits and same-origin unchanged", async () => {
  const payload = scenario();
  state.session = { role: "TEACHER", userId: "teacher-flood" };
  const id = scanId();
  for (let i = 0; i < 601; i += 1) await SCAN({ clientScanId: id, payload: "SLCQR1:x" }); // 1 NEW + 600 replays (404 each)
  await refused(SCAN({ clientScanId: id, payload: "SLCQR1:x" }), 429, "ATTENDANCE_SCAN_RATE_LIMITED");
  const own = scenarioFor("teacher-unaffected");
  const mine = scanId();
  assert.equal((await SCAN({ clientScanId: mine, payload: own })).status, 200);
  assert.equal((await SCAN({ clientScanId: mine, payload: own })).status, 200, "another teacher's replay budget is its own");
  assert.ok(payload);

  state.session = { role: "TEACHER", userId: "teacher-flood" };
  await refused(scanRaw({ body: "x".repeat(2000) }), 413, "ATTENDANCE_REQUEST_TOO_LARGE");
  await refused(SCAN({ clientScanId: id, payload: "SLCQR1:x" }, { headers: { Origin: "https://evil.example" } }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  await refused(SCAN({ clientScanId: id, payload: "SLCQR1:x", extra: 1 }), 400, "VALIDATION_ERROR", "body");
});

// ---- End-to-end through the routes (Stage 5.7b-3f) ----------------------------------------

test("end to end via the routes: online + QR, scan, close, register GET (closed, counted once), scan refused, finalization preview unaffected", async () => {
  const evidenceService = require(path.join(root, "services", "lecture-attendance-evidence-service.ts"));
  const previewRoute = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "finalization", "route.ts"));
  const payload = scenarioFor("teacher-e2e");
  student("s2", { teacherId: "teacher-e2e" });
  // Online evidence for s1 (the join dispatcher's processor), then the physical QR scan.
  state.pg.committed.sessions["sess-a"].isActive = false;
  state.pg.committed.visits["visit-e2e"] = { id: "visit-e2e", studentId: "s1", joinedAt: at(2), classSessionId: "sess-a" };
  await evidenceService.recordOnlineEvidence("visit-e2e", { env: process.env });
  const first = await json(await SCAN({ clientScanId: scanId(), payload }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.data.result, first.body.data.effect, first.body.data.attendance.status], ["VALID", "EVIDENCE_ONLY", "PRESENT"]);

  const previewBefore = await json(await previewRoute.GET(get(`/api/lectures/${L1}/attendance/finalization`), ctx(L1)));
  assert.equal(previewBefore.status, 200, JSON.stringify(previewBefore.body));

  const closed = await json(await CLOSE());
  assert.deepEqual([closed.status, closed.body.data.alreadyClosed, closed.body.data.closedByYou], [200, false, true]);
  const again = await json(await CLOSE()); // a second tab
  assert.deepEqual([again.status, again.body.data.alreadyClosed, again.body.data.closedAt], [200, true, closed.body.data.closedAt]);

  const reg = await json(await REGISTER());
  assert.equal(reg.status, 200);
  assert.deepEqual(reg.body.data.qr, { closed: true, closedAt: closed.body.data.closedAt, opensAt: at(-30).toISOString(), window: "CLOSED" });
  assert.equal(reg.body.data.register.finalized, false, "closing QR attendance does not finalize");
  assert.equal(reg.body.data.summary.withRecord, 1, "one record for the online + QR student");
  assert.equal(reg.body.data.summary.recordStatus.PRESENT, 1);
  const s1 = reg.body.data.students.find((s) => s.studentId === "s1");
  assert.deepEqual([s1.record.firstOnlineAt, typeof s1.record.firstQrAt], [at(2).toISOString(), "string"]);
  assert.ok(!JSON.stringify(reg.body).includes("teacher-e2e"), "no teacher id");

  await refused(SCAN({ clientScanId: scanId(), payload: token(2, "s2") }), 409, "ATTENDANCE_QR_CLOSED");
  const previewAfter = await json(await previewRoute.GET(get(`/api/lectures/${L1}/attendance/finalization`), ctx(L1)));
  assert.equal(previewAfter.status, 200);
  assert.equal(previewAfter.body.data.fingerprint, previewBefore.body.data.fingerprint, "the closure does not change the finalization preview");
});
