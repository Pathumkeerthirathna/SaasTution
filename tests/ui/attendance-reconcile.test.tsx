/**
 * The register page's online evidence reconciliation (Stage 5.5d-3):
 * components/attendance/reconciliation-controller.ts (the run: duplicate
 * clicks, progress, outcome, refresh, cancel, unmount, stale loads) and
 * components/attendance/reconcile-section.tsx (availability, progress and
 * outcome text). The controller is driven with injected runners, including
 * the real runReconciliation over a fake fetch; the section renders with
 * react-dom/server; the panel's wiring is checked from source. Clicking
 * through the real page remains a manual check.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  runReconciliation,
  type AttendanceRegisterResponse,
  type ReconcileCounts,
  type ReconcileOptions,
  type ReconcileOutcome,
  type ReconcileProgress,
} from "../../components/attendance/attendance-ui";
import {
  createLatestRequestGate,
  createReconcileController,
  outcomeChangedData,
  type ReconcileUiState,
} from "../../components/attendance/reconciliation-controller";
import { ReconcileSection, reconcileAvailability, reconcileOutcomeMessage } from "../../components/attendance/reconcile-section";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const ZERO: ReconcileCounts = { processed: 0, applied: 0, duplicates: 0, ineligible: 0, unknown: 0, inactive: 0, finalizedWithoutRecord: 0, busy: 0, skipped: 0 };
const counts = (fields: Partial<ReconcileCounts>): ReconcileCounts => ({ ...ZERO, ...fields });
const complete = (fields: Partial<ReconcileCounts> = {}): ReconcileOutcome => ({ status: "COMPLETE", passes: 1, pages: 1, totals: counts(fields) });
const progress = (pass: number, pageInPass: number, pages: number, totals: Partial<ReconcileCounts>): ReconcileProgress => ({
  pass, pageInPass, pages, totals: counts(totals), page: { lectureId: "L1", ...counts(totals), nextCursor: null, stoppedBecause: null },
});

/** A controlled runner: resolves when the test says so; records its calls. */
function deferredRunner() {
  const calls: { lectureId: string; options: ReconcileOptions }[] = [];
  let resolve!: (outcome: ReconcileOutcome) => void;
  const run = (lectureId: string, options: ReconcileOptions) => {
    calls.push({ lectureId, options });
    return new Promise<ReconcileOutcome>((r) => { resolve = r; });
  };
  return { run, calls, finish: (outcome: ReconcileOutcome) => resolve(outcome) };
}

function harness(run: (lectureId: string, options: ReconcileOptions) => Promise<ReconcileOutcome>, refresh: () => Promise<boolean> = async () => true) {
  const states: ReconcileUiState[] = [];
  let refreshes = 0;
  const controller = createReconcileController({
    lectureId: "L1",
    run,
    refresh: async () => { refreshes += 1; return refresh(); },
    onChange: (state) => states.push(state),
  });
  return { controller, states, refreshes: () => refreshes };
}

const tick = () => new Promise((r) => setImmediate(r));

// ---- Controller --------------------------------------------------------------------------------

test("start: running → progress → COMPLETE → register refreshed; the run gets the lecture and an abort signal", async () => {
  const runner = deferredRunner();
  const { controller, states, refreshes } = harness(runner.run);
  const started = controller.start();
  assert.deepEqual(states.at(-1), { phase: "running", progress: null });
  assert.equal(runner.calls[0].lectureId, "L1");
  assert.ok(runner.calls[0].options.signal instanceof AbortSignal);

  runner.calls[0].options.onProgress!(progress(1, 1, 1, { processed: 100, applied: 4, duplicates: 96 }));
  assert.deepEqual(states.at(-1), { phase: "running", progress: progress(1, 1, 1, { processed: 100, applied: 4, duplicates: 96 }) });

  runner.finish(complete({ processed: 120, applied: 5, duplicates: 115 }));
  assert.equal(await started, true);
  assert.equal(refreshes(), 1);
  assert.deepEqual(states.slice(-2).map((s) => (s.phase === "done" ? s.refresh : s.phase)), ["pending", "done"]);
  const last = states.at(-1)!;
  assert.ok(last.phase === "done" && last.outcome.status === "COMPLETE" && last.outcome.totals.applied === 5);
});

test("duplicate clicks: start is ignored while a run is in progress (one request at a time)", async () => {
  const runner = deferredRunner();
  const { controller } = harness(runner.run);
  const first = controller.start();
  // Checked before awaiting, so a regression fails here instead of waiting on a second run.
  const second = controller.start();
  const third = controller.start();
  assert.equal(runner.calls.length, 1);
  assert.equal(await second, false);
  assert.equal(await third, false);
  assert.equal(controller.isRunning(), true);
  runner.finish(complete());
  await first;
  assert.equal(controller.isRunning(), false);
  // Once finished, a new run may start.
  const again = controller.start();
  assert.equal(runner.calls.length, 2);
  runner.finish(complete());
  await again;
});

test("busy students: the shared helper runs a fresh pass (pass 2 from no cursor); progress shows it; the outcome is reported as is", async () => {
  const bodies: unknown[] = [];
  const pages = [
    { processed: 3, applied: 2, busy: 1, nextCursor: null },
    { processed: 3, applied: 1, duplicates: 2, nextCursor: null },
  ];
  let i = 0;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const page = pages[Math.min(i++, pages.length - 1)];
    return new Response(JSON.stringify({ success: true, data: { lectureId: "L1", ...ZERO, stoppedBecause: null, ...page } }), { status: 200 });
  };
  const { controller, states, refreshes } = harness((lectureId, options) => runReconciliation(lectureId, { ...options, fetchImpl, wait: async () => {} }));
  await controller.start();
  const passes = states.filter((s) => s.phase === "running" && s.progress).map((s) => (s.phase === "running" ? s.progress!.pass : 0));
  assert.deepEqual(passes, [1, 2]);
  assert.deepEqual(bodies, [{ cursor: null, limit: 100 }, { cursor: null, limit: 100 }]);
  const last = states.at(-1)!;
  assert.ok(last.phase === "done" && last.outcome.status === "COMPLETE" && last.outcome.totals.busy === 1 && last.outcome.passes === 2);
  assert.equal(refreshes(), 1);
});

test("incomplete and failed outcomes: never success; the register is refreshed only when data changed", async () => {
  for (const [outcome, refreshed] of [
    [{ status: "INCOMPLETE", reason: "BUSY_REMAINING", passes: 3, pages: 3, totals: counts({ processed: 9, applied: 2, busy: 3 }) }, true],
    [{ status: "INCOMPLETE", reason: "BUSY_REMAINING", passes: 3, pages: 3, totals: counts({ processed: 3, busy: 3 }) }, false],
    [{ status: "INCOMPLETE", reason: "LECTURE_CHANGED", passes: 1, pages: 1, totals: ZERO }, false],
    [{ status: "FAILED", error: { ok: false, status: 409, code: "ATTENDANCE_LECTURE_HISTORICAL", message: "m" }, passes: 1, pages: 0, totals: ZERO }, false],
  ] as [ReconcileOutcome, boolean][]) {
    const runner = deferredRunner();
    const { controller, states, refreshes } = harness(runner.run);
    const done = controller.start();
    runner.finish(outcome);
    await done;
    assert.equal(refreshes(), refreshed ? 1 : 0, JSON.stringify(outcome));
    const last = states.at(-1)!;
    assert.ok(last.phase === "done");
    if (last.phase === "done") {
      assert.equal(last.refresh, refreshed ? "done" : "skipped");
      assert.equal(last.outcome, outcome, "the helper's outcome, unchanged (code preserved)");
    }
  }
  assert.equal(outcomeChangedData(complete()), true, "COMPLETE always refreshes");
});

test("a failed refresh keeps the outcome and reports it; a throwing runner never leaves the button stuck", async () => {
  const runner = deferredRunner();
  const { controller, states } = harness(runner.run, async () => false);
  const done = controller.start();
  runner.finish(complete({ processed: 1, applied: 1 }));
  await done;
  assert.ok(states.at(-1)!.phase === "done" && (states.at(-1) as Extract<ReconcileUiState, { phase: "done" }>).refresh === "failed");

  const broken = harness(async () => { throw new Error("boom"); });
  await broken.controller.start();
  const last = broken.states.at(-1)!;
  assert.ok(last.phase === "done" && last.outcome.status === "FAILED" && last.outcome.error.code === "INVALID_RESPONSE");
  assert.equal(broken.controller.isRunning(), false);
});

test("cancel: aborts the run's signal; with the shared helper the outcome is INCOMPLETE ABORTED (no success, no refresh)", async () => {
  // A request that only ends when its signal aborts.
  const fetchImpl = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const { controller, states, refreshes } = harness((lectureId, options) => runReconciliation(lectureId, { ...options, fetchImpl, wait: async () => {} }));
  const done = controller.start();
  await tick();
  controller.cancel();
  // Bounded wait: if cancel did not abort, fail here instead of hanging.
  const settled = await Promise.race([done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
  assert.equal(settled, true, "cancel ends the run");
  const last = states.at(-1)!;
  assert.ok(last.phase === "done" && last.outcome.status === "INCOMPLETE" && last.outcome.reason === "ABORTED");
  assert.equal(refreshes(), 0);
});

test("unmount (dispose): the run is aborted and nothing that arrives afterwards changes state or refreshes", async () => {
  const runner = deferredRunner();
  const { controller, states, refreshes } = harness(runner.run);
  const done = controller.start();
  const before = states.length;
  controller.dispose();
  assert.equal(runner.calls[0].options.signal!.aborted, true);
  runner.calls[0].options.onProgress!(progress(1, 1, 1, { processed: 5 }));
  runner.finish(complete({ processed: 5, applied: 5 }));
  await done;
  assert.equal(states.length, before, "no state change after dispose");
  assert.equal(refreshes(), 0);
  assert.equal(await controller.start(), false, "a disposed controller never starts");

  // Disposed while the refresh is in flight: its result is ignored too.
  const runner2 = deferredRunner();
  let resolveRefresh!: (v: boolean) => void;
  const h = harness(runner2.run, () => new Promise<boolean>((r) => { resolveRefresh = r; }));
  const done2 = h.controller.start();
  runner2.finish(complete({ processed: 1, applied: 1 }));
  await tick();
  const pending = h.states.length;
  h.controller.dispose();
  resolveRefresh(true);
  await done2;
  assert.equal(h.states.length, pending);
});

test("stale loads: only the newest register request may update the page", () => {
  const gate = createLatestRequestGate();
  const initial = gate.begin();
  const refresh = gate.begin();
  assert.equal(gate.isCurrent(initial), false, "an older (slower) response is ignored");
  assert.equal(gate.isCurrent(refresh), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(refresh), false, "after unmount nothing is current");
});

// ---- Availability and messages ------------------------------------------------------------------

function register(overrides: { classStatus?: string; classification?: "LIVE" | "HISTORICAL" | null; finalized?: boolean } = {}): AttendanceRegisterResponse {
  return {
    lecture: { id: "L1", classId: "C1", title: "T", classStatus: overrides.classStatus ?? "COMPLETED", date: "2026-09-01T12:30:00.000Z", endDate: null },
    register: { lectureId: "L1", exists: true, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: null, graceMinutes: 10, version: 1, finalized: overrides.finalized ?? false, finalizedAt: overrides.finalized ? "2026-09-01T16:00:00.000Z" : null },
    configuration: { approval: "OK", evidence: "OK" },
    classification: overrides.classification === undefined ? "LIVE" : overrides.classification,
    students: [],
    summary: { students: 0, withRecord: 0, recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 0 },
    absencePreview: null,
    onlineEvidence: null,
    activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "LECTURE_COMPLETED" }, configured: true },
    qr: { closed: false, closedAt: null, opensAt: "2026-09-01T12:00:00.000Z", window: "OPEN" },
  };
}

test("availability mirrors the API: cancelled, historical and unconfigured lectures are not offered; finalized ones are, with an explanation", () => {
  assert.deepEqual(reconcileAvailability(register()), { allowed: true, reason: null, note: null });
  for (const [r, words] of [
    [register({ classStatus: "CANCELLED" }), "cancelled"],
    [register({ classification: "HISTORICAL" }), "before automatic attendance started"],
    [register({ classification: null }), "not configured"],
  ] as const) {
    const availability = reconcileAvailability(r);
    assert.equal(availability.allowed, false);
    assert.ok(availability.reason!.includes(words), words);
  }
  const finalized = reconcileAvailability(register({ finalized: true }));
  assert.equal(finalized.allowed, true);
  assert.match(finalized.note!, /never changes a finalized status and never creates new records/);
});

test("messages: success only for COMPLETE; each stop reason and failure explained with its next step", () => {
  const titles = new Set<string>();
  const cases: [ReconcileOutcome, string, string][] = [
    [complete({ applied: 3 }), "success", "NONE"],
    [{ status: "INCOMPLETE", reason: "BUSY_REMAINING", passes: 3, pages: 3, totals: counts({ busy: 2 }) }, "warning", "RUN_AGAIN"],
    [{ status: "INCOMPLETE", reason: "LECTURE_CHANGED", passes: 1, pages: 1, totals: ZERO }, "warning", "RELOAD_PAGE"],
    [{ status: "INCOMPLETE", reason: "NO_PROGRESS", passes: 1, pages: 2, totals: ZERO }, "warning", "RUN_AGAIN"],
    [{ status: "INCOMPLETE", reason: "PAGE_LIMIT", passes: 1, pages: 200, totals: ZERO }, "warning", "RUN_AGAIN"],
    [{ status: "INCOMPLETE", reason: "ABORTED", passes: 1, pages: 1, totals: ZERO }, "info", "RUN_AGAIN"],
    [{ status: "FAILED", error: { ok: false, status: 401, code: "UNAUTHORIZED", message: "Your session has expired. Please sign in again." }, passes: 1, pages: 0, totals: ZERO }, "error", "SIGN_IN"],
    [{ status: "FAILED", error: { ok: false, status: 503, code: "ATTENDANCE_EVIDENCE_NOT_CONFIGURED", message: "x" }, passes: 1, pages: 0, totals: ZERO }, "error", "CONTACT_SUPPORT"],
    [{ status: "FAILED", error: { ok: false, status: 409, code: "ATTENDANCE_BUSY", message: "x" }, passes: 1, pages: 0, totals: ZERO }, "error", "RUN_AGAIN"],
  ];
  for (const [outcome, tone, next] of cases) {
    const message = reconcileOutcomeMessage(outcome);
    assert.deepEqual([message.tone, message.next], [tone, next], JSON.stringify(outcome));
    if (outcome.status !== "COMPLETE") assert.notEqual(message.title, "Online evidence reconciled");
    titles.add(message.title);
  }
  assert.ok(titles.size >= 7, "distinct titles per reason");
  assert.match(reconcileOutcomeMessage(cases[1][0]).body, /Another reconciliation attempt may be needed/);
  // A failure shows the shared helper's safe message (never server internals).
  assert.equal(reconcileOutcomeMessage(cases[6][0]).body, "Your session has expired. Please sign in again.");
});

// ---- Rendering --------------------------------------------------------------------------------------

const renderSection = (state: ReconcileUiState, r = register()) =>
  renderToStaticMarkup(<ReconcileSection availability={reconcileAvailability(r)} state={state} onStart={() => {}} onCancel={() => {}} />);

test("render: idle button, disabled with a reason when not offered, finalized note", () => {
  const idle = renderSection({ phase: "idle" });
  assert.match(idle, /<button type="button"[^>]*aria-busy="false"[^>]*>[\s\S]*?Reconcile online evidence<\/button>/);
  assert.doesNotMatch(idle, /disabled=""/);
  assert.match(idle, /role="status" aria-live="polite"/);

  const historical = renderSection({ phase: "idle" }, register({ classification: "HISTORICAL" }));
  assert.match(historical, /disabled=""/);
  assert.ok(text(historical).includes("before automatic attendance started"));

  const finalized = text(renderSection({ phase: "idle" }, register({ finalized: true })));
  assert.ok(finalized.includes("This register is finalized"));
});

test("render: running shows pass, pages and running counts; the button is busy and disabled; Stop is offered", () => {
  const html = renderSection({ phase: "running", progress: progress(2, 1, 4, { processed: 250, applied: 7, duplicates: 240, busy: 1, skipped: 2 }) });
  const t = text(html);
  assert.match(html, /disabled=""[^>]*aria-busy="true"|aria-busy="true"[^>]*disabled=""/);
  for (const expected of ["Reconciling…", "Stop", "Reconciliation is running", "Pass 2 · page 1 of this pass · 4 page(s) in total",
    "Students checked 250", "Evidence recorded 7", "Already recorded 240", "Busy 1", "Skipped 2"]) {
    assert.ok(t.includes(expected), expected);
  }
  assert.ok(text(renderSection({ phase: "running", progress: null })).includes("Starting…"));
});

test("render: outcomes (complete with refresh, busy, failure with sign-in) and every final count", () => {
  const done = text(renderSection({ phase: "done", outcome: complete({ processed: 10, applied: 3, duplicates: 6, finalizedWithoutRecord: 1 }), refresh: "done" }));
  for (const expected of ["Online evidence reconciled", "3 student(s) had online evidence recorded.", "The register below has been updated.",
    "Students checked 10", "Finalized, no record 1", "1 pass(es), 1 page(s)."]) {
    assert.ok(done.includes(expected), expected);
  }
  assert.ok(text(renderSection({ phase: "done", outcome: complete({ processed: 1, applied: 1 }), refresh: "pending" })).includes("Refreshing the register…"));
  assert.ok(text(renderSection({ phase: "done", outcome: complete({ processed: 1, applied: 1 }), refresh: "failed" })).includes("could not be refreshed"));

  const busy = renderSection({ phase: "done", outcome: { status: "INCOMPLETE", reason: "BUSY_REMAINING", passes: 3, pages: 3, totals: counts({ busy: 2 }) }, refresh: "skipped" });
  assert.match(busy, /data-outcome="INCOMPLETE"/);
  assert.ok(!text(busy).includes("Online evidence reconciled"));
  assert.ok(text(busy).includes("You can run reconciliation again."));

  const failed = renderSection({ phase: "done", outcome: { status: "FAILED", error: { ok: false, status: 401, code: "UNAUTHORIZED", message: "Your session has expired. Please sign in again." }, passes: 1, pages: 0, totals: ZERO }, refresh: "skipped" });
  assert.match(failed, /href="\/login"/);
  assert.ok(text(failed).includes("Reconciliation failed"));
});

// ---- Wiring (source) ---------------------------------------------------------------------------------

test("wiring: the panel uses the shared helper through the controller, refreshes in place, guards stale loads and disposes on unmount", () => {
  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  assert.match(panel, /createReconcileController\(\{\s*lectureId,\s*lock,\s*run: runReconciliation,\s*refresh: \(\) => load\("refresh"\),/);
  assert.match(panel, /controller\.dispose\(\);/);
  assert.match(panel, /if \(!gate\.current\.isCurrent\(id\) \|\| controller\.signal\.aborted\) return false;/);
  assert.match(panel, /if \(mode === "initial"\) setState\(\{ kind: "error", error: result \}\);/, "a failed refresh never replaces the register with an error");
  assert.match(panel, /actions=\{\s*<>\s*<ReconcileSection/);
  assert.doesNotMatch(panel, /window\.location|router\.refresh|location\.reload/, "no full page reload");
  const controllerSource = source("components", "attendance", "reconciliation-controller.ts");
  assert.doesNotMatch(controllerSource, /\bfetch\(|setTimeout|setInterval|nextCursor/, "no paging or retry loop of its own");
});
