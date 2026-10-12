/*
 * Regression tests: student attendance (one Attendance row per actual visit).
 *
 *   npm run test:attendance
 *
 * Runs the real code through tsx: the classroom page's useAttendance hook and
 * its visit tracker (components/Jitsi/attendance-visit.ts), the API routes
 * (POST /api/attendance, POST /api/sessions/[id]/leave, GET
 * /api/sessions/[id]/attendance), services/session-service.ts and the duration
 * helpers. Only the edges are faked: Prisma (an in-memory Attendance table),
 * the login session, Jitsi tokens, mail, and React's useRef / useCallback for
 * the hook. The browser's fetch is routed straight to the route handlers.
 *
 * Not covered here (needs a real browser + Jitsi): the timing of Jitsi's own
 * videoConferenceLeft / videoConferenceJoined events and useJitsi's grace
 * timer, and whether a keepalive request survives a real page unload.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

// ---- Fixed IDs ------------------------------------------------------------

const STUDENT = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDENT = "22222222-2222-4222-8222-222222222222";
const CLASS = "33333333-3333-4333-8333-333333333333";
const OTHER_CLASS = "44444444-4444-4444-8444-444444444444";
const SESSION = "55555555-5555-4555-8555-555555555555";
const TEACHER = "teacher-1";

const T = (hhmm) => new Date(`2026-10-12T${hhmm}:00.000Z`);

// ---- Clock ----------------------------------------------------------------

test.mock.timers.enable({ apis: ["Date"], now: T("07:00") });

const setNow = hhmm => test.mock.timers.setTime(T(hhmm).getTime());

// ---- Fake database --------------------------------------------------------

const db = {
    session: null,
    enrolled: new Set(),
    attendance: []
};

function resetDb() {
    db.session = {
        id: SESSION, classId: CLASS, lectureId: null, roomName: "room-1", jitsiDomain: "meet.jit.si",
        isActive: true, startedAt: T("08:00"), endedAt: null, teacherId: TEACHER
    };
    db.enrolled = new Set([STUDENT, OTHER_STUDENT]);
    db.attendance = [];
}

const students = {
    [STUDENT]: { id: STUDENT, name: "Nimal", grade: null, contact: "0700000001" },
    [OTHER_STUDENT]: { id: OTHER_STUDENT, name: "Kamal", grade: null, contact: "0700000002" }
};

function pick(row, select) {
    if (!select) return { ...row };

    const out = {};

    for (const key of Object.keys(select)) {
        if (key === "student") out.student = { ...students[row.studentId] };
        else out[key] = row[key];
    }

    return out;
}

function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => {
        if (value && typeof value === "object" && !(value instanceof Date) && "in" in value) {
            return value.in.includes(row[key]);
        }

        if (value instanceof Date) return row[key] && row[key].getTime() === value.getTime();

        return row[key] === value;
    });
}

function sortRows(rows, orderBy) {
    const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];

    return rows.slice().sort((a, b) => {
        for (const order of orders) {
            const [key, dir] = Object.entries(order)[0];
            const av = a[key] instanceof Date ? a[key].getTime() : a[key];
            const bv = b[key] instanceof Date ? b[key].getTime() : b[key];

            if (av < bv) return dir === "asc" ? -1 : 1;
            if (av > bv) return dir === "asc" ? 1 : -1;
        }

        return 0;
    });
}

const sessionView = () => ({
    id: db.session.id,
    classId: db.session.classId,
    lectureId: db.session.lectureId,
    roomName: db.session.roomName,
    jitsiDomain: db.session.jitsiDomain,
    isActive: db.session.isActive,
    startedAt: db.session.startedAt,
    endedAt: db.session.endedAt,
    lecture: null,
    class: {
        id: db.session.classId, name: "Physics", schedule: null,
        teacher: { name: "Teacher", profile: null, youtubeConnection: null }
    }
});

const fakePrisma = {
    classSession: {
        findUnique: async ({ where }) => (db.session && where.id === db.session.id ? sessionView() : null),
        findFirst: async ({ where }) =>
            db.session && where.id === db.session.id && where.class?.teacherId === db.session.teacherId
                ? sessionView()
                : null,
        update: async ({ where, data }) => {
            assert.equal(where.id, db.session.id);
            Object.assign(db.session, data);
            return { classId: db.session.classId };
        },
        // End Session ends the session only while it is active.
        updateMany: async ({ where, data }) => {
            assert.equal(where.id, db.session.id);
            if (where.isActive !== undefined && db.session.isActive !== where.isActive) return { count: 0 };
            Object.assign(db.session, data);
            return { count: 1 };
        }
    },
    student: {
        findFirst: async ({ where }) =>
            db.enrolled.has(where.id) && where.classes.some.classId === db.session.classId
                ? { ...students[where.id] }
                : null
    },
    classStudent: {
        findMany: async () => Array.from(db.enrolled).map(id => ({ student: { ...students[id] } }))
    },
    attendance: {
        create: async ({ data, select }) => {
            // Real Prisma IDs are UUIDs (the leave request validates them).
            const row = { id: randomUUID(), leftAt: null, ...data };

            db.attendance.push(row);

            return pick(row, select);
        },
        findMany: async ({ where, orderBy, select }) =>
            sortRows(db.attendance.filter(row => matches(row, where)), orderBy).map(row => pick(row, select)),
        findFirst: async ({ where, orderBy, select }) => {
            const row = sortRows(db.attendance.filter(row => matches(row, where)), orderBy)[0];

            return row ? pick(row, select) : null;
        },
        findUnique: async ({ where, select }) => {
            const row = db.attendance.find(r => r.id === where.id);

            return row ? pick(row, select) : null;
        },
        updateMany: async ({ where, data }) => {
            const rows = db.attendance.filter(row => matches(row, where));

            rows.forEach(row => Object.assign(row, data));

            return { count: rows.length };
        }
    },
    $transaction: async fn => fn(fakePrisma)
};

// ---- Fake login session ---------------------------------------------------

let currentStudent = STUDENT;

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
    requireStudentSession: async () => ({ studentId: currentStudent, email: "s@example.com", name: "S", role: "STUDENT" }),
    requireTeacherSession: async () => ({ teacherId: TEACHER })
});
fake("lib/jitsi-auth.ts", { generateJitsiToken: async () => "token" });
fake("lib/mailer.ts", { buildLiveSessionInviteLoginLink: () => "", sendLiveSessionInviteEmail: async () => {} });
fake("lib/session-invite.ts", { signSessionInviteToken: () => "" });

// React, for the hook: refs and callbacks as plain values.
const reactPath = require.resolve("react", { paths: [root] });
const fakeReact = { useRef: value => ({ current: value }), useCallback: fn => fn };

require.cache[reactPath] = Object.assign(new Module(reactPath), { filename: reactPath, loaded: true, exports: fakeReact });

const sessionEvents = require(path.join(root, "lib/session-events.ts"));
const service = require(path.join(root, "services/session-service.ts"));
const attendanceRoute = require(path.join(root, "app/api/attendance/route.ts"));
const leaveRoute = require(path.join(root, "app/api/sessions/[id]/leave/route.ts"));
const historyRoute = require(path.join(root, "app/api/sessions/[id]/attendance/route.ts"));
const { createAttendanceVisit } = require(path.join(root, "components/Jitsi/attendance-visit.ts"));
const useAttendance = require(path.join(root, "components/Jitsi/hooks/useAttendance.ts")).default;
const { attendedMs } = require(path.join(root, "lib/attendance-duration.ts"));

// ---- Events ---------------------------------------------------------------

let events = [];

sessionEvents.subscribeSessionAttendanceEvents(SESSION, payload => events.push(payload));

// ---- The browser: fetch straight to the route handlers --------------------

let requests = [];
// When set, leave requests are "lost" (e.g. cancelled by a page unload).
let dropLeaves = false;

async function routeFetch(url, init = {}) {
    requests.push({ url, init });

    const request = new Request("http://localhost" + url, init);

    if (url === "/api/attendance") {
        return attendanceRoute.POST(request);
    }

    const leave = url.match(/^\/api\/sessions\/([^/]+)\/leave$/);

    if (leave) {
        if (dropLeaves) {
            throw new TypeError("Failed to fetch");
        }

        return leaveRoute.POST(request, { params: { id: leave[1] } });
    }

    throw new Error("Unexpected request " + url);
}

global.fetch = routeFetch;

// A classroom page (one tab): the real useAttendance hook.
function openPage({ studentId = STUDENT, bodyStudentId = studentId } = {}) {
    currentStudent = studentId;

    return useAttendance(
        { session: { id: SESSION }, class: { id: CLASS }, student: { id: bodyStudentId } },
        "student"
    );
}

function reset() {
    resetDb();
    events = [];
    requests = [];
    dropLeaves = false;
    currentStudent = STUDENT;
    setNow("07:00");
}

const visits = (studentId = STUDENT) =>
    db.attendance.filter(row => row.studentId === studentId).map(row => ({
        joinedAt: row.joinedAt.toISOString().slice(11, 16),
        leftAt: row.leftAt ? row.leftAt.toISOString().slice(11, 16) : null
    }));

async function quietly(fn) {
    const original = console.error;

    console.error = () => {};

    try {
        return await fn();
    } finally {
        console.error = original;
    }
}

// ---- Join -------------------------------------------------------------------

test("first join: one record, HTTP 200, one joined event", async () => {
    reset();
    setNow("08:00");

    const response = await attendanceRoute.POST(new Request("http://localhost/api/attendance", {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION, classId: CLASS, studentId: STUDENT })
    }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.attendance.studentId, STUDENT);
    assert.equal(body.data.attendance.classSessionId, SESSION);
    assert.deepEqual(visits(), [{ joinedAt: "08:00", leftAt: null }]);
    assert.deepEqual(events.map(e => [e.event, e.attendanceId]), [["joined", body.data.attendance.id]]);
});

test("the logged-in student is recorded, never a studentId from the request body", async () => {
    reset();
    setNow("08:00");

    const page = openPage({ studentId: STUDENT, bodyStudentId: OTHER_STUDENT });

    await page.markJoined();

    assert.equal(db.attendance.length, 1);
    assert.equal(db.attendance[0].studentId, STUDENT);
    assert.deepEqual(visits(OTHER_STUDENT), []);
});

test("a mismatched classId and an ended session are rejected, nothing recorded", async () => {
    reset();

    const post = body => attendanceRoute.POST(new Request("http://localhost/api/attendance", {
        method: "POST",
        body: JSON.stringify(body)
    }));

    const mismatch = await post({ sessionId: SESSION, classId: OTHER_CLASS, studentId: STUDENT });

    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, "CLASS_SESSION_MISMATCH");

    db.session.isActive = false;

    const ended = await post({ sessionId: SESSION, classId: CLASS, studentId: STUDENT });

    assert.equal(ended.status, 404);
    assert.equal((await ended.json()).error.code, "SESSION_NOT_ACTIVE");
    assert.equal(db.attendance.length, 0);
    assert.equal(events.length, 0);
});

// ---- Leave and rejoin ---------------------------------------------------------

test("normal leave closes that visit and emits one left event", async () => {
    reset();
    setNow("08:00");

    const page = openPage();

    await page.markJoined();
    setNow("08:10");
    await page.markLeft();

    assert.deepEqual(visits(), [{ joinedAt: "08:00", leftAt: "08:10" }]);
    assert.deepEqual(events.map(e => e.event), ["joined", "left"]);
    assert.equal(events[1].attendanceId, db.attendance[0].id);
    assert.equal(events[1].leftAt, T("08:10").toISOString());

    // The leave names its visit, and survives a page unload where supported.
    const leave = requests.find(r => r.url.endsWith("/leave"));

    assert.equal(leave.init.keepalive, true);
    assert.equal(JSON.parse(leave.init.body).attendanceId, db.attendance[0].id);
});

test("leave at 08:10, rejoin at 08:50, session ends at 09:00: two visits with their own times", async () => {
    reset();

    const page = openPage();

    setNow("08:00");
    await page.markJoined();
    setNow("08:10");
    await page.markLeft();
    setNow("08:50");
    await page.markJoined();

    assert.equal(db.attendance.length, 2, "a new record; the closed one is not reused");

    setNow("09:00");
    await service.endClassSessionForTeacher(TEACHER, SESSION);

    assert.deepEqual(visits(), [
        { joinedAt: "08:00", leftAt: "08:10" },
        { joinedAt: "08:50", leftAt: "09:00" }
    ]);
    assert.deepEqual(events.map(e => e.event), ["joined", "left", "joined"]);
});

test("a late leave for an old visit never closes a later visit", async () => {
    reset();
    setNow("08:00");
    await openPage().markJoined();

    const first = db.attendance[0].id;

    setNow("08:10");
    await service.markStudentLeftSession(SESSION, { studentId: STUDENT }, first);
    setNow("08:50");
    await openPage().markJoined();

    // The first visit's leave arrives again (retry / second tab): no effect.
    setNow("08:55");

    const late = await service.markStudentLeftSession(SESSION, { studentId: STUDENT }, first);

    assert.equal(late.updated, false);
    assert.deepEqual(visits(), [
        { joinedAt: "08:00", leftAt: "08:10" },
        { joinedAt: "08:50", leftAt: null }
    ]);
});

test("a leave only touches the logged-in student's own visit in this session", async () => {
    reset();
    setNow("08:00");
    await openPage({ studentId: OTHER_STUDENT }).markJoined();

    const otherVisit = db.attendance[0].id;

    // Another student naming that visit: not theirs, nothing changes.
    const result = await service.markStudentLeftSession(SESSION, { studentId: STUDENT }, otherVisit);

    assert.equal(result.updated, false);
    assert.equal(db.attendance[0].leftAt, null);
});

// ---- Reconnects and refreshes -----------------------------------------------

test("a brief Jitsi reconnect (joined again before the leave is confirmed) is not a new visit", async () => {
    reset();
    setNow("08:00");

    const page = openPage();

    await page.markJoined();

    // useJitsi: videoConferenceLeft starts the grace timer; videoConferenceJoined
    // arrives within it, cancels the leave (markLeft never runs) and calls
    // markJoined again.
    setNow("08:20");
    await page.markJoined();
    await page.markJoined();

    assert.deepEqual(visits(), [{ joinedAt: "08:00", leftAt: null }]);
    assert.equal(requests.filter(r => r.url === "/api/attendance").length, 1);
    assert.deepEqual(events.map(e => e.event), ["joined"]);

    setNow("08:40");
    await page.markLeft();
    assert.deepEqual(visits(), [{ joinedAt: "08:00", leftAt: "08:40" }]);
});

test("a confirmed leave (grace period over) followed by a join is a new visit", async () => {
    reset();

    const page = openPage();

    setNow("08:00");
    await page.markJoined();
    setNow("08:20");
    await page.markLeft();
    setNow("08:21");
    await page.markJoined();

    assert.deepEqual(visits(), [
        { joinedAt: "08:00", leftAt: "08:20" },
        { joinedAt: "08:21", leftAt: null }
    ]);
});

test("refresh, unload leave delivered: the old visit ends at unload, a new visit starts", async () => {
    reset();
    setNow("08:00");

    const before = openPage();

    await before.markJoined();

    // beforeunload / pagehide / teardown all call markLeft: one request.
    setNow("08:30");
    await before.markLeft();
    await before.markLeft();
    await before.markLeft();

    assert.equal(requests.filter(r => r.url.endsWith("/leave")).length, 1);

    setNow("08:31");
    await openPage().markJoined();

    assert.deepEqual(visits(), [
        { joinedAt: "08:00", leftAt: "08:30" },
        { joinedAt: "08:31", leftAt: null }
    ]);
});

test("refresh, unload leave lost: the new join closes the stale visit, no overlap, nothing deleted", async () => {
    reset();
    setNow("08:00");

    const before = openPage();

    await before.markJoined();

    setNow("08:30");
    dropLeaves = true;
    await quietly(() => before.markLeft());
    dropLeaves = false;

    assert.deepEqual(visits(), [{ joinedAt: "08:00", leftAt: null }], "the leave never arrived");

    setNow("08:31");
    await openPage().markJoined();

    assert.deepEqual(visits(), [
        { joinedAt: "08:00", leftAt: "08:31" },
        { joinedAt: "08:31", leftAt: null }
    ]);
    assert.equal(db.attendance.filter(row => row.leftAt === null).length, 1, "one open visit at a time");
});

test("a failed join is retried by the next Jitsi join; a leave during the join request ends that visit", async () => {
    reset();
    setNow("08:00");

    // The join request fails once.
    let failNext = true;
    const tracker = createAttendanceVisit({
        join: async () => {
            if (failNext) {
                failNext = false;
                return null;
            }

            return (await service.markAttendanceOnJoin({ sessionId: SESSION, student: { studentId: STUDENT } })).attendance.id;
        },
        leave: async id => { await service.markStudentLeftSession(SESSION, { studentId: STUDENT }, id); }
    });

    await tracker.joined();
    assert.equal(tracker.state(), "none");
    assert.equal(db.attendance.length, 0);

    setNow("08:01");
    await tracker.joined();
    assert.equal(tracker.state(), "open");
    assert.deepEqual(visits(), [{ joinedAt: "08:01", leftAt: null }]);

    // Leave confirmed while a new visit's join request is still running.
    await tracker.left();
    setNow("08:05");

    const joining = tracker.joined();

    await tracker.left();
    await joining;

    assert.equal(tracker.state(), "none");
    assert.equal(db.attendance.filter(row => row.leftAt === null).length, 0, "no visit left open");
});

// ---- Teacher history and durations --------------------------------------------

test("teacher history lists every visit in chronological order with its own times and total", async () => {
    reset();

    const page = openPage();

    setNow("08:00");
    await page.markJoined();
    setNow("08:10");
    await page.markLeft();
    setNow("08:50");
    await page.markJoined();
    setNow("09:00");
    await service.endClassSessionForTeacher(TEACHER, SESSION);

    const response = await historyRoute.GET(new Request("http://localhost/api/sessions/" + SESSION + "/attendance"), {
        params: { id: SESSION }
    });
    const body = await response.json();

    assert.equal(response.status, 200);

    const [entry] = body.data.joinedStudents;

    assert.equal(entry.student.id, STUDENT);
    assert.deepEqual(entry.logs.map(log => [log.joinedAt, log.leftAt]), [
        [T("08:00").toISOString(), T("08:10").toISOString()],
        [T("08:50").toISOString(), T("09:00").toISOString()]
    ]);
    assert.equal(entry.totalAttendedMs, 20 * 60000, "10 + 10 minutes; the gap is not counted");
    assert.equal(entry.isPresent, false);
    assert.deepEqual(body.data.notJoinedStudents.map(s => s.id), [OTHER_STUDENT]);
});

test("durations: visits are summed, overlaps merged (no double count), open visits handled explicitly", () => {
    const v = (from, to) => ({ joinedAt: T(from), leftAt: to ? T(to) : null });

    // 08:00-08:10 + 08:50-09:00
    assert.equal(attendedMs([v("08:00", "08:10"), v("08:50", "09:00")]), 20 * 60000);

    // An old duplicate row overlapping a visit: the same minutes once.
    assert.equal(attendedMs([v("08:00", "08:30"), v("08:00", "08:30"), v("08:20", "08:40")]), 40 * 60000);

    // Open visit: left out unless an end is given.
    assert.equal(attendedMs([v("08:00", "08:10"), v("08:50", null)]), 10 * 60000);
    assert.equal(attendedMs([v("08:00", "08:10"), v("08:50", null)], { openUntil: T("09:00") }), 20 * 60000);

    // Clamped to the session window.
    assert.equal(attendedMs([v("07:50", "08:10")], { sessionStart: T("08:00"), sessionEnd: T("09:00") }), 10 * 60000);
});

test("ending a session closes every open visit of that session, and only those", async () => {
    reset();
    setNow("08:00");
    await openPage({ studentId: STUDENT }).markJoined();
    await openPage({ studentId: OTHER_STUDENT }).markJoined();

    setNow("08:30");

    // OTHER_STUDENT left already.
    await service.markStudentLeftSession(SESSION, { studentId: OTHER_STUDENT });

    // An open visit of another session must not be touched.
    db.attendance.push({
        id: "other-session-visit", classSessionId: "other-session", classId: CLASS,
        studentId: STUDENT, joinedAt: T("08:00"), leftAt: null
    });

    setNow("09:00");
    await service.endClassSessionForTeacher(TEACHER, SESSION);

    assert.deepEqual(visits(STUDENT).slice(0, 1), [{ joinedAt: "08:00", leftAt: "09:00" }]);
    assert.deepEqual(visits(OTHER_STUDENT), [{ joinedAt: "08:00", leftAt: "08:30" }], "an earlier leave is kept");
    assert.equal(db.attendance.find(row => row.id === "other-session-visit").leftAt, null);
    assert.equal(db.session.isActive, false);
});
