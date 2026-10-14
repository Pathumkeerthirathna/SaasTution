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

// Header controls: one compact size (28px, 32px from sm) and shape for every
// button and chip, so Record / Start Live / End Session line up exactly.
const HEADER_CONTROL =
  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] px-2.5 text-xs font-semibold leading-none tracking-[-0.005em] sm:h-8 sm:rounded-[10px] sm:px-3 sm:text-[13px]";
const HEADER_BUTTON = `${HEADER_CONTROL} transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/70 disabled:cursor-not-allowed disabled:opacity-55`;
// Secondary (Record, Connect YouTube, Fullscreen): quiet glass.
const HEADER_SECONDARY = `${HEADER_BUTTON} bg-white/[0.07] text-[#E2E8F0] ring-1 ring-inset ring-white/10 hover:bg-white/[0.12] hover:text-white`;
// Primary accent (Start Live): soft red gradient with a faint top highlight.
const HEADER_PRIMARY = `${HEADER_BUTTON} bg-gradient-to-b from-[#F25555] to-[#DC2626] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(2,6,23,0.35)] hover:from-[#F46666] hover:to-[#E23131]`;
// Destructive but restrained (End Session, Stop Recording): tinted, not solid.
const HEADER_DESTRUCTIVE = `${HEADER_BUTTON} bg-[#EF4444]/[0.14] text-[#FCA5A5] ring-1 ring-inset ring-[#EF4444]/35 hover:bg-[#EF4444]/[0.22] hover:text-[#FECACA]`;
// Stop Live: the solid, darker red of an action in progress.
const HEADER_STOP_LIVE = `${HEADER_BUTTON} bg-gradient-to-b from-[#C62828] to-[#A51C1C] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_1px_2px_rgba(2,6,23,0.35)] hover:from-[#D03131] hover:to-[#B02020]`;
// Needs attention (Reconnect YouTube).
const HEADER_WARNING = `${HEADER_BUTTON} bg-amber-500/[0.14] text-amber-300 ring-1 ring-inset ring-amber-500/30 hover:bg-amber-500/[0.22]`;
const HEADER_ICON = 14;

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
   * Shown in its own row between the header and the meeting (e.g. the portrait
   * phone orientation tip), so it never covers the video or its controls.
   */
  belowHeader?: ReactNode;

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
  belowHeader,
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

      {/* HEADER — the teacher workspace's navy (#112D5C) for both roles; the
          student keeps its own border and text colours. */}
      {showHeader && (
      <div
        ref={headerRef}
        onMouseEnter={immersive?.onPointerEnter}
        onMouseLeave={immersive?.onPointerLeave}
        // Always at least the classic 80px tall, but it may wrap onto a second row on
        // narrow screens so every control stays reachable (min height comes from
        // --sl-header-min in globals.css).
        className={`sl-header flex min-h-[var(--sl-header-min)] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-3 py-1.5 sm:px-4 sm:py-2 lg:flex-nowrap lg:px-5 ${
          role === "student"
            ? "border-[#1C332B] bg-[#112D5C]"
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
            size={18}
          />

          <div className="min-w-0">
            <h2
              className={`break-words text-sm font-semibold sm:text-base lg:truncate lg:text-lg ${
                role === "student" ? "text-white" : "text-[#F8FAFC]"
              }`}
            >
              {lectureTitle}
            </h2>

            <p
              className={`break-words text-[11px] sm:text-xs lg:truncate ${
                role === "student" ? "text-white/70" : "text-[#94A3B8]"
              }`}
            >
              {className}
            </p>
          </div>
        </div>

        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-2 lg:shrink-0 lg:flex-nowrap">

          {role === "student" && isLive && (
            <div className="flex items-center gap-1.5">
              <div className={`${HEADER_CONTROL} bg-[#EF4444]/[0.16] text-[#FCA5A5] ring-1 ring-inset ring-[#EF4444]/35`}>
                <Radio
                  size={HEADER_ICON}
                  className="animate-pulse"
                />

                <span className="tracking-wide">
                  LIVE
                </span>
              </div>

              {youtubeLiveUrl && (
                <a
                  href={youtubeLiveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={HEADER_PRIMARY}
                >
                  <MonitorPlay size={HEADER_ICON} />
                  Watch on YouTube
                </a>
              )}
            </div>
          )}

          {role === "teacher" && (
            <div className="flex flex-wrap items-center gap-1.5 lg:flex-nowrap">

             {!isConferenceReady ? (
                <div className={`${HEADER_CONTROL} bg-white/[0.05] font-medium text-[#94A3B8] ring-1 ring-inset ring-white/[0.08]`}>
                  <Loader2 size={HEADER_ICON} className="animate-spin" />
                  Connecting to session...
                </div>
             ) : !youtubeStatus && !isLive && !isRecording ? (
                // No YouTubeConnection row for this teacher at all — Record,
                // Start Live, Stop Recording and Stop Live all require one,
                // so only a way to connect is shown here.
                <button
                  type="button"
                  onClick={handleReconnectYoutube}
                  className={HEADER_SECONDARY}
                >
                  <Video size={HEADER_ICON} />
                  Connect YouTube
                </button>
             ) : youtubeReauthRequired && !isLive && !isRecording ? (
                <button
                  type="button"
                  onClick={handleReconnectYoutube}
                  className={HEADER_WARNING}
                >
                  <RotateCcw size={HEADER_ICON} />
                  Reconnect YouTube
                </button>
             ) : (
              <>

             {!isRecording && (
                <button
                  type="button"
                  onClick={handleStartRecording}
                  disabled={isYoutubeActionBusy}
                  title={breakoutHint ?? "Record this class to YouTube"}
                  className={HEADER_SECONDARY}
                >
                  {isStartingRecording ? (
                    <Loader2
                      size={HEADER_ICON}
                      className="animate-spin"
                    />
                  ) : (
                    <Video size={HEADER_ICON} />
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
                  className={HEADER_DESTRUCTIVE}
                >
                  {isStoppingRecording ? (
                    <Loader2 size={HEADER_ICON} className="animate-spin" />
                  ) : (
                    <CircleStop size={HEADER_ICON} />
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
                  title={breakoutHint ?? "Go live on YouTube"}
                  className={HEADER_PRIMARY}
                >
                  {isStartingLive ? (
                    <Loader2
                      size={HEADER_ICON}
                      className="animate-spin"
                    />
                  ) : (
                    <Radio size={HEADER_ICON} />
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
                  className={HEADER_STOP_LIVE}
                >
                  {isStoppingLive ? (
                    <Loader2
                      size={HEADER_ICON}
                      className="animate-spin"
                    />
                  ) : (
                    <Radio
                      size={HEADER_ICON}
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
                <div className={`${HEADER_CONTROL} bg-[#EF4444]/[0.14] text-[#F87171] ring-1 ring-inset ring-[#EF4444]/30`}>
                  <Radio
                    size={HEADER_ICON}
                    className="animate-pulse"
                  />

                  <span className="tracking-wide">
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
                  className={HEADER_SECONDARY}
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
                    title="End this session for everyone"
                    className={HEADER_DESTRUCTIVE}
                  >
                    <PhoneOff size={HEADER_ICON} />
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
              className={HEADER_SECONDARY}
            >
              <Maximize2 size={HEADER_ICON} />
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
            <div
              title={`YouTube channel: ${youtubeChannelTitle}`}
              className="flex h-7 min-w-0 items-center gap-2 rounded-[9px] bg-white/[0.05] pl-1 pr-2.5 ring-1 ring-inset ring-white/[0.08] sm:h-8 sm:rounded-[10px] sm:pl-1.5"
            >
              {/* YouTube icon */}
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[#FF0033]/[0.12] sm:h-6 sm:w-6 sm:rounded-[7px]">
                <svg
                  viewBox="0 0 24 24"
                  className="h-3 w-3 text-[#FF0033] sm:h-3.5 sm:w-3.5"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.9V8.1l6.5 3.9-6.5 3.9Z" />
                </svg>
              </div>

              {/* Channel information */}
              <div className="flex min-w-0 items-center gap-2">
                <span className="sr-only">YouTube channel:</span>

                <div className="flex min-w-0 items-center gap-2">
                  <span className="max-w-[140px] truncate text-xs font-semibold text-[#F1F5F9] max-sm:max-w-[45vw] sm:text-[13px]">
                    {youtubeChannelTitle}
                  </span>

                  {youtubeReauthRequired ? (
                    <button
                      type="button"
                      onClick={handleReconnectYoutube}
                      className="flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 ring-1 ring-inset ring-amber-500/30 transition hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70 sm:text-[11px]"
                    >
                      <RotateCcw size={11} />
                      Reconnect
                    </button>
                  ) : (
                    <span
                      className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-[#4ADE80] sm:text-[11px]"
                      title="YouTube connected"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-[#22C55E] shadow-[0_0_0_2px_rgba(34,197,94,0.18)]" />
                      <span className="max-sm:sr-only">Connected</span>
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

      {showHeader && belowHeader}

      {/* JITSI CONTENT */}
      <div className="min-h-0 flex-1 overflow-hidden bg-black">
        {children}
      </div>

    </section>
  );
}