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

type NoteAndSubmissionBytesRow = { notesBytes: bigint; submissionsBytes: bigint };

/** Notes and submission bytes, summed in SQL as BIGINT (a Prisma _sum over an Int column could overflow). */
export async function readNoteAndSubmissionBytes(db: Pick<UsageDb, "$queryRaw">, teacherId: string): Promise<{ notes: bigint; submissions: bigint }> {
  return noteAndSubmissionBytesOf(await noteAndSubmissionBytesQuery(db, teacherId));
}

function noteAndSubmissionBytesOf(rows: NoteAndSubmissionBytesRow[]): { notes: bigint; submissions: bigint } {
  const row = rows[0];
  return { notes: BigInt(row?.notesBytes ?? 0), submissions: BigInt(row?.submissionsBytes ?? 0) };
}

/** The raw query itself (lazy, not yet sent), so it can also join a batch transaction. */
function noteAndSubmissionBytesQuery(db: Pick<UsageDb, "$queryRaw">, teacherId: string) {
  return db.$queryRaw<NoteAndSubmissionBytesRow[]>`
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
}

/**
 * The seven reads of a usage calculation, built but NOT yet sent (Prisma
 * queries are lazy), in their required order: 1. reservations first (see the
 * module comment), 2. committed storage, 3. the effective limit. None depends
 * on another's result, so they can run one by one in a caller's transaction
 * or together as one batch transaction.
 */
export function usageQueries(db: UsageDb, teacherId: string, now: Date) {
  return [
    // 1. Reservations.
    db.recordingUploadSession.findMany({
      where: { teacherId, state: { in: [...ACTIVE_SESSION_STATES] } },
      select: { state: true, expectedBytes: true, receivedBytes: true, leaseBytes: true, leaseExpiresAt: true, expiresAt: true },
    }),
    db.storageReservation.groupBy({
      by: ["category"],
      where: { teacherId, expiresAt: { gt: now } },
      _sum: { bytes: true },
    }),
    // 2. Committed storage.
    db.recordedLecture.aggregate({
      where: { teacherId, state: "READY", storedFileName: { not: null }, purgedAt: null },
      _sum: { sizeBytes: true },
    }),
    noteAndSubmissionBytesQuery(db, teacherId),
    db.teacherProfile.findUnique({
      where: { teacherId },
      select: { profileImageStorageKey: true, profileImageSizeBytes: true },
    }),
    // 3. The effective limit (override, else the ACTIVE subscription plan's storageGB, else unlimited).
    db.teacherStorageLimit.findUnique({ where: { teacherId }, select: { limitBytes: true } }),
    db.teacherSubscription.findFirst({
      where: activeSubscriptionWhere(teacherId, now),
      orderBy: { updatedAt: "desc" },
      select: { plan: { select: { storageGB: true } } },
    }),
  ] as const;
}

type UsageQueries = ReturnType<typeof usageQueries>;
type AwaitedTuple<T extends readonly unknown[]> = { -readonly [K in keyof T]: Awaited<T[K]> };
type UsageResults = AwaitedTuple<UsageQueries>;

/** The usage from the seven results, in usageQueries order (unchanged calculations). */
function usageFromResults(teacherId: string, now: Date, results: UsageResults): TeacherStorageUsage {
  const [sessions, reservationGroups, recordings, noteAndSubmissionRows, profile, override, subscription] = results;
  const nowMs = now.getTime();

  const recordingReserved = sessions.reduce((total, session) => total + recordingSessionReservedBytes(session, nowMs), BigInt(0));
  const reservedOf = (category: "NOTE" | "SUBMISSION" | "PROFILE_IMAGE") => reservationGroups.find((g) => g.category === category)?._sum.bytes ?? BigInt(0);
  const { notes, submissions } = noteAndSubmissionBytesOf(noteAndSubmissionRows);
  const profileImages = profile?.profileImageStorageKey ? BigInt(profile.profileImageSizeBytes ?? 0) : BigInt(0);

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

/** Inside the caller's transaction: the reads one by one, in order (no nested transaction). */
async function computeUsageIn(db: UsageDb, teacherId: string, now: Date): Promise<TeacherStorageUsage> {
  const [q1, q2, q3, q4, q5, q6, q7] = usageQueries(db, teacherId, now);
  const results: UsageResults = [await q1, await q2, await q3, await q4, await q5, await q6, await q7];
  return usageFromResults(teacherId, now, results);
}

/**
 * The teacher's storage usage and effective limit. Pass `db` (a transaction
 * client) to read inside the caller's transaction - e.g. under
 * lockTeacherStorageQuota in Stage 3.2; otherwise the reads run as ONE batch
 * transaction at REPEATABLE READ (one snapshot). A batch transaction is not an
 * interactive one, so the interactive transaction timeout (5 s by default;
 * exceeded with seven sequential round trips to a remote database, P2028)
 * does not apply. `now` defaults to database time.
 */
export async function getTeacherStorageUsage(
  teacherId: string,
  options: { db?: UsageDb; now?: Date } = {}
): Promise<TeacherStorageUsage> {
  const now = options.now ?? (await serverNow());
  if (options.db) return computeUsageIn(options.db, teacherId, now);
  const results = await prisma.$transaction([...usageQueries(prisma, teacherId, now)], {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
  return usageFromResults(teacherId, now, results as UsageResults);
}
