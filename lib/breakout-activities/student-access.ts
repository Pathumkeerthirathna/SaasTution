// Student access to a class session's breakout activities (Stage 3).
//
// The student is the one in the signed login session (requireStudentSession,
// the existing convention); a studentId in a request body or query is never
// used. Being logged in is not enough: like the existing classroom routes
// (participant-map, live-updates, join-info), the session must be active and
// the student must be active (status 0) and actively enrolled in the
// session's class (an active ClassStudent row).
//
// Approved decision D2: a session that does not exist, has ended, or whose
// class the student is not (or no longer) enrolled in all answer the same
// 404 NOT_FOUND, so a student can tell none of these apart.
//
// Reads check access with requireEnrolledStudentSessionAccess(). Writes
// lock the session with lockEnrolledActiveSession() and so check it again on
// the locked row, inside their transaction. The room is a separate check
// (room-resolver.ts), made by the services.

import type { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";

import { breakoutError } from "./errors";
import { requireActiveSessionShared, type ActiveSessionLock } from "./locks";
import { requireRouteId } from "./teacher-access";

type Db = Pick<Prisma.TransactionClient, "classSession" | "student">;

export type StudentSessionAccess = { sessionId: string; classId: string };

const notFound = () => breakoutError("NOT_FOUND");

async function isEnrolled(db: Db, studentId: string, classId: string): Promise<boolean> {
  const student = await db.student.findFirst({
    where: { id: studentId, status: 0, classes: { some: { classId, isActive: true } } },
    select: { id: true },
  });
  return student !== null;
}

/**
 * The student's live session: active, and the student actively enrolled in
 * its class. Anything else is 404 NOT_FOUND (D2).
 */
export async function requireEnrolledStudentSessionAccess(db: Db, studentId: string, sessionId: string): Promise<StudentSessionAccess> {
  if (typeof studentId !== "string" || studentId === "") throw notFound();
  const id = requireRouteId(sessionId, "NOT_FOUND");
  const session = await db.classSession.findFirst({ where: { id, isActive: true }, select: { id: true, classId: true } });
  if (!session) throw notFound();
  if (!(await isEnrolled(db, studentId, session.classId))) throw notFound();
  return { sessionId: session.id, classId: session.classId };
}

/**
 * Lock-order level 1 for a student write: access as above (before anything
 * could reveal the session's state), then the session row FOR KEY SHARE,
 * which must still be active, then enrolment again on the locked row.
 * Every failure is 404 NOT_FOUND (D2), never SESSION_NOT_ACTIVE.
 */
export async function lockEnrolledActiveSession(
  tx: Prisma.TransactionClient,
  studentId: string,
  sessionId: string
): Promise<ActiveSessionLock> {
  const access = await requireEnrolledStudentSessionAccess(tx, studentId, sessionId);
  let session: ActiveSessionLock;
  try {
    session = await requireActiveSessionShared(tx, access.sessionId);
  } catch (error) {
    // Ended (or gone) between the check and the lock: the same 404 (D2).
    if (error instanceof AppError && (error.code === "SESSION_NOT_FOUND" || error.code === "SESSION_NOT_ACTIVE")) throw notFound();
    throw error;
  }
  if (!(await isEnrolled(tx, studentId, session.classId))) throw notFound();
  return session;
}
