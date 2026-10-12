/*
 * Regression tests: teacher Tiles view (deploy/jitsi/custom.js +
 * components/Jitsi/teacher-tiles-paging.mjs).
 *
 *   npm run test:jitsi
 *
 * Run the real custom.js against a MOCK Jitsi store, receive controller and
 * bridge (harness.cjs), and the app's real paging module. They check
 * custom.js's own logic; they do not verify production Jitsi / lib-jitsi-meet
 * / JVB behaviour or real browser layout.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");

const { createHarness, createScheduler, ids, loadPaging } = require("./harness.cjs");

// ---- helpers -----------------------------------------------------------------

const PAGE_SIZES = [10, 20, 30, 40, 50];

// The real slSpatialOrder / slPartitionGroups from custom.js.
function pureFunctions() {
    const h = createHarness();

    return {
        spatialOrder: entries => vm.runInContext("slSpatialOrder", h.ctx)(entries),
        partition: (list, count) => vm.runInContext("slPartitionGroups", h.ctx)(list, count)
    };
}

// Grid rectangles for ids laid out left to right in `columns` columns.
function gridEntries(list, columns, width = 100, height = 56) {
    return list.map((id, index) => ({
        id,
        left: (index % columns) * (width + 8),
        top: Math.floor(index / columns) * (height + 8),
        width,
        height
    }));
}

// Group mode on the scheduler alone: page = ids, reading order = order.
function groupScheduler(count, { order } = {}) {
    const sched = createScheduler();
    const students = ids(count);
    const state = sched.stateFor(students);

    sched.rotation.setLayout({ scope: students, order: order || students });
    sched.rotation.update(state);

    return { sched, students, state };
}

// Runs sub-ticks, checking one live member per group and the per-tick swap
// limit; returns the longest wait (sub-ticks) and students never live.
function runGroupTicks(sched, students, ticks, perTick) {
    const { rotation } = sched;
    const lastLive = new Map(students.map(id => [id, 0]));
    const neverLive = new Set(students);
    const failures = [];
    let maxWait = 0;
    let maxSwaps = 0;

    for (let tick = 1; tick <= ticks; tick++) {
        const excluded = perTick ? perTick(tick) || [] : [];
        const before = new Set(rotation.stats().live);

        rotation.subtick();

        const stats = rotation.stats();
        const swaps = stats.live.filter(id => !before.has(id)).length;

        maxSwaps = Math.max(maxSwaps, swaps);

        if (stats.rotating) {
            stats.groupMembers.forEach((members, index) => {
                const liveCount = members.filter(id => rotation.isPlannedLive(id)).length;

                if (liveCount !== 1) {
                    failures.push(`tick ${tick}: group ${index} has ${liveCount} live`);
                }
            });

            if (swaps > Math.max(stats.groupAdvancesPerTick, 1) && !perTick) {
                failures.push(`tick ${tick}: ${swaps} swaps (limit ${stats.groupAdvancesPerTick})`);
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

    return { maxWait, maxSwaps, neverLive, failures };
}

async function teacherWithTiles(count, { pageSize = 20, pageIndex = 0, options } = {}) {
    const h = createHarness(options);
    const all = ids(count);

    all.forEach(id => h.addParticipant(id));
    await h.startTeacher();
    await h.sendTiles({ ids: all, pageSize, pageIndex });
    await h.run(1000);

    return { h, all };
}

// ---- paging (the app's module) ----------------------------------------------------

test("paging: the five page sizes, 100 students at 50 per page = 2 pages", async () => {
    const paging = await loadPaging();
    const all = ids(100);

    assert.deepEqual([...paging.TEACHER_TILES_PAGE_SIZES], PAGE_SIZES);

    PAGE_SIZES.forEach(size => {
        const first = paging.computeTilesPage({ ids: all, pageSize: size, requestedPageIndex: 0 });

        assert.equal(first.pageIds.length, size);
        assert.equal(first.pageCount, Math.ceil(100 / size));
        assert.deepEqual(first.pageIds, all.slice(0, size), "roster order kept");
    });

    const second = paging.computeTilesPage({ ids: all, pageSize: 50, requestedPageIndex: 1 });

    assert.equal(second.pageCount, 2);
    assert.equal(second.page, 2);
    assert.deepEqual(second.pageIds, all.slice(50));
    assert.equal(second.rangeStart, 51);
    assert.equal(second.rangeEnd, 100);
});

test("paging: past the end is clamped; a size change keeps the first student shown", async () => {
    const paging = await loadPaging();
    const all = ids(45);

    const clamped = paging.computeTilesPage({ ids: all, pageSize: 20, requestedPageIndex: 9 });

    assert.equal(clamped.page, 3);
    assert.deepEqual(clamped.pageIds, all.slice(40));

    // Page 3 at 10 per page starts at student 21: at 20 per page that is page 2.
    assert.equal(paging.pageIndexAfterPageSizeChange(2, 10, 20), 1);
    assert.equal(paging.pageIndexAfterPageSizeChange(1, 50, 10), 5);
    assert.equal(paging.computeTilesPage({ ids: [], pageSize: 10, requestedPageIndex: 0 }).page, 0);
    assert.equal(paging.isTeacherTilesPageSize(25), false);
    assert.equal(paging.computeTilesPage({ ids: all, pageSize: 25, requestedPageIndex: 0 }).pageIds.length, 20,
        "an invalid size falls back to the default (20)");
});

// ---- spatial grouping (pure functions) -------------------------------------------

test("spatial order: rows from measured positions, serpentine, not participant IDs", () => {
    const { spatialOrder } = pureFunctions();
    // Participant IDs deliberately unrelated to screen position.
    const onScreen = ["zz9", "aa1", "mm5", "bb2", "yy8", "cc3", "xx7", "dd4"];
    const result = spatialOrder(gridEntries(onScreen, 4).reverse());

    assert.equal(result.rows, 2);
    assert.equal(result.columns, 4);
    // Row 1 left to right, row 2 right to left.
    assert.deepEqual(Array.from(result.order), ["zz9", "aa1", "mm5", "bb2", "dd4", "xx7", "cc3", "yy8"]);
});

test("spatial order follows the responsive column count", () => {
    const { spatialOrder } = pureFunctions();
    const list = ids(12);

    const wide = spatialOrder(gridEntries(list, 6));
    const narrow = spatialOrder(gridEntries(list, 3));

    assert.equal(wide.columns, 6);
    assert.equal(narrow.columns, 3);
    assert.deepEqual(Array.from(wide.order).slice(0, 8), [...list.slice(0, 6), "stud011", "stud010"]);
    assert.deepEqual(Array.from(narrow.order).slice(0, 6), ["stud000", "stud001", "stud002", "stud005", "stud004", "stud003"]);
    // Unmeasured (zero-size) tiles go last, in their given order.
    const partial = spatialOrder([{ id: "late", left: 0, top: 0, width: 0, height: 0 }, ...gridEntries(list.slice(0, 2), 2)]);

    assert.deepEqual(Array.from(partial.order), ["stud000", "stud001", "late"]);
});

test("partition: about 18 contiguous groups of 2-3 for 50; singles when all fit", () => {
    const { partition } = pureFunctions();
    const sizes = (count, slots) => Array.from(partition(ids(count), slots)).map(group => group.length);

    assert.deepEqual(sizes(50, 18), [...Array(14).fill(3), ...Array(4).fill(2)]);
    assert.deepEqual(sizes(20, 18), [2, 2, ...Array(16).fill(1)]);
    assert.deepEqual(sizes(30, 18), [...Array(12).fill(2), ...Array(6).fill(1)]);
    assert.deepEqual(sizes(40, 18), [3, 3, 3, 3, ...Array(14).fill(2)]);
    assert.deepEqual(sizes(10, 18), Array(10).fill(1));

    const groups = partition(ids(50), 18);

    assert.deepEqual(Array.from(groups[0]), ["stud000", "stud001", "stud002"], "students 1-3 share a slot");
    assert.deepEqual(Array.from(groups[1]), ["stud003", "stud004", "stud005"]);
    assert.deepEqual(Array.from(groups.flat()), ids(50), "every student in exactly one group, in order");
});

// ---- group scheduling (scheduler alone) ------------------------------------------

test("page sizes: live and out-of-window counts, no rotation when all fit", () => {
    const expected = { 10: [10, 0], 20: [18, 2], 30: [18, 12], 40: [18, 22], 50: [18, 32] };

    PAGE_SIZES.forEach(size => {
        const { sched, students } = groupScheduler(size);
        const stats = sched.rotation.stats();
        const liveCount = students.filter(id => sched.rotation.isPlannedLive(id)).length;

        assert.equal(stats.mode, "tiles");
        assert.equal(liveCount, expected[size][0], `page ${size}: live`);
        assert.equal(size - liveCount, expected[size][1], `page ${size}: outside the live set`);
        assert.equal(stats.rotating, size > 18, `page ${size}: rotation only over budget`);
    });
});

test("fair rotation inside nearby groups: one live per group, staggered, nobody starved", () => {
    [20, 30, 40, 50].forEach(size => {
        const { sched, students } = groupScheduler(size);
        const result = runGroupTicks(sched, students, 240);
        const stats = sched.rotation.stats();
        const largest = Math.max(...stats.groupMembers.map(group => group.length));

        assert.deepEqual(result.failures, [], `page ${size}`);
        assert.deepEqual([...result.neverLive], [], `page ${size}: everyone gets live time`);
        assert.ok(result.maxSwaps < 18 && result.maxSwaps <= stats.groupAdvancesPerTick,
            `page ${size}: ${result.maxSwaps} swaps per tick`);
        // Each group advances about every 3 ticks (15 s): a member of a group
        // of n waits about (n - 1) * 3 ticks.
        assert.ok(result.maxWait <= (largest - 1) * 3 + 2, `page ${size}: max wait ${result.maxWait} ticks`);
    });
});

test("the live student rotates inside each group (students 1-3 share one slot)", () => {
    const { sched } = groupScheduler(50);
    const firstGroup = sched.rotation.stats().groupMembers[0];
    const seen = new Set();

    for (let tick = 0; tick < 30; tick++) {
        firstGroup.filter(id => sched.rotation.isPlannedLive(id)).forEach(id => seen.add(id));
        sched.rotation.subtick();
    }

    assert.deepEqual(Array.from(firstGroup), ["stud000", "stud001", "stud002"]);
    assert.deepEqual([...seen].sort(), ["stud000", "stud001", "stud002"]);
});

test("groups follow the given screen order, not participant IDs", () => {
    const students = ids(50);
    // A screen order unrelated to the IDs (e.g. the measured serpentine).
    const order = students.slice().reverse();
    const { sched } = groupScheduler(50, { order });
    const groups = sched.rotation.stats().groupMembers;

    assert.deepEqual(Array.from(groups[0]), ["stud049", "stud048", "stud047"]);
    assert.deepEqual(Array.from(groups.flat()), order);
});

test("CPU budget changes in Tiles view: regrouped, credit kept, nobody starved", () => {
    const { sched, students, state } = groupScheduler(50);
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    const result = runGroupTicks(sched, students, 600, tick => {
        if (tick % 3 === 0) {
            const budget = 4 + Math.floor(random() * 15);

            sched.setBudget(budget >= 18 ? null : budget, state);
        }
    });

    assert.deepEqual(result.failures, []);
    assert.deepEqual([...result.neverLive], []);

    sched.setBudget(9, state);
    assert.equal(sched.rotation.stats().groupMembers.length, 9);
    assert.equal(students.filter(id => sched.rotation.isPlannedLive(id)).length, 9);
});

test("selection in Tiles view: priority live, 17 groups, toggling cannot starve", () => {
    const { sched, students, state } = groupScheduler(50);

    sched.rotation.setPriority(["stud020"]);
    sched.rotation.update(state);
    assert.equal(sched.rotation.stats().groupMembers.length, 17);

    const result = runGroupTicks(sched, students, 400, tick => {
        sched.rotation.setPriority(tick % 4 < 2 ? ["stud020"] : []);
        sched.rotation.update(state);

        if (tick % 4 < 2) {
            assert.ok(sched.rotation.isPlannedLive("stud020"));
        }

        return ["stud020"];
    });

    assert.deepEqual(result.failures, []);
    assert.deepEqual([...result.neverLive], []);
});

test("page changes keep waiting credit (no reset)", () => {
    const sched = createScheduler();
    const all = ids(100);
    const state = sched.stateFor(all);
    const pageA = all.slice(0, 50);
    const pageB = all.slice(50);

    sched.rotation.setLayout({ scope: pageA, order: pageA });
    sched.rotation.update(state);

    for (let tick = 0; tick < 6; tick++) {
        sched.rotation.subtick();
    }

    const waitingOnA = sched.rotation.stats().waiting;

    sched.rotation.setLayout({ scope: pageB, order: pageB });
    sched.rotation.update(state);
    assert.equal(pageB.filter(id => sched.rotation.isPlannedLive(id)).length, 18);
    assert.equal(pageA.filter(id => sched.rotation.isPlannedLive(id)).length, 0);

    // Back on page A: in every group the student admitted is the one who has
    // waited longest (credit from before the page change).
    sched.rotation.setLayout({ scope: pageA, order: pageA });
    sched.rotation.update(state);

    const rank = new Map(waitingOnA.map((id, index) => [id, index]));

    sched.rotation.stats().groupMembers.forEach(members => {
        const liveMember = members.find(id => sched.rotation.isPlannedLive(id));
        const waiters = members.filter(id => rank.has(id));

        if (waiters.length) {
            assert.ok(rank.has(liveMember), `${liveMember} had been waiting`);
            assert.equal(liveMember, waiters.sort((a, b) => rank.get(a) - rank.get(b))[0]);
        }
    });
});

// ---- Tiles view (integration with mocks) -------------------------------------------

test("List / Tiles switching: grid of the page, list of everyone, one timer at each pace", async () => {
    const h = createHarness();
    const all = ids(30);

    all.forEach(id => h.addParticipant(id));
    h.addParticipant("coteach1", { role: "moderator" });
    await h.startTeacher();

    assert.equal(h.rotation().stats().mode, "list");
    assert.deepEqual(h.intervals("subtick"), [2000]);

    await h.sendTiles({ ids: all, pageSize: 20 });

    let state = h.tilesState();

    assert.equal(state.layout, "tiles");
    assert.deepEqual(Array.from(state.rendered).sort(), all.slice(0, 20).sort(), "only the page's students");
    assert.equal(h.rotation().stats().mode, "tiles");
    assert.deepEqual(h.intervals("subtick"), [5000], "Tiles pace, single timer");
    assert.ok(h.document.body.classList.contains("sl-tv-strip-hidden"), "toolbar laid out without a filmstrip");

    await h.sendTiles({ layout: "list", ids: all, pageSize: 20 });
    state = h.tilesState();

    assert.equal(state.layout, "list");
    assert.deepEqual(Array.from(state.rendered), []);
    assert.equal(h.rotation().stats().mode, "list");
    assert.deepEqual(h.intervals("subtick"), [2000]);
    assert.ok(Object.keys(h.tileModes()).includes("coteach1"), "List shows co-teachers again");
    assert.ok(!h.document.body.classList.contains("sl-tv-strip-hidden"));
});

test("all five page sizes: tile count, labels and navigation requests", async () => {
    const h = createHarness();
    const all = ids(60);

    all.forEach(id => h.addParticipant(id));
    await h.startTeacher();

    for (const size of PAGE_SIZES) {
        await h.sendTiles({ ids: all, pageSize: size });

        const state = h.tilesState();

        assert.equal(state.rendered.length, size, `page size ${size}`);
        assert.equal(state.label, `Page 1 of ${Math.ceil(60 / size)} · Students 1–${size} of 60`);
        assert.equal(state.previousDisabled, true);
        assert.equal(state.nextDisabled, false);
    }

    // Last page at 50: ten students, Next disabled.
    await h.sendTiles({ ids: all, pageSize: 50, pageIndex: 1 });
    assert.equal(h.tilesState().rendered.length, 10);
    assert.equal(h.tilesState().nextDisabled, true);
    assert.equal(h.tilesState().previousDisabled, false);

    // Previous / Next ask the parent page (which owns the paging).
    h.teacherTest().tilesPrevious();
    h.teacherTest().tilesNext();
    assert.deepEqual(h.posted.filter(message => message.type === "SL_TEACHER_TILES_NAV").map(message => message.action),
        ["previous", "next"]);
});

test("over budget: 18 live feeds, the rest frozen or waiting; at 10 all live, no rotation", async () => {
    const { h: big } = await teacherWithTiles(40, { pageSize: 30 });

    await big.run(30000);

    const modes = Object.values(big.tileModes());

    assert.equal(modes.filter(mode => mode === "live").length, 18);
    assert.equal(modes.filter(mode => mode === "frozen" || mode === "waiting").length, 12);

    const { h: small } = await teacherWithTiles(40, { pageSize: 10 });

    assert.equal(Object.values(small.tileModes()).filter(mode => mode === "live").length, 10);
    assert.equal(small.rotation().stats().rotating, false);
    assert.deepEqual(small.intervals("subtick"), [], "no rotation timer");
});

test("receive policy in Tiles view: only the page's cameras, at most 18", async () => {
    const { h, all } = await teacherWithTiles(60, { pageSize: 50, pageIndex: 1 });
    const sent = h.lastSent();
    const cameras = sent.selectedSources.filter(source => source.startsWith("stud"));

    assert.equal(cameras.length, 10, "page 2 holds 10 students: all received");
    cameras.forEach(source => assert.ok(all.slice(50).includes(source.replace("-v0", ""))));
});

test("nearby groups use the rendered grid and follow a column change", async () => {
    const { h } = await teacherWithTiles(50, { pageSize: 50 });
    const before = h.tilesState();

    // The groups are cut from the measured grid order.
    assert.ok(before.columns > 1);
    assert.deepEqual(Array.from(h.rotation().stats().groupMembers.flat()),
        Array.from(before.order).filter(id => h.rotation().stats().groupMembers.flat().includes(id)));

    // A narrower grid (e.g. the panel opened, a small window): fewer columns,
    // a new measured order, new nearby groups.
    await h.resizeGrid(520, 800);
    await h.run(1000);

    const after = h.tilesState();

    assert.ok(after.columns < before.columns, `${after.columns} < ${before.columns} columns`);
    assert.notDeepEqual(Array.from(after.order), Array.from(before.order));
    assert.deepEqual(Array.from(h.rotation().stats().groupMembers.flat()), Array.from(after.order));
});

test("staggered swaps in the running view: a few cameras per 5 s tick, never all 18", async () => {
    const { h } = await teacherWithTiles(50, { pageSize: 50 });
    const changes = [];
    let previous = new Set(h.rotation().stats().live);

    for (let step = 0; step < 24; step++) {
        await h.run(5000, 5000);

        const now = new Set(h.rotation().stats().live);

        changes.push([...now].filter(id => !previous.has(id)).length);
        previous = now;
    }

    assert.ok(Math.max(...changes) <= 6, `swaps per tick: ${changes}`);
    assert.ok(changes.some(count => count > 0));
});

test("enlarge: click selects, highlights and shows the same track; close keeps the student connected", async () => {
    const { h } = await teacherWithTiles(30, { pageSize: 30 });
    const target = "stud021";
    const track = h.trackOf(target).jitsiTrack;

    h.teacherTest().tileClick(target);
    await h.flush();
    h.deliver();
    await h.flush();

    const state = h.tilesState();
    const panelVideo = h.document._videos.size && [...h.document._videos].find(video =>
        video.parentNode && video.parentNode.classList.contains("sl-tv-panel-body"));

    assert.equal(state.panel.open, true);
    assert.equal(state.panel.id, target);
    assert.equal(state.panel.state, "live");
    assert.ok(h.tile(target).el.classList.contains("sl-pinned"), "tile highlighted");
    assert.equal(h.participants.pinnedParticipant, target, "Jitsi pin (stage quality)");
    assert.ok(h.rotation().stats().priority.includes(target), "priority camera");
    assert.equal(panelVideo.srcObject, track.stream, "the existing track, attached once more");
    assert.equal(panelVideo.shownOwner, target);

    h.teacherTest().closePanel();
    await h.flush();

    assert.equal(h.tilesState().panel.open, false);
    assert.equal(panelVideo.srcObject, null, "panel let go of the track");
    assert.ok(h.participants.remote.has(target), "student still in the meeting");
    assert.equal(h.trackOf(target).jitsiTrack, track, "same track, not stopped or replaced");
    assert.notEqual(h.participants.pinnedParticipant, target, "pin back to the teacher");
    assert.equal(h.rotation().stats().priority.length, 0);
});

test("enlarge: camera off, stalled, disconnected states", async () => {
    const { h } = await teacherWithTiles(12, { pageSize: 20 });
    const target = "stud003";

    h.teacherTest().tileClick(target);
    await h.flush();
    h.deliver();
    await h.flush();
    assert.equal(h.tilesState().panel.state, "live");

    h.trackOf(target).jitsiTrack.setStatus("interrupted");
    await h.flush();
    assert.equal(h.tilesState().panel.state, "stalled");

    h.trackOf(target).jitsiTrack.setStatus("active");
    h.setCamera(target, false);
    h.change();
    await h.flush();
    assert.equal(h.tilesState().panel.state, "off");

    h.setCamera(target, true);
    h.removeParticipant(target);
    h.change();
    await h.flush();
    assert.equal(h.tilesState().panel.state, "disconnected");
    assert.equal(h.tilesState().panel.open, true, "stays open until closed");
    assert.equal(h.tileModes()[target], "disconnected", "the tile too");
});

test("enlarge: the selection persists across a page change (explicit behaviour)", async () => {
    const { h, all } = await teacherWithTiles(60, { pageSize: 20 });

    h.teacherTest().tileClick("stud005");
    await h.flush();
    await h.sendTiles({ ids: all, pageSize: 20, pageIndex: 1 });

    const state = h.tilesState();

    assert.equal(state.panel.open, true);
    assert.equal(state.panel.id, "stud005");
    assert.ok(!state.rendered.includes("stud005"), "not on this page's grid");
    assert.ok(h.rotation().isPlannedLive("stud005"), "still received as the priority camera");
    assert.equal(h.rotation().stats().slots, 17);
});

test("reconnect: the old ID shows disconnected; the new ID takes the roster place", async () => {
    const { h, all } = await teacherWithTiles(20, { pageSize: 20 });

    h.removeParticipant("stud004");
    h.change();
    await h.flush();
    assert.equal(h.tileModes().stud004, "disconnected");

    // Rejoined with a new participant ID; the parent page's roster order puts
    // it in the same place.
    h.addParticipant("rejoin04");
    h.change();
    await h.sendTiles({ ids: all.map(id => (id === "stud004" ? "rejoin04" : id)), pageSize: 20 });
    await h.run(1000);

    const state = h.tilesState();

    assert.equal(state.rendered.indexOf("rejoin04"), all.indexOf("stud004"));
    assert.ok(!state.rendered.includes("stud004"));
    assert.equal(h.tileModes().rejoin04, "live");
});

test("source remapping in Tiles view: a frozen tile keeps its own student's frame", async () => {
    const { h } = await teacherWithTiles(30, { pageSize: 30 });

    await h.run(30000);

    const frozenId = Object.entries(h.tileModes()).find(([, mode]) => mode === "frozen")?.[0];

    assert.ok(frozenId);
    h.participants.remote.set("newcomer", {
        id: "newcomer",
        name: "newcomer",
        role: "participant",
        sources: new Map([["video", new Map([["newcomer-v0", { videoType: "camera", muted: false }]])]])
    });
    h.remapTrack(frozenId, "newcomer");
    h.change();
    await h.run(6000);

    assert.equal(h.tile(frozenId).video.shownOwner, frozenId);
    assert.notEqual(h.tileModes()[frozenId], "live");
});

test("CPU limiter in Tiles view: fewer groups, still one live per group", async () => {
    const { h } = await teacherWithTiles(50, { pageSize: 50 });

    h.controller.limited = true;
    h.controller.limitedLastN = 9;
    await h.run(3000);

    const stats = h.rotation().stats();

    assert.equal(stats.slots, 9);
    assert.equal(stats.groupMembers.length, 9);
    stats.groupMembers.forEach(members =>
        assert.equal(members.filter(id => h.rotation().isPlannedLive(id)).length, 1));

    h.controller.limited = false;
    await h.run(3000);
    assert.equal(h.rotation().stats().groupMembers.length, 18);
});

test("Exam Mode is unchanged with Tiles selected, and Tiles comes back after it", async () => {
    const { h, all } = await teacherWithTiles(30, { pageSize: 20 });

    // Exam Mode as the page sends it: receive set, then the monitoring grid.
    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 1, enabled: true, participantIds: all.slice(0, 5) });
    h.postFromParent({ type: "SL_MONITOR_VIEW", v: 1, epoch: 1, enabled: true, participantIds: all.slice(0, 5) });
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: false });
    await h.flush();
    await h.flush();

    const sent = h.lastSent();

    assert.deepEqual(Array.from(sent.selectedSources), all.slice(0, 5).map(id => id + "-v0"));
    assert.equal(sent.lastN, 5);
    assert.equal(h.rotation().isActive(), false);
    assert.deepEqual(h.intervals("subtick"), []);
    assert.deepEqual(h.intervals("pollCpuLimiter"), []);
    assert.equal(h.receiveTest().limiterCeiling(), 5);
    assert.ok(h.document.body.classList.contains("sl-monitor-active"));

    // Back to Normal: Tiles view again, same page.
    h.postFromParent({ type: "SL_RECEIVE_SET", v: 1, epoch: 2, enabled: false, participantIds: [] });
    h.postFromParent({ type: "SL_MONITOR_VIEW", v: 1, epoch: 2, enabled: false, participantIds: [] });
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 3, enabled: true });
    h.change();
    await h.run(1000);

    assert.equal(h.tilesState().rendered.length, 20);
    assert.equal(h.rotation().stats().mode, "tiles");
    assert.deepEqual(h.intervals("subtick"), [5000]);
});

test("timer and listener cleanup: view off leaves no timers, no panel or tile listeners", async () => {
    const { h } = await teacherWithTiles(30, { pageSize: 30 });

    h.teacherTest().tileClick("stud002");
    await h.flush();
    await h.run(10000);

    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: false });
    await h.flush();

    assert.deepEqual(h.intervals("subtick"), []);
    assert.deepEqual(h.intervals("pollCpuLimiter"), []);
    h.state["features/base/tracks"].forEach(track =>
        assert.equal(track.jitsiTrack.listenerCount(), 0, `${track.participantId}: no listener`));
    assert.equal(h.tilesState().panel.open, false);
});

test("malformed Tiles messages are ignored", async () => {
    const h = createHarness();

    ids(5).forEach(id => h.addParticipant(id));
    await h.startTeacher();

    const bad = [
        { type: "SL_TEACHER_TILES", v: 1, epoch: 1, layout: "grid", participantIds: [], page: 0, pageCount: 0, rangeStart: 0, rangeEnd: 0, total: 0 },
        { type: "SL_TEACHER_TILES", v: 1, epoch: 1, layout: "tiles", participantIds: ids(51), page: 1, pageCount: 1, rangeStart: 1, rangeEnd: 51, total: 51 },
        { type: "SL_TEACHER_TILES", v: 1, epoch: 1, layout: "tiles", participantIds: ["<script>"], page: 1, pageCount: 1, rangeStart: 1, rangeEnd: 1, total: 1 },
        { type: "SL_TEACHER_TILES", v: 1, epoch: 1, layout: "tiles", participantIds: ["stud000", "stud000"], page: 1, pageCount: 1, rangeStart: 1, rangeEnd: 2, total: 2 }
    ];

    bad.forEach(message => h.postFromParent(message));
    await h.flush();

    assert.equal(h.tilesState().layout, "list");
    assert.equal(h.warnings.length, bad.length);
});

// ---- regression: audit defects (bursts, swap cap, minimum live time,
// partial rows, rapid navigation) -----------------------------------------------

// Live set including priority cameras.
function liveNow(rotation) {
    return new Set(rotation.stats().live.concat(rotation.stats().priority));
}

function swapsPerTick(rotation, ticks) {
    const counts = [];

    for (let tick = 0; tick < ticks; tick++) {
        const before = liveNow(rotation);

        rotation.subtick();
        counts.push([...liveNow(rotation)].filter(id => !before.has(id)).length);
    }

    return counts;
}

test("page return after a long absence: cameras start once, no burst of replacements", () => {
    const sched = createScheduler();
    const all = ids(100);
    const state = sched.stateFor(all);
    const { rotation } = sched;
    const pageA = all.slice(0, 50);
    const pageB = all.slice(50);

    rotation.setLayout({ scope: pageA, order: pageA });
    rotation.update(state);
    swapsPerTick(rotation, 6);

    // Five minutes (60 sub-ticks of 5 s) on page B.
    rotation.setLayout({ scope: pageB, order: pageB });
    rotation.update(state);
    swapsPerTick(rotation, 60);

    const before = liveNow(rotation);

    rotation.setLayout({ scope: pageA, order: pageA });
    rotation.update(state);

    assert.equal([...liveNow(rotation)].filter(id => !before.has(id)).length, 18, "page A's cameras start");

    const after = swapsPerTick(rotation, 12);
    const cap = rotation.stats().groupAdvancesPerTick;

    // No replacement before the new cameras' minimum live time (15 s), then
    // never more than the cap (old code: 18, 14 right after the return).
    assert.deepEqual(after.slice(0, 3), [0, 0, 0], `swaps after return: ${after}`);
    assert.ok(after.every(count => count <= cap), `swaps after return: ${after}`);
    assert.ok(after.slice(3).some(count => count > 0), "rotation resumes");
});

test("List view for a long time, then Tiles: swaps stay under the cap", () => {
    const sched = createScheduler();
    const all = ids(100);
    const state = sched.stateFor(all);
    const { rotation } = sched;

    rotation.update(state);
    swapsPerTick(rotation, 150);

    rotation.setLayout({ scope: all.slice(0, 50), order: all.slice(0, 50) });
    rotation.update(state);

    const counts = swapsPerTick(rotation, 12);

    assert.ok(counts.every(count => count <= rotation.stats().groupAdvancesPerTick), `swaps: ${counts}`);
});

test("hard swap cap and minimum live time with many overdue groups (pages 20-50)", () => {
    [20, 30, 40, 50].forEach(size => {
        const { sched, students, state } = groupScheduler(size);
        const { rotation } = sched;

        // A long squeeze (one camera for the whole page) makes nearly every
        // student overdue, then the full budget comes back.
        sched.setBudget(1, state);
        swapsPerTick(rotation, 40);
        sched.setBudget(null, state);

        const cap = rotation.stats().groupAdvancesPerTick;
        const admittedAt = new Map(students.filter(id => rotation.isPlannedLive(id)).map(id => [id, -1]));
        const lastLive = new Map(students.map(id => [id, 0]));
        let maxWait = 0;

        for (let tick = 0; tick < 120; tick++) {
            const before = liveNow(rotation);

            rotation.subtick();

            const now = liveNow(rotation);
            const added = [...now].filter(id => !before.has(id));
            const removed = [...before].filter(id => !now.has(id));

            assert.ok(added.length <= cap, `page ${size} tick ${tick}: ${added.length} swaps, cap ${cap}`);
            // A camera started at the re-cut (between ticks) or at a tick
            // leaves only after 3 full ticks (15 s) live.
            removed.forEach(id => {
                const since = admittedAt.get(id);

                assert.ok(since === undefined || tick - since >= 3, `page ${size}: ${id} live only ${tick - since} ticks`);
            });
            added.forEach(id => admittedAt.set(id, tick));

            students.forEach(id => {
                if (now.has(id)) {
                    lastLive.set(id, tick);
                } else {
                    maxWait = Math.max(maxWait, tick - lastLive.get(id));
                }
            });
        }

        assert.ok(maxWait <= 12, `page ${size}: no starvation (max wait ${maxWait} ticks)`);
    });
});

test("minimum live time in real time: no rotation swap before 15 s, also for cameras started between ticks", async () => {
    const { h, all } = await teacherWithTiles(80, { pageSize: 40 });
    const liveSince = new Map();
    const tooShort = [];
    let lastTick = h.rotation().stats().tick;
    let budgetChangedAt = -Infinity;

    // Sampled every 100 ms, so every start and end time is exact. A camera
    // leaving at a scheduler tick is a rotation swap, unless the CPU budget
    // just changed (the limiter poll, 1 s, may land on the same instant:
    // a forced cut, not a swap).
    const sample = () => {
        const now = h.timers.now;
        const stats = h.rotation().stats();
        const live = new Set(stats.live);
        const atTick = stats.tick !== lastTick;

        lastTick = stats.tick;
        live.forEach(id => { if (!liveSince.has(id)) { liveSince.set(id, now); } });
        Array.from(liveSince.keys()).forEach(id => {
            if (!live.has(id)) {
                if (atTick && now - budgetChangedAt > 1100 && now - liveSince.get(id) < 15000) {
                    tooShort.push(`${id}: ${now - liveSince.get(id)} ms`);
                }

                liveSince.delete(id);
            }
        });
    };

    // Each event lands between timer ticks: page change, CPU budget down and
    // up, selection, close, camera off and on, page change back.
    const events = [
        async () => h.sendTiles({ ids: all, pageSize: 40, pageIndex: 1 }),
        async () => { h.controller.limited = true; h.controller.limitedLastN = 12; budgetChangedAt = h.timers.now; },
        async () => { h.controller.limited = false; budgetChangedAt = h.timers.now; },
        async () => { h.teacherTest().tileClick(all[45]); },
        async () => { h.teacherTest().closePanel(); },
        async () => { h.setCamera(all[50], false); h.change(); },
        async () => { h.setCamera(all[50], true); h.change(); },
        async () => h.sendTiles({ ids: all, pageSize: 40, pageIndex: 0 })
    ];

    sample();

    for (const event of events) {
        // To an instant between ticks, sampled every 100 ms like the rest.
        for (let step = 0; step < 23; step++) {
            h.timers.advance(100);
            await h.flush();
            sample();
        }

        await event();
        await h.flush();
        // Event-time changes are recuts / page changes, not swaps.
        lastTick = h.rotation().stats().tick;
        sample();

        for (let step = 0; step < 250; step++) {
            h.timers.advance(100);
            await h.flush();

            if (step % 10 === 0) {
                h.deliver();
                await h.flush();
            }

            sample();
        }
    }

    assert.deepEqual(tooShort, []);
});

test("partial rows: groups stay within 2 tiles for every page length and column count", () => {
    const { spatialOrder, partition } = pureFunctions();
    const wide = [];

    for (let columns = 3; columns <= 8; columns++) {
        for (let count = 19; count <= 50; count++) {
            const list = ids(count);
            const measured = spatialOrder(gridEntries(list, columns));
            const cell = id => {
                const index = list.indexOf(id);

                return [Math.floor(index / columns), index % columns];
            };
            const groups = Array.from(partition(Array.from(measured.order), 18, measured.positions));

            assert.equal(groups.length, 18);
            assert.deepEqual(groups.flatMap(group => Array.from(group)).sort(), list.slice().sort());

            const sizes = groups.map(group => group.length);

            assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, "balanced sizes");

            groups.forEach(group => {
                let widest = 0;

                for (const a of group) {
                    for (const b of group) {
                        const [ra, ca] = cell(a);
                        const [rb, cb] = cell(b);

                        widest = Math.max(widest, Math.abs(ra - rb), Math.abs(ca - cb));
                    }
                }

                if (widest > 2) {
                    wide.push(`${columns} cols, ${count} students: {${Array.from(group).join(" ")}} spans ${widest}`);
                }
            });
        }
    }

    assert.deepEqual(wide, []);
});

test("partial rows: a short last row continues next to the row above", () => {
    const { spatialOrder } = pureFunctions();
    // 38 tiles in 7 columns: 5 full rows and 3 tiles in the last row
    // (the old order jumped 4 tiles into it).
    const list = ids(38);
    const measured = spatialOrder(gridEntries(list, 7));
    const cell = id => [Math.floor(list.indexOf(id) / 7), list.indexOf(id) % 7];
    const order = Array.from(measured.order);

    for (let index = 1; index < order.length; index++) {
        const [r1, c1] = cell(order[index - 1]);
        const [r2, c2] = cell(order[index]);

        assert.ok(Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2)) <= 1, `${order[index - 1]} -> ${order[index]}`);
    }
});

test("partial final page in the view: groups follow the grid", async () => {
    const { h } = await teacherWithTiles(88, { pageSize: 50, pageIndex: 1 });
    const state = h.tilesState();
    const position = new Map(state.rendered.map(id => {
        const rect = h.tile(id).el.getBoundingClientRect();

        return [id, [Math.round(rect.top / 76), Math.round(rect.left / 128)]];
    }));

    assert.equal(state.rendered.length, 38);
    h.rotation().stats().groupMembers.forEach(group => {
        let widest = 0;

        group.forEach(a => group.forEach(b => {
            const [ra, ca] = position.get(a);
            const [rb, cb] = position.get(b);

            widest = Math.max(widest, Math.abs(ra - rb), Math.abs(ca - cb));
        }));
        assert.ok(widest <= 2, `group ${Array.from(group).join(" ")} spans ${widest}`);
        assert.equal(group.filter(id => h.rotation().isPlannedLive(id)).length, 1);
    });
});

test("rapid navigation: two quick Next presses move two pages", async () => {
    const paging = await loadPaging();
    // The hook applies each press to the LATEST requested index (React
    // functional update), so two presses before a re-render compound.
    let requested = 0;

    ["next", "next"].forEach(action => { requested = paging.stepPageIndex(requested, 4, action); });
    assert.equal(requested, 2);

    ["previous", "previous", "previous"].forEach(action => { requested = paging.stepPageIndex(requested, 4, action); });
    assert.equal(requested, 0, "stops at the first page");

    assert.equal(paging.stepPageIndex(3, 4, "next"), 3, "stops at the last page");
    assert.equal(paging.stepPageIndex(9, 2, "previous"), 0, "a stale index past the end is clamped first");

    // The grid sends one message per press (no debounce or dedupe).
    const { h } = await teacherWithTiles(60, { pageSize: 20 });

    h.teacherTest().tilesNext();
    h.teacherTest().tilesNext();
    assert.deepEqual(h.posted.filter(message => message.type === "SL_TEACHER_TILES_NAV").map(message => message.action),
        ["next", "next"]);
});
