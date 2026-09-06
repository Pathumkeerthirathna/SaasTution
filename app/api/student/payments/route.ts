import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  ALLOWED_PAYMENT_PROOF_MIME_TYPES,
  MAX_PAYMENT_PROOF_SIZE_BYTES,
  sanitizeUploadFileName,
} from "@/lib/payment-validation";
import { emitStudentDataChange } from "@/lib/session-events";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertPathInBounds(resolvedPath: string, allowedRoot: string) {
  const relative = path.relative(allowedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
  }
}

type FeeState = "UNPAID" | "ACTION_NEEDED" | "IN_REVIEW" | "PAID";

// GET /api/student/payments?classId=
// Returns the logged-in student's monthly fees grouped as:
//   toPay    — nothing submitted yet, or the teacher asked for clarification
//   inReview — a slip is submitted and awaiting the teacher
//   paid     — the teacher confirmed the payment
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const { searchParams } = new URL(request.url);
    const classId = searchParams.get("classId")?.trim() || undefined;

    const fees = await prisma.classStudentFee.findMany({
      where: {
        status: 0,
        classStudent: {
          studentId: session.studentId,
          class: { status: 0 },
          ...(classId ? { classId } : {}),
        },
      },
      select: {
        id: true,
        year: true,
        month: true,
        amount: true,
        discount: true,
        lateJoinDeduct: true,
        waiverAmount: true,
        finalAmount: true,
        dueDate: true,
        classStudent: {
          select: {
            class: {
              select: { id: true, name: true, teacher: { select: { name: true } } },
            },
          },
        },
        payments: {
          orderBy: { submittedAt: "desc" },
          select: {
            id: true,
            amount: true,
            status: true,
            note: true,
            teacherFeedback: true,
            slipFileName: true,
            submittedAt: true,
            confirmedAt: true,
          },
        },
      },
    });

    const classesMap = new Map<string, string>();

    const items = fees.map((fee) => {
      const cls = fee.classStudent.class;
      classesMap.set(cls.id, cls.name);

      const confirmed = fee.payments.find((p) => p.status === "CONFIRMED") ?? null;
      const latest = fee.payments[0] ?? null;
      const active = confirmed ?? latest;

      let state: FeeState;
      if (confirmed) state = "PAID";
      else if (!latest) state = "UNPAID";
      else if (latest.status === "NEEDS_CLARIFICATION") state = "ACTION_NEEDED";
      else state = "IN_REVIEW";

      return {
        feeId: fee.id,
        classId: cls.id,
        className: cls.name,
        teacherName: cls.teacher.name,
        year: fee.year,
        month: fee.month,
        dueDate: fee.dueDate ? fee.dueDate.toISOString() : null,
        amount: fee.amount,
        discount: fee.discount,
        lateJoinDeduct: fee.lateJoinDeduct,
        waiverAmount: fee.waiverAmount,
        finalAmount: fee.finalAmount,
        state,
        payment: active
          ? {
              id: active.id,
              amount: active.amount,
              status: active.status,
              note: active.note,
              teacherFeedback: active.teacherFeedback,
              hasSlip: Boolean(active.slipFileName),
              slipFileName: active.slipFileName,
              submittedAt: active.submittedAt.toISOString(),
              confirmedAt: active.confirmedAt ? active.confirmedAt.toISOString() : null,
            }
          : null,
      };
    });

    const dueAsc = (a: (typeof items)[number], b: (typeof items)[number]) => {
      const av = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
      const bv = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
      return av - bv;
    };

    const toPay = items
      .filter((i) => i.state === "UNPAID" || i.state === "ACTION_NEEDED")
      .sort(dueAsc);
    const inReview = items.filter((i) => i.state === "IN_REVIEW").sort(dueAsc);
    const paid = items.filter((i) => i.state === "PAID").sort((a, b) => -dueAsc(a, b));

    const classes = Array.from(classesMap, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return apiSuccess({ toPay, inReview, paid, classes });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/student/payments — submit / re-submit a payment slip for one fee.
// formData: feeId (required), slip (File, required), note (optional)
export async function POST(request: Request) {
  try {
    const session = await requireStudentSession();
    const formData = await request.formData();

    const feeId = String(formData.get("feeId") ?? "").trim();
    const note = String(formData.get("note") ?? "").trim() || null;
    const fileEntry = formData.get("slip");

    if (!feeId) {
      return apiError("A fee is required.", 400, "VALIDATION_ERROR");
    }

    const fee = await prisma.classStudentFee.findFirst({
      where: {
        id: feeId,
        status: 0,
        classStudent: { studentId: session.studentId },
      },
      select: {
        id: true,
        finalAmount: true,
        classStudent: { select: { classId: true } },
        payments: {
          orderBy: { submittedAt: "desc" },
          select: { id: true, status: true, slipFileUrl: true },
        },
      },
    });

    if (!fee) {
      throw new AppError("Fee not found.", 404, "FEE_NOT_FOUND");
    }

    if (fee.payments.some((p) => p.status === "CONFIRMED")) {
      return apiError("This payment is already confirmed.", 409, "ALREADY_CONFIRMED");
    }

    if (!(fileEntry instanceof File) || fileEntry.size === 0) {
      return apiError("A payment slip file is required.", 400, "VALIDATION_ERROR");
    }

    if (!ALLOWED_PAYMENT_PROOF_MIME_TYPES.has(fileEntry.type)) {
      return apiError("Only PDF, PNG, JPG, and WEBP files are allowed.", 400, "UNSUPPORTED_FILE_TYPE");
    }

    if (fileEntry.size > MAX_PAYMENT_PROOF_SIZE_BYTES) {
      return apiError("Payment slip exceeds the 10 MB size limit.", 400, "FILE_TOO_LARGE");
    }

    const classId = fee.classStudent.classId;
    const bytes = new Uint8Array(await fileEntry.arrayBuffer());
    const safeName = sanitizeUploadFileName(fileEntry.name || "payment-slip") || "payment-slip";
    const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const uploadDir = path.join(
      process.cwd(),
      "storage",
      "payments",
      classId,
      session.studentId,
      feeId
    );
    await mkdir(uploadDir, { recursive: true });
    await writeFile(path.join(uploadDir, storedName), bytes);

    const slip = {
      slipFileName: fileEntry.name || "payment-slip",
      slipFileUrl: `payments/${classId}/${session.studentId}/${feeId}/${storedName}`,
      slipMimeType: fileEntry.type,
      slipSizeBytes: fileEntry.size,
    };

    const existing = fee.payments.find((p) => p.status !== "CONFIRMED") ?? null;

    const payment = existing
      ? await prisma.classPayment.update({
          where: { id: existing.id },
          data: {
            amount: fee.finalAmount,
            note,
            status: "PENDING",
            teacherFeedback: null,
            confirmedAt: null,
            confirmedByTeacherId: null,
            submittedAt: new Date(),
            ...slip,
          },
          select: { id: true, status: true, submittedAt: true },
        })
      : await prisma.classPayment.create({
          data: {
            classId,
            studentId: session.studentId,
            classStudentFeeId: feeId,
            amount: fee.finalAmount,
            note,
            ...slip,
          },
          select: { id: true, status: true, submittedAt: true },
        });

    if (existing?.slipFileUrl && existing.slipFileUrl !== slip.slipFileUrl) {
      const root = path.join(process.cwd(), "storage");
      const oldPath = path.join(root, existing.slipFileUrl);
      assertPathInBounds(oldPath, root);
      await unlink(oldPath).catch(() => undefined);
    }

    emitStudentDataChange({ studentId: session.studentId, classId });

    return apiSuccess({ payment }, { status: 201, message: "Payment slip submitted." });
  } catch (error) {
    return handleRouteError(error);
  }
}
