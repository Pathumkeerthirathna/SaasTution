/**
 * Attendance configuration: two independent per-environment settings.
 * See docs/lecture-attendance.md ("Configuration").
 *
 *  - APPROVAL_FEATURE_STARTED_AT: when approval enforcement started. Needed by
 *    everything that evaluates approval history (automatic evidence,
 *    reconciliation, finalization, backfill, the roster's eligibility).
 *  - ATTENDANCE_EVIDENCE_STARTED_AT: when automatic attendance evidence went
 *    live. Lectures starting at or after it are LIVE (automatic evidence and
 *    reconciliation); earlier ones are HISTORICAL (operator backfill only).
 *
 * Both use the same strict format: an ISO 8601 instant with an explicit "Z"
 * or "±HH:MM" offset (approvalHistoryContextFromSetting, the existing parser,
 * is the single implementation of that format). Each setting is OK, MISSING
 * (unset or blank) or INVALID. There are no defaults and no fallbacks: an
 * unavailable setting disables what depends on it (fail closed).
 *
 * Setting VALUES are never included in errors, logs or responses: only the
 * setting's name and its status.
 */

import { attendanceError } from "@/lib/attendance/service-errors";
import {
  APPROVAL_FEATURE_STARTED_AT_SETTING,
  approvalHistoryContextFromSetting,
  type ApprovalHistoryContext,
} from "@/lib/student-confirmation-history";

export const ATTENDANCE_EVIDENCE_STARTED_AT_SETTING = "ATTENDANCE_EVIDENCE_STARTED_AT";

export type SettingStatus = "OK" | "MISSING" | "INVALID";

type Env = Record<string, string | undefined>;

export type ApprovalConfig =
  | { status: "OK"; context: ApprovalHistoryContext }
  | { status: "MISSING" | "INVALID"; context: null };

export type EvidenceConfig =
  | { status: "OK"; evidenceStartedAt: Date }
  | { status: "MISSING" | "INVALID"; evidenceStartedAt: null };

export type AttendanceConfigurationStatus = {
  approval: SettingStatus;
  evidence: SettingStatus;
};

export type LectureClassification = "LIVE" | "HISTORICAL";

/** OK with the instant, MISSING or INVALID. Never throws; never returns the raw value. */
function parseInstantSetting(raw: string | undefined): { status: SettingStatus; instant: Date | null } {
  if (typeof raw !== "string" || raw.trim() === "") return { status: "MISSING", instant: null };

  try {
    return { status: "OK", instant: approvalHistoryContextFromSetting(raw).approvalFeatureStartedAt };
  } catch {
    // The parser's message is about the approval setting; it is not used.
    return { status: "INVALID", instant: null };
  }
}

/**
 * The same strict ISO 8601 instant format as the settings (explicit Z or
 * ±HH:MM offset), for operator input (the backfill's --before). Null when
 * missing or invalid; never throws.
 */
export function parseAttendanceInstant(raw: string | undefined): Date | null {
  return parseInstantSetting(raw).instant;
}

/** APPROVAL_FEATURE_STARTED_AT, read now (a restart or env change is picked up on the next call). */
export function loadApprovalConfig(env: Env = process.env): ApprovalConfig {
  const { status, instant } = parseInstantSetting(env[APPROVAL_FEATURE_STARTED_AT_SETTING]);
  return status === "OK" && instant
    ? { status: "OK", context: { approvalFeatureStartedAt: instant } }
    : { status: status === "OK" ? "INVALID" : status, context: null };
}

/** ATTENDANCE_EVIDENCE_STARTED_AT, read now. */
export function loadEvidenceConfig(env: Env = process.env): EvidenceConfig {
  const { status, instant } = parseInstantSetting(env[ATTENDANCE_EVIDENCE_STARTED_AT_SETTING]);
  return status === "OK" && instant
    ? { status: "OK", evidenceStartedAt: instant }
    : { status: status === "OK" ? "INVALID" : status, evidenceStartedAt: null };
}

/** Status of both settings (no values), for responses and diagnostics. */
export function attendanceConfigurationStatus(env: Env = process.env): AttendanceConfigurationStatus {
  return { approval: loadApprovalConfig(env).status, evidence: loadEvidenceConfig(env).status };
}

/** The approval context, or 503 ATTENDANCE_APPROVAL_NOT_CONFIGURED. */
export function requireApprovalContext(env: Env = process.env): ApprovalHistoryContext {
  const config = loadApprovalConfig(env);
  if (config.status !== "OK") {
    warnConfigurationOnce(APPROVAL_FEATURE_STARTED_AT_SETTING, config.status);
    throw attendanceError("ATTENDANCE_APPROVAL_NOT_CONFIGURED", { setting: APPROVAL_FEATURE_STARTED_AT_SETTING, status: config.status });
  }
  return config.context;
}

/** The evidence start instant, or 503 ATTENDANCE_EVIDENCE_NOT_CONFIGURED. */
export function requireEvidenceStartedAt(env: Env = process.env): Date {
  const config = loadEvidenceConfig(env);
  if (config.status !== "OK") {
    warnConfigurationOnce(ATTENDANCE_EVIDENCE_STARTED_AT_SETTING, config.status);
    throw attendanceError("ATTENDANCE_EVIDENCE_NOT_CONFIGURED", { setting: ATTENDANCE_EVIDENCE_STARTED_AT_SETTING, status: config.status });
  }
  return config.evidenceStartedAt;
}

/**
 * LIVE when the lecture's start (the register's scheduledStartAt, or
 * Lecture.date before a register exists) is at or after the evidence start;
 * HISTORICAL before it.
 */
export function classifyLecture(scheduledStartAt: Date, evidenceStartedAt: Date): LectureClassification {
  if (Number.isNaN(scheduledStartAt.getTime()) || Number.isNaN(evidenceStartedAt.getTime())) {
    throw new RangeError("Attendance: classification needs valid instants.");
  }
  return scheduledStartAt.getTime() >= evidenceStartedAt.getTime() ? "LIVE" : "HISTORICAL";
}

// ---- Logging: name and status only, once per process per (setting, status) --------

const warned = globalThis as unknown as { slAttendanceConfigWarned?: Set<string> };

/** One console warning per process for an unavailable setting: its name and status, never its value. */
export function warnConfigurationOnce(setting: string, status: SettingStatus, log: (line: string) => void = console.warn) {
  if (status === "OK") return;
  const seen = (warned.slAttendanceConfigWarned ??= new Set());
  const key = `${setting}:${status}`;
  if (seen.has(key)) return;
  seen.add(key);
  log(`[attendance] ${setting} is ${status === "MISSING" ? "not set" : "invalid"}; features that need it are disabled.`);
}

/** Tests: forget which warnings were printed. */
export function resetConfigurationWarnings() {
  delete warned.slAttendanceConfigWarned;
}
