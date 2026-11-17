/*
 * Graceful shutdown of the background work inside the Next.js process:
 * lib/process-shutdown.ts with the REAL email worker
 * (services/email-delivery-worker.ts) and the REAL Recorded Lectures
 * maintenance scheduler (services/recorded-lecture-maintenance-scheduler.ts).
 *
 * `next start` registers its own SIGINT / SIGTERM handler
 * (server.close(() => process.exit(0))) before instrumentation runs. Here a
 * stand-in listener plays that role: it must be called only AFTER every
 * registered task finished (or the coordinator's deadline passed). Signals are
 * delivered with process.emit (listeners run; the test process is not killed).
 *
 *   npm run test:students
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();
const root = path.resolve(__dirname, "..", "..");

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
// The maintenance scheduler's shutdown abandons running completion claims; a stand-in records the call.
const abandoned = [];
fake("services/recorded-lecture-completion-service.ts", { abandonRunningCompletions: async () => (abandoned.push(Date.now()), 0) });
fake("services/recorded-lecture-maintenance-service.ts", { runRecordedLectureMaintenance: async () => ({ failedPhases: [], skipped: null }) });
fake("services/permanent-deletion-service.ts", { retryPendingDeletions: async () => null });
fake("services/teacher-profile-photo-service.ts", { finishPendingProfilePhotoRemovals: async () => null, sweepProfilePhotoOrphans: async () => ({ complete: true }) });

const SHUTDOWN = require(path.join(root, "lib", "process-shutdown.ts"));
const WORKER = require(path.join(root, "services", "email-delivery-worker.ts"));
const MAINTENANCE = require(path.join(root, "services", "recorded-lecture-maintenance-scheduler.ts"));

const EMPTY = { claimed: 0, sent: 0, retryScheduled: 0, failed: 0, activated: 0, activationFailed: 0, payloadsExpired: 0 };
const SIGNALS = ["SIGINT", "SIGTERM"];
const quiet = () => {
  const saved = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  return () => Object.assign(console, saved);
};

/** Takes every real listener off (e.g. the test runner's), installs a Next-like one; returns the restore function. */
function withNextLikeHandler(onExit) {
  const saved = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
  for (const s of SIGNALS) process.removeAllListeners(s);
  const nextCleanup = (signal) => onExit(signal);
  for (const s of SIGNALS) process.on(s, nextCleanup);
  return () => {
    for (const s of SIGNALS) {
      process.removeAllListeners(s);
      for (const l of saved[s]) process.on(s, l);
    }
  };
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("SIGTERM: Next's exit waits until the email worker's in-flight pass AND the maintenance shutdown have finished", async () => {
  const restoreConsole = quiet();
  const exits = [];
  const restore = withNextLikeHandler((signal) => exits.push({ signal, at: Date.now() }));
  try {
    let releasePass;
    let passFinishedAt = null;
    WORKER.startEmailDeliveryWorker({
      force: true,
      config: { pollIntervalMs: 3_600_000, shutdownTimeoutMs: 5000 },
      run: () =>
        new Promise((resolve) => {
          releasePass = () => {
            passFinishedAt = Date.now();
            resolve(EMPTY);
          };
        }),
    });
    MAINTENANCE.startRecordedLectureMaintenance({ force: true, startupDelayMs: 3_600_000, intervalMs: 3_600_000 });

    // One listener per signal: the coordinator (Next's listener was taken off and kept).
    assert.equal(process.listenerCount("SIGTERM"), 1);
    WORKER.runEmailDeliveryWorkerPassForTests(); // an email is being sent

    process.emit("SIGTERM", "SIGTERM");
    await tick(1500); // longer than the maintenance shutdown's own 1 s budget
    assert.equal(exits.length, 0, "Next's exit is held while the email pass runs");
    assert.equal(abandoned.length, 1, "the maintenance shutdown ran");
    assert.equal(SHUTDOWN.isShutdownInProgress(), true);

    releasePass();
    await tick(50);
    assert.equal(exits.length, 1, "then Next's own handler runs, once");
    assert.equal(exits[0].signal, "SIGTERM");
    assert.ok(exits[0].at >= passFinishedAt, "only after the email pass finished");
    assert.equal(WORKER.isEmailDeliveryWorkerRunning(), false);
    assert.equal(MAINTENANCE.isMaintenanceSchedulerRunning(), false);
    assert.equal(process.listenerCount("SIGTERM"), 0, "the coordinator is gone (Next's listener was handed the signal)");
  } finally {
    restore();
    restoreConsole();
  }
});

test("the deadline (PROCESS_SHUTDOWN_TIMEOUT_MS, below PM2 kill_timeout) bounds the wait for a stuck task", async () => {
  const restoreConsole = quiet();
  const exits = [];
  const restore = withNextLikeHandler((signal) => exits.push(signal));
  process.env.PROCESS_SHUTDOWN_TIMEOUT_MS = "200";
  try {
    WORKER.startEmailDeliveryWorker({ force: true, config: { pollIntervalMs: 3_600_000, shutdownTimeoutMs: 2000 }, run: () => new Promise(() => {}) });
    WORKER.runEmailDeliveryWorkerPassForTests();
    process.emit("SIGINT", "SIGINT");
    await tick(100);
    assert.equal(exits.length, 0);
    await tick(250);
    assert.deepEqual(exits, ["SIGINT"], "handed over at the deadline");
  } finally {
    delete process.env.PROCESS_SHUTDOWN_TIMEOUT_MS;
    restore();
    restoreConsole();
    await WORKER.shutdownEmailDeliveryWorker().catch(() => {});
  }
});

test("a second signal skips the wait", async () => {
  const restoreConsole = quiet();
  const exits = [];
  const restore = withNextLikeHandler((signal) => exits.push(signal));
  try {
    WORKER.startEmailDeliveryWorker({ force: true, config: { pollIntervalMs: 3_600_000, shutdownTimeoutMs: 2000 }, run: () => new Promise(() => {}) });
    WORKER.runEmailDeliveryWorkerPassForTests();
    process.emit("SIGTERM", "SIGTERM");
    await tick(50);
    assert.equal(exits.length, 0);
    process.emit("SIGTERM", "SIGTERM");
    await tick(10);
    assert.deepEqual(exits, ["SIGTERM"]);
  } finally {
    restore();
    restoreConsole();
  }
});

test("stopping both schedulers without a signal restores the original listeners; restart installs the coordinator again", async () => {
  const restoreConsole = quiet();
  const exits = [];
  const restore = withNextLikeHandler((signal) => exits.push(signal));
  try {
    const nextListener = process.listeners("SIGTERM")[0];
    WORKER.startEmailDeliveryWorker({ force: true, config: { pollIntervalMs: 3_600_000 }, run: async () => EMPTY });
    MAINTENANCE.startRecordedLectureMaintenance({ force: true, startupDelayMs: 3_600_000, intervalMs: 3_600_000 });
    assert.notEqual(process.listeners("SIGTERM")[0], nextListener);

    MAINTENANCE.stopRecordedLectureMaintenance();
    assert.equal(process.listenerCount("SIGTERM"), 1, "still coordinated for the worker");
    await WORKER.shutdownEmailDeliveryWorker();
    assert.deepEqual(process.listeners("SIGTERM"), [nextListener], "Next's listener is back, alone");
    assert.equal(exits.length, 0);

    // Restart (new process / hot reload): coordinated again.
    WORKER.startEmailDeliveryWorker({ force: true, config: { pollIntervalMs: 3_600_000 }, run: async () => EMPTY });
    assert.notEqual(process.listeners("SIGTERM")[0], nextListener);
    assert.equal(WORKER.isEmailDeliveryWorkerRunning(), true);
    await WORKER.shutdownEmailDeliveryWorker();
    assert.deepEqual(process.listeners("SIGTERM"), [nextListener]);
  } finally {
    restore();
    restoreConsole();
  }
});

test("timeout default and validation", () => {
  assert.equal(SHUTDOWN.processShutdownTimeoutMs({}), 9000);
  assert.equal(SHUTDOWN.processShutdownTimeoutMs({ PROCESS_SHUTDOWN_TIMEOUT_MS: "15000" }), 15000);
  assert.equal(SHUTDOWN.processShutdownTimeoutMs({ PROCESS_SHUTDOWN_TIMEOUT_MS: "nope" }), 9000);
});
