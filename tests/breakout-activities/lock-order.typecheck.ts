/*
 * Compile-time check of the breakout lock order (lib/breakout-activities/
 * locks.ts): the submission (advisory) lock needs the ActiveSessionLock that
 * requireActiveSessionShared() returns. Never executed: the project's
 * `tsc --noEmit` and tests/breakout-activities/locks.test.cjs type-check it,
 * and each @ts-expect-error fails the check if that line ever compiles.
 */

import type { Prisma } from "@prisma/client";

import {
  lockActivityForUpdate,
  lockActivityShared,
  lockInProgressAttemptsForUpdate,
  lockOwnQuizAttemptForUpdate,
  lockStudentSubmissionSlot,
  lockSessionExclusive,
  lockSessionShared,
  lockSubmissionSlot,
  requireActiveSessionShared,
  type ActiveSessionLock,
  type LockedSession,
} from "@/lib/breakout-activities/locks";

export async function correctOrder(tx: Prisma.TransactionClient) {
  const session = await requireActiveSessionShared(tx, "session-id");
  await lockActivityForUpdate(tx, session, "quiz", "quiz-id");
  await lockSubmissionSlot(tx, session, "assignment-id", "student-id");
  await lockInProgressAttemptsForUpdate(tx, session, "quiz-id");
}

export async function wrongOrder(tx: Prisma.TransactionClient) {
  // @ts-expect-error no session lock at all (the old signature)
  await lockSubmissionSlot(tx, "assignment-id", "student-id");

  const shared = await lockSessionShared(tx, "session-id");
  // @ts-expect-error a plain shared lock may be null or an ended session
  await lockSubmissionSlot(tx, shared, "assignment-id", "student-id");

  const exclusive = await lockSessionExclusive(tx, "session-id");
  // @ts-expect-error the exclusive (session end) lock is not a breakout-write lock
  await lockSubmissionSlot(tx, exclusive!, "assignment-id", "student-id");

  const handMade: LockedSession = { id: "session-id", classId: "class-id", isActive: true };
  // @ts-expect-error a hand-built object is not a lock
  await lockSubmissionSlot(tx, handMade, "assignment-id", "student-id");

  // @ts-expect-error a lock cannot be forged by spreading fields
  const forged: ActiveSessionLock = { ...handMade };
  void forged;

  // @ts-expect-error the activity row lock also needs the active-session lock
  await lockActivityForUpdate(tx, handMade, "assignment", "assignment-id");
  // @ts-expect-error so do the attempt row locks
  await lockInProgressAttemptsForUpdate(tx, shared, "quiz-id");
}

// Student writes (D4): the quiz / assignment row share lock comes before the
// attempt / advisory lock, and the token must be of the right kind.
export async function studentCorrectOrder(tx: Prisma.TransactionClient) {
  const session = await requireActiveSessionShared(tx, "session-id");
  const quiz = await lockActivityShared(tx, session, "quiz", "quiz-id");
  if (quiz) await lockOwnQuizAttemptForUpdate(tx, quiz, "student-id");
  const assignment = await lockActivityShared(tx, session, "assignment", "assignment-id");
  if (assignment) await lockStudentSubmissionSlot(tx, assignment, "student-id");
}

export async function studentWrongOrder(tx: Prisma.TransactionClient) {
  const session = await requireActiveSessionShared(tx, "session-id");
  // @ts-expect-error an attempt lock needs the quiz share lock, not just the session lock
  await lockOwnQuizAttemptForUpdate(tx, session, "student-id");
  const assignment = await lockActivityShared(tx, session, "assignment", "assignment-id");
  // @ts-expect-error an assignment share lock is not a quiz share lock
  if (assignment) await lockOwnQuizAttemptForUpdate(tx, assignment, "student-id");
  const quiz = await lockActivityShared(tx, session, "quiz", "quiz-id");
  // @ts-expect-error the submission slot needs the assignment share lock
  if (quiz) await lockStudentSubmissionSlot(tx, quiz, "student-id");
}
