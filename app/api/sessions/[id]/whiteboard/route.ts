import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession, requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { sanitizeWhiteboardScene } from "@/lib/whiteboard-data";
import {
  getLatestWhiteboardScene,
  publishWhiteboardScene,
  subscribeWhiteboardScene,
} from "@/lib/whiteboard-events";
import {
  assertStudentCanWatchWhiteboard,
  assertTeacherCanBroadcastWhiteboard,
} from "@/services/lecture-whiteboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSseChunk(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// POST /api/sessions/[id]/whiteboard
// Teacher only. Broadcasts the current scene to the students in the session.
// Nothing is written to the database here; saving is a separate, explicit action.
export async function POST(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const teacherSession = await requireTeacherSession();
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    await assertTeacherCanBroadcastWhiteboard(teacherSession.teacherId, sessionId);

    const body = (await request.json().catch(() => null)) as { scene?: unknown } | null;

    if (!body || body.scene === undefined) {
      return apiError("Whiteboard scene is required.", 400, "VALIDATION_ERROR");
    }

    publishWhiteboardScene(sessionId, sanitizeWhiteboardScene(body.scene));

    return apiSuccess({ published: true });
  } catch (error) {
    return handleRouteError(error);
  }
}

// GET /api/sessions/[id]/whiteboard?role=student|teacher
// Server-Sent Events: sends the latest scene on connect, then every change.
export async function GET(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const role = new URL(request.url).searchParams.get("role");

    if (role === "teacher") {
      const teacherSession = await requireTeacherSession();
      await assertTeacherCanBroadcastWhiteboard(teacherSession.teacherId, sessionId);
    } else {
      const studentSession = await requireStudentSession();
      await assertStudentCanWatchWhiteboard(studentSession.studentId, sessionId);
    }

    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const send = (event: string, payload: unknown) => {
          if (closed) {
            return;
          }

          controller.enqueue(encoder.encode(toSseChunk(event, payload)));
        };

        send("connected", { sessionId, timestamp: new Date().toISOString() });

        const latest = getLatestWhiteboardScene(sessionId);

        if (latest) {
          send("scene", latest);
        }

        const unsubscribe = subscribeWhiteboardScene(sessionId, (payload) => {
          send("scene", payload);
        });

        const keepAliveIntervalId = setInterval(() => {
          send("ping", { timestamp: new Date().toISOString() });
        }, 15_000);

        cleanup = () => {
          if (closed) {
            return;
          }

          closed = true;
          clearInterval(keepAliveIntervalId);
          unsubscribe();
          request.signal.removeEventListener("abort", cleanup);
          controller.close();
        };

        request.signal.addEventListener("abort", cleanup);
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
