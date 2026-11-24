"use client";

/*
 * The teacher's Recorded Lectures page (/dashboard/recorded-lectures;
 * Recorded Lectures redesign Stage 2).
 *
 *  - Class: one of the teacher's classes (GET /api/classes, as the other
 *    dashboard pages load them). Nothing is loaded before a class is chosen.
 *  - General Recordings: GET /api/classes/{id}/recorded-lectures (the server
 *    resolves the class's default lecture; its id is never sent from here),
 *    managed by the existing TeacherRecordingsClient in its GENERAL scope:
 *    uploads through POST /api/classes/{id}/recorded-lectures/uploads, no
 *    publication controls, no lecture date.
 *  - Lecture Recordings: a selector of the class's NORMAL lectures (GET
 *    /api/lectures?classId=..., never a default lecture), then
 *    GET /api/classes/{id}/recorded-lectures?lectureId=... and the same client
 *    in its LECTURE scope (uploads through the lecture's own start route,
 *    exactly as on the lecture page).
 * Upload, resume, pause, cancel, verification, edit, preview and delete are
 * the existing client's and upload engine's. Switching the class or the
 * lecture clears the old lists at once; an older response never replaces the
 * current selection; while an upload is sending, switching asks first (the
 * section's uploads are then paused, resumable later).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Film, Layers, Loader2, Video } from "lucide-react";

import type { TeacherRecordingDto } from "@/lib/recorded-lectures/teacher-dto";
import { TeacherRecordingsClient, type TeacherRecordingsInitial } from "@/components/recorded-lectures/teacher-recordings-client";

export type RecordingsClassOption = { id: string; name: string };
export type RecordingsLectureOption = { id: string; title: string; date: string };

export const RECORDINGS_CLASSES_URL = "/api/classes?page=1&pageSize=100";
export const RECORDINGS_LECTURES_PAGE_SIZE = 100;

/** One page of a class's normal lectures, newest first (the API never lists a default lecture). */
export function recordingsLecturesUrl(classId: string, page: number): string {
  const query = new URLSearchParams({ classId, page: String(page), pageSize: String(RECORDINGS_LECTURES_PAGE_SIZE), sortOrder: "desc" });
  return `/api/lectures?${query.toString()}`;
}

/** A class section's recordings: General (no lectureId) or one normal lecture. */
export function classRecordingsUrl(classId: string, lectureId?: string | null): string {
  const base = `/api/classes/${encodeURIComponent(classId)}/recorded-lectures`;
  return lectureId ? `${base}?lectureId=${encodeURIComponent(lectureId)}` : base;
}

const LECTURE_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Colombo" });

/** "Kinematics · 24 Nov 2026" (Sri Lankan date). */
export function recordingsLectureLabel(lecture: RecordingsLectureOption): string {
  const ms = Date.parse(lecture.date);
  return Number.isNaN(ms) ? lecture.title : `${lecture.title} · ${LECTURE_DATE.format(new Date(ms))}`;
}

type ClassRecordingsResponse = {
  class: { id: string; name: string };
  section: "GENERAL" | "LECTURE";
  lecture: { id: string; title: string; date: string; isDefault: boolean };
  recordings: TeacherRecordingDto[];
  nextPartNumber: number;
  limits: TeacherRecordingsInitial["limits"];
};

/** The client's initial data from a class-scoped list (General: its own title, never the default lecture's). */
export function toRecordingsInitial(data: ClassRecordingsResponse): TeacherRecordingsInitial {
  return {
    lecture: {
      id: data.lecture.id,
      title: data.section === "GENERAL" ? "General recordings" : data.lecture.title,
      date: data.lecture.date,
      className: data.class.name,
    },
    recordings: data.recordings,
    nextPartNumber: data.nextPartNumber,
    limits: data.limits,
  };
}

type Envelope<T> = { success?: boolean; data?: T; error?: { code?: string; message?: string }; pagination?: { hasNextPage?: boolean } };

/** A request's failure message by status (the server's own message when it sent one). */
export function recordingsErrorMessage(status: number, serverMessage: string | null | undefined, fallback: string): string {
  if (status === 401) return "Your session has ended. Please sign in again.";
  if (status === 503) return "Recorded lectures are not available right now. Please try again later.";
  return serverMessage || fallback;
}

async function getJson<T>(url: string, signal: AbortSignal, fallback: string): Promise<{ data: T; hasNextPage: boolean }> {
  const response = await fetch(url, { cache: "no-store", signal });
  let payload: Envelope<T> | null = null;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.success || payload.data === undefined) {
    throw new Error(recordingsErrorMessage(response.status, payload?.error?.message, fallback));
  }
  return { data: payload.data, hasNextPage: Boolean(payload.pagination?.hasNextPage) };
}

type Load<T> = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };
type LecturesLoad = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; items: RecordingsLectureOption[]; hasNextPage: boolean };

/** Loads a class section's recordings; a new url clears the old data at once and drops any older response. */
function useSectionRecordings(url: string | null, attempt: number): Load<TeacherRecordingsInitial> {
  const [load, setLoad] = useState<Load<TeacherRecordingsInitial>>({ state: "idle" });
  useEffect(() => {
    if (!url) {
      setLoad({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    setLoad({ state: "loading" });
    getJson<ClassRecordingsResponse>(url, controller.signal, "The recordings could not be loaded.")
      .then(({ data }) => {
        if (!controller.signal.aborted) setLoad({ state: "ready", data: toRecordingsInitial(data) });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ state: "error", message: error instanceof Error ? error.message : "The recordings could not be loaded." });
      });
    return () => controller.abort();
  }, [url, attempt]);
  return load;
}

const SWITCH_WHILE_UPLOADING = "An upload is still sending. Switching now pauses it (you can resume it later from the recording). Switch anyway?";

export function TeacherRecordingsWorkspace({ teacherId }: { teacherId: string }) {
  const [classes, setClasses] = useState<{ state: "loading" } | { state: "error"; message: string } | { state: "ready"; items: RecordingsClassOption[] }>({ state: "loading" });
  const [classAttempt, setClassAttempt] = useState(0);
  const [classId, setClassId] = useState("");
  const [lectureId, setLectureId] = useState("");
  const [lectures, setLectures] = useState<LecturesLoad | null>(null);
  const [lecturePage, setLecturePage] = useState(1);
  const [lecturesAttempt, setLecturesAttempt] = useState(0);
  const [generalAttempt, setGeneralAttempt] = useState(0);
  const [lectureAttempt, setLectureAttempt] = useState(0);
  // Which sections are sending bytes right now (asked before switching away).
  const sendingRef = useRef<{ general: boolean; lecture: boolean }>({ general: false, lecture: false });
  const onGeneralSending = useCallback((sending: boolean) => {
    sendingRef.current.general = sending;
  }, []);
  const onLectureSending = useCallback((sending: boolean) => {
    sendingRef.current.lecture = sending;
  }, []);

  const general = useSectionRecordings(classId ? classRecordingsUrl(classId) : null, generalAttempt);
  const lecture = useSectionRecordings(classId && lectureId ? classRecordingsUrl(classId, lectureId) : null, lectureAttempt);

  // The teacher's classes.
  useEffect(() => {
    const controller = new AbortController();
    setClasses({ state: "loading" });
    getJson<RecordingsClassOption[]>(RECORDINGS_CLASSES_URL, controller.signal, "Could not load your classes.")
      .then(({ data }) => {
        if (!controller.signal.aborted) setClasses({ state: "ready", items: data.map((c) => ({ id: c.id, name: c.name })) });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setClasses({ state: "error", message: error instanceof Error ? error.message : "Could not load your classes." });
      });
    return () => controller.abort();
  }, [classAttempt]);

  // The class's normal lectures for the selector (page by page; a new class starts again at page 1).
  useEffect(() => {
    if (!classId) {
      setLectures(null);
      return;
    }
    const controller = new AbortController();
    if (lecturePage === 1) setLectures({ state: "loading" });
    getJson<RecordingsLectureOption[]>(recordingsLecturesUrl(classId, lecturePage), controller.signal, "Could not load the lectures of this class.")
      .then(({ data, hasNextPage }) => {
        if (controller.signal.aborted) return;
        const page = data.map((l) => ({ id: l.id, title: l.title, date: l.date }));
        setLectures((previous) => ({ state: "ready", items: lecturePage > 1 && previous?.state === "ready" ? [...previous.items, ...page] : page, hasNextPage }));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLectures({ state: "error", message: error instanceof Error ? error.message : "Could not load the lectures of this class." });
      });
    return () => controller.abort();
  }, [classId, lecturePage, lecturesAttempt]);

  function confirmLeave(sections: ("general" | "lecture")[]): boolean {
    const sending = sections.some((section) => sendingRef.current[section]);
    return !sending || window.confirm(SWITCH_WHILE_UPLOADING);
  }

  function chooseClass(next: string) {
    if (next === classId || !confirmLeave(["general", "lecture"])) return;
    setClassId(next);
    setLectureId("");
    setLecturePage(1);
  }

  function chooseLecture(next: string) {
    if (next === lectureId || !confirmLeave(["lecture"])) return;
    setLectureId(next);
  }

  const selectedClass = classes.state === "ready" ? classes.items.find((c) => c.id === classId) ?? null : null;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <section aria-labelledby="recordings-page-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex min-w-0 items-center gap-3 border-b border-slate-200 p-3 sm:px-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#32598A] text-white">
            <Video size={18} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 id="recordings-page-heading" className="text-xl font-semibold tracking-tight text-slate-900">
              Recorded Lectures
            </h1>
            <p className="break-words text-[12px] text-slate-500 sm:text-[13px]">General recordings for a whole class, and recordings for each lecture.</p>
          </div>
        </header>
        <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-end sm:px-4">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] font-semibold text-slate-600 sm:max-w-md">
            Class
            <select
              value={classId}
              onChange={(event) => chooseClass(event.target.value)}
              disabled={classes.state !== "ready" || classes.items.length === 0}
              className="control-select h-10 w-full min-w-0 text-sm"
              data-recordings-class-select
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
        </div>
        {classes.state === "error" ? (
          <div role="alert" className="mx-3 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 sm:mx-4">
            <span>{classes.message}</span>
            <button type="button" onClick={() => setClassAttempt((n) => n + 1)} className="rounded-md border border-rose-200 bg-white px-2 py-1 font-semibold">
              Try again
            </button>
          </div>
        ) : null}
        {classes.state === "ready" && classes.items.length === 0 ? (
          <p className="mx-3 mb-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-600 sm:mx-4" data-recordings-empty="classes">
            You have no classes yet. Create a class first, then add its recordings here.
          </p>
        ) : null}
      </section>

      {!classId ? (
        classes.state === "ready" && classes.items.length > 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600" data-recordings-empty="no-class">
            Select a class to manage its recordings.
          </p>
        ) : null
      ) : (
        <>
          <section aria-labelledby="general-recordings-heading" className="flex min-w-0 flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50/30 p-3" data-recordings-section="general">
            <h2 id="general-recordings-heading" className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <BookOpen size={16} className="text-emerald-700" aria-hidden />
              General Recordings
              {selectedClass ? <span className="min-w-0 break-words text-sm font-normal text-slate-500">· {selectedClass.name}</span> : null}
            </h2>
            <SectionBody
              load={general}
              onRetry={() => setGeneralAttempt((n) => n + 1)}
              render={(initial) => (
                <TeacherRecordingsClient
                  key={`general:${classId}`}
                  teacherId={teacherId}
                  initial={initial}
                  scope={{ classId, section: "GENERAL" }}
                  onSendingChange={onGeneralSending}
                />
              )}
            />
          </section>

          <section aria-labelledby="lecture-recordings-heading" className="flex min-w-0 flex-col gap-2 rounded-xl border border-brand-200 bg-brand-50/20 p-3" data-recordings-section="lecture">
            <h2 id="lecture-recordings-heading" className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <Layers size={16} className="text-[#32598A]" aria-hidden />
              Lecture Recordings
            </h2>
            <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-600">
                Lecture
                <select
                  value={lectureId}
                  onChange={(event) => chooseLecture(event.target.value)}
                  disabled={lectures?.state !== "ready" || lectures.items.length === 0}
                  className="control-select h-10 w-full min-w-0 text-sm sm:max-w-md"
                  data-recordings-lecture-select
                >
                  <option value="">
                    {lectures?.state === "loading" ? "Loading lectures…" : lectures?.state === "ready" && lectures.items.length === 0 ? "No lectures in this class" : "Select a lecture"}
                  </option>
                  {lectures?.state === "ready"
                    ? lectures.items.map((l) => (
                        <option key={l.id} value={l.id}>
                          {recordingsLectureLabel(l)}
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
                      setLecturesAttempt((n) => n + 1);
                    }}
                    className="rounded-md border border-rose-200 bg-white px-2 py-1 font-semibold"
                  >
                    Try again
                  </button>
                </div>
              ) : null}
            </div>
            {lectureId ? (
              <SectionBody
                load={lecture}
                onRetry={() => setLectureAttempt((n) => n + 1)}
                render={(initial) => (
                  <TeacherRecordingsClient
                    key={`lecture:${classId}:${lectureId}`}
                    teacherId={teacherId}
                    initial={initial}
                    scope={{ classId, section: "LECTURE" }}
                    onSendingChange={onLectureSending}
                  />
                )}
              />
            ) : (
              <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600" data-recordings-empty="no-lecture">
                <Film size={15} className="shrink-0 text-slate-400" aria-hidden />
                {lectures?.state === "ready" && lectures.items.length === 0 ? "This class has no lectures yet." : "Select a lecture to manage its recordings."}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SectionBody({ load, onRetry, render }: { load: Load<TeacherRecordingsInitial>; onRetry: () => void; render: (initial: TeacherRecordingsInitial) => React.ReactNode }) {
  if (load.state === "loading" || load.state === "idle") {
    return (
      <p role="status" className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <Loader2 size={15} className="animate-spin" aria-hidden />
        Loading recordings…
      </p>
    );
  }
  if (load.state === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
        <span>{load.message}</span>
        <button type="button" onClick={onRetry} className="rounded-md border border-rose-200 bg-white px-2 py-1 text-xs font-semibold">
          Try again
        </button>
      </div>
    );
  }
  return <>{render(load.data)}</>;
}
