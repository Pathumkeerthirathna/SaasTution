// Teacher access to a class session's breakout activities.
//
// The teacher is the one in the signed login session (requireTeacherSession,
// the existing convention). A session belongs to the teacher who owns its
// class. A session that does not exist and one owned by another teacher
// answer the same 404 SESSION_NOT_FOUND, so a teacher cannot find out that
// another teacher's session exists (as ensureSessionAccessForTeacher does).
//
// Reads check ownership with requireTeacherSessionAccess(). Writes check it
// again INSIDE their transaction, after the session lock
// (assertTeacherOwnsLockedSession), so it is decided on the locked row.

import type { Prisma } from "@prisma/client";

import { breakoutError, type BreakoutErrorCode } from "./errors";
import type { ActiveSessionLock } from "./locks";

type Db = Pick<Prisma.TransactionClient, "classSession" | "class">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A route or query id (session, activity, submission, student). Ids are
 * UUIDs; anything else cannot exist, so it is 404 with `notFoundCode`,
 * before any query. Returned lower-cased, as Prisma stores them.
 */
export function requireRouteId(value: unknown, notFoundCode: BreakoutErrorCode = "NOT_FOUND"): string {
  if (typeof value !== "string" || !UUID.test(value)) throw breakoutError(notFoundCode);
  return value.toLowerCase();
}

export type TeacherSessionAccess = { sessionId: string; classId: string; isActive: boolean };

/** The teacher's own session (any state), or 404 SESSION_NOT_FOUND. */
export async function requireTeacherSessionAccess(db: Db, teacherId: string, sessionId: string): Promise<TeacherSessionAccess> {
  if (typeof teacherId !== "string" || teacherId === "") throw breakoutError("SESSION_NOT_FOUND");
  const id = requireRouteId(sessionId, "SESSION_NOT_FOUND");
  const session = await db.classSession.findFirst({
    where: { id, class: { teacherId } },
    select: { id: true, classId: true, isActive: true },
  });
  if (!session) throw breakoutError("SESSION_NOT_FOUND");
  return { sessionId: session.id, classId: session.classId, isActive: session.isActive };
}

/**
 * Inside a write transaction, after requireActiveSessionShared(): the locked
 * session's class must belong to the teacher, else 404 SESSION_NOT_FOUND.
 */
export async function assertTeacherOwnsLockedSession(db: Db, session: ActiveSessionLock, teacherId: string): Promise<void> {
  if (typeof teacherId !== "string" || teacherId === "") throw breakoutError("SESSION_NOT_FOUND");
  const owner = await db.class.findUnique({ where: { id: session.classId }, select: { teacherId: true } });
  if (!owner || owner.teacherId !== teacherId) throw breakoutError("SESSION_NOT_FOUND");
}
