import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

type RouteContext = {
  params: {
    teacherId: string;
  };
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    await requireAdminSession();

    const classes = await prisma.class.findMany({
      where: {
        teacherId: context.params.teacherId,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        name: true,
        description: true,
        schedule: true,
        createdAt: true,
        _count: {
          select: {
            students: true,
          },
        },
      },
    });

    return apiSuccess({
      classes: classes.map((classItem) => ({
        id: classItem.id,
        name: classItem.name,
        description: classItem.description,
        schedule: classItem.schedule,
        createdAt: classItem.createdAt,
        studentCount: classItem._count.students,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
