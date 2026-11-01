/*
 * YouTube status coordination and the authoritative clock:
 *
 * - lib/youtube-status-cache.ts: status POLLING (the classroom live-status
 *   stream, dashboards, the teacher page's recording check) shares one
 *   YouTube request per broadcast, reuses a non-terminal answer for at most
 *   statusCacheMs, never reuses an ended status or a failure; lifecycle
 *   operations (stops, starts, the departure stop) always ask YouTube
 *   themselves.
 * - lib/server-clock.ts: the database clock for every lifecycle time; the
 *   local clock's skew never matters.
 *
 *   npm run test:youtube
 *
 * Real modules against youtube-fakes.cjs (Prisma, YouTube). Nothing contacts
 * YouTube or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");

const { LECTURE, TEACHER, db, yt, prisma, reset, teacherPage, quiet, getLiveSnapshot, lectureLib, youtubeRequest } = fakes;

const root = path.resolve(__dirname, "..", "..");
const statusCache = require(path.join(root, "lib/youtube-status-cache.ts"));
const clock = require(path.join(root, "lib/server-clock.ts"));
const presence = require(path.join(root, "lib/teacher-presence.ts"));
const lifecycle = require(path.join(root, "lib/youtube-feature-lifecycle.ts"));
const { getActiveYouTubeLives } = require(path.join(root, "lib/youtube-live-status.ts"));

const lookups = id => yt.calls.filter(c => c === "get:" + id).length;
const liveRow = () => db.lives[db.lives.length - 1];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function liveClass() {
    reset();
    youtubeRequest.youtubeTimeouts.statusCacheMs = 2_000;
    await quiet(() => teacherPage().goLive("unlisted"));
    yt.broadcasts.get(liveRow().broadcastId).lifecycle = "live";
    yt.calls = [];
    return liveRow().broadcastId;
}

// ---- Status polling --------------------------------------------------------------------

test("fan-out: 40 students' live-status snapshots for one event share ONE YouTube request", async () => {
    const id = await liveClass();

    const snapshots = await quiet(() => Promise.all(Array.from({ length: 40 }, () => getLiveSnapshot(LECTURE, "student"))));

    assert.ok(snapshots.every(s => s.isLive === true));
    assert.equal(lookups(id), 1);

    // Dashboards and the teacher page's recording check join the same coordination.
    await quiet(() => getActiveYouTubeLives({ teacherId: TEACHER }));
    assert.equal(lookups(id), 1, "reused within statusCacheMs");
});

test("freshness: a non-terminal answer is reused for statusCacheMs at most, then YouTube is asked again", async () => {
    const id = await liveClass();

    youtubeRequest.youtubeTimeouts.statusCacheMs = 60;
    await quiet(() => getLiveSnapshot(LECTURE, "student"));
    await quiet(() => getLiveSnapshot(LECTURE, "student"));
    assert.equal(lookups(id), 1);

    await sleep(80);
    await quiet(() => getLiveSnapshot(LECTURE, "student"));
    assert.equal(lookups(id), 2);
});

test("a cached answer never confirms a stop: ended statuses and failures are never reused", async () => {
    const id = await liveClass();

    // Ended on YouTube: every poll that would act on it asked YouTube itself.
    yt.broadcasts.get(id).lifecycle = "complete";
    await statusCache.getPolledYouTubeBroadcast("enc", id);
    await statusCache.getPolledYouTubeBroadcast("enc", id);
    assert.equal(lookups(id), 2, "a terminal answer is not kept");

    // Failures are not kept either.
    yt.calls = [];
    yt.getErrors.set(id, new Error("YouTube is down"));
    await assert.rejects(statusCache.getPolledYouTubeBroadcast("enc", id));
    yt.getErrors.delete(id);
    yt.broadcasts.get(id).lifecycle = "live";
    assert.equal((await statusCache.getPolledYouTubeBroadcast("enc", id)).status.lifeCycleStatus, "live");
    assert.equal(lookups(id), 2);
});

test("a cached 'live' never hides a stop from lifecycle operations: they always ask YouTube", async () => {
    const id = await liveClass();

    await quiet(() => getLiveSnapshot(LECTURE, "teacher")); // caches "live"
    yt.broadcasts.get(id).lifecycle = "complete";
    yt.calls = [];

    // The teacher's Stop: its own lookup sees "complete" (no transition needed).
    const page = teacherPage({ isRecording: false, isLive: true });
    const stopped = await quiet(() => page.stopLive());

    assert.equal(stopped.status, "COMPLETE");
    assert.equal(lookups(id), 1, "the Stop asked YouTube despite the cached 'live'");
    assert.equal(yt.calls.filter(c => c.startsWith("transition:")).length, 0);
});

test("a start forgets the polled answer: the students it wakes up see the new state", async () => {
    reset();
    youtubeRequest.youtubeTimeouts.statusCacheMs = 60_000;
    await quiet(() => teacherPage().record());

    // A poll caches the recording's broadcast as "ready".
    const shared = db.recordings[0].broadcastId;

    await statusCache.getPolledYouTubeBroadcast("enc", shared);
    yt.broadcasts.get(shared).lifecycle = "live";

    // Live starts on that (shared) broadcast: the start forgets the old answer.
    await quiet(() => teacherPage({ isRecording: true, isLive: false }).goLive("unlisted"));
    assert.equal((await statusCache.getPolledYouTubeBroadcast("enc", shared)).status.lifeCycleStatus, "live");
});

// ---- The database clock ------------------------------------------------------------------

function withDatabaseClock(offsetMs, fn) {
    const saved = prisma.$queryRaw;
    let queries = 0;

    prisma.$queryRaw = async () => {
        queries += 1;
        return [{ now: new Date(Date.now() + offsetMs) }];
    };
    clock.resetServerClock();

    return Promise.resolve()
        .then(() => fn(() => queries))
        .finally(() => {
            prisma.$queryRaw = saved;
            clock.resetServerClock();
        });
}

test("server clock: the database's time, measured once per minute, whatever this server's clock says", async () => {
    await withDatabaseClock(5 * 60_000, async queries => {
        const first = await clock.serverNow();

        assert.ok(Math.abs(first.getTime() - (Date.now() + 5 * 60_000)) < 1_000, "the database's time");
        await clock.serverNow();
        await clock.serverNow();
        assert.equal(queries(), 1, "measured once, not per call");
        assert.ok(Math.abs(clock.serverNowSync().getTime() - (Date.now() + 5 * 60_000)) < 1_000);
    });
});

test("server clock: a failing database clock keeps the last known offset (and says so)", async () => {
    await withDatabaseClock(90_000, async () => {
        await clock.serverNow();

        // Next measurement fails.
        prisma.$queryRaw = async () => { throw new Error("database unavailable"); };
        const state = globalThis.slServerClock;

        state.measuredAt -= 61_000;

        const now = await quiet(() => clock.serverNow());

        assert.ok(Math.abs(now.getTime() - (Date.now() + 90_000)) < 1_000, "the last offset still applies");
    });
});

test("clock skew: signals, activity and starts are written on the database clock, never this server's or the client's", async () => {
    await withDatabaseClock(-10 * 60_000, async () => {
        reset();
        const session = db.sessions.find(s => s.lectureId === LECTURE && s.isActive);

        session.teacherCurrentPageId = "page-aaaaaaaa";
        await presence.recordTeacherDepartureSignal(session.id, "page-aaaaaaaa");

        const expected = Date.now() - 10 * 60_000;

        assert.ok(Math.abs(session.teacherDepartureAt.getTime() - expected) < 1_000, "the signal's time is the database's");

        await presence.recordTeacherActivity(session.id, "page-bbbbbbbb");
        assert.ok(Math.abs(session.teacherActiveAfterDepartureAt.getTime() - expected) < 1_000, "so is the activity's");
        assert.equal(presence.departureState(session, new Date(expected)), "cancelled", "consistent: activity right after the signal");

        // A start's new generation too.
        await quiet(() => teacherPage().record());
        assert.ok(Math.abs(db.recordings[0].generationStartedAt.getTime() - expected) < 1_000);
    });
});

test("clock skew across processes: a departure confirmed on one clock is judged the same by a process whose own clock is off", async () => {
    await withDatabaseClock(0, async () => {
        reset();
        await quiet(() => teacherPage().goLive("unlisted"));

        const session = db.sessions.find(s => s.lectureId === LECTURE && s.isActive);
        const row = liveRow();

        row.createdAt = row.generationStartedAt = new Date(Date.now() - 120_000);
        session.teacherCurrentPageId = "page-aaaaaaaa";
        await presence.recordTeacherDepartureSignal(session.id, "page-aaaaaaaa", new Date(Date.now() - 60_000));

        // This process's own clock is 5 minutes slow; its database-clock offset corrects it.
        const realNow = Date.now;

        Date.now = () => realNow() - 5 * 60_000;
        clock.resetServerClock();
        prisma.$queryRaw = async () => [{ now: new Date(realNow()) }];

        try {
            const result = await quiet(() => lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE));

            assert.equal(result.status, "done", "confirmed: 60 s on the database clock, whatever this server's clock says");
        } finally {
            Date.now = realNow;
        }
    });
});

test("recording check: the teacher page's poll is coordinated, and an ended recording is still closed from a fresh answer", async () => {
    reset();
    youtubeRequest.youtubeTimeouts.statusCacheMs = 60_000;
    await quiet(() => teacherPage().record());

    const id = db.recordings[0].broadcastId;

    yt.broadcasts.get(id).lifecycle = "live";
    yt.calls = [];
    await quiet(() => Promise.all([
        lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE),
        lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE)
    ]));
    assert.equal(lookups(id), 1);

    // Ended on YouTube: once the cached "live" is past its age, the next poll
    // asks YouTube, sees "complete" and closes the row.
    youtubeRequest.youtubeTimeouts.statusCacheMs = 0;
    yt.autoStop(id, new Date());
    await quiet(() => lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE));
    assert.equal(db.recordings[0].status, "COMPLETE");
    assert.equal(db.recordings[0].stopReason, "YOUTUBE_ENDED");
});
