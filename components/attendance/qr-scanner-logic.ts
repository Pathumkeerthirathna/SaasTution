/*
 * The teacher's physical QR scanner (Stage 5.7b-3d): framework-free logic,
 * tested without a DOM or a camera. React and the camera live in
 * qr-scanner-panel.tsx and qr-camera.ts.
 *
 *   POST /api/lectures/[id]/attendance/qr/scans  { clientScanId, payload }
 *
 * The server is the authority for everything (session, lecture ownership,
 * the QR window, the token, eligibility, idempotency, rate limits). This
 * module only:
 *  - says whether scanning should be OFFERED, from the loaded register's
 *    `qr` state (scannerAvailability);
 *  - checks a payload for basic usability (non-empty, at most 128
 *    characters) before it is sent;
 *  - sends scans ONE AT A TIME (createScanQueue): a fresh clientScanId per
 *    new scan; the SAME clientScanId when a scan is re-sent; automatic
 *    re-sending only when no response arrived at all (the outcome is
 *    unknown); never for an HTTP answer (400, 401, 403, 404, 409, 413, 429,
 *    5xx, 503): those are shown, and the safe ones offer a manual "Try again"
 *    with the same id;
 *  - turns each outcome into teacher-facing text (describeScanOutcome /
 *    describeScanError), never showing payloads, scan ids or token data;
 *  - debounces register refreshes (createDebouncedRefresh).
 *
 * QR payloads are bearer credentials: they are kept in memory only while a
 * scan is pending or may be retried, never logged, never put in browser
 * storage and never shown; dispose() drops all of them.
 */

import {
  attendanceRequest,
  type AttendanceApiError,
  type AttendanceApiResult,
  type AttendanceRegisterResponse,
  type BadgeTone,
} from "@/components/attendance/attendance-ui";

// =========================================================================================
// 1. Contract and constants
// =========================================================================================

/** The server's limit (lib/attendance-http.ts QR_SCAN_PAYLOAD_MAX_LENGTH); a student QR is 50 characters. */
export const QR_PAYLOAD_MAX_LENGTH = 128;

/** The scan response (Stage 5.7b-3b; no ids, no hashes, no payload). */
export type QrScanResponse = {
  result: string;
  effect: string;
  replayed: boolean;
  receivedAt: string;
  afterFinalization: boolean;
  student: { studentId: string; name: string; registrationNumber: string | null } | null;
  attendance: { status: string; statusSource: string; pendingReview: boolean } | null;
};

export const scanEndpoint = (lectureId: string) => `/api/lectures/${encodeURIComponent(lectureId)}/attendance/qr/scans`;
export const scannerPath = (lectureId: string) => `/dashboard/attendance/${encodeURIComponent(lectureId)}/scan`;
export const registerPath = (lectureId: string) => `/dashboard/attendance/${encodeURIComponent(lectureId)}`;

// =========================================================================================
// 2. Availability (UI only: the API decides)
// =========================================================================================

export type ScannerBlockReason = "CANCELLED" | "CLOSED" | "HISTORICAL" | "UNCONFIGURED" | "NOT_OPEN" | "UNAVAILABLE";

export type ScannerAvailability =
  | { available: true }
  | { available: false; reason: ScannerBlockReason; title: string; message: string; opensAt: string | null };

const COLOMBO_DATE_TIME = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Colombo" });
const COLOMBO_TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Colombo" });

function formatAt(value: string | null | undefined, format: Intl.DateTimeFormat): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : format.format(date);
}

/** Colombo time of a scan (hh:mm:ss), or null. */
export const formatScanTime = (value: string | null | undefined) => formatAt(value, COLOMBO_TIME);

/**
 * Whether the scanner should be offered for the loaded register: only when
 * `qr.window` is OPEN and the lecture is eligible. Ordered so the teacher
 * sees the most specific reason. Never authorization: the scan API checks
 * everything again on every request.
 */
export function scannerAvailability(register: AttendanceRegisterResponse): ScannerAvailability {
  // A register without `qr` (a server from before Stage 5.7b-3b) never offers scanning.
  const qr = (register as Partial<AttendanceRegisterResponse>).qr;
  if (!qr) {
    return { available: false, reason: "UNAVAILABLE", title: "QR attendance is not available", message: "QR scanning is not available for this lecture on this server.", opensAt: null };
  }
  const opensAt = qr.opensAt;
  const block = (reason: ScannerBlockReason, title: string, message: string): ScannerAvailability => ({
    available: false,
    reason,
    title,
    message,
    opensAt: reason === "NOT_OPEN" ? opensAt : null,
  });

  if (register.lecture.classStatus === "CANCELLED") {
    return block("CANCELLED", "This lecture is cancelled", "QR attendance is not taken for a cancelled lecture.");
  }
  if (register.qr.closed) {
    const at = formatAt(register.qr.closedAt, COLOMBO_DATE_TIME);
    return block("CLOSED", "QR attendance is closed", `QR attendance was closed${at ? ` on ${at}` : ""}. No more scans are accepted for this lecture.`);
  }
  if (register.classification === "HISTORICAL") {
    return block(
      "HISTORICAL",
      "Not available for this lecture",
      "This lecture is from before automatic attendance started, so QR scans are not accepted. Mark attendance in the register instead."
    );
  }
  if (register.classification === null || register.configuration.approval !== "OK" || register.configuration.evidence !== "OK") {
    return block("UNCONFIGURED", "QR attendance is not available", "Attendance is not fully configured on this server yet. Please contact the administrator.");
  }
  if (register.qr.window === "NOT_OPEN") {
    const at = formatAt(opensAt, COLOMBO_DATE_TIME);
    return block("NOT_OPEN", "QR attendance is not open yet", `Scanning opens${at ? ` at ${at}` : ""}, 30 minutes before the scheduled start.`);
  }
  if (register.qr.window !== "OPEN") {
    return block("UNAVAILABLE", "QR attendance is not available", "QR scanning is not available for this lecture on this server right now. Please contact the administrator.");
  }
  return { available: true };
}

// =========================================================================================
// 3. Payload checks (usability only: the server validates)
// =========================================================================================

export type PayloadProblem = "EMPTY" | "TOO_LONG";
export type PayloadCheck = { ok: true; payload: string } | { ok: false; problem: PayloadProblem };

/**
 * A scanned or typed payload, trimmed (handheld scanners often add a line
 * break or tab). Empty or over 128 characters is refused locally; anything
 * else goes to the server, which decides whether it is a valid student QR.
 */
export function checkScanPayload(raw: unknown): PayloadCheck {
  if (typeof raw !== "string") return { ok: false, problem: "EMPTY" };
  const payload = raw.trim();
  if (payload === "") return { ok: false, problem: "EMPTY" };
  if (payload.length > QR_PAYLOAD_MAX_LENGTH) return { ok: false, problem: "TOO_LONG" };
  return { ok: true, payload };
}

export function payloadProblemMessage(problem: PayloadProblem): string {
  return problem === "EMPTY"
    ? "Enter or scan a QR code first."
    : `That is not a student attendance QR code (more than ${QR_PAYLOAD_MAX_LENGTH} characters).`;
}

// =========================================================================================
// 4. The request
// =========================================================================================

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ScanRequestBody = { clientScanId: string; payload: string };

export type ScanSubmitOutcome = {
  result: AttendanceApiResult<QrScanResponse>;
  /** Seconds from Retry-After on a 429 (60 when missing or unreadable); null otherwise. */
  retryAfterSeconds: number | null;
};

const MAX_RETRY_AFTER_SECONDS = 3600;

/** Retry-After as seconds: delta-seconds or an HTTP date; null when unusable. Clamped to 1..3600. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^[0-9]{1,10}$/.test(trimmed)) return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Number(trimmed)));
  if (!/[a-z]/i.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil((date - nowMs) / 1000)));
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The response's shape (anything else is treated as an unreadable answer: outcome unknown). */
export function readScanResponse(data: unknown): QrScanResponse | null {
  if (!isObject(data)) return null;
  if (typeof data.result !== "string" || typeof data.effect !== "string") return null;
  if (typeof data.replayed !== "boolean" || typeof data.afterFinalization !== "boolean" || typeof data.receivedAt !== "string") return null;
  const student = data.student;
  if (student !== null && !(isObject(student) && typeof student.studentId === "string" && typeof student.name === "string" && (student.registrationNumber === null || typeof student.registrationNumber === "string"))) {
    return null;
  }
  const attendance = data.attendance;
  if (attendance !== null && !(isObject(attendance) && typeof attendance.status === "string" && typeof attendance.statusSource === "string" && typeof attendance.pendingReview === "boolean")) {
    return null;
  }
  return {
    result: data.result,
    effect: data.effect,
    replayed: data.replayed,
    receivedAt: data.receivedAt,
    afterFinalization: data.afterFinalization,
    student: student === null ? null : { studentId: student.studentId as string, name: student.name as string, registrationNumber: student.registrationNumber as string | null },
    attendance:
      attendance === null
        ? null
        : { status: attendance.status as string, statusSource: attendance.statusSource as string, pendingReview: attendance.pendingReview as boolean },
  };
}

/**
 * One scan request through the shared helper (same-origin, no-store, never
 * throws). Retry-After is read from the response for a 429. The payload is
 * only in the request body.
 */
export async function submitQrScan(
  lectureId: string,
  body: ScanRequestBody,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike; now?: () => number } = {}
): Promise<ScanSubmitOutcome> {
  const base: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let retryAfter: string | null = null;
  const result = await attendanceRequest<unknown>(scanEndpoint(lectureId), {
    method: "POST",
    body: { clientScanId: body.clientScanId, payload: body.payload },
    signal: options.signal,
    fetchImpl: async (input, init) => {
      const response = await base(input, init);
      retryAfter = response.headers.get("retry-after");
      return response;
    },
  });

  if (result.ok) {
    const data = readScanResponse(result.data);
    if (!data) {
      return {
        result: { ok: false, status: result.status, code: "INVALID_RESPONSE", message: "The server sent an unexpected response. Please try again." },
        retryAfterSeconds: null,
      };
    }
    return { result: { ok: true, status: result.status, data }, retryAfterSeconds: null };
  }
  return {
    result,
    retryAfterSeconds: result.status === 429 ? (parseRetryAfter(retryAfter, (options.now ?? Date.now)()) ?? 60) : null,
  };
}

// =========================================================================================
// 5. Outcome text (never colour alone: every entry has a text label)
// =========================================================================================

export type ScanDescription = {
  /** The short status word shown as a badge (always text). */
  label: string;
  tone: BadgeTone;
  title: string;
  detail: string;
};

const STATUS_WORDS: Record<string, string> = { PRESENT: "Present", LATE: "Late", ABSENT: "Absent", EXCUSED: "Excused" };
const statusWord = (status: string | null | undefined) => (status ? (STATUS_WORDS[status] ?? status) : "unknown");

/** Teacher-facing text for a scan the server answered (every result / effect). */
export function describeScanOutcome(outcome: QrScanResponse): ScanDescription {
  const status = statusWord(outcome.attendance?.status);
  const reviewNote = outcome.attendance?.pendingReview ? " A review is waiting in the register." : "";
  const finalizedNote = outcome.afterFinalization ? " The register is finalized, so attendance was not changed." : "";

  switch (outcome.result) {
    case "VALID":
      switch (outcome.effect) {
        case "STATUS_UPDATED":
          return {
            label: status,
            tone: outcome.attendance?.status === "LATE" ? "warning" : "positive",
            title: `Marked ${status}`,
            detail: `Attendance recorded as ${status}.${reviewNote}`,
          };
        case "DUPLICATE":
          return {
            label: "Already recorded",
            tone: "info",
            title: "Already recorded",
            detail: `This student's QR attendance was already recorded (current status: ${status}). Nothing changed.`,
          };
        case "REVIEW_REQUIRED":
          return {
            label: "Needs review",
            tone: "warning",
            title: "Recorded: needs your review",
            detail: `The scan shows better attendance than the current status (${status}). Review it in the register.${finalizedNote}`,
          };
        case "EVIDENCE_ONLY":
          return {
            label: "Recorded",
            tone: "info",
            title: "Scan recorded, attendance unchanged",
            detail: outcome.afterFinalization
              ? `The scan was recorded. The register is finalized, so the status stays ${status}.${reviewNote}`
              : `The scan was recorded. The status stays ${status} (it was set by a teacher decision or earlier evidence).${reviewNote}`,
          };
        case "RECORDED_ONLY":
          return {
            label: "Recorded only",
            tone: "warning",
            title: "Recorded after finalization",
            detail: "The register is finalized and this student has no attendance record, so nothing was changed. Mark attendance in the register if needed.",
          };
        default:
          return { label: "Recorded", tone: "info", title: "Scan recorded", detail: "The scan was recorded." };
      }
    case "NOT_ELIGIBLE":
      return {
        label: "Not eligible",
        tone: "danger",
        title: "Not eligible",
        detail: "This student is not approved or not enrolled in this class at this time. The scan was recorded; no attendance was given.",
      };
    case "ELIGIBILITY_UNKNOWN":
      return {
        label: "Eligibility unknown",
        tone: "warning",
        title: "Eligibility could not be confirmed",
        detail: "The student's approval or enrolment could not be confirmed, so no attendance was given. Check the student and mark attendance in the register if needed.",
      };
    case "INVALID_QR":
      return {
        label: "Invalid QR",
        tone: "danger",
        title: "Invalid QR code",
        detail: "This is not a valid student QR code (it may be old, replaced or revoked). Ask the student to show their current QR code.",
      };
    case "QR_UNVERIFIABLE":
      return {
        label: "Unverified",
        tone: "danger",
        title: "QR code could not be verified",
        detail: "This QR code could not be verified. Ask the student to show their current QR code, or mark attendance in the register.",
      };
    case "WRONG_TEACHER":
      return {
        label: "Not your student",
        tone: "danger",
        title: "Another teacher's QR code",
        detail: "This QR code belongs to a student of another teacher. Nothing was recorded for them.",
      };
    case "LECTURE_UNAVAILABLE":
      return {
        label: "Lecture unavailable",
        tone: "danger",
        title: "Lecture unavailable",
        detail: "This lecture is cancelled or was removed, so no attendance was recorded.",
      };
    default:
      return { label: "Recorded", tone: "neutral", title: "Scan answered", detail: "The server answered this scan." };
  }
}

/** Errors whose scan may safely be sent again with the SAME clientScanId (manually; never automatically except NETWORK_ERROR). */
export function scanErrorRetryable(error: AttendanceApiError): boolean {
  if (error.status === 0) return true; // no answer: outcome unknown
  if (error.status === 429) return true;
  if (error.code === "ATTENDANCE_BUSY") return true;
  return error.status >= 500 && error.status !== 503;
}

/** Teacher-facing text for a scan the server refused, or that got no answer. */
export function describeScanError(error: AttendanceApiError, retryAfterSeconds: number | null = null): ScanDescription {
  const detailsOpensAt = isObject(error.details) && typeof error.details.opensAt === "string" ? error.details.opensAt : null;
  switch (error.code) {
    case "ATTENDANCE_QR_NOT_OPEN": {
      const at = formatAt(detailsOpensAt, COLOMBO_DATE_TIME);
      return { label: "Not open yet", tone: "warning", title: "QR attendance is not open yet", detail: `Scanning opens${at ? ` at ${at}` : " 30 minutes before the scheduled start"}. Nothing was recorded.` };
    }
    case "ATTENDANCE_QR_CLOSED":
      return { label: "QR closed", tone: "neutral", title: "QR attendance is closed", detail: "QR attendance was closed for this lecture. Nothing was recorded." };
    case "ATTENDANCE_LECTURE_HISTORICAL":
      return { label: "Not available", tone: "neutral", title: "Not available for this lecture", detail: "This lecture is from before automatic attendance started. Mark attendance in the register." };
    case "ATTENDANCE_SCAN_RATE_LIMITED": {
      const seconds = retryAfterSeconds ?? 60;
      return {
        label: "Too many scans",
        tone: "warning",
        title: "Too many scans",
        detail: `Scanning is paused. Wait about ${seconds} second${seconds === 1 ? "" : "s"}, then try this scan again. Nothing was recorded for it.`,
      };
    }
    case "ATTENDANCE_SCAN_ID_REUSED":
      return { label: "Scan conflict", tone: "warning", title: "Scan conflict", detail: "This scan could not be matched with an earlier one. Scan the QR code again." };
    case "ATTENDANCE_BUSY":
      return { label: "Busy", tone: "warning", title: "Attendance is busy", detail: "Attendance was being updated. Try this scan again (it will never be recorded twice)." };
    case "UNAUTHORIZED":
      return { label: "Signed out", tone: "danger", title: "Your session has expired", detail: "Sign in again, then scan again. Scans waiting to be sent are kept on this page until you leave it." };
    case "LECTURE_NOT_FOUND":
      return { label: "Not found", tone: "danger", title: "Lecture not found", detail: "This lecture does not exist or is not one of your lectures." };
    case "CROSS_ORIGIN_REQUEST_REJECTED":
      return { label: "Blocked", tone: "danger", title: "Request blocked", detail: "This request was blocked for security. Reload the page and try again." };
    case "VALIDATION_ERROR":
    case "INVALID_JSON":
    case "ATTENDANCE_REQUEST_TOO_LARGE":
      return { label: "Not accepted", tone: "danger", title: "Not a valid scan", detail: "The server did not accept this scan. Scan the QR code again." };
    case "ATTENDANCE_APPROVAL_NOT_CONFIGURED":
    case "ATTENDANCE_EVIDENCE_NOT_CONFIGURED":
    case "STUDENT_QR_NOT_CONFIGURED":
      return { label: "Unavailable", tone: "danger", title: "QR attendance is not configured", detail: "QR attendance is not configured on this server. Please contact the administrator." };
    case "NETWORK_ERROR":
      return {
        label: "Not confirmed",
        tone: "warning",
        title: "Not confirmed: connection problem",
        detail: "The server could not be reached, so this scan may or may not have been recorded. Try again: it will never be recorded twice.",
      };
    default:
      return error.status >= 500 && error.status !== 503
        ? { label: "Server error", tone: "danger", title: "Server error", detail: "Something went wrong on the server. Try this scan again (it will never be recorded twice)." }
        : { label: "Not recorded", tone: "danger", title: "Scan not accepted", detail: "This scan could not be completed. Scan the QR code again." };
  }
}

// =========================================================================================
// 6. The sequential queue
// =========================================================================================

export type ScanSource = "CAMERA" | "MANUAL";

export type ScanFeedEntry = {
  /** Local id (never the server's or the scan id). */
  id: string;
  source: ScanSource;
  /** The server's time (ISO) when it answered; null when it did not. */
  receivedAt: string | null;
  student: { name: string; registrationNumber: string | null } | null;
  description: ScanDescription;
  /** Answered again for an already stored scan (the same clientScanId). */
  replayed: boolean;
  /** "Try again" re-sends the same scan (same clientScanId). */
  retryable: boolean;
};

export type PendingScanView = { id: string; source: ScanSource; state: "WAITING" | "SENDING" | "RETRYING"; attempt: number };

export type ScanQueueSnapshot = {
  pending: PendingScanView[];
  /** Newest first, at most FEED_LIMIT. No payloads, no ids from the server. */
  feed: ScanFeedEntry[];
  /** Epoch ms until which nothing is sent (after a 429), or null. */
  pausedUntil: number | null;
  /** The session expired: nothing more is sent from this page (pending scans stay listed). */
  signedOut: boolean;
};

export type EnqueueResult = "QUEUED" | "DUPLICATE" | "INVALID" | "FULL" | "CLOSED";

/** Why the page should reload the register now (the QR or lecture state may have changed). */
export type ScanQueueEvent = { kind: "ANSWERED" } | { kind: "STATE_CHANGED" };

type PendingItem = {
  id: string;
  clientScanId: string;
  payload: string;
  source: ScanSource;
  state: PendingScanView["state"];
  attempt: number;
};

export const SCAN_QUEUE_LIMITS = {
  /** Automatic attempts for a scan that got NO answer (outcome unknown), the first included. */
  networkAttempts: 3,
  /** Waits before the automatic re-sends. */
  retryDelaysMs: [1_000, 3_000] as readonly number[],
  /** The same QR read again by the camera within this time is ignored. */
  cameraRepeatMs: 5_000,
  maxPending: 50,
  feedLimit: 50,
  /** Failed scans kept (with their payload) for a manual retry. */
  maxRetainedForRetry: 20,
} as const;

export type ScanQueueDeps = {
  lectureId: string;
  onChange: (snapshot: ScanQueueSnapshot) => void;
  onEvent?: (event: ScanQueueEvent) => void;
  /**
   * Every answer the SERVER gave (after it is in the feed), e.g. for the audio
   * confirmation. Never called for errors or unanswered scans; a callback that
   * throws never affects the queue.
   */
  onAnswered?: (outcome: QrScanResponse) => void;
  submit?: (lectureId: string, body: ScanRequestBody, options: { signal: AbortSignal }) => Promise<ScanSubmitOutcome>;
  /** A fresh clientScanId (default crypto.randomUUID()). */
  newClientScanId?: () => string;
  now?: () => number;
  /** Resolves after `ms` (or when the signal aborts). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  limits?: Partial<typeof SCAN_QUEUE_LIMITS>;
};

const STATE_CHANGE_CODES = new Set(["ATTENDANCE_QR_CLOSED", "ATTENDANCE_QR_NOT_OPEN", "ATTENDANCE_LECTURE_HISTORICAL", "LECTURE_NOT_FOUND", "LECTURE_CANCELLED"]);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

function defaultClientScanId(): string {
  return globalThis.crypto.randomUUID();
}

export function createScanQueue(deps: ScanQueueDeps) {
  const limits = { ...SCAN_QUEUE_LIMITS, ...deps.limits };
  const submit = deps.submit ?? ((lectureId, body, options) => submitQrScan(lectureId, body, options));
  const newClientScanId = deps.newClientScanId ?? defaultClientScanId;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  const lifetime = new AbortController();
  let disposed = false;
  let running = false;
  let localSeq = 0;
  const pending: PendingItem[] = [];
  let feed: ScanFeedEntry[] = [];
  /** Feed entry id → the scan, for a manual retry (same clientScanId). */
  const retained = new Map<string, { clientScanId: string; payload: string; source: ScanSource }>();
  /** Payload → when the camera last finished it (camera repeat suppression). */
  const recentCamera = new Map<string, number>();
  let pausedUntil: number | null = null;
  let signedOut = false;

  const snapshot = (): ScanQueueSnapshot => ({
    pending: pending.map((p) => ({ id: p.id, source: p.source, state: p.state, attempt: p.attempt })),
    feed: feed.slice(),
    pausedUntil,
    signedOut,
  });
  const emit = () => {
    if (!disposed) deps.onChange(snapshot());
  };
  const event = (e: ScanQueueEvent) => {
    if (!disposed) deps.onEvent?.(e);
  };

  function addFeed(entry: ScanFeedEntry, scan: PendingItem | null) {
    feed = [entry, ...feed];
    if (scan && entry.retryable) {
      retained.set(entry.id, { clientScanId: scan.clientScanId, payload: scan.payload, source: scan.source });
      while (retained.size > limits.maxRetainedForRetry) {
        const oldest = retained.keys().next().value as string;
        retained.delete(oldest);
        feed = feed.map((f) => (f.id === oldest ? { ...f, retryable: false } : f));
      }
    }
    while (feed.length > limits.feedLimit) {
      const dropped = feed.pop();
      if (dropped) retained.delete(dropped.id);
    }
  }

  function rememberCamera(item: PendingItem) {
    if (item.source !== "CAMERA") return;
    const t = now();
    recentCamera.set(item.payload, t);
    for (const [payload, at] of recentCamera) if (t - at > limits.cameraRepeatMs) recentCamera.delete(payload);
  }

  function finish(item: PendingItem, entry: ScanFeedEntry) {
    const index = pending.indexOf(item);
    if (index >= 0) pending.splice(index, 1);
    rememberCamera(item);
    addFeed(entry, entry.retryable ? item : null);
  }

  async function processOne(item: PendingItem): Promise<void> {
    for (;;) {
      item.state = item.attempt === 0 ? "SENDING" : "RETRYING";
      item.attempt += 1;
      emit();
      const { result, retryAfterSeconds } = await submit(deps.lectureId, { clientScanId: item.clientScanId, payload: item.payload }, { signal: lifetime.signal });
      if (disposed) return;

      if (result.ok) {
        const outcome = result.data;
        finish(item, {
          id: item.id,
          source: item.source,
          receivedAt: outcome.receivedAt,
          student: outcome.student ? { name: outcome.student.name, registrationNumber: outcome.student.registrationNumber } : null,
          description: describeScanOutcome(outcome),
          replayed: outcome.replayed,
          retryable: false,
        });
        try {
          deps.onAnswered?.(outcome);
        } catch {
          // Feedback (audio) must never break scanning.
        }
        event({ kind: outcome.result === "LECTURE_UNAVAILABLE" ? "STATE_CHANGED" : "ANSWERED" });
        return;
      }

      // No answer at all: the outcome is unknown. Re-send the SAME scan (same clientScanId) a few times.
      if (result.status === 0 && item.attempt < limits.networkAttempts) {
        item.state = "RETRYING";
        emit();
        await sleep(limits.retryDelaysMs[Math.min(item.attempt - 1, limits.retryDelaysMs.length - 1)] ?? 1_000, lifetime.signal);
        if (disposed) return;
        continue;
      }

      // Any HTTP answer (and an exhausted no-answer): shown, never re-sent automatically.
      if (result.status === 429) pausedUntil = now() + (retryAfterSeconds ?? 60) * 1000;
      if (result.code === "UNAUTHORIZED") signedOut = true;
      finish(item, {
        id: item.id,
        source: item.source,
        receivedAt: null,
        student: null,
        description: describeScanError(result, retryAfterSeconds),
        replayed: false,
        retryable: scanErrorRetryable(result) && result.code !== "UNAUTHORIZED",
      });
      if (STATE_CHANGE_CODES.has(result.code)) event({ kind: "STATE_CHANGED" });
      return;
    }
  }

  async function pump(): Promise<void> {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && !signedOut && pending.length > 0) {
        if (pausedUntil !== null) {
          const wait = pausedUntil - now();
          if (wait > 0) {
            emit();
            await sleep(wait, lifetime.signal);
            if (disposed) return;
          }
          pausedUntil = null;
        }
        await processOne(pending[0]);
        emit();
      }
    } finally {
      running = false;
      emit();
    }
  }

  return {
    /** Adds a scan (fresh clientScanId) unless it is a repeat of one still pending (or a camera repeat). */
    enqueue(raw: string, source: ScanSource): EnqueueResult {
      if (disposed) return "CLOSED";
      const check = checkScanPayload(raw);
      if (!check.ok) return "INVALID";
      const payload = check.payload;
      if (pending.some((p) => p.payload === payload)) return "DUPLICATE";
      if (source === "CAMERA") {
        const at = recentCamera.get(payload);
        if (at !== undefined && now() - at <= limits.cameraRepeatMs) return "DUPLICATE";
      }
      if (pending.length >= limits.maxPending) return "FULL";
      pending.push({ id: `scan-${++localSeq}`, clientScanId: newClientScanId(), payload, source, state: "WAITING", attempt: 0 });
      emit();
      void pump();
      return "QUEUED";
    },
    /** "Try again" for a failed scan that allows it: the SAME clientScanId and payload. */
    retry(entryId: string): boolean {
      if (disposed || signedOut) return false;
      const scan = retained.get(entryId);
      if (!scan) return false;
      if (pending.some((p) => p.clientScanId === scan.clientScanId)) return false;
      retained.delete(entryId);
      feed = feed.filter((f) => f.id !== entryId);
      pending.push({ id: `scan-${++localSeq}`, clientScanId: scan.clientScanId, payload: scan.payload, source: scan.source, state: "WAITING", attempt: 0 });
      emit();
      void pump();
      return true;
    },
    pendingCount: () => pending.length,
    /** How many payloads are held in memory (pending, kept for a retry, camera repeat check): 0 after dispose(). */
    heldPayloadCount: () => pending.length + retained.size + recentCamera.size,
    snapshot,
    /** Stops sending and drops every scan, payload and result from memory (leaving the scanner). */
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      pending.length = 0;
      retained.clear();
      recentCamera.clear();
      feed = [];
    },
  };
}

export type ScanQueue = ReturnType<typeof createScanQueue>;

// =========================================================================================
// 7. Debounced register refresh
// =========================================================================================

export type DebouncedRefreshDeps = {
  /** Reloads the register; resolves true when applied (false keeps what is shown). */
  refresh: () => Promise<boolean>;
  /** Quiet time after the last scan before reloading. */
  delayMs?: number;
  /** Longest wait while scans keep coming. */
  maxWaitMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/**
 * Register reloads after scanning activity: one reload after a quiet period
 * (or at the latest after maxWaitMs of continuous scanning), never one per
 * scan; flush() reloads now. One reload at a time; a request during a reload
 * runs one more afterwards.
 */
export function createDebouncedRefresh(deps: DebouncedRefreshDeps) {
  const delayMs = deps.delayMs ?? 4_000;
  const maxWaitMs = deps.maxWaitMs ?? 20_000;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let firstRequestAt: number | null = null;
  let inFlight = false;
  let again = false;
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  async function run(): Promise<void> {
    cancelTimer();
    firstRequestAt = null;
    if (disposed) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    try {
      await deps.refresh();
    } catch {
      // The page keeps the register it shows.
    } finally {
      inFlight = false;
    }
    if (again && !disposed) {
      again = false;
      await run();
    }
  }

  return {
    schedule() {
      if (disposed) return;
      const t = now();
      if (firstRequestAt === null) firstRequestAt = t;
      cancelTimer();
      const wait = Math.max(0, Math.min(delayMs, firstRequestAt + maxWaitMs - t));
      timer = setTimer(() => void run(), wait);
    },
    flush: () => run(),
    pending: () => timer !== null,
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}
