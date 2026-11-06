// Group Activities error codes, in the same AppError shape as the breakout
// error table (lib/breakout-activities/errors.ts: status, code, message),
// kept here so the existing table and its tests stay unchanged. Every other
// failure reuses the existing breakout codes (404 NOT_FOUND for anyone who is
// not an active confirmed member, ASSIGNMENT_CLOSED, QUIZ_*, REVISION_CONFLICT,
// SUBMISSION_EMPTY, INVALID_PDF, ...).

import { AppError } from "@/lib/error-handler";

export const GROUP_ERRORS = {
  GROUP_WORK_SUBMITTED: { status: 409, message: "Your group has already submitted this work." },
  STUDENT_NOT_IN_CLASS: { status: 400, message: "Only students enrolled in this class can be group members." },
  STUDENT_IN_TWO_ROOMS: { status: 400, message: "A student can be in only one group." },
  // End Session (services/breakout-group-session-end.ts): this session has GROUP activities,
  // so the teacher must choose to keep or delete them. Nothing was changed.
  GROUP_ACTIVITIES_DECISION_REQUIRED: { status: 409, message: "This session has group activities. Choose whether to keep or delete them before ending the session." },
} as const;

export type GroupErrorCode = keyof typeof GROUP_ERRORS;

export function groupError(code: GroupErrorCode, message?: string, details?: unknown): AppError {
  const spec = GROUP_ERRORS[code];
  return new AppError(message ?? spec.message, spec.status, code, details);
}
