/*
 * Recorded Lectures RL-4.3: playback response resource lifecycle
 * (lib/recorded-lectures/stream-response.ts) with the REAL LocalFileStorage.
 *
 * For every path: the stream slot is taken only when a body is really
 * streamed, released EXACTLY once, and every opened file handle is closed.
 * File handles are counted at the source: every FileHandle emits "close"
 * when it is really closed (also when a read stream closes it internally),
 * and every handle opened by openRead must have emitted it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createRecordingStreamResponse, STREAM_IDLE_TIMEOUT_MS } = require(path.join(root, "lib", "recorded-lectures", "stream-response.ts"));
const { LocalFileStorage } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));
const { StorageError } = require(path.join(root, "lib", "file-storage", "types.ts"));

const SIZE = 1024 * 1024; // 16 reads of 64 KiB
const DATA = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 13) % 251));
const KEY = "Teachers/t/Lectures/l/RecordedLectures/r/0123456789abcdef0123456789abcdef.mp4";
const EMPTY_KEY = "Teachers/t/empty.mp4";

// ---- File handle accounting ----------------------------------------------------------------------

let closes = 0;
let fileHandleProto = null;
let originalEmit = null;

test.before(async () => {
  const probe = path.join(os.tmpdir(), `rl43-probe-${process.pid}`);
  fs.writeFileSync(probe, "x");
  const handle = await fs.promises.open(probe, "r");
  fileHandleProto = Object.getPrototypeOf(handle);
  await handle.close();
  fs.rmSync(probe, { force: true });
  assert.equal(typeof handle.on, "function", "FileHandle is an EventEmitter on this Node version");
  originalEmit = fileHandleProto.emit;
  fileHandleProto.emit = function countedEmit(event, ...args) {
    if (event === "close") closes += 1;
    return originalEmit.call(this, event, ...args);
  };
});
test.after(() => {
  if (fileHandleProto && originalEmit) fileHandleProto.emit = originalEmit;
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function settleHandles(ctx) {
  for (let i = 0; i < 100 && closes - ctx.closesAtStart < ctx.opened; i += 1) await tick(5);
}

async function withStorage(fn) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rl43-root-"));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl43-app-"));
  try {
    const storage = await LocalFileStorage.open({ root: storageRoot, appDir });
    await storage.writeNewFile(KEY, (async function* () { yield new Uint8Array(DATA); })(), { maxBytes: SIZE });
    await storage.writeNewFile(EMPTY_KEY, (async function* () {})(), { maxBytes: 1 });
    const ctx = {
      opened: 0,
      closesAtStart: closes,
      patches: {},
      storage: {
        stat: (key) => (ctx.patches.stat ? ctx.patches.stat(storage, key) : storage.stat(key)),
        openRead: async (key, range) => {
          if (ctx.patches.openRead) return ctx.patches.openRead(storage, key, range, ctx);
          const opened = await storage.openRead(key, range);
          ctx.opened += 1;
          return opened;
        },
      },
      acquired: 0,
      released: 0,
      acquireSlot: () => {
        ctx.acquired += 1;
        return () => {
          ctx.released += 1;
        };
      },
    };
    await fn(ctx, storage);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
}

const req = (method, headers = {}, init = {}) => new Request("http://localhost/x", { method, headers, ...init });

function respond(ctx, request, extra = {}) {
  return createRecordingStreamResponse({ storage: ctx.storage, key: KEY, request, acquireSlot: ctx.acquireSlot, ...extra });
}

async function readAll(response) {
  return Buffer.from(await response.arrayBuffer());
}

async function assertClean(ctx, expectedReleases) {
  await settleHandles(ctx);
  assert.equal(ctx.released, expectedReleases, "releases");
  assert.equal(ctx.acquired, expectedReleases, "every acquired slot released once");
  assert.equal(closes - ctx.closesAtStart, ctx.opened, "every opened file handle closed");
}

// ---- Normal completion ---------------------------------------------------------------------------

test("200 full read: one slot, released once at the end, file closed, bytes exact", async () => {
  await withStorage(async (ctx) => {
    const res = await respond(ctx, req("GET"));
    assert.equal(res.status, 200);
    assert.equal(ctx.acquired, 1);
    assert.equal(ctx.released, 0, "held while streaming");
    assert.ok((await readAll(res)).equals(DATA));
    await assertClean(ctx, 1);
  });
});

test("206 range read: released once at the end, file closed", async () => {
  await withStorage(async (ctx) => {
    const res = await respond(ctx, req("GET", { Range: "bytes=100000-300000" }));
    assert.equal(res.status, 206);
    assert.ok((await readAll(res)).equals(DATA.subarray(100000, 300001)));
    await assertClean(ctx, 1);
  });
});

// ---- Responses that never take a slot ------------------------------------------------------------

test("HEAD (with and without Range), 416 and zero-length bodies never take a slot or open the file", async () => {
  await withStorage(async (ctx) => {
    for (const [request, status] of [
      [req("HEAD"), 200],
      [req("HEAD", { Range: "bytes=0-1" }), 206],
      [req("GET", { Range: `bytes=${SIZE}-` }), 416],
      [req("HEAD", { Range: `bytes=${SIZE}-` }), 416],
    ]) {
      const res = await respond(ctx, request);
      assert.equal(res.status, status);
      assert.equal(res.body, null);
    }
    const empty = await createRecordingStreamResponse({ storage: ctx.storage, key: EMPTY_KEY, request: req("GET"), acquireSlot: ctx.acquireSlot });
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("content-length"), "0");
    assert.equal(ctx.acquired, 0);
    assert.equal(ctx.opened, 0);
  });
});

test("errors before the body (missing file, size differs from the database, bad method) never take a slot", async () => {
  await withStorage(async (ctx) => {
    const isCode = (code) => (e) => e instanceof StorageError && e.code === code;
    await assert.rejects(createRecordingStreamResponse({ storage: ctx.storage, key: "Teachers/t/none.mp4", request: req("GET"), acquireSlot: ctx.acquireSlot }), isCode("NOT_FOUND"));
    await assert.rejects(respond(ctx, req("GET"), { expectedSize: SIZE + 1 }), isCode("SIZE_MISMATCH"));
    await assert.rejects(respond(ctx, req("HEAD"), { expectedSize: SIZE - 1 }), isCode("SIZE_MISMATCH"));
    await assert.rejects(respond(ctx, req("POST", {}, { body: "x" })), isCode("INVALID_ARGUMENT"));
    await assert.rejects(respond(ctx, req("GET"), { idleTimeoutMs: 0 }), isCode("INVALID_ARGUMENT"));
    assert.equal(ctx.acquired, 0);
    assert.equal(ctx.opened, 0);
    const ok = await respond(ctx, req("GET"), { expectedSize: SIZE });
    assert.ok((await readAll(ok)).equals(DATA));
    await assertClean(ctx, 1);
  });
});

test("a refused slot (acquireSlot throws) propagates, opens nothing and holds nothing", async () => {
  await withStorage(async (ctx) => {
    const refusal = new Error("refused");
    await assert.rejects(respond(ctx, req("GET"), { acquireSlot: () => { throw refusal; } }), (e) => e === refusal);
    assert.equal(ctx.opened, 0);
    assert.equal(closes - ctx.closesAtStart, 0);
  });
});

// ---- Failures after the slot was taken -----------------------------------------------------------

test("openRead failing releases the slot once", async () => {
  await withStorage(async (ctx) => {
    ctx.patches.openRead = async () => { throw new StorageError("IO_ERROR"); };
    await assert.rejects(respond(ctx, req("GET")), (e) => e instanceof StorageError && e.code === "IO_ERROR");
    await assertClean(ctx, 1);
  });
});

test("file replaced between stat and open (size changed): released once, the opened file closed", async () => {
  await withStorage(async (ctx) => {
    ctx.patches.openRead = async (storage, key, range) => {
      const opened = await storage.openRead(key, range);
      ctx.opened += 1;
      return { stream: opened.stream, size: opened.size + 1 };
    };
    await assert.rejects(respond(ctx, req("GET")), (e) => e instanceof StorageError && e.code === "SIZE_MISMATCH");
    await assertClean(ctx, 1);
  });
});

test("a read error mid-stream: the body errors, the slot is released once", async () => {
  await withStorage(async (ctx) => {
    const failure = new Error("EIO while reading");
    let cancelled = false;
    ctx.patches.openRead = async () => {
      let sent = false;
      return {
        size: SIZE,
        stream: new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new Uint8Array(10));
            } else controller.error(failure);
          },
          cancel() {
            cancelled = true;
          },
        }),
      };
    };
    const res = await respond(ctx, req("GET"));
    const reader = res.body.getReader();
    assert.equal((await reader.read()).value.length, 10);
    await assert.rejects(reader.read(), (e) => e === failure);
    assert.equal(ctx.released, 1);
    assert.equal(cancelled, false, "an errored source needs no cancel");
  });
});

test("a throwing release never breaks the response path", async () => {
  await withStorage(async (ctx) => {
    const res = await respond(ctx, req("GET"), { acquireSlot: () => () => { throw new Error("boom"); } });
    assert.ok((await readAll(res)).equals(DATA));
  });
});

// ---- Disconnects and cancellation ----------------------------------------------------------------

test("client disconnect mid-stream (request.signal): released once, file closed, body ends", async () => {
  await withStorage(async (ctx) => {
    const controller = new AbortController();
    const res = await respond(ctx, req("GET", {}, { signal: controller.signal }));
    const reader = res.body.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    assert.equal(ctx.released, 1, "released at the abort itself");
    let done = false;
    for (let i = 0; i < 20 && !done; i += 1) done = (await reader.read()).done;
    assert.equal(done, true);
    controller.abort();
    await assertClean(ctx, 1);
  });
});

test("an already-aborted request: released immediately, body empty, file closed", async () => {
  await withStorage(async (ctx) => {
    const controller = new AbortController();
    controller.abort();
    const res = await respond(ctx, req("GET", {}, { signal: controller.signal }));
    assert.equal(ctx.released, 1);
    assert.equal((await readAll(res)).length, 0);
    await assertClean(ctx, 1);
  });
});

test("consumer cancel: released once, file closed; a later abort changes nothing", async () => {
  await withStorage(async (ctx) => {
    const controller = new AbortController();
    const res = await respond(ctx, req("GET", {}, { signal: controller.signal }));
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    controller.abort();
    await assertClean(ctx, 1);
  });
});

// ---- Idle timeout --------------------------------------------------------------------------------

test("idle default is 120 seconds", () => {
  assert.equal(STREAM_IDLE_TIMEOUT_MS, 120_000);
});

test("idle: a body that is never consumed is ended (slot released, file closed)", async () => {
  await withStorage(async (ctx) => {
    const res = await respond(ctx, req("GET"), { idleTimeoutMs: 40 });
    assert.equal(ctx.released, 0);
    await tick(120);
    assert.equal(ctx.released, 1);
    await assertClean(ctx, 1);
    await assert.rejects(res.body.getReader().read(), (e) => e.name === "AbortError");
  });
});

test("idle: a consumer that stops pulling (paused player) is ended with an AbortError", async () => {
  await withStorage(async (ctx) => {
    const res = await respond(ctx, req("GET"), { idleTimeoutMs: 40 });
    const reader = res.body.getReader();
    await reader.read();
    await reader.read();
    await tick(120);
    assert.equal(ctx.released, 1);
    await assert.rejects(reader.read(), (e) => e.name === "AbortError");
    await assertClean(ctx, 1);
  });
});

test("idle: steady pulls slower than one read but faster than the timeout never trip it", async () => {
  await withStorage(async (ctx) => {
    const res = await respond(ctx, req("GET"), { idleTimeoutMs: 80 });
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      await tick(20); // 16+ pulls, total well over the timeout
    }
    assert.ok(Buffer.concat(chunks).equals(DATA));
    await assertClean(ctx, 1);
  });
});

test("idle: a slow storage read longer than the timeout does not count as idle", async () => {
  await withStorage(async (ctx) => {
    ctx.patches.openRead = async (storage, key, range) => {
      const opened = await storage.openRead(key, range);
      ctx.opened += 1;
      const inner = opened.stream.getReader();
      return {
        size: opened.size,
        stream: new ReadableStream({
          async pull(controller) {
            await tick(100); // each read is slower than the 30 ms idle timeout
            const { done, value } = await inner.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          cancel(reason) {
            return inner.cancel(reason);
          },
        }, { highWaterMark: 0 }),
      };
    };
    const res = await respond(ctx, req("GET", { Range: "bytes=0-200000" }), { idleTimeoutMs: 30 });
    const body = await readAll(res);
    assert.ok(body.equals(DATA.subarray(0, 200001)));
    await assertClean(ctx, 1);
  });
});

test("idle: the timer never fires after the body finished", async () => {
  await withStorage(async (ctx) => {
    const res = await respond(ctx, req("GET"), { idleTimeoutMs: 30 });
    await readAll(res);
    await tick(100);
    await assertClean(ctx, 1);
  });
});

// ---- If-Range ------------------------------------------------------------------------------------

test("If-Range: any value makes the Range ignored (200, whole file); without it the Range applies", async () => {
  await withStorage(async (ctx) => {
    for (const value of ['"some-etag"', 'W/"x"', "Sat, 14 Nov 2026 10:00:00 GMT", ""]) {
      const res = await respond(ctx, req("GET", { Range: "bytes=0-99", "If-Range": value }));
      assert.equal(res.status, 200, value);
      assert.equal(res.headers.get("content-length"), String(SIZE));
      assert.equal(res.headers.get("content-range"), null);
      assert.ok((await readAll(res)).equals(DATA));
    }
    const head = await respond(ctx, req("HEAD", { Range: `bytes=${SIZE}-`, "If-Range": '"x"' }));
    assert.equal(head.status, 200, "an unsatisfiable Range is ignored too");
    const ranged = await respond(ctx, req("GET", { Range: "bytes=0-99" }));
    assert.equal(ranged.status, 206);
    await readAll(ranged);
    await assertClean(ctx, 5);
  });
});
