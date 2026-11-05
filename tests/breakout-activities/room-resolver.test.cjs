/*
 * Student room resolution (lib/breakout-activities/room-resolver.ts): the
 * Phase 2a default fails closed (404 for every student), injected resolvers
 * are validated, and activity targeting matches exactly.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const rooms = require(path.join(root, "lib/breakout-activities/room-resolver.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const query = { sessionId: "session-1", studentId: "student-1" };
const notFound = (e) => {
  assert.ok(e instanceof AppError);
  assert.equal(e.statusCode, 404);
  assert.equal(e.code, "NOT_FOUND");
  return true;
};
const resolver = (answer) => ({ resolveStudentRoom: async () => answer });

test("the default resolver fails closed: no room for anyone, 404", async () => {
  assert.equal(rooms.defaultStudentRoomResolver, rooms.failClosedStudentRoomResolver);
  assert.equal(await rooms.defaultStudentRoomResolver.resolveStudentRoom(query), null);
  await assert.rejects(rooms.requireStudentRoom(query), notFound);
});

test("an injected resolver's valid answer is returned (copied, extra fields dropped)", async () => {
  assert.deepEqual(await rooms.requireStudentRoom(query, resolver({ type: "MAIN", id: "ignored" })), { type: "MAIN" });
  assert.deepEqual(await rooms.requireStudentRoom(query, resolver({ type: "BREAKOUT", id: "room-a@breakout.example", extra: 1 })), {
    type: "BREAKOUT",
    id: "room-a@breakout.example",
  });
});

test("invalid answers fail closed", async () => {
  for (const answer of [null, undefined, {}, { type: "BREAKOUT" }, { type: "BREAKOUT", id: "" }, { type: "breakout", id: "x" }, "MAIN", 1]) {
    await assert.rejects(rooms.requireStudentRoom(query, resolver(answer)), notFound, JSON.stringify(answer));
  }
});

test("a resolver failure fails closed (404, logged, not a 500)", async () => {
  const saved = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(
      rooms.requireStudentRoom(query, { resolveStudentRoom: async () => { throw new Error("roster unavailable"); } }),
      notFound
    );
  } finally {
    console.error = saved;
  }
  assert.equal(logged.length, 1);
});

test("activity targeting: MAIN matches MAIN, BREAKOUT matches the same id only", () => {
  const main = { targetRoomType: "MAIN", targetRoomId: null };
  const roomA = { targetRoomType: "BREAKOUT", targetRoomId: "room-a" };
  assert.equal(rooms.activityTargetsRoom(main, { type: "MAIN" }), true);
  assert.equal(rooms.activityTargetsRoom(main, { type: "BREAKOUT", id: "room-a" }), false);
  assert.equal(rooms.activityTargetsRoom(roomA, { type: "BREAKOUT", id: "room-a" }), true);
  assert.equal(rooms.activityTargetsRoom(roomA, { type: "BREAKOUT", id: "room-b" }), false);
  assert.equal(rooms.activityTargetsRoom(roomA, { type: "BREAKOUT", id: "ROOM-A" }), false, "exact match");
  assert.equal(rooms.activityTargetsRoom(roomA, { type: "MAIN" }), false);
  assert.equal(rooms.activityTargetsRoom({ targetRoomType: "BREAKOUT", targetRoomId: null }, { type: "BREAKOUT", id: "" }), false);
});
