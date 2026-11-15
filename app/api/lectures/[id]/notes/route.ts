import { randomUUID } from "node:crypto";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { noteKindSchema } from "@/lib/lecture-validation";
import { generateNoteStoredName, noteFileKey } from "@/lib/notes/storage-keys";
import { discardStoredUpload, storeUpload } from "@/lib/stored-files/stored-file";
import { addNoteToLectureForTeacher, assertTeacherOwnsLecture, listNotesForLectureForTeacher } from "@/services/lecture-service";
import { releaseTeacherStorageReservation, reserveTeacherStorage } from "@/services/storage-reservation-service";

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
    return handleRouteError(error, { request: _request });
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

    // RL-0: the teacher must own this (active) lecture before anything is
    // written to disk; otherwise 404 LECTURE_NOT_FOUND and no folder or file.
    // (Also: the lecture id below is then a real lecture id, not URL input.)
    await assertTeacherOwnsLecture(session.teacherId, lectureId);

    // Unified storage (Stage 2): the file goes to FILE_STORAGE_ROOT under a
    // server-generated key (Teachers/{teacher}/Lectures/{lecture}/Notes/{noteId}/
    // {random}.{ext from the validated MIME type}); nothing from the browser's
    // file name reaches the filesystem. It is written completely (exact size,
    // SHA-256, flushed) BEFORE the Note row exists - while the rollback window
    // is open, together with a verified legacy copy that fileUrl points to (so
    // the previous application version can still serve it) - and both are
    // removed again if the row is not created. Reads use storageKey.
    const noteId = randomUUID();
    const storageKey = noteFileKey({
      teacherId: session.teacherId,
      lectureId,
      noteId,
      storedName: generateNoteStoredName(fileEntry.type),
    });
    // Storage quota (Stage 3.2): reserve the file's size under the teacher's quota lock
    // BEFORE anything is written (413 STORAGE_QUOTA_EXCEEDED if it does not fit). The Note
    // row and the reservation's removal then commit together (addNoteToLectureForTeacher);
    // any failure removes the written files and releases the reservation.
    const reservation = await reserveTeacherStorage({
      teacherId: session.teacherId,
      category: "NOTE",
      storageKey,
      bytes: BigInt(fileEntry.size),
      audience: "TEACHER",
    });

    let note;
    try {
      const stored = await storeUpload("NOTE", storageKey, fileEntry, maxFileSize);
      note = await addNoteToLectureForTeacher({
        teacherId: session.teacherId,
        lectureId,
        title,
        fileUrl: stored.fileUrl,
        kind,
        mimeType: fileEntry.type,
        sizeBytes: stored.sizeBytes,
        id: noteId,
        storageKey,
        sha256: stored.sha256,
        discardStoredFile: () => discardStoredUpload(stored, "Lecture note upload: discard the files of a note that was not created"),
        reservation,
      });
    } catch (error) {
      // Committed reservations are already gone (this is then a no-op); otherwise it is released now.
      await releaseTeacherStorageReservation(reservation, "Lecture note upload: release the storage reservation of a failed upload");
      throw error;
    }

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
    return handleRouteError(error, { request });
  }
}
