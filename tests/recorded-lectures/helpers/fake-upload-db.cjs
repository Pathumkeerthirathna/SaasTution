/*
 * In-memory fake of the Prisma client for the recorded-lecture upload tests
 * (RL-3.2+). No database. It implements only the calls the upload service
 * makes, and enforces what the real database would, so service bugs fail:
 *
 *   - interactive $transaction(fn, options): writes are undone on throw;
 *   - pg_advisory_xact_lock(hashtextextended(key, 0)) via $executeRaw: a FIFO
 *     lock per key held until the transaction ends (commit or rollback);
 *     faults.lockTimeout(key) makes it throw P2010 / 55P03 instead;
 *   - every query first yields to the event loop, so concurrent requests
 *     really interleave between statements;
 *   - foreign keys: (lectureId, classId) -> Lecture, (classId, teacherId) ->
 *     Class, teacherId -> Teacher, (recordedLectureId, teacherId) ->
 *     RecordedLecture (P2003);
 *   - the partial unique index (lectureId, partNumber) WHERE status = 0 AND
 *     state <> 'FAILED' and the session's unique (recordedLectureId, teacherId)
 *     (P2002);
 *   - the RL-2 CHECKs the RL-3.2 code can touch (ids, bigint byte counts,
 *     state / timestamp / failure-code pairings, lease all-or-none and
 *     ACTIVE-only): a violation throws "fake CHECK ...".
 *
 * Limitation: uncommitted rows are visible to other transactions (real
 * PostgreSQL READ COMMITTED would hide them); the service serializes every
 * write path that depends on them with advisory locks, which this fake does
 * honour.
 */

"use strict";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function prismaError(code, meta, message = `fake ${code}`) {
  const error = new Error(message);
  error.name = "PrismaClientKnownRequestError";
  error.code = code;
  error.meta = meta;
  return error;
}

const toComparable = (value) => (value instanceof Date ? value.getTime() : value);
function equal(a, b) {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return a === b;
}

function matchValue(value, condition) {
  if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
    for (const [op, operand] of Object.entries(condition)) {
      const a = toComparable(value);
      const b = toComparable(operand);
      if (op === "in") {
        if (!operand.some((item) => equal(value, item))) return false;
      } else if (op === "not") {
        if (equal(value, operand)) return false;
      } else if (op === "lt") {
        if (!(a < b)) return false;
      } else if (op === "lte") {
        if (!(a <= b)) return false;
      } else if (op === "gt") {
        if (!(a > b)) return false;
      } else if (op === "gte") {
        if (!(a >= b)) return false;
      } else {
        throw new Error(`fake: unsupported where operator ${op}`);
      }
    }
    return true;
  }
  return equal(value, condition);
}

function matches(row, where = {}) {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "OR") {
      if (!condition.some((alternative) => matches(row, alternative))) return false;
      continue;
    }
    if (!(key in row)) throw new Error(`fake: unknown column ${key}`);
    if (!matchValue(row[key], condition)) return false;
  }
  return true;
}

function pick(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, on] of Object.entries(select)) if (on === true) out[key] = row[key];
  return out;
}

/** orderBy { column: "asc" | "desc" } and take, as Prisma applies them. */
function orderAndTake(rows, orderBy, take) {
  let out = rows;
  if (orderBy) {
    const [[column, direction]] = Object.entries(orderBy);
    out = [...out].sort((a, b) => {
      const x = toComparable(a[column]);
      const y = toComparable(b[column]);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return direction === "desc" ? -order : order;
    });
  }
  return typeof take === "number" ? out.slice(0, take) : out;
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (!(key in row)) throw new Error(`fake: unknown column ${key}`);
    if (value !== null && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
      row[key] = row[key] + value.increment;
    } else {
      row[key] = value;
    }
  }
}

const RECORDING_DEFAULTS = {
  storedFileName: null, durationSeconds: null, width: null, height: null, videoCodec: null, audioCodec: null,
  fragmented: null, failureCode: null, status: 0, deletedAt: null, deletedByTeacherId: null,
  purgeRequestedAt: null, purgedAt: null, readyAt: null, failedAt: null,
};
const SESSION_DEFAULTS = {
  receivedBytes: BigInt(0), chunkCount: 0, failureCode: null, leaseToken: null, leaseOffset: null, leaseBytes: null,
  leaseGrantedAt: null, leaseExpiresAt: null, endedAt: null, version: 0,
};
const FINAL_SESSION_STATES = new Set(["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"]);
const MAX_BYTES = BigInt(64_000_000_000);

function check(condition, name) {
  if (!condition) throw new Error(`fake CHECK ${name}`);
}

function checkRecording(r) {
  check(UUID.test(r.id) && UUID.test(r.lectureId) && UUID.test(r.teacherId), "RecordedLecture_key_ids_format_check");
  check(typeof r.title === "string" && r.title.trim() !== "" && r.title.length <= 200, "RecordedLecture_title_check");
  check(Number.isInteger(r.partNumber) && r.partNumber >= 1, "RecordedLecture_partNumber_check");
  check(typeof r.displayFileName === "string" && r.displayFileName.length >= 5 && r.displayFileName.endsWith(".mp4"), "RecordedLecture_displayFileName_check");
  check(r.mimeType === "video/mp4", "RecordedLecture_mimeType_check");
  check(typeof r.sizeBytes === "bigint" && r.sizeBytes >= BigInt(1) && r.sizeBytes <= MAX_BYTES, "RecordedLecture_sizeBytes_check");
  check(["UPLOADING", "VERIFYING", "READY", "FAILED"].includes(r.state), "RecordedLectureState");
  check((r.state === "FAILED") === (r.failureCode !== null), "RecordedLecture_failureCode_check");
  check((r.state === "READY") === (r.readyAt !== null), "RecordedLecture_readyAt_check");
  check((r.state === "FAILED") === (r.failedAt !== null), "RecordedLecture_failedAt_check");
  check([0, 1, 2].includes(r.status), "RecordedLecture_status_check");
  check((r.status === 0) === (r.deletedAt === null), "RecordedLecture_deletedAt_check");
  check(r.deletedByTeacherId === null || r.deletedAt !== null, "RecordedLecture_deletedBy_check");
  check((r.status === 2) === (r.purgeRequestedAt !== null), "RecordedLecture_purgeRequestedAt_check");
  check((r.status === 1) === (r.purgedAt !== null), "RecordedLecture_purgedAt_check");
  check(r.storedFileName === null || /^[0-9a-f]{32}\.mp4$/.test(r.storedFileName), "RecordedLecture_storedFileName_check");
  check(r.durationSeconds === null || (Number.isInteger(r.durationSeconds) && r.durationSeconds >= 1 && r.durationSeconds <= 172800), "RecordedLecture_durationSeconds_check");
  check(r.videoCodec === null || /^avc[13]\.[0-9A-F]{6}$/.test(r.videoCodec), "RecordedLecture_videoCodec_check");
  check(r.audioCodec === null || ["mp4a.40.2", "mp4a.40.5", "mp4a.40.29"].includes(r.audioCodec), "RecordedLecture_audioCodec_check");
  check(r.failureCode === null || /^[A-Z][A-Z0-9_]{0,63}$/.test(r.failureCode), "RecordedLecture_failureCode_check (format)");
  check(
    r.state !== "READY" ||
      (r.storedFileName !== null && r.durationSeconds !== null && r.videoCodec !== null && r.audioCodec !== null && r.fragmented !== null),
    "RecordedLecture_ready_metadata_check"
  );
  check(r.createdAt instanceof Date && r.updatedAt instanceof Date, "timestamps");
}

function checkSession(s) {
  check(UUID.test(s.id), "RecordingUploadSession_id_format_check");
  check(typeof s.expectedBytes === "bigint" && s.expectedBytes >= BigInt(1) && s.expectedBytes <= MAX_BYTES, "expectedBytes_check");
  check(typeof s.receivedBytes === "bigint" && s.receivedBytes >= BigInt(0) && s.receivedBytes <= s.expectedBytes, "receivedBytes_check");
  check((s.chunkCount === 0) === (s.receivedBytes === BigInt(0)), "chunkCount_check");
  const lease = [s.leaseToken, s.leaseOffset, s.leaseBytes, s.leaseGrantedAt, s.leaseExpiresAt];
  check(lease.every((v) => v === null) || lease.every((v) => v !== null), "lease_all_or_none_check");
  check(s.leaseToken === null || s.state === "ACTIVE", "lease_only_active_check");
  check(["ACTIVE", "COMPLETING", "COMPLETED", "FAILED", "EXPIRED", "CANCELLED"].includes(s.state), "RecordingUploadState");
  check(FINAL_SESSION_STATES.has(s.state) === (s.endedAt !== null), "endedAt_check");
  check((s.state === "FAILED") === (s.failureCode !== null), "failureCode_check");
  check(s.failureCode === null || /^[A-Z][A-Z0-9_]{0,63}$/.test(s.failureCode), "failureCode_check (format)");
  check(s.expiresAt instanceof Date && s.createdAt instanceof Date && s.expiresAt > s.createdAt, "expiresAt_check");
  check(s.leaseOffset === null || s.leaseOffset === s.receivedBytes, "leaseOffset_check");
  check(
    s.leaseBytes === null ||
      (Number.isInteger(s.leaseBytes) && s.leaseBytes >= 1 && s.leaseBytes <= 67_108_864 && BigInt(s.leaseBytes) <= s.expectedBytes - s.receivedBytes),
    "leaseBytes_check"
  );
  check(s.leaseToken === null || /^[0-9a-f]{64}$/.test(s.leaseToken), "leaseToken_check");
  check(s.leaseExpiresAt === null || s.leaseExpiresAt > s.leaseGrantedAt, "leaseExpiresAt_check");
  check(!["COMPLETING", "COMPLETED"].includes(s.state) || s.receivedBytes === s.expectedBytes, "complete_bytes_check");
}

function checkChunk(c) {
  check(Number.isInteger(c.chunkIndex) && c.chunkIndex >= 0 && typeof c.startOffset === "bigint" && c.startOffset >= BigInt(0), "RecordingUploadChunk_position_check");
  check((c.chunkIndex === 0) === (c.startOffset === BigInt(0)), "RecordingUploadChunk_position_check (first)");
  check(Number.isInteger(c.byteLength) && c.byteLength >= 1 && c.byteLength <= 67_108_864, "RecordingUploadChunk_byteLength_check");
  check(c.startOffset + BigInt(c.byteLength) <= MAX_BYTES, "RecordingUploadChunk_end_check");
  check(/^[0-9a-f]{64}$/.test(c.leaseToken), "RecordingUploadChunk_leaseToken_check");
  check(c.sha256 === null || /^[0-9a-f]{64}$/.test(c.sha256), "RecordingUploadChunk_sha256_check");
  check(c.receivedAt instanceof Date, "receivedAt");
}

function createFakeUploadDb() {
  const db = {
    teachers: [],
    classes: [],
    lectures: [],
    recordings: [],
    sessions: [],
    chunks: [],
    /** Every statement, in order: { tx, kind, ... } (tx: transaction number or null). */
    log: [],
    transactions: [],
    faults: {
      lockTimeout: () => false,
      /**
       * Per transaction (its number): "rollback-then-throw" (the callback ran, its
       * writes are undone, then a connection-style error) or "commit-then-throw"
       * (the writes stay, then the same error: the ambiguous commit).
       */
      commit: () => null,
      /** While true every query and transaction start fails (the database is unreachable). */
      down: false,
    },
    /** How P2002 reports the partial index target (Prisma's shape is unverified: both are handled). */
    partNumberConflictTarget: ["lectureId", "partNumber"],
    /** Tests only: make advisory locks no-ops (to show what they protect). */
    disableAdvisoryLocks: false,
    hooks: {},
    // ---- Teacher storage quota (Stage 3.3). Empty = every teacher unlimited, nothing else counted. ----
    /** TeacherStorageLimit rows: { teacherId, limitBytes }. */
    storageLimits: [],
    /** TeacherSubscription rows: { teacherId, status, endDate, updatedAt, plan: { storageGB } }. */
    subscriptions: [],
    /** StorageReservation rows (Notes / submissions). */
    reservations: [],
    /** Committed Notes / submission bytes per teacher (what the usage SQL would sum). */
    quotaNotesBytes: new Map(),
    quotaSubmissionsBytes: new Map(),
  };

  const locks = new Map();
  let txCounter = 0;

  async function acquire(key, ctx) {
    if (db.disableAdvisoryLocks) return;
    let lock = locks.get(key);
    if (!lock) {
      lock = { holder: null, queue: [] };
      locks.set(key, lock);
    }
    if (lock.holder === ctx.id) return;
    if (lock.holder === null) {
      lock.holder = ctx.id;
    } else {
      await new Promise((resolve) => lock.queue.push({ id: ctx.id, resolve }));
    }
    ctx.locks.push(key);
  }

  function releaseAll(ctx) {
    for (const key of ctx.locks) {
      const lock = locks.get(key);
      const next = lock.queue.shift();
      if (next) {
        lock.holder = next.id;
        next.resolve();
      } else {
        lock.holder = null;
        locks.delete(key);
      }
    }
  }

  /** Every statement first yields, then fails while the database is "down" (faults.down). */
  async function gate() {
    await tick();
    if (db.faults.down) throw new Error("fake: database unreachable");
  }

  function client(ctx) {
    const txId = ctx ? ctx.id : null;
    const record = (entry) => db.log.push({ tx: txId, ...entry });
    const undo = (fn) => ctx && ctx.undo.push(fn);

    function update(table, rows, data, validate) {
      for (const row of rows) {
        const before = { ...row };
        applyData(row, data);
        try {
          validate(row);
        } catch (error) {
          Object.assign(row, before);
          throw error;
        }
        undo(() => Object.assign(row, before));
      }
      return { count: rows.length };
    }

    return {
      async $executeRawUnsafe(sql) {
        await gate();
        record({ kind: "rawUnsafe", sql });
        return 0;
      },
      async $executeRaw(strings, ...values) {
        await gate();
        const sql = strings.join("?");
        record({ kind: "raw", sql, values });
        if (sql.includes("pg_advisory_xact_lock")) {
          if (!ctx) throw new Error("fake: advisory lock outside a transaction");
          const key = values[0];
          if (db.faults.lockTimeout(key)) throw prismaError("P2010", { code: "55P03" }, "lock timeout");
          if (db.hooks.beforeAdvisoryLock) await db.hooks.beforeAdvisoryLock(key, ctx.id);
          await acquire(key, ctx);
          record({ kind: "locked", key });
        }
        return 0;
      },
      teacher: {
        async findUnique({ where, select }) {
          await gate();
          record({ kind: "teacher.findUnique", where });
          const row = db.teachers.find((t) => t.id === where.id);
          return row ? pick(row, select) : null;
        },
      },
      lecture: {
        async findFirst({ where, select }) {
          await gate();
          record({ kind: "lecture.findFirst", where });
          if (db.hooks.beforeLectureFind) db.hooks.beforeLectureFind(where, txId);
          const { class: classWhere, ...own } = where;
          const row = db.lectures.find((l) => {
            if (!matches(l, own)) return false;
            if (!classWhere) return true;
            const cls = db.classes.find((c) => c.id === l.classId);
            return cls && matches(cls, classWhere);
          });
          if (!row) return null;
          const cls = db.classes.find((c) => c.id === row.classId);
          const out = select ? pick(row, select) : { ...row };
          if (select && select.class) out.class = { id: cls.id, name: cls.name, schedule: "TBD" };
          return out;
        },
      },
      recordedLecture: {
        async create({ data }) {
          await gate();
          record({ kind: "recordedLecture.create", data });
          const row = { ...RECORDING_DEFAULTS, ...data };
          checkRecording(row);
          if (!db.teachers.some((t) => t.id === row.teacherId)) throw prismaError("P2003", { field_name: "teacherId" });
          if (!db.lectures.some((l) => l.id === row.lectureId && l.classId === row.classId)) {
            throw prismaError("P2003", { field_name: "RecordedLecture_lectureId_classId_fkey" });
          }
          if (!db.classes.some((c) => c.id === row.classId && c.teacherId === row.teacherId)) {
            throw prismaError("P2003", { field_name: "RecordedLecture_classId_teacherId_fkey" });
          }
          if (db.recordings.some((r) => r.id === row.id)) throw prismaError("P2002", { target: ["id"] });
          if (
            row.status === 0 &&
            row.state !== "FAILED" &&
            db.recordings.some((r) => r.lectureId === row.lectureId && r.partNumber === row.partNumber && r.status === 0 && r.state !== "FAILED")
          ) {
            throw prismaError("P2002", { target: db.partNumberConflictTarget });
          }
          db.recordings.push(row);
          undo(() => db.recordings.splice(db.recordings.indexOf(row), 1));
          return { ...row };
        },
        async findFirst({ where, select }) {
          await gate();
          record({ kind: "recordedLecture.findFirst", where });
          const row = db.recordings.find((r) => matches(r, where));
          return row ? pick(row, select) : null;
        },
        async aggregate({ where, _sum }) {
          await gate();
          record({ kind: "recordedLecture.aggregate", where });
          if (!_sum || !_sum.sizeBytes) throw new Error("fake: aggregate _sum.sizeBytes only");
          const rows = db.recordings.filter((r) => matches(r, where));
          return { _sum: { sizeBytes: rows.length ? rows.reduce((t, r) => t + r.sizeBytes, BigInt(0)) : null } };
        },
        async findMany({ where, select, orderBy, take }) {
          await gate();
          record({ kind: "recordedLecture.findMany", where });
          return orderAndTake(db.recordings.filter((r) => matches(r, where)), orderBy, take).map((r) => pick(r, select));
        },
        async updateMany({ where, data }) {
          await gate();
          record({ kind: "recordedLecture.updateMany", where, data });
          // The partial unique index (lectureId, partNumber) WHERE status = 0 AND state <> 'FAILED' applies to updates too.
          const validate = (row) => {
            checkRecording(row);
            if (
              row.status === 0 &&
              row.state !== "FAILED" &&
              db.recordings.some((r) => r !== row && r.lectureId === row.lectureId && r.partNumber === row.partNumber && r.status === 0 && r.state !== "FAILED")
            ) {
              throw prismaError("P2002", { target: db.partNumberConflictTarget });
            }
          };
          return update("recordings", db.recordings.filter((r) => matches(r, where)), data, validate);
        },
      },
      recordingUploadChunk: {
        async create({ data }) {
          await gate();
          record({ kind: "recordingUploadChunk.create", data });
          const row = { sha256: null, ...data };
          checkChunk(row);
          if (!db.sessions.some((s) => s.id === row.uploadSessionId)) throw prismaError("P2003", { field_name: "RecordingUploadChunk_uploadSessionId_fkey" });
          if (db.chunks.some((c) => c.id === row.id)) throw prismaError("P2002", { target: ["id"] });
          if (db.chunks.some((c) => c.leaseToken === row.leaseToken)) throw prismaError("P2002", { target: ["leaseToken"] });
          if (db.chunks.some((c) => c.uploadSessionId === row.uploadSessionId && c.chunkIndex === row.chunkIndex)) {
            throw prismaError("P2002", { target: ["uploadSessionId", "chunkIndex"] });
          }
          if (db.chunks.some((c) => c.uploadSessionId === row.uploadSessionId && c.startOffset === row.startOffset)) {
            throw prismaError("P2002", { target: ["uploadSessionId", "startOffset"] });
          }
          db.chunks.push(row);
          undo(() => db.chunks.splice(db.chunks.indexOf(row), 1));
          return { ...row };
        },
        async findFirst({ where, select }) {
          await gate();
          record({ kind: "recordingUploadChunk.findFirst", where });
          const row = db.chunks.find((c) => matches(c, where));
          return row ? pick(row, select) : null;
        },
        async findMany({ where, select, orderBy }) {
          await gate();
          if (db.hooks.beforeChunkFindMany) await db.hooks.beforeChunkFindMany(where);
          record({ kind: "recordingUploadChunk.findMany", where, orderBy });
          const rows = db.chunks.filter((c) => matches(c, where)).map((c) => pick(c, select));
          if (orderBy && orderBy.chunkIndex === "asc") rows.sort((a, b) => a.chunkIndex - b.chunkIndex);
          if (db.hooks.afterChunkFindMany) await db.hooks.afterChunkFindMany(where);
          return rows;
        },
      },
      recordingUploadSession: {
        async create({ data }) {
          await gate();
          record({ kind: "recordingUploadSession.create", data });
          const row = { ...SESSION_DEFAULTS, ...data };
          checkSession(row);
          if (!db.recordings.some((r) => r.id === row.recordedLectureId && r.teacherId === row.teacherId)) {
            throw prismaError("P2003", { field_name: "RecordingUploadSession_recordedLectureId_teacherId_fkey" });
          }
          if (db.sessions.some((s) => s.id === row.id || s.recordedLectureId === row.recordedLectureId)) {
            throw prismaError("P2002", { target: ["recordedLectureId", "teacherId"] });
          }
          db.sessions.push(row);
          undo(() => db.sessions.splice(db.sessions.indexOf(row), 1));
          return { ...row };
        },
        async findFirst({ where, select }) {
          await gate();
          record({ kind: "recordingUploadSession.findFirst", where });
          const row = db.sessions.find((s) => matches(s, where));
          return row ? pick(row, select) : null;
        },
        async findMany({ where, select, orderBy, take }) {
          await gate();
          record({ kind: "recordingUploadSession.findMany", where });
          const rows = orderAndTake(db.sessions.filter((s) => matches(s, where)), orderBy, take).map((s) => pick(s, select));
          if (db.hooks.afterSessionFindMany) await db.hooks.afterSessionFindMany(where);
          return rows;
        },
        async count({ where }) {
          await gate();
          record({ kind: "recordingUploadSession.count", where });
          return db.sessions.filter((s) => matches(s, where)).length;
        },
        async updateMany({ where, data }) {
          await gate();
          if (db.hooks.beforeSessionUpdateMany) await db.hooks.beforeSessionUpdateMany(where, data, txId);
          record({ kind: "recordingUploadSession.updateMany", where, data });
          return update("sessions", db.sessions.filter((s) => matches(s, where)), data, checkSession);
        },
      },
      // ---- Teacher storage quota (Stage 3.3) ----------------------------------------------------------
      async $queryRaw(strings, ...values) {
        await gate();
        const sql = strings.join("?");
        record({ kind: "queryRaw", sql, values });
        // getTeacherStorageUsage's Notes / submission sums (the only raw query of the upload paths).
        if (!sql.includes('"notesBytes"')) throw new Error("fake: unsupported $queryRaw");
        const teacherId = values[0];
        return [{ notesBytes: db.quotaNotesBytes.get(teacherId) ?? BigInt(0), submissionsBytes: db.quotaSubmissionsBytes.get(teacherId) ?? BigInt(0) }];
      },
      storageReservation: {
        async create({ data, select }) {
          await gate();
          record({ kind: "storageReservation.create", data });
          // The migration's CHECKs and unique index.
          if (!(typeof data.bytes === "bigint" && data.bytes >= BigInt(1) && data.bytes <= BigInt(2147483647))) throw new Error("fake CHECK StorageReservation_bytes_range");
          if (!(data.expiresAt > data.createdAt)) throw new Error("fake CHECK StorageReservation_expiry_after_creation");
          if (!data.storageKey.startsWith(`Teachers/${data.teacherId}/`)) throw new Error("fake CHECK StorageReservation_storageKey_owner");
          if (db.reservations.some((r) => r.storageKey === data.storageKey)) throw prismaError("P2002", { target: ["storageKey"] });
          const row = { ...data };
          db.reservations.push(row);
          undo(() => db.reservations.splice(db.reservations.indexOf(row), 1));
          return pick(row, select);
        },
        async findUnique({ where, select }) {
          await gate();
          const row = db.reservations.find((r) => r.id === where.id);
          return row ? pick(row, select) : null;
        },
        async deleteMany({ where }) {
          await gate();
          record({ kind: "storageReservation.deleteMany", where });
          const removed = db.reservations.filter((r) => matches(r, where));
          db.reservations = db.reservations.filter((r) => !removed.includes(r));
          undo(() => db.reservations.push(...removed));
          return { count: removed.length };
        },
        async groupBy({ by, where }) {
          await gate();
          record({ kind: "storageReservation.groupBy", where });
          if (by.length !== 1 || by[0] !== "category") throw new Error("fake: groupBy by category only");
          const live = db.reservations.filter((r) => matches(r, where));
          return ["NOTE", "SUBMISSION"]
            .map((category) => ({ category, rows: live.filter((r) => r.category === category) }))
            .filter((g) => g.rows.length > 0)
            .map((g) => ({ category: g.category, _sum: { bytes: g.rows.reduce((t, r) => t + r.bytes, BigInt(0)) } }));
        },
      },
      teacherStorageLimit: {
        async findUnique({ where, select }) {
          await gate();
          const row = db.storageLimits.find((l) => l.teacherId === where.teacherId);
          return row ? pick(row, select) : null;
        },
      },
      teacherSubscription: {
        async findFirst({ where, orderBy }) {
          await gate();
          const { OR, ...rest } = where;
          const rows = db.subscriptions
            .filter((s) => matches(s, rest) && (!OR || OR.some((condition) => matches(s, condition))))
            .sort((a, b) => (orderBy?.updatedAt === "desc" ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt));
          return rows[0] ? { plan: { storageGB: rows[0].plan.storageGB } } : null;
        },
      },
    };
  }

  const root = client(null);
  root.$transaction = async (fn, options) => {
    if (typeof fn !== "function") throw new Error("fake: only interactive transactions are supported");
    const ctx = { id: ++txCounter, undo: [], locks: [] };
    db.transactions.push({ id: ctx.id, options, outcome: "open" });
    const entry = db.transactions[db.transactions.length - 1];
    if (db.hooks.beforeTransaction) await db.hooks.beforeTransaction(ctx.id);
    if (db.faults.down) throw new Error("fake: database unreachable");
    try {
      const result = await fn(client(ctx));
      const fault = db.faults.commit(ctx.id);
      if (fault === "rollback-then-throw") throw Object.assign(new Error("Connection closed (fake)"), { fakeFault: fault });
      entry.outcome = "commit";
      if (fault === "commit-then-throw") {
        ctx.undo.length = 0;
        throw Object.assign(new Error("Connection closed after commit (fake)"), { fakeFault: fault });
      }
      return result;
    } catch (error) {
      if (entry.outcome === "commit") throw error;
      for (const revert of ctx.undo.reverse()) revert();
      entry.outcome = "rollback";
      throw error;
    } finally {
      releaseAll(ctx);
    }
  };

  return { db, prisma: root, prismaError };
}

module.exports = { createFakeUploadDb, prismaError, UUID };
