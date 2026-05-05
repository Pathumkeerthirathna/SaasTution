import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";

type ListClassesParams = {
  teacherId: string;
  skip: number;
  take: number;
  name?: string;
  schedule?: string;
};

type ClassWriteInput = {
  name: string;
  description?: string;
  monthlyFee: number;
  paymentDueWeek: number;
  schedule?: string;
  schedules: {
    dayOfWeek: "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY";
    startTime: string;
    endTime: string;
  }[];
};

function getDayLabel(dayOfWeek: ClassWriteInput["schedules"][number]["dayOfWeek"]) {
  switch (dayOfWeek) {
    case "SUNDAY":
      return "Sun";
    case "MONDAY":
      return "Mon";
    case "TUESDAY":
      return "Tue";
    case "WEDNESDAY":
      return "Wed";
    case "THURSDAY":
      return "Thu";
    case "FRIDAY":
      return "Fri";
    case "SATURDAY":
      return "Sat";
  }
}

function buildScheduleSummary(schedules: ClassWriteInput["schedules"]) {
  return schedules.map((item) => `${getDayLabel(item.dayOfWeek)} ${item.startTime}-${item.endTime}`).join(" | ");
}

export async function listClassesByTeacher(params: ListClassesParams) {
  const where = {
    teacherId: params.teacherId,
    ...(params.name
      ? {
          name: {
            contains: params.name,
            mode: "insensitive" as const,
          },
        }
      : {}),
    ...(params.schedule
      ? {
          schedule: {
            contains: params.schedule,
            mode: "insensitive" as const,
          },
        }
      : {}),
  };

  const [classes, totalItems] = await Promise.all([
    prisma.class.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        monthlyFee: true,
        paymentDueWeek: true,
        schedule: true,
        schedules: {
          select: {
            id: true,
            dayOfWeek: true,
            startTime: true,
            endTime: true,
          },
          orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
        },
        createdAt: true,
        students: {
          select: {
            id: true,
            isActive: true,
            assignedAt: true,
            removedAt: true,
            removeReason: true,
            student: {
              select: {
                id: true,
                name: true,
                registrationNumber: true,
              },
            },
          },
          orderBy: [{ assignedAt: "desc" }],
        },
      },
    }),
    prisma.class.count({
      where,
    }),
  ]);

  return {
    classes,
    totalItems,
  };
}

export async function createClassForTeacher(teacherId: string, input: ClassWriteInput) {
  const scheduleSummary = input.schedule?.trim() || buildScheduleSummary(input.schedules);

  return prisma.class.create({
    data: {
      teacherId,
      name: input.name,
      description: input.description,
      monthlyFee: input.monthlyFee,
      paymentDueWeek: input.paymentDueWeek,
      schedule: scheduleSummary,
      schedules: {
        create: input.schedules,
      },
    },
    select: {
      id: true,
      name: true,
      description: true,
      monthlyFee: true,
      paymentDueWeek: true,
      schedule: true,
      schedules: {
        select: {
          id: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
        },
        orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
      },
      createdAt: true,
    },
  });
}

export async function updateClassForTeacher(
  classId: string,
  teacherId: string,
  input: {
    name?: string;
    description?: string;
    monthlyFee?: number;
    paymentDueWeek?: number;
    schedule?: string;
    schedules?: {
      dayOfWeek: "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY";
      startTime: string;
      endTime: string;
    }[];
  }
) {
  const existingClass = await prisma.class.findFirst({
    where: {
      id: classId,
      teacherId,
    },
    select: { id: true },
  });

  if (!existingClass) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  return prisma.$transaction(async (tx) => {
    if (input.schedules) {
      await tx.classSchedule.deleteMany({
        where: {
          classId,
        },
      });
    }

    const scheduleSummary = input.schedule?.trim()
      ? input.schedule
      : input.schedules
        ? buildScheduleSummary(input.schedules)
        : undefined;

    return tx.class.update({
      where: {
        id: classId,
      },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.monthlyFee !== undefined ? { monthlyFee: input.monthlyFee } : {}),
        ...(input.paymentDueWeek !== undefined ? { paymentDueWeek: input.paymentDueWeek } : {}),
        ...(scheduleSummary !== undefined ? { schedule: scheduleSummary } : {}),
        ...(input.schedules
          ? {
              schedules: {
                create: input.schedules,
              },
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        monthlyFee: true,
        paymentDueWeek: true,
        schedule: true,
        schedules: {
          select: {
            id: true,
            dayOfWeek: true,
            startTime: true,
            endTime: true,
          },
          orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
        },
        createdAt: true,
      },
    });
  });
}

export async function deleteClassForTeacher(classId: string, teacherId: string) {
  const existingClass = await prisma.class.findFirst({
    where: {
      id: classId,
      teacherId,
    },
    select: { id: true },
  });

  if (!existingClass) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  await prisma.class.delete({
    where: {
      id: classId,
    },
  });
}
