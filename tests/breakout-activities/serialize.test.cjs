/*
 * Teacher views (lib/breakout-activities/serialize.ts): allow-listed fields
 * only (no file paths, idempotency keys, status or teacherId, nothing added
 * later), Decimal -> number, dates -> ISO.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const s = require(path.join(root, "lib/breakout-activities/serialize.ts"));
// Prisma's real Decimal class (the installed runtime; no client, no database).
const Prisma = { Decimal: require("@prisma/client/runtime/library").Decimal };

const AT = new Date("2026-11-05T10:00:00.123Z");
const FORBIDDEN = ["briefFilePath", "filePath", "idempotencyKey", "status", "teacherId", "classSessionId", "secretColumn"];

/** Every key at any depth (for "never sent" checks). */
function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}
const assertNoForbidden = (view) => {
  for (const key of FORBIDDEN) assert.equal(keysDeep(view).has(key), false, key);
};

const activity = {
  id: "a1",
  classSessionId: "s1",
  teacherId: "t1",
  publishGroupId: "g1",
  targetRoomType: "BREAKOUT",
  targetRoomId: "r1",
  targetRoomName: "Room 1",
  title: "Essay",
  state: "PUBLISHED",
  publishedAt: AT,
  closedAt: null,
  status: 0,
  createdAt: AT,
  updatedAt: AT,
  secretColumn: "added later",
};
const student = { id: "st1", name: "Nimal", registrationNumber: null, password: "hash", email: "x@example.com" };

test("assignment: allow-listed fields, brief metadata without its path, optional counts", () => {
  const view = s.serializeAssignmentForTeacher(
    { ...activity, instructions: "Write", briefFileName: "brief.pdf", briefFilePath: "breakout-activities/s1/briefs/g1/x.pdf", briefFileSize: 1234 },
    { studentsSubmitted: 2, submissions: 3, drafts: 4, extra: 9 }
  );
  assert.deepEqual(view, {
    id: "a1",
    publishGroupId: "g1",
    target: { type: "BREAKOUT", id: "r1", name: "Room 1" },
    title: "Essay",
    state: "PUBLISHED",
    publishedAt: AT.toISOString(),
    closedAt: null,
    createdAt: AT.toISOString(),
    updatedAt: AT.toISOString(),
    instructions: "Write",
    brief: { fileName: "brief.pdf", fileSize: 1234 },
    counts: { studentsSubmitted: 2, submissions: 3, drafts: 4 },
  });
  assertNoForbidden(view);
  const noBrief = s.serializeAssignmentForTeacher({ ...activity, instructions: "", briefFileName: null, briefFileSize: null });
  assert.equal(noBrief.brief, null);
  assert.equal("counts" in noBrief, false);
});

test("quiz: totalMarks as a number; the definition only when asked for", () => {
  const questions = { schemaVersion: 1, questions: [{ id: "q1", kind: "true_false", prompt: "?", marks: 1, correct: true }] };
  const row = { ...activity, instructions: null, questions, totalMarks: new Prisma.Decimal("12.50"), timeLimitSeconds: 600 };
  const list = s.serializeQuizForTeacher(row, { counts: { attempts: 3, inProgress: 1, submitted: 2 } });
  assert.equal(list.totalMarks, 12.5);
  assert.equal(list.timeLimitSeconds, 600);
  assert.equal(list.instructions, null);
  assert.equal("questions" in list, false, "list views carry no answer keys");
  assert.deepEqual(list.counts, { attempts: 3, inProgress: 1, submitted: 2 });
  const full = s.serializeQuizForTeacher(row, { includeDefinition: true });
  assert.deepEqual(full.questions, questions);
  assertNoForbidden(full);
});

test("assignment submission: no file path or idempotency key; student id, name, registration number only", () => {
  const view = s.serializeAssignmentSubmissionForTeacher(
    {
      id: "sub1",
      assignmentId: "a1",
      classSessionId: "s1",
      studentId: "st1",
      version: 2,
      isLatest: true,
      answerText: "Answer",
      fileName: "answer.pdf",
      filePath: "breakout-activities/s1/submissions/a1/x.pdf",
      fileSize: 99,
      idempotencyKey: "key-1",
      submittedAt: AT,
      student,
    },
    { versionCount: 2 }
  );
  assert.deepEqual(view, {
    id: "sub1",
    version: 2,
    isLatest: true,
    submittedAt: AT.toISOString(),
    answerText: "Answer",
    file: { fileName: "answer.pdf", fileSize: 99 },
    student: { id: "st1", name: "Nimal", registrationNumber: null },
    versionCount: 2,
  });
  assertNoForbidden(view);
  assert.equal(keysDeep(view).has("password"), false);
  assert.equal(keysDeep(view).has("email"), false);
});

test("quiz attempt: scores as numbers, dates as ISO, grading and answers passed through", () => {
  const view = s.serializeQuizAttemptForTeacher({
    id: "att1",
    quizId: "q1",
    classSessionId: "s1",
    studentId: "st1",
    attemptStatus: "SUBMITTED",
    answers: { q1: { kind: "true_false", value: true } },
    revision: 3,
    grading: { schemaVersion: 1, questions: {} },
    autoScore: new Prisma.Decimal("1.00"),
    finalScore: "1.5",
    startedAt: AT,
    deadlineAt: null,
    lastSavedAt: AT.toISOString(),
    submittedAt: AT,
    overriddenAt: null,
    updatedAt: AT,
    student,
  });
  assert.equal(view.autoScore, 1);
  assert.equal(view.finalScore, 1.5);
  assert.equal(view.lastSavedAt, AT.toISOString());
  assert.equal(view.deadlineAt, null);
  assert.equal("updatedAt" in view, false);
  assertNoForbidden(view);
  const empty = s.serializeQuizAttemptForTeacher({ ...view, answers: null, grading: undefined, autoScore: null, finalScore: null, student });
  assert.deepEqual(empty.answers, {});
  assert.equal(empty.grading, null);
  assert.equal(empty.autoScore, null);
});

test("conversions refuse garbage instead of sending it", () => {
  assert.equal(s.toIso(null), null);
  assert.equal(s.toIso("2026-11-05T10:00:00Z"), "2026-11-05T10:00:00.000Z");
  assert.throws(() => s.toIso("not a date"), RangeError);
  assert.equal(s.toNumber(undefined), null);
  assert.equal(s.toNumber("7.25"), 7.25);
  assert.throws(() => s.toNumber("abc"), RangeError);
});
