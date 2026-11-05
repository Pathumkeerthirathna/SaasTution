/*
 * Static guard for the hand-written partial unique index
 * "BreakoutAssignmentSubmission_one_latest_key" (no database needed).
 *
 *   npm run test:breakout
 *
 * Prisma 5.22 cannot declare partial indexes, so this index exists only in the
 * migration SQL. A later `prisma migrate dev` could treat it as drift and
 * generate a DROP INDEX in some new migration. This test fails if:
 *  - the CREATE statement is missing or changed;
 *  - any migration drops, renames or otherwise mentions the index again;
 *  - any migration drops or alters the table's "isLatest" column, or drops
 *    the table;
 *  - schema.prisma no longer has `isLatest Boolean @default(true)` (for
 *    example, switched to a nullable marker);
 *  - the documentation of the manual-SQL rule is missing.
 * See docs/breakout-activities-migrations.md.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const INDEX = "BreakoutAssignmentSubmission_one_latest_key";
const TABLE = "BreakoutAssignmentSubmission";
const CREATING_MIGRATION = "20261105120000_add_breakout_activities";

/** SQL without comments, whitespace collapsed. */
function normalizeSql(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function migrations() {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const file = path.join(migrationsDir, name, "migration.sql");
      return { name, sql: fs.existsSync(file) ? normalizeSql(fs.readFileSync(file, "utf8")) : "" };
    });
}

test("the partial unique index is created exactly once, with the exact definition", () => {
  const all = migrations();
  const creating = all.filter((m) => m.sql.includes(`"${INDEX}"`));
  assert.deepEqual(creating.map((m) => m.name), [CREATING_MIGRATION], `"${INDEX}" must appear only in ${CREATING_MIGRATION}`);

  const expected = `CREATE UNIQUE INDEX "${INDEX}" ON "${TABLE}" ("assignmentId", "studentId") WHERE "isLatest";`;
  const occurrences = creating[0].sql.split(`"${INDEX}"`).length - 1;
  assert.equal(occurrences, 1, "the index is named once in its migration");
  assert.ok(creating[0].sql.includes(expected), `expected statement:\n${expected}`);
});

test("no migration drops, renames or recreates the index", () => {
  for (const m of migrations()) {
    const upper = m.sql.toUpperCase();
    assert.equal(/DROP INDEX[^;]*BREAKOUTASSIGNMENTSUBMISSION_ONE_LATEST_KEY/.test(upper), false, `${m.name} drops ${INDEX}`);
    assert.equal(/ALTER INDEX[^;]*BREAKOUTASSIGNMENTSUBMISSION_ONE_LATEST_KEY/.test(upper), false, `${m.name} alters ${INDEX}`);
  }
});

test("no migration drops the table or drops / alters / renames its isLatest column", () => {
  for (const m of migrations()) {
    assert.equal(new RegExp(`DROP TABLE[^;]*"${TABLE}"`, "i").test(m.sql), false, `${m.name} drops ${TABLE}`);
    const alters = m.sql.match(new RegExp(`ALTER TABLE "${TABLE}"[^;]*;`, "gi")) ?? [];
    for (const statement of alters) {
      assert.equal(/"isLatest"/.test(statement), false, `${m.name} changes "isLatest": ${statement}`);
      assert.equal(/RENAME TO/i.test(statement), false, `${m.name} renames ${TABLE}`);
    }
    assert.equal(new RegExp(`ALTER TABLE[^;]*RENAME TO "${TABLE}"`, "i").test(m.sql), false, `${m.name} replaces ${TABLE}`);
  }
});

test("the creating migration only adds: no DROP, and ALTER only on breakout tables", () => {
  const m = migrations().find((x) => x.name === CREATING_MIGRATION);
  assert.ok(m, `${CREATING_MIGRATION} exists`);
  assert.equal(/\bDROP\b/i.test(m.sql), false, "no DROP statements");
  const alters = m.sql.match(/ALTER TABLE "[^"]+"/gi) ?? [];
  assert.ok(alters.length > 0);
  for (const a of alters) assert.match(a, /ALTER TABLE "Breakout/, a);
});

test("schema.prisma keeps isLatest Boolean @default(true) (non-nullable)", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const block = schema.match(new RegExp(`^model ${TABLE} \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(block, `model ${TABLE} exists`);
  const fields = block[0].split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, " "));
  assert.ok(fields.includes("isLatest Boolean @default(true)"), "isLatest must stay `Boolean @default(true)`");
  assert.equal(fields.some((l) => /^isLatest Boolean\?/.test(l)), false, "isLatest must not become nullable");
  assert.equal(fields.some((l) => /@@unique\(\[[^\]]*isLatest/.test(l)), false, "no Prisma unique on isLatest (the partial index is the rule)");
  assert.ok(block[0].includes(INDEX), "the schema comment names the index");
});

test("the manual-SQL rule is documented", () => {
  const doc = path.join(root, "docs", "breakout-activities-migrations.md");
  assert.ok(fs.existsSync(doc), "docs/breakout-activities-migrations.md exists");
  const text = fs.readFileSync(doc, "utf8");
  assert.ok(text.includes(INDEX));
  assert.ok(text.includes("migrate diff"));
});
