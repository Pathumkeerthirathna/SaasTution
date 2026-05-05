import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateMaterialBundleItemSchema } from "@/lib/material-bundle-validation";
import {
  deleteMaterialBundleItemForTeacher,
  updateMaterialBundleItemForTeacher,
} from "@/services/material-bundle-service";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: { bundleId: string; itemId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { bundleId, itemId } = context.params;

    if (!bundleId?.trim() || !itemId?.trim()) {
      throw new AppError("Bundle id and item id are required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      title?: string;
      description?: string;
      paperStartAt?: string | null;
      paperEndAt?: string | null;
    };

    const parsed = updateMaterialBundleItemSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const item = await updateMaterialBundleItemForTeacher(session.teacherId, bundleId, itemId, parsed.data);
    return apiSuccess({ item }, { message: "Bundle item updated successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: { bundleId: string; itemId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { bundleId, itemId } = context.params;

    if (!bundleId?.trim() || !itemId?.trim()) {
      throw new AppError("Bundle id and item id are required.", 400, "VALIDATION_ERROR");
    }

    await deleteMaterialBundleItemForTeacher(session.teacherId, bundleId, itemId);
    return apiSuccess({ deleted: true }, { message: "Bundle item deleted successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
