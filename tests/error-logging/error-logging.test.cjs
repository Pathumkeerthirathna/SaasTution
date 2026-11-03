/*
 * Error logging (lib/error-logging): sanitizing, the JSON Lines file sink
 * (concurrent writes, rotation, failures), handleRouteError's log entry and
 * unchanged responses, the browser-report endpoint's guards, and the browser
 * reporter.
 *
 *   npm run test:errors
 *
 * Writes only to a temporary directory (ERROR_LOG_DIR), removed afterwards.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slc-error-log-test-"));
process.env.ERROR_LOG_DIR = LOG_DIR;

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const sanitize = require(path.join(root, "lib/error-logging/sanitize.ts"));
const sinkModule = require(path.join(root, "lib/error-logging/file-sink.ts"));
const { createRateLimiter } = require(path.join(root, "lib/error-logging/rate-limit.ts"));
const errorHandler = require(path.join(root, "lib/error-handler.ts"));
const clientErrorsRoute = require(path.join(root, "app/api/client-errors/route.ts"));

test.after(() => fs.rmSync(LOG_DIR, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readLines(file) {
  const full = path.join(LOG_DIR, file);

  if (!fs.existsSync(full)) return [];

  return fs.readFileSync(full, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Other module instances (handleRouteError's lazy import) write on their own
// queue: wait for the line instead.
async function waitForLines(file, count) {
  for (let i = 0; i < 100; i++) {
    const lines = readLines(file);

    if (lines.length >= count) return lines;
    await sleep(20);
  }

  return readLines(file);
}

const SECRETS = ["hunter2", "eyJhbGciOiJIUzI1NiJ9", "nethmi@example.com", "0771234567", "abc123SECRET", "sk_live"];

function assertNoSecrets(text) {
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), `leaked: ${secret}`);
  }
}

// ---- Sanitizing --------------------------------------------------------------

test("scrubText: tokens, passwords, cookies, emails, phone numbers and URL queries are redacted", () => {
  const input = [
    "login failed password=hunter2 for nethmi@example.com",
    "Authorization: Bearer abc123SECRETabc123SECRET",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl",
    '{"token":"abc123SECRET","apiKey":"sk_live_1"}',
    "cookie: sl_session=abc123SECRET; other=1",
    "call 077 123 4567 or 0771234567",
    "at https://slclassroom.live/session/join?invite=abc123SECRET&studentId=42:10:5",
  ].join("\n");

  const output = sanitize.scrubText(input, 5000);

  assertNoSecrets(output);
  assert.match(output, /password=\[REDACTED\]/);
  assert.match(output, /\[REDACTED_EMAIL\]/);
  assert.match(output, /\[REDACTED_JWT\]/);
  assert.match(output, /https:\/\/slclassroom\.live\/session\/join\?\[query\]/);
  assert.match(output, /login failed/, "ordinary text stays readable");
});

test("scrubText: limits the length; non-strings become empty", () => {
  assert.equal(sanitize.scrubText("x".repeat(50), 10).length, 10);
  assert.equal(sanitize.scrubText(undefined, 10), "");
  assert.equal(sanitize.scrubText({ password: "hunter2" }, 10), "");
});

test("sanitizeRoute: path only; tokens in the path redacted, record IDs kept", () => {
  assert.equal(sanitize.sanitizeRoute("/session/join?sessionId=1&invite=abc123SECRET#x"), "/session/join");
  assert.equal(
    sanitize.sanitizeRoute("https://slclassroom.live/api/students/11111111-1111-4111-8111-111111111111?x=1"),
    "/api/students/11111111-1111-4111-8111-111111111111"
  );
  assert.equal(sanitize.sanitizeRoute(`/reset-password/${"a".repeat(64)}`), "/reset-password/:redacted");
  assert.equal(sanitize.sanitizeRoute("/u/nethmi@example.com"), "/u/:redacted");
});

test("normalizeError: Errors, strings and objects; an object is never serialized whole", () => {
  const error = Object.assign(new Error("boom password=hunter2"), { digest: "12345" });
  const normalized = sanitize.normalizeError(error);

  assert.equal(normalized.name, "Error");
  assert.match(normalized.message, /^boom password=\[REDACTED\]$/);
  assert.ok(normalized.stack.includes("error-logging.test.cjs"));
  assert.equal(normalized.digest, "12345");

  const fromObject = sanitize.normalizeError({ student: { email: "nethmi@example.com", phone: "0771234567" } });
  assertNoSecrets(JSON.stringify(fromObject));
  assert.match(fromObject.message, /Non-Error value thrown/);

  assert.equal(sanitize.normalizeError("plain").message, "plain");
  assert.match(sanitize.normalizeError(null).message, /null/);
});

// ---- File sink ---------------------------------------------------------------

function entry(index, extra = {}) {
  return {
    id: `id-${index}`,
    timestamp: new Date().toISOString(),
    source: "server",
    kind: "test",
    environment: "test",
    name: "Error",
    message: `message ${index}`,
    ...extra,
  };
}

test("file sink: concurrent writes give one valid JSON line each, nothing interleaved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slc-sink-"));
  const sink = sinkModule.createFileSink({ dir: path.join(dir, "nested", "errors"), maxBytes: 10 * 1024 * 1024, maxFiles: 3 });

  await Promise.all(Array.from({ length: 300 }, (_, i) => sink.write("server", entry(i, { stack: "x".repeat(i * 10) }))));
  await sink.flush();

  const lines = fs.readFileSync(path.join(dir, "nested", "errors", "server-errors.jsonl"), "utf8").split("\n").filter(Boolean);

  assert.equal(lines.length, 300, "the directory was created and every entry written");
  assert.deepEqual(new Set(lines.map((line) => JSON.parse(line).id)).size, 300);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file sink: rotates at the size limit and keeps at most maxFiles old files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slc-sink-"));
  const sink = sinkModule.createFileSink({ dir, maxBytes: 2000, maxFiles: 2 });

  for (let i = 0; i < 60; i++) {
    await sink.write("api", entry(i, { message: "m".repeat(150) }));
  }

  const files = fs.readdirSync(dir).sort();

  assert.deepEqual(files, ["api-errors.jsonl", "api-errors.jsonl.1", "api-errors.jsonl.2"]);

  for (const file of files) {
    assert.ok(fs.statSync(path.join(dir, file)).size <= 2000, `${file} within the limit`);
    fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean).forEach((line) => JSON.parse(line));
  }

  const newest = fs.readFileSync(path.join(dir, "api-errors.jsonl"), "utf8").trim().split("\n").pop();
  assert.equal(JSON.parse(newest).id, "id-59", "the newest entry is in the current file");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file sink: an oversized entry is shortened to one line; failures never throw", async () => {
  const line = sinkModule.serializeEntry(entry(1, { stack: "s".repeat(100_000) }));

  assert.ok(Buffer.byteLength(line) <= sinkModule.MAX_LINE_BYTES + 1);
  assert.equal(JSON.parse(line).stack, undefined);

  // The "directory" is a file: writing must fail quietly.
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slc-sink-")), "not-a-dir");
  fs.writeFileSync(blocker, "x");

  const sink = sinkModule.createFileSink({ dir: blocker, maxBytes: 100_000, maxFiles: 2 });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    await sink.write("client", entry(1));
    sink.writeSync("client", entry(2));
  } finally {
    console.error = original;
  }

  assert.ok(errors.length <= 1 && errors.every((text) => !text.includes("message 1")), "reported once, without the entry");
});

test("file sink options: ERROR_LOG_DIR, else ./logs/errors; limits bounded", () => {
  assert.equal(sinkModule.resolveFileSinkOptions({ ERROR_LOG_DIR: "/var/log/slclassroom/errors" }).dir, path.resolve("/var/log/slclassroom/errors"));
  assert.equal(sinkModule.resolveFileSinkOptions({}).dir, path.join(process.cwd(), "logs", "errors"));
  assert.equal(sinkModule.resolveFileSinkOptions({ ERROR_LOG_MAX_BYTES: "1" }).maxBytes, 64 * 1024);
  assert.equal(sinkModule.resolveFileSinkOptions({ ERROR_LOG_MAX_FILES: "999" }).maxFiles, 50);

  // Test runs write nowhere unless pointed at a directory; ERROR_LOG_DISABLED turns it off.
  assert.equal(sinkModule.resolveFileSinkOptions({ NODE_TEST_CONTEXT: "child-v8" }).enabled, false);
  assert.equal(sinkModule.resolveFileSinkOptions({ NODE_TEST_CONTEXT: "child-v8", ERROR_LOG_DIR: "/tmp/x" }).enabled, true);
  assert.equal(sinkModule.resolveFileSinkOptions({ NODE_ENV: "production" }).enabled, true);
  assert.equal(sinkModule.resolveFileSinkOptions({ NODE_ENV: "production", ERROR_LOG_DISABLED: "1" }).enabled, false);
});

test("process monitor: not installed outside the Next.js Node.js server (tests keep their own rejection handling)", () => {
  assert.equal(globalThis[Symbol.for("slclassroom.errorLogging.processMonitor")], undefined);
});

// ---- API routes: handleRouteError --------------------------------------------

test("handleRouteError: unexpected errors keep the 500 contract and are logged to api-errors.jsonl, sanitized", async () => {
  const request = new Request("http://localhost:3000/api/students/11111111-1111-4111-8111-111111111111?email=nethmi@example.com", {
    method: "PATCH",
    headers: {
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      cookie: "sl_session=abc123SECRET",
      authorization: "Bearer abc123SECRETabc123SECRET",
    },
  });
  const original = console.error;
  console.error = () => undefined;

  let response;
  try {
    response = errorHandler.handleRouteError(new Error("db failed for nethmi@example.com password=hunter2"), { request });
  } finally {
    console.error = original;
  }

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    success: false,
    error: { message: "db failed for nethmi@example.com password=hunter2", code: "INTERNAL_SERVER_ERROR" },
  }, "the response is exactly as before");

  const [logged] = await waitForLines("api-errors.jsonl", 1);

  assert.equal(logged.source, "api");
  assert.equal(logged.kind, "unhandled-route-error");
  assert.equal(logged.statusCode, 500);
  assert.equal(logged.method, "PATCH");
  assert.equal(logged.route, "/api/students/11111111-1111-4111-8111-111111111111");
  assert.equal(logged.browser, "Mobile Safari 17.5");
  assert.equal(logged.os, "iOS 17.5");
  assert.equal(logged.deviceType, "mobile");
  assert.ok(logged.stack.length > 0);
  assertNoSecrets(JSON.stringify(logged));
});

test("handleRouteError: AppError, JSON errors and Next.js control flow are not logged; responses unchanged", async () => {
  const before = readLines("api-errors.jsonl").length;
  const context = { request: new Request("http://localhost:3000/api/students", { method: "POST" }) };
  const original = console.error;
  console.error = () => undefined;

  try {
    const appError = errorHandler.handleRouteError(new errorHandler.AppError("Not yours.", 403, "FORBIDDEN"), context);
    assert.equal(appError.status, 403);
    assert.deepEqual(await appError.json(), { success: false, error: { message: "Not yours.", code: "FORBIDDEN" } });

    const json = errorHandler.handleRouteError(new SyntaxError("Unexpected token"), context);
    assert.equal(json.status, 400);

    const dynamic = errorHandler.handleRouteError(Object.assign(new Error("Dynamic server usage"), { digest: "DYNAMIC_SERVER_USAGE" }), context);
    assert.equal(dynamic.status, 500, "same response as before");
  } finally {
    console.error = original;
  }

  await sleep(300);
  assert.equal(readLines("api-errors.jsonl").length, before);
});

test("withApiErrorHandling: a thrown error becomes the standard 500 response, with the request logged", async () => {
  const before = readLines("api-errors.jsonl").length;
  const handler = errorHandler.withApiErrorHandling(async () => {
    throw new Error("deliberate API exception");
  });
  const original = console.error;
  console.error = () => undefined;

  let response;
  try {
    response = await handler(new Request("http://localhost/api/deliberate?token=abc123SECRET", { method: "POST" }), { params: {} });
  } finally {
    console.error = original;
  }

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "INTERNAL_SERVER_ERROR");

  const lines = await waitForLines("api-errors.jsonl", before + 1);
  const logged = lines[lines.length - 1];

  assert.equal(logged.message, "deliberate API exception");
  assert.equal(logged.route, "/api/deliberate");
  assert.equal(logged.method, "POST");
});

// ---- Browser reports: POST /api/client-errors --------------------------------

function report(body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);

  return clientErrorsRoute.POST(new Request("http://localhost:3000/api/client-errors", {
    method: "POST",
    body: text,
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "content-type": "text/plain;charset=UTF-8",
      "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      "x-forwarded-for": headers.ip ?? "203.0.113.1",
      ...headers,
    },
  }));
}

const validReport = {
  source: "react",
  kind: "error-boundary:classroom",
  name: "TypeError",
  message: "x is undefined (student nethmi@example.com, password=hunter2)",
  stack: "TypeError: x\n    at https://slclassroom.live/_next/static/chunks/page.js?token=abc123SECRET:1:200",
  digest: "2210434325",
  route: "/session/join?invite=abc123SECRET",
  clientEventId: "a1b2c3d4e5f60718",
};

test("client errors: a valid report is written to client-errors.jsonl (sanitized again, browser from the User-Agent)", async () => {
  const response = await report(validReport);

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");

  const [logged] = await waitForLines("client-errors.jsonl", 1);

  assert.equal(logged.source, "react");
  assert.equal(logged.kind, "error-boundary:classroom");
  assert.equal(logged.route, "/session/join");
  assert.equal(logged.digest, "2210434325");
  assert.equal(logged.clientEventId, "a1b2c3d4e5f60718");
  assert.equal(logged.browser, "Mobile Chrome 130.0.0.0");
  assert.equal(logged.os, "Android 14");
  assert.equal(logged.method, undefined, "the endpoint's own request is not the error's");
  assertNoSecrets(JSON.stringify(logged));
  assert.equal(readLines("api-errors.jsonl").filter((line) => line.route === "/api/client-errors").length, 0);
});

test("client errors: other sites, oversized bodies, invalid JSON, unknown fields and bad values are refused", async () => {
  assert.equal((await report(validReport, { origin: "https://evil.example" })).status, 403);
  assert.equal((await report(validReport, { origin: "", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await report({ ...validReport, stack: "s".repeat(9000) })).status, 413);
  assert.equal((await report("{not json")).status, 400);
  assert.equal((await report({ ...validReport, cookies: "a=b" })).status, 400, "only the known fields");
  assert.equal((await report({ ...validReport, source: "api" })).status, 400, "browsers cannot write API or server entries");
  assert.equal((await report({ ...validReport, kind: "<script>" })).status, 400);
  assert.equal((await report({ ...validReport, message: "m".repeat(3000) })).status, 400);
});

// M1: behind one trusted proxy, the client is the hop that proxy appended;
// whatever the client put at the front of X-Forwarded-For is ignored.
test("client errors (M1): 20 reports a minute per client behind a trusted proxy; spoofed X-Forwarded-For values do not help", async () => {
  process.env.TRUSTED_PROXY_COUNT = "1";

  try {
    const statuses = [];

    for (let i = 0; i < 22; i++) {
      // A different forged first entry every time, the same real address last.
      statuses.push((await report({ ...validReport, clientEventId: undefined, message: `flood ${i}` }, { ip: `10.0.0.${i}, 198.51.100.7` })).status);
    }

    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(204));
    assert.deepEqual(statuses.slice(20), [429, 429]);
    assert.equal((await report(validReport, { ip: "198.51.100.7, 198.51.100.8" })).status, 204, "another client is unaffected");
  } finally {
    delete process.env.TRUSTED_PROXY_COUNT;
  }
});

test("client errors (M1): without a trusted proxy, users are never pooled under one per-client limit", async () => {
  const statuses = [];

  for (let i = 0; i < 25; i++) {
    statuses.push((await report({ ...validReport, clientEventId: undefined, message: `user ${i}` }, { ip: "203.0.113.50" })).status);
  }

  assert.deepEqual(statuses, Array(25).fill(204), "only the global limit applies");
});

test("rate limiter (M1): per key, a lower global limit, null keys held to the global limit only, windows reset", () => {
  let now = 0;
  const limiter = createRateLimiter({ perKey: 2, global: 4, windowMs: 1000, now: () => now });

  assert.deepEqual([limiter.allow("a"), limiter.allow("a"), limiter.allow("a")], [true, true, false]);
  assert.deepEqual([limiter.allow(null), limiter.allow(null), limiter.allow(null)], [true, true, false], "global limit");
  now = 1000;
  assert.equal(limiter.allow("a"), true);
  assert.match(fs.readFileSync(path.join(root, "app/api/client-errors/route.ts"), "utf8"), /createRateLimiter\(\{ perKey: 20, global: 120, windowMs: 60_000 \}\)/);
});

// ---- Browser reporter ----------------------------------------------------------

test("reporter: sends a sanitized report by beacon (path only), skips duplicates and noise, and caps a page at 20", () => {
  const sent = [];
  const saved = { window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };

  globalThis.window = { location: { pathname: "/session/join", search: "?invite=abc123SECRET" } };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
  });

  try {
    const { reportClientError } = require(path.join(root, "lib/error-logging/client-reporter.ts"));

    const failure = new Error("render failed password=hunter2");
    const id = reportClientError(failure, { source: "react", kind: "error-boundary:app", digest: "99" });

    assert.match(id, /^[a-f0-9]{16}$/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "/api/client-errors");
    assert.equal(sent[0].blob.type, "text/plain;charset=utf-8");

    assert.equal(reportClientError(failure, { source: "react", kind: "error-boundary:app" }), null, "duplicate");
    assert.equal(reportClientError("Script error.", { source: "client", kind: "window-error" }), null, "cross-origin noise");

    for (let i = 0; i < 30; i++) {
      reportClientError(new Error(`distinct ${i}`), { source: "client", kind: "window-error" });
    }

    assert.equal(sent.length, 20, "capped per page");
    return sent[0].blob.text().then((body) => {
      const parsed = JSON.parse(body);

      assert.equal(parsed.route, "/session/join");
      assert.equal(parsed.digest, "99");
      assertNoSecrets(body);
    });
  } finally {
    globalThis.window = saved.window;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  }
});
