import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { isRecordedLectureId } from "@/lib/recorded-lectures/keys";
import { uploadError } from "@/lib/recorded-lectures/upload-errors";
import { serverNow } from "@/lib/server-clock";
import { assertTeacherOwnsLecture } from "@/services/lecture-service";

/*
 * A teacher's publication settings of one recorded lecture (public teacher
 * profile integration):
 *
 *   visibility  PRIVATE | PUBLIC   ("Privacy")
 *   access      LOCKED  | FREE     ("Viewing access": Locked / Unlocked)
 *
 * They only decide what the PUBLIC class page shows and plays
 * (services/recorded-lecture-public-service.ts); enrolled students are not
 * affected. New and existing recordings are PRIVATE + LOCKED (database
 * defaults).
 *
 * Ownership on every request, server-side: the recording's teacherId must be
 * the session's teacher and its lecture an active lecture of one of the
 * teacher's classes; another teacher's, a deleted or a missing recording is
 * the same 404 as the other teacher routes ("Recording not found."). The
 * update itself is conditional on the same owner and status 0, so a recording
 * deleted meanwhile is never changed.
 */

export type RecordingPublication = {
  id: string;
  visibility: "PUBLIC" | "PRIVATE";
  access: "FREE" | "LOCKED";
};

export type RecordingPublicationUpdate = Partial<Pick<RecordingPublication, "visibility" | "access">>;

const VISIBILITY = new Set(["PUBLIC", "PRIVATE"]);
const ACCESS = new Set(["FREE", "LOCKED"]);

function recordingNotFound(): AppError {
  return uploadError("UPLOAD_NOT_FOUND", undefined, "Recording not found.");
}

function invalid(message: string): AppError {
  return new AppError(message, 400, "VALIDATION_ERROR");
}

/** { visibility?, access? }: at least one, only these keys, only the allowed values. */
export function parseRecordingPublicationUpdate(body: unknown): RecordingPublicationUpdate {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalid("The request body must be an object.");
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "visibility" && key !== "access") throw invalid(`Unknown field: ${key.slice(0, 40)}.`);
  }
  const update: RecordingPublicationUpdate = {};
  if (input.visibility !== undefined) {
    if (typeof input.visibility !== "string" || !VISIBILITY.has(input.visibility)) throw invalid("Privacy must be PUBLIC or PRIVATE.");
    update.visibility = input.visibility as RecordingPublication["visibility"];
  }
  if (input.access !== undefined) {
    if (typeof input.access !== "string" || !ACCESS.has(input.access)) throw invalid("Viewing access must be FREE or LOCKED.");
    update.access = input.access as RecordingPublication["access"];
  }
  if (update.visibility === undefined && update.access === undefined) throw invalid("Choose a privacy or viewing access setting.");
  return update;
}

/** Normalises a stored value for the client: anything unexpected is shown as the safe default. */
export function toRecordingPublication(row: { id: string; visibility: string; access: string }): RecordingPublication {
  return {
    id: row.id,
    visibility: row.visibility === "PUBLIC" ? "PUBLIC" : "PRIVATE",
    access: row.access === "FREE" ? "FREE" : "LOCKED",
  };
}

export async function updateRecordingPublicationForTeacher(input: {
  teacherId: string;
  recordingId: string;
  body: unknown;
}): Promise<RecordingPublication> {
  const { teacherId, recordingId } = input;
  if (!isRecordedLectureId(recordingId)) throw recordingNotFound();
  const update = parseRecordingPublicationUpdate(input.body);

  const row = await prisma.recordedLecture.findFirst({
    where: { id: recordingId, teacherId, status: 0 },
    select: { id: true, lectureId: true },
  });
  if (!row) throw recordingNotFound();
  try {
    await assertTeacherOwnsLecture(teacherId, row.lectureId);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) throw recordingNotFound();
    throw error;
  }

  const updated = await prisma.recordedLecture.updateMany({
    where: { id: row.id, teacherId, status: 0 },
    data: { ...update, updatedAt: await serverNow() },
  });
  if (updated.count === 0) throw recordingNotFound();

  const after = await prisma.recordedLecture.findFirst({
    where: { id: row.id, teacherId, status: 0 },
    select: { id: true, visibility: true, access: true },
  });
  if (!after) throw recordingNotFound();
  return toRecordingPublication(after);
}
