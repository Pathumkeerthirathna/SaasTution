import { NextRequest } from "next/server";

import { apiSuccess } from "@/lib/api-response";
import { getStudentDevicesByStudentId } from "@/services/student-device.service";
import { handleRouteError } from "@/lib/error-handler";
type RouteContext = {
  params: Promise<{
    studentId: string;
  }>;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ StudentId: string }> }
) {
  try {
    const { StudentId } = await params;

    console.log(StudentId);

    const devices = await getStudentDevicesByStudentId(StudentId);

    return apiSuccess(devices);
  } catch (error) {
    return handleRouteError(error);
  }
}