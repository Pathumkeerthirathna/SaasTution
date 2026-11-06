"use client";

// Student: Group Work. The group (confirmed by the teacher for the student's
// breakout room), the group's published assignments and quizzes with
// progress, and each activity's shared work. Talking and screen sharing stay
// in the meeting itself (the breakout room's audio, chat and screen share).

import { useState } from "react";

import { formatTime, groupUrls } from "./api";
import { useGroupResource } from "./hooks";
import StudentGroupAssignment from "./StudentGroupAssignment";
import StudentGroupQuiz from "./StudentGroupQuiz";
import type { StudentOverview } from "./types";

export default function StudentGroupWorkPanel({ sessionId }: { sessionId: string }) {
  const overview = useGroupResource<StudentOverview>(groupUrls(sessionId).myGroup);
  const [open, setOpen] = useState<{ kind: "assignment" | "quiz"; id: string } | null>(null);

  if (open?.kind === "assignment") return <StudentGroupAssignment sessionId={sessionId} assignmentId={open.id} onBack={() => setOpen(null)} />;
  if (open?.kind === "quiz") return <StudentGroupQuiz sessionId={sessionId} quizId={open.id} onBack={() => setOpen(null)} />;

  const data = overview.data;
  if (overview.loading && !data) return <p className="text-xs text-slate-500">Loading…</p>;
  if (!data) return <p className="text-xs text-red-600">{overview.error && !overview.error.ok ? overview.error.message : "Not available."}</p>;
  if (!data.group) {
    return (
      <p className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
        You are not in a group yet. When your teacher confirms the breakout groups, your group&apos;s work appears here.
      </p>
    );
  }

  return (
    <div className="space-y-3 text-slate-900">
      <section className="rounded-lg border border-slate-200 bg-white p-3">
        <h3 className="break-words text-sm font-semibold">{data.group.room.name}</h3>
        <p className="break-words text-xs text-slate-600">Members: {data.group.members.map((m) => m?.name).join(", ")}</p>
        <p className="mt-1 text-[11px] text-slate-500">Talk and share your screen in the meeting; write and answer together here.</p>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-3">
        <h3 className="mb-2 text-sm font-semibold">Group activities</h3>
        {data.assignments.length === 0 && data.quizzes.length === 0 ? <p className="text-xs text-slate-500">Nothing published for your group yet.</p> : null}
        <ul className="space-y-1.5">
          {data.assignments.map((a) => (
            <li key={a.id}>
              <button type="button" className="w-full rounded-md border border-slate-200 p-2 text-left hover:bg-slate-50" onClick={() => setOpen({ kind: "assignment", id: a.id })}>
                <span className="block break-words text-xs font-medium">Assignment: {a.title}</span>
                <span className="block break-words text-[11px] text-slate-600">
                  {a.progress.submitted
                    ? `Submitted by ${a.progress.submitted.submittedBy?.name ?? "—"} at ${formatTime(a.progress.submitted.submittedAt)}`
                    : a.state === "CLOSED"
                      ? "Closed"
                      : a.progress.lastEditedBy
                        ? `In progress · last edit ${a.progress.lastEditedBy.name} at ${formatTime(a.progress.lastEditedAt)}`
                        : "Not started"}
                </span>
              </button>
            </li>
          ))}
          {data.quizzes.map((q) => (
            <li key={q.id}>
              <button type="button" className="w-full rounded-md border border-slate-200 p-2 text-left hover:bg-slate-50" onClick={() => setOpen({ kind: "quiz", id: q.id })}>
                <span className="block break-words text-xs font-medium">Quiz: {q.title}</span>
                <span className="block break-words text-[11px] text-slate-600">
                  {!q.progress.attemptStatus
                    ? q.state === "CLOSED"
                      ? "Closed"
                      : `Not started · ${q.questionCount} questions`
                    : q.progress.attemptStatus === "IN_PROGRESS"
                      ? `In progress · ${q.progress.answered} / ${q.progress.questions} answered`
                      : `Submitted · ${q.progress.finalScore ?? "—"} / ${q.progress.totalMarks ?? "—"}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
