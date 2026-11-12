import { apiSuccess } from "@/lib/api-response";
import {
  attendanceCrossOriginRejected,
  parseBody,
  parseLectureId,
  readJsonBody,
  RECONCILE_API_DEFAULT_LIMIT,
  reconcileBodySchema,
  withNoStore,
} from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { reconcileLectureOnlineEvidence } from "@/services/lecture-attendance-reconcile-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/lectures/[id]/attendance/reconcile — one page of online
 * evidence reconciliation for one of the signed-in teacher's LIVE lectures.
 * Same-origin only (403), checked first; then 401 / 400 / 404 / 409 / 503.
 * Body (optional, strict): { cursor?: string | null, limit?: 1–500 }
 * (default 100). Returns the service's counts, nextCursor and
 * stoppedBecause unchanged. Client workflow: start without a cursor,
 * continue with nextCursor until it is null; if any page reported busy > 0,
 * run a fresh pass without a cursor. Finalization's evidence gate stays
 * authoritative. Repeating a page is safe (idempotent). Always no-store.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return attendanceCrossOriginRejected(origin);

  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    const body = parseBody(reconcileBodySchema, await readJsonBody(request, { allowEmpty: true }));
    const result = await reconcileLectureOnlineEvidence({
      teacherId,
      lectureId,
      cursor: body.cursor ?? null,
      limit: body.limit ?? RECONCILE_API_DEFAULT_LIMIT,
    });
    return withNoStore(apiSuccess(result));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
