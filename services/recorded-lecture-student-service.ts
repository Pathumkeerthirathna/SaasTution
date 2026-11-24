import type { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { loadRecordedLectureConfig } from "@/lib/recorded-lectures/config";
import { dashboardLectureStartRange } from "@/lib/recorded-lectures/dashboard-window";
import { isRecordedLectureId } from "@/lib/recorded-lectures/keys";
import {
  assertStudentClientSafe,
  buildStudentRecordedLectureDto,
  type StudentRecordedLectureDto,
  type StudentRecordedLectureRow,
} from "@/lib/recorded-lectures/student-dto";
import { serverNow } from "@/lib/server-clock";
import { billingMonthOf, loadStudentResourceAccess, resourceLockFor, type StudentResourceAccess } from "@/services/resource-access-service";

/*
 * Student access to recorded lectures (Recorded Lectures RL-4.2): the list
 * and the metadata of one recording. Playback (RL-4.3) is not here yet; it
 * will authorise with the same studentRecordedLectureAccessWhere().
 *
 * Authorisation on EVERY request, in the same single query that loads the
 * rows (no separate check that could go stale between two queries):
 *   - the recording is active (status 0; never "not 1": 2 = purge pending),
 *     READY and has its stored file name;
 *   - its lecture is active (status 0);
 *   - its class is active (status 0) and the student has an ACTIVE
 *     enrollment in it (ClassStudent.isActive), and the enrolled student is
 *     active and APPROVED (confirmationStatus).
 * The recording's class is its lecture's class and its teacher is the
 * class's teacher (composite foreign keys, RL-2), so enrollment in the
 * recording's class is enrollment in the lecture's class, and another
 * teacher's (or another class's) recording never matches.
 *
 * The student id always comes from the verified session (the caller passes
 * requireStudentSession().studentId); nothing from the request is trusted
 * as identity. A recording that does not exist and one the student may not
 * see give the same 404 (same code, message and body).
 */

const NOT_FOUND_MESSAGE = "Recorded lecture not found.";

export function recordedLectureNotFound(): AppError {
  return new AppError(NOT_FOUND_MESSAGE, 404, "RECORDED_LECTURE_NOT_FOUND");
}

function badRequest(message: string, code: string): AppError {
  return new AppError(message, 400, code);
}

/** The single authorisation filter for a student and a recording (list, metadata and, in RL-4.3, playback). */
export function studentRecordedLectureAccessWhere(studentId: string): Prisma.RecordedLectureWhereInput {
  return {
    status: 0,
    state: "READY",
    storedFileName: { not: null },
    lecture: { status: 0 },
    class: {
      status: 0,
      students: {
        some: {
          studentId,
          isActive: true,
          student: { status: 0, confirmationStatus: "APPROVED" },
        },
      },
    },
  };
}

/** Exactly the columns the student DTO reads; never the stored file name, teacher, paths or upload data. */
const studentSelect = {
  id: true,
  title: true,
  partNumber: true,
  sizeBytes: true,
  durationSeconds: true,
  width: true,
  height: true,
  readyAt: true,
  // The upload instant: the recording's billing month (resource access). Never sent.
  createdAt: true,
  lectureId: true,
  // isDefault: a General Recording (the class's default lecture); never sent as such (the DTO's isGeneral).
  lecture: { select: { id: true, title: true, date: true, endDate: true, isDefault: true } },
  class: { select: { id: true, name: true } },
} satisfies Prisma.RecordedLectureSelect;

/**
 * General Recordings on the DASHBOARD (section "general", scope "dashboard"):
 * newest available first (readyAt; a row without it, which a READY recording
 * never is, last by its upload start), then id, so the widget's merge keeps
 * the most recent ones within its limit. The default lecture's date is the
 * class's creation and never orders them. The full General list (scope "all")
 * uses listOrder instead: within a class that is part number ascending, the
 * same order as the General player (one lecture: the class's default lecture).
 */
const generalOrder: Prisma.RecordedLectureOrderByWithRelationInput[] = [
  { readyAt: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
  { id: "desc" },
];

/** Newest lecture first; then lecture id, part number and recording id, so the order is total and stable. */
const listOrder: Prisma.RecordedLectureOrderByWithRelationInput[] = [
  { lecture: { date: "desc" } },
  { lectureId: "asc" },
  { partNumber: "asc" },
  { id: "asc" },
];

function dashboardDays(): number {
  const loaded = loadRecordedLectureConfig(process.env);
  if (!loaded.ok) {
    throw new AppError("Recorded lectures are not available right now.", 503, "RECORDED_LECTURES_NOT_CONFIGURED");
  }
  return loaded.config.dashboardAvailabilityDays;
}

// ---- Query parameters ----------------------------------------------------------------------------

export type StudentRecordedLectureScope = "all" | "dashboard";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
const MAX_CURSOR_LENGTH = 512;
const MAX_PART_NUMBER = 2_147_483_647; // the INTEGER column's maximum (the database only requires >= 1)

/**
 * Which recordings of the student's classes: "general" = General Recordings
 * only (the class's default lecture, newest available first); "lecture" =
 * recordings of normal lectures only; "all" (absent, the default) = both, in
 * the existing order (unchanged for existing callers).
 */
export type StudentRecordedLectureSection = "all" | "general" | "lecture";

export type StudentRecordedLectureListQuery = {
  scope?: string | null;
  section?: string | null;
  lectureId?: string | null;
  /** RL-5.1: only this class's recordings (still AND-ed with the full access filter). */
  classId?: string | null;
  cursor?: string | null;
  limit?: string | null;
};

function parseScope(value: string | null | undefined): StudentRecordedLectureScope {
  if (value === null || value === undefined || value === "" || value === "all") return "all";
  if (value === "dashboard") return "dashboard";
  throw badRequest("scope must be \"all\" or \"dashboard\".", "INVALID_SCOPE");
}

function parseSection(value: string | null | undefined): StudentRecordedLectureSection {
  if (value === null || value === undefined || value === "" || value === "all") return "all";
  if (value === "general" || value === "lecture") return value;
  throw badRequest('section must be "all", "general" or "lecture".', "INVALID_SECTION");
}

function parseLimit(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") return DEFAULT_PAGE_SIZE;
  if (!/^\d{1,3}$/.test(value)) throw badRequest(`limit must be 1 to ${MAX_PAGE_SIZE}.`, "INVALID_LIMIT");
  const limit = Number(value);
  if (limit < 1 || limit > MAX_PAGE_SIZE) throw badRequest(`limit must be 1 to ${MAX_PAGE_SIZE}.`, "INVALID_LIMIT");
  return limit;
}

function parseLectureId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isRecordedLectureId(value)) throw badRequest("lectureId is not a valid id.", "INVALID_LECTURE_ID");
  return value;
}

function parseClassId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isRecordedLectureId(value)) throw badRequest("classId is not a valid id.", "INVALID_CLASS_ID");
  return value;
}

/**
 * The position after the last row of a page: the four sort keys of that row.
 * Opaque to clients (base64url JSON); it only holds values the student
 * already received in that row (lecture date and id, part number, id).
 */
export type ListCursor = { lectureDate: Date; lectureId: string; partNumber: number; id: string };

export function encodeListCursor(cursor: ListCursor): string {
  const json = JSON.stringify([cursor.lectureDate.getTime(), cursor.lectureId, cursor.partNumber, cursor.id]);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeListCursor(value: string): ListCursor | null {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return null;
  const [ms, lectureId, partNumber, id] = parsed as unknown[];
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || Number.isNaN(new Date(ms).getTime())) return null;
  if (!isRecordedLectureId(lectureId) || !isRecordedLectureId(id)) return null;
  if (typeof partNumber !== "number" || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) return null;
  return { lectureDate: new Date(ms), lectureId, partNumber, id };
}

function parseCursor(value: string | null | undefined): ListCursor | null {
  if (value === null || value === undefined || value === "") return null;
  const cursor = decodeListCursor(value);
  if (!cursor) throw badRequest("The page cursor is not valid.", "INVALID_CURSOR");
  return cursor;
}

/**
 * The position after the last row of a General Recordings page (section
 * "general"): its sort keys (readyAt, createdAt, id). Opaque to clients;
 * tagged "g", so it is never mistaken for a lecture cursor (or the reverse).
 */
export type GeneralListCursor = { readyAt: Date | null; createdAt: Date; id: string };

export function encodeGeneralListCursor(cursor: GeneralListCursor): string {
  const json = JSON.stringify(["g", cursor.readyAt ? cursor.readyAt.getTime() : null, cursor.createdAt.getTime(), cursor.id]);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeGeneralListCursor(value: string): GeneralListCursor | null {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== "g") return null;
  const [, readyMs, createdMs, id] = parsed as unknown[];
  const validMs = (ms: unknown): ms is number => typeof ms === "number" && Number.isSafeInteger(ms) && !Number.isNaN(new Date(ms).getTime());
  if (readyMs !== null && !validMs(readyMs)) return null;
  if (!validMs(createdMs) || !isRecordedLectureId(id)) return null;
  return { readyAt: readyMs === null ? null : new Date(readyMs), createdAt: new Date(createdMs), id };
}

function parseGeneralCursor(value: string | null | undefined): GeneralListCursor | null {
  if (value === null || value === undefined || value === "") return null;
  const cursor = decodeGeneralListCursor(value);
  if (!cursor) throw badRequest("The page cursor is not valid.", "INVALID_CURSOR");
  return cursor;
}

/** Rows strictly after `cursor` in generalOrder (readyAt desc nulls last, createdAt desc, id desc). */
function afterGeneralCursorWhere(cursor: GeneralListCursor): Prisma.RecordedLectureWhereInput {
  if (cursor.readyAt === null) {
    return {
      OR: [
        { readyAt: null, createdAt: { lt: cursor.createdAt } },
        { readyAt: null, createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    };
  }
  return {
    OR: [
      { readyAt: { lt: cursor.readyAt } },
      { readyAt: null },
      { readyAt: cursor.readyAt, createdAt: { lt: cursor.createdAt } },
      { readyAt: cursor.readyAt, createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/**
 * The dashboard window (scope "dashboard"): a normal lecture's recordings from
 * the lecture start, exactly as before; a General Recording from when it
 * became available (readyAt, else its upload start), never from the default
 * lecture's date (the class's creation).
 */
function dashboardWindowWhere(now: Date, days: number): Prisma.RecordedLectureWhereInput {
  const range = dashboardLectureStartRange(now, days);
  return {
    OR: [
      { lecture: { isDefault: false, date: range } },
      { lecture: { isDefault: true }, readyAt: range },
      { lecture: { isDefault: true }, readyAt: null, createdAt: range },
    ],
  };
}

/** Rows strictly after `cursor` in listOrder (date desc, lectureId asc, partNumber asc, id asc). */
function afterCursorWhere(cursor: ListCursor): Prisma.RecordedLectureWhereInput {
  const sameDate: Prisma.RecordedLectureWhereInput = { lecture: { date: cursor.lectureDate } };
  return {
    OR: [
      { lecture: { date: { lt: cursor.lectureDate } } },
      { AND: [sameDate, { lectureId: { gt: cursor.lectureId } }] },
      { AND: [sameDate, { lectureId: cursor.lectureId, partNumber: { gt: cursor.partNumber } }] },
      { AND: [sameDate, { lectureId: cursor.lectureId, partNumber: cursor.partNumber, id: { gt: cursor.id } }] },
    ],
  };
}

// ---- List ----------------------------------------------------------------------------------------

export type StudentRecordedLectureList = {
  scope: StudentRecordedLectureScope;
  dashboardDays: number;
  recordedLectures: StudentRecordedLectureDto[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
};

/**
 * The student's recorded lectures. scope "all" (default): every recording
 * the student may watch, whatever the dashboard window. scope "dashboard":
 * only those whose lecture started within the last dashboardDays days
 * (lib/recorded-lectures/dashboard-window.ts). Optional lectureId narrows to
 * one lecture and optional classId (RL-5.1) to one class; both are only
 * extra AND conditions on top of the full access filter, so they can narrow
 * the result but never widen it (a lecture or class the student cannot see
 * simply gives no rows).
 * Query problems are 400; parameters are validated before any query.
 */
export async function listStudentRecordedLectures(input: {
  studentId: string;
  query: StudentRecordedLectureListQuery;
  /** A resolver already loaded in this request (the player's page loop reuses one). */
  access?: StudentResourceAccess;
}): Promise<StudentRecordedLectureList> {
  const scope = parseScope(input.query.scope);
  const section = parseSection(input.query.section);
  const limit = parseLimit(input.query.limit);
  const lectureId = parseLectureId(input.query.lectureId);
  const classId = parseClassId(input.query.classId);
  // Newest-first General order and its own cursor: the dashboard only. Every other list (the class
  // page's General section included) uses listOrder and the lecture cursor, as before.
  const newestGeneral = section === "general" && scope === "dashboard";
  const cursor = newestGeneral ? null : parseCursor(input.query.cursor);
  const generalCursor = newestGeneral ? parseGeneralCursor(input.query.cursor) : null;
  const days = dashboardDays();
  const now = await serverNow();

  const filters: Prisma.RecordedLectureWhereInput[] = [studentRecordedLectureAccessWhere(input.studentId)];
  if (section === "general") filters.push({ lecture: { isDefault: true } });
  if (section === "lecture") filters.push({ lecture: { isDefault: false } });
  if (scope === "dashboard") filters.push(dashboardWindowWhere(now, days));
  if (lectureId) filters.push({ lectureId });
  if (classId) filters.push({ classId });
  if (cursor) filters.push(afterCursorWhere(cursor));
  if (generalCursor) filters.push(afterGeneralCursorWhere(generalCursor));

  const rows = await prisma.recordedLecture.findMany({
    where: { AND: filters },
    orderBy: newestGeneral ? generalOrder : listOrder,
    take: limit + 1,
    select: studentSelect,
  });

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  // Monthly resource access: one batched load for the page's classes; a
  // locked month's recording is listed without its stream path.
  const access =
    input.access ??
    (await loadStudentResourceAccess(input.studentId, { classIds: [...new Set(page.map((row) => row.class.id))] }));
  const nextCursor =
    rows.length > limit && last
      ? newestGeneral
        ? encodeGeneralListCursor({ readyAt: last.readyAt, createdAt: last.createdAt, id: last.id })
        : encodeListCursor({ lectureDate: last.lecture.date, lectureId: last.lectureId, partNumber: last.partNumber, id: last.id })
      : null;

  const result: StudentRecordedLectureList = {
    scope,
    dashboardDays: days,
    recordedLectures: page.map((row) =>
      buildStudentRecordedLectureDto(toRow(row), {
        now,
        dashboardDays: days,
        lock: resourceLockFor(access, row.class.id, billingMonthOf(row.createdAt)),
      })
    ),
    nextCursor,
  };
  assertStudentClientSafe(result);
  return result;
}

// ---- One recording -------------------------------------------------------------------------------

/** One recording's metadata; 404 RECORDED_LECTURE_NOT_FOUND when it is missing OR the student may not see it. */
export async function getStudentRecordedLecture(input: { studentId: string; recordingId: string }): Promise<StudentRecordedLectureDto> {
  if (!isRecordedLectureId(input.recordingId)) throw recordedLectureNotFound();
  const days = dashboardDays();
  const now = await serverNow();

  const row = await prisma.recordedLecture.findFirst({
    where: { AND: [{ id: input.recordingId }, studentRecordedLectureAccessWhere(input.studentId)] },
    select: studentSelect,
  });
  if (!row) throw recordedLectureNotFound();
  return buildStudentRecordedLectureDto(toRow(row), { now, dashboardDays: days });
}

type SelectedRow = Prisma.RecordedLectureGetPayload<{ select: typeof studentSelect }>;

/** Only the DTO's input columns (lectureId is read for the cursor, never sent). */
function toRow(row: SelectedRow): StudentRecordedLectureRow {
  return {
    id: row.id,
    title: row.title,
    partNumber: row.partNumber,
    sizeBytes: row.sizeBytes,
    durationSeconds: row.durationSeconds,
    width: row.width,
    height: row.height,
    readyAt: row.readyAt,
    createdAt: row.createdAt,
    lecture: row.lecture,
    class: row.class,
  };
}
