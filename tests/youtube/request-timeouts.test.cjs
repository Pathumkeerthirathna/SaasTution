/*
 * Regression tests (Stage 6, H2): time limits for YouTube Data API and Google
 * token requests, and the operation deadline under the lecture lock.
 *
 *   npm run test:youtube
 *
 * Real code through tsx: lib/youtube-request.ts, lib/youtube-live.ts,
 * lib/youtube-auth.ts and lib/youtube-operation-lock.ts. Fakes: a scripted
 * global fetch (nothing reaches the network), the token decryption, and an
 * in-memory YouTubeOperationLock table. Nothing contacts YouTube, Google or a
 * database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

function fake(relativePath, exports) {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);

    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
}

// ---- Fakes ------------------------------------------------------------------------

// The lecture lock table: unique insert, expired takeover, delete by owner.
const locks = new Map();

fake("lib/prisma.ts", {
    prisma: {
        youTubeOperationLock: {
            create: async ({ data }) => {
                if (locks.has(data.lectureId)) {
                    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                }
                locks.set(data.lectureId, { ...data });
                return { ...data };
            },
            updateMany: async ({ where, data }) => {
                const row = locks.get(where.lectureId);
                if (!row || !(row.expiresAt < where.expiresAt.lt)) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            },
            deleteMany: async ({ where }) => {
                const row = locks.get(where.lectureId);
                if (!row || row.ownerId !== where.ownerId) return { count: 0 };
                locks.delete(where.lectureId);
                return { count: 1 };
            }
        }
    }
});
fake("lib/youtube-crypto.ts", { decryptYouTubeToken: () => "refresh-token" });

process.env.GOOGLE_YOUTUBE_CLIENT_ID = "client-id";
process.env.GOOGLE_YOUTUBE_CLIENT_SECRET = "client-secret";

// Scripted fetch. `script(url, init)` answers each request; every request is recorded.
let script = () => hang();
const requests = [];

globalThis.fetch = (url, init = {}) => {
    requests.push({ url: String(url), signal: init.signal });
    return script(String(url), init);
};

// Never answers; fails like real fetch once its signal aborts.
function hang(init) {
    return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
    });
}

const json = (body, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

// Google answers the token request; YouTube requests use `youtube`.
function tokenThen(youtube) {
    return (url, init) => (url.startsWith("https://oauth2.googleapis.com/token")
        ? json({ access_token: "access" })
        : youtube(url, init));
}

const request = require(path.join(root, "lib/youtube-request.ts"));
const live = require(path.join(root, "lib/youtube-live.ts"));
const auth = require(path.join(root, "lib/youtube-auth.ts"));
const lock = require(path.join(root, "lib/youtube-operation-lock.ts"));

const { youtubeTimeouts, YouTubeRequestTimeoutError, runWithYouTubeDeadline, youtubeFetch } = request;
const DEFAULTS = { ...youtubeTimeouts };

function reset(timeouts = {}) {
    Object.assign(youtubeTimeouts, DEFAULTS, timeouts);
    requests.length = 0;
    locks.clear();
    script = (_url, init) => hang(init);
}

async function quiet(fn) {
    const saved = console.error;
    console.error = () => {};
    try {
        return await fn();
    } finally {
        console.error = saved;
    }
}

async function timed(fn) {
    const started = Date.now();
    let error = null;
    let value;

    try {
        value = await quiet(fn);
    } catch (caught) {
        error = caught;
    }

    return { value, error, elapsed: Date.now() - started };
}

function assertTimeout(error) {
    assert.ok(error instanceof YouTubeRequestTimeoutError, `expected a timeout, got ${error}`);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "YOUTUBE_TIMEOUT");
    // Never mistaken for "the broadcast is gone" (callers test for "not found").
    assert.ok(!error.message.includes("not found"));
}

// ---- Requests ----------------------------------------------------------------------

test("a Google token request that never answers fails with a controlled timeout, and is aborted", async () => {
    reset({ requestMs: 60 });

    const { error, elapsed } = await timed(() => auth.getYouTubeAccessToken("enc"));

    assertTimeout(error);
    assert.ok(elapsed < 1_000, `bounded (${elapsed} ms)`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, true, "the request itself was aborted");
});

const HELPERS = [
    ["createYouTubeLiveStream", () => live.createYouTubeLiveStream("enc")],
    ["getYouTubeLiveStream", () => live.getYouTubeLiveStream("enc", "stream-1")],
    ["createYouTubeLiveBroadcast", () => live.createYouTubeLiveBroadcast("enc", { title: "t", scheduledStartTime: new Date() })],
    ["bindYouTubeLiveBroadcast", () => live.bindYouTubeLiveBroadcast("enc", "bc-1", "stream-1")],
    ["getYouTubeLiveBroadcast", () => live.getYouTubeLiveBroadcast("enc", "bc-1")],
    ["updateYouTubeLiveBroadcastPrivacy", () => live.updateYouTubeLiveBroadcastPrivacy("enc", "bc-1", "private")],
    ["transitionYouTubeLiveBroadcast", () => live.transitionYouTubeLiveBroadcast("enc", "bc-1", "complete")]
];

for (const [name, call] of HELPERS) {
    test(`${name}: a YouTube API request that never answers fails with a controlled timeout`, async () => {
        reset({ requestMs: 60 });
        script = tokenThen((_url, init) => hang(init));

        const { error, elapsed } = await timed(call);

        assertTimeout(error);
        assert.ok(elapsed < 1_000, `bounded (${elapsed} ms)`);
        assert.equal(requests.length, 2, "token + one API request");
        assert.ok(requests.every(r => r.signal), "every request carries a time limit");
    });
}

test("a response whose body never finishes also times out (the body is read inside the limit)", async () => {
    reset({ requestMs: 60 });
    script = tokenThen((_url, init) => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode("{\"items\":["));
            init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
        }
    }), { status: 200 })));

    const { error } = await timed(() => live.getYouTubeLiveBroadcast("enc", "bc-1"));

    assertTimeout(error);
});

test("answers within the limit are unchanged: success, YouTube errors, not-found, expired authorization", async () => {
    reset({ requestMs: 1_000 });

    script = tokenThen(() => json({ items: [{ id: "bc-1", status: { lifeCycleStatus: "live" } }] }));
    assert.equal((await live.getYouTubeLiveBroadcast("enc", "bc-1")).status.lifeCycleStatus, "live");

    script = tokenThen(() => json({ items: [] }));
    await assert.rejects(quiet(() => live.getYouTubeLiveBroadcast("enc", "bc-1")), /not found/);

    script = tokenThen(() => json({ error: "backendError" }, 503));
    await assert.rejects(quiet(() => live.getYouTubeLiveBroadcast("enc", "bc-1")), /Failed to retrieve/);

    script = () => json({ error: "invalid_grant" }, 400);
    await assert.rejects(quiet(() => auth.getYouTubeAccessToken("enc")), auth.YouTubeReauthorizationRequiredError);

    script = () => Promise.resolve(new Response(null, { status: 204 }));
    assert.equal((await youtubeFetch("https://www.googleapis.com/x")).status, 204);
});

test("a network failure is passed on as it is (not reported as a timeout)", async () => {
    reset();
    script = () => Promise.reject(new TypeError("fetch failed"));

    const { error } = await timed(() => youtubeFetch("https://www.googleapis.com/x"));

    assert.ok(error instanceof TypeError);
});

// ---- Operation deadline ------------------------------------------------------------

test("after the operation deadline no request is sent at all", async () => {
    reset();
    script = () => json({});

    const { error } = await timed(() => runWithYouTubeDeadline(Date.now() - 1, () => youtubeFetch("https://www.googleapis.com/x")));

    assertTimeout(error);
    assert.equal(requests.length, 0, "nothing was sent");
});

test("the deadline shortens a request's limit; nested deadlines keep the earlier one", async () => {
    reset({ requestMs: 10_000 });

    const { error, elapsed } = await timed(() =>
        runWithYouTubeDeadline(Date.now() + 80, () =>
            runWithYouTubeDeadline(Date.now() + 60_000, () => youtubeFetch("https://www.googleapis.com/x"))));

    assertTimeout(error);
    assert.ok(elapsed < 1_000, `ended by the 80 ms deadline, not the 10 s limit (${elapsed} ms)`);
});

// ---- Lock + deadline: no overlap ------------------------------------------------------

test("a lock holder stalled on YouTube stops before its lock can expire; no second holder meanwhile; owner release", async () => {
    reset({ requestMs: 10_000, lockTtlMs: 400, lockSafetyMarginMs: 200 });
    script = tokenThen((_url, init) => hang(init));

    let expiresAt;
    let concurrent;

    const first = timed(() => lock.withLectureYouTubeLock("lecture-1", async () => {
        expiresAt = locks.get("lecture-1").expiresAt.getTime();

        // Meanwhile another request for the lecture is refused.
        concurrent = await lock.withLectureYouTubeLock("lecture-1", async () => "ran").catch(e => e);

        return live.getYouTubeLiveBroadcast("enc", "bc-1");
    }));

    const { error } = await first;
    const finishedAt = Date.now();

    assertTimeout(error);
    assert.equal(concurrent.code, "YOUTUBE_OPERATION_IN_PROGRESS");
    assert.ok(finishedAt < expiresAt, `the holder gave up on YouTube before its lock expired (${expiresAt - finishedAt} ms left)`);
    assert.equal(locks.size, 0, "released by its owner");
});

test("a budget ends the holder's YouTube requests earlier than the lock deadline", async () => {
    reset({ requestMs: 10_000, lockTtlMs: 60_000, lockSafetyMarginMs: 15_000 });
    script = tokenThen((_url, init) => hang(init));

    const { error, elapsed } = await timed(() =>
        lock.withLectureYouTubeLock("lecture-1", () => live.getYouTubeLiveBroadcast("enc", "bc-1"), { budgetMs: 80 }));

    assertTimeout(error);
    assert.ok(elapsed < 1_000, `bounded by the budget (${elapsed} ms)`);
    assert.equal(locks.size, 0);
});

test("an expired holder's late release never removes the next holder's lock", async () => {
    reset({ lockTtlMs: 40, lockSafetyMarginMs: 0 });

    let releaseFirst;
    const firstDone = lock.withLectureYouTubeLock("lecture-1", () => new Promise(resolve => { releaseFirst = resolve; }));

    await new Promise(resolve => setTimeout(resolve, 60));

    let secondRelease;
    const second = lock.withLectureYouTubeLock("lecture-1", () => new Promise(resolve => { secondRelease = resolve; }));

    await new Promise(resolve => setImmediate(resolve));
    const secondOwner = locks.get("lecture-1").ownerId;

    releaseFirst();
    await firstDone;

    assert.equal(locks.get("lecture-1")?.ownerId, secondOwner, "the takeover holder still holds it");

    secondRelease();
    await second;
    assert.equal(locks.size, 0);
});

// ---- Typed YouTube errors (Stage 7) --------------------------------------------------

test("a YouTube HTTP error keeps its status and reason (YouTubeApiError); a network failure does not become one", async () => {
    reset({ requestMs: 1_000 });

    script = tokenThen(() => json({ error: { code: 403, errors: [{ reason: "invalidTransition" }] } }, 403));

    const refused = await timed(() => live.transitionYouTubeLiveBroadcast("enc", "bc-1", "complete"));

    assert.ok(refused.error instanceof request.YouTubeApiError);
    assert.equal(refused.error.status, 403);
    assert.equal(refused.error.reason, "invalidTransition");
    assert.match(refused.error.message, /Failed to transition/);

    script = tokenThen(() => Promise.resolve(new Response("<html>bad gateway</html>", { status: 502 })));

    const gateway = await timed(() => live.getYouTubeLiveBroadcast("enc", "bc-1"));

    assert.equal(gateway.error.status, 502);
    assert.equal(gateway.error.reason, undefined, "no reason without a YouTube error body");

    script = tokenThen(() => Promise.reject(new TypeError("fetch failed")));

    const network = await timed(() => live.transitionYouTubeLiveBroadcast("enc", "bc-1", "complete"));

    assert.ok(network.error instanceof TypeError);
    assert.ok(!(network.error instanceof request.YouTubeApiError));

    // invalid_grant from Google: the reauthorization error, nothing else.
    script = () => json({ error: "invalid_grant" }, 400);

    const expired = await timed(() => live.getYouTubeLiveBroadcast("enc", "bc-1"));

    assert.ok(expired.error instanceof auth.YouTubeReauthorizationRequiredError);
});
