import { createHash } from "node:crypto";

import type { ByteChunkSource } from "@/lib/file-storage/types";

/*
 * Recorded Lectures (RL-3.3): SHA-256 of a chunk computed while it streams
 * to disk. The wrapper passes the bytes through unchanged and in order, one
 * piece at a time (it never collects them), split into pieces of at most
 * MAX_WRITE_PIECE_BYTES (RL-3.5), so memory stays at one network piece; the
 * digest is available only after the source has been read to its end.
 */

/**
 * The largest piece handed to the file writer at once (RL-3.5). Larger network
 * pieces are split. This bounds what a writer that has passed its write
 * deadline can still write: the deadline is checked before every piece, so at
 * most ONE piece of at most this size can still be completing.
 */
export const MAX_WRITE_PIECE_BYTES = 64 * 1024;

/** Splits a piece into views of at most MAX_WRITE_PIECE_BYTES (no copy). */
export function* splitPiece(piece: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < piece.byteLength; offset += MAX_WRITE_PIECE_BYTES) {
    yield piece.subarray(offset, Math.min(piece.byteLength, offset + MAX_WRITE_PIECE_BYTES));
  }
}

export type HashingSource = {
  /** The pieces of the original source, unchanged and in order. */
  source: AsyncIterable<Uint8Array>;
  /** Lowercase hex SHA-256 of every piece passed through; throws unless the source was read to its end. */
  digest(): string;
  /** Bytes passed through so far. */
  readonly bytes: number;
};

function iterate(source: ByteChunkSource): AsyncIterable<Uint8Array> {
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const stream = source as ReadableStream<Uint8Array>;
    return {
      [Symbol.asyncIterator]() {
        const reader = stream.getReader();
        return {
          next: () => reader.read() as Promise<IteratorResult<Uint8Array>>,
          return: async () => {
            await reader.cancel().catch(() => undefined);
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
  return source as AsyncIterable<Uint8Array>;
}

export function sha256Passthrough(input: ByteChunkSource): HashingSource {
  const hash = createHash("sha256");
  let finished = false;
  let bytes = 0;
  let digest: string | null = null;

  async function* passthrough(): AsyncGenerator<Uint8Array> {
    for await (const piece of iterate(input)) {
      if (!(piece instanceof Uint8Array)) throw new TypeError("A chunk body piece is not bytes.");
      for (const part of splitPiece(piece)) {
        hash.update(part);
        bytes += part.byteLength;
        yield part;
      }
    }
    finished = true;
  }

  return {
    source: passthrough(),
    digest() {
      if (!finished) throw new Error("The chunk was not read to its end.");
      if (digest === null) digest = hash.digest("hex");
      return digest;
    },
    get bytes() {
      return bytes;
    },
  };
}
