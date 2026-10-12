/*
 * In-memory fakes for the YouTube Recording / Live code (tests only):
 * Prisma (Recording / Live / connection / lecture), the YouTube API helpers
 * (lib/youtube-live.ts, with failure injection), the login session, and a
 * fake Jitsi counting Jibri start / stop. Loads the real modules through tsx.
 * Nothing here contacts YouTube, Jibri or a database.
 */

"use strict";

const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

const TEACHER = "teacher-1";
const LECTURE = "lecture-1";
const LECTURE_2 = "lecture-2";
const LECTURES = new Set([LECTURE, LECTURE_2]);
const CLASS = "class-1";
const STREAM = "stream-1";

// ---- Prisma -------------------------------------------------------------------

// Row and session timestamps: the current time, strictly increasing (as the
// database default now() would be; compared with session start times).
let lastTimestamp = 0;
const now = () => new Date(lastTimestamp = Math.max(Date.now(), lastTimestamp + 1));

const db = {
    recordings: [], lives: [], connection: null, nextId: 1, clock: 1,
    // A second teacher's own YouTube connection (null: none).
    otherConnection: null,
    // Class sessions and attendance closes (session-service tests).
    sessions: [],
    attendanceCloses: []
};

function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => {
        if (key === "lecture") return true;
        if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
        if (value && typeof value === "object" && "gte" in value) return row[key] >= value.gte;
        if (value && typeof value === "object" && "not" in value) return row[key] !== value.not;
        if (value instanceof Date) return row[key] instanceof Date && row[key].getTime() === value.getTime();
        return row[key] === value;
    });
}

const withLecture = row => (row
    ? { ...row, lecture: { title: "Physics", class: { name: "Physics", teacherId: TEACHER, teacher: { name: "Teacher" } } } }
    : null);

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
    const insert = data => {
        if (rows().some(r => r.broadcastId === data.broadcastId)) {
            throw new Error("Unique constraint failed on broadcastId");
        }
        const stamp = now();
        const row = { id: "row-" + db.nextId++, endedAt: null, startedAt: null, createdAt: stamp, updatedAt: stamp, version: 0, ...data };
        rows().push(row);
        return row;
    };

    return {
        findFirst: async ({ where, orderBy } = {}) => {
            const found = rows().filter(r => matches(r, where));
            return withLecture((orderBy ? newest(found) : found)[0]);
        },
        findUnique: async ({ where }) => withLecture(rows().find(r => matches(r, where))),
        findMany: async ({ where } = {}) => rows().filter(r => matches(r, where)).map(withLecture),
        create: async ({ data }) => ({ ...insert(data) }),
        update: async ({ where, data }) => {
            const row = rows().find(r => matches(r, where));
            if (!row) throw notFound();
            applyData(row, { updatedAt: now(), ...data });
            return { ...row };
        },
        updateMany: async ({ where, data }) => {
            const found = rows().filter(r => matches(r, where));
            found.forEach(r => applyData(r, { updatedAt: now(), ...data }));
            return { count: found.length };
        },
        upsert: async ({ where, create, update }) => {
            const row = rows().find(r => matches(r, where));
            if (row) {
                applyData(row, { updatedAt: now(), ...update });
                return { ...row };
            }
            return { ...insert(create) };
        }
    };
}

// Per-lecture operation lock (YouTubeOperationLock): unique insert, expired
// takeover, delete by owner — the same contract as Postgres.
function lockTable(store) {
    return {
        create: async ({ data }) => {
            lockAttempts.push(data.lectureId);
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
// Every lock acquisition attempt (lectureId), in order.
const lockAttempts = [];

const lectureRow = (id = LECTURE) => ({ id, title: "Physics", classId: CLASS, status: 0, class: { teacherId: TEACHER } });

const prisma = {
    youTubeOperationLock: lockTable(locks),
    youTubeRecording: table(() => db.recordings),
    youTubeLiveBroadcast: table(() => db.lives),
    youTubeConnection: {
        findUnique: async ({ where }) =>
            where.teacherId === TEACHER ? { ...db.connection }
                : db.otherConnection && where.teacherId === db.otherConnection.teacherId ? { ...db.otherConnection }
                    : null,
        update: async ({ where, data }) => Object.assign(
            where.teacherId === TEACHER ? db.connection : db.otherConnection, data),
        updateMany: async ({ where, data }) => {
            const found = [db.connection, db.otherConnection].filter(c => c &&
                Object.entries(where).every(([key, value]) => (value === null ? c[key] == null : c[key] === value)));
            found.forEach(c => Object.assign(c, data));
            return { count: found.length };
        },
        upsert: async ({ where, create, update }) => {
            if (where.teacherId === TEACHER && db.connection) return Object.assign(db.connection, update);
            if (where.teacherId === TEACHER) return (db.connection = { liveStreamId: null, ...create });
            throw new Error("fake upsert: unknown teacher");
        },
        findMany: async ({ where }) => [db.connection, db.otherConnection]
            .filter(c => c && where.teacherId.in.includes(c.teacherId))
            .map(c => ({ ...c }))
    },
    classSession: {
        findFirst: async ({ where, orderBy, select } = {}) => {
            const found = db.sessions.filter(row =>
                (where.id === undefined || (typeof where.id === "string" ? row.id === where.id : !where.id.notIn.includes(row.id))) &&
                (where.lectureId === undefined || row.lectureId === where.lectureId) &&
                (where.isActive === undefined || row.isActive === where.isActive) &&
                (where.class === undefined || row.teacherId === where.class.teacherId));
            const sorted = orderBy ? found.slice().sort((a, b) => b.startedAt - a.startedAt) : found;
            return sorted[0] ? { ...sorted[0] } : null;
        },
        findMany: async ({ where }) => db.sessions
            .filter(row => row.classId === where.classId && row.isActive === where.isActive)
            .map(row => ({ id: row.id, lectureId: row.lectureId })),
        findUnique: async ({ where }) => {
            const row = db.sessions.find(r => r.id === where.id);
            return row ? { ...row, class: { teacherId: row.teacherId } } : null;
        },
        update: async ({ where, data }) => {
            const row = db.sessions.find(r => r.id === where.id);
            Object.assign(row, data);
            return { classId: row.classId, lectureId: row.lectureId };
        },
        updateMany: async ({ where, data }) => {
            const found = db.sessions.filter(r =>
                (where.id === undefined || r.id === where.id) &&
                (where.classId === undefined || r.classId === where.classId) &&
                (where.isActive === undefined || r.isActive === where.isActive));
            found.forEach(r => Object.assign(r, data));
            return { count: found.length };
        },
        create: async ({ data }) => {
            const row = {
                id: "session-" + db.nextId++, startedAt: now(),
                endedAt: null, teacherId: TEACHER, ...data
            };
            db.sessions.push(row);
            return { ...row, lecture: { id: row.lectureId, title: "Physics", date: null } };
        }
    },
    attendance: {
        updateMany: async ({ where, data }) => {
            db.attendanceCloses.push({ classSessionId: where.classSessionId, leftAt: data.leftAt });
            return { count: 0 };
        }
    },
    class: {
        findFirst: async ({ where }) =>
            where.id === CLASS && where.teacherId === TEACHER ? { id: CLASS, name: "Physics", schedule: null } : null
    },
    lecture: {
        findFirst: async ({ where }) => (LECTURES.has(where.id) ? lectureRow(where.id) : null),
        findUnique: async ({ where }) => (LECTURES.has(where.id) ? lectureRow(where.id) : null),
        update: async () => lectureRow()
    }
};

// ---- YouTube --------------------------------------------------------------------

class YouTubeReauthorizationRequiredError extends Error {}

const yt = {
    broadcasts: new Map(),
    streamActive: false,
    calls: [],
    nextId: 1,
    // broadcastId -> Error thrown by getYouTubeLiveBroadcast
    getErrors: new Map(),
    // Error thrown by updateYouTubeLiveBroadcastPrivacy
    privacyError: null,
    // A promise updateYouTubeLiveBroadcastPrivacy waits for (holds a request mid-flight).
    privacyGate: null,
    // (token) => a promise getYouTubeLiveStream waits for, or null.
    streamGate: null,
    // broadcastId -> Error thrown by transitionYouTubeLiveBroadcast
    transitionErrors: new Map(),
    // (broadcastId) => a promise getYouTubeLiveBroadcast waits for, or null.
    getGate: null,
    // Runs (awaited) while createYouTubeLiveStream is "creating" a stream.
    createStreamHook: null,
    // Operations that hang ("stream", "get", "transition", "create") until the
    // REAL lib/youtube-request.ts limits abort them (see stall()).
    stall: new Set()
};

// No real network in these tests: any fetch hangs until its signal aborts.
let networkRequests = 0;

globalThis.fetch = (_url, init = {}) => {
    networkRequests += 1;
    return new Promise((_resolve, reject) => {
        if (!init.signal) return;
        init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
    });
};

// A stalled YouTube call: a real youtubeFetch (request timeout + operation
// deadline) against the hanging fetch above, so it fails exactly as a stalled
// YouTube request would.
async function stall(op) {
    if (!yt.stall.has(op)) return;
    yt.calls.push("stalled:" + op);
    await youtubeRequest.youtubeFetch("https://youtube.invalid/" + op);
}

const ytBroadcast = id => {
    const b = yt.broadcasts.get(id);
    if (!b) throw new Error("YouTube live broadcast not found.");
    return { id, status: { lifeCycleStatus: b.lifecycle, privacyStatus: b.privacy }, contentDetails: { boundStreamId: b.stream } };
};

const youtubeLive = {
    createYouTubeLiveStream: async () => {
        yt.calls.push("createStream");
        if (yt.createStreamHook) await yt.createStreamHook();
        return { id: STREAM };
    },
    getYouTubeLiveStream: async token => (await stall("stream"), yt.streamGate ? await yt.streamGate(token) : undefined, {
        id: STREAM,
        cdn: { ingestionInfo: { streamName: "key-1" } },
        status: { streamStatus: yt.streamActive ? "active" : "ready" }
    }),
    createYouTubeLiveBroadcast: async (_t, options) => {
        await stall("create");
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
    getYouTubeLiveBroadcast: async (_t, id) => {
        yt.calls.push("get:" + id);
        await stall("get");
        if (yt.getErrors.has(id)) throw yt.getErrors.get(id);
        // The answer is YouTube's state when it answered; a held lookup
        // (getGate) delivers it late, as a slow request would.
        const answer = ytBroadcast(id);
        if (yt.getGate) await yt.getGate(id);
        return answer;
    },
    transitionYouTubeLiveBroadcast: async (_t, id, to) => {
        yt.calls.push("transition:" + id + ":" + to);
        await stall("transition");
        if (yt.transitionErrors.has(id)) throw yt.transitionErrors.get(id);
        yt.broadcasts.get(id).lifecycle = to;
        return ytBroadcast(id);
    },
    updateYouTubeLiveBroadcastPrivacy: async (_t, id, privacy) => {
        yt.calls.push("privacy:" + id + ":" + privacy);
        if (yt.privacyGate) await yt.privacyGate;
        if (yt.privacyError) throw yt.privacyError;
        yt.broadcasts.get(id).privacy = privacy;
        return ytBroadcast(id);
    }
};

// ---- Modules ------------------------------------------------------------------------

function fake(relativePath, exports) {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);

    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
}

fake("lib/prisma.ts", { prisma });
fake("lib/youtube-live.ts", youtubeLive);
fake("lib/youtube-auth.ts", { YouTubeReauthorizationRequiredError });
fake("lib/jitsi-auth.ts", { generateJitsiToken: async () => "token" });
fake("lib/mailer.ts", { buildLiveSessionInviteLoginLink: () => "", sendLiveSessionInviteEmail: async () => {} });
fake("lib/session-invite.ts", { signSessionInviteToken: () => "" });
// The logged-in teacher (tests may switch it).
const session = { teacherId: TEACHER };

fake("lib/auth-session.ts", {
    requireTeacherSession: async () => ({ teacherId: session.teacherId, role: "TEACHER" }),
    requireStudentSession: async () => ({ studentId: "student-1", role: "STUDENT" })
});

const load = relativePath => require(path.join(root, relativePath));

const youtubeRequest = load("lib/youtube-request.ts");
const DEFAULT_TIMEOUTS = {
    ...youtubeRequest.youtubeTimeouts,
    // Tests: session cleanup retries a held lock quickly (its own tests set it).
    sessionCleanupLockRetriesMs: [5, 10]
};

const lectureLib = load("lib/youtube-lecture.ts");
const { getLiveSnapshot } = load("lib/youtube-live-snapshot.ts");
const { shouldStartJibri, shouldStopJibriAfterStop } = load("components/Jitsi/youtube-jibri.ts");
const routes = {
    recordingStart: load("app/api/youtube/lecture/recording/start/route.ts"),
    recordingStop: load("app/api/youtube/lecture/recording/stop/route.ts"),
    liveStart: load("app/api/youtube/lecture/start/route.ts"),
    liveStop: load("app/api/youtube/lecture/stop/route.ts"),
    startAbort: load("app/api/youtube/lecture/start/abort/route.ts"),
    livePrivacy: load("app/api/lectures/[id]/lives/[liveId]/privacy/route.ts")
};

// ---- Jibri and the teacher page --------------------------------------------------

const jibri = { running: false, starts: 0, stops: 0 };

function reset() {
    db.recordings = [];
    db.lives = [];
    db.connection = { teacherId: TEACHER, refreshTokenEncrypted: "enc", liveStreamId: STREAM };
    yt.broadcasts = new Map();
    yt.streamActive = false;
    yt.calls = [];
    yt.getErrors = new Map();
    yt.privacyError = null;
    yt.privacyGate = null;
    yt.streamGate = null;
    db.otherConnection = null;
    db.sessions = [LECTURE, LECTURE_2].map(lectureId => ({
        id: "fixture-session-" + lectureId, classId: CLASS, lectureId, isActive: true,
        startedAt: new Date(0), endedAt: null, teacherId: TEACHER, fixture: true
    }));
    yt.transitionErrors = new Map();
    yt.stall = new Set();
    yt.getGate = null;
    yt.createStreamHook = null;
    Object.assign(youtubeRequest.youtubeTimeouts, DEFAULT_TIMEOUTS);
    networkRequests = 0;
    db.attendanceCloses = [];
    session.teacherId = TEACHER;
    lockAttempts.length = 0;
    jibri.running = false;
    jibri.starts = 0;
    jibri.stops = 0;
    locks.clear();
}

// The lecture's current class session (newest active), as the classroom has it.
function currentSessionId(lectureId = LECTURE) {
    const current = db.sessions
        .filter(s => s.lectureId === lectureId && s.isActive)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
    return current ? current.id : "no-active-session";
}

async function post(route, body) {
    // Recording / Live starts send the classroom's sessionId (tests may pass
    // their own, e.g. a stale one).
    if ((route === routes.recordingStart || route === routes.liveStart) && !("sessionId" in body)) {
        body = { ...body, sessionId: currentSessionId(body.lectureId) };
    }

    const response = await route.POST(new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify(body)
    }));

    return { status: response.status, data: await response.json() };
}

// The teacher page's YouTube actions with JitsiClassroom's Jibri decisions.
function teacherPage(restored = { isRecording: false, isLive: false }) {
    const page = { ...restored };

    const jibriStart = () => {
        jibri.starts += 1;
        jibri.running = true;
        yt.streamActive = true;
    };
    const jibriStop = () => {
        jibri.stops += 1;
        jibri.running = false;
        yt.streamActive = false;
    };

    page.record = async () => {
        const result = await post(routes.recordingStart, { lectureId: LECTURE, isLive: page.isLive });
        if (!result.data.success) return result;
        if (shouldStartJibri({ alreadyStreaming: result.data.alreadyStreaming === true, recordingActive: false, liveActive: page.isLive })) {
            jibriStart();
        }
        page.isRecording = true;
        return result;
    };
    page.goLive = async privacy => {
        const result = await post(routes.liveStart, { lectureId: LECTURE, privacy });
        if (!result.data.success) return result;
        if (shouldStartJibri({ alreadyStreaming: result.data.alreadyStreaming === true, recordingActive: page.isRecording, liveActive: false })) {
            jibriStart();
        }
        page.isLive = true;
        return result;
    };
    page.stopRecording = async () => {
        const { data } = await post(routes.recordingStop, { lectureId: LECTURE });
        assert.equal(data.success, true, JSON.stringify(data));
        page.isRecording = false;
        if (shouldStopJibriAfterStop(data, page.isLive)) jibriStop();
        return data;
    };
    page.stopLive = async () => {
        const { data } = await post(routes.liveStop, { lectureId: LECTURE });
        assert.equal(data.success, true, JSON.stringify(data));
        page.isLive = false;
        if (shouldStopJibriAfterStop(data, page.isRecording)) jibriStop();
        return data;
    };

    return page;
}

async function quiet(fn) {
    const saved = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = () => {};
    try {
        return await fn();
    } finally {
        [console.log, console.warn, console.error] = saved;
    }
}

const created = () => yt.calls.filter(c => c.startsWith("create:"));
const privacyChanges = () => yt.calls.filter(c => c.startsWith("privacy:"));
const completions = id => yt.calls.filter(c => c === "transition:" + id + ":complete");
const active = rows => rows.filter(r => r.status === "READY" || r.status === "LIVE");

module.exports = {
    TEACHER, LECTURE, LECTURE_2, CLASS, STREAM, locks, lockAttempts, session,
    db, yt, jibri, routes, lectureLib, getLiveSnapshot, prisma, youtubeRequest,
    networkRequests: () => networkRequests,
    // The fake database clock (strictly increasing).
    now,
    currentSessionId,
    YouTubeReauthorizationRequiredError,
    reset, post, teacherPage, quiet, created, privacyChanges, completions, active
};
