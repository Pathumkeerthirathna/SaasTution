import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: { bundleId: string } }
) {
  try {
    const session = await requireStudentSession();
    const { bundleId } = context.params;

    if (!bundleId?.trim()) {
      throw new AppError("Bundle id is required.", 400, "VALIDATION_ERROR");
    }

    const recipient = await prisma.materialBundleRecipient.findUnique({
      where: {
        bundleId_studentId: {
          bundleId,
          studentId: session.studentId,
        },
      },
      select: {
        bundleId: true,
        studentId: true,
        willReceive: true,
        receivedAt: true,
        bundle: {
          select: {
            bundleStatus: true,
            status: true,
          },
        },
      },
    });

    if (!recipient || !recipient.willReceive || recipient.bundle.status !== 0) {
      return apiError("Bundle not found.", 404, "BUNDLE_NOT_FOUND");
    }

    if (recipient.bundle.bundleStatus !== "SENT") {
      return apiError("Bundle is not marked as sent yet.", 400, "BUNDLE_NOT_SENT");
    }

    if (recipient.receivedAt) {
      return apiSuccess(
        {
          bundleId,
          receivedAt: recipient.receivedAt.toISOString(),
        },
        { message: "Delivery already confirmed." },
      );
    }

    const confirmedAt = new Date();

    await prisma.materialBundleRecipient.update({
      where: {
        bundleId_studentId: {
          bundleId,
          studentId: session.studentId,
        },
      },
      data: {
        receivedAt: confirmedAt,
      },
    });

    return apiSuccess(
      {
        bundleId,
        receivedAt: confirmedAt.toISOString(),
      },
      { message: "Delivery confirmed successfully." },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}