/*
 * Teacher departure across BOTH features and the one Jibri stream; the
 * teacher's return; who may stop Jibri.
 *
 *   npm run test:youtube
 *
 * - The departure (15 s after a confirmed tab close) ends Recording AND Live:
 *   one shared broadcast completed once, separate broadcasts each completed;
 *   partial success is resumed for the remaining broadcast only.
 * - Stopping one feature never stops Jibri or the other feature.
 * - The returning page (components/Jitsi/teacher-return-sync.ts): departure
 *   notices first (they process a departure not processed yet), THEN the
 *   Recording status: never a stale "Stop Recording" for a Recording the
 *   departure just ended.
 * - A Jibri stop after a late YouTube confirmation needs the SERVER's word
 *   that nothing of the session is still active (a stale page view never
 *   starves the other feature).
 * - The server itself cannot stop Jibri (no Jitsi / Jibri control in this
 *   code base): the departure says so (jibriMayStillRun), never claims it.
 *
 * Real controller, routes, lifecycle, sweep and notices against
 * youtube-fakes.cjs. Nothing contacts YouTube, Jitsi, Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");

const { TEACHER, LECTURE, LECTURE_2, db, yt, routes, reset, post, quiet, active, completions, youtubeRequest } = fakes;

const root = path.resolve(__dirname, "..", "..");
const sweep = require(path.join(root, "lib/teacher-departure-sweep.ts"));
const lifecycle = require(path.join(root, "lib/youtube-feature-lifecycle.ts"));
const departureRoute = require(path.join(root, "app/api/sessions/[id]/teacher-departure/route.ts"));
const recordingStatusRoute = require(path.join(root, "app/api/youtube/lecture/recording/status/route.ts"));
const { createYouTubeStreamController } = require(path.join(root, "components/Jitsi/youtube-stream-controller.ts"));
const { parseDepartureNotices } = require(path.join(root, "components/Jitsi/teacher-departure-notice.ts"));
const { syncTeacherYouTubeState } = require(path.join(root, "components/Jitsi/teacher-return-sync.ts"));

const CONFIRM_MS = 15_000;

// ---- Helpers --------------------------------------------------------------

const liveRow = () => db.lives[db.lives.length - 1];
const recordingRow = () => db.recordings[db.recordings.length - 1];
const currentSession = (lectureId = LECTURE) => db.sessions.find(s => s.lectureId === lectureId && s.isActive);

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

// GET /api/sessions/[id]/teacher-departure, parsed as the page parses it.
async function loadNotices(sessionId = currentSession().id) {
    const response = await quiet(() => departureRoute.GET(new Request("http://localhost/api"), { params: { id: sessionId } }));
    const body = await response.json();

    return response.ok && body.success ? parseDepartureNotices(body.data) : null;
}

// GET /api/youtube/lecture/recording/status, reduced as the page reduces it.
async function loadRecordingStatus(lectureId = LECTURE) {
    const response = await quiet(() => recordingStatusRoute.GET(new Request("http://localhost/api?lectureId=" + lectureId)));
    const data = await response.json();

    return data.success ? data.isRecording === true : null;
}

// The real page's server check before a late-confirmation Jibri stop.
async function serverHasNoActiveFeature() {
    const notices = await loadNotices();

    return Boolean(notices && notices.sessionActive && notices.activeFeatures.length === 0);
}

// A teacher page: the real controller on the real routes, a fake Jitsi, a manual timer.
function page({ lectureId = LECTURE, confirm = serverHasNoActiveFeature } = {}) {
    const timers = [];
    const jitsi = { starts: [], stops: 0 };
    const changes = [];

    const controller = createYouTubeStreamController({
        startFeature: (feature, { privacy }) => feature === "recording"
            ? post(routes.recordingStart, { lectureId, privacy: "unlisted" })
            : post(routes.liveStart, { lectureId, privacy }),
        abortStart: (feature, body) => post(routes.startAbort, { lectureId, feature, ...body }),
        stopFeature: feature => post(feature === "recording" ? routes.recordingStop : routes.liveStop, { lectureId }),
        startJibri: (_key, _broadcastId, feature) => { jitsi.starts.push(feature); },
        stopJibri: () => { jitsi.stops += 1; },
        ...(confirm ? { confirmNoActiveFeature: confirm } : {}),
        schedule: (fn, ms) => {
            const timer = { fn, ms, done: false };
            timers.push(timer);
            return () => { timer.done = true; };
        }
    });

    controller.subscribe((_state, change) => changes.push(change));

    return {
        controller, jitsi, changes,
        state: () => controller.getState(),
        jibriOn: () => { yt.streamActive = true; controller.onStreamStatus({ on: true }); },
        async startConfirmed(feature, privacy) {
            const pending = controller.start(feature, { privacy });
            await settle();
            if (controller.getState()[feature] === "starting") this.jibriOn();
            return pending;
        }
    };
}

// Recording + Live: one shared Unlisted broadcast (Case A) or two broadcasts (Case B).
async function bothFeatures(caseName) {
    const p = page();

    await quiet(() => p.startConfirmed("recording"));
    await quiet(() => p.startConfirmed("live", caseName === "shared" ? "unlisted" : "public"));

    assert.equal(p.state().recording, "on");
    assert.equal(p.state().live, "on");
    assert.equal(p.jitsi.starts.length, 1, "ONE Jibri stream for both features");

    if (caseName === "shared") assert.equal(liveRow().broadcastId, recordingRow().broadcastId);
    else assert.notEqual(liveRow().broadcastId, recordingRow().broadcastId);

    return p;
}

// The teacher closed the classroom tab `agoMs` ago (as the signal route records it).
function closedTabAgo(agoMs) {
    const closedAt = new Date(Date.now() - agoMs);

    Object.assign(currentSession(), {
        teacherDepartureAt: closedAt, teacherDeparturePageId: "page-closed-1", teacherActiveAfterDepartureAt: null
    });
    for (const row of [...db.lives, ...db.recordings]) {
        if (row.createdAt >= closedAt) row.createdAt = row.generationStartedAt = new Date(closedAt.getTime() - 60_000);
    }
}

const sweepNow = async () => (await quiet(() => sweep.sweepDepartedTeachers(new Date())))[0]?.result;

function departureTimePassed() {
    for (const row of [...db.lives, ...db.recordings]) {
        if (row.autoStopAttemptedAt) row.autoStopAttemptedAt = new Date(row.autoStopAttemptedAt.getTime() - 61_000);
        if (row.autoStopCheckedAt) row.autoStopCheckedAt = new Date(row.autoStopCheckedAt.getTime() - 61_000);
    }
}

// A fresh page for the teacher's return, synchronised as the real page does.
async function returningPage() {
    const p = page();
    const notices = await syncTeacherYouTubeState({
        loadNotices: () => loadNotices(),
        loadRecordingStatus: () => loadRecordingStatus(),
        controller: () => p.controller,
        cancelled: () => false
    });

    return { p, notices };
}

// ---- Departure: both features ------------------------------------------------------

test("1 + 4. departure after the 15 s window, separate broadcasts: BOTH features end, each broadcast completed once; Jibri is never claimed stopped", async () => {
    reset();
    await bothFeatures("separate");

    const recordingId = recordingRow().broadcastId;
    const liveId = liveRow().broadcastId;

    closedTabAgo(CONFIRM_MS + 5_000);
    const result = await sweepNow();

    assert.equal(result.status, "done", JSON.stringify(result));
    assert.deepEqual(result.stopped.sort(), ["live", "recording"]);
    assert.equal(result.jibriMayStillRun, true, "the server cannot stop Jibri: reported, never claimed");
    assert.equal(completions(recordingId).length, 1);
    assert.equal(completions(liveId).length, 1);
    assert.equal(recordingRow().status, "COMPLETE");
    assert.equal(liveRow().status, "COMPLETE");
    assert.equal(recordingRow().stopReason, "TEACHER_LEFT");
    assert.equal(liveRow().stopReason, "TEACHER_LEFT");
});

test("2. the teacher comes back within the 15 s window (a refresh): the departure is cancelled, both features stay active", async () => {
    reset();
    await bothFeatures("separate");

    closedTabAgo(5_000);
    const notices = await loadNotices(); // the returning page asking = teacher activity

    assert.deepEqual(notices.activeFeatures.sort(), ["live", "recording"]);

    // Long after the window: the sweeper still finds the departure cancelled.
    const later = new Date(Date.now() + CONFIRM_MS + 60_000);
    const results = await quiet(() => sweep.sweepDepartedTeachers(later));

    assert.ok(!results.some(r => r.result?.status === "done" || r.result?.status === "pending"), JSON.stringify(results));
    assert.equal(active([recordingRow(), liveRow()]).length, 2);
    assert.equal(yt.calls.filter(c => c.startsWith("transition:") && c.endsWith(":complete")).length, 0, "nothing completed");
});

test("3. departure, one SHARED broadcast (Recording + Unlisted Live): completed exactly once, both rows end", async () => {
    reset();
    await bothFeatures("shared");

    const id = recordingRow().broadcastId;

    closedTabAgo(CONFIRM_MS + 5_000);
    const result = await sweepNow();

    assert.equal(result.status, "done", JSON.stringify(result));
    assert.equal(completions(id).length, 1, "one transition for both features");
    assert.equal(recordingRow().status, "COMPLETE");
    assert.equal(liveRow().status, "COMPLETE");
});

test("9 + 10. partial success: one broadcast ends, the other times out (pending); the retry completes ONLY the remaining one", async () => {
    reset();
    await bothFeatures("separate");

    const recordingId = recordingRow().broadcastId;
    const liveId = liveRow().broadcastId;

    yt.transitionErrors.set(liveId, new youtubeRequest.YouTubeRequestTimeoutError("timeout"));
    closedTabAgo(CONFIRM_MS + 5_000);
    const first = await sweepNow();

    assert.equal(first.status, "pending");
    assert.deepEqual(first.stopped, ["recording"]);
    assert.deepEqual(first.pending, [{ feature: "live", reason: "timeout" }]);
    assert.equal(recordingRow().status, "COMPLETE");
    assert.equal(active([liveRow()]).length, 1, "not claimed stopped");

    yt.transitionErrors.clear();
    departureTimePassed();
    const retry = await sweepNow();

    assert.equal(retry.status, "done", JSON.stringify(retry));
    assert.equal(completions(recordingId).length, 1, "the finished broadcast is not asked again");
    assert.equal(completions(liveId).length, 2, "the remaining one is retried");
    assert.equal(liveRow().status, "COMPLETE");
});

// ---- One feature stops, the other and Jibri continue -------------------------------------

test("5. shared broadcast: Stop Live leaves Recording and Jibri running (no YouTube call)", async () => {
    reset();
    const p = await bothFeatures("shared");
    const outcome = await quiet(() => p.controller.stop("live"));

    assert.equal(outcome.ok, true, JSON.stringify(outcome.data));
    assert.equal(outcome.data.stopJibri, false);
    assert.equal(p.jitsi.stops, 0, "Jibri keeps streaming for the Recording");
    assert.equal(p.state().recording, "on");
    assert.equal(active([recordingRow()]).length, 1);
    assert.equal(completions(recordingRow().broadcastId).length, 0);
});

test("6 + 7. separate broadcasts: stopping either feature completes only its own broadcast; the other and Jibri keep running", async () => {
    for (const stopped of ["live", "recording"]) {
        reset();
        const p = await bothFeatures("separate");
        const other = stopped === "live" ? "recording" : "live";
        const otherRow = other === "live" ? liveRow() : recordingRow();
        const ownRow = stopped === "live" ? liveRow() : recordingRow();
        const outcome = await quiet(() => p.controller.stop(stopped));

        assert.equal(outcome.ok, true, JSON.stringify(outcome.data));
        assert.equal(outcome.data.stopJibri, false, `${stopped}: the server keeps Jibri for ${other}`);
        assert.equal(p.jitsi.stops, 0);
        assert.equal(p.state()[other], "on");
        assert.equal(completions(ownRow.broadcastId).length, 1);
        assert.equal(completions(otherRow.broadcastId).length, 0);
        assert.equal(active([otherRow]).length, 1);
    }
});

test("8. both features stopped (either order, shared or separate): Jibri stops exactly once, after the last one", async () => {
    for (const caseName of ["shared", "separate"]) {
        reset();
        const p = await bothFeatures(caseName);

        await quiet(() => p.controller.stop("live"));
        assert.equal(p.jitsi.stops, 0);
        await quiet(() => p.controller.stop("recording"));
        assert.equal(p.jitsi.stops, 1, caseName);

        // Jitsi confirms the stop (this page asked): no "stopped unexpectedly" notice, nothing else changes.
        p.controller.onStreamStatus({ on: false });
        p.controller.onStreamStatus({ on: false }); // 12. a duplicate
        assert.equal(p.jitsi.stops, 1);
        assert.equal(p.changes.filter(c => c.type === "jibri-stopped").length, 0);
    }
});

// ---- Jibri stop decisions ------------------------------------------------------------------

test("11. the server's check before a Jibri stop fails or is refused: nothing is stopped (and nothing claims it was)", async () => {
    for (const confirm of [async () => { throw new Error("network"); }, async () => false]) {
        reset();
        const p = page({ confirm });

        await quiet(() => p.startConfirmed("live", "unlisted"));
        yt.transitionAnswer = id => ({ id, status: { lifeCycleStatus: "live" } });
        await quiet(() => p.controller.stop("live")); // unconfirmed
        yt.transitionAnswer = null;
        yt.autoStop(liveRow().broadcastId, new Date());
        await quiet(() => fakes.getLiveSnapshot(LECTURE, "teacher"));
        p.controller.serverReport("live", false); // YouTube confirmed late

        await settle();
        assert.equal(p.state().live, "off");
        assert.equal(p.jitsi.stops, 0, "not stopped without the server's confirmation");
    }
});

test("13. a stale page view never stops Jibri while the server still has the other feature active (late confirmation)", async () => {
    reset();
    // This page started Live; the Recording was started from ANOTHER tab (this page never heard of it).
    const p = page();

    await quiet(() => p.startConfirmed("live", "public"));
    const otherTab = page();

    otherTab.controller.onStreamStatus({ on: true });
    await quiet(() => otherTab.controller.start("recording"));
    await settle();
    assert.equal(active([recordingRow()]).length, 1, "Recording active on the server");
    assert.equal(p.state().recording, "off", "this page does not know");

    yt.transitionAnswer = id => ({ id, status: { lifeCycleStatus: "live" } });
    await quiet(() => p.controller.stop("live"));
    yt.transitionAnswer = null;
    yt.autoStop(liveRow().broadcastId, new Date());
    await quiet(() => fakes.getLiveSnapshot(LECTURE, "teacher"));
    p.controller.serverReport("live", false);
    await quiet(settle);

    assert.equal(p.state().live, "off");
    assert.equal(p.jitsi.stops, 0, "the server reports the Recording active: Jibri keeps streaming");

    // Without the Recording, the same late confirmation stops Jibri once.
    reset();
    const q = page();

    await quiet(() => q.startConfirmed("live", "public"));
    yt.transitionAnswer = id => ({ id, status: { lifeCycleStatus: "live" } });
    await quiet(() => q.controller.stop("live"));
    yt.transitionAnswer = null;
    yt.autoStop(liveRow().broadcastId, new Date());
    await quiet(() => fakes.getLiveSnapshot(LECTURE, "teacher"));
    q.controller.serverReport("live", false);
    await quiet(settle);
    q.controller.serverReport("live", false);
    await quiet(settle);

    assert.equal(q.jitsi.stops, 1, "stopped exactly once");
});

// ---- The teacher's return ----------------------------------------------------------------------

test("14. return after the departure was processed: both controls off; the orphaned Jibri stop is no longer blocked", async () => {
    reset();
    await bothFeatures("separate");
    closedTabAgo(CONFIRM_MS + 5_000);
    await sweepNow();

    const { p, notices } = await returningPage();

    assert.deepEqual(notices.activeFeatures, []);
    assert.equal(p.state().recording, "off");
    assert.equal(p.state().live, "off");

    // The Jibri stream still running in this conference: stopped once on the server's confirmation.
    p.controller.armOrphanStreamStop(serverHasNoActiveFeature);
    p.jibriOn();
    await quiet(settle);
    assert.equal(p.jitsi.stops, 1);
});

test("14b. ROOT CAUSE: departure processed only by the return (no sweeper ran): status-then-notices restored a stale Recording; notices-then-status does not", async () => {
    // The old order, reproduced: the status answer was read before the departure processing.
    reset();
    await bothFeatures("separate");
    closedTabAgo(CONFIRM_MS + 5_000);

    const stale = page();
    const statusFirst = await loadRecordingStatus();     // read BEFORE the departure ran

    await loadNotices();                                 // the return processes the departure
    stale.controller.serverReport("recording", statusFirst);
    assert.equal(statusFirst, true);
    assert.equal(recordingRow().status, "COMPLETE", "the departure ended it meanwhile");
    assert.equal(stale.state().recording, "restored", "the stale 'Stop Recording'");

    // The fixed order.
    reset();
    await bothFeatures("separate");
    closedTabAgo(CONFIRM_MS + 5_000);

    const { p, notices } = await returningPage();

    assert.equal(recordingRow().status, "COMPLETE");
    assert.deepEqual(notices.activeFeatures, []);
    assert.equal(p.state().recording, "off", "Record shown, matching the server");
    assert.equal(p.state().live, "off");
});

test("15. return while the departure stop is still pending: the pending feature is shown active (Stop available), the ended one off", async () => {
    reset();
    await bothFeatures("separate");
    yt.transitionErrors.set(recordingRow().broadcastId, new youtubeRequest.YouTubeRequestTimeoutError("timeout"));
    closedTabAgo(CONFIRM_MS + 5_000);
    await sweepNow();
    yt.broadcasts.get(recordingRow().broadcastId).lifecycle = "live";

    const { p, notices } = await returningPage();

    assert.deepEqual(notices.activeFeatures, ["recording"]);
    assert.deepEqual(notices.pending.map(n => n.feature), ["recording"]);
    assert.equal(p.state().recording, "restored", "Stop Recording: genuinely still active / pending");
    assert.equal(p.state().live, "off");
});

// ---- Unchanged behaviour --------------------------------------------------------------------

test("16. guarded never-live cleanup still runs on departure (both features, one never went live)", async () => {
    reset();
    yt.refuseNeverLiveComplete = true;
    const p = page();

    // Recording's start never confirmed by Jibri: its broadcast never went live (ready).
    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE, privacy: "unlisted" }));
    const id = recordingRow().broadcastId;

    assert.equal(yt.broadcasts.get(id).lifecycle, "ready");
    closedTabAgo(CONFIRM_MS + 5_000);
    const result = await sweepNow();

    assert.equal(result.status, "done", JSON.stringify(result));
    assert.ok(!yt.broadcasts.has(id), "deleted");
    assert.equal(recordingRow().stopReason ?? null, null);
    assert.equal(p.jitsi.stops, 0);
});

test("17. End Session with both features: unchanged (both ended, the page stops Jibri once when told the session ended)", async () => {
    reset();
    const p = await bothFeatures("separate");
    const result = await quiet(() => lifecycle.endYouTubeFeaturesForLecture(TEACHER, LECTURE));

    assert.deepEqual(result, { status: "done", closed: 2 });
    p.controller.sessionEnded();
    p.controller.sessionEnded();
    assert.equal(p.jitsi.stops, 1);
    assert.equal(p.state().recording, "off");
    assert.equal(p.state().live, "off");
});

test("18. another classroom is never affected: a departure and stops in one lecture leave the other lecture's page and rows alone", async () => {
    reset();
    const other = page({ lectureId: LECTURE_2 });

    other.controller.onStreamStatus({ on: true });
    const p = await bothFeatures("separate");

    closedTabAgo(CONFIRM_MS + 5_000);
    const results = await quiet(() => sweep.sweepDepartedTeachers(new Date()));

    assert.deepEqual(results.map(r => r.lectureId ?? LECTURE).filter(id => id === LECTURE_2), []);
    await quiet(() => p.controller.stop("live"));
    assert.equal(other.jitsi.stops, 0);
    assert.equal(other.state().jibri, "on");
    assert.equal(db.recordings.filter(r => r.lectureId === LECTURE_2).length, 0);
});

test("the classroom page itself: the Recording status is loaded only through syncTeacherYouTubeState (after the notices), and the controller gets the server check", () => {
    const source = require("node:fs").readFileSync(path.join(root, "components/Jitsi/JitsiClassroom.tsx"), "utf8");

    assert.equal((source.match(/\/api\/youtube\/lecture\/recording\/status/g) || []).length, 1, "one Recording status request in the page");
    assert.match(source, /const loadRecordingStatus = async \(\) => \{[\s\S]*?\/api\/youtube\/lecture\/recording\/status/);
    assert.match(source, /await syncTeacherYouTubeState\(\{\s*loadNotices,\s*loadRecordingStatus,/);
    assert.match(source, /confirmNoActiveFeature: async \(\) => \{[\s\S]*?notices\.activeFeatures\.length === 0/);
});
