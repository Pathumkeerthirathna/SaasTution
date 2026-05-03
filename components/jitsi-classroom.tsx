"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

// Real security must be handled on backend (JWT/session). This is a basic client-side guard only.
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
  }, [canJoin, inviteToken, role, sessionId, studentId]);

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
    if (!joinInfo || !containerRef.current || !isJitsiReady || !window.JitsiMeetExternalAPI) {
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
        try {
          void containerRef.current?.requestFullscreen();
        } catch {
          // Browser may block fullscreen — ignore silently.
        }
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
  }, [joinInfo, isJitsiReady, role, teacherName]);

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
            <p>Schedule: {joinInfo.class.schedule}</p>
            {role === "student" && joinInfo.student ? <p>Student: {joinInfo.student.name}</p> : null}
            {role === "teacher" ? <p>Teacher: {teacherName}</p> : null}
          </div>
        ) : null}
      </section>

      <section className="mt-4 overflow-hidden rounded-3xl border border-black/10 bg-black shadow-sm dark:border-white/10">
        <div
          ref={containerRef}
          className="h-[65vh] w-full min-h-[420px] sm:h-[72vh]"
        />
      </section>
    </main>
  );
}
