"use client";

/*
 * The student Recordings > Live Recordings and YouTube Live Sessions pages
 * (read-only). A class (the student's active enrolments, from the server
 * page), then optionally one of its lectures (the existing student lecture
 * list, never a default lecture):
 *  - no lecture: everything of the class; a lecture: only that lecture's;
 *  - changing the class resets the lecture.
 * Data: GET /api/student/classes/{classId}/youtube-recordings | youtube-lives
 * (enrolment, visibility / privacy, payment and monthly locks are applied on
 * the server; a locked recording comes without its link). Playback: the
 * shared YouTube embed (components/youtube/youtube-embed-modal.tsx). No
 * management control of any kind. An older response (a previous class,
 * lecture or page) never replaces the current one.
 */

import { useEffect, useState } from "react";
import { CalendarDays, Clapperboard, ExternalLink, Loader2, PlayCircle, Radio, Video } from "lucide-react";

import { LockedResourceBadge, type ResourceLock } from "@/components/student-portal/locked-resource";
import { studentLecturesUrl } from "@/components/student-portal/notes/student-notes-helpers";
import { YouTubeEmbedModal, type PlayableVideo } from "@/components/youtube/youtube-embed-modal";
import { STUDENT_YOUTUBE_TEXT, type StudentYouTubeKind } from "@/components/student-portal/recordings/student-youtube-text";

export type StudentYouTubeClass = { id: string; name: string };

type LectureRef = { id: string; title: string; date: string };
export type StudentYouTubeRecording = {
  id: string;
  videoId: string | null;
  youtubeUrl: string | null;
  resourceAccess: ResourceLock;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  lecture: LectureRef;
};
export type StudentYouTubeLive = {
  id: string;
  videoId: string;
  youtubeUrl: string;
  isLive: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  lecture: LectureRef;
};

export const STUDENT_YOUTUBE_PAGE_SIZE = 20;

/** The class API for a page of this kind: /api/student/classes/{id}/youtube-recordings | youtube-lives. */
export function studentYouTubeUrl(kind: StudentYouTubeKind, classId: string, lectureId: string | null, page: number): string {
  const query = new URLSearchParams({ page: String(page), pageSize: String(STUDENT_YOUTUBE_PAGE_SIZE) });
  if (lectureId) query.set("lectureId", lectureId);
  return `/api/student/classes/${encodeURIComponent(classId)}/${kind === "recordings" ? "youtube-recordings" : "youtube-lives"}?${query.toString()}`;
}

/** The class shown first: the page's validated `?classId=`, else the only class, else none. */
export function firstStudentYouTubeClass(classes: StudentYouTubeClass[], initialClassId?: string | null): string {
  if (initialClassId && classes.some((c) => c.id === initialClassId)) return initialClassId;
  return classes.length === 1 ? classes[0].id : "";
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Colombo" });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Colombo" });

export function studentYouTubeDate(iso: string | null, withTime = true): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : (withTime ? DATE_TIME : DATE).format(new Date(ms));
}

/** Only a YouTube https address is ever used as an outbound link. */
export function safeYouTubeLink(url: string | null | undefined): string | null {
  return url && /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(url) ? url : null;
}

/** A friendly message for a failed request (restricted class, removed class / lecture, session). */
export function studentYouTubeErrorMessage(status: number, message: string | null | undefined, noun: string): string {
  if (status === 401) return "Your session has ended. Please sign in again.";
  if (status === 403 && message) return message;
  if (status === 404) return "This class or lecture is no longer available.";
  return message || `Could not load the ${noun}. Please try again.`;
}

type ListLoad<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; items: T[]; page: number; totalPages: number; loadingMore: boolean };
type LecturesLoad = { state: "loading" } | { state: "error" } | { state: "ready"; items: LectureRef[] };
type Envelope<T> = { success?: boolean; data?: T; error?: { message?: string } };

export function StudentYouTubeClient({ kind, classes, initialClassId = null }: { kind: StudentYouTubeKind; classes: StudentYouTubeClass[]; initialClassId?: string | null }) {
  const text = STUDENT_YOUTUBE_TEXT[kind];
  const [classId, setClassId] = useState(() => firstStudentYouTubeClass(classes, initialClassId));
  const [lectureId, setLectureId] = useState("");
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<ListLoad<StudentYouTubeRecording | StudentYouTubeLive>>(() => (firstStudentYouTubeClass(classes, initialClassId) ? { state: "loading" } : { state: "idle" }));
  const [lectures, setLectures] = useState<LecturesLoad | null>(null);
  const [playing, setPlaying] = useState<PlayableVideo | null>(null);

  // The class's lectures for the optional filter (first page; newest first).
  useEffect(() => {
    if (!classId) {
      setLectures(null);
      return;
    }
    const controller = new AbortController();
    setLectures({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(studentLecturesUrl(classId, 1), { cache: "no-store", signal: controller.signal });
        const payload = (await response.json().catch(() => null)) as Envelope<{ items?: { kind: string; id: string; title?: string; date: string }[] }> | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !payload?.success) {
          setLectures({ state: "error" });
          return;
        }
        const items = (payload.data?.items ?? []).filter((i) => i.kind === "lecture").map((i) => ({ id: i.id, title: i.title ?? "Lecture", date: i.date }));
        setLectures({ state: "ready", items });
      } catch {
        if (!controller.signal.aborted) setLectures({ state: "error" });
      }
    })();
    return () => controller.abort();
  }, [classId]);

  // The listing (class-wide, or the selected lecture), one page at a time.
  useEffect(() => {
    if (!classId) {
      setList({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    if (page === 1) setList({ state: "loading" });
    else setList((previous) => (previous.state === "ready" ? { ...previous, loadingMore: true } : previous));
    void (async () => {
      try {
        const response = await fetch(studentYouTubeUrl(kind, classId, lectureId || null, page), { cache: "no-store", signal: controller.signal });
        const payload = (await response.json().catch(() => null)) as Envelope<{
          recordings?: StudentYouTubeRecording[];
          broadcasts?: StudentYouTubeLive[];
          pagination?: { totalPages?: number };
        }> | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !payload?.success || !payload.data) {
          setList({ state: "error", message: studentYouTubeErrorMessage(response.status, payload?.error?.message, text.noun) });
          return;
        }
        const items = (kind === "recordings" ? payload.data.recordings : payload.data.broadcasts) ?? [];
        const totalPages = payload.data.pagination?.totalPages ?? 1;
        setList((previous) => ({
          state: "ready",
          items: page > 1 && previous.state === "ready" ? [...previous.items, ...items] : items,
          page,
          totalPages,
          loadingMore: false,
        }));
      } catch {
        if (!controller.signal.aborted) setList({ state: "error", message: studentYouTubeErrorMessage(0, null, text.noun) });
      }
    })();
    return () => controller.abort();
  }, [kind, classId, lectureId, page, attempt, text.noun]);

  function chooseClass(next: string) {
    setClassId(next);
    setLectureId("");
    setPage(1);
  }

  function chooseLecture(next: string) {
    setLectureId(next);
    setPage(1);
  }

  return (
    <div className="space-y-3" data-student-youtube={kind}>
      {classes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-600" data-student-youtube-empty="classes">
          You are not enrolled in any classes yet.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-600">
            Class
            <select value={classId} onChange={(event) => chooseClass(event.target.value)} className="control-select h-9 w-full min-w-0 text-sm" data-student-youtube-class-select>
              <option value="">Select a class</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-600">
            Lecture (optional)
            <select
              value={lectureId}
              onChange={(event) => chooseLecture(event.target.value)}
              disabled={!classId}
              className="control-select h-9 w-full min-w-0 text-sm"
              data-student-youtube-lecture-select
            >
              <option value="">{classId ? "All lectures" : "Select a class first"}</option>
              {lectures?.state === "ready"
                ? lectures.items.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.title} · {studentYouTubeDate(l.date, false)}
                    </option>
                  ))
                : null}
            </select>
            {lectures?.state === "loading" ? <span className="text-[11px] font-normal text-slate-500">Loading lectures…</span> : null}
            {lectures?.state === "error" ? <span className="text-[11px] font-normal text-rose-700">Could not load the lectures; showing the whole class.</span> : null}
          </label>
        </div>
      )}

      {!classId ? (
        classes.length > 0 ? (
          <p className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600" data-student-youtube-empty="no-class">
            <Clapperboard size={15} className="shrink-0 text-slate-400" aria-hidden />
            Select a class to see its {text.noun}.
          </p>
        ) : null
      ) : list.state === "loading" || list.state === "idle" ? (
        <p className="flex items-center gap-2 p-4 text-sm text-slate-500" data-student-youtube-state="loading">
          <Loader2 size={15} className="animate-spin" aria-hidden />
          Loading {text.noun}…
        </p>
      ) : list.state === "error" ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800" data-student-youtube-state="error">
          <span>{list.message}</span>
          <button
            type="button"
            onClick={() => {
              setPage(1);
              setAttempt((n) => n + 1);
            }}
            className="rounded-md border border-rose-200 bg-white px-2 py-1 font-semibold"
          >
            Try again
          </button>
        </div>
      ) : list.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600" data-student-youtube-empty="items">
          {text.empty}
        </p>
      ) : (
        <>
          <ul className="space-y-2" data-student-youtube-list>
            {list.items.map((item) =>
              kind === "recordings" ? (
                <RecordingRow key={item.id} item={item as StudentYouTubeRecording} classId={classId} onPlay={setPlaying} />
              ) : (
                <LiveRow key={item.id} item={item as StudentYouTubeLive} onPlay={setPlaying} />
              )
            )}
          </ul>
          {list.page < list.totalPages ? (
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={list.loadingMore} className="btn-secondary h-8 text-xs">
              {list.loadingMore ? "Loading…" : `Load more ${text.noun}`}
            </button>
          ) : null}
        </>
      )}

      <YouTubeEmbedModal video={playing} onClose={() => setPlaying(null)} title={text.player} />
    </div>
  );
}

function LectureLine({ lecture }: { lecture: LectureRef }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
      <span className="font-medium text-emerald-700">{lecture.title}</span>
      <span className="inline-flex items-center gap-1">
        <CalendarDays size={11} aria-hidden />
        {studentYouTubeDate(lecture.date, false)}
      </span>
    </p>
  );
}

function RecordingRow({ item, classId, onPlay }: { item: StudentYouTubeRecording; classId: string; onPlay: (video: PlayableVideo) => void }) {
  const locked = item.resourceAccess?.locked === true || !item.videoId;
  const when = studentYouTubeDate(item.startedAt ?? item.createdAt);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between" data-student-youtube-item={item.id}>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <Video size={14} className="shrink-0 text-rose-600" aria-hidden />
          Recording · {when}
        </p>
        <LectureLine lecture={item.lecture} />
      </div>
      {locked ? (
        item.resourceAccess?.locked ? <LockedResourceBadge lock={item.resourceAccess} classId={classId} compact /> : <span className="text-xs text-slate-500">Not available</span>
      ) : (
        <button
          type="button"
          onClick={() => onPlay({ id: item.id, videoId: item.videoId! })}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-500"
        >
          <PlayCircle size={14} aria-hidden />
          Watch recording
        </button>
      )}
    </li>
  );
}

function LiveRow({ item, onPlay }: { item: StudentYouTubeLive; onPlay: (video: PlayableVideo) => void }) {
  const when = studentYouTubeDate(item.startedAt ?? item.createdAt);
  const link = safeYouTubeLink(item.youtubeUrl);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between" data-student-youtube-item={item.id}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-900">
          <Radio size={14} className={`shrink-0 ${item.isLive ? "text-rose-600" : "text-slate-500"}`} aria-hidden />
          {item.isLive ? (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700" data-student-youtube-live>
              Live now
            </span>
          ) : null}
          {item.isLive ? `Started ${when}` : `Live session · ${when}`}
        </p>
        <LectureLine lecture={item.lecture} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onPlay({ id: item.id, videoId: item.videoId })}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-500"
        >
          <PlayCircle size={14} aria-hidden />
          {item.isLive ? "Watch live" : "Watch replay"}
        </button>
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
            <ExternalLink size={12} aria-hidden />
            YouTube
          </a>
        ) : null}
      </div>
    </li>
  );
}
