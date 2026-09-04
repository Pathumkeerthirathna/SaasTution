import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type FeeState = "UNPAID" | "ACTION_NEEDED" | "IN_REVIEW";

function feeState(payments: { status: string }[]): FeeState {
  const latest = payments[0] ?? null;
  if (!latest) return "UNPAID";
  if (latest.status === "NEEDS_CLARIFICATION") return "ACTION_NEEDED";
  return "IN_REVIEW";
}

// GET /api/student/dashboard/payments
// The student's unpaid monthly fees split into:
//   due     — the due date is now or past
//   dueSoon — the due date is still ahead but falls within the current month
// Fees due in a later month are not returned.
export async function GET() {
  try {
    const session = await requireStudentSession();
    const studentId = session.studentId;

    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const rows = await prisma.classStudentFee.findMany({
      where: {
        status: 0,
        classStudent: { studentId, class: { status: 0 } },
        payments: { none: { status: "CONFIRMED" } },
        dueDate: { not: null, lte: endOfMonth },
      },
      orderBy: { dueDate: "asc" },
      select: {
        id: true,
        year: true,
        month: true,
        finalAmount: true,
        dueDate: true,
        classStudent: { select: { class: { select: { id: true, name: true } } } },
        payments: {
          orderBy: { submittedAt: "desc" },
          select: { status: true },
        },
      },
    });

    const mapFee = (fee: (typeof rows)[number]) => ({
      feeId: fee.id,
      classId: fee.classStudent.class.id,
      className: fee.classStudent.class.name,
      year: fee.year,
      month: fee.month,
      finalAmount: fee.finalAmount,
      dueDate: fee.dueDate ? fee.dueDate.toISOString() : null,
      state: feeState(fee.payments),
    });

    const due = rows
      .filter((f) => f.dueDate && f.dueDate.getTime() <= now.getTime())
      .map(mapFee);
    const dueSoon = rows
      .filter((f) => f.dueDate && f.dueDate.getTime() > now.getTime())
      .map(mapFee);

    const sum = (list: { finalAmount: number }[]) =>
      list.reduce((total, f) => total + f.finalAmount, 0);

    return apiSuccess({
      due,
      dueSoon,
      dueTotal: sum(due),
      dueSoonTotal: sum(dueSoon),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
