import { apiError, apiSuccess } from "@/lib/api-response";
import { withNoStore } from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { lectureListQuerySchema } from "@/lib/lecture-validation";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { listLectureAttendanceOverviewForTeacher } from "@/services/lecture-attendance-overview-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/lectures/attendance-overview — one page of the signed-in
 * teacher's lectures with each attendance register's state
 * (services/lecture-attendance-overview-service.ts). Read only. The same
 * query parameters and validation as GET /api/lectures: page, pageSize (max
 * 100), classId (UUID; another teacher's or an unknown class: 404
 * CLASS_NOT_FOUND), title, from, to (invalid: 400), sortOrder (asc / desc,
 * by date). The teacher comes only from the session (401 otherwise).
 * Always no-store. (A static segment: it takes precedence over [id].)
 */
export async function GET(request: Request) {
  try {
    const { teacherId } = await requireTeacherSession();
    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);
    const classId = searchParams.get("classId")?.trim();
    const title = searchParams.get("title")?.trim() || undefined;
    const fromParam = searchParams.get("from")?.trim();
    const toParam = searchParams.get("to")?.trim();
    const sortOrder = searchParams.get("sortOrder") === "asc" ? "asc" : "desc";

    const parsedQuery = lectureListQuerySchema.safeParse({ classId });
    if (!parsedQuery.success) {
      const firstIssue = parsedQuery.error.issues[0]?.message ?? "Invalid query parameters.";
      return withNoStore(apiError(firstIssue, 400, "VALIDATION_ERROR", parsedQuery.error.flatten()));
    }

    const dateFrom = fromParam ? new Date(fromParam) : undefined;
    const dateTo = toParam ? new Date(toParam) : undefined;
    if ((dateFrom && Number.isNaN(dateFrom.getTime())) || (dateTo && Number.isNaN(dateTo.getTime()))) {
      return withNoStore(apiError("Invalid date range.", 400, "VALIDATION_ERROR"));
    }

    const { items, totalItems } = await listLectureAttendanceOverviewForTeacher({
      teacherId,
      classId: parsedQuery.data.classId,
      title,
      dateFrom,
      dateTo,
      sortOrder,
      skip: pagination.skip,
      take: pagination.take,
    });

    return withNoStore(apiSuccess(items, { pagination: buildPaginationMeta(totalItems, pagination.page, pagination.pageSize) }));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
