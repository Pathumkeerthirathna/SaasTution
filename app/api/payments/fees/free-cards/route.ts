import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { parseFreeCardRequest, setFreeCards } from "@/services/class-student-fee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/payments/fees/free-cards: issue or revoke teacher Free Cards on
 * fees of one class and month.
 * Body: { classId, year, month, feeIds: string[], action: "issue" | "revoke" }.
 * Returns the processed and skipped fees (with reasons) and the refreshed
 * fee sheet.
 */
export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("Invalid request body.", 400, "VALIDATION_ERROR");
    }

    const input = parseFreeCardRequest(body);
    const result = await setFreeCards({ teacherId: session.teacherId, ...input });

    const verb = input.action === "issue" ? "issued" : "revoked";
    const message =
      result.processed.length === 0
        ? `No Free Card was ${verb}.`
        : `${result.processed.length} Free Card${result.processed.length === 1 ? "" : "s"} ${verb}.`;

    return apiSuccess(result, { message });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
