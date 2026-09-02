import { prisma } from "@/lib/prisma";

export type CountsRange = "month" | "quarter" | "year" | "all";

export type StudentDashboardCounts = {
  range: CountsRange;
  classes: number;
  /** Payments — never affected by the range filter. */
  payments: { due: number; dueSoon: number };
  lectures: { notAttended: number; total: number };
  papers: { pending: number; total: number };
  assignments: { due: number; total: number };
  notes: { unviewed: number; total: number };
  quizzes: { notAttempted: number; total: number };
};

const DUE_SOON_DAYS = 7;

function rangeBounds(range: CountsRange): { gte: Date; lte: Date } | null {
  if (range === "all") return null;
  const now = new Date();
  const y = now.getFullYear();

  if (range === "year") {
    return { gte: new Date(y, 0, 1), lte: new Date(y, 11, 31, 23, 59, 59, 999) };
  }
  if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    return { gte: new Date(y, q * 3, 1), lte: new Date(y, q * 3 + 3, 0, 23, 59, 59, 999) };
  }
  return { gte: new Date(y, now.getMonth(), 1), lte: new Date(y, now.getMonth() + 1, 0, 23, 59, 59, 999) };
}

export async function getStudentDashboardCounts(
  studentId: string,
  range: CountsRange
): Promise<StudentDashboardCounts> {
  const b = rangeBounds(range);
  const dateFilter = b ? { gte: b.gte, lte: b.lte } : undefined;

  const enrolled = { status: 0, students: { some: { studentId, isActive: true } } } as const;

  const paperWhere = {
    status: 0,
    class: { status: 0 },
    ...(dateFilter ? { startTime: dateFilter } : {}),
  };
  const lectureNoteWhere = {
    status: 0,
    lecture: {
      status: 0,
      class: { status: 0 },
      ...(dateFilter ? { date: dateFilter } : {}),
    },
  };
  const assignmentWhere = {
    status: 0,
    lecture: { status: 0, class: enrolled },
    ...(dateFilter ? { dueDate: dateFilter } : {}),
  };
  const quizWhere = {
    status: 0,
    lecture: { status: 0, class: enrolled },
    ...(dateFilter ? { startDateTime: dateFilter } : {}),
  };
  const lectureWhere = {
    status: 0,
    class: enrolled,
    ...(dateFilter ? { date: dateFilter } : {}),
  };

  const now = new Date();
  const dueSoonEnd = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  // Fees the student still owes (no CONFIRMED payment), regardless of range.
  const unpaidFeeWhere = {
    status: 0,
    classStudent: { studentId, class: { status: 0 } },
    payments: { none: { status: "CONFIRMED" as const } },
  };

  const [
    classes,
    paymentsDue,
    paymentsDueSoon,
    lecturesTotal,
    lecturesNotAttended,
    papersTotal,
    papersPending,
    assignmentsTotal,
    assignmentsDue,
    notesTotal,
    notesUnviewed,
    quizzesTotal,
    quizzesNotAttempted,
  ] = await Promise.all([
    prisma.classStudent.count({ where: { studentId, isActive: true, class: { status: 0 } } }),

    prisma.classStudentFee.count({
      where: { ...unpaidFeeWhere, dueDate: { lte: now } },
    }),
    prisma.classStudentFee.count({
      where: { ...unpaidFeeWhere, dueDate: { gt: now, lte: dueSoonEnd } },
    }),

    prisma.lecture.count({ where: lectureWhere }),
    prisma.lecture.count({
      where: { ...lectureWhere, sessions: { none: { attendance: { some: { studentId } } } } },
    }),

    prisma.classPaperStudent.count({ where: { studentId, classPaper: paperWhere } }),
    prisma.classPaperStudent.count({
      where: { studentId, submitted: false, classPaper: paperWhere },
    }),

    prisma.assignment.count({ where: assignmentWhere }),
    prisma.assignment.count({
      where: { ...assignmentWhere, submissions: { none: { studentId } } },
    }),

    prisma.noteStudent.count({ where: { studentId, note: lectureNoteWhere } }),
    prisma.noteStudent.count({ where: { studentId, viewed: false, note: lectureNoteWhere } }),

    prisma.quiz.count({ where: quizWhere }),
    prisma.quiz.count({ where: { ...quizWhere, submissions: { none: { studentId } } } }),
  ]);

  return {
    range,
    classes,
    payments: { due: paymentsDue, dueSoon: paymentsDueSoon },
    lectures: { notAttended: lecturesNotAttended, total: lecturesTotal },
    papers: { pending: papersPending, total: papersTotal },
    assignments: { due: assignmentsDue, total: assignmentsTotal },
    notes: { unviewed: notesUnviewed, total: notesTotal },
    quizzes: { notAttempted: quizzesNotAttempted, total: quizzesTotal },
  };
}
