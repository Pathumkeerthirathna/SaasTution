import crypto from "node:crypto";

/*
 * Authenticated encryption of the SENSITIVE part of a queued email (today: the
 * temporary password of a student welcome / credential resend email), so a
 * retry sends the SAME credentials without the password ever being stored in
 * plain text (EmailDelivery.encryptedPayload).
 *
 *   - AES-256-GCM, a fresh random 96-bit IV per value, 128-bit tag.
 *   - The key comes ONLY from EMAIL_PAYLOAD_ENCRYPTION_KEY (64 hex characters
 *     = 32 bytes; generate with `openssl rand -hex 32`). Never hard-coded,
 *     never stored in the database, never logged.
 *   - Associated data binds the ciphertext to its row (the EmailDelivery id):
 *     a payload copied onto another row does not decrypt.
 *   - Format: "v1." + base64url(iv | tag | ciphertext).
 *
 * Missing / malformed key: EmailPayloadKeyError (callers fail safely: nothing
 * is queued with an unprotected payload). Wrong key, tampering or another
 * row's payload: EmailPayloadDecryptError. Error messages never contain the
 * key or the payload.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = "v1.";
export const EMAIL_PAYLOAD_KEY_ENV = "EMAIL_PAYLOAD_ENCRYPTION_KEY";

export class EmailPayloadKeyError extends Error {
  readonly code = "EMAIL_PAYLOAD_KEY_MISSING";
  constructor(message: string) {
    super(message);
    this.name = "EmailPayloadKeyError";
  }
}

export class EmailPayloadDecryptError extends Error {
  readonly code = "EMAIL_PAYLOAD_UNREADABLE";
  constructor() {
    super("The queued email payload could not be decrypted (wrong key, altered, or not this record's payload).");
    this.name = "EmailPayloadDecryptError";
  }
}

export type CredentialEmailPayload = { temporaryPassword: string };

function readKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env[EMAIL_PAYLOAD_KEY_ENV]?.trim();
  if (!raw) {
    throw new EmailPayloadKeyError(
      `${EMAIL_PAYLOAD_KEY_ENV} is not configured. Set it to 64 hex characters (openssl rand -hex 32) on the server; credential emails cannot be queued without it.`
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new EmailPayloadKeyError(`${EMAIL_PAYLOAD_KEY_ENV} must be exactly 64 hex characters (32 bytes).`);
  }
  return Buffer.from(raw, "hex");
}

/** True when a usable key is configured (never reveals it). */
export function isEmailPayloadEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readKey(env);
    return true;
  } catch {
    return false;
  }
}

/** Throws EmailPayloadKeyError when the key is missing or malformed. */
export function assertEmailPayloadEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): void {
  readKey(env);
}

export function encryptEmailPayload(payload: CredentialEmailPayload, recordId: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = readKey(env);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(`email-delivery:${recordId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ p: payload.temporaryPassword }), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decryptEmailPayload(value: string, recordId: string, env: NodeJS.ProcessEnv = process.env): CredentialEmailPayload {
  const key = readKey(env);
  if (typeof value !== "string" || !value.startsWith(PREFIX)) throw new EmailPayloadDecryptError();
  const raw = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (raw.length <= IV_LENGTH + TAG_LENGTH) throw new EmailPayloadDecryptError();
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_LENGTH), { authTagLength: TAG_LENGTH });
    decipher.setAAD(Buffer.from(`email-delivery:${recordId}`, "utf8"));
    decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain) as { p?: unknown };
    if (typeof parsed.p !== "string" || parsed.p.length === 0) throw new Error("shape");
    return { temporaryPassword: parsed.p };
  } catch {
    throw new EmailPayloadDecryptError();
  }
}
