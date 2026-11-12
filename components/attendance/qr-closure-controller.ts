/*
 * Closing QR attendance from the register page (Stage 5.7b-3e),
 * framework-free so it can be tested without a DOM.
 *
 *   POST /api/lectures/[id]/attendance/qr/close   body: exactly {}
 *   → { lectureId, closedAt, alreadyClosed, closedByYou }
 *
 * The server decides everything (closeQrAttendance: teacher-only,
 * permanent, idempotent, allowed before the window opens and after
 * finalization, 409 LECTURE_CANCELLED for a cancelled lecture, concurrent
 * closures serialized). This controller only sequences one request and the
 * register refresh:
 *
 *  - one request at a time: a second confirm while one is in flight (or
 *    while the register is refreshed after it) is refused, never queued;
 *  - success (also `alreadyClosed`): the register is refreshed, so the page
 *    shows the persisted closure (time, no Close / Scan actions);
 *  - an AMBIGUOUS failure (no answer, 5xx, an unreadable answer: the closure
 *    may or may not have been saved) is NEVER retried automatically: the
 *    register is refreshed to find out; if it now shows the closure, that is
 *    reported as closed; otherwise the teacher may try again explicitly
 *    (safe: closing is idempotent);
 *  - LECTURE_CANCELLED / LECTURE_NOT_FOUND: the register is refreshed and
 *    this closure is over (nothing to retry);
 *  - ATTENDANCE_BUSY: shown; the teacher may try again explicitly;
 *  - UNAUTHORIZED: sign in; same-origin / validation refusals: reload;
 *  - dispose() (unmount): aborts and ignores everything afterwards.
 * Closing QR attendance never finalizes the register and does not use the
 * page's reconciliation / finalization lock (the server serializes the
 * closure with them on the register row).
 */

import {
  attendanceRequest,
  type AttendanceApiError,
  type AttendanceApiResult,
  type AttendanceRegisterResponse,
} from "@/components/attendance/attendance-ui";

export type QrClosureResponse = { lectureId: string; closedAt: string; alreadyClosed: boolean; closedByYou: boolean };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const qrClosureEndpoint = (lectureId: string) => `/api/lectures/${encodeURIComponent(lectureId)}/attendance/qr/close`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function readQrClosureResponse(data: unknown): QrClosureResponse | null {
  if (!isObject(data)) return null;
  if (typeof data.lectureId !== "string" || typeof data.closedAt !== "string" || Number.isNaN(Date.parse(data.closedAt))) return null;
  if (typeof data.alreadyClosed !== "boolean" || typeof data.closedByYou !== "boolean") return null;
  return { lectureId: data.lectureId, closedAt: data.closedAt, alreadyClosed: data.alreadyClosed, closedByYou: data.closedByYou };
}

/** The closure request: POST with the body exactly {} (the session decides who closes). Never throws. */
export async function submitQrClosure(
  lectureId: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}
): Promise<AttendanceApiResult<QrClosureResponse>> {
  const result = await attendanceRequest<unknown>(qrClosureEndpoint(lectureId), { method: "POST", body: {}, signal: options.signal, fetchImpl: options.fetchImpl });
  if (!result.ok) return result;
  const data = readQrClosureResponse(result.data);
  return data
    ? { ok: true, status: result.status, data }
    : { ok: false, status: result.status, code: "INVALID_RESPONSE", message: "The server sent an unexpected response. Please try again." };
}

/** How a failure is handled (the code decides; never an automatic retry). */
export type QrClosureFailureKind =
  /** No answer / 5xx / unreadable: the register was refreshed to find out; an explicit retry is allowed. */
  | "AMBIGUOUS"
  /** ATTENDANCE_BUSY: nothing was saved; an explicit retry is allowed. */
  | "BUSY"
  /** Cancelled or no longer found: refreshed; nothing to retry. */
  | "GONE"
  | "SIGN_IN"
  /** Same-origin / validation refusals: reload the page. */
  | "RELOAD";

export function qrClosureFailureKind(error: AttendanceApiError): QrClosureFailureKind {
  if (error.code === "ATTENDANCE_BUSY") return "BUSY";
  if (error.code === "LECTURE_CANCELLED" || error.code === "LECTURE_NOT_FOUND") return "GONE";
  if (error.code === "UNAUTHORIZED") return "SIGN_IN";
  if (error.status === 0 || error.code === "INVALID_RESPONSE" || (error.status >= 500 && error.status !== 503)) return "AMBIGUOUS";
  return "RELOAD";
}

export type QrClosureRefresh = "pending" | "done" | "failed";

export type QrClosureUiState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "succeeded"; result: QrClosureResponse; refresh: QrClosureRefresh }
  /** An ambiguous failure, but the refreshed register shows the closure: it was saved. */
  | { phase: "confirmed"; closedAt: string | null }
  | {
      phase: "failed";
      error: AttendanceApiError;
      kind: QrClosureFailureKind;
      /** "skipped" when no refresh was needed. */
      refresh: QrClosureRefresh | "skipped";
      /** The teacher may press "Try again" (an explicit new request; closing is idempotent). */
      canRetry: boolean;
    };

export type QrClosureControllerDeps = {
  lectureId: string;
  /** Reloads the register; resolves the register now shown, or null when the reload failed (the old one stays). */
  refresh: () => Promise<AttendanceRegisterResponse | null>;
  onChange: (state: QrClosureUiState) => void;
  submit?: (lectureId: string, options: { signal: AbortSignal }) => Promise<AttendanceApiResult<QrClosureResponse>>;
};

export function qrClosureBusy(state: QrClosureUiState): boolean {
  return (
    state.phase === "submitting" ||
    (state.phase === "succeeded" && state.refresh === "pending") ||
    (state.phase === "failed" && state.refresh === "pending")
  );
}

export function createQrClosureController(deps: QrClosureControllerDeps) {
  const submit = deps.submit ?? ((lectureId, options) => submitQrClosure(lectureId, options));
  let state: QrClosureUiState = { phase: "idle" };
  let busy = false;
  let requestId = 0;
  let inFlight: AbortController | null = null;
  let disposed = false;

  const set = (next: QrClosureUiState) => {
    if (disposed) return;
    state = next;
    deps.onChange(next);
  };
  const current = (id: number) => !disposed && id === requestId;

  async function refreshRegister(): Promise<AttendanceRegisterResponse | null> {
    try {
      return await deps.refresh();
    } catch {
      return null;
    }
  }

  return {
    getState: () => state,
    isBusy: () => busy,

    /** Sends one closure request. Refused (false, nothing sent) while busy or after dispose. Never retries. */
    async confirm(): Promise<boolean> {
      if (disposed || busy) return false;
      busy = true;
      const id = ++requestId;
      const abort = new AbortController();
      inFlight = abort;
      try {
        set({ phase: "submitting" });
        let result: AttendanceApiResult<QrClosureResponse>;
        try {
          result = await submit(deps.lectureId, { signal: abort.signal });
        } catch {
          result = { ok: false, status: 0, code: "INVALID_RESPONSE", message: "The server sent an unexpected response. Please try again." };
        }
        if (!current(id)) return true;
        inFlight = null;

        if (result.ok) {
          set({ phase: "succeeded", result: result.data, refresh: "pending" });
          const register = await refreshRegister();
          if (current(id)) set({ phase: "succeeded", result: result.data, refresh: register ? "done" : "failed" });
          return true;
        }

        const error = result;
        const kind = qrClosureFailureKind(error);
        if (kind === "BUSY" || kind === "SIGN_IN" || kind === "RELOAD") {
          set({ phase: "failed", error, kind, refresh: "skipped", canRetry: kind === "BUSY" });
          return true;
        }

        // AMBIGUOUS (did it save?) or GONE: refresh the register; never re-send.
        set({ phase: "failed", error, kind, refresh: "pending", canRetry: false });
        const register = await refreshRegister();
        if (!current(id)) return true;
        if (kind === "AMBIGUOUS" && register?.qr?.closed) {
          set({ phase: "confirmed", closedAt: register.qr.closedAt });
          return true;
        }
        set({ phase: "failed", error, kind, refresh: register ? "done" : "failed", canRetry: kind === "AMBIGUOUS" });
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

    dispose() {
      disposed = true;
      inFlight?.abort();
      inFlight = null;
      busy = false;
    },
  };
}

export type QrClosureController = ReturnType<typeof createQrClosureController>;
