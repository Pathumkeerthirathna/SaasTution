/*
 * Compile-time check of the breakout lock order (lib/breakout-activities/
 * locks.ts): the submission (advisory) lock needs the ActiveSessionLock that
 * requireActiveSessionShared() returns. Never executed: the project's
 * `tsc --noEmit` and tests/breakout-activities/locks.test.cjs type-check it,
 * and each @ts-expect-error fails the check if that line ever compiles.
 */

import type { Prisma } from "@prisma/client";

import {
  lockSessionExclusive,
  lockSessionShared,
  lockSubmissionSlot,
  requireActiveSessionShared,
  type ActiveSessionLock,
  type LockedSession,
} from "@/lib/breakout-activities/locks";

export async function correctOrder(tx: Prisma.TransactionClient) {
  const session = await requireActiveSessionShared(tx, "session-id");
  await lockSubmissionSlot(tx, session, "assignment-id", "student-id");
}

export async function wrongOrder(tx: Prisma.TransactionClient) {
  // @ts-expect-error no session lock at all (the old signature)
  await lockSubmissionSlot(tx, "assignment-id", "student-id");

  const shared = await lockSessionShared(tx, "session-id");
  // @ts-expect-error a plain shared lock may be null or an ended session
  await lockSubmissionSlot(tx, shared, "assignment-id", "student-id");

  const exclusive = await lockSessionExclusive(tx, "session-id");
  // @ts-expect-error the exclusive (session end) lock is not a breakout-write lock
  await lockSubmissionSlot(tx, exclusive!, "assignment-id", "student-id");

  const handMade: LockedSession = { id: "session-id", classId: "class-id", isActive: true };
  // @ts-expect-error a hand-built object is not a lock
  await lockSubmissionSlot(tx, handMade, "assignment-id", "student-id");

  // @ts-expect-error a lock cannot be forged by spreading fields
  const forged: ActiveSessionLock = { ...handMade };
  void forged;
}
