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
  PhoneOff,
  Maximize2,
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

  /**
   * True once the Jitsi conference has actually joined and the local
   * teacher is confirmed as a real Jitsi moderator. Record/Start Live stay
   * hidden behind a "Connecting..." indicator until this is true, since
   * going live before it's confirmed can fail silently.
   */
  isConferenceReady?: boolean;

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

  /** Lets the classroom measure the header (it can wrap onto two rows on narrow screens). */
  headerRef?: Ref<HTMLDivElement>;

  /**
   * True while the teacher is inside a breakout room. Recording and YouTube Live run in
   * the main room, so Record / Stop / Start Live / Stop Live are disabled until they return.
   */
  breakoutActive?: boolean;

  /**
   * Fullscreen mode: the header floats over the meeting and slides in from the
   * top only while `headerVisible`. Omit for the normal, always-visible header.
   */
  immersive?: {
    headerVisible: boolean;
    /** The right rail is showing, so the header stops short of it. */
    sidebarVisible: boolean;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };

  /** Anchor for the "Start YouTube Live" privacy popover, rendered by the parent. */
  startLiveButtonRef?: Ref<HTMLButtonElement>;

  /**
   * Teacher only: called after the teacher confirms "End Session". Expected to run
   * the existing application End Session flow (and, on success, end the Jitsi
   * conference) — this component only owns the confirm popover and the
   * in-flight/disabled state around that call, not the flow itself.
   */
  onEndSession?: () => void | Promise<void>;

  /**
   * True on phone/touch layouts. Shows the mobile-only header fullscreen
   * button (visible for both roles) instead of the desktop floating one that
   * JitsiClassroom.tsx renders separately.
   */
  isMobile?: boolean;

  /**
   * Mobile only: called when the header fullscreen button is pressed. Expected
   * to set the existing CSS/state fullscreen mode directly — never calls
   * Element.requestFullscreen() itself.
   */
  onEnterFullscreen?: () => void;
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
  isConferenceReady = false,
  youtubeLiveUrl,
  showHeader = true,
  headerRef,
  breakoutActive = false,
  immersive,
  startLiveButtonRef,
  onEndSession,
  isMobile = false,
  onEnterFullscreen,
}: MeetingCardProps) {
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isStoppingRecording, setIsStoppingRecording] = useState(false);
  // const [isStartingLive, setIsStartingLive] = useState(false);
  const [isStoppingLive, setIsStoppingLive] = useState(false);

  const [recordingStartFailed, setRecordingStartFailed] =
    useState(false);

  const [showYoutubeShare, setShowYoutubeShare] =
  useState(false);

  const [showEndSessionConfirm, setShowEndSessionConfirm] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);

  // isRecording/isLive changing is the only reliable signal that the
  // async start/stop actually completed, so use it to clear loading state.
  useEffect(() => {
    setIsStartingRecording(false);
    setIsStoppingRecording(false);
  }, [isRecording]);

  useEffect(() => {
    setIsStoppingLive(false);
  }, [isLive]);

  // Recording and Live share the same underlying Jitsi → YouTube stream, so
  // starting/stopping either one while the other is mid-transition can race.
  // Record, Stop Recording, Start Live and Stop Live all stay disabled
  // together while any one of these four actions is in flight.
  const isYoutubeActionBusy =
    isStartingRecording ||
    isStoppingRecording ||
    Boolean(isStartingLive) ||
    isStoppingLive ||
    breakoutActive;

  const breakoutHint = breakoutActive
    ? "Return to the main room to record or go live"
    : undefined;

  const handleStartRecording = async () => {
    if (isYoutubeActionBusy) return;

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
    if (isYoutubeActionBusy) return;
    setIsStoppingRecording(true);
    try {
      await onStopRecording?.();
    } catch (error) {
      console.error("❌ Failed to stop recording:", error);
      setIsStoppingRecording(false);
    }
  };

  const handleStartLive = async () => {
    if (isYoutubeActionBusy) return;

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
    if (isYoutubeActionBusy) return;
    setIsStoppingLive(true);
    try {
      await onStopLive?.();
    } catch (error) {
      console.error("❌ Failed to stop live:", error);
      setIsStoppingLive(false);
    }
  };

  const handleEndSession = async () => {
    if (isEndingSession) return;

    setIsEndingSession(true);
    try {
      await onEndSession?.();
    } catch (error) {
      console.error("❌ Failed to end session:", error);
    } finally {
      setIsEndingSession(false);
      setShowEndSessionConfirm(false);
    }
  };

  const testYoutubeStatus = "REAUTH_REQUIRED";

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#0B1120]">

      {/* HEADER — navy/blue for the teacher, green for the student. */}
      {showHeader && (
      <div
        ref={headerRef}
        onMouseEnter={immersive?.onPointerEnter}
        onMouseLeave={immersive?.onPointerLeave}
        // Always at least the classic 80px tall, but it may wrap onto a second row on
        // narrow screens so every control stays reachable (min height comes from
        // --sl-header-min in globals.css).
        className={`sl-header flex min-h-[var(--sl-header-min)] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-3 py-2 sm:px-5 sm:py-3 lg:flex-nowrap ${
          role === "student"
            ? "border-[#1C332B] bg-[#10231D]"
            : "border-[#1E293B] bg-[#112D5C]"
        } ${
          immersive
            ? // Slides with `top`, not a transform, because the header holds a fixed modal.
              `absolute left-0 z-40 transition-[top,right] duration-200 ${
                immersive.headerVisible ? "top-0" : "-top-[160px]"
              } ${immersive.sidebarVisible ? "right-[var(--sl-rail-w)]" : "right-0"}`
            : ""
        }`}
      >

        <div className="flex min-w-0 items-center gap-3">
          <MonitorPlay
            className={`shrink-0 ${role === "student" ? "text-white" : "text-[#3B82F6]"}`}
            size={22}
          />

          <div className="min-w-0">
            <h2
              className={`break-words font-semibold lg:truncate ${
                role === "student" ? "text-white" : "text-[#F8FAFC]"
              }`}
            >
              {lectureTitle}
            </h2>

            <p
              className={`break-words text-xs lg:truncate ${
                role === "student" ? "text-white/70" : "text-[#94A3B8]"
              }`}
            >
              {className}
            </p>
          </div>
        </div>

        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-5 gap-y-2 lg:shrink-0 lg:flex-nowrap">

          {role === "student" && isLive && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 rounded-full bg-[#EF4444]/20 px-3 py-1.5">
                <Radio
                  size={16}
                  className="animate-pulse text-[#EF4444]"
                />

                <span className="font-semibold text-[#EF4444]">
                  LIVE
                </span>
              </div>

              {youtubeLiveUrl && (
                <a
                  href={youtubeLiveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-full bg-[#EF4444] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[#DC2626]"
                >
                  <MonitorPlay size={16} />
                  Watch on YouTube
                </a>
              )}
            </div>
          )}

          {role === "teacher" && (
            <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">

             {!isConferenceReady ? (
                <div className="flex items-center gap-2 rounded-full bg-[#1E293B] px-4 py-2 text-sm font-medium text-[#94A3B8]">
                  <Loader2 size={16} className="animate-spin" />
                  Connecting to session...
                </div>
             ) : !youtubeStatus && !isLive && !isRecording ? (
                // No YouTubeConnection row for this teacher at all — Record,
                // Start Live, Stop Recording and Stop Live all require one,
                // so only a way to connect is shown here.
                <button
                  type="button"
                  onClick={handleReconnectYoutube}
                  className="flex items-center gap-2 rounded-full bg-[#334155] px-4 py-2 text-sm font-semibold text-[#F8FAFC] transition hover:bg-[#475569]"
                >
                  <Video size={16} />
                  Connect YouTube
                </button>
             ) : youtubeReauthRequired && !isLive && !isRecording ? (
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
                  disabled={isYoutubeActionBusy}
                  title={breakoutHint}
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
                  disabled={isYoutubeActionBusy}
                  title={breakoutHint}
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
                  disabled={isYoutubeActionBusy}
                  title={breakoutHint}
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
                  disabled={isYoutubeActionBusy}
                  title={breakoutHint}
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

              {/* END SESSION — teacher only. Reuses the existing application End
                  Session flow (passed in as onEndSession); this component only owns
                  the confirm popover and the in-flight/disabled state. */}
              {isConferenceReady && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowEndSessionConfirm((prev) => !prev)}
                    disabled={isEndingSession}
                    className="flex items-center gap-2 rounded-full bg-[#B91C1C] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#991B1B] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <PhoneOff size={16} />
                    {isEndingSession ? "Ending..." : "End Session"}
                  </button>

                  {showEndSessionConfirm && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-[#1E293B] bg-[#172033] p-4 shadow-2xl">
                      <p className="text-sm font-semibold text-[#F8FAFC]">
                        End this session for everyone?
                      </p>
                      <p className="mt-1 text-xs text-[#94A3B8]">
                        Every student currently in the classroom will be removed and
                        the class session will be marked as ended.
                      </p>

                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setShowEndSessionConfirm(false)}
                          disabled={isEndingSession}
                          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-[#CBD5E1] transition hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Cancel
                        </button>

                        <button
                          type="button"
                          onClick={handleEndSession}
                          disabled={isEndingSession}
                          className="rounded-lg bg-[#EF4444] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#DC2626] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isEndingSession ? "Ending..." : "End Session"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>
          )}

          {/* FULLSCREEN — mobile only, both roles. Beside End Session for the
              teacher (it's the sibling immediately after that block); the only
              content in this spot for the student. Sets the existing CSS/state
              fullscreen mode directly (onEnterFullscreen) — never calls
              Element.requestFullscreen() itself; the desktop floating button in
              JitsiClassroom.tsx keeps using the real Fullscreen API, unchanged. */}
          {isMobile && (
            <button
              type="button"
              onClick={() => onEnterFullscreen?.()}
              className="flex items-center gap-2 rounded-full bg-[#334155] px-4 py-2 text-sm font-semibold text-[#F8FAFC] transition hover:bg-[#475569]"
            >
              <Maximize2 size={16} />
              Fullscreen
            </button>
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
                  <span className="max-w-[130px] truncate text-sm font-semibold text-[#F8FAFC] max-sm:max-w-[45vw]">
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