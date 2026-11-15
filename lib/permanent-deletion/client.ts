/*
 * Stage 3.6: what the teacher sees around a PERMANENT deletion (Notes,
 * assignments, recordings). Pure: the confirmation texts and the reading of a
 * DELETE response. Used by the client panels; tested on its own.
 *
 * A DELETE answers:
 *   200 { deleted: true,  pending: false }  everything (row + files) is gone;
 *   202 { deleted: false, pending: true }   hidden everywhere, the files are
 *                                           still being deleted (retried
 *                                           automatically) - NOT a success;
 *   4xx / 5xx                               an error (nothing reported as deleted).
 */

export type DeletionOutcome =
  | { kind: "deleted"; message: string }
  | { kind: "pending"; message: string }
  | { kind: "error"; message: string };

type Payload = {
  success?: boolean;
  data?: { deleted?: unknown; pending?: unknown };
  message?: string;
  error?: { message?: string; code?: string };
};

export function noteDeletionConfirmText(title: string): string {
  return `Permanently delete note "${title}"?\n\nThe note and its file will be deleted permanently. Students will lose access immediately. This cannot be undone.`;
}

export function assignmentDeletionConfirmText(title: string): string {
  return (
    `Permanently delete assignment "${title}"?\n\n` +
    "The assignment, ALL student submissions and ALL submitted PDF files will be deleted permanently. " +
    "Students will no longer be able to submit. This cannot be undone."
  );
}

export const RECORDING_DELETION_WARNING =
  "The recording and its video file will be deleted permanently. Students will no longer see it. This cannot be undone.";

/** Reads a DELETE response: "deleted" only for 200 + deleted: true; 202 + pending: true is "pending"; anything else an error. */
export function readDeletionOutcome(status: number, payload: unknown, labels: { deleted: string; pending: string; failed: string }): DeletionOutcome {
  const body = (payload && typeof payload === "object" ? payload : {}) as Payload;
  if (status === 200 && body.success === true && body.data?.deleted === true) return { kind: "deleted", message: labels.deleted };
  if (status === 202 && body.success === true && body.data?.pending === true) return { kind: "pending", message: labels.pending };
  return { kind: "error", message: body.error?.message ?? (typeof body.message === "string" && body.success === false ? body.message : labels.failed) };
}

export const NOTE_DELETION_LABELS = {
  deleted: "Note deleted permanently.",
  pending: "The note was removed, but its file is still being deleted. This finishes automatically; nothing else is needed.",
  failed: "Failed to delete note.",
};

export const ASSIGNMENT_DELETION_LABELS = {
  deleted: "Assignment, all submissions and their files deleted permanently.",
  pending:
    "The assignment was removed and no longer accepts submissions, but its submissions and files are still being deleted. This finishes automatically; nothing else is needed.",
  failed: "Failed to delete assignment.",
};

export const RECORDING_DELETION_LABELS = {
  deleted: "deleted permanently. Students can no longer see it.",
  pending: "removed. Students can no longer see it; its video file is still being deleted and will be removed automatically.",
  failed: "The recording could not be deleted.",
};
