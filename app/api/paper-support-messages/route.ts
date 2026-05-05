import { NextRequest } from "next/server";

import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await requireTeacherSession();

    const { searchParams } = req.nextUrl;
    const classId = searchParams.get("classId") ?? undefined;
    const from = searchParams.get("from") ?? undefined;
    const to = searchParams.get("to") ?? undefined;
    const { page, pageSize, skip, take } = parsePaginationParams(searchParams);

    const fromDate = from ? new Date(`${from}T00:00:00.000`) : undefined;
    const toDate = to ? new Date(`${to}T23:59:59.999`) : undefined;

    const where = {
      teacherId: session.teacherId,
      ...(classId ? { classId } : {}),
      ...(fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };

    const [totalItems, rows] = await Promise.all([
      prisma.paperSupportMessage.count({ where }),
      prisma.paperSupportMessage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          message: true,
          createdAt: true,
          class: { select: { id: true, name: true } },
          student: { select: { id: true, name: true, registrationNumber: true } },
          item: { select: { id: true, title: true } },
          bundle: { select: { id: true, title: true } },
        },
      }),
    ]);

    const messages = rows.map((row) => ({
      id: row.id,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      classId: row.class.id,
      className: row.class.name,
      studentId: row.student.id,
      studentName: row.student.name,
      registrationNumber: row.student.registrationNumber,
      itemId: row.item.id,
      itemTitle: row.item.title,
      bundleId: row.bundle.id,
      bundleTitle: row.bundle.title,
    }));

    return apiSuccess(
      { messages },
      { pagination: buildPaginationMeta(totalItems, page, pageSize) },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
