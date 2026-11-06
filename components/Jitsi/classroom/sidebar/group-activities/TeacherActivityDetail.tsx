"use client";

// Teacher: one group activity in detail. Assignment: the shared work, the
// latest editor and the final submission (with its PDF). Quiz: the shared
// answers per question, the grading and the result, with the existing
// per-question mark override.

import { useState } from "react";

import { formatTime, groupApi, groupUrls, jsonInit, type Person } from "./api";
import { useGroupResource } from "./hooks";
import type { GroupWork } from "./types";

type TeacherQuestion = {
  id: string;
  kind: "single" | "multiple" | "true_false" | "short";
  prompt: string;
  marks: number;
  options?: { id: string; text: string }[];
  correctOptionId?: string;
  correctOptionIds?: string[];
  correct?: boolean;
  acceptedAnswers?: string[];
};

type TeacherQuizDetail = {
  quiz: { id: string; title: string; state: string; totalMarks: number | null; questions: { questions: TeacherQuestion[] } };
  members: Person[];
  attempt: {
    attemptStatus: "IN_PROGRESS" | "SUBMITTED" | "AUTO_SUBMITTED";
    answers: Record<string, unknown>;
    grading: { questions: Record<string, { auto: number; result: string; override?: { marks: number; note?: string } }> } | null;
    autoScore: number | null;
    finalScore: number | null;
    startedBy: Person | null;
    lastSavedBy: Person | null;
    submittedAt: string | null;
    submittedBy: Person | null;
    members: Person[];
  } | null;
  progress: { answered: number; questions: number } | null;
};

type TeacherAssignmentDetail = { assignment: { id: string; title: string; instructions: string }; members: Person[]; work: GroupWork };

/** A stored answer ({ kind, optionId | optionIds | value | text }) as text. */
function answerText(question: TeacherQuestion, value: unknown): string {
  const a = (value && typeof value === "object" ? value : {}) as { kind?: string; optionId?: unknown; optionIds?: unknown; value?: unknown; text?: unknown };
  if (a.kind !== question.kind) return "No answer";
  if (a.kind === "true_false") return typeof a.value === "boolean" ? (a.value ? "True" : "False") : "No answer";
  if (a.kind === "short") return typeof a.text === "string" && a.text.trim() !== "" ? a.text : "No answer";
  const ids = a.kind === "single" ? (typeof a.optionId === "string" ? [a.optionId] : []) : Array.isArray(a.optionIds) ? a.optionIds : [];
  if (ids.length === 0) return "No answer";
  return ids.map((id) => question.options?.find((o) => o.id === id)?.text ?? "?").join(", ");
}

function correctText(question: TeacherQuestion): string {
  if (question.kind === "true_false") return question.correct ? "True" : "False";
  if (question.kind === "short") return (question.acceptedAnswers ?? []).join(" / ");
  const ids = question.kind === "single" ? [question.correctOptionId] : question.correctOptionIds ?? [];
  return ids.map((id) => question.options?.find((o) => o.id === id)?.text ?? "?").join(", ");
}

const names = (people: Person[]) => (people.length ? people.map((p) => p.name).join(", ") : "None");

export default function TeacherActivityDetail({ sessionId, kind, id }: { sessionId: string; kind: "assignment" | "quiz"; id: string }) {
  const urls = groupUrls(sessionId);
  const resource = useGroupResource<TeacherAssignmentDetail | TeacherQuizDetail>(
    kind === "assignment" ? urls.teacherAssignment(id) : urls.teacherQuiz(id),
    (detail) => detail.activityId === id || detail.kind === "members"
  );

  if (resource.loading && !resource.data) return <p className="p-2 text-xs text-slate-500">Loading…</p>;
  if (!resource.data) return <p className="p-2 text-xs text-red-600">{resource.error && !resource.error.ok ? resource.error.message : "Not available."}</p>;

  if (kind === "assignment") {
    const data = resource.data as TeacherAssignmentDetail;
    const submission = data.work.submission;
    return (
      <div className="space-y-2 rounded-md bg-slate-50 p-2 text-xs text-slate-700">
        <p>
          <span className="font-semibold">Members:</span> {names(data.members)}
        </p>
        <p>
          <span className="font-semibold">Latest edit:</span>{" "}
          {data.work.lastEditedBy ? `${data.work.lastEditedBy.name} at ${formatTime(data.work.lastEditedAt)}` : "Not started"}
        </p>
        <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2 text-sm text-slate-900">
          {data.work.answerText || <span className="text-slate-400">No text yet.</span>}
        </div>
        {submission ? (
          <p className="text-emerald-700">
            Submitted by {submission.submittedBy?.name ?? "—"} at {formatTime(submission.submittedAt)} · members: {names(submission.members)}
            {submission.file ? (
              <>
                {" · "}
                <a className="font-medium underline" href={urls.teacherSubmissionFile(id)} target="_blank" rel="noreferrer">
                  {submission.file.fileName}
                </a>
              </>
            ) : null}
          </p>
        ) : (
          <p className="text-amber-700">Not submitted yet.</p>
        )}
      </div>
    );
  }

  return <QuizDetail sessionId={sessionId} quizId={id} data={resource.data as TeacherQuizDetail} onChanged={() => void resource.reload()} />;
}

function QuizDetail({ sessionId, quizId, data, onChanged }: { sessionId: string; quizId: string; data: TeacherQuizDetail; onChanged: () => void }) {
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const attempt = data.attempt;
  const questions = data.quiz.questions.questions;
  const submitted = attempt && attempt.attemptStatus !== "IN_PROGRESS";

  const saveOverrides = async () => {
    const overrides = Object.entries(marks)
      .filter(([, value]) => value.trim() !== "")
      .map(([questionId, value]) => ({ questionId, marks: Number(value) }));
    if (overrides.length === 0) return;
    setSaving(true);
    const result = await groupApi(groupUrls(sessionId).teacherGrading(quizId), jsonInit("PATCH", { overrides }));
    setSaving(false);
    setMessage(result.ok ? "Marks updated." : result.message);
    if (result.ok) {
      setMarks({});
      onChanged();
    }
  };

  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-2 text-xs text-slate-700">
      <p>
        <span className="font-semibold">Members:</span> {names(data.members)}
      </p>
      {!attempt ? (
        <p className="text-amber-700">The group has not started this quiz.</p>
      ) : (
        <>
          <p>
            {attempt.attemptStatus === "IN_PROGRESS"
              ? `In progress · ${data.progress?.answered ?? 0} / ${data.progress?.questions ?? questions.length} answered`
              : `${attempt.attemptStatus === "AUTO_SUBMITTED" ? "Auto-submitted" : `Submitted by ${attempt.submittedBy?.name ?? "—"}`} at ${formatTime(attempt.submittedAt)} · score ${attempt.finalScore ?? "—"} / ${data.quiz.totalMarks ?? "—"}`}
          </p>
          <ol className="space-y-1.5">
            {questions.map((q, index) => {
              const grade = attempt.grading?.questions?.[q.id];
              return (
                <li key={q.id} className="rounded border border-slate-200 bg-white p-2">
                  <p className="font-medium text-slate-900">
                    {index + 1}. {q.prompt} <span className="text-slate-500">({q.marks})</span>
                  </p>
                  <p>Answer: {answerText(q, attempt.answers?.[q.id])}</p>
                  <p className="text-slate-500">Correct: {correctText(q)}</p>
                  {submitted && grade ? (
                    <div className="mt-1 flex items-center gap-2">
                      <span>
                        {grade.result} · {grade.override ? grade.override.marks : grade.auto} / {q.marks}
                        {grade.override ? " (overridden)" : ""}
                      </span>
                      <input
                        aria-label={`Override marks for question ${index + 1}`}
                        className="ml-auto w-16 rounded border border-slate-300 px-1 py-0.5"
                        inputMode="decimal"
                        placeholder="marks"
                        value={marks[q.id] ?? ""}
                        onChange={(e) => setMarks((m) => ({ ...m, [q.id]: e.target.value }))}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {submitted ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={saving || Object.values(marks).every((v) => v.trim() === "")}
                className="rounded-md bg-[#4D6C90] px-3 py-1 text-xs font-semibold text-white hover:bg-[#3B5776] disabled:opacity-50"
                onClick={() => void saveOverrides()}
              >
                Save marks
              </button>
              {message ? <span>{message}</span> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
