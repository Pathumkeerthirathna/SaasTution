import { SignJWT, jwtVerify } from "jose";

export const GUARDIAN_AUTH_COOKIE_NAME = "guardian_session";
const ONE_DAY_SECONDS = 60 * 60 * 24;
const SEVEN_DAYS_SECONDS = ONE_DAY_SECONDS * 7;

export type GuardianTokenPayload = {
  sub: string;
  email: string;
  role: "GUARDIAN";
  name: string;
};

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }

  return new TextEncoder().encode(secret);
}

export async function signGuardianToken(payload: GuardianTokenPayload): Promise<string> {
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

export async function verifyGuardianToken(token: string): Promise<GuardianTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());

    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      payload.role !== "GUARDIAN" ||
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

export function buildGuardianSessionCookieConfig() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SEVEN_DAYS_SECONDS,
  };
}
