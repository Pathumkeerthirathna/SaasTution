import { prisma } from "@/lib/prisma";

/*
 * Authoritative time for the teacher-departure and YouTube feature lifecycle:
 * the DATABASE clock (Postgres now()), so every server process and
 * serverless instance writes and compares tab-close signals, heartbeats,
 * starts, feature generations, send times and check times on one clock.
 * Client clocks are never used.
 *
 * Each process measures its offset from the database clock (one
 * `SELECT now()`, corrected for half the round trip) at most every
 * REMEASURE_MS and applies it to its own monotonic-enough clock in between:
 * no query per call. If the database clock cannot be read, the last known
 * offset (else 0, this server's clock) is used and the failure logged.
 */

const REMEASURE_MS = 60_000;

const state = globalThis as unknown as { slServerClock?: { offsetMs: number; measuredAt: number } };

async function measure() {
  const client = prisma as unknown as { $queryRaw?: (query: TemplateStringsArray) => Promise<{ now: Date | string }[]> };

  // Only test doubles of Prisma lack it.
  if (typeof client.$queryRaw !== "function") {
    state.slServerClock = { offsetMs: state.slServerClock?.offsetMs ?? 0, measuredAt: Date.now() };
    return;
  }

  const before = Date.now();

  try {
    const rows = await client.$queryRaw`SELECT now() AS now`;
    const after = Date.now();
    const databaseNow = new Date(rows[0].now).getTime();

    if (Number.isNaN(databaseNow)) throw new Error("unreadable database time");

    state.slServerClock = { offsetMs: databaseNow - (before + after) / 2, measuredAt: after };
  } catch (error) {
    console.error("Could not read the database clock; using the last known offset:", error);
    state.slServerClock = { offsetMs: state.slServerClock?.offsetMs ?? 0, measuredAt: Date.now() };
  }
}

/** The current time on the database clock. */
export async function serverNow(): Promise<Date> {
  const known = state.slServerClock;

  if (!known || Date.now() - known.measuredAt >= REMEASURE_MS) {
    await measure();
  }

  return new Date(Date.now() + (state.slServerClock?.offsetMs ?? 0));
}

/** As serverNow, with the offset already measured (inside an operation that awaited serverNow). */
export function serverNowSync(): Date {
  return new Date(Date.now() + (state.slServerClock?.offsetMs ?? 0));
}

/** Tests: forget the measured offset. */
export function resetServerClock() {
  delete state.slServerClock;
}
