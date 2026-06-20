"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type UserRole = "teacher" | "student";

type JoinInfo = {
  session: {
    id: string;
    classId: string;
    lectureId?: string | null;
    roomName: string;
    jitsiDomain: string;
  };
  lecture?: {
    id: string;
    title: string;
    date: string;
  } | null;
  class: {
    id: string;
    name: string;
    schedule: string;
  };
  student?: {
    id: string;
    name: string;
    grade: string | null;
  };
  token?: string;
};

type JitsiApi = {
  executeCommand: (command: string, ...args: unknown[]) => void;
  addListener: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  getParticipantsInfo: () => Array<{ participantId: string; displayName: string }>;
  dispose: () => void;
};

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options: {
        roomName: string;
        parentNode: HTMLElement;
        jwt?: string;
        userInfo?: { displayName?: string };
        configOverwrite?: Record<string, unknown>;
        interfaceConfigOverwrite?: Record<string, unknown>;
      }
    ) => JitsiApi;
  }
}

export function JitsiClassroom() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId") ?? "";
  const studentId = searchParams.get("studentId") ?? "";
  const inviteToken = searchParams.get("invite") ?? "";
  const roleParam = searchParams.get("role");
  const role: UserRole = roleParam === "teacher" ? "teacher" : "student";
  const teacherName = searchParams.get("teacherName") ?? "Teacher";

  const meetingShellRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<JitsiApi | null>(null);
  const teacherParticipantIdRef = useRef<string | null>(null);

  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [isJitsiReady, setIsJitsiReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasSessionEnded, setHasSessionEnded] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  // const [isEndingSession, setIsEndingSession] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // const [restartedSessionId, setRestartedSessionId] = useState<string | null>(null);
  const [teacherFlowStage, setTeacherFlowStage] = useState<"active" | "ended-await-restart" | "restarted-await-notify">("active");

  const dashboardHref = role === "teacher" ? "/dashboard/sessions" : "/student/dashboard";

  function handleToggleFullscreen() {
    const shell = meetingShellRef.current;

    if (!shell) {
      return;
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {
        // Ignore browser-level fullscreen errors.
      });
      return;
    }

    void shell.requestFullscreen().catch(() => {
      // Some browsers require additional user gesture context.
    });
  }



  // async function handleTeacherEndSession() {
  //   if (!joinInfo || role !== "teacher") {
  //     return;
  //   }

  //   const confirmed = window.confirm("End this live session now?");

  //   if (!confirmed) {
  //     return;
  //   }

  //   setIsEndingSession(true);
  //   setErrorMessage(null);

  //   try {
  //     const response = await fetch(`/api/sessions/${joinInfo.session.id}/end`, {
  //       method: "POST",
  //     });

  //     const payload = (await response.json()) as {
  //       success: boolean;
  //       error?: {
  //         message?: string;
  //       };
  //     };

  //     if (!response.ok || !payload.success) {
  //       throw new Error(payload.error?.message ?? "Failed to end session.");
  //     }

  //     apiRef.current?.dispose();
  //     apiRef.current = null;
  //     setIsTeacherControlsReady(false);
  //     setHasSessionEnded(true);
  //     setIsJitsiReady(false);
  //     setTeacherFlowStage("ended-await-restart");
  //   } catch (error) {
  //     setErrorMessage(error instanceof Error ? error.message : "Unable to end session right now.");
  //   } finally {
  //     setIsEndingSession(false);
  //   }
  // }

  async function handleTeacherRestartSession() {
    if (!joinInfo || role !== "teacher") {
      return;
    }

    const confirmed = window.confirm("Restart this session now?");

    if (!confirmed) {
      return;
    }

    setIsRestarting(true);
    setErrorMessage(null);

    try {
      const restartResponse = await fetch(`/api/sessions/${joinInfo.session.id}/restart`, {
        method: "POST",
      });

      const restartPayload = (await restartResponse.json()) as {
        success: boolean;
        data?: {
          session: {
            id: string;
          };
        };
        error?: {
          message?: string;
        };
      };

      if (!restartResponse.ok || !restartPayload.success || !restartPayload.data) {
        throw new Error(restartPayload.error?.message ?? "Failed to restart session.");
      }

      apiRef.current?.dispose();
      apiRef.current = null;
      // setIsTeacherControlsReady(false);
      // setRestartedSessionId(restartPayload.data.session.id);
      setTeacherFlowStage("restarted-await-notify");
      setHasSessionEnded(false);
      router.push(`/session/join?sessionId=${restartPayload.data.session.id}&role=teacher`);
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to restart session right now.");
    } finally {
      setIsRestarting(false);
    }
  }

  // async function handleNotifyAfterRestart() {
  //   if (role !== "teacher") {
  //     return;
  //   }

  //   const targetSessionId = restartedSessionId ?? joinInfo?.session.id;

  //   if (!targetSessionId) {
  //     setErrorMessage("No restarted session is available for notifications.");
  //     return;
  //   }

  //   if (!restartNotifyOptions.email && !restartNotifyOptions.whatsapp) {
  //     setErrorMessage("At least one notify channel must be selected.");
  //     return;
  //   }

  //   setIsNotifyingRestart(true);
  //   setErrorMessage(null);

  //   try {
  //     const response = await fetch(`/api/sessions/${targetSessionId}/notify`, {
  //       method: "POST",
  //       headers: {
  //         "Content-Type": "application/json",
  //       },
  //       body: JSON.stringify({
  //         email: restartNotifyOptions.email,
  //         whatsapp: restartNotifyOptions.whatsapp,
  //         notificationType: "restarted",
  //       }),
  //     });

  //     const payload = (await response.json()) as {
  //       success: boolean;
  //       error?: {
  //         message?: string;
  //       };
  //     };

  //     if (!response.ok || !payload.success) {
  //       throw new Error(payload.error?.message ?? "Failed to notify students.");
  //     }

  //     setTeacherFlowStage("active");
  //     setRestartedSessionId(null);
  //   } catch (error) {
  //     setErrorMessage(error instanceof Error ? error.message : "Unable to notify students right now.");
  //   } finally {
  //     setIsNotifyingRestart(false);
  //   }
  // }

  const canJoin = useMemo(() => {
    if (inviteToken.length > 0) return true;
    if (sessionId.length === 0) return false;
    if (role === "teacher") return true;
    return studentId.length > 0;
  }, [inviteToken, role, sessionId, studentId]);

  useEffect(() => {
    let cancelled = false;

    async function loadJoinInfo() {
      if (!canJoin) {
        setErrorMessage(
          role === "teacher"
            ? "Missing session identifier in link."
            : "Missing session or student identifier in link."
        );
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setErrorMessage(null);

      try {
        let response: Response;

        if (inviteToken) {
          const inviteQuery = new URLSearchParams();
          inviteQuery.set("invite", inviteToken);
          response = await fetch(`/api/sessions/join-info?${inviteQuery.toString()}`);
        } else {
          const query = new URLSearchParams();
          query.set("role", role);
          if (studentId) query.set("studentId", studentId);
          response = await fetch(`/api/sessions/${sessionId}/join-info?${query.toString()}`);
        }

        const payload = (await response.json()) as {
          success: boolean;
          data?: JoinInfo;
          error?: { message?: string };
        };

        if (!response.ok || !payload.success || !payload.data) {
          throw new Error(payload.error?.message ?? "Unable to load class session info.");
        }

        if (!cancelled) {
          setHasSessionEnded(false);
          if (role === "teacher" && teacherFlowStage === "ended-await-restart") {
            setTeacherFlowStage("active");
          }
          setJoinInfo(payload.data);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : "Unable to load class session info.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadJoinInfo();

    return () => {
      cancelled = true;
    };
  }, [canJoin, inviteToken, role, sessionId, studentId, teacherFlowStage]);

  useEffect(() => {
    if (!joinInfo || hasSessionEnded) {
      return;
    }

    let isCancelled = false;

    const checkSessionStatus = async () => {
      try {
        let response: Response;

        if (inviteToken) {
          const inviteQuery = new URLSearchParams();
          inviteQuery.set("invite", inviteToken);
          response = await fetch(`/api/sessions/join-info?${inviteQuery.toString()}`, {
            cache: "no-store",
          });
        } else {
          const query = new URLSearchParams();
          query.set("role", role);
          if (studentId) {
            query.set("studentId", studentId);
          }

          response = await fetch(`/api/sessions/${joinInfo.session.id}/join-info?${query.toString()}`, {
            cache: "no-store",
          });
        }

        const payload = (await response.json()) as {
          success: boolean;
          error?: {
            code?: string;
          };
        };

        if (!response.ok && payload.error?.code === "SESSION_NOT_ACTIVE" && !isCancelled) {
          apiRef.current?.dispose();
          apiRef.current = null;
          setHasSessionEnded(true);
          setIsJitsiReady(false);
          setErrorMessage(null);
          if (role === "teacher") {
            setTeacherFlowStage("ended-await-restart");
          }
        }
      } catch {
        // Ignore transient polling failures. The next poll will re-check session state.
      }
    };

    const intervalId = setInterval(() => {
      void checkSessionStatus();
    }, 5_000);

    return () => {
      isCancelled = true;
      clearInterval(intervalId);
    };
  }, [hasSessionEnded, inviteToken, joinInfo, role, studentId]);

  useEffect(() => {
    if (!joinInfo) {
      return;
    }

    setIsJitsiReady(false);

    const script = document.createElement("script");
    script.src = `https://${joinInfo.session.jitsiDomain}/external_api.js`;
    script.async = true;
    script.onload = () => {
      setIsJitsiReady(true);
    };
    script.onerror = () => {
      setErrorMessage("Unable to load Jitsi script. Please check network access.");
    };
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
      setIsJitsiReady(false);
    };
  }, [joinInfo]);

  useEffect(() => {
    if (!joinInfo || hasSessionEnded || !containerRef.current || !isJitsiReady || !window.JitsiMeetExternalAPI) {
      return;
    }

    const toolbarButtonsForRole =
      role === "teacher"
        ? [
             // Most important classroom actions
            "microphone",
            "camera",
            "desktop",
            "chat",
            "participants-pane",
            "raisehand",
            "hangup",

            // Frequently used secondary actions
            "fullscreen",
            "tileview",
            "filmstrip",
            "settings",
            "videoquality",
            "select-background",
            "videobackgroundblur",
            "noisesuppression",

            // Teacher / moderation features
            "mute-everyone",
            "security",
            "whiteboard",
            "breakoutrooms",
            "recording",
            "livestreaming",

            // Collaboration tools
            "sharedvideo",
            "etherpad",
            "invite",
            "calendar",

            // Accessibility & profile
            "closedcaptions",
            "profile",
            "feedback",
            "help",

            // Advanced / less-used utilities
            "speakerstats",
            "stats",
            "shortcuts",
            "download",
            "embedmeeting",
            "fodeviceselection",
            "toggle-camera",
          ]
        : [
            "microphone",
            "camera",
            "chat",
            "raisehand",
            "participants-pane",
            "tileview",
            "fullscreen",
            "settings",
            "videoquality",
            "shortcuts",
            "hangup",
          ];

    const api = new window.JitsiMeetExternalAPI(joinInfo.session.jitsiDomain, {
      roomName: joinInfo.session.roomName,
      parentNode: containerRef.current,
      userInfo: {
        displayName: role === "teacher" ? teacherName : (joinInfo.student?.name ?? "Student"),
      },
      ...(joinInfo.token && { jwt: joinInfo.token }),
      configOverwrite: {
        prejoinPageEnabled: false,
        prejoinConfig: {
          enabled: false,
        },
        startWithAudioMuted: true,
        startWithVideoMuted: true,
        resolution: 360,
        constraints: {
          video: {
            height: {
              ideal: 360,
              max: 360,
              min: 180,
            },
          },
        },
        disableSimulcast: true,
        disableTileView: true,
        channelLastN: 1,
        enableWelcomePage: false,
        enableNoAudioDetection: false,
        enableNoisyMicDetection: false,
        p2p: {
          enabled: true,
        },
      },
      interfaceConfigOverwrite: {
        TOOLBAR_BUTTONS: toolbarButtonsForRole,
        DISABLE_TILE_VIEW: true,
        SHOW_JITSI_WATERMARK: false,
        SHOW_WATERMARK_FOR_GUESTS: false,
        SHOW_BRAND_WATERMARK: false,
        BRAND_WATERMARK_LINK: "",
        MOBILE_APP_PROMO: false,
        DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
      },
    });

    apiRef.current = api;
    // setIsTeacherControlsReady(role === "teacher");

    const markJoined = async () => {
      if (role !== "student" || !joinInfo.student?.id) return;
      await fetch(`/api/attendance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: joinInfo.session.id,
          classId: joinInfo.class.id,
          studentId: joinInfo.student.id,
        }),
      });
    };

    const markLeft = async () => {
      if (role !== "student" || !joinInfo.student?.id) return;
      await fetch(`/api/sessions/${joinInfo.session.id}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: joinInfo.student.id }),
      });
    };

    const handleJoined = () => {
      void markJoined();

      if (role === "student") {
        api.executeCommand("toggleAudio");
        api.executeCommand("toggleVideo");
        api.executeCommand("setTileView", false);
        api.executeCommand("setFilmStripVisibility", true);

        try {
          const participants = api.getParticipantsInfo();
          const teacherParticipant = participants.find((p) => p.displayName === teacherName);
          if (teacherParticipant?.participantId) {
            teacherParticipantIdRef.current = teacherParticipant.participantId;
            api.executeCommand("setLargeVideoParticipant", teacherParticipant.participantId);
          }
        } catch {
          // getParticipantsInfo may not be available in all Jitsi builds.
        }
      }
    };

    const handleLeftConference = () => {
      void markLeft();
    };

    const handleParticipantJoined = (participant: unknown) => {
      const candidate = participant as { id?: string; displayName?: string };
      if (!candidate?.id) return;

      if (candidate.displayName === teacherName) {
        teacherParticipantIdRef.current = candidate.id;
        if (role === "student") {
          api.executeCommand("setLargeVideoParticipant", candidate.id);
        }
      }
    };

    const handleScreenSharingChanged = (event: unknown) => {
      if (role !== "student") return;
      const e = event as { on?: boolean; id?: string };
      if (e.on && e.id) {
        api.executeCommand("setLargeVideoParticipant", e.id);
      } else if (!e.on && teacherParticipantIdRef.current) {
        api.executeCommand("setLargeVideoParticipant", teacherParticipantIdRef.current);
      }
    };

    api.addListener("videoConferenceJoined", handleJoined);
    api.addListener("videoConferenceLeft", handleLeftConference);
    api.addListener("participantJoined", handleParticipantJoined);
    api.addListener("screenSharingStatusChanged", handleScreenSharingChanged);

    const handleBeforeUnload = () => {
      void markLeft();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      api.removeListener("videoConferenceJoined", handleJoined);
      api.removeListener("videoConferenceLeft", handleLeftConference);
      api.removeListener("participantJoined", handleParticipantJoined);
      api.removeListener("screenSharingStatusChanged", handleScreenSharingChanged);
      api.dispose();
      apiRef.current = null;
      // setIsTeacherControlsReady(false);
      void markLeft();
    };
  }, [hasSessionEnded, joinInfo, isJitsiReady, role, teacherName]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const shell = meetingShellRef.current;
      setIsFullscreen(Boolean(shell && document.fullscreenElement === shell));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
      {isLoading ? <p className="text-sm text-muted">Loading session details...</p> : null}

      {errorMessage ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
      ) : null}

      {hasSessionEnded ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          <p className="font-semibold">Session ended</p>
          <p className="mt-1">This live session has ended. Return to your dashboard to continue.</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {role === "teacher" ? (
              <button
                type="button"
                onClick={() => void handleTeacherRestartSession()}
                disabled={teacherFlowStage !== "ended-await-restart" || isRestarting }
                className="inline-flex items-center justify-center rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRestarting ? "Restarting..." : "Restart session"}
              </button>
            ) : null}

            <Link
              href={dashboardHref}
              className="inline-flex items-center justify-center rounded-xl border border-black/20 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-black/5"
            >
              Go to dashboard
            </Link>
          </div>
        </div>
      ) : null}

      <section
        ref={meetingShellRef}
        className={`relative mt-4 overflow-hidden rounded-3xl border border-black/10 bg-black shadow-sm dark:border-white/10 ${hasSessionEnded ? "hidden" : ""}`}
      >
        <div className="pointer-events-none absolute right-3 top-3 z-20">
          <button
            type="button"
            onClick={handleToggleFullscreen}
            disabled={hasSessionEnded || isLoading}
            className="pointer-events-auto rounded-lg border border-white/25 bg-black/60 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur hover:bg-black/75 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
        </div>

        {role === "teacher" && joinInfo ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-black/85 px-4 py-3 text-white sm:px-6">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-white/70">Class Title</p>
              <p className="text-base font-semibold sm:text-lg">{joinInfo.class.name}</p>
              <p className="text-xs text-white/70 sm:text-sm">
                Lecture: {joinInfo.lecture?.title ?? "No lecture title"}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold">{teacherName}</span>
              <span className="rounded-full border border-red-300/30 bg-red-500/20 px-3 py-1 text-xs font-semibold text-red-100">LIVE</span>
            </div>
          </div>
        ) : null}

        <div
          ref={containerRef}
          className="h-[65vh] w-full min-h-[420px] sm:h-[72vh]"
        />
      </section>
    </main>
  );
}
