import { SignJWT, jwtVerify } from "jose";

export const AUTH_COOKIE_NAME = "teacher_session";
const ONE_DAY_SECONDS = 60 * 60 * 24;
const SEVEN_DAYS_SECONDS = ONE_DAY_SECONDS * 7;

export type AppRole = "TEACHER" | "ADMIN" | "STUDENT";

type AuthTokenIdentity = {
  sub: string;
  email: string;
  name: string;
};

/**
 * Student tokens carry the student's session version (JWT claim `sv`, Student
 * Profile SP-5): a non-negative integer compared with Student.sessionVersion
 * so a password change can end the student's other sessions. Teacher and admin
 * tokens never carry it (guardian and session-invite tokens are separate).
 */
export type AuthTokenPayload =
  | (AuthTokenIdentity & { role: "TEACHER" | "ADMIN"; sessionVersion?: undefined })
  | (AuthTokenIdentity & { role: "STUDENT"; sessionVersion: number });

/** JWT claim name of the student session version. */
export const STUDENT_SESSION_VERSION_CLAIM = "sv";

/** A valid session version: an integer from 0 up to the database INTEGER maximum. */
export function isValidSessionVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
}

/**
 * The session version of a student record as loaded by the login flow.
 * Until the `sessionVersion` column is migrated and the Prisma client is
 * regenerated, records do not include the field: absent means 0 (the
 * column's default, and how a token without `sv` is read). A present but
 * invalid value is an error, never silently 0.
 */
export function studentSessionVersionOf(record: object): number {
  const value = (record as { sessionVersion?: unknown }).sessionVersion;
  if (value === undefined) return 0;
  if (!isValidSessionVersion(value)) throw new Error("Invalid student session version.");
  return value;
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }

  return new TextEncoder().encode(secret);
}

export async function signAuthToken(payload: AuthTokenPayload): Promise<string> {
  const claims: Record<string, unknown> = {
    email: payload.email,
    role: payload.role,
    name: payload.name,
  };

  if (payload.role === "STUDENT") {
    // Every new student token carries its session version.
    if (!isValidSessionVersion(payload.sessionVersion)) {
      throw new Error("A student token needs a valid session version.");
    }
    claims[STUDENT_SESSION_VERSION_CLAIM] = payload.sessionVersion;
  } else if ((payload as { sessionVersion?: unknown }).sessionVersion !== undefined) {
    throw new Error("Only student tokens carry a session version.");
  }

  return new SignJWT(claims)
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

    if (payload.role === "STUDENT") {
      // A student token issued before session versioning has no `sv`: version 0.
      // A present but invalid `sv` (negative, fractional, string, ...) rejects it.
      const sv = payload[STUDENT_SESSION_VERSION_CLAIM];
      if (sv !== undefined && !isValidSessionVersion(sv)) {
        return null;
      }

      return {
        sub: payload.sub,
        email: payload.email,
        role: "STUDENT",
        name: payload.name,
        sessionVersion: sv === undefined ? 0 : sv,
      };
    }

    // Teacher / admin: unchanged (no session version is read or returned).
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
