/*
 * Recorded Lectures RL-1: central configuration (lib/recorded-lectures/config.ts)
 * and the isolation of the RL-1 modules from existing code.
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { loadRecordedLectureConfig, RECORDED_LECTURE_DEFAULTS, RECORDED_LECTURE_SETTINGS, formatDecimalSize } = require(
  path.join(root, "lib", "recorded-lectures", "config.ts")
);

const MIB = 1024 * 1024;

test("defaults: the accepted RL-1 values", () => {
  const result = loadRecordedLectureConfig({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, {
    maxPartBytes: 4_000_000_000,
    chunkBytes: 8_388_608,
    chunkLeaseSeconds: 300,
    maxInflightChunkBytes: 134_217_728,
    scratchGraceMinutes: 15,
    uploadExpiryHours: 24,
    maxActiveUploadsPerTeacher: 3,
    maxPartsPerLecture: null,
    minFreeBytes: 5 * 1024 * MIB,
    maxMoovBytes: 64 * MIB,
    dashboardAvailabilityDays: 7,
    orphanGraceHours: 48,
  });
  assert.deepEqual({ ...RECORDED_LECTURE_DEFAULTS }, result.config);
  assert.ok(Object.isFrozen(result.config));
});

test("every setting can be overridden through its variable (trimmed decimal integers)", () => {
  const env = {
    RECORDED_LECTURE_MAX_PART_BYTES: "2000000000",
    RECORDED_LECTURE_CHUNK_BYTES: String(16 * MIB),
    RECORDED_LECTURE_CHUNK_LEASE_SECONDS: " 120 ",
    RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES: String(256 * MIB),
    RECORDED_LECTURE_SCRATCH_GRACE_MINUTES: "30",
    RECORDED_LECTURE_UPLOAD_EXPIRY_HOURS: "12",
    RECORDED_LECTURE_MAX_ACTIVE_UPLOADS_PER_TEACHER: "5",
    RECORDED_LECTURE_MAX_PARTS_PER_LECTURE: "40",
    RECORDED_LECTURE_MIN_FREE_BYTES: "0",
    RECORDED_LECTURE_MAX_MOOV_BYTES: String(32 * MIB),
    RECORDED_LECTURE_DASHBOARD_DAYS: "10",
    RECORDED_LECTURE_ORPHAN_GRACE_HOURS: "72",
  };
  const result = loadRecordedLectureConfig(env);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.config, {
    maxPartBytes: 2_000_000_000,
    chunkBytes: 16 * MIB,
    chunkLeaseSeconds: 120,
    maxInflightChunkBytes: 256 * MIB,
    scratchGraceMinutes: 30,
    uploadExpiryHours: 12,
    maxActiveUploadsPerTeacher: 5,
    maxPartsPerLecture: 40,
    minFreeBytes: 0,
    maxMoovBytes: 32 * MIB,
    dashboardAvailabilityDays: 10,
    orphanGraceHours: 72,
  });
  assert.equal(RECORDED_LECTURE_SETTINGS.length, Object.keys(env).length, "every setting has a variable");
});

test("invalid values make the feature not configured; problems name the variable, never the value", () => {
  for (const [name, value] of [
    ["RECORDED_LECTURE_MAX_PART_BYTES", "4GB"],
    ["RECORDED_LECTURE_MAX_PART_BYTES", "999999"],
    ["RECORDED_LECTURE_MAX_PART_BYTES", "64000000001"],
    ["RECORDED_LECTURE_CHUNK_BYTES", "-1"],
    ["RECORDED_LECTURE_CHUNK_BYTES", String(65 * MIB)],
    ["RECORDED_LECTURE_CHUNK_LEASE_SECONDS", "29"],
    ["RECORDED_LECTURE_CHUNK_LEASE_SECONDS", "901"],
    ["RECORDED_LECTURE_CHUNK_LEASE_SECONDS", "1e3"],
    ["RECORDED_LECTURE_SCRATCH_GRACE_MINUTES", "4"],
    ["RECORDED_LECTURE_MAX_ACTIVE_UPLOADS_PER_TEACHER", "0"],
    ["RECORDED_LECTURE_MAX_PARTS_PER_LECTURE", "0"],
    ["RECORDED_LECTURE_DASHBOARD_DAYS", "31"],
    ["RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES", "4294967297"],
    ["RECORDED_LECTURE_MIN_FREE_BYTES", "12.5"],
  ]) {
    const result = loadRecordedLectureConfig({ [name]: value });
    assert.equal(result.ok, false, `${name}=${value}`);
    assert.ok(result.problems.some((p) => p.includes(name)));
    assert.ok(result.problems.every((p) => !p.includes(value) || /^\d+$/.test(value)), "the bad value is not echoed");
  }
});

test("relationships: chunk <= part, chunk <= in-flight cap, scratch grace >= one lease", () => {
  assert.equal(loadRecordedLectureConfig({ RECORDED_LECTURE_MAX_PART_BYTES: "1000000", RECORDED_LECTURE_CHUNK_BYTES: String(2 * MIB) }).ok, false);
  assert.equal(loadRecordedLectureConfig({ RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES: String(4 * MIB) }).ok, false, "below the 8 MiB chunk");
  assert.equal(loadRecordedLectureConfig({ RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES: String(8 * MIB) }).ok, true, "exactly one chunk");
  assert.equal(loadRecordedLectureConfig({ RECORDED_LECTURE_CHUNK_LEASE_SECONDS: "900", RECORDED_LECTURE_SCRATCH_GRACE_MINUTES: "14" }).ok, false);
  assert.equal(loadRecordedLectureConfig({ RECORDED_LECTURE_CHUNK_LEASE_SECONDS: "900", RECORDED_LECTURE_SCRATCH_GRACE_MINUTES: "15" }).ok, true);
  assert.equal(loadRecordedLectureConfig({ RECORDED_LECTURE_SCRATCH_GRACE_MINUTES: "5" }).ok, true, "5 min covers the 300 s lease");
});

test("formatDecimalSize: decimal units, as the limit is defined", () => {
  assert.equal(formatDecimalSize(4_000_000_000), "4 GB");
  assert.equal(formatDecimalSize(2_500_000_000), "2.5 GB");
  assert.equal(formatDecimalSize(8_388_608), "8.38 MB");
  assert.equal(formatDecimalSize(1_500), "1.5 KB");
  assert.equal(formatDecimalSize(12), "12 bytes");
});

// ---- Isolation ----------------------------------------------------------------------------------------

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// The only application files allowed to import the recorded-lecture modules (RL-3.2 to RL-3.5: the
// upload, chunk, completion and maintenance services and their routes; RL-4.2: the student service and routes). Any other importer (an existing feature) fails.
const APPROVED_IMPORTERS = [
  "app/api/lectures/[id]/recorded-lectures/uploads/route.ts",
  "app/api/recorded-lectures/uploads/[uploadId]/route.ts",
  "app/api/recorded-lectures/uploads/[uploadId]/chunks/route.ts",
  "app/api/recorded-lectures/uploads/[uploadId]/complete/route.ts",
  "services/recorded-lecture-upload-service.ts",
  "services/recorded-lecture-chunk-service.ts",
  "services/recorded-lecture-completion-service.ts",
  "services/recorded-lecture-maintenance-service.ts",
  // RL-4.2: the student list / metadata service (its routes import only the service).
  "services/recorded-lecture-student-service.ts",
  // RL-4.3: the student playback service (its route imports only the service).
  "services/recorded-lecture-stream-service.ts",
  // RL-5.1: the student page loaders, and the player helpers (a type-only import of the student DTO).
  "services/recorded-lecture-student-pages.ts",
  "components/student-portal/recorded-lectures/recording-helpers.ts",
  // Teacher side: management / preview service and routes, the upload engine and studio (browser MP4 check).
  "services/recorded-lecture-teacher-service.ts",
  "app/api/lectures/[id]/recorded-lectures/route.ts",
  "app/api/recorded-lectures/[recordingId]/route.ts",
  "components/recorded-lectures/teacher-recordings-client.tsx",
  "components/recorded-lectures/studio-controller.ts",
  "components/recorded-lectures/upload-engine.ts",
  // Public teacher profile integration: the public listing / playback service (its route imports only
  // the service) and the teacher's publication settings service and route.
  "services/recorded-lecture-public-service.ts",
  "services/recorded-lecture-publication-service.ts",
  "app/api/recorded-lectures/[recordingId]/publication/route.ts",
  // Unified storage Stage 2 (Notes and assignment submissions on the shared storage foundation):
  // the resource key modules and the one shared read / write module. They use lib/file-storage only
  // (never lib/recorded-lectures); routes import them, not lib/file-storage. See tests/storage-migration.
  "lib/notes/storage-keys.ts",
  "lib/assignments/submission-keys.ts",
  "lib/stored-files/stored-file.ts",
  // Teacher profile photos on unified storage: the key module only (joinStorageKey / parseStorageKey);
  // files are written, read and deleted through lib/stored-files/stored-file.ts.
  "lib/profile-images/storage-keys.ts",
];

test("isolation: only the approved RL-3 upload service and routes import the recorded-lecture modules", () => {
  const importers = [];
  for (const dir of ["app", "components", "lib", "services", "scripts", "middleware.ts"]) {
    const target = path.join(root, dir);
    if (!fs.existsSync(target)) continue;
    const files = fs.statSync(target).isDirectory() ? listFiles(target) : [target];
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (rel.startsWith("lib/file-storage/") || rel.startsWith("lib/recorded-lectures/")) continue;
      if (/lib\/file-storage|lib\/recorded-lectures/.test(fs.readFileSync(file, "utf8"))) importers.push(rel);
    }
  }
  assert.deepEqual(importers.sort(), [...APPROVED_IMPORTERS].sort());
});

// RL-3.1 upload foundation modules: an explicit, per-file allow-list (stricter than "anything").
// Prisma may only be imported for TYPES (import type ... from "@prisma/client"); the Prisma client
// instance (@/lib/prisma) is never imported here, and only upload-errors.ts may import AppError.
const RL3_MODULES = {
  "lib/recorded-lectures/bigint.ts": [],
  "lib/recorded-lectures/upload-errors.ts": ["@/lib/error-handler"],
  "lib/recorded-lectures/upload-dto.ts": ["@prisma/client"],
  "lib/recorded-lectures/upload-locks.ts": ["@prisma/client"],
  "lib/recorded-lectures/request-body.ts": [],
  "lib/recorded-lectures/chunk-stream.ts": [],
  "lib/recorded-lectures/chunk-assembly.ts": [],
  "lib/recorded-lectures/cleanup-rules.ts": [],
  // RL-4.2 (pure): the dashboard window and the student DTO.
  "lib/recorded-lectures/dashboard-window.ts": [],
  "lib/recorded-lectures/student-dto.ts": [],
  // RL-4.3 (pure): the playback stream slots.
  "lib/recorded-lectures/stream-slots.ts": [],
  // Public teacher profile integration (pure): the public playback stream slots.
  "lib/recorded-lectures/public-stream-slots.ts": [],
  // Teacher side (pure): the teacher DTO (Prisma types only).
  "lib/recorded-lectures/teacher-dto.ts": ["@prisma/client"],
};

test("isolation: the RL-1 modules import nothing from existing features (only node and each other)", () => {
  const dirs = [path.join(root, "lib", "file-storage"), path.join(root, "lib", "recorded-lectures")];
  for (const file of dirs.flatMap((d) => listFiles(d))) {
    if (Object.hasOwn(RL3_MODULES, path.relative(root, file).split(path.sep).join("/"))) continue;
    const src = fs.readFileSync(file, "utf8");
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)) {
      const allowed = spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("@/lib/file-storage/") || spec.startsWith("@/lib/recorded-lectures/");
      assert.ok(allowed, `${path.relative(root, file)} imports ${spec}`);
    }
    assert.doesNotMatch(src, /prisma|process\.env\.DATABASE_URL/i, `${path.relative(root, file)}: no database access in RL-1`);
  }
});

test("isolation: the RL-3.1 modules import only their allow-listed modules; Prisma for types only, never the client", () => {
  for (const [rel, extra] of Object.entries(RL3_MODULES)) {
    const src = fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
    for (const [statement, spec] of src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)) {
      const base = spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("@/lib/file-storage/") || spec.startsWith("@/lib/recorded-lectures/");
      assert.ok(base || extra.includes(spec), `${rel} imports ${spec}`);
      if (spec === "@prisma/client") assert.match(statement.trim(), /^import type\b/, `${rel}: Prisma types only`);
    }
    assert.doesNotMatch(src, /@\/lib\/prisma|process\.env\.DATABASE_URL|new PrismaClient/, `${rel}: no database client`);
  }
  // Every file in the two folders is either an RL-1 module (checked above) or listed here.
  const listed = new Set(Object.keys(RL3_MODULES));
  const rl1 = new Set([
    "config.ts", "keys.ts", "chunk-lease.ts", "validation.ts", "mp4-inspect.ts", "mp4-inspect-node.ts", "storage.ts", "stream-response.ts",
  ]);
  for (const file of listFiles(path.join(root, "lib", "recorded-lectures"))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    assert.ok(listed.has(rel) || rl1.has(path.basename(file)), `${rel} is neither an RL-1 module nor an allow-listed RL-3 module`);
  }
});
