/**
 * The Attendance workspace's month (components/attendance/attendance-take-section.tsx):
 * a selected Sri Lankan month drives the lecture selector (the class's
 * lectures of that month only, from the existing lecture list) and the
 * overview; selecting a lecture switches to its register (register mode),
 * clearing it returns to the month's matrix (overview mode).
 *
 * No DOM library is installed: the pure month helpers and query are tested
 * directly, the initial render with react-dom/server (with an injected
 * clock), and the state wiring from source. The server side of the month
 * query (the real GET /api/lectures returning exactly that class and month,
 * pagination, December / January) is tested in
 * tests/attendance/attendance-take.test.cjs. Clicking through a real browser
 * remains a manual check.
 *
 *   npm run test:attendance-ui
 */

// Not Sri Lankan time: month boundaries must never depend on the machine's time zone.
process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { classMonthLecturesQuery, CLASS_LECTURES_PAGE_SIZE } from "../../components/attendance/attendance-ui";
import {
  AttendanceTakeSection,
  colomboMonthBounds,
  colomboMonthKey,
  lectureMonthKey,
  noLectureOptionLabel,
  shiftMonthKey,
  withLectureOption,
  workspaceMode,
} from "../../components/attendance/attendance-take-section";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const TAKE = () => code(source("components", "attendance", "attendance-take-section.tsx"));
const slice = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));

/** Sri Lankan wall clock → the real instant. */
const sl = (wall: string) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60_000);

// =========================================================================================================
// 1. The current month is Asia/Colombo's
// =========================================================================================================

test("1. the initial month is the current Asia/Colombo month (not UTC, not the browser's zone)", () => {
  assert.equal(colomboMonthKey(sl("2026-11-30T23:59")), "2026-11");
  assert.equal(colomboMonthKey(sl("2026-12-01T00:00")), "2026-12", "18:30 UTC on 30 Nov is already December in Colombo");
  assert.equal(colomboMonthKey(new Date("2026-11-30T18:29:59.999Z")), "2026-11");
  assert.equal(lectureMonthKey("2026-12-31T18:30:00.000Z"), "2027-01");
  assert.equal(lectureMonthKey("nope"), null);

  // The workspace renders with the Colombo month from its clock (injected here).
  const december = text(renderToStaticMarkup(<AttendanceTakeSection classOptions={[{ id: "C1", name: "Physics" }]} now={() => sl("2026-12-01T00:05")} />));
  assert.match(december, /— December 2026/);
  assert.match(december, /No lecture selected · monthly overview/);
  assert.match(december, /Lecture in December 2026 \(optional\)/);
  assert.match(december, /No class selected — December 2026/, "the control card's title");
  assert.match(december, /Monthly attendance: December 2026/, "the matrix section's (screen-reader) heading");
  const november = text(renderToStaticMarkup(<AttendanceTakeSection classOptions={[]} now={() => new Date("2026-11-30T18:29:00.000Z")} />));
  assert.match(november, /November 2026/);
  assert.match(TAKE(), /useState<string>\(\(\) => \(isMonthKey\(initialMonth\) \? initialMonth : colomboMonthKey\(now \? now\(\) : new Date\(\)\)\)\)/, "the server's month, else read once");
});

// =========================================================================================================
// 2. The selector's query: the selected class and month only
// =========================================================================================================

test("2. the selector asks the existing lecture list for the class and the month's Colombo bounds (oldest first, 100 per page)", () => {
  const bounds = colomboMonthBounds("2026-11");
  assert.equal(bounds.from.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(bounds.to.toISOString(), "2026-11-30T18:29:59.999Z");
  const params = new URLSearchParams(classMonthLecturesQuery("C1", bounds, 2));
  assert.deepEqual(Object.fromEntries(params), {
    classId: "C1",
    page: "2",
    pageSize: String(CLASS_LECTURES_PAGE_SIZE),
    sortOrder: "asc",
    from: "2026-10-31T18:30:00.000Z",
    to: "2026-11-30T18:29:59.999Z",
  });
  assert.equal(CLASS_LECTURES_PAGE_SIZE, 100, "the list's maximum page size; further pages through Load more");
  const take = TAKE();
  assert.match(take, /fetchClassLectures\(classId, colomboMonthBounds\(month\), lecturePage, \{ signal: controller\.signal \}\)/);
  assert.match(take, /\}, \[classId, month, lecturePage\]\);/, "reloaded for every class / month / page");
  assert.match(take, /Load more lectures in \{monthLabel\(month\)\}/);
  // Consecutive months touch exactly: no lecture can fall between or into two months.
  for (const key of ["2026-01", "2026-02", "2026-11", "2026-12", "2028-02"]) {
    assert.equal(colomboMonthBounds(key).to.getTime() + 1, colomboMonthBounds(shiftMonthKey(key, 1)).from.getTime(), key);
  }
});

// =========================================================================================================
// 3-6. Previous / Next month
// =========================================================================================================

test("3-6. Previous / Next month: plain calendar arithmetic, December → January and January → December", () => {
  assert.equal(shiftMonthKey("2026-11", -1), "2026-10");
  assert.equal(shiftMonthKey("2026-11", 1), "2026-12");
  assert.equal(shiftMonthKey("2026-12", 1), "2027-01", "December → January");
  assert.equal(shiftMonthKey("2027-01", -1), "2026-12", "January → December");
  assert.equal(shiftMonthKey("2026-01", -1), "2025-12");
  assert.throws(() => shiftMonthKey("2026-1", 1), RangeError);
  const dec = colomboMonthBounds("2026-12");
  const jan = colomboMonthBounds("2027-01");
  assert.equal(dec.to.toISOString(), "2026-12-31T18:29:59.999Z");
  assert.equal(jan.from.toISOString(), "2026-12-31T18:30:00.000Z");
  const take = TAKE();
  const change = slice(take, "const changeMonth", "const changeLecture");
  assert.match(change, /resetLectures\(\);\s+setMonth\(\(current\) => shiftMonthKey\(current, delta\)\);/);
  assert.match(take, /onClick=\{\(\) => changeMonth\(-1\)\}/);
  assert.match(take, /onClick=\{\(\) => changeMonth\(1\)\}/);
});

// =========================================================================================================
// 7-11. Selection and modes
// =========================================================================================================

test("7-8. changing the month or the class clears the selected lecture first (never a register of another month / class)", () => {
  const take = TAKE();
  const reset = slice(take, "const resetLectures", "const changeClass");
  for (const step of ['setLectureId("")', "setLectures([])", "setLecturePage(1)", "setHasMoreLectures(false)", "setDialogOpen(false)", "setScanner(null)"]) {
    assert.ok(reset.includes(step), step);
  }
  const changeClass = slice(take, "const changeClass", "const changeMonth");
  assert.ok(changeClass.indexOf("resetLectures()") < changeClass.indexOf("setClassId(next)"));
  assert.doesNotMatch(changeClass, /setMonth/, "the month is kept");
  const changeMonth = slice(take, "const changeMonth", "const changeLecture");
  assert.ok(changeMonth.indexOf("resetLectures()") < changeMonth.indexOf("setMonth("));
});

test("9-10. modes: no lecture → the month's matrix; a lecture → only its register (the matrix hidden and not fetched)", () => {
  assert.equal(workspaceMode("", ""), "NO_CLASS");
  assert.equal(workspaceMode("", "L1"), "NO_CLASS");
  assert.equal(workspaceMode("C1", ""), "OVERVIEW");
  assert.equal(workspaceMode("C1", "L1"), "REGISTER");
  const take = TAKE();
  const register = take.slice(take.indexOf('{mode === "REGISTER" ? ('));
  assert.match(register, /<LectureAttendanceRegisterPanel/);
  assert.doesNotMatch(register, /AttendanceMatrixTable/);
  const overviewBranch = take.slice(take.indexOf('{mode !== "REGISTER" ? ('), take.indexOf("{dialogOpen && classId ? ("));
  assert.match(overviewBranch, /<AttendanceMatrixTable matrix=\{matrix\} selectedLectureId=\{null\} flush \/>/);
  assert.doesNotMatch(overviewBranch, /LectureAttendanceRegisterPanel/);
  // The matrix request runs only in overview mode; returning to it reloads.
  assert.match(take, /if \(!classId \|\| !overview\) return;/);
  assert.match(take, /\}, \[classId, month, matrixAttempt, overview\]\);/);
  // Clearing: the selector's empty option or "Back to the monthly overview" (class and month kept).
  assert.match(take, /onClick=\{\(\) => setLectureId\(""\)\}/);
  assert.match(take, /Monthly overview/);
  // The selectors and month controls stay visible in both modes (the first section is never conditional).
  assert.ok(take.indexOf('aria-label="Month"') < take.indexOf('{mode !== "REGISTER" ? ('));
  assert.ok(take.indexOf('id={TAKE_ATTENDANCE_BUTTON_ID}') < take.indexOf('{mode !== "REGISTER" ? ('));
  const initial = renderToStaticMarkup(<AttendanceTakeSection classOptions={[{ id: "C1", name: "Physics" }]} now={() => sl("2026-11-23T09:00")} />);
  assert.match(initial, /data-workspace-mode="no-class"/);
  assert.match(text(initial), /Choose a class \(Change\) to see its attendance for November 2026\./);
});

test("11. only the selected lecture's register is loaded: one panel, keyed by the lecture; the matrix loads no registers", () => {
  const take = TAKE();
  assert.equal((take.match(/<LectureAttendanceRegisterPanel/g) ?? []).length, 1);
  assert.match(take, /<LectureAttendanceRegisterPanel\s+key=\{lectureId\}\s+lectureId=\{lectureId\}/);
  assert.doesNotMatch(take, /fetchAttendanceRegister|lectures\.map\([^)]*Register/);
  assert.doesNotMatch(code(source("components", "attendance", "attendance-matrix.tsx")), /fetch|attendanceRequest/, "the matrix renders the month's one response");
});

test("the selector's empty option: 'No lectures in this month' once the month has none; otherwise the overview", () => {
  assert.equal(noLectureOptionLabel({ classId: "", lectureLoad: { kind: "idle" }, lectureCount: 0 }), "Select a class first");
  assert.equal(noLectureOptionLabel({ classId: "C1", lectureLoad: { kind: "loading" }, lectureCount: 0 }), "Loading this month's lectures…");
  assert.equal(noLectureOptionLabel({ classId: "C1", lectureLoad: { kind: "ready" }, lectureCount: 0 }), "No lectures in this month");
  assert.equal(noLectureOptionLabel({ classId: "C1", lectureLoad: { kind: "ready" }, lectureCount: 3 }), "No lecture selected (monthly overview)");
  // Creating stays possible without a lecture (the existing dialog).
  assert.match(TAKE(), /else if \(action\.kind === "CREATE_LECTURE"\) setDialogOpen\(true\);/);
});

// =========================================================================================================
// 12-13. A created lecture
// =========================================================================================================

test("12-13. a created lecture is selected and the scanner opens for it: added in the shown month; its own month shown otherwise", () => {
  const take = TAKE();
  const ready = slice(take, "const lectureReady", "const reloadMatrix");
  assert.match(ready, /const key = lectureMonthKey\(lecture\.date\);\s+if \(key && key !== month\) \{\s+setMonth\(key\);\s+setLecturePage\(1\);\s+setHasMoreLectures\(false\);\s+setLectures\(withLectureOption\(\[\], lecture\)\);\s+\} else \{\s+setLectures\(\(previous\) => withLectureOption\(previous, lecture\)\);\s+\}\s+setLectureId\(lecture\.id\);\s+setExpanded\(false\);\s+openScannerModal\(lecture\.id\);/);
  // Never twice when the month's list (reloaded) also contains it.
  assert.match(take, /return merged\.filter\(\(lecture, index\) => merged\.findIndex\(\(l\) => l\.id === lecture\.id\) === index\);/);
  const list = withLectureOption(
    [
      { id: "a", title: "A", date: "2026-11-02T03:30:00.000Z", endDate: null, classStatus: "COMPLETED" },
      { id: "c", title: "C", date: "2026-11-27T03:30:00.000Z", endDate: null, classStatus: "SCHEDULED" },
    ],
    { id: "b", title: "B", date: "2026-11-23T03:30:00.000Z", endDate: null }
  );
  assert.deepEqual(list.map((l) => l.id), ["a", "b", "c"], "oldest first, like the month's list");
});

// =========================================================================================================
// Responsive and request hygiene
// =========================================================================================================

test("responsive: the selection bar wraps (summary left, month and Change right); selectors stack on small screens; no page-level overflow", () => {
  const html = renderToStaticMarkup(<AttendanceTakeSection classOptions={[{ id: "C1", name: "Physics" }]} now={() => sl("2026-11-23T09:00")} />);
  assert.match(html, /<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3"><div class="min-w-0 flex-1"><h2 id="take-attendance-heading"/);
  assert.match(html, /<nav aria-label="Month" class="flex items-center rounded-lg border border-slate-200 bg-white p-0\.5" data-month-nav="[^"]*">/);
  assert.match(html, /class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end"/);
  assert.match(html, /<section aria-labelledby="take-attendance-heading" class="flex min-w-0 flex-col/);
  assert.match(html, /aria-label="Previous month"/);
  assert.match(html, /aria-label="Next month"/);
  assert.doesNotMatch(html, /w-\[\d{3,}px\]|min-w-\[\d{3,}px\]/);
});

test("stale requests: every list / matrix request is aborted when the class, month, page or mode changes", () => {
  const take = TAKE();
  const lists = slice(take, "useEffect(() => {\n    if (!classId) return;", "useEffect(() => {\n    if (!classId || !overview) return;");
  assert.match(lists, /if \(controller\.signal\.aborted\) return;/);
  assert.match(lists, /return \(\) => controller\.abort\(\);/);
  const matrix = slice(take, "useEffect(() => {\n    if (!classId || !overview) return;", "const resetLectures");
  assert.match(matrix, /if \(controller\.signal\.aborted\) return;/);
  assert.match(matrix, /return \(\) => controller\.abort\(\);/);
});
