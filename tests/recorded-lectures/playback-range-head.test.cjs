/*
 * Recorded Lectures RL-1: HTTP Range parsing (lib/file-storage/http-range.ts)
 * and the GET / HEAD playback response foundation
 * (lib/recorded-lectures/stream-response.ts). Used by the student stream route
 * since RL-4.3 (lifecycle, slots and idle timeout: stream-lifecycle.test.cjs).
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { parseRangeHeader, contentRangeHeader, unsatisfiedContentRangeHeader } = require(path.join(root, "lib", "file-storage", "http-range.ts"));
const { createRecordingStreamResponse } = require(path.join(root, "lib", "recorded-lectures", "stream-response.ts"));
const { LocalFileStorage } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));
const { StorageError } = require(path.join(root, "lib", "file-storage", "types.ts"));

// ---- Range parsing --------------------------------------------------------------------------------------

test("parseRangeHeader: single ranges, suffix, open-ended, clamping", () => {
  const size = 1000;
  const cases = [
    [null, { kind: "full" }],
    [undefined, { kind: "full" }],
    ["bytes=0-499", { kind: "partial", start: 0, end: 499 }],
    ["bytes=500-999", { kind: "partial", start: 500, end: 999 }],
    ["bytes=500-5000", { kind: "partial", start: 500, end: 999 }],
    ["bytes=900-", { kind: "partial", start: 900, end: 999 }],
    ["bytes=-100", { kind: "partial", start: 900, end: 999 }],
    ["bytes=-5000", { kind: "partial", start: 0, end: 999 }],
    ["bytes=0-0", { kind: "partial", start: 0, end: 0 }],
    ["bytes=999-999", { kind: "partial", start: 999, end: 999 }],
    ["  bytes=1-2  ", { kind: "partial", start: 1, end: 2 }],
  ];
  for (const [header, expected] of cases) assert.deepEqual(parseRangeHeader(header, size), expected, String(header));
});

test("parseRangeHeader: unsatisfiable -> 416 cases", () => {
  assert.deepEqual(parseRangeHeader("bytes=1000-", 1000), { kind: "unsatisfiable" });
  assert.deepEqual(parseRangeHeader("bytes=1000-2000", 1000), { kind: "unsatisfiable" });
  assert.deepEqual(parseRangeHeader("bytes=-0", 1000), { kind: "unsatisfiable" });
  assert.deepEqual(parseRangeHeader("bytes=0-", 0), { kind: "unsatisfiable" });
  assert.deepEqual(parseRangeHeader("bytes=-10", 0), { kind: "unsatisfiable" });
});

test("parseRangeHeader: ignored (whole file) — multiple ranges, other units, malformed, inverted, huge numbers", () => {
  for (const header of [
    "bytes=0-1,5-6", "bytes=0-1, 5-6", "items=0-10", "bytes 0-10", "bytes=a-b", "bytes=-", "bytes=", "bytes=5-2",
    "bytes=0x10-20", "bytes=+1-2", "bytes=1.5-2", "bytes=99999999999999999-", "bytes=0-99999999999999999", "",
  ]) {
    assert.deepEqual(parseRangeHeader(header, 1000), { kind: "full" }, header);
  }
  assert.throws(() => parseRangeHeader("bytes=0-1", -1));
});

test("RL-1.1 (L-8): the range unit is case-insensitive — bytes=, Bytes=, BYTES= and mixed case", () => {
  for (const unit of ["bytes", "Bytes", "BYTES", "bYtEs", "ByTeS"]) {
    assert.deepEqual(parseRangeHeader(`${unit}=0-9`, 100), { kind: "partial", start: 0, end: 9 }, unit);
    assert.deepEqual(parseRangeHeader(`${unit}=-5`, 100), { kind: "partial", start: 95, end: 99 }, unit);
    assert.deepEqual(parseRangeHeader(`${unit}=100-`, 100), { kind: "unsatisfiable" }, unit);
  }
  assert.deepEqual(parseRangeHeader("Items=0-9", 100), { kind: "full" }, "another unit is still ignored");
  assert.deepEqual(parseRangeHeader("Bytes=0-1,4-5", 100), { kind: "full" }, "several ranges still ignored");
  assert.equal(contentRangeHeader(0, 9, 100), "bytes 0-9/100");
  assert.equal(unsatisfiedContentRangeHeader(100), "bytes */100");
});

// ---- GET / HEAD responses ---------------------------------------------------------------------------------

const DATA = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7) % 256));
const KEY = "Teachers/t/Lectures/l/RecordedLectures/r/file.mp4";

async function withRecording(fn) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rl1-play-root-"));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl1-play-app-"));
  try {
    const storage = await LocalFileStorage.open({ root: storageRoot, appDir });
    await storage.writeNewFile(KEY, (async function* () { yield new Uint8Array(DATA); })(), { maxBytes: DATA.length });
    // Records whether the file was opened for reading (HEAD must never open it).
    const spy = {
      opened: 0,
      stat: (key) => storage.stat(key),
      openRead: (key, range) => {
        spy.opened += 1;
        return storage.openRead(key, range);
      },
    };
    await fn(spy, storage);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
}

const request = (method, range, init = {}) =>
  new Request("http://localhost/api/recording", { method, headers: range ? { Range: range } : {}, ...init });

function assertCommonHeaders(response) {
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="recording.mp4"');
  // RL-4.3
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
}

test("GET without Range: 200, the whole file streamed, Content-Length = size", async () => {
  await withRecording(async (storage) => {
    const response = await createRecordingStreamResponse({ storage, key: KEY, request: request("GET") });
    assert.equal(response.status, 200);
    assertCommonHeaders(response);
    assert.equal(response.headers.get("content-length"), String(DATA.length));
    assert.equal(response.headers.get("content-range"), null);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(DATA));
  });
});

test("GET with Range: 206 with Content-Range; suffix and open-ended ranges; ignored ranges give 200", async () => {
  await withRecording(async (storage) => {
    const partial = await createRecordingStreamResponse({ storage, key: KEY, request: request("GET", "bytes=100-199") });
    assert.equal(partial.status, 206);
    assertCommonHeaders(partial);
    assert.equal(partial.headers.get("content-range"), `bytes 100-199/${DATA.length}`);
    assert.equal(partial.headers.get("content-length"), "100");
    assert.ok(Buffer.from(await partial.arrayBuffer()).equals(DATA.subarray(100, 200)));

    const suffix = await createRecordingStreamResponse({ storage, key: KEY, request: request("GET", "bytes=-50") });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), `bytes ${DATA.length - 50}-${DATA.length - 1}/${DATA.length}`);
    assert.ok(Buffer.from(await suffix.arrayBuffer()).equals(DATA.subarray(DATA.length - 50)));

    const open = await createRecordingStreamResponse({ storage, key: KEY, request: request("GET", "bytes=199990-") });
    assert.equal(open.status, 206);
    assert.equal(Buffer.from(await open.arrayBuffer()).length, 10);

    const multi = await createRecordingStreamResponse({ storage, key: KEY, request: request("GET", "bytes=0-1,4-5") });
    assert.equal(multi.status, 200);
    assert.equal(Buffer.from(await multi.arrayBuffer()).length, DATA.length);
  });
});

test("GET unsatisfiable: 416, Content-Range bytes */size, empty body, file not opened", async () => {
  await withRecording(async (storage) => {
    const response = await createRecordingStreamResponse({ storage, key: KEY, request: request("GET", `bytes=${DATA.length}-`) });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), `bytes */${DATA.length}`);
    assert.equal(response.headers.get("content-length"), "0");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(storage.opened, 0);
  });
});

test("HEAD without Range: 200, the GET headers, no body, the file is never opened for reading", async () => {
  await withRecording(async (storage) => {
    const response = await createRecordingStreamResponse({ storage, key: KEY, request: request("HEAD") });
    assert.equal(response.status, 200);
    assertCommonHeaders(response);
    assert.equal(response.headers.get("content-length"), String(DATA.length));
    assert.equal(response.body, null);
    assert.equal(storage.opened, 0);
  });
});

test("HEAD with Range: 206 with Content-Range and the range length, no body; unsatisfiable: 416; never opened", async () => {
  await withRecording(async (storage) => {
    const partial = await createRecordingStreamResponse({ storage, key: KEY, request: request("HEAD", "bytes=10-19") });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 10-19/${DATA.length}`);
    assert.equal(partial.headers.get("content-length"), "10");
    assert.equal(partial.body, null);

    const bad = await createRecordingStreamResponse({ storage, key: KEY, request: request("HEAD", "bytes=-0") });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), `bytes */${DATA.length}`);
    assert.equal(storage.opened, 0);
  });
});

test("missing file: NOT_FOUND for the caller to map; other methods refused", async () => {
  await withRecording(async (storage) => {
    await assert.rejects(
      createRecordingStreamResponse({ storage, key: "Teachers/t/none.mp4", request: request("GET") }),
      (error) => error instanceof StorageError && error.code === "NOT_FOUND"
    );
    await assert.rejects(
      createRecordingStreamResponse({ storage, key: KEY, request: request("POST") }),
      (error) => error instanceof StorageError && error.code === "INVALID_ARGUMENT"
    );
  });
});

test("client disconnect (request.signal) cancels the file read and releases the file", async () => {
  await withRecording(async (storage, real) => {
    const controller = new AbortController();
    const response = await createRecordingStreamResponse({ storage, key: KEY, request: request("GET", null, { signal: controller.signal }) });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    controller.abort();
    let done = false;
    for (let i = 0; i < 20 && !done; i += 1) done = (await reader.read()).done;
    assert.equal(done, true, "the body ends after the disconnect");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await real.remove(KEY), true, "the handle was closed");
  });
});

test("consumer cancel (the response body cancelled) also releases the file", async () => {
  await withRecording(async (storage, real) => {
    const response = await createRecordingStreamResponse({ storage, key: KEY, request: request("GET") });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await real.remove(KEY), true);
  });
});
