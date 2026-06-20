"use client";

import { useCallback, useEffect, useState } from "react";

import { Panel } from "@/components/student-portal/student-ui";
import type { PaginationMeta } from "@/lib/api-types";

type ClassOption = { id: string; name: string };

type BundleItem = {
  id: string;
  type: "TUTE" | "PAPER";
  title: string;
  description: string | null;
  fileName: string | null;
  fileUrl: string | null;
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
  countdownLeadMinutes: number;
  submissionGraceMinutes: number;
  classId: string;
  className: string;
  items: BundleItem[];
};

const PAGE_SIZE = 10;

export default function StudentMaterialBundlesPage() {
  const [view, setView] = useState<"awaiting" | "confirmed">("awaiting");
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [records, setRecords] = useState<BundleRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File | null>>({});
  const [isSubmittingPaper, setIsSubmittingPaper] = useState<Record<string, boolean>>({});
  const [lateReasons, setLateReasons] = useState<Record<string, string>>({});
  const [isSendingReason, setIsSendingReason] = useState<Record<string, boolean>>({});

  function applyFilter(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setter(e.target.value);
      setPage(1);
    };
  }

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (classId) params.set("classId", classId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("view", view);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));

      const res = await fetch(`/api/students/me/material-bundles?${params.toString()}`);
      const json = (await res.json()) as {
        success: boolean;
        data?: { records: BundleRecord[]; classes: ClassOption[]; view: "awaiting" | "confirmed" };
        pagination?: PaginationMeta;
        error?: { message: string };
      };

      if (json.success && json.data) {
        setRecords(json.data.records);
        setClasses(json.data.classes);
        setPagination(json.pagination ?? null);
      } else {
        setError(json.error?.message ?? "Failed to load material bundles.");
      }
    } catch {
      setError("Failed to load material bundles.");
    } finally {
      setIsLoading(false);
    }
  }, [view, classId, from, to, page]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function setPaperSubmitting(itemId: string, value: boolean) {
    setIsSubmittingPaper((prev) => ({ ...prev, [itemId]: value }));
  }

  function setReasonSending(itemId: string, value: boolean) {
    setIsSendingReason((prev) => ({ ...prev, [itemId]: value }));
  }

  async function submitPaper(bundleId: string, itemId: string) {
    const file = selectedFiles[itemId];
    if (!file) {
      setError("Please choose a PDF file before submitting.");
      return;
    }

    setPaperSubmitting(itemId, true);
    setError(null);

    try {
      const formData = new FormData();
      formData.set("file", file);

      const response = await fetch(`/api/material-bundles/${bundleId}/items/${itemId}/submit`, {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: { message?: string };
      };

      if (!payload.success) {
        setError(payload.error?.message ?? "Failed to submit paper.");
        return;
      }

      setSelectedFiles((prev) => ({ ...prev, [itemId]: null }));
      await loadData();
    } catch {
      setError("Failed to submit paper.");
    } finally {
      setPaperSubmitting(itemId, false);
    }
  }

  async function sendLateReason(bundleId: string, itemId: string) {
    const reason = lateReasons[itemId]?.trim() ?? "";

    if (reason.length < 10) {
      setError("Please enter at least 10 characters for the reason.");
      return;
    }

    setReasonSending(itemId, true);
    setError(null);

    try {
      const response = await fetch(
        `/api/students/me/material-bundles/${bundleId}/items/${itemId}/late-message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: reason }),
        },
      );

      const payload = (await response.json()) as {
        success: boolean;
        error?: { message?: string };
      };

      if (!payload.success) {
        setError(payload.error?.message ?? "Failed to send reason to teacher.");
        return;
      }

      setLateReasons((prev) => ({ ...prev, [itemId]: "" }));
    } catch {
      setError("Failed to send reason to teacher.");
    } finally {
      setReasonSending(itemId, false);
    }
  }

  async function confirmDelivery(bundleId: string) {
    setConfirmingId(bundleId);
    setError(null);

    try {
      const response = await fetch(`/api/students/me/material-bundles/${bundleId}/confirm`, {
        method: "POST",
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: { message?: string };
      };

      if (!payload.success) {
        setError(payload.error?.message ?? "Failed to confirm delivery.");
        return;
      }

      await loadData();
    } catch {
      setError("Failed to confirm delivery.");
    } finally {
      setConfirmingId(null);
    }
  }

  function clearFilters() {
    setClassId("");
    setFrom("");
    setTo("");
    setPage(1);
  }

  function switchView(nextView: "awaiting" | "confirmed") {
    setView(nextView);
    setPage(1);
  }

  const hasFilter = classId || from || to;
  const isAwaitingView = view === "awaiting";

  return (
    <Panel
      title={isAwaitingView ? "Bundle Awaiting" : "Confirmed Bundles"}
      subtitle={
        isAwaitingView
          ? "Teacher-sent tutes and papers waiting for your delivery confirmation."
          : "Previously confirmed bundle deliveries."
      }
      contentClassName="px-5 pb-5 sm:px-6 sm:pb-6"
    >
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => switchView("awaiting")}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
            isAwaitingView
              ? "border-brand-500 bg-brand-600 text-white"
              : "border-brand-200 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Awaiting
        </button>
        <button
          type="button"
          onClick={() => switchView("confirmed")}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
            !isAwaitingView
              ? "border-brand-500 bg-brand-600 text-white"
              : "border-brand-200 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Confirmed
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-brand-200 pb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Class</label>
          <select
            value={classId}
            onChange={applyFilter(setClassId)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          >
            <option value="">All classes</option>
            {classes.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Sent from</label>
          <input
            type="date"
            value={from}
            onChange={applyFilter(setFrom)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Sent to</label>
          <input
            type="date"
            value={to}
            onChange={applyFilter(setTo)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        {hasFilter ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="mt-4">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : records.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-6 text-sm text-slate-600">
            No {isAwaitingView ? "awaiting" : "confirmed"} bundles found{hasFilter ? " for the selected filters" : ""}.
          </div>
        ) : (
          <div className="space-y-4">
            {records.map((bundle) => {
              const tutes = bundle.items.filter((item) => item.type === "TUTE");
              const papers = bundle.items.filter((item) => item.type === "PAPER");

              return (
                <article key={bundle.id} className="rounded-xl border border-brand-200 bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">{bundle.title}</h3>
                      <p className="text-sm text-slate-600">{bundle.className}</p>
                      <p className="text-xs text-slate-500">
                        Sent: {bundle.sentAt ? new Date(bundle.sentAt).toLocaleString() : "-"}
                      </p>
                      {!isAwaitingView ? (
                        <p className="text-xs text-emerald-700">
                          Confirmed: {bundle.confirmedAt ? new Date(bundle.confirmedAt).toLocaleString() : "-"}
                        </p>
                      ) : null}
                    </div>

                    {isAwaitingView ? (
                      <button
                        type="button"
                        disabled={confirmingId === bundle.id}
                        onClick={() => confirmDelivery(bundle.id)}
                        className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                      >
                        {confirmingId === bundle.id ? "Confirming..." : "Confirm Delivery"}
                      </button>
                    ) : null}
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    <section className="rounded-lg border border-brand-100 bg-brand-50/40 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Tutes</p>
                      {tutes.length === 0 ? (
                        <p className="mt-2 text-sm text-slate-500">No tutes in this bundle.</p>
                      ) : (
                        <ul className="mt-2 space-y-2">
                          {tutes.map((item) => (
                            <li key={item.id} className="rounded-md border border-brand-100 bg-white p-2">
                              <p className="text-sm font-medium text-slate-800">{item.title}</p>
                              {item.description ? (
                                <p className="mt-1 text-xs text-slate-600">{item.description}</p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section className="rounded-lg border border-brand-100 bg-brand-50/40 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Papers</p>
                      {papers.length === 0 ? (
                        <p className="mt-2 text-sm text-slate-500">No papers in this bundle.</p>
                      ) : (
                        <ul className="mt-2 space-y-2">
                          {papers.map((item) => (
                            <li key={item.id} className="rounded-md border border-brand-100 bg-white p-2">
                              <p className="text-sm font-medium text-slate-800">{item.title}</p>
                              <p className="mt-1 text-xs text-slate-600">
                                {item.paperStartAt ? `Start: ${new Date(item.paperStartAt).toLocaleString()}` : "Start: -"}
                              </p>
                              <p className="text-xs text-slate-600">
                                {item.paperEndAt ? `End: ${new Date(item.paperEndAt).toLocaleString()}` : "End: -"}
                              </p>
                              <p className="text-xs text-slate-600">
                                {item.submissionDeadline
                                  ? `PDF submit deadline: ${new Date(item.submissionDeadline).toLocaleString()}`
                                  : "PDF submit deadline: -"}
                              </p>

                              {item.fileUrl ? (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <a
                                    href={`/api/students/me/material-bundles/${bundle.id}/items/${item.id}/file`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="rounded-lg border border-brand-200 px-2 py-1 text-xs font-semibold text-slate-700"
                                  >
                                    Preview paper
                                  </a>
                                  <a
                                    href={`/api/students/me/material-bundles/${bundle.id}/items/${item.id}/file?download=1`}
                                    className="rounded-lg border border-brand-200 px-2 py-1 text-xs font-semibold text-slate-700"
                                  >
                                    Download
                                  </a>
                                </div>
                              ) : null}

                              {item.latestSubmission ? (
                                <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5">
                                  <p className="text-xs font-semibold text-emerald-700">Latest submission uploaded</p>
                                  <p className="text-xs text-slate-600">
                                    {item.latestSubmission.fileName} • {new Date(item.latestSubmission.submittedAt).toLocaleString()}
                                  </p>
                                </div>
                              ) : null}

                              {item.canSubmit ? (
                                <div className="mt-2 rounded-lg border border-brand-200 bg-brand-50/40 p-2">
                                  <p className="text-xs font-semibold text-brand-700">Upload your answered PDF</p>
                                  <div className="mt-1 flex flex-wrap items-center gap-2">
                                    <input
                                      type="file"
                                      accept="application/pdf"
                                      onChange={(event) => {
                                        const file = event.target.files?.[0] ?? null;
                                        setSelectedFiles((prev) => ({ ...prev, [item.id]: file }));
                                      }}
                                      className="text-xs"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => void submitPaper(bundle.id, item.id)}
                                      disabled={isSubmittingPaper[item.id]}
                                      className="rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-60"
                                    >
                                      {isSubmittingPaper[item.id] ? "Submitting..." : "Submit PDF"}
                                    </button>
                                  </div>
                                </div>
                              ) : item.submissionDeadline && new Date() > new Date(item.submissionDeadline) ? (
                                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                                  <p className="text-xs font-semibold text-amber-700">
                                    Submission time ended. Send reason to teacher.
                                  </p>
                                  <textarea
                                    value={lateReasons[item.id] ?? ""}
                                    onChange={(event) =>
                                      setLateReasons((prev) => ({ ...prev, [item.id]: event.target.value }))
                                    }
                                    rows={3}
                                    placeholder="Explain why you couldn't submit in time..."
                                    className="mt-1 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-xs outline-none"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => void sendLateReason(bundle.id, item.id)}
                                    disabled={isSendingReason[item.id]}
                                    className="mt-1 rounded-lg border border-amber-300 px-2.5 py-1 text-xs font-semibold text-amber-800 disabled:opacity-60"
                                  >
                                    {isSendingReason[item.id] ? "Sending..." : "Send reason"}
                                  </button>
                                </div>
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
      </div>

      {pagination && pagination.totalPages > 1 ? (
        <div className="mt-5 flex items-center justify-between border-t border-brand-200 pt-4">
          <p className="text-xs text-slate-500">
            Page {pagination.page} of {pagination.totalPages} &mdash;{" "}
            {pagination.totalItems} bundle{pagination.totalItems !== 1 ? "s" : ""}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!pagination.hasPreviousPage || isLoading}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!pagination.hasNextPage || isLoading}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}