/*
 * Regression tests (Stage 8):
 *   D7 - the teacher's ONE reusable stream: a teacher-scoped lock around
 *        stream creation and starts; another lecture using the stream blocks
 *        a start (409); concurrent first starts create one stream;
 *   D8 - two tabs: a failed start's cleanup leaves a row another tab reused
 *        (row version: the integer `version` since the version counter);
 *        status syncs are not "reuse";
 *   D9 - pending session cleanup: lock retries within the budget,
 *        reconciliation when a session starts, teacher-facing message;
 *   D10 / debug - reconnecting another channel clears the saved stream;
 *        debug routes are off in production and never return a stream key.
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
    TEACHER, LECTURE, LECTURE_2, CLASS, STREAM, db, yt, locks, lockAttempts, routes, lectureLib,
    getLiveSnapshot, reset, post, quiet, created, completions, active
} = fakes;
const { youtubeTimeouts } = fakes.youtubeRequest;

const root = path.resolve(__dirname, "..", "..");
const { createYouTubeStreamController } = require(path.join(root, "components/Jitsi/youtube-stream-controller.ts"));
const sessionService = require(path.join(root, "services/session-service.ts"));
const { saveYouTubeConnection } = require(path.join(root, "lib/youtube-connection.ts"));
const { getYoutubeSessionCleanupMessage } = require(path.join(root, "lib/youtube-error-messages.ts"));

const TEACHER_LOCK = "teacher:" + TEACHER;

async function waitFor(condition, label) {
    for (let i = 0; i < 400 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(condition(), label);
}

// The lecture's class sessions, managed by the test (the default ones are dropped).
function activeSession(id, startedAgoMs, lectureId = LECTURE) {
    db.sessions = db.sessions.filter(s => !s.fixture);

    const row = {
        id, classId: CLASS, lectureId, isActive: true,
        startedAt: startedAgoMs ? new Date(Date.now() - startedAgoMs) : fakes.now(),
        endedAt: null, teacherId: TEACHER
    };

    db.sessions.push(row);
    return row;
}

const streamCreations = () => yt.calls.filter(call => call === "createStream").length;

// ===================================================================================
// D7 - one reusable stream per teacher
// ===================================================================================

test("D7: concurrent first-time starts / stream creations create exactly one reusable stream", async () => {
    reset();
    db.connection.liveStreamId = null;

    const results = await quiet(() => Promise.allSettled([
        post(routes.recordingStart, { lectureId: LECTURE }),
        lectureLib.ensureTeacherReusableStream(TEACHER, "enc"),
        lectureLib.ensureTeacherReusableStream(TEACHER, "enc"),
        post(routes.liveStart, { lectureId: LECTURE_2, privacy: "public" })
    ]));

    assert.equal(streamCreations(), 1, "one reusable stream");
    assert.equal(db.connection.liveStreamId, STREAM);
    assert.equal(locks.size, 0, "every lock released");

    // The ones that ran got that same stream; the others were refused (409), not duplicated.
    for (const result of results) {
        const value = result.status === "fulfilled" ? result.value : result.reason;
        if (typeof value === "string") assert.equal(value, STREAM);
        else if (value && value.status !== undefined) assert.ok([200, 409].includes(value.status), JSON.stringify(value.data));
        else assert.equal(value.code, "YOUTUBE_OPERATION_IN_PROGRESS");
    }

    // Afterwards: the saved stream is used, never a second one.
    assert.equal(await lectureLib.ensureTeacherReusableStream(TEACHER, "enc"), STREAM);
    assert.equal(streamCreations(), 1);
});

test("D7: a Recording in lecture A blocks a Live in lecture B (409, nothing created); B can start once A stops", async () => {
    reset();

    const recording = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    assert.equal(recording.status, 200);

    const blocked = await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "public" }));

    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, "YOUTUBE_STREAM_IN_USE");
    assert.equal(created().length, 1, "no broadcast for lecture B");
    assert.equal(db.lives.length, 0);
    assert.equal(locks.size, 0);

    await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));

    const allowed = await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "public" }));

    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.startJibri, true);
});

test("D7: another lecture's rows without an active session (left to its own cleanup) do not block", async () => {
    reset();

    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    // Lecture A's session ended; its row is still active (cleanup pending).
    db.sessions.find(s => s.lectureId === LECTURE).isActive = false;

    const live = await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "public" }));

    assert.equal(live.status, 200);
    assert.equal(active(db.recordings).length, 1, "lecture A's row is untouched here");
});

// Lecture A's active rows in its (still active) session, as YouTube no longer
// knows them: the cross-class check asks YouTube before blocking.
const snapshotRow = row => ({ status: row.status, version: row.version, endedAt: row.endedAt });

test("D7: a stale LIVE row in lecture A whose broadcast YouTube completed does not block lecture B; it is closed", async () => {
    reset();

    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    const stale = db.recordings[0];
    // Jibri stopped without a Stop: YouTube auto-stopped the broadcast, the row still says LIVE.
    stale.status = "LIVE";
    yt.broadcasts.get(stale.broadcastId).lifecycle = "complete";

    const recording = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE_2 }));

    assert.equal(recording.status, 200, JSON.stringify(recording.data));
    assert.equal(recording.data.startJibri, true);
    assert.equal(stale.status, "COMPLETE");
    assert.ok(stale.endedAt, "closed with an end time");
    assert.equal(db.recordings.filter(r => r.lectureId === LECTURE_2).length, 1);
    assert.equal(locks.size, 0);
});

test("D7: lecture A's row whose broadcast is revoked or no longer on YouTube does not block lecture B", async () => {
    for (const ending of ["revoked", "not-found"]) {
        reset();

        await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));
        const stale = db.lives[0];

        if (ending === "revoked") yt.broadcasts.get(stale.broadcastId).lifecycle = "revoked";
        else yt.broadcasts.delete(stale.broadcastId);

        const live = await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "public" }));

        assert.equal(live.status, 200, ending + ": " + JSON.stringify(live.data));
        assert.equal(stale.status, "REVOKED", ending);
    }
});

test("D7: lecture A's broadcast genuinely ready / live (or changing state) on YouTube still blocks lecture B; nothing changes", async () => {
    for (const lifecycle of ["ready", "live", "liveStarting"]) {
        for (const feature of ["recording", "live"]) {
            reset();

            await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
            const row = db.recordings[0];
            yt.broadcasts.get(row.broadcastId).lifecycle = lifecycle;
            const before = snapshotRow(row);

            const blocked = await quiet(() => feature === "recording"
                ? post(routes.recordingStart, { lectureId: LECTURE_2 })
                : post(routes.liveStart, { lectureId: LECTURE_2, privacy: "public" }));

            const label = lifecycle + " / " + feature;
            assert.equal(blocked.status, 409, label);
            assert.equal(blocked.data.code, "YOUTUBE_STREAM_IN_USE", label);
            assert.deepEqual(snapshotRow(row), before, label + ": lecture A's row untouched");
            assert.equal(created().length, 1, label + ": no broadcast for lecture B");
            assert.equal(locks.size, 0, label);
        }
    }
});

test("D7: a failed YouTube lookup of lecture A's broadcast refuses lecture B's start and leaves A's row as it was", async () => {
    reset();

    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    const row = db.recordings[0];
    row.status = "LIVE";
    yt.getErrors.set(row.broadcastId, new Error("YouTube is unreachable"));
    const before = snapshotRow(row);

    const refused = await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "public" }));

    assert.equal(refused.status, 503, JSON.stringify(refused.data));
    assert.equal(refused.data.code, "YOUTUBE_BROADCAST_CHECK_FAILED");
    assert.deepEqual(snapshotRow(row), before, "never closed on an unknown answer");
    assert.equal(created().length, 1, "no broadcast for lecture B");
    assert.equal(db.lives.length, 0);
    assert.equal(locks.size, 0);
});

test("D7: lecture A with an active session but no active Recording / Live never blocks lecture B (no YouTube lookup)", async () => {
    reset();

    // Both lectures have an active class session (fixtures); neither has a row.
    const recording = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE_2 }));
    assert.equal(recording.status, 200, JSON.stringify(recording.data));

    const live = await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "public" }));
    assert.equal(live.status, 200, JSON.stringify(live.data));
    assert.equal(live.data.startJibri, false, "the recording's Jibri stream is reused");

    // A's closed rows (an earlier, stopped recording) do not block either.
    reset();
    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));
    yt.calls = [];

    const afterStop = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE_2 }));
    assert.equal(afterStop.status, 200, JSON.stringify(afterStop.data));
    assert.ok(!yt.calls.some(call => call.startsWith("get:")), "nothing of lecture A was looked up");
});

test("same class: Recording then PUBLIC Live: two broadcasts on the same reusable stream, one Jibri stream", async () => {
    reset();

    const page = fakes.teacherPage();
    let live;

    await quiet(async () => {
        await page.record();
        live = await page.goLive("public");
    });

    assert.equal(live.status, 200, JSON.stringify(live.data));
    assert.equal(live.data.startJibri, false, "Live rides on the recording's Jibri stream");
    assert.equal(fakes.jibri.starts, 1, "no second Jibri start");
    assert.deepEqual(created(), ["create:unlisted", "create:public"]);

    const recordingBroadcast = db.recordings[0].broadcastId;
    const liveBroadcast = db.lives[0].broadcastId;

    assert.notEqual(recordingBroadcast, liveBroadcast, "separate broadcasts");
    assert.equal(yt.broadcasts.get(recordingBroadcast).stream, STREAM);
    assert.equal(yt.broadcasts.get(liveBroadcast).stream, STREAM, "both bound to the teacher's one stream");
    assert.equal(yt.broadcasts.get(liveBroadcast).privacy, "public");
    assert.equal(yt.broadcasts.get(recordingBroadcast).privacy, "unlisted");
});

test("D7: lock order - the teacher lock is taken before the lecture lock; a busy teacher lock refuses without touching the lecture", async () => {
    reset();

    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    assert.deepEqual(lockAttempts, [TEACHER_LOCK, LECTURE]);

    locks.set(TEACHER_LOCK, { lectureId: TEACHER_LOCK, ownerId: "someone", expiresAt: new Date(Date.now() + 30_000) });
    lockAttempts.length = 0;

    const refused = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));

    assert.equal(refused.status, 409);
    assert.deepEqual(lockAttempts, [TEACHER_LOCK], "the lecture lock was never taken");
    assert.equal(locks.get(TEACHER_LOCK).ownerId, "someone", "another request's lock is never released");
});

test("D7: a stream created while the teacher reconnected another channel is not saved for the new channel", async () => {
    reset();
    db.connection.liveStreamId = null;
    db.connection.channelId = "channel-old";

    yt.createStreamHook = async () => {
        await quiet(() => saveYouTubeConnection(TEACHER, {
            channelId: "channel-new", channelTitle: "New", refreshTokenEncrypted: "enc-new"
        }));
    };

    await assert.rejects(
        quiet(() => lectureLib.ensureTeacherReusableStream(TEACHER, "enc")),
        error => error.code === "YOUTUBE_CONNECTION_CHANGED"
    );
    assert.equal(db.connection.liveStreamId, null, "the old channel's stream is not saved");
    assert.equal(db.connection.channelId, "channel-new");
});

// ===================================================================================
// D8 - two tabs
// ===================================================================================

function tab({ confirmTimeoutMs = 40 } = {}) {
    const jitsi = { starts: 0, stops: 0 };
    const cleanups = [];

    const controller = createYouTubeStreamController({
        startFeature: (feature, options) => post(feature === "live" ? routes.liveStart : routes.recordingStart,
            { lectureId: LECTURE, ...(feature === "live" ? { privacy: options.privacy ?? "public" } : {}) }),
        abortStart: async (feature, body) => {
            cleanups.push(body);
            return post(routes.startAbort, { lectureId: LECTURE, feature, ...body });
        },
        stopFeature: async () => ({ status: 200, data: { success: true } }),
        startJibri: () => { jitsi.starts += 1; },
        stopJibri: () => { jitsi.stops += 1; },
        confirmTimeoutMs,
        cleanupTimeoutMs: 500,
        cleanupRetryDelaysMs: [0, 0]
    });

    return { controller, jitsi, cleanups };
}

for (const feature of ["live", "recording"]) {
    test(`D8: tab A starts ${feature}, tab B reuses it, tab A's start fails - A's cleanup closes nothing, completes nothing, stops no stream`, async () => {
        reset();

        const tabA = tab();
        const rows = () => (feature === "live" ? db.lives : db.recordings);

        const outcomeA = quiet(() => tabA.controller.start(feature, { privacy: "public" }));
        await waitFor(() => rows().length === 1, "tab A's row exists");

        // Tab B (another page of the same teacher) starts the same feature: it reuses A's row.
        const startB = await quiet(() => post(feature === "live" ? routes.liveStart : routes.recordingStart,
            { lectureId: LECTURE, ...(feature === "live" ? { privacy: "public" } : {}) }));

        assert.equal(startB.status, 200);
        assert.equal(startB.data.ownsRow, false, "B reused A's row");

        // Tab A's Jibri never confirms: its start fails and cleans up.
        const resultA = await outcomeA;

        assert.equal(resultA.ok, false);
        assert.equal(resultA.reason, "jibri-timeout");
        assert.equal(tabA.cleanups.length, 1);
        assert.equal(typeof tabA.cleanups[0].rowVersion, "number", "the cleanup carries the start's integer row version");

        assert.equal(active(rows()).length, 1, "the row B uses stays active");
        assert.deepEqual(completions(rows()[0].broadcastId), [], "the broadcast is not completed");
        assert.equal(tabA.jitsi.stops, 0, "tab A stops no stream");
        assert.equal(tabA.controller.getState()[feature], "off");
    });
}

test("D8: without a reuse the failed-start cleanup still closes the row - a status sync or privacy change in between is not a reuse", async () => {
    reset();

    const start = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "public" }));
    const { rowId, rowVersion, broadcastId } = start.data;

    // YouTube went live: a student's snapshot syncs the row to LIVE; the teacher changes privacy.
    yt.broadcasts.get(broadcastId).lifecycle = "live";
    assert.deepEqual(await quiet(() => getLiveSnapshot(LECTURE, "student")), { isLive: true, youtubeUrl: start.data.youtubeUrl });
    assert.equal(db.lives[0].status, "LIVE");

    await quiet(() => lectureLib.updateYouTubeLiveBroadcastPrivacyForTeacher(TEACHER, rowId, "unlisted", LECTURE));
    assert.equal(db.lives[0].privacy, "UNLISTED");
    assert.equal(db.lives[0].version, rowVersion, "status syncs and privacy changes keep the version");

    const abort = await quiet(() => post(routes.startAbort, { lectureId: LECTURE, feature: "live", rowId, rowVersion }));

    assert.equal(abort.data.aborted, true);
    assert.equal(abort.data.reused, undefined);
    assert.equal(db.lives[0].status, "REVOKED");
    assert.equal(completions(broadcastId).length, 1);
});

test("D8: a reused row's cleanup answers reused / stopJibri false; a cleanup without a version (older page) keeps the old behaviour", async () => {
    reset();

    const first = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    const stale = await quiet(() => post(routes.startAbort, {
        lectureId: LECTURE, feature: "recording", rowId: first.data.rowId, rowVersion: first.data.rowVersion
    }));

    assert.deepEqual(
        { aborted: stale.data.aborted, reused: stale.data.reused, stopJibri: stale.data.stopJibri },
        { aborted: false, reused: true, stopJibri: false }
    );
    assert.equal(active(db.recordings).length, 1);

    const legacy = await quiet(() => post(routes.startAbort, { lectureId: LECTURE, feature: "recording", rowId: first.data.rowId }));

    assert.equal(legacy.data.aborted, true);
});

// ===================================================================================
// D9 - pending session cleanup
// ===================================================================================

async function sharedRecordingAndLive() {
    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
    await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" }));
    return db.recordings[0].broadcastId;
}

test("D9: End Session retries a held lecture lock within its budget and then finishes the cleanup", async () => {
    reset();
    activeSession("s1", 60_000);

    const broadcastId = await sharedRecordingAndLive();

    Object.assign(youtubeTimeouts, { sessionCleanupLockRetriesMs: [30, 60], sessionCleanupMs: 2_000 });
    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "someone", expiresAt: new Date(Date.now() + 30_000) });
    setTimeout(() => locks.delete(LECTURE), 20);

    const result = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));

    assert.deepEqual(result.youtubeCleanup, { status: "done", closed: 2 });
    assert.equal(completions(broadcastId).length, 1);
});

test("D9: lock retries stay within the cleanup budget; a lock still held is reported pending, never done", async () => {
    reset();
    activeSession("s1", 60_000);

    await sharedRecordingAndLive();

    Object.assign(youtubeTimeouts, { sessionCleanupLockRetriesMs: [40, 40, 40, 40, 40, 40, 40, 40], sessionCleanupMs: 150 });
    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "someone", expiresAt: new Date(Date.now() + 30_000) });
    lockAttempts.length = 0;

    const started = Date.now();
    const result = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, "s1"));

    assert.ok(Date.now() - started < 1_000, "bounded");
    assert.ok(lockAttempts.filter(key => key === LECTURE).length <= 4, "retries stop at the budget");
    assert.equal(result.youtubeCleanup.status, "pending");
    assert.equal(result.youtubeCleanup.reason, "lock-busy");
    assert.equal(active(db.recordings).length + active(db.lives).length, 2);
    assert.equal(locks.get(LECTURE).ownerId, "someone");
});

test("D9: a new class session reconciles the lecture's pending cleanup (bounded); stale rows are never reused", async () => {
    reset();
    db.sessions = [];

    // Session 1: features left active (its End Session found the lock held throughout).
    const s1 = (await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE))).session.id;
    const broadcastId = await sharedRecordingAndLive();

    Object.assign(youtubeTimeouts, { sessionCleanupLockRetriesMs: [] });
    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "someone", expiresAt: new Date(Date.now() + 30_000) });
    const ended = await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, s1));
    locks.clear();
    assert.equal(ended.youtubeCleanup.status, "pending");

    // YouTube fails at the next session start: the session still starts; the cleanup stays pending.
    yt.getErrors.set(broadcastId, new Error("YouTube API request failed: 503 backendError"));
    const failing = await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE));

    assert.ok(failing.session.isActive);
    assert.equal(failing.youtubeCleanup.status, "pending");
    assert.equal(active(db.recordings).length + active(db.lives).length, 2, "not pretended");

    const blocked = await quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" }));
    assert.equal(blocked.status, 503, "the stale broadcast is not reused");

    // YouTube answers again: the next session start ends them.
    yt.getErrors.clear();
    const clean = await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE));

    assert.deepEqual(clean.youtubeCleanup, { status: "done", closed: 2 });
    assert.equal(completions(broadcastId).length, 1);
    assert.equal(active(db.recordings).length + active(db.lives).length, 0);
});

test("D9: the teacher is told about a pending cleanup only when the server reported it pending", () => {
    for (const status of ["done", "none", "skipped", undefined]) {
        assert.equal(getYoutubeSessionCleanupMessage(status ? { status } : null, "end"), null);
    }

    assert.match(getYoutubeSessionCleanupMessage({ status: "pending", reason: "youtube" }, "end"), /did not confirm/);
    assert.match(getYoutubeSessionCleanupMessage({ status: "pending", reason: "lock-busy" }, "start"), /earlier session/);
    assert.match(getYoutubeSessionCleanupMessage({ status: "pending", reason: "reauth-required" }, "end"), /Reconnect YouTube/);
});

// ===================================================================================
// D10 / debug routes
// ===================================================================================

test("D10: reconnecting a different channel clears the saved reusable stream; the same channel keeps it", async () => {
    reset();
    db.connection.channelId = "channel-1";
    db.connection.status = "REAUTH_REQUIRED";

    const same = await saveYouTubeConnection(TEACHER, { channelId: "channel-1", channelTitle: "Mine", refreshTokenEncrypted: "enc-2" });

    assert.equal(same.channelChanged, false);
    assert.equal(db.connection.liveStreamId, STREAM, "same channel: the stream is still its own");
    assert.equal(db.connection.status, "CONNECTED");

    const other = await saveYouTubeConnection(TEACHER, { channelId: "channel-2", channelTitle: "Other", refreshTokenEncrypted: "enc-3" });

    assert.equal(other.channelChanged, true);
    assert.equal(db.connection.liveStreamId, null, "the old channel's stream is not kept");
    assert.equal(db.connection.channelId, "channel-2");

    // The next start creates a stream on the new channel.
    const start = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    assert.equal(start.status, 200);
    assert.equal(streamCreations(), 1);
});

const debugRoutes = {
    createStream: require(path.join(root, "app/api/youtube/test-create-stream/route.ts")),
    getStream: require(path.join(root, "app/api/youtube/test-get-stream/route.ts")),
    token: require(path.join(root, "app/api/youtube/test-token/route.ts"))
};

async function withNodeEnv(value, fn) {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
    try {
        return await fn();
    } finally {
        if (saved === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = saved;
    }
}

test("debug routes: 404 in production before any login, YouTube or database work", async () => {
    reset();
    db.connection.liveStreamId = null;

    await withNodeEnv("production", async () => {
        for (const response of [
            await debugRoutes.createStream.POST(),
            await debugRoutes.getStream.GET(),
            await debugRoutes.token.GET()
        ]) {
            assert.equal(response.status, 404);
            assert.ok(!JSON.stringify(await response.json()).includes("key-1"));
        }
    });

    assert.deepEqual(yt.calls, []);
    assert.equal(db.connection.liveStreamId, null, "no stream created");
});

test("debug routes (development): the stream key is never returned; stream creation goes through the teacher lock", async () => {
    reset();
    db.connection.liveStreamId = null;

    await withNodeEnv("development", async () => {
        const created = await quiet(() => debugRoutes.createStream.POST());
        const createdBody = await created.json();

        assert.equal(created.status, 200);
        assert.equal(createdBody.liveStreamId, STREAM);
        assert.ok(!("streamName" in createdBody) && !("ingestionAddress" in createdBody));
        assert.ok(lockAttempts.includes(TEACHER_LOCK));

        const fetched = await quiet(() => debugRoutes.getStream.GET());
        const fetchedBody = await fetched.json();

        assert.equal(fetched.status, 200);
        assert.ok(!("streamName" in fetchedBody) && !("ingestionAddress" in fetchedBody));
        assert.ok(!JSON.stringify(fetchedBody).includes("key-1"), "no stream key anywhere in the answer");
    });
});
