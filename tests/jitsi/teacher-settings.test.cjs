/*
 * Regression tests: the teacher's View / filmstrip settings menu in the Jitsi
 * view (deploy/jitsi/custom.js): List / Tiles and Tiles per page next to the
 * filmstrip position and auto-hide.
 *
 *   npm run test:jitsi
 *
 * The menu only REQUESTS View / page size changes from the parent page
 * (SL_TEACHER_TILES_SETTINGS); the parent page (useTeacherTiles) owns them and
 * answers with SL_TEACHER_TILES, simulated here with harness.sendTiles. The
 * parent-side handling (useJitsi.ts / JitsiClassroom.tsx) is not run here.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness, ids } = require("./harness.cjs");

const settingsPosts = h => h.posted.filter(message => message.type === "SL_TEACHER_TILES_SETTINGS");
const layoutPosts = h => h.posted.filter(message => message.type === "SL_TEACHER_LAYOUT");

async function teacher(count = 40) {
    const h = createHarness();
    const all = ids(count);

    all.forEach(id => h.addParticipant(id));
    await h.startTeacher();
    await h.run(1000);

    return { h, all, menu: () => h.teacherTest().settingsMenu() };
}

async function step(h) {
    await h.flush();
    await h.flush();
}

test("default: before the parent page sends a view, the menu shows List (no page sizes)", async () => {
    const { h, menu } = await teacher();

    h.teacherTest().openSettings();

    const state = menu();

    assert.equal(h.tilesState().layout, "list");
    assert.equal(state.place, "filmstrip");
    assert.equal(state.view, "list");
    assert.equal(state.pageSizesShown, false);
});

test("List view: the menu opens from the filmstrip with View, and no page sizes", async () => {
    const { h, menu } = await teacher();

    // The parent page's first message: List, page size 20.
    await h.sendTiles({ layout: "list", ids: ids(40), pageSize: 20 });
    h.teacherTest().openSettings();

    const state = menu();

    assert.equal(state.open, true);
    assert.equal(state.place, "filmstrip");
    assert.equal(state.view, "list");
    assert.equal(state.pageSizesShown, false, "page sizes hidden in List");
    assert.equal(state.position, "right", "filmstrip position still shown");
    assert.equal(state.expanded.filmstrip, "true");
});

test("choosing Tiles asks the parent page; the menu follows its answer into the grid bar", async () => {
    const { h, menu, all } = await teacher();

    await h.sendTiles({ layout: "list", ids: all, pageSize: 20 });
    h.teacherTest().openSettings();
    h.teacherTest().chooseView("tiles");

    assert.deepEqual(settingsPosts(h).map(message => ({ ...message })), [{ type: "SL_TEACHER_TILES_SETTINGS", v: 1, layout: "tiles" }]);
    assert.equal(menu().view, "list", "nothing changes until the parent page answers");

    // The parent page's answer (its existing state: page size 30).
    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 30 });
    await step(h);

    const state = menu();

    assert.equal(state.open, true, "still open after the switch");
    assert.equal(state.place, "grid", "moved to the grid bar (the filmstrip is hidden in Tiles)");
    assert.equal(state.view, "tiles");
    assert.equal(state.pageSizesShown, true);
    assert.equal(state.pageSize, 30);
    assert.deepEqual({ ...state.expanded }, { filmstrip: "false", grid: "true" });
});

test("Tiles per page: every size is offered and sent to the parent page; the current one is marked", async () => {
    const { h, menu, all } = await teacher(60);

    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });
    h.teacherTest().openSettings();
    assert.equal(menu().place, "grid");

    for (const size of [10, 30, 40, 50]) {
        h.teacherTest().choosePageSize(size);
    }

    // The current size again: nothing to ask.
    h.teacherTest().choosePageSize(20);

    assert.deepEqual(settingsPosts(h).map(message => message.pageSize), [10, 30, 40, 50]);

    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 50 });
    await step(h);
    assert.equal(menu().pageSize, 50);
    assert.equal(h.tilesState().rendered.length, 50, "the grid follows the parent page's page");
});

test("back to List from the grid bar: the menu returns to the filmstrip, page sizes hidden", async () => {
    const { h, menu, all } = await teacher();

    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });
    h.teacherTest().openSettings();
    h.teacherTest().chooseView("list");
    assert.equal(settingsPosts(h).at(-1).layout, "list");

    await h.sendTiles({ layout: "list", ids: all, pageSize: 20 });
    await step(h);

    const state = menu();

    assert.equal(state.place, "filmstrip");
    assert.equal(state.view, "list");
    assert.equal(state.pageSizesShown, false);
});

test("filmstrip position and auto-hide still work from the menu, in both views", async () => {
    const { h, menu, all } = await teacher();

    await h.sendTiles({ layout: "list", ids: all, pageSize: 20 });
    h.teacherTest().openSettings();
    h.teacherTest().choosePosition("left");

    assert.equal(h.teacherTest().layout().preferred, "left");
    assert.deepEqual({ ...layoutPosts(h).at(-1) }, { type: "SL_TEACHER_LAYOUT", v: 1, position: "left", autoHide: false });

    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });
    h.teacherTest().openSettings();
    h.teacherTest().toggleAutoHide();

    assert.equal(menu().autoHide, true);
    assert.deepEqual({ ...layoutPosts(h).at(-1) }, { type: "SL_TEACHER_LAYOUT", v: 1, position: "left", autoHide: true });

    h.teacherTest().choosePosition("bottom");
    assert.equal(h.teacherTest().layout().preferred, "bottom");
});

test("Escape closes the menu wherever it is", async () => {
    const { h, menu, all } = await teacher();

    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });
    h.teacherTest().openSettings();
    assert.equal(menu().open, true);

    (h.document.listeners.keydown || []).slice().forEach(fn => fn({ key: "Escape", preventDefault() {} }));

    assert.equal(menu().open, false);
    assert.equal(menu().expanded.grid, "false");
});

test("a malformed page size is ignored; a parent page without one is still accepted", async () => {
    const { h, menu, all } = await teacher();

    h.postFromParent({
        type: "SL_TEACHER_TILES", v: 1, epoch: 50, layout: "tiles", participantIds: all.slice(0, 20),
        page: 1, pageCount: 2, rangeStart: 1, rangeEnd: 20, total: 40, pageSize: 25
    });
    await step(h);
    assert.equal(h.tilesState().layout, "list", "pageSize 25 rejected");

    h.postFromParent({
        type: "SL_TEACHER_TILES", v: 1, epoch: 51, layout: "tiles", participantIds: all.slice(0, 20),
        page: 1, pageCount: 2, rangeStart: 1, rangeEnd: 20, total: 40
    });
    await step(h);
    h.teacherTest().openSettings();

    assert.equal(h.tilesState().layout, "tiles");
    assert.equal(menu().pageSize, null, "no size marked when none was sent");
});

test("Exam Mode hides the view and closes the menu; camera policy unchanged", async () => {
    const { h, menu, all } = await teacher();

    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });
    h.teacherTest().openSettings();

    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 1, enabled: true, participantIds: all.slice(0, 10) });
    h.postFromParent({ type: "SL_MONITOR_VIEW", v: 1, epoch: 1, enabled: true, participantIds: all.slice(0, 10) });
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: false });
    await step(h);

    assert.equal(menu().open, false);

    const sent = h.lastSent();

    assert.equal(sent.lastN, 10);
    Array.from(sent.selectedSources).forEach(source => assert.equal(sent.constraints[source].maxHeight, 360));
});
