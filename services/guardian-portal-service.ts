import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import {
  getStudentAttendanceAnalytics,
  getStudentPaymentSummary,
  getStudentQuizAnalytics,
} from "@/services/student-service";

/**
 * Guards every guardian-portal read: the guardian must be linked to the
 * student through a GuardianStudent row.
 */
export async function assertGuardianLinkedToStudent(
  guardianId: string,
  studentId: string
) {
  const link = await prisma.guardianStudent.findUnique({
    where: { guardianId_studentId: { guardianId, studentId } },
    select: { id: true, relation: true },
  });

  if (!link) {
    throw new AppError(
      "You do not have access to this student.",
      403,
      "STUDENT_NOT_LINKED"
    );
  }

  return link;
}

/** The compact student list shown in the guardian portal's left column. */
export async function getGuardianStudents(guardianId: string) {
  const links = await prisma.guardianStudent.findMany({
    where: { guardianId },
    orderBy: { createdAt: "asc" },
    select: {
      relation: true,
      student: {
        select: {
          id: true,
          name: true,
          registrationNumber: true,
          grade: { select: { GradeDesc: true } },
          _count: {
            select: { classes: { where: { isActive: true } } },
          },
        },
      },
    },
  });

  return links.map((link) => ({
    id: link.student.id,
    name: link.student.name,
    registrationNumber: link.student.registrationNumber,
    grade: link.student.grade?.GradeDesc ?? null,
    relation: link.relation,
    classCount: link.student._count.classes,
  }));
}

/**
 * The guardian portal Overview: month-by-month attendance and quiz-growth
 * trends plus the current payment standing.
 */
export async function getGuardianStudentOverview(studentId: string) {
  const [attendance, quiz, payments] = await Promise.all([
    getStudentAttendanceAnalytics(studentId, { months: 6 }),
    getStudentQuizAnalytics(studentId, { period: "3months" }),
    getStudentPaymentSummary(studentId),
  ]);

  const now = new Date();
  const overdueFees = payments.classes
    .flatMap((cls) => cls.fees)
    .filter(
      (fee) =>
        !fee.paid &&
        fee.dueDate != null &&
        new Date(fee.dueDate).getTime() < now.getTime()
    ).length;

  return {
    attendance: {
      rate: attendance.attendanceRate,
      trendDelta: attendance.trendDelta,
      months: attendance.monthly.map((m) => ({
        label: m.label,
        percent: m.percent,
      })),
    },
    quiz: {
      averageScore: quiz.averageScore,
      trendDelta: quiz.trendDelta,
      months: quiz.monthly.map((m) => ({
        label: m.label,
        percent: m.percent,
      })),
    },
    payments: {
      paidCount: payments.summary.paidCount,
      unpaidCount: payments.summary.unpaidCount,
      paidAmount: payments.summary.paidAmount,
      unpaidAmount: payments.summary.unpaidAmount,
      paidPercent: payments.summary.paidPercent,
      overdueFees,
    },
  };
}

type MonthFilter = { classId?: string; year?: number; month?: number };
type RangeFilter = { classId?: string; from?: string; to?: string };

/** Papers issued to the student's classes, with the student's marks. */
export async function getGuardianStudentPapers(
  studentId: string,
  filters: MonthFilter = {}
) {
  const startWindow =
    filters.year && filters.month
      ? {
          gte: new Date(Date.UTC(filters.year, filters.month - 1, 1)),
          lt: new Date(Date.UTC(filters.year, filters.month, 1)),
        }
      : undefined;

  const rows = await prisma.classPaperStudent.findMany({
    where: {
      studentId,
      classPaper: {
        status: 0,
        ...(filters.classId ? { classId: filters.classId } : {}),
        ...(startWindow ? { startTime: startWindow } : {}),
      },
    },
    orderBy: { classPaper: { startTime: "desc" } },
    select: {
      id: true,
      submitted: true,
      submittedAt: true,
      marks: true,
      markedAt: true,
      classPaper: {
        select: {
          id: true,
          name: true,
          maxMarks: true,
          startTime: true,
          endTime: true,
          class: { select: { id: true, name: true } },
        },
      },
    },
  });

  const papers = rows.map((row) => ({
    id: row.classPaper.id,
    submissionId: row.id,
    name: row.classPaper.name,
    className: row.classPaper.class.name,
    classId: row.classPaper.class.id,
    startTime: row.classPaper.startTime.toISOString(),
    endTime: row.classPaper.endTime.toISOString(),
    maxMarks: row.classPaper.maxMarks ? Number(row.classPaper.maxMarks) : null,
    submitted: row.submitted,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    marks: row.marks != null ? Number(row.marks) : null,
    markedAt: row.markedAt ? row.markedAt.toISOString() : null,
  }));

  const marked = papers.filter((p) => p.marks != null);
  const averagePct =
    marked.length > 0
      ? Math.round(
          (marked.reduce(
            (sum, p) => sum + (p.maxMarks ? (p.marks! / p.maxMarks) * 100 : 0),
            0
          ) /
            marked.length) *
            10
        ) / 10
      : null;

  return {
    papers,
    summary: {
      total: papers.length,
      submitted: papers.filter((p) => p.submitted).length,
      marked: marked.length,
      averagePct,
    },
  };
}

/** Assignments in the student's active classes, with the student's marks. */
export async function getGuardianStudentAssignments(
  studentId: string,
  filters: RangeFilter = {}
) {
  const fromDate = filters.from ? new Date(`${filters.from}T00:00:00.000`) : undefined;
  const toDate = filters.to ? new Date(`${filters.to}T23:59:59.999`) : undefined;

  const assignments = await prisma.assignment.findMany({
    where: {
      status: 0,
      lecture: {
        status: 0,
        class: {
          status: 0,
          students: { some: { studentId, isActive: true } },
          ...(filters.classId ? { id: filters.classId } : {}),
        },
      },
      ...(fromDate || toDate
        ? {
            dueDate: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    },
    orderBy: { dueDate: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      dueDate: true,
      lecture: {
        select: {
          id: true,
          title: true,
          date: true,
          class: { select: { id: true, name: true } },
        },
      },
      submissions: {
        where: { studentId },
        select: {
          id: true,
          submittedAt: true,
          marks: true,
          reviewedAt: true,
        },
      },
    },
  });

  const records = assignments.map((a) => {
    const submission = a.submissions[0] ?? null;
    const status = !submission
      ? "not_submitted"
      : submission.marks != null
      ? "marked"
      : "submitted";

    return {
      id: a.id,
      title: a.title,
      description: a.description,
      dueDate: a.dueDate.toISOString(),
      classId: a.lecture.class.id,
      className: a.lecture.class.name,
      lectureTitle: a.lecture.title,
      lectureDate: a.lecture.date.toISOString(),
      status,
      submittedAt: submission?.submittedAt.toISOString() ?? null,
      marks: submission?.marks ?? null,
      reviewedAt: submission?.reviewedAt?.toISOString() ?? null,
    };
  });

  return {
    records,
    summary: {
      total: records.length,
      submitted: records.filter((r) => r.status !== "not_submitted").length,
      marked: records.filter((r) => r.status === "marked").length,
      missing: records.filter((r) => r.status === "not_submitted").length,
    },
  };
}
