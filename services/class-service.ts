import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { nowInSriLanka } from "@/lib/time";
import { TeacherClass } from "@/types/teacherProfileTypes/ClassTeacher";
import { ClassLectureSession } from "@/types/teacherProfileTypes/ClassLectureSession";
import { ClassPublicNote } from "@/types/teacherProfileTypes/ClassPublicNote";

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
  startDate: string;
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
    status:0,
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
        startDate: true,
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
            studentId:true,
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

export async function getClassByIdForTeacher(
  classId: string,
  teacherId: string
) {
  const classInfo = await prisma.class.findFirst({
    where: {
      id: classId,
      teacherId,
      status: 0,
    },
    include: {
      schedules: true,
      students: {
        include: {
          student: true,
        },
      },
    },
  });

  if (!classInfo) {
    throw new AppError(
      "Class not found.",
      404,
      "NOT_FOUND"
    );
  }

  return classInfo;
}

export async function getPublicClass(
  classId: string
): Promise<TeacherClass> {
  const classInfo = await prisma.class.findFirst({
    where: {
      id: classId,
      status: 0,
    },
    include: {
      schedules: true,
      teacher: {
        select: {
          profile: {
            select: {
              slug: true,
            },
          },
        },
      },
      students: {
        select: {
          id: true,
          isActive: true,
        },
      },
    },
  });

  if (!classInfo) {
    throw new AppError(
      "Class not found.",
      404,
      "NOT_FOUND"
    );
  }

  const result: TeacherClass = {
    id: classInfo.id,
    name: classInfo.name,
    description: classInfo.description,
    monthlyFee: classInfo.monthlyFee,
    paymentDueWeek: classInfo.paymentDueWeek,
    teacherId:classInfo.teacherId,
    teacherSlug: classInfo.teacher?.profile?.slug ?? null,
    startDate: classInfo.startDate
  ? classInfo.startDate.toISOString()
  : null,
    schedule: classInfo.schedule,

    schedules: classInfo.schedules.map(schedule => ({
      id: schedule.id,
      dayOfWeek: schedule.dayOfWeek,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
    })),

    students: classInfo.students.map(student => ({
      id: student.id,
      isActive: student.isActive,
    })),
  };

  return result;
}

/**
 * Public course sessions for a class: lectures that have at least one
 * publicly visible recording, newest lecture first. Each lecture keeps all of
 * its public recordings ordered by when the recording started (oldest first),
 * so the UI can number them 1, 2, 3. Recordings marked LOCKED are still
 * returned so the page can render them behind a lock.
 */
export async function getPublicClassSessions(
  classId: string
): Promise<ClassLectureSession[]> {
  const lectures = await prisma.lecture.findMany({
    where: {
      classId,
      youtubeRecordings: {
        some: {
          visibility: "PUBLIC",
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      title: true,
      date: true,
      createdAt: true,
      youtubeRecordings: {
        where: {
          visibility: "PUBLIC",
        },
        orderBy: {
          startedAt: "asc",
        },
        select: {
          id: true,
          videoId: true,
          youtubeUrl: true,
          access: true,
          startedAt: true,
          endedAt: true,
        },
      },
    },
  });

  return lectures.map((lecture) => ({
    id: lecture.id,
    title: lecture.title,
    date: lecture.date.toISOString(),
    createdAt: lecture.createdAt.toISOString(),
    recordings: lecture.youtubeRecordings.map((recording) => ({
      id: recording.id,
      videoId: recording.videoId,
      youtubeUrl: recording.youtubeUrl,
      access: recording.access,
      startedAt: recording.startedAt
        ? recording.startedAt.toISOString()
        : null,
      endedAt: recording.endedAt
        ? recording.endedAt.toISOString()
        : null,
    })),
  }));
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "—";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }

  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function fileTypeFromMime(mimeType: string, fileUrl: string): string {
  const normalized = (mimeType || "").toLowerCase();

  if (normalized.includes("pdf")) return "PDF";
  if (normalized.includes("word") || normalized.includes("msword")) return "DOCX";
  if (normalized.includes("zip") || normalized.includes("compressed")) return "ZIP";
  if (normalized.startsWith("image/")) {
    return normalized.replace("image/", "").toUpperCase();
  }

  const extension = fileUrl.split(".").pop();
  if (extension && extension !== fileUrl) {
    return extension.toUpperCase();
  }

  return "FILE";
}

/**
 * Public lecture notes for a class: every note a teacher has marked as PUBLIC,
 * grouped conceptually by lecture. Each note is returned with its parent
 * lecture's title so the class page can show "Lecture 01 – Algebra" style
 * entries. FREE notes can be previewed by anyone; LOCKED notes are still
 * returned so the page can render them behind a lock.
 */
export async function getPublicClassNotes(
  classId: string
): Promise<ClassPublicNote[]> {
  const notes = await prisma.note.findMany({
    where: {
      visibility: "PUBLIC",
      lecture: {
        classId,
      },
    },
    orderBy: [
      { lecture: { createdAt: "asc" } },
      { lecture: { date: "asc" } },
      { title: "asc" },
    ],
    select: {
      id: true,
      title: true,
      fileUrl: true,
      mimeType: true,
      sizeBytes: true,
      access: true,
      lecture: {
        select: {
          id: true,
          title: true,
        },
      },
    },
  });

  return notes.map((note) => {
    const fileType = fileTypeFromMime(note.mimeType, note.fileUrl);
    const isImage = (note.mimeType || "").toLowerCase().startsWith("image/");

    return {
      id: note.id,
      lectureId: note.lecture.id,
      lectureTitle: note.lecture.title,
      title: note.title,
      fileType,
      fileSize: formatFileSize(note.sizeBytes),
      isPdf: fileType === "PDF",
      isImage,
      access: note.access,
    };
  });
}

/**
 * Fetch a single note for public consumption. Only notes that are both PUBLIC
 * and FREE are returned; anything else is treated as not found so locked
 * material never leaks through the public preview endpoint.
 */
export async function getPublicFreeNote(noteId: string) {
  const note = await prisma.note.findFirst({
    where: {
      id: noteId,
      visibility: "PUBLIC",
      access: "FREE",
    },
    select: {
      id: true,
      title: true,
      fileUrl: true,
      mimeType: true,
    },
  });

  if (!note) {
    throw new AppError("Note not found.", 404, "NOT_FOUND");
  }

  return note;
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
      startDate: new Date(input.startDate),
      // Open the first fee period from now; it stays open (effectiveTo = null)
      // until the fee is changed.
      feeHistory: {
        create: {
          amount: input.monthlyFee,
          effectiveFrom: nowInSriLanka(),
        },
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

/**
 * Guarantee a class has at least one fee-history row. Older classes created
 * before fee history existed are back-filled with an open period covering their
 * current fee.
 */
async function ensureInitialClassFee(
  tx: Prisma.TransactionClient,
  classId: string,
  currentFee: number
) {
  const count = await tx.classFee.count({ where: { classId } });

  if (count === 0) {
    await tx.classFee.create({
      data: {
        classId,
        amount: currentFee,
        effectiveFrom: nowInSriLanka(),
      },
    });
  }
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
    select: { id: true, monthlyFee: true },
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

    // When the fee actually changes, close the current fee period and open a
    // new one starting at the moment of the change.
    if (
      input.monthlyFee !== undefined &&
      input.monthlyFee !== existingClass.monthlyFee
    ) {
      const changedAt = nowInSriLanka();

      await ensureInitialClassFee(tx, classId, existingClass.monthlyFee);

      await tx.classFee.updateMany({
        where: { classId, effectiveTo: null },
        data: { effectiveTo: changedAt },
      });

      await tx.classFee.create({
        data: {
          classId,
          amount: input.monthlyFee,
          effectiveFrom: changedAt,
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

export type ClassFeeHistoryEntry = {
  id: string;
  amount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
};

/**
 * Full fee history for a class, newest period first. The open period
 * (effectiveTo = null) is flagged as current.
 */
export async function getClassFeeHistoryForTeacher(
  classId: string,
  teacherId: string
): Promise<ClassFeeHistoryEntry[]> {
  const classInfo = await prisma.class.findFirst({
    where: {
      id: classId,
      teacherId,
    },
    select: { id: true, monthlyFee: true },
  });

  if (!classInfo) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  await prisma.$transaction((tx) =>
    ensureInitialClassFee(tx, classId, classInfo.monthlyFee)
  );

  const rows = await prisma.classFee.findMany({
    where: { classId },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    amount: row.amount,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    isCurrent: row.effectiveTo === null,
  }));
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

export async function deactivateClassForTeacher(
  classId: string,
  teacherId: string
) {
  return prisma.class.update({
    where: {
      id: classId,
      teacherId,
    },
    data: {
      status: 1,
    },
  });
}
