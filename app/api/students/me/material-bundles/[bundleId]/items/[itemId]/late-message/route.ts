import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { paperLateReasonSchema } from "@/lib/material-bundle-validation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: { bundleId: string; itemId: string } }
) {
  try {
    const session = await requireStudentSession();
    const { bundleId, itemId } = context.params;

    if (!bundleId?.trim() || !itemId?.trim()) {
      throw new AppError("Bundle id and item id are required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      message?: string;
    };

    const parsed = paperLateReasonSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const item = await prisma.materialBundleItem.findFirst({
      where: {
        id: itemId,
        bundleId,
        type: "PAPER",
        bundle: {
          status: "SENT",
          recipients: {
            some: {
              studentId: session.studentId,
              willReceive: true,
            },
          },
        },
      },
      select: {
        id: true,
        bundleId: true,
        bundle: {
          select: {
            classId: true,
            class: {
              select: {
                teacherId: true,
              },
            },
          },
        },
      },
    });

    if (!item) {
      throw new AppError("Paper item not found.", 404, "BUNDLE_ITEM_NOT_FOUND");
    }

    const created = await prisma.paperSupportMessage.create({
      data: {
        bundleId: item.bundleId,
        itemId: item.id,
        classId: item.bundle.classId,
        teacherId: item.bundle.class.teacherId,
        studentId: session.studentId,
        message: parsed.data.message,
      },
      select: {
        id: true,
        createdAt: true,
      },
    });

    return apiSuccess(
      {
        id: created.id,
        createdAt: created.createdAt.toISOString(),
      },
      { status: 201, message: "Reason message sent to teacher." },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
