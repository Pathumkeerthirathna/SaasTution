/*
 * The YouTube API wrappers the never-live cleanup uses (lib/youtube-live.ts):
 * listUpcomingYouTubeLiveBroadcasts (every page, or an error: never a partial
 * list) and deleteYouTubeLiveBroadcast (errors keep HTTP status and YouTube's
 * reason; a timeout stays a timeout).
 *
 *   npm run test:youtube
 *
 * The real wrappers, lib/youtube-request.ts and lib/youtube-auth.ts against a
 * scripted fetch. Nothing contacts Google or YouTube.
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

fake("lib/youtube-crypto.ts", { decryptYouTubeToken: () => "refresh-token" });
process.env.GOOGLE_YOUTUBE_CLIENT_ID = "client-id";
process.env.GOOGLE_YOUTUBE_CLIENT_SECRET = "client-secret";

const ACCESS_TOKEN = "access-token-SECRET";
const requests = [];
let youtube = () => { throw new Error("no script"); };

globalThis.fetch = (url, init = {}) => {
    url = String(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Promise.resolve(json({ access_token: ACCESS_TOKEN }));
    }
    requests.push({ url: new URL(url), method: init.method, auth: init.headers?.Authorization });
    return youtube(new URL(url), init);
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const youtubeError = (status, reason) => json({ error: { code: status, errors: [{ reason }] } }, status);

const hang = init => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal.reason));
});

const request = require(path.join(root, "lib/youtube-request.ts"));
const live = require(path.join(root, "lib/youtube-live.ts"));

const { YouTubeApiError, YouTubeRequestTimeoutError, youtubeTimeouts } = request;
const DEFAULTS = { ...youtubeTimeouts };

function reset(script) {
    Object.assign(youtubeTimeouts, DEFAULTS);
    requests.length = 0;
    youtube = script;
}

async function quietCapture(fn) {
    const logged = [];
    const saved = [console.error, console.warn, console.log];

    console.error = console.warn = console.log = (...args) => logged.push(args.map(a => {
        try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); }
    }).join(" "));
    try {
        return { value: await fn(), logged };
    } catch (error) {
        return { error, logged };
    } finally {
        [console.error, console.warn, console.log] = saved;
    }
}

const broadcast = id => ({ id, snippet: { description: "SLClassroom - x" }, status: { lifeCycleStatus: "ready" }, contentDetails: { boundStreamId: "s" } });

test("16. list: follows every page (pageToken) and returns all upcoming broadcasts with status, description and bound stream", async () => {
    reset(url => json(url.searchParams.get("pageToken") === "p2"
        ? { items: [broadcast("c")] }
        : { items: [broadcast("a"), broadcast("b")], nextPageToken: "p2" }));

    const { value } = await quietCapture(() => live.listUpcomingYouTubeLiveBroadcasts("enc"));

    assert.deepEqual(value.map(b => b.id), ["a", "b", "c"]);
    assert.equal(requests.length, 2);

    const [first, second] = requests;

    assert.equal(first.url.pathname, "/youtube/v3/liveBroadcasts");
    assert.equal(first.method, "GET");
    assert.equal(first.url.searchParams.get("broadcastStatus"), "upcoming");
    assert.equal(first.url.searchParams.get("broadcastType"), "all");
    assert.equal(first.url.searchParams.get("maxResults"), "50");
    assert.deepEqual(first.url.searchParams.get("part").split(",").sort(), ["contentDetails", "id", "snippet", "status"]);
    assert.equal(first.url.searchParams.get("pageToken"), null);
    assert.equal(second.url.searchParams.get("pageToken"), "p2");
    assert.equal(first.auth, `Bearer ${ACCESS_TOKEN}`);
});

test("16b. list never returns a partial result: a failing or malformed later page, or too many pages, is an error", async () => {
    reset(url => (url.searchParams.get("pageToken") ? youtubeError(500, "backendError") : json({ items: [broadcast("a")], nextPageToken: "p2" })));
    let outcome = await quietCapture(() => live.listUpcomingYouTubeLiveBroadcasts("enc"));

    assert.ok(outcome.error instanceof YouTubeApiError);
    assert.equal(outcome.error.status, 500);

    reset(url => (url.searchParams.get("pageToken") ? json({ nothing: true }) : json({ items: [], nextPageToken: "p2" })));
    outcome = await quietCapture(() => live.listUpcomingYouTubeLiveBroadcasts("enc"));
    assert.ok(outcome.error instanceof YouTubeApiError, String(outcome.error));

    let page = 0;

    reset(() => json({ items: [broadcast("x" + page)], nextPageToken: "p" + ++page }));
    outcome = await quietCapture(() => live.listUpcomingYouTubeLiveBroadcasts("enc"));
    assert.ok(outcome.error instanceof Error);
    assert.match(outcome.error.message, /were not all checked/);
    assert.equal(requests.length, live.UPCOMING_BROADCAST_MAX_PAGES);
});

test("delete: DELETE liveBroadcasts?id=…; success resolves; errors keep status and reason (404, 403 liveBroadcastDeletionNotAllowed); no token in logs", async () => {
    reset(() => new Response(null, { status: 204 }));
    let outcome = await quietCapture(() => live.deleteYouTubeLiveBroadcast("enc", "bc-1"));

    assert.equal(outcome.error, undefined);
    assert.equal(requests[0].method, "DELETE");
    assert.equal(requests[0].url.searchParams.get("id"), "bc-1");

    reset(() => youtubeError(404, "liveBroadcastNotFound"));
    outcome = await quietCapture(() => live.deleteYouTubeLiveBroadcast("enc", "bc-1"));
    assert.ok(outcome.error instanceof YouTubeApiError);
    assert.equal(outcome.error.status, 404);
    assert.equal(outcome.error.reason, "liveBroadcastNotFound");

    reset(() => youtubeError(403, "liveBroadcastDeletionNotAllowed"));
    outcome = await quietCapture(() => live.deleteYouTubeLiveBroadcast("enc", "bc-1"));
    assert.equal(outcome.error.status, 403);
    assert.equal(outcome.error.reason, "liveBroadcastDeletionNotAllowed");
    assert.ok(outcome.logged.length > 0);
    assert.ok(!outcome.logged.join("\n").includes(ACCESS_TOKEN), "the access token is never logged");
});

test("delete / list without an answer: a timeout (YouTubeRequestTimeoutError), never a YouTube answer", async () => {
    reset((_url, init) => hang(init));
    youtubeTimeouts.requestMs = 30;

    let outcome = await quietCapture(() => live.deleteYouTubeLiveBroadcast("enc", "bc-1"));

    assert.ok(outcome.error instanceof YouTubeRequestTimeoutError);
    assert.equal(outcome.error.dispatched, true);

    outcome = await quietCapture(() => live.listUpcomingYouTubeLiveBroadcasts("enc"));
    assert.ok(outcome.error instanceof YouTubeRequestTimeoutError);
});
