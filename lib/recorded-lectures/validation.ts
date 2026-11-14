import { formatDecimalSize, type RecordedLectureConfig } from "./config";

/*
 * Recorded Lectures request validation (RL-1). Pure: no I/O, no database.
 *
 * Only MP4 (video/mp4, ".mp4") is accepted initially; the codecs (H.264
 * video + AAC audio) are checked from the file itself by mp4-inspect.ts.
 */

export const RECORDING_MIME_TYPE = "video/mp4";
export const MAX_RECORDING_TITLE_LENGTH = 200;
export const MAX_DISPLAY_FILE_NAME_LENGTH = 200;

export type UploadDeclarationProblem =
  | "TITLE_REQUIRED"
  | "TITLE_TOO_LONG"
  | "PART_NUMBER_INVALID"
  | "PART_NUMBER_TOO_HIGH"
  | "FILE_NAME_INVALID"
  | "MIME_TYPE_NOT_SUPPORTED"
  | "FILE_SIZE_INVALID"
  | "FILE_EMPTY"
  | "FILE_TOO_LARGE";

export type UploadDeclaration = {
  title: string;
  partNumber: number;
  /** For display only; never part of a storage key. */
  displayFileName: string;
  mimeType: typeof RECORDING_MIME_TYPE;
  sizeBytes: number;
};

export type UploadDeclarationResult =
  | { ok: true; value: UploadDeclaration }
  | { ok: false; problem: UploadDeclarationProblem; message: string };

// Control characters and bidirectional overrides/isolates (display spoofing).
const UNSAFE_NAME_CHARS = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

/** A file name made safe for display (no folders, control or bidi characters), always ending ".mp4". */
export function sanitizeRecordingDisplayName(name: unknown, fallback = "recording"): string {
  let base = typeof name === "string" ? name.normalize("NFC") : "";
  base = base.split(/[\\/]/).pop() ?? "";
  base = base.replace(UNSAFE_NAME_CHARS, "").replace(/\s+/gu, " ").trim();
  if (/\.mp4$/i.test(base)) base = base.slice(0, -4).trim();
  if (base === "" || /^\.+$/.test(base)) base = fallback;
  const maxBase = MAX_DISPLAY_FILE_NAME_LENGTH - 4;
  const codePoints = Array.from(base);
  if (codePoints.length > maxBase) base = codePoints.slice(0, maxBase).join("").trim();
  return `${base}.mp4`;
}

function fail(problem: UploadDeclarationProblem, message: string): UploadDeclarationResult {
  return { ok: false, problem, message };
}

/** Validates what a teacher declares when starting an upload (the file itself is checked later). */
export function validateUploadDeclaration(
  input: { title?: unknown; partNumber?: unknown; fileName?: unknown; mimeType?: unknown; sizeBytes?: unknown },
  config: Pick<RecordedLectureConfig, "maxPartBytes" | "maxPartsPerLecture">
): UploadDeclarationResult {
  const title = typeof input.title === "string" ? input.title.normalize("NFC").replace(UNSAFE_NAME_CHARS, "").trim() : "";
  if (title === "") return fail("TITLE_REQUIRED", "A title is required.");
  if (Array.from(title).length > MAX_RECORDING_TITLE_LENGTH) {
    return fail("TITLE_TOO_LONG", `The title must be at most ${MAX_RECORDING_TITLE_LENGTH} characters.`);
  }

  const part = input.partNumber;
  if (typeof part !== "number" || !Number.isSafeInteger(part) || part < 1 || part > 2_147_483_647) {
    return fail("PART_NUMBER_INVALID", "The part number must be a whole number of at least 1.");
  }
  if (config.maxPartsPerLecture !== null && part > config.maxPartsPerLecture) {
    return fail("PART_NUMBER_TOO_HIGH", `A lecture can have at most ${config.maxPartsPerLecture} parts.`);
  }

  if (typeof input.fileName !== "string" || !/\.mp4$/i.test(input.fileName.trim())) {
    return fail("FILE_NAME_INVALID", "Only MP4 files (.mp4) can be uploaded.");
  }
  if (input.mimeType !== RECORDING_MIME_TYPE) {
    return fail("MIME_TYPE_NOT_SUPPORTED", "Only MP4 video (H.264 with AAC audio) can be uploaded.");
  }

  const size = input.sizeBytes;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    return fail("FILE_SIZE_INVALID", "The file size must be a whole number of bytes.");
  }
  if (size === 0) return fail("FILE_EMPTY", "The file is empty.");
  if (size > config.maxPartBytes) {
    return fail("FILE_TOO_LARGE", `Each recording part can be at most ${formatDecimalSize(config.maxPartBytes)}.`);
  }

  return {
    ok: true,
    value: {
      title,
      partNumber: part,
      displayFileName: sanitizeRecordingDisplayName(input.fileName),
      mimeType: RECORDING_MIME_TYPE,
      sizeBytes: size,
    },
  };
}

// ---- Chunk request headers ----------------------------------------------------------------------

export const UPLOAD_OFFSET_HEADER = "Upload-Offset";

export type ChunkHeaderProblem =
  | "OFFSET_REQUIRED"
  | "OFFSET_INVALID"
  | "OFFSET_MISMATCH"
  | "LENGTH_REQUIRED"
  | "LENGTH_INVALID"
  | "CHUNK_TOO_LARGE"
  | "CHUNK_EXCEEDS_REMAINING"
  | "UPLOAD_ALREADY_COMPLETE";

export type ChunkHeaderResult =
  | { ok: true; offset: number; length: number }
  | { ok: false; problem: ChunkHeaderProblem; receivedBytes: number };

const DECIMAL = /^\d{1,16}$/;

function headerNumber(value: string | null): number | null | "missing" {
  if (value === null) return "missing";
  const text = value.trim();
  if (!DECIMAL.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * Checks a chunk request's headers against the upload's state, BEFORE its
 * body is read: Upload-Offset must equal receivedBytes; Content-Length is
 * required, positive, at most one chunk and at most the bytes remaining.
 */
export function parseChunkRequestHeaders(
  headers: Headers,
  upload: { expectedBytes: number; receivedBytes: number },
  config: Pick<RecordedLectureConfig, "chunkBytes">
): ChunkHeaderResult {
  const { expectedBytes, receivedBytes } = upload;
  const failWith = (problem: ChunkHeaderProblem): ChunkHeaderResult => ({ ok: false, problem, receivedBytes });

  if (receivedBytes >= expectedBytes) return failWith("UPLOAD_ALREADY_COMPLETE");

  const offset = headerNumber(headers.get(UPLOAD_OFFSET_HEADER));
  if (offset === "missing") return failWith("OFFSET_REQUIRED");
  if (offset === null) return failWith("OFFSET_INVALID");
  if (offset !== receivedBytes) return failWith("OFFSET_MISMATCH");

  const length = headerNumber(headers.get("Content-Length"));
  if (length === "missing") return failWith("LENGTH_REQUIRED");
  if (length === null || length === 0) return failWith("LENGTH_INVALID");
  if (length > config.chunkBytes) return failWith("CHUNK_TOO_LARGE");
  if (length > expectedBytes - receivedBytes) return failWith("CHUNK_EXCEEDS_REMAINING");

  return { ok: true, offset, length };
}
