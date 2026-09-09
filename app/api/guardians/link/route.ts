import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { linkGuardianSchema } from "@/lib/guardian-validation";
import {
  linkGuardianToStudent,
  unlinkGuardianFromStudent,
} from "@/services/guardian-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as Record<string, unknown>;

    const parsed = linkGuardianSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const result = await linkGuardianToStudent(session.teacherId, parsed.data);
    return apiSuccess(result, { status: 201, message: "Guardian linked to student." });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireTeacherSession();
    const { searchParams } = new URL(request.url);
    const guardianId = searchParams.get("guardianId")?.trim();
    const studentId = searchParams.get("studentId")?.trim();

    if (!guardianId || !studentId) {
      throw new AppError(
        "guardianId and studentId are required.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const result = await unlinkGuardianFromStudent(
      session.teacherId,
      guardianId,
      studentId
    );

    return apiSuccess(result, { message: "Guardian unlinked from student." });
  } catch (error) {
    return handleRouteError(error);
  }
}
