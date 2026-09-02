"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  HelpCircle,
  BookOpenText,
  CalendarDays,
  CalendarClock,
  AlertTriangle,
  CheckCircle2,
  Repeat,
  Ban,
} from "lucide-react";

import { QuizAttemptAction } from "@/components/student-portal/quiz-attempt-action";
import type { PaginationMeta } from "@/lib/api-types";

type ClassOption = { id: string; name: string };
type LectureOption = { id: string; title: string; classId: string; className: string; date: string };

type QuizRecord = {
  id: string;
  title: string;
  maxAttempts: number | null;
  startDateTime: string;
  endDateTime: string;
  classId: string;
  className: string;
  lectureId: string;
  lectureTitle: string;
  lectureDate: string;
  submission: {
    id: string;
    score: number;
    totalQuestions: number;
    attemptCount: number;
    submittedAt: string;
  } | null;
};

const PAGE_SIZE = 10;

type DuePreset =
  | "all"
  | "today"
  | "tomorrow"
  | "yesterday"
  | "week"
  | "lastweek"
  | "nextweek"
  | "month"
  | "quarter"
  | "year";

const DUE_PRESETS: { value: DuePreset; label: string }[] = [
  { value: "all", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "This week" },
  { value: "lastweek", label: "Last week" },
  { value: "nextweek", label: "Next week" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
];

function isDuePreset(v: string | null): v is DuePreset {
  return DUE_PRESETS.some((p) => p.value === v);
}

function toYmd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function computeDueRange(preset: DuePreset): { from: string; to: string } {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (base: Date, days: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  };

  switch (preset) {
    case "all":
      return { from: "", to: "" };
    case "today":
      return { from: toYmd(day), to: toYmd(day) };
    case "tomorrow":
      return { from: toYmd(shift(day, 1)), to: toYmd(shift(day, 1)) };
    case "yesterday":
      return { from: toYmd(shift(day, -1)), to: toYmd(shift(day, -1)) };
    case "week": {
      const start = shift(day, -day.getDay());
      return { from: toYmd(start), to: toYmd(shift(start, 6)) };
    }
    case "lastweek": {
      const start = shift(day, -day.getDay() - 7);
      return { from: toYmd(start), to: toYmd(shift(start, 6)) };
    }
    case "nextweek": {
      const start = shift(day, -day.getDay() + 7);
      return { from: toYmd(start), to: toYmd(shift(start, 6)) };
    }
    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { from: toYmd(start), to: toYmd(end) };
    }
    case "quarter": {
      const q = Math.floor(now.getMonth() / 3);
      return {
        from: toYmd(new Date(now.getFullYear(), q * 3, 1)),
        to: toYmd(new Date(now.getFullYear(), q * 3 + 3, 0)),
      };
    }
    case "year":
      return {
        from: toYmd(new Date(now.getFullYear(), 0, 1)),
        to: toYmd(new Date(now.getFullYear(), 11, 31)),
      };
  }
}

function fmtDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function StudentQuizzesPage() {
  return (
    <Suspense fallback={null}>
      <StudentQuizzesPageInner />
    </Suspense>
  );
}

function StudentQuizzesPageInner() {
  const searchParams = useSearchParams();

  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [lectures, setLectures] = useState<LectureOption[]>([]);
  const [records, setRecords] = useState<QuizRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState(() => searchParams.get("classId") ?? "");
  const [lectureId, setLectureId] = useState(() => searchParams.get("lectureId") ?? "");
  const [duePreset, setDuePreset] = useState<DuePreset>(() => {
    const r = searchParams.get("range");
    return isDuePreset(r) ? r : "all";
  });
  const [todoOnly, setTodoOnly] = useState(() => searchParams.get("todo") === "1");
  const [page, setPage] = useState(1);

  const dueRange = useMemo(() => computeDueRange(duePreset), [duePreset]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (classId) params.set("classId", classId);
        if (lectureId) params.set("lectureId", lectureId);
        if (dueRange.from) params.set("from", dueRange.from);
        if (dueRange.to) params.set("to", dueRange.to);
        params.set("page", String(page));
        params.set("pageSize", String(PAGE_SIZE));

        const res = await fetch(`/api/students/me/quizzes?${params.toString()}`);
        const json = (await res.json()) as {
          success: boolean;
          data?: { records: QuizRecord[]; classes: ClassOption[]; lectures: LectureOption[] };
          pagination?: PaginationMeta;
          error?: { message: string };
        };

        if (!cancelled) {
          if (json.success && json.data) {
            setRecords(json.data.records);
            setClasses(json.data.classes);
            setLectures(json.data.lectures);
            setPagination(json.pagination ?? null);
          } else {
            setError(json.error?.message ?? "Failed to load quizzes.");
          }
        }
      } catch {
        if (!cancelled) setError("Failed to load quizzes.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [classId, lectureId, dueRange.from, dueRange.to, page]);

  const lectureOptions = useMemo(
    () => (classId ? lectures.filter((l) => l.classId === classId) : lectures),
    [lectures, classId]
  );

  const hasFilter = Boolean(classId || lectureId) || duePreset !== "all" || todoOnly;

  function clearFilters() {
    setClassId("");
    setLectureId("");
    setDuePreset("all");
    setTodoOnly(false);
    setPage(1);
  }

  const now = Date.now();
  const visibleRecords = todoOnly ? records.filter((q) => !q.submission) : records;

  return (
    <section className="overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-card">
      <header className="flex items-center gap-2.5 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-white px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <HelpCircle size={16} />
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-slate-900">Quizzes</h1>
          <p className="text-xs text-slate-500">Attempt quizzes and track your marks.</p>
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
                setLectureId("");
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
            <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Lecture</label>
            <select
              value={lectureId}
              onChange={(e) => {
                setLectureId(e.target.value);
                setPage(1);
              }}
              className="max-w-[240px] rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
            >
              <option value="">All lectures</option>
              {lectureOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                  {classId ? "" : ` · ${l.className}`}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Period</label>
            <select
              value={duePreset}
              onChange={(e) => {
                setDuePreset(e.target.value as DuePreset);
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
            >
              {DUE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <label className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={todoOnly}
              onChange={(e) => {
                setTodoOnly(e.target.checked);
                setPage(1);
              }}
              className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            To do only
          </label>

          {hasFilter ? (
            <button
              type="button"
              onClick={clearFilters}
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
              <div key={i} className="h-24 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        ) : visibleRecords.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-6 text-center text-xs text-slate-600">
            No quizzes found{hasFilter ? " for the selected filters" : " for your classes yet"}.
          </div>
        ) : (
          <div className="space-y-2.5">
            {visibleRecords.map((quiz) => {
              const startMs = new Date(quiz.startDateTime).getTime();
              const endMs = new Date(quiz.endDateTime).getTime();
              const phase: "upcoming" | "open" | "closed" =
                now < startMs ? "upcoming" : now > endMs ? "closed" : "open";
              const sub = quiz.submission
                ? { ...quiz.submission, submittedAt: new Date(quiz.submission.submittedAt) }
                : null;
              const attemptsUsed = sub?.attemptCount ?? 0;
              const attemptsExhausted =
                quiz.maxAttempts != null && attemptsUsed >= quiz.maxAttempts;
              const missed = !sub && phase === "closed";

              return (
                <article
                  key={quiz.id}
                  className={`rounded-lg border bg-white p-3 ${
                    missed
                      ? "border-rose-200"
                      : phase === "open" && !sub
                        ? "border-amber-200"
                        : "border-slate-200"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {/* Lecture context */}
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                        <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                          <BookOpenText size={11} />
                          {quiz.lectureTitle}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays size={11} />
                          {fmtDate(quiz.lectureDate)}
                        </span>
                        <span className="text-slate-400">· {quiz.className}</span>
                      </p>

                      <h3 className="mt-1 text-sm font-semibold text-slate-900">{quiz.title}</h3>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                          <CalendarClock size={10} />
                          {fmtDateTime(quiz.startDateTime)} → {fmtDateTime(quiz.endDateTime)}
                        </span>

                        <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                          <Repeat size={10} />
                          {quiz.maxAttempts != null
                            ? `${attemptsUsed}/${quiz.maxAttempts} attempts`
                            : "Unlimited attempts"}
                        </span>

                        {sub ? (
                          <>
                            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                              <CheckCircle2 size={10} />
                              Marks {sub.score}/{sub.totalQuestions} ·{" "}
                              {Math.round((sub.score / Math.max(1, sub.totalQuestions)) * 100)}% ·{" "}
                              {fmtDate(quiz.submission!.submittedAt)}
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                              ✓ {sub.score} correct
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                              ✗ {Math.max(0, sub.totalQuestions - sub.score)} incorrect
                            </span>
                          </>
                        ) : null}

                        {attemptsExhausted ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">
                            <Ban size={10} />
                            Max attempts reached
                          </span>
                        ) : missed ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700">
                            <AlertTriangle size={10} />
                            Missed
                          </span>
                        ) : !sub && phase === "upcoming" ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                            <CalendarClock size={10} />
                            Upcoming
                          </span>
                        ) : !sub && phase === "open" ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-700">
                            Open now
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="shrink-0">
                      <QuizAttemptAction
                        quizId={quiz.id}
                        maxAttempts={quiz.maxAttempts ?? null}
                        startDateTime={new Date(quiz.startDateTime)}
                        endDateTime={new Date(quiz.endDateTime)}
                        initialSubmission={sub}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 ? (
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-200 pt-3">
            <p className="text-[11px] text-slate-500">
              Page {pagination.page} / {pagination.totalPages} · {pagination.totalItems} quiz
              {pagination.totalItems !== 1 ? "zes" : ""}
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
