/*
 * Codec test room tokens: issued with the app's own generateJitsiToken
 * (lib/jitsi-auth.ts) and verified right after, so a link is only ever
 * handed out once its room, expiry and moderator permission are checked.
 *
 * Nothing here prints or returns the signing secret, and error messages
 * never include a token.
 */

import { jwtVerify } from "jose";

import { generateJitsiToken } from "../../lib/jitsi-auth";

/** generateJitsiToken's lifetime; anything longer is refused. */
export const MAX_TOKEN_LIFETIME_SECONDS = 3600;

export type VerifiedTokenClaims = {
  room: string;
  name: string;
  moderator: boolean;
  affiliation: string;
  issuedAt: Date;
  expiresAt: Date;
  lifetimeSeconds: number;
};

function getSecretKey(): Uint8Array {
  const secret = process.env.JITSI_JWT_SECRET?.trim() ? process.env.JITSI_JWT_SECRET : "";

  if (!secret) {
    throw new Error("JITSI_JWT_SECRET is not configured.");
  }

  return new TextEncoder().encode(secret);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Verifies the signature (HS256, audience, issuer, not expired) and that the
 * token is limited to exactly `room` (never "*"), lives at most an hour and
 * carries exactly the expected moderator permission.
 */
export async function verifyTestToken(
  token: string,
  expected: { room: string; moderator: boolean },
  now: Date = new Date()
): Promise<VerifiedTokenClaims> {
  const audience = process.env.JITSI_JWT_AUD?.trim() || "jitsi";
  const issuer = process.env.JITSI_JWT_ISS?.trim() || "saastution";

  let payload: Record<string, unknown>;

  try {
    ({ payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ["HS256"],
      audience,
      issuer,
      currentDate: now,
    }));
  } catch (error) {
    throw new Error(`Token verification failed: ${error instanceof Error ? error.name : "unknown error"}.`);
  }

  const room = payload.room;

  if (typeof room !== "string" || room === "*" || room !== expected.room) {
    throw new Error("Token is not limited to the expected test room.");
  }

  const iat = payload.iat;
  const exp = payload.exp;

  if (typeof iat !== "number" || typeof exp !== "number") {
    throw new Error("Token has no issue or expiry time.");
  }

  const lifetimeSeconds = exp - iat;

  if (lifetimeSeconds <= 0 || lifetimeSeconds > MAX_TOKEN_LIFETIME_SECONDS) {
    throw new Error(`Token lifetime ${lifetimeSeconds}s is outside 1..${MAX_TOKEN_LIFETIME_SECONDS}s.`);
  }

  const user = asRecord(asRecord(payload.context)?.user);
  const moderatorClaim = user?.moderator;
  const moderator = moderatorClaim === true || moderatorClaim === "true";
  const affiliation = typeof user?.affiliation === "string" ? user.affiliation : "";

  if (moderator !== expected.moderator) {
    throw new Error(`Token moderator permission is ${moderator}, expected ${expected.moderator}.`);
  }

  if (affiliation !== (expected.moderator ? "owner" : "member")) {
    throw new Error(`Token affiliation "${affiliation}" does not match the moderator permission.`);
  }

  return {
    room,
    name: typeof user?.name === "string" ? user.name : "",
    moderator,
    affiliation,
    issuedAt: new Date(iat * 1000),
    expiresAt: new Date(exp * 1000),
    lifetimeSeconds,
  };
}

/** Issues a token with the app's own helper, then verifies it. */
export async function issueTestToken(options: {
  room: string;
  name: string;
  moderator: boolean;
  jitsiDomain: string;
}): Promise<{ token: string; claims: VerifiedTokenClaims }> {
  const token = await generateJitsiToken(options);
  const claims = await verifyTestToken(token, { room: options.room, moderator: options.moderator });

  return { token, claims };
}
