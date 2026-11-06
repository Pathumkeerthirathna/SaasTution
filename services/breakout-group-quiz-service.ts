// Breakout Group Activities: group quizzes.
//
// A GROUP quiz row targets one breakout room, so it has ONE shared attempt
// (BreakoutGroupQuizAttempt) for the room's confirmed members. Everything a
// quiz already does is reused unchanged:
//   - answers in the same shape, saved with the existing per-question merge
//     (mergeQuizAnswers, D5): a save replaces only the questions it sends, so
//     members answering different questions never overwrite each other (the
//     same question: the later save wins, every member sees it on refresh);
//   - the deadline from one database-clock start (deadlineAt = startedAt +
//     timeLimitSeconds) and the lazy auto-submit past deadlineAt + 5 s
//     (quiz-deadline.ts), also when a read finds it; a closed quiz's
//     in-progress attempt is auto-submitted (by the next member or teacher read);
//   - grading and scores (gradeAttempt / computeScores), teacher overrides
//     (applyOverrides), and what a student sees (the projection without
//     answer keys; the score once submitted, the review once CLOSED).
// The submission is final (one per group): it records the submitting
// student (null for an auto-submit) and the confirmed members at that time.
//
// Creation reuses the existing createQuizzes() with workMode GROUP and the
// teacher-confirmed rooms as its trusted room directory. Publish / close /
// edit / delete use the existing teacher routes.
//
// Lock order: student writes = session FOR KEY SHARE + enrolment, membership
// SHARED + active membership, quiz FOR KEY SHARE, group-activity lock.
// Teacher writes (auto-submit on read, override) = the teacher's session FOR
// KEY SHARE, then the group-activity lock (no activity row lock: the
// existing close only locks rows, never group locks, so no cycle).

import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import { breakoutError } from "@/lib/breakout-activities/errors";
import { lockActivityShared, type ActiveSessionLock } from "@/lib/breakout-activities/locks";
import { applyOverrides, computeScores, gradeAttempt, type QuizDefinition, type QuizGrading } from "@/lib/breakout-activities/marking.mjs";
import { autoSubmittedAt, isPastGrace } from "@/lib/breakout-activities/quiz-deadline";
import {
  serializeAttemptForStudent,
  serializeQuizForStudent,
  serializeQuizForTeacher,
  serializeQuizSummaryForStudent,
} from "@/lib/breakout-activities/serialize";
import { requireRouteId, requireTeacherSessionAccess } from "@/lib/breakout-activities/teacher-access";
import {
  mergeQuizAnswers,
  parseStoredGrading,
  storedQuizDefinitionSchema,
  type GradingOverridesInput,
  type QuizDefinitionInput,
} from "@/lib/breakout-activities/validation";
import { activeMemberIds, lockStudentGroup, requireStudentGroup, studentNames, type GroupMembership } from "@/lib/breakout-activities/groups/access";
import { emitGroupChange } from "@/lib/breakout-activities/groups/events";
import { lockGroupActivity } from "@/lib/breakout-activities/groups/locks";
import { answeredCount } from "@/lib/breakout-activities/groups/rules.mjs";
import { nameLookup, serializeGroupAttemptForTeacher, serializeGroupAttemptMeta, type NameOf } from "@/lib/breakout-activities/groups/serialize";
import { confirmedRoomDirectory, type ConfirmedRoom } from "@/lib/breakout-activities/groups/validation";

import { inBreakoutTransaction, lockOwnedActiveSession } from "./breakout-assignment-service";
import { confirmGroupMembers } from "./breakout-group-membership-service";
import { createQuizzes } from "./breakout-quiz-service";

type Tx = Prisma.TransactionClient;

const VISIBLE_STATES = ["PUBLISHED", "CLOSED"] as const;

const QUIZ_SELECT = {
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
  questions: true,
  workMode: true,
} as const;

const ATTEMPT_SELECT = {
  id: true,
  attemptStatus: true,
  answers: true,
  revision: true,
  grading: true,
  autoScore: true,
  finalScore: true,
  startedAt: true,
  startedByStudentId: true,
  deadlineAt: true,
  lastSavedAt: true,
  lastSavedByStudentId: true,
  submittedAt: true,
  submittedByStudentId: true,
  memberStudentIds: true,
  overriddenAt: true,
} as const;

type QuizRow = Prisma.BreakoutQuizGetPayload<{ select: typeof QUIZ_SELECT }>;
type AttemptRow = Prisma.BreakoutGroupQuizAttemptGetPayload<{ select: typeof ATTEMPT_SELECT }>;

const notVisible = () => breakoutError("QUIZ_NOT_FOUND");
const asJson = (value: unknown) => value as Prisma.InputJsonValue;

function definitionOf(row: { questions: unknown }): QuizDefinition {
  return storedQuizDefinitionSchema.parse(row.questions);
}

/** Due for the auto-submit: still IN_PROGRESS, and the quiz closed or the time (with grace) over. */
function isDue(attempt: { attemptStatus: string; deadlineAt: Date | null }, quizState: string, now: Date): boolean {
  return attempt.attemptStatus === "IN_PROGRESS" && (quizState === "CLOSED" || isPastGrace(attempt.deadlineAt, now));
}

/** Auto-submits a LOCKED in-progress attempt with its SAVED answers (no submitting student). */
async function autoSubmitLocked(tx: Tx, attempt: AttemptRow, definition: QuizDefinition, members: string[], now: Date): Promise<AttemptRow> {
  const grading = gradeAttempt(definition, attempt.answers as never);
  const scores = computeScores(grading);
  return tx.breakoutGroupQuizAttempt.update({
    where: { id: attempt.id },
    data: {
      attemptStatus: "AUTO_SUBMITTED",
      submittedAt: autoSubmittedAt(attempt.deadlineAt, now),
      submittedByStudentId: null,
      memberStudentIds: asJson(members),
      grading: asJson(grading),
      autoScore: scores.autoScore,
      finalScore: scores.finalScore,
      updatedAt: now,
    },
    select: ATTEMPT_SELECT,
  });
}

async function nameOfFor(db: Pick<Tx, "student">, members: string[], attempt: AttemptRow | null): Promise<NameOf> {
  const snapshot = Array.isArray(attempt?.memberStudentIds) ? (attempt?.memberStudentIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
  const names = await studentNames(db, [...members, ...snapshot, attempt?.startedByStudentId, attempt?.lastSavedByStudentId, attempt?.submittedByStudentId]);
  return nameLookup(names);
}

/** The student view: the existing quiz / attempt projection plus the group's members and who did what. */
function studentView(row: QuizRow, definition: QuizDefinition, attempt: AttemptRow | null, membership: GroupMembership, members: string[], nameOf: NameOf, now: Date) {
  const group = { room: { id: membership.roomId, name: membership.roomName }, members: members.map((id) => nameOf(id)) };
  if (!attempt) {
    return { quiz: serializeQuizSummaryForStudent(row, definition.questions.length), attempt: { attemptStatus: null }, group, activity: null, progress: null, serverNow: now.toISOString() };
  }
  return {
    quiz: serializeQuizForStudent(row, definition),
    attempt: serializeAttemptForStudent({ quizState: row.state, definition, totalMarks: row.totalMarks, attempt }),
    group,
    activity: serializeGroupAttemptMeta(attempt, nameOf),
    progress: { answered: answeredCount(attempt.answers, definition.questions), questions: definition.questions.length },
    serverNow: now.toISOString(),
  };
}

// ---- Teacher: create -------------------------------------------------------------

export type CreateGroupQuizzesInput = {
  teacherId: string;
  sessionId: string;
  title: string;
  instructions?: string;
  timeLimitSeconds?: number | null;
  questions: QuizDefinitionInput;
  rooms: ConfirmedRoom[];
  publish: boolean;
};

/** Confirms the members of the chosen existing rooms, then creates one GROUP quiz per room with the existing createQuizzes(). */
export async function createGroupQuizzes(input: CreateGroupQuizzesInput) {
  const members = await confirmGroupMembers({ teacherId: input.teacherId, sessionId: input.sessionId, rooms: input.rooms });
  const created = await createQuizzes(
    {
      teacherId: input.teacherId,
      sessionId: input.sessionId,
      title: input.title,
      instructions: input.instructions,
      timeLimitSeconds: input.timeLimitSeconds,
      questions: input.questions,
      targets: input.rooms.map((room) => ({ type: "BREAKOUT" as const, id: room.id })),
      publish: input.publish,
      workMode: "GROUP",
    },
    { roomDirectory: confirmedRoomDirectory(input.rooms) }
  );
  return { ...created, rooms: members.rooms };
}

// ---- Student --------------------------------------------------------------------------

async function lockWritableGroupQuiz(tx: Tx, studentId: string, sessionId: string, quizId: string) {
  const { session, membership } = await lockStudentGroup(tx, studentId, sessionId);
  const quizLock = await lockActivityShared(tx, session, "quiz", quizId);
  if (
    !quizLock ||
    quizLock.status !== 0 ||
    quizLock.state === "DRAFT" ||
    quizLock.targetRoomType !== "BREAKOUT" ||
    quizLock.targetRoomId !== membership.roomId
  ) {
    throw notVisible();
  }
  const row = await tx.breakoutQuiz.findUniqueOrThrow({ where: { id: quizLock.id }, select: QUIZ_SELECT });
  if (row.workMode !== "GROUP") throw notVisible();
  const definition = definitionOf(row);
  await lockGroupActivity(tx, session, "quiz", row.id);
  const attempt = await tx.breakoutGroupQuizAttempt.findFirst({ where: { quizId: row.id, classSessionId: session.id }, select: ATTEMPT_SELECT });
  const members = await activeMemberIds(tx, session.id, membership.roomId);
  return { session, membership, quizState: quizLock.state, row, definition, attempt, members };
}

/**
 * One group quiz of the student's group. No attempt yet: metadata only (the
 * existing Q1 rule). Otherwise the questions (no answer keys), the shared
 * answers / result, the members, who started / saved / submitted, progress.
 * An attempt that is due is auto-submitted first (lazy, like the existing quiz).
 */
export async function getGroupQuizForStudent(input: { studentId: string; sessionId: string; quizId: string }) {
  const access = await requireStudentGroup(prisma, input.studentId, input.sessionId);
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  const row = await prisma.breakoutQuiz.findFirst({
    where: {
      id: quizId,
      classSessionId: access.sessionId,
      status: 0,
      state: { in: [...VISIBLE_STATES] },
      workMode: "GROUP",
      targetRoomType: "BREAKOUT",
      targetRoomId: access.membership.roomId,
    },
    select: QUIZ_SELECT,
  });
  if (!row) throw notVisible();
  const now = await serverNow();
  let attempt = await prisma.breakoutGroupQuizAttempt.findFirst({ where: { quizId: row.id, classSessionId: access.sessionId }, select: ATTEMPT_SELECT });
  if (attempt && isDue(attempt, row.state, now)) {
    attempt = await finalizeGroupQuizForStudent(input.studentId, input.sessionId, row.id);
  }
  const members = await activeMemberIds(prisma, access.sessionId, access.membership.roomId);
  const nameOf = await nameOfFor(prisma, members, attempt);
  return studentView(row, definitionOf(row), attempt, access.membership, members, nameOf, now);
}

/**
 * The lazy auto-submit found by a member's read: its own transaction in the
 * student lock order; due-ness is checked AGAIN under the group lock (a
 * concurrent read, save or submit that got there first wins). Returns the attempt.
 */
export async function finalizeGroupQuizForStudent(studentId: string, sessionId: string, quizId: string): Promise<AttemptRow | null> {
  await serverNow();
  const result = await inBreakoutTransaction(async (tx) => {
    const locked = await lockWritableGroupQuiz(tx, studentId, sessionId, quizId);
    const now = serverNowSync();
    if (!locked.attempt || !isDue(locked.attempt, locked.quizState, now)) return { locked, attempt: locked.attempt, changed: false };
    return { locked, attempt: await autoSubmitLocked(tx, locked.attempt, locked.definition, locked.members, now), changed: true };
  });
  if (result.changed && result.attempt) {
    notifyQuiz(result.locked.session.id, quizId, result.locked.membership.roomId, result.attempt.revision, result.locked.members);
  }
  return result.attempt;
}

/** For the overviews: the attempt fields they summarize. */
export type GroupAttemptSummaryRow = AttemptRow;
export { ATTEMPT_SELECT as GROUP_ATTEMPT_SELECT, isDue as isGroupAttemptDue };

/**
 * Starts the group's shared attempt (any member), or returns the existing
 * one: never a second. Only a PUBLISHED quiz starts one (CLOSED: 409
 * QUIZ_CLOSED). The deadline is fixed by this one start for the whole group.
 */
export async function startGroupQuiz(input: { studentId: string; sessionId: string; quizId: string }) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  await serverNow();
  const result = await inBreakoutTransaction(async (tx) => {
    const locked = await lockWritableGroupQuiz(tx, input.studentId, input.sessionId, quizId);
    const now = serverNowSync();
    let attempt = locked.attempt;
    let started = false;
    if (!attempt) {
      if (locked.quizState !== "PUBLISHED") throw breakoutError("QUIZ_CLOSED");
      const deadlineAt = locked.row.timeLimitSeconds ? new Date(now.getTime() + locked.row.timeLimitSeconds * 1000) : null;
      attempt = await tx.breakoutGroupQuizAttempt.create({
        data: {
          id: randomUUID(),
          quizId: locked.row.id,
          classSessionId: locked.session.id,
          attemptStatus: "IN_PROGRESS",
          answers: asJson({}),
          revision: 0,
          startedAt: now,
          startedByStudentId: input.studentId,
          deadlineAt,
          updatedAt: now,
        },
        select: ATTEMPT_SELECT,
      });
      started = true;
    } else if (isDue(attempt, locked.quizState, now)) {
      attempt = await autoSubmitLocked(tx, attempt, locked.definition, locked.members, now);
      started = false;
    }
    return { ...locked, attempt, started, now };
  });
  notifyQuiz(result.session.id, result.row.id, result.membership.roomId, result.attempt.revision, result.members);
  const nameOf = await nameOfFor(prisma, result.members, result.attempt);
  return { ...studentView(result.row, result.definition, result.attempt, result.membership, result.members, nameOf, result.now), started: result.started };
}

export type SaveGroupQuizAnswersInput = { studentId: string; sessionId: string; quizId: string; answers: unknown };

/**
 * Saves some of the group's answers (any member): only the questions sent
 * change (mergeQuizAnswers); the other saved answers are kept, so members
 * can answer different questions at the same time.
 * - Not started: 409 QUIZ_NOT_STARTED; submitted: 409 QUIZ_ALREADY_SUBMITTED.
 * - Time over (past deadlineAt + 5 s) or the quiz closed: the SAVED answers
 *   are auto-submitted and committed, then 409 QUIZ_TIME_UP / QUIZ_CLOSED.
 * - Invalid answers: 400; corrupt stored answers: refused (500), never overwritten.
 */
export async function saveGroupQuizAnswers(input: SaveGroupQuizAnswersInput) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  await serverNow();
  const outcome = await inBreakoutTransaction(async (tx) => {
    const locked = await lockWritableGroupQuiz(tx, input.studentId, input.sessionId, quizId);
    const attempt = locked.attempt;
    if (!attempt) throw breakoutError("QUIZ_NOT_STARTED");
    if (attempt.attemptStatus !== "IN_PROGRESS") throw breakoutError("QUIZ_ALREADY_SUBMITTED");
    const now = serverNowSync();
    if (isDue(attempt, locked.quizState, now)) {
      const submitted = await autoSubmitLocked(tx, attempt, locked.definition, locked.members, now);
      return { kind: locked.quizState === "CLOSED" ? ("closed" as const) : ("time_up" as const), locked, attempt: submitted, now };
    }
    const merged = mergeQuizAnswers(locked.definition, attempt.answers, input.answers);
    if (!merged.ok) {
      if (merged.reason === "STORED_ANSWERS_CORRUPT") {
        throw new Error(`Stored answers of breakout group quiz attempt ${attempt.id} are invalid; save refused.`);
      }
      throw breakoutError("VALIDATION_ERROR", merged.error);
    }
    const saved = await tx.breakoutGroupQuizAttempt.update({
      where: { id: attempt.id },
      data: { answers: asJson(merged.answers), revision: attempt.revision + 1, lastSavedAt: now, lastSavedByStudentId: input.studentId, updatedAt: now },
      select: ATTEMPT_SELECT,
    });
    return { kind: "saved" as const, locked, attempt: saved, now };
  });

  const { locked, attempt, now } = outcome;
  notifyQuiz(locked.session.id, locked.row.id, locked.membership.roomId, attempt.revision, locked.members);
  const nameOf = await nameOfFor(prisma, locked.members, attempt);
  const view = studentView(locked.row, locked.definition, attempt, locked.membership, locked.members, nameOf, now);
  if (outcome.kind === "time_up") throw breakoutError("QUIZ_TIME_UP", undefined, view);
  if (outcome.kind === "closed") throw breakoutError("QUIZ_CLOSED", undefined, view);
  return view;
}

export type SubmitGroupQuizInput = { studentId: string; sessionId: string; quizId: string; revision: number };

/**
 * The group's ONE final quiz submission (any member). Grades the SAVED
 * answers as they are at `revision` (the member confirms what they saw: a
 * stale revision is 409 REVISION_CONFLICT). Already submitted: the stored
 * result (replayed: true), nothing graded or written again. Time over or
 * closed: auto-submitted instead (200, AUTO_SUBMITTED).
 */
export async function submitGroupQuiz(input: SubmitGroupQuizInput) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  if (!Number.isInteger(input.revision) || input.revision < 0) throw breakoutError("VALIDATION_ERROR", "Invalid revision.");
  await serverNow();
  const result = await inBreakoutTransaction(async (tx) => {
    const locked = await lockWritableGroupQuiz(tx, input.studentId, input.sessionId, quizId);
    const attempt = locked.attempt;
    if (!attempt) throw breakoutError("QUIZ_NOT_STARTED");
    const now = serverNowSync();
    if (attempt.attemptStatus !== "IN_PROGRESS") return { locked, attempt, now, replayed: true };
    if (isDue(attempt, locked.quizState, now)) {
      return { locked, attempt: await autoSubmitLocked(tx, attempt, locked.definition, locked.members, now), now, replayed: false };
    }
    if (attempt.revision !== input.revision) {
      throw breakoutError("REVISION_CONFLICT", undefined, { answers: attempt.answers ?? {}, revision: attempt.revision });
    }
    const grading = gradeAttempt(locked.definition, attempt.answers as never);
    const scores = computeScores(grading);
    const submitted = await tx.breakoutGroupQuizAttempt.update({
      where: { id: attempt.id },
      data: {
        attemptStatus: "SUBMITTED",
        submittedAt: now,
        submittedByStudentId: input.studentId,
        memberStudentIds: asJson(locked.members),
        grading: asJson(grading),
        autoScore: scores.autoScore,
        finalScore: scores.finalScore,
        updatedAt: now,
      },
      select: ATTEMPT_SELECT,
    });
    return { locked, attempt: submitted, now, replayed: false };
  });
  const { locked, attempt, now } = result;
  if (!result.replayed) notifyQuiz(locked.session.id, locked.row.id, locked.membership.roomId, attempt.revision, locked.members);
  const nameOf = await nameOfFor(prisma, locked.members, attempt);
  return { ...studentView(locked.row, locked.definition, attempt, locked.membership, locked.members, nameOf, now), replayed: result.replayed };
}

function notifyQuiz(sessionId: string, quizId: string, roomId: string, revision: number, members: string[]) {
  emitGroupChange({ sessionId, kind: "quiz", activityId: quizId, roomId, revision, memberStudentIds: members });
}

// ---- Teacher ----------------------------------------------------------------------------

async function requireOwnedGroupQuiz(teacherId: string, sessionId: string, quizId: string) {
  const access = await requireTeacherSessionAccess(prisma, teacherId, sessionId);
  const id = requireRouteId(quizId, "QUIZ_NOT_FOUND");
  const row = await prisma.breakoutQuiz.findFirst({ where: { id, classSessionId: access.sessionId, status: 0, workMode: "GROUP" }, select: QUIZ_SELECT });
  if (!row) throw notVisible();
  return { access, row };
}

/** Teacher write prelude: own active session, the GROUP quiz, the group-activity lock, the attempt. */
async function lockOwnedGroupQuiz(tx: Tx, teacherId: string, sessionId: string, quizId: string) {
  const session: ActiveSessionLock = await lockOwnedActiveSession(tx, teacherId, sessionId);
  const row = await tx.breakoutQuiz.findFirst({ where: { id: quizId, classSessionId: session.id, status: 0, workMode: "GROUP" }, select: QUIZ_SELECT });
  if (!row) throw notVisible();
  await lockGroupActivity(tx, session, "quiz", row.id);
  const attempt = await tx.breakoutGroupQuizAttempt.findFirst({ where: { quizId: row.id, classSessionId: session.id }, select: ATTEMPT_SELECT });
  return { session, row, definition: definitionOf(row), attempt };
}

/**
 * Auto-submits the group attempt of a GROUP quiz if it is due (closed, or
 * the time over). Used by the teacher's views; only while the session is
 * active (an ended session is left as it is). Returns the attempt.
 */
export async function finalizeGroupQuizForTeacher(teacherId: string, sessionId: string, quizId: string, roomId: string | null): Promise<AttemptRow | null> {
  await serverNow();
  const result = await inBreakoutTransaction(async (tx) => {
    const locked = await lockOwnedGroupQuiz(tx, teacherId, sessionId, quizId);
    const now = serverNowSync();
    if (!locked.attempt || !isDue(locked.attempt, locked.row.state, now)) return { attempt: locked.attempt, changed: false, sessionId: locked.session.id };
    const members = roomId ? await activeMemberIds(tx, locked.session.id, roomId) : [];
    return { attempt: await autoSubmitLocked(tx, locked.attempt, locked.definition, members, now), changed: true, sessionId: locked.session.id, members };
  });
  if (result.changed && roomId) notifyQuiz(result.sessionId, quizId, roomId, result.attempt?.revision ?? 0, result.members ?? []);
  return result.attempt;
}

/** The teacher's view of one group quiz: the definition with answer keys, the room's members and the shared attempt with grading. */
export async function getGroupQuizForTeacher(input: { teacherId: string; sessionId: string; quizId: string }) {
  const { access, row } = await requireOwnedGroupQuiz(input.teacherId, input.sessionId, input.quizId);
  let attempt = await prisma.breakoutGroupQuizAttempt.findFirst({ where: { quizId: row.id, classSessionId: access.sessionId }, select: ATTEMPT_SELECT });
  const now = await serverNow();
  if (attempt && access.isActive && isDue(attempt, row.state, now)) {
    attempt = await finalizeGroupQuizForTeacher(input.teacherId, input.sessionId, row.id, row.targetRoomId);
  }
  const definition = definitionOf(row);
  const members = row.targetRoomId ? await activeMemberIds(prisma, access.sessionId, row.targetRoomId) : [];
  const nameOf = await nameOfFor(prisma, members, attempt);
  return {
    quiz: serializeQuizForTeacher({ ...row, questions: definition }, { includeDefinition: true }),
    members: members.map((id) => nameOf(id)),
    attempt: attempt ? serializeGroupAttemptForTeacher(attempt, nameOf) : null,
    progress: attempt ? { answered: answeredCount(attempt.answers, definition.questions), questions: definition.questions.length } : null,
  };
}

export type OverrideGroupGradingInput = { teacherId: string; sessionId: string; quizId: string; overrides: GradingOverridesInput["overrides"] };

/**
 * Teacher override of the group attempt's marks, with the existing marking
 * (applyOverrides / computeScores): quiz PUBLISHED or CLOSED (DRAFT: 409
 * ACTIVITY_NOT_PUBLISHED), the attempt submitted (IN_PROGRESS: 409
 * QUIZ_NOT_SUBMITTED; none: 404). autoScore unchanged; finalScore recomputed.
 */
export async function overrideGroupQuizGrading(input: OverrideGroupGradingInput) {
  const quizId = requireRouteId(input.quizId, "QUIZ_NOT_FOUND");
  await serverNow();
  const result = await inBreakoutTransaction(async (tx) => {
    const { session, row, definition, attempt } = await lockOwnedGroupQuiz(tx, input.teacherId, input.sessionId, quizId);
    if (row.state === "DRAFT") throw breakoutError("ACTIVITY_NOT_PUBLISHED");
    if (!attempt) throw breakoutError("NOT_FOUND");
    if (attempt.attemptStatus !== "SUBMITTED" && attempt.attemptStatus !== "AUTO_SUBMITTED") throw breakoutError("QUIZ_NOT_SUBMITTED");
    let base: QuizGrading;
    if (attempt.grading === null) {
      base = gradeAttempt(definition, attempt.answers as never);
    } else {
      const stored = parseStoredGrading(definition, attempt.grading);
      if (!stored) throw new Error(`Stored grading of breakout group quiz attempt ${attempt.id} is invalid; override refused.`);
      base = stored;
    }
    const now = serverNowSync();
    const grading = applyOverrides(base, input.overrides, definition, { teacherId: input.teacherId, now });
    const scores = computeScores(grading);
    const updated = await tx.breakoutGroupQuizAttempt.update({
      where: { id: attempt.id },
      data: { grading: asJson(grading), autoScore: scores.autoScore, finalScore: scores.finalScore, overriddenAt: now, updatedAt: now },
      select: ATTEMPT_SELECT,
    });
    const members = row.targetRoomId ? await activeMemberIds(tx, session.id, row.targetRoomId) : [];
    return { sessionId: session.id, row, updated, members };
  });
  if (result.row.targetRoomId) notifyQuiz(result.sessionId, result.row.id, result.row.targetRoomId, result.updated.revision, result.members);
  return {
    autoScore: Number(result.updated.autoScore),
    finalScore: Number(result.updated.finalScore),
    grading: result.updated.grading,
    overriddenAt: result.updated.overriddenAt?.toISOString() ?? null,
  };
}
