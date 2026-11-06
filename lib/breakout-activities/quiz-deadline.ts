// Breakout quiz deadlines: the approved grace period and the one rule for the
// time recorded on an AUTOMATIC submission. Pure (callers pass the database
// clock's `now`). Used by the student quiz service (lazy auto-submit, a save
// or submit after the deadline) and the teacher's quiz close.
//
// deadlineAt = startedAt + timeLimitSeconds (null for an untimed quiz).
// Saves and submits are accepted while now <= deadlineAt + 5 s (inclusive,
// approved Q3); strictly after it the attempt has expired.
//
// What BreakoutQuizSubmission.submittedAt means:
//   - SUBMITTED: when the student submitted (the database clock at that
//     moment; always within the deadline + grace);
//   - AUTO_SUBMITTED: when the attempt ENDED: the earlier of the database
//     clock at the moment of the auto-submit and deadlineAt + 5 s. An attempt
//     found expired later (lazy read, a late save or submit, or the
//     teacher's close) is recorded as ending when its time ran out, not when
//     it was discovered. An attempt cut short by the teacher's close before
//     its time ran out, and any untimed attempt, ends at the close / now.
// updatedAt stays the database clock of the write itself (the explicit
// timestamp convention), so it can be later than submittedAt.

/** Approved grace after deadlineAt: saves and submits are accepted up to and including it. */
export const QUIZ_DEADLINE_GRACE_MS = 5_000;

/** Past deadlineAt + grace (strictly). An untimed attempt never expires. */
export function isPastGrace(deadlineAt: Date | null, now: Date): boolean {
  return deadlineAt !== null && now.getTime() > deadlineAt.getTime() + QUIZ_DEADLINE_GRACE_MS;
}

/** submittedAt of an AUTOMATIC submission: min(now, deadlineAt + grace); untimed: now. */
export function autoSubmittedAt(deadlineAt: Date | null, now: Date): Date {
  if (deadlineAt === null) return new Date(now.getTime());
  return new Date(Math.min(now.getTime(), deadlineAt.getTime() + QUIZ_DEADLINE_GRACE_MS));
}
