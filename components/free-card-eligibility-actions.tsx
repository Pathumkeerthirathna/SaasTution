"use client";

import { AlertTriangle, CheckCircle2, Ticket, X, XCircle } from "lucide-react";

/*
 * Class-level Free Card eligibility in the teacher's Students panel
 * (components/class-management-panel.tsx): enrolment selection, the bulk
 * "Mark as Free Card Students" / "Remove Free Card Eligibility" actions on
 * POST /api/classes/[id]/free-card-eligibility, and the result notices.
 *
 * Eligibility belongs to the enrolment (ClassStudent.freeCardEligible): the
 * selection holds ClassStudent ids, never Student ids, and the indicator
 * reads the enrolment's own flag (never inferred from fee Free Cards).
 * Pure helpers and presentational pieces, testable without a DOM.
 */

// ---- Selection ------------------------------------------------------------------------

/** The minimal enrolment shape the selection needs. */
export type SelectableEnrolment = { id: string; isActive: boolean; freeCardEligible?: boolean };

export type EligibilityAction = "enable" | "disable";

export type EligibilityNotice = {
  tone: "success" | "warning" | "error";
  message: string;
  /** Per-fee details of the optional current-month application (skipped fees). */
  details?: string[];
};

export type EligibilityPanelState = {
  /** Selected ClassStudent (enrolment) ids. */
  selected: Set<string>;
  /** The open confirmation, if any. */
  confirming: EligibilityAction | null;
  /** "Also apply Free Cards to this month's existing eligible fees" (enable only). */
  applyToCurrentMonth: boolean;
  notice: EligibilityNotice | null;
};

export type EligibilityPanelEvent =
  | { type: "toggle"; enrolment: SelectableEnrolment }
  | { type: "toggleAll"; enrolments: SelectableEnrolment[] }
  /** Another class, or the panel closed: nothing carried over. */
  | { type: "reset" }
  /** The list was reloaded: keep only still-active enrolments. */
  | { type: "sync"; enrolments: SelectableEnrolment[] }
  | { type: "confirm"; action: EligibilityAction }
  | { type: "cancel" }
  | { type: "setApply"; value: boolean }
  /** The eligibility change was saved (also when the optional apply step failed). */
  | { type: "saved"; notice: EligibilityNotice }
  /** Nothing was saved. The selection stays for a retry. */
  | { type: "failed"; notice: EligibilityNotice }
  | { type: "dismissNotice" };

export function initialEligibilityPanelState(): EligibilityPanelState {
  return { selected: new Set(), confirming: null, applyToCurrentMonth: false, notice: null };
}

/** Only active enrolments can be selected. */
export function selectableEnrolmentIds(enrolments: SelectableEnrolment[]) {
  return enrolments.filter((e) => e.isActive).map((e) => e.id);
}

export function allEnrolmentsSelected(selected: Set<string>, enrolments: SelectableEnrolment[]) {
  const ids = selectableEnrolmentIds(enrolments);
  return ids.length > 0 && ids.every((id) => selected.has(id));
}

export function eligibilityPanelReducer(
  state: EligibilityPanelState,
  event: EligibilityPanelEvent
): EligibilityPanelState {
  switch (event.type) {
    case "toggle": {
      if (!event.enrolment.isActive) return state;
      const selected = new Set(state.selected);
      if (selected.has(event.enrolment.id)) selected.delete(event.enrolment.id);
      else selected.add(event.enrolment.id);
      return { ...state, selected };
    }
    case "toggleAll": {
      const ids = selectableEnrolmentIds(event.enrolments);
      const selected = new Set(state.selected);
      if (allEnrolmentsSelected(state.selected, event.enrolments)) ids.forEach((id) => selected.delete(id));
      else ids.forEach((id) => selected.add(id));
      return { ...state, selected };
    }
    case "reset":
      return initialEligibilityPanelState();
    case "sync": {
      const active = new Set(selectableEnrolmentIds(event.enrolments));
      const selected = new Set([...state.selected].filter((id) => active.has(id)));
      return selected.size === state.selected.size ? state : { ...state, selected };
    }
    case "confirm":
      if (state.selected.size === 0) return state;
      // The apply option always starts unchecked.
      return { ...state, confirming: event.action, applyToCurrentMonth: false, notice: null };
    case "cancel":
      return { ...state, confirming: null, applyToCurrentMonth: false };
    case "setApply":
      return state.confirming === "enable" ? { ...state, applyToCurrentMonth: event.value } : state;
    case "saved":
      return { selected: new Set(), confirming: null, applyToCurrentMonth: false, notice: event.notice };
    case "failed":
      return { ...state, confirming: null, applyToCurrentMonth: false, notice: event.notice };
    case "dismissNotice":
      return { ...state, notice: null };
  }
}

// ---- Request ----------------------------------------------------------------------------

export type EligibilityRequestBody = {
  classStudentIds: string[];
  eligible: boolean;
  applyToCurrentMonth?: true;
};

/** The Stage 3A contract; applyToCurrentMonth is sent only when explicitly chosen (enable only). */
export function buildEligibilityRequest(
  classStudentIds: Iterable<string>,
  action: EligibilityAction,
  applyToCurrentMonth: boolean
): EligibilityRequestBody {
  const body: EligibilityRequestBody = { classStudentIds: [...new Set(classStudentIds)], eligible: action === "enable" };
  if (action === "enable" && applyToCurrentMonth === true) body.applyToCurrentMonth = true;
  return body;
}

type ApplySkipped = { feeId: string; studentName: string | null; reason: string; message: string };

export type EligibilityApiData = {
  classId: string;
  eligible: boolean;
  enrolments: { classStudentId: string; studentId: string; freeCardEligible: boolean }[];
  changedCount: number;
  apply:
    | null
    | { status: "APPLIED"; processed: { feeId: string; studentName: string }[]; skipped: ApplySkipped[] }
    | { status: "FAILED"; code: string; message: string };
};

export type EligibilityOutcome =
  /** Eligibility committed. applyFailed: the optional step failed AFTER the save (nothing reverted). */
  | { kind: "saved"; data: EligibilityApiData; message: string; applyFailed: boolean }
  /** The server refused: nothing was changed. refresh: the list is stale (removed / unknown enrolments). */
  | { kind: "refused"; status: number; code: string | null; message: string; refresh: boolean }
  | { kind: "network" }
  | { kind: "unexpected"; status: number | null };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function submitFreeCardEligibility(
  classId: string,
  body: EligibilityRequestBody,
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<EligibilityOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/classes/${encodeURIComponent(classId)}/free-card-eligibility`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "network" };
  }

  let payload: {
    success?: boolean;
    data?: EligibilityApiData;
    message?: string;
    error?: { message?: string; code?: string };
  } | null = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.ok && payload?.success === true && payload.data) {
    return {
      kind: "saved",
      data: payload.data,
      message: payload.message ?? "Free Card eligibility saved.",
      applyFailed: payload.data.apply?.status === "FAILED",
    };
  }

  if (payload && payload.success === false && response.status >= 400 && response.status < 500) {
    const code = payload.error?.code ?? null;
    return {
      kind: "refused",
      status: response.status,
      code,
      message: payload.error?.message ?? "The request was refused.",
      refresh: code === "ENROLMENT_NOT_FOUND" || code === "ENROLMENT_NOT_ACTIVE",
    };
  }

  return { kind: "unexpected", status: response.status };
}

/** What the panel shows for an outcome. */
export function eligibilityNotice(outcome: EligibilityOutcome): EligibilityNotice {
  switch (outcome.kind) {
    case "saved": {
      const apply = outcome.data.apply;
      if (apply?.status === "FAILED") {
        // The server's message says the eligibility change was saved and not
        // reverted: shown as it is, as a warning (never as a failed save).
        return { tone: "warning", message: outcome.message };
      }
      const details =
        apply?.status === "APPLIED" && apply.skipped.length > 0
          ? apply.skipped.map((s) => `${s.studentName ?? "A student"}: ${s.message}`)
          : undefined;
      return { tone: "success", message: outcome.message, ...(details ? { details } : {}) };
    }
    case "refused": {
      if (outcome.code === "ENROLMENT_NOT_ACTIVE" || outcome.code === "ENROLMENT_NOT_FOUND") {
        return { tone: "error", message: `${outcome.message} Nothing was changed. The list has been refreshed.` };
      }
      return { tone: "error", message: `${outcome.message} Nothing was changed.` };
    }
    // The outcome is unknown: the list is reloaded to show what was saved.
    case "network":
      return {
        tone: "error",
        message: "Could not reach the server. The change may not have been saved; the list has been refreshed to show the current eligibility.",
      };
    case "unexpected":
      return {
        tone: "error",
        message: "Something went wrong. The change may not have been saved; the list has been refreshed to show the current eligibility.",
      };
  }
}

/**
 * Whether the student list should be reloaded after this outcome: after a
 * save (also when the optional apply step failed), for stale selections, and
 * whenever the outcome is unknown. Not for a validation or busy refusal
 * (nothing changed, the selection stays for a retry).
 */
export function shouldRefreshAfter(outcome: EligibilityOutcome) {
  if (outcome.kind === "refused") return outcome.refresh;
  return true;
}

// ---- Presentational pieces -----------------------------------------------------------------

/** The enrolment's own eligibility (ClassStudent.freeCardEligible). */
export function FreeCardStudentBadge({ eligible }: { eligible: boolean | undefined }) {
  if (!eligible) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700"
      title="Free Card student of this class: new monthly fees get a Free Card automatically"
    >
      <Ticket size={9} />
      Free Card Student
    </span>
  );
}

/** Select-all for the displayed active students, and the bulk actions once something is selected. */
export function EligibilitySelectionBar({
  selectedCount,
  selectableCount,
  allSelected,
  busy,
  onToggleAll,
  onMark,
  onRemove,
  onClear,
}: {
  selectedCount: number;
  selectableCount: number;
  allSelected: boolean;
  busy: boolean;
  onToggleAll: () => void;
  onMark: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  if (selectableCount === 0) return null;
  return (
    <div className="border-b border-gray-100 bg-slate-50 px-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={busy}
            onChange={onToggleAll}
            aria-label="Select all active students"
          />
          <span className="text-xs font-medium">Select All</span>
        </label>
        {selectedCount > 0 ? (
          <span className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-[#264867]">{selectedCount} selected</span>
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="text-[11px] font-medium text-slate-500 hover:text-slate-700 disabled:opacity-60"
            >
              Clear
            </button>
          </span>
        ) : null}
      </div>
      {selectedCount > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={onMark}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-60"
          >
            <Ticket size={11} />
            Mark as Free Card Students
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-60"
          >
            <X size={11} />
            Remove Free Card Eligibility
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function EligibilityConfirmDialog({
  action,
  count,
  className,
  applyToCurrentMonth,
  busy,
  onApplyChange,
  onCancel,
  onConfirm,
}: {
  action: EligibilityAction;
  count: number;
  className: string;
  applyToCurrentMonth: boolean;
  busy: boolean;
  onApplyChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const enable = action === "enable";
  const students = `${count} student${count === 1 ? "" : "s"}`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-panel">
        <div className="flex items-start gap-3">
          <span
            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
              enable ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-600"
            }`}
          >
            <Ticket size={18} />
          </span>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              {enable ? "Mark as Free Card Students?" : "Remove Free Card eligibility?"}
            </h3>
            <p className="mt-1 text-sm text-muted">
              {enable ? (
                <>
                  <span className="font-semibold text-foreground">{students}</span> in{" "}
                  <span className="font-semibold text-foreground">{className}</span> will get a Free Card automatically on
                  each new monthly fee of this class. Existing fees are not changed.
                </>
              ) : (
                <>
                  <span className="font-semibold text-foreground">{students}</span> in{" "}
                  <span className="font-semibold text-foreground">{className}</span> will no longer get automatic Free
                  Cards. Free Cards already issued stay as they are.
                </>
              )}
            </p>
          </div>
        </div>

        {enable ? (
          <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={applyToCurrentMonth}
              disabled={busy}
              onChange={(e) => onApplyChange(e.target.checked)}
            />
            <span className="text-xs text-slate-700">
              Also apply Free Cards to this month&apos;s existing eligible fees
              <span className="mt-0.5 block text-[11px] text-muted">
                Fees with a confirmed payment, or a slip waiting for review, are skipped.
              </span>
            </span>
          </label>
        ) : null}

        <div className="mt-5 flex gap-3">
          <button type="button" disabled={busy} onClick={onCancel} className="btn-ghost flex-1">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-soft transition-all disabled:opacity-60 ${
              enable ? "bg-violet-600 hover:bg-violet-700" : "bg-slate-700 hover:bg-slate-800"
            }`}
          >
            {busy ? "Saving..." : enable ? "Mark as Free Card Students" : "Remove eligibility"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EligibilityNoticeView({ notice, onDismiss }: { notice: EligibilityNotice; onDismiss: () => void }) {
  const style =
    notice.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : notice.tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-rose-200 bg-rose-50 text-rose-700";
  const Icon = notice.tone === "success" ? CheckCircle2 : notice.tone === "warning" ? AlertTriangle : XCircle;
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${style}`} role={notice.tone === "error" ? "alert" : "status"}>
      <Icon size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{notice.message}</p>
        {notice.details && notice.details.length > 0 ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {notice.details.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
        <X size={12} />
      </button>
    </div>
  );
}

/** The per-row checkbox: active enrolments only (the panel never renders it for past ones). */
export function EnrolmentCheckbox({
  checked,
  disabled,
  studentName,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  studentName: string;
  onToggle: () => void;
}) {
  return (
    <input
      type="checkbox"
      className="shrink-0"
      checked={checked}
      disabled={disabled}
      onChange={onToggle}
      aria-label={`Select ${studentName}`}
    />
  );
}
