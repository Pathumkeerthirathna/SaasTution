"use client";

import { FormEvent, useEffect, useState, useTransition } from "react";

import { StatusBadge } from "@/components/student-portal/student-ui";

function formatDuration(ms: number) {
  if (ms <= 0) return "00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${base}` : base;
}

type QuizSubmissionSummary = {
  id: string;
  score: number;
  totalQuestions: number;
  attemptCount: number;
  submittedAt: Date;
};

type QuizDetail = {
  quiz: {
    id: string;
    title: string;
    maxAttempts: number | null;
    startDateTime: string;
    endDateTime: string;
    questions: {
      id: string;
      text: string;
      orderIndex: number;
      answerType: "SINGLE" | "MULTIPLE";
      options: {
        id: string;
        text: string;
        orderIndex: number;
      }[];
    }[];
  };
  submission: {
    id: string;
    score: number;
    totalQuestions: number;
    attemptCount: number;
    submittedAt: string;
    answers: {
      questionId: string;
      selectedOptionIds: string[];
    }[];
  } | null;
};

type ReviewDetail = {
  quiz: {
    id: string;
    title: string;
    questions: {
      id: string;
      text: string;
      answerType: "SINGLE" | "MULTIPLE";
      isCorrect: boolean;
      selectedOptionIds: string[];
      options: {
        id: string;
        text: string;
        isCorrect: boolean;
      }[];
    }[];
  };
  submission: {
    id: string;
    score: number;
    totalQuestions: number;
    attemptCount: number;
    submittedAt: string;
  };
};

type QuizAnswerInput = {
  questionId: string;
  selectedOptionIds: string[];
};

type Props = {
  quizId: string;
  maxAttempts: number | null;
  startDateTime: Date;
  endDateTime: Date;
  initialSubmission: QuizSubmissionSummary | null;
};

export function QuizAttemptAction({
  quizId,
  maxAttempts,
  startDateTime,
  endDateTime,
  initialSubmission,
}: Props) {
  const [submission, setSubmission] = useState<QuizSubmissionSummary | null>(initialSubmission);
  const [panelMode, setPanelMode] = useState<"attempt" | "review" | null>(null);
  const [detail, setDetail] = useState<QuizDetail | null>(null);
  const [reviewDetail, setReviewDetail] = useState<ReviewDetail | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Live 1s clock so the countdowns tick and the phase flips on their own.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const startMs = startDateTime.getTime();
  const endMs = endDateTime.getTime();
  const clock = nowMs ?? Date.now();
  const currentPhase: "upcoming" | "open" | "closed" =
    clock < startMs ? "upcoming" : clock > endMs ? "closed" : "open";

  const attemptsExhausted = maxAttempts !== null && submission !== null && submission.attemptCount >= maxAttempts;
  const canRetake = submission !== null && !attemptsExhausted && currentPhase === "open";
  const canStart = !submission && currentPhase === "open";

  async function openAttemptPanel() {
    setPanelMode("attempt");
    setErrorMessage(null);
    setJustSubmitted(false);
    setIsLoadingDetail(true);

    try {
      const response = await fetch(`/api/student/quizzes/${quizId}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        success: boolean;
        data?: QuizDetail;
        error?: { message?: string };
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error?.message ?? "Failed to load quiz details.");
      }

      setDetail(payload.data);

      const nextAnswers: Record<string, string[]> = {};
      for (const question of payload.data.quiz.questions) {
        const existing = payload.data.submission?.answers.find((a) => a.questionId === question.id);
        nextAnswers[question.id] = existing ? [...existing.selectedOptionIds] : [];
      }
      setAnswers(nextAnswers);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load quiz details.");
    } finally {
      setIsLoadingDetail(false);
    }
  }

  async function openReviewPanel() {
    setPanelMode("review");
    setErrorMessage(null);
    setIsLoadingDetail(true);

    try {
      const response = await fetch(`/api/student/quizzes/${quizId}/review`, { cache: "no-store" });
      const payload = (await response.json()) as {
        success: boolean;
        data?: ReviewDetail;
        error?: { message?: string };
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error?.message ?? "Failed to load review.");
      }

      setReviewDetail(payload.data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load review.");
    } finally {
      setIsLoadingDetail(false);
    }
  }

  function closePanel() {
    setPanelMode(null);
    setErrorMessage(null);
    setJustSubmitted(false);
  }

  function chooseOption(questionId: string, answerType: "SINGLE" | "MULTIPLE", optionId: string) {
    setAnswers((prev) => {
      const current = prev[questionId] ?? [];

      if (answerType === "SINGLE") {
        return {
          ...prev,
          [questionId]: [optionId],
        };
      }

      const exists = current.includes(optionId);
      return {
        ...prev,
        [questionId]: exists ? current.filter((id) => id !== optionId) : [...current, optionId],
      };
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    if (!detail) {
      setErrorMessage("Quiz details are not loaded yet.");
      return;
    }

    const answerItems: QuizAnswerInput[] = detail.quiz.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: answers[question.id] ?? [],
    }));

    if (answerItems.some((item) => item.selectedOptionIds.length === 0)) {
      setErrorMessage("Please answer all questions before submitting.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`/api/student/quizzes/${quizId}/submit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            answers: answerItems,
          }),
        });

        const payload = (await response.json()) as {
          success: boolean;
          data?: {
            submission: {
              id: string;
              score: number;
              totalQuestions: number;
              attemptCount: number;
              submittedAt: string;
            };
          };
          error?: { message?: string };
        };

        if (!response.ok || !payload.success || !payload.data) {
          setErrorMessage(payload.error?.message ?? "Failed to submit quiz.");
          return;
        }

        const nextSubmission = {
          ...payload.data.submission,
          submittedAt: new Date(payload.data.submission.submittedAt),
        };

        setSubmission(nextSubmission);
        setJustSubmitted(true);
        setDetail((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            submission: {
              id: nextSubmission.id,
              score: nextSubmission.score,
              totalQuestions: nextSubmission.totalQuestions,
              attemptCount: nextSubmission.attemptCount,
              submittedAt: nextSubmission.submittedAt.toISOString(),
              answers: answerItems,
            },
          };
        });
      } catch {
        setErrorMessage("Unable to submit quiz right now. Please try again.");
      }
    });
  }

  const isOpen = panelMode !== null;

  const countdownMs =
    currentPhase === "upcoming" ? startMs - clock : currentPhase === "open" ? endMs - clock : 0;

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        {submission ? (
          <StatusBadge label="Completed" tone="completed" />
        ) : currentPhase === "upcoming" ? (
          <StatusBadge label="Upcoming" tone="neutral" />
        ) : currentPhase === "closed" ? (
          <StatusBadge label="Closed" tone="overdue" />
        ) : (
          <StatusBadge label="Open now" tone="pending" />
        )}

        {/* Live countdown */}
        {currentPhase === "upcoming" ? (
          <p className="text-xs font-semibold text-amber-600">
            Starts in <span className="tabular-nums">{formatDuration(countdownMs)}</span>
          </p>
        ) : currentPhase === "open" ? (
          <p
            className={`text-xs font-semibold tabular-nums ${
              countdownMs < 15 * 60_000 ? "text-rose-600" : "text-emerald-600"
            }`}
          >
            Closes in {formatDuration(countdownMs)}
          </p>
        ) : !submission ? (
          <p className="text-xs font-medium text-rose-500">Quiz closed</p>
        ) : null}

        {submission ? (
          <div className="flex flex-col items-end gap-0.5">
            <p className="text-xs font-semibold text-slate-700">
              Marks: {submission.score}/{submission.totalQuestions}
              <span className="ml-1 font-normal text-slate-400">
                ({Math.round((submission.score / Math.max(1, submission.totalQuestions)) * 100)}%)
              </span>
            </p>
            <p className="text-[11px]">
              <span className="font-semibold text-emerald-600">{submission.score} correct</span>
              <span className="text-slate-300"> · </span>
              <span className="font-semibold text-rose-600">
                {Math.max(0, submission.totalQuestions - submission.score)} incorrect
              </span>
            </p>
            {maxAttempts !== null ? (
              <p className="text-[11px] text-slate-400">
                Attempt {submission.attemptCount}/{maxAttempts}
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="text-[11px] text-slate-400">
          {startDateTime.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} →{" "}
          {endDateTime.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
        </p>

        <div className="flex gap-1.5">
          {submission ? (
            <button
              type="button"
              onClick={() => void openReviewPanel()}
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
            >
              Review
            </button>
          ) : null}

          {canStart ? (
            <button
              type="button"
              onClick={() => void openAttemptPanel()}
              className="rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-800"
            >
              Start Quiz
            </button>
          ) : canRetake ? (
            <button
              type="button"
              onClick={() => void openAttemptPanel()}
              className="rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-800"
            >
              Retake
            </button>
          ) : !submission && currentPhase === "upcoming" ? (
            <span className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700">
              Not started yet
            </span>
          ) : attemptsExhausted ? (
            <span className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs text-slate-500">
              No attempts left
            </span>
          ) : null}
        </div>
      </div>

      {isOpen ? (
        <>
          <button
            type="button"
            onClick={closePanel}
            aria-label="Close quiz panel"
            className="fixed inset-0 z-40 bg-slate-900/35"
          />
          <aside className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl border-l border-brand-200 bg-white shadow-2xl">
            {panelMode === "review" ? (
              <div className="flex h-full flex-col">
                <div className="border-b border-brand-200 px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold text-slate-900">
                      {reviewDetail?.quiz.title ?? "Review Answers"}
                    </h2>
                    <button
                      type="button"
                      onClick={closePanel}
                      className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                    >
                      Close
                    </button>
                  </div>
                  {reviewDetail ? (
                    <p className="mt-0.5 text-sm font-medium text-brand-800">
                      Score: {reviewDetail.submission.score}/{reviewDetail.submission.totalQuestions} ·{" "}
                      {Math.round(
                        (reviewDetail.submission.score / reviewDetail.submission.totalQuestions) * 100
                      )}
                      %
                      {maxAttempts !== null ? (
                        <span className="ml-2 font-normal text-slate-500">
                          (Attempt {reviewDetail.submission.attemptCount}/{maxAttempts})
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                </div>

                <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
                  {isLoadingDetail ? <p className="text-sm text-slate-600">Loading review...</p> : null}

                  {errorMessage ? (
                    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                      {errorMessage}
                    </p>
                  ) : null}

                  {!isLoadingDetail && reviewDetail
                    ? reviewDetail.quiz.questions.map((question, index) => (
                        <section
                          key={question.id}
                          className={`rounded-xl border p-4 ${
                            question.isCorrect ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-semibold text-slate-900">
                              Q{index + 1}. {question.text}
                            </p>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                                question.isCorrect
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {question.isCorrect ? "Correct" : "Incorrect"}
                            </span>
                          </div>

                          <div className="mt-3 space-y-2">
                            {question.options.map((option) => {
                              const wasSelected = question.selectedOptionIds.includes(option.id);
                              const isCorrectOption = option.isCorrect;

                              let borderClass = "border-slate-200 bg-white";
                              if (isCorrectOption && wasSelected) {
                                borderClass = "border-emerald-500 bg-emerald-100";
                              } else if (isCorrectOption) {
                                borderClass = "border-emerald-400 bg-emerald-50";
                              } else if (wasSelected) {
                                borderClass = "border-red-400 bg-red-100";
                              }

                              return (
                                <div
                                  key={option.id}
                                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${borderClass}`}
                                >
                                  <span className="mt-0.5 shrink-0 text-base leading-none">
                                    {isCorrectOption && wasSelected ? "✓" : isCorrectOption ? "○" : wasSelected ? "✗" : "·"}
                                  </span>
                                  <span
                                    className={
                                      isCorrectOption
                                        ? "font-medium text-emerald-800"
                                        : wasSelected
                                        ? "text-red-700"
                                        : "text-slate-600"
                                    }
                                  >
                                    {option.text}
                                  </span>
                                  {isCorrectOption && !wasSelected ? (
                                    <span className="ml-auto shrink-0 text-xs font-medium text-emerald-600">
                                      Correct answer
                                    </span>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </section>
                      ))
                    : null}
                </div>

                <div className="flex justify-end gap-2 border-t border-brand-200 px-5 py-4">
                  <button
                    type="button"
                    onClick={closePanel}
                    className="rounded-lg border border-brand-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-brand-50"
                  >
                    Close
                  </button>
                  {canRetake ? (
                    <button
                      type="button"
                      onClick={() => void openAttemptPanel()}
                      className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800"
                    >
                      Retake Quiz
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex h-full flex-col">
                <div className="border-b border-brand-200 px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold text-slate-900">{detail?.quiz.title ?? "Quiz"}</h2>
                    <button
                      type="button"
                      onClick={closePanel}
                      className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                    >
                      Close
                    </button>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-500">Answer all questions and submit to update your marks.</p>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    {submission ? (
                      <p className="text-sm font-medium text-brand-800">
                        Latest marks: {submission.score}/{submission.totalQuestions}
                      </p>
                    ) : null}
                    {detail?.quiz.maxAttempts !== undefined && detail.quiz.maxAttempts !== null ? (
                      <p className="text-xs text-slate-500">
                        Attempt {(submission?.attemptCount ?? 0) + 1}/{detail.quiz.maxAttempts}
                      </p>
                    ) : null}
                    {detail ? (
                      <p
                        className={`text-xs font-medium tabular-nums ${
                          currentPhase === "open" ? "text-emerald-600" : "text-rose-600"
                        }`}
                      >
                        {currentPhase === "open"
                          ? `Closes in ${formatDuration(endMs - clock)}`
                          : "This quiz is closed."}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
                  {isLoadingDetail ? <p className="text-sm text-slate-600">Loading quiz...</p> : null}

                  {justSubmitted && submission ? (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center">
                      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl">
                        🎉
                      </div>
                      <p className="mt-2 text-sm font-semibold text-slate-900">Quiz submitted</p>
                      <p className="mt-1 text-3xl font-bold text-emerald-700">
                        {submission.score}
                        <span className="text-lg font-semibold text-emerald-500">
                          /{submission.totalQuestions}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500">
                        {Math.round((submission.score / Math.max(1, submission.totalQuestions)) * 100)}% score
                        {maxAttempts !== null ? ` · Attempt ${submission.attemptCount}/${maxAttempts}` : ""}
                      </p>

                      <div className="mt-3 flex justify-center gap-2">
                        <span className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700">
                          ✓ {submission.score} correct
                        </span>
                        <span className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700">
                          ✗ {Math.max(0, submission.totalQuestions - submission.score)} incorrect
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => void openReviewPanel()}
                        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        Review answers
                      </button>
                    </div>
                  ) : null}

                  {!isLoadingDetail && !justSubmitted && detail
                    ? detail.quiz.questions.map((question, index) => (
                        <section key={question.id} className="rounded-xl border border-brand-200 bg-slate-50 p-4">
                          <p className="text-sm font-semibold text-slate-900">
                            Q{index + 1}. {question.text}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {question.answerType === "SINGLE" ? "Choose one answer" : "Choose all that apply"}
                          </p>

                          <div className="mt-3 space-y-2">
                            {question.options.map((option) => {
                              const selected = (answers[question.id] ?? []).includes(option.id);
                              return (
                                <label
                                  key={option.id}
                                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                                    selected ? "border-brand-500 bg-brand-50" : "border-brand-200 bg-white"
                                  }`}
                                >
                                  <input
                                    type={question.answerType === "SINGLE" ? "radio" : "checkbox"}
                                    name={`question-${question.id}`}
                                    checked={selected}
                                    onChange={() => chooseOption(question.id, question.answerType, option.id)}
                                    className="mt-0.5"
                                  />
                                  <span>{option.text}</span>
                                </label>
                              );
                            })}
                          </div>
                        </section>
                      ))
                    : null}

                  {errorMessage ? (
                    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                      {errorMessage}
                    </p>
                  ) : null}
                </div>

                <div className="flex justify-end gap-2 border-t border-brand-200 px-5 py-4">
                  {justSubmitted ? (
                    <button
                      type="button"
                      onClick={closePanel}
                      className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800"
                    >
                      Done
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={closePanel}
                        disabled={isPending}
                        className="rounded-lg border border-brand-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-brand-50 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isPending || isLoadingDetail || !detail || currentPhase !== "open"}
                        className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
                      >
                        {isPending
                          ? "Submitting..."
                          : currentPhase !== "open"
                            ? "Quiz closed"
                            : submission
                              ? "Resubmit Quiz"
                              : "Submit Quiz"}
                      </button>
                    </>
                  )}
                </div>
              </form>
            )}
          </aside>
        </>
      ) : null}
    </>
  );
}

