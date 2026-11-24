/*
 * Database locks for quiz edits and submissions. Every lock runs INSIDE an
 * interactive transaction (runQuizTransaction) and is released when it ends.
 *
 * Lock order (always the same, so no two transactions wait in a cycle):
 *   1. the Quiz row
 *        - FOR UPDATE by a teacher's edit (updateQuizForTeacher): it waits for
 *          running submissions and blocks new ones while it replaces the
 *          questions and options;
 *        - FOR SHARE by a student's submission: submissions of different
 *          students run at once; each grades and snapshots the questions it
 *          reads under this lock, so an answer can never reference a question
 *          an edit is deleting, nor be graded against a half-edited quiz;
 *   2. the advisory lock of one (quiz, student) pair, by a submission:
 *      serializes one student's submissions to one quiz (the attempt limit
 *      and the single QuizSubmission row).
 * Lock waits are bounded (QUIZ_LOCK_TIMEOUT_MS); a busy lock is 409 QUIZ_BUSY.
 */

import type { Prisma } from "@prisma/client";

import { isRetryableLockError } from "@/lib/breakout-activities/errors";
import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const QUIZ_LOCK_TIMEOUT_MS = 8_000;

/** Lock waits end (QUIZ_LOCK_TIMEOUT_MS) well before the transaction expires. */
export const QUIZ_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertId(value: string, label: string) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`${label} is not a valid id.`);
}

/** The advisory-lock key of one student's attempts at one quiz. */
export function quizAttemptLockKey(quizId: string, studentId: string): string {
  assertId(quizId, "quizId");
  assertId(studentId, "studentId");
  return `quiz-attempt:${quizId}:${studentId}`;
}

/**
 * Runs `fn` in an interactive transaction with bounded lock waits. A lock
 * timeout or deadlock becomes 409 QUIZ_BUSY (try again); everything else is
 * rethrown unchanged.
 */
export async function runQuizTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      // SET cannot take a bind parameter; the value is a module constant.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${QUIZ_LOCK_TIMEOUT_MS}ms'`);
      return fn(tx);
    }, QUIZ_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isRetryableLockError(error)) {
      throw new AppError("This quiz is being updated right now. Please try again.", 409, "QUIZ_BUSY");
    }
    throw error;
  }
}

/** Level 1, teacher edit: the Quiz row FOR UPDATE. False when the quiz does not exist. */
export async function lockQuizForEdit(tx: Prisma.TransactionClient, quizId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Quiz" WHERE "id" = ${quizId} FOR UPDATE`;
  return rows.length === 1;
}

/** Level 1, student submission: the Quiz row FOR SHARE. False when the quiz does not exist. */
export async function lockQuizForSubmission(tx: Prisma.TransactionClient, quizId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Quiz" WHERE "id" = ${quizId} FOR SHARE`;
  return rows.length === 1;
}

/** Level 2: one student's attempts at one quiz. Held until the transaction ends. */
export async function lockQuizAttempt(tx: Prisma.TransactionClient, quizId: string, studentId: string): Promise<void> {
  const key = quizAttemptLockKey(quizId, studentId);
  // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
