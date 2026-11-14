import { StorageError } from "./types";

/*
 * Storage keys (Recorded Lectures RL-1): relative, "/"-separated names below
 * the storage root. Only conservative ASCII segments are accepted, so a key
 * can never express "..", an absolute path, a drive letter, a backslash, an
 * empty segment, a Windows device name or a name Windows would silently
 * alter (trailing dot). Keys are built by the feature code from generated
 * ids; this check is the last line of defence before the filesystem.
 */

export const MAX_STORAGE_KEY_LENGTH = 512;
export const MAX_STORAGE_KEY_DEPTH = 16;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function isValidSegment(segment: string): boolean {
  return SEGMENT.test(segment) && !segment.endsWith(".") && !WINDOWS_DEVICE.test(segment);
}

/** The key's segments; throws StorageError("INVALID_KEY") for anything unsafe. */
export function parseStorageKey(key: unknown): string[] {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_STORAGE_KEY_LENGTH) {
    throw new StorageError("INVALID_KEY");
  }
  const segments = key.split("/");
  if (segments.length > MAX_STORAGE_KEY_DEPTH || !segments.every(isValidSegment)) {
    throw new StorageError("INVALID_KEY");
  }
  return segments;
}

export function isValidStorageKey(key: unknown): key is string {
  try {
    parseStorageKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Joins validated segments into a key (throws INVALID_KEY). */
export function joinStorageKey(...segments: string[]): string {
  const key = segments.join("/");
  parseStorageKey(key);
  return key;
}

/** The parent key, or null for a top-level key. */
export function parentStorageKey(key: string): string | null {
  const segments = parseStorageKey(key);
  return segments.length > 1 ? segments.slice(0, -1).join("/") : null;
}
