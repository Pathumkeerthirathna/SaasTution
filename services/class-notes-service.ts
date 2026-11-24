/*
 * Class-scoped Notes (Notes page redesign, Stage 1: backend).
 *
 * A class's notes are ordinary Note rows on its lectures:
 *  - General Notes: the notes of the class's DEFAULT lecture
 *    (Lecture.isDefault = true, lib/default-lecture.ts), resolved here from
 *    the class on the server; a client-supplied default lecture id is never
 *    trusted (the routes never accept one);
 *  - Lecture Notes: the notes of one NORMAL lecture of that class
 *    (isDefault = false), chosen by the caller and checked to belong to it.
 *
 * Access: the teacher must own the class; the student must be actively
 * enrolled in it. Either way the class must be active (status 0). A missing
 * default lecture is 409 DEFAULT_LECTURE_MISSING: nothing is created here
 * (existing classes get theirs from docs/sql/default-lecture-backfill.sql).
 * Monthly resource locks are applied by the student route
 * (services/resource-access-service.ts), exactly as for every other note.
 *
 * Ordering (both lists): uploadedAt DESC with NULLs (notes uploaded before
 * uploadedAt existed) last, then the lecture's date DESC, then id DESC.
 */

import type { Prisma } from "@prisma/client";

import { NORMAL_LECTURE_WHERE } from "@/lib/default-lecture";
import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const CLASS_NOTES_ERROR_CODES = {
  CLASS_NOT_FOUND: "CLASS_NOT_FOUND",
  DEFAULT_LECTURE_MISSING: "DEFAULT_LECTURE_MISSING",
  LECTURE_NOT_FOUND: "LECTURE_NOT_FOUND",
} as const;

/** Newest upload first; legacy notes (no uploadedAt) last, by their lecture's date; id breaks ties. */
export const CLASS_NOTES_ORDER = [
  { uploadedAt: { sort: "desc", nulls: "last" } },
  { lecture: { date: "desc" } },
  { id: "desc" },
] satisfies Prisma.NoteOrderByWithRelationInput[];

export type NotesSection = "GENERAL" | "LECTURE";

const NOTES_LECTURE_SELECT = { id: true, classId: true, title: true, date: true, isDefault: true } as const;
export type NotesLecture = { id: string; classId: string; title: string; date: Date; isDefault: boolean };
export type NotesClass = { id: string; name: string };

/** The teacher-facing note (the per-lecture API's fields, plus uploadedAt). Never fileUrl / storageKey. */
const TEACHER_NOTE_SELECT = {
  id: true,
  lectureId: true,
  title: true,
  kind: true,
  mimeType: true,
  sizeBytes: true,
  downloadCount: true,
  lastDownloadedAt: true,
  visibility: true,
  access: true,
  uploadedAt: true,
} as const;

/** The student-facing note (the per-lecture student API's fields, plus uploadedAt). */
const STUDENT_NOTE_SELECT = {
  id: true,
  lectureId: true,
  title: true,
  kind: true,
  mimeType: true,
  sizeBytes: true,
  uploadedAt: true,
} as const;

function classNotFound(): AppError {
  return new AppError("Class not found.", 404, CLASS_NOTES_ERROR_CODES.CLASS_NOT_FOUND);
}

function defaultLectureMissing(): AppError {
  return new AppError(
    "This class has no General Notes lecture yet. Ask the administrator to set it up.",
    409,
    CLASS_NOTES_ERROR_CODES.DEFAULT_LECTURE_MISSING
  );
}

function lectureNotFound(): AppError {
  return new AppError("Lecture not found in this class.", 404, CLASS_NOTES_ERROR_CODES.LECTURE_NOT_FOUND);
}

/** The teacher's active class, or 404 (another teacher's class looks the same as a missing one). */
async function teacherClass(teacherId: string, classId: string): Promise<NotesClass> {
  const cls = await prisma.class.findFirst({ where: { id: classId, teacherId, status: 0 }, select: { id: true, name: true } });
  if (!cls) throw classNotFound();
  return cls;
}

/** An active class the student is actively enrolled in, or 404. */
async function studentClass(studentId: string, classId: string): Promise<NotesClass> {
  const cls = await prisma.class.findFirst({
    where: { id: classId, status: 0, students: { some: { studentId, isActive: true } } },
    select: { id: true, name: true },
  });
  if (!cls) throw classNotFound();
  return cls;
}

/** The class's default lecture, found by classId + isDefault only, or 409 DEFAULT_LECTURE_MISSING (never created here). */
async function defaultLectureOf(classId: string): Promise<NotesLecture> {
  const lecture = await prisma.lecture.findFirst({ where: { classId, isDefault: true, status: 0 }, select: NOTES_LECTURE_SELECT });
  if (!lecture) throw defaultLectureMissing();
  return lecture;
}

/** A NORMAL, active lecture of this class, or 404 (another class's lecture, a default lecture or a removed one). */
async function normalLectureOf(classId: string, lectureId: string): Promise<NotesLecture> {
  const lecture = await prisma.lecture.findFirst({
    where: { id: lectureId, classId, status: 0, ...NORMAL_LECTURE_WHERE },
    select: NOTES_LECTURE_SELECT,
  });
  if (!lecture) throw lectureNotFound();
  return lecture;
}

/** The selected normal lecture, or the class's default lecture when none is selected. */
async function notesLectureOf(classId: string, lectureId: string | null | undefined): Promise<NotesLecture> {
  return lectureId ? normalLectureOf(classId, lectureId) : defaultLectureOf(classId);
}

/** Teacher: the default lecture of a class the teacher owns (404 CLASS_NOT_FOUND, 409 DEFAULT_LECTURE_MISSING). */
export async function resolveDefaultLectureForTeacher(teacherId: string, classId: string): Promise<{ class: NotesClass; lecture: NotesLecture }> {
  const cls = await teacherClass(teacherId, classId);
  return { class: cls, lecture: await defaultLectureOf(cls.id) };
}

/** Student: the default lecture of an active class the student is actively enrolled in (404 / 409 as above). */
export async function resolveDefaultLectureForStudent(studentId: string, classId: string): Promise<{ class: NotesClass; lecture: NotesLecture }> {
  const cls = await studentClass(studentId, classId);
  return { class: cls, lecture: await defaultLectureOf(cls.id) };
}

/**
 * A class section's lecture for the teacher: the class's DEFAULT lecture when
 * no lectureId is given (General Notes / General Recordings), else that NORMAL
 * lecture of the class. Class ownership first (404 CLASS_NOT_FOUND), then 409
 * DEFAULT_LECTURE_MISSING / 404 LECTURE_NOT_FOUND. Shared by the class-scoped
 * Notes and Recorded Lectures APIs (services/class-recordings-service.ts).
 */
export async function resolveClassLectureForTeacher(
  teacherId: string,
  classId: string,
  lectureId: string | null | undefined
): Promise<{ class: NotesClass; lecture: NotesLecture }> {
  const cls = await teacherClass(teacherId, classId);
  return { class: cls, lecture: await notesLectureOf(cls.id, lectureId) };
}

function lectureView(lecture: NotesLecture) {
  return { id: lecture.id, title: lecture.title, date: lecture.date, isDefault: lecture.isDefault };
}

/**
 * Teacher: General Notes (no lectureId) or one normal lecture's notes, newest
 * upload first. 404 CLASS_NOT_FOUND / LECTURE_NOT_FOUND, 409 DEFAULT_LECTURE_MISSING.
 */
export async function listClassNotesForTeacher(teacherId: string, classId: string, options: { lectureId?: string | null } = {}) {
  const cls = await teacherClass(teacherId, classId);
  const lecture = await notesLectureOf(cls.id, options.lectureId);
  const notes = await prisma.note.findMany({
    where: { lectureId: lecture.id, status: 0 },
    orderBy: CLASS_NOTES_ORDER,
    select: TEACHER_NOTE_SELECT,
  });
  return { class: cls, section: (lecture.isDefault ? "GENERAL" : "LECTURE") as NotesSection, lecture: lectureView(lecture), notes };
}

/**
 * Student: General Notes (no lectureId) or one normal lecture's notes, newest
 * upload first, without lock flags (the route adds them: resourceLockFor).
 * `lecture.date` is returned for the billing-month fallback of legacy notes.
 */
export async function listClassNotesForStudent(studentId: string, classId: string, options: { lectureId?: string | null } = {}) {
  const cls = await studentClass(studentId, classId);
  const lecture = await notesLectureOf(cls.id, options.lectureId);
  const notes = await prisma.note.findMany({
    where: { lectureId: lecture.id, status: 0 },
    orderBy: CLASS_NOTES_ORDER,
    select: STUDENT_NOTE_SELECT,
  });
  return { class: cls, section: (lecture.isDefault ? "GENERAL" : "LECTURE") as NotesSection, lecture: lectureView(lecture), notes };
}

/** The optional `lectureId` query parameter: absent / blank = General Notes; otherwise a bounded id string. */
export function parseNotesLectureParam(raw: string | null): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  if (value.length > 64 || !/^[A-Za-z0-9-]+$/.test(value)) {
    throw new AppError("Invalid lecture id.", 400, "VALIDATION_ERROR", { field: "lectureId" });
  }
  return value;
}
