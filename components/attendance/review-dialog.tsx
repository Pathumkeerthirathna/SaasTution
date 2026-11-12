"use client";

/*
 * The teacher's answer to a pending evidence review (Stage 5.6e): the
 * per-student "Accept evidence" / "Dismiss evidence" actions and their
 * dialog. Presentational: the request, duplicate prevention, the version
 * check, 409 handling and the register refresh are
 * components/attendance/record-action-controller.ts (the SAME controller as
 * manual decisions, so a decision and a review are never in flight
 * together); the reason rule is the shared one (reviewReasonRequirement /
 * checkAttendanceReason). The server stays the authority.
 *
 *  - ACCEPT: the evidence status (autoStatus) becomes the teacher's decision;
 *    a reason is always required;
 *  - DISMISS: the current status stays; the review is cleared; a reason is
 *    optional (trimmed and checked when given).
 * Two steps: the reason, then an explicit confirmation.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCheck, Loader2, X, XCircle, Ban } from "lucide-react";

import {
  ATTENDANCE_REASON_MAX_LENGTH,
  attendanceErrorAction,
  attendanceStatusLabel,
  checkAttendanceReason,
  reasonProblemMessage,
  reviewReasonRequirement,
  statusSourceLabel,
  TEACHER_ATTENDANCE_STATUSES,
  type AttendanceRegisterResponse,
  type ReasonCheck,
  type ReasonProblem,
  type ReviewAction,
  type TeacherAttendanceStatus,
} from "@/components/attendance/attendance-ui";
import { decisionBusy, decisionNeedsReopen, REGISTER_STUDENTS_ID, type DecisionStep } from "@/components/attendance/decision-dialog";
import type { RecordActionUiState } from "@/components/attendance/record-action-controller";
import { useModalDialog } from "@/components/attendance/use-modal-dialog";

type RegisterStudent = AttendanceRegisterResponse["students"][number];

const isTeacherStatus = (value: string | null | undefined): value is TeacherAttendanceStatus =>
  (TEACHER_ATTENDANCE_STATUSES as readonly string[]).includes(value ?? "");
const isEvidenceStatus = (value: string | null | undefined): value is "PRESENT" | "LATE" => value === "PRESENT" || value === "LATE";

// =========================================================================================
// Pure helpers (exported for tests)
// =========================================================================================

/** A snapshot of the student taken when the dialog opens (its version is never changed). */
export type ReviewTarget = {
  studentId: string;
  name: string;
  registrationNumber: string | null;
  action: ReviewAction;
  currentStatus: TeacherAttendanceStatus;
  currentSource: string;
  /** The automatic evidence status ACCEPT would apply (null: none recorded). */
  evidenceStatus: "PRESENT" | "LATE" | null;
  pendingSince: string | null;
  /** The loaded record: its version is the review's expectedVersion. */
  record: { version: number };
  finalized: boolean;
};

export type ReviewAvailability = { allowed: boolean; reason: string | null; accept: boolean };

/**
 * Whether review actions are offered (only for a pending review the server
 * would let this teacher answer): a record with review.pending, a known
 * status, not on a cancelled lecture (409), not another teacher's student
 * (404), not an inactive student (404). ACCEPT also needs an evidence status
 * (the server answers 409 ATTENDANCE_NO_PENDING_REVIEW without one).
 */
export function reviewAvailability(student: RegisterStudent, register: AttendanceRegisterResponse): ReviewAvailability {
  const none = (reason: string | null): ReviewAvailability => ({ allowed: false, reason, accept: false });
  if (!student.review.pending || student.record === null) return none(null);
  if (register.lecture.classStatus === "CANCELLED") return none("This lecture is cancelled.");
  if (student.name === null) return none("Not one of your students.");
  if (student.eligibility?.reason === "STUDENT_INACTIVE") return none("This student is inactive.");
  if (!isTeacherStatus(student.record.status)) return none("Unknown attendance status.");
  return { allowed: true, reason: null, accept: isEvidenceStatus(student.record.autoStatus) };
}

export function reviewTargetOf(student: RegisterStudent, register: AttendanceRegisterResponse, action: ReviewAction): ReviewTarget | null {
  const record = student.record;
  if (!record || !isTeacherStatus(record.status)) return null;
  return {
    studentId: student.studentId,
    name: student.name ?? "Unknown student",
    registrationNumber: student.registrationNumber,
    action,
    currentStatus: record.status,
    currentSource: record.statusSource,
    evidenceStatus: isEvidenceStatus(record.autoStatus) ? record.autoStatus : null,
    pendingSince: student.review.since,
    record: { version: record.version },
    finalized: register.register.finalized,
  };
}

/** The reason as it would be sent (the shared rule: ACCEPT required, DISMISS optional; trimmed; ≤ 500). */
export function checkReviewReason(action: ReviewAction, reason: string): ReasonCheck {
  return checkAttendanceReason(reason, reviewReasonRequirement(action));
}

/** What the action does, in the server's terms. */
export function reviewExplanation(target: ReviewTarget): string {
  const current = attendanceStatusLabel(target.currentStatus).label;
  const evidence = target.evidenceStatus ? attendanceStatusLabel(target.evidenceStatus).label : null;
  if (target.action === "ACCEPT") {
    return evidence
      ? `Accepting applies the automatic evidence as your decision: the status changes from ${current} to ${evidence}. A reason is required.`
      : "There is no automatic evidence status to accept.";
  }
  return `Dismissing keeps the current status (${current}) and clears the review. A reason is optional.`;
}

export function reviewResultStatus(target: ReviewTarget): TeacherAttendanceStatus {
  return target.action === "ACCEPT" && target.evidenceStatus ? target.evidenceStatus : target.currentStatus;
}

// =========================================================================================
// The row actions
// =========================================================================================

export function ReviewActions({
  student,
  register,
  onOpen,
}: {
  student: RegisterStudent;
  register: AttendanceRegisterResponse;
  onOpen: (student: RegisterStudent, action: ReviewAction) => void;
}) {
  const availability = reviewAvailability(student, register);
  if (!availability.allowed) return availability.reason ? <span className="text-[11px] text-slate-500">Review: {availability.reason}</span> : null;
  const name = student.name ?? "Unknown student";
  return (
    <div className="flex flex-wrap gap-1.5">
      {availability.accept ? (
        <button
          type="button"
          onClick={() => onOpen(student, "ACCEPT")}
          data-review-action={`${student.studentId}:ACCEPT`}
          className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-emerald-700 px-2.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-700 hover:text-white"
        >
          <CheckCheck size={13} aria-hidden />
          Accept evidence
          <span className="sr-only">: {name}</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onOpen(student, "DISMISS")}
        data-review-action={`${student.studentId}:DISMISS`}
        className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-slate-300 px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
      >
        <Ban size={13} aria-hidden />
        Dismiss evidence
        <span className="sr-only">: {name}</span>
      </button>
    </div>
  );
}

// =========================================================================================
// The dialog
// =========================================================================================

const label = (status: TeacherAttendanceStatus | "PRESENT" | "LATE" | null) => attendanceStatusLabel(status).label;

export function ReviewDialog({
  target,
  reason,
  step,
  problem,
  action,
  onReasonChange,
  onContinue,
  onBack,
  onConfirm,
  onClose,
}: {
  /** Null: closed. */
  target: ReviewTarget | null;
  reason: string;
  step: DecisionStep;
  /** Shown after the teacher tried to continue with an invalid reason. */
  problem: ReasonProblem | null;
  action: RecordActionUiState;
  onReasonChange: (reason: string) => void;
  onContinue: () => void;
  onBack: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const open = target !== null;
  const busy = decisionBusy(action);
  const { refocus } = useModalDialog({ open, dialogRef, overlayRef, canClose: () => !busy, onClose, fallbackId: REGISTER_STUDENTS_ID });

  // A step change or submitting removes / disables the focused control: keep focus inside the dialog.
  useEffect(() => {
    if (open) refocus();
  }, [open, step, busy, refocus]);

  if (!target) return null;

  const accept = target.action === "ACCEPT";
  const requirement = reviewReasonRequirement(target.action);
  // Only this student's REVIEW result (a decision result belongs to the decision dialog).
  const own = action.phase !== "idle" && action.kind === "review" && action.studentId === target.studentId ? action : null;
  const failed = own?.phase === "failed" ? own : null;
  const needsReopen = own ? decisionNeedsReopen(own) : false;
  const title = accept ? "Accept evidence" : "Dismiss evidence";
  const confirmLabel = accept ? "Accept evidence" : "Dismiss evidence";

  return (
    <div ref={overlayRef} data-dialog-overlay className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-dialog-title"
        aria-describedby="review-dialog-description"
        aria-busy={busy}
        tabIndex={-1}
        data-review-dialog={target.action}
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 bg-[#112D5C] px-4 py-3 text-white">
          <div className="min-w-0">
            <h2 id="review-dialog-title" className="text-base font-semibold">
              {title}
            </h2>
            <p id="review-dialog-description" className="break-words text-xs text-white/80">
              {target.name}
              {target.registrationNumber ? ` · ${target.registrationNumber}` : ""}
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
          <dl className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm min-[420px]:grid-cols-2" data-review-statuses>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Current status</dt>
              <dd className="text-slate-900">
                <strong>{label(target.currentStatus)}</strong> <span className="text-xs text-slate-500">({statusSourceLabel(target.currentSource)})</span>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Automatic evidence status</dt>
              <dd className="text-slate-900">
                <strong>{target.evidenceStatus ? label(target.evidenceStatus) : "None recorded"}</strong>
              </dd>
            </div>
          </dl>
          <p className="text-sm text-slate-700">{reviewExplanation(target)}</p>
          {target.finalized ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              This register is finalized. The answer is recorded as made after finalization; the register stays finalized.
            </p>
          ) : null}

          {failed ? (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
              <p className="flex items-center gap-1.5 font-semibold">
                <XCircle size={16} aria-hidden />
                {failed.stale ? "This review changed or is no longer pending" : failed.cancelled ? "The action was cancelled" : "The action was not saved"}
              </p>
              <p className="mt-1 text-xs">{failed.error.message}</p>
              {needsReopen ? (
                <p className="mt-1 text-xs">
                  {failed.refresh === "pending"
                    ? "Refreshing the register…"
                    : failed.refresh === "done"
                      ? "The register has been refreshed. Close this dialog and check the student's current attendance and review state."
                      : "The register could not be refreshed. Reload the page before trying again."}
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
            <div className="flex flex-col gap-1">
              <label htmlFor="review-reason" className="text-xs font-semibold text-slate-600">
                Reason {requirement === "REQUIRED" ? "(required)" : "(optional)"}
              </label>
              <textarea
                id="review-reason"
                value={reason}
                onChange={(event) => onReasonChange(event.target.value)}
                disabled={busy || needsReopen}
                rows={3}
                aria-required={requirement === "REQUIRED"}
                aria-invalid={problem !== null}
                aria-describedby={`review-reason-help${problem ? " review-reason-error" : ""}`}
                className="w-full rounded-lg border border-slate-200 p-2 text-sm text-slate-800 outline-none focus:border-[#112D5C] aria-[invalid=true]:border-rose-400"
              />
              <p id="review-reason-help" className="text-[11px] text-slate-500">
                {requirement === "REQUIRED" ? "Accepting replaces the recorded status, so a reason is required." : "Optional."} At most{" "}
                {ATTENDANCE_REASON_MAX_LENGTH} characters ({reason.trim().length} used; spaces at the start and end are ignored).
              </p>
              {problem ? (
                <p id="review-reason-error" className="text-xs font-semibold text-rose-700">
                  {reasonProblemMessage(problem)}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-800" data-confirm-summary>
              <p>
                {accept ? (
                  <>
                    Accept the evidence for <strong>{target.name}</strong>: change from <strong>{label(target.currentStatus)}</strong> to{" "}
                    <strong>{label(reviewResultStatus(target))}</strong>?
                  </>
                ) : (
                  <>
                    Dismiss the evidence for <strong>{target.name}</strong> and keep <strong>{label(target.currentStatus)}</strong>?
                  </>
                )}
              </p>
              <p className="break-words text-xs text-slate-600">Reason: {reason.trim() === "" ? "None given" : reason.trim()}</p>
              <p className="text-xs text-slate-600">The answer is recorded in the attendance history with your name and cannot be deleted.</p>
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
                {needsReopen ? "Close" : "Cancel"}
              </button>
              {needsReopen ? null : (
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
                onClick={needsReopen ? onClose : onBack}
                disabled={busy}
                data-autofocus
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {needsReopen ? null : <ArrowLeft size={14} aria-hidden />}
                {needsReopen ? "Close" : "Back"}
              </button>
              {needsReopen ? null : (
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={busy}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#112D5C] px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                  {busy ? "Saving…" : failed ? "Try again" : confirmLabel}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
