import { AppError } from "@/lib/error-handler";
import { buildLiveSessionInviteLoginLink, sendLiveSessionInviteEmail } from "@/lib/mailer";
import { emitLiveChange, emitStudentDataChange } from "@/lib/session-events";
import { prisma } from "@/lib/prisma";
import { signSessionInviteToken } from "@/lib/session-invite";
import { generateJitsiToken } from "@/lib/jitsi-auth";
import { StudentSession } from "@/lib/auth-session";
import { formatTeacherClassroomName } from "@/lib/teacher-title";
import { attendedMs } from "@/lib/attendance-duration";
import {
  endYouTubeFeaturesForLecture,
  reconcileYouTubeFeaturesForNewSession,
  type YouTubeSessionCleanupResult,
} from "@/lib/youtube-feature-lifecycle";

type NotifyChannels = {
  email: boolean;
  whatsapp: boolean;
};

function getJitsiDomain() {
  return process.env.JITSI_DOMAIN?.trim() || "meet.jit.si";
}

function shouldUseJitsiJwtAuth(jitsiDomain: string) {
  const enabled = process.env.JITSI_ENABLE_JWT_AUTH?.trim().toLowerCase() === "true";

  if (!enabled) {
    return false;
  }

  // Public meet.jit.si does not accept arbitrary self-signed JWT secrets.
  if (jitsiDomain === "meet.jit.si") {
    return false;
  }

  return Boolean(process.env.JITSI_JWT_SECRET?.trim());
}

function createRoomName(classId: string) {
  const suffix = Date.now().toString(36);
  return `saastution-${classId.slice(0, 8)}-${suffix}`;
}

async function assertTeacherOwnsClass(teacherId: string, classId: string) {
  const classroom = await prisma.class.findFirst({
    where: {
      id: classId,
      teacherId,
      status: 0,
    },
    select: {
      id: true,
      name: true,
      schedule: true,
    },
  });

  if (!classroom) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  return classroom;
}

async function assertTeacherOwnsLectureInClass(teacherId: string, classId: string, lectureId: string) {
  const lecture = await prisma.lecture.findFirst({
    where: {
      id: lectureId,
      classId,
      status: 0,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
      title: true,
      date: true,
      classId: true,
    },
  });

  if (!lecture) {
    throw new AppError("Lecture not found for this class.", 404, "LECTURE_NOT_FOUND");
  }

  return lecture;
}

/**
 * After class sessions ended: end the YouTube Recording / Live of their
 * lecture, unless another session of that lecture is still active (its
 * features belong to that session). Best effort, never throws; see
 * endYouTubeFeaturesForLecture (pending cleanup is reconciled by the next
 * Recording / Live start of the lecture).
 */
async function endYouTubeFeaturesAfterSessionEnd(
  teacherId: string,
  lectureId: string,
  endedSessionIds: string[]
): Promise<YouTubeSessionCleanupResult> {
  try {
    const stillActive = await prisma.classSession.findFirst({
      where: {
        lectureId,
        isActive: true,
        id: { notIn: endedSessionIds },
      },
      select: { id: true },
    });

    if (stillActive) {
      return { status: "skipped", closed: 0, reason: "another session of this lecture is active" };
    }
  } catch (error) {
    console.error("Could not check other sessions before the YouTube cleanup:", { lectureId, error });
    return { status: "pending", closed: 0, reason: "error", pendingBroadcastIds: [] };
  }

  return endYouTubeFeaturesForLecture(teacherId, lectureId);
}

/**
 * One outcome for several YouTube cleanups (replaced sessions, the new
 * session's reconciliation): "pending" if any is pending (nothing is reported
 * done that YouTube did not confirm), else "done" if any closed something.
 */
function combineYouTubeCleanups(results: YouTubeSessionCleanupResult[]): YouTubeSessionCleanupResult {
  const closed = results.reduce((sum, result) => sum + result.closed, 0);
  const pending = results.filter(
    (result): result is Extract<YouTubeSessionCleanupResult, { status: "pending" }> => result.status === "pending"
  );

  if (pending.length > 0) {
    return {
      status: "pending",
      closed,
      reason: pending[0].reason,
      pendingBroadcastIds: [...new Set(pending.flatMap((result) => result.pendingBroadcastIds))],
    };
  }

  return { status: closed > 0 ? "done" : "none", closed };
}

export async function startClassSessionForTeacher(teacherId: string, classId: string, lectureId: string) {
  const [classroom, lecture] = await Promise.all([
    assertTeacherOwnsClass(teacherId, classId),
    assertTeacherOwnsLectureInClass(teacherId, classId, lectureId),
  ]);

  const replacedSessions = await prisma.classSession.findMany({
    where: {
      classId,
      isActive: true,
    },
    select: { id: true, lectureId: true },
  });

  await prisma.classSession.updateMany({
    where: {
      classId,
      isActive: true,
    },
    data: {
      isActive: false,
      endedAt: new Date(),
    },
  });

  // Each replaced session ended: its own classroom pages are told (students
  // leave, the teacher's page stops its Jibri stream), exactly as for End
  // Session. Session-specific, so the new session is never affected.
  for (const replaced of replacedSessions) {
    emitLiveChange({ classId, kind: "jitsi", event: "ended", sessionId: replaced.id });
  }

  // The replaced sessions ended: their lectures' YouTube features end with
  // them (before the new session exists, so it is never counted as "still
  // active"). Best effort; never blocks the new session.
  const replacedIds = replacedSessions.map((replaced) => replaced.id);
  const youtubeCleanups: YouTubeSessionCleanupResult[] = [];

  for (const replacedLectureId of new Set(
    replacedSessions.map((replaced) => replaced.lectureId).filter((id): id is string => Boolean(id))
  )) {
    youtubeCleanups.push(await endYouTubeFeaturesAfterSessionEnd(teacherId, replacedLectureId, replacedIds));
  }

  const roomName = createRoomName(classId);
  const jitsiDomain = getJitsiDomain();

  const session = await prisma.classSession.create({
    data: {
      classId,
      lectureId: lecture.id,
      roomName,
      jitsiDomain,
      isActive: true,
    },
    select: {
      id: true,
      classId: true,
      lectureId: true,
      roomName: true,
      jitsiDomain: true,
      isActive: true,
      startedAt: true,
      lecture: {
        select: {
          id: true,
          title: true,
          date: true,
        },
      },
    },
  });

  await prisma.lecture.update({
    where: { id: lecture.id },
    data: { classStatus: "LIVE" },
  });

  emitLiveChange({ classId, kind: "jitsi", event: "started", sessionId: session.id });

  // Leftover Recording / Live of this lecture from earlier sessions (a
  // cleanup that stayed pending) are ended now, bounded; the session is
  // already started and is never held up or failed by it.
  youtubeCleanups.push(await reconcileYouTubeFeaturesForNewSession(teacherId, lecture.id, session.startedAt));

  return {
    session,
    class: classroom,
    joinBaseUrl: `/session/join?sessionId=${session.id}`,
    // "pending": YouTube did not confirm every cleanup (shown to the teacher).
    youtubeCleanup: combineYouTubeCleanups(youtubeCleanups),
  };
}

/**
 * Start a fresh live session for a lecture. Looks up the lecture's class,
 * verifies ownership, then delegates to the standard session-start flow (which
 * also ends any currently-active session for that class).
 */
export async function startSessionForLectureForTeacher(teacherId: string, lectureId: string) {
  const lecture = await prisma.lecture.findFirst({
    where: {
      id: lectureId,
      status: 0,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
      classId: true,
    },
  });

  if (!lecture) {
    throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");
  }

  return startClassSessionForTeacher(teacherId, lecture.classId, lecture.id);
}

export async function restartClassSessionForTeacher(teacherId: string, sessionId: string) {
  const sourceSession = await prisma.classSession.findFirst({
    where: {
      id: sessionId,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
      classId: true,
      lectureId: true,
    },
  });

  if (!sourceSession) {
    throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
  }

  if (!sourceSession.lectureId) {
    throw new AppError("This session cannot be restarted because no lecture is linked.", 400, "LECTURE_REQUIRED");
  }

  const restarted = await startClassSessionForTeacher(teacherId, sourceSession.classId, sourceSession.lectureId);

  return {
    previousSessionId: sourceSession.id,
    ...restarted,
  };
}

export async function getActiveClassSessionForTeacher(teacherId: string, classId: string) {
  await assertTeacherOwnsClass(teacherId, classId);

  return prisma.classSession.findFirst({
    where: {
      classId,
      isActive: true,
    },
    orderBy: {
      startedAt: "desc",
    },
    select: {
      id: true,
      classId: true,
      lectureId: true,
      roomName: true,
      jitsiDomain: true,
      startedAt: true,
      isActive: true,
      lecture: {
        select: {
          id: true,
          title: true,
          date: true,
        },
      },
    },
  });
}

export async function listClassSessionHistoryForTeacher(params: {
  teacherId: string;
  classId: string;
  lectureId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  skip: number;
  take: number;
}) {
  await assertTeacherOwnsClass(params.teacherId, params.classId);

  const where = {
    classId: params.classId,
    ...(params.lectureId
      ? {
          lectureId: params.lectureId,
        }
      : {}),
    ...(params.dateFrom || params.dateTo
      ? {
          startedAt: {
            ...(params.dateFrom
              ? {
                  gte: params.dateFrom,
                }
              : {}),
            ...(params.dateTo
              ? {
                  lte: params.dateTo,
                }
              : {}),
          },
        }
      : {}),
  };

  const [sessions, totalItems] = await Promise.all([
    prisma.classSession.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: {
        startedAt: "desc",
      },
      select: {
        id: true,
        classId: true,
        lectureId: true,
        roomName: true,
        jitsiDomain: true,
        startedAt: true,
        endedAt: true,
        isActive: true,
        lecture: {
          select: {
            id: true,
            title: true,
            date: true,
          },
        },
        class: {
          select: {
            id: true,
            name: true,
            schedule: true,
          },
        },
        _count: {
          select: {
            attendance: { where: { student: { status: 0 } } },
          },
        },
      },
    }),
    prisma.classSession.count({
      where,
    }),
  ]);

  return {
    sessions,
    totalItems,
  };
}

export async function ensureSessionAccessForTeacher(teacherId: string, sessionId: string) {
  const session = await prisma.classSession.findFirst({
    where: {
      id: sessionId,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
      classId: true,
    },
  });

  if (!session) {
    throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
  }

  return session;
}

export async function notifyStudentsForSession(params: {
  teacherId: string;
  sessionId: string;
  channels: NotifyChannels;
  notificationType?: "started" | "restarted";
  appBaseUrl?: string;
}) {
  if (!params.channels.email && !params.channels.whatsapp) {
    throw new AppError("Select at least one notify channel.", 400, "VALIDATION_ERROR");
  }

  const session = await prisma.classSession.findFirst({
    where: {
      id: params.sessionId,
      isActive: true,
      class: {
        teacherId: params.teacherId,
      },
    },
    select: {
      id: true,
      classId: true,
      class: {
        select: {
          id: true,
          name: true,
          teacher: {
            select: {
              name: true,
            },
          },
          students: {
            where: {
              isActive: true,
            },
            select: {
              student: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  contact: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!session) {
    throw new AppError("Session not found or not active.", 404, "SESSION_NOT_FOUND");
  }

  const students = session.class.students.map((entry) => entry.student);

  const emailResults = params.channels.email
    ? await Promise.all(
        students.map(async (student) => {
          if (!student.email?.trim()) {
            return {
              studentId: student.id,
              studentName: student.name,
              channel: "email" as const,
              status: "FAILED" as const,
              error: "Student email is missing.",
            };
          }

          try {
            const inviteToken = await signSessionInviteToken({
              sessionId: session.id,
              classId: session.classId,
              studentId: student.id,
              role: "STUDENT",
            });

            const loginLink = buildLiveSessionInviteLoginLink(inviteToken, params.appBaseUrl);

            await sendLiveSessionInviteEmail({
              to: student.email,
              studentName: student.name,
              className: session.class.name,
              teacherName: session.class.teacher.name,
              loginLink,
              notificationType: params.notificationType,
            });

            return {
              studentId: student.id,
              studentName: student.name,
              channel: "email" as const,
              status: "SENT" as const,
            };
          } catch (error) {
            return {
              studentId: student.id,
              studentName: student.name,
              channel: "email" as const,
              status: "FAILED" as const,
              error: error instanceof Error ? error.message : "Email delivery failed.",
            };
          }
        })
      )
    : [];

  const whatsappResults = params.channels.whatsapp
    ? students.map((student) => ({
        studentId: student.id,
        studentName: student.name,
        channel: "whatsapp" as const,
        status: "FAILED" as const,
        error: "WhatsApp notifications are not implemented yet.",
      }))
    : [];

  const results = [...emailResults, ...whatsappResults];
  const sentCount = results.filter((item) => item.status === "SENT").length;
  const failedCount = results.length - sentCount;

  return {
    session: {
      id: session.id,
      classId: session.classId,
      className: session.class.name,
    },
    selectedChannels: params.channels,
    totalStudents: students.length,
    attemptedDeliveries: results.length,
    sentCount,
    failedCount,
    results,
  };
}

export async function getSessionJoinInfo(sessionId: string, studentS: StudentSession) {
  const session = await prisma.classSession.findUnique({
    where: {
      id: sessionId,
    },
    select: {
      id: true,
      classId: true,
      lectureId: true,
      roomName: true,
      jitsiDomain: true,
      isActive: true,
      lecture: {
        select: {
          id: true,
          title: true,
          date: true,
        },
      },
      class: {
        select: {
          id: true,
          name: true,
          schedule: true,
          teacher: {
            select: {
              name: true,
              profile: {
                select: {
                  title: true,
                  displayName: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!session || !session.isActive) {
    throw new AppError("Class session is not active.", 404, "SESSION_NOT_ACTIVE");
  }

  const student = await prisma.student.findFirst({
    where: {
      id: studentS.studentId,
      status: 0,
      classes: {
        some: {
          classId: session.classId,
          isActive: true,
        },
      },
    },
    select: {
      id: true,
      name: true,
      grade: true,
      contact: true,
    },
  });

  if (!student) {
    throw new AppError("Student is not enrolled in this class.", 403, "STUDENT_NOT_IN_CLASS");
  }

  const jitsiToken =
  shouldUseJitsiJwtAuth(session.jitsiDomain)
    ? await generateJitsiToken({
        name: student.name,
        room: session.roomName,
        moderator: false,
        jitsiDomain: session.jitsiDomain,
      })
    : null;

    return {
      session: {
          id: session.id,
          classId: session.classId,
          lectureId: session.lectureId,
          roomName: session.roomName,
          jitsiDomain: session.jitsiDomain,
      },
      lecture: session.lecture,
      class: {
        id: session.class.id,
        name: session.class.name,
        schedule: session.class.schedule,
      },
      teacherDisplayName: formatTeacherClassroomName(session.class.teacher),
      student: {
          id: student.id,
          name: student.name,
          
      },
      token: jitsiToken || undefined,
  }
}

export async function getSessionJoinInfoForTeacher(sessionId: string, teacherId?: string) {
  const session = await prisma.classSession.findUnique({
    where: {
      id: sessionId,
    },
    select: {
      id: true,
      classId: true,
      lectureId: true,
      roomName: true,
      jitsiDomain: true,
      isActive: true,
      lecture: {
        select: {
          id: true,
          title: true,
          date: true,
        },
      },
      class: {
        select: {
          id: true,
          name: true,
          schedule: true,

          teacher: {
            select: {
              name: true,
              profile: {
                select: {
                  title: true,
                  displayName: true,
                },
              },
              youtubeConnection: {
                select: {
                  channelTitle: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!session || !session.isActive) {
    throw new AppError("Class session is not active.", 404, "SESSION_NOT_ACTIVE");
  }

  const jitsiToken = shouldUseJitsiJwtAuth(session.jitsiDomain)
    ? await generateJitsiToken({
        name: formatTeacherClassroomName(session.class.teacher),
        room: session.roomName,
        moderator: true,
        jitsiDomain: session.jitsiDomain,
      })
    : null;

  return {
    session: {
      id: session.id,
      classId: session.classId,
      lectureId: session.lectureId,
      roomName: session.roomName,
      jitsiDomain: session.jitsiDomain,
    },
    lecture: session.lecture,
    class: session.class,
    teacherDisplayName: formatTeacherClassroomName(session.class.teacher),
      youtube: {
      channelTitle:
        session.class.teacher.youtubeConnection?.channelTitle ?? null,

      status:
        session.class.teacher.youtubeConnection?.status ?? null,
    },
    token: jitsiToken || undefined,
  };
}

export async function markStudentJoinedSession(sessionId: string, student: StudentSession) {
  // Same visit rules as the attendance endpoint (one place decides them).
  return markAttendanceOnJoin({ sessionId, student });
}

/**
 * Records a NEW visit (Attendance row) for the logged-in student. Each row is
 * one actual visit: a student who left at 08:10 and comes back at 08:50 gets
 * a second row; closed rows are never reopened or reused.
 *
 * The classroom page sends this once per visit: a short Jitsi reconnect or a
 * breakout-room switch is not a new visit and is not sent (useAttendance /
 * attendance-visit.ts). So when a join arrives while an older visit of this
 * student is still open in this session, that visit's leave never arrived
 * (page refresh or tab closed before the leave request got out, browser
 * crash): it is closed now, at the new visit's start, so visits never overlap.
 * Nothing is deleted.
 */
export async function markAttendanceOnJoin(params: {
  sessionId: string;
  student: StudentSession;
  classId?: string;
}) {
  const joinInfo = await getSessionJoinInfo(params.sessionId, params.student);

  if (params.classId && params.classId !== joinInfo.session.classId) {
    throw new AppError("classId does not match the session class.", 400, "CLASS_SESSION_MISMATCH");
  }

  const now = new Date();

  const { attendance, closedVisitIds } = await prisma.$transaction(async (tx) => {
    const stale = await tx.attendance.findMany({
      where: {
        classSessionId: params.sessionId,
        studentId: params.student.studentId,
        leftAt: null,
      },
      select: { id: true },
    });

    if (stale.length > 0) {
      await tx.attendance.updateMany({
        where: {
          id: { in: stale.map((row) => row.id) },
          leftAt: null,
        },
        data: { leftAt: now },
      });
    }

    const created = await tx.attendance.create({
      data: {
        classSessionId: params.sessionId,
        classId: joinInfo.session.classId,
        studentId: params.student.studentId,
        joinedAt: now,
      },
      select: {
        id: true,
        classSessionId: true,
        studentId: true,
        classId: true,
        joinedAt: true,
        leftAt: true,
      },
    });

    return { attendance: created, closedVisitIds: stale.map((row) => row.id) };
  });

  emitStudentDataChange({
    studentId: params.student.studentId,
    classId: joinInfo.session.classId,
  });

  return {
    attendance,
    // A new visit is always recorded (kept for the response shape).
    duplicate: false,
    // Older visits of this student closed because their leave never arrived.
    closedVisitIds,
  };
}

/**
 * Ends the logged-in student's visit. With `attendanceId` (sent by the
 * classroom page for the visit it started) exactly that visit is closed, and
 * only while it is still open, so a late leave can never close a later visit
 * or another device's. Without it (older clients) the newest open visit is
 * closed, as before.
 */
export async function markStudentLeftSession(
  sessionId: string,
  student: StudentSession,
  attendanceId?: string
) {
  const joinInfo = await getSessionJoinInfo(sessionId, student);

  const openAttendance = await prisma.attendance.findFirst({
    where: {
      ...(attendanceId ? { id: attendanceId } : {}),
      classSessionId: sessionId,
      studentId: student.studentId,
      leftAt: null,
    },
    orderBy: {
      joinedAt: "desc",
    },
    select: {
      id: true,
    },
  });

  // Conditional on still being open, so a leave racing the session end (or
  // another leave) never moves an already recorded leave time.
  const leftAt = new Date();
  const closed = openAttendance
    ? await prisma.attendance.updateMany({
        where: {
          id: openAttendance.id,
          leftAt: null,
        },
        data: {
          leftAt,
        },
      })
    : { count: 0 };

  const attendance = closed.count > 0 && openAttendance
    ? await prisma.attendance.findUnique({
        where: {
          id: openAttendance.id,
        },
        select: {
          id: true,
          classSessionId: true,
          studentId: true,
          joinedAt: true,
          leftAt: true,
        },
      })
    : null;

  return {
    classId: joinInfo.session.classId,
    attendance,
    updated: Boolean(attendance),
  };
}

export async function listSessionAttendanceForTeacher(params: {
  teacherId: string;
  sessionId: string;
}) {
  const session = await prisma.classSession.findFirst({
    where: {
      id: params.sessionId,
      class: {
        teacherId: params.teacherId,
      },
    },
    select: {
      id: true,
      classId: true,
      lectureId: true,
      roomName: true,
      startedAt: true,
      endedAt: true,
      lecture: {
        select: {
          id: true,
          title: true,
          date: true,
        },
      },
      class: {
        select: {
          id: true,
          name: true,
          schedule: true,
        },
      },
    },
  });

  if (!session) {
    throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
  }

  const [classStudents, records] = await Promise.all([
    prisma.classStudent.findMany({
      where: {
        classId: session.classId,
        isActive: true,
        student: { status: 0 },
      },
      orderBy: {
        student: {
          name: "asc",
        },
      },
      select: {
        student: {
          select: {
            id: true,
            name: true,
            grade: true,
            contact: true,
          },
        },
      },
    }),
    // Every visit, oldest first: a student's visits are listed in the order
    // they happened (08:00-08:10, then 08:50-09:00).
    prisma.attendance.findMany({
      where: {
        classSessionId: params.sessionId,
      },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        joinedAt: true,
        leftAt: true,
        student: {
          select: {
            id: true,
            name: true,
            grade: true,
            contact: true,
          },
        },
      },
    }),
  ]);

  const joinedStudentsMap = new Map<
    string,
    {
    student: {
      id: string;
      name: string;
      grade: {
        id: number;
        GradeDesc: string;
        Status: number;
      } | null;
      contact: string;
    };
    logs: Array<{
      id: string;
      joinedAt: Date;
      leftAt: Date | null;
    }>;
  }
  >();

  for (const record of records) {
    const existing = joinedStudentsMap.get(record.student.id);

    if (existing) {
      existing.logs.push({
        id: record.id,
        joinedAt: record.joinedAt,
        leftAt: record.leftAt,
      });
      continue;
    }

    joinedStudentsMap.set(record.student.id, {
      student: record.student,
      logs: [
        {
          id: record.id,
          joinedAt: record.joinedAt,
          leftAt: record.leftAt,
        },
      ],
    });
  }

  // Per student: total time present from the actual visits (overlaps merged;
  // an open visit counts up to the session's end, or now while it is live),
  // and whether they are in the session now. Students: latest visit first.
  const now = new Date();
  const joinedStudents = Array.from(joinedStudentsMap.values())
    .map((entry) => ({
      ...entry,
      totalAttendedMs: attendedMs(entry.logs, {
        openUntil: session.endedAt ?? now,
        sessionStart: session.startedAt,
        sessionEnd: session.endedAt,
      }),
      isPresent: !session.endedAt && entry.logs.some((log) => log.leftAt === null),
    }))
    .sort((left, right) => {
      const leftDate = left.logs[left.logs.length - 1]?.joinedAt.getTime() ?? 0;
      const rightDate = right.logs[right.logs.length - 1]?.joinedAt.getTime() ?? 0;
      return rightDate - leftDate;
    });

  const joinedStudentIds = new Set(joinedStudents.map((entry) => entry.student.id));
  const notJoinedStudents = classStudents
    .map((entry) => entry.student)
    .filter((student) => !joinedStudentIds.has(student.id));

  return {
    session,
    joinedStudents,
    notJoinedStudents,
  };
}

export async function listAttendanceByClassForTeacher(params: {
  teacherId: string;
  classId: string;
  skip: number;
  take: number;
}) {
  const classroom = await assertTeacherOwnsClass(params.teacherId, params.classId);

  const [records, totalItems] = await Promise.all([
    prisma.attendance.findMany({
      where: {
        classId: params.classId,
      },
      skip: params.skip,
      take: params.take,
      orderBy: {
        joinedAt: "desc",
      },
      select: {
        id: true,
        classId: true,
        classSessionId: true,
        joinedAt: true,
        leftAt: true,
        student: {
          select: {
            id: true,
            name: true,
            grade: true,
            contact: true,
          },
        },
        classSession: {
          select: {
            id: true,
            roomName: true,
            startedAt: true,
            endedAt: true,
          },
        },
      },
    }),
    prisma.attendance.count({
      where: {
        classId: params.classId,
      },
    }),
  ]);

  return {
    class: classroom,
    records,
    totalItems,
  };
}

export async function endClassSessionForTeacher(teacherId: string, sessionId: string) {
  await ensureSessionAccessForTeacher(teacherId, sessionId);

  const endedAt = new Date();

  const session = await prisma.classSession.findUnique({
    where: {
      id: sessionId,
    },
    select: { classId: true, lectureId: true, endedAt: true },
  });

  // Ends the session only while it is active, once (a concurrent second End
  // Session finds it already ended).
  const { count: endedNow } = await prisma.classSession.updateMany({
    where: {
      id: sessionId,
      isActive: true,
    },
    data: {
      isActive: false,
      endedAt,
    },
  });

  await prisma.attendance.updateMany({
    where: {
      classSessionId: sessionId,
      leftAt: null,
    },
    data: {
      leftAt: endedAt,
    },
  });

  if (!session || endedNow === 0) {
    // Already ended, or replaced by a newer session (e.g. End Session from a
    // stale tab): its end time is kept, and there is no second end event and
    // no YouTube cleanup, so the class's current session and its features
    // are never affected. (Attendance still open for it was closed above, as
    // before.)
    return {
      sessionId,
      endedAt: session?.endedAt ?? endedAt,
      alreadyEnded: true,
      youtubeCleanup: {
        status: "skipped",
        closed: 0,
        reason: "session already ended",
      } satisfies YouTubeSessionCleanupResult,
    };
  }

  emitLiveChange({ classId: session.classId, kind: "jitsi", event: "ended", sessionId });

  // The lecture's YouTube Recording / Live end with the session (after the
  // session and attendance are ended, so this can never fail them). A busy
  // lock or a YouTube failure is reported, not hidden.
  const youtubeCleanup: YouTubeSessionCleanupResult = session.lectureId
    ? await endYouTubeFeaturesAfterSessionEnd(teacherId, session.lectureId, [sessionId])
    : { status: "none", closed: 0 };

  return {
    sessionId,
    endedAt,
    alreadyEnded: false,
    youtubeCleanup,
  };
}
