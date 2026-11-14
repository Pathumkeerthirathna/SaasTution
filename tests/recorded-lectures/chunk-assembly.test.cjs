/*
 * Recorded Lectures RL-3.4: chunk plan, streaming assembly source and the D5
 * second pass (lib/recorded-lectures/chunk-assembly.ts), against a small
 * in-memory storage stand-in. No database.
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const A = require(path.join(root, "lib", "recorded-lectures", "chunk-assembly.ts"));
const { chunkScratchKey } = require(path.join(root, "lib", "recorded-lectures", "keys.ts"));
const { StorageError } = require(path.join(root, "lib", "file-storage", "types.ts"));

const UPLOAD = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const token = (n) => String(n).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, "a");

/** Files in memory; openRead streams them in small pieces. */
function memoryStorage(files, pieceSize = 7) {
  return {
    async openRead(key) {
      if (!files.has(key)) throw new StorageError("NOT_FOUND");
      const bytes = files.get(key);
      let at = 0;
      return {
        size: bytes.length,
        stream: new ReadableStream({
          pull(controller) {
            if (at >= bytes.length) return controller.close();
            controller.enqueue(new Uint8Array(bytes.subarray(at, at + pieceSize)));
            at += pieceSize;
          },
        }),
      };
    },
  };
}

function fixture() {
  const parts = [Buffer.from("first chunk--"), Buffer.from("second-chunk-bytes"), Buffer.from("tail")];
  let offset = 0;
  const rows = parts.map((bytes, i) => {
    const row = { chunkIndex: i, startOffset: BigInt(offset), byteLength: bytes.length, leaseToken: token(i + 1), sha256: sha(bytes) };
    offset += bytes.length;
    return row;
  });
  const files = new Map(parts.map((bytes, i) => [chunkScratchKey(UPLOAD, rows[i].leaseToken), bytes]));
  return { parts, rows, files, total: offset, whole: Buffer.concat(parts) };
}

async function collect(iterable) {
  const out = [];
  for await (const piece of iterable) out.push(Buffer.from(piece));
  return Buffer.concat(out);
}

test("planChunks: accepts an exact, contiguous description of the whole file (any row order)", () => {
  const { rows, total } = fixture();
  const plan = A.planChunks([rows[2], rows[0], rows[1]], { expectedBytes: total, chunkCount: 3 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.chunks.map((c) => [c.index, c.start, c.length]), [[0, 0, 13], [1, 13, 18], [2, 31, 4]]);
});

test("planChunks: refuses every inexact description", () => {
  const { rows, total } = fixture();
  const bad = (mutate, upload = { expectedBytes: total, chunkCount: 3 }) => {
    const copy = rows.map((r) => ({ ...r }));
    mutate(copy);
    return A.planChunks(copy, upload);
  };
  const invalid = { ok: false, problem: "CHUNK_PLAN_INVALID" };
  assert.deepEqual(bad(() => {}, { expectedBytes: total + 1, chunkCount: 3 }), invalid, "size");
  assert.deepEqual(bad(() => {}, { expectedBytes: total, chunkCount: 4 }), invalid, "count");
  assert.deepEqual(bad((r) => r.pop(), { expectedBytes: total, chunkCount: 3 }), invalid, "missing row");
  assert.deepEqual(bad((r) => (r[1].startOffset += BigInt(1))), invalid, "gap");
  assert.deepEqual(bad((r) => (r[1].startOffset -= BigInt(1))), invalid, "overlap");
  assert.deepEqual(bad((r) => ([r[0].chunkIndex, r[1].chunkIndex] = [1, 0])), invalid, "order");
  assert.deepEqual(bad((r) => (r[2].chunkIndex = 5)), invalid, "index hole");
  assert.deepEqual(bad((r) => (r[0].sha256 = null)), invalid, "no hash");
  assert.deepEqual(bad((r) => (r[0].sha256 = "A".repeat(64))), invalid, "hash format");
  assert.deepEqual(bad((r) => (r[0].leaseToken = "x")), invalid, "token");
  assert.deepEqual(bad((r) => (r[0].byteLength = 0)), invalid, "empty chunk");
  assert.deepEqual(bad((r) => (r[0].startOffset = BigInt(2) ** BigInt(60))), invalid, "unsafe offset");
  assert.deepEqual(A.planChunks([], { expectedBytes: 1, chunkCount: 0 }), invalid, "no chunks");
});

test("assembledChunkSource: yields exactly the chunk bytes, in order, in small pieces", async () => {
  const { rows, files, total, whole } = fixture();
  const { chunks } = A.planChunks(rows, { expectedBytes: total, chunkCount: 3 });
  const holder = { fault: null };
  let beforePiece = 0;
  const out = await collect(A.assembledChunkSource(memoryStorage(files), UPLOAD, chunks, holder, async () => void beforePiece++));
  assert.ok(out.equals(whole));
  assert.equal(holder.fault, null);
  assert.equal(beforePiece, Math.ceil(13 / 7) + Math.ceil(18 / 7) + Math.ceil(4 / 7), "called before every piece");
});

test("assembledChunkSource: missing file, wrong size and wrong content are AssemblyFaults recorded in the holder", async () => {
  const cases = [
    [(files, rows) => files.delete(chunkScratchKey(UPLOAD, rows[1].leaseToken)), "CHUNK_MISSING"],
    [(files, rows) => files.set(chunkScratchKey(UPLOAD, rows[1].leaseToken), Buffer.from("second-chunk-bytes!")), "CHUNK_SIZE_MISMATCH"],
    [(files, rows) => files.set(chunkScratchKey(UPLOAD, rows[1].leaseToken), Buffer.from("SECOND-chunk-bytes")), "CHUNK_HASH_MISMATCH"],
  ];
  for (const [mutate, code] of cases) {
    const { rows, files, total } = fixture();
    const { chunks } = A.planChunks(rows, { expectedBytes: total, chunkCount: 3 });
    mutate(files, rows);
    const holder = { fault: null };
    await assert.rejects(collect(A.assembledChunkSource(memoryStorage(files), UPLOAD, chunks, holder)), { name: "AssemblyFault", code });
    assert.equal(holder.fault.code, code);
  }
});

test("assembledChunkSource: a stop from beforePiece (claim lost) is recorded and stops the stream", async () => {
  const { rows, files, total } = fixture();
  const { chunks } = A.planChunks(rows, { expectedBytes: total, chunkCount: 3 });
  const holder = { fault: null };
  let calls = 0;
  const stop = new Error("claim lost");
  await assert.rejects(
    collect(A.assembledChunkSource(memoryStorage(files), UPLOAD, chunks, holder, async () => {
      if (++calls === 3) throw stop;
    })),
    /claim lost/
  );
  assert.equal(holder.fault, stop);
});

test("verifyAssembledFile: exact ranges and size; any change is detected", async () => {
  const { rows, total, whole } = fixture();
  const { chunks } = A.planChunks(rows, { expectedBytes: total, chunkCount: 3 });
  const check = (bytes, pieceSize) => A.verifyAssembledFile(memoryStorage(new Map([["k", bytes]]), pieceSize), "k", chunks, total);
  for (const pieceSize of [1, 5, 13, 64]) assert.equal(await check(whole, pieceSize), null, `piece ${pieceSize}`);
  const flipped = Buffer.from(whole);
  flipped[20] ^= 1;
  assert.equal(await check(flipped, 5), "ASSEMBLY_HASH_MISMATCH");
  assert.equal(await check(Buffer.concat([whole, Buffer.from([0])]), 5), "ASSEMBLY_SIZE_MISMATCH");
  assert.equal(await check(whole.subarray(0, total - 1), 5), "ASSEMBLY_SIZE_MISMATCH");
  // Swapping two chunks keeps the size but not the ranges.
  const swapped = Buffer.concat([whole.subarray(13, 31), whole.subarray(0, 13), whole.subarray(31)]);
  assert.equal(await check(swapped, 7), "ASSEMBLY_HASH_MISMATCH");
});
