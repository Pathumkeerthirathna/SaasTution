import { NextRequest } from "next/server";
import { StudentDeviceStatus } from "@prisma/client";

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  countPendingDeviceApprovalsForTeacher,
  getDeviceApprovalsForTeacher,
} from "@/services/student-device.service";

export const dynamic = "force-dynamic";

/**
 * Student devices belonging to this teacher's students that still need a
 * decision (`?status=pending`, the default) or that were previously rejected
 * (`?status=rejected`). Also returns the pending count so the page can badge
 * both tabs from one request.
 */
export async function GET(request: NextRequest) {
  try {
    const teacher = await requireTeacherSession();

    const statusParam = request.nextUrl.searchParams.get("status") ?? "pending";
    const status =
      statusParam === "rejected"
        ? StudentDeviceStatus.BLOCKED
        : StudentDeviceStatus.PENDING;

    const [devices, pendingCount] = await Promise.all([
      getDeviceApprovalsForTeacher(teacher.teacherId, status),
      countPendingDeviceApprovalsForTeacher(teacher.teacherId),
    ]);

    return apiSuccess({ devices, pendingCount });
  } catch (error) {
    return handleRouteError(error);
  }
}
