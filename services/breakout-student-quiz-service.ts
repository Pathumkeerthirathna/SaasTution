// Breakout Room Activities: student-side quiz service (Stage 3.2).
//
// Stage 3.2: the read paths (3.2.1), starting or retrieving an attempt
// (3.2.2), saving answers (3.2.3), submitting (3.2.4), and the lazy
// auto-submit of expired attempts found by reads (3.2.5; until the Step 4
// sweeper exists, an attempt nobody touches is auto-submitted on its next
// access or by the teacher's close).
//
// Who: the student id always comes from the signed login session (the route
// passes it). Access needs an active session and an active enrolment in its
// class (student-access.ts); every failure is the same 404 (D2).
//
// Which room: the injected StudentRoomResolver; the default fails closed, so
// until Phase 2b every call here is 404. A student sees only PUBLISHED /
// CLOSED, non-deleted quizzes that target their CURRENT room, and only their
// own attempt (D6). Anything else is 404 QUIZ_NOT_FOUND.
//
// What a student sees (approved Q1 and the privacy rules):
//   - no attempt (also on a CLOSED quiz): metadata only (title,
//     instructions, total marks, time limit, number of questions), never
//     the questions or answer keys;
//   - an attempt: the questions through the projection (no answer keys) and
//     the student's own attempt: resume data while in progress, the total
//     score once submitted, and the review (correct answers, per-question
//     results) only once the quiz is CLOSED (buildStudentResult);
//   - raw grading is never sent.
//
// Lock order for the later write steps (Stage 3.0, D4): session FOR KEY
// SHARE, enrolment re-check, room, quiz FOR KEY SHARE (lockActivityShared),
// then the student's own attempt FOR UPDATE (lockOwnQuizAttemptForUpdate).
// The quiz row is never locked after an attempt row.

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import { breakoutError } from "@/lib/breakout-activities/errors";
import {
  activityTargetsRoom,
  defaultStudentRoomResolver,
  requireStudentRoom,
  type StudentRoom,
  type StudentRoomResolver,
} from "@/lib/breakout-activities/room-resolver";
import {
  serializeAttemptForStudent,
  serializeAttemptSummaryForStudent,
  serializeQuizForStudent,
  serializeQuizSummaryForStudent,
} from "@/lib/breakout-activities/serialize";
import { lockActivityShared, lockOwnQuizAttemptForUpdate } from "@/lib/breakout-activities/locks";
import { lockEnrolledActiveSession, requireEnrolledStudentSessionAccess } from "@/lib/breakout-activities/student-access";
import { requireRouteId } from "@/lib/breakout-activities/teacher-access";
import { computeScores, gradeAttempt, type QuizDefinition } from "@/lib/breakout-activities/marking.mjs";
import { mergeQuizAnswers, storedQuizDefinitionSchema } from "@/lib/breakout-activities/validation";
import { autoSubmittedAt, isPastGrace, QUIZ_DEADLINE_GRACE_MS } from "@/lib/breakout-activities/quiz-deadline";
import { assertNotGroupActivity, INDIVIDUAL_ONLY } from "@/lib/breakout-activities/groups/work-mode";

import { inBreakoutTransaction } from "./breakout-assignment-service";

export type StudentQuizServiceOptions = {
  /** Trusted room resolution (Phase 2b); the default fails closed (404). */
  roomResolver?: StudentRoomResolver;
};

const VISIBLE_STATES = ["PUBLISHED", "CLOSED"] as const;

const QUIZ_STUDENT_SELECT = {
  id: true,
  targetRoomType: true,
  targetRoomId: true,
  targetRoomName: true,
  title: true,
  instructions: true,
  totalMarks: true,
  timeLimitSeconds: true,
  state: true,
  publishedAt: true,
  closedAt: true,
  questions: true,
} as const;

/** Everything of the student's own attempt the student views need (no raw grading leaves this module). */
const ATTEMPT_STUDENT_SELECT = {
  quizId: true,
  attemptStatus: true,
  answers: true,
  revision: true,
  grading: true,
  finalScore: true,
  startedAt: true,
  deadlineAt: true,
  lastSavedAt: true,
  submittedAt: true,
} as const;

/** Prisma filter for "targets this room" (the same rule as activityTargetsRoom). */
function roomFilter(room: StudentRoom) {
  return room.type === "MAIN" ? { targetRoomType: "MAIN" as const } : { targetRoomType: "BREAKOUT" as const, targetRoomId: room.id };
}

async function resolveAccessAndRoom(studentId: string, sessionId: string, options: StudentQuizServiceOptions) {
  const access = await requireEnrolledStudentSessionAccess(prisma, studentId, sessionId);
  const room = await requireStudentRoom({ sessionId: access.sessionId, studentId }, options.roomResolver ?? defaultStudentRoomResolver);
  return { sessionId: access.sessionId, room };
}

/**
 * The quizzes of the student's current room (oldest first): metadata only
 * (no questions), each with the student's own attempt summary (status,
 * times, and the total score once submitted).
 */
export async function listQuizzesForStudent(input: { studentId: string; sessionId: string }, options: StudentQuizServiceOptions = {}) {
  const { sessionId, room } = await resolveAccessAndRoom(input.studentId, input.sessionId, options);
  const rows = (
    await prisma.breakoutQuiz.findMany({
      where: { classSessionId: sessionId, status: 0, state: { in: [...VISIBLE_STATES] }, workMode: INDIVIDUAL_ONLY, ...roomFilter(room) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: QUIZ_STUDENT_SELECT,
    })
  ).filter((row) => activityTargetsRoom(row, room));

  const ids = rows.map((row) => row.id);
  const attempts = ids.length
    ? await prisma.breakoutQuizSubmission.findMany({
        where: { classSessionId: sessionId, studentId: input.studentId, quizId: { in: ids } },
        select: ATTEMPT_STUDENT_SELECT,
      })
    : [];
  const attemptOf = new Map(attempts.map((a) => [a.quizId, a]));

  // Lazy auto-submit (D8): only attempts past deadlineAt + 5 s; none -> no transaction.
  const now = await serverNow();
  for (const [quizId, attempt] of attemptOf) {
    if (attempt.attemptStatus === "IN_PROGRESS" && isPastGrace(attempt.deadlineAt, now)) {
      attemptOf.set(quizId, await autoSubmitIfExpired({ studentId: input.studentId, sessionId, quizId }, options));
    }
  }

  return {
    room: { type: room.type },
    quizzes: rows.map((row) => {
      const definition = storedQuizDefinitionSchema.parse(row.questions);
      return {
        ...serializeQuizSummaryForStudent(row, definition.questions.length),
        mine: serializeAttemptSummaryForStudent(attemptOf.get(row.id) ?? null, row.totalMarks),
      };
    }),
  };
}

/**
 * One quiz of the student's current room. Without an attempt: metadata only
 * (Q1), also when CLOSED. With an attempt: the questions (projection, no
 * answer keys) and the student's own attempt view (the review only once
 * CLOSED). `serverNow` lets the client show the deadline on the server's
 * clock.
 */
export async function getQuizForStudent(input: { studentId: string; sessionId: string; quizId: string }, options: StudentQuizServiceOptions = {}) {
  const { sessionId, room } = await resolveAccessAndRoom(input.studentId, input.sessionId, options);
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  const row = await prisma.breakoutQuiz.findFirst({
    where: { id: quizId, classSessionId: sessionId, status: 0, state: { in: [...VISIBLE_STATES] }, workMode: INDIVIDUAL_ONLY },
    select: QUIZ_STUDENT_SELECT,
  });
  if (!row || !activityTargetsRoom(row, room)) throw breakoutError("QUIZ_NOT_FOUND");

  const definition = storedQuizDefinitionSchema.parse(row.questions);
  let attempt = await prisma.breakoutQuizSubmission.findFirst({
    where: { quizId: row.id, classSessionId: sessionId, studentId: input.studentId },
    select: ATTEMPT_STUDENT_SELECT,
  });
  const now = await serverNow();

  // Lazy auto-submit (D8): only past deadlineAt + 5 s; otherwise this read stays lock-free.
  if (attempt && attempt.attemptStatus === "IN_PROGRESS" && isPastGrace(attempt.deadlineAt, now)) {
    attempt = await autoSubmitIfExpired({ studentId: input.studentId, sessionId, quizId: row.id }, options);
  }

  if (!attempt) {
    return {
      quiz: serializeQuizSummaryForStudent(row, definition.questions.length),
      attempt: { attemptStatus: null },
      serverNow: now.toISOString(),
    };
  }
  return {
    quiz: serializeQuizForStudent(row, definition),
    attempt: serializeAttemptForStudent({ quizState: row.state, definition, totalMarks: row.totalMarks, attempt }),
    serverNow: now.toISOString(),
  };
}

// ---- Start (Stage 3.2.2) ---------------------------------------------------------

/**
 * Starts the student's attempt, or returns the one they already have.
 *
 * One transaction, in the approved lock order: session FOR KEY SHARE,
 * enrolment re-checked on the locked row, the current room (resolved now),
 * the quiz FOR KEY SHARE (visible: status 0, PUBLISHED / CLOSED, this room),
 * then the student's own attempt FOR UPDATE.
 *
 * - An existing attempt is returned as it is (never a second one), except
 *   that on a CLOSED quiz an attempt still IN_PROGRESS is auto-submitted
 *   first with its saved answers (re-checked under the attempt lock).
 * - No attempt: only a PUBLISHED quiz creates one (CLOSED: 409 QUIZ_CLOSED).
 *   It is inserted with createMany({ skipDuplicates }) (INSERT ... ON CONFLICT
 *   DO NOTHING on the unique (quizId, studentId)): a concurrent start waits
 *   for the other insert and then does nothing, and both lock and return the
 *   same row. startedAt and deadlineAt come from ONE database-clock value
 *   (deadlineAt = startedAt + timeLimitSeconds, or null), as does updatedAt.
 *
 * The response carries the questions (projection, no answer keys) now that
 * the attempt exists (Q1), and the student's own attempt view (the review
 * only once CLOSED; never raw grading).
 */
export async function startQuizAttempt(input: { studentId: string; sessionId: string; quizId: string }, options: StudentQuizServiceOptions = {}) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  await assertNotGroupActivity("quiz", quizId, "QUIZ_NOT_FOUND");
  await serverNow();
  const result = await inBreakoutTransaction(async (tx) => {
    const session = await lockEnrolledActiveSession(tx, input.studentId, input.sessionId);
    const room = await requireStudentRoom({ sessionId: session.id, studentId: input.studentId }, options.roomResolver ?? defaultStudentRoomResolver);
    const quizLock = await lockActivityShared(tx, session, "quiz", quizId);
    if (!quizLock || quizLock.status !== 0 || quizLock.state === "DRAFT" || !activityTargetsRoom(quizLock, room)) {
      throw breakoutError("QUIZ_NOT_FOUND");
    }
    const row = await tx.breakoutQuiz.findUniqueOrThrow({ where: { id: quizLock.id }, select: QUIZ_STUDENT_SELECT });
    const definition = storedQuizDefinitionSchema.parse(row.questions);

    let locked = await lockOwnQuizAttemptForUpdate(tx, quizLock, input.studentId);
    let created = false;
    if (!locked) {
      if (quizLock.state !== "PUBLISHED") throw breakoutError("QUIZ_CLOSED");
      const now = serverNowSync();
      const deadlineAt = row.timeLimitSeconds ? new Date(now.getTime() + row.timeLimitSeconds * 1000) : null;
      const inserted = await tx.breakoutQuizSubmission.createMany({
        data: [
          {
            id: randomUUID(),
            quizId: quizLock.id,
            classSessionId: session.id,
            studentId: input.studentId,
            attemptStatus: "IN_PROGRESS",
            answers: {} as Prisma.InputJsonValue,
            revision: 0,
            startedAt: now,
            deadlineAt,
            updatedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      created = inserted.count === 1;
      locked = await lockOwnQuizAttemptForUpdate(tx, quizLock, input.studentId);
      if (!locked) throw new Error("The started quiz attempt could not be found.");
    }
    let attempt = await tx.breakoutQuizSubmission.findUniqueOrThrow({ where: { id: locked.id }, select: ATTEMPT_STUDENT_SELECT });
    // A CLOSED quiz (the state read under the quiz share lock) with an attempt
    // still IN_PROGRESS (re-read above under the attempt lock): its close did
    // not auto-submit it, so it is auto-submitted now with its SAVED answers,
    // like a save or submit would. Already SUBMITTED / AUTO_SUBMITTED: returned
    // as it is (scores and teacher overrides kept). Never a second attempt.
    if (quizLock.state === "CLOSED" && attempt.attemptStatus === "IN_PROGRESS") {
      attempt = await autoSubmitLockedAttempt(tx, locked.id, definition, attempt, serverNowSync());
    }
    return { row, definition, attempt, created };
  });
  return {
    quiz: serializeQuizForStudent(result.row, result.definition),
    attempt: serializeAttemptForStudent({
      quizState: result.row.state,
      definition: result.definition,
      totalMarks: result.row.totalMarks,
      attempt: result.attempt,
    }),
    started: result.created,
    serverNow: serverNowSync().toISOString(),
  };
}

// ---- Save answers (Stage 3.2.3) ----------------------------------------------------

// The grace period, the expiry check and the auto-submit time live in
// lib/breakout-activities/quiz-deadline.ts (shared with the teacher's close).
export { QUIZ_DEADLINE_GRACE_MS };

type Tx = Prisma.TransactionClient;

/**
 * Auto-submits a locked IN_PROGRESS attempt with its SAVED answers (graded
 * now with the approved marking). Runs inside the caller's transaction,
 * which must then COMMIT (return, never throw) so the auto-submit is kept.
 * submittedAt = when the attempt ended: min(now, deadlineAt + 5 s), or now
 * when untimed (quiz-deadline.ts autoSubmittedAt); updatedAt = now (the
 * database clock of this write).
 */
async function autoSubmitLockedAttempt(
  tx: Tx,
  attemptId: string,
  definition: QuizDefinition,
  attempt: { answers: unknown; deadlineAt: Date | null },
  now: Date
) {
  const grading = gradeAttempt(definition, attempt.answers as never);
  const scores = computeScores(grading);
  return tx.breakoutQuizSubmission.update({
    where: { id: attemptId },
    data: {
      attemptStatus: "AUTO_SUBMITTED",
      submittedAt: autoSubmittedAt(attempt.deadlineAt, now),
      grading: grading as unknown as Prisma.InputJsonValue,
      autoScore: scores.autoScore,
      finalScore: scores.finalScore,
      updatedAt: now,
    },
    select: ATTEMPT_STUDENT_SELECT,
  });
}

/**
 * Lock-order levels 1-4 for a write on the student's own attempt: session
 * FOR KEY SHARE, enrolment re-check, the room (now), quiz FOR KEY SHARE
 * (visible), then the student's own attempt FOR UPDATE.
 */
async function lockOwnAttempt(tx: Tx, studentId: string, sessionId: string, quizId: string, options: StudentQuizServiceOptions) {
  const session = await lockEnrolledActiveSession(tx, studentId, sessionId);
  const room = await requireStudentRoom({ sessionId: session.id, studentId }, options.roomResolver ?? defaultStudentRoomResolver);
  const quizLock = await lockActivityShared(tx, session, "quiz", quizId);
  if (!quizLock || quizLock.status !== 0 || quizLock.state === "DRAFT" || !activityTargetsRoom(quizLock, room)) {
    throw breakoutError("QUIZ_NOT_FOUND");
  }
  const row = await tx.breakoutQuiz.findUniqueOrThrow({ where: { id: quizLock.id }, select: QUIZ_STUDENT_SELECT });
  const definition = storedQuizDefinitionSchema.parse(row.questions);
  const locked = await lockOwnQuizAttemptForUpdate(tx, quizLock, studentId);
  if (!locked) throw breakoutError("QUIZ_NOT_STARTED");
  const attempt = await tx.breakoutQuizSubmission.findUniqueOrThrow({ where: { id: locked.id }, select: ATTEMPT_STUDENT_SELECT });
  return { quizLock, row, definition, attemptId: locked.id, attempt };
}

export type SaveQuizAnswersInput = {
  studentId: string;
  sessionId: string;
  quizId: string;
  /** The revision the student last saw. */
  revision: number;
  /** Only the questions being saved (D5): the others keep their saved answers. */
  answers: unknown;
};

/**
 * Saves part of the student's answers (D5 merge) on their IN_PROGRESS
 * attempt.
 *
 * - No attempt: 409 QUIZ_NOT_STARTED. Submitted / auto-submitted: 409
 *   QUIZ_ALREADY_SUBMITTED.
 * - Deadline (Q3): allowed while now <= deadlineAt + 5 s (inclusive). Past
 *   that the saved answers are auto-submitted and COMMITTED, and the call
 *   then fails with 409 QUIZ_TIME_UP, the safe result in `details` (Q4).
 * - Stale revision: 409 REVISION_CONFLICT with the saved answers and
 *   revision; nothing changes.
 * - Invalid answers (unknown question, wrong kind, unknown option, reserved
 *   keys, too long): 400; corrupt stored answers: refused (500), never
 *   overwritten.
 * - Success: revision + 1 (exactly once), lastSavedAt and updatedAt from the
 *   database clock.
 */
export async function saveQuizAnswers(input: SaveQuizAnswersInput, options: StudentQuizServiceOptions = {}) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  if (!Number.isInteger(input.revision) || input.revision < 0) throw breakoutError("VALIDATION_ERROR", "Invalid revision.");
  await assertNotGroupActivity("quiz", quizId, "QUIZ_NOT_FOUND");
  await serverNow();

  const outcome = await inBreakoutTransaction(async (tx) => {
    const { quizLock, row, definition, attemptId, attempt } = await lockOwnAttempt(tx, input.studentId, input.sessionId, quizId, options);
    const view = (current: typeof attempt) =>
      serializeAttemptForStudent({ quizState: row.state, definition, totalMarks: row.totalMarks, attempt: current });

    if (attempt.attemptStatus !== "IN_PROGRESS") throw breakoutError("QUIZ_ALREADY_SUBMITTED");

    const now = serverNowSync();
    // A closed quiz's in-progress attempts are auto-submitted by the close;
    // should one remain, it is auto-submitted here (kept), never saved.
    if (quizLock.state === "CLOSED" || isPastGrace(attempt.deadlineAt, now)) {
      const submitted = await autoSubmitLockedAttempt(tx, attemptId, definition, attempt, now);
      return { kind: quizLock.state === "CLOSED" ? ("closed" as const) : ("time_up" as const), result: view(submitted) };
    }

    if (attempt.revision !== input.revision) {
      throw breakoutError("REVISION_CONFLICT", undefined, { answers: attempt.answers ?? {}, revision: attempt.revision });
    }

    const merged = mergeQuizAnswers(definition, attempt.answers, input.answers);
    if (!merged.ok) {
      if (merged.reason === "STORED_ANSWERS_CORRUPT") {
        // A server fault (500, logged by the route): never overwritten.
        throw new Error(`Stored answers of breakout quiz attempt ${attemptId} are invalid; save refused.`);
      }
      throw breakoutError("VALIDATION_ERROR", merged.error);
    }

    const saved = await tx.breakoutQuizSubmission.update({
      where: { id: attemptId },
      data: {
        answers: merged.answers as unknown as Prisma.InputJsonValue,
        revision: attempt.revision + 1,
        lastSavedAt: now,
        updatedAt: now,
      },
      select: ATTEMPT_STUDENT_SELECT,
    });
    return { kind: "saved" as const, result: view(saved) };
  });

  // Raised only now, after the auto-submit was committed (Q4).
  if (outcome.kind === "time_up") throw breakoutError("QUIZ_TIME_UP", undefined, { attempt: outcome.result });
  if (outcome.kind === "closed") throw breakoutError("QUIZ_CLOSED", undefined, { attempt: outcome.result });
  return { attempt: outcome.result };
}

// ---- Submit (Stage 3.2.4) ------------------------------------------------------------

export type SubmitQuizAttemptInput = {
  studentId: string;
  sessionId: string;
  quizId: string;
  /** The revision the student last saw: they submit exactly what they confirmed (Q5). */
  revision: number;
};

/**
 * Submits the student's attempt: grades the SAVED answers (never any sent
 * with the submit) with the approved marking (gradeAttempt / computeScores:
 * multiple-answer option A, short answers normalized with ZWJ / ZWNJ kept).
 *
 * In the approved lock order (session, enrolment, room, quiz FOR KEY SHARE,
 * own attempt FOR UPDATE), then:
 * - no attempt: 409 QUIZ_NOT_STARTED;
 * - already SUBMITTED / AUTO_SUBMITTED: the existing result, nothing graded
 *   or written again (teacher overrides and finalScore are kept);
 * - past deadlineAt + 5 s (strictly; exactly +5 s still submits): the saved
 *   answers are auto-submitted and the call returns 200 with
 *   attemptStatus AUTO_SUBMITTED (Q4); untimed attempts never expire;
 * - a stale revision: 409 REVISION_CONFLICT with the saved answers and
 *   revision; nothing changes;
 * - otherwise SUBMITTED, with submittedAt, grading, autoScore = finalScore
 *   and updatedAt from one database-clock value.
 *
 * The result is the student view: the total score until the quiz is CLOSED,
 * the review after it; raw grading never.
 */
export async function submitQuizAttempt(input: SubmitQuizAttemptInput, options: StudentQuizServiceOptions = {}) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  if (!Number.isInteger(input.revision) || input.revision < 0) throw breakoutError("VALIDATION_ERROR", "Invalid revision.");
  await assertNotGroupActivity("quiz", quizId, "QUIZ_NOT_FOUND");
  await serverNow();

  return inBreakoutTransaction(async (tx) => {
    const { quizLock, row, definition, attemptId, attempt } = await lockOwnAttempt(tx, input.studentId, input.sessionId, quizId, options);
    const view = (current: typeof attempt) =>
      serializeAttemptForStudent({ quizState: row.state, definition, totalMarks: row.totalMarks, attempt: current });

    // A repeat: the stored result as it is (no second grading, overrides kept).
    if (attempt.attemptStatus !== "IN_PROGRESS") return { attempt: view(attempt), replayed: true };

    const now = serverNowSync();
    // Too late (or, defensively, the quiz already closed): the SAVED answers
    // are auto-submitted; this transaction then commits normally.
    if (quizLock.state === "CLOSED" || isPastGrace(attempt.deadlineAt, now)) {
      const submitted = await autoSubmitLockedAttempt(tx, attemptId, definition, attempt, now);
      return { attempt: view(submitted), replayed: false };
    }

    if (attempt.revision !== input.revision) {
      throw breakoutError("REVISION_CONFLICT", undefined, { answers: attempt.answers ?? {}, revision: attempt.revision });
    }

    const grading = gradeAttempt(definition, attempt.answers as never);
    const scores = computeScores(grading);
    const submitted = await tx.breakoutQuizSubmission.update({
      where: { id: attemptId },
      data: {
        attemptStatus: "SUBMITTED",
        submittedAt: now,
        grading: grading as unknown as Prisma.InputJsonValue,
        autoScore: scores.autoScore,
        finalScore: scores.finalScore,
        updatedAt: now,
      },
      select: ATTEMPT_STUDENT_SELECT,
    });
    return { attempt: view(submitted), replayed: false };
  });
}

// ---- Lazy auto-submit on reads (Stage 3.2.5) -------------------------------------------

/**
 * Auto-submits the student's expired attempt found by a read (approved D8,
 * until the Step 4 sweeper exists). Its own transaction, in the approved
 * lock order (session FOR KEY SHARE, enrolment re-check, room, quiz FOR KEY
 * SHARE, then the attempt FOR UPDATE: the quiz always before the attempt).
 *
 * Status and deadline are checked AGAIN under the attempt lock: a concurrent
 * read (or save / submit / teacher close) that got there first already
 * changed it, and this one then writes nothing and returns the row as it is.
 * Only IN_PROGRESS attempts with a deadline, strictly past deadlineAt + 5 s,
 * are auto-submitted, with their SAVED answers.
 */
async function autoSubmitIfExpired(input: { studentId: string; sessionId: string; quizId: string }, options: StudentQuizServiceOptions) {
  await serverNow();
  return inBreakoutTransaction(async (tx) => {
    const { definition, attemptId, attempt } = await lockOwnAttempt(tx, input.studentId, input.sessionId, input.quizId, options);
    const now = serverNowSync();
    if (attempt.attemptStatus !== "IN_PROGRESS" || !isPastGrace(attempt.deadlineAt, now)) return attempt;
    return autoSubmitLockedAttempt(tx, attemptId, definition, attempt, now);
  });
}
