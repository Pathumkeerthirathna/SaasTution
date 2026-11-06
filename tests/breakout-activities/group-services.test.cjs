/*
 * Breakout Group Activities services (services/breakout-group-*.ts):
 * confirmed membership (enrolment, one room per student, moves, other
 * teachers / ended sessions), group creation through the EXISTING create
 * services (and the existing routes still failing closed), the shared
 * assignment workspace (revision conflicts, latest editor, final submission,
 * membership snapshot, duplicate submits, PDFs), the shared quiz (one
 * attempt, per-question merge, deadline and lazy auto-submit, grading and
 * overrides), progress overviews, change notifications, lock order, and the
 * isolation of GROUP activities from the existing individual services.
 *
 * Real service modules; lib/prisma.ts is the in-memory fake (rolls back on
 * error), lib/server-clock.ts a settable clock. No database is contacted.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeGroupDb } = require("./helpers/fake-group-db.cjs");

let db;
let clock = new Date("2026-11-06T09:00:00.000Z");
function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
fake("lib/prisma.ts", { prisma: new Proxy({}, { get: (_, key) => db.client[key] }) });
fake("lib/server-clock.ts", { serverNow: async () => new Date(clock), serverNowSync: () => new Date(clock), resetServerClock() {} });

const members = require(path.join(root, "services/breakout-group-membership-service.ts"));
const groupAssignments = require(path.join(root, "services/breakout-group-assignment-service.ts"));
const groupQuizzes = require(path.join(root, "services/breakout-group-quiz-service.ts"));
const overview = require(path.join(root, "services/breakout-group-overview-service.ts"));
const teacherAssignments = require(path.join(root, "services/breakout-assignment-service.ts"));
const teacherQuizzes = require(path.join(root, "services/breakout-quiz-service.ts"));
const studentAssignments = require(path.join(root, "services/breakout-student-assignment-service.ts"));
const studentQuizzes = require(path.join(root, "services/breakout-student-quiz-service.ts"));
const events = require(path.join(root, "lib/breakout-activities/groups/events.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21"; // active, class c1 (teacher t1)
const S_ENDED = "1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b"; // ended, class c1
const S_OTHER = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"; // active, class c2 (teacher t2)
const A = "a1111111-1111-4111-8111-111111111111";
const B = "a2222222-2222-4222-8222-222222222222";
const C = "a3333333-3333-4333-8333-333333333333";
const X = "a4444444-4444-4444-8444-444444444444"; // not enrolled anywhere
const Y = "a5555555-5555-4555-8555-555555555555"; // enrolled in c2 only
const R1 = "f0f0f0f0-0000-4000-8000-00000000a001";
const R2 = "f0f0f0f0-0000-4000-8000-00000000a002";

let storageRoot;
const emitted = [];
let unsubscribe = () => {};

const appError = (status, code) => (error) => {
  assert.ok(error instanceof AppError, `expected AppError, got ${error && error.stack}`);
  assert.equal(error.statusCode ?? error.status, status, `status of ${error.code}`);
  assert.equal(error.code, code);
  return true;
};

const PDF = () => new Uint8Array(Buffer.from("%PDF-1.4\n% group work\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n"));

test.beforeEach(() => {
  clock = new Date("2026-11-06T09:00:00.000Z");
  db = createFakeGroupDb();
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "breakout-groups-"));
  db.tables.class.push({ id: "c1", teacherId: "t1" }, { id: "c2", teacherId: "t2" });
  db.tables.classSession.push(
    { id: S1, classId: "c1", isActive: true },
    { id: S_ENDED, classId: "c1", isActive: false },
    { id: S_OTHER, classId: "c2", isActive: true }
  );
  for (const [id, name] of [[A, "Amaya"], [B, "Bimal"], [C, "Chathu"], [X, "Xavier"], [Y, "Yasas"]]) db.tables.student.push({ id, name, status: 0, registrationNumber: null });
  for (const id of [A, B, C]) db.tables.classStudent.push({ studentId: id, classId: "c1", isActive: true });
  db.tables.classStudent.push({ studentId: Y, classId: "c2", isActive: true });
  emitted.length = 0;
  unsubscribe = events.subscribeGroupChanges(S1, (payload) => emitted.push(payload));
});

test.afterEach(() => {
  unsubscribe();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

const ROOMS = () => [
  { id: R1, name: "Room 1", studentIds: [A, B] },
  { id: R2, name: "Room 2", studentIds: [C] },
];

const confirm = (rooms = ROOMS(), teacherId = "t1", sessionId = S1) => members.confirmGroupMembers({ teacherId, sessionId, rooms });

async function createAssignment(extra = {}) {
  const result = await groupAssignments.createGroupAssignments(
    { teacherId: "t1", sessionId: S1, title: "Poster", instructions: "Make a poster", rooms: ROOMS(), publish: true, brief: null, ...extra },
    { storageRoot }
  );
  const byRoom = Object.fromEntries(result.assignments.map((a) => [a.target.id, a.id]));
  return { result, r1: byRoom[R1], r2: byRoom[R2] };
}

const QUESTIONS = () => [
  { kind: "single", prompt: "2 + 2?", marks: 2, options: [{ text: "4", correct: true }, { text: "5", correct: false }] },
  { kind: "true_false", prompt: "The sky is blue.", marks: 1, correct: true },
  { kind: "short", prompt: "Capital of Sri Lanka?", marks: 1, acceptedAnswers: ["Colombo", "Sri Jayawardenepura Kotte"] },
];

async function createQuiz(extra = {}) {
  const result = await groupQuizzes.createGroupQuizzes({
    teacherId: "t1",
    sessionId: S1,
    title: "Group quiz",
    instructions: "Together",
    timeLimitSeconds: 600,
    questions: QUESTIONS(),
    rooms: ROOMS(),
    publish: true,
    ...extra,
  });
  const byRoom = Object.fromEntries(result.quizzes.map((q) => [q.target.id, q.id]));
  return { result, r1: byRoom[R1], r2: byRoom[R2] };
}

const work = (studentId, assignmentId) => groupAssignments.getGroupAssignmentForStudent({ studentId, sessionId: S1, assignmentId });
const save = (studentId, assignmentId, revision, answerText) => groupAssignments.saveGroupAssignmentWork({ studentId, sessionId: S1, assignmentId, revision, answerText });
const submit = (studentId, assignmentId, revision, file = null) => groupAssignments.submitGroupAssignment({ studentId, sessionId: S1, assignmentId, revision, file }, { storageRoot });

// ---- Membership ---------------------------------------------------------------------

test("membership: the teacher confirms rooms; one active row per student; explicit timestamps", async () => {
  const result = await confirm();
  assert.deepEqual(result.rooms.map((r) => [r.id, r.studentIds]), [[R1, [A, B].sort()], [R2, [C]]]);
  const active = db.tables.breakoutRoomMember.filter((m) => m.status === 0);
  assert.deepEqual(active.map((m) => [m.roomId, m.studentId]).sort(), [[R1, A], [R1, B], [R2, C]].sort());
  for (const m of active) {
    assert.equal(m.confirmedByTeacherId, "t1");
    assert.equal(new Date(m.confirmedAt).toISOString(), clock.toISOString());
    assert.equal(new Date(m.updatedAt).toISOString(), clock.toISOString(), "updatedAt from the database clock");
  }
});

test("membership: a student who is not enrolled (or in another class) is refused and nothing is written", async () => {
  await assert.rejects(confirm([{ id: R1, name: "Room 1", studentIds: [A, X] }]), appError(400, "STUDENT_NOT_IN_CLASS"));
  await assert.rejects(confirm([{ id: R1, name: "Room 1", studentIds: [Y] }]), appError(400, "STUDENT_NOT_IN_CLASS"));
  assert.equal(db.tables.breakoutRoomMember.length, 0);
  await assert.rejects(confirm([{ id: R1, name: "Room 1", studentIds: [A] }, { id: R2, name: "Room 2", studentIds: [A] }]), appError(400, "STUDENT_IN_TWO_ROOMS"));
});

test("membership: another teacher's session is 404, an ended session 409", async () => {
  await assert.rejects(confirm(ROOMS(), "t2"), appError(404, "SESSION_NOT_FOUND"));
  await assert.rejects(confirm(ROOMS(), "t1", S_ENDED), appError(409, "SESSION_NOT_ACTIVE"));
  await assert.rejects(confirm(ROOMS(), "t1", S_OTHER), appError(404, "SESSION_NOT_FOUND"));
});

test("membership: moving a student removes the old membership; rooms not listed stay; history kept", async () => {
  await confirm();
  clock = new Date(clock.getTime() + 60_000);
  await confirm([{ id: R2, name: "Room 2", studentIds: [C, B] }]); // B moves R1 -> R2
  const active = db.tables.breakoutRoomMember.filter((m) => m.status === 0).map((m) => [m.roomId, m.studentId]).sort();
  assert.deepEqual(active, [[R1, A], [R2, B], [R2, C]].sort());
  const removed = db.tables.breakoutRoomMember.filter((m) => m.status === 1);
  assert.deepEqual(removed.map((m) => [m.roomId, m.studentId]), [[R1, B]]);
  assert.equal(new Date(removed[0].removedAt).toISOString(), clock.toISOString());
  // Re-confirming R1 without A empties it.
  await confirm([{ id: R1, name: "Room 1", studentIds: [] }]);
  assert.deepEqual(db.tables.breakoutRoomMember.filter((m) => m.status === 0 && m.roomId === R1), []);
});

test("membership: lock order is the session FOR KEY SHARE, then the membership lock EXCLUSIVE", async () => {
  await confirm();
  const sql = db.rawSql();
  const session = sql.findIndex((s) => s.includes('FROM "ClassSession"') && s.endsWith("FOR KEY SHARE"));
  const exclusive = sql.findIndex((s) => s === "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))");
  assert.ok(session >= 0 && exclusive > session, sql.join("\n"));
  const lock = db.calls.find((c) => c.tx === db.lastTx() && c.sql === "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))");
  assert.deepEqual(lock.values, [`breakout-group-members:${S1}`]);
});

// ---- Creation (ROOM_UNKNOWN only for the group routes) -------------------------------------

test("create: GROUP assignments through the existing service, one per confirmed room, members confirmed", async () => {
  const { result, r1, r2 } = await createAssignment();
  assert.ok(r1 && r2);
  const rows = db.tables.breakoutAssignment;
  assert.deepEqual(rows.map((r) => [r.targetRoomType, r.targetRoomId, r.targetRoomName, r.workMode, r.state]).sort(), [
    ["BREAKOUT", R1, "Room 1", "GROUP", "PUBLISHED"],
    ["BREAKOUT", R2, "Room 2", "GROUP", "PUBLISHED"],
  ]);
  assert.equal(new Set(rows.map((r) => r.publishGroupId)).size, 1);
  assert.equal(result.rooms.length, 2);
  assert.equal(db.tables.breakoutRoomMember.filter((m) => m.status === 0).length, 3);
});

test("create: the EXISTING create services still fail closed for BREAKOUT targets and default to INDIVIDUAL", async () => {
  await assert.rejects(
    teacherAssignments.createAssignments({ teacherId: "t1", sessionId: S1, title: "T", instructions: "I", targets: [{ type: "BREAKOUT", id: R1 }], publish: true, brief: null }),
    appError(409, "ROOM_UNKNOWN")
  );
  await assert.rejects(
    teacherQuizzes.createQuizzes({ teacherId: "t1", sessionId: S1, title: "T", questions: QUESTIONS(), targets: [{ type: "BREAKOUT", id: R1 }], publish: true }),
    appError(409, "ROOM_UNKNOWN")
  );
  await teacherAssignments.createAssignments({ teacherId: "t1", sessionId: S1, title: "T", instructions: "I", targets: [{ type: "MAIN" }], publish: true, brief: null });
  const created = db.calls.find((c) => c.model === "breakoutAssignment" && c.method === "create");
  assert.equal("workMode" in created.args.data, false, "an individual create writes no workMode (the column default applies)");
  assert.equal(db.tables.breakoutAssignment[0].workMode, "INDIVIDUAL");
});

// ---- Shared assignment ----------------------------------------------------------------

test("assignment: members see the same work; non-members, other rooms and other classes get 404", async () => {
  const { r1, r2 } = await createAssignment();
  const view = await work(A, r1);
  assert.deepEqual(view.group.members.map((m) => m.id).sort(), [A, B].sort());
  assert.equal(view.work.revision, 0);
  assert.equal(view.assignment.instructions, "Make a poster");
  await assert.rejects(work(C, r1), appError(404, "ASSIGNMENT_NOT_FOUND"), "a member of Room 2");
  await assert.rejects(work(X, r1), appError(404, "NOT_FOUND"), "not enrolled");
  await assert.rejects(groupAssignments.getGroupAssignmentForStudent({ studentId: Y, sessionId: S_OTHER, assignmentId: r1 }), appError(404, "NOT_FOUND"));
  assert.ok(await work(C, r2));
});

test("assignment: collaborative saves with revisions, latest editor, conflicts return the current work", async () => {
  const { r1 } = await createAssignment();
  const first = await save(A, r1, 0, "Intro by Amaya");
  assert.equal(first.work.revision, 1);
  assert.equal(first.work.lastEditedBy.id, A);
  const second = await save(B, r1, 1, "Intro by Amaya\nBody by Bimal");
  assert.equal(second.work.revision, 2);
  assert.equal(second.work.lastEditedBy.name, "Bimal");
  // A still has revision 1: conflict with B's text, nothing changed.
  await assert.rejects(save(A, r1, 1, "stale"), (error) => {
    appError(409, "REVISION_CONFLICT")(error);
    assert.equal(error.details.work.answerText, "Intro by Amaya\nBody by Bimal");
    assert.equal(error.details.work.revision, 2);
    return true;
  });
  assert.equal((await work(A, r1)).work.answerText, "Intro by Amaya\nBody by Bimal");
  const row = db.tables.breakoutGroupAssignmentWork[0];
  assert.equal(new Date(row.lastEditedAt).toISOString(), clock.toISOString());
  await assert.rejects(save(C, r1, 2, "intruder"), appError(404, "ASSIGNMENT_NOT_FOUND"));
  await assert.rejects(save(A, r1, -1, "x"), appError(400, "VALIDATION_ERROR"));
});

test("assignment: save lock order: session, membership SHARED, assignment FOR KEY SHARE, group lock", async () => {
  const { r1 } = await createAssignment();
  await save(A, r1, 0, "x");
  const sql = db.rawSql();
  const at = (pred) => sql.findIndex(pred);
  const session = at((s) => s.includes('FROM "ClassSession"'));
  const shared = at((s) => s.includes("pg_advisory_xact_lock_shared"));
  const activity = at((s) => s.includes('FROM "BreakoutAssignment"') && s.endsWith("FOR KEY SHARE"));
  const group = sql.findIndex((s, i) => i > activity && s === "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))");
  assert.ok(session >= 0 && shared > session && activity > shared && group > activity, sql.join("\n"));
  assert.equal(sql[0], "SET LOCAL lock_timeout = '3000ms'", "every lock wait bounded");
});

test("assignment: one final submission by any member: submitter, time, member snapshot; repeats replay", async () => {
  const { r1 } = await createAssignment();
  await save(A, r1, 0, "Our answer");
  clock = new Date(clock.getTime() + 5_000);
  const done = await submit(B, r1, 1);
  assert.equal(done.replayed, false);
  assert.equal(done.work.submission.submittedBy.id, B);
  assert.equal(done.work.submission.submittedAt, clock.toISOString());
  assert.deepEqual(done.work.submission.members.map((m) => m.id).sort(), [A, B].sort());
  const row = db.tables.breakoutGroupAssignmentWork[0];
  assert.deepEqual(row.memberStudentIds, [A, B].sort());
  // Duplicate submits (another member, any revision, a file): the stored one, nothing written.
  const writesBefore = db.calls.filter((c) => c.model === "breakoutGroupAssignmentWork" && ["create", "update"].includes(c.method)).length;
  const again = await submit(A, r1, 0, { bytes: PDF(), fileName: "x.pdf", mimeType: "application/pdf" });
  assert.equal(again.replayed, true);
  assert.equal(again.work.submission.submittedBy.id, B);
  assert.equal(db.calls.filter((c) => c.model === "breakoutGroupAssignmentWork" && ["create", "update"].includes(c.method)).length, writesBefore);
  assert.equal(fs.existsSync(path.join(storageRoot, "breakout-activities")), false, "no file stored by the replay");
  // The work is final.
  await assert.rejects(save(A, r1, 1, "change"), appError(409, "GROUP_WORK_SUBMITTED"));
});

test("assignment: submit rules: empty, stale revision, closed, PDF only, invalid PDF", async () => {
  const { r1, r2 } = await createAssignment();
  await assert.rejects(submit(A, r1, 0), appError(400, "SUBMISSION_EMPTY"));
  await save(A, r1, 0, "text");
  await assert.rejects(submit(A, r1, 0), appError(409, "REVISION_CONFLICT"));
  await assert.rejects(submit(A, r1, 1, { bytes: new Uint8Array(Buffer.from("not a pdf")), fileName: "a.pdf", mimeType: "application/pdf" }), appError(400, "INVALID_PDF"));
  assert.equal(db.tables.breakoutGroupAssignmentWork[0].submittedAt, null);
  // PDF only, by the other group (no saved text).
  const pdfOnly = await submit(C, r2, 0, { bytes: PDF(), fileName: "Our work.pdf", mimeType: "application/pdf" });
  assert.equal(pdfOnly.work.submission.file.fileName, "Our work.pdf");
  const file = await groupAssignments.getGroupSubmissionFileForStudent({ studentId: C, sessionId: S1, assignmentId: r2 }, { storageRoot });
  assert.equal(Buffer.from(file.bytes).toString("latin1").startsWith("%PDF"), true);
  await assert.rejects(groupAssignments.getGroupSubmissionFileForStudent({ studentId: A, sessionId: S1, assignmentId: r2 }, { storageRoot }), appError(404, "ASSIGNMENT_NOT_FOUND"));
  const teacherFile = await groupAssignments.getGroupSubmissionFileForTeacher({ teacherId: "t1", sessionId: S1, assignmentId: r2 }, { storageRoot });
  assert.equal(teacherFile.displayName, "Our work.pdf");
  // Closed (existing teacher close): saving and submitting refused.
  await teacherAssignments.setAssignmentState({ teacherId: "t1", sessionId: S1, assignmentId: r1, action: "close" });
  await assert.rejects(save(A, r1, 1, "late"), appError(409, "ASSIGNMENT_CLOSED"));
  await assert.rejects(submit(A, r1, 1), appError(409, "ASSIGNMENT_CLOSED"));
});

test("assignment: a removed member loses access at once; their earlier edit stays attributed", async () => {
  const { r1 } = await createAssignment();
  await save(B, r1, 0, "Bimal's part");
  await confirm([{ id: R1, name: "Room 1", studentIds: [A] }]);
  await assert.rejects(work(B, r1), appError(404, "NOT_FOUND"));
  await assert.rejects(save(B, r1, 1, "more"), appError(404, "NOT_FOUND"));
  const view = await work(A, r1);
  assert.equal(view.work.lastEditedBy.id, B);
  assert.deepEqual(view.group.members.map((m) => m.id), [A]);
});

test("assignment: the teacher sees the room's members, the work and the submission", async () => {
  const { r1 } = await createAssignment();
  await save(A, r1, 0, "Answer");
  await submit(A, r1, 1);
  const view = await groupAssignments.getGroupAssignmentForTeacher({ teacherId: "t1", sessionId: S1, assignmentId: r1 });
  assert.equal(view.work.answerText, "Answer");
  assert.equal(view.work.submission.submittedBy.id, A);
  assert.deepEqual(view.members.map((m) => m.id).sort(), [A, B].sort());
  await assert.rejects(groupAssignments.getGroupAssignmentForTeacher({ teacherId: "t2", sessionId: S1, assignmentId: r1 }), appError(404, "SESSION_NOT_FOUND"));
});

// ---- Shared quiz ------------------------------------------------------------------------

const qGet = (studentId, quizId) => groupQuizzes.getGroupQuizForStudent({ studentId, sessionId: S1, quizId });
const qStart = (studentId, quizId) => groupQuizzes.startGroupQuiz({ studentId, sessionId: S1, quizId });
const qSave = (studentId, quizId, answers) => groupQuizzes.saveGroupQuizAnswers({ studentId, sessionId: S1, quizId, answers });
const qSubmit = (studentId, quizId, revision) => groupQuizzes.submitGroupQuiz({ studentId, sessionId: S1, quizId, revision });

// The existing stored answer shape.
const single = (optionId) => ({ kind: "single", optionId });
const tf = (value) => ({ kind: "true_false", value });
const short = (text) => ({ kind: "short", text });

function questionIds(quizId) {
  const quiz = db.tables.breakoutQuiz.find((q) => q.id === quizId);
  return quiz.questions.questions;
}

test("quiz: before the start, metadata only; any member starts ONE attempt with one deadline", async () => {
  const { r1 } = await createQuiz();
  const before = await qGet(A, r1);
  assert.equal(before.attempt.attemptStatus, null);
  assert.equal(before.quiz.questions, undefined, "no questions before the group starts");
  const started = await qStart(A, r1);
  assert.equal(started.started, true);
  assert.equal(started.quiz.questions.length, 3);
  assert.equal(JSON.stringify(started.quiz).includes("correct"), false, "no answer keys for students");
  const again = await qStart(B, r1);
  assert.equal(again.started, false);
  assert.equal(db.tables.breakoutGroupQuizAttempt.length, 1);
  const attempt = db.tables.breakoutGroupQuizAttempt[0];
  assert.equal(attempt.startedByStudentId, A);
  assert.equal(new Date(attempt.deadlineAt).getTime(), clock.getTime() + 600_000);
  await assert.rejects(qStart(C, r1), appError(404, "QUIZ_NOT_FOUND"));
});

test("quiz: members answer different questions at the same time; answers merge per question", async () => {
  const { r1 } = await createQuiz();
  await qStart(A, r1);
  const [q1, q2, q3] = questionIds(r1);
  await qSave(A, r1, { [q1.id]: single(q1.correctOptionId) });
  const afterB = await qSave(B, r1, { [q2.id]: tf(true) });
  assert.deepEqual(afterB.attempt.answers[q1.id], single(q1.correctOptionId), "A's answer kept");
  assert.deepEqual(afterB.attempt.answers[q2.id], tf(true));
  assert.equal(afterB.progress.answered, 2);
  assert.equal(afterB.activity.lastSavedBy.id, B);
  const view = await qGet(A, r1);
  assert.deepEqual(view.attempt.answers[q2.id], tf(true), "A sees B's answer");
  await assert.rejects(qSave(A, r1, { nope: true }), appError(400, "VALIDATION_ERROR"));
  await assert.rejects(qSave(A, r1, { [q3.id]: 42 }), appError(400, "VALIDATION_ERROR"));
});

test("quiz: one final submission graded with the existing marking; stale revision refused; repeats replay", async () => {
  const { r1 } = await createQuiz();
  await qStart(A, r1);
  const [q1, q2, q3] = questionIds(r1);
  await qSave(A, r1, { [q1.id]: single(q1.correctOptionId), [q2.id]: tf(false), [q3.id]: short("  colombo ") });
  await assert.rejects(qSubmit(B, r1, 0), appError(409, "REVISION_CONFLICT"));
  const done = await qSubmit(B, r1, 1);
  assert.equal(done.replayed, false);
  assert.equal(done.attempt.attemptStatus, "SUBMITTED");
  assert.equal(done.attempt.finalScore, 3, "2 + 0 + 1 (short answer normalized)");
  assert.equal(done.attempt.review, undefined, "no review before the quiz is closed");
  const row = db.tables.breakoutGroupQuizAttempt[0];
  assert.equal(row.submittedByStudentId, B);
  assert.deepEqual(row.memberStudentIds, [A, B].sort());
  const again = await qSubmit(A, r1, 0);
  assert.equal(again.replayed, true);
  assert.equal(again.attempt.finalScore, 3);
  await assert.rejects(qSave(A, r1, { [q2.id]: tf(true) }), appError(409, "QUIZ_ALREADY_SUBMITTED"));
});

test("quiz: past the deadline (+5 s) a save auto-submits the saved answers and answers QUIZ_TIME_UP", async () => {
  const { r1 } = await createQuiz();
  await qStart(A, r1);
  const [q1] = questionIds(r1);
  await qSave(A, r1, { [q1.id]: single(q1.correctOptionId) });
  clock = new Date(clock.getTime() + 600_000 + 5_000);
  await qSave(B, r1, { [q1.id]: single(q1.correctOptionId) }); // exactly +5 s: still allowed
  clock = new Date(clock.getTime() + 1);
  await assert.rejects(qSave(B, r1, { [q1.id]: single(null) }), appError(409, "QUIZ_TIME_UP"));
  const row = db.tables.breakoutGroupQuizAttempt[0];
  assert.equal(row.attemptStatus, "AUTO_SUBMITTED", "the auto-submit was committed");
  assert.equal(row.submittedByStudentId, null);
  assert.deepEqual(row.answers[q1.id], single(q1.correctOptionId), "the SAVED answers");
});

test("quiz: a closed quiz's in-progress attempt is auto-submitted lazily by a member's read", async () => {
  const { r1 } = await createQuiz({ timeLimitSeconds: null });
  await qStart(A, r1);
  await teacherQuizzes.setQuizState({ teacherId: "t1", sessionId: S1, quizId: r1, action: "close" });
  assert.equal(db.tables.breakoutGroupQuizAttempt[0].attemptStatus, "IN_PROGRESS", "the existing close does not touch group attempts");
  const view = await qGet(B, r1);
  assert.equal(view.attempt.attemptStatus, "AUTO_SUBMITTED");
  assert.ok(Array.isArray(view.attempt.review), "closed: the review");
});

test("quiz: the teacher view and grading override reuse the existing marking", async () => {
  const { r1 } = await createQuiz();
  await qStart(A, r1);
  const [q1, q2] = questionIds(r1);
  await assert.rejects(
    groupQuizzes.overrideGroupQuizGrading({ teacherId: "t1", sessionId: S1, quizId: r1, overrides: [{ questionId: q1.id, marks: 1 }] }),
    appError(409, "QUIZ_NOT_SUBMITTED")
  );
  await qSave(A, r1, { [q2.id]: tf(true) });
  await qSubmit(A, r1, 1);
  const before = await groupQuizzes.getGroupQuizForTeacher({ teacherId: "t1", sessionId: S1, quizId: r1 });
  assert.equal(before.attempt.finalScore, 1);
  assert.ok(before.quiz.questions, "the teacher gets the definition with answer keys");
  const updated = await groupQuizzes.overrideGroupQuizGrading({ teacherId: "t1", sessionId: S1, quizId: r1, overrides: [{ questionId: q1.id, marks: 1.5 }] });
  assert.equal(updated.finalScore, 2.5);
  assert.equal(updated.autoScore, 1, "autoScore unchanged");
  await assert.rejects(
    groupQuizzes.overrideGroupQuizGrading({ teacherId: "t1", sessionId: S1, quizId: r1, overrides: [{ questionId: q1.id, marks: 9 }] }),
    appError(400, "OVERRIDE_OUT_OF_RANGE")
  );
});

// ---- Progress and notifications -----------------------------------------------------------

test("progress: the teacher sees every room, its members, and per activity the progress and submission", async () => {
  const { r1 } = await createAssignment();
  const quiz = await createQuiz();
  await save(A, r1, 0, "Working");
  await qStart(C, quiz.r2);
  const view = await overview.getGroupOverviewForTeacher({ teacherId: "t1", sessionId: S1 });
  const room1 = view.rooms.find((r) => r.id === R1);
  const room2 = view.rooms.find((r) => r.id === R2);
  assert.deepEqual(room1.members.map((m) => m.id).sort(), [A, B].sort());
  assert.equal(room1.assignments[0].progress.lastEditedBy.id, A);
  assert.equal(room1.assignments[0].progress.submitted, null);
  assert.equal(room2.quizzes[0].progress.attemptStatus, "IN_PROGRESS");
  assert.equal(room2.quizzes[0].progress.questions, 3);
});

test("progress: a student sees only their own group's published activities; no group = group null", async () => {
  await createAssignment();
  await createQuiz({ publish: false });
  const mine = await overview.getMyGroupOverview({ studentId: A, sessionId: S1 });
  assert.equal(mine.group.room.id, R1);
  assert.equal(mine.assignments.length, 1);
  assert.equal(mine.quizzes.length, 0, "a draft quiz is not shown");
  db.tables.classStudent.push({ studentId: X, classId: "c1", isActive: true });
  const none = await overview.getMyGroupOverview({ studentId: X, sessionId: S1 });
  assert.deepEqual(none, { group: null, assignments: [], quizzes: [] });
  await assert.rejects(overview.getMyGroupOverview({ studentId: Y, sessionId: S1 }), appError(404, "NOT_FOUND"));
});

test("notifications: saves and submissions notify the group's members (ids only), never other students", async () => {
  const { r1 } = await createAssignment();
  emitted.length = 0;
  await save(A, r1, 0, "x");
  assert.equal(emitted.length, 1);
  const payload = emitted[0];
  assert.deepEqual(payload.memberStudentIds.sort(), [A, B].sort());
  assert.equal(payload.kind, "assignment");
  assert.equal(payload.activityId, r1);
  assert.equal(events.groupChangeVisibleTo(payload, { role: "student", studentId: C }), false);
  assert.equal(events.groupChangeVisibleTo(payload, { role: "student", studentId: B }), true);
  assert.equal(events.groupChangeVisibleTo(payload, { role: "teacher" }), true);
  const sent = events.groupChangeForClient(payload);
  assert.deepEqual(Object.keys(sent).sort(), ["activityId", "kind", "occurredAt", "revision", "roomId"]);
  assert.equal(JSON.stringify(sent).includes("x"), false, "no content");
  // A failed write notifies nobody.
  emitted.length = 0;
  await assert.rejects(save(A, r1, 0, "stale"));
  assert.equal(emitted.length, 0);
});

// ---- Isolation from the existing individual services ------------------------------------

test("isolation: the individual student services never show or accept GROUP activities", async () => {
  const { r1 } = await createAssignment();
  const quiz = await createQuiz();
  // Even with a resolver that places A in Room 1, the GROUP rows are invisible to the individual services.
  const roomResolver = { resolveStudentRoom: async () => ({ type: "BREAKOUT", id: R1 }) };
  const list = await studentAssignments.listAssignmentsForStudent({ studentId: A, sessionId: S1 }, { roomResolver });
  assert.deepEqual(list.assignments, []);
  await assert.rejects(studentAssignments.getDraftForStudent({ studentId: A, sessionId: S1, assignmentId: r1 }, { roomResolver }), appError(404, "ASSIGNMENT_NOT_FOUND"));
  await assert.rejects(
    studentAssignments.saveDraftForStudent({ studentId: A, sessionId: S1, assignmentId: r1, revision: 0, answerText: "x" }, { roomResolver }),
    appError(404, "ASSIGNMENT_NOT_FOUND")
  );
  await assert.rejects(
    studentAssignments.submitAssignmentForStudent({ studentId: A, sessionId: S1, assignmentId: r1, answerText: "x", file: null, idempotencyKey: "key-12345678" }, { roomResolver }),
    appError(404, "ASSIGNMENT_NOT_FOUND")
  );
  const quizzes = await studentQuizzes.listQuizzesForStudent({ studentId: A, sessionId: S1 }, { roomResolver });
  assert.deepEqual(quizzes.quizzes, []);
  await assert.rejects(studentQuizzes.getQuizForStudent({ studentId: A, sessionId: S1, quizId: quiz.r1 }, { roomResolver }), appError(404, "QUIZ_NOT_FOUND"));
  await assert.rejects(studentQuizzes.startQuizAttempt({ studentId: A, sessionId: S1, quizId: quiz.r1 }, { roomResolver }), appError(404, "QUIZ_NOT_FOUND"));
  await assert.rejects(studentQuizzes.saveQuizAnswers({ studentId: A, sessionId: S1, quizId: quiz.r1, revision: 0, answers: {} }, { roomResolver }), appError(404, "QUIZ_NOT_FOUND"));
  await assert.rejects(studentQuizzes.submitQuizAttempt({ studentId: A, sessionId: S1, quizId: quiz.r1, revision: 0 }, { roomResolver }), appError(404, "QUIZ_NOT_FOUND"));
  assert.equal(db.tables.breakoutAssignmentDraft.length + db.tables.breakoutAssignmentSubmission.length + db.tables.breakoutQuizSubmission.length, 0);
});

test("isolation: group work never appears in the existing individual teacher lists", async () => {
  const { r1 } = await createAssignment();
  const quiz = await createQuiz();
  await save(A, r1, 0, "x");
  await submit(A, r1, 1);
  await qStart(A, quiz.r1);
  const subs = await teacherAssignments.listAssignmentSubmissionsForTeacher({ teacherId: "t1", sessionId: S1, assignmentId: r1 });
  assert.deepEqual(subs.submissions ?? subs.students ?? [], []);
  const attempts = await teacherQuizzes.listQuizAttemptsForTeacher({ teacherId: "t1", sessionId: S1, quizId: quiz.r1 });
  assert.deepEqual(attempts.attempts, []);
});

test("isolation: the existing teacher activity list (GET /breakout-activities) returns INDIVIDUAL activities only, unchanged", async () => {
  await teacherAssignments.createAssignments({ teacherId: "t1", sessionId: S1, title: "Solo", instructions: "Alone", targets: [{ type: "MAIN" }], publish: true, brief: null });
  await teacherQuizzes.createQuizzes({ teacherId: "t1", sessionId: S1, title: "Solo quiz", questions: QUESTIONS(), targets: [{ type: "MAIN" }], publish: true });
  const before = {
    assignments: (await teacherAssignments.listAssignmentsForTeacher("t1", S1)).assignments,
    quizzes: (await teacherQuizzes.listQuizzesForTeacher("t1", S1)).quizzes,
  };
  assert.deepEqual(before.assignments.map((a) => a.title), ["Solo"]);
  assert.deepEqual(before.quizzes.map((q) => q.title), ["Solo quiz"]);

  const { r1 } = await createAssignment();
  const quiz = await createQuiz();
  await save(A, r1, 0, "group text");
  await qStart(A, quiz.r1);
  assert.equal(db.tables.breakoutAssignment.length, 3, "the GROUP assignment rows exist");
  assert.equal(db.tables.breakoutQuiz.length, 3, "the GROUP quiz rows exist");

  // Same individual items, same fields and counts: the GROUP rows are simply not in this list.
  const after = {
    assignments: (await teacherAssignments.listAssignmentsForTeacher("t1", S1)).assignments,
    quizzes: (await teacherQuizzes.listQuizzesForTeacher("t1", S1)).quizzes,
  };
  assert.deepEqual(after, before);
  // GROUP activities stay visible to the teacher through the Group Activities overview.
  const groups = await overview.getGroupOverviewForTeacher({ teacherId: "t1", sessionId: S1 });
  assert.ok(JSON.stringify(groups).includes(r1));
});
