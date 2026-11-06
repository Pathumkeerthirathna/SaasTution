// Breakout Group Activities: progress overviews (reads only, plus the lazy
// quiz auto-submit for attempts that are due, as the existing quiz reads do).
//
// Teacher: every room that has confirmed members or a group activity, with
// its confirmed members and, per GROUP assignment / quiz, the progress and
// submission status. Student: their own group (members) and the published
// group activities of their room, with the same progress. A student who is
// not a confirmed member of any group gets { group: null }.

import { prisma } from "@/lib/prisma";
import { serverNow } from "@/lib/server-clock";
import { serializeAssignmentForStudent, serializeAssignmentForTeacher, serializeQuizForTeacher, serializeQuizSummaryForStudent, toIso, toNumber } from "@/lib/breakout-activities/serialize";
import { requireTeacherSessionAccess } from "@/lib/breakout-activities/teacher-access";
import { storedQuizDefinitionSchema } from "@/lib/breakout-activities/validation";
import type { QuizDefinition } from "@/lib/breakout-activities/marking.mjs";
import { findStudentGroup, studentNames } from "@/lib/breakout-activities/groups/access";
import { answeredCount } from "@/lib/breakout-activities/groups/rules.mjs";
import { nameLookup, type NameOf } from "@/lib/breakout-activities/groups/serialize";

import {
  finalizeGroupQuizForStudent,
  finalizeGroupQuizForTeacher,
  GROUP_ATTEMPT_SELECT,
  isGroupAttemptDue,
  type GroupAttemptSummaryRow,
} from "./breakout-group-quiz-service";

const VISIBLE_STATES = ["PUBLISHED", "CLOSED"] as const;

const ASSIGNMENT_SELECT = {
  id: true,
  publishGroupId: true,
  targetRoomType: true,
  targetRoomId: true,
  targetRoomName: true,
  title: true,
  instructions: true,
  briefFileName: true,
  briefFileSize: true,
  state: true,
  publishedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

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
} as const;

const WORK_PROGRESS_SELECT = {
  assignmentId: true,
  answerText: true,
  revision: true,
  lastEditedByStudentId: true,
  lastEditedAt: true,
  submittedAt: true,
  submittedByStudentId: true,
  fileName: true,
} as const;

type WorkProgressRow = {
  answerText: string;
  revision: number;
  lastEditedByStudentId: string | null;
  lastEditedAt: Date | null;
  submittedAt: Date | null;
  submittedByStudentId: string | null;
  fileName: string | null;
};

function assignmentProgress(work: WorkProgressRow | undefined, nameOf: NameOf) {
  return {
    started: Boolean(work && (work.answerText.trim() !== "" || work.submittedAt)),
    revision: work?.revision ?? 0,
    lastEditedBy: nameOf(work?.lastEditedByStudentId),
    lastEditedAt: toIso(work?.lastEditedAt),
    submitted: work?.submittedAt
      ? { submittedAt: toIso(work.submittedAt), submittedBy: nameOf(work.submittedByStudentId), hasFile: Boolean(work.fileName) }
      : null,
  };
}

function quizProgress(attempt: GroupAttemptSummaryRow | undefined, questions: QuizDefinition["questions"], totalMarks: unknown, nameOf: NameOf, includeScore: boolean) {
  if (!attempt) return { attemptStatus: null, answered: 0, questions: questions.length };
  const submitted = attempt.attemptStatus !== "IN_PROGRESS";
  return {
    attemptStatus: attempt.attemptStatus,
    answered: answeredCount(attempt.answers, questions),
    questions: questions.length,
    startedBy: nameOf(attempt.startedByStudentId),
    deadlineAt: toIso(attempt.deadlineAt),
    lastSavedAt: toIso(attempt.lastSavedAt),
    lastSavedBy: nameOf(attempt.lastSavedByStudentId),
    submittedAt: toIso(attempt.submittedAt),
    submittedBy: nameOf(attempt.submittedByStudentId),
    ...(submitted && includeScore ? { finalScore: toNumber(attempt.finalScore), totalMarks: toNumber(totalMarks as never) } : {}),
  };
}

/** The teacher's progress view of the session's groups (any session state; due quiz attempts finalized while active). */
export async function getGroupOverviewForTeacher(input: { teacherId: string; sessionId: string }) {
  const access = await requireTeacherSessionAccess(prisma, input.teacherId, input.sessionId);
  const sessionId = access.sessionId;
  const [memberships, assignments, quizzes] = await Promise.all([
    prisma.breakoutRoomMember.findMany({
      where: { classSessionId: sessionId, status: 0 },
      orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
      select: { roomId: true, roomName: true, studentId: true },
    }),
    prisma.breakoutAssignment.findMany({
      where: { classSessionId: sessionId, status: 0, workMode: "GROUP" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: ASSIGNMENT_SELECT,
    }),
    prisma.breakoutQuiz.findMany({
      where: { classSessionId: sessionId, status: 0, workMode: "GROUP" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: QUIZ_SELECT,
    }),
  ]);
  const [works, attemptsRaw] = await Promise.all([
    assignments.length
      ? prisma.breakoutGroupAssignmentWork.findMany({ where: { classSessionId: sessionId, assignmentId: { in: assignments.map((a) => a.id) } }, select: WORK_PROGRESS_SELECT })
      : Promise.resolve([]),
    quizzes.length
      ? prisma.breakoutGroupQuizAttempt.findMany({ where: { classSessionId: sessionId, quizId: { in: quizzes.map((q) => q.id) } }, select: { ...GROUP_ATTEMPT_SELECT, quizId: true } })
      : Promise.resolve([]),
  ]);

  const now = await serverNow();
  const attemptOf = new Map<string, GroupAttemptSummaryRow>();
  for (const attempt of attemptsRaw) attemptOf.set(attempt.quizId, attempt);
  if (access.isActive) {
    for (const quiz of quizzes) {
      const attempt = attemptOf.get(quiz.id);
      if (attempt && isGroupAttemptDue(attempt, quiz.state, now)) {
        const finalized = await finalizeGroupQuizForTeacher(input.teacherId, sessionId, quiz.id, quiz.targetRoomId);
        if (finalized) attemptOf.set(quiz.id, finalized);
      }
    }
  }
  const workOf = new Map(works.map((w) => [w.assignmentId, w]));

  const ids = [
    ...memberships.map((m) => m.studentId),
    ...works.flatMap((w) => [w.lastEditedByStudentId, w.submittedByStudentId]),
    ...[...attemptOf.values()].flatMap((a) => [a.startedByStudentId, a.lastSavedByStudentId, a.submittedByStudentId]),
  ];
  const nameOf = nameLookup(await studentNames(prisma, ids));

  const rooms = new Map<string, { id: string; name: string; members: { id: string; name: string }[] }>();
  const roomFor = (id: string, name: string) => {
    if (!rooms.has(id)) rooms.set(id, { id, name, members: [] });
    return rooms.get(id)!;
  };
  for (const m of memberships) roomFor(m.roomId, m.roomName).members.push(nameOf(m.studentId)!);
  for (const a of assignments) if (a.targetRoomId) roomFor(a.targetRoomId, a.targetRoomName);
  for (const q of quizzes) if (q.targetRoomId) roomFor(q.targetRoomId, q.targetRoomName);

  return {
    sessionActive: access.isActive,
    rooms: [...rooms.values()].map((room) => ({
      ...room,
      assignments: assignments
        .filter((a) => a.targetRoomId === room.id)
        .map((a) => ({ ...serializeAssignmentForTeacher(a), progress: assignmentProgress(workOf.get(a.id), nameOf) })),
      quizzes: quizzes
        .filter((q) => q.targetRoomId === room.id)
        .map((q) => {
          const definition = storedQuizDefinitionSchema.parse(q.questions);
          return { ...serializeQuizForTeacher(q), progress: quizProgress(attemptOf.get(q.id), definition.questions, q.totalMarks, nameOf, true) };
        }),
    })),
  };
}

/** The student's group: members and the published group activities of their room, with progress. */
export async function getMyGroupOverview(input: { studentId: string; sessionId: string }) {
  const { sessionId, membership } = await findStudentGroup(prisma, input.studentId, input.sessionId);
  if (!membership) return { group: null, assignments: [], quizzes: [] };

  const roomWhere = {
    classSessionId: sessionId,
    status: 0,
    state: { in: [...VISIBLE_STATES] },
    workMode: "GROUP" as const,
    targetRoomType: "BREAKOUT" as const,
    targetRoomId: membership.roomId,
  };
  const [memberRows, assignments, quizzes] = await Promise.all([
    prisma.breakoutRoomMember.findMany({
      where: { classSessionId: sessionId, roomId: membership.roomId, status: 0 },
      orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
      select: { studentId: true },
    }),
    prisma.breakoutAssignment.findMany({ where: roomWhere, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: ASSIGNMENT_SELECT }),
    prisma.breakoutQuiz.findMany({ where: roomWhere, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: QUIZ_SELECT }),
  ]);
  const [works, attemptsRaw] = await Promise.all([
    assignments.length
      ? prisma.breakoutGroupAssignmentWork.findMany({ where: { classSessionId: sessionId, assignmentId: { in: assignments.map((a) => a.id) } }, select: WORK_PROGRESS_SELECT })
      : Promise.resolve([]),
    quizzes.length
      ? prisma.breakoutGroupQuizAttempt.findMany({ where: { classSessionId: sessionId, quizId: { in: quizzes.map((q) => q.id) } }, select: { ...GROUP_ATTEMPT_SELECT, quizId: true } })
      : Promise.resolve([]),
  ]);

  const now = await serverNow();
  const attemptOf = new Map<string, GroupAttemptSummaryRow>();
  for (const attempt of attemptsRaw) attemptOf.set(attempt.quizId, attempt);
  for (const quiz of quizzes) {
    const attempt = attemptOf.get(quiz.id);
    if (attempt && isGroupAttemptDue(attempt, quiz.state, now)) {
      const finalized = await finalizeGroupQuizForStudent(input.studentId, sessionId, quiz.id);
      if (finalized) attemptOf.set(quiz.id, finalized);
    }
  }
  const workOf = new Map(works.map((w) => [w.assignmentId, w]));
  const memberIds = [...new Set(memberRows.map((m) => m.studentId))];
  const nameOf = nameLookup(
    await studentNames(prisma, [
      ...memberIds,
      ...works.flatMap((w) => [w.lastEditedByStudentId, w.submittedByStudentId]),
      ...[...attemptOf.values()].flatMap((a) => [a.startedByStudentId, a.lastSavedByStudentId, a.submittedByStudentId]),
    ])
  );

  return {
    group: { room: { id: membership.roomId, name: membership.roomName }, members: memberIds.map((id) => nameOf(id)) },
    assignments: assignments.map((a) => ({ ...serializeAssignmentForStudent(a), progress: assignmentProgress(workOf.get(a.id), nameOf) })),
    quizzes: quizzes.map((q) => {
      const definition = storedQuizDefinitionSchema.parse(q.questions);
      return { ...serializeQuizSummaryForStudent(q, definition.questions.length), progress: quizProgress(attemptOf.get(q.id), definition.questions, q.totalMarks, nameOf, true) };
    }),
  };
}
