import { prisma } from "@/lib/prisma";

export type CourseworkSubmission = {
  id: string;
  studentName: string;
  registrationNumber: string | null;
  submittedAt: string;
};

export type CourseworkAssignment = {
  id: string;
  title: string;
  dueDate: string;
  className: string;
  lectureTitle: string;
  submissions: (CourseworkSubmission & { hasFile: boolean })[];
};

export type CourseworkQuiz = {
  id: string;
  title: string;
  className: string;
  totalQuestions: number;
  submissions: (CourseworkSubmission & {
    score: number;
    totalQuestions: number;
    attemptCount: number;
  })[];
};

export type TeacherCoursework = {
  assignments: CourseworkAssignment[];
  quizzes: CourseworkQuiz[];
};

/**
 * Assignments and quizzes due in [from, to] for the teacher, each with the
 * students who have submitted (assignments) or attempted (quizzes) — used by
 * the dashboard coursework cards. Honours the usual active/soft-delete filters.
 */
export async function getTeacherCourseworkForRange(
  teacherId: string,
  from: Date,
  to: Date
): Promise<TeacherCoursework> {
  const classScope = {
    status: 0,
    class: { teacherId, status: 0 },
  } as const;

  const [assignments, quizzes] = await Promise.all([
    prisma.assignment.findMany({
      where: {
        status: 0,
        lecture: classScope,
        dueDate: { gte: from, lte: to },
      },
      orderBy: { dueDate: "desc" },
      select: {
        id: true,
        title: true,
        dueDate: true,
        lecture: {
          select: { title: true, class: { select: { name: true } } },
        },
        submissions: {
          where: { student: { status: 0 } },
          orderBy: { submittedAt: "desc" },
          select: {
            id: true,
            submittedAt: true,
            fileUrl: true,
            student: { select: { name: true, registrationNumber: true } },
          },
        },
      },
    }),

    prisma.quiz.findMany({
      where: {
        status: 0,
        lecture: classScope,
        // Quiz window overlaps the selected range.
        startDateTime: { lte: to },
        endDateTime: { gte: from },
      },
      orderBy: [{ endDateTime: "desc" }],
      select: {
        id: true,
        title: true,
        lecture: { select: { class: { select: { name: true } } } },
        _count: { select: { questions: true } },
        submissions: {
          where: { student: { status: 0 } },
          orderBy: { score: "desc" },
          select: {
            id: true,
            score: true,
            totalQuestions: true,
            attemptCount: true,
            submittedAt: true,
            student: { select: { name: true, registrationNumber: true } },
          },
        },
      },
    }),
  ]);

  return {
    assignments: assignments.map((a) => ({
      id: a.id,
      title: a.title,
      dueDate: a.dueDate.toISOString(),
      className: a.lecture.class.name,
      lectureTitle: a.lecture.title,
      submissions: a.submissions.map((s) => ({
        id: s.id,
        studentName: s.student.name,
        registrationNumber: s.student.registrationNumber,
        submittedAt: s.submittedAt.toISOString(),
        hasFile: Boolean(s.fileUrl),
      })),
    })),
    quizzes: quizzes.map((q) => ({
      id: q.id,
      title: q.title,
      className: q.lecture.class.name,
      totalQuestions: q._count.questions,
      submissions: q.submissions.map((s) => ({
        id: s.id,
        studentName: s.student.name,
        registrationNumber: s.student.registrationNumber,
        submittedAt: s.submittedAt.toISOString(),
        score: s.score,
        totalQuestions: s.totalQuestions,
        attemptCount: s.attemptCount,
      })),
    })),
  };
}
