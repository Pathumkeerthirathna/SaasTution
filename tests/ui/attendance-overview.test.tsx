/**
 * The teacher attendance overview page (Stage 5.5d-5b):
 * components/attendance/attendance-overview-panel.tsx and its page wrapper.
 * Pure helpers (tab / Colombo date boundaries, labels, empty messages), the
 * loader's stale-response protection (an injected fetch with real Response
 * objects), and the views rendered with react-dom/server from fixture data
 * shaped like the GET /api/lectures/attendance-overview contract. The
 * panel's effects and the wiring are checked from source. Clicking through
 * the real page remains a manual check.
 *
 *   npm run test:attendance-ui
 */

// Not Sri Lankan time: the Colombo day boundaries must not depend on the machine's time zone.
process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EMPTY_OVERVIEW_FILTERS,
  OVERVIEW_PAGE_SIZE,
  OverviewErrorView,
  OverviewList,
  OverviewView,
  colomboDayEnd,
  colomboDayStart,
  createOverviewLoader,
  emptyMessage,
  filtersActive,
  lectureStatusLabel,
  overviewQuery,
  overviewRegisterState,
  registerHref,
  type OverviewFilters,
  type OverviewLoad,
  type OverviewResult,
  type OverviewTab,
} from "../../components/attendance/attendance-overview-panel";
import { formatColomboDateTime } from "../../components/attendance/lecture-attendance-register-panel";
import type { AttendanceApiError, AttendanceOverviewItem, AttendancePagination } from "../../components/attendance/attendance-ui";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const item = (fields: Partial<AttendanceOverviewItem> = {}): AttendanceOverviewItem => ({
  lectureId: "L1",
  title: "Algebra revision",
  date: "2026-11-12T04:30:00.000Z",
  endDate: null,
  classStatus: "SCHEDULED",
  class: { id: "C1", name: "Grade 10 Maths" },
  register: null,
  recordStatus: { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 },
  pendingReviews: 0,
  classification: "LIVE",
  ...fields,
});

const PAGINATION: AttendancePagination = { page: 1, pageSize: 20, totalItems: 3, totalPages: 1, hasNextPage: false, hasPreviousPage: false };
const err = (status: number, code: string, message = "Teacher-facing message"): AttendanceApiError => ({ ok: false, status, code, message });

const NOW = new Date("2026-11-11T06:00:00.000Z"); // 11:30 in Colombo

// ---- Colombo date boundaries and tab queries (pure) -----------------------------------------------

test("Colombo days: start 00:00 and end 23:59:59.999 at +05:30, independent of the machine's time zone; invalid → null", () => {
  assert.equal(colomboDayStart("2026-11-11")?.toISOString(), "2026-11-10T18:30:00.000Z");
  assert.equal(colomboDayEnd("2026-11-11")?.toISOString(), "2026-11-11T18:29:59.999Z");
  for (const bad of ["", "2026-13-01", "11/11/2026", "2026-11-11T00:00", "x"]) {
    assert.equal(colomboDayStart(bad), null, bad);
    assert.equal(colomboDayEnd(bad), null, bad);
  }
});

test("tabs: Upcoming from now ascending; Previous to now − 1 ms descending (disjoint, inclusive API bounds)", () => {
  const up = overviewQuery("upcoming", EMPTY_OVERVIEW_FILTERS, 1, NOW);
  assert.equal(up.from?.toISOString(), NOW.toISOString());
  assert.equal(up.to, null);
  assert.equal(up.sortOrder, "asc");
  assert.equal(up.pageSize, OVERVIEW_PAGE_SIZE);
  assert.equal(up.title, null);
  assert.equal(up.classId, null);

  const prev = overviewQuery("previous", EMPTY_OVERVIEW_FILTERS, 3, NOW);
  assert.equal(prev.to?.getTime(), NOW.getTime() - 1);
  assert.equal(prev.from, null);
  assert.equal(prev.sortOrder, "desc");
  assert.equal(prev.page, 3);
  assert.ok((prev.to as Date).getTime() < (up.from as Date).getTime(), "a lecture at exactly now is only Upcoming");
});

test("tabs + date range: the tab's boundary is combined with the chosen Colombo days", () => {
  const future: OverviewFilters = { ...EMPTY_OVERVIEW_FILTERS, fromDay: "2026-11-20", toDay: "2026-11-25" };
  const up = overviewQuery("upcoming", future, 1, NOW);
  assert.equal(up.from?.toISOString(), "2026-11-19T18:30:00.000Z", "a later from-day wins over now");
  assert.equal(up.to?.toISOString(), "2026-11-25T18:29:59.999Z");

  const today: OverviewFilters = { ...EMPTY_OVERVIEW_FILTERS, fromDay: "2026-11-11", toDay: "2026-11-11" };
  assert.equal(overviewQuery("upcoming", today, 1, NOW).from?.toISOString(), NOW.toISOString(), "an earlier from-day is clamped to now");
  const prevToday = overviewQuery("previous", today, 1, NOW);
  assert.equal(prevToday.from?.toISOString(), "2026-11-10T18:30:00.000Z");
  assert.equal(prevToday.to?.getTime(), NOW.getTime() - 1, "a later to-day is clamped to now − 1 ms");

  const past: OverviewFilters = { ...EMPTY_OVERVIEW_FILTERS, toDay: "2026-10-01" };
  assert.equal(overviewQuery("previous", past, 1, NOW).to?.toISOString(), "2026-10-01T18:29:59.999Z", "an earlier to-day wins");
});

test("filters: title trimmed, class passed through; active detection", () => {
  const q = overviewQuery("previous", { title: "  Algebra ", classId: "C9", fromDay: "", toDay: "" }, 1, NOW);
  assert.equal(q.title, "Algebra");
  assert.equal(q.classId, "C9");
  assert.equal(filtersActive(EMPTY_OVERVIEW_FILTERS), false);
  assert.equal(filtersActive({ ...EMPTY_OVERVIEW_FILTERS, title: "   " }), false);
  for (const key of ["title", "classId", "fromDay", "toDay"] as const) {
    assert.equal(filtersActive({ ...EMPTY_OVERVIEW_FILTERS, [key]: "2026-11-11" }), true, key);
  }
});

// ---- Labels (pure) ---------------------------------------------------------------------------------

test("register state: none / open / finalized with its Colombo date — from the API fields only", () => {
  assert.deepEqual(overviewRegisterState(item()), { kind: "NONE", label: "No attendance recorded yet", detail: null });
  assert.deepEqual(overviewRegisterState(item({ register: { finalized: false, finalizedAt: null, version: 3 } })), { kind: "OPEN", label: "Open", detail: null });
  const at = "2026-11-10T12:00:00.000Z";
  assert.deepEqual(overviewRegisterState(item({ register: { finalized: true, finalizedAt: at, version: 4 } })), {
    kind: "FINALIZED",
    label: "Finalized",
    detail: formatColomboDateTime(at),
  });
});

test("lecture status labels; unknown values are shown as they are; register link encodes the id", () => {
  assert.deepEqual(
    ["SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"].map((s) => lectureStatusLabel(s).label),
    ["Scheduled", "Live", "Completed", "Cancelled"]
  );
  assert.equal(lectureStatusLabel("ODD").label, "ODD");
  assert.equal(registerHref("L 1/x"), "/dashboard/attendance/L%201%2Fx");
});

test("empty messages: upcoming, previous, and no matches when filters are applied", () => {
  assert.equal(emptyMessage("upcoming", EMPTY_OVERVIEW_FILTERS).title, "No upcoming lectures");
  assert.equal(emptyMessage("previous", EMPTY_OVERVIEW_FILTERS).title, "No previous lectures");
  assert.equal(emptyMessage("previous", { ...EMPTY_OVERVIEW_FILTERS, title: "x" }).title, "No lectures match");
  assert.equal(emptyMessage("upcoming", { ...EMPTY_OVERVIEW_FILTERS, classId: "C1" }).title, "No lectures match");
});

// ---- List rendering --------------------------------------------------------------------------------

const ROWS = [
  item({ lectureId: "L1", title: "No register lecture" }),
  item({
    lectureId: "L2",
    title: "Open lecture",
    classStatus: "LIVE",
    register: { finalized: false, finalizedAt: null, version: 2 },
    recordStatus: { PRESENT: 11, LATE: 12, ABSENT: 13, EXCUSED: 14 },
    pendingReviews: 87,
  }),
  item({
    lectureId: "L3",
    title: "Finalized lecture",
    classStatus: "COMPLETED",
    class: { id: "C2", name: "Grade 11 Physics" },
    register: { finalized: true, finalizedAt: "2026-11-09T10:00:00.000Z", version: 7 },
    recordStatus: { PRESENT: 21, LATE: 22, ABSENT: 23, EXCUSED: 24 },
    pendingReviews: 98,
  }),
  item({ lectureId: "L4", title: "Cancelled lecture", classStatus: "CANCELLED" }),
];

function layouts(html: string) {
  const table = html.slice(html.indexOf('data-layout="table"'), html.indexOf('data-layout="cards"'));
  const cards = html.slice(html.indexOf('data-layout="cards"'));
  return { table, cards };
}

test("list: the table and the cards both show every field of every lecture (nothing hidden on mobile)", () => {
  const html = renderToStaticMarkup(<OverviewList items={ROWS} />);
  const { table, cards } = layouts(html);
  assert.match(html, /class="hidden [^"]*md:block" data-layout="table"/);
  assert.match(html, /class="[^"]*md:hidden" data-layout="cards"/);
  for (const [name, part] of [["table", table], ["cards", cards]] as const) {
    const t = text(part);
    for (const row of ROWS) {
      assert.ok(t.includes(row.title), `${name}: ${row.title}`);
      assert.ok(t.includes(row.class.name), `${name}: class`);
      assert.ok(t.includes(formatColomboDateTime(row.date)), `${name}: Colombo date`);
      assert.ok(part.includes(`href="${registerHref(row.lectureId)}"`), `${name}: register link ${row.lectureId}`);
    }
    for (const n of [11, 12, 13, 14, 87, 21, 22, 23, 24, 98]) assert.match(t, new RegExp(`\\b${n}\\b`), `${name}: count ${n}`);
    for (const label of ["No attendance recorded yet", "Open", "Finalized", formatColomboDateTime("2026-11-09T10:00:00.000Z")]) {
      assert.ok(t.includes(label), `${name}: ${label}`);
    }
    for (const label of ["Scheduled", "Live", "Completed", "Cancelled"]) assert.ok(t.includes(label), `${name}: status ${label}`);
    for (const label of ["Present", "Late", "Absent", "Excused", "Pending reviews"]) assert.ok(t.includes(label), `${name}: heading ${label}`);
    assert.equal((part.match(/Open register/g) ?? []).length, ROWS.length, `${name}: one link per lecture`);
  }
});

test("list: a cancelled lecture is marked with text (not colour alone); links name the lecture for screen readers", () => {
  const cancelled = renderToStaticMarkup(<OverviewList items={[item({ classStatus: "CANCELLED", title: "Gone" })]} />);
  assert.equal((text(cancelled).match(/Cancelled/g) ?? []).length, 2, "the badge text in both layouts");
  assert.match(cancelled, /border-rose-300/);
  assert.match(cancelled, /sr-only">: Gone</);
});

// ---- The page view ---------------------------------------------------------------------------------

function view(load: OverviewLoad, extra: Partial<Parameters<typeof OverviewView>[0]> = {}) {
  return renderToStaticMarkup(
    <OverviewView
      tab="upcoming"
      onTabChange={() => {}}
      draft={EMPTY_OVERVIEW_FILTERS}
      onDraftChange={() => {}}
      applied={EMPTY_OVERVIEW_FILTERS}
      onApply={() => {}}
      onClear={() => {}}
      classOptions={[
        { id: "C1", name: "Grade 10 Maths" },
        { id: "C2", name: "Grade 11 Physics" },
      ]}
      load={load}
      refreshing={false}
      page={1}
      onPageChange={() => {}}
      onRetry={() => {}}
      {...extra}
    />
  );
}

test("view: accessible tabs (tablist, selected state, tabpanel labelled by the selected tab)", () => {
  for (const tab of ["upcoming", "previous"] as OverviewTab[]) {
    const html = view({ kind: "ready", items: [], pagination: null }, { tab });
    assert.match(html, /role="tablist"/);
    assert.match(html, new RegExp(`id="overview-tab-${tab}" aria-selected="true"`));
    assert.match(html, new RegExp(`role="tabpanel" aria-labelledby="overview-tab-${tab}"`));
    assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  }
});

test("view: labelled filters with every class option; Apply button; Clear only when filters are set", () => {
  const html = view({ kind: "ready", items: [], pagination: null });
  for (const label of ["Lecture title", "Class", "From (date)", "To (date)"]) assert.ok(text(html).includes(label), label);
  assert.match(html, /<option value="" selected="">All classes<\/option>/);
  assert.match(html, /<option value="C1">Grade 10 Maths<\/option>/);
  assert.match(html, /<option value="C2">Grade 11 Physics<\/option>/);
  assert.match(html, /type="submit"/);
  assert.ok(!text(html).includes("Clear filters"));
  assert.ok(text(view({ kind: "ready", items: [], pagination: null }, { draft: { ...EMPTY_OVERVIEW_FILTERS, title: "x" } })).includes("Clear filters"));
  assert.ok(text(view({ kind: "ready", items: [], pagination: null }, { applied: { ...EMPTY_OVERVIEW_FILTERS, toDay: "2026-11-01" } })).includes("Clear filters"));

  const noClasses = view({ kind: "ready", items: [], pagination: null }, { classOptions: null });
  assert.match(noClasses, /<select[^>]*disabled=""/);
  assert.ok(text(noClasses).includes("Class list unavailable"));
});

test("view: loading, refreshing (list kept), and empty states per tab / filters", () => {
  const loading = view({ kind: "loading" });
  assert.ok(text(loading).includes("Loading lectures"));
  assert.match(loading, /aria-busy="true"/);

  const refreshing = view({ kind: "ready", items: ROWS, pagination: PAGINATION }, { refreshing: true });
  assert.ok(text(refreshing).includes("Updating"));
  assert.ok(text(refreshing).includes("Open lecture"), "the current list stays visible while refreshing");

  assert.ok(text(view({ kind: "ready", items: [], pagination: { ...PAGINATION, totalItems: 0, totalPages: 0 } })).includes("No upcoming lectures"));
  assert.ok(text(view({ kind: "ready", items: [], pagination: null }, { tab: "previous" })).includes("No previous lectures"));
  assert.ok(text(view({ kind: "ready", items: [], pagination: null }, { applied: { ...EMPTY_OVERVIEW_FILTERS, title: "zzz" } })).includes("No lectures match"));
  assert.ok(!view({ kind: "ready", items: [], pagination: { ...PAGINATION, totalItems: 0, totalPages: 0 } }).includes('aria-label="Pagination"'));
});

test("view: pagination from the API metadata; buttons disabled at the ends and while refreshing", () => {
  const middle = view({ kind: "ready", items: ROWS, pagination: { page: 2, pageSize: 20, totalItems: 45, totalPages: 3, hasNextPage: true, hasPreviousPage: true } }, { page: 2 });
  assert.ok(text(middle).includes("Page 2 of 3"));
  assert.ok(text(middle).includes("45 lecture(s)"));
  assert.ok(!/<button[^>]*disabled=""[^>]*>[\s\S]{0,400}?Previous page/.test(middle.slice(middle.indexOf('aria-label="Pagination"'))));

  const first = view({ kind: "ready", items: ROWS, pagination: { ...PAGINATION, totalPages: 2, hasNextPage: true } });
  const nav = first.slice(first.indexOf('aria-label="Pagination"'));
  const buttons = nav.match(/<button[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2);
  assert.match(buttons[0], /disabled=""/, "Previous disabled on page 1");
  assert.doesNotMatch(buttons[1], /disabled=""/, "Next enabled");

  const busy = view({ kind: "ready", items: ROWS, pagination: { ...PAGINATION, totalPages: 2, hasNextPage: true } }, { refreshing: true });
  const busyButtons = busy.slice(busy.indexOf('aria-label="Pagination"')).match(/<button[^>]*>/g) ?? [];
  assert.ok(busyButtons.length === 2 && busyButtons.every((b) => /disabled=""/.test(b)), "no page change while a request is running");
});

test("view: classification unavailable notice only when every lecture has none", () => {
  const none = view({ kind: "ready", items: ROWS.map((r) => ({ ...r, classification: null })), pagination: PAGINATION });
  assert.ok(text(none).includes("Attendance settings are not configured"));
  assert.ok(!text(view({ kind: "ready", items: ROWS, pagination: PAGINATION })).includes("Attendance settings are not configured"));
  const mixed = ROWS.map((r, i) => ({ ...r, classification: i === 0 ? null : r.classification }));
  assert.ok(!text(view({ kind: "ready", items: mixed, pagination: PAGINATION })).includes("Attendance settings are not configured"), "one unclassified lecture is not a configuration problem");
  assert.ok(!text(view({ kind: "ready", items: [], pagination: null })).includes("Attendance settings are not configured"));
});

test("errors: unauthorized → sign in; network / server / class not found → message and Try again", () => {
  const unauthorized = renderToStaticMarkup(<OverviewErrorView error={err(401, "UNAUTHORIZED")} onRetry={() => {}} />);
  assert.ok(text(unauthorized).includes("Please sign in again"));
  assert.match(unauthorized, /href="\/login"/);
  assert.ok(!text(unauthorized).includes("Try again"));
  assert.match(unauthorized, /role="alert"/);

  for (const [status, code, title] of [
    [0, "NETWORK_ERROR", "Could not reach the server"],
    [500, "INTERNAL_SERVER_ERROR", "The lectures could not be loaded"],
    [503, "ATTENDANCE_CONFIG_UNAVAILABLE", "The lectures could not be loaded"],
    [404, "CLASS_NOT_FOUND", "That class is not available"],
    [200, "INVALID_RESPONSE", "The lectures could not be loaded"],
  ] as const) {
    const html = text(renderToStaticMarkup(<OverviewErrorView error={err(status, code, `msg-${code}`)} onRetry={() => {}} />));
    assert.ok(html.includes(title), code);
    assert.ok(html.includes(`msg-${code}`), `${code}: the helper's message`);
    assert.ok(html.includes("Try again"), `${code}: manual retry`);
  }
  assert.ok(text(view({ kind: "error", error: err(0, "NETWORK_ERROR") })).includes("Could not reach the server"));
});

// ---- Loader: stale-response protection -------------------------------------------------------------

type Pending = { url: string; signal: AbortSignal | null | undefined; resolve: (r: Response) => void };

function controlledFetch() {
  const pending: Pending[] = [];
  const impl = (url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      pending.push({ url, signal, resolve });
    });
  return { impl, pending };
}
const page = (title: string) =>
  new Response(JSON.stringify({ success: true, data: [item({ title })], pagination: PAGINATION }), { status: 200, headers: { "Content-Type": "application/json" } });

test("loader: a newer load aborts the older request; a late older response never overwrites newer data", async () => {
  const { impl, pending } = controlledFetch();
  const results: OverviewResult[] = [];
  const loader = createOverviewLoader({ onResult: (r) => results.push(r), fetchImpl: impl, now: () => NOW });

  const first = loader.load("upcoming", EMPTY_OVERVIEW_FILTERS, 1);
  const second = loader.load("previous", EMPTY_OVERVIEW_FILTERS, 1);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal?.aborted, true, "the older request is aborted");
  assert.equal(pending[1].signal?.aborted, false);
  assert.match(pending[0].url, /sortOrder=asc/);
  assert.match(pending[1].url, /sortOrder=desc/);

  pending[1].resolve(page("newer"));
  pending[0].resolve(page("older")); // ignored: already rejected by the abort
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok && results[0].data[0].title, "newer");
  assert.deepEqual(results[0].ok && results[0].pagination, PAGINATION);
});

test("loader: a response arriving after a newer load started is dropped even if it was not aborted in time", async () => {
  const results: OverviewResult[] = [];
  let release: (() => void) | null = null;
  let call = 0;
  // Ignores the abort signal (a fetch that resolves anyway).
  const impl = () => {
    call += 1;
    if (call === 1) return new Promise<Response>((resolve) => (release = () => resolve(page("stale"))));
    return Promise.resolve(page("fresh"));
  };
  const loader = createOverviewLoader({ onResult: (r) => results.push(r), fetchImpl: impl, now: () => NOW });
  const first = loader.load("upcoming", EMPTY_OVERVIEW_FILTERS, 1);
  assert.equal(await loader.load("upcoming", EMPTY_OVERVIEW_FILTERS, 2), true);
  (release as unknown as () => void)();
  assert.equal(await first, false);
  assert.deepEqual(results.map((r) => r.ok && r.data[0].title), ["fresh"]);
});

test("loader: dispose aborts the request in flight and drops its result; errors are delivered with their code", async () => {
  const { impl, pending } = controlledFetch();
  const results: OverviewResult[] = [];
  const loader = createOverviewLoader({ onResult: (r) => results.push(r), fetchImpl: impl, now: () => NOW });
  const inFlight = loader.load("upcoming", EMPTY_OVERVIEW_FILTERS, 1);
  loader.dispose();
  assert.equal(pending[0].signal?.aborted, true);
  assert.equal(await inFlight, false);
  assert.equal(results.length, 0);

  const failing = createOverviewLoader({
    onResult: (r) => results.push(r),
    fetchImpl: async () =>
      new Response(JSON.stringify({ success: false, error: { code: "UNAUTHORIZED", message: "x" } }), { status: 401, headers: { "Content-Type": "application/json" } }),
    now: () => NOW,
  });
  assert.equal(await failing.load("previous", EMPTY_OVERVIEW_FILTERS, 1), true);
  assert.equal(!results[0].ok && results[0].code, "UNAUTHORIZED");
});

test("loader: the query uses the current time and the applied filters", async () => {
  const urls: string[] = [];
  const loader = createOverviewLoader({
    onResult: () => {},
    fetchImpl: async (url: string) => {
      urls.push(url);
      return page("x");
    },
    now: () => NOW,
  });
  await loader.load("previous", { title: " Alg ", classId: "C2", fromDay: "2026-11-01", toDay: "" }, 4);
  const params = new URLSearchParams(urls[0].split("?")[1]);
  assert.deepEqual(Object.fromEntries(params), {
    page: "4",
    pageSize: String(OVERVIEW_PAGE_SIZE),
    sortOrder: "desc",
    title: "Alg",
    classId: "C2",
    from: "2026-10-31T18:30:00.000Z",
    to: new Date(NOW.getTime() - 1).toISOString(),
  });
});

// ---- Wiring (source) -------------------------------------------------------------------------------

test("wiring: thin page wrapper; tab, filter and clear reset to page 1; no browser storage; reachable from the sidebar (Stage 5.5d-5c)", () => {
  const page = source("app", "dashboard", "attendance", "page.tsx");
  assert.match(page, /dynamic\(\s*\(\) => import\("@\/components\/attendance\/attendance-overview-panel"\)/);
  assert.match(page, /<Suspense/);

  const panel = source("components", "attendance", "attendance-overview-panel.tsx");
  assert.match(panel, /^"use client";/);
  const changeTab = panel.slice(panel.indexOf("const changeTab"), panel.indexOf("const apply"));
  assert.match(changeTab, /setPage\(1\)/);
  const apply = panel.slice(panel.indexOf("const apply"), panel.indexOf("const clear"));
  assert.match(apply, /setPage\(1\)/);
  const clear = panel.slice(panel.indexOf("const clear"), panel.indexOf("const retry"));
  assert.match(clear, /setPage\(1\)/);
  assert.match(clear, /setApplied\(EMPTY_OVERVIEW_FILTERS\)/);
  assert.match(panel, /\}, \[tab, applied, page, attempt\]\);/, "the list reloads on tab, applied filters, page and retry only (not per keystroke)");
  assert.doesNotMatch(panel, /localStorage|sessionStorage|indexedDB/);
  assert.match(panel, /\/api\/classes\?page=1&pageSize=50/);
  assert.match(panel, /return \(\) => loader\?\.dispose\(\)/);

  assert.match(source("components", "dashboard-shell.tsx"), /href: "\/dashboard\/attendance",\s+label: "Attendance"/, "the sidebar item (tests/ui/dashboard-attendance-nav.test.tsx covers its active state)");
});
