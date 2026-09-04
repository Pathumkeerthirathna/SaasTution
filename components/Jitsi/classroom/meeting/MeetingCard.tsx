"use client";

import { ReactNode, Ref, useEffect, useState } from "react";
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
  RotateCcw,
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
  liveStartFailed?: boolean;

  youtubeLiveUrl?: string | null;

  onStartRecording?: () => void | Promise<void>;
  onStopRecording?: () => void | Promise<void>;
  onStartLive?: () => void | Promise<void>;
  onStopLive?: () => void | Promise<void>;
  onReconnectYoutube?: () => void;
  youtubeChannelTitle?: string | null;
  youtubeStatus?: "CONNECTED" | "REAUTH_REQUIRED" | null;
  /** Set only when a live/recording start actually failed with a reauth error. */
  youtubeReauthRequired?: boolean;

  showHeader?: boolean;

  /** Anchor for the "Start YouTube Live" privacy popover, rendered by the parent. */
  startLiveButtonRef?: Ref<HTMLButtonElement>;
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
  onReconnectYoutube,
  youtubeChannelTitle,
  youtubeStatus,
  youtubeReauthRequired = false,
  isStartingLive,
  liveStartFailed = false,
  youtubeLiveUrl,
  showHeader = true,
  startLiveButtonRef,
}: MeetingCardProps) {
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isStoppingRecording, setIsStoppingRecording] = useState(false);
  // const [isStartingLive, setIsStartingLive] = useState(false);
  const [isStoppingLive, setIsStoppingLive] = useState(false);

  const [recordingStartFailed, setRecordingStartFailed] =
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

    try {
      await onStartLive?.();
    } catch (error) {
      console.error("❌ Failed to start live:", error);
    }
  };

  const handleReconnectYoutube = () => {
    if (onReconnectYoutube) {
      onReconnectYoutube();
      return;
    }

    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.href =
      `/api/youtube/oauth/connect?returnTo=${encodeURIComponent(returnTo)}`;
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
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#0B1120]">

      {/* HEADER — navy/blue for the teacher, green for the student. */}
      {showHeader && (
      <div
        className={`flex h-[80px] shrink-0 items-center justify-between border-b px-5 py-3 ${
          role === "student"
            ? "border-[#1C332B] bg-[#10231D]"
            : "border-[#1E293B] bg-[#112D5C]"
        }`}
      >

        <div className="flex items-center gap-3">
          <MonitorPlay
            className={role === "student" ? "text-white" : "text-[#3B82F6]"}
            size={22}
          />

          <div>
            <h2
              className={`font-semibold ${
                role === "student" ? "text-white" : "text-[#F8FAFC]"
              }`}
            >
              {lectureTitle}
            </h2>

            <p
              className={`text-xs ${
                role === "student" ? "text-white/70" : "text-[#94A3B8]"
              }`}
            >
              {className}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-5">

          {role === "teacher" && (
            <div className="flex items-center gap-2">

             {youtubeReauthRequired && !isLive && !isRecording ? (
                <button
                  type="button"
                  onClick={handleReconnectYoutube}
                  className="flex items-center gap-2 rounded-full bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-300 ring-1 ring-amber-500/30 transition hover:bg-amber-500/25"
                >
                  <RotateCcw size={16} />
                  Reconnect YouTube
                </button>
             ) : (
              <>

             {!isRecording && (
                <button
                  type="button"
                  onClick={handleStartRecording}
                  disabled={isStartingRecording}
                  className="flex items-center gap-2 rounded-full bg-[#334155] px-4 py-2 text-sm font-semibold text-[#F8FAFC] transition hover:bg-[#475569] disabled:cursor-not-allowed disabled:opacity-60"
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
                  ref={startLiveButtonRef}
                  type="button"
                  onClick={handleStartLive}
                  disabled={isStartingLive}
                  className="flex items-center gap-2 rounded-full bg-[#EF4444] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#DC2626] disabled:cursor-not-allowed disabled:opacity-60"
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
                  className="flex items-center gap-2 rounded-full bg-[#B91C1C] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#991B1B] disabled:cursor-not-allowed disabled:opacity-60"
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

              </>
             )}

              {/* LIVE */}
              {isLive && (
                <div className="flex items-center gap-2 rounded-full bg-[#EF4444]/20 px-3 py-1.5">
                  <Radio
                    size={16}
                    className="animate-pulse text-[#EF4444]"
                  />

                  <span className="font-semibold text-[#EF4444]">
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
                  className="flex items-center gap-2 rounded-full bg-[#1E293B] px-3 py-1.5 text-sm font-medium text-[#F8FAFC] transition hover:bg-[#334155]"
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
                <div className="w-full max-w-md rounded-2xl border border-[#1E293B] bg-[#172033] p-5 shadow-2xl">

                  {/* Header */}
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-[#F8FAFC]">
                        Share YouTube Live
                      </h3>

                      <p className="mt-1 text-xs text-[#94A3B8]">
                        Share this live class with your students.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setShowYoutubeShare(false)
                      }
                      className="rounded-lg p-2 text-[#94A3B8] hover:bg-[#1E293B] hover:text-[#F8FAFC]"
                    >
                      ✕
                    </button>
                  </div>

                  {/* URL */}
                  <div className="flex items-center gap-2 rounded-xl border border-[#1E293B] bg-[#0F172A] p-2">
                    <input
                      value={youtubeLiveUrl}
                      readOnly
                      className="min-w-0 flex-1 bg-transparent px-2 text-sm text-[#CBD5E1] outline-none"
                    />

                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          youtubeLiveUrl
                        );
                      }}
                      className="rounded-lg bg-[#3B82F6] px-3 py-2 text-sm font-semibold text-white hover:bg-[#2563EB]"
                    >
                      Copy
                    </button>
                  </div>

                  {/* Social sharing */}
                  <div className="mt-5">
                    <p className="mb-3 text-sm font-medium text-[#CBD5E1]">
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
            <div className="flex items-center gap-3 rounded-xl border border-[#1E293B] bg-[#172033] px-3.5 py-2">
              {/* YouTube icon */}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#FF0033]/10">
                <svg
                  viewBox="0 0 24 24"
                  className="h-4.5 w-4.5 text-[#FF0033]"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.9V8.1l6.5 3.9-6.5 3.9Z" />
                </svg>
              </div>

              {/* Channel information */}
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">
                  YouTube Channel
                </div>

                <div className="flex items-center gap-2">
                  <span className="max-w-[130px] truncate text-sm font-semibold text-[#F8FAFC]">
                    {youtubeChannelTitle}
                  </span>

                  {youtubeReauthRequired ? (
                    <button
                      type="button"
                      onClick={handleReconnectYoutube}
                      className="flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-300 ring-1 ring-amber-500/30 transition hover:bg-amber-500/25"
                    >
                      <RotateCcw size={11} />
                      Reconnect
                    </button>
                  ) : (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-[#22C55E]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#22C55E]" />
                      Connected
                    </span>
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
      )}

      {/* JITSI CONTENT */}
      <div className="min-h-0 flex-1 overflow-hidden bg-black">
        {children}
      </div>

    </section>
  );
}