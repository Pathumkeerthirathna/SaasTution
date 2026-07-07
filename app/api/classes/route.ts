import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { createClassSchema } from "@/lib/class-validation";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { createClassForTeacher, listClassesByTeacher } from "@/services/class-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {

  try {
    
    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);
    const nameFilter = searchParams.get("name")?.trim() || undefined;
    const scheduleFilter = searchParams.get("schedule")?.trim() || undefined;

    var teacherId = searchParams.get("teacherId");

    if (!teacherId) {
      const teachr = await requireTeacherSession();

      teacherId = teachr.teacherId;

    }

    if (!teacherId) {
      throw new Error("Teacher id is required.");
    }

    const { classes, totalItems } = await listClassesByTeacher({
      teacherId: teacherId,
      skip: pagination.skip,
      take: pagination.take,
      name: nameFilter,
      schedule: scheduleFilter,
    });

    return apiSuccess(classes, {
      pagination: buildPaginationMeta(totalItems, pagination.page, pagination.pageSize),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      name?: string;
      description?: string;
      startDate: string;
      monthlyFee?: number;
      paymentDueWeek?: number;
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

    const createdClass = await createClassForTeacher(session.teacherId, {
      ...parsed.data,
      startDate: body.startDate,
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
    return handleRouteError(error);
  }
}
