"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookMarked, FileText, ArrowUpRight, ArrowRight, CheckCircle2 } from "lucide-react";

import { useStudentLiveEvent } from "@/components/student-portal/use-student-live-events";

type Note = {
  id: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  lectureId: string;
  lectureTitle: string;
  className: string;
  date: string;
};

function fmtDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function DashboardStudyNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/student/dashboard/notes", { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; data?: { notes?: Note[] } };
      if (json.success && json.data?.notes) setNotes(json.data.notes);
    } catch {
      /* keep last snapshot */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: opening a note marks it viewed and signals `counts-stale`, which
  // drops it from this list.
  useStudentLiveEvent("counts-stale", () => void load());

  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-gradient-to-r from-emerald-50 to-white px-4 py-3 sm:px-5">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-bold text-foreground">
          <BookMarked size={14} className="text-emerald-600" />
          Study material notes
        </h2>
        <div className="flex items-center gap-2">
          {!loading && notes.length > 0 ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
              {notes.length} unviewed
            </span>
          ) : null}
          <Link
            href="/student/lectures?notes=unviewed"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
          >
            View all <ArrowRight size={12} />
          </Link>
        </div>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <p className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-emerald-200 bg-emerald-50/60 p-5 text-center text-xs font-medium text-emerald-700">
            <CheckCircle2 size={13} />
            You&apos;ve viewed all lecture notes.
          </p>
        ) : (
          <ul className="space-y-2">
            {notes.map((note) => (
              <li key={note.id}>
                <a
                  href={`/api/student/lectures/${note.lectureId}/notes/${note.id}/file`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-3 rounded-lg border border-brand-100 p-2.5 transition-colors hover:bg-emerald-50/40"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                    <FileText size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900 break-words sm:truncate">{note.title}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500 break-words sm:truncate">
                      {note.className} · {note.lectureTitle}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-400">{fmtDate(note.date)}</p>
                  </div>
                  <ArrowUpRight size={13} className="mt-1 shrink-0 text-slate-300" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
