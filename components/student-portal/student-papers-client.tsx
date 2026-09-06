"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  UserRound,
  CalendarClock,
  FileText,
  ExternalLink,
  UploadCloud,
  CheckCircle2,
  Award,
  X,
  Clock,
} from "lucide-react";

import { dashRangeToYmd, isDashRange, type DashRange } from "@/lib/dashboard-range";
import { focusElementId, useFocusHighlight } from "@/components/student-portal/use-focus-highlight";
import { useStudentLiveRefetch } from "@/components/student-portal/use-student-live-events";

const PERIODS: { value: DashRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
];

type Paper = {
  submissionId: string;
  paperId: string;
  name: string;
  description: string | null;
  pdfName: string;
  pdfMimeType: string;
  maxMarks: number | null;
  startTime: string;
  endTime: string;
  createdAt: string;
  classId: string;
  className: string;
  teacherName: string;
  submitted: boolean;
  submittedAt: string | null;
  submissionFileName: string | null;
  marks: number | null;
  markedAt: string | null;
};

type ClassOption = { id: string; name: string };
type Data = { papers: Paper[]; classes: ClassOption[] };

const PAPER_EARLY_VIEW_WINDOW_MS = 15 * 60 * 1000;

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString("en-GB", {
    timeZone: "Asia/Colombo",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function StudentPapersClient() {
  const searchParams = useSearchParams();

  const [classId, setClassId] = useState(() => searchParams.get("classId") ?? "");
  const [period, setPeriod] = useState<DashRange>(() => {
    const r = searchParams.get("range");
    return isDashRange(r) ? r : "all";
  });
  const [pendingOnly, setPendingOnly] = useState(() => searchParams.get("pending") === "1");
  const [data, setData] = useState<Data | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [submitPaper, setSubmitPaper] = useState<Paper | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: "success" | "error" } | null>(null);
  const [openingPaperId, setOpeningPaperId] = useState<string | null>(null);

  const load = useCallback(async (cls: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const qs = cls ? `?classId=${encodeURIComponent(cls)}` : "";
      const res = await fetch(`/api/student/papers${qs}`, { cache: "no-store" });
      const json = (await res.json()) as { success: boolean; data?: Data; error?: { message?: string } };
      if (!res.ok || !json.success || !json.data) throw new Error(json.error?.message ?? "Failed to load papers.");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load papers.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(classId);
  }, [classId, load]);

  // Realtime: refresh papers whenever a paper is added/updated or a submission is marked.
  useStudentLiveRefetch(() => void load(classId));

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  async function openPaper(paper: Paper) {
    const url = `/api/class-papers/${paper.paperId}/file`;
    // Opened synchronously so the browser still treats it as a user gesture
    // (avoids the popup blocker) even though we fetch before navigating it.
    const win = window.open("", "_blank");

    setOpeningPaperId(paper.paperId);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        win?.close();
        const body = await res.json().catch(() => ({}));
        setToast({
          message: body?.error?.message ?? "This paper isn't available right now.",
          kind: "error",
        });
        return;
      }

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      if (win) {
        win.location.href = objectUrl;
      } else {
        window.open(objectUrl, "_blank");
      }
    } catch {
      win?.close();
      setToast({ message: "Unable to open the paper right now. Please try again.", kind: "error" });
    } finally {
      setOpeningPaperId(null);
    }
  }

  function openSubmit(paper: Paper) {
    setSubmitPaper(paper);
    setFile(null);
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submitPaper) return;
    if (!file) {
      setSubmitError("Choose your answer file (PDF or image).");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch(`/api/student/papers/${submitPaper.paperId}/submit`, {
        method: "POST",
        body: fd,
      });
      const json = (await res.json()) as { success: boolean; error?: { message?: string } };
      if (!res.ok || !json.success) {
        setSubmitError(json.error?.message ?? "Failed to submit.");
        return;
      }
      setSubmitPaper(null);
      setToast({ message: "Answer submitted.", kind: "success" });
      await load(classId);
    } catch {
      setSubmitError("Unable to submit right now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const classes = data?.classes ?? [];

  const visiblePapers = useMemo(() => {
    const papers = data?.papers ?? [];
    const { from, to } = dashRangeToYmd(period);
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toMs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    return papers.filter((p) => {
      if (pendingOnly && p.submitted) return false;
      if (fromMs !== null || toMs !== null) {
        const t = new Date(p.startTime).getTime();
        if (fromMs !== null && t < fromMs) return false;
        if (toMs !== null && t > toMs) return false;
      }
      return true;
    });
  }, [data, period, pendingOnly]);

  const hasFilter = Boolean(classId) || period !== "all" || pendingOnly;

  useFocusHighlight(!isLoading && visiblePapers.length > 0);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2.5">
        <div>
          <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Class</label>
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Period</label>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as DashRange)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <label className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
          />
          Not submitted only
        </label>

        {hasFilter ? (
          <button
            type="button"
            onClick={() => {
              setClassId("");
              setPeriod("all");
              setPendingOnly(false);
            }}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            Reset
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      ) : isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : visiblePapers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-6 text-center text-xs text-slate-600">
          {hasFilter ? "No papers match the selected filters." : "No papers have been assigned to you yet."}
        </div>
      ) : (
        <div className="space-y-2.5">
          {visiblePapers.map((paper) => {
            const now = Date.now();
            const start = new Date(paper.startTime).getTime();
            const end = new Date(paper.endTime).getTime();
            const phase = now < start ? "upcoming" : now > end ? "closed" : "open";
            const canSubmit = phase === "open";
            const canViewPaper = now >= start - PAPER_EARLY_VIEW_WINDOW_MS;

            return (
              <article
                key={paper.paperId}
                id={focusElementId(paper.paperId)}
                className={`scroll-mt-24 rounded-lg border bg-white p-3 transition-shadow ${
                  paper.marks != null
                    ? "border-emerald-200"
                    : phase === "open"
                      ? "border-emerald-200"
                      : phase === "upcoming"
                        ? "border-amber-200"
                        : "border-slate-200"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="text-sm font-semibold text-slate-900 break-words sm:truncate">{paper.name}</h3>
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                          phase === "open"
                            ? "bg-emerald-100 text-emerald-700"
                            : phase === "upcoming"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-slate-200 text-slate-600"
                        }`}
                      >
                        {phase === "open" ? "Open" : phase === "upcoming" ? "Upcoming" : "Closed"}
                      </span>
                    </div>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1">{paper.className}</span>
                      <span className="inline-flex items-center gap-1">
                        <UserRound size={11} />
                        {paper.teacherName}
                      </span>
                      {paper.maxMarks != null ? (
                        <span className="inline-flex items-center gap-1">
                          <Award size={11} />
                          Max {paper.maxMarks}
                        </span>
                      ) : null}
                    </p>
                  </div>

                  {canViewPaper ? (
                    <button
                      type="button"
                      onClick={() => void openPaper(paper)}
                      disabled={openingPaperId === paper.paperId}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <FileText size={11} />
                      {openingPaperId === paper.paperId ? "Opening…" : "Paper"}
                      {openingPaperId !== paper.paperId && <ExternalLink size={10} />}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setToast({
                          message: "You can view the paper from 15 minutes before it starts.",
                          kind: "error",
                        })
                      }
                      className="inline-flex shrink-0 cursor-not-allowed items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-400"
                    >
                      <FileText size={11} />
                      Paper
                    </button>
                  )}
                </div>

                {paper.description ? (
                  <p className="mt-1.5 line-clamp-2 text-xs text-slate-500">{paper.description}</p>
                ) : null}

                <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-slate-500">
                  <CalendarClock size={11} />
                  {phase === "upcoming"
                    ? `Opens ${fmtDateTime(paper.startTime)}`
                    : `${fmtDateTime(paper.startTime)} → ${fmtDateTime(paper.endTime)}`}
                </p>
                {!canViewPaper ? (
                  <p className="mt-0.5 text-[10.5px] text-amber-600">
                    You can view the paper from 15 minutes before it starts.
                  </p>
                ) : null}

                {/* status row */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {paper.submitted ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                      <CheckCircle2 size={10} />
                      Submitted {paper.submittedAt ? fmtDateTime(paper.submittedAt) : ""}
                    </span>
                  ) : phase === "closed" ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700">
                      Not submitted
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                      <Clock size={10} />
                      Awaiting your submission
                    </span>
                  )}

                  {paper.marks != null ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">
                      <Award size={10} />
                      Marks {paper.marks}
                      {paper.maxMarks != null ? ` / ${paper.maxMarks}` : ""}
                    </span>
                  ) : null}

                  {paper.submitted && paper.submissionFileName ? (
                    <a
                      href={`/api/class-papers/${paper.paperId}/submissions/${paper.submissionId}/file`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:underline"
                    >
                      <FileText size={10} />
                      My answer <ExternalLink size={9} />
                    </a>
                  ) : null}
                </div>

                {canSubmit ? (
                  <div className="mt-2.5 flex justify-end">
                    <button
                      type="button"
                      onClick={() => openSubmit(paper)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      <UploadCloud size={13} />
                      {paper.submitted ? "Re-submit answer" : "Submit answer"}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {/* Submit modal */}
      {submitPaper ? (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={() => !submitting && setSubmitPaper(null)}
            className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[1px]"
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <form
              onSubmit={handleSubmit}
              className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                    Submit answer
                  </p>
                  <p className="mt-0.5 truncate text-sm font-semibold text-slate-900">{submitPaper.name}</p>
                  <p className="text-xs text-slate-500">
                    Closes {fmtDateTime(submitPaper.endTime)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => !submitting && setSubmitPaper(null)}
                  className="shrink-0 rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="space-y-3 px-4 py-3">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-slate-500">
                    Answer file <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="file"
                    accept=".pdf,image/png,image/jpeg,image/webp"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-700 file:mr-2 file:rounded-md file:border-0 file:bg-emerald-600 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-white hover:file:bg-emerald-700"
                  />
                  {file ? (
                    <p className="mt-1 text-[11px] text-slate-500">
                      {file.name} · {(file.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] text-slate-400">PDF, PNG, JPG or WEBP · max 25 MB</p>
                  )}
                </div>

                {submitError ? (
                  <p className="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{submitError}</p>
                ) : null}
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setSubmitPaper(null)}
                  disabled={submitting}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <UploadCloud size={13} />
                  {submitting ? "Submitting…" : "Submit"}
                </button>
              </div>
            </form>
          </div>
        </>
      ) : null}

      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-[60] rounded-lg border bg-white px-3 py-2 text-xs font-semibold shadow-lg ${
            toast.kind === "error"
              ? "border-rose-200 text-rose-700"
              : "border-emerald-200 text-emerald-700"
          }`}
        >
          {toast.message}
        </div>
      ) : null}
    </>
  );
}
