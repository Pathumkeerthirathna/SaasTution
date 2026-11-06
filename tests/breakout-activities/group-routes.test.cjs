/*
 * Group Activities routes (app/api/sessions/[id]/breakout-activities/groups/**
 * and …/me/group/**): the feature flag (off = 404 before authentication, no
 * database access), roles (teacher routes refuse students, student routes
 * refuse teachers), strict bodies (no room / student id taken from the
 * student), and the end-to-end flow through the real routes and services:
 * the teacher confirms existing rooms and publishes, members collaborate,
 * one member submits, the teacher sees the result.
 *
 * Real route modules and services; lib/prisma.ts is the in-memory fake,
 * lib/server-clock.ts a fixed clock, lib/auth-session.ts a fake login.
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

const root = path.resolve(__dirname, "..", "..");
const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "breakout-group-routes-")));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");

require("tsx/cjs/api").register();

const { createFakeGroupDb } = require("./helpers/fake-group-db.cjs");

let db;
let clock = new Date("2026-11-06T09:00:00.000Z");
let login = null; // { role, id }
let authCalls = 0;

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const { AppError } = require(path.join(root, "lib/error-handler.ts"));
fake("lib/prisma.ts", { prisma: new Proxy({}, { get: (_, key) => db.client[key] }) });
fake("lib/server-clock.ts", { serverNow: async () => new Date(clock), serverNowSync: () => new Date(clock), resetServerClock() {} });
fake("lib/auth-session.ts", {
  requireStudentSession: async () => {
    authCalls += 1;
    if (!login || login.role !== "STUDENT") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { studentId: login.id, name: "Student", role: "STUDENT" };
  },
  requireTeacherSession: async () => {
    authCalls += 1;
    if (!login || login.role !== "TEACHER") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { teacherId: login.id, role: "TEACHER" };
  },
});

const base = path.join(root, "app/api/sessions/[id]/breakout-activities");
const r = (p) => require(path.join(base, p));
const routes = {
  overview: r("groups/route.ts"),
  members: r("groups/members/route.ts"),
  createAssignment: r("groups/assignments/route.ts"),
  teacherAssignment: r("groups/assignments/[assignmentId]/route.ts"),
  teacherFile: r("groups/assignments/[assignmentId]/submission/file/route.ts"),
  createQuiz: r("groups/quizzes/route.ts"),
  teacherQuiz: r("groups/quizzes/[quizId]/route.ts"),
  grading: r("groups/quizzes/[quizId]/grading/route.ts"),
  myGroup: r("me/group/route.ts"),
  myAssignment: r("me/group/assignments/[assignmentId]/route.ts"),
  myBrief: r("me/group/assignments/[assignmentId]/brief/route.ts"),
  mySubmission: r("me/group/assignments/[assignmentId]/submission/route.ts"),
  mySubmissionFile: r("me/group/assignments/[assignmentId]/submission/file/route.ts"),
  myQuiz: r("me/group/quizzes/[quizId]/route.ts"),
  myAttempt: r("me/group/quizzes/[quizId]/attempt/route.ts"),
  mySubmit: r("me/group/quizzes/[quizId]/attempt/submit/route.ts"),
};

const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";
const A = "a1111111-1111-4111-8111-111111111111";
const B = "a2222222-2222-4222-8222-222222222222";
const C = "a3333333-3333-4333-8333-333333333333";
const R1 = "0abad041-7a70-4fec-8ace-2db4bbaf1fee";
const R2 = "0abad041-7a70-4fec-8ace-2db4bbaf1fef";
const ANY = "f0000000-0000-4000-8000-000000000000";

const savedCwd = process.cwd();
test.before(() => process.chdir(sandbox));
test.after(() => {
  process.chdir(savedCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});
test.beforeEach(() => {
  clock = new Date("2026-11-06T09:00:00.000Z");
  login = { role: "TEACHER", id: "t1" };
  authCalls = 0;
  process.env.BREAKOUT_ACTIVITIES_ENABLED = "true";
  db = createFakeGroupDb();
  db.tables.class.push({ id: "c1", teacherId: "t1" });
  db.tables.classSession.push({ id: S1, classId: "c1", isActive: true });
  for (const [id, name] of [[A, "Amaya"], [B, "Bimal"], [C, "Chathu"]]) {
    db.tables.student.push({ id, name, status: 0 });
    db.tables.classStudent.push({ studentId: id, classId: "c1", isActive: true });
  }
});
test.afterEach(() => {
  delete process.env.BREAKOUT_ACTIVITIES_ENABLED;
});

const url = (p) => `http://localhost/api/sessions/${S1}/breakout-activities${p}`;
const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function call(handler, href, init = { method: "GET" }, params = {}) {
  const response = await handler(new Request(href, init), { params: { id: S1, ...params } });
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("application/json") ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { status: response.status, body };
}

const ROOMS = [
  { id: R1, name: "Room 1", studentIds: [A, B] },
  { id: R2, name: "Room 2", studentIds: [C] },
];

// [name, handler, method, params, init]
const EVERY = [
  ["overview", routes.overview.GET, {}, () => ({ method: "GET" })],
  ["members", routes.members.PUT, {}, () => json("PUT", { rooms: ROOMS })],
  ["createAssignment", routes.createAssignment.POST, {}, () => ({ method: "POST", body: new FormData() })],
  ["teacherAssignment", routes.teacherAssignment.GET, { assignmentId: ANY }, () => ({ method: "GET" })],
  ["teacherFile", routes.teacherFile.GET, { assignmentId: ANY }, () => ({ method: "GET" })],
  ["createQuiz", routes.createQuiz.POST, {}, () => json("POST", {})],
  ["teacherQuiz", routes.teacherQuiz.GET, { quizId: ANY }, () => ({ method: "GET" })],
  ["grading", routes.grading.PATCH, { quizId: ANY }, () => json("PATCH", { overrides: [] })],
  ["myGroup", routes.myGroup.GET, {}, () => ({ method: "GET" })],
  ["myAssignment", routes.myAssignment.GET, { assignmentId: ANY }, () => ({ method: "GET" })],
  ["myAssignment PUT", routes.myAssignment.PUT, { assignmentId: ANY }, () => json("PUT", { revision: 0, answerText: "" })],
  ["myBrief", routes.myBrief.GET, { assignmentId: ANY }, () => ({ method: "GET" })],
  ["mySubmission", routes.mySubmission.POST, { assignmentId: ANY }, () => ({ method: "POST", body: new FormData() })],
  ["mySubmissionFile", routes.mySubmissionFile.GET, { assignmentId: ANY }, () => ({ method: "GET" })],
  ["myQuiz", routes.myQuiz.GET, { quizId: ANY }, () => ({ method: "GET" })],
  ["myAttempt POST", routes.myAttempt.POST, { quizId: ANY }, () => ({ method: "POST" })],
  ["myAttempt PATCH", routes.myAttempt.PATCH, { quizId: ANY }, () => json("PATCH", { answers: {} })],
  ["mySubmit", routes.mySubmit.POST, { quizId: ANY }, () => json("POST", { revision: 0 })],
];
const TEACHER_ROUTES = new Set(["overview", "members", "createAssignment", "teacherAssignment", "teacherFile", "createQuiz", "teacherQuiz", "grading"]);

test("feature flag off: every group route is 404 before authentication; nothing read or written", async () => {
  for (const value of [undefined, "", "false", "0", "yes"]) {
    if (value === undefined) delete process.env.BREAKOUT_ACTIVITIES_ENABLED;
    else process.env.BREAKOUT_ACTIVITIES_ENABLED = value;
    for (const [name, handler, params, init] of EVERY) {
      const res = await call(handler, url(""), init(), params);
      assert.equal(res.status, 404, `${name} (${value})`);
      assert.equal(res.body.error.code, "NOT_FOUND", name);
    }
  }
  assert.equal(authCalls, 0);
  assert.equal(db.calls.length, 0, "no database access");
});

test("roles: teacher routes refuse students, student routes refuse teachers and anonymous callers (401)", async () => {
  for (const who of [null, { role: "STUDENT", id: A }, { role: "TEACHER", id: "t1" }]) {
    login = who;
    for (const [name, handler, params, init] of EVERY) {
      const allowed = who && (TEACHER_ROUTES.has(name) ? who.role === "TEACHER" : who.role === "STUDENT");
      if (allowed) continue;
      const res = await call(handler, url(""), init(), params);
      assert.equal(res.status, 401, `${name} as ${who ? who.role : "nobody"}`);
    }
  }
  assert.equal(db.tables.breakoutRoomMember.length + db.tables.breakoutAssignment.length, 0, "nothing written");
});

test("strict bodies: unknown fields (a room or student id from the client) are refused", async () => {
  login = { role: "TEACHER", id: "t1" };
  const res = await call(routes.members.PUT, url("/groups/members"), json("PUT", { rooms: ROOMS, teacherId: "t2" }));
  assert.equal(res.status, 400);
  login = { role: "STUDENT", id: A };
  const save = await call(routes.myAssignment.PUT, url(""), json("PUT", { revision: 0, answerText: "x", studentId: B }), { assignmentId: ANY });
  assert.equal(save.status, 400);
  const quizSave = await call(routes.myAttempt.PATCH, url(""), json("PATCH", { answers: {}, roomId: R2 }), { quizId: ANY });
  assert.equal(quizSave.status, 400);
});

test("end to end: confirm existing rooms, publish, collaborate, submit once, the teacher sees the result", async () => {
  // Teacher publishes a group assignment to the two existing rooms (members confirmed with it).
  login = { role: "TEACHER", id: "t1" };
  const form = new FormData();
  form.set("title", "Poster");
  form.set("instructions", "Make a poster together");
  form.set("rooms", JSON.stringify(ROOMS));
  form.set("publish", "true");
  const created = await call(routes.createAssignment.POST, url("/groups/assignments"), { method: "POST", body: form });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const r1 = created.body.data.assignments.find((a) => a.target.id === R1).id;

  // Members collaborate.
  login = { role: "STUDENT", id: A };
  const mine = await call(routes.myGroup.GET, url("/me/group"));
  assert.equal(mine.body.data.group.room.id, R1);
  assert.deepEqual(mine.body.data.assignments.map((a) => a.id), [r1]);
  const s1 = await call(routes.myAssignment.PUT, url(""), json("PUT", { revision: 0, answerText: "Title by Amaya" }), { assignmentId: r1 });
  assert.equal(s1.status, 200);
  login = { role: "STUDENT", id: B };
  const stale = await call(routes.myAssignment.PUT, url(""), json("PUT", { revision: 0, answerText: "Bimal overwrites" }), { assignmentId: r1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "REVISION_CONFLICT");
  assert.equal(stale.body.error.details.work.answerText, "Title by Amaya");
  const s2 = await call(routes.myAssignment.PUT, url(""), json("PUT", { revision: 1, answerText: "Title by Amaya\nBody by Bimal" }), { assignmentId: r1 });
  assert.equal(s2.body.data.work.lastEditedBy.name, "Bimal");

  // Another group's member cannot see it.
  login = { role: "STUDENT", id: C };
  assert.equal((await call(routes.myAssignment.GET, url(""), { method: "GET" }, { assignmentId: r1 })).status, 404);

  // B submits once; A's later submit replays it.
  login = { role: "STUDENT", id: B };
  const sub = new FormData();
  sub.set("revision", "2");
  const done = await call(routes.mySubmission.POST, url(""), { method: "POST", body: sub }, { assignmentId: r1 });
  assert.equal(done.status, 201);
  assert.equal(done.body.data.replayed, false);
  login = { role: "STUDENT", id: A };
  const again = new FormData();
  again.set("revision", "0");
  const replay = await call(routes.mySubmission.POST, url(""), { method: "POST", body: again }, { assignmentId: r1 });
  assert.equal(replay.body.data.replayed, true);
  assert.equal(replay.body.data.work.submission.submittedBy.name, "Bimal");

  // The teacher's progress view and detail.
  login = { role: "TEACHER", id: "t1" };
  const progress = await call(routes.overview.GET, url("/groups"));
  const room1 = progress.body.data.rooms.find((room) => room.id === R1);
  assert.equal(room1.assignments[0].progress.submitted.submittedBy.name, "Bimal");
  const detail = await call(routes.teacherAssignment.GET, url(""), { method: "GET" }, { assignmentId: r1 });
  assert.equal(detail.body.data.work.answerText, "Title by Amaya\nBody by Bimal");
  assert.deepEqual(detail.body.data.work.submission.members.map((m) => m.name).sort(), ["Amaya", "Bimal"]);
});

test("end to end: a group quiz through the routes", async () => {
  login = { role: "TEACHER", id: "t1" };
  const created = await call(
    routes.createQuiz.POST,
    url("/groups/quizzes"),
    json("POST", {
      title: "Quick quiz",
      questions: [{ kind: "true_false", prompt: "The sky is blue.", marks: 1, correct: true }],
      rooms: [{ id: R1, name: "Room 1", studentIds: [A, B] }],
      publish: true,
    })
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const quizId = created.body.data.quizzes[0].id;
  assert.equal(JSON.stringify(created.body.data).includes('"correct"'), false, "no answer keys in the response");

  login = { role: "STUDENT", id: A };
  const started = await call(routes.myAttempt.POST, url(""), { method: "POST" }, { quizId });
  assert.equal(started.status, 201);
  const questionId = started.body.data.quiz.questions[0].id;
  login = { role: "STUDENT", id: B };
  const resumed = await call(routes.myAttempt.POST, url(""), { method: "POST" }, { quizId });
  assert.equal(resumed.status, 200);
  const saved = await call(routes.myAttempt.PATCH, url(""), json("PATCH", { answers: { [questionId]: { kind: "true_false", value: true } } }), { quizId });
  assert.equal(saved.status, 200);
  const submitted = await call(routes.mySubmit.POST, url(""), json("POST", { revision: saved.body.data.attempt.revision }), { quizId });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.data.attempt.finalScore, 1);

  login = { role: "TEACHER", id: "t1" };
  const detail = await call(routes.teacherQuiz.GET, url(""), { method: "GET" }, { quizId });
  assert.equal(detail.body.data.attempt.submittedBy.name, "Bimal");
  const override = await call(routes.grading.PATCH, url(""), json("PATCH", { overrides: [{ questionId, marks: 0.5 }] }), { quizId });
  assert.equal(override.status, 200);
  assert.equal(override.body.data.finalScore, 0.5);
});
