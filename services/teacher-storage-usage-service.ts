import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { serverNow } from "@/lib/server-clock";
import {
  recordingSessionReservedBytes,
  resolveEffectiveStorageLimit,
  summarizeTeacherStorageUsage,
  type TeacherStorageUsage,
} from "@/lib/storage-quota/usage";

/*
 * Teacher storage accounting (Stage 3.1): getTeacherStorageUsage(teacherId).
 *
 * Computed from database rows that reference VERIFIED files in the unified
 * storage hierarchy (FILE_STORAGE_ROOT/Teachers/{teacherId}/...); the
 * filesystem is never scanned here. Sizes are verified when the file is
 * written: Notes / submissions record the bytes actually written
 * (lib/stored-files/stored-file.ts storeUpload, exact size + SHA-256), and a
 * READY recording's sizeBytes is the declared size its assembly wrote exactly
 * (services/recorded-lecture-completion-service.ts, exactBytes).
 *
 * COMMITTED
 *   Recorded Lectures  RecordedLecture: teacherId, state READY, storedFileName
 *                      set, purgedAt NULL. status 0 and 2 ("purge pending":
 *                      deleted by the teacher, file not yet removed) both count
 *                      until the file is purged.
 *   Notes              Note.storageKey set (soft-deleted notes, and notes of
 *                      removed lectures / classes, count while their files
 *                      exist); teacher = Lecture -> Class.teacherId.
 *   Submissions        AssignmentSubmission.storageKey set; teacher =
 *                      Assignment -> Lecture -> Class.teacherId.
 *   Profile images     TeacherProfile.profileImageStorageKey set (its
 *                      profileImageSizeBytes; the database CHECKs keep key,
 *                      size, digest and type together). A photo whose removal
 *                      is pending (profileImageUrl cleared, key kept) still
 *                      counts until its file is deleted. Legacy photos
 *                      (profileImageUrl only) are never counted.
 *   Legacy rows (storageKey NULL), legacy rollback copies (the fileUrl copies
 *   below <cwd>/storage), temporary chunks and assemblies (System/), and
 *   unreferenced files are never counted.
 * RESERVED
 *   Recorded Lectures  ACTIVE / COMPLETING RecordingUploadSession rows, by
 *                      recordingSessionReservedBytes (the reservationRows rules).
 *   Notes / subs /     StorageReservation rows with expiresAt > now
 *   profile images     (categories NOTE / SUBMISSION / PROFILE_IMAGE).
 *
 * Times: `now` is database time (serverNow), as the Recorded Lectures expiry
 * rules use. Consistency: without a caller transaction, everything is read in
 * ONE REPEATABLE READ snapshot. With a caller transaction (Stage 3.2: under
 * the teacher quota lock, READ COMMITTED), reservations are read BEFORE
 * committed rows: a concurrent "session COMPLETED + recording READY" commit in
 * between can then only be counted twice (over-estimate), never missed.
 */

type UsageDb = Pick<
  Prisma.TransactionClient,
  "recordingUploadSession" | "storageReservation" | "recordedLecture" | "teacherStorageLimit" | "teacherSubscription" | "teacherProfile" | "$queryRaw"
>;

const ACTIVE_SESSION_STATES = ["ACTIVE", "COMPLETING"] as const;

/**
 * The subscriptions that may supply the default plan limit (Stage 3.2): status
 * ACTIVE and not past an end date (subscriptions are created ACTIVE with no
 * endDate). CANCELLED, EXPIRED and SUSPENDED subscriptions never do; the
 * individual override applies regardless. Several active ones: the latest
 * by updatedAt.
 */
export function activeSubscriptionWhere(teacherId: string, now: Date) {
  return { teacherId, status: "ACTIVE" as const, OR: [{ endDate: null }, { endDate: { gt: now } }] };
}

/** Notes and submission bytes, summed in SQL as BIGINT (a Prisma _sum over an Int column could overflow). */
export async function readNoteAndSubmissionBytes(db: Pick<UsageDb, "$queryRaw">, teacherId: string): Promise<{ notes: bigint; submissions: bigint }> {
  const rows = await db.$queryRaw<Array<{ notesBytes: bigint; submissionsBytes: bigint }>>`
    SELECT
      (SELECT COALESCE(SUM(n."sizeBytes"), 0)::bigint
         FROM "Note" n
         JOIN "Lecture" l ON l."id" = n."lectureId"
         JOIN "Class" c ON c."id" = l."classId"
        WHERE c."teacherId" = ${teacherId}
          AND n."storageKey" IS NOT NULL) AS "notesBytes",
      (SELECT COALESCE(SUM(s."sizeBytes"), 0)::bigint
         FROM "AssignmentSubmission" s
         JOIN "Assignment" a ON a."id" = s."assignmentId"
         JOIN "Lecture" l ON l."id" = a."lectureId"
         JOIN "Class" c ON c."id" = l."classId"
        WHERE c."teacherId" = ${teacherId}
          AND s."storageKey" IS NOT NULL) AS "submissionsBytes"`;
  const row = rows[0];
  return { notes: BigInt(row?.notesBytes ?? 0), submissions: BigInt(row?.submissionsBytes ?? 0) };
}

async function computeUsage(db: UsageDb, teacherId: string, now: Date): Promise<TeacherStorageUsage> {
  const nowMs = now.getTime();

  // 1. Reservations first (see the module comment).
  const sessions = await db.recordingUploadSession.findMany({
    where: { teacherId, state: { in: [...ACTIVE_SESSION_STATES] } },
    select: { state: true, expectedBytes: true, receivedBytes: true, leaseBytes: true, leaseExpiresAt: true, expiresAt: true },
  });
  const recordingReserved = sessions.reduce((total, session) => total + recordingSessionReservedBytes(session, nowMs), BigInt(0));

  const reservationGroups = await db.storageReservation.groupBy({
    by: ["category"],
    where: { teacherId, expiresAt: { gt: now } },
    _sum: { bytes: true },
  });
  const reservedOf = (category: "NOTE" | "SUBMISSION" | "PROFILE_IMAGE") => reservationGroups.find((g) => g.category === category)?._sum.bytes ?? BigInt(0);

  // 2. Committed storage.
  const recordings = await db.recordedLecture.aggregate({
    where: { teacherId, state: "READY", storedFileName: { not: null }, purgedAt: null },
    _sum: { sizeBytes: true },
  });
  const { notes, submissions } = await readNoteAndSubmissionBytes(db, teacherId);
  const profile = await db.teacherProfile.findUnique({
    where: { teacherId },
    select: { profileImageStorageKey: true, profileImageSizeBytes: true },
  });
  const profileImages = profile?.profileImageStorageKey ? BigInt(profile.profileImageSizeBytes ?? 0) : BigInt(0);

  // 3. The effective limit (override, else the ACTIVE subscription plan's storageGB, else unlimited).
  const override = await db.teacherStorageLimit.findUnique({ where: { teacherId }, select: { limitBytes: true } });
  const subscription = await db.teacherSubscription.findFirst({
    where: activeSubscriptionWhere(teacherId, now),
    orderBy: { updatedAt: "desc" },
    select: { plan: { select: { storageGB: true } } },
  });

  return summarizeTeacherStorageUsage({
    teacherId,
    measuredAt: now,
    committed: { recordedLectures: recordings._sum.sizeBytes ?? BigInt(0), notes, submissions, profileImages },
    reserved: {
      recordedLectures: recordingReserved,
      notes: reservedOf("NOTE"),
      submissions: reservedOf("SUBMISSION"),
      profileImages: reservedOf("PROFILE_IMAGE"),
    },
    limit: resolveEffectiveStorageLimit({
      overrideBytes: override?.limitBytes ?? null,
      subscription: subscription ? { planStorageGB: subscription.plan.storageGB } : null,
    }),
  });
}

/**
 * The teacher's storage usage and effective limit. Pass `db` (a transaction
 * client) to read inside the caller's transaction - e.g. under
 * lockTeacherStorageQuota in Stage 3.2; otherwise a read-only REPEATABLE READ
 * transaction is used. `now` defaults to database time.
 */
export async function getTeacherStorageUsage(
  teacherId: string,
  options: { db?: UsageDb; now?: Date } = {}
): Promise<TeacherStorageUsage> {
  const now = options.now ?? (await serverNow());
  if (options.db) return computeUsage(options.db, teacherId, now);
  return prisma.$transaction((tx) => computeUsage(tx, teacherId, now), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}
