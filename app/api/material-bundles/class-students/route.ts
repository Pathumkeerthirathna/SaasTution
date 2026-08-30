import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { listActiveClassStudentsForMonthForTeacher } from "@/services/material-bundle-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();

    const { searchParams } = new URL(request.url);
    const classId = (searchParams.get("classId") ?? "").trim();
    const year = Number(searchParams.get("year"));
    const month = Number(searchParams.get("month"));

    if (!classId) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new AppError("Valid year and month are required.", 400, "VALIDATION_ERROR");
    }

    const students = await listActiveClassStudentsForMonthForTeacher({
      teacherId: session.teacherId,
      classId,
      year,
      month,
    });

    return apiSuccess({ students });
  } catch (error) {
    return handleRouteError(error);
  }
}
