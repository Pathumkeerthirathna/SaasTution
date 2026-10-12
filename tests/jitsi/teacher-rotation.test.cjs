/*
 * Regression tests: Phase D teacher camera rotation (deploy/jitsi/custom.js).
 *
 *   npm run test:jitsi
 *
 * These run the real custom.js against a MOCK Jitsi store, receive
 * controller and bridge (see harness.cjs). They check custom.js's own
 * logic; they do not verify production Jitsi / lib-jitsi-meet / JVB
 * receiver behaviour, which needs a real browser and bridge.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness, createScheduler, ids } = require("./harness.cjs");

// ---- helpers -----------------------------------------------------------------

// Runs the scheduler for `ticks` sub-ticks, calling perTick(tick) first.
// Returns the longest time (in sub-ticks) any student waited between two
// live periods, the students never live, and the per-tick check failures.
function runTicks(sched, students, ticks, perTick) {
    const { rotation } = sched;
    const lastLive = new Map(students.map(id => [id, 0]));
    const neverLive = new Set(students);
    let maxWait = 0;
    const failures = [];

    for (let tick = 1; tick <= ticks; tick++) {
        const excluded = perTick ? perTick(tick) || [] : [];
        const before = rotation.stats();
        const waitingBefore = before.waiting;

        rotation.subtick();

        const after = rotation.stats();
        const admitted = after.live.filter(id => !before.live.includes(id));

        // Fairness order: a sub-tick admits the LONGEST-waiting students: the
        // admitted ones are the first of the previous waiting order.
        // (Skipped for versions without stats().waiting, so that the
        // starvation checks below still run against them.)
        if (waitingBefore && before.rotating && after.rotating && admitted.length) {
            const expected = waitingBefore.slice(0, admitted.length);

            if (admitted.slice().sort().join() !== expected.slice().sort().join()) {
                failures.push(`tick ${tick}: admitted ${admitted} instead of ${expected}`);
            }
        }

        students.forEach(id => {
            if (rotation.isPlannedLive(id)) {
                neverLive.delete(id);
                lastLive.set(id, tick);
            } else if (!excluded.includes(id)) {
                maxWait = Math.max(maxWait, tick - lastLive.get(id));
            }
        });
    }

    return { maxWait, neverLive, failures };
}

// Every student's camera source that is not selected but whose tile still
// plays, at the moment constraints reach lib-jitsi-meet: a tile that could
// show whatever its stream carries next.
function playingButDropped(h, constraints) {
    if (!constraints || !Array.isArray(constraints.selectedSources)) {
        return [];
    }

    const problems = [];

    for (const [id, participant] of h.participants.remote) {
        if (participant.role === "moderator") {
            continue;
        }

        const source = h.cameraSourceOf(id);
        const tile = h.tile(id);

        if (!tile || constraints.selectedSources.includes(source)) {
            continue;
        }

        if (!tile.video.paused && tile.video.srcObject) {
            problems.push(id);
        }
    }

    return problems;
}

async function teacherWith(count, options) {
    const h = createHarness(options);

    ids(count).forEach(id => h.addParticipant(id));
    await h.startTeacher();

    return h;
}

// ---- scheduler fairness (direct, no DOM) ---------------------------------------

test("no starvation while the CPU camera budget ramps (old code: 62/100 never shown)", () => {
    const sched = createScheduler();
    const students = ids(100);
    const state = sched.stateFor(students);

    sched.rotation.update(state);

    const result = runTicks(sched, students, 600, tick => {
        const budget = 9 + (tick % 10);

        sched.setBudget(budget >= 18 ? null : budget, state);
    });

    assert.deepEqual([...result.neverLive], []);
    assert.deepEqual(result.failures, []);
    // Worst case with the smallest window (9 slots, 2 per sub-tick).
    assert.ok(result.maxWait <= Math.ceil((100 - 9) / 2) + 2, `max wait ${result.maxWait} sub-ticks`);
});

test("no starvation while the CPU camera budget oscillates (old code: 77/100 never shown)", () => {
    const sched = createScheduler();
    const students = ids(100);
    const state = sched.stateFor(students);

    sched.rotation.update(state);

    const result = runTicks(sched, students, 600, tick => {
        if (tick % 2 === 0) {
            sched.setBudget(tick % 4 === 0 ? null : 9, state);
        }
    });

    assert.deepEqual([...result.neverLive], []);
    assert.deepEqual(result.failures, []);
    assert.ok(result.maxWait <= Math.ceil((100 - 9) / 2) + 2, `max wait ${result.maxWait} sub-ticks`);
});

test("no starvation with a random budget including zero", () => {
    const sched = createScheduler();
    const students = ids(60);
    const state = sched.stateFor(students);
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    sched.rotation.update(state);

    const result = runTicks(sched, students, 1500, () => {
        const budget = Math.floor(random() * 19);

        sched.setBudget(budget >= 18 ? null : budget, state);
    });

    assert.deepEqual([...result.neverLive], []);
    assert.deepEqual(result.failures, []);
});

test("budget zero drops (and freezes) every rotating camera, recovery resumes with the longest waiting", () => {
    const sched = createScheduler();
    const students = ids(30);
    const state = sched.stateFor(students);
    const dropped = [];

    sched.rotation.onWillDrop(list => dropped.push(...list));
    sched.rotation.update(state);

    const waitingBefore = sched.rotation.stats().waiting;
    const liveBefore = sched.rotation.stats().live;

    sched.setBudget(0, state);
    assert.equal(sched.rotation.stats().live.length, 0);
    assert.equal(sched.rotation.stats().timerActive, false);
    // (The "lost" check may report the same IDs again: freezing is idempotent.)
    assert.deepEqual([...new Set(dropped)].sort(), Array.from(liveBefore).sort(), "every live camera frozen before the drop");

    sched.setBudget(null, state);

    // The 12 who were waiting before the cut come first, then 6 of the 18
    // who had just been live.
    const live = sched.rotation.stats().live;

    waitingBefore.forEach(id => assert.ok(live.includes(id), `${id} (longest waiting) is live again`));
    assert.equal(live.length, 18);
});

test("selected student stays live; toggling the selection cannot starve others", () => {
    const sched = createScheduler();
    const students = ids(50);
    const state = sched.stateFor(students);

    sched.rotation.update(state);

    const result = runTicks(sched, students, 600, tick => {
        sched.rotation.setPriority(tick % 2 ? ["stud003"] : []);
        sched.rotation.update(state);

        if (tick % 2) {
            assert.ok(sched.rotation.isPlannedLive("stud003"), `selected student live at tick ${tick}`);
        }

        return ["stud003"];
    });

    assert.deepEqual([...result.neverLive], []);
    assert.deepEqual(result.failures, []);
    assert.ok(result.maxWait <= Math.ceil((50 - 17) / 4) + 2, `max wait ${result.maxWait} sub-ticks`);
});

test("selection never pushes the 18-camera ceiling over: selected + rotating = 18", () => {
    const sched = createScheduler();
    const students = ids(40);
    const state = sched.stateFor(students);

    sched.rotation.setPriority(["stud039"]);
    sched.rotation.update(state);

    const stats = sched.rotation.stats();

    assert.equal(stats.priority.length + stats.live.length, 18);
    assert.ok(sched.rotation.isPlannedLive("stud039"));
});

test("a deselected student goes to the back of the queue", () => {
    const sched = createScheduler();
    const students = ids(30);
    const state = sched.stateFor(students);

    sched.rotation.update(state);

    // Select a student who is waiting (not live).
    const target = sched.rotation.stats().waiting[0];

    sched.rotation.setPriority([target]);
    sched.rotation.update(state);
    assert.ok(sched.rotation.isPlannedLive(target));

    sched.rotation.setPriority([]);
    sched.rotation.update(state);

    const waiting = sched.rotation.stats().waiting;

    assert.equal(waiting[waiting.length - 1], target, "deselected student waits last");
});

test("camera off/on keeps a waiting student's place; a live student turning off goes to the back", () => {
    const sched = createScheduler();
    const students = ids(30);

    sched.rotation.update(sched.stateFor(students));

    const { waiting, live } = sched.rotation.stats();
    const waiter = waiting[0];
    const liveOne = live[0];

    sched.rotation.update(sched.stateFor(students, { off: [waiter, liveOne] }));
    sched.rotation.update(sched.stateFor(students));

    const after = sched.rotation.stats();

    // The waiter kept the head of the queue; the one who was live waits last.
    assert.equal(after.waiting[0], waiter, "waiting student kept their place");
    assert.equal(after.waiting[after.waiting.length - 1], liveOne, "the student who was live waits last");

    sched.rotation.subtick();
    assert.ok(sched.rotation.isPlannedLive(waiter), "and goes live on the next sub-tick");
});

test("join / leave / camera churn cannot starve the stable students", () => {
    const sched = createScheduler();
    const stable = ids(40);
    const churn = ids(6, "churn");
    let present = stable.concat(churn);

    sched.rotation.update(sched.stateFor(present));

    const result = runTicks(sched, stable, 500, tick => {
        // Churners leave, rejoin and toggle cameras constantly.
        present = stable.concat(churn.filter((id, index) => (tick + index) % 3 !== 0));
        sched.rotation.update(sched.stateFor(present, { off: churn.filter((id, index) => (tick + index) % 2) }));
    });

    assert.deepEqual([...result.neverLive], []);
    assert.ok(result.maxWait <= Math.ceil((46 - 18) / 4) + 3, `max wait ${result.maxWait} sub-ticks`);
});

test("co-teacher cameras are always received and never use a student slot", () => {
    const sched = createScheduler();
    const everyone = ids(30).concat(["coteach1"]);
    const state = sched.stateFor(everyone, { moderators: ["coteach1"] });

    sched.rotation.update(state);

    const stats = sched.rotation.stats();

    assert.deepEqual(Array.from(stats.coTeachers), ["coteach1"]);
    assert.equal(stats.live.length, 18);
    assert.ok(sched.rotation.isPlannedLive("coteach1"));
    assert.ok(sched.rotation.receiveIds().includes("coteach1"));
});

test("a new conference (reconnect) clears all rotation state and credit", () => {
    const sched = createScheduler();
    const students = ids(30);

    sched.rotation.update(sched.stateFor(students));
    sched.rotation.subtick();

    const fresh = sched.stateFor(students);

    fresh["features/base/conference"] = { conference: {} };
    sched.rotation.update(fresh);

    const stats = sched.rotation.stats();

    assert.equal(stats.live.length, 18);
    // All equal credit again: rotation order only.
    assert.equal(stats.waiting.length, 12);
});

// ---- receive policy + teacher view (integration with mocks) ----------------

test("receive policy: 18 student cameras at most, plus stage, co-teacher and screen share", async () => {
    const h = createHarness();

    ids(40).forEach(id => h.addParticipant(id));
    h.addParticipant("coteach1", { role: "moderator" });
    const share = h.addScreenShare("stud005");

    await h.startTeacher();
    h.change();

    const sent = h.lastSent();
    const studentCameras = sent.selectedSources.filter(source => source.startsWith("stud") && source.endsWith("-v0"));

    assert.equal(studentCameras.length, 18);
    assert.ok(sent.selectedSources.includes("coteach1-v0"), "co-teacher camera selected");
    assert.ok(sent.selectedSources.includes(share), "screen share selected");
    assert.equal(sent.constraints[share].maxHeight, 360);
    assert.equal(sent.constraints[studentCameras[0]].maxHeight, 180);
    assert.equal(sent.defaultConstraints.maxHeight, 0);
    assert.equal(sent.lastN, sent.selectedSources.length);
});

test("freeze-before-drop: no tile still plays when its camera stops being selected", async () => {
    const h = createHarness();
    const violations = [];

    ids(30).forEach(id => h.addParticipant(id));
    h.onSend.push(constraints => violations.push(...playingButDropped(h, constraints)));

    await h.startTeacher();
    await h.run(60000, 1000);

    const modes = Object.values(h.tileModes());

    assert.ok(modes.includes("frozen"), "rotation froze tiles during the run");
    assert.deepEqual(violations, []);
});

test("freeze-before-drop also holds when the CPU budget shrinks", async () => {
    const h = createHarness();
    const violations = [];

    ids(24).forEach(id => h.addParticipant(id));
    h.onSend.push(constraints => violations.push(...playingButDropped(h, constraints)));

    await h.startTeacher();
    await h.run(4000);

    h.controller.limited = true;
    h.controller.limitedLastN = 6;
    await h.run(3000);

    assert.equal(h.rotation().stats().slots, 6);
    assert.deepEqual(violations, []);
});

test("a frozen tile keeps its own student's frame when the stream is re-mapped (SSRC rewrite)", async () => {
    const h = await teacherWith(24);

    await h.run(30000);

    const frozenId = Object.entries(h.tileModes()).find(([, mode]) => mode === "frozen")?.[0];

    assert.ok(frozenId, "a frozen tile exists");
    assert.equal(h.tile(frozenId).video.shownOwner, frozenId);

    // The bridge re-uses the frozen student's stream for another student.
    h.addParticipant("newcomer", { camera: true });
    h.removeParticipant("newcomer");
    h.participants.remote.set("newcomer", {
        id: "newcomer",
        name: "newcomer",
        role: "participant",
        sources: new Map([["video", new Map([["newcomer-v0", { videoType: "camera", muted: false }]])]])
    });
    h.remapTrack(frozenId, "newcomer");
    h.change();
    await h.flush();
    await h.run(6000);

    assert.equal(h.tile(frozenId).video.shownOwner, frozenId, "frozen tile still shows its own student");
    assert.notEqual(h.tileModes()[frozenId], "live", "not live without its own track");
});

test("streaming state: planned but not arriving is never shown as live", async () => {
    const h = createHarness();

    ids(10).forEach(id => h.addParticipant(id));

    // Teacher view on, but the mock bridge has not delivered anything yet.
    h.timers.advance(600);
    h.change();
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 1, enabled: true });
    h.change();
    await h.flush();

    const before = h.tileModes();

    ids(10).forEach(id => {
        assert.ok(h.rotation().isPlannedLive(id), `${id} planned`);
        assert.equal(before[id], "connecting", `${id} not live before any video`);
    });

    // Delivered: active -> live.
    h.deliver();
    await h.flush();
    ids(10).forEach(id => assert.equal(h.tileModes()[id], "live"));

    // The bridge stops forwarding one planned camera (bandwidth, limiter):
    // its tile holds its frame and is paused, not "live".
    h.trackOf("stud004").jitsiTrack.setStatus("interrupted");
    await h.flush();
    assert.equal(h.tileModes().stud004, "stalled");
    assert.equal(h.tile("stud004").video.paused, true);
    assert.equal(h.tile("stud004").video.shownOwner, "stud004");

    h.trackOf("stud004").jitsiTrack.setStatus("active");
    await h.flush();
    assert.equal(h.tileModes().stud004, "live");
    assert.equal(h.tile("stud004").video.paused, false);
});

test("streaming state: a resumed (previously frozen) tile waits for active before playing", async () => {
    const h = await teacherWith(24);

    h.teacherTest().rotationAutoTick(false);

    // Drop four, then bring them back without the bridge delivering.
    h.teacherTest().rotationTick();
    await h.flush();
    h.deliver();
    await h.flush();

    const frozen = Object.keys(h.tileModes()).filter(id => h.tileModes()[id] === "frozen");

    assert.ok(frozen.length > 0);

    for (let tick = 0; tick < 10 && frozen.some(id => !h.rotation().isPlannedLive(id)); tick++) {
        h.teacherTest().rotationTick();
        await h.flush();
    }

    const resumed = frozen.filter(id => h.rotation().isPlannedLive(id));

    assert.ok(resumed.length > 0, "some frozen students are planned again");
    resumed.forEach(id => {
        assert.equal(h.tileModes()[id], "stalled", `${id} holds its frame until video arrives`);
        assert.equal(h.tile(id).video.paused, true);
    });

    h.deliver();
    await h.flush();
    resumed.forEach(id => assert.equal(h.tileModes()[id], "live"));
});

test("streaming state fallback: without the status API a tile is live only once a frame arrived", async () => {
    const h = createHarness({ streamingStatusApi: false });

    ids(6).forEach(id => h.addParticipant(id));
    h.timers.advance(600);
    h.change();
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 1, enabled: true });
    h.change();
    await h.flush();

    assert.equal(h.tileModes().stud000, "connecting");
    // Must keep playing to receive its first frame.
    assert.equal(h.tile("stud000").video.paused, false);

    h.deliver();
    await h.flush();
    await h.flush();
    assert.equal(h.tileModes().stud000, "live");
});

test("status listeners: one per watched tile, all removed when the view goes", async () => {
    const h = await teacherWith(24);

    await h.run(40000);

    h.state["features/base/tracks"].forEach(track => {
        assert.ok(track.jitsiTrack.listenerCount() <= 1, `${track.participantId}: at most one tile listener`);
    });

    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: false });
    await h.flush();

    h.state["features/base/tracks"].forEach(track => {
        assert.equal(track.jitsiTrack.listenerCount(), 0, `${track.participantId}: no listener after hide`);
    });
});

test("CPU limiter detected without the rotation timer (all fit) and without a Jitsi recompute", async () => {
    const h = await teacherWith(12);
    const rotation = h.rotation();

    assert.equal(rotation.stats().timerActive, false, "12 cameras fit: no rotation timer");
    assert.equal(rotation.stats().live.length, 12);

    const recomputes = h.jitsiRecomputes;

    h.controller.limited = true;
    h.controller.limitedLastN = 6;
    await h.run(2000);

    assert.equal(h.jitsiRecomputes, recomputes, "Jitsi did not recompute constraints");
    assert.equal(rotation.getCpuCameraBudget(), 6);
    assert.equal(rotation.stats().live.length, 6);
    assert.equal(h.lastSent().selectedSources.length, 6, "constraints re-applied for the smaller budget");

    // Only six are forwarded: the others are not shown as live.
    const modes = h.tileModes();

    assert.equal(ids(12).filter(id => modes[id] === "live").length, 6);

    // Limiter recovers: everyone back, still without a Jitsi recompute.
    h.controller.limited = false;
    await h.run(2000);

    assert.equal(h.jitsiRecomputes, recomputes);
    assert.equal(rotation.getCpuCameraBudget(), null);
    assert.equal(rotation.stats().live.length, 12);
    assert.equal(h.lastSent().selectedSources.length, 12);
});

test("CPU limiter: a budget of zero (timer stopped) recovers on its own", async () => {
    const h = await teacherWith(30);
    const rotation = h.rotation();

    h.controller.limited = true;
    h.controller.limitedLastN = 0;
    await h.run(2000);

    assert.equal(rotation.getCpuCameraBudget(), 0);
    assert.equal(rotation.stats().live.length, 0);
    assert.equal(rotation.stats().timerActive, false);

    const recomputes = h.jitsiRecomputes;

    h.controller.limitedLastN = 9;
    await h.run(2000);

    assert.equal(h.jitsiRecomputes, recomputes);
    assert.equal(rotation.stats().slots, 9);
    assert.equal(rotation.stats().live.length, 9);
    assert.equal(rotation.stats().timerActive, true);
});

test("CPU limiter poll runs only while Phase D applies (single timer)", async () => {
    const h = await teacherWith(20);

    assert.equal(h.timers.intervalsNamed("pollCpuLimiter"), 1);

    // Exam Mode receive set: no Phase D, no poll.
    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 1, enabled: true, participantIds: ["stud000", "stud001"] });
    await h.flush();
    assert.equal(h.timers.intervalsNamed("pollCpuLimiter"), 0);

    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 2, enabled: false, participantIds: [] });
    h.change();
    await h.flush();
    assert.equal(h.timers.intervalsNamed("pollCpuLimiter"), 1);

    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: false });
    await h.flush();
    assert.equal(h.timers.intervalsNamed("pollCpuLimiter"), 0);
});

test("CPU limiter poll stops without a conference and restarts with the next one", async () => {
    const h = await teacherWith(20);
    const polls = () => h.timers.intervalsNamed("pollCpuLimiter");

    assert.equal(polls(), 1);

    // Meeting ended, no store change at all: the poll stops itself.
    h.setConference(null);
    h.timers.advance(1000);
    assert.equal(polls(), 0, "stopped by its own tick");

    // A store change while still without a conference does not restart it.
    h.change({ recompute: false });
    await h.flush();
    h.timers.advance(5000);
    assert.equal(polls(), 0);

    // Rejoin: a new conference (teacher view still enabled) restarts it.
    h.setConference(h.newConference());
    h.change();
    await h.flush();
    assert.equal(polls(), 1, "restarted with the new conference");
    assert.equal(h.rotation().isActive(), true);

    // And it works on the new conference without a Jitsi recompute.
    const recomputes = h.jitsiRecomputes;

    h.controller.limited = true;
    h.controller.limitedLastN = 6;
    await h.run(2000);

    assert.equal(h.jitsiRecomputes, recomputes);
    assert.equal(h.rotation().stats().live.length, 6);

    // Left again, this time noticed through a store change.
    h.setConference(null);
    h.change({ recompute: false });
    await h.flush();
    assert.equal(polls(), 0, "stopped by the store change");
});

test("tooltip: a planned student whose stream was re-mapped away shows Connecting…", async () => {
    const h = await teacherWith(24);

    await h.run(12000);
    h.teacherTest().rotationAutoTick(false);

    const modes = h.tileModes();
    const rotatedOut = Object.keys(modes).find(id => modes[id] === "frozen");
    const liveId = Object.keys(modes).find(id => modes[id] === "live" && id.startsWith("stud"));

    assert.ok(rotatedOut && liveId);
    assert.equal(h.tile(rotatedOut).chip.title, "Live view resumes shortly");

    // The live student's stream is re-used for someone who just joined.
    h.participants.remote.set("newcomer", {
        id: "newcomer",
        name: "newcomer",
        role: "participant",
        sources: new Map([["video", new Map([["newcomer-v0", { videoType: "camera", muted: false }]])]])
    });
    h.remapTrack(liveId, "newcomer");
    h.change();
    await h.flush();

    assert.ok(h.rotation().isPlannedLive(liveId), "still planned live");
    assert.equal(h.tileModes()[liveId], "frozen", "holds its frame without its own stream");
    assert.equal(h.tile(liveId).chip.title, "Connecting…");
    assert.equal(h.tile(liveId).video.paused, true);
    assert.equal(h.tile(liveId).video.shownOwner, liveId, "still its own student's frame");
    assert.equal(h.tile(rotatedOut).chip.title, "Live view resumes shortly");
});

test("limiter ceiling: raised by Phase D, restored by Exam Mode, view off, demotion and lastN 0", async () => {
    const h = await teacherWith(20);
    const ceiling = () => h.receiveTest().limiterCeiling();

    assert.equal(ceiling(), 18, "Phase D level");

    // lastN 0 (audio only): passed through unchanged, ceiling restored.
    h.jitsiRecompute({ lastN: 0 });
    assert.equal(h.lastSent().lastN, 0);
    assert.deepEqual(Array.from(h.lastSent().selectedSources), []);
    assert.equal(ceiling(), 5);

    h.jitsiRecompute();
    assert.equal(ceiling(), 18, "raised again after audio-only");

    // Exam Mode.
    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 1, enabled: true, participantIds: ["stud000"] });
    assert.equal(ceiling(), 5);
    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 2, enabled: false, participantIds: [] });
    h.change();
    assert.equal(ceiling(), 18);

    // Demoted to a student (role change), teacher view still enabled.
    h.participants.local.role = "participant";
    h.change();
    await h.flush();
    assert.equal(ceiling(), 5, "restored after demotion");
    assert.equal(h.rotation().isActive(), false);

    // Promoted back.
    h.participants.local.role = "moderator";
    h.change();
    await h.flush();
    h.change();
    assert.equal(ceiling(), 18);

    // View off.
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: false });
    await h.flush();
    assert.equal(ceiling(), 5);
});

test("Exam Mode receive set is unchanged by Phase D", async () => {
    const h = await teacherWith(30);

    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 1, enabled: true, participantIds: ["stud000", "stud007"] });

    const sent = h.lastSent();

    assert.deepEqual(Array.from(sent.selectedSources), ["stud000-v0", "stud007-v0"]);
    assert.equal(sent.lastN, 2);
    assert.deepEqual(Array.from(sent.onStageSources), []);
    assert.equal(sent.constraints["stud000-v0"].maxHeight, 360);
});

test("student role: constraints are the student view's, Phase D never runs", async () => {
    const h = createHarness();

    h.participants.local = { id: "student01", role: "participant", name: "Student" };
    h.addParticipant("teacher99", { role: "moderator" });
    ids(25).forEach(id => h.addParticipant(id));

    h.timers.advance(600);
    h.change();
    h.postFromParent({ type: "SL_STUDENT_VIEW", v: 1, epoch: 1, enabled: true });
    // A teacher view message must not activate anything for a student.
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 1, enabled: true });
    h.change();
    await h.flush();
    await h.run(5000);

    const sent = h.lastSent();

    assert.equal(h.rotation().isActive(), false);
    assert.deepEqual(Array.from(sent.selectedSources), ["teacher99-v0"]);
    assert.equal(h.receiveTest().limiterCeiling(), 5);
    assert.equal(h.timers.intervalsNamed("pollCpuLimiter"), 0);
});
