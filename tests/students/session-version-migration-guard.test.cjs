/*
 * Static guard for the student session-version migration (Student Profile
 * SP-5.2). No database needed.
 *
 *   npm run test:students
 *
 * The migration must stay a single additive statement:
 *   ALTER TABLE "Student" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
 * This test fails if it gains any other statement (a DROP / ALTER of an
 * existing column, an index change, another table, data changes), if the
 * column's type / nullability / default change, if any other migration adds,
 * drops or alters "sessionVersion", or if schema.prisma stops declaring
 * `sessionVersion Int @default(0)` on Student only. The manual partial index
 * "Student_registrationNumber_not_deleted_key" is also re-checked here (its own
 * guard is tests/students/registration-number-migration-guard.test.cjs).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261112120000_add_student_session_version";
const COLUMN = "sessionVersion";
const EXPECTED = `ALTER TABLE "Student" ADD COLUMN "${COLUMN}" INTEGER NOT NULL DEFAULT 0;`;
const PARTIAL_INDEX = "Student_registrationNumber_not_deleted_key";

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

const statements = (sql) => sql.split(";").map((s) => s.trim()).filter(Boolean).map((s) => `${s};`);
const theMigration = () => migrations().find((m) => m.name === MIGRATION);

test("the migration exists and is exactly one statement adding sessionVersion to Student", () => {
  const m = theMigration();
  assert.ok(m, `${MIGRATION} exists`);
  assert.deepEqual(statements(m.sql), [EXPECTED]);
});

test("the column is INTEGER, NOT NULL, DEFAULT 0", () => {
  const [statement] = statements(theMigration().sql);
  const match = statement.match(/^ALTER TABLE "Student" ADD COLUMN "sessionVersion" (.+);$/);
  assert.ok(match, "an ADD COLUMN of sessionVersion on Student");
  const definition = match[1];
  assert.match(definition, /^INTEGER\b/, "integer type (not BIGINT / SMALLINT / TEXT)");
  assert.match(definition, /\bNOT NULL\b/, "NOT NULL");
  assert.match(definition, /\bDEFAULT 0$/, "default zero");
  assert.doesNotMatch(definition, /\bNULL\b(?<!NOT NULL)|GENERATED|IDENTITY|COLLATE|CHECK|REFERENCES|UNIQUE|PRIMARY/i);
});

test("nothing is dropped, altered, renamed, indexed or rewritten; no other table is touched", () => {
  const sql = theMigration().sql;
  assert.doesNotMatch(sql, /\bDROP\b/i, "no DROP (column, index, constraint, table, default)");
  assert.doesNotMatch(sql, /\bALTER COLUMN\b|\bRENAME\b|\bTYPE\b|\bSET DATA\b/i, "no existing column altered or renamed");
  assert.doesNotMatch(sql, /\bINDEX\b|\bCONSTRAINT\b|\bUNIQUE\b|\bFOREIGN KEY\b/i, "no index / constraint created, dropped or recreated");
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|INSERT|TRUNCATE|CREATE|COPY)\b/i, "no data changes and no new objects");
  const tables = [...sql.matchAll(/ALTER TABLE "([^"]+)"/gi)].map((m) => m[1]);
  assert.deepEqual(tables, ["Student"], "only the Student table");
});

test("no other migration adds, drops or alters sessionVersion", () => {
  const others = migrations().filter((m) => m.name !== MIGRATION && m.sql.includes(`"${COLUMN}"`));
  assert.deepEqual(others.map((m) => m.name), []);
});

test("the manual registration-number partial index is still created once and never dropped", () => {
  const all = migrations();
  assert.equal(all.filter((m) => m.sql.includes(`"${PARTIAL_INDEX}"`)).length, 1);
  for (const m of all) {
    assert.doesNotMatch(m.sql, new RegExp(`(DROP|ALTER) INDEX[^;]*${PARTIAL_INDEX}`, "i"), m.name);
  }
  assert.ok(!theMigration().sql.includes(PARTIAL_INDEX));
});

test("schema.prisma declares `sessionVersion Int @default(0)` on Student only", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const models = [...schema.matchAll(/^model (\w+) \{[\s\S]*?^\}/gm)].map((m) => ({ name: m[1], body: m[0] }));
  const fieldLines = (body) => body.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim().replace(/\s+/g, " "));

  const student = models.find((m) => m.name === "Student");
  assert.ok(student, "model Student exists");
  assert.equal(/@@map\(/.test(student.body), false, 'Student stays mapped to the "Student" table');
  const lines = fieldLines(student.body).filter((l) => l.startsWith(`${COLUMN} `));
  assert.deepEqual(lines, [`${COLUMN} Int @default(0)`]);

  const elsewhere = models.filter((m) => m.name !== "Student" && fieldLines(m.body).some((l) => l.startsWith(`${COLUMN} `)));
  assert.deepEqual(elsewhere.map((m) => m.name), [], "teachers, guardians and other models have no sessionVersion");

  // The fields the partial index and the status convention rely on are unchanged.
  const all = fieldLines(student.body);
  assert.ok(all.includes("registrationNumber String?"));
  assert.ok(all.includes("status Int @default(0)"));
  assert.ok(all.includes("password String?"));
});
