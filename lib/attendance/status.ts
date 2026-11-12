/**
 * Attendance statuses and lateness. Pure: no database, no clock.
 * See docs/lecture-attendance.md.
 *
 * Evidence (an online join or a QR scan) is PRESENT when its server-recorded
 * time is at or before the register's scheduled start plus the grace period,
 * and LATE after that. Evidence before the scheduled start is PRESENT.
 * Client-supplied times (e.g. AttendanceScanEvent.clientScannedAt) are never
 * used: callers pass the server-recorded time.
 */

export type AttendanceStatus = "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";

/** What evidence can produce. */
export type EvidenceStatus = "PRESENT" | "LATE";

export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = ["PRESENT", "LATE", "ABSENT", "EXCUSED"];

/** Class.attendanceGraceMinutes default, and the CHECK range 0–240 (both bounds included). */
export const DEFAULT_ATTENDANCE_GRACE_MINUTES = 10;
export const MIN_ATTENDANCE_GRACE_MINUTES = 0;
export const MAX_ATTENDANCE_GRACE_MINUTES = 240;

export type LatenessSchedule = {
  /** LectureAttendanceRegister.scheduledStartAt (real UTC instant). */
  scheduledStartAt: Date;
  /** LectureAttendanceRegister.graceMinutes. */
  graceMinutes: number;
};

const isValidDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

export function isValidGraceMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_ATTENDANCE_GRACE_MINUTES &&
    value <= MAX_ATTENDANCE_GRACE_MINUTES
  );
}

/**
 * The last instant that still counts as PRESENT: scheduled start plus grace
 * (inclusive). Throws for an invalid start or a grace outside 0–240 / not an
 * integer.
 */
export function presentUntil(schedule: LatenessSchedule): Date {
  if (!isValidDate(schedule.scheduledStartAt)) {
    throw new RangeError("Attendance: a valid scheduled start is required.");
  }

  if (!isValidGraceMinutes(schedule.graceMinutes)) {
    throw new RangeError(
      `Attendance: the grace period must be a whole number of minutes from ${MIN_ATTENDANCE_GRACE_MINUTES} to ${MAX_ATTENDANCE_GRACE_MINUTES}.`
    );
  }

  return new Date(schedule.scheduledStartAt.getTime() + schedule.graceMinutes * 60_000);
}

/**
 * PRESENT or LATE for evidence recorded by the server at `serverRecordedAt`.
 * Exactly at the boundary (start + grace) is PRESENT; one millisecond later is
 * LATE. Throws for an invalid time or schedule.
 */
export function evidenceStatusAt(serverRecordedAt: Date, schedule: LatenessSchedule): EvidenceStatus {
  const boundary = presentUntil(schedule);

  if (!isValidDate(serverRecordedAt)) {
    throw new RangeError("Attendance: a valid server-recorded evidence time is required.");
  }

  return serverRecordedAt.getTime() <= boundary.getTime() ? "PRESENT" : "LATE";
}

/** The earlier of two optional instants (null when both are null). */
export function earliest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * LectureAttendance.autoStatus: the status of the EARLIEST evidence of either
 * channel; null when there is no evidence.
 */
export function autoStatusFor(
  evidence: { firstOnlineAt: Date | null; firstQrAt: Date | null },
  schedule: LatenessSchedule
): EvidenceStatus | null {
  const first = earliest(evidence.firstOnlineAt, evidence.firstQrAt);
  return first === null ? null : evidenceStatusAt(first, schedule);
}

/**
 * How strongly a status says "attended", for the review rule: PRESENT (2) >
 * LATE (1) > ABSENT = EXCUSED (0).
 */
export function attendanceStrength(status: AttendanceStatus): number {
  return status === "PRESENT" ? 2 : status === "LATE" ? 1 : 0;
}
