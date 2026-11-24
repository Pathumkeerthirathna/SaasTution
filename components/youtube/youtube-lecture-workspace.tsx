"use client";

/*
 * The Recordings > YouTube Live Sessions and Live Recordings pages: a class,
 * then one of its NORMAL lectures (GET /api/lectures?classId=..., which never
 * returns a class's default lecture), then that lecture's shared panel
 * (LectureLiveBroadcastsPanel / LectureYouTubeRecordingsPanel, the same
 * components the lecture cards use). The APIs are per lecture, so nothing is
 * loaded for lectures that are not selected. The classes (and an optional
 * class / lecture from a link) come from the server page, already checked.
 * Switching the class clears the lecture; an older lecture-list response
 * never replaces the current class's; each panel aborts its own request when
 * its lecture changes.
 */

import { useEffect, useState } from "react";
import { Film, Radio, Video } from "lucide-react";

import { LectureLiveBroadcastsPanel } from "@/components/youtube/lecture-live-broadcasts-panel";
import { LectureYouTubeRecordingsPanel } from "@/components/youtube/lecture-youtube-recordings-panel";

export type YouTubeWorkspaceKind = "lives" | "recordings";
export type YouTubeWorkspaceClass = { id: string; name: string };
export type YouTubeWorkspaceLecture = { id: string; title: string; date: string };

export const YOUTUBE_LECTURES_PAGE_SIZE = 100;

/** One page of a class's normal lectures, newest first (the existing lecture API). */
export function youtubeLecturesUrl(classId: string, page: number): string {
  const query = new URLSearchParams({ classId, page: String(page), pageSize: String(YOUTUBE_LECTURES_PAGE_SIZE), sortOrder: "desc" });
  return `/api/lectures?${query.toString()}`;
}

const LECTURE_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Colombo" });

export function youtubeLectureLabel(lecture: YouTubeWorkspaceLecture): string {
  const ms = Date.parse(lecture.date);
  return Number.isNaN(ms) ? lecture.title : `${lecture.title} · ${LECTURE_DATE.format(new Date(ms))}`;
}

export const YOUTUBE_WORKSPACE_TEXT: Record<YouTubeWorkspaceKind, { title: string; description: string; empty: string }> = {
  lives: {
    title: "YouTube Live Sessions",
    description: "YouTube live streams of each lecture. Streams are started from the live classroom.",
    empty: "Select a lecture to see its YouTube live streams.",
  },
  recordings: {
    title: "Live Recordings",
    description: "Classroom recordings saved to YouTube for each lecture. Recordings are started from the live classroom.",
    empty: "Select a lecture to see its live recordings.",
  },
};

type LecturesLoad = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; items: YouTubeWorkspaceLecture[]; hasNextPage: boolean };

export function YouTubeLectureWorkspace({
  kind,
  classes,
  initialClassId = null,
  initialLectureId = null,
}: {
  kind: YouTubeWorkspaceKind;
  classes: YouTubeWorkspaceClass[];
  initialClassId?: string | null;
  initialLectureId?: string | null;
}) {
  const text = YOUTUBE_WORKSPACE_TEXT[kind];
  const [classId, setClassId] = useState(initialClassId ?? "");
  const [lectureId, setLectureId] = useState(initialClassId ? initialLectureId ?? "" : "");
  const [lectures, setLectures] = useState<LecturesLoad | null>(null);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!classId) {
      setLectures(null);
      return;
    }
    const controller = new AbortController();
    if (page === 1) setLectures({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(youtubeLecturesUrl(classId, page), { cache: "no-store", signal: controller.signal });
        const payload = (await response.json().catch(() => null)) as { success?: boolean; data?: YouTubeWorkspaceLecture[]; error?: { message?: string }; pagination?: { hasNextPage?: boolean } } | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !payload?.success) {
          setLectures({ state: "error", message: response.status === 401 ? "Your session has ended. Please sign in again." : payload?.error?.message ?? "Could not load the lectures of this class." });
          return;
        }
        const items = (payload.data ?? []).map((l) => ({ id: l.id, title: l.title, date: l.date }));
        setLectures((previous) => ({
          state: "ready",
          items: page > 1 && previous?.state === "ready" ? [...previous.items, ...items] : items,
          hasNextPage: Boolean(payload.pagination?.hasNextPage),
        }));
      } catch {
        if (!controller.signal.aborted) setLectures({ state: "error", message: "Could not load the lectures of this class." });
      }
    })();
    return () => controller.abort();
  }, [classId, page, attempt]);

  function chooseClass(next: string) {
    setClassId(next);
    setLectureId("");
    setPage(1);
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-4" data-youtube-workspace={kind}>
      <section aria-labelledby="youtube-page-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex min-w-0 items-center gap-3 border-b border-slate-200 p-3 sm:px-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#32598A] text-white">
            {kind === "lives" ? <Radio size={18} aria-hidden /> : <Video size={18} aria-hidden />}
          </span>
          <div className="min-w-0">
            <h1 id="youtube-page-heading" className="text-xl font-semibold tracking-tight text-slate-900">
              {text.title}
            </h1>
            <p className="break-words text-[12px] text-slate-500 sm:text-[13px]">{text.description}</p>
          </div>
        </header>

        {classes.length === 0 ? (
          <p className="m-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-600 sm:mx-4" data-youtube-empty="classes">
            You have no classes yet. Create a class first.
          </p>
        ) : (
          <div className="grid gap-2 p-3 sm:grid-cols-2 sm:px-4">
            <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-600">
              Class
              <select value={classId} onChange={(event) => chooseClass(event.target.value)} className="control-select h-10 w-full min-w-0 text-sm" data-youtube-class-select>
                <option value="">Select a class</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-600">
              Lecture
              <select
                value={lectureId}
                onChange={(event) => setLectureId(event.target.value)}
                disabled={!classId || lectures?.state !== "ready" || lectures.items.length === 0}
                className="control-select h-10 w-full min-w-0 text-sm"
                data-youtube-lecture-select
              >
                <option value="">
                  {!classId ? "Select a class first" : lectures?.state === "loading" ? "Loading lectures…" : lectures?.state === "ready" && lectures.items.length === 0 ? "No lectures in this class" : "Select a lecture"}
                </option>
                {lectures?.state === "ready"
                  ? lectures.items.map((l) => (
                      <option key={l.id} value={l.id}>
                        {youtubeLectureLabel(l)}
                      </option>
                    ))
                  : null}
              </select>
              {lectures?.state === "ready" && lectures.hasNextPage ? (
                <button type="button" onClick={() => setPage((p) => p + 1)} className="self-start text-xs font-semibold text-brand-700 hover:underline">
                  Load older lectures
                </button>
              ) : null}
            </label>
            {lectures?.state === "error" ? (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 sm:col-span-2">
                <span>{lectures.message}</span>
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
            ) : null}
          </div>
        )}
      </section>

      {classId && lectureId ? (
        <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4" data-youtube-lecture={lectureId}>
          {kind === "lives" ? <LectureLiveBroadcastsPanel key={lectureId} lectureId={lectureId} /> : <LectureYouTubeRecordingsPanel key={lectureId} lectureId={lectureId} />}
        </section>
      ) : classes.length > 0 ? (
        <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600" data-youtube-empty="no-lecture">
          <Film size={15} className="shrink-0 text-slate-400" aria-hidden />
          {!classId ? "Select a class and a lecture." : lectures?.state === "ready" && lectures.items.length === 0 ? "This class has no lectures yet." : text.empty}
        </p>
      ) : null}
    </div>
  );
}
