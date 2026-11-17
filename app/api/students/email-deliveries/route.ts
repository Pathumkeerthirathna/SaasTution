import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { listEmailDeliveriesForTeacher, parseEmailDeliveryStatusFilter } from "@/services/student-email-delivery-service";

export const dynamic = "force-dynamic";

/**
 * The signed-in teacher's student email delivery history (welcome and
 * resend emails). Only that teacher's records (teacherId from the session).
 * Never returns passwords, ciphertexts or password hashes.
 *
 * Query: page, pageSize, status (PENDING | PROCESSING | SENT | FAILED),
 * studentId, importBatchId, deliveryId. `summary` counts the same scope
 * (without the status filter), e.g. one import batch.
 */
export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const params = new URL(request.url).searchParams;
    const { page, pageSize, skip, take } = parsePaginationParams(params);
    const id = (name: string) => {
      const value = params.get(name)?.trim() ?? "";
      return value && value.length <= 128 ? value : null;
    };

    const { items, total, summary } = await listEmailDeliveriesForTeacher({
      teacherId: session.teacherId,
      skip,
      take,
      status: parseEmailDeliveryStatusFilter(params.get("status")),
      studentId: id("studentId"),
      importBatchId: id("importBatchId"),
      deliveryId: id("deliveryId"),
    });

    const response = apiSuccess({ items, summary }, { pagination: buildPaginationMeta(total, page, pageSize) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
