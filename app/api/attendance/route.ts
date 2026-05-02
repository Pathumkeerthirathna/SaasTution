import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { attendanceCreateSchema, attendanceListQuerySchema } from "@/lib/attendance-validation";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { emitSessionAttendanceEvent } from "@/lib/session-events";
import { listAttendanceByClassForTeacher, markAttendanceOnJoin } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionId?: string;
      classId?: string;
      studentId?: string;
    };

    const parsed = attendanceCreateSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const result = await markAttendanceOnJoin({
      sessionId: parsed.data.sessionId,
      classId: parsed.data.classId,
      studentId: parsed.data.studentId,
    });

    emitSessionAttendanceEvent({
      sessionId: parsed.data.sessionId,
      attendanceId: result.attendance.id,
      studentId: result.attendance.studentId,
      joinedAt: result.attendance.joinedAt.toISOString(),
      leftAt: result.attendance.leftAt ? result.attendance.leftAt.toISOString() : null,
      event: "joined",
      occurredAt: new Date().toISOString(),
    });

    return apiSuccess(result, {
      message: result.duplicate
        ? "Attendance already existed for this session; duplicate prevented."
        : "Attendance marked successfully.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function GET(request: Request) {
  try {
    const teacherSession = await requireTeacherSession();
    const { searchParams } = new URL(request.url);
    const classId = searchParams.get("classId")?.trim();

    const parsedClassId = attendanceListQuerySchema.safeParse({ classId });

    if (!parsedClassId.success) {
      const firstIssue = parsedClassId.error.issues[0]?.message ?? "classId query parameter is required.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsedClassId.error.flatten());
    }

    const pagination = parsePaginationParams(searchParams);

    const result = await listAttendanceByClassForTeacher({
      teacherId: teacherSession.teacherId,
      classId: parsedClassId.data.classId,
      skip: pagination.skip,
      take: pagination.take,
    });

    return apiSuccess(
      {
        class: result.class,
        records: result.records,
      },
      {
        pagination: buildPaginationMeta(result.totalItems, pagination.page, pagination.pageSize),
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
