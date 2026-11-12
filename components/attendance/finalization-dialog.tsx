"use client";

/*
 * Finalization on the register page (Stage 5.5d-4): the register-level
 * section ("Preview finalization") and the dialog (preview, blockers,
 * warnings, irreversible confirmation, result). Presentational: the
 * workflow is components/attendance/finalization-controller.ts. Blockers and
 * the fingerprint come from the server's preview; nothing here decides
 * whether finalization is allowed.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Loader2, Lock, OctagonX, RefreshCw, X, XCircle } from "lucide-react";

import {
  attendanceErrorAction,
  finalizationBlockerMessage,
  type AttendanceApiError,
  type AttendanceRegisterResponse,
  type FinalizationPreviewResponse,
  type FinalizeResponse,
} from "@/components/attendance/attendance-ui";
import { createDialogFocusManager, type DialogFocusManager, type FocusContainer } from "@/components/attendance/dialog-focus";
import { makeOutsideInert } from "@/components/attendance/dialog-inert";
import { previewAllowsConfirmation, type FinalizationUiState } from "@/components/attendance/finalization-controller";

/** The finalization section: where focus returns when the dialog's trigger no longer exists. */
export const FINALIZE_SECTION_ID = "attendance-finalize-section";

/**
 * The dialog element as the focus manager sees it. contains() means strictly
 * inside: focus resting on the dialog element itself (tabIndex -1) counts as
 * outside, so Tab / Shift+Tab from there wrap to the first / last control.
 */
function focusContainerOf(node: HTMLElement | null): FocusContainer | null {
  if (!node) return null;
  return {
    focus: (options) => node.focus(options),
    querySelectorAll: (selector) => node.querySelectorAll<HTMLElement>(selector),
    querySelector: (selector) => node.querySelector<HTMLElement>(selector),
    contains: (target) => target instanceof Node && target !== node && node.contains(target),
  };
}

const COLOMBO = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Colombo" });
const when = (value: string | null | undefined) => {
  if (!value) return "—";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? "—" : COLOMBO.format(new Date(ms));
};

/** A display reference for the preview (the full fingerprint is only ever sent back to the server). */
export function fingerprintReference(fingerprint: string): string {
  return fingerprint.length > 12 ? `${fingerprint.slice(0, 12)}…` : fingerprint;
}

/** Non-blocking points the teacher should know before confirming (never blockers). */
export function finalizationWarnings(preview: FinalizationPreviewResponse): string[] {
  const out: string[] = [];
  if (preview.evidence.pendingReviews > 0) {
    out.push(`${preview.evidence.pendingReviews} pending review(s) remain. They do not block finalization and can still be answered afterwards.`);
  }
  if (preview.summary.manualReview > 0) {
    out.push(`${preview.summary.manualReview} student(s) with unknown approval at the start will not be marked absent automatically; decide their attendance manually.`);
  }
  if (preview.summary.automaticAbsent > 0) {
    out.push(`${preview.summary.automaticAbsent} student(s) without attendance will be marked ABSENT.`);
  }
  return out;
}

// ---- Register-level section --------------------------------------------------------------------

export type FinalizeAvailability = { allowed: boolean; reason: string | null };

/** Whether the "Preview finalization" action is offered (the preview itself reports every blocker). */
export function finalizeAvailability(register: AttendanceRegisterResponse, reconciling: boolean): FinalizeAvailability {
  if (register.register.finalized) return { allowed: false, reason: null };
  if (!register.finalization.configured) {
    return { allowed: false, reason: "Attendance settings are not configured on this server, so attendance cannot be finalized." };
  }
  if (reconciling) return { allowed: false, reason: "Wait for online evidence reconciliation to finish." };
  return { allowed: true, reason: null };
}

export function FinalizationSection({
  register,
  availability,
  onPreview,
}: {
  register: AttendanceRegisterResponse;
  availability: FinalizeAvailability;
  onPreview: () => void;
}) {
  const finalized = register.register.finalized;
  return (
    <section
      id={FINALIZE_SECTION_ID}
      tabIndex={-1}
      aria-label="Finalize attendance"
      className="rounded-xl border border-slate-200 bg-white p-3 outline-none focus-visible:ring-2 focus-visible:ring-[#112D5C] sm:p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[#112D5C]">
            <ClipboardCheck size={15} aria-hidden />
            Finalize attendance
          </h2>
          <p className="mt-0.5 max-w-2xl text-xs text-slate-600">
            {finalized
              ? `Finalized on ${when(register.register.finalizedAt)}. Finalization cannot be undone.`
              : "Review what finalization will do, then confirm. Finalization cannot be undone."}
          </p>
        </div>
        {finalized ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
            <Lock size={13} aria-hidden />
            Finalized
          </span>
        ) : (
          <button
            type="button"
            onClick={onPreview}
            disabled={!availability.allowed}
            aria-disabled={!availability.allowed}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#112D5C] px-3 text-sm font-semibold text-[#112D5C] transition hover:bg-[#112D5C] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ClipboardCheck size={14} aria-hidden />
            Preview finalization
          </button>
        )}
      </div>
      {!finalized && availability.reason ? <p className="mt-2 text-xs text-slate-600">{availability.reason}</p> : null}
    </section>
  );
}

// ---- Dialog pieces -------------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
      <dt className="text-[11px] font-semibold text-slate-500">{label}</dt>
      <dd className="text-sm font-bold text-[#112D5C]">{value}</dd>
    </div>
  );
}

function PreviewDetails({ preview }: { preview: FinalizationPreviewResponse }) {
  const { register, summary, evidence } = preview;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Stat label="Scheduled start (used for finalization)" value={when(register.scheduledStartAt)} />
        <Stat label="Scheduled end" value={register.scheduledEndAt ? when(register.scheduledEndAt) : "No end time"} />
        <Stat label="Grace period" value={`${register.graceMinutes} minutes`} />
        <Stat label="Register version" value={register.exists ? register.version : "Not created yet (will be created)"} />
      </dl>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Students</h3>
        <dl className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="On the roster" value={summary.rosterSize} />
          <Stat label="Eligible at the start" value={summary.eligibleStudents} />
          <Stat label="Already recorded" value={summary.studentsWithRecord} />
          <Stat label="Will be marked ABSENT" value={summary.automaticAbsent} />
          <Stat label="Present" value={summary.recordStatus.PRESENT} />
          <Stat label="Late" value={summary.recordStatus.LATE} />
          <Stat label="Absent (already)" value={summary.recordStatus.ABSENT} />
          <Stat label="Excused" value={summary.recordStatus.EXCUSED} />
          <Stat label="Manual review (unknown approval)" value={summary.manualReview} />
          <Stat label="Not eligible, no record" value={summary.notEligibleWithoutRecord} />
        </dl>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Evidence and reviews</h3>
        <dl className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Stat label="Online evidence not recorded" value={evidence.pendingOnlineEvidence} />
          <Stat label="Unknown approval at join" value={evidence.unknownApprovalEvidence} />
          <Stat label="Pending reviews" value={evidence.pendingReviews} />
        </dl>
      </div>
      <p className="text-[11px] text-slate-500">
        Preview reference: <span className="font-mono">{fingerprintReference(preview.fingerprint)}</span>
      </p>
    </div>
  );
}

function Blockers({ blockers }: { blockers: string[] }) {
  return (
    <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
      <p className="flex items-center gap-1.5 font-semibold">
        <OctagonX size={16} aria-hidden />
        Finalization is not available yet
      </p>
      <ul className="mt-1 list-disc pl-5 text-xs" aria-label="Blockers">
        {blockers.map((blocker) => (
          <li key={blocker} data-blocker={blocker}>
            {finalizationBlockerMessage(blocker)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle size={16} aria-hidden />
        Please note (not blocking)
      </p>
      <ul className="mt-1 list-disc pl-5 text-xs" aria-label="Warnings">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ErrorBox({ error, title }: { error: AttendanceApiError; title: string }) {
  return (
    <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
      <p className="flex items-center gap-1.5 font-semibold">
        <XCircle size={16} aria-hidden />
        {title}
      </p>
      <p className="mt-1 text-xs">{error.message}</p>
      {attendanceErrorAction(error.code) === "SIGN_IN" ? (
        <Link href="/login" className="mt-2 inline-flex rounded-lg bg-[#112D5C] px-3 py-1.5 text-xs font-semibold text-white">
          Sign in
        </Link>
      ) : null}
    </div>
  );
}

function ResultView({ result, refresh }: { result: FinalizeResponse; refresh: "pending" | "done" | "failed" }) {
  return (
    <div role="status" className="flex flex-col gap-3">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
        <p className="flex items-center gap-1.5 font-semibold">
          <CheckCircle2 size={16} aria-hidden />
          {result.alreadyFinalized ? "Attendance was already finalized" : "Attendance finalized"}
        </p>
        <p className="mt-1 text-xs">
          {result.alreadyFinalized
            ? `This register was finalized on ${when(result.finalizedAt)}. Nothing was changed now.`
            : `Finalized on ${when(result.finalizedAt)}. This cannot be undone.`}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Marked ABSENT" value={result.absentCreated} />
        <Stat label="Eligible at the start" value={result.eligibleStudents} />
        <Stat label="Unknown approval" value={result.unknownEligibilityStudents} />
        {result.details ? (
          <>
            <Stat label="On the roster" value={result.details.rosterSize} />
            <Stat label="Already recorded" value={result.details.studentsWithRecord} />
            <Stat label="Manual review" value={result.details.manualReview} />
            <Stat label="Pending reviews" value={result.details.pendingReviews} />
          </>
        ) : null}
      </dl>
      <p className="text-xs font-medium text-slate-700">
        {refresh === "pending" ? "Refreshing the register…" : refresh === "done" ? "The register below has been updated." : "The register could not be refreshed. Reload the page to see the latest data."}
      </p>
    </div>
  );
}

// ---- Dialog -----------------------------------------------------------------------------------------

export function FinalizationDialog({
  state,
  acknowledged,
  onAcknowledgedChange,
  onConfirm,
  onReloadPreview,
  onClose,
}: {
  state: FinalizationUiState;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  onConfirm: () => void;
  onReloadPreview: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** The backdrop / overlay root: everything outside it is made inert while the dialog is open. */
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const submitting = state.phase === "submitting";
  const open = state.phase !== "closed";
  // Read by the keyboard handler without re-running the open / close effect.
  const submittingRef = useRef(submitting);
  const onCloseRef = useRef(onClose);
  submittingRef.current = submitting;
  onCloseRef.current = onClose;
  const focusManager = useRef<DialogFocusManager | null>(null);

  // Keyboard (components/attendance/dialog-focus.ts): on open, focus moves inside (Cancel); Tab and
  // Shift+Tab cycle inside only; Escape closes, never while submitting; on close, focus returns to
  // the trigger, or to the finalization section when the trigger is gone (register now finalized).
  // Background (components/attendance/dialog-inert.ts): while open, everything outside the dialog
  // is `inert` (no clicks, focus or screen-reader access); restored on close and on unmount.
  // Order matters: the trigger is remembered and focus moved inside BEFORE the background becomes
  // inert (an inert trigger would lose focus), and the background is restored BEFORE focus returns.
  useEffect(() => {
    if (!open) return;
    const manager = createDialogFocusManager({
      container: () => focusContainerOf(dialogRef.current),
      activeElement: () => (document.activeElement as HTMLElement | null) ?? null,
      canClose: () => !submittingRef.current,
      onClose: () => onCloseRef.current(),
      fallback: () => document.getElementById(FINALIZE_SECTION_ID)?.focus({ preventScroll: true }),
    });
    focusManager.current = manager;
    manager.activate();
    const restoreBackground = overlayRef.current ? makeOutsideInert(overlayRef.current, document.body) : () => {};
    const onKey = (event: KeyboardEvent) => manager.handleKeyDown(event);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreBackground();
      manager.deactivate();
      focusManager.current = null;
    };
  }, [open]);

  // While submitting every control is disabled: keep focus on the dialog (a disabled control loses it).
  useEffect(() => {
    if (submitting) focusManager.current?.refocus();
  }, [submitting]);

  if (!open) return null;

  const preview = state.phase === "preview" || state.phase === "submitting" || state.phase === "needs-new-preview" ? state.preview : null;
  const confirmable = state.phase === "preview" && previewAllowsConfirmation(state.preview);
  const blockers = preview ? preview.readiness.blockers : [];

  return (
    <div ref={overlayRef} data-dialog-overlay className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="finalization-dialog-title"
        aria-describedby="finalization-dialog-description"
        aria-busy={submitting || state.phase === "loading-preview"}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 bg-[#112D5C] px-4 py-3 text-white">
          <div>
            <h2 id="finalization-dialog-title" className="text-base font-semibold">
              Finalize attendance
            </h2>
            <p id="finalization-dialog-description" className="text-xs text-white/80">
              Preview what finalization will do. Finalization cannot be undone.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="rounded-md p-1 text-white/90 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto p-4">
          {state.phase === "loading-preview" ? (
            <p role="status" className="flex items-center gap-2 text-sm text-slate-700">
              <Loader2 size={16} className="animate-spin text-[#112D5C]" aria-hidden />
              {state.stale ? "Loading a fresh preview…" : "Loading the finalization preview…"}
            </p>
          ) : null}

          {state.phase === "preview-error" ? <ErrorBox error={state.error} title="The preview could not be loaded" /> : null}

          {state.phase === "needs-new-preview" ? (
            <ErrorBox
              error={state.error}
              title={state.stale ? "Attendance changed since this preview" : "Finalization was refused"}
            />
          ) : null}
          {state.phase === "needs-new-preview" ? (
            <p className="text-xs text-slate-700">Load a fresh preview and review it before confirming again.</p>
          ) : null}

          {state.phase === "preview" && state.stale ? (
            <p className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">This is a fresh preview. Review it before confirming.</p>
          ) : null}
          {state.phase === "preview" && state.error ? <ErrorBox error={state.error} title="Finalization did not go through" /> : null}

          {state.phase === "finalized" ? <ResultView result={state.result} refresh={state.refresh} /> : null}

          {preview && state.phase !== "needs-new-preview" ? (
            <>
              {blockers.length > 0 ? <Blockers blockers={blockers} /> : null}
              <Warnings items={finalizationWarnings(preview)} />
              <PreviewDetails preview={preview} />
            </>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-200 p-4">
          {state.phase === "preview" || state.phase === "submitting" ? (
            <>
              {blockers.length === 0 ? (
                <p className="flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                  Finalization is permanent: the register is locked, its schedule is frozen and the students listed above are marked ABSENT. There is no undo.
                </p>
              ) : null}
              <label className={`flex items-start gap-2 text-sm ${confirmable ? "text-slate-800" : "text-slate-400"}`}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={!confirmable || submitting}
                  onChange={(event) => onAcknowledgedChange(event.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                I understand that finalizing attendance cannot be undone.
              </label>
            </>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {state.phase === "needs-new-preview" || state.phase === "preview-error" ? (
              <button
                type="button"
                onClick={onReloadPreview}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#112D5C] px-3 text-sm font-semibold text-white hover:opacity-90"
              >
                <RefreshCw size={14} aria-hidden />
                Load a fresh preview
              </button>
            ) : null}
            {state.phase === "preview" || state.phase === "submitting" ? (
              <button
                type="button"
                onClick={onConfirm}
                disabled={!confirmable || !acknowledged || submitting}
                aria-disabled={!confirmable || !acknowledged || submitting}
                aria-busy={submitting}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-rose-700 px-3 text-sm font-semibold text-white hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Lock size={14} aria-hidden />}
                {submitting ? "Finalizing…" : state.phase === "preview" && state.error ? "Try finalizing again" : "Finalize attendance"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              data-autofocus
              className="inline-flex h-9 items-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.phase === "finalized" ? "Done" : "Cancel"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
