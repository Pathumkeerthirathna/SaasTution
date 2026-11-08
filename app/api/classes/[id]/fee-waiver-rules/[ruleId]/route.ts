import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { feeWaiverRuleSchema } from "@/lib/fee-waiver-validation";
import { deleteFeeWaiverRule, updateFeeWaiverRule } from "@/services/class-fee-waiver-rule-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: { id: string; ruleId: string } };

function idsFrom(context: RouteContext) {
  const classId = context.params.id?.trim();
  const ruleId = context.params.ruleId?.trim();
  if (!classId || !ruleId) {
    throw new AppError("Class id and rule id are required.", 400, "VALIDATION_ERROR");
  }
  return { classId, ruleId };
}

/** Changes a rule's type / value (its position stays). */
export async function PUT(request: Request, context: RouteContext) {
  try {
    const session = await requireTeacherSession();
    const { classId, ruleId } = idsFrom(context);
    const parsed = feeWaiverRuleSchema.safeParse(await request.json());

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const rules = await updateFeeWaiverRule(session.teacherId, classId, ruleId, parsed.data);
    return apiSuccess({ rules }, { message: "Waiver rule updated." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

/** Removes a rule; later rules move up one position. */
export async function DELETE(request: Request, context: RouteContext) {
  try {
    const session = await requireTeacherSession();
    const { classId, ruleId } = idsFrom(context);
    const rules = await deleteFeeWaiverRule(session.teacherId, classId, ruleId);
    return apiSuccess({ rules }, { message: "Waiver rule removed." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
