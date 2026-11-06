// Group Activities access: who may see and change a group's shared work.
//
// A student may use a group activity only while ALL of these hold:
//   - the session is active and the student is actively enrolled in its
//     class (the existing student-access.ts checks, D2: 404 otherwise);
//   - the student has an ACTIVE confirmed membership (BreakoutRoomMember,
//     status 0) in this session: the teacher confirmed them for a room;
//   - the activity is a GROUP activity of this session that targets THAT
//     room (checked by the services).
// Membership is the only source of the room: never a room id or student id
// from the request, never live Jitsi state. A student who is removed (or
// moved to another room) loses access to the old room's work at once.
// Every failure is the same 404 NOT_FOUND / *_NOT_FOUND as elsewhere.

import type { Prisma } from "@prisma/client";

import { breakoutError } from "../errors";
import type { ActiveSessionLock } from "../locks";
import { lockEnrolledActiveSession, requireEnrolledStudentSessionAccess } from "../student-access";

import { lockGroupMembers } from "./locks";

type Tx = Prisma.TransactionClient;
type Db = Pick<Tx, "classSession" | "student" | "breakoutRoomMember">;

export type GroupMembership = { id: string; roomId: string; roomName: string };

export type StudentGroupAccess = { sessionId: string; classId: string; membership: GroupMembership };

const MEMBERSHIP_SELECT = { id: true, roomId: true, roomName: true } as const;

async function activeMembership(db: Pick<Tx, "breakoutRoomMember">, sessionId: string, studentId: string): Promise<GroupMembership | null> {
  return db.breakoutRoomMember.findFirst({
    where: { classSessionId: sessionId, studentId, status: 0 },
    orderBy: [{ confirmedAt: "desc" }, { id: "asc" }],
    select: MEMBERSHIP_SELECT,
  });
}

/** Reads: the student's live session, enrolment and ACTIVE membership (404 NOT_FOUND otherwise). */
export async function requireStudentGroup(db: Db, studentId: string, sessionId: string): Promise<StudentGroupAccess> {
  const access = await requireEnrolledStudentSessionAccess(db, studentId, sessionId);
  const membership = await activeMembership(db, access.sessionId, studentId);
  if (!membership) throw breakoutError("NOT_FOUND");
  return { sessionId: access.sessionId, classId: access.classId, membership };
}

/** Reads: the active membership, or null (the "my group" overview of a student not in a group). */
export async function findStudentGroup(db: Db, studentId: string, sessionId: string): Promise<{ sessionId: string; membership: GroupMembership | null }> {
  const access = await requireEnrolledStudentSessionAccess(db, studentId, sessionId);
  return { sessionId: access.sessionId, membership: await activeMembership(db, access.sessionId, studentId) };
}

/**
 * Writes, lock-order levels 1 and 1b: the session FOR KEY SHARE (enrolment
 * re-checked on the locked row), then the membership lock SHARED, then the
 * student's active membership, read under that lock.
 */
export async function lockStudentGroup(tx: Tx, studentId: string, sessionId: string): Promise<{ session: ActiveSessionLock; membership: GroupMembership }> {
  const session = await lockEnrolledActiveSession(tx, studentId, sessionId);
  await lockGroupMembers(tx, session, "shared");
  const membership = await activeMembership(tx, session.id, studentId);
  if (!membership) throw breakoutError("NOT_FOUND");
  return { session, membership };
}

/** Active members of one room: student ids, sorted. */
export async function activeMemberIds(db: Pick<Tx, "breakoutRoomMember">, sessionId: string, roomId: string): Promise<string[]> {
  const rows = await db.breakoutRoomMember.findMany({ where: { classSessionId: sessionId, roomId, status: 0 }, select: { studentId: true } });
  return [...new Set(rows.map((row) => row.studentId))].sort();
}

/** studentId -> { id, name } (names of the given students; unknown ids get a placeholder). */
export async function studentNames(db: Pick<Tx, "student">, ids: readonly (string | null | undefined)[]): Promise<Map<string, { id: string; name: string }>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))];
  const out = new Map<string, { id: string; name: string }>();
  if (unique.length === 0) return out;
  const rows = await db.student.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  for (const row of rows) out.set(row.id, { id: row.id, name: row.name });
  for (const id of unique) if (!out.has(id)) out.set(id, { id, name: "Unknown student" });
  return out;
}
