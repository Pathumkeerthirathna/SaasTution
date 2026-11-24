"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  Clock,
  ListVideo,
  Loader2,
  Maximize,
  Minimize,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
} from "lucide-react";

import { diagnosePlaybackFailure, listFailureMessage, type PlaybackFailure } from "./player-errors";
import {
  classRecordingsHref,
  formatDuration,
  formatLectureDateTime,
  initialPartId,
  listApiUrl,
  mergeRecordings,
  normalizePlaybackRate,
  partLabel,
  partPosition,
  PLAYBACK_RATES,
  playerHref,
  type RecordedLecture,
} from "./recording-helpers";
import {
  browserStorage,
  clearResumePosition,
  readLastPart,
  readPreferredRate,
  readResumePosition,
  resumeStartFor,
  SAVE_INTERVAL_MS,
  saveLastPart,
  savePreferredRate,
  saveResumePosition,
} from "./resume-store";

/*
 * Student recorded lecture player (RL-5.1).
 *
 * ONE <video> element plays the current part from its RL-4.3 streamUrl
 * (every Range request is authorised again on the server). Other parts are
 * never preloaded: each would hold a stream slot. Switching parts changes the
 * element's src, which aborts the previous download (the server releases its
 * slot on the disconnect); leaving the page empties the element the same way.
 *
 * Parts come from the server page (no API request); "Load more parts" is only
 * shown when the lecture has more parts than the server loaded. Switching
 * parts, previous / next, speed, fullscreen and resume make NO API request
 * and no server render (the address is updated with history.replaceState).
 * After a playback error ONE HEAD request diagnoses it (player-errors.ts).
 * Resume positions, the last watched part and the speed are remembered in
 * this browser only, per student (resume-store.ts). No automatic jump to the
 * next part: a "Play next part" button appears when a part ends.
 */

const SEEK_STEP_SECONDS = 10;
const PART_PAGE_SIZE = 50;

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

export type RecordingPlayerProps = {
  studentId: string;
  lecture: RecordedLecture["lecture"];
  classInfo: RecordedLecture["class"];
  initialParts: RecordedLecture[];
  initialNextCursor: string | null;
  requestedRecordingId: string | null;
};

export function RecordingPlayer(props: RecordingPlayerProps) {
  const { studentId, lecture, classInfo, requestedRecordingId } = props;

  const [parts, setParts] = useState<RecordedLecture[]>(props.initialParts);
  const [nextCursor, setNextCursor] = useState<string | null>(props.initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<{ message: string; signIn: boolean } | null>(null);

  const [currentId, setCurrentId] = useState<string | null>(() => initialPartId(props.initialParts, requestedRecordingId, null));
  const [rate, setRate] = useState(1);
  const [failure, setFailure] = useState<PlaybackFailure | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const positionRef = useRef(0);
  const lastSaveRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);
  const currentIdRef = useRef<string | null>(currentId);
  const rateRef = useRef(rate);
  const currentSrcRef = useRef<string | null>(null);

  const position = partPosition(parts, currentId);
  const current = position?.current ?? null;
  currentSrcRef.current = current?.streamUrl ?? null;

  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  // Browser-only memory, after hydration: the preferred speed and (without ?recording=) the last watched part.
  useEffect(() => {
    const storage = browserStorage();
    setRate(normalizePlaybackRate(readPreferredRate(storage)));
    if (!requestedRecordingId) {
      const last = readLastPart(storage, studentId, lecture.id);
      const chosen = initialPartId(props.initialParts, null, last);
      if (chosen) setCurrentId(chosen);
    }
    // Only on mount: later part changes are the student's own choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savePosition = useCallback(() => {
    const video = videoRef.current;
    const id = currentIdRef.current;
    if (!video || !id || !video.getAttribute("src")) return;
    if (!Number.isFinite(video.currentTime) || video.currentTime <= 0) return;
    saveResumePosition(browserStorage(), studentId, id, video.currentTime, video.duration);
    lastSaveRef.current = Date.now();
  }, [studentId]);

  // Remember the open part; reset per-part state.
  useEffect(() => {
    if (!currentId) return;
    saveLastPart(browserStorage(), studentId, lecture.id, currentId);
    positionRef.current = 0;
    lastSaveRef.current = Date.now();
  }, [currentId, lecture.id, studentId]);

  // Leaving the page: save, then empty the element so its download stops (the stream slot is released).
  useEffect(() => {
    const onPageHide = () => savePosition();
    window.addEventListener("pagehide", onPageHide);
    const video = videoRef.current;
    // React Strict Mode (development) runs this cleanup and the effect again on mount:
    // give the element back the source the cleanup removed.
    if (video && currentSrcRef.current && !video.getAttribute("src")) {
      video.setAttribute("src", currentSrcRef.current);
      video.load();
    }
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      savePosition();
      if (video) releaseMedia(video);
    };
  }, [savePosition]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function selectPart(id: string) {
    if (id === currentIdRef.current) return;
    savePosition();
    pendingSeekRef.current = null;
    setFailure(null);
    setDiagnosing(false);
    setEnded(false);
    setResumedFrom(null);
    setCurrentId(id); // the new src aborts the previous part's download
    // Keep the address shareable / reloadable without a server round trip: Next.js 14.2
    // syncs native history.replaceState with its router (router.replace would re-render
    // this dynamic page on the server and query every part again).
    try {
      window.history.replaceState(window.history.state, "", playerHref(lecture.id, id));
    } catch {
      // The address just stays on the previous part.
    }
  }

  function onLoadedMetadata() {
    const video = videoRef.current;
    if (!video || !current) return;
    video.playbackRate = rateRef.current;
    if (pendingSeekRef.current !== null) {
      // Retry after an error: continue where playback stopped.
      video.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
      return;
    }
    const start = resumeStartFor(readResumePosition(browserStorage(), studentId, current.id), video.duration);
    if (start !== null) {
      video.currentTime = start;
      setResumedFrom(start);
    }
  }

  function onTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    positionRef.current = video.currentTime;
    if (Date.now() - lastSaveRef.current >= SAVE_INTERVAL_MS) savePosition();
  }

  function onEnded() {
    if (current) clearResumePosition(browserStorage(), studentId, current.id);
    setResumedFrom(null);
    setEnded(true);
  }

  async function onVideoError() {
    const video = videoRef.current;
    const id = currentIdRef.current;
    const part = parts.find((p) => p.id === id);
    if (!video || !part || !part.streamUrl || !video.getAttribute("src") || diagnosing) return;
    setDiagnosing(true);
    let status: number | null = null;
    try {
      // HEAD: authorises again, never opens the file, never takes a stream slot.
      const response = await fetch(part.streamUrl, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
      status = response.status;
    } catch {
      status = null;
    }
    if (currentIdRef.current !== id) return; // the student moved on meanwhile
    setDiagnosing(false);
    setFailure(diagnosePlaybackFailure(status));
  }

  function retry() {
    const video = videoRef.current;
    if (!video) return;
    pendingSeekRef.current = positionRef.current > 0 ? positionRef.current : null;
    setFailure(null);
    video.load();
  }

  function startOver() {
    const video = videoRef.current;
    if (!video || !current) return;
    video.currentTime = 0;
    clearResumePosition(browserStorage(), studentId, current.id);
    setResumedFrom(null);
  }

  function changeRate(value: string) {
    const next = normalizePlaybackRate(value);
    setRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
    savePreferredRate(browserStorage(), next);
  }

  async function toggleFullscreen() {
    const container = containerRef.current;
    const video = videoRef.current as FullscreenVideo | null;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (container && typeof container.requestFullscreen === "function") {
        await container.requestFullscreen();
      } else if (video && typeof video.webkitEnterFullscreen === "function") {
        video.webkitEnterFullscreen(); // iOS Safari: the video element's own fullscreen
      }
    } catch {
      // Fullscreen refused (browser policy): the native controls still offer it.
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (["BUTTON", "SELECT", "INPUT", "A", "TEXTAREA"].includes(target.tagName)) return;
    const video = videoRef.current;
    if (!video) return;
    const key = event.key.toLowerCase();
    if (key === " " || key === "k") {
      event.preventDefault();
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    } else if (key === "arrowleft" || key === "arrowright") {
      event.preventDefault();
      const delta = key === "arrowleft" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS;
      const limit = Number.isFinite(video.duration) ? video.duration : video.currentTime + SEEK_STEP_SECONDS;
      video.currentTime = Math.min(Math.max(0, video.currentTime + delta), limit);
    } else if (key === "f") {
      event.preventDefault();
      void toggleFullscreen();
    }
  }

  async function loadMoreParts() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await fetch(listApiUrl({ lectureId: lecture.id }, nextCursor, PART_PAGE_SIZE), { cache: "no-store" });
      if (!response.ok) {
        setLoadMoreError(listFailureMessage(response.status));
        return;
      }
      const json = (await response.json()) as { data?: { recordedLectures?: RecordedLecture[]; nextCursor?: string | null } };
      // Parts of a locked billing month have no streamUrl and are never played.
      setParts((prev) => mergeRecordings(prev, (json.data?.recordedLectures ?? []).filter((part) => !part.resourceAccess?.locked)));
      setNextCursor(json.data?.nextCursor ?? null);
    } catch {
      setLoadMoreError(listFailureMessage(0));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-3">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-500">
        <Link href="/student/recorded-lectures" className="hover:text-emerald-700">
          Recorded Lectures
        </Link>
        <span aria-hidden>/</span>
        <Link href={classRecordingsHref(classInfo.id)} className="break-words hover:text-emerald-700">
          {classInfo.name}
        </Link>
      </nav>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          <header className="space-y-0.5">
            <h1 className="break-words text-base font-bold text-foreground sm:text-lg">{lecture.title}</h1>
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
              <span>{formatLectureDateTime(lecture.date)}</span>
              {current ? (
                <span className="font-semibold text-emerald-700">
                  {partLabel(current)} of {parts.length}
                  {nextCursor ? "+" : ""}
                </span>
              ) : null}
            </p>
          </header>

          {current ? (
            <div
              ref={containerRef}
              tabIndex={0}
              onKeyDown={onKeyDown}
              aria-label="Video player. Space or K: play or pause. Arrow keys: 10 seconds back or forward. F: fullscreen."
              className="relative overflow-hidden rounded-xl bg-black outline-none ring-emerald-400 focus-visible:ring-2"
            >
              <video
                ref={videoRef}
                src={current.streamUrl ?? undefined}
                controls
                playsInline
                preload="metadata"
                controlsList="nodownload"
                className="aspect-video w-full bg-black"
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={onTimeUpdate}
                onPause={savePosition}
                onEnded={onEnded}
                onError={() => void onVideoError()}
              >
                Your browser cannot play this video.
              </video>

              {failure || diagnosing ? (
                <div role="alert" className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-white">
                  {diagnosing ? (
                    <p className="inline-flex items-center gap-2 text-sm">
                      <Loader2 size={16} className="animate-spin" aria-hidden />
                      Checking the recording…
                    </p>
                  ) : failure ? (
                    <div className="max-w-sm space-y-2">
                      <AlertTriangle size={24} className="mx-auto text-amber-300" aria-hidden />
                      <p className="text-sm font-semibold">{failure.title}</p>
                      <p className="text-xs text-white/80">{failure.message}</p>
                      <div className="flex flex-wrap justify-center gap-2 pt-1">
                        {failure.retryable ? (
                          <button
                            type="button"
                            onClick={retry}
                            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-100"
                          >
                            <RotateCcw size={14} aria-hidden />
                            Try again
                          </button>
                        ) : null}
                        {failure.signIn ? (
                          <Link
                            href="/login"
                            className="inline-flex min-h-[44px] items-center rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-white hover:bg-emerald-600"
                          >
                            Sign in
                          </Link>
                        ) : null}
                        {!failure.retryable && !failure.signIn ? (
                          <Link
                            href={classRecordingsHref(classInfo.id)}
                            className="inline-flex min-h-[44px] items-center rounded-lg border border-white/40 px-4 text-sm font-semibold text-white hover:bg-white/10"
                          >
                            Back to recordings
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
              This recording is not available.
            </p>
          )}

          {current ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => position?.previous && selectPart(position.previous.id)}
                disabled={!position?.previous}
                aria-label="Previous part"
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SkipBack size={14} aria-hidden />
                Previous
              </button>
              <button
                type="button"
                onClick={() => position?.next && selectPart(position.next.id)}
                disabled={!position?.next}
                aria-label="Next part"
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
                <SkipForward size={14} aria-hidden />
              </button>
              <label className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700">
                Speed
                <select
                  value={String(rate)}
                  onChange={(event) => changeRate(event.target.value)}
                  aria-label="Playback speed"
                  className="bg-transparent text-xs font-semibold outline-none"
                >
                  {PLAYBACK_RATES.map((value) => (
                    <option key={value} value={String(value)}>
                      {value}x
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {isFullscreen ? <Minimize size={14} aria-hidden /> : <Maximize size={14} aria-hidden />}
                {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              </button>
              {resumedFrom !== null ? (
                <span className="inline-flex min-h-[44px] flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 text-xs text-emerald-800">
                  <Clock size={13} aria-hidden />
                  Resumed from {formatDuration(resumedFrom)}
                  <button
                    type="button"
                    onClick={startOver}
                    className="inline-flex min-h-[44px] items-center px-1 font-semibold underline hover:text-emerald-950"
                  >
                    Start over
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}

          {ended && current ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-sm font-semibold text-emerald-900">
                {partLabel(current)} finished.
                {position?.next ? "" : " This was the last part."}
              </p>
              {position?.next ? (
                <button
                  type="button"
                  onClick={() => position.next && selectPart(position.next.id)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  <Play size={14} aria-hidden />
                  Play next part ({partLabel(position.next)})
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <aside className="min-w-0 rounded-xl border border-slate-200 bg-white">
          <h2 className="flex items-center gap-1.5 border-b border-slate-100 px-3 py-2.5 text-sm font-bold text-foreground">
            <ListVideo size={15} className="text-emerald-600" aria-hidden />
            Parts ({parts.length}
            {nextCursor ? "+" : ""})
          </h2>
          <ol className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto">
            {parts.map((part) => {
              const active = part.id === currentId;
              return (
                <li key={part.id}>
                  <button
                    type="button"
                    onClick={() => selectPart(part.id)}
                    aria-current={active ? "true" : undefined}
                    className={`flex min-h-[44px] w-full items-start gap-2.5 px-3 py-2 text-left ${active ? "bg-emerald-50" : "hover:bg-slate-50"}`}
                  >
                    <span
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"}`}
                    >
                      <Play size={12} className="translate-x-[1px]" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-xs font-semibold text-slate-800">
                        {partLabel(part)} · {part.title}
                      </span>
                      <span className="block text-[11px] text-slate-500">{formatDuration(part.durationSeconds)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {nextCursor ? (
            <div className="space-y-2 border-t border-slate-100 p-3">
              <p className="text-xs text-slate-600">This lecture has more parts than are shown.</p>
              <button
                type="button"
                onClick={() => void loadMoreParts()}
                disabled={loadingMore}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-60"
              >
                {loadingMore ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                Load more parts
              </button>
              {loadMoreError ? (
                <p role="alert" className="text-xs text-rose-700">
                  {loadMoreError.message}{" "}
                  {loadMoreError.signIn ? (
                    <Link href="/login" className="font-semibold underline">
                      Sign in
                    </Link>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="border-t border-slate-100 p-3">
            <Link
              href={classRecordingsHref(classInfo.id)}
              className="inline-flex min-h-[44px] items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-900"
            >
              <ChevronLeft size={14} aria-hidden />
              All recordings of {classInfo.name}
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Stops the element's download: the server sees the disconnect and releases the stream slot. */
function releaseMedia(video: HTMLVideoElement) {
  try {
    video.pause();
    video.removeAttribute("src");
    video.load();
  } catch {
    // The element is already gone.
  }
}
