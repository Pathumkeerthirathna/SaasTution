"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Calendar,
  ChevronDown,
  FileText,
  FolderOpen,
  MoreVertical,
  Plus,
  Save,
  Users,
  X,
  Download,
  Eye,
  Trash2,
} from "lucide-react";

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
  const [isExpandedList, setIsExpandedList] = useState(false);

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
    <div className="mt-4 space-y-6">
      <article className="surface-panel overflow-hidden border border-brand-100 p-0">
        <div className="flex items-center justify-between gap-4 border-b border-brand-100 bg-gradient-to-r from-brand-50 via-white to-slate-50 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-4">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-100 text-brand-700 shadow-soft">
              <FileText size={24} />
            </span>
            <div>
              <h3 className="text-2xl font-semibold tracking-tight text-slate-900">Lecture assignments</h3>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span>{selectedAssignment?.title ?? "Select an assignment or create a new one"}</span>
                <span>•</span>
                <span className="inline-flex items-center gap-1.5"><Calendar size={13} /> {selectedAssignment ? new Date(selectedAssignment.dueDate).toLocaleString() : "Ready to schedule"}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsExpandedList((prev) => !prev)}
            className="btn-secondary gap-2"
          >
            {isExpandedList ? <ChevronDown size={15} /> : <FolderOpen size={15} />}
            {isExpandedList ? "Collapse" : "Expand"}
          </button>
        </div>

        <div className="px-5 py-5 sm:px-6">
          {errorMessage ? <p className="notice-error mb-4 text-xs">{errorMessage}</p> : null}
          {successMessage ? <p className="notice-success mb-4 text-xs">{successMessage}</p> : null}

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.05fr_0.95fr]">
            <section className="surface-card border border-brand-100 p-5 shadow-soft">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
                    <Plus size={18} />
                  </span>
                  <div>
                    <h4 className="text-xl font-semibold text-slate-900">Create or update assignment</h4>
                    <p className="mt-1 text-sm text-muted">Manage title, description, and due date here.</p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleAddNewAssignment}
                  className="btn-primary gap-2 px-3 py-2 text-xs"
                >
                  <Plus size={14} />
                  Add new assignment
                </button>
              </div>

              <div className="mt-5 space-y-4">
                <div>
                  <label className="form-label">Assignment title</label>
                  <input
                    value={draft.title}
                    onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder="Assignment title"
                    className="control-input mt-2 h-14 text-base"
                  />
                </div>

                <div>
                  <label className="form-label">Description</label>
                  <textarea
                    value={draft.description}
                    onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
                    rows={6}
                    placeholder="Assignment description"
                    className="control-textarea mt-2 text-base"
                  />
                </div>

                <div>
                  <label className="form-label">Due date</label>
                  <div className="relative mt-2">
                    <Calendar size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
                    <input
                      type="datetime-local"
                      value={draft.dueDate}
                      onChange={(event) => setDraft((prev) => ({ ...prev, dueDate: event.target.value }))}
                      className="control-input h-14 pl-11 text-base"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => void handleSaveAssignment()}
                    disabled={isSaving}
                    className="btn-primary gap-2 px-4 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Save size={15} />
                    {isSaving ? "Saving..." : selectedAssignment ? "Save assignment" : "Create assignment"}
                  </button>

                  {selectedAssignment ? (
                    <button
                      type="button"
                      onClick={() => void handleDeleteAssignment(selectedAssignment.id)}
                      disabled={isSaving}
                      className="btn-danger gap-2 px-4 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Trash2 size={15} />
                      Delete assignment
                    </button>
                  ) : null}
                </div>
              </div>
            </section>

            <aside className="surface-card border border-brand-100 p-5 shadow-soft">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                    <Users size={18} />
                  </span>
                  <div>
                    <h4 className="text-xl font-semibold text-slate-900">Existing assignments</h4>
                    <p className="mt-1 text-sm text-muted">Open a record to edit or inspect submissions.</p>
                  </div>
                </div>

                <span className="metric-badge">{assignments.length} total</span>
              </div>

              {isLoading ? <p className="mt-4 text-sm text-muted">Loading assignments...</p> : null}
              {!isLoading && assignments.length === 0 ? (
                <p className="mt-4 text-sm text-muted">No assignments added yet.</p>
              ) : null}

              <div className={`mt-4 space-y-3 ${isExpandedList ? "max-h-none" : "max-h-[520px] overflow-y-auto pr-1"}`}>
                {assignments.map((assignment) => (
                  <div
                    key={assignment.id}
                    className={`rounded-2xl border p-4 shadow-soft transition ${
                      selectedAssignmentId === assignment.id
                        ? "border-brand-300 bg-brand-50/70"
                        : "border-brand-100 bg-white"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectAssignment(assignment.id)}
                      className="block w-full text-left"
                    >
                      <p className="truncate text-lg font-semibold text-slate-900">{assignment.title}</p>
                      <p className="mt-1 line-clamp-2 text-sm text-slate-500">{assignment.description}</p>
                      <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-500">
                        <Calendar size={12} />
                        Due: {new Date(assignment.dueDate).toLocaleString()}
                      </p>
                    </button>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void openSubmissions(assignment.id)}
                        className="btn-secondary gap-2 px-3 py-2 text-xs"
                      >
                        <Eye size={13} />
                        View submissions
                      </button>
                      <button type="button" className="btn-ghost px-3 py-2 text-xs" disabled>
                        <MoreVertical size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </div>
      </article>

      {submissionsAssignmentId ? (
        <div className="surface-panel border border-brand-100 p-0 overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-brand-100 bg-gradient-to-r from-brand-50 via-white to-slate-50 px-5 py-4 sm:px-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">Student submissions</p>
              {submissionsData ? (
                <h3 className="mt-1 text-xl font-semibold text-slate-900">{submissionsData.assignment.title}</h3>
              ) : null}
              {submissionsData ? (
                <p className="mt-2 text-sm text-slate-600">
                  Due {new Date(submissionsData.assignment.dueDate).toLocaleString()} • {submissionsData.totalSubmissions}/{submissionsData.assignment.totalEnrolled} submissions
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                setSubmissionsAssignmentId(null);
                setSubmissionsData(null);
              }}
              className="btn-secondary gap-2"
            >
              <X size={14} />
              Close
            </button>
          </div>

          <div className="px-5 py-5 sm:px-6">
            {isLoadingSubmissions ? (
              <p className="text-sm text-muted">Loading submissions...</p>
            ) : submissionsData ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <div className="metric-tile">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">Submissions</p>
                    <p className="mt-2 text-2xl font-semibold text-slate-900">
                      {submissionsData.totalSubmissions}
                      <span className="ml-2 text-sm font-normal text-muted">/ {submissionsData.assignment.totalEnrolled} enrolled</span>
                    </p>
                  </div>
                  <div className="metric-tile">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">Due</p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{new Date(submissionsData.assignment.dueDate).toLocaleString()}</p>
                  </div>
                  <div className="metric-tile">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">Status</p>
                    <p className="mt-2 text-sm font-semibold text-emerald-700">Ready for review</p>
                  </div>
                </div>

                {submissionsData.submissions.length === 0 ? (
                  <p className="mt-4 text-sm text-muted">No submissions yet.</p>
                ) : (
                  <div className="mt-4 overflow-x-auto rounded-2xl border border-brand-100 bg-white shadow-soft">
                    <table className="min-w-[640px] w-full text-sm">
                      <thead className="bg-brand-50 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                        <tr>
                          <th className="px-4 py-3 text-left">Student</th>
                          <th className="px-4 py-3 text-left">Submitted</th>
                          <th className="px-4 py-3 text-left">File</th>
                          <th className="px-4 py-3 text-left">Notes</th>
                          <th className="px-4 py-3 text-left"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-brand-100">
                        {submissionsData.submissions.map((sub) => (
                          <tr key={sub.submissionId} className="align-top">
                            <td className="px-4 py-4">
                              <p className="font-semibold text-slate-900">{sub.studentName}</p>
                              {sub.registrationNumber ? (
                                <p className="mt-1 text-xs text-muted">{sub.registrationNumber}</p>
                              ) : null}
                            </td>
                            <td className="px-4 py-4 text-sm text-slate-600">{new Date(sub.submittedAt).toLocaleString()}</td>
                            <td className="px-4 py-4">
                              <p className="max-w-[180px] truncate text-sm text-slate-800">{sub.fileName}</p>
                              <p className="mt-1 text-xs text-muted">{formatBytes(sub.sizeBytes)}</p>
                            </td>
                            <td className="px-4 py-4">
                              {sub.notes ? (
                                <p className="max-w-[220px] truncate text-sm text-slate-600" title={sub.notes}>
                                  {sub.notes}
                                </p>
                              ) : (
                                <span className="text-sm text-muted">—</span>
                              )}
                            </td>
                            <td className="px-4 py-4">
                              <a
                                href={`/api/lectures/${props.lectureId}/assignments/${submissionsAssignmentId}/submissions/${sub.submissionId}/file`}
                                download
                                className="btn-secondary gap-2 px-3 py-2 text-xs"
                              >
                                <Download size={13} />
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
        </div>
      ) : null}
    </div>
  );
}
