"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock, CalendarDays, MapPin, Plus } from "lucide-react";

import { useTeacherLiveRefetch } from "@/components/dashboard/use-teacher-live-events";

type CalendarEntry = {
  key: string;
  date: string; // YYYY-MM-DD
  startTime: string | null;
  endTime: string | null;
  kind: "schedule" | "event";
  classId: string | null;
  className: string;
  scheduled: boolean;
  lecture: { id: string; title: string; status: string } | null;
  eventId: number | null;
  eventTypeName: string | null;
  color: string | null;
  description: string | null;
  isAllDay: boolean;
  location: string | null;
  meetingUrl: string | null;
};

type RangeKey =
  | "today"
  | "tomorrow"
  | "yesterday"
  | "thisWeek"
  | "nextWeek"
  | "lastWeek"
  | "next30"
  | "last30"
  | "nextMonth"
  | "lastMonth";

const RANGES: { key: RangeKey; label: string; title: string }[] = [
  { key: "today", label: "Today", title: "Today's" },
  { key: "tomorrow", label: "Tomorrow", title: "Tomorrow's" },
  { key: "yesterday", label: "Yesterday", title: "Yesterday's" },
  { key: "thisWeek", label: "This week", title: "This week's" },
  { key: "nextWeek", label: "Next week", title: "Next week's" },
  { key: "lastWeek", label: "Last week", title: "Last week's" },
  { key: "next30", label: "Next 30 days", title: "Next 30 days'" },
  { key: "last30", label: "Last 30 days", title: "Last 30 days'" },
  { key: "nextMonth", label: "Next month", title: "Next month's" },
  { key: "lastMonth", label: "Last month", title: "Last month's" },
];

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function rangeToDates(range: RangeKey): { from: string; to: string } {
  const now = new Date();
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const y = now.getFullYear();
  const m = now.getMonth();

  const addDays = (base: Date, n: number) => {
    const c = new Date(base);
    c.setDate(c.getDate() + n);
    return c;
  };

  switch (range) {
    case "today":
      return { from: fmt(d0), to: fmt(d0) };
    case "tomorrow":
      return { from: fmt(addDays(d0, 1)), to: fmt(addDays(d0, 1)) };
    case "yesterday":
      return { from: fmt(addDays(d0, -1)), to: fmt(addDays(d0, -1)) };
    case "thisWeek": {
      const sun = addDays(d0, -d0.getDay());
      return { from: fmt(sun), to: fmt(addDays(sun, 6)) };
    }
    case "nextWeek": {
      const sun = addDays(d0, -d0.getDay() + 7);
      return { from: fmt(sun), to: fmt(addDays(sun, 6)) };
    }
    case "lastWeek": {
      const sun = addDays(d0, -d0.getDay() - 7);
      return { from: fmt(sun), to: fmt(addDays(sun, 6)) };
    }
    case "next30":
      return { from: fmt(d0), to: fmt(addDays(d0, 29)) };
    case "last30":
      return { from: fmt(addDays(d0, -29)), to: fmt(d0) };
    case "nextMonth":
      return { from: fmt(new Date(y, m + 1, 1)), to: fmt(new Date(y, m + 2, 0)) };
    case "lastMonth":
      return { from: fmt(new Date(y, m - 1, 1)), to: fmt(new Date(y, m, 0)) };
  }
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function timeRange(start: string | null, end: string | null, allDay: boolean): string {
  if (allDay) return "All day";
  if (start && end) return `${start} – ${end}`;
  if (start) return start;
  return "";
}

export function DashboardScheduleEvents() {
  const [range, setRange] = useState<RangeKey>("today");
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveTick, setLiveTick] = useState(0);

  const { from, to } = useMemo(() => rangeToDates(range), [range]);
  const titleWord = RANGES.find((r) => r.key === range)?.title ?? "";
  const multiDay = from !== to;

  // Realtime: re-pull the current range when a lecture/schedule/event changes.
  useTeacherLiveRefetch(() => setLiveTick((n) => n + 1));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/calendar?from=${from}&to=${to}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        const body = (await res.json()) as {
          success: boolean;
          data?: CalendarEntry[];
          error?: { message?: string };
        };
        if (!res.ok || !body.success || !body.data) {
          throw new Error(body.error?.message ?? "Failed to load.");
        }
        setEntries(body.data);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load.");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [from, to, liveTick]);

  const schedules = useMemo(
    () =>
      (entries ?? [])
        .filter((e) => e.kind === "schedule")
        .sort((a, b) =>
          a.date === b.date
            ? (a.startTime ?? "").localeCompare(b.startTime ?? "")
            : a.date.localeCompare(b.date)
        ),
    [entries]
  );

  const events = useMemo(() => {
    const seen = new Set<number>();
    return (entries ?? [])
      .filter((e) => e.kind === "event")
      .filter((e) => {
        if (e.eventId == null) return true;
        if (seen.has(e.eventId)) return false;
        seen.add(e.eventId);
        return true;
      })
      .sort((a, b) =>
        a.date === b.date
          ? (a.startTime ?? "").localeCompare(b.startTime ?? "")
          : a.date.localeCompare(b.date)
      );
  }, [entries]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1 self-start rounded-xl border border-brand-100 bg-white p-1 shadow-card">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
              range === r.key
                ? "bg-brand-700 text-white shadow-soft"
                : "text-brand-700 hover:bg-brand-50"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Schedule */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-sky-50 to-white px-5 py-4">
            <h2 className="font-bold text-foreground">{titleWord} Schedule</h2>
            <CalendarDays size={18} className="text-sky-500" />
          </div>
          <div className="p-5">
            {error ? (
              <p className="rounded-xl border border-dashed border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-600">
                Couldn&apos;t load the schedule.
              </p>
            ) : loading ? (
              <div className="space-y-2.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-xl bg-brand-50" />
                ))}
              </div>
            ) : schedules.length === 0 ? (
              <p className="rounded-xl border border-dashed border-sky-200 bg-sky-50 px-4 py-4 text-sm text-muted">
                No class schedules in this range.
              </p>
            ) : (
              <div className="space-y-2.5">
                {schedules.map((s) => {
                  const needsLecture = s.scheduled && !s.lecture;
                  return (
                    <div
                      key={s.key}
                      className={`flex flex-col gap-2 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 ${
                        needsLecture
                          ? "border-amber-200 bg-amber-50/60"
                          : "border-brand-100 bg-brand-50/50"
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-foreground sm:truncate">
                          {s.className}
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          {multiDay && <span>{dayLabel(s.date)} · </span>}
                          {timeRange(s.startTime, s.endTime, false) || "—"}
                        </p>
                        {s.lecture ? (
                          <p className="mt-0.5 break-words text-xs font-medium text-brand-700 sm:truncate">
                            {s.lecture.title}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-xs font-medium text-amber-700">
                            Lecture not added
                          </p>
                        )}
                      </div>
                      {needsLecture ? (
                        <Link
                          href={`/dashboard/lectures${
                            s.classId ? `?classId=${s.classId}` : ""
                          }`}
                          className="inline-flex items-center gap-1 self-start rounded-lg bg-amber-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-amber-700 sm:flex-shrink-0"
                        >
                          <Plus size={12} /> Add
                        </Link>
                      ) : (
                        <span className="self-start rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-bold text-sky-700 sm:flex-shrink-0 sm:self-auto">
                          {s.scheduled ? "Scheduled" : "Lecture"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </article>

        {/* Events */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-violet-50 to-white px-5 py-4">
            <h2 className="font-bold text-foreground">{titleWord} Events</h2>
            <CalendarClock size={18} className="text-violet-500" />
          </div>
          <div className="p-5">
            {error ? (
              <p className="rounded-xl border border-dashed border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-600">
                Couldn&apos;t load events.
              </p>
            ) : loading ? (
              <div className="space-y-2.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-xl bg-brand-50" />
                ))}
              </div>
            ) : events.length === 0 ? (
              <p className="rounded-xl border border-dashed border-violet-200 bg-violet-50 px-4 py-4 text-sm text-muted">
                No events in this range.
              </p>
            ) : (
              <div className="space-y-2.5">
                {events.map((e) => (
                  <Link
                    key={e.key}
                    href="/dashboard/calendar"
                    className="flex items-start justify-between gap-3 rounded-xl border border-brand-100 bg-brand-50/50 px-4 py-3 transition hover:border-brand-300 hover:bg-brand-50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-start gap-1.5">
                        <span
                          className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: e.color ?? "#94a3b8" }}
                        />
                        <p className="break-words text-sm font-semibold text-foreground sm:truncate">
                          {e.className}
                        </p>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        {multiDay && <span>{dayLabel(e.date)} · </span>}
                        {e.eventTypeName ?? "Event"}
                        {timeRange(e.startTime, e.endTime, e.isAllDay)
                          ? ` · ${timeRange(e.startTime, e.endTime, e.isAllDay)}`
                          : ""}
                      </p>
                      {e.location && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                          <MapPin size={11} /> {e.location}
                        </p>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
