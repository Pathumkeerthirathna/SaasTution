import { randomBytes } from "node:crypto";

import { joinStorageKey, parseStorageKey } from "@/lib/file-storage/keys";
import { STORAGE_ID } from "@/lib/notes/storage-keys";

/*
 * Student assignment submission storage keys (unified storage, Stage 2),
 * relative to FILE_STORAGE_ROOT:
 *
 *   Teachers/{teacherId}/Lectures/{lectureId}/Assignments/{assignmentId}/Submissions/{submissionId}/{32 hex}.pdf
 *
 * Submissions are PDF only, so the stored name is always 128 random bits +
 * ".pdf"; nothing from the browser (file name, path) is part of a key. Every
 * replacement (resubmission) gets a NEW random name under the same
 * submission id, so the previous file is never overwritten in place. The same
 * pattern is enforced by the CHECK constraint in migration
 * 20261115120000_add_unified_file_storage_keys.
 */

const SUBMISSION_STORED_NAME = /^[0-9a-f]{32}\.pdf$/;

function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || !STORAGE_ID.test(value)) throw new Error(`Invalid ${what} for a storage key.`);
  return value;
}

export function generateSubmissionStoredName(): string {
  return `${randomBytes(16).toString("hex")}.pdf`;
}

export type SubmissionKeyIds = { teacherId: string; lectureId: string; assignmentId: string; submissionId: string };

export function submissionDirectoryKey(ids: SubmissionKeyIds): string {
  return joinStorageKey(
    "Teachers",
    requireId(ids.teacherId, "teacher id"),
    "Lectures",
    requireId(ids.lectureId, "lecture id"),
    "Assignments",
    requireId(ids.assignmentId, "assignment id"),
    "Submissions",
    requireId(ids.submissionId, "submission id")
  );
}

export function submissionFileKey(ids: SubmissionKeyIds & { storedName: string }): string {
  if (!SUBMISSION_STORED_NAME.test(ids.storedName)) throw new Error("Invalid stored submission file name.");
  return `${submissionDirectoryKey(ids)}/${ids.storedName}`;
}

/** Parses a key written by this module; null for anything else (never opened as a submission file). */
export function parseSubmissionStorageKey(key: unknown): (SubmissionKeyIds & { storedName: string }) | null {
  let segments: string[];
  try {
    segments = parseStorageKey(key);
  } catch {
    return null;
  }
  if (
    segments.length !== 9 ||
    segments[0] !== "Teachers" ||
    !STORAGE_ID.test(segments[1]) ||
    segments[2] !== "Lectures" ||
    !STORAGE_ID.test(segments[3]) ||
    segments[4] !== "Assignments" ||
    !STORAGE_ID.test(segments[5]) ||
    segments[6] !== "Submissions" ||
    !STORAGE_ID.test(segments[7]) ||
    !SUBMISSION_STORED_NAME.test(segments[8])
  ) {
    return null;
  }
  return { teacherId: segments[1], lectureId: segments[3], assignmentId: segments[5], submissionId: segments[7], storedName: segments[8] };
}

export function isSubmissionStorageKey(key: unknown): key is string {
  return parseSubmissionStorageKey(key) !== null;
}

/**
 * Rollback window (Stage 2.1 dual-write): the legacy-location copy of a
 * submission stored at `storageKey`, as the pre-Stage-2 application reads it
 * (<cwd>/storage/{this path}): assignments/{assignmentId}/{same random name}.
 */
export function submissionLegacyCopyPath(storageKey: string): string {
  const parsed = parseSubmissionStorageKey(storageKey);
  if (!parsed) throw new Error("Invalid submission storage key.");
  return `assignments/${parsed.assignmentId}/${parsed.storedName}`;
}
