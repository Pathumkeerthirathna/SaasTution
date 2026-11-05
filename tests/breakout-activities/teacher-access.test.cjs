/*
 * Teacher access (lib/breakout-activities/teacher-access.ts): route ids,
 * session ownership (another teacher's session is the same 404 as a missing
 * one), and the ownership check inside a write transaction. A fake Prisma
 * client answers the two queries; no database is contacted.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const access = require(path.join(root, "lib/breakout-activities/teacher-access.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const SESSION = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";
const OTHER_SESSION = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const CLASS = "class-1";
const TEACHER = "teacher-1";
const OTHER_TEACHER = "teacher-2";

/** Sessions: { id, classId, isActive, teacherId }. Records every where clause. */
function fakeDb(sessions = [{ id: SESSION, classId: CLASS, isActive: true, teacherId: TEACHER }]) {
  const calls = [];
  return {
    calls,
    classSession: {
      findFirst: async ({ where, select }) => {
        calls.push({ model: "classSession", where, select });
        const row = sessions.find((s) => s.id === where.id && s.teacherId === where.class.teacherId);
        return row ? { id: row.id, classId: row.classId, isActive: row.isActive } : null;
      },
    },
    class: {
      findUnique: async ({ where, select }) => {
        calls.push({ model: "class", where, select });
        const row = sessions.find((s) => s.classId === where.id);
        return row ? { teacherId: row.teacherId } : null;
      },
    },
  };
}

const notFound = (code) => (e) => {
  assert.ok(e instanceof AppError);
  assert.equal(e.statusCode, 404);
  assert.equal(e.code, code);
  return true;
};

test("route ids: UUIDs only (lower-cased); anything else is 404 before any query", () => {
  assert.equal(access.requireRouteId(SESSION), SESSION);
  assert.equal(access.requireRouteId(SESSION.toUpperCase()), SESSION);
  for (const bad of ["", "abc", `${SESSION} `, `${SESSION}x`, "../x", "6e445fc0-1c04-46bd-8dd3-82acfa381b2", 42, null, undefined, {}]) {
    assert.throws(() => access.requireRouteId(bad), notFound("NOT_FOUND"), String(bad));
  }
  assert.throws(() => access.requireRouteId("x", "QUIZ_NOT_FOUND"), notFound("QUIZ_NOT_FOUND"));
});

test("the teacher's own session: returned whatever its state", async () => {
  for (const isActive of [true, false]) {
    const db = fakeDb([{ id: SESSION, classId: CLASS, isActive, teacherId: TEACHER }]);
    assert.deepEqual(await access.requireTeacherSessionAccess(db, TEACHER, SESSION), { sessionId: SESSION, classId: CLASS, isActive });
    assert.deepEqual(db.calls[0].where, { id: SESSION, class: { teacherId: TEACHER } }, "ownership is part of the query");
  }
});

test("another teacher's session and a missing session are the same 404", async () => {
  const db = fakeDb();
  await assert.rejects(access.requireTeacherSessionAccess(db, OTHER_TEACHER, SESSION), notFound("SESSION_NOT_FOUND"));
  await assert.rejects(access.requireTeacherSessionAccess(db, TEACHER, OTHER_SESSION), notFound("SESSION_NOT_FOUND"));
});

test("an invalid session id or teacher id is 404 without a query", async () => {
  const db = fakeDb();
  await assert.rejects(access.requireTeacherSessionAccess(db, TEACHER, "not-a-uuid"), notFound("SESSION_NOT_FOUND"));
  await assert.rejects(access.requireTeacherSessionAccess(db, "", SESSION), notFound("SESSION_NOT_FOUND"));
  await assert.rejects(access.requireTeacherSessionAccess(db, undefined, SESSION), notFound("SESSION_NOT_FOUND"));
  assert.equal(db.calls.length, 0);
});

test("inside a transaction: the locked session's class must be the teacher's", async () => {
  const db = fakeDb();
  const lock = Object.freeze({ id: SESSION, classId: CLASS, isActive: true });
  await access.assertTeacherOwnsLockedSession(db, lock, TEACHER);
  assert.deepEqual(db.calls[0].where, { id: CLASS });
  await assert.rejects(access.assertTeacherOwnsLockedSession(db, lock, OTHER_TEACHER), notFound("SESSION_NOT_FOUND"));
  await assert.rejects(access.assertTeacherOwnsLockedSession(db, { ...lock, classId: "missing" }, TEACHER), notFound("SESSION_NOT_FOUND"));
  await assert.rejects(access.assertTeacherOwnsLockedSession(db, lock, ""), notFound("SESSION_NOT_FOUND"));
});
