import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  getCurrentMonthKey,
  getPaymentDueDate,
  getPaymentDueStatus,
  getPaymentWeekLabel,
  isValidMonthKey,
} from "@/lib/payment-validation";
import { prisma } from "@/lib/prisma";
import { nowInSriLanka } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id;

    if (!classId?.trim()) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    const { searchParams } = new URL(request.url);
    const month = (searchParams.get("month")?.trim() || getCurrentMonthKey());

    if (!isValidMonthKey(month)) {
      return apiError("Month must be in YYYY-MM format.", 400, "VALIDATION_ERROR");
    }

    const classItem = await prisma.class.findFirst({
      where: {
        id: classId,
        teacherId: session.teacherId,
        status: 0,
      },
      select: {
        id: true,
        name: true,
        monthlyFee: true,
        paymentDueWeek: true,
      },
    });

    if (!classItem) {
      throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
    }

    const payments = await prisma.classPayment.findMany({
      where: {
        classId,
        month,
      },
      orderBy: {
        submittedAt: "desc",
      },
      select: {
        id: true,
        month: true,
        amount: true,
        note: true,
        status: true,
        teacherFeedback: true,
        submittedAt: true,
        confirmedAt: true,
        slipFileName: true,
        student: {
          select: {
            id: true,
            name: true,
            registrationNumber: true,
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
              select: { name: true },
            },
            student: {
              select: { name: true },
            },
          },
        },
      },
    });

    const [yearPart, monthPart] = month.split("-").map((value) => Number(value));
    const periodStart = new Date(Date.UTC(yearPart, monthPart - 1, 1, 0, 0, 0, 0));
    const periodEnd = new Date(Date.UTC(yearPart, monthPart, 0, 23, 59, 59, 999));

    const enrolledStudents = await prisma.classStudent.findMany({
      where: {
        classId,
        assignedAt: {
          lte: periodEnd,
        },
        OR: [
          {
            removedAt: null,
          },
          {
            removedAt: {
              gte: periodStart,
            },
          },
        ],
      },
      distinct: ["studentId"],
      select: {
        studentId: true,
        student: {
          select: {
            id: true,
            name: true,
            registrationNumber: true,
          },
        },
      },
    });

    const paidStudentIds = new Set(payments.map((payment) => payment.student.id));
    const defaulters = enrolledStudents
      .filter((entry) => !paidStudentIds.has(entry.studentId))
      .map((entry) => entry.student);

    const submittedCount = payments.length;
    const confirmedCount = payments.filter((payment) => payment.status === "CONFIRMED").length;
    const pendingCount = payments.filter((payment) => payment.status === "PENDING").length;
    const clarificationCount = payments.filter((payment) => payment.status === "NEEDS_CLARIFICATION").length;
    const submittedAmount = payments.reduce((sum, payment) => sum + payment.amount, 0);
    const confirmedAmount = payments
      .filter((payment) => payment.status === "CONFIRMED")
      .reduce((sum, payment) => sum + payment.amount, 0);
    const expectedAmount = enrolledStudents.length * classItem.monthlyFee;
    const dueDate = getPaymentDueDate(month, classItem.paymentDueWeek as 1 | 2 | 3 | 4);
    const now = nowInSriLanka();
    const dueStatus = getPaymentDueStatus(dueDate, now);

    return apiSuccess({
      class: classItem,
      month,
      summary: {
        dueWeek: classItem.paymentDueWeek,
        dueWeekLabel: getPaymentWeekLabel(classItem.paymentDueWeek as 1 | 2 | 3 | 4),
        dueDate: dueDate.toISOString(),
        isPastDue: dueStatus === "OVERDUE",
        isDueSoon: dueStatus === "DUE_SOON",
        enrolledCount: enrolledStudents.length,
        submittedCount,
        confirmedCount,
        pendingCount,
        clarificationCount,
        defaulterCount: defaulters.length,
        expectedAmount,
        submittedAmount,
        confirmedAmount,
      },
      defaulters,
      payments: payments.map((payment) => ({
        ...payment,
        hasSlip: Boolean(payment.slipFileName),
        messages: payment.messages.map((msg) => ({
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
