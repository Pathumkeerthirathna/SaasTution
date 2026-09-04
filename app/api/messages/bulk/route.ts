import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { bulkMessageSchema } from "@/lib/message-validation";
import { sendClassMessage } from "@/services/message-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      classId?: string;
      content?: string;
      channel?: string;
      channels?: string[];
    };

    const parsed = bulkMessageSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const result = await sendClassMessage({
      teacherId: session.teacherId,
      classId: parsed.data.classId,
      content: parsed.data.content,
      channels: parsed.data.channels,
    });

    return apiSuccess(result, {
      status: 201,
      message: "Message saved and sent to class students.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
