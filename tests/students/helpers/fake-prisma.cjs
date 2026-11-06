/*
 * In-memory stand-in for the Prisma client, for the student tests. No database
 * is contacted.
 *
 *  - Any model name works (tables are created on first use).
 *  - Delegates: findFirst, findUnique, findMany, count, create, createMany,
 *    update, updateMany, deleteMany; `select` projection.
 *  - Where clauses: equality (undefined = no filter; null matches a column
 *    never set), { equals, in, not, gt, startsWith, contains } with
 *    mode: "insensitive", and OR / AND / NOT.
 *  - The Student table enforces the partial unique index
 *    "Student_registrationNumber_not_deleted_key" (registrationNumber unique
 *    among rows with status <> 2, case-sensitive, NULLs never clash) by
 *    throwing Prisma P2002, like PostgreSQL would. createMany is
 *    all-or-nothing.
 *  - $transaction(fn) runs fn with the same client (no rollback).
 *  - state.stopOn = "table.method" makes that call throw STOP (used to prove a
 *    code path got past its checks); state.beforeWrite(table, method, data)
 *    runs before every write (used to simulate a concurrent registration).
 */

"use strict";

const { Prisma } = require("@prisma/client");

const STOP = "STOPPED_AT_MARKER";

function createFakePrisma() {
  const db = {};
  const state = { stopOn: null, beforeWrite: null };
  let nextId = 1;

  const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);

  function matchValue(actual, cond) {
    if (cond === undefined) return true;
    if (cond === null) return actual === null || actual === undefined;
    if (typeof cond !== "object" || cond instanceof Date) return actual === cond;
    const norm = (v) => (cond.mode === "insensitive" ? lower(v) : v);
    if ("equals" in cond && norm(actual) !== norm(cond.equals)) return false;
    if ("in" in cond && !cond.in.map(norm).includes(norm(actual))) return false;
    if ("not" in cond && actual === cond.not) return false;
    if ("gt" in cond && !(actual > cond.gt)) return false;
    if ("startsWith" in cond && !(typeof actual === "string" && norm(actual).startsWith(norm(cond.startsWith)))) return false;
    if ("contains" in cond && !(typeof actual === "string" && norm(actual).includes(norm(cond.contains)))) return false;
    return true;
  }

  function matches(row, where = {}) {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "OR") {
        if (!cond.some((w) => matches(row, w))) return false;
      } else if (key === "AND") {
        if (![].concat(cond).every((w) => matches(row, w))) return false;
      } else if (key === "NOT") {
        if ([].concat(cond).some((w) => matches(row, w))) return false;
      } else if (!matchValue(row[key], cond)) {
        return false;
      }
    }
    return true;
  }

  const project = (row, select) =>
    row && select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row && { ...row };

  function uniqueViolation() {
    return new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`registrationNumber`)", {
      code: "P2002",
      clientVersion: "5.22.0",
      meta: { target: ["registrationNumber"] },
    });
  }

  /** The partial unique index, checked for `rows` against the table plus each other. */
  function assertStudentIndex(rows, table) {
    const live = (r) => r.registrationNumber != null && r.status !== 2;
    const ids = new Set(rows.map((r) => r.id));
    const seen = new Set(table.filter((r) => !ids.has(r.id) && live(r)).map((r) => r.registrationNumber));
    for (const row of rows.filter(live)) {
      if (seen.has(row.registrationNumber)) throw uniqueViolation();
      seen.add(row.registrationNumber);
    }
  }

  function withDefaults(table, data) {
    const row = { id: `${table}-${nextId++}`, ...data };
    if (table === "student" && row.status === undefined) row.status = 0;
    return row;
  }

  function delegate(table) {
    const rows = () => (db[table] ??= []);
    const guard = (method) => {
      if (state.stopOn === `${table}.${method}`) throw new Error(STOP);
    };
    const beforeWrite = async (method, data) => {
      if (state.beforeWrite) await state.beforeWrite(table, method, data);
    };

    return {
      async findFirst({ where, select } = {}) {
        guard("findFirst");
        return project(rows().find((r) => matches(r, where)) ?? null, select);
      },
      async findUnique({ where, select } = {}) {
        guard("findUnique");
        return project(rows().find((r) => matches(r, where)) ?? null, select);
      },
      async findMany({ where, select } = {}) {
        guard("findMany");
        return rows().filter((r) => matches(r, where)).map((r) => project(r, select));
      },
      async count({ where } = {}) {
        guard("count");
        return rows().filter((r) => matches(r, where)).length;
      },
      async create({ data, select }) {
        guard("create");
        await beforeWrite("create", data);
        const row = withDefaults(table, data);
        if (table === "student") assertStudentIndex([row], rows());
        rows().push(row);
        return project(row, select);
      },
      async createMany({ data }) {
        guard("createMany");
        await beforeWrite("createMany", data);
        const created = data.map((d) => withDefaults(table, d));
        if (table === "student") assertStudentIndex(created, rows());
        rows().push(...created);
        return { count: created.length };
      },
      async update({ where, data, select }) {
        guard("update");
        await beforeWrite("update", data);
        const row = rows().find((r) => matches(r, where));
        if (!row) throw new Error(`${table}.update: record not found`);
        const next = { ...row, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
        if (table === "student") assertStudentIndex([next], rows());
        Object.assign(row, next);
        return project(row, select);
      },
      async updateMany({ where, data }) {
        guard("updateMany");
        await beforeWrite("updateMany", data);
        const hit = rows().filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      async deleteMany({ where } = {}) {
        guard("deleteMany");
        const keep = rows().filter((r) => !matches(r, where));
        const count = rows().length - keep.length;
        db[table] = keep;
        return { count };
      },
    };
  }

  const delegates = {};
  const prisma = new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === "$transaction") return async (fn) => fn(prisma);
        if (typeof prop !== "string" || prop.startsWith("$") || prop === "then") return undefined;
        return (delegates[prop] ??= delegate(prop));
      },
    }
  );

  function reset(tables) {
    for (const key of Object.keys(db)) delete db[key];
    for (const [name, list] of Object.entries(tables)) db[name] = list.map((r) => ({ ...r }));
    state.stopOn = null;
    state.beforeWrite = null;
  }

  return { db, prisma, state, reset, STOP };
}

module.exports = { createFakePrisma, STOP };
