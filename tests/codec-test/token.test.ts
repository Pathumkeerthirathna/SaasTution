/*
 * Codec test room tokens (scripts/codec-test/token.ts, using the app's own
 * lib/jitsi-auth.ts).
 *
 *   npm run test:codec
 *
 * Signs with a random throwaway secret created here; the real
 * JITSI_JWT_SECRET is never read, and no token or secret is printed.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { issueTestToken, MAX_TOKEN_LIFETIME_SECONDS, verifyTestToken } from "../../scripts/codec-test/token";

const ENV_KEYS = ["JITSI_JWT_SECRET", "JITSI_JWT_AUD", "JITSI_JWT_ISS", "JITSI_JWT_SUB"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let secret = "";

beforeEach(() => {
  secret = randomBytes(32).toString("hex");
  process.env.JITSI_JWT_SECRET = secret;
  delete process.env.JITSI_JWT_AUD;
  delete process.env.JITSI_JWT_ISS;
  delete process.env.JITSI_JWT_SUB;
});

after(() => {
  ENV_KEYS.forEach((key) => {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  });
});

const ROOM = "sl-codec-test-a-1-abcdef";
const DOMAIN = "meet.example.test";

// An error message must never carry the token or the secret.
async function rejectsSafely(promise: Promise<unknown>, token: string, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(token), "error message contains the token");
    assert.ok(!error.message.includes(secret), "error message contains the secret");

    return true;
  });
}

test("teacher token: limited to the room, moderator (owner), one hour", async () => {
  const before = Math.floor(Date.now() / 1000);
  const { token, claims } = await issueTestToken({ room: ROOM, name: "Codec Test Teacher", moderator: true, jitsiDomain: DOMAIN });

  assert.equal(token.split(".").length, 3);
  assert.equal(claims.room, ROOM);
  assert.equal(claims.moderator, true);
  assert.equal(claims.affiliation, "owner");
  assert.equal(claims.name, "Codec Test Teacher");
  assert.equal(claims.lifetimeSeconds, MAX_TOKEN_LIFETIME_SECONDS);

  const expires = claims.expiresAt.getTime() / 1000;

  assert.ok(expires >= before + 3600 && expires <= before + 3600 + 5, "expires about an hour from now");
});

test("student token: limited to the room, not a moderator (member)", async () => {
  const { claims } = await issueTestToken({ room: ROOM, name: "Codec Test Student", moderator: false, jitsiDomain: DOMAIN });

  assert.equal(claims.room, ROOM);
  assert.equal(claims.moderator, false);
  assert.equal(claims.affiliation, "member");
});

test("a token is refused for another room", async () => {
  const { token } = await issueTestToken({ room: ROOM, name: "T", moderator: true, jitsiDomain: DOMAIN });

  await rejectsSafely(verifyTestToken(token, { room: "sl-codec-test-b-1-abcdef", moderator: true }), token, /expected test room/);
});

test("a wildcard room token is never accepted", async () => {
  const { generateJitsiToken } = await import("../../lib/jitsi-auth");
  const token = await generateJitsiToken({ room: "*", name: "T", moderator: true, jitsiDomain: DOMAIN });

  await rejectsSafely(verifyTestToken(token, { room: "*", moderator: true }), token, /expected test room/);
});

test("a moderator permission that differs from the expected one is refused", async () => {
  const { token } = await issueTestToken({ room: ROOM, name: "S", moderator: false, jitsiDomain: DOMAIN });

  await rejectsSafely(verifyTestToken(token, { room: ROOM, moderator: true }), token, /moderator permission is false/);
});

test("a token signed with another secret is refused", async () => {
  const { token } = await issueTestToken({ room: ROOM, name: "T", moderator: true, jitsiDomain: DOMAIN });

  process.env.JITSI_JWT_SECRET = randomBytes(32).toString("hex");
  secret = process.env.JITSI_JWT_SECRET;

  await rejectsSafely(verifyTestToken(token, { room: ROOM, moderator: true }), token, /verification failed/);
});

test("a tampered token is refused", async () => {
  const { token } = await issueTestToken({ room: ROOM, name: "T", moderator: false, jitsiDomain: DOMAIN });
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

  claims.context.user.moderator = "true";

  const tampered = [header, Buffer.from(JSON.stringify(claims)).toString("base64url"), signature].join(".");

  await rejectsSafely(verifyTestToken(tampered, { room: ROOM, moderator: true }), tampered, /verification failed/);
});

test("an expired token is refused", async () => {
  const { token } = await issueTestToken({ room: ROOM, name: "T", moderator: true, jitsiDomain: DOMAIN });
  const later = new Date(Date.now() + 2 * 3600 * 1000);

  await rejectsSafely(verifyTestToken(token, { room: ROOM, moderator: true }, later), token, /verification failed/);
});

test("without a signing secret nothing is issued", async () => {
  delete process.env.JITSI_JWT_SECRET;

  await assert.rejects(
    issueTestToken({ room: ROOM, name: "T", moderator: true, jitsiDomain: DOMAIN }),
    /JITSI_JWT_SECRET is not configured/
  );
});
