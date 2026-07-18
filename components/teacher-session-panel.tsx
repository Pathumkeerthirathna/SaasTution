"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const FALLBACK_REFRESH_INTERVAL_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const OPTION_PAGE_SIZE = 50;
const SESSION_PAGE_SIZE = 6;

type RealtimeStatus = "idle" | "connecting" | "connected" | "disconnected";

type ClassItem = {
  id: string;
  name: string;
  schedule: string;
};

type LectureItem = {
  id: string;
  title: string;
  date: string;
};

type StudentItem = {
  id: string;
  name: string;
  grade: string | null;
  contact: string;
};

type SessionStudentLog = {
  id: string;
  joinedAt: string;
  leftAt: string | null;
};

type SessionStudentGroup = {
  student: StudentItem;
  logs: SessionStudentLog[];
};

type SessionItem = {
  id: string;
  roomName: string;
  jitsiDomain: string;
  startedAt: string;
  endedAt: string | null;
  isActive: boolean;
  class?: {
    id: string;
    name: string;
    schedule: string;
  };
  lecture: {
    id: string;
    title: string;
    date: string;
  } | null;
  _count?: {
    attendance: number;
  };
};

type SessionAttendancePanelData = {
  session: {
    id: string;
    classId: string;
    lectureId: string | null;
    roomName: string;
    startedAt: string;
    endedAt: string | null;
    lecture: {
      id: string;
      title: string;
      date: string;
    } | null;
    class: {
      id: string;
      name: string;
      schedule: string;
    };
  };
  joinedStudents: SessionStudentGroup[];
  notJoinedStudents: StudentItem[];
};

type ApiError = {
  message?: string;
};

type NotificationType = "started" | "restarted";

type PendingConfirmation = {
  kind: "end" | "restart";
  title: string;
  description: string;
  confirmLabel: string;
} | null;

function formatGradeLabel(value: string | null) {
  if (!value) {
    return "Grade not provided";
  }

  // if (value.startsWith("GRADE_")) {
  //   return `Grade ${value.slice(6)}`;
  // }

  // return `Grade ${value}`;

  console.log("GRADE value:", value, typeof value);

  if (typeof value === "string" && value.startsWith("GRADE_")) {
      return `Grade ${value.slice(6)}`;
  }

  return String(value);
}

export function TeacherSessionPanel() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [lectures, setLectures] = useState<LectureItem[]>([]);
  const [students, setStudents] = useState<StudentItem[]>([]);
  const [sessionHistory, setSessionHistory] = useState<SessionItem[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [selectedLectureId, setSelectedLectureId] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [activeSession, setActiveSession] = useState<SessionItem | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [isNotifying, setIsNotifying] = useState(false);
  const [isSessionPanelLoading, setIsSessionPanelLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("idle");
  const [lastUpdateAt, setLastUpdateAt] = useState<string | null>(null);
  const [notifyChannels, setNotifyChannels] = useState({
    email: true,
    whatsapp: false,
  });
  const [notificationType, setNotificationType] = useState<NotificationType>("started");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>(null);
  const [sessionHistoryPage, setSessionHistoryPage] = useState(1);
  const [sessionHistoryTotalPages, setSessionHistoryTotalPages] = useState(1);
  const [sessionHistoryLectureFilterId, setSessionHistoryLectureFilterId] = useState("");
  const [sessionHistoryDateFrom, setSessionHistoryDateFrom] = useState("");
  const [sessionHistoryDateTo, setSessionHistoryDateTo] = useState("");
  const [isStudentPanelOpen, setIsStudentPanelOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [sessionPanelData, setSessionPanelData] = useState<SessionAttendancePanelData | null>(null);
  const [expandedStudentIds, setExpandedStudentIds] = useState<Record<string, boolean>>({});
  const [studentPanelSearch, setStudentPanelSearch] = useState("");
  const sessionHistoryFiltersRef = useRef({
    lectureId: "",
    dateFrom: "",
    dateTo: "",
  });

  const baseOrigin = useMemo(() => (typeof window !== "undefined" ? window.location.origin : ""), []);
  const selectedSession = useMemo(
    () => sessionHistory.find((item) => item.id === selectedSessionId) ?? null,
    [sessionHistory, selectedSessionId]
  );
  const hasActiveSessionHistoryFilters = useMemo(
    () => Boolean(sessionHistoryLectureFilterId || sessionHistoryDateFrom || sessionHistoryDateTo),
    [sessionHistoryDateFrom, sessionHistoryDateTo, sessionHistoryLectureFilterId]
  );
  const normalizedStudentPanelSearch = studentPanelSearch.trim().toLowerCase();
  const filteredJoinedStudents = useMemo(() => {
    if (!sessionPanelData) {
      return [];
    }

    if (!normalizedStudentPanelSearch) {
      return sessionPanelData.joinedStudents;
    }

    return sessionPanelData.joinedStudents.filter((entry) => {
      const searchableText = [entry.student.name, entry.student.contact, entry.student.grade ?? ""]
        .join(" ")
        .toLowerCase();

      return searchableText.includes(normalizedStudentPanelSearch);
    });
  }, [normalizedStudentPanelSearch, sessionPanelData]);
  const filteredNotJoinedStudents = useMemo(() => {
    if (!sessionPanelData) {
      return [];
    }

    if (!normalizedStudentPanelSearch) {
      return sessionPanelData.notJoinedStudents;
    }

    return sessionPanelData.notJoinedStudents.filter((student) => {
      const searchableText = [student.name, student.contact, student.grade ?? ""].join(" ").toLowerCase();
      return searchableText.includes(normalizedStudentPanelSearch);
    });
  }, [normalizedStudentPanelSearch, sessionPanelData]);

  useEffect(() => {
    sessionHistoryFiltersRef.current = {
      lectureId: sessionHistoryLectureFilterId,
      dateFrom: sessionHistoryDateFrom,
      dateTo: sessionHistoryDateTo,
    };
  }, [sessionHistoryDateFrom, sessionHistoryDateTo, sessionHistoryLectureFilterId]);

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

  async function loadClassLectures(classId: string) {
    const response = await fetch(`/api/lectures?classId=${classId}&page=1&pageSize=${OPTION_PAGE_SIZE}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: Array<{
        id: string;
        title: string;
        date: string;
      }>;
      error?: ApiError;
    };

    if (!response.ok || !payload.success) {
      throw new Error(payload.error?.message ?? "Failed to load lectures.");
    }

    return payload.data ?? [];
  }

  async function loadActiveSession(classId: string) {
    const response = await fetch(`/api/classes/${classId}/sessions/active`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: {
        session: SessionItem | null;
      };
      error?: ApiError;
    };

    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(payload.error?.message ?? "Failed to load active session.");
    }

    return payload.data.session;
  }

  async function loadSessionHistory(
    classId: string,
    page = 1,
    filters?: {
      lectureId?: string;
      dateFrom?: string;
      dateTo?: string;
    }
  ) {
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(SESSION_PAGE_SIZE),
    });

    if (filters?.lectureId) {
      query.set("lectureId", filters.lectureId);
    }

    if (filters?.dateFrom) {
      query.set("dateFrom", filters.dateFrom);
    }

    if (filters?.dateTo) {
      query.set("dateTo", filters.dateTo);
    }

    const response = await fetch(`/api/classes/${classId}/sessions/history?${query.toString()}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: {
        sessions: SessionItem[];
      };
      pagination?: {
        page: number;
        totalPages: number;
      };
      error?: ApiError;
    };

    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(payload.error?.message ?? "Failed to load session history.");
    }

    return {
      sessions: payload.data.sessions,
      page: payload.pagination?.page ?? page,
      totalPages: payload.pagination?.totalPages ?? 1,
    };
  }

  async function loadSessionStudents(sessionId: string) {
    const response = await fetch(`/api/sessions/${sessionId}/attendance`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as {
      success: boolean;
      data?: SessionAttendancePanelData;
      error?: ApiError;
    };

    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(payload.error?.message ?? "Failed to load session students.");
    }

    return payload.data;
  }

  const bootstrap = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const classList = await loadClasses();
      setClasses(classList);

      if (classList.length === 0) {
        setSelectedClassId("");
        setSelectedLectureId("");
        setSelectedSessionId("");
        setLectures([]);
        setStudents([]);
        setActiveSession(null);
        setSessionHistory([]);
        setSessionHistoryPage(1);
        setSessionHistoryTotalPages(1);
        setSessionPanelData(null);
        setIsStudentPanelOpen(false);
        setLastUpdateAt(null);
        return;
      }

      const classId = selectedClassId || classList[0].id;
      setSelectedClassId(classId);

      const [studentsList, lecturesList, session, historyResult] = await Promise.all([
        loadClassStudents(classId),
        loadClassLectures(classId),
        loadActiveSession(classId),
        loadSessionHistory(classId, 1, {
          lectureId: sessionHistoryFiltersRef.current.lectureId || undefined,
          dateFrom: sessionHistoryFiltersRef.current.dateFrom || undefined,
          dateTo: sessionHistoryFiltersRef.current.dateTo || undefined,
        }),
      ]);

      setStudents(studentsList);
      setLectures(lecturesList);
      setActiveSession(session);
      setSessionHistory(historyResult.sessions);
      setSessionHistoryPage(historyResult.page);
      setSessionHistoryTotalPages(historyResult.totalPages);

      const defaultLectureId = lecturesList[0]?.id ?? "";
      setSelectedLectureId((prev) => {
        if (prev && lecturesList.some((item) => item.id === prev)) {
          return prev;
        }

        return defaultLectureId;
      });

      setSelectedSessionId(historyResult.sessions[0]?.id ?? session?.id ?? "");
      setSessionPanelData(null);
      setIsStudentPanelOpen(false);
      setLastUpdateAt(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to initialize session panel.");
    } finally {
      setIsLoading(false);
    }
  }, [selectedClassId]);

  async function handleStartSession() {
    if (!selectedClassId || !selectedLectureId) {
      return;
    }

    setIsStarting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/classes/${selectedClassId}/sessions/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lectureId: selectedLectureId,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          session: SessionItem;
        };
        error?: ApiError;
      };

      if (!response.ok || !payload.success || !payload.data) {
        setErrorMessage(payload.error?.message ?? "Failed to start class session.");
        return;
      }

      setActiveSession(payload.data.session);
      setNotificationType("started");

      const historyResult = await loadSessionHistory(selectedClassId, 1, {
        lectureId: sessionHistoryLectureFilterId || undefined,
        dateFrom: sessionHistoryDateFrom || undefined,
        dateTo: sessionHistoryDateTo || undefined,
      });
      setSessionHistory(historyResult.sessions);
      setSessionHistoryPage(historyResult.page);
      setSessionHistoryTotalPages(historyResult.totalPages);

      setSelectedSessionId(payload.data.session.id);
      setSuccessMessage("Class session started under the selected lecture.");
      setLastUpdateAt(new Date().toISOString());
    } catch {
      setErrorMessage("Unable to start class session right now.");
    } finally {
      setIsStarting(false);
    }
  }

  async function handleEndSession() {
    if (!activeSession) {
      return;
    }

    setIsEnding(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/sessions/${activeSession.id}/end`, {
        method: "POST",
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          sessionId: string;
        };
        error?: ApiError;
      };

      if (!response.ok || !payload.success || !payload.data) {
        setErrorMessage(payload.error?.message ?? "Failed to end class session.");
        return;
      }

      setActiveSession(null);
      const historyResult = await loadSessionHistory(selectedClassId, 1, {
        lectureId: sessionHistoryLectureFilterId || undefined,
        dateFrom: sessionHistoryDateFrom || undefined,
        dateTo: sessionHistoryDateTo || undefined,
      });
      setSessionHistory(historyResult.sessions);
      setSessionHistoryPage(historyResult.page);
      setSessionHistoryTotalPages(historyResult.totalPages);
      setSelectedSessionId(payload.data.sessionId);

      if (isStudentPanelOpen && payload.data.sessionId) {
        const panelData = await loadSessionStudents(payload.data.sessionId);
        setSessionPanelData(panelData);
      }

      setLastUpdateAt(new Date().toISOString());
      setSuccessMessage("Class session ended.");
    } catch {
      setErrorMessage("Unable to end class session right now.");
    } finally {
      setIsEnding(false);
    }
  }

  async function handleRestartSession() {
    if (!selectedClassId || !selectedSession?.lecture?.id || activeSession) {
      return;
    }

    setIsStarting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/classes/${selectedClassId}/sessions/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lectureId: selectedSession.lecture.id,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          session: SessionItem;
        };
        error?: ApiError;
      };

      if (!response.ok || !payload.success || !payload.data) {
        setErrorMessage(payload.error?.message ?? "Failed to restart class session.");
        return;
      }

      setActiveSession(payload.data.session);
      setNotificationType("restarted");

      const historyResult = await loadSessionHistory(selectedClassId, 1, {
        lectureId: sessionHistoryLectureFilterId || undefined,
        dateFrom: sessionHistoryDateFrom || undefined,
        dateTo: sessionHistoryDateTo || undefined,
      });
      setSessionHistory(historyResult.sessions);
      setSessionHistoryPage(historyResult.page);
      setSessionHistoryTotalPages(historyResult.totalPages);
      setSelectedSessionId(payload.data.session.id);

      if (isStudentPanelOpen) {
        const panelData = await loadSessionStudents(payload.data.session.id);
        setSessionPanelData(panelData);
      }

      setLastUpdateAt(new Date().toISOString());
      setSuccessMessage("Session restarted. Confirm channels below to notify students.");
    } catch {
      setErrorMessage("Unable to restart class session right now.");
    } finally {
      setIsStarting(false);
    }
  }

  async function handleClassChange(nextClassId: string) {
    setSelectedClassId(nextClassId);
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const [studentsList, lecturesList, session, historyResult] = await Promise.all([
        loadClassStudents(nextClassId),
        loadClassLectures(nextClassId),
        loadActiveSession(nextClassId),
        loadSessionHistory(nextClassId, 1),
      ]);

      setStudents(studentsList);
      setLectures(lecturesList);
      setActiveSession(session);
      setSessionHistory(historyResult.sessions);
      setSessionHistoryPage(historyResult.page);
      setSessionHistoryTotalPages(historyResult.totalPages);
      setSelectedLectureId(lecturesList[0]?.id ?? "");
      setSessionHistoryLectureFilterId("");
      setSessionHistoryDateFrom("");
      setSessionHistoryDateTo("");
      setSelectedSessionId(historyResult.sessions[0]?.id ?? session?.id ?? "");
      setSessionPanelData(null);
      setIsStudentPanelOpen(false);
      setLastUpdateAt(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load class session details.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSessionHistoryPageChange(nextPage: number) {
    if (!selectedClassId || nextPage < 1 || nextPage > sessionHistoryTotalPages) {
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const historyResult = await loadSessionHistory(selectedClassId, nextPage, {
        lectureId: sessionHistoryLectureFilterId || undefined,
        dateFrom: sessionHistoryDateFrom || undefined,
        dateTo: sessionHistoryDateTo || undefined,
      });
      setSessionHistory(historyResult.sessions);
      setSessionHistoryPage(historyResult.page);
      setSessionHistoryTotalPages(historyResult.totalPages);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load session history.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleOpenStudentPanel(sessionId: string) {
    setSelectedSessionId(sessionId);
    setIsStudentPanelOpen(true);
    setIsSessionPanelLoading(true);
    setExpandedStudentIds({});
    setStudentPanelSearch("");
    setErrorMessage(null);

    try {
      const data = await loadSessionStudents(sessionId);
      setSessionPanelData(data);
      setLastUpdateAt(new Date().toISOString());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load session students.");
    } finally {
      setIsSessionPanelLoading(false);
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
        body: JSON.stringify({
          ...notifyChannels,
          notificationType,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          totalStudents: number;
          attemptedDeliveries: number;
          sentCount: number;
        };
        error?: ApiError;
      };

      if (!response.ok || !payload.success || !payload.data) {
        setErrorMessage(payload.error?.message ?? "Failed to notify students.");
        return;
      }

      setSuccessMessage(
        `Notifications complete. Sent ${payload.data.sentCount} of ${payload.data.attemptedDeliveries} delivery attempts to ${payload.data.totalStudents} students for the ${notificationType === "restarted" ? "restarted" : "started"} session.`
      );
    } catch {
      setErrorMessage("Unable to notify students right now.");
    } finally {
      setIsNotifying(false);
    }
  }

  function openEndSessionConfirmation() {
    if (!activeSession) {
      return;
    }

    setPendingConfirmation({
      kind: "end",
      title: "End this live session?",
      description: "Students will be removed from the live classroom and will see that the session has ended.",
      confirmLabel: "End session",
    });
  }

  function openRestartSessionConfirmation() {
    if (!selectedSession?.lecture || activeSession) {
      return;
    }

    setPendingConfirmation({
      kind: "restart",
      title: "Restart this session?",
      description: "A new live session will be created for the selected lecture. You can then notify students that the session restarted.",
      confirmLabel: "Restart session",
    });
  }

  async function handleConfirmAction() {
    const action = pendingConfirmation;

    if (!action) {
      return;
    }

    setPendingConfirmation(null);

    if (action.kind === "end") {
      await handleEndSession();
      return;
    }

    await handleRestartSession();
  }

  function toggleStudentLogs(studentId: string) {
    setExpandedStudentIds((prev) => ({
      ...prev,
      [studentId]: !prev[studentId],
    }));
  }

  async function applySessionHistoryFilters() {
    if (!selectedClassId) {
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const historyResult = await loadSessionHistory(selectedClassId, 1, {
        lectureId: sessionHistoryLectureFilterId || undefined,
        dateFrom: sessionHistoryDateFrom || undefined,
        dateTo: sessionHistoryDateTo || undefined,
      });
      setSessionHistory(historyResult.sessions);
      setSessionHistoryPage(historyResult.page);
      setSessionHistoryTotalPages(historyResult.totalPages);
      setSelectedSessionId(historyResult.sessions[0]?.id ?? "");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to apply session filters.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!activeSession || !isStudentPanelOpen || selectedSessionId !== activeSession.id) {
      setRealtimeStatus("idle");
      return;
    }

    const sessionId = activeSession.id;

    let isCancelled = false;
    let reconnectAttempts = 0;
    let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let fallbackIntervalId: ReturnType<typeof setInterval> | null = null;
    let eventSource: EventSource | null = null;

    const refreshPanel = async () => {
      try {
        const data = await loadSessionStudents(sessionId);

        if (!isCancelled) {
          setSessionPanelData(data);
          setLastUpdateAt(new Date().toISOString());
        }
      } catch {
        // Ignore transient realtime refresh errors.
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
        void refreshPanel();
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

      const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts);

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

      eventSource = new EventSource(`/api/sessions/${sessionId}/events`);

      eventSource.addEventListener("open", () => {
        if (isCancelled) {
          return;
        }

        reconnectAttempts = 0;
        stopFallbackRefresh();
        setRealtimeStatus("connected");
      });

      eventSource.addEventListener("attendance-update", () => {
        void refreshPanel();
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

    void refreshPanel();
    connectToRealtime();

    return () => {
      isCancelled = true;

      if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
      }

      stopFallbackRefresh();
      disconnectSource();
    };
  }, [activeSession, isStudentPanelOpen, selectedSessionId]);

  return (
    <section className="space-y-5">
      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Start class session</h2>
            <p className="mt-1 text-sm text-muted">Create a unique Jitsi room and share student join links.</p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void bootstrap()}
              className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold dark:border-white/20"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold dark:border-white/20"
            >
              Help
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
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

          <select
            value={selectedLectureId}
            onChange={(event) => setSelectedLectureId(event.target.value)}
            disabled={!selectedClassId || lectures.length === 0}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20 dark:bg-transparent"
          >
            <option value="">Select lecture</option>
            {lectures.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} ({new Date(item.date).toLocaleDateString()})
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={!selectedClassId || !selectedLectureId || isStarting}
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
            {activeSession.lecture ? (
              <p className="text-xs text-muted">
                Lecture: {activeSession.lecture.title} ({new Date(activeSession.lecture.date).toLocaleDateString()})
              </p>
            ) : null}
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="break-all text-xs text-muted">{`${baseOrigin}/session/join?sessionId=${activeSession.id}&role=teacher`}</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.open(`/session/join?sessionId=${activeSession.id}&role=teacher`, "_blank")}
                  className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
                >
                  Join as teacher
                </button>
                <button
                  type="button"
                  onClick={openEndSessionConfirmation}
                  disabled={isEnding}
                  className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isEnding ? "Ending..." : "End session"}
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-black/10 p-3 dark:border-white/10">
              <p className="text-sm font-semibold">
                {notificationType === "restarted" ? "Notify students that the session restarted" : "Notify all students in this class"}
              </p>
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
                disabled={(!notifyChannels.email && !notifyChannels.whatsapp) || isNotifying}
                className="mt-3 rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isNotifying ? "Notifying..." : notificationType === "restarted" ? "Send restarted-session notice" : "Notify students"}
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-5 text-sm text-muted">No active session for this class.</p>
        )}
      </article>

      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Live sessions</h2>
            <p className="mt-1 text-sm text-muted">Page {sessionHistoryPage} of {sessionHistoryTotalPages}</p>
          </div>

          <div className="grid w-full grid-cols-1 gap-2 lg:w-auto lg:grid-cols-[1.1fr_1fr_1fr_1fr_auto]">
            <select
              value={selectedClassId}
              onChange={(event) => void handleClassChange(event.target.value)}
              className="rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
            >
              {classes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>

            <select
              value={sessionHistoryLectureFilterId}
              onChange={(event) => setSessionHistoryLectureFilterId(event.target.value)}
              className="rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
            >
              <option value="">All lectures</option>
              {lectures.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>

            <input
              type="date"
              value={sessionHistoryDateFrom}
              onChange={(event) => setSessionHistoryDateFrom(event.target.value)}
              className="rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
            />

            <input
              type="date"
              value={sessionHistoryDateTo}
              onChange={(event) => setSessionHistoryDateTo(event.target.value)}
              className="rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
            />

            <button
              type="button"
              onClick={() => void applySessionHistoryFilters()}
              className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold dark:border-white/20"
            >
              Apply
            </button>
          </div>
        </div>

        {isLoading ? <p className="mt-4 text-sm text-muted">Loading sessions...</p> : null}

        {!isLoading && sessionHistory.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            {hasActiveSessionHistoryFilters
              ? "No sessions found for the selected filters."
              : "No sessions found for this class yet."}
          </p>
        ) : null}

        <div className="mt-4 space-y-4">
          {sessionHistory.map((session) => {
            const isSelected = session.id === selectedSessionId;

            return (
              <div
                key={session.id}
                className={`rounded-2xl border p-4 shadow-sm ${
                  isSelected
                    ? "border-black/30 bg-black/[0.03] dark:border-white/30 dark:bg-white/[0.05]"
                    : "border-black/10 dark:border-white/10"
                }`}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex gap-4">
                    <div className="h-24 w-24 shrink-0 rounded-2xl border border-black/10 bg-gradient-to-br from-slate-100 to-slate-200 dark:border-white/10" />
                    <div>
                      <p className="text-xl font-semibold">{session.class?.name ?? classes.find((item) => item.id === selectedClassId)?.name ?? "Class"}</p>
                      <p className="mt-1 text-sm text-muted">
                        Lecture: {session.lecture ? `${session.lecture.title} (${new Date(session.lecture.date).toLocaleDateString()})` : "Not linked"}
                      </p>
                      <p className="mt-1 text-xs text-muted">Room: {session.roomName}</p>
                      <p className="mt-1 text-xs text-muted">Started: {new Date(session.startedAt).toLocaleString()}</p>
                      <p className="mt-1 text-xs text-muted">
                        {session.endedAt ? `Ended: ${new Date(session.endedAt).toLocaleString()}` : "End time: In progress"}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col items-start gap-3 lg:items-end">
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        session.isActive ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {session.isActive ? "Live" : "Ended"}
                    </span>
                    <p className="text-xs text-muted">Attendance logs: {session._count?.attendance ?? 0}</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-black/10 pt-4 dark:border-white/10">
                  <button
                    type="button"
                    onClick={() => void handleOpenStudentPanel(session.id)}
                    className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
                  >
                    View students
                  </button>

                  {!session.isActive && !activeSession && isSelected && session.lecture ? (
                    <button
                      type="button"
                      onClick={openRestartSessionConfirmation}
                      disabled={isStarting}
                      className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isStarting ? "Restarting..." : "Restart session"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            disabled={sessionHistoryPage <= 1 || isLoading}
            onClick={() => void handleSessionHistoryPageChange(sessionHistoryPage - 1)}
            className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20"
          >
            Previous
          </button>

          <button
            type="button"
            disabled={sessionHistoryPage >= sessionHistoryTotalPages || isLoading}
            onClick={() => void handleSessionHistoryPageChange(sessionHistoryPage + 1)}
            className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20"
          >
            Next
          </button>
        </div>
      </article>

      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <h2 className="text-lg font-semibold">Students in this class</h2>
        <p className="mt-1 text-sm text-muted">Use the session cards above to inspect joined and not-joined students for each live session.</p>

        {!activeSession ? <p className="mt-4 text-sm text-muted">Start a class session to enable notifications.</p> : null}

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {students.map((student) => (
            <div key={student.id} className="rounded-xl border border-black/10 p-3 text-sm dark:border-white/10">
              <p className="font-semibold">{student.name}</p>
              <p className="text-xs text-muted">{formatGradeLabel(student.grade)}</p>
              <p className="mt-2 break-all text-xs text-muted">Contact: {student.contact || "Not available"}</p>
            </div>
          ))}
        </div>
      </article>

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isStudentPanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsStudentPanelOpen(false)}
        aria-hidden
      />

      <aside
        className={`fixed right-0 top-0 z-50 h-full w-full max-w-lg transform overflow-y-auto border-l border-black/10 bg-card p-5 shadow-2xl transition-transform duration-200 dark:border-white/10 sm:p-6 ${
          isStudentPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isStudentPanelOpen}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Session students</h2>
            <p className="mt-1 text-sm text-muted">
              {sessionPanelData ? sessionPanelData.session.roomName : "Select a session card to inspect attendance."}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setIsStudentPanelOpen(false)}
            className="rounded-lg border border-black/15 px-3 py-1 text-sm font-semibold dark:border-white/20"
          >
            Close
          </button>
        </div>

        <div className="mt-4 flex items-center gap-2">
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
          <span className="text-xs text-muted">Last update: {lastUpdateAt ? new Date(lastUpdateAt).toLocaleTimeString() : "--"}</span>
        </div>

        <div className="mt-4">
          <input
            value={studentPanelSearch}
            onChange={(event) => setStudentPanelSearch(event.target.value)}
            placeholder="Search students by name, grade, or contact..."
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
          />
        </div>

        {isSessionPanelLoading ? <p className="mt-4 text-sm text-muted">Loading students...</p> : null}

        {sessionPanelData ? (
          <div className="mt-4 space-y-5">
            <div className="rounded-xl border border-black/10 p-3 text-sm dark:border-white/10">
              <p className="font-semibold">{sessionPanelData.session.class.name}</p>
              <p className="text-xs text-muted">{sessionPanelData.session.class.schedule}</p>
              {sessionPanelData.session.lecture ? (
                <p className="mt-1 text-xs text-muted">
                  Lecture: {sessionPanelData.session.lecture.title} ({new Date(sessionPanelData.session.lecture.date).toLocaleDateString()})
                </p>
              ) : null}
            </div>

            <div>
              <p className="text-sm font-semibold">Joined students ({filteredJoinedStudents.length})</p>
              {filteredJoinedStudents.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No students joined this session yet.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {filteredJoinedStudents.map((entry) => {
                    const isExpanded = expandedStudentIds[entry.student.id] ?? false;

                    return (
                      <div key={entry.student.id} className="rounded-xl border border-black/10 p-3 text-sm dark:border-white/10">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold">{entry.student.name}</p>
                            <p className="text-xs text-muted">{formatGradeLabel(entry.student.grade)}</p>
                            <p className="text-xs text-muted">Entries: {entry.logs.length}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => toggleStudentLogs(entry.student.id)}
                            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
                          >
                            {isExpanded ? "Hide logs" : "More"}
                          </button>
                        </div>

                        {isExpanded ? (
                          <div className="mt-3 space-y-2 border-t border-black/10 pt-3 dark:border-white/10">
                            {entry.logs.map((log, index) => (
                              <div key={log.id} className="rounded-lg border border-black/10 px-3 py-2 text-xs dark:border-white/10">
                                <p className="font-semibold">Log {index + 1}</p>
                                <p className="text-muted">Joined: {new Date(log.joinedAt).toLocaleString()}</p>
                                <p className="text-muted">Left: {log.leftAt ? new Date(log.leftAt).toLocaleString() : "Still in session"}</p>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <p className="text-sm font-semibold">Not joined ({filteredNotJoinedStudents.length})</p>
              {filteredNotJoinedStudents.length === 0 ? (
                <p className="mt-2 text-sm text-muted">All students joined at least once.</p>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {filteredNotJoinedStudents.map((student) => (
                    <div key={student.id} className="rounded-xl border border-black/10 p-3 text-sm dark:border-white/10">
                      <p className="font-semibold">{student.name}</p>
                      <p className="text-xs text-muted">{formatGradeLabel(student.grade)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </aside>

      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-black/10 bg-card p-4 shadow-2xl dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">About This Page</p>
                <h3 className="mt-2 text-lg font-semibold">Live Class Sessions</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="rounded-lg border border-black/10 px-3 py-1 text-sm font-semibold dark:border-white/15"
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-4 text-sm text-muted">
              <div>
                <p className="font-semibold text-foreground">Start a Class Session</p>
                <p className="mt-1">Create a unique Jitsi room for each class lecture, get a shareable link for students, and begin live teaching.</p>
              </div>
              <div>
                <p className="font-semibold text-foreground">Automatic Attendance Tracking</p>
                <p className="mt-1">Timestamps are automatically captured when students join and leave the session for accurate attendance records.</p>
              </div>
              <div>
                <p className="font-semibold text-foreground">Session History & Analytics</p>
                <p className="mt-1">View past sessions, filter by lecture or date range, and see detailed attendance logs including join/leave times.</p>
              </div>
              <div>
                <p className="font-semibold text-foreground">How to Use</p>
                <ul className="mt-2 list-inside list-disc space-y-1">
                  <li>Select a class and lecture from the dropdowns</li>
                  <li>Click &ldquo;Start session&rdquo; to create the room and get the join link</li>
                  <li>Share the link with students to begin the class</li>
                  <li>End the session when class is complete</li>
                  <li>View session history and student attendance records below</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingConfirmation ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-3xl border border-black/10 bg-card p-6 shadow-xl dark:border-white/10">
            <h3 className="text-lg font-semibold">{pendingConfirmation.title}</h3>
            <p className="mt-2 text-sm text-muted">{pendingConfirmation.description}</p>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setPendingConfirmation(null)}
                className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold dark:border-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmAction()}
                disabled={isEnding || isStarting}
                className="rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pendingConfirmation.kind === "end"
                  ? isEnding
                    ? "Ending..."
                    : pendingConfirmation.confirmLabel
                  : isStarting
                    ? "Restarting..."
                    : pendingConfirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
