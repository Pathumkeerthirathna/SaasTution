import { randomUUID, timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  StudentQrConfigError,
  deriveStudentQrToken,
  generateStudentQrNonce,
  hashStudentQrToken,
  loadStudentQrSecret,
  studentQrTokenHashesEqual,
} from "@/lib/student-qr-token";

/*
 * Controlled STUDENT_QR_SECRET rotation: system reissuance of every active
 * student QR token (docs/student-qr-identity.md, "Secret rotation").
 *
 * OPERATOR USE ONLY, through scripts/student-qr-reissue.ts. Never imported by
 * an API route, page, middleware or instrumentation (a test enforces it), so
 * it can never run during application startup or QR rendering.
 *
 * Every active token is classified by re-deriving it:
 *   - verifies with the OLD secret  -> eligible: revoked + replaced
 *   - verifies with the NEW secret  -> already reissued: left alone
 *   - verifies with neither         -> unverifiable: the whole run REFUSES
 *     (nothing is ever skipped silently).
 *
 * execute: ONE transaction. It first locks every Student row
 * (FOR NO KEY UPDATE, in id order) — the same lock QR issuance and
 * regeneration take — so no QR operation can run between the snapshot and the
 * commit; then revokes each eligible token as SYSTEM / SYSTEM_REISSUE and
 * inserts its SYSTEM_REISSUE replacement under the NEW secret (new row id and
 * nonce; only nonce + tokenHash stored). Any failure rolls everything back.
 * Re-running is safe: already reissued tokens are recognised by the new
 * secret, so no duplicates are created. Tokens the still-running application
 * creates with the old secret before it is switched are picked up by a
 * catch-up run.
 *
 * dry-run: the same classification inside a READ ONLY transaction (no locks,
 * no writes).
 *
 * Nothing here logs. Errors and reports carry counts and codes only — never a
 * secret, token, nonce, hash or row contents.
 */

export const STUDENT_QR_REISSUE_OLD_SECRET_ENV = "STUDENT_QR_SECRET_OLD";
export const STUDENT_QR_REISSUE_NEW_SECRET_ENV = "STUDENT_QR_SECRET_NEW";

/** Rows per revoke / insert statement inside the single transaction. */
const CHUNK_SIZE = 500;

export type StudentQrReissueErrorCode =
  | "OLD_SECRET_INVALID"
  | "NEW_SECRET_INVALID"
  | "SECRETS_IDENTICAL"
  | "UNVERIFIABLE_TOKENS"
  | "REISSUE_INCONSISTENT"
  | "REISSUE_DATABASE_ERROR";

export class StudentQrReissueError extends Error {
  readonly code: StudentQrReissueErrorCode;
  /** Safe operator detail: problem names and counts only. */
  readonly detail?: string;

  constructor(code: StudentQrReissueErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "StudentQrReissueError";
    this.code = code;
    this.detail = detail;
  }
}

export type StudentQrReissueMode = "dry-run" | "execute";

export type StudentQrReissueReport = {
  mode: StudentQrReissueMode;
  /** Active (not revoked) tokens found. */
  activeTokens: number;
  /** Active tokens that verify with the OLD secret (to be / that were reissued). */
  eligible: number;
  /** Active tokens that already verify with the NEW secret. */
  alreadyReissued: number;
  /** Active tokens that verify with neither secret (the run refuses if > 0). */
  unverifiable: number;
  /** execute only: tokens revoked and replaced in this run. */
  reissued: number;
  /** execute only: Student rows locked for the run. */
  lockedStudents: number;
};

export type StudentQrReissueOptions = {
  mode: StudentQrReissueMode;
  /** Secrets as text, read by the caller from the process environment. */
  oldSecretText: string | undefined;
  newSecretText: string | undefined;
  jwtSecret?: string | undefined;
  /** Tests only: runs inside the execute transaction, after the locks. */
  afterLockForTests?: () => Promise<void>;
};

type Tx = Prisma.TransactionClient;
type ActiveRow = { id: string; studentId: string; nonce: string; tokenHash: string; createdAt: Date };
type Classified = { eligible: ActiveRow[]; alreadyReissued: number; unverifiable: number };

// ---------------------------------------------------------------- secrets

function loadSecret(text: string | undefined, jwtSecret: string | undefined, which: "old" | "new"): Buffer {
  try {
    // Only these two variables are read; nothing else from the environment.
    return loadStudentQrSecret({ STUDENT_QR_SECRET: text, JWT_SECRET: jwtSecret } as unknown as NodeJS.ProcessEnv);
  } catch (error) {
    if (error instanceof StudentQrConfigError) {
      const env = which === "old" ? STUDENT_QR_REISSUE_OLD_SECRET_ENV : STUDENT_QR_REISSUE_NEW_SECRET_ENV;
      throw new StudentQrReissueError(
        which === "old" ? "OLD_SECRET_INVALID" : "NEW_SECRET_INVALID",
        `${env} is not a valid student QR secret.`,
        error.detail.replace("STUDENT_QR_SECRET", env)
      );
    }
    throw error;
  }
}

function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validates both secrets (T3 rules) and that they differ. */
export function loadReissueSecrets(options: Pick<StudentQrReissueOptions, "oldSecretText" | "newSecretText" | "jwtSecret">) {
  const oldKey = loadSecret(options.oldSecretText, options.jwtSecret, "old");
  const newKey = loadSecret(options.newSecretText, options.jwtSecret, "new");
  if (sameKey(oldKey, newKey) || options.oldSecretText?.trim() === options.newSecretText?.trim()) {
    throw new StudentQrReissueError("SECRETS_IDENTICAL", "The old and new student QR secrets must be different.");
  }
  return { oldKey, newKey };
}

// ---------------------------------------------------------------- classification

function verifies(secret: Buffer, row: ActiveRow): boolean {
  try {
    const hash = hashStudentQrToken(deriveStudentQrToken(secret, row.id, row.nonce));
    return studentQrTokenHashesEqual(hash, row.tokenHash);
  } catch {
    return false; // malformed row id / nonce: counts as unverifiable
  }
}

function classify(rows: ActiveRow[], oldKey: Buffer, newKey: Buffer): Classified {
  const result: Classified = { eligible: [], alreadyReissued: 0, unverifiable: 0 };
  for (const row of rows) {
    if (verifies(oldKey, row)) result.eligible.push(row);
    else if (verifies(newKey, row)) result.alreadyReissued += 1;
    else result.unverifiable += 1;
  }
  return result;
}

function activeRows(db: Tx): Promise<ActiveRow[]> {
  return db.studentQrToken.findMany({
    where: { revokedAt: null },
    select: { id: true, studentId: true, nonce: true, tokenHash: true, createdAt: true },
    orderBy: { id: "asc" },
  });
}

function refuseUnverifiable(classified: Classified) {
  if (classified.unverifiable > 0) {
    throw new StudentQrReissueError(
      "UNVERIFIABLE_TOKENS",
      `${classified.unverifiable} active QR token(s) verify with neither the old nor the new secret. Nothing was changed.`,
      "Check that STUDENT_QR_SECRET_OLD is the secret the application currently uses. See docs/student-qr-identity.md."
    );
  }
}

// ---------------------------------------------------------------- run

/**
 * Dry run or execute (see the file header). Throws StudentQrReissueError on
 * refusal; a database failure during execute rolls back completely and is
 * reported as REISSUE_DATABASE_ERROR (no row details).
 */
export async function reissueStudentQrTokens(options: StudentQrReissueOptions): Promise<StudentQrReissueReport> {
  const { oldKey, newKey } = loadReissueSecrets(options);

  if (options.mode === "dry-run") {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const rows = await activeRows(tx);
      const classified = classify(rows, oldKey, newKey);
      return {
        mode: "dry-run" as const,
        activeTokens: rows.length,
        eligible: classified.eligible.length,
        alreadyReissued: classified.alreadyReissued,
        unverifiable: classified.unverifiable,
        reissued: 0,
        lockedStudents: 0,
      };
    });
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        // Do not wait forever behind a long-running QR operation.
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '30s'");
        // The lock QR issuance / regeneration take (FOR NO KEY UPDATE), on
        // every student, in a fixed order: no QR operation can interleave.
        const [{ locked }] = await tx.$queryRaw<{ locked: number }[]>`
          SELECT count(*)::int AS "locked"
          FROM (SELECT "id" FROM "Student" ORDER BY "id" FOR NO KEY UPDATE) AS "lockedStudents"`;
        if (options.afterLockForTests) await options.afterLockForTests();

        // Read AFTER the locks: everything committed before them is visible.
        const rows = await activeRows(tx);
        const classified = classify(rows, oldKey, newKey);
        refuseUnverifiable(classified);

        // One instant for the run; never before a row's createdAt (CHECK).
        let now = new Date();
        for (const row of classified.eligible) if (row.createdAt > now) now = row.createdAt;

        let reissued = 0;
        for (let start = 0; start < classified.eligible.length; start += CHUNK_SIZE) {
          const chunk = classified.eligible.slice(start, start + CHUNK_SIZE);
          const revoked = await tx.studentQrToken.updateMany({
            where: { id: { in: chunk.map((row) => row.id) }, revokedAt: null },
            data: { revokedAt: now, revokedByRole: "SYSTEM", revokedById: null, revokedReason: "SYSTEM_REISSUE" },
          });
          if (revoked.count !== chunk.length) {
            throw new StudentQrReissueError("REISSUE_INCONSISTENT", "Active tokens changed during the run. Nothing was changed.");
          }
          const created = await tx.studentQrToken.createMany({
            data: chunk.map((row) => {
              const id = randomUUID();
              const nonce = generateStudentQrNonce();
              return {
                id,
                studentId: row.studentId,
                nonce,
                tokenHash: hashStudentQrToken(deriveStudentQrToken(newKey, id, nonce)),
                reason: "SYSTEM_REISSUE" as const,
                createdAt: now,
                createdByRole: "SYSTEM",
                createdById: null,
              };
            }),
          });
          if (created.count !== chunk.length) {
            throw new StudentQrReissueError("REISSUE_INCONSISTENT", "Not every replacement was created. Nothing was changed.");
          }
          reissued += chunk.length;
        }

        // Final check inside the transaction: every active token now verifies
        // with the new secret, and still exactly one per student.
        const after = classify(await activeRows(tx), oldKey, newKey);
        if (after.eligible.length !== 0 || after.unverifiable !== 0 || after.alreadyReissued !== rows.length) {
          throw new StudentQrReissueError("REISSUE_INCONSISTENT", "Post-reissue verification failed. Nothing was changed.");
        }

        return {
          mode: "execute" as const,
          activeTokens: rows.length,
          eligible: classified.eligible.length,
          alreadyReissued: classified.alreadyReissued,
          unverifiable: 0,
          reissued,
          lockedStudents: locked,
        };
      },
      { timeout: 10 * 60_000, maxWait: 60_000 }
    );
  } catch (error) {
    if (error instanceof StudentQrReissueError) throw error;
    // Database errors may carry row details (nonce / tokenHash): replace them.
    const code =
      error instanceof Prisma.PrismaClientKnownRequestError
        ? error.code
        : error instanceof Error
          ? error.name
          : "unknown";
    throw new StudentQrReissueError(
      "REISSUE_DATABASE_ERROR",
      `The reissue failed and was rolled back completely (${code}). Nothing was changed.`
    );
  }
}
