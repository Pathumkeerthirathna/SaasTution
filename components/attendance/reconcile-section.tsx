"use client";

/*
 * The "Reconcile online evidence" action of the register page (Stage
 * 5.5d-3): availability, progress and outcome, presentational only (the run
 * itself is components/attendance/reconciliation-controller.ts over the
 * shared runReconciliation). The server stays the authority: the
 * availability rules below only mirror what the reconciliation API refuses
 * (cancelled 409, historical 409, unconfigured 503), so the teacher is told
 * before clicking.
 */

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Square, Wifi, XCircle } from "lucide-react";

import {
  attendanceErrorAction,
  type AttendanceRegisterResponse,
  type ReconcileCounts,
  type ReconcileOutcome,
} from "@/components/attendance/attendance-ui";
import type { ReconcileUiState } from "@/components/attendance/reconciliation-controller";

export type ReconcileAvailability = { allowed: boolean; reason: string | null; note: string | null };

/**
 * Whether the action is offered, from the register's own fields: a
 * cancelled lecture, a historical lecture and missing settings are refused
 * by the API; a finalized register is reconciled (existing records only).
 */
export function reconcileAvailability(register: AttendanceRegisterResponse): ReconcileAvailability {
  if (register.lecture.classStatus === "CANCELLED") {
    return { allowed: false, reason: "This lecture is cancelled, so there is no online evidence to reconcile.", note: null };
  }
  if (register.classification === null) {
    return { allowed: false, reason: "Attendance settings are not configured on this server, so online evidence cannot be reconciled.", note: null };
  }
  if (register.classification === "HISTORICAL") {
    return { allowed: false, reason: "This lecture is from before automatic attendance started; online evidence is not reconciled for it.", note: null };
  }
  return {
    allowed: true,
    reason: null,
    note: register.register.finalized
      ? "This register is finalized. Reconciliation only adds online evidence to students who already have a record, and may raise a review for you; it never changes a finalized status and never creates new records."
      : null,
  };
}

export type ReconcileNextStep = "RUN_AGAIN" | "RELOAD_PAGE" | "SIGN_IN" | "CONTACT_SUPPORT" | "NONE";
export type ReconcileMessage = { tone: "success" | "warning" | "error" | "info"; title: string; body: string; next: ReconcileNextStep };

/** What the outcome means for the teacher; success only for COMPLETE. */
export function reconcileOutcomeMessage(outcome: ReconcileOutcome): ReconcileMessage {
  if (outcome.status === "COMPLETE") {
    return {
      tone: "success",
      title: "Online evidence reconciled",
      body: outcome.totals.applied > 0
        ? `${outcome.totals.applied} student(s) had online evidence recorded.`
        : "Everything was already recorded; nothing needed to change.",
      next: "NONE",
    };
  }
  if (outcome.status === "FAILED") {
    const action = attendanceErrorAction(outcome.error.code);
    return {
      tone: "error",
      title: "Reconciliation failed",
      body: outcome.error.message,
      next: action === "SIGN_IN" ? "SIGN_IN" : action === "CONTACT_SUPPORT" ? "CONTACT_SUPPORT" : action === "RELOAD_PAGE" ? "RELOAD_PAGE" : action === "NONE" ? "NONE" : "RUN_AGAIN",
    };
  }
  switch (outcome.reason) {
    case "BUSY_REMAINING":
      return {
        tone: "warning",
        title: "Not finished: some students were busy",
        body: `${outcome.totals.busy} student update(s) could not be processed because attendance was being updated at the same time. Another reconciliation attempt may be needed in a moment.`,
        next: "RUN_AGAIN",
      };
    case "LECTURE_CHANGED":
      return {
        tone: "warning",
        title: "Stopped: the lecture changed",
        body: "The lecture changed while reconciling (for example it was cancelled, removed or rescheduled). Reload the register before trying again.",
        next: "RELOAD_PAGE",
      };
    case "NO_PROGRESS":
      return {
        tone: "warning",
        title: "Stopped: no progress",
        body: "Reconciliation stopped because the server did not move on to the next students. Try again later; if this keeps happening, contact support.",
        next: "RUN_AGAIN",
      };
    case "PAGE_LIMIT":
      return {
        tone: "warning",
        title: "Stopped at the safety limit",
        body: "Reconciliation stopped after the maximum number of pages for one run. Run it again to continue.",
        next: "RUN_AGAIN",
      };
    case "ABORTED":
      return { tone: "info", title: "Reconciliation stopped", body: "You stopped reconciliation. Students already processed keep their recorded evidence.", next: "RUN_AGAIN" };
  }
}

const COUNT_LABELS: [keyof ReconcileCounts, string][] = [
  ["processed", "Students checked"],
  ["applied", "Evidence recorded"],
  ["duplicates", "Already recorded"],
  ["busy", "Busy"],
  ["skipped", "Skipped"],
  ["ineligible", "Not eligible"],
  ["unknown", "Approval unknown"],
  ["inactive", "Inactive or deleted"],
  ["finalizedWithoutRecord", "Finalized, no record"],
];

function Counts({ totals, compact }: { totals: ReconcileCounts; compact?: boolean }) {
  const shown = compact ? COUNT_LABELS.filter(([key]) => ["processed", "applied", "duplicates", "busy", "skipped"].includes(key)) : COUNT_LABELS;
  return (
    <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {shown.map(([key, label]) => (
        <div key={key} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
          <dt className="text-[11px] font-semibold text-slate-500">{label}</dt>
          <dd className="text-base font-bold text-[#112D5C]">{totals[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

const TONE: Record<ReconcileMessage["tone"], { box: string; icon: React.ReactNode }> = {
  success: { box: "border-emerald-200 bg-emerald-50 text-emerald-900", icon: <CheckCircle2 size={16} aria-hidden /> },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-900", icon: <AlertTriangle size={16} aria-hidden /> },
  error: { box: "border-rose-200 bg-rose-50 text-rose-900", icon: <XCircle size={16} aria-hidden /> },
  info: { box: "border-slate-200 bg-slate-50 text-slate-800", icon: <Square size={16} aria-hidden /> },
};

const REFRESH_TEXT = {
  pending: "Refreshing the register…",
  done: "The register below has been updated.",
  failed: "The register could not be refreshed. Reload the page to see the latest data.",
  skipped: null,
} as const;

export function ReconcileSection({
  availability,
  state,
  onStart,
  onCancel,
}: {
  availability: ReconcileAvailability;
  state: ReconcileUiState;
  onStart: () => void;
  onCancel: () => void;
}) {
  const running = state.phase === "running";
  const message = state.phase === "done" ? reconcileOutcomeMessage(state.outcome) : null;
  const refreshing = state.phase === "done" && state.refresh === "pending";

  return (
    <section aria-label="Online evidence reconciliation" className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[#112D5C]">
            <Wifi size={15} aria-hidden />
            Online evidence
          </h2>
          <p className="mt-0.5 max-w-2xl text-xs text-slate-600">
            Records online class joins that were not recorded automatically. Teacher decisions are never changed.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={!availability.allowed || running || refreshing}
            aria-busy={running}
            aria-disabled={!availability.allowed || running || refreshing}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#112D5C] px-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            {running ? "Reconciling…" : "Reconcile online evidence"}
          </button>
          {running ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Square size={13} aria-hidden />
              Stop
            </button>
          ) : null}
        </div>
      </div>

      {!availability.allowed && availability.reason ? <p className="mt-2 text-xs text-slate-600">{availability.reason}</p> : null}
      {availability.allowed && availability.note ? (
        <p className="mt-2 rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">{availability.note}</p>
      ) : null}

      <div role="status" aria-live="polite" className="mt-2">
        {running ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm text-slate-800">
            <p className="flex items-center gap-1.5 font-semibold">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Reconciliation is running
            </p>
            {state.progress ? (
              <>
                <p className="mt-1 text-xs text-slate-600">
                  Pass {state.progress.pass} · page {state.progress.pageInPass} of this pass · {state.progress.pages} page(s) in total
                </p>
                <Counts totals={state.progress.totals} compact />
              </>
            ) : (
              <p className="mt-1 text-xs text-slate-600">Starting…</p>
            )}
          </div>
        ) : null}

        {message && state.phase === "done" ? (
          <div className={`rounded-lg border p-2 text-sm ${TONE[message.tone].box}`} data-outcome={state.outcome.status}>
            <p className="flex items-center gap-1.5 font-semibold">
              {TONE[message.tone].icon}
              {message.title}
            </p>
            <p className="mt-1 text-xs">{message.body}</p>
            <p className="mt-1 text-xs">
              {state.outcome.passes} pass(es), {state.outcome.pages} page(s).
            </p>
            <Counts totals={state.outcome.totals} />
            {REFRESH_TEXT[state.refresh] ? <p className="mt-2 text-xs font-medium">{REFRESH_TEXT[state.refresh]}</p> : null}
            {message.next === "SIGN_IN" ? (
              <Link href="/login" className="mt-2 inline-flex rounded-lg bg-[#112D5C] px-3 py-1.5 text-xs font-semibold text-white">
                Sign in
              </Link>
            ) : null}
            {message.next === "RELOAD_PAGE" ? <p className="mt-2 text-xs font-medium">Reload the page, then try again.</p> : null}
            {message.next === "CONTACT_SUPPORT" ? <p className="mt-2 text-xs font-medium">If this continues, contact support.</p> : null}
            {message.next === "RUN_AGAIN" && availability.allowed ? <p className="mt-2 text-xs font-medium">You can run reconciliation again.</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
