/*
 * HTTP Range parsing (Recorded Lectures RL-1), RFC 9110 section 14.
 *
 * Only a single byte range is served:
 *   bytes=a-b   -> a..min(b, size-1)
 *   bytes=a-    -> a..size-1
 *   bytes=-n    -> the last n bytes (n = 0 is unsatisfiable)
 * A start at or beyond the size is unsatisfiable (416). Anything else (no
 * header, another unit, several ranges, a malformed or inverted range,
 * numbers too long to be exact) is ignored and the whole file is served
 * (200), which the RFC allows. Pure: no I/O.
 */

export type RangeRequest =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

// The range unit is case-insensitive (RFC 9110 section 14.1).
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/i;
const MAX_DIGITS = 15; // every 15-digit number is an exact JavaScript integer

function parseNumber(text: string): number | null {
  if (text.length === 0 || text.length > MAX_DIGITS) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseRangeHeader(header: string | null | undefined, size: number): RangeRequest {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid file size.");
  if (typeof header !== "string") return { kind: "full" };

  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) return { kind: "full" };
  const [, first, last] = match;
  if (first === "" && last === "") return { kind: "full" };

  if (first === "") {
    const suffix = parseNumber(last);
    if (suffix === null) return { kind: "full" };
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = parseNumber(first);
  if (start === null) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };

  if (last === "") return { kind: "partial", start, end: size - 1 };
  const end = parseNumber(last);
  if (end === null || end < start) return { kind: "full" };
  return { kind: "partial", start, end: Math.min(end, size - 1) };
}

export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

export function unsatisfiedContentRangeHeader(size: number): string {
  return `bytes */${size}`;
}
