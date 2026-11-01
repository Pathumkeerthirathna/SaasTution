/*
 * The classroom participant map: POST/PATCH/GET /api/sessions/[id]/participant-map,
 * the student's registration safeguards (components/Jitsi/participant-registration.ts)
 * and its display name reports (components/Jitsi/participant-display-name.ts).
 *
 *   npm run test:attendance
 *
 * Runs the real route and the real in-memory map through tsx. Only the edges
 * are faked: Prisma (in-memory tables) and the login session. The registration
 * client runs against a fake fetch and fake timers.
 *
 * Not covered here (needs a real browser + Jitsi): EventSource reconnects in a
 * browser, and the IDs Jitsi actually assigns.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

// ---- Fixed IDs ------------------------------------------------------------

const ME = "11111111-1111-4111-8111-111111111111";
const AMAL = "22222222-2222-4222-8222-222222222222";
const OUTSIDER = "44444444-4444-4444-8444-444444444444";
const CLASS = "55555555-5555-4555-8555-555555555555";
const OTHER_CLASS = "66666666-6666-4666-8666-666666666666";
const TEACHER = "teacher-1";
const OTHER_TEACHER = "teacher-2";

let sessionCounter = 0;
let SESSION;
let OTHER_SESSION;
let db;

function resetDb() {
    // A fresh session ID per test: the participant map is process-wide memory.
    sessionCounter += 1;
    SESSION = `77777777-7777-4777-8777-${String(sessionCounter).padStart(12, "0")}`;
    OTHER_SESSION = `88888888-8888-4888-8888-${String(sessionCounter).padStart(12, "0")}`;
    db = {
        sessions: {
            [SESSION]: { id: SESSION, classId: CLASS, isActive: true, class: { teacherId: TEACHER } },
            [OTHER_SESSION]: { id: OTHER_SESSION, classId: OTHER_CLASS, isActive: true, class: { teacherId: OTHER_TEACHER } }
        },
        enrolment: { [CLASS]: [ME, AMAL], [OTHER_CLASS]: [OUTSIDER] }
    };
}

const fakePrisma = {
    classSession: {
        findUnique: async ({ where, select }) => {
            const session = db.sessions[where.id];

            if (!session) return null;

            const out = {};

            Object.keys(select).forEach(key => { out[key] = session[key]; });

            return out;
        }
    },
    student: {
        findFirst: async ({ where }) => {
            const classId = where.classes.some.classId;

            return where.status === 0 && where.classes.some.isActive === true && (db.enrolment[classId] || []).includes(where.id)
                ? { id: where.id }
                : null;
        }
    }
};

// ---- Fake login session ------------------------------------------------------

let current = { role: "STUDENT", id: ME };

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
    requireAppSession: async () => {
        if (!current) {
            throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
        }

        return { userId: current.id, email: "x@example.com", name: "x", role: current.role };
    },
    requireStudentSession: async () => {
        if (!current || current.role !== "STUDENT") {
            throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
        }

        return { studentId: current.id, email: "x@example.com", name: "x", role: "STUDENT" };
    }
});

const route = require(path.join(root, "app/api/sessions/[id]/participant-map/route.ts"));
const { createParticipantRegistration } = require(path.join(root, "components/Jitsi/participant-registration.ts"));
const { createDisplayNameReporter, createDisplayNameChanger } = require(path.join(root, "components/Jitsi/participant-display-name.ts"));

// The student's join info (registered name): the session service is faked;
// the route's own rule (the student comes from the login) runs for real.
const joinInfoCalls = [];

fake("services/session-service.ts", {
    ensureSessionAccessForTeacher: async () => {},
    getSessionJoinInfoForTeacher: async () => ({}),
    getSessionJoinInfo: async (sessionId, studentSession) => {
        joinInfoCalls.push({ sessionId, studentId: studentSession.studentId });

        return { student: { id: studentSession.studentId, name: "Registered " + studentSession.studentId, grade: null } };
    }
});

const joinInfoRoute = require(path.join(root, "app/api/sessions/[id]/join-info/route.ts"));
const participantMapStore = require(path.join(root, "lib/classroom-participant-map.ts"));

test.beforeEach(() => {
    resetDb();
    current = { role: "STUDENT", id: ME };
});

// ---- Helpers --------------------------------------------------------------

async function post(participantId, sessionId = SESSION) {
    const response = await route.POST(
        new Request(`http://localhost/api/sessions/${sessionId}/participant-map`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ participantId })
        }),
        { params: { id: sessionId } }
    );

    return { status: response.status, body: await response.json() };
}

async function patchName(participantId, displayName, sessionId = SESSION) {
    const response = await route.PATCH(
        new Request(`http://localhost/api/sessions/${sessionId}/participant-map`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ participantId, displayName })
        }),
        { params: { id: sessionId } }
    );

    return { status: response.status, body: await response.json() };
}

// Opens the SSE stream, reads the first event (the snapshot sent on connect),
// then closes it (abort clears the keep-alive timer).
async function getSnapshot(sessionId = SESSION) {
    const abort = new AbortController();
    const response = await route.GET(
        new Request(`http://localhost/api/sessions/${sessionId}/participant-map`, { signal: abort.signal }),
        { params: { id: sessionId } }
    );

    if (!(response.headers.get("Content-Type") || "").startsWith("text/event-stream")) {
        return { status: response.status, body: await response.json() };
    }

    const reader = response.body.getReader();
    const { value } = await reader.read();

    abort.abort();
    await reader.cancel().catch(() => {});

    const text = new TextDecoder().decode(value);
    const data = /^data: (.*)$/m.exec(text)[1];

    return { status: response.status, event: /^event: (.*)$/m.exec(text)[1], snapshot: JSON.parse(data) };
}

// ---- POST (student registration) ---------------------------------------------

test("POST: an enrolled student registers their own participant ID", async () => {
    const { status, body } = await post("d92a7329");

    assert.equal(status, 200);
    assert.equal(body.data.registered, true);

    current = { role: "TEACHER", id: TEACHER };
    assert.deepEqual((await getSnapshot()).snapshot.participants, { [ME]: "d92a7329" });
});

test("POST: an ended session is refused (404) and nothing is registered", async () => {
    db.sessions[SESSION].isActive = false;

    const { status, body } = await post("d92a7329");

    assert.equal(status, 404);
    assert.equal(body.error.code, "SESSION_NOT_ACTIVE");

    db.sessions[SESSION].isActive = true;
    current = { role: "TEACHER", id: TEACHER };
    assert.deepEqual((await getSnapshot()).snapshot.participants, {});
});

test("POST: another class's session (403), a teacher login (401), a bad ID (400)", async () => {
    assert.equal((await post("d92a7329", OTHER_SESSION)).status, 403);

    current = { role: "TEACHER", id: TEACHER };
    assert.equal((await post("d92a7329")).status, 401);

    current = { role: "STUDENT", id: ME };
    assert.equal((await post("bad/id")).status, 400);
    assert.equal((await post("")).status, 400);
});

test("POST: an ID held by another student is a conflict (409); the newest own ID replaces the older", async () => {
    current = { role: "STUDENT", id: AMAL };
    assert.equal((await post("amal0001")).status, 200);

    current = { role: "STUDENT", id: ME };
    assert.equal((await post("amal0001")).status, 409);
    assert.equal((await post("me000001")).status, 200);
    assert.equal((await post("me000002")).status, 200);

    current = { role: "TEACHER", id: TEACHER };
    assert.deepEqual((await getSnapshot()).snapshot.participants, { [AMAL]: "amal0001", [ME]: "me000002" });
});

// ---- GET (SSE) authorization ---------------------------------------------------

test("GET: the class teacher gets the map stream", async () => {
    current = { role: "TEACHER", id: TEACHER };

    const result = await getSnapshot();

    assert.equal(result.status, 200);
    assert.equal(result.event, "participant-map");
    assert.equal(result.snapshot.sessionId, SESSION);
});

test("GET: another teacher is refused (404)", async () => {
    current = { role: "TEACHER", id: OTHER_TEACHER };
    assert.equal((await getSnapshot()).status, 404);
});

test("GET: an enrolled student of an active session gets the same read-only map", async () => {
    current = { role: "STUDENT", id: AMAL };
    await post("amal0001");

    current = { role: "STUDENT", id: ME };

    const result = await getSnapshot();

    assert.equal(result.status, 200);
    assert.deepEqual(result.snapshot.participants, { [AMAL]: "amal0001" });
});

test("GET: a student of another class (403), an ended session (404), an unknown session (404)", async () => {
    current = { role: "STUDENT", id: OUTSIDER };
    assert.equal((await getSnapshot()).status, 403);

    current = { role: "STUDENT", id: ME };
    db.sessions[SESSION].isActive = false;
    assert.equal((await getSnapshot()).status, 404);
    assert.equal((await getSnapshot("99999999-9999-4999-8999-999999999999")).status, 404);
});

test("GET: not logged in (401); an admin login is refused (403)", async () => {
    current = null;
    assert.equal((await getSnapshot()).status, 401);

    current = { role: "ADMIN", id: "admin-1" };
    assert.equal((await getSnapshot()).status, 403);
});

test("methods: GET (read-only stream), POST (register an ID), PATCH (display name); nothing else", () => {
    assert.deepEqual(Object.keys(route).filter(key => /^[A-Z]+$/.test(key)).sort(), ["GET", "PATCH", "POST"]);
});

// ---- Registration client safeguards ------------------------------------------

function registrationHarness() {
    const calls = [];
    const timers = [];
    const responses = [];
    const state = { local: null, own: new Set() };

    const registration = createParticipantRegistration({
        getSessionId: () => "session-1",
        getLocalParticipantId: () => state.local,
        getOwnParticipantIds: () => state.own,
        fetchImpl: async (url, init) => {
            calls.push({ url, participantId: JSON.parse(init.body).participantId });

            const next = responses.shift() ?? { status: 200 };

            if (next.throws) throw new Error("network");

            return { ok: next.status < 300, status: next.status };
        },
        setTimeoutImpl: (callback, ms) => {
            const timer = { callback, ms };

            timers.push(timer);

            return timer;
        },
        clearTimeoutImpl: timer => {
            timer.cleared = true;
        },
        log: () => {}
    });

    const join = id => {
        state.local = id;
        state.own.add(id);
    };

    const runTimers = async () => {
        const due = timers.splice(0).filter(timer => !timer.cleared);

        due.forEach(timer => timer.callback());
        await flush();
    };

    return { registration, calls, timers, responses, join, runTimers };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("registration: posts the current ID to the session's map", async () => {
    const h = registrationHarness();

    h.join("d92a7329");
    h.registration.start("d92a7329");
    await flush();

    assert.deepEqual(h.calls, [{ url: "/api/sessions/session-1/participant-map", participantId: "d92a7329" }]);
});

test("registration: a stale retry never overwrites a newer ID", async () => {
    const h = registrationHarness();

    h.join("old00001");
    h.responses.push({ status: 503 });
    h.registration.start("old00001");
    await flush();

    // While the first attempt waits to retry, a reconnect gives a new ID.
    h.join("new00001");
    h.registration.start("new00001");
    await flush();
    await h.runTimers();

    assert.deepEqual(h.calls.map(c => c.participantId), ["old00001", "new00001"], "the old ID was not posted again");
});

test("registration: a rejected ID (4xx) is not retried; failures back off and retry", async () => {
    const h = registrationHarness();

    h.join("conf0001");
    h.responses.push({ status: 409 });
    h.registration.start("conf0001");
    await flush();
    h.registration.start("conf0001");
    h.registration.ensure(undefined);
    await flush();

    assert.equal(h.calls.length, 1, "409: never again for this ID");

    const g = registrationHarness();

    g.join("netw0001");
    g.responses.push({ throws: true }, { status: 500 });
    g.registration.start("netw0001");
    await flush();
    await g.runTimers(); // the 2 s pause between the two immediate attempts
    await flush();

    assert.equal(g.calls.length, 2);
    assert.equal(g.timers.length, 1, "a backoff retry is scheduled");
    assert.ok(g.timers[0].ms >= 4000 && g.timers[0].ms <= 5000, "first backoff about 5 s");

    await g.runTimers();
    assert.equal(g.calls.length, 3, "retried after the backoff");
});

test("self-repair: re-registers after a server restart or a stale own entry, not over another tab", async () => {
    const h = registrationHarness();

    h.join("old00001");
    h.join("new00001");

    h.registration.ensure("new00001");
    await flush();
    assert.equal(h.calls.length, 0, "already mapped: nothing to do");

    h.registration.ensure(undefined);
    await flush();
    assert.deepEqual(h.calls.map(c => c.participantId), ["new00001"], "server restart: register again");

    h.registration.ensure("old00001");
    await flush();
    assert.equal(h.calls.length, 2, "our own stale ID: register again");

    h.registration.ensure("tab20001");
    await flush();
    assert.equal(h.calls.length, 2, "another tab's ID: left alone");

    const before = registrationHarness();

    before.registration.ensure(undefined);
    await flush();
    assert.equal(before.calls.length, 0, "not joined yet: nothing to register");
});

test("registration: cancelRetry stops a scheduled retry, and the client keeps working (strict-mode remount)", async () => {
    const h = registrationHarness();

    h.join("netw0001");
    h.responses.push({ throws: true }, { throws: true });
    h.registration.start("netw0001");
    await flush();
    await h.runTimers();
    await flush();

    h.registration.cancelRetry();
    await h.runTimers();
    assert.equal(h.calls.length, 2, "cancelled retry did not run");

    h.join("next0001");
    h.registration.start("next0001");
    await flush();
    assert.equal(h.calls.at(-1).participantId, "next0001");
});

// ---- PATCH (display name, presentation only) ------------------------------------

async function as(who, fn) {
    const saved = current;

    current = who;

    try {
        return await fn();
    } finally {
        current = saved;
    }
}

const teacherSnapshot = () => as({ role: "TEACHER", id: TEACHER }, () => getSnapshot()).then(r => r.snapshot);

test("PATCH: a student's name for its current ID reaches the teacher; a classmate sees only its own", async () => {
    await post("me000001");
    await as({ role: "STUDENT", id: AMAL }, async () => {
        await post("amal0001");
        await patchName("amal0001", "Amal P.");
    });

    const result = await patchName("me000001", "Nethmi (temp)");

    assert.equal(result.status, 200);
    assert.equal(result.body.data.updated, true);

    const snapshot = await teacherSnapshot();

    assert.deepEqual(snapshot.participants, { [ME]: "me000001", [AMAL]: "amal0001" }, "identity unchanged");
    assert.deepEqual(snapshot.displayNames, { [ME]: "Nethmi (temp)", [AMAL]: "Amal P." });
    assert.deepEqual((await getSnapshot()).snapshot.displayNames, { [ME]: "Nethmi (temp)" }, "student: own name only");
});

test("PATCH: duplicate names stay apart (by student); a stale ID is not applied; a new ID (reconnect) clears the name", async () => {
    await post("me000001");
    await patchName("me000001", "Amal Perera");
    await as({ role: "STUDENT", id: AMAL }, async () => {
        await post("amal0001");
        await patchName("amal0001", "Amal Perera");
    });

    assert.deepEqual((await teacherSnapshot()).displayNames, { [ME]: "Amal Perera", [AMAL]: "Amal Perera" });

    await post("me000002"); // reconnect: new ID
    assert.deepEqual((await teacherSnapshot()).displayNames, { [AMAL]: "Amal Perera" }, "old connection's name dropped");

    const stale = await patchName("me000001", "Late report");

    assert.equal(stale.status, 200);
    assert.equal(stale.body.data.updated, false);
    assert.equal((await teacherSnapshot()).displayNames[ME], undefined, "stale report not applied");

    assert.equal((await patchName("me000002", "Amal Perera")).body.data.updated, true);
    assert.equal((await teacherSnapshot()).displayNames[ME], "Amal Perera");
});

test("PATCH: names are cleaned (control / bidi characters, whitespace, length); empty clears; same name publishes nothing", async () => {
    await post("me000001");
    await patchName("me000001", "  Ne‮thi\u0007   perera \n");
    assert.equal((await teacherSnapshot()).displayNames[ME], "Nethi perera");

    await patchName("me000001", "x".repeat(150));
    assert.equal((await teacherSnapshot()).displayNames[ME], "x".repeat(100));

    const seq = (await teacherSnapshot()).seq;

    await patchName("me000001", "x".repeat(150));
    assert.equal((await teacherSnapshot()).seq, seq, "unchanged name: no update sent");

    await patchName("me000001", "   ");
    assert.deepEqual((await teacherSnapshot()).displayNames, {});
});

test("PATCH: refused for a teacher (401), another class (403), an ended session (404), bad ID or name (400)", async () => {
    await post("me000001");

    assert.equal((await as({ role: "TEACHER", id: TEACHER }, () => patchName("me000001", "T"))).status, 401);
    assert.equal((await as({ role: "STUDENT", id: OUTSIDER }, () => patchName("me000001", "X"))).status, 403);
    assert.equal((await patchName("bad id", "X")).status, 400);
    assert.equal((await patchName("me000001", 42)).status, 400);
    assert.equal((await patchName("me000001", "x".repeat(401))).status, 400);

    db.sessions[SESSION].isActive = false;
    assert.equal((await patchName("me000001", "X")).status, 404);
    assert.deepEqual(participantMapStore.getParticipantMap(SESSION).displayNames, {}, "nothing recorded");
});

test("PATCH: another student can never label someone else's entry (the student comes from the login)", async () => {
    await post("me000001");
    await as({ role: "STUDENT", id: AMAL }, () => patchName("me000001", "Hijack"));

    assert.deepEqual((await teacherSnapshot()).displayNames, {});
});

// ---- Display name reporter (student browser) ------------------------------------

function reporterHarness() {
    const calls = [];
    const timers = [];
    const responses = [];
    const state = { local: null, name: null };

    const reporter = createDisplayNameReporter({
        getSessionId: () => "session-1",
        getLocalParticipantId: () => state.local,
        getLocalDisplayName: () => state.name,
        fetchImpl: async (url, init) => {
            calls.push({ url, method: init.method, ...JSON.parse(init.body) });

            const next = responses.shift() ?? { status: 200 };

            if (next.throws) throw new Error("network");

            return {
                ok: next.status < 300,
                status: next.status,
                json: async () => ({ success: next.status < 300, data: { updated: next.updated ?? true } })
            };
        },
        setTimeoutImpl: (callback, ms) => {
            const timer = { callback, ms };

            timers.push(timer);

            return timer;
        },
        clearTimeoutImpl: timer => {
            timer.cleared = true;
        },
        log: () => {}
    });

    const runTimers = async () => {
        timers.splice(0).filter(timer => !timer.cleared).forEach(timer => timer.callback());
        await flush();
    };

    return { reporter, calls, timers, responses, state, runTimers };
}

test("reporter: reports the current name only once the server maps the current ID, and only when it differs", async () => {
    const h = reporterHarness();

    h.state.local = "me000001";
    h.state.name = "Nethi perera";
    h.reporter.sync(undefined, undefined);
    h.reporter.sync("old00001", undefined);
    await flush();
    assert.equal(h.calls.length, 0, "not (yet) our mapped ID: nothing sent");

    h.reporter.sync("me000001", undefined); // registration landed
    await flush();
    assert.deepEqual(h.calls, [{ url: "/api/sessions/session-1/participant-map", method: "PATCH", participantId: "me000001", displayName: "Nethi perera" }]);

    h.reporter.sync("me000001", "Nethi perera"); // the server's update
    await flush();
    assert.equal(h.calls.length, 1, "in sync: nothing more");
});

test("reporter: a rename is sent at once; a rename during a request is sent right after it, never in parallel", async () => {
    const h = reporterHarness();

    h.state.local = "me000001";
    h.state.name = "A";
    h.reporter.sync("me000001", "A");

    h.state.name = "B";
    h.reporter.nameChanged();
    h.state.name = "C";
    h.reporter.nameChanged(); // B is in flight
    assert.equal(h.calls.length, 1);

    await flush();
    await flush();
    assert.deepEqual(h.calls.map(call => call.displayName), ["B", "C"]);
});

test("reporter: reconnect (new ID) reports again for the new ID; a refused report waits for the next map", async () => {
    const h = reporterHarness();

    h.state.local = "me000001";
    h.state.name = "Temp";
    h.reporter.sync("me000001", "Temp");

    h.state.local = "me000002"; // reconnect
    h.responses.push({ status: 200, updated: false }); // the server has not seen the new ID yet
    h.reporter.sync("me000002", undefined);
    await flush();
    h.reporter.nameChanged();
    await flush();
    assert.equal(h.calls.length, 1, "refused: not repeated by itself");

    h.reporter.sync("me000002", undefined); // the next map update
    await flush();
    assert.deepEqual(h.calls.map(call => call.participantId), ["me000002", "me000002"]);
});

test("reporter: failures back off and retry; cancelRetry stops it; a 4xx is not retried", async () => {
    const h = reporterHarness();

    h.state.local = "me000001";
    h.state.name = "Temp";
    h.responses.push({ throws: true }, { status: 503 });
    h.reporter.sync("me000001", undefined);
    await flush();
    assert.equal(h.timers.length, 1);
    assert.ok(h.timers[0].ms >= 4000 && h.timers[0].ms <= 5000);

    await h.runTimers();
    assert.equal(h.calls.length, 2);
    assert.ok(h.timers[0].ms >= 8000, "backed off");

    h.reporter.cancelRetry();
    await h.runTimers();
    assert.equal(h.calls.length, 2, "cancelled retry did not run");

    h.responses.push({ status: 403 });
    h.reporter.nameChanged();
    await flush();
    h.reporter.nameChanged();
    await flush();
    assert.equal(h.calls.length, 3, "rejected: not retried");
    assert.equal(h.timers.filter(timer => !timer.cleared).length, 0);
});

// ---- The student's registered name (join info) ----------------------------------

async function joinInfo(query) {
    const response = await joinInfoRoute.GET(
        new Request(`http://localhost/api/sessions/${SESSION}/join-info?${query}`),
        { params: { id: SESSION } }
    );

    return { status: response.status, body: await response.json() };
}

test("join info: the registered name is the LOGGED-IN student's; another studentId in the URL is refused", async () => {
    joinInfoCalls.length = 0;

    const own = await joinInfo(`studentId=${ME}`);

    assert.equal(own.status, 200);
    assert.equal(own.body.data.student.id, ME);
    assert.equal(own.body.data.student.name, "Registered " + ME);

    const noId = await joinInfo("");

    assert.equal(noId.body.data.student.id, ME, "no studentId: still the logged-in student");

    const other = await joinInfo(`studentId=${AMAL}`);

    assert.equal(other.status, 403, "another student's identity is never served");
    assert.deepEqual(joinInfoCalls.map(call => call.studentId), [ME, ME], "looked up for the login only");

    current = null;
    assert.equal((await joinInfo(`studentId=${ME}`)).status, 401);
    assert.equal(joinInfoCalls.length, 2);
});

// ---- The student's own name change (Jitsi's command) ----------------------------

function changerHarness({ current = "Nethmi Silva", api = true } = {}) {
    const commands = [];
    const timers = [];
    const state = { current, throws: false };
    const fakeApi = {
        executeCommand: (...args) => {
            if (state.throws) throw new Error("boom");
            commands.push(args);
        }
    };
    const changer = createDisplayNameChanger({
        getApi: () => (api ? fakeApi : null),
        getCurrentName: () => state.current,
        timeoutMs: 8000,
        setTimeoutImpl: (callback, ms) => {
            const timer = { callback, ms };

            timers.push(timer);

            return timer;
        },
        clearTimeoutImpl: timer => { timer.cleared = true; }
    });

    return { changer, commands, timers, state };
}

const settled = promise => promise.then(value => ({ value }), error => ({ error: error.message }));

test("name change: Jitsi's own displayName command, resolved only by Jitsi's confirmation", async () => {
    const h = changerHarness();
    let done = null;

    settled(h.changer.change("  Nethi   Perera ")).then(result => { done = result; });
    await flush();

    assert.deepEqual(h.commands, [["displayName", "Nethi Perera"]], "the cleaned name, through Jitsi");
    assert.equal(done, null, "not confirmed yet: the header keeps the current name");

    h.changer.confirmed("Nethi Perera");
    await flush();

    assert.deepEqual(done, { value: "Nethi Perera" });
    assert.ok(h.timers[0].cleared);
});

test("name change: empty or too long names are refused before Jitsi is asked", async () => {
    const h = changerHarness();

    for (const name of ["", "   ", "x".repeat(101)]) {
        assert.ok((await settled(h.changer.change(name))).error);
    }

    assert.match((await settled(h.changer.change("x".repeat(101)))).error, /at most 100/);
    assert.equal(h.commands.length, 0);
});

test("name change: one at a time; no confirmation keeps the old name and reports an error; then it can retry", async () => {
    const h = changerHarness();
    const first = settled(h.changer.change("Temp One"));

    assert.match((await settled(h.changer.change("Temp Two"))).error, /already in progress/);
    assert.equal(h.commands.length, 1, "no repeated submission");

    h.timers[0].callback(); // Jitsi never confirmed

    assert.match((await first).error, /did not confirm/);
    assert.equal(h.state.current, "Nethmi Silva", "nothing changed locally");

    const retry = settled(h.changer.change("Temp One"));

    h.changer.confirmed("Temp One");
    assert.deepEqual(await retry, { value: "Temp One" });
});

test("name change: not connected, Jitsi throwing, unmount; the same name needs no change", async () => {
    assert.match((await settled(changerHarness({ api: false }).changer.change("A name"))).error, /not connected/);

    const h = changerHarness();

    h.state.throws = true;
    assert.match((await settled(h.changer.change("A name"))).error, /could not change/);

    h.state.throws = false;

    const pending = settled(h.changer.change("Another"));

    h.changer.cancel("The classroom was closed.");
    assert.match((await pending).error, /closed/);

    assert.deepEqual(await settled(h.changer.change(" Nethmi  Silva ")), { value: "Nethmi Silva" });
    assert.equal(h.commands.length, 1, "only 'Another' was sent");
});

test("name change -> report: once Jitsi confirms, the student's report carries the new name for its own ID", async () => {
    const r = reporterHarness();
    const c = changerHarness({ current: "Nethmi Silva" });

    r.state.local = "me000001";
    r.state.name = "Nethmi Silva";
    r.reporter.sync("me000001", "Nethmi Silva");

    const change = c.changer.change("Nethi Perera");

    // useJitsi's displayNameChange handler: local name, confirmation, report.
    c.changer.confirmed("Nethi Perera");
    r.state.name = "Nethi Perera";
    r.reporter.nameChanged();
    await change;
    await flush();

    assert.deepEqual(r.calls.map(call => [call.method, call.participantId, call.displayName]),
        [["PATCH", "me000001", "Nethi Perera"]]);
});
