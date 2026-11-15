"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, HardDrive, History, Infinity as InfinityIcon, Loader2 } from "lucide-react";
import toast from "react-hot-toast";

import { bytesToGbInput, formatStorageBytes, parseStorageLimitGb } from "@/lib/storage-quota/limit-input";

/*
 * Admin teacher detail: Storage management (Stage 3.4). Shows one teacher's
 * storage (committed and reserved, per category), the effective limit and
 * where it comes from, and lets an administrator set, change or remove the
 * individual limit. All byte counts arrive as decimal strings (BigInt on the
 * server) and are only formatted here, never turned into Numbers for
 * arithmetic. Decimal units: 1 GB = 1,000,000,000 bytes.
 *
 * Views are exported for tests (react-dom/server); loaders take a fetchImpl.
 */

// ---- Types (the JSON of GET /api/admin/teachers/[teacherId]/storage) ---------------------------------------------

type Categories = { recordedLectures: string; notes: string; submissions: string; profileImages: string; total: string };

export type StorageLimitSource = "OVERRIDE" | "PLAN" | "UNLIMITED_PLAN" | "NO_ACTIVE_SUBSCRIPTION";

type SubscriptionInfo = {
  subscriptionId: string;
  status: string;
  endDate: string | null;
  planId: string;
  planName: string;
  planStorageGB: number | null;
  planLimitBytes: string | null;
} | null;

export type AdminStorageSummary = {
  teacher: { id: string; name: string; email: string };
  usage: {
    teacherId: string;
    measuredAt: string;
    committedBytes: Categories;
    reservedBytes: Categories;
    totalUsedAndReservedBytes: string;
    limit: { limitBytes: string | null; source: StorageLimitSource; overrideBytes: string | null; planLimitBytes: string | null };
    isUnlimited: boolean;
    remainingBytes: string | null;
    usagePercent: number | null;
    isOverQuota: boolean;
    overQuotaBytes: string | null;
  };
  isOverLimitIncludingReservations: boolean;
  override: { limitBytes: string; updatedAt: string; updatedByAdminEmail: string } | null;
  subscription: { active: SubscriptionInfo; latest: SubscriptionInfo };
};

export type StorageHistoryItem = {
  id: string;
  previousLimitBytes: string | null;
  newLimitBytes: string | null;
  planLimitBytes: string | null;
  changedByAdminEmail: string;
  changedAt: string;
};

export const storageEndpoint = (teacherId: string) => `/api/admin/teachers/${encodeURIComponent(teacherId)}/storage`;
export const storageLimitEndpoint = (teacherId: string) => `/api/admin/teachers/${encodeURIComponent(teacherId)}/storage-limit`;
export const storageHistoryEndpoint = (teacherId: string) => `/api/admin/teachers/${encodeURIComponent(teacherId)}/storage-limit/history?pageSize=5`;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
type Result<T> = { ok: true; value: T } | { ok: false; message: string };

async function readJson(response: Response): Promise<{ success?: boolean; data?: unknown; message?: string; error?: { message?: string } } | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function call<T>(fetchImpl: FetchImpl, url: string, init: RequestInit | undefined, fallback: string): Promise<Result<{ data: T; message?: string }>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-store", credentials: "same-origin", ...init });
  } catch {
    return { ok: false, message: "Network error. Check your connection and try again." };
  }
  const body = await readJson(response);
  if (!response.ok || !body?.success) return { ok: false, message: body?.error?.message ?? fallback };
  return { ok: true, value: { data: body.data as T, message: body.message } };
}

export async function loadTeacherStorage(teacherId: string, { fetchImpl = fetch as FetchImpl } = {}): Promise<Result<AdminStorageSummary>> {
  const result = await call<AdminStorageSummary>(fetchImpl, storageEndpoint(teacherId), undefined, "Unable to load storage usage.");
  return result.ok ? { ok: true, value: result.value.data } : result;
}

export async function loadStorageHistory(teacherId: string, { fetchImpl = fetch as FetchImpl } = {}): Promise<Result<StorageHistoryItem[]>> {
  const result = await call<{ items: StorageHistoryItem[] }>(fetchImpl, storageHistoryEndpoint(teacherId), undefined, "Unable to load the limit history.");
  return result.ok ? { ok: true, value: result.value.data.items } : result;
}

export type LimitChange = { limitGB: string } | { removeOverride: true };

export async function saveStorageLimit(
  teacherId: string,
  change: LimitChange,
  { fetchImpl = fetch as FetchImpl } = {}
): Promise<Result<{ summary: AdminStorageSummary & { changed: boolean }; message: string }>> {
  const result = await call<AdminStorageSummary & { changed: boolean }>(
    fetchImpl,
    storageLimitEndpoint(teacherId),
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) },
    "Unable to save the storage limit."
  );
  return result.ok ? { ok: true, value: { summary: result.value.data, message: result.value.message ?? "Saved." } } : result;
}

// ---- Pure helpers ------------------------------------------------------------------------------------------

export function limitSourceLabel(source: StorageLimitSource): string {
  switch (source) {
    case "OVERRIDE":
      return "Individual limit (set by an administrator)";
    case "PLAN":
      return "Subscription plan";
    case "UNLIMITED_PLAN":
      return "Unlimited (the subscription plan has no storage limit)";
    case "NO_ACTIVE_SUBSCRIPTION":
      return "Unlimited (no active subscription)";
  }
}

/** A new limit below the current usage (committed + reserved) needs the administrator's confirmation. */
export function isReductionBelowUsage(summary: AdminStorageSummary, newLimitBytes: bigint): boolean {
  return newLimitBytes < BigInt(summary.usage.totalUsedAndReservedBytes);
}

/** The limit that applies after removing the override: the ACTIVE plan's (null = unlimited). */
export function limitAfterRemovingOverride(summary: AdminStorageSummary): bigint | null {
  const plan = summary.subscription.active?.planLimitBytes;
  return plan === undefined || plan === null ? null : BigInt(plan);
}

// ---- Views --------------------------------------------------------------------------------------------------

export const LIMIT_INPUT_ID = "admin-storage-limit-gb";

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="admin-storage-heading" className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-brand-700" aria-hidden />
        <h3 id="admin-storage-heading" className="text-[13px] font-semibold text-slate-900">
          Storage
        </h3>
      </div>
      {children}
    </section>
  );
}

export function StorageLoadingView() {
  return (
    <CardShell>
      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-slate-500" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Loading storage usage...
      </p>
    </CardShell>
  );
}

export function StorageErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <CardShell>
      <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
        {message}
        {onRetry && (
          <button type="button" onClick={onRetry} className="ml-2 font-semibold underline underline-offset-2">
            Try again
          </button>
        )}
      </div>
    </CardShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 break-words text-[13px] font-semibold text-slate-900">{value}</p>
    </div>
  );
}

export function StorageOverview({ summary }: { summary: AdminStorageSummary }) {
  const u = summary.usage;
  const percent = u.usagePercent;
  const over = u.isOverQuota || summary.isOverLimitIncludingReservations;
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        {u.isUnlimited ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[10.5px] font-semibold text-emerald-700">
            <InfinityIcon className="h-3 w-3" aria-hidden />
            Unlimited
          </span>
        ) : over ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-[10.5px] font-semibold text-red-700">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            Over limit
          </span>
        ) : (
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[10.5px] font-semibold text-brand-700">Within limit</span>
        )}
        <span className="text-[11.5px] text-slate-600">Limit source: {limitSourceLabel(u.limit.source)}</span>
      </div>

      {!u.isUnlimited && percent !== null && (
        <div className="mt-2" aria-hidden>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div className={`h-full rounded-full ${over ? "bg-red-500" : "bg-brand-600"}`} style={{ width: `${Math.min(100, percent)}%` }} />
          </div>
        </div>
      )}

      <dl className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <Stat label="Stored" value={formatStorageBytes(u.committedBytes.total)} />
        <Stat label="Reserved by uploads in progress" value={formatStorageBytes(u.reservedBytes.total)} />
        <Stat label="Total (stored + reserved)" value={formatStorageBytes(u.totalUsedAndReservedBytes)} />
        <Stat label="Allocated limit" value={u.limit.limitBytes === null ? "Unlimited" : formatStorageBytes(u.limit.limitBytes)} />
        <Stat label="Remaining" value={u.remainingBytes === null ? "Unlimited" : formatStorageBytes(u.remainingBytes)} />
        <Stat label="Used" value={percent === null ? (u.isUnlimited ? "—" : "No storage allowed") : `${percent}%`} />
      </dl>

      {over && (
        <p role="note" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] leading-5 text-red-700">
          {u.isOverQuota && u.overQuotaBytes
            ? `Stored files exceed the limit by ${formatStorageBytes(u.overQuotaBytes)}. `
            : "Stored files and uploads in progress exceed the limit. "}
          Existing files are kept; new uploads are refused until usage is below the limit.
        </p>
      )}
    </div>
  );
}

const CATEGORY_ROWS: Array<[keyof Omit<Categories, "total">, string]> = [
  ["recordedLectures", "Recorded Lectures"],
  ["notes", "Notes & Materials"],
  ["submissions", "Student Submissions"],
  ["profileImages", "Profile Images"],
];

export function CategoryBreakdown({ summary }: { summary: AdminStorageSummary }) {
  const u = summary.usage;
  return (
    <div className="mt-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">By category</h4>
      <ul className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {CATEGORY_ROWS.map(([key, label]) => (
          <li key={key} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <p className="text-[12px] font-semibold text-slate-900">{label}</p>
            <p className="mt-0.5 text-[11.5px] text-slate-600">Stored: {formatStorageBytes(u.committedBytes[key])}</p>
            <p className="text-[11.5px] text-slate-600">Reserved: {formatStorageBytes(u.reservedBytes[key])}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function planText(summary: AdminStorageSummary): string {
  const active = summary.subscription.active;
  if (active) return `${active.planName}: ${active.planLimitBytes === null ? "unlimited storage" : formatStorageBytes(active.planLimitBytes)}`;
  const latest = summary.subscription.latest;
  if (latest) return `${latest.planName} (${latest.status.toLowerCase()}): no plan limit applies`;
  return "No subscription: no plan limit applies";
}

export function LimitEditor(props: {
  summary: AdminStorageSummary;
  value: string;
  error: string | null;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const { summary } = props;
  const override = summary.override;
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Storage limit</h4>
      <p className="mt-1 text-[11.5px] text-slate-600">Subscription plan: {planText(summary)}</p>
      <p className="text-[11.5px] text-slate-600">
        Individual limit:{" "}
        {override ? `${formatStorageBytes(override.limitBytes)} (set by ${override.updatedByAdminEmail})` : "not set (the plan applies)"}
      </p>
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSave();
        }}
      >
        <label htmlFor={LIMIT_INPUT_ID} className="flex flex-col text-[11px] font-semibold text-slate-600">
          Individual limit (GB)
          <input
            id={LIMIT_INPUT_ID}
            inputMode="decimal"
            value={props.value}
            onChange={(event) => props.onChange(event.target.value)}
            aria-invalid={props.error ? true : undefined}
            aria-describedby={props.error ? `${LIMIT_INPUT_ID}-error` : `${LIMIT_INPUT_ID}-hint`}
            placeholder="e.g. 50"
            className="mt-1 w-40 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-normal text-slate-900 outline-none focus:border-brand-500"
          />
        </label>
        <button
          type="submit"
          disabled={props.saving}
          className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {props.saving && <Loader2 size={13} className="animate-spin" aria-hidden />}
          Save limit
        </button>
        {override && (
          <button
            type="button"
            onClick={props.onRemove}
            disabled={props.saving}
            className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Remove individual limit
          </button>
        )}
      </form>
      {props.error ? (
        <p id={`${LIMIT_INPUT_ID}-error`} role="alert" className="mt-1.5 text-[11.5px] text-red-600">
          {props.error}
        </p>
      ) : (
        <p id={`${LIMIT_INPUT_ID}-hint`} className="mt-1.5 text-[11px] text-slate-500">
          Decimal GB (1 GB = 1,000,000,000 bytes). 0 means no more files can be stored. Removing the individual limit returns the teacher to the plan&apos;s limit.
        </p>
      )}
    </div>
  );
}

export function ReductionConfirm(props: { summary: AdminStorageSummary; newLimitBytes: bigint; saving: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" aria-labelledby="storage-reduce-title" aria-describedby="storage-reduce-body" className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <p id="storage-reduce-title" className="text-[12.5px] font-semibold text-amber-900">
        Set the limit to {formatStorageBytes(props.newLimitBytes)}, below the current usage of {formatStorageBytes(props.summary.usage.totalUsedAndReservedBytes)}?
      </p>
      <ul id="storage-reduce-body" className="mt-1 list-disc pl-5 text-[11.5px] leading-5 text-amber-900">
        <li>Existing files will not be deleted.</li>
        <li>The teacher may immediately be over the limit.</li>
        <li>New uploads will be refused until storage usage falls below the new limit.</li>
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={props.onCancel} disabled={props.saving} className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          Cancel
        </button>
        <button type="button" onClick={props.onConfirm} disabled={props.saving} className="min-h-[34px] rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
          Yes, reduce the limit
        </button>
      </div>
    </div>
  );
}

const limitText = (bytes: string | null) => (bytes === null ? "None (plan applies)" : formatStorageBytes(bytes));

export function StorageHistoryList({ items }: { items: StorageHistoryItem[] }) {
  return (
    <div className="mt-3">
      <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <History className="h-3.5 w-3.5" aria-hidden />
        Recent limit changes
      </h4>
      {items.length === 0 ? (
        <p className="mt-1.5 text-[11.5px] text-slate-500">No changes yet.</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11.5px] text-slate-700">
              <p className="break-words">
                <span className="font-semibold">{limitText(item.previousLimitBytes)}</span> → <span className="font-semibold">{limitText(item.newLimitBytes)}</span>
              </p>
              <p className="break-words text-slate-500">
                {item.changedByAdminEmail} · {new Date(item.changedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- The card ----------------------------------------------------------------------------------------------

export function AdminTeacherStorageCard({ teacherId }: { teacherId: string }) {
  const [summary, setSummary] = useState<AdminStorageSummary | null>(null);
  const [history, setHistory] = useState<StorageHistoryItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingReduction, setPendingReduction] = useState<{ bytes: bigint; change: LimitChange } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const [storage, changes] = await Promise.all([loadTeacherStorage(teacherId), loadStorageHistory(teacherId)]);
    if (!storage.ok) {
      setLoadError(storage.message);
      return;
    }
    setSummary(storage.value);
    setValue(storage.value.override ? bytesToGbInput(storage.value.override.limitBytes) : "");
    if (changes.ok) setHistory(changes.value);
  }, [teacherId]);

  useEffect(() => {
    setSummary(null);
    setHistory([]);
    setPendingReduction(null);
    setInputError(null);
    void load();
  }, [load]);

  async function submit(change: LimitChange) {
    setSaving(true);
    const result = await saveStorageLimit(teacherId, change);
    setSaving(false);
    setPendingReduction(null);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(result.value.message);
    await load();
  }

  function onSave() {
    if (!summary) return;
    const parsed = parseStorageLimitGb(value);
    if (!parsed.ok) {
      setInputError(parsed.message);
      return;
    }
    setInputError(null);
    const change: LimitChange = { limitGB: value.trim() };
    if (isReductionBelowUsage(summary, parsed.bytes)) {
      setPendingReduction({ bytes: parsed.bytes, change });
      return;
    }
    void submit(change);
  }

  function onRemove() {
    if (!summary) return;
    const after = limitAfterRemovingOverride(summary);
    const change: LimitChange = { removeOverride: true };
    if (after !== null && isReductionBelowUsage(summary, after)) {
      setPendingReduction({ bytes: after, change });
      return;
    }
    void submit(change);
  }

  if (loadError) return <StorageErrorView message={loadError} onRetry={() => void load()} />;
  if (!summary) return <StorageLoadingView />;
  return (
    <CardShell>
      <StorageOverview summary={summary} />
      <CategoryBreakdown summary={summary} />
      <LimitEditor
        summary={summary}
        value={value}
        error={inputError}
        saving={saving}
        onChange={(next) => {
          setValue(next);
          setInputError(null);
          setPendingReduction(null);
        }}
        onSave={onSave}
        onRemove={onRemove}
      />
      {pendingReduction !== null && (
        <ReductionConfirm
          summary={summary}
          newLimitBytes={pendingReduction.bytes}
          saving={saving}
          onCancel={() => setPendingReduction(null)}
          onConfirm={() => void submit(pendingReduction.change)}
        />
      )}
      <StorageHistoryList items={history} />
    </CardShell>
  );
}
