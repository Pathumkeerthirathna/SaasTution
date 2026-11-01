/*
 * Next.js instrumentation hook (experimental.instrumentationHook in
 * next.config.mjs): runs once when a server process starts.
 *
 * Starts the teacher-departure sweeper (lib/teacher-departure-sweep.ts) on a
 * long-running production Node server only. Not during `next build`, not in
 * the Edge runtime, and not on serverless functions (it checks itself); there
 * the students' live-updates connections run the same check instead.
 *
 * Next.js compiles this file for the Node.js AND the Edge runtime, with
 * process.env.NEXT_RUNTIME and process.env.NODE_ENV replaced by literals. The
 * import must stay inside this `if`: its condition then becomes a constant
 * and webpack drops the branch, so the Edge build (and the dev server) never
 * resolves the sweeper's Node-only imports (Prisma, the YouTube token
 * encryption's `crypto`). An early `return` instead would leave the import in
 * every build.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return;
    }

    const { startTeacherDepartureSweeper } = await import("./lib/teacher-departure-sweep");

    startTeacherDepartureSweeper();
  }
}
