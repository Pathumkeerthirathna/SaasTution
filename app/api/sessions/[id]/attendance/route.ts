import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { listSessionAttendanceForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);

    const result = await listSessionAttendanceForTeacher({
      teacherId: session.teacherId,
      sessionId,
      skip: pagination.skip,
      take: pagination.take,
    });

    return apiSuccess(
      {
        session: result.session,
        records: result.records,
      },
      {
        pagination: buildPaginationMeta(result.totalItems, pagination.page, pagination.pageSize),
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
