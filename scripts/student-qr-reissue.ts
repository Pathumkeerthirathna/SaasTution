/*
 * Student QR secret rotation: system reissuance of every active QR token.
 * Operator tool — see docs/student-qr-identity.md ("Secret rotation").
 *
 * Secrets come ONLY from the environment (never arguments, never files):
 *   STUDENT_QR_SECRET_OLD  the secret the application uses now
 *   STUDENT_QR_SECRET_NEW  the replacement
 *
 * Dry run (default; read-only, no locks, no writes):
 *   npm run qr:reissue
 *
 * Execute (one transaction; all-or-nothing):
 *   npm run qr:reissue -- --execute --confirm-reissue-all-student-qr --confirm-database=<database name>
 *
 * --confirm-database must equal the database name in DATABASE_URL (Prisma
 * also loads the project .env, so this proves which database is targeted).
 * Output: counts only — never a secret, token, nonce, hash or row contents.
 * Exit codes: 0 done / nothing to do, 1 refused or failed, 2 usage error.
 */

import { prisma } from "@/lib/prisma";
import {
  STUDENT_QR_REISSUE_NEW_SECRET_ENV,
  STUDENT_QR_REISSUE_OLD_SECRET_ENV,
  StudentQrReissueError,
  reissueStudentQrTokens,
  type StudentQrReissueReport,
} from "@/services/student-qr-reissue-service";

const CONFIRM_FLAG = "--confirm-reissue-all-student-qr";
const DATABASE_FLAG = "--confirm-database=";

class UsageError extends Error {}

function parseArgs(argv: string[]) {
  let execute = false;
  let confirmed = false;
  let database: string | null = null;
  for (const arg of argv) {
    if (arg === "--execute") execute = true;
    else if (arg === "--dry-run") execute = false;
    else if (arg === CONFIRM_FLAG) confirmed = true;
    else if (arg.startsWith(DATABASE_FLAG)) database = arg.slice(DATABASE_FLAG.length);
    // Never echo an unknown argument: it might be a secret pasted by mistake.
    else throw new UsageError("Unknown argument (value not shown). Secrets must be passed in the environment, not as arguments.");
  }
  return { execute, confirmed, database };
}

/** host:port/database of DATABASE_URL — never the user name or password. */
function targetDatabase(): { label: string; name: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new UsageError("DATABASE_URL is not set.");
  try {
    const url = new URL(raw);
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return { label: `${url.hostname}${url.port ? `:${url.port}` : ""}/${name}`, name };
  } catch {
    throw new UsageError("DATABASE_URL is not a valid URL.");
  }
}

function printReport(report: StudentQrReissueReport) {
  console.log(`  active QR tokens:               ${report.activeTokens}`);
  console.log(`  verify with the OLD secret:     ${report.eligible}${report.mode === "dry-run" ? " (would be reissued)" : ""}`);
  console.log(`  already verify with the NEW:    ${report.alreadyReissued}`);
  console.log(`  verify with neither:            ${report.unverifiable}`);
  if (report.mode === "execute") {
    console.log(`  reissued in this run:           ${report.reissued}`);
    console.log(`  students locked during the run: ${report.lockedStudents}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = targetDatabase();
  console.log(`Student QR reissue — ${args.execute ? "EXECUTE" : "DRY RUN (no writes)"}`);
  console.log(`  target database: ${target.label}`);

  if (args.execute) {
    if (!args.confirmed) throw new UsageError(`--execute also needs ${CONFIRM_FLAG}.`);
    if (args.database !== target.name) {
      throw new UsageError(`--execute also needs ${DATABASE_FLAG}<name> matching the DATABASE_URL database.`);
    }
  }

  const report = await reissueStudentQrTokens({
    mode: args.execute ? "execute" : "dry-run",
    oldSecretText: process.env[STUDENT_QR_REISSUE_OLD_SECRET_ENV],
    newSecretText: process.env[STUDENT_QR_REISSUE_NEW_SECRET_ENV],
    jwtSecret: process.env.JWT_SECRET,
  });
  printReport(report);

  if (report.mode === "dry-run") {
    if (report.unverifiable > 0) {
      console.log("Refused: some tokens verify with neither secret; execute would change nothing. See the docs.");
      process.exitCode = 1;
    } else if (report.eligible === 0) {
      console.log("Nothing to reissue: every active token already uses the new secret.");
    } else {
      console.log("Dry run only: nothing was changed.");
    }
  } else {
    console.log(
      report.reissued === 0
        ? "Nothing to reissue: every active token already uses the new secret."
        : "Done. Now switch the application to the new secret and run this again (catch-up)."
    );
  }
}

main()
  .catch((error) => {
    if (error instanceof UsageError) {
      console.error(`Usage error: ${error.message}`);
      process.exitCode = 2;
    } else if (error instanceof StudentQrReissueError) {
      console.error(`Refused (${error.code}): ${error.message}${error.detail ? ` ${error.detail}` : ""}`);
      process.exitCode = 1;
    } else {
      // Unexpected: name only (a message could carry row details).
      console.error(`Student QR reissue failed (${error instanceof Error ? error.name : "unknown error"}). Nothing was changed.`);
      process.exitCode = 1;
    }
  })
  .finally(() => prisma.$disconnect());
