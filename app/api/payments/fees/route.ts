import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  getMonthlyFeeSheet,
  reprocessMonthlyFees,
  setMonthlyFeeAmount,
} from "@/services/class-student-fee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();

    const { searchParams } = new URL(request.url);
    const classId = searchParams.get("classId")?.trim();
    const year = Number(searchParams.get("year"));
    const month = Number(searchParams.get("month"));

    if (!classId) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    const sheet = await getMonthlyFeeSheet({
      teacherId: session.teacherId,
      classId,
      year,
      month,
    });

    return apiSuccess(sheet);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();

    const body = (await request.json()) as {
      classId?: string;
      year?: unknown;
      month?: unknown;
    };

    if (!body.classId?.trim()) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    const sheet = await reprocessMonthlyFees({
      teacherId: session.teacherId,
      classId: body.classId,
      year: Number(body.year),
      month: Number(body.month),
    });

    return apiSuccess(sheet);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireTeacherSession();

    const body = (await request.json()) as {
      classId?: string;
      year?: unknown;
      month?: unknown;
      amount?: unknown;
      applyToAll?: unknown;
      feeId?: string;
    };

    if (!body.classId?.trim()) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    const sheet = await setMonthlyFeeAmount({
      teacherId: session.teacherId,
      classId: body.classId,
      year: Number(body.year),
      month: Number(body.month),
      amount: Number(body.amount),
      applyToAll: body.applyToAll === true,
      feeId: body.feeId,
    });

    return apiSuccess(sheet);
  } catch (error) {
    return handleRouteError(error);
  }
}
