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
      studentId: session.studentId,
      message: {
        ...(classId ? { classId } : {}),
        ...(fromDate || toDate
          ? {
              createdAt: {
                ...(fromDate ? { gte: fromDate } : {}),
                ...(toDate ? { lte: toDate } : {}),
              },
            }
          : {}),
      },
    };

    const [totalItems, deliveries] = await Promise.all([
      prisma.messageDelivery.count({ where }),
      prisma.messageDelivery.findMany({
        where,
        include: {
          message: {
            include: {
              class: {
                select: {
                  id: true,
                  name: true,
                  teacher: { select: { name: true } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
    ]);

    const messages = deliveries.map((d) => ({
      id: d.id,
      messageId: d.messageId,
      classId: d.message.classId,
      className: d.message.class.name,
      teacherName: d.message.class.teacher.name,
      content: d.message.content,
      sentAt: d.message.createdAt.toISOString(),
      status: d.status,
    }));

    // All classes the student is enrolled in (for filter dropdown)
    const classStudents = await prisma.classStudent.findMany({
      where: { studentId: session.studentId },
      distinct: ["classId"],
      include: { class: { select: { id: true, name: true } } },
    });
    const classes = classStudents.map((cs) => ({ id: cs.class.id, name: cs.class.name }));

    return apiSuccess(
      { messages, classes },
      { pagination: buildPaginationMeta(totalItems, page, pageSize) },
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
