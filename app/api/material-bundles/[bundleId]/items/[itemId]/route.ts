import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { storeBundleItemFile } from "@/lib/material-bundle-file";
import { updateMaterialBundleItemSchema } from "@/lib/material-bundle-validation";
import {
  deleteMaterialBundleItemForTeacher,
  updateMaterialBundleItemForTeacher,
} from "@/services/material-bundle-service";

export const runtime = "nodejs";
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

    const formData = await request.formData();
    const title = formData.get("title");
    const description = formData.get("description");
    const paperStartAt = formData.get("paperStartAt");
    const paperEndAt = formData.get("paperEndAt");
    const fileEntry = formData.get("file");

    const parsed = updateMaterialBundleItemSchema.safeParse({
      title: typeof title === "string" && title.trim() ? title : undefined,
      description: typeof description === "string" ? description : undefined,
      paperStartAt:
        typeof paperStartAt === "string" && paperStartAt.trim() ? paperStartAt : undefined,
      paperEndAt: typeof paperEndAt === "string" && paperEndAt.trim() ? paperEndAt : undefined,
    });

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    let uploadedFile;
    try {
      uploadedFile = await storeBundleItemFile(bundleId, fileEntry);
    } catch (fileError) {
      return apiError(
        fileError instanceof Error ? fileError.message : "Invalid file.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const hasChanges =
      parsed.data.title !== undefined ||
      parsed.data.description !== undefined ||
      parsed.data.paperStartAt !== undefined ||
      parsed.data.paperEndAt !== undefined ||
      uploadedFile !== null;

    if (!hasChanges) {
      return apiError("Nothing to update.", 400, "VALIDATION_ERROR");
    }

    const item = await updateMaterialBundleItemForTeacher(
      session.teacherId,
      bundleId,
      itemId,
      parsed.data,
      uploadedFile ?? undefined
    );
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
