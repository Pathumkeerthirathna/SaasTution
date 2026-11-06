// Breakout Group Activities: confirmed group membership (teacher only).
//
// The teacher keeps creating and managing breakout rooms with the existing
// Breakout Rooms feature; nothing here changes those rooms or moves anyone.
// The Group Activities panel shows the existing rooms and the class students
// the teacher's page sees in them, the teacher reviews that list and
// confirms it; this service stores the confirmation. Membership is used for
// Group Activities authorization only, and does not follow live Jitsi state
// afterwards: when students move, the panel shows the difference and the
// teacher confirms again.
//
// Rules (planMembershipUpdate, rules.mjs): every listed room ends with
// exactly the confirmed students; a student is in at most one room per
// session (moving removes the old membership first; the partial unique index
// "BreakoutRoomMember_one_active_key" is the database backstop); rooms not
// listed are unchanged. Removed rows stay (status 1) as history.
//
// Lock order: session FOR KEY SHARE (the teacher's own active session),
// then the session's membership lock EXCLUSIVE (lib/breakout-activities/
// groups/locks.ts): student group writes (membership SHARED) wait for it.

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import { emitGroupChange } from "@/lib/breakout-activities/groups/events";
import { groupError } from "@/lib/breakout-activities/groups/errors";
import { lockGroupMembers } from "@/lib/breakout-activities/groups/locks";
import { planMembershipUpdate } from "@/lib/breakout-activities/groups/rules.mjs";
import type { ConfirmedRoom } from "@/lib/breakout-activities/groups/validation";

import { inBreakoutTransaction, lockOwnedActiveSession } from "./breakout-assignment-service";

export type ConfirmGroupMembersInput = { teacherId: string; sessionId: string; rooms: ConfirmedRoom[] };

/**
 * Confirms the members of the listed rooms (one transaction). Every student
 * must be active (status 0) and actively enrolled in the session's class:
 * otherwise 400 STUDENT_NOT_IN_CLASS and nothing changes. Returns the
 * confirmed members per listed room.
 */
export async function confirmGroupMembers(input: ConfirmGroupMembersInput) {
  const rooms = input.rooms;
  const studentIds = [...new Set(rooms.flatMap((room) => room.studentIds))];
  if (studentIds.length !== rooms.reduce((n, room) => n + room.studentIds.length, 0)) throw groupError("STUDENT_IN_TWO_ROOMS");
  await serverNow();

  const result = await inBreakoutTransaction(async (tx) => {
    const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
    await lockGroupMembers(tx, session, "exclusive");

    if (studentIds.length > 0) {
      const enrolled = await tx.student.findMany({
        where: { id: { in: studentIds }, status: 0, classes: { some: { classId: session.classId, isActive: true } } },
        select: { id: true },
      });
      if (enrolled.length !== studentIds.length) throw groupError("STUDENT_NOT_IN_CLASS");
    }

    const active = await tx.breakoutRoomMember.findMany({
      where: { classSessionId: session.id, status: 0 },
      select: { id: true, roomId: true, roomName: true, studentId: true },
    });
    const plan = planMembershipUpdate(active, rooms);
    const now = serverNowSync();

    // Removals first: the partial unique index allows one ACTIVE row per student.
    for (const id of plan.remove) {
      await tx.breakoutRoomMember.update({ where: { id }, data: { status: 1, removedAt: now, updatedAt: now } });
    }
    for (const row of plan.rename) {
      await tx.breakoutRoomMember.update({ where: { id: row.id }, data: { roomName: row.roomName, updatedAt: now } });
    }
    for (const row of plan.add) {
      await tx.breakoutRoomMember.create({
        data: {
          id: randomUUID(),
          classSessionId: session.id,
          roomId: row.roomId,
          roomName: row.roomName,
          studentId: row.studentId,
          confirmedByTeacherId: input.teacherId,
          confirmedAt: now,
          status: 0,
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    const removedStudentIds = active.filter((row) => plan.remove.includes(row.id)).map((row) => row.studentId);
    return { sessionId: session.id, affected: [...new Set([...plan.affectedStudentIds, ...removedStudentIds])].sort() };
  });

  for (const room of rooms) {
    emitGroupChange({ sessionId: result.sessionId, kind: "members", activityId: null, roomId: room.id, revision: 0, memberStudentIds: result.affected });
  }

  return {
    rooms: rooms.map((room) => ({ id: room.id, name: room.name, studentIds: [...room.studentIds].sort() })),
  };
}

/** The active confirmed memberships of a session, by room (teacher reads; ownership checked by the caller). */
export async function activeMembershipsOfSession(sessionId: string) {
  return prisma.breakoutRoomMember.findMany({
    where: { classSessionId: sessionId, status: 0 },
    orderBy: [{ roomName: "asc" }, { roomId: "asc" }, { confirmedAt: "asc" }],
    select: { roomId: true, roomName: true, studentId: true, confirmedAt: true },
  });
}
