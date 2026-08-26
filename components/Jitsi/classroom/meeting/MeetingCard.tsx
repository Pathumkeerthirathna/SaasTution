"use client";

import { ReactNode, useEffect, useState } from "react";
import {
  MonitorPlay,
  Users,
  Wifi,
  ShieldCheck,
  Clock3,
  Radio,
  CircleStop,
  Video,
  Loader2,
} from "lucide-react";

type MeetingCardProps = {
  children: ReactNode;
  className: string;
  lectureTitle?: string;
  teacherName: string;
  role: "teacher" | "student";

  isRecording?: boolean;
  isLive?: boolean;

  isStartingLive?: boolean;

  youtubeLiveUrl?: string | null;

  onStartRecording?: () => void | Promise<void>;
  onStopRecording?: () => void | Promise<void>;
  onStartLive?: () => void | Promise<void>;
  onStopLive?: () => void | Promise<void>;
  youtubeChannelTitle?: string | null;
  youtubeStatus?: "CONNECTED" | "REAUTH_REQUIRED" | null;
};

export default function MeetingCard({
  children,
  className,
  lectureTitle,
  teacherName,
  role,
  isRecording = false,
  isLive = false,
  onStartRecording,
  onStopRecording,
  onStartLive,
  onStopLive,
  youtubeChannelTitle,
  youtubeStatus,
  isStartingLive,
  youtubeLiveUrl,
}: MeetingCardProps) {
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isStoppingRecording, setIsStoppingRecording] = useState(false);
  // const [isStartingLive, setIsStartingLive] = useState(false);
  const [isStoppingLive, setIsStoppingLive] = useState(false);

  const [recordingStartFailed, setRecordingStartFailed] =
    useState(false);

  const [liveStartFailed, setLiveStartFailed] =
      useState(false);

  const [showYoutubeShare, setShowYoutubeShare] =
  useState(false);

  // isRecording/isLive changing is the only reliable signal that the
  // async start/stop actually completed, so use it to clear loading state.
  useEffect(() => {
    setIsStartingRecording(false);
    setIsStoppingRecording(false);
  }, [isRecording]);

  useEffect(() => {
    setIsStoppingLive(false);
  }, [isLive]);

  const handleStartRecording = async () => {
    if (isStartingRecording || isStoppingRecording) return;

    setRecordingStartFailed(false);

    setIsStartingRecording(true);
    try {
      await onStartRecording?.();
    } catch (error) {
      console.error("❌ Failed to start recording:", error);
      setIsStartingRecording(false);
      setRecordingStartFailed(true);
    }
  };

  const handleStopRecording = async () => {
    if (isStartingRecording || isStoppingRecording) return;
    setIsStoppingRecording(true);
    try {
      await onStopRecording?.();
    } catch (error) {
      console.error("❌ Failed to stop recording:", error);
      setIsStoppingRecording(false);
    }
  };

  const handleStartLive = async () => {
    if (isStartingLive || isStoppingLive) return;

     setLiveStartFailed(false);

    try {
      await onStartLive?.();
    } catch (error) {
      console.error("❌ Failed to start live:", error);
      setLiveStartFailed(true);
    }
  };

  const handleStopLive = async () => {
    if (isStartingLive || isStoppingLive) return;
    setIsStoppingLive(true);
    try {
      await onStopLive?.();
    } catch (error) {
      console.error("❌ Failed to stop live:", error);
      setIsStoppingLive(false);
    }
  };

  const testYoutubeStatus = "REAUTH_REQUIRED";

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#0f172a]">

      {/* HEADER */}
      <div className="flex h-[80px] shrink-0 items-center justify-between border-b border-slate-700 bg-[#0F172A] px-5 py-3">

        <div className="flex items-center gap-3">
          <MonitorPlay
            className="text-blue-400"
            size={22}
          />

          <div>
            <h2 className="font-semibold text-white">
              {lectureTitle}
            </h2>

            <p className="text-xs text-slate-400">
              {className}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-5">

          {role === "teacher" && (
            <div className="flex items-center gap-2">

             {!isRecording && (
                <button
                  type="button"
                  onClick={handleStartRecording}
                  disabled={isStartingRecording}
                  className="flex items-center gap-2 rounded-full bg-slate-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isStartingRecording ? (
                    <Loader2
                      size={16}
                      className="animate-spin"
                    />
                  ) : (
                    <Video size={16} />
                  )}

                  {isStartingRecording
                    ? "Starting Recording..."
                    : recordingStartFailed
                      ? "Retry Recording"
                      : "Record"}
                </button>
              )}

              {isRecording && (
                <button
                  type="button"
                  onClick={handleStopRecording}
                  disabled={isStoppingRecording}
                  className="flex items-center gap-2 rounded-full bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isStoppingRecording ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <CircleStop size={16} />
                  )}
                  {isStoppingRecording ? "Stopping Recording..." : "Stop Recording"}
                </button>
              )}

             {!isLive ? (
                <button
                  type="button"
                  onClick={handleStartLive}
                  disabled={isStartingLive}
                  className="flex items-center gap-2 rounded-full bg-red-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isStartingLive ? (
                    <Loader2
                      size={16}
                      className="animate-spin"
                    />
                  ) : (
                    <Radio size={16} />
                  )}

                  {isStartingLive
                    ? "Starting Live..."
                    : liveStartFailed
                      ? "Retry Live"
                      : "Start Live"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStopLive}
                  disabled={isStoppingLive}
                  className="flex items-center gap-2 rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isStoppingLive ? (
                    <Loader2
                      size={16}
                      className="animate-spin"
                    />
                  ) : (
                    <Radio
                      size={16}
                      className="animate-pulse"
                    />
                  )}

                  {isStoppingLive
                    ? "Stopping Live..."
                    : "Stop Live"}
                </button>
              )}

              {/* LIVE */}
              {isLive && (
                <div className="flex items-center gap-2 rounded-full bg-red-500/20 px-3 py-1.5">
                  <Radio
                    size={16}
                    className="animate-pulse text-red-500"
                  />

                  <span className="font-semibold text-red-400">
                    LIVE
                  </span>
                </div>
              )}

              {isLive && youtubeLiveUrl && (
                <button
                  type="button"
                  onClick={() =>
                    setShowYoutubeShare(true)
                  }
                  className="flex items-center gap-2 rounded-full bg-slate-800 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700"
                >
                  <span>🔗</span>
                  <span>Get Link</span>
                </button>
              )}

            </div>
          )}

          {showYoutubeShare &&
            isLive &&
            youtubeLiveUrl && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#0F172A] p-5 shadow-2xl">

                  {/* Header */}
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-white">
                        Share YouTube Live
                      </h3>

                      <p className="mt-1 text-xs text-slate-400">
                        Share this live class with your students.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setShowYoutubeShare(false)
                      }
                      className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>

                  {/* URL */}
                  <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 p-2">
                    <input
                      value={youtubeLiveUrl}
                      readOnly
                      className="min-w-0 flex-1 bg-transparent px-2 text-sm text-slate-300 outline-none"
                    />

                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          youtubeLiveUrl
                        );
                      }}
                      className="rounded-lg bg-red-500 px-3 py-2 text-sm font-semibold text-white hover:bg-red-600"
                    >
                      Copy
                    </button>
                  </div>

                  {/* Social sharing */}
                  <div className="mt-5">
                    <p className="mb-3 text-sm font-medium text-slate-300">
                      Share with
                    </p>

                    <div className="grid grid-cols-4 gap-2">

                      <a
                        href={`https://wa.me/?text=${encodeURIComponent(
                          youtubeLiveUrl
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-xl bg-green-500/10 px-3 py-3 text-center text-sm font-medium text-green-400 hover:bg-green-500/20"
                      >
                        WhatsApp
                      </a>

                      <a
                        href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
                          youtubeLiveUrl
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-xl bg-blue-500/10 px-3 py-3 text-center text-sm font-medium text-blue-400 hover:bg-blue-500/20"
                      >
                        Facebook
                      </a>

                      <a
                        href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(
                          youtubeLiveUrl
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-xl bg-slate-500/10 px-3 py-3 text-center text-sm font-medium text-slate-300 hover:bg-slate-500/20"
                      >
                        X
                      </a>

                      <a
                        href={`https://t.me/share/url?url=${encodeURIComponent(
                          youtubeLiveUrl
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-xl bg-sky-500/10 px-3 py-3 text-center text-sm font-medium text-sky-400 hover:bg-sky-500/20"
                      >
                        Telegram
                      </a>

                    </div>
                  </div>

                </div>
              </div>
            )}

          {/* TIMER */}
          {/* <div className="flex items-center gap-2 rounded-full bg-slate-800 px-3 py-1.5">
            <Clock3
              size={16}
              className="text-slate-300"
            />

            <span className="font-medium text-white">
              00:00:00
            </span>
          </div> */}

          {/* USER */}
          {/* <div className="rounded-full border border-slate-600 bg-slate-800 px-4 py-1.5">
            <div className="text-xs text-slate-400">
              {role === "teacher" ? "Teacher" : "Student"}
            </div>

            <div className="font-semibold text-white">
              {teacherName}
            </div>
          </div> */}

          {/* {role === "teacher" && youtubeChannelTitle && (
            <div className="rounded-full border border-slate-600 bg-slate-800 px-4 py-1.5">
              <div className="text-xs text-slate-400">
                YouTube
              </div>

              <div className="flex items-center gap-2 font-semibold text-white">
                <span>{youtubeChannelTitle}</span>

                {youtubeStatus === "CONNECTED" && (
                  <span className="text-xs text-green-400">
                    Connected
                  </span>
                )}

                {youtubeStatus === "REAUTH_REQUIRED" && (
                  <span className="text-xs text-red-400">
                    Reconnect required
                  </span>
                )}
              </div>
            </div>
          )} */}

         {role === "teacher" && youtubeChannelTitle && (
            <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2">
              {/* YouTube icon */}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10">
                <svg
                  viewBox="0 0 24 24"
                  className="h-4.5 w-4.5 text-red-500"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.9V8.1l6.5 3.9-6.5 3.9Z" />
                </svg>
              </div>

              {/* Channel information */}
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                  YouTube Channel
                </div>

                <div className="flex items-center gap-2">
                  <span className="max-w-[130px] truncate text-sm font-semibold text-white">
                    {youtubeChannelTitle}
                  </span>

                  {youtubeStatus === "CONNECTED" && (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-green-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                      Connected
                    </span>
                  )}

                  {youtubeStatus === "REAUTH_REQUIRED" && (
                    <button
                      type="button"
                      onClick={() => {
                        const returnTo =
                          `${window.location.pathname}${window.location.search}`;

                        window.location.href =
                          `/api/youtube/oauth/connect?returnTo=${encodeURIComponent(returnTo)}`;
                      }}
                      className="text-[11px] font-semibold text-red-400 transition hover:text-red-300"
                    >
                      Reconnect
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* STATUS */}
          {/* <div className="flex items-center gap-2 text-slate-300">
            <Users size={16} />
            <span className="text-sm">
              Connected
            </span>
          </div>

          <div className="flex items-center gap-2 text-green-400">
            <Wifi size={16} />
            <span className="text-sm">
              Excellent
            </span>
          </div>

          <div className="flex items-center gap-2 text-blue-400">
            <ShieldCheck size={16} />
            <span className="text-sm">
              Secure
            </span>
          </div> */}

        </div>

      </div>

      {/* JITSI CONTENT */}
      <div className="min-h-0 flex-1 overflow-hidden bg-black">
        {children}
      </div>

    </section>
  );
}