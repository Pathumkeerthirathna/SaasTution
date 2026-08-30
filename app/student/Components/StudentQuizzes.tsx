"use client";

import Link from "next/link";
import {
  ClipboardCheck,
  ChevronRight,
  CalendarDays,
  CalendarClock,
  Repeat2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface QuizSummary {
  totalQuizzes: number;
  attempted: number;
  missed: number;
  averageScore: number;
}

interface ClassQuiz {
  classId: string;
  className: string;
  totalQuizzes: number;
  attempted: number;
  missed: number;
  averageScore: number;
}

interface QuizRow {
  quizId: string;
  quizTitle: string;
  lectureId: string;
  lectureTitle: string;
  lectureDate: string;
  dueDate: string | null;
  attempted: boolean;
  score: number | null;
  totalQuestions: number | null;
  percentage: number | null;
  submittedAt: string | null;
  attemptCount: number;
}

interface StudentQuizzesProps {
  studentId: string;
  /** When provided by the parent page, the tab renders this instead of fetching. */
  data?: {
    summary: QuizSummary | null;
    classes: ClassQuiz[];
  } | null;
}

function fmtDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function scoreBadge(pct: number) {
  if (pct >= 90) return "bg-emerald-100 text-emerald-700";
  if (pct >= 75) return "bg-teal-100 text-teal-700";
  if (pct >= 60) return "bg-amber-100 text-amber-700";
  return "bg-rose-100 text-rose-700";
}

export function StudentQuizzes({ studentId, data }: StudentQuizzesProps) {
  const controlled = data !== undefined;

  const [fetched, setFetched] = useState<{
    summary: QuizSummary | null;
    classes: ClassQuiz[];
  } | null>(null);

  const [rowsByClass, setRowsByClass] = useState<Record<string, QuizRow[]>>({});
  const [rowsLoading, setRowsLoading] = useState(true);

  const loadQuizSummary = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/quizzes`
      );
      const result = await response.json();
      setFetched(
        result.success
          ? { summary: result.data.summary, classes: result.data.classes }
          : { summary: null, classes: [] }
      );
    } catch {
      setFetched({ summary: null, classes: [] });
    }
  }, [studentId]);

  useEffect(() => {
    if (controlled) return;
    void loadQuizSummary();
  }, [controlled, loadQuizSummary]);

  const resolved = controlled ? data : fetched;
  const loading = resolved == null;
  const summary = resolved?.summary ?? null;
  const classes = resolved?.classes ?? [];

  // Auto-load per-class quiz rows — no "View details" click required.
  useEffect(() => {
    if (loading || classes.length === 0) {
      if (classes.length === 0) setRowsLoading(false);
      return;
    }

    let cancelled = false;
    setRowsLoading(true);

    Promise.all(
      classes.map(async (cls) => {
        try {
          const response = await fetch(
            `/api/student/Profile/${studentId}/quizzes/${cls.classId}`
          );
          const result = await response.json();
          const quizzes: QuizRow[] =
            result.success && result.data?.quizzes ? result.data.quizzes : [];
          return [cls.classId, quizzes] as const;
        } catch {
          return [cls.classId, [] as QuizRow[]] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setRowsByClass(Object.fromEntries(entries));
      setRowsLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, loading, classes.map((c) => c.classId).join(",")]);

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="animate-pulse rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <div className="h-3.5 w-32 rounded bg-slate-200" />
          <div className="mt-3 grid grid-cols-4 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded-md bg-slate-100" />
            ))}
          </div>
        </div>
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white shadow-sm"
          />
        ))}
      </div>
    );
  }

  if (classes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <ClipboardCheck className="mx-auto mb-2 h-8 w-8 text-slate-400" />
        <h3 className="text-[13px] font-semibold text-slate-900">
          No quizzes yet
        </h3>
        <p className="mt-1 text-[12px] text-slate-500">
          Quiz results appear once this student's classes publish quizzes.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-900">
          <ClipboardCheck size={14} className="text-teal-600" />
          Quiz Overview
        </h2>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SummaryTile label="Total" value={summary?.totalQuizzes ?? 0} tone="slate" />
          <SummaryTile
            label="Attempted"
            value={summary?.attempted ?? 0}
            tone="emerald"
          />
          <SummaryTile
            label="Missed"
            value={summary?.missed ?? 0}
            tone="rose"
          />
          <SummaryTile
            label="Avg Score"
            value={`${summary?.averageScore ?? 0}%`}
            tone="teal"
          />
        </div>
      </div>

      {/* Per-class */}
      {classes.map((cls) => {
        const rows = rowsByClass[cls.classId] ?? [];
        const classRowsLoading = rowsLoading && !rowsByClass[cls.classId];

        return (
          <div
            key={cls.classId}
            className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-3.5 py-3">
              <div className="min-w-0">
                <h3 className="truncate text-[13px] font-semibold text-slate-900">
                  {cls.className}
                </h3>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {cls.attempted} of {cls.totalQuizzes} attempted
                  {cls.missed > 0 ? ` · ${cls.missed} missed` : ""}
                </p>
              </div>

              <div className="shrink-0 text-right">
                <p className="text-base font-bold leading-none text-slate-900">
                  {cls.averageScore}%
                </p>
                <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  Avg score
                </p>
              </div>
            </div>

            {classRowsLoading ? (
              <div className="space-y-1.5 p-2.5">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-11 animate-pulse rounded-md bg-slate-50"
                  />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="px-3.5 py-3 text-[11px] text-slate-400">
                No quizzes for this class yet.
              </p>
            ) : (
              <ul className="divide-y divide-slate-50">
                {rows.map((quiz) => (
                  <li key={quiz.quizId}>
                    <Link
                      href={`/dashboard/lectures?focusLectureId=${quiz.lectureId}`}
                      className="flex items-center gap-3 px-3.5 py-2 transition-colors hover:bg-slate-50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium text-slate-800">
                          {quiz.quizTitle}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-400">
                          <span className="inline-flex items-center gap-1">
                            <CalendarDays size={10} />
                            {quiz.lectureTitle}
                          </span>
                          {quiz.dueDate && (
                            <span className="inline-flex items-center gap-1">
                              <CalendarClock size={10} className="text-amber-500" />
                              Due {fmtDate(quiz.dueDate)}
                            </span>
                          )}
                          {quiz.attempted && quiz.attemptCount > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <Repeat2 size={10} className="text-slate-400" />
                              {quiz.attemptCount}{" "}
                              {quiz.attemptCount === 1 ? "attempt" : "attempts"}
                            </span>
                          )}
                          {quiz.attempted && quiz.submittedAt && (
                            <span>Submitted {fmtDate(quiz.submittedAt)}</span>
                          )}
                        </p>
                      </div>

                      {quiz.attempted && quiz.percentage !== null ? (
                        <span className="shrink-0 text-right">
                          <span
                            className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${scoreBadge(
                              quiz.percentage
                            )}`}
                          >
                            {quiz.percentage}%
                          </span>
                          {quiz.score !== null &&
                            quiz.totalQuestions !== null && (
                              <span className="mt-0.5 block text-[9px] text-slate-400">
                                {quiz.score}/{quiz.totalQuestions}
                              </span>
                            )}
                        </span>
                      ) : (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700">
                          <XCircle size={10} />
                          Missed
                        </span>
                      )}

                      <ChevronRight
                        size={13}
                        className="shrink-0 text-slate-300"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

const TILE_TONES = {
  slate: "text-slate-900",
  emerald: "text-emerald-600",
  rose: "text-rose-600",
  teal: "text-teal-600",
} as const;

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone: keyof typeof TILE_TONES;
}) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/70 px-2.5 py-2">
      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className={`mt-0.5 text-base font-bold leading-none ${TILE_TONES[tone]}`}>
        {value}
      </p>
    </div>
  );
}
