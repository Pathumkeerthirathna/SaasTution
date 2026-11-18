/*
 * Regression tests: a student declined (REJECTED) by the teacher, or still
 * PENDING, cannot enter a live class with a session cookie issued earlier,
 * but can still close their own open attendance visit.
 *
 *   npm run test:attendance
 *
 * Session cookies are stateless JWTs (7 days) and are not revoked when the
 * teacher declines a student, so the classroom entry points re-check the
 * student's approval: services/session-service.ts getSessionJoinInfo (both
 * join-info routes, POST /api/attendance, POST /api/sessions/[id]/join) and
 * getActiveSessionForEnrolledStudent (GET /api/sessions/[id]/register).
 * Leaving (POST /api/sessions/[id]/leave) keeps every other check but not the
 * approval one.
 *
 * Runs the real routes and service through tsx. Only the edges are faked:
 * Prisma (in-memory tables that honour every condition of the student
 * lookup: status, confirmationStatus and the active enrolment), the login
 * session, Jitsi tokens, invite tokens and the mailer.
 */

"use strict";

require("../helpers/no-class-access-restrictions.cjs"); // this suite does not model class fees (tests/class-access covers access control)

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

// Jitsi JWT auth on (test-only values, set before the service is loaded), so
// a successful join issues a token and a refused one provably does not.
process.env.JITSI_ENABLE_JWT_AUTH = "true";
process.env.JITSI_JWT_SECRET = "test-only-not-a-secret";

// ---- Fixed IDs ------------------------------------------------------------

const APPROVED = "11111111-1111-4111-8111-111111111111";
const REJECTED = "22222222-2222-4222-8222-222222222222";
const PENDING = "33333333-3333-4333-8333-333333333333";
const DEACTIVATED = "44444444-4444-4444-8444-444444444444";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";
const CLASS = "66666666-6666-4666-8666-666666666666";
const OTHER_CLASS = "77777777-7777-4777-8777-777777777777";
const SESSION = "88888888-8888-4888-8888-888888888888";
const TEACHER = "teacher-1";

// ---- Fake database --------------------------------------------------------

let db;

function resetDb() {
    db = {
        session: {
            id: SESSION, classId: CLASS, lectureId: null, roomName: "room-1", jitsiDomain: "jitsi.example.test",
            isActive: true, startedAt: new Date("2026-11-10T08:00:00.000Z"), endedAt: null, teacherId: TEACHER
        },
        students: {
            [APPROVED]: { id: APPROVED, name: "Nimal", status: 0, confirmationStatus: "APPROVED" },
            [REJECTED]: { id: REJECTED, name: "Kamal", status: 0, confirmationStatus: "REJECTED" },
            [PENDING]: { id: PENDING, name: "Sunil", status: 0, confirmationStatus: "PENDING" },
            [DEACTIVATED]: { id: DEACTIVATED, name: "Amal", status: 1, confirmationStatus: "APPROVED" },
            [OUTSIDER]: { id: OUTSIDER, name: "Bimal", status: 0, confirmationStatus: "APPROVED" }
        },
        // { studentId, classId, isActive }
        enrolments: [
            { studentId: APPROVED, classId: CLASS, isActive: true },
            { studentId: REJECTED, classId: CLASS, isActive: true },
            { studentId: PENDING, classId: CLASS, isActive: true },
            { studentId: DEACTIVATED, classId: CLASS, isActive: true },
            { studentId: OUTSIDER, classId: OTHER_CLASS, isActive: true }
        ],
        attendance: []
    };
}

// Every student lookup the service makes, to check the approval condition is
// really sent to the database (not just honoured by this fake).
let studentQueries = [];

function studentMatches(student, where) {
    if (where.id !== undefined && student.id !== where.id) return false;
    if (where.status !== undefined && student.status !== where.status) return false;
    if (where.confirmationStatus !== undefined && student.confirmationStatus !== where.confirmationStatus) return false;

    if (where.classes?.some) {
        const { classId, isActive } = where.classes.some;
        const enrolled = db.enrolments.some(e =>
            e.studentId === student.id &&
            (classId === undefined || e.classId === classId) &&
            (isActive === undefined || e.isActive === isActive)
        );

        if (!enrolled) return false;
    }

    return true;
}

function pickFields(row, select) {
    if (!select) return { ...row };

    const out = {};

    for (const key of Object.keys(select)) out[key] = row[key];

    return out;
}

function attendanceMatches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => row[key] === value);
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
        findUnique: async ({ where }) => (db.session && where.id === db.session.id ? sessionView() : null)
    },
    student: {
        findFirst: async ({ where, select }) => {
            studentQueries.push(where);

            const student = Object.values(db.students).find(s => studentMatches(s, where));

            return student ? pickFields({ grade: null, contact: "0700000000", ...student }, select) : null;
        }
    },
    classStudent: {
        findMany: async () => db.enrolments
            .filter(e => e.classId === db.session.classId && e.isActive && db.students[e.studentId].status === 0)
            .map(e => ({ student: { id: e.studentId, name: db.students[e.studentId].name } }))
    },
    attendance: {
        create: async ({ data, select }) => {
            const row = { id: randomUUID(), leftAt: null, ...data };

            db.attendance.push(row);

            return pickFields(row, select);
        },
        findMany: async ({ where, select }) =>
            db.attendance.filter(row => attendanceMatches(row, where)).map(row => pickFields(row, select)),
        findFirst: async ({ where, select }) => {
            const rows = db.attendance
                .filter(row => attendanceMatches(row, where))
                .sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime());

            return rows[0] ? pickFields(rows[0], select) : null;
        },
        findUnique: async ({ where, select }) => {
            const row = db.attendance.find(r => r.id === where.id);

            return row ? pickFields(row, select) : null;
        },
        updateMany: async ({ where, data }) => {
            const rows = db.attendance.filter(row => {
                const { id, ...rest } = where;

                if (id && typeof id === "object" && "in" in id) {
                    if (!id.in.includes(row.id)) return false;
                } else if (id !== undefined && row.id !== id) {
                    return false;
                }

                return attendanceMatches(row, rest);
            });

            rows.forEach(row => Object.assign(row, data));

            return { count: rows.length };
        }
    },
    $transaction: async fn => fn(fakePrisma)
};

// ---- Fake login session, Jitsi tokens, invites ----------------------------

let current = { role: "STUDENT", id: APPROVED };
let jitsiTokensIssued = 0;

function fake(relativePath, exports) {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);

    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
}

const { AppError } = require(path.join(root, "lib/error-handler.ts"));

fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/auth-session.ts", {
    requireStudentSession: async () => {
        if (current.role !== "STUDENT") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");

        return { studentId: current.id, email: "s@example.com", name: "S", role: "STUDENT" };
    },
    requireTeacherSession: async () => {
        if (current.role !== "TEACHER") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");

        return { teacherId: current.id };
    }
});
fake("lib/jitsi-auth.ts", {
    generateJitsiToken: async () => {
        jitsiTokensIssued += 1;

        return "jitsi-token";
    }
});
fake("lib/mailer.ts", { buildLiveSessionInviteLoginLink: () => "", sendLiveSessionInviteEmail: async () => {} });
// Invite tokens: "invite:<studentId>:<sessionId>:<classId>".
fake("lib/session-invite.ts", {
    signSessionInviteToken: () => "",
    verifySessionInviteToken: async token => {
        const [kind, studentId, sessionId, classId] = String(token).split(":");

        return kind === "invite" ? { studentId, sessionId, classId } : null;
    }
});

const service = require(path.join(root, "services/session-service.ts"));
const joinInfoRoute = require(path.join(root, "app/api/sessions/[id]/join-info/route.ts"));
const inviteJoinInfoRoute = require(path.join(root, "app/api/sessions/join-info/route.ts"));
const attendanceRoute = require(path.join(root, "app/api/attendance/route.ts"));
const joinRoute = require(path.join(root, "app/api/sessions/[id]/join/route.ts"));
const leaveRoute = require(path.join(root, "app/api/sessions/[id]/leave/route.ts"));
const registerRoute = require(path.join(root, "app/api/sessions/[id]/register/route.ts"));

// ---- Helpers --------------------------------------------------------------

function reset() {
    resetDb();
    studentQueries = [];
    jitsiTokensIssued = 0;
    current = { role: "STUDENT", id: APPROVED };
}

const as = (id) => { current = { role: "STUDENT", id }; };

async function call(response) {
    const res = await response;

    return { status: res.status, body: await res.json() };
}

const getJoinInfo = (sessionId = SESSION, query = "") =>
    call(joinInfoRoute.GET(new Request(`http://localhost/api/sessions/${sessionId}/join-info${query}`), { params: { id: sessionId } }));

const getInviteJoinInfo = (invite) =>
    call(inviteJoinInfoRoute.GET(new Request(`http://localhost/api/sessions/join-info?invite=${encodeURIComponent(invite)}`)));

const postAttendance = (studentId = current.id) =>
    call(attendanceRoute.POST(new Request("http://localhost/api/attendance", {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION, classId: CLASS, studentId })
    })));

const postJoin = (studentId = current.id) =>
    call(joinRoute.POST(new Request(`http://localhost/api/sessions/${SESSION}/join`, {
        method: "POST",
        body: JSON.stringify({ studentId })
    }), { params: { id: SESSION } }));

const postLeave = (body) =>
    call(leaveRoute.POST(new Request(`http://localhost/api/sessions/${SESSION}/leave`, {
        method: "POST",
        body: JSON.stringify({ studentId: current.id, ...body })
    }), { params: { id: SESSION } }));

const getRegister = (sessionId = SESSION) =>
    call(registerRoute.GET(new Request(`http://localhost/api/sessions/${sessionId}/register`), { params: { id: sessionId } }));

const visitsOf = (studentId) => db.attendance.filter(row => row.studentId === studentId);

function assertRefused(result, status = 403, code = "STUDENT_NOT_IN_CLASS") {
    assert.equal(result.status, status);
    assert.equal(result.body.success, false);
    assert.equal(result.body.error.code, code);
}

// ---- 1. Approved students keep joining ------------------------------------

test("APPROVED student: both join-info routes return the classroom and a Jitsi token", async () => {
    reset();
    as(APPROVED);

    const direct = await getJoinInfo();
    assert.equal(direct.status, 200);
    assert.equal(direct.body.data.session.id, SESSION);
    assert.equal(direct.body.data.student.id, APPROVED);
    assert.equal(direct.body.data.token, "jitsi-token");

    const viaInvite = await getInviteJoinInfo(`invite:${APPROVED}:${SESSION}:${CLASS}`);
    assert.equal(viaInvite.status, 200);
    assert.equal(viaInvite.body.data.student.id, APPROVED);

    assert.equal(jitsiTokensIssued, 2);
});

test("APPROVED student: POST /api/attendance and POST /join record visits", async () => {
    reset();
    as(APPROVED);

    const first = await postAttendance();
    assert.equal(first.status, 200);
    assert.equal(first.body.data.attendance.studentId, APPROVED);

    const second = await postJoin();
    assert.equal(second.status, 200);

    assert.equal(visitsOf(APPROVED).length, 2);
});

test("the join lookup asks the database for APPROVED students only", async () => {
    reset();
    as(APPROVED);

    await getJoinInfo();

    assert.equal(studentQueries.length, 1);
    assert.equal(studentQueries[0].confirmationStatus, "APPROVED");
    assert.equal(studentQueries[0].status, 0);
    assert.deepEqual(studentQueries[0].classes, { some: { classId: CLASS, isActive: true } });
});

// ---- 2. / 3. REJECTED and PENDING students are refused ---------------------

for (const [label, id] of [["REJECTED", REJECTED], ["PENDING", PENDING]]) {
    test(`${label} student with a still-valid session cookie: no join info, no Jitsi token`, async () => {
        reset();
        as(id);

        assertRefused(await getJoinInfo());
        assertRefused(await getInviteJoinInfo(`invite:${id}:${SESSION}:${CLASS}`));

        assert.equal(jitsiTokensIssued, 0);
    });

    test(`${label} student: POST /api/attendance and POST /join record no visit`, async () => {
        reset();
        as(id);

        assertRefused(await postAttendance());
        assertRefused(await postJoin());

        assert.equal(visitsOf(id).length, 0);
    });
}

test("declined mid-class: the next join is refused (the cookie alone is not enough)", async () => {
    reset();
    as(APPROVED);

    assert.equal((await postAttendance()).status, 200);

    db.students[APPROVED].confirmationStatus = "REJECTED"; // teacher declines

    assertRefused(await getJoinInfo());
    assertRefused(await postAttendance());
    assert.equal(visitsOf(APPROVED).length, 1);
});

// ---- 4. Deactivated students stay blocked ----------------------------------

test("deactivated (status 1) student stays blocked even though APPROVED", async () => {
    reset();
    as(DEACTIVATED);

    assertRefused(await getJoinInfo());
    assertRefused(await postAttendance());
    assertRefused(await getRegister());
    assert.equal(jitsiTokensIssued, 0);
    assert.equal(visitsOf(DEACTIVATED).length, 0);
});

// ---- 5. / 6. Leaving ----------------------------------------------------------

test("a student declined while in class can still close their own open visit", async () => {
    reset();
    as(APPROVED);

    const joined = await postAttendance();
    const attendanceId = joined.body.data.attendance.id;

    db.students[APPROVED].confirmationStatus = "REJECTED"; // teacher declines mid-class
    jitsiTokensIssued = 0; // the join above issued one

    const left = await postLeave({ attendanceId });

    assert.equal(left.status, 200);
    assert.equal(left.body.data.updated, true);
    assert.equal(left.body.data.classId, CLASS);
    assert.equal(left.body.data.attendance.id, attendanceId);
    assert.ok(visitsOf(APPROVED)[0].leftAt instanceof Date);

    // Leaving never issues a Jitsi token, and the lookup skipped only approval.
    assert.equal(jitsiTokensIssued, 0);
    const leaveQuery = studentQueries[studentQueries.length - 1];
    assert.equal(leaveQuery.confirmationStatus, undefined);
    assert.equal(leaveQuery.status, 0);
    assert.deepEqual(leaveQuery.classes, { some: { classId: CLASS, isActive: true } });
});

test("a declined student without attendanceId (older client) closes their newest open visit", async () => {
    reset();
    as(APPROVED);

    await postAttendance();
    db.students[APPROVED].confirmationStatus = "REJECTED";

    const left = await postLeave({});

    assert.equal(left.status, 200);
    assert.equal(left.body.data.updated, true);
    assert.ok(visitsOf(APPROVED)[0].leftAt instanceof Date);
});

test("APPROVED student leaves normally; a second leave changes nothing", async () => {
    reset();
    as(APPROVED);

    const joined = await postAttendance();
    const attendanceId = joined.body.data.attendance.id;

    const left = await postLeave({ attendanceId });
    assert.equal(left.status, 200);
    assert.equal(left.body.data.updated, true);
    const leftAt = visitsOf(APPROVED)[0].leftAt;
    assert.ok(leftAt instanceof Date);

    const again = await postLeave({ attendanceId });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.updated, false);
    assert.equal(visitsOf(APPROVED)[0].leftAt, leftAt);
});

// ---- 7. Active-session lookup (class register) -------------------------------

test("class register: APPROVED student sees it, REJECTED and PENDING are refused", async () => {
    reset();

    as(APPROVED);
    const ok = await getRegister();
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.classId, CLASS);

    as(REJECTED);
    assertRefused(await getRegister());

    as(PENDING);
    assertRefused(await getRegister());

    // The register's lookup also sends the approval condition.
    assert.ok(studentQueries.every(where => where.confirmationStatus === "APPROVED"));
});

// ---- 8. Existing authorization and ownership checks ---------------------------

test("leave never closes another student's visit, even with its attendanceId", async () => {
    reset();
    as(APPROVED);
    const joined = await postAttendance();
    const othersVisit = joined.body.data.attendance.id;

    // Make the approved student's classmate a declined student with a cookie.
    as(REJECTED);
    const left = await postLeave({ attendanceId: othersVisit });

    assert.equal(left.status, 200);
    assert.equal(left.body.data.updated, false);
    assert.equal(visitsOf(APPROVED)[0].leftAt, null);
});

test("leave still requires an active, enrolled student in this class", async () => {
    reset();

    // Deactivated: refused, as before this change.
    as(DEACTIVATED);
    assertRefused(await postLeave({}));

    // Enrolled in another class only.
    as(OUTSIDER);
    assertRefused(await postLeave({}));

    // Removed from the class after joining (declined as well): refused.
    as(REJECTED);
    db.enrolments.find(e => e.studentId === REJECTED).isActive = false;
    assertRefused(await postLeave({}));
});

test("leave of an ended session is refused (open visits are closed by End Session)", async () => {
    reset();
    as(APPROVED);
    await postAttendance();

    db.session.isActive = false;

    assertRefused(await postLeave({}), 404, "SESSION_NOT_ACTIVE");
});

test("join-info: a student of another class and a mismatching studentId are refused", async () => {
    reset();

    as(OUTSIDER);
    assertRefused(await getJoinInfo());

    as(APPROVED);
    assertRefused(await getJoinInfo(SESSION, `?studentId=${REJECTED}`), 403, "FORBIDDEN");

    // An invite issued to another student.
    assertRefused(await getInviteJoinInfo(`invite:${REJECTED}:${SESSION}:${CLASS}`), 403, "INVITE_STUDENT_MISMATCH");

    assert.equal(jitsiTokensIssued, 0);
});

test("join-info: unknown or ended sessions are refused before any student check", async () => {
    reset();
    as(APPROVED);

    assertRefused(await getJoinInfo("99999999-9999-4999-8999-999999999999"), 404, "SESSION_NOT_ACTIVE");

    db.session.isActive = false;
    assertRefused(await getJoinInfo(), 404, "SESSION_NOT_ACTIVE");
    assert.equal(studentQueries.length, 0);
});

test("POST /api/attendance: a classId that is not the session's class is refused", async () => {
    reset();
    as(APPROVED);

    const result = await call(attendanceRoute.POST(new Request("http://localhost/api/attendance", {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION, classId: OTHER_CLASS, studentId: APPROVED })
    })));

    assertRefused(result, 400, "CLASS_SESSION_MISMATCH");
    assert.equal(visitsOf(APPROVED).length, 0);
});

test("routes still require a student login (a teacher session gets 401)", async () => {
    reset();
    current = { role: "TEACHER", id: TEACHER };

    assertRefused(await postAttendance(APPROVED), 401, "UNAUTHORIZED");
    assertRefused(await postLeave({ studentId: APPROVED }), 401, "UNAUTHORIZED");
    assertRefused(await getRegister(), 401, "UNAUTHORIZED");
    assert.equal(db.attendance.length, 0);
});

test("getSessionJoinInfo (service) refuses a REJECTED student directly", async () => {
    reset();

    await assert.rejects(
        service.getSessionJoinInfo(SESSION, { studentId: REJECTED, email: "", name: "", role: "STUDENT" }),
        (error) => error.statusCode === 403 && error.code === "STUDENT_NOT_IN_CLASS"
    );
});
