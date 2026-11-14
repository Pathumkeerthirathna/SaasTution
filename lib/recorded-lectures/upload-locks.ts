import type { Prisma } from "@prisma/client";

/*
 * Recorded Lectures (RL-3.1): locks for the upload APIs.
 *
 * 1. PostgreSQL advisory locks, transaction level (pg_advisory_xact_lock,
 *    released at COMMIT / ROLLBACK), taken only inside an interactive
 *    transaction whose lock waits are bounded by SET LOCAL lock_timeout
 *    (setUploadLockTimeout, always first). Lock order, never reversed:
 *      1. teacher lock  (start only: the active-upload cap per teacher);
 *      2. capacity lock (every write that ADDS a disk reservation: a new
 *         upload session or a new chunk lease).
 *    Writes that only release a reservation (chunk commit, cancel, expiry)
 *    take neither.
 *
 * 2. An IN-PROCESS keyed mutex (UploadMutex) around everything that touches
 *    an upload's files (lease -> stream -> commit, completion, cancellation
 *    cleanup). Lock order everywhere: this mutex first, then database locks.
 *    It is a JavaScript object in ONE Node.js process: it does NOT protect
 *    against another process (a second PM2 instance, a cluster worker, a
 *    separate script, another server sharing the storage directory).
 *    Production runs exactly one Next.js process; that topology is a
 *    requirement of this design, not something the mutex can enforce. The
 *    database lease does not fence a stale writer's file writes either: a
 *    request whose lease expired can still be writing when another request
 *    takes the lease over. Chunk uploads are fenced by Option B instead
 *    (each chunk is its own lease-token file, never shared; RL-3.3).
 *
 * Filesystem concurrency requirements (docs/recorded-lecture-uploads.md):
 *   - exactly one application process may write to FILE_STORAGE_ROOT in the
 *     initial deployment (completion and cleanup rely on it);
 *   - development and production must not share the same storage root;
 *   - cleanup workers must not delete files of an upload with an active
 *     lease, nor any committed chunk file of a non-final upload;
 *   - this in-process mutex is NOT cross-process protection;
 *   - database leases do NOT fence stale filesystem writes;
 *   - completion (RL-3.4) uses a unique claim, claim-specific assembly paths
 *     and a READY transition conditional on that claim.
 * Per-chunk SHA-256 verification before READY (D5, same document) detects a
 * corrupted file at the moment it is read; it does not prevent a write that
 * happens after verification.
 */

type Tx = Prisma.TransactionClient;

export const RECORDED_LECTURE_LOCK_NAMESPACE = "recorded-lectures";

/** Upper bound for any advisory / row lock wait in an upload transaction (SET LOCAL lock_timeout). */
export const RECORDED_LECTURE_LOCK_TIMEOUT_MS = 3_000;

/** Options of every upload interactive transaction (as attendance and breakout). */
export const RECORDED_LECTURE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/** RL-3.4: a running completion job refreshes its claim's heartbeat (session lastActivityAt) this often. */
export const COMPLETION_HEARTBEAT_MS = 30_000;

/** RL-3.4: a COMPLETING claim without a heartbeat for this long is stale: it may be taken over or cancelled. */
export const COMPLETION_CLAIM_STALE_MS = 10 * 60_000;

/** Whether a COMPLETING claim's heartbeat is stale at `nowMs` (the server clock). */
export function isCompletionClaimStale(lastActivityAt: Date, nowMs: number): boolean {
  return nowMs - lastActivityAt.getTime() >= COMPLETION_CLAIM_STALE_MS;
}

/**
 * RL-3.5: at most this many chunk writers per process, counted from before the
 * lease grant until the chunk's file write has fully settled (also after its
 * deadline). With pieces of at most MAX_WRITE_PIECE_BYTES (chunk-stream.ts),
 * writers past their deadline can still add at most
 * MAX_CONCURRENT_CHUNK_WRITERS x 64 KiB that no reservation covers.
 */
export const MAX_CONCURRENT_CHUNK_WRITERS = 32;

/** RL-3.5: at most this many completion jobs per process (each assembles a whole recording). */
export const MAX_CONCURRENT_COMPLETION_JOBS = 4;

/** A fixed number of slots, taken without waiting (single process; globalThis singletons below). */
export class SlotLimiter {
  private used = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Invalid slot limit.");
  }

  /** A release function, or null when every slot is taken. Releasing twice does nothing. */
  tryAcquire(): (() => void) | null {
    if (this.used >= this.limit) return null;
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
    };
  }

  get inUse(): number {
    return this.used;
  }
}

const slotState = globalThis as unknown as { slRecordedLectureChunkWriters?: SlotLimiter };

/** This process's chunk-writer slots. */
export function getChunkWriterSlots(): SlotLimiter {
  if (!slotState.slRecordedLectureChunkWriters) slotState.slRecordedLectureChunkWriters = new SlotLimiter(MAX_CONCURRENT_CHUNK_WRITERS);
  return slotState.slRecordedLectureChunkWriters;
}

/** Default bound for waiting on the in-process upload mutex. */
export const UPLOAD_MUTEX_DEFAULT_TIMEOUT_MS = 2_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${name} must be a lowercase UUID.`);
  return value;
}

/** Advisory-lock key serializing one teacher's upload starts (active-upload cap). */
export function teacherUploadLockKey(teacherId: string): string {
  return `${RECORDED_LECTURE_LOCK_NAMESPACE}:teacher:${requireUuid(teacherId, "teacherId")}`;
}

/** Advisory-lock key serializing every write that adds a disk reservation (one global key). */
export const CAPACITY_LOCK_KEY = `${RECORDED_LECTURE_LOCK_NAMESPACE}:capacity`;

/** In-process mutex key of one upload session. */
export function uploadMutexKey(uploadId: string): string {
  return `${RECORDED_LECTURE_LOCK_NAMESPACE}:upload:${requireUuid(uploadId, "uploadId")}`;
}

function assertInTransaction(tx: Tx) {
  // An interactive transaction client has no $transaction method of its own.
  if (!tx || typeof tx !== "object" || "$transaction" in tx) {
    throw new Error("Recorded lecture locks must be taken inside an interactive transaction.");
  }
}

/** Bounds this transaction's lock waits; run first in every upload transaction. */
export async function setUploadLockTimeout(tx: Tx): Promise<void> {
  assertInTransaction(tx);
  // SET cannot take a bind parameter; the value is a module constant.
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${RECORDED_LECTURE_LOCK_TIMEOUT_MS}ms'`);
}

/** Level 1: one teacher's upload starts. */
export async function lockTeacherUploads(tx: Tx, teacherId: string): Promise<void> {
  assertInTransaction(tx);
  const key = teacherUploadLockKey(teacherId);
  // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** Level 2: the global capacity lock. */
export async function lockUploadCapacity(tx: Tx): Promise<void> {
  assertInTransaction(tx);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK_KEY}, 0))`;
}

// ---- In-process keyed mutex ----------------------------------------------------------------------

/** The mutex could not be acquired within the allowed time (another request holds it). */
export class UploadMutexTimeoutError extends Error {
  constructor() {
    super("The upload is busy.");
    this.name = "UploadMutexTimeoutError";
  }
}

export function isUploadMutexTimeoutError(error: unknown): error is UploadMutexTimeoutError {
  return error instanceof Error && error.name === "UploadMutexTimeoutError";
}

/** Releases the mutex; calling it again does nothing. */
export type UploadMutexRelease = () => void;

type Waiter = { grant: () => void };
type Entry = { held: boolean; waiters: Waiter[] };

/**
 * Exclusive per-key lock, FIFO, with a bounded wait. Single process only
 * (see the module comment). A key's entry is removed when it is neither held
 * nor awaited, so idle keys use no memory.
 */
export class UploadMutex {
  private readonly entries = new Map<string, Entry>();

  /** Waits at most `timeoutMs` (0: only if free now); rejects with UploadMutexTimeoutError. */
  acquire(key: string, options: { timeoutMs?: number } = {}): Promise<UploadMutexRelease> {
    if (typeof key !== "string" || key === "") return Promise.reject(new TypeError("A mutex key is required."));
    const timeoutMs = options.timeoutMs ?? UPLOAD_MUTEX_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new TypeError("Invalid mutex timeout."));

    let entry = this.entries.get(key);
    if (!entry) {
      entry = { held: false, waiters: [] };
      this.entries.set(key, entry);
    }
    if (!entry.held) {
      entry.held = true;
      return Promise.resolve(this.releaseFor(key, entry));
    }
    if (timeoutMs === 0) return Promise.reject(new UploadMutexTimeoutError());

    const current = entry;
    return new Promise<UploadMutexRelease>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve(this.releaseFor(key, current));
        },
      };
      const timer = setTimeout(() => {
        const index = current.waiters.indexOf(waiter);
        if (index !== -1) current.waiters.splice(index, 1);
        this.forgetIfIdle(key, current);
        reject(new UploadMutexTimeoutError());
      }, timeoutMs);
      current.waiters.push(waiter);
    });
  }

  /** Runs `fn` holding the key's mutex; always releases it, also when `fn` throws. */
  async withLock<T>(key: string, fn: () => Promise<T> | T, options: { timeoutMs?: number } = {}): Promise<T> {
    const release = await this.acquire(key, options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  isHeld(key: string): boolean {
    return this.entries.get(key)?.held === true;
  }

  /** Number of keys currently held or awaited (diagnostics, tests). */
  get size(): number {
    return this.entries.size;
  }

  private releaseFor(key: string, entry: Entry): UploadMutexRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = entry.waiters.shift();
      if (next) {
        // Ownership passes directly to the next waiter: `held` stays true.
        next.grant();
      } else {
        entry.held = false;
        this.forgetIfIdle(key, entry);
      }
    };
  }

  private forgetIfIdle(key: string, entry: Entry) {
    if (!entry.held && entry.waiters.length === 0 && this.entries.get(key) === entry) this.entries.delete(key);
  }
}

const state = globalThis as unknown as { slRecordedLectureUploadMutex?: UploadMutex };

/** The process-wide upload mutex (one per Node.js process: globalThis, so it survives module reloads). */
export function getUploadMutex(): UploadMutex {
  if (!state.slRecordedLectureUploadMutex) state.slRecordedLectureUploadMutex = new UploadMutex();
  return state.slRecordedLectureUploadMutex;
}
