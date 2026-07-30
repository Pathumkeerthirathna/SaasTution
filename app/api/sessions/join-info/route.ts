import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { verifySessionInviteToken } from "@/lib/session-invite";
import { getSessionJoinInfo } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const studentSession = await requireStudentSession();
    const { searchParams } = new URL(request.url);
    const invite = searchParams.get("invite")?.trim();

    if (!invite) {
      return apiError("invite query parameter is required.", 400, "VALIDATION_ERROR");
    }

    const invitePayload = await verifySessionInviteToken(invite);

    if (!invitePayload) {
      return apiError("Invite link is invalid or expired.", 400, "INVALID_INVITE");
    }

    if (invitePayload.studentId !== studentSession.studentId) {
      return apiError("Invite link does not match the logged in student.", 403, "INVITE_STUDENT_MISMATCH");
    }

    const joinInfo = await getSessionJoinInfo(
        invitePayload.sessionId,
        studentSession
    );

    if (joinInfo.session.classId !== invitePayload.classId) {
        return apiError(
            "Invite link is invalid for this session.",
            400,
            "INVALID_INVITE"
        );
    }

    return apiSuccess(joinInfo);
  } catch (error) {
    return handleRouteError(error);
  }
}
