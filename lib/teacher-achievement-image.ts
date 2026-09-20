import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@/lib/error-handler";

const ACHIEVEMENTS_ROOT = path.join(
  process.cwd(),
  "storage",
  "teacher-achievements"
);

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function teacherDir(teacherId: string): string {
  return path.join(ACHIEVEMENTS_ROOT, teacherId);
}

/** Public URL used by the client to render an achievement photo. */
export function achievementImageUrl(id: string, version: string | number): string {
  return `/api/public/teacher/achievements/${id}/image?v=${version}`;
}

export function validateAchievementImage(file: File) {
  if (!ALLOWED_IMAGE_TYPES[file.type]) {
    throw new AppError(
      "Photo must be a JPG, PNG, WEBP or GIF file.",
      400,
      "VALIDATION_ERROR"
    );
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new AppError("Photo must be 5 MB or smaller.", 400, "VALIDATION_ERROR");
  }
}

/** Validates and stores the photo, returning the generated file name. */
export async function saveAchievementImage(
  teacherId: string,
  file: File
): Promise<string> {
  validateAchievementImage(file);

  const imageName = `${randomUUID()}${ALLOWED_IMAGE_TYPES[file.type]}`;
  const dir = teacherDir(teacherId);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, imageName),
    Buffer.from(await file.arrayBuffer())
  );

  return imageName;
}

export async function removeAchievementImage(
  teacherId: string,
  imageName: string | null | undefined
): Promise<void> {
  if (!imageName) {
    return;
  }

  try {
    await fs.unlink(path.join(teacherDir(teacherId), imageName));
  } catch {
    // Ignore missing files.
  }
}

/** Resolves the absolute image path for streaming, guarding against traversal. */
export function resolveAchievementImagePath(
  teacherId: string,
  imageName: string
): string {
  const dir = teacherDir(teacherId);
  const filePath = path.join(dir, imageName);
  const relative = path.relative(dir, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("Image is not available.", 403, "FILE_ACCESS_DENIED");
  }

  return filePath;
}

/** Reads the achievement multipart form sent by the teacher profile UI. */
export function parseAchievementForm(form: FormData) {
  const yearRaw = String(form.get("year") ?? "").trim();
  const photo = form.get("photo");

  return {
    dto: {
      title: String(form.get("title") ?? ""),
      description: String(form.get("description") ?? ""),
      year: yearRaw ? Number(yearRaw) : undefined,
    },
    file: photo instanceof File && photo.size > 0 ? photo : null,
    removePhoto: form.get("removePhoto") === "true",
  };
}
