"use client";

import PermissionGate from "./PermissionGate";
import JitsiMeeting from "./JitsiMeeting";
import type { JitsiMeetingControls } from "./JitsiMeeting";

import useJoinSession from "./hooks/useJoinSession";
import MeetingCard from "./classroom/meeting/MeetingCard";
import OrientationHint from "./classroom/meeting/OrientationHint";
import RightSidebar from "./classroom/sidebar/RightSidebar";
import useParticipants from "./hooks/useParticipants";
import useBreakoutRooms from "./hooks/useBreakoutRooms";
import useCameraMonitoring from "./hooks/useCameraMonitoring";
import useTeacherTiles from "./hooks/useTeacherTiles";
import type { TeacherTilesNavAction, TeacherTilesSettingsChange } from "./hooks/useJitsi";
import { useClassroomViewport, useVisualViewportVars } from "./hooks/useClassroomViewport";
import { roomLabelByParticipantName } from "./breakout-utils";

import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChatMessage, ClassroomStudent, JitsiParticipant } from "./types";
import { ClassStudent } from "@prisma/client";
import { ClassItem } from "../class-management-panel";

import toast from "react-hot-toast";
import { showYoutubeCleanupWarning } from "@/components/youtube-cleanup-warning";
import {
  getYoutubeFriendlyErrorMessage,
  getYoutubeStopErrorMessage,
  getYoutubeStreamStoppedMessage,
  getYoutubeCleanupPendingMessage,
} from "@/lib/youtube-error-messages";
import { announce } from "@/lib/voice-announcer";
import {
  createYouTubeStreamController,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  type StartOutcome,
  type YouTubeFeature,
  type YouTubeStartData,
  type YouTubeStopData,
  type YouTubeStreamController,
} from "./youtube-stream-controller";
import { RotateCcw, Video, X, XCircle, Maximize2, Globe, Link2, Lock, Radio } from "lucide-react";

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

// Width of the "Start YouTube Live" popover (desktop / tablet), shared by its
// placement under the Start Live button and its markup.
const YOUTUBE_PRIVACY_POPOVER_WIDTH = 336;

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

  const rootRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Responsive layout (see .sl-classroom in globals.css): which mode we are in, and the
  // on-screen keyboard height for the phone bottom sheets.
  const viewport = useClassroomViewport();
  useVisualViewportVars();

  // Fullscreen "immersive" mode: the header and the right rail are hidden and
  // slide in only while the pointer is at the top / right edge of the screen.
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Real iPhone Safari has no Element.requestFullscreen() support for
  // arbitrary elements, so document.fullscreenElement never becomes non-null
  // there — this is a separate, CSS-only "simulated fullscreen" flag for that
  // case (see handleEnterFullscreen below). isFullscreen itself stays a pure
  // reflection of the real fullscreenchange event, unchanged.
  const [isCssFullscreenFallback, setIsCssFullscreenFallback] = useState(false);
  const isFullscreenActive = isFullscreen || isCssFullscreenFallback;

  const [revealTop, setRevealTop] = useState(false);
  const [revealRight, setRevealRight] = useState(false);
  const [sidebarPanelOpen, setSidebarPanelOpen] = useState(false);
  const hideTopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideRightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));

    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen) {
      setRevealTop(false);
      setRevealRight(false);
    }
  }, [isFullscreen]);

  useEffect(() => {
    // These refs hold timers (not DOM nodes), so the latest value is what we want.
    /* eslint-disable react-hooks/exhaustive-deps */
    return () => {
      if (hideTopTimerRef.current) clearTimeout(hideTopTimerRef.current);
      if (hideRightTimerRef.current) clearTimeout(hideRightTimerRef.current);
    };
    /* eslint-enable react-hooks/exhaustive-deps */
  }, []);

  const revealEdge = useCallback((edge: "top" | "right") => {
    const timerRef = edge === "top" ? hideTopTimerRef : hideRightTimerRef;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    (edge === "top" ? setRevealTop : setRevealRight)(true);
  }, []);

  const hideEdgeSoon = useCallback((edge: "top" | "right") => {
    const timerRef = edge === "top" ? hideTopTimerRef : hideRightTimerRef;

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      (edge === "top" ? setRevealTop : setRevealRight)(false);
    }, 500);
  }, []);

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
    // Anchored by its right edge under the button, but never past the left edge of the
    // screen (the button can sit on the left when the header wraps onto two rows).
    const popoverWidth = Math.min(YOUTUBE_PRIVACY_POPOVER_WIDTH, window.innerWidth - 24);
    setYoutubePrivacyPos({
      top: rect.bottom + 8,
      right: Math.max(
        8,
        Math.min(window.innerWidth - rect.right, window.innerWidth - popoverWidth - 8)
      ),
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
  useRef<JitsiMeetingControls | null>(null);

  // Guards handleLocalUserLeft below against firing more than once (defensive —
  // unmounting from any other redirect already cancels the pending leave timer
  // that calls it, but this makes the "only navigate once" guarantee explicit).
  const hasLeftClassroomRef = useRef(false);

  // Fired by useJitsi.ts only once the local user has genuinely left the
  // conference (never for a breakout-room switch — see onLocalUserLeft's own
  // doc comment there). Does not touch the application ClassSession at all —
  // "Leave Classroom" only leaves Jitsi and goes back to the right dashboard,
  // exactly like the native Jitsi hangup behavior did before this existed.
  // Declared here (unconditionally, alongside the other hooks) rather than
  // after the loading/error early returns below, since useCallback must run
  // on every render regardless of which branch this component takes.
  const handleLocalUserLeft = useCallback(() => {
    if (hasLeftClassroomRef.current) return;
    hasLeftClassroomRef.current = true;

    router.push(role === "teacher" ? "/dashboard" : "/student/dashboard");
  }, [role, router]);

  // Breakout rooms: state comes from Jitsi's own events, actions go through the
  // centralized wrappers on the Jitsi controls.
  const breakout = useBreakoutRooms({
    role,
    jitsiDomain: joinInfo?.session.jitsiDomain ?? "",
    teacherName,
    isStreaming: isRecording || isLive,
    getControls: useCallback(() => jitsiMeetingRef.current, []),
  });

  const breakoutRoomLabels = useMemo(
    () => roomLabelByParticipantName(breakout.rooms),
    [breakout.rooms]
  );

  const [youtubeLiveUrl, setYoutubeLiveUrl] =
    useState<string | null>(null);

  // Teacher: YouTube Recording / Live around the ONE Jibri stream
  // (youtube-stream-controller.ts). A start stays "Starting" until Jibri
  // confirms the stream (or rides on one already confirmed); a failed start
  // cleans up only what it owns; Jibri stopping on its own ends the features
  // riding on it. The buttons show its state (isRecording / isLive below).
  const joinInfoRef = useRef(joinInfo);
  joinInfoRef.current = joinInfo;

  const youtubeStreamRef = useRef<YouTubeStreamController | null>(null);

  if (!youtubeStreamRef.current) {
    const postYouTube = async <T,>(
      url: string,
      body: Record<string, unknown>,
      timeoutMs?: number
    ): Promise<{ status: number; data: T }> => {
      const lectureId = joinInfoRef.current?.lecture?.id;

      if (!lectureId) {
        throw new Error("No lecture ID available.");
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lectureId, ...body }),
        // The controller also limits the wait itself; this frees the request.
        ...(timeoutMs && typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
          ? { signal: AbortSignal.timeout(timeoutMs) }
          : {}),
      });

      let data: unknown;

      try {
        data = await response.json();
      } catch {
        data = { success: false, error: "Unexpected response from the server." };
      }

      console.log("🎥 YouTube", url, response.status, data);

      return { status: response.status, data: data as T };
    };

    youtubeStreamRef.current = createYouTubeStreamController({
      // Starts carry this classroom's session: the server refuses (409) a
      // session that has ended or been replaced.
      startFeature: (feature, { privacy }) =>
        feature === "recording"
          ? postYouTube<YouTubeStartData>("/api/youtube/lecture/recording/start", {
              privacy: "unlisted",
              isLive: youtubeStreamRef.current?.getState().live !== "off",
              sessionId: joinInfoRef.current?.session?.id,
            })
          : postYouTube<YouTubeStartData>("/api/youtube/lecture/start", {
              privacy,
              sessionId: joinInfoRef.current?.session?.id,
            }),
      abortStart: (feature, body) =>
        postYouTube<YouTubeStopData>(
          "/api/youtube/lecture/start/abort",
          { feature, ...body },
          DEFAULT_CLEANUP_TIMEOUT_MS
        ),
      stopFeature: (feature) =>
        postYouTube<YouTubeStopData>(
          feature === "recording"
            ? "/api/youtube/lecture/recording/stop"
            : "/api/youtube/lecture/stop",
          {}
        ),
      startJibri: (streamKey, broadcastId, feature) =>
        jitsiMeetingRef.current?.startYouTubeLive(streamKey, broadcastId, feature),
      stopJibri: () => jitsiMeetingRef.current?.stopYouTubeLive(),
      log: (...args) => console.log("🎥", ...args),
    });
  }

  // The teacher's buttons follow the controller (students keep the SSE below).
  useEffect(() => {
    const controller = youtubeStreamRef.current;

    if (!controller || role !== "teacher") {
      return;
    }

    return controller.subscribe((state, change) => {
      setIsRecording(state.recording === "on" || state.recording === "restored");
      setIsLive(state.live === "on" || state.live === "restored");

      if (state.live === "off") {
        setYoutubeLiveUrl(null);
      }

      if (change.type === "jibri-stopped") {
        toast.error(getYoutubeStreamStoppedMessage(change.features));
        announce("The YouTube stream stopped.");
      }

      if (change.type === "cleanup-pending") {
        toast.error(getYoutubeCleanupPendingMessage(change.feature));
      }
    });
  }, [role]);

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

        if (role === "teacher") {
          // Restores Live after a reload / reflects a stop elsewhere; never
          // overrides a start in progress (the controller ignores it then).
          const controller = youtubeStreamRef.current;

          controller?.serverReport("live", data.isLive);

          if (controller?.getState().live !== "off" && data.youtubeUrl) {
            setYoutubeLiveUrl(data.youtubeUrl);
          }

          return;
        }

        setIsLive(data.isLive);
        setYoutubeLiveUrl(data.youtubeUrl);
      } catch {
        /* ignore malformed payloads */
      }
    };

    source.addEventListener("live-status", handleLiveStatus);

    // The teacher ending the session (existing endClassSessionForTeacher flow,
    // wherever it was triggered from) is signalled on this same per-session
    // stream. Students leave the classroom. The teacher's page ends its
    // YouTube features and stops the Jibri stream it may still have running
    // (e.g. the session was ended from the dashboard while this page stayed
    // open); the teacher's own End Session action navigates away itself.
    // The server sends only this session's end; the check below also
    // ignores any event naming another session.
    let handleSessionEnded: ((event: MessageEvent) => void) | null = null;

    const isThisSession = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { sessionId?: string };

        return data.sessionId === sessionId;
      } catch {
        return false;
      }
    };

    if (role === "student") {
      handleSessionEnded = (event) => {
        if (isThisSession(event)) router.push("/student/dashboard");
      };
    } else if (role === "teacher") {
      handleSessionEnded = (event) => {
        if (isThisSession(event)) youtubeStreamRef.current?.sessionEnded();
      };
    }

    if (handleSessionEnded) {
      source.addEventListener("session-ended", handleSessionEnded);
    }

    return () => {
      source.removeEventListener("live-status", handleLiveStatus);
      if (handleSessionEnded) {
        source.removeEventListener("session-ended", handleSessionEnded);
      }
      source.close();
    };
  }, [joinInfo?.session?.id, role, router]);

  // Teacher only: studentId -> Jitsi participantId for this session, pushed over
  // SSE (each student registers its own ID after joining Jitsi). Lets the teacher
  // address students by application ID instead of by display name.
  const [participantMap, setParticipantMap] =
    useState<Record<string, string>>({});
  const participantMapRef = useRef(participantMap);
  participantMapRef.current = participantMap;

  useEffect(() => {
    const sessionId = joinInfo?.session?.id;

    if (!sessionId || role !== "teacher") return;

    const source = new EventSource(`/api/sessions/${sessionId}/participant-map`);

    // Every event carries the whole map, so the latest one simply replaces it.
    const handleParticipantMap = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as {
          participants?: Record<string, string>;
        };

        setParticipantMap(data.participants ?? {});
      } catch {
        /* ignore malformed payloads */
      }
    };

    source.addEventListener("participant-map", handleParticipantMap);

    return () => {
      source.removeEventListener("participant-map", handleParticipantMap);
      source.close();
    };
  }, [joinInfo?.session?.id, role]);

  // ---------------------------------------------------------------------------
  // PHASE 1 TESTING ONLY — remove once the paging UI drives the receive set.
  // Teacher-only console hook for choosing which students' cameras this
  // teacher receives, e.g. in DevTools (top frame):
  //   __slReceiveTest.map()                      // studentId -> participantId
  //   __slReceiveTest.set(["de809448"])          // by Jitsi participant ID
  //   __slReceiveTest.setStudents(["<studentId>"]) // by application student ID
  //   __slReceiveTest.off()                      // back to Jitsi's own choice
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (role !== "teacher") return;

    const testApi = {
      map: () => ({ ...participantMapRef.current }),
      set: (participantIds: string[]) => {
        jitsiMeetingRef.current?.setReceiveSet(participantIds);
      },
      setStudents: (studentIds: string[]) => {
        const participantIds = studentIds
          .map((studentId) => participantMapRef.current[studentId])
          .filter((participantId): participantId is string => Boolean(participantId));

        jitsiMeetingRef.current?.setReceiveSet(participantIds);
        return participantIds;
      },
      off: () => {
        jitsiMeetingRef.current?.setReceiveSet(null);
      },
    };

    const testWindow = window as typeof window & { __slReceiveTest?: typeof testApi };
    testWindow.__slReceiveTest = testApi;

    return () => {
      if (testWindow.__slReceiveTest === testApi) {
        delete testWindow.__slReceiveTest;
      }
    };
  }, [role]);

  // Teacher only: camera monitoring. Pages through the present students and, in
  // exam mode, limits the student cameras this teacher receives to the current
  // page (via the Phase 1 receive set). Kept here, not in the sidebar, so it
  // keeps working while the Class Register panel is closed.
  const setReceiveSet = useCallback((participantIds: string[] | null) => {
    jitsiMeetingRef.current?.setReceiveSet(participantIds);
  }, []);

  // Display only: which received cameras the in-iframe monitoring grid shows.
  const setMonitorView = useCallback((participantIds: string[] | null) => {
    jitsiMeetingRef.current?.setMonitorView(participantIds);
  }, []);

  // Bumped on every Jitsi conference join (first join, rejoin, or a remounted
  // JitsiMeeting), so monitoring can resend its receive set to a fresh iframe.
  const [conferenceGeneration, setConferenceGeneration] = useState(0);

  const cameraMonitoring = useCameraMonitoring({
    enabled: role === "teacher",
    conferenceGeneration,
    classStudents,
    participantMap,
    participants,
    setReceiveSet,
    setMonitorView,
  });

  // Teacher only: SL Classroom's own normal mode view (custom stage + custom
  // filmstrip) in the teacher's Jitsi iframe, shown in normal mode and hidden
  // in exam mode. Reads the monitoring mode only; exam mode itself is driven by
  // useCameraMonitoring as before. Sent again for every new conference
  // generation (a remounted iframe starts without it); custom.js also hides
  // the view on its own while the exam grid is showing.
  const isTeacherNormalView =
    role === "teacher" && cameraMonitoring.mode === "normal";

  useEffect(() => {
    if (role !== "teacher" || conferenceGeneration === 0) {
      return;
    }

    jitsiMeetingRef.current?.setTeacherView(isTeacherNormalView);
  }, [role, isTeacherNormalView, conferenceGeneration]);

  // Teacher only: the Normal mode view's layout (List / Tiles) and the Tiles
  // page: the same present students as monitoring, in roster order, with the
  // Tiles view's own page sizes (10-50). Exam Mode keeps its own paging and is
  // not affected. Sent on every change and again for every new conference
  // generation (a remounted iframe starts in List view).
  const teacherTiles = useTeacherTiles({
    enabled: role === "teacher",
    presentStudents: cameraMonitoring.presentStudents,
    participantMap,
  });

  const teacherTilesRef = useRef(teacherTiles);
  teacherTilesRef.current = teacherTiles;

  const teacherTilesKey = JSON.stringify([
    teacherTiles.layout,
    teacherTiles.participantIds,
    teacherTiles.page,
    teacherTiles.pageCount,
    teacherTiles.rangeStart,
    teacherTiles.rangeEnd,
    teacherTiles.total,
    teacherTiles.pageSize,
  ]);

  useEffect(() => {
    if (role !== "teacher" || conferenceGeneration === 0) {
      return;
    }

    const tiles = teacherTilesRef.current;

    jitsiMeetingRef.current?.setTeacherTiles({
      layout: tiles.layout,
      participantIds: tiles.participantIds,
      page: tiles.page,
      pageCount: tiles.pageCount,
      rangeStart: tiles.rangeStart,
      rangeEnd: tiles.rangeEnd,
      total: tiles.total,
      pageSize: tiles.pageSize,
    });
  }, [role, conferenceGeneration, teacherTilesKey]);

  // Previous / Next pressed inside the iframe's Tiles view.
  const handleTeacherTilesNav = useCallback((action: TeacherTilesNavAction) => {
    if (action === "previous") {
      teacherTilesRef.current.goToPreviousPage();
    } else {
      teacherTilesRef.current.goToNextPage();
    }
  }, []);

  // View / Tiles page size chosen in the iframe's filmstrip settings menu: the
  // same state and setters (useTeacherTiles validates both), answered with a
  // new SL_TEACHER_TILES by the effect above.
  const handleTeacherTilesSettings = useCallback((change: TeacherTilesSettingsChange) => {
    if (change.layout) {
      teacherTilesRef.current.setLayout(change.layout);
    }

    if (change.pageSize !== undefined) {
      teacherTilesRef.current.setPageSize(change.pageSize);
    }
  }, []);

  const [meetingReady, setMeetingReady] =
    useState(false);

  // The header can wrap onto a second row on narrow screens, so its real height is
  // measured and published as --sl-header-h. The side panel and the rail are offset
  // by it (globals.css, .sl-classroom).
  useEffect(() => {
    const header = headerRef.current;
    const root = rootRef.current;

    if (!meetingReady || !header || !root) {
      return;
    }

    const publish = () => {
      root.style.setProperty("--sl-header-h", `${Math.round(header.getBoundingClientRect().height)}px`);
    };

    publish();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(publish);
    observer.observe(header);

    return () => {
      observer.disconnect();
    };
  }, [meetingReady]);

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

    // Students: the read-only Class Register's roster (names only), for
    // a student enrolled in this live session's class.
    const loadStudentRegister = async () => {
        const response = await fetch(
            `/api/sessions/${joinInfo.session.id}/register`
        );

        const payload = await response.json().catch(() => null);

        if (!response.ok || !payload?.success) {
            throw new Error(
                payload?.error?.message ?? "Failed to load the class register"
            );
        }

        setClassStudents(
            (payload.data.students as { studentId: string; displayName: string }[]).map(
                (student) => ({ ...student, email: null })
            )
        );
    };

    if(role=="teacher")
      void loadClassStudents();
    else
      loadStudentRegister().catch((error) =>
        console.error("❌ Class register:", error)
      );

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

        // Restored as "active per the server"; Jibri's own events confirm
        // (or end) it.
        if (!cancelled && data.success) {
          youtubeStreamRef.current?.serverReport("recording", data.isRecording === true);
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
      <main className="flex h-screen h-dvh w-full items-center justify-center bg-[#0B1120]">
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
      <main className="flex h-screen h-dvh w-full items-center justify-center bg-[#0B1120]">
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

  // A start's failure, shown to the teacher (and thrown for MeetingCard).
  const reportYoutubeStartFailure = (
    feature: YouTubeFeature,
    outcome: Exclude<StartOutcome, { ok: true } | { reason: "busy" } | { reason: "session-ended" }>
  ): never => {
    const code =
      outcome.reason === "api"
        ? outcome.data?.code ?? null
        : outcome.reason === "jibri-timeout"
          ? "JIBRI_START_TIMEOUT"
          : "JIBRI_START_FAILED";

    const message =
      outcome.reason === "api" ? outcome.data?.error : outcome.error;

    console.error("❌ YouTube " + feature + " did not start:", outcome);

    if (code === "YOUTUBE_REAUTH_REQUIRED") {
      setYoutubeReauthRequired(true);
    }

    const friendlyMessage = getYoutubeFriendlyErrorMessage(
      typeof message === "string" ? message : undefined,
      feature,
      code
    );

    if (code === "YOUTUBE_NOT_CONNECTED") {
      setYoutubeConnectionLost(true);
      showYoutubeActionToast(friendlyMessage, "Connect YouTube");
    } else if (code === "YOUTUBE_REAUTH_REQUIRED") {
      showYoutubeActionToast(friendlyMessage, "Reconnect YouTube");
    } else {
      toast.error(friendlyMessage);
    }

    throw new Error(friendlyMessage);
  };

  const handleStartYouTubeLive = async () => {

    console.log("🔴 START LIVE BUTTON CLICKED");

    setLiveStartFailed(false);

    const outcome = await youtubeStreamRef.current!.start("live", {
      privacy: youtubePrivacy,
    });

    if (outcome.ok) {
      setYoutubeReauthRequired(false);
      setYoutubeConnectionLost(false);
      setYoutubeLiveUrl(outcome.data.youtubeUrl ?? null);
      announce("Live stream has started.");
      return;
    }

    // session-ended: the session-ended handling already informs the teacher.
    if (outcome.reason === "busy" || outcome.reason === "session-ended") {
      return;
    }

    setLiveStartFailed(true);
    reportYoutubeStartFailure("live", outcome);
  };

  const handleStartYouTubeRecording = async () => {

    console.log("🎥 START YOUTUBE RECORDING BUTTON CLICKED");

    const outcome = await youtubeStreamRef.current!.start("recording");

    if (outcome.ok) {
      setYoutubeReauthRequired(false);
      setYoutubeConnectionLost(false);
      announce("Recording has started.");
      return;
    }

    // session-ended: the session-ended handling already informs the teacher.
    if (outcome.reason === "busy" || outcome.reason === "session-ended") {
      return;
    }

    reportYoutubeStartFailure("recording", outcome);
  };

  // Stop Recording / Stop Live: the server decides what ends (shared
  // broadcast, Jibri); a stop that did not go through keeps the feature and
  // is reported (and thrown, so MeetingCard clears its "Stopping…" state).
  const handleStopYouTubeFeature = async (feature: YouTubeFeature) => {
    const outcome = await youtubeStreamRef.current!.stop(feature);

    if (outcome.ok) {
      announce(feature === "recording" ? "Recording has stopped." : "Live stream has stopped.");
      return;
    }

    const code = outcome.data?.code ?? null;

    if (code === "YOUTUBE_REAUTH_REQUIRED") {
      setYoutubeReauthRequired(true);
    }

    const message = getYoutubeStopErrorMessage(feature, code);

    toast.error(message);
    throw new Error(message);
  };

  // Teacher-only: the existing End Session flow (same POST used by the lecture/session
  // card in lecture-management-panel.tsx), triggered from inside the live classroom.
  // Jitsi is only told to end the conference AFTER the application session has
  // actually been ended — a failed API call leaves the teacher in the classroom with
  // Jitsi untouched, exactly as required.
  const handleEndSessionForEveryone = async () => {
    console.log("🛑 END SESSION BUTTON CLICKED (teacher)");

    try {
      const response = await fetch(`/api/sessions/${joinInfo.session.id}/end`, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error?.message ?? "Unable to end the session.");
      }

      // YouTube cleanup the server could not confirm: said, not hidden.
      showYoutubeCleanupWarning(data.data?.youtubeCleanup, "end");
    } catch (error) {
      console.error("❌ Failed to end session:", error);

      toast.error(
        error instanceof Error ? error.message : "Unable to end the session."
      );

      // Keep the teacher in the classroom — Jitsi is not touched on failure.
      return;
    }

    jitsiMeetingRef.current?.endConference();

    router.push("/dashboard");
  };

  // Capability check, not a device/user-agent check: document.fullscreenEnabled
  // is false on real iPhone Safari (no Element.requestFullscreen() support for
  // arbitrary elements there) and true everywhere the real API works, so this
  // naturally covers "iPhone" without naming it.
  const supportsElementFullscreen =
    typeof document !== "undefined" && document.fullscreenEnabled === true;

  const handleEnterFullscreen = async () => {
    if (!supportsElementFullscreen) {
      setIsCssFullscreenFallback(true);
      return;
    }

    try {
      await jitsiMeetingRef.current?.requestFullscreen();
    } catch (error) {
      console.error("Unable to enter fullscreen, using the CSS fallback instead:", error);
      setIsCssFullscreenFallback(true);
    }
  };

  // Mobile header button only: purely CSS/state — never calls
  // Element.requestFullscreen() or touches document.fullscreenElement at all.
  // Desktop keeps using handleEnterFullscreen (the real API) above, unchanged.
  const handleEnterCssFullscreen = () => {
    setIsCssFullscreenFallback(true);
  };

  const handleExitFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch((error) => {
        console.error("Unable to exit fullscreen:", error);
      });
    }

    setIsCssFullscreenFallback(false);
  };

  // In fullscreen the header / rail stay hidden until the pointer reaches the
  // edge. They also stay put while something anchored to them is open.
  // Touch layouts have no hover, so there the normal header / bar stay visible.
  const immersive = isFullscreen && meetingReady && !viewport.isTouchLayout;
  const headerVisible = revealTop || showYoutubePrivacy;
  const sidebarVisible = revealRight || sidebarPanelOpen;

  return (
  <main
    ref={rootRef}
    className="sl-classroom h-screen h-dvh w-full overflow-hidden bg-[#0B1120]"
  >

    <div
      className={
        meetingReady && !immersive
          ? "sl-grid--split grid h-full min-h-0 w-full"
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
        // Orientation tip (teacher + student): a portrait phone presents a
        // narrow, pillarboxed video to everyone. Its own row under the header,
        // so it never covers the video, filmstrip, bottom bar or sidebar.
        // `viewport.isPhone` (phone width AND portrait) turns it off the
        // instant the phone rotates; the tip itself also checks for a touch
        // device and remembers a dismissal.
        belowHeader={viewport.isPhone ? <OrientationHint /> : undefined}
        headerRef={headerRef}
        breakoutActive={breakout.isInBreakout}
        immersive={
          immersive
            ? {
                headerVisible,
                sidebarVisible,
                onPointerEnter: () => revealEdge("top"),
                onPointerLeave: () => hideEdgeSoon("top"),
              }
            : undefined
        }
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
      onStopRecording={() => {
        console.log("🛑 STOP RECORDING BUTTON CLICKED");

        return handleStopYouTubeFeature("recording");
      }}

        onStartLive={() => {
          console.log("🔴 START LIVE BUTTON CLICKED");
          setShowYoutubePrivacy(true);
        }}

        onStopLive={() => {
          console.log("🛑 STOP LIVE BUTTON CLICKED");

          return handleStopYouTubeFeature("live");
        }}

        onEndSession={handleEndSessionForEveryone}
        isMobile={viewport.isTouchLayout}
        onEnterFullscreen={handleEnterCssFullscreen}
      >
        <PermissionGate onReadyChange={setMeetingReady}>
          <JitsiMeeting
            ref={jitsiMeetingRef}
            onBreakoutRoomsUpdated={breakout.handleRoomsUpdated}
            onRoomChanged={breakout.handleRoomChanged}
            onBreakoutSupportChanged={breakout.handleSupportChanged}
            onYouTubeStreamStatusChanged={(status) => {
              console.log("🎥 CLASSROOM YOUTUBE STREAM STATUS:", status);

              youtubeStreamRef.current?.onStreamStatus(status);
            }}
            onConferenceJoined={() => {
              // A (re)joined conference: Jibri's state is unknown until its
              // next status event.
              youtubeStreamRef.current?.conferenceChanged();
              setIsConferenceJoined(true);
              setConferenceGeneration((generation) => generation + 1);
            }}
            onLocalUserLeft={handleLocalUserLeft}
            onModeratorStatusChanged={setIsModerator}
            onTeacherTilesNav={role === "teacher" ? handleTeacherTilesNav : undefined}
            onTeacherTilesSettings={role === "teacher" ? handleTeacherTilesSettings : undefined}
            joinInfo={joinInfo}
            role={role}
            teacherName={teacherName}
            isFullscreen={isFullscreenActive}
            onExitFullscreen={handleExitFullscreen}
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
          role="dialog"
          aria-modal="false"
          aria-labelledby="sl-youtube-privacy-title"
          className={`fixed rounded-[18px] border border-white/[0.08] bg-[#0E2347] p-4 text-left shadow-[0_18px_48px_-12px_rgba(2,6,23,0.7),inset_0_1px_0_rgba(255,255,255,0.04)] ${
            viewport.isPhone
              ? // Phone: a sheet above the bottom bar instead of a popover pinned to the header button.
                "inset-x-3 bottom-[calc(var(--sl-bar-h)+env(safe-area-inset-bottom)+0.5rem)] z-[70] max-h-[80dvh] overflow-y-auto"
              : "z-50 max-w-[calc(100vw-1.5rem)] overflow-y-auto"
          }`}
          style={
            viewport.isPhone
              ? undefined
              : {
                  width: YOUTUBE_PRIVACY_POPOVER_WIDTH,
                  top: youtubePrivacyPos.top,
                  right: youtubePrivacyPos.right,
                  // Short landscape screens: scroll inside the popover instead of running off the bottom.
                  maxHeight: `calc(100dvh - ${youtubePrivacyPos.top}px - 0.5rem)`,
                }
          }
        >

          <div className="px-0.5">
            <h3
              id="sl-youtube-privacy-title"
              className="text-[15px] font-semibold leading-tight tracking-[-0.01em] text-[#F8FAFC]"
            >
              Start YouTube Live
            </h3>

            <p className="mt-1 text-xs leading-snug text-[#94A3B8]">
              Choose who can watch your live stream.
            </p>
          </div>

          <div
            role="radiogroup"
            aria-label="Live stream visibility"
            className="mt-3.5 space-y-1.5"
          >
            {(
              [
                { value: "public", label: "Public", description: "Anyone can find and watch this live stream.", Icon: Globe },
                { value: "unlisted", label: "Unlisted", description: "Only people with the link can watch.", Icon: Link2 },
                { value: "private", label: "Private", description: "Only you, the account owner, can view it.", Icon: Lock },
              ] as const
            ).map(({ value, label, description, Icon }) => {
              const selected = youtubePrivacy === value;

              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setYoutubePrivacy(value);
                  }}
                  className={`flex min-h-[52px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left ring-1 ring-inset transition-[background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/80 ${
                    selected
                      ? "bg-[#3B82F6]/[0.12] ring-[#60A5FA]/45"
                      : "bg-white/[0.03] ring-white/[0.07] hover:bg-white/[0.06]"
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
                      selected ? "bg-[#3B82F6]/20 text-[#93C5FD]" : "bg-white/[0.06] text-[#94A3B8]"
                    }`}
                  >
                    <Icon size={14} aria-hidden="true" />
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[13px] font-semibold leading-tight text-[#F8FAFC]">
                        {label}
                      </span>
                      {value === "private" && (
                        <span className="rounded px-1 py-px text-[9px] font-semibold uppercase leading-[1.4] tracking-[0.06em] text-amber-300/90 ring-1 ring-inset ring-amber-400/25">
                          Not recommended
                        </span>
                      )}
                    </span>

                    <span className="mt-0.5 block text-[11px] leading-snug text-[#94A3B8]">
                      {description}
                    </span>
                  </span>

                  {/* Selection indicator: a small radio dot. */}
                  <span
                    aria-hidden="true"
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors ${
                      selected ? "bg-[#3B82F6]" : "ring-1 ring-inset ring-white/25"
                    }`}
                  >
                    {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-4 border-t border-white/[0.08] pt-3">
          <div className="flex items-center justify-end gap-2">

            <button
              type="button"
              onClick={() => {
                setShowYoutubePrivacy(false);
              }}
              className="inline-flex h-8 items-center rounded-[10px] px-3 text-[13px] font-medium text-[#CBD5E1] transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/70"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={async () => {
                setShowYoutubePrivacy(false);

                setIsStartingLive(true);

                try {
                  await handleStartYouTubeLive();
                } catch {
                  // Error already surfaced via toast inside handleStartYouTubeLive.
                } finally {
                  setIsStartingLive(false);
                }
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-gradient-to-b from-[#F25555] to-[#DC2626] px-3.5 text-[13px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(2,6,23,0.35)] transition-[background-color,box-shadow] hover:from-[#F46666] hover:to-[#E23131] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/70"
            >
              <Radio size={14} aria-hidden="true" />
              Start Live
            </button>

          </div>
          </div>

        </div>
        </>
    )}

      {/* Fullscreen: invisible hover strips on the top / right edge. They sit above
          the Jitsi iframe, which would otherwise swallow the pointer events. */}
      {immersive && !headerVisible && (
        <div
          aria-hidden="true"
          onMouseEnter={() => revealEdge("top")}
          className="fixed inset-x-0 top-0 z-30 h-3"
        />
      )}
      {immersive && !sidebarVisible && (
        <div
          aria-hidden="true"
          onMouseEnter={() => revealEdge("right")}
          className="fixed right-0 top-0 z-30 h-full w-3"
        />
      )}

      {/* RIGHT SIDEBAR */}
      {meetingReady && (
        <div
          className={
            immersive
              ? // Slides with `right`, not a transform: a transform would become the
                // containing block of the sidebar's fixed popovers and modals.
                `fixed top-0 z-50 h-screen w-[var(--sl-rail-w)] transition-[right] duration-200 ${
                  sidebarVisible ? "right-0" : "-right-[var(--sl-rail-w)]"
                }`
              : "contents"
          }
          onMouseEnter={immersive ? () => revealEdge("right") : undefined}
          onMouseLeave={immersive ? () => hideEdgeSoon("right") : undefined}
        >
        <RightSidebar
          breakout={breakout}
          breakoutRoomLabels={breakoutRoomLabels}
          onPanelOpenChange={setSidebarPanelOpen}
          sessionId={joinInfo.session.id}
          classId={joinInfo.class.id}
          className={joinInfo.class.name}
          lectureId={joinInfo.lecture?.id ?? null}
          lectureTitle={joinInfo.lecture?.title}
          teacherName={teacherName}
          role={role}
          participants={participants}
          ClassroomStudents={classStudents}
          cameraMonitoring={role === "teacher" ? cameraMonitoring : undefined}
          currentStudentId={role === "student" ? joinInfo.student?.id : undefined}
          // Teacher-only controls: students never get them (Jitsi itself also
          // refuses remote mutes from a non-moderator).
          onMuteEveryone={
            role === "teacher"
              ? () => jitsiMeetingRef.current?.muteEveryone()
              : undefined
          }
          onMuteParticipant={
            role === "teacher"
              ? (participantId, muted) =>
                  jitsiMeetingRef.current?.setParticipantAudioMuted(participantId, muted)
              : undefined
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
        </div>
      )}

      {/* Fullscreen trigger — desktop only: fullscreens JitsiMeeting's own wrapper
          (not document.documentElement) via the real Fullscreen API, so the
          header/right sidebar are hidden by the browser's native fullscreen
          rendering itself. Mobile/touch layouts use MeetingCard's own header
          button instead (isMobile / onEnterFullscreen below), which never calls
          the real API at all — see handleEnterCssFullscreen. The matching "Exit
          fullscreen" button lives inside JitsiMeeting's wrapper and works for
          both paths already. */}
      {meetingReady && !isFullscreenActive && !viewport.isTouchLayout && (
        <button
          type="button"
          onClick={() => void handleEnterFullscreen()}
          aria-label="Enter fullscreen"
          className="fixed bottom-4 left-4 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
        >
          <Maximize2 size={16} />
        </button>
      )}

    </div>

  </main>
);
}