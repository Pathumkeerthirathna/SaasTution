"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { QuizAttemptAction } from "@/components/student-portal/quiz-attempt-action";
import { Panel } from "@/components/student-portal/student-ui";
import type { PaginationMeta } from "@/lib/api-types";

type ClassOption = { id: string; name: string };

type QuizRecord = {
  id: string;
  title: string;
  maxAttempts: number | null;
  dueDate: string | null;
  classId: string;
  className: string;
  lectureTitle: string;
  submission: {
    id: string;
    score: number;
    totalQuestions: number;
    attemptCount: number;
    submittedAt: string;
  } | null;
};

const PAGE_SIZE = 10;

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
  const [records, setRecords] = useState<QuizRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState(() => searchParams.get("classId") ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  function applyFilter(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setter(e.target.value);
      setPage(1);
    };
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (classId) params.set("classId", classId);
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        params.set("page", String(page));
        params.set("pageSize", String(PAGE_SIZE));

        const res = await fetch(`/api/students/me/quizzes?${params.toString()}`);
        const json = await res.json() as {
          success: boolean;
          data?: { records: QuizRecord[]; classes: ClassOption[] };
          pagination?: PaginationMeta;
          error?: { message: string };
        };

        if (!cancelled) {
          if (json.success && json.data) {
            setRecords(json.data.records);
            setClasses(json.data.classes);
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
    return () => { cancelled = true; };
  }, [classId, from, to, page]);

  function clearFilters() {
    setClassId("");
    setFrom("");
    setTo("");
    setPage(1);
  }

  const hasFilter = classId || from || to;

  return (
    <Panel title="Quizzes" subtitle="Open a quiz from the right panel, answer, and submit to update marks instantly.">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 border-b border-brand-200 pb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Class</label>
          <select
            value={classId}
            onChange={applyFilter(setClassId)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Due from</label>
          <input
            type="date"
            value={from}
            onChange={applyFilter(setFrom)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Due to</label>
          <input
            type="date"
            value={to}
            onChange={applyFilter(setTo)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        {hasFilter ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* Body */}
      <div className="mt-4">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : records.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-6 text-sm text-slate-600">
            No quizzes found{hasFilter ? " for the selected filters" : " for your classes yet"}.
          </div>
        ) : (
          <div className="space-y-3">
            {records.map((quiz) => {
              const dueDate = quiz.dueDate ? new Date(quiz.dueDate) : null;
              const sub = quiz.submission
                ? { ...quiz.submission, submittedAt: new Date(quiz.submission.submittedAt) }
                : null;
              return (
                <article key={quiz.id} className="rounded-xl border border-brand-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold text-slate-900">{quiz.title}</h3>
                      <p className="mt-0.5 text-sm text-slate-600">{quiz.className}</p>
                      <p className="text-sm text-slate-500">Lecture: {quiz.lectureTitle}</p>
                      {sub ? (
                        <p className="mt-1 text-sm font-medium text-brand-800">
                          Latest marks: {sub.score}/{sub.totalQuestions}
                        </p>
                      ) : null}
                    </div>
                    <div className="shrink-0">
                      <QuizAttemptAction
                        quizId={quiz.id}
                        maxAttempts={quiz.maxAttempts ?? null}
                        dueDate={dueDate}
                        initialSubmission={sub}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 ? (
        <div className="mt-5 flex items-center justify-between border-t border-brand-200 pt-4">
          <p className="text-xs text-slate-500">
            Page {pagination.page} of {pagination.totalPages} &mdash;{" "}
            {pagination.totalItems} quiz{pagination.totalItems !== 1 ? "zes" : ""}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!pagination.hasPreviousPage || isLoading}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!pagination.hasNextPage || isLoading}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
