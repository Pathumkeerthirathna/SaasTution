import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { parseRecordPaymentRequest, recordTeacherPayment } from "@/services/class-payment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/classes/[id]/fees/[feeId]/payments: the class's teacher records
 * money received directly (cash, bank transfer, other) against one monthly
 * fee. Body: { amount, paymentMethod, receivedAt, note?, requestKey }.
 * 201 with the payment and the fee's refreshed payment position; 200 for a
 * repeated request key (the original payment, nothing new recorded).
 */
export async function POST(request: Request, context: { params: { id: string; feeId: string } }) {
  try {
    const session = await requireTeacherSession();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("Invalid request body.", 400, "VALIDATION_ERROR");
    }
    const input = parseRecordPaymentRequest(body);
    const result = await recordTeacherPayment({
      teacherId: session.teacherId,
      classId: context.params.id,
      feeId: context.params.feeId,
      input,
    });
    return apiSuccess(result, {
      status: result.replayed ? 200 : 201,
      message: result.replayed ? "This payment was already recorded." : "Payment recorded.",
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
