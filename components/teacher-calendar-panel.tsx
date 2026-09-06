"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  GraduationCap,
  Pencil,
  Plus,
  Save,
  Settings2,
  Tag,
  Trash2,
  X,
} from "lucide-react";

type CalendarEvent = {
  key: string;
  date: string;
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

type EventType = {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  isActive: boolean;
  eventCount: number;
};

type CalendarView = "month" | "week" | "day";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_COLOR = "#3B82F6";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function ymd(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfWeek(date: Date) {
  const next = new Date(date);
  next.setDate(next.getDate() - next.getDay());
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function formatTimeRange(start: string | null, end: string | null) {
  if (!start) return "";
  return end ? `${start} – ${end}` : start;
}

function readApiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const typed = payload as { error?: { message?: string }; message?: string };
  return typed.error?.message ?? typed.message ?? fallback;
}

export function TeacherCalendarPanel() {
  const today = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  }, []);
  const todayKey = ymd(today);

  const [view, setView] = useState<CalendarView>("month");
  const [anchor, setAnchor] = useState<Date>(today);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null);
  const [isTypesOpen, setIsTypesOpen] = useState(false);

  const { days, fetchFrom, fetchTo, title } = useMemo(() => {
    if (view === "day") {
      return {
        days: [new Date(anchor)],
        fetchFrom: ymd(anchor),
        fetchTo: ymd(anchor),
        title: anchor.toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
      };
    }

    if (view === "week") {
      const start = startOfWeek(anchor);
      const list = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      return {
        days: list,
        fetchFrom: ymd(list[0]),
        fetchTo: ymd(list[6]),
        title: `${list[0].toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
        })} – ${list[6].toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })}`,
      };
    }

    const first = startOfMonth(anchor);
    const last = endOfMonth(anchor);
    const gridStart = startOfWeek(first);
    const gridEnd = addDays(startOfWeek(last), 6);
    const count =
      Math.round((gridEnd.getTime() - gridStart.getTime()) / 86400000) + 1;
    const list = Array.from({ length: count }, (_, i) => addDays(gridStart, i));
    return {
      days: list,
      fetchFrom: ymd(gridStart),
      fetchTo: ymd(gridEnd),
      title: anchor.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      }),
    };
  }, [view, anchor]);

  const loadEvents = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch(
        `/api/calendar?from=${fetchFrom}&to=${fetchTo}`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as {
        success: boolean;
        data?: CalendarEvent[];
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load calendar."));
      }

      setEvents(payload.data ?? []);
    } catch (error) {
      setEvents([]);
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to load calendar."
      );
    } finally {
      setIsLoading(false);
    }
  }, [fetchFrom, fetchTo]);

  const loadEventTypes = useCallback(async () => {
    try {
      const response = await fetch("/api/teacher/event-types", {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: EventType[];
      };
      if (payload.success) setEventTypes(payload.data ?? []);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    void loadEventTypes();
  }, [loadEventTypes]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const list = map.get(event.date) ?? [];
      list.push(event);
      map.set(event.date, list);
    }
    return map;
  }, [events]);

  function shift(direction: -1 | 1) {
    setAnchor((current) => {
      const next = new Date(current);
      if (view === "day") next.setDate(next.getDate() + direction);
      else if (view === "week") next.setDate(next.getDate() + direction * 7);
      else next.setMonth(next.getMonth() + direction);
      next.setHours(0, 0, 0, 0);
      return next;
    });
  }

  function openNewEvent(dayKey: string) {
    setEventDraft({
      id: null,
      eventTypeId: eventTypes.find((t) => t.isActive)?.id ?? eventTypes[0]?.id ?? 0,
      title: "",
      description: "",
      start: `${dayKey}T09:00`,
      end: `${dayKey}T10:00`,
      isAllDay: false,
      location: "",
      meetingUrl: "",
    });
  }

  function openEditEvent(event: CalendarEvent) {
    if (event.kind !== "event" || event.eventId == null) return;
    // Rebuild draft from what we have (times may be day-clamped for multi-day;
    // this is a lightweight edit of type/title/description/all-day).
    setEventDraft({
      id: event.eventId,
      eventTypeId:
        eventTypes.find((t) => t.name === event.eventTypeName)?.id ??
        eventTypes[0]?.id ??
        0,
      title: event.className,
      description: event.description ?? "",
      start: `${event.date}T${event.startTime ?? "09:00"}`,
      end: `${event.date}T${event.endTime ?? event.startTime ?? "10:00"}`,
      isAllDay: event.isAllDay,
      location: event.location ?? "",
      meetingUrl: event.meetingUrl ?? "",
    });
  }

  async function afterMutation() {
    setEventDraft(null);
    await loadEvents();
    await loadEventTypes();
  }

  return (
    <section className="space-y-4">
      <article className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        {/* Header */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
              <CalendarDays size={18} />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">
                Schedule Calendar
              </h2>
              <p className="text-xs text-slate-500">
                Class schedules, lectures and your own events.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 p-0.5">
              {(["month", "week", "day"] as CalendarView[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setView(option)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${
                    view === option
                      ? "bg-brand-700 text-white"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>

            <input
              type="date"
              value={ymd(anchor)}
              onChange={(event) => {
                if (!event.target.value) return;
                const next = new Date(`${event.target.value}T00:00:00`);
                if (!Number.isNaN(next.getTime())) setAnchor(next);
              }}
              className="h-8 rounded-lg border border-slate-200 px-2 text-xs text-slate-700 outline-none focus:border-brand-500"
            />

            <button
              type="button"
              onClick={() => setIsTypesOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              <Settings2 size={13} />
              Event types
            </button>

            <button
              type="button"
              onClick={() => openNewEvent(ymd(anchor))}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-700 px-2.5 text-xs font-semibold text-white transition hover:bg-brand-600"
            >
              <Plus size={13} />
              New event
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => shift(-1)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              onClick={() => shift(1)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50"
            >
              <ChevronRight size={15} />
            </button>
            <button
              type="button"
              onClick={() => setAnchor(today)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              Today
            </button>
          </div>

          <p className="text-sm font-semibold text-slate-900">{title}</p>

          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> Lecture added
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-amber-400" /> Not added
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-slate-400" /> Event
            </span>
          </div>
        </div>

        {errorMessage ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {errorMessage}
          </p>
        ) : null}

        {isLoading ? (
          <p className="py-6 text-center text-sm text-slate-400">
            Loading calendar...
          </p>
        ) : view === "month" ? (
          <MonthGrid
            days={days}
            anchorMonth={anchor.getMonth()}
            todayKey={todayKey}
            eventsByDay={eventsByDay}
            onAdd={openNewEvent}
            onOpenEvent={openEditEvent}
            onPickDay={(day) => {
              setAnchor(day);
              setView("day");
            }}
          />
        ) : view === "week" ? (
          <WeekView
            days={days}
            todayKey={todayKey}
            eventsByDay={eventsByDay}
            onAdd={openNewEvent}
            onOpenEvent={openEditEvent}
          />
        ) : (
          <DayView
            day={days[0]}
            events={eventsByDay.get(ymd(days[0])) ?? []}
            onAdd={openNewEvent}
            onOpenEvent={openEditEvent}
          />
        )}
      </article>

      {eventDraft ? (
        <EventDrawer
          draft={eventDraft}
          eventTypes={eventTypes}
          onClose={() => setEventDraft(null)}
          onSaved={afterMutation}
          onManageTypes={() => setIsTypesOpen(true)}
        />
      ) : null}

      {isTypesOpen ? (
        <TypesManager
          eventTypes={eventTypes}
          onClose={() => setIsTypesOpen(false)}
          onChanged={async () => {
            await loadEventTypes();
            await loadEvents();
          }}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function EventHoverPopover({
  event,
  children,
}: {
  event: CalendarEvent;
  children: React.ReactNode;
}) {
  const [pop, setPop] = useState<{
    top: number;
    left: number;
    above: boolean;
  } | null>(null);

  if (event.kind !== "event") return <>{children}</>;

  const color = event.color ?? DEFAULT_COLOR;
  const timeLabel = event.isAllDay
    ? "All day"
    : event.startTime
    ? formatTimeRange(event.startTime, event.endTime)
    : "—";

  return (
    <span
      className="relative block"
      onMouseEnter={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const above = window.innerHeight - rect.bottom < 210;
        setPop({
          top: above ? rect.top - 8 : rect.bottom + 8,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)),
          above,
        });
      }}
      onMouseLeave={() => setPop(null)}
    >
      {children}

      {pop ? (
        <div
          className="pointer-events-none fixed z-[70] w-64 rounded-lg border border-slate-200 bg-white p-3 text-left shadow-xl"
          style={{
            top: pop.top,
            left: pop.left,
            transform: pop.above ? "translateY(-100%)" : undefined,
          }}
        >
          <div className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <p className="truncate text-xs font-bold text-slate-900">
              {event.className}
            </p>
          </div>

          <p className="mt-1 text-[11px] font-semibold" style={{ color }}>
            {event.eventTypeName}
          </p>

          <p className="mt-0.5 text-[11px] text-slate-600">
            {new Date(`${event.date}T00:00:00`).toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
            })}{" "}
            · {timeLabel}
          </p>

          {event.description ? (
            <p className="mt-1.5 whitespace-pre-line text-[11px] leading-4 text-slate-700">
              {event.description}
            </p>
          ) : null}

          {event.location ? (
            <p className="mt-1 text-[11px] text-slate-500">📍 {event.location}</p>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

function EntryChip({
  event,
  clamp = true,
}: {
  event: CalendarEvent;
  /** Single-line + ellipsis (tight desktop grid cell) vs full wrapped text (mobile list row). */
  clamp?: boolean;
}) {
  const clampCls = clamp ? "truncate" : "break-words";

  if (event.kind === "event") {
    return (
      <EventHoverPopover event={event}>
        <div
          className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${clampCls}`}
          style={{
            borderColor: `${event.color ?? DEFAULT_COLOR}66`,
            background: `${event.color ?? DEFAULT_COLOR}14`,
            color: event.color ?? DEFAULT_COLOR,
          }}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: event.color ?? DEFAULT_COLOR }}
          />
          {event.startTime ? (
            <span className="font-semibold">{event.startTime} </span>
          ) : null}
          {event.className}
        </div>
      </EventHoverPopover>
    );
  }

  const tone = !event.scheduled
    ? "border-sky-200 bg-sky-50 text-sky-700"
    : event.lecture
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-amber-300 border-dashed bg-amber-50 text-amber-700";

  return (
    <div className={`rounded border px-1.5 py-0.5 text-[10px] ${clampCls} ${tone}`}>
      {event.startTime ? (
        <span className="font-semibold">{event.startTime} </span>
      ) : null}
      {event.className}
    </div>
  );
}

function MonthGrid({
  days,
  anchorMonth,
  todayKey,
  eventsByDay,
  onAdd,
  onPickDay,
  onOpenEvent,
}: {
  days: Date[];
  anchorMonth: number;
  todayKey: string;
  eventsByDay: Map<string, CalendarEvent[]>;
  onAdd: (dayKey: string) => void;
  onPickDay: (day: Date) => void;
  onOpenEvent: (event: CalendarEvent) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      {/* Weekday header — only meaningful once the grid layout is in play (sm+) */}
      <div className="hidden grid-cols-7 bg-slate-50 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500 sm:grid">
        {WEEKDAYS.map((label) => (
          <div key={label} className="py-1.5">
            {label}
          </div>
        ))}
      </div>

      {/*
       * Below `sm` there's no room for a 7-column grid without either scrolling
       * horizontally or clipping every event, so each day renders as a full-width
       * row with every event listed in full instead. At `sm` and up this becomes
       * the original 7-column month grid, unchanged.
       */}
      <div className="grid grid-cols-1 sm:grid-cols-7">
        {days.map((day) => {
          const key = ymd(day);
          const dayEvents = eventsByDay.get(key) ?? [];
          const inMonth = day.getMonth() === anchorMonth;
          const isToday = key === todayKey;

          return (
            <div
              key={key}
              className={`group relative border-b border-slate-100 p-2 sm:min-h-[96px] sm:border-r sm:p-1 ${
                inMonth ? "bg-white" : "bg-slate-50/60"
              }`}
            >
              {/* Mobile row header: weekday + full date, shown only below sm */}
              <div className="flex items-center justify-between sm:hidden">
                <button
                  type="button"
                  onClick={() => onPickDay(day)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold ${
                    isToday
                      ? "bg-brand-700 text-white"
                      : inMonth
                      ? "text-slate-700 hover:bg-slate-100"
                      : "text-slate-400"
                  }`}
                >
                  <span>
                    {day.toLocaleDateString(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                  {!inMonth ? (
                    <span className="text-[10px] font-normal text-slate-400">
                      (adjacent month)
                    </span>
                  ) : null}
                </button>

                <button
                  type="button"
                  onClick={() => onAdd(key)}
                  title="Add event"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-white hover:bg-brand-700"
                >
                  <Plus size={12} />
                </button>
              </div>

              {/* Desktop day-number row, shown only sm and up */}
              <div className="hidden items-center justify-between sm:flex">
                <button
                  type="button"
                  onClick={() => onPickDay(day)}
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                    isToday
                      ? "bg-brand-700 text-white"
                      : inMonth
                      ? "text-slate-700 hover:bg-slate-100"
                      : "text-slate-400"
                  }`}
                >
                  {day.getDate()}
                </button>

                <button
                  type="button"
                  onClick={() => onAdd(key)}
                  title="Add event"
                  className="hidden h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white transition group-hover:flex hover:bg-brand-700"
                >
                  <Plus size={11} />
                </button>
              </div>

              {/* Mobile: every event listed in full, nothing clipped or hidden behind "+N more" */}
              <div className="mt-1.5 space-y-1 sm:hidden">
                {dayEvents.length === 0 ? (
                  <p className="text-[11px] text-slate-300">No events</p>
                ) : (
                  dayEvents.map((event) =>
                    event.kind === "schedule" && event.lecture ? (
                      <Link
                        key={event.key}
                        href={`/dashboard/lectures?focusLectureId=${event.lecture.id}`}
                        className="block w-full text-left"
                      >
                        <EntryChip event={event} clamp={false} />
                      </Link>
                    ) : (
                      <button
                        key={event.key}
                        type="button"
                        onClick={() =>
                          event.kind === "event"
                            ? onOpenEvent(event)
                            : onPickDay(day)
                        }
                        className="block w-full text-left"
                      >
                        <EntryChip event={event} clamp={false} />
                      </button>
                    )
                  )
                )}
              </div>

              {/* Desktop: original compact chips, capped at 3 + "+N more" — unchanged */}
              <div className="mt-1 hidden space-y-0.5 sm:block">
                {dayEvents.slice(0, 3).map((event) => (
                  event.kind === "schedule" && event.lecture ? (
                    <Link
                      key={event.key}
                      href={`/dashboard/lectures?focusLectureId=${event.lecture.id}`}
                      className="block w-full text-left"
                    >
                      <EntryChip event={event} />
                    </Link>
                  ) : (
                    <button
                      key={event.key}
                      type="button"
                      onClick={() =>
                        event.kind === "event"
                          ? onOpenEvent(event)
                          : onPickDay(day)
                      }
                      className="block w-full text-left"
                    >
                      <EntryChip event={event} />
                    </button>
                  )
                ))}
                {dayEvents.length > 3 ? (
                  <button
                    type="button"
                    onClick={() => onPickDay(day)}
                    className="text-[9px] font-semibold text-slate-400 hover:text-slate-600"
                  >
                    +{dayEvents.length - 3} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({
  days,
  todayKey,
  eventsByDay,
  onAdd,
  onOpenEvent,
}: {
  days: Date[];
  todayKey: string;
  eventsByDay: Map<string, CalendarEvent[]>;
  onAdd: (dayKey: string) => void;
  onOpenEvent: (event: CalendarEvent) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
      {days.map((day) => {
        const key = ymd(day);
        const dayEvents = eventsByDay.get(key) ?? [];
        const isToday = key === todayKey;

        return (
          <div
            key={key}
            className={`group rounded-lg border p-2 ${
              isToday ? "border-brand-300 bg-brand-50/40" : "border-slate-200"
            }`}
          >
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold text-slate-500">
                {day.toLocaleDateString(undefined, {
                  weekday: "short",
                  day: "numeric",
                })}
              </p>
              <button
                type="button"
                onClick={() => onAdd(key)}
                className="hidden h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white group-hover:flex hover:bg-brand-700"
              >
                <Plus size={11} />
              </button>
            </div>

            <div className="mt-1.5 space-y-1.5">
              {dayEvents.length === 0 ? (
                <p className="text-[10px] text-slate-300">—</p>
              ) : (
                dayEvents.map((event) => (
                  <EntryCard
                    key={event.key}
                    event={event}
                    compact
                    onOpenEvent={onOpenEvent}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayView({
  day,
  events,
  onAdd,
  onOpenEvent,
}: {
  day: Date;
  events: CalendarEvent[];
  onAdd: (dayKey: string) => void;
  onOpenEvent: (event: CalendarEvent) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-500">
          {day.toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </p>
        <button
          type="button"
          onClick={() => onAdd(ymd(day))}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <Plus size={12} />
          Add event
        </button>
      </div>

      {events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 py-8 text-center text-sm text-slate-400">
          Nothing scheduled for this day.
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((event) => (
            <EntryCard
              key={event.key}
              event={event}
              onOpenEvent={onOpenEvent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EntryCard({
  event,
  compact,
  onOpenEvent,
}: {
  event: CalendarEvent;
  compact?: boolean;
  onOpenEvent: (event: CalendarEvent) => void;
}) {
  if (event.kind === "event") {
    const color = event.color ?? DEFAULT_COLOR;
    return (
      <EventHoverPopover event={event}>
        <button
          type="button"
          onClick={() => onOpenEvent(event)}
          className="block w-full rounded-lg border p-2 text-left transition hover:shadow-sm"
          style={{ borderColor: `${color}55`, background: `${color}0F` }}
        >
          <div className="flex items-start gap-1.5">
            <span
              className="mt-1 h-2 w-2 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <div className="min-w-0">
              <p
                className={`break-words font-semibold text-slate-900 ${
                  compact ? "text-[11px] sm:truncate" : "text-sm"
                }`}
              >
                {event.className}
              </p>
              <p className="text-[10px]" style={{ color }}>
                {event.eventTypeName}
                {event.isAllDay
                  ? " · All day"
                  : event.startTime
                  ? ` · ${formatTimeRange(event.startTime, event.endTime)}`
                  : ""}
              </p>
              {event.description ? (
                <p className="mt-0.5 line-clamp-2 text-[10px] text-slate-600">
                  {event.description}
                </p>
              ) : null}
              {event.location ? (
                <p className="text-[10px] text-slate-500">📍 {event.location}</p>
              ) : null}
            </div>
          </div>
        </button>
      </EventHoverPopover>
    );
  }

  const tone = !event.scheduled
    ? "border-sky-200 bg-sky-50"
    : event.lecture
    ? "border-emerald-200 bg-emerald-50"
    : "border-amber-300 border-dashed bg-amber-50";

  return (
    <div className={`rounded-lg border p-2 ${tone}`}>
      <div className="flex items-start gap-1.5">
        <GraduationCap
          size={compact ? 11 : 13}
          className="mt-0.5 shrink-0 text-slate-500"
        />
        <div className="min-w-0">
          <p
            className={`break-words font-semibold text-slate-900 ${
              compact ? "text-[11px] sm:truncate" : "text-sm"
            }`}
          >
            {event.className}
          </p>
          {event.startTime ? (
            <p className="text-[10px] text-slate-500">
              {formatTimeRange(event.startTime, event.endTime)}
            </p>
          ) : null}

          {!event.scheduled && event.lecture ? (
            <Link
              href={`/dashboard/lectures?focusLectureId=${event.lecture.id}`}
              className={`mt-0.5 block break-words text-[10px] font-medium text-sky-700 underline decoration-dotted underline-offset-2 hover:text-sky-900 ${
                compact ? "sm:truncate" : ""
              }`}
            >
              Extra lecture: {event.lecture.title}
            </Link>
          ) : event.lecture ? (
            <Link
              href={`/dashboard/lectures?focusLectureId=${event.lecture.id}`}
              className={`mt-0.5 block break-words text-[10px] font-medium text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-900 ${
                compact ? "sm:truncate" : ""
              }`}
            >
              Lecture: {event.lecture.title}
            </Link>
          ) : (
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700">
                <CircleAlert size={10} />
                Lecture not added yet
              </span>
              <Link
                href={`/dashboard/lectures?addLecture=1&classId=${
                  event.classId
                }&date=${event.date}T${event.startTime ?? "09:00"}`}
                className="inline-flex items-center gap-0.5 rounded border border-amber-300 bg-white px-1 py-0.5 text-[10px] font-semibold text-amber-700 transition hover:bg-amber-100"
              >
                <Plus size={10} />
                Add
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

type EventDraft = {
  id: number | null;
  eventTypeId: number;
  title: string;
  description: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location: string;
  meetingUrl: string;
};

function EventDrawer({
  draft,
  eventTypes,
  onClose,
  onSaved,
  onManageTypes,
}: {
  draft: EventDraft;
  eventTypes: EventType[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onManageTypes: () => void;
}) {
  const [form, setForm] = useState<EventDraft>(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(draft), [draft]);

  const activeTypes = eventTypes.filter(
    (type) => type.isActive || type.id === form.eventTypeId
  );

  async function submit() {
    if (!form.title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!form.eventTypeId) {
      setError("Choose an event type.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload = {
        eventTypeId: form.eventTypeId,
        title: form.title.trim(),
        description: form.description.trim() || null,
        startDateTime: new Date(form.start).toISOString(),
        endDateTime: new Date(
          form.isAllDay && !form.end ? form.start : form.end || form.start
        ).toISOString(),
        isAllDay: form.isAllDay,
        location: form.location.trim() || null,
        meetingUrl: form.meetingUrl.trim() || null,
      };

      const response = await fetch(
        form.id
          ? `/api/teacher/calendar-events/${form.id}`
          : "/api/teacher/calendar-events",
        {
          method: form.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const body = (await response.json()) as { success: boolean };

      if (!response.ok || body.success === false) {
        throw new Error(readApiError(body, "Failed to save event."));
      }

      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save event.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!form.id || !confirm("Delete this event?")) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/teacher/calendar-events/${form.id}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as { success: boolean };
      if (!response.ok || body.success === false) {
        throw new Error(readApiError(body, "Failed to delete event."));
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete event.");
      setSaving(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-900">
            {form.id ? "Edit event" : "New event"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {error ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </p>
          ) : null}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-600">
                Event type
              </label>
              <button
                type="button"
                onClick={onManageTypes}
                className="text-[11px] font-semibold text-brand-700 hover:underline"
              >
                Manage types
              </button>
            </div>
            <select
              value={form.eventTypeId || ""}
              onChange={(e) =>
                setForm((f) => ({ ...f, eventTypeId: Number(e.target.value) }))
              }
              className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-brand-500"
            >
              <option value="">Select type</option>
              {activeTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </div>

          <Field label="Title">
            <input
              value={form.title}
              onChange={(e) =>
                setForm((f) => ({ ...f, title: e.target.value }))
              }
              placeholder="Event title"
              className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-brand-500"
            />
          </Field>

          <Field label="Description (optional)">
            <textarea
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
              rows={3}
              placeholder="Details..."
              className="w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
            />
          </Field>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={form.isAllDay}
              onChange={(e) =>
                setForm((f) => ({ ...f, isAllDay: e.target.checked }))
              }
            />
            All day
          </label>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Start">
              <input
                type={form.isAllDay ? "date" : "datetime-local"}
                value={form.isAllDay ? form.start.slice(0, 10) : form.start}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    start: form.isAllDay
                      ? `${e.target.value}T00:00`
                      : e.target.value,
                  }))
                }
                className="h-9 w-full rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-brand-500"
              />
            </Field>
            <Field label="End">
              <input
                type={form.isAllDay ? "date" : "datetime-local"}
                value={form.isAllDay ? form.end.slice(0, 10) : form.end}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    end: form.isAllDay
                      ? `${e.target.value}T23:59`
                      : e.target.value,
                  }))
                }
                className="h-9 w-full rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-brand-500"
              />
            </Field>
          </div>

          <Field label="Location (optional)">
            <input
              value={form.location}
              onChange={(e) =>
                setForm((f) => ({ ...f, location: e.target.value }))
              }
              className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-brand-500"
            />
          </Field>

          <Field label="Meeting URL (optional)">
            <input
              value={form.meetingUrl}
              onChange={(e) =>
                setForm((f) => ({ ...f, meetingUrl: e.target.value }))
              }
              className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-brand-500"
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          {form.id ? (
            <button
              type="button"
              onClick={remove}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-60"
            >
              <Trash2 size={13} />
              Delete
            </button>
          ) : (
            <span />
          )}

          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-60"
          >
            <Save size={13} />
            {saving ? "Saving..." : form.id ? "Update" : "Add event"}
          </button>
        </div>
      </aside>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-slate-600">
        {label}
      </label>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TypesManager({
  eventTypes,
  onClose,
  onChanged,
}: {
  eventTypes: EventType[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<{
    id: number | null;
    name: string;
    description: string;
    color: string;
  }>({ id: null, name: "", description: "", color: DEFAULT_COLOR });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!draft.name.trim()) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        draft.id
          ? `/api/teacher/event-types/${draft.id}`
          : "/api/teacher/event-types",
        {
          method: draft.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: draft.name.trim(),
            description: draft.description.trim() || null,
            color: draft.color || null,
          }),
        }
      );
      const body = (await response.json()) as { success: boolean };
      if (!response.ok || body.success === false) {
        throw new Error(readApiError(body, "Failed to save event type."));
      }
      setDraft({ id: null, name: "", description: "", color: DEFAULT_COLOR });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save event type.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Remove this event type?")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/teacher/event-types/${id}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as { success: boolean };
      if (!response.ok || body.success === false) {
        throw new Error(readApiError(body, "Failed to remove event type."));
      }
      await onChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to remove event type."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-[61] flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Tag size={15} />
            Event types
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-5">
          {error ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </p>
          ) : null}

          {eventTypes.map((type) => (
            <div
              key={type.id}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                type.isActive ? "border-slate-200" : "border-slate-200 opacity-60"
              }`}
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: type.color ?? DEFAULT_COLOR }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-900">
                  {type.name}
                  {!type.isActive ? (
                    <span className="ml-1 text-[10px] font-medium text-slate-400">
                      (hidden)
                    </span>
                  ) : null}
                </p>
                {type.description ? (
                  <p className="break-words text-[10px] text-slate-500">
                    {type.description}
                  </p>
                ) : null}
              </div>
              <span className="text-[10px] text-slate-400">
                {type.eventCount}
              </span>
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    id: type.id,
                    name: type.name,
                    description: type.description ?? "",
                    color: type.color ?? DEFAULT_COLOR,
                  })
                }
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                onClick={() => void remove(type.id)}
                className="rounded p-1 text-rose-400 hover:bg-rose-50 hover:text-rose-600"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        <div className="space-y-2 border-t border-slate-100 bg-slate-50 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {draft.id ? "Edit type" : "Add type"}
          </p>
          <div className="flex gap-2">
            <input
              value={draft.name}
              onChange={(e) =>
                setDraft((d) => ({ ...d, name: e.target.value }))
              }
              placeholder="Name"
              className="h-9 flex-1 rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-brand-500"
            />
            <input
              type="color"
              value={draft.color}
              onChange={(e) =>
                setDraft((d) => ({ ...d, color: e.target.value }))
              }
              className="h-9 w-10 rounded-lg border border-slate-200"
            />
          </div>
          <input
            value={draft.description}
            onChange={(e) =>
              setDraft((d) => ({ ...d, description: e.target.value }))
            }
            placeholder="Description (optional)"
            className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-brand-500"
          />
          <div className="flex justify-end gap-2">
            {draft.id ? (
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    id: null,
                    name: "",
                    description: "",
                    color: DEFAULT_COLOR,
                  })
                }
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100"
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-60"
            >
              <Save size={13} />
              {draft.id ? "Update" : "Add"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
