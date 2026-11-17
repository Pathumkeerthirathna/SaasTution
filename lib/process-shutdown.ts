/*
 * One graceful-shutdown sequence for the background work that runs inside
 * the Next.js server process (the Recorded Lectures maintenance scheduler and
 * the student email worker). Server only.
 *
 * Why: `next start` installs its own SIGINT / SIGTERM handler
 * (next/dist/server/lib/start-server.js: server.close(() => process.exit(0)))
 * BEFORE instrumentation.ts runs. With independent handlers, that exit (or one
 * scheduler re-raising the signal) could end the process while another task
 * was still finishing, e.g. an email being handed to the provider.
 *
 * How (installed when the first task registers, removed with the last one):
 *   - the SIGINT / SIGTERM listeners that already exist (Next's) are taken off
 *     and kept;
 *   - ONE handler of ours runs every registered task in parallel, each bounded
 *     by its own timeout, and the whole bounded by PROCESS_SHUTDOWN_TIMEOUT_MS
 *     (default 9000 ms; keep PM2 kill_timeout ABOVE it);
 *   - only then are the kept listeners called (Next closes the HTTP server and
 *     exits as usual); with none, the signal's default action is restored and
 *     the signal re-raised;
 *   - a second signal skips the wait (an operator insisting).
 * Never throws; a failing task is logged by name only.
 */

export type ShutdownTask = () => Promise<unknown>;
type Signal = "SIGINT" | "SIGTERM";
const SIGNALS: Signal[] = ["SIGINT", "SIGTERM"];

type Listener = (...args: unknown[]) => void;
type State = {
  tasks: Map<string, ShutdownTask>;
  kept: Map<Signal, Listener[]>;
  handlers: Map<Signal, Listener>;
  shuttingDown: boolean;
  handedOver: boolean;
};

const holder = globalThis as unknown as { slProcessShutdown?: State };

export function processShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.PROCESS_SHUTDOWN_TIMEOUT_MS?.trim());
  return Number.isInteger(value) && value >= 0 && value <= 120_000 ? value : 9000;
}

/** Runs every registered task (bounded). Exposed for tests and the signal handler. Never throws. */
export async function runShutdownTasks(timeoutMs: number = processShutdownTimeoutMs()): Promise<{ finished: boolean; tasks: string[] }> {
  const state = holder.slProcessShutdown;
  const entries = state ? Array.from(state.tasks.entries()) : [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const all = Promise.allSettled(
    entries.map(async ([name, task]) => {
      try {
        await task();
      } catch (error) {
        console.error(`[SHUTDOWN] task ${name} failed (${error instanceof Error ? error.name : "error"}).`);
      }
    })
  ).then(() => true);
  const finished = await Promise.race([
    all,
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return { finished, tasks: entries.map(([name]) => name) };
}

function handOver(state: State, signal: Signal) {
  if (state.handedOver) return;
  state.handedOver = true;
  const kept = state.kept.get(signal) ?? [];
  uninstall(state);
  if (kept.length === 0) {
    process.kill(process.pid, signal); // default action (no listener left)
    return;
  }
  for (const listener of kept) {
    try {
      listener(signal);
    } catch {
      // Next's cleanup does not throw; defensive only.
    }
  }
}

function install(): State {
  const state: State = { tasks: new Map(), kept: new Map(), handlers: new Map(), shuttingDown: false, handedOver: false };
  for (const signal of SIGNALS) {
    const existing = process.listeners(signal) as Listener[];
    state.kept.set(signal, existing);
    for (const listener of existing) process.removeListener(signal, listener);
    const handler: Listener = () => {
      if (state.shuttingDown) {
        handOver(state, signal); // second signal: do not wait any longer
        return;
      }
      state.shuttingDown = true;
      console.log(`[SHUTDOWN] ${signal}: finishing background work (${Array.from(state.tasks.keys()).join(", ") || "none"}).`);
      void runShutdownTasks().then(({ finished }) => {
        if (!finished) console.log("[SHUTDOWN] background work did not finish in time; continuing shutdown.");
        handOver(state, signal);
      });
    };
    state.handlers.set(signal, handler);
    process.on(signal, handler);
  }
  holder.slProcessShutdown = state;
  return state;
}

function uninstall(state: State) {
  for (const signal of SIGNALS) {
    const handler = state.handlers.get(signal);
    if (handler) process.removeListener(signal, handler);
    // Put the original listeners back (unless we are handing the signal to them right now).
    if (!state.handedOver) for (const listener of state.kept.get(signal) ?? []) process.on(signal, listener);
  }
  state.handlers.clear();
  if (holder.slProcessShutdown === state) delete holder.slProcessShutdown;
}

/**
 * Registers (or replaces) a named shutdown task. Returns the function that
 * removes it; removing the last task removes the coordinator and restores the
 * original signal listeners.
 */
export function registerShutdownTask(name: string, task: ShutdownTask): () => void {
  const state = holder.slProcessShutdown ?? install();
  state.tasks.set(name, task);
  return () => {
    const current = holder.slProcessShutdown;
    if (current !== state || state.tasks.get(name) !== task) return;
    state.tasks.delete(name);
    if (state.tasks.size === 0 && !state.shuttingDown) uninstall(state);
  };
}

export function isShutdownInProgress(): boolean {
  return Boolean(holder.slProcessShutdown?.shuttingDown);
}
