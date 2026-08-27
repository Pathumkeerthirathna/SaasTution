"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Calendar,
  ChevronDown,
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
  const [isFormOpen, setIsFormOpen] = useState(false);

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

  function openCreateForm() {
    handleAddNewAssignment();
    setIsFormOpen(true);
  }

  function openEditForm(assignmentId: string) {
    handleSelectAssignment(assignmentId);
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
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
      setIsFormOpen(false);
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
      setIsFormOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete assignment.");
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
              <h4 className="text-sm font-semibold text-slate-900">Existing assignments</h4>
              <p className="text-[11px] text-muted">Open a record to edit or inspect submissions.</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{assignments.length} total</span>
            <button
              type="button"
              onClick={() => setIsExpandedList((prev) => !prev)}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
            >
              {isExpandedList ? <ChevronDown size={11} /> : <FolderOpen size={11} />}
              {isExpandedList ? "Collapse" : "Expand"}
            </button>
          </div>
        </div>

        <div className="mt-3.5 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold text-slate-700">Add / organize assignments</p>
          <button
            type="button"
            onClick={openCreateForm}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-brand-700 px-2.5 text-[11px] font-semibold text-white transition hover:bg-brand-600"
          >
            <Plus size={11} />
            Add new assignment
          </button>
        </div>

        {isLoading ? <p className="mt-3 text-xs text-muted">Loading assignments...</p> : null}
        {!isLoading && assignments.length === 0 ? (
          <p className="mt-3 text-xs text-muted">No assignments added yet.</p>
        ) : null}

        <div className={`mt-3 space-y-2 ${isExpandedList ? "max-h-none" : "max-h-[420px] overflow-y-auto scrollbar-thin pr-1"}`}>
          {assignments.map((assignment) => (
            <div
              key={assignment.id}
              className={`rounded-lg border p-3 transition ${
                selectedAssignmentId === assignment.id && isFormOpen
                  ? "border-brand-300 bg-brand-50/70"
                  : "border-slate-200 bg-white"
              }`}
            >
              <button
                type="button"
                onClick={() => openEditForm(assignment.id)}
                className="block w-full text-left"
              >
                <p className="truncate text-xs font-semibold text-slate-900">{assignment.title}</p>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{assignment.description}</p>
                <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500">
                  <Calendar size={10} />
                  Due: {new Date(assignment.dueDate).toLocaleString()}
                </p>
              </button>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void openSubmissions(assignment.id)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
                >
                  <Eye size={11} />
                  View submissions
                </button>
                <button
                  type="button"
                  onClick={() => openEditForm(assignment.id)}
                  className="inline-flex h-7 items-center justify-center rounded-md border border-slate-200 px-1.5 text-slate-500 transition hover:bg-slate-50"
                >
                  <MoreVertical size={11} />
                </button>
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
              className="w-full max-h-[85vh] overflow-y-auto scrollbar-thin rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                    <Plus size={15} />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">
                      {selectedAssignment ? "Edit assignment" : "Add new assignment"}
                    </h4>
                    <p className="text-[11px] text-muted">Manage title, description, and due date here.</p>
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

              {errorMessage ? <p className="notice-error mt-3 text-xs">{errorMessage}</p> : null}

              <div className="mt-3.5 space-y-3">
                <div>
                  <label className="form-label mb-1 block">Assignment title</label>
                  <input
                    value={draft.title}
                    onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder="Assignment title"
                    className="control-input h-9 text-sm"
                  />
                </div>

                <div>
                  <label className="form-label mb-1 block">Description</label>
                  <textarea
                    value={draft.description}
                    onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
                    rows={4}
                    placeholder="Assignment description"
                    className="control-textarea text-sm"
                  />
                </div>

                <div>
                  <label className="form-label mb-1 block">Due date</label>
                  <div className="relative">
                    <Calendar size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="datetime-local"
                      value={draft.dueDate}
                      onChange={(event) => setDraft((prev) => ({ ...prev, dueDate: event.target.value }))}
                      className="control-input h-9 pl-8 text-sm"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => void handleSaveAssignment()}
                    disabled={isSaving}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 text-xs font-semibold text-white shadow-soft transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Save size={13} />
                    {isSaving ? "Saving..." : selectedAssignment ? "Save assignment" : "Create assignment"}
                  </button>

                  {selectedAssignment ? (
                    <button
                      type="button"
                      onClick={() => void handleDeleteAssignment(selectedAssignment.id)}
                      disabled={isSaving}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Trash2 size={13} />
                      Delete assignment
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {submissionsAssignmentId ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
            <div>
              <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-700">
                <Users size={11} />
                Student submissions
              </p>
              {submissionsData ? (
                <h3 className="mt-0.5 text-sm font-semibold text-slate-900">{submissionsData.assignment.title}</h3>
              ) : null}
              {submissionsData ? (
                <p className="mt-1 text-[11px] text-slate-600">
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
              className="btn-secondary shrink-0"
            >
              <X size={12} />
              Close
            </button>
          </div>

          <div className="px-4 py-4">
            {isLoadingSubmissions ? (
              <p className="text-xs text-muted">Loading submissions...</p>
            ) : submissionsData ? (
              <>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Submissions</p>
                    <p className="mt-1 text-base font-semibold text-slate-900">
                      {submissionsData.totalSubmissions}
                      <span className="ml-1.5 text-[11px] font-normal text-muted">/ {submissionsData.assignment.totalEnrolled} enrolled</span>
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Due</p>
                    <p className="mt-1 text-xs font-semibold text-slate-900">{new Date(submissionsData.assignment.dueDate).toLocaleString()}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Status</p>
                    <p className="mt-1 text-xs font-semibold text-emerald-700">Ready for review</p>
                  </div>
                </div>

                {submissionsData.submissions.length === 0 ? (
                  <p className="mt-3 text-xs text-muted">No submissions yet.</p>
                ) : (
                  <div className="mt-3 overflow-x-auto scrollbar-thin rounded-lg border border-slate-200 bg-white">
                    <table className="min-w-[640px] w-full text-xs">
                      <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">
                        <tr>
                          <th className="px-3 py-2 text-left">Student</th>
                          <th className="px-3 py-2 text-left">Submitted</th>
                          <th className="px-3 py-2 text-left">File</th>
                          <th className="px-3 py-2 text-left">Notes</th>
                          <th className="px-3 py-2 text-left"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {submissionsData.submissions.map((sub) => (
                          <tr key={sub.submissionId} className="align-top">
                            <td className="px-3 py-2.5">
                              <p className="font-semibold text-slate-900">{sub.studentName}</p>
                              {sub.registrationNumber ? (
                                <p className="mt-0.5 text-[10px] text-muted">{sub.registrationNumber}</p>
                              ) : null}
                            </td>
                            <td className="px-3 py-2.5 text-slate-600">{new Date(sub.submittedAt).toLocaleString()}</td>
                            <td className="px-3 py-2.5">
                              <p className="max-w-[180px] truncate text-slate-800">{sub.fileName}</p>
                              <p className="mt-0.5 text-[10px] text-muted">{formatBytes(sub.sizeBytes)}</p>
                            </td>
                            <td className="px-3 py-2.5">
                              {sub.notes ? (
                                <p className="max-w-[220px] truncate text-slate-600" title={sub.notes}>
                                  {sub.notes}
                                </p>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              <a
                                href={`/api/lectures/${props.lectureId}/assignments/${submissionsAssignmentId}/submissions/${sub.submissionId}/file`}
                                download
                                className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
                              >
                                <Download size={11} />
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
