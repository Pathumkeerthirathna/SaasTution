/*
 * Manual Stop that YouTube did not confirm (503 YOUTUBE_STOP_UNCONFIRMED), and
 * Stop's version-conditional row close.
 *
 *   npm run test:youtube
 *
 * Fix 1 (teacher page): the real controller (components/Jitsi/youtube-stream-
 * controller.ts) remembers the unconfirmed Stop; when the server later reports
 * the feature inactive (YouTube ended it), Jibri is stopped by the confirmed-
 * Stop rule, once. Stop waits briefly ("Checking with YouTube…"), never for
 * good.
 *
 * Fix 2 (server): Stop closes its row only at the version it read, so a Stop
 * that stalled past its lock never closes a newer generation a start made.
 *
 * Real routes, controller, lock and library code against youtube-fakes.cjs.
 * Nothing contacts YouTube, Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");

const { LECTURE, db, yt, locks, routes, reset, post, quiet, active, completions, getLiveSnapshot } = fakes;

const root = path.resolve(__dirname, "..", "..");
const controllerLib = require(path.join(root, "components/Jitsi/youtube-stream-controller.ts"));
const { createYouTubeStreamController, STOP_CHECKING_CODE } = controllerLib;

// ---- Helpers --------------------------------------------------------------

const liveRow = () => db.lives[db.lives.length - 1];
const recordingRow = () => db.recordings[db.recordings.length - 1];

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

// YouTube answers `complete` with HTTP success but reports this lifecycle (null: none).
function answerWith(lifecycle) {
    yt.transitionAnswer = id => (lifecycle === null ? { id } : { id, status: { lifeCycleStatus: lifecycle } });
}

// A teacher page: the real controller wired to the real routes, a fake Jitsi and a manual timer.
function page() {
    const timers = [];
    const jitsi = { starts: [], stops: 0 };
    const stopCalls = [];

    const controller = createYouTubeStreamController({
        startFeature: (feature, { privacy }) => feature === "recording"
            ? post(routes.recordingStart, { lectureId: LECTURE, privacy: "unlisted" })
            : post(routes.liveStart, { lectureId: LECTURE, privacy }),
        abortStart: (feature, body) => post(routes.startAbort, { lectureId: LECTURE, feature, ...body }),
        stopFeature: feature => {
            stopCalls.push(feature);
            return post(feature === "recording" ? routes.recordingStop : routes.liveStop, { lectureId: LECTURE });
        },
        startJibri: (_key, _broadcastId, feature) => { jitsi.starts.push(feature); },
        stopJibri: () => { jitsi.stops += 1; },
        schedule: (fn, ms) => {
            const timer = { fn, ms, done: false };
            timers.push(timer);
            return () => { timer.done = true; };
        }
    });

    return {
        controller,
        jitsi,
        stopCalls,
        timers,
        state: () => controller.getState(),
        jibriOn: () => { yt.streamActive = true; controller.onStreamStatus({ on: true }); },
        // The pending timers with this delay run (e.g. the 10 s Stop wait).
        elapse: ms => timers.filter(t => !t.done && t.ms === ms).forEach(t => { t.done = true; t.fn(); }),
        async startConfirmed(feature, privacy) {
            const pending = controller.start(feature, { privacy });
            await settle();
            if (controller.getState()[feature] === "starting") this.jibriOn();
            return pending;
        }
    };
}

// The live-status report the page gets (SSE): the real snapshot, which closes a
// row whose broadcast YouTube reports ended.
async function reportLive(p) {
    const { isLive } = await getLiveSnapshot(LECTURE, "teacher");
    p.controller.serverReport("live", isLive);
    return isLive;
}

// Stop Live answered "live" by YouTube: unconfirmed.
async function unconfirmedStopLive(p) {
    answerWith("live");
    const outcome = await p.controller.stop("live");
    yt.transitionAnswer = null;

    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 503);
    assert.equal(outcome.data.code, "YOUTUBE_STOP_UNCONFIRMED");
    return outcome;
}

// ---- Fix 1: Jibri after a late YouTube confirmation -----------------------------

test("1. unconfirmed Stop, then a later inactive server report: Jibri stopped exactly once", async () => {
    reset();
    const p = page();

    await quiet(() => p.startConfirmed("live", "unlisted"));
    assert.equal(p.state().live, "on");
    assert.equal(p.state().jibri, "on");

    await quiet(() => unconfirmedStopLive(p));

    assert.equal(p.state().live, "on", "unconfirmed: still shown on");
    assert.equal(p.jitsi.stops, 0, "unconfirmed: Jibri not stopped");
    assert.deepEqual(p.controller.unconfirmedStops(), ["live"]);
    assert.equal(active([liveRow()]).length, 1);

    // Still live on YouTube: a report says active; nothing stops.
    assert.equal(await quiet(() => reportLive(p)), true);
    assert.equal(p.jitsi.stops, 0);
    assert.equal(p.state().live, "on");
    assert.deepEqual(p.controller.unconfirmedStops(), ["live"], "still pending");

    // YouTube completes it late; the next report closes the row and says inactive.
    yt.autoStop(liveRow().broadcastId, new Date());
    assert.equal(await quiet(() => reportLive(p)), false);

    assert.equal(liveRow().status, "COMPLETE");
    assert.equal(p.state().live, "off");
    assert.equal(p.jitsi.stops, 1, "Jibri stopped by the confirmed-Stop rule");
    assert.deepEqual(p.controller.unconfirmedStops(), []);

    // Further inactive reports (SSE keeps sending): no duplicate stop.
    await quiet(() => reportLive(p));
    p.controller.serverReport("live", false);
    assert.equal(p.jitsi.stops, 1, "exactly once");
});

test("2. Jibri is NOT stopped when the other feature is still active (separate broadcasts)", async () => {
    reset();
    const p = page();

    await quiet(() => p.startConfirmed("recording"));
    await quiet(() => p.startConfirmed("live", "public")); // its own broadcast

    assert.notEqual(recordingRow().broadcastId, liveRow().broadcastId);
    assert.equal(p.state().recording, "on");

    await quiet(() => unconfirmedStopLive(p));

    yt.autoStop(liveRow().broadcastId, new Date());
    assert.equal(await quiet(() => reportLive(p)), false);

    assert.equal(p.state().live, "off");
    assert.equal(p.state().recording, "on", "recording untouched");
    assert.equal(p.jitsi.stops, 0, "the recording still uses the stream");
    assert.deepEqual(p.controller.unconfirmedStops(), [], "the late stop is finished");
    assert.equal(active([recordingRow()]).length, 1);
});

test("3. the short wait after an unconfirmed Stop: \"Checking with YouTube…\", then Stop can be pressed again (timer or next report)", async () => {
    reset();
    const p = page();

    await quiet(() => p.startConfirmed("live", "unlisted"));
    await quiet(() => unconfirmedStopLive(p));

    assert.deepEqual(p.controller.stopChecking(), ["live"]);
    assert.equal(controllerLib.DEFAULT_STOP_CHECK_WAIT_MS, 10_000);

    // During the wait: refused on the page, nothing sent to the server.
    const calls = p.stopCalls.length;
    const waiting = await p.controller.stop("live");

    assert.equal(waiting.ok, false);
    assert.equal(waiting.data.code, STOP_CHECKING_CODE);
    assert.equal(waiting.data.error, "Checking with YouTube…");
    assert.equal(p.stopCalls.length, calls, "no request during the wait");

    // The wait expires (about 10 s): Stop works again.
    p.elapse(controllerLib.DEFAULT_STOP_CHECK_WAIT_MS);
    assert.deepEqual(p.controller.stopChecking(), []);

    // YouTube now confirms: the retry stops it normally (one Jibri stop).
    const retry = await quiet(() => p.controller.stop("live"));

    assert.equal(retry.ok, true, JSON.stringify(retry.data));
    assert.equal(p.stopCalls.length, calls + 1);
    assert.equal(liveRow().status, "COMPLETE");
    assert.equal(p.state().live, "off");
    assert.equal(p.jitsi.stops, 1);
    assert.deepEqual(p.controller.unconfirmedStops(), []);

    // A later report changes nothing (no second Jibri stop).
    await quiet(() => reportLive(p));
    assert.equal(p.jitsi.stops, 1);

    // Or the wait ends at the next server report (still live: nothing else changes).
    reset();
    const q = page();

    await quiet(() => q.startConfirmed("live", "unlisted"));
    await quiet(() => unconfirmedStopLive(q));
    assert.deepEqual(q.controller.stopChecking(), ["live"]);
    assert.equal(await quiet(() => reportLive(q)), true);
    assert.deepEqual(q.controller.stopChecking(), [], "the next report ends the wait");
    assert.deepEqual(q.controller.unconfirmedStops(), ["live"], "still awaiting YouTube's end");
    assert.equal(q.state().live, "on");
    assert.equal(q.jitsi.stops, 0);
});

test("3b. the pending Stop is cleared when the feature starts again, and when the classroom ends", async () => {
    // A new start of the feature.
    reset();
    const p = page();

    await quiet(() => p.startConfirmed("live", "unlisted"));
    await quiet(() => unconfirmedStopLive(p));

    // YouTube ends it; the page has not heard yet; the teacher starts Live again.
    yt.autoStop(liveRow().broadcastId, new Date());
    const restart = p.controller.start("live", { privacy: "unlisted" });

    assert.deepEqual(p.controller.unconfirmedStops(), [], "forgotten by the new start");
    assert.deepEqual(p.controller.stopChecking(), []);
    await quiet(async () => { await settle(); await restart; });
    assert.equal(p.state().live, "on", "the new Live rides on the running stream");

    // An inactive report about the OLD Live never stops the new one's stream.
    p.controller.serverReport("live", false);
    assert.equal(p.jitsi.stops, 0);

    // The classroom ends: everything forgotten (Jibri stopped once, by the session end).
    reset();
    const q = page();

    await quiet(() => q.startConfirmed("live", "unlisted"));
    await quiet(() => unconfirmedStopLive(q));
    q.controller.sessionEnded();

    assert.deepEqual(q.controller.unconfirmedStops(), []);
    assert.deepEqual(q.controller.stopChecking(), []);
    assert.equal(q.jitsi.stops, 1);
    q.controller.serverReport("live", false);
    assert.equal(q.jitsi.stops, 1, "no second stop");
});

// ---- Fix 2: version-conditional Stop close -------------------------------------

// The lecture lock expires (the Stop holding it stalled past its lifetime).
function expireLocks() {
    for (const lock of locks.values()) lock.expiresAt = new Date(Date.now() - 1);
}

test("4. a Stop stalled past its lock while a start reuses the row: the old Stop cannot close the new generation (shared broadcast)", async () => {
    reset();
    const p = page();

    await quiet(() => p.startConfirmed("recording"));
    await quiet(() => p.startConfirmed("live", "unlisted")); // shares the recording's broadcast

    const live = liveRow();

    assert.equal(live.broadcastId, recordingRow().broadcastId);
    assert.equal(live.version, 0);

    // Stop Live reads the row and finds the broadcast shared; then it stalls,
    // its lock expires, and the teacher's Start Live (another tab) runs: the
    // real start route reuses the active Live row (a new generation).
    const recordings = fakes.prisma.youTubeRecording;
    const findFirst = recordings.findFirst;
    let restart;

    recordings.findFirst = async args => {
        const found = await findFirst(args);

        if (args?.where?.broadcastId === live.broadcastId && !restart) {
            recordings.findFirst = findFirst;
            expireLocks();
            restart = await post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" });
        }
        return found;
    };

    let stop;

    try {
        stop = await quiet(() => post(routes.liveStop, { lectureId: LECTURE }));
    } finally {
        recordings.findFirst = findFirst;
    }

    assert.equal(restart.status, 200, JSON.stringify(restart.data));
    assert.equal(live.version, 1, "the start made a new generation");

    assert.equal(stop.status, 409, JSON.stringify(stop.data));
    assert.equal(stop.data.code, "YOUTUBE_FEATURE_CHANGED");
    assert.equal(active([live]).length, 1, "the new generation stays active");
    assert.equal(live.version, 1);
    assert.equal(completions(live.broadcastId).length, 0, "shared: YouTube never asked");
});

test("4b. own broadcast: a newer version at close time is never closed; an already-closed row (a status check) is still a normal Stop", async () => {
    // A newer generation appears after the transition (simulated directly: a
    // real start is refused while the late-`complete` protection is set).
    reset();
    const p = page();

    await quiet(() => p.startConfirmed("live", "unlisted"));

    const lives = fakes.prisma.youTubeLiveBroadcast;
    const updateMany = lives.updateMany;
    const live = liveRow();

    lives.updateMany = async args => {
        if (args?.data?.status === "COMPLETE" && args.where?.id === live.id) {
            lives.updateMany = updateMany;
            live.version += 1;
            live.generationStartedAt = new Date();
        }
        return updateMany(args);
    };

    let stop;

    try {
        stop = await quiet(() => post(routes.liveStop, { lectureId: LECTURE }));
    } finally {
        lives.updateMany = updateMany;
    }

    assert.equal(stop.status, 409, JSON.stringify(stop.data));
    assert.equal(stop.data.code, "YOUTUBE_FEATURE_CHANGED");
    assert.equal(active([live]).length, 1, "the newer generation is not closed");
    assert.ok(live.completeRequestedAt instanceof Date, "not closed: the protection stays");

    // A status check (no lock) closed the row first: Stop answers success as before.
    reset();
    const q = page();

    await quiet(() => q.startConfirmed("live", "unlisted"));

    const row = liveRow();

    lives.updateMany = async args => {
        if (args?.data?.status === "COMPLETE" && args.where?.id === row.id) {
            lives.updateMany = updateMany;
            row.status = "COMPLETE";
            row.endedAt = new Date();
        }
        return updateMany(args);
    };

    try {
        stop = await quiet(() => post(routes.liveStop, { lectureId: LECTURE }));
    } finally {
        lives.updateMany = updateMany;
    }

    assert.equal(stop.status, 200, JSON.stringify(stop.data));
    assert.equal(stop.data.broadcastCompleted, true);
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.completeRequestedAt, null, "YouTube confirmed: cleared as before");
});

// ---- Existing behaviour ----------------------------------------------------

test("5. a confirmed Stop is unchanged: row closed, marker cleared, Jibri stopped once, no wait, nothing pending", async () => {
    reset();
    const p = page();

    await quiet(() => p.startConfirmed("live", "unlisted"));

    const live = liveRow();
    const outcome = await quiet(() => p.controller.stop("live"));

    assert.equal(outcome.ok, true, JSON.stringify(outcome.data));
    assert.equal(outcome.data.status, "COMPLETE");
    assert.equal(live.status, "COMPLETE");
    assert.equal(live.version, 0);
    assert.equal(live.completeRequestedAt, null);
    assert.equal(completions(live.broadcastId).length, 1);
    assert.equal(p.state().live, "off");
    assert.equal(p.jitsi.stops, 1);
    assert.deepEqual(p.controller.unconfirmedStops(), []);
    assert.deepEqual(p.controller.stopChecking(), []);
    assert.equal(p.timers.filter(t => !t.done && t.ms === controllerLib.DEFAULT_STOP_CHECK_WAIT_MS).length, 0, "no wait");

    // Shared broadcast: only this row closes, YouTube not asked, Jibri kept for the other feature.
    reset();
    const q = page();

    await quiet(() => q.startConfirmed("recording"));
    await quiet(() => q.startConfirmed("live", "unlisted"));

    const shared = await quiet(() => q.controller.stop("live"));

    assert.equal(shared.ok, true, JSON.stringify(shared.data));
    assert.equal(shared.data.sharedWithRecording, true);
    assert.equal(liveRow().status, "COMPLETE");
    assert.equal(active([recordingRow()]).length, 1);
    assert.equal(q.jitsi.stops, 0);

    // Other failures (not "unconfirmed") start no wait and leave nothing pending.
    reset();
    const r = page();

    await quiet(() => r.startConfirmed("live", "unlisted"));
    yt.transitionErrors.set(liveRow().broadcastId, new Error("YouTube API request failed: 503 backendError"));
    const failed = await quiet(() => r.controller.stop("live"));
    yt.transitionErrors.clear();

    assert.equal(failed.ok, false);
    assert.notEqual(failed.data.code, "YOUTUBE_STOP_UNCONFIRMED");
    assert.deepEqual(r.controller.unconfirmedStops(), []);
    assert.deepEqual(r.controller.stopChecking(), []);
});
