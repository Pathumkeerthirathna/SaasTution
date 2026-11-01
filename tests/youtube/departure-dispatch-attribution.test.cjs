/*
 * Fix 3: a departure `complete` that never left the server (the operation
 * deadline passed before youtubeFetch dispatched it) is not a sent
 * transition: not counted, no send time, never attributed TEACHER_LEFT; the
 * protection marker stays. A request that was dispatched and timed out is
 * still a sent, ambiguous transition, exactly as before.
 *
 * Fix 4: a terminal status lookup that closes a row whose broadcast had an
 * unconfirmed `complete` request (completeRequestedAt) at or before YouTube's
 * end claims no reason (not YOUTUBE_ENDED); without such a request the end is
 * still YOUTUBE_ENDED; the departure's TEACHER_LEFT rule is unchanged. Every
 * closing path: live snapshot, live status, recording check, start check,
 * departure lookup.
 *
 *   npm run test:youtube
 *
 * Real lifecycle, routes, request limits and status paths against
 * youtube-fakes.cjs. Nothing contacts YouTube or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");

const {
    TEACHER, LECTURE, db, yt, routes, reset, post, teacherPage, quiet, active, getLiveSnapshot, lectureLib, youtubeRequest
} = fakes;

const root = path.resolve(__dirname, "..", "..");
const sweep = require(path.join(root, "lib/teacher-departure-sweep.ts"));
const presence = require(path.join(root, "lib/teacher-presence.ts"));
const { YouTubeRequestTimeoutError } = youtubeRequest;
const { getActiveYouTubeLives } = require(path.join(root, "lib/youtube-live-status.ts"));

// ---- Helpers --------------------------------------------------------------

const liveRow = () => db.lives[db.lives.length - 1];
const recordingRow = () => db.recordings[db.recordings.length - 1];
const sessionOf = () => db.sessions.find(s => s.lectureId === LECTURE && s.isActive);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const stopLive = () => quiet(() => post(routes.liveStop, { lectureId: LECTURE }));
const stopRecording = () => quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));
const startLive = () => quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" }));

function answerWith(lifecycle) {
    yt.transitionAnswer = id => ({ id, status: { lifeCycleStatus: lifecycle } });
}

// The tab closed `agoMs` ago (confirmed), after the features started.
async function departedAgo(agoMs) {
    const closedAt = new Date(Date.now() - agoMs);

    for (const row of [...db.lives, ...db.recordings]) row.createdAt = row.generationStartedAt = new Date(closedAt.getTime() - 60_000);
    sessionOf().teacherCurrentPageId = "page-closed-1";
    await presence.recordTeacherDepartureSignal(sessionOf().id, "page-closed-1", closedAt);
    await presence.registerTeacherPage(sessionOf().id, "page-back-1", new Date());
}

// The next departure check is due (its last lookup moved into the past).
function checkDue() {
    for (const row of [...db.lives, ...db.recordings]) {
        if (row.autoStopCheckedAt) row.autoStopCheckedAt = new Date(row.autoStopCheckedAt.getTime() - 61_000);
    }
}

const departure = async () => (await quiet(() => sweep.sweepDepartedTeachers(new Date())))[0].result;

// Makes the departure's marker write (markCompleteRequested on the Live table)
// slow: it uses up the operation deadline before the transition is dispatched.
function slowMarkerWrite(ms) {
    const table = fakes.prisma.youTubeLiveBroadcast;
    const saved = table.updateMany;

    table.updateMany = async args => {
        if (args?.data?.completeRequestedAt instanceof Date) {
            table.updateMany = saved;
            await sleep(ms);
        }
        return saved(args);
    };

    return () => { table.updateMany = saved; };
}

// ---- Fix 3: a request never dispatched vs a dispatched timeout -----------------

test("1. pre-dispatch deadline: the transition never reaches YouTube; NOT counted, no send time, marker kept; a later auto-stop is never TEACHER_LEFT", async () => {
    reset();
    // The departure's budget is short (400 ms), so slow database writes
    // (450 ms) use it up between the time check and the request.
    Object.assign(youtubeRequest.youtubeTimeouts, { requestMs: 1_000, transitionMs: 1_000, departureStopMs: 400 });
    await quiet(() => teacherPage().goLive("unlisted"));
    await departedAgo(20_000);

    const row = liveRow();
    const fetchesBefore = fakes.networkRequests();

    yt.stall.add("transition"); // the transition goes through the real youtubeFetch
    const restore = slowMarkerWrite(450);
    let result;

    try {
        result = await departure();
    } finally {
        restore();
        yt.stall.delete("transition");
    }

    assert.equal(fakes.networkRequests(), fetchesBefore, "no HTTP request was dispatched");
    assert.equal(result.status, "pending");
    assert.equal(row.autoStopSendCount, 0, "not counted as a sent transition");
    assert.equal(row.autoStopAttemptedAt, null, "no send time");
    assert.notEqual(row.autoStopError, "timeout", "not an ambiguous (maybe applied) send");
    assert.match(row.autoStopLastError, /not sent/);
    assert.ok(row.completeRequestedAt instanceof Date, "the protection marker is preserved");
    assert.equal(active([row]).length, 1, "never claimed as stopped");

    // No start refusal for an in-flight departure send (nothing is in flight);
    // the marker still refuses reuse of the broadcast.
    const start = await startLive();

    assert.equal(start.status, 409);
    assert.equal(start.data.code, "YOUTUBE_COMPLETE_PENDING", "refused by the marker, not by a departure send");

    // YouTube's own auto-stop ends it within 60 s: never the departure's.
    Object.assign(youtubeRequest.youtubeTimeouts, { departureStopMs: 40_000 });
    yt.autoStop(row.broadcastId, new Date());
    checkDue();
    await departure();

    assert.equal(row.status, "COMPLETE");
    assert.notEqual(row.stopReason, "TEACHER_LEFT", "nothing was sent: not the departure's");
    assert.equal(row.stopReason, null, "a `complete` was requested (marker): cause not claimed");
});

test("1b. the not-sent error is distinguished at its source: only a pre-dispatch deadline is `dispatched: false`", async () => {
    reset();

    const notSent = await youtubeRequest.runWithYouTubeDeadline(Date.now() - 1, () =>
        youtubeRequest.youtubeFetch("https://youtube.invalid/x").catch(error => error));

    assert.ok(notSent instanceof YouTubeRequestTimeoutError);
    assert.equal(notSent.dispatched, false);

    const timedOut = await youtubeRequest.youtubeFetch("https://youtube.invalid/x", {}, { timeoutMs: 20 }).catch(error => error);

    assert.ok(timedOut instanceof YouTubeRequestTimeoutError);
    assert.equal(timedOut.dispatched, true, "dispatched, then aborted: may have reached YouTube");

    const byDeadline = await youtubeRequest.runWithYouTubeDeadline(Date.now() + 20, () =>
        youtubeRequest.youtubeFetch("https://youtube.invalid/x").catch(error => error));

    assert.ok(byDeadline instanceof YouTubeRequestTimeoutError);
    assert.equal(byDeadline.dispatched, true, "aborted by the deadline AFTER dispatch: still dispatched");
});

test("2. dispatched timeout: still a sent, ambiguous transition (counted, send time, \"timeout\"); an auto-stop within 60 s is TEACHER_LEFT as before", async () => {
    reset();
    Object.assign(youtubeRequest.youtubeTimeouts, { requestMs: 40, transitionMs: 40 });
    await quiet(() => teacherPage().goLive("unlisted"));
    await departedAgo(20_000);

    const row = liveRow();
    const fetchesBefore = fakes.networkRequests();

    yt.stall.add("transition");

    try {
        await departure();
    } finally {
        yt.stall.delete("transition");
    }

    assert.equal(fakes.networkRequests(), fetchesBefore + 1, "the request was dispatched");
    assert.equal(row.autoStopSendCount, 1, "counted");
    assert.ok(row.autoStopAttemptedAt instanceof Date, "send time recorded");
    assert.equal(row.autoStopError, "timeout");
    assert.match(row.autoStopLastError, /^transition: no answer in time$/);
    assert.ok(row.completeRequestedAt instanceof Date);

    // Applied late, within 60 s of the send: the departure's (unchanged rule, takes precedence).
    yt.autoStop(row.broadcastId, new Date());
    checkDue();
    await departure();

    assert.equal(row.status, "COMPLETE");
    assert.equal(row.stopReason, "TEACHER_LEFT");
});

// ---- Fix 4: late manual Stop, every closing path ------------------------------

// A Stop that YouTube answered "live" (unconfirmed), then YouTube ends it.
async function lateStoppedLive() {
    await quiet(() => teacherPage().goLive("unlisted"));
    answerWith("live");
    assert.equal((await stopLive()).data.code, "YOUTUBE_STOP_UNCONFIRMED");
    yt.transitionAnswer = null;

    const row = liveRow();

    assert.ok(row.completeRequestedAt instanceof Date);
    yt.autoStop(row.broadcastId, new Date(Date.now() + 1_000)); // after the request
    return row;
}

const CLOSING_PATHS = {
    "live snapshot": () => getLiveSnapshot(LECTURE, "teacher"),
    "live status": () => getActiveYouTubeLives({ teacherId: TEACHER }),
    "start check": () => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" })
};

for (const [name, close] of Object.entries(CLOSING_PATHS)) {
    test(`3. late manual Stop, then a terminal status (${name}): closed with no reason, never YOUTUBE_ENDED; marker cleared`, async () => {
        reset();
        const row = await lateStoppedLive();

        await quiet(close);

        assert.equal(row.status, "COMPLETE", name);
        assert.equal(row.stopReason ?? null, null, `${name}: cause not claimed`);
        assert.equal(row.endedAt.getTime(), yt.broadcasts.get(row.broadcastId).actualEndTime.getTime(), "YouTube's end time");
        assert.equal(row.completeRequestedAt, null, "confirmed end: cleared");
    });
}

test("3. late manual Stop of a Recording, then the recording check: no reason, never YOUTUBE_ENDED", async () => {
    reset();
    await quiet(() => teacherPage().record());
    answerWith("live");
    assert.equal((await stopRecording()).data.code, "YOUTUBE_STOP_UNCONFIRMED");
    yt.transitionAnswer = null;

    const row = recordingRow();

    yt.autoStop(row.broadcastId, new Date(Date.now() + 1_000));
    await quiet(() => lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE));

    assert.equal(row.status, "COMPLETE");
    assert.equal(row.stopReason ?? null, null);
});

test("3. departure lookup: a departure request REFUSED (no ambiguous send), YouTube ends it later: no reason, not YOUTUBE_ENDED, not TEACHER_LEFT", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await departedAgo(20_000);

    const row = liveRow();

    yt.transitionErrors.set(row.broadcastId, Object.assign(new youtubeRequest.YouTubeApiError("backendError", 503)));
    await departure();
    yt.transitionErrors.clear();

    assert.equal(row.autoStopError, "youtube");
    assert.ok(row.completeRequestedAt instanceof Date);

    yt.autoStop(row.broadcastId, new Date(Date.now() + 1_000));
    checkDue();
    await departure();

    assert.equal(row.status, "COMPLETE");
    assert.equal(row.stopReason ?? null, null);
});

// ---- Fix 4: unchanged classifications --------------------------------------

for (const [name, close] of Object.entries(CLOSING_PATHS)) {
    test(`4. no pending request: YouTube's end is still YOUTUBE_ENDED (${name})`, async () => {
        reset();
        await quiet(() => teacherPage().goLive("unlisted"));

        const row = liveRow();

        assert.equal(row.completeRequestedAt ?? null, null);
        yt.autoStop(row.broadcastId, new Date());
        await quiet(close);

        assert.equal(row.status, "COMPLETE");
        assert.equal(row.stopReason, "YOUTUBE_ENDED", name);
    });
}

test("4. no pending request: recording check and departure lookup still give YOUTUBE_ENDED; a request made AFTER YouTube's end does not change that", async () => {
    // Recording check.
    reset();
    await quiet(() => teacherPage().record());
    yt.autoStop(recordingRow().broadcastId, new Date());
    await quiet(() => lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE));
    assert.equal(recordingRow().stopReason, "YOUTUBE_ENDED");

    // Departure lookup: YouTube ended it before anything was sent.
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await departedAgo(20_000);
    yt.autoStop(liveRow().broadcastId, new Date(Date.now() - 5_000));
    await departure();
    assert.equal(liveRow().stopReason, "YOUTUBE_ENDED");

    // A marker set after YouTube's end: YouTube's end, as before.
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const row = liveRow();

    yt.autoStop(row.broadcastId, new Date(Date.now() - 60_000));
    row.completeRequestedAt = new Date();
    await quiet(() => getLiveSnapshot(LECTURE, "teacher"));
    assert.equal(row.stopReason, "YOUTUBE_ENDED", "ended before our request");
});

test("5. TEACHER_LEFT unchanged: an unanswered departure send, then YouTube's end within 60 s, is the departure's on every closing path", async () => {
    for (const [name, close] of Object.entries({ ...CLOSING_PATHS, "departure lookup": () => { checkDue(); return departure(); } })) {
        reset();
        Object.assign(youtubeRequest.youtubeTimeouts, { requestMs: 40, transitionMs: 40 });
        await quiet(() => teacherPage().goLive("unlisted"));
        await departedAgo(20_000);

        const row = liveRow();

        yt.stall.add("transition");
        try {
            await departure();
        } finally {
            yt.stall.delete("transition");
        }

        assert.equal(row.autoStopError, "timeout", name);
        // Past the 60 s in which a start is refused (assertNoDepartureStopBeforeStart),
        // with YouTube's end 5 s after the send: within its window.
        row.autoStopAttemptedAt = new Date(row.autoStopAttemptedAt.getTime() - 61_000);
        yt.autoStop(row.broadcastId, new Date(row.autoStopAttemptedAt.getTime() + 5_000));
        await quiet(close);

        assert.equal(row.status, "COMPLETE", name);
        assert.equal(row.stopReason, "TEACHER_LEFT", name);
    }
});
