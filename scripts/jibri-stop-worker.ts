/*
 * Standalone worker: backend Jibri stop after a teacher departure
 * (lib/jibri-stop-for-departure.ts). A separate long-running process,
 * independent of the Next.js server and its instrumentation hook. It only
 * ever runs the Jibri step; the departure's YouTube cleanup stays with the
 * existing teacher-departure sweeper (lib/teacher-departure-sweep.ts).
 *
 * Startup decision, BEFORE anything that can touch a database is loaded:
 * this file statically imports only lib/jibri-stop-config.ts (no Prisma).
 * Importing @prisma/client loads the project's .env into process.env, so
 * the decision is taken from the real process environment alone: unless
 * JIBRI_SERVER_STOP=on, the Jitsi JWT settings AND DATABASE_URL are given to
 * this process explicitly, it logs why and returns without loading Prisma
 * (no client, no connection, no query) or the XMPP library. Only then are
 * the lifecycle, Prisma and the transport loaded (require, after the
 * check).
 *
 *   npx tsx --env-file=<worker env file> scripts/jibri-stop-worker.ts
 *   (production: deploy/jibri-worker/ecosystem.config.cjs, PM2)
 *
 * Three independent loops, so one never stands in for another
 * (lib/jibri-fence-control.ts reads each separately):
 * - LIVENESS (every 10 s): the mode it sees and its identity (version, Jitsi
 *   target, JWT issuer / audience, the secret's non-reversible fingerprint).
 *   Written even while a sweep runs long.
 * - SWEEP (every 5 s, never overlapping): "off": nothing; "on": arm, stop
 *   once, verify; "drain": verify only. Each sweep is time-boxed; its
 *   completion is recorded (sweep progress), also in mode off.
 * - PROBE (at start, then every 5 min): logs in to Jitsi with the system
 *   token, checks the server's identity (its bound JID's domain) and logs
 *   out; no room is joined. The connection proof (or its failure code).
 *
 * Several workers (or restarts) are safe: each attempt is serialized by the
 * teacher's and the lecture's locks and recorded in the database before
 * anything is sent.
 */

import {
  jibriStopConfigId,
  jibriWorkerIdentity,
  readJibriStopConfig,
  type JibriStopConfig,
} from "../lib/jibri-stop-config";
import type { JibriController } from "../lib/jibri-control";

/** How often the worker looks for departed sessions. */
export const JIBRI_STOP_SWEEP_INTERVAL_MS = 5_000;

/** How often the worker reports it is alive. */
export const JIBRI_LIVENESS_INTERVAL_MS = 10_000;

/** How often the worker proves it can log in to the expected Jitsi server. */
export const JIBRI_PROBE_INTERVAL_MS = 300_000;

/** The probe's budget (connect, identify, close). */
export const JIBRI_PROBE_BUDGET_MS = 15_000;

/** A classroom-shaped room name for the probe token's claim; never joined. */
export const JIBRI_PROBE_ROOM = "saastution-probe-jibristop";

export type JibriStopWorker = { stop(): Promise<void> };

type Runtime = {
  lifecycle: typeof import("../lib/jibri-stop-for-departure");
  control: typeof import("../lib/jibri-control");
  fence: typeof import("../lib/jibri-fence-control");
  clock: typeof import("../lib/server-clock");
  auth: typeof import("../lib/jitsi-auth");
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded only after the startup decision */
function loadRuntime(): Runtime {
  return {
    lifecycle: require("../lib/jibri-stop-for-departure"),
    control: require("../lib/jibri-control"),
    fence: require("../lib/jibri-fence-control"),
    clock: require("../lib/server-clock"),
    auth: require("../lib/jitsi-auth"),
  };
}

function loadPrisma(): typeof import("../lib/prisma") {
  return require("../lib/prisma");
}

function loadTransport(): typeof import("../lib/jibri-xmpp-transport") {
  return require("../lib/jibri-xmpp-transport");
}
/* eslint-enable @typescript-eslint/no-require-imports */

/** A loop that never overlaps itself: each run starts only after the previous one ended. */
function loop(intervalMs: number, run: () => Promise<void>, failure: string) {
  let current: Promise<void> | null = null;
  let stopped = false;

  const tick = () => {
    if (stopped || current) return;

    current = run()
      .catch(() => console.error(failure))
      .finally(() => {
        current = null;
      });
  };

  const timer = setInterval(tick, intervalMs);

  tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (current) await current;
    },
  };
}

/**
 * Starts the worker, or returns null (loading nothing else) when the
 * feature is disabled. `createController` builds the real XMPP controller
 * by default; tests pass a fake one.
 */
export async function startJibriStopWorker(options: {
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  livenessIntervalMs?: number;
  probeIntervalMs?: number;
  sweepBudgetMs?: number;
  createController?: (config: JibriStopConfig) => Promise<JibriController>;
} = {}): Promise<JibriStopWorker | null> {
  const env = options.env ?? process.env;
  const setting = readJibriStopConfig(env);

  if (!setting.enabled) {
    console.log("Jibri stop worker disabled:", setting.reason);
    return null;
  }

  const { lifecycle, control, fence, clock, auth } = loadRuntime();
  const config = setting.config;

  const createController = options.createController ?? (async () =>
    control.createJibriController({ transport: loadTransport().createXmppWebSocketTransport() }));

  const controller = await createController(config);
  const identity = jibriWorkerIdentity(config, env);
  const configId = jibriStopConfigId(config);
  const startedAt = await clock.serverNow();

  let lastMode: string | null = null;

  const readMode = async () => {
    const { mode } = await fence.readJibriFenceControl();

    if (mode !== lastMode) {
      console.log("Jibri stop worker: shared mode is " + mode + ".");
      lastMode = mode;
    }

    return mode;
  };

  // Liveness: alive, the mode seen, the identity. Independent of sweeps and of Jitsi.
  const liveness = loop(options.livenessIntervalMs ?? JIBRI_LIVENESS_INTERVAL_MS, async () => {
    const mode = await readMode();

    await fence.recordJibriWorkerLiveness({ at: await clock.serverNow(), mode, startedAt, configId, identity });
  }, "Jibri stop worker: liveness not recorded.");

  // Sweeps: time-boxed; their completion is the sweep progress.
  const sweeps = loop(options.intervalMs ?? JIBRI_STOP_SWEEP_INTERVAL_MS, async () => {
    const sweepStartedAt = await clock.serverNow();
    const mode = await readMode();

    if (mode === "on" || mode === "drain") {
      await lifecycle.sweepJibriStops({ controller, config, mode, sweepBudgetMs: options.sweepBudgetMs });
    }

    await fence.recordJibriSweepProgress({ startedAt: sweepStartedAt, completedAt: await clock.serverNow() });
  }, "Jibri stop worker: sweep failed (no sweep progress recorded).");

  // Probe: a login to the expected server (connection proof). Skipped by a controller without one.
  const probes = loop(options.probeIntervalMs ?? JIBRI_PROBE_INTERVAL_MS, async () => {
    if (!controller.probeConnection) return;

    let token: string;

    try {
      token = await auth.generateSystemJitsiToken({ room: JIBRI_PROBE_ROOM, jitsiDomain: config.jitsiDomain });
    } catch {
      await fence.recordJibriConnectionProof({ at: await clock.serverNow(), authenticated: false, roomJoined: false, error: "connect-failed" });
      return;
    }

    const result = await controller.probeConnection({
      websocketUrl: config.websocketUrl,
      xmppDomain: config.jitsiDomain,
      roomName: JIBRI_PROBE_ROOM,
      token,
      deadlineAt: Date.now() + JIBRI_PROBE_BUDGET_MS,
    });

    await fence.recordJibriConnectionProof({
      at: await clock.serverNow(),
      authenticated: result.ok,
      roomJoined: false,
      error: result.ok ? null : result.error,
    });

    // Codes only: never the token.
    if (!result.ok) console.warn("Jibri stop worker: Jitsi login probe failed", { error: result.error });
  }, "Jibri stop worker: probe failed (nothing recorded).");

  console.log("Jibri stop worker started.");

  return {
    async stop() {
      // An attempt in progress ends within its own lock budget.
      await Promise.all([liveness.stop(), sweeps.stop(), probes.stop()]);
    },
  };
}

async function main() {
  const worker = await startJibriStopWorker();

  if (!worker) return;

  const shutdown = async () => {
    await worker.stop();
    await loadPrisma().prisma.$disconnect().catch(() => {});
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch(() => {
    console.error("Jibri stop worker could not start.");
    process.exit(1);
  });
}
