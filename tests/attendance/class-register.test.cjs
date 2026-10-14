/*
 * Regression tests: the student-side Class Register.
 *
 *   npm run test:attendance
 *
 * Runs the real code through tsx: GET /api/sessions/[id]/register and its
 * service in services/session-service.ts, the teacher's POST
 * /api/classes/[id]/notify-absent, and the shared present / absent split
 * (components/Jitsi/class-register.mjs). Only the edges are faked: Prisma
 * (in-memory tables), the login session and the mailer.
 *
 * The student register is read-only: it has no Notify, and students have no
 * notify endpoint of their own (checked below).
 *
 * Not covered here (needs a real browser + Jitsi): the panel's rendering,
 * the live participant list Jitsi reports, and actual email delivery.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

// ---- Fixed IDs ------------------------------------------------------------

const ME = "11111111-1111-4111-8111-111111111111";
const AMAL = "22222222-2222-4222-8222-222222222222";
const BIMAL = "33333333-3333-4333-8333-333333333333";
const OUTSIDER = "44444444-4444-4444-8444-444444444444";
const CLASS = "55555555-5555-4555-8555-555555555555";
const TEACHER = "teacher-1";
const OTHER_CLASS = "66666666-6666-4666-8666-666666666666";
const SESSION = "77777777-7777-4777-8777-777777777777";
const OTHER_SESSION = "88888888-8888-4888-8888-888888888888";

const students = {
    [ME]: { id: ME, name: "Nimal", email: "nimal@example.com" },
    [AMAL]: { id: AMAL, name: "Amal", email: "amal@example.com" },
    [BIMAL]: { id: BIMAL, name: "Bimal", email: "bimal@example.com" },
    [OUTSIDER]: { id: OUTSIDER, name: "Outsider", email: "outsider@example.com" }
};

// ---- Fake database --------------------------------------------------------

let db;

function resetDb() {
    db = {
        sessions: {
            [SESSION]: { id: SESSION, classId: CLASS, isActive: true, lecture: { title: "Kinematics" }, class: { id: CLASS, name: "Physics" } },
            [OTHER_SESSION]: { id: OTHER_SESSION, classId: OTHER_CLASS, isActive: true, lecture: null, class: { id: OTHER_CLASS, name: "Chemistry" } }
        },
        // classId -> enrolled student IDs (in assignment order)
        enrolment: {
            [CLASS]: [ME, AMAL, BIMAL],
            [OTHER_CLASS]: [OUTSIDER]
        },
        // { classSessionId, studentId, leftAt }
        attendance: []
    };
}

// Only what the student services select: never more fields than asked for.
function selectStudent(id, select) {
    const out = {};

    Object.keys(select).forEach(key => { out[key] = students[id][key]; });

    return out;
}

const queries = [];

const fakePrisma = {
    class: {
        // The teacher's own class only (services/student-service.ts ownership check).
        findFirst: async ({ where }) => (where.id === CLASS && where.teacherId === TEACHER ? { id: CLASS, name: "Physics" } : null)
    },
    classSession: {
        findUnique: async ({ where }) => {
            const session = db.sessions[where.id];

            return session ? { ...session } : null;
        }
    },
    student: {
        findFirst: async ({ where, select }) => {
            const classId = where.classes.some.classId;

            return (db.enrolment[classId] || []).includes(where.id) ? selectStudent(where.id, select) : null;
        }
    },
    classStudent: {
        findMany: async ({ where, select }) => {
            queries.push({ table: "classStudent", where, select });

            return (db.enrolment[where.classId] || []).map(id => ({ student: selectStudent(id, select.student.select) }));
        }
    },
    attendance: {
        findMany: async ({ where }) => db.attendance
            .filter(row => row.classSessionId === where.classSessionId && (where.leftAt !== null || row.leftAt === null))
            .map(row => ({ studentId: row.studentId }))
    }
};

// ---- Fake login session and mailer ----------------------------------------

let current = { role: "STUDENT", id: ME };
let sent = [];

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
        if (current.role !== "STUDENT") {
            throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
        }

        return { studentId: current.id, email: "x@example.com", name: "x", role: "STUDENT" };
    },
    requireTeacherSession: async () => {
        if (current.role !== "TEACHER") {
            throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
        }

        return { teacherId: current.id };
    }
});
fake("lib/jitsi-auth.ts", { generateJitsiToken: async () => "token" });
fake("lib/session-invite.ts", { signSessionInviteToken: () => "" });
fake("lib/mailer.ts", {
    buildLiveSessionInviteLoginLink: () => "",
    sendLiveSessionInviteEmail: async () => {},
    sendEmailConfirmationCode: async () => {},
    sendClassStartedNotifications: async (recipients, message) => {
        sent.push({ recipients, message });
        return [];
    }
});

const registerRoute = require(path.join(root, "app/api/sessions/[id]/register/route.ts"));
const teacherNotifyRoute = require(path.join(root, "app/api/classes/[id]/notify-absent/route.ts"));

// ---- Helpers --------------------------------------------------------------

test.beforeEach(() => {
    resetDb();
    current = { role: "STUDENT", id: ME };
    sent = [];
    queries.length = 0;
});

async function getRegister(sessionId = SESSION) {
    const response = await registerRoute.GET(new Request(`http://localhost/api/sessions/${sessionId}/register`), { params: { id: sessionId } });

    return { status: response.status, body: await response.json() };
}

// ---- Register --------------------------------------------------------------

test("register: an enrolled student gets the class roster, names only", async () => {
    const { status, body } = await getRegister();

    assert.equal(status, 200);
    assert.equal(body.data.className, "Physics");
    assert.equal(body.data.lectureTitle, "Kinematics");
    assert.deepEqual(body.data.students, [
        { studentId: ME, displayName: "Nimal" },
        { studentId: AMAL, displayName: "Amal" },
        { studentId: BIMAL, displayName: "Bimal" }
    ]);
    assert.ok(!JSON.stringify(body).includes("@example.com"), "no emails in the response");
    assert.deepEqual(Object.keys(queries[0].select.student.select).sort(), ["id", "name"], "emails never even read");
});

test("register: another class's session is refused (403)", async () => {
    const { status, body } = await getRegister(OTHER_SESSION);

    assert.equal(status, 403);
    assert.equal(body.error.code, "STUDENT_NOT_IN_CLASS");
    assert.equal(queries.length, 0, "no roster read");
});

test("register: an ended or unknown session is refused (404)", async () => {
    db.sessions[SESSION].isActive = false;
    assert.equal((await getRegister()).status, 404);
    assert.equal((await getRegister("99999999-9999-4999-8999-999999999999")).status, 404);
});

test("register: not a student (e.g. a teacher login) is refused (401)", async () => {
    current = { role: "TEACHER", id: "teacher-1" };
    assert.equal((await getRegister()).status, 401);
});

// ---- Present / absent split (shared by both registers) ---------------------

test("split: present / absent lists, counts and live updates", async () => {
    const { splitClassRegister } = await import(pathToFileURL(path.join(root, "components/Jitsi/class-register.mjs")).href);
    const roster = [
        { studentId: ME, displayName: "Nimal" },
        { studentId: AMAL, displayName: "Amal" },
        { studentId: BIMAL, displayName: "Bimal" }
    ];

    let register = splitClassRegister(roster, [{ displayName: "Nimal" }, { displayName: "Teacher (Teacher)" }]);

    assert.deepEqual(register.present.map(s => s.displayName), ["Nimal"]);
    assert.deepEqual(register.absent.map(s => s.displayName), ["Amal", "Bimal"]);

    // Amal joins; Bimal is in a breakout room (still in the class).
    register = splitClassRegister(roster, [{ displayName: "Nimal" }, { displayName: "Amal" }], { Bimal: "Room 1" });

    assert.equal(register.present.length, 3);
    assert.equal(register.absent.length, 0);
    assert.equal(register.elsewhereLabel("Bimal"), "Room 1");
    assert.equal(register.elsewhereLabel("Amal"), undefined, "here, not elsewhere");

    // Empty / missing inputs.
    const empty = splitClassRegister(undefined, undefined);

    assert.deepEqual([empty.present, empty.absent], [[], []]);
});

// ---- Student read-only UI, teacher side unchanged (source checks) ----------

const source = file => fs.readFileSync(path.join(root, file), "utf8");

test("student register UI is read-only: no Notify, mute, camera or attendance controls", () => {
    // Code only: the comments may say what the register does NOT do.
    const ui = source("components/Jitsi/classroom/sidebar/StudentClassRegister.tsx")
        .replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/[^\n]*/g, "");

    assert.ok(!/Notify|notify|\bBell\b/.test(ui), "no Notify button or dialog");
    assert.ok(!/onMute|muteEveryone|setParticipantAudioMuted|MicOff|CameraOff/.test(ui), "no mute / camera controls");
    assert.ok(!/<button|fetch\(|onClick/.test(ui), "no actions at all");
    assert.ok(ui.includes("Present") && ui.includes("Absent"), "present / absent sections kept");
});

test("students have no notify endpoint of their own (removed, no callers left)", () => {
    assert.ok(!fs.existsSync(path.join(root, "app/api/sessions/[id]/notify-absent")), "route removed");
    assert.ok(!fs.existsSync(path.join(root, "lib/classmate-notify-throttle.ts")), "its rate limiter removed");
    assert.ok(!source("services/session-service.ts").includes("notifyAbsentClassmatesForStudent"), "its service removed");
});

// ---- Teacher Notify (unchanged) ----------------------------------------------

async function teacherNotify(studentIds) {
    const response = await teacherNotifyRoute.POST(
        new Request(`http://localhost/api/classes/${CLASS}/notify-absent`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentIds, message: "Class has started." })
        }),
        { params: { id: CLASS } }
    );

    return { status: response.status, body: await response.json() };
}

test("teacher Notify still works: the class teacher queues emails to the selected students", async () => {
    current = { role: "TEACHER", id: TEACHER };

    const { status, body } = await teacherNotify([AMAL, BIMAL]);

    assert.equal(status, 200);
    assert.equal(body.queued, 2);
    assert.deepEqual(sent[0].recipients.map(r => r.email).sort(), ["amal@example.com", "bimal@example.com"]);
    assert.equal(sent[0].message, "Class has started.");
});

test("a student cannot trigger the teacher's Notify: refused, nothing sent", async () => {
    current = { role: "STUDENT", id: ME };

    const { status, body } = await teacherNotify([AMAL, BIMAL]);

    assert.ok(status >= 400, "refused (" + status + ")");
    assert.equal(body.success, false);
    assert.equal(sent.length, 0);
});

test("the classroom passes mute controls to teachers only", () => {
    const page = source("components/Jitsi/JitsiClassroom.tsx");

    assert.match(page, /onMuteEveryone=\{\s*role === "teacher"/);
    assert.match(page, /onMuteParticipant=\{\s*role === "teacher"/);
});

test("teacher register and routes unchanged: teacher-only, own endpoints", () => {
    const panel = source("components/Jitsi/classroom/sidebar/ParticipantsPanel.tsx");

    assert.ok(panel.includes("Mute all"), "teacher Mute all kept");
    assert.ok(panel.includes("Notify Absent Students") && panel.includes("Send Emails"), "teacher Notify dialog kept");
    assert.ok(panel.includes("/api/classes/${classId}/notify-absent"), "teacher notify endpoint kept");
    assert.ok(panel.includes("onMuteParticipant(participant.participantId, !audioMuted)"), "teacher per-student mute kept");

    for (const file of ["app/api/classes/[id]/notify-absent/route.ts", "app/api/classes/[id]/ClassParticipants/route.ts"]) {
        assert.ok(source(file).includes("requireTeacherSession"), file + " still teacher-only");
    }
});

test("teacher register: the shared split gives exactly the original result", async () => {
    const { splitClassRegister } = await import(pathToFileURL(path.join(root, "components/Jitsi/class-register.mjs")).href);

    // The teacher panel's original code (before the shared helper), verbatim logic.
    function originalSplit(ClassroomStudents, participants, breakoutRoomLabels) {
        const elsewhereLabel = displayName =>
            participants.some(participant => participant.displayName === displayName)
                ? undefined
                : breakoutRoomLabels?.[displayName];
        const presentStudents = ClassroomStudents.filter(student =>
            participants.some(participant => participant.displayName === student.displayName)
            || Boolean(elsewhereLabel(student.displayName)));
        const absentStudents = ClassroomStudents.filter(student =>
            !participants.some(participant => participant.displayName === student.displayName)
            && !elsewhereLabel(student.displayName));

        return { presentStudents, absentStudents, elsewhereLabel };
    }

    const names = ["Amal", "Bimal", "Chamal", "Dimal", "Teacher (Teacher)", "Amal"];
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let round = 0; round < 300; round++) {
        const roster = names.filter(() => random() < 0.7).map((displayName, i) => ({ studentId: "s" + i, displayName }));
        const live = names.filter(() => random() < 0.5).map(displayName => ({ displayName }));
        const labels = {};

        names.forEach(name => {
            if (random() < 0.3) labels[name] = random() < 0.2 ? "" : "Room " + Math.floor(random() * 3);
        });

        const expected = originalSplit(roster, live, labels);
        const actual = splitClassRegister(roster, live, labels);

        assert.deepEqual(actual.present, expected.presentStudents);
        assert.deepEqual(actual.absent, expected.absentStudents);
        names.forEach(name => assert.equal(Boolean(actual.elsewhereLabel(name)), Boolean(expected.elsewhereLabel(name))));
    }
});
