import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { subscribeSessionAttendanceEvents } from "@/lib/session-events";
import { ensureSessionAccessForTeacher } from "@/services/session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSseChunk(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const teacherSession = await requireTeacherSession();
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    await ensureSessionAccessForTeacher(teacherSession.teacherId, sessionId);

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

        send("connected", {
          sessionId,
          timestamp: new Date().toISOString(),
        });

        const unsubscribe = subscribeSessionAttendanceEvents(sessionId, (payload) => {
          send("attendance-update", payload);
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
