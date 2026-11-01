/*
 * Teacher-departure stop against slow / unanswered YouTube requests:
 *
 * - its own budget (departureStopMs), always inside the lecture lock's
 *   deadline; the `complete` transition's own limit (transitionMs);
 * - Recording and Live ended side by side, with ONE Google token request;
 *   one transition for a broadcast they share;
 * - an unanswered transition is ambiguous (YouTube may still apply it): the
 *   send time is recorded before sending, nothing is resent within the 60 s
 *   cooldown (any process, after a restart or an expired lock), and a later
 *   YouTube completion counts as the departure's only when it is consistent
 *   with that request;
 * - End Session cleanup keeps its own limits and sequence.
 *
 *   npm run test:youtube
 *
 * Real code through tsx: lib/youtube-feature-lifecycle.ts, lib/youtube-live.ts,
 * lib/youtube-auth.ts, lib/youtube-request.ts, lib/youtube-operation-lock.ts,
 * lib/teacher-departure-sweep.ts. Fakes: an in-memory Prisma, the token
 * decryption, and a scripted global fetch playing YouTube and Google (with
 * latency, and transitions YouTube applies even after we stopped waiting).
 * Times are scaled down (100 ms requests, 250 ms transitions, 400 ms budget).
 * Nothing contacts YouTube, Google or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

function fake(relativePath, exports) {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);

    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
}

// ---- In-memory database --------------------------------------------------------------

const TEACHER = "teacher-1";
const LECTURE = "lecture-1";
const SESSION = "session-1";

const db = { recordings: [], lives: [], sessions: [], connection: null, locks: new Map(), lockLog: [] };

function matchValue(actual, cond) {
    if (cond === null) return actual == null;
    if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
    if (cond && typeof cond === "object") {
        return Object.entries(cond).every(([op, v]) => {
            switch (op) {
                case "in": return v.includes(actual);
                case "not": return v === null ? actual != null : actual != null && !matchValue(actual, v);
                case "gte": return actual != null && actual >= v;
                case "lte": return actual != null && actual <= v;
                case "lt": return actual != null && actual < v;
                default: return true;
            }
        });
    }
    return actual === cond;
}

const matches = (row, where = {}) => Object.entries(where).every(([key, value]) =>
    key === "OR" ? value.some(clause => matches(row, clause)) : key === "class" || key === "lecture" ? true : matchValue(row[key], value));

function table(rows) {
    return {
        findMany: async ({ where } = {}) => rows().filter(r => matches(r, where)).map(r => ({ ...r })),
        findFirst: async ({ where } = {}) => {
            const found = rows().filter(r => matches(r, where));
            return found[0] ? { ...found[0] } : null;
        },
        updateMany: async ({ where, data }) => {
            const found = rows().filter(r => matches(r, where));
            found.forEach(r => {
                Object.assign(r, { updatedAt: new Date() });
                // Plain values, or { increment: n } (as Prisma).
                for (const [key, value] of Object.entries(data)) {
                    r[key] = value && typeof value === "object" && "increment" in value ? (r[key] ?? 0) + value.increment : value;
                }
            });
            return { count: found.length };
        }
    };
}

fake("lib/prisma.ts", {
    prisma: {
        youTubeRecording: table(() => db.recordings),
        youTubeLiveBroadcast: table(() => db.lives),
        classSession: {
            ...table(() => db.sessions),
            findMany: async ({ where }) => db.sessions.filter(r => matches(r, where)).map(r => ({ id: r.id, lectureId: r.lectureId }))
        },
        lecture: {
            findUnique: async ({ where }) => (where.id === LECTURE ? { id: LECTURE, classId: "class-1", class: { teacherId: TEACHER } } : null)
        },
        youTubeConnection: {
            findUnique: async ({ where }) => (where.teacherId === TEACHER && db.connection ? { ...db.connection } : null),
            updateMany: async ({ data }) => {
                Object.assign(db.connection, data);
                return { count: 1 };
            }
        },
        // The shared Jibri shutdown control (lib/jibri-fence-control.ts): no row,
        // mode off. Departures arm no fence and stop exactly as before.
        jibriShutdownControl: {
            findUnique: async () => null
        },
        // Unique insert, expired takeover, delete by owner (as Postgres).
        youTubeOperationLock: {
            create: async ({ data }) => {
                if (db.locks.has(data.lectureId)) {
                    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                }
                db.locks.set(data.lectureId, { ...data });
                db.lockLog.push({ ...data });
                return { ...data };
            },
            updateMany: async ({ where, data }) => {
                const row = db.locks.get(where.lectureId);
                if (!row || !(row.expiresAt < where.expiresAt.lt)) return { count: 0 };
                Object.assign(row, data);
                db.lockLog.push({ ...row });
                return { count: 1 };
            },
            deleteMany: async ({ where }) => {
                const row = db.locks.get(where.lectureId);
                if (!row || row.ownerId !== where.ownerId) return { count: 0 };
                db.locks.delete(where.lectureId);
                return { count: 1 };
            }
        }
    }
});
fake("lib/youtube-crypto.ts", { decryptYouTubeToken: () => "refresh-token" });

process.env.GOOGLE_YOUTUBE_CLIENT_ID = "client-id";
process.env.GOOGLE_YOUTUBE_CLIENT_SECRET = "client-secret";

// ---- Scripted YouTube and Google ---------------------------------------------------------

const yt = {
    broadcasts: new Map(),
    tokens: 0,
    lookups: [],
    transitions: [],
    // How long YouTube takes to apply and answer a transition.
    transitionLatencyMs: 0,
    // false: a transition we stopped waiting for is never applied.
    appliesAfterAbort: true,
    // broadcastId -> HTTP status of a refused transition.
    refuse: new Map(),
    tokenError: null,
    // Answers about ANOTHER broadcast ID (lookups / the transition).
    mismatch: false
};

const respond = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const view = id => {
    const b = yt.broadcasts.get(id);
    return {
        id,
        snippet: b.actualEndTime ? { actualEndTime: b.actualEndTime.toISOString() } : {},
        status: { lifeCycleStatus: b.lifecycle }
    };
};

globalThis.fetch = (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));

    if (url.host === "oauth2.googleapis.com") {
        yt.tokens += 1;
        return Promise.resolve(yt.tokenError ? respond(yt.tokenError, 400) : respond({ access_token: "access" }));
    }

    const id = url.searchParams.get("id");

    if (url.pathname.endsWith("/liveBroadcasts/transition")) {
        yt.transitions.push({ id, at: Date.now() });

        if (yt.refuse.has(id)) {
            return Promise.resolve(respond({ error: { errors: [{ reason: "backendError" }] } }, yt.refuse.get(id)));
        }

        return new Promise((resolve, reject) => {
            // YouTube applies it after its latency, whether or not we still wait.
            const applied = setTimeout(() => {
                const b = yt.broadcasts.get(id);

                if (b.lifecycle !== "complete") {
                    b.lifecycle = "complete";
                    b.actualEndTime = new Date();
                }
                resolve(respond(yt.mismatch ? { ...view(id), id: "bc-other" } : view(id)));
            }, yt.transitionLatencyMs);

            init.signal?.addEventListener("abort", () => {
                if (!yt.appliesAfterAbort) clearTimeout(applied);
                reject(init.signal.reason);
            });
        });
    }

    yt.lookups.push(id);
    if (yt.mismatch && yt.broadcasts.has(id)) return Promise.resolve(respond({ items: [{ ...view(id), id: "bc-other" }] }));
    return Promise.resolve(respond({ items: yt.broadcasts.has(id) ? [view(id)] : [] }));
};

// ---- Modules ----------------------------------------------------------------------------

const request = require(path.join(root, "lib/youtube-request.ts"));
const auth = require(path.join(root, "lib/youtube-auth.ts"));
const lifecyclePath = path.join(root, "lib/youtube-feature-lifecycle.ts");
const lifecycle = require(lifecyclePath);
const sweep = require(path.join(root, "lib/teacher-departure-sweep.ts"));

const DEFAULTS = { ...request.youtubeTimeouts };
const SCALED = {
    requestMs: 100,
    transitionMs: 250,
    departureStopMs: 400,
    lockTtlMs: 600,
    lockSafetyMarginMs: 150,
    sessionCleanupMs: 150,
    sessionCleanupLockRetriesMs: [5, 10]
};

// ---- Helpers ----------------------------------------------------------------------------

const ago = ms => new Date(Date.now() - ms);

function reset({ shared = false, timeouts = {} } = {}) {
    Object.assign(request.youtubeTimeouts, DEFAULTS, SCALED, timeouts);
    yt.broadcasts = new Map();
    yt.tokens = 0;
    yt.lookups = [];
    yt.transitions = [];
    yt.transitionLatencyMs = 0;
    yt.appliesAfterAbort = true;
    yt.refuse = new Map();
    yt.tokenError = null;
    yt.mismatch = false;
    db.locks.clear();
    db.lockLog = [];
    db.connection = { teacherId: TEACHER, refreshTokenEncrypted: "enc", status: "CONNECTED" };

    // The teacher closed the tab a minute ago (confirmed); both features were running.
    db.sessions = [{
        id: SESSION, lectureId: LECTURE, isActive: true, startedAt: ago(3_600_000),
        teacherDepartureAt: ago(60_000), teacherActiveAfterDepartureAt: null
    }];

    const recordingBroadcast = shared ? "bc-shared" : "bc-rec";
    const liveBroadcast = shared ? "bc-shared" : "bc-live";
    const row = (id, broadcastId) => ({
        id, lectureId: LECTURE, broadcastId, status: "LIVE", createdAt: ago(600_000), updatedAt: ago(600_000), autoStopSendCount: 0,
        endedAt: null, version: 0, stopReason: null, autoStopAttemptedAt: null, autoStopError: null
    });

    db.recordings = [row("rec-1", recordingBroadcast)];
    db.lives = [row("live-1", liveBroadcast)];

    for (const id of new Set([recordingBroadcast, liveBroadcast])) {
        yt.broadcasts.set(id, { lifecycle: "live", actualEndTime: null });
    }
}

const rec = () => db.recordings[0];

// `ms` pass: every recorded time (session, signal, rows, send, last check) moves back.
function elapse(ms) {
    const back = date => new Date(date.getTime() - ms);

    for (const session of db.sessions) {
        session.startedAt = back(session.startedAt);
        session.teacherDepartureAt = back(session.teacherDepartureAt);
    }
    for (const row of [...db.recordings, ...db.lives]) {
        row.createdAt = back(row.createdAt);
        if (row.autoStopAttemptedAt) row.autoStopAttemptedAt = new Date(row.autoStopAttemptedAt.getTime() - ms);
        row.updatedAt = new Date(row.updatedAt.getTime() - ms);
        if (row.autoStopCheckedAt) row.autoStopCheckedAt = back(row.autoStopCheckedAt);
        if (row.generationStartedAt) row.generationStartedAt = back(row.generationStartedAt);
    }
}
const live = () => db.lives[0];
const transitionsOf = id => yt.transitions.filter(t => t.id === id).length;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function quiet(fn) {
    const saved = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = () => {};
    try {
        return await fn();
    } finally {
        [console.log, console.warn, console.error] = saved;
    }
}

const stop = (module = lifecycle) => quiet(() => module.endYouTubeFeaturesForDepartedTeacher(LECTURE, new Date()));

function assertDeparted(row) {
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.stopReason, "TEACHER_LEFT");
    assert.ok(row.endedAt instanceof Date);
}

// ---- Configuration ----------------------------------------------------------------------

test("settings: 40 s departure budget, 10 s requests, 25 s transitions, 60 s resend cooldown; the budget fits in the lock", () => {
    assert.equal(DEFAULTS.departureStopMs, 40_000);
    assert.equal(DEFAULTS.requestMs, 10_000);
    assert.equal(DEFAULTS.transitionMs, 25_000);
    assert.equal(DEFAULTS.lockTtlMs, 60_000);
    assert.equal(DEFAULTS.lockSafetyMarginMs, 15_000);
    assert.equal(DEFAULTS.sessionCleanupMs, 15_000, "End Session cleanup unchanged");
    assert.equal(lifecycle.TRANSITION_RESEND_COOLDOWN_MS, 60_000);
    assert.ok(DEFAULTS.departureStopMs + DEFAULTS.lockSafetyMarginMs <= DEFAULTS.lockTtlMs);
    assert.ok(SCALED.departureStopMs + SCALED.lockSafetyMarginMs <= SCALED.lockTtlMs, "the scaled test settings too");
});

// ---- Slow transitions, side by side ----------------------------------------------------

test("slow transitions: Recording and Live each take longer than a normal request; both stop, side by side, one token", async () => {
    reset();
    yt.transitionLatencyMs = 180; // > requestMs (100), < transitionMs (250)

    const started = Date.now();
    const result = await stop();
    const elapsed = Date.now() - started;

    assert.equal(result.status, "done", JSON.stringify(result));
    assert.deepEqual(result.stopped.sort(), ["live", "recording"]);
    assertDeparted(rec());
    assertDeparted(live());
    assert.equal(transitionsOf("bc-rec"), 1);
    assert.equal(transitionsOf("bc-live"), 1);
    assert.ok(elapsed < 2 * 180, `side by side (${elapsed} ms), not one after the other`);
    assert.equal(yt.tokens, 1, "one Google token request for the whole stop");
    assert.equal(rec().autoStopError, null);
});

test("End Session cleanup is unchanged: sequential, normal request limit, its own budget, a token per request", async () => {
    reset();
    yt.transitionLatencyMs = 180;
    yt.appliesAfterAbort = false;

    const result = await quiet(() => lifecycle.endYouTubeFeaturesForLecture(TEACHER, LECTURE));

    assert.equal(result.status, "pending");
    assert.equal(result.reason, "timeout", "a 180 ms transition exceeds its 100 ms request limit");
    assert.equal(rec().status, "LIVE");
    assert.equal(rec().autoStopAttemptedAt, null, "End Session never writes the departure's send time");
    assert.ok(yt.tokens >= 2, "no token reuse there");
});

test("a broadcast Recording and Live share gets ONE transition; both rows close as the departure's", async () => {
    reset({ shared: true });
    yt.transitionLatencyMs = 50;

    const result = await stop();

    assert.equal(result.status, "done");
    assert.equal(transitionsOf("bc-shared"), 1);
    assertDeparted(rec());
    assertDeparted(live());
    assert.equal(rec().autoStopAttemptedAt.getTime(), live().autoStopAttemptedAt.getTime(), "one send time");
});

// ---- Ambiguous timeouts ----------------------------------------------------------------

test("timeout recovery: the transition is not answered in time but YouTube applies it; no resend, then TEACHER_LEFT", async () => {
    reset({ shared: true });
    yt.transitionLatencyMs = 320; // > transitionMs (250): we stop waiting; YouTube still applies it

    const first = await stop();

    assert.equal(first.status, "pending");
    assert.deepEqual(first.pending.map(p => p.reason), ["timeout", "timeout"]);
    assert.equal(live().status, "LIVE", "kept active: not confirmed");
    assert.equal(live().autoStopError, "timeout");

    const sentAt = live().autoStopAttemptedAt.getTime();

    assert.ok(Math.abs(sentAt - yt.transitions[0].at) < 50, "the time it was actually sent");

    await sleep(150); // YouTube applies it meanwhile

    const early = await stop();

    assert.equal(early.status, "pending", "not due yet: nothing asked");
    assert.equal(yt.lookups.length, 1);

    elapse(15_000);
    const second = await stop();

    assert.equal(second.status, "done");
    assert.equal(yt.transitions.length, 1, "never sent twice");
    assertDeparted(live());
    assertDeparted(rec());
    assert.equal(live().endedAt.getTime(), yt.broadcasts.get("bc-shared").actualEndTime.getTime(), "YouTube's end time");
});

test("cooldown: an unanswered transition is not resent for 60 s (however often the stop runs), then sent once", async () => {
    reset({ shared: true });
    yt.transitionLatencyMs = 10_000;
    yt.appliesAfterAbort = false;

    await stop();
    await stop();
    await stop();

    assert.equal(yt.transitions.length, 1);
    assert.equal(yt.lookups.length, 1, "not due: YouTube not asked at all");
    assert.equal(db.lockLog.length, 1, "not even the lock taken");
    assert.equal(live().status, "LIVE");

    // 15 s later: looked up, still live, inside the cooldown: not resent.
    elapse(15_000);
    await stop();
    assert.equal(yt.lookups.length, 2);
    assert.equal(yt.transitions.length, 1);

    // 60 s after the send: resent once.
    elapse(lifecycle.TRANSITION_RESEND_COOLDOWN_MS);
    yt.transitionLatencyMs = 20;

    assert.equal((await stop()).status, "done");
    assert.equal(yt.transitions.length, 2);
});

test("conservative: YouTube's completion is the departure's only after OUR unanswered transition, within 60 s of it", async () => {
    // (a) YouTube ended it before we sent anything (auto-stop, a Jibri failure).
    reset();
    for (const id of ["bc-rec", "bc-live"]) Object.assign(yt.broadcasts.get(id), { lifecycle: "complete", actualEndTime: ago(30_000) });
    await stop();
    assert.equal(rec().stopReason, "YOUTUBE_ENDED");
    assert.equal(live().stopReason, "YOUTUBE_ENDED");
    assert.equal(yt.transitions.length, 0);

    // (b) Our transition was refused (an answer: not applied); YouTube's auto-stop ends it later.
    reset({ shared: true });
    yt.refuse.set("bc-shared", 503);
    await stop();
    assert.equal(live().autoStopError, "youtube");
    Object.assign(yt.broadcasts.get("bc-shared"), { lifecycle: "complete", actualEndTime: new Date() });
    elapse(15_000);
    await stop();
    // Our `complete` was requested (completeRequestedAt) before YouTube ended it:
    // neither YouTube's end nor the departure's is claimed.
    assert.equal(live().stopReason, null, "a refused request: not the departure's, not claimed as YouTube's");
    assert.notEqual(live().stopReason, "TEACHER_LEFT");

    // (c) Unanswered, but YouTube ended it more than 60 s after our send.
    reset({ shared: true });
    yt.transitionLatencyMs = 10_000;
    yt.appliesAfterAbort = false;
    await stop();
    elapse(15_000);
    const sentAt = live().autoStopAttemptedAt.getTime();
    Object.assign(yt.broadcasts.get("bc-shared"), { lifecycle: "complete", actualEndTime: new Date(sentAt + 61_000) });
    await stop();
    assert.equal(live().stopReason, null, "too late to be the departure's; requested before, so not claimed as YouTube's either");

    // (d) Unanswered, and YouTube ended it BEFORE our send.
    reset({ shared: true });
    yt.transitionLatencyMs = 10_000;
    yt.appliesAfterAbort = false;
    await stop();
    elapse(15_000);
    Object.assign(yt.broadcasts.get("bc-shared"), { lifecycle: "complete", actualEndTime: new Date(live().autoStopAttemptedAt.getTime() - 1_000) });
    await stop();
    assert.equal(live().stopReason, "YOUTUBE_ENDED", "ended before our request: YouTube's");

    // (e) Complete without an end time: no reason at all.
    reset({ shared: true });
    Object.assign(yt.broadcasts.get("bc-shared"), { lifecycle: "complete", actualEndTime: null });
    await stop();
    assert.equal(live().status, "COMPLETE");
    assert.equal(live().stopReason, null);
});

// ---- The lock -----------------------------------------------------------------------------

test("stalled YouTube: the whole stop ends within its budget and before the lock's safety margin", async () => {
    reset();
    yt.transitionLatencyMs = 60_000;
    yt.appliesAfterAbort = false;

    const started = Date.now();
    const result = await stop();
    const finished = Date.now();
    const lockRow = db.lockLog[0];

    assert.equal(result.status, "pending");
    assert.ok(finished - started < SCALED.departureStopMs + 100, `within the budget (${finished - started} ms)`);
    assert.ok(finished <= lockRow.expiresAt.getTime() - SCALED.lockSafetyMarginMs + 100, "before the lock could be taken over");
    assert.equal(db.locks.size, 0, "released");

    // A budget set too large is still capped by the lock's deadline.
    reset({ timeouts: { departureStopMs: 5_000, transitionMs: 5_000 } });
    yt.transitionLatencyMs = 60_000;
    yt.appliesAfterAbort = false;

    const capped = Date.now();

    await stop();
    assert.ok(Date.now() - capped < SCALED.lockTtlMs - SCALED.lockSafetyMarginMs + 100, "capped by the lock lifetime");
});

test("lock expiry / another process: a second holder never resends a transition that may still be in flight", async () => {
    reset({ shared: true });
    yt.transitionLatencyMs = 60_000;
    yt.appliesAfterAbort = false;

    const first = stop();

    // Bounded: if the stop never sends (it failed), fail here instead of waiting forever.
    const sendDeadline = Date.now() + 10_000;
    while (yt.transitions.length === 0) {
        if (Date.now() > sendDeadline) {
            const outcome = await Promise.race([first, sleep(0).then(() => "still running")]);
            assert.fail(`the first stop sent no transition within 10 s: ${JSON.stringify(outcome)}`);
        }
        await sleep(5);
    }

    // The first holder is still waiting on YouTube; its lock is taken over as
    // if it had expired, by another server process (a fresh module).
    db.locks.get(LECTURE).expiresAt = ago(1);
    elapse(15_000);
    delete require.cache[lifecyclePath];
    const otherProcess = require(lifecyclePath);

    const second = await stop(otherProcess);

    assert.equal(second.status, "pending");
    assert.equal(yt.transitions.length, 1, "the send time written before sending stopped it");
    assert.equal((await first).status, "pending");
    assert.equal(yt.transitions.length, 1);

    // A restart (fresh module) within the cooldown: still nothing resent.
    delete require.cache[lifecyclePath];
    await stop(require(lifecyclePath));
    assert.equal(yt.transitions.length, 1);
});

test("concurrent processing (sweeps, a student's check, direct calls): one transition per broadcast", async () => {
    reset();
    yt.transitionLatencyMs = 60;

    const runs = await quiet(() => Promise.all([
        sweep.sweepDepartedTeachers(new Date()),
        sweep.checkLectureForDepartedTeacher(LECTURE, new Date(Date.now() + 3_600_000)),
        lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, new Date()),
        lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, new Date())
    ]));
    const statuses = runs.map(r => (Array.isArray(r) ? r[0]?.result.status : r?.status));

    assert.equal(statuses.filter(s => s === "done").length, 1, JSON.stringify(statuses));
    assert.equal(transitionsOf("bc-rec"), 1);
    assert.equal(transitionsOf("bc-live"), 1);
    assertDeparted(rec());
    assertDeparted(live());
});

// ---- Authorization and tokens ------------------------------------------------------------

test("expired authorization: no transition is sent (no send time); Google is not asked again until reconnected", async () => {
    reset();
    yt.tokenError = { error: "invalid_grant" };

    const result = await stop();

    assert.deepEqual(result.pending.map(p => p.reason), ["reauth-required", "reauth-required"]);
    assert.equal(yt.transitions.length, 0);
    assert.equal(rec().autoStopAttemptedAt, null, "nothing was sent");
    assert.equal(db.connection.status, "REAUTH_REQUIRED");

    const tokens = yt.tokens;

    await stop();
    assert.equal(yt.tokens, tokens, "not asked again");
});

test("token reuse is per operation: parallel callers share one request; outside it, or after a failure, Google is asked again", async () => {
    reset();

    await auth.withYouTubeAccessTokenReuse(() => Promise.all([
        auth.getYouTubeAccessToken("enc"),
        auth.getYouTubeAccessToken("enc"),
        auth.getYouTubeAccessToken("enc")
    ]));
    assert.equal(yt.tokens, 1);

    await auth.getYouTubeAccessToken("enc");
    await auth.getYouTubeAccessToken("enc");
    assert.equal(yt.tokens, 3, "no reuse outside an operation (End Session, starts, Stop)");

    yt.tokens = 0;
    yt.tokenError = { error: "temporarily_unavailable" };
    await auth.withYouTubeAccessTokenReuse(async () => {
        await assert.rejects(quiet(() => auth.getYouTubeAccessToken("enc")));
        yt.tokenError = null;
        assert.equal(await auth.getYouTubeAccessToken("enc"), "access", "a failed request is not kept");
    });
    assert.equal(yt.tokens, 2);
});

// ---- Quota: the adaptive retry schedule ---------------------------------------------------

test("schedules: lookups every 30 s / 2 min / 5 min as the stop ages, plus one 15 s after each send; resends never within 60 s, then 5 and 15 min", () => {
    assert.deepEqual(lifecycle.DEPARTURE_LOOKUP_SCHEDULE.map(s => [s.untilAgeMs, s.everyMs]), [
        [300_000, 30_000], [1_800_000, 120_000], [7_200_000, 300_000], [Infinity, 900_000]
    ]);
    assert.equal(lifecycle.DEPARTURE_CHECK_AFTER_SEND_MS, 15_000);
    assert.deepEqual(lifecycle.DEPARTURE_RESEND_SCHEDULE.map(s => [s.untilAgeMs, s.everyMs]), [
        [300_000, 60_000], [1_800_000, 300_000], [Infinity, 900_000]
    ]);
    assert.ok(lifecycle.DEPARTURE_RESEND_SCHEDULE.every(s => s.everyMs >= lifecycle.TRANSITION_RESEND_COOLDOWN_MS));
});

test("quota: an unresolved stop over 40 minutes of 5 s passes asks YouTube by the schedule, never resends within 60 s, and keeps retrying", async () => {
    reset({ shared: true });
    yt.transitionLatencyMs = 60_000;
    yt.appliesAfterAbort = false; // YouTube never confirms

    const sends = [];
    let simulated = 0;
    let passes = 0;

    while (simulated <= 40 * 60_000) {
        const before = yt.transitions.length;

        await stop();
        passes += 1;
        if (yt.transitions.length > before) sends.push(simulated);

        elapse(5_000);
        simulated += 5_000;
    }

    assert.ok(passes >= 480);
    assert.ok(yt.lookups.length <= 45, `lookups by the schedule (${yt.lookups.length} for ${passes} passes)`);
    assert.ok(yt.lookups.length >= 15, "still checked regularly");
    assert.ok(sends.length >= 5, `eventually retried (${sends.length} transitions)`);
    assert.ok(sends.length <= 12, `resends back off (${sends.length} transitions)`);

    for (let i = 1; i < sends.length; i++) {
        assert.ok(sends[i] - sends[i - 1] >= lifecycle.TRANSITION_RESEND_COOLDOWN_MS, `no resend within 60 s (${sends[i] - sends[i - 1]} ms)`);
    }

    assert.equal(live().status, "LIVE", "still active: never claimed as stopped");
    assert.equal(live().autoStopError, "timeout");
});

test("passes with nothing due take no lock and ask YouTube nothing (any process, after a restart)", async () => {
    reset({ shared: true });
    yt.transitionLatencyMs = 60_000;
    yt.appliesAfterAbort = false;

    await stop();

    const locks = db.lockLog.length;
    const lookups = yt.lookups.length;

    for (let i = 0; i < 5; i++) {
        delete require.cache[lifecyclePath];
        await stop(require(lifecyclePath));
        await sweep.sweepDepartedTeachers(new Date());
    }

    assert.equal(db.lockLog.length, locks, "no lock taken");
    assert.equal(yt.lookups.length, lookups, "no YouTube request");
    assert.equal(yt.transitions.length, 1);
});

test("the teacher's return asks YouTube at once (accurate notice) but never resends within the cooldown", async () => {
    reset({ shared: true });
    yt.transitionLatencyMs = 320; // unanswered in time; YouTube applies it

    await stop();
    await sleep(150);

    const back = await quiet(() => lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, new Date(), { lookupNow: true }));

    assert.equal(back.status, "done");
    assertDeparted(live());
    assert.equal(yt.transitions.length, 1);

    // Still live on YouTube: the return looks it up, sends nothing within the cooldown.
    reset({ shared: true });
    yt.transitionLatencyMs = 60_000;
    yt.appliesAfterAbort = false;
    await stop();
    await quiet(() => lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, new Date(), { lookupNow: true }));
    assert.equal(yt.lookups.length, 2);
    assert.equal(yt.transitions.length, 1);
});

test("the first stop is prompt even if a row was just updated by something else (never checked yet)", async () => {
    reset();
    yt.transitionLatencyMs = 20;
    for (const row of [rec(), live()]) row.updatedAt = new Date(); // e.g. a status sync promoted it

    assert.equal((await stop()).status, "done");
    assert.equal(yt.transitions.length, 2);
});

// ---- Dedicated check time ------------------------------------------------------------

test("unrelated updates never postpone a departure check: only the departure's own lookups count (autoStopCheckedAt)", async () => {
    reset({ shared: true });
    yt.transitionLatencyMs = 60_000;
    yt.appliesAfterAbort = false;

    await stop();
    assert.equal(yt.lookups.length, 1);

    // 15 s later the check after the send is due, although something else
    // (a status sync, a privacy change) has just updated the rows.
    elapse(15_000);
    for (const row of [rec(), live()]) row.updatedAt = new Date();

    await stop();
    assert.equal(yt.lookups.length, 2, "checked on schedule");
    assert.ok(live().autoStopCheckedAt.getTime() > Date.now() - 1_000, "the check is recorded in its own field");
});

// ---- Long-unresolved stops -----------------------------------------------------------

test("long-unresolved: after the transition cap, automatic transitions stop; an explicit 'unresolved' state with diagnostics; lookups go on; a later end is still recorded", async () => {
    reset({ shared: true });
    yt.refuse.set("bc-shared", 503); // every transition refused

    const errors = [];
    const saved = console.error;

    console.error = (...args) => errors.push(args.map(String).join(" "));

    try {
        for (let simulated = 0; simulated <= 3 * 60 * 60_000; simulated += 15_000) {
            await lifecycle.endYouTubeFeaturesForDepartedTeacher(LECTURE, new Date());
            elapse(15_000);
        }
    } finally {
        console.error = saved;
    }

    const sends = yt.transitions.length;

    assert.ok(sends <= lifecycle.DEPARTURE_MAX_TRANSITIONS, `capped (${sends})`);
    assert.ok(sends >= 5, `retried for a while (${sends})`);
    assert.equal(live().status, "LIVE", "never claimed as stopped");
    assert.equal(live().autoStopError, "unresolved");
    assert.equal(live().autoStopSendCount, sends, "every transition counted");
    assert.match(live().autoStopLastError, /^transition: HTTP 503 backendError$/);
    assert.equal(errors.filter(e => e.includes("UNRESOLVED")).length, 1, "logged once, with its diagnostics");

    // Still looked up (rarely): a later end on YouTube is recorded accurately.
    const lookups = yt.lookups.length;

    Object.assign(yt.broadcasts.get("bc-shared"), { lifecycle: "complete", actualEndTime: new Date() });
    elapse(15 * 60_000);
    await stop();
    assert.equal(yt.lookups.length, lookups + 1);
    assert.equal(live().status, "COMPLETE");
    assert.equal(live().stopReason, null, "long after our last (refused) send: not the departure's; requested, so not claimed as YouTube's");
    assert.equal(yt.transitions.length, sends, "no transition after giving up");
});

test("long-unresolved: two hours after the tab closed, nothing more is sent even below the cap", async () => {
    reset({ shared: true });
    elapse(2 * 60 * 60_000); // the tab closed two hours (and a minute) ago, nothing was ever sent

    const result = await stop();

    assert.deepEqual(result.pending.map(p => p.reason), ["unresolved", "unresolved"]);
    assert.equal(yt.transitions.length, 0);
    assert.equal(yt.lookups.length, 1, "looked up, so a YouTube end would still be recorded");

    // A failing lookup later does not lose the state.
    yt.broadcasts.delete("bc-shared");
    yt.broadcasts.set("bc-shared", { lifecycle: "live", actualEndTime: null });
    elapse(15 * 60_000);
    await stop();
    assert.equal(live().autoStopError, "unresolved");
});

// ---- Broadcast identity --------------------------------------------------------------------

test("H9. an answer about a different broadcast ID is invalid: never \"not found\", never a status to act on, never clears the marker", async () => {
    const youtubeLive = require(path.join(root, "lib/youtube-live.ts"));
    const { YouTubeApiError } = request;

    // The lookup itself.
    reset({ shared: true });
    yt.mismatch = true;
    Object.assign(yt.broadcasts.get("bc-shared"), { lifecycle: "complete", actualEndTime: new Date() });

    const error = await quiet(() => youtubeLive.getYouTubeLiveBroadcast("enc", "bc-shared").catch(e => e));

    assert.ok(error instanceof YouTubeApiError, String(error));
    assert.doesNotMatch(error.message, /not found/, "never taken as gone");

    // The departure: a mismatched "complete" lookup closes nothing and clears nothing.
    for (const row of [rec(), liveRow0()]) row.completeRequestedAt = ago(30_000);
    const result = await stop();

    assert.equal(result.status, "pending");
    assert.equal(liveRow0().status, "LIVE");
    assert.ok(liveRow0().completeRequestedAt instanceof Date, "kept");

    // A mismatched answer to the transition (the lookup before it is correct):
    // never a completion: the rows stay active and protected.
    reset({ shared: true });
    yt.transitionLatencyMs = 5;
    const original = globalThis.fetch;

    globalThis.fetch = (rawUrl, init) => {
        if (String(rawUrl).includes("/liveBroadcasts/transition")) yt.mismatch = true;
        return original(rawUrl, init).finally(() => { yt.mismatch = false; });
    };

    try {
        await stop();
    } finally {
        globalThis.fetch = original;
    }

    assert.equal(liveRow0().status, "LIVE", "an answer about another broadcast never closes the row");
    assert.ok(liveRow0().completeRequestedAt instanceof Date, "and the marker stays");
    assert.match(liveRow0().autoStopLastError, /answered about another broadcast \(bc-other\)/);
});

const liveRow0 = () => db.lives[0];
