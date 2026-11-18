import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { feePaymentState, PAYMENT_STATE_SELECT } from "@/lib/fee-payment-state";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type FeeState = "UNPAID" | "ACTION_NEEDED" | "IN_REVIEW";

/** From the submission awaiting processing (payments newest first); else still to pay. */
function feeState(payments: { status: string }[]): FeeState {
  const awaiting = payments.find((p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION");
  if (!awaiting) return "UNPAID";
  if (awaiting.status === "NEEDS_CLARIFICATION") return "ACTION_NEEDED";
  return "IN_REVIEW";
}

// GET /api/student/dashboard/payments
// The student's monthly fees with an outstanding amount (the shared
// calculation, lib/fee-payment-state.ts: a partly paid fee is still due for
// the rest; a fully paid or Free Card fee never is), split into:
//   due     — the due date is now or past
//   dueSoon — the due date is still ahead but falls within the current month
// Fees due in a later month are not returned. Amounts are what is outstanding.
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const studentId = session.studentId;

    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const candidates = await prisma.classStudentFee.findMany({
      where: {
        status: 0,
        // A teacher-issued Free Card settles the fee: never due.
        freeCard: false,
        classStudent: { studentId, class: { status: 0 } },
        dueDate: { not: null, lte: endOfMonth },
      },
      orderBy: { dueDate: "asc" },
      select: {
        id: true,
        year: true,
        month: true,
        finalAmount: true,
        freeCard: true,
        dueDate: true,
        classStudent: { select: { class: { select: { id: true, name: true } } } },
        payments: {
          orderBy: { submittedAt: "desc" },
          select: PAYMENT_STATE_SELECT,
        },
      },
    });

    const rows = candidates
      .map((fee) => ({ fee, outstanding: feePaymentState(fee, fee.payments).outstanding }))
      .filter((entry) => entry.outstanding > 0);

    const mapFee = ({ fee, outstanding }: (typeof rows)[number]) => ({
      feeId: fee.id,
      classId: fee.classStudent.class.id,
      className: fee.classStudent.class.name,
      year: fee.year,
      month: fee.month,
      finalAmount: fee.finalAmount,
      outstanding,
      dueDate: fee.dueDate ? fee.dueDate.toISOString() : null,
      state: feeState(fee.payments),
    });

    const due = rows
      .filter(({ fee }) => fee.dueDate && fee.dueDate.getTime() <= now.getTime())
      .map(mapFee);
    const dueSoon = rows
      .filter(({ fee }) => fee.dueDate && fee.dueDate.getTime() > now.getTime())
      .map(mapFee);

    const sum = (list: { outstanding: number }[]) =>
      list.reduce((total, f) => total + f.outstanding, 0);

    return apiSuccess({
      due,
      dueSoon,
      dueTotal: sum(due),
      dueSoonTotal: sum(dueSoon),
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
