import type { RecordedLecture, RecordingUploadSession } from "@prisma/client";

import { byteCountToNumber } from "./bigint";
import { isLeaseCurrent, retryAfterSecondsForLease } from "./chunk-lease";
import type { RecordedLectureConfig } from "./config";
import { isCompletionClaimStale } from "./upload-locks";

/*
 * Recorded Lectures (RL-3.1): the upload APIs' response bodies.
 *
 * Every DTO is built field by field from an explicit allow-list (never by
 * spreading a database row), with bigint columns converted by bigint.ts
 * (fail closed). A DTO never contains: a bigint, a storage key or path, the
 * stored file name, a lease token / offset, a chunk checksum, or a teacher /
 * class id. assertClientSafe() checks the finished object for all of that
 * and is applied to every builder's result.
 */

/** Keys that must never appear anywhere in a client response. */
export const FORBIDDEN_DTO_KEYS: readonly string[] = [
  "teacherId",
  "classId",
  "deletedByTeacherId",
  "leaseToken",
  "leaseOffset",
  "leaseBytes",
  "leaseGrantedAt",
  "leaseExpiresAt",
  "storedFileName",
  "storageKey",
  "key",
  "path",
  "filePath",
  "sha256",
  "version",
];

const FORBIDDEN = new Set(FORBIDDEN_DTO_KEYS);

/** Throws unless `value` is plain JSON data (no bigint, function, Date...) without a forbidden key. */
export function assertClientSafe(value: unknown, at = "dto"): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${at}: not a finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClientSafe(item, `${at}[${index}]`));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN.has(key)) throw new TypeError(`${at}: forbidden key "${key}".`);
      assertClientSafe(item, `${at}.${key}`);
    }
    return;
  }
  throw new TypeError(`${at}: not plain JSON data (${typeof value}).`);
}

function checked<T>(dto: T): T {
  assertClientSafe(dto);
  return dto;
}

const iso = (date: Date | null | undefined): string | null => (date instanceof Date ? date.toISOString() : null);

// ---- Inputs (the columns each builder reads; no other column is touched) ----------------------------

export type UploadSessionDtoInput = Pick<
  RecordingUploadSession,
  | "id"
  | "state"
  | "expectedBytes"
  | "receivedBytes"
  | "chunkCount"
  | "failureCode"
  | "leaseToken"
  | "leaseBytes"
  | "leaseExpiresAt"
  | "expiresAt"
  | "lastActivityAt"
>;

export type RecordingDtoInput = Pick<
  RecordedLecture,
  | "id"
  | "lectureId"
  | "title"
  | "partNumber"
  | "state"
  | "failureCode"
  | "sizeBytes"
  | "durationSeconds"
  | "width"
  | "height"
  | "readyAt"
>;

// ---- Outputs ---------------------------------------------------------------------------------------------

export type UploadStatusDto = {
  uploadId: string;
  recordingId: string;
  lectureId: string;
  title: string;
  partNumber: number;
  uploadState: RecordingUploadSession["state"];
  recordingState: RecordedLecture["state"];
  expectedBytes: number;
  receivedBytes: number;
  chunkCount: number;
  /** The chunk size clients should send. */
  chunkBytes: number;
  expiresAt: string;
  /** Another request holds a current chunk lease. */
  chunkInProgress: boolean;
  /** Seconds until that lease expires (null without one). */
  retryAfterSeconds: number | null;
  failureCode: string | null;
  /**
   * COMPLETING only: the completion's heartbeat is stale (no progress for 10
   * minutes, e.g. the server restarted). The client should call complete
   * again, which takes the claim over and restarts the verification.
   */
  completionStalled: boolean;
};

export type ChunkAcceptedDto = {
  uploadId: string;
  receivedBytes: number;
  expectedBytes: number;
  chunkCount: number;
  /** Every byte has been received: the client may call complete. */
  complete: boolean;
};

export type CompletedRecordingDto = {
  recordingId: string;
  lectureId: string;
  title: string;
  partNumber: number;
  recordingState: RecordedLecture["state"];
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  readyAt: string | null;
};

// ---- Builders ---------------------------------------------------------------------------------------------

/** Start / status / cancel responses. `nowMs`: the server clock (serverNow), never the client's. */
export function buildUploadStatusDto(
  session: UploadSessionDtoInput,
  recording: RecordingDtoInput,
  config: Pick<RecordedLectureConfig, "chunkBytes">,
  nowMs: number
): UploadStatusDto {
  const leaseExpiresAtMs = session.leaseExpiresAt ? session.leaseExpiresAt.getTime() : null;
  const chunkInProgress = isLeaseCurrent({ leaseBytes: session.leaseBytes, leaseExpiresAtMs }, nowMs) && session.leaseToken !== null;

  return checked({
    uploadId: session.id,
    recordingId: recording.id,
    lectureId: recording.lectureId,
    title: recording.title,
    partNumber: recording.partNumber,
    uploadState: session.state,
    recordingState: recording.state,
    expectedBytes: byteCountToNumber(session.expectedBytes, "expectedBytes"),
    receivedBytes: byteCountToNumber(session.receivedBytes, "receivedBytes"),
    chunkCount: session.chunkCount,
    chunkBytes: config.chunkBytes,
    expiresAt: session.expiresAt.toISOString(),
    chunkInProgress,
    retryAfterSeconds: chunkInProgress && leaseExpiresAtMs !== null ? retryAfterSecondsForLease(leaseExpiresAtMs, nowMs) : null,
    failureCode: session.failureCode ?? recording.failureCode ?? null,
    completionStalled: session.state === "COMPLETING" && isCompletionClaimStale(session.lastActivityAt, nowMs),
  });
}

/** A committed chunk's response. */
export function buildChunkAcceptedDto(
  session: Pick<RecordingUploadSession, "id" | "expectedBytes" | "receivedBytes" | "chunkCount">
): ChunkAcceptedDto {
  const expectedBytes = byteCountToNumber(session.expectedBytes, "expectedBytes");
  const receivedBytes = byteCountToNumber(session.receivedBytes, "receivedBytes");
  return checked({
    uploadId: session.id,
    receivedBytes,
    expectedBytes,
    chunkCount: session.chunkCount,
    complete: receivedBytes === expectedBytes,
  });
}

/** The completed (READY) recording's response. */
export function buildCompletedRecordingDto(recording: RecordingDtoInput): CompletedRecordingDto {
  return checked({
    recordingId: recording.id,
    lectureId: recording.lectureId,
    title: recording.title,
    partNumber: recording.partNumber,
    recordingState: recording.state,
    sizeBytes: byteCountToNumber(recording.sizeBytes, "sizeBytes"),
    durationSeconds: recording.durationSeconds,
    width: recording.width,
    height: recording.height,
    readyAt: iso(recording.readyAt),
  });
}
