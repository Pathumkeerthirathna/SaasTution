/*
 * Regression tests (pre-deployment Stage 5B):
 *   Fix 1 - lecture ownership is checked before the lecture lock / any YouTube call;
 *   Fix 2 - failed-start cleanup: bounded retries, and Jibri stopped only on an
 *           explicit server "stopJibri: true";
 *   Fix 3 - YouTube features end with the class session (End Session, a
 *           replaced session), with reconciliation by the next start.
 *
 *   npm run test:youtube
 *
 * Fakes only: Prisma, YouTube and the login session (tests/youtube/youtube-
 * fakes.cjs), a scripted cleanup endpoint and a manual timer for the
 * controller. Nothing contacts YouTube, Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");
const {
    TEACHER, LECTURE, CLASS, db, yt, locks, lockAttempts, session, routes,
    reset, post, teacherPage, quiet, created, completions, active
} = fakes;

const root = path.resolve(__dirname, "..", "..");
const { createYouTubeStreamController } = require(path.join(root, "components/Jitsi/youtube-stream-controller.ts"));
const sessionService = require(path.join(root, "services/session-service.ts"));
const lifecycle = require(path.join(root, "lib/youtube-feature-lifecycle.ts"));
const sessionEvents = require(path.join(root, "lib/session-events.ts"));

const transient = () => new Error("YouTube API request failed: 503 backendError");

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

let liveEvents = [];
sessionEvents.subscribeLiveChanges(payload => liveEvents.push(`${payload.kind}:${payload.event}`));

// ===================================================================================
// Fix 1 - ownership before the lock
// ===================================================================================

function otherTeacher() {
    session.teacherId = "teacher-2";
    db.otherConnection = { teacherId: "teacher-2", refreshTokenEncrypted: "other-token", liveStreamId: null };
}

for (const [label, route, body] of [
    ["Recording", "recordingStart", {}],
    ["Live", "liveStart", { privacy: "public" }]
]) {
    test(`Fix 1: an unauthorized ${label} start is refused (403) before any lock, YouTube call or connection change`, async () => {
        reset();
        otherTeacher();

        const result = await quiet(() => post(routes[route], { lectureId: LECTURE, ...body }));

        assert.equal(result.status, 403);
        assert.deepEqual(lockAttempts, [], "the lecture lock was never touched");
        assert.deepEqual(yt.calls, [], "no YouTube call (no stream lookup / creation)");
        assert.equal(db.otherConnection.liveStreamId, null, "the caller's connection is unchanged");
        assert.equal(db.recordings.length + db.lives.length, 0);
    });
}

test("Fix 1: an unauthorized start cannot make the lecture's owner receive 409", async () => {
    reset();

    // Any YouTube request made with the other teacher's connection hangs.
    let release;
    const hang = new Promise(resolve => { release = resolve; });

    yt.streamGate = token => (token === "other-token" ? hang : null);
    otherTeacher();

    let intruder;
    let owner;

    await quiet(async () => {
        const intruderPending = post(routes.recordingStart, { lectureId: LECTURE });
        await settle();

        session.teacherId = TEACHER;
        owner = await post(routes.recordingStart, { lectureId: LECTURE });

        release();
        intruder = await intruderPending;
    });

    assert.equal(intruder.status, 403);
    assert.equal(owner.status, 200, "the owner was not blocked by the intruder");
    // Stage 8: the teacher's stream lock, then the lecture lock.
    assert.deepEqual(lockAttempts, ["teacher:" + TEACHER, LECTURE], "only the owner's start took the locks");
});

test("Fix 1: authorized concurrent starts keep the existing locking (one 409)", async () => {
    reset();

    const results = await quiet(() => Promise.all([
        post(routes.recordingStart, { lectureId: LECTURE }),
        post(routes.liveStart, { lectureId: LECTURE, privacy: "public" })
    ]));

    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(created().length, 1);
});

// ===================================================================================
// Fix 2 - failed-start cleanup
// ===================================================================================

const START_OK = {
    status: 200,
    data: {
        success: true, streamName: "key", broadcastId: "bc-x", youtubeUrl: "u",
        rowId: "row-own", ownsRow: true, ownsBroadcast: true, startJibri: true
    }
};

// A controller with a scripted cleanup endpoint. `cleanup` answers, in order:
// { status, data } | "network" | "hang" (never answers; the attempt times out).
function harness({ cleanup = [], start = START_OK, stop } = {}) {
    const timers = [];
    const jitsi = { starts: 0, stops: 0 };
    const cleanupCalls = [];
    const changes = [];
    const hanging = [];

    const controller = createYouTubeStreamController({
        startFeature: async () => start,
        abortStart: async (feature, body) => {
            cleanupCalls.push({ feature, ...body });
            const answer = cleanup[Math.min(cleanupCalls.length - 1, cleanup.length - 1)];
            if (answer === "network") throw new TypeError("Failed to fetch");
            if (answer === "hang") return new Promise(resolve => hanging.push(resolve));
            return answer;
        },
        stopFeature: async () => stop ?? { status: 200, data: { success: true, stopJibri: true } },
        startJibri: () => { jitsi.starts += 1; },
        stopJibri: () => { jitsi.stops += 1; },
        cleanupTimeoutMs: 10_000,
        cleanupRetryDelaysMs: [1_000, 3_000],
        schedule: (fn, ms) => {
            const timer = { fn, ms, done: false };
            timers.push(timer);
            return () => { timer.done = true; };
        }
    });

    controller.subscribe((_state, change) => changes.push(change));

    // Fires timers (confirmation timeout, per-attempt timeouts, backoff) until
    // `promise` settles: proves the cleanup is bounded.
    async function drive(promise) {
        let done = false;
        let value;

        promise.then(v => { done = true; value = v; });

        for (let round = 0; round < 50 && !done; round++) {
            await settle();
            const due = timers.filter(t => !t.done);
            due.forEach(t => { t.done = true; t.fn(); });
        }

        await settle();
        assert.equal(done, true, "finished within bounded attempts");
        return value;
    }

    return { controller, jitsi, cleanupCalls, changes, hanging, drive, state: () => controller.getState() };
}

test("Fix 2.1: 409 then success with stopJibri true -> retried once, then Jibri stopped", async () => {
    const h = harness({
        cleanup: [
            { status: 409, data: { success: false, code: "YOUTUBE_OPERATION_IN_PROGRESS" } },
            { status: 200, data: { success: true, aborted: true, stopJibri: true } }
        ]
    });

    const outcome = await quiet(() => h.drive(h.controller.start("recording")));

    assert.equal(outcome.reason, "jibri-timeout");
    assert.equal(h.cleanupCalls.length, 2);
    assert.equal(h.jitsi.stops, 1);
    assert.equal(h.state().recording, "off");
    assert.equal(outcome.cleanupPending, undefined);
});

test("Fix 2.2: 503 on every attempt -> no Jibri stop; restored with Stop available; cleanup pending", async () => {
    const h = harness({ cleanup: [{ status: 503, data: { success: false } }] });

    const outcome = await quiet(() => h.drive(h.controller.start("recording")));

    assert.equal(h.cleanupCalls.length, 3, "three attempts");
    assert.equal(h.jitsi.stops, 0, "no stop without the server's explicit permission");
    assert.equal(outcome.cleanupPending, true);
    assert.equal(h.state().recording, "restored", "the normal Stop stays available");
    assert.deepEqual(h.controller.pendingCleanups(), ["recording"]);
    assert.deepEqual(h.changes.find(c => c.type === "cleanup-pending"), { type: "cleanup-pending", feature: "recording" });

    // The normal, server-checked Stop finishes it.
    const stopped = await h.controller.stop("recording");

    assert.equal(stopped.ok, true);
    assert.equal(h.state().recording, "off");
    assert.deepEqual(h.controller.pendingCleanups(), []);
});

test("Fix 2.3: network errors and timeouts end in bounded time, never with an unconfirmed Jibri stop", async () => {
    for (const failure of ["network", "hang"]) {
        const h = harness({ cleanup: [failure] });

        const outcome = await quiet(() => h.drive(h.controller.start("recording")));

        assert.equal(h.cleanupCalls.length, 3, failure);
        assert.equal(h.jitsi.stops, 0, failure);
        assert.equal(outcome.cleanupPending, true, failure);
        assert.equal(h.state().recording, "restored", failure + ": not stuck on Starting");
    }
});

test("Fix 2.4: a successful answer with stopJibri false never stops Jibri (and a late stream is left alone)", async () => {
    const h = harness({ cleanup: [{ status: 200, data: { success: true, aborted: true, stopJibri: false } }] });

    await quiet(() => h.drive(h.controller.start("recording")));

    assert.equal(h.jitsi.stops, 0);
    assert.equal(h.state().recording, "off");

    // The server said the stream is used by another feature: a late "on" is not stopped.
    h.controller.onStreamStatus({ on: true });
    assert.equal(h.jitsi.stops, 0);
});

test("Fix 2.5: after a cleanup failure, a late Jibri confirmation is still stopped and never adopted", async () => {
    const h = harness({ cleanup: [{ status: 503, data: { success: false } }] });

    await quiet(() => h.drive(h.controller.start("recording")));
    assert.equal(h.jitsi.stops, 0);

    h.controller.onStreamStatus({ on: true });

    assert.equal(h.jitsi.stops, 1, "the late stream is stopped");
    assert.equal(h.state().recording, "restored", "not adopted as on; Stop still finishes the cleanup");

    // Its "off" event does not touch the pending feature either.
    h.controller.onStreamStatus({ on: false });
    assert.equal(h.state().recording, "restored");
});

test("Fix 2.6: shared Recording/Live - a failed Live start's cleanup never interrupts the recording", async () => {
    for (const cleanup of [
        [{ status: 200, data: { success: true, aborted: true, stopJibri: false } }],
        [{ status: 503, data: { success: false } }]
    ]) {
        const h = harness({
            cleanup,
            start: { status: 200, data: { ...START_OK.data, rowId: "live-row", ownsBroadcast: false, startJibri: false } }
        });

        // After a reload: the recording is restored, Jibri state unknown.
        h.controller.serverReport("recording", true);

        const outcome = await quiet(() => h.drive(h.controller.start("live", { privacy: "unlisted" })));

        assert.equal(outcome.ok, false);
        assert.equal(h.jitsi.starts, 0, "no second Jibri stream was started");
        assert.equal(h.jitsi.stops, 0, "the recording's stream is not stopped");
        assert.equal(h.state().recording, "restored", "the recording is untouched");
        assert.equal(h.cleanupCalls[0].ownsBroadcast, false, "the shared broadcast is not this start's to complete");
    }
});

test("Fix 2.7: permanent 401 / 403 / 400 / 404 are not retried", async () => {
    for (const status of [401, 403, 400, 404]) {
        const h = harness({ cleanup: [{ status, data: { success: false } }] });

        const outcome = await quiet(() => h.drive(h.controller.start("recording")));

        assert.equal(h.cleanupCalls.length, 1, String(status));
        assert.equal(h.jitsi.stops, 0, String(status));
        assert.equal(outcome.cleanupPending, true, String(status));
    }
});

test("Fix 2.8: a newer start is not affected by a stale cleanup answer; no overlap during cleanup", async () => {
    const h = harness({
        cleanup: ["hang", { status: 200, data: { success: true, aborted: true, stopJibri: true } }]
    });

    const first = h.controller.start("recording");

    // While the first start is still cleaning up, a second start is refused (busy).
    await settle();
    h.drive(Promise.resolve()); // let the confirmation time out
    await settle();

    const overlapping = await h.controller.start("recording");

    assert.deepEqual(overlapping, { ok: false, reason: "busy" });

    await quiet(() => h.drive(first));
    assert.equal(h.jitsi.stops, 1, "stopped once, on the confirmed answer");

    // A new start begins; the first, timed-out cleanup answer arrives now.
    const second = h.controller.start("recording");
    await settle();

    h.hanging.forEach(resolve => resolve({ status: 200, data: { success: true, stopJibri: true } }));
    await settle();

    assert.equal(h.jitsi.stops, 1, "the stale answer stops nothing");
    assert.equal(h.state().recording, "starting");

    h.controller.onStreamStatus({ on: true });
    assert.equal((await second).ok, true);
});

test("Fix 2: the class session ending stops this page's stream and ends the features", async () => {
    const h = harness();

    h.controller.serverReport("recording", true);
    h.controller.onStreamStatus({ on: true });
    assert.equal(h.state().recording, "on");

    h.controller.sessionEnded();

    assert.deepEqual(h.state(), { recording: "off", live: "off", jibri: "off" });
    assert.equal(h.jitsi.stops, 1);
    assert.equal(h.changes.at(-1).type, "session-ended");
});

// ===================================================================================
// Fix 3 - YouTube features end with the class session
// ===================================================================================

function activeSession(id = "s1", startedAgoMs = 60_000) {
    // These tests manage the sessions themselves: drop the default ones.
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

async function sharedRecordingAndLive() {
    await quiet(async () => {
        const page = teacherPage();
        await page.record();
        await page.goLive("unlisted");
    });

    assert.equal(db.recordings[0].broadcastId, db.lives[0].broadcastId);
    return db.recordings[0].broadcastId;
}

test("Fix 3.1: End Session with shared Recording + Live closes both rows, completes the broadcast once", async () => {
    reset();
    liveEvents = [];
    activeSession();

    const broadcastId = await sharedRecordingAndLive();
    const result = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));

    assert.deepEqual(result.youtubeCleanup, { status: "done", closed: 2 });
    assert.equal(completions(broadcastId).length, 1);
    assert.equal(active(db.recordings).length + active(db.lives).length, 0);
    assert.ok(liveEvents.includes("youtube:ended"), "students are told Live ended");
    assert.equal(db.sessions[0].isActive, false);
    assert.equal(db.attendanceCloses[0].classSessionId, "s1", "attendance cleanup unchanged");
    assert.equal(locks.size, 0);
});

test("Fix 3.2: a YouTube failure does not fail End Session; nothing is pretended; the next start reconciles", async () => {
    reset();
    activeSession();

    const broadcastId = await sharedRecordingAndLive();

    yt.getErrors.set(broadcastId, transient());

    const result = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));

    assert.equal(result.youtubeCleanup.status, "pending");
    assert.equal(result.youtubeCleanup.reason, "youtube");
    assert.deepEqual(result.youtubeCleanup.pendingBroadcastIds, [broadcastId]);
    assert.equal(db.sessions[0].isActive, false, "the session still ended");
    assert.equal(db.attendanceCloses.length, 1, "attendance still closed");
    assert.equal(active(db.recordings).length + active(db.lives).length, 2, "rows not marked ended while YouTube is unconfirmed");

    // Later: a new session; YouTube works again; the next start reconciles.
    yt.getErrors.clear();
    activeSession("s2", 0);

    const start = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    assert.equal(start.status, 200);
    assert.equal(completions(broadcastId).length, 1, "the old broadcast is completed once");
    assert.notEqual(start.data.broadcastId, broadcastId, "a fresh broadcast, not the stale one");
    assert.equal(start.data.startJibri, true, "not blocked by the stale Live row");
    assert.equal(active(db.lives).length, 0);
});

test("Fix 3.3: lock busy - End Session still succeeds; feature state untouched; reported as pending", async () => {
    reset();
    activeSession();

    await sharedRecordingAndLive();
    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "someone", expiresAt: new Date(Date.now() + 30_000) });

    const result = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));

    assert.equal(result.youtubeCleanup.status, "pending");
    assert.equal(result.youtubeCleanup.reason, "lock-busy");
    assert.equal(db.sessions[0].isActive, false);
    assert.equal(active(db.recordings).length + active(db.lives).length, 2);
    assert.equal(locks.get(LECTURE).ownerId, "someone", "the other holder's lock is untouched");
});

test("Fix 3.4: starting a new session ends the replaced session's features first", async () => {
    reset();
    activeSession();

    const broadcastId = await sharedRecordingAndLive();
    const restarted = await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE));

    assert.ok(restarted);
    assert.equal(db.sessions.find(s => s.id === "s1").isActive, false);
    assert.equal(active(db.recordings).length + active(db.lives).length, 0);
    assert.equal(completions(broadcastId).length, 1);
    assert.equal(db.sessions.filter(s => s.isActive).length, 1, "the new session");
});

test("Fix 3.5: after a busy-lock End Session, the next start is not blocked once reconciled", async () => {
    reset();
    activeSession();

    await sharedRecordingAndLive();
    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "someone", expiresAt: new Date(Date.now() + 30_000) });
    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));

    locks.clear();
    activeSession("s2", 0);

    const live = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));

    assert.equal(live.status, 200);
    assert.equal(live.data.startJibri, true, "the stale recording no longer blocks the Jibri start");
    assert.equal(active(db.recordings).length, 0);
});

test("Fix 3.6: a broadcast still used by a current feature is never completed by reconciliation", async () => {
    reset();

    // A stale recording row (earlier session) and a current Live row on the SAME broadcast.
    yt.broadcasts.set("bc-shared", { privacy: "unlisted", lifecycle: "live", stream: "stream-1" });

    const old = new Date(Date.now() - 120_000);

    db.recordings.push({
        id: "rec-stale", lectureId: LECTURE, broadcastId: "bc-shared", videoId: "v", youtubeUrl: "u",
        privacy: "UNLISTED", status: "LIVE", createdAt: old, endedAt: null, startedAt: old
    });
    activeSession("s2", 60_000);
    db.lives.push({
        id: "live-current", lectureId: LECTURE, broadcastId: "bc-shared", videoId: "v", youtubeUrl: "u",
        privacy: "UNLISTED", status: "LIVE", createdAt: new Date(), endedAt: null, startedAt: new Date()
    });

    const result = await quiet(() => lifecycle.reconcileStaleYouTubeFeatures(LECTURE));

    assert.equal(result.closed, 1);
    assert.deepEqual(completions("bc-shared"), [], "the current Live still needs it");
    assert.equal(db.recordings[0].status, "COMPLETE");
    assert.equal(db.lives[0].status, "LIVE");
});

test("Fix 3.7: another active session of the same lecture, or another teacher, leaves the features alone", async () => {
    reset();
    activeSession("s1");

    await sharedRecordingAndLive();

    // A second active session of the same lecture (e.g. created elsewhere).
    activeSession("s-other", 30_000);

    const result = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));

    assert.equal(result.youtubeCleanup.status, "skipped");
    assert.equal(active(db.recordings).length + active(db.lives).length, 2);

    const foreign = await quiet(() => lifecycle.endYouTubeFeaturesForLecture("teacher-2", LECTURE));

    assert.equal(foreign.status, "skipped");
    assert.equal(active(db.recordings).length + active(db.lives).length, 2);
});
