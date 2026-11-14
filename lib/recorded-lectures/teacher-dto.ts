import type { RecordedLecture, RecordingUploadSession } from "@prisma/client";

import { byteCountToNumber } from "./bigint";
import { MP4_REJECTION_MESSAGES, type Mp4RejectionCode } from "./mp4-inspect";
import { assertClientSafe } from "./upload-dto";

/*
 * Teacher-facing recorded lecture DTO (Recorded Lectures, teacher
 * management). The teacher OWNS these recordings, so it may see more than a
 * student (its own original file name, every state, the failure reason, the
 * upload's progress), but never storage internals: no stored file name,
 * key or path, no lease token, no session version, no teacher / class id.
 * An explicit allow-list, checked by assertClientSafe (FORBIDDEN_DTO_KEYS).
 */

export type TeacherRecordingRow = Pick<
  RecordedLecture,
  | "id"
  | "lectureId"
  | "title"
  | "partNumber"
  | "displayFileName"
  | "sizeBytes"
  | "durationSeconds"
  | "width"
  | "height"
  | "state"
  | "failureCode"
  | "createdAt"
  | "readyAt"
  | "failedAt"
> & {
  uploadSession: Pick<RecordingUploadSession, "id" | "state" | "receivedBytes" | "expectedBytes" | "expiresAt" | "lastActivityAt"> | null;
};

export type TeacherRecordingUploadDto = {
  uploadId: string;
  uploadState: RecordingUploadSession["state"];
  receivedBytes: number;
  expectedBytes: number;
  expiresAt: string;
};

export type TeacherRecordingDto = {
  id: string;
  lectureId: string;
  title: string;
  partNumber: number;
  /** The teacher's own original file name (display only). */
  fileName: string;
  sizeBytes: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  state: RecordedLecture["state"];
  failureCode: string | null;
  /** A fixed, teacher-readable explanation of failureCode (never a raw error). */
  failureMessage: string | null;
  createdAt: string;
  readyAt: string | null;
  failedAt: string | null;
  /** The upload session (null once there is none, e.g. a very old row). */
  upload: TeacherRecordingUploadDto | null;
  /** Owner-only preview path (READY only); authorised again on every request. */
  previewUrl: string | null;
};

const FAILURE_MESSAGES: Record<string, string> = {
  UPLOAD_CANCELLED: "The upload was cancelled.",
  UPLOAD_EXPIRED: "The upload was not finished in time and expired.",
  DURATION_INVALID: "The video's duration could not be read, or it is longer than 48 hours.",
  DIMENSIONS_INVALID: "The video's picture size is not valid.",
  CHUNK_MISSING: "Part of the upload was missing. Please upload the video again.",
  CHUNK_SIZE_MISMATCH: "Part of the upload was damaged. Please upload the video again.",
  CHUNK_HASH_MISMATCH: "Part of the upload was damaged. Please upload the video again.",
  CHUNK_PLAN_INVALID: "The upload could not be put together. Please upload the video again.",
  ASSEMBLY_SIZE_MISMATCH: "The uploaded file could not be verified. Please upload it again.",
  ASSEMBLY_HASH_MISMATCH: "The uploaded file could not be verified. Please upload it again.",
};

/** A fixed message for a stored failure code; unknown codes get a generic text (never echoed). */
export function recordingFailureMessage(code: string | null): string | null {
  if (!code) return null;
  if (code.startsWith("MP4_")) {
    const mp4 = code.slice(4) as Mp4RejectionCode;
    return Object.hasOwn(MP4_REJECTION_MESSAGES, mp4) ? MP4_REJECTION_MESSAGES[mp4] : "The video could not be accepted.";
  }
  return FAILURE_MESSAGES[code] ?? "The recording could not be processed. Please upload it again.";
}

export function teacherPreviewPath(recordingId: string): string {
  return `/api/recorded-lectures/${encodeURIComponent(recordingId)}/stream`;
}

const iso = (date: Date | null | undefined): string | null => (date instanceof Date ? date.toISOString() : null);

export function buildTeacherRecordingDto(row: TeacherRecordingRow): TeacherRecordingDto {
  const session = row.uploadSession;
  const dto: TeacherRecordingDto = {
    id: row.id,
    lectureId: row.lectureId,
    title: row.title,
    partNumber: row.partNumber,
    fileName: row.displayFileName,
    sizeBytes: String(byteCountToNumber(row.sizeBytes, "sizeBytes")),
    durationSeconds: row.durationSeconds,
    width: row.width,
    height: row.height,
    state: row.state,
    failureCode: row.failureCode,
    failureMessage: recordingFailureMessage(row.failureCode),
    createdAt: row.createdAt.toISOString(),
    readyAt: iso(row.readyAt),
    failedAt: iso(row.failedAt),
    upload: session
      ? {
          uploadId: session.id,
          uploadState: session.state,
          receivedBytes: byteCountToNumber(session.receivedBytes, "receivedBytes"),
          expectedBytes: byteCountToNumber(session.expectedBytes, "expectedBytes"),
          expiresAt: session.expiresAt.toISOString(),
        }
      : null,
    previewUrl: row.state === "READY" ? teacherPreviewPath(row.id) : null,
  };
  assertClientSafe(dto);
  return dto;
}
