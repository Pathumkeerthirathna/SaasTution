"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import toast from "react-hot-toast";

import { DialogShell } from "@/components/fee-payment-actions";
import { formatStoredSriLankaDate } from "@/lib/time";

/*
 * Payments page, "Resource access" of one student row for the selected
 * class, year and month (GET / PUT /api/classes/[id]/resource-access). Shows
 * the server's decision (services/resource-access-service.ts): payment
 * status, confirmed and outstanding amounts, grace period, override and the
 * effective access with its source. The teacher can grant, revoke or restore
 * the automatic (DEFAULT) behaviour; nothing here decides access itself.
 */

export type ResourceAccessChoice = "DEFAULT" | "GRANTED" | "REVOKED";

export type ResourceAccessDecisionView = {
  classId: string;
  className: string;
  year: number;
  month: number;
  accessible: boolean;
  source: string;
  override: "GRANTED" | "REVOKED" | null;
  restrictionEnabled: boolean;
  gracePeriodDays: number;
  fee: {
    paymentStatus: string;
    finalAmount: number;
    confirmedTotal: number;
    outstanding: number;
    awaitingTotal: number;
    dueDate: string | null;
    graceEndsAt: string | null;
    graceActive: boolean;
    initialPayment: boolean;
  } | null;
};

export type ResourceAccessViewData = {
  student: { id: string; name: string; registrationNumber: string | null };
  class: { id: string; name: string };
  decision: ResourceAccessDecisionView;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const resourceMonthText = (year: number, month: number) => `${MONTHS[month - 1] ?? month} ${year}`;

const SOURCE_TEXT: Record<string, string> = {
  OVERRIDE_GRANTED: "Teacher override: access granted",
  OVERRIDE_REVOKED: "Teacher override: access revoked",
  SETTING_OFF: "Automatic: the class restriction is off",
  PAID: "Automatic: nothing outstanding for this month",
  NO_FEE: "Automatic: no fee recorded for this month",
  NO_DUE_DATE: "Automatic: the fee has no due date",
  GRACE: "Automatic: still within the grace period",
  UNPAID: "Automatic: unpaid after the grace period",
  INITIAL_PAYMENT: "Automatic: first payment not confirmed yet",
  PRE_ENROLMENT: "Automatic: before the student joined the class",
};

export function resourceAccessSourceText(source: string) {
  return SOURCE_TEXT[source] ?? source;
}

const STATUS_TEXT: Record<string, string> = {
  PAID: "Paid",
  PARTIAL: "Partly paid",
  PENDING: "Slip awaiting confirmation",
  UNPAID: "Unpaid",
  FREE_CARD: "Free Card",
};

export function gracePeriodText(decision: ResourceAccessDecisionView) {
  const fee = decision.fee;
  if (!fee) return "No fee for this month";
  if (fee.outstanding <= 0) return "Not applicable (nothing outstanding)";
  if (fee.initialPayment) return "None (first payment of a public registration)";
  if (!fee.graceEndsAt) return "Not applicable (no due date)";
  const days = `${decision.gracePeriodDays} day${decision.gracePeriodDays === 1 ? "" : "s"}`;
  return fee.graceActive
    ? `Active (${days}) until ${formatStoredSriLankaDate(fee.graceEndsAt)}`
    : `Ended (${days}) ${formatStoredSriLankaDate(fee.graceEndsAt)}`;
}

const rupees = (value: number) => `Rs. ${value.toLocaleString()}`;

export function choiceOf(decision: ResourceAccessDecisionView): ResourceAccessChoice {
  return decision.override ?? "DEFAULT";
}

const CHOICES: { value: ResourceAccessChoice; label: string; hint: string }[] = [
  { value: "DEFAULT", label: "Automatic (default)", hint: "Follow the class setting, payments, grace period and enrolment." },
  { value: "GRANTED", label: "Grant access", hint: "Unlock this month's resources for this student." },
  { value: "REVOKED", label: "Revoke access", hint: "Lock this month's resources for this student." },
];

/** Pure view (no fetching), so it can be rendered in tests. */
export function ResourceAccessPanel({
  data,
  choice,
  busy,
  message,
  onChoose,
  onSave,
  onCancel,
}: {
  data: ResourceAccessViewData;
  choice: ResourceAccessChoice;
  busy: boolean;
  message: string | null;
  onChoose: (choice: ResourceAccessChoice) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const d = data.decision;
  const dirty = choice !== choiceOf(d);
  const rows: [string, string][] = [
    ["Student", `${data.student.name}${data.student.registrationNumber ? ` (${data.student.registrationNumber})` : ""}`],
    ["Class", data.class.name],
    ["Resource month", resourceMonthText(d.year, d.month)],
    ["Payment status", d.fee ? STATUS_TEXT[d.fee.paymentStatus] ?? d.fee.paymentStatus : "No fee for this month"],
    ["Confirmed amount", d.fee ? rupees(d.fee.confirmedTotal) : "-"],
    ["Outstanding amount", d.fee ? rupees(d.fee.outstanding) : "-"],
    ["Grace period", gracePeriodText(d)],
    ["Class restriction", d.restrictionEnabled ? "On" : "Off"],
  ];

  return (
    <div className="mt-3 space-y-3 text-xs" data-resource-access-panel>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-semibold text-slate-500">{label}</dt>
            <dd className="break-words text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>

      <div
        data-effective-access={d.accessible ? "UNLOCKED" : "LOCKED"}
        className={`rounded-lg border px-2.5 py-2 ${d.accessible ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900"}`}
      >
        <p className="font-semibold">Effective access: {d.accessible ? "Unlocked" : "Locked"}</p>
        <p className="mt-0.5">{resourceAccessSourceText(d.source)}</p>
        {d.fee && d.fee.awaitingTotal > 0 ? (
          <p className="mt-0.5">A submitted slip ({rupees(d.fee.awaitingTotal)}) does not unlock resources until you confirm it.</p>
        ) : null}
      </div>

      <fieldset className="space-y-1.5" disabled={busy}>
        <legend className="mb-1 font-semibold text-slate-700">Access for {resourceMonthText(d.year, d.month)}</legend>
        {CHOICES.map((option) => (
          <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-2.5 py-2 hover:bg-slate-50">
            <input
              type="radio"
              name="resource-access-choice"
              value={option.value}
              checked={choice === option.value}
              onChange={() => onChoose(option.value)}
              className="mt-0.5 accent-[#112D5C]"
            />
            <span>
              <span className="block font-semibold text-slate-900">{option.label}</span>
              <span className="block text-slate-500">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {message ? (
        <p role="alert" className="text-[11px] text-rose-600">
          {message}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="inline-flex items-center gap-1 rounded-lg bg-[#112D5C] px-3 py-1.5 font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
          Save
        </button>
      </div>
    </div>
  );
}

function readError(payload: unknown, fallback: string) {
  const error = (payload as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" && error.message ? error.message : fallback;
}

export function ResourceAccessDialog({
  classId,
  studentId,
  studentName,
  year,
  month,
  onClose,
}: {
  classId: string;
  studentId: string;
  studentName: string;
  year: number;
  month: number;
  onClose: () => void;
}) {
  const titleId = useId();
  const [data, setData] = useState<ResourceAccessViewData | null>(null);
  const [choice, setChoice] = useState<ResourceAccessChoice>("DEFAULT");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const qs = new URLSearchParams({ studentId, year: String(year), month: String(month) });
      const response = await fetch(`/api/classes/${encodeURIComponent(classId)}/resource-access?${qs}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Could not load resource access."));
      const view = (payload as { data: ResourceAccessViewData }).data;
      setData(view);
      setChoice(choiceOf(view.decision));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load resource access.");
    } finally {
      setLoading(false);
    }
  }, [classId, studentId, year, month]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!data || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/classes/${encodeURIComponent(classId)}/resource-access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, year, month, access: choice }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Could not save resource access."));
      const view = (payload as { data: ResourceAccessViewData; message?: string }).data;
      setData(view);
      setChoice(choiceOf(view.decision));
      toast.success((payload as { message?: string }).message ?? "Resource access saved.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Could not save resource access.";
      setMessage(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell
      titleId={titleId}
      title="Resource access"
      subtitle={`${studentName} · ${resourceMonthText(year, month)}`}
      onClose={onClose}
    >
      {loading && !data ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
          <Loader2 size={12} className="animate-spin" aria-hidden /> Loading...
        </p>
      ) : data ? (
        <ResourceAccessPanel
          data={data}
          choice={choice}
          busy={saving}
          message={message}
          onChoose={setChoice}
          onSave={() => void save()}
          onCancel={onClose}
        />
      ) : (
        <p role="alert" className="mt-3 text-xs text-rose-600">
          {message}
        </p>
      )}
    </DialogShell>
  );
}

/** The per-row action that opens the dialog. */
export function ResourceAccessButton({ onOpen, studentName }: { onOpen: () => void; studentName: string }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      aria-label={`Resource access for ${studentName}`}
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-[#112D5C] hover:bg-slate-50"
    >
      <KeyRound size={10} aria-hidden />
      Resources
    </button>
  );
}
