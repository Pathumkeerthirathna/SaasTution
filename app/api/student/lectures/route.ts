import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/student/lectures
// Query: page, limit, classId, from (date), to (date)
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get("limit") ?? "10", 10)));
    const classId = url.searchParams.get("classId") || undefined;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const skip = (page - 1) * limit;

    const enrollmentFilter = {
      class: {
        students: {
          some: {
            studentId: session.studentId,
            isActive: true,
          },
        },
      },
    };

    const where = {
      ...enrollmentFilter,
      ...(classId ? { classId } : {}),
      ...((from ?? to)
        ? {
            date: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to + "T23:59:59.999Z") } : {}),
            },
          }
        : {}),
    };

    const [total, lectures, enrolledClassStudents] = await Promise.all([
      prisma.lecture.count({ where }),
      prisma.lecture.findMany({
        where,
        orderBy: { date: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          date: true,
          class: {
            select: { id: true, name: true },
          },
          _count: {
            select: { notes: true },
          },
        },
      }),
      prisma.classStudent.findMany({
        where: {
          studentId: session.studentId,
          isActive: true,
        },
        select: {
          class: {
            select: { id: true, name: true },
          },
        },
        orderBy: { class: { name: "asc" } },
      }),
    ]);

    return apiSuccess({
      lectures: lectures.map((l) => ({
        id: l.id,
        title: l.title,
        date: l.date,
        className: l.class.name,
        classId: l.class.id,
        noteCount: l._count.notes,
      })),
      enrolledClasses: enrolledClassStudents.map((cs) => ({
        id: cs.class.id,
        name: cs.class.name,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
