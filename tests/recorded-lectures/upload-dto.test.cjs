/*
 * Recorded Lectures RL-3.1: upload response DTOs
 * (lib/recorded-lectures/upload-dto.ts). Rows are plain objects shaped like
 * Prisma's (bigint columns as bigint); no database.
 *
 *   node --test tests/recorded-lectures/upload-dto.test.cjs
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const D = require(path.join(root, "lib", "recorded-lectures", "upload-dto.ts"));

const NOW = Date.parse("2026-11-14T10:00:00.000Z");
const CONFIG = { chunkBytes: 8_388_608 };
const TEACHER = "0f8b4c2e-1d3a-4b5c-8d9e-0a1b2c3d4e5f";
const TOKEN = "ab".repeat(32);
const STORED = `${"cd".repeat(16)}.mp4`;

// Full rows, including every internal column the DTOs must NOT expose.
function sessionRow(overrides = {}) {
  return {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    recordedLectureId: "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    teacherId: TEACHER,
    expectedBytes: BigInt(4_000_000_000),
    receivedBytes: BigInt(16_777_216),
    chunkCount: 2,
    state: "ACTIVE",
    failureCode: null,
    leaseToken: null,
    leaseOffset: null,
    leaseBytes: null,
    leaseGrantedAt: null,
    leaseExpiresAt: null,
    expiresAt: new Date(NOW + 24 * 3600_000),
    lastActivityAt: new Date(NOW),
    createdAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW),
    endedAt: null,
    version: 7,
    ...overrides,
  };
}

function recordingRow(overrides = {}) {
  return {
    id: "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    lectureId: "c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    classId: "d1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    teacherId: TEACHER,
    title: "Algebra part 1",
    partNumber: 1,
    displayFileName: "algebra.mp4",
    mimeType: "video/mp4",
    sizeBytes: BigInt(4_000_000_000),
    storedFileName: STORED,
    durationSeconds: 3600,
    width: 1280,
    height: 720,
    videoCodec: "avc1.64001F",
    audioCodec: "mp4a.40.2",
    fragmented: false,
    state: "UPLOADING",
    failureCode: null,
    status: 0,
    deletedAt: null,
    deletedByTeacherId: null,
    purgeRequestedAt: null,
    purgedAt: null,
    createdAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW),
    readyAt: null,
    failedAt: null,
    ...overrides,
  };
}

// Nothing internal may appear anywhere in the serialized JSON, by key or by value.
function assertNoInternals(dto) {
  const json = JSON.stringify(dto); // also proves: no bigint (JSON.stringify would throw)
  for (const key of D.FORBIDDEN_DTO_KEYS) assert.ok(!json.includes(`"${key}"`), `key ${key}`);
  for (const value of [TEACHER, TOKEN, STORED, "d1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", "System/", "Teachers/", ".part", ".chunk"]) {
    assert.ok(!json.includes(value), `value ${value}`);
  }
  (function walk(value) {
    assert.notEqual(typeof value, "bigint");
    if (value && typeof value === "object") Object.values(value).forEach(walk);
  })(dto);
}

test("status DTO: exact allow-listed fields, numbers instead of bigint, ISO times", () => {
  const dto = D.buildUploadStatusDto(sessionRow(), recordingRow(), CONFIG, NOW);
  assert.deepEqual(dto, {
    uploadId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    recordingId: "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    lectureId: "c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    title: "Algebra part 1",
    partNumber: 1,
    uploadState: "ACTIVE",
    recordingState: "UPLOADING",
    expectedBytes: 4_000_000_000,
    receivedBytes: 16_777_216,
    chunkCount: 2,
    chunkBytes: 8_388_608,
    expiresAt: "2026-11-15T10:00:00.000Z",
    chunkInProgress: false,
    retryAfterSeconds: null,
    failureCode: null,
    completionStalled: false,
  });
  assertNoInternals(dto);
});

test("status DTO: a current lease shows as chunkInProgress + retryAfterSeconds, never the token", () => {
  const leased = sessionRow({
    leaseToken: TOKEN,
    leaseOffset: BigInt(16_777_216),
    leaseBytes: 8_388_608,
    leaseGrantedAt: new Date(NOW - 10_000),
    leaseExpiresAt: new Date(NOW + 290_500),
  });
  const dto = D.buildUploadStatusDto(leased, recordingRow(), CONFIG, NOW);
  assert.equal(dto.chunkInProgress, true);
  assert.equal(dto.retryAfterSeconds, 291);
  assertNoInternals(dto);

  const expired = D.buildUploadStatusDto({ ...leased, leaseExpiresAt: new Date(NOW - 1) }, recordingRow(), CONFIG, NOW);
  assert.equal(expired.chunkInProgress, false);
  assert.equal(expired.retryAfterSeconds, null);
});

test("status DTO: failure code from the session, else the recording", () => {
  const failed = D.buildUploadStatusDto(
    sessionRow({ state: "FAILED", failureCode: "MP4_NO_MOOV", endedAt: new Date(NOW) }),
    recordingRow({ state: "FAILED", failureCode: "MP4_NO_MOOV", failedAt: new Date(NOW) }),
    CONFIG,
    NOW
  );
  assert.equal(failed.failureCode, "MP4_NO_MOOV");
  const cancelled = D.buildUploadStatusDto(sessionRow({ state: "CANCELLED" }), recordingRow({ state: "FAILED", failureCode: "UPLOAD_CANCELLED" }), CONFIG, NOW);
  assert.equal(cancelled.failureCode, "UPLOAD_CANCELLED");
});

test("chunk-accepted DTO: progress numbers and completion flag", () => {
  const partial = D.buildChunkAcceptedDto(sessionRow());
  assert.deepEqual(partial, {
    uploadId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    receivedBytes: 16_777_216,
    expectedBytes: 4_000_000_000,
    chunkCount: 2,
    complete: false,
  });
  const done = D.buildChunkAcceptedDto(sessionRow({ receivedBytes: BigInt(4_000_000_000), chunkCount: 477 }));
  assert.equal(done.complete, true);
  assertNoInternals(partial);
  assertNoInternals(done);
});

test("completed-recording DTO: metadata only, no stored file name or codecs' internals", () => {
  const ready = recordingRow({ state: "READY", readyAt: new Date(NOW) });
  const dto = D.buildCompletedRecordingDto(ready);
  assert.deepEqual(dto, {
    recordingId: "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    lectureId: "c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    title: "Algebra part 1",
    partNumber: 1,
    recordingState: "READY",
    sizeBytes: 4_000_000_000,
    durationSeconds: 3600,
    width: 1280,
    height: 720,
    readyAt: "2026-11-14T10:00:00.000Z",
  });
  assertNoInternals(dto);
});

test("unsafe or invalid bigint values fail closed (no DTO is produced)", () => {
  const huge = BigInt(2) ** BigInt(53);
  assert.throws(() => D.buildUploadStatusDto(sessionRow({ receivedBytes: huge }), recordingRow(), CONFIG, NOW), {
    name: "RecordedLectureIntegerError",
  });
  assert.throws(() => D.buildChunkAcceptedDto(sessionRow({ expectedBytes: BigInt(-1) })), { name: "RecordedLectureIntegerError" });
  assert.throws(() => D.buildCompletedRecordingDto(recordingRow({ sizeBytes: 4_000_000_000 })), {
    name: "RecordedLectureIntegerError",
  }, "a number where the database gives a bigint is also refused");
});

test("assertClientSafe: rejects bigint, forbidden keys (at any depth) and non-JSON values", () => {
  assert.doesNotThrow(() => D.assertClientSafe({ a: 1, b: "x", c: null, d: [true, { e: 2 }] }));
  assert.throws(() => D.assertClientSafe({ n: BigInt(1) }), /not plain JSON/);
  assert.throws(() => D.assertClientSafe({ nested: [{ leaseToken: "x" }] }), /forbidden key "leaseToken"/);
  for (const key of D.FORBIDDEN_DTO_KEYS) assert.throws(() => D.assertClientSafe({ [key]: 1 }), /forbidden key/);
  assert.throws(() => D.assertClientSafe({ when: new Date(NOW) }), /not plain JSON/);
  assert.throws(() => D.assertClientSafe({ f() {} }), /not plain JSON/);
  assert.throws(() => D.assertClientSafe({ x: Number.NaN }), /finite/);
  assert.throws(() => D.assertClientSafe({ x: Infinity }), /finite/);
});

test("the forbidden-key list covers every internal column of the three tables", () => {
  for (const key of ["teacherId", "classId", "deletedByTeacherId", "leaseToken", "leaseOffset", "storedFileName", "sha256", "storageKey", "path"]) {
    assert.ok(D.FORBIDDEN_DTO_KEYS.includes(key), key);
  }
});
