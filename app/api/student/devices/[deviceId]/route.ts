import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireTeacherSession } from "@/lib/auth-session";
import { deleteStudentDeviceForTeacher } from "@/services/student-device.service";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { deviceId: string } }
) {
  try {
    const teacher = await requireTeacherSession();

    const result = await deleteStudentDeviceForTeacher(
      params.deviceId,
      teacher.teacherId
    );

    if (!result.deleted) {
      return apiError("Device not found.", 404, "DEVICE_NOT_FOUND");
    }

    return apiSuccess({ deleted: true }, { message: "Device removed." });
  } catch (error) {
    return handleRouteError(error);
  }
}
