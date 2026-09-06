import { requireStudentSession, requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { subscribeLiveChanges } from "@/lib/session-events";
import { YouTubeBroadcastStatus } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSseChunk(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

type LiveStatusPayload = {
  isLive: boolean;
  youtubeUrl: string | null;
};

async function getLiveSnapshot(
  lectureId: string | null
): Promise<LiveStatusPayload> {
  if (!lectureId) {
    return { isLive: false, youtubeUrl: null };
  }

  const liveBroadcast = await prisma.youTubeLiveBroadcast.findFirst({
    where: {
      lectureId,
      status: {
        in: [YouTubeBroadcastStatus.READY, YouTubeBroadcastStatus.LIVE],
      },
    },
    orderBy: { createdAt: "desc" },
    select: { youtubeUrl: true },
  });

  return {
    isLive: Boolean(liveBroadcast),
    youtubeUrl: liveBroadcast?.youtubeUrl ?? null,
  };
}

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const { searchParams } = new URL(request.url);
    const role = searchParams.get("role")?.trim();

    const classSession = await prisma.classSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        classId: true,
        lectureId: true,
        class: { select: { teacherId: true } },
      },
    });

    if (!classSession) {
      throw new AppError("Class session not found.", 404, "SESSION_NOT_FOUND");
    }

    if (role === "teacher") {
      const teacherSession = await requireTeacherSession();

      if (classSession.class.teacherId !== teacherSession.teacherId) {
        throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
      }
    } else {
      const studentSession = await requireStudentSession();

      const enrolled = await prisma.student.findFirst({
        where: {
          id: studentSession.studentId,
          status: 0,
          classes: {
            some: {
              classId: classSession.classId,
              isActive: true,
            },
          },
        },
        select: { id: true },
      });

      if (!enrolled) {
        throw new AppError(
          "Student is not enrolled in this class.",
          403,
          "STUDENT_NOT_IN_CLASS"
        );
      }
    }

    const { classId, lectureId } = classSession;

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

        // Covers a client connecting after the stream already started.
        getLiveSnapshot(lectureId)
          .then((snapshot) => send("live-status", snapshot))
          .catch(() => {
            send("live-status", { isLive: false, youtubeUrl: null });
          });

        const unsubscribe = subscribeLiveChanges((payload) => {
          if (payload.classId !== classId || payload.kind !== "youtube") {
            return;
          }

          if (payload.event === "ended") {
            send("live-status", { isLive: false, youtubeUrl: null });
            return;
          }

          getLiveSnapshot(lectureId)
            .then((snapshot) => send("live-status", snapshot))
            .catch(() => {});
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
