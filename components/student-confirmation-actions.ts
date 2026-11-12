/**
 * Which approval decisions the teacher's student list offers, and the texts of
 * their confirmation popovers (components/student-guardian-management-panel.tsx).
 * The server re-checks every decision (services/student-service.ts).
 */

export type StudentDecisionAction = "confirm" | "decline" | "decline-approved" | "reapprove";

export type PendingStudentAction = "delete" | "activate" | "decline-approved" | "reapprove";

/**
 * - deleted students (status 2): none;
 * - PENDING: Confirm and Decline (the mobile card has always offered Confirm only);
 * - APPROVED: Decline (after a confirmation popover);
 * - REJECTED: Confirm again (after a confirmation popover).
 * Inactive students (status 1) keep their actions.
 */
export function decisionActionsFor(
  student: { StudentConfirmationStatus: string; status: number },
  variant: "table" | "card"
): StudentDecisionAction[] {
  if (student.status === 2) return [];

  switch (student.StudentConfirmationStatus) {
    case "PENDING":
      return variant === "table" ? ["confirm", "decline"] : ["confirm"];
    case "APPROVED":
      return ["decline-approved"];
    case "REJECTED":
      return ["reapprove"];
    default:
      return [];
  }
}

/** Texts of the row action popovers (ConfirmActionPopover). */
export const PENDING_ACTION_TEXT: Record<
  PendingStudentAction,
  { message: string; confirmLabel: string; tone: "danger" | "positive" }
> = {
  delete: {
    message: "Are you sure you want to delete this student?",
    confirmLabel: "Delete",
    tone: "danger",
  },
  activate: {
    message: "Are you sure you want to activate this student?",
    confirmLabel: "Activate",
    tone: "positive",
  },
  "decline-approved": {
    message:
      "Decline this confirmed student? They will no longer be able to sign in again or join new live classes. Existing login sessions may remain active until they expire.",
    confirmLabel: "Decline",
    tone: "danger",
  },
  reapprove: {
    message: "Confirm this declined student again? They will be able to sign in and join classes.",
    confirmLabel: "Confirm again",
    tone: "positive",
  },
};

export const CONFIRM_ALL_PROMPT =
  "Confirm all pending active students? Inactive and deleted students are not included.";

/** An API error's message: { error: { message } } (current) or { message } (older routes). */
export function apiErrorMessage(result: unknown, fallback: string): string {
  const body = result as { error?: { message?: unknown }; message?: unknown } | null;
  const message = body?.error?.message ?? body?.message;

  return typeof message === "string" && message.trim() ? message : fallback;
}

/** The bulk approval toast, from the count the server actually approved. */
export function confirmAllSuccessMessage(result: unknown): string {
  const count = (result as { count?: unknown } | null)?.count;

  return `${typeof count === "number" ? count : 0} student(s) confirmed successfully.`;
}
