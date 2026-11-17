import crypto from "node:crypto";

import { EmailDeliveryStatus, EmailDeliveryType, Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import {
  decryptEmailPayload,
  EmailPayloadDecryptError,
  EmailPayloadKeyError,
  encryptEmailPayload,
  isEmailPayloadEncryptionConfigured,
} from "@/lib/email-payload-crypto";
import { buildStudentLoginLink, sendStudentWelcomeCredentialsEmail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";
import { studentLoginRateLimiter } from "@/lib/student-login-rate-limit";

/*
 * Student onboarding emails: persistent delivery tracking / outbox.
 *
 * WHAT IS STORED (EmailDelivery, prisma/schema.prisma): one row per email
 * operation, kept after sending (history). Never a plaintext password or an
 * email body: the temporary password is stored ONLY AES-256-GCM encrypted
 * (lib/email-payload-crypto.ts) so that every retry sends the SAME
 * credentials, and the ciphertext is cleared once it is no longer needed.
 *
 * QUEUEING (this file):
 *   - queueStudentWelcomeEmails(tx, ...): called INSIDE the transaction that
 *     creates the student(s), so a row exists exactly when the account exists
 *     (a failed or rolled-back registration queues nothing). One welcome per
 *     student (idempotencyKey "student-welcome:<studentId>", unique).
 *   - createCredentialResendDelivery(...): teacher "Resend Login Details"
 *     (services/student-registration-email-resend-service.ts). The NEW
 *     password's hash waits in pendingPasswordHash; the student's current
 *     password is untouched until the provider accepted the email.
 *
 * PROCESSING (processEmailDeliveries, run by services/email-delivery-worker.ts):
 *   1. Claim: each due row is moved PENDING -> PROCESSING by ONE conditional
 *      UPDATE (compare-and-set on status + nextRetryAt), with a fresh lease
 *      token and lease expiry; a row whose lease expired (worker crash) is
 *      reclaimed the same way (conditional on the old token). Two workers can
 *      never hold the same row; every later write is fenced by the token.
 *   2. Checks before sending: the student still exists (not deleted) and has
 *      an email (the CURRENT address is used, so a corrected typo is honoured);
 *      the credentials are still the student's current ones (welcome: the
 *      password hash is the one the email's password belongs to; resend: the
 *      password and session are unchanged since the request). Otherwise the
 *      row fails terminally WITHOUT sending stale credentials.
 *   3. Send (bounded by sendTimeoutMs). Accepted -> SENT (= accepted by the
 *      provider, NOT proof of inbox delivery), ciphertext cleared. Resend:
 *      then activateCredentialResend (below).
 *   4. Failure -> classified (provider rejection, temporary, timeout,
 *      ambiguous, permanent, configuration). Retryable and attempts left ->
 *      PENDING with exponential backoff; otherwise FAILED (ciphertext kept
 *      until payloadExpiresAt, so a teacher can retry after fixing the cause).
 *      Ambiguous outcomes (timeout / connection lost after sending started)
 *      are recorded as such and retried with the SAME credentials: the
 *      student may receive the same email twice, never two different
 *      passwords. SMTP cannot guarantee exactly-once delivery.
 *
 * RESEND ACTIVATION (activateCredentialResend): only for a SENT resend. One
 * transaction, conditional on the student's password and session being
 * EXACTLY as at request time: password := pendingPasswordHash, sessionVersion
 * + 1 (ends every session, as the teacher reset does), unused reset links
 * retired, other open credential emails of the student superseded. Devices,
 * approvals, enrolments, the teacher link and passwordSetupPending are never
 * touched. If the account changed meanwhile: activationErrorCode
 * ACCOUNT_CHANGED (the emailed password is NOT active; the old one still
 * works; the teacher sees it and can resend). If activation could not run
 * (database error, crash) the row stays "accepted, activation pending" and
 * every worker tick retries it (idempotent).
 */

export const EMAIL_DELIVERY_INITIATORS = {
  PUBLIC_REGISTRATION: "PUBLIC_REGISTRATION",
  TEACHER_ADD: "TEACHER_ADD",
  BULK_IMPORT: "BULK_IMPORT",
  TEACHER_RESEND: "TEACHER_RESEND",
} as const;
export type EmailDeliveryInitiator = (typeof EMAIL_DELIVERY_INITIATORS)[keyof typeof EMAIL_DELIVERY_INITIATORS];

// ---- Configuration -----------------------------------------------------------

export type EmailDeliveryConfig = {
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  leaseMs: number;
  sendTimeoutMs: number;
  payloadRetentionMs: number;
};

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export function emailDeliveryConfig(env: NodeJS.ProcessEnv = process.env): EmailDeliveryConfig {
  const sendTimeoutMs = intFromEnv(env, "EMAIL_DELIVERY_SEND_TIMEOUT_SECONDS", 60, 5, 600) * 1000;
  return {
    maxAttempts: intFromEnv(env, "EMAIL_DELIVERY_MAX_ATTEMPTS", 5, 1, 20),
    retryBaseMs: intFromEnv(env, "EMAIL_DELIVERY_RETRY_BASE_SECONDS", 60, 1, 86_400) * 1000,
    retryMaxMs: intFromEnv(env, "EMAIL_DELIVERY_RETRY_MAX_SECONDS", 6 * 3600, 1, 7 * 86_400) * 1000,
    // The lease must outlive one send attempt (plus margin), or a slow send could be reclaimed.
    leaseMs: Math.max(intFromEnv(env, "EMAIL_DELIVERY_LEASE_SECONDS", 300, 30, 3600) * 1000, sendTimeoutMs * 2),
    sendTimeoutMs,
    payloadRetentionMs: intFromEnv(env, "EMAIL_DELIVERY_PAYLOAD_RETENTION_HOURS", 168, 1, 24 * 90) * 3_600_000,
  };
}

/** Exponential backoff after the given (1-based) attempt: base * 2^(n-1), capped. */
export function retryDelayMs(attempt: number, config: Pick<EmailDeliveryConfig, "retryBaseMs" | "retryMaxMs"> = emailDeliveryConfig()): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(config.retryBaseMs * 2 ** exponent, config.retryMaxMs);
}

// ---- Helpers -----------------------------------------------------------------

/** SHA-256 of a password HASH (never of a password); null / missing hash has its own value. */
export function passwordHashFingerprint(hash: string | null | undefined): string {
  return crypto.createHash("sha256").update(`slc-password-hash:${hash ?? ""}`).digest("hex");
}

const EMAIL_PATTERN = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+/g;

/** Error text safe to store and show: no addresses, no given secrets, single line, bounded. */
export function sanitizeEmailErrorMessage(message: unknown, secrets: readonly string[] = []): string {
  let text = typeof message === "string" ? message : "";
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text.replace(EMAIL_PATTERN, "[address]").replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
}

export type EmailFailureCategory = "REJECTED" | "TEMPORARY" | "TIMEOUT" | "AMBIGUOUS" | "PERMANENT" | "CONFIGURATION";
export type ClassifiedEmailFailure = {
  category: EmailFailureCategory;
  code: string;
  retryable: boolean;
  /** The email may have been sent despite the error. */
  ambiguous: boolean;
};

const TIMEOUT_CODES = new Set(["SENDER_TIMEOUT", "ETIMEDOUT", "SEND_TIMEOUT"]);
// ECONNECTION / ESOCKET: nodemailer uses them for a connection lost at ANY stage, including after the message data.
const AMBIGUOUS_CODES = new Set(["SENDER_NETWORK_ERROR", "SENDER_NOT_CONFIRMED", "ESOCKET", "ECONNECTION", "ECONNRESET", "EPIPE"]);
const TEMPORARY_CODES = new Set(["SENDER_RATE_LIMITED", "SENDER_SERVER_ERROR", "ECONNREFUSED", "EDNS", "ENOTFOUND", "EAI_AGAIN"]);
const CONFIGURATION_CODES = new Set(["SENDER_AUTH_FAILED", "EAUTH", "EMAIL_NOT_CONFIGURED", "EMAIL_PAYLOAD_KEY_MISSING"]);
const REJECTED_CODES = new Set(["SENDER_VALIDATION_FAILED", "EENVELOPE"]);
const PERMANENT_CODES = new Set(["SENDER_REQUEST_FAILED", "EMESSAGE"]);

/**
 * Provider rejection (the provider refused THIS email: permanent), temporary
 * (nothing was sent: retry), timeout / ambiguous (may have been sent: retry
 * with the same credentials), permanent, or configuration (retried: fixing
 * the configuration makes it succeed).
 */
export function classifyEmailFailure(error: unknown): ClassifiedEmailFailure {
  const e = (error ?? {}) as { code?: unknown; responseCode?: unknown; syscall?: unknown };
  const code = typeof e.code === "string" && /^[A-Z0-9_]{1,48}$/.test(e.code) ? e.code : "";
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : null;

  // The TCP connection could not even be opened (nodemailer keeps the socket's syscall): nothing was sent.
  if (e.syscall === "connect") return { category: "TEMPORARY", code: code || "CONNECT_FAILED", retryable: true, ambiguous: false };

  // The SMTP reply code decides first (nodemailer reports both 4xx and 5xx recipient replies as EENVELOPE).
  if (responseCode !== null && responseCode >= 500 && responseCode < 600) {
    return { category: "REJECTED", code: `SMTP_${responseCode}`, retryable: false, ambiguous: false };
  }
  if (responseCode !== null && responseCode >= 400 && responseCode < 500) {
    return { category: "TEMPORARY", code: `SMTP_${responseCode}`, retryable: true, ambiguous: false };
  }
  if (REJECTED_CODES.has(code)) return { category: "REJECTED", code, retryable: false, ambiguous: false };
  if (TIMEOUT_CODES.has(code)) return { category: "TIMEOUT", code, retryable: true, ambiguous: true };
  if (AMBIGUOUS_CODES.has(code)) return { category: "AMBIGUOUS", code, retryable: true, ambiguous: true };
  if (TEMPORARY_CODES.has(code)) return { category: "TEMPORARY", code, retryable: true, ambiguous: false };
  if (CONFIGURATION_CODES.has(code)) return { category: "CONFIGURATION", code, retryable: true, ambiguous: false };
  if (PERMANENT_CODES.has(code)) return { category: "PERMANENT", code, retryable: false, ambiguous: false };
  // Unknown: retried (bounded by maxAttempts), and treated as possibly sent.
  return { category: "AMBIGUOUS", code: code || "UNKNOWN_ERROR", retryable: true, ambiguous: true };
}

/**
 * A provider's positive answer: an object (Sender.net { messageId } or the
 * SMTP transport's info) and, when the provider lists accepted recipients,
 * at least one. `undefined` = the mailer skipped sending (no provider configured).
 */
export function isProviderAcceptance(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const accepted = (result as { accepted?: unknown }).accepted;
  return !Array.isArray(accepted) || accepted.length > 0;
}

class SendTimeoutError extends Error {
  readonly code = "SEND_TIMEOUT";
  constructor(ms: number) {
    super(`The email service did not answer within ${Math.round(ms / 1000)}s.`);
    this.name = "SendTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SendTimeoutError(ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function log(event: string, fields: Record<string, string | number | boolean | null | undefined>) {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`);
  console.log(`[EMAIL_DELIVERY] ${event}${lines.length ? `\n${lines.join("\n")}` : ""}`);
}

type Db = Prisma.TransactionClient | typeof prisma;

// ---- Queueing ----------------------------------------------------------------

export type WelcomeEmailToQueue = {
  studentId: string;
  teacherId: string;
  recipientEmail: string;
  temporaryPassword: string;
  passwordHash: string;
  initiatedBy: EmailDeliveryInitiator;
  importBatchId?: string | null;
};

const KEY_MISSING_MESSAGE =
  "Not queued: the server's email encryption key (EMAIL_PAYLOAD_ENCRYPTION_KEY) is not configured. Once it is, use Resend Login Details.";

let keyMissingLogged = false;

/**
 * Queues one welcome email per student. MUST be called with the transaction
 * that creates the students (outbox): no row without an account, no account
 * without a row. Returns the queued row ids (empty when encryption is not
 * configured: then the rows are recorded as FAILED, the account is kept, and
 * the teacher can send new login details once the key is set).
 */
export async function queueStudentWelcomeEmails(
  db: Db,
  emails: readonly WelcomeEmailToQueue[],
  options: { now?: Date; env?: NodeJS.ProcessEnv } = {}
): Promise<{ queued: number; notQueued: number }> {
  if (emails.length === 0) return { queued: 0, notQueued: 0 };
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const config = emailDeliveryConfig(env);
  const encryption = isEmailPayloadEncryptionConfigured(env);

  if (!encryption && !keyMissingLogged) {
    keyMissingLogged = true;
    console.error("[EMAIL_DELIVERY] EMAIL_PAYLOAD_ENCRYPTION_KEY is not configured: student credential emails cannot be queued.");
  }

  const rows = emails.map((email) => {
    const id = crypto.randomUUID();
    const base = {
      id,
      emailType: EmailDeliveryType.STUDENT_WELCOME,
      studentId: email.studentId,
      teacherId: email.teacherId,
      initiatedBy: email.initiatedBy,
      importBatchId: email.importBatchId ?? null,
      recipientEmail: email.recipientEmail.trim(),
      idempotencyKey: `student-welcome:${email.studentId}`,
      attemptCount: 0,
      lastOutcomeAmbiguous: false,
      maxAttempts: config.maxAttempts,
      credentialFingerprint: passwordHashFingerprint(email.passwordHash),
      createdAt: now,
    };
    if (!encryption) {
      return {
        ...base,
        status: EmailDeliveryStatus.FAILED,
        lastErrorCode: "EMAIL_PAYLOAD_KEY_MISSING",
        lastErrorMessage: KEY_MISSING_MESSAGE,
      };
    }
    return {
      ...base,
      status: EmailDeliveryStatus.PENDING,
      nextRetryAt: now,
      encryptedPayload: encryptEmailPayload({ temporaryPassword: email.temporaryPassword }, id, env),
      payloadExpiresAt: new Date(now.getTime() + config.payloadRetentionMs),
    };
  });

  await db.emailDelivery.createMany({ data: rows });
  return encryption ? { queued: rows.length, notQueued: 0 } : { queued: 0, notQueued: rows.length };
}

export type CredentialResendToQueue = {
  studentId: string;
  teacherId: string;
  recipientEmail: string;
  temporaryPassword: string;
  passwordHash: string;
  currentPasswordHash: string | null;
  currentSessionVersion: number;
};

/** Throws EmailPayloadKeyError (nothing written) when encryption is not configured; P2002 when a resend is already open. */
export async function createCredentialResendDelivery(
  input: CredentialResendToQueue,
  options: { now?: Date; env?: NodeJS.ProcessEnv } = {}
): Promise<{ id: string }> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const config = emailDeliveryConfig(env);
  const id = crypto.randomUUID();
  const encryptedPayload = encryptEmailPayload({ temporaryPassword: input.temporaryPassword }, id, env);

  await prisma.emailDelivery.create({
    data: {
      id,
      emailType: EmailDeliveryType.STUDENT_CREDENTIAL_RESEND,
      status: EmailDeliveryStatus.PENDING,
      studentId: input.studentId,
      teacherId: input.teacherId,
      initiatedBy: EMAIL_DELIVERY_INITIATORS.TEACHER_RESEND,
      recipientEmail: input.recipientEmail.trim(),
      idempotencyKey: `student-credential-resend:${input.studentId}:${id}`,
      attemptCount: 0,
      lastOutcomeAmbiguous: false,
      maxAttempts: config.maxAttempts,
      nextRetryAt: now,
      encryptedPayload,
      payloadExpiresAt: new Date(now.getTime() + config.payloadRetentionMs),
      credentialFingerprint: passwordHashFingerprint(input.passwordHash),
      basePasswordFingerprint: passwordHashFingerprint(input.currentPasswordHash),
      baseSessionVersion: input.currentSessionVersion,
      pendingPasswordHash: input.passwordHash,
      activeOperationKey: resendOperationKey(input.studentId),
      createdAt: now,
    },
    select: { id: true },
  });
  return { id };
}

export function resendOperationKey(studentId: string) {
  return `resend:${studentId}`;
}

// ---- Processing --------------------------------------------------------------

export type SendCredentialEmail = (input: {
  to: string;
  registrationNumber: string;
  temporaryPassword: string;
  loginUrl: string;
}) => Promise<unknown>;

export type ProcessOptions = {
  now?: () => Date;
  batchSize?: number;
  concurrency?: number;
  env?: NodeJS.ProcessEnv;
  send?: SendCredentialEmail;
  /** Checked between records: true stops claiming more (graceful shutdown). */
  shouldStop?: () => boolean;
};

export type ProcessReport = {
  claimed: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  activated: number;
  activationFailed: number;
  payloadsExpired: number;
};

const LEASE_FIELDS_CLEARED = { leaseToken: null, processingStartedAt: null, processingLeaseExpiresAt: null } as const;

const deliverySelect = {
  id: true,
  emailType: true,
  status: true,
  studentId: true,
  teacherId: true,
  attemptCount: true,
  maxAttempts: true,
  encryptedPayload: true,
  payloadExpiresAt: true,
  credentialFingerprint: true,
  basePasswordFingerprint: true,
  baseSessionVersion: true,
  pendingPasswordHash: true,
  leaseToken: true,
} as const;

type ClaimedDelivery = { id: string; leaseToken: string };

/** Atomically claims due rows (and rows whose lease expired). */
export async function claimDueEmailDeliveries(limit: number, now: Date, config: EmailDeliveryConfig): Promise<ClaimedDelivery[]> {
  const candidates = await prisma.emailDelivery.findMany({
    where: {
      OR: [
        { status: EmailDeliveryStatus.PENDING, nextRetryAt: { lte: now } },
        { status: EmailDeliveryStatus.PROCESSING, processingLeaseExpiresAt: { lt: now } },
      ],
    },
    select: { id: true, status: true, leaseToken: true, attemptCount: true, maxAttempts: true, emailType: true },
    orderBy: { nextRetryAt: "asc" },
    take: Math.max(limit * 3, limit),
  });

  const claimed: ClaimedDelivery[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= limit) break;
    const leaseToken = crypto.randomUUID();
    const claimData = {
      status: EmailDeliveryStatus.PROCESSING,
      leaseToken,
      processingStartedAt: now,
      processingLeaseExpiresAt: new Date(now.getTime() + config.leaseMs),
      lastAttemptAt: now,
      attemptCount: { increment: 1 },
    };

    if (candidate.status === EmailDeliveryStatus.PROCESSING) {
      // A worker died (or lost its lease) mid-attempt: the email MAY have been sent.
      const fence = { id: candidate.id, status: EmailDeliveryStatus.PROCESSING, leaseToken: candidate.leaseToken, processingLeaseExpiresAt: { lt: now } };
      if (candidate.attemptCount >= candidate.maxAttempts) {
        await prisma.emailDelivery.updateMany({
          where: fence,
          data: {
            status: EmailDeliveryStatus.FAILED,
            ...LEASE_FIELDS_CLEARED,
            nextRetryAt: null,
            lastErrorCode: "LEASE_EXPIRED",
            lastErrorMessage: "The last attempt was interrupted (worker stopped); its outcome is unknown.",
            lastOutcomeAmbiguous: true,
            activeOperationKey: null,
          },
        });
        log("lease expired, attempts exhausted", { id: candidate.id });
        continue;
      }
      const result = await prisma.emailDelivery.updateMany({
        where: fence,
        data: { ...claimData, lastErrorCode: "LEASE_EXPIRED", lastErrorMessage: "The previous attempt was interrupted; its outcome is unknown.", lastOutcomeAmbiguous: true },
      });
      if (result.count === 1) {
        log("recovered expired lease", { id: candidate.id });
        claimed.push({ id: candidate.id, leaseToken });
      }
      continue;
    }

    const result = await prisma.emailDelivery.updateMany({
      where: { id: candidate.id, status: EmailDeliveryStatus.PENDING, nextRetryAt: { lte: now } },
      data: claimData,
    });
    if (result.count === 1) claimed.push({ id: candidate.id, leaseToken });
  }
  return claimed;
}

type AttemptOutcome = "SENT" | "RETRY" | "FAILED" | "LEASE_LOST";

/** Writes fenced by the lease token: a worker that lost its lease changes nothing. */
async function finishAttempt(claim: ClaimedDelivery, data: Prisma.EmailDeliveryUpdateManyMutationInput): Promise<boolean> {
  const result = await prisma.emailDelivery.updateMany({
    where: { id: claim.id, leaseToken: claim.leaseToken, status: EmailDeliveryStatus.PROCESSING },
    data: { ...LEASE_FIELDS_CLEARED, ...data },
  });
  if (result.count !== 1) log("lease lost before the attempt finished", { id: claim.id });
  return result.count === 1;
}

/** Terminal, and the credentials must not be sent any more. */
function terminalNoCredentials(code: string, message: string): Prisma.EmailDeliveryUpdateManyMutationInput {
  return {
    status: EmailDeliveryStatus.FAILED,
    nextRetryAt: null,
    lastErrorCode: code,
    lastErrorMessage: message,
    lastOutcomeAmbiguous: false,
    encryptedPayload: null,
    pendingPasswordHash: null,
    activeOperationKey: null,
  };
}

async function processClaimed(claim: ClaimedDelivery, nowFn: () => Date, config: EmailDeliveryConfig, env: NodeJS.ProcessEnv, send: SendCredentialEmail): Promise<AttemptOutcome> {
  const row = await prisma.emailDelivery.findFirst({ where: { id: claim.id, leaseToken: claim.leaseToken }, select: deliverySelect });
  if (!row) return "LEASE_LOST";
  const isResend = row.emailType === EmailDeliveryType.STUDENT_CREDENTIAL_RESEND;

  const student = await prisma.student.findUnique({
    where: { id: row.studentId },
    select: { id: true, status: true, email: true, registrationNumber: true, password: true, sessionVersion: true },
  });
  const recipient = student?.email?.trim() ?? "";
  const registrationNumber = student?.registrationNumber?.trim() ?? "";

  if (!student || student.status === 2 || !registrationNumber) {
    await finishAttempt(claim, terminalNoCredentials("STUDENT_UNAVAILABLE", "The student account no longer exists or has no registration number."));
    return "FAILED";
  }
  if (!recipient) {
    // Retryable by the teacher after adding an address (the credentials stay valid).
    await finishAttempt(claim, {
      status: EmailDeliveryStatus.FAILED,
      nextRetryAt: null,
      lastErrorCode: "STUDENT_EMAIL_MISSING",
      lastErrorMessage: "The student has no email address. Add one, then retry.",
      lastOutcomeAmbiguous: false,
      activeOperationKey: null,
    });
    return "FAILED";
  }

  const currentFingerprint = passwordHashFingerprint(student.password);
  if (!isResend && currentFingerprint !== row.credentialFingerprint) {
    await finishAttempt(claim, terminalNoCredentials("CREDENTIALS_SUPERSEDED", "Not sent: the student's password has changed since this email was queued (the emailed password would not work)."));
    return "FAILED";
  }
  if (isResend && !row.pendingPasswordHash) {
    await finishAttempt(claim, terminalNoCredentials("CREDENTIALS_EXPIRED", "The new password of this request is no longer available. Use Resend Login Details."));
    return "FAILED";
  }
  if (isResend && (currentFingerprint !== row.basePasswordFingerprint || student.sessionVersion !== row.baseSessionVersion)) {
    await finishAttempt(claim, terminalNoCredentials("ACCOUNT_CHANGED", "Not sent: the student's password or sessions changed after the request. The current password still works; send new login details again if needed."));
    return "FAILED";
  }

  const now = nowFn();
  if (!row.encryptedPayload || (row.payloadExpiresAt && row.payloadExpiresAt.getTime() <= now.getTime())) {
    await finishAttempt(claim, terminalNoCredentials("CREDENTIALS_EXPIRED", "The queued credentials expired before they could be sent. Use Resend Login Details."));
    return "FAILED";
  }

  let temporaryPassword: string;
  try {
    temporaryPassword = decryptEmailPayload(row.encryptedPayload, row.id, env).temporaryPassword;
  } catch (error) {
    if (error instanceof EmailPayloadKeyError) {
      return scheduleFailure(claim, row, { category: "CONFIGURATION", code: error.code, retryable: true, ambiguous: false }, "The server's email encryption key is not configured.", nowFn(), config);
    }
    const code = error instanceof EmailPayloadDecryptError ? error.code : "EMAIL_PAYLOAD_UNREADABLE";
    await finishAttempt(claim, terminalNoCredentials(code, "The queued credentials could not be decrypted (the encryption key changed?). Use Resend Login Details."));
    return "FAILED";
  }

  // Recipient used by THIS attempt (history shows the address actually tried).
  await prisma.emailDelivery.updateMany({ where: { id: claim.id, leaseToken: claim.leaseToken }, data: { recipientEmail: recipient } });

  let result: unknown;
  try {
    result = await withTimeout(Promise.resolve().then(() => send({ to: recipient, registrationNumber, temporaryPassword, loginUrl: buildStudentLoginLink() })), config.sendTimeoutMs);
  } catch (error) {
    const classified = classifyEmailFailure(error);
    const message = sanitizeEmailErrorMessage((error as { message?: unknown } | null)?.message, [temporaryPassword, recipient]);
    return scheduleFailure(claim, row, classified, message, nowFn(), config);
  }

  // Only a positive answer from a provider counts. The mailer returns nothing
  // when it SKIPS sending (development without SMTP / Sender.net): that is a
  // configuration failure, never SENT, and a resend's password is not activated.
  if (!isProviderAcceptance(result)) {
    log("email provider not configured: nothing was sent", { id: row.id });
    return scheduleFailure(
      claim,
      row,
      { category: "CONFIGURATION", code: "EMAIL_NOT_CONFIGURED", retryable: true, ambiguous: false },
      "No email provider is configured (SMTP or Sender.net), so nothing was sent. The student's current password is unchanged.",
      nowFn(),
      config
    );
  }

  const messageId = (result as { messageId?: unknown } | null | undefined)?.messageId;
  const sentAt = nowFn();
  const accepted = await finishAttempt(claim, {
    status: EmailDeliveryStatus.SENT,
    sentAt,
    nextRetryAt: null,
    providerMessageId: typeof messageId === "string" && messageId ? messageId.slice(0, 256) : null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastOutcomeAmbiguous: false,
    encryptedPayload: null,
    payloadExpiresAt: null,
  });
  log("accepted by the email provider", { id: row.id, type: row.emailType, attempt: row.attemptCount });
  if (accepted && isResend) {
    await activateCredentialResend(row.id, { now: nowFn });
  }
  return accepted ? "SENT" : "LEASE_LOST";
}

async function scheduleFailure(
  claim: ClaimedDelivery,
  row: { id: string; attemptCount: number; maxAttempts: number; emailType: EmailDeliveryType },
  failure: ClassifiedEmailFailure,
  message: string,
  now: Date,
  config: EmailDeliveryConfig
): Promise<AttemptOutcome> {
  const retry = failure.retryable && row.attemptCount < row.maxAttempts;
  const common = {
    lastErrorCode: failure.code,
    lastErrorMessage: message || failure.category,
    lastOutcomeAmbiguous: failure.ambiguous,
  };
  if (retry) {
    await finishAttempt(claim, { ...common, status: EmailDeliveryStatus.PENDING, nextRetryAt: new Date(now.getTime() + retryDelayMs(row.attemptCount, config)) });
    log("attempt failed, retry scheduled", { id: row.id, code: failure.code, category: failure.category, attempt: row.attemptCount });
    return "RETRY";
  }
  // Ciphertext kept until payloadExpiresAt: the teacher may fix the cause and retry.
  await finishAttempt(claim, { ...common, status: EmailDeliveryStatus.FAILED, nextRetryAt: null, activeOperationKey: null });
  log("attempt failed, no automatic retry", { id: row.id, code: failure.code, category: failure.category, attempt: row.attemptCount });
  return "FAILED";
}

class ActivationRace extends Error {}

export type ActivationOutcome = "ACTIVATED" | "ALREADY_ACTIVE" | "ACCOUNT_CHANGED" | "STUDENT_UNAVAILABLE" | "NOT_APPLICABLE" | "RETRY_LATER";

/**
 * Makes an ACCEPTED resend's password the student's password (idempotent;
 * safe to run concurrently and repeatedly). Never throws.
 */
export async function activateCredentialResend(deliveryId: string, options: { now?: () => Date } = {}): Promise<ActivationOutcome> {
  const nowFn = options.now ?? (() => new Date());
  try {
    const row = await prisma.emailDelivery.findFirst({
      where: {
        id: deliveryId,
        emailType: EmailDeliveryType.STUDENT_CREDENTIAL_RESEND,
        status: EmailDeliveryStatus.SENT,
        activatedAt: null,
        activationErrorCode: null,
        pendingPasswordHash: { not: null },
      },
      select: deliverySelect,
    });
    if (!row || !row.pendingPasswordHash) return "NOT_APPLICABLE";
    const pendingHash = row.pendingPasswordHash;

    const notActivated = (code: string) =>
      prisma.emailDelivery.updateMany({
        where: { id: row.id, activatedAt: null, activationErrorCode: null },
        data: { activationErrorCode: code, pendingPasswordHash: null, activeOperationKey: null },
      });

    const student = await prisma.student.findUnique({
      where: { id: row.studentId },
      select: { id: true, status: true, password: true, sessionVersion: true, registrationNumber: true },
    });
    if (!student || student.status === 2) {
      await notActivated("STUDENT_UNAVAILABLE");
      return "STUDENT_UNAVAILABLE";
    }
    const current = passwordHashFingerprint(student.password);
    if (current === row.credentialFingerprint) {
      await prisma.emailDelivery.updateMany({
        where: { id: row.id, activatedAt: null, activationErrorCode: null },
        data: { activatedAt: nowFn(), pendingPasswordHash: null, activeOperationKey: null },
      });
      return "ALREADY_ACTIVE";
    }
    if (current !== row.basePasswordFingerprint || student.sessionVersion !== row.baseSessionVersion) {
      await notActivated("ACCOUNT_CHANGED");
      log("resend accepted but NOT activated: the account changed", { id: row.id });
      return "ACCOUNT_CHANGED";
    }

    const now = nowFn();
    const superseded = await prisma.emailDelivery.findMany({
      where: {
        studentId: row.studentId,
        id: { not: row.id },
        OR: [{ status: EmailDeliveryStatus.PENDING }, { status: EmailDeliveryStatus.FAILED, encryptedPayload: { not: null } }],
      },
      select: { id: true, status: true, lastErrorCode: true },
    });

    await prisma.$transaction(async (tx) => {
      const changed = await tx.student.updateMany({
        where: { id: student.id, password: student.password, sessionVersion: student.sessionVersion, status: student.status },
        data: { password: pendingHash, sessionVersion: { increment: 1 } },
      });
      if (changed.count !== 1) throw new ActivationRace();

      await tx.passwordResetToken.updateMany({
        where: { role: "STUDENT", userId: student.id, usedAt: null },
        data: { usedAt: now },
      });

      const marked = await tx.emailDelivery.updateMany({
        where: { id: row.id, activatedAt: null, activationErrorCode: null, status: EmailDeliveryStatus.SENT },
        data: { activatedAt: now, pendingPasswordHash: null, activeOperationKey: null },
      });
      if (marked.count !== 1) throw new ActivationRace();

      // Older open credential emails would now carry a password that no longer works.
      for (const other of superseded) {
        await tx.emailDelivery.updateMany({
          where: { id: other.id, status: other.status },
          data: {
            status: EmailDeliveryStatus.FAILED,
            nextRetryAt: null,
            lastErrorCode: "CREDENTIALS_SUPERSEDED",
            lastErrorMessage: `Replaced by newer login details${other.lastErrorCode ? ` (previous error: ${other.lastErrorCode})` : ""}.`,
            encryptedPayload: null,
            pendingPasswordHash: null,
            activeOperationKey: null,
          },
        });
      }
    });

    try {
      if (student.registrationNumber) studentLoginRateLimiter().clearRegistrationFailures(student.registrationNumber);
    } catch {
      // In-memory only.
    }
    log("resend activated: new password active, previous password and sessions ended", { id: row.id });
    return "ACTIVATED";
  } catch (error) {
    // Database error or a concurrent change: the row stays "accepted, activation pending"; the next tick re-evaluates.
    log("resend activation deferred", { id: deliveryId, reason: error instanceof ActivationRace ? "concurrent change" : error instanceof Error ? error.name : "error" });
    return "RETRY_LATER";
  }
}

/** Every accepted resend whose activation is still pending (crash / database error after acceptance). */
async function activatePendingResends(nowFn: () => Date, report: ProcessReport) {
  const pending = await prisma.emailDelivery.findMany({
    where: {
      emailType: EmailDeliveryType.STUDENT_CREDENTIAL_RESEND,
      status: EmailDeliveryStatus.SENT,
      activatedAt: null,
      activationErrorCode: null,
      pendingPasswordHash: { not: null },
    },
    select: { id: true },
    take: 50,
  });
  for (const { id } of pending) {
    const outcome = await activateCredentialResend(id, { now: nowFn });
    if (outcome === "ACTIVATED" || outcome === "ALREADY_ACTIVE") report.activated += 1;
    else if (outcome === "ACCOUNT_CHANGED" || outcome === "STUDENT_UNAVAILABLE") report.activationFailed += 1;
  }
}

/** Ciphertexts kept for a manual retry are removed once their retention ends. */
async function expireRetainedPayloads(now: Date): Promise<number> {
  const result = await prisma.emailDelivery.updateMany({
    where: { status: EmailDeliveryStatus.FAILED, encryptedPayload: { not: null }, payloadExpiresAt: { lte: now } },
    data: { encryptedPayload: null, pendingPasswordHash: null },
  });
  return result.count;
}

/**
 * One worker pass: claim up to batchSize due rows, process them with bounded
 * concurrency, then finish pending resend activations and expire retained
 * ciphertexts. Never throws (errors are logged; rows are recovered by lease).
 */
export async function processEmailDeliveries(options: ProcessOptions = {}): Promise<ProcessReport> {
  const env = options.env ?? process.env;
  const config = emailDeliveryConfig(env);
  const nowFn = options.now ?? (() => new Date());
  const send = options.send ?? ((input) => sendStudentWelcomeCredentialsEmail(input));
  const batchSize = Math.max(1, options.batchSize ?? 10);
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const report: ProcessReport = { claimed: 0, sent: 0, retryScheduled: 0, failed: 0, activated: 0, activationFailed: 0, payloadsExpired: 0 };

  try {
    if (!options.shouldStop?.()) {
      const claims = await claimDueEmailDeliveries(batchSize, nowFn(), config);
      report.claimed = claims.length;
      let next = 0;
      const lane = async () => {
        for (;;) {
          if (options.shouldStop?.()) return; // unclaimed work waits; claimed rows are recovered by lease
          const claim = claims[next];
          next += 1;
          if (!claim) return;
          try {
            const outcome = await processClaimed(claim, nowFn, config, env, send);
            if (outcome === "SENT") report.sent += 1;
            else if (outcome === "RETRY") report.retryScheduled += 1;
            else if (outcome === "FAILED") report.failed += 1;
          } catch (error) {
            // Database error mid-attempt: the lease expires and the row is recovered.
            log("attempt aborted", { id: claim.id, reason: error instanceof Error ? error.name : "error" });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, claims.length) }, lane));
    }
    await activatePendingResends(nowFn, report);
    report.payloadsExpired = await expireRetainedPayloads(nowFn());
  } catch (error) {
    log("worker pass failed", { reason: error instanceof Error ? error.name : "error" });
  }
  return report;
}

// ---- Teacher-facing history and manual retry ------------------------------------

/** Error codes after which the SAME credentials must never be sent again. */
const NOT_RETRYABLE_CODES = new Set(["CREDENTIALS_SUPERSEDED", "ACCOUNT_CHANGED", "STUDENT_UNAVAILABLE", "CREDENTIALS_EXPIRED", "EMAIL_PAYLOAD_UNREADABLE", "EMAIL_PAYLOAD_KEY_MISSING"]);

type RetryCheckRow = { status: EmailDeliveryStatus; encryptedPayload: string | null; payloadExpiresAt: Date | null; lastErrorCode: string | null };

export function manualRetryBlock(row: RetryCheckRow, now: Date): string | null {
  if (row.status !== EmailDeliveryStatus.FAILED) return "NOT_FAILED";
  if (row.lastErrorCode && NOT_RETRYABLE_CODES.has(row.lastErrorCode)) return "CREDENTIALS_UNUSABLE";
  if (!row.encryptedPayload || !row.payloadExpiresAt || row.payloadExpiresAt.getTime() <= now.getTime()) return "CREDENTIALS_UNUSABLE";
  return null;
}

export type EmailDeliveryDisplayStatus = "QUEUED" | "PROCESSING" | "RETRYING" | "ACCEPTED" | "FAILED";

export type EmailDeliveryView = {
  id: string;
  emailType: EmailDeliveryType;
  status: EmailDeliveryStatus;
  displayStatus: EmailDeliveryDisplayStatus;
  student: { id: string; name: string; registrationNumber: string | null };
  recipientEmail: string;
  initiatedBy: string;
  importBatchId: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  sentAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastOutcomeAmbiguous: boolean;
  /** Resend only: whether the emailed password is the active one. */
  activation: null | { state: "PENDING" | "ACTIVE" | "NOT_ACTIVATED"; code: string | null };
  canRetry: boolean;
  retryBlockedReason: string | null;
  createdAt: string;
};

export type EmailDeliverySummary = { total: number; queued: number; processing: number; sent: number; failed: number };

const STATUS_FILTERS = ["PENDING", "PROCESSING", "SENT", "FAILED"] as const;

export function parseEmailDeliveryStatusFilter(value: string | null): EmailDeliveryStatus | null {
  return value && (STATUS_FILTERS as readonly string[]).includes(value) ? (value as EmailDeliveryStatus) : null;
}

function displayStatus(status: EmailDeliveryStatus, attemptCount: number): EmailDeliveryDisplayStatus {
  if (status === EmailDeliveryStatus.SENT) return "ACCEPTED";
  if (status === EmailDeliveryStatus.FAILED) return "FAILED";
  if (status === EmailDeliveryStatus.PROCESSING) return "PROCESSING";
  return attemptCount > 0 ? "RETRYING" : "QUEUED";
}

/** The signed-in teacher's own records only (teacherId comes from the session). */
export async function listEmailDeliveriesForTeacher(input: {
  teacherId: string;
  skip: number;
  take: number;
  status?: EmailDeliveryStatus | null;
  studentId?: string | null;
  importBatchId?: string | null;
  deliveryId?: string | null;
  now?: Date;
}): Promise<{ items: EmailDeliveryView[]; total: number; summary: EmailDeliverySummary }> {
  const now = input.now ?? new Date();
  const scope: Prisma.EmailDeliveryWhereInput = {
    teacherId: input.teacherId,
    ...(input.studentId ? { studentId: input.studentId } : {}),
    ...(input.importBatchId ? { importBatchId: input.importBatchId } : {}),
    ...(input.deliveryId ? { id: input.deliveryId } : {}),
  };
  const where: Prisma.EmailDeliveryWhereInput = { ...scope, ...(input.status ? { status: input.status } : {}) };

  const [total, rows, queued, processing, sent, failed] = await Promise.all([
    prisma.emailDelivery.count({ where }),
    prisma.emailDelivery.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: input.skip,
      take: input.take,
      select: {
        id: true,
        emailType: true,
        status: true,
        studentId: true,
        recipientEmail: true,
        initiatedBy: true,
        importBatchId: true,
        attemptCount: true,
        maxAttempts: true,
        lastAttemptAt: true,
        nextRetryAt: true,
        sentAt: true,
        lastErrorCode: true,
        lastErrorMessage: true,
        lastOutcomeAmbiguous: true,
        activatedAt: true,
        activationErrorCode: true,
        encryptedPayload: true,
        payloadExpiresAt: true,
        createdAt: true,
      },
    }),
    prisma.emailDelivery.count({ where: { ...scope, status: EmailDeliveryStatus.PENDING } }),
    prisma.emailDelivery.count({ where: { ...scope, status: EmailDeliveryStatus.PROCESSING } }),
    prisma.emailDelivery.count({ where: { ...scope, status: EmailDeliveryStatus.SENT } }),
    prisma.emailDelivery.count({ where: { ...scope, status: EmailDeliveryStatus.FAILED } }),
  ]);

  const studentIds = Array.from(new Set(rows.map((r) => r.studentId)));
  const students = studentIds.length
    ? await prisma.student.findMany({ where: { id: { in: studentIds }, teacherId: input.teacherId }, select: { id: true, name: true, registrationNumber: true } })
    : [];
  const byId = new Map(students.map((s) => [s.id, s]));
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  const items = rows.map((r): EmailDeliveryView => {
    const block = manualRetryBlock(r, now);
    const isResend = r.emailType === EmailDeliveryType.STUDENT_CREDENTIAL_RESEND;
    const student = byId.get(r.studentId);
    return {
      id: r.id,
      emailType: r.emailType,
      status: r.status,
      displayStatus: displayStatus(r.status, r.attemptCount),
      student: { id: r.studentId, name: student?.name ?? "Unknown student", registrationNumber: student?.registrationNumber ?? null },
      recipientEmail: r.recipientEmail,
      initiatedBy: r.initiatedBy,
      importBatchId: r.importBatchId,
      attemptCount: r.attemptCount,
      maxAttempts: r.maxAttempts,
      lastAttemptAt: iso(r.lastAttemptAt),
      nextRetryAt: r.status === EmailDeliveryStatus.PENDING ? iso(r.nextRetryAt) : null,
      sentAt: iso(r.sentAt),
      lastErrorCode: r.lastErrorCode,
      lastErrorMessage: r.lastErrorMessage,
      lastOutcomeAmbiguous: r.lastOutcomeAmbiguous,
      activation: isResend
        ? r.activatedAt
          ? { state: "ACTIVE", code: null }
          : r.activationErrorCode
          ? { state: "NOT_ACTIVATED", code: r.activationErrorCode }
          : r.status === EmailDeliveryStatus.SENT
          ? { state: "PENDING", code: null }
          : { state: "NOT_ACTIVATED", code: null }
        : null,
      canRetry: block === null,
      retryBlockedReason: block,
      createdAt: r.createdAt.toISOString(),
    };
  });

  return { items, total, summary: { total: queued + processing + sent + failed, queued, processing, sent, failed } };
}

/**
 * Teacher manual retry of a FAILED email with the SAME (still valid)
 * credentials. Never generates new credentials: when they are unusable
 * (expired, superseded, account changed) the teacher is told to use Resend
 * Login Details instead.
 */
export async function retryEmailDeliveryByTeacher(input: { teacherId: string; deliveryId: string; now?: Date; env?: NodeJS.ProcessEnv }): Promise<{ id: string; status: "PENDING" }> {
  const now = input.now ?? new Date();
  const config = emailDeliveryConfig(input.env ?? process.env);
  const row = await prisma.emailDelivery.findFirst({
    where: { id: input.deliveryId, teacherId: input.teacherId },
    select: { id: true, status: true, emailType: true, studentId: true, attemptCount: true, encryptedPayload: true, payloadExpiresAt: true, lastErrorCode: true },
  });
  if (!row) throw new AppError("Email record not found.", 404, "EMAIL_DELIVERY_NOT_FOUND");

  const block = manualRetryBlock(row, now);
  if (block === "NOT_FAILED") {
    throw new AppError("This email is not in a failed state (it is queued, being sent, or already accepted).", 409, "EMAIL_RETRY_NOT_ALLOWED");
  }
  if (block === "CREDENTIALS_UNUSABLE") {
    throw new AppError(
      "These login details can no longer be sent (they expired or were replaced). Use Resend Login Details to send new ones.",
      409,
      "EMAIL_RETRY_CREDENTIALS_UNUSABLE"
    );
  }

  const isResend = row.emailType === EmailDeliveryType.STUDENT_CREDENTIAL_RESEND;
  let result: { count: number };
  try {
    result = await prisma.emailDelivery.updateMany({
      where: { id: row.id, teacherId: input.teacherId, status: EmailDeliveryStatus.FAILED, encryptedPayload: { not: null } },
      data: {
        status: EmailDeliveryStatus.PENDING,
        nextRetryAt: now,
        // History is kept: the attempt count continues; a fresh budget of automatic attempts.
        maxAttempts: row.attemptCount + config.maxAttempts,
        ...(isResend ? { activeOperationKey: resendOperationKey(row.studentId) } : {}),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("Other new login details are already being sent to this student.", 409, "RESEND_IN_PROGRESS");
    }
    throw error;
  }
  if (result.count !== 1) {
    throw new AppError("This email was already queued again.", 409, "EMAIL_RETRY_ALREADY_QUEUED");
  }
  log("manual retry queued", { id: row.id });
  return { id: row.id, status: "PENDING" };
}
