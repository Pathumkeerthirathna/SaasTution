/*
 * Automated tests can never send real email (lib/email-test-guard.ts, used by
 * lib/mailer.ts sendEmail).
 *
 *   node --test tests/email/email-test-guard.test.cjs
 *
 * Network edges are fakes only: nodemailer is replaced (records transports
 * and messages, opens no socket) and the global fetch is a tripwire that
 * records calls and answers locally. No secret value is ever printed.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

// ---- Fake nodemailer: records, never connects ---------------------------------------------

const smtp = { transports: [], sent: [] };
const nodemailerPath = require.resolve("nodemailer", { paths: [root] });
const fakeNodemailer = new Module(nodemailerPath);
fakeNodemailer.filename = nodemailerPath;
fakeNodemailer.loaded = true;
fakeNodemailer.exports = {
  createTransport: (options) => {
    smtp.transports.push(options);
    return {
      verify: async () => true,
      sendMail: async (message) => {
        smtp.sent.push(message);
        return { accepted: [message.to], rejected: [], response: "250 OK", messageId: "<local-1>" };
      },
    };
  },
};
require.cache[nodemailerPath] = fakeNodemailer;

// ---- Tripwire fetch: any call is recorded and answered locally -------------------------------

const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  return new Response(JSON.stringify({ success: true, emailId: "tripwire" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

for (const level of ["log", "info", "error", "warn"]) console[level] = () => {};

const guard = require(path.join(root, "lib", "email-test-guard.ts"));
const mailer = require(path.join(root, "lib", "mailer.ts"));

const FAKE_TOKEN = "fake-sender-token-for-tests"; // never a real credential

function realLookingProviderEnv() {
  process.env.SENDER_API_TOKEN = FAKE_TOKEN;
  process.env.SENDER_FROM_EMAIL = "info@slclassroom.live";
  process.env.SENDER_FROM_NAME = "SLClassroom";
}

function localSmtp() {
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = "2525";
  process.env.SMTP_USER = "test-user";
  process.env.SMTP_PASS = "test-pass";
  process.env.SMTP_FROM = "no-reply@test.local";
}

test.beforeEach(() => {
  fetchCalls.length = 0;
  smtp.transports.length = 0;
  smtp.sent.length = 0;
  guard.useTestSenderFetch(null);
  localSmtp();
});

const send = () => mailer.sendEmail("student@example.com", "Subject", "<p>Hi</p>", "Hi", "StudentWelcomeCredentials");

test("test runs are recognised (node:test, NODE_ENV=test, a test file run directly); app runs are not", () => {
  assert.equal(guard.isAutomatedTestRun(), true, "this process runs under node --test");
  assert.equal(guard.isAutomatedTestRun({ NODE_ENV: "test" }, ["node", "server.js"]), true);
  assert.equal(guard.isAutomatedTestRun({ NODE_TEST_CONTEXT: "child-v8" }, ["node", "x.js"]), true);
  assert.equal(guard.isAutomatedTestRun({}, ["node", "/repo/tests/students/a.test.cjs"]), true);
  assert.equal(guard.isAutomatedTestRun({}, ["node", "/repo/tests/ui/b.test.tsx"]), true);
  assert.equal(guard.isAutomatedTestRun({ NODE_ENV: "production" }, ["node", "/app/node_modules/next/dist/bin/next"]), false);
  assert.equal(guard.isAutomatedTestRun({ NODE_ENV: "development" }, ["node", "/app/node_modules/next/dist/bin/next"]), false);
  assert.equal(guard.isAutomatedTestRun({}, ["node", "/app/server.js"]), false);
});

test("test-safe SMTP hosts: loopback and reserved test domains only", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "smtp.example.test", "mail.example", "x.invalid", "a.localhost"]) {
    assert.equal(guard.isTestSafeSmtpHost(host), true, host);
  }
  for (const host of ["smtp.gmail.com", "smtp.sender.net", "mail.slclassroom.live", "10.0.0.5", "192.168.1.10", "test.com", "", null, undefined]) {
    assert.equal(guard.isTestSafeSmtpHost(host), false, String(host));
  }
});

test("a Sender.net token in the environment never selects Sender.net in a test: the local SMTP path is used", async () => {
  realLookingProviderEnv();
  await send();
  assert.deepEqual(fetchCalls, [], "no Sender.net request");
  assert.equal(smtp.sent.length, 1);
  assert.equal(smtp.transports[0].host, "127.0.0.1");
});

test("importing Prisma Client (which loads .env) cannot re-enable a real provider", async () => {
  delete process.env.SENDER_API_TOKEN;
  delete process.env.SENDER_FROM_EMAIL;
  // The exact sequence of tests/students/email-delivery-smtp.test.cjs: the
  // generated client fills in every absent variable from the project .env.
  require(require.resolve("@prisma/client", { paths: [root] }));
  localSmtp();

  await send();
  assert.deepEqual(fetchCalls, [], "whatever .env restored, no Sender.net request");
  assert.equal(smtp.sent.length, 1);
  assert.equal(smtp.transports[0].host, "127.0.0.1");
});

test("SMTP to a real host in a test fails with EMAIL_BLOCKED_IN_TEST before any transport is created", async () => {
  delete process.env.SENDER_API_TOKEN;
  process.env.SMTP_HOST = "smtp.gmail.com";
  await assert.rejects(send(), (error) => {
    assert.equal(error.code, "EMAIL_BLOCKED_IN_TEST");
    return true;
  });
  assert.deepEqual(smtp.transports, [], "no transport, so no connection");
  assert.deepEqual(smtp.sent, []);
  assert.deepEqual(fetchCalls, []);
});

test("reaching Sender.net in a test without a registered fake fails before any request", () => {
  assert.throws(() => guard.senderFetch(), (error) => error.code === "EMAIL_BLOCKED_IN_TEST");
  assert.deepEqual(fetchCalls, []);
});

test("a registered in-process fake is the only way a test exercises Sender.net, and it gets the request", async () => {
  realLookingProviderEnv();
  const faked = [];
  guard.useTestSenderFetch(async (url, init) => {
    faked.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, emailId: "em-fake" }), { status: 200 });
  });

  const result = await send();
  assert.equal(result.messageId, "em-fake");
  assert.equal(faked.length, 1);
  assert.equal(faked[0].url, "https://api.sender.net/v2/message/send");
  assert.deepEqual(fetchCalls, [], "the global fetch is never used in a test");
  assert.deepEqual(smtp.sent, []);
});

test("outside tests provider selection is unchanged: Sender.net with a token, SMTP without", async (t) => {
  const saved = { ctx: process.env.NODE_TEST_CONTEXT, env: process.env.NODE_ENV, argv1: process.argv[1] };
  t.after(() => {
    if (saved.ctx === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = saved.ctx;
    if (saved.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.env;
    process.argv[1] = saved.argv1;
  });
  // Simulate the app process (no test markers). The global fetch here is the
  // local tripwire, so even this "production-like" path opens no connection.
  delete process.env.NODE_TEST_CONTEXT;
  process.env.NODE_ENV = "development";
  process.argv[1] = path.join(root, "node_modules", "next", "dist", "bin", "next");
  assert.equal(guard.isAutomatedTestRun(), false);

  realLookingProviderEnv();
  await send();
  assert.deepEqual(fetchCalls, ["https://api.sender.net/v2/message/send"], "Sender.net selected via the platform fetch");
  assert.deepEqual(smtp.sent, []);

  delete process.env.SENDER_API_TOKEN;
  process.env.SMTP_HOST = "smtp.gmail.com"; // any host is allowed outside tests (fake transport here)
  await send();
  assert.equal(smtp.sent.length, 1);
  assert.equal(smtp.transports[0].host, "smtp.gmail.com");
});
