/**
 * The read-only attendance register page (Stage 5.5d-2):
 * components/attendance/lecture-attendance-register-panel.tsx, its page
 * wrapper and the lecture list's Register link. The register, error and
 * loading views render with react-dom/server from fixture data shaped like
 * the GET /api/lectures/[id]/attendance contract; the panel's loading effect
 * and the wiring are checked from source. Clicking through the real page
 * remains a manual check.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_REGISTER_FILTERS,
  RegisterErrorView,
  RegisterLoadingView,
  RegisterView,
  filterRegisterStudents,
  formatColomboDateTime,
  type RegisterFilters,
} from "../../components/attendance/lecture-attendance-register-panel";
import type { AttendanceApiError, AttendanceRegisterResponse } from "../../components/attendance/attendance-ui";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

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
    lecture: { id: "lec-1", classId: "class-1", title: "Kinematics II", classStatus: "COMPLETED", date: "2026-09-01T12:30:00.000Z", endDate: "2026-09-01T14:30:00.000Z" },
    register: {
      lectureId: "lec-1", exists: true, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: "2026-09-01T14:30:00.000Z",
      graceMinutes: 10, version: 3, finalized: false, finalizedAt: null,
    },
    configuration: { approval: "OK", evidence: "OK" },
    classification: "LIVE",
    students: [
      student("s-amal", "Amal Perera", "REG-101", { record: record({ firstOnlineAt: "2026-09-01T12:33:00.000Z" }) }),
      student("s-nimali", "Nimali Silva", "REG-102", {
        record: record({ status: "LATE", autoStatus: "LATE", firstQrAt: "2026-09-01T12:50:00.000Z", firstOnlineAt: "2026-09-01T12:55:00.000Z" }),
      }),
      student("s-kasun", "Kasun Fernando", "REG-103", {
        record: record({ status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", autoStatus: "LATE", firstQrAt: "2026-09-01T13:05:00.000Z", teacherDecidedAt: "2026-09-01T15:00:00.000Z" }),
        review: { pending: true, since: "2026-09-01T13:05:00.000Z" },
      }),
      student("s-dilan", "Dilan Jayasuriya", "REG-104", {
        record: record({ status: "EXCUSED", statusSource: "TEACHER", teacherStatus: "EXCUSED", autoStatus: null, teacherDecidedAt: "2026-09-01T15:10:00.000Z" }),
      }),
      student("s-ruwan", "Ruwan Bandara", null, { record: null, absenceDecision: "CREATE_ABSENT" }),
      student("s-unknown", "Sachini Weerasinghe", "REG-106", {
        record: null,
        eligibility: { outcome: "UNKNOWN", reason: "APPROVAL_UNKNOWN", approvalReason: "BROKEN_HISTORY" },
        absenceDecision: "MANUAL_REVIEW",
      }),
    ],
    summary: { students: 6, withRecord: 4, recordStatus: { PRESENT: 1, LATE: 1, ABSENT: 1, EXCUSED: 1 }, pendingReviews: 1 },
    absencePreview: { automaticAbsentStudentIds: ["s-ruwan"], manualReviewStudentIds: ["s-unknown"], eligibleCount: 5, unknownEligibilityCount: 1, absentCreatedCount: 1 },
    onlineEvidence: { complete: true, pending: [], unknownVisits: [] },
    activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: true, basis: "SCHEDULED_END_PASSED" }, configured: true },
    qr: { closed: false, closedAt: null, opensAt: "2026-09-01T12:00:00.000Z", window: "OPEN" },
    ...overrides,
  };
}

const render = (register: AttendanceRegisterResponse, filters: RegisterFilters = DEFAULT_REGISTER_FILTERS) =>
  renderToStaticMarkup(<RegisterView register={register} filters={filters} onFiltersChange={() => {}} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const ids = (students: Student[]) => students.map((s) => s.studentId);

// ---- Filtering (pure) --------------------------------------------------------------------------

test("filter: search by name or registration number (trimmed, case-insensitive), on loaded data", () => {
  const all = fixture().students;
  assert.deepEqual(ids(filterRegisterStudents(all, DEFAULT_REGISTER_FILTERS)), ids(all));
  assert.deepEqual(ids(filterRegisterStudents(all, { ...DEFAULT_REGISTER_FILTERS, search: "  perera " })), ["s-amal"]);
  assert.deepEqual(ids(filterRegisterStudents(all, { ...DEFAULT_REGISTER_FILTERS, search: "reg-10" })), ["s-amal", "s-nimali", "s-kasun", "s-dilan", "s-unknown"]);
  assert.deepEqual(ids(filterRegisterStudents(all, { ...DEFAULT_REGISTER_FILTERS, search: "REG-103" })), ["s-kasun"]);
  assert.deepEqual(ids(filterRegisterStudents(all, { ...DEFAULT_REGISTER_FILTERS, search: "nobody" })), []);
});

test("filter: attendance status (including no record) and review state, combined with search", () => {
  const all = fixture().students;
  const by = (status: RegisterFilters["status"], review: RegisterFilters["review"] = "ALL", search = "") => ids(filterRegisterStudents(all, { search, status, review }));
  assert.deepEqual(by("PRESENT"), ["s-amal"]);
  assert.deepEqual(by("LATE"), ["s-nimali"]);
  assert.deepEqual(by("ABSENT"), ["s-kasun"]);
  assert.deepEqual(by("EXCUSED"), ["s-dilan"]);
  assert.deepEqual(by("NO_RECORD"), ["s-ruwan", "s-unknown"]);
  assert.deepEqual(by("ALL", "PENDING"), ["s-kasun"]);
  assert.equal(by("ALL", "NONE").length, 5);
  assert.deepEqual(by("ABSENT", "NONE"), []);
  assert.deepEqual(by("NO_RECORD", "ALL", "ruwan"), ["s-ruwan"]);
});

test("time: API timestamps are shown in Asia/Colombo; missing or invalid values are a dash", () => {
  assert.equal(formatColomboDateTime("2026-09-01T12:30:00.000Z"), "1 Sept 2026, 18:00");
  assert.equal(formatColomboDateTime("2026-12-31T20:00:00.000Z"), "1 Jan 2027, 01:30");
  assert.equal(formatColomboDateTime(null), "—");
  assert.equal(formatColomboDateTime("not a date"), "—");
});

// ---- Rendering ------------------------------------------------------------------------------------

test("register: header, open state, schedule and grace in Colombo time, the backend summary", () => {
  const html = text(render(fixture()));
  for (const expected of [
    "Attendance register", "Kinematics II", "Lecture status: Completed", "Automatic attendance", "Open",
    "Scheduled start 1 Sept 2026, 18:00", "Scheduled end 1 Sept 2026, 20:00", "Grace period 10 minutes", "Finalized Not finalized",
    "Students 6", "Present 1", "Late 1", "Absent 1", "Excused 1", "Pending reviews 1", "Showing 6 of 6 student(s)",
  ]) {
    assert.ok(html.includes(expected), expected);
  }
  assert.ok(!html.includes("Finalized 1"), "open register");
});

test("register: every student with name, registration number, status, source, evidence, times, eligibility and review", () => {
  const html = text(render(fixture()));
  for (const expected of [
    "Amal Perera", "REG-101", "Nimali Silva", "REG-102", "Kasun Fernando", "Ruwan Bandara", "Sachini Weerasinghe",
    "Present", "Late", "Absent", "Excused", "No record",
    "Automatic (from evidence)", "Teacher decision",
    "Online and QR", "No evidence", "Evidence status: Late",
    "1 Sept 2026, 18:03", "1 Sept 2026, 18:20", "1 Sept 2026, 20:30",
    "Eligible", "Approval unknown (manual review)", "Will be marked absent at finalization", "Manual review (never marked absent automatically)",
    "Pending review since 1 Sept 2026, 18:35", "No pending review",
  ]) {
    assert.ok(html.includes(expected), expected);
  }
  // A missing registration number is a dash, never invented.
  assert.ok(html.includes("Registration no.: —"));
});

test("register: finalized display; not-yet-created register; configuration, live-session and evidence notices", () => {
  const finalizedHtml = render(fixture({ register: { ...fixture().register, finalized: true, finalizedAt: "2026-09-01T16:00:00.000Z" } }));
  const finalized = text(finalizedHtml);
  // The state badge reads "Finalized" (lock icon), never "Open".
  assert.match(finalizedHtml, /<span class="inline-flex items-center gap-1\.5 rounded-full px-3 py-1 text-xs font-semibold bg-white text-\[#112D5C\]"><svg[^]*?<\/svg>Finalized<\/span>/);
  assert.ok(!/>Open</.test(finalizedHtml));
  assert.ok(finalized.includes("Finalized 1 Sept 2026, 21:30"));
  assert.ok(!finalized.includes("Not finalized"));
  // An open register's badge reads "Open".
  assert.ok(/<\/svg>Open<\/span>/.test(render(fixture())));

  const fresh = text(render(fixture({ register: { ...fixture().register, exists: false, version: 0 } })));
  assert.ok(fresh.includes("No attendance has been recorded for this lecture yet"));

  const unconfigured = text(render(fixture({ configuration: { approval: "MISSING", evidence: "OK" }, classification: null, onlineEvidence: null, absencePreview: null })));
  assert.ok(unconfigured.includes("Attendance settings are not fully configured"));
  assert.ok(!unconfigured.includes("Automatic attendance"), "no classification shown when unknown");

  const busy = text(render(fixture({
    activeSessions: { active: true, count: 1 },
    onlineEvidence: { complete: false, pending: [{ studentId: "s-ruwan", earliestEligibleVisitAt: "2026-09-01T12:40:00.000Z" }], unknownVisits: [] },
  })));
  assert.ok(busy.includes("A live class session is in progress"));
  assert.ok(busy.includes("Online evidence not yet recorded: 1 student(s)"));
});

test("register: empty register and empty filtered results have their own states", () => {
  const empty = text(render(fixture({ students: [], summary: { students: 0, withRecord: 0, recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 0 } })));
  assert.ok(empty.includes("No students on this register"));
  const none = text(render(fixture(), { ...DEFAULT_REGISTER_FILTERS, search: "zzz" }));
  assert.ok(none.includes("No students match the filters"));
  assert.ok(none.includes("Showing 0 of 6 student(s)"));
  assert.ok(none.includes("Clear filters"));
  const filtered = text(render(fixture(), { search: "", status: "ABSENT", review: "PENDING" }));
  assert.ok(filtered.includes("Kasun Fernando") && !filtered.includes("Amal Perera"));
});

test("responsive: a sideways-scrolling table on wide screens and cards on narrow ones, both with every field", () => {
  const html = render(fixture());
  assert.match(html, /class="hidden overflow-x-auto[^"]*md:block" data-layout="table"/);
  assert.match(html, /class="flex flex-col gap-2 md:hidden" data-layout="cards"/);
  const [table, cards] = [html.slice(html.indexOf('data-layout="table"'), html.indexOf('data-layout="cards"')), html.slice(html.indexOf('data-layout="cards"'))];
  for (const label of ["Source", "Evidence", "First online", "First QR", "Teacher decision", "Eligibility at start", "Review"]) {
    assert.ok(text(table).includes(label), `table ${label}`);
    assert.ok(text(cards).includes(label), `cards ${label}`);
  }
  for (const value of ["REG-101", "1 Sept 2026, 18:20", "Pending review since"]) {
    assert.ok(text(table).includes(value) && text(cards).includes(value), value);
  }
});

test("register: no internal ids or backend-only fields are rendered", () => {
  const rendered = render(fixture());
  // Stage 5.7b-3d: the lecture id appears only in the scanner link's URL (as in the page's own URL), never as text.
  assert.equal(rendered.split("lec-1").length - 1, 1);
  assert.ok(rendered.includes('href="/dashboard/attendance/lec-1/scan"'));
  const html = rendered.replace('href="/dashboard/attendance/lec-1/scan"', "");
  for (const hidden of ["lec-1", "class-1", "s-amal", "KNOWN_APPROVED", "BROKEN_HISTORY", "SCHEDULED_END_PASSED", "version"]) {
    assert.ok(!html.includes(hidden), hidden);
  }
});

// ---- Errors and loading -----------------------------------------------------------------------------

const err = (status: number, code: string, message = "Message from the helper."): AttendanceApiError => ({ ok: false, status, code, message });

test("errors: not found never echoes server text; unauthorized offers sign-in; network and server errors offer a manual retry", () => {
  const notFound = text(renderToStaticMarkup(<RegisterErrorView error={err(404, "LECTURE_NOT_FOUND", "secret server text")} onRetry={() => {}} />));
  assert.ok(notFound.includes("Lecture not found"));
  assert.ok(notFound.includes("This lecture does not exist or is not one of your lectures."));
  assert.ok(!notFound.includes("secret server text"));
  assert.ok(!notFound.includes("Try again"), "not found is not retried");

  const unauthorized = renderToStaticMarkup(<RegisterErrorView error={err(401, "UNAUTHORIZED")} onRetry={() => {}} />);
  assert.ok(text(unauthorized).includes("Please sign in again"));
  assert.match(unauthorized, /href="\/login"/);

  const network = text(renderToStaticMarkup(<RegisterErrorView error={err(0, "NETWORK_ERROR")} onRetry={() => {}} />));
  assert.ok(network.includes("Could not reach the server") && network.includes("Try again"));

  const server = text(renderToStaticMarkup(<RegisterErrorView error={err(500, "INTERNAL_SERVER_ERROR", "Something went wrong on the server. Please try again.")} onRetry={() => {}} />));
  assert.ok(server.includes("The register could not be loaded") && server.includes("Try again"));

  const config = text(renderToStaticMarkup(<RegisterErrorView error={err(503, "ATTENDANCE_EVIDENCE_NOT_CONFIGURED")} onRetry={() => {}} />));
  assert.ok(config.includes("Attendance is not configured") && !config.includes("Try again"));

  const unknown = text(renderToStaticMarkup(<RegisterErrorView error={err(418, "SOMETHING_NEW")} />));
  assert.ok(unknown.includes("The register could not be loaded") && unknown.includes("Back to lectures"));

  assert.ok(text(renderToStaticMarkup(<RegisterLoadingView />)).includes("Loading the attendance register"));
});

// ---- Wiring (source) ----------------------------------------------------------------------------------

test("wiring: the panel loads through the shared helper only, retries only on request, stores nothing; no finalization yet", () => {
  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  assert.match(panel, /fetchAttendanceRegister\(lectureId, \{ signal: controller\.signal \}\)/);
  assert.doesNotMatch(panel, /\bfetch\(/, "no direct fetch");
  assert.doesNotMatch(panel, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(panel, /setInterval|setTimeout/, "no automatic retries or polling");
  // Stages 5.5d-3/4 add reconciliation and finalization through their controllers
  // (tests/ui/attendance-reconcile.test.tsx, attendance-finalization.test.tsx): never a direct API call here.
  const code = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /finalizeAttendance\(|fetchFinalizationPreview\(|\/api\//);
  assert.ok(panel.startsWith('"use client";'));
});

test("wiring: the page is a thin dynamic wrapper; the lecture list links each lecture to its register", () => {
  const page = source("app", "dashboard", "attendance", "[lectureId]", "page.tsx");
  assert.match(page, /dynamic\(\s*\(\) => import\("@\/components\/attendance\/lecture-attendance-register-panel"\)/);
  assert.match(page, /<Suspense/);
  assert.match(page, /<LectureAttendanceRegisterPanel lectureId=\{params\.lectureId\} \/>/);

  const lectures = source("components", "lecture-management-panel.tsx");
  assert.match(lectures, /import Link from "next\/link";/);
  assert.match(lectures, /href=\{`\/dashboard\/attendance\/\$\{encodeURIComponent\(lecture\.id\)\}`\}/);
  assert.match(lectures, /<ClipboardCheck size=\{11\} \/>\s*Register\s*<\/Link>/);
  assert.equal(lectures.match(/\/dashboard\/attendance\//g)?.length, 1, "one link, nothing else changed in the list");
});
