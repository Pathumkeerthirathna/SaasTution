"use client";

/*
 * Partial payments, Stage 2C: the teacher's payment actions on the Payments
 * page (components/class-fee-sheet-panel.tsx).
 *  - Record a payment received directly (POST /api/classes/[id]/fees/[feeId]/payments).
 *  - Reverse a teacher-recorded payment (POST /api/classes/[id]/payments/[paymentId]/reversal).
 *  - The fee's payment position (confirmed / outstanding / overpaid) and the
 *    details of recorded and reversed payments in the payment history.
 *
 * Every amount shown comes from the fee sheet API (paymentSummary, computed by
 * lib/fee-payment-state.ts on the server); nothing is recalculated here. The
 * server decides and enforces everything; the checks here only explain early
 * why an action is not available.
 *
 * Idempotency of recording: one request key per payment operation, kept (per
 * fee) until the server gives a definite answer. A network failure or an
 * uncertain response keeps the key, so the retry (also after closing and
 * reopening the form) can never record the payment twice.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Wallet, X } from "lucide-react";
import { createPortal } from "react-dom";


// ---- Types (the fee sheet API's shapes, services/class-student-fee-service.ts) ----------

export type PaymentMethod = "CASH" | "BANK_TRANSFER" | "OTHER";
export const PAYMENT_METHODS: readonly PaymentMethod[] = ["CASH", "BANK_TRANSFER", "OTHER"];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank transfer",
  OTHER: "Other",
};

export type FeePaymentStateName = "PAID" | "PARTIAL" | "PENDING" | "UNPAID" | "FREE_CARD";

export type PaymentSummary = {
  confirmedTotal: number;
  outstanding: number;
  overpaidAmount: number;
};

export type PaymentReversalInfo = {
  amount: number;
  reason: string;
  reversedByRole: "TEACHER" | "ADMIN";
  reversedByName: string | null;
  createdAt: string;
};

export type HistoryPayment = {
  id: string;
  amount: number;
  status: "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";
  source?: "STUDENT_SLIP" | "TEACHER_RECORDED";
  reversed?: boolean;
  paymentMethod?: PaymentMethod | null;
  receivedAt?: string | null;
  recordedByName?: string | null;
  reversal?: PaymentReversalInfo | null;
  note?: string | null;
};

export type RecordableRow = {
  feeId: string | null;
  studentName: string;
  registrationNumber?: string | null;
  freeCard: boolean;
  paymentStatus: FeePaymentStateName;
  paymentSummary?: PaymentSummary;
  payments: readonly { status: HistoryPayment["status"] }[];
};

export const MAX_PAYMENT_NOTE = 500;
export const MIN_REVERSAL_REASON = 3;
export const MAX_REVERSAL_REASON = 500;

const rupees = (value: number) => `Rs. ${value.toLocaleString()}`;

// receivedAt and the reversal time are real UTC instants: shown as Sri Lankan
// time whatever the browser’s timezone.
export function formatInstantDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Colombo", day: "2-digit", month: "short", year: "numeric" });
}
export function formatInstantDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Colombo", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ---- Eligibility -----------------------------------------------------------------------

/**
 * Why a payment cannot be recorded for this row now, or null when it can.
 * The same refusals the server makes (409s), from the values it returned.
 */
export function recordPaymentBlock(row: RecordableRow, isFuturePeriod = false): string | null {
  if (!row.feeId) return "This month's fee has not been created yet.";
  if (isFuturePeriod) return "This month has not started yet.";
  if (row.freeCard) return "This student has a Free Card for this month: nothing is payable.";
  if (row.payments.some((p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION")) {
    return "A payment slip from the student is awaiting your review. Confirm it or request clarification first.";
  }
  if (!row.paymentSummary || row.paymentSummary.outstanding <= 0) return "Nothing is outstanding for this fee.";
  return null;
}

/** Only a confirmed, not yet reversed, teacher-recorded payment can be reversed. */
export function canReversePayment(payment: HistoryPayment) {
  return payment.source === "TEACHER_RECORDED" && payment.status === "CONFIRMED" && !payment.reversed && !payment.reversal;
}

// ---- Record form validation --------------------------------------------------------------

export type RecordFormValues = {
  amount: string;
  paymentMethod: PaymentMethod | "";
  /** yyyy-mm-dd, a Sri Lankan calendar date. */
  receivedDate: string;
  note: string;
};

export type RecordPaymentPayload = {
  amount: number;
  paymentMethod: PaymentMethod;
  receivedAt: string;
  note?: string;
};

export type RecordFormErrors = Partial<Record<keyof RecordFormValues, string>>;

/** Today's date in Sri Lanka as yyyy-mm-dd (the received-date picker's maximum). */
export function sriLankaToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function emptyRecordForm(outstanding: number, now = new Date()): RecordFormValues {
  return { amount: outstanding > 0 ? String(outstanding) : "", paymentMethod: "CASH", receivedDate: sriLankaToday(now), note: "" };
}

/** Field errors, or the request body (receivedAt: noon of that Sri Lankan date). */
export function validateRecordPayment(
  values: RecordFormValues,
  outstanding: number,
  now = new Date()
): { errors: RecordFormErrors; payload: RecordPaymentPayload | null } {
  const errors: RecordFormErrors = {};
  const raw = values.amount.trim();
  const amount = Number(raw);
  if (!raw) errors.amount = "Enter the amount received.";
  else if (!/^\d+$/.test(raw) || !Number.isSafeInteger(amount)) errors.amount = "Enter a whole number of rupees.";
  else if (amount <= 0) errors.amount = "The amount must be more than zero.";
  else if (amount > outstanding) errors.amount = `The amount cannot be more than the outstanding ${rupees(outstanding)}.`;

  if (!values.paymentMethod || !PAYMENT_METHODS.includes(values.paymentMethod)) errors.paymentMethod = "Choose how the payment was received.";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.receivedDate) || Number.isNaN(new Date(`${values.receivedDate}T12:00:00+05:30`).getTime())) {
    errors.receivedDate = "Enter the date the payment was received.";
  } else if (values.receivedDate > sriLankaToday(now)) {
    errors.receivedDate = "The received date cannot be in the future.";
  }

  const note = values.note.trim();
  if (note.length > MAX_PAYMENT_NOTE) errors.note = `The note can be at most ${MAX_PAYMENT_NOTE} characters.`;

  if (Object.keys(errors).length > 0) return { errors, payload: null };
  return {
    errors,
    payload: {
      amount,
      paymentMethod: values.paymentMethod as PaymentMethod,
      receivedAt: new Date(`${values.receivedDate}T12:00:00+05:30`).toISOString(),
      ...(note ? { note } : {}),
    },
  };
}

export function validateReversalReason(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REVERSAL_REASON) return `Give a reason of at least ${MIN_REVERSAL_REASON} characters.`;
  if (trimmed.length > MAX_REVERSAL_REASON) return `The reason can be at most ${MAX_REVERSAL_REASON} characters.`;
  return null;
}

// ---- Idempotency: request keys and single submission -------------------------------------

/** A request key the server accepts: 8-100 of A-Z a-z 0-9 - _ (a UUID). */
export function createRequestKey(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The open recording operation of each fee and its request key. A key is
 * created when an operation begins and kept until the server has given a
 * definite answer (settle); retries after a network failure reuse it.
 */
export class RecordAttemptStore {
  private readonly keys = new Map<string, string>();

  constructor(private readonly makeKey: () => string = createRequestKey) {}

  /** The key of the fee's open operation, or a new one for a new operation. */
  keyFor(feeId: string): string {
    let key = this.keys.get(feeId);
    if (!key) {
      key = this.makeKey();
      this.keys.set(feeId, key);
    }
    return key;
  }

  /** An operation still waiting for a definite answer (a retry is pending). */
  isOpen(feeId: string) {
    return this.keys.has(feeId);
  }

  /** The server answered definitely (recorded, or refused): the next submission is a new operation. */
  settle(feeId: string) {
    this.keys.delete(feeId);
  }
}

/**
 * Runs one operation at a time: a call made while another is running (a
 * double click, before React re-renders the disabled button) is ignored.
 */
export function createSingleFlight() {
  let running = false;
  return {
    get busy() {
      return running;
    },
    async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined;
      running = true;
      try {
        return await operation();
      } finally {
        running = false;
      }
    },
  };
}

// ---- API calls ---------------------------------------------------------------------------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiOutcome<T> =
  | { kind: "ok"; status: number; data: T }
  /** A definite refusal (4xx): nothing was changed by this request. */
  | { kind: "rejected"; status: number; code: string | null; message: string }
  /** No definite answer (network failure, server error): it may or may not have happened. */
  | { kind: "uncertain"; message: string };

const RECORD_MESSAGES: Record<string, string> = {
  AMOUNT_EXCEEDS_OUTSTANDING: "The amount is more than what is still outstanding. The balance may have changed: check the updated figures.",
  FEE_ALREADY_SETTLED: "Nothing is outstanding for this fee any more.",
  SUBMISSION_AWAITING: "A payment slip from the student is awaiting your review. Confirm it or request clarification first.",
  FREE_CARD_ACTIVE: "This student has a Free Card for this month: nothing is payable.",
  REQUEST_KEY_CONFLICT: "An earlier attempt of this payment was already recorded with different details. Check the payment history before recording again.",
  PAYMENT_BUSY: "This fee is being changed by another request. Please try again in a moment.",
  FEE_NOT_FOUND: "This fee was not found. It may have been removed; reload the page.",
  CLASS_NOT_FOUND: "This class was not found, or you no longer manage it.",
};

const REVERSAL_MESSAGES: Record<string, string> = {
  ALREADY_REVERSED: "This payment has already been reversed.",
  NOT_TEACHER_RECORDED: "Only payments recorded by a teacher can be reversed. Student payment slips use the clarification workflow.",
  PAYMENT_NOT_FOUND: "This payment was not found, or you are not allowed to reverse it.",
  PAYMENT_BUSY: "This fee is being changed by another request. Please try again in a moment.",
};

/** A useful message for a refused or failed request (the server's message when there is no better one). */
export function describeApiFailure(outcome: Exclude<ApiOutcome<unknown>, { kind: "ok" }>, operation: "record" | "reverse") {
  if (outcome.kind === "uncertain") {
    return operation === "record"
      ? `${outcome.message} The payment may or may not have been recorded. Retrying is safe: it will not be recorded twice.`
      : `${outcome.message} Check the payment history; retrying is safe.`;
  }
  const known = outcome.code ? (operation === "record" ? RECORD_MESSAGES : REVERSAL_MESSAGES)[outcome.code] : undefined;
  if (known) return known;
  if (outcome.status === 400) return outcome.message || "Some details are not valid. Check the form and try again.";
  if (outcome.status === 401 || outcome.status === 403) return "Your session has expired or you are not allowed to do this. Sign in again.";
  if (outcome.status === 404) return outcome.message || "Not found. Reload the page.";
  return outcome.message || "The request was refused.";
}

async function postJson<T>(fetchImpl: FetchLike, url: string, body: unknown): Promise<ApiOutcome<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { kind: "uncertain", message: "The connection failed before the server answered." };
  }
  let payload: { success?: boolean; data?: T; error?: { code?: string; message?: string } } | null = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok && payload?.success) return { kind: "ok", status: response.status, data: payload.data as T };
  if (response.status >= 400 && response.status < 500 && payload && payload.success === false) {
    return { kind: "rejected", status: response.status, code: payload.error?.code ?? null, message: payload.error?.message ?? "" };
  }
  return { kind: "uncertain", message: `The server did not confirm the request (HTTP ${response.status}).` };
}

export type RecordPaymentResult = {
  replayed: boolean;
  feePayment: PaymentSummary & { state: FeePaymentStateName };
};

export function submitRecordPayment(params: {
  classId: string;
  feeId: string;
  payload: RecordPaymentPayload;
  requestKey: string;
  fetchImpl?: FetchLike;
}): Promise<ApiOutcome<RecordPaymentResult>> {
  const { classId, feeId, payload, requestKey, fetchImpl = fetch } = params;
  return postJson(
    fetchImpl,
    `/api/classes/${encodeURIComponent(classId)}/fees/${encodeURIComponent(feeId)}/payments`,
    { ...payload, requestKey }
  );
}

/**
 * One submission of the record form: the fee's open request key (reused on a
 * retry), settled once the server answered definitely. A call while another
 * is running is ignored (undefined).
 */
export async function recordPaymentOnce(params: {
  classId: string;
  feeId: string;
  payload: RecordPaymentPayload;
  attempts: RecordAttemptStore;
  flight: ReturnType<typeof createSingleFlight>;
  fetchImpl?: FetchLike;
}): Promise<ApiOutcome<RecordPaymentResult> | undefined> {
  const { attempts, flight, feeId } = params;
  return flight.run(async () => {
    const requestKey = attempts.keyFor(feeId);
    const outcome = await submitRecordPayment({ ...params, requestKey });
    if (outcome.kind !== "uncertain") attempts.settle(feeId);
    return outcome;
  });
}

export type ReversalResult = { feePayment: PaymentSummary & { state: FeePaymentStateName } };

export function submitReversal(params: {
  classId: string;
  paymentId: string;
  reason: string;
  fetchImpl?: FetchLike;
}): Promise<ApiOutcome<ReversalResult>> {
  const { classId, paymentId, reason, fetchImpl = fetch } = params;
  return postJson(
    fetchImpl,
    `/api/classes/${encodeURIComponent(classId)}/payments/${encodeURIComponent(paymentId)}/reversal`,
    { reason: reason.trim() }
  );
}

// ---- Fee payment position ------------------------------------------------------------------

const STATE_LABELS: Record<FeePaymentStateName, string> = {
  PAID: "Paid",
  PARTIAL: "Partly paid",
  PENDING: "Slip awaiting review",
  UNPAID: "Unpaid",
  FREE_CARD: "Free Card",
};

/** Confirmed total, outstanding balance, state and overpayment: the server's figures. */
export function FeePaymentPosition({
  state,
  summary,
}: {
  state: FeePaymentStateName;
  summary?: PaymentSummary;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
      <span className="font-semibold text-slate-900">{STATE_LABELS[state]}</span>
      {summary ? (
        <>
          <span className="text-slate-600">
            Confirmed <strong className="text-slate-900">{rupees(summary.confirmedTotal)}</strong>
          </span>
          <span className="text-slate-600">
            Outstanding <strong className="text-slate-900">{rupees(summary.outstanding)}</strong>
          </span>
          {summary.overpaidAmount > 0 ? (
            <span className="font-semibold text-amber-700">Overpaid {rupees(summary.overpaidAmount)}</span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ---- Payment history details -----------------------------------------------------------------

/** The teacher-recorded part of a history entry (method, received date, recorder). */
export function RecordedPaymentDetails({ payment }: { payment: HistoryPayment }) {
  return (
    <div className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
      <p className="text-slate-600">
        Method: {payment.paymentMethod ? PAYMENT_METHOD_LABELS[payment.paymentMethod] : "Not recorded"}
      </p>
      {payment.receivedAt ? (
        <p className="text-slate-600">Received: {formatInstantDate(payment.receivedAt)}</p>
      ) : null}
      {payment.recordedByName ? <p className="text-slate-600">Recorded by: {payment.recordedByName}</p> : null}
    </div>
  );
}

export function ReversalDetails({ reversal }: { reversal: PaymentReversalInfo }) {
  const actor =
    reversal.reversedByRole === "ADMIN" ? "an administrator" : reversal.reversedByName ?? "a teacher";
  return (
    <div className="mt-2 rounded-lg border border-slate-300 bg-white/80 px-2 py-1.5 text-slate-700">
      <p className="font-semibold text-slate-800">
        Reversed {rupees(reversal.amount)} on {formatInstantDateTime(reversal.createdAt)} by {actor}
      </p>
      <p className="mt-0.5">
        <span className="font-semibold">Reason:</span> {reversal.reason}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Kept in the history; no longer counted as received.
      </p>
    </div>
  );
}

// ---- Dialog shell -----------------------------------------------------------------------------

/** The Payments-page dialog shell (also used by components/resource-access-dialog.tsx). */
export function DialogShell({
  titleId,
  title,
  subtitle,
  onClose,
  children,
}: {
  titleId: string;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portalled to <body>, like the other Payments-page dialogs.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={titleId} className="text-sm font-semibold text-slate-900">
              {title}
            </h3>
            {subtitle ? <p className="break-words text-xs text-slate-500">{subtitle}</p> : null}
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
        {children}
      </div>
    </div>,
    document.body
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none focus:border-[#112D5C] disabled:bg-slate-50";
const errorClass = "mt-0.5 text-[11px] text-rose-600";

// ---- Record payment ---------------------------------------------------------------------------

export type RecordPaymentFormViewProps = {
  outstanding: number;
  values: RecordFormValues;
  errors: RecordFormErrors;
  busy: boolean;
  /** A failure message (server refusal or uncertain outcome). */
  message: string | null;
  /** The previous attempt had no definite answer: the next submission retries it. */
  retrying: boolean;
  maxDate: string;
  onChange: (values: RecordFormValues) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function RecordPaymentFormView({
  outstanding,
  values,
  errors,
  busy,
  message,
  retrying,
  maxDate,
  onChange,
  onSubmit,
  onCancel,
}: RecordPaymentFormViewProps) {
  const set = (patch: Partial<RecordFormValues>) => onChange({ ...values, ...patch });
  return (
    <form
      className="mt-3 space-y-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Outstanding balance: <strong className="text-slate-900">{rupees(outstanding)}</strong>
      </p>

      <label className="block text-xs font-semibold text-slate-700">
        Amount (Rs.)
        <input
          type="text"
          inputMode="numeric"
          value={values.amount}
          disabled={busy}
          onChange={(event) => set({ amount: event.target.value })}
          aria-invalid={Boolean(errors.amount)}
          className={`mt-1 ${inputClass}`}
        />
        {errors.amount ? <span className={`block ${errorClass}`}>{errors.amount}</span> : null}
      </label>

      <label className="block text-xs font-semibold text-slate-700">
        Payment method
        <select
          value={values.paymentMethod}
          disabled={busy}
          onChange={(event) => set({ paymentMethod: event.target.value as PaymentMethod | "" })}
          aria-invalid={Boolean(errors.paymentMethod)}
          className={`mt-1 ${inputClass}`}
        >
          <option value="">Choose…</option>
          {PAYMENT_METHODS.map((method) => (
            <option key={method} value={method}>
              {PAYMENT_METHOD_LABELS[method]}
            </option>
          ))}
        </select>
        {errors.paymentMethod ? <span className={`block ${errorClass}`}>{errors.paymentMethod}</span> : null}
      </label>

      <label className="block text-xs font-semibold text-slate-700">
        Received on
        <input
          type="date"
          value={values.receivedDate}
          max={maxDate}
          disabled={busy}
          onChange={(event) => set({ receivedDate: event.target.value })}
          aria-invalid={Boolean(errors.receivedDate)}
          className={`mt-1 ${inputClass}`}
        />
        {errors.receivedDate ? <span className={`block ${errorClass}`}>{errors.receivedDate}</span> : null}
      </label>

      <label className="block text-xs font-semibold text-slate-700">
        Note or reference (optional)
        <textarea
          rows={2}
          value={values.note}
          maxLength={MAX_PAYMENT_NOTE}
          disabled={busy}
          onChange={(event) => set({ note: event.target.value })}
          className={`mt-1 resize-none ${inputClass}`}
        />
        <span className="block text-right text-[10px] font-normal text-slate-400">
          {values.note.length}/{MAX_PAYMENT_NOTE}
        </span>
        {errors.note ? <span className={`block ${errorClass}`}>{errors.note}</span> : null}
      </label>

      {message ? (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {message}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#112D5C] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0c2147] disabled:opacity-60"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : null}
          {busy ? "Recording…" : retrying ? "Retry recording" : "Record payment"}
        </button>
      </div>
    </form>
  );
}

export function RecordPaymentDialog({
  classId,
  row,
  attempts,
  onRecorded,
  onRefresh,
  onClose,
}: {
  classId: string;
  row: RecordableRow & { feeId: string };
  attempts: RecordAttemptStore;
  /** After a definite answer that changed (or may have changed) the fee: reload the sheet. */
  onRecorded: (result: { replayed: boolean }) => void | Promise<void>;
  /** Reload the sheet behind the open dialog (after a 409: the fee changed). */
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
}) {
  const outstanding = row.paymentSummary?.outstanding ?? 0;
  const [values, setValues] = useState(() => emptyRecordForm(outstanding));
  const [errors, setErrors] = useState<RecordFormErrors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(() => attempts.isOpen(row.feeId));
  const flight = useRef(createSingleFlight()).current;

  async function submit() {
    if (flight.busy) return;
    const { errors: nextErrors, payload } = validateRecordPayment(values, outstanding);
    setErrors(nextErrors);
    if (!payload) return;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await recordPaymentOnce({ classId, feeId: row.feeId, payload, attempts, flight });
      if (!outcome) return;
      if (outcome.kind === "ok") {
        await onRecorded({ replayed: outcome.data.replayed });
        return;
      }
      setRetrying(outcome.kind === "uncertain");
      setMessage(describeApiFailure(outcome, "record"));
      // A refusal can mean the fee changed meanwhile (a slip, another
      // payment): refresh the figures behind the dialog.
      if (outcome.kind === "rejected" && outcome.status === 409) void onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell
      titleId="record-payment-title"
      title="Record a payment"
      subtitle={`${row.studentName}${row.registrationNumber ? ` (${row.registrationNumber})` : ""}`}
      onClose={busy ? () => undefined : onClose}
    >
      <RecordPaymentFormView
        outstanding={outstanding}
        values={values}
        errors={errors}
        busy={busy}
        message={message}
        retrying={retrying}
        maxDate={sriLankaToday()}
        onChange={setValues}
        onSubmit={() => void submit()}
        onCancel={onClose}
      />
    </DialogShell>
  );
}

// ---- Reverse payment --------------------------------------------------------------------------

export type ReversalFormViewProps = {
  amount: number;
  reason: string;
  acknowledged: boolean;
  busy: boolean;
  /** Shown after the first submit attempt (or a server refusal). */
  error: string | null;
  onReason: (reason: string) => void;
  onAcknowledge: (value: boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

/** The reversal can be submitted only with a valid reason and the explicit confirmation. */
export function canSubmitReversal(reason: string, acknowledged: boolean) {
  return acknowledged && validateReversalReason(reason) === null;
}

export function ReversalFormView({
  amount,
  reason,
  acknowledged,
  busy,
  error,
  onReason,
  onAcknowledge,
  onSubmit,
  onCancel,
}: ReversalFormViewProps) {
  return (
    <form
      className="mt-3 space-y-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <p>
          Reversing adds <strong>{rupees(amount)}</strong> back to the student&apos;s outstanding balance.
        </p>
        <p>The original payment record is kept in the payment history, marked as reversed. A reversal cannot be undone.</p>
      </div>

      <label className="block text-xs font-semibold text-slate-700">
        Reason
        <textarea
          rows={3}
          value={reason}
          maxLength={MAX_REVERSAL_REASON}
          disabled={busy}
          onChange={(event) => onReason(event.target.value)}
          placeholder="Why is this payment being reversed?"
          className={`mt-1 resize-none ${inputClass}`}
        />
        <span className="block text-right text-[10px] font-normal text-slate-400">
          {reason.trim().length}/{MAX_REVERSAL_REASON}
        </span>
      </label>

      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy}
          onChange={(event) => onAcknowledge(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300"
        />
        <span>I confirm this payment of {rupees(amount)} should be reversed.</span>
      </label>

      {error ? (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !canSubmitReversal(reason, acknowledged)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          {busy ? "Reversing…" : "Reverse payment"}
        </button>
      </div>
    </form>
  );
}

export function ReversePaymentDialog({
  classId,
  payment,
  onReversed,
  onRefresh,
  onClose,
}: {
  classId: string;
  payment: HistoryPayment;
  onReversed: () => void | Promise<void>;
  /** Reload the sheet behind the open dialog (the payment changed meanwhile). */
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(createSingleFlight()).current;

  async function submit() {
    const invalid = validateReversalReason(reason);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!acknowledged) {
      setError("Tick the confirmation to reverse this payment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await flight.run(() => submitReversal({ classId, paymentId: payment.id, reason }));
      if (!outcome) return;
      if (outcome.kind === "ok") {
        await onReversed();
        return;
      }
      setError(describeApiFailure(outcome, "reverse"));
      // Already reversed (or changed) meanwhile: show the current history.
      if (outcome.kind === "rejected" && outcome.status === 409) void onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell
      titleId="reverse-payment-title"
      title="Reverse a recorded payment"
      subtitle={`${rupees(payment.amount)}${payment.paymentMethod ? ` · ${PAYMENT_METHOD_LABELS[payment.paymentMethod]}` : ""}${
        payment.receivedAt ? ` · received ${formatInstantDate(payment.receivedAt)}` : ""
      }`}
      onClose={busy ? () => undefined : onClose}
    >
      <ReversalFormView
        amount={payment.amount}
        reason={reason}
        acknowledged={acknowledged}
        busy={busy}
        error={error}
        onReason={(value) => {
          setReason(value);
          setError(null);
        }}
        onAcknowledge={setAcknowledged}
        onSubmit={() => void submit()}
        onCancel={onClose}
      />
    </DialogShell>
  );
}

// ---- Record button ---------------------------------------------------------------------------

/** The row's "Record payment" action: disabled with the reason when not available. */
export function RecordPaymentButton({
  block,
  onClick,
}: {
  block: string | null;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={block !== null}
        onClick={onClick}
        title={block ?? "Record money received directly from the student"}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[#112D5C] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#0c2147] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Wallet size={12} />
        Record payment
      </button>
      {block ? <span className="text-[11px] text-slate-500">{block}</span> : null}
    </div>
  );
}
