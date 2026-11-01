/*
 * Teacher-departure stop: the teacher's return to the classroom after closing
 * its tab.
 *
 *   npm run test:youtube
 *
 * - GET /api/sessions/[id]/teacher-departure: the returning page asking is
 *   teacher activity (within 15 s of the tab-close signal it cancels it: a
 *   refresh); a confirmed departure not processed yet is processed first.
 *   Then: unacknowledged CONFIRMED stops (stopReason TEACHER_LEFT) of this
 *   session only, pending stops apart, never to students or another teacher,
 *   never another session's rows, never a manual Stop or an unrelated end.
 * - POST the same: durable, idempotent acknowledgement of confirmed stops only.
 * - The returning page's orphaned-stream stop (youtube-stream-controller.ts
 *   armOrphanStreamStop): Jibri stopped once, only when Jitsi reports the
 *   stream on, nothing is starting / active, and the server re-confirmed it.
 *
 * Real routes, lifecycle, sweep and controller against youtube-fakes.cjs
 * (Prisma, YouTube, auth). Nothing here contacts YouTube, Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");

const { TEACHER, LECTURE, CLASS, db, yt, jibri, session, reset, teacherPage, quiet, active, routes, post } = fakes;

const root = path.resolve(__dirname, "..", "..");
const sweep = require(path.join(root, "lib/teacher-departure-sweep.ts"));
const departureRoute = require(path.join(root, "app/api/sessions/[id]/teacher-departure/route.ts"));
const { createYouTubeStreamController } = require(path.join(root, "components/Jitsi/youtube-stream-controller.ts"));
const { parseDepartureNotices, canStopOrphanStream, describeStoppedNotice } = require(path.join(root, "components/Jitsi/teacher-departure-notice.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const CONFIRM_MS = 15_000;

// ---- Helpers --------------------------------------------------------------

const currentSession = () => db.sessions.find(s => s.lectureId === LECTURE && s.isActive);

// The teacher closed the classroom tab `agoMs` ago (the signal as the route
// records it), after the features were started.
function closedTabAgo(agoMs) {
    const closedAt = new Date(Date.now() - agoMs);

    Object.assign(currentSession(), {
        teacherDepartureAt: closedAt, teacherDeparturePageId: "page-closed-1", teacherActiveAfterDepartureAt: null
    });

    for (const row of [...db.lives, ...db.recordings]) {
        if (row.createdAt >= closedAt) row.createdAt = row.generationStartedAt = new Date(closedAt.getTime() - 60_000);
    }

    return closedAt;
}

// The teacher closed the tab, the 15 s window passed, then a sweep ran.
async function teacherLeftAndSwept() {
    closedTabAgo(CONFIRM_MS + 5_000);

    return (await quiet(() => sweep.sweepDepartedTeachers(new Date())))[0]?.result;
}

async function getNotices(sessionId = currentSession().id) {
    // Quiet: the request may retry a pending stop (YouTube failures are logged).
    const response = await quiet(() => departureRoute.GET(new Request("http://localhost/api"), { params: { id: sessionId } }));

    return { status: response.status, body: await response.json() };
}

async function acknowledge(body, sessionId = currentSession().id) {
    const response = await departureRoute.POST(
        new Request("http://localhost/api", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
        { params: { id: sessionId } }
    );

    return { status: response.status, body: await response.json() };
}

const idsOf = (stopped, feature) => stopped.filter(n => n.feature === feature).map(n => n.id);

// The auth fake always answers as a teacher; a student's session is refused.
function asStudent(fn) {
    const auth = require.cache[path.join(root, "lib/auth-session.ts")].exports;
    const saved = auth.requireTeacherSession;

    auth.requireTeacherSession = async () => {
        throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    };

    return Promise.resolve().then(fn).finally(() => {
        auth.requireTeacherSession = saved;
    });
}

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

// ---- Which notices ----------------------------------------------------------------

test("Live only: one confirmed Live notice, nothing about Recording", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await teacherLeftAndSwept();

    const { status, body } = await getNotices();

    assert.equal(status, 200);
    assert.equal(body.data.sessionId, currentSession().id);
    assert.deepEqual(body.data.stopped.map(n => n.feature), ["live"]);
    assert.equal(body.data.stopped[0].endedAt, db.lives[0].endedAt.toISOString());
    assert.deepEqual(body.data.pending, []);
    assert.deepEqual(body.data.activeFeatures, []);
    assert.equal(body.data.hadDepartureStop, true);
    assert.equal(body.data.sessionActive, true, "the class session is still running for students");
});

test("Recording only, and both: each confirmed feature reported once", async () => {
    reset();
    await quiet(() => teacherPage().record());
    await teacherLeftAndSwept();
    assert.deepEqual((await getNotices()).body.data.stopped.map(n => n.feature), ["recording"]);

    reset();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));
    await teacherLeftAndSwept();
    assert.deepEqual((await getNotices()).body.data.stopped.map(n => n.feature).sort(), ["live", "recording"]);
});

test("pending stop: reported apart, never as stopped; confirmed later, it moves to stopped", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const broadcastId = db.lives[0].broadcastId;

    yt.transitionErrors.set(broadcastId, new Error("YouTube is down"));
    assert.equal((await teacherLeftAndSwept()).status, "pending");

    let { body } = await getNotices();

    assert.deepEqual(body.data.stopped, []);
    assert.equal(body.data.pending.length, 1);
    assert.equal(body.data.pending[0].feature, "live");
    assert.equal(body.data.pending[0].reason, "youtube");
    assert.equal(body.data.pending[0].attemptedAt, db.lives[0].autoStopAttemptedAt.toISOString(), "when the transition was sent");
    assert.deepEqual(body.data.activeFeatures, ["live"], "still active: its stream is legitimate");
    assert.equal(body.data.hadDepartureStop, false);
    assert.equal(canStopOrphanStream(parseDepartureNotices(body.data)), false);

    // An acknowledgement of a pending row is ignored.
    assert.equal((await acknowledge({ liveIds: [db.lives[0].id] })).body.data.acknowledged, 0);

    // After the 60 s resend cooldown, the next attempt is confirmed.
    yt.transitionErrors.delete(broadcastId);
    db.lives[0].autoStopAttemptedAt = new Date(Date.now() - 61_000);
    await teacherLeftAndSwept();
    ({ body } = await getNotices());

    assert.deepEqual(body.data.pending, []);
    assert.deepEqual(body.data.stopped.map(n => n.feature), ["live"]);
});

test("expired authorization: pending with reauth-required", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    yt.getErrors.set(db.lives[0].broadcastId, new fakes.YouTubeReauthorizationRequiredError("invalid_grant"));
    await teacherLeftAndSwept();

    const { body } = await getNotices();

    assert.equal(body.data.pending[0].reason, "reauth-required");
    assert.deepEqual(body.data.stopped, []);
});

// ---- Acknowledgement ------------------------------------------------------------------

test("acknowledged once, durably: gone after a refresh; a duplicate keeps the first time", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));
    await teacherLeftAndSwept();

    const { stopped } = (await getNotices()).body.data;
    const body = { recordingIds: idsOf(stopped, "recording"), liveIds: idsOf(stopped, "live") };
    const first = await acknowledge(body);

    assert.equal(first.status, 200);
    assert.equal(first.body.data.acknowledged, 2);

    const firstAckAt = db.lives[0].stopNoticeAcknowledgedAt.getTime();

    // Page refresh: nothing to show, but the stop is still on record.
    const refreshed = (await getNotices()).body.data;

    assert.deepEqual(refreshed.stopped, []);
    assert.equal(refreshed.hadDepartureStop, true);

    const again = await acknowledge(body);

    assert.equal(again.body.data.acknowledged, 0, "idempotent");
    assert.equal(db.lives[0].stopNoticeAcknowledgedAt.getTime(), firstAckAt);
});

test("acknowledgement validation: bad body 400; unknown and manual-stop IDs ignored", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.goLive("unlisted"));
    await quiet(() => page.stopLive());

    assert.equal((await quiet(() => acknowledge("not json"))).status, 400);
    assert.equal((await quiet(() => acknowledge({ liveIds: "x" }))).status, 400);
    assert.equal((await quiet(() => acknowledge({ liveIds: Array.from({ length: 21 }, (_, i) => "id" + i) }))).status, 400);
    assert.equal((await acknowledge({ liveIds: ["nope", db.lives[0].id] })).body.data.acknowledged, 0,
        "the teacher's own Stop has no departure notice");
    assert.equal(db.lives[0].stopNoticeAcknowledgedAt ?? null, null);
});

// ---- Sessions and access ---------------------------------------------------------------------

test("a different session: its notices never mix with another session's, in either direction", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await teacherLeftAndSwept();

    const oldSession = currentSession();
    const oldNotice = (await getNotices(oldSession.id)).body.data.stopped[0];

    // A new class session replaces it (as startClassSessionForTeacher does).
    oldSession.isActive = false;
    oldSession.endedAt = fakes.now();
    db.sessions.push({
        id: "session-new", classId: CLASS, lectureId: LECTURE, isActive: true,
        startedAt: fakes.now(), endedAt: null, teacherId: TEACHER
    });

    const fresh = (await getNotices("session-new")).body.data;

    assert.deepEqual(fresh.stopped, [], "the earlier session's stop is not this session's");
    assert.equal(fresh.hadDepartureStop, false);

    // Its ID cannot be acknowledged through the new session either.
    assert.equal((await acknowledge({ liveIds: [oldNotice.id] }, "session-new")).body.data.acknowledged, 0);

    // A feature of the new session never shows under the old one.
    await quiet(() => teacherPage().goLive("unlisted"));

    const old = (await getNotices(oldSession.id)).body.data;

    assert.deepEqual(old.activeFeatures, [], "the new session's Live is not the old session's");
    assert.deepEqual(old.stopped.map(n => n.id), [oldNotice.id]);
    assert.equal(old.sessionActive, false);
});

test("students and other teachers: refused, nothing changed; students stay connected", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await teacherLeftAndSwept();

    const liveId = db.lives[0].id;

    await asStudent(async () => {
        assert.equal((await quiet(() => getNotices())).status, 401);
        assert.equal((await quiet(() => acknowledge({ liveIds: [liveId] }))).status, 401);
    });

    session.teacherId = "teacher-2";
    assert.equal((await quiet(() => getNotices())).status, 404);
    assert.equal((await quiet(() => acknowledge({ liveIds: [liveId] }))).status, 404);
    session.teacherId = TEACHER;

    assert.equal(db.lives[0].stopNoticeAcknowledgedAt ?? null, null);
    assert.equal(currentSession().isActive, true, "the class session keeps running");
    assert.deepEqual(db.attendanceCloses, [], "no student was taken out");
});

// ---- The returning page: orphaned Jibri stream ---------------------------------------------------

// The returning teacher's page: the real controller on the real routes, a fake
// Jitsi, and the orphan check wired to the real GET (as JitsiClassroom does).
function returningPage() {
    const jitsi = { starts: 0, stops: 0 };
    const confirms = [];
    const controller = createYouTubeStreamController({
        startFeature: (feature, { privacy }) => feature === "recording"
            ? post(routes.recordingStart, { lectureId: LECTURE, privacy: "unlisted" })
            : post(routes.liveStart, { lectureId: LECTURE, privacy }),
        abortStart: (feature, body) => post(routes.startAbort, { lectureId: LECTURE, feature, ...body }),
        stopFeature: feature => post(feature === "recording" ? routes.recordingStop : routes.liveStop, { lectureId: LECTURE }),
        startJibri: () => { jitsi.starts += 1; },
        stopJibri: () => { jitsi.stops += 1; jibri.running = false; yt.streamActive = false; },
        schedule: () => () => {}
    });

    const loadNotices = async () => parseDepartureNotices((await getNotices()).body.data);
    const confirm = async () => {
        const fresh = await loadNotices();
        const ok = Boolean(fresh && canStopOrphanStream(fresh));

        confirms.push(ok);
        return ok;
    };

    return {
        controller,
        jitsi,
        confirms,
        async arm() {
            const notices = await loadNotices();

            if (canStopOrphanStream(notices)) controller.armOrphanStreamStop(confirm);
            return notices;
        },
        // Jitsi reports the conference's stream running (on rejoin).
        jibriOn: () => controller.onStreamStatus({ on: true })
    };
}

test("Jibri still running after the departure stop: the returning page stops it once, after the server re-check", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await teacherLeftAndSwept();
    assert.equal(jibri.running, true, "the server could not stop Jibri");

    const page = returningPage();

    await page.arm();
    assert.equal(page.controller.orphanStopArmed(), true);
    assert.equal(page.jitsi.stops, 0, "nothing stopped before Jitsi reports the stream");

    await quiet(async () => {
        page.jibriOn();
        await settle();
    });

    assert.deepEqual(page.confirms, [true]);
    assert.equal(page.jitsi.stops, 1);
    assert.equal(page.controller.orphanStopArmed(), false);

    // A second "on" (e.g. a duplicate event) never stops twice.
    await quiet(async () => {
        page.jibriOn();
        await settle();
    });
    assert.equal(page.jitsi.stops, 1);
});

test("Jitsi never reports the stream: nothing is stopped blindly", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await teacherLeftAndSwept();

    const page = returningPage();

    await page.arm();
    await settle();

    assert.equal(page.jitsi.stops, 0);
    assert.deepEqual(page.confirms, [], "not even asked: no stream seen");
    assert.equal(page.controller.orphanStopArmed(), true, "still armed for a later report");
});

test("the teacher starts Live on return: rides the running stream, never stopped", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await teacherLeftAndSwept();

    const page = returningPage();

    await page.arm();

    let outcome;

    await quiet(async () => {
        const pending = page.controller.start("live", { privacy: "unlisted" });

        assert.equal(page.controller.orphanStopArmed(), false, "a start disarms it");
        await settle();
        page.jibriOn();
        outcome = await pending;
        await settle();
    });

    assert.equal(outcome.ok, true);
    assert.equal(page.controller.getState().live, "on");
    assert.equal(page.jitsi.stops, 0);
    assert.equal(active(db.lives).length, 1);
});

test("a feature becomes active elsewhere (another tab) before the re-check answers: not stopped", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await teacherLeftAndSwept();

    const page = returningPage();

    await page.arm();

    // Another teacher tab starts Recording: its row exists before Jibri is
    // used (the start creates it first), so the re-check sees it.
    await quiet(() => post(routes.recordingStart, { lectureId: LECTURE, privacy: "unlisted" }));

    await quiet(async () => {
        page.jibriOn();
        await settle();
    });

    assert.deepEqual(page.confirms, [false]);
    assert.equal(page.jitsi.stops, 0, "a legitimate stream is never stopped");
    assert.equal(page.controller.orphanStopArmed(), false);
});

test("restored or pending features: never armed, never stopped", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    yt.transitionErrors.set(db.lives[0].broadcastId, new Error("YouTube is down"));
    await teacherLeftAndSwept();

    const page = returningPage();
    const notices = await page.arm();

    assert.equal(notices.pending.length, 1);
    assert.equal(page.controller.orphanStopArmed(), false, "pending: the Live may still be running");

    // Armed anyway (e.g. a stale page), the restored feature still protects the stream.
    page.controller.serverReport("live", true);
    page.controller.armOrphanStreamStop(async () => true);
    page.controller.serverReport("live", true);
    assert.equal(page.controller.orphanStopArmed(), false, "an active report disarms it");

    await quiet(async () => {
        page.jibriOn();
        await settle();
    });
    assert.equal(page.jitsi.stops, 0);
    assert.equal(page.controller.getState().live, "on", "the restored Live is adopted, as before");
});

test("re-check fails or the session ended: nothing stopped", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    await teacherLeftAndSwept();

    const failing = returningPage();

    failing.controller.armOrphanStreamStop(async () => { throw new Error("offline"); });
    await quiet(async () => {
        failing.jibriOn();
        await settle();
    });
    assert.equal(failing.jitsi.stops, 0);

    const ended = returningPage();

    ended.controller.sessionEnded();
    ended.controller.armOrphanStreamStop(async () => true);
    assert.equal(ended.controller.orphanStopArmed(), false, "nothing armed after the session ended");
});

// ---- Returning: within or after the 15 s window ------------------------------------------

test("returning after 15 s with nothing processed yet (no sweeper, no students): processed first, then the notice", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    closedTabAgo(CONFIRM_MS + 5_000);
    assert.equal(active(db.lives).length, 1, "nothing ran while the teacher was away");

    const { body } = await quiet(() => getNotices());

    assert.deepEqual(body.data.stopped.map(n => n.feature), ["live"], "stopped and reported in the same request");
    assert.equal(db.lives[0].stopReason, "TEACHER_LEFT");
    assert.ok(currentSession().teacherActiveAfterDepartureAt, "the return is recorded");
});

test("returning within 15 s (a refresh or reopening the classroom): cancelled, nothing stopped, no notice", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));
    closedTabAgo(3_000);

    const { body } = await getNotices();

    assert.deepEqual(body.data.stopped, []);
    assert.deepEqual(body.data.pending, []);
    assert.deepEqual(body.data.activeFeatures.sort(), ["live", "recording"]);
    assert.equal(active(db.lives).length + active(db.recordings).length, 2);

    // Much later, the sweeper still sees a cancelled departure.
    const [{ result }] = await quiet(() => sweep.sweepDepartedTeachers(new Date(Date.now() + 10 * 60_000)));

    assert.deepEqual(result, { status: "skipped", reason: "departure-cancelled" });
});

test("Live and Recording both stopped while away: one notice naming both", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));
    closedTabAgo(CONFIRM_MS + 5_000);

    const notices = parseDepartureNotices((await quiet(() => getNotices())).body.data);
    const message = describeStoppedNotice(notices.stopped, () => "10:42");

    assert.equal(message.message, "Your YouTube Live and Recording were stopped because you closed the classroom (at 10:42).");
    assert.equal(message.liveIds.length, 1);
    assert.equal(message.recordingIds.length, 1);
});

test("YouTube auto-stopped the Live before anything ran, and a status sync closed it: no departure notice (YouTube's end, not ours)", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));

    const closedAt = closedTabAgo(CONFIRM_MS + 5_000);

    yt.autoStop(db.lives[0].broadcastId, new Date(closedAt.getTime() + 4_000));
    await quiet(() => fakes.getLiveSnapshot(LECTURE, "student"));
    assert.equal(db.lives[0].stopReason, "YOUTUBE_ENDED");

    const { body } = await quiet(() => getNotices());

    // actualEndTime is after the close, but cannot show the close caused it.
    assert.deepEqual(body.data.stopped, []);
    assert.equal(body.data.hadDepartureStop, false);
    assert.equal(db.lives[0].stopReason, "YOUTUBE_ENDED");
    assert.equal(db.lives[0].endedAt.getTime(), closedAt.getTime() + 4_000, "YouTube's end time kept");
});

test("manual Stop, or YouTube ending it before the tab closed: no departure notice", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));
    await quiet(() => page.stopLive());

    const closedAt = closedTabAgo(CONFIRM_MS + 5_000);

    // The recording's broadcast ended on YouTube before the close (a Jibri failure).
    yt.autoStop(db.recordings[0].broadcastId, new Date(closedAt.getTime() - 10_000));

    const { body } = await quiet(() => getNotices());

    assert.deepEqual(body.data.stopped, [], "neither the manual Stop nor the earlier end is the departure's");
    assert.equal(body.data.hadDepartureStop, false);
    assert.equal(db.lives[0].stopReason ?? null, null);
    assert.equal(db.recordings[0].stopReason, "YOUTUBE_ENDED");
});

test("concurrent processing across requests (two returning requests, the sweep, a student's check): one stop, both notices correct", async () => {
    reset();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));
    closedTabAgo(CONFIRM_MS + 5_000);

    const [first, second] = await quiet(() => Promise.all([
        getNotices(),
        getNotices(),
        sweep.sweepDepartedTeachers(new Date()),
        sweep.checkLectureForDepartedTeacher(LECTURE, new Date(Date.now() + 3_600_000))
    ]));

    for (const row of [db.lives[0], db.recordings[0]]) {
        assert.equal(row.stopReason, "TEACHER_LEFT");
        assert.equal(fakes.completions(row.broadcastId).length, 1, "completed once");
    }

    // A request that found the lock busy may answer before the stop finished;
    // the next one (a refresh) always has both.
    for (const answer of [first, second]) assert.equal(answer.status, 200);
    assert.deepEqual((await getNotices()).body.data.stopped.map(n => n.feature).sort(), ["live", "recording"]);
});
