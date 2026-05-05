import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { listMessagesQuerySchema } from "@/lib/message-validation";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { listMessagesForClass } from "@/services/message-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const { searchParams } = new URL(request.url);
    const parsed = listMessagesQuerySchema.safeParse({
      classId: searchParams.get("classId")?.trim(),
      dateFrom: searchParams.get("dateFrom")?.trim() || undefined,
      dateTo: searchParams.get("dateTo")?.trim() || undefined,
    });

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid query parameters.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const dateFrom = parsed.data.dateFrom
      ? new Date(`${parsed.data.dateFrom}T00:00:00.000Z`)
      : undefined;
    const dateTo = parsed.data.dateTo
      ? new Date(`${parsed.data.dateTo}T23:59:59.999Z`)
      : undefined;

    if (dateFrom && dateTo && dateFrom > dateTo) {
      return apiError("dateFrom cannot be later than dateTo.", 400, "VALIDATION_ERROR");
    }

    const pagination = parsePaginationParams(searchParams);
    const { messages, totalItems } = await listMessagesForClass({
      teacherId: session.teacherId,
      classId: parsed.data.classId,
      dateFrom,
      dateTo,
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
