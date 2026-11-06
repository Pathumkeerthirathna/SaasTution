/*
 * Group Activities pure rules: membership planning (rules.mjs), the member
 * snapshot and progress counting, the teacher's member proposal built from
 * the existing breakout rooms (proposal.ts), request validation, the group
 * lock keys / statements, and change-notification visibility.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const rules = require(path.join(root, "lib/breakout-activities/groups/rules.mjs"));
const validation = require(path.join(root, "lib/breakout-activities/groups/validation.ts"));
const locks = require(path.join(root, "lib/breakout-activities/groups/locks.ts"));
const events = require(path.join(root, "lib/breakout-activities/groups/events.ts"));
const { proposeRooms } = require(path.join(root, "components/Jitsi/classroom/sidebar/group-activities/proposal.ts"));

const A = "a1111111-1111-4111-8111-111111111111";
const B = "a2222222-2222-4222-8222-222222222222";
const C = "a3333333-3333-4333-8333-333333333333";

// ---- planMembershipUpdate --------------------------------------------------------------

test("plan: new rooms add everyone; nothing removed", () => {
  const plan = rules.planMembershipUpdate([], [{ id: "r1", name: "Room 1", studentIds: [A, B] }]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.add, [
    { roomId: "r1", roomName: "Room 1", studentId: A },
    { roomId: "r1", roomName: "Room 1", studentId: B },
  ]);
  assert.deepEqual(plan.affectedStudentIds, [A, B].sort());
});

test("plan: kept members stay (renamed when the room name changed); moves and drops are removed first", () => {
  const active = [
    { id: "m1", roomId: "r1", roomName: "Room 1", studentId: A },
    { id: "m2", roomId: "r1", roomName: "Room 1", studentId: B },
    { id: "m3", roomId: "r2", roomName: "Room 2", studentId: C },
  ];
  // r1 now: A only (B dropped), renamed; C moves r2 -> r1? No: C listed in r1.
  const plan = rules.planMembershipUpdate(active, [{ id: "r1", name: "Team A", studentIds: [A, C] }]);
  assert.deepEqual(plan.remove.sort(), ["m2", "m3"]);
  assert.deepEqual(plan.rename, [{ id: "m1", roomName: "Team A" }]);
  assert.deepEqual(plan.add, [{ roomId: "r1", roomName: "Team A", studentId: C }]);
});

test("plan: rooms that are not listed are never touched", () => {
  const active = [{ id: "m3", roomId: "r2", roomName: "Room 2", studentId: C }];
  const plan = rules.planMembershipUpdate(active, [{ id: "r1", name: "Room 1", studentIds: [A] }]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.add.map((a) => a.studentId), [A]);
});

test("snapshot and diff", () => {
  const active = [
    { roomId: "r1", studentId: B },
    { roomId: "r1", studentId: A },
    { roomId: "r2", studentId: C },
  ];
  assert.deepEqual(rules.memberSnapshot(active, "r1"), [A, B].sort());
  assert.deepEqual(rules.membershipDiff(active, [{ roomId: "r1", studentIds: [A, C] }, { roomId: "r2", studentIds: [] }]), [
    { roomId: "r1", joined: [C], left: [B] },
    { roomId: "r2", joined: [], left: [C] },
  ]);
});

test("answeredCount follows the marking's unanswered rule", () => {
  const questions = [
    { id: "q1", kind: "single" },
    { id: "q2", kind: "multiple" },
    { id: "q3", kind: "true_false" },
    { id: "q4", kind: "short" },
  ];
  assert.equal(rules.answeredCount({}, questions), 0);
  assert.equal(rules.answeredCount(null, questions), 0);
  assert.equal(
    rules.answeredCount(
      {
        q1: { kind: "single", optionId: "o1" },
        q2: { kind: "multiple", optionIds: [] },
        q3: { kind: "true_false", value: false },
        q4: { kind: "short", text: "   " },
      },
      questions
    ),
    2
  );
  assert.equal(rules.answeredCount({ q1: { kind: "short", text: "x" } }, questions), 0, "wrong kind is unanswered");
});

// ---- The teacher's proposal from the existing breakout rooms -----------------------------

test("proposal: existing rooms (main room left out) with the class students the page can place", () => {
  const rooms = [
    { id: "main", jid: "m", name: "", isMainRoom: true, participants: [{ occupantJid: "x/p0", participantId: "p0", jid: null, displayName: "Teacher" }] },
    {
      id: "r1",
      jid: "r1@b",
      name: "",
      isMainRoom: false,
      participants: [
        { occupantJid: "r1/p1", participantId: "p1", jid: null, displayName: "Bimal" },
        { occupantJid: "r1/p2", participantId: "p2", jid: null, displayName: "Amaya" },
        { occupantJid: "r1/pX", participantId: "pX", jid: null, displayName: "Guest" },
        { occupantJid: "r1/bad", participantId: null, jid: null, displayName: "?" },
      ],
    },
    { id: "r2", jid: "r2@b", name: "Room 2", isMainRoom: false, participants: [{ occupantJid: "r2/p1", participantId: "p1", jid: null, displayName: "stale" }] },
  ];
  const locations = new Map([
    [A, { participantId: "p2" }],
    [B, { participantId: "p1" }],
  ]);
  const students = [
    { studentId: A, displayName: "Amaya", email: null },
    { studentId: B, displayName: "Bimal", email: null },
  ];
  const proposal = proposeRooms(rooms, locations, students);
  assert.deepEqual(proposal, [
    { id: "r1", name: "Breakout room 1", students: [{ studentId: A, name: "Amaya" }, { studentId: B, name: "Bimal" }], otherOccupants: 2 },
    { id: "r2", name: "Room 2", students: [], otherOccupants: 0 },
  ]);
  assert.deepEqual(proposeRooms(undefined, undefined, undefined), []);
});

// ---- Request validation ---------------------------------------------------------------

test("validation: confirmed rooms (existing room id rule, names normalized, unique rooms and students)", () => {
  const ok = validation.membersUpdateSchema.parse({ rooms: [{ id: "0abad041-7a70-4fec-8ace-2db4bbaf1fee", name: "  Room\n 1 ", studentIds: [A.toUpperCase()] }] });
  assert.equal(ok.rooms[0].name, "Room 1");
  assert.deepEqual(ok.rooms[0].studentIds, [A]);
  const bad = (body) => assert.equal(validation.membersUpdateSchema.safeParse(body).success, false, JSON.stringify(body));
  bad({ rooms: [] });
  bad({ rooms: [{ id: "has space", name: "R", studentIds: [] }] });
  bad({ rooms: [{ id: "r1", name: "   ", studentIds: [] }] });
  bad({ rooms: [{ id: "r1", name: "R", studentIds: ["not-a-uuid"] }] });
  bad({ rooms: [{ id: "r1", name: "R", studentIds: [A, A] }] });
  bad({ rooms: [{ id: "r1", name: "R", studentIds: [A] }, { id: "r2", name: "R2", studentIds: [A] }] });
  bad({ rooms: [{ id: "r1", name: "R", studentIds: [] }, { id: "r1", name: "R", studentIds: [] }] });
  bad({ rooms: [{ id: "r1", name: "R", studentIds: [], extra: 1 }] });
  bad({ rooms: [{ id: "r1", name: "R", studentIds: [] }], studentId: A });
});

test("validation: group create bodies reuse the existing activity rules; no targets accepted", () => {
  const rooms = [{ id: "r1", name: "R1", studentIds: [A] }];
  assert.equal(validation.groupAssignmentCreateSchema.safeParse({ title: "T", instructions: "I", rooms, publish: true }).success, true);
  assert.equal(validation.groupAssignmentCreateSchema.safeParse({ title: "T", instructions: "I", rooms, publish: true, targets: [] }).success, false);
  assert.equal(validation.groupAssignmentCreateSchema.safeParse({ title: "", instructions: "I", rooms, publish: true }).success, false);
  const questions = [{ kind: "true_false", prompt: "P", marks: 1, correct: true }];
  assert.equal(validation.groupQuizCreateSchema.safeParse({ title: "Q", questions, rooms, publish: false }).success, true);
  assert.equal(validation.groupQuizCreateSchema.safeParse({ title: "Q", questions: [], rooms, publish: false }).success, false);
  assert.equal(validation.groupQuizSaveSchema.safeParse({ answers: {} }).success, true);
  assert.equal(validation.groupQuizSaveSchema.safeParse({ answers: {}, revision: 1 }).success, false);
});

test("validation: revision form field", () => {
  assert.equal(validation.parseRevisionField("0"), 0);
  assert.equal(validation.parseRevisionField("12"), 12);
  for (const v of [undefined, "", "-1", "01", "1.5", "x", "9999999999"]) assert.equal(validation.parseRevisionField(v), -1, String(v));
});

test("the confirmed-room directory lists exactly the confirmed rooms", async () => {
  const dir = validation.confirmedRoomDirectory([{ id: "r1", name: "R1", studentIds: [A] }]);
  assert.deepEqual(await dir.listBreakoutRooms(), [{ id: "r1", name: "R1" }]);
});

// ---- Locks -----------------------------------------------------------------------------

function fakeTx() {
  const calls = [];
  return {
    calls,
    $executeRaw: async (strings, ...values) => {
      calls.push({ sql: strings.join("?"), values });
      return 1;
    },
  };
}

test("locks: namespaced keys, shared / exclusive advisory statements, refused outside a transaction", async () => {
  const session = { id: "s1", classId: "c1", isActive: true };
  const tx = fakeTx();
  await locks.lockGroupMembers(tx, session, "shared");
  await locks.lockGroupMembers(tx, session, "exclusive");
  await locks.lockGroupActivity(tx, session, "quiz", "q1");
  assert.deepEqual(
    tx.calls.map((c) => [c.sql, c.values]),
    [
      ["SELECT pg_advisory_xact_lock_shared(hashtextextended(?, 0))", ["breakout-group-members:s1"]],
      ["SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["breakout-group-members:s1"]],
      ["SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["breakout-group-activity:quiz:q1"]],
    ]
  );
  await assert.rejects(locks.lockGroupMembers({ ...tx, $transaction() {} }, session, "shared"), /inside an interactive transaction/);
  await assert.rejects(locks.lockGroupActivity(tx, null, "quiz", "q1"), /session lock/);
  assert.throws(() => locks.groupActivityLockKey("other", "x"), TypeError);
});

// ---- Notifications -------------------------------------------------------------------------

test("events: only the session's listeners, only listed students, ids only", () => {
  const seen = [];
  const off = events.subscribeGroupChanges("s1", (p) => seen.push(p));
  events.emitGroupChange({ sessionId: "s2", kind: "quiz", activityId: "q", roomId: "r", revision: 1, memberStudentIds: [A] });
  events.emitGroupChange({ sessionId: "s1", kind: "quiz", activityId: "q", roomId: "r", revision: 2, memberStudentIds: [A] });
  off();
  events.emitGroupChange({ sessionId: "s1", kind: "quiz", activityId: "q", roomId: "r", revision: 3, memberStudentIds: [A] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].revision, 2);
  assert.equal(events.groupChangeVisibleTo(seen[0], { role: "student", studentId: A }), true);
  assert.equal(events.groupChangeVisibleTo(seen[0], { role: "student", studentId: B }), false);
  assert.equal("memberStudentIds" in events.groupChangeForClient(seen[0]), false);
});
