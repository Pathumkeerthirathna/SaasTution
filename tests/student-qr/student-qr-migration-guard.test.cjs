/*
 * Static guard for the student QR token migration (no database needed).
 *
 *   npm run test:student-qr
 *
 * The migration holds hand-written SQL Prisma cannot express (CHECK
 * constraints and a partial unique index: one active token per student). A
 * later `prisma migrate dev` may report the index as drift and generate a
 * DROP INDEX. This test fails if any of that is lost or altered, if the
 * migration ever becomes destructive, if a database timestamp default sneaks
 * in, or if a column for the raw token appears.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261108150000_add_student_qr_tokens";
const INDEX = "StudentQrToken_one_active_per_student";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

const read = (name) => normalize(fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));
const sql = read(MIGRATION);
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const modelBlock = (schema.match(/model StudentQrToken \{[\s\S]*?\n\}/) ?? [""])[0];

test("the partial unique index is created exactly once, with the exact definition", () => {
  assert.ok(
    sql.includes(`CREATE UNIQUE INDEX "${INDEX}" ON "StudentQrToken" ("studentId") WHERE "revokedAt" IS NULL;`)
  );
  assert.equal(sql.split(INDEX).length - 1, 1, "mentioned once in its own migration");
  const others = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== MIGRATION)
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(migrationsDir, name, "migration.sql")))
    .filter((name) => read(name).includes(INDEX));
  assert.deepEqual(others, [], "no other migration may drop, alter or recreate it");
});

test("tokenHash is globally unique", () => {
  assert.ok(sql.includes(`CREATE UNIQUE INDEX "StudentQrToken_tokenHash_key" ON "StudentQrToken"("tokenHash");`));
  assert.match(modelBlock, /tokenHash\s+String\s+@unique/);
});

test("CHECK constraints keep roles, creators, nonces and hashes well-formed", () => {
  assert.ok(sql.includes(`CHECK ("createdByRole" IN ('STUDENT', 'TEACHER', 'SYSTEM'))`));
  assert.ok(sql.includes(`CHECK ("createdByRole" = 'SYSTEM' OR "createdById" IS NOT NULL)`));
  assert.ok(sql.includes(`CHECK ("nonce" ~ '^[A-Za-z0-9_-]{43}$')`));
  assert.ok(sql.includes(`CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')`));
  assert.ok(sql.includes(`CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")`));
});

test("revocation audit fields are nullable and kept consistent by CHECKs", () => {
  assert.ok(sql.includes(`"revokedByRole" TEXT, "revokedById" TEXT, "revokedReason" TEXT,`));
  assert.match(modelBlock, /revokedByRole String\?/);
  assert.match(modelBlock, /revokedById\s+String\?/);
  assert.match(modelBlock, /revokedReason String\?/);
  assert.ok(sql.includes(`CHECK ("revokedByRole" IS NULL OR "revokedByRole" IN ('STUDENT', 'TEACHER', 'SYSTEM'))`));
  assert.ok(sql.includes(`CHECK ("revokedReason" IS NULL OR "revokedReason" IN ('REGENERATE', 'SYSTEM_REISSUE'))`));
  assert.ok(
    sql.includes(
      `CHECK ( ("revokedAt" IS NULL AND "revokedByRole" IS NULL AND "revokedById" IS NULL AND "revokedReason" IS NULL) ` +
        `OR ("revokedAt" IS NOT NULL AND "revokedByRole" IS NOT NULL AND "revokedReason" IS NOT NULL ` +
        `AND ("revokedByRole" = 'SYSTEM' OR "revokedById" IS NOT NULL) ` +
        `AND (("revokedReason" = 'SYSTEM_REISSUE') = ("revokedByRole" = 'SYSTEM'))) );`
    )
  );
});

test("timestamps have no database default (the application writes real UTC)", () => {
  assert.ok(sql.includes(`"createdAt" TIMESTAMP(3) NOT NULL,`));
  assert.ok(sql.includes(`"revokedAt" TIMESTAMP(3),`));
  assert.doesNotMatch(sql, /\bDEFAULT\b/i);
  assert.doesNotMatch(sql, /CURRENT_TIMESTAMP|\bnow\(\)/i);
  assert.doesNotMatch(modelBlock, /createdAt[^\n]*@default/);
  assert.doesNotMatch(modelBlock, /revokedAt[^\n]*@default/);
});

test("the raw QR token is never stored", () => {
  const table = (sql.match(/CREATE TABLE "StudentQrToken" \(([^;]*)\);/) ?? [])[1] ?? "";
  const columns = [...table.matchAll(/(?:^\s*|, )"([A-Za-z]+)" (?:TEXT|TIMESTAMP|")/g)].map((m) => m[1]);
  assert.deepEqual(columns, [
    "id",
    "studentId",
    "nonce",
    "tokenHash",
    "reason",
    "createdAt",
    "createdByRole",
    "createdById",
    "revokedAt",
    "revokedByRole",
    "revokedById",
    "revokedReason",
  ]);
  assert.doesNotMatch(modelBlock, /^\s*(token|qrToken|payload|secret)\s/m);
});

test("the migration is additive only and changes no existing data", () => {
  // Foreign-key actions (ON DELETE / ON UPDATE ...) are not data changes.
  const statements = sql.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL|RESTRICT|NO ACTION)/g, " ");
  assert.doesNotMatch(statements, /\bDROP\b/i);
  assert.doesNotMatch(statements, /\bDELETE\b/i);
  assert.doesNotMatch(statements, /\bUPDATE\b/i);
  assert.doesNotMatch(sql, /\bINSERT\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /ALTER COLUMN/i);
  assert.doesNotMatch(sql, /RENAME/i);
  for (const statement of sql.split(";").filter((s) => /ALTER TABLE/.test(s))) {
    assert.match(statement, /ALTER TABLE "StudentQrToken" ADD CONSTRAINT/, statement);
  }
});

test("schema.prisma declares the enum, model and relation but not the partial index", () => {
  assert.match(schema, /enum StudentQrTokenReason \{\s*(\/\/\/[^\n]*\s*)*ISSUE\s*(\/\/\/[^\n]*\s*)*REGENERATE\s*(\/\/\/[^\n]*\s*)*SYSTEM_REISSUE\s*\}/);
  assert.ok(modelBlock, "model StudentQrToken exists");
  assert.match(modelBlock, /@relation\(fields: \[studentId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(schema, /qrTokens\s+StudentQrToken\[\]/);
  assert.doesNotMatch(modelBlock, /@@unique\(\[studentId\]\)/);
  assert.doesNotMatch(modelBlock, /studentId\s+String\s+@unique/);
});

test("the documentation covers the secret, rotation and the manual SQL", () => {
  const doc = fs.readFileSync(path.join(root, "docs", "student-qr-identity.md"), "utf8");
  assert.match(doc, new RegExp(INDEX));
  assert.match(doc, /STUDENT_QR_SECRET/);
  assert.match(doc, /at least \*\*32 random bytes\*\*/);
  assert.match(doc, /server-only/);
  assert.match(doc, /explicit administrative operation/);
  assert.match(doc, /Normal QR rendering \*\*never\*\* creates new\s+tokens/);
});
