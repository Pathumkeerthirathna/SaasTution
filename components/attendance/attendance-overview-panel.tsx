"use client";

/*
 * The teacher's attendance overview (Stage 5.5d-5b): the teacher's lectures
 * with each attendance register's state, from
 * GET /api/lectures/attendance-overview (fetchAttendanceOverview). Read only.
 *
 * Tabs: Upcoming (from = now, ascending) and Previous (to = now − 1 ms,
 * descending): the API filters lecture dates inclusively, so a lecture is in
 * exactly one tab. The optional date range is a pair of Sri Lankan
 * (Asia/Colombo) calendar days, combined with the tab's boundary. Search,
 * class and dates are applied with an explicit "Apply" (no request per
 * keystroke); only the newest request may update the page and older ones are
 * aborted. Everything shown comes from the API: register state, counts and
 * pending reviews are never recalculated, and there are no page-wide summary
 * cards (one page of lectures would make them misleading). Nothing is cached
 * or stored in the browser; the server decides which lectures are shown.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  Info,
  Loader2,
  Lock,
  LockOpen,
  RefreshCw,
  Search,
  ServerCrash,
  WifiOff,
  XCircle,
} from "lucide-react";

import {
  attendanceErrorAction,
  attendanceRequest,
  fetchAttendanceOverview,
  type AttendanceApiError,
  type AttendanceOverviewItem,
  type AttendanceOverviewQuery,
  type AttendancePagination,
} from "@/components/attendance/attendance-ui";
import { formatColomboDateTime } from "@/components/attendance/lecture-attendance-register-panel";
import { createLatestRequestGate } from "@/components/attendance/reconciliation-controller";
import { AttendanceTakeSection } from "@/components/attendance/attendance-take-section";
import { AttendancePageHeading } from "@/components/attendance/attendance-page-heading";

// =========================================================================================
// Pure helpers (exported for tests)
// =========================================================================================

export type OverviewTab = "upcoming" | "previous";
export type OverviewFilters = { title: string; classId: string; fromDay: string; toDay: string };
export const EMPTY_OVERVIEW_FILTERS: OverviewFilters = { title: "", classId: "", fromDay: "", toDay: "" };
export const OVERVIEW_PAGE_SIZE = 20;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The first instant of a Sri Lankan (Asia/Colombo, UTC+05:30) calendar day "YYYY-MM-DD"; null when invalid. */
export function colomboDayStart(day: string): Date | null {
  if (!DAY.test(day)) return null;
  const instant = new Date(`${day}T00:00:00.000+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** The last millisecond of a Sri Lankan calendar day "YYYY-MM-DD"; null when invalid. */
export function colomboDayEnd(day: string): Date | null {
  if (!DAY.test(day)) return null;
  const instant = new Date(`${day}T23:59:59.999+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

const later = (a: Date | null, b: Date) => (a && a.getTime() > b.getTime() ? a : b);
const earlier = (a: Date | null, b: Date) => (a && a.getTime() < b.getTime() ? a : b);

/**
 * The API query for a tab, the applied filters and a page. Upcoming:
 * from = max(now, start of the "from" day), ascending. Previous:
 * to = min(now − 1 ms, end of the "to" day), descending. The other bound is
 * the chosen day's (or none).
 */
export function overviewQuery(tab: OverviewTab, filters: OverviewFilters, page: number, now: Date): AttendanceOverviewQuery {
  const fromDay = colomboDayStart(filters.fromDay);
  const toDay = colomboDayEnd(filters.toDay);
  const base = { page, pageSize: OVERVIEW_PAGE_SIZE, title: filters.title.trim() || null, classId: filters.classId || null };
  return tab === "upcoming"
    ? { ...base, from: later(fromDay, now), to: toDay, sortOrder: "asc" }
    : { ...base, from: fromDay, to: earlier(toDay, new Date(now.getTime() - 1)), sortOrder: "desc" };
}

export function filtersActive(filters: OverviewFilters): boolean {
  return filters.title.trim() !== "" || filters.classId !== "" || filters.fromDay !== "" || filters.toDay !== "";
}

export type RegisterStateLabel = { kind: "NONE" | "OPEN" | "FINALIZED"; label: string; detail: string | null };

/** The register state as the API reports it (no other states are invented). */
export function overviewRegisterState(item: AttendanceOverviewItem): RegisterStateLabel {
  if (!item.register) return { kind: "NONE", label: "No attendance recorded yet", detail: null };
  if (item.register.finalized) {
    return { kind: "FINALIZED", label: "Finalized", detail: item.register.finalizedAt ? formatColomboDateTime(item.register.finalizedAt) : null };
  }
  return { kind: "OPEN", label: "Open", detail: null };
}

const LECTURE_STATUS: Record<string, { label: string; tone: string }> = {
  SCHEDULED: { label: "Scheduled", tone: "border-slate-200 bg-slate-50 text-slate-700" },
  LIVE: { label: "Live", tone: "border-sky-200 bg-sky-50 text-sky-800" },
  COMPLETED: { label: "Completed", tone: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  CANCELLED: { label: "Cancelled", tone: "border-rose-300 bg-rose-50 text-rose-800" },
};

export function lectureStatusLabel(classStatus: string): { label: string; tone: string } {
  return LECTURE_STATUS[classStatus] ?? { label: classStatus, tone: "border-slate-200 bg-slate-50 text-slate-700" };
}

export function emptyMessage(tab: OverviewTab, filters: OverviewFilters): { title: string; body: string } {
  if (filtersActive(filters)) return { title: "No lectures match", body: "No lecture matches the search and filters. Change or clear them to see more." };
  return tab === "upcoming"
    ? { title: "No upcoming lectures", body: "Lectures you schedule will appear here." }
    : { title: "No previous lectures", body: "Lectures that have taken place will appear here." };
}

export const registerHref = (lectureId: string) => `/dashboard/attendance/${encodeURIComponent(lectureId)}`;

// =========================================================================================
// Presentational pieces
// =========================================================================================

function StatusBadge({ classStatus }: { classStatus: string }) {
  const status = lectureStatusLabel(classStatus);
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${status.tone}`}>
      {classStatus === "CANCELLED" ? <XCircle size={11} aria-hidden /> : null}
      {status.label}
    </span>
  );
}

function RegisterState({ item }: { item: AttendanceOverviewItem }) {
  const state = overviewRegisterState(item);
  return (
    <span className="inline-flex flex-col items-start gap-0.5 text-xs text-slate-800">
      <span className="inline-flex items-center gap-1 font-semibold">
        {state.kind === "FINALIZED" ? <Lock size={12} aria-hidden /> : state.kind === "OPEN" ? <LockOpen size={12} aria-hidden /> : <Info size={12} aria-hidden />}
        {state.label}
      </span>
      {state.detail ? <span className="text-[11px] text-slate-500">{state.detail}</span> : null}
    </span>
  );
}

function RegisterLink({ item }: { item: AttendanceOverviewItem }) {
  return (
    <Link
      href={registerHref(item.lectureId)}
      className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-[#112D5C] px-2.5 text-xs font-semibold text-[#112D5C] hover:bg-[#112D5C] hover:text-white"
    >
      <ClipboardCheck size={13} aria-hidden />
      Open register
      <span className="sr-only">: {item.title}</span>
    </Link>
  );
}

const COUNT_FIELDS: [keyof AttendanceOverviewItem["recordStatus"], string][] = [
  ["PRESENT", "Present"],
  ["LATE", "Late"],
  ["ABSENT", "Absent"],
  ["EXCUSED", "Excused"],
];

function CardField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-800">{children}</dd>
    </div>
  );
}

export function OverviewList({ items }: { items: readonly AttendanceOverviewItem[] }) {
  return (
    <>
      {/* Wide screens: a table (scrolls sideways when needed, every column kept). */}
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block" data-layout="table">
        <table className="w-full min-w-[1000px] text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Lecture</th>
              <th className="px-3 py-2">Class</th>
              <th className="px-3 py-2">Date and time</th>
              <th className="px-3 py-2">Lecture status</th>
              <th className="px-3 py-2">Register</th>
              {COUNT_FIELDS.map(([, label]) => (
                <th key={label} className="px-3 py-2 text-right">{label}</th>
              ))}
              <th className="px-3 py-2 text-right">Pending reviews</th>
              <th className="px-3 py-2"><span className="sr-only">Register link</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item) => (
              <tr key={item.lectureId} className={`align-top ${item.classStatus === "CANCELLED" ? "bg-rose-50/40" : ""}`}>
                <td className="px-3 py-2 font-medium text-slate-900">{item.title}</td>
                <td className="px-3 py-2 text-slate-700">{item.class.name}</td>
                <td className="px-3 py-2 text-xs text-slate-700">{formatColomboDateTime(item.date)}</td>
                <td className="px-3 py-2"><StatusBadge classStatus={item.classStatus} /></td>
                <td className="px-3 py-2"><RegisterState item={item} /></td>
                {COUNT_FIELDS.map(([key]) => (
                  <td key={key} className="px-3 py-2 text-right tabular-nums text-slate-800">{item.recordStatus[key]}</td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums text-slate-800">{item.pendingReviews}</td>
                <td className="px-3 py-2 text-right"><RegisterLink item={item} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrow screens: cards with the same fields. */}
      <ul className="flex flex-col gap-2 md:hidden" data-layout="cards">
        {items.map((item) => (
          <li key={item.lectureId} className={`rounded-xl border bg-white p-3 shadow-sm ${item.classStatus === "CANCELLED" ? "border-rose-300" : "border-slate-200"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words font-semibold text-slate-900">{item.title}</p>
                <p className="text-xs text-slate-600">Class: {item.class.name}</p>
              </div>
              <StatusBadge classStatus={item.classStatus} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              <CardField label="Date and time">{formatColomboDateTime(item.date)}</CardField>
              <CardField label="Register"><RegisterState item={item} /></CardField>
              {COUNT_FIELDS.map(([key, label]) => (
                <CardField key={key} label={label}>{item.recordStatus[key]}</CardField>
              ))}
              <CardField label="Pending reviews">{item.pendingReviews}</CardField>
            </dl>
            <div className="mt-3">
              <RegisterLink item={item} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function OverviewErrorView({ error, onRetry }: { error: AttendanceApiError; onRetry: () => void }) {
  const action = attendanceErrorAction(error.code);
  const title =
    error.code === "UNAUTHORIZED"
      ? "Please sign in again"
      : error.code === "NETWORK_ERROR"
        ? "Could not reach the server"
        : error.code === "CLASS_NOT_FOUND"
          ? "That class is not available"
          : "The lectures could not be loaded";
  const icon = error.code === "NETWORK_ERROR" ? <WifiOff size={22} aria-hidden /> : <ServerCrash size={22} aria-hidden />;
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <span className="text-[#112D5C]">{icon}</span>
      <p className="text-lg font-semibold text-slate-900">{title}</p>
      <p className="max-w-md text-sm text-slate-600">{error.message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {action === "SIGN_IN" ? (
          <Link href="/login" className="rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            Sign in
          </Link>
        ) : (
          <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            <RefreshCw size={14} aria-hidden />
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

const TABS: { id: OverviewTab; label: string; icon: React.ReactNode }[] = [
  { id: "upcoming", label: "Upcoming", icon: <CalendarClock size={14} aria-hidden /> },
  { id: "previous", label: "Previous", icon: <CalendarDays size={14} aria-hidden /> },
];

export type OverviewLoad =
  | { kind: "loading" }
  | { kind: "error"; error: AttendanceApiError }
  | { kind: "ready"; items: AttendanceOverviewItem[]; pagination: AttendancePagination | null };

export type ClassOption = { id: string; name: string };

/** The whole page from its state (presentational; the panel owns loading). */
export function OverviewView(props: {
  tab: OverviewTab;
  onTabChange: (tab: OverviewTab) => void;
  draft: OverviewFilters;
  onDraftChange: (draft: OverviewFilters) => void;
  applied: OverviewFilters;
  onApply: () => void;
  onClear: () => void;
  classOptions: ClassOption[] | null;
  load: OverviewLoad;
  refreshing: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  /** The "Take attendance" section (class / lecture selectors, QR scanner, class matrix), shown under the header. */
  takeAttendance?: React.ReactNode;
  /** Render the "Attendance registers" section (tabs, filters, lecture list, pagination). Default true; the page passes SHOW_ATTENDANCE_REGISTERS. */
  showRegisters?: boolean;
}) {
  const { tab, draft, load, refreshing } = props;
  const items = load.kind === "ready" ? load.items : [];
  const pagination = load.kind === "ready" ? load.pagination : null;
  const unconfigured = load.kind === "ready" && items.length > 0 && items.every((item) => item.classification === null);
  const empty = emptyMessage(tab, props.applied);

  return (
    <div className="flex w-full flex-col gap-4">
      {/* The page heading is the first part of the workspace's single card; without the workspace, its own card. */}
      {props.takeAttendance ?? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <AttendancePageHeading />
        </div>
      )}

      {/* The existing lecture list (Upcoming / Previous, filters, register links); hidden on the page while SHOW_ATTENDANCE_REGISTERS is false. */}
      {props.showRegisters === false ? null : (
        <>
          <h2 className="mt-1 flex items-center gap-2 text-base font-semibold text-slate-900">
            <CalendarClock size={16} className="text-[#32598A]" aria-hidden />
            Attendance registers
          </h2>

          {/* Tabs */}
          <div role="tablist" aria-label="Lectures" className="flex gap-1 rounded-xl border border-slate-200 bg-white p-1">
            {TABS.map((t) => {
              const selected = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`overview-tab-${t.id}`}
                  aria-selected={selected}
                  aria-controls="overview-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => props.onTabChange(t.id)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "ArrowLeft") props.onTabChange(t.id === "upcoming" ? "previous" : "upcoming");
                  }}
                  className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                    selected ? "bg-[#112D5C] text-white" : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {t.icon}
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Filters (applied explicitly) */}
          <form
            aria-label="Filters"
            onSubmit={(event) => {
              event.preventDefault();
              props.onApply();
            }}
            className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:flex-row sm:flex-wrap sm:items-end"
          >
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-slate-600">
              Lecture title
              <span className="relative">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
                <input
                  type="search"
                  value={draft.title}
                  onChange={(event) => props.onDraftChange({ ...draft, title: event.target.value })}
                  placeholder="Search by title"
                  className="h-9 w-full rounded-lg border border-slate-200 pl-8 pr-2 text-sm font-normal text-slate-800 outline-none focus:border-[#112D5C]"
                />
              </span>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
              Class
              <select
                value={draft.classId}
                onChange={(event) => props.onDraftChange({ ...draft, classId: event.target.value })}
                disabled={props.classOptions === null}
                className="h-9 rounded-lg border border-slate-200 px-2 text-sm font-normal text-slate-800 disabled:opacity-60"
              >
                <option value="">All classes</option>
                {(props.classOptions ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
              From (date)
              <input type="date" value={draft.fromDay} onChange={(event) => props.onDraftChange({ ...draft, fromDay: event.target.value })} className="h-9 rounded-lg border border-slate-200 px-2 text-sm font-normal text-slate-800" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
              To (date)
              <input type="date" value={draft.toDay} onChange={(event) => props.onDraftChange({ ...draft, toDay: event.target.value })} className="h-9 rounded-lg border border-slate-200 px-2 text-sm font-normal text-slate-800" />
            </label>
            <div className="flex gap-2">
              <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#112D5C] px-3 text-sm font-semibold text-white hover:opacity-90">
                <Search size={14} aria-hidden />
                Apply
              </button>
              {filtersActive(draft) || filtersActive(props.applied) ? (
                <button type="button" onClick={props.onClear} className="h-9 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  Clear filters
                </button>
              ) : null}
            </div>
            {props.classOptions === null ? <p className="w-full text-[11px] text-slate-500">Class list unavailable; the class filter is disabled.</p> : null}
          </form>

          <div id="overview-tabpanel" role="tabpanel" aria-labelledby={`overview-tab-${tab}`} aria-busy={load.kind === "loading" || refreshing} className="flex flex-col gap-3">
            {refreshing ? (
              <p role="status" className="flex items-center gap-1.5 text-xs text-slate-600">
                <Loader2 size={13} className="animate-spin" aria-hidden />
                Updating…
              </p>
            ) : null}

            {unconfigured ? (
              <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                Attendance settings are not configured on this server, so live / historical attendance cannot be determined.
              </p>
            ) : null}

            {load.kind === "loading" ? (
              <div role="status" className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
                <Loader2 size={16} className="animate-spin text-[#112D5C]" aria-hidden />
                Loading lectures…
              </div>
            ) : null}

            {load.kind === "error" ? <OverviewErrorView error={load.error} onRetry={props.onRetry} /> : null}

            {load.kind === "ready" && items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
                <ClipboardList size={20} className="text-slate-400" aria-hidden />
                <p className="font-semibold text-slate-800">{empty.title}</p>
                <p className="max-w-md text-sm text-slate-500">{empty.body}</p>
              </div>
            ) : null}

            {load.kind === "ready" && items.length > 0 ? <OverviewList items={items} /> : null}

            {pagination && pagination.totalItems > 0 ? (
              <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-600">
                  Page {pagination.page} of {pagination.totalPages} · {pagination.totalItems} lecture(s)
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => props.onPageChange(props.page - 1)}
                    disabled={!pagination.hasPreviousPage || refreshing}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ChevronLeft size={13} aria-hidden />
                    Previous page
                  </button>
                  <button
                    type="button"
                    onClick={() => props.onPageChange(props.page + 1)}
                    disabled={!pagination.hasNextPage || refreshing}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Next page
                    <ChevronRight size={13} aria-hidden />
                  </button>
                </div>
              </nav>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

// =========================================================================================
// Loading (only the newest request may update the page)
// =========================================================================================

export type OverviewResult = Awaited<ReturnType<typeof fetchAttendanceOverview>>;

/**
 * Loads overview pages. Every load aborts the previous request, and a result
 * is delivered only if its request is still the newest one (an aborted, older
 * or post-dispose response is dropped: it can never overwrite newer data).
 * `load` resolves true when the result was delivered.
 */
export function createOverviewLoader(deps: {
  onResult: (result: OverviewResult) => void;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
}) {
  const gate = createLatestRequestGate();
  let inFlight: AbortController | null = null;
  return {
    load(tab: OverviewTab, filters: OverviewFilters, page: number): Promise<boolean> {
      const id = gate.begin();
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      const query = overviewQuery(tab, filters, page, deps.now ? deps.now() : new Date());
      return fetchAttendanceOverview(query, { signal: controller.signal, fetchImpl: deps.fetchImpl }).then((result) => {
        if (!gate.isCurrent(id) || controller.signal.aborted) return false;
        inFlight = null;
        deps.onResult(result);
        return true;
      });
    },
    /** Unmount: abort the request in flight; nothing may update the page afterwards. */
    dispose() {
      gate.invalidate();
      inFlight?.abort();
      inFlight = null;
    },
  };
}

// =========================================================================================
// The panel
// =========================================================================================

/**
 * Whether /dashboard/attendance shows the "Attendance registers" section
 * (Upcoming / Previous tabs, filters, lecture list, pagination) under the
 * workspace. Hidden for now; set to true to bring it back. While hidden, its
 * lecture list is not requested. Its components, APIs and the standalone
 * register page are unchanged.
 */
export const SHOW_ATTENDANCE_REGISTERS: boolean = false;

/** `initialMonth`: the current Sri Lankan month "YYYY-MM", computed once by the server page (the workspace's first month). */
export function AttendanceOverviewPanel({ initialMonth }: { initialMonth?: string } = {}) {
  const [tab, setTab] = useState<OverviewTab>("upcoming");
  const [draft, setDraft] = useState<OverviewFilters>(EMPTY_OVERVIEW_FILTERS);
  const [applied, setApplied] = useState<OverviewFilters>(EMPTY_OVERVIEW_FILTERS);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<OverviewLoad>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [classOptions, setClassOptions] = useState<ClassOption[] | null>([]);
  /** The class list request has finished (the workspace then selects the first class, or shows that there are none). */
  const [classesLoaded, setClassesLoaded] = useState(false);

  const hasData = useRef(false);
  const loaderRef = useRef<ReturnType<typeof createOverviewLoader> | null>(null);
  if (loaderRef.current === null) {
    loaderRef.current = createOverviewLoader({
      onResult: (result) => {
        setRefreshing(false);
        if (result.ok) {
          hasData.current = true;
          setLoad({ kind: "ready", items: result.data, pagination: result.pagination ?? null });
        } else {
          hasData.current = false;
          setLoad({ kind: "error", error: result });
        }
      },
    });
  }

  // The lectures: the current list stays visible while a newer page loads.
  useEffect(() => {
    if (!SHOW_ATTENDANCE_REGISTERS) return;
    if (hasData.current) setRefreshing(true);
    else setLoad({ kind: "loading" });
    void loaderRef.current?.load(tab, applied, page);
  }, [tab, applied, page, attempt]);

  // Unmount: nothing in flight may update the page afterwards.
  useEffect(() => {
    const loader = loaderRef.current;
    return () => loader?.dispose();
  }, []);

  // Class options (the existing classes API, as the lecture page loads them); a failure only disables the filter.
  useEffect(() => {
    const controller = new AbortController();
    void attendanceRequest<{ id: string; name: string }[]>("/api/classes?page=1&pageSize=50", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setClassOptions(result.ok && Array.isArray(result.data) ? result.data.map((c) => ({ id: c.id, name: c.name })) : null);
      setClassesLoaded(true);
    });
    return () => controller.abort();
  }, []);

  const changeTab = useCallback((next: OverviewTab) => {
    setTab(next);
    setPage(1);
  }, []);
  const apply = useCallback(() => {
    setApplied({ ...draft, title: draft.title.trim() });
    setPage(1);
  }, [draft]);
  const clear = useCallback(() => {
    setDraft(EMPTY_OVERVIEW_FILTERS);
    setApplied(EMPTY_OVERVIEW_FILTERS);
    setPage(1);
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <OverviewView
      tab={tab}
      onTabChange={changeTab}
      draft={draft}
      onDraftChange={setDraft}
      applied={applied}
      onApply={apply}
      onClear={clear}
      classOptions={classOptions}
      load={load}
      refreshing={refreshing}
      page={page}
      onPageChange={setPage}
      onRetry={retry}
      takeAttendance={<AttendanceTakeSection classOptions={classOptions} classesLoaded={classesLoaded} initialMonth={initialMonth} />}
      showRegisters={SHOW_ATTENDANCE_REGISTERS}
    />
  );
}
