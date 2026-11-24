import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { isRecordedLectureId } from "@/lib/recorded-lectures/keys";
import type { StudentRecordedLectureDto } from "@/lib/recorded-lectures/student-dto";
import { listStudentRecordedLectures, MAX_PAGE_SIZE } from "@/services/recorded-lecture-student-service";
import { loadStudentResourceAccess, type StudentResourceAccess } from "@/services/resource-access-service";

/*
 * Server-side loaders for the student Recorded Lectures pages (RL-5.1).
 *
 * The pages call these directly (no HTTP hop) and the recordings always
 * come from listStudentRecordedLectures(), i.e. the exact RL-4.2 access
 * filter. Results are discriminated so a page can render notFound() or an
 * "unavailable" panel instead of throwing:
 *   NOT_FOUND    invalid id, class not actively joined, or no visible recording
 *   UNAVAILABLE  recorded lectures not configured (503 from the service)
 */

export type LoaderFailure = { ok: false; reason: "NOT_FOUND" | "UNAVAILABLE" };

/** At most this many pages of parts are loaded on the server for one lecture (4 x 50 = 200). */
export const MAX_SERVER_PART_PAGES = 4;

export type StudentClassSummary = { id: string; name: string };

/** The student's ACTIVE classes (active enrollment, class status 0), by name. */
export async function loadStudentRecordingClasses(studentId: string): Promise<StudentClassSummary[]> {
  const rows = await prisma.classStudent.findMany({
    where: { studentId, isActive: true, class: { status: 0 } },
    orderBy: { class: { name: "asc" } },
    select: { class: { select: { id: true, name: true } } },
  });
  const seen = new Set<string>();
  const classes: StudentClassSummary[] = [];
  for (const row of rows) {
    if (seen.has(row.class.id)) continue;
    seen.add(row.class.id);
    classes.push({ id: row.class.id, name: row.class.name });
  }
  return classes;
}

function failure(error: unknown): LoaderFailure {
  if (error instanceof AppError) {
    if (error.statusCode === 400 || error.statusCode === 404) return { ok: false, reason: "NOT_FOUND" };
    if (error.statusCode === 503) return { ok: false, reason: "UNAVAILABLE" };
  }
  throw error;
}

export type ClassRecordingsPage =
  | {
      ok: true;
      class: StudentClassSummary;
      recordedLectures: StudentRecordedLectureDto[];
      nextCursor: string | null;
    }
  | LoaderFailure;

/**
 * One class's recordings (first page). The class must be one the student is
 * actively enrolled in (else NOT_FOUND); the rows come from the RL-4.2
 * service with classId, so the full access filter still decides every row.
 */
export async function loadClassRecordings(studentId: string, classId: string): Promise<ClassRecordingsPage> {
  if (!isRecordedLectureId(classId)) return { ok: false, reason: "NOT_FOUND" };
  try {
    const enrollment = await prisma.classStudent.findFirst({
      where: { studentId, classId, isActive: true, class: { status: 0 } },
      select: { class: { select: { id: true, name: true } } },
    });
    if (!enrollment) return { ok: false, reason: "NOT_FOUND" };
    const list = await listStudentRecordedLectures({ studentId, query: { classId, limit: String(MAX_PAGE_SIZE) } });
    return {
      ok: true,
      class: { id: enrollment.class.id, name: enrollment.class.name },
      recordedLectures: list.recordedLectures,
      nextCursor: list.nextCursor,
    };
  } catch (error) {
    return failure(error);
  }
}

export type LecturePlayerPage =
  | {
      ok: true;
      lecture: StudentRecordedLectureDto["lecture"];
      class: StudentRecordedLectureDto["class"];
      parts: StudentRecordedLectureDto[];
      /** Non-null when the lecture has more parts than the server loaded; the player offers "Load more parts". */
      nextCursor: string | null;
      /** The monthly resource access the parts were marked with (one load per page view; reused for the locked-month messages). */
      access: StudentResourceAccess;
    }
  | LoaderFailure;

/**
 * Every visible part of one lecture, up to MAX_SERVER_PART_PAGES pages. More
 * parts are never hidden silently: nextCursor is returned so the player can
 * show that more exist and load them. NOT_FOUND when the student can see no
 * part of this lecture.
 */
export async function loadLecturePlayer(studentId: string, lectureId: string): Promise<LecturePlayerPage> {
  if (!isRecordedLectureId(lectureId)) return { ok: false, reason: "NOT_FOUND" };
  try {
    const parts: StudentRecordedLectureDto[] = [];
    let cursor: string | null = null;
    // Monthly resource access: loaded once (three batched queries) for every
    // page of parts and for the page's locked-month messages.
    const access = await loadStudentResourceAccess(studentId);
    for (let page = 0; page < MAX_SERVER_PART_PAGES; page += 1) {
      const list = await listStudentRecordedLectures({
        studentId,
        query: { lectureId, limit: String(MAX_PAGE_SIZE), cursor },
        access,
      });
      parts.push(...list.recordedLectures);
      cursor = list.nextCursor;
      if (!cursor) break;
    }
    const first = parts[0];
    if (!first) return { ok: false, reason: "NOT_FOUND" };
    return { ok: true, lecture: first.lecture, class: first.class, parts, nextCursor: cursor, access };
  } catch (error) {
    return failure(error);
  }
}
