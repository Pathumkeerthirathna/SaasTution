/*
 * Resource creation timestamps (monthly resource access): the creation
 * instant that decides a resource's Sri Lankan billing month is written by
 * the application from serverNow() (an absolute instant), never left to the
 * database default. In production the PostgreSQL session timezone is
 * Europe/Berlin and these columns are `timestamp without time zone`, so a
 * CURRENT_TIMESTAMP default would store Berlin wall-clock digits that read
 * back 1-2 hours late and could move a resource created just before Colombo
 * midnight at a month's end into the next month.
 *
 *   npm run test:class-access
 *
 * Real services; in-memory database (tests/fee-waiver/helpers/fake-db.cjs);
 * mocked clock. Static checks for the YouTube paths (they call YouTube).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("../fee-waiver/helpers/fake-db.cjs");

const db = createFakeDb();
// The database clock (serverNow measures its offset with SELECT now()): the
// same as this process's (mocked) clock, so the offset is 0.
const baseQueryRaw = db.client.$queryRaw;
db.client.$queryRaw = async (strings, ...values) => {
  const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
  if (/^SELECT now\(\) AS now$/.test(sql.trim())) return [{ now: new Date() }];
  return baseQueryRaw(strings, ...values);
};

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
fake("lib/prisma.ts", { prisma: db.client });

const { resetServerClock } = require(path.join(root, "lib", "server-clock.ts"));
const papers = require(path.join(root, "services", "class-paper-service.ts"));
const whiteboards = require(path.join(root, "services", "lecture-whiteboard-service.ts"));
const RA = require(path.join(root, "services", "resource-access-service.ts"));

// Sri Lankan wall clock "YYYY-MM-DDTHH:mm" -> the real instant (UTC+05:30).
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const at = (t, wall) => {
  t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
  resetServerClock(); // measure the offset again under the mocked clock
};

const T = "teacher-1";
const A = "class-a";

function seed() {
  db.reset();
  db.insert("Class", { id: A, teacherId: T, status: 0, name: "Combined Maths" });
  db.insert("Lecture", { id: "lec-a", classId: A, title: "L1", status: 0, date: sl("2026-11-02T16:00") });
}

const paperInput = (over = {}) => ({
  classId: A,
  name: "Paper",
  description: null,
  maxMarks: null,
  startTime: sl("2026-12-05T09:00"),
  endTime: sl("2026-12-05T11:00"),
  sortOrder: 0,
  file: { fileName: "p.pdf", fileUrl: "papers/p.pdf", mimeType: "application/pdf" },
  ...over,
});
const scene = { elements: [], appState: { viewBackgroundColor: "#ffffff" } };

// Every month end Colombo crosses while Berlin is on winter (+1h) or summer (+2h) time.
const EDGES = [
  // [last minute of the month in Colombo, expected month, first minute of the next month, next month]
  ["2026-11-30T23:59", { year: 2026, month: 11 }, "2026-12-01T00:00", { year: 2026, month: 12 }], // CET (+1h)
  ["2026-07-31T23:30", { year: 2026, month: 7 }, "2026-08-01T00:05", { year: 2026, month: 8 }], // CEST (+2h)
  ["2026-12-31T22:15", { year: 2026, month: 12 }, "2027-01-01T00:00", { year: 2027, month: 1 }], // year end
];

test("ClassPaper: createdAt is the explicit absolute creation instant; the billing month is right on both sides of Colombo midnight", async (t) => {
  for (const [before, beforeMonth, after, afterMonth] of EDGES) {
    for (const [wall, month] of [[before, beforeMonth], [after, afterMonth]]) {
      seed();
      at(t, wall);
      const created = await papers.createClassPaper(T, paperInput());
      const row = db.tables.ClassPaper[0];
      assert.ok(row.createdAt instanceof Date, "written by the application, not a database default");
      assert.equal(row.createdAt.getTime(), sl(wall).getTime(), wall);
      assert.deepEqual(RA.billingMonthOf(row.createdAt), month, wall);
      assert.deepEqual(await RA.resourceClassMonth({ paperId: created.id ?? row.id }), { classId: A, month }, wall);
      t.mock.timers.reset();
    }
  }
});

test("LectureWhiteboard: createdAt is the explicit absolute creation instant; the billing month is right on both sides of Colombo midnight", async (t) => {
  for (const [before, beforeMonth, after, afterMonth] of EDGES) {
    for (const [wall, month] of [[before, beforeMonth], [after, afterMonth]]) {
      seed();
      at(t, wall);
      const created = await whiteboards.createWhiteboardForTeacher(T, "lec-a", { title: "Board", data: scene });
      const row = db.tables.LectureWhiteboard[0];
      assert.ok(row.createdAt instanceof Date);
      assert.equal(row.createdAt.getTime(), sl(wall).getTime(), wall);
      assert.equal(created.createdAt, sl(wall).toISOString(), "the response reports the same instant");
      assert.deepEqual(await RA.resourceClassMonth({ whiteboardId: row.id }), { classId: A, month }, wall);
      t.mock.timers.reset();
    }
  }
});

test("the database clock's offset is applied (serverNow), as for recorded lecture uploads", async (t) => {
  seed();
  at(t, "2026-11-30T23:59");
  // The database clock runs 2 minutes ahead of this server: the stored instant follows the database clock.
  db.client.$queryRaw = async () => [{ now: new Date(Date.now() + 2 * 60 * 1000) }];
  resetServerClock();
  try {
    await whiteboards.createWhiteboardForTeacher(T, "lec-a", { title: "Board", data: scene });
    const row = db.tables.LectureWhiteboard[0];
    assert.equal(row.createdAt.getTime(), sl("2026-12-01T00:01").getTime());
    assert.deepEqual(RA.billingMonthOf(row.createdAt), { year: 2026, month: 12 });
  } finally {
    db.client.$queryRaw = async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (/^SELECT now\(\) AS now$/.test(sql.trim())) return [{ now: new Date() }];
      return baseQueryRaw(strings, ...values);
    };
    resetServerClock();
  }
});

test("why the explicit value matters: Berlin wall-clock digits read back as UTC would move a late-evening resource into the next month", () => {
  // 30 Nov 23:30 in Colombo = 18:00 UTC = 19:00 in Berlin (CET). A database
  // default would store "19:00" in the timestamp-without-time-zone column;
  // Prisma reads it back as 19:00 UTC, i.e. 00:30 on 1 Dec in Colombo.
  const real = sl("2026-11-30T23:30");
  const berlinDigitsAsUtc = new Date(real.getTime() + 60 * 60 * 1000);
  assert.deepEqual(RA.billingMonthOf(real), { year: 2026, month: 11 });
  assert.deepEqual(RA.billingMonthOf(berlinDigitsAsUtc), { year: 2026, month: 12 }, "the bug the explicit createdAt avoids");
});

// ---- Static: the create paths write createdAt, nothing else does -------------------------------

// Source without comments (so explanations never count as code).
const read = (rel) =>
  fs.readFileSync(path.join(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/**
 * `createdAt:` assignments that write a new value: not selects (true), sort
 * orders ("asc" / "desc"), filters ({ ... }), types, or response mappings of
 * a row already read (row.createdAt...).
 */
const createdAtWrites = (source) =>
  source.match(/\bcreatedAt:\s*(?!true\b|"asc"|"desc"|\{|Date\b|string\b|[A-Za-z_]\w*\.)[^\s,}]+/g) ?? [];

test("YouTubeRecording: both create branches (create, upsert create) set createdAt from one serverNow() value; the upsert's update branch never touches it", () => {
  const source = read("lib/youtube-lecture.ts");
  const upsert = source.match(/const sharedRecordingCreatedAt = await serverNow\(\);\s*const sharedRecordingRow =\s*await prisma\.youTubeRecording\.upsert\(\{[\s\S]*?\n\s*\}\);/);
  assert.ok(upsert, "the shared recording upsert");
  const [createBranch, updateBranch] = upsert[0].split(/\n\s*update: \{/);
  assert.match(createBranch, /create: \{\s*\.\.\.newFeatureGeneration\(sharedRecordingCreatedAt\),\s*createdAt: sharedRecordingCreatedAt,/);
  assert.ok(updateBranch, "the update branch exists");
  assert.doesNotMatch(updateBranch, /createdAt/, "an update never changes createdAt");

  const create = source.match(/const recordingCreatedAt = await serverNow\(\);\s*const createdRecordingRow =\s*await prisma\.youTubeRecording\.create\(\{[\s\S]*?\n\s*\}\);/);
  assert.ok(create, "the recording create");
  assert.match(create[0], /data: \{\s*\.\.\.newFeatureGeneration\(recordingCreatedAt\),\s*createdAt: recordingCreatedAt,/);

  assert.deepEqual(createdAtWrites(source), ["createdAt: sharedRecordingCreatedAt", "createdAt: recordingCreatedAt"], "no other createdAt write");
  assert.match(source, /import \{ serverNow \} from "@\/lib\/server-clock";/);
});

test("ClassPaper and LectureWhiteboard: exactly one createdAt write each (the create); updates never set it", () => {
  for (const rel of ["services/class-paper-service.ts", "services/lecture-whiteboard-service.ts"]) {
    const source = read(rel);
    assert.deepEqual(createdAtWrites(source), ["createdAt: await"], rel);
    assert.match(source, /import \{ serverNow \} from "@\/lib\/server-clock";/, rel);
    for (const update of source.match(/\.(update|updateMany|upsert)\(\{[\s\S]*?\n\s{2,4}\}\);/g) ?? []) {
      assert.doesNotMatch(update, /createdAt/, `${rel}: an update sets createdAt`);
    }
  }
});

test("schema and migrations unchanged by this fix: the @default(now()) declarations and CURRENT_TIMESTAMP defaults stay", () => {
  const schema = read("prisma/schema.prisma");
  for (const model of ["ClassPaper", "LectureWhiteboard", "YouTubeRecording"]) {
    const block = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))[0];
    assert.match(block, /\n\s*createdAt\s+DateTime\s+@default\(now\(\)\)/, model);
  }
});
