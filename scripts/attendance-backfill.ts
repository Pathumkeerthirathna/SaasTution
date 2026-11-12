/*
 * Historical attendance backfill — operator entry point.
 * See scripts/attendance-backfill-cli.ts for usage and
 * docs/lecture-attendance.md ("Historical backfill").
 *
 * Dry run is the default. Execute needs ALL of:
 *   --execute --confirm-backfill-historical-attendance --confirm-database=<database name>
 * and exactly one scope: --lecture=<id> | --class=<id> | --before=<ISO instant with offset>.
 *
 * Output: lecture ids and counts only — never DATABASE_URL credentials,
 * secrets, student names or ids. Exit codes: 0 done, 1 refused / incomplete
 * / failed, 2 usage error.
 */

import { prisma } from "@/lib/prisma";
import { runAttendanceBackfillCli } from "./attendance-backfill-cli";

runAttendanceBackfillCli(process.argv.slice(2), {
  databaseUrl: process.env.DATABASE_URL,
  env: process.env,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // Unexpected: name only (a message could carry row details).
    console.error(`Attendance backfill failed (${error instanceof Error ? error.name : "unknown error"}). Re-running is safe.`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
