/*
 * Student breakout activity routes
 * (app/api/sessions/[id]/breakout-activities/me/**): the feature flag (404
 * before authentication), student authentication (401, a teacher login is
 * refused), the studentId taken from the session only (body, form and query
 * values ignored or refused), the room never taken from the client, D2
 * access (all 404), the production default resolver failing closed, body
 * validation (JSON / multipart, strict fields, size caps), drafts, PDF / text
 * submissions with idempotent replay (also with an invalid file on the
 * retry), own history and file downloads, quiz metadata-only without an
 * attempt, start (201 / 200), save (REVISION_CONFLICT, QUIZ_TIME_UP with
 * details), submit (AUTO_SUBMITTED past the grace), the error envelope, and
 * that responses never leak paths, keys, raw grading or internal fields.
 *
 * Real route modules and services. lib/prisma.ts is an in-memory fake,
 * lib/server-clock.ts a fixed clock, lib/auth-session.ts a fake login. The
 * room resolver module is the real one except that its DEFAULT resolver is
 * replaced, in this test process only, by one reading a test table (or
 * delegating to the real fail-closed resolver). The production default is
 * asserted to stay fail-closed. The working directory (uploads) and
 * ERROR_LOG_DIR point to a temporary folder, removed afterwards. No database
 * is contacted.
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
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "breakout-student-routes-")));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");

require("tsx/cjs/api").register();

const { createFakeBreakoutDb } = require("./helpers/fake-breakout-db.cjs");

// ---- Fakes ------------------------------------------------------------------

let db;
let clock = new Date("2026-11-06T09:00:00.000Z");
let login = null; // { role: "TEACHER" | "STUDENT", id }
let authCalls = 0;
let rooms = {}; // studentId -> room
let failClosed = false; // true: the default resolver delegates to the real fail-closed one
let resolverCalls = 0;

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
    if (!login) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    if (login.role !== "STUDENT") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { studentId: login.id, name: "Student", role: "STUDENT" };
  },
  requireTeacherSession: async () => {
    throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
  },
});

// The real resolver module, loaded first; then its cache entry is replaced by
// the same exports with a test-controlled default (test process only).
const realResolver = require(path.join(root, "lib/breakout-activities/room-resolver.ts"));
const PRODUCTION_DEFAULT = realResolver.defaultStudentRoomResolver;
const testResolver = {
  async resolveStudentRoom(query) {
    resolverCalls += 1;
    if (failClosed) return PRODUCTION_DEFAULT.resolveStudentRoom(query);
    return rooms[query.studentId] ?? null;
  },
};
fake("lib/breakout-activities/room-resolver.ts", { ...realResolver, defaultStudentRoomResolver: testResolver });

const base = path.join(root, "app/api/sessions/[id]/breakout-activities/me");
const routes = {
  assignments: require(path.join(base, "assignments/route.ts")),
  brief: require(path.join(base, "assignments/[assignmentId]/brief/route.ts")),
  draft: require(path.join(base, "assignments/[assignmentId]/draft/route.ts")),
  submissions: require(path.join(base, "assignments/[assignmentId]/submissions/route.ts")),
  submissionFile: require(path.join(base, "assignments/[assignmentId]/submissions/[submissionId]/file/route.ts")),
  quizzes: require(path.join(base, "quizzes/route.ts")),
  quiz: require(path.join(base, "quizzes/[quizId]/route.ts")),
  attempt: require(path.join(base, "quizzes/[quizId]/attempt/route.ts")),
  submit: require(path.join(base, "quizzes/[quizId]/attempt/submit/route.ts")),
};
const { writeBreakoutPdf } = require(path.join(root, "lib/breakout-activities/storage.ts"));
const v = require(path.join(root, "lib/breakout-activities/validation.ts"));
const { MAX_BREAKOUT_PDF_BYTES } = require(path.join(root, "lib/breakout-activities/pdf-file.ts"));

const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21"; // active, class-1
const S2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"; // active, class-2
const S3 = "1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b"; // ended, class-1
const ST1 = "a1111111-1111-4111-8111-111111111111"; // enrolled class-1, MAIN
const ST2 = "a2222222-2222-4222-8222-222222222222"; // enrolled class-1, room r1
const ST3 = "a3333333-3333-4333-8333-333333333333"; // not enrolled
const MISSING = "f0000000-0000-4000-8000-000000000000";
const A = {
  MAIN: "b0000000-0000-4000-8000-000000000001",
  R1: "b0000000-0000-4000-8000-000000000002",
  CLOSED: "b0000000-0000-4000-8000-000000000003",
  DRAFT: "b0000000-0000-4000-8000-000000000004",
};
const Q = {
  MAIN: "d0000000-0000-4000-8000-000000000001",
  R1: "d0000000-0000-4000-8000-000000000002",
  CLOSED: "d0000000-0000-4000-8000-000000000003",
  DRAFT: "d0000000-0000-4000-8000-000000000004",
};
const DEFINITION = v.assignServerIds([
  { kind: "single", prompt: "2 + 2?", marks: 2, options: [{ text: "3" }, { text: "4", correct: true }] },
  { kind: "true_false", prompt: "Sky blue?", marks: 1, correct: true },
]);
const [SINGLE, TF] = DEFINITION.questions;

function assignment(id, extra = {}) {
  return {
    id, classSessionId: S1, teacherId: "t1", publishGroupId: "g1", targetRoomType: "MAIN", targetRoomId: null, targetRoomName: "Main room",
    title: `Assignment ${id.slice(-1)}`, instructions: "Write", briefFileName: null, briefFilePath: null, briefFileSize: null,
    state: "PUBLISHED", publishedAt: clock, closedAt: null, status: 0, createdAt: new Date(clock.getTime() + Number(id.slice(-1))), updatedAt: clock, ...extra,
  };
}
function quiz(id, extra = {}) {
  return {
    id, classSessionId: S1, teacherId: "t1", publishGroupId: "g2", targetRoomType: "MAIN", targetRoomId: null, targetRoomName: "Main room",
    title: `Quiz ${id.slice(-1)}`, instructions: "Answer all", questions: structuredClone(DEFINITION), totalMarks: 3, timeLimitSeconds: 600,
    state: "PUBLISHED", publishedAt: clock, closedAt: null, status: 0, createdAt: new Date(clock.getTime() + Number(id.slice(-1))), updatedAt: clock, ...extra,
  };
}

const savedCwd = process.cwd();
test.before(() => process.chdir(sandbox));
test.after(() => {
  process.chdir(savedCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});
test.beforeEach(() => {
  clock = new Date("2026-11-06T09:00:00.000Z");
  login = { role: "STUDENT", id: ST1 };
  authCalls = 0;
  resolverCalls = 0;
  failClosed = false;
  rooms = { [ST1]: { type: "MAIN" }, [ST2]: { type: "BREAKOUT", id: "r1" } };
  process.env.BREAKOUT_ACTIVITIES_ENABLED = "true";
  db = createFakeBreakoutDb();
  db.tables.class.push({ id: "class-1", teacherId: "t1" }, { id: "class-2", teacherId: "t1" });
  db.tables.classSession.push({ id: S1, classId: "class-1", isActive: true }, { id: S2, classId: "class-2", isActive: true }, { id: S3, classId: "class-1", isActive: false });
  db.tables.student.push({ id: ST1, status: 0 }, { id: ST2, status: 0 }, { id: ST3, status: 0 });
  db.tables.classStudent.push({ studentId: ST1, classId: "class-1", isActive: true }, { studentId: ST2, classId: "class-1", isActive: true });
  db.tables.breakoutAssignment.push(
    assignment(A.MAIN),
    assignment(A.R1, { targetRoomType: "BREAKOUT", targetRoomId: "r1", targetRoomName: "Room 1" }),
    assignment(A.CLOSED, { state: "CLOSED", closedAt: clock }),
    assignment(A.DRAFT, { state: "DRAFT", publishedAt: null })
  );
  db.tables.breakoutQuiz.push(
    quiz(Q.MAIN),
    quiz(Q.R1, { targetRoomType: "BREAKOUT", targetRoomId: "r1", targetRoomName: "Room 1" }),
    quiz(Q.CLOSED, { state: "CLOSED", closedAt: clock }),
    quiz(Q.DRAFT, { state: "DRAFT", publishedAt: null })
  );
});
test.afterEach(() => {
  delete process.env.BREAKOUT_ACTIVITIES_ENABLED;
});

// ---- Request helpers ------------------------------------------------------------

const url = (p = "", query = "", session = S1) => `http://localhost/api/sessions/${session}/breakout-activities/me${p}${query}`;
const json = (method, body, extraHeaders = {}) => ({
  method,
  headers: { "content-type": "application/json", ...extraHeaders },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
function multipart(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    const values = Array.isArray(value) ? value : [value];
    for (const one of values) {
      if (one === undefined) continue;
      if (one && one.pdf) form.append(key, new Blob([one.pdf], { type: one.type ?? "application/pdf" }), one.name ?? "answer.pdf");
      else form.append(key, one);
    }
  }
  return { method: "POST", body: form };
}
async function call(handler, href, init = { method: "GET" }, params = {}, session = S1) {
  const response = await handler(new Request(href, init), { params: { id: session, ...params } });
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("application/json") ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body };
}
const pdfBytes = (fill = 1, size = 64) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(Buffer.from("%PDF-1.7\n"));
  return bytes;
};
const expectError = (res, status, code) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, code, JSON.stringify(res.body));
};
const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  return res.body.data;
};

let keySeq = 0;
const newKey = () => `route-key-${++keySeq}`;
const submitAssignment = (fields = {}, assignmentId = A.MAIN) =>
  call(routes.submissions.POST, url(`/assignments/${assignmentId}/submissions`), multipart({ idempotencyKey: newKey(), answerText: "My answer", ...fields }), { assignmentId });
const putDraft = (body, assignmentId = A.MAIN) =>
  call(routes.draft.PUT, url(`/assignments/${assignmentId}/draft`), json("PUT", body), { assignmentId });
const startQuiz = (quizId = Q.MAIN) => call(routes.attempt.POST, url(`/quizzes/${quizId}/attempt`), { method: "POST" }, { quizId });
const saveAnswers = (body, quizId = Q.MAIN) => call(routes.attempt.PATCH, url(`/quizzes/${quizId}/attempt`), json("PATCH", body), { quizId });
const submitQuiz = (body, quizId = Q.MAIN) => call(routes.submit.POST, url(`/quizzes/${quizId}/attempt/submit`), json("POST", body), { quizId });
const tfAnswer = (value) => ({ [TF.id]: { kind: "true_false", value } });

async function seedAttempt(quizId, studentId, attemptStatus, answers = {}, extra = {}) {
  const marking = await import(pathToFileURL(path.join(root, "lib/breakout-activities/marking.mjs")).href);
  const grading = attemptStatus === "IN_PROGRESS" ? null : marking.gradeAttempt(DEFINITION, answers);
  const scores = grading ? marking.computeScores(grading) : null;
  const row = {
    id: `e${String(db.tables.breakoutQuizSubmission.length + 1).padStart(7, "0")}-0000-4000-8000-000000000000`, quizId, classSessionId: S1, studentId, attemptStatus,
    answers, revision: 1, startedAt: clock, deadlineAt: new Date(clock.getTime() + 600_000), lastSavedAt: clock,
    submittedAt: grading ? clock : null, grading, autoScore: scores?.autoScore ?? null, finalScore: scores?.finalScore ?? null, overriddenAt: null, updatedAt: clock, ...extra,
  };
  db.tables.breakoutQuizSubmission.push(row);
  return row;
}

/** Every key at any depth, plus every string value (for leak checks). */
function walk(value, keys = new Set(), strings = []) {
  if (Array.isArray(value)) value.forEach((x) => walk(x, keys, strings));
  else if (value && typeof value === "object") {
    for (const [k, x] of Object.entries(value)) {
      keys.add(k);
      walk(x, keys, strings);
    }
  } else if (typeof value === "string") strings.push(value);
  return { keys, strings };
}
const INTERNAL = ["briefFilePath", "filePath", "idempotencyKey", "classSessionId", "studentId", "teacherId", "publishGroupId", "targetRoomId", "status", "grading", "autoScore"];
const ANSWER_KEYS = ["correct", "correctOptionId", "correctOptionIds", "acceptedAnswers"];
function assertNoLeaks(body, { answerKeysAllowed = false } = {}) {
  const { keys, strings } = walk(body);
  for (const k of INTERNAL) assert.equal(keys.has(k), false, `leaked key ${k}`);
  if (!answerKeysAllowed) for (const k of ANSWER_KEYS) assert.equal(keys.has(k), false, `leaked answer key ${k}`);
  assert.equal(strings.some((s) => s.includes("breakout-activities/") || s.includes("storage")), false, "leaked a stored path");
  assert.equal(strings.some((s) => s.startsWith("route-key-") || s === "secret-idem-key"), false, "leaked an idempotency key");
}

// ---- Every route ------------------------------------------------------------

const EVERY = [
  ["GET assignments", routes.assignments.GET, url("/assignments"), { method: "GET" }, {}],
  ["GET brief", routes.brief.GET, url(`/assignments/${A.MAIN}/brief`), { method: "GET" }, { assignmentId: A.MAIN }],
  ["GET draft", routes.draft.GET, url(`/assignments/${A.MAIN}/draft`), { method: "GET" }, { assignmentId: A.MAIN }],
  ["PUT draft", routes.draft.PUT, url(`/assignments/${A.MAIN}/draft`), json("PUT", { revision: 0, answerText: "x" }), { assignmentId: A.MAIN }],
  ["GET submissions", routes.submissions.GET, url(`/assignments/${A.MAIN}/submissions`), { method: "GET" }, { assignmentId: A.MAIN }],
  ["POST submission", routes.submissions.POST, url(`/assignments/${A.MAIN}/submissions`), () => multipart({ idempotencyKey: "every-1", answerText: "x" }), { assignmentId: A.MAIN }],
  ["GET submission file", routes.submissionFile.GET, url(`/assignments/${A.MAIN}/submissions/${MISSING}/file`), { method: "GET" }, { assignmentId: A.MAIN, submissionId: MISSING }],
  ["GET quizzes", routes.quizzes.GET, url("/quizzes"), { method: "GET" }, {}],
  ["GET quiz", routes.quiz.GET, url(`/quizzes/${Q.MAIN}`), { method: "GET" }, { quizId: Q.MAIN }],
  ["POST attempt", routes.attempt.POST, url(`/quizzes/${Q.MAIN}/attempt`), { method: "POST" }, { quizId: Q.MAIN }],
  ["PATCH attempt", routes.attempt.PATCH, url(`/quizzes/${Q.MAIN}/attempt`), json("PATCH", { revision: 0, answers: {} }), { quizId: Q.MAIN }],
  ["POST submit", routes.submit.POST, url(`/quizzes/${Q.MAIN}/attempt/submit`), json("POST", { revision: 0 }), { quizId: Q.MAIN }],
];
const callEvery = (entry, session = S1) => {
  const [, handler, href, init, params] = entry;
  return call(handler, href, typeof init === "function" ? init() : init, params, session);
};
const breakoutWrites = () =>
  db.tables.breakoutAssignmentDraft.length + db.tables.breakoutAssignmentSubmission.length + db.tables.breakoutQuizSubmission.length;

test("route config: nodejs runtime and force-dynamic on every route file; only the intended methods", () => {
  const methods = { assignments: ["GET"], brief: ["GET"], draft: ["GET", "PUT"], submissions: ["GET", "POST"], submissionFile: ["GET"], quizzes: ["GET"], quiz: ["GET"], attempt: ["PATCH", "POST"], submit: ["POST"] };
  for (const [name, mod] of Object.entries(routes)) {
    assert.equal(mod.runtime, "nodejs", name);
    assert.equal(mod.dynamic, "force-dynamic", name);
    const exported = Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k)).sort();
    assert.deepEqual(exported, methods[name], name);
  }
});

test("feature flag off: every route is 404 NOT_FOUND before authentication, no room resolved, nothing read or written", async () => {
  for (const value of [undefined, "", "false", "0", "yes", "on", "enabled"]) {
    if (value === undefined) delete process.env.BREAKOUT_ACTIVITIES_ENABLED;
    else process.env.BREAKOUT_ACTIVITIES_ENABLED = value;
    for (const entry of EVERY) {
      const res = await callEvery(entry);
      expectError(res, 404, "NOT_FOUND");
      assert.equal(res.body.error.details, undefined, entry[0]);
    }
  }
  assert.equal(authCalls, 0, "authentication is never called");
  assert.equal(resolverCalls, 0);
  assert.equal(db.calls.length, 0, "no database access");
});

test("authentication: no login and a teacher login are 401 on every route; nothing written", async () => {
  for (const who of [null, { role: "TEACHER", id: "t1" }]) {
    login = who;
    for (const entry of EVERY) expectError(await callEvery(entry), 401, "UNAUTHORIZED");
  }
  assert.equal(resolverCalls, 0);
  assert.equal(breakoutWrites(), 0);
});

test("the PRODUCTION default resolver is still fail-closed, and through it every route is 404 NOT_FOUND", async () => {
  assert.equal(PRODUCTION_DEFAULT, realResolver.failClosedStudentRoomResolver, "the real module's default is the fail-closed resolver");
  assert.equal(await PRODUCTION_DEFAULT.resolveStudentRoom({ sessionId: S1, studentId: ST1 }), null);
  failClosed = true;
  for (const entry of EVERY) expectError(await callEvery(entry), 404, "NOT_FOUND");
  assert.ok(resolverCalls >= EVERY.length, "the resolver was consulted");
  assert.equal(breakoutWrites(), 0);
});

test("D2: not enrolled, an ended session, another class's session, an inactive enrolment: the same 404 NOT_FOUND everywhere", async () => {
  rooms[ST3] = { type: "MAIN" };
  const cases = [[ST3, S1], [ST1, S3], [ST1, S2], [ST1, MISSING], [ST1, "not-a-uuid"]];
  for (const [studentId, session] of cases) {
    login = { role: "STUDENT", id: studentId };
    for (const entry of EVERY) {
      const [, handler, href, init, params] = entry;
      const res = await call(handler, href.replace(S1, session), typeof init === "function" ? init() : init, params, session);
      expectError(res, 404, "NOT_FOUND");
    }
  }
  login = { role: "STUDENT", id: ST1 };
  db.tables.classStudent[0].isActive = false;
  for (const entry of EVERY) expectError(await callEvery(entry), 404, "NOT_FOUND");
  assert.equal(breakoutWrites(), 0);
});

test("unknown room (the resolver returns nothing): 404 NOT_FOUND, nothing written", async () => {
  rooms[ST1] = null;
  for (const entry of EVERY) expectError(await callEvery(entry), 404, "NOT_FOUND");
  assert.equal(breakoutWrites(), 0);
});

// ---- Identity and room come from the server only -----------------------------------

test("studentId comes from the session only: a studentId in the query is ignored, in a JSON body or form refused", async () => {
  // ST2's draft exists; ST1 asks with ?studentId=ST2.
  login = { role: "STUDENT", id: ST2 };
  ok(await putDraft({ revision: 0, answerText: "ST2 private" }, A.R1));
  login = { role: "STUDENT", id: ST1 };
  const res = await call(routes.draft.GET, url(`/assignments/${A.R1}/draft`, `?studentId=${ST2}&roomId=r1`), { method: "GET" }, { assignmentId: A.R1 });
  expectError(res, 404, "ASSIGNMENT_NOT_FOUND"); // ST1 is in MAIN: r1 is not visible, the query changes nothing
  const mine = ok(await call(routes.draft.GET, url(`/assignments/${A.MAIN}/draft`, `?studentId=${ST2}`), { method: "GET" }, { assignmentId: A.MAIN }));
  assert.deepEqual(mine.draft, { answerText: "", revision: 0, updatedAt: null });

  expectError(await putDraft({ revision: 0, answerText: "x", studentId: ST2 }), 400, "VALIDATION_ERROR");
  expectError(await saveAnswers({ revision: 0, answers: {}, studentId: ST2 }), 400, "VALIDATION_ERROR");
  expectError(await submitQuiz({ revision: 0, studentId: ST2 }), 400, "VALIDATION_ERROR");
  expectError(await submitAssignment({ studentId: ST2 }), 400, "VALIDATION_ERROR");
  assert.equal(db.tables.breakoutAssignmentSubmission.length, 0);
  assert.equal(db.tables.breakoutAssignmentDraft.length, 1, "only ST2's own draft");
});

test("the room never comes from the client: roomId / room fields are refused and a room query parameter is ignored", async () => {
  expectError(await submitAssignment({ roomId: "r1" }, A.R1), 400, "VALIDATION_ERROR");
  expectError(await putDraft({ revision: 0, answerText: "x", roomId: "r1" }, A.R1), 400, "VALIDATION_ERROR");
  expectError(await saveAnswers({ revision: 0, answers: {}, room: { type: "BREAKOUT", id: "r1" } }, Q.R1), 400, "VALIDATION_ERROR");
  const list = ok(await call(routes.assignments.GET, url("/assignments", "?roomId=r1&room=BREAKOUT"), { method: "GET" }));
  assert.deepEqual(list.room, { type: "MAIN" });
  assert.deepEqual(list.assignments.map((a) => a.id), [A.MAIN, A.CLOSED]);
  const quizzes = ok(await call(routes.quizzes.GET, url("/quizzes", "?roomId=r1"), { method: "GET" }));
  assert.deepEqual(quizzes.quizzes.map((q) => q.id), [Q.MAIN, Q.CLOSED]);
  // Another room's activity, a DRAFT and a missing one: 404 on every route.
  expectError(await startQuiz(Q.R1), 404, "QUIZ_NOT_FOUND");
  expectError(await startQuiz(Q.DRAFT), 404, "QUIZ_NOT_FOUND");
  expectError(await submitAssignment({}, A.R1), 404, "ASSIGNMENT_NOT_FOUND");
  expectError(await submitAssignment({}, A.DRAFT), 404, "ASSIGNMENT_NOT_FOUND");
  expectError(await call(routes.brief.GET, url(`/assignments/${MISSING}/brief`), { method: "GET" }, { assignmentId: MISSING }), 404, "ASSIGNMENT_NOT_FOUND");
  expectError(await call(routes.quiz.GET, url("/quizzes/not-a-uuid"), { method: "GET" }, { quizId: "not-a-uuid" }), 404, "QUIZ_NOT_FOUND");
  assert.equal(breakoutWrites(), 0);
});

test("a student in a breakout room sees only that room's activities; after moving, the old room is hidden", async () => {
  login = { role: "STUDENT", id: ST2 };
  assert.deepEqual(ok(await call(routes.assignments.GET, url("/assignments"))).assignments.map((a) => a.id), [A.R1]);
  assert.deepEqual(ok(await call(routes.quizzes.GET, url("/quizzes"))).quizzes.map((q) => q.id), [Q.R1]);
  rooms[ST2] = { type: "BREAKOUT", id: "r9" };
  assert.deepEqual(ok(await call(routes.assignments.GET, url("/assignments"))).assignments, []);
  expectError(await submitAssignment({}, A.R1), 404, "ASSIGNMENT_NOT_FOUND");
});

// ---- Assignments: list, brief -----------------------------------------------------

test("GET assignments: the success envelope, own state, no internal fields", async () => {
  const res = await call(routes.assignments.GET, url("/assignments"));
  const data = ok(res);
  assert.equal(res.headers.get("content-type").includes("application/json"), true);
  assert.deepEqual(data.room, { type: "MAIN" });
  assert.deepEqual(data.assignments.map((a) => a.id), [A.MAIN, A.CLOSED]);
  assertNoLeaks(res.body);
});

test("GET brief: the PDF as an attachment with a sanitized name; none is 404 FILE_NOT_FOUND; the path never leaks", async () => {
  expectError(await call(routes.brief.GET, url(`/assignments/${A.MAIN}/brief`), { method: "GET" }, { assignmentId: A.MAIN }), 404, "FILE_NOT_FOUND");
  const stored = await writeBreakoutPdf({ sessionId: S1, kind: "brief", activityId: A.MAIN, bytes: pdfBytes(5), nowMs: clock.getTime() });
  Object.assign(db.tables.breakoutAssignment[0], { briefFileName: "ගණිතය.pdf", briefFilePath: stored.relativePath, briefFileSize: 64 });
  const res = await call(routes.brief.GET, url(`/assignments/${A.MAIN}/brief`), { method: "GET" }, { assignmentId: A.MAIN });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition"), /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(res.headers.get("content-disposition").split("''")[1]), "ගණිතය.pdf");
  assert.deepEqual(res.body, pdfBytes(5));
  for (const [, value] of res.headers) assert.equal(value.includes(stored.relativePath) || value.includes("storage"), false);
  const list = ok(await call(routes.assignments.GET, url("/assignments")));
  assertNoLeaks(list);
});

// ---- Drafts --------------------------------------------------------------------------

test("drafts: GET empty, PUT creates then updates with the revision seen; a stale revision is 409 REVISION_CONFLICT with details", async () => {
  const draftGet = () => call(routes.draft.GET, url(`/assignments/${A.MAIN}/draft`), { method: "GET" }, { assignmentId: A.MAIN });
  assert.deepEqual(ok(await draftGet()).draft, { answerText: "", revision: 0, updatedAt: null });
  const first = await putDraft({ revision: 0, answerText: "First" });
  assert.equal(ok(first).draft.revision, 1);
  assert.equal(first.body.message, "Draft saved.");
  assert.equal(ok(await putDraft({ revision: 1, answerText: "Second" })).draft.revision, 2);
  const stale = await putDraft({ revision: 1, answerText: "Other tab" });
  expectError(stale, 409, "REVISION_CONFLICT");
  assert.deepEqual(stale.body.error.details, { answerText: "Second", revision: 2 });
  assert.equal(ok(await draftGet()).draft.answerText, "Second");
  assertNoLeaks(stale.body);
});

test("draft validation: wrong content type, malformed JSON, missing / wrong fields, too long text, a CLOSED assignment", async () => {
  const at = url(`/assignments/${A.MAIN}/draft`);
  const params = { assignmentId: A.MAIN };
  expectError(await call(routes.draft.PUT, at, { method: "PUT", headers: { "content-type": "text/plain" }, body: "{}" }, params), 400, "VALIDATION_ERROR");
  expectError(await call(routes.draft.PUT, at, json("PUT", "{not json"), params), 400, "INVALID_JSON");
  expectError(await call(routes.draft.PUT, at, json("PUT", ""), params), 400, "INVALID_JSON");
  expectError(await putDraft({ answerText: "x" }), 400, "VALIDATION_ERROR");
  expectError(await putDraft({ revision: -1, answerText: "x" }), 400, "VALIDATION_ERROR");
  expectError(await putDraft({ revision: "0", answerText: "x" }), 400, "VALIDATION_ERROR");
  expectError(await putDraft({ revision: 0, answerText: 5 }), 400, "VALIDATION_ERROR");
  expectError(await putDraft([]), 400, "VALIDATION_ERROR");
  const tooLong = await putDraft({ revision: 0, answerText: "x".repeat(50_001) });
  assert.equal(tooLong.status, 400);
  ok(await putDraft({ revision: 0, answerText: "x".repeat(50_000) }));
  expectError(await putDraft({ revision: 0, answerText: "late" }, A.CLOSED), 409, "ASSIGNMENT_CLOSED");
});

test("JSON size cap: a body over 8 MiB is 400 VALIDATION_ERROR, by Content-Length and when streamed without one", async () => {
  const at = url(`/assignments/${A.MAIN}/draft`);
  const params = { assignmentId: A.MAIN };
  const declared = await call(routes.draft.PUT, at, json("PUT", "{}", { "content-length": String(8 * 1024 * 1024 + 1) }), params);
  expectError(declared, 400, "VALIDATION_ERROR");
  const big = new TextEncoder().encode(JSON.stringify({ revision: 0, answerText: "x".repeat(8 * 1024 * 1024) }));
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < big.length; i += 1024 * 1024) controller.enqueue(big.subarray(i, i + 1024 * 1024));
      controller.close();
    },
  });
  const streamed = await call(routes.draft.PUT, at, { method: "PUT", headers: { "content-type": "application/json" }, body: stream, duplex: "half" }, params);
  expectError(streamed, 400, "VALIDATION_ERROR");
  expectError(await call(routes.attempt.PATCH, url(`/quizzes/${Q.MAIN}/attempt`), json("PATCH", "{}", { "content-length": String(8 * 1024 * 1024 + 1) }), { quizId: Q.MAIN }), 400, "VALIDATION_ERROR");
  assert.equal(db.tables.breakoutAssignmentDraft.length, 0);
});

// ---- Submissions -------------------------------------------------------------------

test("submit: text, PDF, both; 201 with the version; the file goes to the service raw and is validated there", async () => {
  const text = await submitAssignment({ answerText: "Text only" });
  const t = ok(text, 201);
  assert.equal(t.replayed, false);
  assert.equal(t.submission.version, 1);
  assert.equal(t.submission.file, null);
  assert.equal(text.body.message, "Submitted.");
  const pdfOnly = ok(await submitAssignment({ answerText: undefined, file: { pdf: pdfBytes(2), name: "My Answer.pdf" } }), 201);
  assert.equal(pdfOnly.submission.version, 2);
  assert.deepEqual(pdfOnly.submission.file, { fileName: "My Answer.pdf", fileSize: 64 });
  const both = ok(await submitAssignment({ answerText: "With file", file: { pdf: pdfBytes(3) } }), 201);
  assert.equal(both.submission.version, 3);
  assert.equal(both.submission.answerText, "With file");
  assertNoLeaks(both);
  assert.equal(db.tables.breakoutAssignmentSubmission.filter((s) => s.studentId === ST1).length, 3);
  assert.ok(db.tables.breakoutAssignmentSubmission.every((s) => s.studentId === ST1 && s.classSessionId === S1));
});

test("submit: an unused file input (empty nameless part) is no file; text-less and file-less is 400 SUBMISSION_EMPTY", async () => {
  const form = new FormData();
  form.append("idempotencyKey", newKey());
  form.append("answerText", "Text");
  form.append("file", new Blob([]), "");
  const res = await call(routes.submissions.POST, url(`/assignments/${A.MAIN}/submissions`), { method: "POST", body: form }, { assignmentId: A.MAIN });
  assert.equal(ok(res, 201).submission.file, null);
  expectError(await submitAssignment({ answerText: undefined }), 400, "SUBMISSION_EMPTY");
  expectError(await submitAssignment({ answerText: "   " }), 400, "SUBMISSION_EMPTY");
});

test("submit: an invalid PDF is 400 INVALID_PDF (wrong bytes, wrong MIME type, empty file); nothing stored", async () => {
  expectError(await submitAssignment({ file: { pdf: Buffer.from("<html>not a pdf</html>") } }), 400, "INVALID_PDF");
  expectError(await submitAssignment({ file: { pdf: pdfBytes(1), type: "text/html" } }), 400, "INVALID_PDF");
  expectError(await submitAssignment({ file: { pdf: new Uint8Array(0), name: "empty.pdf" } }), 400, "INVALID_PDF");
  assert.equal(db.tables.breakoutAssignmentSubmission.length, 0);
});

test("submit: a file over 25 MiB is 413 FILE_TOO_LARGE; a body over the multipart cap is 413 before it is parsed", async () => {
  const big = pdfBytes(1, MAX_BREAKOUT_PDF_BYTES + 1);
  expectError(await submitAssignment({ file: { pdf: big } }), 413, "FILE_TOO_LARGE");
  const declared = await call(
    routes.submissions.POST,
    url(`/assignments/${A.MAIN}/submissions`),
    { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(MAX_BREAKOUT_PDF_BYTES + 1024 * 1024 + 1) }, body: "--x--" },
    { assignmentId: A.MAIN }
  );
  expectError(declared, 413, "FILE_TOO_LARGE");
  ok(await submitAssignment({ file: { pdf: pdfBytes(1, MAX_BREAKOUT_PDF_BYTES) } }), 201);
});

test("submit form validation: JSON instead of multipart, unknown fields, repeated fields, a file as text, text as a file, a bad key", async () => {
  const at = url(`/assignments/${A.MAIN}/submissions`);
  const params = { assignmentId: A.MAIN };
  expectError(await call(routes.submissions.POST, at, json("POST", { idempotencyKey: "k", answerText: "x" }), params), 400, "VALIDATION_ERROR");
  expectError(await submitAssignment({ extra: "1" }), 400, "VALIDATION_ERROR");
  expectError(await submitAssignment({ answerText: ["a", "b"] }), 400, "VALIDATION_ERROR");
  expectError(await submitAssignment({ file: ["a", { pdf: pdfBytes() }] }), 400, "VALIDATION_ERROR");
  expectError(await submitAssignment({ file: "not a file" }), 400, "VALIDATION_ERROR");
  expectError(await submitAssignment({ answerText: { pdf: pdfBytes(), name: "x.pdf" } }), 400, "VALIDATION_ERROR");
  expectError(await submitAssignment({ idempotencyKey: { pdf: pdfBytes(), name: "k.pdf" } }), 400, "VALIDATION_ERROR");
  const missingKey = new FormData();
  missingKey.append("answerText", "x");
  expectError(await call(routes.submissions.POST, at, { method: "POST", body: missingKey }, params), 400, "VALIDATION_ERROR");
  for (const bad of ["", " ", "x".repeat(300), "bad key\n"]) expectError(await submitAssignment({ idempotencyKey: bad }), 400, "VALIDATION_ERROR");
  assert.equal(db.tables.breakoutAssignmentSubmission.length, 0);
});

test("idempotent replay: the same key returns the ORIGINAL (201, replayed: true), even with a different body or an invalid PDF", async () => {
  const first = ok(await submitAssignment({ idempotencyKey: "retry-1", answerText: "Original" }), 201);
  const again = await submitAssignment({ idempotencyKey: "retry-1", answerText: "Changed", file: { pdf: Buffer.from("garbage") } });
  const replay = ok(again, 201);
  assert.equal(replay.replayed, true);
  assert.equal(again.body.message, "Already submitted.");
  assert.equal(replay.submission.id, first.submission.id);
  assert.equal(replay.submission.answerText, "Original");
  assert.equal(db.tables.breakoutAssignmentSubmission.length, 1, "no second version");
  // Also after the assignment is closed.
  db.tables.breakoutAssignment[0].state = "CLOSED";
  assert.equal(ok(await submitAssignment({ idempotencyKey: "retry-1" }), 201).replayed, true);
  expectError(await submitAssignment({ idempotencyKey: "retry-2" }), 409, "ASSIGNMENT_CLOSED");
  assertNoLeaks(again.body);
});

test("own history and own files only: another student's submission is 404; the list is newest first without paths", async () => {
  ok(await submitAssignment({ answerText: "v1" }), 201);
  const v2 = ok(await submitAssignment({ answerText: "v2", file: { pdf: pdfBytes(4), name: "../../etc/passwd.pdf" } }), 201);
  const history = await call(routes.submissions.GET, url(`/assignments/${A.MAIN}/submissions`), { method: "GET" }, { assignmentId: A.MAIN });
  const data = ok(history);
  assert.deepEqual(data.submissions.map((s) => s.version), [2, 1]);
  assertNoLeaks(history.body);
  assert.equal(JSON.stringify(history.body).includes("/etc/"), false, "the display name is sanitized");

  const fileUrl = (subId) => url(`/assignments/${A.MAIN}/submissions/${subId}/file`);
  const file = await call(routes.submissionFile.GET, fileUrl(v2.submission.id), { method: "GET" }, { assignmentId: A.MAIN, submissionId: v2.submission.id });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "application/pdf");
  assert.deepEqual(file.body, pdfBytes(4));
  const v1 = data.submissions[1];
  expectError(await call(routes.submissionFile.GET, fileUrl(v1.id), { method: "GET" }, { assignmentId: A.MAIN, submissionId: v1.id }), 404, "FILE_NOT_FOUND");

  // ST2 (another room, same class) cannot read ST1's file, even when moved into MAIN.
  login = { role: "STUDENT", id: ST2 };
  rooms[ST2] = { type: "MAIN" };
  expectError(await call(routes.submissionFile.GET, fileUrl(v2.submission.id), { method: "GET" }, { assignmentId: A.MAIN, submissionId: v2.submission.id }), 404, "NOT_FOUND");
  assert.deepEqual(ok(await call(routes.submissions.GET, url(`/assignments/${A.MAIN}/submissions`), { method: "GET" }, { assignmentId: A.MAIN })).submissions, []);
  expectError(await call(routes.submissionFile.GET, fileUrl("not-a-uuid"), { method: "GET" }, { assignmentId: A.MAIN, submissionId: "not-a-uuid" }), 404, "NOT_FOUND");
});

// ---- Quizzes ---------------------------------------------------------------------------

test("GET quizzes and GET quiz without an attempt: metadata only (no questions, no keys), also when CLOSED", async () => {
  const list = await call(routes.quizzes.GET, url("/quizzes"));
  const data = ok(list);
  assert.deepEqual(data.quizzes.map((q) => q.id), [Q.MAIN, Q.CLOSED]);
  assert.equal(walk(list.body).keys.has("questions"), false);
  assertNoLeaks(list.body);
  for (const quizId of [Q.MAIN, Q.CLOSED]) {
    const one = await call(routes.quiz.GET, url(`/quizzes/${quizId}`), { method: "GET" }, { quizId });
    const d = ok(one);
    assert.deepEqual(d.attempt, { attemptStatus: null });
    const { keys, strings } = walk(one.body);
    assert.equal(keys.has("questions") || keys.has("prompt") || keys.has("options"), false, quizId);
    assert.equal(strings.includes("2 + 2?"), false);
    assertNoLeaks(one.body);
  }
  assert.equal(db.tables.breakoutQuizSubmission.length, 0, "reads write nothing");
});

test("start: 201 the first time, 200 after; the questions without answer keys; a CLOSED quiz without an attempt is 409 QUIZ_CLOSED", async () => {
  const first = await startQuiz();
  const d = ok(first, 201);
  assert.equal(d.started, true);
  assert.equal(d.attempt.attemptStatus, "IN_PROGRESS");
  assert.equal(d.attempt.revision, 0);
  assert.equal(d.quiz.questions.length, 2);
  assertNoLeaks(first.body);
  const again = await startQuiz();
  const d2 = ok(again, 200);
  assert.equal(d2.started, false);
  assert.equal(d2.attempt.startedAt, d.attempt.startedAt);
  assert.equal(db.tables.breakoutQuizSubmission.length, 1);
  const row = db.tables.breakoutQuizSubmission[0];
  assert.equal(row.studentId, ST1);
  assert.equal(row.classSessionId, S1);
  expectError(await startQuiz(Q.CLOSED), 409, "QUIZ_CLOSED");
  // A body is ignored by start (no fields are read from it).
  const withBody = await call(routes.attempt.POST, url(`/quizzes/${Q.MAIN}/attempt`), json("POST", { studentId: ST2 }), { quizId: Q.MAIN });
  assert.equal(ok(withBody).started, false);
  assert.equal(db.tables.breakoutQuizSubmission.length, 1);
});

test("GET quiz with an attempt: own answers, no keys, no raw grading; after CLOSE the review", async () => {
  ok(await startQuiz(), 201);
  ok(await saveAnswers({ revision: 0, answers: tfAnswer(true) }));
  const inProgress = await call(routes.quiz.GET, url(`/quizzes/${Q.MAIN}`), { method: "GET" }, { quizId: Q.MAIN });
  const d = ok(inProgress);
  assert.deepEqual(d.attempt.answers, tfAnswer(true));
  assert.equal(typeof d.serverNow, "string");
  assertNoLeaks(inProgress.body);
  ok(await submitQuiz({ revision: 1 }));
  db.tables.breakoutQuiz[0].state = "CLOSED";
  db.tables.breakoutQuiz[0].closedAt = clock;
  const closed = await call(routes.quiz.GET, url(`/quizzes/${Q.MAIN}`), { method: "GET" }, { quizId: Q.MAIN });
  const c = ok(closed);
  assert.ok(Array.isArray(c.attempt.review), "the review after CLOSED");
  assert.equal(walk(closed.body).keys.has("grading"), false);
  assertNoLeaks(closed.body, { answerKeysAllowed: true });
});

test("save answers: merged per question with the revision seen; a stale revision is 409 REVISION_CONFLICT with the current answers", async () => {
  ok(await startQuiz(), 201);
  const first = await saveAnswers({ revision: 0, answers: tfAnswer(true) });
  assert.equal(ok(first).attempt.revision, 1);
  assert.equal(first.body.message, "Answers saved.");
  const second = ok(await saveAnswers({ revision: 1, answers: { [SINGLE.id]: { kind: "single", optionId: SINGLE.options[1].id } } }));
  assert.equal(second.attempt.revision, 2);
  assert.deepEqual(Object.keys(second.attempt.answers).sort(), [SINGLE.id, TF.id].sort(), "merged");
  const stale = await saveAnswers({ revision: 1, answers: tfAnswer(false) });
  expectError(stale, 409, "REVISION_CONFLICT");
  assert.equal(stale.body.error.details.revision, 2);
  assert.deepEqual(stale.body.error.details.answers[TF.id], { kind: "true_false", value: true });
  assertNoLeaks(stale.body);
});

test("save validation: no attempt is 409 QUIZ_NOT_STARTED; bad JSON, missing / extra fields, invalid answers are 400", async () => {
  expectError(await saveAnswers({ revision: 0, answers: tfAnswer(true) }), 409, "QUIZ_NOT_STARTED");
  ok(await startQuiz(), 201);
  const at = url(`/quizzes/${Q.MAIN}/attempt`);
  expectError(await call(routes.attempt.PATCH, at, json("PATCH", "{oops"), { quizId: Q.MAIN }), 400, "INVALID_JSON");
  expectError(await call(routes.attempt.PATCH, at, { method: "PATCH", body: "{}" }, { quizId: Q.MAIN }), 400, "VALIDATION_ERROR");
  expectError(await saveAnswers({ answers: {} }), 400, "VALIDATION_ERROR");
  expectError(await saveAnswers({ revision: 0 }), 400, "VALIDATION_ERROR");
  const unknownQuestion = await saveAnswers({ revision: 0, answers: { [MISSING]: { kind: "true_false", value: true } } });
  assert.equal(unknownQuestion.status, 400, JSON.stringify(unknownQuestion.body));
  const wrongKind = await saveAnswers({ revision: 0, answers: { [TF.id]: { kind: "single", optionId: "x" } } });
  assert.equal(wrongKind.status, 400, JSON.stringify(wrongKind.body));
  assert.equal(db.tables.breakoutQuizSubmission[0].revision, 0, "nothing saved");
});

test("Q3/Q4: a save at deadline + 5 s is accepted; after it the attempt is auto-submitted and the route answers 409 QUIZ_TIME_UP with the result", async () => {
  ok(await startQuiz(), 201);
  ok(await saveAnswers({ revision: 0, answers: tfAnswer(true) }));
  const start = clock.getTime();
  clock = new Date(start + 600_000 + 5_000);
  ok(await saveAnswers({ revision: 1, answers: { [SINGLE.id]: { kind: "single", optionId: SINGLE.options[1].id } } }));
  clock = new Date(start + 600_000 + 5_001);
  const late = await saveAnswers({ revision: 2, answers: tfAnswer(false) });
  expectError(late, 409, "QUIZ_TIME_UP");
  assert.equal(late.body.error.details.attempt.attemptStatus, "AUTO_SUBMITTED");
  assert.equal(late.body.error.details.attempt.finalScore, 3, "the SAVED answers were graded, not the late ones");
  assertNoLeaks(late.body);
  const row = db.tables.breakoutQuizSubmission[0];
  assert.equal(row.attemptStatus, "AUTO_SUBMITTED", "committed");
  assert.deepEqual(row.answers[TF.id], { kind: "true_false", value: true });
});

test("submit: 200 with the score (no review before CLOSE); a repeat is replayed; a stale revision is 409; no attempt is 409 QUIZ_NOT_STARTED", async () => {
  expectError(await submitQuiz({ revision: 0 }), 409, "QUIZ_NOT_STARTED");
  ok(await startQuiz(), 201);
  ok(await saveAnswers({ revision: 0, answers: tfAnswer(true) }));
  expectError(await submitQuiz({ revision: 0 }), 409, "REVISION_CONFLICT");
  const res = await submitQuiz({ revision: 1 });
  const d = ok(res);
  assert.equal(d.replayed, false);
  assert.equal(res.body.message, "Submitted.");
  assert.equal(d.attempt.attemptStatus, "SUBMITTED");
  assert.equal(d.attempt.finalScore, 1);
  assert.equal(d.attempt.totalMarks, 3);
  assert.equal("review" in d.attempt, false);
  assertNoLeaks(res.body);
  const again = await submitQuiz({ revision: 1 });
  assert.equal(ok(again).replayed, true);
  assert.equal(again.body.message, "Already submitted.");
  expectError(await submitQuiz({ revision: "1" }), 400, "VALIDATION_ERROR");
  expectError(await submitQuiz({ revision: 1, answers: {} }), 400, "VALIDATION_ERROR");
  expectError(await saveAnswers({ revision: 1, answers: tfAnswer(false) }), 409, "QUIZ_ALREADY_SUBMITTED");
});

test("submit past the grace: 200 with attemptStatus AUTO_SUBMITTED and the saved answers graded", async () => {
  ok(await startQuiz(), 201);
  ok(await saveAnswers({ revision: 0, answers: tfAnswer(true) }));
  clock = new Date(clock.getTime() + 600_000 + 60_000);
  const late = await submitQuiz({ revision: 1 });
  const d = ok(late);
  assert.equal(d.attempt.attemptStatus, "AUTO_SUBMITTED");
  assert.equal(d.attempt.finalScore, 1);
  assertNoLeaks(late.body);
});

test("other students' attempts are never visible: ST2 moved into MAIN starts fresh, ST1's answers untouched", async () => {
  await seedAttempt(Q.MAIN, ST1, "IN_PROGRESS", tfAnswer(true));
  login = { role: "STUDENT", id: ST2 };
  rooms[ST2] = { type: "MAIN" };
  const view = ok(await call(routes.quiz.GET, url(`/quizzes/${Q.MAIN}`), { method: "GET" }, { quizId: Q.MAIN }));
  assert.deepEqual(view.attempt, { attemptStatus: null });
  expectError(await saveAnswers({ revision: 1, answers: tfAnswer(false) }), 409, "QUIZ_NOT_STARTED");
  expectError(await submitQuiz({ revision: 1 }), 409, "QUIZ_NOT_STARTED");
  const started = ok(await startQuiz(), 201);
  assert.deepEqual(started.attempt.answers, {});
  assert.deepEqual(db.tables.breakoutQuizSubmission.find((r) => r.studentId === ST1).answers, tfAnswer(true));
});

// ---- Error envelope ---------------------------------------------------------------------

test("an unexpected service failure is a generic 500 without internal details (production)", async () => {
  const savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const original = db.client.breakoutAssignment;
  db.client.breakoutAssignment = new Proxy(original, {
    get(target, key) {
      if (key === "findMany") return async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 at /srv/app/storage/secret"); };
      return target[key];
    },
  });
  try {
    const res = await call(routes.assignments.GET, url("/assignments"));
    assert.equal(res.status, 500);
    assert.equal(res.body.success, false);
    const text = JSON.stringify(res.body);
    assert.equal(text.includes("ECONNREFUSED") || text.includes("/srv/") || text.includes("10.0.0.5"), false);
    assert.equal(res.body.error.code, "INTERNAL_SERVER_ERROR");
  } finally {
    db.client.breakoutAssignment = original;
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  }
});
