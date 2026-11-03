/*
 * Regression tests for the error-logging security / reliability review:
 * H1 (Prisma errors), H2 (origins behind a reverse proxy), M1 (client
 * identity, byte budget), M2 (linear-time sanitizing), M3 (sanitizer gaps),
 * M5 (storage check), L3 (bounded queue), L5 (control characters), L7 (Try
 * again), L8 (console summaries) and the added API route coverage.
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

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slc-error-review-test-"));
process.env.ERROR_LOG_DIR = LOG_DIR;

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const sanitize = require(path.join(root, "lib/error-logging/sanitize.ts"));
const sinkModule = require(path.join(root, "lib/error-logging/file-sink.ts"));
const trust = require(path.join(root, "lib/error-logging/request-trust.ts"));
const serverLogger = require(path.join(root, "lib/error-logging/server-logger.ts"));
const errorHandler = require(path.join(root, "lib/error-handler.ts"));
const clientErrorsRoute = require(path.join(root, "app/api/client-errors/route.ts"));

test.after(() => fs.rmSync(LOG_DIR, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readLines(file) {
  const full = path.join(LOG_DIR, file);

  if (!fs.existsSync(full)) return [];

  return fs.readFileSync(full, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForLines(file, count) {
  for (let i = 0; i < 100; i++) {
    const lines = readLines(file);

    if (lines.length >= count) return lines;
    await sleep(20);
  }

  return readLines(file);
}

function quietConsole(fn) {
  const original = console.error;
  console.error = () => undefined;

  try {
    return fn();
  } finally {
    console.error = original;
  }
}

function entry(index, extra = {}) {
  return { id: `id-${index}`, timestamp: new Date().toISOString(), source: "server", kind: "test", environment: "test", name: "Error", message: `message ${index}`, ...extra };
}

// Realistic student data that must never reach a log.
const STUDENT = {
  name: "Nethmi Silva",
  nic: "200012345678",
  oldNic: "912345678V",
  address: "12 Galle Road, Colombo 03",
  phone: "0771234567",
  landline: "011 2345678",
  guardian: "Sunil Perera",
  email: "nethmi@example.com",
  passwordHash: "$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012",
};

function assertNoStudentData(text) {
  for (const [field, value] of Object.entries(STUDENT)) {
    assert.ok(!text.includes(value), `leaked student ${field}: ${value}`);
  }
}

// A PrismaClientValidationError as Prisma 5 builds it: the message renders
// the whole query (with runtime values), and the stack starts with it.
function prismaValidationError() {
  const message = [
    "",
    "Invalid `prisma.student.create()` invocation in",
    "D:\\app\\services\\student-service.ts:230:38",
    "",
    "  227 const student = await prisma.student.create({",
    "  228   data: {",
    `  229     name: "${STUDENT.name}",`,
    `→ 230     nic: "${STUDENT.nic}",`,
    `  231     oldNic: "${STUDENT.oldNic}",`,
    `  232     address: "${STUDENT.address}",`,
    `  233     contact: "${STUDENT.phone}",`,
    `  234     home: "${STUDENT.landline}",`,
    `  235     guardianName: "${STUDENT.guardian}",`,
    `  236     email: "${STUDENT.email}",`,
    `  237     password: "${STUDENT.passwordHash}"`,
    "        }",
    "      })",
    "",
    "Unknown argument `nic`. Available options are marked with ?.",
  ].join("\n");
  const error = new Error(message);

  error.name = "PrismaClientValidationError";
  error.clientVersion = "5.22.0";
  error.stack = `PrismaClientValidationError: ${message}\n    at Rn (D:\\app\\node_modules\\@prisma\\client\\runtime\\library.js:29:1363)\n    at createStudent (D:\\app\\services\\student-service.ts:230:38)`;

  return error;
}

// ---- H1: Prisma errors ---------------------------------------------------------------

test("H1: a Prisma validation error keeps the operation and the problem, never the query's student data", () => {
  const normalized = sanitize.normalizeError(prismaValidationError());

  assert.equal(normalized.name, "PrismaClientValidationError");
  assert.equal(normalized.message, "prisma.student.create(): Unknown argument `nic`. Available options are marked with ?.");
  assert.match(normalized.stack, /^PrismaClientValidationError: prisma\.student\.create\(\): Unknown argument `nic`/);
  assert.match(normalized.stack, /at createStudent \(.*student-service\.ts:230:38\)/, "the frames are kept");
  assertNoStudentData(JSON.stringify(normalized));
});

test("H1: Prisma request errors keep their code and model / field names", () => {
  const error = new Error("\nInvalid `prisma.student.create()` invocation:\n\n\nUnique constraint failed on the fields: (`email`)");
  error.name = "PrismaClientKnownRequestError";
  error.code = "P2002";
  error.clientVersion = "5.22.0";
  error.meta = { modelName: "Student", target: ["email"], extra: STUDENT.name };

  assert.equal(
    sanitize.normalizeError(error).message,
    "P2002 prisma.student.create() model Student fields email: Unique constraint failed on the fields: (`email`)"
  );

  // Detected by shape too (code + clientVersion), whatever the name.
  const renamed = Object.assign(new Error(`data: { name: "${STUDENT.name}" }\nRecord to update not found.`), { code: "P2025", clientVersion: "5.22.0" });
  assert.equal(sanitize.normalizeError(renamed).message, "P2025: Record to update not found.");
});

test("H1: through handleRouteError, neither the API log nor the console line contains student data", async () => {
  const before = readLines("api-errors.jsonl").length;
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));

  let response;
  try {
    response = errorHandler.handleRouteError(prismaValidationError(), { request: new Request("http://localhost/api/students", { method: "POST" }) });
  } finally {
    console.error = original;
  }

  assert.equal(response.status, 500, "status unchanged");

  const logged = (await waitForLines("api-errors.jsonl", before + 1)).pop();

  assert.equal(logged.name, "PrismaClientValidationError");
  assertNoStudentData(JSON.stringify(logged));
  assert.equal(lines.length, 1);
  assertNoStudentData(lines[0]);
});

// ---- H2: origins -----------------------------------------------------------------------

function originRequest(headers) {
  return new Request("http://localhost:3000/api/client-errors", { method: "POST", headers });
}

test("H2: behind a reverse proxy that rewrites Host, the configured app URL is accepted; other sites are not", () => {
  const env = { APP_URL: "https://slclassroom.live" };
  // nginx default: Host is the upstream (localhost:3000), Origin is the public site.
  const proxied = { host: "localhost:3000", origin: "https://slclassroom.live" };

  assert.deepEqual(trust.checkReportOrigin(originRequest(proxied), env), { allowed: true });
  assert.deepEqual(trust.checkReportOrigin(originRequest(proxied), { NEXT_PUBLIC_APP_URL: "https://slclassroom.live/" }), { allowed: true });
  assert.equal(trust.checkReportOrigin(originRequest(proxied), {}).allowed, false, "without the setting it is rejected");
  assert.deepEqual(trust.checkReportOrigin(originRequest({ ...proxied, origin: "https://evil.example" }), env), {
    allowed: false,
    reason: "untrusted-origin",
    originHost: "evil.example",
  });
  assert.equal(trust.checkReportOrigin(originRequest({ ...proxied, origin: "null" }), env).allowed, false, "opaque origins");
  assert.equal(trust.checkReportOrigin(originRequest({ ...proxied, origin: "file:///x" }), env).allowed, false);
});

test("H2: same-origin requests (no proxy) still work; X-Forwarded-Host counts only behind a trusted proxy", () => {
  assert.deepEqual(trust.checkReportOrigin(originRequest({ host: "localhost:3000", origin: "http://localhost:3000" }), {}), { allowed: true });

  const forged = { host: "localhost:3000", origin: "https://evil.example", "x-forwarded-host": "evil.example" };

  assert.equal(trust.checkReportOrigin(originRequest(forged), {}).allowed, false, "a forged X-Forwarded-Host is ignored");
  assert.equal(trust.checkReportOrigin(originRequest(forged), { TRUSTED_PROXY_COUNT: "1" }).allowed, true, "set by our own proxy");

  assert.deepEqual(trust.checkReportOrigin(originRequest({ host: "localhost:3000", "sec-fetch-site": "same-site" }), {}), { allowed: false, reason: "cross-site" });
  assert.deepEqual(trust.checkReportOrigin(originRequest({ host: "localhost:3000", "sec-fetch-site": "same-origin" }), {}), { allowed: false, reason: "missing-origin" }, "Sec-Fetch-Site alone is not enough");
});

function report(body, headers = {}) {
  return clientErrorsRoute.POST(new Request("http://localhost:3000/api/client-errors", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "content-type": "text/plain;charset=UTF-8",
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ...headers,
    },
  }));
}

const baseReport = { source: "client", kind: "window-error", name: "Error", message: "boom" };

test("H2: a legitimate browser report through a Host-rewriting proxy is written; a rejected one is not", async () => {
  process.env.APP_URL = "https://slclassroom.live";
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));

  try {
    const accepted = await report({ ...baseReport, clientEventId: "feedfacecafe0001" }, { origin: "https://slclassroom.live" });
    const rejected = await report({ ...baseReport, clientEventId: "feedfacecafe0002" }, { origin: "https://evil.example" });

    assert.equal(accepted.status, 204);
    assert.equal(rejected.status, 403);

    const lines = await waitForLines("client-errors.jsonl", 1);
    await sleep(100);

    assert.ok(lines.some((line) => line.clientEventId === "feedfacecafe0001"));
    assert.ok(!readLines("client-errors.jsonl").some((line) => line.clientEventId === "feedfacecafe0002"));
    assert.equal(warnings.length, 1, "one diagnostic warning");
    assert.match(warnings[0], /^\[error-log\] rejected 1 browser error report\(s\) from untrusted origin\(s\): evil\.example\. Configured application host\(s\): slclassroom\.live\.$/);
  } finally {
    delete process.env.APP_URL;
    console.warn = originalWarn;
  }
});

test("H2: rejected-origin warnings are throttled and contain hosts only", () => {
  let now = 0;
  const warnings = [];
  const notify = trust.createOriginRejectionNotifier({ intervalMs: 600_000, now: () => now, warn: (message) => warnings.push(message), env: {} });

  notify("evil.example");
  notify("evil.example");
  notify("other.example");
  assert.equal(warnings.length, 1, "throttled");
  assert.match(warnings[0], /rejected 1 browser error report\(s\) from untrusted origin\(s\): evil\.example\. NEXT_PUBLIC_APP_URL \/ APP_URL is not set/);

  now = 600_000;
  notify("third.example");
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /rejected 3 browser error report\(s\).*evil\.example, other\.example, third\.example/);
});

// ---- Client reports: browser headers required; rejected requests use no quota ---------------

const SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// A request exactly as given: no default Origin, unlike report().
function rawReport(headers, body = { ...baseReport, message: "raw" }) {
  return clientErrorsRoute.POST(new Request("http://localhost:3000/api/client-errors", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { host: "localhost:3000", "content-type": "text/plain;charset=UTF-8", "user-agent": SAFARI_UA, ...headers },
  }));
}

async function quietly(run) {
  const originalWarn = console.warn;
  console.warn = () => undefined;

  try {
    return await run();
  } finally {
    console.warn = originalWarn;
  }
}

test("client reports: neither Origin nor Sec-Fetch-Site (curl, scripts) is refused with 403 and an empty body", async () => {
  assert.deepEqual(trust.checkReportOrigin(originRequest({ host: "localhost:3000" }), { APP_URL: "https://slclassroom.live" }), { allowed: false, reason: "missing-origin" });
  assert.deepEqual(trust.checkReportOrigin(originRequest({ host: "localhost:3000", origin: "" }), {}), { allowed: false, reason: "missing-origin" });

  const response = await rawReport({});

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "", "nothing about the reason is exposed");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("client reports: malformed, opaque and non-web Origins are refused", async () => {
  const env = { APP_URL: "https://slclassroom.live" };

  for (const origin of ["null", "not a url", "file:///etc", "chrome-extension://abcdef", "javascript:alert(1)", "https://"]) {
    assert.equal(trust.checkReportOrigin(originRequest({ host: "localhost:3000", origin }), env).allowed, false, origin);
  }

  assert.equal((await quietly(() => rawReport({ origin: "null" }))).status, 403);
});

test("client reports: cross-origin requests are refused, also with a matching Origin but a cross-site Sec-Fetch-Site", async () => {
  const env = { APP_URL: "https://slclassroom.live" };
  const check = (headers) => trust.checkReportOrigin(originRequest({ host: "localhost:3000", ...headers }), env);

  assert.deepEqual(check({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }), { allowed: false, reason: "cross-site" });
  assert.deepEqual(check({ origin: "https://evil.example" }), { allowed: false, reason: "untrusted-origin", originHost: "evil.example" });
  assert.equal(check({ origin: "https://slclassroom.live.evil.example" }).allowed, false, "a suffix is another site");
  assert.deepEqual(check({ origin: "https://meet.slclassroom.live", "sec-fetch-site": "same-site" }), { allowed: false, reason: "cross-site" });
  assert.deepEqual(check({ origin: "https://slclassroom.live", "sec-fetch-site": "cross-site" }), { allowed: false, reason: "cross-site" });
  assert.deepEqual(check({ origin: "https://slclassroom.live", "sec-fetch-site": "none" }), { allowed: false, reason: "cross-site" }, "a page's POST is never none");
  assert.deepEqual(check({ origin: "http://slclassroom.live" }), { allowed: false, reason: "untrusted-origin", originHost: "slclassroom.live" }, "the configured origin includes its scheme");
  assert.equal(check({ origin: "https://slclassroom.live:8443" }).allowed, false, "and its port");

  assert.equal((await quietly(() => rawReport({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status, 403);
});

test("client reports: a same-origin browser report is accepted, with or without Sec-Fetch-Site (older Safari)", async () => {
  const env = { APP_URL: "https://slclassroom.live" };

  assert.deepEqual(trust.checkReportOrigin(originRequest({ host: "localhost:3000", origin: "https://slclassroom.live", "sec-fetch-site": "same-origin" }), env), { allowed: true });
  assert.deepEqual(trust.checkReportOrigin(originRequest({ host: "localhost:3000", origin: "https://SLClassroom.live" }), env), { allowed: true }, "case-insensitive host");
  assert.deepEqual(trust.checkReportOrigin(originRequest({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }), {}), { allowed: true }, "reached directly");

  const modern = await rawReport({ origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }, { ...baseReport, clientEventId: "feedfacecafe0101" });
  const legacy = await rawReport({ origin: "http://localhost:3000" }, { ...baseReport, clientEventId: "feedfacecafe0102" });

  assert.equal(modern.status, 204);
  assert.equal(legacy.status, 204);

  await waitForLines("client-errors.jsonl", 1);
  await sleep(100);

  const lines = readLines("client-errors.jsonl");

  assert.ok(lines.some((line) => line.clientEventId === "feedfacecafe0101"));
  assert.ok(lines.some((line) => line.clientEventId === "feedfacecafe0102"));
});

test("client reports: a flood of rejected requests writes nothing and uses none of the quota; real reports still get through", async () => {
  await sleep(100);
  const before = readLines("client-errors.jsonl").length;
  const statuses = new Set();

  await quietly(async () => {
    // 600 rejected requests: 5x the global limit of 120 a minute.
    for (let i = 0; i < 200; i++) {
      statuses.add((await rawReport({}, { ...baseReport, message: `no headers ${i}` })).status);
      statuses.add((await rawReport({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }, { ...baseReport, message: `cross-site ${i}` })).status);
      statuses.add((await rawReport({ origin: "https://evil.example" }, { ...baseReport, message: `bad origin ${i}` })).status);
    }
  });

  assert.deepEqual([...statuses], [403], "never 429: rejection happens before the rate limits");

  const genuine = await rawReport({ origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }, { ...baseReport, clientEventId: "feedfacecafe0103" });

  assert.equal(genuine.status, 204);

  await waitForLines("client-errors.jsonl", before + 1);
  await sleep(100);

  const lines = readLines("client-errors.jsonl");

  assert.equal(lines.length, before + 1, "only the genuine report was written");
  assert.equal(lines[lines.length - 1].clientEventId, "feedfacecafe0103");
});

test("client reports: a script copying the browser headers is held to its own 20 a minute behind a trusted proxy; other users still report", async () => {
  process.env.TRUSTED_PROXY_COUNT = "1";

  try {
    const statuses = [];

    for (let i = 0; i < 25; i++) {
      // Forged first X-Forwarded-For entries and X-Real-IP; the proxy-appended address stays the same.
      statuses.push((await rawReport(
        { origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-forwarded-for": `10.9.9.${i}, 198.51.100.66`, "x-real-ip": `10.8.8.${i}` },
        { ...baseReport, message: `forged ${i}` },
      )).status);
    }

    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(204));
    assert.deepEqual(statuses.slice(20), Array(5).fill(429));

    const other = await rawReport(
      { origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.67" },
      { ...baseReport, clientEventId: "feedfacecafe0104" },
    );

    assert.equal(other.status, 204, "another user is unaffected");
  } finally {
    delete process.env.TRUSTED_PROXY_COUNT;
  }
});

// ---- M1: client identity, limits, byte budget ---------------------------------------------

test("M1: the client address comes from the trusted proxy's hop, never the client-supplied first entry", () => {
  const request = (headers) => new Request("http://localhost/x", { headers });

  assert.equal(trust.clientKey(request({ "x-forwarded-for": "1.2.3.4" }), {}), null, "no trusted proxy: no identity");
  assert.equal(trust.clientKey(request({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }), { TRUSTED_PROXY_COUNT: "1" }), "198.51.100.7");
  assert.equal(trust.clientKey(request({ "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.2" }), { TRUSTED_PROXY_COUNT: "2" }), "198.51.100.7");
  assert.equal(trust.clientKey(request({ "x-real-ip": "198.51.100.9" }), { TRUSTED_PROXY_COUNT: "1" }), null, "X-Real-IP is client-settable: never used");
  assert.equal(trust.clientKey(request({ "x-forwarded-for": "198.51.100.7" }), { TRUSTED_PROXY_COUNT: "2" }), null, "fewer hops than trusted proxies");
  assert.equal(trust.clientKey(request({ "x-forwarded-for": "not-an-ip<script>" }), { TRUSTED_PROXY_COUNT: "1" }), null);
});

test("M1: a per-file byte budget per minute; dropped entries are counted and summarized", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slc-sink-"));
  let now = 0;
  const sink = sinkModule.createFileSink({ dir, maxBytes: 10 * 1024 * 1024, maxFiles: 2, bytesPerMinute: 2000, now: () => now });

  for (let i = 0; i < 40; i++) {
    await sink.write("client", entry(i, { message: "m".repeat(100) }));
  }

  const written = fs.readFileSync(path.join(dir, "client-errors.jsonl"), "utf8").trim().split("\n");
  const dropped = sink.dropped("client");

  assert.ok(Buffer.byteLength(written.join("\n")) <= 2000);
  assert.equal(written.length + dropped.budget, 40);
  assert.ok(dropped.budget > 25);

  now = 60_000;
  await sink.write("client", entry(99));

  const after = fs.readFileSync(path.join(dir, "client-errors.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const summary = after[after.length - 2];

  assert.equal(summary.kind, "log-entries-dropped");
  assert.match(summary.message, new RegExp(`^${dropped.budget} error log entries were dropped`));
  assert.equal(after[after.length - 1].id, "id-99");
  assert.deepEqual(sink.dropped("client"), { queueFull: 0, budget: 0 });
  assert.equal(sinkModule.resolveFileSinkOptions({}).bytesPerMinute, 1024 * 1024);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- L3: bounded queue ---------------------------------------------------------------------

test("L3: at most maxPending entries wait per file; the rest are dropped and counted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slc-sink-"));
  const sink = sinkModule.createFileSink({ dir, maxBytes: 10 * 1024 * 1024, maxFiles: 2, maxPending: 3 });

  // Not awaited: all queued at once.
  for (let i = 0; i < 10; i++) void sink.write("server", entry(i));
  await sink.flush();

  assert.equal(fs.readFileSync(path.join(dir, "server-errors.jsonl"), "utf8").trim().split("\n").length, 3);
  assert.deepEqual(sink.dropped("server"), { queueFull: 7, budget: 0 });

  await sink.write("server", entry(10));
  const last = fs.readFileSync(path.join(dir, "server-errors.jsonl"), "utf8").trim().split("\n").slice(-2).map((line) => JSON.parse(line));
  assert.match(last[0].message, /^7 error log entries were dropped \(write queue full: 7/);
  assert.equal(last[1].id, "id-10");
  assert.equal(sinkModule.resolveFileSinkOptions({}).maxPending, 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- M2: performance -------------------------------------------------------------------------

test("M2: hostile input is sanitized in linear time (1 MB inputs, bounded to the field limit)", () => {
  const inputs = {
    "word run": "a".repeat(1_000_000),
    "dotted run": "a.".repeat(500_000),
    "many @": "a@".repeat(500_000),
    "path run": "/" + "a/".repeat(500_000),
    "url run": "http://" + "a".repeat(1_000_000),
    "key + spaces": "password" + " ".repeat(1_000_000),
    digits: "0".repeat(1_000_000),
  };

  for (const [label, value] of Object.entries(inputs)) {
    const started = process.hrtime.bigint();
    const out = sanitize.scrubText(value, 8000);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.ok(out.length <= 8000, label);
    assert.ok(ms < 50, `${label}: ${ms.toFixed(1)} ms`);
  }

  // The case the review measured at 204 ms (a 12,000-character run), now at full field size.
  for (const n of [12_000, 1_000_000]) {
    const started = process.hrtime.bigint();
    sanitize.normalizeError(Object.assign(new Error("x".repeat(n)), { stack: "y".repeat(n) }));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.ok(ms < 100, `${n}: ${ms.toFixed(1)} ms`);
  }
});

// ---- M3: sanitizer gaps ----------------------------------------------------------------------

test("M3: every gap from the review is now redacted", () => {
  const scrub = (text) => sanitize.scrubText(text, 4000);

  assert.equal(scrub("GET /api/sessions/abc/join-info?studentId=11111111-2222&role=student failed"), "GET /api/sessions/abc/join-info?[query] failed", "relative URL query");
  assert.equal(scrub("fetch(/session/join?invite=x&studentId=y) failed"), "fetch(/session/join?[query]) failed");
  assert.equal(scrub("cookie: sl_session=S1; sl_csrf=S2; theme=dark\nnext line"), "cookie: [REDACTED]\nnext line", "every cookie, to the end of the line");
  assert.equal(scrub("Set-Cookie: a=S1; HttpOnly"), "Set-Cookie: [REDACTED]");
  assert.equal(scrub(`NIC ${STUDENT.oldNic} and 912345678x`), "NIC [REDACTED_NIC] and [REDACTED_NIC]", "old NIC");
  assert.equal(scrub(`NIC ${STUDENT.nic}`), "NIC [REDACTED_NIC]", "new NIC");
  assert.equal(scrub(`home ${STUDENT.landline}, office 0112345678, Kandy 081 234 5678`), "home [REDACTED_PHONE], office [REDACTED_PHONE], Kandy [REDACTED_PHONE]", "landlines");
  assert.equal(scrub("reset token 0123456789abcdef0123456789abcdef used"), "reset token [REDACTED_TOKEN] used", "32-character token");
  assert.equal(scrub("password is hunter2"), "password is [REDACTED]");
});

test("M3: what must stay readable stays readable", () => {
  const scrub = (text) => sanitize.scrubText(text, 4000);

  assert.equal(scrub("student 11111111-1111-4111-8111-111111111111 not found"), "student 11111111-1111-4111-8111-111111111111 not found", "UUIDs kept");
  assert.equal(scrub("digest 2210434325 at 1730518800000"), "digest 2210434325 at 1730518800000", "digests and timestamps kept");
  assert.equal(scrub("useTeacherDepartureSignalHeartbeatCallback failed"), "useTeacherDepartureSignalHeartbeatCallback failed", "long names without digits kept");
  assert.equal(scrub("at https://x.com/_next/static/chunks/page-3289a3190508f76c.js:1:200"), "at https://x.com/_next/static/chunks/page-3289a3190508f76c.js:1:200");
});

// ---- L5: control characters ------------------------------------------------------------------

test("L5: terminal control characters and direction overrides are removed; tab and newline kept", () => {
  assert.equal(
    sanitize.scrubText("bad \u001b[31mred\u001b[0m\r\u0007 text\u202Eevil\u2066 \ttab\nline", 200),
    "bad [31mred[0m textevil \ttab\nline"
  );
});

// ---- M5: storage check -----------------------------------------------------------------------

test("M5: the storage check warns without creating or changing anything", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "slc-storage-"));
  const missing = path.join(base, "var", "log", "slclassroom", "errors");

  const unset = await sinkModule.checkErrorLogStorage({ NODE_ENV: "production" });
  assert.equal(unset.configured, false);
  assert.match(unset.warnings[0], /^ERROR_LOG_DIR is not set/);

  const ok = await sinkModule.checkErrorLogStorage({ NODE_ENV: "production", ERROR_LOG_DIR: base });
  assert.deepEqual([ok.status, ok.warnings], ["writable", []]);

  const notYet = await sinkModule.checkErrorLogStorage({ NODE_ENV: "production", ERROR_LOG_DIR: missing });
  assert.equal(notYet.status, "missing");
  assert.equal(fs.existsSync(path.join(base, "var")), false, "nothing was created");

  const file = path.join(base, "a-file");
  fs.writeFileSync(file, "x");
  assert.equal((await sinkModule.checkErrorLogStorage({ NODE_ENV: "production", ERROR_LOG_DIR: file })).status, "not-a-directory");
  assert.equal((await sinkModule.checkErrorLogStorage({ NODE_ENV: "production", ERROR_LOG_DIR: path.join(file, "sub") })).status, "not-writable");
  assert.equal((await sinkModule.checkErrorLogStorage({ ERROR_LOG_DISABLED: "1" })).status, "disabled");

  fs.rmSync(base, { recursive: true, force: true });
});

test("M5: the start-up report prints each warning once, and where the logs go", async () => {
  const output = { info: [], warn: [] };
  const sink = { info: (m) => output.info.push(m), warn: (m) => output.warn.push(m) };

  await serverLogger.reportErrorLogStorageOnce(async () => ({ dir: "/app/logs/errors", configured: false, status: "writable", warnings: ["ERROR_LOG_DIR is not set: …"] }), sink);
  await serverLogger.reportErrorLogStorageOnce(async () => ({ dir: "x", configured: true, status: "writable", warnings: ["again"] }), sink);

  assert.deepEqual(output.warn, ["[error-log] WARNING: ERROR_LOG_DIR is not set: …"]);
  assert.deepEqual(output.info, ["[error-log] error logs: /app/logs/errors"]);
});

// ---- L7: Try again -----------------------------------------------------------------------------

test("L7: Try again refreshes the server data and resets the boundary in one transition", () => {
  const source = fs.readFileSync(path.join(root, "app/error.tsx"), "utf8");

  assert.match(source, /startTransition\(\(\) => \{\s*router\.refresh\(\);\s*reset\(\);\s*\}\);/);
  assert.match(source, /onClick=\{tryAgain\}/);
  assert.doesNotMatch(source, /onClick=\{reset\}/);
});

// ---- L8: console summaries -------------------------------------------------------------------

test("L8: route errors print one sanitized line pointing to the log entry, never the raw error", () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args);

  try {
    errorHandler.handleRouteError(new Error(`db failed for ${STUDENT.email} password=hunter2 Bearer abc123SECRETabc123SECRET`), {
      request: new Request("http://localhost/api/students"),
    });
  } finally {
    console.error = original;
  }

  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 1, "a single string, not the error object");
  assert.match(lines[0][0], /^Unhandled route error: Error: db failed for \[REDACTED_EMAIL\] password=\[REDACTED\] Bearer \[REDACTED\] \(error log [0-9a-f-]{36}\)$/);
  assert.equal(sanitize.summarizeError(prismaValidationError()), "PrismaClientValidationError: prisma.student.create(): Unknown argument `nic`. Available options are marked with ?.");
});

// ---- API coverage --------------------------------------------------------------------------------

const COVERED_ROUTES = [
  "Grade/route.ts",
  "students/[id]/resetpassword/route.ts",
  "students/import/route.ts",
  "teacher/profile/check-slug/route.ts",
  "teacher/master/districts/route.ts",
  "teacher/master/mediums/route.ts",
  "teacher/master/subjects/route.ts",
  "student/Profile/[StudentId]/route.ts",
  "student/Profile/[StudentId]/attendance/route.ts",
  "student/Profile/[StudentId]/attendance/[classId]/route.ts",
  "student/Profile/[StudentId]/attendance/analytics/route.ts",
  "student/Profile/[StudentId]/classes/route.ts",
  "student/Profile/[StudentId]/payments/route.ts",
  "student/Profile/[StudentId]/quizzes/route.ts",
  "student/Profile/[StudentId]/quizzes/[classId]/route.ts",
  "student/Profile/[StudentId]/quizzes/analytics/route.ts",
];

test("coverage: the 16 added routes report from their catch block and no longer print the raw error", () => {
  for (const rel of COVERED_ROUTES) {
    const source = fs.readFileSync(path.join(root, "app/api", rel), "utf8");

    assert.match(source, /import \{ (developmentOnly, )?reportRouteError \} from "@\/lib\/error-handler";/, rel);
    assert.equal((source.match(/reportRouteError\(error, \{ request(, statusCode: \d{3})? \}\);/g) ?? []).length, 1, rel);
    assert.doesNotMatch(source, /console\.error\(error\)/, rel);
  }
});

test("coverage: reportRouteError logs unexpected errors as route-catch, skips AppError, returns nothing", async () => {
  await sleep(200); // earlier tests' writes land first
  const before = readLines("api-errors.jsonl").length;

  quietConsole(() => {
    assert.equal(errorHandler.reportRouteError(new errorHandler.AppError("Student is already confirmed.", 400)), undefined);
    assert.equal(errorHandler.reportRouteError(new Error("districts table missing"), { request: new Request("http://localhost/api/teacher/master/districts") }), undefined);
  });

  const lines = await waitForLines("api-errors.jsonl", before + 1);

  await sleep(200);
  assert.equal(readLines("api-errors.jsonl").length, before + 1, "the AppError was not logged");
  assert.equal(lines[lines.length - 1].kind, "route-catch");
  assert.equal(lines[lines.length - 1].route, "/api/teacher/master/districts");
});

// ---- Hardening, phase 1: request context, status codes, production 500s, console limit ----------

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Records entries instead of writing files; `write` can be replaced to simulate a stalled or failing disk.
function memorySink(write) {
  const writes = [];

  return {
    writes,
    options: { dir: "", maxBytes: 0, maxFiles: 0 },
    write:
      write ??
      ((channel, logged) => {
        writes.push({ channel, entry: logged });
        return Promise.resolve();
      }),
    writeSync(channel, logged) {
      writes.push({ channel, entry: logged });
    },
    flush: () => Promise.resolve(),
    dropped: () => ({ queueFull: 0, budget: 0 }),
  };
}

// Runs fn with a sink, a fresh console limit and console.error captured; restores everything.
async function withLogging(sink, fn, now) {
  const consoleLines = [];
  const original = console.error;

  serverLogger.setErrorLogSinkForTests(sink);
  errorHandler.resetRouteErrorConsoleForTests(now);
  console.error = (...args) => consoleLines.push(args.join(" "));

  try {
    return await fn(consoleLines);
  } finally {
    console.error = original;
    serverLogger.setErrorLogSinkForTests(null);
    errorHandler.resetRouteErrorConsoleForTests();
  }
}

async function withNodeEnv(value, fn) {
  const original = process.env.NODE_ENV;

  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;

  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
}

test("phase 1: route, method and User-Agent come from the supplied Request; no Next.js request-scope APIs", async () => {
  const sink = memorySink();

  await withLogging(sink, () => {
    const request = new Request("http://localhost/api/classes/11111111-1111-4111-8111-111111111111/students?token=abc123SECRET", {
      method: "DELETE",
      headers: { "user-agent": IPHONE_UA },
    });

    errorHandler.handleRouteError(new Error("delete failed"), { request });
  });

  const [{ channel, entry: logged }] = sink.writes;

  assert.equal(channel, "api");
  assert.equal(logged.route, "/api/classes/11111111-1111-4111-8111-111111111111/students", "path only, no query string");
  assert.equal(logged.method, "DELETE");
  assert.equal(logged.browser, "Mobile Safari 17.5");
  assert.equal(logged.deviceType, "mobile");

  const source = fs.readFileSync(path.join(root, "lib/error-logging/server-logger.ts"), "utf8");

  assert.doesNotMatch(source, /static-generation-async-storage|staticGenerationAsyncStorage/);
  assert.doesNotMatch(source, /from "next\/headers"/);

  // No request (the process monitor): no route, method or browser, and no guessing.
  const bare = serverLogger.buildErrorLogEntry(new Error("x"), { source: "server", kind: "unhandled-rejection" });

  assert.equal(bare.route, undefined);
  assert.equal(bare.method, undefined);
  assert.equal(bare.browser, undefined);
});

test("phase 1: a Request whose url, headers or method cannot be read still logs, and the response is unchanged", async () => {
  const sink = memorySink();
  const hostile = {
    get url() {
      throw new Error("url unavailable");
    },
    get headers() {
      throw new Error("headers unavailable");
    },
    get method() {
      throw new Error("method unavailable");
    },
  };

  const response = await withLogging(sink, () => errorHandler.handleRouteError(new Error("boom"), { request: hostile }));

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "INTERNAL_SERVER_ERROR");
  assert.equal(sink.writes.length, 1, "the entry is still written");
  assert.equal(sink.writes[0].entry.route, undefined);
  assert.equal(sink.writes[0].entry.method, undefined);
});

test("phase 1: the log records the status the route actually responds with", async () => {
  const sink = memorySink();
  const request = () => new Request("http://localhost/api/teacher/master/districts");

  await withLogging(sink, () => {
    assert.equal(errorHandler.reportRouteError(new Error("districts table missing"), { request: request(), statusCode: 400 }), undefined);
    errorHandler.reportRouteError(new Error("no status given"), { request: request() });
    errorHandler.reportRouteError(new Error("nonsense status"), { request: request(), statusCode: 42 });
    errorHandler.reportRouteError(new errorHandler.AppError("Expected.", 409), { request: request(), statusCode: 409 });
    errorHandler.handleRouteError(new Error("unexpected"), { request: request() });
  });

  assert.deepEqual(
    sink.writes.map(({ entry: logged }) => [logged.kind, logged.statusCode]),
    [
      ["route-catch", 400],
      ["route-catch", 500],
      ["route-catch", 500],
      ["unhandled-route-error", 500],
    ],
    "AppError is still not logged"
  );
});

test("phase 1: production 500s never expose the raw message, stack or paths; the log keeps them (sanitized)", async () => {
  const sink = memorySink();
  const internal = new Error("connect ECONNREFUSED 10.0.0.5:5432 while reading /srv/slclassroom/.env");
  internal.stack = `${internal.message}\n    at connect (/srv/slclassroom/.next/server/chunks/8123.js:1:48211)`;

  const responses = await withNodeEnv("production", () =>
    withLogging(sink, () => [
      errorHandler.handleRouteError(internal, { request: new Request("http://localhost/api/students", { method: "POST" }) }),
      errorHandler.handleRouteError("a thrown string with /srv/slclassroom/secret", { request: new Request("http://localhost/api/x") }),
    ])
  );

  for (const response of responses) {
    assert.equal(response.status, 500);

    const text = await response.text();

    assert.deepEqual(JSON.parse(text), {
      success: false,
      error: { message: errorHandler.INTERNAL_ERROR_MESSAGE, code: "INTERNAL_SERVER_ERROR" },
    });
    assert.doesNotMatch(text, /ECONNREFUSED|\/srv|\.env|chunks|\bat\b/);
  }

  assert.match(sink.writes[0].entry.message, /ECONNREFUSED/, "diagnostics stay in the error log");
  assert.match(sink.writes[0].entry.stack, /chunks\/8123\.js:1:48211/);
});

test("phase 1: AppError and INVALID_JSON responses are identical in production and development", async () => {
  const request = () => new Request("http://localhost/api/students/1", { method: "PATCH" });
  const bodies = {};

  for (const env of ["production", "development"]) {
    bodies[env] = await withNodeEnv(env, () =>
      withLogging(memorySink(), async () => {
        const appError = errorHandler.handleRouteError(
          new errorHandler.AppError("Student is already confirmed.", 409, "ALREADY_CONFIRMED", { field: "status" }),
          { request: request() }
        );
        const invalidJson = errorHandler.handleRouteError(new SyntaxError("Unexpected token } in JSON"), { request: request() });

        return [appError.status, await appError.json(), invalidJson.status, await invalidJson.json()];
      })
    );
  }

  assert.deepEqual(bodies.production, [
    409,
    { success: false, error: { message: "Student is already confirmed.", code: "ALREADY_CONFIRMED", details: { field: "status" } } },
    400,
    { success: false, error: { message: "Invalid JSON payload.", code: "INVALID_JSON" } },
  ]);
  assert.deepEqual(bodies.development, bodies.production);
});

test("phase 1: development (and an unset NODE_ENV) keeps the raw message in the 500 for diagnosis", async () => {
  for (const env of ["development", undefined]) {
    const response = await withNodeEnv(env, () =>
      withLogging(memorySink(), () =>
        errorHandler.handleRouteError(new Error('column "grade" does not exist'), { request: new Request("http://localhost/api/Grade") })
      )
    );

    assert.deepEqual(await response.json(), {
      success: false,
      error: { message: 'column "grade" does not exist', code: "INTERNAL_SERVER_ERROR" },
    });
  }
});

test("phase 1: an error burst prints a bounded number of console lines; every error still reaches the log, normalized once", async () => {
  let now = 1_000_000;
  const sink = memorySink();
  let stackReads = 0;

  const burstError = (index) => {
    const error = new Error(`burst ${index}`);

    Object.defineProperty(error, "stack", {
      get() {
        stackReads += 1;
        return `Error: burst ${index}\n    at handler (/srv/app/.next/server/app/api/x/route.js:1:100)`;
      },
    });

    return error;
  };

  await withLogging(
    sink,
    (consoleLines) => {
      for (let i = 0; i < 1000; i++) {
        errorHandler.handleRouteError(burstError(i), { request: new Request("http://localhost/api/x") });
      }

      assert.equal(consoleLines.length, errorHandler.ROUTE_ERROR_CONSOLE_LINES_PER_MINUTE);
      assert.equal(sink.writes.length, 1000, "file logging is not limited by the console limit");
      assert.equal(stackReads, 1000, "one normalization per error, printed or not");

      const skipped = 1000 - errorHandler.ROUTE_ERROR_CONSOLE_LINES_PER_MINUTE;

      now += 60_000;
      errorHandler.reportRouteError(burstError(1000), { request: new Request("http://localhost/api/x") });
      assert.match(
        consoleLines.at(-1),
        new RegExp(`^Route error: Error: burst 1000 \\(error log [0-9a-f-]{36}\\) \\[${skipped} earlier route error line\\(s\\) not printed`)
      );

      errorHandler.handleRouteError(burstError(1001), { request: new Request("http://localhost/api/x") });
      assert.match(consoleLines.at(-1), /^Unhandled route error: Error: burst 1001 \(error log [0-9a-f-]{36}\)$/, "the count is reported once");
    },
    () => now
  );
});

test("phase 1: a stalled or throwing log sink never delays or changes the response", async () => {
  const request = () => new Request("http://localhost/api/students", { method: "POST" });
  const expected = await withLogging(memorySink(), () => errorHandler.handleRouteError(new Error("same error"), { request: request() }).json());

  // A disk that never answers: the response is returned synchronously anyway.
  const stalled = memorySink(() => new Promise(() => undefined));
  const started = Date.now();
  const stalledResponse = await withLogging(stalled, () => errorHandler.handleRouteError(new Error("same error"), { request: request() }));

  assert.ok(stalledResponse instanceof Response, "not a promise: nothing is awaited");
  assert.ok(Date.now() - started < 1000);
  assert.equal(stalledResponse.status, 500);
  assert.deepEqual(await stalledResponse.json(), expected);

  // A sink that throws: same response, and the console line does not point to an entry that was never written.
  const throwing = memorySink(() => {
    throw new Error("EIO");
  });

  await withLogging(throwing, async (consoleLines) => {
    const response = errorHandler.handleRouteError(new Error("same error"), { request: request() });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), expected);
    assert.equal(errorHandler.reportRouteError(new Error("same error"), { request: request(), statusCode: 400 }), undefined);
    assert.ok(consoleLines.some((line) => line.startsWith("Unhandled route error: Error: same error") && !line.includes("(error log")));
  });
});

test("phase 1: a disk write failure is isolated from the response, and logging resumes once the disk is writable", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "slc-disk-fail-"));
  const dir = path.join(base, "errors");

  // The log directory's path is taken by a file: every write fails.
  fs.writeFileSync(dir, "not a directory");

  const sink = sinkModule.createFileSink({ dir, maxBytes: 1024 * 1024, maxFiles: 2 });

  await withLogging(sink, async (consoleLines) => {
    const response = errorHandler.handleRouteError(new Error("first, while the disk fails"), {
      request: new Request("http://localhost/api/students", { method: "POST" }),
    });

    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "INTERNAL_SERVER_ERROR");
    await sink.flush(); // settles: a failed write never rejects

    const failures = consoleLines.filter((line) => line.startsWith("[error-log] could not write"));

    assert.ok(failures.length <= 1, "write failures are throttled");
    assert.ok(failures.every((line) => !line.includes("first, while the disk fails")), "never the entry itself");

    // The problem is fixed: the next entry creates the directory and is written.
    fs.rmSync(dir, { force: true });
    errorHandler.handleRouteError(new Error("second, disk writable again"), {
      request: new Request("http://localhost/api/students", { method: "POST" }),
    });
    await sink.flush();
  });

  const written = fs.readFileSync(path.join(dir, "api-errors.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(written.map((logged) => logged.message), ["second, disk writable again"]);
  assert.equal(written[0].method, "POST");
  fs.rmSync(base, { recursive: true, force: true });
});

// ---- Hardening, phase 2: every API route passes its request ---------------------------------------

const ts = require("typescript");

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function apiRouteSources(dir = path.join(root, "app/api"), out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);

    if (item.isDirectory()) apiRouteSources(full, out);
    else if (/\.tsx?$/.test(item.name)) out.push(full);
  }

  return out;
}

// Every handleRouteError / reportRouteError call in app/api (commented-out code is not code: the AST skips it).
function routeErrorCalls() {
  const calls = [];

  for (const file of apiRouteSources()) {
    const text = fs.readFileSync(file, "utf8");

    if (!/(handle|report)RouteError\(/.test(text)) continue;

    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = path.relative(root, file).split(path.sep).join("/");

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^(handle|report)RouteError$/.test(node.expression.text)) {
        let handler = node.parent;

        while (handler && !ts.isFunctionLike(handler)) handler = handler.parent;

        let catchClause = node.parent;

        while (catchClause && !ts.isCatchClause(catchClause) && !ts.isFunctionLike(catchClause)) catchClause = catchClause.parent;

        calls.push({
          where: `${rel}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`,
          rel,
          sourceFile,
          name: node.expression.text,
          node,
          handler,
          catchClause: catchClause && ts.isCatchClause(catchClause) ? catchClause : null,
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return calls;
}

function contextProperty(call, name) {
  const context = call.node.arguments[1];

  if (!context || !ts.isObjectLiteralExpression(context)) return undefined;

  return context.properties.find((property) => property.name && ts.isIdentifier(property.name) && property.name.text === name);
}

test("phase 2: every API route call passes its own incoming Request, never a fabricated one", () => {
  const calls = routeErrorCalls();

  assert.ok(calls.length >= 250, `found ${calls.length} calls`);

  for (const call of calls) {
    assert.equal(call.node.arguments.length, 2, `${call.where}: no context`);

    const requestProperty = contextProperty(call, "request");

    assert.ok(requestProperty, `${call.where}: the context has no request`);

    const value = ts.isShorthandPropertyAssignment(requestProperty) ? requestProperty.name : requestProperty.initializer;

    assert.ok(ts.isIdentifier(value), `${call.where}: request must be the handler's variable, not ${value.getText(call.sourceFile)}`);

    // Directly in an exported route handler, whose first parameter is the request.
    const handler = call.handler;
    const exported = ts.isFunctionDeclaration(handler) && (ts.getModifiers(handler) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

    assert.ok(exported && HTTP_METHODS.has(handler.name.text), `${call.where}: not directly in an exported route handler`);

    const first = handler.parameters[0];

    assert.equal(value.text, first.name.text, `${call.where}: passes ${value.text}, the handler's request is ${first.name.text}`);
    assert.match(first.type.getText(call.sourceFile), /^(Next)?Request$/, `${call.where}: the first parameter is not a Request`);
  }
});

test("phase 2: reportRouteError records the status its catch block actually responds with", () => {
  const calls = routeErrorCalls().filter((call) => call.name === "reportRouteError");
  const recorded = {};

  assert.ok(calls.length >= 16);

  for (const call of calls) {
    assert.ok(call.catchClause, `${call.where}: not in a catch block`);

    const statuses = new Set();
    const visit = (node) => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "status" && ts.isNumericLiteral(node.initializer)) {
        statuses.add(Number(node.initializer.text));
      }

      ts.forEachChild(node, visit);
    };

    visit(call.catchClause.block);
    assert.equal(statuses.size, 1, `${call.where}: expected one response status, found ${[...statuses]}`);

    const statusProperty = contextProperty(call, "statusCode");
    const logged = statusProperty ? Number(statusProperty.initializer.getText(call.sourceFile)) : 500;

    assert.equal(logged, [...statuses][0], `${call.where}: logs ${logged}, responds ${[...statuses][0]}`);
    recorded[call.rel] = logged;
  }

  assert.equal(recorded["app/api/Grade/route.ts"], 500);
  assert.equal(recorded["app/api/teacher/master/districts/route.ts"], 400);
  assert.equal(recorded["app/api/teacher/master/mediums/route.ts"], 400);
  assert.equal(recorded["app/api/teacher/master/subjects/route.ts"], 400);
});

test("phase 2: the static GET routes use their new request parameter only for the error log", () => {
  // Reading request.url / headers in the success path would make these routes dynamic (Next.js 14.2).
  const STATIC_GETS = [
    "app/api/Grade/route.ts",
    "app/api/health/route.ts",
    "app/api/teacher/master/districts/route.ts",
    "app/api/teacher/master/mediums/route.ts",
    "app/api/teacher/master/subjects/route.ts",
  ];

  for (const rel of STATIC_GETS) {
    const sourceFile = ts.createSourceFile(rel, fs.readFileSync(path.join(root, rel), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const uses = [];

    const visit = (node) => {
      if (ts.isIdentifier(node) && node.text === "request" && !ts.isParameter(node.parent)) {
        let n = node.parent;

        while (n && !ts.isCallExpression(n)) n = n.parent;
        uses.push(n && ts.isIdentifier(n.expression) ? n.expression.text : "outside a call");
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    assert.ok(uses.length >= 1, `${rel}: request not passed to the error handler`);
    assert.ok(uses.every((use) => use === "handleRouteError" || use === "reportRouteError"), `${rel}: request used by ${uses}`);
  }
});

// Loads a route with one module replaced (no database), and restores the module cache afterwards.
function loadRouteWithStub(routeRel, stubRequest, stubExports) {
  const stubPath = require.resolve(stubRequest);
  const routePath = require.resolve(path.join(root, routeRel));
  const saved = { stub: require.cache[stubPath], route: require.cache[routePath] };

  require.cache[stubPath] = { id: stubPath, filename: stubPath, loaded: true, exports: stubExports, children: [], paths: [] };
  delete require.cache[routePath];

  try {
    return require(routePath);
  } finally {
    for (const [file, cached] of [[stubPath, saved.stub], [routePath, saved.route]]) {
      if (cached) require.cache[file] = cached;
      else delete require.cache[file];
    }
  }
}

const DB_FAILURE = "Invalid `prisma.medium.findMany()` invocation: connect ECONNREFUSED 10.0.0.5:5432 (/srv/slclassroom/node_modules/.prisma/client)";

test("phase 2: master-data routes keep their 400 responses; production never sends the raw error message", async () => {
  const failing = () => Promise.reject(new Error(DB_FAILURE));
  const service = { getDistricts: failing, getMediums: failing, getSubjects: failing };
  const routes = {
    districts: { fixed: "Failed to load districts" },
    mediums: { fixed: "Failed to load mediums" },
    subjects: { fixed: "Failed to load subjects" },
  };

  for (const [name, { fixed }] of Object.entries(routes)) {
    const { GET } = loadRouteWithStub(`app/api/teacher/master/${name}/route.ts`, path.join(root, "services/teacher-profile-service.ts"), service);
    const sink = memorySink();
    const request = () => new Request(`http://localhost/api/teacher/master/${name}`, { headers: { "user-agent": IPHONE_UA } });

    const production = await withNodeEnv("production", () => withLogging(sink, () => GET(request())));
    const productionText = await production.text();

    assert.equal(production.status, 400, name);
    assert.deepEqual(JSON.parse(productionText), { message: fixed }, name);
    assert.doesNotMatch(productionText, /ECONNREFUSED|prisma|\/srv/, name);

    const [logged] = sink.writes.map(({ entry: logged }) => logged);

    assert.equal(logged.statusCode, 400, name);
    assert.equal(logged.route, `/api/teacher/master/${name}`, name);
    assert.equal(logged.method, "GET", name);
    assert.equal(logged.browser, "Mobile Safari 17.5", name);

    const development = await withNodeEnv("development", () => withLogging(memorySink(), () => GET(request())));

    assert.equal(development.status, 400, name);

    // districts never sent the raw message; mediums and subjects still do in development, for diagnosis.
    assert.deepEqual(await development.json(), { message: name === "districts" ? fixed : DB_FAILURE }, name);
  }
});

test("phase 2: Grade keeps its 500 response and logs 500; the raw error object is sent in development only", async () => {
  class PrismaClient {
    constructor() {
      this.grade = { findMany: () => Promise.reject(Object.assign(new Error(DB_FAILURE), { clientVersion: "5.0.0", code: "P1001" })) };
    }
  }

  const { GET } = loadRouteWithStub("app/api/Grade/route.ts", "@prisma/client", { PrismaClient });
  const sink = memorySink();

  const production = await withNodeEnv("production", () => withLogging(sink, () => GET(new Request("http://localhost/api/Grade"))));
  const productionText = await production.text();

  assert.equal(production.status, 500);
  assert.deepEqual(JSON.parse(productionText), { message: "Failed to retrieve grades" });
  assert.doesNotMatch(productionText, /ECONNREFUSED|P1001|clientVersion|\/srv/);
  assert.equal(sink.writes[0].entry.statusCode, 500);
  assert.equal(sink.writes[0].entry.route, "/api/Grade");
  assert.equal(sink.writes[0].entry.method, "GET");

  const development = await withNodeEnv("development", () => withLogging(memorySink(), () => GET(new Request("http://localhost/api/Grade"))));
  const developmentBody = await development.json();

  assert.equal(development.status, 500);
  assert.equal(developmentBody.message, "Failed to retrieve grades");
  assert.deepEqual(developmentBody.error, { clientVersion: "5.0.0", code: "P1001" }, "the error object as before (its enumerable fields)");
});

test("phase 2: developmentOnly hides values in production only", async () => {
  assert.equal(await withNodeEnv("production", () => errorHandler.developmentOnly("raw")), undefined);
  assert.equal(await withNodeEnv("development", () => errorHandler.developmentOnly("raw")), "raw");
  assert.equal(await withNodeEnv(undefined, () => errorHandler.developmentOnly("raw")), "raw");
});
