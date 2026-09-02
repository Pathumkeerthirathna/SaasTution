import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { subscribeLiveChanges, subscribeStudentDataChanges } from "@/lib/session-events";
import {
  getStudentClassIds,
  getStudentLiveBroadcasts,
  getStudentLiveSessions,
} from "@/services/student-live-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// GET /api/student/live/stream
// Server-Sent Events. Pushes the student's live view (Jitsi sessions + YouTube
// broadcasts) on connect and again whenever a teacher starts/ends one — driven
// by the in-process live-change bus, not polling.
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const studentId = session.studentId;
    const classIds = new Set(await getStudentClassIds(studentId));

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
            getStudentLiveSessions(studentId),
            getStudentLiveBroadcasts(studentId),
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
                send("sessions", { sessions: await getStudentLiveSessions(studentId) });
              } else {
                send("broadcasts", { broadcasts: await getStudentLiveBroadcasts(studentId) });
              }
            } catch {
              /* leave the client on its last snapshot */
            } finally {
              refreshing = false;
            }
          })();
        });

        // Dashboard-count invalidation: tell the client to re-pull its counts
        // (with whatever range it currently has selected) when relevant data
        // changes for this student or one of their classes.
        const unsubscribeCounts = subscribeStudentDataChanges((payload) => {
          if (payload.studentId === studentId || (payload.classId && classIds.has(payload.classId))) {
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
