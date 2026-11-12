/**
 * Background inertness while the attendance finalization dialog is open
 * (Stage 5.5d-4 follow-up): components/attendance/dialog-inert.ts, driven
 * with a fake DOM tree shaped like the dashboard (no DOM library), plus a
 * simulation of the dialog's open / close effect order with the real focus
 * manager, and the wiring in components/attendance/finalization-dialog.tsx.
 * A real browser pass remains a manual check.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { makeOutsideInert, type InertNode } from "../../components/attendance/dialog-inert";
import { createDialogFocusManager, type FocusContainer, type FocusTarget } from "../../components/attendance/dialog-focus";
import { FinalizationDialog } from "../../components/attendance/finalization-dialog";
import type { FinalizationPreviewResponse } from "../../components/attendance/attendance-ui";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

// ---- A fake DOM shaped like the dashboard -------------------------------------------------------

type FakeNode = InertNode & FocusTarget & { name: string; attrs: Map<string, string>; children: FakeNode[]; parentElement: FakeNode | null };

const focusState = { active: null as FakeNode | null };

function el(name: string, tagName = "DIV", children: FakeNode[] = [], attrs: Record<string, string> = {}): FakeNode {
  const node: FakeNode = {
    name,
    tagName,
    attrs: new Map(Object.entries(attrs)),
    children,
    parentElement: null,
    isConnected: true,
    hasAttribute: (n) => node.attrs.has(n),
    setAttribute: (n, v) => { node.attrs.set(n, v); },
    removeAttribute: (n) => { node.attrs.delete(n); },
    // Like browsers: an inert element (or one inside an inert subtree) cannot take focus.
    focus: () => { if (!insideInert(node)) focusState.active = node; },
  };
  for (const child of children) child.parentElement = node;
  return node;
}
function insideInert(node: FakeNode | null): boolean {
  for (let n = node; n; n = n.parentElement) if (n.hasAttribute("inert")) return true;
  return false;
}

/**
 * body
 * ├── sidebar (nav link)
 * ├── main
 * │   ├── topbar
 * │   └── panel
 * │       ├── back link
 * │       ├── register (Preview finalization trigger, reconcile button)
 * │       └── overlay → dialog → [close, confirm, cancel]
 * ├── toaster
 * ├── already-inert (something else made inert earlier)
 * └── script
 */
function dashboard() {
  focusState.active = null;
  const close = el("close", "BUTTON");
  const confirm = el("confirm", "BUTTON");
  const cancel = el("cancel", "BUTTON", [], { "data-autofocus": "" });
  const dialog = el("dialog", "DIV", [close, confirm, cancel], { role: "dialog" });
  const overlay = el("overlay", "DIV", [dialog]);
  const trigger = el("trigger", "BUTTON");
  const reconcile = el("reconcile", "BUTTON");
  const register = el("register", "DIV", [trigger, reconcile]);
  const back = el("back", "A");
  const panel = el("panel", "DIV", [back, register, overlay]);
  const topbar = el("topbar", "HEADER");
  const main = el("main", "MAIN", [topbar, panel]);
  const sidebar = el("sidebar", "ASIDE", [el("nav-link", "A")]);
  const toaster = el("toaster", "DIV");
  const alreadyInert = el("already-inert", "DIV", [], { inert: "" });
  const script = el("script", "SCRIPT");
  const body = el("body", "BODY", [sidebar, main, toaster, alreadyInert, script]);
  return { body, main, panel, overlay, dialog, close, confirm, cancel, trigger, reconcile, register, back, topbar, sidebar, toaster, alreadyInert, script };
}

const inert = (node: FakeNode) => node.hasAttribute("inert");

// ---- makeOutsideInert ---------------------------------------------------------------------------------

test("open: everything outside the dialog becomes inert; the dialog, its controls and its ancestors do not", () => {
  const d = dashboard();
  makeOutsideInert(d.overlay, d.body);
  for (const node of [d.sidebar, d.topbar, d.back, d.register, d.toaster]) assert.equal(inert(node), true, node.name);
  for (const node of [d.overlay, d.dialog, d.close, d.confirm, d.cancel, d.panel, d.main, d.body]) assert.equal(inert(node), false, node.name);
  // Inside the inert background: the trigger and the reconcile button cannot be reached.
  assert.equal(insideInert(d.trigger), true);
  assert.equal(insideInert(d.reconcile), true);
  // The dialog's own controls stay interactive (no inert ancestor).
  for (const node of [d.close, d.confirm, d.cancel]) assert.equal(insideInert(node), false, node.name);
  assert.equal(inert(d.script), false, "scripts are left alone");
});

test("close: exactly what was added is removed; something inert before stays inert; restore is idempotent", () => {
  const d = dashboard();
  const restore = makeOutsideInert(d.overlay, d.body);
  restore();
  for (const node of [d.sidebar, d.topbar, d.back, d.register, d.toaster, d.overlay, d.dialog]) assert.equal(inert(node), false, node.name);
  assert.equal(inert(d.alreadyInert), true, "not ours to remove");
  // Another restore (close then unmount) changes nothing.
  d.sidebar.setAttribute("inert", "");
  restore();
  assert.equal(inert(d.sidebar), true, "a second restore never removes attributes set by someone else");
});

test("stopAt: nothing at or above the stop node is touched", () => {
  const d = dashboard();
  makeOutsideInert(d.overlay, d.main);
  assert.equal(inert(d.topbar), true);
  assert.equal(inert(d.sidebar), false, "beyond <main>");
  assert.equal(inert(d.toaster), false);
});

// ---- The dialog's effect order (simulated with the real focus manager) -----------------------------

function focusContainer(d: ReturnType<typeof dashboard>): FocusContainer {
  const controls = [d.close, d.confirm, d.cancel];
  return {
    focus: () => d.dialog.focus(),
    querySelectorAll: () => controls,
    querySelector: (selector) => (selector.includes("data-autofocus") ? d.cancel : null),
    contains: (node) => controls.includes(node as FakeNode),
  };
}

/** What FinalizationDialog's open effect does: activate focus, make the background inert; cleanup reverses. */
function openDialog(d: ReturnType<typeof dashboard>, options: { canClose?: () => boolean; onClose?: () => void } = {}) {
  const manager = createDialogFocusManager({
    container: () => focusContainer(d),
    activeElement: () => focusState.active,
    canClose: options.canClose ?? (() => true),
    onClose: options.onClose ?? (() => {}),
  });
  manager.activate();
  const restore = makeOutsideInert(d.overlay, d.body);
  return { manager, cleanup: () => { restore(); manager.deactivate(); } };
}

const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, preventDefault() {} });

test("focus still works: focus moves into the dialog, Tab wraps inside it, and the inert background cannot take focus", () => {
  const d = dashboard();
  d.trigger.focus();
  assert.equal(focusState.active, d.trigger);
  const { manager, cleanup } = openDialog(d);
  assert.equal(focusState.active, d.cancel, "initial focus inside the (non-inert) dialog");
  manager.handleKeyDown(key("Tab"));
  assert.equal(focusState.active, d.close, "Tab wraps inside");
  manager.handleKeyDown(key("Tab", true));
  assert.equal(focusState.active, d.cancel, "Shift+Tab wraps inside");
  d.reconcile.focus();
  assert.equal(focusState.active, d.cancel, "a background control cannot be focused while inert");
  cleanup();
});

test("close and unmount: the background is restored first, then focus returns to the trigger", () => {
  const d = dashboard();
  d.trigger.focus();
  const { cleanup } = openDialog(d);
  cleanup();
  assert.equal(insideInert(d.trigger), false);
  assert.equal(focusState.active, d.trigger, "restored to the (no longer inert) trigger");
  for (const node of [d.sidebar, d.topbar, d.back, d.register, d.toaster]) assert.equal(inert(node), false, node.name);

  // Unmount runs the same cleanup (once more is harmless).
  cleanup();
  assert.equal(focusState.active, d.trigger);
});

test("while submitting: Escape does not close and the background stays inert", () => {
  let closes = 0;
  const d = dashboard();
  d.trigger.focus();
  const { manager, cleanup } = openDialog(d, { canClose: () => false, onClose: () => { closes += 1; } });
  manager.handleKeyDown(key("Escape"));
  assert.equal(closes, 0);
  assert.equal(inert(d.register), true);
  cleanup();
});

// ---- Wiring ---------------------------------------------------------------------------------------------

test("wiring: the overlay is the inert boundary; activate → inert on open, restore → deactivate on close / unmount", () => {
  const dialog = source("components", "attendance", "finalization-dialog.tsx");
  assert.match(dialog, /manager\.activate\(\);\s*const restoreBackground = overlayRef\.current \? makeOutsideInert\(overlayRef\.current, document\.body\) : \(\) => \{\};/);
  assert.match(dialog, /document\.removeEventListener\("keydown", onKey\);\s*restoreBackground\(\);\s*manager\.deactivate\(\);/);
  assert.match(dialog, /\}, \[open\]\);/, "only for the dialog's lifetime");
  assert.match(dialog, /<div ref=\{overlayRef\} data-dialog-overlay className="fixed inset-0 z-50 flex items-end justify-center[^"]*sm:items-center/, "mobile bottom sheet kept");
  assert.doesNotMatch(dialog, /inert=\{|inert:/, "the dialog itself is never given inert");

  const preview = {
    lecture: { lectureId: "L1", status: 0, classStatus: "COMPLETED", date: "2026-09-01T12:30:00.000Z", endDate: null },
    register: { exists: true, version: 1, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: null, graceMinutes: 10, finalized: false, finalizedAt: null },
    classification: "LIVE",
    summary: { rosterSize: 1, eligibleStudents: 1, unknownEligibilityStudents: 0, studentsWithRecord: 0, automaticAbsent: 1, manualReview: 0, notEligibleWithoutRecord: 0, recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 } },
    evidence: { pendingOnlineEvidence: 0, unknownApprovalEvidence: 0, pendingReviews: 0, complete: true },
    readiness: { ready: true, schedule: { allowed: true, basis: "LECTURE_COMPLETED" }, blockers: [], activeSessions: { active: false, count: 0 }, rosterLimit: 500, rosterLimitExceeded: false, evidenceComplete: true },
    fingerprint: "d".repeat(64),
    fingerprintVersion: 1,
  } as FinalizationPreviewResponse;
  const html = renderToStaticMarkup(<FinalizationDialog state={{ phase: "preview", preview, stale: false, error: null }} acknowledged={false} onAcknowledgedChange={() => {}} onConfirm={() => {}} onReloadPreview={() => {}} onClose={() => {}} />);
  assert.match(html, /^<div data-dialog-overlay="true"/);
  assert.doesNotMatch(html, /\binert\b/, "nothing in the dialog is inert");
  assert.match(html, /role="dialog" aria-modal="true"/);
});
