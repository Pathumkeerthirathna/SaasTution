/*
 * Participant identity (components/Jitsi/participant-identity.mjs): which live
 * Jitsi participant is which class student, by studentId -> participantId only.
 *
 *   node --test tests/jitsi/participant-identity.test.cjs
 *
 * Display names are deliberately duplicated, renamed and teacher-like in these
 * fixtures: none of them may change who is who.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const load = () => import(pathToFileURL(path.join(root, "components/Jitsi/participant-identity.mjs")).href);
const loadRegister = () => import(pathToFileURL(path.join(root, "components/Jitsi/class-register.mjs")).href);

// Two students share a name; one is named exactly like the teacher.
const roster = [
    { studentId: "s-amal-1", displayName: "Amal Perera" },
    { studentId: "s-amal-2", displayName: "Amal Perera" },
    { studentId: "s-teacher-like", displayName: "Mr. Silva (Teacher)" },
    { studentId: "s-bimal", displayName: "Bimal" }
];

const live = (participantId, displayName, status = { audioMuted: true, videoMuted: true }) =>
    ({ participantId, displayName, role: "participant", status });

test("studentIdByParticipantId: current entries only; own and ambiguous IDs are no one", async () => {
    const { studentIdByParticipantId } = await load();

    const map = studentIdByParticipantId({ a: "aaaa1111", b: "bbbb2222", c: "teach001", d: "bad id!", e: "dupe0001", f: "dupe0001" }, ["teach001"]);

    assert.deepEqual([...map.entries()].sort(), [["aaaa1111", "a"], ["bbbb2222", "b"]]);
    assert.equal(studentIdByParticipantId(undefined).size, 0);
});

test("duplicate names: each student is matched to their own participant", async () => {
    const { resolveClassroomIdentity, liveParticipantForStudent } = await load();
    const participants = [
        live("teach001", "Mr. Silva (Teacher)"),
        live("amal0001", "Amal Perera", { audioMuted: false, videoMuted: false }),
        live("amal0002", "Amal Perera", { audioMuted: true, videoMuted: true })
    ];

    const { locations, others } = resolveClassroomIdentity({
        students: roster,
        participantMap: { "s-amal-1": "amal0001", "s-amal-2": "amal0002" },
        participants,
        ownParticipantIds: ["teach001"]
    });

    assert.deepEqual(locations.get("s-amal-1"), { participantId: "amal0001", roomLabel: null });
    assert.deepEqual(locations.get("s-amal-2"), { participantId: "amal0002", roomLabel: null });
    assert.equal(locations.has("s-bimal"), false);
    assert.equal(locations.has("s-teacher-like"), false, "absent: not registered, and a name never matches");
    assert.deepEqual(others, [], "the teacher (own ID) is not an 'other participant'");

    // The mute target and mic / camera state of each row: the right person.
    assert.equal(liveParticipantForStudent("s-amal-1", locations, participants).participantId, "amal0001");
    assert.equal(liveParticipantForStudent("s-amal-2", locations, participants).participantId, "amal0002");
    assert.equal(liveParticipantForStudent("s-amal-1", locations, participants).status.audioMuted, false);
    assert.equal(liveParticipantForStudent("s-amal-2", locations, participants).status.audioMuted, true);
    assert.equal(liveParticipantForStudent("s-bimal", locations, participants), undefined);
});

test("a renamed participant stays present; a stranger using a student's name is not that student", async () => {
    const { resolveClassroomIdentity } = await load();

    const { locations, others } = resolveClassroomIdentity({
        students: roster,
        participantMap: { "s-bimal": "bima0001" },
        participants: [live("bima0001", "Totally Different Name"), live("xxxx0001", "Bimal")],
        ownParticipantIds: []
    });

    assert.deepEqual(locations.get("s-bimal"), { participantId: "bima0001", roomLabel: null });
    assert.deepEqual(others.map(o => o.participantId), ["xxxx0001"], "the name-alike is an 'other participant'");
});

test("a student named like the teacher is a student; the teacher's own ID never resolves to a student", async () => {
    const { resolveClassroomIdentity } = await load();

    // A student registered the teacher's participant ID (a claim): ignored here.
    const { locations, others } = resolveClassroomIdentity({
        students: roster,
        participantMap: { "s-teacher-like": "tlik0001", "s-bimal": "teach001" },
        participants: [live("teach001", "Mr. Silva (Teacher)"), live("tlik0001", "Mr. Silva (Teacher)")],
        ownParticipantIds: ["teach001"]
    });

    assert.deepEqual(locations.get("s-teacher-like"), { participantId: "tlik0001", roomLabel: null });
    assert.equal(locations.has("s-bimal"), false, "the teacher's own ID is never a student");
    assert.deepEqual(others, []);
});

test("stale map entries are not presence; only live (or elsewhere-labelled) IDs are", async () => {
    const { resolveClassroomIdentity } = await load();

    const { locations } = resolveClassroomIdentity({
        students: roster,
        participantMap: { "s-amal-1": "gone0001", "s-amal-2": "else0001", "s-bimal": "empt0001" },
        participants: [],
        roomLabelByParticipantId: { else0001: "Room 2", empt0001: "" },
        ownParticipantIds: []
    });

    assert.equal(locations.has("s-amal-1"), false, "left the class: absent");
    assert.deepEqual(locations.get("s-amal-2"), { participantId: "else0001", roomLabel: "Room 2" });
    assert.equal(locations.has("s-bimal"), false, "an empty label is not a room");
});

test("this room wins over an elsewhere label; reconnect: old ID gone, new ID mapped", async () => {
    const { resolveClassroomIdentity } = await load();
    const base = { students: roster, ownParticipantIds: [] };

    const here = resolveClassroomIdentity({
        ...base,
        participantMap: { "s-bimal": "bima0001" },
        participants: [live("bima0001", "Bimal")],
        roomLabelByParticipantId: { bima0001: "Main room" }
    });

    assert.deepEqual(here.locations.get("s-bimal"), { participantId: "bima0001", roomLabel: null });

    // Mid-reconnect: the old ID left, the new one is live but not registered yet.
    const gap = resolveClassroomIdentity({ ...base, participantMap: { "s-bimal": "bima0001" }, participants: [live("bima0002", "Bimal")] });

    assert.equal(gap.locations.has("s-bimal"), false);
    assert.deepEqual(gap.others.map(o => o.participantId), ["bima0002"]);

    const after = resolveClassroomIdentity({ ...base, participantMap: { "s-bimal": "bima0002" }, participants: [live("bima0002", "Bimal")] });

    assert.deepEqual(after.locations.get("s-bimal"), { participantId: "bima0002", roomLabel: null });
    assert.deepEqual(after.others, []);
});

test("an ID registered by two students resolves to neither", async () => {
    const { resolveClassroomIdentity } = await load();

    const { locations, others } = resolveClassroomIdentity({
        students: roster,
        participantMap: { "s-amal-1": "same0001", "s-amal-2": "same0001" },
        participants: [live("same0001", "Amal Perera")],
        ownParticipantIds: []
    });

    assert.equal(locations.size, 0);
    assert.deepEqual(others.map(o => o.participantId), ["same0001"]);
});

test("no roster yet: nobody is an 'other participant'", async () => {
    const { resolveClassroomIdentity } = await load();

    assert.deepEqual(resolveClassroomIdentity({ students: undefined, participantMap: {}, participants: [live("aaaa0001", "A")] }).others, []);
});

test("sessionStatusFor: attendance 'in session' and room by student ID", async () => {
    const { sessionStatusFor } = await load();
    const locations = new Map([["a", { participantId: "aaaa0001", roomLabel: null }], ["b", { participantId: "bbbb0001", roomLabel: "Room 1" }]]);

    assert.deepEqual(sessionStatusFor("a", locations), { inSession: true, roomLabel: null });
    assert.deepEqual(sessionStatusFor("b", locations), { inSession: true, roomLabel: "Room 1" });
    assert.deepEqual(sessionStatusFor("c", locations), { inSession: false, roomLabel: null });
    assert.deepEqual(sessionStatusFor("a", undefined), { inSession: false, roomLabel: null });
});

test("class register split: by student ID, with labels and participant IDs", async () => {
    const { splitClassRegister } = await loadRegister();
    const locations = new Map([
        ["s-amal-1", { participantId: "amal0001", roomLabel: null }],
        ["s-bimal", { participantId: "bima0001", roomLabel: "Room 1" }]
    ]);

    const register = splitClassRegister(roster, locations);

    assert.deepEqual(register.present.map(s => s.studentId), ["s-amal-1", "s-bimal"]);
    assert.deepEqual(register.absent.map(s => s.studentId), ["s-amal-2", "s-teacher-like"], "same name as a present student, still absent");
    assert.equal(register.elsewhereLabel("s-bimal"), "Room 1");
    assert.equal(register.elsewhereLabel("s-amal-1"), undefined);
    assert.equal(register.participantIdOf("s-amal-1"), "amal0001");
    assert.equal(register.participantIdOf("s-amal-2"), undefined);

    const empty = splitClassRegister(undefined, undefined);

    assert.deepEqual([empty.present, empty.absent], [[], []]);
});

test("presence grace (display only): kept for 6 s after vanishing, then absent", async () => {
    const { applyPresenceGrace } = await load();
    const a = { participantId: "aaaa0001", roomLabel: null };

    let step = applyPresenceGrace(new Map(), new Map([["a", a]]), 1000, 6000);

    assert.equal(step.display.get("a"), a);
    assert.equal(step.nextExpiryAt, null);

    // Vanished (reconnect): still shown, with an expiry.
    step = applyPresenceGrace(step.memory, new Map(), 2000, 6000);
    assert.equal(step.display.get("a"), a);
    assert.equal(step.nextExpiryAt, 7000);

    step = applyPresenceGrace(step.memory, new Map(), 6999, 6000);
    assert.equal(step.display.has("a"), true);

    step = applyPresenceGrace(step.memory, new Map(), 7000, 6000);
    assert.equal(step.display.has("a"), false, "expired");
    assert.equal(step.nextExpiryAt, null);

    // Back with a new ID within the grace: the new location replaces the old.
    const b = { participantId: "aaaa0002", roomLabel: "Room 1" };

    step = applyPresenceGrace(applyPresenceGrace(new Map(), new Map([["a", a]]), 0, 6000).memory, new Map([["a", b]]), 100, 6000);
    assert.equal(step.display.get("a"), b);
});

test("self-repair decision: missing or own stale entry re-registers; another tab's entry is left alone", async () => {
    const { shouldReregister } = await load();
    const own = ["old00001", "new00001"];

    assert.equal(shouldReregister({ localParticipantId: "new00001", mappedParticipantId: "new00001", ownParticipantIds: own }), false);
    assert.equal(shouldReregister({ localParticipantId: "new00001", mappedParticipantId: undefined, ownParticipantIds: own }), true, "server restarted");
    assert.equal(shouldReregister({ localParticipantId: "new00001", mappedParticipantId: "old00001", ownParticipantIds: own }), true, "our stale ID");
    assert.equal(shouldReregister({ localParticipantId: "new00001", mappedParticipantId: "tab20001", ownParticipantIds: own }), false, "another tab owns it");
    assert.equal(shouldReregister({ localParticipantId: null, mappedParticipantId: undefined, ownParticipantIds: [] }), false, "not joined yet");
});

test("backoff: doubles from the base, capped, with at most 20 % jitter", async () => {
    const { backoffDelay } = await load();
    const none = { random: () => 1 };

    assert.deepEqual([0, 1, 2, 3, 10].map(n => backoffDelay(n, none)), [1000, 2000, 4000, 8000, 30000]);
    assert.equal(backoffDelay(0, { random: () => 0 }), 800);
    assert.equal(backoffDelay(5, { baseMs: 5000, maxMs: 60000, random: () => 1 }), 60000);
});

test("the server's participant ID check is the same pattern as the client's", async () => {
    require("tsx/cjs/api").register();

    const { PARTICIPANT_ID_PATTERN } = await load();
    const server = require(path.join(root, "lib/classroom-participant-map.ts"));

    assert.equal(server.PARTICIPANT_ID_PATTERN.source, PARTICIPANT_ID_PATTERN.source);
    assert.equal(server.PARTICIPANT_ID_PATTERN.flags, PARTICIPANT_ID_PATTERN.flags);
    assert.ok(PARTICIPANT_ID_PATTERN.test("d92a7329"));
    assert.ok(!PARTICIPANT_ID_PATTERN.test("a/b"));
});

// ---- Display names (presentation only) -----------------------------------------

test("normalizeDisplayName: control / bidi characters removed, whitespace collapsed, length capped", async () => {
    const { normalizeDisplayName, DISPLAY_NAME_MAX_LENGTH } = await load();

    assert.equal(normalizeDisplayName("  Nethi\t\tperera\n"), "Nethi perera");
    assert.equal(normalizeDisplayName("Ne\u202Ethi\u2066 x\u0000"), "Nethi x");
    assert.equal(normalizeDisplayName("   "), "");
    assert.equal(normalizeDisplayName("é".repeat(DISPLAY_NAME_MAX_LENGTH + 5)), "é".repeat(DISPLAY_NAME_MAX_LENGTH));
    assert.equal(normalizeDisplayName("😀".repeat(DISPLAY_NAME_MAX_LENGTH + 1)).length, DISPLAY_NAME_MAX_LENGTH * 2, "cut by character, not UTF-16 unit");
    assert.equal(normalizeDisplayName(undefined), null);
    assert.equal(normalizeDisplayName(42), null);
});

test("studentDisplayLabel: 'Jitsi name (registered)' only when they differ", async () => {
    const { studentDisplayLabel } = await load();

    assert.equal(studentDisplayLabel("Nethi Perera", "Nethi Perera"), "Nethi Perera");
    assert.equal(studentDisplayLabel("Nethi Perera", "  Nethi   Perera "), "Nethi Perera");
    assert.equal(studentDisplayLabel("Nethi Perera", "Nethi (temp)"), "Nethi (temp) (Nethi Perera)");
    assert.equal(studentDisplayLabel("Nethi Perera", ""), "Nethi Perera");
    assert.equal(studentDisplayLabel("Nethi Perera", undefined), "Nethi Perera");
});

test("displayNameByParticipantId: by participant ID; live beats reported beats the rooms list; duplicates stay apart", async () => {
    const { displayNameByParticipantId } = await load();

    const names = displayNameByParticipantId({
        roomEntries: [
            { participantId: "amal0001", displayName: "Amal Perera" }, // rooms list (stale after renames)
            { participantId: "amal0002", displayName: "Amal Perera" },
            { participantId: "away0001", displayName: "Old name" },
            { participantId: null, displayName: "Unparseable" },
            { participantId: "anon0001", displayName: "" }
        ],
        participantMap: { "s-amal-1": "amal0001", "s-amal-2": "amal0002", "s-away": "away0001", "s-gone": "gone0001" },
        reportedNames: { "s-away": "Renamed in Room 2", "s-amal-2": "Amal 2 (temp)", "s-unmapped": "Nobody" },
        participants: [live("amal0001", "Amal (live)"), live("anon0002", "")]
    });

    assert.deepEqual(Object.fromEntries(names), {
        amal0001: "Amal (live)", // this room: live wins
        amal0002: "Amal 2 (temp)", // other room: the student's own report
        away0001: "Renamed in Room 2",
        anon0002: "" // live and nameless: known to be nameless
    });
});

test("displayNameByParticipantId: a report follows the student's CURRENT ID only (reconnect)", async () => {
    const { displayNameByParticipantId } = await load();

    const before = displayNameByParticipantId({ participantMap: { s1: "old00001" }, reportedNames: { s1: "Temp" } });
    const after = displayNameByParticipantId({
        roomEntries: [{ participantId: "old00001", displayName: "Old entry" }, { participantId: "new00001", displayName: "Temp" }],
        participantMap: { s1: "new00001" },
        reportedNames: {}
    });

    assert.deepEqual(Object.fromEntries(before), { old00001: "Temp" });
    assert.deepEqual(Object.fromEntries(after), { old00001: "Old entry", new00001: "Temp" });
});

test("validateDisplayName: cleaned name, or a reason (empty, too long; never cut silently)", async () => {
    const { validateDisplayName } = await load();

    assert.deepEqual(validateDisplayName("  Nethi \t Perera "), { ok: true, name: "Nethi Perera" });
    assert.deepEqual(validateDisplayName("x".repeat(100)), { ok: true, name: "x".repeat(100) });
    assert.equal(validateDisplayName("x".repeat(101)).ok, false);
    assert.equal(validateDisplayName("   ").ok, false);
    assert.equal(validateDisplayName("\u202E\u0007").ok, false, "only unsafe characters");
    assert.equal(validateDisplayName(undefined).ok, false);
});
