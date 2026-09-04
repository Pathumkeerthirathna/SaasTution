"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  FolderOpen,
  FileText,
  ClipboardList,
  Download,
  Eye,
  CalendarClock,
  CheckCircle2,
  UploadCloud,
  PackageCheck,
} from "lucide-react";

import type { PaginationMeta } from "@/lib/api-types";
import { useStudentLiveRefetch } from "@/components/student-portal/use-student-live-events";

type ClassOption = { id: string; name: string };

type BundleItem = {
  id: string;
  type: "TUTE" | "PAPER";
  title: string;
  description: string | null;
  fileName: string | null;
  hasFile: boolean;
  mimeType: string | null;
  paperStartAt: string | null;
  paperEndAt: string | null;
  submissionDeadline: string | null;
  canSubmit: boolean;
  latestSubmission: {
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    submittedAt: string;
  } | null;
};

type BundleRecord = {
  id: string;
  title: string;
  year: number;
  month: number;
  sentAt: string | null;
  confirmedAt: string | null;
  classId: string;
  className: string;
  items: BundleItem[];
};

const PAGE_SIZE = 10;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Period = "all" | "month" | "year" | "custom";
const PERIODS: { value: Period; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "month", label: "This month" },
  { value: "year", label: "This year" },
  { value: "custom", label: "Custom" },
];

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function StudentMaterialBundlesPage() {
  return (
    <Suspense fallback={null}>
      <StudentMaterialBundlesPageInner />
    </Suspense>
  );
}

function StudentMaterialBundlesPageInner() {
  const searchParams = useSearchParams();
  const now = useMemo(() => new Date(), []);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [records, setRecords] = useState<BundleRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState(() => searchParams.get("classId") ?? "");
  const [period, setPeriod] = useState<Period>("all");
  const [customYear, setCustomYear] = useState(String(now.getFullYear()));
  const [customMonth, setCustomMonth] = useState("");
  const [page, setPage] = useState(1);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File | null>>({});
  const [submittingItem, setSubmittingItem] = useState<Record<string, boolean>>({});

  const range = useMemo<{ year?: string; month?: string }>(() => {
    if (period === "month") {
      return { year: String(now.getFullYear()), month: String(now.getMonth() + 1) };
    }
    if (period === "year") {
      return { year: String(now.getFullYear()) };
    }
    if (period === "custom") {
      return { year: customYear || undefined, month: customMonth || undefined };
    }
    return {};
  }, [period, customYear, customMonth, now]);

  const yearOptions = useMemo(
    () => Array.from({ length: 6 }, (_, i) => now.getFullYear() - i),
    [now]
  );

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (classId) params.set("classId", classId);
      if (range.year) params.set("year", range.year);
      if (range.month) params.set("month", range.month);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));

      const res = await fetch(`/api/students/me/material-bundles?${params.toString()}`);
      const json = (await res.json()) as {
        success: boolean;
        data?: { records: BundleRecord[]; classes: ClassOption[] };
        pagination?: PaginationMeta;
        error?: { message: string };
      };

      if (json.success && json.data) {
        setRecords(json.data.records);
        setClasses(json.data.classes);
        setPagination(json.pagination ?? null);
      } else {
        setError(json.error?.message ?? "Failed to load tutes & papers.");
      }
    } catch {
      setError("Failed to load tutes & papers.");
    } finally {
      setIsLoading(false);
    }
  }, [classId, range.year, range.month, page]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Realtime: refresh tutes/papers whenever a bundle is sent or an item changes.
  useStudentLiveRefetch(() => void loadData());

  async function confirmDelivery(bundleId: string) {
    setConfirmingId(bundleId);
    setError(null);
    try {
      const res = await fetch(`/api/students/me/material-bundles/${bundleId}/confirm`, { method: "POST" });
      const json = (await res.json()) as { success: boolean; error?: { message?: string } };
      if (!json.success) {
        setError(json.error?.message ?? "Failed to mark as received.");
        return;
      }
      await loadData();
    } catch {
      setError("Failed to mark as received.");
    } finally {
      setConfirmingId(null);
    }
  }

  async function submitPaper(bundleId: string, itemId: string) {
    const file = selectedFiles[itemId];
    if (!file) {
      setError("Choose a PDF file before submitting.");
      return;
    }
    setSubmittingItem((p) => ({ ...p, [itemId]: true }));
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch(`/api/material-bundles/${bundleId}/items/${itemId}/submit`, {
        method: "POST",
        body: fd,
      });
      const json = (await res.json()) as { success: boolean; error?: { message?: string } };
      if (!json.success) {
        setError(json.error?.message ?? "Failed to submit paper.");
        return;
      }
      setSelectedFiles((p) => ({ ...p, [itemId]: null }));
      await loadData();
    } catch {
      setError("Failed to submit paper.");
    } finally {
      setSubmittingItem((p) => ({ ...p, [itemId]: false }));
    }
  }

  function clearFilters() {
    setClassId("");
    setPeriod("all");
    setCustomMonth("");
    setPage(1);
  }

  const hasFilter = Boolean(classId) || period !== "all";

  function fileLinks(bundleId: string, item: BundleItem, previewLabel: string) {
    if (!item.hasFile) {
      return <span className="text-[11px] text-slate-400">Not uploaded yet</span>;
    }
    const base = `/api/students/me/material-bundles/${bundleId}/items/${item.id}/file`;
    return (
      <div className="flex flex-wrap gap-1.5">
        <a
          href={base}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
        >
          <Eye size={11} /> {previewLabel}
        </a>
        <a
          href={`${base}?download=1`}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Download size={11} /> Download
        </a>
      </div>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-card">
      <header className="flex items-center gap-2.5 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-white px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <FolderOpen size={16} />
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-slate-900">Tutes / Papers</h1>
          <p className="text-xs text-slate-500">Monthly tutes and papers sent by your teachers.</p>
        </div>
      </header>

      <div className="p-3">
        {/* Filters */}
        <div className="mb-3 flex flex-wrap items-end gap-2.5">
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
              onChange={(e) => {
                setPeriod(e.target.value as Period);
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
            >
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {period === "custom" ? (
            <>
              <div>
                <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Year</label>
                <select
                  value={customYear}
                  onChange={(e) => {
                    setCustomYear(e.target.value);
                    setPage(1);
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
                >
                  {yearOptions.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Month</label>
                <select
                  value={customMonth}
                  onChange={(e) => {
                    setCustomMonth(e.target.value);
                    setPage(1);
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
                >
                  <option value="">All months</option>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : null}

          {hasFilter ? (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              Reset
            </button>
          ) : null}
        </div>

        {error ? (
          <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        ) : null}

        {isLoading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : records.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-6 text-center text-xs text-slate-600">
            No tutes or papers{hasFilter ? " for the selected filters" : " sent to you yet"}.
          </div>
        ) : (
          <div className="space-y-2.5">
            {records.map((bundle) => {
              const tutes = bundle.items.filter((i) => i.type === "TUTE");
              const papers = bundle.items.filter((i) => i.type === "PAPER");
              const received = Boolean(bundle.confirmedAt);

              return (
                <article
                  key={bundle.id}
                  className={`rounded-lg border bg-white p-3 ${received ? "border-emerald-200" : "border-slate-200"}`}
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="truncate text-sm font-semibold text-slate-900">{bundle.title}</h3>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                          {MONTHS[bundle.month - 1]} {bundle.year}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {bundle.className}
                        {bundle.sentAt ? ` · sent ${fmtDateTime(bundle.sentAt)}` : ""}
                      </p>
                    </div>

                    {received ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                        <CheckCircle2 size={11} />
                        Received {bundle.confirmedAt ? fmtDateTime(bundle.confirmedAt) : ""}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={confirmingId === bundle.id}
                        onClick={() => confirmDelivery(bundle.id)}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                      >
                        <PackageCheck size={13} />
                        {confirmingId === bundle.id ? "Marking…" : "Mark as received"}
                      </button>
                    )}
                  </div>

                  <div className="mt-3 grid gap-2.5 lg:grid-cols-2">
                    {/* Tutes */}
                    <section className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
                      <p className="mb-1.5 inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-emerald-700">
                        <FileText size={11} /> Tutes ({tutes.length})
                      </p>
                      {tutes.length === 0 ? (
                        <p className="text-[11px] text-slate-400">No tutes in this bundle.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {tutes.map((item) => (
                            <li key={item.id} className="rounded-md border border-slate-100 bg-white p-2">
                              <p className="text-xs font-semibold text-slate-800">{item.title}</p>
                              {item.description ? (
                                <p className="mt-0.5 text-[11px] text-slate-500">{item.description}</p>
                              ) : null}
                              <div className="mt-1.5">{fileLinks(bundle.id, item, "View")}</div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    {/* Papers */}
                    <section className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
                      <p className="mb-1.5 inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-violet-700">
                        <ClipboardList size={11} /> Papers ({papers.length})
                      </p>
                      {papers.length === 0 ? (
                        <p className="text-[11px] text-slate-400">No papers in this bundle.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {papers.map((item) => (
                            <li key={item.id} className="rounded-md border border-slate-100 bg-white p-2">
                              <p className="text-xs font-semibold text-slate-800">{item.title}</p>
                              {item.description ? (
                                <p className="mt-0.5 text-[11px] text-slate-500">{item.description}</p>
                              ) : null}
                              <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-500">
                                <CalendarClock size={11} />
                                {item.paperStartAt ? fmtDateTime(item.paperStartAt) : "—"}
                                {" → "}
                                {item.paperEndAt ? fmtDateTime(item.paperEndAt) : "—"}
                              </p>
                              <div className="mt-1.5">{fileLinks(bundle.id, item, "Preview")}</div>

                              {item.latestSubmission ? (
                                <p className="mt-1.5 inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                                  <CheckCircle2 size={10} />
                                  Answer submitted {fmtDateTime(item.latestSubmission.submittedAt)}
                                </p>
                              ) : null}

                              {item.canSubmit ? (
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                  <input
                                    type="file"
                                    accept="application/pdf"
                                    onChange={(e) =>
                                      setSelectedFiles((p) => ({ ...p, [item.id]: e.target.files?.[0] ?? null }))
                                    }
                                    className="text-[11px]"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => void submitPaper(bundle.id, item.id)}
                                    disabled={submittingItem[item.id]}
                                    className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
                                  >
                                    <UploadCloud size={11} />
                                    {submittingItem[item.id] ? "Submitting…" : "Submit answer"}
                                  </button>
                                </div>
                              ) : item.submissionDeadline && new Date() > new Date(item.submissionDeadline) ? (
                                <p className="mt-1.5 text-[10px] font-semibold text-amber-700">
                                  Submission window closed.
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {pagination && pagination.totalPages > 1 ? (
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-200 pt-3">
            <p className="text-[11px] text-slate-500">
              Page {pagination.page} / {pagination.totalPages} · {pagination.totalItems} bundle
              {pagination.totalItems !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!pagination.hasPreviousPage || isLoading}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                ← Previous
              </button>
              <button
                type="button"
                disabled={!pagination.hasNextPage || isLoading}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
