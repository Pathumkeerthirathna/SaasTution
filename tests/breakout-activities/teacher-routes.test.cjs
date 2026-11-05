/*
 * Teacher breakout activity routes (app/api/sessions/[id]/breakout-activities/**):
 * the feature flag (404 before authentication), teacher authentication
 * (401), ownership (another teacher's session 404), id and body validation,
 * create / publish / edit / close / delete of assignments and quizzes,
 * grading overrides, PDF upload and download (invalid, oversized), status
 * codes and the error envelope, and that responses never leak file paths,
 * idempotency keys or other internal fields.
 *
 * Real route modules and services. lib/prisma.ts is an in-memory fake,
 * lib/server-clock.ts a fixed clock, lib/auth-session.ts a fake login. The
 * working directory (where uploads are stored) and ERROR_LOG_DIR point to a
 * temporary folder, removed afterwards. No database is contacted.
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
const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "breakout-routes-")));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");

require("tsx/cjs/api").register();

const { createFakeBreakoutDb } = require("./helpers/fake-breakout-db.cjs");

// ---- Fakes ------------------------------------------------------------------

let db;
let clock = new Date("2026-11-05T10:00:00.000Z");
let login = null; // { role: "TEACHER" | "STUDENT", id }
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
  requireTeacherSession: async () => {
    authCalls += 1;
    if (!login) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    if (login.role !== "TEACHER") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { teacherId: login.id, email: "t@example.com", name: "Teacher", role: "TEACHER" };
  },
  requireStudentSession: async () => {
    throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
  },
});

const base = path.join(root, "app/api/sessions/[id]/breakout-activities");
const routes = {
  list: require(path.join(base, "route.ts")),
  assignments: require(path.join(base, "assignments/route.ts")),
  assignment: require(path.join(base, "assignments/[assignmentId]/route.ts")),
  brief: require(path.join(base, "assignments/[assignmentId]/brief/route.ts")),
  submissions: require(path.join(base, "assignments/[assignmentId]/submissions/route.ts")),
  submissionFile: require(path.join(base, "assignments/[assignmentId]/submissions/[submissionId]/file/route.ts")),
  quizzes: require(path.join(base, "quizzes/route.ts")),
  quiz: require(path.join(base, "quizzes/[quizId]/route.ts")),
  attempts: require(path.join(base, "quizzes/[quizId]/submissions/route.ts")),
  grading: require(path.join(base, "quizzes/[quizId]/submissions/[submissionId]/grading/route.ts")),
};
const { writeBreakoutPdf } = require(path.join(root, "lib/breakout-activities/storage.ts"));

const T1 = "teacher-1";
const T2 = "teacher-2";
const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";
const S2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const ST1 = "a1111111-1111-4111-8111-111111111111";
const MISSING = "f0000000-0000-4000-8000-000000000000";
const QUESTIONS = [
  { kind: "true_false", prompt: "Is 2 even?", marks: 2, correct: true },
  { kind: "single", prompt: "2 + 2?", marks: 1, options: [{ text: "3" }, { text: "4", correct: true }] },
];

const savedCwd = process.cwd();
test.before(() => process.chdir(sandbox));
test.after(() => {
  process.chdir(savedCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});
test.beforeEach(() => {
  clock = new Date("2026-11-05T10:00:00.000Z");
  login = { role: "TEACHER", id: T1 };
  authCalls = 0;
  process.env.BREAKOUT_ACTIVITIES_ENABLED = "true";
  db = createFakeBreakoutDb();
  db.tables.class.push({ id: "class-1", teacherId: T1 }, { id: "class-2", teacherId: T2 });
  db.tables.classSession.push({ id: S1, classId: "class-1", isActive: true }, { id: S2, classId: "class-2", isActive: true });
  db.tables.student.push({ id: ST1, name: "Nimal", registrationNumber: "R-1" });
});
test.afterEach(() => {
  delete process.env.BREAKOUT_ACTIVITIES_ENABLED;
});

// ---- Request helpers ------------------------------------------------------------

const url = (p = "", query = "") => `http://localhost/api/sessions/${S1}/breakout-activities${p}${query}`;
const json = (method, body, extraHeaders = {}) => ({
  method,
  headers: { "content-type": "application/json", ...extraHeaders },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
function multipart(method, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value && value.pdf) form.append(key, new Blob([value.pdf], { type: value.type ?? "application/pdf" }), value.name ?? "brief.pdf");
    else form.append(key, value);
  }
  return { method, body: form };
}
async function call(handler, href, init = { method: "GET" }, params = {}) {
  const response = await handler(new Request(href, init), { params: { id: S1, ...params } });
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
const createAssignment = (fields = {}) =>
  call(
    routes.assignments.POST,
    url("/assignments"),
    multipart("POST", { title: "Essay", instructions: "Write", targets: '[{"type":"MAIN"}]', publish: "false", ...fields })
  );
const createQuiz = (body = {}) =>
  call(routes.quizzes.POST, url("/quizzes"), json("POST", { title: "Quiz", questions: QUESTIONS, targets: [{ type: "MAIN" }], publish: true, ...body }));

/** Every key at any depth, plus every string value (for leak checks). */
function walk(value, keys = new Set(), strings = []) {
  if (Array.isArray(value)) value.forEach((v) => walk(v, keys, strings));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      walk(v, keys, strings);
    }
  }
  else if (typeof value === "string") strings.push(value);
  return { keys, strings };
}
function assertNoLeaks(body) {
  const { keys, strings } = walk(body);
  for (const k of ["briefFilePath", "filePath", "idempotencyKey", "classSessionId", "status"]) assert.equal(keys.has(k), false, `leaked key ${k}`);
  assert.equal(strings.some((s) => s.includes("breakout-activities/")), false, "leaked a stored path");
}

// ---- Every route ------------------------------------------------------------

const EVERY = [
  ["GET list", routes.list.GET, url(), { method: "GET" }, {}],
  ["POST assignments", routes.assignments.POST, url("/assignments"), { method: "POST" }, {}],
  ["PATCH assignment", routes.assignment.PATCH, url(`/assignments/${MISSING}`), json("PATCH", { action: "publish" }), { assignmentId: MISSING }],
  ["DELETE assignment", routes.assignment.DELETE, url(`/assignments/${MISSING}`), { method: "DELETE" }, { assignmentId: MISSING }],
  ["GET brief", routes.brief.GET, url(`/assignments/${MISSING}/brief`), { method: "GET" }, { assignmentId: MISSING }],
  ["GET submissions", routes.submissions.GET, url(`/assignments/${MISSING}/submissions`), { method: "GET" }, { assignmentId: MISSING }],
  ["GET submission file", routes.submissionFile.GET, url(`/assignments/${MISSING}/submissions/${MISSING}/file`), { method: "GET" }, { assignmentId: MISSING, submissionId: MISSING }],
  ["POST quizzes", routes.quizzes.POST, url("/quizzes"), json("POST", {}), {}],
  ["GET quiz", routes.quiz.GET, url(`/quizzes/${MISSING}`), { method: "GET" }, { quizId: MISSING }],
  ["PATCH quiz", routes.quiz.PATCH, url(`/quizzes/${MISSING}`), json("PATCH", { action: "close" }), { quizId: MISSING }],
  ["DELETE quiz", routes.quiz.DELETE, url(`/quizzes/${MISSING}`), { method: "DELETE" }, { quizId: MISSING }],
  ["GET attempts", routes.attempts.GET, url(`/quizzes/${MISSING}/submissions`), { method: "GET" }, { quizId: MISSING }],
  ["PATCH grading", routes.grading.PATCH, url(`/quizzes/${MISSING}/submissions/${MISSING}/grading`), json("PATCH", { overrides: [] }), { quizId: MISSING, submissionId: MISSING }],
];

test("route config: nodejs runtime and force-dynamic on every route file", () => {
  for (const [name, mod] of Object.entries(routes)) {
    assert.equal(mod.runtime, "nodejs", name);
    assert.equal(mod.dynamic, "force-dynamic", name);
  }
});

test("feature flag off: every route is 404 NOT_FOUND, before authentication, revealing nothing", async () => {
  for (const value of [undefined, "", "false", "0"]) {
    if (value === undefined) delete process.env.BREAKOUT_ACTIVITIES_ENABLED;
    else process.env.BREAKOUT_ACTIVITIES_ENABLED = value;
    for (const [name, handler, href, init, params] of EVERY) {
      login = null;
      const res = await call(handler, href, init, params);
      expectError(res, 404, "NOT_FOUND");
      assert.doesNotMatch(JSON.stringify(res.body), /breakout|disabled|flag/i, name);
    }
  }
  assert.equal(authCalls, 0, "authentication is never attempted");
});

test("not logged in, or logged in as a student: 401 on every route", async () => {
  for (const who of [null, { role: "STUDENT", id: ST1 }]) {
    login = who;
    for (const [name, handler, href, init, params] of EVERY) {
      const res = await call(handler, href, init, params);
      expectError(res, 401, "UNAUTHORIZED");
      assert.ok(name);
    }
  }
  assert.equal(db.transactions.length, 0, "nothing reached a transaction");
});

test("another teacher's session: 404 SESSION_NOT_FOUND on every route; invalid session id: 404", async () => {
  login = { role: "TEACHER", id: T2 };
  for (const [name, handler, href, init, params] of EVERY) {
    if (name === "POST assignments") continue; // needs a valid form first (below)
    const res = await call(handler, href, init, params);
    if (name === "POST quizzes" || name === "PATCH grading") {
      // An invalid body is refused before the service, the same for every
      // session: it reveals nothing about this one.
      expectError(res, 400, "VALIDATION_ERROR");
    } else {
      expectError(res, 404, "SESSION_NOT_FOUND");
    }
  }
  login = { role: "TEACHER", id: T2 };
  expectError(await createAssignment(), 404, "SESSION_NOT_FOUND");
  expectError(await createQuiz(), 404, "SESSION_NOT_FOUND");
  login = { role: "TEACHER", id: T1 };
  expectError(await call(routes.list.GET, url(), { method: "GET" }, { id: "not-a-uuid" }), 404, "SESSION_NOT_FOUND");
  assert.equal(db.tables.breakoutAssignment.length + db.tables.breakoutQuiz.length, 0);
});

// ---- Assignments --------------------------------------------------------------

test("create assignment: 201 with the group, teacher from the login (never the body), no leaks", async () => {
  const res = await createAssignment({ brief: { pdf: pdfBytes(3), name: "Week 1 brief.pdf" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  const [assignment] = res.body.data.assignments;
  assert.equal(assignment.target.name, "Main room");
  assert.equal(assignment.state, "DRAFT");
  assert.deepEqual(assignment.brief, { fileName: "Week 1 brief.pdf", fileSize: 64 });
  assert.equal(db.tables.breakoutAssignment[0].teacherId, T1);
  assertNoLeaks(res.body);
  const stored = db.tables.breakoutAssignment[0].briefFilePath;
  assert.ok(fs.existsSync(path.join(sandbox, "storage", ...stored.split("/"))), "stored under <cwd>/storage");
});

test("create assignment: validation (400) and room fail-closed (409 ROOM_UNKNOWN), nothing created", async () => {
  const cases = [
    [{ publish: "yes" }, 400, "VALIDATION_ERROR"],
    [{ targets: "not json" }, 400, "VALIDATION_ERROR"],
    [{ targets: "[]" }, 400, "VALIDATION_ERROR"],
    [{ title: "" }, 400, "VALIDATION_ERROR"],
    [{ instructions: "" }, 400, "VALIDATION_ERROR"], // no brief either
    [{ teacherId: T2 }, 400, "VALIDATION_ERROR"], // unknown field: the teacher never comes from the body
    [{ targets: '[{"type":"MAIN"},{"type":"BREAKOUT","id":"room-1"}]' }, 409, "ROOM_UNKNOWN"],
  ];
  for (const [fields, status, code] of cases) expectError(await createAssignment(fields), status, code);
  const notMultipart = await call(routes.assignments.POST, url("/assignments"), json("POST", { title: "x" }));
  expectError(notMultipart, 400, "VALIDATION_ERROR");
  assert.equal(db.tables.breakoutAssignment.length, 0);
});

test("create assignment: invalid PDF 400 INVALID_PDF; oversized body 413 FILE_TOO_LARGE before it is read", async () => {
  expectError(await createAssignment({ brief: { pdf: Buffer.from("<html>no</html>"), name: "x.pdf" } }), 400, "INVALID_PDF");
  expectError(await createAssignment({ brief: { pdf: pdfBytes(), type: "text/plain", name: "x.pdf" } }), 400, "INVALID_PDF");
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 });
  const huge = await call(routes.assignments.POST, url("/assignments"), {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(30 * 1024 * 1024) },
    body: stream,
    duplex: "half",
  });
  expectError(huge, 413, "FILE_TOO_LARGE");
  assert.equal(pulled, 0, "refused from Content-Length alone");
  assert.equal(db.tables.breakoutAssignment.length, 0);
});

test("assignment lifecycle over HTTP: publish, repeat (no change), close, edit refused, delete refused", async () => {
  const id = (await createAssignment()).body.data.assignments[0].id;
  const patch = (body) => call(routes.assignment.PATCH, url(`/assignments/${id}`), json("PATCH", body), { assignmentId: id });
  const published = await patch({ action: "publish" });
  assert.equal(published.status, 200);
  assert.equal(published.body.data.assignment.state, "PUBLISHED");
  assert.equal(published.body.data.changed, true);
  assert.equal((await patch({ action: "publish" })).body.data.changed, false);
  expectError(await patch({ title: "x" }), 409, "ACTIVITY_NOT_DRAFT");
  expectError(await call(routes.assignment.DELETE, url(`/assignments/${id}`), { method: "DELETE" }, { assignmentId: id }), 409, "ACTIVITY_NOT_DRAFT");
  assert.equal((await patch({ action: "close" })).body.data.assignment.state, "CLOSED");
  expectError(await patch({ action: "publish" }), 409, "ASSIGNMENT_CLOSED");
  expectError(await patch({ title: "x" }), 409, "ASSIGNMENT_CLOSED");
});

test("assignment PATCH validation: action XOR edits, strict, JSON only; malformed JSON 400 INVALID_JSON", async () => {
  const id = (await createAssignment()).body.data.assignments[0].id;
  const patch = (init) => call(routes.assignment.PATCH, url(`/assignments/${id}`), init, { assignmentId: id });
  expectError(await patch(json("PATCH", { action: "close", title: "x" })), 400, "VALIDATION_ERROR");
  expectError(await patch(json("PATCH", { action: "reopen" })), 400, "VALIDATION_ERROR");
  expectError(await patch(json("PATCH", {})), 400, "VALIDATION_ERROR");
  expectError(await patch(json("PATCH", { state: "CLOSED" })), 400, "VALIDATION_ERROR");
  expectError(await patch(json("PATCH", "{nope")), 400, "INVALID_JSON");
  expectError(await patch({ method: "PATCH", headers: { "content-type": "text/plain" }, body: "x" }), 400, "VALIDATION_ERROR");
  expectError(await patch(json("PATCH", { action: "close" })), 409, "ACTIVITY_NOT_PUBLISHED");
  const edited = await patch(json("PATCH", { title: "  New  " }));
  assert.equal(edited.body.data.assignment.title, "New");
  expectError(await call(routes.assignment.PATCH, url("/assignments/bad"), json("PATCH", { action: "publish" }), { assignmentId: "bad" }), 404, "ASSIGNMENT_NOT_FOUND");
});

test("brief replacement (multipart PATCH) and download; replacement without a file is 400", async () => {
  const id = (await createAssignment({ brief: { pdf: pdfBytes(1) } })).body.data.assignments[0].id;
  const replace = (fields) => call(routes.assignment.PATCH, url(`/assignments/${id}`), multipart("PATCH", fields), { assignmentId: id });
  expectError(await replace({ title: "Only a title" }), 400, "VALIDATION_ERROR");
  expectError(await replace({ brief: { pdf: Buffer.from("zip"), name: "x.pdf" } }), 400, "INVALID_PDF");
  expectError(await replace({ brief: { pdf: pdfBytes(), name: "x.pdf" }, publish: "true" }), 400, "VALIDATION_ERROR");
  const ok = await replace({ brief: { pdf: pdfBytes(9), name: "ගණිතය.pdf" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assertNoLeaks(ok.body);

  const download = await call(routes.brief.GET, url(`/assignments/${id}/brief`), { method: "GET" }, { assignmentId: id });
  assert.equal(download.status, 200);
  assert.equal(download.body[20], 9, "the replacement's bytes");
  assert.equal(download.headers.get("content-type"), "application/pdf");
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  assert.match(download.headers.get("content-disposition"), /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(download.headers.get("content-disposition").split("''")[1]), "ගණිතය.pdf");

  const noBrief = (await createAssignment()).body.data.assignments[0].id;
  expectError(await call(routes.brief.GET, url(`/assignments/${noBrief}/brief`), { method: "GET" }, { assignmentId: noBrief }), 404, "FILE_NOT_FOUND");
});

test("delete DRAFT: 200, then 404; listed no more", async () => {
  const id = (await createAssignment()).body.data.assignments[0].id;
  const del = () => call(routes.assignment.DELETE, url(`/assignments/${id}`), { method: "DELETE" }, { assignmentId: id });
  const first = await del();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data, { id, status: 1 });
  expectError(await del(), 404, "ASSIGNMENT_NOT_FOUND");
  const list = await call(routes.list.GET, url());
  assert.deepEqual(list.body.data.assignments, []);
});

test("submissions and submission file: scoped, studentId validated, no keys or paths in the response", async () => {
  const id = (await createAssignment()).body.data.assignments[0].id;
  const stored = await writeBreakoutPdf({ sessionId: S1, kind: "submission", activityId: id, bytes: pdfBytes(7), nowMs: clock.getTime() });
  const subId = "c0000000-0000-4000-8000-000000000001";
  db.tables.breakoutAssignmentSubmission.push({
    id: subId, assignmentId: id, classSessionId: S1, studentId: ST1, version: 1, isLatest: true, answerText: "Answer",
    fileName: "answer.pdf", filePath: stored.relativePath, fileSize: 64, idempotencyKey: "secret-idem-key", submittedAt: clock,
  });
  const list = await call(routes.submissions.GET, url(`/assignments/${id}/submissions`), { method: "GET" }, { assignmentId: id });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.submissions[0].versionCount, 1);
  assert.ok(!JSON.stringify(list.body).includes("secret-idem-key"));
  assertNoLeaks(list.body);
  const history = await call(routes.submissions.GET, url(`/assignments/${id}/submissions`, `?studentId=${ST1}`), { method: "GET" }, { assignmentId: id });
  assert.equal(history.body.data.submissions.length, 1);
  expectError(await call(routes.submissions.GET, url(`/assignments/${id}/submissions`, "?studentId=x"), { method: "GET" }, { assignmentId: id }), 404, "NOT_FOUND");
  expectError(
    await call(routes.submissions.GET, url(`/assignments/${id}/submissions`, `?studentId=${ST1}&studentId=${ST1}`), { method: "GET" }, { assignmentId: id }),
    400,
    "VALIDATION_ERROR"
  );

  const file = await call(routes.submissionFile.GET, url(`/assignments/${id}/submissions/${subId}/file`), { method: "GET" }, { assignmentId: id, submissionId: subId });
  assert.equal(file.status, 200);
  assert.equal(file.body[20], 7);
  const other = (await createAssignment()).body.data.assignments[0].id;
  expectError(
    await call(routes.submissionFile.GET, url(`/assignments/${other}/submissions/${subId}/file`), { method: "GET" }, { assignmentId: other, submissionId: subId }),
    404,
    "NOT_FOUND"
  );
});

// ---- Quizzes ------------------------------------------------------------------

test("create quiz: 201 without answer keys; GET for the teacher includes them; list excludes them", async () => {
  const res = await createQuiz();
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const quiz = res.body.data.quizzes[0];
  assert.equal(quiz.totalMarks, 3);
  assert.equal(quiz.state, "PUBLISHED");
  assert.equal("questions" in quiz, false);
  const full = await call(routes.quiz.GET, url(`/quizzes/${quiz.id}`), { method: "GET" }, { quizId: quiz.id });
  assert.equal(full.body.data.quiz.questions.questions[0].correct, true);
  const list = await call(routes.list.GET, url());
  assert.equal(list.body.data.quizzes.length, 1);
  assert.equal("questions" in list.body.data.quizzes[0], false);
  assertNoLeaks(list.body);
});

test("create quiz: validation 400, malformed JSON 400 INVALID_JSON, oversized JSON 400, BREAKOUT 409", async () => {
  expectError(await createQuiz({ questions: [] }), 400, "VALIDATION_ERROR");
  expectError(await createQuiz({ timeLimitSeconds: 30 }), 400, "VALIDATION_ERROR");
  expectError(await createQuiz({ totalMarks: 999 }), 400, "VALIDATION_ERROR");
  expectError(await createQuiz({ targets: [{ type: "BREAKOUT", id: "r1" }] }), 409, "ROOM_UNKNOWN");
  expectError(await call(routes.quizzes.POST, url("/quizzes"), json("POST", "{oops")), 400, "INVALID_JSON");
  const tooBig = await call(routes.quizzes.POST, url("/quizzes"), json("POST", "{}", { "content-length": String(9 * 1024 * 1024) }));
  expectError(tooBig, 400, "VALIDATION_ERROR");
  assert.equal(db.tables.breakoutQuiz.length, 0);
});

test("quiz close over HTTP auto-submits IN_PROGRESS attempts; edits / delete need a DRAFT", async () => {
  const quizId = (await createQuiz()).body.data.quizzes[0].id;
  db.tables.breakoutQuizSubmission.push({
    id: "e0000000-0000-4000-8000-000000000001", quizId, classSessionId: S1, studentId: ST1, attemptStatus: "IN_PROGRESS",
    answers: {}, revision: 0, startedAt: clock, deadlineAt: null, lastSavedAt: null, submittedAt: null,
    grading: null, autoScore: null, finalScore: null, overriddenAt: null,
  });
  const patch = (body) => call(routes.quiz.PATCH, url(`/quizzes/${quizId}`), json("PATCH", body), { quizId });
  expectError(await patch({ title: "x" }), 409, "ACTIVITY_NOT_DRAFT");
  const closed = await patch({ action: "close" });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.data.autoSubmitted, 1);
  assert.equal(db.tables.breakoutQuizSubmission[0].attemptStatus, "AUTO_SUBMITTED");
  expectError(await call(routes.quiz.DELETE, url(`/quizzes/${quizId}`), { method: "DELETE" }, { quizId }), 409, "QUIZ_CLOSED");

  const draft = (await createQuiz({ publish: false })).body.data.quizzes[0].id;
  const edited = await call(routes.quiz.PATCH, url(`/quizzes/${draft}`), json("PATCH", { instructions: "", timeLimitSeconds: 120 }), { quizId: draft });
  assert.equal(edited.body.data.quiz.timeLimitSeconds, 120);
  assert.equal(edited.body.data.quiz.instructions, null);
  assert.equal((await call(routes.quiz.DELETE, url(`/quizzes/${draft}`), { method: "DELETE" }, { quizId: draft })).status, 200);
});

test("grading override over HTTP: 200; IN_PROGRESS 409 QUIZ_NOT_SUBMITTED; invalid body 400; corrupt stored grading 500", async () => {
  const quizId = (await createQuiz()).body.data.quizzes[0].id;
  const def = db.tables.breakoutQuiz[0].questions;
  const add = (id, status, grading) =>
    db.tables.breakoutQuizSubmission.push({
      id, quizId, classSessionId: S1, studentId: ST1, attemptStatus: status, answers: {}, revision: 1, startedAt: clock,
      deadlineAt: null, lastSavedAt: null, submittedAt: clock, grading, autoScore: 0, finalScore: 0, overriddenAt: null,
    });
  const grading = { schemaVersion: 1, questions: Object.fromEntries(def.questions.map((q) => [q.id, { auto: 0, result: "unanswered" }])) };
  add("e0000000-0000-4000-8000-000000000001", "SUBMITTED", grading);
  add("e0000000-0000-4000-8000-000000000002", "IN_PROGRESS", null);
  add("e0000000-0000-4000-8000-000000000003", "SUBMITTED", { schemaVersion: 7 });
  const grade = (submissionId, body) =>
    call(routes.grading.PATCH, url(`/quizzes/${quizId}/submissions/${submissionId}/grading`), json("PATCH", body), { quizId, submissionId });

  const ok = await grade("e0000000-0000-4000-8000-000000000001", { overrides: [{ questionId: def.questions[0].id, marks: 2 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.finalScore, 2);
  assert.equal(ok.body.data.autoScore, 0);
  expectError(await grade("e0000000-0000-4000-8000-000000000002", { overrides: [{ questionId: def.questions[0].id, marks: 1 }] }), 409, "QUIZ_NOT_SUBMITTED");
  expectError(await grade("e0000000-0000-4000-8000-000000000001", { overrides: [{ questionId: def.questions[0].id, marks: 5 }] }), 400, "OVERRIDE_OUT_OF_RANGE");
  expectError(await grade("e0000000-0000-4000-8000-000000000001", { overrides: [] }), 400, "VALIDATION_ERROR");
  expectError(await grade("e0000000-0000-4000-8000-000000000001", { overrides: [{ questionId: "__proto__", marks: 1 }] }), 400, "VALIDATION_ERROR");
  expectError(await grade(MISSING, { overrides: [{ questionId: def.questions[0].id, marks: 1 }] }), 404, "NOT_FOUND");

  const saved = console.error;
  console.error = () => {};
  try {
    const corrupt = await grade("e0000000-0000-4000-8000-000000000003", { overrides: [{ questionId: def.questions[0].id, marks: 1 }] });
    expectError(corrupt, 500, "INTERNAL_SERVER_ERROR");
  } finally {
    console.error = saved;
  }

  const attempts = await call(routes.attempts.GET, url(`/quizzes/${quizId}/submissions`), { method: "GET" }, { quizId });
  assert.equal(attempts.status, 200);
  assert.equal(attempts.body.data.attempts.length, 3);
  assertNoLeaks(attempts.body);
});

test("ended session: writes 409 SESSION_NOT_ACTIVE, reads still 200", async () => {
  const id = (await createAssignment()).body.data.assignments[0].id;
  db.tables.classSession.find((s) => s.id === S1).isActive = false;
  expectError(await createAssignment(), 409, "SESSION_NOT_ACTIVE");
  expectError(await call(routes.assignment.PATCH, url(`/assignments/${id}`), json("PATCH", { action: "publish" }), { assignmentId: id }), 409, "SESSION_NOT_ACTIVE");
  assert.equal((await call(routes.list.GET, url())).status, 200);
});
