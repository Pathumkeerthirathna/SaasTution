import { promises as fs } from "fs";
import path from "path";

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import {
  MAX_TEACHER_ANNOUNCEMENTS,
  TeacherAnnouncement,
} from "@/types/teacherProfileTypes/announcement/announcement-types";

const ANNOUNCEMENTS_ROOT = path.join(
  process.cwd(),
  "storage",
  "teacher-announcements"
);

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "teacher"
  );
}

function extensionForFile(file: File): string {
  const fromName = path.extname(file.name).toLowerCase();
  if (fromName) {
    return fromName;
  }

  switch (file.type) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".jpg";
  }
}

function teacherDir(teacherId: string): string {
  return path.join(ANNOUNCEMENTS_ROOT, teacherId);
}

/** Public URL used by the client to render an announcement image. */
export function announcementImageUrl(id: string): string {
  return `/api/public/teacher/announcements/${id}/image`;
}

function toDto(row: {
  id: string;
  teacherId: string;
  imageName: string;
  description: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}): TeacherAnnouncement {
  return {
    id: row.id,
    teacherId: row.teacherId,
    imageName: row.imageName,
    imageUrl: `${announcementImageUrl(row.id)}?v=${row.updatedAt.getTime()}`,
    description: row.description,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateDescription(description: string): string {
  const trimmed = description.trim();

  if (!trimmed) {
    throw new AppError("Description is required.", 400, "VALIDATION_ERROR");
  }

  if (trimmed.length > 1000) {
    throw new AppError(
      "Description must be 1000 characters or fewer.",
      400,
      "VALIDATION_ERROR"
    );
  }

  return trimmed;
}

function validateImage(file: File) {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new AppError(
      "Image must be a JPG, PNG, WEBP or GIF file.",
      400,
      "VALIDATION_ERROR"
    );
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new AppError("Image must be 5 MB or smaller.", 400, "VALIDATION_ERROR");
  }
}

async function writeImage(
  teacherId: string,
  imageName: string,
  file: File
): Promise<void> {
  const dir = teacherDir(teacherId);
  await fs.mkdir(dir, { recursive: true });

  const bytes = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(path.join(dir, imageName), bytes);
}

async function removeImage(
  teacherId: string,
  imageName: string
): Promise<void> {
  try {
    await fs.unlink(path.join(teacherDir(teacherId), imageName));
  } catch {
    // Ignore missing files.
  }
}

export async function getTeacherAnnouncements(
  teacherId: string
): Promise<TeacherAnnouncement[]> {
  const rows = await prisma.teacherAnnouncement.findMany({
    where: { teacherId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return rows.map(toDto);
}

/** Resolve the absolute image path for streaming, guarding against traversal. */
export async function getAnnouncementImagePath(
  announcementId: string
): Promise<{ filePath: string; imageName: string }> {
  const announcement = await prisma.teacherAnnouncement.findUnique({
    where: { id: announcementId },
    select: { teacherId: true, imageName: true },
  });

  if (!announcement) {
    throw new AppError("Announcement not found.", 404, "NOT_FOUND");
  }

  const dir = teacherDir(announcement.teacherId);
  const filePath = path.join(dir, announcement.imageName);
  const relative = path.relative(dir, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("Image is not available.", 403, "FILE_ACCESS_DENIED");
  }

  return { filePath, imageName: announcement.imageName };
}

export async function addTeacherAnnouncement(
  teacherId: string,
  input: { description: string; file: File | null }
): Promise<TeacherAnnouncement> {
  const description = validateDescription(input.description);

  if (!input.file) {
    throw new AppError("An image is required.", 400, "VALIDATION_ERROR");
  }

  validateImage(input.file);

  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { name: true },
  });

  if (!teacher) {
    throw new AppError("Teacher not found.", 404, "NOT_FOUND");
  }

  const existing = await prisma.teacherAnnouncement.findMany({
    where: { teacherId },
    select: { sortOrder: true },
  });

  if (existing.length >= MAX_TEACHER_ANNOUNCEMENTS) {
    throw new AppError(
      `You can publish at most ${MAX_TEACHER_ANNOUNCEMENTS} announcements. Delete one to add another.`,
      400,
      "LIMIT_REACHED"
    );
  }

  const usedSlots = new Set(existing.map((row) => row.sortOrder));
  let slot = 1;
  while (usedSlots.has(slot) && slot <= MAX_TEACHER_ANNOUNCEMENTS) {
    slot += 1;
  }

  const imageName = `${slugifyName(teacher.name)}-Post${String(slot).padStart(
    2,
    "0"
  )}${extensionForFile(input.file)}`;

  await writeImage(teacherId, imageName, input.file);

  const created = await prisma.teacherAnnouncement.create({
    data: {
      teacherId,
      imageName,
      description,
      sortOrder: slot,
    },
  });

  return toDto(created);
}

export async function updateTeacherAnnouncement(
  teacherId: string,
  announcementId: string,
  input: { description: string; file: File | null }
): Promise<TeacherAnnouncement> {
  const description = validateDescription(input.description);

  const announcement = await prisma.teacherAnnouncement.findFirst({
    where: { id: announcementId, teacherId },
  });

  if (!announcement) {
    throw new AppError("Announcement not found.", 404, "NOT_FOUND");
  }

  let imageName = announcement.imageName;

  if (input.file) {
    validateImage(input.file);

    const teacher = await prisma.teacher.findUnique({
      where: { id: teacherId },
      select: { name: true },
    });

    const nextImageName = `${slugifyName(
      teacher?.name ?? "teacher"
    )}-Post${String(announcement.sortOrder).padStart(2, "0")}${extensionForFile(
      input.file
    )}`;

    if (nextImageName !== announcement.imageName) {
      await removeImage(teacherId, announcement.imageName);
    }

    await writeImage(teacherId, nextImageName, input.file);
    imageName = nextImageName;
  }

  const updated = await prisma.teacherAnnouncement.update({
    where: { id: announcementId },
    data: {
      description,
      imageName,
    },
  });

  return toDto(updated);
}

export async function deleteTeacherAnnouncement(
  teacherId: string,
  announcementId: string
): Promise<{ success: true }> {
  const announcement = await prisma.teacherAnnouncement.findFirst({
    where: { id: announcementId, teacherId },
    select: { id: true, imageName: true },
  });

  if (!announcement) {
    throw new AppError("Announcement not found.", 404, "NOT_FOUND");
  }

  await removeImage(teacherId, announcement.imageName);

  await prisma.teacherAnnouncement.delete({
    where: { id: announcementId },
  });

  return { success: true };
}
