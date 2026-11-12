/**
 * Stage 5.7b-2b-3: the grace-period UI — the class forms' default
 * (components/class-form-payload.ts, components/class-management-panel.tsx)
 * and the register's per-lecture change (components/attendance/grace-dialog.tsx,
 * grace-controller.ts, attendance-ui.ts submitRegisterGrace, and the register
 * panel's wiring). Views render with react-dom/server; the request flow runs
 * the real controller and helper over a fake fetch (real Response objects);
 * the modal behaviour is the shared hook's (tested in
 * attendance-decision-dialog.test.tsx) and is checked here by its wiring.
 * No browser, no server, no database.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  attendanceErrorMessage,
  graceResultMessage,
  GRACE_MINUTES_DEFAULT,
  parseGraceMinutesInput,
  submitRegisterGrace,
  type AttendanceRegisterResponse,
  type GraceResponse,
} from "../../components/attendance/attendance-ui";
import { buildClassFormPayload, classGraceInput, DEFAULT_CLASS_GRACE_INPUT, type ClassFormFields } from "../../components/class-form-payload";
import {
  checkGraceDraft,
  GRACE_ACTION_ID,
  GraceAction,
  GraceDialog,
  graceBusy,
  graceChangeAvailability,
  graceTargetOf,
  REGISTER_SCHEDULE_ID,
  type GraceDraft,
  type GraceTarget,
} from "../../components/attendance/grace-dialog";
import { createGraceController, graceErrorNeedsReopen, type GraceUiState } from "../../components/attendance/grace-controller";
import { DEFAULT_REGISTER_FILTERS, RegisterView } from "../../components/attendance/lecture-attendance-register-panel";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const noop = () => {};

// ======================================================================================
// 1. Class forms
// ======================================================================================

const FORM: ClassFormFields = {
  name: "Physics",
  description: "",
  monthlyFee: "2500",
  paymentDueWeek: "2",
  attendanceGraceMinutes: DEFAULT_CLASS_GRACE_INPUT,
  startDate: "2026-09-01",
  schedules: [{ dayOfWeek: "MONDAY", startTime: "08:00", endTime: "10:00" }],
};

test("class forms: a new class defaults to 10; an existing class shows its saved value (0 included)", () => {
  assert.equal(DEFAULT_CLASS_GRACE_INPUT, "10");
  assert.equal(GRACE_MINUTES_DEFAULT, 10);
  assert.equal(classGraceInput(15), "15");
  assert.equal(classGraceInput(0), "0", "0 is a saved value, not 'missing'");
  assert.equal(classGraceInput(240), "240");
  assert.equal(classGraceInput(undefined), "10");
  assert.equal(classGraceInput(null), "10");
});

test("class forms: the request body keeps every existing field and adds the grace as a number (0 and 240 accepted)", () => {
  for (const [input, expected] of [["10", 10], ["0", 0], ["240", 240], [" 15 ", 15]] as const) {
    const payload = buildClassFormPayload({ ...FORM, attendanceGraceMinutes: input });
    assert.ok(payload.ok, input);
    if (!payload.ok) continue;
    assert.deepEqual(payload.body, {
      name: "Physics", description: "", monthlyFee: 2500, paymentDueWeek: 2, attendanceGraceMinutes: expected, startDate: "2026-09-01",
      schedules: [{ dayOfWeek: "MONDAY", startTime: "08:00", endTime: "10:00" }],
    });
  }
  // Existing behaviour kept: empty fee → 0, empty week → 1 (as before).
  const defaults = buildClassFormPayload({ ...FORM, monthlyFee: "", paymentDueWeek: "" });
  assert.ok(defaults.ok && defaults.body.monthlyFee === 0 && defaults.body.paymentDueWeek === 1);
});

test("class forms: invalid grace values are refused before sending (empty, negative, above 240, decimal, text, exponent)", () => {
  for (const input of ["", "   ", "-1", "241", "1.5", "abc", "1e2", "+5", "10 minutes"]) {
    const payload = buildClassFormPayload({ ...FORM, attendanceGraceMinutes: input });
    assert.equal(payload.ok, false, input);
    if (!payload.ok) assert.match(payload.message, /grace period/i, input);
  }
  assert.deepEqual(parseGraceMinutesInput("0"), { ok: true, value: 0 });
  assert.deepEqual(parseGraceMinutesInput("241"), { ok: false, problem: "OUT_OF_RANGE" });
  assert.deepEqual(parseGraceMinutesInput("2.5"), { ok: false, problem: "NOT_WHOLE_NUMBER" });
  assert.deepEqual(parseGraceMinutesInput(""), { ok: false, problem: "REQUIRED" });
});

test("class panel wiring: both forms have the labelled field, default 10, the saved value on edit, the validated payload", () => {
  const panel = source("components", "class-management-panel.tsx");
  for (const id of ["classAttendanceGraceMinutes", "editAttendanceGraceMinutes"]) {
    assert.match(panel, new RegExp(`<label htmlFor="${id}"[^>]*>\\s*Attendance grace period \\(minutes\\)\\s*</label>`), id);
    assert.match(panel, new RegExp(`id="${id}"\\s+type="number"\\s+inputMode="numeric"\\s+min=\\{GRACE_MINUTES_MIN\\}\\s+max=\\{GRACE_MINUTES_MAX\\}\\s+step=\\{1\\}`), id);
  }
  assert.equal((panel.match(/attendanceGraceMinutes: DEFAULT_CLASS_GRACE_INPUT,/g) ?? []).length, 3, "create initial, edit initial, reset after create");
  assert.match(panel, /attendanceGraceMinutes: classGraceInput\(item\.attendanceGraceMinutes\),/);
  assert.match(panel, /const createPayload = buildClassFormPayload\(createForm\);\s*if \(!createPayload\.ok\) \{\s*setErrorMessage\(createPayload\.message\);\s*return;\s*\}/);
  assert.match(panel, /body: JSON\.stringify\(createPayload\.body\),/);
  assert.match(panel, /const updatePayload = buildClassFormPayload\(editForm\);\s*if \(!updatePayload\.ok\) \{\s*setErrorMessage\(updatePayload\.message\);\s*return;\s*\}/);
  assert.match(panel, /body: JSON\.stringify\(updatePayload\.body\),/);
  // The other fields and endpoints are as before.
  assert.match(panel, /fetch\("\/api\/classes", \{\s*method: "POST"/);
  assert.match(panel, /fetch\(`\/api\/classes\/\$\{classId\}`, \{\s*method: "PUT"/);
  assert.match(panel, /setErrorMessage\(payload\.error\?\.message \?\? "Failed to create class\."\)/);
  assert.match(panel, /setErrorMessage\(payload\.error\?\.message \?\? "Failed to update class\."\)/);
});

// ======================================================================================
// 2. Availability, target, draft
// ======================================================================================

function registerOf({ finalized = false, classStatus = "COMPLETED", graceMinutes = 10, version = 3, exists = true, classification = "LIVE" } = {}) {
  return {
    lecture: { id: "L 1", classId: "C1", title: "Kinematics", classStatus, date: "2026-09-01T12:30:00.000Z", endDate: "2026-09-01T14:30:00.000Z" },
    register: {
      lectureId: "L 1", exists, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: "2026-09-01T14:30:00.000Z", graceMinutes,
      version, finalized, finalizedAt: finalized ? "2026-09-01T15:00:00.000Z" : null,
    },
    configuration: { approval: "OK", evidence: "OK" }, classification, students: [],
    summary: { students: 0, withRecord: 0, recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 0 },
    absencePreview: null, onlineEvidence: null, activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "LECTURE_COMPLETED" }, configured: true },
  } as unknown as AttendanceRegisterResponse;
}

test("availability: open registers only (finalized and cancelled refused); historical lectures allowed", () => {
  assert.deepEqual(graceChangeAvailability(registerOf()), { allowed: true, reason: null });
  assert.equal(graceChangeAvailability(registerOf({ classification: "HISTORICAL" })).allowed, true);
  assert.equal(graceChangeAvailability(registerOf({ exists: false, version: 0 })).allowed, true, "no register yet: allowed (the server creates it)");
  assert.equal(graceChangeAvailability(registerOf({ finalized: true })).allowed, false);
  assert.equal(graceChangeAvailability(registerOf({ classStatus: "CANCELLED" })).allowed, false);
});

test("target snapshot: current grace and the loaded register version (0 without a register)", () => {
  assert.deepEqual(graceTargetOf(registerOf({ graceMinutes: 15, version: 4 })), { lectureTitle: "Kinematics", currentGraceMinutes: 15, expectedVersion: 4 });
  assert.equal(graceTargetOf(registerOf({ exists: false, version: 0 })).expectedVersion, 0);
});

const TARGET: GraceTarget = { lectureTitle: "Kinematics", currentGraceMinutes: 10, expectedVersion: 3 };
const draft = (value: string, reason = ""): GraceDraft => ({ value, reason });

test("draft: whole minutes 0–240, different from the current value; reason optional until the server requires it; trimmed; ≤ 500", () => {
  assert.deepEqual(checkGraceDraft(TARGET, draft("30"), false), { ok: true, graceMinutes: 30, reason: null });
  assert.deepEqual(checkGraceDraft(TARGET, draft("0", " Strict. "), false), { ok: true, graceMinutes: 0, reason: "Strict." });
  assert.deepEqual(checkGraceDraft(TARGET, draft("240"), false), { ok: true, graceMinutes: 240, reason: null });
  assert.deepEqual(checkGraceDraft(TARGET, draft("10"), false), { ok: false, problem: { field: "value", problem: "SAME_VALUE" } });
  assert.deepEqual(checkGraceDraft(TARGET, draft(""), false), { ok: false, problem: { field: "value", problem: "REQUIRED" } });
  assert.deepEqual(checkGraceDraft(TARGET, draft("241"), false), { ok: false, problem: { field: "value", problem: "OUT_OF_RANGE" } });
  assert.deepEqual(checkGraceDraft(TARGET, draft("7.5"), false), { ok: false, problem: { field: "value", problem: "NOT_WHOLE_NUMBER" } });
  assert.deepEqual(checkGraceDraft(TARGET, draft("30", "   "), true), { ok: false, problem: { field: "reason", problem: "REQUIRED" } }, "after the server asked");
  assert.deepEqual(checkGraceDraft(TARGET, draft("30", "Bus strike."), true), { ok: true, graceMinutes: 30, reason: "Bus strike." });
  assert.deepEqual(checkGraceDraft(TARGET, draft("30", "x".repeat(501)), false), { ok: false, problem: { field: "reason", problem: "TOO_LONG" } });
});

// ======================================================================================
// 3. Request helper and controller (real helper over a fake fetch)
// ======================================================================================

type Call = { url: string; init?: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const OK = (data: Partial<GraceResponse> = {}) =>
  json(200, { success: true, data: { lectureId: "L 1", graceMinutes: 30, registerVersion: 4, changed: true, registerCreated: false, recalculatedCount: 3, ...data } });
const FAIL = (status: number, code: string) => json(status, { success: false, error: { code, message: "server wording" } });

test("request helper: POST to the encoded grace route; body { graceMinutes, expectedVersion, reason trimmed / null }; the signal passed", async () => {
  const calls: Call[] = [];
  const abort = new AbortController();
  const result = await submitRegisterGrace("L 1/x", { graceMinutes: 30, expectedVersion: 3, reason: "  Bus.  " }, { signal: abort.signal, fetchImpl: async (url, init) => { calls.push({ url, init }); return OK(); } });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "/api/lectures/L%201%2Fx/attendance/grace");
  assert.deepEqual([calls[0].init?.method, calls[0].init?.credentials, calls[0].init?.cache, calls[0].init?.signal], ["POST", "same-origin", "no-store", abort.signal]);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { graceMinutes: 30, expectedVersion: 3, reason: "Bus." });
  await submitRegisterGrace("L1", { graceMinutes: 0, expectedVersion: 0, reason: "   " }, { fetchImpl: async (url, init) => { calls.push({ url, init }); return OK(); } });
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { graceMinutes: 0, expectedVersion: 0, reason: null });
});

function harness(handler: (call: Call) => Response | Promise<Response>, refreshResult = true) {
  const calls: Call[] = [];
  const states: GraceUiState[] = [];
  let refreshes = 0;
  const controller = createGraceController({
    lectureId: "L1",
    onChange: (s) => states.push(s),
    refresh: async () => {
      refreshes += 1;
      return refreshResult;
    },
    submit: (lectureId, request, opts) =>
      submitRegisterGrace(lectureId, request, { ...opts, fetchImpl: async (url, init) => { calls.push({ url, init }); return handler({ url, init }); } }),
  });
  return { controller, calls, states, refreshes: () => refreshes, last: () => states.at(-1)! };
}

test("success: the loaded version is sent; the register (and so its history) is refreshed; the count is reported only for an effective change", async () => {
  const h = harness(() => OK());
  await h.controller.submit({ graceMinutes: 30, expectedVersion: 3, reason: null });
  assert.equal(JSON.parse(String(h.calls[0].init?.body)).expectedVersion, 3);
  assert.equal(h.refreshes(), 1);
  const last = h.last();
  assert.equal(last.phase === "succeeded" && last.refresh, "done");
  if (last.phase === "succeeded") assert.equal(graceResultMessage(last.result), "Grace period changed to 30 minutes. 3 attendance records were recalculated.");
  assert.equal(graceResultMessage({ lectureId: "L1", graceMinutes: 15, registerVersion: 2, changed: true, registerCreated: true, recalculatedCount: 1 }), "Grace period changed to 15 minutes. 1 attendance record was recalculated.");
  assert.equal(graceResultMessage({ lectureId: "L1", graceMinutes: 15, registerVersion: 2, changed: true, registerCreated: false, recalculatedCount: 0 }), "Grace period changed to 15 minutes. No attendance record needed recalculation.");
});

test("no-op answer: refreshed, and the message never claims a recalculation", async () => {
  const h = harness(() => OK({ changed: false, graceMinutes: 10, registerVersion: 0, recalculatedCount: 0 }));
  await h.controller.submit({ graceMinutes: 10, expectedVersion: 0 });
  const last = h.last();
  assert.equal(last.phase, "succeeded");
  if (last.phase === "succeeded") {
    const message = graceResultMessage(last.result);
    assert.match(message, /already 10 minutes\. Nothing was changed\./);
    assert.doesNotMatch(message, /recalculat/i);
  }
});

test("reason required (400): no refresh; the state asks for a reason; an explicit resubmission with one is sent", async () => {
  let n = 0;
  const h = harness(() => (++n === 1 ? FAIL(400, "ATTENDANCE_REASON_REQUIRED") : OK()));
  await h.controller.submit({ graceMinutes: 30, expectedVersion: 3 });
  const failed = h.last();
  assert.deepEqual(failed.phase === "failed" && [failed.reasonRequired, failed.mustReopen, failed.refresh], [true, false, "skipped"]);
  assert.equal(h.refreshes(), 0);
  await tick();
  assert.equal(h.calls.length, 1, "nothing is resubmitted automatically");
  await h.controller.submit({ graceMinutes: 30, expectedVersion: 3, reason: "Late bus." });
  assert.deepEqual(h.calls.map((c) => JSON.parse(String(c.init?.body)).reason), [null, "Late bus."]);
  assert.equal(h.last().phase, "succeeded");
});

test("409s: register changed / finalized / lecture cancelled → refresh, this change is over (no retry); busy → no refresh, retryable", async () => {
  for (const code of ["ATTENDANCE_REGISTER_CHANGED", "ATTENDANCE_REGISTER_FINALIZED", "LECTURE_CANCELLED"]) {
    const h = harness(() => FAIL(409, code));
    await h.controller.submit({ graceMinutes: 30, expectedVersion: 3, reason: "x" });
    await tick();
    const last = h.last();
    assert.deepEqual(last.phase === "failed" && [last.mustReopen, last.refresh, last.error.message], [true, "done", attendanceErrorMessage(code)], code);
    assert.equal(h.refreshes(), 1, code);
    assert.equal(h.calls.length, 1, `${code}: no automatic retry`);
  }
  const busy = harness(() => FAIL(409, "ATTENDANCE_BUSY"));
  await busy.controller.submit({ graceMinutes: 30, expectedVersion: 3 });
  const last = busy.last();
  assert.deepEqual(last.phase === "failed" && [last.mustReopen, last.refresh, last.error.message], [false, "skipped", attendanceErrorMessage("ATTENDANCE_BUSY")]);
  assert.equal(busy.refreshes(), 0);
  assert.equal(graceErrorNeedsReopen({ ok: false, status: 409, code: "ATTENDANCE_BUSY", message: "" }), false);
  // A 5xx shows our message, never the server's text.
  const server = harness(() => json(500, { success: false, error: { code: "INTERNAL_SERVER_ERROR", message: "stack at db.ts" } }));
  await server.controller.submit({ graceMinutes: 30, expectedVersion: 3 });
  const s = server.last();
  assert.equal(s.phase === "failed" && s.error.message, attendanceErrorMessage("INTERNAL_SERVER_ERROR"));
});

test("a failed refresh is reported; the controller is free again (the shown register is kept by the panel's loader)", async () => {
  const h = harness(() => OK(), false);
  await h.controller.submit({ graceMinutes: 30, expectedVersion: 3 });
  assert.equal(h.last().phase === "succeeded" && (h.last() as { refresh: string }).refresh, "failed");
  assert.equal(h.controller.isBusy(), false);
});

test("double submission prevented: a second submit while one is in flight (or refreshing) sends nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness(async () => { await gate; return OK(); });
  const first = h.controller.submit({ graceMinutes: 30, expectedVersion: 3 });
  await tick();
  // Fail fast: a refused submit settles at once, and sends nothing synchronously.
  const second = h.controller.submit({ graceMinutes: 31, expectedVersion: 3 });
  assert.equal(h.calls.length, 1, "no second request");
  let settled: boolean | "PENDING" = "PENDING";
  void second.then((v) => { settled = v; });
  for (let i = 0; i < 20 && settled === "PENDING"; i += 1) await tick();
  assert.equal(settled, false);
  assert.equal(h.controller.reset(), false, "cannot be reset while busy");
  release();
  await first;
  assert.equal(h.calls.length, 1);
});

test("cleanup: dispose aborts the request and ignores its late answer (no state, no refresh)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let signal: AbortSignal | null | undefined;
  const h = harness(async ({ init }) => { signal = init?.signal; await gate; return OK(); });
  const run = h.controller.submit({ graceMinutes: 30, expectedVersion: 3 });
  await tick();
  const count = h.states.length;
  h.controller.dispose();
  assert.equal(signal?.aborted, true);
  release();
  await run;
  assert.equal(h.states.length, count);
  assert.equal(h.refreshes(), 0);
  assert.equal(await h.controller.submit({ graceMinutes: 30, expectedVersion: 3 }), false);
});

// ======================================================================================
// 4. The dialog
// ======================================================================================

function dialog(state: GraceUiState, extra: Partial<Parameters<typeof GraceDialog>[0]> = {}) {
  return renderToStaticMarkup(
    <GraceDialog target={TARGET} draft={draft("30")} step="edit" problem={null} reasonRequired={false} state={state} onValueChange={noop} onReasonChange={noop} onContinue={noop} onBack={noop} onConfirm={noop} onClose={noop} {...extra} />
  );
}
const failed = (code: string, extra: Partial<Extract<GraceUiState, { phase: "failed" }>> = {}): GraceUiState => ({
  phase: "failed", error: { ok: false, status: 409, code, message: attendanceErrorMessage(code) }, reasonRequired: false, mustReopen: graceErrorNeedsReopen({ ok: false, status: 409, code, message: "" }), refresh: "done", ...extra,
});

test("dialog: accessible modal with the current value, labelled inputs, optional reason, Cancel first; closed renders nothing", () => {
  assert.equal(renderToStaticMarkup(<GraceDialog target={null} draft={draft("")} step="edit" problem={null} reasonRequired={false} state={{ phase: "idle" }} onValueChange={noop} onReasonChange={noop} onContinue={noop} onBack={noop} onConfirm={noop} onClose={noop} />), "");
  const html = dialog({ phase: "idle" });
  assert.match(html, /^<div data-dialog-overlay="true" class="fixed inset-0 z-50 flex items-end justify-center[^"]*sm:items-center/, "a bottom sheet on phones");
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="grace-dialog-title" aria-describedby="grace-dialog-description"/);
  assert.match(text(html), /Change the grace period Kinematics/);
  assert.match(text(html), /Current grace period: 10 minutes/);
  assert.match(html, /<label for="grace-minutes"[^>]*>New grace period \(minutes\)<\/label>/);
  assert.match(html, /id="grace-minutes" type="number" inputMode="numeric" min="0" max="240" step="1"/);
  assert.match(html, /<label for="grace-reason"[^>]*>Reason \(optional\)<\/label>/);
  assert.match(html, /aria-required="false"/);
  assert.match(html, /<button type="button"[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
  assert.doesNotMatch(html, /\binert\b/);
});

test("dialog: validation errors are announced on the right field; the reason becomes required after the server asked", () => {
  const value = dialog({ phase: "idle" }, { problem: { field: "value", problem: "OUT_OF_RANGE" } });
  assert.match(value, /id="grace-minutes"[^>]*aria-invalid="true"[^>]*aria-describedby="grace-minutes-help grace-minutes-error"/);
  assert.match(text(value), /from 0 to 240 minutes/);
  assert.match(text(dialog({ phase: "idle" }, { problem: { field: "value", problem: "SAME_VALUE" } })), /different from the current one/);
  const reason = dialog(failed("ATTENDANCE_REASON_REQUIRED", { reasonRequired: true, mustReopen: false, refresh: "skipped" }), { reasonRequired: true, problem: { field: "reason", problem: "REQUIRED" } });
  assert.match(reason, /Reason \(required\)/);
  assert.match(reason, /aria-required="true"/);
  assert.match(reason, /id="grace-reason"[^>]*aria-invalid="true"/);
  assert.match(text(reason), /A reason is required/);
  assert.match(text(reason), /Enter a reason and confirm again/);
  assert.match(reason, />Continue<\/button>/, "the teacher can resubmit");
});

test("dialog: explicit confirmation summary; busy disables everything and shows Saving", () => {
  const confirm = dialog({ phase: "idle" }, { step: "confirm", draft: draft("30", " Bus. ") });
  assert.match(text(confirm), /Change the grace period from 10 minutes to 30 minutes \?/);
  assert.match(text(confirm), /Reason: Bus\./);
  assert.match(confirm, />Confirm change<\/button>/);
  assert.doesNotMatch(confirm, /id="grace-minutes"/);
  const busy = dialog({ phase: "submitting" }, { step: "confirm" });
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /Saving…/);
  assert.equal((busy.match(/<button type="button"[^>]*disabled=""/g) ?? []).length, 3);
  assert.equal(graceBusy({ phase: "succeeded", result: { lectureId: "L", graceMinutes: 1, registerVersion: 1, changed: true, registerCreated: false, recalculatedCount: 0 }, refresh: "pending" }), true);
});

test("dialog: register changed / finalized / cancelled → explained, refreshed, only Close; busy → safe message and Try again", () => {
  for (const [code, title] of [["ATTENDANCE_REGISTER_CHANGED", "The attendance register changed"], ["ATTENDANCE_REGISTER_FINALIZED", "Finalized attendance cannot be changed"], ["LECTURE_CANCELLED", "This lecture is cancelled"]] as const) {
    const html = dialog(failed(code), { step: "confirm" });
    assert.match(text(html), new RegExp(title), code);
    assert.match(text(html), /has been refreshed/, code);
    assert.doesNotMatch(html, /Confirm change|Try again/, code);
    assert.match(html, /data-autofocus="true"[^>]*>Close<\/button>/, code);
  }
  assert.match(text(dialog(failed("ATTENDANCE_REGISTER_CHANGED"), { step: "confirm" })), /Refresh the register/i);
  const busy = dialog(failed("ATTENDANCE_BUSY", { mustReopen: false, refresh: "skipped" }), { step: "confirm" });
  assert.match(text(busy), /Attendance is busy/);
  assert.match(text(busy), new RegExp(attendanceErrorMessage("ATTENDANCE_BUSY").replace(/[.]/g, "\\.")));
  assert.match(busy, />Try again<\/button>/);
});

// ======================================================================================
// 5. The register's display and action
// ======================================================================================

type Found = ReactElement<Record<string, unknown>>;
function walk(node: ReactNode, out: Found[]) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as Found;
  out.push(element);
  if (typeof element.type === "function" && /^(GraceAction|Detail)$/.test((element.type as { name?: string }).name ?? "")) {
    walk((element.type as (p: unknown) => ReactNode)(element.props), out);
  }
  walk(element.props.children as ReactNode, out);
}

test("register: the grace is shown; Change only for an open, not-cancelled register (and only with the callback); it opens the dialog", () => {
  let opened = 0;
  const tree = RegisterView({ register: registerOf({ graceMinutes: 15 }), filters: DEFAULT_REGISTER_FILTERS, onFiltersChange: noop, onChangeGrace: () => { opened += 1; } });
  const found: Found[] = [];
  walk(tree, found);
  const button = found.find((e) => e.props.id === GRACE_ACTION_ID);
  assert.ok(button);
  (button.props.onClick as () => void)();
  assert.equal(opened, 1);

  const html = renderToStaticMarkup(<RegisterView register={registerOf({ graceMinutes: 15 })} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={noop} onChangeGrace={noop} />);
  assert.match(text(html), /Grace period 15 minutes Change grace period/);
  assert.match(html, new RegExp(`<dl id="${REGISTER_SCHEDULE_ID}" tabindex="-1"`), "the focus fallback exists");
  for (const register of [registerOf({ finalized: true }), registerOf({ classStatus: "CANCELLED" })]) {
    const hidden = renderToStaticMarkup(<RegisterView register={register} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={noop} onChangeGrace={noop} />);
    assert.doesNotMatch(hidden, new RegExp(`id="${GRACE_ACTION_ID}"`));
    assert.match(text(hidden), /Grace period 10 minutes/, "the value is still shown");
  }
  assert.doesNotMatch(renderToStaticMarkup(<RegisterView register={registerOf()} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={noop} />), /Change/);
  assert.equal(renderToStaticMarkup(<GraceAction register={registerOf({ finalized: true })} onOpen={noop} />), "");
});

// ======================================================================================
// 6. Wiring (source)
// ======================================================================================

test("wiring: the shared modal hook; one controller without the register lock; the snapshot's version; reason-required handling; disposal", () => {
  const dlg = source("components", "attendance", "grace-dialog.tsx");
  assert.match(dlg, /useModalDialog\(\{ open, dialogRef, overlayRef, canClose: \(\) => !busy, onClose, fallbackId: REGISTER_SCHEDULE_ID \}\)/);
  assert.doesNotMatch(dlg, /createDialogFocusManager|makeOutsideInert/, "no duplicated accessibility utilities");

  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  assert.equal((panel.match(/createGraceController\(/g) ?? []).length, 1);
  const block = panel.slice(panel.indexOf("const controller = createGraceController({"), panel.indexOf("graceController.current = controller;"));
  assert.doesNotMatch(block, /\block\b/, "no reconciliation / finalization lock");
  assert.match(block, /refresh: \(\) => load\("refresh"\)/, "success refreshes the register (its history follows the version)");
  assert.match(panel, /controller\.dispose\(\);\s*if \(graceController\.current === controller\) graceController\.current = null;/);
  assert.match(panel, /expectedVersion: graceTarget\.expectedVersion, reason: check\.reason \}/, "exactly the snapshot's version");
  assert.match(panel, /if \(next\.phase === "failed" && next\.reasonRequired\) \{\s*\/\/[^\n]*\n\s*setGraceReasonRequired\(true\);\s*setGraceStep\("edit"\);/);
  assert.match(panel, /onChangeGrace=\{openGrace\}/);
  assert.match(panel, /<RegisterHistorySection lectureId=\{lectureId\} registerVersion=\{state\.register\.register\.version\} \/>/, "the history reloads when the version changes");
  // Decisions, reviews, reconciliation and finalization are unchanged.
  assert.equal((panel.match(/createRecordActionController\(/g) ?? []).length, 1);
  assert.match(panel, /const lock = createActionLock\(\);\s*const controller = createReconcileController\(\{\s*lectureId,\s*lock,/);
});
