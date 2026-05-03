"use client";

import { useEffect, useMemo, useState } from "react";

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

  return (
    <div className="mt-4 rounded-xl border border-black/10 p-4 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Notes & materials</p>
        <button
          type="button"
          onClick={resetForNew}
          className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background"
        >
          Add new note
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
          <label className="text-xs font-semibold text-muted">Title</label>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="File title"
            className="mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
          />

          <label className="mt-3 block text-xs font-semibold text-muted">Kind</label>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as "NOTE" | "SUPPORTING_MATERIAL")}
            className="mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
          >
            <option value="NOTE">Note</option>
            <option value="SUPPORTING_MATERIAL">Supporting material</option>
          </select>

          {!selectedNote ? (
            <>
              <label className="mt-3 block text-xs font-semibold text-muted">Upload file</label>
              <input
                type="file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="mt-1 w-full text-xs"
              />
            </>
          ) : (
            <p className="mt-3 text-xs text-muted">File replacement is not enabled. Upload a new note if needed.</p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void saveNote()}
              disabled={isSaving}
              className="rounded-lg bg-foreground px-3 py-2 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? "Saving..." : selectedNote ? "Save note" : "Upload note"}
            </button>

            {selectedNote ? (
              <button
                type="button"
                onClick={() => void deleteSelected()}
                disabled={isSaving}
                className="rounded-lg border border-red-300 px-3 py-2 text-xs font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Delete note
              </button>
            ) : null}
          </div>
        </section>

        <aside className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <p className="text-sm font-semibold">Existing notes</p>
          {isLoading ? <p className="mt-2 text-xs text-muted">Loading notes...</p> : null}
          {!isLoading && notes.length === 0 ? <p className="mt-2 text-xs text-muted">No notes uploaded yet.</p> : null}

          <div className="mt-3 space-y-2">
            {notes.map((note) => (
              <div
                key={note.id}
                className={`rounded-lg border px-3 py-2 ${
                  selectedNoteId === note.id
                    ? "border-foreground bg-black/[0.03] dark:bg-white/[0.04]"
                    : "border-black/10 dark:border-white/10"
                }`}
              >
                <button type="button" onClick={() => selectExisting(note.id)} className="w-full text-left">
                  <p className="text-sm font-semibold">{note.title}</p>
                  <p className="mt-1 text-xs text-muted">{note.kind} • {formatBytes(note.sizeBytes)} • Downloads: {note.downloadCount}</p>
                </button>

                <div className="mt-2 flex flex-wrap gap-2">
                  <a
                    href={`/api/lectures/notes/${note.id}/download`}
                    className="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold dark:border-white/20"
                  >
                    Download
                  </a>

                  {note.mimeType === "application/pdf" ? (
                    <button
                      type="button"
                      onClick={() => setPreviewNote(note)}
                      className="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold dark:border-white/20"
                    >
                      Preview
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {previewNote ? (
        <>
          <div className="fixed inset-0 z-[80] bg-black/40" onClick={() => setPreviewNote(null)} aria-hidden />
          <aside className="fixed inset-y-0 right-0 z-[90] h-full w-full transform overflow-hidden border-l border-black/10 bg-white shadow-2xl transition-transform duration-200 dark:border-white/10 dark:bg-card">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-black/10 bg-white px-4 py-4 dark:border-white/10 dark:bg-card sm:px-6">
              <div>
                <p className="text-sm font-semibold">PDF Preview</p>
                <p className="text-xs text-muted">{previewNote.title}</p>
              </div>

              <button
                type="button"
                onClick={() => setPreviewNote(null)}
                className="rounded-lg border border-black/15 px-3 py-1 text-sm font-semibold dark:border-white/20"
              >
                Close
              </button>
            </div>

            <div className="h-[calc(100%-69px)] bg-slate-100 p-2 sm:p-3 dark:bg-black/20">
              <iframe title={`Preview ${previewNote.title}`} src={previewUrl} className="h-full w-full rounded-lg bg-white" />
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
