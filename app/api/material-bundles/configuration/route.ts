import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { teacherPaperConfigSchema } from "@/lib/material-bundle-validation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DEFAULT_COUNTDOWN_MINUTES = 30;
const DEFAULT_GRACE_MINUTES = 20;

export async function GET() {
  try {
    const session = await requireTeacherSession();

    const config = await prisma.teacherPaperConfig.findUnique({
      where: { teacherId: session.teacherId },
      select: {
        countdownLeadMinutes: true,
        submissionGraceMinutes: true,
      },
    });

    return apiSuccess({
      countdownLeadMinutes: config?.countdownLeadMinutes ?? DEFAULT_COUNTDOWN_MINUTES,
      submissionGraceMinutes: config?.submissionGraceMinutes ?? DEFAULT_GRACE_MINUTES,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      countdownLeadMinutes?: number;
      submissionGraceMinutes?: number;
    };

    const parsed = teacherPaperConfigSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid configuration payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const config = await prisma.teacherPaperConfig.upsert({
      where: { teacherId: session.teacherId },
      create: {
        teacherId: session.teacherId,
        countdownLeadMinutes: parsed.data.countdownLeadMinutes,
        submissionGraceMinutes: parsed.data.submissionGraceMinutes,
      },
      update: {
        countdownLeadMinutes: parsed.data.countdownLeadMinutes,
        submissionGraceMinutes: parsed.data.submissionGraceMinutes,
      },
      select: {
        countdownLeadMinutes: true,
        submissionGraceMinutes: true,
      },
    });

    return apiSuccess(config, { message: "Paper configuration updated successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
