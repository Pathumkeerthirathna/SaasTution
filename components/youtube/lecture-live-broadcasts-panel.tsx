"use client";

/*
 * One lecture's YouTube live streams: list, YouTube privacy, and playback in
 * the YouTube player. Extracted unchanged from
 * components/lecture-management-panel.tsx, which renders it under a lecture
 * card's "Live Streams" toggle; the Recordings > YouTube Live Sessions page
 * renders it for the selected lecture. Existing APIs:
 *   GET /api/lectures/[id]/lives
 *   PUT /api/lectures/[id]/lives/[liveId]/privacy   { privacy }
 * (the server checks the teacher owns the lecture). Starting / stopping a
 * live stream stays in the classroom (components/Jitsi/JitsiClassroom.tsx).
 */

import { useEffect, useState } from "react";
import { Calendar, ChevronDown, Clock3, Play, Radio } from "lucide-react";

import { readYouTubeApiError, YouTubeEmbedModal, type PlayableVideo } from "@/components/youtube/youtube-embed-modal";

export type LiveBroadcastItem = {
  id: string;
  videoId: string;
  youtubeUrl: string;
  privacy: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

export type LivePrivacy = "public" | "unlisted" | "private";

export const LIVE_PRIVACY_OPTIONS: { value: LivePrivacy; label: string }[] = [
  { value: "public", label: "Public" },
  { value: "unlisted", label: "Unlisted" },
  { value: "private", label: "Private" },
];

export function lectureLivesUrl(lectureId: string): string {
  return `/api/lectures/${lectureId}/lives`;
}

export function LectureLiveBroadcastsPanel({
  lectureId,
  onError,
  onSuccess,
}: {
  lectureId: string;
  /** The lecture page shows these in its own banners; without them they are shown here. */
  onError?: (message: string | null) => void;
  onSuccess?: (message: string) => void;
}) {
  const [lives, setLives] = useState<LiveBroadcastItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<PlayableVideo | null>(null);

  const reportError = (text: string | null) => {
    if (onError) onError(text);
    else setMessage(text ? { tone: "error", text } : null);
  };
  const reportSuccess = (text: string) => {
    if (onSuccess) onSuccess(text);
    else setMessage({ tone: "success", text });
  };

  useEffect(() => {
    // A newer lecture (or unmount) aborts the older request: its answer never replaces this list.
    const controller = new AbortController();
    setLives(null);
    setLoading(true);
    setMessage(null);
    void (async () => {
      try {
        const response = await fetch(lectureLivesUrl(lectureId), { cache: "no-store", signal: controller.signal });
        const payload = (await response.json()) as { success: boolean; data?: LiveBroadcastItem[] };
        if (controller.signal.aborted) return;
        if (!response.ok || !payload.success) throw new Error(readYouTubeApiError(payload, "Failed to load live streams."));
        setLives(payload.data ?? []);
      } catch (error) {
        if (controller.signal.aborted) return;
        reportError(error instanceof Error ? error.message : "Failed to load live streams.");
        setLives([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lectureId]);

  async function handleChangeLivePrivacy(liveId: string, privacy: LivePrivacy) {
    setUpdating((prev) => new Set(prev).add(liveId));
    reportError(null);
    try {
      const response = await fetch(`/api/lectures/${lectureId}/lives/${liveId}/privacy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ privacy }),
      });
      const payload = (await response.json()) as { success: boolean };
      if (!response.ok || !payload.success) throw new Error(readYouTubeApiError(payload, "Failed to update live stream privacy."));
      setLives((prev) => (prev ?? []).map((live) => (live.id === liveId ? { ...live, privacy: privacy.toUpperCase() } : live)));
      reportSuccess("Live stream privacy updated successfully.");
    } catch (error) {
      reportError(error instanceof Error ? error.message : "Failed to update live stream privacy.");
    } finally {
      setUpdating((prev) => {
        const next = new Set(prev);
        next.delete(liveId);
        return next;
      });
    }
  }

  return (
    <div data-youtube-panel="lives">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Radio size={12} />
        Live Streams
      </p>

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`mt-2 text-xs ${message.tone === "error" ? "text-rose-700" : "text-emerald-700"}`}>
          {message.text}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-2 text-xs text-muted">Loading live streams...</p>
      ) : (lives?.length ?? 0) === 0 ? (
        <p className="mt-2 text-xs text-muted">No YouTube live streams for this lecture yet.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {(lives ?? []).map((live) => (
            <div
              key={live.id}
              className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <button type="button" onClick={() => setPlaying(live)} className="flex min-w-0 items-center gap-2 text-left">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-600 text-white">
                  <Play size={12} />
                </span>
                <div className="min-w-0">
                  <p className="flex items-center gap-1 text-[11px] font-medium text-slate-700">
                    <Calendar size={10} />
                    Started {live.startedAt ? new Date(live.startedAt).toLocaleString() : "—"}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                    <Clock3 size={10} />
                    Ended {live.endedAt ? new Date(live.endedAt).toLocaleString() : "In progress"}
                  </p>
                </div>
              </button>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500 shadow-sm">{live.status}</span>
                <div className="relative shrink-0">
                  <select
                    value={live.privacy.toLowerCase()}
                    aria-label="YouTube privacy"
                    disabled={updating.has(live.id)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => void handleChangeLivePrivacy(live.id, event.target.value as LivePrivacy)}
                    className="w-[92px] appearance-none rounded-md border border-slate-200 bg-white py-1.5 pl-2 pr-6 text-[11px] leading-none font-medium text-slate-700 shadow-sm transition hover:border-brand-300 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {LIVE_PRIVACY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={11} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <YouTubeEmbedModal video={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}
