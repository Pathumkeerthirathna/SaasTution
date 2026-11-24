"use client";

/*
 * Attendance history on the register page (Stage 5.6f), read only:
 *
 *  - the student history dialog: one student's record audit history
 *    (GET .../students/[studentId]/history through createStudentHistoryLoader);
 *  - the register history section: the register's own audit history and the
 *    QR closure (GET .../attendance/history through
 *    createRegisterHistoryLoader). There is no lecture-wide feed of student
 *    record changes (the API has none).
 *
 * Everything shown comes from the API as it is (no recalculation, no ids);
 * times are Sri Lankan (formatColomboDateTime). Pages follow the server's
 * cursor (history-controller.ts): "Load more" asks for the next page, an
 * error keeps what is shown, and "Try again" repeats exactly the request that
 * failed (the same cursor). No decision or review action here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { History, Loader2, RefreshCw, X, XCircle } from "lucide-react";

import {
  attendanceStatusLabel,
  formatColomboDateTime,
  statusSourceLabel,
  type AttendanceApiError,
  type AttendanceRegisterResponse,
  type HistoryActor,
  type RegisterHistoryEntry,
  type RegisterHistoryResponse,
  type StudentHistoryEntry,
  type StudentHistoryResponse,
} from "@/components/attendance/attendance-ui";
import { REGISTER_STUDENTS_ID } from "@/components/attendance/decision-dialog";
import {
  createRegisterHistoryLoader,
  createStudentHistoryLoader,
  type HistoryState,
} from "@/components/attendance/history-controller";
import { useModalDialog } from "@/components/attendance/use-modal-dialog";

type RegisterStudent = AttendanceRegisterResponse["students"][number];
export type StudentHistoryState = HistoryState<StudentHistoryResponse, StudentHistoryEntry>;
export type RegisterHistoryState = HistoryState<RegisterHistoryResponse, RegisterHistoryEntry>;

// =========================================================================================
// Pure helpers (exported for tests)
// =========================================================================================

const STUDENT_ACTIONS: Record<StudentHistoryEntry["action"], string> = {
  CREATED_AUTO: "Recorded automatically",
  AUTO_UPDATED: "Updated automatically",
  AUTO_RECALCULATED: "Recalculated after a schedule or grace change",
  EVIDENCE_RECORDED: "Evidence recorded",
  TEACHER_SET: "Teacher decision",
  EVIDENCE_ACCEPTED: "Evidence accepted",
  EVIDENCE_DISMISSED: "Evidence dismissed",
  FINALIZE_ABSENT: "Marked absent at finalization",
  BACKFILL: "Backfilled (historical attendance)",
};

const REGISTER_ACTIONS: Record<RegisterHistoryEntry["action"], string> = {
  CREATED: "Register created",
  GRACE_CHANGED: "Grace period changed",
  SCHEDULE_SYNCED: "Schedule synchronized",
  FINALIZED: "Register finalized",
};

const CAUSES: Record<NonNullable<StudentHistoryEntry["cause"]>, string> = {
  QR_SCAN: "QR scan",
  ONLINE_VISIT: "Online join",
  REGISTER_CHANGE: "Register change (schedule or grace)",
};

export function studentHistoryActionLabel(action: string): string {
  return (STUDENT_ACTIONS as Record<string, string>)[action] ?? "Attendance change";
}

export function registerHistoryActionLabel(action: string): string {
  return (REGISTER_ACTIONS as Record<string, string>)[action] ?? "Register change";
}

/** "You" for the signed-in teacher, "Teacher" for another teacher, "System" otherwise (no ids). */
export function historyActorLabel(actor: HistoryActor): string {
  if (actor.role === "TEACHER") return actor.isCurrentTeacher ? "You" : "Teacher";
  return "System";
}

export function historyCauseLabel(cause: StudentHistoryEntry["cause"]): string | null {
  return cause ? CAUSES[cause] ?? null : null;
}

const statusText = (status: string | null) => (status === null ? "none" : attendanceStatusLabel(status).label);

/** "A → B" for a change, "B" for a creation (from null); null when nothing was supplied. */
export function changeText(change: { from: string | null; to: string | null }, format: (value: string | null) => string = statusText): string | null {
  if (change.from === null && change.to === null) return null;
  if (change.from === null) return format(change.to);
  return `${format(change.from)} → ${format(change.to)}`;
}

const minutes = (value: string | null) => (value === null ? "none" : `${value} minutes`);
const time = (value: string | null) => (value === null ? "none" : formatColomboDateTime(value));

export type HistoryOp = "first" | "more";

/** "Try again" repeats exactly the failed request: the first page, or the next page with the SAME cursor. */
export function retryHistory(loader: { load: () => Promise<boolean>; loadMore: () => Promise<boolean> }, lastOp: HistoryOp): Promise<boolean> {
  return lastOp === "more" ? loader.loadMore() : loader.load();
}

/** Whether the history action is offered: the teacher's own students only (another teacher's student is a 404). */
export function historyAvailable(student: RegisterStudent): boolean {
  return student.name !== null;
}

// =========================================================================================
// Shared pieces
// =========================================================================================

function Pager({
  state,
  label,
  onLoadMore,
  onRetry,
  onReload,
}: {
  state: { entries: unknown[]; latest: unknown; nextCursor: string | null; complete: boolean; loading: "first" | "more" | null; error: AttendanceApiError | null };
  label: string;
  onLoadMore: () => void;
  onRetry: () => void;
  onReload: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {state.error ? (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          <p className="flex items-center gap-1.5 font-semibold">
            <XCircle size={16} aria-hidden />
            The history could not be loaded
          </p>
          <p className="mt-1 text-xs">{state.error.message}</p>
          {state.entries.length > 0 ? <p className="mt-1 text-xs">The entries already shown are kept.</p> : null}
          <button type="button" onClick={onRetry} className="mt-2 inline-flex h-8 items-center gap-1 rounded-lg bg-[#112D5C] px-3 text-xs font-semibold text-white hover:opacity-90">
            <RefreshCw size={13} aria-hidden />
            Try again
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {state.latest !== null && !state.complete && state.nextCursor !== null ? (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={state.loading !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#112D5C] px-3 text-xs font-semibold text-[#112D5C] hover:bg-[#112D5C] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.loading === "more" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
            {state.loading === "more" ? "Loading…" : `Load more ${label}`}
          </button>
        ) : null}
        {state.latest !== null && state.complete && state.entries.length > 0 ? <p className="text-xs text-slate-500">All {label} shown.</p> : null}
        {state.latest !== null ? (
          <button
            type="button"
            onClick={onReload}
            disabled={state.loading !== null}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={13} aria-hidden />
            Reload
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-slate-600">
      <Loader2 size={15} className="animate-spin text-[#112D5C]" aria-hidden />
      {text}
    </p>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="break-words text-xs text-slate-800">{value}</dd>
    </div>
  );
}

function EntryHeader({ action, at, actor }: { action: string; at: string; actor: HistoryActor }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="text-sm font-semibold text-slate-900">{action}</p>
      <p className="text-xs text-slate-600">
        <time dateTime={at}>{formatColomboDateTime(at)}</time> · By: <span className="font-semibold">{historyActorLabel(actor)}</span>
      </p>
    </div>
  );
}

// =========================================================================================
// Student history (view + dialog)
// =========================================================================================

export function StudentHistoryEntries({ entries }: { entries: readonly StudentHistoryEntry[] }) {
  return (
    <ol className="flex flex-col gap-2" aria-label="History entries, oldest first">
      {entries.map((entry) => {
        const teacher = changeText(entry.teacherStatus);
        const auto = changeText(entry.autoStatus);
        const cause = historyCauseLabel(entry.cause);
        return (
          <li key={entry.version} className="rounded-lg border border-slate-200 bg-white p-3" data-history-entry>
            <EntryHeader action={studentHistoryActionLabel(entry.action)} at={entry.at} actor={entry.actor} />
            <dl className="mt-2 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
              <Field label="Status" value={changeText(entry.status)} />
              {teacher ? <Field label="Teacher status" value={teacher} /> : null}
              {auto ? <Field label="Automatic status" value={auto} /> : null}
              {cause ? <Field label="Caused by" value={cause} /> : null}
              {entry.afterFinalization ? <Field label="Timing" value="After finalization" /> : null}
              {entry.reason ? <Field label="Reason" value={entry.reason} /> : null}
            </dl>
          </li>
        );
      })}
    </ol>
  );
}

export type StudentHistoryTarget = { studentId: string; name: string; registrationNumber: string | null };

export function StudentHistoryBody({
  state,
  onLoadMore,
  onRetry,
  onReload,
}: {
  state: StudentHistoryState;
  onLoadMore: () => void;
  onRetry: () => void;
  onReload: () => void;
}) {
  const latest = state.latest;
  return (
    <div className="flex flex-col gap-3">
      {state.loading === "first" && latest === null ? <Loading text="Loading the attendance history…" /> : null}
      {state.loading === "first" && latest !== null ? <Loading text="Reloading…" /> : null}
      {latest?.record ? (
        <dl className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 min-[420px]:grid-cols-3" data-current-record>
          <Field label="Current status" value={attendanceStatusLabel(latest.record.status).label} />
          <Field label="Source" value={statusSourceLabel(latest.record.statusSource)} />
          <Field label="Review" value={latest.record.pendingReview ? "Pending review" : "No pending review"} />
        </dl>
      ) : null}
      {latest !== null && !latest.recordExists ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-600">
          This student has no attendance record for this lecture, so there is no history yet.
        </p>
      ) : null}
      {latest !== null && latest.recordExists && state.entries.length === 0 && state.loading === null && !state.error ? (
        <p className="text-sm text-slate-600">No history entries.</p>
      ) : null}
      {state.entries.length > 0 ? <StudentHistoryEntries entries={state.entries} /> : null}
      <Pager state={state} label="entries" onLoadMore={onLoadMore} onRetry={onRetry} onReload={onReload} />
    </div>
  );
}

export function StudentHistoryDialogView({
  target,
  state,
  onLoadMore,
  onRetry,
  onReload,
  onClose,
}: {
  target: StudentHistoryTarget | null;
  state: StudentHistoryState;
  onLoadMore: () => void;
  onRetry: () => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const open = target !== null;
  // Read only: closing is always allowed (it aborts any page request).
  useModalDialog({ open, dialogRef, overlayRef, canClose: () => true, onClose, fallbackId: REGISTER_STUDENTS_ID });
  if (!target) return null;

  return (
    <div ref={overlayRef} data-dialog-overlay className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="student-history-title"
        aria-describedby="student-history-description"
        aria-busy={state.loading !== null}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 bg-[#112D5C] px-4 py-3 text-white">
          <div className="min-w-0">
            <h2 id="student-history-title" className="break-words text-base font-semibold">
              Attendance history: {target.name}
            </h2>
            <p id="student-history-description" className="text-xs text-white/80">
              {target.registrationNumber ? `${target.registrationNumber} · ` : ""}Oldest first. Times are Sri Lankan time.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" data-autofocus className="rounded-md p-1 text-white/90 hover:bg-white/10">
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          <StudentHistoryBody state={state} onLoadMore={onLoadMore} onRetry={onRetry} onReload={onReload} />
        </div>
      </div>
    </div>
  );
}

const EMPTY_STATE = { entries: [], latest: null, nextCursor: null, complete: false, loading: null, error: null };

/** The dialog with its loader: created when it opens (first page loaded), disposed when it closes or unmounts. */
export function StudentHistoryDialog({ lectureId, target, onClose }: { lectureId: string; target: StudentHistoryTarget | null; onClose: () => void }) {
  const [state, setState] = useState<StudentHistoryState>(EMPTY_STATE);
  const loaderRef = useRef<ReturnType<typeof createStudentHistoryLoader> | null>(null);
  const lastOp = useRef<HistoryOp>("first");
  const studentId = target?.studentId ?? null;

  useEffect(() => {
    if (studentId === null) return;
    const loader = createStudentHistoryLoader({ lectureId, studentId, onChange: setState });
    loaderRef.current = loader;
    setState(EMPTY_STATE);
    lastOp.current = "first";
    void loader.load();
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, [lectureId, studentId]);

  const loadMore = useCallback(() => {
    lastOp.current = "more";
    void loaderRef.current?.loadMore();
  }, []);
  const reload = useCallback(() => {
    lastOp.current = "first";
    void loaderRef.current?.load();
  }, []);
  const retry = useCallback(() => {
    if (loaderRef.current) void retryHistory(loaderRef.current, lastOp.current);
  }, []);

  return <StudentHistoryDialogView target={target} state={state} onLoadMore={loadMore} onRetry={retry} onReload={reload} onClose={onClose} />;
}

/** The row action (both layouts). */
/** The compact action's accessible name and tooltip. */
export const VIEW_HISTORY_LABEL = "View attendance history";

export function HistoryAction({
  student,
  onOpen,
  compact = false,
}: {
  student: RegisterStudent;
  onOpen: (student: RegisterStudent) => void;
  /** An icon button (the Attendance page's register): a tooltip and an accessible name instead of the text. */
  compact?: boolean;
}) {
  if (!historyAvailable(student)) return null;
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => onOpen(student)}
        data-history-action={student.studentId}
        title={VIEW_HISTORY_LABEL}
        aria-label={`${VIEW_HISTORY_LABEL}: ${student.name ?? "Unknown student"}`}
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border md:h-9 md:w-9 border-slate-300 text-slate-700 hover:bg-slate-100"
      >
        <History size={16} aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(student)}
      data-history-action={student.studentId}
      className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-slate-300 px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
    >
      <History size={13} aria-hidden />
      View history
      <span className="sr-only">: {student.name ?? "Unknown student"}</span>
    </button>
  );
}

// =========================================================================================
// Register history (view + section)
// =========================================================================================

export function RegisterHistoryEntries({ entries }: { entries: readonly RegisterHistoryEntry[] }) {
  return (
    <ol className="flex flex-col gap-2" aria-label="Register history entries, oldest first">
      {entries.map((entry) => {
        const grace = entry.graceMinutes ? changeText({ from: entry.graceMinutes.from === null ? null : String(entry.graceMinutes.from), to: entry.graceMinutes.to === null ? null : String(entry.graceMinutes.to) }, minutes) : null;
        const start = entry.scheduledStartAt ? changeText(entry.scheduledStartAt, time) : null;
        const end = entry.scheduledEndAt ? changeText(entry.scheduledEndAt, time) : null;
        return (
          <li key={entry.version} className="rounded-lg border border-slate-200 bg-white p-3" data-history-entry>
            <EntryHeader action={registerHistoryActionLabel(entry.action)} at={entry.at} actor={entry.actor} />
            <dl className="mt-2 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-3">
              {grace ? <Field label="Grace period" value={grace} /> : null}
              {start ? <Field label="Scheduled start" value={start} /> : null}
              {end ? <Field label="Scheduled end" value={end} /> : null}
              {entry.recalculatedCount !== null ? <Field label="Records recalculated" value={entry.recalculatedCount} /> : null}
              {entry.finalization ? (
                <>
                  <Field label="Finalized at" value={formatColomboDateTime(entry.finalization.finalizedAt)} />
                  {entry.finalization.eligibleCount !== null ? <Field label="Eligible students" value={entry.finalization.eligibleCount} /> : null}
                  {entry.finalization.unknownEligibilityCount !== null ? <Field label="Unknown eligibility" value={entry.finalization.unknownEligibilityCount} /> : null}
                  {entry.finalization.absentCreatedCount !== null ? <Field label="Marked absent" value={entry.finalization.absentCreatedCount} /> : null}
                </>
              ) : null}
              {entry.reason ? <Field label="Reason" value={entry.reason} /> : null}
            </dl>
          </li>
        );
      })}
    </ol>
  );
}

export const REGISTER_HISTORY_ID = "attendance-register-history";

export function RegisterHistoryView({
  expanded,
  state,
  onToggle,
  onLoadMore,
  onRetry,
  onReload,
}: {
  expanded: boolean;
  state: RegisterHistoryState;
  onToggle: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onReload: () => void;
}) {
  const latest = state.latest;
  return (
    <section aria-labelledby="register-history-heading" className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4" data-register-history>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="register-history-heading" className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <History size={15} aria-hidden />
            Register history
          </h2>
          <p className="text-xs text-slate-500">
            {"Changes to the register itself (creation, grace period, schedule, finalization) and the QR closure. Individual students' changes are in each student's own history."}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={REGISTER_HISTORY_ID}
          className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          {expanded ? "Hide register history" : "Show register history"}
        </button>
      </div>
      {expanded ? (
        <div id={REGISTER_HISTORY_ID} className="mt-3 flex flex-col gap-3">
          {state.loading === "first" && latest === null ? <Loading text="Loading the register history…" /> : null}
          {state.loading === "first" && latest !== null ? <Loading text="Reloading…" /> : null}
          {latest?.qrClosure ? (
            <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800" data-qr-closure>
              <span className="font-semibold">QR attendance closed</span> on <time dateTime={latest.qrClosure.closedAt}>{formatColomboDateTime(latest.qrClosure.closedAt)}</time> · By:{" "}
              <span className="font-semibold">{historyActorLabel(latest.qrClosure.actor)}</span>
            </p>
          ) : null}
          {latest !== null && !latest.registerExists ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-600">No attendance has been recorded for this lecture yet, so the register has no history.</p>
          ) : null}
          {latest !== null && latest.registerExists && state.entries.length === 0 && state.loading === null && !state.error ? (
            <p className="text-sm text-slate-600">No register history entries.</p>
          ) : null}
          {state.entries.length > 0 ? <RegisterHistoryEntries entries={state.entries} /> : null}
          <Pager state={state} label="register history" onLoadMore={onLoadMore} onRetry={onRetry} onReload={onReload} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The section with its loader: the first page loads when it is first shown;
 * a new register version (e.g. after finalization) reloads it while shown;
 * disposed on unmount.
 */
export function RegisterHistorySection({ lectureId, registerVersion }: { lectureId: string; registerVersion: number }) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<RegisterHistoryState>(EMPTY_STATE);
  const loaderRef = useRef<ReturnType<typeof createRegisterHistoryLoader> | null>(null);
  const lastOp = useRef<HistoryOp>("first");

  useEffect(() => {
    const loader = createRegisterHistoryLoader({ lectureId, onChange: setState });
    loaderRef.current = loader;
    setState(EMPTY_STATE);
    setExpanded(false);
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, [lectureId]);

  // Shown: (re)load the first page, also when the register's version changes.
  useEffect(() => {
    if (!expanded) return;
    lastOp.current = "first";
    void loaderRef.current?.load();
  }, [expanded, registerVersion]);

  const loadMore = useCallback(() => {
    lastOp.current = "more";
    void loaderRef.current?.loadMore();
  }, []);
  const reload = useCallback(() => {
    lastOp.current = "first";
    void loaderRef.current?.load();
  }, []);
  const retry = useCallback(() => {
    if (loaderRef.current) void retryHistory(loaderRef.current, lastOp.current);
  }, []);

  return <RegisterHistoryView expanded={expanded} state={state} onToggle={() => setExpanded((value) => !value)} onLoadMore={loadMore} onRetry={retry} onReload={reload} />;
}
