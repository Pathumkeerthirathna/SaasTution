import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { clientKey } from "@/lib/error-logging/request-trust";
import { prisma } from "@/lib/prisma";
import { isRecordedLectureId } from "@/lib/recorded-lectures/keys";
import { getPublicStreamSlots } from "@/lib/recorded-lectures/public-stream-slots";
import { getPublicClassSessions } from "@/services/class-service";
import { recordedLectureNotFound } from "@/services/recorded-lecture-student-service";
import { streamStoredRecording } from "@/services/recorded-lecture-stream-service";
import type { ClassLectureSession, ClassLectureUploadedRecording } from "@/types/teacherProfileTypes/ClassLectureSession";

/*
 * Uploaded recorded lectures on the PUBLIC class pages (public teacher
 * profile integration). Anyone can call these, so every rule is decided here,
 * on the server, in the same query that loads the rows:
 *
 *   listed    publicRecordedLectureWhere(): an active (status 0), READY
 *             recording with a stored file, visibility PUBLIC, an active
 *             lecture and class, and a teacher whose public profile exists
 *             and is enabled (TeacherProfile.isPublic).
 *   playable  the same AND access FREE ("Unlocked"). A LOCKED recording is
 *             listed WITHOUT a stream URL and its stream is the same 404 as
 *             a missing one.
 *
 * Playback re-runs the playable filter on EVERY request (each Range request
 * of a player, GET and HEAD), so a change of privacy, access, profile,
 * lecture or class takes effect on the next request. The storage key is
 * built server-side only (streamStoredRecording); nothing that could lead to
 * a file is sent for a recording that is not playable.
 *
 * Enrolled students are not affected: they keep using the student routes and
 * their own filter (studentRecordedLectureAccessWhere), which does not read
 * visibility or access. YouTube recordings keep their own, unchanged rules
 * (getPublicClassSessions); this module only adds uploaded ones next to them.
 */

/** The single rule for a recording to be LISTED on a public class page. */
export function publicRecordedLectureWhere(): Prisma.RecordedLectureWhereInput {
  return {
    status: 0,
    state: "READY",
    storedFileName: { not: null },
    visibility: "PUBLIC",
    // General Recordings (the class's default lecture) are never public: not
    // listed, not playable, not in the restricted-student fallback.
    lecture: { status: 0, isDefault: false },
    class: { status: 0 },
    teacher: { profile: { is: { isPublic: true } } },
  };
}

/** The single rule for a recording to be PLAYABLE by anyone: listed AND Unlocked. */
export function publicPlayableRecordedLectureWhere(): Prisma.RecordedLectureWhereInput {
  return { AND: [publicRecordedLectureWhere(), { access: "FREE" }] };
}

export function publicStreamPath(recordingId: string): string {
  return `/api/public/recorded-lectures/${encodeURIComponent(recordingId)}/stream`;
}

// ---- Listing ------------------------------------------------------------------------------------

type PublicRecordingRow = {
  id: string;
  title: string;
  partNumber: number;
  durationSeconds: number | null;
  access: string;
  lecture: { id: string; title: string; date: Date; createdAt: Date };
};

/**
 * A recording for the public pages. The stream URL is included only for a
 * FREE recording; anything else (LOCKED, or an unknown value) is returned
 * without it: deny by default, decided here.
 */
export function toPublicUploadedRecording(row: Omit<PublicRecordingRow, "lecture">): ClassLectureUploadedRecording {
  const base = {
    source: "UPLOAD" as const,
    id: row.id,
    title: row.title,
    partNumber: row.partNumber,
    durationSeconds: typeof row.durationSeconds === "number" ? row.durationSeconds : null,
  };
  return row.access === "FREE"
    ? { ...base, access: "FREE", streamUrl: publicStreamPath(row.id) }
    : { ...base, access: "LOCKED", streamUrl: null };
}

/** A class's publicly listed uploaded recordings, with their lectures, by part number. */
async function listPublicUploadedRecordings(classId: string): Promise<PublicRecordingRow[]> {
  if (typeof classId !== "string" || classId === "") return [];
  return prisma.recordedLecture.findMany({
    where: { AND: [{ classId }, publicRecordedLectureWhere()] },
    orderBy: [{ partNumber: "asc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      partNumber: true,
      durationSeconds: true,
      access: true,
      lecture: { select: { id: true, title: true, date: true, createdAt: true } },
    },
  });
}

/**
 * The YouTube course sessions exactly as getPublicClassSessions returns them,
 * with the uploaded recordings added to their lectures (`uploads`). A lecture
 * with only uploaded recordings becomes a session of its own; sessions stay
 * newest lecture first (a stable sort, so the YouTube sessions keep their
 * order). A session without uploads is returned unchanged (no `uploads`
 * key), and with no uploads at all the YouTube list itself is returned.
 */
export function mergePublicUploadedRecordings(sessions: ClassLectureSession[], rows: PublicRecordingRow[]): ClassLectureSession[] {
  if (rows.length === 0) return sessions;

  const uploadsByLecture = new Map<string, { lecture: PublicRecordingRow["lecture"]; uploads: ClassLectureUploadedRecording[] }>();
  for (const row of rows) {
    const entry = uploadsByLecture.get(row.lecture.id) ?? { lecture: row.lecture, uploads: [] };
    entry.uploads.push(toPublicUploadedRecording(row));
    uploadsByLecture.set(row.lecture.id, entry);
  }

  const merged: ClassLectureSession[] = sessions.map((session) => {
    const entry = uploadsByLecture.get(session.id);
    if (!entry) return session;
    uploadsByLecture.delete(session.id);
    return { ...session, uploads: entry.uploads };
  });
  for (const { lecture, uploads } of uploadsByLecture.values()) {
    merged.push({
      id: lecture.id,
      title: lecture.title,
      date: lecture.date.toISOString(),
      createdAt: lecture.createdAt.toISOString(),
      recordings: [],
      uploads,
    });
  }
  return merged.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Public course sessions of a class: YouTube recordings (unchanged rules) plus uploaded recordings. */
export async function getPublicClassSessionsWithUploads(classId: string): Promise<ClassLectureSession[]> {
  const [sessions, rows] = await Promise.all([getPublicClassSessions(classId), listPublicUploadedRecordings(classId)]);
  return mergePublicUploadedRecordings(sessions, rows);
}

// ---- Payment-restricted students (student dashboard) ----------------------------------------------

/**
 * Only what ANYONE can already play on the public class page: FREE
 * ("Unlocked") YouTube recordings and uploads. LOCKED ones are dropped (they
 * belong to the class's paid content), and so is a lecture left with nothing.
 */
export function playablePublicSessions(sessions: ClassLectureSession[]): ClassLectureSession[] {
  const playable: ClassLectureSession[] = [];
  for (const session of sessions) {
    const recordings = session.recordings.filter((recording) => recording.access === "FREE");
    const uploads = (session.uploads ?? []).filter((upload) => upload.access === "FREE");
    if (recordings.length === 0 && uploads.length === 0) continue;
    playable.push({ ...session, recordings, ...(uploads.length > 0 ? { uploads } : {}) });
  }
  return playable;
}

export type RestrictedClassPublicSessions = { classId: string; className: string; sessions: ClassLectureSession[] };

/**
 * For the student dashboard: the publicly playable course sessions of each
 * class the student is currently payment-restricted in (either reason), so
 * they can keep watching what the teacher published for everyone. Exactly
 * the public class page's data (getPublicClassSessionsWithUploads, then
 * playablePublicSessions) and its public playback (YouTube embed / the public
 * stream route, authorised again on every request): no student content route,
 * no class-access exception, no private recording. Classes without such
 * sessions, and unrestricted students, get nothing (the dashboard is unchanged).
 */
export async function getPublicSessionsForRestrictedClasses(
  studentId: string,
  getRestrictions: (studentId: string) => Promise<readonly { classId: string; className: string }[]>
): Promise<RestrictedClassPublicSessions[]> {
  const classes = new Map<string, string>();
  for (const restriction of await getRestrictions(studentId)) classes.set(restriction.classId, restriction.className);
  const result: RestrictedClassPublicSessions[] = [];
  for (const [classId, className] of classes) {
    const sessions = playablePublicSessions(await getPublicClassSessionsWithUploads(classId));
    if (sessions.length > 0) result.push({ classId, className, sessions });
  }
  return result;
}

// ---- Playback -----------------------------------------------------------------------------------

function publicStreamRefused(reason: "STUDENT" | "GLOBAL"): AppError {
  return reason === "STUDENT"
    ? new AppError("Too many recordings are playing at once. Close one and try again.", 429, "STREAM_LIMIT_REACHED")
    : new AppError("Recordings are busy right now. Please try again shortly.", 503, "STREAMING_BUSY");
}

/** The public slot for this client (see public-stream-slots.ts); throws the 429 / 503 refusals. */
function acquirePublicSlot(client: string): () => void {
  const slot = getPublicStreamSlots().tryAcquire(client);
  if (!slot.ok) throw publicStreamRefused(slot.reason);
  return slot.release;
}

/**
 * Public playback (GET / HEAD /api/public/recorded-lectures/[recordingId]/stream):
 * 200 / 206 / 416 for a playable recording; the same 404 for one that does not
 * exist, is private, locked, not READY, deleted, or whose lecture, class or
 * public profile is not active. Throws AppErrors for the route.
 */
export async function streamPublicRecordedLecture(input: { recordingId: string; request: Request }): Promise<Response> {
  const { recordingId, request } = input;
  if (!isRecordedLectureId(recordingId)) throw recordedLectureNotFound();

  const target = await prisma.recordedLecture.findFirst({
    where: { AND: [{ id: recordingId }, publicPlayableRecordedLectureWhere()] },
    // Internal only: used to build the key server-side, never sent to the client.
    select: { id: true, teacherId: true, lectureId: true, storedFileName: true, sizeBytes: true },
  });
  if (!target || !target.storedFileName) throw recordedLectureNotFound();

  // Without a trusted proxy there is no reliable client identity: each request is its own client.
  const client = clientKey(request) ?? `unidentified:${randomUUID()}`;
  return streamStoredRecording({
    target: { ...target, storedFileName: target.storedFileName },
    slotKey: `public:${client}`,
    request,
    acquireExtraSlot: () => acquirePublicSlot(client),
  });
}
