import { randomBytes } from "node:crypto";

import { joinStorageKey, parseStorageKey } from "@/lib/file-storage/keys";
import { STORAGE_ID } from "@/lib/notes/storage-keys";

/*
 * Teacher profile photo storage keys (unified storage), relative to
 * FILE_STORAGE_ROOT:
 *
 *   Teachers/{teacherId}/Profile/Photo/{32 hex}.{jpg|png|webp}
 *
 * Every segment is server-side: the teacher id comes from the session, the
 * name is 128 random bits, and the extension follows the type detected from
 * the file's own bytes (lib/profile-images/image-signature.ts), never the
 * browser's file name. Every upload gets a NEW key, so a stored photo is
 * never overwritten and its URL can be cached forever.
 *
 * The same pattern (and the owner prefix) is enforced by the CHECK
 * constraints of migration 20261117120100_add_teacher_profile_image_storage.
 */

export const PROFILE_PHOTO_MAX_BYTES = 2 * 1024 * 1024;

/** The accepted photo types mapped to the stored extension. */
export const PROFILE_PHOTO_EXTENSIONS: Readonly<Record<ProfilePhotoMimeType, string>> = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
});

export type ProfilePhotoMimeType = "image/jpeg" | "image/png" | "image/webp";

const STORED_NAME = /^[0-9a-f]{32}\.(jpg|png|webp)$/;
const MIME_BY_EXTENSION: Readonly<Record<string, ProfilePhotoMimeType>> = Object.freeze({
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
});

export function isProfilePhotoMimeType(value: unknown): value is ProfilePhotoMimeType {
  return typeof value === "string" && Object.hasOwn(PROFILE_PHOTO_EXTENSIONS, value);
}

function requireTeacherId(value: unknown): string {
  if (typeof value !== "string" || !STORAGE_ID.test(value)) throw new Error("Invalid teacher id for a storage key.");
  return value;
}

/** A new stored name: 128 random bits (hex) plus the extension of the detected type. */
export function generateProfilePhotoStoredName(mimeType: ProfilePhotoMimeType): string {
  if (!isProfilePhotoMimeType(mimeType)) throw new Error("Unsupported profile photo type.");
  return `${randomBytes(16).toString("hex")}${PROFILE_PHOTO_EXTENSIONS[mimeType]}`;
}

/** Teachers/{teacherId}/Profile/Photo */
export function profilePhotoDirectoryKey(teacherId: string): string {
  return joinStorageKey("Teachers", requireTeacherId(teacherId), "Profile", "Photo");
}

export function profilePhotoKey(input: { teacherId: string; storedName: string }): string {
  if (!STORED_NAME.test(input.storedName)) throw new Error("Invalid stored profile photo name.");
  return `${profilePhotoDirectoryKey(input.teacherId)}/${input.storedName}`;
}

export type ParsedProfilePhotoKey = { teacherId: string; storedName: string; mimeType: ProfilePhotoMimeType };

/** Parses a key written by this module; null for anything else (never opened or deleted as a photo). */
export function parseProfilePhotoKey(key: unknown): ParsedProfilePhotoKey | null {
  let segments: string[];
  try {
    segments = parseStorageKey(key);
  } catch {
    return null;
  }
  if (
    segments.length !== 5 ||
    segments[0] !== "Teachers" ||
    !STORAGE_ID.test(segments[1]) ||
    segments[2] !== "Profile" ||
    segments[3] !== "Photo" ||
    !STORED_NAME.test(segments[4])
  ) {
    return null;
  }
  const extension = segments[4].slice(segments[4].lastIndexOf(".") + 1);
  return { teacherId: segments[1], storedName: segments[4], mimeType: MIME_BY_EXTENSION[extension] };
}

/** The key, only if it is a photo key of THIS teacher (ownership check before any read or delete). */
export function ownProfilePhotoKey(key: unknown, teacherId: string): ParsedProfilePhotoKey | null {
  const parsed = parseProfilePhotoKey(key);
  return parsed && parsed.teacherId === teacherId ? parsed : null;
}

/**
 * The display URL stored in TeacherProfile.profileImageUrl for a unified
 * photo. The stored name is unique per upload, so the URL is a version: it
 * can be cached as immutable and changes on every replacement.
 */
export const PROFILE_PHOTO_URL_PREFIX = "/api/teacher-photos/";

export function profilePhotoUrl(input: { teacherId: string; storedName: string }): string {
  if (!STORED_NAME.test(input.storedName)) throw new Error("Invalid stored profile photo name.");
  return `${PROFILE_PHOTO_URL_PREFIX}${encodeURIComponent(requireTeacherId(input.teacherId))}/${input.storedName}`;
}

/** Route parameters of the photo URL -> the key they name; null when anything is invalid. */
export function profilePhotoKeyFromRoute(teacherId: unknown, storedName: unknown): string | null {
  if (typeof teacherId !== "string" || !STORAGE_ID.test(teacherId)) return null;
  if (typeof storedName !== "string" || !STORED_NAME.test(storedName)) return null;
  return profilePhotoKey({ teacherId, storedName });
}
