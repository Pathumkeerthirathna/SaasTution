import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { parseReversalRequest, reverseTeacherPayment } from "@/services/class-payment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/payments/[paymentId]/reversal: an administrator reverses
 * any teacher-recorded payment. Body: { reason }. Recorded with the admin's
 * id; the payment itself stays in the history.
 */
export async function POST(request: Request, context: { params: { paymentId: string } }) {
  try {
    const session = await requireAdminSession();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("Invalid request body.", 400, "VALIDATION_ERROR");
    }
    const { reason } = parseReversalRequest(body);
    const result = await reverseTeacherPayment({
      actor: { role: "ADMIN", adminId: session.adminId },
      paymentId: context.params.paymentId,
      reason,
    });
    return apiSuccess(result, { status: 201, message: "Payment reversed." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
