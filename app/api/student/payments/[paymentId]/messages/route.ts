import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  ALLOWED_PAYMENT_PROOF_MIME_TYPES,
  MAX_PAYMENT_PROOF_SIZE_BYTES,
  sanitizeUploadFileName,
} from "@/lib/payment-validation";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: { paymentId: string } }
) {
  try {
    const session = await requireStudentSession();
    const paymentId = context.params.paymentId;

    if (!paymentId?.trim()) {
      return apiError("Payment id is required.", 400, "VALIDATION_ERROR");
    }

    const payment = await prisma.classPayment.findFirst({
      where: {
        id: paymentId,
        studentId: session.studentId,
      },
      select: {
        id: true,
      },
    });

    if (!payment) {
      throw new AppError("Payment not found.", 404, "PAYMENT_NOT_FOUND");
    }

    const formData = await request.formData();
    const message = String(formData.get("message") ?? "").trim();
    const fileEntry = formData.get("proof");

    if (!message && (!(fileEntry instanceof File) || fileEntry.size === 0)) {
      return apiError("Add a message or proof file.", 400, "VALIDATION_ERROR");
    }

    let fileMeta:
      | {
          fileName: string;
          fileUrl: string;
          mimeType: string;
          sizeBytes: number;
        }
      | undefined;

    if (fileEntry instanceof File && fileEntry.size > 0) {
      if (!ALLOWED_PAYMENT_PROOF_MIME_TYPES.has(fileEntry.type)) {
        return apiError("Only PDF, PNG, JPG, and WEBP files are allowed.", 400, "UNSUPPORTED_FILE_TYPE");
      }

      if (fileEntry.size > MAX_PAYMENT_PROOF_SIZE_BYTES) {
        return apiError("Proof file exceeds size limit of 10 MB.", 400, "FILE_TOO_LARGE");
      }

      const bytes = new Uint8Array(await fileEntry.arrayBuffer());
      const safeName = sanitizeUploadFileName(fileEntry.name || "proof") || "proof";
      const ext = path.extname(safeName) || (fileEntry.type === "application/pdf" ? ".pdf" : "");
      const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}${ext && !safeName.endsWith(ext) ? ext : ""}`;
      const uploadDir = path.join(process.cwd(), "storage", "payments", paymentId, "messages");
      await mkdir(uploadDir, { recursive: true });
      const fullFilePath = path.join(uploadDir, storedName);
      await writeFile(fullFilePath, bytes);

      fileMeta = {
        fileName: fileEntry.name || "proof",
        fileUrl: `payments/${paymentId}/messages/${storedName}`,
        mimeType: fileEntry.type,
        sizeBytes: fileEntry.size,
      };
    }

    const created = await prisma.$transaction(async (tx) => {
      const paymentUpdate = await tx.classPayment.update({
        where: { id: paymentId },
        data: {
          status: "PENDING",
          teacherFeedback: null,
        },
      });

      const paymentMessage = await tx.paymentMessage.create({
        data: {
          paymentId,
          senderRole: "STUDENT",
          studentId: session.studentId,
          message: message || "Submitted additional proof",
          ...(fileMeta
            ? {
                proofFileName: fileMeta.fileName,
                proofFileUrl: fileMeta.fileUrl,
                proofMimeType: fileMeta.mimeType,
                proofSizeBytes: fileMeta.sizeBytes,
              }
            : {}),
        },
        select: {
          id: true,
          message: true,
          proofFileName: true,
          createdAt: true,
        },
      });

      return { paymentUpdate, paymentMessage };
    });

    return apiSuccess({ message: created.paymentMessage }, { status: 201, message: "Reply added successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
