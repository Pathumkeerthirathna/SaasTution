import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { createStudentSchema } from "@/lib/student-validation";
import { createStudent, listStudentsByTeacher } from "@/services/student-service";

export const dynamic = "force-dynamic";

const GRADE_VALUES = new Set([
  "GRADE_01",
  "GRADE_02",
  "GRADE_03",
  "GRADE_04",
  "GRADE_05",
  "GRADE_06",
  "GRADE_07",
  "GRADE_08",
  "GRADE_09",
  "GRADE_10",
  "GRADE_11",
  "GRADE_12",
  "GRADE_13",
]);

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);
    const name = searchParams.get("name")?.trim() ?? "";
    const requestedGrade = searchParams.get("grade")?.trim() ?? "";
    const grade = GRADE_VALUES.has(requestedGrade) ? requestedGrade : "";

    const { students, totalItems } = await listStudentsByTeacher({
      teacherId: session.teacherId,
      skip: pagination.skip,
      take: pagination.take,
      name,
      grade,
    });

    return apiSuccess(students, {
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
      grade?: string;
      contact01?: string;
      contact02?: string;
      email?: string;
    };

    const parsed = createStudentSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const student = await createStudent(session.teacherId, parsed.data);

    return apiSuccess(
      {
        student,
      },
      {
        status: 201,
        message: "Student created successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
