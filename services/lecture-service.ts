import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import type {
  CreateAssignmentInput,
  CreateLectureInput,
  CreateQuizInput,
  UpdateAssignmentInput,
  UpdateLectureInput,
  UpdateNoteInput,
  UpdateQuizInput,
} from "@/lib/lecture-validation";

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

async function assertTeacherOwnsLecture(teacherId: string, lectureId: string) {
  const lecture = await prisma.lecture.findFirst({
    where: {
      id: lectureId,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
      title: true,
      classId: true,
      class: {
        select: {
          id: true,
          name: true,
          schedule: true,
        },
      },
    },
  });

  if (!lecture) {
    throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");
  }

  return lecture;
}

async function assertTeacherOwnsAssignment(teacherId: string, lectureId: string, assignmentId: string) {
  const assignment = await prisma.assignment.findFirst({
    where: {
      id: assignmentId,
      lectureId,
      lecture: {
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      description: true,
      dueDate: true,
    },
  });

  if (!assignment) {
    throw new AppError("Assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
  }

  return assignment;
}

async function assertTeacherOwnsQuiz(teacherId: string, lectureId: string, quizId: string) {
  const quiz = await prisma.quiz.findFirst({
    where: {
      id: quizId,
      lectureId,
      lecture: {
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
    },
  });

  if (!quiz) {
    throw new AppError("Quiz not found.", 404, "QUIZ_NOT_FOUND");
  }

  return quiz;
}

async function assertTeacherOwnsNote(teacherId: string, lectureId: string, noteId: string) {
  const note = await prisma.note.findFirst({
    where: {
      id: noteId,
      lectureId,
      lecture: {
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      fileUrl: true,
      kind: true,
      mimeType: true,
      sizeBytes: true,
      downloadCount: true,
      lastDownloadedAt: true,
    },
  });

  if (!note) {
    throw new AppError("Note not found.", 404, "NOTE_NOT_FOUND");
  }

  return note;
}

export async function createLectureForTeacher(teacherId: string, input: CreateLectureInput) {
  await assertTeacherOwnsClass(teacherId, input.classId);

  return prisma.lecture.create({
    data: {
      classId: input.classId,
      title: input.title,
      date: input.date,
    },
    select: {
      id: true,
      title: true,
      date: true,
      createdAt: true,
      class: {
        select: {
          id: true,
          name: true,
          schedule: true,
        },
      },
    },
  });
}

export async function updateLectureForTeacher(teacherId: string, lectureId: string, input: UpdateLectureInput) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.lecture.update({
    where: {
      id: lectureId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
    },
    select: {
      id: true,
      title: true,
      date: true,
      createdAt: true,
      class: {
        select: {
          id: true,
          name: true,
          schedule: true,
        },
      },
    },
  });
}

export async function deleteLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  await prisma.lecture.delete({
    where: {
      id: lectureId,
    },
  });
}

export async function listLecturesForTeacher(params: {
  teacherId: string;
  classId?: string;
  skip: number;
  take: number;
}) {
  if (params.classId) {
    await assertTeacherOwnsClass(params.teacherId, params.classId);
  }

  const where = {
    class: {
      teacherId: params.teacherId,
    },
    ...(params.classId
      ? {
          classId: params.classId,
        }
      : {}),
  };

  const [lectures, totalItems] = await Promise.all([
    prisma.lecture.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: {
        date: "desc",
      },
      select: {
        id: true,
        title: true,
        date: true,
        createdAt: true,
        class: {
          select: {
            id: true,
            name: true,
            schedule: true,
          },
        },
        _count: {
          select: {
            notes: true,
            assignments: true,
            quizzes: true,
          },
        },
      },
    }),
    prisma.lecture.count({
      where,
    }),
  ]);

  return {
    lectures,
    totalItems,
  };
}

export async function listNotesForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.note.findMany({
    where: {
      lectureId,
    },
    orderBy: {
      id: "desc",
    },
    select: {
      id: true,
      title: true,
      fileUrl: true,
      kind: true,
      mimeType: true,
      sizeBytes: true,
      downloadCount: true,
      lastDownloadedAt: true,
    },
  });
}

export async function listAssignmentsForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.assignment.findMany({
    where: {
      lectureId,
    },
    orderBy: {
      dueDate: "asc",
    },
    select: {
      id: true,
      title: true,
      description: true,
      dueDate: true,
    },
  });
}

export async function listQuizzesForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.quiz.findMany({
    where: {
      lectureId,
    },
    orderBy: {
      id: "desc",
    },
    select: {
      id: true,
      title: true,
    },
  });
}

export async function addAssignmentToLectureForTeacher(
  teacherId: string,
  lectureId: string,
  input: CreateAssignmentInput
) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.assignment.create({
    data: {
      lectureId,
      title: input.title,
      description: input.description,
      dueDate: input.dueDate,
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      description: true,
      dueDate: true,
    },
  });
}

export async function updateAssignmentForTeacher(
  teacherId: string,
  lectureId: string,
  assignmentId: string,
  input: UpdateAssignmentInput
) {
  await assertTeacherOwnsAssignment(teacherId, lectureId, assignmentId);

  return prisma.assignment.update({
    where: {
      id: assignmentId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      description: true,
      dueDate: true,
    },
  });
}

export async function deleteAssignmentForTeacher(teacherId: string, lectureId: string, assignmentId: string) {
  await assertTeacherOwnsAssignment(teacherId, lectureId, assignmentId);

  await prisma.assignment.delete({
    where: {
      id: assignmentId,
    },
  });
}

export async function addQuizToLectureForTeacher(
  teacherId: string,
  lectureId: string,
  input: CreateQuizInput
) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.quiz.create({
    data: {
      lectureId,
      title: input.title,
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
    },
  });
}

export async function updateQuizForTeacher(
  teacherId: string,
  lectureId: string,
  quizId: string,
  input: UpdateQuizInput
) {
  await assertTeacherOwnsQuiz(teacherId, lectureId, quizId);

  return prisma.quiz.update({
    where: {
      id: quizId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
    },
  });
}

export async function deleteQuizForTeacher(teacherId: string, lectureId: string, quizId: string) {
  await assertTeacherOwnsQuiz(teacherId, lectureId, quizId);

  await prisma.quiz.delete({
    where: {
      id: quizId,
    },
  });
}

export async function addNoteToLectureForTeacher(params: {
  teacherId: string;
  lectureId: string;
  title: string;
  fileUrl: string;
  mimeType: string;
  sizeBytes: number;
  kind: "NOTE" | "SUPPORTING_MATERIAL";
}) {
  await assertTeacherOwnsLecture(params.teacherId, params.lectureId);

  return prisma.note.create({
    data: {
      lectureId: params.lectureId,
      title: params.title,
      fileUrl: params.fileUrl,
      kind: params.kind,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      fileUrl: true,
      kind: true,
      mimeType: true,
      sizeBytes: true,
      downloadCount: true,
      lastDownloadedAt: true,
    },
  });
}

export async function updateNoteForTeacher(
  teacherId: string,
  lectureId: string,
  noteId: string,
  input: UpdateNoteInput
) {
  await assertTeacherOwnsNote(teacherId, lectureId, noteId);

  return prisma.note.update({
    where: {
      id: noteId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      fileUrl: true,
      kind: true,
      mimeType: true,
      sizeBytes: true,
      downloadCount: true,
      lastDownloadedAt: true,
    },
  });
}

export async function deleteNoteForTeacher(teacherId: string, lectureId: string, noteId: string) {
  const note = await assertTeacherOwnsNote(teacherId, lectureId, noteId);

  await prisma.note.delete({
    where: {
      id: noteId,
    },
  });

  return note;
}

export async function getAndTrackNoteDownloadForTeacher(teacherId: string, noteId: string) {
  const note = await prisma.note.findFirst({
    where: {
      id: noteId,
      lecture: {
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      title: true,
      fileUrl: true,
      mimeType: true,
      sizeBytes: true,
      downloadCount: true,
      lastDownloadedAt: true,
    },
  });

  if (!note) {
    throw new AppError("Note not found.", 404, "NOTE_NOT_FOUND");
  }

  return prisma.note.update({
    where: {
      id: noteId,
    },
    data: {
      downloadCount: {
        increment: 1,
      },
      lastDownloadedAt: new Date(),
    },
    select: {
      id: true,
      title: true,
      fileUrl: true,
      mimeType: true,
      sizeBytes: true,
      downloadCount: true,
      lastDownloadedAt: true,
    },
  });
}
