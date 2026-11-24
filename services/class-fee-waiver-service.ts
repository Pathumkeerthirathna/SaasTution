import type { Prisma } from "@prisma/client";

import {
  type BillingMonth,
  type JoinWaiverResult,
  type WaiverEnrolment,
  type WaiverRule,
  type WaiverStudent,
  computeJoinWaiver,
  isWaiverMonth,
  parseFeeWaiverStart,
  sriLankaMonthWindow,
} from "@/lib/fee-waiver";
import { NORMAL_LECTURE_WHERE } from "@/lib/default-lecture";
import { prisma } from "@/lib/prisma";

/**
 * Database side of the automatic joining fee waiver: the launch gate and the
 * data one class's billing month needs. The calculation itself is the pure
 * lib/fee-waiver.ts; fee rows are written by class-student-fee-service.ts.
 */

type Db = Prisma.TransactionClient;

let reportedMissingSettings = false;

/**
 * The first billing month with automatic waivers (FeeWaiverSettings, written
 * by the feature's migration). Missing or invalid -> null: waivers stay off.
 */
export async function getFeeWaiverStart(db: Db = prisma): Promise<BillingMonth | null> {
  let row: { startYear: number; startMonth: number } | null = null;

  try {
    row = await db.feeWaiverSettings.findUnique({
      where: { id: "default" },
      select: { startYear: true, startMonth: true },
    });
  } catch (error) {
    console.error("[FEE_WAIVER] could not read the start month; automatic waivers are off:", error);
    return null;
  }

  const start = parseFeeWaiverStart(row);

  if (!start && !reportedMissingSettings) {
    reportedMissingSettings = true;
    console.error("[FEE_WAIVER] start month not configured; automatic waivers are off.");
  }

  return start;
}

/** Whether automatic waivers apply to this billing month. */
export async function isFeeWaiverMonth(month: BillingMonth, db: Db = prisma): Promise<boolean> {
  return isWaiverMonth(await getFeeWaiverStart(db), month);
}

export type ClassMonthWaiverContext = {
  month: BillingMonth;
  rules: WaiverRule[];
  completedLectureDates: Date[];
  /** All enrolments (incl. removed) of each student in the class. */
  enrolmentsByStudent: Map<string, WaiverEnrolment[]>;
  students: Map<string, WaiverStudent>;
};

/**
 * Everything a class's billing month needs, loaded once: active rules, the
 * month's active COMPLETED lectures and the students' enrolments in the class.
 * Pass `studentIds` to limit the enrolments loaded.
 */
export async function loadClassMonthWaiverContext(
  db: Db,
  classId: string,
  month: BillingMonth,
  studentIds?: string[]
): Promise<ClassMonthWaiverContext> {
  const { start, end } = sriLankaMonthWindow(month);

  const [rules, lectures, enrolments] = await Promise.all([
    db.classFeeWaiverRule.findMany({
      where: { classId, status: 0 },
      orderBy: { sequence: "asc" },
      select: { id: true, sequence: true, type: true, value: true },
    }),
    db.lecture.findMany({
      where: { classId, status: 0, ...NORMAL_LECTURE_WHERE, classStatus: "COMPLETED", date: { gte: start, lt: end } },
      select: { date: true },
    }),
    db.classStudent.findMany({
      where: { classId, ...(studentIds ? { studentId: { in: studentIds } } : {}) },
      select: {
        id: true,
        classId: true,
        studentId: true,
        assignedAt: true,
        removedAt: true,
        student: {
          select: {
            status: true,
            registrationSource: true,
            publicClassId: true,
            confirmationStatus: true,
            approvedAt: true,
          },
        },
      },
    }),
  ]);

  const enrolmentsByStudent = new Map<string, WaiverEnrolment[]>();
  const students = new Map<string, WaiverStudent>();

  for (const enrolment of enrolments) {
    const list = enrolmentsByStudent.get(enrolment.studentId) ?? [];
    list.push({
      id: enrolment.id,
      classId: enrolment.classId,
      assignedAt: enrolment.assignedAt,
      removedAt: enrolment.removedAt,
    });
    enrolmentsByStudent.set(enrolment.studentId, list);
    students.set(enrolment.studentId, {
      status: enrolment.student.status,
      registrationSource: enrolment.student.registrationSource,
      publicClassId: enrolment.student.publicClassId,
      confirmationStatus: enrolment.student.confirmationStatus,
      approvedAt: enrolment.student.approvedAt,
    });
  }

  return {
    month,
    rules: rules.map((rule) => ({ ...rule, type: rule.type })),
    completedLectureDates: lectures.map((lecture) => lecture.date),
    enrolmentsByStudent,
    students,
  };
}

/** The waiver of one enrolment's fee row, from a loaded context. */
export function joinWaiverFor(
  context: ClassMonthWaiverContext,
  studentId: string,
  classStudentId: string,
  baseAmount: number
): JoinWaiverResult {
  const student = context.students.get(studentId);
  const enrolments = context.enrolmentsByStudent.get(studentId);

  if (!student || !enrolments) {
    return { kind: "NONE" };
  }

  return computeJoinWaiver({
    student,
    enrolments,
    enrolmentId: classStudentId,
    month: context.month,
    completedLectureDates: context.completedLectureDates,
    rules: context.rules,
    baseAmount,
  });
}
