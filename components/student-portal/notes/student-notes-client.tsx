"use client";

/*
 * The student's Notes page (/student/notes; Notes redesign Stage 3).
 *
 *  - Class: the student's ACTIVE enrolments in ACTIVE classes, read on the
 *    server by the page (app/student/notes/page.tsx); the notes API checks the
 *    enrolment again on every request.
 *  - General Notes (the default view): GET /api/student/classes/{id}/notes.
 *  - Lecture Notes: the class's normal lectures (GET /api/student/lectures
 *    ?classId&scheduled=1: never the default lecture), then
 *    GET /api/student/classes/{id}/notes?lectureId=... (another class's or an
 *    invalid lecture is refused by the server).
 *  - Files: only the API's `fileUrl` (the existing student file route; null
 *    while the note's month is locked), fetched first so an expired session,
 *    a 403 lock or a 404 shows a clear message; the route re-checks the
 *    enrolment and the monthly lock and records the view, as before.
 * Every list is newest upload first (the API's order). Switching the class,
 * the view or the lecture clears the list and the preview at once; a request
 * of an earlier selection is aborted and can never replace the current one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Download, Eye, FileText, Layers, Loader2, Maximize2, RefreshCw, X } from "lucide-react";

import { LockedResourceBadge } from "@/components/student-portal/locked-resource";
import { useStudentLiveRefetch } from "@/components/student-portal/use-student-live-events";
import {
  downloadName,
  fileTypeLabel,
  formatNoteSize,
  noteRequestErrorMessage,
  safeNoteFileUrl,
  studentLectureLabel,
  studentLecturesUrl,
  studentNotesUrl,
  uploadedLabel,
  type StudentNote,
  type StudentNotesClass,
  type StudentNotesLecture,
  type StudentNotesResponse,
} from "@/components/student-portal/notes/student-notes-helpers";

type View = "general" | "lecture";
type NotesLoad = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: StudentNotesResponse };
type LecturesLoad = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; items: StudentNotesLecture[]; page: number; totalPages: number };
type Preview = { noteId: string; title: string; state: "loading" } | { noteId: string; title: string; state: "ready"; url: string } | { noteId: string; title: string; state: "error"; message: string };

type Envelope<T> = { success?: boolean; data?: T; error?: { message?: string } };

async function readEnvelope<T>(response: Response): Promise<Envelope<T> | null> {
  try {
    return (await response.json()) as Envelope<T>;
  } catch {
    return null;
  }
}

const TAB = "inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition sm:flex-none";

/** The class shown first: the page's validated `?classId=` (one of `classes`), else the only class, else none. */
export function firstStudentNotesClass(classes: StudentNotesClass[], initialClassId?: string | null): string {
  if (initialClassId && classes.some((c) => c.id === initialClassId)) return initialClassId;
  return classes.length === 1 ? classes[0].id : "";
}

export function StudentNotesClient({ classes, initialClassId = null }: { classes: StudentNotesClass[]; initialClassId?: string | null }) {
  const [classId, setClassId] = useState(() => firstStudentNotesClass(classes, initialClassId));
  const [view, setView] = useState<View>("general");
  const [lectureId, setLectureId] = useState("");
  // A class chosen from the start (the link's class or the only class): General Notes are loading from the first render.
  const [notes, setNotes] = useState<NotesLoad>(() => (firstStudentNotesClass(classes, initialClassId) ? { state: "loading" } : { state: "idle" }));
  const [lectures, setLectures] = useState<LecturesLoad | null>(null);
  const [lecturePage, setLecturePage] = useState(1);
  const [notesAttempt, setNotesAttempt] = useState(0);
  const [lecturesAttempt, setLecturesAttempt] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fileMessage, setFileMessage] = useState<string | null>(null);
  const previewSeq = useRef(0);
  const objectUrl = useRef<string | null>(null);

  const closePreview = useCallback(() => {
    previewSeq.current += 1; // a file request still in flight is ignored
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setPreview(null);
    setFullscreen(false);
  }, []);

  useEffect(() => () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  // The notes of the current selection (General Notes, or the selected lecture's).
  const notesUrl = classId && (view === "general" || lectureId) ? studentNotesUrl(classId, view === "lecture" ? lectureId : null) : null;
  const shownNotesUrl = useRef<string | null>(null);
  useEffect(() => {
    // A new selection clears the list and the preview at once; a refresh of the
    // same selection (Refresh, a live update) keeps them until the new list arrives.
    const selectionChanged = shownNotesUrl.current !== notesUrl;
    shownNotesUrl.current = notesUrl;
    if (selectionChanged) {
      closePreview();
      setFileMessage(null);
    }
    if (!notesUrl) {
      setNotes({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    if (selectionChanged) setNotes({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(notesUrl, { cache: "no-store", signal: controller.signal });
        const payload = await readEnvelope<StudentNotesResponse>(response);
        if (controller.signal.aborted) return;
        if (!response.ok || !payload?.success || !payload.data) {
          setNotes({ state: "error", message: noteRequestErrorMessage(response.status, payload?.error?.message, "notes") });
          return;
        }
        setNotes({ state: "ready", data: payload.data });
      } catch {
        if (!controller.signal.aborted) setNotes({ state: "error", message: noteRequestErrorMessage(0, null, "notes") });
      }
    })();
    return () => controller.abort();
  }, [notesUrl, notesAttempt, closePreview]);

  // The previewed note was removed or became locked in a refreshed list: close its preview.
  const previewNoteId = preview?.noteId ?? null;
  useEffect(() => {
    if (!previewNoteId || notes.state !== "ready") return;
    const current = notes.data.notes.find((note) => note.id === previewNoteId);
    if (!current || !safeNoteFileUrl(current)) closePreview();
  }, [notes, previewNoteId, closePreview]);

  // The class's normal lectures, for the Lecture Notes selector (page by page).
  useEffect(() => {
    if (!classId || view !== "lecture") return;
    const controller = new AbortController();
    if (lecturePage === 1) setLectures({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(studentLecturesUrl(classId, lecturePage), { cache: "no-store", signal: controller.signal });
        const payload = await readEnvelope<{ items?: { kind: string; id: string; title?: string; date: string }[]; pagination?: { totalPages?: number } }>(response);
        if (controller.signal.aborted) return;
        if (!response.ok || !payload?.success || !payload.data) {
          setLectures({ state: "error", message: noteRequestErrorMessage(response.status, payload?.error?.message, "lectures") });
          return;
        }
        const page = (payload.data.items ?? [])
          .filter((item) => item.kind === "lecture")
          .map((item) => ({ id: item.id, title: item.title ?? "Lecture", date: item.date }));
        const totalPages = payload.data.pagination?.totalPages ?? 1;
        setLectures((previous) => ({
          state: "ready",
          items: lecturePage > 1 && previous?.state === "ready" ? [...previous.items, ...page] : page,
          page: lecturePage,
          totalPages,
        }));
      } catch {
        if (!controller.signal.aborted) setLectures({ state: "error", message: noteRequestErrorMessage(0, null, "lectures") });
      }
    })();
    return () => controller.abort();
  }, [classId, view, lecturePage, lecturesAttempt]);

  // A teacher adding or removing a note: reload the current list (the selection stays).
  useStudentLiveRefetch(() => {
    if (notesUrl) setNotesAttempt((n) => n + 1);
  });

  function chooseClass(next: string) {
    setClassId(next);
    setView("general"); // General Notes first for every class
    setLectureId("");
    setLectures(null);
    setLecturePage(1);
  }

  function chooseView(next: View) {
    setView(next);
    if (next === "general") setLectureId("");
  }

  async function openPreview(note: StudentNote) {
    const url = safeNoteFileUrl(note);
    if (!url) return;
    closePreview();
    setFileMessage(null);
    const seq = ++previewSeq.current;
    setPreview({ noteId: note.id, title: note.title, state: "loading" });
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (seq !== previewSeq.current) return;
      if (!response.ok) {
        const payload = await readEnvelope<unknown>(response);
        if (seq === previewSeq.current) setPreview({ noteId: note.id, title: note.title, state: "error", message: noteRequestErrorMessage(response.status, payload?.error?.message, "file") });
        return;
      }
      const blob = await response.blob();
      if (seq !== previewSeq.current) return;
      objectUrl.current = URL.createObjectURL(blob);
      setPreview({ noteId: note.id, title: note.title, state: "ready", url: objectUrl.current });
    } catch {
      if (seq === previewSeq.current) setPreview({ noteId: note.id, title: note.title, state: "error", message: noteRequestErrorMessage(0, null, "file") });
    }
  }

  async function download(note: StudentNote) {
    const url = safeNoteFileUrl(note);
    if (!url) return;
    setFileMessage(null);
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const payload = await readEnvelope<unknown>(response);
        setFileMessage(noteRequestErrorMessage(response.status, payload?.error?.message, "file"));
        return;
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = downloadName(note.title, note.mimeType);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    } catch {
      setFileMessage(noteRequestErrorMessage(0, null, "file"));
    }
  }

  if (classes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600" data-notes-empty="classes">
        You are not enrolled in an active class yet. Notes appear here once you join a class.
      </p>
    );
  }

  const list = notes.state === "ready" ? notes.data.notes : [];
  const generalView = view === "general";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Class and view */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] font-semibold text-slate-600 sm:max-w-sm">
          Class
          <select value={classId} onChange={(event) => chooseClass(event.target.value)} className="control-select h-9 w-full min-w-0 text-sm" data-notes-class-select>
            <option value="">Select a class</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {classId ? (
          <div role="tablist" aria-label="Notes" className="flex gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1" data-notes-view-tabs>
            <button
              type="button"
              role="tab"
              aria-selected={generalView}
              onClick={() => chooseView("general")}
              className={`${TAB} ${generalView ? "bg-emerald-600 text-white shadow-sm" : "text-slate-700 hover:bg-white"}`}
            >
              <BookOpen size={13} aria-hidden />
              General Notes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!generalView}
              onClick={() => chooseView("lecture")}
              className={`${TAB} ${!generalView ? "bg-brand-700 text-white shadow-sm" : "text-slate-700 hover:bg-white"}`}
            >
              <Layers size={13} aria-hidden />
              Lecture Notes
            </button>
          </div>
        ) : null}
      </div>

      {!classId ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600" data-notes-empty="no-class">
          Select a class to see its notes.
        </p>
      ) : (
        <section
          aria-label={generalView ? "General Notes" : "Lecture Notes"}
          className={`min-w-0 rounded-xl border p-3 ${generalView ? "border-emerald-200 bg-emerald-50/40" : "border-brand-200 bg-brand-50/30"}`}
          data-notes-section={view}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">{generalView ? "General Notes" : "Lecture Notes"}</h2>
              <p className="text-[11px] text-slate-500">
                {generalView ? "Notes for the whole class. Newest uploads first." : "Choose a lecture to see its notes. Newest uploads first."}
              </p>
            </div>
            {notesUrl ? (
              <button
                type="button"
                onClick={() => setNotesAttempt((n) => n + 1)}
                disabled={notes.state === "loading"}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                <RefreshCw size={11} aria-hidden />
                Refresh
              </button>
            ) : null}
          </div>

          {!generalView ? (
            <div className="mb-3">
              <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-slate-600">
                Lecture
                <select
                  value={lectureId}
                  onChange={(event) => setLectureId(event.target.value)}
                  disabled={lectures?.state !== "ready" || lectures.items.length === 0}
                  className="control-select h-9 w-full min-w-0 text-sm sm:max-w-md"
                  data-notes-lecture-select
                >
                  <option value="">
                    {lectures?.state === "loading" ? "Loading lectures…" : lectures?.state === "ready" && lectures.items.length === 0 ? "No lectures in this class yet" : "Select a lecture"}
                  </option>
                  {lectures?.state === "ready"
                    ? lectures.items.map((l) => (
                        <option key={l.id} value={l.id}>
                          {studentLectureLabel(l)}
                        </option>
                      ))
                    : null}
                </select>
              </label>
              {lectures?.state === "ready" && lectures.page < lectures.totalPages ? (
                <button type="button" onClick={() => setLecturePage((p) => p + 1)} className="mt-1.5 text-[11px] font-semibold text-brand-700 hover:underline">
                  Load older lectures
                </button>
              ) : null}
              {lectures?.state === "error" ? (
                <div role="alert" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
                  <span>{lectures.message}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setLecturePage(1);
                      setLecturesAttempt((n) => n + 1);
                    }}
                    className="rounded-md border border-rose-200 bg-white px-2 py-0.5 font-semibold"
                  >
                    Try again
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {fileMessage ? (
            <p role="alert" className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
              {fileMessage}
            </p>
          ) : null}

          {!generalView && !lectureId ? (
            <p className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-center text-xs text-slate-600" data-notes-empty="no-lecture">
              {lectures?.state === "ready" && lectures.items.length === 0 ? "This class has no lectures yet." : "Select a lecture to see its notes."}
            </p>
          ) : notes.state === "loading" ? (
            <div role="status" className="space-y-2" aria-label="Loading notes">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-white/80" />
              ))}
            </div>
          ) : notes.state === "error" ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
              <span>{notes.message}</span>
              <button type="button" onClick={() => setNotesAttempt((n) => n + 1)} className="rounded-md border border-rose-200 bg-white px-2 py-0.5 font-semibold">
                Try again
              </button>
            </div>
          ) : notes.state === "ready" && list.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-center text-xs text-slate-600" data-notes-empty="no-notes">
              {generalView ? "No general notes for this class yet." : "No notes for this lecture yet."}
            </p>
          ) : (
            <ul className="space-y-2" data-notes-list>
              {list.map((note) => {
                const fileUrl = safeNoteFileUrl(note);
                const locked = note.resourceAccess?.locked === true;
                return (
                  <li
                    key={note.id}
                    className={`rounded-xl border bg-white p-2.5 ${preview?.noteId === note.id ? "border-emerald-400" : locked ? "border-amber-200" : "border-slate-200"}`}
                    data-note-state={locked ? "locked" : "available"}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${note.kind === "NOTE" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>
                        {note.kind === "NOTE" ? "Note" : "Material"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-xs font-semibold text-slate-900">{note.title}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-slate-500">
                          <span className="inline-flex items-center gap-0.5">
                            <FileText size={10} aria-hidden />
                            {fileTypeLabel(note.mimeType)}
                          </span>
                          <span aria-hidden>•</span>
                          <span>{formatNoteSize(note.sizeBytes)}</span>
                          <span aria-hidden>•</span>
                          <span>{uploadedLabel(note.uploadedAt)}</span>
                        </p>
                      </div>
                    </div>
                    {locked ? (
                      <div className="mt-2">
                        <LockedResourceBadge lock={note.resourceAccess} classId={classId} />
                      </div>
                    ) : fileUrl ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => void openPreview(note)}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                        >
                          <Eye size={11} aria-hidden /> Preview
                        </button>
                        <button
                          type="button"
                          onClick={() => void download(note)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <Download size={11} aria-hidden /> Download
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {preview ? (
            <div className="mt-3" data-notes-preview>
              <div className="mb-1.5 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                <p className="min-w-0 break-words text-xs font-medium text-slate-700">{preview.title}</p>
                <div className="flex shrink-0 gap-1.5">
                  {preview.state === "ready" ? (
                    <button type="button" onClick={() => setFullscreen(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">
                      <Maximize2 size={11} aria-hidden /> Fullscreen
                    </button>
                  ) : null}
                  <button type="button" onClick={closePreview} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">
                    Close
                  </button>
                </div>
              </div>
              {preview.state === "loading" ? (
                <p role="status" className="flex h-40 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-xs text-slate-500">
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                  Opening the file…
                </p>
              ) : preview.state === "error" ? (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
                  {preview.message}
                </p>
              ) : (
                <iframe key={preview.url} src={preview.url} title={preview.title} className="h-[60vh] w-full rounded-xl border border-slate-200 bg-white sm:h-[480px]" />
              )}
            </div>
          ) : null}
        </section>
      )}

      {fullscreen && preview?.state === "ready" ? (
        <div className="fixed inset-0 z-[90] flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label={preview.title}>
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <p className="min-w-0 break-words text-sm font-medium text-white">{preview.title}</p>
            <button type="button" onClick={() => setFullscreen(false)} className="inline-flex items-center gap-1 rounded-lg border border-white/30 px-2 py-1 text-xs font-semibold text-white hover:bg-white/10">
              <X size={12} aria-hidden /> Close
            </button>
          </div>
          <iframe key={`fs-${preview.url}`} src={preview.url} title={`${preview.title} (fullscreen)`} className="min-h-0 w-full flex-1 bg-white" />
        </div>
      ) : null}
    </div>
  );
}
