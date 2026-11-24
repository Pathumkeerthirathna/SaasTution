/**
 * The Attendance workspace (/dashboard/attendance): the selected lecture's
 * attendance management under the class matrix, built from the EXISTING
 * register (LectureAttendanceRegisterPanel, variant="embedded") — the same
 * load, summary, QR controls, reconciliation, finalization, grace, student
 * table, decisions, reviews, histories, controllers and APIs as the register
 * page, which keeps working unchanged.
 *
 * No DOM library is installed: the views are rendered with react-dom/server
 * from register fixtures shaped like GET /api/lectures/[id]/attendance; the
 * compact actions are invoked directly; the React wiring (keyed per lecture,
 * refresh chain, no navigation) is checked from source. The server rules
 * (reconciliation never overrides a teacher decision, finalization
 * preview / fingerprint / irreversibility, decision audit) are exercised by
 * their own suites, run alongside: tests/attendance/reconcile.test.cjs,
 * finalization-service.test.cjs, attendance-decisions.test.cjs,
 * api-*-route.test.cjs, and tests/ui/attendance-finalization.test.tsx,
 * attendance-decision-dialog.test.tsx, attendance-history-ui.test.tsx.
 * Clicking through a real browser remains a manual check.
 *
 *   npm run test:attendance-ui
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AttendanceMatrix, AttendanceRegisterResponse } from "../../components/attendance/attendance-ui";
import { DEFAULT_REGISTER_FILTERS, RegisterErrorView, RegisterView, filterRegisterStudents } from "../../components/attendance/lecture-attendance-register-panel";
import { CHANGE_STATUS_LABEL, DecisionAction } from "../../components/attendance/decision-dialog";
import { HistoryAction, VIEW_HISTORY_LABEL } from "../../components/attendance/history-views";
import { QrScanEntry } from "../../components/attendance/qr-scan-entry";
import { ReconcileSection, reconcileAvailability } from "../../components/attendance/reconcile-section";
import { FinalizationSection, finalizeAvailability } from "../../components/attendance/finalization-dialog";
import { matrixLoadingState } from "../../components/attendance/attendance-take-section";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const noop = () => {};

const TAKE = () => code(source("components", "attendance", "attendance-take-section.tsx"));
const PANEL = () => code(source("components", "attendance", "lecture-attendance-register-panel.tsx"));

type Student = AttendanceRegisterResponse["students"][number];

const record = (fields: Partial<NonNullable<Student["record"]>> = {}): NonNullable<Student["record"]> => ({
  status: "PRESENT",
  statusSource: "AUTO",
  autoStatus: "PRESENT",
  teacherStatus: null,
  firstOnlineAt: null,
  firstQrAt: null,
  teacherDecidedAt: null,
  version: 1,
  ...fields,
});

const student = (studentId: string, name: string, registrationNumber: string | null, fields: Partial<Student> = {}): Student => ({
  studentId,
  name,
  registrationNumber,
  eligibility: { outcome: "ELIGIBLE", reason: "ELIGIBLE", approvalReason: "KNOWN_APPROVED" },
  absenceDecision: "HAS_RECORD",
  record: record(),
  review: { pending: false, since: null },
  ...fields,
});

function fixture(overrides: Partial<AttendanceRegisterResponse> = {}): AttendanceRegisterResponse {
  return {
    lecture: { id: "lec-1", classId: "class-1", title: "Kinematics II", classStatus: "COMPLETED", date: "2026-11-23T03:30:00.000Z", endDate: "2026-11-23T05:30:00.000Z" },
    register: {
      lectureId: "lec-1", exists: true, scheduledStartAt: "2026-11-23T03:30:00.000Z", scheduledEndAt: "2026-11-23T05:30:00.000Z",
      graceMinutes: 15, version: 3, finalized: false, finalizedAt: null,
    },
    configuration: { approval: "OK", evidence: "OK" },
    classification: "LIVE",
    students: [
      student("s-amal", "Amal Perera", "REG-101", { record: record({ firstOnlineAt: "2026-11-23T03:33:00.000Z" }) }),
      student("s-nimali", "Nimali Silva", "REG-102", { record: record({ status: "LATE", autoStatus: "LATE", firstQrAt: "2026-11-23T03:50:00.000Z" }) }),
      student("s-kasun", "Kasun Fernando", "REG-103", {
        record: record({ status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", autoStatus: "LATE", firstQrAt: "2026-11-23T04:05:00.000Z", teacherDecidedAt: "2026-11-23T06:00:00.000Z" }),
        review: { pending: true, since: "2026-11-23T04:05:00.000Z" },
      }),
      student("s-dilan", "Dilan Jayasuriya", "REG-104", { record: record({ status: "EXCUSED", statusSource: "TEACHER", teacherStatus: "EXCUSED", autoStatus: null, teacherDecidedAt: "2026-11-23T06:10:00.000Z" }) }),
      student("s-ruwan", "Ruwan Bandara", null, { record: null, absenceDecision: "CREATE_ABSENT" }),
    ],
    // Deliberately NOT derivable from the students above: the cards must show the server's numbers.
    summary: { students: 41, withRecord: 30, recordStatus: { PRESENT: 17, LATE: 6, ABSENT: 4, EXCUSED: 3 }, pendingReviews: 2 },
    absencePreview: { automaticAbsentStudentIds: ["s-ruwan"], manualReviewStudentIds: [], eligibleCount: 5, unknownEligibilityCount: 0, absentCreatedCount: 1 },
    onlineEvidence: { complete: false, pending: [{ studentId: "s-ruwan", earliestEligibleVisitAt: "2026-11-23T03:40:00.000Z" }], unknownVisits: [] },
    activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "SCHEDULED_END_PASSED" }, configured: true },
    qr: { closed: false, closedAt: null, opensAt: "2026-11-23T03:00:00.000Z", window: "OPEN" },
    ...overrides,
  } as AttendanceRegisterResponse;
}

/** The embedded register as the panel renders it (the panel passes exactly these props when embedded). */
function embedded(register: AttendanceRegisterResponse, extra: { filters?: typeof DEFAULT_REGISTER_FILTERS; reconciling?: boolean } = {}) {
  return renderToStaticMarkup(
    <RegisterView
      register={register}
      filters={extra.filters ?? DEFAULT_REGISTER_FILTERS}
      onFiltersChange={noop}
      onChangeStatus={noop}
      onReview={noop}
      onViewHistory={noop}
      onChangeGrace={noop}
      onCloseQrAttendance={noop}
      variant="embedded"
      className="Physics – Grade 12"
      onOpenScanner={noop}
      compactActions
      actions={
        <>
          <ReconcileSection availability={reconcileAvailability(register)} state={{ phase: "idle" }} onStart={noop} onCancel={noop} />
          <FinalizationSection register={register} availability={finalizeAvailability(register, extra.reconciling ?? false)} onPreview={noop} />
        </>
      }
    />
  );
}

// =========================================================================================================
// 1-3. Selected lecture state
// =========================================================================================================

test("1. selecting a lecture mounts the existing register for it (one panel, the register API, keyed by the lecture)", () => {
  const take = TAKE();
  assert.match(
    take,
    /\{mode === "REGISTER" \? \([\s\S]*?<LectureAttendanceRegisterPanel key=\{lectureId\} lectureId=\{lectureId\} variant="embedded" onOpenScanner=\{openSelectedScanner\} refreshKey=\{registerRefresh\} \/>/
  );
  assert.match(take, /import\("@\/components\/attendance\/lecture-attendance-register-panel"\)\.then\(\(mod\) => mod\.LectureAttendanceRegisterPanel\)/, "the same panel, loaded lazily");
  // The panel loads the register through the existing API helper only.
  const panel = PANEL();
  assert.match(panel, /const result = await fetchAttendanceRegister\(lectureId, \{ signal: controller\.signal \}\);/);
  assert.doesNotMatch(take, /fetchAttendanceRegister|\/api\/lectures\/[^"`]*\/attendance|runReconciliation|finalizeAttendance/, "the page itself calls no register API");
});

test("2. changing the lecture loads that lecture's register (a new key remounts the panel: no state of the previous lecture)", () => {
  const take = TAKE();
  assert.match(take, /key=\{lectureId\}/);
  const change = take.slice(take.indexOf("const changeLecture"), take.indexOf("const openScannerModal"));
  assert.match(change, /setLectureId\(next\)/);
  // Inside the panel, every controller and dialog is per lecture as well (unchanged).
  const panel = PANEL();
  for (const deps of ["}, [lectureId, load]);", "useEffect(() => setHistoryTarget(null), [lectureId]);", "[lectureId]\n  );"]) {
    assert.ok(panel.includes(deps), deps);
  }
});

test("3. clearing the lecture (or changing the class or month) hides the register and shows the monthly overview; nothing is chosen automatically", () => {
  const take = TAKE();
  assert.match(take, /No lecture selected: the month&apos;s attendance overview is shown below\./);
  assert.match(take, /Choose a class \(Change\) to see its attendance for/);
  const reset = take.slice(take.indexOf("const resetLectures"), take.indexOf("const changeClass"));
  assert.match(reset, /setLectureId\(""\)/);
  // The lecture is only ever set by the teacher (the selector, "Back to the monthly overview")
  // or the creation dialog's lecture; cleared by a class or month change.
  assert.deepEqual(
    (take.match(/setLectureId\(([^)]*)\)/g) ?? []).sort(),
    ['setLectureId("")', 'setLectureId("")', "setLectureId(lecture.id)", "setLectureId(next)"].sort()
  );
});

// =========================================================================================================
// 4. Lecture information, summary cards, QR and register controls
// =========================================================================================================

test("4. header and summary: class, title, start / end, lecture status, finalization, grace; the server's counts (never recalculated)", () => {
  const html = embedded(fixture());
  const t = text(html);
  assert.match(t, /Physics – Grade 12/);
  assert.match(html, /<h3[^>]*>Kinematics II<\/h3>/, "an h3 under the page's sections (one h1 on the page)");
  assert.doesNotMatch(html, /<h1/);
  assert.match(t, /Scheduled start 23 Nov 2026, 09:00/);
  assert.match(t, /Scheduled end 23 Nov 2026, 11:00/);
  assert.match(t, /Lecture status: Completed/);
  assert.match(t, /Grace period 15 minutes/);
  assert.match(t, /Finalized Not finalized/);
  for (const [label, value] of [["Students", 41], ["Present", 17], ["Late", 6], ["Absent", 4], ["Excused", 3], ["Pending reviews", 2]] as const) {
    assert.match(t, new RegExp(`${label} ${value}`), `${label} shows the server's ${value}`);
  }
  // The panel never computes counts itself.
  assert.doesNotMatch(PANEL(), /\.filter\([^)]*status === "PRESENT"|reduce\(/);
});

test("5. QR attendance in the register opens the page's scanner modal (no link to the scanner route); its status and opening time are shown", () => {
  const html = embedded(fixture());
  assert.match(text(html), /QR attendance QR scanning: Open/);
  assert.match(text(html), /Open QR scanner/);
  assert.doesNotMatch(html, /href="\/dashboard\/attendance\/lec-1\/scan"/);
  assert.match(text(html), /Close QR attendance/, "the existing closure action is kept");
  const notOpen = text(renderToStaticMarkup(<QrScanEntry register={fixture({ qr: { closed: false, closedAt: null, opensAt: "2026-11-23T03:00:00.000Z", window: "NOT_OPEN" } })} onOpenScanner={noop} />));
  assert.match(notOpen, /Scanning opens at 23 Nov 2026, 08:30, 30 minutes before the scheduled start\./);
  assert.doesNotMatch(notOpen, /Open QR scanner/, "offered only while scanning is available");
  // The page wires it to the same modal as Open QR Scanner.
  const take = TAKE();
  assert.match(take.slice(take.indexOf("const openSelectedScanner")), /if \(lectureId\) openScannerModal\(lectureId\);/);
  // The standalone register keeps its link.
  assert.match(renderToStaticMarkup(<QrScanEntry register={fixture()} />), /href="\/dashboard\/attendance\/lec-1\/scan"/);
});

test("6. after QR scanning the register reloads (refreshKey), and every register reload reloads the matrix once (onRefreshed)", () => {
  const take = TAKE();
  const close = take.slice(take.indexOf("const closeScanner"), take.indexOf("const openSelectedScanner"));
  assert.match(close, /if \(lectureId\) setRegisterRefresh\(\(n\) => n \+ 1\);\s+else reloadMatrix\(\);/);
  const panel = PANEL();
  assert.match(panel, /if \(refreshKey === lastRefreshKey\.current\) return;\s+lastRefreshKey\.current = refreshKey;\s+void load\("refresh"\);/, "not on mount; on every change");
  const load = panel.slice(panel.indexOf("const load = useCallback"), panel.indexOf("useEffect(() => {\n    void load(\"initial\")"));
  assert.match(load, /if \(!gate\.current\.isCurrent\(id\) \|\| controller\.signal\.aborted\) return false;/, "a superseded reload reports nothing");
  assert.match(load, /if \(mode === "refresh"\) onRefreshedRef\.current\?\.\(true\);/);
  assert.match(load, /else onRefreshedRef\.current\?\.\(false\);/, "a failed reload still refreshes the matrix");
  // Every action refreshes through load("refresh") (unchanged): reconciliation, finalization, decisions, reviews, grace, QR closure.
  assert.equal((panel.match(/refresh: \(\) => load\("refresh"\)/g) ?? []).length, 4);
  assert.match(panel, /refresh: async \(\) => \(\(await load\("refresh"\)\) \? latestRegister\.current : null\)/);
});

test("the matrix stays on screen while the same month reloads; another class or month shows loading", () => {
  const matrix = { class: { id: "C1" }, month: { key: "2026-11" } } as unknown as AttendanceMatrix;
  const ready = { kind: "ready" as const, matrix };
  assert.deepEqual(matrixLoadingState(ready, "C1", "2026-11"), { kind: "ready", matrix, refreshing: true });
  assert.deepEqual(matrixLoadingState(ready, "C1", null), { kind: "ready", matrix, refreshing: true });
  assert.deepEqual(matrixLoadingState(ready, "C1", "2026-12"), { kind: "loading" });
  assert.deepEqual(matrixLoadingState(ready, "C2", "2026-11"), { kind: "loading" });
  assert.deepEqual(matrixLoadingState({ kind: "idle" }, "C1", null), { kind: "loading" });
});

// =========================================================================================================
// 7-11. Reconciliation and finalization (the existing sections and controllers)
// =========================================================================================================

test("7-8. online evidence: the notice and the existing reconciliation section; one reconciliation controller, the existing API", () => {
  const t = text(embedded(fixture()));
  assert.match(t, /Online evidence not yet recorded: 1 student\(s\)/);
  assert.match(t, /Online evidence/);
  const panel = PANEL();
  assert.equal((panel.match(/createReconcileController\(/g) ?? []).length, 1);
  assert.match(panel, /run: runReconciliation,/);
  // Teacher decisions are protected on the server (reconcile.test.cjs: "teacher decisions are preserved…"); nothing client-side decides.
  const reconcileTests = source("tests", "attendance", "reconcile.test.cjs");
  assert.match(reconcileTests, /test\("teacher decisions are preserved: stronger evidence raises a review, weaker is only recorded"/);
  assert.match(reconcileTests, /test\("concurrent with a teacher decision: the decision stays authoritative"/);
});

test("9-11. finalization: Preview first (the existing two-step dialog); finalized registers lock the actions the rules lock", () => {
  const open = text(embedded(fixture()));
  assert.match(open, /Finalize attendance Review what finalization will do, then confirm\. Finalization cannot be undone\. Preview finalization/);
  const panel = PANEL();
  assert.match(panel, /const openFinalization = useCallback\(\(\) => void finalization\.current\?\.open\(\), \[\]\);/);
  assert.match(panel, /const confirmFinalization = useCallback\(\(\) => void finalization\.current\?\.confirm\(acknowledged\), \[acknowledged\]\);/, "confirmation needs the explicit acknowledgement");
  assert.match(source("tests", "ui", "attendance-finalization.test.tsx"), /blockers and the acknowledgement: confirmation is refused without both \(no request sent\)/);
  // While reconciling, finalization waits.
  assert.match(text(embedded(fixture(), { reconciling: true })), /Preview finalization/);
  assert.deepEqual(finalizeAvailability(fixture(), true), { allowed: false, reason: "Wait for online evidence reconciliation to finish." });

  const finalized = fixture({ register: { ...fixture().register, finalized: true, finalizedAt: "2026-11-23T07:00:00.000Z" } });
  const html = embedded(finalized);
  const t = text(html);
  assert.match(t, /Finalized on 23 Nov 2026, 12:30\. Finalization cannot be undone\./);
  assert.doesNotMatch(t, /Preview finalization/);
  assert.doesNotMatch(html, /data-grace-action|Change the grace period/, "the grace period is frozen once finalized");
  // Manual changes stay possible after finalization exactly as before (a reason is required by the dialog and the server).
  assert.match(html, /data-decision-action="s-amal"/);
});

// =========================================================================================================
// 12-17. Student table, compact actions, histories, grace, filters
// =========================================================================================================

test("12-14. compact actions: pencil = the existing Change status dialog, clock = the existing history dialog (tooltips, accessible names)", () => {
  const register = fixture();
  const amal = register.students[0];
  const opened: string[] = [];
  const decision = DecisionAction({ student: amal, register, onOpen: (s) => opened.push(`decision:${s.studentId}`), compact: true }) as ReactElement<{ onClick: () => void; title: string; "aria-label": string; className: string }>;
  const history = HistoryAction({ student: amal, onOpen: (s) => opened.push(`history:${s.studentId}`), compact: true }) as ReactElement<{ onClick: () => void; title: string; "aria-label": string; className: string }>;
  decision.props.onClick();
  history.props.onClick();
  assert.deepEqual(opened, ["decision:s-amal", "history:s-amal"], "the same handlers the panel uses (openDecision / openHistory)");
  assert.equal(decision.props.title, CHANGE_STATUS_LABEL);
  assert.equal(decision.props["aria-label"], "Change attendance status: Amal Perera");
  assert.equal(history.props.title, VIEW_HISTORY_LABEL);
  assert.equal(history.props["aria-label"], "View attendance history: Amal Perera");
  for (const el of [decision, history]) assert.match(el.props.className, /h-10 w-10 shrink-0 .*md:h-9 md:w-9/, "touch-sized icons");

  const html = embedded(register);
  assert.equal((html.match(/data-decision-action="s-amal"/g) ?? []).length, 2, "table and card layouts");
  assert.doesNotMatch(text(html), /Change status|View history/, "no text buttons in the embedded register");
  // Review answers keep their labelled buttons (Accept / Dismiss evidence).
  assert.match(text(html), /Dismiss/);
  // The panel's dialogs are the existing ones; decisions and reviews go through one controller (audit on the server).
  const panel = PANEL();
  for (const dialog of ["<DecisionDialog", "<ReviewDialog", "<StudentHistoryDialog lectureId={lectureId}", "<GraceDialog", "<QrClosureDialog", "<FinalizationDialog"]) assert.ok(panel.includes(dialog), dialog);
  assert.equal((panel.match(/createRecordActionController\(/g) ?? []).length, 1);
  assert.match(source("tests", "attendance", "attendance-decisions.test.cjs"), /audit/i);
});

test("15. register history: the existing collapsible section, reloaded when the register version changes", () => {
  assert.match(PANEL(), /<RegisterHistorySection lectureId=\{lectureId\} registerVersion=\{state\.register\.register\.version\} \/>/);
  const history = source("components", "attendance", "history-views.tsx");
  assert.match(history, /const \[expanded, setExpanded\] = useState\(false\);/, "collapsed by default");
  assert.match(history, /\}, \[expanded, registerVersion\]\);/);
});

test("16. grace period: the existing Change action in the header (open register, lecture not cancelled)", () => {
  assert.match(embedded(fixture()), /data-grace-action|Change/);
  assert.match(text(embedded(fixture())), /Grace period 15 minutes Change/);
});

test("17. search and filters: the existing controls and the same filtering on the loaded data", () => {
  const html = embedded(fixture());
  assert.match(text(html), /Search by name or registration number/);
  assert.match(text(html), /Attendance status/);
  assert.match(text(html), /Review/);
  const all = fixture().students;
  assert.deepEqual(filterRegisterStudents(all, { search: "reg-103", status: "ALL", review: "ALL" }).map((s) => s.studentId), ["s-kasun"]);
  assert.deepEqual(filterRegisterStudents(all, { search: "", status: "NO_RECORD", review: "ALL" }).map((s) => s.studentId), ["s-ruwan"]);
  assert.deepEqual(filterRegisterStudents(all, { search: "", status: "ALL", review: "PENDING" }).map((s) => s.studentId), ["s-kasun"]);
  const filtered = text(embedded(fixture(), { filters: { search: "nimali", status: "ALL", review: "ALL" } }));
  assert.match(filtered, /Showing 1 of 5 student\(s\)/);
  // Every student field is kept.
  for (const column of ["Student", "Registration no.", "Status", "Source", "Evidence", "First online", "First QR", "Teacher decision", "Eligibility at start", "Review", "Actions"]) {
    assert.ok(text(html).includes(column), column);
  }
});

// =========================================================================================================
// 18-19. Responsive layout and the standalone register
// =========================================================================================================

test("18. responsive: cards 2 / 3 / 6 columns; table only from md (scrolls inside), cards below; no page-level overflow", () => {
  const html = embedded(fixture());
  assert.match(html, /aria-label="Summary" class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"/);
  assert.match(html, /class="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block" data-layout="table"/);
  assert.match(html, /class="w-full min-w-\[1220px\] text-left text-sm"/, "compact actions: a narrower table");
  assert.match(html, /<ul class="flex flex-col gap-2 md:hidden" data-layout="cards">/);
  assert.doesNotMatch(html, /\btruncate\b|line-clamp/);
  const take = source("components", "attendance", "attendance-take-section.tsx");
  assert.match(take, /className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm" data-selection-bar>/, "the selection bar (its rows have 12px padding)");
  assert.match(take, /<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3">/);
  // Register and matrix sit directly under the control card (no second card or visible heading).
  assert.match(take, /className="flex min-w-0 flex-col" data-workspace-mode="register"/);
  assert.match(take, /className="flex min-w-0 flex-col border-t border-slate-200"\s+data-workspace-mode=/, "the matrix inside the control card, below a divider");
  assert.equal((take.match(/<section[^>]*rounded-xl border border-slate-200 bg-white/g) ?? []).length, 1, "one card section");
  assert.match(source("components", "attendance", "lecture-attendance-register-panel.tsx"), /<div className="flex w-full min-w-0 flex-col gap-4" data-register-variant=\{variant\}>/);
});

test("19. the standalone register route renders the same panel unchanged (page variant: h1, Back to lectures, text actions, scanner link)", () => {
  const page = source("app", "dashboard", "attendance", "[lectureId]", "page.tsx");
  assert.match(page, /<LectureAttendanceRegisterPanel lectureId=\{params\.lectureId\} \/>/);
  const html = renderToStaticMarkup(
    <RegisterView register={fixture()} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={noop} onChangeStatus={noop} onReview={noop} onViewHistory={noop} onChangeGrace={noop} onCloseQrAttendance={noop} />
  );
  assert.match(html, /<h1[^>]*>Kinematics II<\/h1>/);
  assert.match(text(html), /Change status/);
  assert.match(text(html), /View history/);
  assert.match(html, /href="\/dashboard\/attendance\/lec-1\/scan"/);
  assert.match(html, /min-w-\[1340px\]/);
  const panel = PANEL();
  assert.match(panel, /\{embedded \? null : \(\s*<div className="flex flex-wrap items-center justify-between gap-2">\s*<Link href="\/dashboard\/lectures"/);
  assert.match(panel, /export function LectureAttendanceRegisterPanel\(\{\s*lectureId,\s*variant = "page",/);
  // Errors: the page keeps "Back to lectures"; embedded, no link away from the workspace.
  const err = { ok: false as const, status: 0, code: "NETWORK_ERROR", message: "Could not reach the server." };
  assert.match(renderToStaticMarkup(<RegisterErrorView error={err} onRetry={noop} />), /href="\/dashboard\/lectures"/);
  assert.doesNotMatch(renderToStaticMarkup(<RegisterErrorView error={err} onRetry={noop} backLink={false} />), /href=/);
});

// =========================================================================================================
// Visual refinement (the Students page's header and card pattern)
// =========================================================================================================

test("page header: compact (icon box, 20px title 'Attendance', 12-13px subtitle); no full-width navy hero", () => {
  const overview = source("components", "attendance", "attendance-overview-panel.tsx");
  const heading = source("components", "attendance", "attendance-page-heading.tsx");
  const header = heading.slice(heading.indexOf("<header"), heading.indexOf("</header>"));
  assert.match(header, /<header className="flex min-w-0 items-center gap-3" data-page-header>/, "no card of its own");
  assert.match(header, /<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-\[#32598A\] text-white">\s*<ClipboardList size=\{18\} aria-hidden \/>/);
  assert.match(header, /<h1 className="text-xl font-semibold tracking-tight text-slate-900">Attendance<\/h1>/);
  assert.match(header, /className="break-words text-\[12px\] text-slate-500 sm:text-\[13px\]">Manage class attendance and lecture registers\./);
  assert.doesNotMatch(overview, /rounded-2xl bg-\[#112D5C\] p-4 text-white/, "the navy hero is gone");
  // The existing list keeps a (smaller) section heading.
  assert.match(overview, /<h2 className="mt-1 flex items-center gap-2 text-base font-semibold text-slate-900">[\s\S]*?Attendance registers/);
});

test("summary cards: icon box, small label, clearly readable value; the server's numbers, 2 / 3 / 6 columns", () => {
  const html = embedded(fixture());
  const cards = html.match(/<div class="flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm" data-summary-card="[^"]*">[\s\S]*?<\/div><\/div>/g) ?? [];
  assert.equal(cards.length, 6);
  for (const card of cards) {
    assert.match(card, /<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg [^"]+"><svg[^>]*width="16"/);
    assert.match(card, /<p class="break-words text-\[12px\] font-medium leading-tight text-slate-500">/);
    assert.match(card, /<p class="mt-0\.5 text-2xl font-semibold leading-none tabular-nums text-slate-900">\d+<\/p>/);
  }
  assert.match(cards[1], /bg-emerald-50 text-emerald-700[\s\S]*Present[\s\S]*>17</);
  assert.match(cards[3], /bg-rose-50 text-rose-700[\s\S]*Absent[\s\S]*>4</);
});

test("embedded register header: a light card (class, h3 title, status, schedule); the standalone register keeps its navy header", () => {
  const html = embedded(fixture());
  assert.match(html, /<section class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm" aria-label="Lecture" data-register-header="embedded">/);
  assert.match(html, /<h3 class="mt-0\.5 break-words text-lg font-semibold text-slate-900">Kinematics II<\/h3>/);
  assert.doesNotMatch(html, /bg-\[#112D5C\] p-4 text-white/);
  const page = renderToStaticMarkup(<RegisterView register={fixture()} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={noop} />);
  assert.match(page, /<section class="rounded-2xl bg-\[#112D5C\] p-4 text-white shadow-sm sm:p-5" aria-label="Lecture">/);
  assert.match(page, /<h1 class="mt-1 break-words text-xl font-bold sm:text-2xl">Kinematics II<\/h1>/);
});

test("controls: 12px labels, 13px values, 40px selectors and Open QR Scanner, 38px month / back buttons, 16px headings", () => {
  const take = source("components", "attendance", "attendance-take-section.tsx");
  assert.equal((take.match(/className="flex min-w-0 flex-1 flex-col gap-1 text-\[12px\] font-medium text-slate-600"/g) ?? []).length, 2);
  assert.equal((take.match(/className="h-10 min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-\[13px\]/g) ?? []).length, 2);
  assert.match(take, /className="inline-flex h-10 min-h-\[40px\] items-center justify-center gap-1\.5 rounded-lg bg-\[#112D5C\] px-4 text-\[13px\] font-semibold/);
  assert.match(take, /const SECONDARY_BUTTON =\s+"inline-flex h-\[38px\] items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-\[13px\] font-medium text-slate-700 hover:border-\[#8fb0cd\] hover:bg-\[#eef3f8\] hover:text-\[#264867\]";/);
  assert.equal((take.match(/className=\{SECONDARY_BUTTON\}/g) ?? []).length, 1, "Monthly overview (Previous / Next are the month control's own buttons)");
  assert.equal((take.match(/className=\{MONTH_STEP_BUTTON\}/g) ?? []).length, 2);
  assert.match(take, /const MONTH_STEP_BUTTON =\s+"inline-flex h-\[38px\] items-center gap-1 rounded-md px-2\.5 text-\[13px\] font-medium/);
  assert.match(take, /className=\{`\$\{SECONDARY_BUTTON\} h-10`\}/, "Done (40px, beside Open QR Scanner)");
  assert.match(take, /className="break-words text-\[16px\] font-semibold leading-snug text-slate-900"/, "the control card's 16px title");
  assert.doesNotMatch(take, /text-base font-semibold text-slate-900/, "no second visible section heading");
  assert.doesNotMatch(take, /text-(xl|2xl|3xl)|h-11|h-12/, "nothing oversized in the workspace");
  // The selector row keeps the button aligned with the selectors and stacks on small screens.
  assert.match(take, /className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end"/);
});

test("summary first: in the embedded register the six cards come right after the lecture header; the register page keeps its order", () => {
  const html = embedded(fixture());
  const header = html.indexOf('data-register-header="embedded"');
  const summary = html.indexOf('aria-label="Summary"');
  assert.ok(header < summary, "after the header");
  for (const later of ["QR attendance", 'aria-label="Online evidence reconciliation"', 'aria-label="Finalize attendance"', 'aria-label="Filters"']) {
    assert.ok(summary < html.indexOf(later), `before ${later}`);
  }
  assert.match(html, /<div class="flex flex-col gap-3"><section class="rounded-xl border border-slate-200 bg-white p-3/, "12px gaps when embedded");
  // The register page: QR and actions first, then the summary (unchanged).
  const page = renderToStaticMarkup(<RegisterView register={fixture()} filters={DEFAULT_REGISTER_FILTERS} onFiltersChange={noop} actions={<p>ACTIONS</p>} />);
  assert.ok(page.indexOf("ACTIONS") < page.indexOf('aria-label="Summary"'));
  assert.ok(page.indexOf("QR attendance") < page.indexOf('aria-label="Summary"'));
  assert.match(page, /<div class="flex flex-col gap-4">/);
  assert.equal((html.match(/aria-label="Summary"/g) ?? []).length, 1, "rendered once");
});
