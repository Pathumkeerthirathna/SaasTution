import { SignJWT, jwtVerify } from "jose";

type InviteRole = "STUDENT";

export type SessionInvitePayload = {
  sessionId: string;
  classId: string;
  studentId: string;
  role: InviteRole;
};

const INVITE_TOKEN_TTL_SECONDS = 60 * 60 * 6;

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }

  return new TextEncoder().encode(secret);
}

export async function signSessionInviteToken(payload: SessionInvitePayload): Promise<string> {
  return new SignJWT({
    type: "LIVE_SESSION_INVITE",
    sessionId: payload.sessionId,
    classId: payload.classId,
    studentId: payload.studentId,
    role: payload.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${INVITE_TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function verifySessionInviteToken(token: string): Promise<SessionInvitePayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());

    if (
      payload.type !== "LIVE_SESSION_INVITE" ||
      typeof payload.sessionId !== "string" ||
      typeof payload.classId !== "string" ||
      typeof payload.studentId !== "string" ||
      payload.role !== "STUDENT"
    ) {
      return null;
    }

    return {
      sessionId: payload.sessionId,
      classId: payload.classId,
      studentId: payload.studentId,
      role: "STUDENT",
    };
  } catch {
    return null;
  }
}
