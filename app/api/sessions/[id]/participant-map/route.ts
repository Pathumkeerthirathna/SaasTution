import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession, requireTeacherSession } from "@/lib/auth-session";
import {
  getParticipantMap,
  ParticipantIdConflictError,
  PARTICIPANT_ID_PATTERN,
  setParticipant,
  subscribeParticipantMap,
} from "@/lib/classroom-participant-map";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSseChunk(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function findClassSession(sessionId: string) {
  const classSession = await prisma.classSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      classId: true,
      class: { select: { teacherId: true } },
    },
  });

  if (!classSession) {
    throw new AppError("Class session not found.", 404, "SESSION_NOT_FOUND");
  }

  return classSession;
}

// POST /api/sessions/[id]/participant-map
// Student only. Registers the Jitsi participant ID this student is using right
// now. The student is taken from the authenticated session, never from the body.
export async function POST(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const studentSession = await requireStudentSession();
    const classSession = await findClassSession(sessionId);

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

    const body = (await request.json().catch(() => null)) as { participantId?: unknown } | null;
    const participantId =
      typeof body?.participantId === "string" ? body.participantId.trim() : "";

    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      throw new AppError("A valid participant ID is required.", 400, "VALIDATION_ERROR");
    }

    try {
      setParticipant(sessionId, studentSession.studentId, participantId);
    } catch (error) {
      if (error instanceof ParticipantIdConflictError) {
        throw new AppError(error.message, 409, "PARTICIPANT_ID_CONFLICT");
      }

      throw error;
    }

    return apiSuccess(
      { registered: true },
      { message: "Participant registered." }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

// GET /api/sessions/[id]/participant-map
// Teacher only. Server-Sent Events: the current studentId -> participantId map
// on connect, then the whole map again every time it changes.
export async function GET(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const teacherSession = await requireTeacherSession();
    const classSession = await findClassSession(sessionId);

    if (classSession.class.teacherId !== teacherSession.teacherId) {
      throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
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

        send("participant-map", getParticipantMap(sessionId));

        const unsubscribe = subscribeParticipantMap(sessionId, (snapshot) => {
          send("participant-map", snapshot);
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
