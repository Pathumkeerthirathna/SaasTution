import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateMaterialBundleSchema } from "@/lib/material-bundle-validation";
import {
  deleteMaterialBundleForTeacher,
  getMaterialBundleDetailsForTeacher,
  updateMaterialBundleForTeacher,
} from "@/services/material-bundle-service";

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

export async function PUT(
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
      year?: number;
      month?: number;
    };

    const parsed = updateMaterialBundleSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const bundle = await updateMaterialBundleForTeacher(session.teacherId, bundleId, parsed.data);
    return apiSuccess({ bundle }, { message: "Bundle updated successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: { bundleId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { bundleId } = context.params;

    if (!bundleId?.trim()) {
      throw new AppError("Bundle id is required.", 400, "VALIDATION_ERROR");
    }

    await deleteMaterialBundleForTeacher(session.teacherId, bundleId);
    return apiSuccess({ deleted: true }, { message: "Bundle deleted successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
