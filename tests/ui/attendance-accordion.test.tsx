/**
 * The Attendance workspace's selection bar (components/attendance/attendance-take-section.tsx):
 * the first class selected on load, the current Colombo month from the
 * server page, a compact collapsible accordion for the Class / Lecture
 * selectors, and the contextual heading.
 *
 * No DOM library is installed: pure helpers are tested directly, the first
 * render with react-dom/server, and the wiring (effects, handlers) from
 * source. Clicking through a real browser remains a manual check.
 *
 *   npm run test:attendance-ui
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { colomboMonthKey, isMonthKey } from "../../components/attendance/attendance-month";
import {
  AttendanceTakeSection,
  classMonthTitle,
  firstClassId,
  lectureSummary,
  workspaceMode,
} from "../../components/attendance/attendance-take-section";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const TAKE = () => code(source("components", "attendance", "attendance-take-section.tsx"));
const slice = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));
const sl = (wall: string) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60_000);

const CLASSES = [
  { id: "C1", name: "Math - class 04" },
  { id: "C2", name: "Physics" },
];

// =========================================================================================================
// 1-4. Initial load
// =========================================================================================================

test("1. the first of the teacher's classes is selected once the class list has loaded (its own order; never before; never again)", () => {
  assert.equal(firstClassId(CLASSES, true), "C1");
  assert.equal(firstClassId(CLASSES, false), "", "not while loading");
  assert.equal(firstClassId([], true), "", "no classes");
  assert.equal(firstClassId(null, true), "", "the list failed");
  const take = TAKE();
  const effect = slice(take, "useEffect(() => {\n    if (autoSelected.current || classId) return;", "useEffect(() => {\n    if (!classId) return;");
  assert.match(effect, /const first = firstClassId\(classOptions, classesLoaded\);\s+if \(!first\) return;\s+autoSelected\.current = true;\s+setClassId\(first\);/);
  // The list is the existing, ownership-checked class API, loaded once by the page panel.
  const panel = code(source("components", "attendance", "attendance-overview-panel.tsx"));
  assert.match(panel, /attendanceRequest<\{ id: string; name: string \}\[\]>\("\/api\/classes\?page=1&pageSize=50"/);
  assert.match(panel, /setClassOptions\([^;]+;\s+setClassesLoaded\(true\);/);
  assert.match(panel, /takeAttendance=\{<AttendanceTakeSection classOptions=\{classOptions\} classesLoaded=\{classesLoaded\} initialMonth=\{initialMonth\} \/>\}/);
});

test("2. the current Colombo month: computed once by the server page and handed to the client (one value: no hydration mismatch)", () => {
  const page = source("app", "dashboard", "attendance", "page.tsx");
  assert.match(page, /noStore\(\); \/\/ per request/);
  assert.match(page, /const initialMonth = colomboMonthKey\(new Date\(\)\);/);
  assert.match(page, /<AttendanceOverviewPanel initialMonth=\{initialMonth\} \/>/);
  assert.match(page, /import \{ colomboMonthKey \} from "@\/components\/attendance\/attendance-month";/);
  assert.doesNotMatch(code(source("components", "attendance", "attendance-month.ts")), /^"use client"/m, "a plain module the server can call");
  assert.equal(colomboMonthKey(sl("2026-12-01T00:00")), "2026-12");
  // The server's month wins over the clock; an invalid one falls back to the Colombo clock.
  const january = text(renderToStaticMarkup(<AttendanceTakeSection classOptions={CLASSES} initialMonth="2027-01" now={() => sl("2026-11-23T09:00")} />));
  assert.match(january, /Math - class 04 — January 2027|January 2027/);
  assert.match(january, /No lecture selected · monthly overview/);
  assert.match(renderToStaticMarkup(<AttendanceTakeSection classOptions={CLASSES} initialMonth="2027-01" />), /data-month="2027-01"/);
  const fallback = text(renderToStaticMarkup(<AttendanceTakeSection classOptions={CLASSES} initialMonth="2027-13" now={() => sl("2026-11-23T09:00")} />));
  assert.match(fallback, /November 2026/);
  assert.doesNotMatch(fallback, /2027/);
  assert.equal(isMonthKey("2027-13"), false);
  assert.equal(isMonthKey("2027-01"), true);
});

test("3. the matrix loads automatically for the first class and the month, once (one request site, no accordion dependency)", () => {
  const take = TAKE();
  assert.equal((take.match(/fetchClassAttendanceMatrix\(/g) ?? []).length, 1);
  const effect = slice(take, "useEffect(() => {\n    if (!classId || !overview) return;", "const resetLectures");
  assert.match(effect, /\}, \[classId, month, matrixAttempt, overview\]\);/);
  // Selecting the first class is a single classId change: "" → C1 → one matrix request, one lecture-list request.
  assert.equal(workspaceMode("C1", ""), "OVERVIEW");
});

test("4. no classes: an empty state, Change disabled, nothing loaded; the list failing or still loading says so", () => {
  const none = renderToStaticMarkup(<AttendanceTakeSection classOptions={[]} classesLoaded initialMonth="2026-11" />);
  assert.match(text(none), /No classes yet/);
  assert.match(text(none), /You have no classes yet\. Create a class first; its attendance will appear here\./);
  assert.match(none, /data-empty-state="no-classes"/);
  assert.match(none, /<button type="button" aria-expanded="false" aria-controls="[^"]+" disabled=""[^>]*data-selection-toggle/);
  assert.match(text(renderToStaticMarkup(<AttendanceTakeSection classOptions={null} classesLoaded initialMonth="2026-11" />)), /Your classes could not be loaded\./);
  assert.match(text(renderToStaticMarkup(<AttendanceTakeSection classOptions={[]} classesLoaded={false} initialMonth="2026-11" />)), /Loading your classes…/);
  // Without a class there is no list or matrix request (both effects return first).
  const take = TAKE();
  assert.match(take, /useEffect\(\(\) => \{\n    if \(!classId\) return;/);
  assert.match(take, /if \(!classId \|\| !overview\) return;/);
});

// =========================================================================================================
// 5-9. The accordion
// =========================================================================================================

test("5. the accordion starts collapsed: a one-line summary, Change, the selectors hidden (but mounted)", () => {
  const html = renderToStaticMarkup(<AttendanceTakeSection classOptions={CLASSES} initialMonth="2026-11" />);
  assert.match(html, /aria-expanded="false"/);
  assert.match(text(html), /Change/);
  assert.match(html, /role="region" aria-label="Choose class and lecture" class="grid transition-\[grid-template-rows\] duration-200 ease-out motion-reduce:transition-none invisible grid-rows-\[0fr\]" data-selection-region="closed"/);
  assert.match(html, /Lecture in November 2026 \(optional\)/, "the selectors exist (mounted), only hidden");
  assert.match(text(html), /No class selected — November 2026/, "before the first class is chosen (an effect, after the first render)");
  assert.match(text(html), /No lecture selected · monthly overview/);
  assert.match(TAKE(), /const \[expanded, setExpanded\] = useState\(false\);/);
});

test("6-7. Change opens the selectors inline (no popover); Close / Done fold them away without touching any selection", () => {
  const take = TAKE();
  assert.match(take, /onClick=\{\(\) => setExpanded\(\(open\) => !open\)\}\s+aria-expanded=\{expanded\}\s+aria-controls=\{regionId\}/);
  assert.match(take, /\{expanded \? "Close" : "Change"\}/);
  assert.match(take, /<button type="button" onClick=\{\(\) => setExpanded\(false\)\} className=\{`\$\{SECONDARY_BUTTON\} h-10`\}>\s*<Check size=\{14\} aria-hidden \/>\s*Done/);
  assert.match(take, /\$\{expanded \? "grid-rows-\[1fr\]" : "invisible grid-rows-\[0fr\]"\}/, "an animated inline accordion");
  assert.doesNotMatch(take, /createPortal|position: "fixed"|popover/i, "not a floating popover");
  // The region is never conditionally rendered (state, focus targets and the dialogs' fallback stay).
  assert.doesNotMatch(take, /\{expanded \? \(|expanded &&/);
  // Opening / closing only sets `expanded`: no selection setter, no request, no effect depends on it.
  for (const effectDeps of take.match(/\}, \[[^\]]*\]\);/g) ?? []) assert.doesNotMatch(effectDeps, /expanded/, effectDeps);
});

test("8-9. choosing a lecture collapses the accordion and opens the register; clearing it returns to the overview (class and month kept)", () => {
  const take = TAKE();
  const change = slice(take, "const changeLecture", "const openScannerModal");
  assert.match(change, /setLectureId\(next\);\s+if \(next\) setExpanded\(false\);/);
  assert.equal(workspaceMode("C1", "L1"), "REGISTER");
  assert.equal(workspaceMode("C1", ""), "OVERVIEW");
  assert.doesNotMatch(change, /setClassId|setMonth/);
  assert.match(take, /\{lectureId \? \(\s*<button type="button" onClick=\{\(\) => setLectureId\(""\)\} className=\{SECONDARY_BUTTON\}>[\s\S]*?Monthly overview/, "back to the monthly overview, from the control card");
});

// =========================================================================================================
// 10-12. Month, heading, requests
// =========================================================================================================

test("10. Previous / Next month stay outside the accordion; they keep the class and clear the lecture", () => {
  const take = TAKE();
  assert.ok(take.indexOf('aria-label="Month"') < take.indexOf('role="region"'), "in the always-visible bar");
  const change = slice(take, "const changeMonth", "const changeLecture");
  assert.match(change, /resetLectures\(\);\s+setMonth\(\(current\) => shiftMonthKey\(current, delta\)\);/);
  assert.doesNotMatch(change, /setClassId|setExpanded/, "the class is kept; the accordion keeps its state");
  assert.match(slice(take, "const resetLectures", "const changeClass"), /setLectureId\(""\);/);
});

test("11. the control card's title names the class and the month ('<class> — <month>'); the lecture line below it", () => {
  assert.equal(classMonthTitle("Math - class 04", "2026-11"), "Math - class 04 — November 2026");
  assert.equal(classMonthTitle("", "2026-11"), "November 2026");
  assert.equal(lectureSummary(null), "No lecture selected · monthly overview");
  assert.equal(
    lectureSummary({ id: "L", title: "Kinematics", date: sl("2026-11-23T09:00").toISOString(), endDate: null, classStatus: "SCHEDULED" }),
    "Lecture: Kinematics · 23 Nov 2026, 09:00"
  );
  assert.match(TAKE(), /const title = className \? classMonthTitle\(className, month\) : `\$\{classStatus\} — \$\{monthLabel\(month\)\}`;/);
});

test("12. opening / closing the accordion triggers no request: requests live only in effects keyed by class, month, page and mode", () => {
  const take = TAKE();
  assert.equal((take.match(/fetchClassLectures\(/g) ?? []).length, 1);
  assert.equal((take.match(/fetchClassAttendanceMatrix\(/g) ?? []).length, 1);
  assert.match(take, /\}, \[classId, month, lecturePage\]\);/);
  assert.match(take, /\}, \[classId, month, matrixAttempt, overview\]\);/);
  // Stale requests: aborted on every change (unchanged).
  assert.equal((take.match(/return \(\) => controller\.abort\(\);/g) ?? []).length, 2);
});

// =========================================================================================================
// 13-14. Scanner, creation, standalone register
// =========================================================================================================

test("13. QR scanner and lecture creation are unchanged: Open QR Scanner in the selectors, the modal, the dialog, then collapse", () => {
  const take = TAKE();
  assert.match(take, /id=\{TAKE_ATTENDANCE_BUTTON_ID\}/);
  assert.match(take, /if \(action\.kind === "OPEN_SCANNER"\) openScannerModal\(action\.lectureId\);\s+else if \(action\.kind === "CREATE_LECTURE"\) setDialogOpen\(true\);/);
  assert.match(slice(take, "const lectureReady", "const reloadMatrix"), /setLectureId\(lecture\.id\);\s+setExpanded\(false\);\s+openScannerModal\(lecture\.id\);/);
  assert.match(take, /<QrScannerModal key=\{`\$\{scanner\.lectureId\}:\$\{scanner\.opening\}`\}/);
  // The register offers its own Open QR scanner (the same modal) when a lecture is selected.
  assert.match(take, /onOpenScanner=\{openSelectedScanner\}/);
});

test("14. the standalone register page is unchanged", () => {
  const page = source("app", "dashboard", "attendance", "[lectureId]", "page.tsx");
  assert.match(page, /<LectureAttendanceRegisterPanel lectureId=\{params\.lectureId\} \/>/);
  assert.doesNotMatch(page, /initialMonth|AttendanceTakeSection/);
});

test("responsive: the summary wraps beside the month controls and Change; selectors stack on phones; 38-40px controls", () => {
  const html = renderToStaticMarkup(<AttendanceTakeSection classOptions={CLASSES} initialMonth="2026-11" />);
  assert.match(html, /<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3"><div class="min-w-0 flex-1"><h2 id="take-attendance-heading"/);
  assert.match(html, /<div class="flex flex-wrap items-center gap-2"><nav aria-label="Month"/);
  assert.match(html, /class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end"/);
  assert.match(html, /data-selection-toggle/);
  assert.match(TAKE(), /className="inline-flex h-\[38px\] items-center gap-1 rounded-lg border border-\[#112D5C\] bg-white px-3 text-\[13px\] font-semibold text-\[#112D5C\]/);
  assert.doesNotMatch(html, /w-\[\d{3,}px\]|min-w-\[\d{3,}px\]/);
});
