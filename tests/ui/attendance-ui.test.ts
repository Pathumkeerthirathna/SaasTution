/**
 * Shared attendance UI logic (components/attendance/attendance-ui.ts,
 * Stage 5.5d-1): the typed fetch helper, labels, error / blocker messages and
 * the reconciliation loop. Pure: fetch is injected (real Response objects),
 * no server, no database.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTENDANCE_API_ERROR_CODES,
  absenceDecisionLabel,
  attendanceErrorAction,
  attendanceErrorMessage,
  attendanceRequest,
  attendanceStatusLabel,
  buildAttendanceOverviewQuery,
  fetchAttendanceOverview,
  clampReconcilePageSize,
  eligibilityLabel,
  evidenceChannels,
  evidenceSummaryLabel,
  fetchAttendanceRegister,
  fetchFinalizationPreview,
  finalizationBlockerMessage,
  finalizeAttendance,
  runReconciliation,
  statusSourceLabel,
  type ReconcilePage,
  type ReconcileProgress,
} from "../../components/attendance/attendance-ui";

type Call = { url: string; init?: RequestInit };

/** A fetch that answers from a queue of handlers and records every call. */
function fakeFetch(...handlers: ((call: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return handler(call);
  };
  return { impl, calls };
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const success = (data: unknown, status = 200) => jsonResponse(status, { success: true, data });
const failure = (status: number, code: string, message = "Server text", details?: unknown) =>
  jsonResponse(status, { success: false, error: { message, code, ...(details === undefined ? {} : { details }) } });
const bodyOf = (call: Call) => JSON.parse(String(call.init?.body));

// ---- 1. Fetch helper ------------------------------------------------------------------------

test("fetch: a success returns the typed data and status; GET sends no body; same-origin, no-store", async () => {
  const { impl, calls } = fakeFetch(() => success({ lecture: { id: "L1" } }));
  const result = await fetchAttendanceRegister("L 1/x", { fetchImpl: impl });
  assert.deepEqual(result, { ok: true, status: 200, data: { lecture: { id: "L1" } } });
  assert.equal(calls[0].url, "/api/lectures/L%201%2Fx/attendance", "the id is URL-encoded");
  assert.deepEqual([calls[0].init?.method, calls[0].init?.body, calls[0].init?.credentials, calls[0].init?.cache], ["GET", undefined, "same-origin", "no-store"]);

  const preview = fakeFetch(() => success({ fingerprint: "f".repeat(64) }));
  assert.equal((await fetchFinalizationPreview("L1", { fetchImpl: preview.impl })).ok, true);
  assert.equal(preview.calls[0].url, "/api/lectures/L1/attendance/finalization");
});

test("fetch: POST sends JSON (finalize sends only the fingerprint)", async () => {
  const { impl, calls } = fakeFetch(() => success({ alreadyFinalized: false }));
  await finalizeAttendance("L1", "a".repeat(64), { fetchImpl: impl });
  assert.equal(calls[0].url, "/api/lectures/L1/attendance/finalize");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(bodyOf(calls[0]), { fingerprint: "a".repeat(64) });
  assert.equal((calls[0].init?.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("fetch: API errors keep status, code and safe details; known codes get our message, not the server's", async () => {
  const stale = await attendanceRequest("/x", { fetchImpl: fakeFetch(() => failure(409, "FINALIZATION_PREVIEW_STALE", "server words")).impl });
  assert.deepEqual(stale, { ok: false, status: 409, code: "FINALIZATION_PREVIEW_STALE", message: attendanceErrorMessage("FINALIZATION_PREVIEW_STALE") });

  const pending = await attendanceRequest("/x", {
    fetchImpl: fakeFetch(() => failure(409, "FINALIZATION_EVIDENCE_PENDING", "m", { pendingOnlineEvidence: 2, unknownApprovalEvidence: 0 })).impl,
  });
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.deepEqual(pending.details, { pendingOnlineEvidence: 2, unknownApprovalEvidence: 0 });

  const config = await attendanceRequest("/x", {
    fetchImpl: fakeFetch(() => failure(503, "ATTENDANCE_EVIDENCE_NOT_CONFIGURED", "m", { setting: "ATTENDANCE_EVIDENCE_STARTED_AT", status: "MISSING" })).impl,
  });
  assert.deepEqual(config.ok ? null : [config.status, config.code, config.details], [503, "ATTENDANCE_EVIDENCE_NOT_CONFIGURED", { setting: "ATTENDANCE_EVIDENCE_STARTED_AT", status: "MISSING" }]);

  for (const [status, code] of [[401, "UNAUTHORIZED"], [403, "CROSS_ORIGIN_REQUEST_REJECTED"], [404, "LECTURE_NOT_FOUND"], [409, "ATTENDANCE_BUSY"]] as const) {
    const result = await attendanceRequest("/x", { fetchImpl: fakeFetch(() => failure(status, code)).impl });
    assert.deepEqual(result.ok ? null : [result.status, result.code, result.message], [status, code, attendanceErrorMessage(code)]);
  }
  // An unknown 4xx code is kept with the server's (fixed-text) message.
  const unknown = await attendanceRequest("/x", { fetchImpl: fakeFetch(() => failure(409, "SOME_NEW_CODE", "A safe server text.")).impl });
  assert.deepEqual(unknown.ok ? null : [unknown.code, unknown.message], ["SOME_NEW_CODE", "A safe server text."]);
});

test("fetch: 5xx never shows server text or details (development messages may hold internals)", async () => {
  for (const code of ["INTERNAL_SERVER_ERROR", "SOMETHING_ELSE"]) {
    const result = await attendanceRequest("/x", {
      fetchImpl: fakeFetch(() => failure(500, code, "PrismaClientKnownRequestError: relation ... at /srv/app.js:1", { sql: "SELECT" })).impl,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, code, "the code is kept");
      assert.equal(result.message, attendanceErrorMessage("INTERNAL_SERVER_ERROR"));
      assert.equal("details" in result, false);
    }
  }
  const integrity = await attendanceRequest("/x", { fetchImpl: fakeFetch(() => failure(500, "FINALIZATION_INTEGRITY_ERROR", "x", { a: 1 })).impl });
  assert.deepEqual(integrity.ok ? null : [integrity.code, integrity.message, "details" in integrity], ["FINALIZATION_INTEGRITY_ERROR", attendanceErrorMessage("FINALIZATION_INTEGRITY_ERROR"), false]);
});

test("fetch: non-JSON, malformed, empty and unexpected responses; network failure and abort never throw", async () => {
  const cases: [Response, number, string][] = [
    [new Response("<html>Bad gateway</html>", { status: 502 }), 502, "INTERNAL_SERVER_ERROR"],
    [new Response("<html>ok?</html>", { status: 200 }), 200, "INVALID_RESPONSE"],
    [new Response("{not json", { status: 400 }), 400, "INVALID_RESPONSE"],
    [new Response(null, { status: 204 }), 204, "INVALID_RESPONSE"],
    [jsonResponse(200, { success: true }), 200, "INVALID_RESPONSE"], // no data
    [jsonResponse(200, { success: false, error: { code: "X", message: "m" } }), 200, "INVALID_RESPONSE"], // error with 200
    [jsonResponse(404, { success: false, error: { message: "no code" } }), 404, "INVALID_RESPONSE"],
    [jsonResponse(400, ["array"]), 400, "INVALID_RESPONSE"],
    [new Response("Service Unavailable", { status: 503 }), 503, "INVALID_RESPONSE"],
  ];
  for (const [response, status, code] of cases) {
    const result = await attendanceRequest("/x", { fetchImpl: async () => response });
    assert.deepEqual(result.ok ? null : [result.status, result.code], [status, code]);
    if (!result.ok) assert.equal(result.message, attendanceErrorMessage(code));
  }
  const network = await attendanceRequest("/x", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  assert.deepEqual(network.ok ? null : [network.status, network.code], [0, "NETWORK_ERROR"]);
  const controller = new AbortController();
  controller.abort();
  const aborted = await attendanceRequest("/x", { signal: controller.signal, fetchImpl: (_u, init) => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError", init })) });
  assert.deepEqual(aborted.ok ? null : aborted.code, "NETWORK_ERROR");
});

// ---- 2. Labels ------------------------------------------------------------------------------

test("labels: statuses, sources, eligibility and absence decisions; nothing guessed for unknown values", () => {
  assert.deepEqual(["PRESENT", "LATE", "ABSENT", "EXCUSED"].map((s) => attendanceStatusLabel(s)), [
    { label: "Present", tone: "positive" },
    { label: "Late", tone: "warning" },
    { label: "Absent", tone: "danger" },
    { label: "Excused", tone: "info" },
  ]);
  assert.deepEqual(attendanceStatusLabel(null), { label: "No record", tone: "neutral" });
  assert.deepEqual(attendanceStatusLabel("WHATEVER"), { label: "Unknown status", tone: "neutral" });

  assert.deepEqual(["AUTO", "TEACHER", "FINALIZATION", "BACKFILL", null, "X"].map(statusSourceLabel), [
    "Automatic (from evidence)", "Teacher decision", "Finalization (automatic absence)", "Backfill (historical)", "No record", "Unknown source",
  ]);

  assert.equal(eligibilityLabel({ outcome: "ELIGIBLE", reason: "ELIGIBLE" }).label, "Eligible");
  assert.equal(eligibilityLabel({ outcome: "NOT_ELIGIBLE", reason: "NOT_APPROVED" }).label, "Not approved");
  assert.equal(eligibilityLabel({ outcome: "NOT_ELIGIBLE", reason: "NOT_ENROLLED" }).label, "Not enrolled at the start");
  assert.equal(eligibilityLabel({ outcome: "NOT_ELIGIBLE", reason: "STUDENT_INACTIVE" }).label, "Inactive or deleted account");
  assert.deepEqual(eligibilityLabel({ outcome: "UNKNOWN", reason: "APPROVAL_UNKNOWN" }), { label: "Approval unknown (manual review)", tone: "warning" });
  assert.equal(eligibilityLabel({ outcome: "UNKNOWN", reason: "NEW_REASON" }).tone, "warning");
  assert.equal(eligibilityLabel(null).label, "Not available");

  assert.equal(absenceDecisionLabel("CREATE_ABSENT"), "Will be marked absent at finalization");
  assert.equal(absenceDecisionLabel("MANUAL_REVIEW"), "Manual review (never marked absent automatically)");
  assert.equal(absenceDecisionLabel(null), null);
});

test("evidence: online and QR kept apart, from the record's own timestamps only", () => {
  assert.deepEqual(evidenceChannels(null), []);
  assert.deepEqual(evidenceChannels({ firstOnlineAt: null, firstQrAt: null }), []);
  assert.deepEqual(evidenceChannels({ firstOnlineAt: "2026-09-01T12:40:00.000Z", firstQrAt: "2026-09-01T12:35:00.000Z" }), [
    { channel: "QR", at: "2026-09-01T12:35:00.000Z" },
    { channel: "ONLINE", at: "2026-09-01T12:40:00.000Z" },
  ]);
  assert.equal(evidenceSummaryLabel({ firstOnlineAt: "2026-09-01T12:40:00.000Z", firstQrAt: null }), "Online");
  assert.equal(evidenceSummaryLabel({ firstOnlineAt: null, firstQrAt: "2026-09-01T12:40:00.000Z" }), "QR");
  assert.equal(evidenceSummaryLabel({ firstOnlineAt: "2026-09-01T12:40:00.000Z", firstQrAt: "2026-09-01T12:41:00.000Z" }), "Online and QR");
  assert.equal(evidenceSummaryLabel({ firstOnlineAt: null, firstQrAt: null }), "No evidence", "a teacher / finalization status is not evidence");
});

// ---- 3. Error and blocker messages ------------------------------------------------------------

test("messages: every API error code has its own message; actions follow the code; unknown codes stay generic", () => {
  const generic = attendanceErrorMessage("NOT_A_CODE");
  for (const code of ATTENDANCE_API_ERROR_CODES) assert.notEqual(attendanceErrorMessage(code), generic, code);
  assert.equal(generic, "The request could not be completed.");
  assert.deepEqual(
    ["ATTENDANCE_BUSY", "FINALIZATION_PREVIEW_STALE", "FINALIZATION_CANDIDATES_CHANGED", "FINALIZATION_EVIDENCE_PENDING", "FINALIZATION_SESSION_ACTIVE",
      "UNAUTHORIZED", "CROSS_ORIGIN_REQUEST_REJECTED", "ATTENDANCE_APPROVAL_NOT_CONFIGURED", "FINALIZATION_INTEGRITY_ERROR", "LECTURE_NOT_FOUND", "NETWORK_ERROR", "X"].map(attendanceErrorAction),
    ["RETRY", "RELOAD_PREVIEW", "RELOAD_PREVIEW", "RECONCILE", "END_SESSION", "SIGN_IN", "RELOAD_PAGE", "CONTACT_SUPPORT", "CONTACT_SUPPORT", "NONE", "RETRY", "NONE"]
  );
});

test("messages: every finalization blocker has its own message", () => {
  const blockers = ["ALREADY_FINALIZED", "LECTURE_CANCELLED", "LECTURE_NOT_STARTED", "SCHEDULED_END_NOT_PASSED", "COMPLETION_REQUIRED",
    "SESSION_ACTIVE", "EVIDENCE_PENDING", "UNKNOWN_EVIDENCE", "ROSTER_LIMIT_EXCEEDED"];
  const messages = blockers.map(finalizationBlockerMessage);
  assert.equal(new Set(messages).size, blockers.length);
  assert.ok(!messages.includes("Finalization is blocked."));
  assert.equal(finalizationBlockerMessage("NEW_BLOCKER"), "Finalization is blocked.");
});

// ---- 4. Reconciliation loop ------------------------------------------------------------------

const ZERO = { processed: 0, applied: 0, duplicates: 0, ineligible: 0, unknown: 0, inactive: 0, finalizedWithoutRecord: 0, busy: 0, skipped: 0 };
const page = (fields: Partial<ReconcilePage>): ReconcilePage => ({ lectureId: "L1", ...ZERO, nextCursor: null, stoppedBecause: null, ...fields });
const noWait = { wait: async () => {}, busyRetryDelayMs: 0 };

test("reconcile: multi-page pass follows nextCursor with the default page of 100 and totals the counts", async () => {
  const { impl, calls } = fakeFetch(
    () => success(page({ processed: 100, applied: 60, duplicates: 40, nextCursor: "s099" })),
    () => success(page({ processed: 100, applied: 10, duplicates: 85, ineligible: 5, nextCursor: "s199" })),
    () => success(page({ processed: 7, applied: 1, duplicates: 6 }))
  );
  const progress: ReconcileProgress[] = [];
  const outcome = await runReconciliation("L1", { fetchImpl: impl, onProgress: (p) => progress.push(p), ...noWait });
  assert.deepEqual(outcome, { status: "COMPLETE", passes: 1, pages: 3, totals: { ...ZERO, processed: 207, applied: 71, duplicates: 131, ineligible: 5 } });
  assert.deepEqual(calls.map(bodyOf), [{ cursor: null, limit: 100 }, { cursor: "s099", limit: 100 }, { cursor: "s199", limit: 100 }]);
  assert.ok(calls.every((c) => c.url === "/api/lectures/L1/attendance/reconcile" && c.init?.method === "POST"));
  assert.deepEqual(progress.map((p) => [p.pass, p.pageInPass, p.pages, p.totals.applied]), [[1, 1, 1, 60], [1, 2, 2, 70], [1, 3, 3, 71]]);
});

test("reconcile: page size is clamped to 1–500", async () => {
  assert.deepEqual([clampReconcilePageSize(undefined), clampReconcilePageSize(0), clampReconcilePageSize(1), clampReconcilePageSize(250.7), clampReconcilePageSize(501), clampReconcilePageSize(10_000), clampReconcilePageSize(NaN)],
    [100, 1, 1, 250, 500, 500, 100]);
  const { impl, calls } = fakeFetch(() => success(page({ processed: 1 })));
  await runReconciliation("L1", { fetchImpl: impl, pageSize: 9999, ...noWait });
  assert.equal(bodyOf(calls[0]).limit, 500);
});

test("reconcile: busy students → a fresh pass from no cursor (after a pause); complete when a pass has none", async () => {
  const waits: number[] = [];
  const { impl, calls } = fakeFetch(
    () => success(page({ processed: 100, applied: 99, busy: 1, nextCursor: "s099" })),
    () => success(page({ processed: 20, applied: 20 })),
    () => success(page({ processed: 100, applied: 1, duplicates: 99, nextCursor: "s099" })),
    () => success(page({ processed: 20, duplicates: 20 }))
  );
  const outcome = await runReconciliation("L1", { fetchImpl: impl, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(outcome, { status: "COMPLETE", passes: 2, pages: 4, totals: { ...ZERO, processed: 240, applied: 120, duplicates: 119, busy: 1 } });
  assert.deepEqual(calls.map((c) => bodyOf(c).cursor), [null, "s099", null, "s099"], "the second pass starts without the old cursor");
  assert.deepEqual(waits, [1500]);
});

test("reconcile: busy students in every pass → INCOMPLETE BUSY_REMAINING (never COMPLETE)", async () => {
  const { impl, calls } = fakeFetch(() => success(page({ processed: 3, applied: 0, busy: 1 })));
  const outcome = await runReconciliation("L1", { fetchImpl: impl, maxPasses: 2, ...noWait });
  assert.deepEqual(outcome, { status: "INCOMPLETE", reason: "BUSY_REMAINING", passes: 2, pages: 2, totals: { ...ZERO, processed: 6, busy: 2 } });
  assert.equal(calls.length, 2);
});

test("reconcile: an API error stops with FAILED, keeping its code and the counts so far", async () => {
  const { impl } = fakeFetch(
    () => success(page({ processed: 100, applied: 5, duplicates: 95, nextCursor: "s099" })),
    () => failure(409, "ATTENDANCE_LECTURE_HISTORICAL")
  );
  const outcome = await runReconciliation("L1", { fetchImpl: impl, ...noWait });
  assert.equal(outcome.status, "FAILED");
  if (outcome.status === "FAILED") {
    assert.deepEqual([outcome.error.status, outcome.error.code, outcome.pages, outcome.totals.applied], [409, "ATTENDANCE_LECTURE_HISTORICAL", 1, 5]);
  }
  const network = await runReconciliation("L1", { fetchImpl: async () => { throw new Error("offline"); }, ...noWait });
  assert.deepEqual(network.status === "FAILED" ? network.error.code : null, "NETWORK_ERROR");
  // A success with a malformed page is not trusted.
  const malformed = await runReconciliation("L1", { fetchImpl: fakeFetch(() => success({ processed: "100", nextCursor: null })).impl, ...noWait });
  assert.deepEqual(malformed.status === "FAILED" ? malformed.error.code : null, "INVALID_RESPONSE");
});

test("reconcile: a repeated or non-advancing cursor stops with NO_PROGRESS", async () => {
  const same = fakeFetch(
    () => success(page({ processed: 100, nextCursor: "s099" })),
    () => success(page({ processed: 100, nextCursor: "s099" }))
  );
  assert.deepEqual(await runReconciliation("L1", { fetchImpl: same.impl, ...noWait }), {
    status: "INCOMPLETE", reason: "NO_PROGRESS", passes: 1, pages: 2, totals: { ...ZERO, processed: 200 },
  });
  const cycle = fakeFetch(
    () => success(page({ processed: 1, nextCursor: "a" })),
    () => success(page({ processed: 1, nextCursor: "b" })),
    () => success(page({ processed: 1, nextCursor: "a" }))
  );
  assert.equal((await runReconciliation("L1", { fetchImpl: cycle.impl, ...noWait })).status, "INCOMPLETE");
  assert.equal(cycle.calls.length, 3);
  const empty = fakeFetch(() => success(page({ processed: 0, nextCursor: "s1" })));
  const outcome = await runReconciliation("L1", { fetchImpl: empty.impl, ...noWait });
  assert.deepEqual(outcome.status === "INCOMPLETE" ? outcome.reason : null, "NO_PROGRESS");
  assert.equal(empty.calls.length, 1);
});

test("reconcile: the per-pass page limit stops a runaway pass (INCOMPLETE PAGE_LIMIT)", async () => {
  let n = 0;
  // An ever-advancing server. Past 50 calls it answers an error, so a loop
  // without its page limit fails fast here instead of spinning forever (a
  // microtask-only loop would also starve the test runner's own timeout).
  const { impl, calls } = fakeFetch(() => (++n > 50 ? failure(500, "INTERNAL_SERVER_ERROR") : success(page({ processed: 1, nextCursor: `s${String(n).padStart(6, "0")}` }))));
  const outcome = await runReconciliation("L1", { fetchImpl: impl, maxPagesPerPass: 5, ...noWait });
  assert.deepEqual(outcome.status === "INCOMPLETE" ? [outcome.reason, outcome.pages] : null, ["PAGE_LIMIT", 5]);
  assert.equal(calls.length, 5);
});

test("reconcile: a lecture that changed and an abort stop without claiming completion", async () => {
  const changed = fakeFetch(() => success(page({ processed: 0, nextCursor: null, stoppedBecause: "LECTURE_CHANGED" })));
  assert.deepEqual(await runReconciliation("L1", { fetchImpl: changed.impl, ...noWait }), {
    status: "INCOMPLETE", reason: "LECTURE_CHANGED", passes: 1, pages: 1, totals: ZERO,
  });

  const controller = new AbortController();
  const { impl, calls } = fakeFetch(() => {
    controller.abort();
    return success(page({ processed: 100, nextCursor: "s099" }));
  });
  const outcome = await runReconciliation("L1", { fetchImpl: impl, signal: controller.signal, ...noWait });
  assert.deepEqual(outcome.status === "INCOMPLETE" ? outcome.reason : null, "ABORTED");
  assert.equal(calls.length, 1);
});

// ---- Overview fetch helper (Stage 5.5d-5b) --------------------------------------------------

const PAGINATION = { page: 2, pageSize: 20, totalItems: 41, totalPages: 3, hasNextPage: true, hasPreviousPage: true };

test("overview query: every parameter encoded; blanks, invalid dates and out-of-range sizes handled", () => {
  const params = new URLSearchParams(
    buildAttendanceOverviewQuery({
      page: 2,
      pageSize: 20,
      classId: "0b1d2c3e-1111-4111-8111-111111111111",
      title: "  Algebra & co / #1 ",
      from: new Date("2026-11-10T18:30:00.000Z"),
      to: new Date("2026-11-11T18:29:59.999Z"),
      sortOrder: "asc",
    })
  );
  assert.equal(params.get("page"), "2");
  assert.equal(params.get("pageSize"), "20");
  assert.equal(params.get("sortOrder"), "asc");
  assert.equal(params.get("classId"), "0b1d2c3e-1111-4111-8111-111111111111");
  assert.equal(params.get("title"), "Algebra & co / #1", "trimmed, and the decoded value round-trips");
  assert.equal(params.get("from"), "2026-11-10T18:30:00.000Z");
  assert.equal(params.get("to"), "2026-11-11T18:29:59.999Z");

  const raw = buildAttendanceOverviewQuery({ page: 1, pageSize: 10, title: "a&b=c", sortOrder: "desc" });
  assert.ok(!raw.includes("a&b=c"), "special characters are escaped");

  const blank = new URLSearchParams(
    buildAttendanceOverviewQuery({ page: 0, pageSize: 1000, classId: "", title: "   ", from: new Date("nope"), to: null, sortOrder: "desc" })
  );
  assert.equal(blank.get("page"), "1", "page is at least 1");
  assert.equal(blank.get("pageSize"), "100", "pageSize capped at the API maximum");
  for (const key of ["classId", "title", "from", "to"]) assert.equal(blank.has(key), false, `${key} omitted`);
  assert.equal(blank.get("sortOrder"), "desc");
});

test("overview fetch: GET to the overview endpoint; items and pagination returned", async () => {
  const item = { lectureId: "L1", title: "T" };
  const { impl, calls } = fakeFetch(() => jsonResponse(200, { success: true, data: [item], pagination: PAGINATION }));
  const result = await fetchAttendanceOverview({ page: 2, pageSize: 20, sortOrder: "asc" }, { fetchImpl: impl });
  assert.deepEqual(result, { ok: true, status: 200, data: [item], pagination: PAGINATION });
  assert.ok(calls[0].url.startsWith("/api/lectures/attendance-overview?"));
  assert.deepEqual([calls[0].init?.method, calls[0].init?.body, calls[0].init?.cache], ["GET", undefined, "no-store"]);
});

test("overview fetch: malformed pagination is dropped (never invented); other helpers unchanged", async () => {
  const { impl } = fakeFetch(() => jsonResponse(200, { success: true, data: [], pagination: { page: "x" } }));
  const result = await fetchAttendanceOverview({ page: 1, pageSize: 20, sortOrder: "asc" }, { fetchImpl: impl });
  assert.deepEqual(result, { ok: true, status: 200, data: [] });

  const plain = fakeFetch(() => success({ lecture: { id: "L1" } }));
  assert.deepEqual(await fetchAttendanceRegister("L1", { fetchImpl: plain.impl }), { ok: true, status: 200, data: { lecture: { id: "L1" } } });
});

test("overview fetch: error codes preserved (401, 404 CLASS_NOT_FOUND, 400, network)", async () => {
  const q = { page: 1, pageSize: 20, sortOrder: "desc" as const };
  const unauthorized = await fetchAttendanceOverview(q, { fetchImpl: fakeFetch(() => failure(401, "UNAUTHORIZED")).impl });
  assert.equal(unauthorized.ok, false);
  assert.equal(!unauthorized.ok && unauthorized.code, "UNAUTHORIZED");
  assert.equal(!unauthorized.ok && unauthorized.status, 401);

  const foreign = await fetchAttendanceOverview(q, { fetchImpl: fakeFetch(() => failure(404, "CLASS_NOT_FOUND")).impl });
  assert.equal(!foreign.ok && foreign.code, "CLASS_NOT_FOUND");

  const invalid = await fetchAttendanceOverview(q, { fetchImpl: fakeFetch(() => failure(400, "VALIDATION_ERROR")).impl });
  assert.equal(!invalid.ok && invalid.code, "VALIDATION_ERROR");

  const offline = await fetchAttendanceOverview(q, {
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(!offline.ok && offline.code, "NETWORK_ERROR");
});
