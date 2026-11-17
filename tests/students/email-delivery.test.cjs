/*
 * Student email delivery outbox: encryption, worker (claims, leases,
 * retries, shutdown), teacher history and manual retry, registration
 * integration.
 *
 *   npm run test:students
 *
 * Real code through tsx (lib/email-payload-crypto.ts,
 * services/student-email-delivery-service.ts, services/email-delivery-worker.ts,
 * the two teacher routes, services/student-service.ts). Faked edges: Prisma
 * (tests/students/helpers/fake-prisma.cjs, an in-memory stand-in: it does NOT
 * prove PostgreSQL behaviour, see email-delivery.db.test.cjs), the teacher
 * session and the mailer. No database or email server is contacted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const bcrypt = require("bcryptjs");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "email-delivery-"));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");
process.env.APP_URL = "http://localhost";
const KEY = "c3".repeat(32);
process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = KEY;

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const T1 = "teacher-1";
const T2 = "teacher-2";
const CLASS = "class-1";

const { createFakePrisma } = require("./helpers/fake-prisma.cjs");
const { db, prisma, state, reset } = createFakePrisma();

const sent = [];
const failures = [];
let sendDelay = 0;
let login = { role: "TEACHER", id: T1 };

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
fake("lib/prisma.ts", { prisma });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!login) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    if (login.role !== "TEACHER") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { teacherId: login.id, name: "Teacher", email: "t@mail.com", role: "TEACHER" };
  },
});
fake("lib/mailer.ts", {
  buildStudentLoginLink: () => "https://slclassroom.live/login",
  buildPasswordResetLink: () => "",
  sendEmail: async () => {},
  sendPasswordResetEmail: async () => {},
  sendPasswordChangedEmail: async () => {},
  sendEmailVerificationCodeEmail: async () => {},
  sendStudentRegistrationEmail: async () => {},
  sendStudentWelcomeCredentialsEmail: async (input) => {
    if (sendDelay) await new Promise((resolve) => setTimeout(resolve, sendDelay));
    const failure = failures.shift();
    if (failure) throw failure;
    sent.push(input);
    return { messageId: `<m${sent.length}@test>` };
  },
});
fake("services/class-student-fee-service.ts", { ensureCurrentMonthFeeForClassStudent: async () => {} });

const CRYPTO = require(path.join(root, "lib", "email-payload-crypto.ts"));
const OUTBOX = require(path.join(root, "services", "student-email-delivery-service.ts"));
const WORKER = require(path.join(root, "services", "email-delivery-worker.ts"));
const historyRoute = require(path.join(root, "app", "api", "students", "email-deliveries", "route.ts"));
const retryRoute = require(path.join(root, "app", "api", "students", "email-deliveries", "[deliveryId]", "retry", "route.ts"));
const { createStudent, RegisterStudentViaPublicClasses } = require(path.join(root, "services", "student-service.ts"));
const { setTeacherStudentPasswordResetRateLimiterForTests, createTeacherStudentPasswordResetRateLimiter } = require(path.join(root, "lib", "teacher-student-password-reset-rate-limit.ts"));

const logs = [];
const original = { log: console.log, error: console.error };
// One hour AHEAD of the real clock: registration and route paths queue rows with
// the real time, which the worker (run on this clock) must see as due.
let clock = new Date(Date.now() + 60 * 60_000);
const now = () => clock;
const advance = (seconds) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

const PASSWORD = "Tmp2Pass9XyZ";
const HASH = bcrypt.hashSync(PASSWORD, 4);

function setup() {
  reset({
    teacher: [
      { id: T1, name: "Pathum Kumara", email: "t1@mail.com" },
      { id: T2, name: "Other", email: "t2@mail.com" },
    ],
    student: [
      { id: "s1", teacherId: T1, name: "Nimal", registrationNumber: "PK-001", email: "nimal@mail.com", status: 0, password: HASH, sessionVersion: 0, passwordSetupPending: true },
      { id: "s2", teacherId: T1, name: "Kamal", registrationNumber: "PK-002", email: "kamal@mail.com", status: 0, password: HASH, sessionVersion: 0, passwordSetupPending: true },
      { id: "s3", teacherId: T2, name: "Other", registrationNumber: "OT-001", email: "other@mail.com", status: 0, password: HASH, sessionVersion: 0 },
    ],
    class: [{ id: CLASS, teacherId: T1, status: 0, name: "Grade 6" }],
    grade: [{ id: 6 }],
    emailDelivery: [],
  });
  sent.length = 0;
  failures.length = 0;
  logs.length = 0;
  sendDelay = 0;
  login = { role: "TEACHER", id: T1 };
  process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = KEY;
  clock = new Date(Date.now() + 60 * 60_000);
  setTeacherStudentPasswordResetRateLimiterForTests();
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
}
test.afterEach(() => {
  console.log = original.log;
  console.error = original.error;
});
test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const appError = (code, status) => (error) => error.code === code && error.statusCode === status;
const queueWelcome = (studentId, teacherId = T1) =>
  OUTBOX.queueStudentWelcomeEmails(prisma, [{ studentId, teacherId, recipientEmail: db.student.find((s) => s.id === studentId).email, temporaryPassword: PASSWORD, passwordHash: HASH, initiatedBy: "TEACHER_ADD" }], { now: clock });
const work = (options = {}) => OUTBOX.processEmailDeliveries({ now, ...options });
const delivery = (studentId) => db.emailDelivery.find((d) => d.studentId === studentId);
const smtpError = (code, responseCode, message = "error") => Object.assign(new Error(message), { code, ...(responseCode ? { responseCode } : {}) });

async function getHistory(query = "") {
  const response = await historyRoute.GET(new Request(`http://localhost/api/students/email-deliveries${query}`));
  return { status: response.status, body: await response.json() };
}
async function postRetry(id, headers = { origin: "http://localhost" }) {
  const response = await retryRoute.POST(new Request(`http://localhost/api/students/email-deliveries/${id}/retry`, { method: "POST", headers }), { params: { deliveryId: id } });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

// ==== Credential security ===============================================================

test("crypto: AES-256-GCM round trip; ciphertext never contains the password; fresh IV per value", () => {
  const a = CRYPTO.encryptEmailPayload({ temporaryPassword: PASSWORD }, "row-1");
  const b = CRYPTO.encryptEmailPayload({ temporaryPassword: PASSWORD }, "row-1");
  assert.match(a, /^v1\.[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b, "random IV");
  assert.ok(!a.includes(PASSWORD));
  assert.ok(!Buffer.from(a.slice(3), "base64url").toString("latin1").includes(PASSWORD));
  assert.deepEqual(CRYPTO.decryptEmailPayload(a, "row-1"), { temporaryPassword: PASSWORD });
});

test("crypto: wrong key, another row's id, or tampering are rejected (authenticated)", () => {
  const value = CRYPTO.encryptEmailPayload({ temporaryPassword: PASSWORD }, "row-1");
  assert.throws(() => CRYPTO.decryptEmailPayload(value, "row-1", { EMAIL_PAYLOAD_ENCRYPTION_KEY: "d4".repeat(32) }), CRYPTO.EmailPayloadDecryptError);
  assert.throws(() => CRYPTO.decryptEmailPayload(value, "row-2"), CRYPTO.EmailPayloadDecryptError);
  const raw = Buffer.from(value.slice(3), "base64url");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => CRYPTO.decryptEmailPayload("v1." + raw.toString("base64url"), "row-1"), CRYPTO.EmailPayloadDecryptError);
  assert.throws(() => CRYPTO.decryptEmailPayload("plain", "row-1"), CRYPTO.EmailPayloadDecryptError);
});

test("crypto: missing or malformed key fails safely, without echoing the key", () => {
  for (const env of [{}, { EMAIL_PAYLOAD_ENCRYPTION_KEY: "short" }, { EMAIL_PAYLOAD_ENCRYPTION_KEY: "zz".repeat(32) }]) {
    assert.equal(CRYPTO.isEmailPayloadEncryptionConfigured(env), false);
    assert.throws(() => CRYPTO.encryptEmailPayload({ temporaryPassword: PASSWORD }, "r", env), (e) => e instanceof CRYPTO.EmailPayloadKeyError && !e.message.includes("zz".repeat(32)) && /EMAIL_PAYLOAD_ENCRYPTION_KEY/.test(e.message));
  }
  const source = fs.readFileSync(path.join(root, "lib", "email-payload-crypto.ts"), "utf8");
  assert.doesNotMatch(source, /["'][0-9a-fA-F]{64}["']/, "no hard-coded key");
  assert.match(source, /aes-256-gcm/);
});

test("queued rows hold the password only encrypted; missing key at registration: account kept, row FAILED (not queued), no ciphertext", async () => {
  setup();
  await queueWelcome("s1");
  const row = delivery("s1");
  assert.equal(row.status, "PENDING");
  assert.ok(!JSON.stringify(row).includes(PASSWORD));
  assert.equal(CRYPTO.decryptEmailPayload(row.encryptedPayload, row.id).temporaryPassword, PASSWORD);

  delete process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY;
  const result = await queueWelcome("s2");
  assert.deepEqual(result, { queued: 0, notQueued: 1 });
  const failed = delivery("s2");
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.lastErrorCode, "EMAIL_PAYLOAD_KEY_MISSING");
  assert.equal(failed.encryptedPayload ?? null, null);
  assert.equal(OUTBOX.manualRetryBlock(failed, clock), "CREDENTIALS_UNUSABLE", "the teacher is pointed to Resend Login Details");
});

test("payload cleanup: removed after acceptance; kept for a manual retry after a final failure, then expired", async () => {
  setup();
  await queueWelcome("s1");
  await queueWelcome("s2");
  failures.push(smtpError("EENVELOPE", 550, "550 5.1.1 mailbox unavailable"));
  await work();
  const sentRow = db.emailDelivery.find((d) => d.status === "SENT");
  const failedRow = db.emailDelivery.find((d) => d.status === "FAILED");
  assert.equal(sentRow.encryptedPayload, null);
  assert.match(failedRow.encryptedPayload, /^v1\./);

  advance(169 * 3600); // past the 168 h retention
  const report = await work();
  assert.equal(report.payloadsExpired, 1);
  assert.equal(failedRow.encryptedPayload, null);
  assert.equal(OUTBOX.manualRetryBlock(failedRow, clock), "CREDENTIALS_UNUSABLE");
});

// ==== Worker ===================================================================================

test("worker: processes pending emails; SENT = accepted, with the provider message id; history kept", async () => {
  setup();
  await queueWelcome("s1");
  const report = await work();
  assert.deepEqual([report.claimed, report.sent], [1, 1]);
  const row = delivery("s1");
  assert.equal(row.status, "SENT");
  assert.equal(row.providerMessageId, "<m1@test>");
  assert.equal(row.attemptCount, 1);
  assert.ok(row.sentAt instanceof Date);
  assert.equal(row.leaseToken, null);
  assert.equal(sent[0].temporaryPassword, PASSWORD);
  assert.equal(sent[0].registrationNumber, "PK-001");
  assert.equal(db.emailDelivery.length, 1, "the row stays as history");
});

test("worker: atomic claims - two concurrent passes never send the same email twice", async () => {
  setup();
  for (const id of ["s1", "s2"]) await queueWelcome(id);
  sendDelay = 5;
  const [a, b] = await Promise.all([work({ concurrency: 2 }), work({ concurrency: 2 })]);
  assert.equal(a.claimed + b.claimed, 2);
  assert.equal(sent.length, 2);
  assert.equal(new Set(sent.map((m) => m.to)).size, 2);
});

test("worker: a row being processed (valid lease) is not claimed again", async () => {
  setup();
  await queueWelcome("s1");
  const claims = await OUTBOX.claimDueEmailDeliveries(5, clock, OUTBOX.emailDeliveryConfig());
  assert.equal(claims.length, 1);
  assert.equal((await OUTBOX.claimDueEmailDeliveries(5, clock, OUTBOX.emailDeliveryConfig())).length, 0);
  assert.equal(delivery("s1").status, "PROCESSING");
  assert.ok(delivery("s1").processingLeaseExpiresAt > clock);
});

test("worker: an expired lease (crashed worker) is recovered as an unknown-outcome attempt and sent; the old holder can no longer write", async () => {
  setup();
  await queueWelcome("s1");
  const [stale] = await OUTBOX.claimDueEmailDeliveries(1, clock, OUTBOX.emailDeliveryConfig());
  advance(OUTBOX.emailDeliveryConfig().leaseMs / 1000 + 1);
  await work();
  const row = delivery("s1");
  assert.equal(row.status, "SENT");
  assert.equal(row.attemptCount, 2, "the interrupted attempt counts");
  assert.notEqual(row.leaseToken, stale.leaseToken);
  assert.ok(logs.some((l) => l.includes("recovered expired lease")));
  // The stale holder's fenced write does nothing.
  const result = await prisma.emailDelivery.updateMany({ where: { id: row.id, leaseToken: stale.leaseToken, status: "PROCESSING" }, data: { status: "FAILED" } });
  assert.equal(result.count, 0);
});

test("worker: an expired lease with no attempts left ends FAILED (LEASE_EXPIRED, outcome unknown)", async () => {
  setup();
  await queueWelcome("s1");
  delivery("s1").maxAttempts = 1;
  await OUTBOX.claimDueEmailDeliveries(1, clock, OUTBOX.emailDeliveryConfig());
  advance(3600);
  await work();
  const row = delivery("s1");
  assert.equal(row.status, "FAILED");
  assert.equal(row.lastErrorCode, "LEASE_EXPIRED");
  assert.equal(row.lastOutcomeAmbiguous, true);
  assert.equal(sent.length, 0);
});

test("worker: never sends stale credentials - a welcome whose password was since changed is superseded unsent", async () => {
  setup();
  await queueWelcome("s1");
  db.student.find((s) => s.id === "s1").password = bcrypt.hashSync("ChosenByStudent1", 4);
  await work();
  assert.equal(delivery("s1").status, "FAILED");
  assert.equal(delivery("s1").lastErrorCode, "CREDENTIALS_SUPERSEDED");
  assert.equal(delivery("s1").encryptedPayload, null);
  assert.equal(sent.length, 0);
});

test("worker: uses the student's CURRENT address (a corrected typo is honoured) and records it; deleted students are not emailed", async () => {
  setup();
  await queueWelcome("s1");
  await queueWelcome("s2");
  db.student.find((s) => s.id === "s1").email = "nimal.fixed@mail.com";
  db.student.find((s) => s.id === "s2").status = 2;
  await work();
  assert.deepEqual(sent.map((m) => m.to), ["nimal.fixed@mail.com"]);
  assert.equal(delivery("s1").recipientEmail, "nimal.fixed@mail.com");
  assert.equal(delivery("s2").lastErrorCode, "STUDENT_UNAVAILABLE");
});

test("worker: the decrypted password never appears in logs; provider error text is sanitized before storing", async () => {
  setup();
  await queueWelcome("s1");
  failures.push(smtpError("EENVELOPE", 550, `550 rejected nimal@mail.com while sending ${PASSWORD}`));
  await work();
  const row = delivery("s1");
  assert.doesNotMatch(row.lastErrorMessage, /nimal@mail\.com/);
  assert.ok(!row.lastErrorMessage.includes(PASSWORD));
  for (const line of logs) {
    assert.ok(!line.includes(PASSWORD));
    assert.ok(!line.includes("nimal@mail.com"));
    assert.ok(!/v1\.[A-Za-z0-9_-]{20,}/.test(line));
  }
});

test("worker scheduler: start once, pass on wake, graceful shutdown waits for the running pass, restart works", async () => {
  setup();
  let release;
  let passes = 0;
  const run = () => {
    passes += 1;
    return new Promise((resolve) => {
      release = () => resolve({ claimed: 0, sent: 0, retryScheduled: 0, failed: 0, activated: 0, activationFailed: 0, payloadsExpired: 0 });
    });
  };
  assert.equal(WORKER.canRunEmailDeliveryWorker({ NODE_ENV: "test" }), false, "never under the test runner");
  assert.equal(WORKER.canRunEmailDeliveryWorker({ NODE_ENV: "production", NETLIFY: "true" }), false, "never serverless");
  assert.equal(WORKER.canRunEmailDeliveryWorker({ NODE_ENV: "production", EMAIL_WORKER_ENABLED: "false" }), false);
  assert.equal(WORKER.canRunEmailDeliveryWorker({ NODE_ENV: "production" }), true);

  assert.equal(WORKER.startEmailDeliveryWorker({ force: true, run, installSignalHandlers: false, config: { pollIntervalMs: 60_000 } }), true);
  assert.equal(WORKER.startEmailDeliveryWorker({ force: true, run, installSignalHandlers: false }), true, "second start is a no-op");
  const pass = WORKER.runEmailDeliveryWorkerPassForTests();
  assert.equal(passes, 1);
  WORKER.runEmailDeliveryWorkerPassForTests(); // during a pass: no overlap
  assert.equal(passes, 1);

  let finished = false;
  const shutdown = WORKER.shutdownEmailDeliveryWorker().then((value) => {
    finished = value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false, "waits for the running pass");
  release();
  await pass;
  await shutdown;
  assert.equal(finished, true);
  assert.equal(WORKER.isEmailDeliveryWorkerRunning(), false);
  assert.equal(passes, 1, "no pass after shutdown");

  // Restart (e.g. a new process): starts again.
  assert.equal(WORKER.startEmailDeliveryWorker({ force: true, run: async () => ({ claimed: 0, sent: 0, retryScheduled: 0, failed: 0, activated: 0, activationFailed: 0, payloadsExpired: 0 }), installSignalHandlers: false }), true);
  await WORKER.shutdownEmailDeliveryWorker();
});

test("worker scheduler: shutdown gives up after its timeout (the pass's rows are recovered by lease later)", async () => {
  setup();
  WORKER.startEmailDeliveryWorker({ force: true, run: () => new Promise(() => {}), installSignalHandlers: false, config: { pollIntervalMs: 60_000, shutdownTimeoutMs: 30 } });
  WORKER.runEmailDeliveryWorkerPassForTests();
  assert.equal(await WORKER.shutdownEmailDeliveryWorker(), false);
});

test("worker: graceful stop claims nothing new", async () => {
  setup();
  await queueWelcome("s1");
  const report = await work({ shouldStop: () => true });
  assert.equal(report.claimed, 0);
  assert.equal(delivery("s1").status, "PENDING");
});

// ==== Retries ==================================================================================

test("classification: rejection, temporary, timeout, ambiguous, permanent, configuration", () => {
  const c = (e) => OUTBOX.classifyEmailFailure(e);
  assert.deepEqual(c(smtpError("EENVELOPE", 550)), { category: "REJECTED", code: "SMTP_550", retryable: false, ambiguous: false });
  assert.deepEqual(c(smtpError("EENVELOPE", 452)), { category: "TEMPORARY", code: "SMTP_452", retryable: true, ambiguous: false });
  assert.equal(c(smtpError("SENDER_VALIDATION_FAILED")).category, "REJECTED");
  assert.equal(c(smtpError("SENDER_REQUEST_FAILED")).category, "PERMANENT");
  assert.equal(c(smtpError("ECONNREFUSED")).category, "TEMPORARY");
  assert.equal(c(smtpError("SENDER_RATE_LIMITED")).category, "TEMPORARY");
  assert.deepEqual(c(smtpError("SENDER_TIMEOUT")), { category: "TIMEOUT", code: "SENDER_TIMEOUT", retryable: true, ambiguous: true });
  assert.deepEqual(c(smtpError("ETIMEDOUT")).ambiguous, true);
  assert.equal(c(smtpError("ECONNRESET")).category, "AMBIGUOUS");
  assert.equal(c(smtpError("SENDER_NOT_CONFIRMED")).category, "AMBIGUOUS");
  assert.equal(c(smtpError("EAUTH")).category, "CONFIGURATION");
  assert.equal(c(smtpError("EMAIL_NOT_CONFIGURED")).retryable, true);
  assert.deepEqual(c(new Error("??")), { category: "AMBIGUOUS", code: "UNKNOWN_ERROR", retryable: true, ambiguous: true });
});

test("backoff: exponential from the base, capped", () => {
  const config = { retryBaseMs: 60_000, retryMaxMs: 6 * 3600_000 };
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => OUTBOX.retryDelayMs(n, config)), [60_000, 120_000, 240_000, 480_000, 960_000]);
  assert.equal(OUTBOX.retryDelayMs(20, config), 6 * 3600_000);
  const env = { EMAIL_DELIVERY_MAX_ATTEMPTS: "3", EMAIL_DELIVERY_RETRY_BASE_SECONDS: "10", EMAIL_DELIVERY_SEND_TIMEOUT_SECONDS: "30" };
  const configured = OUTBOX.emailDeliveryConfig(env);
  assert.equal(configured.maxAttempts, 3);
  assert.equal(configured.retryBaseMs, 10_000);
  assert.ok(configured.leaseMs >= configured.sendTimeoutMs * 2, "lease outlives a send");
  assert.equal(OUTBOX.emailDeliveryConfig({ EMAIL_DELIVERY_MAX_ATTEMPTS: "nonsense" }).maxAttempts, 5);
});

test("retries: transient failure then success; same credentials each attempt; maximum attempts -> FAILED", async () => {
  setup();
  await queueWelcome("s1");
  failures.push(smtpError("ECONNREFUSED"));
  await work();
  assert.equal(delivery("s1").status, "PENDING");
  assert.equal(delivery("s1").nextRetryAt.getTime(), clock.getTime() + 60_000);
  advance(60);
  await work();
  assert.equal(delivery("s1").status, "SENT");
  assert.equal(sent[0].temporaryPassword, PASSWORD);

  await queueWelcome("s2");
  for (let i = 0; i < 5; i += 1) failures.push(smtpError("ETIMEDOUT"));
  for (let i = 0; i < 5; i += 1) {
    await work();
    advance(7 * 3600);
  }
  const row = delivery("s2");
  assert.equal(row.status, "FAILED");
  assert.equal(row.attemptCount, 5);
  assert.equal(row.lastErrorCode, "ETIMEDOUT");
  assert.equal(row.lastOutcomeAmbiguous, true);
});

test("send timeout: a hanging provider is cut off and treated as an unknown outcome (retried)", async () => {
  setup();
  await queueWelcome("s1");
  const report = await OUTBOX.processEmailDeliveries({
    now,
    env: { ...process.env, EMAIL_DELIVERY_SEND_TIMEOUT_SECONDS: "5" },
    send: () => new Promise(() => {}),
  }).catch((e) => e);
  assert.equal(report.retryScheduled, 1);
  assert.equal(delivery("s1").lastErrorCode, "SEND_TIMEOUT");
  assert.equal(delivery("s1").lastOutcomeAmbiguous, true);
});

// ==== Teacher history and manual retry =============================================================

test("history: only the teacher's own records, with student details and no secrets; summary per scope", async () => {
  setup();
  await queueWelcome("s1");
  await queueWelcome("s2");
  await queueWelcome("s3", T2);
  failures.push(smtpError("EENVELOPE", 550, "550 no such user"));
  await work();

  const { status, body } = await getHistory();
  assert.equal(status, 200);
  assert.equal(body.data.items.length, 2);
  assert.ok(body.data.items.every((i) => ["s1", "s2"].includes(i.student.id)));
  assert.deepEqual(body.data.summary, { total: 2, queued: 0, processing: 0, sent: 1, failed: 1 });
  const failed = body.data.items.find((i) => i.status === "FAILED");
  assert.equal(failed.displayStatus, "FAILED");
  assert.equal(failed.canRetry, true);
  assert.equal(failed.lastErrorCode, "SMTP_550");
  assert.equal(failed.student.registrationNumber, failed.student.id === "s1" ? "PK-001" : "PK-002");
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(PASSWORD));
  assert.ok(!raw.includes("v1."), "no ciphertext");
  assert.ok(!/\$2[aby]\$/.test(raw), "no hash");
  for (const key of ["encryptedPayload", "pendingPasswordHash", "credentialFingerprint", "basePasswordFingerprint", "leaseToken"]) {
    assert.ok(!(key in failed), key);
  }

  // Another teacher's record cannot be reached by id or student filter.
  const other = db.emailDelivery.find((d) => d.teacherId === T2);
  assert.equal((await getHistory(`?deliveryId=${other.id}`)).body.data.items.length, 0);
  assert.equal((await getHistory("?studentId=s3")).body.data.items.length, 0);
  assert.equal((await getHistory("?status=FAILED")).body.data.items.length, 1);
});

test("history: display statuses (queued / retrying) and the next retry time", async () => {
  setup();
  await queueWelcome("s1");
  let { body } = await getHistory();
  assert.equal(body.data.items[0].displayStatus, "QUEUED");
  failures.push(smtpError("ECONNREFUSED"));
  await work();
  ({ body } = await getHistory());
  assert.equal(body.data.items[0].displayStatus, "RETRYING");
  assert.equal(body.data.items[0].nextRetryAt, new Date(clock.getTime() + 60_000).toISOString());
});

test("history route: teacher session required", async () => {
  setup();
  login = null;
  assert.equal((await getHistory()).status, 401);
  login = { role: "STUDENT", id: "s1" };
  assert.equal((await getHistory()).status, 401);
});

test("manual retry: requeues a failed email with the SAME credentials, keeps history, and sends it", async () => {
  setup();
  await queueWelcome("s1");
  failures.push(smtpError("EENVELOPE", 550, "550 no such user"));
  await work();
  const row = delivery("s1");
  const payload = row.encryptedPayload;

  const { status, body } = await postRetry(row.id);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(row.status, "PENDING");
  assert.equal(row.encryptedPayload, payload, "same encrypted credentials");
  assert.equal(row.attemptCount, 1);
  assert.equal(row.maxAttempts, 6);
  assert.ok(!JSON.stringify(body).includes(PASSWORD));
  await work();
  assert.equal(row.status, "SENT");
  assert.equal(sent[0].temporaryPassword, PASSWORD);
});

test("manual retry: duplicates prevented, ineligible states refused, other teachers refused, same-origin and rate limits apply", async () => {
  setup();
  await queueWelcome("s1");
  await queueWelcome("s3", T2);
  failures.push(smtpError("EENVELOPE", 550), smtpError("EENVELOPE", 550));
  await work();
  const mine = delivery("s1");
  const theirs = delivery("s3");

  // Another teacher's record: 404 (indistinguishable from a missing one).
  const foreign = await postRetry(theirs.id);
  assert.equal(foreign.status, 404);
  assert.equal(theirs.status, "FAILED");

  // Two retries at once: one succeeds, the other is refused.
  const [a, b] = await Promise.all([postRetry(mine.id), postRetry(mine.id)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await postRetry(mine.id)).body.error.code, "EMAIL_RETRY_NOT_ALLOWED", "already queued");

  // Cross-origin.
  assert.equal((await postRetry(mine.id, {})).status, 403);
  // Not signed in.
  login = null;
  assert.equal((await postRetry(mine.id)).status, 401);
  login = { role: "TEACHER", id: T1 };

  // Rate limit.
  setTeacherStudentPasswordResetRateLimiterForTests(createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 0 + 1 }));
  await postRetry(mine.id);
  const limited = await postRetry(mine.id);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("manual retry: superseded / expired credentials are refused with the Resend Login Details recovery path", async () => {
  setup();
  await queueWelcome("s1");
  db.student.find((s) => s.id === "s1").password = bcrypt.hashSync("Changed1234", 4);
  await work();
  await assert.rejects(OUTBOX.retryEmailDeliveryByTeacher({ teacherId: T1, deliveryId: delivery("s1").id, now: clock }), (e) => e.code === "EMAIL_RETRY_CREDENTIALS_UNUSABLE" && /Resend Login Details/.test(e.message));
});

// ==== Registration integration =====================================================================

test("registration: exactly one queued record per created account; none for a failed or rolled-back registration", async () => {
  setup();
  const created = await createStudent(T1, { registrationNumber: "PK-050", name: "Fresh", gradeId: 6, contact01: "0771234567", email: "fresh@mail.com" });
  assert.equal(db.emailDelivery.filter((d) => d.studentId === created.id).length, 1);

  // A duplicate name is refused before anything is created: no record.
  const before = db.emailDelivery.length;
  await assert.rejects(createStudent(T1, { registrationNumber: "PK-051", name: "Fresh", gradeId: 6, contact01: "0771234567", email: "fresh2@mail.com" }));
  assert.equal(db.emailDelivery.length, before);

  // Public registration whose transaction fails after the student row: rolled back, no record.
  state.rollback = true;
  state.stopOn = "classStudentHistory.create";
  await assert.rejects(
    RegisterStudentViaPublicClasses({ classId: CLASS, studentName: "Rolled Back", email: "rb@mail.com", mobileNumber: "0771234567", parentMobileNumber: "0777654321", gradeId: 6 })
  );
  assert.equal(db.student.some((s) => s.name === "Rolled Back"), false);
  assert.equal(db.emailDelivery.length, before);

  // The same student can never get a second welcome record (idempotency key).
  await assert.rejects(
    OUTBOX.queueStudentWelcomeEmails(prisma, [{ studentId: created.id, teacherId: T1, recipientEmail: "x@mail.com", temporaryPassword: PASSWORD, passwordHash: HASH, initiatedBy: "TEACHER_ADD" }]),
    (e) => e.code === "P2002"
  );
});

test("key rotation / loss: rows encrypted with the old key fail UNREADABLE (nothing sent, retry points to Resend); a missing key is retried", async () => {
  setup();
  await queueWelcome("s1");
  await queueWelcome("s2");
  // Rotated key: s1 can no longer be decrypted.
  process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = "d4".repeat(32);
  const s2 = delivery("s2");
  s2.nextRetryAt = new Date(clock.getTime() + 3600_000); // not due yet
  await work();
  const s1 = delivery("s1");
  assert.equal(s1.status, "FAILED");
  assert.equal(s1.lastErrorCode, "EMAIL_PAYLOAD_UNREADABLE");
  assert.equal(s1.encryptedPayload, null);
  assert.equal(sent.length, 0);
  assert.equal(OUTBOX.manualRetryBlock(s1, clock), "CREDENTIALS_UNUSABLE");

  // Key removed entirely: a configuration failure, retried (the payload is kept).
  delete process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY;
  advance(3601);
  await work();
  assert.equal(s2.status, "PENDING");
  assert.equal(s2.lastErrorCode, "EMAIL_PAYLOAD_KEY_MISSING");
  assert.match(s2.encryptedPayload, /^v1\./);
  // Original key back: sent.
  process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = KEY;
  advance(3600);
  await work();
  assert.equal(s2.status, "SENT");
  assert.equal(sent[0].temporaryPassword, PASSWORD);
});
