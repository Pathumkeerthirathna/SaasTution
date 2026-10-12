/*
 * Regression tests: requested receive quality for the teacher's student
 * cameras (deploy/jitsi/custom.js): 180 for List / Tiles, 360 for the student
 * enlarged in the Tiles view's side panel.
 *
 *   npm run test:jitsi
 *
 * These check the receiver constraints custom.js hands to a MOCK
 * lib-jitsi-meet (harness.cjs): the REQUESTED maximum height per source. They
 * do not show what the bridge forwards, which simulcast layer arrives, the
 * decoded resolution or the bitrate; that needs a real browser and bridge.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness, ids } = require("./harness.cjs");

// Requested maxHeight for a participant's camera in the last constraints
// sent, or null when the camera is not selected (not received at all).
function requested(h, participantId) {
    const sent = h.lastSent();
    const source = participantId + "-v0";

    return sent && Array.from(sent.selectedSources).includes(source)
        ? sent.constraints[source]?.maxHeight ?? null
        : null;
}

// Every selected source's requested height.
function heights(h) {
    const sent = h.lastSent();

    return Object.fromEntries(Array.from(sent.selectedSources).map(source => [source, sent.constraints[source]?.maxHeight]));
}

async function tilesTeacher(count, { pageSize = 20, setup } = {}) {
    const h = createHarness();
    const all = ids(count);

    all.forEach(id => h.addParticipant(id));

    if (setup) {
        setup(h);
    }

    await h.startTeacher();
    await h.sendTiles({ ids: all, pageSize });
    await h.run(1000);

    return { h, all };
}

async function openPanel(h, id) {
    h.teacherTest().tileClick(id);
    await h.flush();
    await h.flush();
}

async function closePanel(h) {
    h.teacherTest().closePanel();
    await h.flush();
    await h.flush();
}

// ---- List view ---------------------------------------------------------------------

test("List view: student cameras requested at 180; a pinned student keeps Jitsi's stage height", async () => {
    const h = createHarness();
    const all = ids(24);

    all.forEach(id => h.addParticipant(id));
    await h.startTeacher();
    await h.run(1000);

    const before = heights(h);
    const studentHeights = Object.entries(before).filter(([source]) => source.startsWith("stud"));

    assert.equal(studentHeights.length, 18);
    studentHeights.forEach(([source, height]) => assert.equal(height, 180, source));

    // List view click: Jitsi's pin (Phase C), unchanged: the stage height is
    // Jitsi's own (720 in the mock); no enlarged-panel height in List view.
    h.teacherTest().tileClick("stud003");
    await h.flush();

    assert.equal(h.rotation().getEnlarged(), null);
    assert.equal(requested(h, "stud003"), 720);
    Object.entries(heights(h))
        .filter(([source]) => source !== "stud003-v0")
        .forEach(([source, height]) => assert.equal(height, 180, source));
});

// ---- Tiles view ------------------------------------------------------------------

test("Tiles: tiles at 180; the enlarged student at 360, others unchanged", async () => {
    const { h, all } = await tilesTeacher(30, { pageSize: 30 });

    all.forEach(id => {
        const height = requested(h, id);

        assert.ok(height === 180 || height === null, `${id}: ${height}`);
    });

    // A student who is NOT live right now (rotated out).
    const waiting = all.find(id => requested(h, id) === null);

    assert.ok(waiting);
    await openPanel(h, waiting);

    assert.equal(h.rotation().getEnlarged(), waiting);
    assert.equal(requested(h, waiting), 360, "explicit enlarged height");
    all.filter(id => id !== waiting).forEach(id => {
        const height = requested(h, id);

        assert.ok(height === 180 || height === null, `${id}: ${height}`);
    });
});

test("Tiles: closing the panel restores 180 (live in its group) or 0 (not received)", async () => {
    const { h, all } = await tilesTeacher(30, { pageSize: 30 });
    const target = all[7];

    await openPanel(h, target);
    assert.equal(requested(h, target), 360);

    await closePanel(h);

    assert.equal(h.rotation().getEnlarged(), null);

    const after = requested(h, target);
    const live = h.rotation().isPlannedLive(target);

    assert.equal(after, live ? 180 : null, `after close: ${after}, planned live: ${live}`);
    assert.ok(!Object.values(heights(h)).includes(360), "no 360 left");
});

test("Tiles: the enlarged height holds while all of a page fits (no rotation)", async () => {
    const { h, all } = await tilesTeacher(10, { pageSize: 10 });

    await openPanel(h, all[4]);
    assert.equal(requested(h, all[4]), 360);
    all.filter(id => id !== all[4]).forEach(id => assert.equal(requested(h, id), 180));

    await closePanel(h);
    assert.equal(requested(h, all[4]), 180, "back to its tile height (all live)");
});

test("no intermediate request: Jitsi's stage height never reaches the enlarged camera on open or close", async () => {
    const { h, all } = await tilesTeacher(30, { pageSize: 30 });
    const target = all.find(id => requested(h, id) === null) || all[9];
    const heightIn = sent => sent.constraints?.[target + "-v0"]?.maxHeight;

    const beforeOpen = h.sent.length;

    await openPanel(h, target);
    h.sent.slice(beforeOpen).forEach((sent, index) =>
        assert.ok([undefined, 360].includes(heightIn(sent)), `open, send ${index}: ${heightIn(sent)}`));
    assert.equal(requested(h, target), 360);

    const beforeClose = h.sent.length;

    await closePanel(h);
    // 360 (unchanged) while the pin moves, then the tile height or nothing.
    h.sent.slice(beforeClose).forEach((sent, index) =>
        assert.ok([undefined, 360, 180].includes(heightIn(sent)), `close, send ${index}: ${heightIn(sent)}`));
    assert.ok([180, null].includes(requested(h, target)), String(requested(h, target)));
});

test("switching the panel straight to another student: the old one never gets Jitsi's stage height", async () => {
    const { h, all } = await tilesTeacher(30, { pageSize: 30 });
    const first = all[4];
    const second = all[20];

    await openPanel(h, first);
    assert.equal(requested(h, first), 360);

    const from = h.sent.length;

    await openPanel(h, second);

    h.sent.slice(from).forEach((sent, index) => {
        const height = sent.constraints?.[first + "-v0"]?.maxHeight;

        assert.ok([undefined, 360, 180].includes(height), `send ${index}: ${height}`);
    });
    assert.equal(h.rotation().getEnlarged(), second);
    assert.equal(requested(h, second), 360);
    assert.ok([180, null].includes(requested(h, first)), "the first student is a tile again");
});

// ---- prompt re-apply, screen share, teacher quality setting ---------------------

test("screen share on the stage: the enlarged student still gets 360, applied without a Jitsi recompute", async () => {
    let share = null;
    const { h, all } = await tilesTeacher(30, {
        pageSize: 30,
        setup: harness => { share = harness.addScreenShare("stud029", { staged: true }); }
    });

    // Jitsi staged the share (Phase C: shares first).
    assert.equal(h.participants.pinnedParticipant, share);
    assert.equal(h.lastSent().constraints[share].maxHeight, 720, "share at Jitsi's stage height");

    const recomputes = h.jitsiRecomputes;
    const sends = h.sent.length;

    await openPanel(h, all[3]);

    // The share keeps the stage (no pin change, so Jitsi itself recomputes
    // nothing); the policy is re-applied by custom.js at once.
    assert.equal(h.jitsiRecomputes, recomputes, "no Jitsi recompute needed");
    assert.ok(h.sent.length > sends, "constraints re-applied");
    assert.equal(h.participants.pinnedParticipant, share, "share keeps the stage");
    assert.equal(requested(h, all[3]), 360);
    assert.equal(h.lastSent().constraints[share].maxHeight, 720, "share quality unchanged");
    assert.equal(Array.from(h.lastSent().onStageSources)[0], share, "share keeps stage priority");

    const sendsBeforeClose = h.sent.length;

    await closePanel(h);
    assert.ok(h.sent.length > sendsBeforeClose, "re-applied on close");
    assert.ok(requested(h, all[3]) === 180 || requested(h, all[3]) === null);
    assert.equal(h.lastSent().constraints[share].maxHeight, 720);
});

test("an unstaged screen share keeps its 360 tile height with a panel open", async () => {
    let share = null;
    const { h, all } = await tilesTeacher(20, {
        pageSize: 20,
        setup: harness => { share = harness.addScreenShare("stud019"); }
    });

    await openPanel(h, all[2]);
    assert.equal(h.lastSent().constraints[share].maxHeight, 360);
    assert.equal(requested(h, all[2]), 360);
});

test("the teacher's video-quality setting does not override the enlarged 360", async () => {
    const { h, all } = await tilesTeacher(20, { pageSize: 20 });

    // Jitsi's own stage request capped low (teacher picked 180p) ...
    h.stageMaxHeight = 180;
    await openPanel(h, all[5]);
    assert.equal(h.participants.pinnedParticipant, all[5], "pinned: Jitsi asks for its stage height");
    assert.equal(requested(h, all[5]), 360);

    // ... or high (1080p).
    h.stageMaxHeight = 1080;
    h.change();
    await h.flush();
    assert.equal(requested(h, all[5]), 360);
});

// ---- missing, camera-off, disconnected, stale -----------------------------------

test("camera off: never Jitsi's stage height; camera back on: 360 at once", async () => {
    const { h, all } = await tilesTeacher(20, { pageSize: 20 });
    const target = all[6];

    await openPanel(h, target);
    assert.equal(requested(h, target), 360);

    const from = h.sent.length;

    h.setCamera(target, false);
    h.change();
    await h.flush();

    // Still pinned, so Jitsi keeps the (muted) camera on its stage; the
    // request stays the enlarged 360 (nothing is sent while it is off).
    assert.equal(h.tilesState().panel.state, "off");
    assert.equal(h.rotation().getEnlarged(), target);
    assert.ok([360, null].includes(requested(h, target)), String(requested(h, target)));

    h.setCamera(target, true);
    h.change();
    await h.flush();
    assert.equal(requested(h, target), 360);

    h.sent.slice(from).forEach((sent, index) => {
        const height = sent.constraints?.[target + "-v0"]?.maxHeight;

        assert.ok(height === undefined || height === 360, `send ${index}: ${height}`);
    });
});

test("disconnected and stale enlarged students: no 360 for anyone", async () => {
    const { h, all } = await tilesTeacher(20, { pageSize: 20 });
    const target = all[8];

    await openPanel(h, target);
    h.removeParticipant(target);
    h.change();
    await h.flush();

    assert.equal(h.tilesState().panel.state, "disconnected");
    assert.equal(h.rotation().getEnlarged(), null);
    assert.ok(!Object.values(heights(h)).includes(360), "nothing at 360");

    // The student rejoins with a new participant ID: the panel still shows
    // the old (stale) ID, which is not given anything; the new ID is a tile.
    h.addParticipant("rejoin08");
    await h.sendTiles({ ids: all.map(id => (id === target ? "rejoin08" : id)), pageSize: 20 });
    await h.run(1000);

    assert.ok(!Object.values(heights(h)).includes(360));
    assert.ok(requested(h, "rejoin08") === 180 || requested(h, "rejoin08") === null);

    await closePanel(h);
    assert.equal(h.tilesState().panel.open, false);
});

test("an enlarged ID that is not in the meeting is ignored by the receive policy", async () => {
    const { h, all } = await tilesTeacher(20, { pageSize: 20 });
    const before = heights(h);

    h.rotation().setEnlarged("ghost001");
    await h.flush();

    assert.deepEqual(heights(h), before);
    assert.ok(all.every(id => requested(h, id) === 180 || requested(h, id) === null));
});

// ---- co-teachers, Exam Mode ---------------------------------------------------------

test("co-teacher cameras stay at 180 with a panel open", async () => {
    const { h, all } = await tilesTeacher(20, {
        pageSize: 20,
        setup: harness => harness.addParticipant("coteach1", { role: "moderator" })
    });

    await openPanel(h, all[1]);
    assert.equal(requested(h, "coteach1"), 180);
    assert.equal(requested(h, all[1]), 360);
});

test("Exam Mode: identical constraints with or without a panel open, and the panel ends", async () => {
    const examOf = async withPanel => {
        const { h, all } = await tilesTeacher(30, { pageSize: 20 });

        if (withPanel) {
            await openPanel(h, all[2]);
            assert.equal(requested(h, all[2]), 360);
        }

        h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 1, enabled: true, participantIds: all.slice(0, 5) });
        h.postFromParent({ type: "SL_MONITOR_VIEW", v: 1, epoch: 1, enabled: true, participantIds: all.slice(0, 5) });
        h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: false });
        await h.flush();
        await h.flush();

        return { h, all, sent: h.lastSent() };
    };

    const plain = await examOf(false);
    const withPanel = await examOf(true);
    const shape = sent => ({
        lastN: sent.lastN,
        selected: Array.from(sent.selectedSources),
        onStage: Array.from(sent.onStageSources),
        heights: Object.fromEntries(Object.entries(sent.constraints).map(([source, value]) => [source, value.maxHeight]))
    });

    assert.deepEqual(shape(withPanel.sent), shape(plain.sent));
    assert.deepEqual(Object.values(shape(withPanel.sent).heights), [360, 360, 360, 360, 360], "Exam Mode's own 360");
    assert.equal(withPanel.h.rotation().getEnlarged(), null);

    // Back to Normal (Tiles): the panel is gone; no enlarged height.
    const { h } = withPanel;

    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 2, enabled: false, participantIds: [] });
    h.postFromParent({ type: "SL_MONITOR_VIEW", v: 1, epoch: 2, enabled: false, participantIds: [] });
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 3, enabled: true });
    h.change();
    await h.run(1000);

    assert.equal(h.tilesState().panel.open, false);
    assert.ok(!Object.values(heights(h)).includes(360));
});

test("view off (or a role change) clears the enlarged camera", async () => {
    const { h, all } = await tilesTeacher(20, { pageSize: 20 });

    await openPanel(h, all[3]);
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: false });
    await h.flush();

    assert.equal(h.rotation().getEnlarged(), null);
    assert.equal(h.rotation().isActive(), false);
});
