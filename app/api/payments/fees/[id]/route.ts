import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateStudentFeeAdjustment } from "@/services/class-student-fee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const feeId = context.params.id;

    if (!feeId?.trim()) {
      throw new AppError("Fee id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      discount?: unknown;
      lateJoinDeduct?: unknown;
      waiverAmount?: unknown;
    };

    const toNumber = (value: unknown) =>
      value === undefined || value === null || value === ""
        ? undefined
        : Number(value);

    const updated = await updateStudentFeeAdjustment({
      teacherId: session.teacherId,
      feeId,
      discount: toNumber(body.discount),
      lateJoinDeduct: toNumber(body.lateJoinDeduct),
      waiverAmount: toNumber(body.waiverAmount),
    });

    return apiSuccess(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
