/*
 * Regression tests: the teacher's student-camera budget is respected in EVERY
 * receiver-constraints send (deploy/jitsi/custom.js), including the sends in
 * between while the panel opens, closes or switches student, when the pin
 * moves and Jitsi's own stage list is briefly out of date.
 *
 *   npm run test:jitsi
 *
 * Against a MOCK lib-jitsi-meet (harness.cjs): these check the REQUESTED
 * sources, not what the bridge forwards or what the students publish.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness, ids } = require("./harness.cjs");

const isStudentCamera = source => /^(stud\d{3}|rejoin\d+)-v0$/.test(source);

// Student cameras a send asks for: selected or on the stage (both forward).
function studentCameras(sent) {
    const sources = new Set([...Array.from(sent.selectedSources || []), ...Array.from(sent.onStageSources || [])]);

    return [...sources].filter(isStudentCamera);
}

// Records every send from now on; check(limit) fails if any send asked for
// more student cameras than `limit`.
function watchSends(h) {
    const records = [];

    h.onSend.push(sent => {
        records.push({ index: h.sent.length - 1, cameras: studentCameras(sent), sent });
    });

    return {
        records,
        mark: () => records.length,
        over(limit, from = 0) {
            return records.slice(from)
                .filter(record => record.cameras.length > limit)
                .map(record => `send ${record.index}: ${record.cameras.length} student cameras`);
        }
    };
}

async function tilesTeacher({ total = 100, pageSize = 50, pageIndex = 0, setup } = {}) {
    const h = createHarness();
    const all = ids(total);

    all.forEach(id => h.addParticipant(id));

    if (setup) {
        setup(h, all);
    }

    await h.startTeacher();
    await h.sendTiles({ ids: all, pageSize, pageIndex });
    await h.run(1000);

    return { h, all };
}

async function step(h) {
    await h.flush();
    await h.flush();
}

const heightOf = (sent, id) => sent.constraints?.[id + "-v0"]?.maxHeight;

// ---- Tiles view ----------------------------------------------------------------

test("every send stays within 18 student cameras: open, close and switch the panel (page 50)", async () => {
    const { h, all } = await tilesTeacher();
    const sends = watchSends(h);

    // Rotated-out students, so opening them really changes the plan.
    const waiting = all.slice(0, 50).filter(id => !h.rotation().isPlannedLive(id));

    for (let round = 0; round < 3; round++) {
        h.teacherTest().tileClick(waiting[round]);
        await step(h);
        assert.equal(heightOf(h.lastSent(), waiting[round]), 360, "enlarged at 360");

        await h.run(12000);

        h.teacherTest().tileClick(waiting[round + 5]);
        await step(h);
        assert.equal(heightOf(h.lastSent(), waiting[round + 5]), 360, "switched: new student at 360");

        await h.run(12000);

        h.teacherTest().closePanel();
        await step(h);
        await h.run(12000);
    }

    assert.ok(sends.records.length > 10, `${sends.records.length} sends inspected`);
    assert.deepEqual(sends.over(18), []);
});

test("the old close transient (19 cameras for two sends) no longer happens", async () => {
    const { h } = await tilesTeacher();

    h.teacherTest().tileClick("stud030");
    await step(h);
    await h.run(6000);

    const sends = watchSends(h);

    h.teacherTest().closePanel();
    await step(h);

    assert.ok(sends.records.length >= 2, "the close re-applied constraints");
    sends.records.forEach(record =>
        assert.ok(record.cameras.length <= 18, `send ${record.index}: ${record.cameras.length}`));
    // A closed student is not requested at Jitsi's stage height either.
    sends.records.forEach(record =>
        assert.ok([undefined, 360, 180].includes(heightOf(record.sent, "stud030")), String(heightOf(record.sent, "stud030"))));
});

test("staged screen share: the share keeps the stage; enlarged at 360; every send within 18", async () => {
    let share = null;
    const { h, all } = await tilesTeacher({
        setup: harness => { share = harness.addScreenShare("stud099", { staged: true }); }
    });
    const sends = watchSends(h);

    h.teacherTest().tileClick(all[3]);
    await step(h);

    let sent = h.lastSent();

    assert.deepEqual(Array.from(sent.onStageSources), [share], "the share keeps stage priority");
    assert.equal(sent.constraints[share].maxHeight, 720, "share at Jitsi's stage height");
    assert.equal(heightOf(sent, all[3]), 360, "enlarged at 360 during the share");

    h.teacherTest().tileClick(all[27]);
    await step(h);
    sent = h.lastSent();
    assert.equal(heightOf(sent, all[27]), 360);
    assert.deepEqual(Array.from(sent.onStageSources), [share]);

    h.teacherTest().closePanel();
    await step(h);
    await h.run(12000);

    assert.deepEqual(Array.from(h.lastSent().onStageSources), [share]);
    assert.deepEqual(sends.over(18), []);
});

test("co-teachers and screen shares stay outside the 18 and keep their place", async () => {
    let share = null;
    const { h, all } = await tilesTeacher({
        setup: harness => {
            harness.addParticipant("coteachA", { role: "moderator" });
            harness.addParticipant("coteachB", { role: "moderator" });
            share = harness.addScreenShare("stud010");
        }
    });
    const sends = watchSends(h);

    h.teacherTest().tileClick(all[12]);
    await step(h);
    await h.run(12000);
    h.teacherTest().closePanel();
    await step(h);

    sends.records.forEach(record => {
        const selected = Array.from(record.sent.selectedSources);

        assert.ok(selected.includes("coteachA-v0") && selected.includes("coteachB-v0"), `send ${record.index}: co-teachers`);
        assert.ok(selected.includes(share), `send ${record.index}: share`);
        assert.equal(record.sent.constraints.coteachA_v0, undefined);
        assert.equal(record.sent.constraints["coteachA-v0"].maxHeight, 180);
        assert.equal(record.sent.constraints[share].maxHeight, 360);
    });
    assert.deepEqual(sends.over(18), []);
    // The teacher's own camera is never part of what is received.
    sends.records.forEach(record =>
        assert.ok(!Array.from(record.sent.selectedSources).some(source => source.startsWith("teacher01"))));
});

test("CPU limiter: every send within the limited budget while the panel opens, closes and switches", async () => {
    const { h, all } = await tilesTeacher();

    h.controller.limited = true;
    h.controller.limitedLastN = 9;
    await h.run(3000);
    assert.equal(h.rotation().getCpuCameraBudget(), 9);

    const sends = watchSends(h);

    h.teacherTest().tileClick(all[40]);
    await step(h);
    assert.equal(heightOf(h.lastSent(), all[40]), 360);
    await h.run(12000);
    h.teacherTest().tileClick(all[8]);
    await step(h);
    await h.run(12000);
    h.teacherTest().closePanel();
    await step(h);
    await h.run(12000);

    assert.ok(sends.records.length > 3);
    assert.deepEqual(sends.over(9), [], "never above the limiter's budget");
});

test("page 10 with a selected student from another page: 11 at most, nothing else off the page", async () => {
    const { h, all } = await tilesTeacher({ pageSize: 10 });

    await h.sendTiles({ ids: all, pageSize: 10, pageIndex: 6 });
    h.teacherTest().tileClick(all[64]);
    await step(h);

    const sends = watchSends(h);

    await h.sendTiles({ ids: all, pageSize: 10, pageIndex: 0 });
    await h.run(20000);

    const allowed = new Set([...all.slice(0, 10), all[64]].map(id => id + "-v0"));

    sends.records.forEach(record => {
        record.cameras.forEach(source => assert.ok(allowed.has(source), `send ${record.index}: ${source}`));
        assert.ok(record.cameras.length <= 11);
    });
    assert.equal(heightOf(h.lastSent(), all[64]), 360);
});

// ---- List view (stage behaviour unchanged) ----------------------------------

test("List view: a pinned student keeps the stage and Jitsi's height; pin, switch and unpin stay within 18", async () => {
    const h = createHarness();
    const all = ids(40);

    all.forEach(id => h.addParticipant(id));
    await h.startTeacher();
    await h.run(1000);

    const sends = watchSends(h);
    // A student not received right now: the pin must still put them on stage.
    const target = all.find(id => !h.rotation().isPlannedLive(id));

    h.teacherTest().tileClick(target);
    await step(h);

    let sent = h.lastSent();

    assert.deepEqual(Array.from(sent.onStageSources), [target + "-v0"], "pinned student on the stage");
    assert.equal(heightOf(sent, target), 720, "Jitsi's stage height (List view unchanged)");

    const other = all.find(id => id !== target && !h.rotation().isPlannedLive(id));

    h.teacherTest().tileClick(other);
    await step(h);
    sent = h.lastSent();
    assert.deepEqual(Array.from(sent.onStageSources), [other + "-v0"]);

    // Clicking the selected tile again unpins (back to the teacher).
    h.teacherTest().tileClick(other);
    await step(h);
    await h.run(10000);

    assert.deepEqual(Array.from(h.lastSent().onStageSources), []);
    assert.deepEqual(sends.over(18), []);
});

test("an unplanned student camera on Jitsi's stage is not received", async () => {
    const { h, all } = await tilesTeacher();
    const outsider = all[90];

    // Jitsi's own request names a student who is not planned (not on the
    // page, not selected), e.g. an out-of-date stage list.
    h.jitsiRecompute({
        onStageSources: [outsider + "-v0"],
        constraints: { [outsider + "-v0"]: { maxHeight: 720 } }
    });

    const sent = h.lastSent();

    assert.ok(!studentCameras(sent).includes(outsider + "-v0"));
    assert.ok(studentCameras(sent).length <= 18);
});

test("Jitsi recomputing BEFORE the view renders: a new List pin is on the stage at once", async () => {
    const h = createHarness({ jitsiRecomputesFirst: true });
    const all = ids(40);

    all.forEach(id => h.addParticipant(id));
    await h.startTeacher();
    await h.run(1000);

    const target = all.find(id => !h.rotation().isPlannedLive(id));
    const from = h.sent.length;

    h.teacherTest().tileClick(target);

    // The very first send after the pin (Jitsi's own recompute) already
    // has the selected student on the stage: not filtered as unplanned.
    const first = h.sent[from];

    assert.ok(first, "a send after the pin");
    assert.deepEqual(Array.from(first.onStageSources), [target + "-v0"]);
    assert.ok(studentCameras(first).length <= 18);
});

test("Jitsi recomputing BEFORE the view renders: an enlarged student is at 360 in every send", async () => {
    const h = createHarness({ jitsiRecomputesFirst: true });
    const all = ids(100);

    all.forEach(id => h.addParticipant(id));
    await h.startTeacher();
    await h.sendTiles({ ids: all, pageSize: 50 });
    await h.run(1000);

    const target = all.slice(0, 50).find(id => !h.rotation().isPlannedLive(id));
    const sends = watchSends(h);

    h.teacherTest().tileClick(target);
    await step(h);

    const withTarget = sends.records.filter(record => heightOf(record.sent, target) !== undefined);

    assert.ok(withTarget.length > 0);
    withTarget.forEach(record => assert.equal(heightOf(record.sent, target), 360, `send ${record.index}`));
    assert.ok(Array.from(h.lastSent().onStageSources).includes(target + "-v0"), "on Jitsi's stage (pinned)");
    assert.deepEqual(sends.over(18), []);

    h.teacherTest().closePanel();
    await step(h);
    assert.deepEqual(sends.over(18), []);
});

// ---- Exam Mode -----------------------------------------------------------------

test("Exam Mode keeps its own request (stage list not filtered there)", async () => {
    const { h, all } = await tilesTeacher({ pageSize: 20 });

    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 1, enabled: true, participantIds: all.slice(0, 20) });
    h.postFromParent({ type: "SL_MONITOR_VIEW", v: 1, epoch: 1, enabled: true, participantIds: all.slice(0, 20) });
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: false });
    await step(h);

    const sent = h.lastSent();

    assert.equal(sent.lastN, 20);
    assert.equal(studentCameras(sent).length, 20, "Exam Mode's page of 20, no 18 cap (unchanged)");
    assert.deepEqual(Array.from(sent.onStageSources), []);
    Array.from(sent.selectedSources).forEach(source => assert.equal(sent.constraints[source].maxHeight, 360));
});
