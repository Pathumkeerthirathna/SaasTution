// Group Activities locks. Advisory locks only (no new row-lock statements),
// taken INSIDE a breakout transaction (runBreakoutTransaction) and always
// AFTER the session lock of that same transaction (requireActiveSessionShared,
// which also sets the transaction's lock_timeout, so these waits are bounded
// by BREAKOUT_LOCK_TIMEOUT_MS too).
//
// Lock order (extends lib/breakout-activities/locks.ts; never go back up):
//   1. the ClassSession row FOR KEY SHARE (existing level 1);
//   1b. the session's group-membership lock:
//        - SHARED by every student group write (members can work at once),
//        - EXCLUSIVE by the teacher's membership update,
//       so a write never runs on membership that is being changed;
//   2. the activity row FOR KEY SHARE (existing lockActivityShared) by
//      student group writes: the teacher's publish / close (FOR UPDATE)
//      waits for them, later writes see the new state;
//   3. the group-activity lock (EXCLUSIVE): serializes the writes of one
//      group's shared work / attempt (save, submit, start, override).
// Existing paths never take 1b or 3, and nothing here takes a row lock after
// them, so no cycle with the existing lock order is possible.
//
// Key namespaces start with "breakout-group", apart from the existing
// "breakout-submission" keys (locks.ts SUBMISSION_LOCK_NAMESPACE).

import type { Prisma } from "@prisma/client";

import type { ActiveSessionLock } from "../locks";

type Tx = Prisma.TransactionClient;

export const GROUP_MEMBERS_LOCK_NAMESPACE = "breakout-group-members";
export const GROUP_ACTIVITY_LOCK_NAMESPACE = "breakout-group-activity";

function assertInTransaction(tx: Tx) {
  if (!tx || typeof tx !== "object" || "$transaction" in tx) {
    throw new Error("Breakout group locks must be taken inside an interactive transaction.");
  }
}

function requireSession(session: ActiveSessionLock) {
  if (!session || typeof session !== "object" || typeof session.id !== "string" || session.id === "") {
    throw new Error("Take the session lock (requireActiveSessionShared) before a group lock.");
  }
}

export function groupMembersLockKey(sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId === "") throw new TypeError("sessionId is required.");
  return `${GROUP_MEMBERS_LOCK_NAMESPACE}:${sessionId}`;
}

export function groupActivityLockKey(kind: "assignment" | "quiz", activityId: string): string {
  if ((kind !== "assignment" && kind !== "quiz") || typeof activityId !== "string" || activityId === "") {
    throw new TypeError("kind and activityId are required.");
  }
  return `${GROUP_ACTIVITY_LOCK_NAMESPACE}:${kind}:${activityId}`;
}

/** Level 1b: the session's membership lock, shared (student writes) or exclusive (teacher update). */
export async function lockGroupMembers(tx: Tx, session: ActiveSessionLock, mode: "shared" | "exclusive"): Promise<void> {
  assertInTransaction(tx);
  requireSession(session);
  const key = groupMembersLockKey(session.id);
  if (mode === "shared") {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
  } else if (mode === "exclusive") {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  } else {
    throw new TypeError("Unknown lock mode.");
  }
}

/** Level 3: one group's shared work / attempt of one activity (exclusive). */
export async function lockGroupActivity(tx: Tx, session: ActiveSessionLock, kind: "assignment" | "quiz", activityId: string): Promise<void> {
  assertInTransaction(tx);
  requireSession(session);
  const key = groupActivityLockKey(kind, activityId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
