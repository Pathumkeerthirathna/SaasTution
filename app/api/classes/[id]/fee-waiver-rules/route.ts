import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { feeWaiverRuleSchema } from "@/lib/fee-waiver-validation";
import { createFeeWaiverRule, listFeeWaiverRules } from "@/services/class-fee-waiver-rule-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: { id: string } };

function classIdFrom(context: RouteContext) {
  const classId = context.params.id?.trim();
  if (!classId) {
    throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
  }
  return classId;
}

/** The class's active joining-waiver rules, in order. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await requireTeacherSession();
    const rules = await listFeeWaiverRules(session.teacherId, classIdFrom(context));
    return apiSuccess({ rules });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

/** Adds a rule at the next position. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const session = await requireTeacherSession();
    const classId = classIdFrom(context);
    const parsed = feeWaiverRuleSchema.safeParse(await request.json());

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const rules = await createFeeWaiverRule(session.teacherId, classId, parsed.data);
    return apiSuccess({ rules }, { status: 201, message: "Waiver rule added." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
