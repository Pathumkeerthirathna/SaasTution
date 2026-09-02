import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { assertPaperFile, storePaperFile } from "@/lib/class-paper";
import {
  createClassPaper,
  listClassPapersForTeacher,
} from "@/services/class-paper-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const { searchParams } = new URL(request.url);
    const classId = searchParams.get("classId")?.trim() || undefined;

    const papers = await listClassPapersForTeacher(session.teacherId, classId);
    return apiSuccess({ papers });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const form = await request.formData();

    const classId = String(form.get("classId") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim() || null;
    const maxMarksRaw = String(form.get("maxMarks") ?? "").trim();
    const startTimeRaw = String(form.get("startTime") ?? "").trim();
    const endTimeRaw = String(form.get("endTime") ?? "").trim();
    const sortOrderRaw = String(form.get("sortOrder") ?? "").trim();
    const fileEntry = form.get("file");

    if (!classId) return apiError("Select a class.", 400, "VALIDATION_ERROR");
    if (!name) return apiError("Paper name is required.", 400, "VALIDATION_ERROR");
    if (!startTimeRaw || !endTimeRaw) {
      return apiError("Start and end time are required.", 400, "VALIDATION_ERROR");
    }

    const startTime = new Date(startTimeRaw);
    const endTime = new Date(endTimeRaw);
    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
      return apiError("Start and end time must be valid dates.", 400, "VALIDATION_ERROR");
    }

    let maxMarks: number | null = null;
    if (maxMarksRaw) {
      const parsed = Number(maxMarksRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return apiError("Max marks must be a positive number.", 400, "VALIDATION_ERROR");
      }
      maxMarks = parsed;
    }

    const sortOrder = sortOrderRaw ? Number(sortOrderRaw) : 0;

    if (!(fileEntry instanceof File) || fileEntry.size === 0) {
      return apiError("Upload the paper file (PDF or image).", 400, "VALIDATION_ERROR");
    }
    const fileError = assertPaperFile(fileEntry);
    if (fileError) return apiError(fileError, 400, "VALIDATION_ERROR");

    const paperId = randomUUID();
    const stored = await storePaperFile(fileEntry, [paperId]);

    try {
      const result = await createClassPaper(session.teacherId, {
        id: paperId,
        classId,
        name,
        description,
        maxMarks,
        startTime,
        endTime,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        file: stored,
      });
      return apiSuccess(result, { status: 201, message: "Paper created." });
    } catch (createError) {
      await rm(path.join(process.cwd(), "storage", "class-papers", paperId), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      throw createError;
    }
  } catch (error) {
    return handleRouteError(error);
  }
}
