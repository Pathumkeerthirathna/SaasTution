"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, HardDrive, Infinity as InfinityIcon, RefreshCw } from "lucide-react";

import { useTeacherLiveRefetch } from "@/components/dashboard/use-teacher-live-events";
import { formatStorageBytes } from "@/lib/storage-quota/limit-input";
import type { TeacherStorageLimitSource, TeacherStorageView } from "@/lib/storage-quota/teacher-view";

/*
 * Teacher dashboard: Storage usage (Stage 3.5). READ ONLY: the teacher sees
 * their own usage (GET /api/teacher/storage, session-scoped) and cannot change
 * any limit - there is no input, form or limit control here. Byte counts
 * arrive as decimal strings and are only formatted (decimal units: 1 GB =
 * 1,000,000,000 bytes). Views are exported for tests; the loader takes a
 * fetchImpl.
 */

export const TEACHER_STORAGE_ENDPOINT = "/api/teacher/storage";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export async function loadTeacherStorageView({ fetchImpl = fetch as FetchImpl } = {}): Promise<{ ok: true; value: TeacherStorageView } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetchImpl(TEACHER_STORAGE_ENDPOINT, { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { ok: false, message: "Network error. Check your connection and try again." };
  }
  let body: { success?: boolean; data?: TeacherStorageView; error?: { message?: string } } | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body?.success || !body.data) return { ok: false, message: body?.error?.message ?? "Couldn't load your storage usage." };
  return { ok: true, value: body.data };
}

export function limitSourceText(source: TeacherStorageLimitSource): string {
  switch (source) {
    case "INDIVIDUAL":
      return "Your storage limit was set by an administrator.";
    case "PLAN":
      return "Your storage limit comes from your subscription plan.";
    case "UNLIMITED_PLAN":
      return "Your subscription plan has unlimited storage.";
    case "NO_ACTIVE_SUBSCRIPTION":
      return "No storage limit applies to your account.";
  }
}

// ---- Views ------------------------------------------------------------------------------------------------

function CardShell({ children, onRefresh, refreshing }: { children: React.ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <article aria-labelledby="teacher-storage-heading" className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
      <div className="flex items-center justify-between gap-2 border-b border-brand-100 bg-gradient-to-r from-sky-50 to-white px-5 py-4">
        <div className="flex items-center gap-2">
          <HardDrive size={16} className="text-sky-600" aria-hidden />
          <h2 id="teacher-storage-heading" className="font-bold text-foreground">
            Storage usage
          </h2>
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 text-xs font-semibold text-brand-700 hover:underline disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} aria-hidden />
            Refresh
          </button>
        )}
      </div>
      <div className="p-5">{children}</div>
    </article>
  );
}

export function StorageUsageLoading() {
  return (
    <CardShell>
      <div role="status" aria-label="Loading storage usage" className="space-y-2">
        <div className="h-3 w-1/3 animate-pulse rounded bg-slate-200" />
        <div className="h-2 w-full animate-pulse rounded bg-slate-200" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200" />
        <span className="sr-only">Loading storage usage...</span>
      </div>
    </CardShell>
  );
}

export function StorageUsageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <CardShell>
      <div role="alert" className="rounded-xl border border-dashed border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-600">
        {message}{" "}
        <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">
          Try again
        </button>
      </div>
    </CardShell>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
      <dt className="text-[11px] font-bold uppercase tracking-widest text-muted">{label}</dt>
      <dd className="mt-1 break-words text-lg font-bold text-foreground">{value}</dd>
      {note && <dd className="text-[11px] text-muted">{note}</dd>}
    </div>
  );
}

const CATEGORIES: Array<["recordedLectures" | "notes" | "submissions" | "profileImages", string]> = [
  ["recordedLectures", "Recorded Lectures"],
  ["notes", "Notes & Materials"],
  ["submissions", "Student Submissions"],
  ["profileImages", "Profile Images"],
];

export function StorageUsageView({ view, onRefresh, refreshing }: { view: TeacherStorageView; onRefresh?: () => void; refreshing?: boolean }) {
  const reserved = BigInt(view.reservedBytes) > BigInt(0);
  const empty = BigInt(view.totalBytes) === BigInt(0);
  const limitReached = !view.isOverQuota && view.isOverLimitIncludingReservations;
  const percent = view.usagePercent;

  return (
    <CardShell onRefresh={onRefresh} refreshing={refreshing}>
      <div className="flex flex-wrap items-center gap-2">
        {view.isUnlimited ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
            <InfinityIcon size={12} aria-hidden />
            Unlimited storage
          </span>
        ) : view.isOverQuota ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700">
            <AlertTriangle size={12} aria-hidden />
            Over quota
          </span>
        ) : limitReached ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
            <AlertTriangle size={12} aria-hidden />
            Limit reached
          </span>
        ) : (
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">Within quota</span>
        )}
        <span className="text-xs text-muted">{limitSourceText(view.limitSource)}</span>
      </div>

      {!view.isUnlimited && view.limitBytes !== null && (
        <div className="mt-3">
          <div
            role="progressbar"
            aria-label="Storage used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent === null ? 100 : Math.min(100, percent)}
            aria-valuetext={`${formatStorageBytes(view.totalBytes)} of ${formatStorageBytes(view.limitBytes)} used`}
            className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200"
          >
            <div
              className={`h-full rounded-full ${view.isOverQuota ? "bg-rose-500" : limitReached ? "bg-amber-500" : "bg-brand-600"}`}
              style={{ width: `${percent === null ? 100 : Math.min(100, percent)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-muted">
            {formatStorageBytes(view.totalBytes)} of {formatStorageBytes(view.limitBytes)} used
            {percent !== null ? ` (${percent}%)` : ""}
          </p>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Used" value={formatStorageBytes(view.totalBytes)} note={reserved ? `${formatStorageBytes(view.committedBytes)} stored + ${formatStorageBytes(view.reservedBytes)} uploading` : "All stored"} />
        <Figure label="Allocated" value={view.isUnlimited ? "Unlimited" : formatStorageBytes(view.limitBytes ?? "0")} />
        {!view.isUnlimited && <Figure label="Remaining" value={formatStorageBytes(view.remainingBytes ?? "0")} />}
        {!view.isUnlimited && <Figure label="Used (%)" value={percent === null ? "—" : `${percent}%`} note={percent === null ? "No storage is allocated." : undefined} />}
      </dl>

      {reserved && (
        <p className="mt-2 text-xs text-muted">
          Uploads in progress reserve their full size until they finish or are cancelled; that space is included in “Used”.
        </p>
      )}

      {view.isOverQuota && (
        <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Your stored files are {formatStorageBytes(view.overQuotaBytes ?? "0")} over your storage limit. New uploads may be rejected until you
          free up storage or an administrator increases your limit. Your existing files stay available.
        </p>
      )}
      {limitReached && (
        <p role="status" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Your stored files and uploads in progress use all of your storage. New uploads may be rejected until an upload finishes or is cancelled,
          you free up storage, or an administrator increases your limit.
        </p>
      )}

      {empty ? (
        <p className="mt-4 rounded-xl border border-dashed border-sky-200 bg-sky-50 px-4 py-4 text-sm text-muted">
          You have no stored recordings, notes, student submissions or profile images yet.
        </p>
      ) : (
        <table className="mt-4 w-full border-collapse text-sm">
          <caption className="sr-only">Storage used by category</caption>
          <thead>
            <tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-widest text-muted">
              <th scope="col" className="py-2 pr-2">Category</th>
              <th scope="col" className="py-2 pr-2 text-right">Stored</th>
              <th scope="col" className="py-2 pr-2 text-right">Uploading</th>
              <th scope="col" className="py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map(([key, label]) => (
              <tr key={key} className="border-b border-slate-100 last:border-0">
                <th scope="row" className="py-2 pr-2 text-left font-medium text-foreground">{label}</th>
                <td className="whitespace-nowrap py-2 pr-2 text-right text-foreground">{formatStorageBytes(view.categories[key].committedBytes)}</td>
                <td className="whitespace-nowrap py-2 pr-2 text-right text-muted">{formatStorageBytes(view.categories[key].reservedBytes)}</td>
                <td className="whitespace-nowrap py-2 text-right font-semibold text-foreground">{formatStorageBytes(view.categories[key].totalBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </CardShell>
  );
}

// ---- The card -------------------------------------------------------------------------------------------------

export function DashboardStorageUsage() {
  const [view, setView] = useState<TeacherStorageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    const result = await loadTeacherStorageView();
    setRefreshing(false);
    if (result.ok) {
      setView(result.value);
      setError(null);
    } else {
      setError(result.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Uploads / submissions elsewhere on the dashboard change usage: refresh with the other cards.
  useTeacherLiveRefetch(() => void load());

  if (error && !view) return <StorageUsageError message={error} onRetry={() => void load()} />;
  if (!view) return <StorageUsageLoading />;
  return <StorageUsageView view={view} onRefresh={() => void load()} refreshing={refreshing} />;
}
