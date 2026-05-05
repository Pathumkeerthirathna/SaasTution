"use client";

import { useEffect, useMemo, useState } from "react";

type QuizAnswerType = "SINGLE" | "MULTIPLE";

type QuizOption = {
  id?: string;
  text: string;
  isCorrect: boolean;
};

type QuizQuestion = {
  id?: string;
  text: string;
  answerType: QuizAnswerType;
  options: QuizOption[];
};

type LectureQuiz = {
  id: string;
  title: string;
  maxAttempts: number | null;
  dueDate: string | null;
  questions: Array<{
    id: string;
    text: string;
    orderIndex: number;
    answerType: QuizAnswerType;
    options: Array<{
      id: string;
      text: string;
      isCorrect: boolean;
      orderIndex: number;
    }>;
  }>;
};

type QuizDraft = {
  id?: string;
  title: string;
  maxAttempts: number | null;
  dueDate: string | null;
  questions: QuizQuestion[];
};

type QuizResultsData = {
  quiz: {
    id: string;
    title: string;
    maxAttempts: number | null;
    dueDate: string | null;
    totalQuestions: number;
  };
  stats: {
    totalEnrolled: number;
    totalSubmissions: number;
    averageScore: number | null;
  };
  submissions: {
    studentId: string;
    studentName: string;
    registrationNumber: string | null;
    score: number;
    totalQuestions: number;
    percentage: number;
    attemptCount: number;
    submittedAt: string;
  }[];
};

type ApiError = {
  error?: {
    message?: string;
  };
  message?: string;
};

function readApiError(payload: unknown, fallbackMessage: string) {
  if (!payload || typeof payload !== "object") {
    return fallbackMessage;
  }

  const typed = payload as ApiError;
  return typed.error?.message ?? typed.message ?? fallbackMessage;
}

function createEmptyQuestion(): QuizQuestion {
  return {
    text: "",
    answerType: "SINGLE",
    options: [
      { text: "", isCorrect: false },
      { text: "", isCorrect: false },
    ],
  };
}

function createEmptyDraft(): QuizDraft {
  return {
    title: "",
    maxAttempts: null,
    dueDate: null,
    questions: [createEmptyQuestion()],
  };
}

function toDraft(quiz: LectureQuiz): QuizDraft {
  return {
    id: quiz.id,
    title: quiz.title,
    maxAttempts: quiz.maxAttempts,
    dueDate: quiz.dueDate,
    questions: quiz.questions
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((question) => ({
        id: question.id,
        text: question.text,
        answerType: question.answerType,
        options: question.options
          .slice()
          .sort((left, right) => left.orderIndex - right.orderIndex)
          .map((option) => ({
            id: option.id,
            text: option.text,
            isCorrect: option.isCorrect,
          })),
      })),
  };
}

export function LectureQuizPanel(props: {
  lectureId: string;
  onChanged?: () => Promise<void> | void;
}) {
  const [quizzes, setQuizzes] = useState<LectureQuiz[]>([]);
  const [selectedQuizId, setSelectedQuizId] = useState<string | null>(null);
  const [draft, setDraft] = useState<QuizDraft>(createEmptyDraft);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [resultsQuizId, setResultsQuizId] = useState<string | null>(null);
  const [resultsData, setResultsData] = useState<QuizResultsData | null>(null);
  const [isLoadingResults, setIsLoadingResults] = useState(false);

  const selectedQuiz = useMemo(
    () => quizzes.find((item) => item.id === selectedQuizId) ?? null,
    [quizzes, selectedQuizId]
  );

  async function notifyChanged() {
    if (props.onChanged) {
      await props.onChanged();
    }
  }

  async function loadQuizzes(preferredQuizId?: string | null) {
    setIsLoading(true);

    try {
      const response = await fetch(`/api/lectures/${props.lectureId}/quizzes`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: LectureQuiz[];
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load quizzes."));
      }

      const list = payload.data ?? [];
      setQuizzes(list);

      const nextSelectedId =
        (preferredQuizId && list.some((quiz) => quiz.id === preferredQuizId) ? preferredQuizId : null) ??
        (selectedQuizId && list.some((quiz) => quiz.id === selectedQuizId) ? selectedQuizId : null) ??
        list[0]?.id ??
        null;

      setSelectedQuizId(nextSelectedId);

      if (nextSelectedId) {
        const nextQuiz = list.find((quiz) => quiz.id === nextSelectedId);
        if (nextQuiz) {
          setDraft(toDraft(nextQuiz));
        }
      } else {
        setDraft(createEmptyDraft());
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load quizzes.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadQuizzes(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.lectureId]);

  function selectExistingQuiz(quizId: string) {
    const quiz = quizzes.find((item) => item.id === quizId);
    if (!quiz) {
      return;
    }

    setSelectedQuizId(quizId);
    setDraft(toDraft(quiz));
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  function handleAddNewQuiz() {
    setSelectedQuizId(null);
    setDraft(createEmptyDraft());
    setErrorMessage(null);
    setSuccessMessage(null);
    setResultsQuizId(null);
    setResultsData(null);
  }

  async function openResults(quizId: string) {
    setResultsQuizId(quizId);
    setResultsData(null);
    setIsLoadingResults(true);

    try {
      const response = await fetch(`/api/lectures/${props.lectureId}/quizzes/${quizId}/results`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: QuizResultsData;
        error?: { message?: string };
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to load results."));
      }

      setResultsData(payload.data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load results.");
      setResultsQuizId(null);
    } finally {
      setIsLoadingResults(false);
    }
  }

  function updateQuestion(questionIndex: number, updater: (question: QuizQuestion) => QuizQuestion) {
    setDraft((prev) => ({
      ...prev,
      questions: prev.questions.map((question, index) => (index === questionIndex ? updater(question) : question)),
    }));
  }

  function updateOption(questionIndex: number, optionIndex: number, updater: (option: QuizOption) => QuizOption) {
    updateQuestion(questionIndex, (question) => ({
      ...question,
      options: question.options.map((option, index) => (index === optionIndex ? updater(option) : option)),
    }));
  }

  function toggleCorrectOption(questionIndex: number, optionIndex: number) {
    const answerType = draft.questions[questionIndex]?.answerType;

    if (!answerType) {
      return;
    }

    updateQuestion(questionIndex, (question) => {
      if (question.answerType === "SINGLE") {
        return {
          ...question,
          options: question.options.map((option, index) => ({
            ...option,
            isCorrect: index === optionIndex,
          })),
        };
      }

      return {
        ...question,
        options: question.options.map((option, index) =>
          index === optionIndex
            ? {
                ...option,
                isCorrect: !option.isCorrect,
              }
            : option
        ),
      };
    });
  }

  function addQuestion() {
    setDraft((prev) => ({
      ...prev,
      questions: [...prev.questions, createEmptyQuestion()],
    }));
  }

  function removeQuestion(questionIndex: number) {
    if (draft.questions.length <= 1) {
      setErrorMessage("Quiz must include at least one question.");
      return;
    }

    setDraft((prev) => ({
      ...prev,
      questions: prev.questions.filter((_, index) => index !== questionIndex),
    }));
  }

  function addOption(questionIndex: number) {
    updateQuestion(questionIndex, (question) => ({
      ...question,
      options: [...question.options, { text: "", isCorrect: false }],
    }));
  }

  function removeOption(questionIndex: number, optionIndex: number) {
    const optionCount = draft.questions[questionIndex]?.options.length ?? 0;

    if (optionCount <= 2) {
      setErrorMessage("Each question must have at least two answer options.");
      return;
    }

    updateQuestion(questionIndex, (question) => ({
      ...question,
      options: question.options.filter((_, index) => index !== optionIndex),
    }));
  }

  function validateDraft() {
    if (!draft.title.trim()) {
      return "Quiz title is required.";
    }

    if (draft.questions.length === 0) {
      return "Quiz must include at least one question.";
    }

    for (let questionIndex = 0; questionIndex < draft.questions.length; questionIndex += 1) {
      const question = draft.questions[questionIndex];
      if (!question.text.trim()) {
        return `Question ${questionIndex + 1} cannot be empty.`;
      }

      if (question.options.length < 2) {
        return `Question ${questionIndex + 1} must have at least two answers.`;
      }

      for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
        const option = question.options[optionIndex];
        if (!option.text.trim()) {
          return `Answer ${optionIndex + 1} in question ${questionIndex + 1} cannot be empty.`;
        }
      }

      const correctCount = question.options.filter((option) => option.isCorrect).length;
      if (correctCount === 0) {
        return `Question ${questionIndex + 1} must have at least one correct answer.`;
      }

      if (question.answerType === "SINGLE" && correctCount !== 1) {
        return `Question ${questionIndex + 1} is single-answer and must have exactly one correct answer.`;
      }
    }

    return null;
  }

  async function handleSaveQuiz() {
    const validationError = validateDraft();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const payload = {
        title: draft.title.trim(),
        maxAttempts: draft.maxAttempts,
        dueDate: draft.dueDate,
        questions: draft.questions.map((question) => ({
          id: question.id,
          text: question.text.trim(),
          answerType: question.answerType,
          options: question.options.map((option) => ({
            id: option.id,
            text: option.text.trim(),
            isCorrect: option.isCorrect,
          })),
        })),
      };

      const response = await fetch(
        selectedQuizId
          ? `/api/lectures/${props.lectureId}/quizzes/${selectedQuizId}`
          : `/api/lectures/${props.lectureId}/quizzes`,
        {
          method: selectedQuizId ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const result = (await response.json()) as {
        success: boolean;
        data?: {
          quiz: LectureQuiz;
        };
      };

      if (!response.ok || !result.success || !result.data?.quiz) {
        throw new Error(readApiError(result, "Failed to save quiz."));
      }

      await loadQuizzes(result.data.quiz.id);
      await notifyChanged();
      setSuccessMessage(selectedQuizId ? "Quiz updated successfully." : "Quiz created successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save quiz.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteQuiz(quizId: string) {
    const quiz = quizzes.find((item) => item.id === quizId);
    if (!quiz) {
      return;
    }

    const confirmed = window.confirm(`Delete quiz "${quiz.title}"?`);
    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/lectures/${props.lectureId}/quizzes/${quizId}`, {
        method: "DELETE",
      });
      const result = (await response.json()) as { success: boolean };

      if (!response.ok || !result.success) {
        throw new Error(readApiError(result, "Failed to delete quiz."));
      }

      const fallbackQuizId = selectedQuizId === quizId ? null : selectedQuizId;
      await loadQuizzes(fallbackQuizId);
      await notifyChanged();
      setSuccessMessage("Quiz deleted successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete quiz.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-black/10 p-4 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Quizzes</p>
        <button
          type="button"
          onClick={handleAddNewQuiz}
          className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background"
        >
          Add new quiz
        </button>
      </div>

      {errorMessage ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{errorMessage}</p>
      ) : null}

      {successMessage ? (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {successMessage}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_0.9fr]">
        <section className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <label className="text-xs font-semibold text-muted">Quiz title</label>
          <input
            value={draft.title}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                title: event.target.value,
              }))
            }
            placeholder="Quiz title"
            className="mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
          />

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-muted">Max attempts (optional)</label>
              <input
                type="number"
                min={1}
                max={100}
                value={draft.maxAttempts ?? ""}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    maxAttempts: event.target.value ? Number(event.target.value) : null,
                  }))
                }
                placeholder="Unlimited"
                className="mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted">Due date (optional)</label>
              <input
                type="datetime-local"
                value={
                  draft.dueDate
                    ? new Date(draft.dueDate).toISOString().slice(0, 16)
                    : ""
                }
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    dueDate: event.target.value ? new Date(event.target.value).toISOString() : null,
                  }))
                }
                className="mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
              />
            </div>
          </div>

          <div className="mt-4 space-y-4">
            {draft.questions.map((question, questionIndex) => (
              <article key={question.id ?? `new-${questionIndex}`} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">Question {questionIndex + 1}</p>
                  <button
                    type="button"
                    onClick={() => removeQuestion(questionIndex)}
                    className="rounded-lg border border-red-300 px-2.5 py-1 text-xs font-semibold text-red-700"
                  >
                    Remove question
                  </button>
                </div>

                <textarea
                  value={question.text}
                  onChange={(event) =>
                    updateQuestion(questionIndex, (current) => ({
                      ...current,
                      text: event.target.value,
                    }))
                  }
                  rows={2}
                  placeholder="Enter question text"
                  className="mt-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                />

                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-muted">Answer type:</span>
                  <button
                    type="button"
                    onClick={() =>
                      updateQuestion(questionIndex, (current) => {
                        const correctedOptions = current.options.map((option, index) => ({
                          ...option,
                          isCorrect: index === 0 ? option.isCorrect : false,
                        }));

                        const hasCorrect = correctedOptions.some((option) => option.isCorrect);

                        return {
                          ...current,
                          answerType: "SINGLE",
                          options: hasCorrect
                            ? correctedOptions
                            : correctedOptions.map((option, index) => ({
                                ...option,
                                isCorrect: index === 0,
                              })),
                        };
                      })
                    }
                    className={`rounded-lg border px-2.5 py-1 font-semibold ${
                      question.answerType === "SINGLE"
                        ? "border-foreground bg-foreground text-background"
                        : "border-black/15 dark:border-white/20"
                    }`}
                  >
                    Single (radio)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateQuestion(questionIndex, (current) => ({
                        ...current,
                        answerType: "MULTIPLE",
                      }))
                    }
                    className={`rounded-lg border px-2.5 py-1 font-semibold ${
                      question.answerType === "MULTIPLE"
                        ? "border-foreground bg-foreground text-background"
                        : "border-black/15 dark:border-white/20"
                    }`}
                  >
                    Multiple (checkbox)
                  </button>
                </div>

                <div className="mt-3 space-y-2">
                  {question.options.map((option, optionIndex) => (
                    <div key={option.id ?? `option-${optionIndex}`} className="flex items-center gap-2">
                      {question.answerType === "SINGLE" ? (
                        <input
                          type="radio"
                          checked={option.isCorrect}
                          onChange={() => toggleCorrectOption(questionIndex, optionIndex)}
                          aria-label={`Question ${questionIndex + 1} option ${optionIndex + 1} single answer selector`}
                        />
                      ) : (
                        <input
                          type="checkbox"
                          checked={option.isCorrect}
                          onChange={() => toggleCorrectOption(questionIndex, optionIndex)}
                          aria-label={`Question ${questionIndex + 1} option ${optionIndex + 1} multiple answer selector`}
                        />
                      )}

                      <input
                        value={option.text}
                        onChange={(event) =>
                          updateOption(questionIndex, optionIndex, (current) => ({
                            ...current,
                            text: event.target.value,
                          }))
                        }
                        placeholder={`Answer ${optionIndex + 1}`}
                        className="flex-1 rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                      />

                      <button
                        type="button"
                        onClick={() => removeOption(questionIndex, optionIndex)}
                        className="rounded-lg border border-red-300 px-2.5 py-1 text-xs font-semibold text-red-700"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => addOption(questionIndex)}
                  className="mt-3 rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
                >
                  Add answer
                </button>
              </article>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={addQuestion}
              className="rounded-lg border border-black/15 px-3 py-2 text-xs font-semibold dark:border-white/20"
            >
              Add question
            </button>
            <button
              type="button"
              onClick={() => void handleSaveQuiz()}
              disabled={isSaving}
              className="rounded-lg bg-foreground px-3 py-2 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? "Saving..." : selectedQuiz ? "Save quiz" : "Create quiz"}
            </button>
          </div>
        </section>

        <aside className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <p className="text-sm font-semibold">Existing quizzes</p>
          {isLoading ? <p className="mt-2 text-xs text-muted">Loading quizzes...</p> : null}
          {!isLoading && quizzes.length === 0 ? <p className="mt-2 text-xs text-muted">No quizzes added yet.</p> : null}

          <div className="mt-3 space-y-2">
            {quizzes.map((quiz) => (
              <div
                key={quiz.id}
                className={`rounded-lg border px-3 py-2 ${
                  selectedQuizId === quiz.id
                    ? "border-foreground bg-black/[0.03] dark:bg-white/[0.04]"
                    : "border-black/10 dark:border-white/10"
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectExistingQuiz(quiz.id)}
                  className="w-full text-left"
                >
                  <p className="text-sm font-semibold">{quiz.title}</p>
                  <p className="text-xs text-muted">{quiz.questions.length} question(s)</p>
                  {quiz.maxAttempts !== null ? (
                    <p className="text-xs text-muted">Max {quiz.maxAttempts} attempt(s)</p>
                  ) : null}
                  {quiz.dueDate ? (
                    <p className="text-xs text-muted">Due {new Date(quiz.dueDate).toLocaleDateString()}</p>
                  ) : null}
                </button>

                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void openResults(quiz.id)}
                    className="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold dark:border-white/20"
                  >
                    View results
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteQuiz(quiz.id)}
                    className="rounded-lg border border-red-300 px-2.5 py-1 text-xs font-semibold text-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {resultsQuizId ? (
        <div className="mt-4 rounded-xl border border-black/10 p-4 dark:border-white/10">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Quiz Results</p>
              {resultsData ? (
                <h3 className="mt-0.5 text-sm font-semibold">{resultsData.quiz.title}</h3>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                setResultsQuizId(null);
                setResultsData(null);
              }}
              className="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold dark:border-white/20"
            >
              Close results
            </button>
          </div>

          {isLoadingResults ? (
            <p className="mt-3 text-xs text-muted">Loading results...</p>
          ) : resultsData ? (
            <>
              <div className="mt-3 flex flex-wrap gap-4">
                <div className="rounded-lg border border-black/10 px-4 py-2.5 dark:border-white/10">
                  <p className="text-xs text-muted">Submissions</p>
                  <p className="mt-0.5 text-lg font-semibold">
                    {resultsData.stats.totalSubmissions}
                    <span className="ml-1 text-sm font-normal text-muted">
                      / {resultsData.stats.totalEnrolled} enrolled
                    </span>
                  </p>
                </div>
                <div className="rounded-lg border border-black/10 px-4 py-2.5 dark:border-white/10">
                  <p className="text-xs text-muted">Average score</p>
                  <p className="mt-0.5 text-lg font-semibold">
                    {resultsData.stats.averageScore !== null
                      ? `${resultsData.stats.averageScore} / ${resultsData.quiz.totalQuestions}`
                      : "—"}
                  </p>
                </div>
                {resultsData.quiz.maxAttempts !== null ? (
                  <div className="rounded-lg border border-black/10 px-4 py-2.5 dark:border-white/10">
                    <p className="text-xs text-muted">Max attempts</p>
                    <p className="mt-0.5 text-lg font-semibold">{resultsData.quiz.maxAttempts}</p>
                  </div>
                ) : null}
                {resultsData.quiz.dueDate ? (
                  <div className="rounded-lg border border-black/10 px-4 py-2.5 dark:border-white/10">
                    <p className="text-xs text-muted">Due</p>
                    <p className="mt-0.5 text-sm font-semibold">
                      {new Date(resultsData.quiz.dueDate).toLocaleDateString()}
                    </p>
                  </div>
                ) : null}
              </div>

              {resultsData.submissions.length === 0 ? (
                <p className="mt-3 text-xs text-muted">No submissions yet.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[500px] text-sm">
                    <thead>
                      <tr className="border-b border-black/10 text-left text-xs font-semibold text-muted dark:border-white/10">
                        <th className="pb-2 pr-4">Student</th>
                        <th className="pb-2 pr-4">Score</th>
                        <th className="pb-2 pr-4">%</th>
                        <th className="pb-2 pr-4">Attempts</th>
                        <th className="pb-2">Submitted</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/5 dark:divide-white/5">
                      {resultsData.submissions.map((sub) => (
                        <tr key={sub.studentId}>
                          <td className="py-2 pr-4">
                            <p className="font-medium">{sub.studentName}</p>
                            {sub.registrationNumber ? (
                              <p className="text-xs text-muted">{sub.registrationNumber}</p>
                            ) : null}
                          </td>
                          <td className="py-2 pr-4">
                            {sub.score}/{sub.totalQuestions}
                          </td>
                          <td className="py-2 pr-4">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                sub.percentage >= 80
                                  ? "bg-emerald-100 text-emerald-700"
                                  : sub.percentage >= 50
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {sub.percentage}%
                            </span>
                          </td>
                          <td className="py-2 pr-4">{sub.attemptCount}</td>
                          <td className="py-2 text-xs text-muted">
                            {new Date(sub.submittedAt).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
