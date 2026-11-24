/**
 * Taking attendance from the Attendance page: the "Take attendance" section
 * (components/attendance/attendance-take-section.tsx), the lecture creation
 * dialog (attendance-lecture-dialog.tsx) and the class matrix
 * (attendance-matrix.tsx). Pure helpers; the matrix, the dialog and the QR
 * timing notes rendered with react-dom/server from fixtures shaped like the
 * API contracts; the section's wiring (it needs the app router) from source.
 * Clicking through the real page remains a manual check.
 *
 *   npm run test:attendance-ui
 */

// Not Sri Lankan time: every Colombo conversion must not depend on the machine's time zone.
process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AttendanceLectureDialog,
  MANUAL_SESSION,
  TimingNote,
  changeDay,
  chooseSession,
  colomboToday,
  defaultLectureTitle,
  existingLecturesOf,
  initialSessionForm,
  lectureBody,
  schedulesForWeekday,
  sessionFormProblem,
  sessionStart,
  sessionTiming,
} from "../../components/attendance/attendance-lecture-dialog";
import { AttendanceMatrixTable, colomboTime, lectureColumnState, matrixCellLabel, monthLabel } from "../../components/attendance/attendance-matrix";
import { lectureMonthKey, lectureOptionLabel, scannerAction } from "../../components/attendance/attendance-take-section";
import { classAttendanceMatrixUrl } from "../../components/attendance/attendance-ui";
import type { AttendanceMatrix, AttendanceMatrixSchedule } from "../../services/class-attendance-matrix-service";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

/** Sri Lankan wall clock → the real instant. */
const sl = (wall: string) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60_000);

const SCHEDULES: AttendanceMatrixSchedule[] = [
  { id: "mon-2", dayOfWeek: "MONDAY", startTime: "14:00", endTime: "16:00" },
  { id: "mon-1", dayOfWeek: "MONDAY", startTime: "09:00", endTime: "11:00" },
  { id: "fri", dayOfWeek: "FRIDAY", startTime: "16:00", endTime: "18:00" },
];

// =========================================================================================================
// Section helpers
// =========================================================================================================

test("Open QR Scanner: disabled without a class; the scanner modal for a chosen lecture; otherwise the creation dialog", () => {
  assert.deepEqual(scannerAction("", ""), { kind: "DISABLED" });
  assert.deepEqual(scannerAction("", "L1"), { kind: "DISABLED" }, "a lecture without a class never opens anything");
  assert.deepEqual(scannerAction("C1", "L 1"), { kind: "OPEN_SCANNER", lectureId: "L 1" });
  assert.deepEqual(scannerAction("C1", ""), { kind: "CREATE_LECTURE" });
});

test("a lecture's Sri Lankan month (for the matrix) and its selector label", () => {
  assert.equal(lectureMonthKey("2026-11-30T18:29:00.000Z"), "2026-11");
  assert.equal(lectureMonthKey("2026-11-30T18:30:00.000Z"), "2026-12", "midnight in Colombo");
  assert.equal(lectureMonthKey("nope"), null);
  assert.match(lectureOptionLabel({ id: "L", title: "Kinematics", date: sl("2026-11-23T09:00").toISOString(), endDate: null, classStatus: "SCHEDULED" }), /23 Nov 2026, 09:00 · Kinematics$/);
  assert.match(lectureOptionLabel({ id: "L", title: "X", date: sl("2026-11-23T09:00").toISOString(), endDate: null, classStatus: "CANCELLED" }), /\(cancelled\)$/);
  assert.equal(classAttendanceMatrixUrl("C 1", null), "/api/classes/C%201/attendance-matrix");
  assert.equal(classAttendanceMatrixUrl("C1", "2026-11"), "/api/classes/C1/attendance-matrix?month=2026-11");
});

test("section wiring (source): class required, lecture cleared on class change, existing scanner reused, nothing created on load", () => {
  const s = source("components", "attendance", "attendance-take-section.tsx");
  const change = s.slice(s.indexOf("const changeClass"), s.indexOf("const changeMonth"));
  assert.match(change, /resetLectures\(\);/, "the lecture is cleared when the class changes");
  assert.doesNotMatch(change, /setMonth/, "the selected month is kept (tests/ui/attendance-month-workspace.test.tsx)");
  assert.match(s.slice(s.indexOf("const resetLectures"), s.indexOf("const changeClass")), /setLectureId\(""\);/);
  assert.match(s, /disabled=\{action\.kind === "DISABLED" \|\|/);
  assert.match(s, /if \(action\.kind === "OPEN_SCANNER"\) openScannerModal\(action\.lectureId\);/, "the scanner opens in a modal (tests/ui/attendance-scanner-modal.test.tsx)");
  assert.match(s, /else if \(action\.kind === "CREATE_LECTURE"\) setDialogOpen\(true\);/);
  assert.match(s, /onLectureReady=\{lectureReady\}/);
  assert.doesNotMatch(s, /createAttendanceLecture|method: "POST"/, "the section itself never creates a lecture");
  assert.match(s, /disabled=\{lecture\.classStatus === "CANCELLED"\}/);
  assert.match(s, /Previous month/);
  assert.match(s, /Next month/);
  // The only creation call is the dialog's explicit confirmation.
  const dialog = source("components", "attendance", "attendance-lecture-dialog.tsx");
  assert.equal((dialog.match(/createAttendanceLecture\(/g) ?? []).length, 1);
  assert.match(dialog.slice(dialog.indexOf("async function submit")), /createAttendanceLecture\(props\.classId, lectureBody\(form, allowAdditionalSession\)\)/);
});

test("the Attendance page keeps the Upcoming / Previous list's source (hidden by a flag); the workspace comes first", () => {
  const panel = source("components", "attendance", "attendance-overview-panel.tsx");
  assert.match(panel, /takeAttendance=\{<AttendanceTakeSection classOptions=\{classOptions\} classesLoaded=\{classesLoaded\} initialMonth=\{initialMonth\} \/>\}/);
  assert.match(panel, /label: "Upcoming"/);
  assert.match(panel, /label: "Previous"/);
  const view = panel.slice(panel.indexOf("export function OverviewView"));
  // (Searched from the render body: the props' doc comments name the section too.)
  const body = view.slice(view.indexOf("return ("));
  assert.ok(body.indexOf("{props.takeAttendance ?? (") < body.indexOf("Attendance registers"), "the workspace above the (hidden) list's heading");
  // The workspace (whose single card starts with the page heading) comes first; the existing list follows.
  assert.ok(view.indexOf("{props.takeAttendance ?? (") > 0, "the workspace, or the heading alone without it");
  assert.ok(view.indexOf("{props.takeAttendance ?? (") < view.indexOf('role="tablist"'), "above the tabs");
  assert.equal(source("app", "dashboard", "attendance", "page.tsx").includes("AttendanceOverviewPanel"), true);
});

// =========================================================================================================
// Dialog helpers
// =========================================================================================================

test("today and its schedules come from Asia/Colombo, not the browser's time zone", () => {
  // Monday 23 Nov 2026 00:10 in Colombo is still Sunday in New York and in UTC.
  const now = sl("2026-11-23T00:10");
  assert.deepEqual(colomboToday(now), { day: "2026-11-23", weekday: "MONDAY" });
  assert.deepEqual(schedulesForWeekday(SCHEDULES, "MONDAY").map((s) => s.id), ["mon-1", "mon-2"], "earliest first");
  assert.deepEqual(schedulesForWeekday(SCHEDULES, "SUNDAY"), []);
});

test("the form opens prefilled from the first schedule of today (else a manual session); choosing / dates / titles", () => {
  const todays = schedulesForWeekday(SCHEDULES, "MONDAY");
  const form = initialSessionForm({ todays, today: "2026-11-23", className: "Physics" });
  assert.deepEqual(form, { choice: "mon-1", day: "2026-11-23", start: "09:00", end: "11:00", title: "Physics – 23 Nov 2026", titleEdited: false });
  const second = chooseSession(form, "mon-2", todays);
  assert.equal(second.start, "14:00");
  assert.equal(second.end, "16:00");
  const manual = chooseSession(second, MANUAL_SESSION, todays);
  assert.equal(manual.choice, MANUAL_SESSION);
  assert.equal(manual.start, "14:00", "manual keeps the times, editable");
  assert.equal(changeDay(form, "2026-11-24", "Physics").title, "Physics – 24 Nov 2026");
  assert.equal(changeDay({ ...form, title: "Mine", titleEdited: true }, "2026-11-24", "Physics").title, "Mine");
  const empty = initialSessionForm({ todays: [], today: "2026-11-23", className: "Physics" });
  assert.equal(empty.choice, MANUAL_SESSION);
  assert.equal(empty.start, "");
  assert.equal(defaultLectureTitle("x".repeat(200), "2026-11-23").length, 150, "within the lecture title limit");
});

test("form problems use the existing lecture rules (end after start, at most 12 hours)", () => {
  const base = { choice: MANUAL_SESSION, day: "2026-11-23", start: "09:00", end: "11:00", title: "Physics", titleEdited: false };
  assert.equal(sessionFormProblem(base), null);
  assert.equal(sessionFormProblem({ ...base, end: "" }), null, "the end time is optional");
  assert.equal(sessionFormProblem({ ...base, end: "09:00" }), "The end time must be after the start time.");
  assert.match(sessionFormProblem({ ...base, start: "08:00", end: "21:00" }) ?? "", /12 hours/);
  assert.equal(sessionFormProblem({ ...base, start: "" }), "Enter a valid start time.");
  assert.equal(sessionFormProblem({ ...base, day: "" }), "Choose the session date.");
  assert.equal(sessionFormProblem({ ...base, title: " P " }), "Lecture title must be at least 2 characters long.");
  assert.equal(sessionStart(base)?.toISOString(), sl("2026-11-23T09:00").toISOString(), "Sri Lankan time");
});

test("the request body sends Sri Lankan wall-clock values; no end time when empty; the confirmation flag", () => {
  const base = { choice: "mon-1", day: "2026-11-23", start: "09:00", end: "11:00", title: " Physics ", titleEdited: true };
  assert.deepEqual(lectureBody(base, false), { title: "Physics", date: "2026-11-23T09:00", endDate: "2026-11-23T11:00", allowAdditionalSession: false });
  assert.deepEqual(lectureBody({ ...base, end: "" }, true), { title: "Physics", date: "2026-11-23T09:00", endDate: null, allowAdditionalSession: true });
});

test("QR timing notes follow the existing rules: past start beyond the grace → Late warning; >30 min ahead → opens 30 min before", () => {
  const start = sl("2026-11-23T09:00");
  assert.equal(sessionTiming(start, sl("2026-11-23T09:10"), 10).kind, "NOW", "within the grace");
  assert.equal(sessionTiming(start, sl("2026-11-23T09:11"), 10).kind, "PAST");
  assert.equal(sessionTiming(start, sl("2026-11-25T09:00"), 10).kind, "PAST", "a past date");
  assert.equal(sessionTiming(start, sl("2026-11-23T08:30"), 10).kind, "NOW", "the window is open at start − 30 min");
  const future = sessionTiming(start, sl("2026-11-23T08:29"), 10);
  assert.equal(future.kind, "FUTURE");
  assert.equal(future.kind === "FUTURE" && future.opensAt.toISOString(), sl("2026-11-23T08:30").toISOString());

  const past = text(renderToStaticMarkup(<TimingNote timing={{ kind: "PAST" }} isToday={false} graceMinutes={10} />));
  assert.match(past, /This date is in the past\. Under the existing attendance rules, scans recorded more than 10 minute\(s\) after the start are marked Late\./);
  const later = text(renderToStaticMarkup(<TimingNote timing={{ kind: "FUTURE", opensAt: sl("2026-11-23T08:30") }} isToday graceMinutes={10} />));
  assert.match(later, /QR scanning for this lecture opens at 23 Nov 2026, 08:30, 30 minutes before the start\./);
  assert.equal(renderToStaticMarkup(<TimingNote timing={{ kind: "NOW" }} isToday graceMinutes={10} />), "");
});

test("409 details: the existing lectures are read defensively", () => {
  assert.deepEqual(existingLecturesOf({ lectures: [{ id: "L1", title: "A", date: "2026-11-23T03:30:00.000Z", endDate: null }, { nope: true }] }), [
    { id: "L1", title: "A", date: "2026-11-23T03:30:00.000Z", endDate: null },
  ]);
  assert.deepEqual(existingLecturesOf(null), []);
  assert.deepEqual(existingLecturesOf({ lectures: "x" }), []);
});

test("dialog render: today's schedules as choices, the manual session, prefilled fields, Review (no creation before confirmation)", () => {
  const html = renderToStaticMarkup(
    <AttendanceLectureDialog classId="C1" className="Physics" schedules={SCHEDULES} graceMinutes={10} onClose={() => {}} onLectureReady={() => {}} now={() => sl("2026-11-23T07:00")} />
  );
  const t = text(html);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(t, /Create a lecture for attendance/);
  assert.match(t, /Session \(Monday schedules\)/);
  assert.match(t, /Scheduled session 09:00–11:00/);
  assert.match(t, /Scheduled session 14:00–16:00/);
  assert.doesNotMatch(t, /16:00–18:00/, "Friday's schedule is not offered on Monday");
  assert.match(t, /Additional \/ manual session/);
  assert.match(html, /value="2026-11-23"/);
  assert.match(html, /value="09:00"/);
  assert.match(html, /value="Physics – 23 Nov 2026"/);
  assert.match(t, /Review/);
  assert.doesNotMatch(t, /Confirm and open QR scanner/, "the confirmation is a separate step");
  assert.match(t, /QR scanning for this lecture opens at/, "07:00 is more than 30 minutes before 09:00");
});

test("dialog render: no schedule today → the manual session; schedules unavailable → told, manual still possible", () => {
  const sunday = text(renderToStaticMarkup(
    <AttendanceLectureDialog classId="C1" className="Physics" schedules={SCHEDULES} graceMinutes={10} onClose={() => {}} onLectureReady={() => {}} now={() => sl("2026-11-22T10:00")} />
  ));
  assert.match(sunday, /This class has no schedule on Sunday\. Enter an additional session's date and times\./);
  const unavailable = text(renderToStaticMarkup(
    <AttendanceLectureDialog classId="C1" className="Physics" schedules={null} graceMinutes={null} onClose={() => {}} onLectureReady={() => {}} now={() => sl("2026-11-22T10:00")} />
  ));
  assert.match(unavailable, /The class schedules could not be loaded\. Enter the session times manually\./);
  assert.match(unavailable, /Additional \/ manual session/);
});

// =========================================================================================================
// Matrix
// =========================================================================================================

const MATRIX: AttendanceMatrix = {
  class: { id: "C1", name: "Physics", attendanceGraceMinutes: 10 },
  month: { year: 2026, month: 11, key: "2026-11", previous: "2026-10", next: "2026-12" },
  schedules: SCHEDULES,
  lectures: [
    { id: "L1", title: "Kinematics", date: sl("2026-11-02T09:00").toISOString(), endDate: sl("2026-11-02T11:00").toISOString(), classStatus: "COMPLETED", register: { finalized: true, finalizedAt: sl("2026-11-02T12:00").toISOString(), graceMinutes: 10 }, qrClosed: true },
    { id: "L2", title: "Dynamics", date: sl("2026-11-09T09:00").toISOString(), endDate: null, classStatus: "SCHEDULED", register: { finalized: false, finalizedAt: null, graceMinutes: 10 }, qrClosed: false },
    { id: "L3", title: "Cancelled one", date: sl("2026-11-16T09:00").toISOString(), endDate: null, classStatus: "CANCELLED", register: null, qrClosed: false },
  ],
  students: [
    {
      id: "S1", name: "Amal Perera with a very long name that must wrap", registrationNumber: "REG-0001", enrolled: true, active: true,
      cells: [
        { state: "RECORD", status: "PRESENT", attendedAt: sl("2026-11-02T09:03").toISOString(), pendingReview: false },
        { state: "RECORD", status: "LATE", attendedAt: sl("2026-11-09T09:40").toISOString(), pendingReview: true },
        { state: "LECTURE_CANCELLED", status: null, attendedAt: null, pendingReview: false },
      ],
    },
    {
      id: "S2", name: "Bimal", registrationNumber: null, enrolled: false, active: true,
      cells: [
        { state: "NO_RECORD", status: null, attendedAt: null, pendingReview: false },
        { state: "NOT_RECORDED_YET", status: null, attendedAt: null, pendingReview: false },
        { state: "NOT_ENROLLED", status: null, attendedAt: null, pendingReview: false },
      ],
    },
  ],
};

test("cell labels: the stored statuses, the Colombo time, and the two no-record states (never an inferred Absent)", () => {
  assert.deepEqual(matrixCellLabel(MATRIX.students[0].cells[0]), { label: "Present", tone: "positive", time: "09:03" });
  assert.deepEqual(matrixCellLabel(MATRIX.students[0].cells[1]), { label: "Late", tone: "warning", time: "09:40" });
  assert.equal(matrixCellLabel({ state: "RECORD", status: "ABSENT", attendedAt: null, pendingReview: false }).label, "Absent");
  assert.equal(matrixCellLabel({ state: "RECORD", status: "EXCUSED", attendedAt: null, pendingReview: false }).label, "Excused");
  assert.equal(matrixCellLabel(MATRIX.students[1].cells[0]).label, "No record");
  assert.equal(matrixCellLabel(MATRIX.students[1].cells[1]).label, "Not recorded yet");
  assert.equal(matrixCellLabel(MATRIX.students[1].cells[2]).label, "Not enrolled");
  assert.equal(colomboTime("2026-11-02T03:33:00.000Z"), "09:03");
  assert.equal(monthLabel("2026-11"), "November 2026");
  assert.equal(lectureColumnState(MATRIX.lectures[0]), "Finalized");
  assert.equal(lectureColumnState(MATRIX.lectures[1]), "Open");
  assert.equal(lectureColumnState(MATRIX.lectures[2]), "Cancelled");
});

test("matrix render: students × lectures, the selected column identified, register links, sticky student column, nothing truncated", () => {
  const html = renderToStaticMarkup(<AttendanceMatrixTable matrix={MATRIX} selectedLectureId="L2" />);
  const t = text(html);
  assert.match(html, /<table/);
  assert.equal((html.match(/<th scope="row"/g) ?? []).length, 2);
  assert.equal((html.match(/<th scope="col"/g) ?? []).length, 4, "the student column + 3 lectures");
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.match(html, /aria-current="true" data-selected="true"[^>]*>[\s\S]*?Dynamics/);
  assert.match(t, /Selected/);
  assert.match(html, /href="\/dashboard\/attendance\/L1"/, "manual changes stay on the existing register page");
  assert.match(html, /overflow-auto/, "scrolls sideways on small screens");
  assert.match(html, /<th scope="row" class="sticky left-0/, "the student column is sticky");
  assert.match(html, /<th scope="col" class="sticky left-0 top-0/);
  assert.doesNotMatch(html, /\btruncate\b|line-clamp|hidden md:|sm:hidden|md:hidden/);
  assert.match(t, /Amal Perera with a very long name that must wrap/);
  assert.match(t, /REG-0001/);
  assert.match(t, /Removed from class/);
  for (const label of ["Present", "09:03", "Late", "09:40", "Review pending", "Lecture cancelled", "No record", "Not recorded yet", "Not enrolled", "QR closed", "Finalized"]) {
    assert.ok(t.includes(label), label);
  }
  assert.match(t, /Times are Sri Lankan time/);
});

test("matrix render: empty month and no students say so", () => {
  assert.match(text(renderToStaticMarkup(<AttendanceMatrixTable matrix={{ ...MATRIX, lectures: [], students: [] }} selectedLectureId={null} />)), /No lectures in November 2026 for this class\./);
  assert.match(text(renderToStaticMarkup(<AttendanceMatrixTable matrix={{ ...MATRIX, students: [] }} selectedLectureId={null} />)), /No students were enrolled in this class in November 2026\./);
});
