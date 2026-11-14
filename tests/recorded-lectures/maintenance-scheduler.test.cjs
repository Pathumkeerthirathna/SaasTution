/*
 * Recorded Lectures RL-3.5: the maintenance scheduler
 * (services/recorded-lecture-maintenance-scheduler.ts). It is built but NOT
 * wired into application startup; this file also guards that.
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const H = require("./helpers/upload-harness.cjs");
const { state, ids, scheduler } = H;
const { OWNER } = ids;
const { MIB } = H.constants;

H.install(test);

const root = path.resolve(__dirname, "..", "..");

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("NOT WIRED: no application file starts the scheduler (instrumentation.ts unchanged)", () => {
  const instrumentation = fs.readFileSync(path.join(root, "instrumentation.ts"), "utf8");
  assert.doesNotMatch(instrumentation, /recorded-lecture|maintenance/i);
  const users = [];
  for (const dir of ["app", "components", "lib", "services", "scripts"]) {
    for (const file of listFiles(path.join(root, dir))) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (rel === "services/recorded-lecture-maintenance-scheduler.ts") continue;
      const source = fs.readFileSync(file, "utf8");
      // An import of the scheduler, or a call that starts it (mentions in comments do not count).
      if (/from\s+["'][^"']*recorded-lecture-maintenance-scheduler["']|startRecordedLectureMaintenance\s*\(/.test(source)) users.push(rel);
    }
  }
  assert.deepEqual(users, []);
  assert.equal(scheduler.isMaintenanceSchedulerRunning(), false);
});

test("where it may run: production, long-running (not serverless), storage configured", () => {
  const ok = { NODE_ENV: "production", FILE_STORAGE_ROOT: "/srv/recordings" };
  assert.equal(scheduler.canRunMaintenanceScheduler(ok), true);
  assert.equal(scheduler.canRunMaintenanceScheduler({ ...ok, NODE_ENV: "development" }), false);
  assert.equal(scheduler.canRunMaintenanceScheduler({ ...ok, NETLIFY: "true" }), false);
  assert.equal(scheduler.canRunMaintenanceScheduler({ ...ok, AWS_LAMBDA_FUNCTION_NAME: "f" }), false);
  assert.equal(scheduler.canRunMaintenanceScheduler({ NODE_ENV: "production" }), false);
  assert.equal(scheduler.canRunMaintenanceScheduler({ ...ok, FILE_STORAGE_ROOT: " " }), false);
  // In this (test) environment it does not start without force.
  assert.equal(scheduler.startRecordedLectureMaintenance(), false);
  assert.equal(scheduler.isMaintenanceSchedulerRunning(), false);
});

test("constants: 60 s interval, first run 30 s after start, temp sweep every 5 min, final sweep every 6 h", () => {
  assert.equal(scheduler.MAINTENANCE_INTERVAL_MS, 60_000);
  assert.equal(scheduler.STARTUP_DELAY_MS, 30_000);
  assert.equal(scheduler.TEMPORARY_SWEEP_EVERY_MS, 5 * 60_000);
  assert.equal(scheduler.FINAL_SWEEP_EVERY_MS, 6 * 3_600_000);
});

test("tick cadence: expiry + recovery every tick; temporary sweep every 5 min; final sweep every 6 h", async () => {
  await H.signInAs(OWNER);
  await H.createUpload(MIB);
  const t0 = 1_000_000;
  const first = await scheduler.runMaintenanceTick(t0);
  assert.ok(first.temporary && first.finals, "first tick runs everything");
  const minute = await scheduler.runMaintenanceTick(t0 + 60_000);
  assert.equal(minute.temporary, null);
  assert.equal(minute.finals, null);
  const fiveMinutes = await scheduler.runMaintenanceTick(t0 + 5 * 60_000);
  assert.ok(fiveMinutes.temporary);
  assert.equal(fiveMinutes.finals, null);
  const sixHours = await scheduler.runMaintenanceTick(t0 + 6 * 3_600_000);
  assert.ok(sixHours.temporary && sixHours.finals);
});

test("ticks never overlap: a tick during a run returns null", async () => {
  await H.signInAs(OWNER);
  await H.createUpload(MIB);
  const hold = H.gate();
  // A run blocked inside its first phase: hold the session query of the expiry phase.
  let entered;
  const inRun = new Promise((r) => (entered = r));
  const realFindMany = state.fakeDb.prisma.recordingUploadSession.findMany;
  state.fakeDb.prisma.recordingUploadSession.findMany = async (args) => {
    entered();
    await hold.promise;
    return realFindMany(args);
  };
  const running = scheduler.runMaintenanceTick();
  await inRun;
  assert.equal(await scheduler.runMaintenanceTick(), null, "skipped while running");
  hold.open();
  state.fakeDb.prisma.recordingUploadSession.findMany = realFindMany;
  assert.ok(await running);
});

test("start (forced, short timers) runs maintenance on its own; stop ends it; signal handlers are removed", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  const dir = path.join(H.storageRoot(), "System", "TemporaryUploads");
  const orphan = path.join(dir, `${uploadId}.${crypto.randomBytes(32).toString("hex")}.chunk`);
  fs.writeFileSync(orphan, "x");
  const old = (state.clock - 16 * 60_000) / 1000;
  fs.utimesSync(orphan, old, old);

  const before = process.listenerCount("SIGTERM");
  assert.equal(scheduler.startRecordedLectureMaintenance({ force: true, startupDelayMs: 1, intervalMs: 3_600_000 }), true);
  assert.equal(scheduler.startRecordedLectureMaintenance({ force: true }), true, "a second start does nothing");
  assert.equal(process.listenerCount("SIGTERM"), before + 1);
  await H.until(() => !fs.existsSync(orphan), "the startup run deleted the orphan");
  scheduler.stopRecordedLectureMaintenance();
  assert.equal(scheduler.isMaintenanceSchedulerRunning(), false);
  assert.equal(process.listenerCount("SIGTERM"), before);
});
