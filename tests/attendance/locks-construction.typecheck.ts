/*
 * Compile-time guard (checked by `npx tsc --noEmit`; never executed): only
 * runAttendanceTransaction can create AttendanceLocks. Each line below must
 * FAIL to compile; if one starts compiling, its @ts-expect-error becomes
 * unused and tsc reports an error.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { AttendanceLocks, createAttendanceLocksForTesting } from "@/lib/attendance/locks";

declare const client: PrismaClient;
declare const tx: Prisma.TransactionClient;

export function attendanceLocksConstructionGuards() {
  // @ts-expect-error The constructor is private.
  new AttendanceLocks(Symbol("AttendanceLocks") as never, tx);

  // @ts-expect-error A top-level PrismaClient (autocommit) is refused.
  new AttendanceLocks(Symbol("AttendanceLocks") as never, client);

  // @ts-expect-error The module-private token cannot be produced outside lib/attendance/locks.ts.
  AttendanceLocks.fromTransaction(Symbol("AttendanceLocks"), tx);

  // @ts-expect-error The test factory refuses a top-level PrismaClient.
  createAttendanceLocksForTesting(client);

  // Allowed: a transaction client (what the test factory exists for).
  return createAttendanceLocksForTesting(tx);
}
