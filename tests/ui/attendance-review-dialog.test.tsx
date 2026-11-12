/**
 * Stage 5.6e: the teacher's Accept / Dismiss answer to a pending evidence
 * review — components/attendance/review-dialog.tsx (row actions, dialog,
 * pure helpers) and the register panel's wiring (one record-action
 * controller for decisions AND reviews, no register lock). Views render with
 * react-dom/server; row actions are clicked by walking RegisterView's
 * element tree and calling the real handlers; the request flow uses the real
 * controller and helper over a fake fetch; the modal behaviour runs on fake
 * DOM nodes through the shared hook's activateModalDialog. No browser.
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
  submitAttendanceReview,
  type AttendanceRegisterResponse,
  type ReviewAction,
} from "../../components/attendance/attendance-ui";
import { DecisionDialog } from "../../components/attendance/decision-dialog";
import { DEFAULT_REGISTER_FILTERS, RegisterView } from "../../components/attendance/lecture-attendance-register-panel";
import { createRecordActionController, type RecordActionUiState } from "../../components/attendance/record-action-controller";
import { createActionLock } from "../../components/attendance/reconciliation-controller";
import {
  checkReviewReason,
  ReviewActions,
  ReviewDialog,
  reviewAvailability,
  reviewExplanation,
  reviewResultStatus,
  reviewTargetOf,
  type ReviewTarget,
} from "../../components/attendance/review-dialog";
import { activateModalDialog } from "../../components/attendance/use-modal-dialog";
import type { FocusKeyEvent } from "../../components/attendance/dialog-focus";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---- Fixtures ----------------------------------------------------------------------------------

type Student = AttendanceRegisterResponse["students"][number];

const record = (status: string, version: number, extra: Partial<NonNullable<Student["record"]>> = {}): NonNullable<Student["record"]> => ({
  status, statusSource: "TEACHER", autoStatus: null, teacherStatus: status, firstOnlineAt: null, firstQrAt: null, teacherDecidedAt: "2026-09-01T13:00:00.000Z", version, ...extra,
});
const pending = { pending: true, since: "2026-09-01T13:20:00.000Z" };
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
    summary: { students: students.length, withRecord: students.length, recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 2, EXCUSED: 1 }, pendingReviews: 3 },
    absencePreview: null,
    onlineEvidence: null,
    activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "LECTURE_COMPLETED" }, configured: true },
  } as AttendanceRegisterResponse;
}

const STUDENTS: Student[] = [
  // Teacher ABSENT with stronger QR evidence (LATE) waiting.
  student("s-late-ev", { record: record("ABSENT", 4, { autoStatus: "LATE", firstQrAt: "2026-09-01T12:45:00.000Z" }), review: pending }),
  // Finalization ABSENT with PRESENT online evidence waiting.
  student("s-present-ev", { record: record("ABSENT", 2, { statusSource: "FINALIZATION", teacherStatus: null, autoStatus: "PRESENT", firstOnlineAt: "2026-09-01T12:31:00.000Z" }), review: pending }),
  // A pending review without an evidence status (only Dismiss).
  student("s-no-ev", { record: record("EXCUSED", 6), review: pending }),
  // No pending review.
  student("s-plain", { record: record("PRESENT", 1, { autoStatus: "PRESENT", firstOnlineAt: "2026-09-01T12:31:00.000Z" }) }),
  student("s-none"),
  // Pending, but not answerable here.
  student("s-inactive", { record: record("ABSENT", 3, { autoStatus: "LATE" }), review: pending, eligibility: { outcome: "NOT_ELIGIBLE", reason: "STUDENT_INACTIVE", approvalReason: null } }),
  student("s-foreign", { name: null, registrationNumber: null, record: record("ABSENT", 3, { autoStatus: "LATE" }), review: pending }),
];

// ---- Element-tree walking ----------------------------------------------------------------------

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
    const name = (element.type as { name?: string }).name ?? "";
    if (/^(DecisionAction|ReviewActions|StatusCell|EvidenceCell|EligibilityCell|ReviewCell|Detail|Badge|EmptyState|SummaryCard)$/.test(name)) {
      walk((element.type as (p: unknown) => ReactNode)(props), nextLayout, out);
    }
  }
  walk(props.children as ReactNode, nextLayout, out);
}

function reviewButtons(register: AttendanceRegisterResponse, onReview?: (s: Student, a: ReviewAction) => void) {
  const tree = RegisterView({ register, filters: DEFAULT_REGISTER_FILTERS, onFiltersChange: () => {}, onChangeStatus: () => {}, onReview });
  const found: Found[] = [];
  walk(tree, null, found);
  return found.filter((f) => typeof f.element.props["data-review-action"] === "string");
}

// ======================================================================================
// 1. Availability and targets
// ======================================================================================

test("availability: only pending reviews; ACCEPT needs an evidence status; cancelled / foreign / inactive refused", () => {
  const reg = registerOf(STUDENTS);
  assert.deepEqual(reviewAvailability(STUDENTS[0], reg), { allowed: true, reason: null, accept: true });
  assert.deepEqual(reviewAvailability(STUDENTS[1], reg), { allowed: true, reason: null, accept: true });
  assert.deepEqual(reviewAvailability(STUDENTS[2], reg), { allowed: true, reason: null, accept: false }, "Dismiss only");
  assert.deepEqual(reviewAvailability(STUDENTS[3], reg), { allowed: false, reason: null, accept: false }, "not pending: nothing at all");
  assert.deepEqual(reviewAvailability(STUDENTS[4], reg), { allowed: false, reason: null, accept: false }, "no record");
  assert.equal(reviewAvailability(STUDENTS[5], reg).allowed, false, "inactive");
  assert.equal(reviewAvailability(STUDENTS[6], reg).allowed, false, "another teacher's student");
  assert.equal(reviewAvailability(STUDENTS[0], registerOf(STUDENTS, { classStatus: "CANCELLED" })).allowed, false);
  assert.equal(reviewAvailability(STUDENTS[0], registerOf(STUDENTS, { finalized: true })).allowed, true, "a finalized register still takes answers");
});

test("target snapshot: current status and source, evidence status, the record's exact version, the chosen action", () => {
  const reg = registerOf(STUDENTS);
  assert.deepEqual(reviewTargetOf(STUDENTS[0], reg, "ACCEPT"), {
    studentId: "s-late-ev", name: "Name s-late-ev", registrationNumber: "REG-s-late-ev", action: "ACCEPT", currentStatus: "ABSENT", currentSource: "TEACHER",
    evidenceStatus: "LATE", pendingSince: pending.since, record: { version: 4 }, finalized: false,
  });
  assert.equal(reviewTargetOf(STUDENTS[1], reg, "DISMISS")?.record.version, 2);
  assert.equal(reviewTargetOf(STUDENTS[4], reg, "DISMISS"), null, "no record: no target");
});

test("reasons: ACCEPT required (blank / whitespace refused); DISMISS optional; trimmed; 500 characters", () => {
  assert.deepEqual(checkReviewReason("ACCEPT", ""), { ok: false, problem: "REQUIRED" });
  assert.deepEqual(checkReviewReason("ACCEPT", "  \n\t "), { ok: false, problem: "REQUIRED" });
  assert.deepEqual(checkReviewReason("ACCEPT", "  Verified the scan.  "), { ok: true, reason: "Verified the scan." });
  assert.deepEqual(checkReviewReason("DISMISS", ""), { ok: true, reason: null });
  assert.deepEqual(checkReviewReason("DISMISS", "   "), { ok: true, reason: null });
  assert.deepEqual(checkReviewReason("DISMISS", " Wrong device. "), { ok: true, reason: "Wrong device." });
  const max = "r".repeat(500);
  assert.deepEqual(checkReviewReason("ACCEPT", `  ${max}  `), { ok: true, reason: max });
  assert.deepEqual(checkReviewReason("ACCEPT", `${max}r`), { ok: false, problem: "TOO_LONG" });
  assert.deepEqual(checkReviewReason("DISMISS", `${max}r`), { ok: false, problem: "TOO_LONG" }, "an optional reason is still checked");
});

test("explanations and results: ACCEPT applies the evidence status; DISMISS keeps the current status", () => {
  const reg = registerOf(STUDENTS);
  const accept = reviewTargetOf(STUDENTS[0], reg, "ACCEPT")!;
  assert.match(reviewExplanation(accept), /applies the automatic evidence as your decision: the status changes from Absent to Late\. A reason is required\./);
  assert.equal(reviewResultStatus(accept), "LATE");
  const dismiss = reviewTargetOf(STUDENTS[0], reg, "DISMISS")!;
  assert.match(reviewExplanation(dismiss), /keeps the current status \(Absent\).*optional/);
  assert.equal(reviewResultStatus(dismiss), "ABSENT");
});

// ======================================================================================
// 2. Both layouts
// ======================================================================================

test("both layouts: Accept / Dismiss for pending reviews only, the same set in the table and the cards; the real handlers", () => {
  const reg = registerOf(STUDENTS);
  const opened: string[] = [];
  const buttons = reviewButtons(reg, (s, a) => opened.push(`${s.studentId}:${a}`));
  const ids = (layout: string) => buttons.filter((b) => b.layout === layout).map((b) => b.element.props["data-review-action"]);
  const expected = ["s-late-ev:ACCEPT", "s-late-ev:DISMISS", "s-present-ev:ACCEPT", "s-present-ev:DISMISS", "s-no-ev:DISMISS"];
  assert.deepEqual(ids("table"), expected);
  assert.deepEqual(ids("cards"), expected);
  (buttons.find((b) => b.layout === "table" && b.element.props["data-review-action"] === "s-late-ev:ACCEPT")!.element.props.onClick as () => void)();
  (buttons.find((b) => b.layout === "cards" && b.element.props["data-review-action"] === "s-present-ev:DISMISS")!.element.props.onClick as () => void)();
  assert.deepEqual(opened, ["s-late-ev:ACCEPT", "s-present-ev:DISMISS"]);
});

test("both layouts: nothing for non-pending rows; decisions and every existing field are kept; accessible names", () => {
  const reg = registerOf(STUDENTS);
  const html = renderToStaticMarkup(<RegisterView register={reg} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={() => {}} onChangeStatus={() => {}} onReview={() => {}} />);
  const table = html.slice(html.indexOf('data-layout="table"'), html.indexOf('data-layout="cards"'));
  const cards = html.slice(html.indexOf('data-layout="cards"'));
  for (const part of [table, cards]) {
    assert.equal((part.match(/>Accept evidence</g) ?? []).length, 2);
    assert.equal((part.match(/>Dismiss evidence</g) ?? []).length, 3);
    assert.equal((part.match(/Change status/g) ?? []).length, 5, "the manual decision action is still there");
    assert.ok(text(part).includes("Pending review since"), "review information kept");
    assert.ok(text(part).includes("Review: This student is inactive."));
    assert.ok(!part.includes('data-review-action="s-plain'), "no review action without a pending review");
    assert.ok(!part.includes('data-review-action="s-none'));
  }
  assert.match(html, />Accept evidence<span class="sr-only">: Name s-late-ev<\/span>/);
  assert.match(html, />Dismiss evidence<span class="sr-only">: Name s-no-ev<\/span>/);
  assert.equal(renderToStaticMarkup(<ReviewActions student={STUDENTS[3]} register={reg} onOpen={() => {}} />), "", "not pending: nothing rendered");
  assert.equal(reviewButtons(registerOf(STUDENTS, { classStatus: "CANCELLED" }), () => {}).length, 0);
});

// ======================================================================================
// 3. The dialog
// ======================================================================================

const noop = () => {};
function dialog(t: ReviewTarget | null, reason = "", extra: Partial<Parameters<typeof ReviewDialog>[0]> = {}) {
  return renderToStaticMarkup(
    <ReviewDialog target={t} reason={reason} step="edit" problem={null} action={{ phase: "idle" }} onReasonChange={noop} onContinue={noop} onBack={noop} onConfirm={noop} onClose={noop} {...extra} />
  );
}
const reg = registerOf(STUDENTS);
const ACCEPT = reviewTargetOf(STUDENTS[0], reg, "ACCEPT")!;
const DISMISS = reviewTargetOf(STUDENTS[1], reg, "DISMISS")!;

test("dialog: accessible modal; ACCEPT shows the current and evidence statuses, explains, reason required", () => {
  assert.equal(dialog(null), "");
  const html = dialog(ACCEPT);
  assert.match(html, /^<div data-dialog-overlay="true"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="review-dialog-title" aria-describedby="review-dialog-description"/);
  assert.match(html, /<h2 id="review-dialog-title"[^>]*>Accept evidence<\/h2>/);
  assert.match(text(html), /Current status Absent \(Teacher decision\)/);
  assert.match(text(html), /Automatic evidence status Late/);
  assert.match(text(html), /applies the automatic evidence as your decision/);
  assert.match(html, /Reason \(required\)/);
  assert.match(html, /aria-required="true"/);
  assert.match(html, /<button type="button"[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
  assert.doesNotMatch(html, /\binert\b/);
});

test("dialog: DISMISS shows both statuses, explains the status is kept, reason optional", () => {
  const html = dialog(DISMISS);
  assert.match(html, /<h2 id="review-dialog-title"[^>]*>Dismiss evidence<\/h2>/);
  assert.match(text(html), /Current status Absent \(Finalization \(automatic absence\)\)/);
  assert.match(text(html), /Automatic evidence status Present/);
  assert.match(text(html), /Dismissing keeps the current status \(Absent\)/);
  assert.match(html, /Reason \(optional\)/);
  assert.match(html, /aria-required="false"/);
});

test("dialog: validation errors announced and linked; trimmed counter", () => {
  const required = dialog(ACCEPT, "   ", { problem: "REQUIRED" });
  assert.match(required, /aria-invalid="true"/);
  assert.match(required, /aria-describedby="review-reason-help review-reason-error"/);
  assert.match(required, /id="review-reason-error"[^>]*>Enter a reason for this change\./);
  assert.match(text(dialog(DISMISS, "x".repeat(501), { problem: "TOO_LONG" })), /at most 500 characters/);
  assert.match(text(dialog(ACCEPT, "  Seen.  ")), /\(5 used;/);
});

test("dialog: explicit confirmation summarises the action; busy disables everything", () => {
  const confirmAccept = dialog(ACCEPT, " Verified. ", { step: "confirm" });
  assert.match(text(confirmAccept), /Accept the evidence for Name s-late-ev : change from Absent to Late \?/);
  assert.match(text(confirmAccept), /Reason: Verified\./);
  assert.match(confirmAccept, />Accept evidence<\/button>/);
  assert.doesNotMatch(confirmAccept, /<textarea/);
  const confirmDismiss = dialog(DISMISS, "", { step: "confirm" });
  assert.match(text(confirmDismiss), /Dismiss the evidence for Name s-present-ev and keep Absent \?/);
  assert.match(text(confirmDismiss), /Reason: None given/);
  const busy = dialog(ACCEPT, "x", { step: "confirm", action: { phase: "submitting", kind: "review", studentId: "s-late-ev" } });
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /Saving…/);
  assert.equal((busy.match(/<button type="button"[^>]*disabled=""/g) ?? []).length, 3);
});

const failure = (status: number, code: string, refresh: "pending" | "done" | "failed" | "skipped", stale: boolean, kind: "review" | "decision" = "review", studentId = "s-late-ev"): RecordActionUiState => ({
  phase: "failed", kind, studentId, error: { ok: false, status, code, message: attendanceErrorMessage(code) }, stale, cancelled: false, refresh,
});

test("dialog: 409 — the review changed or is no longer pending: explained, refreshed, only Close (no retry)", () => {
  for (const code of ["ATTENDANCE_NO_PENDING_REVIEW", "ATTENDANCE_RECORD_CHANGED"]) {
    const html = dialog(ACCEPT, "x", { step: "confirm", action: failure(409, code, "done", true) });
    assert.match(text(html), /This review changed or is no longer pending/);
    assert.match(text(html), /has been refreshed/);
    assert.doesNotMatch(html, />Accept evidence<\/button>|Try again/);
    assert.match(html, /data-autofocus="true"[^>]*>Close<\/button>/);
  }
  assert.match(text(dialog(ACCEPT, "x", { action: failure(409, "ATTENDANCE_NO_PENDING_REVIEW", "pending", true) })), /Refreshing the register/);
  assert.match(text(dialog(DISMISS, "", { action: failure(409, "ATTENDANCE_NO_PENDING_REVIEW", "done", true, "review", "s-present-ev") })), /no evidence waiting for review/);
});

test("dialog: other failures show our safe message and a manual Try again; another kind's result is never shown", () => {
  const html = dialog(ACCEPT, "x", { step: "confirm", action: failure(500, "INTERNAL_SERVER_ERROR", "skipped", false) });
  assert.match(text(html), /The action was not saved/);
  assert.match(text(html), /Something went wrong on the server/);
  assert.match(html, />Try again<\/button>/);
  // A decision failure for the same student is not the review dialog's, and vice versa.
  assert.doesNotMatch(dialog(ACCEPT, "x", { action: failure(409, "ATTENDANCE_RECORD_CHANGED", "done", true, "decision") }), /role="alert"/);
  const decisionHtml = renderToStaticMarkup(
    <DecisionDialog
      target={{ studentId: "s-late-ev", name: "N", registrationNumber: null, currentStatus: "ABSENT", currentSource: "TEACHER", record: { version: 4 }, finalized: false }}
      draft={{ status: null, reason: "" }}
      step="edit"
      problem={null}
      action={failure(409, "ATTENDANCE_NO_PENDING_REVIEW", "done", true, "review")}
      onStatusChange={noop}
      onReasonChange={noop}
      onContinue={noop}
      onBack={noop}
      onConfirm={noop}
      onClose={noop}
    />
  );
  assert.doesNotMatch(decisionHtml, /role="alert"/);
});

// ======================================================================================
// 4. The request flow (one real controller for decisions and reviews; real helpers over a fake fetch)
// ======================================================================================

type Call = { url: string; body: Record<string, unknown> };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const reviewOk = (action: ReviewAction, status: string) => json(200, { success: true, data: { lectureId: "L1", studentId: "s-late-ev", action, status, statusSource: "TEACHER", teacherStatus: status, autoStatus: "LATE", pendingReview: false, version: 5 } });

function flow(handler: (call: Call) => Response | Promise<Response>, options: { lock?: ReturnType<typeof createActionLock> } = {}) {
  const calls: Call[] = [];
  const states: RecordActionUiState[] = [];
  let refreshes = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const call = { url, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return handler(call);
  };
  const controller = createRecordActionController({
    lectureId: "L1",
    lock: options.lock,
    refresh: async () => {
      refreshes += 1;
      return true;
    },
    onChange: (s) => states.push(s),
    decide: (l, s, r, o) => submitAttendanceDecision(l, s, r, { ...o, fetchImpl }),
    review: (l, s, r, o) => submitAttendanceReview(l, s, r, { ...o, fetchImpl }),
  });
  /** What the panel does on Confirm: the snapshot's version and action, the checked reason. */
  const confirm = (t: ReviewTarget, reason: string) => {
    const check = checkReviewReason(t.action, reason);
    assert.ok(check.ok);
    if (!check.ok) return Promise.resolve(false);
    return controller.submitReview({ target: { studentId: t.studentId, record: t.record }, action: t.action, reason: check.reason });
  };
  return { controller, calls, states, confirm, refreshes: () => refreshes, last: () => states.at(-1)! };
}

test("ACCEPT: the review route, the exact version, the trimmed reason; success refreshes the register (nothing local)", async () => {
  const before = JSON.stringify(reg);
  const f = flow(() => reviewOk("ACCEPT", "LATE"));
  assert.equal(await f.confirm(ACCEPT, "  Verified the scan.  "), true);
  assert.deepEqual(f.calls, [{ url: "/api/lectures/L1/attendance/students/s-late-ev/review", body: { action: "ACCEPT", expectedVersion: 4, reason: "Verified the scan." } }]);
  assert.equal(f.refreshes(), 1);
  const done = f.last();
  assert.deepEqual([done.phase, done.phase === "succeeded" && done.kind, done.phase === "succeeded" && done.refresh], ["succeeded", "review", "done"]);
  assert.equal(JSON.stringify(reg), before, "no optimistic change");
});

test("DISMISS: no reason sent as null; the exact version; success refreshes the register", async () => {
  const f = flow(() => reviewOk("DISMISS", "ABSENT"));
  await f.confirm(DISMISS, "   ");
  assert.deepEqual(f.calls[0], { url: "/api/lectures/L1/attendance/students/s-present-ev/review", body: { action: "DISMISS", expectedVersion: 2, reason: null } });
  assert.equal(f.refreshes(), 1);
  const g = flow(() => reviewOk("DISMISS", "ABSENT"));
  await g.confirm(DISMISS, " Wrong device. ");
  assert.equal(g.calls[0].body.reason, "Wrong device.");
});

test("409: the register is refreshed, exactly one request (no retry, no other version)", async () => {
  const f = flow(() => json(409, { success: false, error: { code: "ATTENDANCE_NO_PENDING_REVIEW", message: "server text" } }));
  await f.confirm(ACCEPT, "Verified.");
  await tick();
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.refreshes(), 1);
  const last = f.last();
  assert.deepEqual(last.phase === "failed" && [last.stale, last.refresh, last.error.message], [true, "done", attendanceErrorMessage("ATTENDANCE_NO_PENDING_REVIEW")]);
});

test("safe errors: a 5xx shows our message, never the server's text; no refresh; a manual retry keeps the version", async () => {
  let n = 0;
  const f = flow(() => (++n === 1 ? json(500, { success: false, error: { code: "INTERNAL_SERVER_ERROR", message: "at prisma.lectureAttendance" } }) : reviewOk("ACCEPT", "LATE")));
  await f.confirm(ACCEPT, "Verified.");
  const failed = f.last();
  assert.equal(failed.phase === "failed" && failed.error.message, attendanceErrorMessage("INTERNAL_SERVER_ERROR"));
  assert.ok(!JSON.stringify(failed).includes("prisma"));
  assert.equal(f.refreshes(), 0);
  await f.confirm(ACCEPT, "Verified.");
  assert.deepEqual(f.calls.map((c) => c.body.expectedVersion), [4, 4]);
});

test("duplicates and mixing: a second review, or a decision, while a review is in flight is refused — and the reverse", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = flow(async (call) => {
    await gate;
    return call.url.endsWith("/review") ? reviewOk("ACCEPT", "LATE") : json(200, { success: true, data: { lectureId: "L1", studentId: "s-late-ev", status: "PRESENT", statusSource: "TEACHER", teacherStatus: "PRESENT", autoStatus: "LATE", pendingReview: false, version: 5, afterFinalization: false, changed: true } });
  });
  const first = f.confirm(ACCEPT, "Verified.");
  await tick();
  assert.equal(await f.confirm(ACCEPT, "Verified."), false, "duplicate review refused");
  assert.equal(await f.controller.submitDecision({ target: { studentId: "s-late-ev", record: { version: 4 } }, status: "PRESENT", reason: "x", finalized: false }), false, "decision refused while a review is in flight");
  release();
  await first;
  assert.deepEqual(f.calls.map((c) => c.url.split("/").pop()), ["review"]);

  let release2!: () => void;
  const gate2 = new Promise<void>((r) => { release2 = r; });
  const g = flow(async () => {
    await gate2;
    return json(200, { success: true, data: { lectureId: "L1", studentId: "s-late-ev", status: "PRESENT", statusSource: "TEACHER", teacherStatus: "PRESENT", autoStatus: "LATE", pendingReview: false, version: 5, afterFinalization: false, changed: true } });
  });
  const decision = g.controller.submitDecision({ target: { studentId: "s-late-ev", record: { version: 4 } }, status: "PRESENT", reason: "x", finalized: false });
  await tick();
  assert.equal(await g.confirm(ACCEPT, "Verified."), false, "review refused while a decision is in flight");
  release2();
  await decision;
  assert.deepEqual(g.calls.map((c) => c.url.split("/").pop()), ["decision"], "a decision is never sent as a review (and vice versa)");
});

test("reviews stay available while reconciliation runs (no register lock); with the lock they would not be", async () => {
  const lock = createActionLock();
  assert.equal(lock.tryAcquire("reconcile"), true);
  const free = flow(() => reviewOk("DISMISS", "ABSENT"));
  assert.equal(await free.confirm(DISMISS, ""), true);
  assert.equal(free.calls.length, 1);
  const locked = flow(() => reviewOk("DISMISS", "ABSENT"), { lock });
  assert.equal(await locked.confirm(DISMISS, ""), false);
});

test("cleanup: dispose aborts the request in flight and ignores its answer (no state, no refresh)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = flow(async () => {
    await gate;
    return reviewOk("ACCEPT", "LATE");
  });
  const run = f.confirm(ACCEPT, "Verified.");
  await tick();
  const count = f.states.length;
  f.controller.dispose();
  release();
  await run;
  assert.equal(f.states.length, count);
  assert.equal(f.refreshes(), 0);
});

// ======================================================================================
// 5. Modal behaviour (the shared hook) on fake DOM nodes
// ======================================================================================

function fakeDom() {
  const log: string[] = [];
  type N = { id: string; tagName: string; parentElement: N | null; children: N[]; attrs: Map<string, string>; isConnected: boolean; hasAttribute(n: string): boolean; setAttribute(n: string, v: string): void; removeAttribute(n: string): void; focus(): void };
  let active: N | null = null;
  const make = (id: string, parent: N | null): N => {
    const node: N = {
      id, tagName: "DIV", parentElement: parent, children: [], attrs: new Map(), isConnected: true,
      hasAttribute: (n) => node.attrs.has(n),
      setAttribute: (n, v) => { node.attrs.set(n, v); log.push(`inert+${id}`); },
      removeAttribute: (n) => { node.attrs.delete(n); log.push(`inert-${id}`); },
      focus: () => { active = node; log.push(`focus:${id}`); },
    };
    parent?.children.push(node);
    return node;
  };
  const body = make("body", null);
  const header = make("header", body);
  const register = make("register", body);
  const acceptButton = make("accept-button", register);
  const overlay = make("overlay", body);
  const dlg = make("dialog", overlay);
  const close = make("close", dlg);
  const reason = make("reason", dlg);
  const cancel = make("cancel", dlg);
  const cont = make("continue", dlg);
  const inside = [close, reason, cancel, cont];
  let handler: ((e: FocusKeyEvent) => void) | null = null;
  return {
    log, header, register, acceptButton, overlay, body, close, cancel, cont, inside,
    active: () => active,
    setActive: (n: N) => { active = n; },
    key: (k: string, shiftKey = false) => handler?.({ key: k, shiftKey, preventDefault: () => {} }),
    activate: (canClose: () => boolean, onClose: () => void) => {
      acceptButton.focus();
      log.length = 0;
      return activateModalDialog({
        dialog: () => ({
          focus: () => dlg.focus(),
          querySelectorAll: () => inside,
          querySelector: (sel: string) => (sel.startsWith("[data-autofocus]") ? cancel : null),
          contains: (n: unknown) => inside.includes(n as N),
        }),
        overlay, stopAt: body,
        activeElement: () => active,
        canClose, onClose,
        listen: (h) => { handler = h; return () => { handler = null; }; },
      });
    },
  };
}

test("modal: focus to Cancel, then the background inert; Tab contained; Escape blocked while busy; restore then focus back", () => {
  const dom = fakeDom();
  let busy = true;
  let closed = 0;
  const { release } = dom.activate(() => !busy, () => { closed += 1; });
  assert.deepEqual(dom.log, ["focus:cancel", "inert+header", "inert+register"]);
  dom.setActive(dom.cont);
  dom.key("Tab");
  assert.equal(dom.active(), dom.close, "wraps inside the dialog");
  dom.key("Tab", true);
  assert.equal(dom.active(), dom.cont);
  dom.key("Escape");
  assert.equal(closed, 0, "busy: Escape does nothing");
  busy = false;
  dom.key("Escape");
  assert.equal(closed, 1);
  dom.log.length = 0;
  release();
  assert.deepEqual(dom.log, ["inert-header", "inert-register", "focus:accept-button"], "background restored, then focus returns to the Accept button");
  for (const n of [dom.header, dom.register]) assert.equal(n.hasAttribute("inert"), false);
});

// ======================================================================================
// 6. Wiring (source)
// ======================================================================================

test("wiring: one controller for decisions and reviews (no register lock); snapshot version and action; guards; shared hook", () => {
  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  assert.equal((panel.match(/createRecordActionController\(/g) ?? []).length, 1, "decisions and reviews share ONE controller");
  const block = panel.slice(panel.indexOf("const controller = createRecordActionController({"), panel.indexOf("recordActions.current = controller;"));
  assert.doesNotMatch(block, /\block\b/, "no register (reconciliation) lock");
  assert.match(panel, /onReview=\{openReview\}/);
  assert.match(panel, /<ReviewDialog\s+target=\{reviewTarget\}/);
  assert.match(panel, /target: \{ studentId: reviewTarget\.studentId, record: reviewTarget\.record \},\s*action: reviewTarget\.action,/);
  assert.match(panel, /controller\.isBusy\(\) \|\| decisionTarget\) return;/, "no review dialog over a decision dialog");
  assert.match(panel, /controller\.isBusy\(\) \|\| reviewTarget\) return;/, "no decision dialog over a review dialog");
  assert.match(panel, /next\.kind === "review" && next\.refresh !== "pending"/, "a review success closes only the review dialog");

  const dlg = source("components", "attendance", "review-dialog.tsx");
  assert.match(dlg, /useModalDialog\(\{ open, dialogRef, overlayRef, canClose: \(\) => !busy, onClose, fallbackId: REGISTER_STUDENTS_ID \}\)/);
  assert.doesNotMatch(dlg, /createDialogFocusManager|makeOutsideInert/, "no duplicated accessibility utilities");
  assert.doesNotMatch(dlg, /submitAttendanceDecision|submitDecision/, "the review dialog never sends a decision");
  assert.doesNotMatch(source("components", "attendance", "decision-dialog.tsx"), /submitAttendanceReview|submitReview/);
});
