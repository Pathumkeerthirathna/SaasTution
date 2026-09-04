"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CalendarCheck,
  CalendarClock,
  Clock,
  LogIn,
  LogOut,
  BookOpenText,
  CheckCircle2,
} from "lucide-react";

import type { PaginationMeta } from "@/lib/api-types";
import { dashRangeToYmd, isDashRange, type DashRange } from "@/lib/dashboard-range";
import { useStudentLiveRefetch } from "@/components/student-portal/use-student-live-events";

type ClassOption = { id: string; name: string };

type AttendanceRecord = {
  id: string;
  classId: string;
  sessionId: string;
  className: string;
  lectureTitle: string | null;
  sessionStartedAt: string;
  sessionEndedAt: string | null;
  joinedAt: string;
  leftAt: string | null;
};

type AttendEntry = { id: string; joinedAt: string; leftAt: string | null };

type SessionGroup = {
  sessionId: string;
  className: string;
  lectureTitle: string | null;
  sessionStartedAt: string;
  sessionEndedAt: string | null;
  entries: AttendEntry[];
};

const PAGE_SIZE = 10;

const PERIODS: { value: DashRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
];

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtTime(value: string) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function sameDay(a: string, b: string) {
  const d1 = new Date(a);
  const d2 = new Date(b);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

/** `start – end` where end is time-only when it falls on the same day. */
function fmtSpan(start: string, end: string | null, ongoingLabel: string) {
  if (!end) return `${fmtDateTime(start)} · ${ongoingLabel}`;
  return `${fmtDateTime(start)} – ${sameDay(start, end) ? fmtTime(end) : fmtDateTime(end)}`;
}

function durationMs(fromValue: string, toValue: string | null): number {
  if (!toValue) return 0;
  return Math.max(0, new Date(toValue).getTime() - new Date(fromValue).getTime());
}

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Collapse attendance rows sharing a session into one group, oldest session first-in wins order. */
function groupBySession(records: AttendanceRecord[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const r of records) {
    const existing = map.get(r.sessionId);
    if (existing) {
      existing.entries.push({ id: r.id, joinedAt: r.joinedAt, leftAt: r.leftAt });
      if (!existing.sessionEndedAt && r.sessionEndedAt) existing.sessionEndedAt = r.sessionEndedAt;
    } else {
      map.set(r.sessionId, {
        sessionId: r.sessionId,
        className: r.className,
        lectureTitle: r.lectureTitle,
        sessionStartedAt: r.sessionStartedAt,
        sessionEndedAt: r.sessionEndedAt,
        entries: [{ id: r.id, joinedAt: r.joinedAt, leftAt: r.leftAt }],
      });
    }
  }
  for (const g of map.values()) {
    g.entries.sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());
  }
  return [...map.values()];
}

export default function StudentAttendancePage() {
  return (
    <Suspense fallback={null}>
      <StudentAttendancePageInner />
    </Suspense>
  );
}

function StudentAttendancePageInner() {
  const searchParams = useSearchParams();

  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState(() => searchParams.get("classId") ?? "");
  const [period, setPeriod] = useState<DashRange>(() => {
    const r = searchParams.get("range");
    return isDashRange(r) ? r : "all";
  });
  const [page, setPage] = useState(1);
  const [liveTick, setLiveTick] = useState(0);

  const range = useMemo(() => dashRangeToYmd(period), [period]);

  // Realtime: refresh attendance history when a session join/leave is signalled.
  useStudentLiveRefetch(() => setLiveTick((n) => n + 1));

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (classId) params.set("classId", classId);
        if (range.from) params.set("from", range.from);
        if (range.to) params.set("to", range.to);
        params.set("page", String(page));
        params.set("pageSize", String(PAGE_SIZE));

        const res = await fetch(`/api/students/me/attendance?${params.toString()}`);
        const json = (await res.json()) as {
          success: boolean;
          data?: { records: AttendanceRecord[]; classes: ClassOption[] };
          pagination?: PaginationMeta;
          error?: { message: string };
        };

        if (!cancelled) {
          if (json.success && json.data) {
            setRecords(json.data.records);
            setClasses(json.data.classes);
            setPagination(json.pagination ?? null);
          } else {
            setError(json.error?.message ?? "Failed to load attendance.");
          }
        }
      } catch {
        if (!cancelled) setError("Failed to load attendance.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [classId, range.from, range.to, page, liveTick]);

  const hasFilter = Boolean(classId) || period !== "all";
  const groups = useMemo(() => groupBySession(records), [records]);

  return (
    <section className="overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-card">
      <header className="flex items-center gap-2.5 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-white px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <CalendarCheck size={16} />
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-slate-900">Attendance history</h1>
          <p className="text-xs text-slate-500">Every session you joined, across all your classes.</p>
        </div>
      </header>

      <div className="p-3">
        {/* Filters */}
        <div className="mb-3 flex flex-wrap items-end gap-2.5">
          <div>
            <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Class</label>
            <select
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
            >
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Period</label>
            <div className="flex flex-wrap gap-1">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => {
                    setPeriod(p.value);
                    setPage(1);
                  }}
                  className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                    period === p.value
                      ? "bg-emerald-600 text-white"
                      : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {hasFilter ? (
            <button
              type="button"
              onClick={() => {
                setClassId("");
                setPeriod("all");
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              Reset
            </button>
          ) : null}
        </div>

        {/* Body */}
        {isLoading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        ) : records.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-6 text-center text-xs text-slate-600">
            No attendance records found{hasFilter ? " for the selected filters" : " yet"}.
          </div>
        ) : (
          <>
            <p className="mb-2 text-[11px] font-medium text-slate-500">
              {groups.length} session{groups.length !== 1 ? "s" : ""} attended
            </p>
            <div className="space-y-2.5">
              {groups.map((group) => {
                const totalPresentMs = group.entries.reduce(
                  (sum, e) => sum + durationMs(e.joinedAt, e.leftAt),
                  0
                );
                const multi = group.entries.length > 1;

                return (
                  <article
                    key={group.sessionId}
                    className="rounded-lg border border-slate-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-slate-900">{group.className}</h3>
                        {group.lectureTitle ? (
                          <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                            <BookOpenText size={11} />
                            {group.lectureTitle}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-[11px] text-slate-400">Session</p>
                        )}
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                        <CheckCircle2 size={10} />
                        Attended
                      </span>
                    </div>

                    <div className="mt-2.5 rounded-md border border-slate-100 bg-slate-50/70 p-2">
                      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        <CalendarClock size={11} />
                        Session
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-700">
                        {fmtSpan(group.sessionStartedAt, group.sessionEndedAt, "ongoing")}
                      </p>
                    </div>

                    <div className="mt-1.5 rounded-md border border-slate-100 bg-slate-50/70 p-2">
                      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        <LogIn size={11} />
                        You attended{multi ? ` · ${group.entries.length} times` : ""}
                      </p>
                      <ul className="mt-1 space-y-1">
                        {group.entries.map((e) => (
                          <li
                            key={e.id}
                            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-700"
                          >
                            <span>{fmtSpan(e.joinedAt, e.leftAt, "no leave time recorded")}</span>
                            {e.leftAt ? (
                              <span className="text-slate-400">· {fmtMs(durationMs(e.joinedAt, e.leftAt))}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                        <Clock size={10} />
                        {multi ? "Total present" : "Present"} {fmtMs(totalPresentMs)}
                      </span>
                      {group.entries[group.entries.length - 1]?.leftAt ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                          <LogOut size={10} />
                          Last left {fmtTime(group.entries[group.entries.length - 1].leftAt as string)}
                        </span>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 ? (
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-200 pt-3">
            <p className="text-[11px] text-slate-500">
              Page {pagination.page} / {pagination.totalPages} · {pagination.totalItems} record
              {pagination.totalItems !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!pagination.hasPreviousPage || isLoading}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                ← Previous
              </button>
              <button
                type="button"
                disabled={!pagination.hasNextPage || isLoading}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
