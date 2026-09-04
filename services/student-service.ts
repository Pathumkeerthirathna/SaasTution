import { Prisma, StudentClassAction, StudentConfirmationStatus, StudentRegistrationSource } from "@prisma/client";
import bcrypt from "bcryptjs";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { emitStudentDataChange } from "@/lib/session-events";
import { nowInSriLanka } from "@/lib/time";
import type { CreateGuardianInput, UpdateGuardianInput } from "@/lib/guardian-validation";
import type { CreateStudentInput, UpdateStudentInput } from "@/lib/student-validation";
import { RegisterStudentRequest } from "@/types/teacherProfileTypes/RegisterStudentRequest";
import { requireTeacherSession } from "@/lib/auth-session";

import {
  sendEmail,
  sendStudentRegistrationEmail,
} from "@/lib/mailer";

import {
  getStudentRegistrationEmail,
} from "@/emails/StudentRegistrationEmail";
import { ClassroomStudent } from "@/components/Jitsi/types";

const HASH_ROUNDS = 12;

async function assertTeacherOwnsClass(classId: string, teacherId: string) {
  const classroom = await prisma.class.findFirst({
    where: {
      id: classId,
      teacherId,
      status: 0,
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
      const student = await prisma.student.create({
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
          registrationSource:StudentRegistrationSource.TEACHER,
          confirmationStatus:StudentConfirmationStatus.APPROVED
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

       if (student.email) {
        try {
          await sendStudentRegistrationEmail({
            to: student.email,
            studentName: student.name,
            registrationNumber: student.registrationNumber??"",
            teacherName: teacher.name,
            className: "No classes assigned yet", // or another value if you want
            registrationDate: new Date().toLocaleDateString(),
          });
        } catch (err) {
          console.error("Email sending failed:", err);
        }
      }

      return student;

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

  const student = await prisma.student.findFirst({
    where: {
      id: studentId,
      teacherId,
      status: 0,
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
      const assignedAt = nowInSriLanka();

      const assignment = await tx.classStudent.create({
        data: {
          classId,
          studentId,
          isActive: true,
          assignedAt,
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
          actionDate: assignedAt,
        },
      });

      return assignment;
    });

    // Realtime: the student's "My Classes" page should show this class immediately.
    emitStudentDataChange({ studentId });

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
  email?: string;
  gradeId?: number;
  sortBy?: string;
  sortOrder?: string;
  registrationNumber?: string; // <-- Add this
  status?: number; // 0 = active, 1 = inactive; omitted = active + inactive

}) {

  const where = {
    teacherId: params.teacherId,
    status:
      params.status === 0 || params.status === 1
        ? params.status
        : {
            not: 2,
          },
    ...(params.registrationNumber
    ? {
        registrationNumber: {
          contains: params.registrationNumber,
          mode: "insensitive" as const,
        },
      }
    : {}),
    ...(params.name
      ? {
          name: {
            contains: params.name,
            mode: "insensitive" as const,
          },
        }
      : {}),
    ...(params.email
    ? {
        email: {
          contains: params.email,
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

const secondaryOrderBy: Prisma.StudentOrderByWithRelationInput =
  params.sortBy === "Name"
    ? { name: sortOrder }
    : params.sortBy === "RegistrationNumber"
    ? { registrationNumber: sortOrder }
    : params.sortBy === "CreatedAt"
    ? { createdAt: sortOrder }
    : { createdAt: "desc" };

const orderBy: Prisma.StudentOrderByWithRelationInput[] = [
  {
    confirmationStatus: "asc", // PENDING → APPROVED → REJECTED
  },
  secondaryOrderBy,
  // Tiebreaker so pagination stays stable when the primary sort field
  // (e.g. createdAt) has duplicate values across students.
  ...(params.sortBy === "RegistrationNumber"
    ? []
    : [{ registrationNumber: sortOrder } as Prisma.StudentOrderByWithRelationInput]),
];

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
        deactivationReason: true,
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
        registrationSource:true,
        confirmationStatus:true,
        confirmedAt:true,
        registeredAt:true,
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
      deactivationReason: student.deactivationReason ?? null,
      gradeId: student.gradeId,
      grade: student.grade,

      contact01: student.contact01,
      contact02: student.contact02,
      email: student.email,

      createdAt: student.createdAt,
      registrationNumber: student.registrationNumber ?? null,
      StudentRegistrationSource:student.registrationSource,
      StudentConfirmationStatus:student.confirmationStatus,
      confirmedAt:student.confirmedAt,
      registeredAt:student.registeredAt,
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
      deactivationReason: null,
    },
  });
}

export async function deactivateStudentForTeacher(
  teacherId: string,
  studentId: string,
  reason: string
) {
  const trimmedReason = reason.trim();

  if (trimmedReason.length < 3) {
    throw new AppError(
      "A reason is required to deactivate a student.",
      400,
      "VALIDATION_ERROR"
    );
  }

  return prisma.student.updateMany({
    where: {
      id: studentId,
      teacherId,
    },
    data: {
      status: 1,
      actionTakenDate: new Date(),
      deactivationReason: trimmedReason.slice(0, 500),
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

  const result = await prisma.$transaction(async (tx) => {
    const removedAt = nowInSriLanka();

    const assignment = await tx.classStudent.update({
      where: {
        id: activeAssignment.id,
      },
      data: {
        isActive: false,
        removedAt,
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
        actionDate: removedAt,
        reason: params.reason,
      },
    });

    return assignment;
  });

  // Realtime: the student's "My Classes" page should drop this class immediately.
  emitStudentDataChange({ studentId: params.studentId });

  return result;
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

async function assertTeacherOwnsStudent(teacherId: string, studentId: string) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, teacherId },
    select: { id: true },
  });

  if (!student) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }
}

const guardianSelect = {
  id: true,
  studentId: true,
  name: true,
  relation: true,
  phone: true,
  email: true,
  createdAt: true,
} as const;

export async function listGuardiansForTeacher(
  teacherId: string,
  studentId: string
) {
  await assertTeacherOwnsStudent(teacherId, studentId);

  return prisma.guardian.findMany({
    where: { studentId },
    orderBy: { createdAt: "asc" },
    select: guardianSelect,
  });
}

export async function deleteGuardianForTeacher(
  teacherId: string,
  guardianId: string
) {
  const guardian = await prisma.guardian.findUnique({
    where: { id: guardianId },
    select: { id: true, studentId: true },
  });

  if (!guardian) {
    throw new AppError("Guardian not found.", 404, "GUARDIAN_NOT_FOUND");
  }

  await assertTeacherOwnsStudent(teacherId, guardian.studentId);

  await prisma.guardian.delete({ where: { id: guardianId } });
  return { success: true };
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
        student: { status: 0 },
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
        student: { status: 0 },
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
              submittedAt: "desc",
            },
            select: {
              id: true,
              amount: true,
              status: true,
              submittedAt: true,
              confirmedAt: true,
              classStudentFee: {
                select: { year: true, month: true },
              },
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
      status: 0,
      class: { status: 0 },
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
      status: 0,
      lecture: {
        classId,
        status: 0,
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
      startDateTime: true,
      endDateTime: true,

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
      lectureId: quiz.lecture.id,
      lectureTitle: quiz.lecture.title,
      lectureDate: quiz.lecture.date,
      startDateTime: quiz.startDateTime,
      endDateTime: quiz.endDateTime,

      attempted: !!submission,

      score: submission?.score ?? null,
      totalQuestions: submission?.totalQuestions ?? null,
      percentage:
        submission && submission.totalQuestions > 0
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
          status: 0,
        },
      });

      const attendedLectures = await prisma.lecture.count({
        where: {
          classId: studentClass.classId,
          status: 0,
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

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Builds the student's payment position from the ClassStudentFee ledger.
 *
 * Every ClassStudentFee row is a charge the student owes for one class in one
 * month. A row counts as "done" when it carries a CONFIRMED ClassPayment;
 * everything else is "not done". Amounts are the row's finalAmount.
 */
export async function getStudentPaymentSummary(studentId: string) {
  const feeRows = await prisma.classStudentFee.findMany({
    where: {
      classStudent: { studentId },
    },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: {
      id: true,
      year: true,
      month: true,
      finalAmount: true,
      dueDate: true,
      status: true,
      classStudent: {
        select: {
          class: {
            select: { id: true, name: true, monthlyFee: true },
          },
        },
      },
      payments: {
        orderBy: { submittedAt: "desc" },
        select: {
          id: true,
          amount: true,
          status: true,
          submittedAt: true,
          confirmedAt: true,
        },
      },
    },
  });

  type ClassBucket = {
    classId: string;
    className: string;
    monthlyFee: number;
    paidCount: number;
    unpaidCount: number;
    paidAmount: number;
    unpaidAmount: number;
    totalAmount: number;
    fees: Array<{
      id: string;
      year: number;
      month: number;
      monthLabel: string;
      finalAmount: number;
      dueDate: string | null;
      paid: boolean;
      payment: {
        id: string;
        amount: number;
        status: string;
        submittedAt: string | null;
        confirmedAt: string | null;
      } | null;
    }>;
  };

  const buckets = new Map<string, ClassBucket>();

  let paidCount = 0;
  let unpaidCount = 0;
  let paidAmount = 0;
  let unpaidAmount = 0;

  for (const row of feeRows) {
    const cls = row.classStudent.class;

    const confirmed = row.payments.find((p) => p.status === "CONFIRMED");
    const latest = row.payments[0] ?? null;
    const paid = Boolean(confirmed) || row.status === 1;

    const chosen = confirmed ?? latest;

    if (paid) {
      paidCount += 1;
      paidAmount += row.finalAmount;
    } else {
      unpaidCount += 1;
      unpaidAmount += row.finalAmount;
    }

    let bucket = buckets.get(cls.id);
    if (!bucket) {
      bucket = {
        classId: cls.id,
        className: cls.name,
        monthlyFee: cls.monthlyFee,
        paidCount: 0,
        unpaidCount: 0,
        paidAmount: 0,
        unpaidAmount: 0,
        totalAmount: 0,
        fees: [],
      };
      buckets.set(cls.id, bucket);
    }

    bucket.totalAmount += row.finalAmount;
    if (paid) {
      bucket.paidCount += 1;
      bucket.paidAmount += row.finalAmount;
    } else {
      bucket.unpaidCount += 1;
      bucket.unpaidAmount += row.finalAmount;
    }

    bucket.fees.push({
      id: row.id,
      year: row.year,
      month: row.month,
      monthLabel: `${MONTH_LABELS[row.month - 1] ?? row.month} ${row.year}`,
      finalAmount: row.finalAmount,
      dueDate: row.dueDate ? row.dueDate.toISOString() : null,
      paid,
      payment: chosen
        ? {
            id: chosen.id,
            amount: chosen.amount,
            status: chosen.status,
            submittedAt: chosen.submittedAt
              ? chosen.submittedAt.toISOString()
              : null,
            confirmedAt: chosen.confirmedAt
              ? chosen.confirmedAt.toISOString()
              : null,
          }
        : null,
    });
  }

  const totalAmount = paidAmount + unpaidAmount;

  return {
    summary: {
      totalFees: feeRows.length,
      paidCount,
      unpaidCount,
      paidAmount,
      unpaidAmount,
      totalAmount,
      paidPercent:
        totalAmount === 0
          ? 0
          : Math.round((paidAmount / totalAmount) * 100),
    },
    classes: [...buckets.values()],
  };
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
          status: 0,
          lecture: {
            classId: studentClass.classId,
            status: 0,
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
      status: 0,
      lecture: {
        classId,
        status: 0,
      },
    },
    orderBy: {
      startDateTime: "desc",
    },
    select: {
      id: true,
      title: true,
      startDateTime: true,
      endDateTime: true,

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
      startDateTime: quiz.startDateTime,
      endDateTime: quiz.endDateTime,

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


// export async function RegisterStudentViaPublicClasses(request:RegisterStudentRequest){

//   // Find class
//   const cls = await prisma.class.findUnique({
//       where: { id: request.classId }
//   });

//   if (!cls) {
//       throw new Error("Class not found");
//   }

//   const teacher = await prisma.teacher.findUnique({
//       where: { id: cls.teacherId }
//   });

//   const regNo = await generateStudentRegistrationNumber(
//       teacher?.name ?? "",teacher?.id??""
//   );

//   await prisma.$transaction(async (tx) => {
      
//       const student = await tx.student.create({
//           data: {
//               name: request.studentName,
//               registrationNumber:regNo,
//               teacherId: cls.teacherId,
//               contact: request.mobileNumber,
//               contact01: request.mobileNumber,
//               contact02:request.parentMobileNumber,
//               gradeId: request.gradeId,
//               email:request.email??""
//           }
//       });

//       // assign class

//       await tx.classStudent.create({
//           data: {
//               classId: cls.id,
//               studentId: student.id
//           }
//       });

//       // history

//       await tx.classStudentHistory.create({
//           data: {
//               classId: cls.id,
//               studentId: student.id,
//               action: "ASSIGNED"
//           }
//       });

//       return student;
//   });

//   return {
//     registrationNumber: regNo,
//   };

// }

export async function RegisterStudentViaPublicClasses(
  request: RegisterStudentRequest
) {
  const cls = await prisma.class.findFirst({
    where: { id: request.classId, status: 0 },
  });

  if (!cls) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  const emailValue = request.email?.trim();
  if (emailValue) {
    const existingByEmail = await prisma.student.findFirst({
      where: {
        teacherId: cls.teacherId,
        email: { equals: emailValue, mode: "insensitive" },
      },
      select: { id: true },
    });

    if (existingByEmail) {
      throw new AppError(
        "A student is already registered with this email address.",
        409,
        "EMAIL_EXISTS"
      );
    }
  }

  const teacher = await prisma.teacher.findUnique({
    where: { id: cls.teacherId },
  });

  const regNo = await generateStudentRegistrationNumber(
    teacher?.name ?? "",
    teacher?.id ?? ""
  );

  const student = await prisma.$transaction(async (tx) => {
    const student = await tx.student.create({
      data: {
        name: request.studentName,
        registrationNumber: regNo,
        teacherId: cls.teacherId,
        contact: request.mobileNumber,
        contact01: request.mobileNumber,
        contact02: request.parentMobileNumber,
        gradeId: request.gradeId,
        email: emailValue ? emailValue.toLowerCase() : "",

        registrationSource: "PUBLIC_CLASS",
        publicClassId: cls.id,

        confirmationStatus: "PENDING",

      },
    });

    const assignedAt = nowInSriLanka();

    await tx.classStudent.create({
      data: {
        classId: cls.id,
        studentId: student.id,
        assignedAt,
      },
    });

    await tx.classStudentHistory.create({
      data: {
        classId: cls.id,
        studentId: student.id,
        action: "ASSIGNED",
        actionDate: assignedAt,
      },
    });

    // await sendStudentRegistrationEmail({
    //   to: request.email!,
    //   studentName: student.name,
    //   registrationNumber: regNo,
    //   teacherName: teacher?.name ?? "",
    //   className: cls.name,
    //   registrationDate: new Date().toLocaleDateString(),
    // });

    return student;
  });

  try {
    await sendStudentRegistrationEmail({
        to: request.email!,
        studentName: student.name,
        registrationNumber: regNo,
        teacherName: teacher?.name ?? "",
        className: cls.name,
        registrationDate: new Date().toLocaleDateString(),
    });
    } catch (err) {
        console.error("Email sending failed:", err);
    }

  return {
    student,
    registrationNumber: regNo,
  };
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
  teacherId: string,
  gradeId?: number | null
) {
  const normalizedName = name.trim();

  const student = await prisma.student.findFirst({
    where: {
      teacherId,
      name: {
        equals: normalizedName,
        mode: "insensitive",
      },
      // A name is only a clash within the same grade.
      ...(gradeId ? { gradeId } : {}),
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


export async function confirmStudent(studentId: string) {
  const student = await prisma.student.findUnique({
    where: {
      id: studentId,
    },
    select: {
      id: true,
      confirmationStatus: true,
    },
  });

  if (!student) {
    throw new Error("Student not found.");
  }

  if (student.confirmationStatus === StudentConfirmationStatus.APPROVED) {
    throw new Error("Student is already confirmed.");
  }

  await prisma.student.update({
    where: {
      id: studentId,
    },
    data: {
      confirmationStatus: StudentConfirmationStatus.APPROVED,
      confirmedAt: new Date(),
    },
  });
}

export async function confirmAllPendingStudents() {
  const result = await prisma.student.updateMany({
    where: {
      confirmationStatus: StudentConfirmationStatus.PENDING,
    },
    data: {
      confirmationStatus: StudentConfirmationStatus.APPROVED,
      confirmedAt: new Date(),
    },
  });

  return result.count;
}


export async function declineStudent(studentId: string) {
  const student = await prisma.student.findUnique({
    where: {
      id: studentId,
    },
    select: {
      id: true,
      confirmationStatus: true,
    },
  });

  if (!student) {
    throw new Error("Student not found.");
  }

  if (student.confirmationStatus === StudentConfirmationStatus.REJECTED) {
    throw new Error("Student is already confirmed.");
  }

  await prisma.student.update({
    where: {
      id: studentId,
    },
    data: {
      confirmationStatus: StudentConfirmationStatus.REJECTED,
      confirmedAt: new Date(),
    },
  });
}


export async function listStudentsForClassroom(params: {
  teacherId: string;
  classId: string;
}): Promise<ClassroomStudent[]> {
  await assertTeacherOwnsClass(
    params.classId,
    params.teacherId
  );

  const classStudents = await prisma.classStudent.findMany({
    where: {
      classId: params.classId,
      isActive: true,
      student: { status: 0 },
    },
    orderBy: {
      assignedAt: "asc",
    },
    select: {
      student: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  return classStudents.map(({ student }) => ({
    studentId: student.id,
    displayName: student.name,
    email: student.email,
  }));
}
export type AttendanceStatusLabel =
  | "Excellent"
  | "Good"
  | "At Risk"
  | "Poor";

export function classifyAttendance(pct: number): AttendanceStatusLabel {
  if (pct >= 90) return "Excellent";
  if (pct >= 75) return "Good";
  if (pct >= 60) return "At Risk";
  return "Poor";
}

export interface AttendanceAnalyticsMonth {
  key: string;
  label: string;
  year: number;
  month: number;
  attended: number;
  total: number;
  percent: number;
  isCurrent: boolean;
}

export interface AttendanceAnalytics {
  monthsBack: number;
  attendanceRate: number;
  status: AttendanceStatusLabel;
  attended: number;
  totalClasses: number;
  trendDelta: number;
  trendDirection: "up" | "down" | "flat";
  averageDuration: number | null;
  targetLine: number;
  monthly: AttendanceAnalyticsMonth[];
}

/**
 * Attendance health + monthly trend for a single student, aggregated across
 * every class the student is (or was) enrolled in.
 *
 * - A lecture counts as "attended" when the student has at least one Attendance
 *   row on any of that lecture's sessions.
 * - The headline rate is all-time; the chart series covers the last `months`
 *   calendar months.
 * - Average duration is the mean of (time present / session length) over
 *   sessions where both the student left-time and the session end-time are known.
 */
export async function getStudentAttendanceAnalytics(
  studentId: string,
  options: { months?: number } = {}
): Promise<AttendanceAnalytics> {
  const monthsBack = Math.min(Math.max(options.months ?? 6, 3), 12);

  const enrolments = await prisma.classStudent.findMany({
    where: { studentId },
    select: { classId: true },
  });
  const classIds = [...new Set(enrolments.map((e) => e.classId))];

  const now = new Date();
  const buckets = Array.from({ length: monthsBack }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1 - i), 1);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      label: MONTH_LABELS[d.getMonth()] ?? String(d.getMonth() + 1),
      attended: 0,
      total: 0,
    };
  });

  const emptyResult: AttendanceAnalytics = {
    monthsBack,
    attendanceRate: 0,
    status: classifyAttendance(0),
    attended: 0,
    totalClasses: 0,
    trendDelta: 0,
    trendDirection: "flat",
    averageDuration: null,
    targetLine: 75,
    monthly: buckets.map((b, idx) => ({
      key: `${b.year}-${String(b.month).padStart(2, "0")}`,
      label: b.label,
      year: b.year,
      month: b.month,
      attended: 0,
      total: 0,
      percent: 0,
      isCurrent: idx === buckets.length - 1,
    })),
  };

  if (classIds.length === 0) return emptyResult;

  const lectures = await prisma.lecture.findMany({
    where: { classId: { in: classIds }, status: 0 },
    select: {
      id: true,
      date: true,
      sessions: {
        select: {
          attendance: { where: { studentId }, select: { id: true } },
        },
      },
    },
  });

  const attended = (lecture: (typeof lectures)[number]) =>
    lecture.sessions.some((s) => s.attendance.length > 0);

  const totalAll = lectures.length;
  const attendedAll = lectures.filter(attended).length;
  const attendanceRate =
    totalAll === 0 ? 0 : Math.round((attendedAll / totalAll) * 100);

  const bucketIndex = new Map(
    buckets.map((b, idx) => [`${b.year}-${b.month}`, idx])
  );

  for (const lecture of lectures) {
    const d = new Date(lecture.date);
    const idx = bucketIndex.get(`${d.getFullYear()}-${d.getMonth() + 1}`);
    if (idx === undefined) continue;
    buckets[idx].total += 1;
    if (attended(lecture)) buckets[idx].attended += 1;
  }

  const monthly: AttendanceAnalyticsMonth[] = buckets.map((b, idx) => ({
    key: `${b.year}-${String(b.month).padStart(2, "0")}`,
    label: b.label,
    year: b.year,
    month: b.month,
    attended: b.attended,
    total: b.total,
    percent: b.total === 0 ? 0 : Math.round((b.attended / b.total) * 100),
    isCurrent: idx === buckets.length - 1,
  }));

  const current = monthly[monthly.length - 1];
  const previous = monthly[monthly.length - 2];
  const trendDelta =
    current && previous
      ? Number((current.percent - previous.percent).toFixed(1))
      : 0;

  const attendanceRecords = await prisma.attendance.findMany({
    where: {
      studentId,
      classId: { in: classIds },
      leftAt: { not: null },
      classSession: { endedAt: { not: null } },
    },
    select: {
      joinedAt: true,
      leftAt: true,
      classSession: { select: { startedAt: true, endedAt: true } },
    },
  });

  let durationSum = 0;
  let durationCount = 0;
  for (const rec of attendanceRecords) {
    const sessionMs =
      (rec.classSession.endedAt as Date).getTime() -
      rec.classSession.startedAt.getTime();
    const presentMs =
      (rec.leftAt as Date).getTime() - rec.joinedAt.getTime();
    if (sessionMs <= 0 || presentMs <= 0) continue;
    durationSum += Math.min(1, presentMs / sessionMs);
    durationCount += 1;
  }
  const averageDuration =
    durationCount === 0 ? null : Math.round((durationSum / durationCount) * 100);

  return {
    monthsBack,
    attendanceRate,
    status: classifyAttendance(attendanceRate),
    attended: attendedAll,
    totalClasses: totalAll,
    trendDelta,
    trendDirection: trendDelta > 0 ? "up" : trendDelta < 0 ? "down" : "flat",
    averageDuration,
    targetLine: 75,
    monthly,
  };
}

export type QuizStatusLabel =
  | "Excellent"
  | "Good"
  | "At Risk"
  | "Needs Attention";

export function classifyQuizScore(pct: number): QuizStatusLabel {
  if (pct >= 90) return "Excellent";
  if (pct >= 75) return "Good";
  if (pct >= 60) return "At Risk";
  return "Needs Attention";
}

export type QuizAnalyticsPeriod = "month" | "3months" | "year";

export interface QuizAnalyticsMonth {
  key: string;
  label: string;
  year: number;
  month: number;
  percent: number;
  count: number;
  isCurrent: boolean;
}

export interface QuizAnalyticsRecent {
  id: string;
  title: string;
  scorePercent: number;
  attempts: number;
  submittedAt: string;
}

export interface QuizAnalytics {
  period: QuizAnalyticsPeriod;
  averageScore: number;
  completed: number;
  totalQuizzes: number;
  bestScore: number;
  lowestScore: number;
  averageAttempts: number;
  trendDelta: number;
  trendDirection: "up" | "down" | "flat";
  status: QuizStatusLabel;
  targetLine: number;
  monthly: QuizAnalyticsMonth[];
  recent: QuizAnalyticsRecent[];
}

/**
 * Quiz performance health + monthly trend for a single student across every
 * class the student is (or was) enrolled in.
 *
 * - A student has at most one QuizSubmission per quiz; its `score` is the
 *   final score and `attemptCount` is how many tries were made.
 * - A quiz belongs to the selected period by its due date (falling back to its
 *   lecture date) and is only counted once that date has passed.
 * - The trend chart buckets submissions by `submittedAt` over the last 6 months
 *   (12 for the "year" period).
 */
export async function getStudentQuizAnalytics(
  studentId: string,
  options: { period?: QuizAnalyticsPeriod } = {}
): Promise<QuizAnalytics> {
  const period: QuizAnalyticsPeriod = options.period ?? "3months";
  const monthsBack = period === "year" ? 12 : 6;

  const now = new Date();
  const periodStart =
    period === "month"
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : period === "3months"
      ? new Date(now.getFullYear(), now.getMonth() - 2, 1)
      : new Date(now.getFullYear(), 0, 1);

  const buckets = Array.from({ length: monthsBack }, (_, i) => {
    const d = new Date(
      now.getFullYear(),
      now.getMonth() - (monthsBack - 1 - i),
      1
    );
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      label: MONTH_LABELS[d.getMonth()] ?? String(d.getMonth() + 1),
      sum: 0,
      count: 0,
    };
  });

  const buildMonthly = (): QuizAnalyticsMonth[] =>
    buckets.map((b, idx) => ({
      key: `${b.year}-${String(b.month).padStart(2, "0")}`,
      label: b.label,
      year: b.year,
      month: b.month,
      count: b.count,
      percent: b.count === 0 ? 0 : Math.round(b.sum / b.count),
      isCurrent: idx === buckets.length - 1,
    }));

  const enrolments = await prisma.classStudent.findMany({
    where: { studentId },
    select: { classId: true },
  });
  const classIds = [...new Set(enrolments.map((e) => e.classId))];

  const emptyResult: QuizAnalytics = {
    period,
    averageScore: 0,
    completed: 0,
    totalQuizzes: 0,
    bestScore: 0,
    lowestScore: 0,
    averageAttempts: 0,
    trendDelta: 0,
    trendDirection: "flat",
    status: classifyQuizScore(0),
    targetLine: 75,
    monthly: buildMonthly(),
    recent: [],
  };

  if (classIds.length === 0) return emptyResult;

  const quizzes = await prisma.quiz.findMany({
    where: { status: 0, lecture: { classId: { in: classIds }, status: 0 } },
    select: {
      id: true,
      title: true,
      endDateTime: true,
      lecture: { select: { date: true } },
      submissions: {
        where: { studentId },
        select: {
          score: true,
          totalQuestions: true,
          submittedAt: true,
          attemptCount: true,
        },
      },
    },
  });

  const pct = (score: number, total: number) =>
    total > 0 ? Math.round((score / total) * 100) : 0;

  const bucketIndex = new Map(
    buckets.map((b, idx) => [`${b.year}-${b.month}`, idx])
  );

  let periodTotal = 0;
  const periodScores: number[] = [];
  const periodAttempts: number[] = [];
  const recentPool: Array<QuizAnalyticsRecent & { ts: number }> = [];

  for (const quiz of quizzes) {
    const scheduled = quiz.endDateTime ?? quiz.lecture.date;
    const scheduledDate = new Date(scheduled);
    const inPeriod = scheduledDate >= periodStart && scheduledDate <= now;

    const submission = quiz.submissions[0] ?? null;

    if (inPeriod) {
      periodTotal += 1;

      if (submission) {
        const score = pct(submission.score, submission.totalQuestions);
        periodScores.push(score);
        periodAttempts.push(submission.attemptCount);
        recentPool.push({
          id: quiz.id,
          title: quiz.title,
          scorePercent: score,
          attempts: submission.attemptCount,
          submittedAt: submission.submittedAt.toISOString(),
          ts: submission.submittedAt.getTime(),
        });
      }
    }

    // Trend series is independent of the period filter.
    if (submission) {
      const d = new Date(submission.submittedAt);
      const idx = bucketIndex.get(`${d.getFullYear()}-${d.getMonth() + 1}`);
      if (idx !== undefined) {
        buckets[idx].sum += pct(submission.score, submission.totalQuestions);
        buckets[idx].count += 1;
      }
    }
  }

  const completed = periodScores.length;
  const averageScore =
    completed === 0
      ? 0
      : Math.round(periodScores.reduce((s, v) => s + v, 0) / completed);
  const bestScore = completed === 0 ? 0 : Math.max(...periodScores);
  const lowestScore = completed === 0 ? 0 : Math.min(...periodScores);
  const averageAttempts =
    completed === 0
      ? 0
      : Number(
          (
            periodAttempts.reduce((s, v) => s + v, 0) / completed
          ).toFixed(1)
        );

  const monthly = buildMonthly();
  const filled = monthly.filter((m) => m.count > 0);
  const last = filled[filled.length - 1];
  const prev = filled[filled.length - 2];
  const trendDelta =
    last && prev ? Number((last.percent - prev.percent).toFixed(1)) : 0;

  const recent = recentPool
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)
    .map(({ ts: _ts, ...rest }) => rest);

  return {
    period,
    averageScore,
    completed,
    totalQuizzes: periodTotal,
    bestScore,
    lowestScore,
    averageAttempts,
    trendDelta,
    trendDirection: trendDelta > 0 ? "up" : trendDelta < 0 ? "down" : "flat",
    status: classifyQuizScore(averageScore),
    targetLine: 75,
    monthly,
    recent,
  };
}
