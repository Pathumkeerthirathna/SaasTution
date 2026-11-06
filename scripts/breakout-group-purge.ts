/*
 * Retries pending Group Activities purges (services/breakout-group-session-end.ts).
 *
 * When a teacher ends a session and chooses to delete its Group Activities,
 * the GROUP rows are marked status = 2 in the same transaction that ends the
 * session; their files and then the rows are removed right after. If that
 * cleanup could not finish (a file could not be removed, a database error),
 * the rows stay marked and hidden. This script finds ENDED sessions with
 * such rows and runs the same purge again: files first, rows only when every
 * file is gone. Safe to run any number of times; it never touches an active
 * session, INDIVIDUAL activities, or anything not marked for deletion.
 *
 * Usage (operator, against the configured database):
 *   npm run breakout:group-purge
 */

import { prisma } from "@/lib/prisma";
import { purgeGroupActivitiesSafely, sessionsWithPendingGroupPurge } from "@/services/breakout-group-session-end";

async function main() {
  const sessionIds = await sessionsWithPendingGroupPurge();
  if (sessionIds.length === 0) {
    console.log("No pending Group Activities purge.");
    return;
  }
  let pending = 0;
  for (const sessionId of sessionIds) {
    const result = await purgeGroupActivitiesSafely(sessionId);
    console.log(`${sessionId}: ${result.status} (assignments ${result.assignments}, quizzes ${result.quizzes})`);
    if (result.status === "pending") pending += 1;
  }
  if (pending > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Group Activities purge failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
