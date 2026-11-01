import { apiSuccess } from "@/lib/api-response";
import { requireAppSession, requireStudentSession } from "@/lib/auth-session";
import {
  DISPLAY_NAME_MAX_LENGTH,
  getParticipantMap,
  normalizeDisplayName,
  ParticipantIdConflictError,
  PARTICIPANT_ID_PATTERN,
  setParticipant,
  setParticipantDisplayName,
  snapshotForViewer,
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
      isActive: true,
      class: { select: { teacherId: true } },
    },
  });

  if (!classSession) {
    throw new AppError("Class session not found.", 404, "SESSION_NOT_FOUND");
  }

  return classSession;
}

/**
 * A student may use the map of a session only while it is active and only when
 * enrolled (active, status 0) in its class: 404 for an ended session, 403 for
 * another class's (the same rules as GET /api/sessions/[id]/register).
 */
async function assertStudentInActiveSession(
  studentId: string,
  classSession: { classId: string; isActive: boolean }
) {
  if (!classSession.isActive) {
    throw new AppError("Class session is not active.", 404, "SESSION_NOT_ACTIVE");
  }

  const enrolled = await prisma.student.findFirst({
    where: {
      id: studentId,
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

    await assertStudentInActiveSession(studentSession.studentId, classSession);

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

// PATCH /api/sessions/[id]/participant-map
// Student only. Reports this student's current Jitsi display name (display
// only, never identity) for the participant ID it is using right now. Applied
// only while that ID is still the student's mapped one ({ updated: false }
// otherwise: the browser reports again for its newer ID). The student is taken
// from the authenticated session, never from the body. No database write.
export async function PATCH(
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

    await assertStudentInActiveSession(studentSession.studentId, classSession);

    const body = (await request.json().catch(() => null)) as
      | { participantId?: unknown; displayName?: unknown }
      | null;
    const participantId =
      typeof body?.participantId === "string" ? body.participantId.trim() : "";

    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      throw new AppError("A valid participant ID is required.", 400, "VALIDATION_ERROR");
    }

    // Generous raw limit (the stored name is cut to DISPLAY_NAME_MAX_LENGTH).
    const displayName =
      typeof body?.displayName === "string" && body.displayName.length <= DISPLAY_NAME_MAX_LENGTH * 4
        ? normalizeDisplayName(body.displayName)
        : null;

    if (displayName === null) {
      throw new AppError("A valid display name is required.", 400, "VALIDATION_ERROR");
    }

    const updated = setParticipantDisplayName(
      sessionId,
      studentSession.studentId,
      participantId,
      displayName
    );

    return apiSuccess(
      { updated },
      { message: updated ? "Display name updated." : "Participant ID is not current." }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

// GET /api/sessions/[id]/participant-map
// Read-only. Server-Sent Events: the current studentId -> participantId map on
// connect, then the whole map again every time it changes.
//  - Teacher: only the teacher of the session's class.
//  - Student: only while the session is active and the student is enrolled in
//    its class (their register shows classmates by student ID, not by name).
//  - Anyone else: refused.
// Display names: the teacher gets every student's; a student only its own.
export async function GET(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const session = await requireAppSession();
    let viewer: Parameters<typeof snapshotForViewer>[1];

    if (session.role === "TEACHER") {
      const classSession = await findClassSession(sessionId);

      if (classSession.class.teacherId !== session.userId) {
        throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
      }

      viewer = { role: "TEACHER" };
    } else if (session.role === "STUDENT") {
      const classSession = await findClassSession(sessionId);

      await assertStudentInActiveSession(session.userId, classSession);
      viewer = { role: "STUDENT", studentId: session.userId };
    } else {
      throw new AppError("Not allowed to read this session.", 403, "FORBIDDEN");
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

        send("participant-map", snapshotForViewer(getParticipantMap(sessionId), viewer));

        const unsubscribe = subscribeParticipantMap(sessionId, (snapshot) => {
          send("participant-map", snapshotForViewer(snapshot, viewer));
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
