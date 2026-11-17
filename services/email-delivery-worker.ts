import { registerShutdownTask } from "@/lib/process-shutdown";
import { processEmailDeliveries, type ProcessReport } from "@/services/student-email-delivery-service";

/*
 * Background email worker (student onboarding emails, EmailDelivery outbox).
 *
 * Runs INSIDE the long-running Next.js Node server process (production: one
 * PM2 fork process), like the Recorded Lectures maintenance scheduler: no
 * extra service, no Redis / queue. It does not depend on any HTTP request:
 * registration only writes the outbox row (same transaction as the account)
 * and calls wakeEmailDeliveryWorker(); the email is sent by this loop.
 *
 *   - Started by instrumentation.ts at server start (production), and lazily
 *     by wakeEmailDeliveryWorker() (so the development server sends too).
 *   - Every EMAIL_WORKER_POLL_INTERVAL_SECONDS (default 15): one pass of
 *     processEmailDeliveries (claim up to EMAIL_WORKER_BATCH_SIZE due rows,
 *     EMAIL_WORKER_CONCURRENCY at a time, lease-protected; recover expired
 *     leases; finish pending resend activations; expire retained payloads).
 *   - Passes never overlap; a wake during a pass schedules one more pass.
 *   - Graceful shutdown (SIGTERM / SIGINT, through the shared coordinator
 *     lib/process-shutdown.ts, which holds Next's own exit until every
 *     registered task finished): no new claims; the running pass is awaited
 *     up to EMAIL_WORKER_SHUTDOWN_TIMEOUT_MS (default 8000). A row
 *     still being sent when the process exits stays PROCESSING and is
 *     recovered by the next process once its lease expires (its outcome is
 *     then treated as unknown: the same email may be sent twice).
 *   - EMAIL_WORKER_ENABLED=false disables it (e.g. a second process).
 *   - Never on serverless platforms (NETLIFY / AWS_LAMBDA_FUNCTION_NAME) and
 *     never in tests (NODE_ENV neither production nor development).
 */

type WorkerConfig = { pollIntervalMs: number; batchSize: number; concurrency: number; shutdownTimeoutMs: number };

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const value = Number(env[name]?.trim());
  return env[name]?.trim() && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function emailWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    pollIntervalMs: intFromEnv(env, "EMAIL_WORKER_POLL_INTERVAL_SECONDS", 15, 1, 3600) * 1000,
    batchSize: intFromEnv(env, "EMAIL_WORKER_BATCH_SIZE", 10, 1, 200),
    concurrency: intFromEnv(env, "EMAIL_WORKER_CONCURRENCY", 2, 1, 20),
    shutdownTimeoutMs: intFromEnv(env, "EMAIL_WORKER_SHUTDOWN_TIMEOUT_MS", 8000, 0, 120_000),
  };
}

export function canRunEmailDeliveryWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production" && env.NODE_ENV !== "development") return false;
  if (env.NEXT_PHASE === "phase-production-build") return false;
  if (env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME) return false;
  return env.EMAIL_WORKER_ENABLED?.trim().toLowerCase() !== "false";
}

type WorkerState = {
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<ProcessReport> | null;
  again: boolean;
  stopping: boolean;
  config: WorkerConfig;
  run: (options: { shouldStop: () => boolean }) => Promise<ProcessReport>;
  unregisterShutdown: (() => void) | null;
  lastReport: ProcessReport | null;
  lastPassAt: Date | null;
};

const holder = globalThis as unknown as { slEmailDeliveryWorker?: WorkerState };

export function isEmailDeliveryWorkerRunning(): boolean {
  return Boolean(holder.slEmailDeliveryWorker && !holder.slEmailDeliveryWorker.stopping);
}

/** For monitoring: the last pass's counts and time (no record contents). */
export function emailDeliveryWorkerStatus() {
  const state = holder.slEmailDeliveryWorker;
  return state ? { running: !state.stopping, lastPassAt: state.lastPassAt?.toISOString() ?? null, lastReport: state.lastReport } : { running: false, lastPassAt: null, lastReport: null };
}

function runPass(state: WorkerState): Promise<ProcessReport> | null {
  if (state.stopping) return null;
  if (state.running) {
    state.again = true;
    return state.running;
  }
  state.again = false;
  state.running = state
    .run({ shouldStop: () => state.stopping })
    .then((report) => {
      state.lastReport = report;
      state.lastPassAt = new Date();
      if (report.claimed >= state.config.batchSize) state.again = true; // more may be due
      if (report.claimed || report.activated || report.activationFailed) {
        console.log(
          `[EMAIL_WORKER] pass claimed=${report.claimed} sent=${report.sent} retry=${report.retryScheduled} failed=${report.failed} activated=${report.activated} activationFailed=${report.activationFailed}`
        );
      }
      return report;
    })
    .catch((error) => {
      console.error(`[EMAIL_WORKER] pass failed (${error instanceof Error ? error.name : "error"}).`);
      return { claimed: 0, sent: 0, retryScheduled: 0, failed: 0, activated: 0, activationFailed: 0, payloadsExpired: 0 };
    })
    .finally(() => {
      state.running = null;
      // A batch was full or a wake arrived meanwhile: go again soon (not in a tight loop).
      if (state.again && !state.stopping) {
        const t = setTimeout(() => void runPass(state), 250);
        t.unref?.();
      }
    });
  return state.running;
}

/**
 * Starts this process's worker (once; later calls return true). `force`
 * skips the environment check (tests); `run` replaces the pass (tests).
 */
export function startEmailDeliveryWorker(
  options: {
    env?: NodeJS.ProcessEnv;
    force?: boolean;
    installSignalHandlers?: boolean;
    run?: (options: { shouldStop: () => boolean }) => Promise<ProcessReport>;
    config?: Partial<WorkerConfig>;
  } = {}
): boolean {
  if (holder.slEmailDeliveryWorker && !holder.slEmailDeliveryWorker.stopping) return true;
  const env = options.env ?? process.env;
  if (!options.force && !canRunEmailDeliveryWorker(env)) return false;

  const config = { ...emailWorkerConfig(env), ...options.config };
  const state: WorkerState = {
    timer: null,
    running: null,
    again: false,
    stopping: false,
    config,
    run:
      options.run ??
      ((o) => processEmailDeliveries({ batchSize: config.batchSize, concurrency: config.concurrency, shouldStop: o.shouldStop, env })),
    unregisterShutdown: null,
    lastReport: null,
    lastPassAt: null,
  };
  holder.slEmailDeliveryWorker = state;

  state.timer = setInterval(() => void runPass(state), config.pollIntervalMs);
  state.timer.unref?.();
  // First pass soon after start: recovers rows left PROCESSING by a previous process.
  const first = setTimeout(() => void runPass(state), Math.min(2000, config.pollIntervalMs));
  first.unref?.();

  if (options.installSignalHandlers !== false) {
    state.unregisterShutdown = registerShutdownTask("email-delivery-worker", () => shutdownEmailDeliveryWorker());
  }
  console.log(`[EMAIL_WORKER] started pollIntervalMs=${config.pollIntervalMs} batchSize=${config.batchSize} concurrency=${config.concurrency}`);
  return true;
}

/** Asks for a pass now (after queueing). Starts the worker if it may run here. Never throws. */
export function wakeEmailDeliveryWorker(): void {
  try {
    if (!holder.slEmailDeliveryWorker || holder.slEmailDeliveryWorker.stopping) {
      if (!startEmailDeliveryWorker()) return;
    }
    const state = holder.slEmailDeliveryWorker;
    if (state) void runPass(state);
  } catch {
    // The poll will pick the row up.
  }
}

/** Runs one pass now and waits for it (tests / operations). */
export async function runEmailDeliveryWorkerPassForTests(): Promise<ProcessReport | null> {
  const state = holder.slEmailDeliveryWorker;
  if (!state) return null;
  return runPass(state);
}

/**
 * Graceful shutdown: stop the timer, claim nothing more, wait (bounded) for
 * the running pass. Never throws. Returns whether the pass finished in time.
 */
export async function shutdownEmailDeliveryWorker(): Promise<boolean> {
  const state = holder.slEmailDeliveryWorker;
  if (!state) return true;
  state.stopping = true;
  if (state.timer) clearInterval(state.timer);
  state.unregisterShutdown?.();
  state.unregisterShutdown = null;
  let finished = true;
  if (state.running) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    finished = await Promise.race([
      state.running.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), state.config.shutdownTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  if (holder.slEmailDeliveryWorker === state) delete holder.slEmailDeliveryWorker;
  console.log(`[EMAIL_WORKER] stopped${finished ? "" : " (a pass was still running; its rows are recovered after their lease)"}`);
  return finished;
}
