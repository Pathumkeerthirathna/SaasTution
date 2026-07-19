import { Prisma, StudentClassAction } from "@prisma/client";
import bcrypt from "bcryptjs";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import type { CreateGuardianInput, UpdateGuardianInput } from "@/lib/guardian-validation";
import type { CreateStudentInput, UpdateStudentInput } from "@/lib/student-validation";
import { RegisterStudentRequest } from "@/types/teacherProfileTypes/RegisterStudentRequest";
import { requireTeacherSession } from "@/lib/auth-session";

const HASH_ROUNDS = 12;

async function assertTeacherOwnsClass(classId: string, teacherId: string) {
  const classroom = await prisma.class.findFirst({
    where: {
      id: classId,
      teacherId,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!classroom) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  return classroom;
}

function buildShortCode(value: string, maxLength: number) {
  const normalizedWords = value
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean);

  if (normalizedWords.length === 0) {
    return "NA";
  }

  const initials = normalizedWords.map((word) => word[0]).join("");

  if (initials.length >= 2) {
    return initials.slice(0, maxLength);
  }

  return normalizedWords.join("").slice(0, maxLength);
}

export async function generateStudentRegistrationNumber(teacherName: string,teacherId:string) {
  const year = new Date().getFullYear();
  const teacherCode = buildShortCode(teacherName, 3);
  const prefix = `${teacherCode}-${year}`;

  const currentCount = await prisma.student.count({
    where: {
      // registrationNumber: {
      //   startsWith: `${prefix}-`,
      // },
      teacherId:teacherId
    },
  });

  const sequence = String(currentCount + 1).padStart(3, "0");
  return `${prefix}-${sequence}`;
}

export async function createStudent(teacherId: string, input: CreateStudentInput) {

  const teacher = await prisma.teacher.findUnique({
    where: {
      id: teacherId,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!teacher) {
    throw new AppError("Teacher not found.", 404, "TEACHER_NOT_FOUND");
  }

  const existingRegistrationNumber =
    await prisma.student.findFirst({
      where: {
        registrationNumber: input.registrationNumber,
      },
      select: {
        id: true,
      },
    });

  if (existingRegistrationNumber) {
    throw new AppError(
      "Registration number already exists.",
      409,
      "DUPLICATE_REGISTRATION_NUMBER"
    );
  }

  const existingStudent =
    await prisma.student.findFirst({
      where: {
        teacherId: teacher.id,
        name: input.name,
        gradeId: input.gradeId,
      },
      select: {
        id: true,
      },
    });

  if (existingStudent) {
    throw new AppError(
      "Student name already exists.",
      409,
      "DUPLICATE_STUDENT_NAME"
    );
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const registrationNumber = await generateStudentRegistrationNumber(teacher.name,teacher.id);
    const passwordHash = await bcrypt.hash(registrationNumber, HASH_ROUNDS);

    try {
      return await prisma.student.create({
        data: {
          registrationNumber:input.registrationNumber??registrationNumber,
          name: input.name,
          gradeId: input.gradeId,
          password: passwordHash,
          contact: input.contact01??"",
          contact01: input.contact01,
          contact02: input.contact02,
          email: input.email,
          teacherId:teacher.id,
        },
        select: {
          id: true,
          name: true,
          grade: true,
          contact01: true,
          contact02: true,
          email: true,
          registrationNumber: true,
          createdAt: true,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const target = Array.isArray(error.meta?.target)
          ? error.meta?.target.map((value) => String(value)).join(",")
          : String(error.meta?.target ?? "");

        if (target.includes("registrationNumber")) {
          continue;
        }
      }

      throw error;
    }
  }

  throw new AppError("Failed to generate registration number. Please retry.", 500, "REGISTRATION_NUMBER_GENERATION_FAILED");
}

export async function assignStudentToClass(teacherId: string, classId: string, studentId: string) {
  await assertTeacherOwnsClass(classId, teacherId);

  const student = await prisma.student.findUnique({
    where: {
      id: studentId,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!student) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }

  try {
    const existingActive = await prisma.classStudent.findFirst({
      where: {
        classId,
        studentId,
        isActive: true,
      },
      select: {
        id: true,
      },
    });

    if (existingActive) {
      throw new AppError("Student is already assigned to this class.", 409, "DUPLICATE_ASSIGNMENT");
    }

    // const record = await prisma.classStudent.create({
    //   data: {
    //     classId,
    //     studentId,
    //     isActive: true,
    //     assignedAt: new Date(),
    //   },
    //   select: {
    //     id: true,
    //     classId: true,
    //     studentId: true,
    //     assignedAt: true,
    //   },
    // });


    const record = await prisma.$transaction(async (tx) => {
      const assignment = await tx.classStudent.create({
        data: {
          classId,
          studentId,
          isActive: true,
          assignedAt: new Date(),
        },
        select: {
          id: true,
          classId: true,
          studentId: true,
          assignedAt: true,
        },
      });

      await tx.classStudentHistory.create({
        data: {
          classId,
          studentId,
          action: StudentClassAction.ASSIGNED,
          actionDate: new Date(),
        },
      });

      return assignment;
    });

    return {
      ...record,
      studentName: student.name,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("Student is already assigned to this class.", 409, "DUPLICATE_ASSIGNMENT");
    }

    throw error;
  }
}

export async function listStudentsByTeacher(params: {

  teacherId: string;
  skip: number;
  take: number;
  name?: string;
  gradeId?: number;
  sortBy?: string;
  sortOrder?: string;

}) {

  const where = {
    teacherId: params.teacherId,
    status: {
      not: 2,
    },
    ...(params.name
      ? {
          name: {
            contains: params.name,
            mode: "insensitive" as const,
          },
        }
      : {}),

    ...(params.gradeId
      ? {
          gradeId: params.gradeId,
        }
      : {}),

    OR: [
      {
        classes: {
          none: {
            isActive: true,
          },
        },
      },
      {
        classes: {
          some: {
            class: {
              teacherId: params.teacherId,
            },
          },
        },
      },
    ],
  };

  const sortOrder: Prisma.SortOrder =
  params.sortOrder === "asc" ? "asc" : "desc";

const orderBy: Prisma.StudentOrderByWithRelationInput =
  params.sortBy === "name"
    ? { name: sortOrder }
    : params.sortBy === "registrationNumber"
    ? { registrationNumber: sortOrder }
    : { createdAt: "desc" };

  const [students, totalItems] = await Promise.all([
    
    prisma.student.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy,
      select: {
        id: true,
        name: true,
        status: true,
        gradeId: true,
        grade: {
          select: {
            id: true,
            GradeDesc: true,
          },
        },

        contact01: true,
        contact02: true,
        email: true,
        registrationNumber: true,
        createdAt: true,

        classes: {
          where: {
            isActive: true,
            class: {
              teacherId: params.teacherId,
            },
          },
          select: {
            id: true,
            class: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    }),

    prisma.student.count({
      where,
    }),
  ]);

  return {
    students: students.map((student) => ({
      id: student.id,
      name: student.name,
      status: student.status,
      gradeId: student.gradeId,
      grade: student.grade,

      contact01: student.contact01,
      contact02: student.contact02,
      email: student.email,

      createdAt: student.createdAt,
      registrationNumber: student.registrationNumber ?? null,

      classes: student.classes.map((entry) => ({
        id: entry.id,
        name: entry.class.name,
      })),
    })),

    totalItems,
  };
}

export async function listAllStudentsByTeacher(params: {

  teacherId: string;
  name?: string;
  gradeId?: number;
  sortBy?: string;
  sortOrder?: string;
  
}) {
  const where = {
    status: {
      not: 2,
    },
    ...(params.name
      ? {
          name: {
            contains: params.name,
            mode: "insensitive" as const,
          },
        }
      : {}),

    ...(params.gradeId
      ? {
          gradeId: params.gradeId,
        }
      : {}),

    OR: [
      {
        classes: {
          none: {
            isActive: true,
          },
        },
      },
      {
        classes: {
          some: {
            class: {
              teacherId: params.teacherId,
            },
          },
        },
      },
    ],
  };

  const sortOrder: Prisma.SortOrder =
  params.sortOrder === "desc"
    ? "desc"
    : "asc";

  const orderBy: Prisma.StudentOrderByWithRelationInput =
    params.sortBy === "name"
      ? { name: sortOrder }
      : { registrationNumber: sortOrder };

  const students = await prisma.student.findMany({
    where,
    orderBy,
    select: {
      id: true,
      name: true,
      status: true,
      gradeId: true,
      grade: {
        select: {
          id: true,
          GradeDesc: true,
        },
      },
      contact01: true,
      contact02: true,
      email: true,
      registrationNumber: true,
      createdAt: true,
      classes: {
        where: {
          isActive: true,
          class: {
            teacherId: params.teacherId,
          },
        },
        select: {
          id: true,
          class: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  return {
    students: students.map((student) => ({
      id: student.id,
      name: student.name,
      status: student.status,
      gradeId: student.gradeId,
      grade: student.grade,
      contact01: student.contact01,
      contact02: student.contact02,
      email: student.email,
      createdAt: student.createdAt,
      registrationNumber: student.registrationNumber ?? null,
      classes: student.classes.map((entry) => ({
        id: entry.id,
        name: entry.class.name,
      })),
    })),
  };

}

export async function activateStudentForTeacher(
  teacherId: string,
  studentId: string
) {
  return prisma.student.updateMany({
    where: {
      id: studentId,
      teacherId,
    },
    data: {
      status: 0,
      actionTakenDate: new Date(),
    },
  });
}

export async function deactivateStudentForTeacher(
  teacherId: string,
  studentId: string
) {
  return prisma.student.updateMany({
    where: {
      id: studentId,
      teacherId,
    },
    data: {
      status: 1,
      actionTakenDate: new Date(),
    },
  });
}

export async function deleteStudentForTeacher(
  teacherId: string,
  studentId: string
) {
  return prisma.student.updateMany({
    where: {
      id: studentId,
      teacherId,
    },
    data: {
      status: 2,
      actionTakenDate: new Date(),
    },
  });
}

export async function getStudentProfileForTeacher(teacherId: string, studentId: string) {
  const student = await prisma.student.findFirst({
    where: {
      id: studentId,
    },
    select: {
      id: true,
      name: true,
      grade: true,
      contact01: true,
      contact02: true,
      email: true,
      registrationNumber: true,
      createdAt: true,
      guardians: {
        select: {
          id: true,
          name: true,
          relation: true,
          phone: true,
          email: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      },
      classes: {
        where: {
          isActive: true,
          class: {
            teacherId,
          },
        },
        select: {
          id: true,
          assignedAt: true,
          class: {
            select: {
              id: true,
              name: true,
              schedule: true,
            },
          },
        },
      },
    },
  });

  if (!student) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }

  // const hasTeacherClass = student.classes.length > 0;
  // const hasTeacherHistory = await prisma.classStudent.count({
  //   where: {
  //     studentId,
  //     class: {
  //       teacherId,
  //     },
  //   },
  // });

  // if (!hasTeacherClass && hasTeacherHistory === 0) {
  //   throw new AppError("Student not available for this teacher.", 403, "FORBIDDEN");
  // }

  const assignmentHistory = await prisma.classStudent.findMany({
    where: {
      studentId,
      class: {
        teacherId,
      },
    },
    orderBy: {
      assignedAt: "desc",
    },
    select: {
      id: true,
      isActive: true,
      assignedAt: true,
      removedAt: true,
      removeReason: true,
      class: {
        select: {
          id: true,
          name: true,
          schedule: true,
        },
      },
    },
  });

  return {
    id: student.id,
    name: student.name,
    grade: student.grade,
    contact01: student.contact01,
    contact02: student.contact02,
    email: student.email,
    registrationNumber: student.registrationNumber,
    createdAt: student.createdAt,
    guardians: student.guardians,
    classes: student.classes.map((entry) => ({
      id: entry.id,
      assignedAt: entry.assignedAt,
      classId: entry.class.id,
      name: entry.class.name,
      schedule: entry.class.schedule,
    })),
    assignmentHistory: assignmentHistory.map((entry) => ({
      id: entry.id,
      classId: entry.class.id,
      name: entry.class.name,
      schedule: entry.class.schedule,
      isActive: entry.isActive,
      assignedAt: entry.assignedAt,
      removedAt: entry.removedAt,
      removeReason: entry.removeReason,
    })),
  };
}

export async function updateStudentForTeacher(teacherId: string, studentId: string, input: UpdateStudentInput) {

  console.log("Updating student with input:", input);
  console.log("Teacher ID:", teacherId, "Student ID:", studentId);

  const profile = await getStudentProfileForTeacher(teacherId, studentId);

  if (!profile) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }

  const duplicateRegistrationNumber =
    await prisma.student.findFirst({
      where: {
        registrationNumber: input.registrationNumber,
        NOT: {
          id: studentId,
        },
      },
      select: {
        id: true,
      },
    });

  if (duplicateRegistrationNumber) {
    throw new AppError(
      "Registration number already exists.",
      409,
      "DUPLICATE_REGISTRATION_NUMBER"
    );
  }

  const duplicateStudentName =
    await prisma.student.findFirst({
      where: {
        name: input.name,
        gradeId: input.gradeId,
        teacherId,
        NOT: {
          id: studentId,
        },
      },
      select: {
        id: true,
      },
    });

  if (duplicateStudentName) {
    throw new AppError(
      "Student name already exists.",
      409,
      "DUPLICATE_STUDENT_NAME"
    );
  }

  return prisma.student.update({
    where: {
      id: studentId,
    },
    data: {
      registrationNumber: input.registrationNumber,
      name: input.name,
      gradeId: input.gradeId,
      contact: input.contact01,
      contact01: input.contact01,
      contact02: input.contact02,
      email: input.email,
    },
    select: {
      id: true,
      name: true,
      grade: true,
      contact01: true,
      contact02: true,
      email: true,
      registrationNumber: true,
      createdAt: true,
    },
  });
}

export async function removeStudentFromClassForTeacher(params: {
  teacherId: string;
  classId: string;
  studentId: string;
  reason?: string;
}) {
  await assertTeacherOwnsClass(params.classId, params.teacherId);

  const activeAssignment = await prisma.classStudent.findFirst({
    where: {
      classId: params.classId,
      studentId: params.studentId,
      isActive: true,
    },
    select: {
      id: true,
    },
  });

  if (!activeAssignment) {
    throw new AppError("Active class assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
  }

  // return prisma.classStudent.update({
  //   where: {
  //     id: activeAssignment.id,
  //   },
  //   data: {
  //     isActive: false,
  //     removedAt: new Date(),
  //     removeReason: params.reason,
  //   },
  //   select: {
  //     id: true,
  //     classId: true,
  //     studentId: true,
  //     assignedAt: true,
  //     removedAt: true,
  //     removeReason: true,
  //   },
  // });

  return prisma.$transaction(async (tx) => {
    const assignment = await tx.classStudent.update({
      where: {
        id: activeAssignment.id,
      },
      data: {
        isActive: false,
        removedAt: new Date(),
        removeReason: params.reason,
      },
      select: {
        id: true,
        classId: true,
        studentId: true,
        assignedAt: true,
        removedAt: true,
        removeReason: true,
      },
    });

    await tx.classStudentHistory.create({
      data: {
        classId: params.classId,
        studentId: params.studentId,
        action: StudentClassAction.UNASSIGNED,
        actionDate: new Date(),
        reason: params.reason,
      },
    });

    return assignment;
  });

}

export async function addGuardianForTeacher(teacherId: string, input: CreateGuardianInput) {
  const linkedToTeacherClass = await prisma.classStudent.findFirst({
    where: {
      studentId: input.studentId,
      isActive: true,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
    },
  });

  if (!linkedToTeacherClass) {
    throw new AppError(
      "Student must be assigned to one of your classes before adding guardians.",
      400,
      "STUDENT_NOT_ASSIGNED_TO_TEACHER_CLASS"
    );
  }

  return prisma.guardian.create({
    data: {
      studentId: input.studentId,
      name: input.name,
      relation: input.relation,
      phone: input.phone,
    },
    select: {
      id: true,
      studentId: true,
      name: true,
      relation: true,
      phone: true,
      email: true,
      createdAt: true,
    },
  });
}

export async function updateGuardianForTeacher(
  teacherId: string,
  guardianId: string,
  input: UpdateGuardianInput
) {
  const guardian = await prisma.guardian.findUnique({
    where: {
      id: guardianId,
    },
    select: {
      id: true,
      studentId: true,
    },
  });

  if (!guardian) {
    throw new AppError("Guardian not found.", 404, "GUARDIAN_NOT_FOUND");
  }

  const linkedToTeacherClass = await prisma.classStudent.findFirst({
    where: {
      studentId: guardian.studentId,
      isActive: true,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
    },
  });

  if (!linkedToTeacherClass) {
    throw new AppError("Guardian is not linked to your active class student.", 403, "FORBIDDEN");
  }

  return prisma.guardian.update({
    where: {
      id: guardianId,
    },
    data: {
      name: input.name,
      relation: input.relation,
      phone: input.phone,
    },
    select: {
      id: true,
      studentId: true,
      name: true,
      relation: true,
      phone: true,
      email: true,
      createdAt: true,
    },
  });
}

export async function listStudentsByClassForTeacher(params: {
  teacherId: string;
  classId: string;
  skip: number;
  take: number;
}) {
  const classroom = await assertTeacherOwnsClass(params.classId, params.teacherId);

  const [classStudents, totalItems] = await Promise.all([
    prisma.classStudent.findMany({
      where: {
        classId: params.classId,
        isActive: true,
      },
      skip: params.skip,
      take: params.take,
      orderBy: {
        id: "desc",
      },
      select: {
        student: {
          select: {
            id: true,
            name: true,
            grade: true,
            contact: true,
            registrationNumber: true,
            createdAt: true,
            guardians: {
              select: {
                id: true,
                name: true,
                relation: true,
                phone: true,
                email: true,
              },
              orderBy: {
                createdAt: "desc",
              },
            },
          },
        },
      },
    }),
    prisma.classStudent.count({
      where: {
        classId: params.classId,
        isActive: true,
      },
    }),
  ]);

  return {
    className: classroom.name,
    students: classStudents.map((entry) => entry.student),
    totalItems,
  };
}

export async function getStudentClassesForTeacher(
  studentId: string
) {
  return prisma.classStudent.findMany({
    where: {
      studentId,
    },
    orderBy: {
      assignedAt: "desc",
    },
    select: {
      id: true,
      isActive: true,
      assignedAt: true,
      removedAt: true,
      removeReason: true,

      class: {
        select: {
          id: true,
          name: true,
          description: true,
          schedule: true,
          monthlyFee: true,

          payments: {
            where: {
              studentId,
            },
            orderBy: {
              month: "desc",
            },
            select: {
              id: true,
              month: true,
              amount: true,
              status: true,
              submittedAt: true,
              confirmedAt: true,
            },
          },

          studentHistory: {
            where: {
              studentId,
            },
            orderBy: {
              actionDate: "desc",
            },
            select: {
              id: true,
              action: true,
              actionDate: true,
              reason: true,
            },
          },
        },
      },
    },
  });
}

export async function getStudentPaymentHistoryForTeacher(studentId: string) {

}

export async function getStudentClassAttendance(
  studentId: string,
  classId: string
) {
  const lectures = await prisma.lecture.findMany({
    where: {
      classId,
    },
    orderBy: {
      date: "desc",
    },
    select: {
      id: true,
      title: true,
      date: true,

      sessions: {
        select: {
          attendance: {
            where: {
              studentId,
            },
            select: {
              id: true,
              joinedAt: true,
              leftAt: true,
            },
          },
        },
      },
    },
  });

  return lectures.map((lecture) => {
    const attendanceRecord = lecture.sessions.flatMap(
      (session) => session.attendance
    );

    return {
      lectureId: lecture.id,
      title: lecture.title,
      date: lecture.date,

      attended: attendanceRecord.length > 0,

      joinedAt:
        attendanceRecord.length > 0
          ? attendanceRecord[0].joinedAt
          : null,

      leftAt:
        attendanceRecord.length > 0
          ? attendanceRecord[0].leftAt
          : null,
    };
  });
}


export async function getStudentQuizResults(
  studentId: string,
  classId: string
) {
  const quizzes = await prisma.quiz.findMany({
    where: {
      lecture: {
        classId,
      },
    },
    orderBy: {
      lecture: {
        date: "desc",
      },
    },
    select: {
      id: true,
      title: true,
      dueDate: true,

      lecture: {
        select: {
          id: true,
          title: true,
          date: true,
        },
      },

      submissions: {
        where: {
          studentId,
        },
        select: {
          id: true,
          score: true,
          totalQuestions: true,
          submittedAt: true,
          attemptCount: true,
        },
      },
    },
  });

  const results = quizzes.map((quiz) => {
    const submission = quiz.submissions[0];

    return {
      quizId: quiz.id,
      quizTitle: quiz.title,
      lectureTitle: quiz.lecture.title,
      lectureDate: quiz.lecture.date,

      attempted: !!submission,

      score: submission?.score ?? null,
      totalQuestions: submission?.totalQuestions ?? null,
      percentage: submission
        ? Math.round(
            (submission.score / submission.totalQuestions) * 100
          )
        : null,

      submittedAt: submission?.submittedAt ?? null,
      attemptCount: submission?.attemptCount ?? 0,
    };
  });

  const totalQuizzes = results.length;

  const attemptedQuizzes = results.filter(
    (x) => x.attempted
  ).length;

  const missedQuizzes = totalQuizzes - attemptedQuizzes;

  const averageScore =
    attemptedQuizzes > 0
      ? Math.round(
          results
            .filter((x) => x.percentage !== null)
            .reduce(
              (sum, x) => sum + (x.percentage ?? 0),
              0
            ) / attemptedQuizzes
        )
      : 0;

  return {
    summary: {
      totalQuizzes,
      attemptedQuizzes,
      missedQuizzes,
      averageScore,
    },
    quizzes: results,
  };
}

export async function getStudentAttendanceSummary(
  studentId: string
) {
  const studentClasses = await prisma.classStudent.findMany({
    where: {
      studentId,
      isActive: true,
    },
    select: {
      classId: true,
      class: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  const summary = await Promise.all(
    studentClasses.map(async (studentClass) => {
      const totalLectures = await prisma.lecture.count({
        where: {
          classId: studentClass.classId,
        },
      });

      const attendedLectures = await prisma.lecture.count({
        where: {
          classId: studentClass.classId,
          sessions: {
            some: {
              attendance: {
                some: {
                  studentId,
                },
              },
            },
          },
        },
      });

      const missedLectures =
        totalLectures - attendedLectures;

      const attendancePercentage =
        totalLectures === 0
          ? 0
          : Number(
              (
                (attendedLectures / totalLectures) *
                100
              ).toFixed(2)
            );

      return {
        classId: studentClass.class.id,
        className: studentClass.class.name,
        totalLectures,
        attendedLectures,
        missedLectures,
        attendancePercentage,
      };
    })
  );

  return summary;
}

export async function getStudentPaymentSummary(
  studentId: string
) {
  const classes = await prisma.classStudent.findMany({
    where: {
      studentId,
    },
    select: {
      classId: true,
      class: {
        select: {
          id: true,
          name: true,
          monthlyFee: true,

          payments: {
            where: {
              studentId,
            },
            select: {
              id: true,
              month: true,
              amount: true,
              status: true,
            },
          },
        },
      },
    },
  });

  return classes;
}

export async function getStudentQuizSummary(
  studentId: string
) {
  const studentClasses = await prisma.classStudent.findMany({
    where: {
      studentId,
      isActive: true,
    },
    select: {
      classId: true,
      class: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  const classes = await Promise.all(
    studentClasses.map(async (studentClass) => {
      const quizzes = await prisma.quiz.findMany({
        where: {
          lecture: {
            classId: studentClass.classId,
          },
        },
        select: {
          id: true,
          submissions: {
            where: {
              studentId,
            },
            select: {
              score: true,
              totalQuestions: true,
            },
          },
        },
      });

      const totalQuizzes = quizzes.length;

      const attempted = quizzes.filter(
        (quiz) => quiz.submissions.length > 0
      );

      const attemptedCount = attempted.length;

      const missedCount =
        totalQuizzes - attemptedCount;

      const averageScore =
        attemptedCount === 0
          ? 0
          : Math.round(
              attempted.reduce((sum, quiz) => {
                const submission =
                  quiz.submissions[0];

                return (
                  sum +
                  (
                    (submission.score /
                      submission.totalQuestions) *
                    100
                  )
                );
              }, 0) / attemptedCount
            );

      return {
        classId: studentClass.class.id,
        className: studentClass.class.name,
        totalQuizzes,
        attempted: attemptedCount,
        missed: missedCount,
        averageScore,
      };
    })
  );

  const totalQuizzes = classes.reduce(
    (sum, c) => sum + c.totalQuizzes,
    0
  );

  const attempted = classes.reduce(
    (sum, c) => sum + c.attempted,
    0
  );

  const missed = classes.reduce(
    (sum, c) => sum + c.missed,
    0
  );

  const averageScore =
    classes.length === 0
      ? 0
      : Math.round(
          classes.reduce(
            (sum, c) => sum + c.averageScore,
            0
          ) / classes.length
        );

  return {
    summary: {
      totalQuizzes,
      attempted,
      missed,
      averageScore,
    },
    classes,
  };
}

export async function getStudentClassQuizResults(
  studentId: string,
  classId: string
) {
  const quizzes = await prisma.quiz.findMany({
    where: {
      lecture: {
        classId,
      },
    },
    orderBy: {
      dueDate: "desc",
    },
    select: {
      id: true,
      title: true,
      dueDate: true,

      lecture: {
        select: {
          title: true,
          date: true,
        },
      },

      submissions: {
        where: {
          studentId,
        },
        select: {
          score: true,
          totalQuestions: true,
          submittedAt: true,
          attemptCount: true,
        },
      },
    },
  });

  return quizzes.map((quiz) => {
    const submission =
      quiz.submissions[0];

    return {
      quizId: quiz.id,
      quizTitle: quiz.title,
      dueDate: quiz.dueDate,

      lectureTitle:
        quiz.lecture.title,

      lectureDate:
        quiz.lecture.date,

      attempted: !!submission,

      score:
        submission?.score ?? null,

      totalQuestions:
        submission?.totalQuestions ??
        null,

      percentage:
        submission
          ? Math.round(
              (submission.score /
                submission.totalQuestions) *
              100
            )
          : null,

      attemptCount:
        submission?.attemptCount ?? 0,

      submittedAt:
        submission?.submittedAt ??
        null,
    };
  });
}


export async function RegisterStudentViaPublicClasses(request:RegisterStudentRequest){

  // Find class
  const cls = await prisma.class.findUnique({
      where: { id: request.classId }
  });

  if (!cls) {
      throw new Error("Class not found");
  }

  const teacher = await prisma.teacher.findUnique({
      where: { id: cls.teacherId }
  });

  const regNo = await generateStudentRegistrationNumber(
      teacher?.name ?? "",teacher?.id??""
  );

  await prisma.$transaction(async (tx) => {

      // find class
      // const cls = await tx.class.findUnique({
      //     where: { id: request.classId }
      // });

      // if (!cls)
      //     throw new Error("Class not found");

      // const teacher = await tx.teacher.findUnique({
      //   where:{id:cls.teacherId}
      // })

      // //generate registration number

      //  const regNoRes = await generateStudentRegistrationNumber(teacher?.name??"");

      //  const regNo = await regNoRes;

      // create student
      
      const student = await tx.student.create({
          data: {
              name: request.studentName,
              registrationNumber:regNo,
              teacherId: cls.teacherId,
              contact: request.mobileNumber,
              contact01: request.mobileNumber,
              contact02:request.parentMobileNumber,
              gradeId: request.gradeId,
              email:request.email??""
          }
      });

      // assign class

      await tx.classStudent.create({
          data: {
              classId: cls.id,
              studentId: student.id
          }
      });

      // history

      await tx.classStudentHistory.create({
          data: {
              classId: cls.id,
              studentId: student.id,
              action: "ASSIGNED"
          }
      });

      return student;
  });

}

export async function checkIfRegNoExists(
  registrationNumber: string,
  studentId: string | undefined,
  teacherId: string
) {
  const student = await prisma.student.findFirst({
    where: {
      teacherId,
      registrationNumber,
      ...(studentId
        ? {
            NOT: {
              id: studentId,
            },
          }
        : {}),
    },
    select: {
      id: true,
    },
  });

  return {
    exists: !!student,
  };
}

export async function checkIfEmailExists(
  email: string,
  studentId: string | undefined,
  teacherId: string
) {
  const normalizedEmail = email.trim().toLowerCase();

  const student = await prisma.student.findFirst({
    where: {
      teacherId,
      email: normalizedEmail,
      ...(studentId && {
        NOT: {
          id: studentId,
        },
      }),
    },
    select: {
      id: true,
    },
  });

  return {
    exists: !!student,
  };
}

export async function checkIfNameExists(
  name: string,
  studentId: string | undefined,
  teacherId: string
) {
  const normalizedName = name.trim();

  const student = await prisma.student.findFirst({
    where: {
      teacherId,
      name: {
        equals: normalizedName,
        mode: "insensitive",
      },
      ...(studentId && {
        NOT: {
          id: studentId,
        },
      }),
    },
    select: {
      id: true,
    },
  });

  return {
    exists: !!student,
  };
}