// Breakout quiz marking: automatic marks, teacher overrides and score totals.
// Plain JavaScript with JSDoc types so the same code runs in the app and in
// the Node test runner. Pure: no database, no clock (callers pass `now`).
//
// All arithmetic is done in integer hundredths, so decimal marks add up
// exactly (0.1 + 0.2 = 0.3) and rounding is predictable (half up).
//
// Rules (approved design):
//   unanswered (any kind)    -> 0
//   single / true_false      -> correct = full marks, otherwise 0
//   multiple (option A)      -> none selected -> 0; more selected than there
//                               are correct options -> 0; otherwise
//                               min(marks, round2(marks x correctSelected / totalCorrect)).
//                               Wrong selections within the limit do not deduct.
//                               Never negative.
//   short                    -> normalized text equals a normalized accepted
//                               answer -> full marks, otherwise 0
//   override (any question)  -> 0 <= marks <= question marks;
//                               finalScore = sum(override ?? auto)

/**
 * @typedef {{ id: string, text: string }} QuizOption
 * @typedef {{ id: string, kind: "single", prompt: string, marks: number, options: QuizOption[], correctOptionId: string }} SingleQuestion
 * @typedef {{ id: string, kind: "multiple", prompt: string, marks: number, options: QuizOption[], correctOptionIds: string[] }} MultipleQuestion
 * @typedef {{ id: string, kind: "true_false", prompt: string, marks: number, correct: boolean }} TrueFalseQuestion
 * @typedef {{ id: string, kind: "short", prompt: string, marks: number, acceptedAnswers: string[] }} ShortQuestion
 * @typedef {SingleQuestion | MultipleQuestion | TrueFalseQuestion | ShortQuestion} QuizQuestion
 * @typedef {{ schemaVersion: 1, questions: QuizQuestion[] }} QuizDefinition
 *
 * @typedef {{ kind: "single", optionId: string | null }
 *   | { kind: "multiple", optionIds: string[] }
 *   | { kind: "true_false", value: boolean | null }
 *   | { kind: "short", text: string }} QuizAnswer
 * @typedef {Record<string, QuizAnswer>} QuizAnswers
 *
 * @typedef {"correct" | "partial" | "incorrect" | "unanswered"} QuestionResult
 * @typedef {{ marks: number, teacherId: string, at: string, note?: string }} GradeOverride
 * @typedef {{ auto: number, result: QuestionResult, override?: GradeOverride }} QuestionGrade
 * @typedef {{ schemaVersion: 1, questions: Record<string, QuestionGrade> }} QuizGrading
 */

export const MAX_OVERRIDE_NOTE_LENGTH = 500;

/** A marking rule was broken by the input (not a server fault). */
export class BreakoutMarkingError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "BreakoutMarkingError";
    this.code = code;
  }
}

/**
 * A mark as integer hundredths. Rejects non-finite values and more than two
 * decimal places (1.005 is refused, not rounded).
 *
 * @param {number} value
 * @returns {number}
 */
export function toHundredths(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BreakoutMarkingError("INVALID_MARKS", "Marks must be a finite number.");
  }
  const scaled = value * 100;
  const hundredths = Math.round(scaled);
  if (Math.abs(hundredths - scaled) > 1e-6) {
    throw new BreakoutMarkingError("INVALID_MARKS", "Marks can have at most 2 decimal places.");
  }
  return hundredths;
}

/**
 * @param {number} hundredths
 * @returns {number}
 */
export function fromHundredths(hundredths) {
  return hundredths / 100;
}

/**
 * Short-answer normalization: Unicode NFKC, whitespace runs collapsed to one
 * space, trimmed, lower-cased (locale-independent). Punctuation is kept.
 * Zero-width joiner / non-joiner (U+200D / U+200C) are kept: Sinhala and
 * Tamil spellings depend on them, so they are never stripped.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeShortAnswer(text) {
  if (typeof text !== "string") return "";
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * @param {QuizQuestion} question
 * @param {QuizAnswer | undefined | null} answer
 * @returns {boolean}
 */
export function isUnanswered(question, answer) {
  if (!answer || typeof answer !== "object" || answer.kind !== question.kind) return true;
  switch (answer.kind) {
    case "single":
      return typeof answer.optionId !== "string" || answer.optionId === "";
    case "multiple":
      return !Array.isArray(answer.optionIds) || answer.optionIds.length === 0;
    case "true_false":
      return typeof answer.value !== "boolean";
    case "short":
      return normalizeShortAnswer(answer.text) === "";
    default:
      return true;
  }
}

/**
 * @param {number} autoHundredths
 * @param {number} marksHundredths
 * @returns {QuestionResult}
 */
function resultFor(autoHundredths, marksHundredths) {
  if (autoHundredths <= 0) return "incorrect";
  return autoHundredths >= marksHundredths ? "correct" : "partial";
}

/**
 * Automatic marks for one question.
 *
 * @param {QuizQuestion} question
 * @param {QuizAnswer | undefined | null} answer
 * @returns {{ auto: number, result: QuestionResult }}
 */
export function markQuestion(question, answer) {
  const marksH = toHundredths(question.marks);
  if (marksH <= 0) throw new BreakoutMarkingError("INVALID_MARKS", "Question marks must be greater than 0.");
  if (isUnanswered(question, answer)) return { auto: 0, result: "unanswered" };

  /** @type {number} */
  let autoH = 0;
  switch (question.kind) {
    case "single": {
      const a = /** @type {{ optionId: string }} */ (answer);
      autoH = a.optionId === question.correctOptionId ? marksH : 0;
      break;
    }
    case "true_false": {
      const a = /** @type {{ value: boolean }} */ (answer);
      autoH = a.value === question.correct ? marksH : 0;
      break;
    }
    case "short": {
      const given = normalizeShortAnswer(/** @type {{ text: string }} */ (answer).text);
      const accepted = question.acceptedAnswers.map(normalizeShortAnswer).filter((s) => s !== "");
      autoH = accepted.includes(given) ? marksH : 0;
      break;
    }
    case "multiple": {
      const correct = new Set(question.correctOptionIds);
      if (correct.size === 0) {
        throw new BreakoutMarkingError("INVALID_QUESTION", "A multiple-answer question needs a correct option.");
      }
      const selected = new Set(/** @type {{ optionIds: string[] }} */ (answer).optionIds);
      if (selected.size > correct.size) {
        autoH = 0;
        break;
      }
      let correctSelected = 0;
      for (const id of selected) if (correct.has(id)) correctSelected += 1;
      autoH = Math.min(marksH, Math.round((marksH * correctSelected) / correct.size));
      break;
    }
    default:
      throw new BreakoutMarkingError("INVALID_QUESTION", "Unknown question kind.");
  }
  return { auto: fromHundredths(autoH), result: resultFor(autoH, marksH) };
}

/**
 * Automatic grading of a whole attempt. Questions without an answer are
 * "unanswered" (0). Answers for questions not in the definition are ignored.
 *
 * @param {QuizDefinition} definition
 * @param {QuizAnswers | null | undefined} answers
 * @returns {QuizGrading}
 */
export function gradeAttempt(definition, answers) {
  /** @type {Record<string, QuestionGrade>} */
  const questions = {};
  const given = answers && typeof answers === "object" ? answers : {};
  for (const question of definition.questions) {
    const answer = Object.prototype.hasOwnProperty.call(given, question.id) ? given[question.id] : undefined;
    questions[question.id] = markQuestion(question, answer);
  }
  return { schemaVersion: 1, questions };
}

/**
 * @param {QuizDefinition} definition
 * @returns {number}
 */
export function computeTotalMarks(definition) {
  let total = 0;
  for (const q of definition.questions) total += toHundredths(q.marks);
  return fromHundredths(total);
}

/**
 * autoScore = sum of automatic marks; finalScore = sum of (override ?? auto).
 *
 * @param {QuizGrading} grading
 * @returns {{ autoScore: number, finalScore: number }}
 */
export function computeScores(grading) {
  let autoH = 0;
  let finalH = 0;
  for (const grade of Object.values(grading.questions)) {
    const a = toHundredths(grade.auto);
    autoH += a;
    finalH += grade.override ? toHundredths(grade.override.marks) : a;
  }
  return { autoScore: fromHundredths(autoH), finalScore: fromHundredths(finalH) };
}

/**
 * Applies teacher overrides and returns a NEW grading (the input is not
 * changed). `marks: null` removes a question's override. All-or-nothing:
 * any invalid entry throws and nothing is applied.
 *
 * @param {QuizGrading} grading
 * @param {Array<{ questionId: string, marks: number | null, note?: string }>} overrides
 * @param {QuizDefinition} definition
 * @param {{ teacherId: string, now: Date }} context
 * @returns {QuizGrading}
 */
export function applyOverrides(grading, overrides, definition, { teacherId, now }) {
  if (!Array.isArray(overrides) || overrides.length === 0) {
    throw new BreakoutMarkingError("INVALID_OVERRIDE", "No overrides given.");
  }
  if (typeof teacherId !== "string" || teacherId === "") throw new TypeError("teacherId is required.");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("now must be a valid Date.");

  const byId = new Map(definition.questions.map((q) => [q.id, q]));
  /** @type {Record<string, QuestionGrade>} */
  const next = {};
  for (const [id, grade] of Object.entries(grading.questions)) {
    next[id] = grade.override ? { ...grade, override: { ...grade.override } } : { ...grade };
  }

  const seen = new Set();
  for (const entry of overrides) {
    const question = byId.get(entry.questionId);
    if (!question || !Object.prototype.hasOwnProperty.call(next, entry.questionId)) {
      throw new BreakoutMarkingError("UNKNOWN_QUESTION", "Override for a question that is not in this quiz.");
    }
    if (seen.has(entry.questionId)) {
      throw new BreakoutMarkingError("DUPLICATE_OVERRIDE", "The same question is overridden twice.");
    }
    seen.add(entry.questionId);

    if (entry.marks === null) {
      delete next[entry.questionId].override;
      continue;
    }
    const marksH = toHundredths(entry.marks);
    if (marksH < 0 || marksH > toHundredths(question.marks)) {
      throw new BreakoutMarkingError("OVERRIDE_OUT_OF_RANGE", "Override marks must be between 0 and the question's marks.");
    }
    if (entry.note !== undefined && (typeof entry.note !== "string" || entry.note.length > MAX_OVERRIDE_NOTE_LENGTH)) {
      throw new BreakoutMarkingError("INVALID_OVERRIDE", `The note can be at most ${MAX_OVERRIDE_NOTE_LENGTH} characters.`);
    }
    /** @type {GradeOverride} */
    const override = { marks: fromHundredths(marksH), teacherId, at: now.toISOString() };
    const note = typeof entry.note === "string" ? entry.note.trim() : "";
    if (note !== "") override.note = note;
    next[entry.questionId].override = override;
  }
  return { schemaVersion: 1, questions: next };
}
