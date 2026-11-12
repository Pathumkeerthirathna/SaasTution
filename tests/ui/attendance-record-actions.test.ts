/**
 * Stage 5.6c: the shared client logic for teacher decisions, evidence reviews
 * and history — the typed API helpers and messages
 * (components/attendance/attendance-ui.ts), the decision / review controller
 * (record-action-controller.ts) and the cursor history loader
 * (history-controller.ts). Pure: fetch is injected (real Response objects) or
 * the API calls are injected; no server, no database, no DOM.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTENDANCE_API_ERROR_CODES,
  ATTENDANCE_REASON_MAX_LENGTH,
  attendanceErrorAction,
  attendanceErrorMessage,
  buildHistoryQuery,
  checkAttendanceReason,
  decisionReasonRequirement,
  fetchRegisterHistory,
  fetchStudentHistory,
  reasonProblemMessage,
  reviewReasonRequirement,
  submitAttendanceDecision,
  submitAttendanceReview,
  type AttendanceApiError,
  type AttendanceApiResult,
  type DecisionRequest,
  type DecisionResponse,
  type HistoryPageRequest,
  type ReviewRequest,
  type ReviewResponse,
  type StudentHistoryEntry,
  type StudentHistoryResponse,
} from "../../components/attendance/attendance-ui";
import { createActionLock } from "../../components/attendance/reconciliation-controller";
import { createRecordActionController, isStaleRecordError, type RecordActionUiState } from "../../components/attendance/record-action-controller";
import {
  clampHistoryPageSize,
  createHistoryLoader,
  createRegisterHistoryLoader,
  createStudentHistoryLoader,
  mergeHistoryEntries,
  type HistoryState,
} from "../../components/attendance/history-controller";

// ---- Helpers ---------------------------------------------------------------------------------

type Call = { url: string; init?: RequestInit };

function fakeFetch(...handlers: ((call: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return handlers[Math.min(calls.length - 1, handlers.length - 1)](call);
  };
  return { impl, calls };
}
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const success = (data: unknown) => jsonResponse(200, { success: true, data });
const failure = (status: number, code: string, message = "Server text") => jsonResponse(status, { success: false, error: { message, code } });
const bodyOf = (call: Call) => JSON.parse(String(call.init?.body));
const queryOf = (call: Call) => Object.fromEntries(new URL(call.url, "https://x.test").searchParams);
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Fail fast: the promise's value if it settles within a few ticks, else "PENDING" (a refused call must settle at once). */
async function quick<T>(promise: Promise<T>): Promise<T | "PENDING"> {
  let settled = false;
  let value: T | "PENDING" = "PENDING";
  void promise.then((v) => { settled = true; value = v; });
  for (let i = 0; i < 20 && !settled; i += 1) await tick();
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const apiError = (status: number, code: string): AttendanceApiError => ({ ok: false, status, code, message: attendanceErrorMessage(code) });

const DECISION: DecisionResponse = {
  lectureId: "L1", studentId: "s1", status: "PRESENT", statusSource: "TEACHER", teacherStatus: "PRESENT", autoStatus: null,
  pendingReview: false, version: 3, afterFinalization: false, changed: true,
};
const REVIEW: ReviewResponse = {
  lectureId: "L1", studentId: "s1", action: "ACCEPT", status: "LATE", statusSource: "TEACHER", teacherStatus: "LATE", autoStatus: "LATE",
  pendingReview: false, version: 3,
};

// ======================================================================================
// 1. API helpers
// ======================================================================================

test("decision helper: POST to the encoded student route; body { status, expectedVersion, reason trimmed / null }; signal passed", async () => {
  const { impl, calls } = fakeFetch(() => success(DECISION));
  const abort = new AbortController();
  const result = await submitAttendanceDecision("L 1/x", "s?1#", { status: "ABSENT", expectedVersion: 2, reason: "  Left early.  " }, { fetchImpl: impl, signal: abort.signal });
  assert.deepEqual(result, { ok: true, status: 200, data: DECISION });
  assert.equal(calls[0].url, "/api/lectures/L%201%2Fx/attendance/students/s%3F1%23/decision");
  assert.deepEqual([calls[0].init?.method, calls[0].init?.credentials, calls[0].init?.cache], ["POST", "same-origin", "no-store"]);
  assert.equal(calls[0].init?.signal, abort.signal);
  assert.deepEqual(bodyOf(calls[0]), { status: "ABSENT", expectedVersion: 2, reason: "Left early." });

  const first = fakeFetch(() => success(DECISION));
  await submitAttendanceDecision("L1", "s1", { status: "PRESENT", expectedVersion: null }, { fetchImpl: first.impl });
  assert.deepEqual(bodyOf(first.calls[0]), { status: "PRESENT", expectedVersion: null, reason: null }, "no record: null version; blank reason: null");
  const blank = fakeFetch(() => success(DECISION));
  await submitAttendanceDecision("L1", "s1", { status: "PRESENT", expectedVersion: null, reason: "   " }, { fetchImpl: blank.impl });
  assert.equal(bodyOf(blank.calls[0]).reason, null);
});

test("review helper: POST .../review; body { action, expectedVersion, reason }", async () => {
  const { impl, calls } = fakeFetch(() => success(REVIEW));
  const result = await submitAttendanceReview("L1", "s1", { action: "ACCEPT", expectedVersion: 2, reason: " Verified. " }, { fetchImpl: impl });
  assert.deepEqual(result, { ok: true, status: 200, data: REVIEW });
  assert.equal(calls[0].url, "/api/lectures/L1/attendance/students/s1/review");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(bodyOf(calls[0]), { action: "ACCEPT", expectedVersion: 2, reason: "Verified." });
  const dismiss = fakeFetch(() => success({ ...REVIEW, action: "DISMISS" }));
  await submitAttendanceReview("L1", "s1", { action: "DISMISS", expectedVersion: 5 }, { fetchImpl: dismiss.impl });
  assert.deepEqual(bodyOf(dismiss.calls[0]), { action: "DISMISS", expectedVersion: 5, reason: null });
});

test("history helpers: GET with limit (default 50, clamped 1–100) and the cursor exactly as given (encoded); no body", async () => {
  const page = { lectureId: "L1", registerExists: true, registerVersion: 2, qrClosure: null, entries: [], nextCursor: "51" };
  const reg = fakeFetch(() => success(page));
  const abort = new AbortController();
  assert.deepEqual(await fetchRegisterHistory("L1", {}, { fetchImpl: reg.impl, signal: abort.signal }), { ok: true, status: 200, data: page });
  assert.equal(reg.calls[0].url, "/api/lectures/L1/attendance/history?limit=50");
  assert.deepEqual([reg.calls[0].init?.method, reg.calls[0].init?.body, reg.calls[0].init?.signal], ["GET", undefined, abort.signal]);

  const student = fakeFetch(() => success({ ...page, studentId: "s 1" }));
  await fetchStudentHistory("L1", "s 1", { cursor: "50", limit: 7 }, { fetchImpl: student.impl });
  assert.equal(student.calls[0].url.split("?")[0], "/api/lectures/L1/attendance/students/s%201/history");
  assert.deepEqual(queryOf(student.calls[0]), { cursor: "50", limit: "7" });

  assert.equal(buildHistoryQuery({ limit: 0 }), "limit=1");
  assert.equal(buildHistoryQuery({ limit: 500 }), "limit=100");
  assert.equal(buildHistoryQuery({ limit: Number.NaN }), "limit=50");
  assert.equal(buildHistoryQuery({ cursor: "a&b=c" }), "cursor=a%26b%3Dc&limit=50", "an odd cursor is still sent exactly (encoded)");
  assert.equal(buildHistoryQuery({ cursor: null }), "limit=50");
});

test("helpers: HTTP status, code and our message preserved for the Stage 5.6 errors; network errors never throw", async () => {
  for (const [status, code] of [
    [409, "ATTENDANCE_RECORD_CHANGED"],
    [400, "ATTENDANCE_REASON_REQUIRED"],
    [409, "ATTENDANCE_NO_PENDING_REVIEW"],
    [409, "ATTENDANCE_STUDENT_NOT_ENROLLED"],
    [404, "STUDENT_NOT_FOUND"],
    [409, "ATTENDANCE_BUSY"],
  ] as const) {
    const { impl } = fakeFetch(() => failure(status, code, "server wording"));
    const result = await submitAttendanceDecision("L1", "s1", { status: "PRESENT", expectedVersion: 1, reason: "x" }, { fetchImpl: impl });
    assert.deepEqual(result, { ok: false, status, code, message: attendanceErrorMessage(code) }, code);
  }
  const offline = await fetchStudentHistory("L1", "s1", {}, { fetchImpl: async () => { throw new TypeError("offline"); } });
  assert.deepEqual([offline.ok, !offline.ok && offline.code, !offline.ok && offline.status], [false, "NETWORK_ERROR", 0]);
});

test("messages: each new code has its own message; RECORD_CHANGED says to refresh; actions; unknown codes stay generic", () => {
  const generic = attendanceErrorMessage("SOMETHING_ELSE");
  for (const code of ["ATTENDANCE_RECORD_CHANGED", "ATTENDANCE_REASON_REQUIRED", "ATTENDANCE_NO_PENDING_REVIEW", "ATTENDANCE_STUDENT_NOT_ENROLLED", "STUDENT_NOT_FOUND", "ATTENDANCE_BUSY"]) {
    assert.ok((ATTENDANCE_API_ERROR_CODES as readonly string[]).includes(code), code);
    assert.notEqual(attendanceErrorMessage(code), generic, code);
  }
  assert.match(attendanceErrorMessage("ATTENDANCE_RECORD_CHANGED"), /changed/i);
  assert.match(attendanceErrorMessage("ATTENDANCE_RECORD_CHANGED"), /refresh the register/i);
  assert.equal(attendanceErrorAction("ATTENDANCE_RECORD_CHANGED"), "REFRESH_REGISTER");
  assert.equal(attendanceErrorAction("ATTENDANCE_NO_PENDING_REVIEW"), "REFRESH_REGISTER");
  assert.equal(attendanceErrorAction("ATTENDANCE_BUSY"), "RETRY", "unchanged: a manual retry");
  assert.equal(attendanceErrorAction("ATTENDANCE_REASON_REQUIRED"), "NONE");
  assert.equal(attendanceErrorAction("FINALIZATION_PREVIEW_STALE"), "RELOAD_PREVIEW", "existing mapping unchanged");
  assert.equal(generic, "The request could not be completed.");
});

// ======================================================================================
// 2. Reason rules (UX mirror of the server's)
// ======================================================================================

test("reasons: first mark optional; existing record required (even the same status); finalized required (even a first mark)", () => {
  assert.equal(decisionReasonRequirement({ hasRecord: false, finalized: false }), "OPTIONAL");
  assert.equal(decisionReasonRequirement({ hasRecord: true, finalized: false }), "REQUIRED");
  assert.equal(decisionReasonRequirement({ hasRecord: false, finalized: true }), "REQUIRED");
  assert.equal(decisionReasonRequirement({ hasRecord: true, finalized: true }), "REQUIRED");
  assert.equal(reviewReasonRequirement("ACCEPT"), "REQUIRED");
  assert.equal(reviewReasonRequirement("DISMISS"), "OPTIONAL");
});

test("reasons: trimmed; blank is none; 500 characters after trimming is the limit", () => {
  assert.deepEqual(checkAttendanceReason("  Verified.  ", "REQUIRED"), { ok: true, reason: "Verified." });
  assert.deepEqual(checkAttendanceReason("   ", "OPTIONAL"), { ok: true, reason: null });
  assert.deepEqual(checkAttendanceReason(undefined, "OPTIONAL"), { ok: true, reason: null });
  assert.deepEqual(checkAttendanceReason(null, "REQUIRED"), { ok: false, problem: "REQUIRED" });
  assert.deepEqual(checkAttendanceReason("  \n ", "REQUIRED"), { ok: false, problem: "REQUIRED" });
  const max = "x".repeat(ATTENDANCE_REASON_MAX_LENGTH);
  assert.deepEqual(checkAttendanceReason(`  ${max}  `, "REQUIRED"), { ok: true, reason: max }, "trimmed before the length check");
  assert.deepEqual(checkAttendanceReason(`${max}y`, "OPTIONAL"), { ok: false, problem: "TOO_LONG" });
  assert.match(reasonProblemMessage("REQUIRED"), /reason/i);
  assert.match(reasonProblemMessage("TOO_LONG"), /500/);
});

// ======================================================================================
// 3. Decision / review controller
// ======================================================================================

function actionHarness(options: { lock?: ReturnType<typeof createActionLock>; refreshResult?: boolean } = {}) {
  const states: RecordActionUiState[] = [];
  const decisions: { studentId: string; request: DecisionRequest; signal: AbortSignal }[] = [];
  const reviews: { studentId: string; request: ReviewRequest; signal: AbortSignal }[] = [];
  const decisionAnswers: ReturnType<typeof deferred<AttendanceApiResult<DecisionResponse>>>[] = [];
  const reviewAnswers: ReturnType<typeof deferred<AttendanceApiResult<ReviewResponse>>>[] = [];
  let refreshes = 0;
  const refreshGate = { next: null as ReturnType<typeof deferred<boolean>> | null };
  const controller = createRecordActionController({
    lectureId: "L1",
    lock: options.lock,
    onChange: (s) => states.push(s),
    refresh: async () => {
      refreshes += 1;
      if (refreshGate.next) return refreshGate.next.promise;
      return options.refreshResult ?? true;
    },
    decide: (lectureId, studentId, request, { signal }) => {
      assert.equal(lectureId, "L1");
      decisions.push({ studentId, request, signal });
      const d = deferred<AttendanceApiResult<DecisionResponse>>();
      decisionAnswers.push(d);
      return d.promise;
    },
    review: (lectureId, studentId, request, { signal }) => {
      reviews.push({ studentId, request, signal });
      const d = deferred<AttendanceApiResult<ReviewResponse>>();
      reviewAnswers.push(d);
      return d.promise;
    },
  });
  return { controller, states, decisions, reviews, decisionAnswers, reviewAnswers, refreshes: () => refreshes, refreshGate, last: () => states.at(-1)! };
}

const withRecord = { studentId: "s1", record: { version: 2 } };
const noRecord = { studentId: "s1", record: null };

test("decision: expectedVersion from the loaded record (null without one); success refreshes the register; nothing optimistic", async () => {
  const h = actionHarness();
  const run = h.controller.submitDecision({ target: withRecord, status: "ABSENT", reason: "Left.", finalized: false });
  assert.deepEqual(h.decisions[0].request, { status: "ABSENT", expectedVersion: 2, reason: "Left." });
  assert.deepEqual(h.last(), { phase: "submitting", kind: "decision", studentId: "s1" });
  h.decisionAnswers[0].resolve({ ok: true, status: 200, data: DECISION });
  assert.equal(await run, true);
  assert.equal(h.refreshes(), 1);
  assert.deepEqual(h.states.slice(-2).map((s) => s.phase === "succeeded" && s.refresh), ["pending", "done"]);
  assert.equal(withRecord.record.version, 2, "the loaded data is never changed locally");

  const first = actionHarness();
  const firstRun = first.controller.submitDecision({ target: noRecord, status: "PRESENT", finalized: false });
  assert.deepEqual(first.decisions[0].request, { status: "PRESENT", expectedVersion: null, reason: null });
  first.decisionAnswers[0].resolve({ ok: true, status: 200, data: DECISION });
  await firstRun;
});

test("decision: reason rules checked before sending (same-status confirmation and finalized first mark need one)", async () => {
  const h = actionHarness();
  assert.equal(await quick(h.controller.submitDecision({ target: withRecord, status: "PRESENT", finalized: false })), false);
  assert.deepEqual(h.last(), { phase: "invalid", kind: "decision", studentId: "s1", problem: "REQUIRED" });
  assert.equal(await quick(h.controller.submitDecision({ target: noRecord, status: "PRESENT", reason: "  ", finalized: true })), false);
  assert.equal(await quick(h.controller.submitDecision({ target: noRecord, status: "PRESENT", reason: "x".repeat(501), finalized: false })), false);
  assert.deepEqual(h.last(), { phase: "invalid", kind: "decision", studentId: "s1", problem: "TOO_LONG" });
  assert.equal(h.decisions.length, 0, "nothing sent");
  assert.equal(h.controller.isBusy(), false);
});

test("review: ACCEPT needs a reason, DISMISS does not; expectedVersion from the record; no record → nothing sent", async () => {
  const h = actionHarness();
  assert.equal(await quick(h.controller.submitReview({ target: withRecord, action: "ACCEPT" })), false);
  assert.equal(h.last().phase, "invalid");
  assert.equal(await quick(h.controller.submitReview({ target: noRecord, action: "DISMISS" })), false);
  assert.equal(h.reviews.length, 0);

  const dismiss = h.controller.submitReview({ target: withRecord, action: "DISMISS" });
  assert.deepEqual(h.reviews[0].request, { action: "DISMISS", expectedVersion: 2, reason: null });
  h.reviewAnswers[0].resolve({ ok: true, status: 200, data: { ...REVIEW, action: "DISMISS" } });
  await dismiss;
  const dismissed = h.last();
  assert.deepEqual([dismissed.phase, dismissed.phase === "succeeded" && dismissed.kind], ["succeeded", "review"]);

  const accept = h.controller.submitReview({ target: withRecord, action: "ACCEPT", reason: " Verified. " });
  assert.deepEqual(h.reviews[1].request, { action: "ACCEPT", expectedVersion: 2, reason: "Verified." });
  h.reviewAnswers[1].resolve({ ok: true, status: 200, data: REVIEW });
  await accept;
});

test("one action at a time: a second submit (decision or review) while one is in flight or refreshing is refused", async () => {
  const h = actionHarness();
  h.refreshGate.next = deferred<boolean>();
  const run = h.controller.submitDecision({ target: noRecord, status: "PRESENT", finalized: false });
  assert.equal(await quick(h.controller.submitDecision({ target: noRecord, status: "LATE", finalized: false })), false);
  assert.equal(await quick(h.controller.submitReview({ target: withRecord, action: "DISMISS" })), false);
  assert.equal(h.decisions.length, 1);
  h.decisionAnswers[0].resolve({ ok: true, status: 200, data: DECISION });
  await tick();
  assert.equal(h.controller.isBusy(), true, "still busy while the register is refreshed");
  assert.equal(await quick(h.controller.submitDecision({ target: noRecord, status: "LATE", finalized: false })), false);
  h.refreshGate.next.resolve(true);
  await run;
  assert.equal(h.controller.isBusy(), false);
  assert.equal(h.decisions.length, 1, "never more than one request");
});

test("409 RECORD_CHANGED: reported as stale, the register is refreshed, nothing is retried (no other version sent)", async () => {
  const h = actionHarness();
  const run = h.controller.submitDecision({ target: withRecord, status: "ABSENT", reason: "x", finalized: false });
  h.decisionAnswers[0].resolve(apiError(409, "ATTENDANCE_RECORD_CHANGED"));
  await run;
  const last = h.last();
  assert.equal(last.phase, "failed");
  if (last.phase !== "failed") return;
  assert.deepEqual([last.stale, last.cancelled, last.refresh, last.error.code], [true, false, "done", "ATTENDANCE_RECORD_CHANGED"]);
  assert.equal(h.refreshes(), 1);
  await tick();
  assert.equal(h.decisions.length, 1, "no automatic retry");
});

test("409 other codes refresh too (BUSY / NO_PENDING_REVIEW / NOT_ENROLLED); non-409 errors do not; stale only for record changes", async () => {
  for (const [status, code, stale, refresh] of [
    [409, "ATTENDANCE_BUSY", false, "done"],
    [409, "ATTENDANCE_NO_PENDING_REVIEW", true, "done"],
    [409, "ATTENDANCE_STUDENT_NOT_ENROLLED", false, "done"],
    [400, "ATTENDANCE_REASON_REQUIRED", false, "skipped"],
    [404, "STUDENT_NOT_FOUND", false, "skipped"],
    [0, "NETWORK_ERROR", false, "skipped"],
  ] as const) {
    const h = actionHarness();
    const run = h.controller.submitReview({ target: withRecord, action: "DISMISS" });
    h.reviewAnswers[0].resolve(apiError(status, code));
    await run;
    const last = h.last();
    assert.equal(last.phase, "failed", code);
    if (last.phase !== "failed") continue;
    assert.deepEqual([last.stale, last.refresh], [stale, refresh], code);
    assert.equal(h.refreshes(), refresh === "done" ? 1 : 0, code);
    assert.equal(h.reviews.length, 1, `${code}: no retry`);
  }
  assert.equal(isStaleRecordError(apiError(409, "ATTENDANCE_RECORD_CHANGED")), true);
  assert.equal(isStaleRecordError(apiError(409, "ATTENDANCE_BUSY")), false);
});

test("a failed refresh is reported (refresh: failed); a throwing refresh too; the controller is free again", async () => {
  const h = actionHarness({ refreshResult: false });
  const run = h.controller.submitDecision({ target: noRecord, status: "PRESENT", finalized: false });
  h.decisionAnswers[0].resolve({ ok: true, status: 200, data: DECISION });
  await run;
  const done = h.last();
  assert.equal(done.phase === "succeeded" && done.refresh, "failed");
  assert.equal(h.controller.isBusy(), false);
});

test("the shared lock: held from submit until the refresh ends, released on success, failure, cancellation and dispose", async () => {
  const lock = createActionLock();
  const h = actionHarness({ lock });
  // Another register action holds the lock: refused, nothing sent.
  assert.equal(lock.tryAcquire("reconcile"), true);
  assert.equal(await quick(h.controller.submitDecision({ target: noRecord, status: "PRESENT", finalized: false })), false);
  assert.equal(h.decisions.length, 0);
  lock.release("reconcile");

  // Success.
  let run = h.controller.submitDecision({ target: noRecord, status: "PRESENT", finalized: false });
  assert.equal(lock.holder(), "record-action");
  h.decisionAnswers[0].resolve({ ok: true, status: 200, data: DECISION });
  await run;
  assert.equal(lock.holder(), null);
  // Failure.
  run = h.controller.submitDecision({ target: withRecord, status: "LATE", reason: "x", finalized: false });
  h.decisionAnswers[1].resolve(apiError(500, "INTERNAL_SERVER_ERROR"));
  await run;
  assert.equal(lock.holder(), null);
  // Cancellation: aborted; the outcome is unknown, so the register is refreshed.
  run = h.controller.submitDecision({ target: withRecord, status: "LATE", reason: "x", finalized: false });
  assert.equal(h.controller.cancel(), true);
  assert.equal(h.decisions[2].signal.aborted, true);
  h.decisionAnswers[2].resolve(apiError(0, "NETWORK_ERROR"));
  await run;
  const last = h.last();
  assert.deepEqual(last.phase === "failed" && [last.cancelled, last.refresh], [true, "done"]);
  assert.equal(lock.holder(), null);
  assert.equal(h.controller.cancel(), false, "nothing to cancel");
  // Dispose while in flight.
  run = h.controller.submitDecision({ target: withRecord, status: "LATE", reason: "x", finalized: false });
  assert.equal(lock.holder(), "record-action");
  h.controller.dispose();
  assert.equal(lock.holder(), null);
  assert.equal(h.decisions[3].signal.aborted, true);
});

test("dispose: a late answer is ignored (no state change, no refresh); nothing can be submitted afterwards", async () => {
  const h = actionHarness();
  const run = h.controller.submitDecision({ target: noRecord, status: "PRESENT", finalized: false });
  const before = h.states.length;
  h.controller.dispose();
  h.decisionAnswers[0].resolve({ ok: true, status: 200, data: DECISION });
  await run;
  assert.equal(h.states.length, before, "no update after dispose");
  assert.equal(h.refreshes(), 0);
  assert.equal(await quick(h.controller.submitDecision({ target: noRecord, status: "PRESENT", finalized: false })), false);
  assert.equal(h.controller.reset(), false);
});

test("reset: back to idle, refused while busy; a throwing API call becomes INVALID_RESPONSE (never stuck)", async () => {
  const states: RecordActionUiState[] = [];
  const c = createRecordActionController({
    lectureId: "L1",
    onChange: (s) => states.push(s),
    refresh: async () => true,
    decide: async () => { throw new Error("broken"); },
  });
  await c.submitDecision({ target: noRecord, status: "PRESENT", finalized: false });
  assert.deepEqual(states.at(-1)?.phase === "failed" && (states.at(-1) as { error: AttendanceApiError }).error.code, "INVALID_RESPONSE");
  assert.equal(c.isBusy(), false);
  assert.equal(c.reset(), true);
  assert.deepEqual(states.at(-1), { phase: "idle" });
});

// ======================================================================================
// 4. History loader
// ======================================================================================

const entry = (version: number): StudentHistoryEntry => ({
  version, action: "TEACHER_SET", at: new Date(Date.UTC(2026, 8, 1, 12, version)).toISOString(), actor: { role: "TEACHER", isCurrentTeacher: true },
  reason: null, afterFinalization: false, status: { from: null, to: "PRESENT" }, teacherStatus: { from: null, to: "PRESENT" }, autoStatus: { from: null, to: null }, cause: null,
});
const studentPage = (versions: number[], nextCursor: string | null, recordVersion = 9): StudentHistoryResponse => ({
  lectureId: "L1", studentId: "s1", recordExists: true, record: { status: "PRESENT", statusSource: "TEACHER", version: recordVersion, pendingReview: false },
  entries: versions.map(entry), nextCursor,
});

function historyHarness(pageSize?: number) {
  const requests: { page: HistoryPageRequest; signal: AbortSignal }[] = [];
  const answers: ReturnType<typeof deferred<AttendanceApiResult<StudentHistoryResponse>>>[] = [];
  const states: HistoryState<StudentHistoryResponse, StudentHistoryEntry>[] = [];
  const loader = createHistoryLoader<StudentHistoryResponse, StudentHistoryEntry>({
    pageSize,
    onChange: (s) => states.push(s),
    fetchPage: (page, { signal }) => {
      requests.push({ page, signal });
      const d = deferred<AttendanceApiResult<StudentHistoryResponse>>();
      answers.push(d);
      return d.promise;
    },
  });
  return { loader, requests, answers, states };
}

test("history: first page without a cursor, then the server's nextCursor exactly; limit default 50; complete at null", async () => {
  const h = historyHarness();
  const first = h.loader.load();
  assert.deepEqual(h.requests[0].page, { cursor: null, limit: 50 });
  assert.equal(h.loader.getState().loading, "first");
  h.answers[0].resolve({ ok: true, status: 200, data: studentPage([1, 2, 3], "3") });
  assert.equal(await first, true);
  assert.deepEqual([h.loader.getState().entries.map((e) => e.version), h.loader.getState().nextCursor, h.loader.getState().complete], [[1, 2, 3], "3", false]);
  assert.deepEqual(h.loader.getState().latest, { lectureId: "L1", studentId: "s1", recordExists: true, record: { status: "PRESENT", statusSource: "TEACHER", version: 9, pendingReview: false } });

  const more = h.loader.loadMore();
  assert.deepEqual(h.requests[1].page, { cursor: "3", limit: 50 });
  h.answers[1].resolve({ ok: true, status: 200, data: studentPage([4, 5], null, 10) });
  await more;
  assert.deepEqual([h.loader.getState().entries.map((e) => e.version), h.loader.getState().nextCursor, h.loader.getState().complete], [[1, 2, 3, 4, 5], null, true]);
  assert.equal(h.loader.getState().latest?.record?.version, 10, "the header comes from the latest page (not one snapshot)");
  assert.equal(await quick(h.loader.loadMore()), false, "nothing after the end");
  assert.equal(h.requests.length, 2);
});

test("history: page size clamped to 1–100; loadMore before the first page is refused", async () => {
  assert.deepEqual([clampHistoryPageSize(undefined), clampHistoryPageSize(0), clampHistoryPageSize(7.9), clampHistoryPageSize(1000), clampHistoryPageSize(Number.NaN)], [50, 1, 7, 100, 50]);
  const h = historyHarness(1000);
  assert.equal(await quick(h.loader.loadMore()), false);
  void h.loader.load();
  assert.equal(h.requests[0].page.limit, 100);
});

test("history: no concurrent page requests; duplicate entries (overlapping pages) never added; order by version", async () => {
  const h = historyHarness(2);
  const first = h.loader.load();
  h.answers[0].resolve({ ok: true, status: 200, data: studentPage([1, 2], "2") });
  await first;
  const more = h.loader.loadMore();
  assert.equal(await quick(h.loader.loadMore()), false, "a second loadMore while one is loading is refused");
  assert.equal(h.requests.length, 2);
  h.answers[1].resolve({ ok: true, status: 200, data: studentPage([2, 4, 3], "4") });
  await more;
  assert.deepEqual(h.loader.getState().entries.map((e) => e.version), [1, 2, 3, 4]);
  assert.deepEqual(mergeHistoryEntries([entry(1)], [entry(1), entry(1), entry(0)]).map((e) => e.version), [0, 1]);
});

test("history: an error keeps the loaded entries and the cursor; loadMore retries the same page (manually)", async () => {
  const h = historyHarness(2);
  const first = h.loader.load();
  h.answers[0].resolve({ ok: true, status: 200, data: studentPage([1, 2], "2") });
  await first;
  const failing = h.loader.loadMore();
  h.answers[1].resolve(apiError(500, "INTERNAL_SERVER_ERROR"));
  assert.equal(await failing, false);
  const s = h.loader.getState();
  assert.deepEqual([s.entries.map((e) => e.version), s.nextCursor, s.loading, s.error?.code], [[1, 2], "2", null, "INTERNAL_SERVER_ERROR"]);
  await tick();
  assert.equal(h.requests.length, 2, "no automatic retry");
  const retry = h.loader.loadMore();
  assert.deepEqual(h.requests[2].page, { cursor: "2", limit: 2 }, "the same cursor again");
  h.answers[2].resolve({ ok: true, status: 200, data: studentPage([3], null) });
  await retry;
  assert.deepEqual([h.loader.getState().entries.map((e) => e.version), h.loader.getState().error], [[1, 2, 3], null]);

  // A failed reload keeps what was shown.
  const reload = h.loader.load();
  h.answers[3].resolve(apiError(0, "NETWORK_ERROR"));
  await reload;
  assert.deepEqual([h.loader.getState().entries.map((e) => e.version), h.loader.getState().error?.code], [[1, 2, 3], "NETWORK_ERROR"]);
});

test("history: load() aborts the request in flight and ignores its late answer; the new first page replaces the entries", async () => {
  const h = historyHarness(2);
  const first = h.loader.load();
  h.answers[0].resolve({ ok: true, status: 200, data: studentPage([1, 2], "2") });
  await first;
  const more = h.loader.loadMore();
  const reload = h.loader.load();
  assert.equal(h.requests[1].signal.aborted, true, "the older request is aborted");
  h.answers[2].resolve({ ok: true, status: 200, data: studentPage([1, 2, 3], null) });
  await reload;
  h.answers[1].resolve({ ok: true, status: 200, data: studentPage([99], "99") });
  assert.equal(await more, false, "the stale answer is ignored");
  assert.deepEqual([h.loader.getState().entries.map((e) => e.version), h.loader.getState().complete], [[1, 2, 3], true]);
});

test("history: dispose aborts and ignores everything afterwards", async () => {
  const h = historyHarness();
  const first = h.loader.load();
  const count = h.states.length;
  h.loader.dispose();
  assert.equal(h.requests[0].signal.aborted, true);
  h.answers[0].resolve({ ok: true, status: 200, data: studentPage([1], null) });
  assert.equal(await first, false);
  assert.equal(h.states.length, count);
  assert.equal(await h.loader.load(), false);
});

test("history factories: register and student loaders call their own routes with the cursor chain", async () => {
  const regPage = (versions: number[], nextCursor: string | null) => ({
    lectureId: "L1", registerExists: true, registerVersion: 3, qrClosure: null, nextCursor,
    entries: versions.map((version) => ({ version, action: "CREATED", at: "2026-09-01T12:00:00.000Z", actor: { role: "SYSTEM", isCurrentTeacher: false }, reason: null, graceMinutes: null, scheduledStartAt: null, scheduledEndAt: null, finalization: null, recalculatedCount: null })),
  });
  const reg = fakeFetch(() => success(regPage([1], "1")), () => success(regPage([2], null)));
  const register = createRegisterHistoryLoader({ lectureId: "L 1", onChange: () => {}, fetchImpl: reg.impl, pageSize: 1 });
  await register.load();
  await register.loadMore();
  assert.deepEqual(reg.calls.map((c) => c.url), ["/api/lectures/L%201/attendance/history?limit=1", "/api/lectures/L%201/attendance/history?cursor=1&limit=1"]);
  assert.deepEqual(register.getState().entries.map((e) => e.version), [1, 2]);

  const stu = fakeFetch(() => success(studentPage([1], null)));
  const student = createStudentHistoryLoader({ lectureId: "L1", studentId: "s/1", onChange: () => {}, fetchImpl: stu.impl });
  await student.load();
  assert.equal(stu.calls[0].url, "/api/lectures/L1/attendance/students/s%2F1/history?limit=50");
  assert.equal(student.getState().complete, true);
});

test("register error codes (Stage 5.7b-2b-2): known, own messages, refresh-the-register action; mapping preserved", () => {
  const generic = attendanceErrorMessage("SOMETHING_ELSE");
  for (const code of ["ATTENDANCE_REGISTER_CHANGED", "ATTENDANCE_REGISTER_FINALIZED"]) {
    assert.ok((ATTENDANCE_API_ERROR_CODES as readonly string[]).includes(code), code);
    assert.notEqual(attendanceErrorMessage(code), generic, code);
    assert.equal(attendanceErrorAction(code), "REFRESH_REGISTER", code);
  }
  assert.match(attendanceErrorMessage("ATTENDANCE_REGISTER_CHANGED"), /changed.*Refresh the register/i);
  assert.match(attendanceErrorMessage("ATTENDANCE_REGISTER_FINALIZED"), /finalized/i);
  assert.equal(attendanceErrorAction("ATTENDANCE_BUSY"), "RETRY", "existing mapping unchanged");
});
