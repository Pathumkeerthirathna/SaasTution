/*
 * The per-lecture grace-period change on the register page (Stage
 * 5.7b-2b-3), framework-free so it can be tested without a DOM. The server
 * decides everything (POST .../attendance/grace through submitRegisterGrace);
 * this only sequences the request and the register refresh.
 *
 *  - one request at a time: a second submit while one is in flight (or while
 *    the register is refreshed after it) is refused, never queued;
 *  - expectedVersion is the register version of the LOADED register (0 = no
 *    register yet): never invented or bumped locally;
 *  - success (an effective change or a no-op): the register is refreshed from
 *    the server, so its history section follows the new version;
 *  - ATTENDANCE_REASON_REQUIRED: nothing is refreshed; the dialog asks for a
 *    reason and the teacher resubmits explicitly;
 *  - the register changed, was finalized, or the lecture was cancelled /
 *    removed: the register is refreshed and this change is over (the teacher
 *    starts again from the current register); nothing is retried;
 *  - busy, network or server errors: the safe message; the teacher may try
 *    again (the same version: a change the server already applied answers
 *    409, never a second change);
 *  - dispose() (unmount): aborts and ignores everything afterwards.
 * The register page's reconciliation / finalization lock is not used (the
 * server serializes grace changes with them on the register row).
 */

import {
  submitRegisterGrace,
  type AttendanceApiError,
  type AttendanceApiResult,
  type GraceRequest,
  type GraceResponse,
} from "@/components/attendance/attendance-ui";

export type GraceRefresh = "pending" | "done" | "failed";

export type GraceUiState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "succeeded"; result: GraceResponse; refresh: GraceRefresh }
  | {
      phase: "failed";
      error: AttendanceApiError;
      /** The server requires a reason for this change (resubmit with one). */
      reasonRequired: boolean;
      /** The register / lecture state changed: refresh and start again (no retry of this change). */
      mustReopen: boolean;
      refresh: GraceRefresh | "skipped";
    };

export type GraceControllerDeps = {
  lectureId: string;
  /** Reloads the register; resolves true when the new data was applied. */
  refresh: () => Promise<boolean>;
  onChange: (state: GraceUiState) => void;
  /** Tests inject the API call; the default is the shared typed helper. */
  submit?: (lectureId: string, request: GraceRequest, options: { signal: AbortSignal }) => Promise<AttendanceApiResult<GraceResponse>>;
};

/** Errors after which this change is over: the register is refreshed and the teacher starts again. */
const REOPEN_CODES = new Set(["ATTENDANCE_REGISTER_CHANGED", "ATTENDANCE_REGISTER_FINALIZED", "LECTURE_CANCELLED", "LECTURE_NOT_FOUND"]);

export function graceErrorNeedsReopen(error: AttendanceApiError): boolean {
  return REOPEN_CODES.has(error.code);
}

export function createGraceController(deps: GraceControllerDeps) {
  const submit = deps.submit ?? ((lectureId, request, options) => submitRegisterGrace(lectureId, request, options));

  let state: GraceUiState = { phase: "idle" };
  let busy = false;
  let requestId = 0;
  let inFlight: AbortController | null = null;
  let disposed = false;

  const set = (next: GraceUiState) => {
    if (disposed) return;
    state = next;
    deps.onChange(next);
  };
  const current = (id: number) => !disposed && id === requestId;

  async function refreshRegister(): Promise<boolean> {
    try {
      return await deps.refresh();
    } catch {
      return false;
    }
  }

  return {
    getState: () => state,
    /** True while the request is sent or the register refreshed after it. */
    isBusy: () => busy,

    /**
     * Sends one grace change. Refused (false, nothing sent) after dispose or
     * while another request is busy. Never retries.
     */
    async submit(request: GraceRequest): Promise<boolean> {
      if (disposed || busy) return false;
      busy = true;
      const id = ++requestId;
      const abort = new AbortController();
      inFlight = abort;
      try {
        set({ phase: "submitting" });
        let result: AttendanceApiResult<GraceResponse>;
        try {
          result = await submit(deps.lectureId, request, { signal: abort.signal });
        } catch {
          result = { ok: false, status: 0, code: "INVALID_RESPONSE", message: "The server sent an unexpected response. Please try again." };
        }
        if (!current(id)) return true;
        inFlight = null;

        if (result.ok) {
          set({ phase: "succeeded", result: result.data, refresh: "pending" });
          const refreshed = await refreshRegister();
          if (current(id)) set({ phase: "succeeded", result: result.data, refresh: refreshed ? "done" : "failed" });
          return true;
        }

        const error = result;
        const reasonRequired = error.code === "ATTENDANCE_REASON_REQUIRED";
        const mustReopen = graceErrorNeedsReopen(error);
        if (!mustReopen) {
          set({ phase: "failed", error, reasonRequired, mustReopen: false, refresh: "skipped" });
          return true;
        }
        set({ phase: "failed", error, reasonRequired: false, mustReopen: true, refresh: "pending" });
        const refreshed = await refreshRegister();
        if (current(id)) set({ phase: "failed", error, reasonRequired: false, mustReopen: true, refresh: refreshed ? "done" : "failed" });
        return true;
      } finally {
        if (id === requestId) {
          busy = false;
          inFlight = null;
        }
      }
    },

    /** Back to idle (the dialog closed or reopened); refused while busy. */
    reset(): boolean {
      if (disposed || busy) return false;
      set({ phase: "idle" });
      return true;
    },

    /** Unmount: abort and ignore everything afterwards. */
    dispose() {
      disposed = true;
      inFlight?.abort();
      inFlight = null;
      busy = false;
    },
  };
}

export type GraceController = ReturnType<typeof createGraceController>;
