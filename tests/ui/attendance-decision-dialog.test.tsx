/**
 * Stage 5.6d: the teacher's manual attendance decision UI —
 * components/attendance/decision-dialog.tsx (row action, dialog, pure
 * helpers), components/attendance/use-modal-dialog.ts (the shared modal
 * behaviour) and the register panel's wiring. Views render with
 * react-dom/server; the row actions are clicked by walking RegisterView's
 * element tree (it has no hooks) and calling the real handlers; the modal
 * behaviour runs against fake DOM nodes; the request flow uses the real
 * controller and helper over a fake fetch. No browser: clicking through the
 * real page remains a manual check.
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
  submitAttendanceDecision,
  type AttendanceRegisterResponse,
  type TeacherAttendanceStatus,
} from "../../components/attendance/attendance-ui";
import {
  checkDecisionDraft,
  DecisionAction,
  DecisionDialog,
  decisionAvailability,
  decisionBusy,
  decisionNeedsReopen,
  decisionReasonExplanation,
  decisionRequirement,
  decisionStatusOptions,
  decisionTargetOf,
  REGISTER_STUDENTS_ID,
  type DecisionDraft,
  type DecisionTarget,
} from "../../components/attendance/decision-dialog";
import { DEFAULT_REGISTER_FILTERS, RegisterView } from "../../components/attendance/lecture-attendance-register-panel";
import { createRecordActionController, type RecordActionUiState } from "../../components/attendance/record-action-controller";
import { createActionLock } from "../../components/attendance/reconciliation-controller";
import { activateModalDialog } from "../../components/attendance/use-modal-dialog";
import type { FocusKeyEvent } from "../../components/attendance/dialog-focus";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---- Fixtures ----------------------------------------------------------------------------------

type Student = AttendanceRegisterResponse["students"][number];

const record = (status: string, version: number, extra: Partial<NonNullable<Student["record"]>> = {}): NonNullable<Student["record"]> => ({
  status, statusSource: "AUTO", autoStatus: status === "PRESENT" || status === "LATE" ? status : null, teacherStatus: null,
  firstOnlineAt: "2026-09-01T12:31:00.000Z", firstQrAt: null, teacherDecidedAt: null, version, ...extra,
});
const eligible = { outcome: "ELIGIBLE" as const, reason: "ELIGIBLE", approvalReason: null };
const student = (studentId: string, fields: Partial<Student> = {}): Student => ({
  studentId, name: `Name ${studentId}`, registrationNumber: `REG-${studentId}`, eligibility: eligible, absenceDecision: null,
  record: null, review: { pending: false, since: null }, ...fields,
});

function registerOf(students: Student[], { finalized = false, classStatus = "COMPLETED" } = {}): AttendanceRegisterResponse {
  return {
    lecture: { id: "L1", classId: "C1", title: "Kinematics", classStatus, date: "2026-09-01T12:30:00.000Z", endDate: "2026-09-01T14:30:00.000Z" },
    register: {
      lectureId: "L1", exists: true, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: "2026-09-01T14:30:00.000Z", graceMinutes: 10,
      version: 3, finalized, finalizedAt: finalized ? "2026-09-01T15:00:00.000Z" : null,
    },
    configuration: { approval: "OK", evidence: "OK" },
    classification: "LIVE",
    students,
    summary: { students: students.length, withRecord: students.filter((s) => s.record).length, recordStatus: { PRESENT: 1, LATE: 1, ABSENT: 1, EXCUSED: 1 }, pendingReviews: 1 },
    absencePreview: null,
    onlineEvidence: null,
    activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "LECTURE_COMPLETED" }, configured: true },
  } as AttendanceRegisterResponse;
}

const STUDENTS: Student[] = [
  student("s-none"),
  student("s-present", { record: record("PRESENT", 4) }),
  student("s-late", { record: record("LATE", 2) }),
  student("s-absent", { record: record("ABSENT", 7, { statusSource: "FINALIZATION" }) }),
  student("s-excused", { record: record("EXCUSED", 3, { statusSource: "TEACHER", teacherStatus: "EXCUSED", teacherDecidedAt: "2026-09-01T13:00:00.000Z" }), review: { pending: true, since: "2026-09-01T13:30:00.000Z" } }),
  student("s-inactive", { eligibility: { outcome: "NOT_ELIGIBLE", reason: "STUDENT_INACTIVE", approvalReason: null } }),
  student("s-foreign", { name: null, registrationNumber: null, record: record("PRESENT", 1) }),
];

// ---- Element-tree walking (RegisterView and DecisionAction have no hooks) -----------------------------

type Found = { element: ReactElement<Record<string, unknown>>; layout: string | null };

function walk(node: ReactNode, layout: string | null, out: Found[]) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, layout, out);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<Record<string, unknown>>;
  const props = element.props;
  const nextLayout = typeof props["data-layout"] === "string" ? (props["data-layout"] as string) : layout;
  out.push({ element, layout: nextLayout });
  if (typeof element.type === "function") {
    // Expand our own hook-free components (DecisionAction, cells); never library components.
    const name = (element.type as { name?: string }).name ?? "";
    if (/^(DecisionAction|StatusCell|EvidenceCell|EligibilityCell|ReviewCell|Detail|Badge|EmptyState|SummaryCard)$/.test(name)) {
      walk((element.type as (p: unknown) => ReactNode)(props), nextLayout, out);
    }
  }
  walk(props.children as ReactNode, nextLayout, out);
}

function decisionButtons(register: AttendanceRegisterResponse, onChangeStatus?: (s: Student) => void) {
  const tree = RegisterView({ register, filters: DEFAULT_REGISTER_FILTERS, onFiltersChange: () => {}, onChangeStatus });
  const found: Found[] = [];
  walk(tree, null, found);
  return found.filter((f) => typeof f.element.props["data-decision-action"] === "string");
}

// ======================================================================================
// 1. Pure helpers
// ======================================================================================

test("status options: every status except the current one (all four current statuses and no record)", () => {
  const all: TeacherAttendanceStatus[] = ["PRESENT", "LATE", "ABSENT", "EXCUSED"];
  for (const current of all) {
    const options = decisionStatusOptions(current);
    assert.deepEqual(options, all.filter((s) => s !== current), current);
    assert.ok(!options.includes(current), `${current} is never offered`);
  }
  assert.deepEqual(decisionStatusOptions(null), all, "no record: all four");
});

test("target snapshot: current status, source, the record's exact version (null without one), finalized", () => {
  const reg = registerOf(STUDENTS);
  assert.deepEqual(decisionTargetOf(STUDENTS[1], reg), {
    studentId: "s-present", name: "Name s-present", registrationNumber: "REG-s-present", currentStatus: "PRESENT", currentSource: "AUTO", record: { version: 4 }, finalized: false,
  });
  assert.deepEqual(decisionTargetOf(STUDENTS[0], reg).record, null);
  assert.equal(decisionTargetOf(STUDENTS[0], registerOf(STUDENTS, { finalized: true })).finalized, true);
});

test("availability: offered only where the server would accept it (cancelled lecture, foreign, inactive, unknown status refused)", () => {
  const reg = registerOf(STUDENTS);
  for (const s of STUDENTS.slice(0, 5)) assert.deepEqual(decisionAvailability(s, reg), { allowed: true, reason: null }, s.studentId);
  assert.equal(decisionAvailability(STUDENTS[5], reg).allowed, false, "inactive");
  assert.equal(decisionAvailability(STUDENTS[6], reg).allowed, false, "another teacher's student");
  assert.equal(decisionAvailability(student("x", { record: record("WEIRD", 1) }), reg).allowed, false, "unknown status");
  const cancelled = registerOf(STUDENTS, { classStatus: "CANCELLED" });
  assert.deepEqual(decisionAvailability(STUDENTS[0], cancelled), { allowed: false, reason: "This lecture is cancelled." });
  // Finalized registers still allow decisions (with a reason).
  assert.equal(decisionAvailability(STUDENTS[1], registerOf(STUDENTS, { finalized: true })).allowed, true);
});

const target = (fields: Partial<DecisionTarget> = {}): DecisionTarget => ({
  studentId: "s1", name: "Asha", registrationNumber: "REG-1", currentStatus: null, currentSource: null, record: null, finalized: false, ...fields,
});
const draft = (status: TeacherAttendanceStatus | null, reason = ""): DecisionDraft => ({ status, reason });

test("reason rules: existing record required; first mark open optional; first mark finalized required; with explanations", () => {
  const existing = target({ currentStatus: "PRESENT", currentSource: "AUTO", record: { version: 4 } });
  assert.equal(decisionRequirement(existing), "REQUIRED");
  assert.deepEqual(checkDecisionDraft(existing, draft("ABSENT")), { ok: false, problem: "REQUIRED" });
  assert.match(decisionReasonExplanation(existing), /required.*replaces/i);

  const first = target();
  assert.equal(decisionRequirement(first), "OPTIONAL");
  assert.deepEqual(checkDecisionDraft(first, draft("PRESENT")), { ok: true, status: "PRESENT", reason: null });
  assert.match(decisionReasonExplanation(first), /optional/i);

  const finalizedFirst = target({ finalized: true });
  assert.equal(decisionRequirement(finalizedFirst), "REQUIRED");
  assert.deepEqual(checkDecisionDraft(finalizedFirst, draft("EXCUSED")), { ok: false, problem: "REQUIRED" });
  assert.match(decisionReasonExplanation(finalizedFirst), /finalized/i);
  assert.match(decisionReasonExplanation(target({ finalized: true, record: { version: 2 }, currentStatus: "ABSENT" })), /finalized/i);
});

test("draft: a status is required and must differ from the current one; blank / whitespace reasons; trimming; 500 characters", () => {
  const existing = target({ currentStatus: "LATE", record: { version: 2 } });
  assert.deepEqual(checkDecisionDraft(existing, draft(null, "x")), { ok: false, problem: "STATUS_REQUIRED" });
  assert.deepEqual(checkDecisionDraft(existing, draft("LATE", "Confirmed.")), { ok: false, problem: "SAME_STATUS" }, "no same-status action");
  assert.deepEqual(checkDecisionDraft(existing, draft("PRESENT", "")), { ok: false, problem: "REQUIRED" });
  assert.deepEqual(checkDecisionDraft(existing, draft("PRESENT", "   \n\t ")), { ok: false, problem: "REQUIRED" });
  assert.deepEqual(checkDecisionDraft(existing, draft("PRESENT", "  Arrived on time.  ")), { ok: true, status: "PRESENT", reason: "Arrived on time." });
  assert.deepEqual(checkDecisionDraft(target(), draft("LATE", "   ")), { ok: true, status: "LATE", reason: null }, "optional: blank is none");
  const max = "r".repeat(500);
  assert.deepEqual(checkDecisionDraft(existing, draft("ABSENT", `  ${max}  `)), { ok: true, status: "ABSENT", reason: max });
  assert.deepEqual(checkDecisionDraft(existing, draft("ABSENT", `${max}r`)), { ok: false, problem: "TOO_LONG" });
});

test("busy and reopen states follow the controller's phases", () => {
  const err = { ok: false as const, status: 409, code: "ATTENDANCE_RECORD_CHANGED", message: "m" };
  assert.equal(decisionBusy({ phase: "idle" }), false);
  assert.equal(decisionBusy({ phase: "submitting", kind: "decision", studentId: "s1" }), true);
  assert.equal(decisionBusy({ phase: "failed", kind: "decision", studentId: "s1", error: err, stale: true, cancelled: false, refresh: "pending" }), true);
  assert.equal(decisionBusy({ phase: "failed", kind: "decision", studentId: "s1", error: err, stale: true, cancelled: false, refresh: "done" }), false);
  assert.equal(decisionNeedsReopen({ phase: "failed", kind: "decision", studentId: "s1", error: err, stale: true, cancelled: false, refresh: "done" }), true);
  assert.equal(decisionNeedsReopen({ phase: "failed", kind: "decision", studentId: "s1", error: { ...err, status: 500, code: "INTERNAL_SERVER_ERROR" }, stale: false, cancelled: false, refresh: "skipped" }), false);
});

// ======================================================================================
// 2. Both layouts
// ======================================================================================

test("the action opens the dialog from the desktop table and from the mobile card (the real handlers, the right student)", () => {
  const reg = registerOf(STUDENTS);
  const opened: string[] = [];
  const buttons = decisionButtons(reg, (s) => opened.push(s.studentId));
  const table = buttons.filter((b) => b.layout === "table");
  const cards = buttons.filter((b) => b.layout === "cards");
  assert.ok(table.length > 0 && cards.length > 0);
  (table.find((b) => b.element.props["data-decision-action"] === "s-late")!.element.props.onClick as () => void)();
  (cards.find((b) => b.element.props["data-decision-action"] === "s-excused")!.element.props.onClick as () => void)();
  assert.deepEqual(opened, ["s-late", "s-excused"]);
});

test("desktop and mobile expose equivalent actions: the same students, the same unavailable notes; every field kept", () => {
  const reg = registerOf(STUDENTS);
  const buttons = decisionButtons(reg, () => {});
  const ids = (layout: string) => buttons.filter((b) => b.layout === layout).map((b) => b.element.props["data-decision-action"]);
  assert.deepEqual(ids("table"), ["s-none", "s-present", "s-late", "s-absent", "s-excused"]);
  assert.deepEqual(ids("cards"), ids("table"));

  const html = renderToStaticMarkup(<RegisterView register={reg} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={() => {}} onChangeStatus={() => {}} />);
  const tablePart = html.slice(html.indexOf('data-layout="table"'), html.indexOf('data-layout="cards"'));
  const cardPart = html.slice(html.indexOf('data-layout="cards"'));
  for (const part of [tablePart, cardPart]) {
    assert.equal((part.match(/Change status/g) ?? []).length, 5);
    assert.ok(text(part).includes("This student is inactive."));
    assert.ok(text(part).includes("Not one of your students."));
    // Existing evidence and review information is still shown.
    assert.ok(text(part).includes("Pending review since"));
    assert.ok(text(part).includes("Online"));
    assert.ok(text(part).includes("Finalization (automatic absence)"));
  }
  assert.match(html, /<th class="px-3 py-2">Actions<\/th>/);
  assert.match(html, /sr-only">: Name s-late</, "each action names its student for screen readers");
  assert.match(html, new RegExp(`id="${REGISTER_STUDENTS_ID}" tabindex="-1"`), "the focus fallback exists");
  // Without the callback (read-only use), nothing changes: no column, no actions.
  const readOnly = renderToStaticMarkup(<RegisterView register={reg} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={() => {}} />);
  assert.doesNotMatch(readOnly, /Change status|>Actions</);
  assert.equal(decisionButtons(registerOf(STUDENTS, { classStatus: "CANCELLED" }), () => {}).length, 0, "no action on a cancelled lecture");
});

test("the row action renders as a note (never a button) where the decision is unavailable", () => {
  const reg = registerOf(STUDENTS);
  const inactive = renderToStaticMarkup(<DecisionAction student={STUDENTS[5]} register={reg} onOpen={() => {}} />);
  assert.doesNotMatch(inactive, /<button/);
  assert.match(renderToStaticMarkup(<DecisionAction student={STUDENTS[0]} register={reg} onOpen={() => {}} />), /<button type="button" data-decision-action="s-none"/);
});

// ======================================================================================
// 3. The dialog
// ======================================================================================

const noop = () => {};
function dialog(t: DecisionTarget | null, d: DecisionDraft, extra: Partial<Parameters<typeof DecisionDialog>[0]> = {}) {
  return renderToStaticMarkup(
    <DecisionDialog target={t} draft={d} step="edit" problem={null} action={{ phase: "idle" }} onStatusChange={noop} onReasonChange={noop} onContinue={noop} onBack={noop} onConfirm={noop} onClose={noop} {...extra} />
  );
}

test("dialog: closed renders nothing; accessible modal; current status shown; the current status is never a choice", () => {
  assert.equal(dialog(null, draft(null)), "");
  for (const current of ["PRESENT", "LATE", "ABSENT", "EXCUSED"] as TeacherAttendanceStatus[]) {
    const html = dialog(target({ currentStatus: current, currentSource: "AUTO", record: { version: 3 } }), draft(null));
    assert.match(html, /^<div data-dialog-overlay="true"/);
    assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="decision-dialog-title" aria-describedby="decision-dialog-description"/);
    assert.match(html, /tabindex="-1"/);
    const radios = [...html.matchAll(/type="radio" name="decision-status" value="([A-Z]+)"/g)].map((m) => m[1]);
    assert.equal(radios.length, 3, current);
    assert.ok(!radios.includes(current), `${current} is not offered`);
    assert.match(text(html), new RegExp(`Current status: ${current.charAt(0)}${current.slice(1).toLowerCase()}`));
  }
  const first = dialog(target(), draft(null));
  assert.equal([...first.matchAll(/type="radio"/g)].length, 4, "no record: all four");
  assert.match(text(first), /Current status: No record/);
  assert.match(first, /<legend[^>]*>New status<\/legend>/);
  assert.match(first, /<label for="decision-reason"[^>]*>Reason \(optional\)<\/label>/);
  assert.match(first, /<button type="button"[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/, "Cancel gets the initial focus");
  assert.doesNotMatch(first, /\binert\b/);
});

test("dialog: reason required / optional with the explanation; validation errors are announced and linked", () => {
  const existing = target({ currentStatus: "PRESENT", currentSource: "AUTO", record: { version: 4 } });
  const html = dialog(existing, draft("ABSENT", "  "), { problem: "REQUIRED" });
  assert.match(html, /Reason \(required\)/);
  assert.match(html, /aria-required="true"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="decision-reason-help decision-reason-error"/);
  assert.match(text(html), /A reason is required: this replaces the student's recorded status\./);
  assert.match(html, /id="decision-reason-error"[^>]*>Enter a reason for this change\./);
  assert.match(text(dialog(existing, draft("ABSENT", "x".repeat(501)), { problem: "TOO_LONG" })), /at most 500 characters/);
  assert.match(text(dialog(existing, draft(null), { problem: "STATUS_REQUIRED" })), /Choose the new attendance status\./);
  assert.match(text(dialog(existing, draft("ABSENT", "  Left early.  "))), /\(11 used;/, "the counter counts the trimmed reason");

  const finalized = dialog(target({ finalized: true }), draft(null));
  assert.match(finalized, /Reason \(required\)/);
  assert.match(text(finalized), /This register is finalized/);
});

test("dialog: explicit confirmation step summarises the change; Back / Confirm change; busy disables everything", () => {
  const existing = target({ currentStatus: "PRESENT", currentSource: "AUTO", record: { version: 4 } });
  const confirm = dialog(existing, draft("ABSENT", " Left early. "), { step: "confirm" });
  assert.match(text(confirm), /Change Asha from Present to Absent ?\?/);
  assert.match(text(confirm), /Reason: Left early\./);
  assert.match(confirm, />Confirm change<\/button>/);
  assert.match(confirm, /data-autofocus="true"[^>]*>.*Back<\/button>/);
  assert.doesNotMatch(confirm, /type="radio"/, "the choice is fixed while confirming");

  const busy = dialog(existing, draft("ABSENT", "x"), { step: "confirm", action: { phase: "submitting", kind: "decision", studentId: "s1" } });
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /Saving…/);
  assert.equal((busy.match(/<button type="button"[^>]*disabled=""/g) ?? []).length, 3, "Close, Back and Confirm are all disabled");
});

test("dialog: a failed request shows a safe message (never server text); non-409 allows a manual Try again", () => {
  const existing = target({ currentStatus: "PRESENT", record: { version: 4 } });
  const html = dialog(existing, draft("ABSENT", "x"), {
    step: "confirm",
    action: { phase: "failed", kind: "decision", studentId: "s1", error: { ok: false, status: 500, code: "INTERNAL_SERVER_ERROR", message: attendanceErrorMessage("INTERNAL_SERVER_ERROR") }, stale: false, cancelled: false, refresh: "skipped" },
  });
  assert.match(html, /role="alert"/);
  assert.match(text(html), /The change was not saved/);
  assert.match(text(html), /Something went wrong on the server/);
  assert.match(html, />Try again<\/button>/);
});

test("dialog: after a 409 the record changed — refreshed, explained, and only Close is offered (no retry)", () => {
  const existing = target({ currentStatus: "PRESENT", record: { version: 4 } });
  const base = { phase: "failed" as const, kind: "decision" as const, studentId: "s1", error: { ok: false as const, status: 409, code: "ATTENDANCE_RECORD_CHANGED", message: attendanceErrorMessage("ATTENDANCE_RECORD_CHANGED") }, stale: true, cancelled: false };
  const refreshing = dialog(existing, draft("ABSENT", "x"), { step: "confirm", action: { ...base, refresh: "pending" } });
  assert.match(text(refreshing), /Refreshing the register/);
  const done = dialog(existing, draft("ABSENT", "x"), { step: "confirm", action: { ...base, refresh: "done" } });
  assert.match(text(done), /This student's attendance changed/);
  assert.match(text(done), /Refresh the register/i);
  assert.match(text(done), /has been refreshed\. Close this dialog/);
  assert.doesNotMatch(done, /Confirm change|Try again/);
  assert.match(done, /data-autofocus="true"[^>]*>Close<\/button>/);
  const edit = dialog(existing, draft("ABSENT", "x"), { action: { ...base, refresh: "done" } });
  assert.doesNotMatch(edit, />Continue</);
  assert.match(edit, /type="radio"[^>]*disabled=""/);
  assert.match(text(dialog(existing, draft("ABSENT", "x"), { action: { ...base, refresh: "failed" } })), /could not be refreshed\. Reload the page/);
  // Another student's failure is not shown in this dialog.
  assert.doesNotMatch(dialog(existing, draft("ABSENT", "x"), { action: { ...base, studentId: "s2", refresh: "done" } }), /role="alert"/);
});

// ======================================================================================
// 4. The request flow (real controller + real helper over a fake fetch)
// ======================================================================================

type Call = { url: string; init?: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function flow(handler: (call: Call) => Response | Promise<Response>, options: { lock?: ReturnType<typeof createActionLock> } = {}) {
  const calls: Call[] = [];
  const states: RecordActionUiState[] = [];
  let refreshes = 0;
  const controller = createRecordActionController({
    lectureId: "L1",
    lock: options.lock,
    refresh: async () => {
      refreshes += 1;
      return true;
    },
    onChange: (s) => states.push(s),
    decide: (lectureId, studentId, request, opts) =>
      submitAttendanceDecision(lectureId, studentId, request, {
        ...opts,
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return handler({ url, init });
        },
      }),
  });
  /** What the panel does on Confirm: the snapshot's version, the checked draft. */
  const confirm = (t: DecisionTarget, d: DecisionDraft) => {
    const check = checkDecisionDraft(t, d);
    assert.ok(check.ok, JSON.stringify(check));
    if (!check.ok) return Promise.resolve(false);
    return controller.submitDecision({ target: { studentId: t.studentId, record: t.record }, status: check.status, reason: check.reason, finalized: t.finalized });
  };
  return { controller, calls, states, confirm, refreshes: () => refreshes, last: () => states.at(-1)! };
}
const OK = (status: string) => json(200, { success: true, data: { lectureId: "L1", studentId: "s-present", status, statusSource: "TEACHER", teacherStatus: status, autoStatus: "PRESENT", pendingReview: false, version: 5, afterFinalization: false, changed: true } });

test("expectedVersion: exactly the loaded record's version; null without a record; every status sent as chosen", async () => {
  const reg = registerOf(STUDENTS);
  for (const status of ["LATE", "ABSENT", "EXCUSED"] as TeacherAttendanceStatus[]) {
    const f = flow(() => OK(status));
    await f.confirm(decisionTargetOf(STUDENTS[1], reg), draft(status, "Checked."));
    assert.equal(f.calls[0].url, "/api/lectures/L1/attendance/students/s-present/decision");
    assert.deepEqual(JSON.parse(String(f.calls[0].init?.body)), { status, expectedVersion: 4, reason: "Checked." });
  }
  const first = flow(() => OK("PRESENT"));
  await first.confirm(decisionTargetOf(STUDENTS[0], reg), draft("PRESENT"));
  assert.deepEqual(JSON.parse(String(first.calls[0].init?.body)), { status: "PRESENT", expectedVersion: null, reason: null });
  const finalizedFirst = flow(() => OK("ABSENT"));
  await finalizedFirst.confirm(decisionTargetOf(STUDENTS[0], registerOf(STUDENTS, { finalized: true })), draft("ABSENT", "Medical note."));
  assert.deepEqual(JSON.parse(String(finalizedFirst.calls[0].init?.body)), { status: "ABSENT", expectedVersion: null, reason: "Medical note." });
});

test("success: the register is refreshed from the server (the loaded data is not changed locally)", async () => {
  const reg = registerOf(STUDENTS);
  const before = JSON.stringify(reg);
  const f = flow(() => OK("ABSENT"));
  await f.confirm(decisionTargetOf(STUDENTS[1], reg), draft("ABSENT", "Left."));
  assert.equal(f.refreshes(), 1);
  const done = f.last();
  assert.deepEqual([done.phase, done.phase === "succeeded" && done.refresh], ["succeeded", "done"]);
  assert.equal(JSON.stringify(reg), before, "no optimistic change");
});

test("409 RECORD_CHANGED: the register is refreshed; never retried (one request, no other version)", async () => {
  const f = flow(() => json(409, { success: false, error: { code: "ATTENDANCE_RECORD_CHANGED", message: "server text" } }));
  await f.confirm(decisionTargetOf(STUDENTS[2], registerOf(STUDENTS)), draft("PRESENT", "Arrived."));
  await tick();
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.refreshes(), 1);
  const last = f.last();
  assert.equal(last.phase, "failed");
  if (last.phase === "failed") {
    assert.deepEqual([last.stale, last.refresh, last.error.message], [true, "done", attendanceErrorMessage("ATTENDANCE_RECORD_CHANGED")]);
    assert.equal(decisionNeedsReopen(last), true);
  }
});

test("a failed request: the safe message; no refresh for a non-409; manual retry sends the SAME version", async () => {
  let n = 0;
  const f = flow(() => (++n === 1 ? json(500, { success: false, error: { code: "INTERNAL_SERVER_ERROR", message: "stack trace at db.ts" } }) : OK("ABSENT")));
  const t = decisionTargetOf(STUDENTS[1], registerOf(STUDENTS));
  await f.confirm(t, draft("ABSENT", "Left."));
  const failed = f.last();
  assert.equal(failed.phase === "failed" && failed.error.message, attendanceErrorMessage("INTERNAL_SERVER_ERROR"));
  assert.ok(!JSON.stringify(failed).includes("stack trace"), "never server text for a 5xx");
  assert.equal(f.refreshes(), 0);
  await f.confirm(t, draft("ABSENT", "Left."));
  assert.deepEqual(f.calls.map((c) => JSON.parse(String(c.init?.body)).expectedVersion), [4, 4], "the teacher's retry keeps the loaded version");
});

test("duplicate submission prevented: a second Confirm while the first is in flight sends nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = flow(async () => {
    await gate;
    return OK("ABSENT");
  });
  const t = decisionTargetOf(STUDENTS[1], registerOf(STUDENTS));
  const first = f.confirm(t, draft("ABSENT", "Left."));
  await tick();
  const second = f.confirm(t, draft("ABSENT", "Left."));
  assert.equal(await second, false);
  release();
  await first;
  assert.equal(f.calls.length, 1);
});

test("decisions stay enabled while reconciliation runs (the panel's controller has no lock; the lock would block it)", async () => {
  const lock = createActionLock();
  assert.equal(lock.tryAcquire("reconcile"), true, "reconciliation is running");
  const free = flow(() => OK("ABSENT"));
  assert.equal(await free.confirm(decisionTargetOf(STUDENTS[1], registerOf(STUDENTS)), draft("ABSENT", "Left.")), true);
  assert.equal(free.calls.length, 1, "sent while reconciliation holds the register lock");
  const locked = flow(() => OK("ABSENT"), { lock });
  assert.equal(await locked.confirm(decisionTargetOf(STUDENTS[1], registerOf(STUDENTS)), draft("ABSENT", "Left.")), false, "(what sharing the lock would do)");

  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  const block = panel.slice(panel.indexOf("const controller = createRecordActionController({"), panel.indexOf("recordActions.current = controller;"));
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /\block\b/, "the panel never passes the shared lock to the decision controller");
  const view = panel.slice(panel.indexOf("<ReconcileSection"), panel.indexOf("<FinalizationSection"));
  assert.doesNotMatch(view, /decision|recordAction/i, "reconciliation availability does not depend on decisions");
});

test("stale answers and unmount: dispose aborts the request and ignores its answer (no state, no refresh)", async () => {
  let seenSignal: AbortSignal | null | undefined;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = flow(async ({ init }) => {
    seenSignal = init?.signal;
    await gate;
    return OK("ABSENT");
  });
  const run = f.confirm(decisionTargetOf(STUDENTS[1], registerOf(STUDENTS)), draft("ABSENT", "Left."));
  await tick();
  const count = f.states.length;
  f.controller.dispose();
  assert.equal(seenSignal?.aborted, true);
  release();
  await run;
  assert.equal(f.states.length, count);
  assert.equal(f.refreshes(), 0);
});

// ======================================================================================
// 5. Modal behaviour (focus containment / restoration, inert background) with fake nodes
// ======================================================================================

type FakeNode = {
  id: string;
  tagName: string;
  parentElement: FakeNode | null;
  children: FakeNode[];
  attrs: Map<string, string>;
  focusable: boolean;
  isConnected: boolean;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  focus(): void;
};

function fakeDom() {
  const log: string[] = [];
  let active: FakeNode | null = null;
  const make = (id: string, parent: FakeNode | null, focusable = false, tagName = "DIV"): FakeNode => {
    const node: FakeNode = {
      id, tagName, parentElement: parent, children: [], attrs: new Map(), focusable, isConnected: true,
      hasAttribute: (n) => node.attrs.has(n),
      setAttribute: (n, v) => { node.attrs.set(n, v); log.push(`inert+${id}`); },
      removeAttribute: (n) => { node.attrs.delete(n); log.push(`inert-${id}`); },
      focus: () => { active = node; log.push(`focus:${id}`); },
    };
    parent?.children.push(node);
    return node;
  };
  const body = make("body", null, false, "BODY");
  const sidebar = make("sidebar", body);
  const main = make("main", body);
  const trigger = make("trigger", main, true, "BUTTON");
  const overlay = make("overlay", main);
  const dialogNode = make("dialog", overlay);
  const close = make("close", dialogNode, true, "BUTTON");
  const radio = make("radio", dialogNode, true, "INPUT");
  const cancel = make("cancel", dialogNode, true, "BUTTON");
  cancel.attrs.set("data-autofocus", "true");
  const confirm = make("confirm", dialogNode, true, "BUTTON");
  const inside = [close, radio, cancel, confirm];
  const container = {
    focus: () => dialogNode.focus(),
    querySelectorAll: () => inside.filter((n) => n.focusable),
    querySelector: (selector: string) => (selector.startsWith("[data-autofocus]") ? (inside.find((n) => n.attrs.has("data-autofocus") && n.focusable) ?? null) : null),
    contains: (n: unknown) => inside.includes(n as FakeNode),
  };
  let handler: ((e: FocusKeyEvent) => void) | null = null;
  const key = (k: string, shiftKey = false) => {
    let prevented = false;
    handler?.({ key: k, shiftKey, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { log, body, sidebar, main, trigger, overlay, dialogNode, close, radio, cancel, confirm, container, key, setHandler: (h: typeof handler) => { handler = h; }, active: () => active, setActive: (n: FakeNode) => { active = n; } };
}

function open(dom: ReturnType<typeof fakeDom>, options: { canClose?: () => boolean; onClose?: () => void; fallback?: () => void } = {}) {
  dom.trigger.focus();
  dom.log.length = 0;
  return activateModalDialog({
    dialog: () => dom.container,
    overlay: dom.overlay,
    stopAt: dom.body,
    activeElement: () => dom.active(),
    canClose: options.canClose ?? (() => true),
    onClose: options.onClose ?? (() => {}),
    fallback: options.fallback,
    listen: (h) => {
      dom.setHandler(h);
      return () => dom.setHandler(null);
    },
  });
}

test("modal: focus moves inside (Cancel) BEFORE the background becomes inert; the dialog and its ancestors stay interactive", () => {
  const dom = fakeDom();
  open(dom);
  assert.deepEqual(dom.log, ["focus:cancel", "inert+trigger", "inert+sidebar"]);
  assert.equal(dom.active(), dom.cancel);
  for (const n of [dom.overlay, dom.dialogNode, dom.main, dom.body, dom.cancel]) assert.equal(n.hasAttribute("inert"), false, n.id);
});

test("modal: Tab / Shift+Tab stay inside (wrapping), escaped focus is pulled back", () => {
  const dom = fakeDom();
  open(dom);
  dom.setActive(dom.confirm);
  assert.equal(dom.key("Tab"), true);
  assert.equal(dom.active(), dom.close, "wraps to the first control");
  assert.equal(dom.key("Tab", true), true);
  assert.equal(dom.active(), dom.confirm, "Shift+Tab wraps to the last");
  dom.setActive(dom.radio);
  assert.equal(dom.key("Tab"), false, "moves freely inside (the browser handles it)");
  dom.setActive(dom.sidebar);
  assert.equal(dom.key("Tab"), true);
  assert.equal(dom.active(), dom.close, "escaped focus comes back");
});

test("modal: Escape closes only when allowed (never while busy); release restores the background THEN focus, once", () => {
  const dom = fakeDom();
  let busy = true;
  let closed = 0;
  const { release } = open(dom, { canClose: () => !busy, onClose: () => { closed += 1; } });
  dom.key("Escape");
  assert.equal(closed, 0, "busy: Escape does nothing");
  busy = false;
  dom.key("Escape");
  assert.equal(closed, 1);
  dom.log.length = 0;
  release();
  assert.deepEqual(dom.log, ["inert-trigger", "inert-sidebar", "focus:trigger"]);
  assert.equal(dom.active(), dom.trigger, "focus restored to the Change status button");
  dom.log.length = 0;
  release();
  assert.deepEqual(dom.log, [], "idempotent");
  assert.equal(dom.key("Escape"), false, "no listener after release");
});

test("modal: when the trigger is gone (row filtered out after the refresh), focus goes to the fallback", () => {
  const dom = fakeDom();
  let fellBack = 0;
  const { release } = open(dom, { fallback: () => { fellBack += 1; } });
  dom.trigger.isConnected = false;
  release();
  assert.equal(fellBack, 1);
  assert.equal(dom.sidebar.hasAttribute("inert"), false);
});

// ======================================================================================
// 6. Wiring (source)
// ======================================================================================

test("wiring: the dialog uses the shared modal hook; the hook keeps the established order; the panel renders and disposes", () => {
  const dlg = source("components", "attendance", "decision-dialog.tsx");
  assert.match(dlg, /useModalDialog\(\{ open, dialogRef, overlayRef, canClose: \(\) => !busy, onClose, fallbackId: REGISTER_STUDENTS_ID \}\)/);
  assert.doesNotMatch(dlg, /createDialogFocusManager|makeOutsideInert/, "no duplicated accessibility utilities");

  const hook = source("components", "attendance", "use-modal-dialog.ts");
  assert.match(hook, /manager\.activate\(\);\s*const restoreBackground = deps\.overlay \? makeOutsideInert\(deps\.overlay, deps\.stopAt\) : \(\) => \{\};/);
  assert.match(hook, /unlisten\(\);\s*restoreBackground\(\);\s*manager\.deactivate\(\);/);
  assert.match(hook, /\}, \[open, dialogRef, overlayRef, fallbackId\]\);/, "once per opening");

  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  assert.match(panel, /onChangeStatus=\{openDecision\}/);
  assert.match(panel, /<DecisionDialog\s+target=\{decisionTarget\}/);
  assert.match(panel, /refresh: \(\) => load\("refresh"\),\s*onChange: \(next\) => \{\s*setRecordAction\(next\);/);
  assert.match(panel, /controller\.dispose\(\);\s*if \(recordActions\.current === controller\) recordActions\.current = null;/);
  assert.match(panel, /target: \{ studentId: decisionTarget\.studentId, record: decisionTarget\.record \}/, "the snapshot's version");
  assert.match(panel, /if \(controller\?\.isBusy\(\)\) return;/, "the dialog cannot be closed while busy");
  // Finalization and reconciliation keep their shared lock and are unchanged.
  assert.match(panel, /const lock = createActionLock\(\);\s*const controller = createReconcileController\(\{\s*lectureId,\s*lock,/);
  assert.doesNotMatch(source("components", "attendance", "finalization-dialog.tsx"), /useModalDialog/, "the finalization dialog is untouched");
});
