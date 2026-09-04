"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  UserRound,
  BookOpenText,
  ArrowUpRight,
} from "lucide-react";

import { useStudentLiveRefetch } from "@/components/student-portal/use-student-live-events";

type CalendarEntry = {
  key: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  classId: string;
  className: string;
  teacherName: string;
  scheduled: boolean;
  lecture: { id: string; title: string; status: string } | null;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function formatTime12h(value: string | null) {
  if (!value) return "";
  const [hRaw, mRaw] = value.split(":");
  const hour = Number(hRaw);
  if (Number.isNaN(hour)) return value;
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${(mRaw ?? "00").padStart(2, "0")} ${suffix}`;
}

function timeRange(a: string | null, b: string | null) {
  if (a && b) return `${formatTime12h(a)} – ${formatTime12h(b)}`;
  if (a) return formatTime12h(a);
  return "Time not set";
}

export function StudentCalendarClient() {
  const router = useRouter();
  const today = useMemo(() => new Date(), []);
  const todayKey = ymd(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));

  const [view, setView] = useState(() => ({ year: today.getFullYear(), month: today.getMonth() }));
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string>(todayKey);

  // The visible 6-week grid, Sunday-first.
  const gridDays = useMemo(() => {
    const first = new Date(Date.UTC(view.year, view.month, 1));
    const start = new Date(first);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      return d;
    });
  }, [view]);

  const range = useMemo(
    () => ({ from: ymd(gridDays[0]), to: ymd(gridDays[41]) }),
    [gridDays]
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/student/calendar?from=${range.from}&to=${range.to}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: { entries: CalendarEntry[] };
        error?: { message?: string };
      };
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error?.message ?? "Failed to load calendar.");
      }
      setEntries(json.data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load calendar.");
    } finally {
      setIsLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: re-pull the visible month whenever a lecture/schedule change is signalled.
  useStudentLiveRefetch(() => void load());

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    return map;
  }, [entries]);

  const monthLabel = new Date(Date.UTC(view.year, view.month, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  function shiftMonth(delta: number) {
    setView((v) => {
      const d = new Date(Date.UTC(v.year, v.month + delta, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });
  }

  function goToday() {
    setView({ year: today.getFullYear(), month: today.getMonth() });
    setSelectedDay(todayKey);
  }

  function openLecture(entry: CalendarEntry) {
    if (!entry.lecture) return;
    router.push(`/student/lectures?classId=${entry.classId}&focus=${entry.lecture.id}`);
  }

  const selectedEntries = byDay.get(selectedDay) ?? [];
  const selectedLabel = new Date(`${selectedDay}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50"
            aria-label="Previous month"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50"
            aria-label="Next month"
          >
            <ChevronRight size={14} />
          </button>
          <h2 className="ml-1 text-sm font-bold text-slate-900">{monthLabel}</h2>
        </div>
        <div className="flex items-center gap-2">
          {isLoading ? <span className="text-[11px] text-slate-400">Loading…</span> : null}
          <button
            type="button"
            onClick={goToday}
            className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
          >
            Today
          </button>
        </div>
      </div>

      {error ? (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      ) : null}

      {/* Legend */}
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-emerald-500" /> Lecture added
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-amber-400" /> Lecture not added yet
        </span>
      </div>

      {/* Grid — scrolls horizontally on small screens so every day cell stays readable */}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <div className="min-w-[640px] sm:min-w-0">
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500">
          {WEEKDAYS.map((d) => (
            <div key={d} className="py-1.5">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {gridDays.map((day) => {
            const key = ymd(day);
            const inMonth = day.getUTCMonth() === view.month;
            const isToday = key === todayKey;
            const isSelected = key === selectedDay;
            const dayEntries = byDay.get(key) ?? [];

            return (
              <button
                type="button"
                key={key}
                onClick={() => setSelectedDay(key)}
                className={`flex min-h-[86px] flex-col gap-1 border-b border-r border-slate-100 p-1 text-left last:border-r-0 [&:nth-child(7n)]:border-r-0 ${
                  inMonth ? "bg-white" : "bg-slate-50/60"
                } ${isSelected ? "ring-2 ring-inset ring-emerald-400" : "hover:bg-emerald-50/40"}`}
              >
                <span
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                    isToday
                      ? "bg-emerald-600 text-white"
                      : inMonth
                        ? "text-slate-700"
                        : "text-slate-400"
                  }`}
                >
                  {day.getUTCDate()}
                </span>

                <div className="flex flex-col gap-0.5">
                  {dayEntries.slice(0, 3).map((e) => (
                    <span
                      key={e.key}
                      onClick={(ev) => {
                        if (e.lecture) {
                          ev.stopPropagation();
                          openLecture(e);
                        }
                      }}
                      className={`truncate rounded px-1 py-0.5 text-[10px] font-medium ${
                        e.lecture
                          ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                          : "bg-amber-100 text-amber-800"
                      }`}
                      title={`${e.className}${e.startTime ? ` · ${formatTime12h(e.startTime)}` : ""}`}
                    >
                      {e.startTime ? `${formatTime12h(e.startTime)} ` : ""}
                      {e.className}
                    </span>
                  ))}
                  {dayEntries.length > 3 ? (
                    <span className="px-1 text-[10px] font-semibold text-slate-400">
                      +{dayEntries.length - 3} more
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
        </div>
      </div>

      {/* Selected day detail */}
      <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center gap-1.5">
          <CalendarDays size={13} className="text-emerald-600" />
          <h3 className="text-xs font-bold text-slate-800">{selectedLabel}</h3>
        </div>

        {selectedEntries.length === 0 ? (
          <p className="text-xs text-slate-500">No classes scheduled on this day.</p>
        ) : (
          <div className="space-y-2">
            {selectedEntries.map((e) => (
              <div
                key={e.key}
                className={`rounded-lg border p-2.5 ${
                  e.lecture ? "border-emerald-200 bg-emerald-50/40" : "border-amber-200 bg-amber-50/40"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{e.className}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <UserRound size={11} />
                        {e.teacherName}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} />
                        {timeRange(e.startTime, e.endTime)}
                      </span>
                      {e.scheduled ? null : (
                        <span className="rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-500">
                          extra
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                {e.lecture ? (
                  <button
                    type="button"
                    onClick={() => openLecture(e)}
                    className="mt-2 inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50"
                  >
                    <BookOpenText size={11} />
                    {e.lecture.title}
                    <ArrowUpRight size={11} />
                  </button>
                ) : (
                  <p className="mt-2 inline-flex items-center gap-1 rounded-lg bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800">
                    Lecture not added yet
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
