/*
 * POST /api/students/public/Register (anonymous public class registration):
 * same-origin, body validation, rate limits (lib/public-registration-rate-limit.ts)
 * and the unchanged registration service behind them.
 *
 *   npm run test:students
 *
 * Real code through tsx: the route, lib/same-origin.ts, clientKey, the limiter,
 * services/student-service.ts RegisterStudentViaPublicClasses and the outbox
 * queue. Faked edges: Prisma (tests/students/helpers/fake-prisma.cjs), the
 * mailer, the class fee helper and the worker wake-up. No database or email
 * server is contacted. APP_URL / TRUSTED_PROXY_COUNT / the payload key are
 * throwaway in-process values.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "public-registration-"));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");
process.env.APP_URL = "http://localhost:3000";
process.env.TRUSTED_PROXY_COUNT = "1";
process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = "c3".repeat(32);
const APP = "http://localhost:3000";

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const T1 = "teacher-1";
const CLASS = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const MISSING_CLASS = "0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

const { createFakePrisma } = require("./helpers/fake-prisma.cjs");
const { db, prisma, reset } = createFakePrisma();

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
fake("services/class-student-fee-service.ts", { ensureCurrentMonthFeeForClassStudent: async () => {} });
fake("services/email-delivery-worker.ts", {
  wakeEmailDeliveryWorker: () => {
    wakes += 1;
  },
});

const route = require(path.join(root, "app", "api", "students", "public", "Register", "route.ts"));
const LIMIT = require(path.join(root, "lib", "public-registration-rate-limit.ts"));

const original = { log: console.log, error: console.error, warn: console.warn };

function setup(limiterOptions) {
  reset({
    teacher: [{ id: T1, name: "Pathum Kumara", email: "t1@mail.com" }],
    student: [],
    class: [{ id: CLASS, teacherId: T1, status: 0, name: "Grade 6" }],
    grade: [{ id: 6 }],
    emailDelivery: [],
  });
  wakes = 0;
  LIMIT.setPublicRegistrationRateLimiterForTests(
    limiterOptions ? LIMIT.createPublicRegistrationRateLimiter(limiterOptions) : undefined
  );
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
}
test.afterEach(() => Object.assign(console, original));

const valid = (overrides = {}) => ({
  classId: CLASS,
  studentName: "  Public Student  ",
  mobileNumber: " 0771234567 ",
  parentMobileNumber: "0777654321",
  gradeId: 6,
  email: "  Public.Student@Mail.com ",
  ...overrides,
});

let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

async function post(body, { ip = nextIp(), headers = {}, raw } = {}) {
  const response = await route.POST(
    new Request(`${APP}/api/students/public/Register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP, "sec-fetch-site": "same-origin", "x-forwarded-for": ip, ...headers },
      body: raw ?? JSON.stringify(body),
    })
  );
  return { status: response.status, headers: response.headers, body: await response.json() };
}

const tracked = () => LIMIT.publicRegistrationRateLimiter().trackedKeys();

// ---- Configuration ------------------------------------------------------------------------------

test("limits: 3 per email, 10 per address, 200 globally, per hour", () => {
  assert.deepEqual({ ...LIMIT.PUBLIC_REGISTRATION_RATE_LIMIT }, {
    requestsPerIdentifier: 3,
    requestsPerIp: 10,
    globalRequests: 200,
    windowMs: 60 * 60_000,
    maxKeys: 20_000,
  });
});

// ---- Existing behaviour -------------------------------------------------------------------------

test("anonymous registration succeeds: trimmed values, lower-case email, pending approval, one queued welcome email", async () => {
  setup();
  const { status, body } = await post(valid());
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.success, true);

  assert.equal(db.student.length, 1);
  const student = db.student[0];
  assert.equal(student.name, "Public Student");
  assert.equal(student.contact01, "0771234567");
  assert.equal(student.contact02, "0777654321");
  assert.equal(student.email, "public.student@mail.com");
  assert.equal(student.gradeId, 6);
  assert.equal(student.teacherId, T1);
  assert.equal(student.registrationSource, "PUBLIC_CLASS");
  assert.equal(student.confirmationStatus, "PENDING");
  assert.equal(student.passwordSetupPending, true);
  assert.equal(db.classStudent.length, 1);

  assert.equal(db.emailDelivery.length, 1);
  assert.equal(db.emailDelivery[0].status, "PENDING");
  assert.equal(db.emailDelivery[0].initiatedBy, "PUBLIC_REGISTRATION");
  assert.equal(db.emailDelivery[0].recipientEmail, "public.student@mail.com");
  assert.equal(wakes, 1, "the worker is woken; the email is not sent in the request");
});

test("the anonymous success response holds only the registration number (no hash, ids or private fields)", async () => {
  setup();
  const { status, body } = await post(valid());
  assert.equal(status, 201);
  const student = db.student[0];
  assert.ok(student.password, "the account does have a stored hash");

  assert.deepEqual(Object.keys(body.data), ["registrationNumber"]);
  assert.equal(body.data.registrationNumber, student.registrationNumber);

  const text = JSON.stringify(body);
  for (const secret of [student.password, student.id, T1, CLASS, db.classStudent[0].id, db.emailDelivery[0].id]) {
    assert.ok(!text.includes(String(secret)), `response leaks ${secret}`);
  }
  for (const field of [
    "password", "passwordSetupPending", "sessionVersion", "student", "teacherId", "publicClassId",
    "email", "contact", "contact01", "contact02", "confirmationStatus", "registrationSource", "gradeId",
  ]) {
    assert.ok(!text.includes(`"${field}"`), `response has a "${field}" field`);
  }
  assert.ok(!/\$2[aby]\$/.test(text), "no bcrypt hash in the response");
});

test("a nonexistent grade is 400 VALIDATION_ERROR (field gradeId), creates nothing and uses no budget", async () => {
  setup();
  const response = await post(valid({ gradeId: 999 }));
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
  assert.equal(response.body.error.details.field, "gradeId");
  assert.deepEqual(tracked(), { identifiers: 0, addresses: 0 });
  assert.equal(db.student.length, 0);
  assert.equal(db.emailDelivery.length, 0);
});

test("parent mobile number is optional (stored empty, as before)", async () => {
  setup();
  const body = valid();
  delete body.parentMobileNumber;
  const response = await post(body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(db.student[0].contact02, "");
});

test("an inactive or unknown class is still refused by the service (404)", async () => {
  setup();
  db.class[0].status = 1;
  const response = await post(valid());
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "CLASS_NOT_FOUND");
  assert.equal(db.student.length, 0);
});

// ---- Same-origin --------------------------------------------------------------------------------

test("cross-site, foreign-origin and origin-less requests are 403 and use no budget", async () => {
  setup();
  for (const headers of [
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { origin: "https://evil.example" },
    { origin: "" },
    { origin: "null" },
  ]) {
    const response = await post(valid(), { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.body.error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  assert.deepEqual(tracked(), { identifiers: 0, addresses: 0 });
  assert.equal(db.student.length, 0);
});

// ---- Validation ---------------------------------------------------------------------------------

test("invalid bodies are 400 VALIDATION_ERROR, create nothing and use no budget", async () => {
  setup();
  const cases = [
    ["classId", { classId: "class-1" }],
    ["classId", { classId: undefined }],
    ["studentName", { studentName: " A " }],
    ["studentName", { studentName: "x".repeat(121) }],
    ["studentName", { studentName: 42 }],
    ["mobileNumber", { mobileNumber: "   " }],
    ["mobileNumber", { mobileNumber: undefined }],
    ["mobileNumber", { mobileNumber: "1".repeat(61) }],
    ["parentMobileNumber", { parentMobileNumber: "1".repeat(61) }],
    // No grade / Grade 0 are valid (Grade 0, tests/students/grade-zero.test.cjs).
    ["gradeId", { gradeId: -3 }],
    ["gradeId", { gradeId: 1.5 }],
    ["gradeId", { gradeId: "6" }],
    ["email", { email: "" }],
    ["email", { email: "not-an-email" }],
    ["email", { email: `${"a".repeat(115)}@x.com` }],
  ];
  for (const [field, overrides] of cases) {
    const response = await post(valid(overrides));
    assert.equal(response.status, 400, `${field} ${JSON.stringify(overrides)}`);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
    assert.equal(response.body.error.details.field, field, JSON.stringify(overrides));
  }
  for (const raw of ["{not json", "", "null", "[]"]) {
    const response = await post(null, { raw });
    assert.equal(response.status, 400, raw);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
  }
  assert.deepEqual(tracked(), { identifiers: 0, addresses: 0 });
  assert.equal(db.student.length, 0);
  assert.equal(db.emailDelivery.length, 0);
});

// ---- Rate limits --------------------------------------------------------------------------------

test("per email: 3 an hour (any case / spacing); duplicate-email 409s count; the 4th is 429 with Retry-After", async () => {
  let time = 1_000_000;
  setup({ now: () => time });

  const first = await post(valid({ email: "dup@mail.com" }));
  assert.equal(first.status, 201);
  for (const email of ["DUP@mail.com", "  dup@MAIL.com "]) {
    const duplicate = await post(valid({ email, studentName: "Another Student" }));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "EMAIL_EXISTS");
  }

  const limited = await post(valid({ email: "dup@mail.com", studentName: "Third Student" }));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "REGISTRATION_RATE_LIMITED");
  assert.equal(limited.headers.get("Retry-After"), "3600");

  time += 30 * 60_000;
  const later = await post(valid({ email: "dup@mail.com" }));
  assert.equal(later.status, 429);
  assert.equal(later.headers.get("Retry-After"), "1800");

  // Another address is unaffected.
  assert.equal((await post(valid({ email: "other@mail.com" }))).status, 201);

  // The window slides: an hour after the first request a slot frees.
  time += 30 * 60_000;
  const again = await post(valid({ email: "dup@mail.com", studentName: "Fourth Student" }));
  assert.equal(again.status, 409, "allowed again (and still refused as a duplicate by the service)");
  assert.equal(db.student.length, 2);
});

test("per address: 10 an hour from one client address (any outcome counts); the 11th is 429", async () => {
  setup();
  const ip = "198.51.100.7";
  for (let i = 0; i < 10; i += 1) {
    const classId = i % 2 === 0 ? CLASS : MISSING_CLASS; // 201s and 404s both count
    const response = await post(valid({ classId, email: `ip${i}@mail.com`, studentName: `Student ${i}` }), { ip });
    assert.ok([201, 404].includes(response.status), String(response.status));
  }
  const limited = await post(valid({ email: "ip-last@mail.com" }), { ip });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "REGISTRATION_RATE_LIMITED");
  assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  assert.equal(db.student.length, 5);

  assert.equal((await post(valid({ email: "elsewhere@mail.com" }), { ip: "198.51.100.8" })).status, 201);
});

test("global: every client together (a small injected global budget)", async () => {
  setup({ requestsPerIp: 4, globalRequests: 4 });
  for (let i = 0; i < 4; i += 1) {
    const response = await post(valid({ classId: MISSING_CLASS, email: `g${i}@mail.com` }));
    assert.equal(response.status, 404);
  }
  const limited = await post(valid({ email: "g-last@mail.com" }));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "REGISTRATION_RATE_LIMITED");
  assert.equal(db.student.length, 0);
});

test("no trusted proxy configured: the per-address budget is skipped, per-email and global still apply", async () => {
  setup();
  const saved = process.env.TRUSTED_PROXY_COUNT;
  delete process.env.TRUSTED_PROXY_COUNT;
  try {
    for (let i = 0; i < 12; i += 1) {
      const response = await post(valid({ classId: MISSING_CLASS, email: `np${i}@mail.com` }), { ip: "198.51.100.9" });
      assert.equal(response.status, 404, `request ${i}`);
    }
    assert.equal(tracked().addresses, 0);
    for (let i = 0; i < 3; i += 1) await post(valid({ classId: MISSING_CLASS, email: "np-same@mail.com" }));
    assert.equal((await post(valid({ email: "np-same@mail.com" }))).status, 429);
  } finally {
    process.env.TRUSTED_PROXY_COUNT = saved;
  }
});
