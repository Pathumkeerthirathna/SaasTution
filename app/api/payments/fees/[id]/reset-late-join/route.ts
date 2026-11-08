import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { resetLateJoinDeductToAutomatic } from "@/services/class-student-fee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Explicit "Reset to automatic" of a manually entered late-join deduction.
 * 409 FEE_LOCKED (paid), NOT_MANUAL, FEE_CHANGED (changed meanwhile; nothing
 * written) or WAIVER_NOT_ACTIVE_FOR_MONTH (before the launch month).
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    const feeId = context.params.id?.trim();

    if (!feeId) {
      throw new AppError("Fee id is required.", 400, "VALIDATION_ERROR");
    }

    const updated = await resetLateJoinDeductToAutomatic({ teacherId: session.teacherId, feeId });

    return apiSuccess(updated, { message: "Late-join deduction reset to automatic." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
