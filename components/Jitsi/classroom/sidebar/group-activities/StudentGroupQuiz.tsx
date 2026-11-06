"use client";

// Student: one group quiz. One shared attempt for the whole group: any member
// starts it (one deadline for everyone), every member sees and changes the
// same answers (each change saves only that question, so members can answer
// different questions at the same time), and any member submits the group's
// final answers. After submitting: the score; once the teacher closes the
// quiz: the review.

import { useCallback, useEffect, useRef, useState } from "react";

import { formatTime, groupApi, groupUrls, jsonInit } from "./api";
import { useGroupResource } from "./hooks";
import type { StudentQuestion, StudentQuizView } from "./types";

const SHORT_SAVE_DELAY_MS = 1200;

// Answers use the existing stored shape: { kind: "single", optionId },
// { kind: "multiple", optionIds }, { kind: "true_false", value }, { kind: "short", text }.
type Answer =
  | { kind: "single"; optionId: string | null }
  | { kind: "multiple"; optionIds: string[] }
  | { kind: "true_false"; value: boolean | null }
  | { kind: "short"; text: string };

function asAnswer(value: unknown): Partial<Answer> & Record<string, unknown> {
  return value && typeof value === "object" ? (value as Partial<Answer> & Record<string, unknown>) : {};
}

function isAnswered(value: unknown) {
  const a = asAnswer(value);
  if (a.kind === "single") return typeof a.optionId === "string" && a.optionId !== "";
  if (a.kind === "multiple") return Array.isArray(a.optionIds) && a.optionIds.length > 0;
  if (a.kind === "true_false") return typeof a.value === "boolean";
  if (a.kind === "short") return typeof a.text === "string" && a.text.trim() !== "";
  return false;
}

export default function StudentGroupQuiz({ sessionId, quizId, onBack }: { sessionId: string; quizId: string; onBack: () => void }) {
  const urls = groupUrls(sessionId);
  const resource = useGroupResource<StudentQuizView>(urls.myQuiz(quizId), (d) => d.activityId === quizId || d.kind === "members");
  const [pending, setPending] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timers = useRef<Record<string, number>>({});

  useEffect(() => {
    const current = timers.current;
    return () => Object.values(current).forEach((t) => window.clearTimeout(t));
  }, []);

  const view = resource.data;

  const apply = useCallback(
    (result: Awaited<ReturnType<typeof groupApi<StudentQuizView>>>) => {
      if (result.ok) {
        resource.setData(result.data);
        return true;
      }
      if (result.code === "QUIZ_TIME_UP" || result.code === "QUIZ_CLOSED" || result.code === "QUIZ_ALREADY_SUBMITTED") {
        setStatus(result.message);
        void resource.reload();
        return false;
      }
      setStatus(result.message);
      return false;
    },
    [resource]
  );

  const saveAnswer = useCallback(
    async (questionId: string, value: unknown) => {
      setStatus("Saving…");
      const result = await groupApi<StudentQuizView>(urls.myAttempt(quizId), jsonInit("PATCH", { answers: { [questionId]: value } }));
      setPending((p) => {
        const next = { ...p };
        if (next[questionId] === value) delete next[questionId];
        return next;
      });
      if (apply(result)) setStatus("Saved.");
    },
    [apply, quizId, urls]
  );

  const change = (question: StudentQuestion, value: unknown) => {
    setPending((p) => ({ ...p, [question.id]: value }));
    if (timers.current[question.id]) window.clearTimeout(timers.current[question.id]);
    if (question.kind === "short") {
      timers.current[question.id] = window.setTimeout(() => void saveAnswer(question.id, value), SHORT_SAVE_DELAY_MS);
    } else {
      void saveAnswer(question.id, value);
    }
  };

  if (resource.loading && !view) return <p className="text-xs text-slate-500">Loading…</p>;
  if (!view) {
    return (
      <div className="space-y-2">
        <button type="button" className="text-xs text-blue-700 hover:underline" onClick={onBack}>
          ← Back
        </button>
        <p className="text-xs text-red-600">{resource.error && !resource.error.ok ? resource.error.message : "Not available."}</p>
      </div>
    );
  }

  const start = async () => {
    setBusy(true);
    const result = await groupApi<StudentQuizView>(urls.myAttempt(quizId), { method: "POST" });
    setBusy(false);
    apply(result);
  };

  const submit = async () => {
    if (view.attempt.attemptStatus !== "IN_PROGRESS") return;
    if (Object.keys(pending).length > 0) {
      setStatus("Still saving the latest answers. Try again in a moment.");
      return;
    }
    if (!window.confirm("Submit your group's answers? Nobody in the group can change them after this.")) return;
    setBusy(true);
    const result = await groupApi<StudentQuizView & { replayed: boolean }>(urls.mySubmit(quizId), jsonInit("POST", { revision: view.attempt.revision }));
    setBusy(false);
    if (!result.ok && result.code === "REVISION_CONFLICT") {
      setStatus("Someone changed an answer just now. Check the answers, then submit again.");
      void resource.reload();
      return;
    }
    if (apply(result)) setStatus("Submitted.");
  };

  const attempt = view.attempt;
  const questions = view.quiz.questions ?? [];
  const members = view.group.members.map((m) => m?.name).join(", ");

  return (
    <div className="space-y-2 text-slate-900">
      <button type="button" className="text-xs text-blue-700 hover:underline" onClick={onBack}>
        ← Back
      </button>
      <h4 className="break-words text-sm font-semibold">{view.quiz.title}</h4>
      {view.quiz.instructions ? <p className="whitespace-pre-wrap break-words text-xs text-slate-700">{view.quiz.instructions}</p> : null}
      <p className="break-words text-xs text-slate-600">Group: {members}</p>

      {attempt.attemptStatus === null ? (
        <div className="space-y-2 rounded-md border border-slate-200 p-2 text-xs text-slate-700">
          <p>
            {view.quiz.questionCount ?? 0} questions · {view.quiz.totalMarks ?? "—"} marks
            {view.quiz.timeLimitSeconds ? ` · ${Math.round(view.quiz.timeLimitSeconds / 60)} minutes for the whole group` : ""}
          </p>
          {view.quiz.state === "PUBLISHED" ? (
            <button type="button" disabled={busy} className="rounded-md bg-emerald-700 px-3 py-1.5 font-semibold text-white hover:bg-emerald-800 disabled:opacity-50" onClick={() => void start()}>
              Start the group quiz
            </button>
          ) : (
            <p>This quiz is closed.</p>
          )}
        </div>
      ) : attempt.attemptStatus === "IN_PROGRESS" ? (
        <>
          <p className="break-words text-[11px] text-slate-500">
            {view.progress ? `${view.progress.answered} / ${view.progress.questions} answered` : ""}
            {attempt.deadlineAt ? ` · ends ${formatTime(attempt.deadlineAt)}` : ""}
            {view.activity?.lastSavedBy ? ` · last change ${view.activity.lastSavedBy.name} ${formatTime(view.activity.lastSavedAt)}` : ""}
            {status ? ` · ${status}` : ""}
          </p>
          <ol className="space-y-2">
            {questions.map((q, index) => {
              const value = Object.prototype.hasOwnProperty.call(pending, q.id) ? pending[q.id] : attempt.answers?.[q.id];
              return (
                <li key={q.id} className={`rounded-md border p-2 ${isAnswered(value) ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200"}`}>
                  <p className="mb-1 break-words text-sm font-medium">
                    {index + 1}. {q.prompt} <span className="text-xs text-slate-500">({q.marks})</span>
                  </p>
                  <QuestionInput question={q} value={value} onChange={(v) => change(q, v)} />
                </li>
              );
            })}
          </ol>
          <button type="button" disabled={busy} className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50" onClick={() => void submit()}>
            Submit group answers
          </button>
        </>
      ) : (
        <div className="space-y-2 rounded-md bg-emerald-50 p-2 text-xs text-emerald-900">
          <p>
            {attempt.attemptStatus === "AUTO_SUBMITTED" ? "Submitted automatically" : `Submitted by ${view.activity?.submittedBy?.name ?? "—"}`} at{" "}
            {formatTime(attempt.submittedAt)} · score {attempt.finalScore ?? "—"} / {attempt.totalMarks ?? "—"}
          </p>
          {attempt.review ? (
            <ol className="space-y-1.5 text-slate-800">
              {attempt.review.map((item, index) => (
                <li key={item.id} className="rounded border border-emerald-100 bg-white p-1.5">
                  <p className="break-words font-medium">
                    {index + 1}. {item.prompt}
                  </p>
                  <p>
                    {item.result} · {item.awarded} / {item.marks}
                    {item.note ? ` · ${item.note}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-emerald-800">Answers and corrections appear when your teacher closes the quiz.</p>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionInput({ question, value, onChange }: { question: StudentQuestion; value: unknown; onChange: (value: Answer) => void }) {
  const answer = asAnswer(value);
  if (question.kind === "single") {
    return (
      <div className="space-y-1">
        {question.options?.map((o) => (
          <label key={o.id} className="flex items-start gap-2 text-sm">
            <input type="radio" className="mt-1" name={`q-${question.id}`} checked={answer.optionId === o.id} onChange={() => onChange({ kind: "single", optionId: o.id })} />
            <span className="break-words">{o.text}</span>
          </label>
        ))}
      </div>
    );
  }
  if (question.kind === "multiple") {
    const selected = Array.isArray(answer.optionIds) ? (answer.optionIds as string[]) : [];
    return (
      <div className="space-y-1">
        {question.options?.map((o) => (
          <label key={o.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.includes(o.id)}
              onChange={(e) => onChange({ kind: "multiple", optionIds: e.target.checked ? [...selected, o.id] : selected.filter((id) => id !== o.id) })}
            />
            <span className="break-words">{o.text}</span>
          </label>
        ))}
      </div>
    );
  }
  if (question.kind === "true_false") {
    return (
      <div className="flex gap-4 text-sm">
        {[true, false].map((option) => (
          <label key={String(option)} className="flex items-center gap-1">
            <input type="radio" name={`q-${question.id}`} checked={answer.value === option} onChange={() => onChange({ kind: "true_false", value: option })} />
            {option ? "True" : "False"}
          </label>
        ))}
      </div>
    );
  }
  return (
    <input
      aria-label="Answer"
      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      value={typeof answer.text === "string" ? answer.text : ""}
      onChange={(e) => onChange({ kind: "short", text: e.target.value })}
    />
  );
}
