import { prisma } from "@/lib/prisma";

const WEEKDAY_NAMES = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

export type TeacherDashboardMetrics = {
  payments: { due: number; total: number; dueAmountLkr: number };
  lectures: { scheduled: number; total: number };
  events: { pending: number; total: number };
  schedules: { pending: number; total: number };
  materials: { pendingToSend: number; total: number };
};

/** Every `{ year, month }` pair (1-indexed month) the [from, to] range touches. */
function monthsInRange(from: Date, to: Date): { year: number; month: number }[] {
  const pairs: { year: number; month: number }[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth(); // 0-indexed
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth();

  while (y < endY || (y === endY && m <= endM)) {
    pairs.push({ year: y, month: m + 1 });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }

  return pairs;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Counts for the teacher dashboard metric cards, scoped to [from, to].
 * All queries honour the active/soft-delete filters used across the app
 * (`status: 0` on class / lecture / student / fee / bundle / item).
 */
export async function getTeacherDashboardMetrics(
  teacherId: string,
  from: Date,
  to: Date
): Promise<TeacherDashboardMetrics> {
  const now = new Date();

  const [
    feeRows,
    lecturesTotal,
    lecturesScheduled,
    eventsTotal,
    eventsPending,
    schedulesTotal,
    schedules,
    rangeLectures,
    materialsTotal,
    materialsPending,
  ] = await Promise.all([
    // payments — one row per student-month obligation in the range
    prisma.classStudentFee.findMany({
      where: {
        status: 0,
        classStudent: {
          class: { teacherId, status: 0 },
          student: { status: 0 },
        },
        OR: monthsInRange(from, to),
      },
      select: {
        finalAmount: true,
        payments: {
          where: { status: "CONFIRMED" },
          select: { id: true },
          take: 1,
        },
      },
    }),

    prisma.lecture.count({
      where: {
        status: 0,
        class: { teacherId, status: 0 },
        date: { gte: from, lte: to },
      },
    }),
    prisma.lecture.count({
      where: {
        status: 0,
        classStatus: "SCHEDULED",
        class: { teacherId, status: 0 },
        date: { gte: from, lte: to },
      },
    }),

    prisma.teacherCalendarEvent.count({
      where: {
        teacherId,
        status: 0,
        startDateTime: { gte: from, lte: to },
      },
    }),
    prisma.teacherCalendarEvent.count({
      where: {
        teacherId,
        status: 0,
        startDateTime: { gte: from, lte: to },
        endDateTime: { gt: now },
      },
    }),

    prisma.classSchedule.count({
      where: { class: { teacherId, status: 0 } },
    }),
    prisma.classSchedule.findMany({
      where: { class: { teacherId, status: 0 } },
      select: { classId: true, dayOfWeek: true },
    }),
    prisma.lecture.findMany({
      where: {
        status: 0,
        class: { teacherId, status: 0 },
        date: { gte: from, lte: to },
      },
      select: { classId: true, date: true },
    }),

    prisma.materialBundleItem.count({
      where: {
        status: 0,
        type: { in: ["TUTE", "PAPER"] },
        createdAt: { gte: from, lte: to },
        bundle: { status: 0, class: { teacherId, status: 0 } },
      },
    }),
    prisma.materialBundleItem.count({
      where: {
        status: 0,
        type: { in: ["TUTE", "PAPER"] },
        createdAt: { gte: from, lte: to },
        bundle: {
          status: 0,
          bundleStatus: "DRAFT",
          class: { teacherId, status: 0 },
        },
      },
    }),
  ]);

  // ── payments ────────────────────────────────────────────────────────────
  const paymentsTotal = feeRows.length;
  let paymentsDue = 0;
  let dueAmountLkr = 0;
  for (const fee of feeRows) {
    if (fee.payments.length === 0) {
      paymentsDue += 1;
      dueAmountLkr += fee.finalAmount;
    }
  }

  // ── schedules pending: occurrences in range with no lecture that day ────
  const lectureDayKeys = new Set(
    rangeLectures.map((l) => `${l.classId}|${dayKey(l.date)}`)
  );

  let schedulesPending = 0;
  for (const schedule of schedules) {
    const targetDow = WEEKDAY_NAMES.indexOf(
      schedule.dayOfWeek as (typeof WEEKDAY_NAMES)[number]
    );
    if (targetDow < 0) continue;

    const cursor = new Date(from);
    cursor.setUTCHours(0, 0, 0, 0);
    // advance to the first matching weekday on/after `from`
    cursor.setUTCDate(
      cursor.getUTCDate() + ((targetDow - cursor.getUTCDay() + 7) % 7)
    );

    while (cursor.getTime() <= to.getTime()) {
      if (!lectureDayKeys.has(`${schedule.classId}|${dayKey(cursor)}`)) {
        schedulesPending += 1;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
  }

  return {
    payments: {
      due: paymentsDue,
      total: paymentsTotal,
      dueAmountLkr,
    },
    lectures: { scheduled: lecturesScheduled, total: lecturesTotal },
    events: { pending: eventsPending, total: eventsTotal },
    schedules: { pending: schedulesPending, total: schedulesTotal },
    materials: { pendingToSend: materialsPending, total: materialsTotal },
  };
}
