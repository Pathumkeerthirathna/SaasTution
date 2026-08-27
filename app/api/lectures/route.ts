import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { createLectureSchema, lectureListQuerySchema } from "@/lib/lecture-validation";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { createLectureForTeacher, listLecturesForTeacher } from "@/services/lecture-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
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
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsedQuery.error.flatten());
    }

    const dateFrom = fromParam ? new Date(fromParam) : undefined;
    const dateTo = toParam ? new Date(toParam) : undefined;

    if ((dateFrom && Number.isNaN(dateFrom.getTime())) || (dateTo && Number.isNaN(dateTo.getTime()))) {
      return apiError("Invalid date range.", 400, "VALIDATION_ERROR");
    }

    const result = await listLecturesForTeacher({
      teacherId: session.teacherId,
      classId: parsedQuery.data.classId,
      title,
      dateFrom,
      dateTo,
      sortOrder,
      skip: pagination.skip,
      take: pagination.take,
    });

    return apiSuccess(result.lectures, {
      pagination: buildPaginationMeta(result.totalItems, pagination.page, pagination.pageSize),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      classId?: string;
      title?: string;
      date?: string;
    };

    const parsed = createLectureSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const lecture = await createLectureForTeacher(session.teacherId, parsed.data);

    return apiSuccess(
      {
        lecture,
      },
      {
        status: 201,
        message: "Lecture created successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
