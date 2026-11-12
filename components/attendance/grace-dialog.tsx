"use client";

/*
 * The per-lecture grace period on the register page (Stage 5.7b-2b-3): the
 * "Change" action beside the register's grace and its dialog. Presentational:
 * the request, duplicate prevention, the version check, 409 handling and the
 * register refresh are components/attendance/grace-controller.ts; the server
 * decides whether a reason is required (ATTENDANCE_REASON_REQUIRED) and
 * whether attendance is recalculated (recalculatedCount).
 *
 * Two steps: the new value (whole minutes 0–240) and an optional reason, then
 * an explicit confirmation. The reason becomes required only when the server
 * says so; the teacher then resubmits explicitly.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Clock, Loader2, X, XCircle } from "lucide-react";

import {
  ATTENDANCE_REASON_MAX_LENGTH,
  attendanceErrorAction,
  checkAttendanceReason,
  graceInputProblemMessage,
  GRACE_MINUTES_MAX,
  GRACE_MINUTES_MIN,
  parseGraceMinutesInput,
  reasonProblemMessage,
  type AttendanceRegisterResponse,
  type GraceInputProblem,
  type ReasonProblem,
} from "@/components/attendance/attendance-ui";
import type { GraceUiState } from "@/components/attendance/grace-controller";
import { useModalDialog } from "@/components/attendance/use-modal-dialog";

/** The Change action (focus returns to it) and the register's schedule (the fallback when the action is gone). */
export const GRACE_ACTION_ID = "attendance-grace-change";
export const REGISTER_SCHEDULE_ID = "attendance-register-schedule";

// =========================================================================================
// Pure helpers (exported for tests)
// =========================================================================================

export type GraceAvailability = { allowed: boolean; reason: string | null };

/** Offered only where the server would accept it: an open (not finalized) register of a lecture that is not cancelled. */
export function graceChangeAvailability(register: AttendanceRegisterResponse): GraceAvailability {
  if (register.register.finalized) return { allowed: false, reason: "Finalized attendance cannot be changed." };
  if (register.lecture.classStatus === "CANCELLED") return { allowed: false, reason: "This lecture is cancelled." };
  return { allowed: true, reason: null };
}

/** A snapshot taken when the dialog opens (its version is never changed locally). */
export type GraceTarget = {
  lectureTitle: string;
  currentGraceMinutes: number;
  /** register.version as loaded (0: no register yet). */
  expectedVersion: number;
};

export function graceTargetOf(register: AttendanceRegisterResponse): GraceTarget {
  return { lectureTitle: register.lecture.title, currentGraceMinutes: register.register.graceMinutes, expectedVersion: register.register.version };
}

export type GraceDraft = { value: string; reason: string };
/** Which field is wrong, and how. */
export type GraceDraftProblem = { field: "value"; problem: GraceInputProblem | "SAME_VALUE" } | { field: "reason"; problem: ReasonProblem };
export type GraceDraftCheck = { ok: true; graceMinutes: number; reason: string | null } | { ok: false; problem: GraceDraftProblem };

/**
 * The draft as it would be sent: whole minutes 0–240, different from the
 * current value; the reason trimmed and at most 500 characters, and required
 * only after the server asked for one (reasonRequired).
 */
export function checkGraceDraft(target: GraceTarget, draft: GraceDraft, reasonRequired: boolean): GraceDraftCheck {
  const parsed = parseGraceMinutesInput(draft.value);
  if (!parsed.ok) return { ok: false, problem: { field: "value", problem: parsed.problem } };
  if (parsed.value === target.currentGraceMinutes) return { ok: false, problem: { field: "value", problem: "SAME_VALUE" } };
  const reason = checkAttendanceReason(draft.reason, reasonRequired ? "REQUIRED" : "OPTIONAL");
  if (!reason.ok) return { ok: false, problem: { field: "reason", problem: reason.problem } };
  return { ok: true, graceMinutes: parsed.value, reason: reason.reason };
}

export function graceDraftProblemMessage(problem: GraceDraftProblem): string {
  if (problem.field === "reason") return reasonProblemMessage(problem.problem);
  if (problem.problem === "SAME_VALUE") return "Choose a grace period different from the current one.";
  return graceInputProblemMessage(problem.problem);
}

export function graceBusy(state: GraceUiState): boolean {
  return state.phase === "submitting" || ((state.phase === "succeeded" || state.phase === "failed") && state.refresh === "pending");
}

function failureTitle(state: Extract<GraceUiState, { phase: "failed" }>): string {
  if (state.reasonRequired) return "A reason is required";
  switch (state.error.code) {
    case "ATTENDANCE_REGISTER_CHANGED":
      return "The attendance register changed";
    case "ATTENDANCE_REGISTER_FINALIZED":
      return "Finalized attendance cannot be changed";
    case "LECTURE_CANCELLED":
      return "This lecture is cancelled";
    case "ATTENDANCE_BUSY":
      return "Attendance is busy";
    default:
      return "The grace period was not changed";
  }
}

// =========================================================================================
// The action
// =========================================================================================

export function GraceAction({ register, onOpen }: { register: AttendanceRegisterResponse; onOpen: () => void }) {
  if (!graceChangeAvailability(register).allowed) return null;
  return (
    <button
      type="button"
      id={GRACE_ACTION_ID}
      onClick={onOpen}
      className="ml-2 inline-flex h-7 items-center gap-1 rounded-md border border-[#112D5C] px-2 text-xs font-semibold text-[#112D5C] hover:bg-[#112D5C] hover:text-white"
    >
      Change
      <span className="sr-only"> grace period</span>
    </button>
  );
}

// =========================================================================================
// The dialog
// =========================================================================================

export type GraceStep = "edit" | "confirm";

export function GraceDialog({
  target,
  draft,
  step,
  problem,
  reasonRequired,
  state,
  onValueChange,
  onReasonChange,
  onContinue,
  onBack,
  onConfirm,
  onClose,
}: {
  /** Null: closed. */
  target: GraceTarget | null;
  draft: GraceDraft;
  step: GraceStep;
  /** Shown after the teacher tried to continue with an invalid draft. */
  problem: GraceDraftProblem | null;
  /** The server asked for a reason (ATTENDANCE_REASON_REQUIRED). */
  reasonRequired: boolean;
  state: GraceUiState;
  onValueChange: (value: string) => void;
  onReasonChange: (reason: string) => void;
  onContinue: () => void;
  onBack: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const open = target !== null;
  const busy = graceBusy(state);
  const { refocus } = useModalDialog({ open, dialogRef, overlayRef, canClose: () => !busy, onClose, fallbackId: REGISTER_SCHEDULE_ID });

  // A step change or submitting removes / disables the focused control: keep focus inside the dialog.
  useEffect(() => {
    if (open) refocus();
  }, [open, step, busy, refocus]);

  if (!target) return null;

  const failed = state.phase === "failed" ? state : null;
  const mustReopen = failed?.mustReopen === true;
  const reasonInvalid = problem?.field === "reason";
  const valueInvalid = problem?.field === "value";
  const parsed = parseGraceMinutesInput(draft.value);

  return (
    <div ref={overlayRef} data-dialog-overlay className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="grace-dialog-title"
        aria-describedby="grace-dialog-description"
        aria-busy={busy}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 bg-[#112D5C] px-4 py-3 text-white">
          <div className="min-w-0">
            <h2 id="grace-dialog-title" className="flex items-center gap-1.5 text-base font-semibold">
              <Clock size={16} aria-hidden />
              Change the grace period
            </h2>
            <p id="grace-dialog-description" className="break-words text-xs text-white/80">
              {target.lectureTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-md p-1 text-white/90 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto p-4">
          <p className="text-sm text-slate-700" data-current-grace>
            Current grace period: <strong>{target.currentGraceMinutes} minutes</strong>
          </p>
          <p className="text-xs text-slate-600">
            Online joins and QR scans up to this many minutes after the scheduled start count as Present; later ones count as Late. Attendance already
            recorded for this lecture is recalculated with the new value (teacher decisions are kept).
          </p>

          {failed ? (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
              <p className="flex items-center gap-1.5 font-semibold">
                <XCircle size={16} aria-hidden />
                {failureTitle(failed)}
              </p>
              <p className="mt-1 text-xs">
                {failed.reasonRequired
                  ? "Existing attendance records will be recalculated, so a reason is required. Enter a reason and confirm again."
                  : failed.error.message}
              </p>
              {mustReopen ? (
                <p className="mt-1 text-xs">
                  {failed.refresh === "pending"
                    ? "Refreshing the register…"
                    : failed.refresh === "done"
                      ? "The register has been refreshed. Close this dialog and check the current register."
                      : "The register could not be refreshed. Reload the page."}
                </p>
              ) : null}
              {attendanceErrorAction(failed.error.code) === "SIGN_IN" ? (
                <Link href="/login" className="mt-2 inline-flex rounded-lg bg-[#112D5C] px-3 py-1.5 text-xs font-semibold text-white">
                  Sign in
                </Link>
              ) : null}
            </div>
          ) : null}

          {step === "edit" ? (
            <>
              <div className="flex flex-col gap-1">
                <label htmlFor="grace-minutes" className="text-xs font-semibold text-slate-600">
                  New grace period (minutes)
                </label>
                <input
                  id="grace-minutes"
                  type="number"
                  inputMode="numeric"
                  min={GRACE_MINUTES_MIN}
                  max={GRACE_MINUTES_MAX}
                  step={1}
                  value={draft.value}
                  onChange={(event) => onValueChange(event.target.value)}
                  disabled={busy || mustReopen}
                  aria-invalid={valueInvalid}
                  aria-describedby={`grace-minutes-help${valueInvalid ? " grace-minutes-error" : ""}`}
                  className="h-9 w-40 rounded-lg border border-slate-200 px-2 text-sm text-slate-800 outline-none focus:border-[#112D5C] aria-[invalid=true]:border-rose-400"
                />
                <p id="grace-minutes-help" className="text-[11px] text-slate-500">
                  Whole minutes from {GRACE_MINUTES_MIN} to {GRACE_MINUTES_MAX}.
                </p>
                {valueInvalid && problem ? (
                  <p id="grace-minutes-error" className="text-xs font-semibold text-rose-700">
                    {graceDraftProblemMessage(problem)}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="grace-reason" className="text-xs font-semibold text-slate-600">
                  Reason {reasonRequired ? "(required)" : "(optional)"}
                </label>
                <textarea
                  id="grace-reason"
                  value={draft.reason}
                  onChange={(event) => onReasonChange(event.target.value)}
                  disabled={busy || mustReopen}
                  rows={3}
                  aria-required={reasonRequired}
                  aria-invalid={reasonInvalid}
                  aria-describedby={`grace-reason-help${reasonInvalid ? " grace-reason-error" : ""}`}
                  className="w-full rounded-lg border border-slate-200 p-2 text-sm text-slate-800 outline-none focus:border-[#112D5C] aria-[invalid=true]:border-rose-400"
                />
                <p id="grace-reason-help" className="text-[11px] text-slate-500">
                  {reasonRequired
                    ? "Required: existing attendance records will be recalculated."
                    : "Optional unless existing attendance records are recalculated (the server will ask)."}{" "}
                  At most {ATTENDANCE_REASON_MAX_LENGTH} characters ({draft.reason.trim().length} used).
                </p>
                {reasonInvalid && problem ? (
                  <p id="grace-reason-error" className="text-xs font-semibold text-rose-700">
                    {graceDraftProblemMessage(problem)}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800" data-confirm-summary>
              <p>
                Change the grace period from <strong>{target.currentGraceMinutes} minutes</strong> to{" "}
                <strong>{parsed.ok ? parsed.value : draft.value} minutes</strong>?
              </p>
              <p className="break-words text-xs text-slate-600">Reason: {draft.reason.trim() === "" ? "None given" : draft.reason.trim()}</p>
              <p className="text-xs text-slate-600">The change is recorded in the register history with your name and cannot be deleted.</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 p-4">
          {step === "edit" ? (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                data-autofocus
                className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {mustReopen ? "Close" : "Cancel"}
              </button>
              {mustReopen ? null : (
                <button
                  type="button"
                  onClick={onContinue}
                  disabled={busy}
                  className="h-9 rounded-lg bg-[#112D5C] px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Continue
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={mustReopen ? onClose : onBack}
                disabled={busy}
                data-autofocus
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {mustReopen ? null : <ArrowLeft size={14} aria-hidden />}
                {mustReopen ? "Close" : "Back"}
              </button>
              {mustReopen ? null : (
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={busy}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#112D5C] px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                  {busy ? "Saving…" : failed ? "Try again" : "Confirm change"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
