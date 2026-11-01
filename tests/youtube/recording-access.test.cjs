/*
 * LOCKED recording links on the public class pages (security).
 *
 *   npm run test:youtube
 *
 * The public class pages (four routes, all fed by getPublicClassSessions in
 * services/class-service.ts) are open to anyone. A LOCKED recording is listed
 * there, but its YouTube video ID / URL must never be in what the server
 * hands to the page (the props of the client component, i.e. the RSC
 * payload): the server decides, not the Watch button.
 *
 * Unchanged access, checked on the real code:
 * - FREE + PUBLIC recordings: playable on the public pages.
 * - PRIVATE recordings: never on the public pages or in the student portal.
 * - Students actively enrolled in the class: every PUBLIC recording, FREE or
 *   LOCKED, with its link (the existing student-portal rule); anyone else
 *   (not enrolled, inactive, not signed in) gets nothing.
 * - The owning teacher: every recording of their lecture; another teacher:
 *   nothing.
 *
 * In-memory Prisma; the real service, route and page modules (through tsx).
 * Nothing contacts a database or YouTube.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

// The page modules' JSX compiles to React.createElement here (no Next.js build).
globalThis.React = require("react");

const root = path.resolve(__dirname, "..", "..");
const load = relativePath => require(path.join(root, relativePath));

// ---- Data -------------------------------------------------------------------

const CLASS = "class-1";
const LECTURE = "lecture-1";
const TEACHER = "teacher-1";

const FREE_PUBLIC = "vidFreePublic01";
const LOCKED_PUBLIC = "vidLockedPublic2";
const FREE_PRIVATE = "vidFreePrivate03";
const LOCKED_PRIVATE = "vidLockedPrivate4";

const recording = (id, videoId, visibility, access, startedAt) => ({
    id,
    lectureId: LECTURE,
    videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
    visibility,
    access,
    status: "COMPLETE",
    privacy: "UNLISTED",
    startedAt: new Date(startedAt),
    endedAt: new Date(Date.parse(startedAt) + 3_600_000),
    createdAt: new Date(startedAt)
});

const db = {
    recordings: [
        recording("rec-1", FREE_PUBLIC, "PUBLIC", "FREE", "2026-10-01T10:00:00Z"),
        recording("rec-2", LOCKED_PUBLIC, "PUBLIC", "LOCKED", "2026-10-02T10:00:00Z"),
        recording("rec-3", FREE_PRIVATE, "PRIVATE", "FREE", "2026-10-03T10:00:00Z"),
        recording("rec-4", LOCKED_PRIVATE, "PRIVATE", "LOCKED", "2026-10-04T10:00:00Z")
    ],
    // Class enrolments.
    enrolments: [
        { studentId: "student-active", isActive: true },
        { studentId: "student-inactive", isActive: false }
    ]
};

const LOCKED_OR_PRIVATE = [LOCKED_PUBLIC, FREE_PRIVATE, LOCKED_PRIVATE];

// ---- Fake Prisma (only what these code paths query) ------------------------------

const lectureRow = { id: LECTURE, title: "Algebra", classId: CLASS, status: 0, date: new Date("2026-10-01"), createdAt: new Date("2026-09-30") };

// Applies a nested select ({ field: true } or { select / where }) to a row.
function project(row, select) {
    if (!select) return { ...row };

    const out = {};

    for (const [key, value] of Object.entries(select)) {
        if (value === true) out[key] = row[key];
    }
    return out;
}

const matchesRecordingWhere = (rec, where = {}) =>
    Object.entries(where).every(([key, value]) => rec[key] === value);

function lectureView(select) {
    const view = project(lectureRow, select);

    if (select.class) view.class = { id: CLASS, name: "Maths", schedule: null };
    for (const relation of ["notes", "assignments", "whiteboards"]) {
        if (select[relation]) view[relation] = [];
    }
    if (select.youtubeRecordings) {
        const { where, select: fields } = select.youtubeRecordings;

        view.youtubeRecordings = db.recordings
            .filter(rec => rec.lectureId === LECTURE && matchesRecordingWhere(rec, where))
            .map(rec => project(rec, fields));
    }
    return view;
}

const prisma = {
    class: {
        findFirst: async ({ where }) => where.id === CLASS ? {
            id: CLASS, name: "Maths", description: "", monthlyFee: 0, paymentDueWeek: 1, teacherId: TEACHER,
            teacher: { profile: { slug: "teacher" } }, startDate: null, schedule: null, schedules: [], students: []
        } : null
    },
    note: { findMany: async () => [] },
    lecture: {
        // getPublicClassSessions.
        findMany: async ({ where, select }) => {
            if (where.classId !== CLASS) return [];

            const some = where.youtubeRecordings?.some;
            const hasMatching = db.recordings.some(rec => rec.lectureId === LECTURE && matchesRecordingWhere(rec, some));

            return hasMatching ? [lectureView(select)] : [];
        },
        // The student lecture route (enrolment) and the teacher's ownership check.
        findFirst: async ({ where, select }) => {
            if (where.id !== LECTURE) return null;

            const enrolment = where.class?.students?.some;

            if (enrolment && !db.enrolments.some(e =>
                e.studentId === enrolment.studentId && e.isActive === enrolment.isActive)) {
                return null;
            }

            if (where.class && "teacherId" in where.class && where.class.teacherId !== TEACHER) return null;

            return lectureView(select);
        }
    },
    youTubeRecording: {
        // The teacher's recording list.
        findMany: async ({ where, select }) =>
            db.recordings.filter(rec => rec.lectureId === where.lectureId).map(rec => project(rec, select))
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

const { AppError } = load("lib/error-handler.ts");

// The signed-in student (null: nobody signed in).
let studentId = null;

fake("lib/prisma.ts", { prisma });
fake("lib/auth-session.ts", {
    requireStudentSession: async () => {
        if (!studentId) throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
        return { studentId, role: "STUDENT" };
    }
});

const classService = load("services/class-service.ts");
const lectureService = load("services/lecture-service.ts");
const studentLectureRoute = load("app/api/student/lectures/[lectureId]/route.ts");

const PUBLIC_PAGES = {
    "app/publicClass/[classId]/page.tsx": { classId: CLASS },
    "app/publicclasses/[classId]/page.tsx": Promise.resolve({ classId: CLASS }),
    "app/dashboard/publicclasses/[classId]/page.tsx": { classId: CLASS },
    "app/[slug]/pubClass/page.tsx": { classId: CLASS, slug: "teacher" }
};

const assertNoneOf = (payload, ids, label) => {
    for (const id of ids) assert.ok(!payload.includes(id), `${label}: must not contain ${id}`);
};

async function studentGet(id) {
    studentId = id;
    const response = await studentLectureRoute.GET(new Request("http://test/api/student/lectures/" + LECTURE), {
        params: { lectureId: LECTURE }
    });
    const text = await response.text();

    return { status: response.status, text, body: JSON.parse(text) };
}

// ---- Public class pages ---------------------------------------------------------------

test("1. public service: a LOCKED recording is listed WITHOUT its video ID / URL; FREE keeps them; PRIVATE is not listed", async () => {
    const sessions = await classService.getPublicClassSessions(CLASS);
    const payload = JSON.stringify(sessions);

    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].recordings.map(r => r.id), ["rec-1", "rec-2"], "PUBLIC only, oldest first");

    const [free, locked] = sessions[0].recordings;

    assert.equal(free.access, "FREE");
    assert.equal(free.videoId, FREE_PUBLIC);
    assert.equal(free.youtubeUrl, `https://www.youtube.com/watch?v=${FREE_PUBLIC}`);

    assert.equal(locked.access, "LOCKED");
    assert.equal(locked.videoId, null);
    assert.equal(locked.youtubeUrl, null);
    assert.ok(locked.startedAt && locked.endedAt, "still listed with its times (shown behind the lock)");

    assertNoneOf(payload, LOCKED_OR_PRIVATE, "public service payload");
    assert.ok(payload.includes(FREE_PUBLIC));
});

test("2. every public class page: the props handed to the client component (RSC payload) carry no LOCKED or PRIVATE video", async () => {
    for (const [file, params] of Object.entries(PUBLIC_PAGES)) {
        const Page = load(file).default;
        const element = await Page({ params });

        assert.ok(element && element.props && Array.isArray(element.props.sessions), `${file}: renders the landing page with sessions`);

        const payload = JSON.stringify(element.props);

        assertNoneOf(payload, LOCKED_OR_PRIVATE, file);
        assert.ok(payload.includes(FREE_PUBLIC), `${file}: the FREE recording is still playable`);
    }
});

test("3. the public decision is made on the server and denies by default (an unknown access value is treated as LOCKED)", () => {
    const base = { id: "x", videoId: "vidSecret", youtubeUrl: "https://www.youtube.com/watch?v=vidSecret", startedAt: null, endedAt: null };

    assert.deepEqual(classService.toPublicClassRecording({ ...base, access: "LOCKED" }), {
        id: "x", startedAt: null, endedAt: null, access: "LOCKED", videoId: null, youtubeUrl: null
    });
    assert.equal(classService.toPublicClassRecording({ ...base, access: "SOMETHING_NEW" }).videoId, null);
    assert.equal(classService.toPublicClassRecording({ ...base, access: "FREE" }).videoId, "vidSecret");
});

// ---- Student portal (enrolled students only) -------------------------------------------

test("4. an actively enrolled student still gets every PUBLIC recording, FREE and LOCKED, with its link; never a PRIVATE one", async () => {
    const { status, body, text } = await studentGet("student-active");

    assert.equal(status, 200);

    const byId = Object.fromEntries(body.data.lecture.recordings.map(r => [r.id, r]));

    assert.deepEqual(Object.keys(byId).sort(), ["rec-1", "rec-2"]);
    assert.equal(byId["rec-1"].videoId, FREE_PUBLIC);
    assert.equal(byId["rec-2"].videoId, LOCKED_PUBLIC, "entitled: the existing student-portal rule");
    assert.equal(byId["rec-2"].access, "LOCKED");
    assertNoneOf(text, [FREE_PRIVATE, LOCKED_PRIVATE], "enrolled student");
});

test("5. not entitled (not enrolled, inactive enrolment, not signed in): refused, and the response carries no video at all", async () => {
    for (const [label, id, expected] of [
        ["not enrolled", "student-stranger", 404],
        ["inactive enrolment", "student-inactive", 404],
        ["not signed in", null, 401]
    ]) {
        const { status, text } = await studentGet(id);

        assert.equal(status, expected, label);
        assertNoneOf(text, [FREE_PUBLIC, ...LOCKED_OR_PRIVATE], label);
        assert.ok(!text.includes("youtube.com"), `${label}: no YouTube link`);
    }
});

// ---- Teacher (unchanged) ---------------------------------------------------------------

test("6. the owning teacher still sees every recording of the lecture with its link; another teacher is refused", async () => {
    const own = await lectureService.listRecordingsForLectureForTeacher(TEACHER, LECTURE);

    assert.deepEqual(own.map(r => r.videoId).sort(), [FREE_PUBLIC, LOCKED_PUBLIC, FREE_PRIVATE, LOCKED_PRIVATE].sort());

    await assert.rejects(
        () => lectureService.listRecordingsForLectureForTeacher("teacher-other", LECTURE),
        error => error instanceof AppError && error.statusCode !== 200
    );
});
