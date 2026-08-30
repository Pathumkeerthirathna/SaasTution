import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import {
  createTeacherEventType,
  getTeacherEventTypes,
} from "@/services/teacher-event-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireTeacherSession();
    const types = await getTeacherEventTypes(session.teacherId);
    return apiSuccess(types);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      name?: string;
      description?: string | null;
      color?: string | null;
    };

    const type = await createTeacherEventType(session.teacherId, {
      name: String(body.name ?? ""),
      description: body.description ?? null,
      color: body.color ?? null,
    });

    return apiSuccess(type, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
