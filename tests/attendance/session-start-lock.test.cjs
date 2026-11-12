/*
 * Regression tests: starting a class session creates the session and marks
 * its lecture LIVE in ONE transaction, under FOR NO KEY UPDATE on the lecture
 * row (services/session-service.ts createSessionUnderLectureLock), so a
 * session can never appear between attendance finalization's "no active
 * session" check and its commit.
 *
 *   npm run test:attendance
 *
 * Runs the real service through tsx against an in-memory model of the parts
 * of PostgreSQL the protocol relies on:
 *   - row locks on Lecture: FOR SHARE (finalization) and FOR NO KEY UPDATE
 *     (session start; also taken by UPDATE "Lecture") conflict; two FOR SHARE
 *     do not; locks are held until the transaction ends, waiters are granted
 *     in order;
 *   - READ COMMITTED: each statement sees what is committed when it runs,
 *     plus the transaction's own writes; a failed transaction's writes are
 *     discarded (rollback);
 *   - inserting a ClassSession does NOT conflict with FOR SHARE (its foreign
 *     key only takes FOR KEY SHARE), which is exactly why the explicit lock
 *     is needed (see the control test).
 * Finalization itself does not exist yet: a test helper runs its planned
 * protocol (FOR SHARE, check, commit) against the same model.
 *
 * NOT covered here: real PostgreSQL. See session-start-lock.db.test.cjs
 * (opt-in, needs an explicitly configured throwaway local database).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

const TEACHER = "teacher-1";
const CLASS = "11111111-1111-4111-8111-111111111111";
const LECTURE = "22222222-2222-4222-8222-222222222222";
const OTHER_LECTURE = "33333333-3333-4333-8333-333333333333";

// ---- Log of everything that happens, in order ---------------------------------

let log = [];
const record = (entry) => log.push(entry);
const indexOf = (entry) => {
    const index = log.indexOf(entry);
    assert.notEqual(index, -1, `expected "${entry}" in ${JSON.stringify(log)}`);
    return index;
};

const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

// ---- Row locks on Lecture ----------------------------------------------------------

const conflicts = (a, b) => !(a === "SHARE" && b === "SHARE");

function lockTimeoutError() {
    // Prisma 5.22's shape for a raw query that hit lock_timeout (SQLSTATE 55P03).
    return Object.assign(new Error("canceling statement due to lock timeout"), {
        name: "PrismaClientKnownRequestError", code: "P2010", meta: { code: "55P03" }
    });
}

const locks = {
    held: [],     // { row, owner, mode }
    waiting: [],  // { row, owner, mode, grant }
    // When true, a blocked lock request fails at once with the lock-timeout error.
    failWhenBlocked: false,

    canGrant(row, owner, mode) {
        return this.held.every(h => h.row !== row || h.owner === owner || !conflicts(h.mode, mode));
    },

    async acquire(row, owner, mode) {
        // A transaction re-taking a lock it already holds never waits (as in
        // PostgreSQL: the UPDATE after SELECT ... FOR NO KEY UPDATE).
        if (this.held.some(h => h.row === row && h.owner === owner && h.mode === mode)) return;

        if (this.canGrant(row, owner, mode) && !this.waiting.some(w => w.row === row)) {
            this.held.push({ row, owner, mode });
            return;
        }

        if (this.failWhenBlocked) throw lockTimeoutError();

        record(`${owner}:waits-for-lock`);
        await new Promise(grant => this.waiting.push({ row, owner, mode, grant }));
        record(`${owner}:got-lock`);
    },

    release(owner) {
        this.held = this.held.filter(h => h.owner !== owner);

        // Grant waiters in order while they fit.
        while (this.waiting.length > 0) {
            const next = this.waiting[0];

            if (!this.canGrant(next.row, next.owner, next.mode)) break;

            this.waiting.shift();
            this.held.push({ row: next.row, owner: next.owner, mode: next.mode });
            next.grant();
        }
    },

    holders(row) {
        return this.held.filter(h => h.row === row).map(h => `${h.owner}:${h.mode}`);
    }
};

// ---- Committed state ---------------------------------------------------------------

let db;
let nextId;

function resetDb() {
    db = {
        lectures: {
            [LECTURE]: { id: LECTURE, title: "Kinematics", classId: CLASS, status: 0, classStatus: "SCHEDULED", date: new Date("2026-11-10T03:30:00.000Z") },
            [OTHER_LECTURE]: { id: OTHER_LECTURE, title: "Optics", classId: CLASS, status: 0, classStatus: "SCHEDULED", date: new Date("2026-11-09T03:30:00.000Z") }
        },
        sessions: []
    };
    nextId = 1;
}

const sessionMatches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (key === "class") return value.teacherId === TEACHER;
    if (value && typeof value === "object" && "notIn" in value) return !value.notIn.includes(row[key]);
    return row[key] === value;
});

function sessionOut(row, select) {
    const full = {
        ...row,
        lecture: row.lectureId
            ? { id: row.lectureId, title: db.lectures[row.lectureId].title, date: db.lectures[row.lectureId].date }
            : null
    };

    if (!select) return full;

    return Object.fromEntries(Object.keys(select).map(key => [key, full[key]]));
}

// ---- Hooks the tests use to pause or break a transaction ---------------------------

const hooks = {
    beforeSessionCreate: null, // async (txLabel) => void
    failLectureUpdate: false
};

// ---- Transactions --------------------------------------------------------------------

let transactionOptions = [];
let rawStatements = [];
let txSeq = 0;

function makeTx(label) {
    const tx = { id: label, sessions: [], lectureUpdates: {} };

    const visibleSessions = () => [...db.sessions, ...tx.sessions];
    const visibleLecture = (id) =>
        db.lectures[id] ? { ...db.lectures[id], ...(tx.lectureUpdates[id] || {}) } : null;

    tx.client = {
        $executeRawUnsafe: async (sql) => {
            rawStatements.push({ tx: label, sql, values: [] });
            if (/^SET LOCAL lock_timeout = '\d+ms'$/.test(sql)) return 0;
            throw new Error("unexpected raw SQL " + sql);
        },
        $queryRaw: async (strings, ...values) => {
            const sql = strings.join("$?");
            rawStatements.push({ tx: label, sql, values });

            if (!/FROM "Lecture"/.test(sql)) throw new Error("unexpected raw SQL " + sql);

            const mode = /FOR NO KEY UPDATE/.test(sql) ? "NO_KEY_UPDATE" : /FOR SHARE/.test(sql) ? "SHARE" : null;
            if (!mode) throw new Error("unexpected lock mode " + sql);

            const [id] = values;
            await locks.acquire(id, label, mode);
            record(`${label}:locked-lecture:${mode}`);

            // READ COMMITTED: what is committed now (after the lock wait).
            const row = visibleLecture(id);
            return row ? [{ id: row.id, classId: row.classId, status: row.status, classStatus: row.classStatus, date: row.date }] : [];
        },
        classSession: {
            create: async ({ data, select }) => {
                if (hooks.beforeSessionCreate) await hooks.beforeSessionCreate(label);

                const row = { id: `session-${nextId++}`, startedAt: new Date(), endedAt: null, ...data };
                tx.sessions.push(row);
                record(`${label}:create-session:${row.id}`);
                return sessionOut(row, select);
            },
            count: async ({ where }) => visibleSessions().filter(row => sessionMatches(row, where)).length
        },
        lecture: {
            update: async ({ where, data }) => {
                // UPDATE "Lecture" takes FOR NO KEY UPDATE (re-entrant here).
                await locks.acquire(where.id, label, "NO_KEY_UPDATE");
                if (hooks.failLectureUpdate) throw new Error("simulated failure while marking the lecture LIVE");
                tx.lectureUpdates[where.id] = { ...(tx.lectureUpdates[where.id] || {}), ...data };
                record(`${label}:update-lecture:${data.classStatus}`);
                return visibleLecture(where.id);
            }
        }
    };

    tx.commit = () => {
        db.sessions.push(...tx.sessions);
        for (const [id, data] of Object.entries(tx.lectureUpdates)) Object.assign(db.lectures[id], data);
        record(`${label}:commit`);
    };

    return tx;
}

async function runTransaction(label, fn, options) {
    const tx = makeTx(label);

    try {
        const result = await fn(tx.client);
        tx.commit();
        return result;
    } catch (error) {
        record(`${label}:rollback`);
        throw error;
    } finally {
        // PostgreSQL releases row locks when the transaction ends.
        locks.release(label);
    }
}

// ---- The fake Prisma client (top level: autocommit) ---------------------------------

const fakePrisma = {
    $transaction: async (fn, options) => {
        transactionOptions.push(options);
        return runTransaction(`start-${++txSeq}`, fn, options);
    },
    class: {
        findFirst: async ({ where }) =>
            where.id === CLASS && where.teacherId === TEACHER ? { id: CLASS, name: "Physics", schedule: null } : null
    },
    lecture: {
        findFirst: async ({ where }) => {
            const row = db.lectures[where.id];
            if (!row || row.status !== where.status) return null;
            if (where.classId !== undefined && row.classId !== where.classId) return null;
            if (where.class && where.class.teacherId !== TEACHER) return null;
            return { ...row };
        },
        // Autocommit UPDATE: takes and releases the row lock (the pre-fix order).
        update: async ({ where, data }) => {
            const owner = `autocommit-${++txSeq}`;
            await locks.acquire(where.id, owner, "NO_KEY_UPDATE");
            Object.assign(db.lectures[where.id], data);
            record(`${owner}:update-lecture:${data.classStatus}`);
            locks.release(owner);
            return { ...db.lectures[where.id] };
        }
    },
    classSession: {
        findMany: async ({ where, select }) => db.sessions.filter(row => sessionMatches(row, where)).map(row => sessionOut(row, select)),
        findFirst: async ({ where, select }) => {
            const row = db.sessions.find(r => sessionMatches(r, where));
            return row ? sessionOut(row, select) : null;
        },
        updateMany: async ({ where, data }) => {
            const rows = db.sessions.filter(row => sessionMatches(row, where));
            rows.forEach(row => Object.assign(row, data));
            if (rows.length > 0) record(`end-sessions:${rows.map(r => r.id).join(",")}`);
            return { count: rows.length };
        },
        // Autocommit INSERT: its FK takes only FOR KEY SHARE on the lecture,
        // which no lock here conflicts with (the pre-fix order).
        create: async ({ data, select }) => {
            const row = { id: `session-${nextId++}`, startedAt: new Date(), endedAt: null, ...data };
            db.sessions.push(row);
            record(`autocommit:create-session:${row.id}`);
            return sessionOut(row, select);
        }
    }
};

// ---- Faked edges -----------------------------------------------------------------------

function fake(relativePath, exports) {
    const filename = path.join(root, relativePath);
    const mod = new Module(filename);

    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
}

fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/session-events.ts", {
    emitLiveChange: (change) => record(`event:${change.event}:${change.sessionId}`),
    emitStudentDataChange: () => {}
});
fake("lib/youtube-feature-lifecycle.ts", {
    endYouTubeFeaturesForLecture: async (teacherId, lectureId) => {
        record(`youtube-end:${lectureId}`);
        return { status: "none", closed: 0 };
    },
    reconcileYouTubeFeaturesForNewSession: async (teacherId, lectureId) => {
        record(`youtube-reconcile:${lectureId}`);
        return { status: "none", closed: 0 };
    }
});
fake("services/fee-waiver-events.ts", {
    recalculateAfterLectureChange: async (before, after) => {
        record(`waiver:${before.classStatus}->${after.classStatus}`);
    }
});
fake("lib/mailer.ts", { buildLiveSessionInviteLoginLink: () => "", sendLiveSessionInviteEmail: async () => {} });
fake("lib/session-invite.ts", { signSessionInviteToken: () => "" });
fake("lib/jitsi-auth.ts", { generateJitsiToken: async () => "token" });

const service = require(path.join(root, "services/session-service.ts"));

// ---- Helpers ---------------------------------------------------------------------------------

function reset() {
    resetDb();
    log = [];
    locks.held = [];
    locks.waiting = [];
    locks.failWhenBlocked = false;
    hooks.beforeSessionCreate = null;
    hooks.failLectureUpdate = false;
    transactionOptions = [];
    rawStatements = [];
    txSeq = 0;
}

const start = (lectureId = LECTURE) => service.startClassSessionForTeacher(TEACHER, CLASS, lectureId);

const activeSessionsOf = (lectureId) => db.sessions.filter(s => s.lectureId === lectureId && s.isActive);

/**
 * The planned attendance finalization, run against the same model: lock the
 * lecture FOR SHARE, check (a separate, later statement) that it has no
 * active session, wait for `beforeCommit`, commit. Records how many active
 * sessions were committed at the moment it committed.
 */
async function finalize({ beforeCommit } = {}) {
    let activeAtCommit = null;

    try {
        await runTransaction("finalize", async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Lecture" WHERE "id" = ${LECTURE} FOR SHARE`;

            const active = await tx.classSession.count({ where: { lectureId: LECTURE, isActive: true } });
            record(`finalize:check:${active}`);
            if (active > 0) {
                const error = new Error("An active session blocks finalization.");
                error.code = "SESSION_ACTIVE";
                throw error;
            }

            if (beforeCommit) await beforeCommit();
            activeAtCommit = activeSessionsOf(LECTURE).length;
        });
        return { finalized: true, activeAtCommit };
    } catch (error) {
        if (error.code === "SESSION_ACTIVE") return { finalized: false, reason: "SESSION_ACTIVE" };
        throw error;
    }
}

// ---- Successful start --------------------------------------------------------------------------

test("start: creates the session and marks the lecture LIVE in one committed transaction", async () => {
    reset();

    const result = await start();

    assert.equal(result.session.lectureId, LECTURE);
    assert.equal(result.session.isActive, true);
    assert.equal(result.session.lecture.id, LECTURE);
    assert.equal(result.joinBaseUrl, `/session/join?sessionId=${result.session.id}`);
    assert.equal(result.class.id, CLASS);
    assert.deepEqual(result.youtubeCleanup, { status: "none", closed: 0 });

    assert.equal(activeSessionsOf(LECTURE).length, 1);
    assert.equal(db.lectures[LECTURE].classStatus, "LIVE");

    // Both writes happened inside the same transaction, before its commit.
    const create = indexOf(`start-1:create-session:${result.session.id}`);
    const live = indexOf("start-1:update-lecture:LIVE");
    const commit = indexOf("start-1:commit");
    assert.ok(create < commit && live < commit);
});

test("start: the lock is FOR NO KEY UPDATE on the lecture, parameterized, after SET LOCAL lock_timeout", async () => {
    reset();

    await start();

    const [timeout, lock] = rawStatements;
    assert.equal(timeout.sql, `SET LOCAL lock_timeout = '${service.SESSION_START_LOCK_TIMEOUT_MS}ms'`);
    assert.equal(service.SESSION_START_LOCK_TIMEOUT_MS, 3000);

    assert.match(lock.sql, /FROM "Lecture"/);
    assert.match(lock.sql, /FOR NO KEY UPDATE/);
    assert.deepEqual(lock.values, [LECTURE]);
    assert.ok(!lock.sql.includes(LECTURE), "the lecture id is a bind parameter, never part of the SQL text");

    // The lock is taken before the session row exists.
    assert.ok(indexOf("start-1:locked-lecture:NO_KEY_UPDATE") < indexOf("start-1:create-session:session-1"));
});

test("start: transaction options bound the wait; no isolation level is set (READ COMMITTED)", async () => {
    reset();

    await start();

    assert.equal(transactionOptions.length, 1);
    assert.deepEqual(transactionOptions[0], { maxWait: 5000, timeout: 15000 });
    assert.equal("isolationLevel" in transactionOptions[0], false);
    assert.ok(service.SESSION_START_LOCK_TIMEOUT_MS < service.SESSION_START_TRANSACTION_OPTIONS.timeout);
});

// ---- Rollback ----------------------------------------------------------------------------------

test("rollback: a failure while marking the lecture LIVE leaves no session and no LIVE status", async () => {
    reset();
    hooks.failLectureUpdate = true;

    await assert.rejects(start(), /simulated failure/);

    assert.equal(db.sessions.length, 0);
    assert.equal(db.lectures[LECTURE].classStatus, "SCHEDULED");
    assert.ok(log.includes("start-1:rollback"));
    assert.ok(!log.some(entry => entry.startsWith("event:started")), "no started event for a rolled-back start");
    assert.ok(!log.some(entry => entry.startsWith("youtube-reconcile")));
    assert.deepEqual(locks.held, [], "the lecture lock is released");
});

test("rollback: a failure while creating the session leaves the lecture untouched", async () => {
    reset();
    hooks.beforeSessionCreate = async () => { throw new Error("simulated insert failure"); };

    await assert.rejects(start(), /simulated insert failure/);

    assert.equal(db.sessions.length, 0);
    assert.equal(db.lectures[LECTURE].classStatus, "SCHEDULED");
    assert.ok(!log.some(entry => entry.startsWith("event:started")));
});

test("re-check under the lock: a lecture removed after the ownership check is refused (404), nothing written", async () => {
    reset();
    hooks.beforeSessionCreate = null;

    // Removed between the ownership check and the lock: the lock query sees it.
    const originalFindFirst = fakePrisma.lecture.findFirst;
    fakePrisma.lecture.findFirst = async (args) => {
        const row = await originalFindFirst(args);
        db.lectures[LECTURE].status = 1; // the teacher deletes it right after
        return row;
    };

    try {
        await assert.rejects(start(), (error) => error.statusCode === 404 && error.code === "LECTURE_NOT_FOUND");
    } finally {
        fakePrisma.lecture.findFirst = originalFindFirst;
    }

    assert.equal(db.sessions.length, 0);
    assert.equal(db.lectures[LECTURE].classStatus, "SCHEDULED");
    assert.ok(!log.some(entry => entry.startsWith("event:started")));
});

test("lock timeout: a lecture held by another transaction gives 409 LECTURE_BUSY, nothing written", async () => {
    reset();
    locks.held.push({ row: LECTURE, owner: "finalize-elsewhere", mode: "SHARE" });
    locks.failWhenBlocked = true;

    await assert.rejects(start(), (error) => error.statusCode === 409 && error.code === "LECTURE_BUSY");

    assert.equal(db.sessions.length, 0);
    assert.equal(db.lectures[LECTURE].classStatus, "SCHEDULED");
    assert.ok(!log.some(entry => entry.startsWith("event:started")));
});

// ---- Concurrency with finalization ----------------------------------------------------------

test("finalization first: a start waits for its commit; no session appears between its check and commit", async () => {
    reset();

    const holdFinalization = deferred();
    const finalization = finalize({ beforeCommit: () => holdFinalization.promise });
    await tick();
    assert.ok(log.includes("finalize:check:0"));

    const starting = start();
    for (let i = 0; i < 20; i += 1) await tick();

    // The start reached its lock and is blocked: no session row exists yet.
    assert.ok(log.includes("start-1:waits-for-lock"), JSON.stringify(log));
    assert.ok(!log.some(entry => entry.includes("create-session")));
    assert.equal(db.sessions.length, 0);
    assert.deepEqual(locks.holders(LECTURE), ["finalize:SHARE"]);

    holdFinalization.resolve();
    const finalized = await finalization;
    const result = await starting;

    assert.deepEqual(finalized, { finalized: true, activeAtCommit: 0 });
    assert.ok(indexOf("finalize:commit") < indexOf(`start-1:create-session:${result.session.id}`));
    assert.ok(indexOf("start-1:commit") < indexOf(`event:started:${result.session.id}`));
    assert.equal(activeSessionsOf(LECTURE).length, 1, "the start still succeeds, after finalization");
});

test("start first: finalization waits for the start's commit, then its check sees the session and refuses", async () => {
    reset();

    const holdStart = deferred();
    hooks.beforeSessionCreate = () => holdStart.promise;

    const starting = start();
    for (let i = 0; i < 20; i += 1) await tick();
    assert.deepEqual(locks.holders(LECTURE), ["start-1:NO_KEY_UPDATE"]);

    const finalization = finalize();
    for (let i = 0; i < 20; i += 1) await tick();

    // Finalization is blocked on the lecture lock and has not checked yet.
    assert.ok(log.includes("finalize:waits-for-lock"));
    assert.ok(!log.some(entry => entry.startsWith("finalize:check")));

    holdStart.resolve();
    const result = await starting;
    const finalized = await finalization;

    assert.deepEqual(finalized, { finalized: false, reason: "SESSION_ACTIVE" });
    assert.ok(indexOf("start-1:commit") < indexOf("finalize:check:1"));
    assert.equal(activeSessionsOf(LECTURE)[0].id, result.session.id);
});

test("control: the pre-fix order (insert without the lecture lock) IS caught by this model", async () => {
    reset();

    const holdFinalization = deferred();
    const finalization = finalize({ beforeCommit: () => holdFinalization.promise });
    await tick();
    assert.ok(log.includes("finalize:check:0"));

    // The old code: an autocommit INSERT (FK = FOR KEY SHARE only), which
    // FOR SHARE does not block, and the LIVE update only afterwards.
    await fakePrisma.classSession.create({
        data: { classId: CLASS, lectureId: LECTURE, roomName: "old-order", jitsiDomain: "meet.jit.si", isActive: true }
    });
    const liveUpdate = fakePrisma.lecture.update({ where: { id: LECTURE }, data: { classStatus: "LIVE" } });
    await tick();

    holdFinalization.resolve();
    const finalized = await finalization;
    await liveUpdate;

    // Finalization committed while a session of the lecture was active: the
    // race the fix closes.
    assert.deepEqual(finalized, { finalized: true, activeAtCommit: 1 });
});

// ---- Order around the transaction: replaced sessions, YouTube, events, waivers ----------------

test("replacing a live session: ending, its event and its YouTube cleanup all happen BEFORE the transaction", async () => {
    reset();

    const first = await start(OTHER_LECTURE);
    log = [];

    const second = await start(LECTURE);

    // Previous session ended, its "ended" event, its lecture's YouTube end...
    const ended = indexOf(`end-sessions:${first.session.id}`);
    const endedEvent = indexOf(`event:ended:${first.session.id}`);
    const youtubeEnd = indexOf(`youtube-end:${OTHER_LECTURE}`);
    // ...then the transaction...
    const lock = indexOf("start-2:locked-lecture:NO_KEY_UPDATE");
    const commit = indexOf("start-2:commit");
    // ...then the new session's event and reconciliation.
    const startedEvent = indexOf(`event:started:${second.session.id}`);
    const reconcile = indexOf(`youtube-reconcile:${LECTURE}`);

    assert.ok(ended < endedEvent && endedEvent < youtubeEnd && youtubeEnd < lock);
    assert.ok(lock < commit && commit < startedEvent && startedEvent < reconcile);

    assert.equal(db.sessions.find(s => s.id === first.session.id).isActive, false);
    assert.ok(db.sessions.find(s => s.id === first.session.id).endedAt instanceof Date);
    assert.equal(activeSessionsOf(LECTURE).length, 1);
});

test("waivers: a COMPLETED lecture going LIVE recalculates after the commit; SCHEDULED does not", async () => {
    reset();
    db.lectures[LECTURE].classStatus = "COMPLETED";

    await start();

    assert.ok(indexOf("start-1:commit") < indexOf("waiver:COMPLETED->LIVE"));
    assert.equal(db.lectures[LECTURE].classStatus, "LIVE");

    reset();
    await start();
    assert.ok(!log.some(entry => entry.startsWith("waiver:")));
});

test("authorization: another teacher, another class's lecture, or a removed lecture never reach the transaction", async () => {
    reset();

    await assert.rejects(service.startClassSessionForTeacher("teacher-2", CLASS, LECTURE),
        (error) => error.statusCode === 404);

    db.lectures[OTHER_LECTURE].classId = "99999999-9999-4999-8999-999999999999";
    await assert.rejects(start(OTHER_LECTURE), (error) => error.code === "LECTURE_NOT_FOUND");

    db.lectures[LECTURE].status = 1;
    await assert.rejects(start(LECTURE), (error) => error.code === "LECTURE_NOT_FOUND");

    assert.equal(transactionOptions.length, 0);
    assert.equal(db.sessions.length, 0);
});

// ---- Restart / start by lecture ----------------------------------------------------------------

test("restart: ends the previous session and starts a new one for the same lecture", async () => {
    reset();

    const first = await start();
    const restarted = await service.restartClassSessionForTeacher(TEACHER, first.session.id);

    assert.equal(restarted.previousSessionId, first.session.id);
    assert.notEqual(restarted.session.id, first.session.id);
    assert.equal(restarted.session.lectureId, LECTURE);
    assert.equal(db.sessions.find(s => s.id === first.session.id).isActive, false);
    assert.deepEqual(activeSessionsOf(LECTURE).map(s => s.id), [restarted.session.id]);
    assert.equal(db.lectures[LECTURE].classStatus, "LIVE");
    assert.ok(indexOf(`event:ended:${first.session.id}`) < indexOf(`event:started:${restarted.session.id}`));
});

test("restart: a session with no lecture is still refused (LECTURE_REQUIRED)", async () => {
    reset();
    db.sessions.push({ id: "legacy", classId: CLASS, lectureId: null, isActive: false, roomName: "r", jitsiDomain: "meet.jit.si" });

    await assert.rejects(service.restartClassSessionForTeacher(TEACHER, "legacy"),
        (error) => error.statusCode === 400 && error.code === "LECTURE_REQUIRED");
    assert.equal(transactionOptions.length, 0);
});

test("start for a lecture (lecture page) uses the same locked transaction", async () => {
    reset();

    const result = await service.startSessionForLectureForTeacher(TEACHER, LECTURE);

    assert.equal(result.session.lectureId, LECTURE);
    assert.equal(transactionOptions.length, 1);
    assert.ok(log.includes("start-1:locked-lecture:NO_KEY_UPDATE"));
    assert.equal(db.lectures[LECTURE].classStatus, "LIVE");
});

// ---- Stage 5.7b-2a: a cancelled lecture is never started -------------------------------------

/**
 * The teacher's cancellation as lecture-service runs it (guardedLectureWriteInTransaction):
 * the lecture FOR NO KEY UPDATE, then classStatus CANCELLED, then commit; `beforeCommit` holds it open.
 */
async function cancelLecture({ beforeCommit } = {}) {
    await runTransaction("cancel", async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Lecture" WHERE "id" = ${LECTURE} FOR NO KEY UPDATE`;
        await tx.lecture.update({ where: { id: LECTURE }, data: { classStatus: "CANCELLED" } });
        if (beforeCommit) await beforeCommit();
    });
}

test("cancelled: a start is refused (409 LECTURE_CANCELLED) before anything happens; the class's live session keeps running", async () => {
    reset();
    db.lectures[LECTURE].classStatus = "CANCELLED";
    db.sessions.push({ id: "running", classId: CLASS, lectureId: OTHER_LECTURE, isActive: true, roomName: "r", jitsiDomain: "meet.jit.si", startedAt: new Date(), endedAt: null });

    await assert.rejects(start(), (error) => error.statusCode === 409 && error.code === "LECTURE_CANCELLED" && /cancelled/i.test(error.message));

    assert.equal(transactionOptions.length, 0, "no transaction started");
    assert.equal(db.sessions.length, 1, "no new session");
    assert.equal(db.sessions[0].isActive, true, "the running session of the class was NOT ended");
    assert.ok(!log.some((entry) => entry.startsWith("end-sessions") || entry.startsWith("youtube-") || entry.startsWith("event:")), JSON.stringify(log));
    assert.equal(db.lectures[LECTURE].classStatus, "CANCELLED");
});

test("cancelled: every entry point (lecture page, restart) is refused the same way", async () => {
    reset();
    db.lectures[LECTURE].classStatus = "CANCELLED";
    await assert.rejects(service.startSessionForLectureForTeacher(TEACHER, LECTURE), (error) => error.statusCode === 409 && error.code === "LECTURE_CANCELLED");
    db.sessions.push({ id: "old", classId: CLASS, lectureId: LECTURE, isActive: false, roomName: "r", jitsiDomain: "meet.jit.si", startedAt: new Date(0), endedAt: new Date(1) });
    await assert.rejects(service.restartClassSessionForTeacher(TEACHER, "old"), (error) => error.statusCode === 409 && error.code === "LECTURE_CANCELLED");
    assert.equal(transactionOptions.length, 0);
    assert.equal(db.lectures[LECTURE].classStatus, "CANCELLED");
    assert.ok(!db.sessions.some((s) => s.isActive));
});

test("eligible lectures still start: SCHEDULED, LIVE and COMPLETED go LIVE in the locked transaction", async () => {
    for (const before of ["SCHEDULED", "LIVE", "COMPLETED"]) {
        reset();
        db.lectures[LECTURE].classStatus = before;
        const result = await start();
        assert.equal(result.session.lectureId, LECTURE, before);
        assert.equal(db.lectures[LECTURE].classStatus, "LIVE", before);
        assert.equal(activeSessionsOf(LECTURE).length, 1, before);
    }
    // The locked read now also returns the lecture's classStatus (the authoritative check).
    assert.match(rawStatements.find((s) => /FOR NO KEY UPDATE/.test(s.sql)).sql, /"classStatus"::text AS "classStatus"/);
});

test("race: a cancellation that commits while the start waits for the lock is seen under the lock (409); nothing written; stays CANCELLED", async () => {
    reset();
    const holdCancel = deferred();
    const cancelling = cancelLecture({ beforeCommit: () => holdCancel.promise });
    for (let i = 0; i < 20; i += 1) await tick();
    assert.deepEqual(locks.holders(LECTURE), ["cancel:NO_KEY_UPDATE"]);

    // The start's pre-check still reads the COMMITTED state (SCHEDULED): it passes and waits for the lock.
    const starting = start();
    for (let i = 0; i < 20; i += 1) await tick();
    assert.ok(log.includes("start-1:waits-for-lock"), JSON.stringify(log));

    holdCancel.resolve();
    await cancelling;
    await assert.rejects(starting, (error) => error.statusCode === 409 && error.code === "LECTURE_CANCELLED");

    assert.ok(indexOf("cancel:commit") < indexOf("start-1:rollback"));
    assert.equal(db.lectures[LECTURE].classStatus, "CANCELLED", "never LIVE");
    assert.equal(activeSessionsOf(LECTURE).length, 0, "no session");
    assert.ok(!log.some((entry) => entry.startsWith("start-1:create-session") || entry.startsWith("start-1:update-lecture") || entry.startsWith("event:started")));
});

test("race, other order: a start that holds the lock first commits LIVE; the cancellation waits, then wins (CANCELLED)", async () => {
    reset();
    const holdStart = deferred();
    hooks.beforeSessionCreate = () => holdStart.promise;
    const starting = start();
    for (let i = 0; i < 20; i += 1) await tick();
    assert.deepEqual(locks.holders(LECTURE), ["start-1:NO_KEY_UPDATE"]);

    const cancelling = cancelLecture();
    for (let i = 0; i < 20; i += 1) await tick();
    assert.ok(log.includes("cancel:waits-for-lock"));

    holdStart.resolve();
    await starting;
    await cancelling;
    assert.ok(indexOf("start-1:commit") < indexOf("cancel:commit"));
    assert.equal(db.lectures[LECTURE].classStatus, "CANCELLED", "the cancellation is last: the lecture is not left LIVE");
    // A later start can never revive it.
    await assert.rejects(start(), (error) => error.code === "LECTURE_CANCELLED");
    assert.equal(db.lectures[LECTURE].classStatus, "CANCELLED");
});
