/*
 * Regression tests: YouTube Recording and Live sharing one Unlisted broadcast
 * (Stage 2: persisted shared-broadcast lifecycle).
 *
 *   npm run test:youtube
 *
 * Real code through tsx: lib/youtube-lecture.ts, the four routes
 * (POST /api/youtube/lecture/recording/{start,stop}, /api/youtube/lecture/
 * {start,stop}), the reload paths (checkYouTubeRecordingStatus and the
 * teacher's getLiveSnapshot) and the page's Jibri decisions
 * (components/Jitsi/youtube-jibri.ts). Fakes: Prisma (in memory), the YouTube
 * API helpers (lib/youtube-live.ts), the login session, and a fake Jitsi that
 * counts Jibri start / stop commands. Nothing contacts YouTube or Jibri.
 *
 * The fake YouTube lets several broadcasts be live on one stream; whether real
 * YouTube allows that (Recording + a separate Public / Private Live) is not
 * tested here.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

const TEACHER = "teacher-1";
const LECTURE = "lecture-1";
const CLASS = "class-1";
const STREAM = "stream-1";

// ---- Fake database ---------------------------------------------------------

const db = { recordings: [], lives: [], connection: null, nextId: 1, clock: 1 };

function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => {
        if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
        if (value && typeof value === "object" && "gte" in value) return row[key] >= value.gte;
        if (value && typeof value === "object" && "not" in value) return row[key] !== value.not;
        if (value instanceof Date) return row[key] instanceof Date && row[key].getTime() === value.getTime();
        return row[key] === value;
    });
}

// Rows come back with their lecture -> class relation (selected by some callers).
const withLecture = row => (row ? { ...row, lecture: { class: { teacherId: TEACHER } } } : null);

// Applies Prisma update data: plain values, or { increment: n } for numbers.
function applyData(row, data) {
    for (const [key, value] of Object.entries(data)) {
        row[key] = value && typeof value === "object" && "increment" in value ? (row[key] ?? 0) + value.increment : value;
    }
    return row;
}

const notFound = () => Object.assign(new Error("Record to update not found"), { code: "P2025" });

function table(rows) {
    const newest = list => list.slice().sort((a, b) => b.createdAt - a.createdAt);

    return {
        findFirst: async ({ where, orderBy } = {}) => {
            const found = rows().filter(r => matches(r, where));
            return withLecture((orderBy ? newest(found) : found)[0]);
        },
        findUnique: async ({ where }) => {
            return withLecture(rows().find(r => matches(r, where)));
        },
        findMany: async ({ where } = {}) => rows().filter(r => matches(r, where)).map(r => ({ ...r })),
        create: async ({ data }) => {
            if (rows().some(r => r.broadcastId === data.broadcastId)) {
                throw new Error("Unique constraint failed on broadcastId");
            }
            const row = { id: "row-" + db.nextId++, endedAt: null, startedAt: null, createdAt: db.clock++, updatedAt: new Date(), version: 0, ...data };
            rows().push(row);
            return { ...row };
        },
        update: async ({ where, data }) => {
            const row = rows().find(r => matches(r, where));
            if (!row) throw notFound();
            applyData(row, { updatedAt: new Date(), ...data });
            return { ...row };
        },
        updateMany: async ({ where, data }) => {
            const found = rows().filter(r => matches(r, where));
            found.forEach(r => applyData(r, { updatedAt: new Date(), ...data }));
            return { count: found.length };
        },
        upsert: async ({ where, create, update }) => {
            const row = rows().find(r => matches(r, where));
            if (row) {
                applyData(row, { updatedAt: new Date(), ...update });
                return { ...row };
            }
            const created = { id: "row-" + db.nextId++, endedAt: null, startedAt: null, createdAt: db.clock++, updatedAt: new Date(), version: 0, ...create };
            rows().push(created);
            return { ...created };
        }
    };
}

// Per-lecture operation lock (YouTubeOperationLock): unique insert, expired
// takeover, delete by owner — the same contract as Postgres.
function lockTable(store) {
    return {
        create: async ({ data }) => {
            if (store.has(data.lectureId)) {
                throw Object.assign(new Error("Unique constraint failed on lectureId"), { code: "P2002" });
            }
            store.set(data.lectureId, { createdAt: new Date(), ...data });
            return { ...store.get(data.lectureId) };
        },
        updateMany: async ({ where, data }) => {
            const row = store.get(where.lectureId);
            if (!row || !(row.expiresAt < where.expiresAt.lt)) return { count: 0 };
            Object.assign(row, data);
            return { count: 1 };
        },
        deleteMany: async ({ where }) => {
            const row = store.get(where.lectureId);
            if (!row || row.ownerId !== where.ownerId) return { count: 0 };
            store.delete(where.lectureId);
            return { count: 1 };
        }
    };
}

const locks = new Map();

const lectureRow = () => ({ id: LECTURE, title: "Physics", classId: CLASS, status: 0, class: { teacherId: TEACHER } });

const fakePrisma = {
    youTubeOperationLock: lockTable(locks),
    youTubeRecording: table(() => db.recordings),
    youTubeLiveBroadcast: table(() => db.lives),
    youTubeConnection: {
        findUnique: async ({ where }) => (where.teacherId === TEACHER ? { ...db.connection } : null),
        update: async ({ data }) => Object.assign(db.connection, data),
        updateMany: async () => ({ count: 1 })
    },
    // Starts need the lecture's active class session (started before every row here).
    classSession: {
        findFirst: async ({ where }) =>
            where.lectureId === LECTURE && where.isActive === true ? { id: "session-1", startedAt: new Date(0) } : null
    },
    lecture: {
        findFirst: async ({ where }) => (where.id === LECTURE ? lectureRow() : null),
        findUnique: async ({ where }) => (where.id === LECTURE ? lectureRow() : null),
        update: async () => lectureRow()
    }
};

// ---- Fake YouTube ------------------------------------------------------------

const yt = { broadcasts: new Map(), streamActive: false, calls: [], nextId: 1 };

const ytBroadcast = id => {
    const b = yt.broadcasts.get(id);
    if (!b) throw new Error("YouTube broadcast not found");
    return { id, status: { lifeCycleStatus: b.lifecycle, privacyStatus: b.privacy }, contentDetails: { boundStreamId: b.stream } };
};

const fakeYoutubeLive = {
    createYouTubeLiveStream: async () => { yt.calls.push("createStream"); return { id: STREAM }; },
    getYouTubeLiveStream: async () => ({
        id: STREAM,
        cdn: { ingestionInfo: { streamName: "key-1" } },
        status: { streamStatus: yt.streamActive ? "active" : "ready" }
    }),
    createYouTubeLiveBroadcast: async (_t, options) => {
        const id = "bc-" + yt.nextId++;
        yt.calls.push("create:" + options.privacyStatus);
        yt.broadcasts.set(id, { privacy: options.privacyStatus, lifecycle: "created", stream: null });
        return ytBroadcast(id);
    },
    bindYouTubeLiveBroadcast: async (_t, id, streamId) => {
        const b = yt.broadcasts.get(id);
        b.stream = streamId;
        b.lifecycle = "ready";
        return ytBroadcast(id);
    },
    getYouTubeLiveBroadcast: async (_t, id) => ytBroadcast(id),
    transitionYouTubeLiveBroadcast: async (_t, id, to) => {
        yt.calls.push("transition:" + id + ":" + to);
        yt.broadcasts.get(id).lifecycle = to;
        return ytBroadcast(id);
    },
    updateYouTubeLiveBroadcastPrivacy: async (_t, id, privacy) => {
        yt.calls.push("privacy:" + id + ":" + privacy);
        yt.broadcasts.get(id).privacy = privacy;
        return ytBroadcast(id);
    }
};

// ---- Module fakes ------------------------------------------------------------

function fake(relativePath, exports) {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);

    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
}

class YouTubeReauthorizationRequiredError extends Error {}

fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/youtube-live.ts", fakeYoutubeLive);
fake("lib/youtube-auth.ts", { YouTubeReauthorizationRequiredError });
fake("lib/auth-session.ts", { requireTeacherSession: async () => ({ teacherId: TEACHER, role: "TEACHER" }) });

const sessionEvents = require(path.join(root, "lib/session-events.ts"));
const lectureLib = require(path.join(root, "lib/youtube-lecture.ts"));
const { getLiveSnapshot } = require(path.join(root, "lib/youtube-live-snapshot.ts"));
const { shouldStartJibri, shouldStopJibriAfterStop } = require(path.join(root, "components/Jitsi/youtube-jibri.ts"));
const recordingStart = require(path.join(root, "app/api/youtube/lecture/recording/start/route.ts"));
const recordingStop = require(path.join(root, "app/api/youtube/lecture/recording/stop/route.ts"));
const liveStart = require(path.join(root, "app/api/youtube/lecture/start/route.ts"));
const liveStop = require(path.join(root, "app/api/youtube/lecture/stop/route.ts"));

let liveEvents = [];

sessionEvents.subscribeLiveChanges(payload => liveEvents.push(payload.event));

// ---- Fake Jitsi / Jibri and the teacher page -----------------------------------

const jibri = { running: false, starts: 0, stops: 0 };

function reset() {
    db.recordings = [];
    db.lives = [];
    db.connection = { teacherId: TEACHER, refreshTokenEncrypted: "enc", liveStreamId: STREAM };
    yt.broadcasts = new Map();
    yt.streamActive = false;
    yt.calls = [];
    jibri.running = false;
    jibri.starts = 0;
    jibri.stops = 0;
    liveEvents = [];
}

async function post(route, body) {
    const response = await route.POST(new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify(body)
    }));

    return { status: response.status, data: await response.json() };
}

// The teacher page's YouTube actions, with JitsiClassroom's Jibri decisions.
// `isRecording` / `isLive` are what the page shows (set after Jibri confirms,
// or restored from the server after a reload).
function teacherPage(restored = { isRecording: false, isLive: false }) {
    const page = { ...restored };

    const jibriStart = () => {
        jibri.starts += 1;
        jibri.running = true;
        yt.streamActive = true; // YouTube sees the ingest (no lag in this fake)
    };
    const jibriStop = () => {
        jibri.stops += 1;
        jibri.running = false;
        yt.streamActive = false;
    };

    page.record = async () => {
        const { data } = await post(recordingStart, { lectureId: LECTURE, isLive: page.isLive, sessionId: "session-1" });
        assert.equal(data.success, true, JSON.stringify(data));
        if (shouldStartJibri({ alreadyStreaming: data.alreadyStreaming === true, recordingActive: false, liveActive: page.isLive })) {
            jibriStart();
        }
        page.isRecording = true;
        return data;
    };
    page.goLive = async privacy => {
        const { status, data } = await post(liveStart, { lectureId: LECTURE, privacy, sessionId: "session-1" });
        if (!data.success) return { status, data };
        if (shouldStartJibri({ alreadyStreaming: data.alreadyStreaming === true, recordingActive: page.isRecording, liveActive: false })) {
            jibriStart();
        }
        page.isLive = true;
        return { status, data };
    };
    page.stopRecording = async () => {
        const { data } = await post(recordingStop, { lectureId: LECTURE });
        assert.equal(data.success, true, JSON.stringify(data));
        page.isRecording = false;
        if (shouldStopJibriAfterStop(data, page.isLive)) jibriStop();
        return data;
    };
    page.stopLive = async () => {
        const { data } = await post(liveStop, { lectureId: LECTURE });
        assert.equal(data.success, true, JSON.stringify(data));
        page.isLive = false;
        if (shouldStopJibriAfterStop(data, page.isRecording)) jibriStop();
        return data;
    };

    return page;
}

const created = () => yt.calls.filter(c => c.startsWith("create:"));
const completions = id => yt.calls.filter(c => c === "transition:" + id + ":complete");
const active = rows => rows.filter(r => r.status === "READY" || r.status === "LIVE");

const quiet = async fn => {
    const log = console.log;
    const warn = console.warn;
    const error = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
        return await fn();
    } finally {
        console.log = log;
        console.warn = warn;
        console.error = error;
    }
};

// ---- Case A: Recording, then Unlisted Live -------------------------------------

test("Recording -> Unlisted Live: one YouTube broadcast, a persisted Live row on it, one Jibri stream", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        const rec = await page.record();
        const { data: live } = await page.goLive("unlisted");

        assert.deepEqual(created(), ["create:unlisted"], "no second broadcast");
        assert.equal(live.broadcastId, rec.broadcastId);
        assert.equal(db.lives.length, 1);
        assert.equal(db.lives[0].broadcastId, rec.broadcastId, "durable Live association");
        assert.equal(db.lives[0].privacy, "UNLISTED");
        assert.equal(jibri.starts, 1, "Jibri started once, by the recording");
    });

    // Students can discover it through the existing paths once YouTube says live.
    yt.broadcasts.get(db.lives[0].broadcastId).lifecycle = "live";
    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), { isLive: true, youtubeUrl: db.lives[0].youtubeUrl });
});

test("Stop Live while Recording continues: the shared broadcast and Jibri stay active", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        const rec = await page.record();
        await page.goLive("unlisted");

        const stop = await page.stopLive();

        assert.equal(stop.broadcastCompleted, false);
        assert.equal(stop.stopJibri, false);
        assert.deepEqual(completions(rec.broadcastId), [], "shared broadcast not completed");
        assert.equal(jibri.running, true);
        assert.equal(jibri.stops, 0);
        assert.equal(db.lives[0].status, "COMPLETE", "the Live feature ended");
        assert.equal(active(db.recordings).length, 1, "the recording continues");
        assert.deepEqual(liveEvents.slice(-1), ["ended"], "students are told Live ended");
    });
});

test("Stop Recording while Live continues: the shared broadcast and Jibri stay active", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        const rec = await page.record();
        await page.goLive("unlisted");

        const stop = await page.stopRecording();

        assert.equal(stop.broadcastCompleted, false);
        assert.equal(stop.stopJibri, false);
        assert.deepEqual(completions(rec.broadcastId), []);
        assert.equal(jibri.running, true);
        assert.equal(db.recordings[0].status, "COMPLETE", "the Recording feature ended");
        assert.equal(active(db.lives).length, 1, "Live continues");
    });
});

test("stopping the last active feature completes the shared broadcast and stops Jibri exactly once", async () => {
    for (const order of [["stopLive", "stopRecording"], ["stopRecording", "stopLive"]]) {
        reset();

        await quiet(async () => {
            const page = teacherPage();
            const rec = await page.record();
            await page.goLive("unlisted");

            await page[order[0]]();
            assert.equal(jibri.stops, 0, order.join(" then "));

            const last = await page[order[1]]();

            assert.equal(last.broadcastCompleted, true, order.join(" then "));
            assert.equal(last.stopJibri, true);
            assert.equal(completions(rec.broadcastId).length, 1, "completed once");
            assert.equal(jibri.stops, 1, "Jibri stop requested exactly once");
            assert.equal(jibri.running, false);
            assert.equal(active(db.recordings).length + active(db.lives).length, 0);
        });
    }
});

test("repeated stop requests never complete the shared broadcast while the other feature is active", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        const rec = await page.record();
        await page.goLive("unlisted");

        await page.stopLive();

        // Stop Live again (double click / retry / second tab), twice.
        for (let i = 0; i < 2; i++) {
            const again = await post(liveStop, { lectureId: LECTURE });

            assert.equal(again.data.success, true);
            assert.equal(again.data.broadcastCompleted, false);
            assert.equal(again.data.stopJibri, false, "the recording still needs Jibri");
        }

        assert.deepEqual(completions(rec.broadcastId), []);
        assert.equal(jibri.stops, 0);
        assert.equal(active(db.recordings).length, 1);
    });
});

test("Live stopped then started again on the shared broadcast: its row is reactivated, no duplicate", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        const rec = await page.record();
        await page.goLive("unlisted");
        await page.stopLive();
        const { data } = await page.goLive("unlisted");

        assert.equal(data.broadcastId, rec.broadcastId);
        assert.deepEqual(created(), ["create:unlisted"]);
        assert.equal(db.lives.length, 1);
        assert.equal(db.lives[0].status === "READY" || db.lives[0].status === "LIVE", true);
        assert.equal(db.lives[0].endedAt, null);
        assert.equal(jibri.starts, 1);
    });
});

test("a shared broadcast is never switched to Public / Private for Live", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        const rec = await page.record();
        await page.goLive("unlisted");

        // Start Live again with PUBLIC while it runs shared: refused, privacy untouched.
        const { status, data } = await page.goLive("public");

        assert.equal(status, 409);
        assert.equal(data.code, "YOUTUBE_SHARED_BROADCAST_PRIVACY");
        assert.equal(yt.broadcasts.get(rec.broadcastId).privacy, "unlisted");
        assert.equal(yt.calls.filter(c => c.startsWith("privacy:")).length, 0);

        // The per-broadcast privacy setting refuses it too.
        await assert.rejects(
            lectureLib.updateYouTubeLiveBroadcastPrivacyForTeacher(TEACHER, db.lives[0].id, "private"),
            error => error.code === "YOUTUBE_SHARED_BROADCAST_PRIVACY"
        );
    });
});

// ---- Case B: Unlisted Live, then Recording --------------------------------------

test("Unlisted Live -> Recording: one YouTube broadcast, a persisted Recording row on it, one Jibri stream", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        const { data: live } = await page.goLive("unlisted");
        const rec = await page.record();

        assert.deepEqual(created(), ["create:unlisted"], "no duplicate broadcast");
        assert.equal(rec.broadcastId, live.broadcastId);
        assert.equal(rec.sharedWithLive, true);
        assert.equal(db.recordings.length, 1);
        assert.equal(db.recordings[0].broadcastId, live.broadcastId, "durable Recording association");
        assert.equal(db.recordings[0].privacy, "UNLISTED");
        assert.equal(jibri.starts, 1, "Jibri started once, by Live");

        // And both stops behave: the first keeps everything running.
        const first = await page.stopRecording();

        assert.equal(first.broadcastCompleted, false);
        assert.equal(jibri.running, true);

        const last = await page.stopLive();

        assert.equal(last.broadcastCompleted, true);
        assert.equal(completions(live.broadcastId).length, 1);
        assert.equal(jibri.stops, 1);
    });
});

test("Recording reuses Live even if YouTube has not reported the stream active yet (no second Jibri stream)", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        await page.goLive("unlisted");

        yt.streamActive = false; // YouTube lags behind Jibri

        await page.record();

        assert.equal(jibri.starts, 1, "the page's own Live state prevents a second Jibri start");
    });
});

// ---- Case C: Public / Private Live keep their own broadcast ------------------------

for (const privacy of ["public", "private"]) {
    test(`${privacy.toUpperCase()} Live -> Recording: a separate Unlisted recording broadcast, Live untouched`, async () => {
        reset();

        await quiet(async () => {
            const page = teacherPage();
            const { data: live } = await page.goLive(privacy);
            const rec = await page.record();

            assert.deepEqual(created(), ["create:" + privacy, "create:unlisted"]);
            assert.notEqual(rec.broadcastId, live.broadcastId);
            assert.equal(rec.sharedWithLive, undefined);
            assert.equal(yt.broadcasts.get(live.broadcastId).privacy, privacy, "Live privacy never changed");
            assert.equal(yt.calls.filter(c => c.startsWith("privacy:")).length, 0);
            assert.equal(db.recordings[0].privacy, "UNLISTED");
            assert.equal(jibri.starts, 1, "one Jibri stream for both broadcasts");

            // Separate broadcasts: each stop completes its own; Jibri stops after both.
            const stopRec = await page.stopRecording();

            assert.equal(stopRec.broadcastCompleted, true);
            assert.equal(completions(rec.broadcastId).length, 1);
            assert.deepEqual(completions(live.broadcastId), []);
            assert.equal(jibri.running, true, "Live still needs Jibri");

            await page.stopLive();
            assert.equal(completions(live.broadcastId).length, 1);
            assert.equal(jibri.stops, 1);
        });
    });
}

// ---- Reload: the relationship comes from persisted data ----------------------------

test("after a reload the shared relationship and both stops work from persisted data only", async () => {
    reset();

    let broadcastId;

    await quiet(async () => {
        const before = teacherPage();
        broadcastId = (await before.record()).broadcastId;
        await before.goLive("unlisted");
    });

    yt.broadcasts.get(broadcastId).lifecycle = "live";

    // A fresh page: no in-memory flags. What the classroom restores on load:
    const state = await lectureLib.getYouTubeFeatureState(LECTURE);

    assert.equal(state.sharedBroadcastId, broadcastId);
    assert.equal(state.recording.broadcastId, broadcastId);
    assert.equal(state.live.broadcastId, broadcastId);

    const recordingStatus = await quiet(() => lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE));
    const liveStatus = await getLiveSnapshot(LECTURE, "teacher");

    assert.equal(recordingStatus.isRecording, true);
    assert.equal(liveStatus.isLive, true);

    await quiet(async () => {
        const after = teacherPage({ isRecording: recordingStatus.isRecording, isLive: liveStatus.isLive });

        const stopLive = await after.stopLive();

        assert.equal(stopLive.sharedWithRecording, true);
        assert.equal(stopLive.broadcastCompleted, false);
        assert.equal(jibri.stops, 0);

        const stopRecording = await after.stopRecording();

        assert.equal(stopRecording.broadcastCompleted, true);
        assert.equal(completions(broadcastId).length, 1);
        assert.equal(jibri.stops, 1);
    });
});

// ---- The page's Jibri decisions --------------------------------------------------

test("Jibri decisions: start only when nothing streams; stop follows the server, else the page", () => {
    assert.equal(shouldStartJibri({ alreadyStreaming: false, recordingActive: false, liveActive: false }), true);
    assert.equal(shouldStartJibri({ alreadyStreaming: true, recordingActive: false, liveActive: false }), false);
    assert.equal(shouldStartJibri({ alreadyStreaming: false, recordingActive: true, liveActive: false }), false);
    assert.equal(shouldStartJibri({ alreadyStreaming: false, recordingActive: false, liveActive: true }), false);

    assert.equal(shouldStopJibriAfterStop({ stopJibri: false }, false), false, "server wins");
    assert.equal(shouldStopJibriAfterStop({ stopJibri: true }, true), true, "server wins");
    assert.equal(shouldStopJibriAfterStop({}, false), true, "older server: the page decides");
    assert.equal(shouldStopJibriAfterStop({}, true), false);
});
