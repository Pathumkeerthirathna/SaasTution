"use client";

/*
 * One lecture's YouTube recordings (the classroom recorded by Jibri to
 * YouTube): list, visibility / access, and playback in the YouTube player.
 * Extracted unchanged from components/lecture-management-panel.tsx, which
 * renders it under a lecture card's "Recordings" toggle; the Recordings >
 * Live Recordings page renders it for the selected lecture. Existing APIs:
 *   GET /api/lectures/[id]/recordings
 *   PUT /api/lectures/[id]/recordings/[recordingId]   { visibility?, access? }
 * (the server checks the teacher owns the lecture). Starting / stopping a
 * recording stays in the classroom (components/Jitsi/JitsiClassroom.tsx).
 */

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Calendar, ChevronDown, Clock3, Play, Video } from "lucide-react";

import { readYouTubeApiError, YouTubeEmbedModal, type PlayableVideo } from "@/components/youtube/youtube-embed-modal";

export type RecordingVisibility = "PUBLIC" | "PRIVATE";
export type RecordingAccess = "FREE" | "LOCKED";

export type YouTubeRecordingItem = {
  id: string;
  videoId: string;
  youtubeUrl: string;
  privacy: string;
  status: string;
  visibility: RecordingVisibility;
  access: RecordingAccess;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

export const RECORDING_VISIBILITY_OPTIONS: { value: RecordingVisibility; label: string }[] = [
  { value: "PUBLIC", label: "Public" },
  { value: "PRIVATE", label: "Private" },
];

export const RECORDING_ACCESS_OPTIONS: { value: RecordingAccess; label: string }[] = [
  { value: "FREE", label: "Free" },
  { value: "LOCKED", label: "Locked" },
];

export function lectureRecordingsUrl(lectureId: string): string {
  return `/api/lectures/${lectureId}/recordings`;
}

export function LectureYouTubeRecordingsPanel({
  lectureId,
  onError,
}: {
  lectureId: string;
  /** The lecture page shows load errors in its own banner; without it they are shown here. */
  onError?: (message: string) => void;
}) {
  const [recordings, setRecordings] = useState<YouTubeRecordingItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<PlayableVideo | null>(null);

  useEffect(() => {
    // A newer lecture (or unmount) aborts the older request: its answer never replaces this list.
    const controller = new AbortController();
    setRecordings(null);
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const response = await fetch(lectureRecordingsUrl(lectureId), { cache: "no-store", signal: controller.signal });
        const payload = (await response.json()) as { success: boolean; data?: YouTubeRecordingItem[] };
        if (controller.signal.aborted) return;
        if (!response.ok || !payload.success) throw new Error(readYouTubeApiError(payload, "Failed to load recordings."));
        setRecordings(payload.data ?? []);
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Failed to load recordings.";
        if (onError) onError(message);
        else setLoadError(message);
        setRecordings([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lectureId]);

  async function handleChangeRecordingAccess(recordingId: string, updates: { visibility?: RecordingVisibility; access?: RecordingAccess }) {
    setUpdating((prev) => new Set(prev).add(recordingId));
    try {
      const response = await fetch(`/api/lectures/${lectureId}/recordings/${recordingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const payload = (await response.json()) as { success: boolean };
      if (!response.ok || !payload.success) throw new Error(readYouTubeApiError(payload, "Failed to update recording."));
      setRecordings((prev) => (prev ?? []).map((recording) => (recording.id === recordingId ? { ...recording, ...updates } : recording)));
      toast.success("Recording updated successfully.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update recording.");
    } finally {
      setUpdating((prev) => {
        const next = new Set(prev);
        next.delete(recordingId);
        return next;
      });
    }
  }

  return (
    <div data-youtube-panel="recordings">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Video size={12} />
        Recordings
      </p>

      {loadError ? (
        <p role="alert" className="mt-2 text-xs text-rose-700">
          {loadError}
        </p>
      ) : loading ? (
        <p className="mt-2 text-xs text-muted">Loading recordings...</p>
      ) : (recordings?.length ?? 0) === 0 ? (
        <p className="mt-2 text-xs text-muted">No recordings available for this lecture yet.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {(recordings ?? []).map((recording) => (
            <div
              key={recording.id}
              className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <button type="button" onClick={() => setPlaying(recording)} className="flex min-w-0 items-center gap-2 text-left">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white">
                  <Play size={12} />
                </span>
                <div className="min-w-0">
                  <p className="flex items-center gap-1 text-[11px] font-medium text-slate-700">
                    <Calendar size={10} />
                    Started {recording.startedAt ? new Date(recording.startedAt).toLocaleString() : "—"}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                    <Clock3 size={10} />
                    Ended {recording.endedAt ? new Date(recording.endedAt).toLocaleString() : "In progress"}
                  </p>
                </div>
              </button>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500 shadow-sm">{recording.status}</span>
                <div className="relative shrink-0">
                  <select
                    value={recording.visibility}
                    aria-label="Visibility"
                    disabled={updating.has(recording.id)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => void handleChangeRecordingAccess(recording.id, { visibility: event.target.value as RecordingVisibility })}
                    className="w-[92px] appearance-none rounded-md border border-slate-200 bg-white py-1.5 pl-2 pr-6 text-[11px] leading-none font-medium text-slate-700 shadow-sm transition hover:border-brand-300 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {RECORDING_VISIBILITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={11} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
                </div>
                <div className="relative shrink-0">
                  <select
                    value={recording.access}
                    aria-label="Access"
                    disabled={updating.has(recording.id)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => void handleChangeRecordingAccess(recording.id, { access: event.target.value as RecordingAccess })}
                    className="w-[84px] appearance-none rounded-md border border-slate-200 bg-white py-1.5 pl-2 pr-6 text-[11px] leading-none font-medium text-slate-700 shadow-sm transition hover:border-brand-300 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {RECORDING_ACCESS_OPTIONS.map((option) => (
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
