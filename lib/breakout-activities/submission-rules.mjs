// Breakout assignment submissions: version and latest-submission rules.
// Plain JavaScript with JSDoc types so the same code runs in the app and in
// the Node test runner. Pure: no database, no clock, no I/O.
//
// The transaction that applies these rules (Phase 2a) runs, in this order:
//   session lock -> per (assignment, student) advisory lock ->
//   idempotency lookup -> decideSubmission() -> file write ->
//   flip the previous latest row to isLatest = false -> insert the new row.
// The partial unique index "BreakoutAssignmentSubmission_one_latest_key" is
// the database backstop for "at most one latest"; assertSingleLatest() is the
// same rule in code.

/** Versions kept per student per assignment (bounds disk use). */
export const MAX_SUBMISSION_VERSIONS = 20;

/** Written answer text, for drafts and submissions alike. */
export const MAX_ANSWER_TEXT_LENGTH = 50_000;

/** Client-generated per attempt (normally a UUID). Column is VARCHAR(64). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isIdempotencyKey(value) {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * @param {unknown} versions
 * @returns {number[]}
 */
function checkedVersions(versions) {
  if (!Array.isArray(versions)) throw new TypeError("existingVersions must be an array.");
  for (const v of versions) {
    if (!Number.isInteger(v) || v < 1) throw new RangeError(`Invalid submission version: ${String(v)}`);
  }
  if (new Set(versions).size !== versions.length) throw new RangeError("Duplicate submission versions.");
  return versions;
}

/**
 * The version number the next submission gets: max(existing) + 1, or 1.
 * Refused once MAX_SUBMISSION_VERSIONS rows exist.
 *
 * @param {number[]} existingVersions every stored version for this (assignment, student)
 * @param {number} [limit]
 * @returns {{ ok: true, version: number } | { ok: false, code: "SUBMISSION_LIMIT_REACHED" }}
 */
export function planNextVersion(existingVersions, limit = MAX_SUBMISSION_VERSIONS) {
  const versions = checkedVersions(existingVersions);
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer.");
  if (versions.length >= limit) return { ok: false, code: "SUBMISSION_LIMIT_REACHED" };
  const max = versions.reduce((m, v) => (v > m ? v : m), 0);
  return { ok: true, version: max + 1 };
}

/**
 * @typedef {"DRAFT" | "PUBLISHED" | "CLOSED"} ActivityState
 * @typedef {{ action: "replay" }
 *   | { action: "insert", version: number }
 *   | { action: "reject", code: "ASSIGNMENT_NOT_FOUND" | "ASSIGNMENT_CLOSED" | "SUBMISSION_LIMIT_REACHED" }} SubmissionDecision
 */

/**
 * What a submission request does, decided after the advisory lock is held.
 *
 * Order matters: an idempotent replay (same key already stored) returns the
 * original submission even if the assignment has since closed or the version
 * limit has been reached, because the student's submission DID succeed.
 *
 * @param {{ assignmentState: ActivityState, replayFound: boolean, existingVersions: number[], limit?: number }} input
 * @returns {SubmissionDecision}
 */
export function decideSubmission({ assignmentState, replayFound, existingVersions, limit }) {
  if (replayFound === true) return { action: "replay" };
  if (assignmentState === "DRAFT") return { action: "reject", code: "ASSIGNMENT_NOT_FOUND" };
  if (assignmentState === "CLOSED") return { action: "reject", code: "ASSIGNMENT_CLOSED" };
  if (assignmentState !== "PUBLISHED") throw new RangeError(`Unknown assignment state: ${String(assignmentState)}`);
  const plan = planNextVersion(existingVersions, limit);
  if (!plan.ok) return { action: "reject", code: plan.code };
  return { action: "insert", version: plan.version };
}

/**
 * A submission needs written text, a PDF, or both. Whitespace-only text
 * counts as no text and is stored as null.
 *
 * @param {{ answerText?: string | null, hasFile: boolean }} input
 * @returns {{ ok: true, answerText: string | null } | { ok: false, code: "SUBMISSION_EMPTY" | "ANSWER_TEXT_TOO_LONG" }}
 */
export function checkSubmissionContent({ answerText, hasFile }) {
  if (answerText != null && typeof answerText !== "string") throw new TypeError("answerText must be a string.");
  if (typeof answerText === "string" && answerText.length > MAX_ANSWER_TEXT_LENGTH) {
    return { ok: false, code: "ANSWER_TEXT_TOO_LONG" };
  }
  const text = typeof answerText === "string" && answerText.trim() !== "" ? answerText : null;
  if (text === null && hasFile !== true) return { ok: false, code: "SUBMISSION_EMPTY" };
  return { ok: true, answerText: text };
}

/**
 * @typedef {{ version: number, isLatest: boolean }} SubmissionRow
 */

/**
 * The latest submission, or null when there are none.
 * Throws when the rows break the single-latest rule.
 *
 * @template {SubmissionRow} T
 * @param {T[]} rows every stored version for one (assignment, student)
 * @returns {T | null}
 */
export function pickLatest(rows) {
  assertSingleLatest(rows);
  return rows.find((r) => r.isLatest) ?? null;
}

/**
 * The rule the partial unique index enforces, plus what it cannot express:
 * with any rows present, exactly one is latest and it has the highest version.
 *
 * @param {SubmissionRow[]} rows every stored version for one (assignment, student)
 */
export function assertSingleLatest(rows) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array.");
  if (rows.length === 0) return;
  checkedVersions(rows.map((r) => r.version));
  const latest = rows.filter((r) => r.isLatest === true);
  if (latest.length !== 1) {
    throw new Error(`Expected exactly one latest submission, found ${latest.length}.`);
  }
  const max = Math.max(...rows.map((r) => r.version));
  if (latest[0].version !== max) {
    throw new Error(`The latest submission is version ${latest[0].version}, not the highest version ${max}.`);
  }
}
