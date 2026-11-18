import { AppError } from "@/lib/error-handler";
import { feePaymentState, PAYMENT_STATE_SELECT, type FeePaymentState } from "@/lib/fee-payment-state";
import { prisma } from "@/lib/prisma";
import { nowInSriLanka } from "@/lib/time";

/*
 * Payment-due LMS access control (per class, teacher-controlled; the settings
 * live on Class: restrictUnpaidStudentAccess, paymentGracePeriodDays).
 *
 * A student cannot open a class's learning content while ALL of these hold
 * for a fee of their ACTIVE enrolment in that class (any month):
 *  - the class has the restriction enabled;
 *  - an amount is still outstanding by the shared payment calculation
 *    (lib/fee-payment-state.ts: finalAmount minus confirmed, not reversed
 *    payments; a partly paid fee still owes the rest; a Free Card, a full
 *    payment or adjustments down to 0 never restrict);
 *  - no submission awaits processing (PENDING / NEEDS_CLARIFICATION protect
 *    the student while the teacher handles it);
 *  - its due date plus the grace period has passed.
 * No fee record: no restriction. Evaluated on every request (no stored flag,
 * no job): paying, a Free Card, an adjustment to 0 or switching the setting
 * off restores access immediately. Other classes are never affected.
 *
 * Dates: ClassStudentFee.dueDate holds Sri Lankan wall-clock digits (the end
 * of the due day, see computeDueDate in class-student-fee-service.ts) and is
 * compared with nowInSriLanka(), the existing fee due-date convention. Due
 * 10 Nov + 5 days: open through 15 Nov 23:59:59, restricted from 16 Nov.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const MIN_PAYMENT_GRACE_DAYS = 0;
export const MAX_PAYMENT_GRACE_DAYS = 30;
export const DEFAULT_PAYMENT_GRACE_DAYS = 5;

export type ClassAccessRestriction = {
  classId: string;
  className: string;
  feeId: string;
  year: number;
  month: number;
  outstandingAmount: number;
  /** Sri Lankan wall-clock digits (as stored), ISO. */
  dueDate: string;
  /** Last moment of the grace period (Sri Lankan wall-clock digits), ISO. */
  graceEndsAt: string;
  gracePeriodDays: number;
};

type FeeForAccess = {
  /** The amount still payable (the outstanding balance). */
  finalAmount: number;
  freeCard: boolean;
  dueDate: Date | null;
  /** Submissions awaiting processing (PENDING / NEEDS_CLARIFICATION). */
  paymentCount: number;
};

/** End of the grace period (inclusive), in the dueDate's digits convention. */
export function graceEndsAt(dueDate: Date, gracePeriodDays: number): Date {
  return new Date(dueDate.getTime() + Math.max(0, gracePeriodDays) * DAY_MS);
}

/** Pure rule: whether one fee restricts the class (restriction enabled). */
export function feeRestrictsAccess(fee: FeeForAccess, gracePeriodDays: number, nowSriLanka: Date): boolean {
  if (fee.freeCard || fee.finalAmount <= 0 || fee.paymentCount > 0 || !fee.dueDate) return false;
  return nowSriLanka.getTime() > graceEndsAt(fee.dueDate, gracePeriodDays).getTime();
}

/**
 * The student's current restrictions (one per overdue fee), optionally for
 * the given classes only. Empty when nothing is restricted.
 */
export async function getClassAccessRestrictions(
  studentId: string,
  classIds?: readonly string[]
): Promise<ClassAccessRestriction[]> {
  if (!studentId) return [];
  if (classIds && classIds.length === 0) return [];

  const fees = await prisma.classStudentFee.findMany({
    where: {
      freeCard: false,
      finalAmount: { gt: 0 },
      dueDate: { not: null },
      classStudent: {
        studentId,
        isActive: true,
        class: {
          status: 0,
          restrictUnpaidStudentAccess: true,
          ...(classIds ? { id: { in: [...classIds] } } : {}),
        },
      },
    },
    orderBy: [{ year: "asc" }, { month: "asc" }],
    select: {
      id: true,
      year: true,
      month: true,
      finalAmount: true,
      freeCard: true,
      dueDate: true,
      classStudent: {
        select: { class: { select: { id: true, name: true, paymentGracePeriodDays: true } } },
      },
      payments: { select: PAYMENT_STATE_SELECT },
    },
  });

  const now = nowInSriLanka();
  return fees
    .map((fee) => ({
      fee,
      // The shared payment calculation: what is still payable after confirmed
      // (not reversed) payments; a slip awaiting processing protects access.
      outstanding: feePaymentState(fee, fee.payments).outstanding,
      awaiting: fee.payments.filter((p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION").length,
    }))
    .filter(({ fee, outstanding, awaiting }) =>
      feeRestrictsAccess(
        { finalAmount: outstanding, freeCard: fee.freeCard, dueDate: fee.dueDate, paymentCount: awaiting },
        fee.classStudent.class.paymentGracePeriodDays,
        now
      )
    )
    .map(({ fee, outstanding }) => {
      const cls = fee.classStudent.class;
      return {
        classId: cls.id,
        className: cls.name,
        feeId: fee.id,
        year: fee.year,
        month: fee.month,
        outstandingAmount: outstanding,
        dueDate: fee.dueDate!.toISOString(),
        graceEndsAt: graceEndsAt(fee.dueDate!, cls.paymentGracePeriodDays).toISOString(),
        gracePeriodDays: cls.paymentGracePeriodDays,
      };
    });
}

export const CLASS_ACCESS_RESTRICTED = "CLASS_ACCESS_RESTRICTED";

/**
 * Throws 403 CLASS_ACCESS_RESTRICTED (with the restrictions as details) when
 * the student may not open this class's learning content. A no-op otherwise.
 */
export async function assertClassAccessForStudent(studentId: string, classId: string): Promise<void> {
  const restrictions = await getClassAccessRestrictions(studentId, [classId]);
  if (restrictions.length === 0) return;
  throw new AppError(
    `Access to ${restrictions[0].className} is paused because a class fee is overdue. Please pay and submit your payment slip from the Payments page.`,
    403,
    CLASS_ACCESS_RESTRICTED,
    { restrictions }
  );
}

/** The given classes minus those currently restricted for the student. */
export async function filterAccessibleClassIds(studentId: string, classIds: readonly string[]): Promise<Set<string>> {
  const restricted = new Set((await getClassAccessRestrictions(studentId, classIds)).map((r) => r.classId));
  return new Set(classIds.filter((id) => !restricted.has(id)));
}

// ---- Teacher settings -------------------------------------------------------------

export type ClassAccessSettings = { restrictUnpaidStudentAccess: boolean; paymentGracePeriodDays: number };

export function parseClassAccessSettings(body: unknown): ClassAccessSettings {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const days = input.paymentGracePeriodDays;
  if (typeof input.restrictUnpaidStudentAccess !== "boolean") {
    throw new AppError("restrictUnpaidStudentAccess must be true or false.", 400, "VALIDATION_ERROR");
  }
  if (typeof days !== "number" || !Number.isInteger(days) || days < MIN_PAYMENT_GRACE_DAYS || days > MAX_PAYMENT_GRACE_DAYS) {
    throw new AppError(
      `The grace period must be a whole number of days from ${MIN_PAYMENT_GRACE_DAYS} to ${MAX_PAYMENT_GRACE_DAYS}.`,
      400,
      "VALIDATION_ERROR"
    );
  }
  return { restrictUnpaidStudentAccess: input.restrictUnpaidStudentAccess, paymentGracePeriodDays: days };
}

async function ownedClass(teacherId: string, classId: string) {
  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId, status: 0 },
    select: { id: true, restrictUnpaidStudentAccess: true, paymentGracePeriodDays: true },
  });
  if (!cls) throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  return cls;
}

export async function getClassAccessSettings(teacherId: string, classId: string): Promise<ClassAccessSettings> {
  const cls = await ownedClass(teacherId, classId);
  return { restrictUnpaidStudentAccess: cls.restrictUnpaidStudentAccess, paymentGracePeriodDays: cls.paymentGracePeriodDays };
}

export async function updateClassAccessSettings(
  teacherId: string,
  classId: string,
  settings: ClassAccessSettings
): Promise<ClassAccessSettings> {
  await ownedClass(teacherId, classId);
  const updated = await prisma.class.update({
    where: { id: classId },
    data: settings,
    select: { restrictUnpaidStudentAccess: true, paymentGracePeriodDays: true },
  });
  return updated;
}

// ---- Outstanding students of a class (QR attendance payment warning) ------------------

/**
 * Pure: whether a fee still owes money that no awaiting slip covers.
 *
 * `outstanding` is the shared calculation (finalAmount minus CONFIRMED, not
 * reversed payments; 0 with a Free Card), so PENDING / NEEDS_CLARIFICATION
 * slips are never received money. A slip awaiting processing is, however,
 * not itself a reason to warn: its amount is set by the server to the whole
 * outstanding balance when it is submitted (app/api/student/payments), so it
 * normally covers the fee. Only what remains beyond the awaiting slips (for
 * example after a reversal or a fee increase since the slip) still counts.
 */
export function feeOwesBeyondAwaitingSlips(state: Pick<FeePaymentState, "outstanding" | "pendingTotal" | "clarificationTotal">): boolean {
  return state.outstanding - state.pendingTotal - state.clarificationTotal > 0;
}

/**
 * The unique ids of the students of the teacher's class who still owe money
 * on any existing fee month of an ACTIVE enrolment (non-deleted students
 * only), by the shared payment calculation. Any positive balance counts,
 * whatever the due date. Read-only: never creates or changes fee rows.
 * 404 CLASS_NOT_FOUND when the class is not the teacher's (or is deleted).
 */
export async function getOutstandingStudentIdsForClass(teacherId: string, classId: string): Promise<string[]> {
  await ownedClass(teacherId, classId);

  // freeCard / finalAmount > 0: the same safe pre-filter as getClassAccessRestrictions
  // (feePaymentState gives 0 outstanding for every fee it leaves out).
  const fees = await prisma.classStudentFee.findMany({
    where: {
      freeCard: false,
      finalAmount: { gt: 0 },
      classStudent: { classId, isActive: true, student: { status: 0 } },
    },
    select: {
      finalAmount: true,
      freeCard: true,
      payments: { select: PAYMENT_STATE_SELECT },
      classStudent: { select: { studentId: true } },
    },
  });

  const ids = new Set<string>();
  for (const fee of fees) {
    if (ids.has(fee.classStudent.studentId)) continue;
    if (feeOwesBeyondAwaitingSlips(feePaymentState(fee, fee.payments))) ids.add(fee.classStudent.studentId);
  }
  return [...ids].sort();
}

// ---- Enforcement entry points for the student content / action routes ----------------

export type ClassContentRef =
  | { classId: string }
  | { lectureId: string }
  | { recordingId: string }
  | { quizId: string }
  | { paperId: string }
  | { assignmentId: string }
  | { bundleId: string }
  | { sessionId: string };

/** The class a piece of content belongs to (null when it does not exist). */
async function classIdOf(ref: ClassContentRef): Promise<string | null> {
  if ("classId" in ref) return ref.classId;
  if ("lectureId" in ref) {
    return (await prisma.lecture.findUnique({ where: { id: ref.lectureId }, select: { classId: true } }))?.classId ?? null;
  }
  if ("recordingId" in ref) {
    return (await prisma.recordedLecture.findUnique({ where: { id: ref.recordingId }, select: { classId: true } }))?.classId ?? null;
  }
  if ("quizId" in ref) {
    return (await prisma.quiz.findUnique({ where: { id: ref.quizId }, select: { lecture: { select: { classId: true } } } }))?.lecture.classId ?? null;
  }
  if ("paperId" in ref) {
    return (await prisma.classPaper.findUnique({ where: { id: ref.paperId }, select: { classId: true } }))?.classId ?? null;
  }
  if ("assignmentId" in ref) {
    return (
      await prisma.assignment.findUnique({ where: { id: ref.assignmentId }, select: { lecture: { select: { classId: true } } } })
    )?.lecture.classId ?? null;
  }
  if ("sessionId" in ref) {
    return (await prisma.classSession.findUnique({ where: { id: ref.sessionId }, select: { classId: true } }))?.classId ?? null;
  }
  return (await prisma.materialBundle.findUnique({ where: { id: ref.bundleId }, select: { classId: true } }))?.classId ?? null;
}

/**
 * The single check every protected student content / action route makes,
 * right after authenticating the student. Unknown content is left to the
 * route's own 404; a student not (actively) enrolled is never restricted, so
 * nothing is revealed about other classes.
 */
export async function assertContentAccessForStudent(studentId: string, ref: ClassContentRef): Promise<void> {
  if (!studentId) return;
  // One query for the usual case (nothing restricted); the content's class is
  // resolved only when the student has a restriction somewhere.
  const restrictions = await getClassAccessRestrictions(studentId);
  if (restrictions.length === 0) return;
  const classId = await classIdOf(ref);
  const forClass = classId ? restrictions.filter((r) => r.classId === classId) : [];
  if (forClass.length === 0) return;
  throw new AppError(
    `Access to ${forClass[0].className} is paused because a class fee is overdue. Please pay and submit your payment slip from the Payments page.`,
    403,
    CLASS_ACCESS_RESTRICTED,
    { restrictions: forClass }
  );
}
