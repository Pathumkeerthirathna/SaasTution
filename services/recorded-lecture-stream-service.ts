import { AppError, reportRouteError } from "@/lib/error-handler";
import { isStorageError } from "@/lib/file-storage/types";
import { prisma } from "@/lib/prisma";
import { bigintToSafeNumber } from "@/lib/recorded-lectures/bigint";
import { isRecordedLectureId, recordingFileKey } from "@/lib/recorded-lectures/keys";
import { getRecordedLectureStorage, invalidateRecordedLectureStorageForRootError } from "@/lib/recorded-lectures/storage";
import { createRecordingStreamResponse } from "@/lib/recorded-lectures/stream-response";
import { getStreamSlots } from "@/lib/recorded-lectures/stream-slots";
import { recordedLectureNotFound, studentRecordedLectureAccessWhere } from "@/services/recorded-lecture-student-service";

/*
 * Student playback of one recorded lecture (Recorded Lectures RL-4.3):
 * GET / HEAD /api/student/recorded-lectures/[recordingId]/stream.
 *
 * Every request (each Range request of a player) is authorised again with
 * the EXACT RL-4.2 filter, studentRecordedLectureAccessWhere(), in the query
 * that loads the file's location: approved active student, active
 * enrollment, active class and lecture, active READY recording with a
 * stored file name. Missing and not-allowed are the same 404 as RL-4.2.
 *
 * Order (nothing is held before it is needed):
 *   1. id format (404 without a query);
 *   2. authorisation + location (404);
 *   3. storage (cached per process; 503 when not configured);
 *   4. stat, size against the database, Range / If-Range (416 needs no slot);
 *   5. GET with a body only: a stream slot (429 per student / 503 per
 *      process, Retry-After set by the route), then the file is opened.
 * Slot release, idle timeout and file-handle cleanup: lib/recorded-lectures/stream-response.ts.
 *
 * A READY recording whose file is missing, has another size, or cannot be
 * read safely is an integrity problem: 500 RECORDING_FILE_UNAVAILABLE, logged
 * with the recording id and storage error code only (never a key, path or
 * file name). A ROOT_* storage error means the storage root itself is broken:
 * the cached storage handle is dropped and the answer is 503.
 */

export const STREAM_RETRY_AFTER_SECONDS = 5;

export const STREAM_LIMIT_CODES: ReadonlySet<string> = new Set(["STREAM_LIMIT_REACHED", "STREAMING_BUSY"]);

function notConfigured(): AppError {
  return new AppError("Recorded lectures are not available right now.", 503, "RECORDED_LECTURES_NOT_CONFIGURED");
}

function fileUnavailable(recordingId: string, code: string, request: Request): AppError {
  try {
    reportRouteError(new Error(`Recorded lecture file unavailable: recording ${recordingId} (${code}).`), {
      request,
      statusCode: 500,
      label: "Recorded lecture playback",
    });
  } catch {
    // Logging must never change the response.
  }
  return new AppError("This recording cannot be played right now.", 500, "RECORDING_FILE_UNAVAILABLE");
}

function acquireStreamSlot(slotKey: string): () => void {
  const slot = getStreamSlots().tryAcquire(slotKey);
  if (slot.ok) return slot.release;
  if (slot.reason === "STUDENT") {
    throw new AppError("Too many recordings are playing at once. Close one and try again.", 429, "STREAM_LIMIT_REACHED");
  }
  throw new AppError("Recordings are busy right now. Please try again shortly.", 503, "STREAMING_BUSY");
}

/** The playback response (200 / 206 / 416, or HEAD); throws AppErrors for the route's error handler. */
export async function streamStudentRecordedLecture(input: { studentId: string; recordingId: string; request: Request }): Promise<Response> {
  const { studentId, recordingId, request } = input;
  if (!isRecordedLectureId(recordingId)) throw recordedLectureNotFound();

  const target = await prisma.recordedLecture.findFirst({
    where: { AND: [{ id: recordingId }, studentRecordedLectureAccessWhere(studentId)] },
    // Internal only: used to build the key server-side, never sent to the client.
    select: { id: true, teacherId: true, lectureId: true, storedFileName: true, sizeBytes: true },
  });
  if (!target || !target.storedFileName) throw recordedLectureNotFound();
  return streamStoredRecording({ target: { ...target, storedFileName: target.storedFileName }, slotKey: studentId, request });
}

export type StreamTarget = { id: string; teacherId: string; lectureId: string; storedFileName: string; sizeBytes: bigint };

/**
 * The playback response for a recording the caller has ALREADY authorised
 * (student: the RL-4.2 filter above; teacher preview: ownership, in
 * recorded-lecture-teacher-service.ts). Builds the key server-side, checks
 * the size, takes a stream slot under `slotKey` only when a body is streamed.
 */
export async function streamStoredRecording(input: { target: StreamTarget; slotKey: string; request: Request }): Promise<Response> {
  const { target, slotKey, request } = input;
  let key: string;
  let expectedSize: number;
  try {
    key = recordingFileKey({ teacherId: target.teacherId, lectureId: target.lectureId, recordingId: target.id, storedName: target.storedFileName });
    expectedSize = bigintToSafeNumber(target.sizeBytes, "sizeBytes");
  } catch {
    throw fileUnavailable(target.id, "INVALID_LOCATION", request);
  }

  const opened = await getRecordedLectureStorage();
  if (!opened.ok) throw notConfigured();

  try {
    return await createRecordingStreamResponse({
      storage: opened.storage,
      key,
      request,
      expectedSize,
      acquireSlot: () => acquireStreamSlot(slotKey),
    });
  } catch (error) {
    if (error instanceof AppError) throw error; // the slot refusals
    if (isStorageError(error)) {
      if (invalidateRecordedLectureStorageForRootError(error.code)) throw notConfigured();
      throw fileUnavailable(target.id, error.code, request);
    }
    throw error;
  }
}
