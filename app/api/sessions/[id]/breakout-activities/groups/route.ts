// GET /api/sessions/[id]/breakout-activities/groups
// Teacher: the Group Activities progress view of this session: every room
// with confirmed members or a group activity, its confirmed members, and per
// GROUP assignment / quiz the progress and submission status.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getGroupOverviewForTeacher } from "@/services/breakout-group-overview-service";

import { requireBreakoutTeacher } from "../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    return apiSuccess(await getGroupOverviewForTeacher({ teacherId, sessionId: context.params.id }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
