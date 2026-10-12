/*
 * Regression tests (Stage 4): failed-start cleanup, Jibri state, concurrency
 * and stop reliability for YouTube Recording / Live.
 *
 *   npm run test:youtube
 *
 * Drives the real teacher-page controller (components/Jitsi/youtube-stream-
 * controller.ts) against the real routes (start, stop, start/abort) and
 * library code, with fake Prisma (including the per-lecture lock table),
 * fake YouTube, a fake Jitsi that records Jibri commands, and a manual timer
 * for the 25 s confirmation. Jibri status events are injected by the tests.
 * Nothing contacts YouTube, Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");
const {
    LECTURE, LECTURE_2, db, yt, locks, routes, getLiveSnapshot,
    reset, post, quiet, created, completions, active
} = fakes;

const root = path.resolve(__dirname, "..", "..");
const { createYouTubeStreamController } = require(path.join(root, "components/Jitsi/youtube-stream-controller.ts"));
const { toYouTubeStreamStatus } = require(path.join(root, "components/Jitsi/youtube-jibri.ts"));

const transient = () => new Error("YouTube API request failed: 503 backendError");

// Let pending promises (fake DB / YouTube / routes) run.
async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

// A teacher page: the real controller wired to the routes, a fake Jitsi and a manual timer.
function page(lectureId = LECTURE) {
    const timers = [];
    const jitsi = { starts: [], stops: 0 };
    const changes = [];

    const controller = createYouTubeStreamController({
        startFeature: (feature, { privacy }) => feature === "recording"
            ? post(routes.recordingStart, { lectureId, privacy: "unlisted" })
            : post(routes.liveStart, { lectureId, privacy }),
        abortStart: (feature, body) => post(routes.startAbort, { lectureId, feature, ...body }),
        stopFeature: feature => post(feature === "recording" ? routes.recordingStop : routes.liveStop, { lectureId }),
        startJibri: (_key, _broadcastId, feature) => { jitsi.starts.push(feature); },
        stopJibri: () => { jitsi.stops += 1; },
        schedule: (fn, ms) => {
            const timer = { fn, ms, done: false };
            timers.push(timer);
            return () => { timer.done = true; };
        }
    });

    controller.subscribe((_state, change) => changes.push(change));

    return {
        controller,
        jitsi,
        changes,
        state: () => controller.getState(),
        // The 25 s confirmation timeout passes.
        timeout: () => timers.filter(t => !t.done).forEach(t => { t.done = true; t.fn(); }),
        // Jibri reports the stream (YouTube then sees it too).
        jibriOn: () => { yt.streamActive = true; controller.onStreamStatus({ on: true }); },
        jibriOff: error => { yt.streamActive = false; controller.onStreamStatus(error ? { on: false, error } : { on: false }); },
        // Start and confirm.
        async startConfirmed(feature, privacy) {
            const pending = controller.start(feature, { privacy });
            await settle();
            if (controller.getState()[feature] === "starting") this.jibriOn();
            return pending;
        }
    };
}

// ---- 1-3: failed starts ------------------------------------------------------------

test("1. Recording startup timeout: own row and broadcast cleaned up, own Jibri start stopped, nothing left active", async () => {
    reset();

    const p = page();
    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("recording");
        await settle();

        assert.equal(p.state().recording, "starting", "stays Starting while unconfirmed");
        assert.deepEqual(p.jitsi.starts, ["recording"]);

        p.timeout();
        outcome = await pending;
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "jibri-timeout");
    assert.equal(p.state().recording, "off");
    assert.equal(db.recordings[0].status, "REVOKED", "its new row is not left active");
    assert.equal(completions(db.recordings[0].broadcastId).length, 1, "its own new broadcast is completed");
    assert.equal(p.jitsi.stops, 1, "the Jibri start it made is stopped");
    assert.equal(locks.size, 0, "lock released");
});

test("2. Live startup timeout: cleaned up; students never see it", async () => {
    reset();

    const p = page();
    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("live", { privacy: "public" });
        await settle();
        p.timeout();
        outcome = await pending;
    });

    assert.equal(outcome.reason, "jibri-timeout");
    assert.equal(p.state().live, "off");
    assert.equal(db.lives[0].status, "REVOKED");
    assert.equal(p.jitsi.stops, 1);
    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), { isLive: false, youtubeUrl: null });
    assert.deepEqual(await getLiveSnapshot(LECTURE, "teacher"), { isLive: false, youtubeUrl: null });
});

test("3. a Jibri confirmation that arrives after the timeout is stopped, never adopted", async () => {
    reset();

    const p = page();

    await quiet(async () => {
        const pending = p.controller.start("recording");
        await settle();
        p.timeout();
        await pending;
    });

    assert.equal(p.jitsi.stops, 1);

    // The stream comes up late.
    p.jibriOn();

    assert.equal(p.state().recording, "off", "the timed-out start does not become active");
    assert.equal(p.jitsi.stops, 2, "the late stream is stopped");
    assert.equal(active(db.recordings).length, 0);

    // And only once.
    p.jibriOn();
    assert.equal(p.jitsi.stops, 2);
});

test("3b. a Jibri error during startup fails at once (no 25 s wait) with the same cleanup", async () => {
    reset();

    const p = page();
    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("recording");
        await settle();
        p.jibriOff("unexpected-request");
        outcome = await pending;
    });

    assert.equal(outcome.reason, "jibri-error");
    assert.equal(outcome.error, "unexpected-request");
    assert.equal(db.recordings[0].status, "REVOKED");
    assert.equal(p.state().recording, "off");
});

// ---- 4: shared broadcast -----------------------------------------------------------

test("4. a failed Live start on the recording's shared broadcast closes only its own Live row", async () => {
    reset();

    // Recording runs (started earlier), then the page reloads: Jibri state unknown.
    await quiet(async () => {
        const before = page();
        await before.startConfirmed("recording");
    });

    const p = page();

    p.controller.serverReport("recording", true);
    assert.equal(p.state().recording, "restored");

    yt.streamActive = false; // YouTube does not show the stream as active right now

    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("live", { privacy: "unlisted" });
        await settle();

        assert.deepEqual(p.jitsi.starts, [], "the recording's stream is not started a second time");

        p.timeout();
        outcome = await pending;
    });

    assert.equal(outcome.reason, "jibri-timeout");
    assert.equal(db.lives[0].broadcastId, db.recordings[0].broadcastId, "it was the shared broadcast");
    assert.equal(db.lives[0].status, "REVOKED", "its own Live row closed");
    assert.equal(active(db.recordings).length, 1, "the recording is untouched");
    assert.deepEqual(completions(db.recordings[0].broadcastId), [], "the shared broadcast is not completed");
    assert.equal(p.jitsi.stops, 0, "Jibri it did not start is not stopped");
    assert.equal(p.state().recording, "restored");
});

test("4b. a start that reuses an already-active row of its own feature never closes it on failure", async () => {
    reset();

    await quiet(async () => {
        await page().startConfirmed("recording");
    });

    // Jibri died (page lost it); the row is still active. Record again, and Jibri fails again.
    const p = page();

    await quiet(async () => {
        const pending = p.controller.start("recording");
        await settle();
        p.timeout();
        await pending;
    });

    assert.equal(active(db.recordings).length, 1, "a row this start did not create stays as it was");
    assert.equal(created().length, 1);
});

// ---- 5-7: Jibri stops during a session --------------------------------------------------

test("5. Jibri stops while Recording alone is active: Recording ends on the page; Record again recovers on the same broadcast", async () => {
    reset();

    const p = page();

    await quiet(() => p.startConfirmed("recording"));
    assert.equal(p.state().recording, "on");

    p.jibriOff("jibri-crashed");

    assert.equal(p.state().recording, "off");
    assert.deepEqual(p.changes.at(-1), { type: "jibri-stopped", features: ["recording"], error: "jibri-crashed" });

    // Record again: the same broadcast is reused (still ready/live on YouTube) and Jibri restarted.
    const again = await quiet(() => p.startConfirmed("recording"));

    assert.equal(again.ok, true);
    assert.equal(created().length, 1, "no new broadcast");
    assert.deepEqual(p.jitsi.starts, ["recording", "recording"]);
    assert.equal(p.state().recording, "on");
});

test("6. Jibri stops while Live alone is active: Live ends on the page", async () => {
    reset();

    const p = page();

    await quiet(() => p.startConfirmed("live", "public"));
    p.jibriOff();

    assert.equal(p.state().live, "off");
    assert.deepEqual(p.changes.at(-1), { type: "jibri-stopped", features: ["live"], error: undefined });
});

test("7. Jibri stops while both share one broadcast: both end on the page, in one notice", async () => {
    reset();

    const p = page();

    await quiet(async () => {
        await p.startConfirmed("recording");
        const live = await p.startConfirmed("live", "unlisted");

        assert.equal(live.ok, true);
        assert.equal(live.reusedStream, true, "Live rode on the confirmed stream");
    });

    assert.deepEqual(p.jitsi.starts, ["recording"], "one Jibri stream");

    p.jibriOff();

    assert.deepEqual(p.state(), { recording: "off", live: "off", jibri: "off" });
    assert.deepEqual(p.changes.at(-1).features, ["recording", "live"]);
});

test("7b. stopping one shared feature leaves the other on and Jibri running; the last stop stops Jibri once", async () => {
    reset();

    const p = page();

    await quiet(async () => {
        await p.startConfirmed("recording");
        await p.startConfirmed("live", "unlisted");

        const first = await p.controller.stop("live");

        assert.equal(first.ok, true);
        assert.equal(p.state().recording, "on", "the other feature is not marked inactive");
        assert.equal(p.jitsi.stops, 0);

        await p.controller.stop("recording");
    });

    assert.equal(p.jitsi.stops, 1);
    assert.equal(completions(db.recordings[0].broadcastId).length, 1);
});

// ---- 8-9: concurrency --------------------------------------------------------------------

test("8. two simultaneous starts for one lecture: one proceeds, the other is refused (409); one broadcast", async () => {
    reset();

    let results;

    await quiet(async () => {
        results = await Promise.all([
            post(routes.recordingStart, { lectureId: LECTURE }),
            post(routes.liveStart, { lectureId: LECTURE, privacy: "public" })
        ]);
    });

    const statuses = results.map(r => r.status).sort();

    assert.deepEqual(statuses, [200, 409]);
    assert.equal(results.find(r => r.status === 409).data.code, "YOUTUBE_OPERATION_IN_PROGRESS");
    assert.equal(created().length, 1, "no duplicate broadcast");
    assert.equal(locks.size, 0, "released");

    // Same feature twice at once.
    reset();

    await quiet(async () => {
        results = await Promise.all([
            post(routes.recordingStart, { lectureId: LECTURE }),
            post(routes.recordingStart, { lectureId: LECTURE })
        ]);
    });

    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(db.recordings.length, 1);
});

test("8b. the second start of a feature knows the first one's stream: startJibri false (no second Jibri)", async () => {
    reset();

    let first;
    let second;

    await quiet(async () => {
        first = await post(routes.recordingStart, { lectureId: LECTURE });
        second = await post(routes.liveStart, { lectureId: LECTURE, privacy: "public" });
    });

    assert.equal(first.data.startJibri, true);
    assert.equal(second.data.startJibri, false);
});

test("8c. lock expiry: a crashed holder's lock is taken over once expired; a fresh one still refuses", async () => {
    reset();

    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "crashed", expiresAt: new Date(Date.now() - 1000) });

    const afterExpiry = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    assert.equal(afterExpiry.status, 200);
    assert.equal(locks.size, 0);

    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "busy", expiresAt: new Date(Date.now() + 30_000) });

    const whileHeld = await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));

    assert.equal(whileHeld.status, 409);
    assert.equal(locks.get(LECTURE).ownerId, "busy", "someone else's lock is never removed");
});

// Stage 8 (D7): one teacher has ONE reusable YouTube stream, so two of their
// lectures can no longer both start at once (before Stage 8 this test
// expected both to succeed, feeding one stream from two classes).
test("9. simultaneous starts in two lectures of the same teacher: one proceeds, the other is refused (one stream)", async () => {
    reset();

    let results;

    await quiet(async () => {
        results = await Promise.all([
            post(routes.recordingStart, { lectureId: LECTURE }),
            post(routes.recordingStart, { lectureId: LECTURE_2 })
        ]);
    });

    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(created().length, 1);
    assert.equal(locks.size, 0);
});

// ---- 10: stops --------------------------------------------------------------------------

test("10a. a YouTube lookup failure on stop changes nothing (503) and keeps the feature; a retry works", async () => {
    for (const feature of ["recording", "live"]) {
        reset();

        const p = page();

        await quiet(() => p.startConfirmed(feature, "public"));

        const rows = feature === "recording" ? db.recordings : db.lives;

        yt.getErrors.set(rows[0].broadcastId, transient());

        const failed = await quiet(() => p.controller.stop(feature));

        assert.equal(failed.ok, false, feature);
        assert.equal(failed.status, 503);
        assert.equal(failed.data.code, "YOUTUBE_BROADCAST_CHECK_FAILED");
        assert.equal(p.state()[feature], "on", feature + ": still shown as running");
        assert.equal(active(rows).length, 1, "row unchanged");
        assert.equal(p.jitsi.stops, 0, "Jibri not stopped");

        yt.getErrors.clear();

        const retried = await quiet(() => p.controller.stop(feature));

        assert.equal(retried.ok, true, feature);
        assert.equal(p.jitsi.stops, 1);
    }
});

test("10b. a broadcast YouTube no longer knows / already completed is closed on stop (never left active)", async () => {
    for (const situation of ["gone", "complete"]) {
        reset();

        const p = page();

        await quiet(() => p.startConfirmed("recording"));

        if (situation === "gone") yt.broadcasts.delete(db.recordings[0].broadcastId);
        else yt.broadcasts.get(db.recordings[0].broadcastId).lifecycle = "complete";

        const stopped = await quiet(() => p.controller.stop("recording"));

        assert.equal(stopped.ok, true, situation);
        assert.equal(active(db.recordings).length, 0, situation);
        assert.equal(db.recordings[0].status, situation === "gone" ? "REVOKED" : "COMPLETE");
    }
});

test("10c. repeated stops and a lookup failure never complete a shared broadcast while the other feature runs", async () => {
    reset();

    const p = page();

    await quiet(async () => {
        await p.startConfirmed("recording");
        await p.startConfirmed("live", "unlisted");
    });

    // YouTube is failing; the shared stop does not need it.
    yt.getErrors.set(db.recordings[0].broadcastId, transient());

    for (let i = 0; i < 3; i++) {
        const result = await quiet(() => post(routes.liveStop, { lectureId: LECTURE }));

        assert.equal(result.data.success, true);
        assert.equal(result.data.stopJibri, false);
    }

    assert.deepEqual(completions(db.recordings[0].broadcastId), []);
    assert.equal(active(db.recordings).length, 1);
});

test("10d. a YouTube refusal to complete a live broadcast is a 503 (retry), not a silent success", async () => {
    reset();

    const p = page();

    await quiet(() => p.startConfirmed("live", "public"));

    const broadcastId = db.lives[0].broadcastId;

    yt.broadcasts.get(broadcastId).lifecycle = "live";

    const transition = fakes.yt.broadcasts.get(broadcastId);
    const original = require(path.join(root, "lib/youtube-live.ts")).transitionYouTubeLiveBroadcast;
    const youtubeLive = require(path.join(root, "lib/youtube-live.ts"));

    youtubeLive.transitionYouTubeLiveBroadcast = async () => { throw new Error("Failed to transition YouTube broadcast."); };

    try {
        const result = await quiet(() => p.controller.stop("live"));

        assert.equal(result.ok, false);
        assert.equal(result.data.code, "YOUTUBE_BROADCAST_STOP_FAILED");
        assert.equal(active(db.lives).length, 1);
        assert.equal(transition.lifecycle, "live");
    } finally {
        youtubeLive.transitionYouTubeLiveBroadcast = original;
    }
});

// ---- 11: stale / unrelated events --------------------------------------------------------

test("11. only the main room's YouTube stream events count; stale events change nothing", () => {
    assert.equal(toYouTubeStreamStatus({ on: true, mode: "stream" }, { inBreakout: true }), null, "breakout room");
    assert.equal(toYouTubeStreamStatus({ on: true, mode: "file" }, { inBreakout: false }), null, "file recording");
    assert.equal(toYouTubeStreamStatus({ on: true, mode: "stream", transcription: true }, { inBreakout: false }), null);
    assert.equal(toYouTubeStreamStatus({ mode: "stream" }, { inBreakout: false }), null, "malformed");
    assert.equal(toYouTubeStreamStatus(null, { inBreakout: false }), null);
    assert.deepEqual(toYouTubeStreamStatus({ on: false, mode: "stream", error: "busy" }, { inBreakout: false }), { on: false, error: "busy" });

    const p = page();

    // An "off" for a stream nobody uses on this page: no feature affected, no notice.
    p.controller.onStreamStatus({ on: false });
    assert.deepEqual(p.state(), { recording: "off", live: "off", jibri: "off" });
    assert.equal(p.changes.some(c => c.type === "jibri-stopped"), false);

    // An unrelated "on" (e.g. another moderator's stream): no feature becomes active.
    p.controller.onStreamStatus({ on: true });
    assert.equal(p.state().recording, "off");
    assert.equal(p.state().live, "off");
    assert.equal(p.jitsi.stops, 0, "and it is not stopped by this page");
});

test("11b. the off event of a stop this page asked for does not fail a new start made right after", async () => {
    reset();

    const p = page();

    await quiet(async () => {
        await p.startConfirmed("recording");
        await p.controller.stop("recording");
    });

    assert.equal(p.jitsi.stops, 1);

    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("recording");
        await settle();

        p.controller.onStreamStatus({ on: false }); // the earlier stop's event, late
        assert.equal(p.state().recording, "starting");

        p.jibriOn();
        outcome = await pending;
    });

    assert.equal(outcome.ok, true);
});

// ---- 12: restore vs Jibri ------------------------------------------------------------

test("12. restored from the database but Jibri disagrees: Jibri wins", () => {
    const p = page();

    p.controller.serverReport("recording", true);
    p.controller.serverReport("live", true);
    assert.deepEqual(p.state(), { recording: "restored", live: "restored", jibri: "unknown" });

    // Jibri confirms: verified.
    p.controller.onStreamStatus({ on: true });
    assert.deepEqual(p.state(), { recording: "on", live: "on", jibri: "on" });

    // A database row alone is not a running stream: Jibri off ends them.
    const q = page();

    q.controller.serverReport("recording", true);
    q.controller.onStreamStatus({ on: false });
    assert.equal(q.state().recording, "off");
    assert.deepEqual(q.changes.at(-1), { type: "jibri-stopped", features: ["recording"], error: undefined });
});

test("12b. the server's live report never overrides a start in progress (no early Stop Live)", async () => {
    reset();

    const p = page();
    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("live", { privacy: "public" });
        await settle();

        p.controller.serverReport("live", true);  // e.g. the SSE snapshot after "started"
        assert.equal(p.state().live, "starting");

        p.controller.serverReport("live", false);
        assert.equal(p.state().live, "starting");

        p.jibriOn();
        outcome = await pending;
    });

    assert.equal(outcome.ok, true);
    assert.equal(p.state().live, "on");
});

test("12c. after a reload, a start on the restored feature's stream waits for Jibri's own confirmation", async () => {
    reset();

    await quiet(() => page().startConfirmed("recording"));

    const p = page();

    p.controller.serverReport("recording", true);
    yt.streamActive = true; // YouTube says the stream is arriving: not proof of Jibri

    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("live", { privacy: "unlisted" });
        await settle();

        assert.equal(p.state().live, "starting", "YouTube's stream status alone does not make it active");
        assert.deepEqual(p.jitsi.starts, [], "no second Jibri stream (the server says the recording owns it)");

        // Jitsi reports the running stream: both features are verified.
        p.controller.onStreamStatus({ on: true });
        outcome = await pending;
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.reusedStream, true);
    assert.deepEqual(p.state(), { recording: "on", live: "on", jibri: "on" });
});

test("12d. the controller's stop never stops Jibri while the other feature is starting on this page", async () => {
    reset();

    const p = page();

    await quiet(() => p.startConfirmed("live", "public"));

    // Jibri drops; Record is clicked (starting, waiting on Jibri); the Live stop goes through meanwhile.
    p.jibriOff();

    await quiet(async () => {
        const pending = p.controller.start("recording");
        await settle();

        await p.controller.stop("live");
        assert.equal(p.jitsi.stops, 0);

        p.jibriOn();
        await pending;
    });

    assert.equal(p.state().recording, "on");
});

// ---- Pre-deployment fix D1: Jibri evidence, never YouTube's stream status alone ------

test("D1a. reload after a stop: YouTube still says 'active', nothing else is active -> Jibri is started, not assumed", async () => {
    reset();

    await quiet(async () => {
        const before = page();
        await before.startConfirmed("recording");
        await before.controller.stop("recording");
    });

    const p = page();         // fresh page: Jibri state unknown
    yt.streamActive = true;   // YouTube's stream status lags behind the stop

    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("recording");
        await settle();

        assert.equal(p.state().recording, "starting", "not active on YouTube's word");
        assert.deepEqual(p.jitsi.starts, ["recording"], "Jibri is asked to start");

        p.jibriOn();
        outcome = await pending;
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.reusedStream, false);
    assert.equal(p.state().recording, "on");
});

test("D1b. a stale 'active' stream status with no Jibri behind it is never adopted: the start times out and cleans up", async () => {
    reset();

    const p = page();
    yt.streamActive = true;

    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("live", { privacy: "public" });
        await settle();
        p.timeout();
        outcome = await pending;
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "jibri-timeout");
    assert.equal(p.state().live, "off");
    assert.equal(db.lives[0].status, "REVOKED");
    assert.equal(p.jitsi.stops, 1, "its own Jibri start is stopped");
});

test("D1c. a stream genuinely confirmed by Jibri on this page is reused at once", async () => {
    reset();

    const p = page();

    await quiet(() => p.startConfirmed("recording"));
    yt.streamActive = false; // whatever YouTube says, Jibri confirmed it on this page

    const outcome = await quiet(() => p.controller.start("live", { privacy: "unlisted" }));

    assert.equal(outcome.ok, true);
    assert.equal(outcome.reusedStream, true);
    assert.deepEqual(p.jitsi.starts, ["recording"], "no second Jibri start");
    assert.equal(p.state().live, "on");
});

// ---- Pre-deployment fix D2: a server report cannot revive a feature after Jibri stopped ----

test("D2a. unexpected Jibri stop, then an SSE snapshot reporting Live: Live stays off", async () => {
    reset();

    const p = page();

    await quiet(() => p.startConfirmed("live", "public"));
    p.jibriOff("jibri-crashed");

    assert.equal(p.state().live, "off");

    p.controller.serverReport("live", true); // e.g. the EventSource reconnected
    assert.equal(p.state().live, "off", "a database row does not bring back a stopped stream");
});

test("D2b. once Jibri is confirmed on again, a later report restores Live (as on)", async () => {
    reset();

    const p = page();

    await quiet(() => p.startConfirmed("live", "public"));
    p.jibriOff();
    p.controller.serverReport("live", true);
    assert.equal(p.state().live, "off");

    // The teacher records again: Jibri restarted and confirmed.
    await quiet(() => p.startConfirmed("recording"));
    assert.equal(p.state().jibri, "on");

    p.controller.serverReport("live", true);
    assert.equal(p.state().live, "on");
});

test("D2c. a new start in progress ignores old server snapshots", async () => {
    reset();

    const p = page();

    await quiet(() => p.startConfirmed("live", "public"));
    p.jibriOff();

    let outcome;

    await quiet(async () => {
        const pending = p.controller.start("live", { privacy: "public" });
        await settle();

        p.controller.serverReport("live", true);
        assert.equal(p.state().live, "starting");
        p.controller.serverReport("live", false);
        assert.equal(p.state().live, "starting");

        p.jibriOn();
        outcome = await pending;
    });

    assert.equal(outcome.ok, true);
    assert.equal(p.state().live, "on");
});

test("D2d. Recording and Live sharing one broadcast: neither is revived after Jibri stopped; a new conference restores normally", async () => {
    reset();

    const p = page();

    await quiet(async () => {
        await p.startConfirmed("recording");
        await p.startConfirmed("live", "unlisted");
    });

    assert.equal(db.lives[0].broadcastId, db.recordings[0].broadcastId);

    p.jibriOff();
    p.controller.serverReport("live", true);
    p.controller.serverReport("recording", true);
    assert.deepEqual(p.state(), { recording: "off", live: "off", jibri: "off" });

    // Rejoined conference: Jibri's state is unknown again; reports restore (unverified).
    p.controller.conferenceChanged();
    p.controller.serverReport("live", true);
    assert.equal(p.state().live, "restored");
});
