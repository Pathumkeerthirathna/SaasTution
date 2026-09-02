"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Play,
  BookOpen,
  Video,
  ScrollText,
  ClipboardList,
  FileText,
  HelpCircle,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { LiveBroadcastCard } from "@/components/dashboard/live-broadcast-card";
import type { LiveBroadcastView } from "@/lib/youtube-live-status";
import type { LiveSessionView } from "@/services/student-live-service";
import type {
  CountsRange,
  StudentDashboardCounts,
} from "@/services/student-dashboard-counts-service";

type Props = {
  studentId: string;
  initialSessions: LiveSessionView[];
  initialBroadcasts: LiveBroadcastView[];
  initialCounts: StudentDashboardCounts;
};

const RANGE_OPTIONS: { value: CountsRange; label: string }[] = [
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
  { value: "all", label: "All" },
];

function formatElapsed(startedAt: string): string {
  const mins = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

export function LiveDashboardSection({
  studentId,
  initialSessions,
  initialBroadcasts,
  initialCounts,
}: Props) {
  const [sessions, setSessions] = useState<LiveSessionView[]>(initialSessions);
  const [broadcasts, setBroadcasts] = useState<LiveBroadcastView[]>(initialBroadcasts);
  const [counts, setCounts] = useState<StudentDashboardCounts>(initialCounts);
  const [range, setRange] = useState<CountsRange>(initialCounts.range);
  const [countsLoading, setCountsLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  const rangeRef = useRef(range);
  rangeRef.current = range;

  useEffect(() => setMounted(true), []);

  const fetchCounts = useCallback(async (r: CountsRange) => {
    setCountsLoading(true);
    try {
      const res = await fetch(`/api/student/dashboard/counts?range=${r}`, { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; data?: { counts?: StudentDashboardCounts } };
      if (json.success && json.data?.counts) setCounts(json.data.counts);
    } catch {
      /* keep last-known counts */
    } finally {
      setCountsLoading(false);
    }
  }, []);

  // Re-pull counts when the range changes (the first render already has them).
  const firstRange = useRef(true);
  useEffect(() => {
    if (firstRange.current) {
      firstRange.current = false;
      return;
    }
    void fetchCounts(range);
  }, [range, fetchCounts]);

  // One SSE connection for the whole live area — pushed on real changes only,
  // never polled. Keep-alive comments from the server keep it open.
  useEffect(() => {
    const source = new EventSource("/api/student/live/stream");

    source.addEventListener("sessions", (e) => {
      try {
        setSessions((JSON.parse((e as MessageEvent).data).sessions as LiveSessionView[]) ?? []);
      } catch {
        /* ignore malformed frame */
      }
    });
    source.addEventListener("broadcasts", (e) => {
      try {
        setBroadcasts((JSON.parse((e as MessageEvent).data).broadcasts as LiveBroadcastView[]) ?? []);
      } catch {
        /* ignore malformed frame */
      }
    });
    source.addEventListener("counts-stale", () => {
      void fetchCounts(rangeRef.current);
    });

    return () => source.close();
  }, [fetchCounts]);

  return (
    <>
      <LiveBroadcastCard broadcasts={broadcasts} tone="emerald" heading="Live class streaming now" />

      {sessions.length > 0 && (
        <section className="rounded-3xl border-2 border-emerald-400 bg-gradient-to-r from-emerald-50 to-white p-5 shadow-card">
          <div className="mb-3 flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
            </span>
            <p className="text-sm font-bold uppercase tracking-widest text-emerald-700">Live Now</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sessions.map((session) => (
              <article
                key={session.id}
                className="flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm"
              >
                <div>
                  <h3 className="text-base font-bold text-foreground">{session.className}</h3>
                  <p className="text-xs text-muted">Teacher: {session.teacherName}</p>
                  {session.lectureTitle && (
                    <p className="mt-0.5 text-xs font-medium text-emerald-700">{session.lectureTitle}</p>
                  )}
                  <p className="mt-1 text-[11px] text-muted">
                    {mounted ? `Started ${formatElapsed(session.startedAt)}` : "Live"} &middot;{" "}
                    {session.joinedCount} joined
                  </p>
                </div>
                <Link
                  href={`/session/join?sessionId=${session.id}&role=student&studentId=${studentId}`}
                  className="btn-primary inline-flex items-center gap-1.5 self-start"
                >
                  <Play size={13} /> Join Now
                </Link>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Overview counts — realtime via the same SSE stream */}
      <section className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-gradient-to-r from-emerald-50 to-white px-5 py-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">Your overview</h2>
            <p className="text-[11px] text-muted">Engagement across your classes{countsLoading ? " · updating…" : ""}</p>
          </div>
          <div className="flex flex-wrap gap-1">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setRange(opt.value)}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  range === opt.value
                    ? "bg-emerald-600 text-white"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 xl:grid-cols-7">
          <CountTile
            icon={BookOpen}
            label="Enrolled classes"
            big={String(counts.classes)}
            tone="emerald"
            href="/student/classes"
          />
          <CountTile
            icon={Wallet}
            label="Payments due"
            big={String(counts.payments.due)}
            sub={`· ${counts.payments.dueSoon} due soon`}
            tone={counts.payments.due > 0 ? "rose" : "teal"}
            href="/student/payments"
          />
          <CountTile
            icon={Video}
            label="Lectures not attended"
            big={String(counts.lectures.notAttended)}
            sub={`/ ${counts.lectures.total} lectures`}
            tone="rose"
            href={`/student/lectures?range=${range}&attendance=missed`}
          />
          <CountTile
            icon={ScrollText}
            label="Not engaged papers"
            big={String(counts.papers.pending)}
            sub={`/ ${counts.papers.total} papers`}
            tone="violet"
            href={`/student/papers?range=${range}&pending=1`}
          />
          <CountTile
            icon={ClipboardList}
            label="Due assignments"
            big={String(counts.assignments.due)}
            sub={`/ ${counts.assignments.total} assignments`}
            tone="sky"
            href={`/student/assignments?range=${range}&due=1`}
          />
          <CountTile
            icon={FileText}
            label="Notes to view"
            big={String(counts.notes.unviewed)}
            sub={`/ ${counts.notes.total} notes`}
            tone="amber"
            href={`/student/lectures?range=${range}&notes=unviewed`}
          />
          <CountTile
            icon={HelpCircle}
            label="Quizzes to attempt"
            big={String(counts.quizzes.notAttempted)}
            sub={`/ ${counts.quizzes.total} quizzes`}
            tone="indigo"
            href={`/student/quizzes?range=${range}&todo=1`}
          />
        </div>
      </section>
    </>
  );
}

const TONES: Record<string, string> = {
  emerald: "bg-emerald-100 text-emerald-700",
  rose: "bg-rose-100 text-rose-700",
  teal: "bg-teal-100 text-teal-700",
  violet: "bg-violet-100 text-violet-700",
  sky: "bg-sky-100 text-sky-700",
  amber: "bg-amber-100 text-amber-700",
  indigo: "bg-indigo-100 text-indigo-700",
};

function CountTile({
  icon: Icon,
  label,
  big,
  sub,
  tone,
  href,
}: {
  icon: LucideIcon;
  label: string;
  big: string;
  sub?: string;
  tone: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl border border-slate-200 bg-white p-3 transition-colors hover:border-emerald-300 hover:bg-emerald-50/40"
    >
      <span className={`mb-2 inline-flex h-8 w-8 items-center justify-center rounded-lg ${TONES[tone]}`}>
        <Icon size={15} />
      </span>
      <p className="text-2xl font-bold leading-none text-slate-900">
        {big}
        {sub ? <span className="ml-1 text-xs font-medium text-slate-400">{sub}</span> : null}
      </p>
      <p className="mt-1 text-[11px] font-medium text-muted">{label}</p>
    </Link>
  );
}
