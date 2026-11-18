import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import {
  type BillingMonth,
  type JoinWaiverResult,
  isWaiverMonth,
  joinWaiverColumns,
} from "@/lib/fee-waiver";
import { getPaymentDueStatus } from "@/lib/payment-validation";
import { emitStudentDataChange } from "@/lib/session-events";
import { feePaymentState, hasAwaitingSubmission, PAYMENT_STATE_SELECT, type FeePaymentState } from "@/lib/fee-payment-state";
import { nowInSriLanka, sriLankaCalendarParts } from "@/lib/time";
import {
  type ClassMonthWaiverContext,
  getFeeWaiverStart,
  joinWaiverFor,
  loadClassMonthWaiverContext,
} from "@/services/class-fee-waiver-service";

/**
 * Anything that can run the model queries this file needs — either the plain
 * `prisma` singleton, or the `tx` client Prisma hands to a
 * `prisma.$transaction(async (tx) => {...})` callback. Lets the new
 * single-ClassStudent helper below participate in a caller's own transaction
 * (so a rollback there rolls back the fee row too) while every existing
 * function in this file keeps using the plain `prisma` singleton, unchanged.
 */
type Db = Prisma.TransactionClient;

export type EnrolmentPeriod = {
  assignedAt: string;
  removedAt: string | null;
};

export type FeePaymentDetail = {
  id: string;
  amount: number;
  status: "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";
  note: string | null;
  teacherFeedback: string | null;
  hasSlip: boolean;
  submittedAt: string;
  confirmedAt: string | null;
  /** STUDENT_SLIP (uploaded by the student) or TEACHER_RECORDED. */
  source: "STUDENT_SLIP" | "TEACHER_RECORDED";
  /** A reversed payment stays in the history but no longer counts as received. */
  reversed: boolean;
  /** TEACHER_RECORDED only (null for student slips). */
  paymentMethod: "CASH" | "BANK_TRANSFER" | "OTHER" | null;
  /** When the teacher received the money (real UTC instant); TEACHER_RECORDED only. */
  receivedAt: string | null;
  /** Name of the teacher who recorded it (null when unknown or a slip). */
  recordedByName: string | null;
  /** The audit record of the reversal, when reversed. */
  reversal: {
    amount: number;
    reason: string;
    reversedByRole: "TEACHER" | "ADMIN";
    /** The teacher's name; null for an administrator or an unknown account. */
    reversedByName: string | null;
    createdAt: string;
  } | null;
};

/** Snapshot of the automatic joining waiver applied to a fee row. */
export type JoinWaiverSnapshot = {
  sequence: number;
  type: "PERCENTAGE" | "FIXED_AMOUNT";
  value: number;
  lecturesBefore: number;
  /** Real UTC instant the enrolment counted from. */
  enrolledAt: string;
  baseAmount: number;
  computedAt: string | null;
};

export type MonthlyFeeRow = {
  feeId: string | null;
  classStudentId: string;
  studentId: string;
  studentName: string;
  registrationNumber: string | null;
  assignedAt: string;
  /**
   * Every assign/remove period for this student in the class, oldest first.
   * When a student was assigned and removed more than once, the UI shows each
   * assign date plus a "Removed" date.
   */
  enrolments: EnrolmentPeriod[];
  amount: number;
  discount: number;
  lateJoinDeduct: number;
  /** lateJoinDeduct was entered by the teacher (automatic calculation keeps it). */
  lateJoinDeductManual: boolean;
  /** The automatic joining waiver behind lateJoinDeduct, if any. */
  joinWaiver: JoinWaiverSnapshot | null;
  waiverAmount: number;
  finalAmount: number;
  dueDate: string | null;
  createdAt: string | null;
  hasPaid: boolean;
  /**
   * From feePaymentState: PAID (received >= finalAmount), PARTIAL (received
   * but an amount is still outstanding), FREE_CARD (an active Free Card and
   * nothing received), PENDING (a slip awaits processing), UNPAID.
   */
  paymentStatus: "PAID" | "PARTIAL" | "PENDING" | "UNPAID" | "FREE_CARD";
  /** Received / awaiting / outstanding amounts (feePaymentState). */
  paymentSummary: Omit<FeePaymentState, "state">;
  payments: FeePaymentDetail[];
  /** Teacher-issued Free Card: finalAmount is 0, the components are kept. */
  freeCard: boolean;
  /** Real UTC instant the Free Card was issued. */
  freeCardIssuedAt: string | null;
};

export type MonthlyFeeSheet = {
  class: {
    id: string;
    name: string;
    paymentDueWeek: number;
  };
  year: number;
  month: number;
  /** The class's live current fee (the open ClassFee period). */
  currentFee: number;
  /** The class fee applied to this month's rows (fee as of the due date). */
  periodFee: number;
  isCurrentPeriod: boolean;
  isPastPeriod: boolean;
  isFuturePeriod: boolean;
  processed: boolean;
  dueDate: string;
  isPastDue: boolean;
  isDueSoon: boolean;
  /** Automatic joining waivers apply to this month (on/after the launch month). */
  joinWaiversActive: boolean;
  rows: MonthlyFeeRow[];
};

/**
 * The amount a student pays. An active Free Card makes it 0 without touching
 * the components underneath (they keep being maintained, so revoking the card
 * restores the current calculation). Without a card: unchanged formula.
 */
export function computeFinalAmount(
  amount: number,
  discount: number,
  lateJoinDeduct: number,
  waiverAmount: number,
  freeCard = false
) {
  if (freeCard) return 0;
  return Math.max(0, amount - discount - lateJoinDeduct - waiverAmount);
}

const FREE_CARD_ACTIVE_MESSAGE =
  "This student has a Free Card for this month. Revoke the Free Card before changing this fee.";

// ---- Automatic joining waiver helpers (see lib/fee-waiver.ts) -------------------

/** Columns read to compare a row's current waiver with a recalculated one. */
const WAIVER_STATE_SELECT = {
  lateJoinDeductManual: true,
  joinWaiverRuleId: true,
  joinWaiverSequence: true,
  joinWaiverType: true,
  joinWaiverValue: true,
  joinWaiverLecturesBefore: true,
  joinWaiverEnrolledAt: true,
  joinWaiverBaseAmount: true,
} as const;

type WaiverState = {
  lateJoinDeduct: number;
  joinWaiverRuleId: string | null;
  joinWaiverSequence: number | null;
  joinWaiverType: string | null;
  joinWaiverValue: number | null;
  joinWaiverLecturesBefore: number | null;
  joinWaiverEnrolledAt: Date | null;
  joinWaiverBaseAmount: number | null;
};

type WaiverColumns = ReturnType<typeof joinWaiverColumns>;

function sameWaiver(row: WaiverState, next: WaiverColumns) {
  return (
    row.lateJoinDeduct === next.lateJoinDeduct &&
    row.joinWaiverRuleId === next.joinWaiverRuleId &&
    row.joinWaiverSequence === next.joinWaiverSequence &&
    row.joinWaiverType === next.joinWaiverType &&
    row.joinWaiverValue === next.joinWaiverValue &&
    row.joinWaiverLecturesBefore === next.joinWaiverLecturesBefore &&
    (row.joinWaiverEnrolledAt?.getTime() ?? null) === (next.joinWaiverEnrolledAt?.getTime() ?? null) &&
    row.joinWaiverBaseAmount === next.joinWaiverBaseAmount
  );
}

/** Columns that clear an automatic waiver snapshot (manual entry). */
const CLEARED_WAIVER_SNAPSHOT = {
  joinWaiverRuleId: null,
  joinWaiverSequence: null,
  joinWaiverType: null,
  joinWaiverValue: null,
  joinWaiverLecturesBefore: null,
  joinWaiverEnrolledAt: null,
  joinWaiverBaseAmount: null,
  joinWaiverComputedAt: null,
} as const;

/**
 * Loads (and caches per class+month) the waiver context, or null when the
 * month is before the launch month (then no waiver column is ever written).
 */
function createWaiverContextCache(db: Db, start: BillingMonth | null) {
  const cache = new Map<string, Promise<ClassMonthWaiverContext>>();

  return async (classId: string, month: BillingMonth, studentIds?: string[]) => {
    if (!isWaiverMonth(start, month)) {
      return null;
    }
    const key = `${classId}|${month.year}-${month.month}|${studentIds?.join(",") ?? "*"}`;
    let context = cache.get(key);
    if (!context) {
      context = loadClassMonthWaiverContext(db, classId, month, studentIds);
      cache.set(key, context);
    }
    return context;
  };
}

/** Waiver columns for a NEW fee row (all zero / empty when not applicable). */
function newRowWaiverColumns(
  context: ClassMonthWaiverContext | null,
  studentId: string,
  classStudentId: string,
  amount: number
): Partial<WaiverColumns> {
  if (!context) return {};
  const result: JoinWaiverResult = joinWaiverFor(context, studentId, classStudentId, amount);
  return result.kind === "AUTO" ? joinWaiverColumns(result, new Date()) : {};
}

/**
 * Writes an automatic-waiver update only if the row is still automatic and
 * unpaid — and, with `updatedAt`, unchanged since it was read. A concurrent
 * manual adjustment or payment confirmation always wins (nothing written).
 */
async function writeAutomaticWaiver(
  db: Db,
  row: { id: string; updatedAt?: Date; freeCard: boolean },
  data: Prisma.ClassStudentFeeUpdateManyMutationInput
) {
  const { count } = await db.classStudentFee.updateMany({
    where: {
      id: row.id,
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      // finalAmount was computed for this Free Card state: a card issued or
      // revoked meanwhile wins (nothing written).
      freeCard: row.freeCard,
      lateJoinDeductManual: false,
      payments: { none: { status: "CONFIRMED" } },
    },
    data,
  });
  return count > 0;
}

/**
 * Due date for a class fee period: the last day of the configured payment week
 * (week 1 -> 7th, week 2 -> 14th, ...) at end of day. Built from UTC calendar
 * fields so the stored digits are stable regardless of server timezone.
 */
function computeDueDate(year: number, month: number, paymentDueWeek: number) {
  const week = Math.min(4, Math.max(1, paymentDueWeek || 1));
  const day = week * 7;
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
}

function isCurrentPeriod(year: number, month: number) {
  const now = nowInSriLanka();
  return now.getUTCFullYear() === year && now.getUTCMonth() + 1 === month;
}

export async function assertTeacherOwnsClass(teacherId: string, classId: string) {
  const classInfo = await prisma.class.findFirst({
    where: { id: classId, teacherId, status: 0 },
    select: { id: true, name: true, monthlyFee: true, paymentDueWeek: true },
  });

  if (!classInfo) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  return classInfo;
}

function monthWindow(year: number, month: number) {
  return {
    start: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}

/**
 * The class fee to charge for a month: the fee whose period had started on or
 * before that month's payment due date. A fee change made *after* the due date
 * does not affect that month's charge. If no fee period had started by the due
 * date (e.g. the class was created later in the month), the earliest recorded
 * fee is used; failing that, the class's current monthly fee.
 */
async function getClassFeeForPeriod(
  classId: string,
  year: number,
  month: number,
  paymentDueWeek: number,
  fallback: number
) {
  const dueDate = computeDueDate(year, month, paymentDueWeek);

  const atDueDate = await prisma.classFee.findFirst({
    where: { classId, effectiveFrom: { lte: dueDate } },
    orderBy: { effectiveFrom: "desc" },
    select: { amount: true },
  });

  if (atDueDate) {
    return atDueDate.amount;
  }

  const earliest = await prisma.classFee.findFirst({
    where: { classId },
    orderBy: { effectiveFrom: "asc" },
    select: { amount: true },
  });

  return earliest?.amount ?? fallback;
}

/**
 * The class's live fee: the open ClassFee period, else the class monthly fee.
 * Defaults to the plain `prisma` singleton — every existing call site omits
 * `db` and behaves exactly as before; `ensureCurrentMonthFeeForClassStudent`
 * below is the only caller that passes a transaction client.
 */
async function getCurrentClassFee(classId: string, fallback: number, db: Db = prisma) {
  const open = await db.classFee.findFirst({
    where: { classId, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
    select: { amount: true },
  });

  return open?.amount ?? fallback;
}

/**
 * Creates the CURRENT month's ClassStudentFee for exactly ONE ClassStudent, if
 * it doesn't already exist — reusing the exact same amount/due-date/final-
 * amount calculation `processCurrentMonthFees` already uses for the teacher's
 * Fee Sheet, just scoped to a single enrolment instead of every active student
 * in the class. This never touches, and is never called by,
 * `processCurrentMonthFees`/`processPastMonthFees`/`reprocessMonthlyFees` —
 * their existing behavior for the teacher Fee Sheet is unchanged.
 *
 * Pass `tx` (from `prisma.$transaction(async (tx) => {...})`) to run this as
 * part of an assignment transaction, so a rollback there also rolls back the
 * fee row; pass the plain `prisma` singleton to run it standalone (e.g. a
 * defensive backfill from a GET route).
 *
 * No-ops — creates nothing — if the ClassStudent can't be found, isn't
 * active, its student isn't active, its class isn't active, or a fee row for
 * the current month already exists. The same
 * `@@unique([classStudentId, year, month])` constraint the rest of this file
 * already relies on protects against ever creating a duplicate.
 */
export async function ensureCurrentMonthFeeForClassStudent(
  db: Db,
  classStudentId: string
): Promise<void> {
  const classStudent = await db.classStudent.findFirst({
    where: {
      id: classStudentId,
      isActive: true,
      student: { status: 0 },
      class: { status: 0 },
    },
    select: {
      id: true,
      classId: true,
      studentId: true,
      class: { select: { monthlyFee: true, paymentDueWeek: true } },
    },
  });

  if (!classStudent) {
    return;
  }

  const now = nowInSriLanka();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const existing = await db.classStudentFee.findFirst({
    where: { classStudentId, year, month },
    select: { id: true },
  });

  if (existing) {
    return;
  }

  const currentFee = await getCurrentClassFee(
    classStudent.classId,
    classStudent.class.monthlyFee,
    db
  );

  const dueDate = computeDueDate(year, month, classStudent.class.paymentDueWeek);

  // Automatic joining waiver, calculated in the caller's transaction (the
  // enrolment being created is visible to it). Nothing for pre-launch months.
  const waiverContext = await createWaiverContextCache(db, await getFeeWaiverStart(db))(
    classStudent.classId,
    { year, month },
    [classStudent.studentId]
  );
  const waiver = newRowWaiverColumns(waiverContext, classStudent.studentId, classStudentId, currentFee);
  const lateJoinDeduct = waiver.lateJoinDeduct ?? 0;

  await db.classStudentFee.create({
    data: {
      classStudentId,
      year,
      month,
      amount: currentFee,
      discount: 0,
      lateJoinDeduct: 0,
      waiverAmount: 0,
      ...waiver,
      finalAmount: computeFinalAmount(currentFee, 0, lateJoinDeduct, 0),
      dueDate,
      status: 0,
      createdAt: now,
    },
  });
}

/**
 * For the current calendar month only: make sure every active student of the
 * class has a ClassStudentFee row for (year, month), and keep the amount in
 * sync with the class's current fee — but never touch a row once its due date
 * (or the class's payment due date for the month) has passed.
 */
async function processCurrentMonthFees(params: {
  classId: string;
  paymentDueWeek: number;
  currentFee: number;
  year: number;
  month: number;
}) {
  const { classId, paymentDueWeek, currentFee, year, month } = params;

  const dueDate = computeDueDate(year, month, paymentDueWeek);
  const now = nowInSriLanka();
  const classDueDatePassed = now.getTime() > dueDate.getTime();

  const activeStudents = await prisma.classStudent.findMany({
    where: { classId, isActive: true, student: { status: 0 } },
    select: { id: true, studentId: true },
  });

  if (activeStudents.length === 0) {
    return;
  }

  const classStudentIds = activeStudents.map((entry) => entry.id);
  const studentIdByEnrolment = new Map(activeStudents.map((entry) => [entry.id, entry.studentId]));

  // Automatic joining waivers: null before the launch month (nothing written).
  const waiverContext = await createWaiverContextCache(prisma, await getFeeWaiverStart())(classId, {
    year,
    month,
  });

  const existing = await prisma.classStudentFee.findMany({
    where: { classStudentId: { in: classStudentIds }, year, month },
    include: { payments: { select: { status: true } } },
  });

  const existingByClassStudent = new Map(
    existing.map((row) => [row.classStudentId, row])
  );

  const missing = classStudentIds.filter(
    (id) => !existingByClassStudent.has(id)
  );

  if (missing.length > 0) {
    await prisma.classStudentFee.createMany({
      data: missing.map((classStudentId) => {
        const waiver = newRowWaiverColumns(
          waiverContext,
          studentIdByEnrolment.get(classStudentId)!,
          classStudentId,
          currentFee
        );
        return {
          classStudentId,
          year,
          month,
          amount: currentFee,
          discount: 0,
          lateJoinDeduct: 0,
          waiverAmount: 0,
          ...waiver,
          finalAmount: computeFinalAmount(currentFee, 0, waiver.lateJoinDeduct ?? 0, 0),
          dueDate,
          status: 0,
          createdAt: now,
        };
      }),
      skipDuplicates: true,
    });
  }

  for (const row of existing) {
    const rowDueDatePassed = row.dueDate
      ? now.getTime() > row.dueDate.getTime()
      : false;
    const paid = row.payments.some((p) => p.status === "CONFIRMED");

    // The existing automatic due-date freeze also freezes the waiver.
    if (rowDueDatePassed || classDueDatePassed || paid) {
      continue;
    }

    // Automatic rows also get their joining waiver recalculated (against the
    // current fee). Written only if still automatic, unpaid and unchanged.
    if (waiverContext && !row.lateJoinDeductManual) {
      const next = joinWaiverColumns(
        joinWaiverFor(waiverContext, studentIdByEnrolment.get(row.classStudentId)!, row.classStudentId, currentFee),
        new Date()
      );
      const nextFinalWithWaiver = computeFinalAmount(
        currentFee,
        row.discount,
        next.lateJoinDeduct,
        row.waiverAmount,
        row.freeCard
      );

      if (row.amount === currentFee && row.finalAmount === nextFinalWithWaiver && sameWaiver(row, next)) {
        continue;
      }

      await writeAutomaticWaiver(prisma, row, {
        amount: currentFee,
        finalAmount: nextFinalWithWaiver,
        ...next,
      });
      continue;
    }

    const nextFinal = computeFinalAmount(
      currentFee,
      row.discount,
      row.lateJoinDeduct,
      row.waiverAmount,
      row.freeCard
    );

    if (row.amount === currentFee && row.finalAmount === nextFinal) {
      continue;
    }

    // Conditional on the Free Card state read above: a card issued or revoked
    // meanwhile wins (nothing written; the next pass uses the new state).
    await prisma.classStudentFee.updateMany({
      where: { id: row.id, freeCard: row.freeCard },
      data: { amount: currentFee, finalAmount: nextFinal },
    });
  }
}

/**
 * For a month that has already finished: back-fill a ClassStudentFee row for
 * every student whose enrolment overlapped that month and who has no row yet.
 * The amount is the fee that applied during that past month. Existing rows are
 * never touched.
 */
async function processPastMonthFees(params: {
  classId: string;
  paymentDueWeek: number;
  periodFee: number;
  year: number;
  month: number;
}) {
  const { classId, paymentDueWeek, periodFee, year, month } = params;
  const { start, end } = monthWindow(year, month);

  // Every enrolment period that overlaps the selected month.
  const enrolments = await prisma.classStudent.findMany({
    where: {
      classId,
      assignedAt: { lte: end },
      OR: [{ removedAt: null }, { removedAt: { gte: start } }],
    },
    select: { id: true, studentId: true },
  });

  if (enrolments.length === 0) {
    return;
  }

  const classStudentIds = enrolments.map((entry) => entry.id);

  const existing = await prisma.classStudentFee.findMany({
    where: { classStudentId: { in: classStudentIds }, year, month },
    select: { classStudentId: true },
  });

  const existingSet = new Set(existing.map((row) => row.classStudentId));
  const missing = classStudentIds.filter((id) => !existingSet.has(id));

  if (missing.length === 0) {
    return;
  }

  const dueDate = computeDueDate(year, month, paymentDueWeek);
  const now = nowInSriLanka();

  // Only NEW past rows get their automatic joining waiver; existing past rows
  // are never touched here (only an explicit Reprocess recalculates them).
  const studentIdByEnrolment = new Map(enrolments.map((entry) => [entry.id, entry.studentId]));
  const waiverContext = await createWaiverContextCache(prisma, await getFeeWaiverStart())(classId, {
    year,
    month,
  });

  await prisma.classStudentFee.createMany({
    data: missing.map((classStudentId) => {
      const waiver = newRowWaiverColumns(
        waiverContext,
        studentIdByEnrolment.get(classStudentId)!,
        classStudentId,
        periodFee
      );
      return {
        classStudentId,
        year,
        month,
        amount: periodFee,
        discount: 0,
        lateJoinDeduct: 0,
        waiverAmount: 0,
        ...waiver,
        finalAmount: computeFinalAmount(periodFee, 0, waiver.lateJoinDeduct ?? 0, 0),
        dueDate,
        status: 0,
        createdAt: now,
      };
    }),
    skipDuplicates: true,
  });
}

/**
 * Explicit teacher-triggered reprocess. Unlike the automatic pass, this forces
 * every fee row for the month to:
 *  - the class fee that applied on or before the month's payment due date,
 *  - a recomputed final amount (teacher adjustments are kept),
 *  - a paid / unpaid status based on the student's linked payments,
 * and back-fills rows for any enrolled student that is still missing one.
 */
export async function reprocessMonthlyFees(params: {
  teacherId: string;
  classId: string;
  year: number;
  month: number;
}): Promise<MonthlyFeeSheet> {
  const { teacherId, classId, year, month } = params;

  if (!Number.isInteger(year) || year < 1900 || year > 3000) {
    throw new AppError("A valid year is required.", 400, "VALIDATION_ERROR");
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new AppError("Month must be between 1 and 12.", 400, "VALIDATION_ERROR");
  }

  const classInfo = await assertTeacherOwnsClass(teacherId, classId);

  const now = nowInSriLanka();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  const isFuture = year > nowYear || (year === nowYear && month > nowMonth);

  // Nothing to reprocess for a month that has not started.
  if (!isFuture) {
    const periodFee = await getClassFeeForPeriod(
      classId,
      year,
      month,
      classInfo.paymentDueWeek,
      classInfo.monthlyFee
    );
    const dueDate = computeDueDate(year, month, classInfo.paymentDueWeek);
    const { start, end } = monthWindow(year, month);

    const enrolments = await prisma.classStudent.findMany({
      where: {
        classId,
        assignedAt: { lte: end },
        OR: [{ removedAt: null }, { removedAt: { gte: start } }],
      },
      select: { id: true, studentId: true },
    });

    const classStudentIds = enrolments.map((entry) => entry.id);
    const studentIdByEnrolment = new Map(enrolments.map((entry) => [entry.id, entry.studentId]));

    // Explicit Reprocess recalculates automatic joining waivers of unpaid rows
    // (past or current, regardless of the due date); never before the launch month.
    const waiverContext = await createWaiverContextCache(prisma, await getFeeWaiverStart())(classId, {
      year,
      month,
    });

    const existing = await prisma.classStudentFee.findMany({
      where: { classStudentId: { in: classStudentIds }, year, month },
      select: {
        id: true,
        classStudentId: true,
        discount: true,
        lateJoinDeduct: true,
        waiverAmount: true,
        finalAmount: true,
        freeCard: true,
        ...WAIVER_STATE_SELECT,
        payments: { select: PAYMENT_STATE_SELECT },
      },
    });

    const existingSet = new Set(existing.map((row) => row.classStudentId));
    const missing = classStudentIds.filter((id) => !existingSet.has(id));

    if (missing.length > 0) {
      await prisma.classStudentFee.createMany({
        data: missing.map((classStudentId) => {
          const waiver = newRowWaiverColumns(
            waiverContext,
            studentIdByEnrolment.get(classStudentId)!,
            classStudentId,
            periodFee
          );
          return {
            classStudentId,
            year,
            month,
            amount: periodFee,
            discount: 0,
            lateJoinDeduct: 0,
            waiverAmount: 0,
            ...waiver,
            finalAmount: computeFinalAmount(periodFee, 0, waiver.lateJoinDeduct ?? 0, 0),
            dueDate,
            status: 0,
            createdAt: now,
          };
        }),
        skipDuplicates: true,
      });
    }

    for (const row of existing) {
      const paid = row.payments.some((p) => p.status === "CONFIRMED");

      if (!paid && waiverContext && !row.lateJoinDeductManual) {
        const next = joinWaiverColumns(
          joinWaiverFor(waiverContext, studentIdByEnrolment.get(row.classStudentId)!, row.classStudentId, periodFee),
          new Date()
        );

        // Same write as below plus the waiver; skipped (not overwritten) if the
        // row became manual or paid in the meantime.
        const written = await writeAutomaticWaiver(prisma, { id: row.id, freeCard: row.freeCard }, {
          amount: periodFee,
          finalAmount: computeFinalAmount(periodFee, row.discount, next.lateJoinDeduct, row.waiverAmount, row.freeCard),
          dueDate,
          status: 0,
          ...next,
        });

        if (written) {
          continue;
        }

        // Changed meanwhile (now manual, paid, or a Free Card issued /
        // revoked): fall through to the existing write below with fresh
        // values, so a concurrent edit is not undone.
        const fresh = await prisma.classStudentFee.findUnique({
          where: { id: row.id },
          select: {
            discount: true,
            lateJoinDeduct: true,
            waiverAmount: true,
            finalAmount: true,
            freeCard: true,
            payments: { select: PAYMENT_STATE_SELECT },
          },
        });

        if (!fresh) {
          continue;
        }

        Object.assign(row, fresh);
      }

      const paidNow = row.payments.some((p) => p.status === "CONFIRMED");

      // A row with any confirmed payment is frozen (also after a reversal):
      // the money is left exactly as it was paid against. Only the paid flag
      // is refreshed: 1 when fully paid (feePaymentState), else 0, so a
      // partly paid fee stays visible and payable.
      if (paidNow) {
        await prisma.classStudentFee.update({
          where: { id: row.id },
          data: { status: feePaymentState(row, row.payments).state === "PAID" ? 1 : 0 },
        });
        continue;
      }

      // Conditional on the Free Card state read above: a card issued or
      // revoked meanwhile wins (nothing written).
      await prisma.classStudentFee.updateMany({
        where: { id: row.id, freeCard: row.freeCard },
        data: {
          amount: periodFee,
          finalAmount: computeFinalAmount(
            periodFee,
            row.discount,
            row.lateJoinDeduct,
            row.waiverAmount,
            row.freeCard
          ),
          dueDate,
          status: 0,
        },
      });
    }
  }

  return buildReadOnlySheet(classInfo, year, month);
}

export async function getMonthlyFeeSheet(params: {
  teacherId: string;
  classId: string;
  year: number;
  month: number;
}): Promise<MonthlyFeeSheet> {
  const { teacherId, classId, year, month } = params;

  if (!Number.isInteger(year) || year < 1900 || year > 3000) {
    throw new AppError("A valid year is required.", 400, "VALIDATION_ERROR");
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new AppError("Month must be between 1 and 12.", 400, "VALIDATION_ERROR");
  }

  const classInfo = await assertTeacherOwnsClass(teacherId, classId);

  const periodFee = await getClassFeeForPeriod(
    classId,
    year,
    month,
    classInfo.paymentDueWeek,
    classInfo.monthlyFee
  );

  const now = nowInSriLanka();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;

  const current = isCurrentPeriod(year, month);
  const future = year > nowYear || (year === nowYear && month > nowMonth);
  const past = !current && !future;

  if (current) {
    await processCurrentMonthFees({
      classId,
      paymentDueWeek: classInfo.paymentDueWeek,
      currentFee: periodFee,
      year,
      month,
    });
  } else if (past) {
    await processPastMonthFees({
      classId,
      paymentDueWeek: classInfo.paymentDueWeek,
      periodFee,
      year,
      month,
    });
  }

  return buildMonthlyFeeSheet({ classInfo, year, month, periodFee, current, past, future, now });
}

type ClassInfoLite = {
  id: string;
  name: string;
  monthlyFee: number;
  paymentDueWeek: number;
};

/** Read-only sheet assembly — never mutates. */
async function buildMonthlyFeeSheet(params: {
  classInfo: ClassInfoLite;
  year: number;
  month: number;
  periodFee: number;
  current: boolean;
  past: boolean;
  future: boolean;
  now: Date;
}): Promise<MonthlyFeeSheet> {
  const { classInfo, year, month, periodFee, current, past, future, now } = params;
  const classId = classInfo.id;

  const currentFee = await getCurrentClassFee(classId, classInfo.monthlyFee);

  const fees = await prisma.classStudentFee.findMany({
    where: {
      year,
      month,
      classStudent: { classId, student: { status: 0 } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      amount: true,
      discount: true,
      lateJoinDeduct: true,
      ...WAIVER_STATE_SELECT,
      joinWaiverComputedAt: true,
      waiverAmount: true,
      finalAmount: true,
      freeCard: true,
      freeCardIssuedAt: true,
      dueDate: true,
      createdAt: true,
      classStudent: {
        select: {
          id: true,
          assignedAt: true,
          isActive: true,
          student: {
            select: { id: true, name: true, registrationNumber: true },
          },
        },
      },
      payments: {
        orderBy: { submittedAt: "desc" },
        select: {
          id: true,
          amount: true,
          status: true,
          source: true,
          reversal: {
            select: { amount: true, reason: true, reversedByRole: true, reversedById: true, createdAt: true },
          },
          note: true,
          teacherFeedback: true,
          slipFileName: true,
          submittedAt: true,
          confirmedAt: true,
          paymentMethod: true,
          receivedAt: true,
          recordedByTeacher: { select: { name: true } },
        },
      },
    },
  });

  // Names of the teachers who reversed payments (the reversal stores an id
  // without a relation, so the audit survives the account): one query, only
  // when a teacher reversal is on the sheet.
  const reversingTeacherIds = Array.from(
    new Set(
      fees.flatMap((fee) =>
        fee.payments.flatMap((payment) =>
          payment.reversal?.reversedByRole === "TEACHER" ? [payment.reversal.reversedById] : []
        )
      )
    )
  );
  const reversingTeacherNames = new Map(
    reversingTeacherIds.length
      ? (
          await prisma.teacher.findMany({
            where: { id: { in: reversingTeacherIds } },
            select: { id: true, name: true },
          })
        ).map((teacher) => [teacher.id, teacher.name] as const)
      : []
  );

  // All assign/remove periods per student for this class, so the sheet can show
  // repeated enrolments within a month.
  const studentIds = Array.from(
    new Set(fees.map((fee) => fee.classStudent.student.id))
  );

  const enrolmentRows = studentIds.length
    ? await prisma.classStudent.findMany({
        where: { classId, studentId: { in: studentIds } },
        orderBy: { assignedAt: "asc" },
        select: { studentId: true, assignedAt: true, removedAt: true },
      })
    : [];

  const enrolmentsByStudent = new Map<string, EnrolmentPeriod[]>();
  for (const entry of enrolmentRows) {
    const list = enrolmentsByStudent.get(entry.studentId) ?? [];
    list.push({
      assignedAt: entry.assignedAt.toISOString(),
      removedAt: entry.removedAt ? entry.removedAt.toISOString() : null,
    });
    enrolmentsByStudent.set(entry.studentId, list);
  }

  const rows: MonthlyFeeRow[] = fees
    .map((fee) => {
      const { state, ...paymentSummary } = feePaymentState(fee, fee.payments);

      const studentId = fee.classStudent.student.id;

      return {
        feeId: fee.id,
        classStudentId: fee.classStudent.id,
        studentId,
        studentName: fee.classStudent.student.name,
        registrationNumber: fee.classStudent.student.registrationNumber,
        assignedAt: fee.classStudent.assignedAt.toISOString(),
        enrolments: enrolmentsByStudent.get(studentId) ?? [
          {
            assignedAt: fee.classStudent.assignedAt.toISOString(),
            removedAt: null,
          },
        ],
        amount: fee.amount,
        discount: fee.discount,
        lateJoinDeduct: fee.lateJoinDeduct,
        lateJoinDeductManual: fee.lateJoinDeductManual,
        joinWaiver: toJoinWaiverSnapshot(fee),
        waiverAmount: fee.waiverAmount,
        finalAmount: fee.finalAmount,
        dueDate: fee.dueDate ? fee.dueDate.toISOString() : null,
        createdAt: fee.createdAt ? fee.createdAt.toISOString() : null,
        hasPaid: state === "PAID",
        paymentStatus: state,
        paymentSummary,
        payments: fee.payments.map((payment) => ({
          id: payment.id,
          amount: payment.amount,
          status: payment.status,
          note: payment.note,
          teacherFeedback: payment.teacherFeedback,
          hasSlip: Boolean(payment.slipFileName),
          submittedAt: payment.submittedAt.toISOString(),
          confirmedAt: payment.confirmedAt
            ? payment.confirmedAt.toISOString()
            : null,
          source: payment.source,
          reversed: Boolean(payment.reversal),
          paymentMethod: payment.paymentMethod,
          receivedAt: payment.receivedAt ? payment.receivedAt.toISOString() : null,
          recordedByName: payment.recordedByTeacher?.name ?? null,
          reversal: payment.reversal
            ? {
                amount: payment.reversal.amount,
                reason: payment.reversal.reason,
                reversedByRole: payment.reversal.reversedByRole,
                reversedByName:
                  payment.reversal.reversedByRole === "TEACHER"
                    ? reversingTeacherNames.get(payment.reversal.reversedById) ?? null
                    : null,
                createdAt: payment.reversal.createdAt.toISOString(),
              }
            : null,
        })),
        freeCard: fee.freeCard,
        freeCardIssuedAt: fee.freeCardIssuedAt ? fee.freeCardIssuedAt.toISOString() : null,
      } satisfies MonthlyFeeRow;
    })
    .sort((a, b) => a.studentName.localeCompare(b.studentName));

  const dueDate = computeDueDate(year, month, classInfo.paymentDueWeek);
  const joinWaiversActive = isWaiverMonth(await getFeeWaiverStart(), { year, month });

  return {
    class: {
      id: classInfo.id,
      name: classInfo.name,
      paymentDueWeek: classInfo.paymentDueWeek,
    },
    year,
    month,
    currentFee,
    periodFee,
    isCurrentPeriod: current,
    isPastPeriod: past,
    isFuturePeriod: future,
    processed: current || past,
    dueDate: dueDate.toISOString(),
    isPastDue: now.getTime() > dueDate.getTime(),
    isDueSoon: getPaymentDueStatus(dueDate, now) === "DUE_SOON",
    joinWaiversActive,
    rows,
  };
}

function toJoinWaiverSnapshot(fee: {
  lateJoinDeductManual: boolean;
  joinWaiverSequence: number | null;
  joinWaiverType: "PERCENTAGE" | "FIXED_AMOUNT" | null;
  joinWaiverValue: number | null;
  joinWaiverLecturesBefore: number | null;
  joinWaiverEnrolledAt: Date | null;
  joinWaiverBaseAmount: number | null;
  joinWaiverComputedAt: Date | null;
}): JoinWaiverSnapshot | null {
  if (
    fee.lateJoinDeductManual ||
    fee.joinWaiverSequence === null ||
    fee.joinWaiverType === null ||
    fee.joinWaiverValue === null ||
    fee.joinWaiverLecturesBefore === null ||
    fee.joinWaiverEnrolledAt === null ||
    fee.joinWaiverBaseAmount === null
  ) {
    return null;
  }

  return {
    sequence: fee.joinWaiverSequence,
    type: fee.joinWaiverType,
    value: fee.joinWaiverValue,
    lecturesBefore: fee.joinWaiverLecturesBefore,
    enrolledAt: fee.joinWaiverEnrolledAt.toISOString(),
    baseAmount: fee.joinWaiverBaseAmount,
    computedAt: fee.joinWaiverComputedAt ? fee.joinWaiverComputedAt.toISOString() : null,
  };
}

/**
 * Set the base `amount` for one student's fee row, or for every student's fee
 * row in the month. The final amount is recomputed from each row's existing
 * adjustments.
 */
export async function setMonthlyFeeAmount(params: {
  teacherId: string;
  classId: string;
  year: number;
  month: number;
  amount: number;
  applyToAll: boolean;
  feeId?: string;
}): Promise<MonthlyFeeSheet> {
  const { teacherId, classId, year, month, applyToAll, feeId } = params;

  const amount = Math.round(params.amount);

  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError(
      "Amount must be zero or a positive number.",
      400,
      "VALIDATION_ERROR"
    );
  }

  const classInfo = await assertTeacherOwnsClass(teacherId, classId);

  const where = applyToAll
    ? { year, month, classStudent: { classId, class: { teacherId } } }
    : feeId
      ? { id: feeId, classStudent: { classId, class: { teacherId } } }
      : null;

  if (!where) {
    throw new AppError(
      "A fee row is required when not applying to all students.",
      400,
      "VALIDATION_ERROR"
    );
  }

  const allTargets = await prisma.classStudentFee.findMany({
    where,
    select: {
      id: true,
      year: true,
      month: true,
      classStudentId: true,
      classStudent: { select: { studentId: true } },
      discount: true,
      lateJoinDeduct: true,
      waiverAmount: true,
      freeCard: true,
      ...WAIVER_STATE_SELECT,
      payments: { select: { status: true } },
    },
  });

  if (allTargets.length === 0) {
    throw new AppError("No fee rows to update.", 404, "NOT_FOUND");
  }

  // One student's amount is not edited under an active Free Card (revoke it
  // first). Apply-to-all keeps updating the amount underneath the card, which
  // stays active (finalAmount remains 0).
  if (!applyToAll && allTargets.some((row) => row.freeCard)) {
    throw new AppError(FREE_CARD_ACTIVE_MESSAGE, 409, "FREE_CARD_ACTIVE");
  }

  // A paid fee row is frozen. For a single student that is an error; for an
  // apply-to-all it just skips the ones that are already paid.
  const paidIds = new Set(
    allTargets
      .filter((row) => row.payments.some((p) => p.status === "CONFIRMED"))
      .map((row) => row.id)
  );

  if (!applyToAll && paidIds.size > 0) {
    throw new AppError(
      "This fee is locked because the student has already paid.",
      409,
      "FEE_LOCKED"
    );
  }

  const targets = allTargets.filter((row) => !paidIds.has(row.id));

  // Automatic joining waivers follow the new amount (a percentage changes with
  // it). Calculated before the batch; manual rows keep the existing write.
  const waiverContextFor = createWaiverContextCache(prisma, await getFeeWaiverStart());
  const nextWaivers = new Map<string, WaiverColumns>();

  for (const row of targets) {
    if (row.lateJoinDeductManual) continue;
    const context = await waiverContextFor(classId, { year: row.year, month: row.month });
    if (!context) continue;
    nextWaivers.set(
      row.id,
      joinWaiverColumns(joinWaiverFor(context, row.classStudent.studentId, row.classStudentId, amount), new Date())
    );
  }

  if (targets.length > 0) {
    await prisma.$transaction(
      targets.map((row) => {
        const next = nextWaivers.get(row.id);

        if (next) {
          // Written only while still automatic and unpaid (and with the Free
          // Card state the amount was computed for).
          return prisma.classStudentFee.updateMany({
            where: {
              id: row.id,
              lateJoinDeductManual: false,
              freeCard: row.freeCard,
              payments: { none: { status: "CONFIRMED" } },
            },
            data: {
              amount,
              finalAmount: computeFinalAmount(amount, row.discount, next.lateJoinDeduct, row.waiverAmount, row.freeCard),
              ...next,
            },
          });
        }

        // Conditional on the Free Card state read above: a card issued or
        // revoked meanwhile wins (nothing written).
        return prisma.classStudentFee.updateMany({
          where: { id: row.id, freeCard: row.freeCard },
          data: {
            amount,
            finalAmount: computeFinalAmount(
              amount,
              row.discount,
              row.lateJoinDeduct,
              row.waiverAmount,
              row.freeCard
            ),
          },
        });
      })
    );

    // Realtime: the affected students' payment pages should reflect the new amount.
    emitStudentDataChange({ classId });
  }

  return buildReadOnlySheet(classInfo, year, month);
}

/**
 * Assemble the sheet for a period without running any processing. Used after an
 * explicit teacher edit so the edit is not immediately overwritten by the
 * automatic sync.
 */
async function buildReadOnlySheet(
  classInfo: ClassInfoLite,
  year: number,
  month: number
): Promise<MonthlyFeeSheet> {
  const periodFee = await getClassFeeForPeriod(
    classInfo.id,
    year,
    month,
    classInfo.paymentDueWeek,
    classInfo.monthlyFee
  );

  const now = nowInSriLanka();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  const current = isCurrentPeriod(year, month);
  const future = year > nowYear || (year === nowYear && month > nowMonth);
  const past = !current && !future;

  return buildMonthlyFeeSheet({
    classInfo,
    year,
    month,
    periodFee,
    current,
    past,
    future,
    now,
  });
}

export async function updateStudentFeeAdjustment(params: {
  teacherId: string;
  feeId: string;
  discount?: number;
  lateJoinDeduct?: number;
  waiverAmount?: number;
}) {
  const { teacherId, feeId } = params;

  const fee = await prisma.classStudentFee.findFirst({
    where: {
      id: feeId,
      classStudent: { class: { teacherId } },
    },
    select: {
      id: true,
      amount: true,
      discount: true,
      lateJoinDeduct: true,
      waiverAmount: true,
      freeCard: true,
      payments: { select: { status: true } },
      classStudent: { select: { classId: true } },
    },
  });

  if (!fee) {
    throw new AppError("Fee record not found.", 404, "NOT_FOUND");
  }

  if (fee.payments.some((p) => p.status === "CONFIRMED")) {
    throw new AppError(
      "This fee is locked because the student has already paid.",
      409,
      "FEE_LOCKED"
    );
  }

  // Adjustments are not edited under an active Free Card: the values stay as
  // they were, ready for when the card is revoked.
  if (fee.freeCard) {
    throw new AppError(FREE_CARD_ACTIVE_MESSAGE, 409, "FREE_CARD_ACTIVE");
  }

  const clamp = (value: number | undefined, current: number) => {
    if (value === undefined) return current;
    if (!Number.isFinite(value) || value < 0) {
      throw new AppError(
        "Adjustments must be zero or a positive amount.",
        400,
        "VALIDATION_ERROR"
      );
    }
    return Math.round(value);
  };

  const discount = clamp(params.discount, fee.discount);
  const lateJoinDeduct = clamp(params.lateJoinDeduct, fee.lateJoinDeduct);
  const waiverAmount = clamp(params.waiverAmount, fee.waiverAmount);

  const finalAmount = computeFinalAmount(
    fee.amount,
    discount,
    lateJoinDeduct,
    waiverAmount
  );

  // A teacher-entered late-join deduction becomes manual: automatic joining
  // waivers never overwrite it (only an explicit reset makes it automatic).
  const lateJoinEnteredByTeacher =
    params.lateJoinDeduct !== undefined && lateJoinDeduct !== fee.lateJoinDeduct;

  // Conditional: a Free Card issued since the read above wins (its
  // finalAmount must stay 0), and nothing is written.
  const { count } = await prisma.classStudentFee.updateMany({
    where: { id: fee.id, freeCard: false },
    data: {
      discount,
      lateJoinDeduct,
      waiverAmount,
      finalAmount,
      ...(lateJoinEnteredByTeacher ? { lateJoinDeductManual: true, ...CLEARED_WAIVER_SNAPSHOT } : {}),
    },
  });

  if (count === 0) {
    throw new AppError(FREE_CARD_ACTIVE_MESSAGE, 409, "FREE_CARD_ACTIVE");
  }

  const updated = await prisma.classStudentFee.findUniqueOrThrow({
    where: { id: fee.id },
    select: {
      id: true,
      amount: true,
      discount: true,
      lateJoinDeduct: true,
      lateJoinDeductManual: true,
      waiverAmount: true,
      finalAmount: true,
    },
  });

  // Realtime: the student's payment page should reflect the new adjustment.
  emitStudentDataChange({ classId: fee.classStudent.classId });

  return updated;
}

// ---- Automatic joining waiver: explicit events and reset ---------------------------

/**
 * Recalculates the automatic joining waivers of one class's billing month
 * after an explicit event (student approval / decline, a lecture entering or
 * leaving COMPLETED, or a COMPLETED lecture moving). Bypasses the automatic
 * due-date freeze, but only touches UNPAID rows whose late-join deduction is
 * automatic; each write is conditional on the row being unchanged since it
 * was read, so a concurrent manual adjustment or payment always wins.
 * Never touches months before the launch month. `studentIds` limits the rows.
 */
export async function recalculateJoinWaiversForClassMonth(params: {
  classId: string;
  month: BillingMonth;
  studentIds?: string[];
}): Promise<{ updated: number }> {
  const { classId, month, studentIds } = params;
  const context = await createWaiverContextCache(prisma, await getFeeWaiverStart())(classId, month, studentIds);

  if (!context) {
    return { updated: 0 };
  }

  const rows = await prisma.classStudentFee.findMany({
    where: {
      year: month.year,
      month: month.month,
      lateJoinDeductManual: false,
      payments: { none: { status: "CONFIRMED" } },
      classStudent: { classId, ...(studentIds ? { studentId: { in: studentIds } } : {}) },
    },
    select: {
      id: true,
      updatedAt: true,
      classStudentId: true,
      classStudent: { select: { studentId: true } },
      amount: true,
      discount: true,
      lateJoinDeduct: true,
      waiverAmount: true,
      finalAmount: true,
      freeCard: true,
      ...WAIVER_STATE_SELECT,
    },
  });

  let updated = 0;

  for (const row of rows) {
    const next = joinWaiverColumns(
      joinWaiverFor(context, row.classStudent.studentId, row.classStudentId, row.amount),
      new Date()
    );
    const finalAmount = computeFinalAmount(row.amount, row.discount, next.lateJoinDeduct, row.waiverAmount, row.freeCard);

    if (sameWaiver(row, next) && row.finalAmount === finalAmount) {
      continue;
    }

    if (await writeAutomaticWaiver(prisma, row, { finalAmount, ...next })) {
      updated += 1;
    }
  }

  if (updated > 0) {
    emitStudentDataChange({ classId });
  }

  return { updated };
}

/**
 * After a student's approval or decline: recalculates that student's
 * automatic joining waivers for the CURRENT Sri Lankan billing month, in
 * every class (same protections as recalculateJoinWaiversForClassMonth).
 */
export async function recalculateStudentCurrentMonthJoinWaivers(studentId: string) {
  const { year, month } = sriLankaCalendarParts(new Date());

  const rows = await prisma.classStudentFee.findMany({
    where: { year, month, classStudent: { studentId } },
    select: { classStudent: { select: { classId: true } } },
  });

  const classIds = Array.from(new Set(rows.map((row) => row.classStudent.classId)));
  let updated = 0;

  for (const classId of classIds) {
    updated += (await recalculateJoinWaiversForClassMonth({ classId, month: { year, month }, studentIds: [studentId] })).updated;
  }

  return { updated };
}

/**
 * Explicit "Reset to automatic" for a manually entered late-join deduction.
 * Writes only lateJoinDeduct, finalAmount, the manual flag and the waiver
 * snapshot — never discount, waiverAmount, amount or payments — and only if,
 * at write time, the row is still manual, unpaid and unchanged since read.
 */
export async function resetLateJoinDeductToAutomatic(params: { teacherId: string; feeId: string }) {
  const { teacherId, feeId } = params;

  const fee = await prisma.classStudentFee.findFirst({
    where: { id: feeId, classStudent: { class: { teacherId } } },
    select: {
      id: true,
      updatedAt: true,
      year: true,
      month: true,
      amount: true,
      discount: true,
      waiverAmount: true,
      lateJoinDeductManual: true,
      freeCard: true,
      classStudentId: true,
      classStudent: { select: { classId: true, studentId: true } },
      payments: { select: { status: true } },
    },
  });

  if (!fee) {
    throw new AppError("Fee record not found.", 404, "NOT_FOUND");
  }

  if (fee.payments.some((p) => p.status === "CONFIRMED")) {
    throw new AppError("This fee is locked because the student has already paid.", 409, "FEE_LOCKED");
  }

  if (fee.freeCard) {
    throw new AppError(FREE_CARD_ACTIVE_MESSAGE, 409, "FREE_CARD_ACTIVE");
  }

  if (!fee.lateJoinDeductManual) {
    throw new AppError("This late-join deduction is already automatic.", 409, "NOT_MANUAL");
  }

  const month = { year: fee.year, month: fee.month };
  const context = await createWaiverContextCache(prisma, await getFeeWaiverStart())(
    fee.classStudent.classId,
    month,
    [fee.classStudent.studentId]
  );

  if (!context) {
    throw new AppError(
      "Automatic joining waivers do not apply to this month.",
      409,
      "WAIVER_NOT_ACTIVE_FOR_MONTH"
    );
  }

  const next = joinWaiverColumns(
    joinWaiverFor(context, fee.classStudent.studentId, fee.classStudentId, fee.amount),
    new Date()
  );

  const { count } = await prisma.classStudentFee.updateMany({
    where: {
      id: fee.id,
      updatedAt: fee.updatedAt,
      lateJoinDeductManual: true,
      freeCard: false,
      payments: { none: { status: "CONFIRMED" } },
    },
    data: {
      ...next,
      lateJoinDeductManual: false,
      finalAmount: computeFinalAmount(fee.amount, fee.discount, next.lateJoinDeduct, fee.waiverAmount, fee.freeCard),
    },
  });

  if (count === 0) {
    // Someone changed it meanwhile: the newer data wins, nothing was written.
    const current = await prisma.classStudentFee.findUnique({
      where: { id: fee.id },
      select: { payments: { select: { status: true } } },
    });

    if (current?.payments.some((p) => p.status === "CONFIRMED")) {
      throw new AppError("This fee is locked because the student has already paid.", 409, "FEE_LOCKED");
    }

    throw new AppError(
      "This fee was changed by someone else. Reload and try again.",
      409,
      "FEE_CHANGED"
    );
  }

  emitStudentDataChange({ classId: fee.classStudent.classId });

  return prisma.classStudentFee.findUniqueOrThrow({
    where: { id: fee.id },
    select: {
      id: true,
      amount: true,
      discount: true,
      lateJoinDeduct: true,
      lateJoinDeductManual: true,
      waiverAmount: true,
      finalAmount: true,
    },
  });
}

// ---- Teacher-issued Free Cards ------------------------------------------------------

export const FREE_CARD_MAX_FEES = 500;
const FREE_CARD_LOCK_TIMEOUT_MS = 3_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FreeCardAction = "issue" | "revoke";

export type FreeCardSkipReason =
  | "NOT_IN_SHEET"
  | "CONFIRMED_PAYMENT"
  | "PENDING_PAYMENT"
  | "CLARIFICATION_PAYMENT"
  | "ALREADY_FREE_CARD"
  | "NO_FREE_CARD";

const FREE_CARD_SKIP_MESSAGES: Record<FreeCardSkipReason, string> = {
  NOT_IN_SHEET: "Not a fee of this class and month.",
  CONFIRMED_PAYMENT: "A payment is already confirmed for this fee.",
  PENDING_PAYMENT: "A payment slip is waiting for your confirmation.",
  CLARIFICATION_PAYMENT: "A payment slip is waiting for the student's clarification.",
  ALREADY_FREE_CARD: "Already has a Free Card for this month.",
  NO_FREE_CARD: "Has no Free Card for this month.",
};

export type FreeCardResult = {
  action: FreeCardAction;
  /** Fees whose Free Card was issued / revoked by this request. */
  processed: { feeId: string; studentName: string }[];
  skipped: { feeId: string; studentName: string | null; reason: FreeCardSkipReason; message: string }[];
  sheet: MonthlyFeeSheet;
};

/** Validates the bulk request body (classId, year, month, feeIds, action). */
export function parseFreeCardRequest(body: unknown): {
  classId: string;
  year: number;
  month: number;
  feeIds: string[];
  action: FreeCardAction;
} {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const classId = typeof input.classId === "string" ? input.classId.trim() : "";
  const year = Number(input.year);
  const month = Number(input.month);
  const action = input.action;

  if (!classId) {
    throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
  }
  if (!Number.isInteger(year) || year < 1900 || year > 3000) {
    throw new AppError("A valid year is required.", 400, "VALIDATION_ERROR");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new AppError("Month must be between 1 and 12.", 400, "VALIDATION_ERROR");
  }
  if (action !== "issue" && action !== "revoke") {
    throw new AppError('Action must be "issue" or "revoke".', 400, "VALIDATION_ERROR");
  }
  if (!Array.isArray(input.feeIds) || input.feeIds.length === 0) {
    throw new AppError("Select at least one student.", 400, "VALIDATION_ERROR");
  }
  if (input.feeIds.length > FREE_CARD_MAX_FEES) {
    throw new AppError(`Select at most ${FREE_CARD_MAX_FEES} students at a time.`, 400, "VALIDATION_ERROR");
  }
  if (!input.feeIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
    throw new AppError("Invalid fee id.", 400, "VALIDATION_ERROR");
  }

  return {
    classId,
    year,
    month,
    feeIds: Array.from(new Set(input.feeIds as string[])),
    action,
  };
}

export function isLockContention(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  // P2010: raw query failed (lock_timeout 55P03, deadlock 40P01);
  // P2028: transaction API error (timed out); P2034: write conflict.
  return code === "P2010" || code === "P2028" || code === "P2034";
}

/**
 * Issues or revokes Free Cards on fees of one class and month, all in one
 * transaction. Each fee row is locked (FOR UPDATE, in id order) and re-read
 * under the lock, so a payment submitted concurrently (which locks the same
 * row, see app/api/student/payments/route.ts) is either seen here, and the
 * fee is skipped, or sees the card and is refused. Writes are conditional as
 * well, and only ever touch freeCard, its issue details and finalAmount:
 * discount, lateJoinDeduct, waiverAmount, the automatic waiver columns and
 * every payment stay exactly as they are. Repeating a request changes
 * nothing (already issued / not issued fees are reported as skipped).
 */
export async function setFreeCards(params: {
  teacherId: string;
  classId: string;
  year: number;
  month: number;
  feeIds: string[];
  action: FreeCardAction;
}): Promise<FreeCardResult> {
  const { teacherId, classId, year, month, feeIds, action } = params;
  const classInfo = await assertTeacherOwnsClass(teacherId, classId);
  const issue = action === "issue";

  type Outcome = { processed: FreeCardResult["processed"]; skipped: FreeCardResult["skipped"] };

  let outcome: Outcome;
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${FREE_CARD_LOCK_TIMEOUT_MS}ms'`);

        // Lock in a fixed order so two overlapping bulk requests never deadlock.
        for (const feeId of [...feeIds].sort()) {
          await tx.$queryRaw`SELECT "id" FROM "ClassStudentFee" WHERE "id" = ${feeId} FOR UPDATE`;
        }

        const fees = await tx.classStudentFee.findMany({
          where: {
            id: { in: feeIds },
            year,
            month,
            classStudent: { classId, class: { teacherId }, student: { status: 0 } },
          },
          select: {
            id: true,
            amount: true,
            discount: true,
            lateJoinDeduct: true,
            waiverAmount: true,
            freeCard: true,
            classStudent: { select: { student: { select: { name: true } } } },
            payments: { select: { status: true } },
          },
        });
        const byId = new Map(fees.map((fee) => [fee.id, fee]));

        const result: Outcome = { processed: [], skipped: [] };
        const skip = (feeId: string, studentName: string | null, reason: FreeCardSkipReason) =>
          result.skipped.push({ feeId, studentName, reason, message: FREE_CARD_SKIP_MESSAGES[reason] });

        for (const feeId of feeIds) {
          const fee = byId.get(feeId);
          if (!fee) {
            skip(feeId, null, "NOT_IN_SHEET");
            continue;
          }

          const studentName = fee.classStudent.student.name;
          const statuses = new Set(fee.payments.map((p) => p.status));

          if (statuses.has("CONFIRMED")) {
            skip(feeId, studentName, "CONFIRMED_PAYMENT");
            continue;
          }

          if (issue) {
            if (fee.freeCard) {
              skip(feeId, studentName, "ALREADY_FREE_CARD");
              continue;
            }
            if (statuses.has("PENDING")) {
              skip(feeId, studentName, "PENDING_PAYMENT");
              continue;
            }
            if (statuses.has("NEEDS_CLARIFICATION")) {
              skip(feeId, studentName, "CLARIFICATION_PAYMENT");
              continue;
            }

            // Only while still without a card and without any payment record.
            const { count } = await tx.classStudentFee.updateMany({
              where: { id: fee.id, freeCard: false, payments: { none: {} } },
              data: {
                freeCard: true,
                freeCardIssuedAt: new Date(),
                freeCardIssuedByTeacherId: teacherId,
                finalAmount: 0,
              },
            });
            if (count === 0) {
              skip(feeId, studentName, "PENDING_PAYMENT");
              continue;
            }
          } else {
            if (!fee.freeCard) {
              skip(feeId, studentName, "NO_FREE_CARD");
              continue;
            }

            // The fee as currently calculated from the components maintained
            // underneath the card (amount, automatic waiver, adjustments).
            const { count } = await tx.classStudentFee.updateMany({
              where: { id: fee.id, freeCard: true, payments: { none: { status: "CONFIRMED" } } },
              data: {
                freeCard: false,
                freeCardIssuedAt: null,
                freeCardIssuedByTeacherId: null,
                finalAmount: computeFinalAmount(fee.amount, fee.discount, fee.lateJoinDeduct, fee.waiverAmount),
              },
            });
            if (count === 0) {
              skip(feeId, studentName, "CONFIRMED_PAYMENT");
              continue;
            }
          }

          result.processed.push({ feeId, studentName });
        }

        return result;
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
  } catch (error) {
    if (isLockContention(error)) {
      throw new AppError(
        "These fees are being changed by another request. Please try again.",
        409,
        "FREE_CARD_BUSY"
      );
    }
    throw error;
  }

  if (outcome.processed.length > 0) {
    // Realtime: the students' payment pages should show (or drop) the card.
    emitStudentDataChange({ classId });
  }

  return {
    action,
    processed: outcome.processed,
    skipped: outcome.skipped,
    sheet: await buildReadOnlySheet(classInfo, year, month),
  };
}

/**
 * The teacher's ACTIVE enrolments (ClassStudent ids) whose own fee for the
 * month carries a Free Card (read-only; the teacher dashboard's "Payments
 * Due"). Keyed by enrolment, not by class + student: a card on an earlier,
 * removed enrolment never covers the fee of a re-enrolment in the same month.
 */
export async function getFreeCardEnrolmentIds(params: {
  teacherId: string;
  year: number;
  month: number;
}): Promise<Set<string>> {
  const fees = await prisma.classStudentFee.findMany({
    where: {
      year: params.year,
      month: params.month,
      freeCard: true,
      classStudent: { isActive: true, class: { teacherId: params.teacherId, status: 0 } },
    },
    select: { classStudentId: true },
  });
  return new Set(fees.map((fee) => fee.classStudentId));
}

/**
 * Students settled by Free Cards for one class and month (pure; the legacy
 * GET /api/classes/[id]/payments summary). A student counts only when EVERY
 * enrolment of theirs overlapping the month has a fee row for that month with
 * an active card: a card on an earlier, removed enrolment never covers the
 * payable fee row of a re-enrolment, and an enrolment without a fee row is
 * not covered either.
 */
export function studentsSettledByFreeCards(
  enrolments: readonly { id: string; studentId: string }[],
  freeCardEnrolmentIds: ReadonlySet<string>
): Set<string> {
  const byStudent = new Map<string, string[]>();
  for (const enrolment of enrolments) {
    const list = byStudent.get(enrolment.studentId) ?? [];
    list.push(enrolment.id);
    byStudent.set(enrolment.studentId, list);
  }

  const settled = new Set<string>();
  for (const [studentId, ids] of byStudent) {
    if (ids.length > 0 && ids.every((id) => freeCardEnrolmentIds.has(id))) {
      settled.add(studentId);
    }
  }
  return settled;
}

/**
 * Payment position of each ACTIVE enrolment's fee for one month (teacher
 * dashboard "Payments Due"), keyed by enrolment (ClassStudent id), from the
 * shared calculation. `awaiting`: a slip awaits processing.
 */
export async function getEnrolmentPaymentStates(params: {
  teacherId: string;
  year: number;
  month: number;
}): Promise<Map<string, FeePaymentState & { awaiting: boolean }>> {
  const fees = await prisma.classStudentFee.findMany({
    where: {
      year: params.year,
      month: params.month,
      classStudent: { isActive: true, class: { teacherId: params.teacherId, status: 0 } },
    },
    select: { classStudentId: true, finalAmount: true, freeCard: true, payments: { select: PAYMENT_STATE_SELECT } },
  });
  return new Map(
    fees.map((fee) => [
      fee.classStudentId,
      { ...feePaymentState(fee, fee.payments), awaiting: hasAwaitingSubmission(fee.payments) },
    ])
  );
}

// ---- Partial payments: the shared payment calculation ------------------------------
// Defined in lib/fee-payment-state.ts (pure; also used by client components).
export { feePaymentState, hasAwaitingSubmission, PAYMENT_STATE_SELECT } from "@/lib/fee-payment-state";
export type { FeePaymentRecord, FeePaymentState, FeePaymentStateName } from "@/lib/fee-payment-state";
