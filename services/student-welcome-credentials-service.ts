import bcrypt from "bcryptjs";

import { generateTemporaryStudentPassword } from "@/lib/student-temporary-password";

/*
 * Simplified student registration: the ONE credential behaviour shared by all
 * three ways a student account is created (public class registration, the
 * teacher's Add Student, bulk import) and by "Resend Login Details".
 *
 *   issueTemporaryStudentPassword(): a CSPRNG temporary password and its
 *   bcrypt hash. Only the hash is stored (Student.password), together with
 *   passwordSetupPending = true (the optional "Secure Your Account" step).
 *
 * The welcome email itself is QUEUED in the same transaction that creates the
 * account (services/student-email-delivery-service.ts queueStudentWelcomeEmails:
 * the temporary password is kept only AES-256-GCM encrypted) and sent by the
 * background email worker (services/email-delivery-worker.ts), with retries
 * and a teacher-visible delivery history. Registration never waits for it.
 *
 * Work factor: temporary passwords are hashed at cost 10 (passwords a student
 * chooses keep cost 12). The work factor protects guessable, human-chosen
 * passwords; a 69-bit random secret is infeasible to brute-force at either
 * cost, and cost 10 keeps bulk imports fast (about 4x quicker per row).
 */

export const TEMPORARY_PASSWORD_HASH_ROUNDS = 10;

export type IssuedTemporaryPassword = { temporaryPassword: string; passwordHash: string };

export async function issueTemporaryStudentPassword(): Promise<IssuedTemporaryPassword> {
  const temporaryPassword = generateTemporaryStudentPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, TEMPORARY_PASSWORD_HASH_ROUNDS);
  return { temporaryPassword, passwordHash };
}
