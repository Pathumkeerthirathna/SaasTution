/**
 * Class enrolment at one instant, from ClassStudent rows. Pure: no database,
 * no clock. See docs/lecture-attendance.md.
 *
 * ClassStudent.assignedAt / removedAt hold Sri Lankan wall-clock digits
 * (written with nowInSriLanka()); they are converted to real instants with
 * sriLankaDigitsToInstant, the same conversion lib/fee-waiver.ts uses, before
 * any comparison with a real instant (a lecture start, a scan time).
 *
 * A row covers the half-open period [assignedAt, removedAt): enrolled from the
 * assignment instant itself, and no longer at the removal instant. A row
 * without removedAt is open-ended. Re-enrolment is a separate row, so a
 * student can have several periods in one class with gaps between them.
 */

import { sriLankaDigitsToInstant } from "@/lib/time";

export type EnrolmentRow = {
  id: string;
  classId: string;
  /** Sri Lankan wall-clock digits (ClassStudent.assignedAt). */
  assignedAt: Date;
  /** Sri Lankan wall-clock digits (ClassStudent.removedAt); null = not removed. */
  removedAt: Date | null;
  /** ClassStudent.isActive. */
  isActive: boolean;
};

/** Why a row is ignored: its period cannot be placed in time. */
export type UnusableEnrolmentReason =
  /** assignedAt or removedAt is not a valid date. */
  | "INVALID_TIMESTAMP"
  /** removedAt is before assignedAt. */
  | "REMOVED_BEFORE_ASSIGNED"
  /** isActive is false but removedAt is missing: the end is unknown. */
  | "INACTIVE_WITHOUT_REMOVAL_TIME";

export type EnrolmentExplanation =
  | { enrolled: true; enrolmentId: string }
  | {
      enrolled: false;
      enrolmentId: null;
      /** Rows of this class that were ignored, with why (for review screens and logs). */
      unusable: { enrolmentId: string; reason: UnusableEnrolmentReason }[];
    };

const isValidDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

function unusableReason(row: EnrolmentRow): UnusableEnrolmentReason | null {
  if (!isValidDate(row.assignedAt)) return "INVALID_TIMESTAMP";
  if (row.removedAt !== null && !isValidDate(row.removedAt)) return "INVALID_TIMESTAMP";
  if (row.removedAt !== null && row.removedAt.getTime() < row.assignedAt.getTime()) return "REMOVED_BEFORE_ASSIGNED";
  if (row.removedAt === null && row.isActive === false) return "INACTIVE_WITHOUT_REMOVAL_TIME";
  return null;
}

/**
 * Whether the student was enrolled in `classId` at `instant` (a real UTC
 * instant), with the enrolment row that proves it.
 *
 * `enrolments` must be ALL of this student's ClassStudent rows for the class
 * (removed ones included); rows of other classes are ignored. Rows whose
 * period cannot be placed in time never count as enrolment (fail closed: no
 * automatic attendance or ABSENT from them) and are listed in `unusable`.
 * Throws when `instant` is not a valid date.
 */
export function explainEnrolmentAt(
  enrolments: readonly EnrolmentRow[],
  classId: string,
  instant: Date
): EnrolmentExplanation {
  if (!isValidDate(instant)) {
    throw new RangeError("enrolmentAt: a valid instant is required.");
  }

  const at = instant.getTime();
  const unusable: { enrolmentId: string; reason: UnusableEnrolmentReason }[] = [];
  const covering: string[] = [];

  for (const row of enrolments) {
    if (row.classId !== classId) continue;

    const reason = unusableReason(row);

    if (reason) {
      unusable.push({ enrolmentId: row.id, reason });
      continue;
    }

    const start = sriLankaDigitsToInstant(row.assignedAt).getTime();
    const end = row.removedAt === null ? null : sriLankaDigitsToInstant(row.removedAt).getTime();

    if (start <= at && (end === null || at < end)) covering.push(row.id);
  }

  if (covering.length > 0) {
    // Deterministic when periods overlap (should not happen): the smallest id.
    return { enrolled: true, enrolmentId: [...covering].sort()[0] };
  }

  return { enrolled: false, enrolmentId: null, unusable };
}

/** Was the student enrolled in `classId` at `instant`? (see explainEnrolmentAt) */
export function enrolledAt(enrolments: readonly EnrolmentRow[], classId: string, instant: Date): boolean {
  return explainEnrolmentAt(enrolments, classId, instant).enrolled;
}
