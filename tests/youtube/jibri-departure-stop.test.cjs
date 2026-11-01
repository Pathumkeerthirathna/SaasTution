/*
 * The teacher's Jibri shutdown fence and the backend Jibri stop
 * (lib/jibri-shutdown-gate.ts, lib/jibri-stop-for-departure.ts) end to end
 * on the real departure lifecycle and the real start routes: the teacher's
 * page starts Recording + Live, closes the tab, the departure arms the fence
 * BEFORE it ends the features on YouTube, the worker stops (once) or
 * observes the exact classroom (a scripted fake room) and releases the
 * fence only on evidence: the room clear AND the PINNED stream idle on
 * YouTube three times over at least 2 minutes (then still watched), or an
 * administrator's audited override. The mode is the shared database control
 * (lib/jibri-fence-control.ts), the same for the app and the worker.
 *
 *   npm run test:youtube
 *
 * youtube-fakes.cjs + fake-jitsi-room.cjs: nothing contacts YouTube, Jitsi,
 * Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const util = require("node:util");

process.env.JITSI_JWT_SECRET = "test-only-secret-not-a-real-one";
// The app's own Jitsi settings: what it expects the worker's identity to be.
process.env.JITSI_DOMAIN = "meet.example.test";
process.env.JITSI_ENABLE_JWT_AUTH = "true";

const fakes = require("./youtube-fakes.cjs");
const { createFakeJitsi, decodeJwt, defaultOccupants, CONFIG, DOMAIN, STUDENT_NAME, STUDENT_JID } = require("./fake-jitsi-room.cjs");

const { LECTURE, LECTURE_2, TEACHER, db, yt, routes, reset, post, quiet, active, youtubeRequest, locks, session } = fakes;

const root = path.resolve(__dirname, "..", "..");
const sweep = require(path.join(root, "lib/teacher-departure-sweep.ts"));
const jibriStop = require(path.join(root, "lib/jibri-stop-for-departure.ts"));
const gate = require(path.join(root, "lib/jibri-shutdown-gate.ts"));
const lockLib = require(path.join(root, "lib/youtube-operation-lock.ts"));
const overrides = require(path.join(root, "services/jibri-fence-override-service.ts"));
const overrideRoute = require(path.join(root, "app/api/admin/jibri-fences/[sessionId]/override/route.ts"));
const listRoute = require(path.join(root, "app/api/admin/jibri-fences/route.ts"));
const { createJibriController } = require(path.join(root, "lib/jibri-control.ts"));
const { createYouTubeStreamController } = require(path.join(root, "components/Jitsi/youtube-stream-controller.ts"));
const { startJibriStopWorker } = require(path.join(root, "scripts/jibri-stop-worker.ts"));

const CONFIRM_MS = 15_000;
const ROOM = "saastution-class001-k9x2ab";

// ---- Helpers --------------------------------------------------------------------

const liveRow = () => db.lives[db.lives.length - 1];
const recordingRow = () => db.recordings[db.recordings.length - 1];
const sessionOf = lectureId => db.sessions.find(s => s.lectureId === lectureId && s.fixture);
const currentSession = () => sessionOf(LECTURE);

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

const FENCE_DEFAULTS = {
    jibriStopDepartureAt: null, jibriStopState: null, jibriStopAttemptedAt: null, jibriStopAttemptCount: 0,
    jibriStopLastError: null, jibriStopConfirmedAt: null, jibriStopSentAt: null, jibriStopRecorderLeftAt: null,
    jibriStopStreamInactiveAt: null, jibriStopOverrideAt: null, jibriStopOverrideBy: null, jibriStopOverrideReason: null
};

const stopConfig = require(path.join(path.resolve(__dirname, "..", ".."), "lib/jibri-stop-config.ts"));

// The control columns of a worker running with `config` and `env` (as its liveness writes them).
function workerIdentityColumns(config = CONFIG, env = process.env) {
    const identity = stopConfig.jibriWorkerIdentity(config, env);
    return {
        workerVersion: identity.workerVersion, workerJitsiDomain: identity.jitsiDomain, workerWebsocketUrl: identity.websocketUrl,
        workerMucDomain: identity.mucDomain, workerRecorderDomain: identity.recorderDomain, workerFocusJid: identity.focusJid,
        workerJwtIssuer: identity.jwtIssuer, workerJwtAudience: identity.jwtAudience, workerJwtFingerprint: identity.jwtSecretFingerprint
    };
}

// The shared control: mode "on", a READY worker that saw "on": fresh liveness,
// the app's identity, a recent sweep and a recent login to the expected server.
function controlOn(extra = {}) {
    db.control = {
        id: "default", mode: "on", modeChangedAt: new Date(), modeChangedBy: "admin-0",
        heartbeatAt: new Date(), workerStartedAt: new Date(), workerConfigId: "cfg", workerMode: "on",
        ...workerIdentityColumns(),
        sweepStartedAt: new Date(), sweepCompletedAt: new Date(), lastXmppAuthAt: new Date(), lastRoomJoinAt: null,
        lastConnectionError: null, lastConnectionErrorAt: null,
        ...extra
    };
}

function prepare() {
    reset();
    controlOn();
    stream.ingest = "none";
    Object.assign(sessionOf(LECTURE), { roomName: ROOM, jitsiDomain: DOMAIN, ...FENCE_DEFAULTS });
    Object.assign(sessionOf(LECTURE_2), { roomName: "saastution-class002-k9x2ac", jitsiDomain: DOMAIN, ...FENCE_DEFAULTS });
}

// The teacher page (real controller, real routes, fake Jitsi).
function page() {
    const jitsi = { starts: [], stops: 0 };
    const controller = createYouTubeStreamController({
        startFeature: (feature, { privacy }) => feature === "recording"
            ? post(routes.recordingStart, { lectureId: LECTURE, privacy: "unlisted" })
            : post(routes.liveStart, { lectureId: LECTURE, privacy }),
        abortStart: (feature, body) => post(routes.startAbort, { lectureId: LECTURE, feature, ...body }),
        stopFeature: feature => post(feature === "recording" ? routes.recordingStop : routes.liveStop, { lectureId: LECTURE }),
        startJibri: (_key, _broadcastId, feature) => { jitsi.starts.push(feature); },
        stopJibri: () => { jitsi.stops += 1; },
        schedule: () => () => {}
    });

    return {
        controller, jitsi,
        async startConfirmed(feature, privacy) {
            const pending = controller.start(feature, { privacy });
            await settle();
            if (controller.getState()[feature] === "starting") {
                yt.streamActive = true;
                controller.onStreamStatus({ on: true });
            }
            return pending;
        }
    };
}

async function bothFeatures(caseName) {
    const p = page();

    await quiet(() => p.startConfirmed("recording"));
    await quiet(() => p.startConfirmed("live", caseName === "shared" ? "unlisted" : "public"));
    assert.equal(p.jitsi.starts.length, 1, "ONE Jibri stream for both features");
    if (caseName === "shared") assert.equal(liveRow().broadcastId, recordingRow().broadcastId);
    else assert.notEqual(liveRow().broadcastId, recordingRow().broadcastId);

    return p;
}

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

const youTubeDeparture = async () =>
    (await quiet(() => sweep.sweepDepartedTeachers(new Date()))).find(r => r.lectureId === LECTURE)?.result;

// The departed classroom: both features ended on YouTube, the fence armed.
async function departedAndYouTubeEnded(caseName = "separate") {
    prepare();
    await bothFeatures(caseName);
    const closedAt = closedTabAgo(CONFIRM_MS + 5_000);
    const result = await youTubeDeparture();

    assert.equal(result.status, "done", JSON.stringify(result));
    assert.equal(active([recordingRow(), liveRow()]).length, 0);
    assert.equal(currentSession().jibriStopDepartureAt?.getTime(), closedAt.getTime(), "armed for this departure");
    assert.equal(currentSession().jibriStopState, "pending");
    // YouTube reports the stream idle: the existing departed-class check
    // (assertNoDepartedClassStreaming) alone would let other lectures start
    // again; the fence must still refuse until the worker's evidence.
    yt.streamActive = false;
    return closedAt;
}

// YouTube's view of the teacher's stream, as the worker reads it.
const stream = { ingest: "none", reads: [] };
const readStreamIngest = async (_teacherId, streamId) => {
    stream.reads.push(streamId);
    return stream.ingest;
};

// The real controller over a fake room, its waits capped; `onCheck` runs
// before each of the lifecycle's own database re-checks.
function jitsi(script = {}, { deadlineMs = 250, onCheck } = {}) {
    const fake = createFakeJitsi(script);
    const real = createJibriController({
        transport: fake.transport, connectTimeoutMs: 200, joinTimeoutMs: 200,
        iqTimeoutMs: 100, notFoundRecheckMs: 20, leaveReserveMs: 20
    });
    let checks = 0;
    const controller = {
        calls: 0,
        modes: [],
        async stopStreamInRoom(request) {
            controller.calls += 1;
            controller.modes.push(request.mode);
            return real.stopStreamInRoom({
                ...request,
                deadlineAt: Math.min(request.deadlineAt, Date.now() + deadlineMs),
                shouldAbort: async () => {
                    checks += 1;
                    if (onCheck) await onCheck(checks);
                    return request.shouldAbort();
                }
            });
        }
    };
    return { ...fake, controller };
}

// A room where the recorder has gone and Jicofo reports no stream session.
function clearRoom(extra = {}) {
    const occupants = defaultOccupants().filter(o => !o.recorder);
    occupants[0].focus.status = "off";
    return { occupants, ...extra };
}

const stopIqs = room => room.iqs.filter(iq => iq.children.some(c => c.name === "jibri" && c.attrs.action === "stop"));

function run(controller, at = new Date(), sessionId = currentSession().id, extra = {}) {
    return quiet(() => jibriStop.processJibriFence(sessionId, { controller, config: CONFIG, at, readStreamIngest, ...extra }));
}

const startRecording = (lectureId = LECTURE) => quiet(() => post(routes.recordingStart, { lectureId, isLive: false }));
const refusedWith = (r, code) => r.status === 409 && JSON.stringify(r.data).includes(code);
const refusedForShutdown = r => refusedWith(r, "JIBRI_SHUTDOWN_IN_PROGRESS");
const fenced = (at = new Date()) => gate.findTeacherFence(TEACHER, at).then(s => s !== null);

// The one STOP, the recorder leaving voluntarily and the stream idle, then
// two later observations of a clear room and an idle stream (3 readings over
// >= 2 minutes): released.
async function releaseByEvidence(t0 = Date.now()) {
    stream.ingest = "none";
    const first = await run(jitsi().controller, new Date(t0));
    const second = await run(jitsi(clearRoom()).controller, new Date(t0 + 31_000));
    const third = await run(jitsi(clearRoom()).controller, new Date(t0 + 152_000));
    return [first, second, third];
}

async function captureLogs(fn) {
    const saved = [console.log, console.info, console.warn, console.error];
    const lines = [];
    const capture = (...args) => lines.push(args.map(a => (typeof a === "string" ? a : util.inspect(a, { depth: 5 }))).join(" "));
    console.log = console.info = console.warn = console.error = capture;
    try {
        return { result: await fn(), logs: lines.join("\n") };
    } finally {
        [console.log, console.info, console.warn, console.error] = saved;
    }
}

function patchPrisma(model, method, wrap) {
    const original = fakes.prisma[model][method];
    fakes.prisma[model][method] = wrap(original);
    return () => { fakes.prisma[model][method] = original; };
}

// ---- Arming at the departure -----------------------------------------------------------

test("the departure arms the fence BEFORE any covered row closes; no STOP is needed for it", async () => {
    prepare();
    await bothFeatures("separate");
    closedTabAgo(CONFIRM_MS + 5_000);

    const armedWhenClosed = [];
    const watch = original => async args => {
        if (args.data && args.data.endedAt) armedWhenClosed.push(Boolean(currentSession().jibriStopDepartureAt));
        return original(args);
    };
    const restore = [
        patchPrisma("youTubeRecording", "updateMany", watch), patchPrisma("youTubeRecording", "update", watch),
        patchPrisma("youTubeLiveBroadcast", "updateMany", watch), patchPrisma("youTubeLiveBroadcast", "update", watch)
    ];

    try {
        const result = await youTubeDeparture();
        assert.equal(result.status, "done", JSON.stringify(result));
    } finally {
        restore.forEach(r => r());
    }

    assert.ok(armedWhenClosed.length >= 2, "both rows closed: " + armedWhenClosed.length);
    assert.ok(armedWhenClosed.every(Boolean), "armed before every close");
    assert.equal(currentSession().jibriStopState, "pending");
    assert.equal(currentSession().jibriStopSentAt, null);
    assert.equal(await fenced(), true);
});

test("Lecture A departs while Lecture B starts: refused by the stream check before the departure stop, by the fence after it", async () => {
    prepare();
    await bothFeatures("separate");
    closedTabAgo(CONFIRM_MS + 5_000);

    const before = await startRecording(LECTURE_2);
    assert.ok(refusedWith(before, "YOUTUBE_STREAM_IN_USE"), JSON.stringify(before));

    assert.equal((await youTubeDeparture()).status, "done");

    // Stream still reported active: refused (by the existing departed-class check or the fence).
    const whileActive = await startRecording(LECTURE_2);
    assert.ok(refusedWith(whileActive, "YOUTUBE_STREAM_IN_USE") || refusedForShutdown(whileActive), JSON.stringify(whileActive));

    // Stream reported idle once: only the fence still refuses.
    yt.streamActive = false;
    const after = await startRecording(LECTURE_2);
    assert.ok(refusedForShutdown(after), JSON.stringify(after));
    assert.equal(db.recordings.filter(r => r.lectureId === LECTURE_2).length, 0, "nothing created for B");
});

test("a start immediately BEFORE and immediately AFTER the fence is written: both refused (no window)", async () => {
    prepare();
    await bothFeatures("separate");
    closedTabAgo(CONFIRM_MS + 5_000);

    const seen = {};
    const restore = patchPrisma("classSession", "updateMany", original => async args => {
        const arming = args.data && args.data.jibriStopState === "pending" && "jibriStopDepartureAt" in args.data;
        if (arming) seen.before = await startRecording(LECTURE_2);
        const result = await original(args);
        if (arming) seen.after = await startRecording(LECTURE_2);
        return result;
    });

    try {
        assert.equal((await youTubeDeparture()).status, "done");
    } finally {
        restore();
    }

    assert.ok(seen.before && seen.after, "both starts ran around the fence write");
    assert.ok(refusedWith(seen.before, "YOUTUBE_STREAM_IN_USE"), JSON.stringify(seen.before));
    assert.ok(seen.after.status === 409 && !seen.after.data.success, JSON.stringify(seen.after));
    yt.streamActive = false;
    assert.ok(refusedForShutdown(await startRecording(LECTURE_2)), "and after the rows closed (stream reported idle)");
});

test("the fence covers every lecture of the teacher, the same lecture included", async () => {
    await departedAndYouTubeEnded("shared");

    assert.ok(refusedForShutdown(await startRecording(LECTURE)));
    assert.ok(refusedForShutdown(await startRecording(LECTURE_2)));
    assert.ok(refusedForShutdown(await quiet(() => post(routes.liveStart, { lectureId: LECTURE_2, privacy: "public" }))));
});

test("not armed: no feature at the departure, a departure still in its 15 s window, or a cancelled one", async () => {
    prepare();
    closedTabAgo(CONFIRM_MS + 5_000);
    await youTubeDeparture();
    assert.equal(currentSession().jibriStopDepartureAt, null);
    assert.equal(await fenced(), false);

    prepare();
    await bothFeatures("separate");
    closedTabAgo(5_000);
    await youTubeDeparture();
    assert.equal(currentSession().jibriStopDepartureAt, null);
    assert.equal(await fenced(), false);
});

test("shared mode off (no control row): departures arm nothing and starts behave as before", async () => {
    prepare();
    db.control = null;
    await bothFeatures("separate");
    closedTabAgo(CONFIRM_MS + 5_000);
    assert.equal((await youTubeDeparture()).status, "done");

    assert.equal(currentSession().jibriStopDepartureAt, null, "nothing armed");
    // As before this feature: the departed-class check alone (stream idle: allowed).
    yt.streamActive = false;
    const other = await startRecording(LECTURE_2);
    assert.equal(other.data.success, true, JSON.stringify(other));
});

test("a fence due but not armed (rows closed another way) still refuses while the session is active; the worker arms it", async () => {
    prepare();
    await bothFeatures("separate");
    const closedAt = closedTabAgo(CONFIRM_MS + 5_000);
    // YouTube ended both before the departure stop ran: closed, not armed.
    for (const row of [recordingRow(), liveRow()]) Object.assign(row, { status: "COMPLETE", endedAt: new Date(closedAt.getTime() + 1_000) });
    yt.streamActive = false;

    assert.equal(currentSession().jibriStopDepartureAt, null);
    assert.ok(refusedForShutdown(await startRecording(LECTURE_2)));

    const { controller } = jitsi();
    const result = await run(controller);
    assert.equal(result.status, "attempted", JSON.stringify(result));
    assert.equal(currentSession().jibriStopDepartureAt.getTime(), closedAt.getTime(), "armed durably by the worker");
});

// ---- One STOP, then observation -----------------------------------------------------------

test("separate broadcasts: the one STOP, the recorder leaves, the stream idles; released only by the third idle reading >= 2 min after the first", async () => {
    await departedAndYouTubeEnded("separate");
    const t0 = Date.now();
    const { room, controller } = jitsi();

    const first = await run(controller, new Date(t0));
    assert.deepEqual([first.mode, first.outcome, first.ingest, first.state, first.stopSent], ["stop", "recorder-left", "none", "verifying", true]);
    assert.equal(stopIqs(room).length, 1);
    assert.ok(currentSession().jibriStopSentAt instanceof Date);
    assert.ok(currentSession().jibriStopRecorderLeftAt instanceof Date);
    assert.equal(await fenced(), true, "a recorder leaving is not proof on its own");

    assert.deepEqual(await run(jitsi(clearRoom()).controller, new Date(t0 + 10_000)), { status: "skipped", reason: "not-due" });

    const second = await run(jitsi(clearRoom()).controller, new Date(t0 + 31_000));
    assert.deepEqual([second.mode, second.outcome, second.state, second.stopSent], ["observe", "not-running", "verifying", false]);
    assert.equal(currentSession().jibriStopIdleReadingCount, 2);
    assert.equal(await fenced(), true, "two idle readings are not enough");

    const third = await run(jitsi(clearRoom()).controller, new Date(t0 + 152_000));
    assert.equal(third.state, "confirmed");
    assert.ok(currentSession().jibriStopConfirmedAt instanceof Date);
    assert.ok(currentSession().jibriStopWatchUntil > new Date(t0 + 152_000), "still watched after the release");
    assert.equal(await fenced(), false);
    assert.equal((await startRecording(LECTURE_2)).data.success, true);

    assert.deepEqual(await run(jitsi().controller, new Date(t0 + 3_600_000)), { status: "skipped", reason: "already-done" });
    assert.ok(stream.reads.every(id => id === "stream-1"), "only the pinned stream is read");
});

test("shared broadcast: armed once, the one STOP, released by evidence", async () => {
    await departedAndYouTubeEnded("shared");
    const [first, , third] = await releaseByEvidence();

    assert.equal(first.stopSent, true);
    assert.equal(third.state, "confirmed");
    assert.equal(await fenced(), false);
});

test("the STOP is sent once only: later attempts observe, even while the recorder stays", async () => {
    await departedAndYouTubeEnded("separate");
    const t0 = Date.now();
    const rooms = [];
    const attempt = async (at, script = { recorderLeaveMs: null }) => {
        const j = jitsi(script);
        rooms.push(j.room);
        return run(j.controller, new Date(at));
    };

    const first = await attempt(t0);
    assert.deepEqual([first.mode, first.outcome, first.state], ["stop", "unconfirmed", "stop-sent"]);

    const second = await attempt(t0 + 31_000);
    const third = await attempt(t0 + 31_000 + 121_000);
    assert.deepEqual([second.mode, second.outcome], ["observe", "recorder-present"]);
    assert.deepEqual([third.mode, third.outcome], ["observe", "recorder-present"]);

    assert.equal(rooms.reduce((n, r) => n + stopIqs(r).length, 0), 1, "exactly one STOP for the fence");
    assert.equal(await fenced(), true);
});

test("a recorder departure without independent confirmation never releases: stream active / unknown keeps the fence", async () => {
    await departedAndYouTubeEnded("separate");
    const t0 = Date.now();

    stream.ingest = "active";
    const first = await run(jitsi().controller, new Date(t0));
    assert.deepEqual([first.outcome, first.state], ["recorder-left", "stop-sent"]);
    assert.equal(currentSession().jibriStopStreamInactiveAt, null);

    stream.ingest = "unknown";
    const second = await run(jitsi(clearRoom()).controller, new Date(t0 + 31_000));
    assert.equal(second.state, "stop-sent");

    stream.ingest = "none";
    const third = await run(jitsi(clearRoom()).controller, new Date(t0 + 152_000));
    assert.equal(third.state, "verifying", "first idle reading only");

    // The recorder seen again: the readings start over.
    const fourth = await run(jitsi().controller, new Date(t0 + 453_000));
    assert.deepEqual([fourth.mode, fourth.outcome, fourth.state], ["observe", "recorder-present", "stop-sent"]);
    assert.equal(currentSession().jibriStopStreamInactiveAt, null);
    assert.equal(await fenced(), true);
});

test("the default stream check reads YouTube's status of the teacher's reusable stream (active: no release)", async () => {
    await departedAndYouTubeEnded("separate");
    yt.streamActive = true; // something still pushes into the stream key

    const first = await quiet(() => jibriStop.processJibriFence(currentSession().id, { controller: jitsi().controller, config: CONFIG }));
    assert.deepEqual([first.outcome, first.ingest, first.state], ["recorder-left", "active", "stop-sent"]);

    yt.streamActive = false;
    const second = await quiet(() => jibriStop.processJibriFence(currentSession().id, {
        controller: jitsi(clearRoom()).controller, config: CONFIG, at: new Date(Date.now() + 31_000)
    }));
    assert.deepEqual([second.ingest, second.state], ["none", "verifying"]);
});

// ---- Teacher return -------------------------------------------------------------------------

test("teacher return followed by a rejected start: the return is recorded, the fence stays, the worker only observes", async () => {
    await departedAndYouTubeEnded("separate");

    const refused = await startRecording(LECTURE);
    assert.ok(refusedForShutdown(refused), JSON.stringify(refused));
    assert.ok(currentSession().teacherActiveAfterDepartureAt instanceof Date, "the return was recorded");
    assert.equal(await fenced(), true, "a refused start releases nothing");

    const { room, controller } = jitsi();
    const observed = await run(controller);
    assert.deepEqual([observed.mode, observed.outcome, observed.stopSent], ["observe", "recorder-present", false]);
    assert.equal(stopIqs(room).length, 0, "a returned teacher's room never gets an automatic STOP");

    // The page's own orphan stop (unchanged) ends Jibri: observed, released.
    const t = Date.now() + 31_000;
    assert.equal((await run(jitsi(clearRoom()).controller, new Date(t))).state, "verifying");
    assert.equal((await run(jitsi(clearRoom()).controller, new Date(t + 121_000))).state, "verifying");
    const released = await run(jitsi(clearRoom()).controller, new Date(t + 121_000 + 301_000));
    assert.equal(released.state, "not-running", "released without any STOP of ours");
    assert.equal((await startRecording(LECTURE)).data.success, true);
});

test("teacher returns after joining or just before the STOP: no STOP; every later attempt observes", async () => {
    for (const at of [3, 4]) {
        await departedAndYouTubeEnded("separate");
        const { room, controller } = jitsi({}, { onCheck: n => { if (n === at) currentSession().teacherActiveAfterDepartureAt = new Date(); } });

        const result = await run(controller);
        assert.deepEqual([result.outcome, result.stopSent], ["aborted", false], "check " + at);
        assert.equal(stopIqs(room).length, 0);
        assert.equal(currentSession().jibriStopSentAt, null);

        const later = jitsi();
        const next = await run(later.controller, new Date(Date.now() + 31_000));
        assert.equal(next.mode, "observe");
        assert.equal(stopIqs(later.room).length, 0);
    }
});

test("a later tab-close of the same session (the teacher was back in between) keeps the fence and never re-enables a STOP", async () => {
    const firstClose = await departedAndYouTubeEnded("separate");
    currentSession().teacherActiveAfterDepartureAt = new Date();
    // The teacher closes the tab again: a new, later signal (confirmed: > 15 s ago).
    Object.assign(currentSession(), { teacherDepartureAt: new Date(firstClose.getTime() + 2_000), teacherActiveAfterDepartureAt: null });

    assert.equal(currentSession().jibriStopDepartureAt.getTime(), firstClose.getTime(), "the open fence continues");
    const { room, controller } = jitsi();
    const result = await run(controller);
    assert.equal(result.mode, "observe");
    assert.equal(stopIqs(room).length, 0);
});

test("the returning page after a released fence: Jitsi reports Jibri off, the page sends no second stop", async () => {
    await departedAndYouTubeEnded("separate");
    await releaseByEvidence();

    currentSession().teacherActiveAfterDepartureAt = new Date();
    const returning = page();
    returning.controller.onStreamStatus({ on: false });
    await settle();

    assert.equal(returning.jitsi.stops, 0);
});

// ---- Never released by time ------------------------------------------------------------------

test("no automatic release after 120 s, a day, or retry exhaustion; unresolved keeps being observed; a restarted worker resumes", async () => {
    await departedAndYouTubeEnded("separate");
    const t0 = Date.now();
    const at = ms => new Date(t0 + ms);

    assert.equal((await run(jitsi({ recorderLeaveMs: null }).controller, at(0))).state, "stop-sent");
    assert.equal(await fenced(at(121_000)), true, "not after 120 s");
    assert.equal(await fenced(at(86_400_000)), true, "not after a day");

    let when = 0;
    for (const delay of [31_000, 121_000, 301_000, 301_000]) {
        when += delay;
        await run(jitsi().controller, at(when)); // the recorder still there
    }
    assert.equal(currentSession().jibriStopAttemptCount, 5);
    assert.equal(currentSession().jibriStopState, "unresolved");
    assert.equal(await fenced(at(when + 36_000_000)), true, "unresolved stays fenced");
    assert.ok(refusedForShutdown(await startRecording(LECTURE_2)));

    // A "restarted" worker (a new controller; only the database carries over).
    assert.deepEqual(await run(jitsi().controller, at(when + 899_000)), { status: "skipped", reason: "not-due" });
    const observed = await run(jitsi(clearRoom()).controller, at(when + 901_000));
    assert.deepEqual([observed.mode, observed.state], ["observe", "verifying"]);
    assert.equal((await run(jitsi(clearRoom()).controller, at(when + 2 * 901_000))).state, "verifying");
    const released = await run(jitsi(clearRoom()).controller, at(when + 3 * 901_000));
    assert.equal(released.state, "confirmed", "evidence still releases an unresolved fence");
    assert.equal(currentSession().jibriStopOverrideAt, null, "never an automatic override");
});

test("timeouts, disconnects and refusals never release", async () => {
    for (const script of [{ stopAnswer: "hang" }, { stopAnswer: "drop" }, { connectError: true }, { stopAnswer: { error: "forbidden" } }]) {
        await departedAndYouTubeEnded("separate");
        const result = await run(jitsi(script).controller);

        assert.ok(["pending", "stop-sent"].includes(result.state), JSON.stringify(script) + " " + result.state);
        assert.equal(currentSession().jibriStopConfirmedAt, null);
        assert.equal(await fenced(), true);
    }
});

test("refused (forbidden): the next attempt waits 5 minutes", async () => {
    await departedAndYouTubeEnded("separate");
    const t0 = Date.now();

    assert.equal((await run(jitsi({ stopAnswer: { error: "forbidden" } }).controller, new Date(t0))).outcome, "refused");
    assert.deepEqual(await run(jitsi().controller, new Date(t0 + 31_000)), { status: "skipped", reason: "not-due" });
    assert.equal((await run(jitsi().controller, new Date(t0 + 301_000))).attempt, 2);
});

// ---- Deactivated sessions ---------------------------------------------------------------------

test("a deactivated session (End Session / replaced) stays fenced; the worker only observes it and releases on evidence", async () => {
    await departedAndYouTubeEnded("separate");
    const old = currentSession();
    old.isActive = false; // as End Session or a replacing session would leave it

    assert.ok(refusedForShutdown(await startRecording(LECTURE_2)));
    const listed = await quiet(() => jibriStop.sweepJibriStops({ controller: jitsi().controller, config: CONFIG, readStreamIngest }));
    assert.ok(listed.some(r => r.sessionId === old.id), "swept although inactive");
    assert.equal(listed.find(r => r.sessionId === old.id).result.mode, "observe");

    const t = Date.now() + 31_000;
    const { room, controller } = jitsi(clearRoom());
    assert.equal((await run(controller, new Date(t), old.id)).state, "verifying");
    assert.equal(stopIqs(room).length, 0);
    assert.equal((await run(jitsi(clearRoom()).controller, new Date(t + 121_000), old.id)).state, "verifying");
    assert.equal((await run(jitsi(clearRoom()).controller, new Date(t + 121_000 + 301_000), old.id)).state, "not-running");
    assert.equal((await startRecording(LECTURE_2)).data.success, true);
});

// ---- Locks and concurrency ------------------------------------------------------------------------

test("two simultaneous starts from different lectures: exactly one starts", async () => {
    prepare();
    const results = await Promise.all([startRecording(LECTURE), startRecording(LECTURE_2)]);

    assert.equal(results.filter(r => r.data.success).length, 1, JSON.stringify(results.map(r => r.data)));
    assert.equal(results.filter(r => r.status === 409).length, 1);
    assert.equal(active([...db.recordings, ...db.lives]).length, 1);
});

test("a start while the worker holds the teacher lock is refused (busy), for any lecture", async () => {
    await departedAndYouTubeEnded("separate");
    let during = null;
    const { controller } = jitsi({}, { onCheck: async n => { if (n === 3) during = await startRecording(LECTURE_2); } });

    await run(controller);

    assert.ok(refusedWith(during, "YOUTUBE_OPERATION_IN_PROGRESS"), JSON.stringify(during));
});

test("the worker never acquires while a start holds the teacher lock: busy, no connection", async () => {
    await departedAndYouTubeEnded("separate");
    const { room, controller } = jitsi();
    let release;
    const held = quiet(() => lockLib.withTeacherYouTubeLock(TEACHER, () => new Promise(resolve => { release = resolve; })));
    await settle();

    assert.deepEqual(await run(controller), { status: "busy" });
    assert.equal(room.opens.length, 0);
    assert.equal(locks.has(LECTURE), false, "the lecture lock was not taken either (teacher first)");

    release();
    await held;
    assert.equal((await run(controller)).status, "attempted");
});

test("duplicate invocations at once: one attempt, one connection, one STOP", async () => {
    await departedAndYouTubeEnded("separate");
    const { room, controller } = jitsi();

    const results = await Promise.all([run(controller), run(controller), run(controller)]);

    assert.equal(results.filter(r => r.status === "attempted").length, 1, JSON.stringify(results));
    assert.equal(room.opens.length, 1);
    assert.equal(stopIqs(room).length, 1);
});

test("the worker never stops another classroom: the STOP and every join target only the fenced session's room", async () => {
    await departedAndYouTubeEnded("separate");
    currentSession().roomName = "SaasTution-CLASS001-K9X2AB";
    const { room, controller } = jitsi();

    await run(controller);

    const { payload } = decodeJwt(room.opens[0].token);
    assert.equal(payload.room, ROOM);
    assert.equal(room.opens[0].room, ROOM);
    assert.equal(stopIqs(room)[0].attrs.to, ROOM + "@" + CONFIG.mucDomain + "/focus");
    assert.deepEqual(payload.context.user, { id: "system:jibri-stop", name: "SL Classroom System", moderator: "true", affiliation: "owner" });
    for (const s of room.sent) if (s.attrs.to) assert.ok(s.attrs.to.startsWith(ROOM + "@" + CONFIG.mucDomain + "/"));
});

test("unobservable sessions (another Jitsi domain, a non-classroom room) stay fenced: no connection", async () => {
    await departedAndYouTubeEnded("separate");
    const { room, controller } = jitsi();

    currentSession().jitsiDomain = "meet.jit.si";
    assert.deepEqual(await run(controller), { status: "skipped", reason: "other-domain" });
    currentSession().jitsiDomain = DOMAIN;
    currentSession().roomName = "*";
    assert.deepEqual(await run(controller), { status: "skipped", reason: "invalid-room" });
    assert.equal(room.opens.length, 0);
    assert.equal(await fenced(), true);
});

test("a feature still being ended on YouTube: no connection yet; the fence is armed already", async () => {
    prepare();
    await bothFeatures("separate");
    yt.transitionErrors.set(recordingRow().broadcastId, new youtubeRequest.YouTubeRequestTimeoutError("timeout"));
    closedTabAgo(CONFIRM_MS + 5_000);
    assert.equal((await youTubeDeparture()).status, "pending");

    assert.ok(currentSession().jibriStopDepartureAt, "armed before closing anything");
    const { room, controller } = jitsi();
    assert.deepEqual(await run(controller), { status: "skipped", reason: "feature-active" });
    assert.equal(room.opens.length, 0);
});

// ---- Administrator override ----------------------------------------------------------------------

test("override: an authenticated administrator with a reason releases the fence; audited; never automatic", async () => {
    await departedAndYouTubeEnded("separate");
    await run(jitsi({ recorderLeaveMs: null }).controller);
    const id = currentSession().id;
    const reason = "Checked the Jibri server: no ffmpeg process; YouTube stream idle.";

    await assert.rejects(overrides.overrideJibriShutdownFence({ sessionId: id, reason, admin: { adminId: "" } }), e => e.code === "FORBIDDEN");
    await assert.rejects(overrides.overrideJibriShutdownFence({ sessionId: id, reason: "  short ", admin: { adminId: "admin-1" } }),
        e => e.code === "JIBRI_OVERRIDE_REASON_REQUIRED");
    await assert.rejects(overrides.overrideJibriShutdownFence({ sessionId: id, reason: "x".repeat(501), admin: { adminId: "admin-1" } }),
        e => e.code === "JIBRI_OVERRIDE_REASON_REQUIRED");
    assert.equal(await fenced(), true, "nothing released by refused attempts");
    assert.equal(db.overrides.length, 0);

    const result = await quiet(() => overrides.overrideJibriShutdownFence({ sessionId: id, reason, admin: { adminId: "admin-1", email: "a@x.test" } }));

    assert.equal(result.sessionId, id);
    assert.equal(currentSession().jibriStopOverrideBy, "admin-1");
    assert.equal(currentSession().jibriStopOverrideReason, reason);
    assert.ok(currentSession().jibriStopOverrideAt instanceof Date);
    assert.equal(db.overrides.length, 1);
    assert.deepEqual(
        (({ classSessionId, previousState, adminId, adminEmail, reason: r }) => ({ classSessionId, previousState, adminId, adminEmail, reason: r }))(db.overrides[0]),
        { classSessionId: id, previousState: "stop-sent", adminId: "admin-1", adminEmail: "a@x.test", reason }
    );
    assert.equal(db.overrides[0].fenceDepartureAt.getTime(), currentSession().jibriStopDepartureAt.getTime());
    assert.equal(await fenced(), false);
    assert.equal((await startRecording(LECTURE_2)).data.success, true);

    await assert.rejects(overrides.overrideJibriShutdownFence({ sessionId: id, reason, admin: { adminId: "admin-1" } }), e => e.code === "JIBRI_FENCE_NOT_OPEN");
    assert.equal(db.overrides.length, 1);

    // The worker leaves an overridden fence alone.
    assert.deepEqual(await run(jitsi().controller, new Date(Date.now() + 3_600_000)), { status: "skipped", reason: "already-done" });
});

test("override routes: administrators only (403 otherwise); the list shows open fences", async () => {
    await departedAndYouTubeEnded("separate");
    const id = currentSession().id;
    const call = body => quiet(() => overrideRoute.POST(new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) }), { params: { sessionId: id } }));

    session.adminId = null;
    const forbidden = await call({ reason: "Verified on the Jibri server by hand." });
    assert.equal(forbidden.status, 403);
    assert.equal((await quiet(() => listRoute.GET())).status, 403);
    assert.equal(await fenced(), true);

    session.adminId = "admin-7";
    const list = await (await quiet(() => listRoute.GET())).json();
    assert.deepEqual(list.data.fences.map(f => f.sessionId), [id]);

    const noReason = await call({});
    assert.equal(noReason.status, 400);

    const ok = await call({ reason: "Verified on the Jibri server by hand." });
    assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
    assert.equal(db.overrides[0].adminId, "admin-7");
    assert.equal(await fenced(), false);
});

test("an override while the worker holds the teacher lock is refused (busy) and changes nothing", async () => {
    await departedAndYouTubeEnded("separate");
    let attemptDuring = null;
    const { controller } = jitsi({}, {
        onCheck: async n => {
            if (n === 3) {
                attemptDuring = await overrides.overrideJibriShutdownFence({
                    sessionId: currentSession().id, reason: "Checked on the Jibri server by hand.", admin: { adminId: "admin-1" }
                }).catch(e => e);
            }
        }
    });

    await run(controller);

    assert.equal(attemptDuring.code, "YOUTUBE_OPERATION_IN_PROGRESS");
    assert.equal(db.overrides.length, 0);
    assert.equal(currentSession().jibriStopOverrideAt, null);
});

// ---- Privacy ---------------------------------------------------------------------------------------

test("logs: outcome codes only; never the token, a student name or a student JID", async () => {
    await departedAndYouTubeEnded("separate");
    const { room, controller } = jitsi();

    const { result, logs } = await captureLogs(() =>
        jibriStop.processJibriFence(currentSession().id, { controller, config: CONFIG, readStreamIngest }));

    assert.equal(result.outcome, "recorder-left");
    const token = room.opens[0].token;
    assert.ok(token && token.split(".").length === 3);
    assert.ok(!logs.includes(token), "no token");
    assert.ok(!logs.includes(token.split(".")[2]), "no signature");
    assert.ok(!logs.includes(process.env.JITSI_JWT_SECRET), "no secret");
    assert.ok(!logs.includes(STUDENT_NAME), "no student name");
    assert.ok(!logs.includes(STUDENT_JID), "no student JID");
});

// ---- X10: hung database steps fail closed ------------------------------------------------------------

test("X10: a re-check query hanging after joining: aborted, no STOP, never released, locks free", async () => {
    await departedAndYouTubeEnded("separate");
    let hang = false;
    const restore = patchPrisma("classSession", "findUnique", original => async (...args) => {
        if (hang) {
            hang = false;
            return new Promise(() => {});
        }
        return original(...args);
    });

    try {
        const { room, controller } = jitsi({}, { onCheck: n => { if (n === 3) hang = true; } });
        const result = await run(controller);

        assert.equal(result.outcome, "aborted");
        assert.equal(stopIqs(room).length, 0);
        assert.equal(locks.size, 0, "locks released");
        assert.equal(room.openSessions, 0);
        assert.equal(await fenced(), true);
    } finally {
        restore();
    }
});

test("X10: the claim hanging: no connection at all, error, locks free (bounded)", async () => {
    await departedAndYouTubeEnded("separate");
    const restore = patchPrisma("classSession", "updateMany", original => async args =>
        (args.data.jibriStopAttemptCount && !("jibriStopState" in args.data) ? new Promise(() => {}) : original(args)));

    try {
        const { room, controller } = jitsi();
        const started = Date.now();
        const result = await run(controller);

        assert.deepEqual(result, { status: "error" });
        assert.ok(Date.now() - started < 10_000);
        assert.equal(room.opens.length, 0);
        assert.equal(locks.size, 0);
    } finally {
        restore();
    }
});

test("X10: the outcome write hanging: nothing released", async () => {
    await departedAndYouTubeEnded("separate");
    const t0 = Date.now();
    await run(jitsi().controller, new Date(t0)); // idle readings 1 and 2 recorded
    await run(jitsi(clearRoom()).controller, new Date(t0 + 31_000));
    const restore = patchPrisma("classSession", "updateMany", original => async args =>
        ("jibriStopLastError" in args.data && !("jibriStopDepartureAt" in args.data) ? new Promise(() => {}) : original(args)));

    try {
        const result = await quiet(() => run(jitsi(clearRoom()).controller, new Date(t0 + 152_000)));

        assert.notEqual(result.state, "confirmed");
        assert.equal(currentSession().jibriStopConfirmedAt, null);
        assert.equal(await fenced(), true);
        assert.equal(locks.size, 0);
    } finally {
        restore();
    }
});

test("X10: the STOP record cannot be written (hangs): no STOP", async () => {
    await departedAndYouTubeEnded("separate");
    const restore = patchPrisma("classSession", "updateMany", original => async args =>
        (args.data.jibriStopSentAt ? new Promise(() => {}) : original(args)));

    try {
        const { room, controller } = jitsi();
        const result = await run(controller);

        assert.deepEqual([result.outcome, result.stopSent], ["aborted", false]);
        assert.equal(stopIqs(room).length, 0);
    } finally {
        restore();
    }
});

// ---- Feature flag, worker startup ------------------------------------------------------------------------

// DATABASE_URL: required by the startup decision; never used here (Prisma is the in-memory fake).
const JWT_ENV = {
    JITSI_DOMAIN: "meet.slclassroom.live", JITSI_ENABLE_JWT_AUTH: "true", JITSI_JWT_SECRET: "x",
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:9/never-connected"
};

test("worker: off by default; only JIBRI_SERVER_STOP=on with a complete Jitsi JWT setup AND an explicit DATABASE_URL enables it", () => {
    const { readJibriStopConfig } = jibriStop;

    assert.equal(readJibriStopConfig({}).enabled, false);
    assert.equal(readJibriStopConfig({ ...JWT_ENV }).enabled, false);
    for (const value of ["off", "true", "1", "yes", "enabled", ""]) {
        assert.equal(readJibriStopConfig({ ...JWT_ENV, JIBRI_SERVER_STOP: value }).enabled, false, value);
    }
    assert.equal(readJibriStopConfig({ JIBRI_SERVER_STOP: "on" }).enabled, false, "no Jitsi config");
    assert.equal(readJibriStopConfig({ ...JWT_ENV, JIBRI_SERVER_STOP: "on", JITSI_ENABLE_JWT_AUTH: "false" }).enabled, false);
    assert.equal(readJibriStopConfig({ ...JWT_ENV, JIBRI_SERVER_STOP: "on", JITSI_DOMAIN: "meet.jit.si" }).enabled, false);
    assert.equal(readJibriStopConfig({ ...JWT_ENV, JIBRI_SERVER_STOP: "on", JITSI_XMPP_WEBSOCKET_URL: "ws://meet.slclassroom.live/xmpp-websocket" }).enabled, false);
    assert.equal(readJibriStopConfig({ ...JWT_ENV, JIBRI_SERVER_STOP: "on", DATABASE_URL: "" }).enabled, false, "no explicit DATABASE_URL");
    for (const focus of ["focus", "@auth.meet.slclassroom.live", "focus@", "focus@bad host", "a/b@auth.meet.slclassroom.live"]) {
        assert.equal(readJibriStopConfig({ ...JWT_ENV, JIBRI_SERVER_STOP: "on", JITSI_FOCUS_JID: focus }).enabled, false, focus);
    }

    assert.deepEqual(readJibriStopConfig({ ...JWT_ENV, JIBRI_SERVER_STOP: "on" }), {
        enabled: true,
        config: {
            jitsiDomain: "meet.slclassroom.live",
            websocketUrl: "wss://meet.slclassroom.live/xmpp-websocket",
            mucDomain: "conference.meet.slclassroom.live",
            recorderDomain: "recorder.meet.slclassroom.live",
            focusJid: "focus@auth.meet.slclassroom.live"
        }
    });
});

test("worker with the flag off: returns null, builds no controller, reads nothing", async () => {
    let built = 0;
    let listed = 0;
    const restore = patchPrisma("classSession", "findMany", original => async (...args) => { listed += 1; return original(...args); });

    try {
        const worker = await quiet(() => startJibriStopWorker({
            env: { ...JWT_ENV, JIBRI_SERVER_STOP: "off" },
            createController: async () => { built += 1; return { stopStreamInRoom: async () => ({}) }; }
        }));

        assert.equal(worker, null);
        assert.equal(built, 0);
        assert.equal(listed, 0);
    } finally {
        restore();
    }
});

test("worker with the flag on (fake controller): sweeps; one STOP despite many sweeps; shuts down cleanly", async () => {
    await departedAndYouTubeEnded("separate");
    const { room, controller } = jitsi();
    yt.streamActive = false;

    const worker = await quiet(() => startJibriStopWorker({
        env: { ...JWT_ENV, JITSI_DOMAIN: DOMAIN, JIBRI_SERVER_STOP: "on" },
        intervalMs: 20,
        createController: async () => controller
    }));

    for (let i = 0; i < 50 && !currentSession().jibriStopSentAt; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    await quiet(() => worker.stop());

    assert.equal(stopIqs(room).length, 1);
    assert.equal(currentSession().jibriStopState, "verifying", "one idle reading; released only after more over >= 2 min");
    assert.ok(db.control.heartbeatAt instanceof Date, "heartbeat written");
    assert.equal(db.control.workerMode, "on");
    assert.equal(db.control.workerVersion, "jibri-stop-worker/3");
    assert.match(db.control.workerConfigId, /^[0-9a-f]{8}:meet\.example\.test$/);
});

// A separate Node process with a minimal environment (no DATABASE_URL, no
// project .env values): it imports the worker MODULE (its main() does not
// run) and calls the disabled startup path, then reports what was loaded.
function startupInIsolation(workerEnv) {
    const { execFileSync } = require("node:child_process");
    const script = `
        require("tsx/cjs/api").register();
        const path = require("node:path");
        const { startJibriStopWorker } = require(path.join(process.cwd(), "scripts/jibri-stop-worker.ts"));
        console.log = () => {};
        startJibriStopWorker({ env: JSON.parse(process.argv[1]) }).then(worker => {
            const loaded = Object.keys(require.cache).filter(p =>
                /@prisma|[\\\\/]\\.prisma[\\\\/]|[\\\\/]lib[\\\\/]prisma\\.ts$|@xmpp|jibri-stop-for-departure|jibri-xmpp-transport|jibri-control|jibri-shutdown-gate/.test(p));
            process.stdout.write(JSON.stringify({ worker: worker === null ? null : "started", loaded, configLoaded: Object.keys(require.cache).some(p => p.includes("jibri-stop-config")) && Object.keys(require.cache).some(p => p.includes("jibri-stop-worker")), databaseUrl: process.env.DATABASE_URL ?? null, secret: process.env.JITSI_JWT_SECRET ?? null }));
        });
    `;
    const env = {};
    for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME"]) {
        if (process.env[key]) env[key] = process.env[key];
    }
    const out = execFileSync(process.execPath, ["-e", script, JSON.stringify(workerEnv)], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
    return JSON.parse(out);
}

test("D1: disabled startup (flag off / incomplete config / no explicit DATABASE_URL) loads no Prisma, no .env, no XMPP", () => {
    for (const workerEnv of [
        {},
        { JIBRI_SERVER_STOP: "off", ...JWT_ENV },
        { JIBRI_SERVER_STOP: "on", JITSI_DOMAIN: "meet.example.test" },
        { JIBRI_SERVER_STOP: "on", JITSI_DOMAIN: "meet.example.test", JITSI_ENABLE_JWT_AUTH: "true", JITSI_JWT_SECRET: "x" }
    ]) {
        const result = startupInIsolation(workerEnv);

        assert.equal(result.worker, null, JSON.stringify(workerEnv));
        assert.equal(result.configLoaded, true, "positive control: the worker and its config module were loaded");
        assert.deepEqual(result.loaded, [], "nothing that touches the database or XMPP was loaded: " + JSON.stringify(workerEnv));
        assert.equal(result.databaseUrl, null, ".env was never loaded into the process");
        assert.equal(result.secret, null, ".env was never loaded into the process");
    }
});

// ============================================================================================
// Provisional fence at the tab-close signal, shared control, pinned stream, verification, UI
// ============================================================================================

const presence = require(path.join(root, "lib/teacher-presence.ts"));
const sessionService = require(path.join(root, "services/session-service.ts"));
const fenceControl = require(path.join(root, "lib/jibri-fence-control.ts"));
const youtubeLiveFake = require(path.join(root, "lib/youtube-live.ts"));
const departureNoticesRoute = require(path.join(root, "app/api/sessions/[id]/teacher-departure/route.ts"));
const modeRoute = require(path.join(root, "app/api/admin/jibri-fences/mode/route.ts"));
const noticeClient = require(path.join(root, "components/Jitsi/teacher-departure-notice.ts"));
const { getYoutubeFriendlyErrorMessage } = require(path.join(root, "lib/youtube-error-messages.ts"));
const { CLASS } = fakes;

// The real tab-close signal of the current page, `agoMs` ago (rows started before it).
async function signalAgo(agoMs, pageId = "page-1") {
    const at = new Date(Date.now() - agoMs);
    currentSession().teacherCurrentPageId = pageId;
    for (const row of [...db.lives, ...db.recordings]) {
        if (row.createdAt >= at) row.createdAt = row.generationStartedAt = new Date(at.getTime() - 60_000);
    }
    const result = await quiet(() => presence.recordTeacherDepartureSignal(currentSession().id, pageId, at));
    assert.deepEqual(result, { accepted: true });
    return at;
}

test("the tab-close signal and the provisional fence are ONE update (with the pinned stream)", async () => {
    prepare();
    await bothFeatures("separate");

    const writes = [];
    const restore = patchPrisma("classSession", "updateMany", original => async args => {
        writes.push(args.data);
        return original(args);
    });

    let at;
    try {
        at = await signalAgo(5_000);
    } finally {
        restore();
    }

    const signalWrites = writes.filter(d => "teacherDepartureAt" in d);
    assert.equal(signalWrites.length, 1);
    assert.equal(signalWrites[0].jibriStopState, "provisional", "in the same update as the signal");
    assert.equal(signalWrites[0].jibriStopStreamId, "stream-1");
    assert.equal(signalWrites[0].jibriStopDepartureAt.getTime(), at.getTime());

    // Not enforced inside the 15 s window, enforced once it passed (no processing needed).
    assert.equal(await fenced(new Date(at.getTime() + 10_000)), false);
    assert.equal(await fenced(new Date(at.getTime() + CONFIRM_MS + 1_000)), true);
});

test("mode off: no provisional fence; nothing active: a provisional fence that is never enforced and is cleared once confirmed", async () => {
    prepare();
    db.control = null;
    await bothFeatures("separate");
    await signalAgo(5_000);
    assert.equal(currentSession().jibriStopDepartureAt ?? null, null, "mode off");

    // Written whatever the rows look like (no read-then-write race), but it
    // covered no generation: never enforced, and the worker clears it.
    prepare();
    const at = await signalAgo(CONFIRM_MS + 1_000);
    assert.equal(currentSession().jibriStopState, "provisional");
    assert.equal(currentSession().jibriStopOrigin, "signal");
    assert.equal(await fenced(), false, "covered nothing: not enforced");
    yt.streamActive = false;
    assert.equal((await startRecording(LECTURE_2)).data.success, true);

    const cleared = await run(jitsi().controller, new Date(at.getTime() + CONFIRM_MS + 2_000));
    assert.equal(cleared.status, "cleared");
    assert.equal(currentSession().jibriStopDepartureAt, null);
});

test("the teacher returns within the grace period (activity, or the page withdraws its signal): the provisional fence is cleared", async () => {
    prepare();
    await bothFeatures("separate");
    const at = await signalAgo(5_000);

    await quiet(() => presence.recordTeacherActivity(currentSession().id, "page-2", new Date(at.getTime() + 5_000)));
    assert.equal(currentSession().jibriStopDepartureAt, null);
    assert.equal(currentSession().jibriStopState, null);
    assert.equal(await fenced(new Date(at.getTime() + 60_000)), false);

    prepare();
    await bothFeatures("separate");
    const again = await signalAgo(3_000, "page-1");
    const resumed = await quiet(() => presence.recordTeacherResumeSignal(currentSession().id, "page-1", new Date(again.getTime() + 3_000)));
    assert.equal(resumed.cancelled, true);
    assert.equal(currentSession().jibriStopDepartureAt, null);
});

test("a return AFTER the window keeps the provisional fence (enforced); a later signal makes it a confirmed one", async () => {
    prepare();
    await bothFeatures("separate");
    const at = await signalAgo(CONFIRM_MS + 5_000);

    await quiet(() => presence.recordTeacherActivity(currentSession().id, "page-2"));
    assert.equal(currentSession().jibriStopState, "provisional");
    assert.equal(await fenced(), true, "a late return never releases it");

    // The teacher closes the new page too: the open fence becomes "pending" in that same update.
    currentSession().teacherCurrentPageId = "page-2";
    await quiet(() => presence.recordTeacherDepartureSignal(currentSession().id, "page-2"));
    assert.equal(currentSession().jibriStopState, "pending");
    assert.equal(currentSession().jibriStopDepartureAt.getTime(), at.getTime(), "the original fence continues");
    assert.equal(await fenced(new Date(Date.now() + 3_000)), true, "no gap during the new window");
});

test("session replaced right after the departure was confirmed (before any processing): the fence survives deactivation; the worker finds it and never STOPs", async () => {
    prepare();
    await bothFeatures("separate");
    await signalAgo(CONFIRM_MS + 1_000);
    const old = currentSession();

    // The teacher starts a new session of the class from the dashboard (the real service).
    await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE));
    assert.equal(old.isActive, false, "deactivated");
    assert.equal(active([recordingRow(), liveRow()]).length, 0, "its rows were ended by the replacement");
    assert.equal(old.jibriStopState, "provisional");
    assert.equal(await fenced(), true);

    yt.streamActive = false;
    const refused = await startRecording(LECTURE); // in the NEW session
    assert.ok(refusedForShutdown(refused), JSON.stringify(refused));

    const { room, controller } = jitsi();
    const swept = await quiet(() => jibriStop.sweepJibriStops({ controller, config: CONFIG, readStreamIngest }));
    const mine = swept.find(r => r.sessionId === old.id);
    assert.ok(mine, "discovered although deactivated");
    assert.equal(mine.result.mode, "observe");
    assert.equal(old.jibriStopState, "pending", "made a confirmed fence");
    assert.equal(stopIqs(room).length, 0, "no STOP for an ended session");
});

test("YouTube rows already COMPLETE before any processing do not hide a confirmed departure (active or deactivated)", async () => {
    prepare();
    await bothFeatures("separate");
    const at = await signalAgo(CONFIRM_MS + 1_000);
    for (const row of [recordingRow(), liveRow()]) Object.assign(row, { status: "COMPLETE", endedAt: new Date(at.getTime() + 500) });
    yt.streamActive = false;

    assert.ok(refusedForShutdown(await startRecording(LECTURE_2)));
    currentSession().isActive = false;
    assert.ok(refusedForShutdown(await startRecording(LECTURE_2)), "still after deactivation");
});

test("a normal End Session WITHOUT a departure signal creates no fence (End Session unchanged); one after a confirmed departure keeps it", async () => {
    prepare();
    await bothFeatures("separate");
    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, currentSession().id));
    assert.equal(currentSession().isActive, false);
    assert.equal(currentSession().jibriStopDepartureAt ?? null, null, "no fence");
    yt.streamActive = false;
    assert.equal((await startRecording(LECTURE_2)).data.success, true);

    await departedAndYouTubeEnded("separate");
    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, currentSession().id));
    assert.equal(currentSession().isActive, false);
    assert.equal(currentSession().jibriStopState, "pending", "kept");
    assert.ok(refusedForShutdown(await startRecording(LECTURE_2)));
});

// ---- Shared control and worker health -------------------------------------------------------------

test("app on, worker missing / stale / on another mode: fenced teachers get a clear 503; teachers without a fence start normally", async () => {
    prepare();
    controlOn({ heartbeatAt: new Date(Date.now() - 120_000) });
    yt.streamActive = false;
    assert.equal((await startRecording(LECTURE_2)).data.success, true, "no fence: unaffected by the worker's health");

    for (const extra of [{ heartbeatAt: null }, { heartbeatAt: new Date(Date.now() - 61_000) }, { workerMode: "off" }]) {
        await departedAndYouTubeEnded("separate");
        controlOn(extra);
        const refused = await startRecording(LECTURE_2);
        assert.equal(refused.status, 503, JSON.stringify(extra));
        assert.equal(refused.data.code, "JIBRI_SHUTDOWN_WORKER_UNAVAILABLE", JSON.stringify(extra));
    }

    assert.deepEqual(fenceControl.jibriWorkerHealth({ mode: "on", heartbeatAt: null, workerMode: null }, new Date()), { healthy: false, status: "unavailable", reason: "missing" });
    assert.deepEqual(fenceControl.jibriWorkerHealth({ mode: "on", heartbeatAt: new Date(Date.now() - 61_000), workerMode: "on" }, new Date()), { healthy: false, status: "unavailable", reason: "stale" });
    assert.deepEqual(fenceControl.jibriWorkerHealth({ ...db.control, mode: "drain", workerMode: "on", heartbeatAt: new Date() }, new Date()), { healthy: false, status: "degraded", reason: "mode-mismatch" });
    assert.deepEqual(fenceControl.jibriWorkerHealth({ mode: "off", heartbeatAt: null, workerMode: null }, new Date()), { healthy: true });
});

test("mode turned off with fences open: they stay enforced (needs an administrator), nothing new is armed", async () => {
    await departedAndYouTubeEnded("separate");
    controlOn({ mode: "off", workerMode: "off" });

    const refused = await startRecording(LECTURE_2);
    assert.ok(refusedWith(refused, "JIBRI_SHUTDOWN_NEEDS_ADMIN"), JSON.stringify(refused));

    // A new departure of another session arms nothing in mode off.
    const other = sessionOf(LECTURE_2);
    Object.assign(other, { teacherCurrentPageId: "p2" });
    await quiet(() => presence.recordTeacherDepartureSignal(other.id, "p2"));
    assert.equal(other.jibriStopDepartureAt ?? null, null);
});

test("worker running while the shared mode is off: it only reports alive (no sweep, no STOP); with drain it verifies but never STOPs", async () => {
    await departedAndYouTubeEnded("separate");
    controlOn({ mode: "off", workerMode: null, heartbeatAt: null });
    const { room, controller } = jitsi();

    const worker = await quiet(() => startJibriStopWorker({
        env: { ...JWT_ENV, JITSI_DOMAIN: DOMAIN, JIBRI_SERVER_STOP: "on" }, intervalMs: 20, createController: async () => controller
    }));
    await new Promise(resolve => setTimeout(resolve, 150));
    await quiet(() => worker.stop());

    assert.equal(controller.calls, 0, "no work in mode off");
    assert.equal(db.control.workerMode, "off");
    assert.ok(db.control.heartbeatAt instanceof Date, "alive");

    db.control.mode = "drain";
    const drained = await run(controller, new Date(), currentSession().id, { mode: "drain" });
    assert.deepEqual([drained.mode, drained.stopSent], ["observe", false]);
    assert.equal(stopIqs(room).length, 0, "never a STOP in drain");
});

test("administrators change the mode (reason required, audited); health is visible; 403 for others", async () => {
    prepare();
    const call = body => quiet(() => modeRoute.POST(new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) })));

    session.adminId = null;
    assert.equal((await call({ mode: "drain", reason: "Planned maintenance window." })).status, 403);

    session.adminId = "admin-3";
    assert.equal((await call({ mode: "sideways", reason: "Planned maintenance window." })).status, 400);
    assert.equal((await call({ mode: "drain", reason: "short" })).status, 400);
    assert.equal((await call({ mode: "drain", reason: "Planned maintenance window." })).status, 200);
    assert.equal(db.control.mode, "drain");
    assert.deepEqual(
        (({ fromMode, toMode, adminId, reason }) => ({ fromMode, toMode, adminId, reason }))(db.modeChanges[0]),
        { fromMode: "on", toMode: "drain", adminId: "admin-3", reason: "Planned maintenance window." }
    );

    const listed = await (await quiet(() => listRoute.GET())).json();
    assert.equal(listed.data.health.mode, "drain");
    assert.deepEqual(listed.data.health.worker, { healthy: false, status: "degraded", reason: "mode-mismatch" });
    assert.ok(!JSON.stringify(listed).includes(process.env.JITSI_JWT_SECRET), "no secret in the admin view");
});

// ---- Pinned stream -----------------------------------------------------------------------------------

function patchStreamLookup(answer) {
    const original = youtubeLiveFake.getYouTubeLiveStream;
    const asked = [];
    youtubeLiveFake.getYouTubeLiveStream = async (_token, id) => {
        asked.push(id);
        return answer(id);
    };
    return { asked, restore: () => { youtubeLiveFake.getYouTubeLiveStream = original; } };
}

test("a replaced / reconnected stream never stands in: only the pinned stream is read (it still pushes: no release)", async () => {
    prepare();
    await bothFeatures("separate");
    await signalAgo(CONFIRM_MS + 1_000); // pins stream-1
    assert.equal((await youTubeDeparture()).status, "done");
    db.connection.liveStreamId = "stream-NEW"; // a newer stream of the connection

    const lookup = patchStreamLookup(id => ({ id, status: { streamStatus: id === "stream-1" ? "active" : "inactive" } }));
    try {
        const t0 = Date.now();
        const first = await quiet(() => jibriStop.processJibriFence(currentSession().id, { controller: jitsi().controller, config: CONFIG, at: new Date(t0) }));
        const second = await quiet(() => jibriStop.processJibriFence(currentSession().id, { controller: jitsi(clearRoom()).controller, config: CONFIG, at: new Date(t0 + 31_000) }));

        assert.deepEqual(lookup.asked, ["stream-1", "stream-1"], "never stream-NEW");
        assert.equal(first.ingest, "active");
        assert.equal(second.ingest, "active");
        assert.equal(await fenced(), true);
    } finally {
        lookup.restore();
    }
});

test("pinned stream not visible (another channel reconnected), none pinned, or re-authorization needed: unknown, never released", async () => {
    await departedAndYouTubeEnded("separate");
    const id = currentSession().id;
    const t0 = Date.now();

    // Another channel: the pinned stream is not found (an error) -> unknown.
    const lookup = patchStreamLookup(() => { throw new Error("YouTube live stream not found."); });
    try {
        const r = await quiet(() => jibriStop.processJibriFence(id, { controller: jitsi().controller, config: CONFIG, at: new Date(t0) }));
        assert.equal(r.ingest, "unknown");
    } finally {
        lookup.restore();
    }

    // Re-authorization required.
    db.connection.status = "REAUTH_REQUIRED";
    const reauth = await quiet(() => jibriStop.processJibriFence(id, { controller: jitsi(clearRoom()).controller, config: CONFIG, at: new Date(t0 + 31_000) }));
    assert.equal(reauth.ingest, "unknown");
    db.connection.status = "CONNECTED";

    // No pinned stream at all.
    currentSession().jibriStopStreamId = null;
    yt.streamActive = false;
    const none = await quiet(() => jibriStop.processJibriFence(id, { controller: jitsi(clearRoom()).controller, config: CONFIG, at: new Date(t0 + 152_000) }));
    assert.equal(none.ingest, "unknown");
    assert.equal(currentSession().jibriStopIdleReadingCount, 0);
    assert.equal(await fenced(), true);
});

// ---- Verification -----------------------------------------------------------------------------------

test("intermittent readings (idle, active, idle ...): the series restarts; release needs 3 idle readings in a row over >= 2 min", async () => {
    await departedAndYouTubeEnded("separate");
    const t0 = Date.now();
    const at = ms => new Date(t0 + ms);
    const step = async (ms, ingest, room = clearRoom()) => {
        stream.ingest = ingest;
        return run(jitsi(room).controller, at(ms));
    };

    assert.equal((await run(jitsi().controller, at(0))).state, "verifying"); // STOP, idle #1
    assert.equal((await step(31_000, "none")).state, "verifying");            // #2
    assert.equal((await step(152_000, "active")).state, "stop-sent");         // resumed: over
    assert.equal(currentSession().jibriStopIdleReadingCount, 0);
    assert.equal((await step(453_000, "none")).state, "verifying");           // #1
    assert.equal((await step(754_000, "unknown")).state, "unresolved");       // unknown: over (5 attempts)
    assert.equal((await step(754_000 + 901_000, "none")).state, "verifying"); // #1
    assert.equal((await step(754_000 + 2 * 901_000, "none")).state, "verifying"); // #2
    assert.equal(await fenced(at(754_000 + 2 * 901_000)), true);
    assert.equal((await step(754_000 + 3 * 901_000, "none")).state, "confirmed"); // #3, span >= 2 min
});

test("after a release the pinned stream is still watched: ingest resuming re-opens the fence; the teacher's own new stream ends the watch", async () => {
    await departedAndYouTubeEnded("separate");
    const t0 = Date.now();
    const [, , released] = await releaseByEvidence(t0);
    assert.equal(released.state, "confirmed");
    assert.equal(await fenced(), false);

    stream.ingest = "active";
    const watched = await run(jitsi().controller, new Date(t0 + 152_000 + 61_000));
    assert.deepEqual([watched.status, watched.reopened], ["watched", true]);
    assert.equal(currentSession().jibriStopState, "stop-sent");
    assert.equal(currentSession().jibriStopLastError, "stream-resumed");
    assert.equal(await fenced(), true, "fenced again");

    // Released again, then the teacher starts a stream of their own: the watch ends.
    stream.ingest = "none";
    const t1 = Date.now() + 200_000;
    await run(jitsi(clearRoom()).controller, new Date(t1));
    await run(jitsi(clearRoom()).controller, new Date(t1 + 31_000));
    assert.equal((await run(jitsi(clearRoom()).controller, new Date(t1 + 152_000))).state, "confirmed");
    yt.streamActive = false;
    assert.equal((await startRecording(LECTURE_2)).data.success, true);
    stream.ingest = "active";
    const ended = await run(jitsi().controller, new Date(t1 + 152_000 + 61_000));
    assert.deepEqual([ended.status, ended.reopened, ended.watchEnded], ["watched", false, true]);
    assert.equal(currentSession().jibriStopWatchUntil, null);
    assert.equal(await fenced(), false);
});

// ---- Teacher UI ------------------------------------------------------------------------------------

async function loadNoticesFor(sessionId) {
    const response = await quiet(() => departureNoticesRoute.GET(new Request("http://localhost/api"), { params: { id: sessionId } }));
    const body = await response.json();
    return body.success ? noticeClient.parseDepartureNotices(body.data) : null;
}

test("after a reload the teacher sees why they cannot start (server-side state), and Check again clears once released", async () => {
    await departedAndYouTubeEnded("separate");
    const fmt = date => date.toISOString();

    const notices = await loadNoticesFor(sessionOf(LECTURE_2).id);
    const fence = noticeClient.describeShutdownFenceNotice(notices, fmt);
    assert.equal(notices.shutdownFence.blocked, true);
    assert.equal(notices.shutdownFence.code, "JIBRI_SHUTDOWN_IN_PROGRESS");
    assert.match(fence.message, /not been confirmed stopped/);
    assert.ok(!/End (that|the) class session/i.test(fence.message));

    await releaseByEvidence();
    const fresh = await loadNoticesFor(sessionOf(LECTURE_2).id);
    assert.deepEqual(fresh.shutdownFence, { blocked: false });
    assert.equal(noticeClient.describeShutdownFenceNotice(fresh, fmt), null);

    // An older server (no field): nothing shown, nothing broken.
    assert.equal(noticeClient.describeShutdownFenceNotice({}, fmt), null);
});

test("start error messages explain the fence and never suggest End Session releases it", () => {
    for (const code of ["JIBRI_SHUTDOWN_IN_PROGRESS", "JIBRI_SHUTDOWN_WORKER_UNAVAILABLE", "JIBRI_SHUTDOWN_NEEDS_ADMIN"]) {
        const message = getYoutubeFriendlyErrorMessage(null, "recording", code);
        assert.match(message, /not been confirmed stopped/, code);
        assert.ok(!/End (that|the) class session/i.test(message), code);
    }
});

// ---- Fence lookups ------------------------------------------------------------------------------------

test("released historical fences are excluded in the query itself (never scanned per start)", async () => {
    prepare();
    for (let i = 0; i < 40; i++) {
        db.sessions.push({
            id: "old-" + i, classId: CLASS, lectureId: LECTURE, isActive: false, startedAt: new Date(0), teacherId: TEACHER,
            ...FENCE_DEFAULTS, jibriStopDepartureAt: new Date(1_000 + i),
            jibriStopState: i % 2 ? "confirmed" : "not-running",
            jibriStopOverrideAt: i % 5 === 0 ? new Date() : null
        });
    }

    let returned = null;
    let where = null;
    const restore = patchPrisma("classSession", "findMany", original => async args => {
        const rows = await original(args);
        if (args.where && args.where.class) {
            returned = rows;
            where = args.where;
        }
        return rows;
    });

    try {
        assert.equal(await fenced(), false);
    } finally {
        restore();
    }
    assert.deepEqual(returned, [], "no released fence was returned");
    assert.deepEqual(where.OR[0], {
        jibriStopDepartureAt: { not: null }, jibriStopOverrideAt: null, jibriStopState: { notIn: ["confirmed", "not-running"] }
    }, "released fences are excluded by the query's own condition");
});

// ============================================================================================
// Late fences, race timelines, worker identity, connection proof, liveness vs sweep progress
// ============================================================================================

// The signal is recorded but its provisional fence is not (the control cannot be read then).
async function signalWithoutFence(agoMs) {
    const restore = patchPrisma("jibriShutdownControl", "findUnique", () => async () => {
        throw new Error("database unavailable (test)");
    });
    try {
        return await signalAgo(agoMs);
    } finally {
        restore();
    }
}

test("late fence: the provisional fence failed, End Session followed (rows COMPLETE): the start path arms a durable late fence and refuses", async () => {
    prepare();
    await bothFeatures("separate");
    const at = await signalWithoutFence(CONFIRM_MS + 1_000);
    const old = currentSession();
    assert.equal(old.jibriStopDepartureAt ?? null, null, "no provisional fence was written");

    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, old.id));
    assert.equal(old.isActive, false);
    assert.ok([recordingRow(), liveRow()].every(r => r.status === "COMPLETE" && r.endedAt >= at), "rows COMPLETE after the departure");
    assert.equal(old.jibriStopDepartureAt ?? null, null, "End Session itself arms nothing (unchanged)");

    yt.streamActive = false;
    const refused = await startRecording(LECTURE_2);
    assert.ok(refusedForShutdown(refused), JSON.stringify(refused));
    assert.equal(old.jibriStopDepartureAt.getTime(), at.getTime(), "armed durably by the start path");
    assert.equal(old.jibriStopState, "pending");
    assert.equal(old.jibriStopOrigin, "late");
    assert.equal(old.jibriStopStreamId, "stream-1", "the connection is unchanged since the departure: pinned");

    // The worker only observes an ended session's room (never a STOP).
    const { room, controller } = jitsi();
    const result = await run(controller, new Date(), old.id);
    assert.equal(result.mode, "observe");
    assert.equal(stopIqs(room).length, 0);
});

test("late fence: a session REPLACED right after an unfenced departure is found by the worker sweep and armed (observe only)", async () => {
    prepare();
    await bothFeatures("separate");
    const at = await signalWithoutFence(CONFIRM_MS + 1_000);
    const old = currentSession();

    await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE));
    assert.equal(old.isActive, false);

    const { room, controller } = jitsi();
    const swept = await quiet(() => jibriStop.sweepJibriStops({ controller, config: CONFIG, readStreamIngest }));
    const mine = swept.find(r => r.sessionId === old.id);

    assert.ok(mine, "discovered from durable departure facts although deactivated");
    assert.equal(mine.result.mode, "observe");
    assert.equal(old.jibriStopDepartureAt.getTime(), at.getTime());
    assert.equal(old.jibriStopOrigin, "late");
    assert.equal(stopIqs(room).length, 0);
});

test("late fence never for: End Session without a signal, a return before the end, a departure that covered nothing, mode off", async () => {
    // No tab-close signal at all.
    prepare();
    await bothFeatures("separate");
    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, currentSession().id));
    yt.streamActive = false;
    assert.equal((await startRecording(LECTURE_2)).data.success, true, "ordinary End Session: no fence");
    assert.equal(sessionOf(LECTURE).jibriStopDepartureAt ?? null, null);

    // The teacher came back (after the window) before End Session.
    prepare();
    await bothFeatures("separate");
    const at = await signalWithoutFence(CONFIRM_MS + 5_000);
    await quiet(() => presence.recordTeacherActivity(currentSession().id, "page-2", new Date(at.getTime() + CONFIRM_MS + 2_000)));
    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, currentSession().id));
    yt.streamActive = false;
    assert.equal((await startRecording(LECTURE_2)).data.success, true, "returned before the end");

    // A departure while nothing of the session was running.
    prepare();
    await signalWithoutFence(CONFIRM_MS + 1_000);
    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, currentSession().id));
    yt.streamActive = false;
    assert.equal((await startRecording(LECTURE_2)).data.success, true, "covered nothing");

    // Mode off: nothing new is armed (as before this feature).
    prepare();
    await bothFeatures("separate");
    await signalWithoutFence(CONFIRM_MS + 1_000);
    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, currentSession().id));
    db.control = null;
    yt.streamActive = false;
    assert.equal((await startRecording(LECTURE_2)).data.success, true, "mode off");
});

test("late fence: a later generation can never erase the departure's evidence (the start is refused and arms BEFORE writing)", async () => {
    prepare();
    await bothFeatures("separate");
    const at = await signalWithoutFence(CONFIRM_MS + 1_000);
    const old = currentSession();
    const generations = [recordingRow(), liveRow()].map(r => r.generationStartedAt.getTime());

    // A new session of the SAME lecture, then a start there (it would reuse the rows).
    await quiet(() => sessionService.startClassSessionForTeacher(TEACHER, CLASS, LECTURE));
    yt.streamActive = false;
    const refused = await startRecording(LECTURE);
    assert.ok(refusedForShutdown(refused), JSON.stringify(refused));

    assert.deepEqual([recordingRow(), liveRow()].map(r => r.generationStartedAt.getTime()), generations, "no new generation written");
    assert.equal(old.jibriStopDepartureAt.getTime(), at.getTime(), "the fence is durable now");

    // Even if a row were rewritten later, the armed fence stays enforced.
    recordingRow().generationStartedAt = new Date();
    liveRow().generationStartedAt = new Date();
    assert.equal(await fenced(), true);
});

test("late fence pin: only a connection unchanged since the departure is pinned; a reconnected one pins nothing (never released by readings)", async () => {
    prepare();
    await bothFeatures("separate");
    await signalWithoutFence(CONFIRM_MS + 1_000);
    const old = currentSession();
    await quiet(() => sessionService.endClassSessionForTeacher(TEACHER, old.id));

    // Reconnected after the departure: a new stream.
    Object.assign(db.connection, { liveStreamId: "stream-NEW", updatedAt: new Date() });
    yt.streamActive = false;
    assert.ok(refusedForShutdown(await startRecording(LECTURE_2)));
    assert.equal(old.jibriStopOrigin, "late");
    assert.equal(old.jibriStopStreamId, null, "unknown stream: fails closed");

    // The real reader: no pinned stream is "unknown" (never an idle reading).
    const reading = await quiet(() => jibriStop.processJibriFence(old.id, { controller: jitsi(clearRoom()).controller, config: CONFIG }));
    assert.equal(reading.ingest, "unknown");
    assert.equal(old.jibriStopIdleReadingCount, 0);
    assert.equal(await fenced(), true, "never released without the pinned stream");
});

test("arming over an earlier departure's provisional fence keeps ITS pinned stream", async () => {
    prepare();
    await bothFeatures("separate");
    const first = new Date(Date.now() - CONFIRM_MS - 60_000);
    const second = new Date(Date.now() - CONFIRM_MS - 1_000);

    // An earlier departure's provisional fence (stream-1), then a later departure
    // recorded without its fence; the channel reconnected meanwhile.
    Object.assign(currentSession(), {
        jibriStopDepartureAt: first, jibriStopState: "provisional", jibriStopStreamId: "stream-1", jibriStopOrigin: "signal",
        teacherDepartureAt: second, teacherActiveAfterDepartureAt: null
    });
    db.connection.liveStreamId = "stream-NEW";

    await quiet(() => gate.armJibriFence(currentSession().id, second, { armNew: true, origin: "worker" }));
    assert.equal(currentSession().jibriStopDepartureAt.getTime(), second.getTime());
    assert.equal(currentSession().jibriStopStreamId, "stream-1", "never substituted by the new stream");
});

// ---- Race timelines: a start against the tab-close signal --------------------------------------

// A start whose row is written around the signal: `generationOffsetMs` relative to the signal,
// and the teacher's activity (if any) at `activityOffsetMs`.
async function startAroundSignal({ generationOffsetMs, activityOffsetMs = null }) {
    prepare();
    const at = await signalAgo(CONFIRM_MS + 2_000);
    assert.equal(currentSession().jibriStopState, "provisional", "written whatever the rows were");

    yt.streamActive = false;
    const p = page();
    await quiet(() => p.startConfirmed("recording"));
    // Rewind to the timeline under test (the start path recorded the activity itself).
    recordingRow().generationStartedAt = new Date(at.getTime() + generationOffsetMs);
    currentSession().teacherActiveAfterDepartureAt = activityOffsetMs === null ? null : new Date(at.getTime() + activityOffsetMs);
    return at;
}

test("race A: the start's row lands after the signal's write but its generation began BEFORE the signal: covered, enforced", async () => {
    await startAroundSignal({ generationOffsetMs: -500 });
    assert.equal(await fenced(), true);
});

test("race B: a start racing the signal (its generation after it, the teacher's activity recorded BEFORE the signal): covered, enforced", async () => {
    await startAroundSignal({ generationOffsetMs: 500, activityOffsetMs: null });
    assert.equal(await fenced(), true);
});

test("race C: the teacher's ordinary return (activity recorded, then the start): the new generation is theirs, not covered", async () => {
    // A return after the window (a cancellation within it clears the fence anyway).
    await startAroundSignal({ generationOffsetMs: CONFIRM_MS + 600, activityOffsetMs: CONFIRM_MS + 400 });
    assert.equal(await fenced(), false);
});

test("race D: the worker's clear of an uncovered provisional fence never interleaves with a start (teacher lock): busy, then it sees the row", async () => {
    prepare();
    const at = await signalAgo(CONFIRM_MS + 2_000);
    let release;
    const held = quiet(() => lockLib.withTeacherYouTubeLock(TEACHER, () => new Promise(resolve => { release = resolve; })));
    await settle();

    assert.deepEqual(await run(jitsi().controller), { status: "busy" }, "no clear while a start may be writing");
    assert.equal(currentSession().jibriStopState, "provisional");

    // The start (holding the lock) wrote a generation from before the signal.
    yt.streamActive = false;
    release();
    await held;
    await quiet(() => page().startConfirmed("recording"));
    recordingRow().generationStartedAt = new Date(at.getTime() - 200);
    currentSession().teacherActiveAfterDepartureAt = null;

    const result = await run(jitsi().controller);
    assert.notEqual(result.status, "cleared");
    assert.equal(currentSession().jibriStopState, "pending", "covered: made a confirmed fence, not cleared");
    assert.equal(await fenced(), true, "kept and enforced");
});

// ---- Worker identity -------------------------------------------------------------------------------

test("identity: the JWT secret fingerprint is non-reversible, stable, and differs per secret", () => {
    const a = stopConfig.jibriJwtSecretFingerprint("secret-one");
    assert.equal(a, stopConfig.jibriJwtSecretFingerprint("secret-one"));
    assert.notEqual(a, stopConfig.jibriJwtSecretFingerprint("secret-two"));
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.ok(!a.includes("secret"));
});

test("configuration mismatch (any field): unavailable, fenced teachers get 503; the admin view names the field, never a secret or fingerprint", async () => {
    const fields = {
        workerJitsiDomain: ["jitsiDomain", "other.example.test"],
        workerWebsocketUrl: ["websocketUrl", "wss://other.example.test/xmpp-websocket"],
        workerMucDomain: ["mucDomain", "muc.other.example.test"],
        workerRecorderDomain: ["recorderDomain", "rec.other.example.test"],
        workerFocusJid: ["focusJid", "focus@auth.other.example.test"],
        workerJwtIssuer: ["jwtIssuer", "someone-else"],
        workerJwtAudience: ["jwtAudience", "elsewhere"],
        workerVersion: ["workerVersion", "jibri-stop-worker/2"]
    };

    for (const [column, [field, value]] of Object.entries(fields)) {
        controlOn({ [column]: value });
        const health = fenceControl.jibriWorkerHealth(db.control, new Date());
        assert.equal(health.healthy, false, field);
        assert.equal(health.status, "unavailable", field);
        assert.deepEqual(health.fields, [field], field);
    }

    // Another JWT secret: only the fingerprint differs; its value is never shown.
    await departedAndYouTubeEnded("separate");
    const otherSecret = workerIdentityColumns(CONFIG, { ...process.env, JITSI_JWT_SECRET: "another-secret" });
    controlOn({ workerJwtFingerprint: otherSecret.workerJwtFingerprint });
    const refused = await startRecording(LECTURE_2);
    assert.equal(refused.status, 503);

    session.adminId = "admin-3";
    const listed = await (await quiet(() => listRoute.GET())).json();
    const row = listed.data.health.identity.find(r => r.field === "jwtSecretFingerprint");
    assert.deepEqual(row, { field: "jwtSecretFingerprint", matches: false, secret: true, expected: null, reported: null });
    assert.equal(listed.data.health.worker.reason, "config-mismatch");
    assert.deepEqual(listed.data.health.worker.fields, ["jwtSecretFingerprint"]);
    const json = JSON.stringify(listed);
    assert.ok(!json.includes(otherSecret.workerJwtFingerprint), "the worker's fingerprint is not shown");
    assert.ok(!json.includes(workerIdentityColumns().workerJwtFingerprint), "nor the app's");
    assert.ok(!json.includes(process.env.JITSI_JWT_SECRET));
    assert.equal(listed.data.health.identity.find(r => r.field === "jitsiDomain").expected, DOMAIN, "non-secret values are shown");
});

test("switching the mode to on is refused unless the worker is ready (identity, liveness, sweep, login); drain and off always allowed", async () => {
    prepare();
    session.adminId = "admin-3";
    const call = body => quiet(() => modeRoute.POST(new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) })));
    const reason = "Enabling after the worker check.";

    for (const extra of [
        { heartbeatAt: null },
        { workerFocusJid: "focus@auth.other.example.test" },
        { lastXmppAuthAt: null },
        { lastConnectionError: "wrong-server", lastConnectionErrorAt: new Date(Date.now() + 1_000) },
        { sweepCompletedAt: new Date(Date.now() - 400_000), workerStartedAt: new Date(Date.now() - 400_000) }
    ]) {
        controlOn({ mode: "off", workerMode: "off", ...extra });
        const response = await call({ mode: "on", reason });
        const body = await response.json();
        assert.equal(response.status, 409, JSON.stringify(extra));
        assert.ok(JSON.stringify(body).includes("JIBRI_WORKER_NOT_READY"), JSON.stringify(body));
        assert.equal(db.control.mode, "off", "unchanged");
    }

    controlOn({ mode: "off", workerMode: "off", heartbeatAt: null });
    assert.equal((await call({ mode: "drain", reason })).status, 200, "drain is always allowed");
    assert.equal((await call({ mode: "off", reason })).status, 200, "off is always allowed");

    controlOn({ mode: "off", workerMode: "off" });
    assert.equal((await call({ mode: "on", reason })).status, 200, "a ready worker");
    assert.equal(db.control.mode, "on");
});

// ---- Connection proof -----------------------------------------------------------------------------

test("a healthy heartbeat with a failed Jitsi login is NOT healthy: degraded (xmpp-failing); fenced teachers get 503", async () => {
    await departedAndYouTubeEnded("separate");
    const { room, controller } = jitsi({ connectError: true });
    const result = await run(controller, new Date(Date.now() + 1_000));

    assert.equal(result.outcome, "connect-failed");
    assert.equal(db.control.lastConnectionError, "connect-failed");
    assert.ok(db.control.heartbeatAt instanceof Date, "liveness itself is fine");
    assert.equal(room.opens.length, 1);

    const health = fenceControl.jibriWorkerHealth(db.control, new Date());
    assert.deepEqual([health.status, health.reason, health.error], ["degraded", "xmpp-failing", "connect-failed"]);
    yt.streamActive = false;
    assert.equal((await startRecording(LECTURE_2)).status, 503);

    // A later successful login clears it.
    await run(jitsi().controller, new Date(Date.now() + 31_000));
    assert.ok(db.control.lastXmppAuthAt > db.control.lastConnectionErrorAt);
    assert.equal(fenceControl.jibriWorkerHealth(db.control, new Date()).healthy, true);
});

test("a different Jitsi server (bound JID of another domain, or none): wrong-server, no join, no STOP, degraded health", async () => {
    for (const serverDomain of ["meet.someone-else.test", null]) {
        await departedAndYouTubeEnded("separate");
        const { room, controller } = jitsi({ serverDomain });
        const result = await run(controller, new Date(Date.now() + 1_000));

        assert.equal(result.outcome, "wrong-server", String(serverDomain));
        assert.equal(result.stopSent, false);
        assert.equal(stopIqs(room).length, 0);
        assert.equal(room.sent.filter(s => s.name === "presence").length, 0, "never joined");
        assert.equal(db.control.lastConnectionError, "wrong-server");
        assert.equal(fenceControl.jibriWorkerHealth(db.control, new Date()).reason, "xmpp-failing");
        assert.equal(currentSession().jibriStopState, "pending", "nothing released");
    }
});

test("a missing room join (refused, or not a moderator): degraded (room-join-failing) until a later join; old failures expire", async () => {
    for (const [script, code] of [[{ joinError: "forbidden" }, "join-failed"], [{ selfRole: "participant" }, "not-moderator"]]) {
        await departedAndYouTubeEnded("separate");
        await run(jitsi(script).controller, new Date(Date.now() + 1_000));
        assert.equal(db.control.lastConnectionError, code);
        assert.ok(db.control.lastXmppAuthAt instanceof Date, "the login itself worked");
        const health = fenceControl.jibriWorkerHealth(db.control, new Date());
        assert.deepEqual([health.status, health.reason, health.error], ["degraded", "room-join-failing", code]);
    }

    controlOn({ lastConnectionError: "join-failed", lastConnectionErrorAt: new Date(Date.now() - 1_900_000), lastRoomJoinAt: null });
    assert.equal(fenceControl.jibriWorkerHealth(db.control, new Date()).healthy, true, "older than 30 min");

    await departedAndYouTubeEnded("separate");
    await run(jitsi().controller);
    assert.ok(db.control.lastRoomJoinAt instanceof Date, "a successful moderator join is recorded");
});

test("the login probe: the expected server only; never joins a room; failures carry a code", async () => {
    const probe = async script => {
        const fake = createFakeJitsi(script);
        const controller = createJibriController({ transport: fake.transport, connectTimeoutMs: 200 });
        const result = await controller.probeConnection({
            websocketUrl: CONFIG.websocketUrl, xmppDomain: DOMAIN, roomName: "saastution-probe-jibristop",
            token: "t", deadlineAt: Date.now() + 1_000
        });
        return { result, fake };
    };

    const ok = await probe({});
    assert.deepEqual(ok.result, { ok: true });
    assert.equal(ok.fake.room.sent.length, 0, "nothing sent: no join");
    assert.equal(ok.fake.room.closes, 1);
    assert.deepEqual((await probe({ serverDomain: "meet.someone-else.test" })).result, { ok: false, error: "wrong-server" });
    assert.deepEqual((await probe({ connectError: true })).result, { ok: false, error: "connect-failed" });
});

// ---- Liveness vs sweep progress -------------------------------------------------------------------

test("health thresholds: stale liveness, a long sweep (not stalled), a stalled sweep, a fresh worker's grace, an old login", () => {
    const now = new Date();
    const ago = ms => new Date(now.getTime() - ms);
    controlOn();
    const base = { ...db.control };
    const health = extra => fenceControl.jibriWorkerHealth({ ...base, ...extra }, now);

    assert.equal(health({}).healthy, true);
    assert.equal(health({ heartbeatAt: ago(61_000) }).reason, "stale");
    assert.equal(health({ sweepCompletedAt: ago(200_000), workerStartedAt: ago(3_600_000) }).healthy, true, "a long sweep is not a dead worker");
    assert.deepEqual(
        (({ status, reason }) => ({ status, reason }))(health({ sweepCompletedAt: ago(301_000), workerStartedAt: ago(3_600_000) })),
        { status: "unavailable", reason: "sweep-stalled" }
    );
    assert.equal(health({ sweepCompletedAt: null, workerStartedAt: ago(10_000) }).healthy, true, "a restarted worker: grace for its first sweep");
    assert.equal(health({ sweepCompletedAt: null, workerStartedAt: ago(301_000) }).reason, "sweep-stalled");
    assert.equal(health({ lastXmppAuthAt: ago(901_000) }).reason, "xmpp-unverified");
    assert.equal(health({ lastXmppAuthAt: null }).reason, "xmpp-unverified");
});

test("several long attempts in one sweep: liveness keeps being written meanwhile, the sweep is time-boxed, then completes", async () => {
    await departedAndYouTubeEnded("separate");
    // A second open fence (another lecture's session).
    Object.assign(sessionOf(LECTURE_2), {
        isActive: true, teacherDepartureAt: new Date(Date.now() - 60_000), teacherActiveAfterDepartureAt: null,
        jibriStopDepartureAt: new Date(Date.now() - 60_000), jibriStopState: "pending", jibriStopStreamId: "stream-1"
    });
    controlOn({ heartbeatAt: null, sweepCompletedAt: null, sweepStartedAt: null });

    const slow = jitsi();
    const controller = {
        calls: 0,
        async stopStreamInRoom(request) {
            controller.calls += 1;
            await new Promise(resolve => setTimeout(resolve, 150));
            return slow.controller.stopStreamInRoom(request);
        }
    };
    const writes = [];
    const restore = patchPrisma("jibriShutdownControl", "upsert", original => async args => {
        writes.push({ at: Date.now(), keys: Object.keys(args.update) });
        return original(args);
    });

    let worker;
    try {
        worker = await quiet(() => startJibriStopWorker({
            env: { ...JWT_ENV, JITSI_DOMAIN: DOMAIN, JITSI_JWT_SECRET: process.env.JITSI_JWT_SECRET, JIBRI_SERVER_STOP: "on" },
            intervalMs: 20, livenessIntervalMs: 25, probeIntervalMs: 60_000, sweepBudgetMs: 100,
            createController: async () => controller
        }));
        for (let i = 0; i < 100 && !writes.some(w => w.keys.includes("sweepCompletedAt")); i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    } finally {
        await quiet(() => worker?.stop());
        restore();
    }

    const firstSweepDone = writes.find(w => w.keys.includes("sweepCompletedAt"));
    assert.ok(firstSweepDone, "the sweep completed");
    const livenessDuringSweep = writes.filter(w => w.keys.includes("heartbeatAt") && w.at < firstSweepDone.at);
    assert.ok(livenessDuringSweep.length >= 3, `liveness written during the long sweep (${livenessDuringSweep.length})`);
    assert.equal(controller.calls >= 1, true);
    assert.ok(db.control.sweepCompletedAt instanceof Date);
});

test("the sweep's time box: no new session is started after it (the rest wait for the next sweep)", async () => {
    await departedAndYouTubeEnded("separate");
    Object.assign(sessionOf(LECTURE_2), {
        isActive: true, teacherDepartureAt: new Date(Date.now() - 60_000), teacherActiveAfterDepartureAt: null,
        jibriStopDepartureAt: new Date(Date.now() - 60_000), jibriStopState: "pending", jibriStopStreamId: "stream-1"
    });
    const slow = jitsi();
    const controller = {
        async stopStreamInRoom(request) {
            await new Promise(resolve => setTimeout(resolve, 120));
            return slow.controller.stopStreamInRoom(request);
        }
    };

    const results = await quiet(() => jibriStop.sweepJibriStops({ controller, config: CONFIG, readStreamIngest, sweepBudgetMs: 50 }));
    assert.equal(results.filter(r => r.result.status === "attempted").length, 1, "one attempt, then the time box ended the sweep");
});

test("worker restart: a fresh liveness, a login probe at start, sweeps; a stale worker becomes healthy again", async () => {
    prepare();
    controlOn({ heartbeatAt: new Date(Date.now() - 120_000), lastXmppAuthAt: null, sweepCompletedAt: null, workerStartedAt: new Date(Date.now() - 3_600_000) });
    assert.equal(fenceControl.jibriWorkerHealth(db.control, new Date()).reason, "stale", "the old worker is gone");

    const fake = createFakeJitsi();
    const controller = createJibriController({ transport: fake.transport, connectTimeoutMs: 200 });
    let worker;
    try {
        worker = await quiet(() => startJibriStopWorker({
            // The same Jitsi settings as this app (its issuer / audience included).
            env: {
                ...JWT_ENV, JITSI_DOMAIN: DOMAIN, JITSI_JWT_SECRET: process.env.JITSI_JWT_SECRET,
                JITSI_JWT_ISS: process.env.JITSI_JWT_ISS, JITSI_JWT_AUD: process.env.JITSI_JWT_AUD, JIBRI_SERVER_STOP: "on"
            },
            intervalMs: 20, livenessIntervalMs: 20, probeIntervalMs: 60_000, createController: async () => controller
        }));
        for (let i = 0; i < 100 && !(db.control.lastXmppAuthAt && db.control.sweepCompletedAt); i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    } finally {
        await quiet(() => worker?.stop());
    }

    assert.ok(db.control.workerStartedAt > new Date(Date.now() - 60_000), "a new start time");
    assert.ok(db.control.lastXmppAuthAt instanceof Date, "the probe proved a login to the expected server");
    assert.equal(fake.room.sent.filter(s => s.name === "presence").length, 0, "the probe joined no room");
    assert.deepEqual(fenceControl.jibriWorkerHealth(db.control, new Date()), { healthy: true });
});
