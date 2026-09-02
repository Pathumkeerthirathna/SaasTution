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
    const lectureId = searchParams.get("lectureId") ?? undefined;
    const from = searchParams.get("from") ?? undefined;
    const to = searchParams.get("to") ?? undefined;
    const { page, pageSize, skip, take } = parsePaginationParams(searchParams);

    const fromDate = from ? new Date(`${from}T00:00:00.000`) : undefined;
    const toDate = to ? new Date(`${to}T23:59:59.999`) : undefined;

    const enrolledFilter = {
      class: {
        status: 0,
        students: { some: { studentId: session.studentId, isActive: true } },
      },
    };

    const where = {
      status: 0,
      lecture: {
        status: 0,
        ...enrolledFilter,
        ...(classId ? { classId } : {}),
        ...(lectureId ? { id: lectureId } : {}),
      },
      // The quiz window overlaps the selected range.
      ...(toDate ? { startDateTime: { lte: toDate } } : {}),
      ...(fromDate ? { endDateTime: { gte: fromDate } } : {}),
    };

    const [totalItems, quizzes, lectureOptions, classStudents] = await Promise.all([
      prisma.quiz.count({ where }),
      prisma.quiz.findMany({
        where,
        orderBy: [{ startDateTime: "asc" }, { title: "asc" }],
        skip,
        take,
        select: {
          id: true,
          title: true,
          maxAttempts: true,
          startDateTime: true,
          endDateTime: true,
          lecture: {
            select: {
              id: true,
              title: true,
              date: true,
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
      prisma.lecture.findMany({
        where: {
          status: 0,
          ...enrolledFilter,
          ...(classId ? { classId } : {}),
          quizzes: { some: { status: 0 } },
        },
        orderBy: { date: "desc" },
        select: {
          id: true,
          title: true,
          date: true,
          classId: true,
          class: { select: { name: true } },
        },
      }),
      prisma.classStudent.findMany({
        where: { studentId: session.studentId, isActive: true },
        distinct: ["classId"],
        select: { class: { select: { id: true, name: true } } },
        orderBy: { class: { name: "asc" } },
      }),
    ]);

    const records = quizzes.map((q) => {
      const sub = q.submissions[0] ?? null;
      return {
        id: q.id,
        title: q.title,
        maxAttempts: q.maxAttempts,
        startDateTime: q.startDateTime.toISOString(),
        endDateTime: q.endDateTime.toISOString(),
        classId: q.lecture.class.id,
        className: q.lecture.class.name,
        lectureId: q.lecture.id,
        lectureTitle: q.lecture.title,
        lectureDate: q.lecture.date.toISOString(),
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

    const classes = classStudents.map((cs) => ({ id: cs.class.id, name: cs.class.name }));
    const lectures = lectureOptions.map((l) => ({
      id: l.id,
      title: l.title,
      classId: l.classId,
      className: l.class.name,
      date: l.date.toISOString(),
    }));

    return apiSuccess(
      { records, classes, lectures },
      { pagination: buildPaginationMeta(totalItems, page, pageSize) },
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
