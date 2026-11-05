// summaryVersion: a fingerprint of all breakout data of one session, shown to
// the teacher with the export and checked again, under the session row lock,
// when they end (or replace) the session. If anything changed in between, the
// end is refused with 409 BREAKOUT_DATA_CHANGED, so nothing is deleted that
// the teacher was not offered to export.
//
// Pure: hashes the per-table values that one SQL query (Phase 2a) returns.
// For each of the five tables: count, the latest change time (updatedAt;
// submittedAt for the insert-only submissions table) and, where the table has
// a revision column, the sum of revisions (two changes in the same
// millisecond still change the sum).

import { createHash } from "node:crypto";

type Count = number | bigint | string;
type Instant = Date | string | null;

export type BreakoutSummaryRows = {
  assignments: { count: Count; lastChangedAt: Instant };
  drafts: { count: Count; lastChangedAt: Instant; revisionSum: Count | null };
  submissions: { count: Count; lastChangedAt: Instant };
  quizzes: { count: Count; lastChangedAt: Instant };
  quizSubmissions: { count: Count; lastChangedAt: Instant; revisionSum: Count | null };
};

export type BreakoutSummaryCounts = {
  assignments: number;
  drafts: number;
  submissions: number;
  quizzes: number;
  attempts: number;
};

const TABLES = ["assignments", "drafts", "submissions", "quizzes", "quizSubmissions"] as const;
const WITH_REVISION = new Set<string>(["drafts", "quizSubmissions"]);

/** count / sum from Postgres (bigint, number or digit string) -> canonical digit string. */
function canonicalInteger(value: unknown, label: string): string {
  if (typeof value === "bigint") {
    if (value < BigInt(0)) throw new RangeError(`${label} must not be negative.`);
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer.`);
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value.replace(/^0+(?=\d)/, "");
  throw new RangeError(`${label} must be a non-negative integer.`);
}

function canonicalInstant(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new RangeError(`${label} must be a valid time.`);
  return date.toISOString();
}

/** Fixed order, fixed shape: the same data always gives the same text. */
export function canonicalSummaryJson(rows: BreakoutSummaryRows): string {
  if (!rows || typeof rows !== "object") throw new TypeError("rows are required.");
  const extra = Object.keys(rows).filter((k) => !(TABLES as readonly string[]).includes(k));
  if (extra.length > 0) throw new RangeError(`Unknown summary table: ${extra.join(", ")}`);
  const tables = TABLES.map((table) => {
    const row = (rows as Record<string, Record<string, unknown> | undefined>)[table];
    if (!row || typeof row !== "object") throw new RangeError(`Missing summary table: ${table}`);
    const entry: (string | null)[] = [
      table,
      canonicalInteger(row.count, `${table}.count`),
      canonicalInstant(row.lastChangedAt, `${table}.lastChangedAt`),
    ];
    if (WITH_REVISION.has(table)) {
      entry.push(row.revisionSum === null || row.revisionSum === undefined ? "0" : canonicalInteger(row.revisionSum, `${table}.revisionSum`));
    }
    return entry;
  });
  return JSON.stringify({ v: 1, tables });
}

/** SHA-256 (lowercase hex, 64 characters) of the canonical summary. */
export function computeSummaryVersion(rows: BreakoutSummaryRows): string {
  return createHash("sha256").update(canonicalSummaryJson(rows), "utf8").digest("hex");
}

export function summaryCounts(rows: BreakoutSummaryRows): BreakoutSummaryCounts {
  const n = (v: Count, label: string) => Number(canonicalInteger(v, label));
  return {
    assignments: n(rows.assignments.count, "assignments.count"),
    drafts: n(rows.drafts.count, "drafts.count"),
    submissions: n(rows.submissions.count, "submissions.count"),
    quizzes: n(rows.quizzes.count, "quizzes.count"),
    attempts: n(rows.quizSubmissions.count, "quizSubmissions.count"),
  };
}

/** No breakout data at all: ending the session needs no confirmation. */
export function summaryIsEmpty(rows: BreakoutSummaryRows): boolean {
  const c = summaryCounts(rows);
  return c.assignments + c.drafts + c.submissions + c.quizzes + c.attempts === 0;
}

const SUMMARY_VERSION = /^[0-9a-f]{64}$/;

export function isSummaryVersion(value: unknown): value is string {
  return typeof value === "string" && SUMMARY_VERSION.test(value);
}
