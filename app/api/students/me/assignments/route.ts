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
      ...(fromDate || toDate
        ? {
            dueDate: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };

    const [totalItems, assignments, submissions, lectureOptions, classStudents] =
      await Promise.all([
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
            lecture: {
              select: {
                id: true,
                title: true,
                date: true,
                class: { select: { id: true, name: true } },
              },
            },
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
        // Lectures (with at least one active assignment) for the lecture filter.
        prisma.lecture.findMany({
          where: {
            status: 0,
            ...enrolledFilter,
            ...(classId ? { classId } : {}),
            assignments: { some: { status: 0 } },
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
        lectureId: a.lecture.id,
        lectureTitle: a.lecture.title,
        lectureDate: a.lecture.date.toISOString(),
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
