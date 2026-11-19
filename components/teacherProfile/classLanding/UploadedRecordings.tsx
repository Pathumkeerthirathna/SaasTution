"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Clock3, Lock, LogIn, PlayCircle, UserPlus, Video, X } from "lucide-react";

import type { ClassLectureUploadedRecording } from "@/types/teacherProfileTypes/ClassLectureSession";

/*
 * Uploaded recorded lectures inside the public "Course Sessions" card
 * (ClassSessionsPreview): the row (same look as a YouTube recording row), the
 * player for an Unlocked one and the Log in / Register prompt for a Locked
 * one. What a recording carries is decided on the server
 * (services/recorded-lecture-public-service.ts): a Locked recording has no
 * stream URL, so nothing here can request its video.
 */

export type FreeUploadedRecording = Extract<ClassLectureUploadedRecording, { access: "FREE" }>;

/** "1h 5m" / "45m" from whole seconds; null when unknown. */
export function formatRecordingSeconds(seconds: number | null): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** The existing student player page for this part (the student routes decide access). */
export function studentRecordingPath(lectureId: string, recordingId: string): string {
  return `/student/recorded-lectures/${encodeURIComponent(lectureId)}?recording=${encodeURIComponent(recordingId)}`;
}

export function UploadedRecordingRow({
  recording,
  onWatch,
  onLocked,
}: {
  recording: ClassLectureUploadedRecording;
  onWatch: (recording: FreeUploadedRecording) => void;
  onLocked: (recording: ClassLectureUploadedRecording) => void;
}) {
  const duration = formatRecordingSeconds(recording.durationSeconds);
  const isFree = recording.access === "FREE";

  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            isFree ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"
          }`}
        >
          <PlayCircle className="h-4 w-4" />
          {!isFree && (
            <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-slate-500 ring-2 ring-white">
              <Lock className="h-2.5 w-2.5" />
            </span>
          )}
        </span>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="break-words text-[14px] font-medium text-slate-800">
              Part {recording.partNumber}. {recording.title}
            </p>

            {isFree ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-semibold text-emerald-700">FREE</span>
            ) : (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-semibold text-slate-500">LOCKED</span>
            )}
          </div>

          {duration && (
            <p className="mt-0.5 flex items-center gap-1 text-[13px] text-slate-500">
              <Clock3 className="h-3.5 w-3.5 text-orange-500" />
              {duration}
            </p>
          )}
        </div>
      </div>

      {recording.access === "FREE" ? (
        <button
          type="button"
          onClick={() => onWatch(recording)}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-emerald-700"
        >
          <PlayCircle className="h-3.5 w-3.5" />
          Watch
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onLocked(recording)}
          aria-haspopup="dialog"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[13px] font-semibold text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
        >
          <Lock className="h-3.5 w-3.5" />
          Locked
        </button>
      )}
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** Plays an Unlocked uploaded recording from the public stream endpoint (authorised on every Range request). */
export function UploadedRecordingPlayer({ recording, onClose }: { recording: FreeUploadedRecording; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEscape(onClose);

  // Closing: stop the download so the server releases the stream slot at once.
  useEffect(() => {
    const video = videoRef.current;
    // React Strict Mode (development) runs this cleanup and the effect again on mount:
    // give the element back the source the cleanup removed (as the student player does).
    if (video && !video.getAttribute("src")) {
      video.setAttribute("src", recording.streamUrl);
      video.load();
    }
    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [recording.id, recording.streamUrl]);

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/70" onClick={onClose} aria-hidden />
      <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Recording: ${recording.title}`}
          className="w-full max-w-3xl overflow-hidden rounded-xl border border-slate-200 bg-black shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
            <p className="flex min-w-0 items-center gap-1.5 break-words text-[13px] font-medium text-white">
              <Video className="h-3.5 w-3.5 shrink-0" />
              Part {recording.partNumber}. {recording.title}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close player"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="aspect-video w-full">
            <video
              ref={videoRef}
              key={recording.id}
              src={recording.streamUrl}
              controls
              autoPlay
              playsInline
              preload="metadata"
              controlsList="nodownload"
              onError={() => setFailed(true)}
              className="h-full w-full bg-black"
            />
          </div>

          {failed ? (
            <p role="alert" className="px-4 py-2.5 text-[13px] text-white/80">
              This recording cannot be played right now. It may no longer be public, or too many recordings are playing. Please try again later.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** The Log in / Register prompt for a Locked recording. Never requests the recording's video. */
export function LockedRecordingPrompt({
  recording,
  lectureId,
  onClose,
  onRegister,
}: {
  recording: ClassLectureUploadedRecording;
  lectureId: string;
  onClose: () => void;
  onRegister: () => void;
}) {
  useEscape(onClose);
  const titleId = `locked-recording-${recording.id}`;

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/50" onClick={onClose} aria-hidden />
      <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
            <div className="flex min-w-0 items-start gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                <Lock className="h-4 w-4 text-slate-500" />
              </div>
              <div className="min-w-0">
                <h3 id={titleId} className="text-[16px] font-bold text-slate-900">
                  This recording is locked
                </h3>
                <p className="mt-0.5 break-words text-[13px] text-slate-500">
                  Part {recording.partNumber}. {recording.title}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3 p-5">
            <p className="text-[14px] leading-5 text-slate-600">
              Locked recordings are available to approved students enrolled in this class. Log in, or register to join the class.
            </p>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Link
                href="/login"
                className="flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-[#4D6C90] px-3 text-[13px] font-semibold text-white shadow-sm transition hover:bg-[#3B5776]"
              >
                <LogIn className="h-4 w-4" />
                Log in
              </Link>
              <button
                type="button"
                onClick={onRegister}
                className="flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-[13px] font-semibold text-white shadow-sm transition hover:bg-emerald-700"
              >
                <UserPlus className="h-4 w-4" />
                Register
              </button>
            </div>

            <p className="text-[13px] leading-5 text-slate-500">
              Already enrolled?{" "}
              <Link href={studentRecordingPath(lectureId, recording.id)} className="font-semibold text-emerald-700 underline">
                Watch it in your student portal
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
