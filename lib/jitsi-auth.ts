import { SignJWT } from "jose";

export type JitsiTokenPayload = {
  name: string;
  room: string;
  moderator: boolean;
  jitsiDomain: string;
};

function getJitsiJwtSecret() {
  const secret = process.env.JITSI_JWT_SECRET;

  if (!secret) {
    throw new Error("JITSI_JWT_SECRET is not configured.");
  }

  return new TextEncoder().encode(secret);
}

export async function generateJitsiToken(payload: JitsiTokenPayload): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresIn = 3600; // 1 hour
  const audience = process.env.JITSI_JWT_AUD?.trim() || "jitsi";
  const issuer = process.env.JITSI_JWT_ISS?.trim() || "saastution";
  const subject = process.env.JITSI_JWT_SUB?.trim() || payload.jitsiDomain;

  return new SignJWT({
    aud: audience,
    iss: issuer,
    sub: subject,
    room: payload.room,
    context: {
    user: {
      name: payload.name,
      moderator: payload.moderator ? "true" : "false",
      affiliation: payload.moderator ? "owner" : "member",
    },
  },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + expiresIn)
    .sign(getJitsiJwtSecret());
}

/*
 * System moderator token (backend Jibri stop after a teacher departure,
 * lib/jibri-stop-for-departure.ts): a dedicated identity, never the teacher's,
 * for ONE exact classroom, valid for at most SYSTEM_TOKEN_LIFETIME_SECONDS.
 * Same secret, audience, issuer and subject conventions as
 * generateJitsiToken (which is unchanged). The token is never logged; errors
 * never include it.
 */

export const SYSTEM_JITSI_USER = { id: "system:jibri-stop", name: "SL Classroom System" } as const;

export const SYSTEM_TOKEN_LIFETIME_SECONDS = 90;

/** Rooms created by createRoomName (services/session-service.ts), lowercase. Never "*". */
export const CLASSROOM_ROOM_NAME = /^saastution-[0-9a-z]{1,8}-[0-9a-z]{1,16}$/;

/** A DNS host name (lowercase labels), e.g. meet.slclassroom.live. */
export const JITSI_HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The issuer and audience the system token is signed with (the same
 * defaults as every Jitsi token here). Also the worker identity the app
 * compares (lib/jibri-stop-config.ts).
 */
export function jitsiJwtIssuerAudience(env: NodeJS.ProcessEnv): { issuer: string; audience: string } {
  return {
    issuer: env.JITSI_JWT_ISS?.trim() || "saastution",
    audience: env.JITSI_JWT_AUD?.trim() || "jitsi",
  };
}

export async function generateSystemJitsiToken(payload: { room: string; jitsiDomain: string }): Promise<string> {
  if (!CLASSROOM_ROOM_NAME.test(payload.room)) {
    throw new Error("System Jitsi token: invalid room name.");
  }

  if (!JITSI_HOST_NAME.test(payload.jitsiDomain)) {
    throw new Error("System Jitsi token: invalid Jitsi domain.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const { issuer, audience } = jitsiJwtIssuerAudience(process.env);
  const subject = process.env.JITSI_JWT_SUB?.trim() || payload.jitsiDomain;

  return new SignJWT({
    aud: audience,
    iss: issuer,
    sub: subject,
    room: payload.room,
    context: {
      user: {
        id: SYSTEM_JITSI_USER.id,
        name: SYSTEM_JITSI_USER.name,
        moderator: "true",
        affiliation: "owner",
      },
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + SYSTEM_TOKEN_LIFETIME_SECONDS)
    .sign(getJitsiJwtSecret());
}
