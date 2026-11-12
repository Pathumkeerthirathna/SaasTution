/**
 * Unified lecture attendance, Stage 5.7b-3b: the QR attendance state shown
 * with the register (GET /api/lectures/[id]/attendance `qr`). Read only.
 *
 * `closed` / `closedAt` come only from the persisted, immutable closure row
 * (LectureQrAttendanceClosure). `opensAt` is the register's start (its
 * frozen start once finalized; otherwise the lecture's, as ensureRegister
 * would copy) minus 30 minutes (qrScanOpensAt, the scan service's own rule).
 *
 * `window` answers "would a scan be accepted now?" with the scan service's
 * own conditions, so the UI never offers scanning the server would refuse:
 *  - CLOSED: the teacher closed QR attendance; or the lecture is cancelled;
 *    or it is HISTORICAL (409 ATTENDANCE_LECTURE_HISTORICAL); or a setting
 *    the scan needs is unavailable (APPROVAL_FEATURE_STARTED_AT,
 *    ATTENDANCE_EVIDENCE_STARTED_AT or STUDENT_QR_SECRET: the scan answers
 *    503). `closed` stays false unless a closure row exists;
 *  - NOT_OPEN: before opensAt (qrScanWindowState);
 *  - OPEN: otherwise (a finalized register included: scans are still
 *    recorded there, as evidence or a review, never as a new record).
 */

import { qrScanOpensAt, qrScanWindowState } from "@/lib/attendance/evidence";
import { prisma } from "@/lib/prisma";
import { loadStudentQrSecret } from "@/lib/student-qr-token";
import type {
  AttendanceRegisterQrState as RegisterQrState,
  AttendanceRegisterQrWindow as RegisterQrWindow,
} from "@/lib/attendance-register-response";
import type { RegisterView } from "@/services/lecture-attendance-service";

type Env = Record<string, string | undefined>;

export type { RegisterQrState, RegisterQrWindow };

export type RegisterQrStateInput = {
  scheduledStartAt: Date;
  classStatus: string;
  classification: "LIVE" | "HISTORICAL" | null;
  approvalConfigured: boolean;
  qrSecretConfigured: boolean;
  closedAt: Date | null;
  now: Date;
};

/** Pure: the state from the register's data, the closure and the configuration (see the header). */
export function registerQrState(input: RegisterQrStateInput): RegisterQrState {
  const closed = input.closedAt !== null;
  const opensAt = qrScanOpensAt(input.scheduledStartAt).toISOString();
  const available =
    !closed &&
    input.classStatus !== "CANCELLED" &&
    input.classification === "LIVE" &&
    input.approvalConfigured &&
    input.qrSecretConfigured;
  const window: RegisterQrWindow = available
    ? qrScanWindowState({ scheduledStartAt: input.scheduledStartAt, closed: false, receivedAt: input.now }) === "NOT_OPEN"
      ? "NOT_OPEN"
      : "OPEN"
    : "CLOSED";
  return { closed, closedAt: closed ? (input.closedAt as Date).toISOString() : null, opensAt, window };
}

/** Whether STUDENT_QR_SECRET is usable (the scan's own check); never returns or logs the value. */
export function studentQrSecretConfigured(env: Env = process.env): boolean {
  try {
    loadStudentQrSecret(env as NodeJS.ProcessEnv);
    return true;
  } catch {
    return false;
  }
}

/**
 * The QR state of a register the caller has ALREADY authorized (getRegister
 * checked the lecture's ownership): one plain read of the closure row (no
 * transaction, no lock, never a write; the row is immutable once it exists).
 */
export async function getRegisterQrState(view: RegisterView, options: { env?: Env; now?: Date } = {}): Promise<RegisterQrState> {
  const closure = await prisma.lectureQrAttendanceClosure.findUnique({
    where: { lectureId: view.lecture.id },
    select: { closedAt: true },
  });
  return registerQrState({
    scheduledStartAt: view.register.scheduledStartAt,
    classStatus: view.lecture.classStatus,
    classification: view.classification,
    approvalConfigured: view.configuration.approval === "OK",
    qrSecretConfigured: studentQrSecretConfigured(options.env ?? process.env),
    closedAt: closure ? closure.closedAt : null,
    now: options.now ?? new Date(),
  });
}
