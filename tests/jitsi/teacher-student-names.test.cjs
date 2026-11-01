/*
 * The teacher view's tiles show a class student's live Jitsi name with the
 * student's REGISTERED name under it (deploy/jitsi/custom.js, SL_STUDENT_NAMES
 * from the teacher's page). Matched by participant ID only, never by name.
 *
 *   npm run test:jitsi
 *
 * Runs custom.js against the fake DOM / Jitsi model in harness.cjs. The parent
 * page side (who sends the list, built from the authorized participant map) is
 * covered in tests/ui/classroom-identity-panels.test.tsx.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

let epoch = 0;

async function sendNames(h, entries, extra = {}) {
    epoch += 1;
    h.postFromParent({ type: "SL_STUDENT_NAMES", v: 1, epoch, names: entries, ...extra });
    await h.flush();
}

function label(h, id) {
    const tile = h.tile(id);

    assert.ok(tile, "tile for " + id);

    const nameEl = tile.el.children.find(child => child.classList.contains("sl-tv-name"));
    const [primary, secondary] = nameEl.children;

    return {
        primary: primary.textContent,
        secondary: nameEl.classList.contains("sl-has-registered") ? secondary.textContent : null,
        title: tile.el.title
    };
}

async function rename(h, id, name) {
    h.participants.remote.get(id).name = name;
    h.change();
    await h.flush();
}

async function classroom(people) {
    const h = createHarness();

    people.forEach(([id, name]) => h.addParticipant(id, { name }));
    await h.startTeacher();

    return h;
}

test("a registered student: live Jitsi name first, registered name under it; the same name only once", async () => {
    const h = await classroom([["neth0001", "Nethi Perera"], ["same0001", "Kamal Silva"]]);

    await sendNames(h, [["neth0001", "Nethmi Silva"], ["same0001", "  Kamal   Silva "]]);

    assert.deepEqual(label(h, "neth0001"), { primary: "Nethi Perera", secondary: "Nethmi Silva", title: "Nethi Perera (Nethmi Silva)" });
    assert.deepEqual(label(h, "same0001"), { primary: "Kamal Silva", secondary: null, title: "Kamal Silva" }, "identical: shown once");
});

test("a temporary rename updates the tile at once; the registered name stays", async () => {
    const h = await classroom([["neth0001", "Nethmi Silva"]]);

    await sendNames(h, [["neth0001", "Nethmi Silva"]]);
    assert.equal(label(h, "neth0001").secondary, null);

    await rename(h, "neth0001", "Nethi (temp)");
    assert.deepEqual(label(h, "neth0001"), { primary: "Nethi (temp)", secondary: "Nethmi Silva", title: "Nethi (temp) (Nethmi Silva)" });

    await rename(h, "neth0001", "Nethmi Silva");
    assert.equal(label(h, "neth0001").secondary, null, "renamed back: once again");
});

test("duplicate Jitsi names: each tile gets its own registered name, by participant ID", async () => {
    const h = await classroom([["amal0001", "Amal Perera"], ["amal0002", "Amal Perera"]]);

    await sendNames(h, [["amal0001", "Amal Perera"], ["amal0002", "Amali Fernando"]]);

    assert.equal(label(h, "amal0001").secondary, null);
    assert.equal(label(h, "amal0002").secondary, "Amali Fernando");
});

test("reconnect: the new participant ID gets the registered name; the old ID's mapping is gone", async () => {
    const h = await classroom([["neth0001", "Nethi"]]);

    await sendNames(h, [["neth0001", "Nethmi Silva"]]);
    assert.equal(label(h, "neth0001").secondary, "Nethmi Silva");

    // She reconnects: Jitsi drops the old participant and adds the new one; the
    // page sends the new map (the whole list replaces the old one).
    h.removeParticipant("neth0001");
    h.addParticipant("neth0002", { name: "Nethi" });
    h.change();
    await h.flush();
    await sendNames(h, [["neth0002", "Nethmi Silva"]]);

    assert.equal(h.tile("neth0001"), null);
    assert.equal(label(h, "neth0002").secondary, "Nethmi Silva");

    // A participant later reusing nothing of hers: an unmapped ID shows its own name only.
    h.addParticipant("neth0001", { name: "Someone else" });
    h.change();
    await h.flush();
    assert.deepEqual(label(h, "neth0001"), { primary: "Someone else", secondary: null, title: "Someone else" });
});

test("the teacher and unmatched participants keep their existing labels and fallback", async () => {
    const h = await classroom([["gues0001", "Visitor"], ["anon0001", "x"], ["stud0001", ""]]);

    await rename(h, "anon0001", "");
    await rename(h, "stud0001", ""); // the harness names a participant by its ID by default
    await sendNames(h, [["stud0001", "Registered Only"]]);

    assert.deepEqual(label(h, "gues0001"), { primary: "Visitor", secondary: null, title: "Visitor" });
    assert.equal(label(h, "anon0001").primary, "Participant", "existing fallback");
    assert.deepEqual(label(h, "stud0001"), { primary: "Registered Only", secondary: null, title: "Registered Only" },
        "a student without a Jitsi name: the registered name alone");
    assert.equal(label(h, "teacher01").primary, "Teacher (You)");
    assert.equal(label(h, "teacher01").secondary, null);
});

test("only the embedding SL Classroom page is listened to; malformed, oversized and older lists are ignored", async () => {
    const h = await classroom([["neth0001", "Nethi"]]);

    await sendNames(h, [["neth0001", "Nethmi Silva"]]);

    const foreign = { type: "SL_STUDENT_NAMES", v: 1, epoch: 1e9, names: [["neth0001", "Spoofed"]] };

    h.postFromParent(foreign, { origin: "https://evil.example" });
    h.postFromParent(foreign, { source: {} }); // another frame, right origin
    await h.flush();

    for (const names of [
        [["bad id", "X"]],
        [["neth0001", ""]],
        [["neth0001", "x".repeat(201)]],
        [["neth0001", "A"], ["neth0001", "B"]],
        [["neth0001"]],
        Array.from({ length: 501 }, (_, i) => ["id" + String(i).padStart(4, "0"), "N"]),
        "neth0001"
    ]) {
        await sendNames(h, names);
    }

    await sendNames(h, [["neth0001", "Missing v"]], { v: 2 });

    h.postFromParent({ type: "SL_STUDENT_NAMES", v: 1, epoch: 0, names: [["neth0001", "Older"]] });
    await h.flush();

    assert.equal(label(h, "neth0001").secondary, "Nethmi Silva");
});

test("a student's iframe (not a moderator) never shows the teacher view, so never shows the names", async () => {
    const student = createHarness();

    student.participants.local = { id: "stud0009", role: "participant", name: "Student" };
    student.addParticipant("neth0001", { name: "Nethi" });
    await student.startTeacher();
    await sendNames(student, [["neth0001", "Nethmi Silva"]]);

    assert.equal(student.tile("neth0001"), null);
});

test("display only: the names never change what is received or the view's other messages", async () => {
    const h = await classroom([["neth0001", "Nethi"], ["amal0001", "Amal"]]);
    const sentBefore = h.sent.length;

    await sendNames(h, [["neth0001", "Nethmi Silva"], ["amal0001", "Amal Perera"]]);
    assert.equal(h.sent.length, sentBefore, "no new receiver constraints");

    // The view's own messages still work after it: hidden and shown again.
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 50, enabled: false });
    await h.flush();
    assert.equal(h.tile("neth0001"), null);

    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 51, enabled: true });
    h.change();
    await h.flush();
    assert.equal(label(h, "neth0001").secondary, "Nethmi Silva", "kept across the view being rebuilt");
});

// ---- What the teacher actually sees (1023) ---------------------------------------
//
// A tile without live video hides its name label (CSS: .sl-no-video
// .sl-tv-name) and shows the placeholder instead, so the registered name must be
// in the placeholder too. Tiles view and the enlarged panel show it as well.

function placeholderText(h, id) {
    const placeholder = h.tile(id).el.children.find(child => child.classList.contains("sl-tv-placeholder"));
    const part = cls => placeholder.children.find(child => child.classList.contains(cls)).textContent;

    return { name: part("sl-tv-ph-name"), registered: part("sl-tv-ph-registered") };
}

test("camera off: the visible placeholder shows the Jitsi name with the registered name under it", async () => {
    const h = createHarness();

    h.addParticipant("neth0001", { name: "Nethmi Silva test", camera: false });
    h.addParticipant("same0001", { name: "Kamal Silva", camera: false });
    h.addParticipant("gues0001", { name: "Visitor", camera: false });
    await h.startTeacher();
    await sendNames(h, [["neth0001", "Nethmi Silva"], ["same0001", "Kamal Silva"]]);

    assert.ok(h.tile("neth0001").el.classList.contains("sl-no-video"), "the label is hidden here");
    assert.deepEqual(placeholderText(h, "neth0001"), { name: "Nethmi Silva test", registered: "Nethmi Silva" });
    assert.deepEqual(placeholderText(h, "same0001"), { name: "Kamal Silva", registered: "" }, "same name: once");
    assert.deepEqual(placeholderText(h, "gues0001"), { name: "Visitor", registered: "" }, "guest unchanged");
    assert.equal(placeholderText(h, "teacher01").registered, "", "the teacher's own tile unchanged");

    // A rename and a camera turned on: both follow.
    await rename(h, "neth0001", "Nethi");
    assert.deepEqual(placeholderText(h, "neth0001"), { name: "Nethi", registered: "Nethmi Silva" });

    h.setCamera("neth0001", true);
    h.change();
    await h.run(2000);
    assert.equal(h.tileModes().neth0001, "live");
    assert.deepEqual(label(h, "neth0001"), { primary: "Nethi", secondary: "Nethmi Silva", title: "Nethi (Nethmi Silva)" });
});

test("diagnostics: what was received and where it shows (IDs only, no names)", async () => {
    const h = createHarness();

    h.addParticipant("live0001", { name: "Temp A" });
    h.addParticipant("off00001", { name: "Temp B", camera: false });
    await h.startTeacher();
    await h.run(2000);
    await sendNames(h, [["live0001", "Reg A"], ["off00001", "Reg B"], ["gone0001", "Reg C"]]);

    const report = JSON.parse(JSON.stringify(h.teacherTest().studentNames())); // out of the custom.js context

    assert.equal(report.count, 3);
    assert.equal(report.viewShowing, true);
    assert.deepEqual(report.tiles, [
        { id: "live0001", tile: true, shown: "label" },
        { id: "off00001", tile: true, shown: "placeholder" },
        { id: "gone0001", tile: false, shown: "" }
    ]);
    assert.ok(!JSON.stringify(report).includes("Reg "), "no names in the report");
});

test("Tiles view and the enlarged panel show the registered name too", async () => {
    const h = createHarness();

    h.addParticipant("neth0001", { name: "Nethmi Silva test" });
    h.addParticipant("off00001", { name: "Temp B", camera: false });
    await h.startTeacher();
    await sendNames(h, [["neth0001", "Nethmi Silva"], ["off00001", "Reg B"]]);
    await h.sendTiles({ layout: "tiles", ids: ["neth0001", "off00001"] });
    await h.run(2000);

    assert.equal(label(h, "neth0001").secondary, "Nethmi Silva");
    assert.deepEqual(placeholderText(h, "off00001"), { name: "Temp B", registered: "Reg B" });

    h.teacherTest().tileClick("neth0001");
    await h.flush();

    const panel = Array.from(h.document.documentElement.walk()).find(el => el.classList && el.classList.contains("sl-tv-panel"));
    const text = cls => Array.from(panel.walk()).find(el => el.classList && el.classList.contains(cls)).textContent;

    assert.equal(text("sl-tv-panel-name"), "Nethmi Silva test");
    assert.equal(text("sl-tv-panel-registered"), "Nethmi Silva");
});
