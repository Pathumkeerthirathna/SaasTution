import { Weekday } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { nextSriLankaWeeklyOccurrence, sriLankaDateKey } from "@/lib/time";

const WEEKDAY_INDEX: Record<Weekday, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

const WINDOW_MS = 8 * 60 * 60 * 1000;

export type StudentCountdownKind =
  | "LECTURE"
  | "SCHEDULE"
  | "PAPER"
  | "CLASS_PAPER"
  | "ASSIGNMENT"
  | "QUIZ"
  | "PAYMENT";

export type StudentCountdown = {
  id: string;
  kind: StudentCountdownKind;
  /** e.g. "Lecture starts in", "Assignment due in" */
  message: string;
  title: string;
  subtitle: string;
  /** ISO time we count down to */
  startsAt: string;
  href: string;
};

// Sri Lankan calendar day of a real instant, whatever the server's timezone.
function ymd(d: Date) {
  return sriLankaDateKey(d);
}

/**
 * Everything on the student's plate that starts or falls due within the next
 * 8 hours — lectures, not-yet-added class-schedule occurrences, papers
 * (material-bundle + ClassPaper), assignments, quizzes and fee due dates.
 * Ordered soonest first.
 */
export async function getStudentUpcomingCountdowns(studentId: string): Promise<StudentCountdown[]> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_MS);

  const enrolled = {
    status: 0,
    students: { some: { studentId, isActive: true } },
  } as const;

  const [
    lectures,
    schedules,
    bundlePapers,
    classPapers,
    assignments,
    quizzes,
    fees,
  ] = await Promise.all([
    prisma.lecture.findMany({
      where: {
        status: 0,
        class: enrolled,
        date: { gt: now, lte: windowEnd },
      },
      select: {
        id: true,
        title: true,
        date: true,
        classId: true,
        class: { select: { name: true } },
      },
      orderBy: { date: "asc" },
    }),

    prisma.classSchedule.findMany({
      where: { class: enrolled },
      select: {
        id: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        classId: true,
        class: { select: { name: true } },
      },
    }),

    prisma.materialBundleItem.findMany({
      where: {
        type: "PAPER",
        status: 0,
        paperStartAt: { gt: now, lte: windowEnd },
        bundle: {
          bundleStatus: "SENT",
          status: 0,
          recipients: { some: { studentId, willReceive: true } },
        },
      },
      select: {
        id: true,
        title: true,
        paperStartAt: true,
        bundle: { select: { classId: true, class: { select: { name: true } } } },
      },
    }),

    prisma.classPaper.findMany({
      where: {
        status: 0,
        startTime: { gt: now, lte: windowEnd },
        class: { status: 0 },
        submissions: { some: { studentId } },
      },
      select: {
        id: true,
        name: true,
        startTime: true,
        classId: true,
        class: { select: { name: true } },
      },
    }),

    prisma.assignment.findMany({
      where: {
        status: 0,
        dueDate: { gt: now, lte: windowEnd },
        submissions: { none: { studentId } },
        lecture: { status: 0, class: enrolled },
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        lectureId: true,
        lecture: { select: { classId: true, class: { select: { name: true } } } },
      },
    }),

    prisma.quiz.findMany({
      where: {
        status: 0,
        startDateTime: { gt: now, lte: windowEnd },
        lecture: { status: 0, class: enrolled },
      },
      select: {
        id: true,
        title: true,
        startDateTime: true,
        lectureId: true,
        lecture: { select: { classId: true, class: { select: { name: true } } } },
      },
    }),

    prisma.classStudentFee.findMany({
      where: {
        status: 0,
        dueDate: { gt: now, lte: windowEnd },
        classStudent: { studentId, class: { status: 0 } },
        payments: { none: { status: "CONFIRMED" } },
      },
      select: {
        id: true,
        dueDate: true,
        finalAmount: true,
        classStudent: { select: { classId: true, class: { select: { name: true } } } },
      },
    }),
  ]);

  const items: StudentCountdown[] = [];

  // Class+day keys that already have a lecture — used to skip schedule rows.
  const lectureDayKeys = new Set(lectures.map((l) => `${l.classId}|${ymd(l.date)}`));

  for (const l of lectures) {
    items.push({
      id: `lecture-${l.id}`,
      kind: "LECTURE",
      message: "Lecture starts in",
      title: l.title,
      subtitle: l.class.name,
      startsAt: l.date.toISOString(),
      href: `/student/lectures?classId=${l.classId}&focus=${l.id}`,
    });
  }

  for (const s of schedules) {
    // Schedule times are Sri Lankan wall-clock times.
    const occ = nextSriLankaWeeklyOccurrence(now, WEEKDAY_INDEX[s.dayOfWeek], s.startTime);
    if (!occ) continue;

    if (occ.getTime() > windowEnd.getTime()) continue;
    if (lectureDayKeys.has(`${s.classId}|${ymd(occ)}`)) continue;

    items.push({
      id: `schedule-${s.id}-${ymd(occ)}`,
      kind: "SCHEDULE",
      message: "Class starts in",
      title: `${s.class.name} class`,
      subtitle: "Lecture not added yet",
      startsAt: occ.toISOString(),
      href: `/student/lectures?classId=${s.classId}`,
    });
  }

  for (const p of bundlePapers) {
    if (!p.paperStartAt) continue;
    items.push({
      id: `bundle-paper-${p.id}`,
      kind: "PAPER",
      message: "Paper starts in",
      title: p.title,
      subtitle: p.bundle.class.name,
      startsAt: p.paperStartAt.toISOString(),
      href: `/student/material-bundles?classId=${p.bundle.classId}`,
    });
  }

  for (const p of classPapers) {
    items.push({
      id: `class-paper-${p.id}`,
      kind: "CLASS_PAPER",
      message: "Paper starts in",
      title: p.name,
      subtitle: p.class.name,
      startsAt: p.startTime.toISOString(),
      href: `/student/papers?classId=${p.classId}`,
    });
  }

  for (const a of assignments) {
    items.push({
      id: `assignment-${a.id}`,
      kind: "ASSIGNMENT",
      message: "Assignment due in",
      title: a.title,
      subtitle: a.lecture.class.name,
      startsAt: a.dueDate.toISOString(),
      href: `/student/assignments?classId=${a.lecture.classId}&lectureId=${a.lectureId}&due=1`,
    });
  }

  for (const q of quizzes) {
    items.push({
      id: `quiz-${q.id}`,
      kind: "QUIZ",
      message: "Quiz starts in",
      title: q.title,
      subtitle: q.lecture.class.name,
      startsAt: q.startDateTime.toISOString(),
      href: `/student/quizzes?classId=${q.lecture.classId}&lectureId=${q.lectureId}&todo=1`,
    });
  }

  for (const f of fees) {
    if (!f.dueDate) continue;
    items.push({
      id: `payment-${f.id}`,
      kind: "PAYMENT",
      message: "Payment due in",
      title: `${f.classStudent.class.name} fee`,
      subtitle: `Rs ${f.finalAmount.toLocaleString()}`,
      startsAt: f.dueDate.toISOString(),
      href: `/student/payments?classId=${f.classStudent.classId}`,
    });
  }

  items.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return items;
}
