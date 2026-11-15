import type { ProfilePhotoMimeType } from "@/lib/profile-images/storage-keys";

/*
 * Profile photos: the image type from the file's OWN bytes (never the
 * browser's MIME type or file name). Only JPEG, PNG and WebP are accepted;
 * SVG, HTML, GIF and anything else (or a truncated / malformed file) is
 * refused. Pure: the caller passes the first and last bytes and the size.
 *
 *   JPEG  starts FF D8 FF, ends with the EOI marker FF D9 (trailing padding of
 *         at most 32 bytes tolerated: some encoders add it).
 *   PNG   the 8-byte signature, then an IHDR chunk of length 13 with a non-zero
 *         width and height; ends with the IEND chunk (and its fixed CRC).
 *   WebP  "RIFF" + little-endian size + "WEBP" + a VP8 / VP8L / VP8X chunk; the
 *         RIFF size must account for the whole file exactly.
 *
 * This is a structural check, not a decoder: it reliably rejects files that
 * are not images of these types (the attack surface here: scripts / markup
 * served from our origin), while the response headers (nosniff, sandbox CSP)
 * make sure nothing is ever rendered as anything but an image.
 */

/** Bytes the caller must provide from each end of the file. */
export const SIGNATURE_HEAD_BYTES = 64;
export const SIGNATURE_TAIL_BYTES = 64;
const MIN_IMAGE_BYTES = 32;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((value, i) => bytes[offset + i] === value);
const ascii = (bytes: Uint8Array, offset: number, text: string) => startsWith(bytes, [...text].map((c) => c.charCodeAt(0)), offset);
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u32le = (b: Uint8Array, o: number) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] as const;

function isJpeg(head: Uint8Array, tail: Uint8Array): boolean {
  if (!startsWith(head, [0xff, 0xd8, 0xff])) return false;
  // The marker after SOI: APPn / DQT / SOFn / COM / DHT ... (never 0x00 / 0xFF).
  if (head[3] === undefined || head[3] === 0x00 || head[3] === 0xff) return false;
  const window = tail.subarray(Math.max(0, tail.length - 34));
  for (let i = window.length - 2; i >= 0; i -= 1) {
    if (window[i] === 0xff && window[i + 1] === 0xd9) {
      // Only zero padding may follow the end marker.
      return window.subarray(i + 2).every((b) => b === 0x00);
    }
  }
  return false;
}

function isPng(head: Uint8Array, tail: Uint8Array): boolean {
  if (!startsWith(head, PNG_SIGNATURE)) return false;
  if (head.length < 24 || u32be(head, 8) !== 13 || !ascii(head, 12, "IHDR")) return false;
  if (u32be(head, 16) === 0 || u32be(head, 20) === 0) return false;
  return tail.length >= PNG_IEND.length && startsWith(tail, PNG_IEND, tail.length - PNG_IEND.length);
}

function isWebp(head: Uint8Array, size: number): boolean {
  if (head.length < 16 || !ascii(head, 0, "RIFF") || !ascii(head, 8, "WEBP")) return false;
  if (u32le(head, 4) + 8 !== size) return false;
  return ascii(head, 12, "VP8 ") || ascii(head, 12, "VP8L") || ascii(head, 12, "VP8X");
}

/** The detected type, or null (not an accepted image, or malformed). */
export function detectProfilePhotoType(input: { head: Uint8Array; tail: Uint8Array; size: number }): ProfilePhotoMimeType | null {
  const { head, tail, size } = input;
  if (!Number.isSafeInteger(size) || size < MIN_IMAGE_BYTES) return null;
  if (isJpeg(head, tail)) return "image/jpeg";
  if (isPng(head, tail)) return "image/png";
  if (isWebp(head, size)) return "image/webp";
  return null;
}

/** Reads the head and tail of a Blob (at most 128 bytes) and detects its type. */
export async function detectBlobProfilePhotoType(blob: Blob): Promise<ProfilePhotoMimeType | null> {
  const size = blob.size;
  const head = new Uint8Array(await blob.slice(0, SIGNATURE_HEAD_BYTES).arrayBuffer());
  const tail = new Uint8Array(await blob.slice(Math.max(0, size - SIGNATURE_TAIL_BYTES), size).arrayBuffer());
  return detectProfilePhotoType({ head, tail, size });
}
