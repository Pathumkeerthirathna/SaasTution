// CSV exports of breakout activity results. Plain JavaScript with JSDoc types
// so the same code runs in the app and in the Node test runner. Pure.
//
// Format: UTF-8 with a byte-order mark (so Excel shows Sinhala and Tamil
// correctly), CRLF line endings, every text cell quoted.
//
// Formula injection: student text is untrusted. A text cell starting with
// = + - @ tab or CR would be run as a formula by Excel / Sheets / LibreOffice,
// so it is prefixed with a single quote ('), which they show as plain text.
// Numbers are written as numbers and are never prefixed.
//
// Timestamps: breakout rows use real UTC instants (column defaults now() and
// @updatedAt), shown here in Sri Lanka time (UTC+05:30, no daylight saving).

/**
 * @typedef {import("./marking.mjs").QuizQuestion} QuizQuestion
 * @typedef {import("./marking.mjs").QuizAnswer} QuizAnswer
 */

export const CSV_BOM = "﻿";
const FORMULA_START = /^[=+\-@\t\r]/;
const SRI_LANKA_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * One CSV cell.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return String(Math.round(value * 100) / 100);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  let text = value instanceof Date ? formatCsvDateTime(value) : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * @param {string[]} headers
 * @param {unknown[][]} rows
 * @returns {string}
 */
export function toCsv(headers, rows) {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    if (row.length !== headers.length) {
      throw new RangeError(`CSV row has ${row.length} cells; expected ${headers.length}.`);
    }
    lines.push(row.map(escapeCsvCell).join(","));
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

/**
 * A real UTC instant as Sri Lanka wall-clock time: "YYYY-MM-DD HH:mm:ss".
 *
 * @param {Date | string | null | undefined} value
 * @returns {string}
 */
export function formatCsvDateTime(value) {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() + SRI_LANKA_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Prisma Decimal, number or numeric string -> number (null when absent).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function toCsvNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(typeof value === "object" ? String(value) : value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A student's answer as readable text (option texts, not IDs).
 *
 * @param {QuizQuestion} question
 * @param {QuizAnswer | null | undefined} answer
 * @returns {string}
 */
export function formatAnswerForCsv(question, answer) {
  if (!answer || answer.kind !== question.kind) return "";
  switch (answer.kind) {
    case "single": {
      if (question.kind !== "single") return "";
      return question.options.find((o) => o.id === answer.optionId)?.text ?? "";
    }
    case "multiple": {
      if (question.kind !== "multiple") return "";
      const chosen = new Set(answer.optionIds);
      return question.options.filter((o) => chosen.has(o.id)).map((o) => o.text).join("; ");
    }
    case "true_false":
      return answer.value === true ? "True" : answer.value === false ? "False" : "";
    case "short":
      return typeof answer.text === "string" ? answer.text : "";
    default:
      return "";
  }
}

const TIME = "(Sri Lanka time)";

/**
 * @typedef {{ roomName: string, assignmentTitle: string, studentName: string, studentId: string,
 *   version: number, isLatest: boolean, submittedAt: Date | string, fileName: string | null,
 *   answerText: string | null }} AssignmentSubmissionRow
 */

/**
 * Dataset "assignments": the latest submission of each student.
 *
 * @param {AssignmentSubmissionRow[]} rows
 */
export function assignmentsCsv(rows) {
  return toCsv(
    ["Room", "Assignment", "Student", "Student ID", "Version", `Submitted at ${TIME}`, "Has file", "File name", "Answer text"],
    rows
      .filter((r) => r.isLatest)
      .map((r) => [r.roomName, r.assignmentTitle, r.studentName, r.studentId, r.version, formatCsvDateTime(r.submittedAt), Boolean(r.fileName), r.fileName ?? "", r.answerText ?? ""])
  );
}

/**
 * Dataset "assignment-history": every submitted version.
 *
 * @param {AssignmentSubmissionRow[]} rows
 */
export function assignmentHistoryCsv(rows) {
  return toCsv(
    ["Room", "Assignment", "Student", "Student ID", "Version", "Latest", `Submitted at ${TIME}`, "Has file", "File name", "Answer text"],
    rows.map((r) => [r.roomName, r.assignmentTitle, r.studentName, r.studentId, r.version, r.isLatest, formatCsvDateTime(r.submittedAt), Boolean(r.fileName), r.fileName ?? "", r.answerText ?? ""])
  );
}

/**
 * Dataset "drafts": text students typed but may not have submitted.
 *
 * @param {Array<{ roomName: string, assignmentTitle: string, studentName: string, studentId: string,
 *   answerText: string, updatedAt: Date | string }>} rows
 */
export function draftsCsv(rows) {
  return toCsv(
    ["Room", "Assignment", "Student", "Student ID", `Last saved ${TIME}`, "Draft text"],
    rows.map((r) => [r.roomName, r.assignmentTitle, r.studentName, r.studentId, formatCsvDateTime(r.updatedAt), r.answerText])
  );
}

/**
 * Dataset "quizzes": one row per attempt.
 *
 * @param {Array<{ roomName: string, quizTitle: string, studentName: string, studentId: string,
 *   attemptStatus: string, autoScore: unknown, finalScore: unknown, totalMarks: unknown,
 *   startedAt: Date | string, submittedAt: Date | string | null }>} rows
 */
export function quizzesCsv(rows) {
  return toCsv(
    ["Room", "Quiz", "Student", "Student ID", "Status", "Auto score", "Final score", "Total marks", `Started ${TIME}`, `Submitted ${TIME}`],
    rows.map((r) => [r.roomName, r.quizTitle, r.studentName, r.studentId, r.attemptStatus, toCsvNumber(r.autoScore), toCsvNumber(r.finalScore), toCsvNumber(r.totalMarks), formatCsvDateTime(r.startedAt), formatCsvDateTime(r.submittedAt)])
  );
}

/**
 * Dataset "quiz-answers": one row per question per attempt.
 *
 * @param {Array<{ roomName: string, quizTitle: string, studentName: string, studentId: string,
 *   questionNumber: number, question: QuizQuestion, answer: QuizAnswer | null,
 *   auto: number | null, overrideMarks: number | null, note: string | null }>} rows
 */
export function quizAnswersCsv(rows) {
  return toCsv(
    ["Room", "Quiz", "Student", "Student ID", "Question", "Type", "Prompt", "Answer", "Auto marks", "Override marks", "Final marks", "Question marks", "Note"],
    rows.map((r) => [
      r.roomName,
      r.quizTitle,
      r.studentName,
      r.studentId,
      r.questionNumber,
      r.question.kind,
      r.question.prompt,
      formatAnswerForCsv(r.question, r.answer),
      r.auto ?? 0,
      r.overrideMarks,
      r.overrideMarks ?? r.auto ?? 0,
      r.question.marks,
      r.note ?? "",
    ])
  );
}
