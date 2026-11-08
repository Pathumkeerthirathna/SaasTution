import { type BillingMonth, billingMonthOf } from "@/lib/fee-waiver";
import { prisma } from "@/lib/prisma";
import {
  recalculateJoinWaiversForClassMonth,
  recalculateStudentCurrentMonthJoinWaivers,
} from "@/services/class-student-fee-service";

/**
 * Entry points that recalculate automatic joining waivers after explicit
 * events. They run AFTER the event's own write has committed, outside its
 * transaction, and never throw: a waiver failure is logged and can never fail
 * (or undo) the student decision or lecture change that triggered it.
 */

export type LectureWaiverState = {
  classId: string;
  date: Date;
  classStatus: string;
  status: number;
};

/** A lecture's waiver-relevant state (null if it cannot be read). */
export async function readLectureWaiverState(lectureId: string): Promise<LectureWaiverState | null> {
  try {
    return await prisma.lecture.findUnique({
      where: { id: lectureId },
      select: { classId: true, date: true, classStatus: true, status: true },
    });
  } catch (error) {
    console.error("[FEE_WAIVER] could not read lecture state:", error);
    return null;
  }
}

const countsForWaivers = (state: LectureWaiverState | null): state is LectureWaiverState =>
  state !== null && state.status === 0 && state.classStatus === "COMPLETED";

/**
 * The (class, Sri Lankan billing month) pairs a lecture change affects: the
 * old one if the lecture counted before, the new one if it counts after.
 * Nothing when neither counted, or when nothing waiver-relevant changed.
 */
export function affectedClassMonths(
  before: LectureWaiverState | null,
  after: LectureWaiverState | null
): Array<{ classId: string; month: BillingMonth }> {
  if (
    before &&
    after &&
    before.classId === after.classId &&
    before.date.getTime() === after.date.getTime() &&
    before.classStatus === after.classStatus &&
    before.status === after.status
  ) {
    return [];
  }

  const pairs: Array<{ classId: string; month: BillingMonth }> = [];

  for (const state of [before, after]) {
    if (!countsForWaivers(state)) continue;
    const month = billingMonthOf(state.date);
    if (!pairs.some((p) => p.classId === state.classId && p.month.year === month.year && p.month.month === month.month)) {
      pairs.push({ classId: state.classId, month });
    }
  }

  return pairs;
}

/** After a lecture changed: recalculate every affected class/month. Never throws. */
export async function recalculateAfterLectureChange(
  before: LectureWaiverState | null,
  after: LectureWaiverState | null
): Promise<void> {
  for (const { classId, month } of affectedClassMonths(before, after)) {
    try {
      await recalculateJoinWaiversForClassMonth({ classId, month });
    } catch (error) {
      console.error(
        `[FEE_WAIVER] recalculation after a lecture change failed (class ${classId}, ${month.year}-${month.month}):`,
        error
      );
    }
  }
}

/** After a student's approval or decline. Never throws. */
export async function recalculateAfterStudentDecision(studentId: string): Promise<void> {
  try {
    await recalculateStudentCurrentMonthJoinWaivers(studentId);
  } catch (error) {
    console.error(`[FEE_WAIVER] recalculation after a student decision failed (student ${studentId}):`, error);
  }
}
