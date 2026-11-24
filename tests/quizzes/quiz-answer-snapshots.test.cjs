/*
 * Historical quiz attempts (no database): the answer snapshot helpers
 * (lib/quiz-answer-snapshot.ts), the quiz locks (lib/quiz-locks.ts), the
 * migration 20261130120000_add_quiz_answer_snapshots (static guard) and the
 * submit / review / edit code paths (source pins). The same behaviour on
 * real PostgreSQL: tests/quizzes/quiz-history.db.test.cjs.
 *
 *   npm run test:quizzes
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8").replace(/\r\n/g, "\n");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A fake Prisma for runQuizTransaction (records the raw SQL; the callback's error is what $transaction throws).
const calls = [];
let transactionError = null;
const fakeTx = {
  $executeRawUnsafe: async (sql) => calls.push(["unsafe", sql]),
  $executeRaw: async (strings, ...values) => calls.push(["executeRaw", strings.join("?"), values]),
  $queryRaw: async (strings, ...values) => {
    calls.push(["queryRaw", strings.join("?"), values]);
    return values[0] === "missing" ? [] : [{ id: values[0] }];
  },
};
const prismaFile = path.join(root, "lib", "prisma.ts");
const mod = new Module(prismaFile);
mod.filename = prismaFile;
mod.loaded = true;
mod.exports = {
  prisma: {
    $transaction: async (fn, options) => {
      calls.push(["transaction", options]);
      if (transactionError) throw transactionError;
      return fn(fakeTx);
    },
  },
};
require.cache[prismaFile] = mod;

const snapshot = require(path.join(root, "lib", "quiz-answer-snapshot.ts"));
const locks = require(path.join(root, "lib", "quiz-locks.ts"));
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

// ---- Snapshot helpers ------------------------------------------------------------------------------

const QUESTION = {
  id: "q1",
  text: "2 + 2 = ?",
  orderIndex: 4,
  answerType: "SINGLE",
  options: [
    { id: "o-b", text: "4", isCorrect: true, orderIndex: 1 },
    { id: "o-a", text: "3", isCorrect: false, orderIndex: 0 },
  ],
};

test("snapshotQuizQuestion: the question as answered, options in their order (ids, texts, correctness)", () => {
  assert.deepEqual(snapshot.snapshotQuizQuestion(QUESTION), {
    questionId: "q1",
    questionText: "2 + 2 = ?",
    questionOrderIndex: 4,
    answerType: "SINGLE",
    optionsSnapshot: [
      { id: "o-a", text: "3", isCorrect: false, orderIndex: 0 },
      { id: "o-b", text: "4", isCorrect: true, orderIndex: 1 },
    ],
  });
  assert.equal(QUESTION.options[0].id, "o-b", "the input is not reordered in place");
});

test("reviewQuestionsFromAnswers: exactly the answered questions, in their order then; a replaced question keeps the answer's id", () => {
  const answer = (id, questionId, order, text, selected, isCorrect) => ({
    id,
    questionId,
    questionText: text,
    questionOrderIndex: order,
    answerType: "SINGLE",
    optionsSnapshot: [
      { id: `${id}-y`, text: "Yes", isCorrect: true, orderIndex: 1 },
      { id: `${id}-n`, text: "No", isCorrect: false, orderIndex: 0 },
    ],
    selectedOptionIds: selected,
    isCorrect,
  });
  const review = snapshot.reviewQuestionsFromAnswers([answer("a2", null, 1, "Second", ["a2-n"], false), answer("a1", "q1", 0, "First", ["a1-y"], true)]);
  assert.deepEqual(review, [
    { id: "q1", text: "First", answerType: "SINGLE", isCorrect: true, selectedOptionIds: ["a1-y"], options: [{ id: "a1-n", text: "No", isCorrect: false }, { id: "a1-y", text: "Yes", isCorrect: true }] },
    { id: "a2", text: "Second", answerType: "SINGLE", isCorrect: false, selectedOptionIds: ["a2-n"], options: [{ id: "a2-n", text: "No", isCorrect: false }, { id: "a2-y", text: "Yes", isCorrect: true }] },
  ]);
  assert.deepEqual(snapshot.reviewQuestionsFromAnswers([]), []);
});

test("readOptionsSnapshot: a malformed snapshot is a data error, never shown as an empty question", () => {
  for (const bad of [null, {}, [{ id: "x" }], [{ id: "x", text: "t", isCorrect: "yes", orderIndex: 0 }], [{ id: 1, text: "t", isCorrect: true, orderIndex: 0 }]]) {
    assert.throws(() => snapshot.readOptionsSnapshot(bad), TypeError, JSON.stringify(bad));
  }
  assert.deepEqual(snapshot.readOptionsSnapshot([]), []);
});

// ---- Locks -----------------------------------------------------------------------------------------

test("quiz locks: bounded waits in one transaction; FOR UPDATE (edit), FOR SHARE (submit), the (quiz, student) advisory lock via $executeRaw", async () => {
  calls.length = 0;
  await locks.runQuizTransaction(async (tx) => {
    assert.equal(await locks.lockQuizForEdit(tx, "quiz-1"), true);
    assert.equal(await locks.lockQuizForSubmission(tx, "missing"), false);
    await locks.lockQuizAttempt(tx, "quiz-1", "student-1");
  });
  assert.deepEqual(calls[0], ["transaction", locks.QUIZ_TRANSACTION_OPTIONS]);
  assert.deepEqual(calls[1], ["unsafe", `SET LOCAL lock_timeout = '${locks.QUIZ_LOCK_TIMEOUT_MS}ms'`]);
  assert.match(calls[2][1], /SELECT "id" FROM "Quiz" WHERE "id" = \? FOR UPDATE$/);
  assert.match(calls[3][1], /SELECT "id" FROM "Quiz" WHERE "id" = \? FOR SHARE$/);
  assert.deepEqual(calls[4], ["executeRaw", "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["quiz-attempt:quiz-1:student-1"]]);
  assert.ok(locks.QUIZ_LOCK_TIMEOUT_MS < locks.QUIZ_TRANSACTION_OPTIONS.timeout, "a lock wait ends before the transaction expires");
  assert.throws(() => locks.quizAttemptLockKey("quiz 1", "s"), TypeError);
  assert.throws(() => locks.quizAttemptLockKey("q", ""), TypeError);
});

test("runQuizTransaction: a lock timeout or deadlock is 409 QUIZ_BUSY; any other error is unchanged", async () => {
  const lockError = Object.assign(new Error("lock timeout"), { name: "PrismaClientKnownRequestError", code: "P2010", meta: { code: "55P03" } });
  transactionError = lockError;
  await assert.rejects(locks.runQuizTransaction(async () => {}), (error) => error instanceof AppError && error.statusCode === 409 && error.code === "QUIZ_BUSY");
  const other = new Error("boom");
  transactionError = other;
  await assert.rejects(locks.runQuizTransaction(async () => {}), (error) => error === other);
  transactionError = null;
});

// ---- Migration guard -------------------------------------------------------------------------------

const MIGRATION = "20261130120000_add_quiz_answer_snapshots";
const migrationsDir = path.join(root, "prisma", "migrations");
const normalize = (sql) => sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const statements = normalize(read("prisma", "migrations", MIGRATION, "migration.sql")).split(";").map((s) => s.trim()).filter(Boolean);

test("migration: the newest, right after the default lecture; no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(-2), ["20261129120000_add_lecture_is_default", MIGRATION]);
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "committed migrations are untouched");
});

test("migration: nullable columns, exact backfill, NOT NULL, then the FK swapped to ON DELETE SET NULL; nothing else", () => {
  assert.equal(statements.length, 7);
  assert.equal(statements[0], "SET lock_timeout = '5s'");
  assert.equal(
    statements[1],
    'ALTER TABLE "QuizSubmissionAnswer" ADD COLUMN "answerType" "QuizAnswerType", ADD COLUMN "optionsSnapshot" JSONB, ADD COLUMN "questionOrderIndex" INTEGER, ADD COLUMN "questionText" TEXT'
  );
  assert.match(statements[2], /^UPDATE "QuizSubmissionAnswer" AS a SET "questionText" = q\."text", "questionOrderIndex" = q\."orderIndex", "answerType" = q\."answerType", "optionsSnapshot" = COALESCE\(/);
  assert.match(statements[2], /jsonb_build_object\('id', o\."id", 'text', o\."text", 'isCorrect', o\."isCorrect", 'orderIndex', o\."orderIndex"\) ORDER BY o\."orderIndex", o\."id"/);
  assert.match(statements[2], /FROM "QuizQuestion" AS q WHERE q\."id" = a\."questionId"$/);
  assert.equal(
    statements[3],
    'ALTER TABLE "QuizSubmissionAnswer" ALTER COLUMN "answerType" SET NOT NULL, ALTER COLUMN "optionsSnapshot" SET NOT NULL, ALTER COLUMN "questionOrderIndex" SET NOT NULL, ALTER COLUMN "questionText" SET NOT NULL, ALTER COLUMN "questionId" DROP NOT NULL'
  );
  assert.equal(statements[4], 'ALTER TABLE "QuizSubmissionAnswer" DROP CONSTRAINT "QuizSubmissionAnswer_questionId_fkey"');
  assert.equal(
    statements[5],
    'ALTER TABLE "QuizSubmissionAnswer" ADD CONSTRAINT "QuizSubmissionAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE'
  );
  assert.equal(statements[6], "RESET lock_timeout");
});

test("schema mirrors the migration: snapshot columns required, questionId optional with onDelete: SetNull", () => {
  const schema = read("prisma", "schema.prisma");
  const model = /model QuizSubmissionAnswer \{[\s\S]*?\n\}/.exec(schema)[0];
  assert.match(model, /\n  questionId +String\?\n/);
  assert.match(model, /\n  questionText +String\n/);
  assert.match(model, /\n  questionOrderIndex +Int\n/);
  assert.match(model, /\n  answerType +QuizAnswerType\n/);
  assert.match(model, /\n  optionsSnapshot +Json\n/);
  assert.match(model, /question +QuizQuestion\? +@relation\(fields: \[questionId\], references: \[id\], onDelete: SetNull\)/);
  assert.match(model, /@@unique\(\[submissionId, questionId\]\)/);
});

// ---- Source pins: submit, review, edit -------------------------------------------------------------

test("submit: the quiz is read, graded, snapshotted and saved inside one locked transaction (quiz FOR SHARE, then the student's attempt lock)", () => {
  const src = code(read("app", "api", "student", "quizzes", "[quizId]", "submit", "route.ts"));
  assert.doesNotMatch(src, /\bprisma\./, "no query outside the transaction");
  const tx = src.indexOf("await runQuizTransaction(async (tx) => {");
  const share = src.indexOf("await lockQuizForSubmission(tx, quizId);");
  const attempt = src.indexOf("await lockQuizAttempt(tx, quizId, studentSession.studentId);");
  const quizRead = src.indexOf("await tx.quiz.findFirst({");
  assert.ok(tx > 0 && tx < share && share < attempt && attempt < quizRead, "lock order, then the read");
  assert.match(src, /\.\.\.snapshotQuizQuestion\(question\),/);
  assert.ok(src.indexOf("assertContentAccessForStudent") < tx, "payment-access check unchanged, before");
  for (const check of ["QUIZ_NOT_STARTED", "QUIZ_CLOSED", "MAX_ATTEMPTS_REACHED", "QUIZ_HAS_NO_QUESTIONS"]) assert.ok(src.includes(check), check);
});

test("review: built from the answers' snapshots only, never from the quiz's current questions", () => {
  const src = code(read("app", "api", "student", "quizzes", "[quizId]", "review", "route.ts"));
  assert.match(src, /answers: \{\s*select: STORED_QUIZ_ANSWER_SELECT,\s*\}/);
  assert.match(src, /questions: reviewQuestionsFromAnswers\(submission\.answers\)/);
  assert.doesNotMatch(src, /questions: \{/, "the quiz's questions are not read");
  assert.match(src, /assertContentAccessForStudent\(studentSession\.studentId, \{ quizId \}\)/);
});

test("edit: replaces questions under the quiz's FOR UPDATE lock, after re-checking the quiz is active; students are refreshed", () => {
  const src = code(read("services", "lecture-service.ts"));
  const fn = src.slice(src.indexOf("export async function updateQuizForTeacher("), src.indexOf("export async function deleteQuizForTeacher("));
  const tx = fn.indexOf("await runQuizTransaction(async (tx) => {");
  const lock = fn.indexOf("await lockQuizForEdit(tx, quizId);");
  const check = fn.indexOf("tx.quiz.findFirst({ where: { id: quizId, status: 0 }");
  const update = fn.indexOf("return tx.quiz.update({");
  assert.ok(fn.indexOf("assertTeacherOwnsQuiz(teacherId, lectureId, quizId)") < tx, "ownership first");
  assert.ok(tx > 0 && tx < lock && lock < check && check < update);
  assert.match(fn, /questions: \{\s*deleteMany: \{\},/, "the questions are still replaced (answers keep their snapshots)");
  assert.match(fn, /emitStudentDataChange\(\{ classId: owned\.lecture\.classId \}\)/);
  assert.doesNotMatch(fn, /prisma\.quiz\.update/);
});

test("nothing else writes quiz answers (every answer row gets its snapshot)", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && /quizSubmissionAnswer\.(create|update|upsert)|answers: \{\s*(create|createMany)/.test(read(rel))) offenders.push(rel);
    }
  };
  ["app", "services", "lib"].forEach(walk);
  assert.deepEqual(offenders, ["app/api/student/quizzes/[quizId]/submit/route.ts"]);
});
