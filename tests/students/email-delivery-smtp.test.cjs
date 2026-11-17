/*
 * Student email outbox against a REAL SMTP conversation: the real
 * lib/mailer.ts (nodemailer, SMTP branch) talks over TCP to a minimal,
 * throwaway SMTP server started by this test on 127.0.0.1 (no external
 * provider, no production credentials). The server can accept, reject (5xx),
 * defer (4xx), or drop the connection after the message data (the "did it
 * send?" case). The database is the in-memory fake (see
 * email-delivery.db.test.cjs for PostgreSQL).
 *
 *   npm run test:students
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const bcrypt = require("bcryptjs");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "email-smtp-"));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");
process.env.APP_URL = "http://localhost";
process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = "e5".repeat(32);
delete process.env.SENDER_API_TOKEN; // SMTP branch of the real mailer
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_USER = "test-user";
process.env.SMTP_PASS = "test-pass";
process.env.SMTP_SECURE = "false";
process.env.SMTP_FROM = "no-reply@test.local";

require("tsx/cjs/api").register();
const root = path.resolve(__dirname, "..", "..");

// ---- A minimal SMTP server ---------------------------------------------------------------

const server = { mode: "accept", messages: [], connections: 0 };
const smtp = net.createServer((socket) => {
  server.connections += 1;
  let inData = false;
  let data = "";
  let buffer = "";
  let authLogin = 0;
  const reply = (line) => socket.write(`${line}\r\n`);
  reply("220 test.local ESMTP ready");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) return;
        data += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        if (server.mode === "drop-after-data") {
          server.messages.push(data); // the message reached the server...
          socket.destroy(); // ...but the client never hears "250"
          return;
        }
        server.messages.push(data);
        reply("250 2.0.0 Ok: queued as TEST123");
        continue;
      }
      const eol = buffer.indexOf("\r\n");
      if (eol === -1) return;
      const line = buffer.slice(0, eol);
      buffer = buffer.slice(eol + 2);
      const verb = line.split(" ")[0].toUpperCase();
      if (authLogin > 0) {
        authLogin -= 1;
        reply(authLogin === 0 ? "235 2.7.0 Authentication successful" : "334 UGFzc3dvcmQ6");
        continue;
      }
      if (verb === "EHLO" || verb === "HELO") socket.write("250-test.local\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
      else if (verb === "AUTH" && /LOGIN/i.test(line)) {
        authLogin = 2;
        reply("334 VXNlcm5hbWU6");
      } else if (verb === "AUTH") reply("235 2.7.0 Authentication successful");
      else if (verb === "MAIL") reply("250 2.1.0 Ok");
      else if (verb === "RCPT") {
        if (server.mode === "reject") reply("550 5.1.1 <recipient> User unknown");
        else if (server.mode === "defer") reply("452 4.2.2 Mailbox full, try later");
        else reply("250 2.1.5 Ok");
      } else if (verb === "DATA") {
        inData = true;
        data = "";
        reply("354 End data with <CR><LF>.<CR><LF>");
      } else if (verb === "QUIT") {
        reply("221 2.0.0 Bye");
        socket.end();
      } else reply("250 Ok");
    }
  });
});

let FAKE_DB;
let OUTBOX;
let mailerLogs = [];
const PASSWORD = "SmtpTest7Pwd";
const HASH = bcrypt.hashSync(PASSWORD, 4);

test.before(async () => {
  await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  process.env.SMTP_PORT = String(smtp.address().port);

  const { createFakePrisma } = require("./helpers/fake-prisma.cjs");
  FAKE_DB = createFakePrisma();
  const filename = path.join(root, "lib", "prisma.ts");
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = { prisma: FAKE_DB.prisma };
  require.cache[filename] = mod;
  OUTBOX = require(path.join(root, "services", "student-email-delivery-service.ts"));
});
test.after(async () => {
  await new Promise((resolve) => smtp.close(resolve));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let clock = new Date("2026-11-16T10:00:00.000Z");
async function setupAndQueue() {
  FAKE_DB.reset({
    teacher: [{ id: "t1", name: "Teacher", email: "t@mail.com" }],
    student: [{ id: "s1", teacherId: "t1", name: "Nimal", registrationNumber: "PK-001", email: "nimal@student.test", status: 0, password: HASH, sessionVersion: 0 }],
    emailDelivery: [],
  });
  server.messages = [];
  clock = new Date("2026-11-16T10:00:00.000Z");
  await OUTBOX.queueStudentWelcomeEmails(FAKE_DB.prisma, [{ studentId: "s1", teacherId: "t1", recipientEmail: "nimal@student.test", temporaryPassword: PASSWORD, passwordHash: HASH, initiatedBy: "TEACHER_ADD" }], { now: clock });
  return FAKE_DB.db.emailDelivery[0];
}

async function pass() {
  const { log, error, info } = console;
  mailerLogs = [];
  console.log = console.error = console.info = (...args) => mailerLogs.push(args.join(" "));
  try {
    return await OUTBOX.processEmailDeliveries({ now: () => clock });
  } finally {
    Object.assign(console, { log, error, info });
  }
}

test("SMTP accepted: the real mailer delivers the welcome email to the server; the row is SENT with the message id", async () => {
  server.mode = "accept";
  const row = await setupAndQueue();
  const report = await pass();
  assert.equal(report.sent, 1, JSON.stringify({ report, row, logs: mailerLogs.slice(-3) }));
  assert.equal(row.status, "SENT");
  assert.match(row.providerMessageId, /^<.+>$/);
  assert.equal(server.messages.length, 1);
  const message = server.messages[0];
  assert.ok(message.includes("Subject: =?UTF-8?Q?Welcome_to_SLClassroom"), "the welcome subject (MIME encoded)");
  assert.match(message, /To: nimal@student\.test/);
  assert.match(message, /PK-001/);
  assert.match(message, new RegExp(PASSWORD), "the student receives the queued password");
  // Never in the logs (the mailer logs a masked recipient only).
  assert.ok(mailerLogs.every((l) => !l.includes(PASSWORD) && !l.includes("nimal@student.test")));
});

test("SMTP 550 rejection: FAILED at once (permanent), no automatic retry, credentials kept for a manual retry", async () => {
  server.mode = "reject";
  const row = await setupAndQueue();
  await pass();
  assert.equal(row.status, "FAILED");
  assert.equal(row.lastErrorCode, "SMTP_550");
  assert.equal(row.lastOutcomeAmbiguous, false);
  assert.match(row.encryptedPayload, /^v1\./);
  assert.equal(server.messages.length, 0);
});

test("SMTP 452 deferral: retried with backoff, then delivered with the same password", async () => {
  server.mode = "defer";
  const row = await setupAndQueue();
  await pass();
  assert.equal(row.status, "PENDING");
  assert.equal(row.lastErrorCode, "SMTP_452");
  server.mode = "accept";
  clock = new Date(clock.getTime() + 61_000);
  await pass();
  assert.equal(row.status, "SENT");
  assert.equal(row.attemptCount, 2);
  assert.match(server.messages[0], new RegExp(PASSWORD));
});

test("connection dropped after the message data: recorded as an UNKNOWN outcome and retried - the student may get the same email twice, never two passwords", async () => {
  server.mode = "drop-after-data";
  const row = await setupAndQueue();
  await pass();
  assert.equal(row.status, "PENDING", `code=${row.lastErrorCode}`);
  assert.equal(row.lastOutcomeAmbiguous, true, `code=${row.lastErrorCode}`);
  server.mode = "accept";
  clock = new Date(clock.getTime() + 61_000);
  await pass();
  assert.equal(row.status, "SENT");
  assert.equal(server.messages.length, 2, "duplicate delivery is possible");
  assert.ok(server.messages.every((m) => m.includes(PASSWORD)), "both carry the SAME password");
});

test("server unreachable: a temporary failure, retried (nothing could have been sent)", async () => {
  const row = await setupAndQueue();
  const port = process.env.SMTP_PORT;
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  process.env.SMTP_PORT = String(closed.address().port);
  await new Promise((resolve) => closed.close(resolve));
  try {
    await pass();
  } finally {
    process.env.SMTP_PORT = port;
  }
  assert.equal(row.status, "PENDING");
  assert.equal(row.lastOutcomeAmbiguous, false, `code=${row.lastErrorCode}`);
  assert.equal(row.lastErrorCode, "ESOCKET"); // nodemailer's code for a refused connection (syscall connect)
});

// ---- No email provider configured (the real mailer silently skips in development) ----

/** Runs fn with no SMTP / Sender.net configuration and the given NODE_ENV. */
async function withoutProvider(nodeEnv, fn) {
  const saved = { host: process.env.SMTP_HOST, env: process.env.NODE_ENV };
  delete process.env.SMTP_HOST;
  process.env.NODE_ENV = nodeEnv;
  try {
    return await fn();
  } finally {
    process.env.SMTP_HOST = saved.host;
    if (saved.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.env;
  }
}

test("no provider (development: the mailer skips): NEVER marked SENT; explicit EMAIL_NOT_CONFIGURED; retried later", async () => {
  server.mode = "accept";
  const row = await setupAndQueue();
  const report = await withoutProvider("development", pass);
  assert.equal(report.sent, 0);
  assert.equal(row.status, "PENDING");
  assert.equal(row.lastErrorCode, "EMAIL_NOT_CONFIGURED");
  assert.match(row.lastErrorMessage, /No email provider is configured/);
  assert.equal(row.sentAt ?? null, null);
  assert.match(row.encryptedPayload, /^v1\./, "credentials kept for when a provider is configured");
  assert.equal(server.messages.length, 0);

  // Once configured, the same credentials go out.
  clock = new Date(clock.getTime() + 61_000);
  await pass();
  assert.equal(row.status, "SENT");
  assert.match(server.messages[0], new RegExp(PASSWORD));
});

test("no provider (production: the mailer throws): the same explicit configuration failure", async () => {
  const row = await setupAndQueue();
  await withoutProvider("production", pass);
  assert.equal(row.status, "PENDING");
  assert.equal(row.lastErrorCode, "EMAIL_NOT_CONFIGURED");
  assert.equal(row.lastOutcomeAmbiguous, false);
});

test("no provider: a credential RESEND is never activated; the old password keeps working until a provider accepts the email", async () => {
  const RESEND = require(path.join(root, "services", "student-registration-email-resend-service.ts"));
  await setupAndQueue();
  FAKE_DB.db.emailDelivery.length = 0;
  const before = FAKE_DB.db.student[0].password;
  await RESEND.resendStudentRegistrationEmails("t1", "s1", { now: () => clock });
  const row = FAKE_DB.db.emailDelivery[0];

  for (let i = 0; i < 3; i += 1) {
    await withoutProvider("development", pass);
    clock = new Date(clock.getTime() + 7 * 3600_000);
  }
  assert.equal(row.status, "PENDING");
  assert.equal(row.lastErrorCode, "EMAIL_NOT_CONFIGURED");
  assert.equal(row.activatedAt ?? null, null);
  assert.equal(FAKE_DB.db.student[0].password, before, "the old password is untouched");
  assert.equal(FAKE_DB.db.student[0].sessionVersion, 0, "no session ended");

  server.mode = "accept";
  await pass();
  assert.equal(row.status, "SENT");
  assert.ok(row.activatedAt instanceof Date, "activated only after real acceptance");
  const mailed = server.messages.at(-1).match(/Temporary Password: (\S+)/)[1];
  assert.ok(await bcrypt.compare(mailed, FAKE_DB.db.student[0].password), "the emailed password is now the active one");
  assert.equal(FAKE_DB.db.student[0].sessionVersion, 1);
});

test("acceptance rule: only a provider's positive answer counts", () => {
  assert.equal(OUTBOX.isProviderAcceptance(undefined), false, "mailer skipped");
  assert.equal(OUTBOX.isProviderAcceptance(null), false);
  assert.equal(OUTBOX.isProviderAcceptance(3), false);
  assert.equal(OUTBOX.isProviderAcceptance({ messageId: "x" }), true, "Sender.net");
  assert.equal(OUTBOX.isProviderAcceptance({ messageId: "<x>", accepted: ["a@b.c"], rejected: [] }), true, "SMTP");
  assert.equal(OUTBOX.isProviderAcceptance({ messageId: "<x>", accepted: [], rejected: ["a@b.c"] }), false, "SMTP: nobody accepted");
});
