/*
 * Public class registration (RegisterStudentViaPublicClasses) with the REAL
 * month-fee and fee-waiver services inside its interactive transaction:
 * explicit transaction options (the P2028 "transaction not found" fix), the
 * fee row with and without FeeWaiverSettings, and rollback on a genuine
 * transaction failure.
 *
 *   npm run test:students
 *
 * Faked edges: Prisma, the mailer and the worker wake-up. The Prisma fake
 * composes the two existing in-memory fakes: tests/fee-waiver/helpers/fake-db.cjs
 * (students, classes, enrolments, fees, waiver settings / rules, lectures —
 * with relation filters) and tests/students/helpers/fake-prisma.cjs (teacher,
 * guardian, enrolment history, email outbox). Its $transaction behaves like
 * Prisma's interactive transaction in VIRTUAL time: every statement inside it
 * costs `latencyMs`; once more than the transaction's `timeout` (Prisma's
 * default 5000 ms when no options are passed) has elapsed, the transaction is
 * expired and every further statement fails with P2028, and a failed
 * transaction is rolled back (all tables restored). No database is contacted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "public-registration-fee-"));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");
process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = "c3".repeat(32);

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { Prisma } = require("@prisma/client");
const { createFakeDb } = require("../fee-waiver/helpers/fake-db.cjs");
const { createFakePrisma } = require("./helpers/fake-prisma.cjs");

const root = path.resolve(__dirname, "..", "..");
const T1 = "teacher-1";
const CLASS = "class-1";
const PRISMA_DEFAULT_TIMEOUT_MS = 5_000;

// ---- Composite Prisma fake ------------------------------------------------------------------------

const fee = createFakeDb();
const other = createFakePrisma();
const FEE_MODELS = new Set(Object.keys(fee.client).filter((key) => !key.startsWith("$")));

const sim = { latencyMs: 0, transactions: [], txStatements: [] };

function p2028(message) {
  return new Prisma.PrismaClientKnownRequestError(message, { code: "P2028", clientVersion: "5.22.0" });
}

/** Prisma defaults the fee fake does not apply on create. */
function withPrismaDefaults(model, data) {
  if (model === "student") return { status: 0, ...data };
  if (model === "classStudent") return { isActive: true, ...data };
  return data;
}

function delegateFor(model, tx) {
  const target = FEE_MODELS.has(model) ? fee.client[model] : other.prisma[model];
  return new Proxy(target, {
    get(object, method) {
      const fn = object[method];
      if (typeof fn !== "function") return fn;
      return async (args = {}) => {
        if (tx) {
          if (tx.expired) throw p2028("Transaction API error: Transaction not found.");
          tx.elapsedMs += sim.latencyMs;
          sim.txStatements.push(`${model}.${String(method)}`);
          if (tx.elapsedMs > tx.timeoutMs) {
            tx.expired = true;
            throw p2028("Transaction API error: Transaction not found.");
          }
        }
        if ((method === "create" || method === "createMany") && args.data) {
          args = {
            ...args,
            data: Array.isArray(args.data)
              ? args.data.map((row) => withPrismaDefaults(model, row))
              : withPrismaDefaults(model, args.data),
          };
        }
        return fn.call(object, args);
      };
    },
  });
}

function clientFor(tx) {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "$transaction") return $transaction;
        if (typeof prop !== "string" || prop.startsWith("$") || prop === "then") return undefined;
        return delegateFor(prop, tx);
      },
    }
  );
}

function snapshot() {
  return { fee: structuredClone(fee.tables), other: structuredClone(other.db) };
}

function restore(saved) {
  for (const [model, rows] of Object.entries(saved.fee)) {
    fee.tables[model].length = 0;
    fee.tables[model].push(...rows);
  }
  for (const key of Object.keys(other.db)) delete other.db[key];
  Object.assign(other.db, saved.other);
}

async function $transaction(fn, options) {
  if (typeof fn !== "function") throw new Error("only interactive transactions are used here");
  const tx = { elapsedMs: 0, timeoutMs: options?.timeout ?? PRISMA_DEFAULT_TIMEOUT_MS, expired: false, options };
  sim.transactions.push(tx);
  const saved = snapshot();
  try {
    const result = await fn(clientFor(tx));
    if (tx.elapsedMs > tx.timeoutMs) throw p2028("Transaction API error: Transaction already closed.");
    return result;
  } catch (error) {
    restore(saved);
    throw error;
  }
}

const prisma = clientFor(null);

// ---- Module fakes -------------------------------------------------------------------------------

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

let wakes = 0;
fake("lib/prisma.ts", { prisma });
fake("lib/mailer.ts", {
  buildStudentLoginLink: () => "https://slclassroom.live/login",
  buildPasswordResetLink: () => "",
  sendEmail: async () => {},
  sendPasswordResetEmail: async () => {},
  sendPasswordChangedEmail: async () => {},
  sendEmailVerificationCodeEmail: async () => {},
  sendStudentRegistrationEmail: async () => {},
  sendStudentWelcomeCredentialsEmail: async () => {
    throw new Error("registration must never send the email itself");
  },
});
fake("services/email-delivery-worker.ts", {
  wakeEmailDeliveryWorker: () => {
    wakes += 1;
  },
});

const { RegisterStudentViaPublicClasses, STUDENT_DECISION_TRANSACTION_OPTIONS } = require(path.join(root, "services", "student-service.ts"));
const feeService = require(path.join(root, "services", "class-student-fee-service.ts"));

// ---- Fixtures -----------------------------------------------------------------------------------

const original = { log: console.log, error: console.error, warn: console.warn };

function setup({ waiverSettings }) {
  fee.reset();
  other.reset({ teacher: [{ id: T1, name: "Pathum Kumara", email: "t1@mail.com" }], guardian: [], classStudentHistory: [], emailDelivery: [] });
  fee.insert("Class", { id: CLASS, teacherId: T1, status: 0, name: "Grade 6", monthlyFee: 2000, paymentDueWeek: 2 });
  if (waiverSettings) {
    fee.insert("FeeWaiverSettings", { id: "default", startYear: 2026, startMonth: 1 });
    fee.insert("ClassFeeWaiverRule", { id: "r1", classId: CLASS, sequence: 1, type: "PERCENTAGE", value: 10 });
  }
  sim.latencyMs = 0;
  sim.transactions.length = 0;
  sim.txStatements.length = 0;
  wakes = 0;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
}
test.afterEach(() => Object.assign(console, original));

const register = (email = "new.student@mail.com") =>
  RegisterStudentViaPublicClasses({
    classId: CLASS,
    studentName: "Public Student",
    mobileNumber: "0771234567",
    parentMobileNumber: "0777654321",
    gradeId: 6,
    email,
    school: "",
  });

const nothingPersisted = () => {
  assert.equal(fee.tables.Student.length, 0, "no student");
  assert.equal(fee.tables.ClassStudent.length, 0, "no enrolment");
  assert.equal(fee.tables.ClassStudentFee.length, 0, "no fee row");
  assert.equal(other.db.classStudentHistory.length, 0, "no enrolment history");
  assert.equal(other.db.emailDelivery.length, 0, "no queued email");
  assert.equal(wakes, 0, "the worker is not woken");
};

/** The registration's fee row must equal what the standard month-fee path produces for that enrolment. */
async function assertFeeMatchesStandardPath(classStudentId) {
  const [row] = fee.tables.ClassStudentFee.filter((r) => r.classStudentId === classStudentId);
  const pick = (r) => ({
    amount: r.amount, discount: r.discount, lateJoinDeduct: r.lateJoinDeduct, waiverAmount: r.waiverAmount,
    finalAmount: r.finalAmount, year: r.year, month: r.month, dueDate: r.dueDate?.toISOString?.() ?? r.dueDate,
    joinWaiverRuleId: r.joinWaiverRuleId ?? null, joinWaiverSequence: r.joinWaiverSequence ?? null,
  });
  const fromRegistration = pick(row);
  fee.tables.ClassStudentFee.length = 0;
  await feeService.ensureCurrentMonthFeeForClassStudent(prisma, classStudentId);
  assert.deepEqual(pick(fee.tables.ClassStudentFee[0]), fromRegistration);
}

// ---- Tests --------------------------------------------------------------------------------------

test("the public registration transaction passes the explicit options (maxWait 5 s, timeout 15 s)", async () => {
  setup({ waiverSettings: true });
  await register();
  assert.equal(sim.transactions.length, 1);
  assert.deepEqual(sim.transactions[0].options, { maxWait: 5_000, timeout: 15_000 });
  assert.equal(sim.transactions[0].options, STUDENT_DECISION_TRANSACTION_OPTIONS, "the shared constant, not a copy");
});

test("with waiver settings: a slow database (beyond Prisma's default 5 s) still registers; fee and email are consistent", async () => {
  setup({ waiverSettings: true });
  sim.latencyMs = 600;
  const { student, registrationNumber } = await register();
  const tx = sim.transactions[0];
  assert.ok(tx.elapsedMs > PRISMA_DEFAULT_TIMEOUT_MS, `took ${tx.elapsedMs} ms: the default would have expired it (P2028)`);
  assert.ok(sim.txStatements.includes("feeWaiverSettings.findUnique"), "waiver start read in the transaction");
  assert.ok(sim.txStatements.includes("classFeeWaiverRule.findMany"), "waiver context loaded in the transaction");

  assert.equal(fee.tables.Student.length, 1);
  assert.equal(student.registrationNumber, registrationNumber);
  assert.equal(fee.tables.Student[0].confirmationStatus, "PENDING");
  const [enrolment] = fee.tables.ClassStudent;
  assert.equal(enrolment.studentId, student.id);
  assert.equal(enrolment.classId, CLASS);
  assert.equal(other.db.classStudentHistory.length, 1);
  assert.equal(other.db.classStudentHistory[0].action, "ASSIGNED");

  const [row] = fee.tables.ClassStudentFee;
  assert.equal(row.classStudentId, enrolment.id);
  assert.equal(row.amount, 2000);
  // Existing waiver rule: a PENDING public registrant gets no joining waiver
  // yet (studentPassesGate); it is applied when the teacher approves.
  assert.equal(row.lateJoinDeduct, 0);
  assert.equal(row.joinWaiverRuleId, null);
  assert.equal(row.finalAmount, 2000);

  assert.equal(other.db.emailDelivery.length, 1);
  assert.equal(other.db.emailDelivery[0].studentId, student.id);
  assert.equal(other.db.emailDelivery[0].status, "PENDING");
  assert.equal(other.db.emailDelivery[0].initiatedBy, "PUBLIC_REGISTRATION");
  assert.equal(wakes, 1);

  await assertFeeMatchesStandardPath(enrolment.id);
});

test("without waiver settings: registers as before (waivers off), same fee as the standard path", async () => {
  setup({ waiverSettings: false });
  sim.latencyMs = 600;
  const { student } = await register();
  assert.ok(sim.transactions[0].elapsedMs > PRISMA_DEFAULT_TIMEOUT_MS);
  assert.ok(sim.txStatements.includes("feeWaiverSettings.findUnique"));
  assert.ok(!sim.txStatements.includes("classFeeWaiverRule.findMany"), "no waiver context without a start month");

  assert.equal(fee.tables.Student.length, 1);
  assert.equal(fee.tables.ClassStudent.length, 1);
  const [row] = fee.tables.ClassStudentFee;
  assert.equal(row.amount, 2000);
  assert.equal(row.lateJoinDeduct, 0);
  assert.equal(row.finalAmount, 2000);
  assert.equal(other.db.emailDelivery.length, 1);
  assert.equal(other.db.emailDelivery[0].studentId, student.id);

  await assertFeeMatchesStandardPath(fee.tables.ClassStudent[0].id);
});

test("a genuine transaction expiry (beyond 15 s) fails with P2028 and rolls everything back", async () => {
  setup({ waiverSettings: true });
  sim.latencyMs = 1_500;
  await assert.rejects(register(), (error) => error.code === "P2028");
  assert.ok(sim.transactions[0].expired);
  nothingPersisted();
});

test("a failure inside the transaction (fee row) rolls back the student, enrolment, history and queued email", async () => {
  setup({ waiverSettings: true });
  fee.hooks.failOn = (model, method) => model === "ClassStudentFee" && method === "create";
  await assert.rejects(register(), /simulated failure: ClassStudentFee.create/);
  nothingPersisted();
});
