import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { emitStudentDataChange } from "@/lib/session-events";
import type { StoredFile } from "@/lib/class-paper";

async function assertTeacherOwnsClass(teacherId: string, classId: string) {
  const classroom = await prisma.class.findFirst({
    where: { id: classId, teacherId, status: 0 },
    select: { id: true, name: true },
  });
  if (!classroom) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }
  return classroom;
}

async function assertTeacherOwnsPaper(teacherId: string, paperId: string) {
  const paper = await prisma.classPaper.findFirst({
    where: { id: paperId, status: 0, class: { teacherId, status: 0 } },
    select: { id: true, classId: true },
  });
  if (!paper) {
    throw new AppError("Paper not found.", 404, "PAPER_NOT_FOUND");
  }
  return paper;
}

export type CreateClassPaperInput = {
  id?: string;
  classId: string;
  name: string;
  description: string | null;
  maxMarks: number | null;
  startTime: Date;
  endTime: Date;
  sortOrder: number;
  file: StoredFile;
};

export async function createClassPaper(teacherId: string, input: CreateClassPaperInput) {
  await assertTeacherOwnsClass(teacherId, input.classId);

  if (input.endTime.getTime() <= input.startTime.getTime()) {
    throw new AppError("End time must be after the start time.", 400, "VALIDATION_ERROR");
  }

  // Active students of the class at creation time.
  const activeStudents = await prisma.classStudent.findMany({
    where: { classId: input.classId, isActive: true, student: { status: 0 } },
    select: { studentId: true },
  });

  const paper = await prisma.classPaper.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      classId: input.classId,
      name: input.name,
      description: input.description,
      pdfName: input.file.fileName,
      pdfUrl: input.file.fileUrl,
      pdfMimeType: input.file.mimeType,
      maxMarks: input.maxMarks,
      startTime: input.startTime,
      endTime: input.endTime,
      sortOrder: input.sortOrder,
      submissions: {
        createMany: {
          data: activeStudents.map((s) => ({ studentId: s.studentId })),
          skipDuplicates: true,
        },
      },
    },
    select: { id: true },
  });

  emitStudentDataChange({ classId: input.classId });
  return { id: paper.id, assignedStudents: activeStudents.length };
}

export async function listClassPapersForTeacher(teacherId: string, classId?: string) {
  const papers = await prisma.classPaper.findMany({
    where: {
      status: 0,
      class: { teacherId, status: 0 },
      ...(classId ? { classId } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      description: true,
      pdfName: true,
      pdfMimeType: true,
      maxMarks: true,
      startTime: true,
      endTime: true,
      createdAt: true,
      class: { select: { id: true, name: true } },
      submissions: {
        select: { submitted: true, marks: true },
      },
    },
  });

  return papers.map((p) => {
    const total = p.submissions.length;
    const submitted = p.submissions.filter((s) => s.submitted).length;
    const marked = p.submissions.filter((s) => s.marks !== null).length;
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      pdfName: p.pdfName,
      pdfMimeType: p.pdfMimeType,
      maxMarks: p.maxMarks ? p.maxMarks.toNumber() : null,
      startTime: p.startTime.toISOString(),
      endTime: p.endTime.toISOString(),
      createdAt: p.createdAt.toISOString(),
      classId: p.class.id,
      className: p.class.name,
      totalStudents: total,
      submittedCount: submitted,
      markedCount: marked,
    };
  });
}

/** Submitted paper answers this teacher hasn't marked yet, oldest first. */
export async function getPendingPaperReviewsForTeacher(teacherId: string, limit = 8) {
  const submissions = await prisma.classPaperStudent.findMany({
    where: {
      submitted: true,
      marks: null,
      classPaper: {
        status: 0,
        class: { teacherId, status: 0 },
      },
    },
    orderBy: { submittedAt: "asc" },
    take: limit,
    select: {
      id: true,
      submittedAt: true,
      student: { select: { name: true, registrationNumber: true } },
      classPaper: {
        select: {
          id: true,
          name: true,
          startTime: true,
          endTime: true,
          class: { select: { id: true, name: true } },
        },
      },
    },
  });

  return submissions.map((s) => ({
    submissionId: s.id,
    submittedAt: s.submittedAt ? s.submittedAt.toISOString() : null,
    studentName: s.student.name,
    registrationNumber: s.student.registrationNumber,
    paperId: s.classPaper.id,
    paperName: s.classPaper.name,
    startTime: s.classPaper.startTime.toISOString(),
    endTime: s.classPaper.endTime.toISOString(),
    classId: s.classPaper.class.id,
    className: s.classPaper.class.name,
  }));
}

export async function getClassPaperForTeacher(teacherId: string, paperId: string) {
  await assertTeacherOwnsPaper(teacherId, paperId);

  const paper = await prisma.classPaper.findUnique({
    where: { id: paperId },
    select: {
      id: true,
      name: true,
      description: true,
      pdfName: true,
      pdfMimeType: true,
      maxMarks: true,
      startTime: true,
      endTime: true,
      createdAt: true,
      class: { select: { id: true, name: true } },
      submissions: {
        orderBy: { student: { name: "asc" } },
        select: {
          id: true,
          submitted: true,
          submittedAt: true,
          submissionFileName: true,
          submissionMimeType: true,
          marks: true,
          markedAt: true,
          student: { select: { id: true, name: true, registrationNumber: true } },
        },
      },
    },
  });

  if (!paper) {
    throw new AppError("Paper not found.", 404, "PAPER_NOT_FOUND");
  }

  return {
    id: paper.id,
    name: paper.name,
    description: paper.description,
    pdfName: paper.pdfName,
    pdfMimeType: paper.pdfMimeType,
    maxMarks: paper.maxMarks ? paper.maxMarks.toNumber() : null,
    startTime: paper.startTime.toISOString(),
    endTime: paper.endTime.toISOString(),
    createdAt: paper.createdAt.toISOString(),
    classId: paper.class.id,
    className: paper.class.name,
    submissions: paper.submissions.map((s) => ({
      id: s.id,
      studentId: s.student.id,
      studentName: s.student.name,
      registrationNumber: s.student.registrationNumber,
      submitted: s.submitted,
      submittedAt: s.submittedAt ? s.submittedAt.toISOString() : null,
      hasFile: Boolean(s.submissionFileName),
      submissionFileName: s.submissionFileName,
      marks: s.marks ? s.marks.toNumber() : null,
      markedAt: s.markedAt ? s.markedAt.toISOString() : null,
    })),
  };
}

export async function setPaperSubmissionMarks(
  teacherId: string,
  paperId: string,
  submissionId: string,
  marks: number | null
) {
  await assertTeacherOwnsPaper(teacherId, paperId);

  const submission = await prisma.classPaperStudent.findFirst({
    where: { id: submissionId, classPaperId: paperId },
    select: { id: true, classPaper: { select: { maxMarks: true } } },
  });
  if (!submission) {
    throw new AppError("Submission not found.", 404, "SUBMISSION_NOT_FOUND");
  }

  if (marks !== null) {
    if (marks < 0) {
      throw new AppError("Marks cannot be negative.", 400, "VALIDATION_ERROR");
    }
    const max = submission.classPaper.maxMarks;
    if (max && marks > max.toNumber()) {
      throw new AppError(`Marks cannot exceed the maximum of ${max.toNumber()}.`, 400, "VALIDATION_ERROR");
    }
  }

  const updated = await prisma.classPaperStudent.update({
    where: { id: submissionId },
    data: { marks, markedAt: marks === null ? null : new Date() },
    select: { id: true, marks: true, markedAt: true },
  });

  return {
    id: updated.id,
    marks: updated.marks ? updated.marks.toNumber() : null,
    markedAt: updated.markedAt ? updated.markedAt.toISOString() : null,
  };
}

export async function deleteClassPaperForTeacher(teacherId: string, paperId: string) {
  const paper = await assertTeacherOwnsPaper(teacherId, paperId);
  await prisma.classPaper.update({ where: { id: paperId }, data: { status: 1 } });
  emitStudentDataChange({ classId: paper.classId });
  return { deleted: true };
}

/** Paper file for whoever is allowed to see it (teacher owner or enrolled student). */
/** Students may open the paper starting this long before its scheduled start time. */
const PAPER_EARLY_VIEW_WINDOW_MS = 15 * 60 * 1000;

export async function getPaperFileForViewer(
  viewer: { role: "TEACHER"; teacherId: string } | { role: "STUDENT"; studentId: string },
  paperId: string
) {
  const paper = await prisma.classPaper.findFirst({
    where: {
      id: paperId,
      status: 0,
      class:
        viewer.role === "TEACHER"
          ? { teacherId: viewer.teacherId, status: 0 }
          : {
              status: 0,
              students: { some: { studentId: viewer.studentId, isActive: true } },
            },
    },
    select: { pdfUrl: true, pdfName: true, pdfMimeType: true, startTime: true },
  });

  if (!paper) return null;

  // Teachers can always preview their own paper; students only from 15
  // minutes before the paper's scheduled start time.
  if (viewer.role === "STUDENT") {
    const viewableFrom = paper.startTime.getTime() - PAPER_EARLY_VIEW_WINDOW_MS;
    if (Date.now() < viewableFrom) {
      throw new AppError(
        "This paper isn't available yet. It opens 15 minutes before the start time.",
        403,
        "PAPER_NOT_YET_AVAILABLE"
      );
    }
  }

  return paper;
}
