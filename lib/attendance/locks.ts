/**
 * Row locks and transactions of the attendance services.
 * See docs/lecture-attendance.md ("Locking").
 *
 * Global lock order (every path takes a subset, in this order):
 *   1. Student            FOR SHARE         (evidence, finalization, teacher decisions and review answers)
 *   2. Lecture            FOR SHARE / FOR NO KEY UPDATE
 *   3. Class              FOR KEY SHARE
 *   4. Register           FOR KEY SHARE / FOR UPDATE (or its own insert)
 *   5. LectureAttendance  FOR NO KEY UPDATE, ascending studentId
 *   6. inserts and audit rows
 * AttendanceLocks enforces it at run time: a lock below the highest level
 * already held, a second row of a single-row level, records out of studentId
 * order, a lock upgrade, or any lock after the first audit write throws
 * AttendanceLockOrderError (a programming error, never a user error).
 * Re-locking a row already held in an equal or stronger mode is allowed: it
 * cannot wait. A request that finds no row holds nothing and does not move
 * the transaction's place in the order.
 *
 * Write phase (enforced, not a convention): callers never see the raw
 * transaction. `locks.db` exposes the Prisma models but no raw SQL, and
 * refuses every model write until locks.beginWrites(); after it, every lock
 * request is refused. The only writes before it are this module's lock-phase
 * inserts (insertRegisterIfAbsent with its CREATED audit, insertRecordIfAbsent),
 * each inserting the very row the transaction then holds.
 *
 * Database errors: never caught inside the transaction (a failed statement
 * aborts it; nothing more may be sent). They propagate, the transaction rolls
 * back, and only then are lock errors mapped to 409 ATTENDANCE_BUSY.
 *
 * Every lock is a raw, parameterised SELECT ... FOR ... (static SQL text; the
 * lock mode is part of the text, never interpolated), so a lock timeout or
 * deadlock surfaces as P2010 with its SQLSTATE and maps to 409
 * ATTENDANCE_BUSY. Rows are re-read under the lock (READ COMMITTED: each
 * statement sees what is committed when it runs).
 *
 * Transactions: the database default isolation, READ COMMITTED (never
 * overridden), SET LOCAL lock_timeout = 3000ms as the first statement, and
 * { maxWait: 5000, timeout: 15000 }, like the session start and the student
 * decisions: a lock wait always ends long before the transaction expires.
 */

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { mapAttendanceLockError } from "@/lib/attendance/service-errors";
import { prisma } from "@/lib/prisma";

export const ATTENDANCE_LOCK_TIMEOUT_MS = 3_000;
/** D6: the most students one finalization may lock and create ABSENT records for. */
export const FINALIZATION_MAX_STUDENTS = 500;
export const ATTENDANCE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

type Tx = Prisma.TransactionClient;

export type LockLevel = "STUDENT" | "LECTURE" | "CLASS" | "REGISTER" | "RECORDS";
type LockMode = "KEY_SHARE" | "SHARE" | "NO_KEY_UPDATE" | "UPDATE";

const LEVEL_RANK: Record<LockLevel, number> = { STUDENT: 1, LECTURE: 2, CLASS: 3, REGISTER: 4, RECORDS: 5 };

// Each mode conflicts with a superset of what the previous one conflicts
// with, so holding a stronger mode covers a weaker request (no new wait).
const MODE_STRENGTH: Record<LockMode, number> = { KEY_SHARE: 1, SHARE: 2, NO_KEY_UPDATE: 3, UPDATE: 4 };

export class AttendanceLockOrderError extends Error {
  constructor(message: string) {
    super(`Attendance lock order violated: ${message}`);
    this.name = "AttendanceLockOrderError";
  }
}

// Module-private: only this module can construct AttendanceLocks.
const CONSTRUCTION_TOKEN: unique symbol = Symbol("AttendanceLocks");

/**
 * A transaction client that is not a top-level PrismaClient: a real
 * interactive-transaction client (which has no $transaction) or a test double.
 * A PrismaClient does not fit (its $transaction is a function), so lock
 * tracking can never be attached to autocommit statements.
 */
type TransactionOnly = Tx & { $transaction?: never };

/**
 * What callers get instead of the raw transaction: the same Prisma models,
 * but no raw SQL ($queryRaw / $executeRaw and friends: locks and the
 * lock-phase inserts only go through this module's helpers), and every model
 * WRITE refused until beginWrites(). Reads are always allowed. Any other
 * member is refused (fail closed).
 */
export type AttendanceDb = Omit<
  Tx,
  "$queryRaw" | "$queryRawUnsafe" | "$executeRaw" | "$executeRawUnsafe" | "$queryRawTyped"
>;

const READ_METHODS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

// Module-private: the raw transaction client behind each AttendanceLocks.
// A WeakMap (not a property) so nothing outside this module can reach it,
// even from plain JavaScript.
const RAW_TX = new WeakMap<AttendanceLocks, Tx>();
// Module-private: the AttendanceLocks created by runFinalizationTransaction.
const FINALIZATION_SCOPE = new WeakSet<AttendanceLocks>();

function rawOf(locks: AttendanceLocks): Tx {
  const tx = RAW_TX.get(locks);
  if (!tx) throw new Error("AttendanceLocks has no transaction.");
  return tx;
}

/**
 * The locks one transaction holds, and its place in the global order.
 *
 * Only runAttendanceTransaction creates instances (private constructor,
 * module-private token), so every lock and write made through it belongs to
 * one transaction with the attendance lock timeout: never autocommit.
 * `new AttendanceLocks(prisma)` does not compile, and throws at run time.
 *
 * Write phase: model writes through `db` are refused until beginWrites();
 * after it, no lock may be requested. The only writes before it are the
 * lock-phase inserts of this module (a new register with its CREATED audit,
 * a new record): each inserts the very row the transaction then holds, at
 * that row's level in the order.
 */
export class AttendanceLocks {
  private rank = 0;
  private readonly held = new Map<string, { level: LockLevel; strength: number }>();
  private lastRecordStudentId: string | null = null;
  private wrote = false;
  private guardedDb: AttendanceDb | null = null;
  private studentSetLocked = false;
  /** Locks granted, in order ("LEVEL:MODE:id"), for diagnostics and tests. */
  readonly trail: string[] = [];

  private constructor(token: typeof CONSTRUCTION_TOKEN, tx: Tx) {
    if (token !== CONSTRUCTION_TOKEN) {
      throw new Error("AttendanceLocks can only be created by runAttendanceTransaction.");
    }
    RAW_TX.set(this, tx);
  }

  /** @internal Module use only: needs the module-private token. */
  static fromTransaction(token: typeof CONSTRUCTION_TOKEN, tx: TransactionOnly, finalizationScope = false): AttendanceLocks {
    const locks = new AttendanceLocks(token, tx);
    if (finalizationScope) FINALIZATION_SCOPE.add(locks);
    return locks;
  }

  /** True only inside runFinalizationTransaction (the only scope allowed a multi-row Student lock). */
  get finalization(): boolean {
    return FINALIZATION_SCOPE.has(this);
  }

  /**
   * @internal The finalization Student set (D8): only in the finalization
   * scope, only as the FIRST lock of the transaction (nothing held yet), at
   * most once, at most FINALIZATION_MAX_STUDENTS ids, strictly ascending
   * (sorted, no duplicates). After it, the single-row Student rule applies
   * as usual: a further Student lock is refused unless it re-enters a held
   * row.
   */
  checkStudentSet(studentIds: readonly string[]) {
    if (!this.finalization) {
      throw new AttendanceLockOrderError("a Student set may only be locked by the finalization transaction.");
    }
    if (this.wrote) throw new AttendanceLockOrderError("STUDENT lock requested after writes began.");
    if (this.studentSetLocked) throw new AttendanceLockOrderError("the Student set was already locked.");
    if (this.rank !== 0 || this.held.size !== 0) {
      throw new AttendanceLockOrderError("the Student set must be the first lock of the transaction.");
    }
    if (studentIds.length > FINALIZATION_MAX_STUDENTS) {
      throw new AttendanceLockOrderError(`more than ${FINALIZATION_MAX_STUDENTS} students requested.`);
    }
    for (let i = 1; i < studentIds.length; i += 1) {
      if (!(studentIds[i - 1] < studentIds[i])) {
        throw new AttendanceLockOrderError("the Student set must be strictly ascending (sorted, no duplicates).");
      }
    }
    this.studentSetLocked = true;
  }

  /** The transaction's models, write-guarded (see AttendanceDb). */
  get db(): AttendanceDb {
    if (!this.guardedDb) this.guardedDb = guardDb(this, rawOf(this));
    return this.guardedDb;
  }

  /** True once beginWrites() was called. */
  get writing(): boolean {
    return this.wrote;
  }

  /** @internal Checks a lock request before it is sent. Returns true when it re-enters a held row. */
  check(level: LockLevel, id: string, mode: LockMode): boolean {
    if (this.wrote) throw new AttendanceLockOrderError(`${level} lock requested after writes began.`);

    const current = this.held.get(`${level}:${id}`);
    if (current && current.strength >= MODE_STRENGTH[mode]) return true;

    if (LEVEL_RANK[level] < this.rank) {
      throw new AttendanceLockOrderError(`${level} requested after a later level.`);
    }

    if (level !== "RECORDS" && [...this.held.entries()].some(([key, h]) => h.level === level && key !== `${level}:${id}`)) {
      throw new AttendanceLockOrderError(`a second ${level} row requested.`);
    }

    if (current) {
      // Two transactions upgrading the same row (e.g. KEY SHARE to UPDATE)
      // deadlock each other: every path takes its final mode first.
      throw new AttendanceLockOrderError(`${level} lock upgrade requested.`);
    }

    return false;
  }

  /** @internal Records a granted lock (only when a row was actually locked). */
  granted(level: LockLevel, id: string, mode: LockMode) {
    const key = `${level}:${id}`;
    const strength = Math.max(this.held.get(key)?.strength ?? 0, MODE_STRENGTH[mode]);
    this.held.set(key, { level, strength });
    this.rank = Math.max(this.rank, LEVEL_RANK[level]);
    this.trail.push(`${level}:${mode}:${id}`);
  }

  /**
   * @internal Records are requested in ascending studentId. The same student
   * again is allowed (held: no wait; not held: the earlier request found no
   * row, e.g. before its insert), a smaller one is not.
   */
  checkRecordOrder(studentIds: string[]) {
    for (const id of studentIds) {
      if (this.lastRecordStudentId !== null && id < this.lastRecordStudentId) {
        throw new AttendanceLockOrderError("records requested out of studentId order.");
      }
      this.lastRecordStudentId = id;
    }
  }

  /** @internal Whether this transaction holds the row in at least `mode`. */
  holds(level: LockLevel, id: string, mode: LockMode): boolean {
    return (this.held.get(`${level}:${id}`)?.strength ?? 0) >= MODE_STRENGTH[mode];
  }

  /** Starts the write phase: model writes are allowed, no lock may be requested any more. */
  beginWrites() {
    this.wrote = true;
  }
}

function guardDb(locks: AttendanceLocks, tx: Tx): AttendanceDb {
  return new Proxy({} as AttendanceDb, {
    get(_, member) {
      // Not a thenable (awaiting it by mistake must not reach the client).
      if (member === "then" || typeof member === "symbol") return undefined;
      if (member.startsWith("$")) {
        throw new AttendanceLockOrderError(`${member} is not available through locks.db; use the lock helpers.`);
      }

      const delegate = (tx as unknown as Record<string, unknown>)[member];
      if (!delegate || typeof delegate !== "object") {
        throw new AttendanceLockOrderError(`locks.db.${member} is not a model.`);
      }

      return new Proxy(delegate as Record<string, unknown>, {
        get(target, method) {
          if (typeof method !== "string") return undefined;
          const fn = target[method];
          if (typeof fn !== "function") {
            throw new AttendanceLockOrderError(`locks.db.${member}.${method} is not available.`);
          }
          if (READ_METHODS.has(method)) return (...args: unknown[]) => fn.apply(target, args);
          if (WRITE_METHODS.has(method)) {
            return (...args: unknown[]) => {
              if (!locks.writing) {
                throw new AttendanceLockOrderError(`${member}.${method} called before beginWrites().`);
              }
              return fn.apply(target, args);
            };
          }
          throw new AttendanceLockOrderError(`locks.db.${member}.${method} is not allowed.`);
        },
      });
    },
  });
}

/**
 * Runs `work` in one attendance transaction (see the header). A lock
 * timeout, deadlock or serialization failure becomes 409 ATTENDANCE_BUSY;
 * every other error is rethrown unchanged. The whole transaction rolls back
 * on any error.
 */
export async function runAttendanceTransaction<T>(work: (locks: AttendanceLocks) => Promise<T>): Promise<T> {
  return runScoped(work, false);
}

/**
 * The finalization transaction (Stage 5.5b): exactly runAttendanceTransaction
 * (same isolation, lock timeout, limits and error mapping), plus the
 * finalization scope, the only one in which lockStudentSetForFinalization
 * and createFinalizationAbsences are allowed. Only the finalization service
 * may call it (a guard test checks the importers).
 */
export async function runFinalizationTransaction<T>(work: (locks: AttendanceLocks) => Promise<T>): Promise<T> {
  return runScoped(work, true);
}

async function runScoped<T>(work: (locks: AttendanceLocks) => Promise<T>, finalizationScope: boolean): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      // SET cannot take a bind parameter; the value is a module constant.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${ATTENDANCE_LOCK_TIMEOUT_MS}ms'`);
      return work(AttendanceLocks.fromTransaction(CONSTRUCTION_TOKEN, tx, finalizationScope));
    }, ATTENDANCE_TRANSACTION_OPTIONS);
  } catch (error) {
    throw mapAttendanceLockError(error);
  }
}

/**
 * TESTS ONLY: lock tracking over a transaction double, to unit-test the
 * lock-order rules without a database. Refuses a top-level PrismaClient at
 * compile time and at run time (anything with a $transaction function), so
 * it cannot be used to lock in autocommit mode. Application code must use
 * runAttendanceTransaction (a guard test checks that only tests import this).
 */
export function createAttendanceLocksForTesting(tx: TransactionOnly): AttendanceLocks {
  if (typeof (tx as { $transaction?: unknown }).$transaction === "function") {
    throw new Error("createAttendanceLocksForTesting refuses a top-level Prisma client.");
  }
  return AttendanceLocks.fromTransaction(CONSTRUCTION_TOKEN, tx);
}

// ---- Row shapes ---------------------------------------------------------------------

export type LockedStudent = {
  id: string;
  teacherId: string;
  status: number;
  confirmationStatus: "PENDING" | "APPROVED" | "REJECTED";
  confirmedAt: Date | null;
  approvedAt: Date | null;
};

export type LockedLecture = {
  id: string;
  classId: string;
  status: number;
  classStatus: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  date: Date;
  endDate: Date | null;
};

export type LockedClass = {
  id: string;
  teacherId: string;
  status: number;
  attendanceGraceMinutes: number;
};

export type LockedRegister = {
  lectureId: string;
  classId: string;
  scheduledStartAt: Date;
  scheduledEndAt: Date | null;
  graceMinutes: number;
  finalizedAt: Date | null;
  finalizedByTeacherId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LockedRecord = {
  id: string;
  lectureId: string;
  classId: string;
  studentId: string;
  status: "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";
  statusSource: "AUTO" | "TEACHER" | "FINALIZATION" | "BACKFILL";
  firstOnlineAt: Date | null;
  firstQrAt: Date | null;
  autoStatus: "PRESENT" | "LATE" | null;
  teacherStatus: "PRESENT" | "LATE" | "ABSENT" | "EXCUSED" | null;
  teacherDecidedAt: Date | null;
  teacherDecidedById: string | null;
  pendingReviewSince: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

// ---- Level 1: Student ------------------------------------------------------------------

/** Student FOR SHARE (conflicts with a decision's FOR NO KEY UPDATE). Null when absent. */
export async function lockStudentShared(locks: AttendanceLocks, studentId: string): Promise<LockedStudent | null> {
  locks.check("STUDENT", studentId, "SHARE");
  const rows = await rawOf(locks).$queryRaw<LockedStudent[]>`
    SELECT "id", "teacherId", "status", "confirmationStatus"::text AS "confirmationStatus", "confirmedAt", "approvedAt"
    FROM "Student" WHERE "id" = ${studentId} FOR SHARE`;
  if (rows[0]) locks.granted("STUDENT", studentId, "SHARE");
  return rows[0] ?? null;
}

/**
 * FINALIZATION ONLY (D8): every candidate Student row FOR SHARE, in one
 * parameterised statement, in ascending id (ORDER BY "id": PostgreSQL locks
 * the rows in the sorted order, the same order the bulk student decision
 * uses), as the FIRST lock of the finalization transaction. FOR SHARE
 * conflicts with a student decision's FOR NO KEY UPDATE and with every
 * UPDATE of the row (deactivation, deletion), so none of them can commit
 * until finalization ends; a decision that committed before is fully
 * visible (its status and history row commit together). Returns the rows
 * found (a missing row holds nothing); the caller must compare them with the
 * ids requested and fail closed on any difference.
 */
export async function lockStudentSetForFinalization(locks: AttendanceLocks, studentIds: readonly string[]): Promise<LockedStudent[]> {
  locks.checkStudentSet(studentIds);
  if (studentIds.length === 0) return [];
  const ids = [...studentIds];
  const rows = await rawOf(locks).$queryRaw<LockedStudent[]>`
    SELECT "id", "teacherId", "status", "confirmationStatus"::text AS "confirmationStatus", "confirmedAt", "approvedAt"
    FROM "Student" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR SHARE`;
  for (const row of rows) locks.granted("STUDENT", row.id, "SHARE");
  return rows;
}

// ---- Level 2: Lecture --------------------------------------------------------------------

/** Lecture FOR SHARE (finalization, register creation). Null when absent. */
export async function lockLectureShared(locks: AttendanceLocks, lectureId: string): Promise<LockedLecture | null> {
  locks.check("LECTURE", lectureId, "SHARE");
  const rows = await rawOf(locks).$queryRaw<LockedLecture[]>`
    SELECT "id", "classId", "status", "classStatus"::text AS "classStatus", "date", "endDate"
    FROM "Lecture" WHERE "id" = ${lectureId} FOR SHARE`;
  if (rows[0]) locks.granted("LECTURE", lectureId, "SHARE");
  return rows[0] ?? null;
}

/** Lecture FOR NO KEY UPDATE (lecture edits, status changes, deletion). Null when absent. */
export async function lockLectureForUpdate(locks: AttendanceLocks, lectureId: string): Promise<LockedLecture | null> {
  locks.check("LECTURE", lectureId, "NO_KEY_UPDATE");
  const rows = await rawOf(locks).$queryRaw<LockedLecture[]>`
    SELECT "id", "classId", "status", "classStatus"::text AS "classStatus", "date", "endDate"
    FROM "Lecture" WHERE "id" = ${lectureId} FOR NO KEY UPDATE`;
  if (rows[0]) locks.granted("LECTURE", lectureId, "NO_KEY_UPDATE");
  return rows[0] ?? null;
}

// ---- Level 3: Class ------------------------------------------------------------------------

/**
 * Class FOR KEY SHARE, taken explicitly before any insert that references
 * the class: the fee-waiver rule edits hold Class FOR UPDATE, and an
 * implicit foreign-key wait inside a model insert would not be classified as
 * retryable. Null when absent.
 */
export async function lockClassKeyShared(locks: AttendanceLocks, classId: string): Promise<LockedClass | null> {
  locks.check("CLASS", classId, "KEY_SHARE");
  const rows = await rawOf(locks).$queryRaw<LockedClass[]>`
    SELECT "id", "teacherId", "status", "attendanceGraceMinutes"
    FROM "Class" WHERE "id" = ${classId} FOR KEY SHARE`;
  if (rows[0]) locks.granted("CLASS", classId, "KEY_SHARE");
  return rows[0] ?? null;
}

// ---- Level 4: Register ---------------------------------------------------------------------

/** Register FOR KEY SHARE (evidence, teacher actions). Null when there is no register. */
export async function lockRegisterKeyShared(locks: AttendanceLocks, lectureId: string): Promise<LockedRegister | null> {
  locks.check("REGISTER", lectureId, "KEY_SHARE");
  const rows = await rawOf(locks).$queryRaw<LockedRegister[]>`
    SELECT "lectureId", "classId", "scheduledStartAt", "scheduledEndAt", "graceMinutes", "finalizedAt",
           "finalizedByTeacherId", "version", "createdAt", "updatedAt"
    FROM "LectureAttendanceRegister" WHERE "lectureId" = ${lectureId} FOR KEY SHARE`;
  if (rows[0]) locks.granted("REGISTER", lectureId, "KEY_SHARE");
  return rows[0] ?? null;
}

/** Register FOR UPDATE (finalization, grace and schedule changes): waits for every KEY SHARE holder. */
export async function lockRegisterForUpdate(locks: AttendanceLocks, lectureId: string): Promise<LockedRegister | null> {
  locks.check("REGISTER", lectureId, "UPDATE");
  const rows = await rawOf(locks).$queryRaw<LockedRegister[]>`
    SELECT "lectureId", "classId", "scheduledStartAt", "scheduledEndAt", "graceMinutes", "finalizedAt",
           "finalizedByTeacherId", "version", "createdAt", "updatedAt"
    FROM "LectureAttendanceRegister" WHERE "lectureId" = ${lectureId} FOR UPDATE`;
  if (rows[0]) locks.granted("REGISTER", lectureId, "UPDATE");
  return rows[0] ?? null;
}

/**
 * Lock-phase creation of the register (version 1, open) and, only when THIS
 * transaction inserted it, its CREATED audit (version 1): one unit, in the
 * same transaction, so a failing audit rolls the register back.
 * INSERT ... ON CONFLICT ("lectureId") DO NOTHING: a concurrent creator's
 * uncommitted insert makes this wait (bounded by lock_timeout) and then
 * insert nothing. Returns true when this transaction inserted it (it then
 * holds the new row). The audit references only that new row, so it cannot
 * make anyone wait. Timestamps are sent as UTC ISO text and converted
 * explicitly, so the session time zone never shifts the stored digits.
 */
export async function insertRegisterIfAbsent(
  locks: AttendanceLocks,
  data: {
    lectureId: string;
    classId: string;
    scheduledStartAt: Date;
    scheduledEndAt: Date | null;
    graceMinutes: number;
    now: Date;
    actor: { role: "SYSTEM" } | { role: "TEACHER"; teacherId: string };
  }
): Promise<boolean> {
  locks.check("REGISTER", data.lectureId, "UPDATE");
  const start = data.scheduledStartAt.toISOString();
  const end = data.scheduledEndAt ? data.scheduledEndAt.toISOString() : null;
  const now = data.now.toISOString();
  const tx = rawOf(locks);

  const rows = await tx.$queryRaw<{ lectureId: string }[]>`
    INSERT INTO "LectureAttendanceRegister"
      ("lectureId", "classId", "scheduledStartAt", "scheduledEndAt", "graceMinutes", "finalizedAt",
       "finalizedByTeacherId", "version", "createdAt", "updatedAt")
    VALUES (
      ${data.lectureId}, ${data.classId},
      (CAST(${start} AS timestamptz) AT TIME ZONE 'UTC'),
      (CAST(${end} AS timestamptz) AT TIME ZONE 'UTC'),
      ${data.graceMinutes}, NULL, NULL, 1,
      (CAST(${now} AS timestamptz) AT TIME ZONE 'UTC'),
      (CAST(${now} AS timestamptz) AT TIME ZONE 'UTC')
    )
    ON CONFLICT ("lectureId") DO NOTHING
    RETURNING "lectureId"`;

  if (rows.length === 0) return false;

  locks.granted("REGISTER", data.lectureId, "UPDATE");
  await tx.lectureAttendanceRegisterAuditLog.create({
    data: {
      lectureId: data.lectureId,
      version: 1,
      action: "CREATED",
      toGraceMinutes: data.graceMinutes,
      toScheduledStartAt: data.scheduledStartAt,
      toScheduledEndAt: data.scheduledEndAt,
      actorRole: data.actor.role,
      actorId: data.actor.role === "TEACHER" ? data.actor.teacherId : null,
      createdAt: data.now,
    },
  });
  return true;
}

// ---- Level 5: LectureAttendance records ------------------------------------------------------

/**
 * The records of these students for the lecture, FOR NO KEY UPDATE, in
 * ascending studentId (one statement). NO KEY UPDATE still lets audit and
 * scan-event inserts take FOR KEY SHARE on them.
 */
export async function lockRecords(locks: AttendanceLocks, lectureId: string, studentIds: readonly string[]): Promise<LockedRecord[]> {
  const ids = [...new Set(studentIds)].sort();
  if (ids.length === 0) return [];

  for (const id of ids) locks.check("RECORDS", `${lectureId}:${id}`, "NO_KEY_UPDATE");
  locks.checkRecordOrder(ids);

  const rows = await rawOf(locks).$queryRaw<LockedRecord[]>`
    SELECT "id", "lectureId", "classId", "studentId", "status"::text AS "status", "statusSource"::text AS "statusSource",
           "firstOnlineAt", "firstQrAt", "autoStatus"::text AS "autoStatus", "teacherStatus"::text AS "teacherStatus",
           "teacherDecidedAt", "teacherDecidedById", "pendingReviewSince", "version", "createdAt", "updatedAt"
    FROM "LectureAttendance"
    WHERE "lectureId" = ${lectureId} AND "studentId" = ANY(${ids}::text[])
    ORDER BY "studentId"
    FOR NO KEY UPDATE`;

  for (const row of rows) locks.granted("RECORDS", `${lectureId}:${row.studentId}`, "NO_KEY_UPDATE");
  return rows;
}

export type NewRecord = {
  id: string;
  lectureId: string;
  classId: string;
  studentId: string;
  status: LockedRecord["status"];
  statusSource: LockedRecord["statusSource"];
  firstOnlineAt: Date | null;
  firstQrAt: Date | null;
  autoStatus: LockedRecord["autoStatus"];
  teacherStatus: LockedRecord["teacherStatus"];
  teacherDecidedAt: Date | null;
  teacherDecidedById: string | null;
  pendingReviewSince: Date | null;
  now: Date;
};

/**
 * Lock-phase creation of a student's record (version 1):
 * INSERT ... ON CONFLICT ("lectureId", "studentId") DO NOTHING. A concurrent
 * creator's uncommitted insert makes this wait (bounded by lock_timeout) and
 * then insert nothing; the caller then locks the committed row with
 * lockRecords (same student: allowed) and plans again. Returns true when
 * this transaction inserted it (it then holds the new row). The register
 * must be locked first (its foreign key), and the record's own audit row is
 * written later, in the write phase.
 */
export async function insertRecordIfAbsent(locks: AttendanceLocks, data: NewRecord): Promise<boolean> {
  const key = `${data.lectureId}:${data.studentId}`;
  locks.check("RECORDS", key, "UPDATE");
  locks.checkRecordOrder([data.studentId]);
  const iso = (value: Date | null) => (value ? value.toISOString() : null);

  const rows = await rawOf(locks).$queryRaw<{ id: string }[]>`
    INSERT INTO "LectureAttendance"
      ("id", "lectureId", "classId", "studentId", "status", "statusSource", "firstOnlineAt", "firstQrAt",
       "autoStatus", "teacherStatus", "teacherDecidedAt", "teacherDecidedById", "pendingReviewSince",
       "version", "createdAt", "updatedAt")
    VALUES (
      ${data.id}, ${data.lectureId}, ${data.classId}, ${data.studentId},
      CAST(${data.status} AS "LectureAttendanceStatus"),
      CAST(${data.statusSource} AS "AttendanceStatusSource"),
      (CAST(${iso(data.firstOnlineAt)} AS timestamptz) AT TIME ZONE 'UTC'),
      (CAST(${iso(data.firstQrAt)} AS timestamptz) AT TIME ZONE 'UTC'),
      CAST(${data.autoStatus} AS "LectureAttendanceStatus"),
      CAST(${data.teacherStatus} AS "LectureAttendanceStatus"),
      (CAST(${iso(data.teacherDecidedAt)} AS timestamptz) AT TIME ZONE 'UTC'),
      ${data.teacherDecidedById},
      (CAST(${iso(data.pendingReviewSince)} AS timestamptz) AT TIME ZONE 'UTC'),
      1,
      (CAST(${iso(data.now)} AS timestamptz) AT TIME ZONE 'UTC'),
      (CAST(${iso(data.now)} AS timestamptz) AT TIME ZONE 'UTC')
    )
    ON CONFLICT ("lectureId", "studentId") DO NOTHING
    RETURNING "id"`;

  if (rows.length === 0) return false;
  locks.granted("RECORDS", key, "UPDATE");
  return true;
}

/**
 * FINALIZATION ONLY (D6): the automatic ABSENT records, in the write phase,
 * under the register FOR UPDATE (which every record writer's KEY SHARE
 * conflicts with, so no record can appear meanwhile). One model createMany
 * through the write-guarded client (no raw SQL, no skipDuplicates): a
 * conflicting row is a unique violation that aborts and rolls back the whole
 * transaction, never a silent skip. 1–500 ids, strictly ascending; the
 * inserted count must equal the ids given. Rows: ABSENT, source
 * FINALIZATION, no evidence and no teacher decision (the CHECK constraints),
 * version 1. Returns the new record ids by student, in id order.
 */
export async function createFinalizationAbsences(
  locks: AttendanceLocks,
  input: { lectureId: string; classId: string; studentIds: readonly string[]; now: Date }
): Promise<{ id: string; studentId: string }[]> {
  if (!locks.finalization) throw new AttendanceLockOrderError("ABSENT records may only be created by the finalization transaction.");
  if (!locks.writing) throw new AttendanceLockOrderError("finalization ABSENT records are written after beginWrites().");
  if (!locks.holds("REGISTER", input.lectureId, "UPDATE")) {
    throw new AttendanceLockOrderError("finalization ABSENT records need the register FOR UPDATE.");
  }
  const ids = input.studentIds;
  if (ids.length === 0 || ids.length > FINALIZATION_MAX_STUDENTS) {
    throw new Error(`Finalization: 1 to ${FINALIZATION_MAX_STUDENTS} ABSENT records expected, ${ids.length} given.`);
  }
  for (let i = 1; i < ids.length; i += 1) {
    if (!(ids[i - 1] < ids[i])) throw new Error("Finalization: ABSENT students must be strictly ascending.");
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) throw new RangeError("Finalization: a valid server time is required.");

  const rows = ids.map((studentId) => ({ id: randomUUID(), studentId }));
  const result = await locks.db.lectureAttendance.createMany({
    data: rows.map((row) => ({
      id: row.id,
      lectureId: input.lectureId,
      classId: input.classId,
      studentId: row.studentId,
      status: "ABSENT" as const,
      statusSource: "FINALIZATION" as const,
      firstOnlineAt: null,
      firstQrAt: null,
      autoStatus: null,
      teacherStatus: null,
      teacherDecidedAt: null,
      teacherDecidedById: null,
      pendingReviewSince: null,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    })),
  });
  if (result.count !== rows.length) {
    throw new Error(`Finalization: ${result.count} of ${rows.length} ABSENT records were created.`);
  }
  return rows;
}

// ---- QR attendance closure (LectureQrAttendanceClosure) ---------------------------------

export type QrClosure = { lectureId: string; closedAt: Date; closedByTeacherId: string };

/**
 * The lecture's QR closure, or null. Requires the register to be locked
 * (KEY SHARE by scans, FOR UPDATE by the closure): the register lock is what
 * serializes scans with the closure, so an answer read without it could be
 * stale by the time the scan commits.
 */
export async function readQrClosure(locks: AttendanceLocks, lectureId: string): Promise<QrClosure | null> {
  if (!locks.holds("REGISTER", lectureId, "KEY_SHARE")) {
    throw new AttendanceLockOrderError("the QR closure is read without the register lock.");
  }
  const rows = await rawOf(locks).$queryRaw<QrClosure[]>`
    SELECT "lectureId", "closedAt", "closedByTeacherId"
    FROM "LectureQrAttendanceClosure" WHERE "lectureId" = ${lectureId}`;
  return rows[0] ?? null;
}

/**
 * Closes QR attendance (write phase only; the register must be held FOR
 * UPDATE, which waits for every scan holding it FOR KEY SHARE). INSERT ...
 * ON CONFLICT ("lectureId") DO NOTHING; returns false when it was already
 * closed. The row is append-only in the database: never changed or removed.
 */
export async function insertQrClosure(
  locks: AttendanceLocks,
  data: { lectureId: string; classId: string; closedAt: Date; closedByTeacherId: string }
): Promise<boolean> {
  if (!locks.writing) throw new AttendanceLockOrderError("the QR closure is written before beginWrites().");
  if (!locks.holds("REGISTER", data.lectureId, "UPDATE")) {
    throw new AttendanceLockOrderError("the QR closure is written without the register held FOR UPDATE.");
  }
  const closedAt = data.closedAt.toISOString();
  const rows = await rawOf(locks).$queryRaw<{ lectureId: string }[]>`
    INSERT INTO "LectureQrAttendanceClosure" ("lectureId", "classId", "closedAt", "closedByTeacherId")
    VALUES (${data.lectureId}, ${data.classId}, (CAST(${closedAt} AS timestamptz) AT TIME ZONE 'UTC'), ${data.closedByTeacherId})
    ON CONFLICT ("lectureId") DO NOTHING
    RETURNING "lectureId"`;
  return rows.length > 0;
}

