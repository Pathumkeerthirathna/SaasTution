/*
 * Recorded Lectures RL-1: chunk lease and capacity reservation arithmetic
 * (lib/recorded-lectures/chunk-lease.ts), the plan v7/v8 formula. The
 * database transaction that feeds these functions (candidate written first,
 * then the aggregate, under the global capacity lock) is RL-3.
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const C = require(path.join(root, "lib", "recorded-lectures", "chunk-lease.ts"));
const { RECORDED_LECTURE_DEFAULTS } = require(path.join(root, "lib", "recorded-lectures", "config.ts"));

const MIB = 1024 * 1024;
const NOW = 1_800_000_000_000;
const CONFIG = { minFreeBytes: 0, maxInflightChunkBytes: 128 * MIB };
const lease = (bytes, expiresInMs = 60_000) => ({ leaseBytes: bytes, leaseExpiresAtMs: NOW + expiresInMs });
const noLease = { leaseBytes: null, leaseExpiresAtMs: null };
const total = (r) => r.reservedUploads + r.reservedChunks;

test("v7 examples (MiB): 100 -> 100; with an 8 lease -> 92 + 16 = 108; after apply -> 92; lease expired -> 100; last chunk -> 16", () => {
  const upload = { expectedBytes: 100 * MIB, receivedBytes: 0 };

  assert.equal(total(C.computeReservations([{ ...upload, ...noLease }], NOW)), 100 * MIB);

  const leased = C.computeReservations([{ ...upload, ...lease(8 * MIB) }], NOW);
  assert.deepEqual(leased, { reservedUploads: 92 * MIB, reservedChunks: 16 * MIB, reservedAssembly: 0, inflightLeaseBytes: 8 * MIB });
  assert.equal(total(leased), 108 * MIB, "not 116 (counted three times) and not 100 (scratch copy forgotten)");

  assert.equal(total(C.computeReservations([{ expectedBytes: 100 * MIB, receivedBytes: 8 * MIB, ...noLease }], NOW)), 92 * MIB);

  const expired = C.computeReservations([{ ...upload, ...lease(8 * MIB, -1) }], NOW);
  assert.deepEqual(expired, { reservedUploads: 100 * MIB, reservedChunks: 0, reservedAssembly: 0, inflightLeaseBytes: 0 });

  const last = C.computeReservations([{ expectedBytes: 100 * MIB, receivedBytes: 92 * MIB, ...lease(8 * MIB) }], NOW);
  assert.deepEqual(last, { reservedUploads: 0, reservedChunks: 16 * MIB, reservedAssembly: 0, inflightLeaseBytes: 8 * MIB });
});

test("a lease expiring exactly now is no longer current", () => {
  assert.equal(C.isLeaseCurrent(lease(1, 0), NOW), false);
  assert.equal(C.isLeaseCurrent(lease(1, 1), NOW), true);
  assert.equal(C.isLeaseCurrent(noLease, NOW), false);
});

test("several uploads add up; the candidate is simply one of the rows (no extra term)", () => {
  const rows = [
    { expectedBytes: 500, receivedBytes: 100, ...lease(50) },
    { expectedBytes: 300, receivedBytes: 0, ...noLease },
    { expectedBytes: 1000, receivedBytes: 1000, ...noLease },
  ];
  assert.deepEqual(C.computeReservations(rows, NOW), { reservedUploads: 350 + 300 + 0, reservedChunks: 100, reservedAssembly: 0, inflightLeaseBytes: 50 });
});

test("capacity boundary: an exactly fitting candidate is allowed; one byte more is refused (no over- or under-reservation)", () => {
  const rows = [{ expectedBytes: 100 * MIB, receivedBytes: 0, ...lease(8 * MIB) }];
  const reservations = C.computeReservations(rows, NOW);
  const minFree = 5 * MIB;
  const exact = total(reservations) + minFree;

  assert.deepEqual(C.decideCapacity({ freeBytes: exact, reservations }, { ...CONFIG, minFreeBytes: minFree }), { ok: true, headroomBytes: 0 });
  assert.deepEqual(C.decideCapacity({ freeBytes: exact - 1, reservations }, { ...CONFIG, minFreeBytes: minFree }), {
    ok: false, reason: "INSUFFICIENT_STORAGE", shortfallBytes: 1,
  });
});

test("in-flight cap: the sum of current leases (including the candidate) may not exceed it", () => {
  const rows = (n) => Array.from({ length: n }, () => ({ expectedBytes: 100 * MIB, receivedBytes: 0, ...lease(8 * MIB) }));
  const free = 10_000 * MIB;
  assert.equal(C.decideCapacity({ freeBytes: free, reservations: C.computeReservations(rows(16), NOW) }, CONFIG).ok, true, "16 x 8 MiB = 128 MiB");
  assert.deepEqual(C.decideCapacity({ freeBytes: free, reservations: C.computeReservations(rows(17), NOW) }, CONFIG), {
    ok: false, reason: "INFLIGHT_CHUNK_CAP", shortfallBytes: 8 * MIB,
  });
});

test("invalid rows fail closed", () => {
  for (const row of [
    { expectedBytes: -1, receivedBytes: 0, ...noLease },
    { expectedBytes: 10, receivedBytes: 11, ...noLease },
    { expectedBytes: 10, receivedBytes: 0, ...lease(11) },
    { expectedBytes: 1.5, receivedBytes: 0, ...noLease },
    { expectedBytes: 10, receivedBytes: 0, leaseBytes: -1, leaseExpiresAtMs: NOW + 1 },
  ]) {
    assert.throws(() => C.computeReservations([row], NOW), JSON.stringify(row));
  }
  assert.throws(() => C.decideCapacity({ freeBytes: -1, reservations: { reservedUploads: 0, reservedChunks: 0, inflightLeaseBytes: 0 } }, CONFIG));
});

test("randomized: reservations never fall below the real future disk need, and exceed it only by written scratch bytes", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i += 1) {
    const rows = [];
    let realNeed = 0;
    let writtenScratch = 0;
    for (let u = 0; u < 1 + Math.floor(random() * 6); u += 1) {
      const expected = 1 + Math.floor(random() * 50 * MIB);
      const received = Math.floor(random() * expected);
      const remaining = expected - received;
      const hasLease = random() < 0.6;
      const current = random() < 0.8;
      const leaseBytes = hasLease ? 1 + Math.floor(random() * Math.min(remaining, 8 * MIB)) : null;
      rows.push({ expectedBytes: expected, receivedBytes: received, leaseBytes, leaseExpiresAtMs: hasLease ? NOW + (current ? 1000 : -1000) : null });

      // Real future need: the rest of the upload, plus (current lease) the scratch bytes not written yet.
      realNeed += remaining;
      if (hasLease && current) {
        const written = Math.floor(random() * (leaseBytes + 1));
        writtenScratch += written;
        realNeed += leaseBytes - written;
      }
    }
    const reserved = total(C.computeReservations(rows, NOW));
    assert.ok(reserved >= realNeed, "never under-reserved");
    assert.ok(reserved - realNeed <= writtenScratch, "over-reserved by at most the scratch bytes already written");
  }
});

test("lease timing: expiry from the configured 300 s lease; Retry-After at least 1 s", () => {
  assert.equal(C.leaseExpiresAtMs(NOW, RECORDED_LECTURE_DEFAULTS), NOW + 300_000);
  assert.equal(C.retryAfterSecondsForLease(NOW + 1500, NOW), 2);
  assert.equal(C.retryAfterSecondsForLease(NOW, NOW), 1);
  assert.equal(C.retryAfterSecondsForLease(NOW - 5000, NOW), 1);
});

test("RL-3.4: a COMPLETING upload reserves its full size for assembly, on top of the other reservations", () => {
  const rows = [
    { expectedBytes: 100 * MIB, receivedBytes: 100 * MIB, ...noLease, assemblyBytes: 100 * MIB }, // COMPLETING
    { expectedBytes: 50 * MIB, receivedBytes: 10 * MIB, ...lease(8 * MIB) }, // ACTIVE, unchanged rules
  ];
  const r = C.computeReservations(rows, NOW);
  assert.deepEqual(r, { reservedUploads: 32 * MIB, reservedChunks: 16 * MIB, reservedAssembly: 100 * MIB, inflightLeaseBytes: 8 * MIB });

  const minFree = 5 * 1024 * MIB;
  const exact = 32 * MIB + 16 * MIB + 100 * MIB + minFree;
  assert.deepEqual(C.decideCapacity({ freeBytes: exact, reservations: r }, { ...CONFIG, minFreeBytes: minFree }), { ok: true, headroomBytes: 0 });
  assert.deepEqual(C.decideCapacity({ freeBytes: exact - 1, reservations: r }, { ...CONFIG, minFreeBytes: minFree }), {
    ok: false, reason: "INSUFFICIENT_STORAGE", shortfallBytes: 1,
  });
});

test("RL-3.4: assembly reservations are validated (non-negative integer, at most the upload size)", () => {
  const base = { expectedBytes: 100, receivedBytes: 100, ...noLease };
  for (const bad of [-1, 1.5, 101, Number.NaN, "100"]) {
    assert.throws(() => C.computeReservations([{ ...base, assemblyBytes: bad }], NOW), /Invalid reservation/);
  }
  assert.equal(C.computeReservations([{ ...base }], NOW).reservedAssembly, 0, "absent means 0");
});
