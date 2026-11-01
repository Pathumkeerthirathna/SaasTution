/*
 * The teacher page's visit history (components/Jitsi/session-visit-history.ts):
 * parsing the existing attendance endpoint, matching visits to participant IDs,
 * the message caps, and keeping it current from the existing event stream.
 *
 *   npm run test:attendance
 *
 * Pure: a fake fetch, a fake event stream and fake timers. The browser hook
 * (useSessionVisitHistory) only wires these to fetch / EventSource.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const history = require(path.join(root, "components/Jitsi/session-visit-history.ts"));

const iso = (h, m) => new Date(Date.UTC(2026, 10, 1, h, m)).toISOString();
const ms = (h, m) => Date.UTC(2026, 10, 1, h, m);

// What GET /api/sessions/[id]/attendance returns (data), contacts included.
const endpointData = {
    session: { id: "sess-1" },
    joinedStudents: [
        {
            student: { id: "s-nethmi", name: "Nethmi Silva", grade: { id: 1 }, contact: "0771234567" },
            logs: [
                { id: "a3", joinedAt: iso(10, 18), leftAt: null },
                { id: "a1", joinedAt: iso(9, 5), leftAt: iso(9, 35) },
                { id: "a2", joinedAt: iso(9, 42), leftAt: iso(10, 10) }
            ],
            totalAttendedMs: 1,
            isPresent: true
        },
        { student: { id: "s-amal", name: "Amal", contact: "0770000000" }, logs: [{ joinedAt: iso(9, 0), leftAt: null }] },
        { student: { id: "s-bad" }, logs: [{ joinedAt: "not a date", leftAt: null }] },
        { student: {}, logs: [] }
    ],
    notJoinedStudents: [{ id: "s-never", name: "Never", contact: "0779999999" }]
};

test("parse: every visit per student, oldest first, times only (no contact, grade or name)", () => {
    const parsed = history.parseVisitHistory(endpointData);

    assert.deepEqual([...parsed.keys()], ["s-nethmi", "s-amal"]);
    assert.deepEqual(parsed.get("s-nethmi"), [[ms(9, 5), ms(9, 35)], [ms(9, 42), ms(10, 10)], [ms(10, 18), null]]);
    assert.ok(!JSON.stringify([...parsed]).match(/077|Nethmi|grade/));
    assert.equal(history.parseVisitHistory(null).size, 0);
    assert.equal(history.parseVisitHistory({ joinedStudents: "x" }).size, 0);
});

test("entries: by the CURRENT participant ID of each mapped student; reconnects, unmapped and guests left out", () => {
    const parsed = history.parseVisitHistory(endpointData);

    // Participant ID -> studentId: the page builds it from the participant map
    // (current, unambiguous, never the teacher's own IDs).
    assert.deepEqual(history.studentHistoryEntries(new Map([["neth0002", "s-nethmi"], ["amal0001", "s-amal"], ["gues0001", "s-never"]]), parsed), [
        ["neth0002", [[ms(9, 5), ms(9, 35)], [ms(9, 42), ms(10, 10)], [ms(10, 18), null]]],
        ["amal0001", [[ms(9, 0), null]]]
    ]);
    assert.deepEqual(history.studentHistoryEntries(new Map([["bad id!", "s-amal"]]), parsed), []);
});

test("entries: caps (500 students, the latest 50 visits with the real total)", () => {
    const visits = Array.from({ length: 80 }, (_, i) => [ms(8, 0) + i * 60000, ms(8, 0) + i * 60000 + 1000]);
    const parsed = new Map([["s-long", visits]]);
    const [entry] = history.studentHistoryEntries(new Map([["long0001", "s-long"]]), parsed);

    assert.equal(entry[1].length, 50);
    assert.equal(entry[2], 80);
    assert.deepEqual(entry[1][49], visits[79], "the latest are kept");

    const students = new Map(Array.from({ length: 600 }, (_, i) => ["p" + String(i).padStart(4, "0"), "s-long"]));

    assert.equal(history.studentHistoryEntries(students, parsed).length, 500);
});

// ---- Keeping it current --------------------------------------------------------

function syncHarness() {
    const fetches = [];
    const timers = [];
    const streams = [];
    const results = [];

    const sync = history.createVisitHistorySync({
        fetchHistory: signal => new Promise((resolve, reject) => fetches.push({ resolve, reject, signal })),
        openEvents: handlers => {
            const stream = { handlers, closed: false };

            streams.push(stream);

            return () => { stream.closed = true; };
        },
        onHistory: value => results.push(value),
        debounceMs: 500,
        setTimeoutImpl: (callback, delay) => {
            const timer = { callback, delay, cleared: false };

            timers.push(timer);

            return timer;
        },
        clearTimeoutImpl: timer => { timer.cleared = true; },
        createAbortController: () => {
            const controller = { signal: { aborted: false }, abort: () => { controller.signal.aborted = true; } };

            return controller;
        }
    });

    const runTimers = () => timers.splice(0).filter(timer => !timer.cleared).forEach(timer => timer.callback());
    const flush = () => new Promise(resolve => setImmediate(resolve));

    return { sync, fetches, timers, streams, results, runTimers, flush };
}

test("sync: fetch at start; attendance events are debounced into one refetch", async () => {
    const h = syncHarness();

    h.sync.start();
    assert.equal(h.fetches.length, 1);
    assert.equal(h.streams.length, 1, "the existing event stream");

    h.fetches[0].resolve(endpointData);
    await h.flush();
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].get("s-nethmi").length, 3);

    h.streams[0].handlers.onOpen(); // first open: just fetched
    h.streams[0].handlers.onUpdate();
    h.streams[0].handlers.onUpdate();
    h.streams[0].handlers.onUpdate();
    assert.equal(h.fetches.length, 1, "debounced");

    h.runTimers();
    assert.equal(h.fetches.length, 2, "one refetch for the burst");
});

test("sync: one request at a time; events during it fetch once more after; a stopped sync never applies", async () => {
    const h = syncHarness();

    h.sync.start();
    h.sync.refresh(true);
    h.sync.refresh(true);
    assert.equal(h.fetches.length, 1, "in flight: queued, not parallel");

    h.fetches[0].resolve(endpointData);
    await h.flush();
    assert.equal(h.fetches.length, 2, "the queued one");

    h.sync.stop();
    assert.equal(h.fetches[1].signal.aborted, true);
    assert.equal(h.streams[0].closed, true);

    h.fetches[1].resolve(endpointData);
    await h.flush();
    assert.equal(h.results.length, 1, "nothing applied after stop");

    h.streams[0].handlers.onUpdate();
    assert.equal(h.timers.filter(timer => !timer.cleared).length, 0, "no timers left");
});

test("sync: a stream error reconnects with backoff and refetches once reconnected; a failed fetch keeps the old history", async () => {
    const h = syncHarness();

    h.sync.start();
    h.fetches[0].resolve(endpointData);
    await h.flush();
    h.streams[0].handlers.onOpen();

    h.streams[0].handlers.onError();
    assert.equal(h.streams[0].closed, true);

    const reconnect = h.timers.find(timer => !timer.cleared);

    assert.ok(reconnect.delay >= 800 && reconnect.delay <= 1000, "1 s backoff");

    h.runTimers();
    assert.equal(h.streams.length, 2);
    h.streams[1].handlers.onOpen();
    assert.equal(h.fetches.length, 2, "missed events: fetched again");

    h.fetches[1].reject(new Error("503"));
    await h.flush();
    assert.equal(h.results.length, 1, "kept as it was");
});
