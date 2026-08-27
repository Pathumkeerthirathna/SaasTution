import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateRecordingAccessSchema } from "@/lib/lecture-validation";
import { updateRecordingAccessForTeacher } from "@/services/lecture-service";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: {
    params: { id: string; recordingId: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const recordingId = context.params.recordingId;

    if (!recordingId?.trim()) {
      throw new AppError("Recording id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as { visibility?: string; access?: string };
    const parsed = updateRecordingAccessSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const recording = await updateRecordingAccessForTeacher(session.teacherId, recordingId, parsed.data);

    return apiSuccess(
      {
        recording,
      },
      {
        message: "Recording updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
