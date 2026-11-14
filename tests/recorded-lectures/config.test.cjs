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

test("isolation: no existing application code imports the RL-1 modules (nothing is wired in yet)", () => {
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
  assert.deepEqual(importers, []);
});

test("isolation: the RL-1 modules import nothing from existing features (only node and each other)", () => {
  const dirs = [path.join(root, "lib", "file-storage"), path.join(root, "lib", "recorded-lectures")];
  for (const file of dirs.flatMap((d) => listFiles(d))) {
    const src = fs.readFileSync(file, "utf8");
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)) {
      const allowed = spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("@/lib/file-storage/") || spec.startsWith("@/lib/recorded-lectures/");
      assert.ok(allowed, `${path.relative(root, file)} imports ${spec}`);
    }
    assert.doesNotMatch(src, /prisma|process\.env\.DATABASE_URL/i, `${path.relative(root, file)}: no database access in RL-1`);
  }
});
