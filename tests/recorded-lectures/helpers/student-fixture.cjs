/*
 * Shared fixture for the student recorded-lecture tests (RL-4.2 list /
 * metadata, RL-4.3 playback): module fakes (session cookie, Prisma double
 * that evaluates queries, server clock, error log), the students, classes,
 * lectures and recordings, and student / teacher sign-in.
 *
 * Require it ONCE, first, from a test file: it registers module fakes before
 * the code under test loads. state.logs collects error-log entries.
 */

"use strict";

const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "rl-4-student-test-secret-not-a-real-one-0123456789";

const root = path.resolve(__dirname, "..", "..", "..");
require("../../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { createFakeStudentDb } = require("./fake-student-db.cjs");

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-14T10:00:00.000Z");
const state = { cookie: null, clock: NOW, fake: null, logs: [] };

fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (name === "teacher_session" && state.cookie ? { name, value: state.cookie } : undefined) }),
  headers: () => new Headers(),
});
fake("lib/prisma.ts", {
  get prisma() {
    return state.fake.prisma;
  },
});
fake("lib/server-clock.ts", {
  serverNow: async () => new Date(state.clock),
  serverNowSync: () => new Date(state.clock),
  resetServerClock() {},
});
fake("lib/error-logging/server-logger.ts", {
  // Records what would be written to the error log (an Error's own fields are not enumerable).
  logErrorEntry: (error, context) => {
    state.logs.push({ name: error?.name, message: error?.message, stack: error?.stack, kind: context?.kind, statusCode: context?.statusCode });
    return null;
  },
});
fake("lib/session-events.ts", { emitStudentDataChange: () => {} });

const { signAuthToken } = require(path.join(root, "lib", "auth.ts"));

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEACHER_A = id(1);
const TEACHER_B = id(2);
const STUDENT = id(11);
const CLASSMATE = id(12);
const CLASS_A = id(101); // enrolled, active
const CLASS_A_OTHER = id(102); // same teacher, NOT enrolled
const CLASS_A_INACTIVE = id(103); // enrolled, class status 1
const CLASS_A_REMOVED = id(104); // enrollment isActive false
const CLASS_B = id(105); // another teacher, NOT enrolled
const LECTURE = id(201); // CLASS_A, 1 day ago
const LECTURE_DELETED = id(202); // CLASS_A, status 1
const LECTURE_OTHER_CLASS = id(203);
const LECTURE_INACTIVE_CLASS = id(204);
const LECTURE_REMOVED = id(205);
const LECTURE_TEACHER_B = id(206);

const STORED = "0123456789abcdef0123456789abcdef.mp4";
const ORIGINAL_NAME = "Private original upload name.mp4";

const R = {
  ok: id(501),
  okPart2: id(502),
  uploading: id(503),
  verifying: id(504),
  failed: id(505),
  removed: id(506),
  purgePending: id(507),
  noStoredName: id(508),
  deletedLecture: id(509),
  otherClass: id(510),
  inactiveClass: id(511),
  removedEnrollment: id(512),
  otherTeacher: id(513),
};

function recording(recId, lectureId, classId, teacherId, extra = {}) {
  return {
    id: recId,
    lectureId,
    classId,
    teacherId,
    title: `Recording ${recId.slice(-3)}`,
    partNumber: 1,
    displayFileName: ORIGINAL_NAME,
    mimeType: "video/mp4",
    sizeBytes: BigInt("5000000000"),
    storedFileName: STORED,
    durationSeconds: 3600,
    width: 1280,
    height: 720,
    videoCodec: "avc1",
    audioCodec: "mp4a",
    fragmented: false,
    state: "READY",
    failureCode: null,
    status: 0,
    deletedAt: null,
    deletedByTeacherId: null,
    purgeRequestedAt: null,
    purgedAt: null,
    createdAt: new Date(NOW - 2 * DAY),
    updatedAt: new Date(NOW - 2 * DAY),
    readyAt: new Date(NOW - DAY),
    failedAt: null,
    ...extra,
  };
}

function lecture(lectureId, classId, extra = {}) {
  return { id: lectureId, classId, title: `Lecture ${lectureId.slice(-3)}`, date: new Date(NOW - DAY), endDate: null, status: 0, ...extra };
}

function seed() {
  state.fake = createFakeStudentDb();
  const { db } = state.fake;
  db.students.push(
    { id: STUDENT, status: 0, sessionVersion: 0, confirmationStatus: "APPROVED", teacherId: TEACHER_A },
    { id: CLASSMATE, status: 0, sessionVersion: 0, confirmationStatus: "APPROVED", teacherId: TEACHER_A }
  );
  db.classes.push(
    { id: CLASS_A, teacherId: TEACHER_A, status: 0, name: "Grade 10 Maths" },
    { id: CLASS_A_OTHER, teacherId: TEACHER_A, status: 0, name: "Grade 11 Maths" },
    { id: CLASS_A_INACTIVE, teacherId: TEACHER_A, status: 1, name: "Old class" },
    { id: CLASS_A_REMOVED, teacherId: TEACHER_A, status: 0, name: "Left class" },
    { id: CLASS_B, teacherId: TEACHER_B, status: 0, name: "Other teacher" }
  );
  db.classStudents.push(
    { id: id(301), classId: CLASS_A, studentId: STUDENT, isActive: true },
    { id: id(302), classId: CLASS_A_INACTIVE, studentId: STUDENT, isActive: true },
    { id: id(303), classId: CLASS_A_REMOVED, studentId: STUDENT, isActive: false },
    { id: id(304), classId: CLASS_A_OTHER, studentId: CLASSMATE, isActive: true },
    { id: id(305), classId: CLASS_B, studentId: CLASSMATE, isActive: true }
  );
  db.lectures.push(
    lecture(LECTURE, CLASS_A),
    lecture(LECTURE_DELETED, CLASS_A, { status: 1 }),
    lecture(LECTURE_OTHER_CLASS, CLASS_A_OTHER),
    lecture(LECTURE_INACTIVE_CLASS, CLASS_A_INACTIVE),
    lecture(LECTURE_REMOVED, CLASS_A_REMOVED),
    lecture(LECTURE_TEACHER_B, CLASS_B)
  );
  db.recordings.push(
    recording(R.ok, LECTURE, CLASS_A, TEACHER_A),
    recording(R.okPart2, LECTURE, CLASS_A, TEACHER_A, { partNumber: 2 }),
    recording(R.uploading, LECTURE, CLASS_A, TEACHER_A, { partNumber: 3, state: "UPLOADING", storedFileName: null, readyAt: null }),
    recording(R.verifying, LECTURE, CLASS_A, TEACHER_A, { partNumber: 4, state: "VERIFYING", readyAt: null }),
    recording(R.failed, LECTURE, CLASS_A, TEACHER_A, { partNumber: 5, state: "FAILED", failureCode: "MP4_INVALID", readyAt: null }),
    recording(R.removed, LECTURE, CLASS_A, TEACHER_A, { partNumber: 6, status: 1 }),
    recording(R.purgePending, LECTURE, CLASS_A, TEACHER_A, { partNumber: 7, status: 2 }),
    // Not a state the database CHECKs allow for READY; tested anyway (defence in depth).
    recording(R.noStoredName, LECTURE, CLASS_A, TEACHER_A, { partNumber: 8, storedFileName: null }),
    recording(R.deletedLecture, LECTURE_DELETED, CLASS_A, TEACHER_A),
    recording(R.otherClass, LECTURE_OTHER_CLASS, CLASS_A_OTHER, TEACHER_A),
    recording(R.inactiveClass, LECTURE_INACTIVE_CLASS, CLASS_A_INACTIVE, TEACHER_A),
    recording(R.removedEnrollment, LECTURE_REMOVED, CLASS_A_REMOVED, TEACHER_A),
    recording(R.otherTeacher, LECTURE_TEACHER_B, CLASS_B, TEACHER_B)
  );
}

async function signIn(studentId = STUDENT, sessionVersion = 0) {
  state.cookie = await signAuthToken({ sub: studentId, email: "s@example.com", name: "Student", role: "STUDENT", sessionVersion });
}
async function signInTeacher() {
  state.cookie = await signAuthToken({ sub: TEACHER_A, email: "t@example.com", name: "Teacher", role: "TEACHER" });
}

module.exports = {
  root,
  state,
  fake,
  DAY,
  NOW,
  id,
  TEACHER_A,
  TEACHER_B,
  STUDENT,
  CLASSMATE,
  CLASS_A,
  CLASS_A_OTHER,
  CLASS_A_INACTIVE,
  CLASS_A_REMOVED,
  CLASS_B,
  LECTURE,
  LECTURE_DELETED,
  LECTURE_OTHER_CLASS,
  LECTURE_INACTIVE_CLASS,
  LECTURE_REMOVED,
  LECTURE_TEACHER_B,
  STORED,
  ORIGINAL_NAME,
  R,
  recording,
  lecture,
  seed,
  signIn,
  signInTeacher,
};
