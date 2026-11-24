import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { isRecordedLectureId } from "@/lib/recorded-lectures/keys";
import { buildTeacherRecordingDto, type TeacherRecordingDto } from "@/lib/recorded-lectures/teacher-dto";
import { uploadError } from "@/lib/recorded-lectures/upload-errors";
import { getRecordedLectureStorage } from "@/lib/recorded-lectures/storage";
import { validateUploadDeclaration } from "@/lib/recorded-lectures/validation";
import { serverNow } from "@/lib/server-clock";
import { assertTeacherOwnsLecture } from "@/services/lecture-service";
import { cancelRecordingUpload } from "@/services/recorded-lecture-completion-service";
import { purgeRemovedRecording } from "@/services/recorded-lecture-maintenance-service";
import { streamStoredRecording } from "@/services/recorded-lecture-stream-service";
import { assertTeacherCanUpload, loadConfig } from "@/services/recorded-lecture-upload-service";

/*
 * Teacher management of a lecture's recorded lectures (list, edit title /
 * part number, soft delete, owner preview). Uploading itself is the
 * EXISTING RL-3 protocol (start / chunks / complete / status / cancel);
 * nothing here writes files.
 *
 * Ownership on every request: the recording's teacherId must be the
 * session's teacher (and, for the lecture views, the lecture must be an
 * active lecture of one of the teacher's classes: assertTeacherOwnsLecture).
 * Another teacher's recording is the same 404 as a missing one.
 *
 * Deleting is the existing soft-delete lifecycle: status 0 -> 2 (purge
 * pending) with deletedAt, deletedByTeacherId and purgeRequestedAt. The file
 * stays on disk until a purge step removes it (status 1, purgedAt); that step
 * is not part of this change. Students never see status <> 0.
 */

function recordingNotFound() {
  return uploadError("UPLOAD_NOT_FOUND", undefined, "Recording not found.");
}

const recordingSelect = {
  id: true,
  lectureId: true,
  title: true,
  partNumber: true,
  displayFileName: true,
  sizeBytes: true,
  durationSeconds: true,
  width: true,
  height: true,
  state: true,
  failureCode: true,
  createdAt: true,
  readyAt: true,
  failedAt: true,
  visibility: true,
  access: true,
} as const;

const sessionSelect = { id: true, recordedLectureId: true, state: true, receivedBytes: true, expectedBytes: true, expiresAt: true, lastActivityAt: true } as const;

/**
 * The lecture must be an active lecture of one of the teacher's classes (else
 * the same 404 as a missing recording). A class's default lecture is accepted:
 * the recording already exists and is the teacher's own (General Recordings,
 * started only through the class-scoped upload; services/class-recordings-service.ts).
 */
async function assertOwnedLectureForRecording(teacherId: string, lectureId: string) {
  try {
    await assertTeacherOwnsLecture(teacherId, lectureId, { includeDefault: true });
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) throw recordingNotFound();
    throw error;
  }
}

export type TeacherLectureRecordings = {
  lecture: { id: string; title: string; date: string; className: string };
  recordings: TeacherRecordingDto[];
  /** The lowest part number not used by an active (non-failed) recording. */
  nextPartNumber: number;
  limits: { maxPartBytes: number; chunkBytes: number; maxPartsPerLecture: number | null; maxMoovBytes: number };
};

/**
 * A lecture's active (status 0) recordings, every state, by part number.
 * `includeDefault`: the class's default lecture (General Recordings), only
 * when the caller resolved it on the server from the class
 * (services/class-recordings-service.ts); the lecture-scoped route never sets it.
 */
export async function listTeacherLectureRecordings(input: { teacherId: string; lectureId: string; includeDefault?: boolean }): Promise<TeacherLectureRecordings> {
  if (!isRecordedLectureId(input.lectureId)) throw uploadError("LECTURE_NOT_FOUND");
  const config = loadConfig();
  const lecture = await assertTeacherOwnsLecture(input.teacherId, input.lectureId, { includeDefault: input.includeDefault === true });
  const found = await prisma.recordedLecture.findMany({
    where: { lectureId: input.lectureId, teacherId: input.teacherId, status: 0 },
    orderBy: { partNumber: "asc" },
    select: recordingSelect,
  });
  // A FAILED part keeps its number while a new upload may reuse it: newest first among equals.
  const rows = [...found].sort((a, b) => a.partNumber - b.partNumber || b.createdAt.getTime() - a.createdAt.getTime());
  const sessions = rows.length
    ? await prisma.recordingUploadSession.findMany({
        where: { teacherId: input.teacherId, recordedLectureId: { in: rows.map((r) => r.id) } },
        select: sessionSelect,
      })
    : [];
  const sessionByRecording = new Map(sessions.map((s) => [s.recordedLectureId, s]));
  const used = new Set(rows.filter((r) => r.state !== "FAILED").map((r) => r.partNumber));
  let nextPartNumber = 1;
  while (used.has(nextPartNumber)) nextPartNumber += 1;
  return {
    lecture: { id: lecture.id, title: lecture.title, date: lecture.date.toISOString(), className: lecture.class.name },
    recordings: rows.map((row) => buildTeacherRecordingDto({ ...row, uploadSession: sessionByRecording.get(row.id) ?? null })),
    nextPartNumber,
    limits: { maxPartBytes: config.maxPartBytes, chunkBytes: config.chunkBytes, maxPartsPerLecture: config.maxPartsPerLecture, maxMoovBytes: config.maxMoovBytes },
  };
}

async function ownedRecording(teacherId: string, recordingId: string) {
  if (!isRecordedLectureId(recordingId)) throw recordingNotFound();
  const row = await prisma.recordedLecture.findFirst({
    where: { id: recordingId, teacherId, status: 0 },
    select: recordingSelect,
  });
  if (!row) throw recordingNotFound();
  await assertOwnedLectureForRecording(teacherId, row.lectureId);
  const uploadSession = await prisma.recordingUploadSession.findFirst({
    where: { recordedLectureId: row.id, teacherId },
    select: sessionSelect,
  });
  return { ...row, uploadSession };
}

/**
 * Edits the title and / or part number (same rules as an upload's
 * declaration). A part number already used by another active recording of
 * the lecture is 409 PART_NUMBER_IN_USE (the database's partial unique index
 * decides, so two concurrent edits cannot both win).
 */
export async function updateTeacherRecording(input: { teacherId: string; recordingId: string; body: unknown }): Promise<TeacherRecordingDto> {
  const config = loadConfig();
  await assertTeacherCanUpload(prisma, input.teacherId);
  const current = await ownedRecording(input.teacherId, input.recordingId);
  const body = input.body !== null && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : {};
  const wantsTitle = Object.hasOwn(body, "title");
  const wantsPart = Object.hasOwn(body, "partNumber");
  if (!wantsTitle && !wantsPart) throw uploadError("UPLOAD_DECLARATION_INVALID", { reason: "NOTHING_TO_UPDATE" }, "Nothing to update.");

  // Reuse the declaration rules; the file fields are the recording's own (already valid).
  const checked = validateUploadDeclaration(
    {
      title: wantsTitle ? body.title : current.title,
      partNumber: wantsPart ? body.partNumber : current.partNumber,
      fileName: "recording.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1,
    },
    config
  );
  if (!checked.ok) throw uploadError("UPLOAD_DECLARATION_INVALID", { reason: checked.problem }, checked.message);

  const now = await serverNow();
  const updated = await prisma.recordedLecture.updateMany({
    where: { id: current.id, teacherId: input.teacherId, status: 0 },
    data: { title: checked.value.title, partNumber: checked.value.partNumber, updatedAt: now },
  });
  if (updated.count === 0) throw recordingNotFound();
  return buildTeacherRecordingDto(await ownedRecording(input.teacherId, input.recordingId));
}

/**
 * Soft-deletes a recording (status 0 -> 2). An upload still receiving data
 * is cancelled first through the existing cancel (its locks and lease rules
 * apply: 409 CHUNK_IN_PROGRESS while a chunk is being written). A recording
 * being verified (COMPLETING) cannot be deleted until verification ends.
 */
export async function deleteTeacherRecording(input: { teacherId: string; recordingId: string }): Promise<void> {
  const row = await ownedRecording(input.teacherId, input.recordingId);
  if (row.uploadSession?.state === "COMPLETING" || row.state === "VERIFYING") throw uploadError("UPLOAD_COMPLETING");
  if (row.uploadSession?.state === "ACTIVE") {
    await cancelRecordingUpload({ teacherId: input.teacherId, uploadId: row.uploadSession.id });
  }
  const now = await serverNow();
  const deleted = await prisma.recordedLecture.updateMany({
    // Never while a verification is running (a complete may have started meanwhile).
    where: { id: row.id, teacherId: input.teacherId, status: 0, state: { not: "VERIFYING" } },
    data: { status: 2, deletedAt: now, deletedByTeacherId: input.teacherId, purgeRequestedAt: now, updatedAt: now },
  });
  if (deleted.count === 0) {
    const again = await prisma.recordedLecture.findFirst({ where: { id: row.id, teacherId: input.teacherId }, select: { status: true, state: true } });
    if (again && again.status === 0 && again.state === "VERIFYING") throw uploadError("UPLOAD_COMPLETING");
    throw recordingNotFound();
  }
}

/**
 * Stage 3.6: the teacher's DELETE is PERMANENT. The recording is marked
 * (deleteTeacherRecording: status 2, hidden everywhere, committed first), then
 * its stored file is deleted at once (purgeRemovedRecording, the maintenance
 * purge). DELETED = the file is gone and the row is final (status 1,
 * purgedAt); PENDING = hidden, the file deletion is retried by maintenance.
 * Deleting a recording that is already pending retries the purge.
 */
export async function deleteTeacherRecordingPermanently(input: { teacherId: string; recordingId: string }): Promise<"DELETED" | "PENDING"> {
  if (!isRecordedLectureId(input.recordingId)) throw recordingNotFound();
  const pending = await prisma.recordedLecture.findFirst({
    where: { id: input.recordingId, teacherId: input.teacherId, status: 2, purgedAt: null },
    select: { id: true },
  });
  if (!pending) await deleteTeacherRecording(input);
  const opened = await getRecordedLectureStorage(process.env);
  if (opened.ok) await purgeRemovedRecording(opened.storage, input.recordingId);
  // The database decides (a concurrent maintenance run may have finished it): final only as status 1.
  const after = await prisma.recordedLecture.findFirst({ where: { id: input.recordingId, teacherId: input.teacherId }, select: { status: true } });
  return after?.status === 1 ? "DELETED" : "PENDING";
}

/** Owner preview of a READY recording (same streaming, slots under "teacher:<id>"). */
export async function streamTeacherRecording(input: { teacherId: string; recordingId: string; request: Request }): Promise<Response> {
  if (!isRecordedLectureId(input.recordingId)) throw recordingNotFound();
  const target = await prisma.recordedLecture.findFirst({
    where: { id: input.recordingId, teacherId: input.teacherId, status: 0, state: "READY", storedFileName: { not: null } },
    select: { id: true, teacherId: true, lectureId: true, storedFileName: true, sizeBytes: true },
  });
  if (!target || !target.storedFileName) throw recordingNotFound();
  await assertOwnedLectureForRecording(input.teacherId, target.lectureId);
  return streamStoredRecording({
    target: { ...target, storedFileName: target.storedFileName },
    slotKey: `teacher:${input.teacherId}`,
    request: input.request,
  });
}
