import { AppError } from "@/lib/error-handler";
import { buildLiveSessionInviteLoginLink, sendLiveSessionInviteEmail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";
import { signSessionInviteToken } from "@/lib/session-invite";
import { generateJitsiToken } from "@/lib/jitsi-auth";
import { StudentSession } from "@/lib/auth-session";

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

export async function startClassSessionForTeacher(teacherId: string, classId: string, lectureId: string) {
  const [classroom, lecture] = await Promise.all([
    assertTeacherOwnsClass(teacherId, classId),
    assertTeacherOwnsLectureInClass(teacherId, classId, lectureId),
  ]);

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

  return {
    session,
    class: classroom,
    joinBaseUrl: `/session/join?sessionId=${session.id}`,
  };
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
            attendance: true,
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
      class: session.class,
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
        },
      },
    },
  });

  if (!session || !session.isActive) {
    throw new AppError("Class session is not active.", 404, "SESSION_NOT_ACTIVE");
  }

  const jitsiToken = shouldUseJitsiJwtAuth(session.jitsiDomain)
    ? await generateJitsiToken({
        name: "Teacher",
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
    token: jitsiToken || undefined,
  };
}

export async function markStudentJoinedSession(sessionId: string, student: StudentSession) {
  const joinInfo = await getSessionJoinInfo(sessionId, student);

  const attendance = await prisma.attendance.create({
    data: {
      classSessionId: sessionId,
      classId: joinInfo.session.classId,
      studentId:student.studentId,
      joinedAt: new Date(),
      leftAt: null,
    },
    select: {
      id: true,
      classSessionId: true,
      studentId: true,
      joinedAt: true,
      leftAt: true,
    },
  });

  return {
    attendance,
  };
}

export async function markAttendanceOnJoin(params: {
  sessionId: string;
  student: StudentSession;
  classId?: string;
}) {
  const joinInfo = await getSessionJoinInfo(params.sessionId, params.student);

  if (params.classId && params.classId !== joinInfo.session.classId) {
    throw new AppError("classId does not match the session class.", 400, "CLASS_SESSION_MISMATCH");
  }

  const attendance = await prisma.attendance.create({
    data: {
      classSessionId: params.sessionId,
      classId: joinInfo.session.classId,
      studentId: params.student.studentId,
      joinedAt: new Date(),
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

  return {
    attendance,
    duplicate: false,
  };
}

export async function markStudentLeftSession(sessionId: string, student: StudentSession) {
  const joinInfo = await getSessionJoinInfo(sessionId, student);

  const openAttendance = await prisma.attendance.findFirst({
    where: {
      classSessionId: sessionId,
      studentId:student.studentId,
      leftAt: null, 
    },
    orderBy: {
      joinedAt: "desc",
    },
    select: {
      id: true,
    },
  });

  const attendance = openAttendance
    ? await prisma.attendance.update({
        where: {
          id: openAttendance.id,
        },
        data: {
          leftAt: new Date(),
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
    prisma.attendance.findMany({
      where: {
        classSessionId: params.sessionId,
      },
      orderBy: [{ joinedAt: "desc" }],
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

  const joinedStudents = Array.from(joinedStudentsMap.values()).sort((left, right) => {
    const leftDate = left.logs[0]?.joinedAt.getTime() ?? 0;
    const rightDate = right.logs[0]?.joinedAt.getTime() ?? 0;
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

  await prisma.classSession.update({
    where: {
      id: sessionId,
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

  return {
    sessionId,
    endedAt,
  };
}
