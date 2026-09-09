import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireGuardianStudentAccess } from "@/lib/guardian-portal-guard";
import { getPaymentDueStatus } from "@/lib/payment-validation";
import { getStudentPaymentSummary } from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: { studentId: string } }
) {
  try {
    const { studentId } = await requireGuardianStudentAccess(
      context.params.studentId
    );

    const { searchParams } = new URL(request.url);
    const year = Number(searchParams.get("year")) || null;
    const month = Number(searchParams.get("month")) || null;
    const classId = searchParams.get("classId") || null;

    const data = await getStudentPaymentSummary(studentId);
    const now = new Date();

    // Filter + enrich each fee with a due status for the "Due" / "Due soon" badges.
    const classes = data.classes
      .filter((cls) => !classId || cls.classId === classId)
      .map((cls) => ({
        ...cls,
        fees: cls.fees
          .filter((fee) => !year || fee.year === year)
          .filter((fee) => !month || fee.month === month)
          .map((fee) => ({
            ...fee,
            dueStatus:
              fee.paid || !fee.dueDate
                ? null
                : getPaymentDueStatus(new Date(fee.dueDate), now),
          })),
      }))
      .filter((cls) => cls.fees.length > 0);

    const years = Array.from(
      new Set(data.classes.flatMap((c) => c.fees.map((f) => f.year)))
    ).sort((a, b) => b - a);

    return apiSuccess({ summary: data.summary, classes, years });
  } catch (error) {
    return handleRouteError(error);
  }
}
