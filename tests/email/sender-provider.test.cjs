/*
 * Sender.net transactional provider in lib/mailer.ts (sendEmail).
 *
 *   node --test tests/email/sender-provider.test.cjs
 *
 * Runs the real lib/mailer.ts and the real email templates through tsx. Only
 * the network edges are faked: global fetch (Sender.net API) and the
 * nodemailer module (SMTP). No real email is sent and no server is contacted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const TOKEN = "sender-test-token-7f3a9c1e5b";

// ---- Fake nodemailer (SMTP) -------------------------------------------------

const smtp = { sent: [], verified: 0 };

const nodemailerPath = require.resolve("nodemailer", { paths: [root] });
const fakeNodemailer = new Module(nodemailerPath);
fakeNodemailer.filename = nodemailerPath;
fakeNodemailer.loaded = true;
fakeNodemailer.exports = {
  createTransport: () => ({
    verify: async () => {
      smtp.verified += 1;
      return true;
    },
    sendMail: async (message) => {
      smtp.sent.push(message);
      return { accepted: [message.to], rejected: [], response: "250 OK", messageId: "<smtp-1>" };
    },
  }),
};
require.cache[nodemailerPath] = fakeNodemailer;

// ---- Fake fetch (Sender.net) ------------------------------------------------

const requests = [];
let respond = () => jsonResponse(200, { success: true, message: "Email sent", emailId: "em-123" });

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const fakeFetch = async (url, init) => {
  requests.push({ url, init, body: JSON.parse(init.body) });
  return respond(url, init);
};
globalThis.fetch = fakeFetch;

// ---- Console capture (for log assertions) ----------------------------------

const logs = [];
for (const level of ["log", "info", "error", "warn"]) {
  console[level] = (...args) => {
    logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
  };
}

const mailer = require(path.join(root, "lib", "mailer.ts"));
// In an automated test Sender.net is selected only with a registered in-process
// fake (lib/email-test-guard.ts); this file's fake plays the Sender.net API.
require(path.join(root, "lib", "email-test-guard.ts")).useTestSenderFetch(fakeFetch);

function useSender() {
  process.env.SENDER_API_TOKEN = TOKEN;
  process.env.SENDER_FROM_EMAIL = "info@slclassroom.live";
  process.env.SENDER_FROM_NAME = "SLClassroom";
}

function useSmtpOnly() {
  delete process.env.SENDER_API_TOKEN;
  delete process.env.SENDER_FROM_EMAIL;
  delete process.env.SENDER_FROM_NAME;
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "smtp-user@example.test";
  process.env.SMTP_PASS = "smtp-pass";
  process.env.SMTP_FROM = "SLClassroom <no-reply@example.test>";
}

test.beforeEach(() => {
  requests.length = 0;
  smtp.sent.length = 0;
  smtp.verified = 0;
  respond = () => jsonResponse(200, { success: true, message: "Email sent", emailId: "em-123" });
  useSender();
});

test.after(() => {
  // No log line, at any point in this file, may contain the API token.
  for (const line of logs) {
    assert.ok(!line.includes(TOKEN), `token leaked into log: ${line}`);
  }
});

// ---- Success and payload ---------------------------------------------------

test("successful send posts to the Sender.net endpoint with bearer auth", async () => {
  const result = await mailer.sendEmail("student@example.com", "Hello", "<p>Hi</p>", "Hi", "StudentRegistration");

  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, "https://api.sender.net/v2/message/send");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers.Accept, "application/json");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(result, { messageId: "em-123" });
  assert.equal(smtp.sent.length, 0, "SMTP must not be used when the token is set");
});

test("payload carries the configured sender, recipient, subject, html and text unchanged", async () => {
  await mailer.sendEmail("student@example.com", "Subject ✓", "<p>Body <b>x</b></p>", "Body x", "PasswordReset");

  assert.deepEqual(requests[0].body, {
    from: { email: "info@slclassroom.live", name: "SLClassroom" },
    to: { email: "student@example.com" },
    subject: "Subject ✓",
    html: "<p>Body <b>x</b></p>",
    text: "Body x",
  });
});

test("missing text falls back to the HTML-stripped body, exactly as for SMTP", async () => {
  await mailer.sendEmail("student@example.com", "S", "<p>Hello <b>there</b></p>", undefined, "StudentRegistration");
  assert.equal(requests[0].body.text, "Hello there");
});

test("SENDER_FROM_NAME defaults to SLClassroom", async () => {
  delete process.env.SENDER_FROM_NAME;
  await mailer.sendEmail("student@example.com", "S", "<p>x</p>", "x", "PasswordReset");
  assert.equal(requests[0].body.from.name, "SLClassroom");
});

test("existing templates go through unchanged (password reset and confirmation code)", async () => {
  await mailer.sendPasswordResetEmail({ to: "t@example.com", resetLink: "https://slclassroom.live/reset-password/confirm?token=abc" });
  await mailer.sendEmailVerificationCodeEmail({ to: "s@example.com", code: "123456" });

  const [reset, code] = requests.map((r) => r.body);
  assert.equal(reset.subject, "Reset your SLClassroom password");
  assert.ok(reset.html.includes("https://slclassroom.live/reset-password/confirm?token=abc"));
  assert.ok(reset.text.includes("https://slclassroom.live/reset-password/confirm?token=abc"));
  assert.equal(code.subject, "Your SLClassroom confirmation code");
  assert.ok(code.html.includes("123456"));
  assert.ok(code.text.startsWith("Your SLClassroom confirmation code is: 123456"));
});

test("success is logged with the existing [EMAIL] format, a masked recipient and the emailId", async () => {
  logs.length = 0;
  await mailer.sendEmail("student@example.com", "S", "<p>x</p>", "x", "DeviceDecision");

  const sent = logs.find((l) => l.startsWith("[EMAIL] Sent successfully"));
  assert.ok(sent);
  assert.ok(sent.includes("purpose=DeviceDecision"));
  assert.ok(sent.includes("provider=sender"));
  assert.ok(sent.includes('messageId="em-123"'));
  assert.ok(!logs.join("\n").includes("student@example.com"), "full recipient address must not be logged");
});

// ---- Failures: thrown, logged, never retried over SMTP -----------------------

async function expectFailure(code, status, messagePart) {
  logs.length = 0;
  await assert.rejects(
    mailer.sendEmail("student@example.com", "S", "<p>x</p>", "x", "PasswordReset"),
    (error) => {
      assert.equal(error.name, "SenderApiError");
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      if (messagePart) assert.ok(error.message.includes(messagePart), error.message);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    }
  );
  assert.equal(smtp.sent.length, 0, "must not fall back to SMTP");
  assert.equal(smtp.verified, 0, "must not touch SMTP");
  assert.equal(requests.length, 1, "must not retry");
  const failed = logs.find((l) => l.startsWith("[EMAIL] Send failed"));
  assert.ok(failed && failed.includes("provider=sender"));
}

test("401 invalid token: thrown as SENDER_AUTH_FAILED, no SMTP fallback", async () => {
  respond = () => jsonResponse(401, { message: "Unauthenticated." });
  await expectFailure("SENDER_AUTH_FAILED", 401, "Unauthenticated.");
});

test("422 validation error: Sender's message is surfaced, no SMTP fallback", async () => {
  respond = () =>
    jsonResponse(422, { message: "The given data was invalid.", errors: { from: ["From email must be verified"] } });
  await expectFailure("SENDER_VALIDATION_FAILED", 422, "From email must be verified");
});

test("429 rate limit: Retry-After is reported, no SMTP fallback, no retry", async () => {
  respond = () => jsonResponse(429, { message: "Too Many Attempts." }, { "Retry-After": "42" });
  await expectFailure("SENDER_RATE_LIMITED", 429, "retry after 42s");
});

test("5xx server error is thrown, no SMTP fallback", async () => {
  respond = () => new Response("<html>Bad Gateway</html>", { status: 502 });
  await expectFailure("SENDER_SERVER_ERROR", 502, "HTTP 502");
});

test("2xx without success:true is treated as a failure", async () => {
  respond = () => jsonResponse(200, { success: false, message: "You must activate workflow first" });
  await expectFailure("SENDER_NOT_CONFIRMED", 200, "You must activate workflow first");
});

test("network error is thrown, no SMTP fallback", async () => {
  respond = () => {
    throw new TypeError("fetch failed");
  };
  await expectFailure("SENDER_NETWORK_ERROR", null, "fetch failed");
});

test("request is aborted after the 15 second timeout", async () => {
  const realTimeout = AbortSignal.timeout;
  const requestedMs = [];
  AbortSignal.timeout = (ms) => {
    requestedMs.push(ms);
    return realTimeout.call(AbortSignal, 20); // fire quickly in the test
  };
  respond = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });

  try {
    await expectFailure("SENDER_TIMEOUT", null, "timed out after 15s");
    assert.deepEqual(requestedMs, [15_000]);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});

test("token set but SENDER_FROM_EMAIL missing: EMAIL_NOT_CONFIGURED, no request, no SMTP", async () => {
  delete process.env.SENDER_FROM_EMAIL;
  useSmtpOnlyEnvKeepingToken();

  await assert.rejects(
    mailer.sendEmail("student@example.com", "S", "<p>x</p>", "x", "PasswordReset"),
    (error) => error.code === "EMAIL_NOT_CONFIGURED"
  );
  assert.equal(requests.length, 0);
  assert.equal(smtp.sent.length, 0);
});

function useSmtpOnlyEnvKeepingToken() {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_USER = "smtp-user@example.test";
  process.env.SMTP_PASS = "smtp-pass";
}

// ---- No token: the existing SMTP path ---------------------------------------

test("without SENDER_API_TOKEN the existing SMTP path is used unchanged", async () => {
  useSmtpOnly();

  const info = await mailer.sendEmail("student@example.com", "Hello", "<p>Hi</p>", "Hi", "StudentRegistration");

  assert.equal(requests.length, 0, "Sender.net must not be called");
  assert.equal(smtp.verified, 1);
  assert.equal(smtp.sent.length, 1);
  assert.deepEqual(smtp.sent[0], {
    from: "SLClassroom <no-reply@example.test>",
    to: "student@example.com",
    subject: "Hello",
    html: "<p>Hi</p>",
    text: "Hi",
  });
  assert.equal(info.messageId, "<smtp-1>");
});

test("an empty SENDER_API_TOKEN counts as not configured (SMTP is used)", async () => {
  useSmtpOnly();
  process.env.SENDER_API_TOKEN = "   ";

  await mailer.sendEmail("student@example.com", "Hello", "<p>Hi</p>", "Hi", "PasswordReset");
  assert.equal(requests.length, 0);
  assert.equal(smtp.sent.length, 1);
});

test("the token is never in any log line or error message", async () => {
  logs.length = 0;
  respond = () => jsonResponse(401, { message: "Unauthenticated." });
  await mailer.sendEmail("a@example.com", "S", "<p>x</p>", "x", "PasswordReset").catch((e) => {
    assert.ok(!String(e.message).includes(TOKEN));
  });
  respond = () => jsonResponse(200, { success: true, emailId: "em-9" });
  await mailer.sendEmail("a@example.com", "S", "<p>x</p>", "x", "PasswordReset");

  assert.ok(logs.length >= 3);
  for (const line of logs) {
    assert.ok(!line.includes(TOKEN));
    assert.ok(!/authorization|bearer/i.test(line));
  }
});

// ---- Callers keep their behaviour --------------------------------------------

test("class-started notifications still retry 3 times and report failure per recipient", async () => {
  respond = () => jsonResponse(500, { message: "Server Error" });
  const results = await mailer.sendClassStartedNotifications(
    [{ email: "s@example.com", displayName: "S" }, { email: null, displayName: "No email" }],
    "Class has started"
  );

  assert.equal(requests.length, 3);
  assert.equal(results[0].success, false);
  assert.ok(results[0].error.includes("HTTP 500"));
  assert.equal(results[1].error, "Missing email address.");
  assert.equal(smtp.sent.length, 0);
});

test("sender module source keeps the token server-side (no NEXT_PUBLIC_ variant)", () => {
  const source = require("node:fs").readFileSync(path.join(root, "lib", "mailer.ts"), "utf8");
  assert.ok(source.includes("process.env.SENDER_API_TOKEN"));
  assert.ok(!/NEXT_PUBLIC_SENDER/.test(source));
});
