import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { listMessageDeliveriesForTeacher } from "@/services/message-service";

const DELIVERY_STATUSES = new Set(["QUEUED", "SENT", "FAILED"] as const);

type DeliveryStatus = "QUEUED" | "SENT" | "FAILED";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const messageId = context.params.id;

    if (!messageId?.trim()) {
      throw new AppError("Message id is required.", 400, "VALIDATION_ERROR");
    }

    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);
    const statusParam = searchParams.get("status")?.trim().toUpperCase();

    if (statusParam && !DELIVERY_STATUSES.has(statusParam as DeliveryStatus)) {
      return apiError("status must be one of QUEUED, SENT, FAILED.", 400, "VALIDATION_ERROR");
    }

    const result = await listMessageDeliveriesForTeacher({
      teacherId: session.teacherId,
      messageId,
      skip: pagination.skip,
      take: pagination.take,
      status: statusParam as DeliveryStatus | undefined,
    });

    return apiSuccess(
      {
        message: result.message,
        deliveries: result.deliveries,
      },
      {
        pagination: buildPaginationMeta(result.totalItems, pagination.page, pagination.pageSize),
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
