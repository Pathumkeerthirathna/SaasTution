/*
 * Recorded Lectures RL-1: storage-key layout (lib/recorded-lectures/keys.ts)
 * and request validation (lib/recorded-lectures/validation.ts).
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const K = require(path.join(root, "lib", "recorded-lectures", "keys.ts"));
const V = require(path.join(root, "lib", "recorded-lectures", "validation.ts"));
const { isValidStorageKey } = require(path.join(root, "lib", "file-storage", "keys.ts"));
const { RECORDED_LECTURE_DEFAULTS } = require(path.join(root, "lib", "recorded-lectures", "config.ts"));

const T = "0e4714fd-256e-4eed-a142-b860e77fb0b6";
const L = "65d87fef-0f55-4b05-bda9-a8b85446f9e4";
const R = "9c6a59ee-fd5f-444b-83dd-31346d229c82";
const U = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";

// ---- Keys ---------------------------------------------------------------------------------------------

test("layout: recording, temporary upload and chunk scratch keys (relative, valid storage keys)", () => {
  const name = K.generateRecordingFileName();
  assert.match(name, /^[0-9a-f]{32}\.mp4$/);
  assert.notEqual(K.generateRecordingFileName(), name, "random");

  const key = K.recordingFileKey({ teacherId: T, lectureId: L, recordingId: R, storedName: name });
  assert.equal(key, `Teachers/${T}/Lectures/${L}/RecordedLectures/${R}/${name}`);
  assert.equal(K.recordingDirectoryKey({ teacherId: T, lectureId: L, recordingId: R }), `Teachers/${T}/Lectures/${L}/RecordedLectures/${R}`);
  assert.equal(K.uploadTempKey(U), `System/TemporaryUploads/${U}.part`);

  const token = K.generateLeaseToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(K.chunkScratchKey(U, token), `System/TemporaryUploads/${U}.${token}.chunk`);

  for (const k of [key, K.uploadTempKey(U), K.chunkScratchKey(U, token)]) {
    assert.equal(isValidStorageKey(k), true);
    assert.ok(!k.startsWith("/") && !/^[A-Za-z]:/.test(k), "relative");
  }
});

test("only generated lowercase UUIDs and names are accepted; request data can never shape a key", () => {
  const bad = ["../x", "", "abc", T.toUpperCase(), `${T}/..`, `${T} `, "00000000-0000-0000-0000-00000000000g"];
  for (const id of bad) {
    assert.throws(() => K.recordingDirectoryKey({ teacherId: id, lectureId: L, recordingId: R }), JSON.stringify(id));
    assert.throws(() => K.uploadTempKey(id));
  }
  for (const storedName of ["video.mp4", "../a.mp4", `${"a".repeat(32)}.mov`, `${"A".repeat(32)}.mp4`]) {
    assert.throws(() => K.recordingFileKey({ teacherId: T, lectureId: L, recordingId: R, storedName }));
  }
  assert.throws(() => K.chunkScratchKey(U, "short"));
  assert.throws(() => K.chunkScratchKey(U, "g".repeat(64)));
});

test("parseRecordedLectureKey: classifies only this module's keys", () => {
  const name = K.generateRecordingFileName();
  const token = K.generateLeaseToken();
  assert.deepEqual(K.parseRecordedLectureKey(K.recordingFileKey({ teacherId: T, lectureId: L, recordingId: R, storedName: name })), {
    kind: "recording", teacherId: T, lectureId: L, recordingId: R, storedName: name,
  });
  assert.deepEqual(K.parseRecordedLectureKey(K.uploadTempKey(U)), { kind: "temp", uploadId: U });
  assert.deepEqual(K.parseRecordedLectureKey(K.chunkScratchKey(U, token)), { kind: "scratch", uploadId: U, leaseToken: token });
  for (const other of [
    "lectures/x/file.pdf", `Teachers/${T}/Profile/x.jpg`, `System/TemporaryUploads/${U}.tmp`, `System/TemporaryUploads/notauuid.part`,
    `Teachers/${T}/Lectures/${L}/RecordedLectures/${R}/video.mp4`, "../escape", "",
  ]) {
    assert.equal(K.parseRecordedLectureKey(other), null, other);
  }
});

// ---- Upload declaration ----------------------------------------------------------------------------------

const CONFIG = { maxPartBytes: RECORDED_LECTURE_DEFAULTS.maxPartBytes, maxPartsPerLecture: null };
const valid = { title: "  Week 1 — Algebra  ", partNumber: 1, fileName: "C:\\Users\\x\\Lecture 1.MP4", mimeType: "video/mp4", sizeBytes: 123_456 };

test("valid declaration: trimmed title, display name without folders, size kept", () => {
  const result = V.validateUploadDeclaration(valid, CONFIG);
  assert.deepEqual(result, {
    ok: true,
    value: { title: "Week 1 — Algebra", partNumber: 1, displayFileName: "Lecture 1.mp4", mimeType: "video/mp4", sizeBytes: 123_456 },
  });
});

test("MP4 only: WebM, QuickTime, other types or names refused", () => {
  for (const mimeType of ["video/webm", "video/quicktime", "video/x-matroska", "application/octet-stream", "", undefined]) {
    assert.equal(V.validateUploadDeclaration({ ...valid, mimeType }, CONFIG).problem, "MIME_TYPE_NOT_SUPPORTED", String(mimeType));
  }
  for (const fileName of ["lecture.webm", "lecture.mov", "lecture.mp4.exe", "lecture", "", 5]) {
    assert.equal(V.validateUploadDeclaration({ ...valid, fileName }, CONFIG).problem, "FILE_NAME_INVALID", String(fileName));
  }
});

test("size: 4,000,000,000 bytes accepted, one more refused with a '4 GB' message; empty refused", () => {
  assert.equal(V.validateUploadDeclaration({ ...valid, sizeBytes: 4_000_000_000 }, CONFIG).ok, true);
  const tooBig = V.validateUploadDeclaration({ ...valid, sizeBytes: 4_000_000_001 }, CONFIG);
  assert.equal(tooBig.problem, "FILE_TOO_LARGE");
  assert.equal(tooBig.message, "Each recording part can be at most 4 GB.");
  assert.deepEqual(V.validateUploadDeclaration({ ...valid, sizeBytes: 0 }, CONFIG), {
    ok: false, problem: "FILE_EMPTY", message: "The file is empty.",
  });
});

test("RL-1.1 (L-15): negative, fractional, non-numeric or unsafe sizes get their own accurate error", () => {
  for (const sizeBytes of [-1, -4_000_000_000, 1.5, 0.1, "100", "", null, undefined, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2, true, {}]) {
    assert.deepEqual(
      V.validateUploadDeclaration({ ...valid, sizeBytes }, CONFIG),
      { ok: false, problem: "FILE_SIZE_INVALID", message: "The file size must be a whole number of bytes." },
      String(sizeBytes)
    );
  }
  // Zero is empty (not invalid), and a valid but too-large size is still FILE_TOO_LARGE.
  assert.equal(V.validateUploadDeclaration({ ...valid, sizeBytes: 0 }, CONFIG).problem, "FILE_EMPTY");
  assert.equal(V.validateUploadDeclaration({ ...valid, sizeBytes: Number.MAX_SAFE_INTEGER }, CONFIG).problem, "FILE_TOO_LARGE");
});

test("title and part number: required, bounded, no fixed part limit unless configured", () => {
  for (const title of ["", "   ", undefined, 5, "\u202E\u0007"]) {
    assert.equal(V.validateUploadDeclaration({ ...valid, title }, CONFIG).problem, "TITLE_REQUIRED", JSON.stringify(title));
  }
  assert.equal(V.validateUploadDeclaration({ ...valid, title: "x".repeat(200) }, CONFIG).ok, true);
  assert.equal(V.validateUploadDeclaration({ ...valid, title: "x".repeat(201) }, CONFIG).problem, "TITLE_TOO_LONG");

  for (const partNumber of [0, -1, 1.5, "1", NaN, 2_147_483_648]) {
    assert.equal(V.validateUploadDeclaration({ ...valid, partNumber }, CONFIG).problem, "PART_NUMBER_INVALID", String(partNumber));
  }
  assert.equal(V.validateUploadDeclaration({ ...valid, partNumber: 500 }, CONFIG).ok, true, "no arbitrary limit");
  assert.equal(V.validateUploadDeclaration({ ...valid, partNumber: 41 }, { ...CONFIG, maxPartsPerLecture: 40 }).problem, "PART_NUMBER_TOO_HIGH");
  assert.equal(V.validateUploadDeclaration({ ...valid, partNumber: 40 }, { ...CONFIG, maxPartsPerLecture: 40 }).ok, true);
});

test("sanitizeRecordingDisplayName: folders, control and bidi characters removed; bounded; always .mp4", () => {
  assert.equal(V.sanitizeRecordingDisplayName("/etc/../a/b/Lecture.mp4"), "Lecture.mp4");
  assert.equal(V.sanitizeRecordingDisplayName("evil\u202Egnp.mp4"), "evilgnp.mp4");
  assert.equal(V.sanitizeRecordingDisplayName("tab\there\n.mp4"), "tabhere.mp4");
  assert.equal(V.sanitizeRecordingDisplayName("...mp4"), "recording.mp4");
  assert.equal(V.sanitizeRecordingDisplayName(""), "recording.mp4");
  assert.equal(V.sanitizeRecordingDisplayName(undefined), "recording.mp4");
  assert.equal(Array.from(V.sanitizeRecordingDisplayName("ශ".repeat(500) + ".mp4")).length, 200);
});

// ---- Chunk headers -----------------------------------------------------------------------------------------

const CHUNK = { chunkBytes: 8_388_608 };
const headers = (offset, length) => {
  const h = new Headers();
  if (offset !== undefined) h.set("Upload-Offset", offset);
  if (length !== undefined) h.set("Content-Length", length);
  return h;
};

test("chunk headers: offset must equal receivedBytes; length required, positive, <= chunk and <= remaining", () => {
  const upload = { expectedBytes: 20_000_000, receivedBytes: 8_388_608 };
  assert.deepEqual(V.parseChunkRequestHeaders(headers("8388608", "8388608"), upload, CHUNK), { ok: true, offset: 8_388_608, length: 8_388_608 });

  const problem = (h, u = upload) => V.parseChunkRequestHeaders(h, u, CHUNK);
  assert.deepEqual(problem(headers(undefined, "10")), { ok: false, problem: "OFFSET_REQUIRED", receivedBytes: 8_388_608 });
  assert.equal(problem(headers("abc", "10")).problem, "OFFSET_INVALID");
  assert.equal(problem(headers("-1", "10")).problem, "OFFSET_INVALID");
  assert.equal(problem(headers("12345678901234567", "10")).problem, "OFFSET_INVALID");
  assert.deepEqual(problem(headers("0", "10")), { ok: false, problem: "OFFSET_MISMATCH", receivedBytes: 8_388_608 }, "tells the client where to resume");
  assert.equal(problem(headers("8388608", undefined)).problem, "LENGTH_REQUIRED");
  assert.equal(problem(headers("8388608", "0")).problem, "LENGTH_INVALID");
  assert.equal(problem(headers("8388608", "1e3")).problem, "LENGTH_INVALID");
  assert.equal(problem(headers("8388608", "8388609")).problem, "CHUNK_TOO_LARGE");

  const last = { expectedBytes: 10_000_000, receivedBytes: 8_388_608 };
  assert.equal(problem(headers("8388608", "1611393"), last).problem, "CHUNK_EXCEEDS_REMAINING");
  assert.deepEqual(problem(headers("8388608", "1611392"), last), { ok: true, offset: 8_388_608, length: 1_611_392 }, "the last, shorter chunk");
  assert.equal(problem(headers("10000000", "1"), { expectedBytes: 10_000_000, receivedBytes: 10_000_000 }).problem, "UPLOAD_ALREADY_COMPLETE");
});
