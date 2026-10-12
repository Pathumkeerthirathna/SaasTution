/*
 * Regression tests (Stage 6):
 *   H2 - bounded YouTube requests under the lecture lock and in session cleanup;
 *        a timeout is reported as pending / an error, never as success;
 *   M1 - a pending or failed reconciliation blocks the start (503); reuse is
 *        limited to the current class session;
 *   M3 - no start without an active class session; a start answer that
 *        arrives after sessionEnded() starts nothing.
 *
 *   npm run test:youtube
 *
 * Fakes only (tests/youtube/youtube-fakes.cjs): Prisma, YouTube, the login
 * session, a fetch that never reaches the network. A "stalled" YouTube call
 * runs through the REAL lib/youtube-request.ts limits. Nothing contacts
 * YouTube, Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");
const {
    TEACHER, LECTURE, CLASS, db, yt, jibri, locks, lockAttempts, routes, prisma,
    reset, post, teacherPage, quiet, created, completions, active
} = fakes;
const { youtubeTimeouts } = fakes.youtubeRequest;

const root = path.resolve(__dirname, "..", "..");
const { createYouTubeStreamController } = require(path.join(root, "components/Jitsi/youtube-stream-controller.ts"));
const sessionService = require(path.join(root, "services/session-service.ts"));

const transient = () => new Error("YouTube API request failed: 503 backendError");

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

async function waitFor(condition, label) {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(condition(), label);
}

// The lecture's class sessions, managed by the test (the default ones are dropped).
function activeSession(id, startedAgoMs) {
    db.sessions = db.sessions.filter(s => !s.fixture);

    const row = {
        id, classId: CLASS, lectureId: LECTURE, isActive: true,
        // "Now": after every row created so far (the fake database clock).
        startedAt: startedAgoMs ? new Date(Date.now() - startedAgoMs) : fakes.now(),
        endedAt: null, teacherId: TEACHER
    };

    db.sessions.push(row);
    return row;
}

const allActive = () => active(db.recordings).length + active(db.lives).length;

async function sharedRecordingAndLive() {
    await quiet(async () => {
        const page = teacherPage();
        await page.record();
        await page.goLive("unlisted");
    });

    return db.recordings[0].broadcastId;
}

// Session s1's features are left active: its End Session found the lock busy.
async function endS1WithCleanupPending() {
    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "someone", expiresAt: new Date(Date.now() + 30_000) });

    const result = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));

    assert.equal(result.youtubeCleanup.status, "pending");
    locks.clear();
}

// ===================================================================================
// H2 - timeouts
// ===================================================================================

test("H2: End Session with YouTube stalled is bounded, reports pending/timeout, changes no feature row", async () => {
    reset();
    activeSession("s1", 60_000);

    const broadcastId = await sharedRecordingAndLive();

    Object.assign(youtubeTimeouts, { requestMs: 10_000, sessionCleanupMs: 120 });
    yt.stall.add("get");

    const started = Date.now();
    const result = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 2_000, `bounded by the cleanup budget, not the 10 s request limit (${elapsed} ms)`);
    assert.deepEqual(result.youtubeCleanup, {
        status: "pending", reason: "timeout", closed: 0, pendingBroadcastIds: [broadcastId]
    });
    assert.equal(allActive(), 2, "nothing marked ended while YouTube did not answer");
    assert.deepEqual(completions(broadcastId), [], "no completion was attempted after the stall");
    assert.equal(db.sessions[0].isActive, false, "the session still ended");
    assert.equal(db.attendanceCloses.length, 1, "attendance still closed");
    assert.equal(locks.size, 0, "the lock was released");
});

test("H2: starting a new session with YouTube stalled is bounded; the new session exists; the next start reconciles", async () => {
    reset();
    activeSession("s1", 60_000);

    const broadcastId = await sharedRecordingAndLive();

    Object.assign(youtubeTimeouts, { requestMs: 10_000, sessionCleanupMs: 120 });
    yt.stall.add("get");

    const started = Date.now();
    const restarted = await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE));

    assert.ok(Date.now() - started < 2_000, "the session start was not held up");
    assert.ok(restarted.session.isActive);
    assert.equal(allActive(), 2, "left pending, not pretended");

    // YouTube answers again: the next start of the new session ends the old features first.
    yt.stall.clear();
    const start = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    assert.equal(start.status, 200);
    assert.equal(completions(broadcastId).length, 1);
    assert.notEqual(start.data.broadcastId, broadcastId);
});

test("H2: a timed-out completion of a never-live broadcast is refused (503), never tolerated as 'never went live'", async () => {
    reset();

    const { data } = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    assert.equal(yt.broadcasts.get(data.broadcastId).lifecycle, "ready");

    Object.assign(youtubeTimeouts, { requestMs: 60 });
    yt.stall.add("transition");

    const stop = await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));

    assert.equal(stop.status, 503);
    assert.equal(stop.data.code, "YOUTUBE_TIMEOUT");
    assert.equal(active(db.recordings).length, 1, "the row stays active (YouTube may not have acted)");
    assert.equal(locks.size, 0);

    // An explicit refusal for a broadcast that never went live is still tolerated.
    yt.stall.clear();
    // (YouTube's 403 invalidTransition; Stage 7 identifies it positively.)
    yt.transitionErrors.set(data.broadcastId, new fakes.youtubeRequest.YouTubeApiError(
        "Failed to transition YouTube broadcast.", 403,
        JSON.stringify({ error: { errors: [{ reason: "invalidTransition" }] } })));

    const retried = await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));

    assert.equal(retried.status, 200);
    assert.equal(active(db.recordings).length, 0);
});

test("H2: failed-start cleanup with YouTube stalled answers 503 within its budget; nothing claimed, the row stays recoverable", async () => {
    reset();

    const { data } = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    Object.assign(youtubeTimeouts, { requestMs: 10_000, startAbortMs: 100 });
    yt.stall.add("get");

    const started = Date.now();
    const abort = await quiet(() => post(routes.startAbort, {
        lectureId: LECTURE, feature: "recording", rowId: data.rowId, ownsBroadcast: true
    }));

    assert.ok(Date.now() - started < 2_000, "within the abort budget (below the page's 10 s wait)");
    // Stage 7: an uncertain YouTube state never closes the row.
    assert.equal(abort.status, 503);
    assert.equal(abort.data.code, "YOUTUBE_TIMEOUT");
    assert.equal(active(db.recordings).length, 1, "the row stays active (recoverable by Stop / cleanup)");
    assert.deepEqual(completions(data.broadcastId), []);
    assert.equal(locks.size, 0);
});

test("H2: a start stalled on YouTube gives up before its lock expires; a concurrent start meanwhile gets 409; nothing after the deadline", async () => {
    reset();
    Object.assign(youtubeTimeouts, { requestMs: 10_000, lockTtlMs: 400, lockSafetyMarginMs: 200 });
    yt.stall.add("stream");

    let expiresAt;
    const first = quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));

    await waitFor(() => yt.calls.includes("stalled:stream"), "the first start is waiting on YouTube");
    expiresAt = locks.get(LECTURE).expiresAt.getTime();

    const second = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    const result = await first;
    const finishedAt = Date.now();

    assert.equal(second.status, 409, "no overlapping operation");
    assert.equal(result.status, 503);
    assert.equal(result.data.code, "YOUTUBE_TIMEOUT");
    assert.ok(finishedAt < expiresAt, `stopped ${expiresAt - finishedAt} ms before the lock expired`);
    assert.deepEqual(created(), [], "no YouTube request after the deadline");
    assert.equal(db.lives.length, 0);
    assert.equal(locks.size, 0, "released by its owner");
});

// ===================================================================================
// M1 - reconciliation gate
// ===================================================================================

test("M1: pending reconciliation refuses the start (503) - stale rows not reused, nothing created, no Jibri", async () => {
    reset();
    activeSession("s1", 60_000);

    const broadcastId = await sharedRecordingAndLive();

    await endS1WithCleanupPending();
    activeSession("s2", 0);

    const before = JSON.stringify([db.recordings, db.lives]);
    const startsBefore = jibri.starts;

    yt.getErrors.set(broadcastId, transient());

    const page = teacherPage();
    const live = await quiet(() => page.goLive("unlisted"));
    const recording = await quiet(() => page.record());

    for (const result of [live, recording]) {
        assert.equal(result.status, 503);
        assert.equal(result.data.code, "YOUTUBE_RECONCILIATION_PENDING");
    }

    assert.equal(created().length, 1, "no new broadcast");
    assert.equal(JSON.stringify([db.recordings, db.lives]), before, "stale rows untouched, not reused");
    assert.equal(jibri.starts, startsBefore, "no Jibri start");
    assert.equal(locks.size, 0);
});

test("M1: a reconciliation that times out also refuses the start (503)", async () => {
    reset();
    activeSession("s1", 60_000);

    await sharedRecordingAndLive();
    await endS1WithCleanupPending();
    activeSession("s2", 0);

    Object.assign(youtubeTimeouts, { requestMs: 60 });
    yt.stall.add("get");

    const result = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" }));

    assert.equal(result.status, 503);
    assert.equal(result.data.code, "YOUTUBE_RECONCILIATION_PENDING");
    assert.equal(created().length, 1);
    assert.equal(allActive(), 2);
});

test("M1: a broadcast the newer session uses is never ended by reconciliation of the older session's rows", async () => {
    reset();
    activeSession("s1", 60_000);

    // Session 1: a Public Live, live on YouTube; its End Session cleanup stays pending.
    const first = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));
    const oldBroadcast = first.data.broadcastId;

    yt.broadcasts.get(oldBroadcast).lifecycle = "live";
    await endS1WithCleanupPending();
    activeSession("s2", 0);

    // Session 2, YouTube answers the lookup but refuses the completion: before
    // Stage 6 the start went on and REUSED the old Live.
    yt.transitionErrors.set(oldBroadcast, transient());

    const refused = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));

    assert.equal(refused.status, 503);
    assert.equal(refused.data.code, "YOUTUBE_RECONCILIATION_PENDING");
    assert.equal(created().length, 1, "the old broadcast was not reused");

    // YouTube works again: the old broadcast is completed, the new session gets its own.
    yt.transitionErrors.clear();

    const live = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));

    assert.equal(live.status, 200);
    assert.notEqual(live.data.broadcastId, oldBroadcast);
    assert.equal(completions(oldBroadcast).length, 2, "the refused attempt, then the successful one");
    assert.equal(yt.broadcasts.get(oldBroadcast).lifecycle, "complete");
    assert.equal(db.lives.find(r => r.broadcastId === oldBroadcast).status, "COMPLETE");

    yt.broadcasts.get(live.data.broadcastId).lifecycle = "live";

    // A later start reconciles again: the newer session's Live is untouched.
    const recording = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    assert.equal(recording.status, 200);
    assert.deepEqual(completions(live.data.broadcastId), []);
    assert.equal(db.lives.find(r => r.broadcastId === live.data.broadcastId).status, "READY");
    assert.equal(active(db.lives).length, 1);
});

test("M1: reuse is limited to the current session even for a stale row that appears after reconciliation", async () => {
    reset();
    const s2 = activeSession("s2", 60_000);

    // While the start waits on YouTube (after its reconciliation), an active Live
    // row from before this session appears, on a broadcast YouTube reports live.
    yt.broadcasts.set("bc-stale", { privacy: "public", lifecycle: "live", stream: "stream-1" });
    yt.streamGate = () => {
        if (!db.lives.some(r => r.id === "live-stale")) {
            const old = new Date(s2.startedAt.getTime() - 60_000);
            db.lives.push({
                id: "live-stale", lectureId: LECTURE, broadcastId: "bc-stale", videoId: "bc-stale", youtubeUrl: "u",
                privacy: "PUBLIC", status: "LIVE", createdAt: old, startedAt: old, endedAt: null
            });
        }
        return null;
    };

    const live = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));

    assert.equal(live.status, 200);
    assert.notEqual(live.data.broadcastId, "bc-stale", "the stale row was not reused");
    assert.equal(created().length, 1);

    // The next start's reconciliation ends only the stale one.
    yt.streamGate = null;
    yt.broadcasts.get(live.data.broadcastId).lifecycle = "live";

    const recording = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    assert.equal(recording.status, 200);
    assert.equal(completions("bc-stale").length, 1);
    assert.deepEqual(completions(live.data.broadcastId), []);
});

// ===================================================================================
// M3 - active class session required
// ===================================================================================

for (const [label, route, body] of [
    ["Recording", "recordingStart", {}],
    ["Live", "liveStart", { privacy: "public" }]
]) {
    test(`M3: a ${label} start without an active class session is refused - no lock, YouTube call, row or Jibri`, async () => {
        reset();
        // Only another lecture has an active session.
        db.sessions = db.sessions.filter(s => s.lectureId !== LECTURE);
        db.connection.liveStreamId = null;

        const jitsi = { starts: 0 };
        const controller = createYouTubeStreamController({
            startFeature: () => post(routes[route], { lectureId: LECTURE, ...body }),
            abortStart: async () => ({ status: 200, data: { success: true } }),
            stopFeature: async () => ({ status: 200, data: { success: true } }),
            startJibri: () => { jitsi.starts += 1; },
            stopJibri: () => {}
        });

        const outcome = await quiet(() => controller.start(route === "liveStart" ? "live" : "recording", body));

        assert.equal(outcome.ok, false);
        assert.equal(outcome.status, 409);
        assert.equal(outcome.data.code, "CLASS_SESSION_NOT_ACTIVE");
        assert.deepEqual(lockAttempts, []);
        assert.deepEqual(yt.calls, []);
        assert.equal(db.recordings.length + db.lives.length, 0);
        assert.equal(db.connection.liveStreamId, null, "no stream created");
        assert.equal(jitsi.starts, 0);
        assert.equal(controller.getState()[route === "liveStart" ? "live" : "recording"], "off");
    });
}

test("M3: a session that ends between the check and the lock is caught under the lock (no YouTube call)", async () => {
    reset();
    activeSession("s1", 60_000);

    const create = prisma.youTubeOperationLock.create;

    prisma.youTubeOperationLock.create = async args => {
        db.sessions.forEach(s => { s.isActive = false; });
        return create(args);
    };

    try {
        const result = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));

        assert.equal(result.status, 409);
        assert.equal(result.data.code, "CLASS_SESSION_NOT_ACTIVE");
        assert.deepEqual(yt.calls, []);
        assert.equal(db.lives.length, 0);
        assert.equal(locks.size, 0);
    } finally {
        prisma.youTubeOperationLock.create = create;
    }
});

const START_OK = {
    status: 200,
    data: {
        success: true, streamName: "key", broadcastId: "bc-x", youtubeUrl: "u",
        rowId: "row-own", ownsRow: true, ownsBroadcast: true, startJibri: true
    }
};

// A controller whose start request is answered by the test.
function controllerHarness({ cleanup = { status: 200, data: { success: true, aborted: true, stopJibri: true } } } = {}) {
    const jitsi = { starts: 0, stops: 0 };
    const calls = { start: 0, cleanup: [] };
    const changes = [];
    let pending = null;

    const controller = createYouTubeStreamController({
        startFeature: () => {
            calls.start += 1;
            return new Promise((resolve, reject) => { pending = { resolve, reject }; });
        },
        abortStart: async (feature, body) => {
            calls.cleanup.push({ feature, ...body });
            return cleanup;
        },
        stopFeature: async () => ({ status: 200, data: { success: true, stopJibri: true } }),
        startJibri: () => { jitsi.starts += 1; },
        stopJibri: () => { jitsi.stops += 1; },
        cleanupTimeoutMs: 50,
        cleanupRetryDelaysMs: [0, 0]
    });

    controller.subscribe((_snapshot, change) => changes.push(change.type));

    return { controller, jitsi, calls, changes, answer: () => pending };
}

test("M3: a start answer arriving after sessionEnded() starts no Jibri, keeps the feature off and cleans up its own row", async () => {
    const h = controllerHarness();

    const outcome = h.controller.start("live", { privacy: "public" });
    await settle();

    h.controller.sessionEnded();
    h.answer().resolve(START_OK);

    assert.deepEqual(await outcome, { ok: false, reason: "session-ended" });
    assert.equal(h.jitsi.starts, 0, "no Jibri start");
    assert.equal(h.controller.getState().live, "off");
    assert.deepEqual(h.calls.cleanup, [{ feature: "live", rowId: "row-own", ownsBroadcast: true }]);
    assert.ok(!h.changes.includes("cleanup-pending"));

    // Nothing brings it back afterwards.
    h.controller.serverReport("live", true);
    assert.equal(h.controller.getState().live, "off", "a stale server report does not reactivate it");

    const stopsBefore = h.jitsi.stops;
    h.controller.onStreamStatus({ on: true });
    assert.equal(h.jitsi.stops, stopsBefore + 1, "a stream that comes up after the end is stopped");
    assert.equal(h.controller.getState().live, "off");

    assert.deepEqual(await h.controller.start("recording"), { ok: false, reason: "session-ended" });
    assert.equal(h.calls.start, 1, "no new start request after the session ended");
});

test("M3: an unconfirmed cleanup after the session ended is not shown as pending; a failed request does not restore the feature", async () => {
    const h = controllerHarness({ cleanup: { status: 503, data: { success: false } } });

    // Restored after a reload, then started again (e.g. a retry).
    h.controller.serverReport("recording", true);
    assert.equal(h.controller.getState().recording, "restored");

    const failing = h.controller.start("recording");
    await settle();
    h.controller.sessionEnded();
    h.answer().reject(new TypeError("Failed to fetch"));

    const outcome = await failing;

    assert.equal(outcome.ok, false);
    assert.equal(h.controller.getState().recording, "off", "not restored to its pre-start state");

    const h2 = controllerHarness({ cleanup: { status: 503, data: { success: false } } });
    const late = h2.controller.start("live");
    await settle();
    h2.controller.sessionEnded();
    h2.answer().resolve(START_OK);

    assert.deepEqual(await late, { ok: false, reason: "session-ended" });
    assert.equal(h2.calls.cleanup.length, 3, "bounded retries");
    assert.equal(h2.controller.getState().live, "off");
    assert.ok(!h2.changes.includes("cleanup-pending"));
    assert.equal(h2.jitsi.starts, 0);
});
