/*
 * In-memory stand-in for the parts of PrismaClient the fee-waiver code uses.
 *
 * Generic where evaluation (scalars, Date equality, in / gt / gte / lt / lte /
 * not, AND / OR / NOT, to-one relation filters and to-many some / none /
 * every), select / include projection, orderBy, the two unique constraints
 * that matter here (ClassStudentFee per month, one active rule per position),
 * an updatedAt that changes on every write, and a hook to simulate a
 * concurrent write landing between a read and a conditional write.
 */

"use strict";

const { Prisma } = require("@prisma/client");

const MODELS = {
  student: "Student",
  class: "Class",
  classStudent: "ClassStudent",
  classStudentFee: "ClassStudentFee",
  classPayment: "ClassPayment",
  paymentMessage: "PaymentMessage",
  classPaymentReversal: "ClassPaymentReversal",
  lecture: "Lecture",
  classFeeWaiverRule: "ClassFeeWaiverRule",
  feeWaiverSettings: "FeeWaiverSettings",
  classFee: "ClassFee",
  studentConfirmationHistory: "StudentConfirmationHistory",
  teacher: "Teacher",
  // Monthly resource access (services/resource-access-service.ts).
  classStudentResourceAccess: "ClassStudentResourceAccess",
  recordedLecture: "RecordedLecture",
  note: "Note",
  lectureWhiteboard: "LectureWhiteboard",
  classPaper: "ClassPaper",
  materialBundle: "MaterialBundle",
  youTubeRecording: "YouTubeRecording",
  assignment: "Assignment",
};

const RELATIONS = {
  Student: { classStudents: ["ClassStudent", "studentId", "many"] },
  Class: {
    students: ["ClassStudent", "classId", "many"],
    lectures: ["Lecture", "classId", "many"],
    teacher: null,
  },
  ClassStudent: {
    student: ["Student", "studentId"],
    class: ["Class", "classId"],
    fees: ["ClassStudentFee", "classStudentId", "many"],
  },
  ClassStudentFee: {
    classStudent: ["ClassStudent", "classStudentId"],
    payments: ["ClassPayment", "classStudentFeeId", "many"],
    joinWaiverRule: ["ClassFeeWaiverRule", "joinWaiverRuleId"],
  },
  ClassPayment: {
    classStudentFee: ["ClassStudentFee", "classStudentFeeId"],
    student: ["Student", "studentId"],
    class: ["Class", "classId"],
    recordedByTeacher: ["Teacher", "recordedByTeacherId"],
    messages: ["PaymentMessage", "paymentId", "many"],
    // One-to-one, the foreign key on the reversal row.
    reversal: ["ClassPaymentReversal", "paymentId", "reverse-one"],
  },
  PaymentMessage: {},
  ClassPaymentReversal: {},
  Lecture: {
    class: ["Class", "classId"],
    notes: ["Note", "lectureId", "many"],
    whiteboards: ["LectureWhiteboard", "lectureId", "many"],
    youtubeRecordings: ["YouTubeRecording", "lectureId", "many"],
    assignments: ["Assignment", "lectureId", "many"],
  },
  ClassFeeWaiverRule: {},
  FeeWaiverSettings: {},
  ClassFee: {},
  StudentConfirmationHistory: {},
  Teacher: {},
  ClassStudentResourceAccess: { classStudent: ["ClassStudent", "classStudentId"] },
  RecordedLecture: { class: ["Class", "classId"], lecture: ["Lecture", "lectureId"] },
  Note: { lecture: ["Lecture", "lectureId"] },
  LectureWhiteboard: { lecture: ["Lecture", "lectureId"] },
  ClassPaper: { class: ["Class", "classId"] },
  MaterialBundle: { class: ["Class", "classId"] },
  YouTubeRecording: { lecture: ["Lecture", "lectureId"] },
  Assignment: {},
};

const FEE_DEFAULTS = {
  discount: 0,
  lateJoinDeduct: 0,
  waiverAmount: 0,
  status: 0,
  dueDate: null,
  lateJoinDeductManual: false,
  joinWaiverRuleId: null,
  joinWaiverSequence: null,
  joinWaiverType: null,
  joinWaiverValue: null,
  joinWaiverLecturesBefore: null,
  joinWaiverEnrolledAt: null,
  joinWaiverBaseAmount: null,
  joinWaiverComputedAt: null,
  // Free Card columns (migration 20261120120000): database defaults.
  freeCard: false,
  freeCardIssuedAt: null,
  freeCardIssuedByTeacherId: null,
};

function createFakeDb() {
  const tables = Object.fromEntries(Object.values(MODELS).map((m) => [m, []]));
  let idCounter = 0;
  let tick = 0;
  const writes = [];
  const enrolmentLocks = [];
  // Every enrolment lock, both kinds, in the order taken.
  const lockLog = [];
  const hooks = { beforeUpdateMany: null, failOn: null, onEnrolmentLock: null };

  const nextTick = () => new Date(Date.UTC(2030, 0, 1) + ++tick);
  const nextId = (model) => `${model.toLowerCase()}-${++idCounter}`;

  // ---- where -------------------------------------------------------------------
  const isPlainObject = (v) => v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);
  const eq = (a, b) =>
    a instanceof Date || b instanceof Date
      ? a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
      : (a ?? null) === (b ?? null);
  const cmp = (a, b) => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b);

  function matchScalar(value, cond) {
    if (!isPlainObject(cond)) return eq(value, cond);
    for (const [op, arg] of Object.entries(cond)) {
      if (op === "equals" && !eq(value, arg)) return false;
      if (op === "in" && !arg.some((x) => eq(value, x))) return false;
      if (op === "notIn" && arg.some((x) => eq(value, x))) return false;
      if (op === "not" && (isPlainObject(arg) ? matchScalar(value, arg) : eq(value, arg))) return false;
      if (op === "gt" && !(value !== null && value !== undefined && cmp(value, arg) > 0)) return false;
      if (op === "gte" && !(value !== null && value !== undefined && cmp(value, arg) >= 0)) return false;
      if (op === "lt" && !(value !== null && value !== undefined && cmp(value, arg) < 0)) return false;
      if (op === "lte" && !(value !== null && value !== undefined && cmp(value, arg) <= 0)) return false;
    }
    return true;
  }

  function related(model, row, name) {
    const rel = RELATIONS[model][name];
    const [target, fk, many] = rel;
    if (many === "reverse-one") return tables[target].find((r) => r[fk] === row.id) ?? null;
    if (many) return tables[target].filter((r) => r[fk] === row.id);
    return tables[target].find((r) => r.id === row[fk]) ?? null;
  }

  function matches(model, row, where = {}) {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (cond === undefined) continue;
      if (key === "AND") { if (![].concat(cond).every((w) => matches(model, row, w))) return false; continue; }
      if (key === "OR") { if (!cond.some((w) => matches(model, row, w))) return false; continue; }
      if (key === "NOT") { if ([].concat(cond).some((w) => matches(model, row, w))) return false; continue; }
      const rel = RELATIONS[model][key];
      if (rel) {
        const [target, , many] = rel;
        if (many === "many") {
          const list = related(model, row, key);
          if (cond.some && !list.some((r) => matches(target, r, cond.some))) return false;
          if (cond.none && list.some((r) => matches(target, r, cond.none))) return false;
          if (cond.every && !list.every((r) => matches(target, r, cond.every))) return false;
        } else {
          const one = related(model, row, key);
          if (!one || !matches(target, one, cond)) return false;
        }
        continue;
      }
      if (rel === null) continue; // relation not modelled (e.g. Class.teacher)
      // A compound unique selector (e.g. classStudentId_year_month: {...}): all its fields.
      if (key.includes("_") && !(key in row) && isPlainObject(cond)) {
        if (!matches(model, row, cond)) return false;
        continue;
      }
      // Lecture.isDefault (migration 20261129120000): rows seeded without it are normal lectures (the column default).
      const value = model === "Lecture" && key === "isDefault" && row[key] === undefined ? false : row[key];
      if (!matchScalar(value, cond)) return false;
    }
    return true;
  }

  // ---- projection ----------------------------------------------------------------
  const scalars = (row) => ({ ...row });

  function project(model, row, args = {}) {
    if (!row) return null;
    const { select, include } = args;
    if (!select && !include) return scalars(row);
    const out = select ? {} : scalars(row);
    for (const [key, spec] of Object.entries(select ?? include)) {
      if (!spec) continue;
      const rel = RELATIONS[model][key];
      if (rel) {
        const [target, , many] = rel;
        const sub = spec === true ? {} : spec;
        if (many === "many") {
          let list = related(model, row, key).filter((r) => matches(target, r, sub.where));
          list = sortRows(list, sub.orderBy);
          if (sub.take) list = list.slice(0, sub.take);
          out[key] = list.map((r) => project(target, r, sub));
        } else {
          out[key] = project(target, related(model, row, key), sub);
        }
      } else if (select) {
        out[key] = row[key];
      }
    }
    return out;
  }

  function sortRows(list, orderBy) {
    if (!orderBy) return list;
    const keys = [].concat(orderBy);
    return [...list].sort((a, b) => {
      for (const entry of keys) {
        const [field, dir] = Object.entries(entry)[0];
        if (typeof dir !== "string") continue;
        const av = a[field];
        const bv = b[field];
        const c = av instanceof Date ? av.getTime() - bv.getTime() : av < bv ? -1 : av > bv ? 1 : 0;
        if (c !== 0) return dir === "desc" ? -c : c;
      }
      return 0;
    });
  }

  // ---- constraints ---------------------------------------------------------------
  function uniqueError(target) {
    return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${target}`, {
      code: "P2002",
      clientVersion: "5.22.0",
    });
  }

  function checkUnique(model, row, selfId) {
    if (model === "ClassStudentFee") {
      if (tables.ClassStudentFee.some((r) => r.id !== selfId && r.classStudentId === row.classStudentId && r.year === row.year && r.month === row.month)) {
        throw uniqueError("ClassStudentFee_classStudentId_year_month_key");
      }
    }
    // Partial payments: a request key is used once; one reversal per payment.
    if (model === "ClassPayment" && row.requestKey) {
      if (tables.ClassPayment.some((r) => r.id !== selfId && r.requestKey === row.requestKey)) {
        throw uniqueError("ClassPayment_requestKey_key");
      }
    }
    if (model === "ClassPaymentReversal") {
      if (tables.ClassPaymentReversal.some((r) => r.id !== selfId && r.paymentId === row.paymentId)) {
        throw uniqueError("ClassPaymentReversal_paymentId_key");
      }
    }
    if (model === "ClassStudentResourceAccess") {
      if (tables.ClassStudentResourceAccess.some((r) => r.id !== selfId && r.classStudentId === row.classStudentId && r.year === row.year && r.month === row.month)) {
        throw uniqueError("ClassStudentResourceAccess_classStudentId_year_month_key");
      }
    }
    if (model === "ClassFeeWaiverRule" && row.status === 0) {
      if (tables.ClassFeeWaiverRule.some((r) => r.id !== selfId && r.status === 0 && r.classId === row.classId && r.sequence === row.sequence)) {
        throw uniqueError("ClassFeeWaiverRule_active_sequence_key");
      }
    }
  }

  function withDefaults(model, data) {
    const base = { id: nextId(model), createdAt: new Date(Date.UTC(2026, 0, 1)), updatedAt: nextTick() };
    if (model === "ClassStudentFee") return { ...base, ...FEE_DEFAULTS, ...data, updatedAt: nextTick() };
    if (model === "ClassFeeWaiverRule") return { ...base, status: 0, ...data };
    // Class-level Free Card eligibility (migration 20261123120000): database default.
    if (model === "ClassStudent") return { ...base, freeCardEligible: false, ...data };
    // Lecture.isDefault (migration 20261129120000): database default.
    if (model === "Lecture") return { ...base, isDefault: false, ...data };
    if (model === "ClassPayment") return { ...base, status: "PENDING", source: "STUDENT_SLIP", paymentMethod: null, receivedAt: null, recordedByTeacherId: null, requestKey: null, submittedAt: new Date(), ...data }; // schema defaults
    return { ...base, ...data };
  }

  function applyData(row, data) {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (isPlainObject(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
      else row[key] = value;
    }
    row.updatedAt = nextTick();
  }

  function fail(model, method) {
    if (hooks.failOn && hooks.failOn(model, method)) {
      throw new Error(`simulated failure: ${model}.${method}`);
    }
  }

  // ---- model delegates -----------------------------------------------------------
  function delegate(model) {
    const table = () => tables[model];
    return {
      async findMany(args = {}) {
        fail(model, "findMany");
        let rows = table().filter((r) => matches(model, r, args.where));
        rows = sortRows(rows, args.orderBy);
        if (args.distinct) {
          // Prisma's distinct: the first row (in order) per combination.
          const seen = new Set();
          rows = rows.filter((r) => {
            const key = JSON.stringify([].concat(args.distinct).map((field) => r[field]));
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map((r) => project(model, r, args));
      },
      async findFirst(args = {}) {
        fail(model, "findFirst");
        const rows = sortRows(table().filter((r) => matches(model, r, args.where)), args.orderBy);
        return project(model, rows[0] ?? null, args);
      },
      async findUnique(args) {
        fail(model, "findUnique");
        return project(model, table().find((r) => matches(model, r, args.where)) ?? null, args);
      },
      async findUniqueOrThrow(args) {
        const row = table().find((r) => matches(model, r, args.where));
        if (!row) throw new Error(`${model} not found`);
        return project(model, row, args);
      },
      async count(args = {}) {
        return table().filter((r) => matches(model, r, args.where)).length;
      },
      async create(args) {
        fail(model, "create");
        if (hooks.beforeCreate) hooks.beforeCreate(model, args);
        const row = withDefaults(model, args.data);
        checkUnique(model, row);
        table().push(row);
        writes.push({ model, method: "create", id: row.id });
        return project(model, row, args);
      },
      async createMany(args) {
        let count = 0;
        for (const data of args.data) {
          const row = withDefaults(model, data);
          try {
            checkUnique(model, row);
          } catch (error) {
            if (args.skipDuplicates) continue;
            throw error;
          }
          table().push(row);
          count += 1;
        }
        writes.push({ model, method: "createMany", count });
        return { count };
      },
      async update(args) {
        fail(model, "update");
        const row = table().find((r) => matches(model, r, args.where));
        if (!row) throw new Error(`${model} to update not found`);
        const next = { ...row };
        applyData(next, args.data);
        checkUnique(model, next, row.id);
        Object.assign(row, next);
        writes.push({ model, method: "update", id: row.id, data: args.data });
        return project(model, row, args);
      },
      async upsert(args) {
        fail(model, "upsert");
        const row = table().find((r) => matches(model, r, args.where));
        if (row) {
          const next = { ...row };
          applyData(next, args.update);
          checkUnique(model, next, row.id);
          Object.assign(row, next);
          writes.push({ model, method: "upsert-update", id: row.id, data: args.update });
          return project(model, row, args);
        }
        const created = withDefaults(model, args.create);
        checkUnique(model, created);
        table().push(created);
        writes.push({ model, method: "upsert-create", id: created.id });
        return project(model, created, args);
      },
      async deleteMany(args = {}) {
        fail(model, "deleteMany");
        const doomed = table().filter((r) => matches(model, r, args.where));
        for (const row of doomed) table().splice(table().indexOf(row), 1);
        writes.push({ model, method: "deleteMany", count: doomed.length });
        return { count: doomed.length };
      },
      async updateMany(args) {
        fail(model, "updateMany");
        if (hooks.beforeUpdateMany) {
          const hook = hooks.beforeUpdateMany;
          hooks.beforeUpdateMany = null; // one simulated concurrent write
          hook(model, args, api);
        }
        let count = 0;
        for (const row of table().filter((r) => matches(model, r, args.where))) {
          applyData(row, args.data);
          count += 1;
          writes.push({ model, method: "updateMany", id: row.id, data: args.data });
        }
        return { count };
      },
    };
  }

  const client = {};
  for (const [prop, model] of Object.entries(MODELS)) client[prop] = delegate(model);
  client.$transaction = async (arg) => (typeof arg === "function" ? arg(client) : Promise.all(arg));
  // The approval decisions' raw SQL (services/student-service.ts): the
  // lock_timeout SET and the Student row-lock SELECTs. No concurrency here
  // (see tests/students/confirmation-decisions.test.cjs for that); anything
  // else returns no rows, as before.
  client.$executeRawUnsafe = async (sql) => {
    if (/^SET LOCAL lock_timeout = '\d+ms'$/.test(sql)) return 0;
    throw new Error(`unexpected raw SQL: ${sql}`);
  };
  client.$queryRaw = async (strings, ...values) => {
    const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
    // Automatic Free Cards: fee creation locks the enrolments FOR SHARE (in
    // id order) before reading their eligibility. Recorded for the tests.
    // Eligibility changes lock the selected enrolments FOR NO KEY UPDATE (in
    // id order) before validating and updating them. Recorded for the tests.
    if (/^SELECT "id" FROM "ClassStudent" WHERE "id" = ANY\(\?\) ORDER BY "id" FOR NO KEY UPDATE$/.test(sql)) {
      const ids = values[0];
      lockLog.push({ mode: "NO KEY UPDATE", ids: [...ids] });
      return tables.ClassStudent.filter((r) => ids.includes(r.id))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => ({ id: r.id }));
    }
    if (/^SELECT "id" FROM "ClassStudent" WHERE "id" = ANY\(\?\) ORDER BY "id" FOR SHARE$/.test(sql)) {
      const ids = values[0];
      enrolmentLocks.push([...ids]);
      lockLog.push({ mode: "SHARE", ids: [...ids] });
      if (hooks.onEnrolmentLock) hooks.onEnrolmentLock(ids, api);
      return tables.ClassStudent.filter((r) => ids.includes(r.id))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => ({ id: r.id }));
    }
    // Stage 5.4e: lecture schedule edits, cancelling and deleting lock the
    // lecture (and look for an attendance register: none here).
    if (/FROM "Lecture" WHERE "id" = \? FOR NO KEY UPDATE/.test(sql)) {
      const row = tables.Lecture.find((r) => r.id === values[0]);
      return row ? [{ id: row.id, classId: row.classId, status: row.status, classStatus: row.classStatus, date: row.date, endDate: row.endDate ?? null }] : [];
    }
    if (!/FROM "Student"/.test(sql) || !/FOR NO KEY UPDATE/.test(sql)) return [];
    if (/"id" = \? AND "teacherId" = \?/.test(sql)) {
      const [studentId, teacherId] = values;
      const row = tables.Student.find((r) => r.id === studentId && r.teacherId === teacherId);
      return row ? [{ id: row.id, confirmationStatus: row.confirmationStatus, confirmedAt: row.confirmedAt ?? null }] : [];
    }
    const [teacherId] = values;
    return tables.Student
      .filter((r) => r.teacherId === teacherId && r.status === 0 && r.confirmationStatus === "PENDING")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({ id: r.id, confirmedAt: r.confirmedAt ?? null }));
  };

  // ---- test API ------------------------------------------------------------------
  const api = {
    client,
    tables,
    writes,
    enrolmentLocks,
    lockLog,
    hooks,
    insert(model, data) {
      const row = withDefaults(model, data);
      tables[model].push(row);
      return row;
    },
    row(model, id) {
      return tables[model].find((r) => r.id === id);
    },
    touch(model, id, data) {
      const row = api.row(model, id);
      applyData(row, data);
      return row;
    },
    reset() {
      for (const key of Object.keys(tables)) tables[key].length = 0;
      writes.length = 0;
      enrolmentLocks.length = 0;
      lockLog.length = 0;
      hooks.onEnrolmentLock = null;
      hooks.beforeUpdateMany = null;
      hooks.beforeCreate = null;
      hooks.failOn = null;
    },
  };

  return api;
}

module.exports = { createFakeDb };
