/*
 * Shared HTTP helpers for the lecture attendance API routes
 * (app/api/lectures/[id]/attendance/**). Server only. See
 * docs/lecture-attendance.md ("Attendance API (Stage 5.5c)").
 *
 * Authentication, ownership, error mapping and responses stay with the
 * existing utilities (requireTeacherSession, the services, handleRouteError,
 * apiSuccess); this module only adds what the attendance routes share:
 * no-store headers, the generic same-origin rejection, lecture-id and JSON
 * body parsing, the request bodies' schemas, and the one structured operator
 * log for FINALIZATION_INTEGRITY_ERROR.
 */

import { z } from "zod";

import { apiError } from "@/lib/api-response";
import { attendanceError } from "@/lib/attendance/service-errors";
import { MAX_ATTENDANCE_GRACE_MINUTES, MIN_ATTENDANCE_GRACE_MINUTES } from "@/lib/attendance/status";
import { AppError } from "@/lib/error-handler";
import type { SameOriginDecision } from "@/lib/same-origin";

/** Private, never stored by browsers, proxies or CDNs (the attendance data of the teacher's students). */
export const ATTENDANCE_NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};

export function withNoStore(response: Response): Response {
  for (const [name, value] of Object.entries(ATTENDANCE_NO_STORE_HEADERS)) response.headers.set(name, value);
  return response;
}

const ORIGIN_WARNING_INTERVAL_MS = 10 * 60_000;
let lastOriginWarning = -Infinity;

/**
 * 403 CROSS_ORIGIN_REQUEST_REJECTED for a POST that failed
 * checkSameOriginRequest (lib/same-origin.ts). A missing APP_URL /
 * NEXT_PUBLIC_APP_URL is reported to operators at most every 10 minutes
 * (the setting's name, never a value).
 */
export function attendanceCrossOriginRejected(decision: Exclude<SameOriginDecision, { allowed: true }>): Response {
  if (decision.reason === "origin-not-configured") {
    const now = Date.now();
    if (now - lastOriginWarning >= ORIGIN_WARNING_INTERVAL_MS) {
      lastOriginWarning = now;
      console.warn("[attendance] Request refused: set APP_URL or NEXT_PUBLIC_APP_URL to the application's public origin.");
    }
  }
  return withNoStore(apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED"));
}

/**
 * The lecture id of the route (existing lecture API convention, D2):
 * trimmed, non-empty, at most 191 characters; no format check (the service
 * answers 404 for an unknown lecture or another teacher's).
 */
export function parseLectureId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (id === "") throw new AppError("Lecture id is required.", 400, "VALIDATION_ERROR", { field: "lectureId" });
  if (id.length > 191) throw new AppError("Lecture id is too long.", 400, "VALIDATION_ERROR", { field: "lectureId" });
  return id;
}

/**
 * The student id of a student route (Stage 5.6a), with the lecture id's
 * rules: trimmed, non-empty, at most 191 characters; no format check (the
 * service answers 404 for an unknown, another teacher's, an inactive or a
 * deleted student).
 */
export function parseStudentId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (id === "") throw new AppError("Student id is required.", 400, "VALIDATION_ERROR", { field: "studentId" });
  if (id.length > 191) throw new AppError("Student id is too long.", 400, "VALIDATION_ERROR", { field: "studentId" });
  return id;
}

/**
 * The JSON body. Invalid JSON throws SyntaxError (handleRouteError: 400
 * INVALID_JSON). An empty body is `{}` only when `allowEmpty`.
 */
export async function readJsonBody(request: Request, { allowEmpty }: { allowEmpty: boolean }): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") {
    if (allowEmpty) return {};
    throw new SyntaxError("Empty JSON body.");
  }
  return JSON.parse(text) as unknown;
}

const CONTENT_LENGTH_PATTERN = /^[0-9]{1,15}$/;
const invalidContentLength = () => attendanceError("VALIDATION_ERROR", { field: "content-length" });

/**
 * The JSON body, read with a hard byte cap (Stage 5.7b-3c; the QR routes).
 * request.text() would buffer a body of any size; here:
 *  1. a Content-Length header must be plain decimal digits (no sign, list,
 *     inner spaces or exponent; otherwise 400 VALIDATION_ERROR, field
 *     "content-length"), and one over `maxBytes` is 413
 *     ATTENDANCE_REQUEST_TOO_LARGE before a byte is read;
 *  2. the body is read chunk by chunk and abandoned (the stream cancelled)
 *     as soon as more than `maxBytes` have arrived: 413, also without a
 *     Content-Length (chunked / streamed) or with a false, smaller one;
 *  3. a declared length that differs from the bytes received is 400
 *     VALIDATION_ERROR, field "content-length";
 *  4. the bytes must be valid UTF-8, then JSON (otherwise SyntaxError:
 *     handleRouteError's 400 INVALID_JSON); empty is `{}` only when
 *     `allowEmpty`.
 * Nothing of the body is logged or echoed.
 */
export async function readJsonBodyWithLimit(
  request: Request,
  { maxBytes, allowEmpty }: { maxBytes: number; allowEmpty: boolean }
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer.");

  const header = request.headers.get("content-length");
  let declared: number | null = null;
  if (header !== null) {
    const trimmed = header.trim();
    if (!CONTENT_LENGTH_PATTERN.test(trimmed)) throw invalidContentLength();
    declared = Number(trimmed);
    if (declared > maxBytes) throw attendanceError("ATTENDANCE_REQUEST_TOO_LARGE");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw attendanceError("ATTENDANCE_REQUEST_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (declared !== null && declared !== total) throw invalidContentLength();

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("The request body is not valid UTF-8.");
  }
  if (text.trim() === "") {
    if (allowEmpty) return {};
    throw new SyntaxError("Empty JSON body.");
  }
  return JSON.parse(text) as unknown;
}

/** Parses with a strict schema; a failure is 400 VALIDATION_ERROR with the first offending field (no values echoed). */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.code === "unrecognized_keys" ? "body" : String(issue?.path?.[0] ?? "body");
  throw attendanceError("VALIDATION_ERROR", { field });
}

/** D1: the API's default reconciliation page; the service's own limits (1–500) are unchanged. */
export const RECONCILE_API_DEFAULT_LIMIT = 100;
export const RECONCILE_API_MAX_LIMIT = 500;

/** POST /api/lectures/[id]/attendance/reconcile body (strict). */
export const reconcileBodySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(191)
      .refine((value) => value.trim() !== "")
      .nullable()
      .optional(),
    limit: z.number().int().min(1).max(RECONCILE_API_MAX_LIMIT).optional(),
  })
  .strict();

/** POST /api/lectures/[id]/attendance/finalize body (strict; the format is checked by the service: 400). */
export const finalizeBodySchema = z.object({ fingerprint: z.string() }).strict();

// ---- Teacher decisions and reviews (Stage 5.6a) -------------------------------------------------

const TEACHER_STATUSES = ["PRESENT", "LATE", "ABSENT", "EXCUSED"] as const;

/**
 * A version the client saw: a non-negative integer here; the services own the
 * rest (a record version is at least 1, so 0 is their 400 VALIDATION_ERROR,
 * field expectedVersion).
 */
const expectedVersionSchema = z.number().int().min(0);

/**
 * The teacher's reason: text or null, or absent. Trimming, the 500-character
 * limit and whether one is required are the services' rules (400
 * VALIDATION_ERROR field reason / ATTENDANCE_REASON_REQUIRED), backed by the
 * database's AttendanceAuditLog_reason_check.
 */
const reasonSchema = z.string().nullable().optional();

/**
 * POST /api/lectures/[id]/attendance/students/[studentId]/decision body
 * (strict: an unknown field, a teacher id included, is 400 field body).
 * expectedVersion is required: the record version the teacher saw, or null
 * when the student had no record.
 */
export const decisionBodySchema = z
  .object({
    status: z.enum(TEACHER_STATUSES),
    expectedVersion: expectedVersionSchema.nullable(),
    reason: reasonSchema,
  })
  .strict();

/**
 * POST /api/lectures/[id]/attendance/grace body (Stage 5.7b-2b-2, strict: an
 * unknown field, a teacher id included, is 400 field body). graceMinutes:
 * whole minutes 0–240; expectedVersion: the register version the teacher saw
 * (0 = no register yet); reason: the service's rule (trimmed, ≤ 500; required
 * when existing records are recalculated).
 */
export const graceBodySchema = z
  .object({
    graceMinutes: z.number().int().min(MIN_ATTENDANCE_GRACE_MINUTES).max(MAX_ATTENDANCE_GRACE_MINUTES),
    expectedVersion: expectedVersionSchema,
    reason: reasonSchema,
  })
  .strict();

type GraceServiceResult = {
  lectureId: string;
  graceMinutes: number;
  registerVersion: number;
  changed: boolean;
  registerCreated: boolean;
  recalculatedCount: number;
};

/** The grace response: an explicit field list (no register-audit or record ids). */
export function graceResponse(result: GraceServiceResult) {
  return {
    lectureId: result.lectureId,
    graceMinutes: result.graceMinutes,
    registerVersion: result.registerVersion,
    changed: result.changed,
    registerCreated: result.registerCreated,
    recalculatedCount: result.recalculatedCount,
  };
}

// ---- Physical QR attendance (Stage 5.7b-3b) ------------------------------------------------------

/** The scanner's retry key: the same id is the same scan (the service's own format). */
export const QR_CLIENT_SCAN_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** The longest scanned text accepted (a student QR is 50 characters: "SLCQR1:" + token). */
export const QR_SCAN_PAYLOAD_MAX_LENGTH = 128;

/**
 * POST /api/lectures/[id]/attendance/qr/scans body (strict). The payload is
 * any string up to 128 characters (an unrecognized one is still recorded as
 * INVALID_QR by the service); its value is never echoed: a refusal names
 * only the field.
 */
export const qrScanBodySchema = z
  .object({
    clientScanId: z.string().regex(QR_CLIENT_SCAN_ID_PATTERN),
    payload: z.string().max(QR_SCAN_PAYLOAD_MAX_LENGTH),
  })
  .strict();

/**
 * The scan route's body cap (bytes, Stage 5.7b-3c). The largest schema-valid
 * body in any legal compact JSON encoding is 959 bytes: both keys written
 * entirely as six-byte unicode escapes ((12 + 7) × 6), a 64-character
 * clientScanId (its characters never need escaping) and a 128-character
 * payload written entirely as six-byte escapes (128 × 6 = 768; raw UTF-8 is
 * at most 3 bytes per character). So 1 KiB never refuses a valid scan with
 * 413; a real scan body is about 110–150 bytes.
 */
export const QR_SCAN_MAX_BODY_BYTES = 1024;
/** The closure route's body cap: `{}` plus a little whitespace (for example "{ }" and a CRLF). */
export const QR_CLOSE_MAX_BODY_BYTES = 16;

/** POST /api/lectures/[id]/attendance/qr/close body: exactly {} (strict). */
export const qrCloseBodySchema = z.object({}).strict();

type QrScanServiceResult = {
  result: string;
  effect: string;
  replayed: boolean;
  receivedAt: Date;
  afterFinalization: boolean;
  student: { id: string; name: string; registrationNumber: string | null } | null;
  attendance: { status: string; statusSource: string; pendingReview: boolean } | null;
};

/**
 * The scan response: an explicit field list. Never the scan event id, a token
 * id or hash, the payload, or the record's version / row id.
 */
export function qrScanResponse(outcome: QrScanServiceResult) {
  return {
    result: outcome.result,
    effect: outcome.effect,
    replayed: outcome.replayed,
    receivedAt: outcome.receivedAt.toISOString(),
    afterFinalization: outcome.afterFinalization,
    student: outcome.student
      ? { studentId: outcome.student.id, name: outcome.student.name, registrationNumber: outcome.student.registrationNumber }
      : null,
    attendance: outcome.attendance
      ? { status: outcome.attendance.status, statusSource: outcome.attendance.statusSource, pendingReview: outcome.attendance.pendingReview }
      : null,
  };
}

type QrCloseServiceResult = { lectureId: string; closedAt: Date; closedByTeacherId: string; alreadyClosed: boolean };

/** The closure response: `closedByYou` instead of the closing teacher's id. */
export function qrCloseResponse(result: QrCloseServiceResult, sessionTeacherId: string) {
  return {
    lectureId: result.lectureId,
    closedAt: result.closedAt.toISOString(),
    alreadyClosed: result.alreadyClosed,
    closedByYou: result.closedByTeacherId === sessionTeacherId,
  };
}

/** POST /api/lectures/[id]/attendance/students/[studentId]/review body (strict). */
export const reviewBodySchema = z
  .object({
    action: z.enum(["ACCEPT", "DISMISS"]),
    expectedVersion: expectedVersionSchema,
    reason: reasonSchema,
  })
  .strict();

type DecisionServiceResult = {
  lectureId: string;
  studentId: string;
  status: string;
  statusSource: string;
  teacherStatus: string;
  autoStatus: string | null;
  pendingReview: boolean;
  version: number;
  afterFinalization: boolean;
  changed: boolean;
};

/** The decision response: an explicit field list (never the service object as such). */
export function decisionResponse(result: DecisionServiceResult) {
  return {
    lectureId: result.lectureId,
    studentId: result.studentId,
    status: result.status,
    statusSource: result.statusSource,
    teacherStatus: result.teacherStatus,
    autoStatus: result.autoStatus,
    pendingReview: result.pendingReview,
    version: result.version,
    afterFinalization: result.afterFinalization,
    changed: result.changed,
  };
}

type ReviewServiceResult = {
  studentId: string;
  status: string;
  statusSource: string;
  autoStatus: string | null;
  teacherStatus: string | null;
  pendingReviewSince: Date | null;
  version: number;
};

/** The review response: an explicit field list; the record's row id is never returned. */
export function reviewResponse(lectureId: string, action: "ACCEPT" | "DISMISS", result: ReviewServiceResult) {
  return {
    lectureId,
    studentId: result.studentId,
    action,
    status: result.status,
    statusSource: result.statusSource,
    teacherStatus: result.teacherStatus,
    autoStatus: result.autoStatus,
    pendingReview: result.pendingReviewSince !== null,
    version: result.version,
  };
}

/** A correlation id from the proxy, when it sends one that is safe to log. */
export function requestIdOf(request: Request): string | null {
  const value = request.headers.get("x-request-id");
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

export const FINALIZATION_INTEGRITY_EVENT = "attendance.finalization.integrity_error";

/**
 * D3: the one structured operator log line for FINALIZATION_INTEGRITY_ERROR:
 * event, code, lecture id, teacher id and the request id, nothing else (no
 * error details, body, student data, SQL, tokens or environment values).
 * Never throws.
 */
export function logFinalizationIntegrityEvent(input: { lectureId: string; teacherId: string; requestId: string | null }) {
  try {
    console.error(
      JSON.stringify({
        event: FINALIZATION_INTEGRITY_EVENT,
        level: "error",
        code: "FINALIZATION_INTEGRITY_ERROR",
        lectureId: input.lectureId,
        teacherId: input.teacherId,
        requestId: input.requestId,
        at: new Date().toISOString(),
      })
    );
  } catch {
    // Logging never breaks the response.
  }
}

// ---- Attendance history (Stage 5.6b) -------------------------------------------------------------

/**
 * The history routes' query: `cursor` and `limit`, each at most once.
 * `limit` must be decimal digits (1–100 is the service's rule: 400 field
 * limit otherwise); `cursor` is passed through unchanged for the service's
 * own format check (the previous page's nextCursor). Absent: null (the
 * service's defaults: first page, 50 entries). Other parameters are ignored
 * (the teacher never comes from the query).
 */
export function parseHistoryQuery(url: string): { cursor: string | null; limit: number | null } {
  const params = new URL(url).searchParams;
  const one = (name: "cursor" | "limit"): string | null => {
    const values = params.getAll(name);
    if (values.length > 1) throw attendanceError("VALIDATION_ERROR", { field: name });
    return values.length === 1 ? values[0] : null;
  };
  const cursor = one("cursor");
  const rawLimit = one("limit");
  if (rawLimit !== null && !/^[0-9]{1,4}$/.test(rawLimit)) throw attendanceError("VALIDATION_ERROR", { field: "limit" });
  return { cursor, limit: rawLimit === null ? null : Number(rawLimit) };
}

type HistoryServiceActor = { role: "SYSTEM"; teacherId: null } | { role: "TEACHER"; teacherId: string };

/**
 * An audit actor without its database id: SYSTEM, or a TEACHER flagged as
 * the signed-in teacher (the only teacher who can act on the lecture's
 * attendance) or not.
 */
function historyActor(actor: HistoryServiceActor, sessionTeacherId: string) {
  return actor.role === "TEACHER"
    ? { role: "TEACHER" as const, isCurrentTeacher: actor.teacherId === sessionTeacherId }
    : { role: "SYSTEM" as const, isCurrentTeacher: false };
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);
const isoPair = (pair: { from: Date | null; to: Date | null } | null) => (pair ? { from: iso(pair.from), to: iso(pair.to) } : null);

type RegisterHistoryServicePage = {
  lectureId: string;
  registerExists: boolean;
  registerVersion: number;
  qrClosure: { closedAt: Date; actor: HistoryServiceActor } | null;
  entries: {
    version: number;
    action: string;
    at: Date;
    actor: HistoryServiceActor;
    reason: string | null;
    graceMinutes: { from: number | null; to: number | null } | null;
    scheduledStartAt: { from: Date | null; to: Date | null } | null;
    scheduledEndAt: { from: Date | null; to: Date | null } | null;
    finalization: { finalizedAt: Date | null; eligibleCount: number | null; unknownEligibilityCount: number | null; absentCreatedCount: number | null } | null;
    recalculatedCount: number | null;
  }[];
  nextCursor: string | null;
};

/** GET .../attendance/history: an explicit field list (UTC ISO dates; no row or teacher ids). */
export function registerHistoryResponse(page: RegisterHistoryServicePage, sessionTeacherId: string) {
  return {
    lectureId: page.lectureId,
    registerExists: page.registerExists,
    registerVersion: page.registerVersion,
    qrClosure: page.qrClosure ? { closedAt: page.qrClosure.closedAt.toISOString(), actor: historyActor(page.qrClosure.actor, sessionTeacherId) } : null,
    entries: page.entries.map((entry) => ({
      version: entry.version,
      action: entry.action,
      at: entry.at.toISOString(),
      actor: historyActor(entry.actor, sessionTeacherId),
      reason: entry.reason,
      graceMinutes: entry.graceMinutes ? { from: entry.graceMinutes.from, to: entry.graceMinutes.to } : null,
      scheduledStartAt: isoPair(entry.scheduledStartAt),
      scheduledEndAt: isoPair(entry.scheduledEndAt),
      finalization: entry.finalization
        ? {
            finalizedAt: iso(entry.finalization.finalizedAt),
            eligibleCount: entry.finalization.eligibleCount,
            unknownEligibilityCount: entry.finalization.unknownEligibilityCount,
            absentCreatedCount: entry.finalization.absentCreatedCount,
          }
        : null,
      recalculatedCount: entry.recalculatedCount,
    })),
    nextCursor: page.nextCursor,
  };
}

type StudentHistoryServicePage = {
  lectureId: string;
  studentId: string;
  recordExists: boolean;
  record: { status: string; statusSource: string; version: number; pendingReview: boolean } | null;
  entries: {
    version: number;
    action: string;
    at: Date;
    actor: HistoryServiceActor;
    reason: string | null;
    afterFinalization: boolean;
    status: { from: string | null; to: string };
    teacherStatus: { from: string | null; to: string | null };
    autoStatus: { from: string | null; to: string | null };
    cause: string | null;
  }[];
  nextCursor: string | null;
};

/** GET .../attendance/students/[studentId]/history: an explicit field list (UTC ISO dates; no row or teacher ids). */
export function studentHistoryResponse(page: StudentHistoryServicePage, sessionTeacherId: string) {
  return {
    lectureId: page.lectureId,
    studentId: page.studentId,
    recordExists: page.recordExists,
    record: page.record
      ? { status: page.record.status, statusSource: page.record.statusSource, version: page.record.version, pendingReview: page.record.pendingReview }
      : null,
    entries: page.entries.map((entry) => ({
      version: entry.version,
      action: entry.action,
      at: entry.at.toISOString(),
      actor: historyActor(entry.actor, sessionTeacherId),
      reason: entry.reason,
      afterFinalization: entry.afterFinalization,
      status: { from: entry.status.from, to: entry.status.to },
      teacherStatus: { from: entry.teacherStatus.from, to: entry.teacherStatus.to },
      autoStatus: { from: entry.autoStatus.from, to: entry.autoStatus.to },
      cause: entry.cause,
    })),
    nextCursor: page.nextCursor,
  };
}
