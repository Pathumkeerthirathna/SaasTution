/*
 * In-memory Prisma double for the student recorded-lecture tests (RL-4.2).
 *
 * Unlike a shape-only mock, it EVALUATES the where / orderBy / select the
 * service sends against related rows, so the tests check what the query
 * means (which recordings a student really gets), not how it is spelled:
 *
 *   recordedLecture -> lecture (to-one), class (to-one)
 *   class           -> students (to-many ClassStudent)
 *   classStudent    -> student, class (to-one)
 *
 * Supported: scalar equality (Date by instant), { equals, not, in, notIn,
 * lt, lte, gt, gte }, AND / OR / NOT, to-one relation filters, to-many
 * some / every / none, orderBy on scalars and to-one relation scalars,
 * take, nested select. Anything else (an unknown field, operator or relation)
 * THROWS, so a misspelled filter can never silently match everything.
 *
 * String comparison is JavaScript code-unit order; for the lower-case UUIDs
 * used here that is the same order PostgreSQL gives a uuid column. The real
 * PostgreSQL check of these queries is deferred to RL-3.6 (localhost only,
 * never Neon).
 */

"use strict";

const MODELS = {
  recordedLecture: {
    table: "recordings",
    relations: {
      lecture: { kind: "one", model: "lecture", local: "lectureId" },
      class: { kind: "one", model: "class", local: "classId" },
    },
  },
  lecture: { table: "lectures", relations: { class: { kind: "one", model: "class", local: "classId" } } },
  class: { table: "classes", relations: { students: { kind: "many", model: "classStudent", foreign: "classId" } } },
  classStudent: {
    table: "classStudents",
    relations: {
      student: { kind: "one", model: "student", local: "studentId" },
      class: { kind: "one", model: "class", local: "classId" },
    },
  },
  student: { table: "students", relations: {} },
};

const OPERATORS = new Set(["equals", "not", "in", "notIn", "lt", "lte", "gt", "gte"]);

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function same(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  return comparable(a) === comparable(b);
}

function compare(a, b) {
  const x = comparable(a);
  const y = comparable(b);
  if (typeof x !== typeof y) throw new Error(`fake db: comparing ${typeof x} with ${typeof y}`);
  return x < y ? -1 : x > y ? 1 : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value);
}

function matchScalar(value, condition, field) {
  if (!isPlainObject(condition)) return same(value, condition);
  for (const [op, arg] of Object.entries(condition)) {
    if (!OPERATORS.has(op)) throw new Error(`fake db: unsupported operator ${op} on ${field}`);
    if (op === "equals" && !same(value, arg)) return false;
    if (op === "not" && (isPlainObject(arg) ? matchScalar(value, arg, field) : same(value, arg))) return false;
    if (op === "in" && !arg.some((v) => same(value, v))) return false;
    if (op === "notIn" && arg.some((v) => same(value, v))) return false;
    if (["lt", "lte", "gt", "gte"].includes(op)) {
      if (value === null || value === undefined) return false;
      const c = compare(value, arg);
      if (op === "lt" && !(c < 0)) return false;
      if (op === "lte" && !(c <= 0)) return false;
      if (op === "gt" && !(c > 0)) return false;
      if (op === "gte" && !(c >= 0)) return false;
    }
  }
  return true;
}

function createFakeStudentDb() {
  const db = { recordings: [], lectures: [], classes: [], classStudents: [], students: [] };
  const queries = [];

  function related(modelName, row, relationName) {
    const rel = MODELS[modelName].relations[relationName];
    const table = db[MODELS[rel.model].table];
    if (rel.kind === "one") return table.find((r) => r.id === row[rel.local]) ?? null;
    return table.filter((r) => r[rel.foreign] === row.id);
  }

  function matches(modelName, row, where) {
    if (where === undefined) return true;
    if (!isPlainObject(where)) throw new Error(`fake db: bad where for ${modelName}`);
    for (const [key, condition] of Object.entries(where)) {
      if (key === "AND") {
        const list = Array.isArray(condition) ? condition : [condition];
        if (!list.every((w) => matches(modelName, row, w))) return false;
        continue;
      }
      if (key === "OR") {
        if (!condition.some((w) => matches(modelName, row, w))) return false;
        continue;
      }
      if (key === "NOT") {
        const list = Array.isArray(condition) ? condition : [condition];
        if (list.some((w) => matches(modelName, row, w))) return false;
        continue;
      }
      const rel = MODELS[modelName].relations[key];
      if (rel) {
        if (rel.kind === "one") {
          const target = related(modelName, row, key);
          if (!target || !matches(rel.model, target, condition)) return false;
        } else {
          const targets = related(modelName, row, key);
          for (const [op, inner] of Object.entries(condition)) {
            if (op === "some" && !targets.some((t) => matches(rel.model, t, inner))) return false;
            else if (op === "every" && !targets.every((t) => matches(rel.model, t, inner))) return false;
            else if (op === "none" && targets.some((t) => matches(rel.model, t, inner))) return false;
            else if (!["some", "every", "none"].includes(op)) throw new Error(`fake db: unsupported list filter ${op}`);
          }
        }
        continue;
      }
      if (!Object.hasOwn(row, key)) throw new Error(`fake db: unknown field ${modelName}.${key}`);
      if (!matchScalar(row[key], condition, `${modelName}.${key}`)) return false;
    }
    return true;
  }

  function sortValue(modelName, row, spec) {
    const [[key, dir]] = Object.entries(spec);
    const rel = MODELS[modelName].relations[key];
    if (rel) {
      if (rel.kind !== "one") throw new Error("fake db: ordering by a list relation");
      return sortValue(rel.model, related(modelName, row, key), dir);
    }
    if (!Object.hasOwn(row, key)) throw new Error(`fake db: unknown order field ${modelName}.${key}`);
    if (dir !== "asc" && dir !== "desc") throw new Error(`fake db: bad direction ${dir}`);
    return { value: row[key], dir };
  }

  function order(modelName, rows, orderBy) {
    if (!orderBy) return rows;
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        const x = sortValue(modelName, a, spec);
        const y = sortValue(modelName, b, spec);
        const c = compare(x.value, y.value);
        if (c !== 0) return x.dir === "asc" ? c : -c;
      }
      return 0;
    });
  }

  function pick(modelName, row, select) {
    if (!select) return { ...row };
    const out = {};
    for (const [key, value] of Object.entries(select)) {
      if (!value) continue;
      const rel = MODELS[modelName].relations[key];
      if (rel) {
        if (rel.kind !== "one") throw new Error("fake db: selecting a list relation");
        const target = related(modelName, row, key);
        out[key] = target ? pick(rel.model, target, value.select) : null;
        continue;
      }
      if (!Object.hasOwn(row, key)) throw new Error(`fake db: unknown select field ${modelName}.${key}`);
      out[key] = row[key];
    }
    return out;
  }

  function delegate(modelName) {
    const rows = () => db[MODELS[modelName].table];
    return {
      async findMany(args = {}) {
        queries.push({ model: modelName, op: "findMany", args });
        const found = order(modelName, rows().filter((r) => matches(modelName, r, args.where)), args.orderBy);
        const taken = args.take === undefined ? found : found.slice(0, args.take);
        return taken.map((r) => pick(modelName, r, args.select));
      },
      async findFirst(args = {}) {
        queries.push({ model: modelName, op: "findFirst", args });
        const found = order(modelName, rows().filter((r) => matches(modelName, r, args.where)), args.orderBy);
        return found.length ? pick(modelName, found[0], args.select) : null;
      },
      async findUnique(args) {
        queries.push({ model: modelName, op: "findUnique", args });
        const row = rows().find((r) => r.id === args.where.id) ?? null;
        return row ? pick(modelName, row, args.select) : null;
      },
    };
  }

  const prisma = {
    recordedLecture: delegate("recordedLecture"),
    lecture: delegate("lecture"),
    class: delegate("class"),
    classStudent: delegate("classStudent"),
    student: delegate("student"),
  };
  return { db, prisma, queries };
}

module.exports = { createFakeStudentDb };
