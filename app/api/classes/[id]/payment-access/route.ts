import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  getClassAccessSettings,
  parseClassAccessSettings,
  updateClassAccessSettings,
} from "@/services/class-access-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET / PUT /api/classes/[id]/payment-access: the class's payment-due access
 * control (restrictUnpaidStudentAccess, paymentGracePeriodDays). Only the
 * class's own teacher.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    return apiSuccess(await getClassAccessSettings(session.teacherId, context.params.id));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function PUT(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("Invalid request body.", 400, "VALIDATION_ERROR");
    }
    const settings = parseClassAccessSettings(body);
    const saved = await updateClassAccessSettings(session.teacherId, context.params.id, settings);
    return apiSuccess(saved, { message: "Payment access settings saved." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
