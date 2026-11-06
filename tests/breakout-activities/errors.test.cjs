/*
 * Breakout API error codes (lib/breakout-activities/errors.ts): one status
 * and message per code, Phase 1 module codes covered, marking errors and
 * lock timeouts normalized.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const errors = require(path.join(root, "lib/breakout-activities/errors.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));
const load = (file) => import(pathToFileURL(path.join(root, "lib/breakout-activities", file)).href);

test("every code has a valid HTTP status and a message", () => {
  for (const [code, spec] of Object.entries(errors.BREAKOUT_ERRORS)) {
    assert.match(code, /^[A-Z][A-Z0-9_]+$/, code);
    assert.ok([400, 403, 404, 409, 413].includes(spec.status), `${code}: ${spec.status}`);
    assert.ok(typeof spec.message === "string" && spec.message.length > 0, code);
  }
});

test("the session end / replacement codes are 409", () => {
  assert.equal(errors.BREAKOUT_ERRORS.BREAKOUT_EXPORT_REQUIRED.status, 409);
  assert.equal(errors.BREAKOUT_ERRORS.BREAKOUT_DATA_CHANGED.status, 409);
});

test("aligned with the approved v2 error table (and the later decisions)", () => {
  const v2 = {
    ROOM_UNKNOWN: 409,
    NOT_IN_TARGET_ROOM: 403,
    ACTIVITY_NOT_PUBLISHED: 409,
    // Approved decisions (no v2 codes for these cases):
    ACTIVITY_NOT_DRAFT: 409,
    QUIZ_NOT_SUBMITTED: 409,
    QUIZ_NOT_STARTED: 409,
    ASSIGNMENT_CLOSED: 409,
    QUIZ_CLOSED: 409,
    QUIZ_TIME_UP: 409,
    QUIZ_ALREADY_SUBMITTED: 409,
    REVISION_CONFLICT: 409,
    SUBMISSION_LIMIT_REACHED: 409,
    INVALID_PDF: 400,
    FILE_TOO_LARGE: 413,
    SESSION_NOT_ACTIVE: 409,
    BREAKOUT_DATA_CHANGED: 409,
    // v2's BREAKOUT_ACTIVITIES_PENDING, renamed by the approved decision:
    BREAKOUT_EXPORT_REQUIRED: 409,
  };
  for (const [code, status] of Object.entries(v2)) {
    assert.equal(errors.BREAKOUT_ERRORS[code]?.status, status, code);
  }
  // Replaced names must not linger as alternatives.
  for (const gone of ["BREAKOUT_ACTIVITIES_PENDING", "SESSION_ENDED", "QUIZ_TIME_EXPIRED", "FILE_EMPTY", "FILE_NOT_PDF", "INVALID_IDEMPOTENCY_KEY"]) {
    assert.equal(errors.isBreakoutErrorCode(gone), false, gone);
  }
});

test("pdf-file.ts check codes map to INVALID_PDF (400) or FILE_TOO_LARGE (413)", () => {
  const pdf = require(path.join(root, "lib/breakout-activities/pdf-file.ts"));
  const checks = [
    [pdf.validatePdfUpload(new Uint8Array(0), "application/pdf"), "INVALID_PDF", 400],
    [pdf.validatePdfUpload(Buffer.from("not a pdf"), "application/pdf"), "INVALID_PDF", 400],
    [pdf.validatePdfUpload(Buffer.from("%PDF-1.7"), "text/html"), "INVALID_PDF", 400],
    [pdf.validatePdfUpload(new Uint8Array(pdf.MAX_BREAKOUT_PDF_BYTES + 1), "application/pdf"), "FILE_TOO_LARGE", 413],
  ];
  for (const [check, code, status] of checks) {
    assert.equal(check.ok, false);
    const e = errors.pdfCheckError(check.code);
    assert.ok(e instanceof AppError);
    assert.equal(e.code, code, check.code);
    assert.equal(e.statusCode, status, check.code);
  }
});

test("breakoutError builds an AppError with the standard status, code and message", () => {
  const e = errors.breakoutError("ASSIGNMENT_CLOSED");
  assert.ok(e instanceof AppError);
  assert.equal(e.statusCode, 409);
  assert.equal(e.code, "ASSIGNMENT_CLOSED");
  assert.equal(e.message, errors.BREAKOUT_ERRORS.ASSIGNMENT_CLOSED.message);
  const custom = errors.breakoutError("VALIDATION_ERROR", "Title is required.", { field: "title" });
  assert.equal(custom.message, "Title is required.");
  assert.deepEqual(custom.details, { field: "title" });
});

test("isBreakoutErrorCode: own keys only", () => {
  assert.equal(errors.isBreakoutErrorCode("FILE_TOO_LARGE"), true);
  assert.equal(errors.isBreakoutErrorCode("toString"), false);
  assert.equal(errors.isBreakoutErrorCode("__proto__"), false);
  assert.equal(errors.isBreakoutErrorCode(42), false);
});

test("covers every API code the Phase 1 modules return or throw (pdf-file.ts codes map via pdfCheckError)", async () => {
  const rules = await load("submission-rules.mjs");
  const codes = new Set();
  // submission-rules.mjs
  codes.add(rules.planNextVersion([1, 2], 2).code);
  for (const assignmentState of ["DRAFT", "CLOSED"]) {
    codes.add(rules.decideSubmission({ assignmentState, replayFound: false, existingVersions: [] }).code);
  }
  codes.add(rules.checkSubmissionContent({ answerText: "", hasFile: false }).code);
  codes.add(rules.checkSubmissionContent({ answerText: "x".repeat(rules.MAX_ANSWER_TEXT_LENGTH + 1), hasFile: false }).code);
  // marking.mjs (BreakoutMarkingError codes, from its source)
  const fs = require("node:fs");
  const markingSource = fs.readFileSync(path.join(root, "lib/breakout-activities/marking.mjs"), "utf8");
  for (const m of markingSource.matchAll(/new BreakoutMarkingError\("([A-Z_]+)"/g)) codes.add(m[1]);

  assert.ok(codes.size >= 10, `found ${codes.size} codes`);
  for (const code of codes) assert.equal(errors.isBreakoutErrorCode(code), true, `missing ${code}`);
});

test("toBreakoutAppError: marking errors become 400 with their code", async () => {
  const { BreakoutMarkingError } = await load("marking.mjs");
  const e = errors.toBreakoutAppError(new BreakoutMarkingError("OVERRIDE_OUT_OF_RANGE", "Too high."));
  assert.ok(e instanceof AppError);
  assert.equal(e.statusCode, 400);
  assert.equal(e.code, "OVERRIDE_OUT_OF_RANGE");
  assert.equal(e.message, "Too high.");
  const unknown = errors.toBreakoutAppError(new BreakoutMarkingError("SOMETHING_NEW", "x"));
  assert.equal(unknown.code, "VALIDATION_ERROR");
  assert.equal(unknown.statusCode, 400);
});

// Real Prisma 5.22 error classes from the installed runtime (no client, no database).
const prismaRuntime = require("@prisma/client/runtime/library");
const known = (code, meta) =>
  new prismaRuntime.PrismaClientKnownRequestError(`Prisma error ${code}`, { code, clientVersion: "5.22.0", meta });
const rawFailed = (sqlstate) =>
  known("P2010", { code: sqlstate, message: `Raw query failed. Code: \`${sqlstate}\`.` });
const label = (e) => (e instanceof Error ? `${e.name} ${e.code ?? ""} ${JSON.stringify(e.meta ?? null)}` : JSON.stringify(e));

test("real Prisma errors: lock timeout, deadlock and serialization failure become 409 BREAKOUT_BUSY", () => {
  const cases = [rawFailed("55P03"), rawFailed("40P01"), rawFailed("40001"), known("P2034", undefined)];
  for (const raw of cases) {
    assert.equal(raw.name, "PrismaClientKnownRequestError");
    assert.equal(errors.isRetryableLockError(raw), true, label(raw));
    const e = errors.toBreakoutAppError(raw);
    assert.ok(e instanceof AppError);
    assert.equal(e.code, "BREAKOUT_BUSY");
    assert.equal(e.statusCode, 409);
  }
});

test("a second copy of the Prisma runtime is still recognized (matched by name)", () => {
  const copy = Object.assign(new Error("Raw query failed."), { name: "PrismaClientKnownRequestError", code: "P2010", meta: { code: "55P03" } });
  assert.equal(errors.isRetryableLockError(copy), true);
});

test("real Prisma errors that are NOT lock contention stay unchanged (500 path)", () => {
  const cases = [
    known("P2028", { error: "Transaction already closed" }), // expired / could not start
    known("P2002", { target: ["assignmentId", "studentId", "version"] }), // unique violation
    rawFailed("23505"), // raw unique violation
    rawFailed("23503"), // raw foreign-key violation
    rawFailed("57014"), // statement_timeout / query canceled
    rawFailed("25P02"), // in_failed_sql_transaction
    known("P2010", undefined), // no meta
    known("P2010", { code: 55 }), // non-string meta.code
    known("P2025", { cause: "Record not found" }),
    new prismaRuntime.PrismaClientUnknownRequestError('Error occurred during query execution: code: "55P03"', { clientVersion: "5.22.0" }),
  ];
  for (const raw of cases) {
    assert.equal(errors.isRetryableLockError(raw), false, label(raw));
    assert.equal(errors.toBreakoutAppError(raw), raw, label(raw));
  }
});

test("non-Prisma values are never classified, even with a SQLSTATE-like code", () => {
  const app = new AppError("x", 418, "TEAPOT");
  assert.equal(errors.toBreakoutAppError(app), app);
  const cases = [
    { code: "55P03" }, // bare SQLSTATE, plain object
    Object.assign(new Error("lock timeout"), { code: "55P03" }), // bare SQLSTATE on an Error
    { name: "PrismaClientKnownRequestError", code: "P2034" }, // right name, but not an Error
    { code: "P2010", meta: { code: "55P03" } }, // Prisma-like plain object
    { code: "P2034" },
    Object.assign(new Error("x"), { code: "P2034" }), // P2034 on a plain Error
    new Error("boom"),
    null,
    undefined,
    "text",
  ];
  for (const raw of cases) {
    assert.equal(errors.isRetryableLockError(raw), false, label(raw));
    assert.equal(errors.toBreakoutAppError(raw), raw);
  }
});
