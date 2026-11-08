/*
 * Prisma client logging must never print row data, query arguments, QR token
 * material or secrets (lib/prisma.ts + formatPrismaLogEvent /
 * describePrismaProblem in lib/error-logging/sanitize.ts).
 *
 *   npm run test:errors
 *
 * The messages below copy the exact shapes Prisma 5.22 produced against
 * PostgreSQL (captured on a throwaway database), with planted sensitive values.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const sanitize = require(path.join(root, "lib", "error-logging", "sanitize.ts"));

const NONCE = "ZLIk1ohCjU3PKkGk3WU_qSbt3A5ZsEsz3OAZ_Zf7k3Y";
const HASH = "16045c035eabbce6993890abb2273d3370e360c8f298dfdcd5fe2022f34b27c9";
const TOKEN = "q9Vb2xY7mN4kP0sL8tR3wE6uI1oA5dF2gH7jK9lZ3cX";
const SECRET = "dGhpcyBpcyBhIHZlcnkgc2VjcmV0IHN0dWRlbnQgcXIga2V5IHZhbHVl";
const NAME = "Amaya Perera";
const PHONE = "0771234567";
const EMAIL = "amaya.perera@example.test";
const SENSITIVE = [NONCE, HASH, TOKEN, SECRET, NAME, "Amaya", "Perera", PHONE, EMAIL, "secretpw", "probe-t"];

const assertClean = (text) => {
  for (const value of SENSITIVE) assert.ok(!text.includes(value), `leaked ${value} in: ${text}`);
  assert.ok(!/Failing row contains \(\w/.test(text), text);
  assert.ok(!/Some\(/.test(text), text);
};

const codeFrame = (op, line) =>
  `\nInvalid \`${op}\` invocation in\nD:\\app\\services\\student-qr-service.ts:${line}:35\n\n` +
  `  ${line - 2} const nonce = "${NONCE}";\n  ${line - 1} const secret = "${SECRET}";\n→ ${line} return ${op.replace("()", "")}(\n`;

// Engine error: CHECK violation with the full failing row in DETAIL.
const CHECK_VIOLATION =
  codeFrame("tx.studentQrToken.create()", 420) +
  String.raw`Error occurred during query execution:
ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \"StudentQrToken\" violates check constraint \"StudentQrToken_revocation_audit_check\"", severity: "ERROR", detail: Some("Failing row contains (b7fce5df-7306-4d2f-996a-aa51ad673bee, qrtest-student-1, ` +
  NONCE +
  ", " +
  HASH +
  String.raw`, REGENERATE, 2026-11-08 11:19:04.645, STUDENT, qrtest-student-1, null, STUDENT, qrtest-student-1, REGENERATE)."), column: None, hint: None }), transient: false })`;

// Engine error: unique violation with Key (...)=(...) values in DETAIL.
const UNIQUE_VIOLATION =
  String.raw`Error occurred during query execution:
ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23505", message: "duplicate key value violates unique constraint \"StudentQrToken_tokenHash_key\"", severity: "ERROR", detail: Some("Key (\"tokenHash\")=(` +
  HASH +
  String.raw`) already exists."), column: None, hint: None }), transient: false })`;

// Prisma validation error: the code frame prints the query's data.
const VALIDATION =
  "\nInvalid `prisma.student.create()` invocation in\nD:\\app\\services\\student-service.ts:17:33\n\n" +
  `→ 17 validation: () => p.student.create({\n       data: {\n         name: "${NAME}",\n         contact: "${PHONE}",\n         email: "${EMAIL}",\n         bogus: 1,\n     +   teacher: {\n     +     create: TeacherCreateWithoutStudentsInput\n       }\n     }\n   })\n\n` +
  "Unknown argument `bogus`. Available options are marked with ?.";

const RAW_UNIQUE =
  "\nInvalid `prisma.$executeRawUnsafe()` invocation:\n\n\nRaw query failed. Code: `23505`. Message: `Key (email)=(" +
  EMAIL +
  ") already exists.`";

const RAW_MULTILINE =
  "\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nRaw query failed. Code: `22P02`. Message: `ERROR: invalid input syntax for type uuid: \"" +
  NAME +
  " " +
  PHONE +
  "\"\nHINT: something about '" +
  EMAIL +
  "'`";

const KNOWN_UNIQUE =
  codeFrame("tx.studentQrToken.create()", 13) + "Unique constraint failed on the fields: (`tokenHash`)";

const FOREIGN_KEY = codeFrame("tx.studentQrToken.create()", 14) + "Foreign key constraint violated: `StudentQrToken_studentId_fkey (index)`";

test("CHECK violation: keeps SQLSTATE, relation and constraint; drops the failing row", () => {
  const line = sanitize.formatPrismaLogEvent("error", { message: CHECK_VIOLATION, target: "studentQrToken.create" });
  assert.equal(
    line,
    'prisma:error studentQrToken.create: Database error 23514: new row for relation "StudentQrToken" violates check constraint "StudentQrToken_revocation_audit_check"'
  );
  assertClean(line);
});

test("unique violation from the engine: constraint kept, key values dropped", () => {
  const line = sanitize.formatPrismaLogEvent("error", { message: UNIQUE_VIOLATION, target: "studentQrToken.update" });
  assert.equal(
    line,
    'prisma:error studentQrToken.update: Database error 23505: duplicate key value violates unique constraint "StudentQrToken_tokenHash_key"'
  );
  assertClean(line);
});

test("validation errors keep only Prisma's problem line, never the printed query data", () => {
  const line = sanitize.formatPrismaLogEvent("error", { message: VALIDATION, target: "student.create" });
  assert.equal(line, "prisma:error student.create: Unknown argument `bogus`. Available options are marked with ?.");
  assertClean(line);
});

test("raw query errors keep the code and message shape, without key values or quoted input", () => {
  const unique = sanitize.formatPrismaLogEvent("error", { message: RAW_UNIQUE, target: "$executeRawUnsafe" });
  assert.equal(unique, "prisma:error $executeRawUnsafe: Raw query failed. Code: `23505`. Message: Key (email)=(…) already exists.");
  assertClean(unique);

  const multi = sanitize.formatPrismaLogEvent("error", { message: RAW_MULTILINE, target: "$queryRawUnsafe" });
  assert.equal(multi, 'prisma:error $queryRawUnsafe: Raw query failed. Code: `22P02`. Message: invalid input syntax for type uuid: "…"');
  assertClean(multi);
});

test("Prisma known-request summaries (field / constraint names) are kept as they are", () => {
  assert.equal(
    sanitize.formatPrismaLogEvent("error", { message: KNOWN_UNIQUE, target: "studentQrToken.create" }),
    "prisma:error studentQrToken.create: Unique constraint failed on the fields: (`tokenHash`)"
  );
  assert.equal(
    sanitize.formatPrismaLogEvent("error", { message: FOREIGN_KEY, target: "studentQrToken.create" }),
    "prisma:error studentQrToken.create: Foreign key constraint violated: `StudentQrToken_studentId_fkey (index)`"
  );
});

test("missing target falls back to the operation; odd input never throws and stays bounded", () => {
  assert.equal(
    sanitize.formatPrismaLogEvent("error", { message: CHECK_VIOLATION }),
    'prisma:error tx.studentQrToken.create(): Database error 23514: new row for relation "StudentQrToken" violates check constraint "StudentQrToken_revocation_audit_check"'
  );
  for (const event of [undefined, null, 42, "text", {}, { message: 7 }, { message: "", target: "bad target!" }]) {
    const line = sanitize.formatPrismaLogEvent("error", event);
    assert.equal(line, "prisma:error: (no message)");
  }
  const huge = sanitize.formatPrismaLogEvent("warn", { message: `${"x".repeat(100000)} ${TOKEN}`, target: "a.b" });
  assert.ok(huge.length <= 400);
  assertClean(huge);
});

test("tokens, secrets, emails and phones in any remaining text are scrubbed", () => {
  const line = sanitize.formatPrismaLogEvent("warn", {
    message: `Something odd for ${EMAIL} / ${PHONE} with token ${TOKEN} and secret=${SECRET}`,
    target: "student.findMany",
  });
  assertClean(line);
});

test("thrown Prisma errors (route error logs) use the same sanitizing", () => {
  const error = Object.assign(new Error(CHECK_VIOLATION), {
    name: "PrismaClientUnknownRequestError",
    clientVersion: "5.22.0",
  });
  const normalized = sanitize.normalizeError(error);
  assert.equal(
    normalized.message,
    'tx.studentQrToken.create(): Database error 23514: new row for relation "StudentQrToken" violates check constraint "StudentQrToken_revocation_audit_check"'
  );
  assertClean(JSON.stringify(normalized));
  assertClean(sanitize.summarizeError(error));

  const raw = Object.assign(new Error(RAW_UNIQUE), { name: "PrismaClientKnownRequestError", code: "P2010", clientVersion: "5.22.0" });
  assert.equal(
    sanitize.normalizeError(raw).message,
    "P2010 prisma.$executeRawUnsafe(): Raw query failed. Code: `23505`. Message: Key (email)=(…) already exists."
  );
});

test("lib/prisma.ts emits Prisma logs as events and prints only the sanitized line", () => {
  // Fake @prisma/client to capture the client options and the $on handlers.
  const captured = { options: null, handlers: {} };
  class FakePrismaClient {
    constructor(options) {
      captured.options = options;
    }
    $on(level, handler) {
      captured.handlers[level] = handler;
    }
  }
  const prismaClientPath = require.resolve("@prisma/client", { paths: [path.join(root, "lib")] });
  const fakeModule = new Module(prismaClientPath);
  fakeModule.filename = prismaClientPath;
  fakeModule.loaded = true;
  fakeModule.exports = { PrismaClient: FakePrismaClient };
  const previous = require.cache[prismaClientPath];
  const previousGlobal = globalThis.prisma;
  require.cache[prismaClientPath] = fakeModule;
  delete globalThis.prisma;

  const errors = [];
  const warns = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  try {
    const libPrismaPath = path.join(root, "lib", "prisma.ts");
    delete require.cache[libPrismaPath];
    require(libPrismaPath);

    assert.deepEqual(captured.options.log, [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ]);
    assert.equal(typeof captured.handlers.error, "function");
    assert.equal(typeof captured.handlers.warn, "function");

    captured.handlers.error({ message: CHECK_VIOLATION, target: "studentQrToken.create", timestamp: new Date() });
    captured.handlers.error({ message: VALIDATION, target: "student.create", timestamp: new Date() });
    captured.handlers.warn({ message: `warning about ${EMAIL}`, target: "", timestamp: new Date() });
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    if (previous) require.cache[prismaClientPath] = previous;
    else delete require.cache[prismaClientPath];
    delete require.cache[path.join(root, "lib", "prisma.ts")];
    if (previousGlobal) globalThis.prisma = previousGlobal;
    else delete globalThis.prisma;
  }

  assert.equal(errors.length, 2);
  assert.equal(warns.length, 1);
  assert.match(errors[0], /^prisma:error studentQrToken\.create: Database error 23514: /);
  assert.match(errors[1], /^prisma:error student\.create: Unknown argument `bogus`/);
  for (const line of [...errors, ...warns]) assertClean(line);
});
