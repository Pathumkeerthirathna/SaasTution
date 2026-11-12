/**
 * Error codes of the attendance services: one table, so every caller answers
 * the same code with the same HTTP status and message. Services throw
 * AppError (lib/error-handler.ts); handleRouteError turns it into the usual
 * { success: false, message, code } response.
 *
 * Messages are fixed text: they never contain configuration values, SQL or
 * identifiers from the request.
 */

import { isRetryableLockError } from "@/lib/breakout-activities/errors";
import { AppError } from "@/lib/error-handler";

type ErrorSpec = { status: number; message: string };

export const ATTENDANCE_ERRORS = {
  // Validation
  VALIDATION_ERROR: { status: 400, message: "Invalid request." },
  ATTENDANCE_REASON_REQUIRED: { status: 400, message: "A reason is required for this change." },

  // A request body over the route's byte limit (Stage 5.7b-3c; the QR routes).
  ATTENDANCE_REQUEST_TOO_LARGE: { status: 413, message: "The request is too large." },

  // Not found (also used when the resource belongs to another teacher)
  LECTURE_NOT_FOUND: { status: 404, message: "Lecture not found." },
  STUDENT_NOT_FOUND: { status: 404, message: "Student not found." },

  // Conflicts
  ATTENDANCE_BUSY: { status: 409, message: "Attendance is being updated. Please try again." },
  ATTENDANCE_RECORD_CHANGED: { status: 409, message: "This attendance record was changed. Reload and try again." },
  ATTENDANCE_REGISTER_CHANGED: { status: 409, message: "The attendance register was changed. Reload and try again." },
  ATTENDANCE_REGISTER_FINALIZED: { status: 409, message: "The attendance register is finalized." },
  ATTENDANCE_NO_PENDING_REVIEW: { status: 409, message: "There is no evidence waiting for review." },
  FINALIZATION_NOT_ALLOWED: { status: 409, message: "The attendance register cannot be finalized yet." },
  FINALIZATION_SESSION_ACTIVE: { status: 409, message: "End the active class session before finalizing attendance." },
  FINALIZATION_PREVIEW_STALE: { status: 409, message: "Attendance changed since the preview. Review it again before finalizing." },
  FINALIZATION_EVIDENCE_PENDING: {
    status: 409,
    message: "Some online attendance is not recorded yet. Review those students before finalizing.",
  },
  LECTURE_CANCELLED: { status: 409, message: "This lecture is cancelled." },
  ATTENDANCE_LECTURE_HISTORICAL: {
    status: 409,
    message: "Automatic attendance is not available for this lecture. Mark attendance manually.",
  },
  // Finalization (Stage 5.5b).
  FINALIZATION_ROSTER_LIMIT_EXCEEDED: { status: 409, message: "This class has too many students to finalize attendance in one step." },
  FINALIZATION_CANDIDATES_CHANGED: { status: 409, message: "The class roster changed while finalizing. Review the preview again." },
  FINALIZATION_INTEGRITY_ERROR: { status: 500, message: "The finalized attendance register is inconsistent. Contact support." },
  // Historical backfill (operator only): the lecture is LIVE (automatic evidence applies).
  ATTENDANCE_LECTURE_LIVE: { status: 409, message: "Backfill is only available for lectures before automatic attendance started." },
  ATTENDANCE_SCAN_ID_REUSED: { status: 409, message: "This scan id was already used for a different scan." },
  ATTENDANCE_QR_NOT_OPEN: { status: 409, message: "QR attendance is not open yet for this lecture." },
  ATTENDANCE_QR_CLOSED: { status: 409, message: "QR attendance is closed for this lecture." },
  // Too many distinct QR scans from one teacher (Stage 5.7b-3b; the scan route
  // adds Retry-After). Nothing was recorded; the same scan id may be retried.
  ATTENDANCE_SCAN_RATE_LIMITED: { status: 429, message: "Too many scans. Wait a moment, then scan again." },
  ATTENDANCE_STUDENT_NOT_ENROLLED: { status: 409, message: "This student has never been enrolled in this class." },
  LECTURE_ATTENDANCE_FINALIZED: {
    status: 409,
    message: "This lecture's attendance is finalized, so the lecture cannot be cancelled or deleted.",
  },

  // Configuration (fail closed). The setting's name and status may be in
  // `details`; its value never is.
  ATTENDANCE_APPROVAL_NOT_CONFIGURED: { status: 503, message: "Attendance eligibility is not configured on this server." },
  ATTENDANCE_EVIDENCE_NOT_CONFIGURED: { status: 503, message: "Automatic attendance evidence is not configured on this server." },
  STUDENT_QR_NOT_CONFIGURED: { status: 503, message: "Student QR codes are not configured on this server." },
} as const satisfies Record<string, ErrorSpec>;

export type AttendanceErrorCode = keyof typeof ATTENDANCE_ERRORS;

export function attendanceError(code: AttendanceErrorCode, details?: unknown): AppError {
  const spec = ATTENDANCE_ERRORS[code];
  return new AppError(spec.message, spec.status, code, details);
}

/**
 * A lock timeout (55P03), deadlock (40P01) or serialization failure (40001)
 * from a raw lock statement becomes 409 ATTENDANCE_BUSY (safe to retry);
 * anything else is returned unchanged. Same classification as the session
 * start and the breakout services (isRetryableLockError).
 */
export function mapAttendanceLockError(error: unknown): unknown {
  return isRetryableLockError(error) ? attendanceError("ATTENDANCE_BUSY") : error;
}
