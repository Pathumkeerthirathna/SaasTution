/*
 * In-memory stand-in for the Prisma client, for the breakout service tests.
 * Implements only what the breakout services use:
 *   - model delegates: findFirst, findUnique(OrThrow), findMany, create,
 *     update, count (equality, { in }, { not } and the classSession ->
 *     class.teacherId relation filter; select; orderBy);
 *   - the raw lock statements of lib/breakout-activities/locks.ts, answered
 *     from the tables and RECORDED in order (lock-order assertions);
 *   - $transaction(fn, options): records the options, runs fn with a
 *     transaction client (no $transaction on it, like Prisma's), and ROLLS
 *     BACK every table on error, like a database would.
 * No database is contacted.
 */

"use strict";

const TABLES = [
  "classSession",
  "class",
  "student",
  "classStudent",
  "breakoutAssignment",
  "breakoutAssignmentDraft",
  "breakoutAssignmentSubmission",
  "breakoutQuiz",
  "breakoutQuizSubmission",
];

// Tables whose model has an @updatedAt column (BreakoutAssignmentSubmission has none).
const HAS_UPDATED_AT = new Set(["breakoutAssignment", "breakoutAssignmentDraft", "breakoutQuiz", "breakoutQuizSubmission"]);

// The schema's unique constraints, enforced by createMany (and its skipDuplicates).
const UNIQUE_KEYS = {
  breakoutQuizSubmission: [["quizId", "studentId"]],
  breakoutAssignmentDraft: [["assignmentId", "studentId"]],
  breakoutAssignmentSubmission: [["assignmentId", "studentId", "version"], ["assignmentId", "studentId", "idempotencyKey"]],
};

function clone(value) {
  return structuredClone(value);
}

/**
 * `appNow`: the clock Prisma's @updatedAt would use (this server's own
 * clock) when a write does not pass updatedAt itself. Tests set it apart
 * from the database clock, so a forgotten explicit updatedAt is visible.
 */
function createFakeBreakoutDb({ appNow = () => new Date("1999-01-01T00:00:00.000Z") } = {}) {
  const now = appNow;
  const tables = Object.fromEntries(TABLES.map((t) => [t, []]));
  const calls = []; // { tx, kind, sql?, values?, model?, method?, args? }
  const transactions = []; // options per $transaction call
  const failures = {}; // "model.method" -> remaining call index (1-based) to fail at
  let txCounter = 0;

  const matches = (table, row, where = {}) => {
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (table === "classSession" && key === "class") {
        const cls = tables.class.find((c) => c.id === row.classId);
        if (!cls || (cond.teacherId !== undefined && cls.teacherId !== cond.teacherId)) return false;
        continue;
      }
      // student.classes.some { classId, isActive }: the ClassStudent enrolment rows.
      if (table === "student" && key === "classes") {
        const some = cond.some ?? {};
        const ok = tables.classStudent.some((cs) => cs.studentId === row.id && matches("classStudent", cs, some));
        if (!ok) return false;
        continue;
      }
      const value = row[key];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        if ("in" in cond && !cond.in.includes(value)) return false;
        if ("not" in cond && value === cond.not) return false;
        continue;
      }
      if (value instanceof Date && cond instanceof Date) {
        if (value.getTime() !== cond.getTime()) return false;
      } else if (value !== cond) return false;
    }
    return true;
  };

  const pick = (row, select) => {
    if (!row) return null;
    if (!select) return clone(row);
    const out = {};
    for (const [key, on] of Object.entries(select)) if (on) out[key] = clone(row[key]);
    return out;
  };

  const sortRows = (rows, orderBy) => {
    const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    return [...rows].sort((a, b) => {
      for (const order of orders) {
        const [key, dir] = Object.entries(order)[0];
        const av = a[key] instanceof Date ? a[key].getTime() : a[key];
        const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
        if (av < bv) return dir === "desc" ? 1 : -1;
        if (av > bv) return dir === "desc" ? -1 : 1;
      }
      return 0;
    });
  };

  const DEFAULTS = {
    breakoutAssignment: { status: 0, state: "DRAFT", publishedAt: null, closedAt: null, publishGroupId: null, briefFileName: null, briefFilePath: null, briefFileSize: null },
    breakoutQuiz: { status: 0, state: "DRAFT", publishedAt: null, closedAt: null, publishGroupId: null, instructions: null, timeLimitSeconds: null },
    breakoutQuizSubmission: { attemptStatus: "IN_PROGRESS", answers: {}, revision: 0, deadlineAt: null, lastSavedAt: null, submittedAt: null, grading: null, autoScore: null, finalScore: null, overriddenAt: null },
    breakoutAssignmentSubmission: { isLatest: true, answerText: null, fileName: null, filePath: null, fileSize: null },
    breakoutAssignmentDraft: { answerText: "", revision: 0 },
  };

  const maybeFail = (name) => {
    if (failures[name] === undefined) return;
    failures[name] -= 1;
    if (failures[name] === 0) {
      delete failures[name];
      throw new Error(`injected failure: ${name}`);
    }
  };

  function delegates(txId) {
    const out = {};
    for (const table of TABLES) {
      const record = (method, args) => calls.push({ tx: txId, kind: "model", model: table, method, args: clone(args) });
      const findFirst = async (args = {}) => {
        record("findFirst", args);
        return pick(sortRows(tables[table].filter((r) => matches(table, r, args.where)), args.orderBy)[0], args.select);
      };
      out[table] = {
        findFirst,
        findUnique: async (args) => {
          record("findUnique", args);
          return pick(tables[table].find((r) => matches(table, r, args.where)), args.select);
        },
        findUniqueOrThrow: async (args) => {
          record("findUniqueOrThrow", args);
          const row = tables[table].find((r) => matches(table, r, args.where));
          if (!row) throw new Error(`${table} not found`);
          return pick(row, args.select);
        },
        findMany: async (args = {}) => {
          record("findMany", args);
          return sortRows(tables[table].filter((r) => matches(table, r, args.where)), args.orderBy).map((r) => pick(r, args.select));
        },
        count: async (args = {}) => {
          record("count", args);
          return tables[table].filter((r) => matches(table, r, args.where)).length;
        },
        create: async (args) => {
          record("create", args);
          maybeFail(`${table}.create`);
          // Like @updatedAt: an explicit value is kept, otherwise the app clock.
          const row = { ...(DEFAULTS[table] ?? {}), ...(HAS_UPDATED_AT.has(table) ? { updatedAt: now() } : {}), ...clone(args.data) };
          tables[table].push(row);
          return pick(row, args.select);
        },
        // INSERT ... ON CONFLICT DO NOTHING with skipDuplicates, like Prisma on
        // PostgreSQL; without it a duplicate is the unique-violation error.
        createMany: async (args) => {
          record("createMany", args);
          maybeFail(`${table}.createMany`);
          const rows = Array.isArray(args.data) ? args.data : [args.data];
          let count = 0;
          for (const data of rows) {
            const keys = UNIQUE_KEYS[table] ?? [];
            const duplicate = keys.some((fields) => tables[table].some((r) => fields.every((f) => r[f] === data[f])));
            if (duplicate) {
              if (args.skipDuplicates) continue;
              throw Object.assign(new Error(`Unique constraint failed on ${table}`), { name: "PrismaClientKnownRequestError", code: "P2002" });
            }
            tables[table].push({ ...(DEFAULTS[table] ?? {}), ...(HAS_UPDATED_AT.has(table) ? { updatedAt: now() } : {}), ...clone(data) });
            count += 1;
          }
          return { count };
        },
        updateMany: async (args) => {
          record("updateMany", args);
          maybeFail(`${table}.updateMany`);
          const rows = tables[table].filter((r) => matches(table, r, args.where));
          // Like @updatedAt: only tables that have the column get the fallback.
          for (const row of rows) Object.assign(row, HAS_UPDATED_AT.has(table) ? { updatedAt: now() } : {}, clone(args.data));
          return { count: rows.length };
        },
        update: async (args) => {
          record("update", args);
          maybeFail(`${table}.update`);
          const row = tables[table].find((r) => matches(table, r, args.where));
          if (!row) throw new Error(`${table} to update not found`);
          Object.assign(row, HAS_UPDATED_AT.has(table) ? { updatedAt: now() } : {}, clone(args.data));
          return pick(row, args.select);
        },
      };
    }
    return out;
  }

  const normalize = (strings) => strings.join("?").replace(/\s+/g, " ").trim();

  function raw(txId) {
    return {
      $executeRawUnsafe: async (sql) => {
        calls.push({ tx: txId, kind: "raw", sql, values: [] });
        return 0;
      },
      $executeRaw: async (strings, ...values) => {
        calls.push({ tx: txId, kind: "raw", sql: normalize(strings), values });
        return 1;
      },
      $queryRaw: async (strings, ...values) => {
        const sql = normalize(strings);
        calls.push({ tx: txId, kind: "raw", sql, values });
        if (sql.includes('FROM "ClassSession"')) {
          const s = tables.classSession.find((r) => r.id === values[0]);
          return s ? [{ id: s.id, classId: s.classId, isActive: s.isActive }] : [];
        }
        if (sql.includes('FROM "BreakoutAssignment"') || sql.includes('FROM "BreakoutQuiz" ')) {
          const table = sql.includes('FROM "BreakoutAssignment"') ? "breakoutAssignment" : "breakoutQuiz";
          const row = tables[table].find((r) => r.id === values[0] && r.classSessionId === values[1]);
          if (!row) return [];
          // The student share lock (FOR KEY SHARE) also reads the target room.
          return sql.endsWith("FOR KEY SHARE")
            ? [{ id: row.id, classSessionId: row.classSessionId, state: row.state, status: row.status, targetRoomType: row.targetRoomType, targetRoomId: row.targetRoomId ?? null }]
            : [{ id: row.id, state: row.state, status: row.status }];
        }
        if (sql.includes('FROM "BreakoutQuizSubmission" WHERE "quizId" = ? AND "studentId" = ?')) {
          const row = tables.breakoutQuizSubmission.find((r) => r.quizId === values[0] && r.studentId === values[1] && r.classSessionId === values[2]);
          return row ? [{ id: row.id }] : [];
        }
        if (sql.includes("'IN_PROGRESS' ORDER BY")) {
          return tables.breakoutQuizSubmission
            .filter((r) => r.quizId === values[0] && r.classSessionId === values[1] && r.attemptStatus === "IN_PROGRESS")
            .map((r) => r.id)
            .sort()
            .map((id) => ({ id }));
        }
        if (sql.includes('FROM "BreakoutQuizSubmission" WHERE "id" = ?')) {
          const row = tables.breakoutQuizSubmission.find((r) => r.id === values[0] && r.quizId === values[1] && r.classSessionId === values[2]);
          return row ? [{ id: row.id }] : [];
        }
        throw new Error(`fake db: unexpected raw query: ${sql}`);
      },
    };
  }

  const client = {
    ...delegates(0),
    ...raw(0),
    $transaction: async (fn, options) => {
      const txId = ++txCounter;
      transactions.push(clone(options));
      const snapshot = clone(tables);
      const tx = { ...delegates(txId), ...raw(txId) };
      try {
        return await fn(tx);
      } catch (error) {
        for (const t of TABLES) tables[t] = snapshot[t];
        throw error;
      }
    },
  };

  return {
    client,
    tables,
    calls,
    transactions,
    /** Make the n-th next call of "model.method" throw (rolled back like a database error). */
    failOn(name, nth = 1) {
      failures[name] = nth;
    },
    /** Raw SQL (in order) sent in transaction `txId` (default: the last one). */
    rawSql(txId = txCounter) {
      return calls.filter((c) => c.tx === txId && c.kind === "raw").map((c) => c.sql);
    },
    lastTx: () => txCounter,
  };
}

module.exports = { createFakeBreakoutDb };
