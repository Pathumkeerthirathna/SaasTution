/**
 * The Attendance workspace's ONE control card
 * (components/attendance/attendance-take-section.tsx): class and month title,
 * the selected lecture, month navigation, Change and the inline accordion
 * (Class, Lecture, Open QR Scanner, Done) in a single card; directly below
 * it, without another heading or card, the month's matrix or the selected
 * lecture's register.
 *
 * No DOM library is installed: the first render is checked with
 * react-dom/server, the wiring from source. Clicking through a real browser
 * remains a manual check.
 *
 *   npm run test:attendance-ui
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { AttendanceMatrixTable } from "../../components/attendance/attendance-matrix";
import { AttendanceTakeSection, classMonthTitle, lectureSummary, workspaceMode } from "../../components/attendance/attendance-take-section";
import type { AttendanceMatrix } from "../../services/class-attendance-matrix-service";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const TAKE = () => code(source("components", "attendance", "attendance-take-section.tsx"));
const CLASSES = [{ id: "C1", name: "Math - Grade 10" }];

const render = () => renderToStaticMarkup(<AttendanceTakeSection classOptions={CLASSES} initialMonth="2026-11" />);
/** The control card: the first <section> of the workspace. */
const card = (html: string) => html.slice(html.indexOf("<section"), html.indexOf("</section>") + "</section>".length);

test("1. one control card holds the class / month title, the lecture line, month navigation and Change", () => {
  const html = card(render());
  assert.match(html, /^<section aria-labelledby="take-attendance-heading" class="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm" data-selection-bar=/);
  assert.match(html, /<h2 id="take-attendance-heading" class="break-words text-\[16px\] font-semibold leading-snug text-slate-900" data-class-month="2026-11">/);
  assert.match(text(html), /No lecture selected · monthly overview/);
  assert.match(html, /<nav aria-label="Month"/);
  assert.match(html, /aria-label="Previous month"/);
  assert.match(html, /data-month="2026-11">November 2026<\/span>/, "the selected month between Previous and Next");
  assert.match(html, /aria-label="Next month"/);
  assert.match(html, /data-selection-toggle/);
  assert.equal(classMonthTitle("Math - Grade 10", "2026-11"), "Math - Grade 10 — November 2026");
  assert.match(TAKE(), /<h2 id="take-attendance-heading"[^>]*>\s*\{title\}\s*<\/h2>/);
});

test("2. the accordion (in the same card) holds the Class and Lecture selectors, Open QR Scanner and Done", () => {
  const html = card(render());
  const region = html.slice(html.indexOf('role="region"'));
  assert.equal((region.match(/<select/g) ?? []).length, 2);
  assert.match(text(region), /Class/);
  assert.match(text(region), /Lecture in November 2026 \(optional\)/);
  assert.match(text(region), /Open QR Scanner/);
  assert.match(text(region), /Done/);
  assert.match(html, /data-selection-region="closed"/, "collapsed by default");
});

test("3-4. no second class / month heading or card; the actual matrix stays, inside the one card", () => {
  const html = render();
  assert.equal((html.match(/<section/g) ?? []).length, 1, "one outer card in overview mode");
  assert.equal(html.slice(html.indexOf("</section>") + "</section>".length), "", "nothing outside the card");
  assert.match(card(html), /<h3 id="monthly-overview-heading" class="sr-only">/, "a screen-reader heading only (no visible duplicate)");
  assert.doesNotMatch(text(html), /Attendance — /);
  const take = TAKE();
  const overview = take.slice(take.indexOf('{mode !== "REGISTER" ? ('), take.indexOf("{dialogOpen && classId ? ("));
  assert.match(overview, /<AttendanceMatrixTable matrix=\{matrix\} selectedLectureId=\{null\} flush \/>\s*<div className="rounded-b-xl border-t border-slate-100 px-3 py-2">\s*<MatrixLegend \/>/);
  assert.match(overview, /className="flex min-w-0 flex-col border-t border-slate-200"\s+data-workspace-mode=/, "a divider between the controls and the matrix");
});

test("5-7. a selected lecture is named in the card; its register appears below (no matrix); clearing restores the matrix", () => {
  assert.equal(lectureSummary(null), "No lecture selected · monthly overview");
  assert.match(lectureSummary({ id: "L", title: "Kinematics", date: "2026-11-23T03:30:00.000Z", endDate: null, classStatus: "SCHEDULED" }), /^Lecture: Kinematics · 23 Nov 2026, 09:00$/);
  const take = TAKE();
  const cardSource = take.slice(take.indexOf("<section aria-labelledby=\"take-attendance-heading\""), take.indexOf("{mode !== \"REGISTER\" ? ("));
  assert.match(cardSource, /\{lectureSummary\(selectedLecture\)\}/);
  assert.match(cardSource, /\{lectureId \? \(\s*<button type="button" onClick=\{\(\) => setLectureId\(""\)\} className=\{SECONDARY_BUTTON\}>[\s\S]*?Monthly overview/);
  const register = take.slice(take.indexOf('{mode === "REGISTER" ? ('));
  assert.match(register, /<LectureAttendanceRegisterPanel key=\{lectureId\} lectureId=\{lectureId\} variant="embedded" onOpenScanner=\{openSelectedScanner\} refreshKey=\{registerRefresh\} \/>/);
  assert.doesNotMatch(register, /AttendanceMatrixTable|className=\{className/, "no matrix; the class is not repeated in the register header");
  assert.equal(workspaceMode("C1", "L1"), "REGISTER");
  assert.equal(workspaceMode("C1", ""), "OVERVIEW");
  assert.match(take.slice(take.indexOf("const changeLecture")), /setLectureId\(next\);\s+if \(next\) setExpanded\(false\);/, "choosing a lecture collapses the accordion");
});

test("8. month navigation (always visible, in the card): keeps the class, clears the lecture, keeps the accordion's state", () => {
  const take = TAKE();
  const change = take.slice(take.indexOf("const changeMonth"), take.indexOf("const changeLecture"));
  assert.match(change, /resetLectures\(\);\s+setMonth\(\(current\) => shiftMonthKey\(current, delta\)\);/);
  assert.doesNotMatch(change, /setClassId|setExpanded/);
  assert.match(take, /onClick=\{\(\) => changeMonth\(-1\)\} aria-label="Previous month"/);
  assert.match(take, /onClick=\{\(\) => changeMonth\(1\)\} aria-label="Next month"/);
  assert.ok(take.indexOf('aria-label="Month"') < take.indexOf('role="region"'), "outside the accordion");
});

test("9. QR scanner and lecture creation: Open QR Scanner in the accordion; the modal or the creation dialog, as before", () => {
  const take = TAKE();
  const region = take.slice(take.indexOf('role="region"'), take.indexOf("{dialogOpen && classId ? ("));
  assert.match(region, /id=\{TAKE_ATTENDANCE_BUTTON_ID\}\s+onClick=\{openScanner\}/);
  assert.match(take, /if \(action\.kind === "OPEN_SCANNER"\) openScannerModal\(action\.lectureId\);\s+else if \(action\.kind === "CREATE_LECTURE"\) setDialogOpen\(true\);/);
  assert.match(take, /setLectureId\(lecture\.id\);\s+setExpanded\(false\);\s+openScannerModal\(lecture\.id\);/);
  assert.match(take, /<QrScannerModal key=\{`\$\{scanner\.lectureId\}:\$\{scanner\.opening\}`\}/);
  assert.doesNotMatch(take, /router\.|scannerPath|window\.location/, "never the standalone scanner page");
});

test("10. responsive: the card wraps (title left, controls right), month steps become icons on phones, selectors stack; no fixed widths", () => {
  const html = card(render());
  assert.match(html, /<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3"><div class="min-w-0 flex-1">/);
  assert.match(html, /<div class="flex flex-wrap items-center gap-2"><nav aria-label="Month"/);
  assert.match(html, /<span class="hidden sm:inline">Previous<\/span>/);
  assert.match(html, /<span class="hidden sm:inline">Next<\/span>/);
  assert.match(html, /class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end"/);
  assert.doesNotMatch(render(), /w-\[\d{3,}px\]|min-w-\[\d{3,}px\]|whitespace-nowrap[^"]*w-/);
  // Touch targets: month steps, Change and Monthly overview 38px; selectors, Open QR Scanner and Done 40px.
  const take = TAKE();
  assert.match(take, /const MONTH_STEP_BUTTON =\s+"inline-flex h-\[38px\]/);
  assert.match(take, /className="h-10 min-w-0 rounded-lg border border-slate-300/);
});

// =========================================================================================================
// The matrix inside the card (one outer card in overview mode)
// =========================================================================================================

const MATRIX: AttendanceMatrix = {
  class: { id: "C1", name: "Math - Grade 10", attendanceGraceMinutes: 10 },
  month: { year: 2026, month: 11, key: "2026-11", previous: "2026-10", next: "2026-12" },
  schedules: [],
  lectures: [{ id: "L1", title: "Algebra", date: "2026-11-02T03:30:00.000Z", endDate: null, classStatus: "COMPLETED", register: null, qrClosed: false }],
  students: [{ id: "S1", name: "Amal Perera", registrationNumber: "REG-1", enrolled: true, active: true, cells: [{ state: "RECORD", status: "PRESENT", attendedAt: "2026-11-02T03:33:00.000Z", pendingReview: false }] }],
};

test("matrix inside the card: rendered before the card closes, below a divider; the register (lecture mode) follows the card", () => {
  const take = TAKE();
  const cardStart = take.indexOf('<section aria-labelledby="take-attendance-heading"');
  const cardEnd = take.indexOf("</section>", cardStart);
  const overview = take.indexOf('{mode !== "REGISTER" ? (');
  assert.ok(cardStart < overview && overview < cardEnd, "the overview block is part of the control card");
  assert.ok(take.indexOf("<AttendanceMatrixTable") < cardEnd);
  assert.ok(take.indexOf('{mode === "REGISTER" ? (') > cardEnd, "the register is its own section after the card");
  assert.equal((take.match(/<AttendanceMatrixTable/g) ?? []).length, 1);
});

test("flush matrix: no border or rounding of its own (no nested card), same internal scrolling and sticky student column", () => {
  const flush = renderToStaticMarkup(<AttendanceMatrixTable matrix={MATRIX} selectedLectureId={null} flush />);
  assert.match(flush, /<div class="max-h-\[70vh\] overflow-auto bg-white" data-matrix="table">/);
  assert.doesNotMatch(flush.slice(0, flush.indexOf("<table")), /border|rounded/);
  assert.match(flush, /<th scope="row" class="sticky left-0/, "sticky student column");
  assert.match(flush, /<th scope="col" class="sticky left-0 top-0/, "sticky corner header");
  assert.match(text(flush), /Amal Perera/);
  assert.match(text(flush), /Present/);
  // The default (elsewhere) keeps its own frame.
  assert.match(renderToStaticMarkup(<AttendanceMatrixTable matrix={MATRIX} selectedLectureId={null} />), /<div class="max-h-\[70vh\] overflow-auto rounded-xl border border-slate-200 bg-white" data-matrix="table">/);
  // Empty states keep the card's padding when flush.
  assert.match(renderToStaticMarkup(<AttendanceMatrixTable matrix={{ ...MATRIX, lectures: [], students: [] }} selectedLectureId={null} flush />), /<p class="m-3 rounded-xl border border-dashed/);
});

test("states inside the card: loading / updating / error / empty keep their messages with the card's padding", () => {
  const take = TAKE();
  const overview = take.slice(take.indexOf('{mode !== "REGISTER" ? ('), take.indexOf("{dialogOpen && classId ? ("));
  assert.match(overview, /className="flex items-center gap-2 px-3 py-2 text-xs text-slate-600">\s*<Loader2[^>]*\/>\s*Loading attendance…/);
  assert.match(overview, /Updating attendance…/);
  assert.match(overview, /<div className="p-3">\s*<div role="alert"/);
  assert.match(overview, /<div className="p-3">\s*<p className="rounded-xl border border-dashed/);
  // No-class state renders inside the one card too.
  const none = renderToStaticMarkup(<AttendanceTakeSection classOptions={[]} classesLoaded initialMonth="2026-11" />);
  assert.equal((none.match(/<section/g) ?? []).length, 1);
  assert.match(card(none), /You have no classes yet/);
});

// =========================================================================================================
// The page heading inside the same card
// =========================================================================================================

test("one outer card: the Attendance heading on top (a divider below), then the workspace and the matrix", () => {
  const html = render();
  assert.equal((html.match(/<section/g) ?? []).length, 1, "exactly one outer card in overview mode");
  const c = card(html);
  const heading = c.indexOf("data-page-header");
  const title = c.indexOf('id="take-attendance-heading"');
  const region = c.indexOf('role="region" aria-label="Choose class and lecture"');
  const matrixBlock = c.indexOf('id="monthly-overview-heading"');
  assert.ok(heading > 0 && heading < title && title < region && region < matrixBlock, "heading → class / month → accordion → matrix");
  assert.match(c, /<div class="border-b border-slate-200 p-3 sm:px-4" data-page-heading-row="[^"]*"><header class="flex min-w-0 items-center gap-3" data-page-header="[^"]*">/);
  assert.match(c, /<h1 class="text-xl font-semibold tracking-tight text-slate-900">Attendance<\/h1>/);
  assert.match(text(c), /Manage class attendance and lecture registers\. Times are Sri Lankan time\./);
  assert.equal((html.match(/<h1/g) ?? []).length, 1);
});

test("the separate heading card is gone: the overview panel draws the heading only when there is no workspace", () => {
  const overview = code(source("components", "attendance", "attendance-overview-panel.tsx"));
  assert.doesNotMatch(overview, /<header/, "no heading markup of its own");
  assert.match(overview, /\{props\.takeAttendance \?\? \(\s*<div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">\s*<AttendancePageHeading \/>\s*<\/div>\s*\)\}/);
  assert.equal((overview.match(/<AttendancePageHeading \/>/g) ?? []).length, 1);
  assert.equal((TAKE().match(/<AttendancePageHeading \/>/g) ?? []).length, 1);
});

test("lecture mode keeps the heading in the card; the register stays below it; the standalone register is unchanged", () => {
  const take = TAKE();
  const cardEnd = take.indexOf("</section>", take.indexOf('<section aria-labelledby="take-attendance-heading"'));
  assert.ok(take.indexOf("<AttendancePageHeading />") < cardEnd, "the heading is always part of the card (both modes)");
  assert.ok(take.indexOf('{mode === "REGISTER" ? (') > cardEnd, "the register follows the card");
  const page = source("app", "dashboard", "attendance", "[lectureId]", "page.tsx");
  assert.match(page, /<LectureAttendanceRegisterPanel lectureId=\{params\.lectureId\} \/>/);
  assert.doesNotMatch(page, /AttendancePageHeading|AttendanceTakeSection/);
});
