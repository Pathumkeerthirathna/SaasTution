import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { parseReversalRequest, reverseTeacherPayment } from "@/services/class-payment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/classes/[id]/payments/[paymentId]/reversal: reverse a
 * teacher-recorded payment of this class (the teacher who recorded it, or the
 * class's teacher). Body: { reason }. The payment stays in the history; an
 * auditable reversal record is added and the amount is outstanding again.
 */
export async function POST(request: Request, context: { params: { id: string; paymentId: string } }) {
  try {
    const session = await requireTeacherSession();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("Invalid request body.", 400, "VALIDATION_ERROR");
    }
    const { reason } = parseReversalRequest(body);
    const result = await reverseTeacherPayment({
      actor: { role: "TEACHER", teacherId: session.teacherId },
      classId: context.params.id,
      paymentId: context.params.paymentId,
      reason,
    });
    return apiSuccess(result, { status: 201, message: "Payment reversed." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
