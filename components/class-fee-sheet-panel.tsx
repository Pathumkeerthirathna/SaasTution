"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BadgeCheck,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FileText,
  Gift,
  Loader2,
  RefreshCw,
  Users,
  ExternalLink,
  CheckCircle2,
  MessageCircleWarning,
  Info,
  ListOrdered,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";

import {
  formatStoredSriLankaDate,
  formatStoredSriLankaDateTime,
} from "@/lib/time";
import { feePaymentState } from "@/lib/fee-payment-state";
import {
  canReversePayment,
  FeePaymentPosition,
  RecordAttemptStore,
  RecordedPaymentDetails,
  RecordPaymentButton,
  RecordPaymentDialog,
  recordPaymentBlock,
  ReversalDetails,
  ReversePaymentDialog,
  type HistoryPayment,
} from "@/components/fee-payment-actions";

type ClassOption = {
  id: string;
  name: string;
};

type EnrolmentPeriod = {
  assignedAt: string;
  removedAt: string | null;
};

type ClassFeeHistoryEntry = {
  id: string;
  amount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
};

type FeePaymentDetail = {
  id: string;
  amount: number;
  status: "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";
  note: string | null;
  teacherFeedback: string | null;
  hasSlip: boolean;
  submittedAt: string;
  confirmedAt: string | null;
  source?: "STUDENT_SLIP" | "TEACHER_RECORDED";
  /** Reversed: kept in the history, no longer counted as received. */
  reversed?: boolean;
  /** Teacher-recorded payments (Stage 2C display; null for student slips). */
  paymentMethod?: HistoryPayment["paymentMethod"];
  receivedAt?: string | null;
  recordedByName?: string | null;
  reversal?: HistoryPayment["reversal"];
};

type FeeRow = {
  feeId: string | null;
  classStudentId: string;
  studentId: string;
  studentName: string;
  registrationNumber: string | null;
  assignedAt: string;
  enrolments: EnrolmentPeriod[];
  amount: number;
  discount: number;
  lateJoinDeduct: number;
  lateJoinDeductManual: boolean;
  joinWaiver: JoinWaiverSnapshot | null;
  waiverAmount: number;
  finalAmount: number;
  dueDate: string | null;
  createdAt: string | null;
  hasPaid: boolean;
  paymentStatus: "PAID" | "PARTIAL" | "PENDING" | "UNPAID" | "FREE_CARD";
  /** Received / outstanding amounts (lib/fee-payment-state.ts). */
  paymentSummary?: { confirmedTotal: number; outstanding: number; overpaidAmount: number };
  payments: FeePaymentDetail[];
  /** Teacher-issued Free Card: finalAmount is 0, adjustments kept underneath. */
  freeCard: boolean;
  freeCardIssuedAt: string | null;
};

type WaiverRuleType = "PERCENTAGE" | "FIXED_AMOUNT";

type JoinWaiverSnapshot = {
  sequence: number;
  type: WaiverRuleType;
  value: number;
  lecturesBefore: number;
  enrolledAt: string;
  baseAmount: number;
  computedAt: string | null;
};

type WaiverRule = {
  id: string;
  sequence: number;
  type: WaiverRuleType;
  value: number;
};

const MAX_WAIVER_RULES = 20;

function describeRule(rule: { type: WaiverRuleType; value: number }) {
  return rule.type === "PERCENTAGE" ? `${rule.value}%` : `Rs. ${rule.value.toLocaleString()}`;
}

// Real UTC instants shown as Sri Lankan time, whatever the browser's timezone.
function formatSriLankaDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Colombo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type FeeSheet = {
  class: { id: string; name: string; paymentDueWeek: number };
  year: number;
  month: number;
  currentFee: number;
  periodFee: number;
  isCurrentPeriod: boolean;
  isPastPeriod: boolean;
  isFuturePeriod: boolean;
  processed: boolean;
  dueDate: string;
  isPastDue: boolean;
  isDueSoon: boolean;
  joinWaiversActive: boolean;
  rows: FeeRow[];
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const YEARS_BACK = 40;

function readApiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const typed = payload as { error?: { message?: string }; message?: string };
  return typed.error?.message ?? typed.message ?? fallback;
}

function rupees(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

// ---- Financial summary (Expected / Due / Received / Confirmed) ----------------

export type FeeSheetSummary = {
  /** Sum of every row's finalAmount (fee after discount, late-join deduction and waiver). */
  expected: number;
  /** After the due date only: finalAmount of rows with no payment submission at all. */
  due: number;
  /** One submission per row: its CONFIRMED payment, else its latest submission. */
  received: number;
  /** One CONFIRMED payment per row, at the amount actually confirmed. */
  confirmed: number;
};

export const EMPTY_FEE_SUMMARY: FeeSheetSummary = {
  expected: 0,
  due: 0,
  received: 0,
  confirmed: 0,
};

type SummaryPayment = { amount: number; status: FeePaymentDetail["status"]; reversed?: boolean };
type SummaryRow = { finalAmount: number; freeCard?: boolean; payments?: readonly SummaryPayment[] | null };

function money(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The four amounts of one class's fee sheet, from the rows the fee sheet API
 * already returns, through the shared calculation (lib/fee-payment-state.ts):
 *  - Expected: the fees (finalAmount);
 *  - Confirmed: confirmed, not reversed payments (every one: partial
 *    payments add up);
 *  - Received: Confirmed plus the latest submission awaiting processing, at
 *    most up to what is still outstanding (a stray slip on a paid fee is not
 *    counted twice);
 *  - Due (after the due date): the outstanding amount of fees with no
 *    submission awaiting processing (a submitted slip is never Due).
 * Payments arrive newest first.
 */
export function summarizeFeeRows(
  rows: readonly SummaryRow[] | null | undefined,
  isPastDue: boolean
): FeeSheetSummary {
  const summary = { ...EMPTY_FEE_SUMMARY };

  for (const row of rows ?? []) {
    const finalAmount = money(row.finalAmount);
    const payments = row.payments ?? [];
    const state = feePaymentState(
      { finalAmount, freeCard: Boolean(row.freeCard) },
      payments.map((p) => ({ amount: p.amount, status: p.status, reversal: p.reversed ? { amount: p.amount } : null }))
    );
    const awaiting = payments.find((p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION");

    summary.expected += finalAmount;
    summary.confirmed += state.confirmedTotal;
    summary.received += state.confirmedTotal + (awaiting ? Math.min(money(awaiting.amount), state.outstanding) : 0);
    if (isPastDue && !awaiting) summary.due += state.outstanding;
  }

  return summary;
}

/** Totals across classes (the All classes header); one summary per class. */
export function addFeeSummaries(summaries: readonly (FeeSheetSummary | undefined)[]): FeeSheetSummary {
  return summaries.reduce<FeeSheetSummary>(
    (total, item) =>
      item
        ? {
            expected: total.expected + money(item.expected),
            due: total.due + money(item.due),
            received: total.received + money(item.received),
            confirmed: total.confirmed + money(item.confirmed),
          }
        : total,
    { ...EMPTY_FEE_SUMMARY }
  );
}

/**
 * Sheet requests are numbered in the order they start (`++counter.current`);
 * a response may be applied only while it is still the newest request.
 */
export function isLatestSheetRequestId(counter: { current: number }, requestId: number) {
  return requestId === counter.current;
}

// ---- Free Cards (teacher-issued 100% waivers) ----------------------------------

export type FreeCardAction = "issue" | "revoke";

export type FreeCardOutcome = {
  action: FreeCardAction;
  processed: { feeId: string; studentName: string }[];
  skipped: { feeId: string; studentName: string | null; reason: string; message: string }[];
};

type SelectableRow = {
  feeId: string | null;
  paymentStatus: FeeRow["paymentStatus"];
  freeCard?: boolean;
};

/**
 * Rows a Free Card can be issued to or revoked from: every fee row without a
 * confirmed payment (a confirmed payment is never touched). Rows with a slip
 * awaiting confirmation stay selectable; the server skips them with a reason.
 */
export function selectableFeeIds(rows: readonly SelectableRow[] | null | undefined): string[] {
  return (rows ?? [])
    .filter((row) => row.feeId && row.paymentStatus !== "PAID" && row.paymentStatus !== "PARTIAL")
    .map((row) => row.feeId as string);
}

/** The selection limited to rows still selectable in the current sheet. */
export function effectiveSelection(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[] | null | undefined
): string[] {
  return selectableFeeIds(rows).filter((id) => selected.has(id));
}

export function toggleSelection(selected: ReadonlySet<string>, feeId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(feeId)) next.delete(feeId);
  else next.add(feeId);
  return next;
}

/** Select-all: every selectable row, or none when they are all selected. */
export function toggleAllSelection(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[] | null | undefined
): Set<string> {
  const ids = selectableFeeIds(rows);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  return allSelected ? new Set() : new Set(ids);
}

export function freeCardConfirmText(action: FreeCardAction, count: number, periodLabel: string) {
  const students = `${count} selected student${count === 1 ? "" : "s"}`;
  return action === "issue"
    ? `Issue a Free Card to ${students} for ${periodLabel}? Their fee for this month becomes Rs. 0. Students with a payment slip are skipped.`
    : `Revoke the Free Card of ${students} for ${periodLabel}? Their fee is recalculated and becomes payable again.`;
}

export function freeCardOutcomeText(outcome: FreeCardOutcome) {
  const verb = outcome.action === "issue" ? "issued" : "revoked";
  const done = outcome.processed.length;
  const skipped = outcome.skipped.length;
  return `${done} Free Card${done === 1 ? "" : "s"} ${verb}${skipped > 0 ? ` · ${skipped} skipped` : ""}.`;
}

/** Part of the fee received; the rest is still outstanding. */
export function PartialBadge({ outstanding }: { outstanding: number | null }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
      <Clock3 size={10} />
      Partial{outstanding !== null ? ` · ${rupees(outstanding)} due` : ""}
    </span>
  );
}

export function FreeCardBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">
      <Gift size={10} />
      Free card
    </span>
  );
}

export function FreeCardToolbar({
  selectedCount,
  selectableCount,
  canIssue,
  canRevoke,
  busy,
  onToggleAll,
  onIssue,
  onRevoke,
}: {
  selectedCount: number;
  selectableCount: number;
  canIssue: boolean;
  canRevoke: boolean;
  busy: boolean;
  onToggleAll: () => void;
  onIssue: () => void;
  onRevoke: () => void;
}) {
  const allSelected = selectableCount > 0 && selectedCount === selectableCount;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-violet-100 bg-violet-50/60 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={onToggleAll}
          disabled={selectableCount === 0 || busy}
          aria-label="Select all eligible students"
          className="h-4 w-4 rounded border-slate-300 accent-violet-600"
        />
        {selectedCount > 0
          ? `${selectedCount} of ${selectableCount} selected`
          : "Select students for Free Cards"}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onIssue}
          disabled={!canIssue || busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Gift size={13} />}
          Issue Free Card
        </button>
        <button
          type="button"
          onClick={onRevoke}
          disabled={!canRevoke || busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700 transition hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw size={13} />
          Revoke Free Card
        </button>
      </div>
    </div>
  );
}

// ---- Payment Due Access Control (per class) -------------------------------------

export type PaymentAccessSettings = { restrictUnpaidStudentAccess: boolean; paymentGracePeriodDays: number };

export const MIN_GRACE_DAYS = 0;
export const MAX_GRACE_DAYS = 30;

/**
 * Shown before the restriction is switched on: every unpaid fee whose due
 * date plus grace has passed counts, including months from before the
 * setting existed, so some students may lose access at once.
 */
export function enableRestrictionWarning(graceDays: number) {
  return (
    "Turn on payment-based access restriction for this class?\n\n" +
    `Students with ANY unpaid fee of this class whose due date plus ${graceDays} grace day${graceDays === 1 ? "" : "s"} has passed ` +
    "will lose access to its lectures, notes, recordings, quizzes, papers and the live classroom immediately. " +
    "This includes earlier months that are still unpaid.\n\n" +
    "Students who submitted a payment slip, have a Free Card or owe nothing are not affected. Payments stay available, " +
    "and access returns as soon as a slip is submitted or the fee is settled."
  );
}

/** Whether saving these settings switches the restriction on (needs the warning). */
export function isEnablingRestriction(saved: PaymentAccessSettings | null, enabled: boolean) {
  return enabled && saved !== null && !saved.restrictUnpaidStudentAccess;
}

/** A whole number of days in range, else null (the form shows an error). */
export function parseGraceDays(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const days = Number(value.trim());
  return days >= MIN_GRACE_DAYS && days <= MAX_GRACE_DAYS ? days : null;
}

export function PaymentAccessForm({
  saved,
  enabled,
  graceDays,
  saving,
  error,
  onEnabledChange,
  onGraceDaysChange,
  onSave,
}: {
  saved: PaymentAccessSettings | null;
  enabled: boolean;
  graceDays: string;
  saving: boolean;
  error: string | null;
  onEnabledChange: (value: boolean) => void;
  onGraceDaysChange: (value: string) => void;
  onSave: () => void;
}) {
  const days = parseGraceDays(graceDays);
  const dirty =
    saved !== null &&
    (saved.restrictUnpaidStudentAccess !== enabled || (days !== null && days !== saved.paymentGracePeriodDays));

  return (
    <section
      aria-labelledby="payment-access-title"
      className="rounded-lg border border-[#dce7f1] bg-[#eef3f8]/60 p-3"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h3 id="payment-access-title" className="text-xs font-semibold uppercase tracking-wide text-[#264867]">
            Payment Due Access Control
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {saved === null
              ? "Loading saved settings..."
              : saved.restrictUnpaidStudentAccess
                ? `On: students with an unpaid fee lose access to this class's lectures, notes, recordings and classroom ${saved.paymentGracePeriodDays} day${saved.paymentGracePeriodDays === 1 ? "" : "s"} after the due date. Payments stay open.`
                : "Off: unpaid fees never restrict access to this class."}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={enabled}
              disabled={saved === null || saving}
              onChange={(event) => onEnabledChange(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 accent-[#32598A]"
            />
            Restrict unpaid students
          </label>
          <label className="text-xs font-medium text-slate-700">
            <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Grace period (days)
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={MIN_GRACE_DAYS}
              max={MAX_GRACE_DAYS}
              step={1}
              value={graceDays}
              disabled={saved === null || saving}
              onChange={(event) => onGraceDaysChange(event.target.value)}
              aria-invalid={days === null}
              className="h-8 w-20 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-[#32598A]"
            />
          </label>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || days === null || saving}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#32598A] px-3 text-xs font-semibold text-white transition hover:bg-[#264867] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
      {days === null ? (
        <p className="mt-2 text-xs text-rose-600">
          Enter a whole number of days from {MIN_GRACE_DAYS} to {MAX_GRACE_DAYS}.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  );
}

function PaymentAccessControl({ classId }: { classId: string }) {
  const [saved, setSaved] = useState<PaymentAccessSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [graceDays, setGraceDays] = useState("5");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (settings: PaymentAccessSettings) => {
    setSaved(settings);
    setEnabled(settings.restrictUnpaidStudentAccess);
    setGraceDays(String(settings.paymentGracePeriodDays));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/classes/${classId}/payment-access`, { cache: "no-store" });
        const payload = (await response.json()) as { success: boolean; data?: PaymentAccessSettings };
        if (!response.ok || !payload.success || !payload.data) {
          throw new Error(readApiError(payload, "Failed to load payment access settings."));
        }
        if (!cancelled) apply(payload.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load payment access settings.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [classId]);

  async function save() {
    const days = parseGraceDays(graceDays);
    if (days === null || saving) return;
    if (isEnablingRestriction(saved, enabled) && !window.confirm(enableRestrictionWarning(days))) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/classes/${classId}/payment-access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restrictUnpaidStudentAccess: enabled, paymentGracePeriodDays: days }),
      });
      const payload = (await response.json()) as { success: boolean; data?: PaymentAccessSettings };
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to save payment access settings."));
      }
      apply(payload.data);
      toast.success("Payment access settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save payment access settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PaymentAccessForm
      saved={saved}
      enabled={enabled}
      graceDays={graceDays}
      saving={saving}
      error={error}
      onEnabledChange={setEnabled}
      onGraceDaysChange={setGraceDays}
      onSave={() => void save()}
    />
  );
}

export function FreeCardResultPanel({
  outcome,
  onDismiss,
}: {
  outcome: FreeCardOutcome;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="rounded-lg border border-violet-100 bg-white px-3 py-2 text-xs text-slate-700"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-slate-900">{freeCardOutcomeText(outcome)}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          <X size={13} />
        </button>
      </div>
      {outcome.skipped.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {outcome.skipped.map((item) => (
            <li key={item.feeId} className="break-words">
              <span className="font-medium text-slate-800">{item.studentName ?? "Unknown fee"}</span>
              <span className="text-slate-500"> — {item.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The rows of a sheet only while it belongs to the selection (else none). */
function currentSheetRows<R>(
  sheet: { class: { id: string }; year: number; month: number; rows: R[] } | null | undefined,
  selection: { classId: string; year: number; month: number }
): R[] {
  return sheet && sheetMatchesSelection(sheet, selection) ? sheet.rows : [];
}

/** Whether a loaded sheet belongs to the class, year and month now selected. */
export function sheetMatchesSelection(
  sheet: { class: { id: string }; year: number; month: number } | null | undefined,
  selection: { classId: string; year: number; month: number }
) {
  return Boolean(
    sheet &&
      sheet.class.id === selection.classId &&
      sheet.year === selection.year &&
      sheet.month === selection.month
  );
}

const SUMMARY_TILES: {
  key: keyof FeeSheetSummary;
  label: string;
  tone: string;
  value: string;
}[] = [
  {
    key: "expected",
    label: "Expected total",
    tone: "border-slate-200 bg-slate-50",
    value: "text-slate-900",
  },
  {
    key: "due",
    label: "Due amount",
    tone: "border-rose-100 bg-rose-50/70",
    value: "text-rose-700",
  },
  {
    key: "received",
    label: "Received amount",
    tone: "border-amber-100 bg-amber-50/70",
    value: "text-amber-800",
  },
  {
    key: "confirmed",
    label: "Confirmed amount",
    tone: "border-emerald-100 bg-emerald-50/70",
    value: "text-emerald-700",
  },
];

/**
 * The four amounts side by side. `isPastDue` (a single class) explains a zero
 * Due before the due date; it is omitted for the All classes totals.
 */
export function FeeSummaryAmounts({
  summary,
  isPastDue,
  compact = false,
}: {
  summary: FeeSheetSummary;
  isPastDue?: boolean;
  compact?: boolean;
}) {
  const awaiting = Math.max(0, summary.received - summary.confirmed);

  const hint: Record<keyof FeeSheetSummary, string> = {
    expected: "After discounts and waivers",
    due:
      isPastDue === false
        ? "Not yet past the due date"
        : "Past due, no slip submitted",
    received:
      awaiting > 0 ? `${rupees(awaiting)} awaiting confirmation` : "Slips submitted",
    confirmed: "Confirmed by you",
  };

  return (
    <dl
      className={`grid grid-cols-2 gap-2 ${compact ? "sm:grid-cols-4" : "lg:grid-cols-4"}`}
    >
      {SUMMARY_TILES.map((tile) => (
        <div
          key={tile.key}
          className={`min-w-0 rounded-lg border ${tile.tone} ${compact ? "px-3 py-2" : "p-2.5"}`}
        >
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {tile.label}
          </dt>
          <dd className={`break-words font-bold ${tile.value} ${compact ? "text-base" : "text-sm"}`}>
            {rupees(summary[tile.key])}
          </dd>
          {!compact ? (
            <dd className="text-[10px] leading-4 text-slate-500">{hint[tile.key]}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

export function ClassFeeSheetPanel() {
  const now = useMemo(() => new Date(), []);

  const [classes, setClasses] = useState<ClassOption[]>([]);
  // "" means "All classes".
  const [classId, setClassId] = useState("");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [classesError, setClassesError] = useState<string | null>(null);
  const [classesLoading, setClassesLoading] = useState(true);
  const [isWaiverRulesOpen, setIsWaiverRulesOpen] = useState(false);
  const selectedClass = classes.find((c) => c.id === classId) ?? null;

  // Each mounted ClassFeeSheetDetail reports its own financial summary here
  // (keyed by class, so each class counts once), so the header can show
  // combined totals across every class currently shown.
  const [classSummaries, setClassSummaries] = useState<Record<string, FeeSheetSummary>>({});
  const handleSummaryChange = useCallback((id: string, summary: FeeSheetSummary) => {
    setClassSummaries((prev) => {
      const current = prev[id];
      if (
        current &&
        current.expected === summary.expected &&
        current.due === summary.due &&
        current.received === summary.received &&
        current.confirmed === summary.confirmed
      ) {
        return prev;
      }
      return { ...prev, [id]: summary };
    });
  }, []);
  const relevantClassIds = classId ? [classId] : classes.map((c) => c.id);
  const combinedSummary = addFeeSummaries(relevantClassIds.map((id) => classSummaries[id]));

  // The month grid has a fixed 4×3 layout; the class and year lists scroll
  // within that same height.
  const monthGridRef = useRef<HTMLDivElement>(null);
  const [selectorMaxHeight, setSelectorMaxHeight] = useState<number>();

  useEffect(() => {
    const element = monthGridRef.current;
    if (!element) return;

    const update = () => setSelectorMaxHeight(element.offsetHeight);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const yearOptions = useMemo(() => {
    const start = now.getFullYear();
    return Array.from({ length: YEARS_BACK }, (_, index) => start - index);
  }, [now]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/classes?page=1&pageSize=50");
        const payload = (await response.json()) as {
          success: boolean;
          data?: ClassOption[];
        };

        if (cancelled) return;

        setClasses(payload.data ?? []);
      } catch {
        if (!cancelled) {
          setClassesError("Failed to load classes.");
        }
      } finally {
        if (!cancelled) setClassesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-4">
      <article className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#32598A] text-white">
              <CircleDollarSign size={18} />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">
                Monthly Fees
              </h2>
              <p className="text-xs text-slate-500">
                Fee sheet per class, year and month. The current month is
                generated and kept in sync automatically.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <button
              type="button"
              onClick={() => setIsWaiverRulesOpen(true)}
              disabled={!selectedClass}
              title={selectedClass ? "Automatic joining waiver rules" : "Select a class first"}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#b9cfe3] bg-white px-3 text-xs font-semibold text-[#264867] transition hover:bg-[#eef3f8] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ListOrdered size={14} />
              Waiver Rules
            </button>

            {classId ? (
              <div className="rounded-lg border border-[#dce7f1] bg-[#eef3f8] px-3 py-2 text-right">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[#264867]">
                  Expected total
                </p>
                <p className="text-lg font-bold text-[#1a3049]">
                  {rupees(combinedSummary.expected)}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        {/* All classes: the four amounts summed over every class shown. */}
        {!classId ? (
          <div className="rounded-lg border border-[#dce7f1] bg-[#eef3f8]/60 p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[#264867]">
              Totals · all classes · {MONTHS[month - 1]} {year}
            </p>
            <FeeSummaryAmounts summary={combinedSummary} compact />
          </div>
        ) : null}

        {/* Selectors — three matching tile pickers */}
        <div className="grid gap-3 lg:grid-cols-3">

          {/* Class */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Class
            </p>
            <div
              className="scrollbar-thin space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-1.5"
              style={{ maxHeight: selectorMaxHeight }}
            >
              <button
                type="button"
                onClick={() => setClassId("")}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                  classId === ""
                    ? "bg-[#32598A] text-white shadow-sm"
                    : "bg-white text-slate-600 hover:bg-[#eef3f8]"
                }`}
              >
                <Users
                  size={12}
                  className={`shrink-0 ${classId === "" ? "text-white" : "text-slate-400"}`}
                />
                <span>All classes</span>
              </button>

              {classesLoading ? (
                <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-slate-400">
                  <Loader2 size={12} className="animate-spin" />
                  Loading classes...
                </p>
              ) : classes.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-slate-400">No classes</p>
              ) : (
                classes.map((item) => {
                  const selected = item.id === classId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setClassId(item.id)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                        selected
                          ? "bg-[#32598A] text-white shadow-sm"
                          : "bg-white text-slate-600 hover:bg-[#eef3f8]"
                      }`}
                    >
                      <BookOpen
                        size={12}
                        className={`shrink-0 ${selected ? "text-white" : "text-slate-400"}`}
                      />
                      <span className="break-words">{item.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Year */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Year
            </p>
            <div
              className="scrollbar-thin grid grid-cols-3 gap-1.5 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-1.5"
              style={{ maxHeight: selectorMaxHeight }}
            >
              {yearOptions.map((option) => {
                const selected = option === year;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setYear(option)}
                    className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                      selected
                        ? "bg-[#32598A] text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-[#eef3f8]"
                    }`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Month — 4 per row */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Month
            </p>
            <div
              ref={monthGridRef}
              className="grid grid-cols-4 gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1.5"
            >
              {MONTHS.map((label, index) => {
                const value = index + 1;
                const selected = value === month;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setMonth(value)}
                    className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                      selected
                        ? "bg-[#32598A] text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-[#eef3f8]"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {classesError ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {classesError}
          </p>
        ) : null}

        {classId ? <PaymentAccessControl key={classId} classId={classId} /> : null}

        {classId ? (
          <ClassFeeSheetDetail
            classId={classId}
            year={year}
            month={month}
            onSummaryChange={handleSummaryChange}
          />
        ) : null}
      </article>

      {!classId ? (
        <div className="space-y-4">
          {classesLoading ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-[#b9cfe3] bg-[#eef3f8]/60 p-8 text-sm font-medium text-[#264867]">
              <Loader2 size={16} className="animate-spin" />
              Loading classes...
            </div>
          ) : classes.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              No classes yet.
            </p>
          ) : (
            classes.map((item) => (
              <article
                key={item.id}
                className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <BookOpen size={14} className="text-[#32598A]" />
                    {item.name}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setClassId(item.id)}
                    className="text-xs font-semibold text-[#264867] hover:underline"
                  >
                    Manage only this class &rarr;
                  </button>
                </div>
                <ClassFeeSheetDetail
                  classId={item.id}
                  year={year}
                  month={month}
                  onSummaryChange={handleSummaryChange}
                />
              </article>
            ))
          )}
        </div>
      ) : null}

      {isWaiverRulesOpen && selectedClass ? (
        <FeeWaiverRulesPanel
          classId={selectedClass.id}
          className={selectedClass.name}
          onClose={() => setIsWaiverRulesOpen(false)}
        />
      ) : null}
    </section>
  );
}

type ClassFeeSheetDetailProps = {
  classId: string;
  year: number;
  month: number;
  onSummaryChange?: (classId: string, summary: FeeSheetSummary) => void;
};

function ClassFeeSheetDetail({
  classId,
  year,
  month,
  onSummaryChange,
}: ClassFeeSheetDetailProps) {
  const now = useMemo(() => new Date(), []);

  const [sheet, setSheet] = useState<FeeSheet | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savingFeeId, setSavingFeeId] = useState<string | null>(null);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [feeHistory, setFeeHistory] = useState<ClassFeeHistoryEntry[]>([]);
  // Late-join deduction explanation (and its explicit reset to automatic).
  const [explainFeeId, setExplainFeeId] = useState<string | null>(null);
  const [isResettingLateJoin, setIsResettingLateJoin] = useState(false);
  // Free Cards: the selected fee rows, the running request and its outcome.
  const [selectedFeeIds, setSelectedFeeIds] = useState<Set<string>>(() => new Set());
  const [isApplyingFreeCards, setIsApplyingFreeCards] = useState(false);
  const [freeCardOutcome, setFreeCardOutcome] = useState<FreeCardOutcome | null>(null);
  // Partial payments: the fee being recorded, the payment being reversed, and
  // each fee's open recording operation (its request key survives a retry,
  // also after the dialog is closed and reopened).
  const [recordFeeId, setRecordFeeId] = useState<string | null>(null);
  const [reversePayment, setReversePayment] = useState<FeePaymentDetail | null>(null);
  const recordAttempts = useRef(new RecordAttemptStore()).current;

  useEffect(() => {
    setRecordFeeId(null);
    setReversePayment(null);
  }, [classId, year, month]);

  // A new class / year / month starts with nothing selected.
  useEffect(() => {
    setSelectedFeeIds(new Set());
    setFreeCardOutcome(null);
  }, [classId, year, month]);

  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth() + 1;
  const isFutureSelection =
    year > nowYear || (year === nowYear && month > nowMonth);
  const willProcess = !isFutureSelection;

  // Every request that replaces the whole sheet takes a sequence number; only
  // the newest one may write its result, so a slower response for an earlier
  // class/year/month can never overwrite a newer selection.
  const sheetRequestRef = useRef(0);
  // Loads only: the newest load alone ends the loading state.
  const loadRequestRef = useRef(0);

  const loadSheet = useCallback(async () => {
    if (!classId) return;

    const requestId = ++sheetRequestRef.current;
    const loadId = ++loadRequestRef.current;
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const query = new URLSearchParams({
        classId,
        year: String(year),
        month: String(month),
      });

      const response = await fetch(`/api/payments/fees?${query.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: FeeSheet;
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to load fee sheet."));
      }

      if (isLatestSheetRequestId(sheetRequestRef, requestId)) setSheet(payload.data);
    } catch (error) {
      if (!isLatestSheetRequestId(sheetRequestRef, requestId)) return;
      setSheet(null);
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to load fee sheet."
      );
    } finally {
      if (isLatestSheetRequestId(loadRequestRef, loadId)) setIsLoading(false);
    }
  }, [classId, year, month]);

  useEffect(() => {
    void loadSheet();
  }, [loadSheet]);

  // Fee history for the amount picker.
  useEffect(() => {
    if (!classId) return;
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/classes/${classId}/fee-history`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as {
          success: boolean;
          data?: ClassFeeHistoryEntry[];
        };
        if (!cancelled && payload.success) {
          setFeeHistory(payload.data ?? []);
        }
      } catch {
        if (!cancelled) setFeeHistory([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [classId]);

  async function applyAmount(
    row: FeeRow,
    amount: number,
    applyToAll: boolean
  ) {
    setSavingFeeId(row.feeId ?? "all");
    setErrorMessage(null);
    const requestId = ++sheetRequestRef.current;

    try {
      const response = await fetch("/api/payments/fees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId,
          year,
          month,
          amount,
          applyToAll,
          feeId: row.feeId,
        }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: FeeSheet;
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to update amount."));
      }

      if (isLatestSheetRequestId(sheetRequestRef, requestId)) setSheet(payload.data);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to update amount."
      );
    } finally {
      setSavingFeeId(null);
    }
  }

  async function reprocess() {
    if (!classId || isReprocessing) return;

    setIsReprocessing(true);
    setErrorMessage(null);
    const requestId = ++sheetRequestRef.current;

    try {
      const response = await fetch("/api/payments/fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classId, year, month }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: FeeSheet;
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to reprocess fees."));
      }

      if (isLatestSheetRequestId(sheetRequestRef, requestId)) setSheet(payload.data);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to reprocess fees."
      );
    } finally {
      setIsReprocessing(false);
    }
  }

  async function saveAdjustment(
    row: FeeRow,
    field: "discount" | "lateJoinDeduct" | "waiverAmount",
    rawValue: string
  ) {
    if (!row.feeId) return;

    const value = Math.max(0, Math.round(Number(rawValue) || 0));

    if (value === row[field]) return;

    setSavingFeeId(row.feeId);

    try {
      const response = await fetch(`/api/payments/fees/${row.feeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          discount: number;
          lateJoinDeduct: number;
          lateJoinDeductManual: boolean;
          waiverAmount: number;
          finalAmount: number;
        };
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to update adjustment."));
      }

      setSheet((current) => {
        if (!current) return current;
        return {
          ...current,
          rows: current.rows.map((r) =>
            r.feeId === row.feeId
              ? {
                  ...r,
                  ...payload.data!,
                  // A manual late-join deduction replaces any automatic one.
                  joinWaiver: payload.data!.lateJoinDeductManual ? null : r.joinWaiver,
                }
              : r
          ),
        };
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to update adjustment."
      );
      // Reload to restore the correct values.
      void loadSheet();
    } finally {
      setSavingFeeId(null);
    }
  }

  async function resetLateJoinToAutomatic(row: FeeRow) {
    if (!row.feeId || isResettingLateJoin) return;

    const confirmed = window.confirm(
      `Reset ${row.studentName}'s late-join deduction to the automatic calculation? The manually entered amount will be replaced.`
    );
    if (!confirmed) return;

    setIsResettingLateJoin(true);

    try {
      const response = await fetch(`/api/payments/fees/${row.feeId}/reset-late-join`, {
        method: "POST",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to reset the late-join deduction."));
      }

      toast.success("Late-join deduction reset to automatic.");
      setExplainFeeId(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to reset the late-join deduction."
      );
    } finally {
      setIsResettingLateJoin(false);
      // Reload either way: shows the new automatic values, or the newer data
      // that won a conflict.
      void loadSheet();
    }
  }

  const selectedIds = effectiveSelection(selectedFeeIds, currentSheetRows(sheet, { classId, year, month }));
  const selectedRows = (sheet?.rows ?? []).filter((row) => row.feeId && selectedIds.includes(row.feeId));
  const selectableCount = selectableFeeIds(currentSheetRows(sheet, { classId, year, month })).length;

  async function applyFreeCards(action: FreeCardAction) {
    if (selectedIds.length === 0 || isApplyingFreeCards) return;
    if (!window.confirm(freeCardConfirmText(action, selectedIds.length, `${MONTHS[month - 1]} ${year}`))) {
      return;
    }

    setIsApplyingFreeCards(true);
    setErrorMessage(null);
    const requestId = ++sheetRequestRef.current;

    try {
      const response = await fetch("/api/payments/fees/free-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classId, year, month, feeIds: selectedIds, action }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: FreeCardOutcome & { sheet: FeeSheet };
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to update Free Cards."));
      }

      const { sheet: nextSheet, ...outcome } = payload.data;
      if (isLatestSheetRequestId(sheetRequestRef, requestId)) setSheet(nextSheet);
      setFreeCardOutcome(outcome);
      setSelectedFeeIds(new Set());
      toast.success(freeCardOutcomeText(outcome));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update Free Cards.");
      // Show the current state (nothing or part of it may have changed).
      void loadSheet();
    } finally {
      setIsApplyingFreeCards(false);
    }
  }

  const explainRow = explainFeeId
    ? sheet?.rows.find((r) => r.feeId === explainFeeId) ?? null
    : null;

  // The summary only ever describes the selected class, year and month: a
  // sheet still on screen from an earlier selection is not summarised.
  const currentSheet = sheetMatchesSelection(sheet, { classId, year, month }) ? sheet : null;

  const recordRow = useMemo(() => {
    const row = currentSheet?.rows.find((r) => r.feeId !== null && r.feeId === recordFeeId);
    return row ? { ...row, feeId: row.feeId as string } : null;
  }, [currentSheet, recordFeeId]);

  const summary = useMemo(
    () => summarizeFeeRows(currentSheet?.rows, currentSheet?.isPastDue === true),
    [currentSheet]
  );

  // Report to the All classes totals once this selection has settled (zero
  // amounts when it failed to load), never while a new selection loads.
  useEffect(() => {
    if (isLoading) return;
    onSummaryChange?.(classId, summary);
  }, [classId, summary, isLoading, onSummaryChange]);

  return (
    <div className="space-y-4">
        {/* Status strip */}
        {currentSheet ? (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Current class fee
                </p>
                <p className="text-sm font-bold text-slate-900">
                  {rupees(currentSheet.currentFee)}
                </p>
                {currentSheet.periodFee !== currentSheet.currentFee ? (
                  <p className="text-[10px] text-slate-400">
                    Applied this month: {rupees(currentSheet.periodFee)}
                  </p>
                ) : null}
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Due date (week {currentSheet.class.paymentDueWeek})
                </p>
                <p className="text-sm font-bold text-slate-900">
                  {formatStoredSriLankaDate(currentSheet.dueDate)}
                  {currentSheet.isPastDue ? (
                    <span className="ml-1 rounded bg-rose-100 px-1 py-0.5 text-[10px] font-semibold text-rose-600">
                      Past due
                    </span>
                  ) : currentSheet.isDueSoon ? (
                    <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-600">
                      Due soon
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Students
                </p>
                <p className="text-sm font-bold text-slate-900">
                  {currentSheet.rows.length}
                </p>
              </div>
            </div>
            <FeeSummaryAmounts summary={summary} isPastDue={currentSheet.isPastDue} />
          </div>
        ) : null}

        {errorMessage ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {errorMessage}
          </p>
        ) : null}

        {/* Processing / loading */}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-[#b9cfe3] bg-[#eef3f8]/60 py-8 text-sm font-medium text-[#264867]">
            <Loader2 size={16} className="animate-spin" />
            {willProcess
              ? "Processing fees for this month..."
              : "Loading fee records..."}
          </div>
        ) : null}

        {/* Table */}
        {!isLoading && sheet ? (
          <>
          {!sheet.isFuturePeriod ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                {MONTHS[month - 1]} {year} · {sheet.rows.length}{" "}
                {sheet.rows.length === 1 ? "student" : "students"}
              </p>
              <button
                type="button"
                onClick={() => void reprocess()}
                disabled={isReprocessing}
                title="Recompute every fee from the fee applicable at the due date and refresh paid/unpaid status"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#b9cfe3] bg-[#eef3f8] px-3 py-1.5 text-xs font-semibold text-[#264867] transition hover:bg-[#dce7f1] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RefreshCw
                  size={13}
                  className={isReprocessing ? "animate-spin" : ""}
                />
                {isReprocessing ? "Reprocessing..." : "Reprocess"}
              </button>
            </div>
          ) : null}

          {!sheet.isFuturePeriod && sheet.rows.length > 0 ? (
            <FreeCardToolbar
              selectedCount={selectedIds.length}
              selectableCount={selectableCount}
              canIssue={selectedRows.some((row) => !row.freeCard)}
              canRevoke={selectedRows.some((row) => row.freeCard)}
              busy={isApplyingFreeCards}
              onToggleAll={() => setSelectedFeeIds((current) => toggleAllSelection(current, sheet.rows))}
              onIssue={() => void applyFreeCards("issue")}
              onRevoke={() => void applyFreeCards("revoke")}
            />
          ) : null}

          {freeCardOutcome ? (
            <FreeCardResultPanel outcome={freeCardOutcome} onDismiss={() => setFreeCardOutcome(null)} />
          ) : null}

          {sheet.rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 py-8 text-center">
              <Users size={22} className="mx-auto text-slate-300" />
              <p className="mt-2 text-sm font-medium text-slate-600">
                No fee records for {MONTHS[month - 1]} {year}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {sheet.isFuturePeriod
                  ? "This month has not started yet."
                  : sheet.isCurrentPeriod
                  ? "No active students in this class."
                  : "No students were enrolled in this class during this month."}
              </p>
            </div>
          ) : (
            <>
              {/*
                Below xl there isn't room for the sidebar (256px) plus this
                table's 860px minimum without horizontal scrolling, so each
                student renders as its own card instead — same data, same
                editable amount/discount/late-deduct/waiver controls and the
                same expand-to-view-payment-history behaviour, just stacked.
              */}
              <div className="space-y-3 xl:hidden">
                {sheet.rows.map((row) => {
                  // Any received payment freezes the row (partial payments too).
                  const paidLocked = row.paymentStatus === "PAID" || row.paymentStatus === "PARTIAL";
                  // An active Free Card also locks the adjustments (kept
                  // unchanged underneath until the card is revoked).
                  const locked =
                    !row.feeId ||
                    savingFeeId === row.feeId ||
                    paidLocked ||
                    row.freeCard;
                  const selectable = Boolean(row.feeId) && !paidLocked;
                  const rowKey = row.feeId ?? row.classStudentId;
                  const isExpanded = expandedRowKey === rowKey;
                  const stop = (event: React.MouseEvent) =>
                    event.stopPropagation();

                  return (
                    <div
                      key={rowKey}
                      className={`overflow-hidden rounded-xl border border-slate-200 ${
                        isExpanded ? "bg-slate-50" : "bg-white"
                      }`}
                    >
                      <div className="flex items-start">
                      {!sheet.isFuturePeriod ? (
                        <label className="flex shrink-0 items-center py-3 pl-3">
                          <input
                            type="checkbox"
                            checked={Boolean(row.feeId) && selectedIds.includes(row.feeId!)}
                            disabled={!selectable || isApplyingFreeCards}
                            onChange={() =>
                              row.feeId && setSelectedFeeIds((current) => toggleSelection(current, row.feeId!))
                            }
                            aria-label={`Select ${row.studentName}`}
                            className="h-4 w-4 rounded border-slate-300 accent-violet-600"
                          />
                        </label>
                      ) : null}
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedRowKey((current) =>
                            current === rowKey ? null : rowKey
                          )
                        }
                        className="flex min-w-0 flex-1 items-start justify-between gap-2 p-3 text-left"
                      >
                        <div className="flex min-w-0 items-start gap-1.5">
                          {isExpanded ? (
                            <ChevronDown size={13} className="mt-0.5 shrink-0 text-slate-400" />
                          ) : (
                            <ChevronRight size={13} className="mt-0.5 shrink-0 text-slate-400" />
                          )}
                          <div className="min-w-0">
                            <p className="break-words text-xs font-semibold text-slate-900">
                              {row.studentName}
                            </p>
                            {row.registrationNumber ? (
                              <p className="text-[10px] text-slate-400">
                                {row.registrationNumber}
                              </p>
                            ) : null}
                          </div>
                        </div>

                        <div className="shrink-0">
                          {row.paymentStatus === "FREE_CARD" ? (
                            <FreeCardBadge />
                          ) : row.paymentStatus === "PARTIAL" ? (
                            <PartialBadge outstanding={row.paymentSummary?.outstanding ?? null} />
                          ) : row.paymentStatus === "PAID" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              <BadgeCheck size={10} />
                              Paid
                            </span>
                          ) : row.paymentStatus === "PENDING" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                              <Clock3 size={10} />
                              Pending
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                              Unpaid
                            </span>
                          )}
                        </div>
                      </button>
                      </div>

                      <div
                        className="grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-slate-100 px-3 py-3 text-xs"
                        onClick={stop}
                      >
                        <div className="col-span-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Assigned
                          </p>
                          <div className="mt-0.5 space-y-0.5">
                            {(row.enrolments.length > 0
                              ? row.enrolments
                              : [{ assignedAt: row.assignedAt, removedAt: null }]
                            ).map((period, index) => (
                              <div key={index} className="leading-tight">
                                <span className="text-slate-500">
                                  {formatStoredSriLankaDate(period.assignedAt)}
                                </span>
                                {period.removedAt ? (
                                  <span className="block text-[10px] font-medium text-rose-500">
                                    Removed {formatStoredSriLankaDate(period.removedAt)}
                                  </span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Amount
                          </p>
                          <div className="mt-0.5">
                            <AmountCell
                              row={row}
                              feeHistory={feeHistory}
                              currentFee={sheet.currentFee}
                              studentCount={sheet.rows.length}
                              paid={paidLocked}
                              freeCard={row.freeCard}
                              busy={
                                savingFeeId === row.feeId || savingFeeId === "all"
                              }
                              onApply={(amount, applyToAll) =>
                                void applyAmount(row, amount, applyToAll)
                              }
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Final
                          </p>
                          <p className="mt-0.5 font-bold text-slate-900">
                            {rupees(row.finalAmount)}
                          </p>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Discount
                          </p>
                          <div className="mt-0.5">
                            <AdjustInput
                              defaultValue={row.discount}
                              disabled={locked}
                              onCommit={(value) =>
                                void saveAdjustment(row, "discount", value)
                              }
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Late deduct
                          </p>
                          <div className="mt-0.5 flex items-center gap-1">
                            <AdjustInput
                              defaultValue={row.lateJoinDeduct}
                              disabled={locked}
                              onCommit={(value) =>
                                void saveAdjustment(row, "lateJoinDeduct", value)
                              }
                            />
                            <LateJoinInfoButton
                              row={row}
                              onOpen={() => row.feeId && setExplainFeeId(row.feeId)}
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Waiver
                          </p>
                          <div className="mt-0.5">
                            <AdjustInput
                              defaultValue={row.waiverAmount}
                              disabled={locked}
                              onCommit={(value) =>
                                void saveAdjustment(row, "waiverAmount", value)
                              }
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Due date
                          </p>
                          <p className="mt-0.5 text-slate-500">
                            {formatStoredSriLankaDate(row.dueDate)}
                          </p>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="border-t border-slate-100 bg-slate-50/70 p-3" onClick={stop}>
                          <FeePaymentSection
                            row={row}
                            classId={sheet.class.id}
                            isFuturePeriod={sheet.isFuturePeriod}
                            onChanged={loadSheet}
                            onRecord={() => setRecordFeeId(row.feeId)}
                            onReverse={setReversePayment}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 xl:block">
              <table className="w-full min-w-[860px] text-left text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    {!sheet.isFuturePeriod ? (
                      <th className="w-8 py-2 pl-3 font-semibold">
                        <span className="sr-only">Select</span>
                      </th>
                    ) : null}
                    <th className="px-3 py-2 font-semibold">Student</th>
                    <th className="px-3 py-2 font-semibold">Assigned</th>
                    <th className="px-3 py-2 font-semibold">Amount</th>
                    <th className="px-3 py-2 font-semibold">Discount</th>
                    <th className="px-3 py-2 font-semibold">Late deduct</th>
                    <th className="px-3 py-2 font-semibold">Waiver</th>
                    <th className="px-3 py-2 font-semibold">Final</th>
                    <th className="px-3 py-2 font-semibold">Due date</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sheet.rows.map((row) => {
                    // A confirmed payment freezes the whole row; an active
                    // Free Card locks the adjustments (kept underneath).
                    // Any received payment freezes the row (partial payments too).
                    const paidLocked = row.paymentStatus === "PAID" || row.paymentStatus === "PARTIAL";
                    const locked =
                      !row.feeId ||
                      savingFeeId === row.feeId ||
                      paidLocked ||
                      row.freeCard;
                    const selectable = Boolean(row.feeId) && !paidLocked;
                    const rowKey = row.feeId ?? row.classStudentId;
                    const isExpanded = expandedRowKey === rowKey;
                    const stop = (event: React.MouseEvent) =>
                      event.stopPropagation();

                    return (
                      <Fragment key={rowKey}>
                      <tr
                        onClick={() =>
                          setExpandedRowKey((current) =>
                            current === rowKey ? null : rowKey
                          )
                        }
                        className={`cursor-pointer align-middle transition hover:bg-slate-50 ${
                          isExpanded ? "bg-slate-50" : ""
                        }`}
                      >
                        {!sheet.isFuturePeriod ? (
                          <td className="py-2 pl-3" onClick={stop}>
                            <input
                              type="checkbox"
                              checked={Boolean(row.feeId) && selectedIds.includes(row.feeId!)}
                              disabled={!selectable || isApplyingFreeCards}
                              onChange={() =>
                                row.feeId && setSelectedFeeIds((current) => toggleSelection(current, row.feeId!))
                              }
                              aria-label={`Select ${row.studentName}`}
                              className="h-4 w-4 rounded border-slate-300 accent-violet-600"
                            />
                          </td>
                        ) : null}
                        <td className="px-3 py-2">
                          <div className="flex items-start gap-1.5">
                            {isExpanded ? (
                              <ChevronDown size={13} className="mt-0.5 shrink-0 text-slate-400" />
                            ) : (
                              <ChevronRight size={13} className="mt-0.5 shrink-0 text-slate-400" />
                            )}
                            <div>
                              <p className="font-semibold text-slate-900">
                                {row.studentName}
                              </p>
                              {row.registrationNumber ? (
                                <p className="text-[10px] text-slate-400">
                                  {row.registrationNumber}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="space-y-0.5">
                            {(row.enrolments.length > 0
                              ? row.enrolments
                              : [{ assignedAt: row.assignedAt, removedAt: null }]
                            ).map((period, index) => (
                              <div key={index} className="leading-tight">
                                <span className="text-slate-500">
                                  {formatStoredSriLankaDate(period.assignedAt)}
                                </span>
                                {period.removedAt ? (
                                  <span className="block text-[10px] font-medium text-rose-500">
                                    Removed {formatStoredSriLankaDate(period.removedAt)}
                                  </span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2" onClick={stop}>
                          <AmountCell
                            row={row}
                            feeHistory={feeHistory}
                            currentFee={sheet.currentFee}
                            studentCount={sheet.rows.length}
                            paid={paidLocked}
                            freeCard={row.freeCard}
                            busy={
                              savingFeeId === row.feeId || savingFeeId === "all"
                            }
                            onApply={(amount, applyToAll) =>
                              void applyAmount(row, amount, applyToAll)
                            }
                          />
                        </td>
                        <td className="px-3 py-2" onClick={stop}>
                          <AdjustInput
                            defaultValue={row.discount}
                            disabled={locked}
                            onCommit={(value) =>
                              void saveAdjustment(row, "discount", value)
                            }
                          />
                        </td>
                        <td className="px-3 py-2" onClick={stop}>
                          <div className="flex items-center gap-1">
                            <AdjustInput
                              defaultValue={row.lateJoinDeduct}
                              disabled={locked}
                              onCommit={(value) =>
                                void saveAdjustment(row, "lateJoinDeduct", value)
                              }
                            />
                            <LateJoinInfoButton
                              row={row}
                              onOpen={() => row.feeId && setExplainFeeId(row.feeId)}
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2" onClick={stop}>
                          <AdjustInput
                            defaultValue={row.waiverAmount}
                            disabled={locked}
                            onCommit={(value) =>
                              void saveAdjustment(row, "waiverAmount", value)
                            }
                          />
                        </td>
                        <td className="px-3 py-2 font-bold text-slate-900">
                          {rupees(row.finalAmount)}
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {formatStoredSriLankaDate(row.dueDate)}
                        </td>
                        <td className="px-3 py-2">
                          {row.paymentStatus === "FREE_CARD" ? (
                            <FreeCardBadge />
                          ) : row.paymentStatus === "PARTIAL" ? (
                            <PartialBadge outstanding={row.paymentSummary?.outstanding ?? null} />
                          ) : row.paymentStatus === "PAID" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              <BadgeCheck size={10} />
                              Paid
                            </span>
                          ) : row.paymentStatus === "PENDING" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                              <Clock3 size={10} />
                              Pending
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                              Unpaid
                            </span>
                          )}
                        </td>
                      </tr>

                      {isExpanded ? (
                        <tr className="bg-slate-50/70">
                          <td colSpan={sheet.isFuturePeriod ? 9 : 10} className="px-3 pb-3 pt-1">
                            <FeePaymentSection
                              row={row}
                              classId={sheet.class.id}
                              isFuturePeriod={sheet.isFuturePeriod}
                              onChanged={loadSheet}
                              onRecord={() => setRecordFeeId(row.feeId)}
                              onReverse={setReversePayment}
                            />
                          </td>
                        </tr>
                      ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </>
          )}
          </>
        ) : null}

      {recordRow && sheet ? (
        <RecordPaymentDialog
          key={recordRow.feeId}
          classId={sheet.class.id}
          row={recordRow}
          attempts={recordAttempts}
          onRecorded={async ({ replayed }) => {
            setRecordFeeId(null);
            toast.success(replayed ? "This payment was already recorded." : "Payment recorded.");
            await loadSheet();
          }}
          onRefresh={loadSheet}
          onClose={() => setRecordFeeId(null)}
        />
      ) : null}

      {reversePayment && sheet ? (
        <ReversePaymentDialog
          key={reversePayment.id}
          classId={sheet.class.id}
          payment={reversePayment}
          onReversed={async () => {
            setReversePayment(null);
            toast.success("Payment reversed. The amount is outstanding again.");
            await loadSheet();
          }}
          onRefresh={loadSheet}
          onClose={() => setReversePayment(null)}
        />
      ) : null}

      {explainRow && sheet ? (
        <LateJoinExplanation
          row={explainRow}
          joinWaiversActive={sheet.joinWaiversActive}
          isResetting={isResettingLateJoin}
          onReset={() => void resetLateJoinToAutomatic(explainRow)}
          onClose={() => setExplainFeeId(null)}
        />
      ) : null}
    </div>
  );
}

function AmountCell({
  row,
  feeHistory,
  currentFee,
  studentCount,
  paid,
  freeCard,
  busy,
  onApply,
}: {
  row: FeeRow;
  feeHistory: ClassFeeHistoryEntry[];
  currentFee: number;
  studentCount: number;
  paid?: boolean;
  /** Active Free Card: this student's amount is not edited (revoke first). */
  freeCard?: boolean;
  busy?: boolean;
  onApply: (amount: number, applyToAll: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(currentFee);
  const [applyToAll, setApplyToAll] = useState(true);

  const differs = row.amount !== currentFee;

  useEffect(() => {
    if (open) {
      setSelected(currentFee);
      setApplyToAll(true);
    }
  }, [open, currentFee]);

  const options = useMemo(() => {
    const seen = new Set<number>();
    const list: { amount: number; label: string; current: boolean }[] = [];

    if (!seen.has(currentFee)) {
      seen.add(currentFee);
      list.push({
        amount: currentFee,
        current: true,
        label: "Current class fee",
      });
    }

    for (const entry of feeHistory) {
      if (seen.has(entry.amount)) continue;
      seen.add(entry.amount);
      list.push({
        amount: entry.amount,
        current: entry.isCurrent,
        label: `${formatStoredSriLankaDate(entry.effectiveFrom)} – ${
          entry.effectiveTo
            ? formatStoredSriLankaDate(entry.effectiveTo)
            : "Present"
        }`,
      });
    }

    if (!seen.has(row.amount)) {
      list.push({
        amount: row.amount,
        current: false,
        label: "This row's amount",
      });
    }

    return list;
  }, [feeHistory, currentFee, row.amount]);

  function confirmAndApply() {
    const scopeLabel = applyToAll
      ? `all ${studentCount} student${studentCount === 1 ? "" : "s"}`
      : row.studentName;

    if (
      window.confirm(
        `Update the amount for ${scopeLabel} to ${rupees(selected)}?`
      )
    ) {
      onApply(selected, applyToAll);
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-slate-700">{rupees(row.amount)}</span>

        {paid ? (
          <span className="text-[10px] leading-tight text-slate-400">
            Locked — student has paid
          </span>
        ) : freeCard ? (
          <span className="text-[10px] leading-tight text-violet-600">
            Free Card — Rs. 0 payable
          </span>
        ) : differs ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] leading-tight text-amber-600">
              Applied by the class fee before the due date
            </span>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="rounded border border-[#b9cfe3] bg-[#eef3f8] px-1.5 py-0.5 text-[10px] font-semibold text-[#264867] transition hover:bg-[#dce7f1]"
            >
              Change
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="w-fit text-[10px] font-medium text-slate-400 underline decoration-dotted underline-offset-2 hover:text-[#32598A]"
          >
            Change
          </button>
        )}
      </div>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-[min(16rem,calc(100vw-2.5rem))] rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Change amount
            </p>

            <div className="mt-1.5 max-h-44 space-y-1 overflow-y-auto scrollbar-thin">
              {options.map((option) => (
                <label
                  key={option.amount}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition ${
                    selected === option.amount
                      ? "border-[#8fb0cd] bg-[#eef3f8]"
                      : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="radio"
                    checked={selected === option.amount}
                    onChange={() => setSelected(option.amount)}
                  />
                  <span className="font-bold text-slate-900">
                    {rupees(option.amount)}
                  </span>
                  {option.current ? (
                    <span className="rounded-full bg-[#32598A] px-1.5 text-[9px] font-semibold text-white">
                      Current
                    </span>
                  ) : null}
                  <span className="ml-auto text-[9px] text-slate-400">
                    {option.label}
                  </span>
                </label>
              ))}
            </div>

            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(event) => setApplyToAll(event.target.checked)}
              />
              Apply to all students
            </label>

            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={confirmAndApply}
                className="rounded-md bg-[#32598A] px-3 py-1 text-xs font-semibold text-white transition hover:bg-[#264867] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Updating..." : "Update"}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The expanded row: the fee's payment position (the server's figures), the
 * Record payment action and the full payment history.
 */
function FeePaymentSection({
  row,
  classId,
  isFuturePeriod,
  onChanged,
  onRecord,
  onReverse,
}: {
  row: FeeRow;
  classId: string;
  isFuturePeriod: boolean;
  onChanged: () => void | Promise<void>;
  onRecord: () => void;
  onReverse: (payment: FeePaymentDetail) => void;
}) {
  return (
    <div className="space-y-2">
      {row.feeId ? <FeePaymentPosition state={row.paymentStatus} summary={row.paymentSummary} /> : null}
      <RecordPaymentButton block={recordPaymentBlock(row, isFuturePeriod)} onClick={onRecord} />
      <PaymentAccordion
        payments={row.payments}
        finalAmount={row.finalAmount}
        classId={classId}
        onChanged={onChanged}
        onReverse={onReverse}
      />
    </div>
  );
}

function PaymentAccordion({
  payments,
  finalAmount,
  classId,
  onChanged,
  onReverse,
}: {
  payments: FeePaymentDetail[];
  finalAmount: number;
  classId: string;
  onChanged: () => void | Promise<void>;
  onReverse: (payment: FeePaymentDetail) => void;
}) {
  if (payments.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-3 text-xs text-slate-500">
        No payment submitted for this month yet.
        <span className="ml-1 text-slate-400">
          (Expected {rupees(finalAmount)})
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {payments.map((payment) => (
        <PaymentReviewCard
          key={payment.id}
          payment={payment}
          classId={classId}
          onChanged={onChanged}
          onReverse={() => onReverse(payment)}
        />
      ))}
    </div>
  );
}

export function PaymentReviewCard({
  payment,
  classId,
  onChanged,
  onReverse,
}: {
  payment: FeePaymentDetail;
  classId: string;
  onChanged: () => void | Promise<void>;
  onReverse?: () => void;
}) {
  const [busy, setBusy] = useState<null | "CONFIRMED" | "NEEDS_CLARIFICATION">(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  const recorded = payment.source === "TEACHER_RECORDED";
  const reversed = Boolean(payment.reversed || payment.reversal);

  const tone = reversed
    ? "border-slate-300 bg-slate-100"
    : payment.status === "CONFIRMED"
      ? "border-emerald-200 bg-emerald-50"
      : payment.status === "NEEDS_CLARIFICATION"
      ? "border-rose-200 bg-rose-50"
      : "border-amber-200 bg-amber-50";

  const label = reversed
    ? "Reversed"
    : payment.status === "CONFIRMED"
      ? "Confirmed"
      : payment.status === "NEEDS_CLARIFICATION"
      ? "Needs clarification"
      : "Pending review";

  async function act(status: "CONFIRMED" | "NEEDS_CLARIFICATION") {
    if (status === "NEEDS_CLARIFICATION" && feedback.trim().length < 3) {
      toast.error("Add a short note explaining what the student should fix.");
      return;
    }
    setBusy(status);
    try {
      const res = await fetch(`/api/classes/${classId}/payments/${payment.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, feedback: feedback.trim() || undefined }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message?: string } };
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message ?? "Action failed.");
      }
      toast.success(status === "CONFIRMED" ? "Payment confirmed." : "Clarification requested.");
      setShowFeedback(false);
      setFeedback("");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  // The slip review applies to student slips only; a recorded payment is
  // corrected by a reversal.
  const canAct = payment.status !== "CONFIRMED" && !recorded;

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-xs ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`font-bold ${reversed ? "text-slate-500 line-through" : "text-slate-900"}`}>
          {rupees(payment.amount)}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
            {recorded ? "Recorded by teacher" : "Student slip"}
          </span>
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
            {label}
          </span>
        </span>
      </div>

      {recorded ? <RecordedPaymentDetails payment={payment} /> : null}

      <div className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
        <p className="text-slate-600">
          {recorded ? "Recorded" : "Submitted"}: {formatStoredSriLankaDateTime(payment.submittedAt)}
        </p>
        {payment.confirmedAt ? (
          <p className="text-slate-600">
            Confirmed: {formatStoredSriLankaDateTime(payment.confirmedAt)}
          </p>
        ) : null}
      </div>

      {payment.note ? (
        <p className="mt-1.5 text-slate-700">
          <span className="font-semibold">{recorded ? "Note:" : "Student note:"}</span> {payment.note}
        </p>
      ) : null}
      {payment.teacherFeedback ? (
        <p className="mt-0.5 text-slate-700">
          <span className="font-semibold">Your feedback:</span> {payment.teacherFeedback}
        </p>
      ) : null}

      {payment.reversal ? <ReversalDetails reversal={payment.reversal} /> : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {recorded ? null : payment.hasSlip ? (
          <a
            href={`/api/payments/${payment.id}/slip`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            <FileText size={11} />
            View slip <ExternalLink size={9} />
          </a>
        ) : (
          <span className="text-[11px] text-slate-400">No slip attached</span>
        )}

        {canAct ? (
          <>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act("CONFIRMED")}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <CheckCircle2 size={11} />
              {busy === "CONFIRMED" ? "Confirming…" : "Confirm payment"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setShowFeedback((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2 py-1 text-[11px] font-semibold text-amber-700 hover:bg-amber-50"
            >
              <MessageCircleWarning size={11} />
              Request clarification
            </button>
          </>
        ) : null}

        {onReverse && canReversePayment(payment) ? (
          <button
            type="button"
            onClick={onReverse}
            className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50"
          >
            <RotateCcw size={11} />
            Reverse payment
          </button>
        ) : null}
      </div>

      {showFeedback && canAct ? (
        <div className="mt-2 rounded-lg border border-amber-200 bg-white p-2">
          <textarea
            rows={2}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should the student correct or re-send?"
            className="w-full resize-none rounded-md border border-amber-200 bg-white px-2 py-1 text-[11px] outline-none focus:border-amber-400"
          />
          <div className="mt-1 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setShowFeedback(false)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act("NEEDS_CLARIFICATION")}
              className="rounded-lg bg-amber-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy === "NEEDS_CLARIFICATION" ? "Sending…" : "Send request"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AdjustInput({
  defaultValue,
  disabled,
  onCommit,
}: {
  defaultValue: number;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(String(defaultValue));
  const lastCommitted = useRef(String(defaultValue));

  useEffect(() => {
    setValue(String(defaultValue));
    lastCommitted.current = String(defaultValue);
  }, [defaultValue]);

  function commit() {
    if (value === lastCommitted.current) return;
    lastCommitted.current = value;
    onCommit(value);
  }

  return (
    <input
      type="number"
      min={0}
      inputMode="numeric"
      value={value}
      disabled={disabled}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      className="h-8 w-24 rounded-md border border-slate-200 px-2 text-xs text-slate-700 outline-none transition focus:border-[#3d6690] disabled:cursor-not-allowed disabled:bg-slate-50"
    />
  );
}

// ---- Automatic joining waiver UI ---------------------------------------------------

/** Small button beside a Late deduct input: opens its explanation. */
function LateJoinInfoButton({ row, onOpen }: { row: FeeRow; onOpen: () => void }) {
  const label = row.lateJoinDeductManual
    ? "Manual late-join deduction"
    : row.joinWaiver
      ? `Automatic: rule ${row.joinWaiver.sequence}`
      : "Late-join deduction details";

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      disabled={!row.feeId}
      title={label}
      aria-label={label}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-40 ${
        row.lateJoinDeductManual
          ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
          : row.joinWaiver
            ? "border-[#b9cfe3] bg-[#eef3f8] text-[#264867] hover:bg-[#dce7f1]"
            : "border-slate-200 bg-white text-slate-400 hover:bg-slate-50"
      }`}
    >
      <Info size={13} />
    </button>
  );
}

/** Explanation of a row's late-join deduction (automatic, manual or none). */
function LateJoinExplanation({
  row,
  joinWaiversActive,
  isResetting,
  onReset,
  onClose,
}: {
  row: FeeRow;
  joinWaiversActive: boolean;
  isResetting: boolean;
  onReset: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const paid = row.paymentStatus === "PAID" || row.paymentStatus === "PARTIAL";
  const waiver = row.joinWaiver;

  // Portalled to <body>: inside the sheet's space-y containers the overlay
  // would inherit a top margin and leave a strip of the page uncovered.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="late-join-explanation-title"
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="late-join-explanation-title" className="text-sm font-semibold text-slate-900">
              Late-join deduction
            </h3>
            <p className="truncate text-xs text-slate-500">
              {row.studentName}
              {row.registrationNumber ? ` (${row.registrationNumber})` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={16} />
          </button>
        </div>

        {row.lateJoinDeductManual ? (
          <div className="mt-3 space-y-3">
            <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
              Manual
            </span>
            <p className="text-xs leading-relaxed text-slate-600">
              Entered manually by the teacher: <strong>{rupees(row.lateJoinDeduct)}</strong>. Automatic
              joining waivers never change a manual deduction.
            </p>
            {paid ? (
              <p className="text-xs text-slate-500">This invoice is paid, so it can no longer change.</p>
            ) : row.freeCard ? (
              <p className="text-xs text-slate-500">
                This student has a Free Card for this month. Revoke it before resetting the deduction.
              </p>
            ) : !joinWaiversActive ? (
              <p className="text-xs text-slate-500">
                Automatic joining waivers do not apply to this month, so it cannot be reset.
              </p>
            ) : (
              <button
                type="button"
                onClick={onReset}
                disabled={isResetting}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#b9cfe3] bg-white px-3 text-xs font-semibold text-[#264867] transition hover:bg-[#eef3f8] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isResetting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                Reset to automatic
              </button>
            )}
          </div>
        ) : waiver ? (
          <div className="mt-3 space-y-3">
            <span className="inline-flex rounded-full bg-[#dce7f1] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#264867]">
              Automatic
            </span>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-slate-500">Rule applied</dt>
              <dd className="font-semibold text-slate-900">
                Rule {waiver.sequence} · {describeRule(waiver)}
                {waiver.type === "PERCENTAGE" ? " (percentage)" : " (fixed amount)"}
              </dd>
              <dt className="text-slate-500">Joined</dt>
              <dd className="text-slate-900">{formatSriLankaDateTime(waiver.enrolledAt)} (Sri Lanka)</dd>
              <dt className="text-slate-500">Completed lectures before joining</dt>
              <dd className="text-slate-900">{waiver.lecturesBefore}</dd>
              <dt className="text-slate-500">Original fee</dt>
              <dd className="text-slate-900">{rupees(waiver.baseAmount)}</dd>
              <dt className="text-slate-500">Deducted</dt>
              <dd className="font-semibold text-slate-900">{rupees(row.lateJoinDeduct)}</dd>
            </dl>
            <p className="text-[11px] leading-relaxed text-slate-500">
              Only one rule applies: rule {waiver.sequence} for {waiver.lecturesBefore} completed
              lecture{waiver.lecturesBefore === 1 ? "" : "s"} held this month before the student joined.
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              No automatic waiver
            </span>
            <p className="text-xs leading-relaxed text-slate-600">
              {joinWaiversActive
                ? "No joining waiver applies: the student did not join this month after completed lectures, or the class has no waiver rules."
                : "Automatic joining waivers do not apply to this month."}
            </p>
            {row.lateJoinDeduct > 0 ? (
              <p className="text-xs text-slate-600">Current deduction: {rupees(row.lateJoinDeduct)}</p>
            ) : null}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

/** Side panel: the selected class's sequential joining-waiver rules. */
function FeeWaiverRulesPanel({
  classId,
  className,
  onClose,
}: {
  classId: string;
  className: string;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<WaiverRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [newType, setNewType] = useState<WaiverRuleType>("PERCENTAGE");
  const [newValue, setNewValue] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editType, setEditType] = useState<WaiverRuleType>("PERCENTAGE");
  const [editValue, setEditValue] = useState("");

  const endpoint = `/api/classes/${classId}/fee-waiver-rules`;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        const payload = (await response.json()) as { success: boolean; data?: { rules: WaiverRule[] } };
        if (!response.ok || !payload.success || !payload.data) {
          throw new Error(readApiError(payload, "Failed to load waiver rules."));
        }
        if (!cancelled) setRules(payload.data.rules);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : "Failed to load waiver rules.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  async function send(url: string, method: "POST" | "PUT" | "DELETE", body?: unknown) {
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: { rules: WaiverRule[] };
        message?: string;
      };
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to save the waiver rules."));
      }
      setRules(payload.data.rules);
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save the waiver rules.");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function addRule() {
    if (await send(endpoint, "POST", { type: newType, value: Number(newValue) })) {
      setNewValue("");
      toast.success("Waiver rule added.");
    }
  }

  async function saveEdit(ruleId: string) {
    if (await send(`${endpoint}/${ruleId}`, "PUT", { type: editType, value: Number(editValue) })) {
      setEditingId(null);
      toast.success("Waiver rule updated.");
    }
  }

  async function removeRule(rule: WaiverRule) {
    const confirmed = window.confirm(
      `Remove rule ${rule.sequence} (${describeRule(rule)})? Later rules move up one position. Existing invoices keep the rule they already used.`
    );
    if (!confirmed) return;
    if (await send(`${endpoint}/${rule.id}`, "DELETE")) {
      toast.success("Waiver rule removed.");
    }
  }

  const atLimit = rules.length >= MAX_WAIVER_RULES;

  // Portalled to <body> (see LateJoinExplanation).
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="fee-waiver-rules-title"
        className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
          <div className="min-w-0">
            <h3 id="fee-waiver-rules-title" className="text-sm font-semibold text-slate-900">
              Waiver Rules
            </h3>
            <p className="truncate text-xs text-slate-500">{className}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <p className="rounded-lg border border-[#dce7f1] bg-[#eef3f8] p-3 text-[11px] leading-relaxed text-[#264867]">
            Rule N applies when N completed lectures of the billing month were held before the student
            joined. Only one rule applies, and rules are never added together. If more lectures were
            held than there are rules, the last rule applies. The current month updates automatically
            until its due date; use Reprocess for later or past months.
          </p>

          {errorMessage ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {errorMessage}
            </p>
          ) : null}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Rules</p>
              <p className="text-[10px] font-semibold text-slate-400">
                {rules.length} / {MAX_WAIVER_RULES}
              </p>
            </div>

            {isLoading ? (
              <p className="flex items-center gap-1.5 text-xs text-slate-400">
                <Loader2 size={12} className="animate-spin" />
                Loading rules...
              </p>
            ) : rules.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500">
                No rules: no automatic joining waiver applies to this class.
              </p>
            ) : (
              <ol className="space-y-1.5">
                {rules.map((rule) => (
                  <li key={rule.id} className="rounded-lg border border-slate-200 bg-white p-2.5">
                    {editingId === rule.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-slate-700">Rule {rule.sequence}</span>
                        <RuleValueInputs
                          type={editType}
                          value={editValue}
                          onTypeChange={setEditType}
                          onValueChange={setEditValue}
                          disabled={isSaving}
                        />
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => void saveEdit(rule.id)}
                            disabled={isSaving || !editValue.trim()}
                            className="h-8 rounded-md bg-[#32598A] px-3 text-xs font-semibold text-white transition hover:bg-[#264867] disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            disabled={isSaving}
                            className="h-8 rounded-md border border-slate-200 px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-slate-700">
                          <span className="font-semibold">Rule {rule.sequence}</span>
                          <span className="text-slate-400"> · </span>
                          {rule.sequence} completed lecture{rule.sequence === 1 ? "" : "s"} before joining
                          <span className="text-slate-400"> → </span>
                          <span className="font-semibold text-[#264867]">{describeRule(rule)}</span>
                        </p>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(rule.id);
                              setEditType(rule.type);
                              setEditValue(String(rule.value));
                            }}
                            disabled={isSaving}
                            aria-label={`Edit rule ${rule.sequence}`}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeRule(rule)}
                            disabled={isSaving}
                            aria-label={`Remove rule ${rule.sequence}`}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-rose-500 transition hover:bg-rose-50"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Add rule {rules.length + 1}
            </p>
            {atLimit ? (
              <p className="text-xs text-slate-500">A class can have at most {MAX_WAIVER_RULES} rules.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <RuleValueInputs
                  type={newType}
                  value={newValue}
                  onTypeChange={setNewType}
                  onValueChange={setNewValue}
                  disabled={isSaving || isLoading}
                />
                <button
                  type="button"
                  onClick={() => void addRule()}
                  disabled={isSaving || isLoading || !newValue.trim()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#32598A] px-3 text-xs font-semibold text-white transition hover:bg-[#264867] disabled:opacity-50"
                >
                  {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  Add
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>,
    document.body
  );
}

function RuleValueInputs({
  type,
  value,
  onTypeChange,
  onValueChange,
  disabled,
}: {
  type: WaiverRuleType;
  value: string;
  onTypeChange: (type: WaiverRuleType) => void;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={type}
        onChange={(event) => onTypeChange(event.target.value as WaiverRuleType)}
        disabled={disabled}
        aria-label="Waiver type"
        className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-[#3d6690]"
      >
        <option value="PERCENTAGE">Percentage</option>
        <option value="FIXED_AMOUNT">Fixed amount</option>
      </select>
      <div className="relative">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={type === "PERCENTAGE" ? 100 : undefined}
          step={1}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          disabled={disabled}
          aria-label={type === "PERCENTAGE" ? "Percentage" : "Amount in rupees"}
          placeholder={type === "PERCENTAGE" ? "10" : "500"}
          className="h-8 w-24 rounded-md border border-slate-200 py-0 pl-2 pr-7 text-xs text-slate-700 outline-none focus:border-[#3d6690]"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">
          {type === "PERCENTAGE" ? "%" : "Rs"}
        </span>
      </div>
    </div>
  );
}
