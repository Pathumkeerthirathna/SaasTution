/*
 * Next.js instrumentation hook (experimental.instrumentationHook in
 * next.config.mjs): runs once when a server process starts.
 *
 * Starts the teacher-departure sweeper (lib/teacher-departure-sweep.ts) on a
 * long-running production Node server only. Not during `next build`, not in
 * the Edge runtime, and not on serverless functions (it checks itself); there
 * the students' live-updates connections run the same check instead.
 * Also starts the Recorded Lectures maintenance scheduler
 * (services/recorded-lecture-maintenance-scheduler.ts, Stage 3.6) under the
 * same conditions; it checks its own (storage configured, not serverless).
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

    // Stage 3.6: Recorded Lectures maintenance (expiry, recovery, cleanup, purge of deleted
    // recordings) and the retry of pending permanent deletions of Notes / assignments.
    // Once per process (it ignores later calls), and only where it may run
    // (canRunMaintenanceScheduler: production, not serverless, storage configured).
    const { startRecordedLectureMaintenance } = await import("./services/recorded-lecture-maintenance-scheduler");

    startRecordedLectureMaintenance();

    // Student onboarding emails (EmailDelivery outbox): the background email
    // worker, once per process. Its first pass recovers rows a previous
    // process left PROCESSING. EMAIL_WORKER_ENABLED=false disables it.
    const { startEmailDeliveryWorker } = await import("./services/email-delivery-worker");

    startEmailDeliveryWorker();
  }
}
