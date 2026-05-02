import { cookies } from "next/headers";

import { GUARDIAN_AUTH_COOKIE_NAME, verifyGuardianToken } from "@/lib/guardian-auth";
import { AppError } from "@/lib/error-handler";

export type GuardianSession = {
  guardianId: string;
  email: string;
  name: string;
};

export async function requireGuardianSession(): Promise<GuardianSession> {
  const token = cookies().get(GUARDIAN_AUTH_COOKIE_NAME)?.value;

  if (!token) {
    throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
  }

  const payload = await verifyGuardianToken(token);

  if (!payload || payload.role !== "GUARDIAN") {
    throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
  }

  return {
    guardianId: payload.sub,
    email: payload.email,
    name: payload.name,
  };
}
