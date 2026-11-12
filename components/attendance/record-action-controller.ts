/*
 * One student's teacher decision or evidence review on the register page
 * (Stage 5.6c), framework-free so it can be tested without a DOM. The server
 * decides everything; this only sequences the API calls of
 * components/attendance/attendance-ui.ts (submitAttendanceDecision,
 * submitAttendanceReview) and the register refresh.
 *
 *  - one action at a time: a second submit while one is in flight (or while
 *    the register is being refreshed after it) is refused, never queued;
 *  - expectedVersion is the version of the record in the LOADED register
 *    (null: no record) — never invented, never bumped locally;
 *  - the reason is checked first with the shared UX rule
 *    (decisionReasonRequirement / reviewReasonRequirement /
 *    checkAttendanceReason): an invalid reason sends nothing;
 *  - success: the register is refreshed from the server (no optimistic
 *    change to the loaded data);
 *  - any 409: reported, and the register is refreshed so the teacher sees
 *    the current record; nothing is retried, with any version;
 *  - cancel(): aborts the request; the outcome on the server is unknown, so
 *    the register is refreshed;
 *  - the optional shared ActionLock ("record-action") is held from submit
 *    until the refresh has finished, and released on every path;
 *  - dispose() (unmount): aborts, releases the lock, ignores everything
 *    afterwards.
 */

import {
  checkAttendanceReason,
  decisionReasonRequirement,
  reviewReasonRequirement,
  submitAttendanceDecision,
  submitAttendanceReview,
  type AttendanceApiError,
  type AttendanceApiResult,
  type DecisionRequest,
  type DecisionResponse,
  type ReasonProblem,
  type ReviewAction,
  type ReviewRequest,
  type ReviewResponse,
  type TeacherAttendanceStatus,
} from "@/components/attendance/attendance-ui";
import type { ActionLock } from "@/components/attendance/reconciliation-controller";

export type RecordActionKind = "decision" | "review";
export type RecordActionRefresh = "pending" | "done" | "failed";

/** The register student the action is for, as loaded (only what the action needs). */
export type RecordActionTarget = {
  studentId: string;
  /** The loaded record (null: none); its version is the expectedVersion. */
  record: { version: number } | null;
};

export type RecordActionUiState =
  | { phase: "idle" }
  /** The reason check failed: nothing was sent. */
  | { phase: "invalid"; kind: RecordActionKind; studentId: string; problem: ReasonProblem }
  | { phase: "submitting"; kind: RecordActionKind; studentId: string }
  | { phase: "succeeded"; kind: "decision"; studentId: string; result: DecisionResponse; refresh: RecordActionRefresh }
  | { phase: "succeeded"; kind: "review"; studentId: string; result: ReviewResponse; refresh: RecordActionRefresh }
  /**
   * `stale`: the record (or its review) changed on the server since the
   * register was loaded. `refresh`: whether the register is being / was
   * reloaded (every 409 and every cancellation); "skipped" otherwise.
   */
  | {
      phase: "failed";
      kind: RecordActionKind;
      studentId: string;
      error: AttendanceApiError;
      stale: boolean;
      cancelled: boolean;
      refresh: RecordActionRefresh | "skipped";
    };

export type RecordActionControllerDeps = {
  lectureId: string;
  /** Optional: shared with the register's other actions when the page wants them exclusive. */
  lock?: ActionLock;
  /** Reloads the register; resolves true when the new data was applied. */
  refresh: () => Promise<boolean>;
  onChange: (state: RecordActionUiState) => void;
  /** Tests inject the API calls; the defaults are the shared typed helpers. */
  decide?: (lectureId: string, studentId: string, request: DecisionRequest, options: { signal: AbortSignal }) => Promise<AttendanceApiResult<DecisionResponse>>;
  review?: (lectureId: string, studentId: string, request: ReviewRequest, options: { signal: AbortSignal }) => Promise<AttendanceApiResult<ReviewResponse>>;
};

/** Errors meaning the loaded record is out of date (refresh, then decide again). */
export function isStaleRecordError(error: AttendanceApiError): boolean {
  return error.code === "ATTENDANCE_RECORD_CHANGED" || error.code === "ATTENDANCE_NO_PENDING_REVIEW";
}

const LOCK_NAME = "record-action";

export function createRecordActionController(deps: RecordActionControllerDeps) {
  const decide = deps.decide ?? ((lectureId, studentId, request, options) => submitAttendanceDecision(lectureId, studentId, request, options));
  const review = deps.review ?? ((lectureId, studentId, request, options) => submitAttendanceReview(lectureId, studentId, request, options));

  let state: RecordActionUiState = { phase: "idle" };
  /** True from submit until the refresh after it has finished (one action at a time). */
  let busy = false;
  let actionId = 0;
  let inFlight: AbortController | null = null;
  let cancelled = false;
  let disposed = false;

  const set = (next: RecordActionUiState) => {
    if (disposed) return;
    state = next;
    deps.onChange(next);
  };
  const current = (id: number) => !disposed && id === actionId;

  async function refreshRegister(): Promise<boolean> {
    try {
      return await deps.refresh();
    } catch {
      return false;
    }
  }

  /**
   * The shared run: acquire, send, then refresh when the server state may
   * have changed or is unknown. Returns true when a request was sent.
   */
  async function run<T extends DecisionResponse | ReviewResponse>(
    kind: RecordActionKind,
    studentId: string,
    send: (signal: AbortSignal) => Promise<AttendanceApiResult<T>>,
    succeeded: (result: T, refresh: RecordActionRefresh) => RecordActionUiState
  ): Promise<boolean> {
    if (deps.lock && !deps.lock.tryAcquire(LOCK_NAME)) return false;
    busy = true;
    const id = ++actionId;
    const abort = new AbortController();
    inFlight = abort;
    cancelled = false;
    try {
      set({ phase: "submitting", kind, studentId });
      let result: AttendanceApiResult<T>;
      try {
        result = await send(abort.signal);
      } catch {
        // The shared helper never throws; a broken injected one must not leave the action stuck.
        result = { ok: false, status: 0, code: "INVALID_RESPONSE", message: "The server sent an unexpected response. Please try again." };
      }
      if (!current(id)) return true;
      inFlight = null;
      const wasCancelled = cancelled;

      if (result.ok) {
        set(succeeded(result.data, "pending"));
        const refreshed = await refreshRegister();
        if (current(id)) set(succeeded(result.data, refreshed ? "done" : "failed"));
        return true;
      }

      const error = result;
      const stale = isStaleRecordError(error);
      // Every 409 (and a cancellation, whose outcome is unknown) reloads the register; nothing is retried.
      const needsRefresh = error.status === 409 || wasCancelled;
      const failed = (refresh: RecordActionRefresh | "skipped"): RecordActionUiState => ({
        phase: "failed",
        kind,
        studentId,
        error,
        stale,
        cancelled: wasCancelled,
        refresh,
      });
      if (!needsRefresh) {
        set(failed("skipped"));
        return true;
      }
      set(failed("pending"));
      const refreshed = await refreshRegister();
      if (current(id)) set(failed(refreshed ? "done" : "failed"));
      return true;
    } finally {
      if (id === actionId) {
        busy = false;
        inFlight = null;
      }
      deps.lock?.release(LOCK_NAME);
    }
  }

  const api = {
    getState: () => state,
    /** True while an action is being sent or the register refreshed after it. */
    isBusy: () => busy,

    /**
     * Sets the student's status. Refused (false, nothing sent) after dispose,
     * while another action is busy, when the lock is held by another action,
     * or when the reason check fails (state "invalid").
     */
    async submitDecision(input: { target: RecordActionTarget; status: TeacherAttendanceStatus; reason?: string | null; finalized: boolean }): Promise<boolean> {
      if (disposed || busy) return false;
      const { target } = input;
      const check = checkAttendanceReason(input.reason, decisionReasonRequirement({ hasRecord: target.record !== null, finalized: input.finalized }));
      if (!check.ok) {
        set({ phase: "invalid", kind: "decision", studentId: target.studentId, problem: check.problem });
        return false;
      }
      const request: DecisionRequest = { status: input.status, expectedVersion: target.record ? target.record.version : null, reason: check.reason };
      return run<DecisionResponse>(
        "decision",
        target.studentId,
        (signal) => decide(deps.lectureId, target.studentId, request, { signal }),
        (result, refresh) => ({ phase: "succeeded", kind: "decision", studentId: target.studentId, result, refresh })
      );
    },

    /**
     * Accepts or dismisses the student's pending evidence review. Refused
     * (false, nothing sent) as submitDecision, and when the loaded register
     * shows no record (there can be no review to answer).
     */
    async submitReview(input: { target: RecordActionTarget; action: ReviewAction; reason?: string | null }): Promise<boolean> {
      if (disposed || busy) return false;
      const { target } = input;
      if (target.record === null) return false;
      const check = checkAttendanceReason(input.reason, reviewReasonRequirement(input.action));
      if (!check.ok) {
        set({ phase: "invalid", kind: "review", studentId: target.studentId, problem: check.problem });
        return false;
      }
      const request: ReviewRequest = { action: input.action, expectedVersion: target.record.version, reason: check.reason };
      return run<ReviewResponse>(
        "review",
        target.studentId,
        (signal) => review(deps.lectureId, target.studentId, request, { signal }),
        (result, refresh) => ({ phase: "succeeded", kind: "review", studentId: target.studentId, result, refresh })
      );
    },

    /** Aborts the request in flight (the register is then refreshed: the server may have applied it). */
    cancel(): boolean {
      if (!inFlight) return false;
      cancelled = true;
      inFlight.abort();
      return true;
    },

    /** Back to idle (e.g. the dialog closed); refused while busy. */
    reset(): boolean {
      if (disposed || busy) return false;
      set({ phase: "idle" });
      return true;
    },

    /** Unmount: abort, release the lock, ignore everything afterwards. */
    dispose() {
      disposed = true;
      inFlight?.abort();
      inFlight = null;
      busy = false;
      deps.lock?.release(LOCK_NAME);
    },
  };
  return api;
}

export type RecordActionController = ReturnType<typeof createRecordActionController>;
