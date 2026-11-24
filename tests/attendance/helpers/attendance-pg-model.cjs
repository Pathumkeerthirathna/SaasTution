/*
 * In-memory model of the PostgreSQL behaviour the attendance services rely
 * on (no database): row locks KEY SHARE / SHARE / NO KEY UPDATE / UPDATE with
 * their conflicts, held until the transaction ends; INSERT ... ON CONFLICT DO
 * NOTHING and unique keys waiting for another transaction's uncommitted
 * insert; READ COMMITTED visibility; rollback; and an ABORTED transaction
 * after any database error (every later statement fails with 25P02, so a
 * service that caught a database error and carried on would be caught).
 *
 * The CHECK constraints of LectureAttendance, AttendanceScanEvent and
 * AttendanceAuditLog (migration 20261110140000) are enforced on every write.
 */

"use strict";

const assert = require("node:assert/strict");

const CONFLICTS = {
  KEY_SHARE: new Set(["UPDATE"]),
  SHARE: new Set(["NO_KEY_UPDATE", "UPDATE"]),
  NO_KEY_UPDATE: new Set(["SHARE", "NO_KEY_UPDATE", "UPDATE"]),
  UPDATE: new Set(["KEY_SHARE", "SHARE", "NO_KEY_UPDATE", "UPDATE"]),
};

function dbError(message, extra) {
  return Object.assign(new Error(message), { name: "PrismaClientKnownRequestError", __db: true, ...extra });
}
const lockTimeoutError = () => dbError("canceling statement due to lock timeout", { code: "P2010", meta: { code: "55P03" } });
const abortedError = () => dbError("current transaction is aborted", { code: "P2010", meta: { code: "25P02" } });
const uniqueError = (target) => dbError("Unique constraint failed", { code: "P2002", meta: { target } });
const checkError = (name) => dbError(`check constraint ${name} violated`, { code: "P2010", meta: { code: "23514", constraint: name } });
const fkError = (name) => dbError(`foreign key ${name} violated`, { code: "P2003", meta: { field_name: name } });

const isNull = (v) => v === null || v === undefined;

/**
 * Lecture.isDefault (migration 20261129120000, NOT NULL DEFAULT false): a
 * lecture row seeded without it is a normal lecture; a `where.isDefault`
 * filter (NORMAL_LECTURE_WHERE) is applied like the database would.
 */
const isDefaultOk = (lecture, where) => where.isDefault === undefined || (lecture.isDefault ?? false) === where.isDefault;

// ---- CHECK constraints ------------------------------------------------------------------

function checkRecord(r) {
  const rules = {
    teacher_status: isNull(r.teacherStatus) || r.status === r.teacherStatus,
    auto_status: isNull(r.autoStatus) || ["PRESENT", "LATE"].includes(r.autoStatus),
    evidence: isNull(r.autoStatus) === (isNull(r.firstOnlineAt) && isNull(r.firstQrAt)),
    teacher_decision: isNull(r.teacherStatus) === isNull(r.teacherDecidedAt) && isNull(r.teacherStatus) === isNull(r.teacherDecidedById),
    source_teacher: (r.statusSource === "TEACHER") === !isNull(r.teacherStatus),
    source_finalization: r.statusSource !== "FINALIZATION" || r.status === "ABSENT",
    source_auto: r.statusSource !== "AUTO" || (!isNull(r.autoStatus) && ["PRESENT", "LATE"].includes(r.status)),
    source_backfill: r.statusSource !== "BACKFILL" || r.status === "PRESENT",
    version: r.version >= 1,
  };
  for (const [name, ok] of Object.entries(rules)) if (!ok) throw checkError(`LectureAttendance_${name}_check`);
}

const APPROVED_REASONS = ["KNOWN_APPROVED", "APPROVED_AT_EVIDENCE"];
const UNKNOWN_REASONS = ["BEFORE_APPROVAL_FEATURE", "BEFORE_RECORDED_DECISIONS", "APPROVED_AT_CONFLICT", "BROKEN_HISTORY"];
const ALL_REASONS = [...APPROVED_REASONS, "KNOWN_NOT_APPROVED", ...UNKNOWN_REASONS];

function checkScan(s) {
  const linked = ["STATUS_UPDATED", "EVIDENCE_ONLY", "REVIEW_REQUIRED", "DUPLICATE"].includes(s.effect);
  const rules = {
    record_link: linked === !isNull(s.lectureAttendanceId),
    effect: (s.result === "VALID") === (s.effect !== "NONE"),
    identity:
      !["VALID", "NOT_ELIGIBLE", "ELIGIBILITY_UNKNOWN"].includes(s.result) ||
      (!isNull(s.studentId) && !isNull(s.qrTokenId) && !isNull(s.scannedTokenHash)),
    wrong_teacher: s.result !== "WRONG_TEACHER" || (isNull(s.studentId) && isNull(s.qrTokenId) && isNull(s.scannedTokenHash)),
    token_hash: isNull(s.scannedTokenHash) || /^[0-9a-f]{64}$/.test(s.scannedTokenHash),
    valid_reason: s.result !== "VALID" || APPROVED_REASONS.includes(s.eligibilityReason),
    unknown_reason: s.result !== "ELIGIBILITY_UNKNOWN" || UNKNOWN_REASONS.includes(s.eligibilityReason),
    reason_identity: !isNull(s.studentId) || isNull(s.eligibilityReason),
    eligibility_reason: isNull(s.eligibilityReason) || ALL_REASONS.includes(s.eligibilityReason),
  };
  for (const [name, ok] of Object.entries(rules)) if (!ok) throw checkError(`AttendanceScanEvent_${name}_check`);
}

function checkRegisterAudit(a) {
  const changed = (x, y) => (x === null || x === undefined ? null : new Date(x).getTime()) !== (y === null || y === undefined ? null : new Date(y).getTime());
  const rules = {
    version: a.version >= 1,
    actor_role: ["TEACHER", "SYSTEM"].includes(a.actorRole),
    actor_id: (a.actorRole === "TEACHER") === !isNull(a.actorId),
    created: a.action !== "CREATED" || (a.version === 1 && isNull(a.fromGraceMinutes) && isNull(a.fromScheduledStartAt) && isNull(a.fromScheduledEndAt)),
    grace_changed: a.action !== "GRACE_CHANGED" || (!isNull(a.fromGraceMinutes) && !isNull(a.toGraceMinutes) && a.fromGraceMinutes !== a.toGraceMinutes),
    schedule_synced: a.action !== "SCHEDULE_SYNCED" || changed(a.fromScheduledStartAt, a.toScheduledStartAt) || changed(a.fromScheduledEndAt, a.toScheduledEndAt),
    finalized:
      a.action !== "FINALIZED" ||
      (!isNull(a.finalizedAt) && !isNull(a.eligibleCount) && !isNull(a.unknownEligibilityCount) && !isNull(a.absentCreatedCount) && !isNull(a.actorId)),
  };
  for (const [name, ok] of Object.entries(rules)) if (!ok) throw checkError(`LectureAttendanceRegisterAuditLog_${name}_check`);
}

function checkAudit(a) {
  const teacherActions = ["TEACHER_SET", "EVIDENCE_ACCEPTED", "EVIDENCE_DISMISSED"];
  const rules = {
    actor_role: ["TEACHER", "SYSTEM"].includes(a.actorRole),
    teacher_action: (a.actorRole === "TEACHER") === teacherActions.includes(a.action),
    actor_id: (a.actorRole === "TEACHER") === !isNull(a.actorId),
    version: a.version >= 1,
    creation: (a.version === 1) === isNull(a.fromStatus) && (a.version !== 1 || (isNull(a.fromTeacherStatus) && isNull(a.fromAutoStatus))),
    creation_action:
      (!["CREATED_AUTO", "BACKFILL", "FINALIZE_ABSENT"].includes(a.action) || a.version === 1) &&
      (a.version !== 1 || ["CREATED_AUTO", "BACKFILL", "FINALIZE_ABSENT", "TEACHER_SET"].includes(a.action)),
    finalize_absent: a.action !== "FINALIZE_ABSENT" || a.toStatus === "ABSENT",
    backfill: a.action !== "BACKFILL" || a.toStatus === "PRESENT",
    reason: !(["TEACHER_SET", "EVIDENCE_ACCEPTED"].includes(a.action) && (!isNull(a.fromStatus) || a.afterFinalization)) || !isNull(a.reason),
  };
  for (const [name, ok] of Object.entries(rules)) if (!ok) throw checkError(`AttendanceAuditLog_${name}_check`);
}

// ---- Read helpers (top-level history reads) ---------------------------------------------------

/** Prisma's `select`: only the selected keys (undefined columns become null, as in a row). */
function pickSelected(row, select) {
  if (!select) return row;
  const out = {};
  for (const [key, on] of Object.entries(select)) if (on) out[key] = row[key] === undefined ? null : row[key];
  return out;
}

/** version > where.version.gt, ordered by version (asc only, as the history service asks), take. */
function pageAudits(rows, where, orderBy, take, select) {
  if (!orderBy || orderBy.version !== "asc") throw new Error("model: audit reads must order by version asc");
  const after = where.version && where.version.gt !== undefined ? where.version.gt : 0;
  const sorted = rows.filter((a) => a.version > after).sort((x, y) => x.version - y.version);
  return (take === undefined ? sorted : sorted.slice(0, take)).map((a) => pickSelected({ ...a }, select));
}

// ---- The model --------------------------------------------------------------------------

function createPgModel() {
  const pg = {
    log: [],
    held: [],
    waiting: [],
    failWhenBlocked: false,
    pending: new Map(), // unique key -> owning transaction label (uncommitted insert)
    ended: new Map(), // label -> { promise, resolve }
    transactions: [],
    seq: 0,
    idSeq: 0,
    /** (label, op) => Error | null: a simulated database failure of that statement. */
    failOn: null,
    /** async (label, op) => void: called before each statement (pauses, races). */
    beforeStatement: null,
    /** Called after top-level prisma.lecture.findFirst (to change the lecture "between" reads). */
    afterOwnershipRead: null,
    committed: {
      students: {},
      tokens: {},
      lectures: {},
      classes: {},
      registers: {},
      registerAudits: [],
      records: {},
      recordAudits: [],
      scans: [],
      history: [],
      enrolments: [],
      visits: {},
      sessions: {},
      qrClosures: {},
    },
  };

  const nextId = (prefix) => `${prefix}-${++pg.idSeq}`;

  // ---- locks --------------------------------------------------------------------------
  const locks = {
    canGrant(row, owner, mode) {
      return pg.held.every((h) => h.row !== row || h.owner === owner || !CONFLICTS[mode].has(h.mode));
    },
    async acquire(row, owner, mode) {
      if (this.canGrant(row, owner, mode) && !pg.waiting.some((w) => w.row === row)) {
        pg.held.push({ row, owner, mode });
        return;
      }
      if (pg.failWhenBlocked) throw lockTimeoutError();
      pg.log.push(`${owner}:waits:${row}:${mode}`);
      await new Promise((grant) => pg.waiting.push({ row, owner, mode, grant }));
      pg.log.push(`${owner}:granted:${row}:${mode}`);
    },
    hold(row, owner, mode) {
      pg.held.push({ row, owner, mode });
    },
    release(owner) {
      pg.held = pg.held.filter((h) => h.owner !== owner);
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (let i = 0; i < pg.waiting.length; i += 1) {
          const w = pg.waiting[i];
          const first = pg.waiting.findIndex((x) => x.row === w.row) === i;
          if (first && this.canGrant(w.row, w.owner, w.mode)) {
            pg.waiting.splice(i, 1);
            pg.held.push({ row: w.row, owner: w.owner, mode: w.mode });
            w.grant();
            progressed = true;
            break;
          }
        }
      }
    },
  };

  /** Waits while another transaction holds an uncommitted insert of `key`; then true when it is committed. */
  async function waitUnique(key, label, committedExists) {
    for (;;) {
      if (committedExists()) return true;
      const owner = pg.pending.get(key);
      if (owner && owner !== label) {
        if (pg.failWhenBlocked) throw lockTimeoutError();
        pg.log.push(`${label}:unique-wait:${key}:${owner}`);
        await pg.ended.get(owner).promise;
        continue;
      }
      // Claim the key in the SAME step as the check, as PostgreSQL's unique index does: the
      // caller's insert runs after an await, and without this claim a concurrent transaction
      // could pass the check in between (both "inserting" the same key). Released at the
      // transaction's end like every pending key.
      pg.pending.set(key, label);
      return false;
    }
  }

  // ---- one transaction ------------------------------------------------------------------
  function makeTx(label) {
    const local = { registers: {}, registerAudits: [], records: {}, recordAudits: [], scans: [], qrClosures: {}, lectures: {} };
    const statements = [];
    let aborted = false;

    const rk = (lectureId, studentId) => `${lectureId}:${studentId}`;
    const register = (id) => local.registers[id] ?? pg.committed.registers[id] ?? null;
    const record = (lectureId, studentId) => local.records[rk(lectureId, studentId)] ?? pg.committed.records[rk(lectureId, studentId)] ?? null;
    const recordById = (id) =>
      Object.values(local.records).find((r) => r.id === id) ?? Object.values(pg.committed.records).find((r) => r.id === id) ?? null;
    const scans = () => [...pg.committed.scans, ...local.scans];

    async function statement(op, fn) {
      statements.push(op);
      if (aborted) throw abortedError();
      if (pg.beforeStatement) await pg.beforeStatement(label, op);
      const injected = pg.failOn && pg.failOn(label, op);
      if (injected) {
        aborted = true;
        pg.log.push(`${label}:failed:${op}`);
        throw injected;
      }
      try {
        return await fn();
      } catch (error) {
        if (error && error.__db) aborted = true;
        throw error;
      }
    }

    const iso = (v) => (v === null ? null : new Date(v));

    const client = {
      $executeRawUnsafe: (sql) =>
        statement("SET", async () => {
          if (/^SET LOCAL lock_timeout = '3000ms'$/.test(sql)) return 0;
          throw new Error("unexpected raw SQL: " + sql);
        }),
      $queryRaw: (strings, ...values) => {
        const sql = strings.join("?").replace(/\s+/g, " ").trim();
        let m;

        if (/FROM "Student" WHERE "id" = \? FOR SHARE$/.test(sql)) {
          return statement("lock:student", async () => {
            const row = pg.committed.students[values[0]];
            if (!row) return [];
            await locks.acquire(`student:${row.id}`, label, "SHARE");
            const s = pg.committed.students[row.id];
            return [{ id: s.id, teacherId: s.teacherId, status: s.status, confirmationStatus: s.confirmationStatus, confirmedAt: s.confirmedAt, approvedAt: s.approvedAt }];
          });
        }
        if (/FROM "Student" WHERE "id" = ANY\(\?::text\[\]\) ORDER BY "id" FOR SHARE$/.test(sql)) {
          return statement("lock:students", async () => {
            const ids = [...values[0]].sort();
            const out = [];
            for (const id of ids) {
              if (!pg.committed.students[id]) continue;
              await locks.acquire(`student:${id}`, label, "SHARE");
              const st = pg.committed.students[id];
              if (st) out.push({ id: st.id, teacherId: st.teacherId, status: st.status, confirmationStatus: st.confirmationStatus, confirmedAt: st.confirmedAt, approvedAt: st.approvedAt });
            }
            pg.log.push(`${label}:lock:students:${out.length}`);
            return out;
          });
        }
        if ((m = /FROM "Lecture" WHERE "id" = \? FOR (SHARE|NO KEY UPDATE)$/.exec(sql))) {
          const mode = m[1] === "SHARE" ? "SHARE" : "NO_KEY_UPDATE";
          return statement("lock:lecture", async () => {
            if (!pg.committed.lectures[values[0]]) return [];
            await locks.acquire(`lecture:${values[0]}`, label, mode);
            return [{ ...pg.committed.lectures[values[0]] }];
          });
        }
        if (/FROM "Class" WHERE "id" = \? FOR KEY SHARE$/.test(sql)) {
          return statement("lock:class", async () => {
            if (!pg.committed.classes[values[0]]) return [];
            await locks.acquire(`class:${values[0]}`, label, "KEY_SHARE");
            return [{ ...pg.committed.classes[values[0]] }];
          });
        }
        if ((m = /FROM "LectureAttendanceRegister" WHERE "lectureId" = \? FOR (KEY SHARE|UPDATE)$/.exec(sql))) {
          const mode = m[1] === "KEY SHARE" ? "KEY_SHARE" : "UPDATE";
          return statement("lock:register", async () => {
            if (!register(values[0])) return [];
            await locks.acquire(`register:${values[0]}`, label, mode);
            const row = register(values[0]);
            return row ? [{ ...row }] : [];
          });
        }
        if (/^INSERT INTO "LectureAttendanceRegister"/.test(sql)) {
          return statement("insert:register", async () => {
            const [lectureId, classId, start, end, grace, now] = values;
            const key = `register:${lectureId}`;
            if (await waitUnique(key, label, () => Boolean(pg.committed.registers[lectureId]))) return [];
            if (local.registers[lectureId]) return [];
            await locks.acquire(`lecture:${lectureId}`, label, "KEY_SHARE");
            await locks.acquire(`class:${classId}`, label, "KEY_SHARE");
            local.registers[lectureId] = {
              lectureId, classId, scheduledStartAt: iso(start), scheduledEndAt: iso(end), graceMinutes: grace,
              finalizedAt: null, finalizedByTeacherId: null, version: 1, createdAt: iso(now), updatedAt: iso(now),
            };
            pg.pending.set(key, label);
            locks.hold(key, label, "UPDATE");
            pg.log.push(`${label}:insert:register:${lectureId}`);
            return [{ lectureId }];
          });
        }
        if (/FROM "LectureAttendance" WHERE "lectureId" = \? AND "studentId" = ANY\(\?::text\[\]\) ORDER BY "studentId" FOR NO KEY UPDATE$/.test(sql)) {
          return statement("lock:records", async () => {
            const [lectureId, ids] = values;
            const out = [];
            for (const studentId of [...ids].sort()) {
              if (!record(lectureId, studentId)) continue;
              await locks.acquire(`record:${lectureId}:${studentId}`, label, "NO_KEY_UPDATE");
              const row = record(lectureId, studentId);
              if (row) out.push({ ...row });
            }
            return out;
          });
        }
        if (/^INSERT INTO "LectureAttendance"/.test(sql)) {
          return statement("insert:record", async () => {
            const [id, lectureId, classId, studentId, status, statusSource, firstOnlineAt, firstQrAt, autoStatus, teacherStatus,
              teacherDecidedAt, teacherDecidedById, pendingReviewSince, createdAt] = values;
            const key = `record:${lectureId}:${studentId}`;
            if (await waitUnique(key, label, () => Boolean(pg.committed.records[rk(lectureId, studentId)]))) return [];
            if (local.records[rk(lectureId, studentId)]) return [];
            if (!register(lectureId)) throw fkError("LectureAttendance_lectureId_classId_fkey");
            const row = {
              id, lectureId, classId, studentId, status, statusSource, firstOnlineAt: iso(firstOnlineAt), firstQrAt: iso(firstQrAt),
              autoStatus, teacherStatus, teacherDecidedAt: iso(teacherDecidedAt), teacherDecidedById, pendingReviewSince: iso(pendingReviewSince),
              version: 1, createdAt: iso(createdAt), updatedAt: iso(createdAt),
            };
            checkRecord(row);
            local.records[rk(lectureId, studentId)] = row;
            pg.pending.set(key, label);
            locks.hold(key, label, "UPDATE");
            pg.log.push(`${label}:insert:record:${studentId}`);
            return [{ id }];
          });
        }
        if (/FROM "LectureQrAttendanceClosure" WHERE "lectureId" = \?$/.test(sql)) {
          return statement("read:closure", async () => {
            const row = local.qrClosures[values[0]] ?? pg.committed.qrClosures[values[0]];
            // Exactly the selected columns.
            return row ? [{ lectureId: row.lectureId, closedAt: row.closedAt, closedByTeacherId: row.closedByTeacherId }] : [];
          });
        }
        if (/^INSERT INTO "LectureQrAttendanceClosure"/.test(sql) && /ON CONFLICT \("lectureId"\) DO NOTHING RETURNING "lectureId"$/.test(sql)) {
          return statement("insert:closure", async () => {
            const [lectureId, classId, closedAt, closedByTeacherId] = values;
            assert.equal(typeof closedAt, "string", "UTC ISO text, explicitly cast");
            const key = `closure:${lectureId}`;
            if (await waitUnique(key, label, () => Boolean(pg.committed.qrClosures[lectureId]))) return [];
            if (local.qrClosures[lectureId]) return [];
            const reg = register(lectureId);
            if (!reg || reg.classId !== classId) throw fkError("LectureQrAttendanceClosure_lectureId_classId_fkey");
            local.qrClosures[lectureId] = { lectureId, classId, closedAt: new Date(closedAt), closedByTeacherId };
            pg.pending.set(key, label);
            pg.log.push(`${label}:insert:closure:${lectureId}`);
            return [{ lectureId }];
          });
        }
        return statement("raw", async () => {
          throw new Error("unexpected raw SQL: " + sql);
        });
      },

      lectureAttendanceRegisterAuditLog: {
        create: ({ data }) =>
          statement("create:registerAudit", async () => {
            const all = [...pg.committed.registerAudits, ...local.registerAudits];
            if (all.some((a) => a.lectureId === data.lectureId && a.version === data.version)) throw uniqueError(["lectureId", "version"]);
            if (!register(data.lectureId)) throw fkError("LectureAttendanceRegisterAuditLog_lectureId_fkey");
            checkRegisterAudit(data);
            const row = { id: nextId("register-audit"), ...data };
            local.registerAudits.push(row);
            pg.log.push(`${label}:audit:register:${data.action}`);
            return row;
          }),
        findMany: ({ where }) =>
          statement("read:registerAudits", async () =>
            [...pg.committed.registerAudits, ...local.registerAudits]
              .filter((a) => a.lectureId === where.lectureId && (where.action === undefined || a.action === where.action))
              .map((a) => ({ ...a }))
          ),
      },
      lecture: {
        findFirst: ({ where }) =>
          statement("read:lecture", async () => {
            const l = local.lectures[where.id] ?? pg.committed.lectures[where.id];
            const cls = l && pg.committed.classes[l.classId];
            return l && cls && l.status === where.status && isDefaultOk(l, where) && cls.teacherId === where.class.teacherId ? { id: l.id, classId: l.classId } : null;
          }),
        update: ({ where, data }) =>
          statement("update:lecture", async () => {
            const current = local.lectures[where.id] ?? pg.committed.lectures[where.id];
            if (!current) throw dbError("Record to update not found.", { code: "P2025" });
            const next = { ...current, ...data };
            if (next.endDate && !(next.endDate.getTime() > next.date.getTime())) throw checkError("Lecture_endDate_after_date");
            local.lectures[where.id] = next;
            pg.log.push(`${label}:update:lecture:${Object.keys(data).join(",")}`);
            const cls = pg.committed.classes[next.classId];
            return { ...next, class: { id: cls.id, name: cls.name ?? null, schedule: null } };
          }),
      },
      lectureAttendanceRegister: {
        findUnique: ({ where }) =>
          statement("read:register", async () => {
            const r = register(where.lectureId);
            return r ? { ...r } : null;
          }),
        update: ({ where, data }) =>
          statement("update:register", async () => {
            const current = register(where.lectureId);
            if (!current || (where.version !== undefined && current.version !== where.version)) {
              throw dbError("Record to update not found.", { code: "P2025" });
            }
            // The register freeze trigger.
            if (current.finalizedAt !== null) {
              throw dbError("LectureAttendanceRegister is finalized and cannot be changed", { code: "P2010", meta: { code: "P0001" } });
            }
            const next = { ...current, ...data };
            if (next.scheduledEndAt && !(next.scheduledEndAt.getTime() > next.scheduledStartAt.getTime())) {
              throw checkError("LectureAttendanceRegister_schedule_check");
            }
            if (isNull(next.finalizedAt) !== isNull(next.finalizedByTeacherId)) throw checkError("LectureAttendanceRegister_finalized_check");
            if (!(Number.isInteger(next.graceMinutes) && next.graceMinutes >= 0 && next.graceMinutes <= 240)) throw checkError("LectureAttendanceRegister_graceMinutes_check");
            local.registers[where.lectureId] = next;
            pg.log.push(`${label}:update:register:v${next.version}`);
            return next;
          }),
      },
      studentConfirmationHistory: {
        findMany: ({ where }) =>
          statement("read:history", async () =>
            pg.committed.history.filter((h) => (where.studentId.in ? where.studentId.in.includes(h.studentId) : h.studentId === where.studentId))
          ),
      },
      student: {
        findFirst: ({ where }) =>
          statement("read:student", async () => {
            const st = pg.committed.students[where.id];
            return st && st.teacherId === where.teacherId ? { id: st.id } : null;
          }),
      },
      classStudent: {
        findMany: ({ where }) =>
          statement("read:enrolments", async () =>
            pg.committed.enrolments.filter((e) => {
              if (e.classId !== where.classId) return false;
              if (where.student) return pg.committed.students[e.studentId]?.teacherId === where.student.teacherId;
              return e.studentId === where.studentId;
            })
          ),
      },
      classSession: {
        findMany: ({ where }) =>
          statement("read:sessions", async () =>
            Object.values(pg.committed.sessions)
              .filter((x) => x.lectureId === where.lectureId && (where.isActive === undefined || x.isActive === where.isActive))
              .map((x) => ({ id: x.id, startedAt: x.startedAt ?? null }))
          ),
      },
      attendance: {
        findMany: ({ where }) =>
          statement("read:visits", async () =>
            Object.values(pg.committed.visits)
              .filter((v) => pg.committed.sessions[v.classSessionId]?.lectureId === where.classSession.lectureId)
              .filter((v) => !where.studentId || where.studentId.in.includes(v.studentId))
              .map((v) => ({ studentId: v.studentId, joinedAt: v.joinedAt }))
          ),
      },
      studentQrToken: {
        findUnique: ({ where }) =>
          statement("read:token", async () => {
            const t = pg.committed.tokens[where.id];
            return t ? { studentId: t.studentId, revokedAt: t.revokedAt } : null;
          }),
      },
      lectureAttendance: {
        findMany: ({ where }) =>
          statement("read:records", async () => {
            const all = { ...pg.committed.records, ...local.records };
            if (where.OR) {
              // Schedule sync: the records with evidence.
              return Object.values(all)
                .filter((r) => r.lectureId === where.lectureId && (r.firstOnlineAt !== null || r.firstQrAt !== null))
                .map((r) => ({ studentId: r.studentId }));
            }
            return Object.values(all)
              .filter((r) => r.lectureId === where.lectureId)
              .sort((a, b) => (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0))
              .map((r) => ({ ...r }));
          }),
        // No ON CONFLICT: an existing (or concurrently inserted) row is a unique violation.
        createMany: ({ data, skipDuplicates }) =>
          statement("insert:records", async () => {
            assert.ok(!skipDuplicates, "skipDuplicates is never used");
            for (const row of data) {
              const key = `record:${row.lectureId}:${row.studentId}`;
              if (await waitUnique(key, label, () => Boolean(pg.committed.records[rk(row.lectureId, row.studentId)]))) {
                throw uniqueError(["lectureId", "studentId"]);
              }
              if (local.records[rk(row.lectureId, row.studentId)]) throw uniqueError(["lectureId", "studentId"]);
              if (!register(row.lectureId)) throw fkError("LectureAttendance_lectureId_classId_fkey");
            }
            for (const row of data) {
              const full = { ...row };
              checkRecord(full);
              local.records[rk(row.lectureId, row.studentId)] = full;
              pg.pending.set(`record:${row.lectureId}:${row.studentId}`, label);
            }
            pg.log.push(`${label}:insert:records:${data.length}`);
            return { count: data.length };
          }),
        update: ({ where, data, select }) =>
          statement("update:record", async () => {
            const current = recordById(where.id);
            if (!current || (where.version !== undefined && current.version !== where.version)) {
              throw dbError("Record to update not found.", { code: "P2025" });
            }
            const next = { ...current, ...data };
            checkRecord(next);
            local.records[rk(current.lectureId, current.studentId)] = next;
            pg.log.push(`${label}:update:record:${current.studentId}:v${next.version}`);
            return select ? Object.fromEntries(Object.keys(select).map((k) => [k, next[k]])) : next;
          }),
      },
      attendanceScanEvent: {
        create: ({ data }) =>
          statement("create:scan", async () => {
            checkScan(data);
            const key = `scan:${data.scannedByTeacherId}:${data.clientScanId}`;
            const exists = () => pg.committed.scans.some((s) => s.scannedByTeacherId === data.scannedByTeacherId && s.clientScanId === data.clientScanId);
            if (await waitUnique(key, label, exists)) throw uniqueError(["scannedByTeacherId", "clientScanId"]);
            if (data.lectureAttendanceId && !recordById(data.lectureAttendanceId)) throw fkError("AttendanceScanEvent_lectureAttendanceId_fkey");
            if (!pg.committed.lectures[data.lectureId]) throw fkError("AttendanceScanEvent_lectureId_classId_fkey");
            const row = { id: nextId("scan"), ...data };
            local.scans.push(row);
            pg.pending.set(key, label);
            pg.log.push(`${label}:scan:${data.result}:${data.effect}`);
            return { id: row.id };
          }),
      },
      attendanceAuditLog: {
        create: ({ data }) =>
          statement("create:audit", async () => {
            checkAudit(data);
            const all = [...pg.committed.recordAudits, ...local.recordAudits];
            if (all.some((a) => a.lectureAttendanceId === data.lectureAttendanceId && a.version === data.version)) {
              throw uniqueError(["lectureAttendanceId", "version"]);
            }
            if (!recordById(data.lectureAttendanceId)) throw fkError("AttendanceAuditLog_lectureAttendanceId_fkey");
            if (data.scanEventId && !scans().some((s) => s.id === data.scanEventId)) throw fkError("AttendanceAuditLog_scanEventId_fkey");
            if (data.attendanceVisitId && !pg.committed.visits[data.attendanceVisitId]) throw fkError("AttendanceAuditLog_attendanceVisitId_fkey");
            if (data.registerAuditId && ![...pg.committed.registerAudits, ...local.registerAudits].some((a) => a.id === data.registerAuditId)) {
              throw fkError("AttendanceAuditLog_registerAuditId_fkey");
            }
            const row = { id: nextId("audit"), ...data };
            local.recordAudits.push(row);
            pg.log.push(`${label}:audit:${data.action}:v${data.version}`);
            return row;
          }),
        createMany: ({ data }) =>
          statement("create:audits", async () => {
            const all = [...pg.committed.recordAudits, ...local.recordAudits];
            for (const a of data) {
              checkAudit(a);
              if (all.some((x) => x.lectureAttendanceId === a.lectureAttendanceId && x.version === a.version)) throw uniqueError(["lectureAttendanceId", "version"]);
              if (!recordById(a.lectureAttendanceId)) throw fkError("AttendanceAuditLog_lectureAttendanceId_fkey");
              if (a.registerAuditId && ![...pg.committed.registerAudits, ...local.registerAudits].some((x) => x.id === a.registerAuditId)) {
                throw fkError("AttendanceAuditLog_registerAuditId_fkey");
              }
            }
            for (const a of data) local.recordAudits.push({ id: nextId("audit"), ...a });
            pg.log.push(`${label}:audits:${data[0]?.action}:${data.length}`);
            return { count: data.length };
          }),
        count: ({ where }) =>
          statement("read:auditCount", async () =>
            [...pg.committed.recordAudits, ...local.recordAudits].filter((a) => a.lectureId === where.lectureId && a.action === where.action).length
          ),
      },
    };

    return {
      label,
      client,
      statements,
      commit() {
        Object.assign(pg.committed.registers, local.registers);
        pg.committed.registerAudits.push(...local.registerAudits);
        Object.assign(pg.committed.records, local.records);
        pg.committed.recordAudits.push(...local.recordAudits);
        pg.committed.scans.push(...local.scans);
        Object.assign(pg.committed.qrClosures, local.qrClosures);
        for (const [id, row] of Object.entries(local.lectures)) pg.committed.lectures[id] = row;
        pg.log.push(`${label}:commit`);
      },
    };
  }

  // ---- top-level client (autocommit reads) ---------------------------------------------
  function presentScanRow(s) {
    const student = s.studentId ? pg.committed.students[s.studentId] : null;
    const rec = s.lectureAttendanceId ? Object.values(pg.committed.records).find((r) => r.id === s.lectureAttendanceId) : null;
    return {
      id: s.id,
      lectureId: s.lectureId,
      scannedTokenHash: s.scannedTokenHash,
      result: s.result,
      effect: s.effect,
      afterFinalization: s.afterFinalization,
      receivedAt: s.receivedAt,
      student: student ? { id: student.id, name: student.name, registrationNumber: student.registrationNumber ?? null } : null,
      attendance: rec ? { status: rec.status, statusSource: rec.statusSource, pendingReviewSince: rec.pendingReviewSince, version: rec.version } : null,
    };
  }

  const prisma = {
    $transaction: async (fn, options) => {
      const label = `tx${++pg.seq}`;
      const tx = makeTx(label);
      let resolveEnded;
      pg.ended.set(label, { promise: new Promise((r) => { resolveEnded = r; }), resolve: () => resolveEnded() });
      const entry = { label, options, statements: tx.statements, outcome: "open" };
      pg.transactions.push(entry);
      try {
        const result = await fn(tx.client);
        tx.commit();
        entry.outcome = "commit";
        return result;
      } catch (error) {
        pg.log.push(`${label}:rollback`);
        entry.outcome = "rollback";
        throw error;
      } finally {
        for (const [key, owner] of pg.pending) if (owner === label) pg.pending.delete(key);
        locks.release(label);
        pg.ended.get(label).resolve();
      }
    },
    lecture: {
      findFirst: async ({ where }) => {
        const l = pg.committed.lectures[where.id];
        const cls = l && pg.committed.classes[l.classId];
        const ok = l && cls && cls.teacherId === where.class.teacherId && (where.status === undefined || l.status === where.status) && isDefaultOk(l, where);
        const result = ok
          ? { ...l, title: l.title ?? "Lecture", class: { id: cls.id, name: cls.name ?? null, schedule: null, teacherId: cls.teacherId, attendanceGraceMinutes: cls.attendanceGraceMinutes } }
          : null;
        if (pg.afterOwnershipRead) await pg.afterOwnershipRead();
        return result;
      },
      // Backfill: the lecture with its class's teacher and grace (no ownership filter).
      findUnique: async ({ where }) => {
        pg.log.push("read:lecture");
        const l = pg.committed.lectures[where.id];
        const cls = l && pg.committed.classes[l.classId];
        if (!l || !cls || !isDefaultOk(l, where)) return null;
        return { id: l.id, classId: l.classId, status: l.status, classStatus: l.classStatus, date: l.date,
          class: { teacherId: cls.teacherId, attendanceGraceMinutes: cls.attendanceGraceMinutes } };
      },
      // Backfill scopes (status, classStatus not, classId or date lt; by date, id) and the
      // gap report (class.teacherId, id gt, OR of register is null / open + start gte; by id; take).
      findMany: async ({ where, orderBy, take }) => {
        pg.log.push("read:lectures");
        const ms = (d) => d.getTime();
        const dateOk = (l, cond) => {
          if (!cond) return true;
          const unsupported = Object.keys(cond).filter((k) => k !== "lt" && k !== "gte");
          if (unsupported.length) throw new Error(`model: unsupported date operator ${unsupported.join(",")}`);
          return (cond.lt === undefined || ms(l.date) < ms(cond.lt)) && (cond.gte === undefined || ms(l.date) >= ms(cond.gte));
        };
        const registerOk = (l, cond) => {
          const r = pg.committed.registers[l.id] ?? null;
          if (cond.is === null) return r === null;
          if (!r) return false;
          const is = cond.is;
          return (is.finalizedAt === undefined || r.finalizedAt === is.finalizedAt) &&
            (is.scheduledStartAt === undefined || ms(r.scheduledStartAt) >= ms(is.scheduledStartAt.gte));
        };
        const branchOk = (l, b) => dateOk(l, b.date) && (b.attendanceRegister === undefined || registerOk(l, b.attendanceRegister));
        const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.keys(o)[0]);
        let rows = Object.values(pg.committed.lectures)
          .filter((l) => l.status === where.status && l.classStatus !== where.classStatus.not && isDefaultOk(l, where))
          .filter((l) => (where.classId !== undefined ? l.classId === where.classId : true))
          .filter((l) => (where.class ? pg.committed.classes[l.classId]?.teacherId === where.class.teacherId : true))
          .filter((l) => (where.id ? l.id > where.id.gt : true))
          .filter((l) => dateOk(l, where.date))
          .filter((l) => (where.OR ? where.OR.some((b) => branchOk(l, b)) : true))
          .sort((a, b) => {
            for (const k of keys) {
              const x = a[k] instanceof Date ? ms(a[k]) : a[k];
              const y = b[k] instanceof Date ? ms(b[k]) : b[k];
              if (x < y) return -1;
              if (x > y) return 1;
            }
            return 0;
          });
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((l) => {
          const r = pg.committed.registers[l.id] ?? null;
          return { id: l.id, classId: l.classId, date: l.date,
            attendanceRegister: r ? { scheduledStartAt: r.scheduledStartAt, finalizedAt: r.finalizedAt } : null };
        });
      },
      // Autocommit updates (title-only edits, COMPLETED): the row lock is taken and released at once.
      update: async ({ where, data }) => {
        const owner = `autocommit-${++pg.seq}`;
        await locks.acquire(`lecture:${where.id}`, owner, "NO_KEY_UPDATE");
        Object.assign(pg.committed.lectures[where.id], data);
        pg.log.push(`${owner}:update:lecture:${Object.keys(data).join(",")}`);
        locks.release(owner);
        const l = pg.committed.lectures[where.id];
        const cls = pg.committed.classes[l.classId];
        return { ...l, class: { id: cls.id, name: cls.name ?? null, schedule: null } };
      },
    },
    studentQrToken: {
      findUnique: async ({ where }) => {
        const t = Object.values(pg.committed.tokens).find((x) => x.tokenHash === where.tokenHash);
        if (!t) return null;
        const s = pg.committed.students[t.studentId];
        return { id: t.id, nonce: t.nonce, tokenHash: t.tokenHash, revokedAt: t.revokedAt, studentId: t.studentId, student: { teacherId: s.teacherId, status: s.status } };
      },
    },
    attendanceScanEvent: {
      findUnique: async ({ where }) => {
        const s = where.id
          ? pg.committed.scans.find((x) => x.id === where.id)
          : pg.committed.scans.find(
              (x) =>
                x.scannedByTeacherId === where.scannedByTeacherId_clientScanId.scannedByTeacherId &&
                x.clientScanId === where.scannedByTeacherId_clientScanId.clientScanId
            );
        return s ? presentScanRow(s) : null;
      },
    },
    student: {
      // History (read only): the teacher's student by id, any status.
      findFirst: async ({ where, select }) => {
        pg.log.push("read:student");
        const st = pg.committed.students[where.id];
        if (!st || (where.teacherId !== undefined && st.teacherId !== where.teacherId)) return null;
        if (where.status !== undefined) throw new Error("model: student.findFirst status filter not modelled");
        return pickSelected({ ...st }, select);
      },
      findMany: async ({ where }) => {
        pg.log.push("read:students");
        return where.id.in.map((id) => pg.committed.students[id]).filter(Boolean)
          .filter((st) => where.teacherId === undefined || st.teacherId === where.teacherId).map((st) => ({
          id: st.id, teacherId: st.teacherId, status: st.status, confirmationStatus: st.confirmationStatus,
          confirmedAt: st.confirmedAt, approvedAt: st.approvedAt, name: st.name, registrationNumber: st.registrationNumber ?? null,
        }));
      },
    },
    studentConfirmationHistory: {
      findMany: async ({ where }) => {
        pg.log.push("read:history");
        return pg.committed.history.filter((h) => (where.studentId.in ? where.studentId.in.includes(h.studentId) : h.studentId === where.studentId));
      },
    },
    classStudent: {
      findMany: async ({ where }) => {
        pg.log.push("read:enrolments");
        return pg.committed.enrolments.filter((e) => {
          if (e.classId !== where.classId) return false;
          if (where.student) return pg.committed.students[e.studentId]?.teacherId === where.student.teacherId;
          return where.studentId.in ? where.studentId.in.includes(e.studentId) : e.studentId === where.studentId;
        });
      },
    },
    lectureAttendance: {
      // History (read only): one record by (lectureId, studentId).
      findUnique: async ({ where, select }) => {
        pg.log.push("read:record");
        const key = where.lectureId_studentId;
        const r = pg.committed.records[`${key.lectureId}:${key.studentId}`];
        return r ? pickSelected({ ...r }, select) : null;
      },
      findMany: async ({ where }) => {
        pg.log.push("read:records");
        return Object.values(pg.committed.records)
          .filter((r) => r.lectureId === where.lectureId && (!where.studentId || where.studentId.in.includes(r.studentId)))
          .sort((a, b) => (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0))
          .map((r) => ({ ...r }));
      },
    },
    classSession: {
      findMany: async ({ where }) => {
        pg.log.push("read:sessions");
        return Object.values(pg.committed.sessions)
          .filter((x) => x.lectureId === where.lectureId && (where.isActive === undefined || x.isActive === where.isActive))
          .map((x) => ({ id: x.id, startedAt: x.startedAt ?? null }));
      },
    },
    lectureAttendanceRegister: {
      findUnique: async ({ where }) => {
        const r = pg.committed.registers[where.lectureId];
        return r ? { ...r } : null;
      },
    },
    // History (read only): the QR closure and both append-only audit logs, keyset
    // paged as PostgreSQL would answer them (version > cursor, ascending, take).
    lectureQrAttendanceClosure: {
      findUnique: async ({ where, select }) => {
        pg.log.push("read:closure");
        const c = pg.committed.qrClosures[where.lectureId];
        return c ? pickSelected({ ...c }, select) : null;
      },
    },
    lectureAttendanceRegisterAuditLog: {
      findMany: async ({ where, orderBy, take, select }) => {
        pg.log.push("read:registerAudits");
        return pageAudits(pg.committed.registerAudits.filter((a) => a.lectureId === where.lectureId), where, orderBy, take, select);
      },
    },
    attendanceAuditLog: {
      findMany: async ({ where, orderBy, take, select }) => {
        pg.log.push("read:recordAudits");
        return pageAudits(pg.committed.recordAudits.filter((a) => a.lectureAttendanceId === where.lectureAttendanceId), where, orderBy, take, select);
      },
    },
    attendance: {
      // Visits of a lecture's sessions (reconciliation): distinct students or
      // visits, studentId > cursor / in [...], ordered, limited.
      findMany: async ({ where, distinct, orderBy, take }) => {
        pg.log.push("read:visits");
        let rows = Object.values(pg.committed.visits).filter((v) => {
          const session = pg.committed.sessions[v.classSessionId];
          if (!session || session.lectureId !== where.classSession.lectureId) return false;
          if (where.studentId && where.studentId.gt !== undefined && !(v.studentId > where.studentId.gt)) return false;
          if (where.studentId && where.studentId.in && !where.studentId.in.includes(v.studentId)) return false;
          return true;
        });
        const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0]);
        rows = rows.sort((a, b) => {
          for (const [key] of keys) {
            const x = a[key] instanceof Date ? a[key].getTime() : a[key];
            const y = b[key] instanceof Date ? b[key].getTime() : b[key];
            if (x < y) return -1;
            if (x > y) return 1;
          }
          return 0;
        });
        if (distinct) {
          const seen = new Set();
          rows = rows.filter((r) => (seen.has(r.studentId) ? false : (seen.add(r.studentId), true)));
        }
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((v) => ({ id: v.id, studentId: v.studentId, joinedAt: v.joinedAt }));
      },
      findUnique: async ({ where }) => {
        const v = pg.committed.visits[where.id];
        if (!v) return null;
        const session = pg.committed.sessions[v.classSessionId];
        return { id: v.id, studentId: v.studentId, joinedAt: v.joinedAt, classSession: { lectureId: session ? session.lectureId : null } };
      },
    },
  };

  return { pg, locks, prisma, checkRecord, checkScan, checkAudit, checkRegisterAudit };
}

module.exports = { createPgModel, lockTimeoutError, dbError, CONFLICTS };
