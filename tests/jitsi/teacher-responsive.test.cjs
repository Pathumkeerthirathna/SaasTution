/*
 * Regression tests: the teacher view on phones and tablets
 * (deploy/jitsi/custom.js: bestGridLayout / layoutTilesGrid /
 * gridBottomReserve, getEffectivePosition, liftLayoutMenu / fitLayoutMenu).
 *
 *   npm run test:jitsi
 *
 * - Tiles view: tiles never narrower than 96px (the grid scrolls instead),
 *   a smaller toolbar reserve on short screens / under a stacked panel, and
 *   compact labels on small tiles. Desktop sizes keep the exact fit-all
 *   layout they had before.
 * - List view: a narrow screen or an upright touch tablet shows the
 *   filmstrip at the bottom; the teacher's preference is kept and nothing is
 *   reported to the parent page.
 * - The List view settings menu fits a short screen and scrolls inside.
 *
 * These check custom.js's own logic against the harness's layout model;
 * real browser layout is checked on devices.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness, ids } = require("./harness.cjs");

const GAP = 8;
const MIN_TILE = 96;

// The layout before the minimum tile width: the columns giving the largest
// 16:9 tiles that all fit (a copy of the original bestGridLayout).
function fitAllLayout(count, width, height) {
    let best = { cols: 1, tileWidth: 0 };

    for (let cols = 1; cols <= Math.max(1, count); cols++) {
        const rows = Math.ceil(count / cols);
        const tileWidth = Math.min(
            (width - GAP * (cols - 1)) / cols,
            ((height - GAP * (rows - 1)) / rows) * 16 / 9
        );

        if (tileWidth > best.tileWidth) {
            best = { cols, tileWidth };
        }
    }

    return { cols: best.cols, tileWidth: Math.max(1, Math.floor(best.tileWidth)) };
}

// The grid's content box for a client size and toolbar reserve.
const contentBox = (width, height, reserve = 96) => ({ width: width - 2 * GAP, height: height - GAP - reserve });

function findByClass(h, name) {
    for (const el of h.document.documentElement.walk()) {
        if (el.classList.contains(name)) {
            return el;
        }
    }

    return null;
}

function applied(h) {
    const grid = findByClass(h, "sl-tv-grid");

    return {
        cols: Number(grid.style.getPropertyValue("--sl-tv-grid-cols")),
        tileWidth: parseInt(grid.style.getPropertyValue("--sl-tv-tile-w"), 10),
        reserve: grid.style.getPropertyValue("--sl-tv-grid-pad-b"),
        compact: grid.classList.contains("sl-tv-grid-compact")
    };
}

async function step(h) {
    await h.flush();
    await h.flush();
}

// Tiles view with `count` students; the window (root) and grid sizes are
// set before the view is built.
async function tilesView(count, { root = [1280, 800], grid = [1280, 800], pageSize = 50 } = {}) {
    const h = createHarness();
    const all = ids(count);

    all.forEach(id => h.addParticipant(id));
    h.document._rootSize = { width: root[0], height: root[1] };
    h.document._gridSize = { width: grid[0], height: grid[1] };

    await h.startTeacher();
    await h.sendTiles({ layout: "tiles", ids: all, pageSize });

    return { h, all };
}

// List view, with matchMedia available (pointer: fine unless set).
async function listView({ root = [1280, 800], coarse = false } = {}) {
    const h = createHarness({ matchMedia: true });
    const all = ids(6);

    h.coarsePointer = coarse;
    all.forEach(id => h.addParticipant(id));
    h.document._rootSize = { width: root[0], height: root[1] };

    await h.startTeacher();
    await h.sendTiles({ layout: "list", ids: all, pageSize: 20 });
    await step(h);

    return { h, all };
}

const effective = h => h.teacherTest().layout().effective;
const preferred = h => h.teacherTest().layout().preferred;
const layoutPosts = h => h.posted.filter(message => message.type === "SL_TEACHER_LAYOUT");

// ---- Tiles view: desktop layouts unchanged ------------------------------------

test("desktop grids: every layout that fits at 96px or more is exactly the original fit-all layout", async () => {
    const sizes = [[1466, 622], [1280, 720], [800, 900], [520, 800], [1920, 500], [640, 360],
        [1000, 1000], [1366, 620], [2560, 1000], [1024, 520]];
    const counts = [1, 2, 3, 4, 5, 6, 7, 9, 12, 20, 30, 40, 50];
    let compared = 0;

    for (const [width, height] of sizes) {
        const { h, all } = await tilesView(50, { grid: [width, height] });

        for (const count of counts) {
            await h.sendTiles({ layout: "tiles", ids: all.slice(0, count), pageSize: 50 });

            const box = contentBox(width, height);
            const before = fitAllLayout(count, box.width, box.height);
            const now = applied(h);

            assert.equal(now.reserve, "96px", "desktop keeps the 96px toolbar reserve");

            if (before.tileWidth >= MIN_TILE) {
                compared += 1;
                assert.deepEqual({ cols: now.cols, tileWidth: now.tileWidth }, before,
                    `${count} on ${width} x ${height}`);
                assert.equal(now.compact, before.tileWidth < 112, `${count} on ${width} x ${height}: compact labels`);
            } else {
                assert.ok(now.tileWidth >= MIN_TILE, `${count} on ${width} x ${height}: ${now.tileWidth} >= 96`);
            }
        }
    }

    assert.ok(compared > 100, `${compared} desktop layouts compared`);
});

test("desktop values pinned: 1466 x 622 (1 / 4 students) and 1280 x 720 with 50 students", async () => {
    const { h, all } = await tilesView(50, { grid: [1466, 622] });

    await h.sendTiles({ layout: "tiles", ids: all.slice(0, 1), pageSize: 50 });
    assert.deepEqual(applied(h), { cols: 1, tileWidth: 920, reserve: "96px", compact: false });

    await h.sendTiles({ layout: "tiles", ids: all.slice(0, 4), pageSize: 50 });
    assert.deepEqual(applied(h), { cols: 2, tileWidth: 453, reserve: "96px", compact: false });

    await h.resizeGrid(1280, 720);
    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 50 });

    const box = contentBox(1280, 720);

    assert.deepEqual(applied(h), { ...fitAllLayout(50, box.width, box.height), reserve: "96px", compact: false });
});

// ---- Tiles view: phones -----------------------------------------------------------

test("portrait phone, 20 students: 3 columns of 114px tiles (was 4 x 83px), the grid scrolls", async () => {
    // Short view (440 <= 500): 64px reserve. Content box 359 x 328.
    const { h } = await tilesView(20, { root: [375, 440], grid: [375, 400] });
    const now = applied(h);
    const box = contentBox(375, 400, 64);

    assert.equal(fitAllLayout(20, box.width, box.height).tileWidth, 83, "fit-all would give 83px tiles");
    assert.deepEqual(now, { cols: 3, tileWidth: 114, reserve: "64px", compact: false });

    const rows = Math.ceil(20 / now.cols);

    assert.ok(rows * (now.tileWidth * 9 / 16) + GAP * (rows - 1) > box.height, "taller than the grid: it scrolls");
    assert.ok(now.cols * now.tileWidth + GAP * (now.cols - 1) <= box.width, "never wider than the grid");
});

test("portrait phone, 50 students on a 320px grid: 96px tiles, compact labels", async () => {
    const { h } = await tilesView(50, { root: [320, 460], grid: [320, 420] });

    assert.deepEqual(applied(h), { cols: 3, tileWidth: 96, reserve: "64px", compact: true });
});

test("a grid narrower than one tile: one column, the full width", async () => {
    const { h } = await tilesView(10, { root: [320, 460], grid: [90, 420] });
    const now = applied(h);

    assert.equal(now.cols, 1);
    assert.equal(now.tileWidth, 74, "90 - 16");
});

test("landscape phone, 50 students: no tile under 96px (fit-all gave about 50px)", async () => {
    const { h } = await tilesView(50, { root: [790, 300], grid: [790, 263] });
    const now = applied(h);
    const box = contentBox(790, 263, 64);

    assert.ok(fitAllLayout(50, box.width, box.height).tileWidth < MIN_TILE);
    assert.equal(now.reserve, "64px");
    assert.ok(now.tileWidth >= MIN_TILE, `${now.tileWidth}px`);
    assert.equal(now.cols, Math.floor((box.width + GAP) / (MIN_TILE + GAP)));
});

test("rotation in a scrolling grid: groups follow the measured order and every student gets live time", async () => {
    const { h, all } = await tilesView(50, { root: [375, 440], grid: [375, 400] });

    await h.run(1000);

    const state = h.tilesState();

    assert.equal(state.rendered.length, 50);
    assert.deepEqual(Array.from(h.rotation().stats().groupMembers.flat()), Array.from(state.order));

    const everLive = new Set(h.rotation().stats().live);

    for (let elapsed = 0; elapsed < 600000; elapsed += 5000) {
        await h.run(5000, 5000);
        h.rotation().stats().live.forEach(id => everLive.add(id));
    }

    assert.deepEqual(all.filter(id => !everLive.has(id)), [], "nobody starved");
});

// ---- Tiles view: toolbar reserve ---------------------------------------------------

test("toolbar reserve: 96px on desktop, 64px on a short view, 8px under a stacked panel", async () => {
    // Short view: the reserve also sets the height the tiles are fitted to.
    const { h: short } = await tilesView(1, { root: [800, 400], grid: [800, 360] });

    assert.deepEqual(applied(short), { cols: 1, tileWidth: 512, reserve: "64px", compact: false },
        "(360 - 8 - 64) * 16 / 9");

    // A narrow upright view: 96px until the panel stacks under the grid.
    const { h, all } = await tilesView(4, { root: [600, 900], grid: [600, 860] });

    assert.equal(applied(h).reserve, "96px");

    h.teacherTest().tileClick(all[0]);
    await step(h);
    await h.resizeGrid(600, 450);

    assert.equal(h.tilesState().panel.open, true);
    assert.equal(applied(h).reserve, "8px", "the toolbar is over the panel, not the grid");

    h.teacherTest().closePanel();
    await step(h);
    await h.resizeGrid(600, 860);

    assert.equal(applied(h).reserve, "96px");

    // A wide view: the panel opens beside the grid; the reserve is kept.
    const { h: wide, all: wideAll } = await tilesView(4, { grid: [1466, 622] });

    wide.teacherTest().tileClick(wideAll[0]);
    await step(wide);
    await wide.resizeGrid(780, 622);
    assert.equal(applied(wide).reserve, "96px");
});

test("the window turns (rotation): reserve and columns follow the new size", async () => {
    const { h } = await tilesView(20, { root: [844, 390], grid: [792, 353] });

    assert.equal(applied(h).reserve, "64px");

    await h.resizeRoot(390, 844, { width: 390, height: 640 });

    const now = applied(h);
    const box = contentBox(390, 640, 96);

    assert.equal(now.reserve, "96px");
    assert.deepEqual({ cols: now.cols, tileWidth: now.tileWidth }, fitAllLayout(20, box.width, box.height));
});

test("CSS: grid padding follows the reserve, compact labels, stacked panel clear of the toolbar", async () => {
    const { h } = await tilesView(1);
    const css = h.document.getElementById("sl-teacher-view-style").textContent;

    assert.match(css, /\.sl-tv-grid \{[^}]*padding: 8px 8px var\(--sl-tv-grid-pad-b, 96px\); overflow-y: auto; overscroll-behavior: contain;/);
    assert.match(css, /\.sl-tv-grid-compact \.sl-tv-icon \{ width: 26px; height: 26px; \}/);
    assert.match(css, /\.sl-tv-grid-compact \.sl-tv-ph-role, #sl-teacher-view \.sl-tv-grid-compact \.sl-tv-ph-status \{ display: none; \}/);
    assert.match(css, /@media \(max-width: 640px\) \{[^\n]*\.sl-tv-panel-open \.sl-tv-panel-body \{ margin-bottom: 64px; \} \}/);
    assert.match(css, /\.sl-tv-layout-menu \{ position: absolute;[^}]*overflow-y: auto; overscroll-behavior: contain; \}/);
});

// ---- List view: automatic filmstrip position ---------------------------------------

test("desktop: the teacher's position, also without matchMedia (fine pointer)", async () => {
    const { h } = await listView();

    assert.equal(effective(h), "right");

    // A portrait desktop monitor (fine pointer): unchanged.
    await h.resizeRoot(1020, 1800);
    assert.equal(effective(h), "right");

    // No matchMedia at all: an upright tablet-sized window keeps the position.
    const plain = createHarness();

    ids(3).forEach(id => plain.addParticipant(id));
    plain.document._rootSize = { width: 708, height: 920 };
    await plain.startTeacher();
    await step(plain);
    assert.equal(plain.teacherTest().layout().effective, "right");
});

test("phones: a narrow view is always at the bottom, also when the page chrome leaves it wider than tall", async () => {
    const { h } = await listView({ root: [390, 844], coarse: true });

    assert.equal(effective(h), "bottom");

    await h.resizeRoot(390, 380);
    assert.equal(effective(h), "bottom", "portrait phone whose view is landscape-shaped");

    // Too short for the smallest stage above the smallest strip: as chosen.
    await h.resizeRoot(390, 300);
    assert.equal(effective(h), "right");

    // Landscape phone: as chosen.
    await h.resizeRoot(790, 300);
    assert.equal(effective(h), "right");
});

test("tablets: upright touch screen at the bottom, landscape as chosen; a fine pointer keeps the choice", async () => {
    const { h } = await listView({ root: [708, 920], coarse: true });

    assert.equal(effective(h), "bottom");

    await h.resizeRoot(964, 1300);
    assert.equal(effective(h), "bottom", "large tablet, upright");

    await h.resizeRoot(1100, 1300);
    assert.equal(effective(h), "right", "at the tablet width limit: as chosen");

    await h.resizeRoot(1180, 760);
    assert.equal(effective(h), "right", "landscape tablet");

    h.coarsePointer = false;
    await h.resizeRoot(708, 920);
    assert.equal(effective(h), "right", "fine pointer: as chosen");
});

test("automatic bottom: the preference is kept, never reported, and comes back", async () => {
    const { h } = await listView({ coarse: true });

    h.teacherTest().openSettings();
    h.teacherTest().choosePosition("left");
    await step(h);

    const posts = layoutPosts(h).length;

    assert.equal(effective(h), "left");

    await h.resizeRoot(708, 920);
    assert.equal(effective(h), "bottom");
    assert.equal(preferred(h), "left");

    // Choosing closed the menu; open it again on the new screen.
    h.teacherTest().openSettings();
    await step(h);

    const menu = findByClass(h, "sl-tv-layout-menu");
    const checked = Array.from(menu.querySelectorAll(".sl-tv-layout-item[data-position]"))
        .filter(item => item.getAttribute("aria-checked") === "true")
        .map(item => item.dataset.position);

    assert.deepEqual(checked, ["left"], "the menu still shows the teacher's choice");
    assert.equal(menu.querySelector(".sl-tv-layout-note").textContent, "Shown at the bottom on this screen size.");

    await h.resizeRoot(1280, 800);
    assert.equal(effective(h), "left");
    assert.equal(layoutPosts(h).length, posts, "no SL_TEACHER_LAYOUT for automatic changes");
});

// ---- List view: settings menu on short screens ----------------------------------------

// The menu as a browser would lay it out: anchored `anchorBottom` px from
// the view's top (minus any lift in style.bottom), 300px tall unless capped
// by style.maxHeight.
function layoutMenu(h, anchorBottom, natural = 300) {
    h.document._rects["sl-tv-layout-menu"] = el => {
        const bottom = anchorBottom - (parseFloat(el.style.bottom) || 0);
        const height = Math.min(natural, parseFloat(el.style.maxHeight) || Infinity);

        return { left: 200, right: 400, top: bottom - height, bottom, width: 200, height, x: 200, y: bottom - height };
    };
}

// Jitsi's toolbar bar at [top, top + 50).
function toolbarAt(h, top) {
    const bar = { getBoundingClientRect: () => ({ left: 0, right: 1280, top, bottom: top + 50, width: 1280, height: 50 }) };

    h.document.querySelector = selector => selector === "#new-toolbox .toolbox-content-items" ? bar : null;
}

const menuEl = h => findByClass(h, "sl-tv-layout-menu");
// An inline style as a browser reports it ("" when never set).
const menuStyle = (h, name) => menuEl(h).style[name] || "";

test("side filmstrip on a landscape phone: the menu is capped to the view and scrolls", async () => {
    const { h } = await listView({ root: [790, 300], coarse: true });

    // Footer at the strip's bottom (48px) + 6px: the menu's bottom at 246.
    layoutMenu(h, 246);
    h.teacherTest().openSettings();
    await step(h);

    assert.equal(menuStyle(h, "maxHeight"), "238px", "246 - 8 from the top");
});

test("desktop: a menu that fits is never capped, and the bottom-strip lift is unchanged", async () => {
    const { h } = await listView();

    layoutMenu(h, 746);
    h.teacherTest().openSettings();
    await step(h);
    assert.equal(menuStyle(h, "maxHeight"), "");

    // Bottom strip (140px): menu bottom at 800 - 140 - 6, toolbar just above
    // the strip. Lifted 58px clear of it, as before; no cap.
    h.teacherTest().choosePosition("bottom");
    await step(h);
    toolbarAt(h, 800 - 140 - 8 - 50);
    layoutMenu(h, 654);
    h.teacherTest().openSettings();
    await step(h);

    assert.equal(effective(h), "bottom");
    assert.equal(h.teacherTest().settingsMenu().open, true);
    assert.equal(menuStyle(h, "bottom"), "58px");
    assert.equal(menuStyle(h, "maxHeight"), "");
});

test("bottom strip on a short screen: lifted clear of the toolbar, then capped", async () => {
    const { h } = await listView({ root: [500, 400], coarse: true });

    assert.equal(effective(h), "bottom");

    // Strip 140px: menu bottom at 400 - 140 - 6 = 254, 300px tall (top -46).
    // Toolbar from 202: clear above 196, 188px of room there.
    toolbarAt(h, 202);
    layoutMenu(h, 254);
    h.teacherTest().openSettings();
    await step(h);

    assert.equal(menuStyle(h, "bottom"), "58px", "254 - 196");
    assert.equal(menuStyle(h, "maxHeight"), "188px", "196 - 8");
});

test("bottom strip with too little room above the toolbar: lifted only as before, capped to the view", async () => {
    const { h } = await listView({ root: [500, 400], coarse: true });

    toolbarAt(h, 120);
    layoutMenu(h, 254);
    h.teacherTest().openSettings();
    await step(h);

    assert.equal(menuStyle(h, "bottom"), "0px", "no room for a lift (106px < 120px)");
    assert.equal(menuStyle(h, "maxHeight"), "246px", "254 - 8");
});

test("the cap follows a resize and is dropped in the Tiles view's grid bar", async () => {
    const { h, all } = await listView();

    layoutMenu(h, 746);
    h.teacherTest().openSettings();
    await step(h);
    assert.equal(menuStyle(h, "maxHeight"), "");

    // The window becomes a landscape phone with the menu open.
    layoutMenu(h, 246);
    await h.resizeRoot(790, 300);
    assert.equal(menuStyle(h, "maxHeight"), "238px");

    // Tiles view: the menu moves to the grid bar (its own CSS cap).
    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });
    await step(h);
    assert.equal(h.teacherTest().settingsMenu().place, "grid");
    assert.equal(h.teacherTest().settingsMenu().open, true);
    assert.equal(menuStyle(h, "maxHeight"), "");
});

// ---- List view: choosing a position where the screen places the filmstrip ----

// The position items' state in the open menu: { position: disabled }.
function positionItems(h) {
    const menu = findByClass(h, "sl-tv-layout-menu");
    const items = {};

    Array.from(menu.querySelectorAll(".sl-tv-layout-item[data-position]")).forEach(item => {
        items[item.dataset.position] = {
            disabled: item.getAttribute("aria-disabled") === "true",
            describedBy: item.getAttribute("aria-describedby") || null
        };
    });

    return items;
}

const menuNote = h => findByClass(h, "sl-tv-layout-menu").querySelector(".sl-tv-layout-note").textContent;

async function choose(h, position) {
    if (!h.teacherTest().settingsMenu().open) {
        h.teacherTest().openSettings();
    }

    h.teacherTest().choosePosition(position);
    await step(h);
}

test("phone: Left / Right are disabled with a reason; choosing one changes nothing and keeps the menu open", async () => {
    const { h } = await listView({ root: [390, 700], coarse: true });

    assert.equal(effective(h), "bottom", "automatic bottom by default");

    h.teacherTest().openSettings();
    await step(h);

    const items = positionItems(h);

    assert.deepEqual(
        Object.fromEntries(Object.entries(items).map(([position, item]) => [position, item.disabled])),
        { right: true, left: true, top: false, bottom: false });
    assert.equal(items.left.describedBy, "sl-tv-layout-note");
    assert.equal(menuNote(h), "Shown at the bottom on this screen size. Right and Left need a wider screen.");

    const posts = layoutPosts(h).length;

    await choose(h, "left");

    assert.equal(h.teacherTest().settingsMenu().open, true, "not closed silently");
    assert.equal(preferred(h), "right", "the saved choice is unchanged");
    assert.equal(effective(h), "bottom");
    assert.equal(h.teacherTest().layout().chosenHere, false);
    assert.equal(layoutPosts(h).length, posts, "nothing reported");
});

test("phone: Top fits and wins over the automatic bottom; it is reported like any choice", async () => {
    const { h } = await listView({ root: [390, 700], coarse: true });

    await choose(h, "top");

    assert.equal(effective(h), "top");
    assert.equal(preferred(h), "top");
    assert.equal(h.teacherTest().layout().chosenHere, true);
    assert.equal(h.teacherTest().settingsMenu().open, false, "a choice that takes effect closes the menu");
    assert.deepEqual({ ...layoutPosts(h).at(-1) }, { type: "SL_TEACHER_LAYOUT", v: 1, position: "top", autoHide: false });

    await choose(h, "bottom");
    assert.equal(effective(h), "bottom");
});

test("portrait tablet: all four positions can be chosen and take effect at once", async () => {
    const { h } = await listView({ root: [708, 920], coarse: true });

    h.teacherTest().openSettings();
    await step(h);
    assert.ok(Object.values(positionItems(h)).every(item => !item.disabled), "nothing disabled");
    assert.equal(menuNote(h), "Shown at the bottom on this screen size.");

    for (const position of ["left", "top", "bottom", "right"]) {
        await choose(h, position);
        assert.equal(effective(h), position);
        assert.equal(layoutPosts(h).at(-1).position, position);
    }
});

test("the already-saved position chosen again applies it over the automatic bottom", async () => {
    const { h } = await listView({ root: [708, 920], coarse: true });

    assert.equal(preferred(h), "right");
    assert.equal(effective(h), "bottom");

    await choose(h, "right");

    assert.equal(effective(h), "right");
    assert.equal(h.teacherTest().layout().chosenHere, true);
    assert.equal(layoutPosts(h).at(-1).position, "right");
});

test("rotation: the choice stays; where it no longer fits it falls back to bottom, and returns when it fits again", async () => {
    const { h } = await listView({ root: [708, 920], coarse: true });

    await choose(h, "left");
    assert.equal(effective(h), "left");

    await h.resizeRoot(920, 708);
    assert.equal(effective(h), "left", "landscape: the teacher's position");

    await h.resizeRoot(708, 920);
    assert.equal(effective(h), "left", "upright again: the session choice still wins");

    // Narrow: 450px cannot hold a side strip next to the smallest stage.
    await h.resizeRoot(450, 800);
    assert.equal(effective(h), "bottom");
    assert.equal(preferred(h), "left", "the choice itself is kept");

    await h.resizeRoot(708, 920);
    assert.equal(effective(h), "left", "fits again: back");
});

test("parent messages: a saved position on a phone starts at the bottom; resends never count as a choice", async () => {
    const { h } = await listView({ root: [390, 700], coarse: true });

    // A fresh join carrying a desktop choice ("left").
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: true, position: "left" });
    await step(h);

    assert.equal(preferred(h), "left");
    assert.equal(effective(h), "bottom");
    assert.equal(h.teacherTest().layout().chosenHere, false);

    // Portrait tablet: the teacher chooses; the parent resends what it saved.
    const { h: tablet } = await listView({ root: [708, 920], coarse: true });

    await choose(tablet, "top");
    tablet.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 2, enabled: true, position: "top" });
    await step(tablet);

    assert.equal(effective(tablet), "top");
    assert.equal(tablet.teacherTest().layout().chosenHere, true);
});

test("desktop: nothing disabled, every choice applies, no session override is recorded", async () => {
    const { h } = await listView();

    h.teacherTest().openSettings();
    await step(h);
    assert.ok(Object.values(positionItems(h)).every(item => !item.disabled && !item.describedBy));
    assert.equal(menuNote(h), "");

    for (const position of ["left", "top", "bottom", "right"]) {
        await choose(h, position);
        assert.equal(effective(h), position);
        assert.equal(h.teacherTest().settingsMenu().open, false);
    }

    assert.equal(h.teacherTest().layout().chosenHere, false, "only choices made under the automatic bottom count");

    const css = h.document.getElementById("sl-teacher-view-style").textContent;

    assert.match(css, /\.sl-tv-layout-item\[aria-disabled=true\] \{ opacity: 0\.45; cursor: not-allowed; \}/);
});
