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

    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    if (toDate) toDate.setHours(23, 59, 59, 999);

    const where = {
      studentId: session.studentId,
      ...(classId ? { classId } : {}),
      ...(fromDate || toDate
        ? {
            joinedAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };

    const [totalItems, rows] = await Promise.all([
      prisma.attendance.count({ where }),
      prisma.attendance.findMany({
        where,
        include: {
          classSession: {
            include: {
              class: { select: { id: true, name: true } },
              lecture: { select: { id: true, title: true } },
            },
          },
        },
        orderBy: { joinedAt: "desc" },
        skip,
        take,
      }),
    ]);

    const records = rows.map((a) => ({
      id: a.id,
      classId: a.classId,
      className: a.classSession.class.name,
      lectureTitle: a.classSession.lecture?.title ?? null,
      joinedAt: a.joinedAt.toISOString(),
      leftAt: a.leftAt ? a.leftAt.toISOString() : null,
    }));

    const allClasses = await prisma.classStudent.findMany({
      where: { studentId: session.studentId },
      distinct: ["classId"],
      include: { class: { select: { id: true, name: true } } },
    });

    const classes = allClasses.map((cs) => ({ id: cs.class.id, name: cs.class.name }));

    return apiSuccess(
      { records, classes },
      { pagination: buildPaginationMeta(totalItems, page, pageSize) },
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
