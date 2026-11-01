/*
 * The teacher view's tiles show each mapped class student's visits in this
 * session (deploy/jitsi/custom.js, SL_STUDENT_HISTORY from the teacher's page):
 * a summary line on the tile (video label or camera-off placeholder), every
 * visit in the tooltip and in the enlarged panel. Matched by participant ID.
 *
 *   npm run test:jitsi
 *
 * Runs custom.js against the fake DOM / Jitsi model in harness.cjs. The page
 * side (fetch, events, the participant ID mapping) is covered in
 * tests/attendance/visit-history.test.cjs and the UI source tests.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const at = (h, m) => new Date(2026, 10, 1, h, m).getTime();
const t = ms => clock.format(new Date(ms));

// Joined 09:05, left 09:35, rejoined 09:42, left 10:10, rejoined 10:18 (open).
const NETHMI = [[at(9, 5), at(9, 35)], [at(9, 42), at(10, 10)], [at(10, 18), null]];

let epoch = 0;

async function sendHistory(h, entries, extra = {}) {
    epoch += 1;
    h.postFromParent({ type: "SL_STUDENT_HISTORY", v: 1, epoch, entries, ...extra });
    await h.flush();
}

function tileParts(h, id) {
    const tile = h.tile(id);

    assert.ok(tile, "tile for " + id);

    const nameEl = tile.el.children.find(child => child.classList.contains("sl-tv-name"));
    const placeholder = tile.el.children.find(child => child.classList.contains("sl-tv-placeholder"));
    const ph = cls => placeholder.children.find(child => child.classList.contains(cls)).textContent;

    return {
        labelHistory: nameEl.classList.contains("sl-has-history") ? nameEl.children[2].textContent : null,
        placeholderHistory: ph("sl-tv-ph-history"),
        noVideo: tile.el.classList.contains("sl-no-video"),
        title: tile.el.title
    };
}

async function classroom(people) {
    const h = createHarness();

    people.forEach(([id, name, camera = true]) => h.addParticipant(id, { name, camera }));
    await h.startTeacher();
    await h.run(2000);

    return h;
}

test("several visits, the current one open: 'Connected since … · Visit 3' and every visit in the tooltip", async () => {
    const h = await classroom([["neth0001", "Nethmi Silva"]]);

    await sendHistory(h, [["neth0001", NETHMI]]);

    const parts = tileParts(h, "neth0001");

    assert.equal(parts.labelHistory, "Connected since " + t(at(10, 18)) + " · Visit 3");
    assert.equal(parts.title, [
        "Nethmi Silva",
        "Joined " + t(at(9, 5)), "Left " + t(at(9, 35)),
        "Rejoined " + t(at(9, 42)), "Left " + t(at(10, 10)),
        "Rejoined " + t(at(10, 18)), "Currently connected"
    ].join("\n"));
});

test("one visit; a closed latest visit while in the room says so honestly; camera off uses the placeholder", async () => {
    const h = await classroom([["one00001", "A"], ["back0001", "B"], ["off00001", "C", false]]);

    await sendHistory(h, [
        ["one00001", [[at(9, 0), null]]],
        // The record is catching up: the latest visit is closed, but B is here.
        ["back0001", [[at(9, 0), at(9, 30)]]],
        ["off00001", [[at(9, 0), null]]]
    ]);

    assert.equal(tileParts(h, "one00001").labelHistory, "Connected since " + t(at(9, 0)) + " · Visit 1");
    assert.ok(tileParts(h, "one00001").title.endsWith("Joined " + t(at(9, 0)) + "\nCurrently connected"));
    assert.equal(tileParts(h, "back0001").labelHistory, "Connected now, last left " + t(at(9, 30)) + " · Visit 1");

    const off = tileParts(h, "off00001");

    assert.ok(off.noVideo, "the label is hidden for this tile");
    assert.equal(off.placeholderHistory, "Connected since " + t(at(9, 0)) + " · Visit 1");
});

test("reconnect: the new participant ID gets the history, the old one is cleared; duplicates stay apart", async () => {
    const h = await classroom([["neth0001", "Amal Perera"], ["amal0002", "Amal Perera"]]);

    await sendHistory(h, [["neth0001", NETHMI], ["amal0002", [[at(9, 1), null]]]]);
    assert.ok(tileParts(h, "neth0001").labelHistory.endsWith("Visit 3"));
    assert.ok(tileParts(h, "amal0002").labelHistory.endsWith("Visit 1"), "same name, own history");

    h.removeParticipant("neth0001");
    h.addParticipant("neth0002", { name: "Amal Perera" });
    h.change();
    await h.run(2000);

    const reconnected = [...NETHMI.slice(0, 2), [at(10, 18), at(10, 30)], [at(10, 31), null]];

    await sendHistory(h, [["neth0002", reconnected], ["amal0002", [[at(9, 1), null]]]]);

    assert.equal(h.tile("neth0001"), null);
    assert.equal(tileParts(h, "neth0002").labelHistory, "Connected since " + t(at(10, 31)) + " · Visit 4");

    // A participant who later shows up with the old ID has no history.
    h.addParticipant("neth0001", { name: "Someone" });
    h.change();
    await h.run(2000);
    assert.equal(tileParts(h, "neth0001").labelHistory, null);
});

test("the teacher, guests and unmapped students show no history and look exactly as before", async () => {
    const h = await classroom([["gues0001", "Visitor"], ["stud0001", "Student"]]);

    await sendHistory(h, [["stud0001", [[at(9, 0), null]]]]);

    for (const id of ["teacher01", "gues0001"]) {
        const parts = tileParts(h, id);

        assert.equal(parts.labelHistory, null);
        assert.equal(parts.placeholderHistory, "");
        assert.ok(!parts.title.includes("\n"));
    }
});

test("Tiles view: a student who left (not in the meeting) is never 'connected'; the panel lists every visit", async () => {
    const h = await classroom([["neth0001", "Nethmi Silva"], ["gone0001", "Gone"]]);

    await sendHistory(h, [
        ["neth0001", NETHMI],
        // The leave never arrived (crashed tab): the record is still open.
        ["gone0001", [[at(9, 0), null]]]
    ]);
    h.removeParticipant("gone0001");
    h.change();
    await h.sendTiles({ layout: "tiles", ids: ["neth0001", "gone0001"] });
    await h.run(2000);

    assert.equal(tileParts(h, "neth0001").labelHistory, "Connected since " + t(at(10, 18)) + " · Visit 3");

    const gone = tileParts(h, "gone0001");

    assert.equal(gone.placeholderHistory, "Not connected (leave not recorded) · Visit 1");
    assert.ok(gone.title.endsWith("Leave not recorded"));
    assert.ok(!gone.title.includes("Currently connected"));

    h.teacherTest().tileClick("neth0001");
    await h.flush();

    const panel = Array.from(h.document.documentElement.walk()).find(el => el.classList && el.classList.contains("sl-tv-panel"));
    const find = cls => Array.from(panel.walk()).find(el => el.classList && el.classList.contains(cls));

    assert.equal(find("sl-tv-panel-history").hidden, false);
    assert.equal(find("sl-tv-panel-history-summary").textContent, "Connected since " + t(at(10, 18)) + " · Visit 3");
    assert.deepEqual(find("sl-tv-panel-history-list").children.map(li => li.textContent), [
        "Joined " + t(at(9, 5)), "Left " + t(at(9, 35)),
        "Rejoined " + t(at(9, 42)), "Left " + t(at(10, 10)),
        "Rejoined " + t(at(10, 18)), "Currently connected"
    ]);
});

test("a long history: the latest 50 visits are shown and the rest are counted, never shown as complete", async () => {
    const h = await classroom([["long0001", "Long"]]);
    const visits = Array.from({ length: 50 }, (_, i) => [at(8, 0) + i * 60000, at(8, 0) + i * 60000 + 30000]);

    await sendHistory(h, [["long0001", visits, 72]]);

    const parts = tileParts(h, "long0001");

    assert.ok(parts.labelHistory.endsWith("Visit 72"));
    assert.ok(parts.title.split("\n")[1] === "22 earlier visits not shown");
    assert.ok(!parts.title.includes("\nJoined "), "no visit is presented as the first one");
});

test("only the embedding page is listened to; malformed, oversized and older histories are ignored", async () => {
    const h = await classroom([["neth0001", "Nethmi Silva"]]);

    await sendHistory(h, [["neth0001", NETHMI]]);

    const before = tileParts(h, "neth0001").labelHistory;
    const spoof = { type: "SL_STUDENT_HISTORY", v: 1, epoch: 1e9, entries: [["neth0001", [[at(11, 0), null]]]] };

    h.postFromParent(spoof, { origin: "https://evil.example" });
    h.postFromParent(spoof, { source: {} });
    await h.flush();

    const good = [at(9, 0), null];

    for (const entries of [
        [["bad id", [good]]],
        [["neth0001", []]],
        [["neth0001", [[0, null]]]],
        [["neth0001", [[at(9, 0), at(8, 0)]]]], // left before joined
        [["neth0001", [[at(9, 0), null], [at(8, 0), null]]]], // not oldest first
        [["neth0001", [[1.5, null]]]],
        [["neth0001", [good], 1]], // a total no larger than what is sent
        [["neth0001", Array.from({ length: 51 }, () => good)]],
        [["neth0001", [good]], ["neth0001", [good]]],
        Array.from({ length: 501 }, (_, i) => ["id" + String(i).padStart(4, "0"), [good]]),
        "neth0001"
    ]) {
        await sendHistory(h, entries);
    }

    await sendHistory(h, [["neth0001", [good]]], { v: 2 });
    h.postFromParent({ type: "SL_STUDENT_HISTORY", v: 1, epoch: 0, entries: [["neth0001", [good]]] });
    await h.flush();

    assert.equal(tileParts(h, "neth0001").labelHistory, before);
});

test("a student's iframe never shows it; the names and the receive policy are unaffected", async () => {
    const student = createHarness();

    student.participants.local = { id: "stud0009", role: "participant", name: "Student" };
    student.addParticipant("neth0001", { name: "Nethi" });
    await student.startTeacher();
    await sendHistory(student, [["neth0001", NETHMI]]);
    assert.equal(student.tile("neth0001"), null);

    const h = await classroom([["neth0001", "Nethmi Silva test"]]);
    const sentBefore = h.sent.length;

    h.postFromParent({ type: "SL_STUDENT_NAMES", v: 1, epoch: 1, names: [["neth0001", "Nethmi Silva"]] });
    await sendHistory(h, [["neth0001", NETHMI]]);

    const nameEl = h.tile("neth0001").el.children.find(child => child.classList.contains("sl-tv-name"));

    assert.deepEqual(nameEl.children.map(child => child.textContent),
        ["Nethmi Silva test", "Nethmi Silva", "Connected since " + t(at(10, 18)) + " · Visit 3"]);
    assert.equal(h.sent.length, sentBefore, "no new receiver constraints");

    const report = JSON.parse(JSON.stringify(h.teacherTest().studentHistory()));

    assert.deepEqual(report.tiles, [{ id: "neth0001", visits: 3, total: 3, tile: true, shown: "label" }]);
});
