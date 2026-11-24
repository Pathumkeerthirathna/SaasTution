/**
 * Lecture creation from the teacher's Attendance page ("Open QR Scanner"
 * with a class but no lecture), with protection against accidental
 * duplicates. The lecture itself is created by the existing
 * createLectureForTeacher (services/lecture-service.ts): the same ownership
 * check (404 CLASS_NOT_FOUND), fields and validation as every other lecture.
 * It is a normal Lecture: no schedule link is stored, so a later ClassSchedule
 * edit never changes it (the lecture keeps its own date / endDate, and its
 * attendance register freezes them).
 *
 * Duplicate rule: another non-deleted, non-cancelled lecture of the same
 * class on the same Sri Lankan calendar day whose time overlaps the new one
 * ([date, endDate], or the start instant alone without an end; the same
 * start always overlaps). Then 409 ATTENDANCE_LECTURE_EXISTS with those
 * lectures, and nothing is created, unless the teacher explicitly confirmed
 * an additional session (allowAdditionalSession). A session at another time
 * of the day is never blocked.
 *
 * Transaction-safe: the check and the insert run in one transaction under
 * a transaction-scoped advisory lock on (class, Sri Lankan day), so two
 * concurrent requests (two tabs, a double click) are serialized and the
 * second sees the first's lecture. The live-update event is emitted only
 * after the commit.
 *
 * Inside the lock, only what must be atomic with the duplicate check runs
 * (4 statements between BEGIN and COMMIT): the bounded lock, the same-day
 * lectures, the ownership check and one INSERT ... RETURNING
 * (createLectureForTeacher with the transaction). No event, network call or
 * re-read happens inside it. Interactive transactions use the project's
 * { maxWait: 5 s, timeout: 15 s } (Prisma's 5 s default expired on the remote,
 * pooled database: each statement costs about two network round trips). The
 * lock wait is bounded by a transaction-local lock_timeout set in the same
 * statement (no extra round trip), so a stuck holder ends as a clean 409
 * ATTENDANCE_BUSY long before this transaction could expire.
 */

import type { Prisma } from "@prisma/client";

import { mapAttendanceLockError } from "@/lib/attendance/service-errors";
import { AppError } from "@/lib/error-handler";
import type { CreateLectureInput } from "@/lib/lecture-validation";
import { NORMAL_LECTURE_WHERE } from "@/lib/default-lecture";
import { prisma } from "@/lib/prisma";
import { emitStudentDataChange } from "@/lib/session-events";
import { sriLankaDateKey, sriLankaDigitsToInstant } from "@/lib/time";
import { createLectureForTeacher } from "@/services/lecture-service";

export const ATTENDANCE_LECTURE_EXISTS = "ATTENDANCE_LECTURE_EXISTS";

/** The project's interactive-transaction settings (as lib/attendance/locks.ts, session start, payments). */
export const ATTENDANCE_LECTURE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/**
 * The longest wait for the (class, day) lock: a double click waits for the
 * first request to commit (then sees its lecture: 409 ATTENDANCE_LECTURE_EXISTS);
 * beyond this, 409 ATTENDANCE_BUSY. Leaves the waiter's own statements room
 * within the 15 s transaction timeout.
 */
export const ATTENDANCE_LECTURE_LOCK_TIMEOUT_MS = 8_000;

export type ExistingLectureSummary = { id: string; title: string; date: string; endDate: string | null };

/** The advisory-lock key of one class on one Sri Lankan day. */
export const attendanceLectureLockKey = (classId: string, day: string) => `attendance-lecture:${classId}:${day}`;

/** [first instant, first instant of the next day) of the Sri Lankan day "YYYY-MM-DD". */
function colomboDayRange(day: string): { start: Date; end: Date } {
  const start = sriLankaDigitsToInstant(new Date(`${day}T00:00:00.000Z`));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

const intervalOf = (lecture: { date: Date; endDate: Date | null }) => ({
  from: lecture.date.getTime(),
  to: (lecture.endDate ?? lecture.date).getTime(),
});

/** Whether two lectures' times overlap (closed intervals: touching ends count, the same start always does). */
export function lectureTimesOverlap(a: { date: Date; endDate: Date | null }, b: { date: Date; endDate: Date | null }): boolean {
  const x = intervalOf(a);
  const y = intervalOf(b);
  return x.from <= y.to && y.from <= x.to;
}

export async function createAttendanceLectureForTeacher(
  teacherId: string,
  input: CreateLectureInput & { allowAdditionalSession: boolean }
) {
  const { allowAdditionalSession, ...lectureInput } = input;
  const day = sriLankaDateKey(lectureInput.date);
  const range = colomboDayRange(day);

  const lockKey = attendanceLectureLockKey(lectureInput.classId, day);

  let lecture: Awaited<ReturnType<typeof createLectureForTeacher>>;
  try {
    lecture = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // One statement, one round trip: the transaction-local lock_timeout
      // (set_config(..., true) = SET LOCAL) is set in the OFFSET 0 subquery,
      // which PostgreSQL evaluates before the outer target list (OFFSET 0 keeps
      // it from being flattened), so it bounds this very lock wait.
      // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot read.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) FROM (SELECT set_config('lock_timeout', '8000ms', true) OFFSET 0) AS bounded`;

      // Only this teacher's live class (another teacher's class finds nothing,
      // and createLectureForTeacher then answers 404 without revealing it).
      const sameDay = await tx.lecture.findMany({
        where: {
          classId: lectureInput.classId,
          status: 0,
          ...NORMAL_LECTURE_WHERE,
          classStatus: { not: "CANCELLED" },
          class: { teacherId, status: 0 },
          date: { gte: range.start, lt: range.end },
        },
        orderBy: [{ date: "asc" }, { id: "asc" }],
        select: { id: true, title: true, date: true, endDate: true },
      });

      const candidate = { date: lectureInput.date, endDate: lectureInput.endDate ?? null };
      const overlapping = sameDay.filter((existing) => lectureTimesOverlap(existing, candidate));

      if (overlapping.length > 0 && !allowAdditionalSession) {
        throw new AppError(
          "A lecture of this class already exists at this time on this day. Use it, or confirm an additional session.",
          409,
          ATTENDANCE_LECTURE_EXISTS,
          {
            lectures: overlapping.map(
              (existing): ExistingLectureSummary => ({
                id: existing.id,
                title: existing.title,
                date: existing.date.toISOString(),
                endDate: existing.endDate ? existing.endDate.toISOString() : null,
              })
            ),
          }
        );
      }

      return createLectureForTeacher(teacherId, lectureInput, { db: tx });
    }, ATTENDANCE_LECTURE_TRANSACTION_OPTIONS);
  } catch (error) {
    // A lock wait beyond the lock_timeout (or a deadlock): 409 ATTENDANCE_BUSY, safe to retry.
    throw mapAttendanceLockError(error);
  }

  emitStudentDataChange({ classId: lectureInput.classId });
  return lecture;
}
