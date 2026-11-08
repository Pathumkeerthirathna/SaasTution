/**
 * Automatic monthly joining fee waiver: pure calculation (no database).
 * See docs/fee-waiver-rules.md and services/class-fee-waiver-service.ts.
 *
 * For a class and a Sri Lankan billing month, a student who JOINED during the
 * month gets ONE configured rule: rule N when N COMPLETED lectures of that
 * class were held in the month strictly before the student joined (the last
 * rule when N exceeds the number of rules). Rules are never added together.
 *
 * Timestamp conventions (see lib/time.ts):
 *  - ClassStudent.assignedAt / removedAt hold Sri Lankan wall-clock digits
 *    (written with nowInSriLanka()): converted with sriLankaDigitsToInstant.
 *  - Student.approvedAt and Lecture.date are real UTC instants: used as is.
 * All comparisons below are between real UTC instants.
 */

import { sriLankaCalendarParts, sriLankaDigitsToInstant } from "@/lib/time";

export type FeeWaiverRuleType = "PERCENTAGE" | "FIXED_AMOUNT";

export const MAX_FEE_WAIVER_RULES = 20;
export const MAX_FIXED_FEE_WAIVER = 10_000_000;

export type BillingMonth = { year: number; month: number };

// ---- Billing months and the launch gate ----------------------------------------

export function compareBillingMonths(a: BillingMonth, b: BillingMonth): number {
  return a.year !== b.year ? a.year - b.year : a.month - b.month;
}

/** Sri Lankan billing month of a real instant. */
export function billingMonthOf(instant: Date): BillingMonth {
  const { year, month } = sriLankaCalendarParts(instant);
  return { year, month };
}

/** Real UTC instants [start, end) of a Sri Lankan calendar month. */
export function sriLankaMonthWindow({ year, month }: BillingMonth): { start: Date; end: Date } {
  return {
    start: sriLankaDigitsToInstant(new Date(Date.UTC(year, month - 1, 1))),
    end: sriLankaDigitsToInstant(new Date(Date.UTC(year, month, 1))),
  };
}

/**
 * The first full Sri Lankan month after `instant`. Mirrors the SQL that the
 * migration uses to write FeeWaiverSettings (kept in sync by the guard test).
 */
export function firstFullSriLankaMonthAfter(instant: Date): BillingMonth {
  const { year, month } = sriLankaCalendarParts(instant);
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/**
 * Validates the FeeWaiverSettings row. Anything missing or out of range means
 * "not configured": automatic waivers then stay off everywhere (fail-safe).
 */
export function parseFeeWaiverStart(
  row: { startYear: unknown; startMonth: unknown } | null | undefined
): BillingMonth | null {
  if (!row) return null;
  const { startYear, startMonth } = row;

  if (
    !Number.isInteger(startYear) ||
    !Number.isInteger(startMonth) ||
    (startYear as number) < 2026 ||
    (startYear as number) > 2100 ||
    (startMonth as number) < 1 ||
    (startMonth as number) > 12
  ) {
    return null;
  }

  return { year: startYear as number, month: startMonth as number };
}

/** Whether automatic waivers apply to `month` (never before the launch month). */
export function isWaiverMonth(start: BillingMonth | null, month: BillingMonth): boolean {
  return start !== null && compareBillingMonths(month, start) >= 0;
}

// ---- Enrolments -----------------------------------------------------------------

export type WaiverStudent = {
  status: number;
  registrationSource: string;
  publicClassId: string | null;
  confirmationStatus: string;
  approvedAt: Date | null;
};

export type WaiverEnrolment = {
  id: string;
  classId: string;
  assignedAt: Date; // Sri Lankan wall-clock digits
  removedAt: Date | null; // Sri Lankan wall-clock digits
};

export type EnrolmentTimes = {
  /** When the enrolment counts as present (used for "enrolled at month start"). */
  presenceStart: Date;
  /** When it counts as joined for a waiver; null = this row can never get one. */
  waiverStart: Date | null;
  end: Date | null;
};

/**
 * Pending and rejected public registrations, and inactive / deleted students,
 * never get an automatic joining waiver (on any enrolment).
 */
export function studentPassesGate(student: WaiverStudent): boolean {
  if (student.status !== 0) return false;
  if (student.registrationSource === "PUBLIC_CLASS" && student.confirmationStatus !== "APPROVED") {
    return false;
  }
  return true;
}

function byInstantThenId(a: { at: Date; id: string }, b: { at: Date; id: string }) {
  const diff = a.at.getTime() - b.at.getTime();
  return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Real-instant times of each enrolment of ONE class. Only the original
 * public-registration enrolment (the student's earliest enrolment in its
 * publicClassId) counts from the later of its assignment and the student's
 * FIRST approval; every other enrolment (teacher assignments, re-adds, other
 * classes) counts from its own assignedAt.
 */
export function enrolmentTimes(
  student: WaiverStudent,
  enrolments: WaiverEnrolment[]
): Map<string, EnrolmentTimes> {
  const times = new Map<string, EnrolmentTimes>();

  const publicRowId =
    student.registrationSource === "PUBLIC_CLASS" && student.publicClassId
      ? enrolments
          .filter((e) => e.classId === student.publicClassId)
          .map((e) => ({ at: e.assignedAt, id: e.id }))
          .sort(byInstantThenId)[0]?.id ?? null
      : null;

  for (const enrolment of enrolments) {
    const assigned = sriLankaDigitsToInstant(enrolment.assignedAt);
    const end = enrolment.removedAt ? sriLankaDigitsToInstant(enrolment.removedAt) : null;

    if (enrolment.id === publicRowId) {
      const approved = student.approvedAt;
      const presenceStart =
        approved && approved.getTime() > assigned.getTime() ? approved : assigned;
      const waiverStart =
        student.confirmationStatus === "APPROVED" && approved ? presenceStart : null;
      times.set(enrolment.id, { presenceStart, waiverStart, end });
    } else {
      times.set(enrolment.id, { presenceStart: assigned, waiverStart: assigned, end });
    }
  }

  return times;
}

/**
 * The one enrolment of (student, class) that may get the month's joining
 * waiver, with the instant it joined; null when none may. `enrolments` must be
 * ALL enrolments of the student in that class (including removed ones).
 */
export function selectJoiningEnrolment(
  student: WaiverStudent,
  enrolments: WaiverEnrolment[],
  month: BillingMonth
): { enrolmentId: string; enrolledAt: Date } | null {
  if (!studentPassesGate(student)) return null;

  const { start, end } = sriLankaMonthWindow(month);
  const times = enrolmentTimes(student, enrolments);

  // Enrolled when the month began: no joining waiver this month.
  for (const t of times.values()) {
    if (t.presenceStart.getTime() < start.getTime() && (t.end === null || t.end.getTime() >= start.getTime())) {
      return null;
    }
  }

  const candidates = enrolments
    .map((e) => ({ id: e.id, at: times.get(e.id)!.waiverStart }))
    .filter((c): c is { id: string; at: Date } =>
      c.at !== null && c.at.getTime() >= start.getTime() && c.at.getTime() < end.getTime()
    )
    .sort(byInstantThenId);

  return candidates.length > 0 ? { enrolmentId: candidates[0].id, enrolledAt: candidates[0].at } : null;
}

// ---- Rules ----------------------------------------------------------------------

export type WaiverRule = {
  id: string;
  sequence: number;
  type: FeeWaiverRuleType;
  value: number;
};

/** Rule N for N lectures before joining (the last rule when N is larger). */
export function selectRule(rules: WaiverRule[], lecturesBefore: number): WaiverRule | null {
  if (lecturesBefore <= 0 || rules.length === 0) return null;
  const ordered = [...rules].sort((a, b) => a.sequence - b.sequence);
  return ordered[Math.min(lecturesBefore, ordered.length) - 1];
}

/**
 * The deduction of one rule from `baseAmount` (whole LKR): percentages rounded
 * half up, fixed amounts never above the fee. Never negative.
 */
export function computeDeduction(rule: Pick<WaiverRule, "type" | "value">, baseAmount: number): number {
  const base = Math.max(0, Math.round(baseAmount));

  if (rule.type === "PERCENTAGE") {
    const percent = Math.min(100, Math.max(0, rule.value));
    // Integer arithmetic: round half up without floating-point drift.
    return Math.floor((base * percent + 50) / 100);
  }

  return Math.min(Math.max(0, rule.value), base);
}

// ---- The whole calculation for one fee row ---------------------------------------

export type JoinWaiverResult =
  | {
      kind: "AUTO";
      ruleId: string;
      sequence: number;
      type: FeeWaiverRuleType;
      value: number;
      lecturesBefore: number;
      enrolledAt: Date;
      baseAmount: number;
      deduction: number;
    }
  | { kind: "NONE" };

export function computeJoinWaiver(input: {
  student: WaiverStudent;
  /** All enrolments of the student in the fee row's class. */
  enrolments: WaiverEnrolment[];
  /** The fee row's enrolment. */
  enrolmentId: string;
  month: BillingMonth;
  /** Dates of the class's active COMPLETED lectures (any range; filtered here). */
  completedLectureDates: Date[];
  rules: WaiverRule[];
  baseAmount: number;
}): JoinWaiverResult {
  const joining = selectJoiningEnrolment(input.student, input.enrolments, input.month);

  if (!joining || joining.enrolmentId !== input.enrolmentId) {
    return { kind: "NONE" };
  }

  const { start } = sriLankaMonthWindow(input.month);
  const lecturesBefore = input.completedLectureDates.filter(
    (date) => date.getTime() >= start.getTime() && date.getTime() < joining.enrolledAt.getTime()
  ).length;

  const rule = selectRule(input.rules, lecturesBefore);

  if (!rule) {
    return { kind: "NONE" };
  }

  return {
    kind: "AUTO",
    ruleId: rule.id,
    sequence: rule.sequence,
    type: rule.type,
    value: rule.value,
    lecturesBefore,
    enrolledAt: joining.enrolledAt,
    baseAmount: Math.max(0, Math.round(input.baseAmount)),
    deduction: computeDeduction(rule, input.baseAmount),
  };
}

/** The ClassStudentFee columns that store a result (NONE clears the snapshot). */
export function joinWaiverColumns(result: JoinWaiverResult, computedAt: Date) {
  if (result.kind === "NONE") {
    return {
      lateJoinDeduct: 0,
      joinWaiverRuleId: null,
      joinWaiverSequence: null,
      joinWaiverType: null,
      joinWaiverValue: null,
      joinWaiverLecturesBefore: null,
      joinWaiverEnrolledAt: null,
      joinWaiverBaseAmount: null,
      joinWaiverComputedAt: null,
    };
  }

  return {
    lateJoinDeduct: result.deduction,
    joinWaiverRuleId: result.ruleId,
    joinWaiverSequence: result.sequence,
    joinWaiverType: result.type,
    joinWaiverValue: result.value,
    joinWaiverLecturesBefore: result.lecturesBefore,
    joinWaiverEnrolledAt: result.enrolledAt,
    joinWaiverBaseAmount: result.baseAmount,
    joinWaiverComputedAt: computedAt,
  };
}
