import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { noteKindSchema } from "@/lib/lecture-validation";
import { addNoteToLectureForTeacher, listNotesForLectureForTeacher } from "@/services/lecture-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;

    if (!lectureId?.trim()) {
      throw new AppError("Lecture id is required.", 400, "VALIDATION_ERROR");
    }

    const notes = await listNotesForLectureForTeacher(session.teacherId, lectureId);
    return apiSuccess(notes);
  } catch (error) {
    return handleRouteError(error);
  }
}

const NOTE_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const SUPPORTING_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/plain",
  "application/zip",
]);

const MAX_NOTE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_SUPPORTING_SIZE_BYTES = 25 * 1024 * 1024;

function sanitizeFileName(fileName: string) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getAllowedMimeTypes(kind: "NOTE" | "SUPPORTING_MATERIAL") {
  return kind === "NOTE" ? NOTE_MIME_TYPES : SUPPORTING_MIME_TYPES;
}

function formatMegabytes(bytes: number) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

export async function POST(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;

    if (!lectureId?.trim()) {
      throw new AppError("Lecture id is required.", 400, "VALIDATION_ERROR");
    }

    const formData = await request.formData();
    const title = String(formData.get("title") ?? "").trim();
    const kindRaw = String(formData.get("kind") ?? "NOTE");
    const fileEntry = formData.get("file");

    if (!title) {
      return apiError("Title is required.", 400, "VALIDATION_ERROR");
    }

    if (!(fileEntry instanceof File)) {
      return apiError("File is required.", 400, "VALIDATION_ERROR");
    }

    const parsedKind = noteKindSchema.safeParse(kindRaw);

    if (!parsedKind.success) {
      return apiError("Invalid note kind.", 400, "VALIDATION_ERROR", parsedKind.error.flatten());
    }

    const kind = parsedKind.data;
    const allowedMimeTypes = getAllowedMimeTypes(kind);
    const maxFileSize = kind === "NOTE" ? MAX_NOTE_SIZE_BYTES : MAX_SUPPORTING_SIZE_BYTES;

    if (!allowedMimeTypes.has(fileEntry.type)) {
      return apiError(
        kind === "NOTE"
          ? "Notes only support PDF or image files."
          : "Unsupported supporting material file type.",
        400,
        "UNSUPPORTED_FILE_TYPE"
      );
    }

    if (fileEntry.size > maxFileSize) {
      return apiError(
        `File exceeds size limit. ${kind === "NOTE" ? "Notes" : "Supporting materials"} allow up to ${formatMegabytes(maxFileSize)} MB, received ${formatMegabytes(fileEntry.size)} MB.`,
        400,
        "FILE_TOO_LARGE"
      );
    }

    const bytes = new Uint8Array(await fileEntry.arrayBuffer());
    const safeFileName = sanitizeFileName(fileEntry.name || "upload.bin") || "upload.bin";
    const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${uniquePrefix}-${safeFileName}`;

    const uploadDir = path.join(process.cwd(), "storage", "lectures", lectureId);
    await mkdir(uploadDir, { recursive: true });

    const fullFilePath = path.join(uploadDir, fileName);
    await writeFile(fullFilePath, bytes);

    const fileUrl = `lectures/${lectureId}/${fileName}`;

    const note = await addNoteToLectureForTeacher({
      teacherId: session.teacherId,
      lectureId,
      title,
      fileUrl,
      kind,
      mimeType: fileEntry.type,
      sizeBytes: fileEntry.size,
    });

    return apiSuccess(
      {
        note,
      },
      {
        status: 201,
        message: kind === "NOTE" ? "Lecture note uploaded successfully." : "Supporting material uploaded successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
