/*
 * Regression tests (pre-deployment fix D3): changing a Live broadcast's
 * privacy (PUT /api/lectures/[id]/lives/[liveId]/privacy) is serialized with
 * Recording / Live start and stop by the per-lecture YouTube operation lock,
 * so a Recording can never start sharing a broadcast that is being made
 * Public / Private.
 *
 *   npm run test:youtube
 *
 * Fakes only (tests/youtube/youtube-fakes.cjs): no YouTube, Jibri or database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    LECTURE, LECTURE_2, db, yt, locks, lockAttempts, session, routes,
    reset, post, teacherPage, quiet, privacyChanges
} = require("./youtube-fakes.cjs");

async function putPrivacy(liveId, privacy, lectureId = LECTURE) {
    const response = await routes.livePrivacy.PUT(
        new Request("http://localhost/api", { method: "PUT", body: JSON.stringify({ privacy }) }),
        { params: { id: lectureId, liveId } }
    );

    return { status: response.status, body: await response.json() };
}

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

// A gate that holds the fake YouTube privacy update mid-request.
function holdPrivacyUpdate() {
    let release;

    yt.privacyGate = new Promise(resolve => { release = resolve; });

    return () => { yt.privacyGate = null; release(); };
}

test("race: a privacy change in progress holds the lock; a Recording start meanwhile is refused (no public shared broadcast)", async () => {
    reset();

    await quiet(() => teacherPage().goLive("unlisted"));

    const live = db.lives[0];
    const release = holdPrivacyUpdate();

    let privacy;
    let recording;

    await quiet(async () => {
        const privacyPending = putPrivacy(live.id, "public");
        await settle(); // the privacy change now holds the lock, waiting on YouTube

        assert.equal(locks.size, 1);

        recording = await post(routes.recordingStart, { lectureId: LECTURE });

        release();
        privacy = await privacyPending;
    });

    assert.equal(recording.status, 409);
    assert.equal(recording.data.code, "YOUTUBE_OPERATION_IN_PROGRESS");
    assert.equal(privacy.status, 200);
    assert.equal(yt.broadcasts.get(live.broadcastId).privacy, "public");
    assert.equal(db.recordings.length, 0, "the recording never attached to the broadcast being made public");
    assert.equal(locks.size, 0, "released");

    // Recording afterwards: the Live is Public now, so it gets its own Unlisted broadcast.
    const after = await quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));

    assert.equal(after.status, 200);
    assert.notEqual(db.recordings[0].broadcastId, live.broadcastId);
    assert.equal(yt.broadcasts.get(db.recordings[0].broadcastId).privacy, "unlisted");
});

test("race: while another operation holds the lecture's lock, a privacy change is refused (409) and changes nothing", async () => {
    reset();

    await quiet(() => teacherPage().goLive("unlisted"));

    // e.g. a Recording start in progress on another server.
    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "recording-start", expiresAt: new Date(Date.now() + 30_000) });

    const result = await quiet(() => putPrivacy(db.lives[0].id, "public"));

    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "YOUTUBE_OPERATION_IN_PROGRESS");
    assert.deepEqual(privacyChanges(), [], "YouTube privacy untouched");
    assert.equal(db.lives[0].privacy, "UNLISTED");
    assert.equal(locks.get(LECTURE).ownerId, "recording-start", "the other operation's lock is never released by this request");
});

test("a shared broadcast is still refused under the lock (409 shared), and the lock is released", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        await page.record();
        await page.goLive("unlisted");
    });

    const result = await quiet(() => putPrivacy(db.lives[0].id, "private"));

    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "YOUTUBE_SHARED_BROADCAST_PRIVACY");
    assert.deepEqual(privacyChanges(), []);
    assert.equal(locks.size, 0);
});

test("the lock is released after a successful change and after a YouTube failure", async () => {
    reset();

    await quiet(() => teacherPage().goLive("unlisted"));

    const ok = await quiet(() => putPrivacy(db.lives[0].id, "public"));

    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.liveBroadcast.privacy, "PUBLIC");
    assert.equal(locks.size, 0);

    yt.privacyError = new Error("YouTube API request failed: 503 backendError");

    const failed = await quiet(() => putPrivacy(db.lives[0].id, "private"));

    assert.equal(failed.status, 500);
    assert.equal(db.lives[0].privacy, "PUBLIC", "the row keeps what YouTube has");
    assert.equal(locks.size, 0, "released after the failure too");
});

test("authorization: another teacher, a broadcast of another lecture, or an unknown broadcast is refused before any lock", async () => {
    reset();

    await quiet(() => teacherPage().goLive("unlisted"));

    const liveId = db.lives[0].id;

    session.teacherId = "teacher-2";

    const otherTeacher = await quiet(() => putPrivacy(liveId, "public"));

    assert.equal(otherTeacher.status, 403);
    assert.equal(otherTeacher.body.error.code, "FORBIDDEN");

    session.teacherId = "teacher-1";

    // The URL names a different lecture than the broadcast's.
    const wrongLecture = await quiet(() => putPrivacy(liveId, "public", LECTURE_2));

    assert.equal(wrongLecture.status, 404);
    assert.equal(wrongLecture.body.error.code, "LIVE_BROADCAST_NOT_FOUND");

    const unknown = await quiet(() => putPrivacy("no-such-live", "public"));

    assert.equal(unknown.status, 404);

    assert.deepEqual(lockAttempts.filter(id => id === LECTURE || id === LECTURE_2).length, 1,
        "only the initial Live start took a lock; refused requests never did");
    assert.deepEqual(privacyChanges(), []);
    assert.equal(locks.size, 0);
});
