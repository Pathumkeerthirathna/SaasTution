/*
 * Recordings > YouTube Live Sessions / Live Recordings: the pages' server-side
 * class / lecture selection (app/dashboard/recordings/_lib/youtube-lecture-selection.ts).
 * The teacher's ACTIVE classes only; ?classId= only when it is one of them;
 * ?lectureId= only as a NORMAL, active lecture of that class (never a default
 * lecture, never another class's or teacher's). Faked edge: Prisma (records
 * the queries and answers from a small store). No database.
 *
 *   npm run test:youtube
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const T1 = "teacher-1";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C_OTHER = "33333333-3333-4333-8333-333333333333";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const D1 = "aaaaaaaa-0000-4000-8000-00000000000d";
const L_OTHER_CLASS = "bbbbbbbb-0000-4000-8000-000000000001";

const queries = [];
const store = {
  classes: [
    { id: C1, name: "Physics", teacherId: T1, status: 0 },
    { id: C2, name: "Chemistry", teacherId: T1, status: 0 },
    { id: "44444444-4444-4444-8444-444444444444", name: "Old", teacherId: T1, status: 1 },
    { id: C_OTHER, name: "Theirs", teacherId: "teacher-2", status: 0 },
  ],
  lectures: [
    { id: L1, classId: C1, status: 0, isDefault: false },
    { id: D1, classId: C1, status: 0, isDefault: true },
    { id: L_OTHER_CLASS, classId: C2, status: 0, isDefault: false },
  ],
};
const prisma = {
  class: {
    findMany: async ({ where }) => {
      queries.push(["class.findMany", where]);
      return store.classes.filter((c) => c.teacherId === where.teacherId && c.status === where.status).map((c) => ({ id: c.id, name: c.name }));
    },
  },
  lecture: {
    findFirst: async ({ where }) => {
      queries.push(["lecture.findFirst", where]);
      const l = store.lectures.find((x) => x.id === where.id && x.classId === where.classId && x.status === where.status && x.isDefault === where.isDefault);
      const cls = l && store.classes.find((c) => c.id === l.classId);
      return l && cls.teacherId === where.class.teacherId && cls.status === where.class.status ? { id: l.id } : null;
    },
  },
};
const filename = path.join(root, "lib", "prisma.ts");
const mod = new Module(filename);
mod.filename = filename;
mod.loaded = true;
mod.exports = { prisma };
require.cache[filename] = mod;

const { loadYouTubeLectureSelection } = require(path.join(root, "app", "dashboard", "recordings", "_lib", "youtube-lecture-selection.ts"));

test("the teacher's active classes only; no parameters: nothing pre-selected", async () => {
  queries.length = 0;
  const selection = await loadYouTubeLectureSelection(T1, {});
  assert.deepEqual(selection.classes.map((c) => c.id), [C1, C2]);
  assert.deepEqual([selection.initialClassId, selection.initialLectureId], [null, null]);
  assert.deepEqual(queries[0], ["class.findMany", { teacherId: T1, status: 0 }]);
  assert.equal(queries.length, 1, "no lecture query without a lecture parameter");
});

test("?classId= / ?lectureId=: a normal lecture of one of the teacher's classes is accepted", async () => {
  const selection = await loadYouTubeLectureSelection(T1, { classId: C1, lectureId: L1 });
  assert.deepEqual([selection.initialClassId, selection.initialLectureId], [C1, L1]);
  const where = queries.find((q) => q[0] === "lecture.findFirst")[1];
  assert.equal(where.isDefault, false, "never a default lecture");
  assert.deepEqual(where.class, { teacherId: T1, status: 0 });
});

test("rejected: another teacher's class, a deactivated class, a default lecture, another class's lecture, a lecture without its class, arrays and oversized values", async () => {
  const cases = [
    [{ classId: C_OTHER, lectureId: L1 }, [null, null]],
    [{ classId: "44444444-4444-4444-8444-444444444444" }, [null, null]],
    [{ classId: C1, lectureId: D1 }, [C1, null]],
    [{ classId: C1, lectureId: L_OTHER_CLASS }, [C1, null]],
    [{ lectureId: L1 }, [null, null]],
    [{ classId: [C1, C2] }, [null, null]],
    [{ classId: C1, lectureId: "x".repeat(65) }, [C1, null]],
  ];
  for (const [params, expected] of cases) {
    const selection = await loadYouTubeLectureSelection(T1, params);
    assert.deepEqual([selection.initialClassId, selection.initialLectureId], expected, JSON.stringify(params));
  }
});
