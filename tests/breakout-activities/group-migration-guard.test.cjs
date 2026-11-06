/*
 * Static guard for the Group Activities migration (no database needed):
 *  - the migration is additive only: no DROP, no ALTER COLUMN / RENAME, and
 *    the only ALTER TABLE on existing tables adds the workMode column with
 *    the INDIVIDUAL default (existing rows stay individual);
 *  - the hand-written partial unique index "BreakoutRoomMember_one_active_key"
 *    exists exactly once, with the exact definition, and no migration drops
 *    or alters it;
 *  - schema.prisma keeps the three models, the enum, the workMode defaults
 *    and the comment naming the index; the docs describe it.
 * See docs/breakout-activities-migrations.md.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261106120000_add_breakout_group_activities";
const INDEX = "BreakoutRoomMember_one_active_key";

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

const groupMigration = () => {
  const m = migrations().find((x) => x.name === MIGRATION);
  assert.ok(m, `${MIGRATION} exists`);
  return m;
};

test("the group migration is additive only", () => {
  const { sql } = groupMigration();
  assert.equal(/\bDROP\b/i.test(sql), false, "no DROP statements");
  assert.equal(/\bRENAME\b/i.test(sql), false, "no RENAME");
  assert.equal(/ALTER COLUMN/i.test(sql), false, "no column changes");
  assert.equal(/\bDELETE\s+FROM\b|\bUPDATE\s+"/i.test(sql), false, "no data changes");

  const existing = sql.match(/ALTER TABLE "(BreakoutAssignment|BreakoutQuiz)" [^;]*;/g) ?? [];
  assert.deepEqual(existing, [
    `ALTER TABLE "BreakoutAssignment" ADD COLUMN "workMode" "BreakoutWorkMode" NOT NULL DEFAULT 'INDIVIDUAL';`,
    `ALTER TABLE "BreakoutQuiz" ADD COLUMN "workMode" "BreakoutWorkMode" NOT NULL DEFAULT 'INDIVIDUAL';`,
  ]);
  for (const a of sql.match(/ALTER TABLE "[^"]+"/gi) ?? []) {
    assert.match(a, /ALTER TABLE "(BreakoutAssignment|BreakoutQuiz|BreakoutRoomMember|BreakoutGroupAssignmentWork|BreakoutGroupQuizAttempt)"/, a);
  }
  for (const table of ["BreakoutRoomMember", "BreakoutGroupAssignmentWork", "BreakoutGroupQuizAttempt"]) {
    assert.ok(sql.includes(`CREATE TABLE "${table}"`), `creates ${table}`);
  }
  assert.ok(sql.includes(`CREATE TYPE "BreakoutWorkMode" AS ENUM ('INDIVIDUAL', 'GROUP');`));
});

test("the partial unique index is created exactly once, with the exact definition", () => {
  const all = migrations();
  const creating = all.filter((m) => m.sql.includes(`"${INDEX}"`));
  assert.deepEqual(creating.map((m) => m.name), [MIGRATION]);
  const expected = `CREATE UNIQUE INDEX "${INDEX}" ON "BreakoutRoomMember" ("classSessionId", "studentId") WHERE "status" = 0;`;
  assert.ok(creating[0].sql.includes(expected), `expected statement:\n${expected}`);
  assert.equal(creating[0].sql.split(`"${INDEX}"`).length - 1, 1);
  for (const m of all) {
    const upper = m.sql.toUpperCase();
    assert.equal(/DROP INDEX[^;]*BREAKOUTROOMMEMBER_ONE_ACTIVE_KEY/.test(upper), false, `${m.name} drops ${INDEX}`);
    assert.equal(/ALTER INDEX[^;]*BREAKOUTROOMMEMBER_ONE_ACTIVE_KEY/.test(upper), false, `${m.name} alters ${INDEX}`);
  }
});

test("schema.prisma: the enum, the workMode defaults, the three models and the index comment", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const block = (name) => {
    const match = schema.match(new RegExp(`^(model|enum) ${name} \\{[\\s\\S]*?^\\}`, "m"));
    assert.ok(match, `${name} exists`);
    return match[0].split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, " "));
  };
  assert.ok(block("BreakoutWorkMode").includes("INDIVIDUAL"));
  assert.ok(block("BreakoutWorkMode").includes("GROUP"));
  assert.ok(block("BreakoutAssignment").includes("workMode BreakoutWorkMode @default(INDIVIDUAL)"));
  assert.ok(block("BreakoutQuiz").includes("workMode BreakoutWorkMode @default(INDIVIDUAL)"));
  assert.ok(block("BreakoutRoomMember").includes("status Int @default(0)"));
  assert.ok(block("BreakoutGroupAssignmentWork").includes("assignmentId String @unique"));
  assert.ok(block("BreakoutGroupQuizAttempt").includes("quizId String @unique"));
  assert.ok(schema.includes(INDEX), "the model comment names the index");
});

test("the manual index is documented", () => {
  const text = fs.readFileSync(path.join(root, "docs", "breakout-activities-migrations.md"), "utf8");
  assert.ok(text.includes(INDEX));
  assert.ok(text.includes(MIGRATION));
});
