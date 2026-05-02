import { cookies } from "next/headers";

import { apiError, apiSuccess } from "@/lib/api-response";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

const ADMIN_ID = "admin-pathum";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const token = cookies().get(AUTH_COOKIE_NAME)?.value;

    if (!token) {
      return apiError("Authentication required.", 401, "UNAUTHORIZED");
    }

    const session = await verifyAuthToken(token);

    if (!session) {
      return apiError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    }

    if (session.role === "ADMIN" && session.sub === ADMIN_ID) {
      return apiSuccess({
        user: {
          id: session.sub,
          name: session.name,
          email: session.email,
          role: session.role,
        },
      });
    }

    if (session.role !== "TEACHER") {
      return apiError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    }

    const teacher = await prisma.teacher.findUnique({
      where: { id: session.sub },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
      },
    });

    if (!teacher) {
      return apiError("Teacher account not found.", 404, "TEACHER_NOT_FOUND");
    }

    return apiSuccess({
      user: {
        ...teacher,
        role: session.role,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
