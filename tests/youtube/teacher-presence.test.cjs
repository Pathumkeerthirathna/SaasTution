/*
 * Teacher presence: the class's own teacher's live-updates SSE connection
 * records ClassSession.teacherLastSeenAt when it opens and refreshes it every
 * 10 s while it stays open. Students never do. Opening the connection (a live
 * page's own request) can CANCEL a pending tab-close signal of another page;
 * the server-side refresh never does (a connection the server has not
 * noticed is gone is not the teacher). A dropped connection, a lost network
 * or a stale heartbeat never creates a signal. (The page's own heartbeat
 * requests: tests/youtube/teacher-tab-close.test.cjs.)
 *
 *   npm run test:youtube
 *
 * Covers lib/teacher-presence.ts and the real route
 * GET /api/sessions/[id]/live-updates, loaded through tsx. Prisma and the
 * login session are in-memory fakes; time is node:test's mock timers.
 * Nothing here contacts YouTube, Jibri or a database.
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
const CLASS = "class-1";
const SESSION = "session-1";
const LECTURE = "lecture-1";
const REFRESH_MS = 10_000;

// ---- Fakes ----------------------------------------------------------------

// writes: presence writes; departureWrites: the tab-close cancel / return writes.
const db = { session: null, writes: [], departureWrites: [], failWrites: false };

// The logged-in user: { role: "TEACHER" | "STUDENT", id } or null.
let login = null;

const { AppError } = require(path.join(root, "lib/error-handler.ts"));

// Prisma's where for the presence write: id, isActive and the OR of
// "never seen" / "seen earlier".
function presenceMatches(row, where) {
    if (row.id !== where.id || row.isActive !== where.isActive) return false;

    return where.OR.some(clause =>
        clause.teacherLastSeenAt === null
            ? row.teacherLastSeenAt === null
            : row.teacherLastSeenAt !== null && row.teacherLastSeenAt < clause.teacherLastSeenAt.lt);
}

// The tab-close cancel / return write (lib/teacher-presence.ts): a pending
// signal at or before the activity, no activity recorded yet, and for a
// heartbeat only from another page than the one that signalled.
function departureMatches(row, where) {
    if (row.id !== where.id || row.isActive !== where.isActive) return false;
    if (!row.teacherDepartureAt || row.teacherDepartureAt > where.teacherDepartureAt.lte) return false;
    if (row.teacherActiveAfterDepartureAt) return false;
    if (!where.OR) return true;

    return row.teacherDeparturePageId == null || row.teacherDeparturePageId !== where.OR[1].teacherDeparturePageId.not;
}

const fakePrisma = {
    youTubeLiveBroadcast: { findFirst: async () => null },
    youTubeConnection: { findUnique: async () => null },
    classSession: {
        findUnique: async ({ where }) =>
            where.id === SESSION
                ? { id: SESSION, classId: CLASS, lectureId: LECTURE, class: { teacherId: TEACHER } }
                : null,
        updateMany: async ({ where, data }) => {
            if (!("teacherLastSeenAt" in data)) {
                db.departureWrites.push({ where, data });
                const hit = db.session && departureMatches(db.session, where);
                if (hit) Object.assign(db.session, data);
                return { count: hit ? 1 : 0 };
            }

            db.writes.push({ where, data });

            if (db.failWrites) throw new Error("database unavailable");

            const hit = db.session && presenceMatches(db.session, where);

            if (hit) Object.assign(db.session, data);

            return { count: hit ? 1 : 0 };
        }
    },
    student: {
        findFirst: async ({ where }) =>
            where.id === STUDENT && where.classes.some.classId === CLASS ? { id: STUDENT } : null
    },
    // Teacher-departure check from student connections: not under test here
    // (tests/youtube/teacher-departure.test.cjs); no lecture means nothing to stop.
    lecture: { findUnique: async () => null }
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

const { recordTeacherPresence, TEACHER_PRESENCE_REFRESH_MS } = require(path.join(root, "lib/teacher-presence.ts"));
const { GET } = require(path.join(root, "app/api/sessions/[id]/live-updates/route.ts"));

// ---- Helpers --------------------------------------------------------------

const settle = () => new Promise(resolve => setImmediate(resolve));

function reset(t) {
    db.session = {
        id: SESSION, isActive: true, teacherLastSeenAt: null,
        teacherDepartureAt: null, teacherDeparturePageId: null, teacherActiveAfterDepartureAt: null
    };
    db.writes = [];
    db.departureWrites = [];
    db.failWrites = false;
    login = null;
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
}

async function tick(t, ms) {
    t.mock.timers.tick(ms);
    await settle();
}

// Opens the SSE route as the current login and keeps it open. close() is a
// browser disconnect (the request is aborted).
async function connect(roleParam, pageId) {
    const url = "http://localhost/api/sessions/" + SESSION + "/live-updates" + (roleParam ? "?role=" + roleParam : "") +
        (pageId ? "&pageId=" + pageId : "");
    const abort = new AbortController();
    const response = await GET(new Request(url, { signal: abort.signal }), { params: { id: SESSION } });

    await settle();

    const isStream = Boolean(response.headers.get("content-type")?.includes("text/event-stream"));

    return {
        status: response.status,
        isStream,
        response,
        close: async () => {
            abort.abort();
            await settle();
        }
    };
}

// The first SSE event of an open connection.
async function firstEvent(connection) {
    const reader = connection.response.body.getReader();
    const { value } = await reader.read();

    reader.releaseLock();

    return new TextDecoder().decode(value);
}

const seen = () => db.session.teacherLastSeenAt?.getTime() ?? null;

async function quietly(fn) {
    const original = console.error;

    console.error = () => {};

    try {
        return await fn();
    } finally {
        console.error = original;
    }
}

// ---- Teacher --------------------------------------------------------------

test("refresh interval is 10 s (shorter than the 15 s tab-close window)", () => {
    assert.equal(TEACHER_PRESENCE_REFRESH_MS, REFRESH_MS);
});

test("the class's teacher: presence recorded when the connection opens; payload unchanged", async t => {
    reset(t);
    login = { role: "TEACHER", id: TEACHER };

    const connection = await connect("teacher");

    assert.equal(connection.status, 200);
    assert.equal(connection.isStream, true);
    assert.equal(seen(), 1_000_000);
    assert.equal(db.writes.length, 1);
    assert.equal(db.writes[0].where.id, SESSION);
    assert.equal(db.writes[0].where.isActive, true, "only an active session");
    assert.deepEqual(Object.keys(db.writes[0].data), ["teacherLastSeenAt"], "nothing else is written");

    assert.equal(await firstEvent(connection), 'event: live-status\ndata: {"isLive":false,"youtubeUrl":null}\n\n');

    await connection.close();
});

test("refreshed every 10 s while the connection stays open, not more often", async t => {
    reset(t);
    login = { role: "TEACHER", id: TEACHER };

    const connection = await connect("teacher");

    await tick(t, 9_999);
    assert.equal(db.writes.length, 1, "nothing before the interval");

    await tick(t, 1);
    assert.equal(db.writes.length, 2);
    assert.equal(seen(), 1_010_000);

    await tick(t, 30_000);
    assert.equal(db.writes.length, 5);
    assert.equal(seen(), 1_040_000);

    await connection.close();
});

test("a closed connection stops refreshing; a reconnect records presence again", async t => {
    reset(t);
    login = { role: "TEACHER", id: TEACHER };

    const first = await connect("teacher");

    await tick(t, 10_000);
    await first.close();

    const writesAtClose = db.writes.length;

    await tick(t, 120_000);
    assert.equal(db.writes.length, writesAtClose, "nothing after the disconnect");
    assert.equal(seen(), 1_010_000, "last seen stays at the last refresh");

    // EventSource reconnects with a new request.
    const second = await connect("teacher");

    assert.equal(db.writes.length, writesAtClose + 1, "written on reconnect");
    assert.equal(seen(), 1_130_000);

    await tick(t, 10_000);
    assert.equal(db.writes.length, writesAtClose + 2, "one refresh per tick: the old connection's timer is gone");

    await second.close();
});

test("two teacher tabs: each refreshes; time never moves backwards", async t => {
    reset(t);
    login = { role: "TEACHER", id: TEACHER };

    const tabA = await connect("teacher");

    await tick(t, 5_000);

    const tabB = await connect("teacher");

    assert.equal(seen(), 1_005_000);

    await tabA.close();
    await tick(t, 10_000);
    assert.equal(seen(), 1_015_000, "the remaining tab keeps it fresh");

    // A write carrying an older time (a slow request) is ignored.
    assert.equal(await recordTeacherPresence(SESSION, new Date(1_000_500)), false);
    assert.equal(seen(), 1_015_000);

    await tabB.close();
});

// ---- Not the teacher ----------------------------------------------------------

test("students never record teacher presence, connected or over time", async t => {
    reset(t);
    login = { role: "STUDENT", id: STUDENT };

    const connection = await connect("student");

    assert.equal(connection.isStream, true);
    await tick(t, 120_000);
    assert.equal(db.writes.length, 0);
    assert.equal(seen(), null);

    await connection.close();

    // A student asking for the teacher view is refused before anything runs.
    const forged = await quietly(() => connect("teacher"));

    assert.equal(forged.status, 401);
    assert.equal(db.writes.length, 0);
});

test("another teacher, or no login: refused, no presence", async t => {
    reset(t);

    login = { role: "TEACHER", id: OTHER_TEACHER };
    assert.equal((await quietly(() => connect("teacher"))).status, 404);

    login = null;
    assert.equal((await quietly(() => connect("teacher"))).status, 401);

    await tick(t, 60_000);
    assert.equal(db.writes.length, 0);
});

// ---- Existing sessions and failures --------------------------------------------

test("an ended session keeps its row as it is; the stream still works", async t => {
    reset(t);
    db.session.isActive = false;
    login = { role: "TEACHER", id: TEACHER };

    const connection = await connect("teacher");

    assert.equal(connection.isStream, true);
    assert.equal(seen(), null, "never written for an ended session");

    await connection.close();
});

test("a failing database write never breaks the stream", async t => {
    reset(t);
    db.failWrites = true;
    login = { role: "TEACHER", id: TEACHER };

    await quietly(async () => {
        const connection = await connect("teacher");

        assert.equal(connection.isStream, true);
        assert.match(await firstEvent(connection), /^event: live-status\n/);

        await tick(t, 10_000);
        assert.equal(db.writes.length, 2, "still retried on the next refresh");

        await connection.close();
    });

    assert.equal(await quietly(() => recordTeacherPresence(SESSION)), false, "never throws");
});

// ---- Presence and the tab-close signal --------------------------------------------

test("network loss, SSE drop, Wi-Fi switch: disconnects and reconnects never create a departure", async t => {
    reset(t);
    login = { role: "TEACHER", id: TEACHER };

    // The page keeps its pageId across EventSource reconnects (a Wi-Fi switch,
    // a dropped proxy connection, a phone backgrounding the browser).
    let connection = await connect("teacher", "page-aaaaaaaa");

    for (const gapMs of [5_000, 60_000, 10 * 60_000]) {
        await connection.close();
        await tick(t, gapMs);
        connection = await connect("teacher", "page-aaaaaaaa");
    }

    await connection.close();
    await tick(t, 60 * 60_000);

    assert.equal(db.session.teacherDepartureAt, null, "no tab-close signal: never a departure");
    assert.equal(db.session.teacherDeparturePageId, null);
    assert.ok(db.departureWrites.every(w => !("teacherDepartureAt" in w.data)), "presence never writes a signal");
});

test("a pending tab-close signal: a refreshed page connecting cancels it", async t => {
    reset(t);
    login = { role: "TEACHER", id: TEACHER };
    Object.assign(db.session, { teacherDepartureAt: new Date(999_000), teacherDeparturePageId: "page-old-1" });

    const connection = await connect("teacher", "page-new-1");

    assert.equal(db.session.teacherActiveAfterDepartureAt.getTime(), 1_000_000);

    await connection.close();
});

test("server-side presence refresh never cancels a departure; only a live page's own (re)connection does", async t => {
    reset(t);
    login = { role: "TEACHER", id: TEACHER };

    // An old page's connection the server has not noticed is gone keeps ticking.
    const lingering = await connect("teacher", "page-old-1");

    // The newer, current page closed: its signal is pending.
    Object.assign(db.session, {
        teacherCurrentPageId: "page-new-1", teacherDepartureAt: new Date(1_000_000), teacherDeparturePageId: "page-new-1"
    });

    await tick(t, 30_000);
    assert.equal(db.session.teacherActiveAfterDepartureAt, null, "server-side ticks are not the teacher");
    assert.equal(db.session.teacherCurrentPageId, "page-new-1", "an old page cannot take over by ticking");
    await lingering.close();

    // A page that actually reconnects (its browser opened a new request) is live.
    Object.assign(db.session, { teacherDepartureAt: new Date(1_030_000) });
    const reconnected = await connect("teacher", "page-old-1");

    assert.equal(db.session.teacherActiveAfterDepartureAt.getTime(), 1_030_000);
    assert.equal(db.session.teacherCurrentPageId, "page-old-1", "the live page takes over from the closed one");

    await reconnected.close();
});

test("students' connections never touch the tab-close signal", async t => {
    reset(t);
    login = { role: "STUDENT", id: STUDENT };
    Object.assign(db.session, { teacherDepartureAt: new Date(999_000), teacherDeparturePageId: "page-closing" });

    const connection = await connect("student");

    await tick(t, 60_000);
    assert.equal(db.session.teacherActiveAfterDepartureAt, null, "a student is not the teacher coming back");
    assert.deepEqual(db.departureWrites, []);

    await connection.close();
});
