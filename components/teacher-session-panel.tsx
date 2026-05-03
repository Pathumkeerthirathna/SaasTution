"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const FALLBACK_REFRESH_INTERVAL_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const OPTION_PAGE_SIZE = 50;
const ATTENDANCE_PAGE_SIZE = 50;

type RealtimeStatus = "idle" | "connecting" | "connected" | "disconnected";

type ClassItem = {
  id: string;
  name: string;
  schedule: string;
};

type StudentItem = {
  id: string;
  name: string;
  grade: string | null;
  contact: string;
};

type AttendanceRecord = {
  id: string;
  joinedAt: string;
  leftAt: string | null;
  student: StudentItem;
};

type ApiError = {
  message?: string;
};

function formatGradeLabel(value: string | null) {
  if (!value) {
    return "Grade not provided";
  }

  if (value.startsWith("GRADE_")) {
    return `Grade ${value.slice(6)}`;
  }

  return `Grade ${value}`;
}

export function TeacherSessionPanel() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [students, setStudents] = useState<StudentItem[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [activeSession, setActiveSession] = useState<{
    id: string;
    roomName: string;
    jitsiDomain: string;
    startedAt: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isNotifying, setIsNotifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("idle");
  const [lastUpdateAt, setLastUpdateAt] = useState<string | null>(null);
  const [notifyChannels, setNotifyChannels] = useState({
    email: true,
    whatsapp: false,
  });

  const baseOrigin = useMemo(() => (typeof window !== "undefined" ? window.location.origin : ""), []);

  async function loadClasses() {
    const response = await fetch(`/api/classes?page=1&pageSize=${OPTION_PAGE_SIZE}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: ClassItem[];
      error?: ApiError;
    };

    if (!response.ok || !payload.success) {
      throw new Error(payload.error?.message ?? "Failed to load classes.");
    }

    return payload.data ?? [];
  }

  async function loadClassStudents(classId: string) {
    const response = await fetch(`/api/classes/${classId}/students?page=1&pageSize=${OPTION_PAGE_SIZE}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: {
        students: StudentItem[];
      };
      error?: ApiError;
    };

    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(payload.error?.message ?? "Failed to load class students.");
    }

    return payload.data.students;
  }

  async function loadActiveSession(classId: string) {
    const response = await fetch(`/api/classes/${classId}/sessions/active`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: {
        session: {
          id: string;
          roomName: string;
          jitsiDomain: string;
          startedAt: string;
        } | null;
      };
      error?: ApiError;
    };

    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(payload.error?.message ?? "Failed to load active session.");
    }

    return payload.data.session;
  }

  async function loadAttendance(sessionId: string) {
    const response = await fetch(`/api/sessions/${sessionId}/attendance?page=1&pageSize=${ATTENDANCE_PAGE_SIZE}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: {
        records: AttendanceRecord[];
      };
      error?: ApiError;
    };

    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(payload.error?.message ?? "Failed to load attendance.");
    }

    return payload.data.records;
  }

  const bootstrap = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const classList = await loadClasses();
      setClasses(classList);

      if (classList.length === 0) {
        setSelectedClassId("");
        setStudents([]);
        setActiveSession(null);
        setAttendance([]);
        setLastUpdateAt(null);
        return;
      }

      const classId = selectedClassId || classList[0].id;
      setSelectedClassId(classId);

      const [studentsList, session] = await Promise.all([
        loadClassStudents(classId),
        loadActiveSession(classId),
      ]);

      setStudents(studentsList);
      setActiveSession(session);

      if (session) {
        const records = await loadAttendance(session.id);
        setAttendance(records);
        setLastUpdateAt(new Date().toISOString());
      } else {
        setAttendance([]);
        setLastUpdateAt(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to initialize session panel.");
    } finally {
      setIsLoading(false);
    }
  }, [selectedClassId]);

  async function handleStartSession() {
    if (!selectedClassId) {
      return;
    }

    setIsStarting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/classes/${selectedClassId}/sessions/start`, {
        method: "POST",
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          session: {
            id: string;
            roomName: string;
            jitsiDomain: string;
            startedAt: string;
          };
        };
        error?: ApiError;
      };

      if (!response.ok || !payload.success || !payload.data) {
        setErrorMessage(payload.error?.message ?? "Failed to start class session.");
        return;
      }

      setActiveSession(payload.data.session);
      setAttendance([]);
      setSuccessMessage("Class session started. Share student links below.");
    } catch {
      setErrorMessage("Unable to start class session right now.");
    } finally {
      setIsStarting(false);
    }
  }

  async function handleClassChange(nextClassId: string) {
    setSelectedClassId(nextClassId);
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const [studentsList, session] = await Promise.all([
        loadClassStudents(nextClassId),
        loadActiveSession(nextClassId),
      ]);

      setStudents(studentsList);
      setActiveSession(session);

      if (session) {
        const records = await loadAttendance(session.id);
        setAttendance(records);
        setLastUpdateAt(new Date().toISOString());
      } else {
        setAttendance([]);
        setLastUpdateAt(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load class session details.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleNotifyStudents() {
    if (!activeSession) {
      return;
    }

    setIsNotifying(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/sessions/${activeSession.id}/notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(notifyChannels),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          totalStudents: number;
          attemptedDeliveries: number;
          sentCount: number;
          failedCount: number;
        };
        error?: ApiError;
      };

      if (!response.ok || !payload.success || !payload.data) {
        setErrorMessage(payload.error?.message ?? "Failed to notify students.");
        return;
      }

      setSuccessMessage(
        `Notifications complete. Sent ${payload.data.sentCount} of ${payload.data.attemptedDeliveries} delivery attempts to ${payload.data.totalStudents} students.`
      );
    } catch {
      setErrorMessage("Unable to notify students right now.");
    } finally {
      setIsNotifying(false);
    }
  }

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!activeSession) {
      setRealtimeStatus("idle");
      return;
    }

    let isCancelled = false;
    let reconnectAttempts = 0;
    let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let fallbackIntervalId: ReturnType<typeof setInterval> | null = null;
    let eventSource: EventSource | null = null;

    const refreshAttendance = async () => {
      try {
        const records = await loadAttendance(activeSession.id);

        if (!isCancelled) {
          setAttendance(records);
          setLastUpdateAt(new Date().toISOString());
        }
      } catch {
        // Ignore transient realtime refresh errors to avoid noisy UI.
      }
    };

    const stopFallbackRefresh = () => {
      if (!fallbackIntervalId) {
        return;
      }

      clearInterval(fallbackIntervalId);
      fallbackIntervalId = null;
    };

    const startFallbackRefresh = () => {
      if (fallbackIntervalId) {
        return;
      }

      fallbackIntervalId = setInterval(() => {
        void refreshAttendance();
      }, FALLBACK_REFRESH_INTERVAL_MS);
    };

    const disconnectSource = () => {
      if (!eventSource) {
        return;
      }

      eventSource.close();
      eventSource = null;
    };

    const scheduleReconnect = () => {
      if (isCancelled || reconnectTimeoutId) {
        return;
      }

      const delay = Math.min(
        RECONNECT_MAX_DELAY_MS,
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts
      );

      reconnectAttempts += 1;
      reconnectTimeoutId = setTimeout(() => {
        reconnectTimeoutId = null;
        connectToRealtime();
      }, delay);
    };

    const connectToRealtime = () => {
      if (isCancelled) {
        return;
      }

      setRealtimeStatus("connecting");
      disconnectSource();

      eventSource = new EventSource(`/api/sessions/${activeSession.id}/events`);

      eventSource.addEventListener("open", () => {
        if (isCancelled) {
          return;
        }

        reconnectAttempts = 0;
        stopFallbackRefresh();
        setRealtimeStatus("connected");
      });

      eventSource.addEventListener("attendance-update", () => {
        void refreshAttendance();
      });

      eventSource.addEventListener("error", () => {
        if (isCancelled) {
          return;
        }

        setRealtimeStatus("disconnected");
        startFallbackRefresh();
        disconnectSource();
        scheduleReconnect();
      });
    };

    void refreshAttendance();
    connectToRealtime();

    return () => {
      isCancelled = true;

      if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
      }

      stopFallbackRefresh();
      disconnectSource();
    };
  }, [activeSession]);

  return (
    <section className="mt-6 space-y-6">
      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Start class session</h2>
            <p className="mt-1 text-sm text-muted">Create a unique Jitsi room and share student join links.</p>
          </div>

          <button
            type="button"
            onClick={() => void bootstrap()}
            className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold dark:border-white/20"
          >
            Refresh
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <select
            value={selectedClassId}
            onChange={(event) => void handleClassChange(event.target.value)}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
          >
            <option value="">Select class</option>
            {classes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.schedule})
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={!selectedClassId || isStarting}
            onClick={() => void handleStartSession()}
            className="rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isStarting ? "Starting..." : "Start session"}
          </button>
        </div>

        {errorMessage ? (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
        ) : null}

        {successMessage ? (
          <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {successMessage}
          </p>
        ) : null}

        {activeSession ? (
          <div className="mt-5 rounded-2xl border border-black/10 p-4 dark:border-white/10">
            <p className="text-sm font-semibold">Active room: {activeSession.roomName}</p>
            <p className="text-xs text-muted">Started at {new Date(activeSession.startedAt).toLocaleString()}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="break-all text-xs text-muted">
                {`${baseOrigin}/session/join?sessionId=${activeSession.id}&role=teacher`}
              </p>
              <button
                type="button"
                onClick={() => window.open(`/session/join?sessionId=${activeSession.id}&role=teacher`, "_blank")}
                className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
              >
                Join as teacher
              </button>
            </div>

            <div className="mt-4 rounded-xl border border-black/10 p-3 dark:border-white/10">
              <p className="text-sm font-semibold">Notify all students in this class</p>
              <p className="mt-1 text-xs text-muted">
                Select channels and send secure login links. Email is active now; WhatsApp is placeholder for upcoming integration.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={notifyChannels.email}
                    onChange={(event) =>
                      setNotifyChannels((prev) => ({
                        ...prev,
                        email: event.target.checked,
                      }))
                    }
                  />
                  Email
                </label>

                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={notifyChannels.whatsapp}
                    onChange={(event) =>
                      setNotifyChannels((prev) => ({
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
                onClick={() => void handleNotifyStudents()}
                disabled={!notifyChannels.email && !notifyChannels.whatsapp || isNotifying}
                className="mt-3 rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isNotifying ? "Notifying..." : "Notify students"}
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-5 text-sm text-muted">No active session for this class.</p>
        )}
      </article>

      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <h2 className="text-lg font-semibold">Students in this class</h2>
        <p className="mt-1 text-sm text-muted">
          Use &quot;Notify students&quot; above to email secure invite links that auto-join after login.
        </p>

        {!activeSession ? <p className="mt-4 text-sm text-muted">Start a class session to enable notifications.</p> : null}

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {students.map((student) => {
            return (
              <div key={student.id} className="rounded-xl border border-black/10 p-3 text-sm dark:border-white/10">
                <p className="font-semibold">{student.name}</p>
                <p className="text-xs text-muted">{formatGradeLabel(student.grade)}</p>
                <p className="mt-2 break-all text-xs text-muted">Contact: {student.contact || "Not available"}</p>
              </div>
            );
          })}
        </div>
      </article>

      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold">Live attendance</h2>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                realtimeStatus === "connected"
                  ? "bg-emerald-100 text-emerald-700"
                  : realtimeStatus === "connecting"
                    ? "bg-amber-100 text-amber-800"
                    : realtimeStatus === "disconnected"
                      ? "bg-red-100 text-red-700"
                      : "bg-black/[0.06] text-muted dark:bg-white/[0.08]"
              }`}
            >
              Realtime: {realtimeStatus === "idle" ? "Not active" : realtimeStatus}
            </span>
            <span className="text-xs text-muted">
              Last update: {lastUpdateAt ? new Date(lastUpdateAt).toLocaleTimeString() : "--"}
            </span>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted">Join and leave timestamps are recorded automatically from Jitsi events.</p>

        {isLoading ? <p className="mt-4 text-sm text-muted">Loading attendance...</p> : null}

        {!isLoading && attendance.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No attendance records yet for the active session.</p>
        ) : null}

        <div className="mt-4 space-y-2">
          {attendance.map((record) => (
            <div key={record.id} className="rounded-xl border border-black/10 p-3 text-sm dark:border-white/10">
              <p className="font-semibold">{record.student.name}</p>
              <p className="text-xs text-muted">Joined: {new Date(record.joinedAt).toLocaleString()}</p>
              <p className="text-xs text-muted">
                Left: {record.leftAt ? new Date(record.leftAt).toLocaleString() : "Still in session"}
              </p>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
