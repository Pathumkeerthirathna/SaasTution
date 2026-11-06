// What the Group Activities API returns. Built by ALLOW-LIST like
// lib/breakout-activities/serialize.ts (whose activity / quiz / attempt
// views are reused as they are). Never sent: stored file paths, the
// soft-delete status, teacherId, other sessions' data; to students also
// never answer keys or raw grading (the quiz goes through the existing
// projection, results through the existing buildStudentResult rules).

import { toIso, toNumber } from "../serialize";

type Instant = Date | string | null | undefined;

export type NameOf = (id: string | null | undefined) => { id: string; name: string } | null;

export function nameLookup(names: Map<string, { id: string; name: string }>): NameOf {
  return (id) => (id ? names.get(id) ?? { id, name: "Unknown student" } : null);
}

/** Member ids (a stored JSON array) -> [{ id, name }]; anything else -> []. */
export function membersFromJson(value: unknown, nameOf: NameOf) {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string").map((id) => nameOf(id) as { id: string; name: string });
}

export type GroupWorkRow = {
  answerText: string;
  revision: number;
  lastEditedByStudentId: string | null;
  lastEditedAt: Instant;
  submittedAt: Instant;
  submittedByStudentId: string | null;
  memberStudentIds: unknown;
  fileName: string | null;
  fileSize: number | null;
};

/** The shared assignment work (both roles): text, revision, latest editor, and the final submission once made. */
export function serializeGroupWork(row: GroupWorkRow | null, nameOf: NameOf) {
  if (!row) {
    return { answerText: "", revision: 0, lastEditedBy: null, lastEditedAt: null, submission: null };
  }
  return {
    answerText: row.answerText,
    revision: row.revision,
    lastEditedBy: nameOf(row.lastEditedByStudentId),
    lastEditedAt: toIso(row.lastEditedAt),
    submission: row.submittedAt
      ? {
          submittedAt: toIso(row.submittedAt),
          submittedBy: nameOf(row.submittedByStudentId),
          members: membersFromJson(row.memberStudentIds, nameOf),
          file: row.fileName ? { fileName: row.fileName, fileSize: row.fileSize ?? null } : null,
        }
      : null,
  };
}

export type GroupAttemptMeta = {
  startedAt: Instant;
  startedByStudentId: string;
  lastSavedAt: Instant;
  lastSavedByStudentId: string | null;
  submittedAt: Instant;
  submittedByStudentId: string | null;
  memberStudentIds: unknown;
};

/** Who did what on the shared attempt (both roles; no answers, no scores). */
export function serializeGroupAttemptMeta(row: GroupAttemptMeta | null, nameOf: NameOf) {
  if (!row) return null;
  return {
    startedAt: toIso(row.startedAt),
    startedBy: nameOf(row.startedByStudentId),
    lastSavedAt: toIso(row.lastSavedAt),
    lastSavedBy: nameOf(row.lastSavedByStudentId),
    submittedAt: toIso(row.submittedAt),
    submittedBy: nameOf(row.submittedByStudentId),
    members: membersFromJson(row.memberStudentIds, nameOf),
  };
}

/** The teacher's view of a group attempt: answers, grading and scores (the session's own teacher only). */
export function serializeGroupAttemptForTeacher(row: {
  attemptStatus: "IN_PROGRESS" | "SUBMITTED" | "AUTO_SUBMITTED";
  answers: unknown;
  revision: number;
  grading: unknown;
  autoScore: { toString(): string } | number | null;
  finalScore: { toString(): string } | number | null;
  deadlineAt: Instant;
  overriddenAt: Instant;
} & GroupAttemptMeta, nameOf: NameOf) {
  return {
    attemptStatus: row.attemptStatus,
    answers: row.answers ?? {},
    revision: row.revision,
    grading: row.grading ?? null,
    autoScore: toNumber(row.autoScore),
    finalScore: toNumber(row.finalScore),
    deadlineAt: toIso(row.deadlineAt),
    overriddenAt: toIso(row.overriddenAt),
    ...serializeGroupAttemptMeta(row, nameOf),
  };
}
