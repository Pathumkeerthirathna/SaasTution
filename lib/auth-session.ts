import { cookies } from "next/headers";

import { AUTH_COOKIE_NAME, verifyAuthToken, type AuthTokenPayload } from "@/lib/auth";
import { AppError } from "@/lib/error-handler";
import { assertStudentSessionAccess, checkStudentSessionAccess } from "@/lib/student-session";

export type TeacherSession = {
  teacherId: string;
  email: string;
  name: string;
  role: "TEACHER";
};

export type AdminSession = {
  adminId: string;
  email: string;
  name: string;
  role: "ADMIN";
};

export type StudentSession = {
  studentId: string;
  email: string;
  name: string;
  role: "STUDENT";
};

export type AppSession =
  | {
      userId: string;
      email: string;
      name: string;
      role: "TEACHER";
    }
  | {
      userId: string;
      email: string;
      name: string;
      role: "ADMIN";
    }
  | {
      userId: string;
      email: string;
      name: string;
      role: "STUDENT";
    };

function toAppSession(payload: AuthTokenPayload): AppSession {
  return {
    userId: payload.sub,
    email: payload.email,
    name: payload.name,
    role: payload.role,
  };
}

/** The verified token from the session cookie (signature and expiry only; no database). */
async function readAppToken(): Promise<AuthTokenPayload> {
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;

  if (!token) {
    throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
  }

  const payload = await verifyAuthToken(token);

  if (!payload) {
    throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
  }

  return payload;
}

/**
 * Like `requireAppSession`, but returns null instead of throwing when there's no valid session.
 * A student session counts only while it passes the central student check (lib/student-session.ts);
 * a database failure still throws (never treated as a session).
 */
export async function getOptionalSession(): Promise<AppSession | null> {
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = await verifyAuthToken(token);
  if (!payload) return null;

  if (payload.role === "STUDENT" && (await checkStudentSessionAccess(payload)) !== "ACTIVE") return null;

  return toAppSession(payload);
}

/** Any signed-in app user. Student sessions are also checked against the database (lib/student-session.ts). */
export async function requireAppSession(): Promise<AppSession> {
  const payload = await readAppToken();

  if (payload.role === "STUDENT") {
    await assertStudentSessionAccess(payload);
  }

  return toAppSession(payload);
}

export async function requireTeacherSession(): Promise<TeacherSession> {
  const payload = await readAppToken();

  if (payload.role !== "TEACHER") {
    throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
  }

  return {
    teacherId: payload.sub,
    email: payload.email,
    name: payload.name,
    role: "TEACHER",
  };
}

export async function requireAdminSession(): Promise<AdminSession> {
  const payload = await readAppToken();

  if (payload.role !== "ADMIN") {
    throw new AppError("Admin privileges are required.", 403, "FORBIDDEN");
  }

  return {
    adminId: payload.sub,
    email: payload.email,
    name: payload.name,
    role: "ADMIN",
  };
}

/**
 * The signed-in student (Student Profile SP-5.4): a valid student token whose
 * student exists, is active (status 0) and whose session version matches the
 * database. 401 UNAUTHORIZED otherwise, or 403 STUDENT_ACCOUNT_INACTIVE for an
 * inactive account; a database failure is thrown as is.
 */
export async function requireStudentSession(): Promise<StudentSession> {
  const payload = await readAppToken();

  if (payload.role !== "STUDENT") {
    throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
  }

  await assertStudentSessionAccess(payload);

  return {
    studentId: payload.sub,
    email: payload.email,
    name: payload.name,
    role: "STUDENT",
  };
}
