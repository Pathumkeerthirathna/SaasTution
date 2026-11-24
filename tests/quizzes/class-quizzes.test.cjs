/*
 * Quizzes page, Stage 2 (backend): class-scoped quizzes.
 *  - services/class-quizzes-service.ts (scope resolution, listing, creation)
 *  - GET  /api/classes/[id]/quizzes[?lectureId=]
 *  - POST /api/classes/[id]/quizzes[?lectureId=]
 *  - the EXISTING per-quiz routes on a General Quiz (the default lecture's
 *    id, as returned above): PUT / DELETE /api/lectures/[id]/quizzes/[quizId],
 *    GET .../results
 *  - the EXISTING student routes on a General Quiz: submit and review, with
 *    the answer snapshots and locks (lib/quiz-answer-snapshot.ts, lib/quiz-locks.ts)
 *  - the EXISTING lecture-level list / create routes, unchanged (they still
 *    refuse a default lecture).
 *
 *   npm run test:quizzes
 *
 * The real routes and services run through tsx. Faked edges: Prisma (a small
 * in-memory relational store: relation filters / selects / orderBy, nested
 * creates, deleteMany with the schema's cascades and the answers' ON DELETE
 * SET NULL, raw lock statements recorded), the sessions, live events and the
 * payment-access check (recorded). The same edit / submit / review flow on
 * real PostgreSQL: tests/quizzes/quiz-history.db.test.cjs.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const APP_ORIGIN = "https://app.example.test";
process.env.APP_URL = APP_ORIGIN;

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

// ---- Fixtures --------------------------------------------------------------------------------------

const T1 = "teacher-1";
const T2 = "teacher-2";
const S1 = "student-1";
const S2 = "student-2";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C_OFF = "33333333-3333-4333-8333-333333333333";
const C_NODEFAULT = "44444444-4444-4444-8444-444444444444";
const D1 = "aaaaaaaa-0000-4000-8000-00000000000d";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L1_REMOVED = "aaaaaaaa-0000-4000-8000-000000000002";
const D2 = "bbbbbbbb-0000-4000-8000-00000000000d";
const L2 = "bbbbbbbb-0000-4000-8000-000000000001";
const D_OFF = "cccccccc-0000-4000-8000-00000000000d";
const L_NODEFAULT = "dddddddd-0000-4000-8000-000000000001";
const HOUR = 3_600_000;
const utc = (iso) => new Date(iso);

let state;
const uuid = () => crypto.randomUUID();

function seedQuiz(id, lectureId, extra = {}) {
  const quiz = { id, lectureId, title: `Quiz ${id}`, maxAttempts: null, startDateTime: new Date(Date.now() - HOUR), endDateTime: new Date(Date.now() + 24 * HOUR), status: 0, createdAt: new Date(), updatedAt: new Date(), ...extra };
  state.db.Quiz.push(quiz);
  const question = { id: `${id}-q1`, quizId: id, text: `Question of ${id}`, orderIndex: 0, answerType: "SINGLE" };
  state.db.QuizQuestion.push(question);
  state.db.QuizQuestionOption.push(
    { id: `${id}-o1`, questionId: question.id, text: "Yes", isCorrect: true, orderIndex: 0 },
    { id: `${id}-o2`, questionId: question.id, text: "No", isCorrect: false, orderIndex: 1 }
  );
}

function reset() {
  state = {
    teacher: T1,
    student: S1,
    events: [],
    raw: [],
    accessChecks: [],
    db: {
      Class: [
        { id: C1, name: "Physics", teacherId: T1, status: 0, schedule: "Mon" },
        { id: C2, name: "Chemistry", teacherId: T1, status: 0, schedule: "Tue" },
        { id: C_OFF, name: "Old", teacherId: T1, status: 1, schedule: "Wed" },
        { id: C_NODEFAULT, name: "Biology", teacherId: T1, status: 0, schedule: "Thu" },
      ],
      Lecture: [
        { id: D1, classId: C1, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), endDate: null, status: 0, isDefault: true },
        { id: L1, classId: C1, title: "Kinematics", date: utc("2026-10-10T03:30:00Z"), endDate: null, status: 0, isDefault: false },
        { id: L1_REMOVED, classId: C1, title: "Removed", date: utc("2026-10-11T03:30:00Z"), endDate: null, status: 1, isDefault: false },
        { id: D2, classId: C2, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), endDate: null, status: 0, isDefault: true },
        { id: L2, classId: C2, title: "Organic", date: utc("2026-10-12T03:30:00Z"), endDate: null, status: 0, isDefault: false },
        { id: D_OFF, classId: C_OFF, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), endDate: null, status: 0, isDefault: true },
        { id: L_NODEFAULT, classId: C_NODEFAULT, title: "Cells", date: utc("2026-10-13T03:30:00Z"), endDate: null, status: 0, isDefault: false },
      ],
      Student: [{ id: S1, name: "Nimal", registrationNumber: "R1" }, { id: S2, name: "Kamal", registrationNumber: "R2" }],
      ClassStudent: [
        { id: "cs-1", classId: C1, studentId: S1, isActive: true },
        { id: "cs-2", classId: C1, studentId: S2, isActive: true },
      ],
      Quiz: [],
      QuizQuestion: [],
      QuizQuestionOption: [],
      QuizSubmission: [],
      QuizSubmissionAnswer: [],
    },
  };
  seedQuiz("10000000-0000-4000-8000-00000000000a", D1);
  seedQuiz("10000000-0000-4000-8000-00000000000b", D1);
  seedQuiz("10000000-0000-4000-8000-00000000000c", D1, { status: 1 });
  seedQuiz("20000000-0000-4000-8000-00000000000a", L1);
  seedQuiz("30000000-0000-4000-8000-00000000000a", D2);
  seedQuiz("40000000-0000-4000-8000-00000000000a", L2);
}
reset();

// ---- A small in-memory relational Prisma ------------------------------------------------------------

/** [kind, target model, target key, local key]: one = target[targetKey] === row[localKey]; many = target[targetKey] === row[localKey]. */
const REL = {
  Class: { students: ["many", "ClassStudent", "classId", "id"], lectures: ["many", "Lecture", "classId", "id"] },
  Lecture: { class: ["one", "Class", "id", "classId"], quizzes: ["many", "Quiz", "lectureId", "id"] },
  ClassStudent: { class: ["one", "Class", "id", "classId"], student: ["one", "Student", "id", "studentId"] },
  Student: {},
  Quiz: { lecture: ["one", "Lecture", "id", "lectureId"], questions: ["many", "QuizQuestion", "quizId", "id"], submissions: ["many", "QuizSubmission", "quizId", "id"] },
  QuizQuestion: { quiz: ["one", "Quiz", "id", "quizId"], options: ["many", "QuizQuestionOption", "questionId", "id"] },
  QuizQuestionOption: {},
  QuizSubmission: { quiz: ["one", "Quiz", "id", "quizId"], student: ["one", "Student", "id", "studentId"], answers: ["many", "QuizSubmissionAnswer", "submissionId", "id"] },
  QuizSubmissionAnswer: {},
};
const DEFAULTS = {
  Quiz: () => ({ status: 0, maxAttempts: null, createdAt: new Date(), updatedAt: new Date() }),
  QuizQuestionOption: () => ({ isCorrect: false }),
  QuizSubmission: () => ({ submittedAt: new Date(), updatedAt: new Date(), attemptCount: 1 }),
};
/** The schema's ON DELETE behaviour for the rows this store deletes. */
const ON_DELETE = {
  QuizQuestion: (row) => {
    remove("QuizQuestionOption", (o) => o.questionId === row.id); // Cascade
    for (const answer of state.db.QuizSubmissionAnswer) if (answer.questionId === row.id) answer.questionId = null; // SET NULL
  },
  QuizSubmission: (row) => remove("QuizSubmissionAnswer", (a) => a.submissionId === row.id),
  Quiz: (row) => {
    remove("QuizQuestion", (q) => q.quizId === row.id);
    remove("QuizSubmission", (s) => s.quizId === row.id);
  },
};
function remove(model, predicate) {
  const doomed = state.db[model].filter(predicate);
  state.db[model] = state.db[model].filter((row) => !doomed.includes(row));
  for (const row of doomed) ON_DELETE[model]?.(row);
  return doomed.length;
}

const value = (v) => (v instanceof Date ? v.getTime() : v);
function related(model, row, key) {
  const [kind, target, targetKey, localKey] = REL[model][key];
  const rows = state.db[target].filter((t) => t[targetKey] === row[localKey]);
  return { kind, target, rows };
}
function matches(model, row, where) {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "quizId_studentId") {
      if (row.quizId !== cond.quizId || row.studentId !== cond.studentId) return false;
    } else if (REL[model][key]) {
      const { kind, target, rows } = related(model, row, key);
      if (kind === "one") {
        if (!rows[0] || !matches(target, rows[0], cond)) return false;
      } else {
        const keys = Object.keys(cond);
        if (keys.some((k) => !["some", "none", "every"].includes(k))) throw new Error(`fake: unsupported relation filter ${model}.${key}`);
        if (cond.some && !rows.some((r) => matches(target, r, cond.some))) return false;
        if (cond.none && rows.some((r) => matches(target, r, cond.none))) return false;
        if (cond.every && !rows.every((r) => matches(target, r, cond.every))) return false;
      }
    } else if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      for (const [op, operand] of Object.entries(cond)) {
        const v = value(row[key]);
        const o = value(operand);
        if (op === "in" ? !operand.includes(row[key]) : op === "gte" ? !(v >= o) : op === "lte" ? !(v <= o) : op === "not" ? v === o : (() => { throw new Error(`fake: unsupported operator ${op}`); })()) return false;
      }
    } else if (value(row[key]) !== value(cond)) {
      return false;
    }
  }
  return true;
}
function sorter(orderBy) {
  const specs = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return (a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec)[0];
      const x = value(a[key]);
      const y = value(b[key]);
      if (x < y) return dir === "desc" ? 1 : -1;
      if (x > y) return dir === "desc" ? -1 : 1;
    }
    return 0;
  };
}
function project(model, row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, spec] of Object.entries(select)) {
    if (!spec) continue;
    if (REL[model][key]) {
      const { kind, target, rows } = related(model, row, key);
      const nested = spec === true ? {} : spec;
      if (kind === "one") {
        out[key] = rows[0] ? project(target, rows[0], nested.select) : null;
      } else {
        let list = rows.filter((r) => matches(target, r, nested.where)).sort(sorter(nested.orderBy));
        if (nested.take !== undefined) list = list.slice(0, nested.take);
        out[key] = list.map((r) => project(target, r, nested.select));
      }
    } else {
      if (spec !== true) throw new Error(`fake: unsupported select ${model}.${key}`);
      out[key] = row[key];
    }
  }
  return out;
}
function create(model, data, parent = {}) {
  const row = { id: uuid(), ...(DEFAULTS[model]?.() ?? {}), ...parent };
  const nested = [];
  for (const [key, v] of Object.entries(data)) {
    if (REL[model][key]) nested.push([key, v]);
    else row[key] = v;
  }
  if (model === "QuizSubmission" && state.db.QuizSubmission.some((s) => s.quizId === row.quizId && s.studentId === row.studentId)) {
    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  }
  state.db[model].push(row);
  for (const [key, v] of nested) writeMany(model, row, key, v);
  return row;
}
function writeMany(model, row, key, ops) {
  const [, target, targetKey, localKey] = REL[model][key];
  const link = { [targetKey]: row[localKey] };
  for (const [op, arg] of Object.entries(ops)) {
    if (op === "deleteMany") remove(target, (r) => r[targetKey] === row[localKey] && matches(target, r, arg));
    else if (op === "create") (Array.isArray(arg) ? arg : [arg]).forEach((d) => create(target, d, link));
    else if (op === "createMany") arg.data.forEach((d) => create(target, d, link));
    else throw new Error(`fake: unsupported nested write ${op}`);
  }
}
function update(model, row, data) {
  for (const [key, v] of Object.entries(data)) {
    if (REL[model][key]) writeMany(model, row, key, v);
    else if (v && typeof v === "object" && "increment" in v) row[key] += v.increment;
    else row[key] = v;
  }
  return row;
}

function delegate(model) {
  const rows = (where) => state.db[model].filter((r) => matches(model, r, where));
  return {
    findMany: async ({ where, orderBy, select, take, distinct } = {}) => {
      let list = rows(where).sort(sorter(orderBy));
      if (distinct) {
        const seen = new Set();
        list = list.filter((r) => {
          const k = distinct.map((d) => r[d]).join("|");
          return seen.has(k) ? false : (seen.add(k), true);
        });
      }
      if (take !== undefined) list = list.slice(0, take);
      return list.map((r) => project(model, r, select));
    },
    findFirst: async ({ where, select, orderBy } = {}) => {
      const r = rows(where).sort(sorter(orderBy))[0];
      return r ? project(model, r, select) : null;
    },
    findUnique: async ({ where, select }) => {
      const r = rows(where)[0];
      return r ? project(model, r, select) : null;
    },
    count: async ({ where } = {}) => rows(where).length,
    create: async ({ data, select }) => project(model, create(model, data), select),
    update: async ({ where, data, select }) => {
      const r = rows(where)[0];
      if (!r) throw new Error(`fake: ${model}.update found nothing`);
      return project(model, update(model, r, data), select);
    },
    updateMany: async ({ where, data }) => {
      const list = rows(where);
      list.forEach((r) => update(model, r, data));
      return { count: list.length };
    },
    deleteMany: async ({ where } = {}) => ({ count: remove(model, (r) => matches(model, r, where)) }),
  };
}
const delegates = {
  class: delegate("Class"),
  lecture: delegate("Lecture"),
  classStudent: delegate("ClassStudent"),
  student: delegate("Student"),
  quiz: delegate("Quiz"),
  quizQuestion: delegate("QuizQuestion"),
  quizQuestionOption: delegate("QuizQuestionOption"),
  quizSubmission: delegate("QuizSubmission"),
  quizSubmissionAnswer: delegate("QuizSubmissionAnswer"),
};
delegates.lecture.create = async () => {
  throw new Error("a lecture must never be created here");
};
const tx = {
  ...delegates,
  $executeRawUnsafe: async (sql) => state.raw.push(sql),
  $executeRaw: async (strings, ...values) => state.raw.push(`${strings.join("?")} [${values.join(",")}]`),
  $queryRaw: async (strings, ...values) => {
    state.raw.push(`${strings.join("?")} [${values.join(",")}]`);
    return state.db.Quiz.some((q) => q.id === values[0]) ? [{ id: values[0] }] : [];
  },
  $queryRawUnsafe: async () => {
    throw new Error("not used");
  },
};
const prisma = { ...delegates, $transaction: async (fn) => fn(tx) };

fake("lib/prisma.ts", { prisma });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!state.teacher) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    return { teacherId: state.teacher, role: "TEACHER" };
  },
  requireStudentSession: async () => {
    if (!state.student) throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { studentId: state.student, role: "STUDENT" };
  },
  requireAppSession: async () => { throw new Error("not used"); },
  requireAdminSession: async () => { throw new Error("not used"); },
  requireTeacherSessionForbiddingOtherRoles: async () => { throw new Error("not used"); },
  getOptionalSession: async () => null,
});
fake("lib/session-events.ts", { emitStudentDataChange: (payload) => state.events.push(payload), emitLiveChange: () => {} });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
const realAccess = require(path.join(root, "services", "class-access-service.ts"));
fake("services/class-access-service.ts", {
  ...realAccess,
  assertContentAccessForStudent: async (studentId, ref) => {
    state.accessChecks.push([studentId, ref]);
  },
});

const service = require(path.join(root, "services", "class-quizzes-service.ts"));
const route = (...p) => require(path.join(root, "app", "api", ...p, "route.ts"));
const classRoute = route("classes", "[id]", "quizzes");
const lectureListRoute = route("lectures", "[id]", "quizzes");
const itemRoute = route("lectures", "[id]", "quizzes", "[quizId]");
const resultsRoute = route("lectures", "[id]", "quizzes", "[quizId]", "results");
const submitRoute = route("student", "quizzes", "[quizId]", "submit");
const reviewRoute = route("student", "quizzes", "[quizId]", "review");

test.beforeEach(() => reset());

// ---- Helpers ---------------------------------------------------------------------------------------

async function call(handler, url, params, init = {}) {
  const response = await handler(new Request(url, init), { params });
  return { status: response.status, body: await response.json() };
}
const json = (method, body, headers = {}) => ({ method, headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const classGet = (classId, query = "") => call(classRoute.GET, `${APP_ORIGIN}/api/classes/${classId}/quizzes${query}`, { id: classId });
const opt = (text, isCorrect = false) => ({ text, isCorrect });
function quizBody(overrides = {}) {
  return {
    title: "Kinematics check",
    maxAttempts: 2,
    startDateTime: new Date(Date.now() - HOUR).toISOString(),
    endDateTime: new Date(Date.now() + 24 * HOUR).toISOString(),
    questions: [
      { text: "2 + 2 = ?", answerType: "SINGLE", options: [opt("3"), opt("4", true)] },
      { text: "Primes?", answerType: "MULTIPLE", options: [opt("2", true), opt("4"), opt("5", true)] },
    ],
    ...overrides,
  };
}
const classPost = (classId, { query = "", body = quizBody(), headers = { origin: APP_ORIGIN } } = {}) =>
  call(classRoute.POST, `${APP_ORIGIN}/api/classes/${classId}/quizzes${query}`, { id: classId }, json("POST", body, headers));
const ids = (result) => result.body.data.quizzes.map((q) => q.id);
const code = (result) => result.body.error?.code;
const quizzesOn = (lectureId) => state.db.Quiz.filter((q) => q.lectureId === lectureId);

// ---- 1-5: listing, creation, sections ----------------------------------------------------------------

test("1. GET without lectureId: the class's General Quizzes (its default lecture), active only, with questions and options", async () => {
  const result = await classGet(C1);
  assert.equal(result.status, 200);
  const data = result.body.data;
  assert.equal(data.section, "GENERAL");
  assert.equal(data.label, "General Quizzes");
  assert.deepEqual(data.class, { id: C1, name: "Physics" });
  assert.deepEqual(data.lecture, { id: D1, isDefault: true, title: null, date: null });
  assert.deepEqual(ids(result), ["10000000-0000-4000-8000-00000000000b", "10000000-0000-4000-8000-00000000000a"], "the lecture API's order (id desc); removed quizzes and other lectures excluded");
  assert.deepEqual(Object.keys(data.quizzes[0]).sort(), ["endDateTime", "id", "lectureId", "maxAttempts", "questions", "startDateTime", "title"]);
  assert.deepEqual(data.quizzes[0].questions[0].options.map((o) => [o.text, o.isCorrect]), [["Yes", true], ["No", false]]);
  assert.doesNotMatch(JSON.stringify(result.body), /General Notes|2026-01-05/, "the default lecture's internal title and date are never sent");
});

test("2. POST without lectureId: created on the class's default lecture (questions, options, window, attempts), students refreshed", async () => {
  const result = await classPost(C1, { body: { ...quizBody(), lectureId: L1 } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const data = result.body.data;
  assert.equal(data.section, "GENERAL");
  assert.equal(data.label, "General Quizzes");
  assert.deepEqual(data.lecture, { id: D1, isDefault: true, title: null, date: null });
  assert.equal(data.quiz.lectureId, D1, "a lecture id in the body is ignored");
  assert.equal(data.quiz.maxAttempts, 2);
  assert.deepEqual(data.quiz.questions.map((q) => [q.text, q.orderIndex, q.answerType]), [["2 + 2 = ?", 0, "SINGLE"], ["Primes?", 1, "MULTIPLE"]]);
  assert.deepEqual(data.quiz.questions[1].options.map((o) => [o.text, o.isCorrect, o.orderIndex]), [["2", true, 0], ["4", false, 1], ["5", true, 2]]);
  assert.equal(quizzesOn(D1).length, 4);
  assert.deepEqual(state.events, [{ classId: C1 }]);
  assert.ok(ids(await classGet(C1)).includes(data.quiz.id));
});

test("3-5. lectureId of a normal lecture: its quizzes (LECTURE section, the lecture's title and date); POST creates there", async () => {
  const list = await classGet(C1, `?lectureId=${L1}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.section, "LECTURE");
  assert.equal(list.body.data.label, "Kinematics");
  assert.deepEqual(list.body.data.lecture, { id: L1, isDefault: false, title: "Kinematics", date: "2026-10-10T03:30:00.000Z" });
  assert.deepEqual(ids(list), ["20000000-0000-4000-8000-00000000000a"]);

  const created = await classPost(C1, { query: `?lectureId=${L1}` });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.section, "LECTURE");
  assert.equal(created.body.data.quiz.lectureId, L1);
  assert.ok(!ids(await classGet(C1)).includes(created.body.data.quiz.id), "not in General Quizzes");
  assert.equal((await classGet(C1, "?lectureId=%20")).body.data.section, "GENERAL", "a blank lectureId means General");
});

test("the existing quiz validation applies (window, questions, correct answers); nothing created", async () => {
  const now = Date.now();
  for (const body of [
    quizBody({ title: "Q" }),
    quizBody({ startDateTime: new Date(now + HOUR).toISOString(), endDateTime: new Date(now).toISOString() }),
    quizBody({ questions: [] }),
    quizBody({ questions: [{ text: "No right answer", answerType: "SINGLE", options: [opt("a"), opt("b")] }] }),
    quizBody({ maxAttempts: 0 }),
  ]) {
    const result = await classPost(C1, { body });
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 120));
    assert.equal(code(result), "VALIDATION_ERROR");
  }
  assert.equal((await classPost(C1, { body: "{bad" })).status, 400);
  assert.equal(quizzesOn(D1).length, 3);
});

// ---- 6-8, 10: errors and protection --------------------------------------------------------------------

test("6. a class without a default lecture: 409 DEFAULT_LECTURE_MISSING (in this page's words); its normal lectures still work", async () => {
  for (const result of [await classGet(C_NODEFAULT), await classPost(C_NODEFAULT)]) {
    assert.equal(result.status, 409);
    assert.equal(code(result), "DEFAULT_LECTURE_MISSING");
    assert.match(result.body.error.message, /General Quizzes/);
  }
  assert.equal((await classGet(C_NODEFAULT, `?lectureId=${L_NODEFAULT}`)).status, 200);
  assert.equal(state.db.Quiz.length, 6);
});

test("7. another teacher, a deactivated or an unknown class: 404 CLASS_NOT_FOUND; nothing created", async () => {
  state.teacher = T2;
  for (const result of [await classGet(C1), await classPost(C1), await classGet(C1, `?lectureId=${L1}`)]) {
    assert.equal(result.status, 404);
    assert.equal(code(result), "CLASS_NOT_FOUND");
  }
  state.teacher = T1;
  assert.equal(code(await classGet(C_OFF)), "CLASS_NOT_FOUND");
  assert.equal(code(await classGet("99999999-9999-4999-8999-999999999999")), "CLASS_NOT_FOUND");
  assert.equal(state.db.Quiz.length, 6);
});

test("8. lectureId of another class, a default lecture given explicitly, or a removed lecture: 404 LECTURE_NOT_FOUND; malformed: 400", async () => {
  for (const lectureId of [L2, D1, D2, L1_REMOVED]) {
    for (const result of [await classGet(C1, `?lectureId=${lectureId}`), await classPost(C1, { query: `?lectureId=${lectureId}` })]) {
      assert.equal(result.status, 404, lectureId);
      assert.equal(code(result), "LECTURE_NOT_FOUND");
    }
  }
  assert.equal((await classGet(C1, "?lectureId=bad%20id")).status, 400);
  assert.equal(state.db.Quiz.length, 6);
});

test("10. POST same-origin protection: missing / foreign Origin or a cross-site fetch is 403 before the session; nothing created", async () => {
  for (const headers of [{}, { origin: "https://evil.example" }, { origin: APP_ORIGIN, "sec-fetch-site": "cross-site" }]) {
    const result = await classPost(C1, { headers });
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.equal(code(result), "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  state.teacher = null;
  assert.equal((await classPost(C1, { headers: {} })).status, 403);
  assert.equal((await classPost(C1)).status, 401);
  assert.equal((await classGet(C1)).status, 401);
  assert.equal(state.db.Quiz.length, 6);
});

// ---- 9: the existing item routes on a General Quiz ---------------------------------------------------

test("9. existing item routes on a General Quiz with the lecture id this API returns: edit (under the quiz lock), results, delete; ownership kept", async () => {
  const created = (await classPost(C1)).body.data;
  const lectureId = created.lecture.id;
  const params = { id: lectureId, quizId: created.quiz.id };

  state.raw.length = 0;
  const edited = await call(itemRoute.PUT, `${APP_ORIGIN}/x`, params, json("PUT", quizBody({ title: "Renamed", questions: [{ text: "Only", answerType: "SINGLE", options: [opt("a", true), opt("b")] }] })));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.data.quiz.title, "Renamed");
  assert.equal(edited.body.data.quiz.lectureId, D1);
  assert.deepEqual(edited.body.data.quiz.questions.map((q) => q.text), ["Only"]);
  assert.ok(state.raw.some((sql) => /FOR UPDATE \[/.test(sql) && sql.includes(created.quiz.id)), "edited under the quiz's FOR UPDATE lock");

  const results = await call(resultsRoute.GET, `${APP_ORIGIN}/x`, params);
  assert.equal(results.status, 200, JSON.stringify(results.body));
  assert.equal(results.body.data.quiz.totalQuestions, 1);
  assert.equal(results.body.data.stats.totalEnrolled, 2);

  state.teacher = T2;
  assert.equal((await call(itemRoute.PUT, `${APP_ORIGIN}/x`, params, json("PUT", quizBody()))).status, 404);
  assert.equal((await call(resultsRoute.GET, `${APP_ORIGIN}/x`, params)).status, 404);
  assert.equal((await call(itemRoute.DELETE, `${APP_ORIGIN}/x`, params, { method: "DELETE" })).status, 404);
  state.teacher = T1;
  assert.equal((await call(resultsRoute.GET, `${APP_ORIGIN}/x`, { id: L1, quizId: created.quiz.id })).status, 404, "not through another lecture of the class");

  const deleted = await call(itemRoute.DELETE, `${APP_ORIGIN}/x`, params, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(state.db.Quiz.find((q) => q.id === created.quiz.id).status, 1, "soft delete, as before");
  assert.ok(!ids(await classGet(C1)).includes(created.quiz.id));
});

// ---- 11: the existing lecture-level routes, unchanged ----------------------------------------------------

test("11. the lecture-level list / create routes are unchanged: a normal lecture works; the default lecture is still refused", async () => {
  const list = await call(lectureListRoute.GET, `${APP_ORIGIN}/x`, { id: L1 });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((q) => q.id), ["20000000-0000-4000-8000-00000000000a"]);
  for (const result of [
    await call(lectureListRoute.GET, `${APP_ORIGIN}/x`, { id: D1 }),
    await call(lectureListRoute.POST, `${APP_ORIGIN}/x`, { id: D1 }, json("POST", quizBody())),
  ]) {
    assert.equal(result.status, 404);
    assert.equal(code(result), "LECTURE_NOT_FOUND");
  }
  assert.equal(quizzesOn(D1).length, 3);
  const onLecture = await call(lectureListRoute.POST, `${APP_ORIGIN}/x`, { id: L1 }, json("POST", quizBody()));
  assert.equal(onLecture.status, 201);
  assert.equal(onLecture.body.data.quiz.lectureId, L1);
});

// ---- 12: historical answers on a General Quiz ----------------------------------------------------------

test("12. a General Quiz keeps its students' history across an edit: snapshots, scores, attempts, review; new attempts use the new questions", async () => {
  const quiz = (await classPost(C1)).body.data.quiz;
  const answersFor = (q, pick) =>
    q.questions.map((question) => ({ questionId: question.id, selectedOptionIds: question.options.filter((o) => pick(question).includes(o.text)).map((o) => o.id) }));
  const correct = (question) => question.options.filter((o) => o.isCorrect).map((o) => o.text);

  // S1: all correct; S2: wrong on the second question. Through the real student submit route.
  state.raw.length = 0;
  state.student = S1;
  const s1 = await call(submitRoute.POST, `${APP_ORIGIN}/x`, { quizId: quiz.id }, json("POST", { answers: answersFor(quiz, correct) }));
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  assert.ok(state.raw.some((sql) => /FOR SHARE \[/.test(sql)) && state.raw.some((sql) => sql.includes(`quiz-attempt:${quiz.id}:${S1}`)), "submitted under the quiz and attempt locks");
  assert.deepEqual(state.accessChecks.at(-1), [S1, { quizId: quiz.id }], "the payment-access check still runs");
  state.student = S2;
  const s2 = await call(submitRoute.POST, `${APP_ORIGIN}/x`, { quizId: quiz.id }, json("POST", { answers: answersFor(quiz, (q) => (q.text === "Primes?" ? ["4"] : correct(q))) }));
  assert.deepEqual([s2.status, s2.body.data.submission.score], [201, 1]);
  const reviewBefore = (await call(reviewRoute.GET, `${APP_ORIGIN}/x`, { quizId: quiz.id })).body.data;

  // The teacher edits the General Quiz through the existing item route with the default lecture's id.
  state.teacher = T1;
  const edited = await call(itemRoute.PUT, `${APP_ORIGIN}/x`, { id: D1, quizId: quiz.id }, json("PUT", quizBody({ questions: [{ text: "New question", answerType: "SINGLE", options: [opt("x", true), opt("y")] }] })));
  assert.equal(edited.status, 200);

  // History: both submissions, their answers and snapshots are intact; the replaced questions are only unlinked.
  for (const [student, score] of [[S1, 2], [S2, 1]]) {
    const submission = state.db.QuizSubmission.find((s) => s.quizId === quiz.id && s.studentId === student);
    assert.deepEqual([submission.score, submission.totalQuestions, submission.attemptCount], [score, 2, 1], student);
    const answers = state.db.QuizSubmissionAnswer.filter((a) => a.submissionId === submission.id);
    assert.deepEqual(answers.map((a) => [a.questionText, a.questionId]).sort(), [["2 + 2 = ?", null], ["Primes?", null]], student);
  }
  const reviewAfter = (await call(reviewRoute.GET, `${APP_ORIGIN}/x`, { quizId: quiz.id })).body.data;
  assert.deepEqual(reviewAfter.submission, reviewBefore.submission);
  assert.deepEqual(
    reviewAfter.quiz.questions.map(({ id, ...rest }) => rest),
    reviewBefore.quiz.questions.map(({ id, ...rest }) => rest),
    "S2 reviews the questions and options exactly as answered"
  );
  assert.deepEqual(reviewAfter.quiz.questions.map((q) => [q.text, q.isCorrect]), [["2 + 2 = ?", true], ["Primes?", false]]);

  // A new attempt uses the new questions (and still counts towards maxAttempts = 2).
  const current = edited.body.data.quiz;
  state.student = S1;
  const second = await call(submitRoute.POST, `${APP_ORIGIN}/x`, { quizId: quiz.id }, json("POST", { answers: answersFor(current, correct) }));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.deepEqual([second.body.data.submission.score, second.body.data.submission.totalQuestions, second.body.data.submission.attemptCount], [1, 1, 2]);
  assert.deepEqual((await call(reviewRoute.GET, `${APP_ORIGIN}/x`, { quizId: quiz.id })).body.data.quiz.questions.map((q) => q.text), ["New question"]);
  const third = await call(submitRoute.POST, `${APP_ORIGIN}/x`, { quizId: quiz.id }, json("POST", { answers: answersFor(current, correct) }));
  assert.deepEqual([third.status, code(third)], [403, "MAX_ATTEMPTS_REACHED"]);
  // S2's history is untouched by S1's new attempt.
  state.student = S2;
  assert.deepEqual((await call(reviewRoute.GET, `${APP_ORIGIN}/x`, { quizId: quiz.id })).body.data.quiz.questions.map((q) => q.text), ["2 + 2 = ?", "Primes?"]);
});

test("source: the class API validates with the lecture API's schema, resolves through the shared resolver, and adds no item routes", () => {
  const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
  const routeSrc = read("app", "api", "classes", "[id]", "quizzes", "route.ts");
  assert.match(routeSrc, /createQuizSchema\.safeParse\(body\)/);
  assert.ok(routeSrc.indexOf("checkSameOriginRequest(request)") < routeSrc.indexOf("requireTeacherSession()", routeSrc.indexOf("export async function POST")), "origin before session");
  const svc = read("services", "class-quizzes-service.ts");
  assert.match(svc, /resolveClassLectureForTeacher\(teacherId, classId, lectureId\)/);
  assert.doesNotMatch(svc, /prisma\./, "no queries of its own: the existing lecture-service functions");
  assert.deepEqual(fs.readdirSync(path.join(root, "app", "api", "classes", "[id]", "quizzes")), ["route.ts"]);
  assert.equal(service.GENERAL_QUIZZES_LABEL, "General Quizzes");
});
