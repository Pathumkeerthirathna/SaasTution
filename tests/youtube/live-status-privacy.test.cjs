/*
 * Regression tests: the classroom's YouTube live status must never expose a
 * PRIVATE broadcast (or one that is not live yet) to students.
 *
 *   npm run test:youtube
 *
 * Covers lib/youtube-live-snapshot.ts (getLiveSnapshot) and the real route
 * GET /api/sessions/[id]/live-updates, whose first SSE event is the snapshot.
 * Loaded through tsx; Prisma, the YouTube API helper and the login session
 * are in-memory fakes. Nothing here contacts YouTube, Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

const TEACHER = "teacher-1";
const OTHER_TEACHER = "teacher-2";
const STUDENT = "student-1";
const OUTSIDER = "student-2";
const CLASS = "class-1";
const SESSION = "session-1";
const LECTURE = "lecture-1";

// ---- Fakes ----------------------------------------------------------------

const db = { broadcasts: [], connection: true, updates: [] };

// What YouTube reports per broadcastId: a lifecycle string, or an Error to throw.
let youtube = {};
let youtubeCalls = 0;

// The logged-in user: { role: "TEACHER" | "STUDENT", id } or null.
let login = null;

const { AppError } = require(path.join(root, "lib/error-handler.ts"));

function matches(row, where) {
    return Object.entries(where).every(([key, value]) =>
        value && typeof value === "object" && "in" in value ? value.in.includes(row[key]) : row[key] === value);
}

const fakePrisma = {
    youTubeLiveBroadcast: {
        findFirst: async ({ where, select }) => {
            const row = db.broadcasts
                .filter(r => matches(r, where))
                .sort((a, b) => b.createdAt - a.createdAt)[0];

            if (!row) return null;

            const out = {};

            for (const key of Object.keys(select)) {
                out[key] = key === "lecture" ? { class: { teacherId: TEACHER } } : row[key];
            }

            return out;
        },
        update: async args => {
            db.updates.push(args);
            const row = db.broadcasts.find(r => r.id === args.where.id);
            Object.assign(row, args.data);
            return row;
        },
        // Conditional write: only rows still matching `where` change.
        updateMany: async args => {
            db.updates.push(args);
            const found = db.broadcasts.filter(r => matches(r, args.where));
            found.forEach(r => Object.assign(r, args.data));
            return { count: found.length };
        }
    },
    youTubeConnection: {
        findUnique: async ({ where }) =>
            db.connection && where.teacherId === TEACHER ? { refreshTokenEncrypted: "enc" } : null
    },
    classSession: {
        findUnique: async ({ where }) =>
            where.id === SESSION
                ? { id: SESSION, classId: CLASS, lectureId: LECTURE, class: { teacherId: TEACHER } }
                : null
    },
    student: {
        findFirst: async ({ where }) =>
            where.id === STUDENT && where.classes.some.classId === CLASS ? { id: STUDENT } : null
    }
};

function fake(relativePath, exports) {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);

    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
}

fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/youtube-live.ts", {
    getYouTubeLiveBroadcast: async (_token, broadcastId) => {
        youtubeCalls += 1;

        const answer = youtube[broadcastId];

        if (answer instanceof Error) throw answer;

        return { id: broadcastId, status: { lifeCycleStatus: answer } };
    }
});
// Same behaviour as lib/auth-session.ts: a session of the wrong role is
// rejected with 401, no session at all is 401.
fake("lib/auth-session.ts", {
    requireTeacherSession: async () => {
        if (!login || login.role !== "TEACHER") {
            throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
        }
        return { teacherId: login.id, role: "TEACHER" };
    },
    requireStudentSession: async () => {
        if (!login || login.role !== "STUDENT") {
            throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
        }
        return { studentId: login.id, role: "STUDENT" };
    }
});

const { getLiveSnapshot } = require(path.join(root, "lib/youtube-live-snapshot.ts"));
const { GET } = require(path.join(root, "app/api/sessions/[id]/live-updates/route.ts"));

// ---- Helpers --------------------------------------------------------------

const URLS = {
    PUBLIC: "https://www.youtube.com/watch?v=public1",
    UNLISTED: "https://www.youtube.com/watch?v=unlisted1",
    PRIVATE: "https://www.youtube.com/watch?v=private1"
};

let nextCreated = 1;

function reset() {
    db.broadcasts = [];
    db.connection = true;
    db.updates = [];
    youtube = {};
    youtubeCalls = 0;
    login = null;
}

// A YouTubeLiveBroadcast row (stored status READY or LIVE) and what YouTube says.
function broadcast(privacy, lifecycle, storedStatus = "READY") {
    const broadcastId = privacy.toLowerCase() + "-" + nextCreated;

    db.broadcasts.push({
        id: "row-" + nextCreated,
        lectureId: LECTURE,
        broadcastId,
        youtubeUrl: URLS[privacy],
        privacy,
        status: storedStatus,
        createdAt: nextCreated++
    });
    youtube[broadcastId] = lifecycle;
}

const NOT_LIVE = { isLive: false, youtubeUrl: null };

// Opens the SSE route as the current login; returns its status and the first
// live-status event (or the JSON error body), then closes the stream.
async function openLiveUpdates(roleParam) {
    const url = "http://localhost/api/sessions/" + SESSION + "/live-updates" + (roleParam ? "?role=" + roleParam : "");
    // Closed like a browser disconnect: the request is aborted.
    const abort = new AbortController();
    const response = await GET(new Request(url, { signal: abort.signal }), { params: { id: SESSION } });

    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        return { status: response.status, error: await response.json() };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (!text.includes("event: live-status")) {
        const { value, done } = await reader.read();

        if (done) break;
        text += decoder.decode(value);
    }

    abort.abort();
    reader.releaseLock();

    const data = text.split("event: live-status\ndata: ")[1].split("\n")[0];

    return { status: response.status, snapshot: JSON.parse(data) };
}

async function quietly(fn) {
    const original = console.error;

    console.error = () => {};

    try {
        return await fn();
    } finally {
        console.error = original;
    }
}

// ---- Student: what may be shown -------------------------------------------

test("PUBLIC live broadcast: the student gets the live status and URL", async () => {
    reset();
    broadcast("PUBLIC", "live");

    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), { isLive: true, youtubeUrl: URLS.PUBLIC });

    login = { role: "STUDENT", id: STUDENT };
    assert.deepEqual((await openLiveUpdates("student")).snapshot, { isLive: true, youtubeUrl: URLS.PUBLIC });
});

test("UNLISTED live broadcast: the student gets the live status and URL", async () => {
    reset();
    broadcast("UNLISTED", "live");

    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), { isLive: true, youtubeUrl: URLS.UNLISTED });

    login = { role: "STUDENT", id: STUDENT };
    assert.deepEqual((await openLiveUpdates()).snapshot, { isLive: true, youtubeUrl: URLS.UNLISTED });
});

test("PRIVATE live broadcast: the student gets isLive false and no URL", async () => {
    reset();
    broadcast("PRIVATE", "live", "LIVE");

    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), NOT_LIVE);
    assert.equal(youtubeCalls, 0, "a PRIVATE broadcast is not even looked up for a student");

    login = { role: "STUDENT", id: STUDENT };

    const { snapshot } = await openLiveUpdates("student");

    assert.deepEqual(snapshot, NOT_LIVE);
    assert.ok(!JSON.stringify(snapshot).includes("private1"), "the PRIVATE URL never appears");
});

test("PRIVATE newest, PUBLIC older still live: the student gets the PUBLIC one, never the PRIVATE", async () => {
    reset();
    broadcast("PUBLIC", "live");
    broadcast("PRIVATE", "live");

    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), { isLive: true, youtubeUrl: URLS.PUBLIC });
    // The teacher sees the newest broadcast, as before.
    assert.deepEqual(await getLiveSnapshot(LECTURE, "teacher"), { isLive: true, youtubeUrl: URLS.PRIVATE });
});

test("ready (not yet live) PUBLIC / UNLISTED broadcast: the student does not see it as live", async () => {
    for (const privacy of ["PUBLIC", "UNLISTED"]) {
        reset();
        broadcast(privacy, "ready");

        assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), NOT_LIVE, privacy);

        login = { role: "STUDENT", id: STUDENT };
        assert.deepEqual((await openLiveUpdates()).snapshot, NOT_LIVE, privacy);
    }
});

test("YouTube unreachable: a student only falls back to a row already confirmed LIVE", async () => {
    reset();
    broadcast("UNLISTED", new Error("YouTube API request failed: 503"), "READY");

    assert.deepEqual(await quietly(() => getLiveSnapshot(LECTURE, "student")), NOT_LIVE);

    reset();
    broadcast("UNLISTED", new Error("YouTube API request failed: 503"), "LIVE");

    assert.deepEqual(await quietly(() => getLiveSnapshot(LECTURE, "student")), { isLive: true, youtubeUrl: URLS.UNLISTED });
});

test("no eligible broadcast: the student gets an inactive status and no URL", async () => {
    reset();
    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), NOT_LIVE, "no rows");
    assert.deepEqual(await getLiveSnapshot(null, "student"), NOT_LIVE, "no lecture");

    broadcast("PUBLIC", "complete");
    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), NOT_LIVE, "ended on YouTube");
    assert.equal(db.updates[0].data.status, "COMPLETE", "the stale row still self-heals");

    reset();
    broadcast("UNLISTED", "live");
    db.connection = false;
    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), NOT_LIVE, "no YouTube connection");
});

// ---- Teacher: unchanged -----------------------------------------------------

test("PRIVATE live broadcast: the owning teacher keeps the status and URL", async () => {
    reset();
    broadcast("PRIVATE", "live");

    assert.deepEqual(await getLiveSnapshot(LECTURE, "teacher"), { isLive: true, youtubeUrl: URLS.PRIVATE });

    login = { role: "TEACHER", id: TEACHER };
    assert.deepEqual((await openLiveUpdates("teacher")).snapshot, { isLive: true, youtubeUrl: URLS.PRIVATE });
});

test("teacher behaviour unchanged: a ready broadcast still shows as live (Stop Live stays available)", async () => {
    reset();
    broadcast("PRIVATE", "ready");

    assert.deepEqual(await getLiveSnapshot(LECTURE, "teacher"), { isLive: true, youtubeUrl: URLS.PRIVATE });
});

// ---- Authentication and authorization (unchanged) ---------------------------

test("?role=teacher never grants the teacher view without a teacher session that owns the class", async () => {
    reset();
    broadcast("PRIVATE", "live");

    // A student asking for the teacher view: rejected, nothing streamed.
    login = { role: "STUDENT", id: STUDENT };

    const asStudent = await openLiveUpdates("teacher");

    assert.equal(asStudent.status, 401);
    assert.equal(asStudent.snapshot, undefined);

    // Another teacher (does not own the class): 404, nothing streamed.
    login = { role: "TEACHER", id: OTHER_TEACHER };

    const otherTeacher = await openLiveUpdates("teacher");

    assert.equal(otherTeacher.status, 404);
    assert.equal(otherTeacher.error.error.code, "SESSION_NOT_FOUND");

    // Not logged in.
    login = null;
    assert.equal((await openLiveUpdates("teacher")).status, 401);
    assert.equal((await openLiveUpdates()).status, 401);
});

test("student checks unchanged: a student not enrolled in the class is rejected; an unknown session is 404", async () => {
    reset();
    broadcast("PUBLIC", "live");

    login = { role: "STUDENT", id: OUTSIDER };

    const outsider = await openLiveUpdates();

    assert.equal(outsider.status, 403);
    assert.equal(outsider.error.error.code, "STUDENT_NOT_IN_CLASS");

    // A teacher without ?role=teacher gets the student path, which requires a
    // student session: rejected (as before), not a downgraded student view.
    login = { role: "TEACHER", id: TEACHER };
    assert.equal((await openLiveUpdates()).status, 401);

    login = { role: "STUDENT", id: STUDENT };

    const unknown = await GET(new Request("http://localhost/api/sessions/nope/live-updates"), { params: { id: "nope" } });

    assert.equal(unknown.status, 404);
});
