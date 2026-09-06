import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { subscribeLiveChanges, subscribeStudentDataChanges } from "@/lib/session-events";
import {
  getTeacherClassIds,
  getTeacherLiveBroadcasts,
  getTeacherLiveSessions,
} from "@/services/student-live-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// GET /api/teacher/live/stream
// Server-Sent Events for the teacher dashboard. Pushes the teacher's live view
// (Jitsi sessions + YouTube broadcasts across their own classes) on connect and
// again whenever it changes, and signals `counts-stale` whenever coursework
// data for one of the teacher's classes (or a student in one) changes — driven
// by the same in-process live-change bus the student stream uses, not polling.
export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const teacherId = session.teacherId;
    const classIds = new Set(await getTeacherClassIds(teacherId));

    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (event: string, payload: unknown) => {
          if (!closed) controller.enqueue(encoder.encode(sse(event, payload)));
        };

        // Initial authoritative snapshot.
        try {
          const [sessions, broadcasts] = await Promise.all([
            getTeacherLiveSessions(teacherId),
            getTeacherLiveBroadcasts(teacherId),
          ]);
          send("sessions", { sessions });
          send("broadcasts", { broadcasts });
        } catch {
          send("sessions", { sessions: [] });
        }

        let refreshing = false;
        const unsubscribe = subscribeLiveChanges((payload) => {
          if (!classIds.has(payload.classId)) return;
          if (refreshing) return;
          refreshing = true;

          void (async () => {
            try {
              if (payload.kind === "jitsi") {
                send("sessions", { sessions: await getTeacherLiveSessions(teacherId) });
              } else {
                send("broadcasts", { broadcasts: await getTeacherLiveBroadcasts(teacherId) });
              }
            } catch {
              /* leave the client on its last snapshot */
            } finally {
              refreshing = false;
            }
          })();
        });

        // Dashboard-count invalidation: tell the client to re-pull its data
        // (metrics, schedule, coursework) whenever something changes for one
        // of the teacher's own classes or a student enrolled in one.
        const unsubscribeCounts = subscribeStudentDataChanges((payload) => {
          if (payload.classId && classIds.has(payload.classId)) {
            send("counts-stale", { at: payload.occurredAt });
          }
        });

        // SSE keep-alive comment (not data; stops proxies closing the stream).
        const keepAlive = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
        }, 15_000);

        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          unsubscribe();
          unsubscribeCounts();
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
