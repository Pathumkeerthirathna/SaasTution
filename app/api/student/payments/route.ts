import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  ALLOWED_PAYMENT_PROOF_MIME_TYPES,
  getCurrentMonthKey,
  isValidMonthKey,
  MAX_PAYMENT_PROOF_SIZE_BYTES,
  sanitizeUploadFileName,
} from "@/lib/payment-validation";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertPathInBounds(resolvedPath: string, allowedRoot: string) {
  const relative = path.relative(allowedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
  }
}

export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const { searchParams } = new URL(request.url);
    const classId = searchParams.get("classId")?.trim();

    const payments = await prisma.classPayment.findMany({
      where: {
        studentId: session.studentId,
        ...(classId ? { classId } : {}),
      },
      orderBy: [{ month: "desc" }, { submittedAt: "desc" }],
      select: {
        id: true,
        classId: true,
        month: true,
        amount: true,
        note: true,
        status: true,
        teacherFeedback: true,
        slipFileName: true,
        submittedAt: true,
        class: {
          select: {
            name: true,
            monthlyFee: true,
            paymentDueWeek: true,
          },
        },
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            senderRole: true,
            message: true,
            proofFileName: true,
            createdAt: true,
            teacher: {
              select: {
                name: true,
              },
            },
            student: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

    return apiSuccess({
      payments: payments.map((item) => ({
        ...item,
        hasSlip: Boolean(item.slipFileName),
        messages: item.messages.map((msg) => ({
          ...msg,
          senderName: msg.senderRole === "TEACHER" ? msg.teacher?.name ?? "Teacher" : msg.student?.name ?? "Student",
          hasProofFile: Boolean(msg.proofFileName),
        })),
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireStudentSession();
    const formData = await request.formData();

    const classId = String(formData.get("classId") ?? "").trim();
    const month = String(formData.get("month") ?? "").trim();
    const amountRaw = String(formData.get("amount") ?? "").trim();
    const note = String(formData.get("note") ?? "").trim() || null;
    const fileEntry = formData.get("slip");

    if (!classId) {
      return apiError("Class is required.", 400, "VALIDATION_ERROR");
    }

    const monthKey = month || getCurrentMonthKey();
    if (!isValidMonthKey(monthKey)) {
      return apiError("Month must be in YYYY-MM format.", 400, "VALIDATION_ERROR");
    }

    const enrollment = await prisma.classStudent.findFirst({
      where: {
        classId,
        studentId: session.studentId,
        isActive: true,
      },
      select: {
        id: true,
        class: {
          select: {
            monthlyFee: true,
          },
        },
      },
    });

    if (!enrollment) {
      throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
    }

    const amount = amountRaw ? Number(amountRaw) : enrollment.class.monthlyFee;
    if (!Number.isInteger(amount) || amount < 0) {
      return apiError("Amount must be a non-negative whole number.", 400, "VALIDATION_ERROR");
    }

    let storedFileMeta:
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
        return apiError("Payment proof exceeds size limit of 10 MB.", 400, "FILE_TOO_LARGE");
      }

      const bytes = new Uint8Array(await fileEntry.arrayBuffer());
      const safeName = sanitizeUploadFileName(fileEntry.name || "payment-proof") || "payment-proof";
      const ext = path.extname(safeName) || (fileEntry.type === "application/pdf" ? ".pdf" : "");
      const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}${ext && !safeName.endsWith(ext) ? ext : ""}`;
      const uploadDir = path.join(process.cwd(), "storage", "payments", classId, session.studentId, monthKey);
      await mkdir(uploadDir, { recursive: true });
      const fullFilePath = path.join(uploadDir, storedName);
      await writeFile(fullFilePath, bytes);

      storedFileMeta = {
        fileName: fileEntry.name || "payment-proof",
        fileUrl: `payments/${classId}/${session.studentId}/${monthKey}/${storedName}`,
        mimeType: fileEntry.type,
        sizeBytes: fileEntry.size,
      };
    }

    const existing = await prisma.classPayment.findUnique({
      where: {
        classId_studentId_month: {
          classId,
          studentId: session.studentId,
          month: monthKey,
        },
      },
      select: {
        id: true,
        slipFileUrl: true,
      },
    });

    const payment = await prisma.classPayment.upsert({
      where: {
        classId_studentId_month: {
          classId,
          studentId: session.studentId,
          month: monthKey,
        },
      },
      create: {
        classId,
        studentId: session.studentId,
        month: monthKey,
        amount,
        note,
        ...(storedFileMeta
          ? {
              slipFileName: storedFileMeta.fileName,
              slipFileUrl: storedFileMeta.fileUrl,
              slipMimeType: storedFileMeta.mimeType,
              slipSizeBytes: storedFileMeta.sizeBytes,
            }
          : {}),
      },
      update: {
        amount,
        note,
        status: "PENDING",
        teacherFeedback: null,
        confirmedAt: null,
        confirmedByTeacherId: null,
        submittedAt: new Date(),
        ...(storedFileMeta
          ? {
              slipFileName: storedFileMeta.fileName,
              slipFileUrl: storedFileMeta.fileUrl,
              slipMimeType: storedFileMeta.mimeType,
              slipSizeBytes: storedFileMeta.sizeBytes,
            }
          : {}),
      },
      select: {
        id: true,
        classId: true,
        month: true,
        amount: true,
        status: true,
        submittedAt: true,
      },
    });

    if (storedFileMeta && existing?.slipFileUrl && existing.slipFileUrl !== storedFileMeta.fileUrl) {
      const oldPath = path.join(process.cwd(), "storage", existing.slipFileUrl);
      const root = path.join(process.cwd(), "storage");
      assertPathInBounds(oldPath, root);
      await unlink(oldPath).catch(() => undefined);
    }

    return apiSuccess({ payment }, { status: 201, message: "Payment submitted successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
