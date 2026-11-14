import type { RecordedLectureConfig } from "./config";

/*
 * Chunk leases and disk-capacity reservations: the pure calculations
 * (Recorded Lectures RL-1, plan v7/v8). The database parts (writing the
 * lease or the upload row under the global capacity lock, then running the
 * aggregate over the rows INCLUDING that candidate) come in RL-3; they feed
 * the rows to these functions.
 *
 * For every active upload u (not expired, not failed, not finished):
 *
 *   L_u           = leaseBytes when the lease is current, else 0
 *   outstanding_u = (expectedBytes - receivedBytes) - L_u
 *   chunkRes_u    = 2 * L_u   (the chunk's scratch copy, plus the same bytes
 *                              appended to the temporary upload file while
 *                              both exist)
 *
 *   assembly_u    = assemblyBytes (RL-3.4: expectedBytes for a COMPLETING
 *                   session, whose assembled file grows to the full size
 *                   while every chunk file still exists; 0 otherwise)
 *
 *   allowed when  free - sum(outstanding_u) - sum(chunkRes_u) - sum(assembly_u) >= minFreeBytes
 *
 * A candidate (new upload or new lease) must already be among the rows; no
 * extra "request bytes" term is added. Bytes already written to disk are
 * counted by the filesystem's free space, never reserved again (except the
 * full 2L of a current lease, a deliberate, bounded overestimate).
 */

export type ReservationRow = {
  expectedBytes: number;
  receivedBytes: number;
  leaseBytes: number | null;
  /** Epoch ms; null without a lease. */
  leaseExpiresAtMs: number | null;
  /** Bytes reserved for assembling the upload (RL-3.4; at most expectedBytes). Default 0. */
  assemblyBytes?: number;
};

export type Reservations = {
  reservedUploads: number;
  reservedChunks: number;
  /** Sum of assembly reservations (COMPLETING uploads, RL-3.4). */
  reservedAssembly: number;
  /** Sum of current lease sizes (limited by maxInflightChunkBytes). */
  inflightLeaseBytes: number;
};

function assertNonNegativeInteger(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid reservation row.");
  }
}

export function isLeaseCurrent(row: Pick<ReservationRow, "leaseBytes" | "leaseExpiresAtMs">, nowMs: number): boolean {
  return row.leaseBytes !== null && row.leaseExpiresAtMs !== null && row.leaseExpiresAtMs > nowMs;
}

/** Sums the reservations of the given active uploads. Invalid rows throw (fail closed). */
export function computeReservations(rows: readonly ReservationRow[], nowMs: number): Reservations {
  let reservedUploads = 0;
  let reservedChunks = 0;
  let reservedAssembly = 0;
  let inflightLeaseBytes = 0;

  for (const row of rows) {
    assertNonNegativeInteger(row.expectedBytes);
    assertNonNegativeInteger(row.receivedBytes);
    if (row.receivedBytes > row.expectedBytes) throw new Error("Invalid reservation row.");
    if (row.leaseBytes !== null) assertNonNegativeInteger(row.leaseBytes);

    const lease = isLeaseCurrent(row, nowMs) ? (row.leaseBytes as number) : 0;
    const remaining = row.expectedBytes - row.receivedBytes;
    if (lease > remaining) throw new Error("Invalid reservation row.");

    const assembly = row.assemblyBytes ?? 0;
    assertNonNegativeInteger(assembly);
    if (assembly > row.expectedBytes) throw new Error("Invalid reservation row.");

    reservedUploads += remaining - lease;
    reservedChunks += 2 * lease;
    reservedAssembly += assembly;
    inflightLeaseBytes += lease;
  }

  if (!Number.isSafeInteger(reservedUploads + reservedChunks + reservedAssembly)) throw new Error("Invalid reservation total.");
  return { reservedUploads, reservedChunks, reservedAssembly, inflightLeaseBytes };
}

export type CapacityDecision =
  | { ok: true; headroomBytes: number }
  | { ok: false; reason: "INSUFFICIENT_STORAGE"; shortfallBytes: number }
  | { ok: false; reason: "INFLIGHT_CHUNK_CAP"; shortfallBytes: number };

/**
 * The decision for a candidate already included in `reservations`.
 * Exactly fitting (headroom 0) is allowed.
 */
export function decideCapacity(
  input: { freeBytes: number; reservations: Reservations },
  config: Pick<RecordedLectureConfig, "minFreeBytes" | "maxInflightChunkBytes">
): CapacityDecision {
  assertNonNegativeInteger(input.freeBytes);
  const { reservedUploads, reservedChunks, inflightLeaseBytes } = input.reservations;
  const reservedAssembly = input.reservations.reservedAssembly ?? 0;

  if (inflightLeaseBytes > config.maxInflightChunkBytes) {
    return { ok: false, reason: "INFLIGHT_CHUNK_CAP", shortfallBytes: inflightLeaseBytes - config.maxInflightChunkBytes };
  }
  const headroom = input.freeBytes - reservedUploads - reservedChunks - reservedAssembly - config.minFreeBytes;
  if (headroom < 0) return { ok: false, reason: "INSUFFICIENT_STORAGE", shortfallBytes: -headroom };
  return { ok: true, headroomBytes: headroom };
}

/** When a lease granted now expires. */
export function leaseExpiresAtMs(nowMs: number, config: Pick<RecordedLectureConfig, "chunkLeaseSeconds">): number {
  return nowMs + config.chunkLeaseSeconds * 1000;
}

/** Seconds a client should wait before retrying while another chunk's lease is current (at least 1). */
export function retryAfterSecondsForLease(leaseExpiresAt: number, nowMs: number): number {
  return Math.max(1, Math.ceil((leaseExpiresAt - nowMs) / 1000));
}

// RL-3.5: scratchFileDisposition (which treated committed chunk files as scratch) is retired;
// file cleanup decisions are in cleanup-rules.ts.
