import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { listStudentsByClassForTeacher } from "@/services/student-service";

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

    const { className, students, totalItems } = await listStudentsByClassForTeacher({
      teacherId: session.teacherId,
      classId,
      skip: pagination.skip,
      take: pagination.take,
    });

    return apiSuccess(
      {
        className,
        students,
      },
      {
        pagination: buildPaginationMeta(totalItems, pagination.page, pagination.pageSize),
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
