import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { createStudentSchema } from "@/lib/student-validation";
import { createStudent, listStudentsByTeacher } from "@/services/student-service";
import { RegisterStudentType } from "@/types/Student/RegisterStudent";
import { StudentRegistrationSource } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);
    const name = searchParams.get("name")?.trim() ?? "";
    const gradeId = Number(searchParams.get("grade") ?? 0);

    const email = searchParams.get("email")?.trim() || undefined;

    const sortBy = searchParams.get("sortBy") ?? "registrationNumber";
    const sortOrder = searchParams.get("sortOrder") ?? "asc";

      console.log("STUDENT SERVICE");

       console.log(request);

    const { students, totalItems } = await listStudentsByTeacher({
      teacherId: session.teacherId,
      skip: pagination.skip,
      take: pagination.take,
      name,
      email,
      gradeId: gradeId || undefined,
      sortBy,
      sortOrder,
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

    const body:RegisterStudentType = (await request.json()) as {
      registrationNumber?: string;
      name?: string;
      grade?: string;
      contact01?: string;
      contact02?: string;
      email?: string;
      registrationSource?: StudentRegistrationSource;
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
