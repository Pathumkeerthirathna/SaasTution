import { prisma } from "@/lib/prisma";
import { startOfTodaySriLankaUtc } from "@/lib/time";

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
  lectures: { scheduled: number; total: number };
  events: { pending: number; total: number };
  materials: { pendingToSend: number; total: number };
  papers: { notReviewed: number; total: number };
  bundlePapers: { notReviewed: number; total: number };
  assignments: { notReviewed: number; total: number };
};

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
  // "Pending" events are the ones still ahead — today (even if already
  // started) through the end of the selected range.
  const todayStartUtc = startOfTodaySriLankaUtc();
  const pendingEventsFrom = todayStartUtc > from ? todayStartUtc : from;

  const [
    eventsTotal,
    eventsPending,
    schedules,
    rangeLectures,
    materialsTotal,
    materialsPending,
    papersInRange,
    bundlePapersInRange,
    assignmentsInRange,
  ] = await Promise.all([
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
        startDateTime: { gte: pendingEventsFrom, lte: to },
      },
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

    // papers added in range, with just enough of each paper's submissions to
    // tell whether it still has an unmarked (submitted) answer.
    prisma.classPaper.findMany({
      where: {
        status: 0,
        class: { teacherId, status: 0 },
        createdAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        submissions: {
          where: { submitted: true, marks: null },
          select: { id: true },
          take: 1,
        },
      },
    }),

    // bundle ("physical") papers sent in range, with just enough of each
    // paper's submissions to tell whether it still has an unreviewed answer.
    prisma.materialBundleItem.findMany({
      where: {
        status: 0,
        type: "PAPER",
        createdAt: { gte: from, lte: to },
        bundle: { status: 0, class: { teacherId, status: 0 } },
      },
      select: {
        id: true,
        submissions: {
          where: { reviewedAt: null },
          select: { id: true },
          take: 1,
        },
      },
    }),

    // assignments due in range, with just enough of each assignment's
    // submissions to tell whether it still has an unreviewed answer.
    prisma.assignment.findMany({
      where: {
        status: 0,
        lecture: { status: 0, class: { teacherId, status: 0 } },
        dueDate: { gte: from, lte: to },
      },
      select: {
        id: true,
        submissions: {
          where: { reviewedAt: null },
          select: { id: true },
          take: 1,
        },
      },
    }),
  ]);

  // ── schedule occurrences in range: with vs. without a lecture added ─────
  const lectureDayKeys = new Set(
    rangeLectures.map((l) => `${l.classId}|${dayKey(l.date)}`)
  );

  let schedulesPending = 0;
  let scheduleOccurrencesInRange = 0;
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
      scheduleOccurrencesInRange += 1;
      if (!lectureDayKeys.has(`${schedule.classId}|${dayKey(cursor)}`)) {
        schedulesPending += 1;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
  }

  // "Lectures scheduled" = of all this range's class-schedule occurrences,
  // how many already have a lecture added by the teacher.
  const lecturesAdded = scheduleOccurrencesInRange - schedulesPending;

  // A paper counts as "not reviewed" if any student's submitted answer on it
  // still has no marks.
  const papersTotal = papersInRange.length;
  const papersNotReviewed = papersInRange.filter((p) => p.submissions.length > 0).length;

  // Same idea for bundle ("physical") papers, using reviewedAt instead of marks.
  const bundlePapersTotal = bundlePapersInRange.length;
  const bundlePapersNotReviewed = bundlePapersInRange.filter((p) => p.submissions.length > 0).length;

  // An assignment counts as "not reviewed" if any student's submission on it
  // still has no review (reviewedAt null).
  const assignmentsTotal = assignmentsInRange.length;
  const assignmentsNotReviewed = assignmentsInRange.filter((a) => a.submissions.length > 0).length;

  return {
    lectures: { scheduled: lecturesAdded, total: scheduleOccurrencesInRange },
    events: { pending: eventsPending, total: eventsTotal },
    materials: { pendingToSend: materialsPending, total: materialsTotal },
    papers: { notReviewed: papersNotReviewed, total: papersTotal },
    bundlePapers: { notReviewed: bundlePapersNotReviewed, total: bundlePapersTotal },
    assignments: { notReviewed: assignmentsNotReviewed, total: assignmentsTotal },
  };
}
