"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, HelpCircle, Loader2 } from "lucide-react";

import { QuizAttemptAction } from "@/components/student-portal/quiz-attempt-action";

type QuizRecord = {
  id: string;
  title: string;
  maxAttempts: number | null;
  startDateTime: string;
  endDateTime: string;
  submission: {
    id: string;
    score: number;
    totalQuestions: number;
    attemptCount: number;
    submittedAt: string;
  } | null;
};

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A student's quizzes for the current lecture, inside the live session.
 * Students can read the schedule and attempt each quiz; they cannot add, edit
 * or delete quizzes.
 */
export default function StudentQuizzesPanel({
  lectureId,
}: {
  lectureId: string;
}) {
  const [records, setRecords] = useState<QuizRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/students/me/quizzes?lectureId=${encodeURIComponent(lectureId)}&page=1&pageSize=50`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as {
        success?: boolean;
        data?: { records?: QuizRecord[] };
        error?: { message?: string };
      };
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error?.message ?? "Failed to load quizzes.");
      }
      setRecords(json.data.records ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quizzes.");
    } finally {
      setIsLoading(false);
    }
  }, [lectureId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3 text-slate-900">
      <section className="rounded-xl border border-emerald-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
            <HelpCircle size={15} />
          </span>
          <div>
            <h4 className="text-sm font-semibold text-slate-900">Quizzes</h4>
            <p className="text-[11px] text-slate-500">
              Attempt the quizzes for this lecture and track your marks.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" />
            Loading quizzes…
          </div>
        ) : error ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        ) : records.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-emerald-200 bg-emerald-50/60 px-3 py-3 text-center text-xs text-emerald-700">
            No quizzes for this lecture yet.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {records.map((quiz) => {
              const sub = quiz.submission
                ? {
                    ...quiz.submission,
                    submittedAt: new Date(quiz.submission.submittedAt),
                  }
                : null;

              return (
                <article
                  key={quiz.id}
                  className="rounded-lg border border-slate-200 bg-white p-3"
                >
                  <div className="flex flex-col gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900">
                        {quiz.title}
                      </h3>
                      <p className="mt-0.5 inline-flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                        <CalendarClock size={11} />
                        {fmtDateTime(quiz.startDateTime)} →{" "}
                        {fmtDateTime(quiz.endDateTime)}
                      </p>
                    </div>
                    <div>
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
      </section>
    </div>
  );
}
