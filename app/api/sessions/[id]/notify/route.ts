import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { sessionNotifySchema } from "@/lib/session-validation";
import { notifyStudentsForSession } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const teacherSession = await requireTeacherSession();
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      return apiError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      email?: boolean;
      whatsapp?: boolean;
      notificationType?: "started" | "restarted";
    };

    const parsed = sessionNotifySchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const result = await notifyStudentsForSession({
      teacherId: teacherSession.teacherId,
      sessionId,
      channels: {
        email: parsed.data.email,
        whatsapp: parsed.data.whatsapp,
      },
      notificationType: parsed.data.notificationType,
      appBaseUrl: new URL(request.url).origin,
    });

    return apiSuccess(result, {
      message: "Live session notifications processed.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
