"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Package } from "lucide-react";
import toast from "react-hot-toast";

/*
 * Admin teacher detail: Subscription management. Shows the teacher's current
 * subscription (plan, price, interval, status, dates, auto-renew) and lets an
 * administrator assign or change the plan. The server copies the price and
 * currency from the chosen plan; this card only sends the plan id. Assigning a
 * plan records no payment.
 *
 * Views are exported for tests (react-dom/server); loaders take a fetchImpl
 * (same structure as admin-teacher-storage-card.tsx).
 */

// ---- Types (the JSON of GET /api/admin/teachers/[teacherId]/subscription) ----------------------------------------

export type AdminPlanOption = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  interval: string;
  maxLiveParticipants: number;
  storageGB: number | null;
  status: string;
};

export type AdminTeacherSubscription = {
  id: string;
  planId: string;
  planName: string;
  planStatus: string;
  interval: string;
  status: string;
  price: number;
  currency: string;
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  updatedAt: string;
} | null;

export type AdminSubscriptionSummary = {
  teacher: { id: string; name: string; email: string };
  subscription: AdminTeacherSubscription;
  plans: AdminPlanOption[];
};

export const subscriptionEndpoint = (teacherId: string) => `/api/admin/teachers/${encodeURIComponent(teacherId)}/subscription`;

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

export async function loadTeacherSubscription(teacherId: string, { fetchImpl = fetch as FetchImpl } = {}): Promise<Result<AdminSubscriptionSummary>> {
  const result = await call<AdminSubscriptionSummary>(fetchImpl, subscriptionEndpoint(teacherId), undefined, "Unable to load the subscription.");
  return result.ok ? { ok: true, value: result.value.data } : result;
}

/** Sends only the plan id: the server takes the price and currency from the plan. */
export async function saveTeacherSubscriptionPlan(
  teacherId: string,
  planId: string,
  { fetchImpl = fetch as FetchImpl } = {}
): Promise<Result<{ summary: AdminSubscriptionSummary & { changed: boolean }; message: string }>> {
  const result = await call<AdminSubscriptionSummary & { changed: boolean }>(
    fetchImpl,
    subscriptionEndpoint(teacherId),
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId }) },
    "Unable to save the subscription plan."
  );
  return result.ok ? { ok: true, value: { summary: result.value.data, message: result.value.message ?? "Saved." } } : result;
}

// ---- Pure helpers ------------------------------------------------------------------------------------------

export function intervalLabel(interval: string): string {
  return interval === "MONTHLY" ? "per month" : interval === "YEARLY" ? "per year" : interval.toLowerCase();
}

export function formatPlanPrice(price: number, currency: string, interval: string): string {
  const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(price);
  return `${currency} ${amount} ${intervalLabel(interval)}`;
}

export function planOptionLabel(plan: AdminPlanOption): string {
  return `${plan.name} (${formatPlanPrice(plan.price, plan.currency, plan.interval)})${plan.status === "ACTIVE" ? "" : " (inactive)"}`;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" });

/** True when saving `planId` would change nothing (already ACTIVE on it at its current price). */
export function isCurrentAssignment(summary: AdminSubscriptionSummary, planId: string): boolean {
  const current = summary.subscription;
  const plan = summary.plans.find((candidate) => candidate.id === planId);
  return Boolean(current && plan && current.planId === planId && current.status === "ACTIVE" && current.price === plan.price && current.currency === plan.currency);
}

// ---- Views --------------------------------------------------------------------------------------------------

export const PLAN_SELECT_ID = "admin-subscription-plan";

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="admin-subscription-heading" className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 text-brand-700" aria-hidden />
        <h3 id="admin-subscription-heading" className="text-[13px] font-semibold text-slate-900">
          Subscription
        </h3>
      </div>
      {children}
    </section>
  );
}

export function SubscriptionLoadingView() {
  return (
    <CardShell>
      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-slate-500" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Loading subscription...
      </p>
    </CardShell>
  );
}

export function SubscriptionErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
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

export function SubscriptionOverview({ summary }: { summary: AdminSubscriptionSummary }) {
  const s = summary.subscription;
  if (!s) {
    return (
      <p className="mt-3 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-[12px] text-slate-600">
        This teacher has no subscription yet. Choose a plan below to assign one.
      </p>
    );
  }
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-1 text-[10.5px] font-semibold ${
            s.status === "ACTIVE" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"
          }`}
        >
          {s.status}
        </span>
        {s.planStatus !== "ACTIVE" && (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10.5px] font-semibold text-amber-800">Inactive plan</span>
        )}
      </div>
      <dl className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <Stat label="Current plan" value={s.planName} />
        <Stat label="Price" value={formatPlanPrice(s.price, s.currency, s.interval)} />
        <Stat label="Status" value={s.status} />
        <Stat label="Start date" value={formatDate(s.startDate)} />
        <Stat label="End date" value={s.endDate ? formatDate(s.endDate) : "No end date"} />
        <Stat label="Auto-renew" value={s.autoRenew ? "On" : "Off"} />
      </dl>
    </div>
  );
}

export function PlanEditor(props: {
  summary: AdminSubscriptionSummary;
  selectedPlanId: string;
  saving: boolean;
  error: string | null;
  onChange: (planId: string) => void;
  onSave: () => void;
}) {
  const { summary, selectedPlanId } = props;
  const selected = summary.plans.find((plan) => plan.id === selectedPlanId) ?? null;
  const unchanged = selected !== null && isCurrentAssignment(summary, selected.id);
  const action = summary.subscription ? "Save plan" : "Assign plan";

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{summary.subscription ? "Change plan" : "Assign a plan"}</h4>
      {summary.plans.length === 0 ? (
        <p className="mt-1.5 text-[11.5px] text-slate-600">No subscription plans exist yet. Create one under Packages first.</p>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSave();
          }}
        >
          <label htmlFor={PLAN_SELECT_ID} className="flex min-w-0 flex-col text-[11px] font-semibold text-slate-600">
            Plan
            <select
              id={PLAN_SELECT_ID}
              value={selectedPlanId}
              onChange={(event) => props.onChange(event.target.value)}
              aria-invalid={props.error ? true : undefined}
              aria-describedby={props.error ? `${PLAN_SELECT_ID}-error` : `${PLAN_SELECT_ID}-hint`}
              className="mt-1 w-full max-w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-normal text-slate-900 outline-none focus:border-brand-500 sm:w-80"
            >
              <option value="">Select a plan</option>
              {summary.plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {planOptionLabel(plan)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={props.saving || selected === null || unchanged}
            className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {props.saving && <Loader2 size={13} className="animate-spin" aria-hidden />}
            {action}
          </button>
        </form>
      )}

      {selected && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11.5px] text-slate-700" aria-live="polite">
          <p className="break-words font-semibold text-slate-900">
            {selected.name}: {formatPlanPrice(selected.price, selected.currency, selected.interval)}
          </p>
          <p className="break-words">
            Up to {selected.maxLiveParticipants} live participants · Storage:{" "}
            {selected.storageGB === null ? "unlimited" : `${selected.storageGB} GB`}
          </p>
          {selected.status !== "ACTIVE" && (
            <p className="mt-1 flex items-start gap-1 text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              This plan is inactive: teachers cannot choose it themselves, but it can be assigned here.
            </p>
          )}
          {unchanged && <p className="mt-1 text-slate-500">The teacher is already on this plan.</p>}
        </div>
      )}

      {props.error ? (
        <p id={`${PLAN_SELECT_ID}-error`} role="alert" className="mt-1.5 text-[11.5px] text-red-600">
          {props.error}
        </p>
      ) : (
        <p id={`${PLAN_SELECT_ID}-hint`} className="mt-1.5 text-[11px] text-slate-500">
          The price and currency are taken from the plan. An existing subscription keeps its start date, end date and
          auto-renew setting. Assigning a plan does not record a payment.
        </p>
      )}
    </div>
  );
}

// ---- The card ----------------------------------------------------------------------------------------------

export function AdminTeacherSubscriptionCard({ teacherId }: { teacherId: string }) {
  const [summary, setSummary] = useState<AdminSubscriptionSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const result = await loadTeacherSubscription(teacherId);
    if (!result.ok) {
      setLoadError(result.message);
      return;
    }
    setSummary(result.value);
    setSelectedPlanId(result.value.subscription?.planId ?? "");
  }, [teacherId]);

  useEffect(() => {
    setSummary(null);
    setSaveError(null);
    void load();
  }, [load]);

  async function onSave() {
    if (!selectedPlanId) return;
    setSaving(true);
    setSaveError(null);
    const result = await saveTeacherSubscriptionPlan(teacherId, selectedPlanId);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      toast.error(result.message);
      return;
    }
    toast.success(result.value.message);
    await load();
  }

  if (loadError) return <SubscriptionErrorView message={loadError} onRetry={() => void load()} />;
  if (!summary) return <SubscriptionLoadingView />;
  return (
    <CardShell>
      <SubscriptionOverview summary={summary} />
      <PlanEditor
        summary={summary}
        selectedPlanId={selectedPlanId}
        saving={saving}
        error={saveError}
        onChange={(next) => {
          setSelectedPlanId(next);
          setSaveError(null);
        }}
        onSave={() => void onSave()}
      />
    </CardShell>
  );
}
