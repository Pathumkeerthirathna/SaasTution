/*
 * The teacher-facing contract of GET /api/lectures/[id]/attendance (D4):
 * an explicit mapping of the register view (services/lecture-attendance-
 * service.ts getRegister), never the internal RegisterView itself. See
 * docs/lecture-attendance.md ("Attendance API (Stage 5.5c)").
 *
 * Included: what the owning teacher's attendance screen needs (the
 * lecture, the register schedule and state, one row per student with name,
 * registration number, eligibility at the scheduled start, absence decision,
 * canonical record and review state, summary counts, the absence preview,
 * the online-evidence check, an active-session indicator and finalization
 * readiness, and the QR attendance state, Stage 5.7b-3b). Excluded: record ids, session ids and start times, the
 * finalizing teacher's id, created / updated timestamps, internal enrolment
 * details. Dates are UTC ISO strings.
 *
 * Configuration: the register view never fails for missing settings; the
 * fields that need them are null (eligibility, absenceDecision,
 * absencePreview, onlineEvidence, classification), and `configuration`
 * says which setting is MISSING or INVALID.
 */

import type { RegisterView } from "@/services/lecture-attendance-service";

type Status = "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";

/**
 * QR attendance (Stage 5.7b-3b; computed by services/lecture-attendance-qr-
 * state.ts). `closed` / `closedAt`: the persisted closure only. `window`:
 * whether a scan would be accepted now (CLOSED also for a cancelled or
 * HISTORICAL lecture and while a setting the scan needs is missing). No
 * teacher id.
 */
export type AttendanceRegisterQrWindow = "NOT_OPEN" | "OPEN" | "CLOSED";
export type AttendanceRegisterQrState = {
  closed: boolean;
  closedAt: string | null;
  opensAt: string;
  window: AttendanceRegisterQrWindow;
};
const iso = (value: Date | null) => (value ? value.toISOString() : null);

export type AttendanceRegisterStudent = {
  studentId: string;
  /** Null only for a record of a student who is not this teacher's (not expected). */
  name: string | null;
  registrationNumber: string | null;
  /** At the register's scheduled start; null without APPROVAL_FEATURE_STARTED_AT. */
  eligibility: { outcome: "ELIGIBLE" | "NOT_ELIGIBLE" | "UNKNOWN"; reason: string; approvalReason: string | null } | null;
  /** What finalization would do now; null when finalized or unconfigured. */
  absenceDecision: "CREATE_ABSENT" | "HAS_RECORD" | "NOT_ELIGIBLE" | "MANUAL_REVIEW" | null;
  record: {
    status: string;
    statusSource: string;
    /** Evidence status (PRESENT / LATE of the earliest evidence), or null. */
    autoStatus: string | null;
    teacherStatus: string | null;
    firstOnlineAt: string | null;
    firstQrAt: string | null;
    teacherDecidedAt: string | null;
    /** For the decision API's expectedVersion. */
    version: number;
  } | null;
  review: { pending: boolean; since: string | null };
};

export type AttendanceRegisterResponse = {
  lecture: { id: string; classId: string; title: string; classStatus: string; date: string; endDate: string | null };
  register: {
    lectureId: string;
    /** False: computed from the lecture and the class; nothing stored yet. */
    exists: boolean;
    scheduledStartAt: string;
    scheduledEndAt: string | null;
    graceMinutes: number;
    /** 0 while the register does not exist. */
    version: number;
    finalized: boolean;
    finalizedAt: string | null;
  };
  configuration: { approval: string; evidence: string };
  /** LIVE / HISTORICAL; null without ATTENDANCE_EVIDENCE_STARTED_AT. */
  classification: "LIVE" | "HISTORICAL" | null;
  students: AttendanceRegisterStudent[];
  summary: {
    students: number;
    withRecord: number;
    recordStatus: Record<Status, number>;
    pendingReviews: number;
  };
  /** Null when finalized or without APPROVAL_FEATURE_STARTED_AT. */
  absencePreview: {
    automaticAbsentStudentIds: string[];
    manualReviewStudentIds: string[];
    eligibleCount: number;
    unknownEligibilityCount: number;
    absentCreatedCount: number;
  } | null;
  /** The online-evidence check (reconciliation / finalization gate); null without either setting. */
  onlineEvidence: {
    complete: boolean;
    pending: { studentId: string; earliestEligibleVisitAt: string }[];
    unknownVisits: { studentId: string; earliestUnknownVisitAt: string }[];
  } | null;
  activeSessions: { active: boolean; count: number };
  finalization: {
    readiness: { allowed: true; basis: string } | { allowed: false; reason: string };
    configured: boolean;
  };
  qr: AttendanceRegisterQrState;
};

/** The explicit, field-by-field mapping (nothing is spread from the view). */
export function toAttendanceRegisterResponse(view: RegisterView, qr: AttendanceRegisterQrState): AttendanceRegisterResponse {
  const recordBy = new Map(view.records.map((r) => [r.studentId, r]));
  const rosterIds = new Set(view.roster.map((r) => r.studentId));

  const recordOf = (studentId: string): AttendanceRegisterStudent["record"] => {
    const r = recordBy.get(studentId);
    return r
      ? {
          status: r.status,
          statusSource: r.statusSource,
          autoStatus: r.autoStatus,
          teacherStatus: r.teacherStatus,
          firstOnlineAt: iso(r.firstOnlineAt),
          firstQrAt: iso(r.firstQrAt),
          teacherDecidedAt: iso(r.teacherDecidedAt),
          version: r.version,
        }
      : null;
  };
  const reviewOf = (studentId: string) => {
    const since = recordBy.get(studentId)?.pendingReviewSince ?? null;
    return { pending: since !== null, since: iso(since) };
  };

  const students: AttendanceRegisterStudent[] = [
    ...view.roster.map((entry) => ({
      studentId: entry.studentId,
      name: entry.name,
      registrationNumber: entry.registrationNumber,
      eligibility: entry.eligibility
        ? { outcome: entry.eligibility.outcome, reason: entry.eligibility.reason, approvalReason: entry.eligibility.approvalReason }
        : null,
      absenceDecision: entry.absenceDecision,
      record: recordOf(entry.studentId),
      review: reviewOf(entry.studentId),
    })),
    // A record of a student outside the roster (not this teacher's): shown, never named.
    ...view.records
      .filter((r) => !rosterIds.has(r.studentId))
      .map((r) => ({
        studentId: r.studentId,
        name: null,
        registrationNumber: null,
        eligibility: null,
        absenceDecision: null,
        record: recordOf(r.studentId),
        review: reviewOf(r.studentId),
      })),
  ];

  const recordStatus: Record<Status, number> = { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 };
  for (const r of view.records) if (r.status in recordStatus) recordStatus[r.status as Status] += 1;

  const readiness = view.finalization.readiness;
  return {
    lecture: {
      id: view.lecture.id,
      classId: view.lecture.classId,
      title: view.lecture.title,
      classStatus: view.lecture.classStatus,
      date: view.lecture.date.toISOString(),
      endDate: iso(view.lecture.endDate),
    },
    register: {
      lectureId: view.lecture.id,
      exists: view.register.exists,
      scheduledStartAt: view.register.scheduledStartAt.toISOString(),
      scheduledEndAt: iso(view.register.scheduledEndAt),
      graceMinutes: view.register.graceMinutes,
      version: view.register.version,
      finalized: view.register.finalizedAt !== null,
      finalizedAt: iso(view.register.finalizedAt),
    },
    configuration: { approval: view.configuration.approval, evidence: view.configuration.evidence },
    classification: view.classification,
    students,
    summary: {
      students: students.length,
      withRecord: view.records.length,
      recordStatus,
      pendingReviews: view.reviewQueue.length,
    },
    absencePreview: view.absencePreview
      ? {
          automaticAbsentStudentIds: [...view.absencePreview.absentStudentIds],
          manualReviewStudentIds: [...view.absencePreview.manualReviewStudentIds],
          eligibleCount: view.absencePreview.eligibleCount,
          unknownEligibilityCount: view.absencePreview.unknownEligibilityCount,
          absentCreatedCount: view.absencePreview.absentCreatedCount,
        }
      : null,
    onlineEvidence: view.onlineEvidence
      ? {
          complete: view.onlineEvidence.pending.length === 0 && view.onlineEvidence.unknownVisits.length === 0,
          pending: view.onlineEvidence.pending.map((p) => ({ studentId: p.studentId, earliestEligibleVisitAt: p.earliestEligibleVisitAt.toISOString() })),
          unknownVisits: view.onlineEvidence.unknownVisits.map((u) => ({ studentId: u.studentId, earliestUnknownVisitAt: u.earliestUnknownVisitAt.toISOString() })),
        }
      : null,
    activeSessions: { active: view.activeSessions.length > 0, count: view.activeSessions.length },
    finalization: {
      readiness: readiness.allowed ? { allowed: true, basis: readiness.basis } : { allowed: false, reason: readiness.reason },
      configured: view.finalization.configured,
    },
    qr: { closed: qr.closed, closedAt: qr.closedAt, opensAt: qr.opensAt, window: qr.window },
  };
}
