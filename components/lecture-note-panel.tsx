"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  ChevronDown,
  CircleHelp,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Lock,
  LockOpen,
  MoreVertical,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";

import { NOTE_DELETION_LABELS, noteDeletionConfirmText, readDeletionOutcome } from "@/lib/permanent-deletion/client";

type NoteVisibility = "PUBLIC" | "PRIVATE";
type NoteAccess = "FREE" | "LOCKED";

type LectureNote = {
  id: string;
  /** The note's own lecture: edits and deletions go to /api/lectures/{lectureId}/notes/{id}. */
  lectureId?: string;
  title: string;
  kind: "NOTE" | "SUPPORTING_MATERIAL";
  mimeType: string;
  sizeBytes: number;
  downloadCount: number;
  lastDownloadedAt: string | null;
  visibility: NoteVisibility;
  access: NoteAccess;
  /** Class-scoped listings only (the Notes page): the original upload instant; null for older notes. */
  uploadedAt?: string | null;
};

/**
 * Where the panel's notes come from.
 *  - { lectureId } (no classId): one lecture through its own API, exactly as
 *    before (the lecture management page, the classroom sidebar).
 *  - { classId } (no lectureId): the class's General Notes (its default
 *    lecture, resolved by the server): GET / POST /api/classes/{classId}/notes.
 *  - { classId, lectureId }: one normal lecture of that class, listed through
 *    GET /api/classes/{classId}/notes?lectureId= (newest upload first);
 *    uploads go to the lecture's own API.
 * Edits, deletions, previews and downloads always use the existing per-note routes.
 */
export type LectureNotePanelSource =
  | { lectureId: string; classId?: undefined }
  | { classId: string; lectureId?: string };

/** The list and upload endpoints for a source. */
export function noteEndpoints(source: LectureNotePanelSource): { list: string; upload: string; classScoped: boolean } {
  if (source.classId === undefined) {
    const base = `/api/lectures/${source.lectureId}/notes`;
    return { list: base, upload: base, classScoped: false };
  }
  const classBase = `/api/classes/${encodeURIComponent(source.classId)}/notes`;
  if (!source.lectureId) return { list: classBase, upload: classBase, classScoped: true };
  return {
    list: `${classBase}?lectureId=${encodeURIComponent(source.lectureId)}`,
    upload: `/api/lectures/${encodeURIComponent(source.lectureId)}/notes`,
    classScoped: true,
  };
}

const UPLOADED_AT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Colombo",
});

/** "24 Nov 2026, 14:05" in Sri Lankan time; null when absent or invalid. */
export function formatUploadedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : UPLOADED_AT.format(new Date(ms));
}

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

export function LectureNotePanel(
  props: LectureNotePanelSource & {
    onChanged?: () => Promise<void> | void;
    /** The list card's heading, subtitle and empty text (defaults: the lecture wording). */
    heading?: string;
    description?: string;
    emptyText?: string;
  }
) {
  const endpoints = noteEndpoints(props);
  const [notes, setNotes] = useState<LectureNote[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"NOTE" | "SUPPORTING_MATERIAL">("NOTE");
  const [visibility, setVisibility] = useState<NoteVisibility>("PRIVATE");
  const [access, setAccess] = useState<NoteAccess>("LOCKED");
  const [file, setFile] = useState<File | null>(null);
  const [previewNote, setPreviewNote] = useState<LectureNote | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // Stage 3.6: a deletion that is hidden but whose file is still being deleted (not a success).
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const deletingRef = useRef(false);
  // One upload / save at a time, even before the disabled button re-renders (double clicks).
  const savingRef = useRef(false);
  // Only the newest list request may update the panel (the class or lecture can change meanwhile).
  const loadSeqRef = useRef(0);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const selectedNote = useMemo(() => notes.find((note) => note.id === selectedNoteId) ?? null, [notes, selectedNoteId]);

  async function notifyChanged() {
    if (props.onChanged) {
      await props.onChanged();
    }
  }

  async function loadNotes(preferredId?: string | null) {
    const seq = ++loadSeqRef.current;
    setIsLoading(true);

    try {
      const response = await fetch(endpoints.list, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        // The lecture API answers the list itself; the class API { class, section, lecture, notes }.
        data?: LectureNote[] | { notes?: LectureNote[] };
      };
      if (seq !== loadSeqRef.current) return;

      if (!response.ok || !payload.success) {
        setNotes([]);
        throw new Error(readApiError(payload, "Failed to load notes."));
      }

      const list = (Array.isArray(payload.data) ? payload.data : payload.data?.notes) ?? [];
      setNotes(list);

      const nextSelectedId =
        (preferredId && list.some((item) => item.id === preferredId) ? preferredId : null) ??
        (selectedNoteId && list.some((item) => item.id === selectedNoteId) ? selectedNoteId : null) ??
        null;

      setSelectedNoteId(nextSelectedId);

      if (nextSelectedId) {
        const note = list.find((item) => item.id === nextSelectedId);
        if (note) {
          setTitle(note.title);
          setKind(note.kind);
          setVisibility(note.visibility);
          setAccess(note.access);
        }
      } else {
        setTitle("");
        setKind("NOTE");
        setVisibility("PRIVATE");
        setAccess("LOCKED");
      }
    } catch (error) {
      if (seq !== loadSeqRef.current) return;
      setErrorMessage(error instanceof Error ? error.message : "Failed to load notes.");
    } finally {
      if (seq === loadSeqRef.current) setIsLoading(false);
    }
  }

  useEffect(() => {
    // A different lecture / class: nothing of the previous one stays on screen.
    setNotes([]);
    setIsFormOpen(false);
    setPreviewNote(null);
    setErrorMessage(null);
    setSuccessMessage(null);
    setPendingMessage(null);
    void loadNotes(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoints.list]);

  /** The note's own lecture (class-scoped listings return it; the lecture API's notes belong to props.lectureId). */
  function lectureIdOf(note: LectureNote | null): string {
    return note?.lectureId ?? props.lectureId ?? "";
  }

  function resetForNew() {
    setSelectedNoteId(null);
    setTitle("");
    setKind("NOTE");
    setVisibility("PRIVATE");
    setAccess("LOCKED");
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
    setVisibility(note.visibility);
    setAccess(note.access);
    setFile(null);
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  function openCreateForm() {
    resetForNew();
    setIsFormOpen(true);
  }

  function openEditForm(noteId: string) {
    selectExisting(noteId);
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
  }

  async function saveNote() {
    if (savingRef.current) {
      return;
    }
    if (!title.trim()) {
      setErrorMessage("Title is required.");
      return;
    }
    if (!selectedNoteId && !file) {
      setErrorMessage("File is required for a new note.");
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      if (selectedNoteId) {
        const response = await fetch(`/api/lectures/${lectureIdOf(selectedNote)}/notes/${selectedNoteId}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: title.trim(),
            kind,
            visibility,
            access,
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
        setIsFormOpen(false);
      } else {
        if (!file) {
          setErrorMessage("File is required for a new note.");
          return;
        }

        const formData = new FormData();
        formData.set("title", title.trim());
        formData.set("kind", kind);
        formData.set("file", file);

        const response = await fetch(endpoints.upload, {
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
        setIsFormOpen(false);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save note.");
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  async function deleteSelected() {
    if (!selectedNote) {
      return;
    }

    // Permanent: an explicit, irreversible confirmation; one request at a time.
    if (deletingRef.current) {
      return;
    }
    const confirmed = window.confirm(noteDeletionConfirmText(selectedNote.title));
    if (!confirmed) {
      return;
    }

    deletingRef.current = true;
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    setPendingMessage(null);

    try {
      const response = await fetch(`/api/lectures/${lectureIdOf(selectedNote)}/notes/${selectedNote.id}`, {
        method: "DELETE",
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const outcome = readDeletionOutcome(response.status, payload, NOTE_DELETION_LABELS);

      if (outcome.kind === "error") {
        throw new Error(outcome.message);
      }

      await loadNotes(null);
      await notifyChanged();
      if (outcome.kind === "deleted") {
        setSuccessMessage(outcome.message);
      } else {
        setPendingMessage(outcome.message);
      }
      setIsFormOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : NOTE_DELETION_LABELS.failed);
    } finally {
      deletingRef.current = false;
      setIsSaving(false);
    }
  }

  const previewUrl = previewNote ? `/api/lectures/notes/${previewNote.id}/preview` : "";

  return (
    <div className="space-y-4">
      {errorMessage && !isFormOpen ? <p className="notice-error text-xs">{errorMessage}</p> : null}
      {successMessage ? <p className="notice-success text-xs">{successMessage}</p> : null}
      {pendingMessage ? (
        <p role="status" className="notice-info text-xs">
          {pendingMessage}
        </p>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
              <FileText size={15} />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-slate-900">{props.heading ?? "Existing notes"}</h4>
              <p className="text-[11px] text-muted">{props.description ?? "Browse lecture uploads and manage downloads."}</p>
            </div>
          </div>

          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{notes.length} total</span>
        </div>

        <div className="mt-3.5 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold text-slate-700">Add / organize files</p>
          <button
            type="button"
            onClick={openCreateForm}
            disabled={isSaving}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60 px-2.5 text-[11px] font-semibold text-white transition hover:bg-brand-600"
          >
            <Plus size={11} />
            Add new note
          </button>
        </div>

        {isLoading ? <p className="mt-3 text-xs text-muted">Loading notes...</p> : null}
        {!isLoading && notes.length === 0 && !errorMessage ? <p className="mt-3 text-xs text-muted">{props.emptyText ?? "No notes uploaded yet."}</p> : null}

        <div className="mt-3 space-y-2">
          {notes.map((note) => (
            <div
              key={note.id}
              className={`rounded-lg border p-3 transition ${
                selectedNoteId === note.id && isFormOpen
                  ? "border-brand-300 bg-brand-50/70"
                  : "border-slate-200 bg-white"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="inline-flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                  <FileText size={16} />
                  {note.mimeType === "application/pdf" ? (
                    <span className="mt-0.5 rounded bg-brand-600 px-1 py-px text-[8px] font-bold tracking-wide text-white">PDF</span>
                  ) : null}
                </div>

                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => openEditForm(note.id)} className="block w-full text-left">
                    <p className="break-words text-xs font-semibold text-slate-900">{note.title}</p>
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                          note.visibility === "PUBLIC"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {note.visibility === "PUBLIC" ? <Eye size={10} /> : <EyeOff size={10} />}
                        {note.visibility === "PUBLIC" ? "Public" : "Private"}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                          note.access === "FREE"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {note.access === "FREE" ? <LockOpen size={10} /> : <Lock size={10} />}
                        {note.access === "FREE" ? "Free" : "Locked"}
                      </span>
                    </span>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                      <span className="uppercase tracking-wide">{note.kind}</span>
                      <span>•</span>
                      <span>{formatBytes(note.sizeBytes)}</span>
                      <span>•</span>
                      <span>Downloads: {note.downloadCount}</span>
                    </p>
                    {endpoints.classScoped ? (
                      <p className="mt-1 block text-[10px] text-slate-500">
                        {formatUploadedAt(note.uploadedAt) ? `Uploaded ${formatUploadedAt(note.uploadedAt)}` : "Upload date not recorded"}
                      </p>
                    ) : null}
                    <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500">
                      <Calendar size={10} />
                      {note.lastDownloadedAt ? `Last downloaded ${new Date(note.lastDownloadedAt).toLocaleString()}` : "Added to lecture"}
                    </p>
                  </button>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <a
                      href={`/api/lectures/notes/${note.id}/download`}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      <Download size={11} />
                      Download
                    </a>

                    {note.mimeType === "application/pdf" ? (
                      <button
                        type="button"
                        onClick={() => setPreviewNote(note)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
                      >
                        <Eye size={11} />
                        Preview
                      </button>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => openEditForm(note.id)}
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
          <div className="fixed inset-0 z-[71] flex items-center justify-center p-4 max-sm:p-2">
            <div
              className="w-full max-h-[85vh] max-sm:max-h-[94dvh] overflow-y-auto scrollbar-thin rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                    <Plus size={15} />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">{selectedNote ? "Edit note" : "Add new note"}</h4>
                    <p className="text-[11px] text-muted">
                      {selectedNote ? "Update the selected note's details." : "Upload a new lecture file."}
                    </p>
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
                  <label className="form-label mb-1 block">Title</label>
                  <div className="relative">
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="File title"
                      className="control-input h-9 pr-12 text-sm"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-muted">
                      {title.length}/120
                    </span>
                  </div>
                </div>

                <div>
                  <label className="form-label mb-1 block">Kind</label>
                  <div className="relative">
                    <FolderOpen size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <ChevronDown size={12} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <select
                      value={kind}
                      onChange={(event) => setKind(event.target.value as "NOTE" | "SUPPORTING_MATERIAL")}
                      className="control-select h-9 w-full appearance-none pl-8 pr-7 text-sm"
                    >
                      <option value="NOTE">Note</option>
                      <option value="SUPPORTING_MATERIAL">Supporting material</option>
                    </select>
                  </div>
                </div>

                {selectedNote ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="form-label mb-1 block">Visibility</label>
                      <div className="relative">
                        {visibility === "PUBLIC" ? (
                          <Eye size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-emerald-500" />
                        ) : (
                          <EyeOff size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        )}
                        <ChevronDown size={12} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <select
                          value={visibility}
                          onChange={(event) => setVisibility(event.target.value as NoteVisibility)}
                          className="control-select h-9 w-full appearance-none pl-8 pr-7 text-sm"
                        >
                          <option value="PRIVATE">Private</option>
                          <option value="PUBLIC">Public</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="form-label mb-1 block">Access</label>
                      <div className="relative">
                        {access === "FREE" ? (
                          <LockOpen size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-emerald-500" />
                        ) : (
                          <Lock size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-amber-500" />
                        )}
                        <ChevronDown size={12} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <select
                          value={access}
                          onChange={(event) => setAccess(event.target.value as NoteAccess)}
                          className="control-select h-9 w-full appearance-none pl-8 pr-7 text-sm"
                        >
                          <option value="LOCKED">Locked</option>
                          <option value="FREE">Free</option>
                        </select>
                      </div>
                    </div>

                    <p className="col-span-2 flex items-start gap-1.5 text-[11px] text-muted">
                      <CircleHelp size={12} className="mt-0.5 shrink-0" />
                      <span>
                        Public notes appear on the class page. Free notes can be opened without
                        registering; locked notes require enrolment.
                      </span>
                    </p>
                  </div>
                ) : null}

                {!selectedNote ? (
                  <div className="rounded-lg border border-dashed border-brand-200 bg-brand-50/40 p-3">
                    <label className="form-label mb-1 block">Upload file</label>
                    <input
                      type="file"
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                      className="w-full text-xs text-slate-600"
                    />
                    <p className="mt-2 flex items-center gap-1 text-[11px] text-brand-700">
                      <FileText size={11} />
                      PDF, image, or document file for the lecture note/material.
                    </p>
                  </div>
                ) : (
                  <div className="notice-info flex items-start gap-1.5 text-[11px]">
                    <CircleHelp size={12} className="mt-0.5 shrink-0" />
                    <span>File replacement is not enabled. Upload a new note if needed.</span>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => void saveNote()}
                    disabled={isSaving}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 text-xs font-semibold text-white shadow-soft transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Save size={13} />
                    {isSaving ? "Saving..." : selectedNote ? "Save note" : "Upload note"}
                  </button>

                  {selectedNote ? (
                    <button
                      type="button"
                      onClick={() => void deleteSelected()}
                      disabled={isSaving}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Trash2 size={13} />
                      Delete permanently
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}

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
