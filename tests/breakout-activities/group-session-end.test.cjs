/*
 * Group Activities at End Session (services/breakout-group-session-end.ts,
 * services/session-service.ts endClassSessionForTeacher, the End Session
 * route): the teacher keeps or deletes the session's GROUP activities.
 *
 * Checked: no GROUP activities = End Session unchanged; a decision is
 * required otherwise (also with the feature flag off); Preserve changes
 * nothing; Delete removes ONLY this session's GROUP rows, memberships and
 * files (INDIVIDUAL rows and files, and other sessions, byte-identical),
 * every query filtered by classSessionId + workMode GROUP + status; the
 * session lock comes first; files before rows; failures stay retryable;
 * duplicates never delete more. The in-memory fake database is used; no
 * database is contacted.
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
let teacherSession = { teacherId: "t1" };
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
// session-service's other dependencies: not used by End Session without a lecture.
fake("lib/mailer.ts", { buildLiveSessionInviteLoginLink: () => "", sendLiveSessionInviteEmail: async () => {} });
fake("lib/session-invite.ts", { signSessionInviteToken: () => "" });
fake("lib/jitsi-auth.ts", { generateJitsiToken: () => "" });
fake("lib/youtube-feature-lifecycle.ts", {
  endYouTubeFeaturesForLecture: async () => ({ status: "none", closed: 0 }),
  reconcileYouTubeFeaturesForNewSession: async () => ({ status: "none", closed: 0 }),
});
fake("lib/auth-session.ts", { requireTeacherSession: async () => teacherSession });

const groupAssignments = require(path.join(root, "services/breakout-group-assignment-service.ts"));
const groupQuizzes = require(path.join(root, "services/breakout-group-quiz-service.ts"));
const overview = require(path.join(root, "services/breakout-group-overview-service.ts"));
const teacherAssignments = require(path.join(root, "services/breakout-assignment-service.ts"));
const teacherQuizzes = require(path.join(root, "services/breakout-quiz-service.ts"));
const studentAssignments = require(path.join(root, "services/breakout-student-assignment-service.ts"));
const studentQuizzes = require(path.join(root, "services/breakout-student-quiz-service.ts"));
const sessionEnd = require(path.join(root, "services/breakout-group-session-end.ts"));
const sessionService = require(path.join(root, "services/session-service.ts"));
const storage = require(path.join(root, "lib/breakout-activities/storage.ts"));
const endRoute = require(path.join(root, "app/api/sessions/[id]/end/route.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21"; // active, class c1 (teacher t1): the session ended in these tests
const S2 = "7a556fd1-2d15-47ce-9ee4-93bdab492c32"; // active, class c1 (teacher t1): another session, never touched
const A = "a1111111-1111-4111-8111-111111111111";
const B = "a2222222-2222-4222-8222-222222222222";
const C = "a3333333-3333-4333-8333-333333333333";
const R1 = "f0f0f0f0-0000-4000-8000-00000000a001";
const R2 = "f0f0f0f0-0000-4000-8000-00000000a002";

let tmp;
let storageRoot;
let previousCwd;

const appError = (status, code) => (error) => {
  assert.ok(error instanceof AppError, `expected AppError, got ${error && error.stack}`);
  assert.equal(error.statusCode ?? error.status, status, `status of ${error.code}`);
  assert.equal(error.code, code);
  return true;
};

const PDF = (label = "x") => new Uint8Array(Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n`));
const brief = (label) => {
  const bytes = PDF(label);
  return { bytes, displayName: `${label}.pdf`, sizeBytes: bytes.byteLength };
};
const upload = (label) => ({ bytes: PDF(label), fileName: `${label}.pdf`, mimeType: "application/pdf" });

test.beforeEach(() => {
  clock = new Date("2026-11-06T09:00:00.000Z");
  teacherSession = { teacherId: "t1" };
  db = createFakeGroupDb();
  // End Session uses the default storage root (<cwd>/storage): run in a temporary folder.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "breakout-group-end-"));
  storageRoot = path.join(tmp, "storage");
  previousCwd = process.cwd();
  process.chdir(tmp);
  db.tables.class.push({ id: "c1", teacherId: "t1" }, { id: "c2", teacherId: "t2" });
  db.tables.classSession.push(
    { id: S1, classId: "c1", lectureId: null, isActive: true, endedAt: null },
    { id: S2, classId: "c1", lectureId: null, isActive: true, endedAt: null }
  );
  for (const [id, name] of [[A, "Amaya"], [B, "Bimal"], [C, "Chathu"]]) db.tables.student.push({ id, name, status: 0, registrationNumber: null });
  for (const id of [A, B, C]) db.tables.classStudent.push({ studentId: id, classId: "c1", isActive: true });
  delete process.env.BREAKOUT_ACTIVITIES_ENABLED;
});

test.afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ROOMS = () => [
  { id: R1, name: "Room 1", studentIds: [A, B] },
  { id: R2, name: "Room 2", studentIds: [C] },
];
const QUESTIONS = () => [
  { kind: "single", prompt: "2 + 2?", marks: 2, options: [{ text: "4", correct: true }, { text: "5", correct: false }] },
  { kind: "true_false", prompt: "The sky is blue.", marks: 1, correct: true },
];
const MAIN = { roomResolver: { resolveStudentRoom: async () => ({ type: "MAIN" }) } };

/** INDIVIDUAL work of a session: an assignment with a brief and a PDF submission, a quiz with an attempt. */
async function individualWork(sessionId = S1) {
  const { assignments } = await teacherAssignments.createAssignments(
    { teacherId: "t1", sessionId, title: "Solo", instructions: "Alone", targets: [{ type: "MAIN" }], publish: true, brief: brief("solo-brief") },
    { storageRoot }
  );
  const assignmentId = assignments[0].id;
  await studentAssignments.submitAssignmentForStudent(
    { studentId: A, sessionId, assignmentId, answerText: "mine", file: upload("solo-submission"), idempotencyKey: "key-12345678" },
    { ...MAIN, storageRoot }
  );
  const { quizzes } = await teacherQuizzes.createQuizzes({ teacherId: "t1", sessionId, title: "Solo quiz", questions: QUESTIONS(), targets: [{ type: "MAIN" }], publish: true });
  await studentQuizzes.startQuizAttempt({ studentId: A, sessionId, quizId: quizzes[0].id }, MAIN);
  return { assignmentId, quizId: quizzes[0].id };
}

/** GROUP work of a session: assignments (shared brief) with one PDF submission, quizzes with one attempt. */
async function groupWork(sessionId = S1) {
  const created = await groupAssignments.createGroupAssignments(
    { teacherId: "t1", sessionId, title: "Poster", instructions: "Together", rooms: ROOMS(), publish: true, brief: brief("group-brief") },
    { storageRoot }
  );
  const r1 = created.assignments.find((a) => a.target.id === R1).id;
  await groupAssignments.saveGroupAssignmentWork({ studentId: A, sessionId, assignmentId: r1, revision: 0, answerText: "ours" });
  await groupAssignments.submitGroupAssignment({ studentId: A, sessionId, assignmentId: r1, revision: 1, file: upload("group-submission") }, { storageRoot });
  const quizzes = await groupQuizzes.createGroupQuizzes({ teacherId: "t1", sessionId, title: "Group quiz", questions: QUESTIONS(), rooms: ROOMS(), publish: true });
  const q1 = quizzes.quizzes.find((q) => q.target.id === R1).id;
  await groupQuizzes.startGroupQuiz({ studentId: A, sessionId, quizId: q1 });
  return { publishGroupId: created.publishGroupId, r1, q1 };
}

/** Every stored file below the storage root: relative path -> bytes (hex). */
function filesOnDisk() {
  const out = {};
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(storageRoot, full).split(path.sep).join("/")] = fs.readFileSync(full).toString("hex");
    }
  };
  walk(storageRoot);
  return out;
}

const INDIVIDUAL_TABLES = ["breakoutAssignmentDraft", "breakoutAssignmentSubmission", "breakoutQuizSubmission"];
const snapshot = (rows) => JSON.parse(JSON.stringify(rows));
const individualRows = () => ({
  assignments: snapshot(db.tables.breakoutAssignment.filter((r) => r.workMode !== "GROUP")),
  quizzes: snapshot(db.tables.breakoutQuiz.filter((r) => r.workMode !== "GROUP")),
  ...Object.fromEntries(INDIVIDUAL_TABLES.map((t) => [t, snapshot(db.tables[t])])),
});
const sessionRows = (sessionId) => ({
  assignments: snapshot(db.tables.breakoutAssignment.filter((r) => r.classSessionId === sessionId)),
  quizzes: snapshot(db.tables.breakoutQuiz.filter((r) => r.classSessionId === sessionId)),
  members: snapshot(db.tables.breakoutRoomMember.filter((r) => r.classSessionId === sessionId)),
  works: snapshot(db.tables.breakoutGroupAssignmentWork.filter((r) => r.classSessionId === sessionId)),
  attempts: snapshot(db.tables.breakoutGroupQuizAttempt.filter((r) => r.classSessionId === sessionId)),
});
const filesOf = (files, sessionId) => Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(`breakout-activities/${sessionId}/`)));

const end = (decision, teacherId = "t1", sessionId = S1) =>
  sessionService.endClassSessionForTeacher(teacherId, sessionId, decision ? { groupActivities: decision } : undefined);
const sessionOf = (id) => db.tables.classSession.find((s) => s.id === id);
const breakoutWritesSince = (mark) =>
  db.calls.slice(mark).filter((c) => c.kind === "model" && /^breakout/.test(c.model) && ["update", "updateMany", "deleteMany", "create", "createMany"].includes(c.method));

// ---- No GROUP activities: unchanged ----------------------------------------------------

test("no GROUP activities: End Session runs as before (same response shape, no lock, no breakout write)", async () => {
  await individualWork();
  const before = individualRows();
  const files = filesOnDisk();
  const mark = db.calls.length;
  const result = await end();
  assert.deepEqual(Object.keys(result).sort(), ["alreadyEnded", "endedAt", "sessionId", "youtubeCleanup"]);
  assert.equal(result.alreadyEnded, false);
  assert.equal(sessionOf(S1).isActive, false);
  assert.deepEqual(individualRows(), before);
  assert.deepEqual(filesOnDisk(), files);
  assert.deepEqual(breakoutWritesSince(mark), []);
  assert.equal(db.calls.slice(mark).some((c) => c.kind === "raw" && /FOR UPDATE/.test(c.sql)), false, "the existing End Session takes no lock");
});

test("confirmed groups without any GROUP activity: no decision needed, memberships kept", async () => {
  const groupMembers = require(path.join(root, "services/breakout-group-membership-service.ts"));
  await groupMembers.confirmGroupMembers({ teacherId: "t1", sessionId: S1, rooms: ROOMS() });
  const result = await end();
  assert.equal(result.alreadyEnded, false);
  assert.equal("groupActivities" in result, false);
  assert.equal(db.tables.breakoutRoomMember.filter((m) => m.status === 0).length, 3);
});

// ---- A decision is required ------------------------------------------------------------

test("GROUP activities without a decision: 409 with the summary, nothing changed (also with the feature flag off)", async () => {
  await individualWork();
  await groupWork();
  const rows = sessionRows(S1);
  const files = filesOnDisk();
  const mark = db.calls.length;
  let caught;
  await assert.rejects(end(), (error) => {
    caught = error;
    return appError(409, "GROUP_ACTIVITIES_DECISION_REQUIRED")(error);
  });
  assert.deepEqual(caught.details.summary, { assignments: 2, quizzes: 2, rooms: 2, submittedAssignments: 1, submittedQuizzes: 0 });
  assert.equal(sessionOf(S1).isActive, true, "the session is still running");
  assert.deepEqual(sessionRows(S1), rows);
  assert.deepEqual(filesOnDisk(), files);
  assert.deepEqual(breakoutWritesSince(mark), []);
  assert.equal(db.tables.attendance.length, 0);
});

test("an ended session needs no decision (the existing already-ended answer)", async () => {
  await groupWork();
  await end("preserve");
  const again = await end();
  assert.equal(again.alreadyEnded, true);
  assert.equal("groupActivities" in again, false);
});

// ---- Preserve ---------------------------------------------------------------------------

test("preserve: the session ends; every GROUP and INDIVIDUAL row and file is untouched", async () => {
  await individualWork();
  await groupWork();
  const rows = sessionRows(S1);
  const individual = individualRows();
  const files = filesOnDisk();
  const mark = db.calls.length;
  const result = await end("preserve");
  assert.equal(result.alreadyEnded, false);
  assert.deepEqual(result.groupActivities, { decision: "preserve", cleanup: { status: "none", assignments: 0, quizzes: 0 } });
  assert.equal(sessionOf(S1).isActive, false);
  assert.deepEqual(sessionRows(S1), rows);
  assert.deepEqual(individualRows(), individual);
  assert.deepEqual(filesOnDisk(), files);
  assert.deepEqual(breakoutWritesSince(mark), []);
});

// ---- Delete -----------------------------------------------------------------------------

test("delete: only this session's GROUP rows, memberships and files go; INDIVIDUAL work and other sessions are untouched", async () => {
  await individualWork(S1);
  const group = await groupWork(S1);
  await individualWork(S2);
  await groupWork(S2);
  const individual = individualRows();
  const otherSession = sessionRows(S2);
  const filesBefore = filesOnDisk();
  const s1GroupFiles = Object.keys(filesOf(filesBefore, S1)).filter((p) => p.includes(group.publishGroupId) || p.includes(group.r1));
  assert.equal(s1GroupFiles.length, 2, "the group brief and the group submission PDF");

  const result = await end("delete");
  assert.equal(result.alreadyEnded, false);
  assert.deepEqual(result.groupActivities, { decision: "delete", cleanup: { status: "done", assignments: 2, quizzes: 2 } });
  assert.equal(sessionOf(S1).isActive, false);

  const after = sessionRows(S1);
  assert.equal(after.assignments.filter((r) => r.workMode === "GROUP").length, 0);
  assert.equal(after.quizzes.filter((r) => r.workMode === "GROUP").length, 0);
  assert.deepEqual([after.members, after.works, after.attempts], [[], [], []]);

  assert.deepEqual(individualRows(), individual, "INDIVIDUAL rows of every session unchanged");
  assert.deepEqual(sessionRows(S2), otherSession, "the other session unchanged");
  const filesAfter = filesOnDisk();
  const expected = { ...filesBefore };
  for (const p of s1GroupFiles) delete expected[p];
  assert.deepEqual(filesAfter, expected, "exactly the session's GROUP files are gone; every other file byte-identical");
});

test("delete: every write to the activity tables is filtered by classSessionId + workMode GROUP + status", async () => {
  await individualWork();
  await groupWork();
  const mark = db.calls.length;
  await end("delete");
  const writes = db.calls.slice(mark).filter((c) => c.kind === "model" && (c.model === "breakoutAssignment" || c.model === "breakoutQuiz") && ["update", "updateMany", "delete", "deleteMany"].includes(c.method));
  assert.equal(writes.length, 4, "mark (2) and hard delete (2)");
  for (const call of writes) {
    assert.equal(call.args.where.classSessionId, S1);
    assert.equal(call.args.where.workMode, "GROUP");
    assert.ok(call.args.where.status !== undefined, "a status filter");
    if (call.method === "updateMany") assert.deepEqual(call.args.where.status, { in: [0, 1] });
    if (call.method === "deleteMany") {
      assert.equal(call.args.where.status, 2);
      assert.ok(Array.isArray(call.args.where.id.in));
    }
  }
  const members = db.calls.slice(mark).filter((c) => c.model === "breakoutRoomMember" && c.method === "deleteMany");
  assert.deepEqual(members.map((c) => c.args.where), [{ classSessionId: S1 }]);
  // The individual tables are never written.
  assert.deepEqual(db.calls.slice(mark).filter((c) => c.kind === "model" && INDIVIDUAL_TABLES.includes(c.model) && c.method !== "findMany"), []);
});

test("delete: the session row lock (FOR UPDATE) comes first; later student writes see the session ended", async () => {
  const group = await groupWork();
  const mark = db.calls.length;
  await end("delete");
  const markTx = db.calls.slice(mark).find((c) => c.kind === "raw" && /FROM "ClassSession".*FOR UPDATE/.test(c.sql)).tx;
  const inTx = db.calls.filter((c) => c.tx === markTx);
  const lockAt = inTx.findIndex((c) => c.kind === "raw" && /FOR UPDATE/.test(c.sql));
  const firstWrite = inTx.findIndex((c) => c.kind === "model" && ["update", "updateMany", "deleteMany"].includes(c.method));
  assert.ok(lockAt >= 0 && lockAt < firstWrite, "lock before any write");
  assert.match(inTx[0].sql, /lock_timeout/, "bounded lock wait (BREAKOUT_BUSY on timeout)");
  await assert.rejects(groupAssignments.saveGroupAssignmentWork({ studentId: B, sessionId: S1, assignmentId: group.r1, revision: 1, answerText: "late" }), appError(404, "NOT_FOUND"));
});

test("delete: a failure in the ending transaction changes nothing (session still active, nothing marked or removed)", async () => {
  await groupWork();
  const rows = sessionRows(S1);
  const files = filesOnDisk();
  db.failOn("breakoutQuiz.updateMany");
  await assert.rejects(end("delete"));
  assert.equal(sessionOf(S1).isActive, true);
  assert.deepEqual(sessionRows(S1), rows);
  assert.deepEqual(filesOnDisk(), files);
});

test("delete: a failed folder removal keeps the rows marked (hidden, pending); the retry finishes", async () => {
  // End with delete (step 1), then a purge whose folder removal fails.
  const g2 = await groupWork(S2);
  await sessionEnd.endSessionAndMarkGroupActivitiesForPurge({ teacherId: "t1", sessionId: S2, endedAt: new Date(clock) });
  const failing = async () => ({ removed: false });
  const pending = await sessionEnd.purgeGroupActivities(S2, { storageRoot, removeActivityDir: failing });
  assert.deepEqual(pending, { status: "pending", assignments: 2, quizzes: 2 });
  const marked = db.tables.breakoutAssignment.filter((r) => r.classSessionId === S2 && r.workMode === "GROUP");
  assert.deepEqual(marked.map((r) => r.status), [2, 2], "kept, marked purge-pending");
  assert.equal(db.tables.breakoutGroupAssignmentWork.filter((w) => w.classSessionId === S2).length, 1, "work kept until its files are gone");
  assert.ok(Object.keys(filesOf(filesOnDisk(), S2)).some((p) => p.includes(g2.r1)), "files still there");
  // Hidden from every view in the meantime.
  const view = await overview.getGroupOverviewForTeacher({ teacherId: "t1", sessionId: S2 });
  assert.equal(JSON.stringify(view).includes(g2.r1), false);
  await assert.rejects(groupAssignments.getGroupAssignmentForTeacher({ teacherId: "t1", sessionId: S2, assignmentId: g2.r1 }), appError(404, "ASSIGNMENT_NOT_FOUND"));
  assert.deepEqual(await sessionEnd.sessionsWithPendingGroupPurge(), [S2]);

  const retried = await sessionEnd.purgeGroupActivities(S2, { storageRoot });
  assert.deepEqual(retried, { status: "done", assignments: 2, quizzes: 2 });
  assert.equal(db.tables.breakoutAssignment.filter((r) => r.classSessionId === S2 && r.workMode === "GROUP").length, 0);
  assert.deepEqual(filesOf(filesOnDisk(), S2), {});
  assert.deepEqual(await sessionEnd.sessionsWithPendingGroupPurge(), []);
});

test("delete: a failed row deletion after the files are gone stays pending and the retry finishes", async () => {
  await groupWork(S2);
  await sessionEnd.endSessionAndMarkGroupActivitiesForPurge({ teacherId: "t1", sessionId: S2, endedAt: new Date(clock) });
  db.failOn("breakoutQuiz.deleteMany");
  const pending = await sessionEnd.purgeGroupActivitiesSafely(S2, { storageRoot });
  assert.equal(pending.status, "pending");
  assert.deepEqual(db.tables.breakoutAssignment.filter((r) => r.classSessionId === S2).map((r) => r.status), [2, 2], "rolled back: still marked");
  assert.deepEqual((await sessionEnd.purgeGroupActivities(S2, { storageRoot })).status, "done");
  assert.equal(db.tables.breakoutQuiz.filter((r) => r.classSessionId === S2).length, 0);
});

test("delete: a stored path outside this session's folder is never touched and keeps the rows pending", async () => {
  await individualWork(S2);
  const group = await groupWork(S1);
  const otherFile = db.tables.breakoutAssignmentSubmission.find((r) => r.classSessionId === S2).filePath;
  // A tampered GROUP row pointing at another session's file.
  db.tables.breakoutAssignment.find((r) => r.id === group.r1).briefFilePath = otherFile;
  const files = filesOnDisk();
  const result = await end("delete");
  assert.equal(result.groupActivities.cleanup.status, "pending");
  assert.equal(filesOnDisk()[otherFile], files[otherFile], "the other session's file is intact");
  assert.ok(db.tables.breakoutAssignment.some((r) => r.id === group.r1 && r.status === 2), "rows kept for inspection");
});

test("delete: a folder still referenced by a retained activity is kept (shared brief)", async () => {
  const group = await groupWork(S1);
  await sessionEnd.endSessionAndMarkGroupActivitiesForPurge({ teacherId: "t1", sessionId: S1, endedAt: new Date(clock) });
  const sharedBrief = db.tables.breakoutAssignment.find((r) => r.id === group.r1).briefFilePath;
  // A retained (INDIVIDUAL) row that refers to the same brief file.
  db.tables.breakoutAssignment.push({ id: "b9999999-9999-4999-8999-999999999999", classSessionId: S1, workMode: "INDIVIDUAL", status: 0, publishGroupId: null, briefFilePath: sharedBrief });
  const result = await sessionEnd.purgeGroupActivities(S1, { storageRoot });
  assert.equal(result.status, "done");
  assert.ok(filesOnDisk()[sharedBrief], "the shared brief stays for the retained row");
  assert.equal(Object.keys(filesOnDisk()).some((p) => p.includes(group.r1)), false, "the group submission folder is gone");
});

test("purge never touches an active session", async () => {
  await groupWork(S1);
  for (const row of db.tables.breakoutAssignment) row.status = 2; // even if rows were marked
  const files = filesOnDisk();
  assert.deepEqual(await sessionEnd.purgeGroupActivities(S1, { storageRoot }), { status: "none", assignments: 0, quizzes: 0 });
  assert.deepEqual(filesOnDisk(), files);
  assert.equal(db.tables.breakoutAssignment.length, 2);
});

// ---- Duplicates and authorization ----------------------------------------------------------

test("duplicates: a second delete only retries the purge; delete after preserve deletes nothing", async () => {
  await groupWork(S1);
  const first = await end("delete");
  assert.equal(first.groupActivities.cleanup.status, "done");
  const again = await end("delete");
  assert.equal(again.alreadyEnded, true);
  assert.equal("groupActivities" in again, false, "nothing left to retry");

  await groupWork(S2);
  const rows = sessionRows(S2);
  const files = filesOf(filesOnDisk(), S2);
  await end("preserve", "t1", S2);
  const late = await end("delete", "t1", S2);
  assert.equal(late.alreadyEnded, true);
  assert.deepEqual(sessionRows(S2), rows, "the preserved session keeps everything");
  assert.deepEqual(filesOf(filesOnDisk(), S2), files);
});

test("concurrent delete requests: one ends the session, the other finds it ended; nothing else is lost", async () => {
  await individualWork();
  await groupWork();
  const individual = individualRows();
  const results = await Promise.all([end("delete"), end("delete")]);
  assert.deepEqual(results.map((r) => r.alreadyEnded).sort(), [false, true]);
  assert.deepEqual(individualRows(), individual);
  assert.equal(db.tables.breakoutAssignment.filter((r) => r.workMode === "GROUP").length, 0);
});

test("authorization: another teacher's session is 404 and nothing changes", async () => {
  await groupWork();
  const rows = sessionRows(S1);
  await assert.rejects(end("delete", "t2"), appError(404, "SESSION_NOT_FOUND"));
  await assert.rejects(sessionEnd.endSessionAndMarkGroupActivitiesForPurge({ teacherId: "t2", sessionId: S1, endedAt: new Date(clock) }), appError(404, "SESSION_NOT_FOUND"));
  assert.equal(sessionOf(S1).isActive, true);
  assert.deepEqual(sessionRows(S1), rows);
});

// ---- Route ---------------------------------------------------------------------------------

const post = (body) =>
  endRoute.POST(new Request(`http://localhost/api/sessions/${S1}/end`, { method: "POST", body }), { params: { id: S1 } });

test("route: no body as before; a decision body is accepted; anything else is 400", async () => {
  await groupWork();
  const required = await post(undefined);
  assert.equal(required.status, 409);
  const payload = await required.json();
  assert.equal(payload.error.code, "GROUP_ACTIVITIES_DECISION_REQUIRED");
  assert.equal(payload.error.details.summary.assignments, 2);

  for (const bad of ["not json", "[]", JSON.stringify({ groupActivities: "maybe" }), JSON.stringify({ groupActivities: "delete", extra: 1 })]) {
    const response = await post(bad);
    assert.equal(response.status, 400, bad);
  }
  assert.equal(sessionOf(S1).isActive, true);

  const ok = await post(JSON.stringify({ groupActivities: "preserve" }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.groupActivities.decision, "preserve");
});

// ---- Storage helper -------------------------------------------------------------------------

test("removeBreakoutActivityDir: removes one activity folder of one session only; invalid ids refused", async () => {
  const group = await groupWork(S1);
  await individualWork(S1);
  const before = filesOnDisk();
  assert.deepEqual(await storage.removeBreakoutActivityDir(S1, "submission", group.r1, storageRoot), { removed: true });
  const after = filesOnDisk();
  for (const p of Object.keys(before)) {
    if (p.startsWith(`breakout-activities/${S1}/submissions/${group.r1}/`)) assert.equal(after[p], undefined);
    else assert.equal(after[p], before[p]);
  }
  assert.deepEqual(await storage.removeBreakoutActivityDir(S1, "submission", group.r1, storageRoot), { removed: true }, "already gone");
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await storage.removeBreakoutActivityDir(S1, "submission", "..", storageRoot), { removed: false });
    assert.deepEqual(await storage.removeBreakoutActivityDir("not-a-uuid", "brief", group.r1, storageRoot), { removed: false });
    assert.deepEqual(await storage.removeBreakoutActivityDir(S1, "other", group.r1, storageRoot), { removed: false });
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(Object.keys(filesOnDisk()).length, Object.keys(after).length);
});
