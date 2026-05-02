"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LiveSessionControlBar } from "@/components/live-session-control-bar";

type UserRole = "teacher" | "student";

type JoinInfo = {
  session: {
    id: string;
    roomName: string;
    jitsiDomain: string;
  };
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

type BroadcastMessage = {
  id: string;
  text: string;
  sender: string;
  sentAt: string;
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
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
      dispose: () => void;
    };
  }
}

export function JitsiClassroom() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId") ?? "";
  const studentId = searchParams.get("studentId") ?? "";
  const teacherId = searchParams.get("teacherId") ?? "";
  const roleParam = searchParams.get("role");
  const role: UserRole = roleParam === "teacher" ? "teacher" : "student";
  const teacherName = searchParams.get("teacherName") ?? "Teacher";

  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{
    executeCommand: (command: string, ...args: unknown[]) => void;
    addListener: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    dispose: () => void;
  } | null>(null);
  const participantIdsRef = useRef<Set<string>>(new Set());

  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [isJitsiReady, setIsJitsiReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [participantsCount, setParticipantsCount] = useState(0);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isFilmStripOpen, setIsFilmStripOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [broadcastInput, setBroadcastInput] = useState("");
  const [broadcastMessages, setBroadcastMessages] = useState<BroadcastMessage[]>([]);
  const [successHint, setSuccessHint] = useState<string | null>(null);

  const canJoin = useMemo(() => {
    if (sessionId.length === 0) {
      return false;
    }

    if (role === "teacher") {
      return true;
    }

    return studentId.length > 0;
  }, [role, sessionId, studentId]);

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
        const query = new URLSearchParams();
        query.set("role", role);
        if (studentId) {
          query.set("studentId", studentId);
        }
        if (teacherId) {
          query.set("teacherId", teacherId);
        }

        const response = await fetch(`/api/sessions/${sessionId}/join-info?${query.toString()}`);
        const payload = (await response.json()) as {
          success: boolean;
          data?: JoinInfo;
          error?: { message?: string };
        };

        if (!response.ok || !payload.success || !payload.data) {
          throw new Error(payload.error?.message ?? "Unable to load class session info.");
        }

        if (!cancelled) {
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
  }, [canJoin, role, sessionId, studentId, teacherId]);

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

  const postLeaveEvent = useCallback(async () => {
    if (!joinInfo) {
      return;
    }

    try {
      if (role === "student" && joinInfo.student?.id) {
        await fetch(`/api/sessions/${joinInfo.session.id}/leave`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            studentId: joinInfo.student.id,
          }),
        });
      }
    } catch {
      // Ignore best-effort leave tracking errors.
    }
  }, [joinInfo, role]);

  const postJoinAttendance = useCallback(async () => {
    if (!joinInfo || role !== "student" || !joinInfo.student?.id) {
      return;
    }

    try {
      await fetch(`/api/attendance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: joinInfo.session.id,
          classId: joinInfo.class.id,
          studentId: joinInfo.student.id,
        }),
      });
    } catch {
      // Ignore best-effort attendance tracking errors.
    }
  }, [joinInfo, role]);

  const postClassEnded = useCallback(async () => {
    if (!joinInfo || role !== "teacher") {
      return;
    }

    try {
      await fetch(`/api/sessions/${joinInfo.session.id}/end`, {
        method: "POST",
      });
    } catch {
      // Keep UI responsive even if API endpoint is unavailable.
    }
  }, [joinInfo, role]);

  useEffect(() => {
    if (!joinInfo || !containerRef.current || !isJitsiReady || !window.JitsiMeetExternalAPI) {
      return;
    }

    participantIdsRef.current = new Set();
    setParticipantsCount(0);

    const api = new window.JitsiMeetExternalAPI(joinInfo.session.jitsiDomain, {
      roomName: joinInfo.session.roomName,
      parentNode: containerRef.current,
      userInfo: {
        displayName: role === "teacher" ? teacherName : joinInfo.student?.name,
      },
      configOverwrite: {
        prejoinPageEnabled: false,
      },
    });

    apiRef.current = api;

    const handleJoined = () => {
      setIsLive(true);
      setParticipantsCount(1);
      void postJoinAttendance();
    };

    const handleLeftConference = () => {
      setIsLive(false);
      participantIdsRef.current.clear();
      setParticipantsCount(0);
      void postLeaveEvent();
    };

    const handleParticipantJoined = (participant: unknown) => {
      const candidate = participant as { id?: string };
      if (candidate?.id) {
        participantIdsRef.current.add(candidate.id);
        setParticipantsCount(participantIdsRef.current.size + 1);
      }
    };

    const handleParticipantLeft = (participant: unknown) => {
      const candidate = participant as { id?: string };
      if (candidate?.id) {
        participantIdsRef.current.delete(candidate.id);
      }
      setParticipantsCount(participantIdsRef.current.size + 1);
    };

    api.addListener("videoConferenceJoined", handleJoined);
    api.addListener("videoConferenceLeft", handleLeftConference);
    api.addListener("participantJoined", handleParticipantJoined);
    api.addListener("participantLeft", handleParticipantLeft);

    const handleBeforeUnload = () => {
      void postLeaveEvent();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      api.removeListener?.("videoConferenceJoined", handleJoined);
      api.removeListener?.("videoConferenceLeft", handleLeftConference);
      api.removeListener?.("participantJoined", handleParticipantJoined);
      api.removeListener?.("participantLeft", handleParticipantLeft);
      api.dispose();
      apiRef.current = null;
      void postLeaveEvent();
      setIsLive(false);
      setParticipantsCount(0);
    };
  }, [isJitsiReady, joinInfo, postJoinAttendance, postLeaveEvent, role, teacherName]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  function executeJitsiCommand(command: string, ...args: unknown[]) {
    if (!apiRef.current) {
      setErrorMessage("Meeting controls are not ready yet.");
      return;
    }

    try {
      apiRef.current.executeCommand(command, ...args);
    } catch {
      setErrorMessage(`Unable to execute command: ${command}`);
    }
  }

  function handleStartClass() {
    setIsLive(true);
    setSuccessHint("Class started. Students can now actively join.");
  }

  async function handleEndClass() {
    try {
      setIsBusy(true);
      executeJitsiCommand("hangup");
      await postClassEnded();
      setIsLive(false);
      setParticipantsCount(0);
      setSuccessHint("Class ended successfully.");

      if (role === "teacher") {
        router.replace("/dashboard/sessions");
      } else {
        router.replace("/");
      }
    } finally {
      setIsBusy(false);
    }
  }

  function handleMuteAllStudents() {
    executeJitsiCommand("muteEveryone");
    setSuccessHint("Mute all command sent.");
  }

  function handleToggleAudio() {
    executeJitsiCommand("toggleAudio");
    setIsAudioMuted((prev) => !prev);
  }

  function handleToggleVideo() {
    executeJitsiCommand("toggleVideo");
    setIsVideoMuted((prev) => !prev);
  }

  function handleToggleChat() {
    executeJitsiCommand("toggleChat");
    setIsChatOpen((prev) => !prev);
  }

  function handleToggleFilmStrip() {
    executeJitsiCommand("toggleFilmStrip");
    setIsFilmStripOpen((prev) => !prev);
  }

  async function handleToggleFullscreen() {
    if (!containerRef.current) {
      return;
    }

    if (!document.fullscreenElement) {
      await containerRef.current.requestFullscreen();
      return;
    }

    await document.exitFullscreen();
  }

  function handleSendBroadcast() {
    const trimmedMessage = broadcastInput.trim();
    if (!trimmedMessage || role !== "teacher" || !isLive) {
      return;
    }

    executeJitsiCommand("sendChatMessage", trimmedMessage);
    setBroadcastMessages((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text: trimmedMessage,
        sender: teacherName,
        sentAt: new Date().toISOString(),
      },
      ...prev,
    ]);
    setBroadcastInput("");
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-black/10 bg-card p-4 shadow-sm dark:border-white/10 sm:p-6">
        <h1 className="text-xl font-semibold sm:text-2xl">Classroom session</h1>

        {isLoading ? <p className="mt-2 text-sm text-muted">Loading session details...</p> : null}

        {errorMessage ? (
          <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
        ) : null}

        {successHint ? (
          <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{successHint}</p>
        ) : null}

        {joinInfo ? (
          <div className="mt-3 text-sm text-muted">
            <p>Class: {joinInfo.class.name}</p>
            <p>Schedule: {joinInfo.class.schedule}</p>
            {role === "student" && joinInfo.student ? <p>Student: {joinInfo.student.name}</p> : null}
            {role === "teacher" ? <p>Teacher: {teacherName}</p> : null}
          </div>
        ) : null}
      </section>

      <section className="mt-4 space-y-3">
        <LiveSessionControlBar
          role={role}
          isLive={isLive}
          participantsCount={participantsCount}
          isAudioMuted={isAudioMuted}
          isVideoMuted={isVideoMuted}
          isChatOpen={isChatOpen}
          isFilmStripOpen={isFilmStripOpen}
          isFullscreen={isFullscreen}
          isBusy={isBusy}
          onStartClass={handleStartClass}
          onEndClass={() => void handleEndClass()}
          onMuteAllStudents={handleMuteAllStudents}
          onToggleAudio={handleToggleAudio}
          onToggleVideo={handleToggleVideo}
          onToggleChat={handleToggleChat}
          onToggleFilmStrip={handleToggleFilmStrip}
          onToggleFullscreen={() => void handleToggleFullscreen()}
        />

        {role === "teacher" ? (
          <div className="rounded-2xl border border-black/10 bg-card p-3 shadow-sm transition dark:border-white/10">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Broadcast message</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                value={broadcastInput}
                onChange={(event) => setBroadcastInput(event.target.value)}
                placeholder="Send a quick class update to all students..."
                className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:ring-2 focus:ring-black/10 dark:border-white/20 dark:bg-transparent dark:focus:ring-white/10"
              />
              <button
                type="button"
                onClick={handleSendBroadcast}
                disabled={!isLive || broadcastInput.trim().length === 0}
                className="rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
              >
                Send
              </button>
            </div>

            {broadcastMessages.length > 0 ? (
              <div className="mt-3 max-h-36 space-y-2 overflow-auto pr-1">
                {broadcastMessages.map((message) => (
                  <div key={message.id} className="rounded-xl border border-black/10 px-3 py-2 text-sm dark:border-white/10">
                    <p className="font-medium">{message.text}</p>
                    <p className="mt-1 text-xs text-muted">
                      {message.sender} • {new Date(message.sentAt).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="mt-3 overflow-hidden rounded-3xl border border-black/10 bg-black shadow-sm transition-all dark:border-white/10">
        <div
          ref={containerRef}
          className="h-[65vh] w-full min-h-[420px] sm:h-[72vh]"
        />
      </section>
    </main>
  );
}
