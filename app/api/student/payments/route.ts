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
import { feePaymentState } from "@/lib/fee-payment-state";
import { ensureCurrentMonthFeeForClassStudent, isLockContention } from "@/services/class-student-fee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertPathInBounds(resolvedPath: string, allowedRoot: string) {
  const relative = path.relative(allowedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
  }
}

const FREE_CARD_SUBMIT_MESSAGE =
  "Your teacher has given you a Free Card for this month, so there is nothing to pay.";

type FeeState = "UNPAID" | "PARTIAL" | "ACTION_NEEDED" | "IN_REVIEW" | "PAID" | "FREE_CARD";

// GET /api/student/payments?classId=
// Returns the logged-in student's monthly fees grouped as:
//   toPay    — nothing submitted yet, or the teacher asked for clarification
//   inReview — a slip is submitted and awaiting the teacher
//   paid     — the teacher confirmed the payment, or issued a Free Card
//              (state FREE_CARD: settled, nothing to pay or upload)
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const { searchParams } = new URL(request.url);
    const classId = searchParams.get("classId")?.trim() || undefined;

    // Defensive backfill: a ClassStudent normally gets its current-month fee
    // row created the moment it's assigned (see assignStudentToClass /
    // registerStudentForPublicClass in services/student-service.ts). This
    // covers any ClassStudent that predates that, or was created by some
    // other path — scoped to only this authenticated student's own active
    // memberships, never anyone else's. Reuses the exact same single-row
    // helper those flows call; it no-ops if the fee already exists.
    const activeClassStudents = await prisma.classStudent.findMany({
      where: {
        studentId: session.studentId,
        isActive: true,
        class: { status: 0 },
        ...(classId ? { classId } : {}),
      },
      select: { id: true },
    });

    await Promise.all(
      activeClassStudents.map((entry) =>
        ensureCurrentMonthFeeForClassStudent(prisma, entry.id)
      )
    );

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
        freeCard: true,
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
            reversal: { select: { amount: true } },
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

      const confirmed = fee.payments.find((p) => p.status === "CONFIRMED" && !p.reversal) ?? null;
      const latest = fee.payments[0] ?? null;
      const active = confirmed ?? latest;
      // The shared calculation (lib/fee-payment-state.ts): paid only when the
      // whole fee is received; a partly paid fee stays to pay.
      const position = feePaymentState(fee, fee.payments);
      const awaiting = fee.payments.find((p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION") ?? null;

      let state: FeeState;
      if (position.state === "PAID") state = "PAID";
      else if (position.state === "FREE_CARD") state = "FREE_CARD";
      else if (awaiting?.status === "NEEDS_CLARIFICATION") state = "ACTION_NEEDED";
      else if (awaiting) state = "IN_REVIEW";
      else if (position.state === "PARTIAL") state = "PARTIAL";
      else state = "UNPAID";

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
        freeCard: fee.freeCard,
        /** Received so far (confirmed, not reversed) and still payable. */
        paidAmount: position.confirmedTotal,
        outstanding: position.outstanding,
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
      .filter((i) => i.state === "UNPAID" || i.state === "PARTIAL" || i.state === "ACTION_NEEDED")
      .sort(dueAsc);
    const inReview = items.filter((i) => i.state === "IN_REVIEW").sort(dueAsc);
    const paid = items
      .filter((i) => i.state === "PAID" || i.state === "FREE_CARD")
      .sort((a, b) => -dueAsc(a, b));

    const classes = Array.from(classesMap, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return apiSuccess({ toPay, inReview, paid, classes });
  } catch (error) {
    return handleRouteError(error, { request });
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
        freeCard: true,
        classStudent: { select: { classId: true } },
        payments: {
          orderBy: { submittedAt: "desc" },
          select: { id: true, status: true, slipFileUrl: true, amount: true, reversal: { select: { amount: true } } },
        },
      },
    });

    if (!fee) {
      throw new AppError("Fee not found.", 404, "FEE_NOT_FOUND");
    }

    if (fee.freeCard) {
      return apiError(FREE_CARD_SUBMIT_MESSAGE, 409, "FREE_CARD_ACTIVE");
    }

    // Partial payments: a slip is for what is still outstanding after the
    // confirmed (not reversed) payments; a fully paid fee takes no slip.
    if (feePaymentState(fee, fee.payments).outstanding <= 0) {
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

    // The payment write holds the fee row (FOR UPDATE), the same lock a
    // teacher's Free Card issue, a recorded payment and a slip confirmation
    // take: the fee and its payments are re-read under it, so a card issued,
    // a payment recorded or a slip confirmed meanwhile is seen here (the slip
    // is refused, or made for what is still outstanding), never missed.
    let payment;
    let replaced: { slipFileUrl: string | null } | null = null;
    try {
      payment = await prisma.$transaction(async (tx) => {
        // The same 3-second wait the other payment operations allow.
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3000ms'");
        await tx.$queryRaw`SELECT "id" FROM "ClassStudentFee" WHERE "id" = ${feeId} FOR UPDATE`;
        const locked = await tx.classStudentFee.findUnique({
          where: { id: feeId },
          select: {
            finalAmount: true,
            freeCard: true,
            payments: {
              orderBy: { submittedAt: "desc" },
              select: { id: true, status: true, slipFileUrl: true, amount: true, reversal: { select: { amount: true } } },
            },
          },
        });
        if (!locked || locked.freeCard) {
          throw new AppError(FREE_CARD_SUBMIT_MESSAGE, 409, "FREE_CARD_ACTIVE");
        }
        const outstanding = feePaymentState(locked, locked.payments).outstanding;
        if (outstanding <= 0) {
          throw new AppError("This payment is already confirmed.", 409, "ALREADY_CONFIRMED");
        }
        // The slip awaiting processing is reused (as before); never a confirmed payment.
        const existing = locked.payments.find((p) => p.status !== "CONFIRMED") ?? null;
        replaced = existing;

        return existing
          ? tx.classPayment.update({
              where: { id: existing.id },
              data: {
                amount: outstanding,
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
          : tx.classPayment.create({
              data: {
                classId,
                studentId: session.studentId,
                classStudentFeeId: feeId,
                amount: outstanding,
                note,
                ...slip,
              },
              select: { id: true, status: true, submittedAt: true },
            });
      });
    } catch (error) {
      // Nothing was recorded: drop the slip file just written.
      await unlink(path.join(uploadDir, storedName)).catch(() => undefined);
      // The fee row was held by another payment operation (lock timeout,
      // deadlock or transaction timeout): the transaction rolled back.
      if (isLockContention(error)) {
        throw new AppError("This fee is being changed by another request. Please try again.", 409, "PAYMENT_BUSY");
      }
      throw error;
    }

    const previous = replaced as { slipFileUrl: string | null } | null;
    if (previous?.slipFileUrl && previous.slipFileUrl !== slip.slipFileUrl) {
      const root = path.join(process.cwd(), "storage");
      const oldPath = path.join(root, previous.slipFileUrl);
      assertPathInBounds(oldPath, root);
      await unlink(oldPath).catch(() => undefined);
    }

    emitStudentDataChange({ studentId: session.studentId, classId });

    return apiSuccess({ payment }, { status: 201, message: "Payment slip submitted." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
