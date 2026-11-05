/*
 * Activity target rooms (lib/breakout-activities/target-rooms.ts): MAIN is
 * always resolved; BREAKOUT rooms only through a trusted directory, which
 * fails closed by default (Phase 2b provides the roster). One unresolvable
 * BREAKOUT target refuses the WHOLE request with 409 ROOM_UNKNOWN, the MAIN
 * target included. Client-sent names are never used.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const rooms = require(path.join(root, "lib/breakout-activities/target-rooms.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const query = { sessionId: "session-1", teacherId: "teacher-1" };
const MAIN = { type: "MAIN" };
const room = (id) => ({ type: "BREAKOUT", id });
const directory = (list) => {
  const calls = [];
  return { calls, listBreakoutRooms: async (q) => (calls.push(q), list) };
};
const roomUnknown = (e) => {
  assert.ok(e instanceof AppError);
  assert.equal(e.statusCode, 409);
  assert.equal(e.code, "ROOM_UNKNOWN");
  return true;
};

test("MAIN alone: resolved without consulting the directory", async () => {
  const dir = directory(null);
  assert.deepEqual(await rooms.resolveTargets([MAIN], query, dir), [
    { targetRoomType: "MAIN", targetRoomId: null, targetRoomName: "Main room" },
  ]);
  assert.equal(dir.calls.length, 0);
  assert.equal(rooms.MAIN_ROOM_NAME, "Main room");
});

test("the default directory fails closed: any BREAKOUT target is 409 ROOM_UNKNOWN", async () => {
  assert.equal(rooms.defaultTeacherRoomDirectory, rooms.failClosedTeacherRoomDirectory);
  assert.equal(await rooms.defaultTeacherRoomDirectory.listBreakoutRooms(query), null);
  await assert.rejects(rooms.resolveTargets([room("r1")], query), roomUnknown);
});

test("all or nothing: MAIN plus an unresolvable BREAKOUT target refuses the whole request", async () => {
  await assert.rejects(rooms.resolveTargets([MAIN, room("r1")], query), roomUnknown, "default directory");
  const dir = directory([{ id: "r1", name: "Room 1" }]);
  await assert.rejects(rooms.resolveTargets([MAIN, room("r1"), room("r2")], query, dir), roomUnknown, "r2 is not listed");
});

test("a trusted directory: names come from it, in the targets' order, never from the client", async () => {
  const dir = directory([
    { id: "r2", name: "  Room   Two " },
    { id: "r1", name: "Room One" },
  ]);
  assert.deepEqual(await rooms.resolveTargets([room("r1"), MAIN, room("r2")], query, dir), [
    { targetRoomType: "BREAKOUT", targetRoomId: "r1", targetRoomName: "Room One" },
    { targetRoomType: "MAIN", targetRoomId: null, targetRoomName: "Main room" },
    { targetRoomType: "BREAKOUT", targetRoomId: "r2", targetRoomName: "Room Two" },
  ]);
  assert.deepEqual(dir.calls, [query], "consulted once, with the session and teacher");
  // A name the client might add to a target is ignored.
  const [only] = await rooms.resolveTargets([{ type: "BREAKOUT", id: "r1", name: "Spoofed" }], query, dir);
  assert.equal(only.targetRoomName, "Room One");
});

test("ids match exactly", async () => {
  const dir = directory([{ id: "room-a@breakout.example", name: "A" }]);
  await assert.rejects(rooms.resolveTargets([room("ROOM-A@breakout.example")], query, dir), roomUnknown);
  await assert.rejects(rooms.resolveTargets([room("room-a")], query, dir), roomUnknown);
});

test("unknown roster, directory failure or unusable entries fail closed", async () => {
  for (const list of [null, undefined, "rooms", {}, [{ id: "r1" }], [{ id: "r1", name: "   " }], [{ id: "r1", name: 7 }], [{ name: "x" }], [null]]) {
    await assert.rejects(rooms.resolveTargets([room("r1")], query, directory(list)), roomUnknown, JSON.stringify(list));
  }
  const saved = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(
      rooms.resolveTargets([MAIN, room("r1")], query, { listBreakoutRooms: async () => { throw new Error("roster down"); } }),
      roomUnknown
    );
  } finally {
    console.error = saved;
  }
  assert.equal(logged.length, 1);
});

test("room names fit VARCHAR(120) in code points; controls and bidi overrides removed; ZWJ kept", () => {
  assert.equal(rooms.ROOM_NAME_MAX, 120);
  const long = "ක".repeat(130);
  assert.equal(Array.from(rooms.normalizeRoomName(long)).length, 120);
  assert.equal(rooms.normalizeRoomName("Room‮1\u0000\n2"), "Room1 2");
  assert.equal(rooms.normalizeRoomName("ශ්‍රී"), "ශ්‍රී", "ZWJ (U+200D) is kept");
  assert.equal(rooms.normalizeRoomName("‎ \t"), null);
  assert.equal(rooms.normalizeRoomName(undefined), null);
});

test("no targets is a validation error", async () => {
  await assert.rejects(rooms.resolveTargets([], query), (e) => e.code === "VALIDATION_ERROR" && e.statusCode === 400);
});
