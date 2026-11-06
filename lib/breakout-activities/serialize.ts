// What the teacher API returns for breakout rows. Built by ALLOW-LIST
// (fields copied one by one, like quiz-projection.mjs), so a column added
// later is never sent by default.
//
// Never sent: stored file paths (briefFilePath, filePath: the storage layout
// stays on the server), idempotency keys, the soft-delete status column,
// and teacherId. Prisma Decimal values become numbers; dates become ISO
// strings (real UTC instants).
//
// The teacher views include the full quiz definition with answer keys and
// every student's answers: they are only for the session's own teacher.
// The student views (end of this file) carry the student's OWN work only,
// the quiz through quiz-projection.mjs (no answer keys), and results through
// buildStudentResult (correct answers and per-question results only once the
// quiz is CLOSED).

import { buildStudentResult, projectQuizForStudent } from "./quiz-projection.mjs";
import type { QuizDefinition } from "./marking.mjs";

type Instant = Date | string | null | undefined;
type DecimalLike = { toString(): string } | number | string | null | undefined;

export function toIso(value: Instant): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date.");
  return date.toISOString();
}

/** Prisma Decimal / number / numeric string -> number (null when absent). */
export function toNumber(value: DecimalLike): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(typeof value === "object" ? value.toString() : value);
  if (!Number.isFinite(n)) throw new RangeError("Invalid number.");
  return n;
}

type ActivityState = "DRAFT" | "PUBLISHED" | "CLOSED";
type TargetRoomType = "MAIN" | "BREAKOUT";

type ActivityBase = {
  id: string;
  publishGroupId: string | null;
  targetRoomType: TargetRoomType;
  targetRoomId: string | null;
  targetRoomName: string;
  title: string;
  state: ActivityState;
  publishedAt: Instant;
  closedAt: Instant;
  createdAt: Instant;
  updatedAt: Instant;
};

function activityFields(row: ActivityBase) {
  return {
    id: row.id,
    publishGroupId: row.publishGroupId ?? null,
    target: { type: row.targetRoomType, id: row.targetRoomId ?? null, name: row.targetRoomName },
    title: row.title,
    state: row.state,
    publishedAt: toIso(row.publishedAt),
    closedAt: toIso(row.closedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export type AssignmentRow = ActivityBase & {
  instructions: string;
  briefFileName: string | null;
  briefFileSize: number | null;
};

export type AssignmentCounts = { studentsSubmitted: number; submissions: number; drafts: number };

export function serializeAssignmentForTeacher(row: AssignmentRow, counts?: AssignmentCounts) {
  return {
    ...activityFields(row),
    instructions: row.instructions,
    brief: row.briefFileName ? { fileName: row.briefFileName, fileSize: row.briefFileSize ?? null } : null,
    ...(counts
      ? { counts: { studentsSubmitted: counts.studentsSubmitted, submissions: counts.submissions, drafts: counts.drafts } }
      : {}),
  };
}

export type QuizRow = ActivityBase & {
  instructions: string | null;
  questions?: unknown;
  totalMarks: DecimalLike;
  timeLimitSeconds: number | null;
};

export type QuizCounts = { attempts: number; inProgress: number; submitted: number };

/** `includeDefinition`: the full stored definition, answer keys included (GET …/quizzes/[id]). */
export function serializeQuizForTeacher(row: QuizRow, options: { includeDefinition?: boolean; counts?: QuizCounts } = {}) {
  return {
    ...activityFields(row),
    instructions: row.instructions ?? null,
    totalMarks: toNumber(row.totalMarks),
    timeLimitSeconds: row.timeLimitSeconds ?? null,
    ...(options.includeDefinition ? { questions: row.questions } : {}),
    ...(options.counts
      ? { counts: { attempts: options.counts.attempts, inProgress: options.counts.inProgress, submitted: options.counts.submitted } }
      : {}),
  };
}

export type StudentRef = { id: string; name: string; registrationNumber: string | null };

function studentFields(student: StudentRef) {
  return { id: student.id, name: student.name, registrationNumber: student.registrationNumber ?? null };
}

export type AssignmentSubmissionRow = {
  id: string;
  version: number;
  isLatest: boolean;
  answerText: string | null;
  fileName: string | null;
  fileSize: number | null;
  submittedAt: Instant;
  student: StudentRef;
};

export function serializeAssignmentSubmissionForTeacher(row: AssignmentSubmissionRow, extra?: { versionCount?: number }) {
  return {
    id: row.id,
    version: row.version,
    isLatest: row.isLatest,
    submittedAt: toIso(row.submittedAt),
    answerText: row.answerText ?? null,
    file: row.fileName ? { fileName: row.fileName, fileSize: row.fileSize ?? null } : null,
    student: studentFields(row.student),
    ...(extra?.versionCount !== undefined ? { versionCount: extra.versionCount } : {}),
  };
}

export type QuizAttemptRow = {
  id: string;
  attemptStatus: "IN_PROGRESS" | "SUBMITTED" | "AUTO_SUBMITTED";
  answers: unknown;
  revision: number;
  grading: unknown;
  autoScore: DecimalLike;
  finalScore: DecimalLike;
  startedAt: Instant;
  deadlineAt: Instant;
  lastSavedAt: Instant;
  submittedAt: Instant;
  overriddenAt: Instant;
  student: StudentRef;
};

export function serializeQuizAttemptForTeacher(row: QuizAttemptRow) {
  return {
    id: row.id,
    attemptStatus: row.attemptStatus,
    answers: row.answers ?? {},
    revision: row.revision,
    grading: row.grading ?? null,
    autoScore: toNumber(row.autoScore),
    finalScore: toNumber(row.finalScore),
    startedAt: toIso(row.startedAt),
    deadlineAt: toIso(row.deadlineAt),
    lastSavedAt: toIso(row.lastSavedAt),
    submittedAt: toIso(row.submittedAt),
    overriddenAt: toIso(row.overriddenAt),
    student: studentFields(row.student),
  };
}

// ---- Student views (Stage 3) --------------------------------------------------
// Never sent to a student: file paths, idempotency keys, status, teacherId,
// classSessionId, publishGroupId, studentId, the stored quiz definition (answer
// keys), raw grading, and anything about other students.

type StudentActivityBase = {
  id: string;
  targetRoomType: TargetRoomType;
  targetRoomName: string;
  title: string;
  state: ActivityState;
  publishedAt: Instant;
  closedAt: Instant;
};

function studentActivityFields(row: StudentActivityBase) {
  return {
    id: row.id,
    room: { type: row.targetRoomType, name: row.targetRoomName },
    title: row.title,
    state: row.state,
    publishedAt: toIso(row.publishedAt),
    closedAt: toIso(row.closedAt),
  };
}

export type StudentAssignmentRow = StudentActivityBase & {
  instructions: string;
  briefFileName: string | null;
  briefFileSize: number | null;
};

export function serializeAssignmentForStudent(row: StudentAssignmentRow) {
  return {
    ...studentActivityFields(row),
    instructions: row.instructions,
    brief: row.briefFileName ? { fileName: row.briefFileName, fileSize: row.briefFileSize ?? null } : null,
  };
}

export type StudentDraftRow = { answerText: string; revision: number; updatedAt: Instant };

/** The student's own draft; no draft yet = empty text at revision 0. */
export function serializeDraftForStudent(row: StudentDraftRow | null) {
  if (!row) return { answerText: "", revision: 0, updatedAt: null };
  return { answerText: row.answerText, revision: row.revision, updatedAt: toIso(row.updatedAt) };
}

export type StudentSubmissionRow = {
  id: string;
  version: number;
  isLatest: boolean;
  answerText: string | null;
  fileName: string | null;
  fileSize: number | null;
  submittedAt: Instant;
};

/** One of the student's own submission versions. `replayed`: an idempotent repeat. */
export function serializeSubmissionForStudent(row: StudentSubmissionRow, extra?: { replayed?: boolean }) {
  return {
    id: row.id,
    version: row.version,
    isLatest: row.isLatest,
    submittedAt: toIso(row.submittedAt),
    answerText: row.answerText ?? null,
    file: row.fileName ? { fileName: row.fileName, fileSize: row.fileSize ?? null } : null,
    ...(extra?.replayed ? { replayed: true } : {}),
  };
}

export type StudentQuizRow = StudentActivityBase & {
  instructions: string | null;
  totalMarks: DecimalLike;
  timeLimitSeconds: number | null;
};

/** The quiz as a student sees it: the projection (no answer keys) of the validated definition. */
export function serializeQuizForStudent(row: StudentQuizRow, definition: QuizDefinition) {
  return {
    ...studentActivityFields(row),
    instructions: row.instructions ?? null,
    totalMarks: toNumber(row.totalMarks),
    timeLimitSeconds: row.timeLimitSeconds ?? null,
    questions: projectQuizForStudent(definition).questions,
  };
}

export type StudentAttemptRow = {
  attemptStatus: "IN_PROGRESS" | "SUBMITTED" | "AUTO_SUBMITTED";
  answers: unknown;
  revision: number;
  grading: unknown;
  finalScore: DecimalLike;
  startedAt: Instant;
  deadlineAt: Instant;
  lastSavedAt: Instant;
  submittedAt: Instant;
};

/**
 * The student's own attempt. In progress: what is needed to resume (own
 * answers, revision, deadline). Submitted: buildStudentResult, i.e. the score
 * only until the quiz is CLOSED, then the review. Raw grading is never sent.
 */
export function serializeAttemptForStudent(input: {
  quizState: ActivityState;
  definition: QuizDefinition;
  totalMarks: DecimalLike;
  attempt: StudentAttemptRow | null;
}) {
  const { attempt } = input;
  if (!attempt) return { attemptStatus: null };
  if (attempt.attemptStatus === "IN_PROGRESS") {
    return {
      attemptStatus: "IN_PROGRESS" as const,
      answers: attempt.answers ?? {},
      revision: attempt.revision,
      startedAt: toIso(attempt.startedAt),
      deadlineAt: toIso(attempt.deadlineAt),
      lastSavedAt: toIso(attempt.lastSavedAt),
    };
  }
  return buildStudentResult({
    quizState: input.quizState,
    definition: input.definition,
    totalMarks: input.totalMarks,
    submission: {
      attemptStatus: attempt.attemptStatus,
      answers: (attempt.answers ?? null) as never,
      grading: (attempt.grading ?? null) as never,
      finalScore: attempt.finalScore,
      submittedAt: attempt.submittedAt instanceof Date ? attempt.submittedAt : (attempt.submittedAt ?? null),
    },
  });
}

/**
 * A quiz without its questions (approved decision Q1): what a student sees
 * before starting an attempt, and of a CLOSED quiz they never attempted.
 * Title, instructions, total marks, time limit and the number of questions.
 */
export function serializeQuizSummaryForStudent(row: StudentQuizRow, questionCount: number) {
  if (!Number.isInteger(questionCount) || questionCount < 0) throw new RangeError("Invalid question count.");
  return {
    ...studentActivityFields(row),
    instructions: row.instructions ?? null,
    totalMarks: toNumber(row.totalMarks),
    timeLimitSeconds: row.timeLimitSeconds ?? null,
    questionCount,
  };
}

/**
 * The student's own attempt in a list: its status and times, and the total
 * score once submitted. Never answers, a review or raw grading (those come
 * with the single quiz, serializeAttemptForStudent).
 */
export function serializeAttemptSummaryForStudent(attempt: StudentAttemptRow | null, totalMarks: DecimalLike) {
  if (!attempt) return { attemptStatus: null };
  if (attempt.attemptStatus === "IN_PROGRESS") {
    return {
      attemptStatus: "IN_PROGRESS" as const,
      startedAt: toIso(attempt.startedAt),
      deadlineAt: toIso(attempt.deadlineAt),
      lastSavedAt: toIso(attempt.lastSavedAt),
    };
  }
  return {
    attemptStatus: attempt.attemptStatus,
    finalScore: toNumber(attempt.finalScore),
    totalMarks: toNumber(totalMarks),
    submittedAt: toIso(attempt.submittedAt),
  };
}
