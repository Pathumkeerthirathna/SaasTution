"use client";

import { useEffect, useMemo, useState } from "react";

type LectureAssignment = {
  id: string;
  title: string;
  description: string;
  dueDate: string;
};

type AssignmentSubmissionRow = {
  submissionId: string;
  studentId: string;
  studentName: string;
  registrationNumber: string | null;
  fileName: string;
  sizeBytes: number;
  notes: string | null;
  submittedAt: string;
};

type SubmissionsData = {
  assignment: {
    id: string;
    title: string;
    dueDate: string;
    totalEnrolled: number;
  };
  totalSubmissions: number;
  submissions: AssignmentSubmissionRow[];
};

type AssignmentDraft = {
  title: string;
  description: string;
  dueDate: string;
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

function toDateTimeLocal(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function createEmptyDraft(): AssignmentDraft {
  return {
    title: "",
    description: "",
    dueDate: "",
  };
}

export function LectureAssignmentPanel(props: {
  lectureId: string;
  onChanged?: () => Promise<void> | void;
}) {
  const [assignments, setAssignments] = useState<LectureAssignment[]>([]);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AssignmentDraft>(createEmptyDraft);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [submissionsAssignmentId, setSubmissionsAssignmentId] = useState<string | null>(null);
  const [submissionsData, setSubmissionsData] = useState<SubmissionsData | null>(null);
  const [isLoadingSubmissions, setIsLoadingSubmissions] = useState(false);

  const selectedAssignment = useMemo(
    () => assignments.find((item) => item.id === selectedAssignmentId) ?? null,
    [assignments, selectedAssignmentId]
  );

  async function notifyChanged() {
    if (props.onChanged) {
      await props.onChanged();
    }
  }

  async function loadAssignments(preferredId?: string | null) {
    setIsLoading(true);

    try {
      const response = await fetch(`/api/lectures/${props.lectureId}/assignments`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: LectureAssignment[];
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load assignments."));
      }

      const list = payload.data ?? [];
      setAssignments(list);

      const nextSelectedId =
        (preferredId && list.some((item) => item.id === preferredId) ? preferredId : null) ??
        (selectedAssignmentId && list.some((item) => item.id === selectedAssignmentId)
          ? selectedAssignmentId
          : null) ??
        list[0]?.id ??
        null;

      setSelectedAssignmentId(nextSelectedId);

      if (nextSelectedId) {
        const assignment = list.find((item) => item.id === nextSelectedId);
        if (assignment) {
          setDraft({
            title: assignment.title,
            description: assignment.description,
            dueDate: toDateTimeLocal(assignment.dueDate),
          });
        }
      } else {
        setDraft(createEmptyDraft());
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load assignments.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadAssignments(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.lectureId]);

  function handleAddNewAssignment() {
    setSelectedAssignmentId(null);
    setDraft(createEmptyDraft());
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  function handleSelectAssignment(assignmentId: string) {
    const selected = assignments.find((item) => item.id === assignmentId);
    if (!selected) {
      return;
    }

    setSelectedAssignmentId(assignmentId);
    setDraft({
      title: selected.title,
      description: selected.description,
      dueDate: toDateTimeLocal(selected.dueDate),
    });
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  function validateDraft() {
    if (!draft.title.trim()) {
      return "Assignment title is required.";
    }

    if (!draft.description.trim()) {
      return "Assignment description is required.";
    }

    if (!draft.dueDate.trim()) {
      return "Assignment due date is required.";
    }

    return null;
  }

  async function handleSaveAssignment() {
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
        description: draft.description.trim(),
        dueDate: draft.dueDate,
      };

      const response = await fetch(
        selectedAssignmentId
          ? `/api/lectures/${props.lectureId}/assignments/${selectedAssignmentId}`
          : `/api/lectures/${props.lectureId}/assignments`,
        {
          method: selectedAssignmentId ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const result = (await response.json()) as {
        success: boolean;
        data?: {
          assignment: LectureAssignment;
        };
      };

      if (!response.ok || !result.success || !result.data?.assignment) {
        throw new Error(readApiError(result, "Failed to save assignment."));
      }

      await loadAssignments(result.data.assignment.id);
      await notifyChanged();
      setSuccessMessage(selectedAssignmentId ? "Assignment updated successfully." : "Assignment created successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save assignment.");
    } finally {
      setIsSaving(false);
    }
  }

  async function openSubmissions(assignmentId: string) {
    setSubmissionsAssignmentId(assignmentId);
    setSubmissionsData(null);
    setIsLoadingSubmissions(true);

    try {
      const response = await fetch(
        `/api/lectures/${props.lectureId}/assignments/${assignmentId}/submissions`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as {
        success: boolean;
        data?: SubmissionsData;
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load submissions."));
      }

      setSubmissionsData(payload.data ?? null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load submissions.");
      setSubmissionsAssignmentId(null);
    } finally {
      setIsLoadingSubmissions(false);
    }
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function handleDeleteAssignment(assignmentId: string) {
    const assignment = assignments.find((item) => item.id === assignmentId);
    if (!assignment) {
      return;
    }

    const confirmed = window.confirm(`Delete assignment \"${assignment.title}\"?`);
    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/lectures/${props.lectureId}/assignments/${assignmentId}`, {
        method: "DELETE",
      });
      const result = (await response.json()) as {
        success: boolean;
      };

      if (!response.ok || !result.success) {
        throw new Error(readApiError(result, "Failed to delete assignment."));
      }

      const fallbackId = selectedAssignmentId === assignmentId ? null : selectedAssignmentId;
      await loadAssignments(fallbackId);
      await notifyChanged();
      setSuccessMessage("Assignment deleted successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete assignment.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-black/10 p-4 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Assignments</p>
        <button
          type="button"
          onClick={handleAddNewAssignment}
          className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background"
        >
          Add new assignment
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

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.5fr_1fr]">
        <section className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <label className="text-xs font-semibold text-muted">Assignment title</label>
          <input
            value={draft.title}
            onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
            placeholder="Assignment title"
            className="mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
          />

          <label className="mt-3 block text-xs font-semibold text-muted">Description</label>
          <textarea
            value={draft.description}
            onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
            rows={5}
            placeholder="Assignment description"
            className="mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
          />

          <label className="mt-3 block text-xs font-semibold text-muted">Due date</label>
          <input
            type="datetime-local"
            value={draft.dueDate}
            onChange={(event) => setDraft((prev) => ({ ...prev, dueDate: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
          />

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleSaveAssignment()}
              disabled={isSaving}
              className="rounded-lg bg-foreground px-3 py-2 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? "Saving..." : selectedAssignment ? "Save assignment" : "Create assignment"}
            </button>

            {selectedAssignment ? (
              <button
                type="button"
                onClick={() => void handleDeleteAssignment(selectedAssignment.id)}
                disabled={isSaving}
                className="rounded-lg border border-red-300 px-3 py-2 text-xs font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Delete assignment
              </button>
            ) : null}
          </div>
        </section>

        <aside className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <p className="text-sm font-semibold">Existing assignments</p>
          {isLoading ? <p className="mt-2 text-xs text-muted">Loading assignments...</p> : null}
          {!isLoading && assignments.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No assignments added yet.</p>
          ) : null}

          <div className="mt-3 space-y-2">
            {assignments.map((assignment) => (
              <div
                key={assignment.id}
                className={`rounded-lg border px-3 py-2 ${
                  selectedAssignmentId === assignment.id
                    ? "border-foreground bg-black/[0.03] dark:bg-white/[0.04]"
                    : "border-black/10 dark:border-white/10"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleSelectAssignment(assignment.id)}
                  className="w-full text-left"
                >
                  <p className="text-sm font-semibold">{assignment.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted">{assignment.description}</p>
                  <p className="mt-1 text-xs text-muted">Due: {new Date(assignment.dueDate).toLocaleString()}</p>
                </button>

                <button
                  type="button"
                  onClick={() => void openSubmissions(assignment.id)}
                  className="mt-2 rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold dark:border-white/20"
                >
                  View submissions
                </button>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {submissionsAssignmentId ? (
        <div className="mt-4 rounded-xl border border-black/10 p-4 dark:border-white/10">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Student Submissions</p>
              {submissionsData ? (
                <h3 className="mt-0.5 text-sm font-semibold">{submissionsData.assignment.title}</h3>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                setSubmissionsAssignmentId(null);
                setSubmissionsData(null);
              }}
              className="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold dark:border-white/20"
            >
              Close
            </button>
          </div>

          {isLoadingSubmissions ? (
            <p className="mt-3 text-xs text-muted">Loading submissions...</p>
          ) : submissionsData ? (
            <>
              <div className="mt-3 flex flex-wrap gap-4">
                <div className="rounded-lg border border-black/10 px-4 py-2.5 dark:border-white/10">
                  <p className="text-xs text-muted">Submissions</p>
                  <p className="mt-0.5 text-lg font-semibold">
                    {submissionsData.totalSubmissions}
                    <span className="ml-1 text-sm font-normal text-muted">
                      / {submissionsData.assignment.totalEnrolled} enrolled
                    </span>
                  </p>
                </div>
                <div className="rounded-lg border border-black/10 px-4 py-2.5 dark:border-white/10">
                  <p className="text-xs text-muted">Due</p>
                  <p className="mt-0.5 text-sm font-semibold">
                    {new Date(submissionsData.assignment.dueDate).toLocaleString()}
                  </p>
                </div>
              </div>

              {submissionsData.submissions.length === 0 ? (
                <p className="mt-3 text-xs text-muted">No submissions yet.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[540px] text-sm">
                    <thead>
                      <tr className="border-b border-black/10 text-left text-xs font-semibold text-muted dark:border-white/10">
                        <th className="pb-2 pr-4">Student</th>
                        <th className="pb-2 pr-4">Submitted</th>
                        <th className="pb-2 pr-4">File</th>
                        <th className="pb-2">Notes</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/5 dark:divide-white/5">
                      {submissionsData.submissions.map((sub) => (
                        <tr key={sub.submissionId}>
                          <td className="py-2 pr-4">
                            <p className="font-medium">{sub.studentName}</p>
                            {sub.registrationNumber ? (
                              <p className="text-xs text-muted">{sub.registrationNumber}</p>
                            ) : null}
                          </td>
                          <td className="py-2 pr-4 text-xs text-muted">
                            {new Date(sub.submittedAt).toLocaleString()}
                          </td>
                          <td className="py-2 pr-4">
                            <p className="max-w-[160px] truncate text-xs">{sub.fileName}</p>
                            <p className="text-xs text-muted">{formatBytes(sub.sizeBytes)}</p>
                          </td>
                          <td className="py-2 pr-4">
                            {sub.notes ? (
                              <p className="max-w-[180px] truncate text-xs text-muted" title={sub.notes}>
                                {sub.notes}
                              </p>
                            ) : (
                              <span className="text-xs text-muted">—</span>
                            )}
                          </td>
                          <td className="py-2">
                            <a
                              href={`/api/lectures/${props.lectureId}/assignments/${submissionsAssignmentId}/submissions/${sub.submissionId}/file`}
                              download
                              className="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold dark:border-white/20"
                            >
                              Download
                            </a>
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
