import { readFile } from "node:fs/promises";
import path from "node:path";

import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { resolveAchievementImagePath } from "@/lib/teacher-achievement-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(
  _request: Request,
  context: { params: { id: string } }
) {
  try {
    const { id } = context.params;

    if (!id?.trim()) {
      throw new AppError("Achievement id is required.", 400, "VALIDATION_ERROR");
    }

    const achievement = await prisma.teacherAchievement.findUnique({
      where: { id },
      select: {
        imageName: true,
        profile: { select: { teacherId: true } },
      },
    });

    if (!achievement?.imageName) {
      throw new AppError("Image not found.", 404, "NOT_FOUND");
    }

    const filePath = resolveAchievementImagePath(
      achievement.profile.teacherId,
      achievement.imageName
    );

    const file = await readFile(filePath).catch(() => {
      throw new AppError("The image is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const ext = path.extname(achievement.imageName).toLowerCase();

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
