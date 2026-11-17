"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle, Clock, Loader2, Mail, RefreshCw, RotateCcw, X, XCircle } from "lucide-react";
import toast from "react-hot-toast";

/*
 * Teacher-facing student email delivery history (welcome + "Resend Login
 * Details" emails): GET /api/students/email-deliveries, manual retry via
 * POST /api/students/email-deliveries/{id}/retry. The server returns only the
 * signed-in teacher's records and never passwords or encrypted payloads.
 *
 * "Accepted" means the email service accepted the email; it does not prove
 * the email reached the inbox. Every field is shown at every width (cards).
 */

export type EmailHistoryScope = {
  studentId?: string;
  studentName?: string;
  importBatchId?: string;
  deliveryId?: string;
};

export type DeliveryItem = {
  id: string;
  emailType: "STUDENT_WELCOME" | "STUDENT_CREDENTIAL_RESEND";
  status: "PENDING" | "PROCESSING" | "SENT" | "FAILED";
  displayStatus: "QUEUED" | "PROCESSING" | "RETRYING" | "ACCEPTED" | "FAILED";
  student: { id: string; name: string; registrationNumber: string | null };
  recipientEmail: string;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  sentAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastOutcomeAmbiguous: boolean;
  activation: null | { state: "PENDING" | "ACTIVE" | "NOT_ACTIVATED"; code: string | null };
  canRetry: boolean;
  retryBlockedReason: string | null;
  createdAt: string;
};

export type Summary = { total: number; queued: number; processing: number; sent: number; failed: number };
export type Pagination = { page: number; totalPages: number; totalItems: number; hasNextPage: boolean; hasPreviousPage: boolean };

const STATUS_FILTERS: Array<{ value: "" | DeliveryItem["status"]; label: string }> = [
  { value: "", label: "All" },
  { value: "FAILED", label: "Failed" },
  { value: "PENDING", label: "Queued / retrying" },
  { value: "PROCESSING", label: "Sending" },
  { value: "SENT", label: "Accepted" },
];

const STATUS_STYLE: Record<DeliveryItem["displayStatus"], { label: string; className: string; Icon: typeof Clock }> = {
  QUEUED: { label: "Queued", className: "border-slate-200 bg-slate-50 text-slate-700", Icon: Clock },
  PROCESSING: { label: "Sending", className: "border-sky-200 bg-sky-50 text-sky-700", Icon: Loader2 },
  RETRYING: { label: "Retrying automatically", className: "border-amber-200 bg-amber-50 text-amber-800", Icon: RotateCcw },
  ACCEPTED: { label: "Accepted by email service", className: "border-emerald-200 bg-emerald-50 text-emerald-700", Icon: CheckCircle },
  FAILED: { label: "Failed", className: "border-red-200 bg-red-50 text-red-700", Icon: XCircle },
};

const PAGE_SIZE = 10;

function formatTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function typeLabel(type: DeliveryItem["emailType"]) {
  return type === "STUDENT_WELCOME" ? "Welcome email" : "New login details";
}

export function activationText(item: DeliveryItem): { text: string; tone: "ok" | "warn" | "info" } | null {
  if (!item.activation) return null;
  if (item.activation.state === "ACTIVE") return { text: "The emailed password is active; the previous password no longer works.", tone: "ok" };
  if (item.activation.state === "PENDING") return { text: "Accepted; activating the new password…", tone: "info" };
  if (item.activation.code === "ACCOUNT_CHANGED") {
    return { text: "The password in this email is NOT active (the account changed meanwhile). The previous password still works. Send new login details again if needed.", tone: "warn" };
  }
  if (item.status === "SENT") return { text: "The password in this email is NOT active. The previous password still works.", tone: "warn" };
  return { text: "Not sent yet: the student's current password is unchanged.", tone: "info" };
}

export function retryBlockedText(item: DeliveryItem) {
  if (item.status !== "FAILED" || item.canRetry) return null;
  return "These login details can no longer be sent (expired or replaced). Use Resend Login Details to send new ones.";
}

export function StudentEmailDeliveryHistory({ scope, onClose }: { scope: EmailHistoryScope; onClose: () => void }) {
  const [status, setStatus] = useState<"" | DeliveryItem["status"]>("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const retryingRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      const requestId = ++requestRef.current;
      if (!options.quiet) setIsLoading(true);
      try {
        const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
        if (status) query.set("status", status);
        if (scope.studentId) query.set("studentId", scope.studentId);
        if (scope.importBatchId) query.set("importBatchId", scope.importBatchId);
        if (scope.deliveryId) query.set("deliveryId", scope.deliveryId);
        const response = await fetch(`/api/students/email-deliveries?${query.toString()}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (requestId !== requestRef.current) return;
        if (!response.ok || !payload?.success) {
          setLoadError(payload?.error?.message ?? "Email delivery history could not be loaded.");
          return;
        }
        setLoadError(null);
        setItems(payload.data.items ?? []);
        setSummary(payload.data.summary ?? null);
        setPagination(payload.pagination ?? null);
      } catch {
        if (requestId === requestRef.current) setLoadError("Email delivery history could not be loaded. Check your connection and try again.");
      } finally {
        if (requestId === requestRef.current) setIsLoading(false);
      }
    },
    [page, status, scope.studentId, scope.importBatchId, scope.deliveryId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // While something is queued or being sent, refresh quietly.
  const hasActive = items.some((item) => item.status === "PENDING" || item.status === "PROCESSING" || item.activation?.state === "PENDING");
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void load({ quiet: true }), 10_000);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function retry(item: DeliveryItem) {
    if (retryingRef.current) return;
    retryingRef.current = item.id;
    setRetryingId(item.id);
    try {
      const response = await fetch(`/api/students/email-deliveries/${encodeURIComponent(item.id)}/retry`, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        toast.error(payload?.error?.message ?? "The email could not be queued again.", { duration: 8000 });
      } else {
        toast.success(payload.message ?? "The email was queued again.", { duration: 6000 });
      }
      await load({ quiet: true });
    } catch {
      toast.error("No answer from the server. Refresh to see whether the email was queued again.", { duration: 8000 });
    } finally {
      retryingRef.current = null;
      setRetryingId(null);
    }
  }

  const title = scope.studentName
    ? `Email delivery – ${scope.studentName}`
    : scope.importBatchId
    ? "Email delivery – this import"
    : "Student email delivery";

  if (typeof document === "undefined") return null;

  return createPortal(
    <EmailDeliveryHistoryView
      title={title}
      summary={summary}
      items={items}
      status={status}
      isLoading={isLoading}
      loadError={loadError}
      pagination={pagination}
      retryingId={retryingId}
      onRefresh={() => void load()}
      onClose={onClose}
      onStatus={(value) => {
        setStatus(value);
        setPage(1);
      }}
      onPage={setPage}
      onRetry={(item) => void retry(item)}
    />,
    document.body
  );
}

export type EmailDeliveryHistoryViewProps = {
  title: string;
  summary: Summary | null;
  items: DeliveryItem[];
  status: "" | DeliveryItem["status"];
  isLoading: boolean;
  loadError: string | null;
  pagination: Pagination | null;
  retryingId: string | null;
  onRefresh: () => void;
  onClose: () => void;
  onStatus: (value: "" | DeliveryItem["status"]) => void;
  onPage: (page: number) => void;
  onRetry: (item: DeliveryItem) => void;
};

/** The dialog's markup for one state (rendered by the container above; tested with react-dom/server). */
export function EmailDeliveryHistoryView({
  title,
  summary,
  items,
  status,
  isLoading,
  loadError,
  pagination,
  retryingId,
  onRefresh,
  onClose,
  onStatus,
  onPage,
  onRetry,
}: EmailDeliveryHistoryViewProps) {
  return (
  <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="email-delivery-history-title"
      className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:rounded-2xl"
    >
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#32598A] text-white">
            <Mail size={16} />
          </span>
          <div className="min-w-0">
            <h3 id="email-delivery-history-title" className="break-words text-sm font-semibold text-slate-900">
              {title}
            </h3>
            <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
              &ldquo;Accepted&rdquo; means the email service accepted the email; it does not guarantee it reached the inbox (ask students to check spam).
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            aria-label="Refresh"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-2 border-b border-slate-100 px-4 py-3 sm:grid-cols-4">
          {[
            { label: "Queued / retrying", value: summary.queued, className: "text-slate-800" },
            { label: "Sending", value: summary.processing, className: "text-sky-700" },
            { label: "Accepted", value: summary.sent, className: "text-emerald-700" },
            { label: "Failed", value: summary.failed, className: "text-red-700" },
          ].map((tile) => (
            <div key={tile.label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{tile.label}</p>
              <p className={`text-lg font-semibold ${tile.className}`}>{tile.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value || "all"}
            type="button"
            onClick={() => onStatus(filter.value)}
            className={`h-7 rounded-full border px-3 text-[11px] font-medium ${
              status === filter.value ? "border-[#32598A] bg-[#32598A] text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="min-h-[160px] flex-1 overflow-y-auto px-4 py-3">
        {isLoading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Loader2 size={16} className="animate-spin" /> Loading email history…
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
            <p>{loadError}</p>
            <button type="button" onClick={onRefresh} className="mt-2 text-xs font-semibold underline">
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">No emails{status ? " with this status" : ""} yet.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => {
              const style = STATUS_STYLE[item.displayStatus];
              const activation = activationText(item);
              const blocked = retryBlockedText(item);
              return (
                <li key={item.id} className="rounded-xl border border-slate-200 px-3 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-slate-900">
                        {item.student.name}
                        <span className="ml-1.5 font-normal text-slate-500">{item.student.registrationNumber ?? "No registration number"}</span>
                      </p>
                      <p className="break-all text-xs text-slate-600">{item.recipientEmail}</p>
                    </div>
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${style.className}`}>
                      <style.Icon size={11} className={item.displayStatus === "PROCESSING" ? "animate-spin" : ""} />
                      {style.label}
                    </span>
                  </div>

                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-2">
                    <div>
                      <dt className="inline font-medium text-slate-500">Email: </dt>
                      <dd className="inline">{typeLabel(item.emailType)}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-slate-500">Attempts: </dt>
                      <dd className="inline">
                        {item.attemptCount} of {item.maxAttempts}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-slate-500">Queued: </dt>
                      <dd className="inline">{formatTime(item.createdAt)}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-slate-500">Last attempt: </dt>
                      <dd className="inline">{formatTime(item.lastAttemptAt)}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-slate-500">Next automatic retry: </dt>
                      <dd className="inline">{item.nextRetryAt ? formatTime(item.nextRetryAt) : "—"}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-slate-500">Accepted: </dt>
                      <dd className="inline">{formatTime(item.sentAt)}</dd>
                    </div>
                  </dl>

                  {item.lastErrorMessage && item.status !== "SENT" && (
                    <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span className="break-words">
                        {item.lastErrorMessage}
                        {item.lastErrorCode ? ` (${item.lastErrorCode})` : ""}
                        {item.lastOutcomeAmbiguous ? " The outcome was unknown, so the student may receive this email more than once (always with the same password)." : ""}
                      </span>
                    </p>
                  )}

                  {activation && (
                    <p
                      className={`mt-2 rounded-lg px-2 py-1.5 text-[11px] ${
                        activation.tone === "ok" ? "bg-emerald-50 text-emerald-800" : activation.tone === "warn" ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-600"
                      }`}
                    >
                      {activation.text}
                    </p>
                  )}

                  {item.status === "FAILED" && (
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      {blocked && <p className="flex-1 text-[11px] text-slate-500">{blocked}</p>}
                      {item.canRetry && (
                        <button
                          type="button"
                          onClick={() => onRetry(item)}
                          disabled={retryingId !== null}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#32598A] px-3 text-xs font-semibold text-white hover:bg-[#264867] disabled:opacity-50"
                        >
                          {retryingId === item.id ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                          {retryingId === item.id ? "Queuing…" : "Retry now"}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-600">
          <button
            type="button"
            onClick={() => onPage(Math.max(1, pagination.page - 1))}
            disabled={!pagination.hasPreviousPage || isLoading}
            className="h-7 rounded-lg border border-slate-200 px-3 disabled:opacity-50"
          >
            Previous
          </button>
          <span>
            Page {pagination.page} of {pagination.totalPages} ({pagination.totalItems})
          </span>
          <button
            type="button"
            onClick={() => onPage(pagination.page + 1)}
            disabled={!pagination.hasNextPage || isLoading}
            className="h-7 rounded-lg border border-slate-200 px-3 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  </div>
  );
}
