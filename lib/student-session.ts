import { isValidSessionVersion, type AuthTokenPayload } from "@/lib/auth";
import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

/*
 * Central student session validation (Student Profile SP-5.4).
 *
 * A student JWT (already signature- and expiry-checked by verifyAuthToken) is
 * only a claim. Every server-side student entry point also checks the
 * database: the student exists, the token's session version (`sv`, absent =
 * 0) equals Student.sessionVersion, and the account is active.
 *
 *   ACTIVE    status 0 and matching version          -> allow
 *   INACTIVE  status 1 and matching version          -> 403 STUDENT_ACCOUNT_INACTIVE
 *   INVALID   missing, status 2 (or unknown), or any
 *             version mismatch                        -> 401 UNAUTHORIZED
 *
 * The version is compared before the status, so a stale token learns nothing
 * about the account. A database failure, or an invalid stored version, is
 * thrown (never treated as access). Only `status` and `sessionVersion` are
 * read, by the id from the verified token; nothing from the request.
 * Teacher, admin and guardian sessions never come here.
 */

export type StudentTokenPayload = Extract<AuthTokenPayload, { role: "STUDENT" }>;

export type StudentSessionAccess = "ACTIVE" | "INACTIVE" | "INVALID";

const ACTIVE_STATUS = 0;
const INACTIVE_STATUS = 1;

export async function checkStudentSessionAccess(payload: StudentTokenPayload): Promise<StudentSessionAccess> {
  if (payload.role !== "STUDENT" || typeof payload.sub !== "string" || payload.sub.trim() === "") return "INVALID";
  if (!isValidSessionVersion(payload.sessionVersion)) return "INVALID";

  // Errors propagate: no answer from the database is never access.
  const student = await prisma.student.findUnique({
    where: { id: payload.sub },
    select: { status: true, sessionVersion: true },
  });

  if (!student) return "INVALID";
  if (!isValidSessionVersion(student.sessionVersion)) {
    throw new Error("Invalid student session version in the database.");
  }
  if (student.sessionVersion !== payload.sessionVersion) return "INVALID";
  if (student.status === ACTIVE_STATUS) return "ACTIVE";
  if (student.status === INACTIVE_STATUS) return "INACTIVE";
  return "INVALID"; // 2 = deleted, or any unknown status
}

/** For APIs: throws the project's AppErrors (401 / 403) unless the session is active. */
export async function assertStudentSessionAccess(payload: StudentTokenPayload): Promise<void> {
  const access = await checkStudentSessionAccess(payload);
  if (access === "ACTIVE") return;
  if (access === "INACTIVE") {
    throw new AppError("Your student account is inactive. Please contact your teacher.", 403, "STUDENT_ACCOUNT_INACTIVE");
  }
  throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
}
