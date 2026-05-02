import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

function getJitsiDomain() {
  return process.env.JITSI_DOMAIN?.trim() || "meet.jit.si";
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

export async function startClassSessionForTeacher(teacherId: string, classId: string) {
  const classroom = await assertTeacherOwnsClass(teacherId, classId);

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
      roomName,
      jitsiDomain,
      isActive: true,
    },
    select: {
      id: true,
      classId: true,
      roomName: true,
      jitsiDomain: true,
      isActive: true,
      startedAt: true,
    },
  });

  return {
    session,
    class: classroom,
    joinBaseUrl: `/session/join?sessionId=${session.id}`,
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
      roomName: true,
      jitsiDomain: true,
      startedAt: true,
      isActive: true,
    },
  });
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

export async function getSessionJoinInfo(sessionId: string, studentId: string) {
  const session = await prisma.classSession.findUnique({
    where: {
      id: sessionId,
    },
    select: {
      id: true,
      classId: true,
      roomName: true,
      jitsiDomain: true,
      isActive: true,
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
      id: studentId,
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

  return {
    session: {
      id: session.id,
      classId: session.classId,
      roomName: session.roomName,
      jitsiDomain: session.jitsiDomain,
    },
    class: session.class,
    student,
  };
}

export async function getSessionJoinInfoForTeacher(sessionId: string) {
  const session = await prisma.classSession.findUnique({
    where: {
      id: sessionId,
    },
    select: {
      id: true,
      classId: true,
      roomName: true,
      jitsiDomain: true,
      isActive: true,
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

  return {
    session: {
      id: session.id,
      classId: session.classId,
      roomName: session.roomName,
      jitsiDomain: session.jitsiDomain,
    },
    class: session.class,
  };
}

export async function markStudentJoinedSession(sessionId: string, studentId: string) {
  const joinInfo = await getSessionJoinInfo(sessionId, studentId);

  const attendance = await prisma.attendance.upsert({
    where: {
      classSessionId_studentId: {
        classSessionId: sessionId,
        studentId,
      },
    },
    update: {
      leftAt: null,
    },
    create: {
      classSessionId: sessionId,
      classId: joinInfo.session.classId,
      studentId,
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
  studentId: string;
  classId?: string;
}) {
  const joinInfo = await getSessionJoinInfo(params.sessionId, params.studentId);

  if (params.classId && params.classId !== joinInfo.session.classId) {
    throw new AppError("classId does not match the session class.", 400, "CLASS_SESSION_MISMATCH");
  }

  const existingAttendance = await prisma.attendance.findUnique({
    where: {
      classSessionId_studentId: {
        classSessionId: params.sessionId,
        studentId: params.studentId,
      },
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

  if (existingAttendance) {
    const attendance = existingAttendance.leftAt
      ? await prisma.attendance.update({
          where: {
            id: existingAttendance.id,
          },
          data: {
            leftAt: null,
          },
          select: {
            id: true,
            classSessionId: true,
            studentId: true,
            classId: true,
            joinedAt: true,
            leftAt: true,
          },
        })
      : existingAttendance;

    return {
      attendance,
      duplicate: true,
    };
  }

  const attendance = await prisma.attendance.create({
    data: {
      classSessionId: params.sessionId,
      classId: joinInfo.session.classId,
      studentId: params.studentId,
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

export async function markStudentLeftSession(sessionId: string, studentId: string) {
  const joinInfo = await getSessionJoinInfo(sessionId, studentId);

  const attendance = await prisma.attendance.upsert({
    where: {
      classSessionId_studentId: {
        classSessionId: sessionId,
        studentId,
      },
    },
    update: {
      leftAt: new Date(),
    },
    create: {
      classSessionId: sessionId,
      classId: joinInfo.session.classId,
      studentId,
      joinedAt: new Date(),
      leftAt: new Date(),
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

export async function listSessionAttendanceForTeacher(params: {
  teacherId: string;
  sessionId: string;
  skip: number;
  take: number;
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
      roomName: true,
      startedAt: true,
      endedAt: true,
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

  const [records, totalItems] = await Promise.all([
    prisma.attendance.findMany({
      where: {
        classSessionId: params.sessionId,
      },
      skip: params.skip,
      take: params.take,
      orderBy: {
        joinedAt: "desc",
      },
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
    prisma.attendance.count({
      where: {
        classSessionId: params.sessionId,
      },
    }),
  ]);

  return {
    session,
    records,
    totalItems,
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
