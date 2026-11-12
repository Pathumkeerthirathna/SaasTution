/*
 * The register page's reconciliation run (Stage 5.5d-3), framework-free so
 * it can be tested without a DOM. It wraps the shared runReconciliation
 * (components/attendance/attendance-ui.ts: paging, fresh passes after busy
 * students, safety limits); nothing here pages or retries on its own.
 *
 *  - start(): ignored while a run is in progress (no duplicate submission);
 *  - progress is forwarded as it arrives; the outcome replaces it;
 *  - cancel(): aborts the run (the helper ends it as INCOMPLETE ABORTED);
 *  - dispose() (unmount): aborts and ignores every later callback;
 *  - after an outcome that changed data (COMPLETE, or any outcome with
 *    applied > 0), the register is refreshed through `refresh` (the panel's
 *    own loader, which already ignores stale responses).
 */

import type { ReconcileOptions, ReconcileOutcome, ReconcileProgress } from "@/components/attendance/attendance-ui";

export type ReconcileRefresh = "pending" | "done" | "failed" | "skipped";

export type ReconcileUiState =
  | { phase: "idle" }
  | { phase: "running"; progress: ReconcileProgress | null }
  | { phase: "done"; outcome: ReconcileOutcome; refresh: ReconcileRefresh };

/**
 * One register action at a time (Stage 5.5d-4): reconciliation and the
 * finalization dialog share a lock, so they can never run together.
 * "record-action" (Stage 5.6c): a teacher decision or review, when the page
 * chooses to share the lock with it (createRecordActionController).
 */
export type RegisterActionName = "reconcile" | "finalization" | "record-action";
export function createActionLock() {
  let holder: RegisterActionName | null = null;
  return {
    holder: () => holder,
    /** True when acquired (or already held by the same action). */
    tryAcquire(name: RegisterActionName): boolean {
      if (holder !== null && holder !== name) return false;
      holder = name;
      return true;
    },
    release(name: RegisterActionName) {
      if (holder === name) holder = null;
    },
  };
}
export type ActionLock = ReturnType<typeof createActionLock>;

export type ReconcileControllerDeps = {
  lectureId: string;
  /** Shared with the finalization dialog; without it reconciliation is never blocked by another action. */
  lock?: ActionLock;
  run: (lectureId: string, options: ReconcileOptions) => Promise<ReconcileOutcome>;
  /** Reloads the register; resolves true when the new data was applied. */
  refresh: () => Promise<boolean>;
  onChange: (state: ReconcileUiState) => void;
};

/** Whether the outcome changed attendance data (so the register should be reloaded). */
export function outcomeChangedData(outcome: ReconcileOutcome): boolean {
  return outcome.status === "COMPLETE" || outcome.totals.applied > 0;
}

export function createReconcileController(deps: ReconcileControllerDeps) {
  let state: ReconcileUiState = { phase: "idle" };
  let controller: AbortController | null = null;
  let runId = 0;
  let disposed = false;

  const set = (next: ReconcileUiState) => {
    if (disposed) return;
    state = next;
    deps.onChange(next);
  };

  const api = {
    getState: () => state,
    isRunning: () => state.phase === "running",

    /** Starts a run; false when one is already running (or after dispose). */
    async start(): Promise<boolean> {
      if (disposed || state.phase === "running") return false;
      if (deps.lock && !deps.lock.tryAcquire("reconcile")) return false;
      try {
        return await api.runOnce();
      } finally {
        deps.lock?.release("reconcile");
      }
    },

    /** @internal The run itself (start() holds the lock around it). */
    async runOnce(): Promise<boolean> {
      const id = ++runId;
      const abort = new AbortController();
      controller = abort;
      set({ phase: "running", progress: null });

      let outcome: ReconcileOutcome;
      try {
        outcome = await deps.run(deps.lectureId, {
          signal: abort.signal,
          onProgress: (progress) => {
            if (id === runId && !disposed) set({ phase: "running", progress });
          },
        });
      } catch {
        // runReconciliation never throws; a broken injected runner must not leave the button stuck.
        outcome = {
          status: "FAILED",
          error: { ok: false, status: 0, code: "INVALID_RESPONSE", message: "The server sent an unexpected response. Please try again." },
          passes: 0,
          pages: 0,
          totals: { processed: 0, applied: 0, duplicates: 0, ineligible: 0, unknown: 0, inactive: 0, finalizedWithoutRecord: 0, busy: 0, skipped: 0 },
        };
      }
      if (disposed || id !== runId) return true;
      controller = null;

      if (!outcomeChangedData(outcome)) {
        set({ phase: "done", outcome, refresh: "skipped" });
        return true;
      }
      set({ phase: "done", outcome, refresh: "pending" });
      let refreshed = false;
      try {
        refreshed = await deps.refresh();
      } catch {
        refreshed = false;
      }
      if (!disposed && id === runId) set({ phase: "done", outcome, refresh: refreshed ? "done" : "failed" });
      return true;
    },

    /** Stops the running reconciliation (pages already applied stay applied). */
    cancel() {
      controller?.abort();
    },

    /** Unmount: abort and ignore everything that arrives afterwards. */
    dispose() {
      disposed = true;
      controller?.abort();
      controller = null;
    },
  };
  return api;
}

export type ReconcileController = ReturnType<typeof createReconcileController>;

/**
 * "Latest request wins" for the register loads (initial load, manual retry,
 * refresh after reconciliation): a response may update the page only while
 * its request is still the newest one, so an older, slower response can
 * never overwrite newer data.
 */
export function createLatestRequestGate() {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (id: number) => id === latest,
    /** Unmount / lecture change: every request in flight becomes stale. */
    invalidate: () => {
      latest += 1;
    },
  };
}
