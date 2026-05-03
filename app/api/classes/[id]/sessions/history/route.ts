import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { listClassSessionHistoryForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id;

    if (!classId?.trim()) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);
    const lectureId = searchParams.get("lectureId")?.trim() || undefined;
    const dateFromValue = searchParams.get("dateFrom")?.trim() || undefined;
    const dateToValue = searchParams.get("dateTo")?.trim() || undefined;

    const dateFrom = dateFromValue ? new Date(dateFromValue) : undefined;
    const dateTo = dateToValue ? new Date(dateToValue) : undefined;

    if (dateFrom && Number.isNaN(dateFrom.getTime())) {
      throw new AppError("dateFrom must be a valid date.", 400, "VALIDATION_ERROR");
    }

    if (dateTo && Number.isNaN(dateTo.getTime())) {
      throw new AppError("dateTo must be a valid date.", 400, "VALIDATION_ERROR");
    }

    if (dateTo) {
      dateTo.setHours(23, 59, 59, 999);
    }

    const result = await listClassSessionHistoryForTeacher({
      teacherId: session.teacherId,
      classId,
      lectureId,
      dateFrom,
      dateTo,
      skip: pagination.skip,
      take: pagination.take,
    });

    return apiSuccess(
      {
        sessions: result.sessions,
      },
      {
        pagination: buildPaginationMeta(result.totalItems, pagination.page, pagination.pageSize),
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
