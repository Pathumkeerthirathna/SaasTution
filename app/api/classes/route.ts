import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { CLASS_START_DATE_NOT_SET } from "@/lib/class-start-date";
import { createClassSchema } from "@/lib/class-validation";
import { handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { createClassForTeacher, listClassesByTeacher } from "@/services/class-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();

    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);
    const nameFilter = searchParams.get("name")?.trim() || undefined;
    const scheduleFilter = searchParams.get("schedule")?.trim() || undefined;

    const { classes, totalItems } = await listClassesByTeacher({
      teacherId: session.teacherId,
      skip: pagination.skip,
      take: pagination.take,
      name: nameFilter,
      schedule: scheduleFilter,
    });

    return apiSuccess(classes, {
      pagination: buildPaginationMeta(totalItems, pagination.page, pagination.pageSize),
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function POST(request: Request) {
  // Same-origin only (CSRF), before authentication (Stage 5.7b-2b-2).
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      name?: string;
      description?: string;
      startDate?: string;
      monthlyFee?: number;
      paymentDueWeek?: number;
      attendanceGraceMinutes?: number;
      schedule?: string;
      schedules?: {
        dayOfWeek?: "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY";
        startTime?: string;
        endTime?: string;
      }[];
    };

    const parsed = createClassSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    // Batch Start Date: the validated "YYYY-MM-DD" as sent (1900-01-01 = not given, kept as is);
    // nothing sent = the "not given" sentinel. Never replaced with today or any other date.
    const createdClass = await createClassForTeacher(session.teacherId, {
      ...parsed.data,
      startDate: parsed.data.startDate ?? CLASS_START_DATE_NOT_SET,
    });

    return apiSuccess(
      {
        class: createdClass,
      },
      {
        status: 201,
        message: "Class created successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
