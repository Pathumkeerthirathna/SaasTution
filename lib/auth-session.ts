import { cookies } from "next/headers";

import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { AppError } from "@/lib/error-handler";

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
    };

export async function requireAppSession(): Promise<AppSession> {
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;

  if (!token) {
    throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
  }

  const payload = await verifyAuthToken(token);

  if (!payload) {
    throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
  }

  return {
    userId: payload.sub,
    email: payload.email,
    name: payload.name,
    role: payload.role,
  };
}

export async function requireTeacherSession(): Promise<TeacherSession> {
  const session = await requireAppSession();

  if (session.role !== "TEACHER") {
    throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
  }

  return {
    teacherId: session.userId,
    email: session.email,
    name: session.name,
    role: "TEACHER",
  };
}

export async function requireAdminSession(): Promise<AdminSession> {
  const session = await requireAppSession();

  if (session.role !== "ADMIN") {
    throw new AppError("Admin privileges are required.", 403, "FORBIDDEN");
  }

  return {
    adminId: session.userId,
    email: session.email,
    name: session.name,
    role: "ADMIN",
  };
}
