/**
 * The register page's finalization workflow (Stage 5.5d-4):
 * components/attendance/finalization-controller.ts (preview, blockers,
 * acknowledgement, fingerprint, duplicate clicks, stale / busy / refused /
 * idempotent outcomes, refresh, cancel, unmount, the shared lock with
 * reconciliation) and components/attendance/finalization-dialog.tsx
 * (rendered with react-dom/server). API calls are injected (the real
 * finalizeAttendance over a fake fetch where the request body matters).
 * Clicking through the real page remains a manual check.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  attendanceErrorMessage,
  finalizeAttendance,
  type AttendanceApiError,
  type AttendanceApiResult,
  type AttendanceRegisterResponse,
  type FinalizationPreviewResponse,
  type FinalizeResponse,
} from "../../components/attendance/attendance-ui";
import {
  createFinalizationController,
  previewAllowsConfirmation,
  type FinalizationUiState,
} from "../../components/attendance/finalization-controller";
import {
  FinalizationDialog,
  FinalizationSection,
  finalizationWarnings,
  finalizeAvailability,
  fingerprintReference,
} from "../../components/attendance/finalization-dialog";
import { createActionLock, createReconcileController } from "../../components/attendance/reconciliation-controller";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const FP1 = "a1".repeat(32);
const FP2 = "b2".repeat(32);

function preview(overrides: { fingerprint?: string; blockers?: string[]; pendingReviews?: number; finalized?: boolean } = {}): FinalizationPreviewResponse {
  const blockers = (overrides.blockers ?? []) as FinalizationPreviewResponse["readiness"]["blockers"];
  return {
    lecture: { lectureId: "L1", status: 0, classStatus: "COMPLETED", date: "2026-09-01T12:30:00.000Z", endDate: "2026-09-01T14:30:00.000Z" },
    register: {
      exists: true, version: 4, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: "2026-09-01T14:30:00.000Z", graceMinutes: 10,
      finalized: overrides.finalized ?? false, finalizedAt: overrides.finalized ? "2026-09-01T16:00:00.000Z" : null,
    },
    classification: "LIVE",
    summary: {
      rosterSize: 30, eligibleStudents: 27, unknownEligibilityStudents: 1, studentsWithRecord: 22, automaticAbsent: 5, manualReview: 1,
      notEligibleWithoutRecord: 2, recordStatus: { PRESENT: 15, LATE: 4, ABSENT: 2, EXCUSED: 1 },
    },
    evidence: { pendingOnlineEvidence: 0, unknownApprovalEvidence: 0, pendingReviews: overrides.pendingReviews ?? 2, complete: true },
    readiness: {
      ready: blockers.length === 0,
      schedule: { allowed: true, basis: "SCHEDULED_END_PASSED" },
      blockers,
      activeSessions: { active: false, count: 0 },
      rosterLimit: 500,
      rosterLimitExceeded: false,
      evidenceComplete: true,
    },
    fingerprint: overrides.fingerprint ?? FP1,
    fingerprintVersion: 1,
  };
}

const finalized = (overrides: Partial<FinalizeResponse> = {}): FinalizeResponse => ({
  lectureId: "L1", alreadyFinalized: false, finalizedAt: "2026-09-01T16:00:00.000Z", registerVersion: 5, eligibleStudents: 27,
  unknownEligibilityStudents: 1, absentCreated: 5,
  details: { rosterSize: 30, studentsWithRecord: 22, manualReview: 1, notEligibleWithoutRecord: 2, recordStatusBefore: { PRESENT: 15, LATE: 4, ABSENT: 2, EXCUSED: 1 }, pendingReviews: 2 },
  ...overrides,
});
const ok = <T,>(data: T): AttendanceApiResult<T> => ({ ok: true, status: 200, data });
const fail = (status: number, code: string): AttendanceApiError => ({ ok: false, status, code, message: attendanceErrorMessage(code) });

/** Queued API answers; each call returns the next one (or a never-settling promise when told to hang). */
function api() {
  const previews: (AttendanceApiResult<FinalizationPreviewResponse> | "hang")[] = [];
  const finals: (AttendanceApiResult<FinalizeResponse> | "hang")[] = [];
  const calls = { preview: [] as AbortSignal[], finalize: [] as { fingerprint: string; signal: AbortSignal }[] };
  const answer = <T,>(queue: (T | "hang")[]) => {
    const next = queue.shift();
    return next === "hang" || next === undefined ? new Promise<T>(() => {}) : Promise.resolve(next);
  };
  return {
    previews, finals, calls,
    preview: (_lectureId: string, options: { signal: AbortSignal }) => { calls.preview.push(options.signal); return answer(previews); },
    finalize: (_lectureId: string, fingerprint: string, options: { signal: AbortSignal }) => { calls.finalize.push({ fingerprint, signal: options.signal }); return answer(finals); },
  };
}

function setup(a = api(), lock = createActionLock(), refresh: () => Promise<boolean> = async () => true) {
  const states: FinalizationUiState[] = [];
  let refreshes = 0;
  const controller = createFinalizationController({
    lectureId: "L1", lock, preview: a.preview, finalize: a.finalize,
    refresh: async () => { refreshes += 1; return refresh(); },
    onChange: (s) => states.push(s),
  });
  return { controller, states, api: a, lock, refreshes: () => refreshes, last: () => states.at(-1)! };
}

// ---- Controller --------------------------------------------------------------------------------

test("open: a fresh preview is loaded (loading → preview); the dialog holds the action lock", async () => {
  const h = setup();
  h.api.previews.push(ok(preview()));
  assert.equal(await h.controller.open(), true);
  assert.deepEqual(h.states.map((s) => s.phase), ["loading-preview", "preview"]);
  assert.equal(h.lock.holder(), "finalization");
  assert.equal(await h.controller.open(), false, "already open");
  assert.equal(h.api.calls.preview.length, 1);
  assert.equal(h.controller.close(), true);
  assert.equal(h.lock.holder(), null);
  // Reopening always fetches a new preview (never a cached one).
  h.api.previews.push(ok(preview({ fingerprint: FP2 })));
  await h.controller.open();
  assert.equal(h.api.calls.preview.length, 2);
  const last = h.last();
  assert.ok(last.phase === "preview" && last.preview.fingerprint === FP2);
});

test("blockers and the acknowledgement: confirmation is refused without both (no request sent)", async () => {
  const blocked = setup();
  blocked.api.previews.push(ok(preview({ blockers: ["SESSION_ACTIVE", "EVIDENCE_PENDING"] })));
  await blocked.controller.open();
  assert.equal(previewAllowsConfirmation((blocked.last() as Extract<FinalizationUiState, { phase: "preview" }>).preview), false);
  // Checked before awaiting: a regression that sends the request fails here instead of waiting for an answer.
  const blockedConfirm = blocked.controller.confirm(true);
  assert.equal(blocked.api.calls.finalize.length, 0);
  assert.equal(await blockedConfirm, false);

  const ready = setup();
  ready.api.previews.push(ok(preview()));
  await ready.controller.open();
  const unacknowledged = ready.controller.confirm(false);
  assert.equal(ready.api.calls.finalize.length, 0, "explicit acknowledgement required");
  assert.equal(await unacknowledged, false);

  // A finalized register's preview is never confirmable, whatever it says.
  assert.equal(previewAllowsConfirmation(preview({ finalized: true })), false);
});

test("fingerprint: exactly the latest preview's, sent as the only body field (real helper over a fake fetch)", async () => {
  const bodies: unknown[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    bodies.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ success: true, data: finalized() }), { status: 200 });
  };
  const a = api();
  const lock = createActionLock();
  const controller = createFinalizationController({
    lectureId: "L1", lock, preview: a.preview,
    finalize: (lectureId, fingerprint, options) => finalizeAttendance(lectureId, fingerprint, { ...options, fetchImpl }),
    refresh: async () => true, onChange: () => {},
  });
  a.previews.push(ok(preview({ fingerprint: FP2 })));
  await controller.open();
  await controller.confirm(true);
  assert.deepEqual(bodies, [{ url: "/api/lectures/L1/attendance/finalize", method: "POST", body: { fingerprint: FP2 } }]);
});

test("duplicate submissions: a second confirm while one is in flight is refused; close is refused too", async () => {
  const h = setup();
  h.api.previews.push(ok(preview()));
  h.api.finals.push("hang");
  await h.controller.open();
  const first = h.controller.confirm(true);
  assert.equal(h.last().phase, "submitting");
  assert.equal(await h.controller.confirm(true), false);
  assert.equal(h.controller.close(), false, "cannot close while submitting");
  assert.equal(await h.controller.reloadPreview(), false);
  assert.equal(h.api.calls.finalize.length, 1);
  void first;
});

test("stale preview: confirmation locked until a fresh preview is loaded and shown; then the NEW fingerprint is used", async () => {
  const h = setup();
  h.api.previews.push(ok(preview({ fingerprint: FP1 })), ok(preview({ fingerprint: FP2 })));
  h.api.finals.push(fail(409, "FINALIZATION_PREVIEW_STALE"), ok(finalized()));
  await h.controller.open();
  await h.controller.confirm(true);
  const stale = h.last();
  assert.ok(stale.phase === "needs-new-preview" && stale.stale && stale.error.code === "FINALIZATION_PREVIEW_STALE");
  assert.equal(h.api.calls.finalize.length, 1, "no automatic retry");
  assert.equal(await h.controller.confirm(true), false, "the old preview cannot be confirmed");

  await h.controller.reloadPreview();
  assert.deepEqual(h.states.slice(-2).map((s) => s.phase), ["loading-preview", "preview"]);
  const fresh = h.last();
  assert.ok(fresh.phase === "preview" && fresh.stale && fresh.preview.fingerprint === FP2);
  await h.controller.confirm(true);
  assert.deepEqual(h.api.calls.finalize.map((c) => c.fingerprint), [FP1, FP2]);
  assert.equal(h.last().phase, "finalized");

  // The roster changing is handled the same way.
  const changed = setup();
  changed.api.previews.push(ok(preview()));
  changed.api.finals.push(fail(409, "FINALIZATION_CANDIDATES_CHANGED"));
  await changed.controller.open();
  await changed.controller.confirm(true);
  assert.equal(changed.last().phase, "needs-new-preview");
});

test("busy: the same preview may be confirmed again (safe: finalization is idempotent)", async () => {
  const h = setup();
  h.api.previews.push(ok(preview()));
  h.api.finals.push(fail(409, "ATTENDANCE_BUSY"), ok(finalized()));
  await h.controller.open();
  await h.controller.confirm(true);
  const busy = h.last();
  assert.ok(busy.phase === "preview" && busy.error?.code === "ATTENDANCE_BUSY");
  await h.controller.confirm(true);
  assert.deepEqual(h.api.calls.finalize.map((c) => c.fingerprint), [FP1, FP1]);
  assert.equal(h.last().phase, "finalized");
});

test("success and already-finalized: the result is shown and the register refreshed in place", async () => {
  for (const result of [finalized(), finalized({ alreadyFinalized: true, details: null })]) {
    const h = setup();
    h.api.previews.push(ok(preview()));
    h.api.finals.push(ok(result));
    await h.controller.open();
    await h.controller.confirm(true);
    assert.equal(h.refreshes(), 1);
    assert.deepEqual(h.states.slice(-2).map((s) => (s.phase === "finalized" ? s.refresh : s.phase)), ["pending", "done"]);
    const last = h.last();
    assert.ok(last.phase === "finalized" && last.result === result);
  }
  const failedRefresh = setup(api(), createActionLock(), async () => false);
  failedRefresh.api.previews.push(ok(preview()));
  failedRefresh.api.finals.push(ok(finalized()));
  await failedRefresh.controller.open();
  await failedRefresh.controller.confirm(true);
  assert.ok(failedRefresh.last().phase === "finalized" && (failedRefresh.last() as Extract<FinalizationUiState, { phase: "finalized" }>).refresh === "failed");
});

test("refusals and failures: a fresh preview is required; a failed preview load is shown; nothing is refreshed", async () => {
  for (const code of ["FINALIZATION_SESSION_ACTIVE", "FINALIZATION_EVIDENCE_PENDING", "FINALIZATION_NOT_ALLOWED", "LECTURE_CANCELLED", "UNAUTHORIZED", "FINALIZATION_INTEGRITY_ERROR"]) {
    const h = setup();
    h.api.previews.push(ok(preview()));
    h.api.finals.push(fail(409, code));
    await h.controller.open();
    await h.controller.confirm(true);
    const last = h.last();
    assert.ok(last.phase === "needs-new-preview" && !last.stale && last.error.code === code, code);
    assert.equal(h.refreshes(), 0);
    assert.equal(await h.controller.confirm(true), false);
  }
  const h = setup();
  h.api.previews.push(fail(503, "ATTENDANCE_EVIDENCE_NOT_CONFIGURED"));
  await h.controller.open();
  const last = h.last();
  assert.ok(last.phase === "preview-error" && last.error.code === "ATTENDANCE_EVIDENCE_NOT_CONFIGURED");
  assert.equal(await h.controller.confirm(true), false);
});

test("cancellation and unmount: closing aborts a pending preview (its late answer is ignored); dispose aborts and ignores everything", async () => {
  // Close while the preview is loading: aborted; a late answer never shows.
  let release!: (v: AttendanceApiResult<FinalizationPreviewResponse>) => void;
  const a = api();
  const late = setup({ ...a, preview: (_l: string, options: { signal: AbortSignal }) => { a.calls.preview.push(options.signal); return new Promise((r) => { release = r; }); } });
  const opening = late.controller.open();
  late.controller.close();
  assert.equal(a.calls.preview[0].aborted, true);
  release(ok(preview()));
  await opening;
  assert.equal(late.last().phase, "closed", "the late preview is ignored");

  // Dispose while submitting: aborted, no further state, no refresh; the lock is released.
  const h = setup();
  h.api.previews.push(ok(preview()));
  let finish!: (v: AttendanceApiResult<FinalizeResponse>) => void;
  const controller = createFinalizationController({
    lectureId: "L1", lock: h.lock, preview: h.api.preview,
    finalize: (_l, fingerprint, options) => { h.api.calls.finalize.push({ fingerprint, signal: options.signal }); return new Promise((r) => { finish = r; }); },
    refresh: async () => { throw new Error("must not refresh"); },
    onChange: (s) => h.states.push(s),
  });
  await controller.open();
  const submitting = controller.confirm(true);
  const before = h.states.length;
  controller.dispose();
  assert.equal(h.api.calls.finalize[0].signal.aborted, true);
  assert.equal(h.lock.holder(), null);
  finish(ok(finalized()));
  await submitting;
  assert.equal(h.states.length, before, "no state change after dispose");
  assert.equal(await controller.open(), false);
});

test("never together: an open dialog blocks reconciliation, and a running reconciliation blocks the dialog", async () => {
  const lock = createActionLock();
  let finishRun!: () => void;
  const reconciler = createReconcileController({
    lectureId: "L1", lock,
    run: () => new Promise((r) => { finishRun = () => r({ status: "COMPLETE", passes: 1, pages: 1, totals: { processed: 0, applied: 0, duplicates: 0, ineligible: 0, unknown: 0, inactive: 0, finalizedWithoutRecord: 0, busy: 0, skipped: 0 } }); }),
    refresh: async () => true, onChange: () => {},
  });
  const h = setup(api(), lock);
  h.api.previews.push(ok(preview()));

  // Reconciling: the dialog cannot open.
  const running = reconciler.start();
  assert.equal(await h.controller.open(), false);
  assert.equal(h.api.calls.preview.length, 0);
  finishRun();
  await running;
  assert.equal(lock.holder(), null);

  // Dialog open: reconciliation cannot start; after closing it can.
  await h.controller.open();
  assert.equal(await reconciler.start(), false);
  h.controller.close();
  const again = reconciler.start();
  assert.equal(lock.holder(), "reconcile");
  finishRun();
  await again;
});

// ---- Presentation --------------------------------------------------------------------------------

const renderDialog = (state: FinalizationUiState, acknowledged = false) =>
  renderToStaticMarkup(<FinalizationDialog state={state} acknowledged={acknowledged} onAcknowledgedChange={() => {}} onConfirm={() => {}} onReloadPreview={() => {}} onClose={() => {}} />);
const confirmButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?(?:Finalize attendance|Try finalizing again|Finalizing…)<\/button>/)?.[0] ?? "";

test("dialog: accessible dialog with the frozen schedule, register version, counts, warnings and a shortened reference", () => {
  const html = renderDialog({ phase: "preview", preview: preview(), stale: false, error: null });
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="finalization-dialog-title" aria-describedby="finalization-dialog-description"/);
  const t = text(html);
  for (const expected of [
    "Scheduled start (used for finalization) 1 Sept 2026, 18:00", "Scheduled end 1 Sept 2026, 20:00", "Grace period 10 minutes", "Register version 4",
    "On the roster 30", "Eligible at the start 27", "Already recorded 22", "Will be marked ABSENT 5", "Present 15", "Late 4", "Absent (already) 2", "Excused 1",
    "Manual review (unknown approval) 1", "Not eligible, no record 2", "Online evidence not recorded 0", "Pending reviews 2",
    "Please note (not blocking)", "2 pending review(s) remain", "5 student(s) without attendance will be marked ABSENT.",
    "Finalization is permanent", "I understand that finalizing attendance cannot be undone.",
  ]) {
    assert.ok(t.includes(expected), expected);
  }
  assert.ok(t.includes(`Preview reference: ${FP1.slice(0, 12)}…`));
  assert.ok(!html.includes(FP1), "the full fingerprint is never displayed");
  assert.equal(fingerprintReference("abc"), "abc");
  assert.match(confirmButton(html), /disabled=""/, "disabled until acknowledged");
  assert.doesNotMatch(confirmButton(renderDialog({ phase: "preview", preview: preview(), stale: false, error: null }, true)), /disabled=""/);
});

test("dialog: blockers are listed with their messages; confirmation and the checkbox are disabled; warnings are not blockers", () => {
  const html = renderDialog({ phase: "preview", preview: preview({ blockers: ["SESSION_ACTIVE", "EVIDENCE_PENDING"] }), stale: false, error: null }, true);
  const t = text(html);
  assert.ok(t.includes("Finalization is not available yet"));
  assert.match(html, /data-blocker="SESSION_ACTIVE"/);
  assert.match(html, /data-blocker="EVIDENCE_PENDING"/);
  assert.ok(t.includes("A live class session is still running. End it before finalizing."));
  assert.ok(t.includes("Reconcile online evidence first"));
  assert.match(confirmButton(html), /disabled=""/, "disabled even when acknowledged");
  assert.match(html, /<input type="checkbox"[^>]*disabled=""/);
  assert.ok(!t.includes("Finalization is permanent"), "no irreversible warning when it cannot happen");
  // Pending reviews alone are a warning, never a blocker.
  assert.deepEqual(finalizationWarnings(preview({ pendingReviews: 3 })).length > 0, true);
  assert.doesNotMatch(renderDialog({ phase: "preview", preview: preview({ pendingReviews: 3 }), stale: false, error: null }), /data-blocker=/);
});

test("dialog: stale / refused (fresh preview required), busy (retry), submitting, result, preview error, closed", () => {
  const stale = renderDialog({ phase: "needs-new-preview", preview: preview(), error: fail(409, "FINALIZATION_PREVIEW_STALE"), stale: true });
  assert.ok(text(stale).includes("Attendance changed since this preview") && text(stale).includes("Load a fresh preview"));
  assert.equal(confirmButton(stale), "", "no confirm button until a fresh preview is shown");

  const refused = text(renderDialog({ phase: "needs-new-preview", preview: preview(), error: fail(409, "FINALIZATION_SESSION_ACTIVE"), stale: false }));
  assert.ok(refused.includes("Finalization was refused") && refused.includes("End the live class session before finalizing attendance."));

  const freshAfterStale = text(renderDialog({ phase: "preview", preview: preview({ fingerprint: FP2 }), stale: true, error: null }));
  assert.ok(freshAfterStale.includes("This is a fresh preview. Review it before confirming."));

  const busy = renderDialog({ phase: "preview", preview: preview(), stale: false, error: fail(409, "ATTENDANCE_BUSY") }, true);
  assert.ok(text(busy).includes("Finalization did not go through") && text(busy).includes("Try finalizing again"));

  const submitting = renderDialog({ phase: "submitting", preview: preview() }, true);
  assert.match(confirmButton(submitting), /disabled=""[^>]*aria-busy="true"|aria-busy="true"[^>]*disabled=""/);
  assert.ok(text(submitting).includes("Finalizing…"));
  assert.match(submitting, /aria-label="Close"[^>]*disabled=""|disabled=""[^>]*aria-label="Close"/);

  const done = text(renderDialog({ phase: "finalized", result: finalized(), refresh: "done" }));
  for (const expected of ["Attendance finalized", "This cannot be undone.", "Marked ABSENT 5", "Eligible at the start 27", "Manual review 1", "The register below has been updated.", "Done"]) {
    assert.ok(done.includes(expected), expected);
  }
  const already = text(renderDialog({ phase: "finalized", result: finalized({ alreadyFinalized: true, details: null }), refresh: "done" }));
  assert.ok(already.includes("Attendance was already finalized") && already.includes("Nothing was changed now."));

  const loadError = text(renderDialog({ phase: "preview-error", error: fail(503, "ATTENDANCE_EVIDENCE_NOT_CONFIGURED") }));
  assert.ok(loadError.includes("The preview could not be loaded") && loadError.includes("Load a fresh preview"));

  assert.equal(renderDialog({ phase: "closed" }), "");
});

function register(finalizedAt: string | null, configured = true): AttendanceRegisterResponse {
  return {
    lecture: { id: "L1", classId: "C1", title: "T", classStatus: "COMPLETED", date: "2026-09-01T12:30:00.000Z", endDate: null },
    register: { lectureId: "L1", exists: true, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: null, graceMinutes: 10, version: 1, finalized: finalizedAt !== null, finalizedAt },
    configuration: { approval: "OK", evidence: "OK" }, classification: "LIVE", students: [],
    summary: { students: 0, withRecord: 0, recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 0 },
    absencePreview: null, onlineEvidence: null, activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "LECTURE_COMPLETED" }, configured },
    qr: { closed: false, closedAt: null, opensAt: "2026-09-01T12:00:00.000Z", window: "OPEN" },
  };
}

test("section: open register offers the preview; finalized shows the badge and no action (no reopen); reconciling and unconfigured disable it", () => {
  const open = renderToStaticMarkup(<FinalizationSection register={register(null)} availability={finalizeAvailability(register(null), false)} onPreview={() => {}} />);
  assert.ok(text(open).includes("Preview finalization"));
  assert.doesNotMatch(open, /disabled=""/);

  const done = renderToStaticMarkup(<FinalizationSection register={register("2026-09-01T16:00:00.000Z")} availability={finalizeAvailability(register("2026-09-01T16:00:00.000Z"), false)} onPreview={() => {}} />);
  assert.ok(text(done).includes("Finalized on 1 Sept 2026, 21:30. Finalization cannot be undone."));
  assert.ok(!text(done).includes("Preview finalization"));
  assert.doesNotMatch(done, /reopen/i);

  assert.deepEqual(finalizeAvailability(register(null), true), { allowed: false, reason: "Wait for online evidence reconciliation to finish." });
  assert.equal(finalizeAvailability(register(null, false), false).allowed, false);
});

test("wiring: the panel shares one lock between both controllers, disposes both, resets the acknowledgement, renders the dialog", () => {
  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  assert.match(panel, /const lock = createActionLock\(\);/);
  assert.match(panel, /createFinalizationController\(\{\s*lectureId,\s*lock,\s*refresh: \(\) => load\("refresh"\),/);
  assert.match(panel, /controller\.dispose\(\);\s*finalizer\.dispose\(\);/);
  assert.match(panel, /if \(next\.phase !== "preview" && next\.phase !== "submitting"\) setAcknowledged\(false\);/);
  assert.match(panel, /<FinalizationDialog\s/);
  assert.match(panel, /finalization\.current\?\.confirm\(acknowledged\)/);
  const controller = source("components", "attendance", "finalization-controller.ts");
  assert.match(controller, /submit\(deps\.lectureId, preview\.fingerprint, \{ signal \}\)/, "the preview's own fingerprint");
  assert.doesNotMatch(controller, /createHash|sha256|crypto|setTimeout|setInterval/, "never builds a fingerprint, never retries on a timer");
});
