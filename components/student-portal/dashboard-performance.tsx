"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { UserCheck, BarChart2 } from "lucide-react";

import { useStudentLiveEvent } from "@/components/student-portal/use-student-live-events";

type Data = {
  attendance: { percent: number; attended: number; total: number };
  quiz: { percent: number; attempted: number };
};

function tone(percent: number) {
  if (percent >= 75) return { ring: "border-emerald-200", text: "text-emerald-700", bar: "bg-emerald-500" };
  if (percent >= 50) return { ring: "border-amber-200", text: "text-amber-700", bar: "bg-amber-500" };
  return { ring: "border-rose-200", text: "text-rose-700", bar: "bg-rose-500" };
}

function Metric({
  icon,
  label,
  percent,
  sub,
  loading,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  percent: number;
  sub: string;
  loading: boolean;
  href: string;
}) {
  const t = tone(percent);
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3 transition-colors hover:border-emerald-300 hover:bg-emerald-50/40"
    >
      <div
        className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-4 bg-white ${t.ring}`}
      >
        <span className={`text-base font-bold ${t.text}`}>
          {loading ? "—" : `${percent}%`}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="inline-flex items-center gap-1.5 text-sm font-bold text-slate-900">
          {icon}
          {label}
        </p>
        <p className="mt-0.5 text-[11px] text-slate-500">{loading ? "Loading…" : sub}</p>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-2 rounded-full transition-all ${t.bar}`}
            style={{ width: `${loading ? 0 : percent}%` }}
          />
        </div>
      </div>
    </Link>
  );
}

export function DashboardPerformance() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/student/dashboard/performance", { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; data?: Data };
      if (json.success && json.data) setData(json.data);
    } catch {
      /* keep last snapshot */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: attendance and quiz submissions bump the shared SSE stream.
  useStudentLiveEvent("counts-stale", () => void load());

  const attendance = data?.attendance ?? { percent: 0, attended: 0, total: 0 };
  const quiz = data?.quiz ?? { percent: 0, attempted: 0 };

  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-gradient-to-r from-emerald-50 to-white px-4 py-3 sm:px-5">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-bold text-foreground">
          <BarChart2 size={14} className="text-emerald-600" />
          Attendance &amp; quiz performance
        </h2>
      </div>

      <div className="grid gap-2 p-4 sm:grid-cols-2">
        <Metric
          icon={<UserCheck size={13} className="text-emerald-600" />}
          label="Overall attendance"
          percent={attendance.percent}
          sub={`Attended ${attendance.attended} of ${attendance.total} lectures`}
          loading={loading}
          href="/student/attendance"
        />
        <Metric
          icon={<BarChart2 size={13} className="text-violet-600" />}
          label="Overall quiz score"
          percent={quiz.percent}
          sub={
            quiz.attempted > 0
              ? `Average across ${quiz.attempted} attempted quiz${quiz.attempted === 1 ? "" : "zes"}`
              : "No quizzes attempted yet"
          }
          loading={loading}
          href="/student/quizzes"
        />
      </div>
    </section>
  );
}
