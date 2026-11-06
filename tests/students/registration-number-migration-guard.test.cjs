/*
 * Static guard for the hand-written partial unique index
 * "Student_registrationNumber_not_deleted_key" (no database needed).
 *
 *   npm run test:students
 *
 * Prisma 5.22 cannot declare partial indexes, so this index exists only in the
 * migration SQL. A later `prisma migrate dev` could treat it as drift and
 * generate a DROP INDEX in some new migration. This test fails if:
 *  - the CREATE statement is missing or changed;
 *  - any migration drops, alters or recreates the index;
 *  - a later migration drops / alters / renames the Student "status" or
 *    "registrationNumber" columns, or drops / renames the table;
 *  - schema.prisma gains @unique on registrationNumber (deleted numbers would
 *    no longer be reusable) or changes the two fields;
 *  - the documentation of the manual-SQL rule is missing.
 * See docs/student-registration-number-index.md.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const INDEX = "Student_registrationNumber_not_deleted_key";
const TABLE = "Student";
const CREATING_MIGRATION = "20261106150000_student_registration_number_not_deleted_unique";

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

  const expected = `CREATE UNIQUE INDEX "${INDEX}" ON "${TABLE}" ("registrationNumber") WHERE "status" <> 2;`;
  assert.equal(creating[0].sql, expected, "the migration contains exactly this statement");
});

test("no migration drops, alters or recreates the index", () => {
  for (const m of migrations()) {
    const upper = m.sql.toUpperCase();
    const name = INDEX.toUpperCase();
    assert.equal(new RegExp(`DROP INDEX[^;]*${name}`).test(upper), false, `${m.name} drops ${INDEX}`);
    assert.equal(new RegExp(`ALTER INDEX[^;]*${name}`).test(upper), false, `${m.name} alters ${INDEX}`);
  }
});

test("later migrations leave the Student table and its status / registrationNumber columns alone", () => {
  const later = migrations().filter((m) => m.name > CREATING_MIGRATION);
  for (const m of later) {
    assert.equal(new RegExp(`DROP TABLE[^;]*"${TABLE}"`, "i").test(m.sql), false, `${m.name} drops ${TABLE}`);
    assert.equal(new RegExp(`ALTER TABLE[^;]*RENAME TO "${TABLE}"`, "i").test(m.sql), false, `${m.name} replaces ${TABLE}`);
    const alters = m.sql.match(new RegExp(`ALTER TABLE "${TABLE}"[^;]*;`, "gi")) ?? [];
    for (const statement of alters) {
      assert.equal(/"status"|"registrationNumber"/.test(statement), false, `${m.name} changes an indexed column: ${statement}`);
      assert.equal(/RENAME TO/i.test(statement), false, `${m.name} renames ${TABLE}`);
    }
    assert.equal(
      new RegExp(`CREATE UNIQUE INDEX[^;]*ON "${TABLE}"[^;]*"registrationNumber"`, "i").test(m.sql),
      false,
      `${m.name} adds another unique index on registrationNumber`
    );
  }
});

test("the creating migration only adds the index", () => {
  const m = migrations().find((x) => x.name === CREATING_MIGRATION);
  assert.ok(m, `${CREATING_MIGRATION} exists`);
  assert.equal(/\b(DROP|ALTER|UPDATE|DELETE|INSERT)\b/i.test(m.sql), false, "no DROP / ALTER / data changes");
});

test("schema.prisma keeps registrationNumber String? (no @unique) and status Int @default(0)", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const block = schema.match(new RegExp(`^model ${TABLE} \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(block, `model ${TABLE} exists`);
  const fields = block[0].split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim().replace(/\s+/g, " "));
  assert.ok(fields.includes("registrationNumber String?"), "registrationNumber must stay `String?` without attributes");
  assert.ok(fields.includes("status Int @default(0)"), "status must stay `Int @default(0)`");
  assert.equal(fields.some((l) => /@@unique\(\[[^\]]*registrationNumber/.test(l)), false, "no Prisma unique on registrationNumber (the partial index is the rule)");
});

test("the manual-SQL rule is documented", () => {
  const doc = path.join(root, "docs", "student-registration-number-index.md");
  assert.ok(fs.existsSync(doc), "docs/student-registration-number-index.md exists");
  const text = fs.readFileSync(doc, "utf8");
  assert.ok(text.includes(INDEX));
  assert.ok(text.includes("migrate diff"));
});
