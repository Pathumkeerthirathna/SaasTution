"use client";

/*
 * The "Close QR attendance" confirmation (Stage 5.7b-3e). The modal
 * behaviour is the shared one (use-modal-dialog.ts: focus moved inside and
 * trapped, the background inert, Escape closes unless a request is
 * running, focus returned to the trigger or, when the trigger is gone after
 * a closure, to the register's QR section). A bottom sheet on narrow
 * screens. The request flow is qr-closure-controller.ts.
 */

import Link from "next/link";
import { useEffect, useRef } from "react";
import { AlertTriangle, Loader2, Lock, X, XCircle } from "lucide-react";

import { attendanceErrorAction, formatColomboDateTime, type AttendanceRegisterResponse } from "@/components/attendance/attendance-ui";
import { qrClosureBusy, type QrClosureUiState } from "@/components/attendance/qr-closure-controller";
import { QR_SECTION_ID } from "@/components/attendance/qr-scan-entry";
import { useModalDialog } from "@/components/attendance/use-modal-dialog";

/** A snapshot of the register taken when the dialog opens. */
export type QrClosureTarget = {
  lectureTitle: string;
  window: string;
  opensAt: string;
  registerFinalized: boolean;
  /** Students whose record shows QR attendance (accepted scans only). */
  qrRecordedCount: number;
};

export function qrClosureTargetOf(register: AttendanceRegisterResponse): QrClosureTarget {
  return {
    lectureTitle: register.lecture.title,
    window: register.qr.window,
    opensAt: register.qr.opensAt,
    registerFinalized: register.register.finalized,
    qrRecordedCount: register.students.filter((s) => s.record?.firstQrAt).length,
  };
}

function failureTitle(state: Extract<QrClosureUiState, { phase: "failed" }>): string {
  switch (state.kind) {
    case "AMBIGUOUS":
      return "The closure could not be confirmed";
    case "BUSY":
      return "Attendance is busy";
    case "GONE":
      return state.error.code === "LECTURE_CANCELLED" ? "This lecture is cancelled" : "Lecture not found";
    case "SIGN_IN":
      return "Please sign in again";
    default:
      return "QR attendance was not closed";
  }
}

function failureDetail(state: Extract<QrClosureUiState, { phase: "failed" }>): string {
  if (state.kind === "AMBIGUOUS") {
    if (state.refresh === "pending") return "Checking the register to see whether QR attendance was closed…";
    if (state.refresh === "failed") return "The register could not be checked either. Reload the page to see whether QR attendance was closed before trying again.";
    return "The register shows QR attendance is still open, so it was not closed. You can try again.";
  }
  if (state.kind === "GONE") {
    if (state.refresh === "pending") return "Refreshing the register…";
    return state.error.code === "LECTURE_CANCELLED"
      ? "QR attendance cannot be closed for a cancelled lecture. The register has been refreshed."
      : "This lecture does not exist or is not one of your lectures.";
  }
  if (state.kind === "BUSY") return "Attendance was being updated. Nothing was changed; you can try again in a moment.";
  if (state.kind === "SIGN_IN") return "Your session has expired. Sign in again, then close QR attendance.";
  return state.error.message;
}

export function QrClosureDialog({
  target,
  state,
  onConfirm,
  onClose,
}: {
  /** Null: closed. */
  target: QrClosureTarget | null;
  state: QrClosureUiState;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const open = target !== null;
  const busy = qrClosureBusy(state);
  const { refocus } = useModalDialog({ open, dialogRef, overlayRef, canClose: () => !busy, onClose, fallbackId: QR_SECTION_ID });

  // Submitting disables the focused control: keep focus inside the dialog.
  useEffect(() => {
    if (open) refocus();
  }, [open, busy, refocus]);

  if (!target) return null;

  const failed = state.phase === "failed" ? state : null;
  const confirmable = !failed || failed.canRetry;
  const notOpen = target.window === "NOT_OPEN";

  return (
    <div ref={overlayRef} data-dialog-overlay className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-closure-dialog-title"
        aria-describedby="qr-closure-dialog-description"
        aria-busy={busy}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 bg-[#112D5C] px-4 py-3 text-white">
          <div className="min-w-0">
            <h2 id="qr-closure-dialog-title" className="flex items-center gap-1.5 text-base font-semibold">
              <Lock size={16} aria-hidden />
              Close QR attendance
            </h2>
            <p className="break-words text-xs text-white/80">{target.lectureTitle}</p>
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

        <div className="flex flex-col gap-3 overflow-y-auto p-4 text-sm text-slate-800">
          <ul id="qr-closure-dialog-description" className="flex list-disc flex-col gap-1.5 pl-5" data-closure-explanation>
            <li>
              QR attendance for this lecture will be closed <strong>permanently</strong>. This cannot be reversed.
            </li>
            <li>No more physical QR scans will be accepted for this lecture, from any device.</li>
            <li>Attendance already recorded, and its history, is kept. Nothing is deleted.</li>
            <li>
              {target.registerFinalized
                ? "The attendance register is already finalized; closing QR attendance does not change it."
                : "This does not finalize the attendance register. Finalize it separately when you are ready."}
            </li>
            {notOpen ? <li>{`Scanning has not opened yet (it would open at ${formatColomboDateTime(target.opensAt)}).`}</li> : null}
          </ul>

          {target.qrRecordedCount === 0 ? (
            <p role="note" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950" data-no-scans-warning>
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              No QR attendance has been recorded for this lecture yet. If you close it now, physical QR attendance cannot be used for this lecture at all.
            </p>
          ) : (
            <p className="text-xs text-slate-600">{`QR attendance is recorded for ${target.qrRecordedCount} student${target.qrRecordedCount === 1 ? "" : "s"}; it stays as it is.`}</p>
          )}

          {failed ? (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-900">
              <p className="flex items-center gap-1.5 font-semibold">
                <XCircle size={16} aria-hidden />
                {failureTitle(failed)}
              </p>
              <p className="mt-1 text-xs">{failureDetail(failed)}</p>
              {attendanceErrorAction(failed.error.code) === "SIGN_IN" ? (
                <Link href="/login" className="mt-2 inline-flex rounded-lg bg-[#112D5C] px-3 py-1.5 text-xs font-semibold text-white">
                  Sign in
                </Link>
              ) : null}
            </div>
          ) : null}
          <p className="sr-only" role="status" aria-live="polite">
            {busy ? "Closing QR attendance…" : ""}
          </p>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 p-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            data-autofocus
            className="min-h-[44px] rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {confirmable ? "Cancel" : "Close"}
          </button>
          {confirmable ? (
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-rose-700 px-4 text-sm font-semibold text-white hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Lock size={14} aria-hidden />}
              {busy ? "Closing…" : failed ? "Try again" : "Close QR attendance permanently"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
