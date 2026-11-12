/*
 * The register page's finalization workflow (Stage 5.5d-4), framework-free
 * so it can be tested without a DOM. The server decides everything: this
 * only sequences the two API calls of components/attendance/attendance-ui.ts
 * (fetchFinalizationPreview, finalizeAttendance).
 *
 *  - open(): takes the shared register-action lock (no reconciliation while
 *    the dialog is open) and loads a FRESH preview (never a cached one);
 *  - confirm(acknowledged): only for the latest preview, only when the
 *    server reported it ready (no blockers), only after the explicit
 *    acknowledgement, only once at a time; it sends exactly that preview's
 *    fingerprint (never built in the browser);
 *  - stale (FINALIZATION_PREVIEW_STALE / _CANDIDATES_CHANGED): confirmation
 *    is locked until the teacher loads a fresh preview (no automatic retry);
 *  - retryable failures (ATTENDANCE_BUSY, network, server): the same preview
 *    may be confirmed again (finalization is idempotent: a repeat that the
 *    server already applied returns alreadyFinalized);
 *  - any other refusal: confirmation is locked until a fresh preview;
 *  - success (new or alreadyFinalized): the result is shown and the
 *    register is refreshed in place;
 *  - close(): releases the lock (not while a submission is in flight);
 *    dispose() (unmount): aborts and ignores everything afterwards.
 */

import {
  attendanceErrorAction,
  fetchFinalizationPreview,
  finalizeAttendance,
  type AttendanceApiError,
  type AttendanceApiResult,
  type FinalizationPreviewResponse,
  type FinalizeResponse,
} from "@/components/attendance/attendance-ui";
import type { ActionLock } from "@/components/attendance/reconciliation-controller";

export type FinalizationRefresh = "pending" | "done" | "failed";

export type FinalizationUiState =
  | { phase: "closed" }
  | { phase: "loading-preview"; stale: boolean }
  | { phase: "preview-error"; error: AttendanceApiError }
  /** `error`: the last confirmation failure that allows confirming this preview again (busy, network, server). */
  | { phase: "preview"; preview: FinalizationPreviewResponse; stale: boolean; error: AttendanceApiError | null }
  | { phase: "submitting"; preview: FinalizationPreviewResponse }
  /** The preview is no longer usable: a fresh preview is required before confirming. */
  | { phase: "needs-new-preview"; preview: FinalizationPreviewResponse; error: AttendanceApiError; stale: boolean }
  | { phase: "finalized"; result: FinalizeResponse; refresh: FinalizationRefresh };

export type FinalizationControllerDeps = {
  lectureId: string;
  lock: ActionLock;
  /** Reloads the register; resolves true when the new data was applied. */
  refresh: () => Promise<boolean>;
  onChange: (state: FinalizationUiState) => void;
  /** Tests inject the API calls; the defaults are the shared typed helpers. */
  preview?: (lectureId: string, options: { signal: AbortSignal }) => Promise<AttendanceApiResult<FinalizationPreviewResponse>>;
  finalize?: (lectureId: string, fingerprint: string, options: { signal: AbortSignal }) => Promise<AttendanceApiResult<FinalizeResponse>>;
};

/** Whether the preview may be confirmed: the server's own verdict (ready and no blockers). */
export function previewAllowsConfirmation(preview: FinalizationPreviewResponse): boolean {
  return preview.readiness.ready && preview.readiness.blockers.length === 0 && !preview.register.finalized;
}

export function createFinalizationController(deps: FinalizationControllerDeps) {
  const loadPreview = deps.preview ?? ((lectureId, options) => fetchFinalizationPreview(lectureId, options));
  const submit = deps.finalize ?? ((lectureId, fingerprint, options) => finalizeAttendance(lectureId, fingerprint, options));

  let state: FinalizationUiState = { phase: "closed" };
  let requestId = 0;
  let inFlight: AbortController | null = null;
  let disposed = false;

  const set = (next: FinalizationUiState) => {
    if (disposed) return;
    state = next;
    deps.onChange(next);
  };
  /** A new request: the previous one is aborted and its answer will be ignored. */
  const begin = () => {
    inFlight?.abort();
    inFlight = new AbortController();
    return { id: ++requestId, signal: inFlight.signal };
  };
  const current = (id: number) => !disposed && id === requestId;

  async function fetchPreview(stale: boolean): Promise<void> {
    const { id, signal } = begin();
    set({ phase: "loading-preview", stale });
    const result = await loadPreview(deps.lectureId, { signal });
    if (!current(id)) return;
    inFlight = null;
    set(result.ok ? { phase: "preview", preview: result.data, stale, error: null } : { phase: "preview-error", error: result });
  }

  const api = {
    getState: () => state,

    /** Opens the dialog with a fresh preview; false when another register action holds the lock. */
    async open(): Promise<boolean> {
      if (disposed || state.phase !== "closed") return false;
      if (!deps.lock.tryAcquire("finalization")) return false;
      await fetchPreview(false);
      return true;
    },

    /** Loads a fresh preview (after a stale answer, a refusal or an error). Not while submitting. */
    async reloadPreview(): Promise<boolean> {
      if (disposed || state.phase === "closed" || state.phase === "submitting" || state.phase === "finalized") return false;
      const stale = state.phase === "needs-new-preview" && state.stale;
      await fetchPreview(stale);
      return true;
    },

    /**
     * Confirms the CURRENT preview with its own fingerprint. Refused (false)
     * without the acknowledgement, without a confirmable preview, or while
     * another submission is in flight.
     */
    async confirm(acknowledged: boolean): Promise<boolean> {
      if (disposed || !acknowledged || state.phase !== "preview") return false;
      const preview = state.preview;
      if (!previewAllowsConfirmation(preview)) return false;
      const { id, signal } = begin();
      set({ phase: "submitting", preview });

      const result = await submit(deps.lectureId, preview.fingerprint, { signal });
      if (!current(id)) return true;
      inFlight = null;

      if (!result.ok) {
        const action = attendanceErrorAction(result.code);
        if (action === "RELOAD_PREVIEW") set({ phase: "needs-new-preview", preview, error: result, stale: true });
        else if (action === "RETRY") set({ phase: "preview", preview, stale: false, error: result });
        else set({ phase: "needs-new-preview", preview, error: result, stale: false });
        return true;
      }

      set({ phase: "finalized", result: result.data, refresh: "pending" });
      let refreshed = false;
      try {
        refreshed = await deps.refresh();
      } catch {
        refreshed = false;
      }
      if (current(id)) set({ phase: "finalized", result: result.data, refresh: refreshed ? "done" : "failed" });
      return true;
    },

    /** Closes the dialog and releases the lock; refused while a submission is in flight. */
    close(): boolean {
      if (state.phase === "submitting") return false;
      inFlight?.abort();
      inFlight = null;
      requestId += 1;
      deps.lock.release("finalization");
      set({ phase: "closed" });
      return true;
    },

    /** Unmount: abort, release the lock, ignore everything afterwards. */
    dispose() {
      disposed = true;
      inFlight?.abort();
      inFlight = null;
      deps.lock.release("finalization");
    },
  };
  return api;
}

export type FinalizationController = ReturnType<typeof createFinalizationController>;
