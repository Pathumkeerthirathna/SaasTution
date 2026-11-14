/*
 * Recorded Lectures RL-3.5: file cleanup eligibility (lib/recorded-lectures/cleanup-rules.ts).
 * Pure; every rule, every boundary (grace - 1 ms and exactly the grace).
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const R = require(path.join(root, "lib", "recorded-lectures", "cleanup-rules.ts"));

const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const MIN = 60_000;
const GRACE = 15 * MIN;
const ORPHAN = 48 * 60 * MIN;
const T = "a".repeat(64);
const OTHER = "b".repeat(64);
const OLD = NOW - GRACE; // exactly the grace
const YOUNG = NOW - GRACE + 1; // 1 ms short

const action = (d) => d.action;
const session = (overrides = {}) => ({ state: "ACTIVE", leaseToken: null, leaseExpiresAtMs: null, endedAtMs: null, ...overrides });
const chunk = (overrides) => R.chunkFileDisposition({ token: T, fileModifiedAtMs: OLD, session: session(), committed: false, nowMs: NOW, ...overrides });

test("defaults: 15-minute scratch grace, 48-hour orphan grace", () => {
  assert.equal(R.SCRATCH_GRACE_DEFAULT_MS, GRACE);
  assert.equal(R.ORPHAN_GRACE_DEFAULT_MS, ORPHAN);
});

test("chunk file: the current, unexpired lease is always kept, whatever its age", () => {
  const current = session({ leaseToken: T, leaseExpiresAtMs: NOW + 1 });
  assert.equal(action(chunk({ session: current, fileModifiedAtMs: NOW - 10 * GRACE })), "KEEP");
  assert.equal(chunk({ session: current }).reason, "current lease");
  // At / after its expiry it is no longer current (the writer is >= 60 s past its write deadline).
  assert.equal(action(chunk({ session: session({ leaseToken: T, leaseExpiresAtMs: NOW }) })), "DELETE");
  // Another token's lease does not protect this file.
  assert.equal(action(chunk({ session: session({ leaseToken: OTHER, leaseExpiresAtMs: NOW + 1 }) })), "DELETE");
});

test("chunk file, uncommitted: deleted only from exactly the grace on", () => {
  assert.equal(action(chunk({ fileModifiedAtMs: YOUNG })), "KEEP");
  assert.equal(action(chunk({ fileModifiedAtMs: OLD })), "DELETE");
  assert.equal(chunk({}).reason, "uncommitted chunk");
  assert.equal(action(chunk({ session: null })), "DELETE", "no session row");
});

test("chunk file, committed: kept while the upload is ACTIVE or COMPLETING; deleted once final + grace", () => {
  for (const state of ["ACTIVE", "COMPLETING"]) {
    assert.equal(action(chunk({ committed: true, session: session({ state }), fileModifiedAtMs: NOW - 100 * GRACE })), "KEEP", state);
  }
  for (const state of ["COMPLETED", "CANCELLED", "FAILED", "EXPIRED"]) {
    assert.equal(action(chunk({ committed: true, session: session({ state, endedAtMs: NOW - GRACE + 1 }) })), "KEEP", `${state}: ended within grace`);
    assert.equal(action(chunk({ committed: true, session: session({ state, endedAtMs: NOW - GRACE }) })), "DELETE", `${state}: ended a grace ago`);
    assert.equal(action(chunk({ committed: true, session: session({ state, endedAtMs: null }) })), "KEEP", `${state}: no end time`);
  }
  assert.equal(action(chunk({ committed: true, session: null })), "DELETE", "upload removed");
  assert.equal(action(chunk({ committed: true, session: null, fileModifiedAtMs: YOUNG })), "KEEP", "file within grace");
});

test("assembly file: the current claim's is always kept; another claim's only after the grace", () => {
  const name = `${"c".repeat(32)}.mp4`;
  const a = (overrides) => R.assemblyFileDisposition({ claimFileName: name, fileModifiedAtMs: OLD, sessionState: "COMPLETING", recordingStoredFileName: name, nowMs: NOW, ...overrides });
  assert.equal(action(a({ fileModifiedAtMs: NOW - 100 * GRACE })), "KEEP", "current claim");
  assert.equal(action(a({ recordingStoredFileName: `${"d".repeat(32)}.mp4` })), "DELETE", "taken over");
  assert.equal(action(a({ recordingStoredFileName: `${"d".repeat(32)}.mp4`, fileModifiedAtMs: YOUNG })), "KEEP", "within grace");
  for (const state of ["ACTIVE", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED", null]) {
    assert.equal(action(a({ sessionState: state })), "DELETE", `session ${state}`);
  }
  assert.equal(action(a({ recordingStoredFileName: null })), "DELETE");
});

test("final file: referenced (READY, VERIFYING claim) kept forever; orphans only after 48 hours", () => {
  const name = `${"e".repeat(32)}.mp4`;
  const f = (overrides) => R.finalFileDisposition({ storedName: name, fileModifiedAtMs: NOW - ORPHAN, recording: { state: "READY", storedFileName: name }, nowMs: NOW, ...overrides });
  for (const state of ["READY", "VERIFYING", "UPLOADING"]) {
    assert.equal(action(f({ recording: { state, storedFileName: name }, fileModifiedAtMs: NOW - 100 * ORPHAN })), "KEEP", state);
  }
  const orphans = [
    { recording: null },
    { recording: { state: "READY", storedFileName: `${"f".repeat(32)}.mp4` } },
    { recording: { state: "FAILED", storedFileName: name } },
  ];
  for (const o of orphans) {
    assert.equal(action(f({ ...o, fileModifiedAtMs: NOW - ORPHAN + 1 })), "KEEP", "1 ms short of 48 h");
    assert.equal(action(f({ ...o, fileModifiedAtMs: NOW - ORPHAN })), "DELETE", "exactly 48 h");
  }
  // A recording removed by its teacher (status 1 / 2) is not purged here: the rule does not even look at status.
  assert.equal(action(f({ recording: { state: "READY", storedFileName: name, status: 2 } })), "KEEP");
});

test(".part file: only of a finished or removed upload, after the grace", () => {
  const p = (overrides) => R.partFileDisposition({ fileModifiedAtMs: OLD, sessionState: "CANCELLED", nowMs: NOW, ...overrides });
  for (const state of ["ACTIVE", "COMPLETING"]) assert.equal(action(p({ sessionState: state, fileModifiedAtMs: NOW - 100 * GRACE })), "KEEP");
  for (const state of ["COMPLETED", "CANCELLED", "FAILED", "EXPIRED", null]) assert.equal(action(p({ sessionState: state })), "DELETE", String(state));
  assert.equal(action(p({ fileModifiedAtMs: YOUNG })), "KEEP");
});

test("recording directories: removable only for a removed or FAILED recording", () => {
  assert.equal(R.recordingDirectoryRemovable(null), true);
  assert.equal(R.recordingDirectoryRemovable({ state: "FAILED", storedFileName: null }), true);
  for (const state of ["READY", "VERIFYING", "UPLOADING"]) assert.equal(R.recordingDirectoryRemovable({ state, storedFileName: null }), false);
});

test("custom grace periods are honoured", () => {
  assert.equal(action(chunk({ fileModifiedAtMs: NOW - MIN, graceMs: MIN })), "DELETE");
  assert.equal(action(chunk({ fileModifiedAtMs: NOW - MIN + 1, graceMs: MIN })), "KEEP");
});
