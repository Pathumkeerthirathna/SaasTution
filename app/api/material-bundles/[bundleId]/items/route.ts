import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { storeBundleItemFile } from "@/lib/material-bundle-file";
import { createMaterialBundleItemSchema } from "@/lib/material-bundle-validation";
import { addMaterialBundleItemForTeacher } from "@/services/material-bundle-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    const formData = await request.formData();
    const type = formData.get("type");
    const title = formData.get("title");
    const description = formData.get("description");
    const paperStartAt = formData.get("paperStartAt");
    const paperEndAt = formData.get("paperEndAt");

    const parsed = createMaterialBundleItemSchema.safeParse({
      type: typeof type === "string" ? type : undefined,
      title: typeof title === "string" ? title : undefined,
      description: typeof description === "string" && description.trim() ? description : undefined,
      paperStartAt: typeof paperStartAt === "string" && paperStartAt.trim() ? paperStartAt : undefined,
      paperEndAt: typeof paperEndAt === "string" && paperEndAt.trim() ? paperEndAt : undefined,
    });

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    let uploadedFile;
    try {
      uploadedFile = await storeBundleItemFile(bundleId, formData.get("file"));
    } catch (fileError) {
      return apiError(
        fileError instanceof Error ? fileError.message : "Invalid file.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const item = await addMaterialBundleItemForTeacher({
      teacherId: session.teacherId,
      bundleId,
      input: parsed.data,
      file: uploadedFile ?? undefined,
    });

    return apiSuccess({ item }, { status: 201, message: "Bundle item added successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
