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
