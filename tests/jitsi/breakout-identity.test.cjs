/*
 * Breakout rooms identify people by the participant ID in the rooms list KEY
 * (the occupant JID "<room>@<muc>/<participantId>"), never by display name and
 * never by the `jid` field (the real JID, kept only for moving people).
 *
 *   node --test tests/jitsi/breakout-identity.test.cjs
 *
 * Uses the real staging payload (Jitsi Meet 2.0.11248): fixtures/breakout-rooms-11248.cjs.
 * Not covered here (needs real Jitsi): Prosody actually filtering Jicofo, and
 * the close / remove flow's timing against a live server.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const fixture = require("./fixtures/breakout-rooms-11248.cjs");
const breakout = require(path.join(root, "components/Jitsi/breakout-utils.ts"));
const loadIdentity = () => import(pathToFileURL(path.join(root, "components/Jitsi/participant-identity.mjs")).href);

const room = (overrides) => ({ id: "r1", jid: "r1@breakout.x", name: "Room 1", isMainRoom: false, participants: [], ...overrides });

// ---- Parser ------------------------------------------------------------------

test("parser: the captured key yields the participant ID; the jid resource never does", async () => {
    const { participantIdFromRoomKey } = await loadIdentity();

    assert.equal(participantIdFromRoomKey(fixture.CAPTURED_KEY), fixture.CAPTURED_PARTICIPANT_ID);
    // The jid is a real JID: its resource ("tw79LuAQTEIU") is the XMPP session,
    // not a participant ID, so identity must come from the key.
    assert.notEqual(participantIdFromRoomKey(fixture.CAPTURED_KEY), fixture.CAPTURED_JID_RESOURCE);
    assert.ok(!fixture.CAPTURED_JID.endsWith("/" + fixture.CAPTURED_PARTICIPANT_ID));

    // The normalized entry takes its ID from the key, never from the jid.
    const [, breakoutRoom] = breakout.normalizeBreakoutRooms(fixture.storeRooms());

    assert.equal(breakoutRoom.participants[0].participantId, fixture.CAPTURED_PARTICIPANT_ID);
});

test("parser: malformed keys are never matched to anyone", async () => {
    const { participantIdFromRoomKey } = await loadIdentity();

    for (const key of [
        "no-slash@breakout.meet.slclassroom.live",
        "/d92a7329",
        "room-without-at/d92a7329",
        "room@breakout.meet.slclassroom.live/",
        "room@breakout.meet.slclassroom.live/d92/a7329",
        "room@breakout.meet.slclassroom.live/d9@a7329",
        "room@breakout.meet.slclassroom.live/abc",
        "room@breakout.meet.slclassroom.live/" + "a".repeat(65),
        "",
        undefined,
        null,
        42
    ]) {
        assert.equal(participantIdFromRoomKey(key), null, JSON.stringify(key));
    }

    // A main-room key parses the same way.
    assert.equal(participantIdFromRoomKey("saastution-abc-def@conference.meet.slclassroom.live/de809448"), "de809448");
});

// ---- Normalization -----------------------------------------------------------

test("normalize: the captured entry keeps its key, parsed ID, original jid and name (store and event forms)", () => {
    for (const raw of [fixture.storeRooms(), fixture.eventPayload()]) {
        const rooms = breakout.normalizeBreakoutRooms(raw);

        assert.deepEqual(rooms.map(r => [r.isMainRoom, r.name]), [[true, ""], [false, "Room 1"]], "main room first");
        assert.deepEqual(rooms[0].participants, [], "the captured Jicofo focus occupant is not listed");
        assert.deepEqual(rooms[1].participants, [{
            occupantJid: fixture.CAPTURED_KEY,
            participantId: fixture.CAPTURED_PARTICIPANT_ID,
            jid: fixture.CAPTURED_JID,
            displayName: "Lahiru Rathnayake"
        }]);
    }
});

test("normalize: entries without a name, without a jid, or with an unparseable key are kept", () => {
    const rooms = breakout.normalizeBreakoutRooms({
        r1: {
            id: "r1",
            jid: "r1@breakout.x",
            name: "Room 1",
            participants: {
                "r1@breakout.x/aaaa0001": { jid: "u1@x/res" },
                "r1@breakout.x/bbbb0002": { displayName: "No JID" },
                "garbage-key": { jid: "u3@x/res", displayName: "Odd" },
                "r1@breakout.x/cccc0003": null
            }
        }
    });

    assert.deepEqual(rooms[0].participants, [
        { occupantJid: "r1@breakout.x/aaaa0001", participantId: "aaaa0001", jid: "u1@x/res", displayName: "" },
        { occupantJid: "r1@breakout.x/bbbb0002", participantId: "bbbb0002", jid: null, displayName: "No JID" },
        { occupantJid: "garbage-key", participantId: null, jid: "u3@x/res", displayName: "Odd" },
        { occupantJid: "r1@breakout.x/cccc0003", participantId: "cccc0003", jid: null, displayName: "" }
    ]);
});

// ---- Service occupants (Jicofo) ----------------------------------------------

const DOMAIN = "meet.slclassroom.live";
const BREAKOUT_JID = `${fixture.ROOM_ID}@breakout.${DOMAIN}`;

test("service occupant: the room's Jitsi domain comes from the room JID (main and breakout)", () => {
    assert.equal(breakout.jitsiDomainOfRoomJid(fixture.MAIN_ROOM_JID), DOMAIN);
    assert.equal(breakout.jitsiDomainOfRoomJid(BREAKOUT_JID), DOMAIN);

    for (const jid of ["", "no-at.example", "room@", "@conference.x", "room@nodot", "room@conference.", "a@b@conference.x", null, 42]) {
        assert.equal(breakout.jitsiDomainOfRoomJid(jid), null, JSON.stringify(jid));
    }
});

test("service occupant: only Jicofo's real JID (focus@auth.<domain>) counts; never a name, role or missing name", () => {
    assert.equal(breakout.isServiceOccupant(fixture.capturedFocus[fixture.FOCUS_KEY], DOMAIN), true, "the captured entry");
    assert.equal(breakout.isServiceOccupant({ jid: "Focus@Auth.Meet.SLClassroom.live/focus" }, DOMAIN), true, "JIDs compare case-insensitively");
    assert.equal(breakout.isServiceOccupant({ jid: `focus@auth.${DOMAIN}` }, DOMAIN), true, "bare JID");
    assert.equal(breakout.isServiceOccupant(fixture.capturedFocus[fixture.FOCUS_KEY], null), false, "unknown domain: never filtered");

    for (const entry of [
        fixture.capturedParticipants[fixture.CAPTURED_KEY], // a student
        { jid: `d92a7329-ee44@${DOMAIN}/abc` }, // nameless human
        { jid: `teacher-uuid@${DOMAIN}/abc`, role: "moderator", displayName: "" }, // a nameless moderator (co-teacher)
        { jid: `focus@${DOMAIN}/focus`, role: "moderator" }, // a user called "focus", not on the auth domain
        { jid: "focus@auth.other.example/focus" }, // another deployment's focus
        { jid: `focus@auth.${DOMAIN}.evil.example/focus` },
        { jid: `focusbot@auth.${DOMAIN}/focus` },
        { jid: `x@auth.${DOMAIN}/focus`, displayName: "focus" }, // focus only in the resource / name
        { role: "moderator" }, // no jid
        { jid: "focus" },
        { jid: "focus@" },
        { jid: `@auth.${DOMAIN}` },
        { jid: `focus@@auth.${DOMAIN}` },
        { jid: 42 },
        {},
        null,
        undefined
    ]) {
        assert.equal(breakout.isServiceOccupant(entry, DOMAIN), false, JSON.stringify(entry));
    }
});

test("normalize: Jicofo is dropped from main and breakout rooms; nameless humans, moderators, no-jid and odd entries stay", () => {
    const rooms = breakout.normalizeBreakoutRooms({
        main: { id: "main", jid: fixture.MAIN_ROOM_JID, isMainRoom: true, participants: {
            ...fixture.capturedFocus,
            [`${fixture.MAIN_ROOM_JID}/teach001`]: { jid: `teacher-uuid@${DOMAIN}/t1`, role: "moderator", displayName: "Mr. Silva (Teacher)" }
        } },
        [fixture.ROOM_ID]: { id: fixture.ROOM_ID, jid: BREAKOUT_JID, name: "Room 1", participants: {
            [`${BREAKOUT_JID}/focus`]: { jid: fixture.FOCUS_JID, role: "moderator" },
            ...fixture.capturedParticipants,
            [`${BREAKOUT_JID}/aaaa0001`]: { jid: `nameless-uuid@${DOMAIN}/r1` },
            [`${BREAKOUT_JID}/bbbb0002`]: { jid: `cohost-uuid@${DOMAIN}/r2`, role: "moderator" },
            [`${BREAKOUT_JID}/cccc0003`]: { displayName: "No JID" },
            [`${BREAKOUT_JID}/dddd0004`]: { jid: "focus" }
        } }
    });

    assert.deepEqual(rooms[0].participants.map(p => p.participantId), ["teach001"], "main: Jicofo gone, the teacher kept");
    assert.deepEqual(rooms[1].participants.map(p => [p.participantId, p.jid, p.displayName]), [
        [fixture.CAPTURED_PARTICIPANT_ID, fixture.CAPTURED_JID, "Lahiru Rathnayake"],
        ["aaaa0001", `nameless-uuid@${DOMAIN}/r1`, ""],
        ["bbbb0002", `cohost-uuid@${DOMAIN}/r2`, ""],
        ["cccc0003", null, "No JID"],
        ["dddd0004", "focus", ""]
    ]);

    // Occupancy: the teacher's own entry is excluded as before; everyone else counts.
    const own = new Set(["teach001"]);

    assert.equal(breakout.breakoutOccupants(rooms[0], own).length, 0);
    assert.equal(breakout.breakoutOccupants(rooms[1], own).length, 5);
    assert.deepEqual(breakout.roomLabelByParticipantId(rooms).focus, undefined, "Jicofo never gets a room label");
});

test("close flow: with only Jicofo (and the teacher's old entry) left, the refreshed rooms are empty", async () => {
    const own = new Set(["teach001"]);
    const listed = (studentStillThere) => ({
        main: { id: "main", jid: fixture.MAIN_ROOM_JID, isMainRoom: true, participants: { ...fixture.capturedFocus } },
        [fixture.ROOM_ID]: { id: fixture.ROOM_ID, jid: BREAKOUT_JID, name: "Room 1", participants: {
            [`${BREAKOUT_JID}/focus`]: { jid: fixture.FOCUS_JID, role: "moderator" },
            [`${BREAKOUT_JID}/teach001`]: { jid: `teacher-uuid@${DOMAIN}/t1`, displayName: "Mr. Silva (Teacher)" },
            ...(studentStillThere ? fixture.capturedParticipants : {})
        } }
    });
    let stillThere = true;
    const api = { executeCommand: () => {}, listBreakoutRooms: async () => listed(stillThere) };
    const controls = breakout.createBreakoutControls(() => api, () => fixture.MAIN_ROOM_JID);
    const occupied = async () => (await controls.refreshBreakoutRooms())
        .filter(room => !room.isMainRoom)
        .map(room => breakout.breakoutOccupants(room, own).length);

    assert.deepEqual(await occupied(), [1], "the student is still inside");

    stillThere = false;

    assert.deepEqual(await occupied(), [0], "Jicofo does not keep the room 'occupied'");
});

// ---- Labels ------------------------------------------------------------------

test("labels by participant ID: the captured student is in Room 1; same names in two rooms stay apart", () => {
    const labels = breakout.roomLabelByParticipantId(breakout.normalizeBreakoutRooms(fixture.storeRooms()));

    assert.deepEqual(labels, { [fixture.CAPTURED_PARTICIPANT_ID]: "Room 1" });

    const twins = breakout.roomLabelByParticipantId([
        room({ isMainRoom: true, name: "", participants: [{ occupantJid: "m/aaaa0001", participantId: "aaaa0001", jid: "a@x", displayName: "Amal" }] }),
        room({ participants: [
            { occupantJid: "r1/aaaa0002", participantId: "aaaa0002", jid: "b@x", displayName: "Amal" },
            { occupantJid: "garbage", participantId: null, jid: "c@x", displayName: "Amal" }
        ] })
    ]);

    assert.deepEqual(twins, { aaaa0001: "Main room", aaaa0002: "Room 1" });
});

test("registers: a mapped student in a breakout room is present there, by ID (the Jitsi name is irrelevant)", async () => {
    const { resolveClassroomIdentity } = await loadIdentity();
    const labels = breakout.roomLabelByParticipantId(breakout.normalizeBreakoutRooms(fixture.storeRooms()));
    const roster = [{ studentId: "s-lahiru", displayName: "L. Rathnayake" }, { studentId: "s-other", displayName: "Lahiru Rathnayake" }];

    const { locations } = resolveClassroomIdentity({
        students: roster,
        participantMap: { "s-lahiru": fixture.CAPTURED_PARTICIPANT_ID },
        participants: [],
        roomLabelByParticipantId: labels,
        ownParticipantIds: ["teach001"]
    });

    assert.deepEqual(locations.get("s-lahiru"), { participantId: fixture.CAPTURED_PARTICIPANT_ID, roomLabel: "Room 1" });
    assert.equal(locations.has("s-other"), false, "same Jitsi name, not that student");
});

// ---- Occupancy (close / remove safety) -----------------------------------------

test("occupancy: only this browser's own entries (current and earlier IDs) are excluded", () => {
    const people = [
        { occupantJid: "r1/teach002", participantId: "teach002", jid: "t@x/2", displayName: "Mr. Silva (Teacher)" }, // the teacher, now
        { occupantJid: "r1/teach001", participantId: "teach001", jid: "t@x/1", displayName: "Mr. Silva (Teacher)" }, // the teacher's lagging old entry
        { occupantJid: "r1/stud0001", participantId: "stud0001", jid: "s@x/1", displayName: "Mr. Silva (Teacher)" }, // a student named like the teacher
        { occupantJid: "garbage", participantId: null, jid: "g@x/1", displayName: "" }, // unparseable, nameless
        { occupantJid: "r1/focus001", participantId: "focus001", jid: "focus@auth.meet.slclassroom.live/focus", displayName: "" } // occupancy itself never filters by JID (normalize drops Jicofo earlier)
    ];

    const occupants = breakout.breakoutOccupants(room({ participants: people }), new Set(["teach001", "teach002"]));

    assert.deepEqual(occupants.map(p => p.occupantJid), ["r1/stud0001", "garbage", "r1/focus001"]);
    assert.equal(breakout.breakoutOccupants(room({ participants: people.slice(0, 2) }), new Set(["teach001", "teach002"])).length, 0,
        "only the teacher's own (old) entries left: the room is empty");
});

test("close / remove flow decides 'empty' with the ID-based occupants (source)", () => {
    const hook = fs.readFileSync(path.join(root, "components/Jitsi/hooks/useBreakoutRooms.ts"), "utf8");
    const code = hook.replace(/\/\/[^\n]*/g, "");

    assert.ok(!/teacherName|displayName/.test(code), "no name-based occupancy");
    assert.ok(code.includes("breakoutOccupants(room, getControls()?.getOwnParticipantIds()"));
    assert.ok(code.includes("occupants(room).length > 0") && code.includes("occupants(room).length === 0"), "close and wait-until-empty use it");
});

// ---- Moves --------------------------------------------------------------------

test("moves: the original jid from the rooms list is sent, unchanged", () => {
    const commands = [];
    const api = { executeCommand: (...args) => commands.push(args) };
    const controls = breakout.createBreakoutControls(() => api, () => "main@conference.x");
    const [, breakoutRoom] = breakout.normalizeBreakoutRooms(fixture.storeRooms());
    const person = breakoutRoom.participants[0];

    controls.sendParticipantToBreakoutRoom(person.jid, "main-room-id");

    assert.deepEqual(commands, [["sendParticipantToRoom", fixture.CAPTURED_JID, "main-room-id"]]);
});
