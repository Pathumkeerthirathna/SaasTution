"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, Plus } from "lucide-react";

export type DashboardCountdownItem = {
  id: string;
  kind: "LECTURE" | "SCHEDULE" | "EVENT";
  title: string;
  subtitle: string;
  startsAt: string; // ISO
  needsLecture: boolean;
  actionHref: string;
  actionLabel: string;
};

type Props = {
  items: DashboardCountdownItem[];
};

function formatRemaining(ms: number) {
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function DashboardCountdown({ items }: Props) {
  // Null until mounted so the server render and the first client render match
  // (a live "Starts in HH:MM:SS" ticker can never be SSR-stable).
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const upcoming = useMemo(
    () =>
      now === null
        ? []
        : items
            .map((item) => ({
              ...item,
              remainingMs: new Date(item.startsAt).getTime() - now,
            }))
            .filter((item) => item.remainingMs > -5 * 60 * 1000) // keep for 5 min after start
            .sort((a, b) => a.remainingMs - b.remainingMs),
    [items, now]
  );

  if (upcoming.length === 0) return null;

  const next = upcoming[0];
  const started = next.remainingMs <= 0;
  const warn = next.needsLecture;

  return (
    <section
      className={`flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between ${
        warn
          ? "border-amber-300 bg-amber-50"
          : "border-emerald-200 bg-emerald-50"
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
            warn ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
          }`}
        >
          {warn ? <AlertTriangle size={16} /> : <CalendarClock size={16} />}
        </span>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <p
              className={`text-sm font-semibold ${
                warn ? "text-amber-900" : "text-emerald-900"
              }`}
            >
              {started ? "Starting now" : `Starts in ${formatRemaining(next.remainingMs)}`}
            </p>
            <span className="text-[11px] uppercase tracking-wide text-slate-400">
              {next.kind === "EVENT"
                ? "Calendar event"
                : next.kind === "LECTURE"
                ? "Lecture"
                : "Class"}
            </span>
          </div>

          <p className="mt-0.5 break-words text-[13px] text-slate-700 sm:truncate">
            <span className="font-medium">{next.title}</span>
            {next.subtitle ? <span className="text-slate-500"> · {next.subtitle}</span> : null}
          </p>

          {warn && (
            <p className="mt-0.5 text-[12px] leading-4 text-amber-700">
              You have not added a lecture for this class yet.
            </p>
          )}

          {upcoming.length > 1 && (
            <p className="mt-0.5 text-[11px] text-slate-400">
              + {upcoming.length - 1} more in the next 8 hours
            </p>
          )}
        </div>
      </div>

      <Link
        href={next.actionHref}
        className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition ${
          warn
            ? "bg-amber-600 hover:bg-amber-700"
            : "bg-emerald-600 hover:bg-emerald-700"
        }`}
      >
        {warn && <Plus size={13} />}
        {next.actionLabel}
      </Link>
    </section>
  );
}
