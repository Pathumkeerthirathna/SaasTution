/**
 * Keyboard focus in the attendance finalization dialog (Stage 5.5d-4
 * accessibility follow-up): components/attendance/dialog-focus.ts, driven
 * with fake focusable elements (no DOM library), and its wiring in
 * components/attendance/finalization-dialog.tsx (rendered with
 * react-dom/server and checked from source). A real browser pass (Tab,
 * Shift+Tab, Escape, screen reader) remains a manual check.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { FOCUSABLE_SELECTOR, createDialogFocusManager, type FocusContainer, type FocusTarget } from "../../components/attendance/dialog-focus";
import { FINALIZE_SECTION_ID, FinalizationDialog, FinalizationSection, finalizeAvailability } from "../../components/attendance/finalization-dialog";
import type { AttendanceRegisterResponse, FinalizationPreviewResponse } from "../../components/attendance/attendance-ui";
import type { FinalizationUiState } from "../../components/attendance/finalization-controller";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

// ---- A tiny fake of the focus world -------------------------------------------------------------

type FakeElement = FocusTarget & { name: string; disabled: boolean; autofocus: boolean; isConnected: boolean };

function world(names: { name: string; disabled?: boolean; autofocus?: boolean }[]) {
  const state = { active: null as FocusTarget | null };
  const make = (name: string, disabled = false, autofocus = false): FakeElement => {
    const el: FakeElement = { name, disabled, autofocus, isConnected: true, focus: () => { state.active = el; } };
    return el;
  };
  const children = names.map((n) => make(n.name, n.disabled, n.autofocus));
  const container: FocusContainer & { name: string } = {
    name: "dialog",
    focus: () => { state.active = container; },
    querySelectorAll: () => children.filter((c) => !c.disabled),
    querySelector: (selector: string) => (selector.includes("data-autofocus") ? children.find((c) => c.autofocus && !c.disabled) ?? null : null),
    contains: (node) => children.includes(node as FakeElement),
  };
  const trigger = make("trigger");
  const page = make("page-link");
  return { state, children, container, trigger, page, byName: (name: string) => children.find((c) => c.name === name)! };
}

function manager(w: ReturnType<typeof world>, options: { canClose?: () => boolean; onClose?: () => void; fallback?: () => void } = {}) {
  return createDialogFocusManager({
    container: () => w.container,
    activeElement: () => w.state.active,
    canClose: options.canClose ?? (() => true),
    onClose: options.onClose ?? (() => {}),
    fallback: options.fallback,
  });
}

const key = (k: string, shiftKey = false) => {
  const event = { key: k, shiftKey, prevented: false, preventDefault() { event.prevented = true; } };
  return event;
};
const activeName = (w: ReturnType<typeof world>) => (w.state.active as { name?: string } | null)?.name ?? null;

const CONTROLS = [
  { name: "close-x" },
  { name: "checkbox" },
  { name: "confirm" },
  { name: "cancel", autofocus: true },
];

// ---- Initial focus ----------------------------------------------------------------------------------

test("initial focus: the data-autofocus control (Cancel), else the first focusable, else the dialog itself", () => {
  const w = world(CONTROLS);
  w.trigger.focus();
  manager(w).activate();
  assert.equal(activeName(w), "cancel");

  const noAutofocus = world([{ name: "close-x" }, { name: "confirm" }]);
  manager(noAutofocus).activate();
  assert.equal(activeName(noAutofocus), "close-x");

  const autofocusDisabled = world([{ name: "close-x" }, { name: "cancel", autofocus: true, disabled: true }]);
  manager(autofocusDisabled).activate();
  assert.equal(activeName(autofocusDisabled), "close-x", "a disabled Cancel is skipped");

  const nothing = world([{ name: "confirm", disabled: true }]);
  manager(nothing).activate();
  assert.equal(activeName(nothing), "dialog");
});

// ---- Tab / Shift+Tab ----------------------------------------------------------------------------------

test("Tab: moves freely inside, wraps from the last control to the first, and pulls escaped focus back in", () => {
  const w = world(CONTROLS);
  const m = manager(w);
  m.activate();

  w.byName("checkbox").focus();
  const middle = key("Tab");
  m.handleKeyDown(middle);
  assert.equal(middle.prevented, false, "the browser moves between inner controls");

  w.byName("cancel").focus();
  const atEnd = key("Tab");
  m.handleKeyDown(atEnd);
  assert.equal(atEnd.prevented, true);
  assert.equal(activeName(w), "close-x", "wraps to the first");

  w.page.focus();
  const outside = key("Tab");
  m.handleKeyDown(outside);
  assert.equal(outside.prevented, true);
  assert.equal(activeName(w), "close-x", "focus outside comes back to the first");

  w.container.focus();
  const onDialog = key("Tab");
  m.handleKeyDown(onDialog);
  assert.equal(activeName(w), "close-x", "from the dialog element itself to the first control");
});

test("Shift+Tab: moves backwards inside, wraps from the first control to the last, and pulls escaped focus back in", () => {
  const w = world(CONTROLS);
  const m = manager(w);
  m.activate();

  w.byName("confirm").focus();
  const middle = key("Tab", true);
  m.handleKeyDown(middle);
  assert.equal(middle.prevented, false);

  w.byName("close-x").focus();
  const atStart = key("Tab", true);
  m.handleKeyDown(atStart);
  assert.equal(atStart.prevented, true);
  assert.equal(activeName(w), "cancel", "wraps to the last");

  w.page.focus();
  m.handleKeyDown(key("Tab", true));
  assert.equal(activeName(w), "cancel");

  w.container.focus();
  m.handleKeyDown(key("Tab", true));
  assert.equal(activeName(w), "cancel", "from the dialog element itself to the last control");

  // Other keys are left alone.
  const other = key("Enter");
  m.handleKeyDown(other);
  assert.equal(other.prevented, false);
});

// ---- Restoration ---------------------------------------------------------------------------------------

test("focus restoration: back to the trigger on close; to the fallback when the trigger is gone; only once", () => {
  const w = world(CONTROLS);
  w.trigger.focus();
  const m = manager(w);
  m.activate();
  assert.equal(activeName(w), "cancel");
  m.deactivate();
  assert.equal(activeName(w), "trigger");

  // The trigger was removed (the register became finalized): the fallback receives focus.
  const w2 = world(CONTROLS);
  w2.trigger.focus();
  let fellBack = 0;
  const m2 = manager(w2, { fallback: () => { fellBack += 1; } });
  m2.activate();
  w2.trigger.isConnected = false;
  m2.deactivate();
  assert.equal(fellBack, 1);
  m2.deactivate();
  assert.equal(fellBack, 1, "deactivate is idempotent");
  m2.handleKeyDown(key("Escape"));
});

// ---- Submission -----------------------------------------------------------------------------------------

test("submitting: Escape does not close; with every control disabled Tab keeps focus on the dialog; refocus pulls it back", () => {
  let closes = 0;
  let submitting = true;
  const w = world([{ name: "close-x", disabled: true }, { name: "checkbox", disabled: true }, { name: "confirm", disabled: true }, { name: "cancel", autofocus: true, disabled: true }]);
  const m = manager(w, { canClose: () => !submitting, onClose: () => { closes += 1; } });
  m.activate();
  assert.equal(activeName(w), "dialog");

  const escape = key("Escape");
  m.handleKeyDown(escape);
  assert.equal(escape.prevented, true);
  assert.equal(closes, 0, "never closes while submitting");

  w.page.focus();
  const tab = key("Tab");
  m.handleKeyDown(tab);
  assert.equal(tab.prevented, true);
  assert.equal(activeName(w), "dialog");

  // A focused control became disabled and focus fell outside: refocus brings it back.
  w.page.focus();
  m.refocus();
  assert.equal(activeName(w), "dialog");

  // Submission over: Escape closes.
  submitting = false;
  m.handleKeyDown(key("Escape"));
  assert.equal(closes, 1);
});

test("selector: enabled controls only (disabled controls and tabindex=-1 are never in the cycle)", () => {
  for (const part of ['button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', 'textarea:not([disabled])', 'a[href]', '[tabindex]:not([tabindex="-1"])']) {
    assert.ok(FOCUSABLE_SELECTOR.includes(part), part);
  }
});

// ---- Wiring ----------------------------------------------------------------------------------------------

const preview: FinalizationPreviewResponse = {
  lecture: { lectureId: "L1", status: 0, classStatus: "COMPLETED", date: "2026-09-01T12:30:00.000Z", endDate: null },
  register: { exists: true, version: 1, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: null, graceMinutes: 10, finalized: false, finalizedAt: null },
  classification: "LIVE",
  summary: { rosterSize: 1, eligibleStudents: 1, unknownEligibilityStudents: 0, studentsWithRecord: 0, automaticAbsent: 1, manualReview: 0, notEligibleWithoutRecord: 0, recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 } },
  evidence: { pendingOnlineEvidence: 0, unknownApprovalEvidence: 0, pendingReviews: 0, complete: true },
  readiness: { ready: true, schedule: { allowed: true, basis: "LECTURE_COMPLETED" }, blockers: [], activeSessions: { active: false, count: 0 }, rosterLimit: 500, rosterLimitExceeded: false, evidenceComplete: true },
  fingerprint: "c".repeat(64),
  fingerprintVersion: 1,
};
const render = (state: FinalizationUiState) =>
  renderToStaticMarkup(<FinalizationDialog state={state} acknowledged={false} onAcknowledgedChange={() => {}} onConfirm={() => {}} onReloadPreview={() => {}} onClose={() => {}} />);

test("wiring: dialog semantics kept; Cancel is the initial focus; disabled while submitting; the section is the restoration fallback", () => {
  const html = render({ phase: "preview", preview, stale: false, error: null });
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="finalization-dialog-title" aria-describedby="finalization-dialog-description"/);
  assert.match(html, /tabindex="-1"/, "the dialog itself can hold focus");
  assert.match(html, /<button type="button"[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
  assert.match(html, /items-end justify-center[^"]*sm:items-center/, "mobile bottom sheet kept");

  const submitting = render({ phase: "submitting", preview });
  assert.match(submitting, /<button type="button" disabled=""[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
  assert.match(submitting, /aria-label="Close"[^>]*disabled=""|disabled=""[^>]*aria-label="Close"/);

  const register = {
    lecture: { id: "L1", classId: "C1", title: "T", classStatus: "COMPLETED", date: "2026-09-01T12:30:00.000Z", endDate: null },
    register: { lectureId: "L1", exists: true, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: null, graceMinutes: 10, version: 1, finalized: false, finalizedAt: null },
    configuration: { approval: "OK", evidence: "OK" }, classification: "LIVE", students: [],
    summary: { students: 0, withRecord: 0, recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 0 },
    absencePreview: null, onlineEvidence: null, activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "LECTURE_COMPLETED" }, configured: true },
    qr: { closed: false, closedAt: null, opensAt: "2026-09-01T12:00:00.000Z", window: "OPEN" },
  } as AttendanceRegisterResponse;
  const section = renderToStaticMarkup(<FinalizationSection register={register} availability={finalizeAvailability(register, false)} onPreview={() => {}} />);
  assert.match(section, new RegExp(`<section id="${FINALIZE_SECTION_ID}" tabindex="-1"`));

  const dialog = source("components", "attendance", "finalization-dialog.tsx");
  assert.match(dialog, /createDialogFocusManager\(\{/);
  assert.match(dialog, /canClose: \(\) => !submittingRef\.current/);
  assert.match(dialog, /document\.addEventListener\("keydown", onKey\)/);
  // The background is restored first (tests/ui/attendance-dialog-inert.test.tsx), then focus returns.
  assert.match(dialog, /document\.removeEventListener\("keydown", onKey\);\s*restoreBackground\(\);\s*manager\.deactivate\(\);/, "focus restored when the dialog closes or unmounts");
  assert.match(dialog, /if \(submitting\) focusManager\.current\?\.refocus\(\);/);
  assert.match(dialog, /\}, \[open\]\);/, "activated once per opening (not on every phase change)");
  assert.doesNotMatch(dialog, /window\.addEventListener\("keydown"/, "the old Escape-only handler is gone");
});
