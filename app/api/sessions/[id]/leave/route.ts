import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { emitSessionAttendanceEvent } from "@/lib/session-events";
import { studentSessionActionSchema } from "@/lib/session-validation";
import { markStudentLeftSession } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      return apiError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      studentId?: string;
    };

    const parsed = studentSessionActionSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const result = await markStudentLeftSession(sessionId, parsed.data.studentId);

    emitSessionAttendanceEvent({
      sessionId,
      attendanceId: result.attendance.id,
      studentId: result.attendance.studentId,
      joinedAt: result.attendance.joinedAt.toISOString(),
      leftAt: result.attendance.leftAt ? result.attendance.leftAt.toISOString() : null,
      event: "left",
      occurredAt: new Date().toISOString(),
    });

    return apiSuccess(result, {
      message: "Student leave event tracked successfully.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
