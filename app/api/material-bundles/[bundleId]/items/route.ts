import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { createMaterialBundleItemSchema } from "@/lib/material-bundle-validation";
import { addMaterialBundleItemForTeacher } from "@/services/material-bundle-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PDF_MIME_TYPE = "application/pdf";
const MAX_PDF_SIZE_BYTES = 25 * 1024 * 1024;

function sanitizeFileName(fileName: string) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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

    const formData = await request.formData();
    const type = formData.get("type");
    const title = formData.get("title");
    const description = formData.get("description");
    const paperStartAt = formData.get("paperStartAt");
    const paperEndAt = formData.get("paperEndAt");
    const file = formData.get("file");

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

    let uploadedFile:
      | {
          fileName: string;
          fileUrl: string;
          mimeType: string;
          sizeBytes: number;
        }
      | undefined;

    if (file instanceof File && file.size > 0) {
      if (file.type !== PDF_MIME_TYPE) {
        return apiError("Only PDF files are allowed.", 400, "VALIDATION_ERROR");
      }

      if (file.size > MAX_PDF_SIZE_BYTES) {
        return apiError("PDF file exceeds the maximum allowed size (25MB).", 400, "VALIDATION_ERROR");
      }

      const sanitized = sanitizeFileName(file.name) || "material.pdf";
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitized}`;
      const relativeDir = path.join("material-bundles", bundleId);
      const absoluteDir = path.join(process.cwd(), "storage", relativeDir);
      await mkdir(absoluteDir, { recursive: true });

      const filePath = path.join(absoluteDir, fileName);
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(filePath, buffer);

      uploadedFile = {
        fileName: file.name,
        fileUrl: path.join(relativeDir, fileName).replace(/\\/g, "/"),
        mimeType: file.type,
        sizeBytes: file.size,
      };
    }

    const item = await addMaterialBundleItemForTeacher({
      teacherId: session.teacherId,
      bundleId,
      input: parsed.data,
      file: uploadedFile,
    });

    return apiSuccess({ item }, { status: 201, message: "Bundle item added successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
