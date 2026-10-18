/*
 * Regression tests: Tiles view tile SIZE (deploy/jitsi/custom.js,
 * layoutTilesGrid / bestGridLayout).
 *
 *   npm run test:jitsi
 *
 * The view picks the column count that gives the largest 16:9 tiles, and
 * now also applies the tile width it picked (--sl-tv-tile-w; the CSS caps
 * each tile at it, centred in its column). Before, only the column count was
 * applied and each tile was as wide as its column: a height-limited layout
 * (one student on a wide screen: grid 1466 x 622 measured live, tile
 * 1449.6 x 815.4) overflowed the grid and was cut off at the top.
 *
 * The grid's content box is its client size minus the padding (8px each
 * side, 96px at the bottom for the toolbar), as in the view.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness, ids } = require("./harness.cjs");

const GAP = 8;

// The grid's content box for a client size (CSS padding: 8 8 96).
const contentBox = (width, height) => ({ width: width - 2 * GAP, height: height - GAP - 96 });

function gridElOf(h) {
    for (const el of h.document.documentElement.walk()) {
        if (el.classList.contains("sl-tv-grid")) {
            return el;
        }
    }

    return null;
}

async function tilesView(count, gridWidth, gridHeight) {
    const h = createHarness();
    const all = ids(count);

    all.forEach(id => h.addParticipant(id));
    h.document._gridSize = { width: gridWidth, height: gridHeight };

    await h.startTeacher();
    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });

    return { h, all, grid: () => gridElOf(h) };
}

function applied(h) {
    const grid = gridElOf(h);

    return {
        cols: Number(grid.style.getPropertyValue("--sl-tv-grid-cols")),
        tileWidth: parseInt(grid.style.getPropertyValue("--sl-tv-tile-w"), 10)
    };
}

// The rows and columns of `count` tiles at the applied size fit the box,
// and no tile is wider than its column.
function assertFits(count, { cols, tileWidth }, box) {
    const rows = Math.ceil(count / cols);
    const columnWidth = (box.width - GAP * (cols - 1)) / cols;
    const tileHeight = tileWidth * 9 / 16;

    assert.ok(tileWidth <= columnWidth + 1e-9, `tile ${tileWidth} <= column ${columnWidth}`);
    assert.ok(cols * tileWidth + GAP * (cols - 1) <= box.width + 1e-9, "fits the width");
    assert.ok(rows * tileHeight + GAP * (rows - 1) <= box.height + 1e-9,
        `fits the height: ${rows} x ${tileHeight} + gaps <= ${box.height}`);
}

test("1 student, measured live grid 1466 x 622: height-limited tile 920px, fits (was 1449.6 x 815.4)", async () => {
    const { h } = await tilesView(1, 1466, 622);
    const layout = applied(h);
    const box = contentBox(1466, 622);

    assert.equal(layout.cols, 1);
    assert.equal(layout.tileWidth, 920, "floor(518 * 16 / 9)");
    assert.ok(layout.tileWidth * 9 / 16 <= box.height, "517.5px tall in 518px");
    assert.ok(layout.tileWidth < box.width, "narrower than the column: centred, not column-wide");
    assertFits(1, layout, box);
    assert.equal(h.tilesState().tileWidth, "920px", "exposed for the console check");
});

test("1 student on a tall grid (520 x 800): width-limited, the full column", async () => {
    const { h } = await tilesView(1, 520, 800);
    const layout = applied(h);

    assert.equal(layout.cols, 1);
    assert.equal(layout.tileWidth, 504, "the whole column");
    assertFits(1, layout, contentBox(520, 800));
});

test("2 students (1466 x 622): two columns, width-limited 721px", async () => {
    const { h } = await tilesView(2, 1466, 622);
    const layout = applied(h);

    assert.equal(layout.cols, 2);
    assert.equal(layout.tileWidth, 721, "(1450 - 8) / 2: the full column");
    assertFits(2, layout, contentBox(1466, 622));
});

test("3 students (1466 x 622): three columns, width-limited 478px", async () => {
    const { h } = await tilesView(3, 1466, 622);
    const layout = applied(h);

    assert.equal(layout.cols, 3);
    assert.equal(layout.tileWidth, 478, "(1450 - 16) / 3");
    assertFits(3, layout, contentBox(1466, 622));
});

test("4 students (1466 x 622): 2 x 2, height-limited 453px (column is 721px)", async () => {
    const { h } = await tilesView(4, 1466, 622);
    const layout = applied(h);
    const box = contentBox(1466, 622);

    assert.equal(layout.cols, 2);
    assert.equal(layout.tileWidth, 453, "floor((518 - 8) / 2 * 16 / 9)");
    assert.ok(layout.tileWidth < (box.width - GAP) / 2, "capped below the column width");
    assertFits(4, layout, box);
});

test("any page size on many grid sizes: the applied tiles always fit, never wider than a column", async () => {
    const sizes = [[1466, 622], [1280, 720], [800, 900], [520, 800], [1920, 500], [640, 360], [1000, 1000]];
    const counts = [1, 2, 3, 4, 5, 6, 7, 9, 12, 20];

    for (const [width, height] of sizes) {
        const { h, all } = await tilesView(20, width, height);

        for (const count of counts) {
            await h.sendTiles({ layout: "tiles", ids: all.slice(0, count), pageSize: 20 });
            assertFits(count, applied(h), contentBox(width, height));
        }
    }
});

test("students join and leave: the size follows (1 -> 2 -> 4 -> 1)", async () => {
    const { h, all } = await tilesView(4, 1466, 622);

    await h.sendTiles({ layout: "tiles", ids: all.slice(0, 1), pageSize: 20 });
    assert.deepEqual(applied(h), { cols: 1, tileWidth: 920 });

    await h.sendTiles({ layout: "tiles", ids: all.slice(0, 2), pageSize: 20 });
    assert.deepEqual(applied(h), { cols: 2, tileWidth: 721 });

    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });
    assert.deepEqual(applied(h), { cols: 2, tileWidth: 453 });

    await h.sendTiles({ layout: "tiles", ids: all.slice(0, 1), pageSize: 20 });
    assert.deepEqual(applied(h), { cols: 1, tileWidth: 920 });
});

test("the grid resizes (window, enlarged panel opening): the size is re-applied", async () => {
    const { h, all } = await tilesView(1, 1466, 622);

    // The enlarged panel opens beside the grid: the grid gets narrower.
    h.teacherTest().tileClick(all[0]);
    await h.flush();
    assert.equal(h.tilesState().panel.open, true);

    await h.resizeGrid(780, 622);

    const layout = applied(h);

    assert.equal(layout.tileWidth, 764, "width-limited now: 780 - 16");
    assertFits(1, layout, contentBox(780, 622));
});

test("CSS: tiles capped at the applied width and centred; overflow never cut off at the top", async () => {
    const { h } = await tilesView(1, 1466, 622);
    const css = h.document.getElementById("sl-teacher-view-style").textContent;

    assert.match(css, /\.sl-tv-grid \.sl-tv-tile \{ width: 100%; max-width: var\(--sl-tv-tile-w, none\); justify-self: center; \}/);
    assert.match(css, /\.sl-tv-grid \{[^}]*align-content: center; align-content: safe center;/);
    // Unchanged: the tile video's fit (cropping is a separate decision).
    assert.match(css, /\.sl-tv-tile video \{[^}]*object-fit: cover;/);
});

test("v1005 untouched: Jitsi's covered #largeVideo stays paused in the Tiles view", async () => {
    const h = createHarness();
    const all = ids(1);

    all.forEach(id => h.addParticipant(id));

    const large = h.document.createElement("video");

    large.id = "largeVideo";
    large.autoplay = true;
    h.document.body.appendChild(large);
    large.srcObject = { id: "stream-large" };

    h.document._gridSize = { width: 1466, height: 622 };
    await h.startTeacher();
    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });

    assert.equal(large.paused, true);
    assert.deepEqual(applied(h), { cols: 1, tileWidth: 920 });
});
