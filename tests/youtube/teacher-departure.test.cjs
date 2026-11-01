/*
 * Teacher-departure stop: once the class's teacher closed the classroom tab
 * (a tab-close signal, ClassSession.teacherDepartureAt, confirmed because no
 * teacher activity followed within the 15 s reload-confirmation window), the
 * YouTube Recording / Live that were active then are ended on YouTube, with
 * stopReason TEACHER_LEFT written only together with a confirmed end.
 * Students and the class session are untouched. Jibri is NOT stopped (no
 * server-side way to): the start guard keeps another class from riding that
 * orphaned stream.
 *
 * Never a reason to stop: no signal at all (lost network, SSE drop, Wi-Fi
 * switch, a backgrounded / suspended tab, a stale heartbeat), a signal
 * cancelled by a refresh or another open tab.
 *
 *   npm run test:youtube
 *
 * Real lib/youtube-feature-lifecycle.ts, lib/teacher-presence.ts,
 * lib/teacher-departure-sweep.ts, lib/youtube-lecture.ts, the status syncs,
 * the lock and the routes, against the in-memory fakes of youtube-fakes.cjs
 * (Prisma, YouTube, a fake Jibri). Nothing here contacts YouTube, Jibri or a
 * database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");

const {
    TEACHER, LECTURE, LECTURE_2, db, yt, jibri, routes, locks, lockAttempts, reset, post, teacherPage, quiet,
    completions, active, lectureLib, getLiveSnapshot, YouTubeReauthorizationRequiredError
} = fakes;

const root = path.resolve(__dirname, "..", "..");
const lifecycle = require(path.join(root, "lib/youtube-feature-lifecycle.ts"));
const sweep = require(path.join(root, "lib/teacher-departure-sweep.ts"));
const presence = require(path.join(root, "lib/teacher-presence.ts"));
const { getActiveYouTubeLives } = require(path.join(root, "lib/youtube-live-status.ts"));

const CONFIRM_MS = 15_000;

// ---- Helpers --------------------------------------------------------------

const sessionOf = (lectureId = LECTURE) => db.sessions.find(s => s.lectureId === lectureId && s.isActive);

// A moment after every row created so far (the fake clock is the real time):
// the tab closes after the features were started.
const later = (ms = 0) => new Date(Date.now() + 60_000 + ms);

// The classroom page `pageId` (the teacher's current page) sent its closing
// signal at `at`, as the signal route records it.
async function closeTab(at, pageId = "page-closed-1", lectureId = LECTURE) {
    sessionOf(lectureId).teacherCurrentPageId = pageId;

    const result = await presence.recordTeacherDepartureSignal(sessionOf(lectureId).id, pageId, at);

    assert.deepEqual(result, { accepted: true });
    return result;
}

// Closed long enough before `now` for the departure to be confirmed.
const departed = now => closeTab(new Date(now.getTime() - CONFIRM_MS - 1_000));

const liveRow = () => db.lives[db.lives.length - 1];
const recordingRow = () => db.recordings[db.recordings.length - 1];
const transitions = () => yt.calls.filter(call => call.startsWith("transition:") && call.endsWith(":complete"));

function assertEndedByDeparture(row) {
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.stopReason, "TEACHER_LEFT");
    assert.ok(row.endedAt instanceof Date, "end time recorded");
    assert.equal(row.autoStopError, null);
}

function assertClassUntouched() {
    for (const s of db.sessions) {
        assert.equal(s.isActive, true, "class session not ended");
        assert.equal(s.endedAt, null);
    }
    assert.deepEqual(db.attendanceCloses, [], "no student's attendance closed");
}

const runSweep = now => quiet(() => sweep.sweepDepartedTeachers(now));

// ---- Which features --------------------------------------------------------------

test("tab closed (Live only): ended on YouTube, TEACHER_LEFT recorded; class and students untouched; Jibri still running", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.goLive("unlisted"));
    assert.equal(jibri.running, true);

    const now = later();

    await departed(now);

    const [{ result }] = await runSweep(now);

    assert.equal(result.status, "done");
    assert.deepEqual(result.stopped, ["live"]);
    assert.deepEqual(result.pending, []);
    assertEndedByDeparture(liveRow());
    assert.equal(completions(liveRow().broadcastId).length, 1);
    assert.equal(db.recordings.length, 0, "no recording touched or invented");
    assertClassUntouched();

    // Only YouTube was ended: the fake Jibri was never told to stop.
    assert.equal(result.jibriMayStillRun, true);
    assert.equal(jibri.stops, 0);
    assert.equal(jibri.running, true);
    assert.equal(yt.streamActive, true, "the reusable stream still receives Jibri's stream");
});

test("tab closed (Recording only): only the recording is ended and reported", async () => {
    reset();
    await quiet(() => teacherPage().record());

    const now = later();

    await departed(now);

    const [{ result }] = await runSweep(now);

    assert.deepEqual(result.stopped, ["recording"]);
    assertEndedByDeparture(recordingRow());
    assert.equal(db.lives.length, 0);
    assertClassUntouched();
});

test("tab closed (both): both ended, each YouTube broadcast completed exactly once", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));
    assert.equal(active(db.recordings).length + active(db.lives).length, 2);

    const now = later();

    await departed(now);

    const [{ result }] = await runSweep(now);

    assert.deepEqual(result.stopped.sort(), ["live", "recording"]);
    assertEndedByDeparture(recordingRow());
    assertEndedByDeparture(liveRow());

    for (const id of new Set([recordingRow().broadcastId, liveRow().broadcastId])) {
        assert.equal(completions(id).length, 1, "completed once: " + id);
    }
    assertClassUntouched();
});

// ---- The 15 s reload-confirmation window ----------------------------------------------

test("15 s window: pending until it has passed (no lock, nothing stopped); confirmed just after", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = later();

    await closeTab(closedAt);

    for (const afterMs of [0, 5_000, CONFIRM_MS]) {
        lockAttempts.length = 0;

        const [{ result }] = await runSweep(new Date(closedAt.getTime() + afterMs));

        assert.deepEqual(result, { status: "skipped", reason: "departure-pending" }, String(afterMs));
        assert.deepEqual(lockAttempts, [], "no lock while the departure is pending");
        assert.equal(active(db.lives).length, 1, "YouTube keeps running during the window");
    }

    assert.equal((await runSweep(new Date(closedAt.getTime() + CONFIRM_MS + 1)))[0].result.status, "done");
    assertEndedByDeparture(liveRow());
});

test("the window and heartbeat settings: 15 s and 10 s", () => {
    assert.equal(presence.TEACHER_DEPARTURE_CONFIRM_MS, 15_000);
    assert.equal(presence.TEACHER_PRESENCE_REFRESH_MS, 10_000);
    assert.ok(presence.TEACHER_PRESENCE_REFRESH_MS < presence.TEACHER_DEPARTURE_CONFIRM_MS,
        "an open tab's heartbeat always lands inside the window");

    const at = new Date(1_000_000);
    const state = (activeAfterMs, nowMs) => presence.departureState({
        teacherDepartureAt: at,
        teacherActiveAfterDepartureAt: activeAfterMs === null ? null : new Date(at.getTime() + activeAfterMs)
    }, new Date(at.getTime() + nowMs));

    assert.equal(presence.departureState({ teacherDepartureAt: null, teacherActiveAfterDepartureAt: null }, at), "none");
    assert.equal(state(null, CONFIRM_MS), "pending");
    assert.equal(state(null, CONFIRM_MS + 1), "confirmed");
    assert.equal(state(CONFIRM_MS, CONFIRM_MS + 60_000), "cancelled", "activity at exactly 15 s still cancels");
    assert.equal(state(CONFIRM_MS + 1, CONFIRM_MS + 60_000), "confirmed", "later activity is a return");
});

test("refresh within 15 s: the new page's connection cancels the departure; nothing is ever stopped", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = later();

    await closeTab(closedAt, "page-before-refresh");
    // The refreshed page (a new page instance) registers.
    await presence.registerTeacherPage(sessionOf().id, "page-after-refresh", new Date(closedAt.getTime() + 3_000));
    assert.equal(sessionOf().teacherCurrentPageId, "page-after-refresh");

    for (const afterMs of [CONFIRM_MS + 1, 10 * 60_000]) {
        const [{ result }] = await runSweep(new Date(closedAt.getTime() + afterMs));

        assert.deepEqual(result, { status: "skipped", reason: "departure-cancelled" });
    }

    assert.equal(active(db.lives).length, 1);
    assert.deepEqual(transitions(), []);
});

test("another open teacher tab: its heartbeat within the window cancels and takes over; server-side presence ticks never cancel", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = later();

    await closeTab(closedAt, "tab-a");
    // The closed tab's own activity racing its close, and the server-side
    // presence refresh of any connection: neither is activity.
    await presence.recordTeacherActivity(sessionOf().id, "tab-a", new Date(closedAt.getTime() + 500));
    await presence.recordTeacherPresence(sessionOf().id, new Date(closedAt.getTime() + 5_000));
    assert.equal(sessionOf().teacherActiveAfterDepartureAt, null);

    // Tab B is still open: its next heartbeat (every 10 s) arrives within the window.
    await presence.recordTeacherActivity(sessionOf().id, "tab-b", new Date(closedAt.getTime() + 9_000));
    assert.equal(sessionOf().teacherCurrentPageId, "tab-b", "the live tab is now the current page");

    const [{ result }] = await runSweep(new Date(closedAt.getTime() + 60_000));

    assert.equal(result.reason, "departure-cancelled");
    assert.equal(active(db.lives).length, 1);

    // Tab B closes later: accepted (it is current), a new window.
    assert.deepEqual(await presence.recordTeacherDepartureSignal(sessionOf().id, "tab-b", new Date(closedAt.getTime() + 120_000)), { accepted: true });
    assert.equal(sessionOf().teacherActiveAfterDepartureAt, null);
    assert.equal((await runSweep(new Date(closedAt.getTime() + 140_000)))[0].result.status, "done");
    assertEndedByDeparture(liveRow());
});

test("the teacher comes back after 15 s: the departure stands (it is a return, not a refresh)", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = later();

    await closeTab(closedAt);
    await presence.registerTeacherPage(sessionOf().id, "page-returned", new Date(closedAt.getTime() + 20_000));

    assert.equal(sessionOf().teacherActiveAfterDepartureAt.getTime(), closedAt.getTime() + 20_000, "the return is recorded");
    assert.equal((await runSweep(new Date(closedAt.getTime() + 21_000)))[0].result.status, "done");
    assertEndedByDeparture(liveRow());
});

test("features the teacher starts after coming back are theirs: never stopped by the old departure", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.goLive("unlisted"));

    const closedAt = later();

    await closeTab(closedAt);
    await runSweep(new Date(closedAt.getTime() + 20_000));
    assertEndedByDeparture(liveRow());

    // Back (after the window), the teacher starts Recording: created after the signal.
    await presence.registerTeacherPage(sessionOf().id, "page-2", new Date(closedAt.getTime() + 25_000));
    const recording = await quiet(() => page.record());

    assert.equal(recording.status, 200);
    recordingRow().createdAt = recordingRow().generationStartedAt = new Date(closedAt.getTime() + 30_000);

    const [{ result }] = await runSweep(new Date(closedAt.getTime() + 60_000));

    assert.deepEqual(result, { status: "skipped", reason: "no-active-features" });
    assert.equal(active(db.recordings).length, 1);
});

// ---- Never a departure without a signal ------------------------------------------------

test("no signal at all (lost network, SSE drop, Wi-Fi switch, backgrounded tab): a stale heartbeat never stops anything", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const now = later();

    // Last heard from hours ago, never a closing signal.
    sessionOf().teacherLastSeenAt = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    lockAttempts.length = 0;

    assert.deepEqual(await runSweep(now), [], "no session with a signal: nothing even checked");
    const result = await quiet(() => lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, now));

    assert.deepEqual(result, { status: "skipped", reason: "no-departure" });
    assert.deepEqual(lockAttempts, []);
    assert.equal(active(db.lives).length, 1);
    assert.equal(await quiet(() => lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, new Date(now.getTime() + 600_000)))
        .then(r => r.reason), "no-departure", "the students' check (same function) agrees");
});

test("a new closing signal while the sweep takes the lock: checked again under it, nothing stopped", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const now = later();

    await departed(now);

    const create = fakes.prisma.youTubeOperationLock.create;

    fakes.prisma.youTubeOperationLock.create = async args => {
        // Another tab of the teacher closes just now: a new window starts.
        await closeTab(new Date(now.getTime() - 1_000), "page-other");
        return create(args);
    };

    try {
        const [{ result }] = await runSweep(now);

        assert.deepEqual(result, { status: "skipped", reason: "departure-pending" });
        assert.equal(active(db.lives).length, 1);
        assert.deepEqual(transitions(), []);
    } finally {
        fakes.prisma.youTubeOperationLock.create = create;
    }
});

// ---- YouTube's auto-stop racing the departure -------------------------------------------

test("YouTube auto-stops first and a status sync closes the row: kept as YOUTUBE_ENDED, never re-labelled a departure", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = later();
    const id = liveRow().broadcastId;

    await closeTab(closedAt);
    // Jibri lost the teacher's media; YouTube's enableAutoStop ends the broadcast.
    yt.autoStop(id, new Date(closedAt.getTime() + 5_000));
    // A student's live-updates snapshot sees it ended and closes the row.
    await quiet(() => getLiveSnapshot(LECTURE, "student"));

    assert.equal(liveRow().status, "COMPLETE");
    assert.equal(liveRow().stopReason, "YOUTUBE_ENDED", "the YouTube end is kept, not erased");
    assert.equal(liveRow().endedAt.getTime(), closedAt.getTime() + 5_000, "with YouTube's own end time");

    // actualEndTime is after the close, but it only says when YouTube
    // completed it: the stream may have failed before the close.
    const [{ result }] = await runSweep(new Date(closedAt.getTime() + 20_000));

    assert.deepEqual(result, { status: "skipped", reason: "no-active-features" });
    assert.equal(liveRow().stopReason, "YOUTUBE_ENDED");
    assert.deepEqual(transitions(), [], "YouTube was not asked to end it again");
});

test("YouTube auto-stopped and nobody synced yet: the departure closes it as YOUTUBE_ENDED with YouTube's time, not as its own stop", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = later();
    const id = liveRow().broadcastId;

    await closeTab(closedAt);
    yt.autoStop(id, new Date(closedAt.getTime() + 7_000));

    const [{ result }] = await runSweep(new Date(closedAt.getTime() + 20_000));

    assert.deepEqual(result.stopped, ["live"], "closed now");
    assert.equal(liveRow().stopReason, "YOUTUBE_ENDED");
    assert.equal(liveRow().endedAt.getTime(), closedAt.getTime() + 7_000);
    assert.deepEqual(transitions(), [], "already complete: not completed again");
});

test("YouTube ended BEFORE the tab closed (Jibri failure, unrelated end): never a teacher departure", async () => {
    reset();
    await quiet(() => teacherPage().record());
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = later();

    // Both broadcasts ended on YouTube before the teacher closed the tab.
    yt.autoStop(recordingRow().broadcastId, new Date(closedAt.getTime() - 30_000));
    yt.autoStop(liveRow().broadcastId, new Date(closedAt.getTime() - 30_000));
    // The recording row is synced (teacher's status check), the live one is not.
    await quiet(() => lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE));
    assert.equal(recordingRow().stopReason, "YOUTUBE_ENDED");

    await closeTab(closedAt);
    await runSweep(new Date(closedAt.getTime() + 20_000));

    assert.equal(recordingRow().stopReason, "YOUTUBE_ENDED", "not attributed");
    assert.equal(liveRow().status, "COMPLETE");
    assert.equal(liveRow().stopReason, "YOUTUBE_ENDED", "found ended, before the signal: not the departure");
});

test("YouTube ends after the teacher came back, or without an end time: not attributed", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = later();

    await closeTab(closedAt);
    await presence.registerTeacherPage(sessionOf().id, "page-back-1", new Date(closedAt.getTime() + 60_000));
    // A Jibri failure after the return: YouTube ends it then.
    yt.autoStop(liveRow().broadcastId, new Date(closedAt.getTime() + 90_000));
    await quiet(() => getLiveSnapshot(LECTURE, "teacher"));
    await runSweep(new Date(closedAt.getTime() + 120_000));
    assert.equal(liveRow().stopReason, "YOUTUBE_ENDED");

    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt2 = later();

    await closeTab(closedAt2);
    yt.autoStop(liveRow().broadcastId, new Date(closedAt2.getTime() + 5_000), { withEndTime: false });
    await quiet(() => getLiveSnapshot(LECTURE, "student"));
    assert.equal(liveRow().stopReason ?? null, null, "no end time from YouTube: nothing claimed");
    await runSweep(new Date(closedAt2.getTime() + 20_000));
    assert.equal(liveRow().stopReason ?? null, null);
});

test("every status sync keeps a YouTube end as YOUTUBE_ENDED with YouTube's time (the departure's evidence)", async () => {
    const endedAt = new Date(Date.now() + 5_000);

    // getLiveSnapshot (live-updates), getActiveYouTubeLives (dashboards).
    for (const sync of [() => getLiveSnapshot(LECTURE, "teacher"), () => getActiveYouTubeLives({ teacherId: TEACHER })]) {
        reset();
        await quiet(() => teacherPage().goLive("unlisted"));
        yt.autoStop(liveRow().broadcastId, endedAt);
        await quiet(sync);
        assert.equal(liveRow().status, "COMPLETE");
        assert.equal(liveRow().stopReason, "YOUTUBE_ENDED");
        assert.equal(liveRow().endedAt.getTime(), endedAt.getTime());
    }

    // checkYouTubeRecordingStatus (the teacher's classroom page).
    reset();
    await quiet(() => teacherPage().record());
    yt.autoStop(recordingRow().broadcastId, endedAt);
    await quiet(() => lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE));
    assert.equal(recordingRow().stopReason, "YOUTUBE_ENDED");
    assert.equal(recordingRow().endedAt.getTime(), endedAt.getTime());

    // checkExistingBroadcast (any start).
    reset();
    await quiet(() => teacherPage().record());
    yt.autoStop(recordingRow().broadcastId, endedAt);
    assert.deepEqual(await quiet(() => lectureLib.checkExistingBroadcast("recording", recordingRow(), "enc")), { reusable: false });
    assert.equal(recordingRow().stopReason, "YOUTUBE_ENDED");
    assert.equal(recordingRow().endedAt.getTime(), endedAt.getTime());
});

// ---- Concurrency ---------------------------------------------------------------------

test("duplicate and concurrent sweeps: one stop, one completion; later sweeps do nothing", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const now = later();

    await departed(now);

    const results = await quiet(() => Promise.all([
        sweep.sweepDepartedTeachers(now),
        sweep.sweepDepartedTeachers(now),
        lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, now)
    ]));
    const statuses = results.map(r => (Array.isArray(r) ? r[0]?.result.status : r.status));

    assert.equal(statuses.filter(s => s === "done").length, 1, JSON.stringify(statuses));
    assert.ok(statuses.every(s => s === "done" || s === "busy" || s === "skipped" || s === undefined), JSON.stringify(statuses));
    assert.equal(completions(liveRow().broadcastId).length, 1);
    assertEndedByDeparture(liveRow());

    const callsBefore = yt.calls.length;
    const [{ result: again }] = await runSweep(later(1_000));

    assert.deepEqual(again, { status: "skipped", reason: "no-active-features" }, "nothing left to stop");
    assert.equal(yt.calls.length, callsBefore, "no YouTube call");
});

test("manual Stop: never a departure notice; a Stop holding the lock makes the sweep busy", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.goLive("unlisted"));

    const now = later();

    await departed(now);
    locks.set(LECTURE, { lectureId: LECTURE, ownerId: "manual-stop", expiresAt: new Date(Date.now() + 60_000) });

    const [{ result }] = await runSweep(now);

    assert.equal(result.status, "busy");
    assert.equal(active(db.lives).length, 1);
    assert.equal(liveRow().autoStopError ?? null, null, "a busy lock is not an error");

    locks.clear();
    await quiet(() => page.stopLive());
    assert.equal(liveRow().status, "COMPLETE");
    assert.equal(liveRow().stopReason ?? null, null, "the teacher's own Stop: no departure reason");

    assert.equal((await runSweep(now))[0].result.reason, "no-active-features");
    assert.equal(liveRow().stopReason ?? null, null, "still none after the sweep");
    assert.equal(completions(liveRow().broadcastId).length, 1);
});

test("manual Stop and sweep at the same moment: the broadcast is completed once, by one of them", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const now = later();

    await departed(now);

    const [stop] = await quiet(() => Promise.all([
        post(routes.liveStop, { lectureId: LECTURE }),
        sweep.sweepDepartedTeachers(now)
    ]));

    assert.ok(stop.status === 200 || stop.status === 409, String(stop.status));
    assert.equal(completions(liveRow().broadcastId).length, 1);
    assert.equal(liveRow().status, "COMPLETE");
});

// ---- Failures --------------------------------------------------------------------------

test("YouTube refuses the transition: nothing claimed, the send time and reason kept; resent only after the 60 s cooldown", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const id = liveRow().broadcastId;
    const now = later();

    await departed(now);
    yt.transitionErrors.set(id, new Error("YouTube is down"));

    const [{ result }] = await runSweep(now);

    assert.equal(result.status, "pending");
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.pending, [{ feature: "live", reason: "youtube" }]);
    assert.equal(active(db.lives).length, 1, "still active: not claimed as stopped");
    assert.equal(liveRow().stopReason ?? null, null);
    assert.equal(liveRow().autoStopError, "youtube");

    const sentAt = liveRow().autoStopAttemptedAt.getTime();

    assert.ok(Math.abs(Date.now() - sentAt) < 5_000, "the time the transition was actually sent");
    assert.equal(completions(id).length, 1);

    yt.transitionErrors.delete(id);

    // Within the cooldown: looked up, nothing sent again.
    const [{ result: early }] = await runSweep(later(5_000));

    assert.deepEqual(early.pending, [{ feature: "live", reason: "youtube" }]);
    assert.equal(completions(id).length, 1, "no second transition within 60 s");

    // 60 s later (in the database): sent again, confirmed.
    liveRow().autoStopAttemptedAt = new Date(sentAt - lifecycle.TRANSITION_RESEND_COOLDOWN_MS);
    liveRow().autoStopCheckedAt = new Date(sentAt - lifecycle.TRANSITION_RESEND_COOLDOWN_MS);
    const [{ result: retry }] = await runSweep(later(70_000));

    assert.equal(retry.status, "done");
    assertEndedByDeparture(liveRow());
    assert.equal(completions(id).length, 2);
    assert.ok(liveRow().autoStopAttemptedAt.getTime() >= sentAt, "the new send time");
});

test("expired YouTube authorization: pending, connection marked; Google not asked again until reconnected", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const id = liveRow().broadcastId;
    const now = later();

    await departed(now);
    yt.getErrors.set(id, new YouTubeReauthorizationRequiredError("invalid_grant"));

    const [{ result }] = await runSweep(now);

    assert.deepEqual(result.pending, [{ feature: "live", reason: "reauth-required" }]);
    assert.equal(db.connection.status, "REAUTH_REQUIRED");
    assert.equal(liveRow().autoStopError, "reauth-required");
    assert.equal(active(db.lives).length, 1);

    const callsBefore = yt.calls.length;
    const [{ result: again }] = await runSweep(later(5_000));

    assert.deepEqual(again.pending, [{ feature: "live", reason: "reauth-required" }]);
    assert.equal(yt.calls.length, callsBefore, "no Google request while authorization is expired");

    // The teacher reconnects YouTube; the next check is due (time passes).
    db.connection.status = "CONNECTED";
    yt.getErrors.delete(id);
    liveRow().autoStopCheckedAt = new Date(Date.now() - 60_000);
    assert.equal((await runSweep(later(10_000)))[0].result.status, "done");
    assertEndedByDeparture(liveRow());
});

test("a broadcast still used by an earlier session's row: not ended, not claimed (pending shared-broadcast)", async () => {
    reset();
    sessionOf().startedAt = new Date(1_000);
    yt.broadcasts.set("bc-shared", { privacy: "unlisted", lifecycle: "live", stream: fakes.STREAM });
    db.recordings.push({ id: "old-rec", lectureId: LECTURE, broadcastId: "bc-shared", status: "LIVE", createdAt: new Date(500), version: 0 });
    db.lives.push({ id: "new-live", lectureId: LECTURE, broadcastId: "bc-shared", status: "LIVE", createdAt: new Date(2_000), version: 0 });

    const now = later();

    await departed(now);

    const [{ result }] = await runSweep(now);

    assert.deepEqual(result.pending, [{ feature: "live", reason: "shared-broadcast" }]);
    assert.deepEqual(transitions(), [], "YouTube not asked to end a broadcast still in use");
    assert.equal(db.lives[0].status, "LIVE");
    assert.equal(db.recordings[0].status, "LIVE", "the earlier session's row is left to reconciliation");
});

// ---- Restart, triggers ---------------------------------------------------------------

test("process restart: a sweep in a fresh process finishes what a failed one left (all state is in the database)", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const id = liveRow().broadcastId;
    const now = later();

    await departed(now);
    yt.transitionErrors.set(id, new Error("YouTube is down"));
    assert.equal((await runSweep(now))[0].result.status, "pending");

    // "Restart": nothing in memory survives; everything needed is in the database.
    sweep.stopTeacherDepartureSweeper();
    delete require.cache[path.join(root, "lib/teacher-departure-sweep.ts")];

    const fresh = require(path.join(root, "lib/teacher-departure-sweep.ts"));

    yt.transitionErrors.delete(id);

    // The send time survived the restart: no second transition within the cooldown.
    assert.equal((await quiet(() => fresh.sweepDepartedTeachers(later(5_000))))[0].result.status, "pending");
    assert.equal(completions(id).length, 1);

    liveRow().autoStopAttemptedAt = new Date(Date.now() - lifecycle.TRANSITION_RESEND_COOLDOWN_MS - 1_000);
    liveRow().autoStopCheckedAt = new Date(Date.now() - lifecycle.TRANSITION_RESEND_COOLDOWN_MS - 1_000);
    const [{ result }] = await quiet(() => fresh.sweepDepartedTeachers(later(70_000)));

    assert.equal(result.status, "done");
    assertEndedByDeparture(liveRow());
});

test("scheduled sweep (interval, long-running server): processes a confirmed departure with no student connected", async t => {
    assert.equal(sweep.TEACHER_DEPARTURE_SWEEP_INTERVAL_MS, 5_000);
    assert.equal(sweep.canRunIntervalSweeper({ NODE_ENV: "production" }), true);
    assert.equal(sweep.canRunIntervalSweeper({ NODE_ENV: "development" }), false);
    assert.equal(sweep.canRunIntervalSweeper({ NODE_ENV: "production", NETLIFY: "true" }), false);
    assert.equal(sweep.canRunIntervalSweeper({ NODE_ENV: "production", AWS_LAMBDA_FUNCTION_NAME: "fn" }), false);
    assert.equal(sweep.startTeacherDepartureSweeper({ NODE_ENV: "development" }), false);

    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    // The sweeper uses the real clock: the tab closed well before it.
    sessionOf().teacherDepartureAt = new Date(Date.now() - 60_000);
    liveRow().createdAt = liveRow().generationStartedAt = new Date(Date.now() - 120_000);

    t.mock.timers.enable({ apis: ["setInterval"] });

    try {
        await quiet(async () => {
            assert.equal(sweep.startTeacherDepartureSweeper({ NODE_ENV: "production" }), true);
            assert.equal(sweep.startTeacherDepartureSweeper({ NODE_ENV: "production" }), true, "already running");

            t.mock.timers.tick(4_999);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(active(db.lives).length, 1, "not before the interval");

            t.mock.timers.tick(1);
            for (let i = 0; i < 20 && active(db.lives).length; i++) {
                await new Promise(resolve => setImmediate(resolve));
            }
        });

        assertEndedByDeparture(liveRow());
    } finally {
        sweep.stopTeacherDepartureSweeper();
    }
});

test("students still connected: their check stops the class's features, throttled per lecture", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const now = later(5 * 60_000);

    await departed(now);

    const result = await quiet(() => sweep.checkLectureForDepartedTeacher(LECTURE, now));

    assert.equal(result.status, "done");
    assertEndedByDeparture(liveRow());
    assertClassUntouched();

    assert.equal(await sweep.checkLectureForDepartedTeacher(LECTURE, new Date(now.getTime() + 1_000)), null, "throttled");
    assert.equal(await sweep.checkLectureForDepartedTeacher(null, now), null, "a session without a lecture");
});

// ---- Jibri still running: the start guard ----------------------------------------------------

test("Jibri still streaming the left class: another lecture cannot ride the stream; the same class can", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const now = later();

    await departed(now);
    assert.equal((await runSweep(now))[0].result.status, "done");
    assert.equal(jibri.running, true, "Jibri was not stopped");
    assert.equal(yt.streamActive, true);

    // Another class of the same teacher: refused while the stream is active.
    const blocked = await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "unlisted" }));

    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, "YOUTUBE_STREAM_IN_USE");
    assert.equal(active(db.lives.filter(r => r.lectureId === LECTURE_2)).length, 0, "nothing started");

    // A failed stream lookup refuses too (never assumed inactive).
    yt.streamGate = () => Promise.reject(new Error("YouTube is down"));
    const unknown = await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "unlisted" }));

    assert.equal(unknown.status, 503);
    assert.equal(unknown.data.code, "YOUTUBE_STREAM_CHECK_FAILED");
    yt.streamGate = null;

    // The same class (its teacher came back): may ride its own classroom's stream.
    const page = teacherPage();
    const back = await quiet(() => page.goLive("unlisted"));

    assert.equal(back.status, 200, JSON.stringify(back.data));
    assert.equal(back.data.alreadyStreaming, true, "rides the running Jibri");
    assert.equal(jibri.starts, 1, "no second Jibri");
});

test("Jibri stopped (stream inactive) or the left class's session ended: other lectures may start again", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const now = later();

    await departed(now);
    await runSweep(now);

    // Jibri ended (students left, or someone stopped it): YouTube reports the stream inactive.
    jibri.running = false;
    yt.streamActive = false;
    assert.equal((await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "unlisted" }))).status, 200);

    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const now2 = later();

    await departed(now2);
    await runSweep(now2);

    // Stream still active, but the left class's session has ended: as before
    // the departure stop, an ended session no longer blocks.
    sessionOf().isActive = false;
    const other = await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "unlisted" }));

    assert.notEqual(other.data.code, "YOUTUBE_STREAM_IN_USE");
});

// ---- instrumentation.ts: the sweeper's only startup path -------------------------------

// The production Node.js case loads the sweeper with a native import(), which
// webpack resolves in Next.js but this test runner cannot without a file
// extension: it is covered by the source check below and by
// canRunIntervalSweeper / startTeacherDepartureSweeper above.
test("instrumentation: Edge, dev, the build and unknown runtimes never load or start the sweeper", async () => {
    const { register } = require(path.join(root, "instrumentation.ts"));
    const keys = ["NEXT_RUNTIME", "NODE_ENV", "NEXT_PHASE", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME"];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const running = () => Boolean(globalThis.slTeacherDepartureSweeper);
    const setEnv = env => keys.forEach(key => {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
    });

    sweep.stopTeacherDepartureSweeper();

    try {
        for (const env of [
            { NEXT_RUNTIME: "edge", NODE_ENV: "production" },
            { NEXT_RUNTIME: "nodejs", NODE_ENV: "development" },
            { NEXT_RUNTIME: "nodejs", NODE_ENV: "production", NEXT_PHASE: "phase-production-build" },
            {}
        ]) {
            setEnv(env);
            // Resolves without importing anything (an import would reject here).
            await register();
            assert.equal(running(), false, JSON.stringify(env));
        }
    } finally {
        setEnv(saved);
        sweep.stopTeacherDepartureSweeper();
    }
});

test("instrumentation: the Node-only import sits inside the constant NEXT_RUNTIME / NODE_ENV branch", () => {
    // Next.js compiles instrumentation.ts for Edge too, with these env values
    // replaced by literals; only an import inside such an `if` is dropped
    // there. Outside it, the Edge build must resolve Node's `crypto` (through
    // lib/youtube-crypto.ts) and fails: "Module not found: Can't resolve 'crypto'".
    const code = require("node:fs").readFileSync(path.join(root, "instrumentation.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const branch = 'if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {';
    const start = code.indexOf(branch);
    const importAt = code.indexOf('await import("./lib/teacher-departure-sweep")');

    assert.ok(start >= 0, "the guarded branch exists");
    assert.ok(importAt > start, "the import is inside it");
    assert.equal((code.match(/import\(/g) || []).length, 1, "one dynamic import, no other");
    assert.doesNotMatch(code, /^import /m, "no static import (it would be compiled for Edge)");
    assert.doesNotMatch(code, /NEXT_RUNTIME !== /, "no early-return form");
});

test("concurrent processing from several requests and processes: one completion, one TEACHER_LEFT, the others busy or skipped", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));

    const now = later(10 * 60_000);

    await departed(now);

    const runs = await quiet(() => Promise.all([
        sweep.sweepDepartedTeachers(now),
        sweep.checkLectureForDepartedTeacher(LECTURE, now),
        lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, now),
        lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, now)
    ]));
    const statuses = runs.map(r => (Array.isArray(r) ? r[0]?.result.status : r?.status));

    assert.equal(statuses.filter(s => s === "done").length, 1, JSON.stringify(statuses));
    for (const row of [liveRow(), recordingRow()]) {
        assertEndedByDeparture(row);
        assert.equal(completions(row.broadcastId).length, 1);
    }
});

// ---- Restarted features: an old departure never stops them --------------------------------

// The tab closed `agoMs` ago (real time), after the active features were started.
async function closedTabAgo(agoMs) {
    const closedAt = new Date(Date.now() - agoMs);

    for (const row of [...db.lives, ...db.recordings]) row.createdAt = row.generationStartedAt = new Date(closedAt.getTime() - 60_000);
    await closeTab(closedAt);
    return closedAt;
}

// The departure's next check is due and its resend cooldown has passed.
function cooldownPassed() {
    for (const row of [...db.lives, ...db.recordings]) {
        if (row.autoStopAttemptedAt) row.autoStopAttemptedAt = new Date(row.autoStopAttemptedAt.getTime() - 61_000);
        row.autoStopCheckedAt = new Date(Date.now() - 61_000);
    }
}

const startLive = () => quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" }));
const startRecording = () => quiet(() => post(routes.recordingStart, { lectureId: LECTURE, privacy: "unlisted" }));

test("restart after an unconfirmed departure transition: never reuses that broadcast, even 60 s later; after YouTube confirms its end, a NEW broadcast", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = await closedTabAgo(20_000);
    const row = liveRow();
    const id = row.broadcastId;

    yt.transitionErrors.set(id, new Error("YouTube is down"));
    assert.equal((await runSweep(new Date()))[0].result.status, "pending");
    assert.ok(row.completeRequestedAt instanceof Date, "protected before the request was sent");
    await presence.registerTeacherPage(sessionOf().id, "page-back-1", new Date());

    // Within 60 s: refused by the departure gate.
    assert.equal((await startLive()).data.code, "YOUTUBE_DEPARTURE_STOP_PENDING");

    // 60 s later YouTube still reports it live: still never reused (no time limit).
    yt.transitionErrors.delete(id);
    cooldownPassed();
    yt.transitionErrors.set(id, new Error("YouTube is down"));

    for (const start of [startLive, startRecording]) {
        const refused = await start();

        assert.equal(refused.status, 409, JSON.stringify(refused.data));
        assert.equal(refused.data.code, "YOUTUBE_COMPLETE_PENDING");
    }
    assert.equal(row.version, 0, "not reused");

    // The departure's retry is answered: ended on YouTube, protection cleared.
    yt.transitionErrors.delete(id);
    cooldownPassed();
    assert.equal((await runSweep(new Date()))[0].result.status, "done");
    assertEndedByDeparture(row);
    assert.equal(row.completeRequestedAt, null);

    // Now the restart gets a NEW broadcast: an old request names the old ID only.
    const restart = await startLive();

    assert.equal(restart.status, 200, JSON.stringify(restart.data));
    assert.equal(db.lives.length, 2);
    assert.notEqual(liveRow().broadcastId, id);
    assert.ok(liveRow().createdAt > closedAt);

    for (let i = 0; i < 2; i++) {
        cooldownPassed();
        assert.deepEqual((await runSweep(new Date()))[0].result, { status: "skipped", reason: "no-active-features" });
    }
    assert.equal(completions(liveRow().broadcastId).length, 0);
});

test("a Live never shares an old Recording's broadcast while a complete request for it is unconfirmed", async () => {
    reset();
    await quiet(() => teacherPage().record());

    await closedTabAgo(20_000);
    const recording = recordingRow();
    const id = recording.broadcastId;

    yt.transitionErrors.set(id, new Error("YouTube is down"));
    await runSweep(new Date());
    cooldownPassed();

    // The teacher comes back and goes Live (Unlisted), which would ride the recording's broadcast.
    const live = await startLive();

    assert.equal(live.status, 409, JSON.stringify(live.data));
    assert.equal(live.data.code, "YOUTUBE_COMPLETE_PENDING");
    assert.equal(db.lives.length, 0, "no Live row on the protected broadcast");
    assert.equal(active(db.recordings).length, 1, "the recording is still being stopped");
});

test("a closed row reactivated by a start (one row per broadcast) carries no earlier departure stop: no false notice later", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));

    // An earlier generation of the Live was ended by a departure stop.
    Object.assign(liveRow(), {
        status: "COMPLETE", endedAt: new Date(), stopReason: "TEACHER_LEFT",
        autoStopAttemptedAt: new Date(), autoStopError: null, autoStopSendCount: 3, autoStopLastError: "transition: HTTP 500"
    });
    page.isLive = false;

    // Live again on the same (shared) broadcast: the row is reactivated.
    assert.equal((await startLive()).status, 200);
    const row = liveRow();

    assert.equal(db.lives.length, 1);
    assert.equal(active([row]).length, 1);
    assert.equal(row.stopReason, null, "the old stop reason does not come back");
    assert.equal(row.autoStopAttemptedAt, null);
    assert.equal(row.autoStopSendCount, 0);
    assert.equal(row.autoStopLastError, null);
    assert.ok(row.generationStartedAt instanceof Date);

    // The teacher's own Stop then: never a departure reason.
    page.isLive = true;
    await quiet(() => page.stopLive());
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.stopReason ?? null, null);
});

test("restart after the teacher's own Stop of the pending feature: a new row, untouched by the old departure's retries", async () => {
    reset();
    const page = teacherPage({ isRecording: false, isLive: false });

    await quiet(() => page.goLive("unlisted"));
    await closedTabAgo(20_000);
    yt.transitionErrors.set(liveRow().broadcastId, new Error("YouTube is down"));
    await runSweep(new Date());
    yt.transitionErrors.delete(liveRow().broadcastId);

    await quiet(() => page.stopLive());
    assert.equal(liveRow().stopReason ?? null, null, "the teacher's Stop: no departure reason");

    assert.equal((await startLive()).status, 200);
    const restarted = liveRow();

    for (let i = 0; i < 3; i++) {
        cooldownPassed();
        assert.equal((await runSweep(new Date()))[0].result.reason, "no-active-features");
    }

    assert.equal(active([restarted]).length, 1, "still active");
    assert.equal(restarted.stopReason ?? null, null);
});

test("restart within the 15 s window: the start is the teacher's activity, the departure is cancelled, the reused row is never stopped", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await closedTabAgo(3_000);

    const restart = await startLive();

    assert.equal(restart.status, 200, JSON.stringify(restart.data));
    assert.equal(liveRow().version, 1, "the active row was reused (a new generation)");
    assert.equal(presence.departureState(sessionOf(), new Date()), "cancelled");

    assert.deepEqual((await runSweep(new Date(Date.now() + 10 * 60_000)))[0].result, { status: "skipped", reason: "departure-cancelled" });
    assert.equal(active(db.lives).length, 1);
    assert.equal(completions(liveRow().broadcastId).length, 0);
});

test("generation guard: a row reused behind the departure's back (version changed) is never marked, sent for or closed", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await closedTabAgo(20_000);

    // The row is reused (new generation) while the departure is looking it up.
    yt.getGate = async () => {
        liveRow().version += 1;
        yt.getGate = null;
    };

    const [{ result }] = await runSweep(new Date());

    assert.equal(result.status, "pending");
    assert.equal(completions(liveRow().broadcastId).length, 0, "no transition for a restarted feature");
    assert.equal(liveRow().autoStopAttemptedAt ?? null, null, "nothing written on it");
    assert.equal(active(db.lives).length, 1);

    // Already complete on YouTube, but reused meanwhile: not closed either.
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await closedTabAgo(20_000);
    yt.autoStop(liveRow().broadcastId, new Date());
    yt.getGate = async () => {
        liveRow().version += 1;
        yt.getGate = null;
    };
    await runSweep(new Date());
    assert.equal(active(db.lives).length, 1, "a restarted row is never closed by the old departure");
});

test("concurrent start and departure processing: never a restarted feature stopped, whichever runs first", async () => {
    for (let round = 0; round < 5; round++) {
        reset();
        await quiet(() => teacherPage().goLive("unlisted"));

        const closedAt = await closedTabAgo(20_000);
        const oldRow = liveRow();

        const [start] = await Promise.all([startLive(), runSweep(new Date())]);

        assert.ok(start.status === 200 || start.status === 409, String(start.status));

        // Whatever happened, more retries never touch a row created after the departure.
        for (let i = 0; i < 2; i++) {
            cooldownPassed();
            await runSweep(new Date());
        }

        for (const row of db.lives.filter(r => r.createdAt > closedAt)) {
            assert.notEqual(row.status, "COMPLETE", "a restarted Live is never stopped");
            assert.equal(row.stopReason ?? null, null);
        }

        assert.ok(oldRow.status === "COMPLETE", "the old Live is ended");
        assert.ok(start.status === 409 || db.lives.length === 2, "a start after the stop made a new row");
    }
});
