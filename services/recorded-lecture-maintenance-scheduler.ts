import { abandonRunningCompletions } from "@/services/recorded-lecture-completion-service";
import { runRecordedLectureMaintenance, type MaintenanceReport } from "@/services/recorded-lecture-maintenance-service";

/*
 * Recorded Lectures RL-3.5: the maintenance scheduler.
 *
 * NOT WIRED: nothing in the application calls startRecordedLectureMaintenance
 * yet (instrumentation.ts is unchanged); enabling it is a separate, reviewed
 * step. Until then cleanup and automatic recovery do not run.
 *
 * When started (one per process; later calls do nothing):
 *   - a first run STARTUP_DELAY_MS after start (startup recovery), then every
 *     MAINTENANCE_INTERVAL_MS;
 *   - every run: expiry and stale-completion recovery; the temporary-file
 *     sweep at most every TEMPORARY_SWEEP_EVERY_MS; the final-file orphan
 *     sweep at most every FINAL_SWEEP_EVERY_MS;
 *   - runs never overlap (a tick during a run is skipped); a failing run is
 *     logged by the maintenance service and simply retried by the next tick;
 *   - the timers do not keep the process alive;
 *   - graceful shutdown (SIGTERM / SIGINT): the timers stop and every
 *     completion claim running here is abandoned (made stale, fenced), so the
 *     next process recovers it at once. The signal then takes its normal
 *     course (another handler, or the default exit).
 * Only on a long-running production Node server (not serverless), and only
 * when the recorded-lecture storage is configured.
 */

export const MAINTENANCE_INTERVAL_MS = 60_000;
export const STARTUP_DELAY_MS = 30_000;
export const TEMPORARY_SWEEP_EVERY_MS = 5 * 60_000;
export const FINAL_SWEEP_EVERY_MS = 6 * 3_600_000;
/** How long shutdown waits for claims to be abandoned before letting the signal proceed. */
export const SHUTDOWN_ABANDON_TIMEOUT_MS = 1_000;

type SchedulerState = {
  timer: ReturnType<typeof setInterval> | null;
  startupTimer: ReturnType<typeof setTimeout> | null;
  signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }>;
};

/** Run bookkeeping, shared by scheduled and manual ticks (overlap guard, sweep cadence). */
type TickState = { running: boolean; lastTemporaryAtMs: number | null; lastFinalsAtMs: number | null };

const holder = globalThis as unknown as { slRecordedLectureMaintenance?: SchedulerState; slRecordedLectureMaintenanceTicks?: TickState };

function ticks(): TickState {
  if (!holder.slRecordedLectureMaintenanceTicks) holder.slRecordedLectureMaintenanceTicks = { running: false, lastTemporaryAtMs: null, lastFinalsAtMs: null };
  return holder.slRecordedLectureMaintenanceTicks;
}

/** Tests only: forget the run bookkeeping. */
export function resetMaintenanceTicksForTests() {
  holder.slRecordedLectureMaintenanceTicks = { running: false, lastTemporaryAtMs: null, lastFinalsAtMs: null };
}

/** Where the scheduler may run: a long-running production Node server with the storage configured. */
export function canRunMaintenanceScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return false;
  if (env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME) return false;
  return typeof env.FILE_STORAGE_ROOT === "string" && env.FILE_STORAGE_ROOT.trim() !== "";
}

export function isMaintenanceSchedulerRunning(): boolean {
  return Boolean(holder.slRecordedLectureMaintenance);
}

/**
 * One scheduled run: expiry and recovery always, the sweeps when due.
 * Returns null when a run is already in progress here.
 */
export async function runMaintenanceTick(nowMs: number = Date.now()): Promise<MaintenanceReport | null> {
  const state = ticks();
  if (state.running) return null;
  state.running = true;
  try {
    const temporary = state.lastTemporaryAtMs === null || nowMs - state.lastTemporaryAtMs >= TEMPORARY_SWEEP_EVERY_MS;
    const finals = state.lastFinalsAtMs === null || nowMs - state.lastFinalsAtMs >= FINAL_SWEEP_EVERY_MS;
    const report = await runRecordedLectureMaintenance({ phases: { expire: true, recover: true, temporary, finals } });
    if (temporary && !report.failedPhases.includes("temporary") && report.skipped === null) state.lastTemporaryAtMs = nowMs;
    if (finals && !report.failedPhases.includes("finals") && report.skipped === null && report.finals?.complete) state.lastFinalsAtMs = nowMs;
    return report;
  } catch {
    return null; // runRecordedLectureMaintenance never throws; defensive only
  } finally {
    state.running = false;
  }
}

function newState(): SchedulerState {
  return { timer: null, startupTimer: null, signalHandlers: [] };
}

/**
 * Starts this process's scheduler (once). Returns whether it runs after the
 * call. `options.force` skips the environment check (tests only).
 */
export function startRecordedLectureMaintenance(
  options: { env?: NodeJS.ProcessEnv; force?: boolean; startupDelayMs?: number; intervalMs?: number; installSignalHandlers?: boolean } = {}
): boolean {
  if (holder.slRecordedLectureMaintenance) return true;
  if (!options.force && !canRunMaintenanceScheduler(options.env ?? process.env)) return false;

  const state = newState();
  holder.slRecordedLectureMaintenance = state;
  const tick = () => {
    void runMaintenanceTick().catch(() => undefined);
  };
  state.startupTimer = setTimeout(tick, options.startupDelayMs ?? STARTUP_DELAY_MS);
  state.startupTimer.unref?.();
  state.timer = setInterval(tick, options.intervalMs ?? MAINTENANCE_INTERVAL_MS);
  state.timer.unref?.();

  if (options.installSignalHandlers !== false) {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => {
        void shutdownRecordedLectureMaintenance().finally(() => {
          // Ours was a once-listener: with no other listener left, the signal's
          // default action (exit) must still happen.
          if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
        });
      };
      process.once(signal, handler);
      state.signalHandlers.push({ signal, handler });
    }
  }
  return true;
}

/** Stops the timers (and removes the signal handlers). Running work finishes on its own. */
export function stopRecordedLectureMaintenance() {
  const state = holder.slRecordedLectureMaintenance;
  if (!state) return;
  if (state.timer) clearInterval(state.timer);
  if (state.startupTimer) clearTimeout(state.startupTimer);
  for (const { signal, handler } of state.signalHandlers) process.removeListener(signal, handler);
  delete holder.slRecordedLectureMaintenance;
}

/**
 * Graceful shutdown: stop the timers, then abandon this process's running
 * completion claims (bounded wait). Never throws.
 */
export async function shutdownRecordedLectureMaintenance(): Promise<number> {
  stopRecordedLectureMaintenance();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      abandonRunningCompletions(),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(0), SHUTDOWN_ABANDON_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
