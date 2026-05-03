import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import type { CreateGuardianInput, UpdateGuardianInput } from "@/lib/guardian-validation";
import type { CreateStudentInput, UpdateStudentInput } from "@/lib/student-validation";

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

async function generateStudentRegistrationNumber(teacherName: string) {
  const year = new Date().getFullYear();
  const teacherCode = buildShortCode(teacherName, 3);
  const prefix = `${teacherCode}-${year}`;

  const currentCount = await prisma.student.count({
    where: {
      registrationNumber: {
        startsWith: `${prefix}-`,
      },
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

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const registrationNumber = await generateStudentRegistrationNumber(teacher.name);
    const passwordHash = await bcrypt.hash(registrationNumber, HASH_ROUNDS);

    try {
      return await prisma.student.create({
        data: {
          name: input.name,
          grade: input.grade,
          password: passwordHash,
          contact: input.contact01,
          contact01: input.contact01,
          contact02: input.contact02,
          email: input.email,
          registrationNumber,
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

    const record = await prisma.classStudent.create({
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
  grade?: string;
}) {
  const where = {
    ...(params.name
      ? {
          name: {
            contains: params.name,
            mode: "insensitive" as const,
          },
        }
      : {}),
    ...(params.grade
      ? {
          grade: params.grade as
            | "GRADE_01"
            | "GRADE_02"
            | "GRADE_03"
            | "GRADE_04"
            | "GRADE_05"
            | "GRADE_06"
            | "GRADE_07"
            | "GRADE_08"
            | "GRADE_09"
            | "GRADE_10"
            | "GRADE_11"
            | "GRADE_12"
            | "GRADE_13",
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
            isActive: true,
            class: {
              teacherId: params.teacherId,
            },
          },
        },
      },
    ],
  };

  const [students, totalItems] = await Promise.all([
    prisma.student.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: {
        createdAt: "desc",
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

export async function getStudentProfileForTeacher(teacherId: string, studentId: string) {
  const student = await prisma.student.findUnique({
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

  const hasTeacherClass = student.classes.length > 0;
  const isUnassigned = await prisma.classStudent.count({ where: { studentId, isActive: true } });

  if (!hasTeacherClass && isUnassigned > 0) {
    throw new AppError("Student not available for this teacher.", 403, "FORBIDDEN");
  }

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
  const profile = await getStudentProfileForTeacher(teacherId, studentId);

  if (!profile) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }

  return prisma.student.update({
    where: {
      id: studentId,
    },
    data: {
      name: input.name,
      grade: input.grade,
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

  return prisma.classStudent.update({
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
