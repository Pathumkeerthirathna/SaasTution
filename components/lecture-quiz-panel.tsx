"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Calendar,
  Eye,
  FileText,
  MoreVertical,
  Plus,
  Save,
  Trash2,
  Users,
  X,
} from "lucide-react";

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
  const [isFormOpen, setIsFormOpen] = useState(false);
  // const [isExpandedList, setIsExpandedList] = useState(false);

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

  function openCreateForm() {
    handleAddNewQuiz();
    setIsFormOpen(true);
  }

  function openEditForm(quizId: string) {
    selectExistingQuiz(quizId);
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
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
      setIsFormOpen(false);
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
      setIsFormOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete quiz.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {errorMessage && !isFormOpen ? <p className="notice-error text-xs">{errorMessage}</p> : null}
      {successMessage ? <p className="notice-success text-xs">{successMessage}</p> : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
              <Users size={15} />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-slate-900">Existing quizzes</h4>
              <p className="text-[11px] text-muted">Manage previously created quizzes.</p>
            </div>
          </div>

          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{quizzes.length} total</span>
        </div>

        <div className="mt-3.5 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold text-slate-700">Add / organize quizzes</p>
          <button
            type="button"
            onClick={openCreateForm}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-brand-700 px-2.5 text-[11px] font-semibold text-white transition hover:bg-brand-600"
          >
            <Plus size={11} />
            Add new quiz
          </button>
        </div>

        {isLoading ? <p className="mt-3 text-xs text-muted">Loading quizzes...</p> : null}
        {!isLoading && quizzes.length === 0 ? <p className="mt-3 text-xs text-muted">No quizzes added yet.</p> : null}

        <div className="mt-3 max-h-[420px] space-y-2 overflow-y-auto scrollbar-thin pr-1">
          {quizzes.map((quiz) => (
            <div
              key={quiz.id}
              className={`rounded-lg border p-3 transition ${
                selectedQuizId === quiz.id && isFormOpen ? "border-brand-300 bg-brand-50/70" : "border-slate-200 bg-white"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                  <FileText size={16} />
                </span>

                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => openEditForm(quiz.id)} className="block w-full text-left">
                    <p className="truncate text-xs font-semibold text-slate-900">{quiz.title}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{quiz.questions.length} question(s)</p>
                    {quiz.maxAttempts !== null ? (
                      <p className="mt-0.5 text-[11px] text-slate-500">Max {quiz.maxAttempts} attempt(s)</p>
                    ) : null}
                    {quiz.dueDate ? (
                      <p className="mt-0.5 text-[10px] text-muted">Due {new Date(quiz.dueDate).toLocaleDateString()}</p>
                    ) : null}
                  </button>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void openResults(quiz.id)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      <Eye size={11} />
                      View results
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteQuiz(quiz.id)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-200 px-2 text-[11px] font-medium text-rose-600 transition hover:bg-rose-50"
                    >
                      <Trash2 size={11} />
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditForm(quiz.id)}
                      className="inline-flex h-7 items-center justify-center rounded-md border border-slate-200 px-1.5 text-slate-500 transition hover:bg-slate-50"
                    >
                      <MoreVertical size={11} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {isFormOpen ? (
        <>
          <div className="fixed inset-0 z-[70] bg-black/40" onClick={closeForm} aria-hidden />
          <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
            <div
              className="flex max-h-[85vh] w-full flex-col rounded-xl border border-slate-200 bg-white shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 p-4">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                    <Plus size={15} />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">{selectedQuiz ? "Edit quiz" : "Add new quiz"}</h4>
                    <p className="text-[11px] text-muted">Build questions and set quiz details.</p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={closeForm}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50"
                >
                  <X size={13} />
                </button>
              </div>

              <div className="overflow-y-auto scrollbar-thin p-4">
                {errorMessage ? <p className="notice-error mb-3 text-xs">{errorMessage}</p> : null}

                <div className="space-y-3">
                  <div>
                    <label className="form-label mb-1 block">Quiz title *</label>
                    <div className="relative">
                      <input
                        value={draft.title}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            title: event.target.value,
                          }))
                        }
                        placeholder="Quiz title"
                        className="control-input h-9 pr-12 text-sm"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-muted">
                        {draft.title.length}/120
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="form-label mb-1 block">Max attempts (optional)</label>
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
                        className="control-input h-9 text-sm"
                      />
                    </div>

                    <div>
                      <label className="form-label mb-1 block">Due date (optional)</label>
                      <div className="relative">
                        <Calendar size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                          type="datetime-local"
                          value={draft.dueDate ? new Date(draft.dueDate).toISOString().slice(0, 16) : ""}
                          onChange={(event) =>
                            setDraft((prev) => ({
                              ...prev,
                              dueDate: event.target.value ? new Date(event.target.value).toISOString() : null,
                            }))
                          }
                          className="control-input h-9 pl-8 text-sm"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {draft.questions.map((question, questionIndex) => (
                      <article key={question.id ?? `new-${questionIndex}`} className="rounded-xl border border-slate-200 bg-white p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                          <div className="flex items-center gap-2.5">
                            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                              {questionIndex + 1}
                            </span>
                            <div>
                              <p className="text-xs font-semibold text-slate-900">Question {questionIndex + 1}</p>
                              <p className="text-[11px] text-muted">Build the prompt and answer options.</p>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => removeQuestion(questionIndex)}
                            className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 text-[11px] font-medium text-rose-600 transition hover:bg-rose-100"
                          >
                            <Trash2 size={11} />
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
                          className="control-textarea mt-2.5 text-sm"
                        />

                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="font-semibold text-slate-500">Answer type</span>
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
                            className={`rounded-full border px-2.5 py-1 font-semibold ${
                              question.answerType === "SINGLE"
                                ? "border-brand-700 bg-brand-700 text-white"
                                : "border-slate-200 bg-white text-slate-700"
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
                            className={`rounded-full border px-2.5 py-1 font-semibold ${
                              question.answerType === "MULTIPLE"
                                ? "border-brand-700 bg-brand-700 text-white"
                                : "border-slate-200 bg-white text-slate-700"
                            }`}
                          >
                            Multiple (checkbox)
                          </button>
                        </div>

                        <div className="mt-2.5 space-y-2">
                          {question.options.map((option, optionIndex) => (
                            <div key={option.id ?? `option-${optionIndex}`} className="flex items-center gap-2">
                              {question.answerType === "SINGLE" ? (
                                <input
                                  type="radio"
                                  checked={option.isCorrect}
                                  onChange={() => toggleCorrectOption(questionIndex, optionIndex)}
                                  aria-label={`Question ${questionIndex + 1} option ${optionIndex + 1} single answer selector`}
                                  className="h-3.5 w-3.5 accent-brand-700"
                                />
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={option.isCorrect}
                                  onChange={() => toggleCorrectOption(questionIndex, optionIndex)}
                                  aria-label={`Question ${questionIndex + 1} option ${optionIndex + 1} multiple answer selector`}
                                  className="h-3.5 w-3.5 accent-brand-700"
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
                                className="control-input h-8 flex-1 text-sm"
                              />

                              <button
                                type="button"
                                onClick={() => removeOption(questionIndex, optionIndex)}
                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-rose-200 text-rose-600 transition hover:bg-rose-50"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ))}
                        </div>

                        <button
                          type="button"
                          onClick={() => addOption(questionIndex)}
                          className="mt-2.5 inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
                        >
                          <Plus size={11} />
                          Add answer
                        </button>
                      </article>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={addQuestion}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                    >
                      <Plus size={13} />
                      Add question
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveQuiz()}
                      disabled={isSaving}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 text-xs font-semibold text-white shadow-soft transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Save size={13} />
                      {isSaving ? "Saving..." : selectedQuiz ? "Save quiz" : "Create quiz"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {resultsQuizId ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
            <div>
              <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-700">
                <Eye size={11} />
                Quiz results
              </p>
              {resultsData ? <h3 className="mt-0.5 text-sm font-semibold text-slate-900">{resultsData.quiz.title}</h3> : null}
              {resultsData ? (
                <p className="mt-1 text-[11px] text-slate-600">
                  {resultsData.stats.totalSubmissions}/{resultsData.stats.totalEnrolled} submissions • Average score:{" "}
                  {resultsData.stats.averageScore !== null ? `${resultsData.stats.averageScore} / ${resultsData.quiz.totalQuestions}` : "—"}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => {
                setResultsQuizId(null);
                setResultsData(null);
              }}
              className="btn-secondary shrink-0"
            >
              <X size={12} />
              Close results
            </button>
          </div>

          <div className="px-4 py-4">
            {isLoadingResults ? (
              <p className="text-xs text-muted">Loading results...</p>
            ) : resultsData ? (
              <>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Submissions</p>
                    <p className="mt-1 text-base font-semibold text-slate-900">
                      {resultsData.stats.totalSubmissions}
                      <span className="ml-1.5 text-[11px] font-normal text-muted">/ {resultsData.stats.totalEnrolled}</span>
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Average score</p>
                    <p className="mt-1 text-base font-semibold text-slate-900">
                      {resultsData.stats.averageScore !== null
                        ? `${resultsData.stats.averageScore} / ${resultsData.quiz.totalQuestions}`
                        : "—"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Max attempts</p>
                    <p className="mt-1 text-base font-semibold text-slate-900">{resultsData.quiz.maxAttempts ?? "Unlimited"}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Due</p>
                    <p className="mt-1 text-xs font-semibold text-slate-900">
                      {resultsData.quiz.dueDate ? new Date(resultsData.quiz.dueDate).toLocaleDateString() : "No due date"}
                    </p>
                  </div>
                </div>

                {resultsData.submissions.length === 0 ? (
                  <p className="mt-3 text-xs text-muted">No submissions yet.</p>
                ) : (
                  <div className="mt-3 overflow-x-auto scrollbar-thin rounded-lg border border-slate-200 bg-white">
                    <table className="min-w-[680px] w-full text-xs">
                      <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">
                        <tr>
                          <th className="px-3 py-2 text-left">Student</th>
                          <th className="px-3 py-2 text-left">Score</th>
                          <th className="px-3 py-2 text-left">%</th>
                          <th className="px-3 py-2 text-left">Attempts</th>
                          <th className="px-3 py-2 text-left">Submitted</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {resultsData.submissions.map((sub) => (
                          <tr key={sub.studentId} className="align-top">
                            <td className="px-3 py-2.5">
                              <p className="font-semibold text-slate-900">{sub.studentName}</p>
                              {sub.registrationNumber ? <p className="mt-0.5 text-[10px] text-muted">{sub.registrationNumber}</p> : null}
                            </td>
                            <td className="px-3 py-2.5 text-slate-700">
                              {sub.score}/{sub.totalQuestions}
                            </td>
                            <td className="px-3 py-2.5">
                              <span
                                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                  sub.percentage >= 80
                                    ? "bg-emerald-100 text-emerald-700"
                                    : sub.percentage >= 50
                                    ? "bg-amber-100 text-amber-700"
                                    : "bg-rose-100 text-rose-700"
                                }`}
                              >
                                {sub.percentage}%
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-slate-700">{sub.attemptCount}</td>
                            <td className="px-3 py-2.5 text-slate-600">{new Date(sub.submittedAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
