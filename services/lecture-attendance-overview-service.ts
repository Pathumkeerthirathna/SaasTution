/**
 * Teacher attendance overview (Stage 5.5d-5a): one page of the teacher's
 * lectures with the state of each attendance register. READ ONLY.
 *
 * The lectures come from the existing listLecturesForTeacher
 * (services/lecture-service.ts), unchanged: the same teacher ownership
 * (class.teacherId), deleted lecture / class filtering, class (ownership
 * checked: 404 CLASS_NOT_FOUND), title, date-range filters, date sort and
 * pagination as the lecture list. Register data is then read for exactly
 * the lecture ids of that page, never ids from the client, with a fixed
 * number of bulk queries (no per-lecture call):
 *   1. LectureAttendanceRegister by lectureId IN (the page): exists,
 *      finalizedAt, version (and the scheduled start for the classification);
 *   2. LectureAttendance grouped by (lectureId, status): record counts;
 *   3. LectureAttendance with a pending review, grouped by lectureId.
 * Nothing per student is evaluated (no eligibility, readiness or absence
 * preview: those stay on the register and preview pages).
 *
 * classification: classifyLecture on the register's scheduled start (else
 * the lecture date), the same rule as the register view; null while
 * ATTENDANCE_EVIDENCE_STARTED_AT is missing or invalid.
 */

import { classifyLecture, loadEvidenceConfig, type LectureClassification } from "@/lib/attendance/config";
import { prisma } from "@/lib/prisma";
import { listLecturesForTeacher } from "@/services/lecture-service";

type Env = Record<string, string | undefined>;
type RecordStatus = "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";

export type AttendanceOverviewItem = {
  lectureId: string;
  title: string;
  /** UTC ISO instants. */
  date: string;
  endDate: string | null;
  classStatus: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  class: { id: string; name: string };
  /** Null: no attendance has been recorded for the lecture yet (no register). */
  register: { finalized: boolean; finalizedAt: string | null; version: number } | null;
  /** Canonical records by status (0 without a register). */
  recordStatus: Record<RecordStatus, number>;
  /** Records waiting for a teacher review. */
  pendingReviews: number;
  classification: LectureClassification | null;
};

export type AttendanceOverviewPage = { items: AttendanceOverviewItem[]; totalItems: number };

export type AttendanceOverviewQuery = {
  teacherId: string;
  classId?: string;
  title?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sortOrder?: "asc" | "desc";
  skip: number;
  take: number;
};

const STATUSES: readonly RecordStatus[] = ["PRESENT", "LATE", "ABSENT", "EXCUSED"];

export async function listLectureAttendanceOverviewForTeacher(
  query: AttendanceOverviewQuery,
  options: { env?: Env } = {}
): Promise<AttendanceOverviewPage> {
  // The lecture list's own ownership, filters, sort and pagination (the teacher id is the caller's session).
  const { lectures, totalItems } = await listLecturesForTeacher({
    teacherId: query.teacherId,
    classId: query.classId,
    title: query.title,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    sortOrder: query.sortOrder,
    skip: query.skip,
    take: query.take,
  });
  if (lectures.length === 0) return { items: [], totalItems };

  // Only the ids of this ownership-checked page.
  const lectureIds = lectures.map((lecture) => lecture.id);
  const [registers, statusGroups, reviewGroups] = await Promise.all([
    prisma.lectureAttendanceRegister.findMany({
      where: { lectureId: { in: lectureIds } },
      select: { lectureId: true, finalizedAt: true, version: true, scheduledStartAt: true },
    }),
    prisma.lectureAttendance.groupBy({
      by: ["lectureId", "status"],
      where: { lectureId: { in: lectureIds } },
      _count: { _all: true },
    }),
    prisma.lectureAttendance.groupBy({
      by: ["lectureId"],
      where: { lectureId: { in: lectureIds }, pendingReviewSince: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const registerBy = new Map(registers.map((register) => [register.lectureId, register]));
  const statusBy = new Map<string, Record<RecordStatus, number>>();
  for (const group of statusGroups) {
    const counts = statusBy.get(group.lectureId) ?? { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 };
    if ((STATUSES as readonly string[]).includes(group.status)) counts[group.status as RecordStatus] += group._count._all;
    statusBy.set(group.lectureId, counts);
  }
  const reviewsBy = new Map(reviewGroups.map((group) => [group.lectureId, group._count._all]));

  const evidence = loadEvidenceConfig(options.env ?? process.env);
  const evidenceStartedAt = evidence.status === "OK" ? evidence.evidenceStartedAt : null;

  const items = lectures.map((lecture): AttendanceOverviewItem => {
    const register = registerBy.get(lecture.id) ?? null;
    return {
      lectureId: lecture.id,
      title: lecture.title,
      date: lecture.date.toISOString(),
      endDate: lecture.endDate ? lecture.endDate.toISOString() : null,
      classStatus: lecture.classStatus,
      class: { id: lecture.class.id, name: lecture.class.name },
      register: register
        ? { finalized: register.finalizedAt !== null, finalizedAt: register.finalizedAt ? register.finalizedAt.toISOString() : null, version: register.version }
        : null,
      recordStatus: statusBy.get(lecture.id) ?? { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 },
      pendingReviews: reviewsBy.get(lecture.id) ?? 0,
      classification: evidenceStartedAt ? classifyLecture(register?.scheduledStartAt ?? lecture.date, evidenceStartedAt) : null,
    };
  });

  return { items, totalItems };
}
