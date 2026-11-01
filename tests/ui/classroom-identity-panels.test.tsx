/**
 * The Class Register, the student register and the attendance panel match
 * students to live Jitsi participants by participant ID (participant map),
 * never by display name. Panels are rendered with react-dom/server; the
 * attendance panel loads its rows in an effect, so its matching is covered
 * through the shared helper and checked from source.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import ParticipantsPanel from "../../components/Jitsi/classroom/sidebar/ParticipantsPanel";
import StudentClassRegister from "../../components/Jitsi/classroom/sidebar/StudentClassRegister";
import BreakoutRoomsPanel from "../../components/Jitsi/classroom/sidebar/BreakoutRoomsPanel";
import StudentProfileMenu from "../../components/Jitsi/classroom/student/StudentProfileMenu";
import MeetingCard from "../../components/Jitsi/classroom/meeting/MeetingCard";
import { breakoutOccupants, normalizeBreakoutRooms } from "../../components/Jitsi/breakout-utils";
import type { BreakoutController } from "../../components/Jitsi/hooks/useBreakoutRooms";
import {
  displayNameByParticipantId,
  resolveClassroomIdentity,
  studentIdByParticipantId,
} from "../../components/Jitsi/participant-identity.mjs";
import type { BreakoutRoom, ClassroomStudent, JitsiParticipant } from "../../components/Jitsi/types";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS fixture shared with the Node tests
const breakoutFixture = require("../jitsi/fixtures/breakout-rooms-11248.cjs");

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const roster: ClassroomStudent[] = [
  { studentId: "s-amal-1", displayName: "Amal Perera", email: null },
  { studentId: "s-amal-2", displayName: "Amal Perera", email: null },
  { studentId: "s-teacher-like", displayName: "Mr. Silva (Teacher)", email: null },
];

const live = (participantId: string, displayName: string, audioMuted: boolean, videoMuted = true): JitsiParticipant => ({
  participantId,
  displayName,
  role: "participant",
  status: { audioMuted, videoMuted, raisedHand: false, isSpeaking: false, connectionQuality: "excellent" },
});

// Silence the panel's own debug logging while rendering.
const quietly = <T,>(render: () => T): T => {
  const log = console.log;

  console.log = () => {};

  try {
    return render();
  } finally {
    console.log = log;
  }
};

test("teacher register: two students with the same name each get their own mic state and mute target", () => {
  const participants = [
    live("teach001", "Mr. Silva (Teacher)", false),
    live("amal0001", "Amal Perera", false), // live mic
    live("amal0002", "Amal Perera", true), // muted
  ];
  const { locations, others } = resolveClassroomIdentity({
    students: roster,
    participantMap: { "s-amal-1": "amal0001", "s-amal-2": "amal0002" },
    participants,
    ownParticipantIds: ["teach001"],
  });

  const html = quietly(() =>
    renderToStaticMarkup(
      <ParticipantsPanel
        role="teacher"
        participants={participants}
        ClassroomStudents={roster}
        studentLocations={locations}
        otherParticipants={others}
        onMuteParticipant={() => {}}
      />
    )
  );

  // One row offers "mute" (Amal 1, live mic), the other "ask to unmute"
  // (Amal 2, muted). The old name match gave both rows Amal 1's state.
  assert.equal(html.split('title="Mute this student"').length - 1, 1);
  assert.equal(html.split('title="Ask this student to unmute"').length - 1, 1);

  // The student named like the teacher is not registered: absent, not "the teacher".
  const absentSection = html.slice(html.indexOf(">Absent<"));

  assert.ok(absentSection.includes("Mr. Silva (Teacher)"));
  assert.ok(!html.includes("Other participants"), "nobody unmapped: no extra card");
});

test("teacher register: an unmapped live participant is listed under Other participants, never as a student", () => {
  const participants = [live("teach001", "Teacher", false), live("xxxx0001", "Amal Perera", false)];
  const { locations, others } = resolveClassroomIdentity({
    students: roster,
    participantMap: {},
    participants,
    ownParticipantIds: ["teach001"],
  });

  const html = quietly(() =>
    renderToStaticMarkup(
      <ParticipantsPanel
        role="teacher"
        participants={participants}
        ClassroomStudents={roster}
        studentLocations={locations}
        otherParticipants={others}
        onMuteParticipant={() => {}}
      />
    )
  );

  assert.ok(html.includes("Other participants"));
  assert.ok(html.includes("Not matched to a class student"));
  assert.equal(html.split('title="Mute this student"').length - 1, 0, "no per-student mute for an unmapped participant");
  assert.ok(html.indexOf("Other participants") < html.indexOf(">Absent<"));
});

test("student register: the viewing student and a classmate in a breakout room are present, by ID", () => {
  // As JitsiClassroom computes it for a student: no own-ID exclusion (a
  // student's own participant ID is that student).
  const participants = [live("amal0001", "Totally renamed", true)];
  const { locations } = resolveClassroomIdentity({
    students: roster,
    participantMap: { "s-amal-1": "amal0001", "s-amal-2": "amal0002" },
    participants,
    roomLabelByParticipantId: { amal0002: "Room 2" },
  });

  const html = renderToStaticMarkup(
    <StudentClassRegister students={roster} currentStudentId="s-amal-1" studentLocations={locations} />
  );

  const presentSection = html.slice(0, html.indexOf(">Absent<"));
  const absentSection = html.slice(html.indexOf(">Absent<"));

  assert.equal(presentSection.split("Amal Perera").length - 1, 2, "both same-name students present");
  assert.ok(presentSection.includes("(You)"), "the viewer (renamed in Jitsi) is present");
  assert.ok(presentSection.includes("In Room 2"), "the classmate in a breakout room is present, with the room");
  assert.ok(absentSection.includes("Mr. Silva (Teacher)"));
});

test("source: only the teacher's own IDs are excluded from student identity", () => {
  const page = source("components/Jitsi/JitsiClassroom.tsx");

  assert.match(page, /ownParticipantIds:\s*role === "teacher"\s*\?\s*jitsiMeetingRef\.current\?\.getOwnParticipantIds\(\)\s*:\s*undefined/);
});

test("source: no panel matches people by display name any more", () => {
  const panel = source("components/Jitsi/classroom/sidebar/ParticipantsPanel.tsx");
  const attendance = source("components/Jitsi/classroom/sidebar/AttendancePanel.tsx");
  const register = source("components/Jitsi/class-register.mjs");
  const studentRegister = source("components/Jitsi/classroom/sidebar/StudentClassRegister.tsx");

  assert.ok(!/displayName\s*===/.test(panel), "ParticipantsPanel");
  assert.ok(panel.includes("participantFor(student.studentId)"));
  assert.ok(!/row\.name\)/.test(attendance) && !/displayName/.test(attendance), "AttendancePanel");
  assert.ok(attendance.includes("sessionStatusFor(row.studentId, studentLocations)"));
  assert.ok(!/displayName/.test(register.replace(/\/\/[^\n]*/g, "")), "class-register.mjs code");
  assert.ok(studentRegister.includes("elsewhereLabel(student.studentId)"));
});

test("source: the classroom streams the participant map to both roles, with backoff and self-repair", () => {
  const page = source("components/Jitsi/JitsiClassroom.tsx");

  assert.ok(page.includes('role !== "teacher" && role !== "student"'), "both roles subscribe");
  assert.ok(page.includes("backoffDelay(failures)"), "reconnect with backoff");
  assert.ok(page.includes("ensureParticipantRegistered("), "student self-repair");
  assert.ok(page.includes("statusById"), "mic / camera state kept by participant ID on refresh");
  assert.ok(!page.includes("roomLabelByParticipantName"), "no display-name labels");
});

function teacherBreakoutController(rooms: BreakoutRoom[], ownIds: string[]): BreakoutController {
  const own = new Set(ownIds);
  const noop = () => {};

  return {
    role: "teacher",
    supported: true,
    rooms,
    mainRoom: rooms.find((room) => room.isMainRoom) ?? null,
    breakoutRooms: rooms.filter((room) => !room.isMainRoom),
    currentRoom: { roomName: "main", isBreakoutRoom: false },
    isInBreakout: false,
    assignedRoom: null,
    busy: null,
    notice: null,
    dismissNotice: noop,
    occupants: (room) => breakoutOccupants(room, own),
    handleRoomsUpdated: noop,
    handleRoomChanged: noop,
    handleSupportChanged: noop,
    createRoom: noop,
    moveParticipant: noop,
    autoAssign: noop,
    joinRoom: noop,
    removeRoom: async () => {},
    closeAllRooms: async () => {},
    returnToMain: noop,
    joinAssignedRoom: noop,
  };
}

test("breakout panel: the captured student is matched by ID and labelled 'Jitsi name (registered)'; others and the teacher by ID", () => {
  // The fixture's main room also holds the captured Jicofo focus occupant.
  const rooms = normalizeBreakoutRooms(breakoutFixture.storeRooms());

  // The teacher (own ID) and a student named exactly like the teacher are in the main room.
  rooms[0].participants.push(
    { occupantJid: "main@conference.x/teach001", participantId: "teach001", jid: "t@x/1", displayName: "Mr. Silva (Teacher)" },
    { occupantJid: "main@conference.x/xxxx0001", participantId: "xxxx0001", jid: "u@x/1", displayName: "Mr. Silva (Teacher)" }
  );
  // A nameless human (not Jicofo) in Room 1.
  rooms[1].participants.push({ occupantJid: "r1@breakout.x/nnnn0001", participantId: "nnnn0001", jid: "n@x/1", displayName: "" });

  const html = renderToStaticMarkup(
    <BreakoutRoomsPanel
      controller={teacherBreakoutController(rooms, ["teach001"])}
      studentNameByParticipantId={new Map([[breakoutFixture.CAPTURED_PARTICIPANT_ID, "L. Rathnayake"]])}
    />
  );

  const room1 = html.slice(html.indexOf(">Room 1<"));
  const main = html.slice(html.indexOf(">Main room<"), html.indexOf(">Room 1<"));

  // Matched by participant ID to the registered student; the Jitsi name (which
  // differs) is shown with it, never used to decide who it is.
  assert.ok(room1.includes("Lahiru Rathnayake (L. Rathnayake)"), "Jitsi name (registered name)");
  assert.ok(room1.includes("1 student · 1 other"));
  assert.ok(room1.includes("Unnamed participant"), "a nameless human stays visible");

  // The teacher's own entry and Jicofo are hidden; the teacher-named stranger is an
  // "other participant" (counted, movable), not a student and not the teacher.
  assert.equal(main.split("Mr. Silva (Teacher)").length - 1, 1);
  assert.ok(main.includes("Other participants"));
  assert.ok(main.includes("0 students · 1 other"));
  assert.ok(!main.includes("Unnamed participant"), "no Jicofo row");
  assert.ok(main.includes("Move to..."), "still movable by its jid");
  assert.equal(html.split(">Move to...<").length - 1, 3, "stranger, student and nameless human; never Jicofo");
});

test("source: the breakout panel has no teacher-name logic and moves by the original jid", () => {
  const panel = source("components/Jitsi/classroom/sidebar/BreakoutRoomsPanel.tsx");

  assert.ok(!/teacherName/.test(panel));
  assert.ok(!/displayName\s*!==/.test(panel));
  assert.ok(panel.includes("jid={person.jid}"));
  assert.ok(panel.includes("key={person.occupantJid}"));
});

test("source: Jitsi roles are never derived from a display name", () => {
  const jitsi = source("components/Jitsi/hooks/useJitsi.ts").replace(/\/\/[^\n]*/g, "");

  assert.ok(!/displayName\s*===\s*teacherName/.test(jitsi));
  assert.ok(jitsi.includes("localIsModeratorRef.current"));
});

// ---- Breakout panel in real time ------------------------------------------------
//
// Each step is what the page has after one Jitsi / SSE update: the rooms list
// (breakoutRoomsUpdated, normalized), the participant map and the students' own
// name reports (SSE), and this browser's live participants (participantJoined /
// participantLeft / displayNameChange). The panel is rendered from them the way
// JitsiClassroom builds its props.

const DOMAIN = "meet.slclassroom.live";
const MAIN_JID = breakoutFixture.MAIN_ROOM_JID as string;
const ROOM_A_JID = `room-a@breakout.${DOMAIN}`;
const realtimeRoster: ClassroomStudent[] = [
  { studentId: "s-nethi", displayName: "Nethi Perera", email: null },
  { studentId: "s-amal-1", displayName: "Amal Perera", email: null },
  { studentId: "s-amal-2", displayName: "Amal Perera", email: null },
];
const TEACHER_ID = "teach001";

type Occupant = { id: string; name?: string; jid?: string };

const focusIn = (roomJid: string) => ({ [`${roomJid}/focus`]: { jid: breakoutFixture.FOCUS_JID, role: "moderator" } });

function roomsPayload(main: Occupant[], roomA: Occupant[]) {
  const entries = (roomJid: string, people: Occupant[]) =>
    Object.fromEntries(
      people.map((person) => [
        `${roomJid}/${person.id}`,
        { jid: person.jid ?? `${person.id}-uuid@${DOMAIN}/res`, ...(person.name !== undefined ? { displayName: person.name } : {}) },
      ])
    );

  return {
    rooms: {
      main: { id: "main", jid: MAIN_JID, name: "", isMainRoom: true, participants: { ...focusIn(MAIN_JID), ...entries(MAIN_JID, main) } },
      "room-a": { id: "room-a", jid: ROOM_A_JID, name: "Room A", isMainRoom: false, participants: { ...focusIn(ROOM_A_JID), ...entries(ROOM_A_JID, roomA) } },
    },
  };
}

function renderBreakout({
  rooms,
  participantMap,
  reportedNames = {},
  liveParticipants = [],
}: {
  rooms: unknown;
  participantMap: Record<string, string>;
  reportedNames?: Record<string, string>;
  liveParticipants?: JitsiParticipant[];
}) {
  const normalized = normalizeBreakoutRooms(rooms);
  const own = new Set([TEACHER_ID]);
  const registered = new Map(realtimeRoster.map((student) => [student.studentId, student.displayName]));
  const studentNames = new Map<string, string>();

  studentIdByParticipantId(participantMap, own).forEach((studentId, participantId) => {
    const name = registered.get(studentId);

    if (name !== undefined) studentNames.set(participantId, name);
  });

  const html = renderToStaticMarkup(
    <BreakoutRoomsPanel
      controller={teacherBreakoutController(normalized, [TEACHER_ID])}
      studentNameByParticipantId={studentNames}
      displayNameByParticipantId={displayNameByParticipantId({
        roomEntries: normalized.flatMap((room) => room.participants),
        participantMap,
        reportedNames,
        participants: liveParticipants,
      })}
    />
  );
  // Room card headings (the "Move to..." options repeat the room names).
  const heading = (name: string) => html.indexOf(`text-slate-900">${name}</p>`);
  const roomAStart = heading("Room A");

  assert.ok(heading("Main room") >= 0 && roomAStart > heading("Main room"));

  return {
    html,
    main: html.slice(heading("Main room"), roomAStart),
    roomA: html.slice(roomAStart),
  };
}

const teacher = { id: TEACHER_ID, name: "Mr. Silva (Teacher)" };

test("breakout real time: join, move (both rooms), rename here and elsewhere, duplicates, leave, reconnect", () => {
  // 1. Nethi joins the main room.
  let map: Record<string, string> = { "s-nethi": "neth0001" };
  let view = renderBreakout({
    rooms: roomsPayload([teacher, { id: "neth0001", name: "Nethi Perera" }], []),
    participantMap: map,
    liveParticipants: [live(TEACHER_ID, teacher.name, false), live("neth0001", "Nethi Perera", true)],
  });

  assert.ok(view.main.includes("1 student"));
  assert.ok(view.main.includes(">Nethi Perera<"));
  assert.ok(view.roomA.includes("Empty"));

  // 2. Nethi is moved to Room A; Amal 1 and Amal 2 (same name) join. Both rooms change.
  map = { ...map, "s-amal-1": "amal0001", "s-amal-2": "amal0002" };
  view = renderBreakout({
    rooms: roomsPayload(
      [teacher, { id: "amal0001", name: "Amal Perera" }],
      [{ id: "neth0001", name: "Nethi Perera" }, { id: "amal0002", name: "Amal Perera" }]
    ),
    participantMap: map,
    liveParticipants: [live(TEACHER_ID, teacher.name, false), live("amal0001", "Amal Perera", true)],
  });

  assert.ok(!view.main.includes("Nethi"), "left the main room");
  assert.ok(view.roomA.includes(">Nethi Perera<") && view.roomA.includes("2 students"), "arrived in Room A");
  assert.ok(view.main.includes(">Amal Perera<") && view.main.includes("1 student"));

  // 3. Renames: Amal 1 in the teacher's room (live displayNameChange), Nethi in
  //    Room A (her own report over SSE; the rooms list still has the old name).
  view = renderBreakout({
    rooms: roomsPayload(
      [teacher, { id: "amal0001", name: "Amal Perera" }],
      [{ id: "neth0001", name: "Nethi Perera" }, { id: "amal0002", name: "Amal Perera" }]
    ),
    participantMap: map,
    reportedNames: { "s-nethi": "Nethi (temp)" },
    liveParticipants: [live(TEACHER_ID, teacher.name, false), live("amal0001", "Amal One", true)],
  });

  assert.ok(view.main.includes(">Amal One (Amal Perera)<"), "renamed here: updated at once");
  assert.ok(view.roomA.includes(">Nethi (temp) (Nethi Perera)<"), "renamed in another room: updated from her report");
  assert.ok(view.roomA.includes(">Amal Perera<"), "same-name classmate untouched: matched by ID, not name");
  assert.ok(!view.roomA.includes("Amal One"));

  // 4. Nethi leaves the classroom (removed / closed the tab).
  view = renderBreakout({
    rooms: roomsPayload([teacher, { id: "amal0001", name: "Amal One" }], [{ id: "amal0002", name: "Amal Perera" }]),
    participantMap: map, // the map keeps her last ID; she is simply not in any room
    reportedNames: { "s-nethi": "Nethi (temp)" },
  });

  assert.ok(!view.html.includes("Nethi"), "gone from every room");
  assert.ok(view.roomA.includes("1 student"));

  // 5. Nethi reconnects: new participant ID, the server cleared her old name.
  map = { ...map, "s-nethi": "neth0002" };
  view = renderBreakout({
    rooms: roomsPayload(
      [teacher, { id: "amal0001", name: "Amal One" }, { id: "neth0002", name: "Nethi Perera" }],
      [{ id: "amal0002", name: "Amal Perera" }]
    ),
    participantMap: map,
  });

  assert.ok(view.main.includes(">Nethi Perera<") && view.main.includes("2 students"), "restored as the same student");
  assert.ok(!view.html.includes("(temp)"), "the old connection's name is not carried over");
});

test("breakout real time: Jicofo never shows; unnamed humans and strangers do, renamed live by participant ID", () => {
  const map = { "s-nethi": "neth0001" };
  const rooms = roomsPayload(
    [teacher, { id: "gues0001", name: "Visitor" }],
    [{ id: "neth0001", name: "Nethi Perera" }, { id: "anon0001" }]
  );

  let view = renderBreakout({ rooms, participantMap: map });

  assert.ok(!view.main.includes("Unnamed participant"), "no Jicofo row (main has no nameless human)");
  assert.ok(view.main.includes("0 students · 1 other") && view.main.includes(">Visitor<"));
  assert.ok(view.roomA.includes("1 student · 1 other") && view.roomA.includes(">Unnamed participant<"));
  assert.equal(view.html.split(">Move to...<").length - 1, 3, "visitor, Nethi, unnamed human: never Jicofo or the teacher");

  // The visitor (not a class student) renames in the teacher's room.
  view = renderBreakout({
    rooms,
    participantMap: map,
    liveParticipants: [live(TEACHER_ID, teacher.name, false), live("gues0001", "Guest Speaker", true)],
  });

  assert.ok(view.main.includes(">Guest Speaker<") && view.main.includes("0 students · 1 other"), "renamed, still not a student");
});

test("source: one displayNameChange listener, removed on cleanup; the student's name report is wired and cancelled", () => {
  const jitsi = source("components/Jitsi/hooks/useJitsi.ts");
  const page = source("components/Jitsi/JitsiClassroom.tsx");
  const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

  assert.equal(count(jitsi, /addListener\(\s*"displayNameChange",\s*handleDisplayNameChange\s*\)/g), 1);
  assert.equal(count(jitsi, /removeListener\(\s*"displayNameChange",\s*handleDisplayNameChange\s*\)/g), 1);
  assert.match(jitsi, /const handleDisplayNameChange = [\s\S]*?updateParticipants\(\);\n    \};/, "re-reads the participant list");
  assert.ok(jitsi.includes("displayNameReporterRef.current?.cancelRetry()"), "pending retry cancelled on unmount");
  assert.ok(page.includes("syncParticipantDisplayName("), "student reconciles its name with every map update");
  assert.ok(page.includes("displayNameByParticipantId({"), "teacher labels by participant ID");
});

test("source: registered names reach the teacher's own Jitsi iframe only, by participant ID, resent when custom.js is ready", () => {
  const jitsi = source("components/Jitsi/hooks/useJitsi.ts");
  const page = source("components/Jitsi/JitsiClassroom.tsx");

  // Built from the authorized participant map (current, unambiguous entries; never
  // the teacher's own IDs), sent by the teacher's page only.
  assert.match(page, /if \(role !== "teacher" \|\| conferenceGeneration === 0\) \{\s*return;\s*\}\s*jitsiMeetingRef\.current\?\.setStudentNames\(breakoutStudentNames\);/);
  assert.match(page, /studentIdByParticipantId\(participantMap, jitsiMeetingRef\.current\?\.getOwnParticipantIds\(\)\)/);

  // Teacher-only control and post, to the iframe's own window and origin.
  assert.match(jitsi, /setStudentNames: \(names\) => \{\s*if \(roleRef\.current !== "teacher"\) \{\s*return;/);
  assert.match(jitsi, /const postStudentNames = \(\) => \{[\s\S]*?roleRef\.current !== "teacher"[\s\S]*?frameWindow\.postMessage\(message, SL_JITSI_ORIGIN\);/);
  assert.match(jitsi, /postTeacherView\(\);\s*postStudentNames\(\);/, "resent on SL_RECEIVE_READY");
  assert.ok(!/displayNames|reportedDisplayNames/.test(jitsi.slice(jitsi.indexOf("setStudentNames: (names)"), jitsi.indexOf("setTeacherTiles: (state)"))),
    "registered names only; the live Jitsi name comes from the iframe itself");
});

test("registered names for the iframe: a student's current ID only; reconnect, ambiguous and own IDs are left out", () => {
  const own = new Set(["teach001"]);
  const registered = new Map(realtimeRoster.map((student) => [student.studentId, student.displayName]));
  const namesFor = (map: Record<string, string>) => {
    const names = new Map<string, string>();

    studentIdByParticipantId(map, own).forEach((studentId, participantId) => {
      const name = registered.get(studentId);

      if (name !== undefined) names.set(participantId, name);
    });

    return Object.fromEntries(names);
  };

  assert.deepEqual(namesFor({ "s-nethi": "neth0001", "s-amal-1": "amal0001" }), { neth0001: "Nethi Perera", amal0001: "Amal Perera" });
  assert.deepEqual(namesFor({ "s-nethi": "neth0002", "s-amal-1": "amal0001" }), { neth0002: "Nethi Perera", amal0001: "Amal Perera" },
    "reconnect: the old ID is no longer sent");
  assert.deepEqual(namesFor({ "s-nethi": "dupe0001", "s-amal-1": "dupe0001", "s-amal-2": "teach001" }), {},
    "an ID claimed twice, or the teacher's own, names no one");
});

// ---- Student header profile ---------------------------------------------------

const neverCalled = () => Promise.reject(new Error("not expected"));

test("student profile: the temporary Jitsi name first, the registered name read-only, a change action", () => {
  const closed = renderToStaticMarkup(
    <StudentProfileMenu registeredName="Nethmi Silva" displayName="Nethi Perera" onChangeName={neverCalled} />
  );

  assert.ok(closed.includes(">Nethi Perera<"), "the trigger shows the current Jitsi name");
  assert.ok(closed.includes('title="Nethi Perera (Registered: Nethmi Silva)"'));
  assert.ok(!closed.includes("Change display name"), "closed");

  const open = renderToStaticMarkup(
    <StudentProfileMenu registeredName="Nethmi Silva" displayName="Nethi Perera" onChangeName={neverCalled} defaultOpen />
  );

  assert.match(open, /data-testid="profile-display-name">Nethi Perera</);
  assert.match(open, /data-testid="profile-registered-name">Registered: <span[^>]*>Nethmi Silva</);
  assert.ok(open.includes("Change display name"));
  assert.ok(!open.includes("<input"), "nothing editable until asked, and never the registered name");
});

test("student profile: the same name is shown once; before joining the change waits", () => {
  const same = renderToStaticMarkup(
    <StudentProfileMenu registeredName="Nethmi Silva" displayName=" Nethmi  Silva" onChangeName={neverCalled} defaultOpen />
  );

  assert.ok(!same.includes("Registered:"));
  assert.ok(same.includes("Your registered name"));

  const beforeJoin = renderToStaticMarkup(
    <StudentProfileMenu registeredName="Nethmi Silva" displayName={null} onChangeName={neverCalled} defaultOpen />
  );

  assert.match(beforeJoin, /data-testid="profile-display-name">Nethmi Silva</);
  assert.match(beforeJoin, /<button[^>]*disabled=""[^>]*title="Available once you have joined the class"/);
});

test("student profile: the editor edits the temporary name only, with the limit and a note", () => {
  const editing = renderToStaticMarkup(
    <StudentProfileMenu
      registeredName="Nethmi Silva"
      displayName="Nethi Perera"
      onChangeName={neverCalled}
      defaultOpen
      defaultEditing
    />
  );

  assert.equal(editing.split("<input").length - 1, 1, "one field");
  assert.match(editing, /<input[^>]*value="Nethi Perera"/, "prefilled with the current Jitsi name");
  assert.ok(editing.includes("New display name"));
  assert.ok(editing.includes("Your registered name does not change."));
  assert.ok(editing.includes(">Save<") && editing.includes("Cancel"));
});

test("source: the profile is the student's own, from the login's join info, changed only through Jitsi", () => {
  const page = source("components/Jitsi/JitsiClassroom.tsx");
  const jitsi = source("components/Jitsi/hooks/useJitsi.ts");
  const menu = source("components/Jitsi/classroom/student/StudentProfileMenu.tsx");
  const card = source("components/Jitsi/classroom/meeting/MeetingCard.tsx");

  // Students only, the registered name from the server-built join info.
  assert.match(page, /profileMenu=\{\s*role === "student" && joinInfo\.student \? \(\s*<StudentProfileMenu\s*registeredName=\{joinInfo\.student\.name\}\s*displayName=\{localDisplayName\}/);
  assert.ok(page.includes("onLocalDisplayNameChanged={setLocalDisplayName}"), "the header follows Jitsi's confirmed name");
  assert.ok(card.includes("{profileMenu}"));

  // The control is student-only and goes through Jitsi's own command.
  assert.match(jitsi, /setLocalDisplayName: \(name\) =>\s*roleRef\.current === "student"/);
  assert.ok(source("components/Jitsi/participant-display-name.ts").includes('api.executeCommand("displayName", checked.name)'));
  assert.ok(jitsi.includes("displayNameChangerRef.current?.confirmed(data.displayname)"));

  // No other naming path: the menu never posts anything itself.
  assert.ok(!/fetch\(|participant-map/.test(menu));
});

test("teacher header: unchanged (no profile menu)", () => {
  const teacher = renderToStaticMarkup(
    <MeetingCard className="Grade 10" lectureTitle="Algebra" teacherName="Mr. Silva" role="teacher" showHeader>
      <div />
    </MeetingCard>
  );

  assert.ok(!teacher.includes("Change display name"));
  assert.ok(!teacher.includes("Registered:"));
});

test("source: visit history is teacher-only, from the existing endpoint and stream, times only, sent like the names", () => {
  const page = source("components/Jitsi/JitsiClassroom.tsx");
  const jitsi = source("components/Jitsi/hooks/useJitsi.ts");
  const hook = source("components/Jitsi/hooks/useSessionVisitHistory.ts");

  // The existing teacher-only endpoint and event stream; nothing new on the server.
  assert.ok(hook.includes("`/api/sessions/${sessionId}/attendance`"));
  assert.ok(hook.includes("`/api/sessions/${sessionId}/events`"));
  assert.ok(hook.includes('"attendance-update"'));
  // The stream only while the teacher view shows (fewer open connections).
  assert.match(page, /enabled: isTeacherNormalView && SL_TEACHER_FILMSTRIP_ENABLED/);

  // Matched by studentId -> current participant ID, class students only.
  assert.match(page, /studentIdByParticipantId\(participantMap, jitsiMeetingRef\.current\?\.getOwnParticipantIds\(\)\)[\s\S]*?roster\.has\(studentId\)/);
  assert.match(page, /if \(role !== "teacher" \|\| conferenceGeneration === 0\) \{\s*return;\s*\}\s*jitsiMeetingRef\.current\?\.setStudentHistory\(studentHistory\);/);

  // Teacher-only control, the iframe's own origin, resent when custom.js is ready.
  assert.match(jitsi, /setStudentHistory: \(entries\) => \{\s*if \(roleRef\.current !== "teacher"\) \{\s*return;/);
  assert.match(jitsi, /const postStudentHistory = \(\) => \{[\s\S]*?roleRef\.current !== "teacher"[\s\S]*?frameWindow\.postMessage\(message, SL_JITSI_ORIGIN\);/);
  assert.match(jitsi, /postStudentNames\(\);\s*postStudentHistory\(\);/);
});
