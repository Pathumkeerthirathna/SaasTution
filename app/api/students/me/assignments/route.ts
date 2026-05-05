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
      ...(classId ? { lecture: { class: { id: classId } } } : {}),
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

    const [totalItems, assignments, submissions] = await Promise.all([
      prisma.assignment.count({ where }),
      prisma.assignment.findMany({
        where,
        orderBy: { dueDate: "asc" },
        skip,
        take,
        select: {
          id: true,
          title: true,
          description: true,
          dueDate: true,
          lecture: { select: { class: { select: { id: true, name: true } } } },
        },
      }),
      prisma.assignmentSubmission.findMany({
        where: { studentId: session.studentId },
        select: {
          assignmentId: true,
          id: true,
          notes: true,
          fileName: true,
          fileUrl: true,
          mimeType: true,
          sizeBytes: true,
          submittedAt: true,
        },
      }),
    ]);

    const submissionMap = new Map(submissions.map((s) => [s.assignmentId, s]));

    const records = assignments.map((a) => {
      const sub = submissionMap.get(a.id) ?? null;
      return {
        id: a.id,
        title: a.title,
        description: a.description,
        dueDate: a.dueDate.toISOString(),
        classId: a.lecture.class.id,
        className: a.lecture.class.name,
        submission: sub
          ? {
              id: sub.id,
              notes: sub.notes,
              fileName: sub.fileName,
              fileUrl: sub.fileUrl,
              mimeType: sub.mimeType,
              sizeBytes: sub.sizeBytes,
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
