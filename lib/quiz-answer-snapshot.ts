/*
 * Quiz answer snapshots (migration 20261130120000_add_quiz_answer_snapshots).
 *
 * Every QuizSubmissionAnswer row records the question exactly as the student
 * answered it: its text, position, answer type and options (ids, texts,
 * correctness, order). A quiz edit replaces the quiz's questions and options
 * (services/lecture-service.ts updateQuizForTeacher); with the snapshot the
 * submitted answers, their score and their review stay exactly as they were.
 * The review of a submission is built ONLY from these rows, never from the
 * quiz's current questions.
 */

import type { QuizAnswerType } from "@prisma/client";

export type QuizOptionSnapshot = { id: string; text: string; isCorrect: boolean; orderIndex: number };

/** The question as loaded for grading: the fields the snapshot keeps. */
export type GradableQuizQuestion = {
  id: string;
  text: string;
  orderIndex: number;
  answerType: QuizAnswerType;
  options: QuizOptionSnapshot[];
};

/** The snapshot columns of one answer row. */
export type QuizAnswerSnapshotColumns = {
  questionId: string;
  questionText: string;
  questionOrderIndex: number;
  answerType: QuizAnswerType;
  optionsSnapshot: QuizOptionSnapshot[];
};

const byOrder = (a: { orderIndex: number; id: string }, b: { orderIndex: number; id: string }) =>
  a.orderIndex - b.orderIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The snapshot of one question as it is graded now (options in their order). */
export function snapshotQuizQuestion(question: GradableQuizQuestion): QuizAnswerSnapshotColumns {
  return {
    questionId: question.id,
    questionText: question.text,
    questionOrderIndex: question.orderIndex,
    answerType: question.answerType,
    optionsSnapshot: [...question.options]
      .sort(byOrder)
      .map((option) => ({ id: option.id, text: option.text, isCorrect: option.isCorrect, orderIndex: option.orderIndex })),
  };
}

function isOptionSnapshot(value: unknown): value is QuizOptionSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.text === "string" && typeof v.isCorrect === "boolean" && Number.isInteger(v.orderIndex);
}

/** The stored options of an answer (JSONB), in their order. A malformed value is a data error, never silently empty. */
export function readOptionsSnapshot(value: unknown): QuizOptionSnapshot[] {
  if (!Array.isArray(value) || !value.every(isOptionSnapshot)) {
    throw new TypeError("A quiz answer has a malformed options snapshot.");
  }
  return [...value].sort(byOrder);
}

/** A stored answer row, as the review reads it. */
export type StoredQuizAnswer = {
  id: string;
  questionId: string | null;
  questionText: string;
  questionOrderIndex: number;
  answerType: QuizAnswerType;
  optionsSnapshot: unknown;
  selectedOptionIds: string[];
  isCorrect: boolean;
};

export const STORED_QUIZ_ANSWER_SELECT = {
  id: true,
  questionId: true,
  questionText: true,
  questionOrderIndex: true,
  answerType: true,
  optionsSnapshot: true,
  selectedOptionIds: true,
  isCorrect: true,
} as const;

export type ReviewQuestion = {
  /** The question's id while it exists; the answer's own id once the question was replaced by an edit. */
  id: string;
  text: string;
  answerType: QuizAnswerType;
  isCorrect: boolean;
  selectedOptionIds: string[];
  options: { id: string; text: string; isCorrect: boolean }[];
};

/**
 * The review of one submission: exactly the questions it answered, as they
 * were answered (text, options, correctness), in their order at that time.
 * Questions added later are not part of it; replaced ones still are.
 */
export function reviewQuestionsFromAnswers(answers: StoredQuizAnswer[]): ReviewQuestion[] {
  return [...answers]
    .sort((a, b) => a.questionOrderIndex - b.questionOrderIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((answer) => ({
      id: answer.questionId ?? answer.id,
      text: answer.questionText,
      answerType: answer.answerType,
      isCorrect: answer.isCorrect,
      selectedOptionIds: answer.selectedOptionIds,
      options: readOptionsSnapshot(answer.optionsSnapshot).map((option) => ({ id: option.id, text: option.text, isCorrect: option.isCorrect })),
    }));
}
