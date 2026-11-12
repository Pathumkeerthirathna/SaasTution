/**
 * Stage 5.6f: the teacher attendance history UI —
 * components/attendance/history-views.tsx (the student history dialog, the
 * register history section, the row action, pure labels) and the register
 * panel's wiring. Views render with react-dom/server from data shaped like
 * the Stage 5.6b API responses; the row action is clicked by walking
 * RegisterView's element tree and calling the real handlers; paging runs
 * the real loaders and helpers over a fake fetch; the modal behaviour runs on
 * fake DOM nodes through the shared hook. No browser, no database.
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
  formatColomboDateTime,
  type AttendanceRegisterResponse,
  type RegisterHistoryEntry,
  type RegisterHistoryResponse,
  type StudentHistoryEntry,
  type StudentHistoryResponse,
} from "../../components/attendance/attendance-ui";
import { createRegisterHistoryLoader, createStudentHistoryLoader } from "../../components/attendance/history-controller";
import {
  changeText,
  historyActorLabel,
  historyAvailable,
  historyCauseLabel,
  RegisterHistoryView,
  registerHistoryActionLabel,
  retryHistory,
  StudentHistoryBody,
  StudentHistoryDialogView,
  studentHistoryActionLabel,
  type RegisterHistoryState,
  type StudentHistoryState,
} from "../../components/attendance/history-views";
import { DEFAULT_REGISTER_FILTERS, RegisterView, formatColomboDateTime as panelFormat } from "../../components/attendance/lecture-attendance-register-panel";
import { activateModalDialog } from "../../components/attendance/use-modal-dialog";
import type { FocusKeyEvent } from "../../components/attendance/dialog-focus";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const noop = () => {};

// ---- Fixtures ----------------------------------------------------------------------------------

type Student = AttendanceRegisterResponse["students"][number];
const eligible = { outcome: "ELIGIBLE" as const, reason: "ELIGIBLE", approvalReason: null };
const student = (studentId: string, fields: Partial<Student> = {}): Student => ({
  studentId, name: `Name ${studentId}`, registrationNumber: `REG-${studentId}`, eligibility: eligible, absenceDecision: null,
  record: null, review: { pending: false, since: null }, ...fields,
});
const rec = (status: string, version: number): NonNullable<Student["record"]> => ({
  status, statusSource: "TEACHER", autoStatus: "LATE", teacherStatus: status, firstOnlineAt: null, firstQrAt: "2026-09-01T12:45:00.000Z", teacherDecidedAt: "2026-09-01T13:00:00.000Z", version,
});
const STUDENTS: Student[] = [
  student("s-1", { record: rec("ABSENT", 3), review: { pending: true, since: "2026-09-01T13:10:00.000Z" } }),
  student("s-2"),
  student("s-inactive", { record: rec("PRESENT", 2), eligibility: { outcome: "NOT_ELIGIBLE", reason: "STUDENT_INACTIVE", approvalReason: null } }),
  student("s-foreign", { name: null, registrationNumber: null, record: rec("PRESENT", 1) }),
];
const register = (classStatus = "COMPLETED") =>
  ({
    lecture: { id: "L1", classId: "C1", title: "Kinematics", classStatus, date: "2026-09-01T12:30:00.000Z", endDate: null },
    register: { lectureId: "L1", exists: true, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: null, graceMinutes: 10, version: 3, finalized: false, finalizedAt: null },
    configuration: { approval: "OK", evidence: "OK" }, classification: "LIVE", students: STUDENTS,
    summary: { students: 4, withRecord: 3, recordStatus: { PRESENT: 2, LATE: 0, ABSENT: 1, EXCUSED: 0 }, pendingReviews: 1 },
    absencePreview: null, onlineEvidence: null, activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "LECTURE_COMPLETED" }, configured: true },
  }) as AttendanceRegisterResponse;

const you = { role: "TEACHER" as const, isCurrentTeacher: true };
const system = { role: "SYSTEM" as const, isCurrentTeacher: false };
const studentEntry = (version: number, fields: Partial<StudentHistoryEntry> = {}): StudentHistoryEntry => ({
  version, action: "TEACHER_SET", at: "2026-09-01T13:00:00.000Z", actor: you, reason: null, afterFinalization: false,
  status: { from: null, to: "ABSENT" }, teacherStatus: { from: null, to: "ABSENT" }, autoStatus: { from: null, to: null }, cause: null, ...fields,
});
const studentPage = (entries: StudentHistoryEntry[], nextCursor: string | null, fields: Partial<StudentHistoryResponse> = {}): StudentHistoryResponse => ({
  lectureId: "L1", studentId: "s-1", recordExists: true, record: { status: "ABSENT", statusSource: "TEACHER", version: 3, pendingReview: true }, entries, nextCursor, ...fields,
});
const registerEntry = (version: number, action: RegisterHistoryEntry["action"], fields: Partial<RegisterHistoryEntry> = {}): RegisterHistoryEntry => ({
  version, action, at: "2026-09-01T12:00:00.000Z", actor: system, reason: null, graceMinutes: null, scheduledStartAt: null, scheduledEndAt: null,
  finalization: null, recalculatedCount: null, ...fields,
});
const registerPage = (entries: RegisterHistoryEntry[], nextCursor: string | null, fields: Partial<RegisterHistoryResponse> = {}): RegisterHistoryResponse => ({
  lectureId: "L1", registerExists: true, registerVersion: 4, qrClosure: null, entries, nextCursor, ...fields,
});
const stateOf = <P extends { entries: E[]; nextCursor: string | null }, E>(page: P | null, extra: Record<string, unknown> = {}) => {
  if (!page) return { entries: [], latest: null, nextCursor: null, complete: false, loading: null, error: null, ...extra };
  const { entries, nextCursor, ...latest } = page;
  return { entries, latest, nextCursor, complete: nextCursor === null, loading: null, error: null, ...extra };
};
const err = (code: string, status = 500) => ({ ok: false as const, status, code, message: attendanceErrorMessage(code) });

// ---- Element-tree walking ----------------------------------------------------------------------

type Found = { element: ReactElement<Record<string, unknown>>; layout: string | null };
function walk(node: ReactNode, layout: string | null, out: Found[]) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, layout, out);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<Record<string, unknown>>;
  const nextLayout = typeof element.props["data-layout"] === "string" ? (element.props["data-layout"] as string) : layout;
  out.push({ element, layout: nextLayout });
  if (typeof element.type === "function" && /^(DecisionAction|ReviewActions|HistoryAction|StatusCell|EvidenceCell|EligibilityCell|ReviewCell|Detail|Badge|EmptyState|SummaryCard)$/.test((element.type as { name?: string }).name ?? "")) {
    walk((element.type as (p: unknown) => ReactNode)(element.props), nextLayout, out);
  }
  walk(element.props.children as ReactNode, nextLayout, out);
}
function actionsOf(onViewHistory: (s: Student) => void, classStatus?: string) {
  const tree = RegisterView({ register: register(classStatus), filters: DEFAULT_REGISTER_FILTERS, onFiltersChange: noop, onChangeStatus: noop, onReview: noop, onViewHistory });
  const found: Found[] = [];
  walk(tree, null, found);
  return found;
}

// ======================================================================================
// 1. Row action (both layouts)
// ======================================================================================

test("history action: opens from the desktop table and from the mobile card with the right student", () => {
  const opened: string[] = [];
  const found = actionsOf((s) => opened.push(s.studentId)).filter((f) => typeof f.element.props["data-history-action"] === "string");
  const ids = (layout: string) => found.filter((f) => f.layout === layout).map((f) => f.element.props["data-history-action"]);
  assert.deepEqual(ids("table"), ["s-1", "s-2", "s-inactive"], "every authorized student, the inactive one included; never another teacher's");
  assert.deepEqual(ids("cards"), ids("table"));
  (found.find((f) => f.layout === "table" && f.element.props["data-history-action"] === "s-1")!.element.props.onClick as () => void)();
  (found.find((f) => f.layout === "cards" && f.element.props["data-history-action"] === "s-inactive")!.element.props.onClick as () => void)();
  assert.deepEqual(opened, ["s-1", "s-inactive"]);
  assert.equal(historyAvailable(STUDENTS[3]), false);
  assert.equal(actionsOf(noop, "CANCELLED").filter((f) => typeof f.element.props["data-history-action"] === "string").length, 6, "history stays readable on a cancelled lecture");
});

test("history action: decision and review actions are unaffected; accessible names; every field kept", () => {
  const html = renderToStaticMarkup(<RegisterView register={register()} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={noop} onChangeStatus={noop} onReview={noop} onViewHistory={noop} />);
  for (const part of [html.slice(html.indexOf('data-layout="table"'), html.indexOf('data-layout="cards"')), html.slice(html.indexOf('data-layout="cards"'))]) {
    assert.equal((part.match(/>View history</g) ?? []).length, 3);
    assert.equal((part.match(/Change status/g) ?? []).length, 2, "decision actions unchanged (inactive and foreign excluded)");
    assert.equal((part.match(/>Accept evidence</g) ?? []).length, 1);
    assert.equal((part.match(/>Dismiss evidence</g) ?? []).length, 1);
    assert.ok(text(part).includes("Pending review since"));
  }
  assert.match(html, />View history<span class="sr-only">: Name s-1<\/span>/);
});

// ======================================================================================
// 2. Labels and formatting
// ======================================================================================

test("labels: actions, actors (You / Teacher / System from isCurrentTeacher, no ids), causes, changes", () => {
  assert.equal(studentHistoryActionLabel("EVIDENCE_ACCEPTED"), "Evidence accepted");
  assert.equal(studentHistoryActionLabel("FINALIZE_ABSENT"), "Marked absent at finalization");
  assert.equal(studentHistoryActionLabel("SOMETHING_NEW"), "Attendance change");
  assert.deepEqual(["CREATED", "GRACE_CHANGED", "SCHEDULE_SYNCED", "FINALIZED"].map(registerHistoryActionLabel), ["Register created", "Grace period changed", "Schedule synchronized", "Register finalized"]);
  assert.equal(historyActorLabel(you), "You");
  assert.equal(historyActorLabel({ role: "TEACHER", isCurrentTeacher: false }), "Teacher");
  assert.equal(historyActorLabel(system), "System");
  assert.deepEqual([historyCauseLabel("QR_SCAN"), historyCauseLabel("ONLINE_VISIT"), historyCauseLabel("REGISTER_CHANGE"), historyCauseLabel(null)], ["QR scan", "Online join", "Register change (schedule or grace)", null]);
  assert.equal(changeText({ from: "ABSENT", to: "LATE" }), "Absent → Late");
  assert.equal(changeText({ from: null, to: "PRESENT" }), "Present");
  assert.equal(changeText({ from: null, to: null }), null);
});

test("Asia/Colombo times: the shared formatter (moved, same function, still exported by the panel)", () => {
  assert.equal(formatColomboDateTime("2026-09-01T12:30:00.000Z"), panelFormat("2026-09-01T12:30:00.000Z"));
  assert.match(formatColomboDateTime("2026-09-01T12:30:00.000Z"), /18:00/, "UTC+05:30");
  assert.equal(formatColomboDateTime(null), "—");
});

// ======================================================================================
// 3. Student history view and dialog
// ======================================================================================

test("student history: every supplied field — action, time, actor, statuses, teacher / automatic status, reason, after finalization, cause", () => {
  const entries = [
    studentEntry(1, { action: "CREATED_AUTO", actor: system, status: { from: null, to: "LATE" }, teacherStatus: { from: null, to: null }, autoStatus: { from: null, to: "LATE" }, cause: "QR_SCAN", at: "2026-09-01T12:45:00.000Z" }),
    studentEntry(2, { action: "TEACHER_SET", status: { from: "LATE", to: "ABSENT" }, teacherStatus: { from: null, to: "ABSENT" }, autoStatus: { from: "LATE", to: "LATE" }, reason: "Left before the break.", at: "2026-09-01T13:00:00.000Z" }),
    studentEntry(3, { action: "EVIDENCE_DISMISSED", actor: { role: "TEACHER", isCurrentTeacher: false }, status: { from: "ABSENT", to: "ABSENT" }, teacherStatus: { from: "ABSENT", to: "ABSENT" }, afterFinalization: true }),
  ];
  const html = renderToStaticMarkup(<StudentHistoryBody state={stateOf(studentPage(entries, null)) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} />);
  const t = text(html);
  for (const expected of [
    "Recorded automatically", "Teacher decision", "Evidence dismissed",
    `${formatColomboDateTime("2026-09-01T12:45:00.000Z")} · By: System`, `${formatColomboDateTime("2026-09-01T13:00:00.000Z")} · By: You`, "By: Teacher",
    "Status Late", "Status Late → Absent", "Teacher status Absent", "Automatic status Late → Late", "Automatic status Late",
    "Caused by QR scan", "Reason Left before the break.", "Timing After finalization",
    "Current status Absent", "Source Teacher decision", "Review Pending review",
  ]) assert.ok(t.includes(expected), expected);
  assert.match(html, /<time dateTime="2026-09-01T12:45:00.000Z">/);
  assert.equal((html.match(/data-history-entry/g) ?? []).length, 3);
  assert.ok(!t.includes("Timing After finalization Caused") && (t.match(/After finalization/g) ?? []).length === 1, "only where supplied");
  assert.ok(t.includes("All entries shown."));
  // No ids anywhere: none are in the contract, and nothing invents one.
  assert.doesNotMatch(html, /\bs-1\b|\bL1\b|teacher-|lectureId|studentId/);
});

test("student history: no canonical record, empty history, initial loading, reload keeps the entries", () => {
  const none = text(renderToStaticMarkup(<StudentHistoryBody state={stateOf(studentPage([], null, { recordExists: false, record: null })) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} />));
  assert.ok(none.includes("no attendance record for this lecture, so there is no history yet"));
  assert.ok(!none.includes("Current status"));
  assert.ok(text(renderToStaticMarkup(<StudentHistoryBody state={stateOf(studentPage([], null)) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} />)).includes("No history entries."));
  const loading = renderToStaticMarkup(<StudentHistoryBody state={stateOf(null, { loading: "first" }) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} />);
  assert.match(loading, /role="status"/);
  assert.ok(text(loading).includes("Loading the attendance history"));
  const reloading = text(renderToStaticMarkup(<StudentHistoryBody state={stateOf(studentPage([studentEntry(1)], null), { loading: "first" }) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} />));
  assert.ok(reloading.includes("Reloading") && reloading.includes("Teacher decision"), "the shown entries stay while reloading");
});

test("student history: Load more (with the loading state), a failure keeps the entries and offers Try again", () => {
  const page = studentPage([studentEntry(1), studentEntry(2)], "2");
  const more = renderToStaticMarkup(<StudentHistoryBody state={stateOf(page) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} />);
  assert.match(more, /<button type="button" class="[^"]*">Load more entries<\/button>/);
  const loadingMore = renderToStaticMarkup(<StudentHistoryBody state={stateOf(page, { loading: "more" }) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} />);
  assert.match(loadingMore, /<button type="button" disabled=""[^>]*>.*Loading…<\/button>/);
  const failed = renderToStaticMarkup(<StudentHistoryBody state={stateOf(page, { error: err("NETWORK_ERROR", 0) }) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} />);
  assert.match(failed, /role="alert"/);
  assert.ok(text(failed).includes(attendanceErrorMessage("NETWORK_ERROR")));
  assert.ok(text(failed).includes("The entries already shown are kept."));
  assert.equal((failed.match(/data-history-entry/g) ?? []).length, 2, "previous entries preserved");
  assert.match(failed, />Try again<\/button>/);
});

test("student history dialog: accessible title with the student's name; closed renders nothing; no decision / review actions", () => {
  assert.equal(renderToStaticMarkup(<StudentHistoryDialogView target={null} state={stateOf(null) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} onClose={noop} />), "");
  const html = renderToStaticMarkup(
    <StudentHistoryDialogView target={{ studentId: "s-1", name: "Asha Perera", registrationNumber: "REG-7" }} state={stateOf(studentPage([studentEntry(1)], null)) as StudentHistoryState} onLoadMore={noop} onRetry={noop} onReload={noop} onClose={noop} />
  );
  assert.match(html, /^<div data-dialog-overlay="true" class="fixed inset-0 z-50 flex items-end justify-center[^"]*sm:items-center/, "a bottom sheet on phones");
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="student-history-title" aria-describedby="student-history-description"/);
  assert.match(html, /<h2 id="student-history-title"[^>]*>Attendance history: Asha Perera<\/h2>/);
  assert.match(html, /aria-label="Close" data-autofocus="true"/);
  assert.doesNotMatch(html, /Change status|Accept evidence|Dismiss evidence|Confirm/);
  assert.doesNotMatch(html, /\binert\b/);
});

// ======================================================================================
// 4. Register history
// ======================================================================================

test("register history: every register event type, counts, reasons, actors and the QR closure", () => {
  const entries = [
    registerEntry(1, "CREATED", { actor: you, graceMinutes: { from: null, to: 10 }, scheduledStartAt: { from: null, to: "2026-09-01T12:30:00.000Z" }, scheduledEndAt: { from: null, to: "2026-09-01T14:30:00.000Z" } }),
    registerEntry(2, "GRACE_CHANGED", { actor: you, graceMinutes: { from: 10, to: 15 }, reason: "Traffic.", recalculatedCount: 4 }),
    registerEntry(3, "SCHEDULE_SYNCED", { scheduledStartAt: { from: "2026-09-01T12:30:00.000Z", to: "2026-09-01T13:00:00.000Z" }, recalculatedCount: 2 }),
    registerEntry(4, "FINALIZED", { actor: you, finalization: { finalizedAt: "2026-09-01T15:00:00.000Z", eligibleCount: 30, unknownEligibilityCount: 2, absentCreatedCount: 5 } }),
  ];
  const html = renderToStaticMarkup(
    <RegisterHistoryView expanded state={stateOf(registerPage(entries, null, { qrClosure: { closedAt: "2026-09-01T14:00:00.000Z", actor: you } })) as RegisterHistoryState} onToggle={noop} onLoadMore={noop} onRetry={noop} onReload={noop} />
  );
  const t = text(html);
  for (const expected of [
    "Register created", "Grace period changed", "Schedule synchronized", "Register finalized",
    "Grace period 10 minutes", "Grace period 10 minutes → 15 minutes", "Reason Traffic.", "Records recalculated 4", "Records recalculated 2",
    `Scheduled start ${formatColomboDateTime("2026-09-01T12:30:00.000Z")} → ${formatColomboDateTime("2026-09-01T13:00:00.000Z")}`,
    `Finalized at ${formatColomboDateTime("2026-09-01T15:00:00.000Z")}`, "Eligible students 30", "Unknown eligibility 2", "Marked absent 5",
    `QR attendance closed on ${formatColomboDateTime("2026-09-01T14:00:00.000Z")} · By: You`, "By: System", "By: You",
  ]) assert.ok(t.includes(expected), expected);
  assert.match(html, /<section aria-labelledby="register-history-heading"/);
  assert.match(html, /<h2 id="register-history-heading"/);
  assert.match(html, /aria-expanded="true" aria-controls="attendance-register-history"/);
  assert.doesNotMatch(html, /teacher-|lectureId|actorId/);
});

test("register history: collapsed by default (nothing shown), empty register, no entries, load more and errors", () => {
  const collapsed = renderToStaticMarkup(<RegisterHistoryView expanded={false} state={stateOf(null) as RegisterHistoryState} onToggle={noop} onLoadMore={noop} onRetry={noop} onReload={noop} />);
  assert.match(collapsed, /aria-expanded="false"[^>]*>Show register history</);
  assert.doesNotMatch(collapsed, /id="attendance-register-history"/, "nothing loaded or shown while collapsed");
  const none = text(renderToStaticMarkup(<RegisterHistoryView expanded state={stateOf(registerPage([], null, { registerExists: false, registerVersion: 0 })) as RegisterHistoryState} onToggle={noop} onLoadMore={noop} onRetry={noop} onReload={noop} />));
  assert.ok(none.includes("the register has no history"));
  assert.ok(text(renderToStaticMarkup(<RegisterHistoryView expanded state={stateOf(registerPage([], null)) as RegisterHistoryState} onToggle={noop} onLoadMore={noop} onRetry={noop} onReload={noop} />)).includes("No register history entries."));
  const more = renderToStaticMarkup(<RegisterHistoryView expanded state={stateOf(registerPage([registerEntry(1, "CREATED")], "1")) as RegisterHistoryState} onToggle={noop} onLoadMore={noop} onRetry={noop} onReload={noop} />);
  assert.match(more, />Load more register history<\/button>/);
  const failed = renderToStaticMarkup(<RegisterHistoryView expanded state={stateOf(registerPage([registerEntry(1, "CREATED")], "1"), { error: err("INTERNAL_SERVER_ERROR") }) as RegisterHistoryState} onToggle={noop} onLoadMore={noop} onRetry={noop} onReload={noop} />);
  assert.ok(text(failed).includes("Register created"), "kept");
  assert.match(failed, />Try again<\/button>/);
  assert.ok(text(renderToStaticMarkup(<RegisterHistoryView expanded state={stateOf(null, { loading: "first" }) as RegisterHistoryState} onToggle={noop} onLoadMore={noop} onRetry={noop} onReload={noop} />)).includes("Loading the register history"));
});

// ======================================================================================
// 5. Paging with the real loaders over a fake fetch
// ======================================================================================

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("student paging: the right lecture and student ids, the server's cursor, Load more, no duplicate entries", async () => {
  const urls: string[] = [];
  const pages = [studentPage([studentEntry(1), studentEntry(2)], "2"), studentPage([studentEntry(2), studentEntry(3)], null)];
  const loader = createStudentHistoryLoader({
    lectureId: "L 1", studentId: "s/1", onChange: noop,
    fetchImpl: async (url) => {
      urls.push(url);
      return json({ success: true, data: pages[urls.length - 1] });
    },
  });
  await loader.load();
  await loader.loadMore();
  assert.deepEqual(urls, ["/api/lectures/L%201/attendance/students/s%2F1/history?limit=50", "/api/lectures/L%201/attendance/students/s%2F1/history?cursor=2&limit=50"]);
  assert.deepEqual(loader.getState().entries.map((e) => e.version), [1, 2, 3], "an overlapping entry is shown once");
  assert.equal(loader.getState().complete, true);
});

test("a Load more failure keeps the entries; Try again repeats the SAME cursor; a first-page failure retries the first page", async () => {
  const urls: string[] = [];
  let n = 0;
  const loader = createStudentHistoryLoader({
    lectureId: "L1", studentId: "s-1", onChange: noop,
    fetchImpl: async (url) => {
      urls.push(url);
      n += 1;
      if (n === 2) return json({ success: false, error: { code: "INTERNAL_SERVER_ERROR", message: "db down at x.ts" } }, 500);
      return json({ success: true, data: n === 1 ? studentPage([studentEntry(1)], "1") : studentPage([studentEntry(2)], null) });
    },
  });
  await loader.load();
  await retryHistory(loader, "more"); // the panel's Load more
  assert.deepEqual([loader.getState().entries.map((e) => e.version), loader.getState().error?.message], [[1], attendanceErrorMessage("INTERNAL_SERVER_ERROR")]);
  await retryHistory(loader, "more"); // Try again
  assert.deepEqual(urls.slice(1), ["/api/lectures/L1/attendance/students/s-1/history?cursor=1&limit=50", "/api/lectures/L1/attendance/students/s-1/history?cursor=1&limit=50"]);
  assert.deepEqual(loader.getState().entries.map((e) => e.version), [1, 2]);

  const firstUrls: string[] = [];
  let m = 0;
  const first = createRegisterHistoryLoader({
    lectureId: "L1", onChange: noop,
    fetchImpl: async (url) => {
      firstUrls.push(url);
      m += 1;
      return m === 1 ? json({ success: false, error: { code: "NETWORK_ERROR", message: "x" } }, 503) : json({ success: true, data: registerPage([registerEntry(1, "CREATED")], null) });
    },
  });
  await first.load();
  await retryHistory(first, "first");
  assert.deepEqual(firstUrls, ["/api/lectures/L1/attendance/history?limit=50", "/api/lectures/L1/attendance/history?limit=50"]);
  assert.equal(first.getState().entries.length, 1);
});

test("inactive / deleted students: an authorized historical record is shown like any other (the API decides access)", async () => {
  const loader = createStudentHistoryLoader({
    lectureId: "L1", studentId: "s-inactive", onChange: noop,
    fetchImpl: async () => json({ success: true, data: studentPage([studentEntry(1, { action: "CREATED_AUTO", actor: system })], null, { studentId: "s-inactive", record: { status: "PRESENT", statusSource: "AUTO", version: 1, pendingReview: false } }) }),
  });
  await loader.load();
  const html = text(renderToStaticMarkup(<StudentHistoryBody state={loader.getState()} onLoadMore={noop} onRetry={noop} onReload={noop} />));
  assert.ok(html.includes("Recorded automatically") && html.includes("Current status Present"));
});

test("no duplicate concurrent requests; stale answers and dispose ignored (aborted)", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const releases: (() => void)[] = [];
  const loader = createStudentHistoryLoader({
    lectureId: "L1", studentId: "s-1", onChange: noop,
    fetchImpl: (url, init) => {
      signals.push(init?.signal);
      return new Promise<Response>((resolve) => releases.push(() => resolve(json({ success: true, data: studentPage([studentEntry(signals.length)], "9") }))));
    },
  });
  const first = loader.load();
  await tick();
  releases[0]();
  await first;
  const more = loader.loadMore();
  assert.equal(await loader.loadMore(), false, "a second Load more while one runs is refused");
  assert.equal(signals.length, 2);
  const reload = loader.load();
  assert.equal(signals[1]?.aborted, true, "reload aborts the older page request");
  releases[1]();
  assert.equal(await more, false, "its late answer is ignored");
  loader.dispose();
  assert.equal(signals[2]?.aborted, true, "dispose aborts");
  releases[2]();
  assert.equal(await reload, false);
});

// ======================================================================================
// 6. Modal behaviour (the shared hook) on fake DOM nodes
// ======================================================================================

test("modal: focus to Close, background inert, Tab contained, Escape closes (read only: always allowed), restored then focus back", () => {
  const log: string[] = [];
  type N = { id: string; tagName: string; parentElement: N | null; children: N[]; attrs: Map<string, string>; isConnected: boolean; hasAttribute(n: string): boolean; setAttribute(n: string, v: string): void; removeAttribute(n: string): void; focus(): void };
  let active: N | null = null;
  const make = (id: string, parent: N | null): N => {
    const node: N = {
      id, tagName: "DIV", parentElement: parent, children: [], attrs: new Map(), isConnected: true,
      hasAttribute: (n) => node.attrs.has(n), setAttribute: (n, v) => { node.attrs.set(n, v); log.push(`inert+${id}`); },
      removeAttribute: (n) => { node.attrs.delete(n); log.push(`inert-${id}`); }, focus: () => { active = node; log.push(`focus:${id}`); },
    };
    parent?.children.push(node);
    return node;
  };
  const body = make("body", null);
  const page = make("page", body);
  const trigger = make("history-button", page);
  const overlay = make("overlay", body);
  const dlg = make("dialog", overlay);
  const close = make("close", dlg);
  const more = make("load-more", dlg);
  const inside = [close, more];
  let handler: ((e: FocusKeyEvent) => void) | null = null;
  let closed = 0;
  trigger.focus();
  log.length = 0;
  const { release } = activateModalDialog({
    dialog: () => ({ focus: () => dlg.focus(), querySelectorAll: () => inside, querySelector: (s: string) => (s.startsWith("[data-autofocus]") ? close : null), contains: (n: unknown) => inside.includes(n as N) }),
    overlay, stopAt: body, activeElement: () => active, canClose: () => true, onClose: () => { closed += 1; },
    listen: (h) => { handler = h; return () => { handler = null; }; },
  });
  assert.deepEqual(log, ["focus:close", "inert+page"]);
  active = more;
  handler!({ key: "Tab", shiftKey: false, preventDefault: noop });
  assert.equal(active, close, "wraps inside");
  handler!({ key: "Escape", shiftKey: false, preventDefault: noop });
  assert.equal(closed, 1);
  log.length = 0;
  release();
  assert.deepEqual(log, ["inert-page", "focus:history-button"]);
});

// ======================================================================================
// 7. Wiring (source)
// ======================================================================================

test("wiring: dialog and section in the panel; the shared modal hook; loaders disposed; no lecture-wide student feed", () => {
  const views = source("components", "attendance", "history-views.tsx");
  assert.match(views, /useModalDialog\(\{ open, dialogRef, overlayRef, canClose: \(\) => true, onClose, fallbackId: REGISTER_STUDENTS_ID \}\)/);
  assert.doesNotMatch(views, /createDialogFocusManager|makeOutsideInert/, "no duplicated accessibility utilities");
  assert.match(views, /const loader = createStudentHistoryLoader\(\{ lectureId, studentId, onChange: setState \}\);/);
  assert.match(views, /return \(\) => \{\s*loader\.dispose\(\);/);
  assert.equal((views.match(/loader\.dispose\(\);/g) ?? []).length, 2, "both loaders disposed on close / unmount");
  const section = views.slice(views.indexOf("export function RegisterHistorySection"));
  assert.doesNotMatch(section, /createStudentHistoryLoader|fetchStudentHistory/, "the register section never builds a student feed");
  assert.doesNotMatch(views, /submitDecision|submitReview|submitAttendance/, "no decision or review action in history");

  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  assert.match(panel, /onViewHistory=\{openHistory\}/);
  assert.match(panel, /<RegisterHistorySection lectureId=\{lectureId\} registerVersion=\{state\.register\.register\.version\} \/>/);
  assert.match(panel, /<StudentHistoryDialog lectureId=\{lectureId\} target=\{historyTarget\} onClose=\{closeHistory\} \/>/);
  assert.equal((panel.match(/createRecordActionController\(/g) ?? []).length, 1, "decisions and reviews unchanged: one controller");
});
