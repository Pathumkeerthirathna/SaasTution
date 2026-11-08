/**
 * Student QR identity tokens: pure, server-only crypto helpers.
 * See docs/student-qr-identity.md (decisions fixed in T2).
 *
 *   token     = base64url(HMAC-SHA256(secret, "slc-student-qr:v1:" + rowId + ":" + nonce))
 *   tokenHash = hex(SHA-256(token))           <- the only thing ever stored
 *   payload   = "SLCQR1:" + token             <- what the QR image encodes
 *
 * No database access, no logging, no caching. Nothing here ever generates a
 * replacement secret or a replacement token: a missing / invalid secret throws
 * StudentQrConfigError, invalid input throws StudentQrInputError, and an
 * invalid scanned payload parses to null. Error messages never contain the
 * secret, tokens, nonces or hashes.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

if (typeof window !== "undefined") {
  // Defence in depth: the secret is never NEXT_PUBLIC_, so a client bundle
  // could not read it anyway; refuse to run in a browser at all.
  throw new Error("lib/student-qr-token is server-only.");
}

export const STUDENT_QR_SECRET_ENV = "STUDENT_QR_SECRET";
export const STUDENT_QR_SECRET_MIN_BYTES = 32;
export const STUDENT_QR_NONCE_BYTES = 32;
export const STUDENT_QR_PAYLOAD_PREFIX = "SLCQR1:";
const DERIVATION_PREFIX = "slc-student-qr:v1:";

/** 32 bytes as unpadded base64url = 43 characters. */
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Row ids are Prisma uuid() values: lowercase, hyphenated. */
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The secret is base64 or base64url text (e.g. `openssl rand -base64 48`). */
const SECRET_TEXT = /^[A-Za-z0-9+/_-]+={0,2}$/;

export type StudentQrConfigProblem =
  | "missing"
  | "invalid_encoding"
  | "too_short"
  | "low_entropy"
  | "reuses_jwt_secret";

const CONFIG_DETAILS: Record<StudentQrConfigProblem, string> = {
  missing: `${STUDENT_QR_SECRET_ENV} is not set.`,
  invalid_encoding: `${STUDENT_QR_SECRET_ENV} must be base64 or base64url text.`,
  too_short: `${STUDENT_QR_SECRET_ENV} must decode to at least ${STUDENT_QR_SECRET_MIN_BYTES} bytes.`,
  low_entropy: `${STUDENT_QR_SECRET_ENV} does not look random; generate it with \`openssl rand -base64 48\`.`,
  reuses_jwt_secret: `${STUDENT_QR_SECRET_ENV} must not be the same value as JWT_SECRET.`,
};

/**
 * The QR secret is missing or unusable. `message` is safe to show to users;
 * `detail` explains the problem for server logs / operators. Neither ever
 * contains the secret.
 */
export class StudentQrConfigError extends Error {
  readonly statusCode = 503;
  readonly code = "STUDENT_QR_NOT_CONFIGURED";
  readonly problem: StudentQrConfigProblem;
  readonly detail: string;

  constructor(problem: StudentQrConfigProblem) {
    super("Student QR codes are not configured on this server.");
    this.name = "StudentQrConfigError";
    this.problem = problem;
    this.detail = CONFIG_DETAILS[problem];
  }
}

/** A programming error: a malformed row id, nonce, token or hash was passed in. */
export class StudentQrInputError extends Error {
  constructor(what: "rowId" | "nonce" | "token" | "secret") {
    super(`Invalid student QR ${what}.`);
    this.name = "StudentQrInputError";
  }
}

/**
 * Reads and validates STUDENT_QR_SECRET. Returns the decoded key bytes.
 * Throws StudentQrConfigError; never falls back to another secret and never
 * generates one.
 */
export function loadStudentQrSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[STUDENT_QR_SECRET_ENV]?.trim();
  if (!raw) throw new StudentQrConfigError("missing");
  if (!SECRET_TEXT.test(raw)) throw new StudentQrConfigError("invalid_encoding");

  const jwtSecret = env.JWT_SECRET?.trim();
  if (jwtSecret && sameText(raw, jwtSecret)) throw new StudentQrConfigError("reuses_jwt_secret");

  const key = Buffer.from(raw, "base64");
  if (key.length < STUDENT_QR_SECRET_MIN_BYTES) throw new StudentQrConfigError("too_short");
  // 32+ random bytes practically always contain far more than 16 distinct
  // values; this rejects placeholders such as "AAAA..." or a repeated word.
  if (new Set(key).size < 16) throw new StudentQrConfigError("low_entropy");
  return key;
}

/** A fresh nonce: 32 cryptographically secure random bytes, base64url (43 chars). */
export function generateStudentQrNonce(): string {
  return randomBytes(STUDENT_QR_NONCE_BYTES).toString("base64url");
}

export function isValidStudentQrNonce(nonce: unknown): nonce is string {
  return isCanonicalBase64Url32(nonce);
}

export function isValidStudentQrTokenHash(hash: unknown): hash is string {
  return typeof hash === "string" && SHA256_HEX.test(hash);
}

/** Deterministic: same secret + row id + nonce always give the same token. */
export function deriveStudentQrToken(secret: Buffer, rowId: string, nonce: string): string {
  assertSecret(secret);
  if (typeof rowId !== "string" || !ROW_ID.test(rowId)) throw new StudentQrInputError("rowId");
  if (!isValidStudentQrNonce(nonce)) throw new StudentQrInputError("nonce");
  return createHmac("sha256", secret)
    .update(`${DERIVATION_PREFIX}${rowId}:${nonce}`, "utf8")
    .digest("base64url");
}

/** SHA-256 of the token, lowercase hex (64 chars): the stored `tokenHash`. */
export function hashStudentQrToken(token: string): string {
  if (!isCanonicalBase64Url32(token)) throw new StudentQrInputError("token");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The text encoded in the QR image. */
export function buildStudentQrPayload(token: string): string {
  if (!isCanonicalBase64Url32(token)) throw new StudentQrInputError("token");
  return `${STUDENT_QR_PAYLOAD_PREFIX}${token}`;
}

/**
 * Parses a scanned payload. Returns the token, or null for anything that is
 * not exactly "SLCQR1:" + a canonical 43-character base64url token (no
 * whitespace, case-sensitive prefix). Never throws.
 */
export function parseStudentQrPayload(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  if (payload.length !== STUDENT_QR_PAYLOAD_PREFIX.length + 43) return null;
  if (!payload.startsWith(STUDENT_QR_PAYLOAD_PREFIX)) return null;
  const token = payload.slice(STUDENT_QR_PAYLOAD_PREFIX.length);
  return isCanonicalBase64Url32(token) ? token : null;
}

/**
 * Constant-time equality of two token hashes. Malformed input is simply
 * "not equal" (false), never an exception.
 */
export function studentQrTokenHashesEqual(a: unknown, b: unknown): boolean {
  if (!isValidStudentQrTokenHash(a) || !isValidStudentQrTokenHash(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Re-derives a stored row's token and checks it against the stored hash.
 * Returns the token on a match and null on a mismatch (e.g. the secret was
 * rotated). The caller must then fail safely: never reissue automatically.
 */
export function deriveVerifiedStudentQrToken(
  secret: Buffer,
  row: { id: string; nonce: string; tokenHash: string }
): string | null {
  const token = deriveStudentQrToken(secret, row.id, row.nonce);
  return studentQrTokenHashesEqual(hashStudentQrToken(token), row.tokenHash) ? token : null;
}

function isCanonicalBase64Url32(value: unknown): value is string {
  if (typeof value !== "string" || !BASE64URL_43.test(value)) return false;
  // 43 chars carry 258 bits; the last 2 must be zero for exactly 32 bytes,
  // so each 32-byte value has exactly one accepted spelling.
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

function assertSecret(secret: Buffer) {
  if (!Buffer.isBuffer(secret) || secret.length < STUDENT_QR_SECRET_MIN_BYTES) {
    throw new StudentQrInputError("secret");
  }
}

/** Constant-time text comparison (via fixed-length digests). */
function sameText(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}
