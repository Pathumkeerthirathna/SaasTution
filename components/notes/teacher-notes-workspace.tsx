"use client";

/*
 * The teacher's Notes page (/dashboard/notes; Notes redesign Stage 2).
 *
 *  - Class: one of the teacher's classes (GET /api/classes, as the other
 *    dashboard pages load them). Nothing about notes is loaded before a class
 *    is chosen.
 *  - General Notes: the class's notes that belong to no lecture (its default
 *    lecture, resolved by the server): LectureNotePanel with { classId }
 *    (GET / POST /api/classes/{id}/notes). Shown as soon as a class is chosen.
 *  - Lecture Notes: a selector of the class's NORMAL lectures only (GET
 *    /api/lectures?classId=..., which never returns a default lecture), then
 *    LectureNotePanel with { classId, lectureId } (GET
 *    /api/classes/{id}/notes?lectureId=..., uploads to the lecture's own API).
 *
 * Upload, edit, delete, preview and download are the existing panel's
 * (components/lecture-note-panel.tsx); every list is newest upload first.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, FileText, Layers, Loader2, NotebookPen } from "lucide-react";

import { LectureNotePanel } from "@/components/lecture-note-panel";

export type NotesClassOption = { id: string; name: string };
export type NotesLectureOption = { id: string; title: string; date: string };

/** The teacher's classes for the selector (the API's maximum page). */
export const NOTES_CLASSES_URL = "/api/classes?page=1&pageSize=100";
export const NOTES_LECTURES_PAGE_SIZE = 100;

/** One page of a class's normal lectures, newest first (the API never lists a default lecture). */
export function notesLecturesUrl(classId: string, page: number): string {
  const query = new URLSearchParams({ classId, page: String(page), pageSize: String(NOTES_LECTURES_PAGE_SIZE), sortOrder: "desc" });
  return `/api/lectures?${query.toString()}`;
}

const LECTURE_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Colombo" });

/** "Kinematics · 24 Nov 2026" (Sri Lankan date). */
export function notesLectureLabel(lecture: NotesLectureOption): string {
  const ms = Date.parse(lecture.date);
  return Number.isNaN(ms) ? lecture.title : `${lecture.title} · ${LECTURE_DATE.format(new Date(ms))}`;
}

type Envelope<T> = { success?: boolean; data?: T; error?: { message?: string }; pagination?: { hasNextPage?: boolean } };

async function getJson<T>(url: string, signal: AbortSignal, fallback: string): Promise<{ data: T; hasNextPage: boolean }> {
  const response = await fetch(url, { cache: "no-store", signal });
  let payload: Envelope<T> | null = null;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.success || payload.data === undefined) throw new Error(payload?.error?.message ?? fallback);
  return { data: payload.data, hasNextPage: Boolean(payload.pagination?.hasNextPage) };
}

const SELECT_CLASS = "control-select h-10 w-full min-w-0 text-sm";

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; items: T[]; hasNextPage: boolean; page: number };

export function TeacherNotesWorkspace() {
  const [classes, setClasses] = useState<Load<NotesClassOption>>({ state: "loading" });
  const [classAttempt, setClassAttempt] = useState(0);
  const [classId, setClassId] = useState("");
  const [lectures, setLectures] = useState<Load<NotesLectureOption> | null>(null);
  const [lectureId, setLectureId] = useState("");
  const [lecturePage, setLecturePage] = useState(1);
  const [lectureAttempt, setLectureAttempt] = useState(0);
  const lectureRequest = useRef<AbortController | null>(null);

  // The teacher's classes.
  useEffect(() => {
    const controller = new AbortController();
    setClasses({ state: "loading" });
    getJson<NotesClassOption[]>(NOTES_CLASSES_URL, controller.signal, "Could not load your classes.")
      .then(({ data }) => setClasses({ state: "ready", items: data.map((c) => ({ id: c.id, name: c.name })), hasNextPage: false, page: 1 }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setClasses({ state: "error", message: error instanceof Error ? error.message : "Could not load your classes." });
      });
    return () => controller.abort();
  }, [classAttempt]);

  // The selected class's normal lectures (page by page; a new class starts again at page 1).
  useEffect(() => {
    lectureRequest.current?.abort();
    if (!classId) {
      setLectures(null);
      return;
    }
    const controller = new AbortController();
    lectureRequest.current = controller;
    if (lecturePage === 1) setLectures({ state: "loading" });
    getJson<NotesLectureOption[]>(notesLecturesUrl(classId, lecturePage), controller.signal, "Could not load the lectures of this class.")
      .then(({ data, hasNextPage }) => {
        if (controller.signal.aborted) return;
        const page = data.map((l) => ({ id: l.id, title: l.title, date: l.date }));
        setLectures((previous) => ({
          state: "ready",
          items: lecturePage > 1 && previous?.state === "ready" ? [...previous.items, ...page] : page,
          hasNextPage,
          page: lecturePage,
        }));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLectures({ state: "error", message: error instanceof Error ? error.message : "Could not load the lectures of this class." });
      });
    return () => controller.abort();
  }, [classId, lecturePage, lectureAttempt]);

  const chooseClass = useCallback((next: string) => {
    setClassId(next);
    setLectureId("");
    setLecturePage(1);
  }, []);

  const selectedClass = classes.state === "ready" ? classes.items.find((c) => c.id === classId) ?? null : null;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <section aria-labelledby="notes-page-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex min-w-0 items-center gap-3 border-b border-slate-200 p-3 sm:px-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#32598A] text-white">
            <NotebookPen size={18} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 id="notes-page-heading" className="text-xl font-semibold tracking-tight text-slate-900">
              Notes
            </h1>
            <p className="break-words text-[12px] text-slate-500 sm:text-[13px]">General notes for a whole class, and notes for each lecture. Newest uploads first.</p>
          </div>
        </header>

        <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-end sm:px-4">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] font-semibold text-slate-600 sm:max-w-md">
            Class
            <select
              value={classId}
              onChange={(event) => chooseClass(event.target.value)}
              disabled={classes.state !== "ready" || classes.items.length === 0}
              className={SELECT_CLASS}
              data-notes-class-select
            >
              <option value="">{classes.state === "loading" ? "Loading classes…" : "Select a class"}</option>
              {classes.state === "ready"
                ? classes.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))
                : null}
            </select>
          </label>
          {classes.state === "loading" ? (
            <p role="status" className="flex items-center gap-1.5 text-xs text-slate-500 sm:pb-2.5">
              <Loader2 size={13} className="animate-spin" aria-hidden />
              Loading classes…
            </p>
          ) : null}
        </div>

        {classes.state === "error" ? (
          <div role="alert" className="mx-3 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 sm:mx-4">
            <span>{classes.message}</span>
            <button type="button" onClick={() => setClassAttempt((n) => n + 1)} className="rounded-md border border-rose-200 bg-white px-2 py-1 font-semibold hover:bg-rose-50">
              Try again
            </button>
          </div>
        ) : null}
        {classes.state === "ready" && classes.items.length === 0 ? (
          <p className="mx-3 mb-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-600 sm:mx-4" data-notes-empty="classes">
            You have no classes yet. Create a class first, then add its notes here.
          </p>
        ) : null}
      </section>

      {!classId ? (
        classes.state === "ready" && classes.items.length > 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600" data-notes-empty="no-class">
            Select a class to see and manage its notes.
          </p>
        ) : null
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <section aria-labelledby="general-notes-heading" className="flex min-w-0 flex-col gap-2" data-notes-section="general">
            <h2 id="general-notes-heading" className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <BookOpen size={16} className="text-[#32598A]" aria-hidden />
              General Notes
              {selectedClass ? <span className="min-w-0 break-words text-sm font-normal text-slate-500">· {selectedClass.name}</span> : null}
            </h2>
            <LectureNotePanel
              key={`general:${classId}`}
              classId={classId}
              heading="General notes"
              description="Notes for the whole class, not tied to a lecture."
              emptyText="No general notes yet. Use Add new note to upload one."
            />
          </section>

          <section aria-labelledby="lecture-notes-heading" className="flex min-w-0 flex-col gap-2" data-notes-section="lecture">
            <h2 id="lecture-notes-heading" className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <Layers size={16} className="text-[#32598A]" aria-hidden />
              Lecture Notes
            </h2>
            <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-600">
                Lecture
                <select
                  value={lectureId}
                  onChange={(event) => setLectureId(event.target.value)}
                  disabled={lectures?.state !== "ready" || lectures.items.length === 0}
                  className={SELECT_CLASS}
                  data-notes-lecture-select
                >
                  <option value="">
                    {lectures?.state === "loading" ? "Loading lectures…" : lectures?.state === "ready" && lectures.items.length === 0 ? "No lectures in this class" : "Select a lecture"}
                  </option>
                  {lectures?.state === "ready"
                    ? lectures.items.map((l) => (
                        <option key={l.id} value={l.id}>
                          {notesLectureLabel(l)}
                        </option>
                      ))
                    : null}
                </select>
              </label>
              {lectures?.state === "ready" && lectures.hasNextPage ? (
                <button type="button" onClick={() => setLecturePage((p) => p + 1)} className="mt-2 text-xs font-semibold text-brand-700 hover:underline">
                  Load older lectures
                </button>
              ) : null}
              {lectures?.state === "error" ? (
                <div role="alert" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                  <span>{lectures.message}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setLecturePage(1);
                      setLectureAttempt((n) => n + 1);
                    }}
                    className="rounded-md border border-rose-200 bg-white px-2 py-1 font-semibold hover:bg-rose-50"
                  >
                    Try again
                  </button>
                </div>
              ) : null}
            </div>

            {lectureId ? (
              <LectureNotePanel
                key={`lecture:${classId}:${lectureId}`}
                classId={classId}
                lectureId={lectureId}
                heading="Lecture notes"
                description="Notes of the selected lecture."
                emptyText="No notes for this lecture yet."
              />
            ) : (
              <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600" data-notes-empty="no-lecture">
                <FileText size={15} className="shrink-0 text-slate-400" aria-hidden />
                {lectures?.state === "ready" && lectures.items.length === 0 ? "This class has no lectures yet." : "Select a lecture to see its notes."}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
