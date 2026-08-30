"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Calendar,
  CalendarClock,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  CircleHelp,
  Clock3,
  FileText,
  Filter,
  GraduationCap,
  MonitorPlay,
  Play,
  Plus,
  Radio,
  Save,
  Search,
  SquarePen,
  Trash2,
  UserCheck,
  UserX,
  Users,
  Video,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { LectureQuizPanel } from "@/components/lecture-quiz-panel";
import { LectureAssignmentPanel } from "@/components/lecture-assignment-panel";
import { LectureNotePanel } from "@/components/lecture-note-panel";

type ClassItem = {
  id: string;
  name: string;
  schedule: string;
};

type ClassStatus = "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";

type LectureItem = {
  id: string;
  title: string;
  date: string;
  classStatus: ClassStatus;
  createdAt: string;
  class: {
    id: string;
    name: string;
    schedule: string;
  };
  _count: {
    notes: number;
    assignments: number;
    quizzes: number;
  };
};

type RecordingVisibility = "PUBLIC" | "PRIVATE";
type RecordingAccess = "FREE" | "LOCKED";

type RecordingItem = {
  id: string;
  videoId: string;
  youtubeUrl: string;
  privacy: string;
  status: string;
  visibility: RecordingVisibility;
  access: RecordingAccess;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

type LiveBroadcastItem = {
  id: string;
  videoId: string;
  youtubeUrl: string;
  privacy: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

type PlayableVideo = {
  id: string;
  videoId: string;
};

type LectureSessionItem = {
  id: string;
  roomName: string;
  jitsiDomain: string;
  startedAt: string;
  endedAt: string | null;
  isActive: boolean;
  createdAt: string;
  _count: {
    attendance: number;
  };
};

type SessionAttendanceLog = {
  id: string;
  joinedAt: string;
  leftAt: string | null;
};

type SessionAttendanceStudent = {
  id: string;
  name: string;
};

type SessionAttendanceData = {
  present: {
    student: SessionAttendanceStudent;
    logs: SessionAttendanceLog[];
  }[];
  absent: SessionAttendanceStudent[];
};

const PRIVACY_OPTIONS: { value: "public" | "unlisted" | "private"; label: string }[] = [
  { value: "public", label: "Public" },
  { value: "unlisted", label: "Unlisted" },
  { value: "private", label: "Private" },
];

const VISIBILITY_OPTIONS: { value: RecordingVisibility; label: string }[] = [
  { value: "PUBLIC", label: "Public" },
  { value: "PRIVATE", label: "Private" },
];

const ACCESS_OPTIONS: { value: RecordingAccess; label: string }[] = [
  { value: "FREE", label: "Free" },
  { value: "LOCKED", label: "Locked" },
];

type LectureTab = "notes" | "assignments" | "quizzes";

type QuizPanelLecture = {
  id: string;
  title: string;
  date: string;
  class: {
    id: string;
    name: string;
    schedule: string;
  };
};

type AssignmentPanelLecture = {
  id: string;
  title: string;
  date: string;
  class: {
    id: string;
    name: string;
    schedule: string;
  };
};

type NotePanelLecture = {
  id: string;
  title: string;
  date: string;
  class: {
    id: string;
    name: string;
    schedule: string;
  };
};

const DEFAULT_PAGE_SIZE = 3;
const PAGE_SIZE_OPTIONS = [3, 5, 10, 20, 50];
const OPTION_PAGE_SIZE = 50;

function readApiError(payload: unknown, fallbackMessage: string) {
  if (!payload || typeof payload !== "object") {
    return fallbackMessage;
  }

  const typed = payload as { error?: { message?: string }; message?: string };
  return typed.error?.message ?? typed.message ?? fallbackMessage;
}

const CLASS_STATUS_META: Record<ClassStatus, { label: string; tone: string; dot: string }> = {
  SCHEDULED: { label: "Scheduled", tone: "bg-slate-100 text-slate-700", dot: "bg-slate-500" },
  LIVE: { label: "Live", tone: "bg-red-100 text-red-700", dot: "bg-red-600" },
  COMPLETED: { label: "Completed", tone: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-600" },
  CANCELLED: { label: "Cancelled", tone: "bg-rose-100 text-rose-700", dot: "bg-rose-600" },
};

function toDateTimeLocal(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

type DatePreset =
  | "all"
  | "today"
  | "tomorrow"
  | "yesterday"
  | "last7"
  | "next7"
  | "last30"
  | "next30"
  | "lastMonth"
  | "nextMonth"
  | "custom";

const DATE_PRESET_OPTIONS: { value: DatePreset; label: string }[] = [
  { value: "all", label: "All dates" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last week" },
  { value: "next7", label: "Next week" },
  { value: "last30", label: "Last 30 days" },
  { value: "next30", label: "Next 30 days" },
  { value: "lastMonth", label: "Last month" },
  { value: "nextMonth", label: "Next month" },
  { value: "custom", label: "Custom range" },
];

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

type PeriodMode = "all" | "period" | "quick" | "custom";

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const QUICK_RANGE_OPTIONS = DATE_PRESET_OPTIONS.filter(
  (option) => option.value !== "all" && option.value !== "custom"
);

function filterTileClass(active: boolean) {
  return `rounded-md px-2 py-1 text-[11px] font-semibold leading-5 transition ${
    active
      ? "bg-brand-700 text-white shadow-sm"
      : "bg-white text-slate-600 hover:bg-brand-50"
  }`;
}

function quickPillClass(active: boolean) {
  return `rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
    active
      ? "border-brand-700 bg-brand-700 text-white"
      : "border-slate-200 bg-white text-slate-600 hover:border-brand-200 hover:bg-brand-50"
  }`;
}

function yearRange(year: number) {
  return {
    from: startOfDay(new Date(year, 0, 1)),
    to: endOfDay(new Date(year, 11, 31)),
  };
}

function monthRange(year: number, month: number) {
  return {
    from: startOfDay(new Date(year, month - 1, 1)),
    to: endOfDay(new Date(year, month, 0)),
  };
}

function computeDatePresetRange(preset: DatePreset): { from?: Date; to?: Date } {
  const now = new Date();

  switch (preset) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "tomorrow": {
      const day = addDays(now, 1);
      return { from: startOfDay(day), to: endOfDay(day) };
    }
    case "yesterday": {
      const day = addDays(now, -1);
      return { from: startOfDay(day), to: endOfDay(day) };
    }
    case "last7":
      return { from: startOfDay(addDays(now, -7)), to: endOfDay(now) };
    case "next7":
      return { from: startOfDay(now), to: endOfDay(addDays(now, 7)) };
    case "last30":
      return { from: startOfDay(addDays(now, -30)), to: endOfDay(now) };
    case "next30":
      return { from: startOfDay(now), to: endOfDay(addDays(now, 30)) };
    case "lastMonth": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: startOfDay(first), to: endOfDay(last) };
    }
    case "nextMonth": {
      const first = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 2, 0);
      return { from: startOfDay(first), to: endOfDay(last) };
    }
    default:
      return {};
  }
}

function LectureCardSkeleton() {
  return (
    <div className="animate-pulse rounded-lg border border-slate-200 bg-white p-3.5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex gap-3">
          <div className="h-10 w-10 shrink-0 rounded-lg bg-slate-200" />
          <div className="space-y-2">
            <div className="h-3.5 w-40 rounded bg-slate-200" />
            <div className="flex flex-wrap gap-2">
              <div className="h-2.5 w-16 rounded bg-slate-100" />
              <div className="h-2.5 w-14 rounded bg-slate-100" />
              <div className="h-2.5 w-24 rounded bg-slate-100" />
            </div>
            <div className="h-2.5 w-28 rounded bg-slate-100" />
            <div className="mt-1 flex gap-1.5">
              <div className="h-5 w-16 rounded-full bg-slate-100" />
              <div className="h-5 w-24 rounded-full bg-slate-100" />
              <div className="h-5 w-16 rounded-full bg-slate-100" />
            </div>
          </div>
        </div>

        <div className="flex flex-row items-center justify-between gap-2 lg:flex-col lg:items-end">
          <div className="h-4 w-16 rounded-full bg-slate-100" />
          <div className="flex gap-1.5">
            <div className="h-7 w-12 rounded-md bg-slate-100" />
            <div className="h-7 w-14 rounded-md bg-slate-100" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function LectureManagementPanel() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [lectures, setLectures] = useState<LectureItem[]>([]);
  const [filterClassId, setFilterClassId] = useState("");
  const [searchText, setSearchText] = useState("");

  const [createLectureForm, setCreateLectureForm] = useState({
    classId: "",
    title: "",
    date: "",
  });

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [isAddLecturePanelOpen, setIsAddLecturePanelOpen] = useState(false);
  const [isQuizPanelOpen, setIsQuizPanelOpen] = useState(false);
  const [quizPanelLecture, setQuizPanelLecture] = useState<QuizPanelLecture | null>(null);
  const [isAssignmentPanelOpen, setIsAssignmentPanelOpen] = useState(false);
  const [assignmentPanelLecture, setAssignmentPanelLecture] = useState<AssignmentPanelLecture | null>(null);
  const [isNotePanelOpen, setIsNotePanelOpen] = useState(false);
  const [notePanelLecture, setNotePanelLecture] = useState<NotePanelLecture | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  const [editingLecture, setEditingLecture] = useState<LectureItem | null>(null);
  const [editLectureForm, setEditLectureForm] = useState({ title: "", date: "" });

  const [appliedSearch, setAppliedSearch] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [dateRange, setDateRange] = useState<{ from?: Date; to?: Date }>({});
  const [periodMode, setPeriodMode] = useState<PeriodMode>("period");
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [filterMonth, setFilterMonth] = useState<number | null>(
    new Date().getMonth() + 1
  );
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [statusMenuLectureId, setStatusMenuLectureId] = useState<string | null>(null);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  const [expandedRecordingIds, setExpandedRecordingIds] = useState<Set<string>>(new Set());
  const [recordingsByLecture, setRecordingsByLecture] = useState<Record<string, RecordingItem[]>>({});
  const [loadingRecordingsFor, setLoadingRecordingsFor] = useState<Set<string>>(new Set());
  const [playingRecording, setPlayingRecording] = useState<PlayableVideo | null>(null);

  const [expandedLiveIds, setExpandedLiveIds] = useState<Set<string>>(new Set());
  const [livesByLecture, setLivesByLecture] = useState<Record<string, LiveBroadcastItem[]>>({});
  const [loadingLivesFor, setLoadingLivesFor] = useState<Set<string>>(new Set());
  const [updatingPrivacyFor, setUpdatingPrivacyFor] = useState<Set<string>>(new Set());
  const [updatingRecordingFor, setUpdatingRecordingFor] = useState<Set<string>>(new Set());

  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(new Set());
  const [sessionsByLecture, setSessionsByLecture] = useState<Record<string, LectureSessionItem[]>>({});
  const [loadingSessionsFor, setLoadingSessionsFor] = useState<Set<string>>(new Set());
  const [creatingSessionFor, setCreatingSessionFor] = useState<Set<string>>(new Set());
  const [endingSessionFor, setEndingSessionFor] = useState<Set<string>>(new Set());
  const [endSessionConfirm, setEndSessionConfirm] = useState<
    { sessionId: string; lectureId: string; roomName: string } | null
  >(null);
  const [attendancePopoverSessionId, setAttendancePopoverSessionId] = useState<string | null>(null);
  const [attendanceBySession, setAttendanceBySession] = useState<Record<string, SessionAttendanceData>>({});
  const [loadingAttendanceFor, setLoadingAttendanceFor] = useState<Set<string>>(new Set());

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const loadClasses = useCallback(async () => {
    const response = await fetch(`/api/classes?page=1&pageSize=${OPTION_PAGE_SIZE}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: ClassItem[];
    };

    if (!response.ok || !payload.success) {
      throw new Error(readApiError(payload, "Failed to load classes."));
    }

    return payload.data ?? [];
  }, []);

  const loadLectures = useCallback(
    async (
      nextPage = 1,
      classId = "",
      title = "",
      dateFrom?: Date,
      dateTo?: Date,
      currentPageSize = DEFAULT_PAGE_SIZE,
      currentSortOrder: "asc" | "desc" = "desc"
    ) => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const query = new URLSearchParams({
        page: String(nextPage),
        pageSize: String(currentPageSize),
        sortOrder: currentSortOrder,
      });

      if (classId) {
        query.set("classId", classId);
      }

      if (title.trim()) {
        query.set("title", title.trim());
      }

      if (dateFrom) {
        query.set("from", dateFrom.toISOString());
      }

      if (dateTo) {
        query.set("to", dateTo.toISOString());
      }

      const response = await fetch(`/api/lectures?${query.toString()}`);
      const payload = (await response.json()) as {
        success: boolean;
        data?: LectureItem[];
        pagination?: {
          page: number;
          totalPages: number;
        };
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load lectures."));
      }

      setLectures(payload.data ?? []);
      setPage(payload.pagination?.page ?? nextPage);
      setTotalPages(payload.pagination?.totalPages ?? 1);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load lectures.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  function runLoad(nextRange: { from?: Date; to?: Date }, nextClassId = filterClassId) {
    setDateRange(nextRange);
    void loadLectures(
      1,
      nextClassId,
      appliedSearch,
      nextRange.from,
      nextRange.to,
      pageSize,
      sortOrder
    );
  }

  function selectFilterClass(value: string) {
    setFilterClassId(value);
    runLoad(dateRange, value);
  }

  function selectFilterYear(year: number) {
    setFilterYear(year);
    setPeriodMode("period");
    setDatePreset("all");
    runLoad(filterMonth ? monthRange(year, filterMonth) : yearRange(year));
  }

  function selectFilterMonth(month: number) {
    setFilterMonth(month);
    setPeriodMode("period");
    setDatePreset("all");
    runLoad(monthRange(filterYear, month));
  }

  function selectQuickRange(preset: DatePreset) {
    setDatePreset(preset);
    setPeriodMode("quick");
    setFilterMonth(null);
    runLoad(computeDatePresetRange(preset));
  }

  function clearPeriodFilter() {
    setPeriodMode("all");
    setDatePreset("all");
    setFilterMonth(null);
    runLoad({});
  }

  useEffect(() => {
    async function bootstrap() {
      let firstClassId = "";

      try {
        const classList = await loadClasses();
        setClasses(classList);

        if (classList.length > 0) {
          firstClassId = classList[0].id;
          setCreateLectureForm((prev) => ({ ...prev, classId: classList[0].id }));
          setFilterClassId(firstClassId);
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to load class options.");
      }

      // The deep-link effect handles loading when focusing a single lecture.
      if (!searchParams.get("focusLectureId")) {
        const now = new Date();
        const range = monthRange(now.getFullYear(), now.getMonth() + 1);
        setDateRange(range);
        await loadLectures(
          1,
          firstClassId,
          "",
          range.from,
          range.to,
          pageSize,
          sortOrder
        );
      }
    }

    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadClasses, loadLectures]);

  // Deep links from the calendar.
  const consumedDeepLink = useRef(false);

  // Focus a single lecture: ?focusLectureId=<id>
  const [focusLectureId, setFocusLectureId] = useState<string | null>(null);

  async function loadFocusLecture(lectureId: string) {
    setIsLoading(true);
    setErrorMessage(null);
    setFocusLectureId(lectureId);

    try {
      const response = await fetch(
        `/api/lectures?lectureId=${lectureId}&page=1&pageSize=1`
      );
      const payload = (await response.json()) as {
        success: boolean;
        data?: LectureItem[];
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load lecture."));
      }

      setLectures(payload.data ?? []);
      setPage(1);
      setTotalPages(1);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to load lecture."
      );
    } finally {
      setIsLoading(false);
    }
  }

  function clearFocusLecture() {
    setFocusLectureId(null);
    void loadLectures(1, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder);
  }

  useEffect(() => {
    if (consumedDeepLink.current) return;

    const focusId = searchParams.get("focusLectureId");
    if (focusId) {
      consumedDeepLink.current = true;
      void loadFocusLecture(focusId);
      router.replace(pathname);
      return;
    }

    // ?addLecture=1&classId=...&date=YYYY-MM-DDTHH:MM
    if (searchParams.get("addLecture") !== "1") return;
    if (classes.length === 0) return;

    consumedDeepLink.current = true;

    const requestedClassId = searchParams.get("classId") ?? "";
    const requestedDate = searchParams.get("date") ?? "";

    setCreateLectureForm({
      classId: classes.some((item) => item.id === requestedClassId)
        ? requestedClassId
        : classes[0]?.id ?? "",
      title: "",
      date: requestedDate,
    });
    setIsAddLecturePanelOpen(true);

    router.replace(pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes, searchParams, router, pathname]);

  async function withSubmitState(action: () => Promise<void>) {
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      await action();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function openLectureTab(lectureId: string, tab: LectureTab) {
    if (tab === "notes") {
      const lecture = lectures.find((item) => item.id === lectureId);

      if (lecture) {
        setNotePanelLecture({
          id: lecture.id,
          title: lecture.title,
          date: lecture.date,
          class: lecture.class,
        });
        setIsNotePanelOpen(true);
      }

      return;
    }

    if (tab === "assignments") {
      const lecture = lectures.find((item) => item.id === lectureId);

      if (lecture) {
        setAssignmentPanelLecture({
          id: lecture.id,
          title: lecture.title,
          date: lecture.date,
          class: lecture.class,
        });
        setIsAssignmentPanelOpen(true);
      }

      return;
    }

    if (tab === "quizzes") {
      const lecture = lectures.find((item) => item.id === lectureId);

      if (lecture) {
        setQuizPanelLecture({
          id: lecture.id,
          title: lecture.title,
          date: lecture.date,
          class: lecture.class,
        });
        setIsQuizPanelOpen(true);
      }

      return;
    }
  }

  async function handleCreateLecture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await withSubmitState(async () => {
      const response = await fetch("/api/lectures", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createLectureForm),
      });

      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to create lecture."));
      }

      setSuccessMessage("Lecture created successfully.");
      setCreateLectureForm((prev) => ({
        ...prev,
        title: "",
        date: "",
      }));
      setIsAddLecturePanelOpen(false);
      await loadLectures(1, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder);
    });
  }

  function openEditLecture(lecture: LectureItem) {
    setEditingLecture(lecture);
    setEditLectureForm({ title: lecture.title, date: toDateTimeLocal(lecture.date) });
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  function closeEditLecture() {
    setEditingLecture(null);
  }

  async function handleUpdateLecture() {
    if (!editingLecture) {
      return;
    }

    const nextTitle = editLectureForm.title.trim();
    if (!nextTitle || !editLectureForm.date) {
      setErrorMessage("Lecture title and date are required.");
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${editingLecture.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: nextTitle,
          date: new Date(editLectureForm.date).toISOString(),
        }),
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to update lecture."));
      }

      setSuccessMessage("Lecture updated successfully.");
      setEditingLecture(null);
      await loadLectures(page, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder);
    });
  }

  async function handleDeleteLecture(lecture: LectureItem) {
    const confirmed = window.confirm(`Delete lecture "${lecture.title}" and all linked materials?`);
    if (!confirmed) {
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lecture.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to delete lecture."));
      }

      setSuccessMessage("Lecture deleted successfully.");
      await loadLectures(page, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder);
    });
  }

  async function handleChangeClassStatus(lectureId: string, classStatus: "COMPLETED" | "CANCELLED") {
    setStatusMenuLectureId(null);
    setIsUpdatingStatus(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/lectures/${lectureId}/status`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ classStatus }),
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to update lecture status."));
      }

      setLectures((prev) =>
        prev.map((lecture) => (lecture.id === lectureId ? { ...lecture, classStatus } : lecture))
      );
      setSuccessMessage("Lecture status updated successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update lecture status.");
    } finally {
      setIsUpdatingStatus(false);
    }
  }

  async function loadRecordingsForLecture(lectureId: string) {
    setLoadingRecordingsFor((prev) => new Set(prev).add(lectureId));

    try {
      const response = await fetch(`/api/lectures/${lectureId}/recordings`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as { success: boolean; data?: RecordingItem[] };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load recordings."));
      }

      setRecordingsByLecture((prev) => ({ ...prev, [lectureId]: payload.data ?? [] }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load recordings.");
    } finally {
      setLoadingRecordingsFor((prev) => {
        const next = new Set(prev);
        next.delete(lectureId);
        return next;
      });
    }
  }

  function toggleRecordings(lectureId: string) {
    setExpandedRecordingIds((prev) => {
      const next = new Set(prev);

      if (next.has(lectureId)) {
        next.delete(lectureId);
      } else {
        next.add(lectureId);

        if (!recordingsByLecture[lectureId]) {
          void loadRecordingsForLecture(lectureId);
        }
      }

      return next;
    });
  }

  async function loadLivesForLecture(lectureId: string) {
    setLoadingLivesFor((prev) => new Set(prev).add(lectureId));

    try {
      const response = await fetch(`/api/lectures/${lectureId}/lives`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as { success: boolean; data?: LiveBroadcastItem[] };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load live streams."));
      }

      setLivesByLecture((prev) => ({ ...prev, [lectureId]: payload.data ?? [] }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load live streams.");
    } finally {
      setLoadingLivesFor((prev) => {
        const next = new Set(prev);
        next.delete(lectureId);
        return next;
      });
    }
  }

  function toggleLives(lectureId: string) {
    setExpandedLiveIds((prev) => {
      const next = new Set(prev);

      if (next.has(lectureId)) {
        next.delete(lectureId);
      } else {
        next.add(lectureId);

        if (!livesByLecture[lectureId]) {
          void loadLivesForLecture(lectureId);
        }
      }

      return next;
    });
  }

  async function handleChangeLivePrivacy(
    lectureId: string,
    liveId: string,
    privacy: "public" | "unlisted" | "private"
  ) {
    setUpdatingPrivacyFor((prev) => new Set(prev).add(liveId));
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/lectures/${lectureId}/lives/${liveId}/privacy`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ privacy }),
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to update live stream privacy."));
      }

      setLivesByLecture((prev) => ({
        ...prev,
        [lectureId]: (prev[lectureId] ?? []).map((live) =>
          live.id === liveId ? { ...live, privacy: privacy.toUpperCase() } : live
        ),
      }));
      setSuccessMessage("Live stream privacy updated successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update live stream privacy.");
    } finally {
      setUpdatingPrivacyFor((prev) => {
        const next = new Set(prev);
        next.delete(liveId);
        return next;
      });
    }
  }

  async function handleChangeRecordingAccess(
    lectureId: string,
    recordingId: string,
    updates: { visibility?: RecordingVisibility; access?: RecordingAccess }
  ) {
    setUpdatingRecordingFor((prev) => new Set(prev).add(recordingId));

    try {
      const response = await fetch(`/api/lectures/${lectureId}/recordings/${recordingId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updates),
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to update recording."));
      }

      setRecordingsByLecture((prev) => ({
        ...prev,
        [lectureId]: (prev[lectureId] ?? []).map((recording) =>
          recording.id === recordingId ? { ...recording, ...updates } : recording
        ),
      }));
      toast.success("Recording updated successfully.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update recording.");
    } finally {
      setUpdatingRecordingFor((prev) => {
        const next = new Set(prev);
        next.delete(recordingId);
        return next;
      });
    }
  }

  async function loadSessionsForLecture(lectureId: string) {
    setLoadingSessionsFor((prev) => new Set(prev).add(lectureId));

    try {
      const response = await fetch(`/api/lectures/${lectureId}/sessions`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as { success: boolean; data?: LectureSessionItem[] };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load sessions."));
      }

      setSessionsByLecture((prev) => ({ ...prev, [lectureId]: payload.data ?? [] }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load sessions.");
    } finally {
      setLoadingSessionsFor((prev) => {
        const next = new Set(prev);
        next.delete(lectureId);
        return next;
      });
    }
  }

  function toggleSessions(lectureId: string) {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev);

      if (next.has(lectureId)) {
        next.delete(lectureId);
      } else {
        next.add(lectureId);

        if (!sessionsByLecture[lectureId]) {
          void loadSessionsForLecture(lectureId);
        }
      }

      return next;
    });
  }

  async function handleCreateSession(lectureId: string) {
    setCreatingSessionFor((prev) => new Set(prev).add(lectureId));

    try {
      const response = await fetch(`/api/lectures/${lectureId}/sessions`, {
        method: "POST",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to create session."));
      }

      toast.success("New session created for this lecture.");
      await loadSessionsForLecture(lectureId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create session.");
    } finally {
      setCreatingSessionFor((prev) => {
        const next = new Set(prev);
        next.delete(lectureId);
        return next;
      });
    }
  }

  function handleJoinSession(sessionId: string) {
    window.open(
      `/session/join?sessionId=${sessionId}&role=teacher`,
      "_blank",
      "noopener,noreferrer"
    );
  }

  async function handleEndSession(sessionId: string, lectureId: string) {
    setEndSessionConfirm(null);
    setEndingSessionFor((prev) => new Set(prev).add(sessionId));

    try {
      const response = await fetch(`/api/sessions/${sessionId}/end`, {
        method: "POST",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to end session."));
      }

      toast.success("Live session ended.");
      await loadSessionsForLecture(lectureId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to end session.");
    } finally {
      setEndingSessionFor((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function loadAttendanceForSession(sessionId: string) {
    setLoadingAttendanceFor((prev) => new Set(prev).add(sessionId));

    try {
      const response = await fetch(`/api/sessions/${sessionId}/attendance`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          joinedStudents: { student: SessionAttendanceStudent; logs: SessionAttendanceLog[] }[];
          notJoinedStudents: SessionAttendanceStudent[];
        };
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to load attendance."));
      }

      setAttendanceBySession((prev) => ({
        ...prev,
        [sessionId]: {
          present: payload.data!.joinedStudents.map((entry) => ({
            student: entry.student,
            logs: entry.logs,
          })),
          absent: payload.data!.notJoinedStudents,
        },
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load attendance.");
    } finally {
      setLoadingAttendanceFor((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  function toggleAttendancePopover(sessionId: string) {
    setAttendancePopoverSessionId((prev) => {
      if (prev === sessionId) {
        return null;
      }

      if (!attendanceBySession[sessionId]) {
        void loadAttendanceForSession(sessionId);
      }

      return sessionId;
    });
  }

  const currentYear = new Date().getFullYear();
  const yearOptions = [
    currentYear - 3,
    currentYear - 2,
    currentYear - 1,
    currentYear,
    currentYear + 1,
    currentYear + 2,
  ];

  return (
    <section className="space-y-4">
      <article className="relative space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
              <FileText size={18} />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">Lectures</h2>
              <p className="text-xs text-slate-500">Create lectures, manage files, assignments, and quizzes.</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:border-brand-200 hover:bg-brand-50"
            >
              <CircleHelp size={13} />
              Help
            </button>
            <button
              type="button"
              onClick={() => setIsAddLecturePanelOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-600"
            >
              <Plus size={13} />
              Add lecture
            </button>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">

          {/* Class · Year · Month tile pickers */}
          <div className="grid gap-2.5 lg:grid-cols-[1.2fr_0.8fr_1.5fr]">
            <div>
              <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                <GraduationCap size={11} />
                Class
              </p>
              <div className="scrollbar-thin max-h-[120px] space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-1">
                <button
                  type="button"
                  onClick={() => selectFilterClass("")}
                  className={`${filterTileClass(filterClassId === "")} block w-full shrink-0 text-left`}
                >
                  All classes
                </button>
                {classes.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.name}
                    onClick={() => selectFilterClass(item.id)}
                    className={`${filterTileClass(filterClassId === item.id)} block w-full shrink-0 truncate text-left`}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                <Calendar size={11} />
                Year
              </p>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-slate-200 bg-white p-1">
                {yearOptions.map((year) => (
                  <button
                    key={year}
                    type="button"
                    onClick={() => selectFilterYear(year)}
                    className={filterTileClass(periodMode === "period" && filterYear === year)}
                  >
                    {year}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                <CalendarClock size={11} />
                Month
              </p>
              <div className="grid grid-cols-6 gap-1 rounded-md border border-slate-200 bg-white p-1">
                {MONTH_LABELS.map((label, index) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => selectFilterMonth(index + 1)}
                    className={filterTileClass(periodMode === "period" && filterMonth === index + 1)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Quick ranges */}
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Quick range
            </p>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={clearPeriodFilter}
                className={quickPillClass(periodMode === "all")}
              >
                All dates
              </button>
              {QUICK_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => selectQuickRange(option.value)}
                  className={quickPillClass(periodMode === "quick" && datePreset === option.value)}
                >
                  {option.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setPeriodMode("custom");
                  setDatePreset("custom");
                  setFilterMonth(null);
                }}
                className={quickPillClass(periodMode === "custom")}
              >
                Custom range
              </button>
            </div>
          </div>

          {periodMode === "custom" ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <div className="relative">
                <Calendar size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="date"
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                  className="control-input h-8 pl-8 text-xs"
                />
              </div>
              <div className="relative">
                <Calendar size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="date"
                  value={customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                  className="control-input h-8 pl-8 text-xs"
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  runLoad({
                    from: customFrom ? startOfDay(new Date(customFrom)) : undefined,
                    to: customTo ? endOfDay(new Date(customTo)) : undefined,
                  })
                }
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white transition hover:bg-blue-600"
              >
                <Filter size={12} />
                Apply range
              </button>
            </div>
          ) : null}

          {/* Search */}
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[1fr_auto]">
            <div className="relative">
              <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    setAppliedSearch(searchText);
                    void loadLectures(1, filterClassId, searchText, dateRange.from, dateRange.to, pageSize, sortOrder);
                  }
                }}
                placeholder="Search lectures... (press Enter)"
                className="control-input h-8 pl-7 text-xs"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setAppliedSearch(searchText);
                void loadLectures(1, filterClassId, searchText, dateRange.from, dateRange.to, pageSize, sortOrder);
              }}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              <Filter size={11} />
              Apply
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="rounded-md bg-brand-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-brand-700">
            Sort By
          </span>
          <button
            type="button"
            onClick={() => {
              const nextOrder = sortOrder === "desc" ? "asc" : "desc";
              setSortOrder(nextOrder);
              void loadLectures(1, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, nextOrder);
            }}
            className="inline-flex items-center gap-1 rounded-lg bg-brand-700 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition-all"
          >
            Lecture Date
            {sortOrder === "asc" ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>

        {errorMessage && !editingLecture ? (
          <p className="notice-error">{errorMessage}</p>
        ) : null}

        {successMessage ? (
          <p className="notice-success">
            {successMessage}
          </p>
        ) : null}

        {focusLectureId ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
            <p className="text-xs font-semibold text-brand-700">
              Showing 1 lecture opened from the calendar
            </p>
            <button
              type="button"
              onClick={clearFocusLecture}
              className="rounded-md border border-brand-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-brand-700 transition hover:bg-brand-100"
            >
              Show all lectures
            </button>
          </div>
        ) : null}

        {isLoading ? (
          <div className="space-y-2.5">
            {Array.from({ length: pageSize }).map((_, index) => (
              <LectureCardSkeleton key={index} />
            ))}
          </div>
        ) : null}

        {!isLoading && lectures.length === 0 ? (
          <p className="text-xs text-muted">No lectures found for selected criteria.</p>
        ) : null}

        {!isLoading ? (
        <div className="space-y-2.5">
          {lectures.map((lecture) => {
            const statusMeta = CLASS_STATUS_META[lecture.classStatus];
            const isFocused = lecture.id === focusLectureId;

            return (
              <div
                key={lecture.id}
                className={`rounded-lg border bg-white p-3.5 shadow-sm transition ${
                  isFocused
                    ? "border-brand-500 ring-2 ring-brand-200"
                    : "border-slate-200 hover:border-brand-200"
                }`}
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex gap-3">
                    <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                      <FileText size={18} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold tracking-tight text-slate-900">{lecture.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                        <span className="inline-flex items-center gap-1"><Calendar size={11} />{new Date(lecture.date).toLocaleDateString()}</span>
                        <span className="inline-flex items-center gap-1"><Clock3 size={11} />{new Date(lecture.date).toLocaleTimeString()}</span>
                        <span className="inline-flex items-center gap-1"><GraduationCap size={11} />{lecture.class.name}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted">{lecture.class.schedule}</p>

                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => void openLectureTab(lecture.id, "notes")}
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                            isNotePanelOpen && notePanelLecture?.id === lecture.id
                              ? "border-brand-700 bg-brand-700 text-white"
                              : "border-brand-100 bg-white text-slate-700"
                          }`}
                        >
                          <FileText size={10} />
                          Notes {lecture._count.notes}
                        </button>
                        <button
                          type="button"
                          onClick={() => void openLectureTab(lecture.id, "assignments")}
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                            isAssignmentPanelOpen && assignmentPanelLecture?.id === lecture.id
                              ? "border-brand-700 bg-brand-700 text-white"
                              : "border-brand-100 bg-white text-slate-700"
                          }`}
                        >
                          Assignments {lecture._count.assignments}
                        </button>
                        <button
                          type="button"
                          onClick={() => void openLectureTab(lecture.id, "quizzes")}
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                            isQuizPanelOpen && quizPanelLecture?.id === lecture.id
                              ? "border-brand-700 bg-brand-700 text-white"
                              : "border-brand-100 bg-white text-slate-700"
                          }`}
                        >
                          Quizzes {lecture._count.quizzes}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-row items-center justify-between gap-2 lg:flex-col lg:items-end">
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() =>
                          setStatusMenuLectureId((prev) => (prev === lecture.id ? null : lecture.id))
                        }
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition hover:opacity-80 ${statusMeta.tone}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${statusMeta.dot} ${
                            lecture.classStatus === "LIVE" ? "animate-pulse" : ""
                          }`}
                        />
                        {statusMeta.label}
                        <ChevronDown size={10} />
                      </button>

                      {statusMenuLectureId === lecture.id ? (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setStatusMenuLectureId(null)} />
                          <div className="absolute right-0 top-full z-50 mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                            <button
                              type="button"
                              disabled={isUpdatingStatus}
                              onClick={() => void handleChangeClassStatus(lecture.id, "COMPLETED")}
                              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-slate-700 transition hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                              Mark Completed
                            </button>
                            <button
                              type="button"
                              disabled={isUpdatingStatus}
                              onClick={() => void handleChangeClassStatus(lecture.id, "CANCELLED")}
                              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-slate-700 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-rose-600" />
                              Mark Cancelled
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => toggleRecordings(lecture.id)}
                        className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition ${
                          expandedRecordingIds.has(lecture.id)
                            ? "border-brand-700 bg-brand-700 text-white"
                            : "border-slate-200 text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <Video size={11} />
                        Recordings
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleLives(lecture.id)}
                        className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition ${
                          expandedLiveIds.has(lecture.id)
                            ? "border-brand-700 bg-brand-700 text-white"
                            : "border-slate-200 text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <Radio size={11} />
                        Live Streams
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleSessions(lecture.id)}
                        className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition ${
                          expandedSessionIds.has(lecture.id)
                            ? "border-brand-700 bg-brand-700 text-white"
                            : "border-slate-200 text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <CalendarClock size={11} />
                        Sessions
                      </button>
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => openEditLecture(lecture)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <SquarePen size={11} />
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => void handleDeleteLecture(lecture)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-200 px-2 text-[11px] font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Trash2 size={11} />
                        Delete
                      </button>
                    </div>
                  </div>
                </div>

                {expandedRecordingIds.has(lecture.id) ? (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <Video size={12} />
                      Recordings
                    </p>

                    {loadingRecordingsFor.has(lecture.id) ? (
                      <p className="mt-2 text-xs text-muted">Loading recordings...</p>
                    ) : (recordingsByLecture[lecture.id]?.length ?? 0) === 0 ? (
                      <p className="mt-2 text-xs text-muted">No recordings available for this lecture yet.</p>
                    ) : (
                      <div className="mt-2 space-y-1.5">
                        {(recordingsByLecture[lecture.id] ?? []).map((recording) => (
                          <div
                            key={recording.id}
                            className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <button
                              type="button"
                              onClick={() => setPlayingRecording(recording)}
                              className="flex min-w-0 items-center gap-2 text-left"
                            >
                              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white">
                                <Play size={12} />
                              </span>
                              <div className="min-w-0">
                                <p className="flex items-center gap-1 text-[11px] font-medium text-slate-700">
                                  <Calendar size={10} />
                                  Started {recording.startedAt ? new Date(recording.startedAt).toLocaleString() : "—"}
                                </p>
                                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                                  <Clock3 size={10} />
                                  Ended {recording.endedAt ? new Date(recording.endedAt).toLocaleString() : "In progress"}
                                </p>
                              </div>
                            </button>

                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500 shadow-sm">
                                {recording.status}
                              </span>
                              <div className="relative shrink-0">
                                <select
                                  value={recording.visibility}
                                  disabled={updatingRecordingFor.has(recording.id)}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) =>
                                    void handleChangeRecordingAccess(lecture.id, recording.id, {
                                      visibility: event.target.value as RecordingVisibility,
                                    })
                                  }
                                  className="w-[92px] appearance-none rounded-md border border-slate-200 bg-white py-1.5 pl-2 pr-6 text-[11px] leading-none font-medium text-slate-700 shadow-sm transition hover:border-brand-300 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {VISIBILITY_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown size={11} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
                              </div>
                              <div className="relative shrink-0">
                                <select
                                  value={recording.access}
                                  disabled={updatingRecordingFor.has(recording.id)}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) =>
                                    void handleChangeRecordingAccess(lecture.id, recording.id, {
                                      access: event.target.value as RecordingAccess,
                                    })
                                  }
                                  className="w-[84px] appearance-none rounded-md border border-slate-200 bg-white py-1.5 pl-2 pr-6 text-[11px] leading-none font-medium text-slate-700 shadow-sm transition hover:border-brand-300 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {ACCESS_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown size={11} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}

                {expandedLiveIds.has(lecture.id) ? (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <Radio size={12} />
                      Live Streams
                    </p>

                    {loadingLivesFor.has(lecture.id) ? (
                      <p className="mt-2 text-xs text-muted">Loading live streams...</p>
                    ) : (livesByLecture[lecture.id]?.length ?? 0) === 0 ? (
                      <p className="mt-2 text-xs text-muted">No YouTube live streams for this lecture yet.</p>
                    ) : (
                      <div className="mt-2 space-y-1.5">
                        {(livesByLecture[lecture.id] ?? []).map((live) => (
                          <div
                            key={live.id}
                            className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <button
                              type="button"
                              onClick={() => setPlayingRecording(live)}
                              className="flex min-w-0 items-center gap-2 text-left"
                            >
                              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-600 text-white">
                                <Play size={12} />
                              </span>
                              <div className="min-w-0">
                                <p className="flex items-center gap-1 text-[11px] font-medium text-slate-700">
                                  <Calendar size={10} />
                                  Started {live.startedAt ? new Date(live.startedAt).toLocaleString() : "—"}
                                </p>
                                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                                  <Clock3 size={10} />
                                  Ended {live.endedAt ? new Date(live.endedAt).toLocaleString() : "In progress"}
                                </p>
                              </div>
                            </button>

                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500 shadow-sm">
                                {live.status}
                              </span>
                              <div className="relative shrink-0">
                                <select
                                  value={live.privacy.toLowerCase()}
                                  disabled={updatingPrivacyFor.has(live.id)}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) =>
                                    void handleChangeLivePrivacy(
                                      lecture.id,
                                      live.id,
                                      event.target.value as "public" | "unlisted" | "private"
                                    )
                                  }
                                  className="w-[92px] appearance-none rounded-md border border-slate-200 bg-white py-1.5 pl-2 pr-6 text-[11px] leading-none font-medium text-slate-700 shadow-sm transition hover:border-brand-300 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {PRIVACY_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown size={11} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}

                {expandedSessionIds.has(lecture.id) ? (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        <CalendarClock size={12} />
                        Live Sessions
                      </p>
                      <button
                        type="button"
                        disabled={creatingSessionFor.has(lecture.id)}
                        onClick={() => void handleCreateSession(lecture.id)}
                        className="inline-flex h-7 items-center gap-1 rounded-md bg-brand-700 px-2 text-[11px] font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <CalendarPlus size={11} />
                        {creatingSessionFor.has(lecture.id) ? "Creating..." : "New session"}
                      </button>
                    </div>

                    {loadingSessionsFor.has(lecture.id) ? (
                      <p className="mt-2 text-xs text-muted">Loading sessions...</p>
                    ) : (sessionsByLecture[lecture.id]?.length ?? 0) === 0 ? (
                      <p className="mt-2 text-xs text-muted">No live sessions run for this lecture yet.</p>
                    ) : (
                      <div className="mt-2 space-y-1.5">
                        {(sessionsByLecture[lecture.id] ?? []).map((sessionItem) => {
                          const attendance = attendanceBySession[sessionItem.id];
                          const isPopoverOpen = attendancePopoverSessionId === sessionItem.id;

                          return (
                            <div
                              key={sessionItem.id}
                              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5"
                            >
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex min-w-0 items-center gap-3">
                                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
                                    <MonitorPlay size={20} />
                                  </span>
                                  <div className="min-w-0">
                                    <p className="flex items-center gap-1 text-[11px] font-semibold text-slate-700">
                                      <Calendar size={10} />
                                      Started {new Date(sessionItem.startedAt).toLocaleString()}
                                    </p>
                                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                                      <Clock3 size={10} />
                                      {sessionItem.endedAt
                                        ? `Ended ${new Date(sessionItem.endedAt).toLocaleString()}`
                                        : "In progress"}
                                    </p>
                                    <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                                      Room {sessionItem.roomName}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                                  {sessionItem.isActive ? (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => handleJoinSession(sessionItem.id)}
                                        className="inline-flex h-7 items-center gap-1 rounded-md bg-brand-700 px-2 text-[11px] font-semibold text-white transition hover:bg-brand-600"
                                      >
                                        <Video size={11} />
                                        Join
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setEndSessionConfirm({
                                            sessionId: sessionItem.id,
                                            lectureId: lecture.id,
                                            roomName: sessionItem.roomName,
                                          })
                                        }
                                        disabled={endingSessionFor.has(sessionItem.id)}
                                        className="inline-flex h-7 items-center gap-1 rounded-md border border-red-300 px-2 text-[11px] font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                                      >
                                        <X size={11} />
                                        {endingSessionFor.has(sessionItem.id) ? "Ending..." : "End session"}
                                      </button>
                                    </>
                                  ) : null}

                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                      sessionItem.isActive
                                        ? "bg-emerald-100 text-emerald-700"
                                        : "bg-slate-200 text-slate-600"
                                    }`}
                                  >
                                    {sessionItem.isActive ? "Live" : "Ended"}
                                  </span>

                                  <div className="relative">
                                    <button
                                      type="button"
                                      onClick={() => toggleAttendancePopover(sessionItem.id)}
                                      className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition ${
                                        isPopoverOpen
                                          ? "border-brand-700 bg-brand-700 text-white"
                                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                      }`}
                                    >
                                      <Users size={11} />
                                      Attendance {sessionItem._count.attendance}
                                    </button>

                                    {isPopoverOpen ? (
                                      <>
                                        <div
                                          className="fixed inset-0 z-40"
                                          onClick={() => setAttendancePopoverSessionId(null)}
                                        />
                                        <div className="absolute right-0 top-full z-50 mt-1 max-h-80 w-72 overflow-y-auto scrollbar-thin rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
                                          {loadingAttendanceFor.has(sessionItem.id) || !attendance ? (
                                            <p className="text-xs text-muted">Loading attendance...</p>
                                          ) : (
                                            <div className="space-y-3">
                                              <div>
                                                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                                                  <UserCheck size={12} />
                                                  Present ({attendance.present.length})
                                                </p>
                                                {attendance.present.length === 0 ? (
                                                  <p className="mt-1 text-[11px] text-muted">No students joined.</p>
                                                ) : (
                                                  <ul className="mt-1.5 space-y-1.5">
                                                    {attendance.present.map((entry) => (
                                                      <li
                                                        key={entry.student.id}
                                                        className="rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5"
                                                      >
                                                        <p className="text-[12px] font-semibold text-emerald-800">
                                                          {entry.student.name}
                                                        </p>
                                                        <div className="mt-0.5 space-y-0.5">
                                                          {entry.logs.map((log) => (
                                                            <p
                                                              key={log.id}
                                                              className="text-[10px] text-emerald-700"
                                                            >
                                                              In {new Date(log.joinedAt).toLocaleTimeString()}
                                                              {" · "}
                                                              Out{" "}
                                                              {log.leftAt
                                                                ? new Date(log.leftAt).toLocaleTimeString()
                                                                : "—"}
                                                            </p>
                                                          ))}
                                                        </div>
                                                      </li>
                                                    ))}
                                                  </ul>
                                                )}
                                              </div>

                                              <div>
                                                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
                                                  <UserX size={12} />
                                                  Absent ({attendance.absent.length})
                                                </p>
                                                {attendance.absent.length === 0 ? (
                                                  <p className="mt-1 text-[11px] text-muted">Everyone joined.</p>
                                                ) : (
                                                  <ul className="mt-1.5 space-y-1">
                                                    {attendance.absent.map((student) => (
                                                      <li
                                                        key={student.id}
                                                        className="rounded-md border border-rose-100 bg-rose-50 px-2 py-1 text-[12px] font-medium text-rose-800"
                                                      >
                                                        {student.name}
                                                      </li>
                                                    ))}
                                                  </ul>
                                                )}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}

              </div>
            );
          })}
        </div>
        ) : null}

        <div className="flex flex-col gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <select
                value={pageSize}
                onChange={(event) => {
                  const nextSize = Number(event.target.value);
                  setPageSize(nextSize);
                  void loadLectures(1, filterClassId, appliedSearch, dateRange.from, dateRange.to, nextSize, sortOrder);
                }}
                className="appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-7 text-xs font-medium text-slate-700 shadow-sm transition hover:border-brand-300 focus:border-brand-500 focus:outline-none"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size} / Page
                  </option>
                ))}
              </select>
              <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>

            <span className="hidden text-xs text-slate-500 sm:block">
              Page <strong>{page}</strong> of <strong>{totalPages}</strong>
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1 || isLoading}
              onClick={() => void loadLectures(1, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronsLeft size={14} />
            </button>
            <button
              type="button"
              disabled={page <= 1 || isLoading}
              onClick={() => void loadLectures(page - 1, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={14} />
            </button>

            <div className="max-w-[220px] overflow-x-auto scrollbar-thin">
              <div className="flex gap-1.5 px-0.5">
                {Array.from({ length: totalPages }, (_, index) => index + 1).map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={isLoading}
                    onClick={() => void loadLectures(p, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder)}
                    className={`flex h-8 min-w-[32px] items-center justify-center rounded-lg border text-xs font-semibold transition-all duration-200 ${
                      p === page
                        ? "border-brand-700 bg-brand-700 text-white shadow"
                        : "border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:bg-brand-50"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={page >= totalPages || isLoading}
              onClick={() => void loadLectures(page + 1, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight size={14} />
            </button>
            <button
              type="button"
              disabled={page >= totalPages || isLoading}
              onClick={() => void loadLectures(totalPages, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronsRight size={14} />
            </button>
          </div>
        </div>
      </article>

      {endSessionConfirm ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start gap-3 p-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
                <AlertTriangle size={18} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-900">
                  End this live session?
                </h3>
                <p className="mt-1 text-[12px] leading-5 text-slate-500">
                  Students in{" "}
                  <span className="font-medium text-slate-700">
                    {endSessionConfirm.roomName}
                  </span>{" "}
                  will be disconnected and the session will be marked as ended.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
              <button
                type="button"
                onClick={() => setEndSessionConfirm(null)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  void handleEndSession(
                    endSessionConfirm.sessionId,
                    endSessionConfirm.lectureId
                  )
                }
                className="rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-red-700"
              >
                End session
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isAddLecturePanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsAddLecturePanelOpen(false)}
        aria-hidden
      />

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isQuizPanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsQuizPanelOpen(false)}
        aria-hidden
      />

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isAssignmentPanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsAssignmentPanelOpen(false)}
        aria-hidden
      />

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isNotePanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsNotePanelOpen(false)}
        aria-hidden
      />

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          editingLecture ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={closeEditLecture}
        aria-hidden
      />

      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-brand-100 bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
          editingLecture ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!editingLecture}
      >
        <div className="shrink-0 border-b border-brand-200 bg-white/90 px-5 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
                <SquarePen size={16} />
              </span>
              <div>
                <h2 className="text-base font-semibold text-slate-900">Edit lecture</h2>
                <p className="mt-0.5 text-xs text-muted">Update the title and scheduled date.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={closeEditLecture}
              className="btn-ghost shrink-0"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto scrollbar-thin px-5 py-4">
          {errorMessage && editingLecture ? <p className="notice-error text-xs">{errorMessage}</p> : null}

          <div className="space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-sm">
            <label className="form-label mb-1 block">Lecture title</label>
            <div className="relative">
              <FileText size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={editLectureForm.title}
                onChange={(event) => setEditLectureForm((prev) => ({ ...prev, title: event.target.value }))}
                placeholder="Lecture title"
                className="control-input h-9 pl-9 text-sm"
              />
            </div>
          </div>

          <div className="space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-sm">
            <label className="form-label mb-1 block">Date &amp; time</label>
            <div className="relative">
              <Calendar size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="datetime-local"
                value={editLectureForm.date}
                onChange={(event) => setEditLectureForm((prev) => ({ ...prev, date: event.target.value }))}
                className="control-input h-9 pl-9 text-sm"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleUpdateLecture()}
            disabled={isSubmitting}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand-700 text-xs font-semibold text-white shadow-soft transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save size={13} />
            {isSubmitting ? "Saving..." : "Save changes"}
          </button>
        </div>
      </aside>

      {playingRecording ? (
        <>
          <div className="fixed inset-0 z-[70] bg-black/70" onClick={() => setPlayingRecording(null)} aria-hidden />
          <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
            <div
              className="w-full max-w-3xl rounded-xl border border-slate-200 bg-black shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
                <p className="flex items-center gap-1.5 text-xs font-medium text-white">
                  <Video size={13} />
                  Lecture recording
                </p>
                <button
                  type="button"
                  onClick={() => setPlayingRecording(null)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="aspect-video w-full">
                <iframe
                  key={playingRecording.id}
                  title="Lecture recording"
                  src={`https://www.youtube.com/embed/${playingRecording.videoId}?autoplay=1`}
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>
          </div>
        </>
      ) : null}

      {isHelpOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-3xl rounded-3xl border border-brand-100 bg-white/95 p-6 shadow-panel backdrop-blur">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">About This Page</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900">Lecture Management</h2>
                <p className="mt-2 text-sm text-muted">
                  Manage lectures, files, assignments, and quizzes. Create lectures with dates, upload notes and supporting materials, and add assignments and quizzes for each lecture.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="btn-secondary px-3 py-1.5 text-xs"
              >
                Close
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-4 shadow-soft">
                <p className="text-sm font-semibold text-slate-900">What you can do here</p>
                <ul className="mt-2 space-y-2 text-sm text-muted">
                  <li>Create and schedule lectures for each class.</li>
                  <li>Upload notes and supporting materials for students.</li>
                  <li>Add and manage assignments linked to each lecture.</li>
                  <li>Create quizzes and manage lecture learning content in one place.</li>
                </ul>
              </div>

              <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-4 shadow-soft">
                <p className="text-sm font-semibold text-slate-900">How to use this page</p>
                <ul className="mt-2 space-y-2 text-sm text-muted">
                  <li>Use the class filter and search to find lectures quickly.</li>
                  <li>Use Add lecture to create a new scheduled lecture.</li>
                  <li>Open Notes, Assignments, or Quizzes from each lecture card.</li>
                  <li>Keep everything for a lecture organized under one record.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-brand-100 bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
          isAddLecturePanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isAddLecturePanelOpen}
      >
        <div className="shrink-0 border-b border-brand-200 bg-white/90 px-5 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
                <FileText size={16} />
              </span>
              <div>
                <h2 className="text-base font-semibold text-slate-900">Add lecture</h2>
                <p className="mt-0.5 text-xs text-muted">Create lecture entries with class and schedule date.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsAddLecturePanelOpen(false)}
              className="btn-ghost shrink-0"
            >
              Close
            </button>
          </div>
        </div>

        <form className="flex-1 space-y-3 overflow-y-auto scrollbar-thin px-5 py-4" onSubmit={handleCreateLecture}>
          <div className="space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-sm">
            <label className="form-label mb-1 block">Class</label>
            <div className="relative">
              <GraduationCap size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <ChevronDown size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <select
                value={createLectureForm.classId}
                onChange={(event) => setCreateLectureForm((prev) => ({ ...prev, classId: event.target.value }))}
                className="control-select h-9 w-full appearance-none pl-9 pr-8 text-sm"
              >
                <option value="">Select class</option>
                {classes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.schedule})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-sm">
            <label className="form-label mb-1 block">Lecture title</label>
            <div className="relative">
              <FileText size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={createLectureForm.title}
                onChange={(event) => setCreateLectureForm((prev) => ({ ...prev, title: event.target.value }))}
                placeholder="Lecture title"
                className="control-input h-9 pl-9 text-sm"
              />
            </div>
          </div>

          <div className="space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-sm">
            <label className="form-label mb-1 block">Date &amp; time</label>
            <div className="relative">
              <Calendar size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="datetime-local"
                value={createLectureForm.date}
                onChange={(event) => setCreateLectureForm((prev) => ({ ...prev, date: event.target.value }))}
                className="control-input h-9 pl-9 text-sm"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting || !createLectureForm.classId || !createLectureForm.title || !createLectureForm.date}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-700 py-2 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus size={14} />
            {isSubmitting ? "Saving..." : "Add lecture"}
          </button>
        </form>
      </aside>

      <aside
        className={`fixed inset-0 z-50 transform overflow-y-auto scrollbar-thin bg-white shadow-2xl transition-transform duration-200 lg:left-auto lg:w-1/2 lg:min-w-[480px] lg:border-l lg:border-brand-100 ${
          isQuizPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isQuizPanelOpen}
      >
        <div className="sticky top-0 z-10 border-b border-brand-100 bg-white/95 px-4 py-2.5 backdrop-blur sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                <FileText size={15} />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Lecture quizzes</h2>
                {quizPanelLecture ? (
                  <p className="text-[11px] text-muted">
                    {quizPanelLecture.title} • {quizPanelLecture.class.name} • {new Date(quizPanelLecture.date).toLocaleString()}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted">Select a lecture card and open Quizzes to manage quiz content.</p>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsQuizPanelOpen(false)}
              className="btn-secondary shrink-0"
            >
              Close
            </button>
          </div>
        </div>

        <div className="px-4 pb-5 pt-3 sm:px-6">
          {quizPanelLecture ? (
            <LectureQuizPanel lectureId={quizPanelLecture.id} onChanged={() => loadLectures(page, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder)} />
          ) : null}
        </div>
      </aside>

      <aside
        className={`fixed inset-0 z-50 transform overflow-y-auto scrollbar-thin bg-white shadow-2xl transition-transform duration-200 lg:left-auto lg:w-1/2 lg:min-w-[480px] lg:border-l lg:border-brand-100 ${
          isAssignmentPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isAssignmentPanelOpen}
      >
        <div className="sticky top-0 z-10 border-b border-brand-100 bg-white/95 px-4 py-2.5 backdrop-blur sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                <FileText size={15} />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Lecture assignments</h2>
                {assignmentPanelLecture ? (
                  <p className="text-[11px] text-muted">
                    {assignmentPanelLecture.title} • {assignmentPanelLecture.class.name} • {new Date(assignmentPanelLecture.date).toLocaleString()}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted">Select a lecture card and open Assignments to manage assignment content.</p>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsAssignmentPanelOpen(false)}
              className="btn-secondary shrink-0"
            >
              Close
            </button>
          </div>
        </div>

        <div className="px-4 pb-5 pt-3 sm:px-6">
          {assignmentPanelLecture ? (
            <LectureAssignmentPanel
              lectureId={assignmentPanelLecture.id}
              onChanged={() => loadLectures(page, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder)}
            />
          ) : null}
        </div>
      </aside>

      <aside
        className={`fixed inset-0 z-50 transform overflow-y-auto scrollbar-thin bg-white shadow-2xl transition-transform duration-200 lg:left-auto lg:w-1/2 lg:min-w-[480px] lg:border-l lg:border-brand-100 ${
          isNotePanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isNotePanelOpen}
      >
        <div className="sticky top-0 z-10 border-b border-brand-100 bg-white/95 px-4 py-2.5 backdrop-blur sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                <FileText size={15} />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Lecture notes</h2>
                {notePanelLecture ? (
                  <p className="text-[11px] text-muted">
                    {notePanelLecture.title} • {notePanelLecture.class.name} • {new Date(notePanelLecture.date).toLocaleString()}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted">Select a lecture card and open Notes to manage files.</p>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsNotePanelOpen(false)}
              className="btn-secondary shrink-0"
            >
              Close
            </button>
          </div>
        </div>

        <div className="px-4 pb-5 pt-3 sm:px-6">
          {notePanelLecture ? (
            <LectureNotePanel lectureId={notePanelLecture.id} onChanged={() => loadLectures(page, filterClassId, appliedSearch, dateRange.from, dateRange.to, pageSize, sortOrder)} />
          ) : null}
        </div>
      </aside>
    </section>
  );
}
