import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { saveMaterialBundleRecipientsSchema } from "@/lib/material-bundle-validation";
import { getMaterialBundleDetailsForTeacher, saveMaterialBundleRecipientsForTeacher } from "@/services/material-bundle-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: { bundleId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { bundleId } = context.params;

    if (!bundleId?.trim()) {
      throw new AppError("Bundle id is required.", 400, "VALIDATION_ERROR");
    }

    const bundle = await getMaterialBundleDetailsForTeacher(session.teacherId, bundleId);
    return apiSuccess({ bundle });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: { bundleId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { bundleId } = context.params;

    if (!bundleId?.trim()) {
      throw new AppError("Bundle id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      selectedStudentIds?: string[];
    };

    const parsed = saveMaterialBundleRecipientsSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const bundle = await saveMaterialBundleRecipientsForTeacher(session.teacherId, bundleId, parsed.data);

    return apiSuccess({ bundle }, { message: "Bundle sent and recipients saved successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
