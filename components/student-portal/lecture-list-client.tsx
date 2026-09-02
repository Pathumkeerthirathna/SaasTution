"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  BookOpenText,
  FileText,
  ClipboardList,
  Video,
  Play,
  X,
  ChevronDown,
  Download,
  Eye,
  Maximize2,
  CalendarClock,
  CalendarDays,
  Clock,
  CalendarPlus,
} from "lucide-react";

import { AssignmentSubmitButton } from "@/components/student-portal/assignment-submit-button";
import { dashRangeToYmd } from "@/lib/dashboard-range";

type ClassOption = { id: string; name: string };

type LectureListItem = {
  kind: "lecture";
  id: string;
  title: string;
  date: string;
  className: string;
  classId: string;
  startTime: string | null;
  endTime: string | null;
  noteCount: number;
  unviewedNoteCount: number;
  assignmentCount: number;
  recordingCount: number;
  attended: boolean;
};

type ScheduleListItem = {
  kind: "schedule";
  id: string;
  date: string;
  className: string;
  classId: string;
  startTime: string;
  endTime: string;
};

type ListItem = LectureListItem | ScheduleListItem;

type NoteItem = {
  id: string;
  title: string;
  kind: "NOTE" | "SUPPORTING_MATERIAL";
  mimeType: string;
  sizeBytes: number;
};

type AssignmentItem = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string;
  submission: {
    id: string;
    notes: string | null;
    fileName: string;
    fileUrl: string;
    mimeType: string;
    sizeBytes: number;
    submittedAt: string;
  } | null;
};

type RecordingItem = {
  id: string;
  videoId: string;
  youtubeUrl: string;
  status: string;
  access: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

type LectureDetail = {
  id: string;
  title: string;
  date: string;
  className: string;
  classId: string;
  notes: NoteItem[];
  assignments: AssignmentItem[];
  recordings: RecordingItem[];
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };
type ListData = { items: ListItem[]; enrolledClasses: ClassOption[]; pagination: Pagination };

type Preset = "all" | "today" | "yesterday" | "tomorrow" | "week" | "lastweek" | "month" | "custom";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "week", label: "This week" },
  { value: "lastweek", label: "Last week" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom" },
];

function toYmd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function computeRange(preset: Preset, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (preset) {
    case "all":
      return { from: "", to: "" };
    case "today":
      return { from: toYmd(startOfToday), to: toYmd(startOfToday) };
    case "yesterday": {
      const y = new Date(startOfToday);
      y.setDate(y.getDate() - 1);
      return { from: toYmd(y), to: toYmd(y) };
    }
    case "tomorrow": {
      const t = new Date(startOfToday);
      t.setDate(t.getDate() + 1);
      return { from: toYmd(t), to: toYmd(t) };
    }
    case "week": {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - start.getDay());
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { from: toYmd(start), to: toYmd(end) };
    }
    case "lastweek": {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - start.getDay() - 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { from: toYmd(start), to: toYmd(end) };
    }
    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { from: toYmd(start), to: toYmd(end) };
    }
    case "custom":
      return { from: customFrom, to: customTo };
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLectureDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatTime12h(value: string | null) {
  if (!value) return "";
  const [hRaw, mRaw] = value.split(":");
  const hour = Number(hRaw);
  if (Number.isNaN(hour)) return value;
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${(mRaw ?? "00").padStart(2, "0")} ${suffix}`;
}

export function LectureListClient() {
  const searchParams = useSearchParams();

  const initialRange = (() => {
    const r = searchParams.get("range");
    if (r === "month" || r === "quarter" || r === "year" || r === "all") return dashRangeToYmd(r);
    return null;
  })();

  const [classId, setClassId] = useState(() => searchParams.get("classId") ?? "");
  const [preset, setPreset] = useState<Preset>(initialRange ? "custom" : "month");
  const [customFrom, setCustomFrom] = useState(initialRange?.from ?? "");
  const [customTo, setCustomTo] = useState(initialRange?.to ?? "");
  const [scheduledOnly, setScheduledOnly] = useState(
    () => ["1", "true", "yes"].includes((searchParams.get("scheduled") ?? "").toLowerCase())
  );
  const [unviewedNotesOnly, setUnviewedNotesOnly] = useState(
    () => searchParams.get("notes") === "unviewed"
  );
  const [missedOnly, setMissedOnly] = useState(() => searchParams.get("attendance") === "missed");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<ListData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detailByLecture, setDetailByLecture] = useState<Record<string, LectureDetail>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);

  const [panelLectureId, setPanelLectureId] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<"notes" | "assignments">("notes");

  const [recordingsOpenId, setRecordingsOpenId] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ videoId: string; title: string } | null>(null);

  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const range = useMemo(() => computeRange(preset, customFrom, customTo), [preset, customFrom, customTo]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef({
    classId,
    from: range.from,
    to: range.to,
    page,
    scheduledOnly,
    unviewedNotesOnly,
    missedOnly,
  });
  reqRef.current = {
    classId,
    from: range.from,
    to: range.to,
    page,
    scheduledOnly,
    unviewedNotesOnly,
    missedOnly,
  };

  const fetchItems = useCallback(
    async (params: {
      classId: string;
      from: string;
      to: string;
      page: number;
      scheduledOnly: boolean;
      unviewedNotesOnly: boolean;
      missedOnly: boolean;
    }) => {
    setIsLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (params.classId) qs.set("classId", params.classId);
      if (params.from) qs.set("from", params.from);
      if (params.to) qs.set("to", params.to);
      if (params.scheduledOnly) qs.set("scheduled", "1");
      if (params.unviewedNotesOnly) qs.set("notes", "unviewed");
      if (params.missedOnly) qs.set("attendance", "missed");
      qs.set("page", String(params.page));
      qs.set("limit", "10");

      const response = await fetch(`/api/student/lectures?${qs.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as { success: boolean; data?: ListData };
      if (!response.ok || !payload.success) throw new Error("Failed to load.");
      setData(payload.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void fetchItems(reqRef.current), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, range.from, range.to, page, scheduledOnly, unviewedNotesOnly, missedOnly, fetchItems]);

  const ensureDetail = useCallback(
    async (lectureId: string) => {
      if (detailByLecture[lectureId]) return detailByLecture[lectureId];
      setDetailLoadingId(lectureId);
      try {
        const response = await fetch(`/api/student/lectures/${lectureId}`, { cache: "no-store" });
        const payload = (await response.json()) as { success: boolean; data?: { lecture: LectureDetail } };
        if (!response.ok || !payload.success || !payload.data) throw new Error();
        const lecture = payload.data.lecture;
        setDetailByLecture((prev) => ({ ...prev, [lectureId]: lecture }));
        return lecture;
      } catch {
        return null;
      } finally {
        setDetailLoadingId(null);
      }
    },
    [detailByLecture]
  );

  async function openPanel(lectureId: string, tab: "notes" | "assignments") {
    setPanelLectureId(lectureId);
    setPanelTab(tab);
    setPreviewNoteId(null);
    setIsFullscreen(false);
    await ensureDetail(lectureId);
  }

  // Deep link from the calendar: ?focus=<lectureId> opens that lecture's panel.
  useEffect(() => {
    const focusId = searchParams.get("focus");
    if (focusId) void openPanel(focusId, "notes");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closePanel() {
    setPanelLectureId(null);
    setPreviewNoteId(null);
    setIsFullscreen(false);
  }

  async function toggleRecordings(lectureId: string) {
    if (recordingsOpenId === lectureId) {
      setRecordingsOpenId(null);
      return;
    }
    setRecordingsOpenId(lectureId);
    await ensureDetail(lectureId);
  }

  function clearFilters() {
    setClassId("");
    setPreset("month");
    setCustomFrom("");
    setCustomTo("");
    setScheduledOnly(false);
    setUnviewedNotesOnly(false);
    setMissedOnly(false);
    setPage(1);
  }

  const enrolledClasses = data?.enrolledClasses ?? [];
  const items = data?.items ?? [];
  const pagination = data?.pagination;
  const hasFilters =
    Boolean(classId) || preset !== "month" || scheduledOnly || unviewedNotesOnly || missedOnly;

  const panelDetail = panelLectureId ? detailByLecture[panelLectureId] ?? null : null;
  const panelLoading = panelLectureId != null && detailLoadingId === panelLectureId && !panelDetail;

  const previewUrl =
    previewNoteId && panelLectureId
      ? `/api/student/lectures/${panelLectureId}/notes/${previewNoteId}/file`
      : null;
  const previewNote = panelDetail?.notes.find((n) => n.id === previewNoteId) ?? null;

  const now = Date.now();

  return (
    <>
      {/* Filter bar */}
      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                setPreset(p.value);
                setPage(1);
              }}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                preset === p.value
                  ? "bg-emerald-600 text-white"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {p.label}
            </button>
          ))}

          <label className="ml-auto inline-flex cursor-pointer select-none items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={scheduledOnly}
              onChange={(e) => {
                setScheduledOnly(e.target.checked);
                setPage(1);
              }}
              className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            Scheduled
          </label>

          <label className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={unviewedNotesOnly}
              onChange={(e) => {
                setUnviewedNotesOnly(e.target.checked);
                setPage(1);
              }}
              className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            Unviewed notes
          </label>

          <label className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={missedOnly}
              onChange={(e) => {
                setMissedOnly(e.target.checked);
                setPage(1);
              }}
              className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            Not attended
          </label>
        </div>

        <div className="flex flex-wrap items-end gap-2.5">
          <div>
            <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Class</label>
            <select
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
            >
              <option value="">All classes</option>
              {enrolledClasses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {preset === "custom" ? (
            <>
              <div>
                <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">From</label>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => {
                    setCustomFrom(e.target.value);
                    setPage(1);
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
                />
              </div>
              <div>
                <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">To</label>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => {
                    setCustomTo(e.target.value);
                    setPage(1);
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
                />
              </div>
            </>
          ) : null}

          {hasFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      ) : null}

      {/* List */}
      {isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-6 text-center text-xs text-slate-600">
          Nothing scheduled in this range.
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map((item) => {
            const upcoming = new Date(item.date).getTime() > now;
            const timeLabel =
              item.startTime && item.endTime
                ? `${formatTime12h(item.startTime)} – ${formatTime12h(item.endTime)}`
                : null;

            if (item.kind === "schedule") {
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50/70 p-3"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-200 text-slate-500">
                    <CalendarClock size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="truncate text-sm font-semibold text-slate-800">{item.className}</h3>
                          <span className="shrink-0 rounded-full bg-slate-200 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-600">
                            No lecture yet
                          </span>
                        </div>
                        {timeLabel ? (
                          <p className="flex items-center gap-1 text-xs text-slate-500">
                            <Clock size={11} />
                            {timeLabel}
                          </p>
                        ) : null}
                      </div>
                      <p className="flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
                        <CalendarDays size={11} />
                        {formatLectureDate(item.date)}
                      </p>
                    </div>
                    <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-slate-400">
                      <CalendarPlus size={11} />
                      Scheduled class — lecture not added by the teacher yet.
                    </p>
                  </div>
                </div>
              );
            }

            const recordingsOpen = recordingsOpenId === item.id;
            const detail = detailByLecture[item.id] ?? null;
            const loadingThis = detailLoadingId === item.id;

            return (
              <div key={item.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="flex items-start gap-3 p-3">
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                      upcoming ? "bg-amber-100 text-amber-600" : "bg-emerald-100 text-emerald-600"
                    }`}
                  >
                    {upcoming ? <CalendarClock size={16} /> : <BookOpenText size={16} />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="truncate text-sm font-semibold text-slate-900">{item.title}</h3>
                          {upcoming ? (
                            <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">
                              Upcoming
                            </span>
                          ) : !item.attended ? (
                            <span className="shrink-0 rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-700">
                              Not attended
                            </span>
                          ) : null}
                        </div>
                        <p className="truncate text-xs text-slate-500">
                          {item.className}
                          {timeLabel ? (
                            <span className="text-slate-400"> · {timeLabel}</span>
                          ) : null}
                        </p>
                      </div>
                      <p className="flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
                        <CalendarDays size={11} />
                        {formatLectureDate(item.date)}
                      </p>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => void openPanel(item.id, "notes")}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
                      >
                        <FileText size={12} />
                        Notes
                        <span
                          className={`rounded px-1 text-[10px] font-bold ${
                            item.unviewedNoteCount > 0
                              ? "bg-amber-200 text-amber-800"
                              : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {item.unviewedNoteCount > 0
                            ? `${item.unviewedNoteCount} new`
                            : item.noteCount}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void openPanel(item.id, "assignments")}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700"
                      >
                        <ClipboardList size={12} />
                        Assignments
                        <span className="rounded bg-slate-100 px-1 text-[10px] font-bold text-slate-500">
                          {item.assignmentCount}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void toggleRecordings(item.id)}
                        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
                          recordingsOpen
                            ? "border-rose-300 bg-rose-50 text-rose-700"
                            : "border-slate-200 bg-white text-slate-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
                        }`}
                      >
                        <Video size={12} />
                        Recordings
                        <span className="rounded bg-slate-100 px-1 text-[10px] font-bold text-slate-500">
                          {item.recordingCount}
                        </span>
                        <ChevronDown
                          size={12}
                          className={`transition-transform ${recordingsOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                    </div>
                  </div>
                </div>

                {recordingsOpen ? (
                  <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2.5">
                    {loadingThis && !detail ? (
                      <div className="space-y-1.5">
                        {Array.from({ length: 2 }).map((_, i) => (
                          <div key={i} className="h-9 animate-pulse rounded-lg bg-slate-200/70" />
                        ))}
                      </div>
                    ) : detail && detail.recordings.length > 0 ? (
                      <ul className="space-y-1.5">
                        {detail.recordings.map((rec, index) => (
                          <li key={rec.id}>
                            <button
                              type="button"
                              onClick={() =>
                                setPlaying({
                                  videoId: rec.videoId,
                                  title: `${detail.title} — Recording ${detail.recordings.length - index}`,
                                })
                              }
                              className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left hover:border-rose-300 hover:bg-rose-50/60"
                            >
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600">
                                <Play size={13} className="translate-x-[1px]" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-medium text-slate-800">
                                  Recording {detail.recordings.length - index}
                                </span>
                                <span className="block text-[10px] text-slate-400">
                                  {new Date(rec.startedAt ?? rec.createdAt).toLocaleString([], {
                                    month: "short",
                                    day: "numeric",
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}
                                </span>
                              </span>
                              <span className="shrink-0 text-[10px] font-semibold text-rose-600">Play</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="py-1 text-center text-[11px] text-slate-500">
                        No recordings published for this lecture.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            ← Previous
          </button>
          <p className="text-xs text-slate-600">
            Page {pagination.page} / {pagination.totalPages}
            <span className="ml-1 text-slate-400">({pagination.total})</span>
          </p>
          <button
            type="button"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      ) : null}

      {/* Side panel backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          panelLectureId ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={closePanel}
        aria-hidden="true"
      />

      {/* Side panel */}
      <div
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[520px] flex-col bg-white shadow-2xl transition-transform duration-300 ease-in-out ${
          panelLectureId ? "translate-x-0" : "translate-x-full"
        }`}
        aria-modal="true"
        role="dialog"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          {panelLoading ? (
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
            </div>
          ) : panelDetail ? (
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {panelDetail.className}
              </p>
              <h2 className="mt-0.5 truncate text-sm font-semibold text-slate-900">{panelDetail.title}</h2>
              <p className="text-xs text-slate-500">{formatLectureDate(panelDetail.date)}</p>
            </div>
          ) : (
            <div className="flex-1" />
          )}
          <button
            type="button"
            onClick={closePanel}
            aria-label="Close panel"
            className="shrink-0 rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-slate-200 px-4 pt-2">
          {(["notes", "assignments"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                setPanelTab(tab);
                setPreviewNoteId(null);
              }}
              className={`rounded-t-lg px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                panelTab === tab
                  ? "border border-b-white border-slate-200 bg-white text-emerald-700"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab === "notes" ? (
                <FileText size={12} className="mr-1 inline" />
              ) : (
                <ClipboardList size={12} className="mr-1 inline" />
              )}
              {tab}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {panelLoading ? (
            <div className="space-y-2.5">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-100" />
              ))}
            </div>
          ) : !panelDetail ? null : panelTab === "notes" ? (
            <>
              {panelDetail.notes.length === 0 ? (
                <p className="text-xs text-slate-500">No notes uploaded for this lecture.</p>
              ) : (
                <div className="space-y-2">
                  {panelDetail.notes.map((note) => (
                    <div
                      key={note.id}
                      className={`rounded-xl border p-2.5 transition-colors ${
                        previewNoteId === note.id ? "border-emerald-400 bg-emerald-50" : "border-slate-200 bg-white"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                            note.kind === "NOTE" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {note.kind === "NOTE" ? "Note" : "Material"}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-slate-900">{note.title}</p>
                          <p className="text-[10px] text-slate-500">{formatBytes(note.sizeBytes)}</p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewNoteId(note.id);
                            setIsFullscreen(false);
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                        >
                          <Eye size={11} /> Preview
                        </button>
                        <a
                          href={`/api/student/lectures/${panelDetail.id}/notes/${note.id}/file`}
                          download={note.title}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <Download size={11} /> Download
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {previewUrl ? (
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-xs font-medium text-slate-700">
                      {previewNote?.title ?? "Preview"}
                    </p>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setIsFullscreen(true)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <Maximize2 size={11} /> Fullscreen
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewNoteId(null)}
                        className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                  <iframe
                    key={previewUrl}
                    src={previewUrl}
                    title={previewNote?.title ?? "PDF Preview"}
                    className="h-[440px] w-full rounded-xl border border-slate-200"
                  />
                </div>
              ) : null}
            </>
          ) : (
            <>
              {panelDetail.assignments.length === 0 ? (
                <p className="text-xs text-slate-500">No assignments for this lecture.</p>
              ) : (
                <div className="space-y-2.5">
                  {panelDetail.assignments.map((a) => {
                    const dueDate = new Date(a.dueDate);
                    const sub = a.submission
                      ? { ...a.submission, submittedAt: new Date(a.submission.submittedAt) }
                      : null;
                    return (
                      <article key={a.id} className="rounded-xl border border-slate-200 bg-white p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <h3 className="text-xs font-semibold text-slate-900">{a.title}</h3>
                            <p className="text-[11px] text-slate-500">
                              Due{" "}
                              {dueDate.toLocaleDateString(undefined, {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })}
                            </p>
                            {a.description ? (
                              <p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{a.description}</p>
                            ) : null}
                          </div>
                          <div className="shrink-0">
                            <AssignmentSubmitButton
                              assignmentId={a.id}
                              dueDate={dueDate}
                              initialSubmission={sub}
                            />
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Fullscreen PDF overlay */}
      {isFullscreen && previewUrl ? (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black">
          <div className="flex shrink-0 items-center justify-between bg-neutral-900 px-4 py-2.5">
            <p className="truncate text-sm font-medium text-white">{previewNote?.title ?? "Preview"}</p>
            <button
              type="button"
              onClick={() => setIsFullscreen(false)}
              className="ml-4 shrink-0 rounded-lg border border-white/20 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/10"
            >
              <X size={14} className="mr-1 inline" /> Exit
            </button>
          </div>
          <iframe
            key={`fs-${previewUrl}`}
            src={previewUrl}
            title={`${previewNote?.title ?? "PDF"} — Fullscreen`}
            className="w-full flex-1 border-0"
          />
        </div>
      ) : null}

      {/* YouTube player modal */}
      {playing ? (
        <>
          <div className="fixed inset-0 z-[70] bg-black/70" onClick={() => setPlaying(null)} aria-hidden />
          <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
            <div
              className="w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-black shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
                <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-white">
                  <Video size={13} className="shrink-0" />
                  <span className="truncate">{playing.title}</span>
                </p>
                <button
                  type="button"
                  onClick={() => setPlaying(null)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="aspect-video w-full">
                <iframe
                  key={playing.videoId}
                  title={playing.title}
                  src={`https://www.youtube.com/embed/${playing.videoId}?autoplay=1`}
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
