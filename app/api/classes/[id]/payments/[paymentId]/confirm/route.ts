import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { emitStudentDataChange } from "@/lib/session-events";
import { feePaymentState, PAYMENT_STATE_SELECT } from "@/lib/fee-payment-state";
import { prisma } from "@/lib/prisma";
import { isLockContention } from "@/services/class-student-fee-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: { id: string; paymentId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id;
    const paymentId = context.params.paymentId;

    if (!classId?.trim() || !paymentId?.trim()) {
      return apiError("Class id and payment id are required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      status?: "CONFIRMED" | "NEEDS_CLARIFICATION";
      feedback?: string;
    };

    const status = body.status;
    const feedback = body.feedback?.trim() || "";

    if (status !== "CONFIRMED" && status !== "NEEDS_CLARIFICATION") {
      return apiError("Invalid confirmation status.", 400, "VALIDATION_ERROR");
    }

    if (status === "NEEDS_CLARIFICATION" && !feedback) {
      return apiError("Feedback is required when requesting clarification.", 400, "VALIDATION_ERROR");
    }

    const payment = await prisma.classPayment.findFirst({
      where: {
        id: paymentId,
        classId,
        class: {
          teacherId: session.teacherId,
        },
      },
      select: {
        id: true,
        studentId: true,
        source: true,
        status: true,
        amount: true,
        classStudentFeeId: true,
      },
    });

    if (!payment) {
      throw new AppError("Payment not found.", 404, "PAYMENT_NOT_FOUND");
    }

    // Partial payments: this is the student-slip workflow; a payment the
    // teacher recorded is already confirmed and is corrected by a reversal.
    if (payment.source === "TEACHER_RECORDED") {
      throw new AppError(
        "This payment was recorded by the teacher, so the payment slip review does not apply to it.",
        409,
        "PAYMENT_NOT_A_SLIP"
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Confirming adds received money: under the fee-row lock (the lock the
      // upload, recording and Free Card issue take), never beyond what is
      // still outstanding. Re-confirming an already confirmed slip changes no
      // money and is left as before.
      if (status === "CONFIRMED" && payment.status !== "CONFIRMED") {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3000ms'");
        await tx.$queryRaw`SELECT "id" FROM "ClassStudentFee" WHERE "id" = ${payment.classStudentFeeId} FOR UPDATE`;
        const fee = await tx.classStudentFee.findUnique({
          where: { id: payment.classStudentFeeId },
          select: { finalAmount: true, freeCard: true, payments: { select: { id: true, ...PAYMENT_STATE_SELECT } } },
        });
        const outstanding = fee ? feePaymentState(fee, fee.payments).outstanding : 0;
        const current = fee?.payments.find((p) => p.id === paymentId);
        if (!current || current.status === "CONFIRMED") {
          throw new AppError("This payment changed meanwhile. Reload and try again.", 409, "PAYMENT_CHANGED");
        }
        if (current.amount > outstanding) {
          throw new AppError(
            `Confirming Rs. ${current.amount.toLocaleString()} would exceed the outstanding Rs. ${outstanding.toLocaleString()} for this fee.`,
            409,
            "AMOUNT_EXCEEDS_OUTSTANDING",
            { outstanding }
          );
        }
      }

      const paymentUpdate = await tx.classPayment.update({
        where: {
          id: paymentId,
        },
        data:
          status === "CONFIRMED"
            ? {
                status: "CONFIRMED",
                teacherFeedback: null,
                confirmedAt: new Date(),
                confirmedByTeacherId: session.teacherId,
              }
            : {
                status: "NEEDS_CLARIFICATION",
                teacherFeedback: feedback,
                confirmedAt: null,
                confirmedByTeacherId: null,
              },
        select: {
          id: true,
          status: true,
          teacherFeedback: true,
          confirmedAt: true,
        },
      });

      if (status === "NEEDS_CLARIFICATION") {
        await tx.paymentMessage.create({
          data: {
            paymentId,
            senderRole: "TEACHER",
            teacherId: session.teacherId,
            message: feedback,
          },
        });
      }

      return paymentUpdate;
    }).catch((error: unknown) => {
      // The fee row was held by another payment operation (lock timeout,
      // deadlock or transaction timeout): nothing was changed.
      if (isLockContention(error)) {
        throw new AppError("This fee is being changed by another request. Please try again.", 409, "PAYMENT_BUSY");
      }
      throw error;
    });

    emitStudentDataChange({ studentId: payment.studentId, classId });

    return apiSuccess({ payment: updated }, { message: status === "CONFIRMED" ? "Payment confirmed." : "Clarification requested." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
