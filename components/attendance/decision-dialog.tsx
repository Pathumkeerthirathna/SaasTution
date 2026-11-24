"use client";

/*
 * The teacher's manual attendance decision (Stage 5.6d): the per-student
 * "Change status" action and its dialog. Presentational: the request,
 * duplicate prevention, the version check, 409 handling and the register
 * refresh are components/attendance/record-action-controller.ts; the reason
 * rule is the shared one (decisionReasonRequirement / checkAttendanceReason
 * in attendance-ui.ts). The server stays the authority.
 *
 * Two steps: choose a status (never the current one: an unchanged decision is
 * a no-op on the server) and give a reason when one is required, then an
 * explicit confirmation of exactly what will be recorded.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, PencilLine, X, XCircle } from "lucide-react";

import {
  ATTENDANCE_REASON_MAX_LENGTH,
  attendanceErrorAction,
  attendanceStatusLabel,
  checkAttendanceReason,
  decisionReasonRequirement,
  reasonProblemMessage,
  statusSourceLabel,
  TEACHER_ATTENDANCE_STATUSES,
  type AttendanceRegisterResponse,
  type ReasonProblem,
  type ReasonRequirement,
  type TeacherAttendanceStatus,
} from "@/components/attendance/attendance-ui";
import type { RecordActionUiState } from "@/components/attendance/record-action-controller";
import { useModalDialog } from "@/components/attendance/use-modal-dialog";

type RegisterStudent = AttendanceRegisterResponse["students"][number];

/** Where focus returns when the action that opened the dialog no longer exists. */
export const REGISTER_STUDENTS_ID = "attendance-register-students";

// =========================================================================================
// Pure helpers (exported for tests)
// =========================================================================================

/** The student as the dialog uses it: a snapshot taken when the dialog opens (its version is never changed). */
export type DecisionTarget = {
  studentId: string;
  name: string;
  registrationNumber: string | null;
  /** The effective status of the loaded record, or null (no record). */
  currentStatus: TeacherAttendanceStatus | null;
  currentSource: string | null;
  /** The loaded record (its version is the decision's expectedVersion), or null. */
  record: { version: number } | null;
  finalized: boolean;
};

const isTeacherStatus = (value: string | null | undefined): value is TeacherAttendanceStatus =>
  (TEACHER_ATTENDANCE_STATUSES as readonly string[]).includes(value ?? "");

export function decisionTargetOf(student: RegisterStudent, register: AttendanceRegisterResponse): DecisionTarget {
  return {
    studentId: student.studentId,
    name: student.name ?? "Unknown student",
    registrationNumber: student.registrationNumber,
    currentStatus: isTeacherStatus(student.record?.status) ? (student.record?.status as TeacherAttendanceStatus) : null,
    currentSource: student.record?.statusSource ?? null,
    record: student.record ? { version: student.record.version } : null,
    finalized: register.register.finalized,
  };
}

export type DecisionAvailability = { allowed: boolean; reason: string | null };

/**
 * Whether the action is offered for a student (only where the server would
 * accept it): not on a cancelled lecture (409), not for a record of a student
 * who is not the teacher's (shown without a name: 404), not for an inactive
 * or deleted student (404). The server re-checks everything.
 */
export function decisionAvailability(student: RegisterStudent, register: AttendanceRegisterResponse): DecisionAvailability {
  if (register.lecture.classStatus === "CANCELLED") return { allowed: false, reason: "This lecture is cancelled." };
  if (student.name === null) return { allowed: false, reason: "Not one of your students." };
  if (student.eligibility?.reason === "STUDENT_INACTIVE") return { allowed: false, reason: "This student is inactive." };
  if (student.record !== null && !isTeacherStatus(student.record.status)) return { allowed: false, reason: "Unknown attendance status." };
  return { allowed: true, reason: null };
}

/** The statuses offered: every teacher status except the current one (no same-status action). */
export function decisionStatusOptions(current: TeacherAttendanceStatus | null): TeacherAttendanceStatus[] {
  return TEACHER_ATTENDANCE_STATUSES.filter((status) => status !== current);
}

export function decisionRequirement(target: DecisionTarget): ReasonRequirement {
  return decisionReasonRequirement({ hasRecord: target.record !== null, finalized: target.finalized });
}

/** Why a reason is (or is not) required, in the server's terms. */
export function decisionReasonExplanation(target: DecisionTarget): string {
  if (target.finalized && target.record === null) return "A reason is required: the register is finalized, so every change is recorded with a reason.";
  if (target.finalized) return "A reason is required: the register is finalized and this replaces the recorded status.";
  if (target.record !== null) return "A reason is required: this replaces the student's recorded status.";
  return "A reason is optional for a first mark on an open register.";
}

export type DecisionDraft = { status: TeacherAttendanceStatus | null; reason: string };
export type DecisionDraftProblem = "STATUS_REQUIRED" | "SAME_STATUS" | ReasonProblem;

export type DecisionDraftCheck = { ok: true; status: TeacherAttendanceStatus; reason: string | null } | { ok: false; problem: DecisionDraftProblem };

/** The draft as it would be sent: a status other than the current one, and the shared reason rule. */
export function checkDecisionDraft(target: DecisionTarget, draft: DecisionDraft): DecisionDraftCheck {
  if (draft.status === null) return { ok: false, problem: "STATUS_REQUIRED" };
  if (draft.status === target.currentStatus) return { ok: false, problem: "SAME_STATUS" };
  const reason = checkAttendanceReason(draft.reason, decisionRequirement(target));
  if (!reason.ok) return { ok: false, problem: reason.problem };
  return { ok: true, status: draft.status, reason: reason.reason };
}

export function decisionDraftProblemMessage(problem: DecisionDraftProblem): string {
  if (problem === "STATUS_REQUIRED") return "Choose the new attendance status.";
  if (problem === "SAME_STATUS") return "Choose a status different from the current one.";
  return reasonProblemMessage(problem);
}

/** Busy: sending, or refreshing the register after it (nothing in the dialog may be used). */
export function decisionBusy(action: RecordActionUiState): boolean {
  return action.phase === "submitting" || ((action.phase === "succeeded" || action.phase === "failed") && action.refresh === "pending");
}

/**
 * After a 409 (the record changed, or the server refused the state) the
 * register has been refreshed and the dialog's snapshot is out of date: the
 * teacher must close it and decide again from the current register (never a
 * retry with another version).
 */
export function decisionNeedsReopen(action: RecordActionUiState): boolean {
  return action.phase === "failed" && action.refresh !== "skipped";
}

// =========================================================================================
// The row action
// =========================================================================================

/** The compact action's accessible name and tooltip. */
export const CHANGE_STATUS_LABEL = "Change attendance status";

export function DecisionAction({
  student,
  register,
  onOpen,
  compact = false,
}: {
  student: RegisterStudent;
  register: AttendanceRegisterResponse;
  onOpen: (student: RegisterStudent) => void;
  /** An icon button (the Attendance page's register): a tooltip and an accessible name instead of the text. */
  compact?: boolean;
}) {
  const availability = decisionAvailability(student, register);
  if (!availability.allowed) return <span className="text-[11px] text-slate-500">{availability.reason}</span>;
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => onOpen(student)}
        data-decision-action={student.studentId}
        title={CHANGE_STATUS_LABEL}
        aria-label={`${CHANGE_STATUS_LABEL}: ${student.name ?? "Unknown student"}`}
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border md:h-9 md:w-9 border-[#112D5C] text-[#112D5C] hover:bg-[#112D5C] hover:text-white"
      >
        <PencilLine size={16} aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(student)}
      data-decision-action={student.studentId}
      className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-[#112D5C] px-2.5 text-xs font-semibold text-[#112D5C] hover:bg-[#112D5C] hover:text-white"
    >
      <PencilLine size={13} aria-hidden />
      Change status
      <span className="sr-only">: {student.name ?? "Unknown student"}</span>
    </button>
  );
}

// =========================================================================================
// The dialog
// =========================================================================================

export type DecisionStep = "edit" | "confirm";

const statusText = (status: TeacherAttendanceStatus | null) => attendanceStatusLabel(status).label;

export function DecisionDialog({
  target,
  draft,
  step,
  problem,
  action,
  onStatusChange,
  onReasonChange,
  onContinue,
  onBack,
  onConfirm,
  onClose,
}: {
  /** Null: closed. */
  target: DecisionTarget | null;
  draft: DecisionDraft;
  step: DecisionStep;
  /** Shown after the teacher tried to continue with an invalid draft. */
  problem: DecisionDraftProblem | null;
  action: RecordActionUiState;
  onStatusChange: (status: TeacherAttendanceStatus) => void;
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

  const requirement = decisionRequirement(target);
  const options = decisionStatusOptions(target.currentStatus);
  // Only this student's DECISION result (a review result belongs to the review dialog, Stage 5.6e).
  const ownAction = action.phase !== "idle" && action.kind === "decision" && action.studentId === target.studentId ? action : null;
  const failed = ownAction?.phase === "failed" ? ownAction : null;
  const needsReopen = ownAction ? decisionNeedsReopen(ownAction) : false;
  const trimmedLength = draft.reason.trim().length;
  const reasonProblem = problem === "REQUIRED" || problem === "TOO_LONG" ? problem : null;
  const statusProblem = problem === "STATUS_REQUIRED" || problem === "SAME_STATUS" ? problem : null;

  return (
    <div ref={overlayRef} data-dialog-overlay className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-dialog-title"
        aria-describedby="decision-dialog-description"
        aria-busy={busy}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 bg-[#112D5C] px-4 py-3 text-white">
          <div className="min-w-0">
            <h2 id="decision-dialog-title" className="text-base font-semibold">
              Change attendance status
            </h2>
            <p id="decision-dialog-description" className="break-words text-xs text-white/80">
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
          <p className="text-sm text-slate-700" data-current-status>
            Current status: <strong>{statusText(target.currentStatus)}</strong>
            {target.currentSource ? <span className="text-slate-500"> ({statusSourceLabel(target.currentSource)})</span> : null}
          </p>
          {target.finalized ? (
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
              This register is finalized. The change is recorded as made after finalization; the register stays finalized.
            </p>
          ) : null}

          {failed ? (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
              <p className="flex items-center gap-1.5 font-semibold">
                <XCircle size={16} aria-hidden />
                {failed.stale ? "This student's attendance changed" : failed.cancelled ? "The change was cancelled" : "The change was not saved"}
              </p>
              <p className="mt-1 text-xs">{failed.error.message}</p>
              {needsReopen ? (
                <p className="mt-1 text-xs">
                  {failed.refresh === "pending"
                    ? "Refreshing the register…"
                    : failed.refresh === "done"
                      ? "The register has been refreshed. Close this dialog, check the student's current attendance, and make the change again if it is still needed."
                      : "The register could not be refreshed. Reload the page before making another change."}
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
              <fieldset className="flex flex-col gap-2" aria-describedby={statusProblem ? "decision-status-error" : undefined}>
                <legend className="text-xs font-semibold text-slate-600">New status</legend>
                <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
                  {options.map((status) => (
                    <label
                      key={status}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                        draft.status === status ? "border-[#112D5C] bg-[#112D5C]/5 font-semibold text-[#112D5C]" : "border-slate-200 text-slate-800"
                      }`}
                    >
                      <input
                        type="radio"
                        name="decision-status"
                        value={status}
                        checked={draft.status === status}
                        disabled={busy || needsReopen}
                        onChange={() => onStatusChange(status)}
                      />
                      {statusText(status)}
                    </label>
                  ))}
                </div>
                {statusProblem ? (
                  <p id="decision-status-error" className="text-xs font-semibold text-rose-700">
                    {decisionDraftProblemMessage(statusProblem)}
                  </p>
                ) : null}
              </fieldset>

              <div className="flex flex-col gap-1">
                <label htmlFor="decision-reason" className="text-xs font-semibold text-slate-600">
                  Reason {requirement === "REQUIRED" ? "(required)" : "(optional)"}
                </label>
                <textarea
                  id="decision-reason"
                  value={draft.reason}
                  onChange={(event) => onReasonChange(event.target.value)}
                  disabled={busy || needsReopen}
                  rows={3}
                  aria-required={requirement === "REQUIRED"}
                  aria-invalid={reasonProblem !== null}
                  aria-describedby={`decision-reason-help${reasonProblem ? " decision-reason-error" : ""}`}
                  className="w-full rounded-lg border border-slate-200 p-2 text-sm text-slate-800 outline-none focus:border-[#112D5C] aria-[invalid=true]:border-rose-400"
                />
                <p id="decision-reason-help" className="text-[11px] text-slate-500">
                  {decisionReasonExplanation(target)} At most {ATTENDANCE_REASON_MAX_LENGTH} characters ({trimmedLength} used; spaces at the start and end are ignored).
                </p>
                {reasonProblem ? (
                  <p id="decision-reason-error" className="text-xs font-semibold text-rose-700">
                    {decisionDraftProblemMessage(reasonProblem)}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800" data-confirm-summary>
              <p>
                Change <strong>{target.name}</strong> from <strong>{statusText(target.currentStatus)}</strong> to{" "}
                <strong>{statusText(draft.status)}</strong>?
              </p>
              <p className="break-words text-xs text-slate-600">Reason: {draft.reason.trim() === "" ? "None given" : draft.reason.trim()}</p>
              <p className="text-xs text-slate-600">The change is recorded in the attendance history with your name and cannot be deleted.</p>
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
