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

    const [totalItems, rows, classRows] = await Promise.all([
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
          item: { select: { id: true, title: true } },
          bundle: { select: { id: true, title: true } },
        },
      }),
      prisma.classStudent.findMany({
        where: { studentId: session.studentId },
        distinct: ["classId"],
        include: { class: { select: { id: true, name: true } } },
      }),
    ]);

    const messages = rows.map((row) => ({
      id: row.id,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      classId: row.class.id,
      className: row.class.name,
      itemId: row.item.id,
      itemTitle: row.item.title,
      bundleId: row.bundle.id,
      bundleTitle: row.bundle.title,
    }));

    const classes = classRows.map((cs) => ({ id: cs.class.id, name: cs.class.name }));

    return apiSuccess(
      { messages, classes },
      { pagination: buildPaginationMeta(totalItems, page, pageSize) },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
