/*
 * Historical quiz attempts survive quiz edits: against a REAL, THROWAWAY
 * PostgreSQL. The real routes and services run (teacher edit:
 * services/lecture-service.ts updateQuizForTeacher and its route; student
 * submit / quiz / review routes; teacher results route) with the real
 * Prisma client, the real foreign keys (ON DELETE SET NULL), JSONB snapshots,
 * row locks and advisory locks. Faked: the sessions and live events only.
 *
 *   QUIZ_TEST_DATABASE_URL=postgresql://slc_test@127.0.0.1:55436/slc_quiz_history_test npm run test:quizzes-db
 *
 * The database must contain the project schema WITH migration
 * 20261130120000_add_quiz_answer_snapshots, and the Prisma client must be
 * generated from it (or QUIZ_TEST_PRISMA_CLIENT = the folder of a client
 * generated from it). The migration's backfill itself is tested in a
 * temporary schema, rolled back. Safety: SKIPPED unless QUIZ_TEST_DATABASE_URL
 * is set; refuses any host other than localhost / 127.0.0.1 and any database
 * whose name does not contain "test"; the project's .env database is never
 * used. Every row it creates has the "qhtest-" prefix (quizzes: deleted by
 * their lecture) and is deleted afterwards.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const url = process.env.QUIZ_TEST_DATABASE_URL;
let skip = "set QUIZ_TEST_DATABASE_URL to a throwaway local database to run these tests";
if (url) {
  const target = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Refusing to run: QUIZ_TEST_DATABASE_URL must point at localhost.");
  if (!/test/i.test(target.pathname.replace(/^\//, ""))) throw new Error('Refusing to run: the test database name must contain "test".');
  skip = false;
}

const root = path.resolve(__dirname, "..", "..");
const P = `qhtest-${process.pid}-`;
const TEACHER = `${P}teacher`;
const OTHER_TEACHER = `${P}other-teacher`;
const CLASS = `${P}class`;
const LECTURE = `${P}lecture`;
const DEFAULT_LECTURE = `${P}default-lecture`;
const STUDENTS = Array.from({ length: 8 }, (_, i) => `${P}student-${i + 1}`);
const [S1, S2, S3, S4] = STUDENTS;
const APP = "https://app.example.test";

let prisma;
let lectureService;
let validation;
let locks;
let routes;
const state = { student: S1, teacher: TEACHER };

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

if (!skip) {
  process.env.DATABASE_URL = url; // before anything can load the project's .env
  require("../helpers/server-only.cjs");
  require("tsx/cjs/api").register();
  const clientModule = process.env.QUIZ_TEST_PRISMA_CLIENT || "@prisma/client";
  const { PrismaClient, Prisma } = require(clientModule);
  if (!("optionsSnapshot" in Prisma.QuizSubmissionAnswerScalarFieldEnum)) {
    throw new Error("Refusing to run: the Prisma client has no QuizSubmissionAnswer.optionsSnapshot (run prisma generate).");
  }
  prisma = new PrismaClient({ datasources: { db: { url } } });
  fake("lib/prisma.ts", { prisma });
  const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
  fake("lib/auth-session.ts", {
    requireStudentSession: async () => ({ studentId: state.student, role: "STUDENT" }),
    requireTeacherSession: async () => {
      if (!state.teacher) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
      return { teacherId: state.teacher, role: "TEACHER" };
    },
    requireAppSession: async () => { throw new Error("not used"); },
    requireAdminSession: async () => { throw new Error("not used"); },
    requireTeacherSessionForbiddingOtherRoles: async () => { throw new Error("not used"); },
    getOptionalSession: async () => null,
  });
  fake("lib/session-events.ts", { emitStudentDataChange: () => {}, emitLiveChange: () => {} });
  fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
  lectureService = require(path.join(root, "services", "lecture-service.ts"));
  validation = require(path.join(root, "lib", "lecture-validation.ts"));
  locks = require(path.join(root, "lib", "quiz-locks.ts"));
  const r = (...p) => require(path.join(root, "app", "api", ...p, "route.ts"));
  routes = {
    submit: r("student", "quizzes", "[quizId]", "submit"),
    quiz: r("student", "quizzes", "[quizId]"),
    review: r("student", "quizzes", "[quizId]", "review"),
    results: r("lectures", "[id]", "quizzes", "[quizId]", "results"),
    teacherQuiz: r("lectures", "[id]", "quizzes", "[quizId]"),
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM "Quiz" WHERE "lectureId" LIKE '${P}%'`); // questions, options, submissions, answers cascade
  await prisma.$executeRawUnsafe(`DELETE FROM "ClassStudent" WHERE "id" LIKE '${P}%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Lecture" WHERE "id" LIKE '${P}%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Class" WHERE "id" LIKE '${P}%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Student" WHERE "id" LIKE '${P}%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Teacher" WHERE "id" LIKE '${P}%'`);
}

// ---- Helpers ---------------------------------------------------------------------------------------

const HOUR = 3_600_000;
function quizInput({ title = "Quiz", maxAttempts = null, questions }) {
  return validation.createQuizSchema.parse({
    title,
    maxAttempts,
    startDateTime: new Date(Date.now() - HOUR).toISOString(),
    endDateTime: new Date(Date.now() + 24 * HOUR).toISOString(),
    questions,
  });
}
const q = (text, options, answerType = "SINGLE") => ({ text, answerType, options: options.map(([t, c]) => ({ text: t, isCorrect: c })) });
const V1 = [
  q("2 + 2 = ?", [["3", false], ["4", true], ["5", false]]),
  q("Primes?", [["2", true], ["4", false], ["5", true]], "MULTIPLE"),
  q("Capital of Sri Lanka?", [["Colombo", false], ["Sri Jayawardenepura Kotte", true]]),
];

async function createQuiz(options = {}) {
  return lectureService.addQuizToLectureForTeacher(TEACHER, LECTURE, quizInput({ questions: V1, ...options }));
}
async function editQuiz(quizId, questions, extra = {}) {
  return lectureService.updateQuizForTeacher(TEACHER, LECTURE, quizId, quizInput({ questions, ...extra }));
}

/** Answers for the quiz as it is now: `pick(question, index)` returns the option texts to select. */
async function answersFor(quizId, pick) {
  const questions = await prisma.quizQuestion.findMany({ where: { quizId }, orderBy: { orderIndex: "asc" }, include: { options: true } });
  return questions.map((question, index) => {
    const texts = pick(question, index);
    return { questionId: question.id, selectedOptionIds: question.options.filter((o) => texts.includes(o.text)).map((o) => o.id) };
  });
}
const allCorrect = (question) => question.options.filter((o) => o.isCorrect).map((o) => o.text);

async function call(handler, params, init, studentId) {
  if (studentId) state.student = studentId;
  const response = await handler(new Request(`${APP}/x`, init), { params });
  return { status: response.status, body: await response.json() };
}
const submit = (quizId, studentId, answers) =>
  call(routes.submit.POST, { quizId }, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers }) }, studentId);
const review = (quizId, studentId) => call(routes.review.GET, { quizId }, {}, studentId);
const studentQuiz = (quizId, studentId) => call(routes.quiz.GET, { quizId }, {}, studentId);

async function submissionOf(quizId, studentId) {
  return prisma.quizSubmission.findUnique({
    where: { quizId_studentId: { quizId, studentId } },
    include: { answers: { orderBy: { questionOrderIndex: "asc" } } },
  });
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test.describe("quiz history on PostgreSQL", { skip }, () => {
  test.before(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Teacher" ("id", "name", "email", "password") VALUES ($1, 'T', $2, 'x'), ($3, 'O', $4, 'x')`,
      TEACHER, `${TEACHER}@example.test`, OTHER_TEACHER, `${OTHER_TEACHER}@example.test`
    );
    for (const student of STUDENTS) {
      // gradeId NULL: the column default (Grade 6) needs seeded Grade rows, which a schema built by migrate diff has not.
      await prisma.$executeRawUnsafe(`INSERT INTO "Student" ("id", "name", "teacherId", "contact", "gradeId") VALUES ($1, $1, $2, '0700000000', NULL)`, student, TEACHER);
    }
    await prisma.$executeRawUnsafe(`INSERT INTO "Class" ("id", "name", "teacherId") VALUES ($1, 'A', $2)`, CLASS, TEACHER);
    for (const student of STUDENTS) {
      await prisma.$executeRawUnsafe(`INSERT INTO "ClassStudent" ("id", "classId", "studentId", "isActive") VALUES ($1, $2, $3, true)`, `${student}-enrolment`, CLASS, student);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Lecture" ("id", "title", "date", "classId", "isDefault") VALUES ($1, 'Kinematics', '2026-10-10 03:30:00', $3, false), ($2, 'General Notes', '2026-01-05 00:00:00', $3, true)`,
      LECTURE, DEFAULT_LECTURE, CLASS
    );
  });
  test.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  // ---- The migration's backfill (temporary schema, rolled back) ---------------------------------------

  test("migration: answers written before it get the exact snapshot of their (still current) question; replacing a question then keeps them", async () => {
    const sql = fs.readFileSync(path.join(root, "prisma", "migrations", "20261130120000_add_quiz_answer_snapshots", "migration.sql"), "utf8");
    const statements = sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
    const schema = `qhmig_${process.pid}`;
    const ROLLBACK = new Error("rollback");
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        // The quiz tables as the init migration created them (the answer FK with ON DELETE CASCADE).
        for (const ddl of [
          `CREATE TYPE "QuizAnswerType" AS ENUM ('SINGLE', 'MULTIPLE')`,
          `CREATE TABLE "QuizQuestion" ("id" TEXT PRIMARY KEY, "text" TEXT NOT NULL, "orderIndex" INTEGER NOT NULL, "answerType" "QuizAnswerType" NOT NULL)`,
          `CREATE TABLE "QuizQuestionOption" ("id" TEXT PRIMARY KEY, "questionId" TEXT NOT NULL REFERENCES "QuizQuestion"("id") ON DELETE CASCADE, "text" TEXT NOT NULL, "isCorrect" BOOLEAN NOT NULL DEFAULT false, "orderIndex" INTEGER NOT NULL)`,
          `CREATE TABLE "QuizSubmission" ("id" TEXT PRIMARY KEY)`,
          `CREATE TABLE "QuizSubmissionAnswer" ("id" TEXT PRIMARY KEY, "submissionId" TEXT NOT NULL REFERENCES "QuizSubmission"("id") ON DELETE CASCADE, "questionId" TEXT NOT NULL, "selectedOptionIds" TEXT[], "isCorrect" BOOLEAN NOT NULL)`,
          `ALTER TABLE "QuizSubmissionAnswer" ADD CONSTRAINT "QuizSubmissionAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
          `INSERT INTO "QuizQuestion" VALUES ('q1', 'Two plus two?', 0, 'SINGLE'), ('q2', 'Primes?', 1, 'MULTIPLE')`,
          `INSERT INTO "QuizQuestionOption" VALUES ('o1b', 'q1', 'Four', true, 1), ('o1a', 'q1', 'Three', false, 0), ('o2a', 'q2', 'Two', true, 0), ('o2b', 'q2', 'Nine', false, 1)`,
          `INSERT INTO "QuizSubmission" VALUES ('s1'), ('s2')`,
          `INSERT INTO "QuizSubmissionAnswer" VALUES ('a1', 's1', 'q1', '{o1b}', true), ('a2', 's1', 'q2', '{o2b}', false), ('a3', 's2', 'q1', '{o1a}', false)`,
        ]) {
          await tx.$executeRawUnsafe(ddl);
        }
        for (const statement of statements) await tx.$executeRawUnsafe(statement);

        const rows = await tx.$queryRawUnsafe(
          `SELECT "id", "questionId", "questionText", "questionOrderIndex", "answerType"::text AS "answerType", "optionsSnapshot", "selectedOptionIds", "isCorrect" FROM "QuizSubmissionAnswer" ORDER BY "id"`
        );
        assert.deepEqual(plain(rows), [
          { id: "a1", questionId: "q1", questionText: "Two plus two?", questionOrderIndex: 0, answerType: "SINGLE", selectedOptionIds: ["o1b"], isCorrect: true,
            optionsSnapshot: [{ id: "o1a", text: "Three", isCorrect: false, orderIndex: 0 }, { id: "o1b", text: "Four", isCorrect: true, orderIndex: 1 }] },
          { id: "a2", questionId: "q2", questionText: "Primes?", questionOrderIndex: 1, answerType: "MULTIPLE", selectedOptionIds: ["o2b"], isCorrect: false,
            optionsSnapshot: [{ id: "o2a", text: "Two", isCorrect: true, orderIndex: 0 }, { id: "o2b", text: "Nine", isCorrect: false, orderIndex: 1 }] },
          { id: "a3", questionId: "q1", questionText: "Two plus two?", questionOrderIndex: 0, answerType: "SINGLE", selectedOptionIds: ["o1a"], isCorrect: false,
            optionsSnapshot: [{ id: "o1a", text: "Three", isCorrect: false, orderIndex: 0 }, { id: "o1b", text: "Four", isCorrect: true, orderIndex: 1 }] },
        ]);
        const columns = await tx.$queryRawUnsafe(
          `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'QuizSubmissionAnswer' ORDER BY column_name`,
          schema
        );
        assert.deepEqual(Object.fromEntries(columns.map((c) => [c.column_name, c.is_nullable])), {
          answerType: "NO", id: "YES".replace("YES", "NO"), isCorrect: "NO", optionsSnapshot: "NO", questionId: "YES", questionOrderIndex: "NO", questionText: "NO", selectedOptionIds: "YES", submissionId: "NO",
        });

        // An edit replaces the question: the answers (and their snapshots) stay; questionId becomes NULL.
        await tx.$executeRawUnsafe(`DELETE FROM "QuizQuestion" WHERE "id" = 'q1'`);
        const after = await tx.$queryRawUnsafe(`SELECT "id", "questionId", "questionText" FROM "QuizSubmissionAnswer" ORDER BY "id"`);
        assert.deepEqual(plain(after), [
          { id: "a1", questionId: null, questionText: "Two plus two?" },
          { id: "a2", questionId: "q2", questionText: "Primes?" },
          { id: "a3", questionId: null, questionText: "Two plus two?" },
        ]);
        throw ROLLBACK;
      }),
      (error) => error === ROLLBACK
    );
    const leftover = await prisma.$queryRawUnsafe(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, schema);
    assert.equal(leftover.length, 0, "rolled back");
  });

  // ---- 1: edit before any attempt -------------------------------------------------------------------

  test("1. editing a quiz before any attempt replaces its questions (as before)", async () => {
    const quiz = await createQuiz();
    const edited = await editQuiz(quiz.id, [q("Only question", [["A", true], ["B", false]])], { title: "Renamed" });
    assert.equal(edited.title, "Renamed");
    assert.deepEqual(edited.questions.map((x) => x.text), ["Only question"]);
    assert.equal(await prisma.quizQuestion.count({ where: { quizId: quiz.id } }), 1);
    const first = await submit(quiz.id, S1, await answersFor(quiz.id, allCorrect));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.submission.score, 1);
  });

  // ---- 2-10: edit after attempts ---------------------------------------------------------------------

  test("2-10. after attempts: change texts and options, remove and add questions; history, scores, reviews stay; new attempts use the new quiz", async () => {
    const quiz = await createQuiz({ maxAttempts: 3 });
    // S1: all correct (3/3). S2: wrong on question 2 (2/3).
    assert.equal((await submit(quiz.id, S1, await answersFor(quiz.id, allCorrect))).status, 201);
    const s2Answers = await answersFor(quiz.id, (question, i) => (i === 1 ? ["4"] : allCorrect(question)));
    assert.equal((await submit(quiz.id, S2, s2Answers)).status, 201);
    const before = { s1: await submissionOf(quiz.id, S1), s2: await submissionOf(quiz.id, S2) };
    const reviewBefore = { s1: (await review(quiz.id, S1)).body.data, s2: (await review(quiz.id, S2)).body.data };
    assert.equal(before.s2.score, 2);
    assert.deepEqual(reviewBefore.s2.quiz.questions.map((x) => x.isCorrect), [true, false, true]);

    // The edit: question 1 re-worded, question 2's options changed (and its answer), question 3 removed, a new question added.
    const V2 = [
      q("What is 2 + 2?", [["3", false], ["4", true], ["5", false]]),
      q("Primes?", [["2", true], ["9", false], ["7", true], ["11", true]], "MULTIPLE"),
      q("New: 3 x 3 = ?", [["9", true], ["6", false]]),
    ];
    const edited = await editQuiz(quiz.id, V2, { maxAttempts: 3 });
    assert.deepEqual(edited.questions.map((x) => x.text), V2.map((x) => x.text));

    // 2 / 7 / 8 / 10: every historical submission and answer is exactly as it was (only questionId is cleared).
    for (const key of ["s1", "s2"]) {
      const now = await submissionOf(quiz.id, key === "s1" ? S1 : S2);
      assert.deepEqual(
        { score: now.score, totalQuestions: now.totalQuestions, attemptCount: now.attemptCount, submittedAt: now.submittedAt.toISOString() },
        { score: before[key].score, totalQuestions: before[key].totalQuestions, attemptCount: before[key].attemptCount, submittedAt: before[key].submittedAt.toISOString() },
        key
      );
      assert.equal(now.answers.length, 3, `${key}: no answer deleted`);
      assert.deepEqual(
        plain(now.answers.map(({ questionId, ...rest }) => rest)),
        plain(before[key].answers.map(({ questionId, ...rest }) => rest)),
        `${key}: answers and snapshots unchanged`
      );
      assert.ok(now.answers.every((a) => a.questionId === null), `${key}: the replaced questions are unlinked, not deleted with their answers`);
      // 3-7: the review is the attempt as it was taken: old texts, old options, the old selections and correctness.
      const reviewNow = (await review(quiz.id, key === "s1" ? S1 : S2)).body.data;
      assert.deepEqual(reviewNow.submission, reviewBefore[key].submission, `${key}: score / attempts in the review`);
      assert.deepEqual(
        reviewNow.quiz.questions.map(({ id, ...rest }) => rest),
        reviewBefore[key].quiz.questions.map(({ id, ...rest }) => rest),
        `${key}: questions as answered`
      );
      assert.deepEqual(reviewNow.quiz.questions.map((x) => x.text), ["2 + 2 = ?", "Primes?", "Capital of Sri Lanka?"], "the removed question is still reviewable; the new one is not part of it");
    }

    // The teacher's results: unchanged scores and attempts.
    state.teacher = TEACHER;
    const results = await call(routes.results.GET, { id: LECTURE, quizId: quiz.id }, {});
    assert.equal(results.status, 200);
    const byStudent = Object.fromEntries(results.body.data.submissions.map((s) => [s.studentId, [s.score, s.totalQuestions, s.attemptCount]]));
    assert.deepEqual(byStudent, { [S1]: [3, 3, 1], [S2]: [2, 3, 1] });

    // 9: the quiz now shows the new questions; answers to the old ones are refused.
    const current = await studentQuiz(quiz.id, S3);
    assert.deepEqual(current.body.data.quiz.questions.map((x) => x.text), V2.map((x) => x.text));
    const stale = await submit(quiz.id, S3, before.s1.answers.map((a) => ({ questionId: a.questionId ?? a.id, selectedOptionIds: a.selectedOptionIds })));
    assert.equal(stale.status, 400);
    // A first attempt on the new quiz: graded and snapshotted with the new questions.
    const fresh = await submit(quiz.id, S3, await answersFor(quiz.id, allCorrect));
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    assert.deepEqual([fresh.body.data.submission.score, fresh.body.data.submission.totalQuestions], [3, 3]);
    assert.deepEqual((await review(quiz.id, S3)).body.data.quiz.questions.map((x) => x.text), V2.map((x) => x.text));
    // S1's second attempt replaces S1's own latest attempt only (the existing one-row-per-student design).
    const second = await submit(quiz.id, S1, await answersFor(quiz.id, (question, i) => (i === 2 ? ["6"] : allCorrect(question))));
    assert.equal(second.status, 201);
    assert.deepEqual([second.body.data.submission.score, second.body.data.submission.attemptCount], [2, 2]);
    const s1Review = (await review(quiz.id, S1)).body.data.quiz.questions;
    assert.deepEqual(s1Review.map((x) => x.text), V2.map((x) => x.text));
    assert.deepEqual(s1Review[1].options.map((o) => o.text), ["2", "9", "7", "11"]);
    // 10: S2's historical attempt is still untouched.
    const s2Now = await submissionOf(quiz.id, S2);
    assert.deepEqual([s2Now.score, s2Now.attemptCount, s2Now.answers.map((a) => a.questionText)], [2, 1, ["2 + 2 = ?", "Primes?", "Capital of Sri Lanka?"]]);
  });

  test("the teacher edit route still works (validation, ownership); another teacher cannot edit", async () => {
    const quiz = await createQuiz();
    const body = JSON.stringify({
      title: "Via route",
      startDateTime: new Date(Date.now() - HOUR).toISOString(),
      endDateTime: new Date(Date.now() + HOUR).toISOString(),
      questions: [q("Route question", [["Yes", true], ["No", false]])],
    });
    state.teacher = OTHER_TEACHER;
    const denied = await call(routes.teacherQuiz.PUT, { id: LECTURE, quizId: quiz.id }, { method: "PUT", headers: { "content-type": "application/json" }, body });
    assert.equal(denied.status, 404);
    state.teacher = TEACHER;
    const ok = await call(routes.teacherQuiz.PUT, { id: LECTURE, quizId: quiz.id }, { method: "PUT", headers: { "content-type": "application/json" }, body });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.quiz.questions.map((x) => x.text), ["Route question"]);
  });

  test("General Quizzes (the class's default lecture, services/class-quizzes-service.ts): created, attempted, edited through the item route, history intact", async () => {
    const classQuizzes = require(path.join(root, "services", "class-quizzes-service.ts"));
    const created = await classQuizzes.createClassQuizForTeacher({ teacherId: TEACHER, classId: CLASS, quiz: quizInput({ questions: V1 }) });
    assert.equal(created.section, "GENERAL");
    assert.deepEqual(created.lecture, { id: DEFAULT_LECTURE, isDefault: true, title: null, date: null });
    const quizId = created.quiz.id;
    const listed = await classQuizzes.listClassQuizzesForTeacher(TEACHER, CLASS);
    assert.ok(listed.quizzes.some((x) => x.id === quizId));

    const first = await submit(quizId, S2, await answersFor(quizId, (question, i) => (i === 0 ? ["5"] : allCorrect(question))));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const before = (await review(quizId, S2)).body.data;

    state.teacher = TEACHER;
    const body = JSON.stringify({
      title: "General, edited",
      startDateTime: new Date(Date.now() - HOUR).toISOString(),
      endDateTime: new Date(Date.now() + HOUR).toISOString(),
      questions: [q("Edited", [["Yes", true], ["No", false]])],
    });
    const edited = await call(routes.teacherQuiz.PUT, { id: created.lecture.id, quizId }, { method: "PUT", headers: { "content-type": "application/json" }, body });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const after = (await review(quizId, S2)).body.data;
    assert.deepEqual(after.submission, before.submission);
    assert.deepEqual(after.quiz.questions.map(({ id, ...rest }) => rest), before.quiz.questions.map(({ id, ...rest }) => rest));
    assert.deepEqual([after.submission.score, after.submission.totalQuestions], [2, 3]);
    const results = await call(routes.results.GET, { id: created.lecture.id, quizId }, {});
    assert.equal(results.status, 200);
    assert.deepEqual(results.body.data.submissions.map((s) => [s.studentId, s.score, s.totalQuestions]), [[S2, 2, 3]]);
  });

  // ---- 11: attempt limits --------------------------------------------------------------------------

  test("11. attempt limits still apply across an edit: earlier attempts count; the limit is enforced", async () => {
    const quiz = await createQuiz({ maxAttempts: 2 });
    assert.equal((await submit(quiz.id, S4, await answersFor(quiz.id, allCorrect))).status, 201);
    await editQuiz(quiz.id, V1.slice(0, 2), { maxAttempts: 2 });
    const second = await submit(quiz.id, S4, await answersFor(quiz.id, allCorrect));
    assert.equal(second.status, 201);
    assert.equal(second.body.data.submission.attemptCount, 2);
    const third = await submit(quiz.id, S4, await answersFor(quiz.id, allCorrect));
    assert.equal(third.status, 403);
    assert.equal(third.body.error.code, "MAX_ATTEMPTS_REACHED");
    assert.equal((await submissionOf(quiz.id, S4)).attemptCount, 2);
  });

  // ---- 12: concurrency -------------------------------------------------------------------------------

  test("12a. an edit waits for an in-flight submission (FOR SHARE) and a submission waits for an in-flight edit (FOR UPDATE)", async () => {
    const quiz = await createQuiz();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let edited = false;
    // A submission in flight: holds the quiz's FOR SHARE lock.
    const holder = locks.runQuizTransaction(async (tx) => {
      await locks.lockQuizForSubmission(tx, quiz.id);
      await gate;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const edit = editQuiz(quiz.id, [q("After the edit", [["A", true], ["B", false]])]).then(() => (edited = true));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(edited, false, "the edit waits for the submission");
    release();
    await holder;
    await edit;
    assert.equal(edited, true);

    // An edit in flight: a submission waits, then grades the NEW questions (its old answers are refused).
    const oldAnswers = await answersFor(quiz.id, allCorrect);
    let releaseEdit;
    const editGate = new Promise((resolve) => (releaseEdit = resolve));
    const editor = locks.runQuizTransaction(async (tx) => {
      await locks.lockQuizForEdit(tx, quiz.id);
      await tx.quizQuestion.updateMany({ where: { quizId: quiz.id }, data: { text: "Changed under lock" } });
      await editGate;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    let submitted = null;
    const pending = submit(quiz.id, S2, oldAnswers).then((r) => (submitted = r));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(submitted, null, "the submission waits for the edit");
    releaseEdit();
    await editor;
    await pending;
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const saved = await submissionOf(quiz.id, S2);
    assert.deepEqual(saved.answers.map((a) => a.questionText), ["Changed under lock"], "graded on the committed edit, never on a half-edited quiz");
  });

  test("12b. an edit racing many submissions: every saved attempt is consistent with exactly one version; nothing fails with 500", async () => {
    const quiz = await createQuiz();
    const v1Texts = V1.map((x) => x.text);
    const V2 = [q("V2 one", [["x", true], ["y", false]]), q("V2 two", [["x", false], ["y", true]])];
    const answers = await answersFor(quiz.id, allCorrect);
    const racers = STUDENTS.map((student) => {
      const request = new Request(`${APP}/x`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers }) });
      return { student, request };
    });
    // Each submission runs with its own session (the fake reads state.student when the route starts).
    const results = await Promise.all([
      editQuiz(quiz.id, V2).then(() => ({ status: "edit" })),
      ...racers.map(async ({ student, request }) => {
        state.student = student;
        const response = await routes.submit.POST(request, { params: { quizId: quiz.id } });
        return { student, status: response.status, body: await response.json() };
      }),
    ]);
    const outcomes = results.slice(1);
    for (const outcome of outcomes) assert.ok([201, 400].includes(outcome.status), `${outcome.student}: ${outcome.status} ${JSON.stringify(outcome.body)}`);
    for (const outcome of outcomes.filter((o) => o.status === 201)) {
      const saved = await submissionOf(quiz.id, outcome.student);
      assert.deepEqual(saved.answers.map((a) => a.questionText), v1Texts, `${outcome.student}: graded wholly on version 1`);
      assert.equal(saved.totalQuestions, 3);
      assert.equal(saved.score, saved.answers.filter((a) => a.isCorrect).length);
    }
    assert.deepEqual((await prisma.quizQuestion.findMany({ where: { quizId: quiz.id }, orderBy: { orderIndex: "asc" } })).map((x) => x.text), ["V2 one", "V2 two"]);
  });

  test("12c. one student's simultaneous submissions with one attempt allowed: exactly one is saved, the other is refused", async () => {
    const quiz = await createQuiz({ maxAttempts: 1 });
    const answers = await answersFor(quiz.id, allCorrect);
    state.student = S3;
    const responses = await Promise.all(
      [0, 1, 2].map(() =>
        routes.submit.POST(new Request(`${APP}/x`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers }) }), { params: { quizId: quiz.id } })
      )
    );
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 403, 403]);
    const saved = await submissionOf(quiz.id, S3);
    assert.equal(saved.attemptCount, 1);
    assert.equal(saved.answers.length, 3);
  });
});
