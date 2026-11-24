"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Play, Video } from "lucide-react";

import { listFailureMessage } from "./player-errors";
import { formatLectureDateTime, listApiUrl, partLabel, playerHref, type RecordedLecture } from "./recording-helpers";
import { LockedResourceBadge } from "@/components/student-portal/locked-resource";

/*
 * Dashboard widget (RL-5.1): recordings of lectures that started within the
 * dashboard window (RECORDED_LECTURE_DASHBOARD_DAYS, scope=dashboard). One
 * request when the dashboard opens; the last loaded list is kept if a later
 * load fails. The full library is always reachable through "All recorded
 * lectures": the window only decides what this shortcut shows.
 */

const WIDGET_LIMIT = 6;

export function DashboardRecordedLectures() {
  const [items, setItems] = useState<RecordedLecture[]>([]);
  const [days, setDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(listApiUrl({ scope: "dashboard" }, null, WIDGET_LIMIT), { cache: "no-store" });
      if (!response.ok) {
        setError(listFailureMessage(response.status).message);
        return;
      }
      const json = (await response.json()) as { data?: { recordedLectures?: RecordedLecture[]; dashboardDays?: number } };
      setItems(json.data?.recordedLectures ?? []);
      setDays(typeof json.data?.dashboardDays === "number" ? json.data.dashboardDays : null);
      setError(null);
    } catch {
      setError("Could not load recorded lectures.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-gradient-to-r from-emerald-50 to-white px-4 py-3 sm:px-5">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-bold text-foreground">
          <Video size={14} className="text-emerald-600" aria-hidden />
          Watch recorded lectures
          {days ? <span className="text-xs font-normal text-slate-500">(last {days} days)</span> : null}
        </h2>
        <Link
          href="/student/recorded-lectures"
          className="inline-flex min-h-[44px] items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-900"
        >
          All recorded lectures
          <ArrowRight size={12} aria-hidden />
        </Link>
      </div>
      <div className="p-4 sm:p-5">
        {loading && items.length === 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-slate-100" />
            ))}
          </div>
        ) : error && items.length === 0 ? (
          <p role="alert" className="text-sm text-rose-700">
            {error}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-slate-500">No new recorded lectures right now.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {items.map((item) => (
              <li key={item.id}>
                {item.resourceAccess?.locked ? (
                  <div className="flex min-h-[44px] items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-xs font-semibold text-slate-800">
                        {item.lecture.title} · {partLabel(item)}
                      </span>
                      <span className="block break-words text-[11px] text-slate-500">
                        {item.class.name} · {formatLectureDateTime(item.lecture.date)}
                      </span>
                      <span className="mt-1 block">
                        <LockedResourceBadge lock={item.resourceAccess} compact />
                      </span>
                    </span>
                  </div>
                ) : (
                <Link
                  href={playerHref(item.lecture.id, item.id)}
                  prefetch={false}
                  className="flex min-h-[44px] items-start gap-2.5 rounded-xl border border-slate-200 px-3 py-2 hover:border-emerald-300 hover:bg-emerald-50/60"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <Play size={12} className="translate-x-[1px]" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-xs font-semibold text-slate-800">
                      {item.lecture.title} · {partLabel(item)}
                    </span>
                    <span className="block break-words text-[11px] text-slate-500">
                      {item.class.name} · {formatLectureDateTime(item.lecture.date)}
                    </span>
                  </span>
                </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
