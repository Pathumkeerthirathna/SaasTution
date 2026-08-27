import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateLiveBroadcastPrivacySchema } from "@/lib/lecture-validation";
import { updateYouTubeLiveBroadcastPrivacyForTeacher } from "@/lib/youtube-lecture";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: {
    params: { id: string; liveId: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const liveId = context.params.liveId;

    if (!liveId?.trim()) {
      throw new AppError("Live broadcast id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as { privacy?: string };
    const parsed = updateLiveBroadcastPrivacySchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const liveBroadcast = await updateYouTubeLiveBroadcastPrivacyForTeacher(
      session.teacherId,
      liveId,
      parsed.data.privacy
    );

    return apiSuccess(
      {
        liveBroadcast,
      },
      {
        message: "Live broadcast privacy updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
