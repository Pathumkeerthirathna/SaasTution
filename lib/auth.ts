import { SignJWT, jwtVerify } from "jose";

export const AUTH_COOKIE_NAME = "teacher_session";
const ONE_DAY_SECONDS = 60 * 60 * 24;
const SEVEN_DAYS_SECONDS = ONE_DAY_SECONDS * 7;

export type AppRole = "TEACHER" | "ADMIN" | "STUDENT";

export type AuthTokenPayload = {
  sub: string;
  email: string;
  role: AppRole;
  name: string;
};

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }

  return new TextEncoder().encode(secret);
}

export async function signAuthToken(payload: AuthTokenPayload): Promise<string> {
  return new SignJWT({
    email: payload.email,
    role: payload.role,
    name: payload.name,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${SEVEN_DAYS_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function verifyAuthToken(token: string): Promise<AuthTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());

    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      (payload.role !== "TEACHER" && payload.role !== "ADMIN" && payload.role !== "STUDENT") ||
      typeof payload.name !== "string"
    ) {
      return null;
    }

    return {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      name: payload.name,
    };
  } catch {
    return null;
  }
}

export function buildSessionCookieConfig() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SEVEN_DAYS_SECONDS,
  };
}
