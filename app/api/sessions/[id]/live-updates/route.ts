import { requireStudentSession, requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { subscribeLiveChanges } from "@/lib/session-events";
import {
  isValidPageId,
  recordTeacherActivity,
  recordTeacherPresence,
  TEACHER_PRESENCE_REFRESH_MS,
} from "@/lib/teacher-presence";
import { checkLectureForDepartedTeacher, TEACHER_DEPARTURE_SWEEP_INTERVAL_MS } from "@/lib/teacher-departure-sweep";
import { getLiveSnapshot, type LiveSnapshotAudience } from "@/lib/youtube-live-snapshot";

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
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const { searchParams } = new URL(request.url);
    const role = searchParams.get("role")?.trim();
    // The classroom page instance (teacher-departure-signal.ts); optional for
    // pages loaded before it existed.
    const rawPageId = searchParams.get("pageId");
    const pageId = isValidPageId(rawPageId) ? rawPageId : null;

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

    // Who the live status is for. Set only after the matching session (from
    // the signed login cookie) and its ownership / enrolment check pass:
    // `?role=teacher` without a teacher session that owns this class fails
    // below, it never grants the teacher view.
    let audience: LiveSnapshotAudience;

    if (role === "teacher") {
      const teacherSession = await requireTeacherSession();

      if (classSession.class.teacherId !== teacherSession.teacherId) {
        throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
      }

      audience = "teacher";
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

      // Students never receive a PRIVATE broadcast or one that is not live.
      audience = "student";
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
        getLiveSnapshot(lectureId, audience)
          .then((snapshot) => send("live-status", snapshot))
          .catch(() => {
            send("live-status", { isLive: false, youtubeUrl: null });
          });

        const unsubscribe = subscribeLiveChanges((payload) => {
          if (payload.classId !== classId) {
            return;
          }

          // The application's ClassSession was ended (teacher's "End Session" flow,
          // wherever it was triggered from) — tell anyone still connected to this
          // exact session so they can leave the classroom. Kept as its own event,
          // separate from the youtube "live-status" signal below.
          // Only THIS session's end: another session of the class ending
          // (an older one ended late, or this one replacing it) never ends it.
          if (payload.kind === "jitsi") {
            if (payload.event === "ended" && payload.sessionId === sessionId) {
              send("session-ended", { occurredAt: payload.occurredAt, sessionId });
            }
            return;
          }

          if (payload.kind !== "youtube") {
            return;
          }

          if (payload.event === "ended") {
            send("live-status", { isLive: false, youtubeUrl: null });
            return;
          }

          getLiveSnapshot(lectureId, audience)
            .then((snapshot) => send("live-status", snapshot))
            .catch(() => {});
        });

        const keepAliveIntervalId = setInterval(() => {
          send("ping", { timestamp: new Date().toISOString() });
        }, 15_000);

        // Teacher presence (lib/teacher-presence.ts): only the class's own
        // teacher, checked above. Opening the connection (also every
        // reconnect) is a live page's own request: teacher activity, which
        // cancels a pending tab-close signal of another page. The refresh
        // timer below runs on the server, so it only refreshes
        // teacherLastSeenAt: a connection the server has not noticed is gone
        // must never cancel a departure. A lost connection is never taken as
        // the teacher leaving. Best effort: never affects the stream.
        let presenceIntervalId: ReturnType<typeof setInterval> | null = null;

        if (audience === "teacher") {
          void recordTeacherActivity(sessionId, pageId);

          presenceIntervalId = setInterval(() => {
            if (!closed) {
              void recordTeacherPresence(sessionId);
            }
          }, TEACHER_PRESENCE_REFRESH_MS);
        }

        // Teacher-departure check (lib/teacher-departure-sweep.ts) from the
        // students still in the class: ends the class's YouTube features once
        // its teacher has left. Throttled per lecture, never throws, and never
        // changes what this stream sends.
        let departureIntervalId: ReturnType<typeof setInterval> | null = null;

        if (audience === "student") {
          void checkLectureForDepartedTeacher(lectureId);

          departureIntervalId = setInterval(() => {
            if (!closed) {
              void checkLectureForDepartedTeacher(lectureId);
            }
          }, TEACHER_DEPARTURE_SWEEP_INTERVAL_MS);
        }

        cleanup = () => {
          if (closed) {
            return;
          }

          closed = true;
          clearInterval(keepAliveIntervalId);

          if (presenceIntervalId) {
            clearInterval(presenceIntervalId);
          }

          if (departureIntervalId) {
            clearInterval(departureIntervalId);
          }

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
