import { AppError, reportRouteError } from "@/lib/error-handler";
import { detectBlobProfilePhotoType } from "@/lib/profile-images/image-signature";
import {
  generateProfilePhotoStoredName,
  ownProfilePhotoKey,
  PROFILE_PHOTO_MAX_BYTES,
  profilePhotoDirectoryKey,
  profilePhotoKey,
  profilePhotoKeyFromRoute,
  profilePhotoUrl,
  type ProfilePhotoMimeType,
} from "@/lib/profile-images/storage-keys";
import { STORAGE_ID } from "@/lib/notes/storage-keys";
import { prisma } from "@/lib/prisma";
import {
  listStoredDirectory,
  openProfilePhotoForRead,
  removeEmptyStoredDirectoryQuietly,
  removeStoredFileQuietly,
  removeStoredFileStrict,
  statStoredFile,
  writeUploadedFile,
  type OpenedStoredFile,
} from "@/lib/stored-files/stored-file";
import {
  commitTeacherStorageReservation,
  releaseTeacherStorageReservation,
  reserveTeacherStorage,
} from "@/services/storage-reservation-service";

/*
 * Teacher profile photos on unified storage.
 *
 * Files: FILE_STORAGE_ROOT/Teachers/{teacherId}/Profile/Photo/{32 hex}.{ext}
 * (lib/profile-images/storage-keys.ts). Database: TeacherProfile
 * profileImageStorageKey / Sha256 / SizeBytes / MimeType (set and cleared
 * together, CHECKed) plus profileImageUrl, the display URL every consumer
 * reads (header, public profile, search, Jitsi photoUrl). Quota: category
 * PROFILE_IMAGE (counted while profileImageStorageKey is set).
 *
 * UPLOAD / REPLACE (uploadTeacherProfilePhoto)
 *   1. type from the file's own bytes (JPEG / PNG / WebP only), <= 2 MB;
 *   2. the current profile is read (the compare-and-set reference);
 *   3. the FULL new size is reserved under the teacher's quota lock (the old
 *      photo keeps counting: replacing never frees quota in advance);
 *   4. the photo is streamed to a NEW random key (exact size, SHA-256,
 *      flushed); a failure removes the partial file and releases the
 *      reservation, and the old photo is untouched;
 *   5. one transaction under the quota lock: the profile row is updated only
 *      if it still references what step 2 read (compare-and-set), and the
 *      reservation is deleted with it; a lost race discards this upload's file
 *      and retries (at most 3 attempts, then 409);
 *   6. only after that commit: the PREVIOUS unified photo is deleted (strict,
 *      own key only). If that fails it is logged and left unreferenced: the
 *      orphan sweep deletes it after the grace period. A legacy photo
 *      (profileImageUrl only) is never deleted.
 * REMOVE (removeTeacherProfilePhoto): a recoverable lifecycle
 *   a. profileImageUrl is cleared (hidden everywhere at once); the key stays,
 *      so the photo still counts while its file exists;
 *   b. the file is deleted (strict; already missing = deleted);
 *   c. the four columns are cleared (compare-and-set on the key): only now is
 *      the quota released. A failure after (a) leaves it PENDING: the
 *      maintenance retry (finishPendingProfilePhotoRemovals) finishes it.
 *   A legacy-only photo: profileImageUrl is cleared, the legacy file stays.
 * ORPHAN SWEEP (sweepProfilePhotoOrphans, maintenance): files below
 *   Teachers/{t}/Profile/Photo/ that are not referenced by the teacher's row,
 *   not reserved by an unexpired upload, and older than the grace period.
 */

export const PROFILE_PHOTO_UPLOAD_ATTEMPTS = 3;
/** Orphan sweep: a file this young may belong to an upload still in progress. */
export const PROFILE_PHOTO_ORPHAN_GRACE_MS = 24 * 3_600_000;

function reportPhotoProblem(error: unknown, label: string) {
  try {
    reportRouteError(error, { request: new Request("http://internal/storage/profile-photo", { method: "POST" }), label });
  } catch {
    // Logging must never break the request.
  }
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Error && error.name === "PrismaClientKnownRequestError" && (error as Error & { code?: unknown }).code === "P2002";

export const invalidProfilePhotoError = () =>
  new AppError("Upload a JPEG, PNG or WebP image.", 415, "PROFILE_PHOTO_INVALID_IMAGE");

// ---- Upload / replace -----------------------------------------------------------------------------------------

export async function uploadTeacherProfilePhoto(input: { teacherId: string; photo: Blob }): Promise<{ profileImageUrl: string }> {
  const { teacherId, photo } = input;
  if (typeof teacherId !== "string" || !STORAGE_ID.test(teacherId)) throw new AppError("Teacher not found.", 404, "TEACHER_NOT_FOUND");
  if (photo.size < 1 || photo.size > PROFILE_PHOTO_MAX_BYTES) {
    throw new AppError("The photo is larger than 2 MB. Choose a smaller image.", 413, "PROFILE_PHOTO_TOO_LARGE");
  }
  const mimeType = await detectBlobProfilePhotoType(photo);
  if (!mimeType) throw invalidProfilePhotoError();

  for (let attempt = 1; attempt <= PROFILE_PHOTO_UPLOAD_ATTEMPTS; attempt++) {
    const outcome = await uploadOnce(teacherId, photo, mimeType);
    if (outcome) return outcome;
  }
  throw new AppError("Your profile photo was changed at the same time. Please try again.", 409, "PROFILE_PHOTO_CONFLICT");
}

/** One attempt; null when it lost the compare-and-set (nothing of it is left behind). */
async function uploadOnce(teacherId: string, photo: Blob, mimeType: ProfilePhotoMimeType): Promise<{ profileImageUrl: string } | null> {
  const current = await prisma.teacherProfile.findUnique({
    where: { teacherId },
    select: { profileImageUrl: true, profileImageStorageKey: true },
  });

  const storedName = generateProfilePhotoStoredName(mimeType);
  const storageKey = profilePhotoKey({ teacherId, storedName });
  const url = profilePhotoUrl({ teacherId, storedName });

  const reservation = await reserveTeacherStorage({
    teacherId,
    category: "PROFILE_IMAGE",
    storageKey,
    bytes: BigInt(photo.size),
    audience: "TEACHER",
  });

  let stored: { sha256: string; sizeBytes: number };
  try {
    stored = await writeUploadedFile(storageKey, photo, PROFILE_PHOTO_MAX_BYTES);
  } catch (error) {
    await releaseTeacherStorageReservation(reservation, "Profile photo: release the reservation of a failed write");
    throw error;
  }

  const data = {
    profileImageUrl: url,
    profileImageStorageKey: storageKey,
    profileImageSha256: stored.sha256,
    profileImageSizeBytes: stored.sizeBytes,
    profileImageMimeType: mimeType,
  };

  let committed: boolean;
  try {
    committed = await commitTeacherStorageReservation(reservation, "TEACHER", async (tx) => {
      if (current) {
        // Compare-and-set: only if nobody changed the photo since it was read.
        const result = await tx.teacherProfile.updateMany({
          where: { teacherId, profileImageStorageKey: current.profileImageStorageKey, profileImageUrl: current.profileImageUrl },
          data,
        });
        return result.count === 1;
      }
      await tx.teacherProfile.create({ data: { teacherId, slug: `teacher-${teacherId}`, ...data }, select: { id: true } });
      return true;
    });
  } catch (error) {
    // Nothing was committed: only THIS attempt's file and reservation go.
    await removeStoredFileQuietly(storageKey, "Profile photo: discard the file of a photo that was not saved");
    await releaseTeacherStorageReservation(reservation, "Profile photo: release the reservation of a photo that was not saved");
    if (!current && isUniqueViolation(error)) return null; // another first upload created the profile: retry
    throw error;
  }

  if (!committed) {
    // Lost the compare-and-set (the reservation was removed in the same transaction).
    await removeStoredFileQuietly(storageKey, "Profile photo: discard the file of a superseded concurrent upload");
    return null;
  }

  // The new reference is committed: the previous unified photo is no longer referenced.
  const previous = current?.profileImageStorageKey ?? null;
  if (previous && previous !== storageKey) {
    if (!ownProfilePhotoKey(previous, teacherId)) {
      reportPhotoProblem(new Error("A profile photo key does not belong to its teacher; it was not deleted."), "Profile photo: replaced photo not deleted");
    } else {
      try {
        await removeStoredFileStrict(previous);
      } catch (error) {
        // Unreferenced now (not counted): the orphan sweep deletes it after the grace period.
        reportPhotoProblem(error, "Profile photo: the replaced photo could not be deleted (left for the orphan sweep)");
      }
    }
  }
  return { profileImageUrl: url };
}

// ---- Remove -------------------------------------------------------------------------------------------------

export type ProfilePhotoRemovalState = "REMOVED" | "PENDING";

/** The teacher removes their own photo. REMOVED, or PENDING (hidden; the file deletion is retried by maintenance). */
export async function removeTeacherProfilePhoto(input: { teacherId: string }): Promise<ProfilePhotoRemovalState> {
  const { teacherId } = input;
  if (typeof teacherId !== "string" || !STORAGE_ID.test(teacherId)) throw new AppError("Teacher not found.", 404, "TEACHER_NOT_FOUND");

  const current = await prisma.teacherProfile.findUnique({
    where: { teacherId },
    select: { profileImageUrl: true, profileImageStorageKey: true },
  });
  if (!current) return "REMOVED";

  if (current.profileImageStorageKey === null) {
    // A legacy photo (or none): hide it; the legacy file is kept (no automatic legacy cleanup).
    if (current.profileImageUrl !== null) {
      await prisma.teacherProfile.updateMany({
        where: { teacherId, profileImageStorageKey: null, profileImageUrl: current.profileImageUrl },
        data: { profileImageUrl: null },
      });
    }
    return "REMOVED";
  }

  // a. Hide it, keep the key (still counted until the file is gone). Idempotent when already pending.
  if (current.profileImageUrl !== null) {
    await prisma.teacherProfile.updateMany({
      where: { teacherId, profileImageStorageKey: current.profileImageStorageKey, profileImageUrl: current.profileImageUrl },
      data: { profileImageUrl: null },
    });
  }
  // b + c.
  return (await finishRemoval(teacherId)) === "REMOVED" ? "REMOVED" : "PENDING";
}

/** Deletes the file of a pending removal, then clears the columns. Never throws. */
async function finishRemoval(teacherId: string): Promise<"REMOVED" | "FAILED"> {
  try {
    const row = await prisma.teacherProfile.findUnique({
      where: { teacherId },
      select: { profileImageUrl: true, profileImageStorageKey: true },
    });
    // Nothing pending: no photo, finished elsewhere, or replaced by a new upload meanwhile.
    if (!row || row.profileImageStorageKey === null || row.profileImageUrl !== null) return "REMOVED";
    if (!ownProfilePhotoKey(row.profileImageStorageKey, teacherId)) {
      throw new Error("A profile photo key does not belong to its teacher; nothing was deleted.");
    }
    await removeStoredFileStrict(row.profileImageStorageKey);
    await prisma.teacherProfile.updateMany({
      where: { teacherId, profileImageStorageKey: row.profileImageStorageKey, profileImageUrl: null },
      data: { profileImageStorageKey: null, profileImageSha256: null, profileImageSizeBytes: null, profileImageMimeType: null },
    });
    return "REMOVED";
  } catch (error) {
    reportPhotoProblem(error, "Profile photo: removal left pending (retried by maintenance)");
    return "FAILED";
  }
}

// ---- Maintenance ----------------------------------------------------------------------------------------------

type Backoff = { attempts: number; nextAtMs: number };
const holder = globalThis as unknown as { slProfilePhotoRemovalBackoff?: Map<string, Backoff> };
const backoffs = () => (holder.slProfilePhotoRemovalBackoff ??= new Map());

/** Tests only. */
export function resetProfilePhotoMaintenanceStateForTests() {
  holder.slProfilePhotoRemovalBackoff = new Map();
}

export type PendingProfilePhotoReport = { examined: number; removed: number; failed: number; backoff: number };

/**
 * Finishes pending removals (profileImageUrl cleared, key still set). A failed
 * one is skipped for 1, 2, 4 ... 60 minutes (logged once per attempt). Never throws.
 */
export async function finishPendingProfilePhotoRemovals(options: { max?: number; deadlineMs?: number } = {}): Promise<PendingProfilePhotoReport> {
  const report: PendingProfilePhotoReport = { examined: 0, removed: 0, failed: 0, backoff: 0 };
  try {
    const rows = await prisma.teacherProfile.findMany({
      where: { profileImageStorageKey: { not: null }, profileImageUrl: null },
      orderBy: { teacherId: "asc" },
      take: options.max ?? 100,
      select: { teacherId: true },
    });
    for (const { teacherId } of rows) {
      if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) break;
      const entry = backoffs().get(teacherId);
      if (entry && entry.nextAtMs > Date.now()) {
        report.backoff++;
        continue;
      }
      report.examined++;
      if ((await finishRemoval(teacherId)) === "REMOVED") {
        report.removed++;
        backoffs().delete(teacherId);
      } else {
        report.failed++;
        const attempts = (entry?.attempts ?? 0) + 1;
        backoffs().set(teacherId, { attempts, nextAtMs: Date.now() + Math.min(60 * 60_000, 60_000 * 2 ** (attempts - 1)) });
      }
    }
  } catch (error) {
    reportPhotoProblem(error, "Profile photo: maintenance retry of pending removals");
  }
  return report;
}

export type ProfilePhotoSweepReport = {
  teachers: number;
  examined: number;
  deleted: number;
  kept: number;
  unknown: number;
  skippedLinks: number;
  errors: number;
  complete: boolean;
};

/**
 * Orphan sweep of Teachers/{t}/Profile/Photo/ ONLY (no other folder is ever
 * listed or touched). A file is deleted only when ALL hold: its name parses as
 * a photo key of that teacher; the teacher's row does not reference it
 * (database read first); no unexpired PROFILE_IMAGE reservation names it (an
 * upload in progress); and it was last modified before the grace period.
 * Links and unknown entries are never touched. Bounded; never throws.
 */
export async function sweepProfilePhotoOrphans(
  options: { nowMs?: number; graceMs?: number; maxDeletes?: number; maxTeachers?: number; deadlineMs?: number } = {}
): Promise<ProfilePhotoSweepReport> {
  const report: ProfilePhotoSweepReport = { teachers: 0, examined: 0, deleted: 0, kept: 0, unknown: 0, skippedLinks: 0, errors: 0, complete: false };
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = options.graceMs ?? PROFILE_PHOTO_ORPHAN_GRACE_MS;
  const maxDeletes = options.maxDeletes ?? 200;
  const maxTeachers = options.maxTeachers ?? 5_000;
  const stop = () => (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) || report.deleted >= maxDeletes;

  try {
    const teacherIds: string[] = [];
    for await (const entry of listStoredDirectory("Teachers", { limit: 100_000 })) {
      if (entry.kind === "directory" && STORAGE_ID.test(entry.name)) teacherIds.push(entry.name);
      else if (entry.kind === "other") report.skippedLinks++;
    }
    teacherIds.sort();

    for (const teacherId of teacherIds) {
      if (stop() || report.teachers >= maxTeachers) return report;
      report.teachers++;
      const dirKey = profilePhotoDirectoryKey(teacherId);

      const candidates: string[] = [];
      for await (const entry of listStoredDirectory(dirKey, { limit: 1_000 })) {
        if (entry.kind === "other") {
          report.skippedLinks++;
          continue;
        }
        const key = `${dirKey}/${entry.name}`;
        if (entry.kind !== "file" || !ownProfilePhotoKey(key, teacherId)) {
          report.unknown++;
          continue;
        }
        candidates.push(key);
      }
      if (candidates.length === 0) continue;

      // The database FIRST (then the file's age): what the row references and what uploads reserve.
      const [row, reservations] = await Promise.all([
        prisma.teacherProfile.findUnique({ where: { teacherId }, select: { profileImageStorageKey: true } }),
        prisma.storageReservation.findMany({
          where: { teacherId, category: "PROFILE_IMAGE", storageKey: { in: candidates }, expiresAt: { gt: new Date(nowMs) } },
          select: { storageKey: true },
        }),
      ]);
      const protectedKeys = new Set<string>(reservations.map((r) => r.storageKey));
      if (row?.profileImageStorageKey) protectedKeys.add(row.profileImageStorageKey);

      for (const key of candidates) {
        if (stop()) return report;
        report.examined++;
        if (protectedKeys.has(key)) {
          report.kept++;
          continue;
        }
        try {
          const info = await statStoredFile(key);
          if (!info) continue;
          if (nowMs - info.modifiedAtMs < graceMs) {
            report.kept++;
            continue;
          }
          await removeStoredFileStrict(key);
          report.deleted++;
        } catch (error) {
          report.errors++;
          reportPhotoProblem(error, "Profile photo: orphan sweep could not check or delete a file");
        }
      }
      await removeEmptyStoredDirectoryQuietly(dirKey);
    }
    report.complete = true;
  } catch (error) {
    report.errors++;
    reportPhotoProblem(error, "Profile photo: orphan sweep");
  }
  return report;
}

// ---- Serving --------------------------------------------------------------------------------------------------

/**
 * The photo named by the URL /api/teacher-photos/{teacherId}/{storedName},
 * served only while it is the teacher's CURRENT photo (an old, pending-removal
 * or unknown name is 404, so a replaced or removed photo is never served).
 */
export async function openTeacherProfilePhoto(
  teacherId: unknown,
  storedName: unknown
): Promise<{ file: OpenedStoredFile; mimeType: ProfilePhotoMimeType; sha256: string } | null> {
  const key = profilePhotoKeyFromRoute(teacherId, storedName);
  if (!key) return null;
  const row = await prisma.teacherProfile.findFirst({
    where: { teacherId: teacherId as string, profileImageStorageKey: key, profileImageUrl: { not: null } },
    select: { profileImageMimeType: true, profileImageSha256: true },
  });
  if (!row || !row.profileImageMimeType || !row.profileImageSha256) return null;
  const parsed = ownProfilePhotoKey(key, teacherId as string);
  if (!parsed || parsed.mimeType !== row.profileImageMimeType) return null;
  const file = await openProfilePhotoForRead(key);
  return { file, mimeType: parsed.mimeType, sha256: row.profileImageSha256 };
}
