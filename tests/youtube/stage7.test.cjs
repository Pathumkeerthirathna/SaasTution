/*
 * Regression tests (Stage 7):
 *   D1      - status checks write conditionally: a lookup answered after a Stop
 *             never reactivates the row; "testing" never makes an active row
 *             unmanageable;
 *   D2 / M2 - session-specific end events; End Session is idempotent;
 *   D3      - a start must carry the lecture's current class session;
 *   D4 / D6 - failed-start cleanup and completion are truthful: only YouTube's
 *             explicit refusal is tolerated; uncertainty leaves rows active;
 *   D5      - expired YouTube authorization survives reconciliation (401).
 *
 *   npm run test:youtube
 *
 * Fakes only (tests/youtube/youtube-fakes.cjs): Prisma, YouTube, the login
 * session, a fetch that never reaches the network. Nothing contacts YouTube,
 * Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");
const {
    TEACHER, LECTURE, CLASS, db, yt, locks, lockAttempts, routes, prisma, getLiveSnapshot,
    YouTubeReauthorizationRequiredError,
    reset, post, teacherPage, quiet, created, completions, active
} = fakes;
const { YouTubeApiError } = fakes.youtubeRequest;

const root = path.resolve(__dirname, "..", "..");
const { createYouTubeStreamController } = require(path.join(root, "components/Jitsi/youtube-stream-controller.ts"));
const sessionService = require(path.join(root, "services/session-service.ts"));
const sessionEvents = require(path.join(root, "lib/session-events.ts"));
const { getActiveYouTubeLives } = require(path.join(root, "lib/youtube-live-status.ts"));
const liveUpdates = require(path.join(root, "app/api/sessions/[id]/live-updates/route.ts"));

const events = [];
sessionEvents.subscribeLiveChanges(payload =>
    events.push(`${payload.kind}:${payload.event}${payload.sessionId ? ":" + payload.sessionId : ""}`));

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

// The lecture's class sessions, managed by the test (the default ones are dropped).
function activeSession(id, startedAgoMs) {
    db.sessions = db.sessions.filter(s => !s.fixture);

    const row = {
        id, classId: CLASS, lectureId: LECTURE, isActive: true,
        startedAt: startedAgoMs ? new Date(Date.now() - startedAgoMs) : fakes.now(),
        endedAt: null, teacherId: TEACHER
    };

    db.sessions.push(row);
    return row;
}

// Holds the next YouTube broadcast lookup until release() is called.
function holdNextLookup() {
    let release;
    const held = new Promise(resolve => { release = resolve; });

    yt.getGate = () => {
        yt.getGate = null;
        return held;
    };

    return () => release();
}

async function sharedRecordingAndLive() {
    await quiet(async () => {
        const page = teacherPage();
        await page.record();
        await page.goLive("unlisted");
    });

    return db.recordings[0].broadcastId;
}

const refusal = (status, reason) => new YouTubeApiError(
    "Failed to transition YouTube broadcast.", status,
    JSON.stringify({ error: { errors: [{ reason }] } }));

// ===================================================================================
// D1 - conditional status writes
// ===================================================================================

test("D1: a student's Live snapshot answered after Stop Live never reactivates the Live row; the last stop still completes the shared broadcast once", async () => {
    reset();

    const broadcastId = await sharedRecordingAndLive();
    yt.broadcasts.get(broadcastId).lifecycle = "live";
    assert.equal(db.lives[0].status, "READY");

    const release = holdNextLookup();
    const snapshot = quiet(() => getLiveSnapshot(LECTURE, "student"));
    await settle();

    // Stop Live while the snapshot waits on YouTube (shared: only the Live row closes).
    const stopLive = await quiet(() => post(routes.liveStop, { lectureId: LECTURE }));
    assert.equal(stopLive.status, 200);
    assert.equal(db.lives[0].status, "COMPLETE");

    release();
    assert.deepEqual(await snapshot, { isLive: false, youtubeUrl: null });
    assert.equal(db.lives[0].status, "COMPLETE", "the stale answer did not reactivate it");

    const stopRecording = await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));

    assert.equal(stopRecording.data.broadcastCompleted, true);
    assert.equal(stopRecording.data.stopJibri, true);
    assert.equal(completions(broadcastId).length, 1);
});

test("D1: a dashboard lookup answered after Stop Live never reactivates the row or shows it", async () => {
    reset();

    const broadcastId = await sharedRecordingAndLive();
    yt.broadcasts.get(broadcastId).lifecycle = "live";

    const release = holdNextLookup();
    const dashboard = quiet(() => getActiveYouTubeLives({ studentId: "student-1" }));
    await settle();

    await quiet(() => post(routes.liveStop, { lectureId: LECTURE }));
    release();

    assert.deepEqual(await dashboard, [], "not shown once stopped");
    assert.equal(db.lives[0].status, "COMPLETE");

    // Without a concurrent stop it is still promoted and shown.
    reset();
    const second = await sharedRecordingAndLive();
    yt.broadcasts.get(second).lifecycle = "live";

    const shown = await quiet(() => getActiveYouTubeLives({ studentId: "student-1" }));

    assert.equal(shown.length, 1);
    assert.equal(db.lives[0].status, "LIVE");
});

test("D1: a recording status check answered after Stop Recording never reactivates the row", async () => {
    reset();

    const { data } = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    yt.broadcasts.get(data.broadcastId).lifecycle = "live";

    const release = holdNextLookup();
    const status = quiet(() => fakes.lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE));
    await settle();

    const stop = await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));
    assert.equal(stop.status, 200);

    release();
    const result = await status;

    assert.equal(db.recordings[0].status, "COMPLETE", "not set back to LIVE");
    assert.equal(result.isRecording, false);
});

test("D1: a 'testing' answer never turns an active Live row into TESTING; Stop still manages it", async () => {
    reset();

    const { data } = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));
    yt.broadcasts.get(data.broadcastId).lifecycle = "testing";

    await quiet(() => getActiveYouTubeLives({ teacherId: TEACHER }));

    assert.equal(db.lives[0].status, "READY", "still an active feature row");

    yt.broadcasts.get(data.broadcastId).lifecycle = "live";
    const stop = await quiet(() => post(routes.liveStop, { lectureId: LECTURE }));

    assert.equal(stop.data.broadcastCompleted, true);
    assert.equal(active(db.lives).length, 0);
});

// ===================================================================================
// D2 / M2 - session-specific end events, idempotent End Session
// ===================================================================================

test("D2: a replaced session gets its own end event; ending it later (stale tab) changes nothing; ending twice is harmless", async () => {
    reset();
    db.sessions = [];
    events.length = 0;

    const s1 = (await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE))).session.id;
    const s2 = (await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE))).session.id;

    assert.deepEqual(events, [`jitsi:started:${s1}`, `jitsi:ended:${s1}`, `jitsi:started:${s2}`]);

    const broadcastId = await sharedRecordingAndLive();
    const s1EndedAt = db.sessions.find(s => s.id === s1).endedAt;
    events.length = 0;

    // End Session for the replaced S1 (e.g. from a stale tab).
    const stale = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, s1));

    assert.equal(stale.alreadyEnded, true);
    assert.equal(stale.youtubeCleanup.status, "skipped");
    assert.deepEqual(events, [], "no second end event: S2's pages are not ended");
    assert.equal(db.sessions.find(s => s.id === s1).endedAt, s1EndedAt, "its end time is kept");
    assert.equal(db.sessions.find(s => s.id === s2).isActive, true);
    assert.equal(active(db.recordings).length + active(db.lives).length, 2, "S2's features untouched");
    assert.deepEqual(completions(broadcastId), []);

    // S2 ended twice: one end event, one cleanup.
    const first = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, s2));
    const again = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, s2));

    assert.equal(first.alreadyEnded, false);
    assert.equal(first.youtubeCleanup.status, "done");
    assert.equal(again.alreadyEnded, true);
    assert.deepEqual(events.filter(e => e.startsWith("jitsi:ended")), [`jitsi:ended:${s2}`]);
    assert.equal(completions(broadcastId).length, 1);
});

test("D2: a classroom's live-updates stream sends session-ended only for its own session", async () => {
    reset();
    db.sessions = [];

    activeSession("s1", 60_000).isActive = false;
    const s2 = activeSession("s2", 0);

    const abort = new AbortController();
    const response = await liveUpdates.GET(
        new Request("http://localhost/api/sessions/s2/live-updates?role=teacher", { signal: abort.signal }),
        { params: { id: s2.id } }
    );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    const readUntil = async predicate => {
        while (!predicate(text)) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value);
        }
    };

    await readUntil(t => t.includes("event: live-status"));

    sessionEvents.emitLiveChange({ classId: CLASS, kind: "jitsi", event: "ended", sessionId: "s1" });
    sessionEvents.emitLiveChange({ classId: CLASS, kind: "jitsi", event: "ended" });
    sessionEvents.emitLiveChange({ classId: CLASS, kind: "jitsi", event: "ended", sessionId: "s2" });
    // A marker after them (sends a second live-status): every chunk above is read.
    sessionEvents.emitLiveChange({ classId: CLASS, kind: "youtube", event: "ended" });

    await readUntil(t => t.split("event: live-status").length - 1 >= 2);
    abort.abort();

    const ended = text.split("\n\n").filter(chunk => chunk.startsWith("event: session-ended"));

    assert.equal(ended.length, 1, "only S2's own end");
    assert.match(ended[0], /"sessionId":"s2"/);
});

// ===================================================================================
// D3 - the exact current session
// ===================================================================================

for (const [label, route, body, feature] of [
    ["Recording", "recordingStart", {}, "recording"],
    ["Live", "liveStart", { privacy: "public" }, "live"]
]) {
    test(`D3: a ${label} start carrying a replaced session's ID is refused (409) - no lock, YouTube call, row, connection change or Jibri`, async () => {
        reset();
        db.sessions = [];
        activeSession("s1", 60_000).isActive = false;
        db.sessions.push({
            id: "s2", classId: CLASS, lectureId: LECTURE, isActive: true,
            startedAt: fakes.now(), endedAt: null, teacherId: TEACHER
        });
        db.connection.liveStreamId = null;

        const jitsi = { starts: 0 };
        const controller = createYouTubeStreamController({
            startFeature: () => post(routes[route], { lectureId: LECTURE, ...body, sessionId: "s1" }),
            abortStart: async () => ({ status: 200, data: { success: true } }),
            stopFeature: async () => ({ status: 200, data: { success: true } }),
            startJibri: () => { jitsi.starts += 1; },
            stopJibri: () => {}
        });

        const outcome = await quiet(() => controller.start(feature, body));

        assert.equal(outcome.status, 409);
        assert.equal(outcome.data.code, "CLASS_SESSION_NOT_ACTIVE");
        assert.deepEqual(lockAttempts, []);
        assert.deepEqual(yt.calls, []);
        assert.equal(db.recordings.length + db.lives.length, 0);
        assert.equal(db.connection.liveStreamId, null);
        assert.equal(jitsi.starts, 0);

        // Without a sessionId at all: a validation error.
        const missing = await quiet(() => post(routes[route], { lectureId: LECTURE, ...body, sessionId: undefined }));
        assert.equal(missing.status, 400);
    });
}

test("D3: a session replaced between the check and the lock is refused under the lock (no YouTube call)", async () => {
    reset();
    activeSession("s1", 60_000);

    const create = prisma.youTubeOperationLock.create;

    prisma.youTubeOperationLock.create = async args => {
        db.sessions.forEach(s => { s.isActive = false; });
        db.sessions.push({
            id: "s2", classId: CLASS, lectureId: LECTURE, isActive: true,
            startedAt: fakes.now(), endedAt: null, teacherId: TEACHER
        });
        return create(args);
    };

    try {
        const result = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public", sessionId: "s1" }));

        assert.equal(result.status, 409);
        assert.equal(result.data.code, "CLASS_SESSION_NOT_ACTIVE");
        assert.deepEqual(yt.calls, []);
        assert.equal(db.lives.length, 0);
        assert.equal(locks.size, 0);
    } finally {
        prisma.youTubeOperationLock.create = create;
    }
});

// ===================================================================================
// D4 / D6 - truthful completion and failed-start cleanup
// ===================================================================================

test("D6: a network failure while completing a never-live broadcast is uncertain - refused (503), the row stays recoverable", async () => {
    reset();

    const { data } = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    assert.equal(yt.broadcasts.get(data.broadcastId).lifecycle, "ready");

    yt.transitionErrors.set(data.broadcastId, new TypeError("fetch failed"));

    const stop = await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));

    assert.equal(stop.status, 503);
    assert.equal(stop.data.code, "YOUTUBE_BROADCAST_STOP_FAILED");
    assert.equal(active(db.recordings).length, 1);

    // Recovered once YouTube answers.
    yt.transitionErrors.clear();
    const retried = await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));

    assert.equal(retried.status, 200);
    assert.equal(active(db.recordings).length, 0);
});

test("D6: only YouTube's explicit 403 invalidTransition is tolerated as 'never went live'; other refusals are not", async () => {
    for (const [error, expected] of [
        [refusal(403, "invalidTransition"), 200],
        [refusal(403, "forbidden"), 503],
        [refusal(500, "backendError"), 503],
        [new YouTubeApiError("Failed to transition YouTube broadcast.", 403, "not json"), 503]
    ]) {
        reset();

        const { data } = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
        yt.transitionErrors.set(data.broadcastId, error);

        const stop = await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));

        assert.equal(stop.status, expected, `${error.status} ${error.reason}`);
        assert.equal(active(db.recordings).length, expected === 200 ? 0 : 1);
    }
});

test("D4: failed-start cleanup with YouTube unreachable answers 503 and keeps the row; a later cleanup finishes it", async () => {
    reset();

    const { data } = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    const body = { lectureId: LECTURE, feature: "recording", rowId: data.rowId, ownsBroadcast: true };

    for (const error of [new TypeError("fetch failed"), new Error("YouTube API request failed: 503 backendError")]) {
        yt.getErrors.set(data.broadcastId, error);

        const abort = await quiet(() => post(routes.startAbort, body));

        assert.equal(abort.status, 503);
        assert.equal(active(db.recordings).length, 1, "not marked REVOKED while YouTube is uncertain");
    }

    yt.getErrors.clear();
    const finished = await quiet(() => post(routes.startAbort, body));

    assert.equal(finished.status, 200);
    assert.equal(finished.data.aborted, true);
    assert.equal(db.recordings[0].status, "REVOKED");
});

test("D4: a failed shared Live start whose recording stopped meanwhile completes the broadcast exactly once; never while the recording still needs it", async () => {
    reset();

    // Recording, then an Unlisted Live sharing its broadcast (ownsRow, not ownsBroadcast).
    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    const live = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" }));
    const broadcastId = live.data.broadcastId;

    assert.equal(live.data.ownsRow, true);
    assert.equal(live.data.ownsBroadcast, false);

    // While the recording is active: only the Live row is closed.
    const whileShared = await quiet(() => post(routes.startAbort, {
        lectureId: LECTURE, feature: "live", rowId: live.data.rowId, ownsBroadcast: false
    }));

    assert.equal(whileShared.data.aborted, true);
    assert.deepEqual(completions(broadcastId), [], "the recording still needs it");
    assert.equal(active(db.recordings).length, 1);

    // The Live again; the recording stops while the Live start is pending.
    const again = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" }));
    await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));
    assert.deepEqual(completions(broadcastId), [], "Stop Recording left it to the Live");

    const abort = await quiet(() => post(routes.startAbort, {
        lectureId: LECTURE, feature: "live", rowId: again.data.rowId, ownsBroadcast: false
    }));

    assert.equal(abort.data.aborted, true);
    assert.equal(abort.data.broadcastCompleted, true);
    assert.equal(completions(broadcastId).length, 1, "completed once, by the last user");
    assert.equal(active(db.recordings).length + active(db.lives).length, 0);
});

// ===================================================================================
// D5 - expired authorization
// ===================================================================================

async function staleFeaturesFromEndedSession() {
    activeSession("s1", 60_000);
    const broadcastId = await sharedRecordingAndLive();

    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "someone", expiresAt: new Date(Date.now() + 30_000) });
    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));
    locks.clear();

    activeSession("s2", 0);
    return broadcastId;
}

test("D5: expired authorization during reconciliation reaches the route as 401 and marks the connection; no blind retries", async () => {
    reset();

    const broadcastId = await staleFeaturesFromEndedSession();
    yt.getErrors.set(broadcastId, new YouTubeReauthorizationRequiredError());

    const start = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));

    assert.equal(start.status, 401);
    assert.equal(start.data.code, "YOUTUBE_REAUTH_REQUIRED");
    assert.equal(db.connection.status, "REAUTH_REQUIRED");
    assert.equal(created().length, 1, "nothing created");
    assert.equal(active(db.recordings).length + active(db.lives).length, 2, "stale rows untouched");

    // Until the teacher reconnects: refused at once, YouTube is not asked again.
    const callsBefore = yt.calls.length;
    const again = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    assert.equal(again.status, 401);
    assert.equal(yt.calls.length, callsBefore);

    // Reconnected (the OAuth callback sets CONNECTED): reconciled, then started.
    db.connection.status = "CONNECTED";
    yt.getErrors.clear();

    const ok = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    assert.equal(ok.status, 200);
    assert.equal(completions(broadcastId).length, 1);
});

test("D5: expired authorization in End Session cleanup is reported as reauth-required and marks the connection", async () => {
    reset();
    activeSession("s1", 60_000);

    const broadcastId = await sharedRecordingAndLive();
    yt.getErrors.set(broadcastId, new YouTubeReauthorizationRequiredError());

    const result = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));

    assert.equal(result.youtubeCleanup.status, "pending");
    assert.equal(result.youtubeCleanup.reason, "reauth-required");
    assert.equal(db.connection.status, "REAUTH_REQUIRED");
    assert.equal(db.sessions[0].isActive, false, "the session still ended");
    assert.equal(active(db.recordings).length + active(db.lives).length, 2);
});
