import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { emitStudentDataChange } from "@/lib/session-events";
import { prisma } from "@/lib/prisma";

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
      },
    });

    if (!payment) {
      throw new AppError("Payment not found.", 404, "PAYMENT_NOT_FOUND");
    }

    const updated = await prisma.$transaction(async (tx) => {
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
    });

    emitStudentDataChange({ studentId: payment.studentId });

    return apiSuccess({ payment: updated }, { message: status === "CONFIRMED" ? "Payment confirmed." : "Clarification requested." });
  } catch (error) {
    return handleRouteError(error);
  }
}
