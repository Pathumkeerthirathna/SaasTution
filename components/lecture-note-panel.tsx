"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Calendar,
  ChevronDown,
  CircleHelp,
  Download,
  Eye,
  FileText,
  FolderOpen,
  MoreVertical,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";

type LectureNote = {
  id: string;
  title: string;
  fileUrl: string;
  kind: "NOTE" | "SUPPORTING_MATERIAL";
  mimeType: string;
  sizeBytes: number;
  downloadCount: number;
  lastDownloadedAt: string | null;
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

function formatBytes(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

export function LectureNotePanel(props: {
  lectureId: string;
  onChanged?: () => Promise<void> | void;
}) {
  const [notes, setNotes] = useState<LectureNote[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"NOTE" | "SUPPORTING_MATERIAL">("NOTE");
  const [file, setFile] = useState<File | null>(null);
  const [previewNote, setPreviewNote] = useState<LectureNote | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const selectedNote = useMemo(() => notes.find((note) => note.id === selectedNoteId) ?? null, [notes, selectedNoteId]);

  async function notifyChanged() {
    if (props.onChanged) {
      await props.onChanged();
    }
  }

  async function loadNotes(preferredId?: string | null) {
    setIsLoading(true);

    try {
      const response = await fetch(`/api/lectures/${props.lectureId}/notes`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: LectureNote[];
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load notes."));
      }

      const list = payload.data ?? [];
      setNotes(list);

      const nextSelectedId =
        (preferredId && list.some((item) => item.id === preferredId) ? preferredId : null) ??
        (selectedNoteId && list.some((item) => item.id === selectedNoteId) ? selectedNoteId : null) ??
        list[0]?.id ??
        null;

      setSelectedNoteId(nextSelectedId);

      if (nextSelectedId) {
        const note = list.find((item) => item.id === nextSelectedId);
        if (note) {
          setTitle(note.title);
          setKind(note.kind);
        }
      } else {
        setTitle("");
        setKind("NOTE");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load notes.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadNotes(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.lectureId]);

  function resetForNew() {
    setSelectedNoteId(null);
    setTitle("");
    setKind("NOTE");
    setFile(null);
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  function selectExisting(noteId: string) {
    const note = notes.find((item) => item.id === noteId);
    if (!note) {
      return;
    }

    setSelectedNoteId(noteId);
    setTitle(note.title);
    setKind(note.kind);
    setFile(null);
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  async function saveNote() {
    if (!title.trim()) {
      setErrorMessage("Title is required.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      if (selectedNoteId) {
        const response = await fetch(`/api/lectures/${props.lectureId}/notes/${selectedNoteId}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: title.trim(),
            kind,
          }),
        });

        const payload = (await response.json()) as {
          success: boolean;
        };

        if (!response.ok || !payload.success) {
          throw new Error(readApiError(payload, "Failed to update note."));
        }

        await loadNotes(selectedNoteId);
        await notifyChanged();
        setSuccessMessage("Note details updated successfully.");
      } else {
        if (!file) {
          setErrorMessage("File is required for a new note.");
          return;
        }

        const formData = new FormData();
        formData.set("title", title.trim());
        formData.set("kind", kind);
        formData.set("file", file);

        const response = await fetch(`/api/lectures/${props.lectureId}/notes`, {
          method: "POST",
          body: formData,
        });

        const payload = (await response.json()) as {
          success: boolean;
          data?: {
            note: LectureNote;
          };
        };

        if (!response.ok || !payload.success || !payload.data?.note) {
          throw new Error(readApiError(payload, "Failed to upload note."));
        }

        await loadNotes(payload.data.note.id);
        await notifyChanged();
        setFile(null);
        setSuccessMessage("Note uploaded successfully.");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save note.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteSelected() {
    if (!selectedNote) {
      return;
    }

    const confirmed = window.confirm(`Delete note \"${selectedNote.title}\"?`);
    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/lectures/${props.lectureId}/notes/${selectedNote.id}`, {
        method: "DELETE",
      });

      const payload = (await response.json()) as {
        success: boolean;
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to delete note."));
      }

      await loadNotes(null);
      await notifyChanged();
      setSuccessMessage("Note deleted successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete note.");
    } finally {
      setIsSaving(false);
    }
  }

  const previewUrl = previewNote ? `/api/lectures/notes/${previewNote.id}/preview` : "";

  const selectedKindLabel = kind === "NOTE" ? "Note" : "Supporting material";

  return (
    <div className="mt-4 space-y-6">
      <article className="surface-panel border border-brand-100 p-0 overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-brand-100 bg-gradient-to-r from-brand-50 via-white to-slate-50 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-4">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-100 text-brand-700 shadow-soft">
              <FileText size={24} />
            </span>
            <div>
              <h3 className="text-2xl font-semibold tracking-tight text-slate-900">Lecture notes</h3>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span>{selectedNote?.title ?? "Select a note or create a new one"}</span>
                <span>•</span>
                <span className="inline-flex items-center gap-1.5"><BookOpen size={13} /> {selectedKindLabel}</span>
                <span>•</span>
                <span className="inline-flex items-center gap-1.5"><Calendar size={13} /> {selectedNote ? formatBytes(selectedNote.sizeBytes) : "Ready to upload"}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setPreviewNote(null)}
            className="btn-secondary gap-2"
            aria-label="Close notes panel"
          >
            <X size={15} />
            Close
          </button>
        </div>

        <div className="px-5 py-5 sm:px-6">
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.08fr_0.92fr]">
            <section className="surface-card border border-brand-100 p-5 shadow-soft">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
                    <Plus size={18} />
                  </span>
                  <div>
                    <h4 className="text-xl font-semibold text-slate-900">Create or update note</h4>
                    <p className="mt-1 text-sm text-muted">Edit the selected note or upload a new lecture file.</p>
                  </div>
                </div>

                {selectedNote ? (
                  <span className="metric-badge">Editing existing</span>
                ) : (
                  <button
                    type="button"
                    onClick={resetForNew}
                    className="btn-primary gap-2 px-3 py-2 text-xs"
                  >
                    <Plus size={14} />
                    Add new note
                  </button>
                )}
              </div>

              {errorMessage ? (
                <p className="notice-error mt-4 text-xs">{errorMessage}</p>
              ) : null}

              {successMessage ? (
                <p className="notice-success mt-4 text-xs">{successMessage}</p>
              ) : null}

              <div className="mt-5 space-y-4">
                <div>
                  <label className="form-label">Title</label>
                  <div className="relative mt-2">
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="File title"
                      className="control-input h-14 pr-16 text-base"
                    />
                    <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted">
                      {title.length}/120
                    </span>
                  </div>
                </div>

                <div>
                  <label className="form-label">Kind</label>
                  <div className="relative mt-2">
                    <FolderOpen size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
                    <ChevronDown size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
                    <select
                      value={kind}
                      onChange={(event) => setKind(event.target.value as "NOTE" | "SUPPORTING_MATERIAL")}
                      className="control-select h-14 appearance-none pl-11 pr-12 text-base"
                    >
                      <option value="NOTE">Note</option>
                      <option value="SUPPORTING_MATERIAL">Supporting material</option>
                    </select>
                  </div>
                </div>

                {!selectedNote ? (
                  <div className="rounded-2xl border border-dashed border-brand-200 bg-brand-50/40 p-4">
                    <label className="form-label">Upload file</label>
                    <input
                      type="file"
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                      className="mt-2 w-full text-sm text-slate-600"
                    />
                    <p className="mt-3 text-xs text-brand-700">PDF, image, or document file for the lecture note/material.</p>
                  </div>
                ) : (
                  <div className="notice-info flex items-start gap-2 text-xs">
                    <CircleHelp size={14} className="mt-0.5 shrink-0" />
                    <span>File replacement is not enabled. Upload a new note if needed.</span>
                  </div>
                )}

                <div className="flex flex-wrap gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => void saveNote()}
                    disabled={isSaving}
                    className="btn-primary gap-2 px-4 py-3 text-sm"
                  >
                    <Save size={15} />
                    {isSaving ? "Saving..." : selectedNote ? "Save note" : "Upload note"}
                  </button>

                  {selectedNote ? (
                    <button
                      type="button"
                      onClick={() => void deleteSelected()}
                      disabled={isSaving}
                      className="btn-danger gap-2 px-4 py-3 text-sm"
                    >
                      <Trash2 size={15} />
                      Delete note
                    </button>
                  ) : null}
                </div>
              </div>
            </section>

            <aside className="surface-card border border-brand-100 p-5 shadow-soft">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                    <FileText size={18} />
                  </span>
                  <div>
                    <h4 className="text-xl font-semibold text-slate-900">Existing notes</h4>
                    <p className="mt-1 text-sm text-muted">Browse lecture uploads and manage downloads.</p>
                  </div>
                </div>

                <span className="metric-badge">{notes.length} total</span>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-brand-100 bg-white/90 px-4 py-3 shadow-soft">
                <p className="text-sm font-semibold text-slate-800">Add / organize files</p>
                <button type="button" onClick={resetForNew} className="btn-primary gap-2 px-3 py-2 text-xs">
                  <Plus size={14} />
                  Add new note
                </button>
              </div>

              {isLoading ? <p className="mt-4 text-sm text-muted">Loading notes...</p> : null}
              {!isLoading && notes.length === 0 ? <p className="mt-4 text-sm text-muted">No notes uploaded yet.</p> : null}

              <div className="mt-4 space-y-3">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className={`rounded-2xl border p-4 shadow-soft transition ${
                      selectedNoteId === note.id
                        ? "border-brand-300 bg-brand-50/70"
                        : "border-brand-100 bg-white"
                    }`}
                  >
                    <div className="flex items-start gap-4">
                      <div className="inline-flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-2xl bg-brand-50 text-brand-700 shadow-soft">
                        <FileText size={22} />
                        {note.mimeType === "application/pdf" ? (
                          <span className="mt-1 rounded-md bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white">PDF</span>
                        ) : null}
                      </div>

                      <div className="min-w-0 flex-1">
                        <button type="button" onClick={() => selectExisting(note.id)} className="block w-full text-left">
                          <p className="truncate text-lg font-semibold text-slate-900">{note.title}</p>
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                            <span className="uppercase tracking-wide">{note.kind}</span>
                            <span>•</span>
                            <span>{formatBytes(note.sizeBytes)}</span>
                            <span>•</span>
                            <span>Downloads: {note.downloadCount}</span>
                          </p>
                          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-500">
                            <Calendar size={12} />
                            {note.lastDownloadedAt ? `Last downloaded ${new Date(note.lastDownloadedAt).toLocaleString()}` : "Added to lecture"}
                          </p>
                        </button>

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <a
                            href={`/api/lectures/notes/${note.id}/download`}
                            className="btn-secondary gap-2 px-3 py-2 text-xs"
                          >
                            <Download size={13} />
                            Download
                          </a>

                          {note.mimeType === "application/pdf" ? (
                            <button
                              type="button"
                              onClick={() => setPreviewNote(note)}
                              className="btn-secondary gap-2 px-3 py-2 text-xs"
                            >
                              <Eye size={13} />
                              Preview
                            </button>
                          ) : null}

                          <button type="button" className="btn-ghost px-3 py-2 text-xs" disabled>
                            <MoreVertical size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </div>
      </article>

      {previewNote ? (
        <>
          <div className="fixed inset-0 z-[80] bg-black/40" onClick={() => setPreviewNote(null)} aria-hidden />
          <aside className="fixed inset-y-0 right-0 z-[90] h-full w-full transform overflow-hidden border-l border-brand-100 bg-white shadow-2xl transition-transform duration-200 dark:bg-white">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-brand-100 bg-white/95 px-4 py-4 backdrop-blur sm:px-6">
              <div>
                <p className="text-sm font-semibold text-slate-900">PDF Preview</p>
                <p className="text-xs text-muted">{previewNote.title}</p>
              </div>

              <button
                type="button"
                onClick={() => setPreviewNote(null)}
                className="btn-secondary gap-2"
              >
                <X size={14} />
                Close
              </button>
            </div>

            <div className="h-[calc(100%-69px)] bg-slate-100 p-2 sm:p-3">
              <iframe title={`Preview ${previewNote.title}`} src={previewUrl} className="h-full w-full rounded-2xl bg-white shadow-soft" />
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
