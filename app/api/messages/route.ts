import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { listMessagesForClass } from "@/services/message-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const { searchParams } = new URL(request.url);
    const classId = searchParams.get("classId")?.trim();

    if (!classId) {
      return apiError("classId query parameter is required.", 400, "VALIDATION_ERROR");
    }

    const pagination = parsePaginationParams(searchParams);
    const { messages, totalItems } = await listMessagesForClass({
      teacherId: session.teacherId,
      classId,
      skip: pagination.skip,
      take: pagination.take,
    });

    return apiSuccess(messages, {
      pagination: buildPaginationMeta(totalItems, pagination.page, pagination.pageSize),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
