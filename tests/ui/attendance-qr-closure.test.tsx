/**
 * Stage 5.7b-3e: closing QR attendance from the register — the QR section
 * (components/attendance/qr-scan-entry.tsx), the confirmation dialog
 * (qr-closure-dialog.tsx, rendered with react-dom/server), the request and
 * its controller (qr-closure-controller.ts, over a fake fetch / fake
 * submit) and the register panel's wiring (checked from source). The modal
 * behaviour itself is the shared hook's (tested in
 * attendance-decision-dialog.test.tsx and attendance-dialog-focus.test.tsx)
 * and is checked here by its wiring. No browser, no server, no database.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type { AttendanceApiResult, AttendanceRegisterResponse } from "../../components/attendance/attendance-ui";
import {
  createQrClosureController,
  qrClosureBusy,
  qrClosureEndpoint,
  qrClosureFailureKind,
  readQrClosureResponse,
  submitQrClosure,
  type QrClosureResponse,
  type QrClosureUiState,
} from "../../components/attendance/qr-closure-controller";
import { QrClosureDialog, qrClosureTargetOf, type QrClosureTarget } from "../../components/attendance/qr-closure-dialog";
import { QR_CLOSE_ACTION_ID, QR_SECTION_ID, QrScanEntry, qrClosureAvailability, qrStatusSummary } from "../../components/attendance/qr-scan-entry";
import { scannerAvailability } from "../../components/attendance/qr-scanner-logic";
import { finalizeAvailability } from "../../components/attendance/finalization-dialog";
import { reconcileAvailability } from "../../components/attendance/reconcile-section";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const noop = () => {};

async function settle(times = 15) {
  for (let i = 0; i < times; i += 1) await tick();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type QrPatch = Partial<AttendanceRegisterResponse["qr"]>;

function registerFixture(patch: { classStatus?: string; classification?: "LIVE" | "HISTORICAL" | null; finalized?: boolean; qr?: QrPatch | null; qrStudents?: number } = {}): AttendanceRegisterResponse {
  const finalized = patch.finalized ?? false;
  const students = Array.from({ length: 3 }, (_, i) => ({
    studentId: `s${i}`,
    name: `Student ${i}`,
    registrationNumber: `REG-${i}`,
    eligibility: { outcome: "ELIGIBLE", reason: "ELIGIBLE", approvalReason: "KNOWN_APPROVED" },
    absenceDecision: "HAS_RECORD",
    record: {
      status: "PRESENT",
      statusSource: "AUTO",
      autoStatus: "PRESENT",
      teacherStatus: null,
      firstOnlineAt: i < (patch.qrStudents ?? 0) ? null : "2026-09-01T12:31:00.000Z",
      firstQrAt: i < (patch.qrStudents ?? 0) ? "2026-09-01T12:32:00.000Z" : null,
      teacherDecidedAt: null,
      version: 1,
    },
    review: { pending: false, since: null },
  }));
  const register = {
    lecture: { id: "lec-1", classId: "class-1", title: "Kinematics II", classStatus: patch.classStatus ?? "SCHEDULED", date: "2026-09-01T12:30:00.000Z", endDate: "2026-09-01T14:30:00.000Z" },
    register: {
      lectureId: "lec-1",
      exists: true,
      scheduledStartAt: "2026-09-01T12:30:00.000Z",
      scheduledEndAt: "2026-09-01T14:30:00.000Z",
      graceMinutes: 10,
      version: 1,
      finalized,
      finalizedAt: finalized ? "2026-09-01T16:00:00.000Z" : null,
    },
    configuration: { approval: "OK", evidence: "OK" },
    classification: patch.classification === undefined ? "LIVE" : patch.classification,
    students,
    summary: { students: 3, withRecord: 3, recordStatus: { PRESENT: 3, LATE: 0, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 0 },
    absencePreview: null,
    onlineEvidence: { complete: true, pending: [], unknownVisits: [] },
    activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "SCHEDULED_END_PASSED" }, configured: true },
    qr: { closed: false, closedAt: null, opensAt: "2026-09-01T12:00:00.000Z", window: "OPEN", ...(patch.qr ?? {}) },
  } as AttendanceRegisterResponse;
  if (patch.qr === null) delete (register as Partial<AttendanceRegisterResponse>).qr;
  return register;
}

const CLOSED_AT = "2026-09-01T13:15:00.000Z"; // 18:45 in Colombo
const closedQr: QrPatch = { closed: true, closedAt: CLOSED_AT, window: "CLOSED" };

// ======================================================================================
// 1. QR state display and the Close action's availability
// ======================================================================================

test("availability: Close is offered unless already closed or cancelled — also NOT_OPEN, finalized, historical, unconfigured", () => {
  const allowed: Parameters<typeof registerFixture>[0][] = [
    {},
    { qr: { window: "NOT_OPEN" } },
    { finalized: true },
    { finalized: true, qr: { window: "NOT_OPEN" } },
    { classification: "HISTORICAL", qr: { window: "CLOSED" } },
    { classification: null, qr: { window: "CLOSED" } },
    { qr: { window: "CLOSED" } }, // the window is CLOSED (e.g. a missing setting) but nothing was persisted
  ];
  for (const patch of allowed) assert.deepEqual(qrClosureAvailability(registerFixture(patch)), { allowed: true, reason: null }, JSON.stringify(patch));
  assert.deepEqual(qrClosureAvailability(registerFixture({ qr: closedQr })), { allowed: false, reason: "ALREADY_CLOSED" });
  assert.deepEqual(qrClosureAvailability(registerFixture({ classStatus: "CANCELLED" })), { allowed: false, reason: "CANCELLED" });
  assert.deepEqual(qrClosureAvailability(registerFixture({ qr: null })), { allowed: false, reason: "NO_QR_STATE" });
});

test("status: open / not open (opening time) / closed (closure time) / cancelled / unavailable; Colombo times; closed only when persisted", () => {
  assert.equal(qrStatusSummary(registerFixture()).state, "OPEN");
  const notOpen = qrStatusSummary(registerFixture({ qr: { window: "NOT_OPEN" } }));
  assert.equal(notOpen.state, "NOT_OPEN");
  assert.match(notOpen.detail, /opens at 1 Sept 2026, 17:30/);
  const closed = qrStatusSummary(registerFixture({ qr: closedQr }));
  assert.equal(closed.state, "CLOSED");
  assert.match(closed.detail, /closed on 1 Sept 2026, 18:45/);
  assert.match(closed.detail, /Attendance already recorded is kept/);
  assert.equal(qrStatusSummary(registerFixture({ classStatus: "CANCELLED" })).state, "CANCELLED");
  assert.equal(qrStatusSummary(registerFixture({ classStatus: "CANCELLED", qr: closedQr })).state, "CLOSED", "a persisted closure is shown as closed");
  // A CLOSED window without a persisted closure is never shown as closed.
  for (const patch of [{ qr: { window: "CLOSED" as const } }, { classification: "HISTORICAL" as const, qr: { window: "CLOSED" as const } }, { qr: null }]) {
    const s = qrStatusSummary(registerFixture(patch));
    assert.notEqual(s.state, "CLOSED", JSON.stringify(patch));
    assert.doesNotMatch(s.detail, /was closed/);
  }
});

test("section: Close and Scan actions by state; the register's finalized state is shown separately", () => {
  const html = (patch: Parameters<typeof registerFixture>[0], withClose = true) =>
    renderToStaticMarkup(<QrScanEntry register={registerFixture(patch)} onCloseQr={withClose ? noop : undefined} />);
  const hasClose = (h: string) => h.includes(`id="${QR_CLOSE_ACTION_ID}"`);
  const hasScan = (h: string) => h.includes('href="/dashboard/attendance/lec-1/scan"');

  const open = html({});
  assert.ok(hasClose(open) && hasScan(open));
  assert.ok(text(open).includes("QR scanning: Open"));
  assert.ok(text(open).includes("Attendance register: not finalized. Closing QR attendance and finalizing the register are separate steps."));

  const notOpen = html({ qr: { window: "NOT_OPEN" } });
  assert.ok(hasClose(notOpen), "closing before scanning opens is allowed");
  assert.ok(!hasScan(notOpen));
  assert.ok(text(notOpen).includes("QR scanning: Not open yet") && text(notOpen).includes("17:30"));

  const finalized = html({ finalized: true });
  assert.ok(hasClose(finalized), "closing after finalization is allowed");
  assert.ok(text(finalized).includes("Attendance register: finalized."));

  const closed = html({ qr: closedQr });
  assert.ok(!hasClose(closed) && !hasScan(closed));
  assert.ok(text(closed).includes("QR scanning: Closed") && text(closed).includes("18:45"));

  const cancelled = html({ classStatus: "CANCELLED" });
  assert.ok(!hasClose(cancelled) && !hasScan(cancelled));
  assert.ok(text(cancelled).includes("cancelled, so QR attendance is not taken and cannot be closed"));

  assert.ok(!hasClose(html({}, false)), "no action without the panel's callback");
  assert.match(open, new RegExp(`<section id="${QR_SECTION_ID}" tabindex="-1"`), "the focus fallback target");
  assert.match(open, /<button type="button" id="attendance-qr-close"[^>]*class="[^"]*min-h-\[44px\]/);
});

// ======================================================================================
// 2. The confirmation dialog
// ======================================================================================

const target = (patch: Partial<QrClosureTarget> = {}): QrClosureTarget => ({
  lectureTitle: "Kinematics II",
  window: "OPEN",
  opensAt: "2026-09-01T12:00:00.000Z",
  registerFinalized: false,
  qrRecordedCount: 2,
  ...patch,
});
const dialog = (t: QrClosureTarget | null, state: QrClosureUiState = { phase: "idle" }) =>
  renderToStaticMarkup(<QrClosureDialog target={t} state={state} onConfirm={noop} onClose={noop} />);

test("dialog: permanent, no more scans, nothing deleted, irreversible, separate from finalization; accessible modal; bottom sheet", () => {
  assert.equal(dialog(null), "", "closed: nothing rendered");
  const html = dialog(target());
  const t = text(html);
  assert.ok(t.includes("closed permanently") && t.includes("cannot be reversed"));
  assert.ok(t.includes("No more physical QR scans will be accepted"));
  assert.ok(t.includes("Attendance already recorded, and its history, is kept. Nothing is deleted."));
  assert.ok(t.includes("This does not finalize the attendance register."));
  assert.ok(t.includes("QR attendance is recorded for 2 students"));
  assert.ok(!html.includes("data-no-scans-warning"));
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="qr-closure-dialog-title" aria-describedby="qr-closure-dialog-description"/);
  assert.match(html, /<button type="button"[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/, "focus starts on Cancel (the safe choice)");
  assert.match(html, /class="fixed inset-0 z-50 flex items-end justify-center[^"]*sm:items-center/, "bottom sheet on narrow screens");
  assert.match(html, /rounded-t-2xl[^"]*sm:rounded-2xl/);
  assert.ok(t.includes("Close QR attendance permanently"));

  const dialogSource = source("components", "attendance", "qr-closure-dialog.tsx");
  assert.match(dialogSource, /useModalDialog\(\{ open, dialogRef, overlayRef, canClose: \(\) => !busy, onClose, fallbackId: QR_SECTION_ID \}\)/, "Escape and close refused while busy; focus falls back to the QR section");
});

test("dialog: the no-scans warning appears only when no QR attendance is recorded; NOT_OPEN and finalized wording", () => {
  const none = dialog(target({ qrRecordedCount: 0 }));
  assert.ok(none.includes("data-no-scans-warning"));
  assert.ok(text(none).includes("No QR attendance has been recorded for this lecture yet. If you close it now, physical QR attendance cannot be used for this lecture at all."));
  const notOpen = text(dialog(target({ window: "NOT_OPEN", qrRecordedCount: 0 })));
  assert.ok(notOpen.includes("Scanning has not opened yet (it would open at 1 Sept 2026, 17:30)."));
  const finalized = text(dialog(target({ registerFinalized: true })));
  assert.ok(finalized.includes("already finalized; closing QR attendance does not change it"));
  assert.ok(!finalized.includes("This does not finalize"));

  assert.equal(qrClosureTargetOf(registerFixture({ qrStudents: 0 })).qrRecordedCount, 0);
  assert.equal(qrClosureTargetOf(registerFixture({ qrStudents: 2 })).qrRecordedCount, 2);
  assert.deepEqual(qrClosureTargetOf(registerFixture({ finalized: true, qr: { window: "NOT_OPEN" } })), {
    lectureTitle: "Kinematics II",
    window: "NOT_OPEN",
    opensAt: "2026-09-01T12:00:00.000Z",
    registerFinalized: true,
    qrRecordedCount: 0,
  });
});

test("dialog: busy disables every control; failures explain what happened and offer Try again only when allowed", () => {
  const busy = dialog(target(), { phase: "submitting" });
  assert.equal((busy.match(/<button[^>]*disabled=""/g) ?? []).length, 3, "header close, Cancel and Confirm disabled");
  assert.ok(text(busy).includes("Closing…"));
  assert.match(busy, /aria-busy="true"/);

  const err = (status: number, code: string) => ({ ok: false as const, status, code, message: "Safe helper message." });
  const ambiguous = text(dialog(target(), { phase: "failed", error: err(0, "NETWORK_ERROR"), kind: "AMBIGUOUS", refresh: "done", canRetry: true }));
  assert.ok(ambiguous.includes("The closure could not be confirmed") && ambiguous.includes("still open, so it was not closed") && ambiguous.includes("Try again"));
  const checking = text(dialog(target(), { phase: "failed", error: err(0, "NETWORK_ERROR"), kind: "AMBIGUOUS", refresh: "pending", canRetry: false }));
  assert.ok(checking.includes("Checking the register"));
  const unknown = text(dialog(target(), { phase: "failed", error: err(502, "INTERNAL_SERVER_ERROR"), kind: "AMBIGUOUS", refresh: "failed", canRetry: true }));
  assert.ok(unknown.includes("Reload the page to see whether QR attendance was closed"));
  const busyErr = text(dialog(target(), { phase: "failed", error: err(409, "ATTENDANCE_BUSY"), kind: "BUSY", refresh: "skipped", canRetry: true }));
  assert.ok(busyErr.includes("Attendance is busy") && busyErr.includes("Try again"));
  const cancelled = dialog(target(), { phase: "failed", error: err(409, "LECTURE_CANCELLED"), kind: "GONE", refresh: "done", canRetry: false });
  assert.ok(text(cancelled).includes("This lecture is cancelled"));
  assert.ok(!text(cancelled).includes("Try again") && !text(cancelled).includes("permanently</button>"));
  assert.match(cancelled, /data-autofocus="true"[^>]*>Close<\/button>/, "only Close is offered");
  const gone = text(dialog(target(), { phase: "failed", error: err(404, "LECTURE_NOT_FOUND"), kind: "GONE", refresh: "done", canRetry: false }));
  assert.ok(gone.includes("Lecture not found"));
  const signIn = dialog(target(), { phase: "failed", error: err(401, "UNAUTHORIZED"), kind: "SIGN_IN", refresh: "skipped", canRetry: false });
  assert.ok(signIn.includes('href="/login"'));
  const blocked = text(dialog(target(), { phase: "failed", error: err(403, "CROSS_ORIGIN_REQUEST_REJECTED"), kind: "RELOAD", refresh: "skipped", canRetry: false }));
  assert.ok(blocked.includes("QR attendance was not closed") && blocked.includes("Safe helper message."));
  assert.match(dialog(target(), { phase: "failed", error: err(409, "ATTENDANCE_BUSY"), kind: "BUSY", refresh: "skipped", canRetry: true }), /role="alert"/);
});

// ======================================================================================
// 3. The request
// ======================================================================================

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const CLOSURE: QrClosureResponse = { lectureId: "lec-1", closedAt: CLOSED_AT, alreadyClosed: false, closedByYou: true };

test("request: POST exactly {} (no teacher id or anything else), same-origin, no-store; the mapped response", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return jsonResponse(200, { success: true, data: { ...CLOSURE, closedByTeacherId: "teacher-9" } });
  };
  const result = await submitQrClosure("lec 1", { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/lectures/lec%201/attendance/qr/close");
  assert.equal(qrClosureEndpoint("lec-1"), "/api/lectures/lec-1/attendance/qr/close");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "{}", "the body is exactly {}");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.cache, "no-store");
  assert.deepEqual(result, { ok: true, status: 200, data: CLOSURE }, "only the four contract fields are kept");

  for (const data of [null, { ...CLOSURE, closedAt: "never" }, { ...CLOSURE, alreadyClosed: "no" }, { lectureId: "lec-1" }]) {
    const bad = await submitQrClosure("lec-1", { fetchImpl: async () => jsonResponse(200, { success: true, data }) });
    assert.equal(!bad.ok && bad.code, "INVALID_RESPONSE", JSON.stringify(data));
  }
  assert.equal(readQrClosureResponse({ ...CLOSURE, alreadyClosed: true })?.alreadyClosed, true);
  const offline = await submitQrClosure("lec-1", { fetchImpl: async () => Promise.reject(new TypeError("offline")) });
  assert.deepEqual([offline.ok, !offline.ok && offline.status, !offline.ok && offline.code], [false, 0, "NETWORK_ERROR"]);
  const cancelled = await submitQrClosure("lec-1", { fetchImpl: async () => jsonResponse(409, { success: false, error: { message: "This lecture is cancelled.", code: "LECTURE_CANCELLED" } }) });
  assert.equal(!cancelled.ok && cancelled.code, "LECTURE_CANCELLED");
});

test("failure kinds: busy, gone, sign-in, reload, ambiguous (no answer, 5xx, unreadable)", () => {
  const e = (status: number, code: string) => ({ ok: false as const, status, code, message: "" });
  assert.equal(qrClosureFailureKind(e(409, "ATTENDANCE_BUSY")), "BUSY");
  assert.equal(qrClosureFailureKind(e(409, "LECTURE_CANCELLED")), "GONE");
  assert.equal(qrClosureFailureKind(e(404, "LECTURE_NOT_FOUND")), "GONE");
  assert.equal(qrClosureFailureKind(e(401, "UNAUTHORIZED")), "SIGN_IN");
  assert.equal(qrClosureFailureKind(e(403, "CROSS_ORIGIN_REQUEST_REJECTED")), "RELOAD");
  assert.equal(qrClosureFailureKind(e(400, "VALIDATION_ERROR")), "RELOAD");
  assert.equal(qrClosureFailureKind(e(413, "ATTENDANCE_REQUEST_TOO_LARGE")), "RELOAD");
  assert.equal(qrClosureFailureKind(e(0, "NETWORK_ERROR")), "AMBIGUOUS");
  assert.equal(qrClosureFailureKind(e(500, "INTERNAL_SERVER_ERROR")), "AMBIGUOUS");
  assert.equal(qrClosureFailureKind(e(502, "INVALID_RESPONSE")), "AMBIGUOUS");
  assert.equal(qrClosureFailureKind(e(200, "INVALID_RESPONSE")), "AMBIGUOUS");
});

// ======================================================================================
// 4. The controller
// ======================================================================================

function harness(options: { results?: AttendanceApiResult<QrClosureResponse>[]; refreshes?: (AttendanceRegisterResponse | null | Error)[]; submit?: () => Promise<AttendanceApiResult<QrClosureResponse>> } = {}) {
  const states: QrClosureUiState[] = [];
  const signals: AbortSignal[] = [];
  let submits = 0;
  let refreshes = 0;
  const results = (options.results ?? []).slice();
  const refreshQueue = (options.refreshes ?? []).slice();
  const controller = createQrClosureController({
    lectureId: "lec-1",
    onChange: (s) => states.push(s),
    refresh: async () => {
      refreshes += 1;
      const next = refreshQueue.shift();
      if (next instanceof Error) throw next;
      return next === undefined ? registerFixture({ qr: closedQr }) : next;
    },
    submit: async (lectureId, { signal }) => {
      assert.equal(lectureId, "lec-1");
      submits += 1;
      signals.push(signal);
      if (options.submit) return options.submit();
      const next = results.shift();
      if (!next) throw new Error("no scripted result");
      return next;
    },
  });
  return { controller, states, signals, submits: () => submits, refreshes: () => refreshes, last: () => states[states.length - 1] };
}

const okResult = (patch: Partial<QrClosureResponse> = {}): AttendanceApiResult<QrClosureResponse> => ({ ok: true, status: 200, data: { ...CLOSURE, ...patch } });
const errResult = (status: number, code: string): AttendanceApiResult<QrClosureResponse> => ({ ok: false, status, code, message: "Safe helper message." });

test("controller: success refreshes the register once; the refreshed GET hides Close and Scan and the scanner reports closed", async () => {
  const closedRegister = registerFixture({ qr: closedQr });
  const h = harness({ results: [okResult()], refreshes: [closedRegister] });
  assert.equal(await h.controller.confirm(), true);
  assert.deepEqual(h.states.map((s) => s.phase + (s.phase === "succeeded" ? `:${s.refresh}` : "")), ["submitting", "succeeded:pending", "succeeded:done"]);
  assert.equal(h.refreshes(), 1);
  assert.equal(h.submits(), 1);
  const html = renderToStaticMarkup(<QrScanEntry register={closedRegister} onCloseQr={noop} />);
  assert.ok(!html.includes(QR_CLOSE_ACTION_ID) && !html.includes("/scan"));
  assert.ok(text(html).includes("closed on 1 Sept 2026, 18:45"));
  const scanner = scannerAvailability(closedRegister);
  assert.equal(!scanner.available && scanner.reason, "CLOSED", "the scanner route reports QR attendance closed");
  assert.equal(closedRegister.register.finalized, false, "closing QR attendance does not finalize the register");
});

test("controller: an already-closed (idempotent) answer is a success; a failed refresh after success is reported, not retried", async () => {
  const h = harness({ results: [okResult({ alreadyClosed: true })], refreshes: [null] });
  await h.controller.confirm();
  const s = h.last();
  assert.equal(s.phase, "succeeded");
  if (s.phase === "succeeded") {
    assert.equal(s.result.alreadyClosed, true);
    assert.equal(s.refresh, "failed");
  }
  assert.equal(h.submits(), 1);
});

test("controller: double confirm is refused while the request (or its refresh) runs; reset refused while busy", async () => {
  const gate = deferred<AttendanceApiResult<QrClosureResponse>>();
  const h = harness({ submit: () => gate.promise });
  const first = h.controller.confirm();
  assert.equal(h.controller.isBusy(), true);
  assert.equal(await h.controller.confirm(), false, "a second press sends nothing");
  assert.equal(await h.controller.confirm(), false);
  assert.equal(h.controller.reset(), false);
  assert.equal(qrClosureBusy(h.controller.getState()), true);
  gate.resolve(okResult());
  await first;
  assert.equal(h.submits(), 1);
  assert.equal(h.controller.isBusy(), false);
  assert.equal(qrClosureBusy({ phase: "succeeded", result: CLOSURE, refresh: "pending" }), true);
  assert.equal(qrClosureBusy({ phase: "failed", error: { ok: false, status: 0, code: "NETWORK_ERROR", message: "" }, kind: "AMBIGUOUS", refresh: "pending", canRetry: false }), true);
  assert.equal(qrClosureBusy({ phase: "idle" }), false);
});

test("controller: an ambiguous failure is never re-sent; the register is refreshed to find out — closed → confirmed", async () => {
  const h = harness({ results: [errResult(0, "NETWORK_ERROR")], refreshes: [registerFixture({ qr: closedQr })] });
  await h.controller.confirm();
  assert.equal(h.submits(), 1, "no automatic retry");
  assert.equal(h.refreshes(), 1);
  assert.deepEqual(h.last(), { phase: "confirmed", closedAt: CLOSED_AT });
});

test("controller: ambiguous and still open → an explicit Try again is allowed (and only then a second request)", async () => {
  for (const failure of [errResult(0, "NETWORK_ERROR"), errResult(500, "INTERNAL_SERVER_ERROR"), errResult(200, "INVALID_RESPONSE")]) {
    const h = harness({ results: [failure, okResult()], refreshes: [registerFixture(), registerFixture({ qr: closedQr })] });
    await h.controller.confirm();
    await settle();
    assert.equal(h.submits(), 1, `${failure.ok ? "" : failure.code}: never re-sent automatically`);
    const s = h.last();
    assert.equal(s.phase, "failed");
    if (s.phase === "failed") {
      assert.equal(s.kind, "AMBIGUOUS");
      assert.equal(s.refresh, "done");
      assert.equal(s.canRetry, true);
    }
    await h.controller.confirm();
    assert.equal(h.submits(), 2, "the teacher's explicit Try again");
    assert.equal(h.last().phase, "succeeded");
  }
  // The register cannot be checked either: still no automatic retry; the dialog says to reload.
  const blind = harness({ results: [errResult(0, "NETWORK_ERROR")], refreshes: [new Error("offline")] });
  await blind.controller.confirm();
  const s = blind.last();
  assert.equal(s.phase === "failed" && s.refresh, "failed");
  assert.equal(blind.submits(), 1);
});

test("controller: busy → no refresh, explicit retry; cancelled / not found → refresh, no retry; sign-in and reload → neither", async () => {
  const busy = harness({ results: [errResult(409, "ATTENDANCE_BUSY")] });
  await busy.controller.confirm();
  const b = busy.last();
  assert.equal(b.phase === "failed" && `${b.kind}:${b.refresh}:${b.canRetry}`, "BUSY:skipped:true");
  assert.equal(busy.refreshes(), 0);
  assert.equal(busy.submits(), 1);

  for (const code of ["LECTURE_CANCELLED", "LECTURE_NOT_FOUND"]) {
    const gone = harness({ results: [errResult(code === "LECTURE_CANCELLED" ? 409 : 404, code)], refreshes: [registerFixture({ classStatus: "CANCELLED" })] });
    await gone.controller.confirm();
    const g = gone.last();
    assert.equal(g.phase === "failed" && `${g.kind}:${g.refresh}:${g.canRetry}`, "GONE:done:false", code);
    assert.equal(gone.refreshes(), 1);
    assert.equal(gone.submits(), 1);
  }
  for (const [status, code, kind] of [[401, "UNAUTHORIZED", "SIGN_IN"], [403, "CROSS_ORIGIN_REQUEST_REJECTED", "RELOAD"], [400, "VALIDATION_ERROR", "RELOAD"]] as const) {
    const h = harness({ results: [errResult(status, code)] });
    await h.controller.confirm();
    const s = h.last();
    assert.equal(s.phase === "failed" && `${s.kind}:${s.refresh}:${s.canRetry}`, `${kind}:skipped:false`, code);
    assert.equal(h.refreshes(), 0);
  }
  // A thrown submit is treated as an unreadable answer (ambiguous), never as success.
  const thrown = harness({ submit: () => Promise.reject(new Error("boom")), refreshes: [registerFixture()] });
  await thrown.controller.confirm();
  const t = thrown.last();
  assert.equal(t.phase === "failed" && t.kind, "AMBIGUOUS");
});

test("controller: dispose aborts the request and ignores its answer (modal cleanup on unmount)", async () => {
  const gate = deferred<AttendanceApiResult<QrClosureResponse>>();
  const h = harness({ submit: () => gate.promise });
  const pending = h.controller.confirm();
  const count = h.states.length;
  h.controller.dispose();
  assert.equal(h.signals[0].aborted, true);
  gate.resolve(okResult());
  await pending;
  assert.equal(h.states.length, count, "no state after dispose");
  assert.equal(h.refreshes(), 0);
  assert.equal(await h.controller.confirm(), false);
});

// ======================================================================================
// 5. The register panel's wiring; other attendance features unchanged
// ======================================================================================

test("panel: the dialog opens from the QR section only when allowed and no other dialog is open; confirm goes through the controller", () => {
  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  // The Attendance page's embedded register may also pass onOpenScanner (tests/ui/attendance-workspace.test.tsx).
  assert.match(panel, /<QrScanEntry register=\{register\} onCloseQr=\{onCloseQrAttendance\}(?: onOpenScanner=\{onOpenScanner\})? \/>/);
  assert.match(panel, /onCloseQrAttendance=\{openQrClose\}/);
  const open = panel.slice(panel.indexOf("const openQrClose"), panel.indexOf("const closeQrClose"));
  assert.match(open, /controller\.isBusy\(\) \|\| decisionTarget \|\| reviewTarget \|\| historyTarget \|\| graceTarget\) return;/);
  assert.match(open, /if \(!qrClosureAvailability\(state\.register\)\.allowed\) return;/);
  assert.match(open, /setQrCloseTarget\(qrClosureTargetOf\(state\.register\)\)/);
  const close = panel.slice(panel.indexOf("const closeQrClose"), panel.indexOf("const confirmQrClose"));
  assert.match(close, /if \(controller\?\.isBusy\(\)\) return;/, "the dialog cannot be dismissed mid-request");
  assert.match(panel, /const confirmQrClose = useCallback\(\(\) => void qrCloseController\.current\?\.confirm\(\), \[\]\);/);
  assert.match(panel, /<QrClosureDialog target=\{qrCloseTarget\} state=\{qrCloseState\} onConfirm=\{confirmQrClose\} onClose=\{closeQrClose\} \/>/);
  assert.match(panel, /refresh: async \(\) => \(\(await load\("refresh"\)\) \? latestRegister\.current : null\)/);
  assert.match(panel, /latestRegister\.current = result\.data;\n\s+setState\(\{ kind: "ready", register: result\.data \}\);/);
  const effect = panel.slice(panel.indexOf("const controller = createQrClosureController"), panel.indexOf("const openQrClose"));
  assert.match(effect, /controller\.dispose\(\)/);
  assert.match(effect, /QR attendance closed on \$\{at\}\. No more QR scans will be accepted\./);
  assert.match(effect, /QR attendance was already closed \(on \$\{at\}\)\./);
  assert.doesNotMatch(effect, /finaliz/i, "the success message never claims the register was finalized");
});

test("unchanged: closing QR attendance touches no decision, reconciliation or finalization logic", () => {
  const controller = source("components", "attendance", "qr-closure-controller.ts");
  assert.doesNotMatch(controller, /runReconciliation|finalizeAttendance|submitAttendanceDecision|submitAttendanceReview|submitRegisterGrace|createActionLock|actionLock/);
  // The finalization and reconciliation availability are computed from the register as before: a QR closure does not change them.
  for (const finalized of [false, true]) {
    const open = registerFixture({ finalized });
    const closed = registerFixture({ finalized, qr: closedQr });
    assert.deepEqual(finalizeAvailability(closed, false), finalizeAvailability(open, false));
    assert.deepEqual(reconcileAvailability(closed), reconcileAvailability(open));
  }
  const panelBefore = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  assert.match(panelBefore, /availability=\{finalizeAvailability\(state\.register, reconcileState\.phase === "running"\)\}/);
});
