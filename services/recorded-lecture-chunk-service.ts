import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { isStorageError } from "@/lib/file-storage/types";
import { byteCountToBigint, byteCountToNumber } from "@/lib/recorded-lectures/bigint";
import { computeReservations, decideCapacity, retryAfterSecondsForLease } from "@/lib/recorded-lectures/chunk-lease";
import { sha256Passthrough } from "@/lib/recorded-lectures/chunk-stream";
import { chunkScratchKey, generateLeaseToken, isRecordedLectureId } from "@/lib/recorded-lectures/keys";
import { openRecordedLectureStorage } from "@/lib/recorded-lectures/storage";
import { buildChunkAcceptedDto, type ChunkAcceptedDto } from "@/lib/recorded-lectures/upload-dto";
import { chunkHeaderError, isDefiniteRollback, storageErrorToAppError, uploadError } from "@/lib/recorded-lectures/upload-errors";
import {
  getChunkWriterSlots,
  getUploadMutex,
  isUploadMutexTimeoutError,
  lockUploadCapacity,
  RECORDED_LECTURE_TRANSACTION_OPTIONS,
  setUploadLockTimeout,
  uploadMutexKey,
} from "@/lib/recorded-lectures/upload-locks";
import { parseChunkRequestHeaders } from "@/lib/recorded-lectures/validation";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import {
  assertLectureActiveForUpload,
  assertTeacherCanUpload,
  expireStaleUploads,
  loadConfig,
  reservationRows,
} from "@/services/recorded-lecture-upload-service";

/*
 * Recorded Lectures RL-3.3: one chunk of an upload
 * (PUT /api/recorded-lectures/uploads/[uploadId]/chunks).
 *
 * Option B (approved): every chunk is its own, never-modified file,
 *   System/TemporaryUploads/{uploadId}.{leaseToken}.chunk
 * (a fresh 256-bit lease token per chunk). There is no shared file that
 * several requests write: a stale writer (its lease expired and taken over,
 * in this or another process) can only ever write its OWN token file, which
 * nothing references unless its own commit succeeds, and that commit is
 * refused once the lease expired or changed. Committed chunk files are joined
 * once, at completion (RL-3.4).
 *
 * Sequence (each step's failures are mapped to upload errors):
 *   1. headers (Content-Type) and storage / configuration;
 *   2. the in-process upload mutex (bounded wait; this process only), then one
 *      of this process's chunk-writer slots (RL-3.5: at most 32, held until
 *      the request ends, so writers past their deadline stay bounded);
 *   3. transaction A: lock timeout, the caller's session + recording, the
 *      teacher account (D3) and the lecture / class (D4), lazy expiry, the
 *      chunk headers against the database's byte counts, a current lease of
 *      another request (409 + Retry-After), the capacity lock, the lease
 *      granted by a conditional update (state, offset, chunk count, version,
 *      upload expiry), then the reservation aggregate (candidate lease
 *      included), free space and the capacity decision;
 *   4. the body streamed into the token file (never collected in memory),
 *      SHA-256 computed on the way, exact byte count, a write deadline ahead of
 *      the lease expiry, then the file flushed, closed and its directory
 *      flushed (POSIX);
 *   5. transaction B: the teacher account and lecture / class again, then the
 *      RecordingUploadChunk row and the session's byte count, guarded by one
 *      conditional update: ACTIVE, upload not expired, the same lease token,
 *      the lease NOT expired, the same received offset, chunk count and
 *      version. Anything else rolls back: the chunk is not accepted.
 *
 * Failures after the file was written:
 *   - definite (our own refusal, a constraint or lock error: the transaction
 *     certainly rolled back): this request's own token file is removed and
 *     its lease released (conditional: only if it still holds it);
 *   - ambiguous (the commit's outcome is unknown, e.g. the connection broke):
 *     the database is read again; if the chunk row exists the chunk WAS
 *     accepted; otherwise the lease is released (conditional, so harmless
 *     either way) but the file is KEPT: cleanup (RL-3.5) deletes it only once
 *     the database shows that no committed chunk names it.
 * A committed chunk's file is never modified or deleted here.
 */

export type ChunkUploadInput = {
  /** From the authenticated session only. */
  teacherId: string;
  /** The route parameter. */
  uploadId: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
};

/** How long a request waits for the in-process upload mutex. */
export const CHUNK_MUTEX_WAIT_MS = 2_000;

/** The body must have arrived this long before the lease expires (at most 60 s, a fifth of the lease). */
export function writeMarginMs(chunkLeaseSeconds: number): number {
  return Math.min(60_000, Math.floor((chunkLeaseSeconds * 1000) / 5));
}

const OCTET_STREAM = /^application\/octet-stream(\s*;|$)/i;

type Lease = {
  token: string;
  offset: number;
  length: number;
  expectedBytes: bigint;
  chunkCount: number;
  /** The session version after the grant (the commit requires it unchanged). */
  version: number;
  leaseExpiresAtMs: number;
};

async function* emptySource(): AsyncGenerator<Uint8Array> {
  // A missing body is a body of 0 bytes (exactBytes then fails).
}

/** Releases this request's lease if (and only if) it still holds it. Never throws. */
async function releaseLease(uploadId: string, teacherId: string, token: string): Promise<void> {
  try {
    const now = await serverNow();
    await prisma.recordingUploadSession.updateMany({
      where: { id: uploadId, teacherId, leaseToken: token, state: "ACTIVE" },
      data: {
        leaseToken: null,
        leaseOffset: null,
        leaseBytes: null,
        leaseGrantedAt: null,
        leaseExpiresAt: null,
        updatedAt: now,
        version: { increment: 1 },
      },
    });
  } catch {
    // The lease expires on its own (chunk lease seconds).
  }
}

export async function uploadRecordingChunk(input: ChunkUploadInput): Promise<ChunkAcceptedDto> {
  const { teacherId, uploadId } = input;
  if (!isRecordedLectureId(uploadId)) throw uploadError("UPLOAD_NOT_FOUND");
  if (!OCTET_STREAM.test((input.headers.get("content-type") ?? "").trim())) throw uploadError("CONTENT_TYPE_INVALID");

  const config = loadConfig();
  const opened = await openRecordedLectureStorage(process.env);
  if (!opened.ok) throw uploadError("RECORDED_LECTURES_NOT_CONFIGURED");
  const { storage } = opened;

  let release: () => void;
  try {
    release = await getUploadMutex().acquire(uploadMutexKey(uploadId), { timeoutMs: CHUNK_MUTEX_WAIT_MS });
  } catch (error) {
    if (isUploadMutexTimeoutError(error)) throw uploadError("CHUNK_IN_PROGRESS", { retryAfterSeconds: 1 });
    throw error;
  }

  // RL-3.5: a writer slot of this process, held from before the lease grant until the
  // request ends (writeNewFile never returns while one of its writes is still running).
  const releaseWriter = getChunkWriterSlots().tryAcquire();
  if (!releaseWriter) {
    release();
    throw uploadError("INFLIGHT_CHUNK_CAP", { retryAfterSeconds: 1 });
  }

  try {
    // ---- Transaction A: the lease ----------------------------------------------------------------
    const granted = await prisma.$transaction(async (tx): Promise<{ expired: true } | { expired: false; lease: Lease }> => {
      await setUploadLockTimeout(tx);
      const now = await serverNow();

      const session = await tx.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
      if (!session) throw uploadError("UPLOAD_NOT_FOUND");
      const recording = await tx.recordedLecture.findFirst({ where: { id: session.recordedLectureId, teacherId } });
      if (!recording) throw uploadError("UPLOAD_NOT_FOUND");

      await assertTeacherCanUpload(tx, teacherId);
      await assertLectureActiveForUpload(tx, recording.lectureId, teacherId);

      if (session.state === "ACTIVE" && session.expiresAt.getTime() <= now.getTime()) {
        await expireStaleUploads(tx, { teacherId, uploadId }, now);
        return { expired: true };
      }
      if (session.state === "EXPIRED") throw uploadError("UPLOAD_EXPIRED");
      if (session.state !== "ACTIVE" || recording.state !== "UPLOADING" || recording.status !== 0) throw uploadError("UPLOAD_NOT_ACTIVE");

      const expectedBytes = byteCountToNumber(session.expectedBytes, "expectedBytes");
      const receivedBytes = byteCountToNumber(session.receivedBytes, "receivedBytes");
      const parsed = parseChunkRequestHeaders(input.headers, { expectedBytes, receivedBytes }, config);
      if (!parsed.ok) throw chunkHeaderError(parsed.problem, parsed.receivedBytes);

      if (session.leaseToken !== null && session.leaseExpiresAt !== null && session.leaseExpiresAt.getTime() > now.getTime()) {
        throw uploadError("CHUNK_IN_PROGRESS", {
          retryAfterSeconds: retryAfterSecondsForLease(session.leaseExpiresAt.getTime(), now.getTime()),
          receivedBytes,
        });
      }

      await lockUploadCapacity(tx);

      const token = generateLeaseToken();
      const leaseExpiresAt = new Date(now.getTime() + config.chunkLeaseSeconds * 1000);
      const updated = await tx.recordingUploadSession.updateMany({
        where: {
          id: uploadId,
          teacherId,
          state: "ACTIVE",
          receivedBytes: session.receivedBytes,
          chunkCount: session.chunkCount,
          version: session.version,
          expiresAt: { gt: now },
        },
        data: {
          leaseToken: token,
          leaseOffset: session.receivedBytes,
          leaseBytes: parsed.length,
          leaseGrantedAt: now,
          leaseExpiresAt,
          lastActivityAt: now,
          updatedAt: now,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw uploadError("CHUNK_IN_PROGRESS", { retryAfterSeconds: 1, receivedBytes });

      // The candidate lease is stored: the aggregate includes it (plan v8).
      const reservations = computeReservations(await reservationRows(tx, now), now.getTime());
      const freeBytes = await storage.freeBytes();
      const decision = decideCapacity({ freeBytes, reservations }, config);
      if (!decision.ok) {
        throw decision.reason === "INSUFFICIENT_STORAGE"
          ? uploadError("INSUFFICIENT_STORAGE")
          : uploadError("INFLIGHT_CHUNK_CAP", { retryAfterSeconds: Math.min(config.chunkLeaseSeconds, 30) });
      }

      return {
        expired: false,
        lease: {
          token,
          offset: parsed.offset,
          length: parsed.length,
          expectedBytes: session.expectedBytes,
          chunkCount: session.chunkCount,
          version: session.version + 1,
          leaseExpiresAtMs: leaseExpiresAt.getTime(),
        },
      };
    }, RECORDED_LECTURE_TRANSACTION_OPTIONS);

    if (granted.expired) throw uploadError("UPLOAD_EXPIRED");
    const { lease } = granted;
    const key = chunkScratchKey(uploadId, lease.token);

    // ---- The body -> this lease's own file ---------------------------------------------------------
    const hashing = sha256Passthrough(input.body ?? emptySource());
    try {
      await storage.writeNewFile(key, hashing.source, {
        maxBytes: lease.length,
        exactBytes: lease.length,
        deadlineAtMs: lease.leaseExpiresAtMs - writeMarginMs(config.chunkLeaseSeconds),
        signal: input.signal,
        sync: true,
        syncDirectory: true,
        now: () => serverNowSync().getTime(),
      });
    } catch (error) {
      // writeNewFile already removed its partial file.
      await releaseLease(uploadId, teacherId, lease.token);
      if (isStorageError(error)) throw storageErrorToAppError(error.code, "chunk-write");
      throw error;
    }
    const sha256 = hashing.digest();

    // ---- Transaction B: commit -----------------------------------------------------------------------
    const newReceived = lease.offset + lease.length;
    try {
      await prisma.$transaction(async (tx) => {
        await setUploadLockTimeout(tx);
        const now = await serverNow();

        await assertTeacherCanUpload(tx, teacherId);
        const session = await tx.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId, leaseToken: lease.token } });
        if (!session) throw uploadError("LEASE_LOST");
        const recording = await tx.recordedLecture.findFirst({ where: { id: session.recordedLectureId, teacherId } });
        if (!recording) throw uploadError("LEASE_LOST");
        await assertLectureActiveForUpload(tx, recording.lectureId, teacherId);
        if (session.expiresAt.getTime() <= now.getTime()) throw uploadError("UPLOAD_EXPIRED");
        if (session.leaseExpiresAt === null || session.leaseExpiresAt.getTime() <= now.getTime()) throw uploadError("LEASE_LOST");

        await tx.recordingUploadChunk.create({
          data: {
            id: randomUUID(),
            uploadSessionId: uploadId,
            chunkIndex: lease.chunkCount,
            startOffset: byteCountToBigint(lease.offset, "startOffset"),
            byteLength: lease.length,
            leaseToken: lease.token,
            sha256,
            receivedAt: now,
          },
        });
        const committed = await tx.recordingUploadSession.updateMany({
          where: {
            id: uploadId,
            teacherId,
            state: "ACTIVE",
            expiresAt: { gt: now },
            leaseToken: lease.token,
            leaseExpiresAt: { gt: now },
            receivedBytes: byteCountToBigint(lease.offset, "receivedBytes"),
            chunkCount: lease.chunkCount,
            version: lease.version,
          },
          data: {
            receivedBytes: byteCountToBigint(newReceived, "receivedBytes"),
            chunkCount: { increment: 1 },
            leaseToken: null,
            leaseOffset: null,
            leaseBytes: null,
            leaseGrantedAt: null,
            leaseExpiresAt: null,
            lastActivityAt: now,
            updatedAt: now,
            version: { increment: 1 },
          },
        });
        if (committed.count !== 1) throw uploadError("LEASE_LOST");
      }, RECORDED_LECTURE_TRANSACTION_OPTIONS);
    } catch (error) {
      if (isDefiniteRollback(error)) {
        await storage.remove(key).catch(() => undefined);
        await releaseLease(uploadId, teacherId, lease.token);
        throw error;
      }
      // Ambiguous: establish the outcome before touching the file.
      const accepted = await findCommittedChunk(uploadId, teacherId, lease.token);
      if (accepted) return accepted;
      await releaseLease(uploadId, teacherId, lease.token);
      throw uploadError("UPLOAD_BUSY", { retryAfterSeconds: 1 });
    }

    return buildChunkAcceptedDto({
      id: uploadId,
      expectedBytes: lease.expectedBytes,
      receivedBytes: byteCountToBigint(newReceived, "receivedBytes"),
      chunkCount: lease.chunkCount + 1,
    });
  } finally {
    releaseWriter();
    release();
  }
}

/** After an ambiguous commit: the session's state if a chunk row names this lease token, else null (also on errors). */
async function findCommittedChunk(uploadId: string, teacherId: string, token: string): Promise<ChunkAcceptedDto | null> {
  try {
    const chunk = await prisma.recordingUploadChunk.findFirst({ where: { uploadSessionId: uploadId, leaseToken: token } });
    if (!chunk) return null;
    const session = await prisma.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
    if (!session) return null;
    return buildChunkAcceptedDto(session);
  } catch {
    return null;
  }
}
