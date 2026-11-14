/*
 * Recorded Lectures RL-3.1: upload error codes and mapping
 * (lib/recorded-lectures/upload-errors.ts). No database: Prisma errors are
 * plain objects with Prisma's error name and shape.
 *
 *   node --test tests/recorded-lectures/upload-errors.test.cjs
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const E = require(path.join(root, "lib", "recorded-lectures", "upload-errors.ts"));
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
const { StorageError } = require(path.join(root, "lib", "file-storage", "types.ts"));
const { MP4_REJECTION_MESSAGES } = require(path.join(root, "lib", "recorded-lectures", "mp4-inspect.ts"));
const { UploadMutexTimeoutError } = require(path.join(root, "lib", "recorded-lectures", "upload-locks.ts"));

function prismaError(code, meta) {
  const error = new Error(`Prisma error ${code}`);
  error.name = "PrismaClientKnownRequestError";
  error.code = code;
  error.meta = meta;
  return error;
}

const STORAGE_CODES = [
  "ROOT_MISSING", "ROOT_NOT_DIRECTORY", "ROOT_INSIDE_APPLICATION", "ROOT_WORLD_WRITABLE", "ROOT_NOT_WRITABLE",
  "INVALID_KEY", "INVALID_ARGUMENT", "UNSAFE_PATH", "NOT_FOUND", "ALREADY_EXISTS", "LIMIT_EXCEEDED",
  "SIZE_MISMATCH", "DEADLINE_EXCEEDED", "ABORTED", "NO_SPACE", "IO_ERROR",
];

// Anything that could reveal storage layout, files or secrets.
const LEAKS = /(System\/|Teachers\/|TemporaryUploads|\.part\b|\.chunk\b|[A-Za-z]:\\|\/var\/|\/srv\/|\/home\/|FILE_STORAGE_ROOT|lease ?token|[0-9a-f]{32})/i;

test("every error code: an HTTP status and a fixed, non-leaking message", () => {
  for (const [code, spec] of Object.entries(E.UPLOAD_ERRORS)) {
    assert.ok(Number.isInteger(spec.status) && spec.status >= 400 && spec.status <= 599, code);
    assert.ok(spec.message.length > 0, code);
    assert.doesNotMatch(spec.message, LEAKS, code);
    const error = E.uploadError(code);
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, spec.status);
    assert.equal(error.message, spec.message);
  }
});

test("approved statuses for the key cases", () => {
  const status = (code) => E.UPLOAD_ERRORS[code].status;
  assert.equal(status("UPLOAD_NOT_FOUND"), 404);
  assert.equal(status("LECTURE_NOT_FOUND"), 404);
  assert.equal(status("TEACHER_ACCOUNT_INACTIVE"), 403);
  assert.equal(status("LECTURE_NOT_ACTIVE"), 409);
  assert.equal(status("OFFSET_MISMATCH"), 409);
  assert.equal(status("CHUNK_IN_PROGRESS"), 409);
  assert.equal(status("LENGTH_REQUIRED"), 411);
  assert.equal(status("CHUNK_TOO_LARGE"), 413);
  assert.equal(status("CONTENT_TYPE_INVALID"), 415);
  assert.equal(status("UPLOAD_EXPIRED"), 410);
  assert.equal(status("MP4_REJECTED"), 422);
  assert.equal(status("INSUFFICIENT_STORAGE"), 507);
  assert.equal(status("RECORDED_LECTURES_NOT_CONFIGURED"), 503);
});

test("details are sanitized: only retryAfterSeconds, receivedBytes and an UPPER_SNAKE reason survive", () => {
  const error = E.uploadError("OFFSET_MISMATCH", {
    receivedBytes: 8_388_608,
    retryAfterSeconds: 2.2,
    reason: "OFFSET_MISMATCH",
    leaseToken: "a".repeat(64),
    path: "/srv/storage/System/TemporaryUploads/x.part",
  });
  assert.deepEqual(error.details, { retryAfterSeconds: 3, receivedBytes: 8_388_608, reason: "OFFSET_MISMATCH" });

  assert.equal(E.uploadError("UPLOAD_BUSY", { reason: "/etc/passwd" }).details, undefined);
  assert.equal(E.uploadError("UPLOAD_BUSY", { receivedBytes: -1 }).details, undefined);
  assert.equal(E.uploadError("UPLOAD_BUSY", { receivedBytes: 2 ** 53 }).details, undefined);
  assert.deepEqual(E.uploadError("UPLOAD_BUSY", { retryAfterSeconds: 0 }).details, { retryAfterSeconds: 1 });
});

test("Retry-After header: from the error's details only", () => {
  assert.equal(E.retryAfterHeader(E.uploadError("CHUNK_IN_PROGRESS", { retryAfterSeconds: 42 })), "42");
  assert.equal(E.retryAfterHeader(E.uploadError("CHUNK_IN_PROGRESS")), null);
  assert.equal(E.retryAfterHeader(new Error("x")), null);
  assert.equal(E.retryAfterHeader(null), null);
});

test("chunk header problems: every RL-1 problem maps, carrying the server's received bytes", () => {
  const problems = [
    "OFFSET_REQUIRED", "OFFSET_INVALID", "OFFSET_MISMATCH", "LENGTH_REQUIRED", "LENGTH_INVALID",
    "CHUNK_TOO_LARGE", "CHUNK_EXCEEDS_REMAINING", "UPLOAD_ALREADY_COMPLETE",
  ];
  for (const problem of problems) {
    const error = E.chunkHeaderError(problem, 16_777_216);
    assert.equal(error.code, problem);
    assert.equal(error.statusCode, E.UPLOAD_ERRORS[problem].status);
    assert.deepEqual(error.details, { receivedBytes: 16_777_216 });
  }
});

test("declaration problems: 400 with the RL-1 message and the problem as reason", () => {
  const error = E.declarationError("FILE_TOO_LARGE", "Each recording part can be at most 4 GB.");
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "UPLOAD_DECLARATION_INVALID");
  assert.equal(error.message, "Each recording part can be at most 4 GB.");
  assert.deepEqual(error.details, { reason: "FILE_TOO_LARGE" });
});

test("MP4 rejections: 422 with the RL-1 user message for every code", () => {
  for (const [code, message] of Object.entries(MP4_REJECTION_MESSAGES)) {
    const error = E.mp4RejectionError(code);
    assert.equal(error.statusCode, 422);
    assert.equal(error.code, "MP4_REJECTED");
    assert.equal(error.message, message);
    assert.deepEqual(error.details, { reason: code });
  }
});

test("StorageError: every code maps; the storage message is never passed through", () => {
  for (const code of STORAGE_CODES) {
    for (const context of ["default", "chunk-write"]) {
      const error = E.storageErrorToAppError(code, context);
      assert.ok(error instanceof AppError, `${code}/${context}`);
      assert.ok(E.UPLOAD_ERRORS[error.code], `${code}/${context}`);
      assert.notEqual(error.message, new StorageError(code).message);
      assert.doesNotMatch(error.message, LEAKS);
    }
  }
  const map = (code, context) => E.storageErrorToAppError(code, context).code;
  assert.equal(map("NO_SPACE"), "INSUFFICIENT_STORAGE");
  assert.equal(map("ROOT_MISSING"), "RECORDED_LECTURES_NOT_CONFIGURED");
  assert.equal(map("LIMIT_EXCEEDED", "chunk-write"), "CHUNK_INCOMPLETE");
  assert.equal(map("SIZE_MISMATCH", "chunk-write"), "CHUNK_INCOMPLETE");
  assert.equal(map("DEADLINE_EXCEEDED", "chunk-write"), "CHUNK_TIMEOUT");
  assert.equal(map("ABORTED", "chunk-write"), "CHUNK_ABORTED");
  // Outside a chunk write the same codes are server faults.
  assert.equal(map("SIZE_MISMATCH", "default"), "STORAGE_ERROR");
  assert.equal(map("UNSAFE_PATH", "chunk-write"), "STORAGE_ERROR");
  assert.equal(map("IO_ERROR"), "STORAGE_ERROR");
});

test("database errors: only lock timeout / deadlock / serialization / write conflict are retryable", () => {
  assert.ok(E.isRetryableDatabaseError(prismaError("P2034")));
  for (const sqlState of ["55P03", "40P01", "40001"]) assert.ok(E.isRetryableDatabaseError(prismaError("P2010", { code: sqlState })));
  assert.ok(!E.isRetryableDatabaseError(prismaError("P2010", { code: "23514" })), "CHECK violation");
  assert.ok(!E.isRetryableDatabaseError(prismaError("P2010", { code: "23505" })), "unique violation");
  assert.ok(!E.isRetryableDatabaseError(prismaError("P2028")));
  assert.ok(!E.isRetryableDatabaseError(prismaError("P2002")));
  const bare = new Error("x");
  bare.code = "55P03";
  assert.ok(!E.isRetryableDatabaseError(bare), "a bare SQLSTATE is not a Prisma shape");
  assert.ok(!E.isRetryableDatabaseError(null));
});

test("part-number conflict: P2002 on the active part-number index, both target shapes; nothing else", () => {
  assert.ok(E.isPartNumberConflict(prismaError("P2002", { target: ["lectureId", "partNumber"] })));
  assert.ok(E.isPartNumberConflict(prismaError("P2002", { target: "RecordedLecture_active_part_number_key" })));
  assert.ok(!E.isPartNumberConflict(prismaError("P2002", { target: ["leaseToken"] })));
  assert.ok(!E.isPartNumberConflict(prismaError("P2002", { target: ["uploadSessionId", "chunkIndex"] })));
  assert.ok(!E.isPartNumberConflict(prismaError("P2002", { target: "RecordingUploadChunk_leaseToken_key" })));
  assert.ok(!E.isPartNumberConflict(prismaError("P2002")));
  assert.ok(!E.isPartNumberConflict(prismaError("P2010", { code: "23505" })));
});

test("toUploadAppError: normalizes known failures, leaves unknown ones for the 500 path", () => {
  const app = E.uploadError("UPLOAD_NOT_FOUND");
  assert.equal(E.toUploadAppError(app), app);

  const storage = E.toUploadAppError(new StorageError("NO_SPACE"));
  assert.equal(storage.code, "INSUFFICIENT_STORAGE");

  const busy = E.toUploadAppError(prismaError("P2010", { code: "55P03" }));
  assert.equal(busy.code, "UPLOAD_BUSY");
  assert.equal(busy.statusCode, 503);
  assert.equal(E.retryAfterHeader(busy), "1");

  assert.equal(E.toUploadAppError(new UploadMutexTimeoutError()).code, "UPLOAD_BUSY");
  assert.equal(E.toUploadAppError(prismaError("P2002", { target: ["lectureId", "partNumber"] })).code, "PART_NUMBER_IN_USE");

  for (const unknown of [prismaError("P2010", { code: "23514" }), prismaError("P2002", { target: ["leaseToken"] }), new TypeError("bug")]) {
    assert.equal(E.toUploadAppError(unknown), unknown, "returned unchanged: 500 + logged");
  }
});
