/*
 * Shared client-side logic of the teacher attendance UI (Stage 5.5d-1).
 * Pure TypeScript: no React, no dependency beyond the browser `fetch`. See
 * docs/lecture-attendance.md ("Attendance API (Stage 5.5c)") for the
 * contracts this module consumes:
 *
 *   GET  /api/lectures/[id]/attendance              → AttendanceRegisterResponse
 *   POST /api/lectures/[id]/attendance/reconcile    → ReconcilePage
 *   GET  /api/lectures/[id]/attendance/finalization → FinalizationPreviewResponse
 *   POST /api/lectures/[id]/attendance/finalize     → FinalizeResponse
 *   GET  /api/lectures/attendance-overview          → AttendanceOverviewItem[] (+ pagination)
 *   POST /api/lectures/[id]/attendance/students/[studentId]/decision → DecisionResponse (5.6a)
 *   POST /api/lectures/[id]/attendance/students/[studentId]/review   → ReviewResponse (5.6a)
 *   GET  /api/lectures/[id]/attendance/history                       → RegisterHistoryResponse (5.6b)
 *   GET  /api/lectures/[id]/attendance/students/[studentId]/history  → StudentHistoryResponse (5.6b)
 *
 * The server stays the authority for authorization and every state
 * transition; nothing here decides anything the server does not.
 */

import type { AttendanceRegisterResponse } from "@/lib/attendance-register-response";
import { DEFAULT_ATTENDANCE_GRACE_MINUTES, MAX_ATTENDANCE_GRACE_MINUTES, MIN_ATTENDANCE_GRACE_MINUTES } from "@/lib/attendance/status";
import type { AttendanceOverviewItem } from "@/services/lecture-attendance-overview-service";

// =========================================================================================
// 1. Typed fetch helper
// =========================================================================================

/**
 * The error codes the four attendance routes can answer (their services'
 * table, lib/attendance/service-errors.ts, plus the route, middleware and
 * shared-handler codes), and the two client-side ones (no answer / not a
 * valid API answer).
 */
export const ATTENDANCE_API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "INVALID_JSON",
  "UNAUTHORIZED",
  "CROSS_ORIGIN_REQUEST_REJECTED",
  "LECTURE_NOT_FOUND",
  "LECTURE_CANCELLED",
  "ATTENDANCE_LECTURE_HISTORICAL",
  "ATTENDANCE_BUSY",
  "FINALIZATION_NOT_ALLOWED",
  "FINALIZATION_SESSION_ACTIVE",
  "FINALIZATION_EVIDENCE_PENDING",
  "FINALIZATION_ROSTER_LIMIT_EXCEEDED",
  "FINALIZATION_CANDIDATES_CHANGED",
  "FINALIZATION_PREVIEW_STALE",
  "FINALIZATION_INTEGRITY_ERROR",
  "INTERNAL_SERVER_ERROR",
  "ATTENDANCE_APPROVAL_NOT_CONFIGURED",
  "ATTENDANCE_EVIDENCE_NOT_CONFIGURED",
  // Decisions, reviews and history (Stage 5.6a / 5.6b).
  "ATTENDANCE_RECORD_CHANGED",
  "ATTENDANCE_REASON_REQUIRED",
  "ATTENDANCE_NO_PENDING_REVIEW",
  "ATTENDANCE_STUDENT_NOT_ENROLLED",
  "STUDENT_NOT_FOUND",
  // Register changes (Stage 5.7b-2b-2: the per-lecture grace period).
  "ATTENDANCE_REGISTER_CHANGED",
  "ATTENDANCE_REGISTER_FINALIZED",
] as const;
export const CLIENT_ERROR_CODES = ["NETWORK_ERROR", "INVALID_RESPONSE"] as const;

export type AttendanceApiErrorCode = (typeof ATTENDANCE_API_ERROR_CODES)[number];
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export type AttendanceApiError = {
  ok: false;
  /** HTTP status; 0 when no response arrived. */
  status: number;
  /** The server's code (kept even when this module does not know it), or a client code. */
  code: string;
  /** A teacher-facing message: never server internals. */
  message: string;
  /** The server's safe details (field, counts, reason, setting / status) for 4xx and 503; never for other 5xx. */
  details?: unknown;
};

/** The API's page metadata (lib/api-types.ts PaginationMeta), when a list endpoint sends it. */
export type AttendancePagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

/** `pagination` is present only when the API sent valid page metadata (list endpoints). */
export type AttendanceApiResult<T> = { ok: true; status: number; data: T; pagination?: AttendancePagination } | AttendanceApiError;

function readPagination(value: unknown): AttendancePagination | null {
  if (!isObject(value)) return null;
  const numbers = ["page", "pageSize", "totalItems", "totalPages"] as const;
  if (!numbers.every((key) => typeof value[key] === "number" && Number.isInteger(value[key]) && (value[key] as number) >= 0)) return null;
  if (typeof value.hasNextPage !== "boolean" || typeof value.hasPreviousPage !== "boolean") return null;
  return value as unknown as AttendancePagination;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type AttendanceRequestOptions = {
  method?: "GET" | "POST";
  /** JSON body for a POST. */
  body?: unknown;
  signal?: AbortSignal;
  /** Tests (and callers needing it) inject a fetch; defaults to the global one. */
  fetchImpl?: FetchLike;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One attendance API call. Never throws (an aborted request is
 * NETWORK_ERROR); the result keeps the HTTP status and the API error code.
 * Same-origin `fetch` sends the session cookie and the Origin header the
 * POST routes check; responses are no-store on the server side, so nothing
 * is cached here.
 */
export async function attendanceRequest<T>(url: string, options: AttendanceRequestOptions = {}): Promise<AttendanceApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const method = options.method ?? "GET";

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: method === "POST" ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
      signal: options.signal,
    });
  } catch {
    return { ok: false, status: 0, code: "NETWORK_ERROR", message: attendanceErrorMessage("NETWORK_ERROR") };
  }

  let payload: unknown = null;
  try {
    const text = await response.text();
    payload = text.trim() === "" ? null : JSON.parse(text);
  } catch {
    payload = undefined; // not JSON
  }

  if (response.ok && isObject(payload) && payload.success === true && "data" in payload) {
    const pagination = readPagination(payload.pagination);
    return pagination
      ? { ok: true, status: response.status, data: payload.data as T, pagination }
      : { ok: true, status: response.status, data: payload.data as T };
  }

  const error = isObject(payload) && payload.success === false && isObject(payload.error) ? payload.error : null;
  if (!response.ok && error && typeof error.code === "string" && error.code !== "") {
    const code = error.code;
    const serverSide = response.status >= 500 && response.status !== 503;
    return {
      ok: false,
      status: response.status,
      code,
      // Known codes: our fixed text. Unknown 4xx: the server's message (fixed text by convention). 5xx: never server text.
      message: isKnownErrorCode(code)
        ? attendanceErrorMessage(code)
        : !serverSide && typeof error.message === "string" && error.message.trim() !== ""
          ? error.message
          : attendanceErrorMessage(serverSide ? "INTERNAL_SERVER_ERROR" : "INVALID_RESPONSE"),
      ...(!serverSide && error.details !== undefined ? { details: error.details } : {}),
    };
  }

  // Anything else (HTML error pages, proxies, a success without data, an error without a code).
  return {
    ok: false,
    status: response.status,
    code: response.status >= 500 && response.status !== 503 ? "INTERNAL_SERVER_ERROR" : "INVALID_RESPONSE",
    message: attendanceErrorMessage(response.status >= 500 && response.status !== 503 ? "INTERNAL_SERVER_ERROR" : "INVALID_RESPONSE"),
  };
}

const lecturePath = (lectureId: string) => `/api/lectures/${encodeURIComponent(lectureId)}/attendance`;

// ---- The four API contracts (wire format: dates are ISO strings) ----------------------

export type ReconcileCounts = {
  processed: number;
  applied: number;
  duplicates: number;
  ineligible: number;
  unknown: number;
  inactive: number;
  finalizedWithoutRecord: number;
  busy: number;
  skipped: number;
};

/** POST /reconcile `data` (services/lecture-attendance-reconcile-service.ts ReconcileResult). */
export type ReconcilePage = ReconcileCounts & {
  lectureId: string;
  nextCursor: string | null;
  stoppedBecause: "LECTURE_CHANGED" | null;
};

export type FinalizationReadinessReason =
  | "ALREADY_FINALIZED"
  | "LECTURE_CANCELLED"
  | "LECTURE_NOT_STARTED"
  | "SCHEDULED_END_NOT_PASSED"
  | "COMPLETION_REQUIRED";

/** services/lecture-attendance-finalization-preview-service.ts FinalizationBlocker. */
export type FinalizationBlocker = FinalizationReadinessReason | "SESSION_ACTIVE" | "EVIDENCE_PENDING" | "UNKNOWN_EVIDENCE" | "ROSTER_LIMIT_EXCEEDED";

/** GET /finalization `data` (the Stage 5.5a preview, serialized). */
export type FinalizationPreviewResponse = {
  lecture: { lectureId: string; status: number; classStatus: string; date: string; endDate: string | null };
  register: {
    exists: boolean;
    version: number;
    scheduledStartAt: string;
    scheduledEndAt: string | null;
    graceMinutes: number;
    finalized: boolean;
    finalizedAt: string | null;
  };
  classification: "LIVE" | "HISTORICAL";
  summary: {
    rosterSize: number;
    eligibleStudents: number;
    unknownEligibilityStudents: number;
    studentsWithRecord: number;
    automaticAbsent: number;
    manualReview: number;
    notEligibleWithoutRecord: number;
    recordStatus: { PRESENT: number; LATE: number; ABSENT: number; EXCUSED: number };
  };
  evidence: { pendingOnlineEvidence: number; unknownApprovalEvidence: number; pendingReviews: number; complete: boolean };
  readiness: {
    ready: boolean;
    schedule: { allowed: true; basis: "SCHEDULED_END_PASSED" | "LECTURE_COMPLETED" } | { allowed: false; reason: FinalizationReadinessReason };
    blockers: FinalizationBlocker[];
    activeSessions: { active: boolean; count: number };
    rosterLimit: number;
    rosterLimitExceeded: boolean;
    evidenceComplete: boolean;
  };
  fingerprint: string;
  fingerprintVersion: number;
};

/** POST /finalize `data`. */
export type FinalizeResponse = {
  lectureId: string;
  alreadyFinalized: boolean;
  finalizedAt: string;
  registerVersion: number;
  eligibleStudents: number;
  unknownEligibilityStudents: number;
  absentCreated: number;
  details: {
    rosterSize: number;
    studentsWithRecord: number;
    manualReview: number;
    notEligibleWithoutRecord: number;
    recordStatusBefore: { PRESENT: number; LATE: number; ABSENT: number; EXCUSED: number };
    pendingReviews: number;
  } | null;
};

export type { AttendanceRegisterResponse };

type CallOptions = Pick<AttendanceRequestOptions, "signal" | "fetchImpl">;

export function fetchAttendanceRegister(lectureId: string, options: CallOptions = {}) {
  return attendanceRequest<AttendanceRegisterResponse>(lecturePath(lectureId), options);
}

export function fetchFinalizationPreview(lectureId: string, options: CallOptions = {}) {
  return attendanceRequest<FinalizationPreviewResponse>(`${lecturePath(lectureId)}/finalization`, options);
}

export function finalizeAttendance(lectureId: string, fingerprint: string, options: CallOptions = {}) {
  return attendanceRequest<FinalizeResponse>(`${lecturePath(lectureId)}/finalize`, { ...options, method: "POST", body: { fingerprint } });
}

export function reconcilePage(lectureId: string, page: { cursor: string | null; limit: number }, options: CallOptions = {}) {
  return attendanceRequest<ReconcilePage>(`${lecturePath(lectureId)}/reconcile`, {
    ...options,
    method: "POST",
    body: { cursor: page.cursor, limit: page.limit },
  });
}

/** One lecture of GET /api/lectures/attendance-overview (services/lecture-attendance-overview-service.ts). */
export type { AttendanceOverviewItem };

export const OVERVIEW_MAX_PAGE_SIZE = 100;

export type AttendanceOverviewQuery = {
  page: number;
  pageSize: number;
  classId?: string | null;
  title?: string | null;
  /** Real instants (the API filters lecture dates inclusively: from ≤ date ≤ to). */
  from?: Date | null;
  to?: Date | null;
  sortOrder: "asc" | "desc";
};

/**
 * The query string of GET /api/lectures/attendance-overview, encoded by
 * URLSearchParams: page ≥ 1, pageSize 1–100 (the API's cap), the title
 * trimmed (omitted when blank), the class id (omitted when empty), from / to
 * as UTC ISO instants (omitted when absent or invalid), sortOrder asc / desc.
 */
export function buildAttendanceOverviewQuery(query: AttendanceOverviewQuery): string {
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Math.floor(query.page) || 1)));
  params.set("pageSize", String(Math.min(OVERVIEW_MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize) || 1))));
  params.set("sortOrder", query.sortOrder === "asc" ? "asc" : "desc");
  const title = query.title?.trim();
  if (title) params.set("title", title);
  const classId = query.classId?.trim();
  if (classId) params.set("classId", classId);
  if (query.from && !Number.isNaN(query.from.getTime())) params.set("from", query.from.toISOString());
  if (query.to && !Number.isNaN(query.to.getTime())) params.set("to", query.to.toISOString());
  return params.toString();
}

/** One page of the teacher's lectures with their register state (the result carries `pagination`). */
export function fetchAttendanceOverview(query: AttendanceOverviewQuery, options: CallOptions = {}) {
  return attendanceRequest<AttendanceOverviewItem[]>(`/api/lectures/attendance-overview?${buildAttendanceOverviewQuery(query)}`, options);
}

// =========================================================================================
// 2. Labels
// =========================================================================================

export type BadgeTone = "positive" | "warning" | "danger" | "info" | "neutral";

const STATUS_LABELS: Record<string, { label: string; tone: BadgeTone }> = {
  PRESENT: { label: "Present", tone: "positive" },
  LATE: { label: "Late", tone: "warning" },
  ABSENT: { label: "Absent", tone: "danger" },
  EXCUSED: { label: "Excused", tone: "info" },
};

/** A LectureAttendance status (status, autoStatus or teacherStatus). Null / unknown values say so; nothing is guessed. */
export function attendanceStatusLabel(status: string | null | undefined): { label: string; tone: BadgeTone } {
  if (status === null || status === undefined) return { label: "No record", tone: "neutral" };
  return STATUS_LABELS[status] ?? { label: "Unknown status", tone: "neutral" };
}

const SOURCE_LABELS: Record<string, string> = {
  AUTO: "Automatic (from evidence)",
  TEACHER: "Teacher decision",
  FINALIZATION: "Finalization (automatic absence)",
  BACKFILL: "Backfill (historical)",
};

export function statusSourceLabel(source: string | null | undefined): string {
  if (source === null || source === undefined) return "No record";
  return SOURCE_LABELS[source] ?? "Unknown source";
}

/** Eligibility at the register's scheduled start (outcome + reason as the API sends them). */
export function eligibilityLabel(eligibility: { outcome: string; reason: string } | null | undefined): { label: string; tone: BadgeTone } {
  if (!eligibility) return { label: "Not available", tone: "neutral" };
  switch (eligibility.reason) {
    case "ELIGIBLE":
      return { label: "Eligible", tone: "positive" };
    case "NOT_APPROVED":
      return { label: "Not approved", tone: "neutral" };
    case "NOT_ENROLLED":
      return { label: "Not enrolled at the start", tone: "neutral" };
    case "STUDENT_INACTIVE":
      return { label: "Inactive or deleted account", tone: "neutral" };
    case "APPROVAL_UNKNOWN":
      return { label: "Approval unknown (manual review)", tone: "warning" };
    default:
      return eligibility.outcome === "UNKNOWN" ? { label: "Unknown (manual review)", tone: "warning" } : { label: "Not eligible", tone: "neutral" };
  }
}

const ABSENCE_DECISION_LABELS: Record<string, string> = {
  CREATE_ABSENT: "Will be marked absent at finalization",
  HAS_RECORD: "Already recorded",
  NOT_ELIGIBLE: "Not eligible",
  MANUAL_REVIEW: "Manual review (never marked absent automatically)",
};

export function absenceDecisionLabel(decision: string | null | undefined): string | null {
  if (decision === null || decision === undefined) return null;
  return ABSENCE_DECISION_LABELS[decision] ?? "Unknown";
}

export type EvidenceChannel = { channel: "ONLINE" | "QR"; at: string };

/**
 * The evidence the record shows, from its own timestamps only: ONLINE when
 * firstOnlineAt is set, QR when firstQrAt is set, earliest first. Empty for
 * no record or no evidence (a teacher / finalization status without evidence).
 */
export function evidenceChannels(record: { firstOnlineAt: string | null; firstQrAt: string | null } | null | undefined): EvidenceChannel[] {
  if (!record) return [];
  const out: EvidenceChannel[] = [];
  if (record.firstOnlineAt) out.push({ channel: "ONLINE", at: record.firstOnlineAt });
  if (record.firstQrAt) out.push({ channel: "QR", at: record.firstQrAt });
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function evidenceSummaryLabel(record: { firstOnlineAt: string | null; firstQrAt: string | null } | null | undefined): string {
  const channels = evidenceChannels(record).map((c) => c.channel);
  if (channels.length === 2) return "Online and QR";
  if (channels[0] === "ONLINE") return "Online";
  if (channels[0] === "QR") return "QR";
  return "No evidence";
}

const COLOMBO_FORMAT = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Colombo" });

/** An API timestamp (UTC ISO) in Sri Lankan time; "—" when absent or invalid (also exported by the register panel). */
export function formatColomboDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? "—" : COLOMBO_FORMAT.format(new Date(ms));
}

// =========================================================================================
// 3. Error and blocker messages
// =========================================================================================

const ERROR_MESSAGES: Record<AttendanceApiErrorCode | ClientErrorCode, string> = {
  VALIDATION_ERROR: "The request was not valid. Reload the page and try again.",
  INVALID_JSON: "The request was not valid. Reload the page and try again.",
  UNAUTHORIZED: "Your session has expired. Please sign in again.",
  CROSS_ORIGIN_REQUEST_REJECTED: "This request was blocked for security. Reload the page and try again.",
  LECTURE_NOT_FOUND: "This lecture was not found.",
  LECTURE_CANCELLED: "This lecture is cancelled.",
  ATTENDANCE_LECTURE_HISTORICAL: "This lecture is before automatic attendance started, so online evidence is not reconciled for it.",
  ATTENDANCE_BUSY: "Attendance is being updated right now. Please try again in a moment.",
  FINALIZATION_NOT_ALLOWED: "This register cannot be finalized yet.",
  FINALIZATION_SESSION_ACTIVE: "End the live class session before finalizing attendance.",
  FINALIZATION_EVIDENCE_PENDING: "Some online attendance is not recorded yet. Reconcile online evidence and review those students before finalizing.",
  FINALIZATION_ROSTER_LIMIT_EXCEEDED: "This class has too many students to finalize in one step.",
  FINALIZATION_CANDIDATES_CHANGED: "The class roster changed while finalizing. Review the preview again.",
  FINALIZATION_PREVIEW_STALE: "Attendance changed since the preview. Review the updated preview before finalizing.",
  FINALIZATION_INTEGRITY_ERROR: "The finalized register is inconsistent. Please contact support.",
  INTERNAL_SERVER_ERROR: "Something went wrong on the server. Please try again.",
  ATTENDANCE_APPROVAL_NOT_CONFIGURED: "Attendance is not configured on this server yet. Please contact the administrator.",
  ATTENDANCE_EVIDENCE_NOT_CONFIGURED: "Attendance is not configured on this server yet. Please contact the administrator.",
  ATTENDANCE_RECORD_CHANGED: "This student's attendance changed since the register was loaded. Refresh the register and review it before trying again.",
  ATTENDANCE_REASON_REQUIRED: "A reason is required for this change.",
  ATTENDANCE_NO_PENDING_REVIEW: "There is no evidence waiting for review for this student any more. Refresh the register.",
  ATTENDANCE_STUDENT_NOT_ENROLLED: "This student has never been enrolled in this lecture's class.",
  STUDENT_NOT_FOUND: "This student was not found, or is no longer active.",
  ATTENDANCE_REGISTER_CHANGED: "The attendance register changed since it was loaded. Refresh the register and review it before trying again.",
  ATTENDANCE_REGISTER_FINALIZED: "This attendance register is finalized, so it can no longer be changed.",
  NETWORK_ERROR: "Could not reach the server. Check your connection and try again.",
  INVALID_RESPONSE: "The server sent an unexpected response. Please try again.",
};

export function isKnownErrorCode(code: string): code is AttendanceApiErrorCode | ClientErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code);
}

/** A teacher-facing message for an error code (a generic one for unknown codes). */
export function attendanceErrorMessage(code: string): string {
  return isKnownErrorCode(code) ? ERROR_MESSAGES[code] : "The request could not be completed.";
}

/** What the UI should offer after an error (the code decides; the message is only for display). */
export type AttendanceErrorAction =
  | "RETRY"
  | "RELOAD_PREVIEW"
  | "RECONCILE"
  | "END_SESSION"
  | "SIGN_IN"
  | "RELOAD_PAGE"
  | "CONTACT_SUPPORT"
  /** The record moved on the server (Stage 5.6): reload the register, then decide again (never retried automatically). */
  | "REFRESH_REGISTER"
  | "NONE";

export function attendanceErrorAction(code: string): AttendanceErrorAction {
  switch (code) {
    case "ATTENDANCE_BUSY":
    case "NETWORK_ERROR":
    case "INTERNAL_SERVER_ERROR":
    case "INVALID_RESPONSE":
      return "RETRY";
    case "FINALIZATION_PREVIEW_STALE":
    case "FINALIZATION_CANDIDATES_CHANGED":
      return "RELOAD_PREVIEW";
    case "FINALIZATION_EVIDENCE_PENDING":
      return "RECONCILE";
    case "ATTENDANCE_RECORD_CHANGED":
    case "ATTENDANCE_NO_PENDING_REVIEW":
    case "ATTENDANCE_REGISTER_CHANGED":
    case "ATTENDANCE_REGISTER_FINALIZED":
      return "REFRESH_REGISTER";
    case "FINALIZATION_SESSION_ACTIVE":
      return "END_SESSION";
    case "UNAUTHORIZED":
      return "SIGN_IN";
    case "CROSS_ORIGIN_REQUEST_REJECTED":
    case "VALIDATION_ERROR":
    case "INVALID_JSON":
      return "RELOAD_PAGE";
    case "FINALIZATION_INTEGRITY_ERROR":
    case "ATTENDANCE_APPROVAL_NOT_CONFIGURED":
    case "ATTENDANCE_EVIDENCE_NOT_CONFIGURED":
      return "CONTACT_SUPPORT";
    default:
      return "NONE";
  }
}

const BLOCKER_MESSAGES: Record<FinalizationBlocker, string> = {
  ALREADY_FINALIZED: "Attendance for this lecture is already finalized.",
  LECTURE_CANCELLED: "This lecture is cancelled; there is no attendance to finalize.",
  LECTURE_NOT_STARTED: "The lecture has not started yet.",
  SCHEDULED_END_NOT_PASSED: "The lecture has not ended yet. Mark it completed or wait for the scheduled end.",
  COMPLETION_REQUIRED: "This lecture has no end time. Mark it completed before finalizing.",
  SESSION_ACTIVE: "A live class session is still running. End it before finalizing.",
  EVIDENCE_PENDING: "Some online attendance is not recorded yet. Reconcile online evidence first.",
  UNKNOWN_EVIDENCE: "Some students joined online while their approval is unknown. Decide their attendance first.",
  ROSTER_LIMIT_EXCEEDED: "This class has more than 500 students; it cannot be finalized in one step.",
};

export function finalizationBlockerMessage(blocker: string): string {
  return Object.prototype.hasOwnProperty.call(BLOCKER_MESSAGES, blocker)
    ? BLOCKER_MESSAGES[blocker as FinalizationBlocker]
    : "Finalization is blocked.";
}

// =========================================================================================
// 4. Online evidence reconciliation loop
// =========================================================================================

export const RECONCILE_DEFAULT_PAGE_SIZE = 100;
export const RECONCILE_MAX_PAGE_SIZE = 500;

export type ReconcileProgress = {
  /** 1-based pass number (a new pass starts without a cursor). */
  pass: number;
  /** Pages so far in this pass / in total. */
  pageInPass: number;
  pages: number;
  /** Counts over every page of every pass. */
  totals: ReconcileCounts;
  page: ReconcilePage;
};

export type ReconcileOutcome =
  /** A whole pass ran without busy students (the evidence gate at finalization stays authoritative). */
  | { status: "COMPLETE"; passes: number; pages: number; totals: ReconcileCounts }
  | {
      status: "INCOMPLETE";
      reason: "BUSY_REMAINING" | "LECTURE_CHANGED" | "NO_PROGRESS" | "PAGE_LIMIT" | "ABORTED";
      passes: number;
      pages: number;
      totals: ReconcileCounts;
    }
  | { status: "FAILED"; error: AttendanceApiError; passes: number; pages: number; totals: ReconcileCounts };

export type ReconcileOptions = {
  /** Students per page: default 100, clamped to 1–500. */
  pageSize?: number;
  /** Fresh passes allowed when busy students remain (default 3). */
  maxPasses?: number;
  /** Safety limit per pass (default 200 pages). */
  maxPagesPerPass?: number;
  /** Pause before a fresh pass after busy students (default 1500 ms; tests pass 0). */
  busyRetryDelayMs?: number;
  onProgress?: (progress: ReconcileProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** Tests: replaces the pause. */
  wait?: (ms: number) => Promise<void>;
};

const zeroCounts = (): ReconcileCounts => ({
  processed: 0, applied: 0, duplicates: 0, ineligible: 0, unknown: 0, inactive: 0, finalizedWithoutRecord: 0, busy: 0, skipped: 0,
});
const COUNT_KEYS = Object.keys(zeroCounts()) as (keyof ReconcileCounts)[];

/** The page as sent, or null when it does not have the documented shape (never trusted blindly). */
function readPage(data: unknown): ReconcilePage | null {
  if (!isObject(data)) return null;
  for (const key of COUNT_KEYS) {
    const value = data[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  }
  if (data.nextCursor !== null && (typeof data.nextCursor !== "string" || data.nextCursor === "")) return null;
  if (data.stoppedBecause !== null && data.stoppedBecause !== "LECTURE_CHANGED") return null;
  if (typeof data.lectureId !== "string") return null;
  return data as unknown as ReconcilePage;
}

export function clampReconcilePageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return RECONCILE_DEFAULT_PAGE_SIZE;
  return Math.min(RECONCILE_MAX_PAGE_SIZE, Math.max(1, Math.floor(value)));
}

/**
 * Runs reconciliation passes: from no cursor, following nextCursor until it
 * is null. A pass that met busy students is followed by a fresh pass without
 * a cursor (up to maxPasses). Stops, never claiming completion, on an API
 * error (FAILED), a lecture that changed, a cursor that repeats or does not
 * move, a page that processed nothing but points further, the page limit,
 * or an abort (INCOMPLETE). COMPLETE only when the last pass ended with no
 * busy student.
 */
export async function runReconciliation(lectureId: string, options: ReconcileOptions = {}): Promise<ReconcileOutcome> {
  const pageSize = clampReconcilePageSize(options.pageSize);
  const maxPasses = Math.max(1, Math.floor(options.maxPasses ?? 3));
  const maxPagesPerPass = Math.max(1, Math.floor(options.maxPagesPerPass ?? 200));
  const delayMs = Math.max(0, options.busyRetryDelayMs ?? 1500);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const totals = zeroCounts();
  let pages = 0;
  const incomplete = (reason: Extract<ReconcileOutcome, { status: "INCOMPLETE" }>["reason"], passes: number): ReconcileOutcome => ({
    status: "INCOMPLETE",
    reason,
    passes,
    pages,
    totals: { ...totals },
  });

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (pass > 1 && delayMs > 0) await wait(delayMs);
    let cursor: string | null = null;
    const seen = new Set<string>();
    let passBusy = 0;
    let pageInPass = 0;

    for (;;) {
      if (options.signal?.aborted) return incomplete("ABORTED", pass);
      if (pageInPass >= maxPagesPerPass) return incomplete("PAGE_LIMIT", pass);

      const result = await reconcilePage(lectureId, { cursor, limit: pageSize }, { signal: options.signal, fetchImpl: options.fetchImpl });
      if (!result.ok) {
        if (options.signal?.aborted) return incomplete("ABORTED", pass);
        return { status: "FAILED", error: result, passes: pass, pages, totals: { ...totals } };
      }
      const page = readPage(result.data);
      if (!page) {
        return {
          status: "FAILED",
          error: { ok: false, status: result.status, code: "INVALID_RESPONSE", message: attendanceErrorMessage("INVALID_RESPONSE") },
          passes: pass,
          pages,
          totals: { ...totals },
        };
      }

      pages += 1;
      pageInPass += 1;
      for (const key of COUNT_KEYS) totals[key] += page[key];
      passBusy += page.busy;
      options.onProgress?.({ pass, pageInPass, pages, totals: { ...totals }, page });

      if (page.stoppedBecause === "LECTURE_CHANGED") return incomplete("LECTURE_CHANGED", pass);
      if (page.nextCursor === null) break;
      if (page.nextCursor === cursor || seen.has(page.nextCursor) || page.processed === 0) return incomplete("NO_PROGRESS", pass);
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    if (passBusy === 0) return { status: "COMPLETE", passes: pass, pages, totals: { ...totals } };
    if (pass === maxPasses) return incomplete("BUSY_REMAINING", pass);
  }
  return incomplete("BUSY_REMAINING", maxPasses);
}

// =========================================================================================
// 5. Teacher decisions, evidence reviews and history (Stage 5.6c)
// =========================================================================================

export type TeacherAttendanceStatus = "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";
export const TEACHER_ATTENDANCE_STATUSES: readonly TeacherAttendanceStatus[] = ["PRESENT", "LATE", "ABSENT", "EXCUSED"];
export type ReviewAction = "ACCEPT" | "DISMISS";

/** POST .../students/[studentId]/decision `data` (lib/attendance-http.ts decisionResponse). */
export type DecisionResponse = {
  lectureId: string;
  studentId: string;
  status: TeacherAttendanceStatus;
  statusSource: "TEACHER";
  teacherStatus: TeacherAttendanceStatus;
  autoStatus: "PRESENT" | "LATE" | null;
  pendingReview: boolean;
  version: number;
  afterFinalization: boolean;
  /** False: the teacher had already decided this status (nothing written). */
  changed: boolean;
};

/** POST .../students/[studentId]/review `data` (lib/attendance-http.ts reviewResponse). */
export type ReviewResponse = {
  lectureId: string;
  studentId: string;
  action: ReviewAction;
  status: TeacherAttendanceStatus;
  statusSource: string;
  teacherStatus: TeacherAttendanceStatus | null;
  autoStatus: "PRESENT" | "LATE" | null;
  pendingReview: boolean;
  version: number;
};

/** An audit actor as the history routes return it (no ids). */
export type HistoryActor = { role: "TEACHER" | "SYSTEM"; isCurrentTeacher: boolean };

type Change<T> = { from: T | null; to: T | null };

export type RegisterHistoryEntry = {
  version: number;
  action: "CREATED" | "GRACE_CHANGED" | "SCHEDULE_SYNCED" | "FINALIZED";
  at: string;
  actor: HistoryActor;
  reason: string | null;
  graceMinutes: Change<number> | null;
  scheduledStartAt: Change<string> | null;
  scheduledEndAt: Change<string> | null;
  finalization: { finalizedAt: string | null; eligibleCount: number | null; unknownEligibilityCount: number | null; absentCreatedCount: number | null } | null;
  recalculatedCount: number | null;
};

/** GET /api/lectures/[id]/attendance/history `data` (lib/attendance-http.ts registerHistoryResponse). */
export type RegisterHistoryResponse = {
  lectureId: string;
  registerExists: boolean;
  registerVersion: number;
  qrClosure: { closedAt: string; actor: HistoryActor } | null;
  entries: RegisterHistoryEntry[];
  nextCursor: string | null;
};

export type StudentHistoryEntry = {
  version: number;
  action:
    | "CREATED_AUTO"
    | "AUTO_UPDATED"
    | "AUTO_RECALCULATED"
    | "EVIDENCE_RECORDED"
    | "TEACHER_SET"
    | "EVIDENCE_ACCEPTED"
    | "EVIDENCE_DISMISSED"
    | "FINALIZE_ABSENT"
    | "BACKFILL";
  at: string;
  actor: HistoryActor;
  reason: string | null;
  afterFinalization: boolean;
  status: { from: TeacherAttendanceStatus | null; to: TeacherAttendanceStatus };
  teacherStatus: Change<TeacherAttendanceStatus>;
  autoStatus: Change<TeacherAttendanceStatus>;
  cause: "QR_SCAN" | "ONLINE_VISIT" | "REGISTER_CHANGE" | null;
};

/** GET .../students/[studentId]/history `data` (lib/attendance-http.ts studentHistoryResponse). */
export type StudentHistoryResponse = {
  lectureId: string;
  studentId: string;
  recordExists: boolean;
  record: { status: TeacherAttendanceStatus; statusSource: "AUTO" | "TEACHER" | "FINALIZATION" | "BACKFILL"; version: number; pendingReview: boolean } | null;
  entries: StudentHistoryEntry[];
  nextCursor: string | null;
};

// ---- Reasons (UX only: the server and the database stay authoritative) ----------------------

/** The services' limit (services/lecture-attendance-evidence-service.ts MAX_REASON_LENGTH), after trimming. */
export const ATTENDANCE_REASON_MAX_LENGTH = 500;

export type ReasonRequirement = "REQUIRED" | "OPTIONAL";

/**
 * Whether a teacher decision needs a reason (teacherDecisionRequiresReason /
 * AttendanceAuditLog_reason_check): required when the student already has a
 * record (even to confirm its current status) or the register is finalized
 * (even a first mark); optional only for a first mark on an open register.
 */
export function decisionReasonRequirement(input: { hasRecord: boolean; finalized: boolean }): ReasonRequirement {
  return input.hasRecord || input.finalized ? "REQUIRED" : "OPTIONAL";
}

/** ACCEPT always replaces an existing status (required); DISMISS changes no status (optional). */
export function reviewReasonRequirement(action: ReviewAction): ReasonRequirement {
  return action === "ACCEPT" ? "REQUIRED" : "OPTIONAL";
}

export type ReasonProblem = "REQUIRED" | "TOO_LONG";
export type ReasonCheck = { ok: true; reason: string | null } | { ok: false; problem: ReasonProblem };

/**
 * The services' normalization (normalizeReason): trimmed; blank is no
 * reason; more than 500 characters after trimming is refused; a required
 * reason must then be present.
 */
export function checkAttendanceReason(raw: string | null | undefined, requirement: ReasonRequirement): ReasonCheck {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length > ATTENDANCE_REASON_MAX_LENGTH) return { ok: false, problem: "TOO_LONG" };
  if (reason === "") return requirement === "REQUIRED" ? { ok: false, problem: "REQUIRED" } : { ok: true, reason: null };
  return { ok: true, reason };
}

export function reasonProblemMessage(problem: ReasonProblem): string {
  return problem === "REQUIRED" ? "Enter a reason for this change." : `The reason must be at most ${ATTENDANCE_REASON_MAX_LENGTH} characters.`;
}

// ---- API helpers ----------------------------------------------------------------------------

const studentPath = (lectureId: string, studentId: string) => `${lecturePath(lectureId)}/students/${encodeURIComponent(studentId)}`;

export type DecisionRequest = {
  status: TeacherAttendanceStatus;
  /** The record version from the loaded register (null: the student had no record). Never invented. */
  expectedVersion: number | null;
  reason?: string | null;
};

/** POST .../decision. The reason is sent trimmed (blank: null); the server decides whether it is required. */
export function submitAttendanceDecision(lectureId: string, studentId: string, request: DecisionRequest, options: CallOptions = {}) {
  return attendanceRequest<DecisionResponse>(`${studentPath(lectureId, studentId)}/decision`, {
    ...options,
    method: "POST",
    body: { status: request.status, expectedVersion: request.expectedVersion, reason: request.reason?.trim() || null },
  });
}

export type ReviewRequest = { action: ReviewAction; expectedVersion: number; reason?: string | null };

/** POST .../review. */
export function submitAttendanceReview(lectureId: string, studentId: string, request: ReviewRequest, options: CallOptions = {}) {
  return attendanceRequest<ReviewResponse>(`${studentPath(lectureId, studentId)}/review`, {
    ...options,
    method: "POST",
    body: { action: request.action, expectedVersion: request.expectedVersion, reason: request.reason?.trim() || null },
  });
}

export const HISTORY_DEFAULT_PAGE_SIZE = 50;
export const HISTORY_MAX_PAGE_SIZE = 100;

export type HistoryPageRequest = { cursor?: string | null; limit?: number | null };

/** limit 1–100 (default 50); the cursor exactly as the server gave it (omitted for the first page). */
export function buildHistoryQuery(page: HistoryPageRequest = {}): string {
  const params = new URLSearchParams();
  if (page.cursor !== undefined && page.cursor !== null) params.set("cursor", page.cursor);
  const limit = page.limit ?? HISTORY_DEFAULT_PAGE_SIZE;
  params.set("limit", String(Number.isFinite(limit) ? Math.min(HISTORY_MAX_PAGE_SIZE, Math.max(1, Math.floor(limit))) : HISTORY_DEFAULT_PAGE_SIZE));
  return params.toString();
}

/** GET .../attendance/history (one page). */
export function fetchRegisterHistory(lectureId: string, page: HistoryPageRequest = {}, options: CallOptions = {}) {
  return attendanceRequest<RegisterHistoryResponse>(`${lecturePath(lectureId)}/history?${buildHistoryQuery(page)}`, options);
}

/** GET .../students/[studentId]/history (one page). */
export function fetchStudentHistory(lectureId: string, studentId: string, page: HistoryPageRequest = {}, options: CallOptions = {}) {
  return attendanceRequest<StudentHistoryResponse>(`${studentPath(lectureId, studentId)}/history?${buildHistoryQuery(page)}`, options);
}

// =========================================================================================
// 6. Grace period (Stage 5.7b-2b-3)
// =========================================================================================

/** POST .../attendance/grace `data` (lib/attendance-http.ts graceResponse). */
export type GraceResponse = {
  lectureId: string;
  graceMinutes: number;
  /** 0: still no register (a no-op before any register exists). */
  registerVersion: number;
  /** False: nothing was written (the value was already in effect). */
  changed: boolean;
  registerCreated: boolean;
  recalculatedCount: number;
};

export type GraceRequest = {
  graceMinutes: number;
  /** The register version from the loaded register (0: no register yet). Never invented. */
  expectedVersion: number;
  reason?: string | null;
};

/** POST .../attendance/grace. The reason is sent trimmed (blank: null); the server decides whether it is required. */
export function submitRegisterGrace(lectureId: string, request: GraceRequest, options: CallOptions = {}) {
  return attendanceRequest<GraceResponse>(`${lecturePath(lectureId)}/grace`, {
    ...options,
    method: "POST",
    body: { graceMinutes: request.graceMinutes, expectedVersion: request.expectedVersion, reason: request.reason?.trim() || null },
  });
}

/** The database CHECK's range and the class default (lib/attendance/status.ts, the server's own constants). */
export const GRACE_MINUTES_MIN = MIN_ATTENDANCE_GRACE_MINUTES;
export const GRACE_MINUTES_MAX = MAX_ATTENDANCE_GRACE_MINUTES;
export const GRACE_MINUTES_DEFAULT = DEFAULT_ATTENDANCE_GRACE_MINUTES;

export type GraceInputProblem = "REQUIRED" | "NOT_WHOLE_NUMBER" | "OUT_OF_RANGE";
export type GraceInputCheck = { ok: true; value: number } | { ok: false; problem: GraceInputProblem };

/**
 * A grace period typed by the teacher (an input's text): whole minutes from
 * 0 to 240 (0 is valid). Leading / trailing spaces are ignored; anything else
 * (decimals, signs, exponents, letters) is refused. UX only: the server
 * validates again.
 */
export function parseGraceMinutesInput(raw: string): GraceInputCheck {
  const text = raw.trim();
  if (text === "") return { ok: false, problem: "REQUIRED" };
  if (!/^\d+$/.test(text)) return { ok: false, problem: "NOT_WHOLE_NUMBER" };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < GRACE_MINUTES_MIN || value > GRACE_MINUTES_MAX) return { ok: false, problem: "OUT_OF_RANGE" };
  return { ok: true, value };
}

export function graceInputProblemMessage(problem: GraceInputProblem): string {
  if (problem === "REQUIRED") return "Enter the attendance grace period in minutes.";
  if (problem === "NOT_WHOLE_NUMBER") return "The attendance grace period must be a whole number of minutes.";
  return `The attendance grace period must be from ${GRACE_MINUTES_MIN} to ${GRACE_MINUTES_MAX} minutes.`;
}

/**
 * What to tell the teacher after a successful call, from the server's
 * answer only: an effective change reports how many records were
 * recalculated; a no-op never claims a recalculation.
 */
export function graceResultMessage(result: GraceResponse): string {
  if (!result.changed) return `The grace period is already ${result.graceMinutes} minutes. Nothing was changed.`;
  const records =
    result.recalculatedCount === 0
      ? "No attendance record needed recalculation."
      : `${result.recalculatedCount} attendance record${result.recalculatedCount === 1 ? " was" : "s were"} recalculated.`;
  return `Grace period changed to ${result.graceMinutes} minutes. ${records}`;
}
