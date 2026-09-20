import type { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { sanitizeWhiteboardScene } from "@/lib/whiteboard-data";
import type { WhiteboardDetail, WhiteboardListItem, WhiteboardScene } from "@/types/whiteboard";

const listSelect = {
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LectureWhiteboardSelect;

const detailSelect = {
  ...listSelect,
  lectureId: true,
  data: true,
} satisfies Prisma.LectureWhiteboardSelect;

function toListItem(row: {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}): WhiteboardListItem {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: {
  id: string;
  title: string;
  lectureId: string;
  data: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): WhiteboardDetail {
  return {
    ...toListItem(row),
    lectureId: row.lectureId,
    data: row.data as unknown as WhiteboardScene,
  };
}

async function assertTeacherOwnsLecture(teacherId: string, lectureId: string) {
  const lecture = await prisma.lecture.findFirst({
    where: { id: lectureId, status: 0, class: { teacherId } },
    select: { id: true },
  });

  if (!lecture) {
    throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");
  }
}

/** Same access rule as notes: an active student of the lecture's active class. */
async function assertStudentCanViewLecture(studentId: string, lectureId: string) {
  const lecture = await prisma.lecture.findFirst({
    where: {
      id: lectureId,
      status: 0,
      class: {
        status: 0,
        students: { some: { studentId, isActive: true } },
      },
    },
    select: { id: true },
  });

  if (!lecture) {
    throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");
  }
}

/* ------------------------------ teacher ------------------------------ */

export async function listWhiteboardsForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  const rows = await prisma.lectureWhiteboard.findMany({
    where: { lectureId, status: 0 },
    orderBy: { createdAt: "asc" },
    select: listSelect,
  });

  return rows.map(toListItem);
}

export async function getWhiteboardForTeacher(teacherId: string, lectureId: string, whiteboardId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  const row = await prisma.lectureWhiteboard.findFirst({
    where: { id: whiteboardId, lectureId, status: 0 },
    select: detailSelect,
  });

  if (!row) {
    throw new AppError("Whiteboard not found.", 404, "WHITEBOARD_NOT_FOUND");
  }

  return toDetail(row);
}

export async function createWhiteboardForTeacher(
  teacherId: string,
  lectureId: string,
  input: { title: string; data: unknown }
) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  const scene = sanitizeWhiteboardScene(input.data);

  const row = await prisma.lectureWhiteboard.create({
    data: {
      lectureId,
      title: input.title,
      data: scene as unknown as Prisma.InputJsonValue,
    },
    select: detailSelect,
  });

  return toDetail(row);
}

export async function updateWhiteboardForTeacher(
  teacherId: string,
  lectureId: string,
  whiteboardId: string,
  input: { title?: string; data?: unknown }
) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  const existing = await prisma.lectureWhiteboard.findFirst({
    where: { id: whiteboardId, lectureId, status: 0 },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError("Whiteboard not found.", 404, "WHITEBOARD_NOT_FOUND");
  }

  const row = await prisma.lectureWhiteboard.update({
    where: { id: whiteboardId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.data !== undefined
        ? { data: sanitizeWhiteboardScene(input.data) as unknown as Prisma.InputJsonValue }
        : {}),
    },
    select: detailSelect,
  });

  return toDetail(row);
}

/** Soft delete: status 1 hides the whiteboard everywhere, the row is kept. */
export async function deleteWhiteboardForTeacher(teacherId: string, lectureId: string, whiteboardId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  const result = await prisma.lectureWhiteboard.updateMany({
    where: { id: whiteboardId, lectureId, status: 0 },
    data: { status: 1 },
  });

  if (result.count === 0) {
    throw new AppError("Whiteboard not found.", 404, "WHITEBOARD_NOT_FOUND");
  }
}

/* ------------------------------ student ------------------------------ */

export async function listWhiteboardsForLectureForStudent(studentId: string, lectureId: string) {
  await assertStudentCanViewLecture(studentId, lectureId);

  const rows = await prisma.lectureWhiteboard.findMany({
    where: { lectureId, status: 0 },
    orderBy: { createdAt: "asc" },
    select: listSelect,
  });

  return rows.map(toListItem);
}

export async function getWhiteboardForStudent(studentId: string, lectureId: string, whiteboardId: string) {
  await assertStudentCanViewLecture(studentId, lectureId);

  const row = await prisma.lectureWhiteboard.findFirst({
    where: { id: whiteboardId, lectureId, status: 0 },
    select: detailSelect,
  });

  if (!row) {
    throw new AppError("Whiteboard not found.", 404, "WHITEBOARD_NOT_FOUND");
  }

  return toDetail(row);
}

/* --------------------------- live (per session) --------------------------- */

/** The teacher may broadcast only in their own active session that has a lecture. */
export async function assertTeacherCanBroadcastWhiteboard(teacherId: string, sessionId: string) {
  const session = await prisma.classSession.findFirst({
    where: { id: sessionId, isActive: true, lectureId: { not: null }, class: { teacherId } },
    select: { id: true },
  });

  if (!session) {
    throw new AppError("Active lecture session not found.", 404, "SESSION_NOT_FOUND");
  }
}

/** A student may watch only an active lecture session of a class they are in. */
export async function assertStudentCanWatchWhiteboard(studentId: string, sessionId: string) {
  const session = await prisma.classSession.findFirst({
    where: {
      id: sessionId,
      isActive: true,
      lectureId: { not: null },
      class: { students: { some: { studentId, isActive: true } } },
    },
    select: { id: true },
  });

  if (!session) {
    throw new AppError("Active lecture session not found.", 404, "SESSION_NOT_FOUND");
  }
}
