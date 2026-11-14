import { createHash } from "node:crypto";

import { isStorageError, type FileStorage } from "@/lib/file-storage/types";

import { byteCountToNumber } from "./bigint";
import { splitPiece } from "./chunk-stream";
import { chunkScratchKey, isLeaseToken } from "./keys";

/*
 * Recorded Lectures (RL-3.4): verifying and joining the committed chunks of
 * an upload (Option B: one file per chunk, System/TemporaryUploads/
 * {uploadId}.{leaseToken}.chunk).
 *
 *   planChunks              the committed chunk records must describe the whole
 *                           file exactly: indexes 0..n-1, offsets contiguous from
 *                           0, lengths summing to expectedBytes, a SHA-256 each;
 *   assembledChunkSource    streams the chunk files in that order (bounded pieces,
 *                           never a whole chunk in memory), checking each file's
 *                           exact size and SHA-256 when it ends;
 *   verifyAssembledFile     the second D5 pass: reads the assembled file once and
 *                           checks exactly each recorded range against its hash,
 *                           and the exact total size.
 *
 * Failures that prove the upload is bad are AssemblyFault (a database failure
 * code). Anything else (I/O) is left as is: a temporary failure.
 */

export type CompletionFailureCode =
  | "CHUNK_PLAN_INVALID"
  | "CHUNK_MISSING"
  | "CHUNK_SIZE_MISMATCH"
  | "CHUNK_HASH_MISMATCH"
  | "ASSEMBLY_SIZE_MISMATCH"
  | "ASSEMBLY_HASH_MISMATCH";

/** A verification failure that proves the upload is bad (permanent). */
export class AssemblyFault extends Error {
  readonly code: CompletionFailureCode;

  constructor(code: CompletionFailureCode) {
    super(`Upload verification failed: ${code}.`);
    this.name = "AssemblyFault";
    this.code = code;
  }
}

export type ChunkRecord = {
  chunkIndex: number;
  startOffset: bigint;
  byteLength: number;
  leaseToken: string;
  sha256: string | null;
};

export type PlannedChunk = { index: number; start: number; length: number; token: string; sha256: string };

const SHA256 = /^[0-9a-f]{64}$/;

/** The committed chunk records must describe exactly the whole file. */
export function planChunks(
  rows: readonly ChunkRecord[],
  upload: { expectedBytes: number; chunkCount: number }
): { ok: true; chunks: PlannedChunk[] } | { ok: false; problem: "CHUNK_PLAN_INVALID" } {
  const invalid = { ok: false as const, problem: "CHUNK_PLAN_INVALID" as const };
  if (!Number.isSafeInteger(upload.expectedBytes) || upload.expectedBytes < 1) return invalid;
  if (rows.length === 0 || rows.length !== upload.chunkCount) return invalid;

  const sorted = [...rows].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const chunks: PlannedChunk[] = [];
  let next = 0;
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    let start: number;
    try {
      start = byteCountToNumber(row.startOffset, "startOffset");
    } catch {
      return invalid;
    }
    if (row.chunkIndex !== i) return invalid;
    if (start !== next) return invalid;
    if (!Number.isSafeInteger(row.byteLength) || row.byteLength < 1) return invalid;
    if (typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) return invalid;
    if (!isLeaseToken(row.leaseToken)) return invalid;
    chunks.push({ index: i, start, length: row.byteLength, token: row.leaseToken, sha256: row.sha256 });
    next = start + row.byteLength;
  }
  if (next !== upload.expectedBytes) return invalid;
  return { ok: true, chunks };
}

/** Records why a source stopped (storage wraps a source's errors as IO_ERROR). */
export type FaultHolder = { fault: Error | null };

async function* readPieces(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * The chunk files, in order, as one stream of pieces. Each file's size and
 * SHA-256 are checked when it ends (AssemblyFault). `beforePiece` runs before
 * each piece (the completion heartbeat; it may throw to stop). Any error is
 * recorded in `holder` before it propagates.
 */
export async function* assembledChunkSource(
  storage: Pick<FileStorage, "openRead">,
  uploadId: string,
  chunks: readonly PlannedChunk[],
  holder: FaultHolder,
  beforePiece?: () => Promise<void>
): AsyncGenerator<Uint8Array> {
  try {
    for (const chunk of chunks) {
      let opened: { stream: ReadableStream<Uint8Array>; size: number };
      try {
        opened = await storage.openRead(chunkScratchKey(uploadId, chunk.token));
      } catch (error) {
        if (isStorageError(error, "NOT_FOUND")) throw new AssemblyFault("CHUNK_MISSING");
        throw error;
      }
      if (opened.size !== chunk.length) {
        await opened.stream.cancel().catch(() => undefined);
        throw new AssemblyFault("CHUNK_SIZE_MISMATCH");
      }
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const read of readPieces(opened.stream)) {
        // At most MAX_WRITE_PIECE_BYTES per write (RL-3.5): bounds a stale job's last write.
        for (const piece of splitPiece(read)) {
          if (beforePiece) await beforePiece();
          bytes += piece.byteLength;
          if (bytes > chunk.length) throw new AssemblyFault("CHUNK_SIZE_MISMATCH");
          hash.update(piece);
          yield piece;
        }
      }
      if (bytes !== chunk.length) throw new AssemblyFault("CHUNK_SIZE_MISMATCH");
      if (hash.digest("hex") !== chunk.sha256) throw new AssemblyFault("CHUNK_HASH_MISMATCH");
    }
  } catch (error) {
    holder.fault = error instanceof Error ? error : new Error(String(error));
    throw error;
  }
}

/**
 * D5 second pass over the assembled file: exact total size, and every
 * recorded range (startOffset, byteLength) against its stored SHA-256.
 * Returns the failure code, or null when everything matches.
 */
export async function verifyAssembledFile(
  storage: Pick<FileStorage, "openRead">,
  key: string,
  chunks: readonly PlannedChunk[],
  expectedBytes: number,
  beforePiece?: () => Promise<void>
): Promise<"ASSEMBLY_SIZE_MISMATCH" | "ASSEMBLY_HASH_MISMATCH" | null> {
  const opened = await storage.openRead(key);
  if (opened.size !== expectedBytes) {
    await opened.stream.cancel().catch(() => undefined);
    return "ASSEMBLY_SIZE_MISMATCH";
  }

  let index = 0;
  let hash = createHash("sha256");
  let inChunk = 0;
  let total = 0;
  for await (const piece of readPieces(opened.stream)) {
    if (beforePiece) await beforePiece();
    total += piece.byteLength;
    if (total > expectedBytes) return "ASSEMBLY_SIZE_MISMATCH";
    let offset = 0;
    while (offset < piece.byteLength) {
      const chunk = chunks[index];
      if (!chunk) return "ASSEMBLY_SIZE_MISMATCH";
      const take = Math.min(chunk.length - inChunk, piece.byteLength - offset);
      hash.update(piece.subarray(offset, offset + take));
      offset += take;
      inChunk += take;
      if (inChunk === chunk.length) {
        if (hash.digest("hex") !== chunk.sha256) return "ASSEMBLY_HASH_MISMATCH";
        index++;
        inChunk = 0;
        hash = createHash("sha256");
      }
    }
  }
  if (total !== expectedBytes || index !== chunks.length) return "ASSEMBLY_SIZE_MISMATCH";
  return null;
}
