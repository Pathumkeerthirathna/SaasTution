import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { byteCountToBigint, byteCountToNumber } from "@/lib/recorded-lectures/bigint";
import { computeReservations, decideCapacity, type ReservationRow } from "@/lib/recorded-lectures/chunk-lease";
import { loadRecordedLectureConfig, type RecordedLectureConfig } from "@/lib/recorded-lectures/config";
import { isRecordedLectureId } from "@/lib/recorded-lectures/keys";
import { openRecordedLectureStorage } from "@/lib/recorded-lectures/storage";
import { buildUploadStatusDto, type UploadStatusDto } from "@/lib/recorded-lectures/upload-dto";
import { declarationError, uploadError } from "@/lib/recorded-lectures/upload-errors";
import {
  lockTeacherUploads,
  lockUploadCapacity,
  RECORDED_LECTURE_TRANSACTION_OPTIONS,
  setUploadLockTimeout,
} from "@/lib/recorded-lectures/upload-locks";
import { validateUploadDeclaration } from "@/lib/recorded-lectures/validation";
import { serverNow } from "@/lib/server-clock";
import { assertTeacherOwnsLecture } from "@/services/lecture-service";

/*
 * Recorded Lectures RL-3.2: start an upload and read its status.
 *
 * The teacher id always comes from the caller's authenticated session; no
 * request field is ever read for it (nor for the class). Every time
 * decision uses serverNow() (the database clock), never the client's.
 *
 * Start transaction, in this order (lock order of upload-locks.ts):
 *   1. SET LOCAL lock_timeout;
 *   2. the teacher's advisory lock (serializes this teacher's starts, so the
 *      active-upload cap cannot be exceeded by concurrent requests);
 *   3. teacher account and lecture / class re-checked inside the transaction;
 *   4. this teacher's expired ACTIVE uploads are expired (conditional
 *      updates), which also frees their part numbers;
 *   5. the active-upload cap;
 *   6. the global capacity advisory lock;
 *   7. the candidate rows (RecordedLecture UPLOADING + RecordingUploadSession
 *      ACTIVE) are written first;
 *   8. the reservation aggregate over the stored rows (candidate included),
 *      free space (statfs) and the capacity decision: not enough space throws,
 *      rolling back both rows.
 * The active part-number uniqueness is the database's partial unique index
 * (a P2002 maps to 409 PART_NUMBER_IN_USE). No file is created here: the
 * temporary .part file is created by the first chunk (RL-3.3).
 */

export type Tx = Prisma.TransactionClient;

export const ACTIVE_STATES = ["ACTIVE", "COMPLETING"] as const;

export type StartUploadInput = {
  /** From the authenticated session only. */
  teacherId: string;
  /** The route parameter. */
  lectureId: string;
  /** The parsed JSON body (any shape; validated here). */
  body: unknown;
};

export function loadConfig(): RecordedLectureConfig {
  const loaded = loadRecordedLectureConfig(process.env);
  if (!loaded.ok) throw uploadError("RECORDED_LECTURES_NOT_CONFIGURED");
  return loaded.config;
}

/** Only the five declaration fields are read; anything else in the body (teacherId, classId...) is ignored. */
function declarationFields(body: unknown) {
  const source = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return {
    title: source.title,
    partNumber: source.partNumber,
    fileName: source.fileName,
    mimeType: source.mimeType,
    sizeBytes: source.sizeBytes,
  };
}

/**
 * D3: blocked, rejected, unconfirmed or email-unconfirmed teachers cannot start
 * or continue uploads. Their teacher id must also be usable in storage keys
 * (a lowercase UUID, as the database CHECK requires).
 */
export async function assertTeacherCanUpload(client: Pick<Tx, "teacher">, teacherId: string): Promise<void> {
  if (!isRecordedLectureId(teacherId)) throw uploadError("TEACHER_ACCOUNT_INACTIVE");
  const teacher = await client.teacher.findUnique({
    where: { id: teacherId },
    select: { isBlocked: true, isConfirmed: true, isRejected: true, emailConfirmed: true },
  });
  if (!teacher || teacher.isBlocked || !teacher.isConfirmed || teacher.isRejected || !teacher.emailConfirmed) {
    throw uploadError("TEACHER_ACCOUNT_INACTIVE");
  }
}

/**
 * "No current chunk lease" at `now`: no lease, or one that has expired. A
 * chunk writer's write deadline is its lease expiry minus 60 s, so once the
 * lease has expired the writer cannot start another piece (RL-3.5 bug fix:
 * expiry used to clear a CURRENT lease, releasing its capacity reservation
 * while the writer could still write).
 */
export function noCurrentLease(now: Date) {
  return { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] };
}

/**
 * Expires ACTIVE uploads whose expiry has passed (conditional updates: only
 * rows still ACTIVE, expired at `now` and WITHOUT a current chunk lease
 * change; an upload with a current lease is expired once that lease ends).
 * The session becomes EXPIRED (lease cleared, endedAt set) and its recording
 * FAILED (UPLOAD_EXPIRED), which frees the part number. Files are removed by
 * the maintenance cleanup (RL-3.5).
 */
export async function expireStaleUploads(tx: Tx, filter: { teacherId: string; uploadId?: string }, now: Date): Promise<number> {
  const stale = await tx.recordingUploadSession.findMany({
    where: {
      teacherId: filter.teacherId,
      ...(filter.uploadId ? { id: filter.uploadId } : {}),
      state: "ACTIVE",
      expiresAt: { lte: now },
      ...noCurrentLease(now),
    },
    select: { id: true, recordedLectureId: true },
  });

  let expired = 0;
  for (const row of stale) {
    const updated = await tx.recordingUploadSession.updateMany({
      where: { id: row.id, teacherId: filter.teacherId, state: "ACTIVE", expiresAt: { lte: now }, ...noCurrentLease(now) },
      data: {
        state: "EXPIRED",
        endedAt: now,
        updatedAt: now,
        leaseToken: null,
        leaseOffset: null,
        leaseBytes: null,
        leaseGrantedAt: null,
        leaseExpiresAt: null,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) continue;
    expired++;
    await tx.recordedLecture.updateMany({
      where: { id: row.recordedLectureId, teacherId: filter.teacherId, state: "UPLOADING" },
      data: { state: "FAILED", failureCode: "UPLOAD_EXPIRED", failedAt: now, updatedAt: now },
    });
  }
  return expired;
}

/**
 * D4: the recording's lecture is still active, in an active class owned by
 * this teacher (re-checked inside each upload transaction).
 */
export async function assertLectureActiveForUpload(tx: Pick<Tx, "lecture">, lectureId: string, teacherId: string): Promise<void> {
  const lecture = await tx.lecture.findFirst({
    where: { id: lectureId, status: 0, class: { teacherId, status: 0 } },
    select: { id: true },
  });
  if (!lecture) throw uploadError("LECTURE_NOT_ACTIVE");
}

/**
 * The capacity aggregate's rows: every ACTIVE or COMPLETING session, as
 * numbers. A COMPLETING session also reserves its full size for assembly
 * (RL-3.4): the assembled file grows to expectedBytes while every chunk file
 * still exists. An ACTIVE session past its upload expiry reserves nothing for
 * the bytes it will never receive, but its CURRENT chunk lease still counts in
 * full (2 x lease, and in the in-flight cap) until the lease expires (RL-3.5
 * bug fix: such a row used to be dropped entirely).
 */
export async function reservationRows(tx: Tx, now: Date): Promise<ReservationRow[]> {
  const rows = await tx.recordingUploadSession.findMany({
    where: { state: { in: [...ACTIVE_STATES] } },
    select: { state: true, expectedBytes: true, receivedBytes: true, leaseBytes: true, leaseExpiresAt: true, expiresAt: true },
  });
  const out: ReservationRow[] = [];
  for (const row of rows) {
    const expectedBytes = byteCountToNumber(row.expectedBytes, "expectedBytes");
    const receivedBytes = byteCountToNumber(row.receivedBytes, "receivedBytes");
    const leaseExpiresAtMs = row.leaseExpiresAt ? row.leaseExpiresAt.getTime() : null;
    if (row.state === "ACTIVE" && row.expiresAt.getTime() <= now.getTime()) {
      const leaseCurrent = row.leaseBytes !== null && leaseExpiresAtMs !== null && leaseExpiresAtMs > now.getTime();
      if (!leaseCurrent) continue;
      // Only the current lease: as if the upload ended right after this chunk.
      out.push({ expectedBytes: receivedBytes + (row.leaseBytes as number), receivedBytes, leaseBytes: row.leaseBytes, leaseExpiresAtMs });
      continue;
    }
    out.push({
      expectedBytes,
      receivedBytes,
      leaseBytes: row.leaseBytes,
      leaseExpiresAtMs,
      assemblyBytes: row.state === "COMPLETING" ? expectedBytes : 0,
    });
  }
  return out;
}

/** POST /api/lectures/[id]/recorded-lectures/uploads */
export async function startRecordingUpload(input: StartUploadInput): Promise<UploadStatusDto> {
  const { teacherId, lectureId } = input;
  if (!isRecordedLectureId(lectureId)) throw uploadError("LECTURE_NOT_FOUND");

  const config = loadConfig();
  const declared = validateUploadDeclaration(declarationFields(input.body), config);
  if (!declared.ok) throw declarationError(declared.problem, declared.message);
  const declaration = declared.value;

  await assertTeacherCanUpload(prisma, teacherId);
  // 404 LECTURE_NOT_FOUND unless this teacher owns the (active) lecture.
  await assertTeacherOwnsLecture(teacherId, lectureId);

  const opened = await openRecordedLectureStorage(process.env);
  if (!opened.ok) throw uploadError("RECORDED_LECTURES_NOT_CONFIGURED");
  const { storage } = opened;

  const { recording, session, nowMs } = await prisma.$transaction(async (tx) => {
    await setUploadLockTimeout(tx);
    await lockTeacherUploads(tx, teacherId);
    const now = await serverNow();

    await assertTeacherCanUpload(tx, teacherId);
    const lecture = await tx.lecture.findFirst({
      where: { id: lectureId, status: 0, class: { teacherId, status: 0 } },
      select: { id: true, classId: true },
    });
    if (!lecture) throw uploadError("LECTURE_NOT_ACTIVE");

    await expireStaleUploads(tx, { teacherId }, now);
    const activeUploads = await tx.recordingUploadSession.count({ where: { teacherId, state: { in: [...ACTIVE_STATES] } } });
    if (activeUploads >= config.maxActiveUploadsPerTeacher) throw uploadError("TOO_MANY_ACTIVE_UPLOADS");

    await lockUploadCapacity(tx);

    const sizeBytes = byteCountToBigint(declaration.sizeBytes, "sizeBytes");
    const recording = await tx.recordedLecture.create({
      data: {
        id: randomUUID(),
        lectureId: lecture.id,
        classId: lecture.classId,
        teacherId,
        title: declaration.title,
        partNumber: declaration.partNumber,
        displayFileName: declaration.displayFileName,
        mimeType: declaration.mimeType,
        sizeBytes,
        state: "UPLOADING",
        status: 0,
        createdAt: now,
        updatedAt: now,
      },
    });
    const session = await tx.recordingUploadSession.create({
      data: {
        id: randomUUID(),
        recordedLectureId: recording.id,
        teacherId,
        expectedBytes: sizeBytes,
        receivedBytes: byteCountToBigint(0, "receivedBytes"),
        chunkCount: 0,
        state: "ACTIVE",
        expiresAt: new Date(now.getTime() + config.uploadExpiryHours * 3_600_000),
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });

    // The candidate is stored: the aggregate includes it (plan v8).
    const reservations = computeReservations(await reservationRows(tx, now), now.getTime());
    const freeBytes = await storage.freeBytes();
    const decision = decideCapacity({ freeBytes, reservations }, config);
    if (!decision.ok) {
      throw decision.reason === "INSUFFICIENT_STORAGE"
        ? uploadError("INSUFFICIENT_STORAGE")
        : uploadError("INFLIGHT_CHUNK_CAP", { retryAfterSeconds: config.chunkLeaseSeconds });
    }

    return { recording, session, nowMs: now.getTime() };
  }, RECORDED_LECTURE_TRANSACTION_OPTIONS);

  return buildUploadStatusDto(session, recording, config, nowMs);
}

/**
 * GET /api/recorded-lectures/uploads/[uploadId]. Only the caller's own uploads
 * (another teacher's upload is indistinguishable from a missing one: 404).
 * Allowed for any authenticated owner, including a blocked one (D3: inspect
 * and cancel stay possible). An ACTIVE upload past its expiry is expired
 * first (conditional update), then reported.
 */
export async function getRecordingUploadStatus(input: { teacherId: string; uploadId: string }): Promise<UploadStatusDto> {
  const { teacherId, uploadId } = input;
  if (!isRecordedLectureId(uploadId)) throw uploadError("UPLOAD_NOT_FOUND");
  const config = loadConfig();

  const now = await serverNow();
  let session = await prisma.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
  if (!session) throw uploadError("UPLOAD_NOT_FOUND");

  if (session.state === "ACTIVE" && session.expiresAt.getTime() <= now.getTime()) {
    await prisma.$transaction(async (tx) => {
      await setUploadLockTimeout(tx);
      await expireStaleUploads(tx, { teacherId, uploadId }, now);
    }, RECORDED_LECTURE_TRANSACTION_OPTIONS);
    session = await prisma.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
    if (!session) throw uploadError("UPLOAD_NOT_FOUND");
  }

  const recording = await prisma.recordedLecture.findFirst({ where: { id: session.recordedLectureId, teacherId } });
  if (!recording) throw uploadError("UPLOAD_NOT_FOUND");

  return buildUploadStatusDto(session, recording, config, now.getTime());
}
