"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, ClipboardList, FileText, HelpCircle } from "lucide-react";

import { useTeacherLiveRefetch } from "@/components/dashboard/use-teacher-live-events";

type Submission = {
  id: string;
  studentName: string;
  registrationNumber: string | null;
  submittedAt: string;
};

type Assignment = {
  id: string;
  title: string;
  dueDate: string;
  className: string;
  lectureTitle: string;
  submissions: (Submission & { hasFile: boolean })[];
};

type Quiz = {
  id: string;
  title: string;
  className: string;
  totalQuestions: number;
  submissions: (Submission & {
    score: number;
    totalQuestions: number;
    attemptCount: number;
  })[];
};

type Coursework = { assignments: Assignment[]; quizzes: Quiz[] };

type RangeKey = "week" | "month";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
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
  if (range === "week") {
    const sun = new Date(d0);
    sun.setDate(d0.getDate() - d0.getDay());
    const sat = new Date(sun);
    sat.setDate(sun.getDate() + 6);
    return { from: fmt(sun), to: fmt(sat) };
  }
  return {
    from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function pct(score: number, total: number): number {
  return total > 0 ? Math.round((score / total) * 100) : 0;
}

function scoreTone(p: number): string {
  if (p >= 70) return "bg-emerald-100 text-emerald-700";
  if (p >= 40) return "bg-amber-100 text-amber-700";
  return "bg-rose-100 text-rose-700";
}

const MAX_ROWS = 5;

export function DashboardCoursework() {
  const [range, setRange] = useState<RangeKey>("week");
  const [data, setData] = useState<Coursework | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveTick, setLiveTick] = useState(0);

  const { from, to } = useMemo(() => rangeToDates(range), [range]);

  // Realtime: re-pull when a student submits an assignment/quiz or a teacher edits one.
  useTeacherLiveRefetch(() => setLiveTick((n) => n + 1));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/dashboard/coursework?from=${from}&to=${to}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        const body = (await res.json()) as {
          success: boolean;
          data?: Coursework;
          error?: { message?: string };
        };
        if (!res.ok || !body.success || !body.data) {
          throw new Error(body.error?.message ?? "Failed to load.");
        }
        setData(body.data);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load.");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [from, to, liveTick]);

  const skeleton = (
    <div className="space-y-2.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl bg-brand-50" />
      ))}
    </div>
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Assignments — not range-scoped: shows whatever still needs review. */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-amber-50 to-white px-5 py-4">
            <div className="flex items-center gap-2">
              <ClipboardList size={16} className="text-amber-500" />
              <h2 className="font-bold text-foreground">Assignments &amp; submissions</h2>
            </div>
            <Link
              href="/dashboard/lectures"
              className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline"
            >
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="p-5">
            {error ? (
              <p className="rounded-xl border border-dashed border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-600">
                Couldn&apos;t load assignments.
              </p>
            ) : loading ? (
              skeleton
            ) : (data?.assignments.length ?? 0) === 0 ? (
              <p className="rounded-xl border border-dashed border-amber-200 bg-amber-50 px-4 py-4 text-sm text-muted">
                No assignment submissions are waiting to be reviewed.
              </p>
            ) : (
              <div className="space-y-3">
                {data!.assignments.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-foreground sm:truncate">{a.title}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {a.className} &middot; {a.lectureTitle}
                        </p>
                        <p className="text-[11px] text-muted">Due {shortDate(a.dueDate)}</p>
                      </div>
                      <span
                        className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                          a.submissions.length > 0
                            ? "bg-amber-100 text-amber-700"
                            : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {a.submissions.length} sub{a.submissions.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    {a.submissions.length > 0 && (
                      <ul className="mt-2 space-y-1 border-t border-brand-100 pt-2">
                        {a.submissions.slice(0, MAX_ROWS).map((s) => (
                          <li
                            key={s.id}
                            className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-2"
                          >
                            <span className="flex min-w-0 items-start gap-1.5 text-foreground">
                              {s.hasFile && (
                                <FileText size={11} className="mt-0.5 flex-shrink-0 text-brand-500" />
                              )}
                              <span className="break-words sm:truncate">
                                {s.studentName}
                                {s.registrationNumber && (
                                  <span className="text-muted"> ({s.registrationNumber})</span>
                                )}
                              </span>
                            </span>
                            <span className="text-muted sm:flex-shrink-0">
                              {shortDate(s.submittedAt)}
                            </span>
                          </li>
                        ))}
                        {a.submissions.length > MAX_ROWS && (
                          <li className="text-[11px] text-muted">
                            + {a.submissions.length - MAX_ROWS} more
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </article>

        {/* Quizzes — range-scoped via the tabs below. */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-gradient-to-r from-violet-50 to-white px-5 py-4">
            <div className="flex items-center gap-2">
              <HelpCircle size={16} className="text-violet-500" />
              <h2 className="font-bold text-foreground">Quizzes &amp; results</h2>
            </div>
            <Link
              href="/dashboard/lectures"
              className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline"
            >
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="flex flex-wrap gap-1 border-b border-brand-100 bg-white p-3">
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
          <div className="p-5">
            {error ? (
              <p className="rounded-xl border border-dashed border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-600">
                Couldn&apos;t load quizzes.
              </p>
            ) : loading ? (
              skeleton
            ) : (data?.quizzes.length ?? 0) === 0 ? (
              <p className="rounded-xl border border-dashed border-violet-200 bg-violet-50 px-4 py-4 text-sm text-muted">
                No quizzes due in this range.
              </p>
            ) : (
              <div className="space-y-3">
                {data!.quizzes.map((q) => (
                  <div
                    key={q.id}
                    className="rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-foreground sm:truncate">{q.title}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {q.className} &middot; {q.totalQuestions} question
                          {q.totalQuestions !== 1 ? "s" : ""}
                        </p>
                      </div>
                      <span
                        className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                          q.submissions.length > 0
                            ? "bg-violet-100 text-violet-700"
                            : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {q.submissions.length} done
                      </span>
                    </div>
                    {q.submissions.length > 0 && (
                      <ul className="mt-2 space-y-1 border-t border-brand-100 pt-2">
                        {q.submissions.slice(0, MAX_ROWS).map((s) => {
                          const p = pct(s.score, s.totalQuestions);
                          return (
                            <li
                              key={s.id}
                              className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-2"
                            >
                              <span className="min-w-0 break-words text-foreground sm:truncate">
                                {s.studentName}
                                {s.registrationNumber && (
                                  <span className="text-muted"> ({s.registrationNumber})</span>
                                )}
                              </span>
                              <span className="flex items-center gap-1.5 sm:flex-shrink-0">
                                <span className="text-muted">
                                  {s.score}/{s.totalQuestions}
                                </span>
                                <span
                                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${scoreTone(p)}`}
                                >
                                  {p}%
                                </span>
                              </span>
                            </li>
                          );
                        })}
                        {q.submissions.length > MAX_ROWS && (
                          <li className="text-[11px] text-muted">
                            + {q.submissions.length - MAX_ROWS} more
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
