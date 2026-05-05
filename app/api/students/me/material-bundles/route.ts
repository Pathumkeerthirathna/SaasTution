import { NextRequest } from "next/server";

import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DEFAULT_COUNTDOWN_MINUTES = 30;
const DEFAULT_GRACE_MINUTES = 20;

export async function GET(req: NextRequest) {
  try {
    const session = await requireStudentSession();

    const { searchParams } = req.nextUrl;
    const viewParam = searchParams.get("view");
    const view = viewParam === "confirmed" ? "confirmed" : "awaiting";
    const classId = searchParams.get("classId") ?? undefined;
    const from = searchParams.get("from") ?? undefined;
    const to = searchParams.get("to") ?? undefined;
    const { page, pageSize, skip, take } = parsePaginationParams(searchParams);

    const fromDate = from ? new Date(`${from}T00:00:00.000`) : undefined;
    const toDate = to ? new Date(`${to}T23:59:59.999`) : undefined;
    const now = new Date();

    const where = {
      status: "SENT" as const,
      ...(classId ? { classId } : {}),
      ...(fromDate || toDate
        ? {
            sentAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
      recipients: {
        some: {
          studentId: session.studentId,
          willReceive: true,
          ...(view === "awaiting" ? { receivedAt: null } : { receivedAt: { not: null } }),
        },
      },
    };

    const [totalItems, bundles, classRows] = await Promise.all([
      prisma.materialBundle.count({ where }),
      prisma.materialBundle.findMany({
        where,
        orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
        skip,
        take,
        select: {
          id: true,
          title: true,
          year: true,
          month: true,
          sentAt: true,
          class: {
            select: {
              id: true,
              name: true,
              teacher: {
                select: {
                  paperConfig: {
                    select: {
                      countdownLeadMinutes: true,
                      submissionGraceMinutes: true,
                    },
                  },
                },
              },
            },
          },
          recipients: {
            where: { studentId: session.studentId, willReceive: true },
            select: {
              receivedAt: true,
            },
            take: 1,
          },
          items: {
            orderBy: [{ type: "asc" }, { createdAt: "desc" }],
            select: {
              id: true,
              type: true,
              title: true,
              description: true,
              fileName: true,
              fileUrl: true,
              paperStartAt: true,
              paperEndAt: true,
              submissions: {
                where: {
                  studentId: session.studentId,
                },
                orderBy: {
                  submittedAt: "desc",
                },
                take: 1,
                select: {
                  id: true,
                  fileName: true,
                  mimeType: true,
                  sizeBytes: true,
                  submittedAt: true,
                },
              },
            },
          },
        },
      }),
      prisma.classStudent.findMany({
        where: { studentId: session.studentId },
        distinct: ["classId"],
        include: { class: { select: { id: true, name: true } } },
      }),
    ]);

    const records = bundles.map((bundle) => ({
      countdownLeadMinutes: bundle.class.teacher.paperConfig?.countdownLeadMinutes ?? DEFAULT_COUNTDOWN_MINUTES,
      submissionGraceMinutes: bundle.class.teacher.paperConfig?.submissionGraceMinutes ?? DEFAULT_GRACE_MINUTES,
      id: bundle.id,
      title: bundle.title,
      year: bundle.year,
      month: bundle.month,
      sentAt: bundle.sentAt ? bundle.sentAt.toISOString() : null,
      confirmedAt: bundle.recipients[0]?.receivedAt ? bundle.recipients[0].receivedAt.toISOString() : null,
      classId: bundle.class.id,
      className: bundle.class.name,
      items: bundle.items.map((item) => ({
        submissionDeadline:
          item.type === "PAPER" && item.paperEndAt
            ? new Date(
                item.paperEndAt.getTime() +
                  (bundle.class.teacher.paperConfig?.submissionGraceMinutes ?? DEFAULT_GRACE_MINUTES) * 60 * 1000,
              ).toISOString()
            : null,
        canSubmit:
          item.type === "PAPER"
            ? !!item.paperStartAt &&
              !!item.paperEndAt &&
              now >= item.paperStartAt &&
              now <=
                new Date(
                  item.paperEndAt.getTime() +
                    (bundle.class.teacher.paperConfig?.submissionGraceMinutes ?? DEFAULT_GRACE_MINUTES) * 60 * 1000,
                )
            : false,
        id: item.id,
        type: item.type,
        title: item.title,
        description: item.description,
        fileName: item.fileName,
        fileUrl: item.fileUrl,
        paperStartAt: item.paperStartAt ? item.paperStartAt.toISOString() : null,
        paperEndAt: item.paperEndAt ? item.paperEndAt.toISOString() : null,
        latestSubmission: item.submissions[0]
          ? {
              id: item.submissions[0].id,
              fileName: item.submissions[0].fileName,
              mimeType: item.submissions[0].mimeType,
              sizeBytes: item.submissions[0].sizeBytes,
              submittedAt: item.submissions[0].submittedAt.toISOString(),
            }
          : null,
      })),
    }));

    const classes = classRows.map((cs) => ({ id: cs.class.id, name: cs.class.name }));

    return apiSuccess(
      { records, classes, view },
      { pagination: buildPaginationMeta(totalItems, page, pageSize) },
    );
  } catch (err) {
    return handleRouteError(err);
  }
}