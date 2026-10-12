/*
 * Regression tests: checkYouTubeRecordingStatus() (lib/youtube-lecture.ts)
 * and GET /api/youtube/lecture/recording/status.
 *
 *   npm run test:youtube
 *
 * The real TypeScript modules are loaded through tsx. Prisma, the YouTube API
 * helpers (lib/youtube-live.ts), the session and the live-change events are
 * replaced by in-memory fakes, so nothing here touches a database or YouTube.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const TEACHER_ID = "teacher-1";
const LECTURE_ID = "dfdbbfed-25bd-40ba-a753-5d9333125b11";

// ---- Fakes ----------------------------------------------------------------

const db = {
    connection: null,
    lecture: null,
    recordings: [],
    recordingUpdates: [],
    connectionUpdates: [],
    recordingQueries: []
};

const youtube = {
    calls: { getStream: 0, getBroadcast: 0, createStream: 0, other: 0 },
    stream: null,
    broadcast: null,
    streamError: null,
    broadcastError: null
};

let session = { teacherId: TEACHER_ID };

const fakePrisma = {
    youTubeConnection: {
        findUnique: async ({ where }) =>
            db.connection && db.connection.teacherId === where.teacherId ? { ...db.connection } : null,
        update: async args => {
            db.connectionUpdates.push(args);
            return { ...db.connection, ...args.data };
        }
    },
    lecture: {
        findFirst: async ({ where }) =>
            db.lecture && db.lecture.id === where.id && db.lecture.status === where.status
                ? { id: db.lecture.id, class: { teacherId: db.lecture.teacherId } }
                : null
    },
    youTubeRecording: {
        // Honours the lectureId / status-in filter and newest-first order.
        findFirst: async args => {
            const allowed = args.where.status?.in;

            // By id: is this row still active (the status check re-reads it).
            if (args.where.id) {
                return db.recordings.find(row =>
                    row.id === args.where.id && (!allowed || allowed.includes(row.status))) || null;
            }

            db.recordingQueries.push(args);

            return db.recordings
                .filter(row => row.lectureId === args.where.lectureId)
                .filter(row => !allowed || allowed.includes(row.status))
                .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
        },
        // Conditional write: only a row still matching `where` changes.
        updateMany: async args => {
            db.recordingUpdates.push(args);
            const { id, status } = args.where;
            const found = db.recordings.filter(row => row.id === id &&
                (status === undefined || (typeof status === "object" ? status.in.includes(row.status) : row.status === status)));
            found.forEach(row => Object.assign(row, args.data));
            return { count: found.length };
        },
        update: async args => {
            db.recordingUpdates.push(args);
            return args.data;
        }
    }
};

const fakeYoutubeLive = {
    getYouTubeLiveStream: async () => {
        youtube.calls.getStream += 1;
        if (youtube.streamError) throw youtube.streamError;
        return youtube.stream;
    },
    getYouTubeLiveBroadcast: async () => {
        youtube.calls.getBroadcast += 1;
        if (youtube.broadcastError) throw youtube.broadcastError;
        return youtube.broadcast;
    },
    createYouTubeLiveStream: async () => {
        youtube.calls.createStream += 1;
        return { id: "new-stream" };
    },
    createYouTubeLiveBroadcast: async () => { youtube.calls.other += 1; },
    bindYouTubeLiveBroadcast: async () => { youtube.calls.other += 1; },
    updateYouTubeLiveBroadcastPrivacy: async () => { youtube.calls.other += 1; },
    transitionYouTubeLiveBroadcast: async () => { youtube.calls.other += 1; }
};

// Installs a fake module at the file a project import resolves to.
function fake(relativePath, exports) {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);

    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
}

fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/youtube-live.ts", fakeYoutubeLive);
fake("lib/session-events.ts", { emitLiveChange: () => {} });
fake("lib/auth-session.ts", { requireTeacherSession: async () => session });

const { YouTubeBroadcastStatus } = require("@prisma/client");
const { checkYouTubeRecordingStatus } = require(path.join(root, "lib/youtube-lecture.ts"));
const { GET } = require(path.join(root, "app/api/youtube/lecture/recording/status/route.ts"));

// ---- Helpers --------------------------------------------------------------

function reset({ liveStreamId = "stream-1" } = {}) {
    db.connection = { teacherId: TEACHER_ID, refreshTokenEncrypted: "enc-token", liveStreamId };
    db.lecture = { id: LECTURE_ID, status: 0, teacherId: TEACHER_ID };
    db.recordings = [];
    db.recordingUpdates = [];
    db.connectionUpdates = [];
    db.recordingQueries = [];
    youtube.calls = { getStream: 0, getBroadcast: 0, createStream: 0, other: 0 };
    youtube.stream = { id: liveStreamId, status: { streamStatus: "active" } };
    youtube.broadcast = null;
    youtube.streamError = null;
    youtube.broadcastError = null;
    session = { teacherId: TEACHER_ID };
}

function addRecording(status, extra = {}) {
    const row = {
        id: "rec-" + (db.recordings.length + 1),
        lectureId: LECTURE_ID,
        broadcastId: "bc-" + (db.recordings.length + 1),
        videoId: "vid-" + (db.recordings.length + 1),
        youtubeUrl: "https://youtu.be/vid-" + (db.recordings.length + 1),
        status,
        createdAt: db.recordings.length + 1,
        ...extra
    };

    db.recordings.push(row);

    return row;
}

const totalYoutubeCalls = () =>
    Object.values(youtube.calls).reduce((sum, count) => sum + count, 0);

const NOT_RECORDING = {
    recordingId: null,
    streamStatus: undefined,
    broadcastStatus: undefined,
    isRecording: false,
    privacy: undefined,
    broadcastId: null,
    videoId: null,
    youtubeUrl: null
};

async function callRoute(lectureId = LECTURE_ID) {
    const url = "http://localhost/api/youtube/lecture/recording/status"
        + (lectureId ? "?lectureId=" + lectureId : "");
    const response = await GET(new Request(url));

    return { status: response.status, body: await response.json() };
}

// Keeps the route's expected console.error output out of the test report.
async function quietly(fn) {
    const original = console.error;

    console.error = () => {};

    try {
        return await fn();
    } finally {
        console.error = original;
    }
}

const quietLogs = () => {
    const original = console.log;

    console.log = () => {};

    return () => { console.log = original; };
};

// ---- No recording / completed recording -----------------------------------

test("no recording: a normal not-recording result, with no YouTube calls", async () => {
    reset();

    const result = await checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID);

    assert.deepEqual(result, { ...NOT_RECORDING, streamId: "stream-1" });
    assert.equal(totalYoutubeCalls(), 0, "YouTube is never contacted");
    assert.equal(db.recordingUpdates.length, 0);
    assert.equal(db.connectionUpdates.length, 0);

    // Only READY / LIVE rows count as an ongoing recording.
    assert.deepEqual(
        [...db.recordingQueries[0].where.status.in],
        [YouTubeBroadcastStatus.READY, YouTubeBroadcastStatus.LIVE]
    );
});

test("no recording and no reusable stream yet: none is created", async () => {
    reset({ liveStreamId: null });

    const result = await checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID);

    assert.equal(result.isRecording, false);
    assert.equal(result.streamId, null);
    assert.equal(youtube.calls.createStream, 0, "no reusable stream is created");
    assert.equal(totalYoutubeCalls(), 0);
    assert.equal(db.connectionUpdates.length, 0);
});

test("completed recording only: not recording, no YouTube calls, row untouched", async () => {
    reset();
    addRecording(YouTubeBroadcastStatus.COMPLETE);
    addRecording(YouTubeBroadcastStatus.REVOKED);

    const result = await checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID);

    assert.deepEqual(result, { ...NOT_RECORDING, streamId: "stream-1" });
    assert.equal(totalYoutubeCalls(), 0);
    assert.equal(db.recordingUpdates.length, 0);
});

test("route: no recording answers 200 { success: true, isRecording: false }", async () => {
    reset();

    const { status, body } = await callRoute();

    assert.equal(status, 200);
    assert.deepEqual(body, {
        success: true,
        recordingId: null,
        isRecording: false,
        broadcastId: null,
        videoId: null,
        youtubeUrl: null,
        streamId: "stream-1"
    });
    assert.equal(totalYoutubeCalls(), 0);
});

// ---- Active recording -----------------------------------------------------

test("active recording: YouTube says live -> isRecording true with its IDs", async () => {
    reset();

    const row = addRecording(YouTubeBroadcastStatus.LIVE);

    youtube.broadcast = { id: row.broadcastId, status: { lifeCycleStatus: "live", privacyStatus: "unlisted" } };

    const restore = quietLogs();
    let result;

    try {
        result = await checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID);
    } finally {
        restore();
    }

    assert.equal(result.isRecording, true);
    assert.equal(result.recordingId, row.id);
    assert.equal(result.broadcastId, row.broadcastId);
    assert.equal(result.videoId, row.videoId);
    assert.equal(result.youtubeUrl, row.youtubeUrl);
    assert.equal(result.broadcastStatus, "live");
    assert.equal(result.streamStatus, "active");
    assert.equal(result.privacy, "unlisted");
    assert.equal(youtube.calls.getStream, 1);
    assert.equal(youtube.calls.getBroadcast, 1);
    assert.equal(db.recordingUpdates.length, 0, "already LIVE: nothing to sync");
});

test("active recording: a READY row YouTube reports live is synced to LIVE", async () => {
    reset();

    const row = addRecording(YouTubeBroadcastStatus.READY);

    youtube.broadcast = { id: row.broadcastId, status: { lifeCycleStatus: "live" } };

    const restore = quietLogs();

    try {
        const result = await checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID);

        assert.equal(result.isRecording, true);
    } finally {
        restore();
    }

    assert.deepEqual(db.recordingUpdates.map(update => update.data.status), [YouTubeBroadcastStatus.LIVE]);
});

test("recording ended on YouTube: row marked COMPLETE, isRecording false", async () => {
    reset();

    const row = addRecording(YouTubeBroadcastStatus.LIVE);

    youtube.broadcast = { id: row.broadcastId, status: { lifeCycleStatus: "complete" } };

    const restore = quietLogs();
    let result;

    try {
        result = await checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID);
    } finally {
        restore();
    }

    assert.equal(result.isRecording, false);
    assert.equal(result.recordingId, row.id);
    assert.deepEqual(db.recordingUpdates.map(update => update.data.status), [YouTubeBroadcastStatus.COMPLETE]);
});

// ---- YouTube API failures (unchanged handling) ----------------------------

test("YouTube API failure on the stream lookup: still an error (route answers 500)", async () => {
    reset();
    addRecording(YouTubeBroadcastStatus.LIVE);
    youtube.streamError = new Error("YouTube API quota exceeded");

    await assert.rejects(
        checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID),
        /YouTube API quota exceeded/
    );

    const { status, body } = await quietly(() => callRoute());

    assert.equal(status, 500);
    assert.deepEqual(body, { success: false, error: "YouTube API quota exceeded" });
    assert.equal(db.recordingUpdates.length, 0);
});

test("YouTube API failure on the broadcast lookup: inconclusive, row left as it is", async () => {
    reset();

    const row = addRecording(YouTubeBroadcastStatus.LIVE);

    youtube.broadcastError = new Error("YouTube API request failed: 503");

    const result = await quietly(() => checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID));

    assert.equal(result.isRecording, false);
    assert.equal(result.recordingId, row.id);
    assert.equal(result.broadcastId, row.broadcastId);
    assert.equal(db.recordingUpdates.length, 0, "a genuinely live recording is never marked COMPLETE");
});

test("broadcast not found on YouTube: row self-heals to COMPLETE", async () => {
    reset();
    addRecording(YouTubeBroadcastStatus.LIVE);
    youtube.broadcastError = new Error("YouTube broadcast not found");

    const result = await quietly(() => checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID));

    assert.equal(result.isRecording, false);
    assert.deepEqual(db.recordingUpdates.map(update => update.data.status), [YouTubeBroadcastStatus.COMPLETE]);
});

// ---- Connection, lecture and authorization errors (unchanged) -------------

test("missing YouTube connection, missing lecture and another teacher still throw", async () => {
    reset();
    db.connection = null;
    await assert.rejects(checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID), /has not connected a YouTube channel/);

    reset();
    db.lecture = null;
    await assert.rejects(checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID), /Lecture not found/);

    reset();
    db.lecture.teacherId = "someone-else";
    await assert.rejects(checkYouTubeRecordingStatus(TEACHER_ID, LECTURE_ID), /not authorized/);

    assert.equal(totalYoutubeCalls(), 0);
});

test("route: missing lectureId is still a 400", async () => {
    reset();

    const { status, body } = await callRoute(null);

    assert.equal(status, 400);
    assert.deepEqual(body, { success: false, error: "lectureId is required." });
});
