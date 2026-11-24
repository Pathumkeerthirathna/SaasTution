/**
 * The "Attendance registers" section (Upcoming / Previous tabs, title search,
 * class and date filters, lecture table, pagination) is hidden on
 * /dashboard/attendance by the reversible SHOW_ATTENDANCE_REGISTERS flag in
 * components/attendance/attendance-overview-panel.tsx. Its source, its API
 * client and the standalone register page stay; the workspace still renders.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { EMPTY_OVERVIEW_FILTERS, OverviewView, SHOW_ATTENDANCE_REGISTERS, type OverviewLoad } from "@/components/attendance/attendance-overview-panel";

const ROOT = path.resolve(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");
const PANEL = () => source("components", "attendance", "attendance-overview-panel.tsx");

const READY: OverviewLoad = {
  kind: "ready",
  items: [],
  pagination: { page: 1, pageSize: 20, totalItems: 3, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
};

function view(extra: Partial<Parameters<typeof OverviewView>[0]> = {}) {
  return renderToStaticMarkup(
    <OverviewView
      tab="upcoming"
      onTabChange={() => {}}
      draft={EMPTY_OVERVIEW_FILTERS}
      onDraftChange={() => {}}
      applied={EMPTY_OVERVIEW_FILTERS}
      onApply={() => {}}
      onClear={() => {}}
      classOptions={[{ id: "C1", name: "Grade 10 Maths" }]}
      load={READY}
      refreshing={false}
      page={1}
      onPageChange={() => {}}
      onRetry={() => {}}
      takeAttendance={<section data-testid="workspace">WORKSPACE</section>}
      {...extra}
    />
  );
}

const REGISTER_PARTS: [string, RegExp][] = [
  ["heading", /Attendance registers/],
  ["Upcoming / Previous tabs", /role="tablist"/],
  ["lecture title search", /Search by title/],
  ["class and date filters", /aria-label="Filters"|From \(date\)|All classes/],
  ["results panel", /id="overview-tabpanel"/],
  ["pagination", /aria-label="Pagination"/],
];

test("the flag is off: the page hides the Attendance registers section", () => {
  assert.equal(SHOW_ATTENDANCE_REGISTERS, false);
  assert.match(PANEL(), /showRegisters=\{SHOW_ATTENDANCE_REGISTERS\}/, "the page passes the flag to the view");
});

test("hidden: no heading, tabs, search, filters, results or pagination; the workspace still renders", () => {
  const html = view({ showRegisters: false });
  for (const [name, pattern] of REGISTER_PARTS) assert.doesNotMatch(html, pattern, name);
  assert.match(html, /data-testid="workspace">WORKSPACE</);
});

test("reversible: with the flag on (or the prop omitted) the whole section renders again", () => {
  for (const html of [view({ showRegisters: true }), view()]) {
    for (const [name, pattern] of REGISTER_PARTS) assert.match(html, pattern, name);
    assert.match(html, /data-testid="workspace">WORKSPACE</);
    assert.ok(html.indexOf("WORKSPACE") < html.indexOf("Attendance registers"), "the workspace stays first");
  }
});

test("hidden: the lecture list is not requested; the class list (the workspace's class selector) still is", () => {
  const panel = PANEL();
  const effect = panel.slice(panel.indexOf("// The lectures: the current list stays visible"));
  assert.match(effect, /useEffect\(\(\) => \{\s*if \(!SHOW_ATTENDANCE_REGISTERS\) return;/);
  assert.match(panel, /attendanceRequest<\{ id: string; name: string \}\[\]>\("\/api\/classes\?page=1&pageSize=50"/);
  assert.doesNotMatch(panel.slice(panel.indexOf("// Class options")), /SHOW_ATTENDANCE_REGISTERS\) return/);
});

test("kept: the section's source, the overview API route and the standalone register page", () => {
  const panel = PANEL();
  for (const part of ["export function OverviewList", "export function OverviewErrorView", "export function createOverviewLoader", 'label: "Upcoming"', 'label: "Previous"']) {
    assert.ok(panel.includes(part), part);
  }
  assert.ok(existsSync(path.join(ROOT, "app", "api", "lectures", "attendance-overview", "route.ts")), "overview API");
  for (const route of [["[lectureId]", "page.tsx"], ["[lectureId]", "scan", "page.tsx"]]) {
    assert.ok(existsSync(path.join(ROOT, "app", "dashboard", "attendance", ...route)), route.join("/"));
    assert.doesNotMatch(source("app", "dashboard", "attendance", ...route), /SHOW_ATTENDANCE_REGISTERS|AttendanceOverviewPanel/, "the standalone register / scanner pages do not use the flag");
  }
});
