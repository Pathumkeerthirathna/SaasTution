import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { emitStudentDataChange } from "@/lib/session-events";
import { nowInSriLanka } from "@/lib/time";

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
  waiverAmount: number;
  finalAmount: number;
  dueDate: string | null;
  createdAt: string | null;
  hasPaid: boolean;
  paymentStatus: "PAID" | "PENDING" | "UNPAID";
  payments: FeePaymentDetail[];
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
  rows: MonthlyFeeRow[];
};

function computeFinalAmount(
  amount: number,
  discount: number,
  lateJoinDeduct: number,
  waiverAmount: number
) {
  return Math.max(0, amount - discount - lateJoinDeduct - waiverAmount);
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

async function assertTeacherOwnsClass(teacherId: string, classId: string) {
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

/** The class's live fee: the open ClassFee period, else the class monthly fee. */
async function getCurrentClassFee(classId: string, fallback: number) {
  const open = await prisma.classFee.findFirst({
    where: { classId, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
    select: { amount: true },
  });

  return open?.amount ?? fallback;
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
    select: { id: true },
  });

  if (activeStudents.length === 0) {
    return;
  }

  const classStudentIds = activeStudents.map((entry) => entry.id);

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
      data: missing.map((classStudentId) => ({
        classStudentId,
        year,
        month,
        amount: currentFee,
        discount: 0,
        lateJoinDeduct: 0,
        waiverAmount: 0,
        finalAmount: computeFinalAmount(currentFee, 0, 0, 0),
        dueDate,
        status: 0,
        createdAt: now,
      })),
      skipDuplicates: true,
    });
  }

  for (const row of existing) {
    const rowDueDatePassed = row.dueDate
      ? now.getTime() > row.dueDate.getTime()
      : false;
    const paid = row.payments.some((p) => p.status === "CONFIRMED");

    if (rowDueDatePassed || classDueDatePassed || paid) {
      continue;
    }

    const nextFinal = computeFinalAmount(
      currentFee,
      row.discount,
      row.lateJoinDeduct,
      row.waiverAmount
    );

    if (row.amount === currentFee && row.finalAmount === nextFinal) {
      continue;
    }

    await prisma.classStudentFee.update({
      where: { id: row.id },
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
    select: { id: true },
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

  await prisma.classStudentFee.createMany({
    data: missing.map((classStudentId) => ({
      classStudentId,
      year,
      month,
      amount: periodFee,
      discount: 0,
      lateJoinDeduct: 0,
      waiverAmount: 0,
      finalAmount: computeFinalAmount(periodFee, 0, 0, 0),
      dueDate,
      status: 0,
      createdAt: now,
    })),
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
      select: { id: true },
    });

    const classStudentIds = enrolments.map((entry) => entry.id);

    const existing = await prisma.classStudentFee.findMany({
      where: { classStudentId: { in: classStudentIds }, year, month },
      select: {
        id: true,
        classStudentId: true,
        discount: true,
        lateJoinDeduct: true,
        waiverAmount: true,
        payments: { select: { status: true } },
      },
    });

    const existingSet = new Set(existing.map((row) => row.classStudentId));
    const missing = classStudentIds.filter((id) => !existingSet.has(id));

    if (missing.length > 0) {
      await prisma.classStudentFee.createMany({
        data: missing.map((classStudentId) => ({
          classStudentId,
          year,
          month,
          amount: periodFee,
          discount: 0,
          lateJoinDeduct: 0,
          waiverAmount: 0,
          finalAmount: computeFinalAmount(periodFee, 0, 0, 0),
          dueDate,
          status: 0,
          createdAt: now,
        })),
        skipDuplicates: true,
      });
    }

    for (const row of existing) {
      const paid = row.payments.some((p) => p.status === "CONFIRMED");

      // A paid row is frozen: only its status is refreshed, the money is left
      // exactly as the student paid against it.
      await prisma.classStudentFee.update({
        where: { id: row.id },
        data: paid
          ? { status: 1 }
          : {
              amount: periodFee,
              finalAmount: computeFinalAmount(
                periodFee,
                row.discount,
                row.lateJoinDeduct,
                row.waiverAmount
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
      waiverAmount: true,
      finalAmount: true,
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
          note: true,
          teacherFeedback: true,
          slipFileName: true,
          submittedAt: true,
          confirmedAt: true,
        },
      },
    },
  });

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
      const confirmed = fee.payments.some((p) => p.status === "CONFIRMED");
      const pending = fee.payments.some(
        (p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION"
      );

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
        waiverAmount: fee.waiverAmount,
        finalAmount: fee.finalAmount,
        dueDate: fee.dueDate ? fee.dueDate.toISOString() : null,
        createdAt: fee.createdAt ? fee.createdAt.toISOString() : null,
        hasPaid: confirmed,
        paymentStatus: confirmed ? "PAID" : pending ? "PENDING" : "UNPAID",
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
        })),
      } satisfies MonthlyFeeRow;
    })
    .sort((a, b) => a.studentName.localeCompare(b.studentName));

  const dueDate = computeDueDate(year, month, classInfo.paymentDueWeek);

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
    rows,
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
      discount: true,
      lateJoinDeduct: true,
      waiverAmount: true,
      payments: { select: { status: true } },
    },
  });

  if (allTargets.length === 0) {
    throw new AppError("No fee rows to update.", 404, "NOT_FOUND");
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

  if (targets.length > 0) {
    await prisma.$transaction(
      targets.map((row) =>
        prisma.classStudentFee.update({
          where: { id: row.id },
          data: {
            amount,
            finalAmount: computeFinalAmount(
              amount,
              row.discount,
              row.lateJoinDeduct,
              row.waiverAmount
            ),
          },
        })
      )
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

  const updated = await prisma.classStudentFee.update({
    where: { id: fee.id },
    data: { discount, lateJoinDeduct, waiverAmount, finalAmount },
    select: {
      id: true,
      amount: true,
      discount: true,
      lateJoinDeduct: true,
      waiverAmount: true,
      finalAmount: true,
    },
  });

  // Realtime: the student's payment page should reflect the new adjustment.
  emitStudentDataChange({ classId: fee.classStudent.classId });

  return updated;
}
