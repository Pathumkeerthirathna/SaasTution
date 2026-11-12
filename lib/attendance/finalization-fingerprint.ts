/**
 * Attendance finalization fingerprint (Stage 5.5a). Pure: no database, no
 * clock, no environment. See docs/lecture-attendance.md ("Finalization
 * preview and fingerprint").
 *
 * The preview shows the teacher what finalization would do; the
 * confirmation (Stage 5.5b) recomputes the fingerprint inside its
 * transaction, under its locks, from the same kind of inputs and refuses
 * (409 FINALIZATION_PREVIEW_STALE) when it differs. So the fingerprint
 * covers every decision-relevant input (D4):
 *  - the lecture: id, status, classStatus, date, endDate;
 *  - the register: exists, version, scheduled start / end, grace, finalizedAt;
 *  - every record: studentId, id, version, status, statusSource (versions
 *    change with every teacher decision, review answer and evidence update);
 *  - every candidate: studentId, absence decision, eligibility outcome and
 *    reason (and the approval reason) at the scheduled start;
 *  - the online-evidence check: pending and unknown-approval students with
 *    their earliest visit times (evidenceRepresentation);
 *  - the classification, the readiness (result and basis / reason) and
 *    whether a session is active.
 * Not included: names or any personal data, review timestamps (a review
 * changes the record version anyway; D1), QR closure (D7), session ids,
 * configuration values, secrets.
 *
 * Canonical form: an explicit serializer (never JSON.stringify of an object
 * whose key order depends on insertion): object keys sorted by code unit,
 * Dates as UTC ISO strings, arrays in the order given after the helper has
 * sorted every list by studentId (then record id). undefined, non-finite
 * numbers, functions and other objects are refused. A domain / version tag
 * is hashed first. Output: lowercase hex SHA-256 (64 characters).
 */

import { createHash } from "node:crypto";

import type { LectureClassification } from "@/lib/attendance/config";
import type { AbsenceDecision, FinalizationReadiness, LectureClassStatus } from "@/lib/attendance/finalization";

export const FINALIZATION_FINGERPRINT_VERSION = 1;
const DOMAIN = "slclassroom/attendance-finalization-fingerprint/v1";

export type FinalizationFingerprintInput = {
  lecture: { id: string; status: number; classStatus: LectureClassStatus; date: Date; endDate: Date | null };
  register: {
    exists: boolean;
    /** 0 when the register does not exist yet. */
    version: number;
    scheduledStartAt: Date;
    scheduledEndAt: Date | null;
    graceMinutes: number;
    finalizedAt: Date | null;
  };
  records: { studentId: string; id: string; version: number; status: string; statusSource: string }[];
  candidates: {
    studentId: string;
    /** Null once the register is finalized (no absence decision any more). */
    decision: AbsenceDecision | null;
    eligibilityOutcome: string;
    eligibilityReason: string;
    approvalReason: string | null;
  }[];
  evidence: {
    pending: { studentId: string; earliestEligibleVisitAt: Date }[];
    unknown: { studentId: string; earliestUnknownVisitAt: Date }[];
  };
  classification: LectureClassification;
  readiness: FinalizationReadiness;
  activeSession: boolean;
};

type Canonical = null | boolean | number | string | Date | readonly Canonical[] | { readonly [key: string]: Canonical };

/** Deterministic serialization (see the module header). Throws for anything it cannot represent exactly. */
export function canonicalJson(value: Canonical): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Fingerprint: non-finite number.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("Fingerprint: invalid date.");
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const item = (value as Record<string, Canonical | undefined>)[key];
        if (item === undefined) throw new TypeError(`Fingerprint: "${key}" is undefined (use null).`);
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Fingerprint: unsupported value.");
}

const byStudent = <T extends { studentId: string }>(rows: readonly T[], what: string): T[] => {
  const sorted = [...rows].sort((a, b) => (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].studentId === sorted[i - 1].studentId) throw new Error(`Fingerprint: a student appears twice in ${what}.`);
  }
  return sorted;
};

/** The canonical document that is hashed (exported for tests and diagnostics; it contains ids, never names). */
export function finalizationFingerprintDocument(input: FinalizationFingerprintInput): string {
  const readiness: Canonical = input.readiness.allowed
    ? { allowed: true, basis: input.readiness.basis }
    : { allowed: false, reason: input.readiness.reason };

  return canonicalJson({
    version: FINALIZATION_FINGERPRINT_VERSION,
    lecture: {
      id: input.lecture.id,
      status: input.lecture.status,
      classStatus: input.lecture.classStatus,
      date: input.lecture.date,
      endDate: input.lecture.endDate,
    },
    register: {
      exists: input.register.exists,
      version: input.register.version,
      scheduledStartAt: input.register.scheduledStartAt,
      scheduledEndAt: input.register.scheduledEndAt,
      graceMinutes: input.register.graceMinutes,
      finalizedAt: input.register.finalizedAt,
    },
    records: byStudent(input.records, "the records").map((r) => ({
      studentId: r.studentId,
      id: r.id,
      version: r.version,
      status: r.status,
      statusSource: r.statusSource,
    })),
    candidates: byStudent(input.candidates, "the candidates").map((c) => ({
      studentId: c.studentId,
      decision: c.decision,
      eligibilityOutcome: c.eligibilityOutcome,
      eligibilityReason: c.eligibilityReason,
      approvalReason: c.approvalReason,
    })),
    evidence: {
      pending: byStudent(input.evidence.pending, "the pending evidence").map((p) => ({
        studentId: p.studentId,
        earliestEligibleVisitAt: p.earliestEligibleVisitAt,
      })),
      unknown: byStudent(input.evidence.unknown, "the unknown evidence").map((u) => ({
        studentId: u.studentId,
        earliestUnknownVisitAt: u.earliestUnknownVisitAt,
      })),
    },
    classification: input.classification,
    readiness,
    activeSession: input.activeSession,
  });
}

/** SHA-256 (lowercase hex) of the domain tag and the canonical document. */
export function computeFinalizationFingerprint(input: FinalizationFingerprintInput): string {
  return createHash("sha256").update(DOMAIN).update("\n").update(finalizationFingerprintDocument(input)).digest("hex");
}
