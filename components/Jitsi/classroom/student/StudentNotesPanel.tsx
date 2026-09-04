"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, FileText, Loader2 } from "lucide-react";

type Note = {
  id: string;
  title: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
};

function formatBytes(bytes: number) {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Read-only view of a lecture's notes for a student inside the live session.
 * Students can preview and download; they cannot add, edit or delete.
 */
export default function StudentNotesPanel({ lectureId }: { lectureId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
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
        data?: { lecture?: { notes?: Note[] } };
        error?: { message?: string };
      };
      if (!res.ok || !json.success || !json.data?.lecture) {
        throw new Error(json.error?.message ?? "Failed to load notes.");
      }
      setNotes(json.data.lecture.notes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notes.");
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
            <FileText size={15} />
          </span>
          <div>
            <h4 className="text-sm font-semibold text-slate-900">Lecture notes</h4>
            <p className="text-[11px] text-slate-500">
              Preview or download the materials for this lecture.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" />
            Loading notes…
          </div>
        ) : error ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        ) : notes.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-emerald-200 bg-emerald-50/60 px-3 py-3 text-center text-xs text-emerald-700">
            No notes have been uploaded for this lecture yet.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {notes.map((note) => {
              const base = `/api/student/lectures/${lectureId}/notes/${note.id}/file`;
              return (
                <div
                  key={note.id}
                  className="rounded-lg border border-slate-200 bg-white p-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="inline-flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
                      <FileText size={16} />
                      {note.mimeType === "application/pdf" ? (
                        <span className="mt-0.5 rounded bg-emerald-600 px-1 py-px text-[8px] font-bold tracking-wide text-white">
                          PDF
                        </span>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-900">
                        {note.title}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {note.kind === "NOTE" ? "Note" : "Material"} ·{" "}
                        {formatBytes(note.sizeBytes)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <a
                          href={base}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                        >
                          <ExternalLink size={11} /> Preview
                        </a>
                        <a
                          href={base}
                          download={note.title}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <Download size={11} /> Download
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
