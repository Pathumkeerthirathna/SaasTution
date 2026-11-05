// Breakout Room Activities: teacher-side quiz service (Phase 2a Step 2).
//
// Same transaction and lock rules as breakout-assignment-service.ts (and the
// same two helpers: inBreakoutTransaction, lockOwnedActiveSession). Lock
// order:
//   1. session row FOR KEY SHARE (owned, active);
//   2. quiz row FOR UPDATE (state changes, edits, delete);
//   4. attempt rows FOR UPDATE: every IN_PROGRESS attempt in id order (close),
//      or the one attempt being graded (override; level 2 is skipped, the
//      quiz row is only read, so the order never goes back up).
// MANDATORY for the Step 3 student services as well: a transaction that has
// locked an attempt row must NEVER then lock the quiz row (quiz close holds
// the quiz lock while it waits for attempt locks: the reverse order would
// deadlock). Student attempt writes lock the session, then only their own
// attempt row, and read the quiz without locking it.
//
// The stored definition holds the answer keys: it is built server-side
// (assignServerIds: server ids, keys by id), totalMarks is computed from it,
// and it is re-validated whenever it is read (storedQuizDefinitionSchema).
// Only the session's own teacher gets it here; students get the projection
// (Step 3).
//
// Timestamps (mandatory for every breakout write, including Step 3):
// createdAt, updatedAt, publishedAt, closedAt, submittedAt (auto-submit) and
// overriddenAt are passed EXPLICITLY from the database clock (serverNow()
// once before the transaction, then serverNowSync()), never left to database
// defaults or to Prisma's @updatedAt (this server's own clock).
//
// Stored grading is re-validated against the definition before an override
// is applied (parseStoredGrading); a corrupt grading is a server fault
// (500, logged) and is never silently replaced by a re-grade.

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import { breakoutError } from "@/lib/breakout-activities/errors";
import { lockActivityForUpdate, lockInProgressAttemptsForUpdate, lockQuizAttemptForUpdate } from "@/lib/breakout-activities/locks";
import { applyOverrides, computeScores, computeTotalMarks, gradeAttempt, type QuizDefinition, type QuizGrading } from "@/lib/breakout-activities/marking.mjs";
import {
  serializeQuizAttemptForTeacher,
  serializeQuizForTeacher,
  type QuizCounts,
  type StudentRef,
} from "@/lib/breakout-activities/serialize";
import { resolveTargets } from "@/lib/breakout-activities/target-rooms";
import { requireRouteId, requireTeacherSessionAccess } from "@/lib/breakout-activities/teacher-access";
import {
  assignServerIds,
  parseStoredGrading,
  storedQuizDefinitionSchema,
  type BreakoutTarget,
  type GradingOverridesInput,
  type QuizDefinitionInput,
} from "@/lib/breakout-activities/validation";

import { inBreakoutTransaction, lockOwnedActiveSession, type BreakoutServiceOptions } from "./breakout-assignment-service";

const QUIZ_VIEW_SELECT = {
  id: true,
  publishGroupId: true,
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
  createdAt: true,
  updatedAt: true,
} as const;

const asJson = (value: unknown) => value as Prisma.InputJsonValue;

/** The stored definition, re-validated (a corrupt row fails loudly, never half-graded). */
function storedDefinition(questions: unknown): QuizDefinition {
  return storedQuizDefinitionSchema.parse(questions);
}

/** "" clears the optional instructions (approved); stored as null. */
const optionalInstructions = (value: string | undefined) => (value === undefined || value.trim() === "" ? null : value);

// ---- Create ------------------------------------------------------------------

export type CreateQuizzesInput = {
  teacherId: string;
  sessionId: string;
  title: string;
  instructions?: string;
  timeLimitSeconds?: number | null;
  questions: QuizDefinitionInput;
  targets: BreakoutTarget[];
  publish: boolean;
};

/**
 * One quiz per target, sharing one publishGroupId and one definition. With
 * publish: true the whole group is published in the same transaction. All
 * or nothing: an unresolvable BREAKOUT target refuses everything (409
 * ROOM_UNKNOWN).
 */
export async function createQuizzes(input: CreateQuizzesInput, options: BreakoutServiceOptions = {}) {
  const definition = assignServerIds(input.questions);
  const totalMarks = computeTotalMarks(definition);
  await serverNow();
  const result = await inBreakoutTransaction(async (tx) => {
    const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
    const targets = await resolveTargets(input.targets, { sessionId: session.id, teacherId: input.teacherId }, options.roomDirectory);
    const now = serverNowSync();
    const publishGroupId = randomUUID();
    const quizzes = [];
    for (const target of targets) {
      quizzes.push(
        await tx.breakoutQuiz.create({
          data: {
            id: randomUUID(),
            classSessionId: session.id,
            teacherId: input.teacherId,
            publishGroupId,
            targetRoomType: target.targetRoomType,
            targetRoomId: target.targetRoomId,
            targetRoomName: target.targetRoomName,
            title: input.title,
            instructions: optionalInstructions(input.instructions),
            questions: asJson(definition),
            totalMarks,
            timeLimitSeconds: input.timeLimitSeconds ?? null,
            state: input.publish ? "PUBLISHED" : "DRAFT",
            publishedAt: input.publish ? now : null,
            createdAt: now,
            updatedAt: now,
          },
          select: QUIZ_VIEW_SELECT,
        })
      );
    }
    return { publishGroupId, quizzes };
  });
  return { publishGroupId: result.publishGroupId, quizzes: result.quizzes.map((row) => serializeQuizForTeacher(row)) };
}

// ---- State changes (per activity) ---------------------------------------------

export type QuizStateInput = { teacherId: string; sessionId: string; quizId: string; action: "publish" | "close" };

/**
 * DRAFT -> PUBLISHED -> CLOSED, this quiz only. Repeating the current state
 * changes nothing. Closing auto-submits every IN_PROGRESS attempt with its
 * saved answers (graded now); SUBMITTED / AUTO_SUBMITTED attempts are not
 * touched. Publish a CLOSED one: 409 QUIZ_CLOSED; close a DRAFT: 409
 * ACTIVITY_NOT_PUBLISHED.
 */
export async function setQuizState(input: QuizStateInput) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  await serverNow();
  const result = await inBreakoutTransaction(async (tx) => {
    const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
    const activity = await lockActivityForUpdate(tx, session, "quiz", quizId);
    if (!activity || activity.status !== 0) throw breakoutError("QUIZ_NOT_FOUND");

    let autoSubmitted = 0;
    const now = serverNowSync();
    let data: Prisma.BreakoutQuizUpdateInput | null = null;
    if (input.action === "publish") {
      if (activity.state === "CLOSED") throw breakoutError("QUIZ_CLOSED");
      if (activity.state === "DRAFT") data = { state: "PUBLISHED", publishedAt: now, updatedAt: now };
    } else if (input.action === "close") {
      if (activity.state === "DRAFT") throw breakoutError("ACTIVITY_NOT_PUBLISHED");
      if (activity.state === "PUBLISHED") {
        data = { state: "CLOSED", closedAt: now, updatedAt: now };
        const attemptIds = await lockInProgressAttemptsForUpdate(tx, session, quizId);
        if (attemptIds.length > 0) {
          const quiz = await tx.breakoutQuiz.findUniqueOrThrow({ where: { id: quizId }, select: { questions: true } });
          const definition = storedDefinition(quiz.questions);
          for (const attemptId of attemptIds) {
            const attempt = await tx.breakoutQuizSubmission.findUniqueOrThrow({ where: { id: attemptId }, select: { answers: true } });
            const grading = gradeAttempt(definition, attempt.answers as never);
            const scores = computeScores(grading);
            await tx.breakoutQuizSubmission.update({
              where: { id: attemptId },
              data: {
                attemptStatus: "AUTO_SUBMITTED",
                submittedAt: now,
                grading: asJson(grading),
                autoScore: scores.autoScore,
                finalScore: scores.finalScore,
                updatedAt: now,
              },
            });
            autoSubmitted += 1;
          }
        }
      }
    } else {
      throw breakoutError("VALIDATION_ERROR", "Unknown action.");
    }

    const row = data
      ? await tx.breakoutQuiz.update({ where: { id: quizId }, data, select: QUIZ_VIEW_SELECT })
      : await tx.breakoutQuiz.findUniqueOrThrow({ where: { id: quizId }, select: QUIZ_VIEW_SELECT });
    return { row, changed: data !== null, autoSubmitted };
  });
  return { quiz: serializeQuizForTeacher(result.row), changed: result.changed, autoSubmitted: result.autoSubmitted };
}

// ---- DRAFT edits / delete -------------------------------------------------------

export type EditQuizInput = {
  teacherId: string;
  sessionId: string;
  quizId: string;
  title?: string;
  instructions?: string;
  timeLimitSeconds?: number | null;
  questions?: QuizDefinitionInput;
};

/**
 * Edits a DRAFT (PUBLISHED: 409 ACTIVITY_NOT_DRAFT; CLOSED: 409
 * QUIZ_CLOSED). New questions replace the definition (server ids, answer
 * keys) and totalMarks is recomputed; a DRAFT has no attempts.
 */
export async function editQuiz(input: EditQuizInput) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  if (input.title === undefined && input.instructions === undefined && input.timeLimitSeconds === undefined && input.questions === undefined) {
    throw breakoutError("VALIDATION_ERROR", "Nothing to change.");
  }
  const definition = input.questions !== undefined ? assignServerIds(input.questions) : null;
  await serverNow();
  const row = await inBreakoutTransaction(async (tx) => {
    const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
    const activity = await lockActivityForUpdate(tx, session, "quiz", quizId);
    if (!activity || activity.status !== 0) throw breakoutError("QUIZ_NOT_FOUND");
    if (activity.state === "CLOSED") throw breakoutError("QUIZ_CLOSED");
    if (activity.state !== "DRAFT") throw breakoutError("ACTIVITY_NOT_DRAFT");

    const data: Prisma.BreakoutQuizUpdateInput = { updatedAt: serverNowSync() };
    if (input.title !== undefined) data.title = input.title;
    if (input.instructions !== undefined) data.instructions = optionalInstructions(input.instructions);
    if (input.timeLimitSeconds !== undefined) data.timeLimitSeconds = input.timeLimitSeconds;
    if (definition) {
      data.questions = asJson(definition);
      data.totalMarks = computeTotalMarks(definition);
    }
    return tx.breakoutQuiz.update({ where: { id: quizId }, data, select: QUIZ_VIEW_SELECT });
  });
  return { quiz: serializeQuizForTeacher(row) };
}

/** Soft-deletes a DRAFT (status = 1). PUBLISHED: 409 ACTIVITY_NOT_DRAFT; CLOSED: 409 QUIZ_CLOSED. */
export async function deleteQuiz(input: { teacherId: string; sessionId: string; quizId: string }) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  await serverNow();
  return inBreakoutTransaction(async (tx) => {
    const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
    const activity = await lockActivityForUpdate(tx, session, "quiz", quizId);
    if (!activity || activity.status !== 0) throw breakoutError("QUIZ_NOT_FOUND");
    if (activity.state === "CLOSED") throw breakoutError("QUIZ_CLOSED");
    if (activity.state !== "DRAFT") throw breakoutError("ACTIVITY_NOT_DRAFT");
    await tx.breakoutQuiz.update({ where: { id: quizId }, data: { status: 1, updatedAt: serverNowSync() } });
    return { id: quizId, status: 1 as const };
  });
}

// ---- Grading overrides ---------------------------------------------------------

export type OverrideGradingInput = {
  teacherId: string;
  sessionId: string;
  quizId: string;
  submissionId: string;
  overrides: GradingOverridesInput["overrides"];
};

/**
 * Teacher mark overrides (approved restrictions): the session active, the
 * quiz PUBLISHED or CLOSED (DRAFT: 409 ACTIVITY_NOT_PUBLISHED), the attempt
 * SUBMITTED or AUTO_SUBMITTED (IN_PROGRESS: 409 QUIZ_NOT_SUBMITTED). Marks
 * are range-checked by marking.mjs (400). autoScore is unchanged;
 * finalScore = sum(override ?? auto).
 */
export async function overrideQuizGrading(input: OverrideGradingInput) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  const submissionId = requireRouteId(input.submissionId, "NOT_FOUND");
  await serverNow();
  return inBreakoutTransaction(async (tx) => {
    const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
    const quiz = await tx.breakoutQuiz.findFirst({
      where: { id: quizId, classSessionId: session.id, status: 0 },
      select: { state: true, questions: true },
    });
    if (!quiz) throw breakoutError("QUIZ_NOT_FOUND");
    if (quiz.state === "DRAFT") throw breakoutError("ACTIVITY_NOT_PUBLISHED");

    const locked = await lockQuizAttemptForUpdate(tx, session, quizId, submissionId);
    if (!locked) throw breakoutError("NOT_FOUND");
    const attempt = await tx.breakoutQuizSubmission.findUniqueOrThrow({
      where: { id: submissionId },
      select: { attemptStatus: true, answers: true, grading: true, autoScore: true },
    });
    if (attempt.attemptStatus !== "SUBMITTED" && attempt.attemptStatus !== "AUTO_SUBMITTED") {
      throw breakoutError("QUIZ_NOT_SUBMITTED");
    }

    const definition = storedDefinition(quiz.questions);
    let base: QuizGrading;
    if (attempt.grading === null) {
      // Never graded (should not happen for a submitted attempt): grade it now.
      base = gradeAttempt(definition, attempt.answers as never);
    } else {
      const stored = parseStoredGrading(definition, attempt.grading);
      if (!stored) {
        // Corrupt or not matching this quiz: a server fault. Refused (500, logged
        // by the route); never silently replaced, which would drop overrides.
        throw new Error(`Stored grading of breakout quiz attempt ${submissionId} is invalid; override refused.`);
      }
      base = stored;
    }
    const now = serverNowSync();
    const grading = applyOverrides(base, input.overrides, definition, { teacherId: input.teacherId, now });
    const scores = computeScores(grading);
    const updated = await tx.breakoutQuizSubmission.update({
      where: { id: submissionId },
      data: { grading: asJson(grading), autoScore: scores.autoScore, finalScore: scores.finalScore, overriddenAt: now, updatedAt: now },
      select: { autoScore: true, finalScore: true, grading: true, overriddenAt: true },
    });
    return {
      autoScore: Number(updated.autoScore),
      finalScore: Number(updated.finalScore),
      grading: updated.grading,
      overriddenAt: updated.overriddenAt?.toISOString() ?? null,
    };
  });
}

// ---- Reads (no transaction; ownership checked; any session state) ---------------

/** The session's quizzes (not deleted), oldest first, with attempt counts; no answer keys. */
export async function listQuizzesForTeacher(teacherId: string, sessionId: string) {
  const access = await requireTeacherSessionAccess(prisma, teacherId, sessionId);
  const rows = await prisma.breakoutQuiz.findMany({
    where: { classSessionId: access.sessionId, status: 0 },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: QUIZ_VIEW_SELECT,
  });
  const ids = rows.map((row) => row.id);
  const counts = new Map<string, QuizCounts>(ids.map((id) => [id, { attempts: 0, inProgress: 0, submitted: 0 }]));
  if (ids.length > 0) {
    const attempts = await prisma.breakoutQuizSubmission.findMany({
      where: { classSessionId: access.sessionId, quizId: { in: ids } },
      select: { quizId: true, attemptStatus: true },
    });
    for (const a of attempts) {
      const c = counts.get(a.quizId);
      if (!c) continue;
      c.attempts += 1;
      if (a.attemptStatus === "IN_PROGRESS") c.inProgress += 1;
      else c.submitted += 1;
    }
  }
  return { quizzes: rows.map((row) => serializeQuizForTeacher(row, { counts: counts.get(row.id) })) };
}

async function requireOwnedQuiz(teacherId: string, sessionId: string, quizId: string) {
  const access = await requireTeacherSessionAccess(prisma, teacherId, sessionId);
  const id = requireRouteId(quizId, "QUIZ_NOT_FOUND");
  const quiz = await prisma.breakoutQuiz.findFirst({
    where: { id, classSessionId: access.sessionId, status: 0 },
    select: { ...QUIZ_VIEW_SELECT, questions: true },
  });
  if (!quiz) throw breakoutError("QUIZ_NOT_FOUND");
  return { sessionId: access.sessionId, quiz };
}

/** The full quiz for its own teacher: the definition with answer keys. */
export async function getQuizForTeacher(input: { teacherId: string; sessionId: string; quizId: string }) {
  const { quiz } = await requireOwnedQuiz(input.teacherId, input.sessionId, input.quizId);
  return { quiz: serializeQuizForTeacher({ ...quiz, questions: storedDefinition(quiz.questions) }, { includeDefinition: true }) };
}

/** Every attempt of the quiz, with answers and grading, oldest first. */
export async function listQuizAttemptsForTeacher(input: { teacherId: string; sessionId: string; quizId: string }) {
  const { sessionId, quiz } = await requireOwnedQuiz(input.teacherId, input.sessionId, input.quizId);
  const attempts = await prisma.breakoutQuizSubmission.findMany({
    where: { quizId: quiz.id, classSessionId: sessionId },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      studentId: true,
      attemptStatus: true,
      answers: true,
      revision: true,
      grading: true,
      autoScore: true,
      finalScore: true,
      startedAt: true,
      deadlineAt: true,
      lastSavedAt: true,
      submittedAt: true,
      overriddenAt: true,
    },
  });
  const studentIds = [...new Set(attempts.map((a) => a.studentId))];
  const students = new Map<string, StudentRef>();
  if (studentIds.length > 0) {
    const rows = await prisma.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true, registrationNumber: true } });
    for (const row of rows) students.set(row.id, row);
  }
  return {
    attempts: attempts.map((a) =>
      serializeQuizAttemptForTeacher({
        ...a,
        student: students.get(a.studentId) ?? { id: a.studentId, name: "Unknown student", registrationNumber: null },
      })
    ),
  };
}
