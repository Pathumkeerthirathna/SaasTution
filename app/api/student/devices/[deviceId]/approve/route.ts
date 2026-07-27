import { NextRequest } from "next/server";

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { approveStudentDevice } from "@/services/student-device.service";
import { requireTeacherSession } from "@/lib/auth-session";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

export async function PUT(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { deviceId } = await context.params;

    const body = await request.json().catch(() => ({}));

    // Replace with logged-in teacher id
    const teacher = await requireTeacherSession();

    const device = await approveStudentDevice(
      deviceId,
      teacher.teacherId,
      body.reason
    );

    return apiSuccess(
      device
    );
  } catch (error) {
    return handleRouteError(error);
  }
}


