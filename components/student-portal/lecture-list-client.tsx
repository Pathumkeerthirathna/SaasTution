"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ClassOption = {
  id: string;
  name: string;
};

type LectureItem = {
  id: string;
  title: string;
  date: string;
  className: string;
  classId: string;
  noteCount: number;
};

type NoteItem = {
  id: string;
  title: string;
  kind: "NOTE" | "SUPPORTING_MATERIAL";
  mimeType: string;
  sizeBytes: number;
};

type LectureDetail = {
  id: string;
  title: string;
  date: string;
  className: string;
  classId: string;
  notes: NoteItem[];
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type ListData = {
  lectures: LectureItem[];
  enrolledClasses: ClassOption[];
  pagination: Pagination;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLectureDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function LectureListClient() {
  const [classId, setClassId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<ListData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedLectureId, setSelectedLectureId] = useState<string | null>(null);
  const [panelData, setPanelData] = useState<LectureDetail | null>(null);
  const [isPanelLoading, setIsPanelLoading] = useState(false);

  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null);
  const [previewLectureId, setPreviewLectureId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep stable copies of filter state for the debounced effect
  const filterRef = useRef({ classId, from, to, page });
  filterRef.current = { classId, from, to, page };

  const fetchLectures = useCallback(async (params: { classId: string; from: string; to: string; page: number }) => {
    setIsLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (params.classId) qs.set("classId", params.classId);
      if (params.from) qs.set("from", params.from);
      if (params.to) qs.set("to", params.to);
      qs.set("page", String(params.page));
      qs.set("limit", "10");

      const response = await fetch(`/api/student/lectures?${qs.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as { success: boolean; data?: ListData };

      if (!response.ok || !payload.success) {
        throw new Error("Failed to load lectures.");
      }

      setData(payload.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load lectures.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Debounced trigger when filters or page change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchLectures(filterRef.current);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, from, to, page, fetchLectures]);

  function resetPage() {
    setPage(1);
  }

  async function openPanel(lectureId: string) {
    setSelectedLectureId(lectureId);
    setPanelOpen(true);
    setPanelData(null);
    setPreviewNoteId(null);
    setPreviewLectureId(null);
    setIsFullscreen(false);
    setIsPanelLoading(true);

    try {
      const response = await fetch(`/api/student/lectures/${lectureId}/notes`, { cache: "no-store" });
      const payload = (await response.json()) as { success: boolean; data?: { lecture: LectureDetail } };

      if (!response.ok || !payload.success) throw new Error("Failed to load lecture.");
      setPanelData(payload.data?.lecture ?? null);
    } catch {
      setPanelOpen(false);
      setSelectedLectureId(null);
    } finally {
      setIsPanelLoading(false);
    }
  }

  function closePanel() {
    setPanelOpen(false);
    setSelectedLectureId(null);
    setPreviewNoteId(null);
    setPreviewLectureId(null);
    setIsFullscreen(false);
  }

  function openPreview(lectureId: string, noteId: string) {
    setPreviewLectureId(lectureId);
    setPreviewNoteId(noteId);
    setIsFullscreen(false);
  }

  function closePreview() {
    setPreviewNoteId(null);
    setPreviewLectureId(null);
    setIsFullscreen(false);
  }

  const enrolledClasses = data?.enrolledClasses ?? [];
  const lectures = data?.lectures ?? [];
  const pagination = data?.pagination;
  const hasFilters = Boolean(classId || from || to);

  const previewUrl =
    previewNoteId && previewLectureId
      ? `/api/student/lectures/${previewLectureId}/notes/${previewNoteId}/file`
      : null;

  const previewNote = panelData?.notes.find((n) => n.id === previewNoteId) ?? null;

  return (
    <>
      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">Class</label>
          <select
            value={classId}
            onChange={(e) => {
              setClassId(e.target.value);
              resetPage();
            }}
            className="rounded-xl border border-brand-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-400"
          >
            <option value="">All classes</option>
            {enrolledClasses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              resetPage();
            }}
            className="rounded-xl border border-brand-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-400"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              resetPage();
            }}
            className="rounded-xl border border-brand-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-400"
          />
        </div>

        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setClassId("");
              setFrom("");
              setTo("");
              resetPage();
            }}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {/* Error */}
      {error ? (
        <p className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {/* Lecture list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : lectures.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-6 text-center text-sm text-slate-600">
          {hasFilters
            ? "No lectures match your filters."
            : "No lectures are available for your classes yet."}
        </div>
      ) : (
        <div className="space-y-3">
          {lectures.map((lecture) => (
            <button
              key={lecture.id}
              type="button"
              onClick={() => void openPanel(lecture.id)}
              className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                selectedLectureId === lecture.id
                  ? "border-brand-400 bg-brand-50"
                  : "border-brand-200 bg-white hover:border-brand-300 hover:bg-brand-50/50"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-medium text-slate-900">{lecture.title}</h3>
                  <p className="mt-0.5 text-sm text-slate-500">{lecture.className}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm text-slate-700">
                    {new Date(lecture.date).toLocaleDateString()}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {lecture.noteCount} note{lecture.noteCount !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 ? (
        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-xl border border-brand-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← Previous
          </button>
          <p className="text-sm text-slate-600">
            Page {pagination.page} of {pagination.totalPages}
            <span className="ml-1 text-slate-400">({pagination.total} lectures)</span>
          </p>
          <button
            type="button"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-xl border border-brand-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      ) : null}

      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          panelOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={closePanel}
        aria-hidden="true"
      />

      {/* Side panel — slides in from right */}
      <div
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[540px] flex-col bg-white shadow-2xl transition-transform duration-300 ease-in-out dark:bg-neutral-900 ${
          panelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-modal="true"
        role="dialog"
      >
        {/* Panel header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-black/10 px-5 py-4 dark:border-white/10">
          {isPanelLoading ? (
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
            </div>
          ) : panelData ? (
            <div className="flex-1 pr-2 min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {panelData.className}
              </p>
              <h2 className="mt-1 text-base font-semibold text-slate-900 dark:text-white">
                {panelData.title}
              </h2>
              <p className="mt-0.5 text-sm text-slate-500">{formatLectureDate(panelData.date)}</p>
            </div>
          ) : null}

          <button
            type="button"
            onClick={closePanel}
            aria-label="Close panel"
            className="shrink-0 rounded-lg border border-black/10 p-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-white/15 dark:text-slate-300 dark:hover:bg-white/5"
          >
            ✕
          </button>
        </div>

        {/* Panel body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isPanelLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100" />
              ))}
            </div>
          ) : panelData ? (
            <>
              {/* Notes list */}
              {panelData.notes.length === 0 ? (
                <p className="text-sm text-slate-500">No notes have been uploaded for this lecture yet.</p>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {panelData.notes.length} note{panelData.notes.length !== 1 ? "s" : ""}
                  </p>

                  {panelData.notes.map((note) => (
                    <div
                      key={note.id}
                      className={`rounded-xl border p-3 transition-colors ${
                        previewNoteId === note.id
                          ? "border-brand-400 bg-brand-50"
                          : "border-brand-200 bg-white dark:border-white/10 dark:bg-transparent"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            note.kind === "NOTE"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {note.kind === "NOTE" ? "Note" : "Supporting Material"}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                            {note.title}
                          </p>
                          <p className="text-xs text-slate-500">{formatBytes(note.sizeBytes)}</p>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => openPreview(panelData.id, note.id)}
                          className="rounded-xl border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-100"
                        >
                          Preview
                        </button>
                        <a
                          href={`/api/student/lectures/${panelData.id}/notes/${note.id}/file`}
                          download={note.title}
                          className="rounded-xl border border-black/10 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-white/15 dark:text-slate-300"
                        >
                          Download
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* PDF preview embed */}
              {previewUrl ? (
                <div className="mt-5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Preview
                      </p>
                      {previewNote ? (
                        <p className="truncate text-sm font-medium text-slate-800 dark:text-white">
                          {previewNote.title}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => setIsFullscreen(true)}
                        className="rounded-xl border border-black/10 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-white/15 dark:text-slate-300"
                      >
                        Fullscreen
                      </button>
                      <button
                        type="button"
                        onClick={closePreview}
                        className="rounded-xl border border-black/10 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-white/15 dark:text-slate-300"
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  <iframe
                    key={previewUrl}
                    src={previewUrl}
                    title={previewNote?.title ?? "PDF Preview"}
                    className="h-[500px] w-full rounded-xl border border-brand-200"
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {/* Fullscreen PDF overlay */}
      {isFullscreen && previewUrl ? (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black">
          <div className="flex shrink-0 items-center justify-between bg-neutral-900 px-4 py-2.5">
            <p className="truncate text-sm font-medium text-white">
              {previewNote?.title ?? "PDF Preview"}
            </p>
            <button
              type="button"
              onClick={() => setIsFullscreen(false)}
              className="ml-4 shrink-0 rounded-xl border border-white/20 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/10"
            >
              ✕ Exit Fullscreen
            </button>
          </div>
          <iframe
            key={`fs-${previewUrl}`}
            src={previewUrl}
            title={`${previewNote?.title ?? "PDF"} — Fullscreen`}
            className="flex-1 w-full border-0"
          />
        </div>
      ) : null}
    </>
  );
}
