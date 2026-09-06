"use client";

import PermissionGate from "./PermissionGate";
import JitsiMeeting from "./JitsiMeeting";

import useJoinSession from "./hooks/useJoinSession";
import MeetingCard from "./classroom/meeting/MeetingCard";
import RightSidebar from "./classroom/sidebar/RightSidebar";
import useParticipants from "./hooks/useParticipants";

import { useCallback,useRef, useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChatMessage, ClassroomStudent, JitsiParticipant } from "./types";
import { ClassStudent } from "@prisma/client";
import { ClassItem } from "../class-management-panel";

import type { JitsiControls } from "./hooks/useJitsi";
import toast from "react-hot-toast";
import { getYoutubeFriendlyErrorMessage } from "@/lib/youtube-error-messages";
import { announce } from "@/lib/voice-announcer";
import { RotateCcw, Video, X, XCircle } from "lucide-react";

function goToYouTubeOAuthConnect() {
  const returnTo = `${window.location.pathname}${window.location.search}`;

  window.location.href =
    `/api/youtube/oauth/connect?returnTo=${encodeURIComponent(returnTo)}`;
}

function showYoutubeActionToast(
  message: string,
  buttonLabel: string
) {
  toast.custom((t) => (
    <div
      className={`${
        t.visible ? "animate-enter" : "animate-leave"
      } flex max-w-sm items-start gap-3 rounded-xl bg-white px-4 py-3 shadow-lg ring-1 ring-black/5`}
    >
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
        <XCircle className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-5 text-slate-700">
          {message}
        </p>

        <button
          type="button"
          onClick={() => {
            toast.dismiss(t.id);
            goToYouTubeOAuthConnect();
          }}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-red-700"
        >
          {buttonLabel === "Reconnect YouTube" ? (
            <RotateCcw className="h-3.5 w-3.5" />
          ) : (
            <Video className="h-3.5 w-3.5" />
          )}
          {buttonLabel}
        </button>
      </div>
    </div>
  ));
}

const YOUTUBE_OAUTH_ERROR_MESSAGES: Record<string, string> = {
  DENIED: "YouTube authorization was cancelled.",
  MISSING_CODE:
    "YouTube authorization did not complete. Please try again.",
  INVALID_STATE:
    "Your YouTube connection request expired. Please try again.",
  TOKEN_EXCHANGE_FAILED:
    "Could not complete YouTube authorization. Please try again.",
  NO_ACCESS_TOKEN:
    "Google did not authorize access. Please try again.",
  CHANNEL_LOOKUP_FAILED:
    "Could not check your YouTube channel. Please try again.",
  NO_REFRESH_TOKEN:
    "Please reconnect and allow offline access when Google asks.",
  CONFIG_MISSING:
    "YouTube connection is temporarily unavailable. Please try again later.",
};

function showYoutubeNoChannelToast() {
  toast.custom(
    (t) => (
      <div
        className={`${
          t.visible ? "animate-enter" : "animate-leave"
        } w-full max-w-sm rounded-xl bg-white p-4 shadow-lg ring-1 ring-black/5`}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
            <XCircle className="h-4 w-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[13px] font-semibold text-slate-800">
                No YouTube Channel Found
              </p>

              <button
                type="button"
                onClick={() => toast.dismiss(t.id)}
                className="shrink-0 rounded-md p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <p className="mt-1 text-[12.5px] leading-5 text-slate-600">
              The Google account you signed in with doesn&apos;t have a
              YouTube channel yet. Create one, then connect again:
            </p>

            <ol className="mt-2 list-decimal space-y-1 pl-4 text-[12px] leading-5 text-slate-600">
              <li>
                Go to youtube.com and sign in with the same Google
                account.
              </li>
              <li>
                Click your profile picture, then &quot;Create a
                channel&quot;.
              </li>
              <li>Come back here and click &quot;Try Again&quot; below.</li>
            </ol>

            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href="https://www.youtube.com/account"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-[12.5px] font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Open YouTube
              </a>

              <button
                type="button"
                onClick={() => {
                  toast.dismiss(t.id);
                  goToYouTubeOAuthConnect();
                }}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-red-700"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Try Again
              </button>
            </div>
          </div>
        </div>
      </div>
    ),
    { duration: 20000 }
  );
}

export default function JitsiClassroom() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const {
    joinInfo,
    loading,
    error,
    role,
    teacherName,
  } = useJoinSession();

  const {
    participants,
    setParticipants,
  } = useParticipants();

  console.log(
    "🔴 JitsiClassroom PARTICIPANTS:",
    participants
  );

  console.log(
    "🔴 JitsiClassroom COUNT:",
    participants.length
  );

const [classStudents, setClassStudents] =
  useState<ClassroomStudent[]>([]);

  const [isRecording, setIsRecording] =
  useState(false);

  const [isLive, setIsLive] =
  useState(false);

  const [isStartingLive, setIsStartingLive] =
  useState(false);

  const [liveStartFailed, setLiveStartFailed] =
  useState(false);

  const [youtubeReauthRequired, setYoutubeReauthRequired] =
  useState(false);

  // Set when a start-live/start-recording attempt fails with
  // YOUTUBE_NOT_CONNECTED — i.e. the connection was there when the page
  // loaded (or never checked yet) but YouTube rejected it as not connected
  // at all. Overrides the header's Record/Start Live buttons with a single
  // "Connect YouTube" button, the same as if joinInfo had loaded with no
  // connection to begin with.
  const [youtubeConnectionLost, setYoutubeConnectionLost] =
  useState(false);

  // The Jitsi conference reports these independently of PermissionGate's
  // device-permission "ready" state — Record/Start Live must stay hidden
  // until the conference has actually joined AND Jitsi confirms the local
  // user is really a moderator, otherwise going live can silently fail.
  const [isConferenceJoined, setIsConferenceJoined] =
  useState(false);

  const [isModerator, setIsModerator] =
  useState(false);

  const isConferenceReady =
    role !== "teacher" || (isConferenceJoined && isModerator);

  const [youtubePrivacy, setYoutubePrivacy] =
  useState<"public" | "unlisted" | "private">(
    "unlisted"
  );


  const [showYoutubePrivacy, setShowYoutubePrivacy] =
  useState(false);

  // Anchors the "Start YouTube Live" popover under the Start Live button
  // instead of centering it as a full-screen modal.
  const startLiveButtonRef = useRef<HTMLButtonElement>(null);
  const youtubePrivacyPopoverRef = useRef<HTMLDivElement>(null);
  const [youtubePrivacyPos, setYoutubePrivacyPos] =
    useState<{ top: number; right: number } | null>(null);

  const placeYoutubePrivacyPopover = useCallback(() => {
    const rect = startLiveButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setYoutubePrivacyPos({
      top: rect.bottom + 8,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

  // Surface any error the YouTube OAuth callback redirected back with, then
  // strip it from the URL so refreshing the page doesn't re-show it.
  useEffect(() => {
    const oauthError = searchParams.get("youtubeOauthError");

    if (!oauthError) return;

    if (oauthError === "NO_CHANNEL") {
      showYoutubeNoChannelToast();
    } else {
      toast.error(
        YOUTUBE_OAUTH_ERROR_MESSAGES[oauthError] ??
          "Failed to connect your YouTube account. Please try again."
      );
    }

    const params = new URLSearchParams(searchParams.toString());
    params.delete("youtubeOauthError");

    const query = params.toString();

    router.replace(
      query
        ? `${window.location.pathname}?${query}`
        : window.location.pathname
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!showYoutubePrivacy) return;

    placeYoutubePrivacyPopover();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setShowYoutubePrivacy(false);
    }

    // Outside-click is handled by the transparent full-screen overlay rendered
    // with the popover below, not a document listener: most of the screen is
    // the Jitsi meeting iframe, and clicks inside a cross-origin iframe never
    // bubble up to this page's document, so a document-level listener would
    // silently miss them.
    window.addEventListener("resize", placeYoutubePrivacyPopover);
    window.addEventListener("scroll", placeYoutubePrivacyPopover, true);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("resize", placeYoutubePrivacyPopover);
      window.removeEventListener("scroll", placeYoutubePrivacyPopover, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showYoutubePrivacy, placeYoutubePrivacyPopover]);

  const jitsiMeetingRef =
  useRef<JitsiControls | null>(null);

  const youtubeLiveRequestedRef =
  useRef(false);

  const [youtubeLiveUrl, setYoutubeLiveUrl] =
    useState<string | null>(null);

  // Recording and Live share one Jitsi → YouTube stream, which Jibri takes
  // a few seconds to actually join once told to start. These resolvers let
  // handleStartYouTubeRecording/handleStartYouTubeLive await Jitsi's own
  // `recordingStatusChanged` confirmation (surfaced as
  // onRecordingStatusChanged/onLiveStatusChanged below) instead of marking
  // isRecording/isLive true the moment the start API call merely succeeds —
  // that's what keeps the *other* button disabled for the whole handoff.
  const recordingStreamConfirmedResolverRef =
    useRef<(() => void) | null>(null);

  const liveStreamConfirmedResolverRef =
    useRef<(() => void) | null>(null);

  function waitForYoutubeStreamConfirmation(
    resolverRef: MutableRefObject<(() => void) | null>,
    timeoutMs = 25000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        resolverRef.current = null;
        reject(
          new Error(
            "Timed out waiting for Jitsi to confirm the YouTube stream started."
          )
        );
      }, timeoutMs);

      resolverRef.current = () => {
        clearTimeout(timeoutId);
        resolverRef.current = null;
        resolve();
      };
    });
  }

  // const testRecordingControl = () => {
  //   jitsiMeetingRef.current?.startRecording();
  // };

  const [youtubeLiveReusedRecording, setYoutubeLiveReusedRecording] =
    useState(false);

  // Real-time "is this class live on YouTube right now" signal, pushed via
  // SSE so students see the stream start without refreshing — the Jitsi
  // `recordingStatusChanged` event alone isn't reliable for this (it's only
  // acted on by the client that initiated the start).
  useEffect(() => {
    const sessionId = joinInfo?.session?.id;

    if (!sessionId) return;

    const source = new EventSource(
      `/api/sessions/${sessionId}/live-updates?role=${role}`
    );

    const handleLiveStatus = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as {
          isLive: boolean;
          youtubeUrl: string | null;
        };

        setIsLive(data.isLive);
        setYoutubeLiveUrl(data.youtubeUrl);
      } catch {
        /* ignore malformed payloads */
      }
    };

    source.addEventListener("live-status", handleLiveStatus);

    return () => {
      source.removeEventListener("live-status", handleLiveStatus);
      source.close();
    };
  }, [joinInfo?.session?.id, role]);

  const [meetingReady, setMeetingReady] =
    useState(false);

  // Realtime chat — backed by Jitsi's own group chat, mirrored into our panel.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const handleChatMessage = useCallback((message: ChatMessage) => {
    setChatMessages((prev) => {
      // Cap history so a long class doesn't grow this without bound.
      const next = [...prev, message];
      return next.length > 300 ? next.slice(next.length - 300) : next;
    });
  }, []);

  const sendChat = useCallback((text: string) => {
    jitsiMeetingRef.current?.sendChatMessage(text);
  }, []);


  const handleParticipantsChanged = useCallback(
    (newParticipants: JitsiParticipant[]) => {

      console.log(
        "🟣 JitsiMeeting SENT PARTICIPANTS:",
        newParticipants
      );

      console.log(
        "🟣 COUNT:",
        newParticipants.length
      );

      setParticipants(newParticipants);

    },
    [setParticipants]
  );

  useEffect(() => {
    if (!joinInfo) {
        return;
    }

    console.log(role);

    const loadClassStudents = async () => {
        const response = await fetch(
            `/api/classes/${joinInfo.class.id}/ClassParticipants`
        );

        if (!response.ok) {
            throw new Error("Failed to load class students");
        }

        const data = await response.json();

        setClassStudents(data.data);

        console.log(data);
    };

    if(role=="teacher")
      void loadClassStudents();

}, [joinInfo]);

  // A teacher who closed the browser (or lost connection) without pressing
  // "Stop Recording" leaves the server-side Jibri → YouTube recording
  // running unattended. When they come back to this lecture, reconcile the
  // UI against YouTube itself rather than trusting a possibly-stale
  // YouTubeRecording row, so "Stop Recording" reappears only if the
  // recording is confirmed still live on the channel.
  useEffect(() => {
    const lectureId = joinInfo?.lecture?.id;

    if (!joinInfo || role !== "teacher" || !lectureId) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(
          `/api/youtube/lecture/recording/status?lectureId=${lectureId}`
        );

        const data = await response.json();

        if (!cancelled && data.success && data.isRecording) {
          setIsRecording(true);
        }
      } catch (error) {
        console.error(
          "Failed to check existing YouTube recording status:",
          error
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [joinInfo, role]);

  // Loading
  if (loading) {
    return (
      <main className="flex h-screen w-full items-center justify-center bg-[#0B1120]">
        <div className="flex flex-col items-center text-center">

          {/* SL Classroom Logo */}
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-[#3B82F6]/10 ring-1 ring-[#3B82F6]/30">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#3B82F6] shadow-lg shadow-[#3B82F6]/30">
              <span className="text-2xl font-bold text-white">
                SL
              </span>
            </div>
          </div>

          {/* Brand */}
          <h1 className="text-3xl font-bold tracking-tight text-[#F8FAFC]">
            SL Classroom
          </h1>

          <p className="mt-2 text-sm text-[#94A3B8]">
            Your virtual classroom is getting ready
          </p>

          {/* Loader */}
          <div className="mt-8 flex items-center gap-3">

            <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#1E293B] border-t-[#3B82F6]" />

            <span className="text-sm font-medium text-[#CBD5E1]">
              Joining classroom...
            </span>

          </div>

          {/* Small status */}
          <div className="mt-6 flex items-center gap-2 text-xs text-[#64748B]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#3B82F6]" />
            Connecting securely
          </div>

        </div>
      </main>
    );
  }

  // Error
  if (error || !joinInfo) {
    return (
      <main className="flex h-screen w-full items-center justify-center bg-[#0B1120]">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-[#F8FAFC]">
            Unable to Join Classroom
          </h2>

          <p className="mt-2 text-sm text-red-400">
            {error ?? "Unknown error."}
          </p>
        </div>
      </main>
    );
  }

  const handleStartYouTubeLive = async () => {

    console.log("🔴 START LIVE BUTTON CLICKED");

    const lectureId = joinInfo.lecture?.id;

    if (!lectureId) {
      console.error("❌ No lecture ID available.");
      return;
    }

    setLiveStartFailed(false);

    let youtubeErrorCode: string | null = null;

    try {
      const response = await fetch(
        "/api/youtube/lecture/start",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            lectureId,
            privacy: youtubePrivacy,
          }),
        }
      );

      const data = await response.json();

      console.log(
        "🎥 YOUTUBE LIVE START RESPONSE:",
        data
      );

      youtubeErrorCode = data?.code ?? null;

      if (data?.code === "YOUTUBE_REAUTH_REQUIRED") {
        setYoutubeReauthRequired(true);
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data.error ?? "Unable to start YouTube Live."
        );
      }

      setYoutubeReauthRequired(false);
      setYoutubeConnectionLost(false);

      if (!data.streamName) {
        throw new Error(
          "YouTube stream key is missing."
        );
      }

      if (!data.broadcastId) {
        throw new Error(
          "YouTube broadcast ID is missing."
        );
      }

      console.log(
        "🔴 YOUTUBE LIVE PREPARED:",
        data
      );

      setYoutubeLiveUrl(data.youtubeUrl);

      setYoutubeLiveReusedRecording(
          data.reusedRecording === true
      );

      if (!data.alreadyStreaming) {
          console.log(
            "🚀 Starting Jitsi → YouTube stream..."
          );

          jitsiMeetingRef.current?.startYouTubeLive(
            data.streamName,
            data.broadcastId,
            "live"
          );

          console.log(
            "⏳ Waiting for Jitsi to confirm the live stream has actually started..."
          );

          await waitForYoutubeStreamConfirmation(
            liveStreamConfirmedResolverRef
          );

      } else {

        console.log(
          "♻️ Reusing existing active YouTube stream."
        );

      }

      // Only now — after Jibri has actually confirmed the stream, not just
      // after the start API call succeeded — mark Live as active. This is
      // what keeps Record disabled for the whole handoff.
      setIsLive(true);

      announce("Live stream has started.");

    } catch (error) {
      console.error(
        "❌ Failed to start YouTube live:",
        error
      );

      // Important: don't leave the UI showing Live
      setIsLive(false);
      setLiveStartFailed(true);

      const friendlyMessage = getYoutubeFriendlyErrorMessage(
        error instanceof Error ? error.message : undefined,
        "live",
        youtubeErrorCode
      );

      if (youtubeErrorCode === "YOUTUBE_NOT_CONNECTED") {
        setYoutubeConnectionLost(true);
        showYoutubeActionToast(friendlyMessage, "Connect YouTube");
      } else if (youtubeErrorCode === "YOUTUBE_REAUTH_REQUIRED") {
        showYoutubeActionToast(friendlyMessage, "Reconnect YouTube");
      } else {
        toast.error(friendlyMessage);
      }

      throw error;
    }
  };

  const handleStartYouTubeRecording = async () => {

    console.log("🎥 START YOUTUBE RECORDING BUTTON CLICKED");

    youtubeLiveRequestedRef.current = false;

    const lectureId =
      joinInfo.lecture?.id;

    if (!lectureId) {
      console.error("❌ No lecture ID available.");
      return;
    }

    let youtubeErrorCode: string | null = null;

    try {
      const response = await fetch(
        "/api/youtube/lecture/recording/start",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            lectureId,
            privacy: "unlisted",
            isLive,
          }),
        }
      );

      const data = await response.json();

      console.log(
        "🎥 YOUTUBE RECORDING START RESPONSE:",
        data
      );

      youtubeErrorCode = data?.code ?? null;

      if (data?.code === "YOUTUBE_REAUTH_REQUIRED") {
        setYoutubeReauthRequired(true);
      }

      if (!data.success) {
        throw new Error(
          data.error ?? "Unable to start YouTube recording."
        );
      }

      setYoutubeReauthRequired(false);
      setYoutubeConnectionLost(false);

      if (!data.streamName) {
        throw new Error(
          "YouTube stream key is missing."
        );
      }

      if (!data.broadcastId) {
        throw new Error(
          "YouTube broadcast ID is missing."
        );
      }

      console.log(
        "🚀 Starting Jitsi → YouTube recording..."
      );

      if (data.alreadyStreaming) {
        console.log(
          "♻️ YouTube reusable stream is already active. Reusing it."
        );
      } else {
        console.log(
          "🚀 YouTube stream is inactive. Starting Jitsi → YouTube..."
        );

        jitsiMeetingRef.current?.startYouTubeLive(
          data.streamName,
          data.broadcastId,
          "recording"
        );

        console.log(
          "⏳ Waiting for Jitsi to confirm the recording stream has actually started..."
        );

        await waitForYoutubeStreamConfirmation(
          recordingStreamConfirmedResolverRef
        );
      }

      // Only now — after Jibri has actually confirmed the stream, not just
      // after the start API call succeeded — mark recording as active. This
      // is what keeps Start Live disabled for the whole handoff.
      setIsRecording(true);

      announce("Recording has started.");

    } catch (error) {
      console.error(
        "❌ Failed to start YouTube recording:",
        error
      );

      const friendlyMessage = getYoutubeFriendlyErrorMessage(
        error instanceof Error ? error.message : undefined,
        "recording",
        youtubeErrorCode
      );

      if (youtubeErrorCode === "YOUTUBE_NOT_CONNECTED") {
        setYoutubeConnectionLost(true);
        showYoutubeActionToast(friendlyMessage, "Connect YouTube");
      } else if (youtubeErrorCode === "YOUTUBE_REAUTH_REQUIRED") {
        showYoutubeActionToast(friendlyMessage, "Reconnect YouTube");
      } else {
        toast.error(friendlyMessage);
      }

      throw error;
    }
  };

  return (
  <main className="h-screen w-full overflow-hidden bg-[#0B1120]">

    <div
      className={
        meetingReady
          ? "grid h-full min-h-0 w-full grid-cols-[minmax(0,1fr)_72px]"
          : "grid h-full min-h-0 w-full grid-cols-1"
      }
    >

      {/* <button
        type="button"
        onClick={testRecordingControl}
        className="rounded-lg bg-red-600 px-4 py-2 text-white"
      >
        Test Recording Control
      </button> */}

      {/* MAIN CLASSROOM */}
      <MeetingCard
        className={joinInfo.class.name}
        lectureTitle={joinInfo.lecture?.title}
        teacherName={teacherName}
        role={role}
        isRecording={isRecording}
        isLive={isLive}
        isStartingLive={isStartingLive}
        liveStartFailed={liveStartFailed}
        isConferenceReady={isConferenceReady}
        showHeader={meetingReady}
        startLiveButtonRef={startLiveButtonRef}
        youtubeLiveUrl={youtubeLiveUrl}
        youtubeChannelTitle={
          youtubeConnectionLost ? null : joinInfo.youtube?.channelTitle
        }
        youtubeStatus={
          youtubeConnectionLost ? null : joinInfo.youtube?.status
        }
        youtubeReauthRequired={youtubeReauthRequired}
        onReconnectYoutube={goToYouTubeOAuthConnect}
        onStartRecording={() => {
           console.log("🎥 RECORD BUTTON CLICKED");

           return handleStartYouTubeRecording();
        }}
      onStopRecording={async () => {
        console.log(
            "🛑 STOP RECORDING BUTTON CLICKED"
        );

        const lectureId =
            joinInfo.lecture?.id;

        if (!lectureId) {
            console.error(
                "❌ No lecture ID available."
            );
            return;
        }

        try {

            /*
            * First tell backend to stop the
            * specific YouTube recording broadcast.
            */
            const response =
                await fetch(
                    "/api/youtube/lecture/recording/stop",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body: JSON.stringify({
                            lectureId,
                        }),
                    }
                );

            const data =
                await response.json();

            console.log(
                "⏹ YOUTUBE RECORDING STOP RESPONSE:",
                data
            );

            if (!data.success) {
                console.error(
                    "❌ Failed to stop YouTube recording:",
                    data.error
                );

                return;
            }

            /*
            * Now stop the Jitsi recording itself.
            *
            * This does NOT mean stopping the
            * shared YouTube/Jibri stream.
            */
            // jitsiMeetingRef.current?.stopRecording();

            setIsRecording(false);

            announce("Recording has stopped.");

            if (!isLive) {
            console.log(
                "🛑 Recording and Live are both stopped."
            );

            console.log(
                "🛑 Stopping shared Jitsi/Jibri stream..."
            );

            jitsiMeetingRef.current?.stopYouTubeLive();
        } else {
            console.log(
                "🔴 Live is still active. Keeping shared Jitsi/Jibri stream alive."
            );
        }

        } catch (error) {

            console.error(
                "❌ Failed to stop YouTube recording:",
                error
            );
        }
    }}

        onStartLive={() => {
          console.log("🔴 START LIVE BUTTON CLICKED");
          setShowYoutubePrivacy(true);
        }}

        onStopLive={async () => {

          if (
              youtubeLiveReusedRecording &&
              isRecording
          ) {
              console.log(
                  "♻️ This Live uses the active recording broadcast."
              );

              console.log(
                  "⏹ Stopping Live mode only. Recording will continue."
              );

              setIsLive(false);

              setYoutubeLiveUrl(null);

              setYoutubeLiveReusedRecording(false);

              announce("Live stream has stopped.");

              return;
          }

          console.log("🛑 STOP LIVE BUTTON CLICKED");

          youtubeLiveRequestedRef.current = false;

          const lectureId =
            joinInfo.lecture?.id;

          if (!lectureId) {
            console.error(
              "❌ No lecture ID available."
            );
            return;
          }

          try {
            const response = await fetch(
              "/api/youtube/lecture/stop",
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body: JSON.stringify({
                  lectureId,
                }),
              }
            );

            const data =
              await response.json();

            console.log(
              "🎥 YOUTUBE STOP LIVE RESPONSE:",
              data
            );

            if (!data.success) {
              console.error(
                "❌ Failed to stop YouTube Live:",
                data.error
              );
              return;
            }

            /*
            * Only update the UI after the backend
            * successfully stopped the Live broadcast.
            */
            setIsLive(false);

            announce("Live stream has stopped.");

            if (!isRecording) {
              console.log(
                  "🛑 Live and Recording are both stopped."
              );

              console.log(
                  "🛑 Stopping shared Jitsi/Jibri stream..."
              );

              jitsiMeetingRef.current?.stopYouTubeLive();
          } else {
              console.log(
                  "⏺ Recording is still active. Keeping shared Jitsi/Jibri stream alive."
              );
          }

            /*
            * IMPORTANT:
            *
            * Do NOT call:
            *
            * jitsiMeetingRef.current?.stopYouTubeLive();
            *
            * here.
            *
            * Recording may still be using the same
            * Jitsi → YouTube reusable stream.
            */

          } catch (error) {

            console.error(
              "❌ Failed to stop YouTube Live:",
              error
            );
          }
        }}
      >
        <PermissionGate onReadyChange={setMeetingReady}>
          <JitsiMeeting
            ref={jitsiMeetingRef}
            onRecordingStatusChanged={(recording) => {
              console.log(
                "🎥 CLASSROOM RECORDING STATUS:",
                recording
              );

              if (recording && recordingStreamConfirmedResolverRef.current) {
                recordingStreamConfirmedResolverRef.current();
              }

              //setIsRecording(recording);
            }}
            onLiveStatusChanged={(live) => {
              console.log(
                "🔴 CLASSROOM LIVE STATUS:",
                live
              );

              if (live && liveStreamConfirmedResolverRef.current) {
                liveStreamConfirmedResolverRef.current();
              }

              // Only update the Live button state when
              // the teacher explicitly started YouTube Live.
              if (youtubeLiveRequestedRef.current) {
                setIsLive(live);
              }
            }}
            onConferenceJoined={() => setIsConferenceJoined(true)}
            onModeratorStatusChanged={setIsModerator}
            joinInfo={joinInfo}
            role={role}
            teacherName={teacherName}
            onParticipantsChanged={handleParticipantsChanged}
            onChatMessage={handleChatMessage}
            onParticipantStatusChanged={(
              participantId,
              status
            ) => {

              console.log(
                "🟣 PARTICIPANT STATUS UPDATE:",
                participantId,
                status
              );

              setParticipants((previous) =>
                previous.map((participant) =>
                  participant.participantId === participantId
                    ? {
                        ...participant,
                        status: {
                          ...participant.status,
                          ...status,
                        },
                      }
                    : participant
                )
              );
            }}
          />
        </PermissionGate>
      </MeetingCard>

      {showYoutubePrivacy && youtubePrivacyPos && (
        <>
        {/* Transparent click-catcher: most of the screen is the Jitsi meeting
            iframe, whose clicks never bubble to this document, so we can't
            rely on a document-level "outside click" listener to close this. */}
        <button
          type="button"
          aria-label="Close"
          onClick={() => setShowYoutubePrivacy(false)}
          className="fixed inset-0 z-40 cursor-default"
        />
        <div
          ref={youtubePrivacyPopoverRef}
          className="fixed z-50 w-[384px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-[#1E293B] bg-[#112D5C] p-5 shadow-2xl"
          style={{ top: youtubePrivacyPos.top, right: youtubePrivacyPos.right }}
        >

          <div className="mb-5">
            <h3 className="text-lg font-semibold text-[#F8FAFC]">
              Start YouTube Live
            </h3>

            <p className="mt-1 text-sm text-[#94A3B8]">
              Choose who can watch your live stream.
            </p>
          </div>

          <div className="space-y-3">

            {/* PUBLIC */}
            <button
              type="button"
              onClick={() => {
                setYoutubePrivacy("public");
              }}
              className={`w-full rounded-xl border p-4 text-left transition ${
                youtubePrivacy === "public"
                  ? "border-[#3B82F6] bg-[#3B82F6]/10"
                  : "border-[#1B3A6B] bg-[#0B2044]/70 hover:bg-[#153060]"
              }`}
            >
              <div className="font-semibold text-[#F8FAFC]">
                Public
              </div>

              <div className="mt-1 text-xs text-[#94A3B8]">
                Anyone can find and watch this live stream.
              </div>
            </button>

            {/* UNLISTED */}
            <button
              type="button"
              onClick={() => {
                setYoutubePrivacy("unlisted");
              }}
              className={`w-full rounded-xl border p-4 text-left transition ${
                youtubePrivacy === "unlisted"
                  ? "border-[#3B82F6] bg-[#3B82F6]/10"
                  : "border-[#1B3A6B] bg-[#0B2044]/70 hover:bg-[#153060]"
              }`}
            >
              <div className="font-semibold text-[#F8FAFC]">
                Unlisted
              </div>

              <div className="mt-1 text-xs text-[#94A3B8]">
                Only people with the link can watch.
              </div>
            </button>

            {/* PRIVATE */}
            <button
              type="button"
              onClick={() => {
                setYoutubePrivacy("private");
              }}
              className={`w-full rounded-xl border p-4 text-left transition ${
                youtubePrivacy === "private"
                  ? "border-[#3B82F6] bg-[#3B82F6]/10"
                  : "border-[#1B3A6B] bg-[#0B2044]/70 hover:bg-[#153060]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[#F8FAFC]">
                  Private
                </span>
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                  Not recommended
                </span>
              </div>

              <div className="mt-1 text-xs text-[#94A3B8]">
                Only you, the account owner, can view it.
              </div>
            </button>

          </div>

          <div className="mt-6 flex justify-end gap-3">

            <button
              type="button"
              onClick={() => {
                setShowYoutubePrivacy(false);
              }}
              className="rounded-lg px-4 py-2 text-sm font-medium text-[#CBD5E1] transition hover:bg-[#1E293B]"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={async () => {
                setShowYoutubePrivacy(false);

                youtubeLiveRequestedRef.current = true;

                setIsStartingLive(true);

                try {
                  await handleStartYouTubeLive();
                } catch {
                  // Error already surfaced via toast inside handleStartYouTubeLive.
                } finally {
                  setIsStartingLive(false);
                }
              }}
              className="rounded-lg bg-[#EF4444] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#DC2626]"
            >
              Start Live
            </button>

          </div>

        </div>
        </>
    )}

      {/* RIGHT SIDEBAR */}
      {meetingReady && (
        <RightSidebar
          classId={joinInfo.class.id}
          className={joinInfo.class.name}
          lectureId={joinInfo.lecture?.id ?? null}
          lectureTitle={joinInfo.lecture?.title}
          teacherName={teacherName}
          role={role}
          participants={participants}
          ClassroomStudents={classStudents}
          onMuteEveryone={() => jitsiMeetingRef.current?.muteEveryone()}
          onMuteParticipant={(participantId, muted) =>
            jitsiMeetingRef.current?.setParticipantAudioMuted(participantId, muted)
          }
          chatMessages={chatMessages}
          onSendChat={sendChat}
          onSetVideoQuality={(heightPx) =>
            jitsiMeetingRef.current?.setVideoQuality(heightPx)
          }
          onSetNoiseSuppression={(enabled) =>
            jitsiMeetingRef.current?.setNoiseSuppression(enabled)
          }
        />
      )}

    </div>

  </main>
);
}