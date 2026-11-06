// What a student may see of a breakout quiz. Plain JavaScript with JSDoc
// types so the same code runs in the app and in the Node test runner. Pure.
//
// The stored definition (BreakoutQuiz.questions) holds the answer keys. A
// student only ever receives the output of these functions, which are built
// by ALLOW-LIST (fields copied one by one), so a key added to the definition
// later can never leak by default.
//
// Visibility (approved design):
//   in progress            -> the quiz without keys
//   submitted, not CLOSED  -> { finalScore, totalMarks } only
//   CLOSED                 -> plus correct answers, the student's answers and
//                             per-question results (and teacher notes); with
//                             a teacher override the result follows the
//                             awarded marks (shownResult)

/**
 * @typedef {import("./marking.mjs").QuizDefinition} QuizDefinition
 * @typedef {import("./marking.mjs").QuizQuestion} QuizQuestion
 * @typedef {import("./marking.mjs").QuizAnswers} QuizAnswers
 * @typedef {import("./marking.mjs").QuizGrading} QuizGrading
 *
 * @typedef {{ id: string, text: string }} StudentOption
 * @typedef {{ id: string, kind: QuizQuestion["kind"], prompt: string, marks: number, options?: StudentOption[] }} StudentQuestion
 * @typedef {{ schemaVersion: 1, questions: StudentQuestion[] }} StudentQuizView
 */

/**
 * @param {QuizQuestion} q
 * @returns {StudentQuestion}
 */
function studentQuestion(q) {
  /** @type {StudentQuestion} */
  const out = { id: String(q.id), kind: q.kind, prompt: String(q.prompt), marks: Number(q.marks) };
  if (q.kind === "single" || q.kind === "multiple") {
    out.options = q.options.map((o) => ({ id: String(o.id), text: String(o.text) }));
  }
  return out;
}

/**
 * The quiz as a student sees it while answering: no answer keys.
 *
 * @param {QuizDefinition} definition
 * @returns {StudentQuizView}
 */
export function projectQuizForStudent(definition) {
  return { schemaVersion: 1, questions: definition.questions.map(studentQuestion) };
}

/**
 * Prisma Decimal, number or numeric string -> number (null when absent).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toScore(value) {
  if (value === null || value === undefined) return null;
  const n = Number(typeof value === "object" ? String(value) : value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {QuizQuestion} q
 * @returns {Record<string, unknown>}
 */
function answerKey(q) {
  switch (q.kind) {
    case "single":
      return { correctOptionId: q.correctOptionId };
    case "multiple":
      return { correctOptionIds: [...q.correctOptionIds] };
    case "true_false":
      return { correct: q.correct };
    case "short":
      return { acceptedAnswers: [...q.acceptedAnswers] };
    default:
      return {};
  }
}

/**
 * @param {QuizAnswers | null | undefined} answers
 * @param {string} id
 */
function ownAnswer(answers, id) {
  if (!answers || typeof answers !== "object") return null;
  return Object.prototype.hasOwnProperty.call(answers, id) ? answers[id] : null;
}

/**
 * The per-question result a student is shown. Without an override: the
 * stored automatic result, as marking.mjs computed it. With a teacher
 * override, the result follows the AWARDED marks with the same thresholds as
 * the automatic marking (marking.mjs resultFor): 0 -> "incorrect", the
 * question's full marks -> "correct", anything between -> "partial". So the
 * review never shows e.g. "incorrect" next to full marks. "unanswered" stays
 * "unanswered" when the override awards 0 (the student gave no answer, and 0
 * marks agrees with it). Compared in integer hundredths, like the marking.
 * A malformed stored override (marks not a number) falls back to the stored
 * automatic result rather than failing the view. The stored grading itself
 * is never changed or sent.
 *
 * @param {QuizQuestion} q
 * @param {{ result?: unknown, override?: { marks?: unknown } } | null} grade
 * @returns {unknown}
 */
function shownResult(q, grade) {
  if (!grade) return "unanswered";
  if (!grade.override) return grade.result;
  const awardedH = Math.round(Number(grade.override.marks) * 100);
  const marksH = Math.round(Number(q.marks) * 100);
  if (!Number.isFinite(awardedH) || !Number.isFinite(marksH) || marksH <= 0) return grade.result;
  if (awardedH <= 0) return grade.result === "unanswered" ? "unanswered" : "incorrect";
  return awardedH >= marksH ? "correct" : "partial";
}

/**
 * The student's own result.
 *
 * @param {{
 *   quizState: "DRAFT" | "PUBLISHED" | "CLOSED",
 *   definition: QuizDefinition,
 *   totalMarks: unknown,
 *   submission: null | {
 *     attemptStatus: "IN_PROGRESS" | "SUBMITTED" | "AUTO_SUBMITTED",
 *     answers: QuizAnswers | null,
 *     grading: QuizGrading | null,
 *     finalScore: unknown,
 *     submittedAt: Date | string | null,
 *   },
 * }} input
 */
export function buildStudentResult({ quizState, definition, totalMarks, submission }) {
  if (!submission) return { attemptStatus: null };
  if (submission.attemptStatus === "IN_PROGRESS") return { attemptStatus: "IN_PROGRESS" };

  const submittedAt =
    submission.submittedAt instanceof Date ? submission.submittedAt.toISOString() : submission.submittedAt ?? null;
  const summary = {
    attemptStatus: submission.attemptStatus,
    finalScore: toScore(submission.finalScore),
    totalMarks: toScore(totalMarks),
    submittedAt,
  };
  if (quizState !== "CLOSED") return summary;

  const grades = submission.grading?.questions ?? {};
  const review = definition.questions.map((q) => {
    const grade = Object.prototype.hasOwnProperty.call(grades, q.id) ? grades[q.id] : null;
    return {
      ...studentQuestion(q),
      ...answerKey(q),
      answer: ownAnswer(submission.answers, q.id),
      result: shownResult(q, grade),
      awarded: grade ? (grade.override ? grade.override.marks : grade.auto) : 0,
      ...(grade?.override?.note ? { note: grade.override.note } : {}),
    };
  });
  return { ...summary, review };
}
