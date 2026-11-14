/*
 * Recorded Lectures RL-3.3: SHA-256 computed while a chunk streams
 * (lib/recorded-lectures/chunk-stream.ts). Pure; no database, no files.
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
const { sha256Passthrough } = require(path.join(root, "lib", "recorded-lectures", "chunk-stream.ts"));

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const enc = (text) => new TextEncoder().encode(text);

async function drain(iterable) {
  const out = [];
  for await (const piece of iterable) out.push(piece);
  return out;
}

test("passes every piece through unchanged and in order; digest = SHA-256 of all of them", async () => {
  async function* source() {
    yield enc("ab");
    yield enc("");
    yield enc("cdef");
  }
  const hashing = sha256Passthrough(source());
  const pieces = await drain(hashing.source);
  assert.deepEqual(pieces.map((p) => new TextDecoder().decode(p)), ["ab", "cdef"], "empty pieces carry no bytes and are not passed on");
  assert.equal(hashing.bytes, 6);
  assert.equal(hashing.digest(), sha(Buffer.from("abcdef")));
  assert.match(hashing.digest(), /^[0-9a-f]{64}$/, "lowercase hex, stable on repeated calls");
});

test("accepts a web ReadableStream; the empty body hashes to SHA-256 of nothing", async () => {
  const stream = new ReadableStream({ start(c) { c.enqueue(enc("xyz")); c.close(); } });
  const hashing = sha256Passthrough(stream);
  await drain(hashing.source);
  assert.equal(hashing.digest(), sha(Buffer.from("xyz")));

  const empty = sha256Passthrough((async function* () {})());
  await drain(empty.source);
  assert.equal(empty.digest(), sha(Buffer.alloc(0)));
});

test("no digest unless the source was read to its end", async () => {
  async function* source() {
    yield enc("a");
    yield enc("b");
  }
  const hashing = sha256Passthrough(source());
  const iterator = hashing.source[Symbol.asyncIterator]();
  await iterator.next();
  assert.throws(() => hashing.digest(), /not read to its end/);
});

test("pieces are not collected: each is released to the consumer before the next is pulled", async () => {
  let pulled = 0;
  async function* source() {
    for (let i = 0; i < 5; i++) {
      pulled++;
      yield new Uint8Array(10);
    }
  }
  const hashing = sha256Passthrough(source());
  let consumed = 0;
  for await (const piece of hashing.source) {
    consumed++;
    assert.equal(pulled, consumed, "exactly one piece ahead at most");
    assert.equal(piece.byteLength, 10);
  }
});

test("a piece that is not bytes is refused", async () => {
  async function* source() {
    yield "not bytes";
  }
  await assert.rejects(drain(sha256Passthrough(source()).source), TypeError);
});

test("RL-3.5: pieces larger than 64 KiB are split, so a late write is at most 64 KiB; the bytes and hash are unchanged", async () => {
  const { MAX_WRITE_PIECE_BYTES, splitPiece } = require(path.join(root, "lib", "recorded-lectures", "chunk-stream.ts"));
  assert.equal(MAX_WRITE_PIECE_BYTES, 64 * 1024);
  const big = crypto.randomBytes(3 * 64 * 1024 + 5);
  async function* source() {
    yield big;
  }
  const hashing = sha256Passthrough(source());
  const pieces = await drain(hashing.source);
  assert.deepEqual(pieces.map((p) => p.byteLength), [65536, 65536, 65536, 5]);
  assert.ok(Buffer.concat(pieces.map((p) => Buffer.from(p))).equals(big));
  assert.equal(hashing.digest(), sha(big));
  assert.deepEqual([...splitPiece(new Uint8Array(0))], []);
  assert.deepEqual([...splitPiece(new Uint8Array(65536))].map((p) => p.byteLength), [65536]);
});
