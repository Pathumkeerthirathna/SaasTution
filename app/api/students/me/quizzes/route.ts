import { NextRequest } from "next/server";

import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await requireStudentSession();

    const { searchParams } = req.nextUrl;
    const classId = searchParams.get("classId") ?? undefined;
    const from = searchParams.get("from") ?? undefined;
    const to = searchParams.get("to") ?? undefined;
    const { page, pageSize, skip, take } = parsePaginationParams(searchParams);

    const fromDate = from ? new Date(`${from}T00:00:00.000`) : undefined;
    const toDate = to ? new Date(`${to}T23:59:59.999`) : undefined;

    const where = {
      status: 0,
      lecture: {
        status: 0,
        ...(classId ? { class: { id: classId } } : {}),
      },
      OR: [
        {
          submissions: {
            some: {
              studentId: session.studentId,
            },
          },
        },
        {
          lecture: {
            class: {
              students: { some: { studentId: session.studentId, isActive: true } },
            },
          },
        },
      ],
      ...(fromDate || toDate
        ? {
            dueDate: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };

    const [totalItems, quizzes] = await Promise.all([
      prisma.quiz.count({ where }),
      prisma.quiz.findMany({
        where,
        orderBy: [{ lecture: { date: "desc" } }, { title: "asc" }],
        skip,
        take,
        select: {
          id: true,
          title: true,
          maxAttempts: true,
          dueDate: true,
          lecture: {
            select: {
              title: true,
              class: { select: { id: true, name: true } },
            },
          },
          submissions: {
            where: { studentId: session.studentId },
            select: {
              id: true,
              score: true,
              totalQuestions: true,
              attemptCount: true,
              submittedAt: true,
            },
            take: 1,
          },
        },
      }),
    ]);

    const records = quizzes.map((q) => {
      const sub = q.submissions[0] ?? null;
      return {
        id: q.id,
        title: q.title,
        maxAttempts: q.maxAttempts,
        dueDate: q.dueDate ? q.dueDate.toISOString() : null,
        classId: q.lecture.class.id,
        className: q.lecture.class.name,
        lectureTitle: q.lecture.title,
        submission: sub
          ? {
              id: sub.id,
              score: sub.score,
              totalQuestions: sub.totalQuestions,
              attemptCount: sub.attemptCount,
              submittedAt: sub.submittedAt.toISOString(),
            }
          : null,
      };
    });

    // Classes for filter dropdown
    const classStudents = await prisma.classStudent.findMany({
      where: { studentId: session.studentId },
      distinct: ["classId"],
      include: { class: { select: { id: true, name: true } } },
    });
    const classes = classStudents.map((cs) => ({ id: cs.class.id, name: cs.class.name }));

    return apiSuccess(
      { records, classes },
      { pagination: buildPaginationMeta(totalItems, page, pageSize) },
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
