import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireTeacherSession } from "@/lib/auth-session";
import { replyToStudentDevice } from "@/services/student-device.service";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  try {
    const { deviceId } = await params;
    const teacher = await requireTeacherSession();

    const body = await request.json().catch(() => ({}));

    if (!body.rejectedReason?.trim()) {
      return apiError("Teacher response is required.", 400, "VALIDATION_ERROR");
    }

    const device = await replyToStudentDevice(
      deviceId,
      teacher.teacherId,
      body.rejectedReason
    );

    return apiSuccess(device);
  } catch (error) {
    return handleRouteError(error);
  }
}
