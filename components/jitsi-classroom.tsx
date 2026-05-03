"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Real security must be handled on backend (JWT/session). This is a basic client-side guard only.
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
};

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options: {
        roomName: string;
        parentNode: HTMLElement;
        userInfo?: { displayName?: string };
        configOverwrite?: Record<string, unknown>;
        interfaceConfigOverwrite?: Record<string, unknown>;
      }
    ) => {
      executeCommand: (command: string, ...args: unknown[]) => void;
      addListener: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
      getParticipantsInfo: () => Array<{ participantId: string; displayName: string }>;
      dispose: () => void;
    };
  }
}

export function JitsiClassroom() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId") ?? "";
  const studentId = searchParams.get("studentId") ?? "";
  const inviteToken = searchParams.get("invite") ?? "";
  const roleParam = searchParams.get("role");
  // Real security must be handled on backend (JWT/session). This is a basic client-side guard only.
  const role: UserRole = roleParam === "teacher" ? "teacher" : "student";
  const teacherName = searchParams.get("teacherName") ?? "Teacher";

  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{
    executeCommand: (command: string, ...args: unknown[]) => void;
    addListener: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
    getParticipantsInfo: () => Array<{ participantId: string; displayName: string }>;
    dispose: () => void;
  } | null>(null);
  const teacherParticipantIdRef = useRef<string | null>(null);
  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [isJitsiReady, setIsJitsiReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasSessionEnded, setHasSessionEnded] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);
  const [isLeavingSession, setIsLeavingSession] = useState(false);
  const [isNotifyingRestart, setIsNotifyingRestart] = useState(false);
  const [restartedSessionId, setRestartedSessionId] = useState<string | null>(null);
  const [teacherFlowStage, setTeacherFlowStage] = useState<"active" | "ended-await-restart" | "restarted-await-notify">("active");
  const [restartNotifyOptions, setRestartNotifyOptions] = useState({
    email: true,
    whatsapp: false,
  });

  const dashboardHref = role === "teacher" ? "/dashboard/sessions" : "/student/dashboard";

  async function handleStudentLeave() {
    if (!joinInfo?.student?.id) {
      return;
    }

    const confirmed = window.confirm("Leave this live session and return to dashboard?");

    if (!confirmed) {
      return;
    }

    setIsLeavingSession(true);

    try {
      await fetch(`/api/sessions/${joinInfo.session.id}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: joinInfo.student.id,
        }),
      });
    } catch {
      // Ignore leave tracking failures and continue navigation to avoid trapping students.
    } finally {
      apiRef.current?.dispose();
      apiRef.current = null;
      router.push("/student/dashboard");
    }
  }

  async function handleTeacherEndSession() {
    if (!joinInfo || role !== "teacher") {
      return;
    }

    const confirmed = window.confirm("End this live session now?");

    if (!confirmed) {
      return;
    }

    setIsEndingSession(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/sessions/${joinInfo.session.id}/end`, {
        method: "POST",
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: {
          message?: string;
        };
      };

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "Failed to end session.");
      }

      apiRef.current?.dispose();
      apiRef.current = null;
      setHasSessionEnded(true);
      setIsJitsiReady(false);
      setTeacherFlowStage("ended-await-restart");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to end session right now.");
    } finally {
      setIsEndingSession(false);
    }
  }

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
      setRestartedSessionId(restartPayload.data.session.id);
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

  async function handleNotifyAfterRestart() {
    if (role !== "teacher") {
      return;
    }

    const targetSessionId = restartedSessionId ?? joinInfo?.session.id;

    if (!targetSessionId) {
      setErrorMessage("No restarted session is available for notifications.");
      return;
    }

    if (!restartNotifyOptions.email && !restartNotifyOptions.whatsapp) {
      setErrorMessage("At least one notify channel must be selected.");
      return;
    }

    setIsNotifyingRestart(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/sessions/${targetSessionId}/notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: restartNotifyOptions.email,
          whatsapp: restartNotifyOptions.whatsapp,
          notificationType: "restarted",
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: {
          message?: string;
        };
      };

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "Failed to notify students.");
      }

      setTeacherFlowStage("active");
      setRestartedSessionId(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to notify students right now.");
    } finally {
      setIsNotifyingRestart(false);
    }
  }

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

    const api = new window.JitsiMeetExternalAPI(joinInfo.session.jitsiDomain, {
      roomName: joinInfo.session.roomName,
      parentNode: containerRef.current,
      userInfo: {
        displayName: role === "teacher" ? teacherName : (joinInfo.student?.name ?? "Student"),
      },
      configOverwrite: {
        prejoinPageEnabled: false,
        disableTileView: true,
      },
      interfaceConfigOverwrite: {
        DISABLE_TILE_VIEW: true,
      },
    });

    apiRef.current = api;

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

      if (role === "teacher") {
        // Auto-fullscreen for teacher only. Students must never auto-enter fullscreen.
        const fullscreenRequest = containerRef.current?.requestFullscreen();
        void fullscreenRequest?.catch(() => {
          // Browser may block fullscreen without a user gesture — ignore silently.
        });
      }

      if (role === "student") {
        // Auto-mute on join only. Students can unmute themselves afterwards.
        api.executeCommand("toggleAudio");
        api.executeCommand("toggleVideo");
        // Enforce tile view off + filmstrip visible.
        api.executeCommand("setTileView", false);
        api.executeCommand("setFilmStripVisibility", true);

        // Detect teacher already present in the room via getParticipantsInfo.
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

      // Track teacher participant by display name — never use local or database IDs.
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
        // Screen share started — focus on the sharer.
        api.executeCommand("setLargeVideoParticipant", e.id);
      } else if (!e.on && teacherParticipantIdRef.current) {
        // Screen share ended — restore teacher as dominant view.
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
      void markLeft();
    };
  }, [hasSessionEnded, joinInfo, isJitsiReady, role, teacherName]);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-black/10 bg-card p-4 shadow-sm dark:border-white/10 sm:p-6">
        <h1 className="text-xl font-semibold sm:text-2xl">Classroom session</h1>

        {isLoading ? <p className="mt-2 text-sm text-muted">Loading session details...</p> : null}

        {errorMessage ? (
          <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
        ) : null}

        {joinInfo ? (
          <div className="mt-3 text-sm text-muted">
            <p>Class: {joinInfo.class.name}</p>
            {joinInfo.lecture ? <p>Lecture: {joinInfo.lecture.title}</p> : null}
            <p>Schedule: {joinInfo.class.schedule}</p>
            {role === "student" && joinInfo.student ? <p>Student: {joinInfo.student.name}</p> : null}
            {role === "teacher" ? <p>Teacher: {teacherName}</p> : null}
          </div>
        ) : null}

        {joinInfo && !hasSessionEnded ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {role === "teacher" ? (
              <>
                {teacherFlowStage === "active" ? (
                  <button
                    type="button"
                    onClick={() => void handleTeacherEndSession()}
                    disabled={isEndingSession || isRestarting || isNotifyingRestart}
                    className="rounded-xl border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isEndingSession ? "Ending..." : "End session"}
                  </button>
                ) : null}

                {teacherFlowStage === "ended-await-restart" ? (
                  <button
                    type="button"
                    onClick={() => void handleTeacherRestartSession()}
                    disabled={isRestarting || isEndingSession || isNotifyingRestart}
                    className="rounded-xl bg-foreground px-3 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isRestarting ? "Restarting..." : "Restart session"}
                  </button>
                ) : null}

                {teacherFlowStage === "restarted-await-notify" ? (
                  <>
                    <div className="inline-flex items-center gap-3 rounded-xl border border-black/10 px-3 py-2 text-xs dark:border-white/10">
                      <span className="font-semibold text-muted">Notify:</span>
                      <label className="inline-flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={restartNotifyOptions.email}
                          onChange={(event) =>
                            setRestartNotifyOptions((prev) => ({
                              ...prev,
                              email: event.target.checked,
                            }))
                          }
                        />
                        Email
                      </label>
                      <label className="inline-flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={restartNotifyOptions.whatsapp}
                          onChange={(event) =>
                            setRestartNotifyOptions((prev) => ({
                              ...prev,
                              whatsapp: event.target.checked,
                            }))
                          }
                        />
                        WhatsApp
                      </label>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleNotifyAfterRestart()}
                      disabled={isNotifyingRestart || isRestarting || isEndingSession}
                      className="rounded-xl bg-foreground px-3 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isNotifyingRestart ? "Notifying..." : "Notify students"}
                    </button>
                  </>
                ) : null}
              </>
            ) : null}

            {role === "student" ? (
              <button
                type="button"
                onClick={() => void handleStudentLeave()}
                disabled={isLeavingSession}
                className="rounded-xl border border-black/15 px-3 py-2 text-sm font-semibold dark:border-white/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLeavingSession ? "Leaving..." : "Leave session"}
              </button>
            ) : null}
          </div>
        ) : null}

        {hasSessionEnded ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
            <p className="font-semibold">Session ended</p>
            <p className="mt-1">This live session has ended. Return to your dashboard to continue.</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {role === "teacher" ? (
                <button
                  type="button"
                  onClick={() => void handleTeacherRestartSession()}
                  disabled={teacherFlowStage !== "ended-await-restart" || isRestarting || isEndingSession}
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
      </section>

      <section className={`mt-4 overflow-hidden rounded-3xl border border-black/10 bg-black shadow-sm dark:border-white/10 ${hasSessionEnded ? "hidden" : ""}`}>
        <div
          ref={containerRef}
          className="h-[65vh] w-full min-h-[420px] sm:h-[72vh]"
        />
      </section>
    </main>
  );
}
