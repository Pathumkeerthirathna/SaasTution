"use client";

import { Video, X } from "lucide-react";

/*
 * The YouTube player modal of the teacher's lecture recordings and live
 * streams (extracted unchanged from components/lecture-management-panel.tsx).
 * Plays a YouTube video by its id in the standard embed; nothing is stored or
 * proxied here.
 */

export type PlayableVideo = {
  id: string;
  videoId: string;
};

/** The embed URL of a YouTube video (autoplay, as before). */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
}

/** `title`: the heading and the player's accessible name (default "Lecture recording", as before). */
export function YouTubeEmbedModal({ video, onClose, title = "Lecture recording" }: { video: PlayableVideo | null; onClose: () => void; title?: string }) {
  if (!video) return null;
  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/70" onClick={onClose} aria-hidden />
      <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
        <div className="w-full max-w-3xl rounded-xl border border-slate-200 bg-black shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-white">
              <Video size={13} />
              {title}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <X size={14} />
            </button>
          </div>

          <div className="aspect-video w-full">
            <iframe
              key={video.id}
              title={title}
              src={youtubeEmbedUrl(video.videoId)}
              className="h-full w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>
      </div>
    </>
  );
}

type ApiError = { error?: { message?: string }; message?: string };

/** The server's message, else the fallback (the lecture panel's readApiError). */
export function readYouTubeApiError(payload: unknown, fallbackMessage: string): string {
  if (!payload || typeof payload !== "object") return fallbackMessage;
  const typed = payload as ApiError;
  return typed.error?.message ?? typed.message ?? fallbackMessage;
}
