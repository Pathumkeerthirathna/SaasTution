/*
 * Lecture end time (Lecture.endDate): validation, the lecture service and
 * the lecture API routes.
 *
 *   npm run test:lectures
 *
 * Runs the real lib/lecture-schedule.ts, lib/lecture-validation.ts,
 * services/lecture-service.ts and app/api/lectures routes through tsx. Only
 * the edges are faked: Prisma (an in-memory Lecture table that enforces the
 * migration's CHECK constraint "endDate" IS NULL OR "endDate" > "date"), the
 * teacher login, live-update events and the fee-waiver hooks (recorded, to
 * check they are called exactly as before). Every expectation is a fixed UTC
 * instant, so the suite passes in any process timezone.
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
const CLASS = "11111111-1111-4111-8111-111111111111";
const LECTURE = "22222222-2222-4222-8222-222222222222";
const LEGACY = "33333333-3333-4333-8333-333333333333";

const utc = (iso) => new Date(iso);

// ---- Fake database ------------------------------------------------------------------

let db;
let updates;
let creates;
let waiverCalls;
// A stale stored row returned by the ownership read (a concurrent edit).
let staleRead = null;

function resetDb() {
    db = {
        classes: { [CLASS]: { id: CLASS, name: "Physics", schedule: "Mon 09:00", teacherId: TEACHER, status: 0 } },
        lectures: {
            // 09:00-11:00 Sri Lanka = 03:30-05:30 UTC.
            [LECTURE]: {
                id: LECTURE, title: "Kinematics", classId: CLASS, status: 0, classStatus: "SCHEDULED",
                createdAt: utc("2026-11-01T00:00:00.000Z"),
                date: utc("2026-11-10T03:30:00.000Z"), endDate: utc("2026-11-10T05:30:00.000Z")
            },
            // An existing lecture from before this feature: no end time.
            [LEGACY]: {
                id: LEGACY, title: "Optics", classId: CLASS, status: 0, classStatus: "COMPLETED",
                createdAt: utc("2026-10-01T00:00:00.000Z"),
                date: utc("2026-10-20T03:30:00.000Z"), endDate: null
            }
        }
    };
    updates = [];
    creates = [];
    waiverCalls = [];
    staleRead = null;
}

function pick(row, select) {
    if (!select) return { ...row };

    const out = {};

    for (const [key, value] of Object.entries(select)) {
        if (key === "class") {
            const cls = db.classes[row.classId];
            out.class = value.select
                ? Object.fromEntries(Object.keys(value.select).map(k => [k, cls[k]]))
                : { ...cls };
        } else if (key === "_count") {
            out._count = { notes: 0, assignments: 0, quizzes: 0, whiteboards: 0 };
        } else {
            out[key] = row[key];
        }
    }

    return out;
}

function checkConstraint(row) {
    if (row.endDate !== null && row.endDate !== undefined && !(row.endDate.getTime() > row.date.getTime())) {
        // The shape of PostgreSQL's message, as Prisma passes it on.
        throw new Error('new row for relation "Lecture" violates check constraint "Lecture_endDate_after_date"');
    }
}

const fakePrisma = {
    // Stage 5.4e: schedule edits, cancelling and deleting run in an attendance
    // transaction (services/lecture-service.ts). No concurrency here (see
    // tests/attendance/schedule-sync.test.cjs); the transaction client is this
    // same object, the lecture lock reads the real (never stale) row, and no
    // attendance register exists.
    $transaction: async (fn) => fn(fakePrisma),
    $executeRawUnsafe: async (sql) => {
        if (/^SET LOCAL lock_timeout = '3000ms'$/.test(sql)) return 0;
        throw new Error("unexpected raw SQL: " + sql);
    },
    $queryRaw: async (strings, ...values) => {
        const sql = strings.join("?");
        if (/FROM "Lecture" WHERE "id" = \? FOR NO KEY UPDATE/.test(sql)) {
            const row = db.lectures[values[0]];
            return row ? [{ id: row.id, classId: row.classId, status: row.status, classStatus: row.classStatus, date: row.date, endDate: row.endDate ?? null }] : [];
        }
        if (/FROM "LectureAttendanceRegister"/.test(sql)) return [];
        throw new Error("unexpected raw SQL: " + sql);
    },
    class: {
        findFirst: async ({ where, select }) => {
            const cls = db.classes[where.id];
            if (!cls || cls.teacherId !== where.teacherId || cls.status !== where.status) return null;
            return select ? Object.fromEntries(Object.keys(select).map(k => [k, cls[k]])) : { ...cls };
        }
    },
    lecture: {
        findFirst: async ({ where, select }) => {
            const row = db.lectures[where.id];
            if (!row || row.status !== where.status) return null;
            if (where.class && db.classes[row.classId].teacherId !== where.class.teacherId) return null;
            return pick(staleRead ? { ...row, ...staleRead } : row, select);
        },
        findUnique: async ({ where, select }) => {
            const row = db.lectures[where.id];
            return row ? pick(row, select) : null;
        },
        findMany: async ({ select }) => Object.values(db.lectures).map(row => pick(row, select)),
        count: async () => Object.keys(db.lectures).length,
        create: async ({ data, select }) => {
            creates.push({ ...data });
            const row = {
                id: `lecture-${creates.length}`, classStatus: "SCHEDULED", status: 0,
                createdAt: utc("2026-11-10T00:00:00.000Z"), endDate: null, ...data
            };
            checkConstraint(row);
            db.lectures[row.id] = row;
            return pick(row, select);
        },
        update: async ({ where, data, select }) => {
            updates.push({ id: where.id, data: { ...data } });
            const next = { ...db.lectures[where.id], ...data };
            checkConstraint(next);
            db.lectures[where.id] = next;
            return pick(next, select);
        }
    }
};

// ---- Faked edges ------------------------------------------------------------------------

function fake(relativePath, exports) {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);
    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
}

let currentTeacher = TEACHER;

fake("lib/prisma.ts", { prisma: fakePrisma });
let emitted = [];
fake("lib/session-events.ts", { emitStudentDataChange: (event) => { emitted.push(event); }, emitLiveChange: () => {} });

// POST /api/lectures is same-origin only (lib/same-origin.ts): the app's origin (test value).
const APP_ORIGIN = "http://localhost";
process.env.APP_URL = APP_ORIGIN;
let sessionCalls = 0;
fake("lib/auth-session.ts", { requireTeacherSession: async () => { sessionCalls += 1; return { teacherId: currentTeacher }; } });
fake("services/fee-waiver-events.ts", {
    readLectureWaiverState: async (lectureId) => {
        const row = db.lectures[lectureId];
        return row ? { classId: row.classId, date: row.date, classStatus: row.classStatus, status: row.status } : null;
    },
    recalculateAfterLectureChange: async (before, after) => {
        waiverCalls.push({ before, after });
    }
});

const schedule = require(path.join(root, "lib", "lecture-schedule.ts"));
const { createLectureSchema, updateLectureSchema } = require(path.join(root, "lib", "lecture-validation.ts"));
const service = require(path.join(root, "services", "lecture-service.ts"));
const lecturesRoute = require(path.join(root, "app", "api", "lectures", "route.ts"));
const lectureRoute = require(path.join(root, "app", "api", "lectures", "[id]", "route.ts"));

function reset() {
    resetDb();
    currentTeacher = TEACHER;
}

const create = (fields) => createLectureSchema.safeParse({ classId: CLASS, title: "Maths", date: "2026-11-10T09:00", ...fields });
const update = (fields) => updateLectureSchema.safeParse(fields);

const firstMessage = (result) => result.error.issues[0].message;
const firstPath = (result) => result.error.issues[0].path.join(".");

async function call(response) {
    const res = await response;
    return { status: res.status, body: await res.json() };
}

// The app's own pages call POST with a same-origin fetch, which sends Origin (and Sec-Fetch-Site).
const SAME_ORIGIN = { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
const post = (body, headers = SAME_ORIGIN) =>
    call(lecturesRoute.POST(new Request("http://localhost/api/lectures", { method: "POST", headers, body: JSON.stringify(body) })));
const put = (id, body) => call(lectureRoute.PUT(new Request(`http://localhost/api/lectures/${id}`, { method: "PUT", body: JSON.stringify(body) }), { params: { id } }));

async function rejectsWith(promise, statusCode, code) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.statusCode, statusCode, error.message);
        assert.equal(error.code, code);
        return true;
    });
}

// ---- The shared rule (lib/lecture-schedule.ts) -----------------------------------------------

test("rule: end after start, at most 12 hours; no end is fine", () => {
    const start = utc("2026-11-10T03:30:00.000Z");
    const plus = (ms) => new Date(start.getTime() + ms);

    assert.equal(schedule.MAX_LECTURE_DURATION_HOURS, 12);
    assert.equal(schedule.lectureEndDateProblem(start, null), null);
    assert.equal(schedule.lectureEndDateProblem(start, undefined), null);
    assert.equal(schedule.lectureEndDateProblem(start, plus(60_000)), null);
    assert.equal(schedule.lectureEndDateProblem(start, plus(12 * 3600_000)), null, "exactly 12 hours is allowed");
    assert.equal(schedule.lectureEndDateProblem(start, plus(12 * 3600_000 + 60_000)), "LECTURE_TOO_LONG");
    assert.equal(schedule.lectureEndDateProblem(start, start), "END_NOT_AFTER_START");
    assert.equal(schedule.lectureEndDateProblem(start, plus(-60_000)), "END_NOT_AFTER_START");
    assert.equal(schedule.lectureEndDateProblem(start, new Date(Number.NaN)), "END_NOT_AFTER_START");
});

// ---- Validation: Sri Lankan time ------------------------------------------------------------

test("validation: endDate uses the same Sri Lankan rule as date (datetime-local = Asia/Colombo)", () => {
    const result = create({ endDate: "2026-11-10T11:30" });

    assert.equal(result.success, true);
    assert.equal(result.data.date.toISOString(), "2026-11-10T03:30:00.000Z");
    assert.equal(result.data.endDate.toISOString(), "2026-11-10T06:00:00.000Z");
});

test("validation: ISO instants with Z / an offset are taken as given", () => {
    const result = create({ date: "2026-11-10T03:30:00.000Z", endDate: "2026-11-10T11:30:00+05:30" });

    assert.equal(result.success, true);
    assert.equal(result.data.endDate.toISOString(), "2026-11-10T06:00:00.000Z");
});

test("validation: an end that crosses Sri Lankan midnight is allowed (within 12 hours)", () => {
    const result = create({ date: "2026-11-10T20:00", endDate: "2026-11-11T01:00" });

    assert.equal(result.success, true);
    assert.equal(result.data.endDate.toISOString(), "2026-11-10T19:30:00.000Z");
});

test("validation: an impossible or malformed end time gets a clear error", () => {
    for (const endDate of ["2026-02-30T10:00", "2026-11-10T25:00", "not a date"]) {
        const result = create({ endDate });
        assert.equal(result.success, false, endDate);
        assert.equal(firstPath(result), "endDate");
        assert.equal(firstMessage(result), "The end time must be a valid date and time.");
    }
});

// ---- Validation: end vs start ----------------------------------------------------------------

test("validation: end after start passes; equal and earlier are rejected on endDate", () => {
    assert.equal(create({ endDate: "2026-11-10T09:01" }).success, true);

    const equal = create({ endDate: "2026-11-10T09:00" });
    assert.equal(equal.success, false);
    assert.equal(firstPath(equal), "endDate");
    assert.equal(firstMessage(equal), "The end time must be after the start time.");

    const before = create({ endDate: "2026-11-10T08:59" });
    assert.equal(before.success, false);
    assert.equal(firstMessage(before), "The end time must be after the start time.");

    const updateBefore = update({ date: "2026-11-10T09:00", endDate: "2026-11-10T08:00" });
    assert.equal(updateBefore.success, false);
    assert.equal(firstPath(updateBefore), "endDate");
});

test("validation: at most 12 hours (exactly 12 passes, 12h01 fails)", () => {
    assert.equal(create({ endDate: "2026-11-10T21:00" }).success, true);

    const tooLong = create({ endDate: "2026-11-10T21:01" });
    assert.equal(tooLong.success, false);
    assert.equal(firstMessage(tooLong), "A lecture can be at most 12 hours long.");

    const updateTooLong = update({ date: "2026-11-10T09:00", endDate: "2026-11-11T09:00" });
    assert.equal(updateTooLong.success, false);
    assert.equal(firstMessage(updateTooLong), "A lecture can be at most 12 hours long.");
});

test("validation: endDate is optional; explicit null is kept as null (clear), never 1970", () => {
    const omitted = create({});
    assert.equal(omitted.success, true);
    assert.equal(omitted.data.endDate, undefined);

    const cleared = update({ endDate: null });
    assert.equal(cleared.success, true, "an endDate-only update is a valid update");
    assert.equal(cleared.data.endDate, null);

    const createNull = create({ endDate: null });
    assert.equal(createNull.success, true);
    assert.equal(createNull.data.endDate, null);
});

test("validation: an empty form field (\"\" or blanks) means no end time, like null", () => {
    for (const endDate of ["", "   "]) {
        const created = create({ endDate });
        assert.equal(created.success, true, JSON.stringify(endDate));
        assert.equal(created.data.endDate, null);

        const updated = update({ endDate });
        assert.equal(updated.success, true);
        assert.equal(updated.data.endDate, null);
    }
});

test("validation: unchanged rules for title / date-only updates and empty updates", () => {
    assert.equal(update({}).success, false);
    assert.equal(update({ title: "New title" }).success, true);
    assert.equal(update({ date: "2026-11-10T10:00" }).success, true, "start-only: checked by the service against the stored end");
    assert.equal(update({ endDate: "2026-11-10T12:00" }).success, true, "end-only: checked by the service against the stored start");
});

// ---- Service: create ----------------------------------------------------------------------------

test("service create: stores endDate and returns it", async () => {
    reset();

    const input = create({ endDate: "2026-11-10T11:30" }).data;
    const lecture = await service.createLectureForTeacher(TEACHER, input);

    assert.equal(lecture.endDate.toISOString(), "2026-11-10T06:00:00.000Z");
    assert.equal(creates[0].endDate.toISOString(), "2026-11-10T06:00:00.000Z");
});

test("service create: without an end time nothing is written for endDate (column stays NULL)", async () => {
    reset();

    const lecture = await service.createLectureForTeacher(TEACHER, create({}).data);

    assert.equal("endDate" in creates[0], false);
    assert.equal(lecture.endDate, null);
});

test("service create: another teacher's class is still refused", async () => {
    reset();

    await rejectsWith(service.createLectureForTeacher(OTHER_TEACHER, create({}).data), 404, "CLASS_NOT_FOUND");
    assert.equal(creates.length, 0);
});

// ---- Service: update --------------------------------------------------------------------------------

test("service update: a start-only change that passes the stored end is refused; the end is NOT cleared", async () => {
    reset();

    // Stored 09:00-11:00; moving the start to 11:30 would put it after the end.
    await rejectsWith(
        service.updateLectureForTeacher(TEACHER, LECTURE, update({ date: "2026-11-10T11:30" }).data),
        400,
        "LECTURE_END_NOT_AFTER_START"
    );

    assert.equal(updates.length, 0, "nothing written");
    assert.equal(db.lectures[LECTURE].endDate.toISOString(), "2026-11-10T05:30:00.000Z");
    assert.equal(db.lectures[LECTURE].date.toISOString(), "2026-11-10T03:30:00.000Z");
});

test("service update: a start-only change that makes the stored end too far away is refused (12 hours)", async () => {
    reset();

    await rejectsWith(
        service.updateLectureForTeacher(TEACHER, LECTURE, update({ date: "2026-11-09T22:00" }).data),
        400,
        "LECTURE_TOO_LONG"
    );
    assert.equal(updates.length, 0);
});

test("service update: the error tells the teacher to change or clear the end time", async () => {
    reset();

    await assert.rejects(
        service.updateLectureForTeacher(TEACHER, LECTURE, update({ date: "2026-11-10T11:30" }).data),
        (error) => /change the end time as well, or clear it/.test(error.message) && error.details.field === "endDate"
    );
});

test("service update: a start-only change that still fits the stored end is saved", async () => {
    reset();

    const lecture = await service.updateLectureForTeacher(TEACHER, LECTURE, update({ date: "2026-11-10T09:30" }).data);

    assert.equal(lecture.date.toISOString(), "2026-11-10T04:00:00.000Z");
    assert.equal(lecture.endDate.toISOString(), "2026-11-10T05:30:00.000Z");
    assert.deepEqual(Object.keys(updates[0].data), ["date"], "the end time is not touched");
});

test("service update: an end-only change is checked against the stored start", async () => {
    reset();

    await rejectsWith(
        service.updateLectureForTeacher(TEACHER, LECTURE, update({ endDate: "2026-11-10T08:00" }).data),
        400,
        "LECTURE_END_NOT_AFTER_START"
    );
    await rejectsWith(
        service.updateLectureForTeacher(TEACHER, LECTURE, update({ endDate: "2026-11-10T22:00" }).data),
        400,
        "LECTURE_TOO_LONG"
    );
    assert.equal(updates.length, 0);

    const lecture = await service.updateLectureForTeacher(TEACHER, LECTURE, update({ endDate: "2026-11-10T12:00" }).data);
    assert.equal(lecture.endDate.toISOString(), "2026-11-10T06:30:00.000Z");
});

test("service update: explicit null clears the end time", async () => {
    reset();

    const lecture = await service.updateLectureForTeacher(TEACHER, LECTURE, update({ endDate: null }).data);

    assert.equal(lecture.endDate, null);
    assert.equal(db.lectures[LECTURE].endDate, null);
    assert.deepEqual(updates[0].data, { endDate: null });
});

test("service update: moving the start past the end together with clearing the end is allowed", async () => {
    reset();

    const lecture = await service.updateLectureForTeacher(
        TEACHER, LECTURE, update({ date: "2026-11-10T13:00", endDate: null }).data
    );

    assert.equal(lecture.date.toISOString(), "2026-11-10T07:30:00.000Z");
    assert.equal(lecture.endDate, null);
});

test("service update: a title-only update never checks or touches the end time", async () => {
    reset();

    const lecture = await service.updateLectureForTeacher(TEACHER, LECTURE, update({ title: "Renamed" }).data);

    assert.equal(lecture.title, "Renamed");
    assert.deepEqual(updates[0].data, { title: "Renamed" });
});

test("service update: a concurrent edit caught by the CHECK constraint becomes a 400, not a 500", async () => {
    reset();

    // The ownership read saw an old start (08:00); the stored row actually
    // starts at 09:00 (another tab saved it). An end of 08:30 passes the
    // service check against the stale start but not the database constraint.
    staleRead = { date: utc("2026-11-10T02:30:00.000Z"), endDate: null };

    await rejectsWith(
        service.updateLectureForTeacher(TEACHER, LECTURE, update({ endDate: "2026-11-10T08:30" }).data),
        400,
        "LECTURE_END_NOT_AFTER_START"
    );
    assert.equal(db.lectures[LECTURE].endDate.toISOString(), "2026-11-10T05:30:00.000Z", "the database row is unchanged");
});

test("service update: another teacher's lecture is still refused before any check", async () => {
    reset();

    await rejectsWith(
        service.updateLectureForTeacher(OTHER_TEACHER, LECTURE, update({ endDate: null }).data),
        404,
        "LECTURE_NOT_FOUND"
    );
    assert.equal(updates.length, 0);
});

// ---- Existing lectures (endDate NULL) ----------------------------------------------------------------

test("existing lecture without an end time: start changes, renames and status changes work as before", async () => {
    reset();

    const moved = await service.updateLectureForTeacher(TEACHER, LEGACY, update({ date: "2026-10-21T09:00" }).data);
    assert.equal(moved.date.toISOString(), "2026-10-21T03:30:00.000Z");
    assert.equal(moved.endDate, null);

    const renamed = await service.updateLectureForTeacher(TEACHER, LEGACY, update({ title: "Optics II" }).data);
    assert.equal(renamed.title, "Optics II");

    const cancelled = await service.updateLectureClassStatusForTeacher(TEACHER, LEGACY, "CANCELLED");
    assert.equal(cancelled.classStatus, "CANCELLED");
    assert.equal(cancelled.endDate, null);

    const listed = await service.listLecturesForTeacher({ teacherId: TEACHER, skip: 0, take: 10 });
    assert.equal(listed.lectures.find(l => l.id === LEGACY).endDate, null);
    assert.equal(listed.lectures.find(l => l.id === LECTURE).endDate.toISOString(), "2026-11-10T05:30:00.000Z");
});

// ---- Fee waivers: unchanged ------------------------------------------------------------------------------

test("fee waivers: date updates recalculate exactly as before; end-only changes pass the stored date", async () => {
    reset();

    await service.updateLectureForTeacher(TEACHER, LEGACY, update({ date: "2026-10-22T09:00" }).data);
    assert.equal(waiverCalls.length, 1);
    assert.equal(waiverCalls[0].before.date.toISOString(), "2026-10-20T03:30:00.000Z");
    assert.equal(waiverCalls[0].after.date.toISOString(), "2026-10-22T03:30:00.000Z");
    assert.equal("endDate" in waiverCalls[0].after, false, "waiver state never includes endDate");

    waiverCalls = [];
    await service.updateLectureForTeacher(TEACHER, LECTURE, update({ endDate: "2026-11-10T12:00" }).data);
    assert.equal(waiverCalls.length, 1);
    assert.equal(waiverCalls[0].before.date.getTime(), waiverCalls[0].after.date.getTime(), "same date: no waiver-relevant change");
});

// ---- API routes ----------------------------------------------------------------------------------------------

test("POST /api/lectures: endDate stored and returned; a bad end time is a 400 with a clear message", async () => {
    reset();

    const ok = await post({ classId: CLASS, title: "Maths", date: "2026-11-10T09:00", endDate: "2026-11-10T10:30" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.lecture.endDate, "2026-11-10T05:00:00.000Z");

    const noEnd = await post({ classId: CLASS, title: "Maths", date: "2026-11-10T09:00", endDate: null });
    assert.equal(noEnd.status, 201);
    assert.equal(noEnd.body.data.lecture.endDate, null);

    const bad = await post({ classId: CLASS, title: "Maths", date: "2026-11-10T09:00", endDate: "2026-11-10T09:00" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "VALIDATION_ERROR");
    assert.equal(bad.body.error.message, "The end time must be after the start time.");
});

test("PUT /api/lectures/[id]: start-only conflict is a 400 LECTURE_END_NOT_AFTER_START; null clears", async () => {
    reset();

    const conflict = await put(LECTURE, { date: "2026-11-10T11:30" });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.body.error.code, "LECTURE_END_NOT_AFTER_START");

    const cleared = await put(LECTURE, { endDate: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.lecture.endDate, null);

    // The edit form sends both values together.
    const both = await put(LECTURE, { title: "Kinematics", date: "2026-11-10T14:00", endDate: "2026-11-10T16:00" });
    assert.equal(both.status, 200);
    assert.equal(both.body.data.lecture.date, "2026-11-10T08:30:00.000Z");
    assert.equal(both.body.data.lecture.endDate, "2026-11-10T10:30:00.000Z");
});

// ---- POST /api/lectures: same-origin (CSRF) ------------------------------------------------------------------

test("POST /api/lectures: same-origin only (403 CROSS_ORIGIN_REQUEST_REJECTED before authentication); nothing created", async () => {
    const body = { classId: CLASS, title: "Maths", date: "2026-11-10T09:00", endDate: "2026-11-10T10:30" };
    const refused = [
        {},
        { Origin: "https://evil.example" },
        { Origin: "null" },
        { Origin: APP_ORIGIN, "Sec-Fetch-Site": "cross-site" },
        { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-site" },
        { "Sec-Fetch-Site": "same-origin" },
    ];
    for (const headers of refused) {
        reset();
        emitted = [];
        sessionCalls = 0;
        const before = Object.keys(db.lectures).length;
        const res = await post(body, headers);
        assert.equal(res.status, 403, JSON.stringify(headers));
        assert.equal(res.body.error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
        assert.equal(Object.keys(db.lectures).length, before, "nothing created");
        assert.equal(creates.length, 0);
        assert.deepEqual(emitted, []);
        assert.equal(sessionCalls, 0, "authentication is never reached");
    }
});

test("POST /api/lectures: the app's own same-origin request still works (with or without Sec-Fetch-Site); GET is unchanged", async () => {
    reset();
    emitted = [];
    const withFetchSite = await post({ classId: CLASS, title: "Maths", date: "2026-11-10T09:00" });
    assert.equal(withFetchSite.status, 201);
    const originOnly = await post({ classId: CLASS, title: "Maths", date: "2026-11-11T09:00" }, { Origin: APP_ORIGIN, "Content-Type": "application/json" });
    assert.equal(originOnly.status, 201, "older browsers without Sec-Fetch-Site");
    assert.equal(creates.length, 2);
    assert.deepEqual(emitted, [{ classId: CLASS }, { classId: CLASS }], "the live update is still emitted after a normal create");

    // GET needs no Origin (a read).
    const list = await call(lecturesRoute.GET(new Request(`http://localhost/api/lectures?classId=${CLASS}`)));
    assert.equal(list.status, 200);
});

test("POST /api/lectures: same-origin is checked before the session (a cross-site request never reaches authentication)", async () => {
    reset();
    sessionCalls = 0;
    const crossSite = await post({ classId: CLASS, title: "Maths", date: "2026-11-10T09:00" }, { Origin: "https://evil.example" });
    assert.equal(crossSite.status, 403);
    assert.equal(sessionCalls, 0);
    const sameOrigin = await post({ classId: CLASS, title: "Maths", date: "2026-11-10T09:00" });
    assert.equal(sameOrigin.status, 201);
    assert.equal(sessionCalls, 1);
});
