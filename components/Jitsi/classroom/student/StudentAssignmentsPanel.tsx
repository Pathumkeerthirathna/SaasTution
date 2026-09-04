"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ClipboardList, Loader2 } from "lucide-react";

import { AssignmentSubmitButton } from "@/components/student-portal/assignment-submit-button";

type Submission = {
  id: string;
  notes: string | null;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  sizeBytes: number;
  submittedAt: string;
};

type Assignment = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string;
  submission: Submission | null;
};

function fmtDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * A student's assignments for the current lecture, inside the live session.
 * Students can read the brief and submit their own file; they cannot add, edit
 * or delete the assignment itself.
 */
export default function StudentAssignmentsPanel({
  lectureId,
}: {
  lectureId: string;
}) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/student/lectures/${lectureId}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        success?: boolean;
        data?: { lecture?: { assignments?: Assignment[] } };
        error?: { message?: string };
      };
      if (!res.ok || !json.success || !json.data?.lecture) {
        throw new Error(json.error?.message ?? "Failed to load assignments.");
      }
      setAssignments(json.data.lecture.assignments ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load assignments."
      );
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
            <ClipboardList size={15} />
          </span>
          <div>
            <h4 className="text-sm font-semibold text-slate-900">Assignments</h4>
            <p className="text-[11px] text-slate-500">
              Read the brief and submit your work for this lecture.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" />
            Loading assignments…
          </div>
        ) : error ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        ) : assignments.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-emerald-200 bg-emerald-50/60 px-3 py-3 text-center text-xs text-emerald-700">
            No assignments for this lecture yet.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {assignments.map((assignment) => {
              const dueDate = new Date(assignment.dueDate);
              const sub = assignment.submission
                ? {
                    ...assignment.submission,
                    submittedAt: new Date(assignment.submission.submittedAt),
                  }
                : null;

              return (
                <article
                  key={assignment.id}
                  className="rounded-lg border border-slate-200 bg-white p-3"
                >
                  <div className="flex flex-col gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900">
                        {assignment.title}
                      </h3>
                      <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-500">
                        <CalendarClock size={11} />
                        Due {fmtDate(assignment.dueDate)}
                      </p>
                      {assignment.description ? (
                        <p className="mt-1 whitespace-pre-line text-xs text-slate-600">
                          {assignment.description}
                        </p>
                      ) : null}
                    </div>
                    <div>
                      <AssignmentSubmitButton
                        assignmentId={assignment.id}
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
      </section>
    </div>
  );
}
