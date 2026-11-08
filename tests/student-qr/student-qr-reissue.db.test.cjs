/*
 * Secret rotation / system reissuance (services/student-qr-reissue-service.ts
 * and scripts/student-qr-reissue.ts) against a REAL, THROWAWAY PostgreSQL.
 *
 *   STUDENT_QR_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55433/qr_t4 npm run test:student-qr-db
 *
 * Same safety rules as student-qr-service.db.test.cjs: SKIPPED unless the
 * variable is set; refuses non-local hosts and database names that do not
 * start with "qr_" or contain "test"; DATABASE_URL is overwritten before
 * Prisma loads. The reissue works on EVERY active token of the database, so
 * the file refuses to run if the database holds active tokens it did not
 * create, and the DB test files run one at a time (--test-concurrency=1).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const url = process.env.STUDENT_QR_TEST_DATABASE_URL;
let skip = "set STUDENT_QR_TEST_DATABASE_URL to a throwaway local database to run these tests";
if (url) {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("Refusing to run: STUDENT_QR_TEST_DATABASE_URL must point at localhost.");
  }
  if (!/^qr_|test/i.test(dbName)) {
    throw new Error('Refusing to run: the test database name must start with "qr_" or contain "test".');
  }
  skip = false;
  process.env.DATABASE_URL = url;
}

const root = path.resolve(__dirname, "..", "..");
const OLD = crypto.createHash("sha512").update("qr reissue test OLD secret").digest("base64");
const NEW = crypto.createHash("sha512").update("qr reissue test NEW secret").digest("base64");
const JWT = crypto.createHash("sha512").update("qr reissue test JWT secret").digest("base64");
process.env.STUDENT_QR_SECRET = OLD; // the "running application" uses the old secret
process.env.JWT_SECRET = JWT;

let svc;
let reissue;
let prisma;
if (!skip) {
  require("../helpers/server-only.cjs");
  require("tsx/cjs/api").register();
  ({ prisma } = require(path.join(root, "lib", "prisma.ts")));
  svc = require(path.join(root, "services", "student-qr-service.ts"));
  reissue = require(path.join(root, "services", "student-qr-reissue-service.ts"));
}

const PREFIX = "qrrot-";
const T1 = `${PREFIX}teacher-1`;
let counter = 0;

async function newStudent() {
  counter += 1;
  const id = `${PREFIX}student-${process.pid}-${counter}`;
  await prisma.$executeRaw`
    INSERT INTO "Student" ("id", "name", "teacherId", "contact", "status", "gradeId")
    VALUES (${id}, ${"Rotation Student " + counter}, ${T1}, '0700000000', 0, NULL)`;
  return id;
}

const asStudent = (id) => ({ role: "STUDENT", id });
const allRows = () =>
  prisma.studentQrToken.findMany({ where: { studentId: { startsWith: PREFIX } }, orderBy: [{ studentId: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
const activeRows = () => prisma.studentQrToken.findMany({ where: { studentId: { startsWith: PREFIX }, revokedAt: null } });

const run = (mode, overrides = {}) =>
  reissue.reissueStudentQrTokens({ mode, oldSecretText: OLD, newSecretText: NEW, jwtSecret: JWT, ...overrides });

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "StudentQrReissueError", error.stack);
    assert.equal(error.code, code);
    for (const secret of [OLD, NEW, JWT]) {
      assert.ok(!String(error.message).includes(secret) && !String(error.detail ?? "").includes(secret));
    }
    return true;
  });
}

/** Fresh fixture: 4 students with QR tokens (one with regeneration history), 1 without. */
async function fixture() {
  await cleanup();
  await prisma.$executeRaw`INSERT INTO "Teacher" ("id", "name", "email", "password") VALUES (${T1}, 'Rotation Teacher', ${T1 + "@example.test"}, 'x')`;
  const students = [];
  for (let i = 0; i < 4; i += 1) {
    const s = await newStudent();
    await svc.getOrCreateActiveToken(s, asStudent(s));
    students.push(s);
  }
  // Regeneration history on the first student (2 REGENERATE rows).
  await svc.regenerateToken(students[0], asStudent(students[0]));
  await svc.regenerateToken(students[0], { role: "TEACHER", id: T1 });
  const withoutQr = await newStudent();
  return { students, withoutQr };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qrrot_fail ON "StudentQrToken"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS qrrot_fail()`);
  await prisma.$executeRaw`DELETE FROM "StudentQrToken" WHERE "studentId" LIKE ${PREFIX + "%"}`;
  await prisma.$executeRaw`DELETE FROM "Student" WHERE "id" LIKE ${PREFIX + "%"}`;
  await prisma.$executeRaw`DELETE FROM "Teacher" WHERE "id" LIKE ${PREFIX + "%"}`;
}

test.describe("student QR secret rotation (throwaway PostgreSQL)", { skip }, () => {
  test.before(async () => {
    await cleanup();
    const [{ foreign }] = await prisma.$queryRaw`
      SELECT count(*)::int AS "foreign" FROM "StudentQrToken" WHERE "revokedAt" IS NULL AND "studentId" NOT LIKE ${PREFIX + "%"}`;
    if (foreign > 0) throw new Error(`Refusing to run: the database holds ${foreign} active QR token(s) not created by this test.`);
  });
  test.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  test.beforeEach(() => {
    process.env.STUDENT_QR_SECRET = OLD;
  });

  // ------------------------------------------------------------ dry run

  test("dry run: classifies every active token and writes nothing", async () => {
    await fixture();
    const before = await allRows();
    const [{ xact: xactBefore }] = await prisma.$queryRaw`SELECT pg_current_xact_id_if_assigned() IS NULL AS "xact"`;
    const report = await run("dry-run");
    assert.deepEqual(report, {
      mode: "dry-run",
      activeTokens: 4,
      eligible: 4,
      alreadyReissued: 0,
      unverifiable: 0,
      reissued: 0,
      lockedStudents: 0,
    });
    assert.deepEqual(await allRows(), before, "no row changed");
    assert.equal(xactBefore, true);
  });

  test("dry run is a READ ONLY transaction (a write inside it would fail)", async () => {
    const source = require("node:fs").readFileSync(path.join(root, "services", "student-qr-reissue-service.ts"), "utf8");
    assert.match(source, /if \(options\.mode === "dry-run"\) \{\s*return prisma\.\$transaction\(async \(tx\) => \{\s*await tx\.\$executeRawUnsafe\("SET TRANSACTION READ ONLY"\);/);
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRaw`UPDATE "StudentQrToken" SET "revokedAt" = "revokedAt" WHERE false`;
      }),
      /read-only|25006/i
    );
  });

  // ------------------------------------------------------------ refusals

  test("invalid or wrong OLD secret refuses (both modes) without writes", async () => {
    await fixture();
    const before = await allRows();
    for (const mode of ["dry-run", "execute"]) {
      await rejectsCode(run(mode, { oldSecretText: undefined }), "OLD_SECRET_INVALID");
      await rejectsCode(run(mode, { oldSecretText: "too-short" }), "OLD_SECRET_INVALID");
      await rejectsCode(run(mode, { oldSecretText: JWT }), "OLD_SECRET_INVALID");
    }
    // A valid secret that is not the one in use: every token is unverifiable.
    const wrongOld = crypto.randomBytes(48).toString("base64");
    const dry = await run("dry-run", { oldSecretText: wrongOld });
    assert.equal(dry.unverifiable, 4);
    assert.equal(dry.eligible, 0);
    await rejectsCode(run("execute", { oldSecretText: wrongOld }), "UNVERIFIABLE_TOKENS");
    assert.deepEqual(await allRows(), before);
  });

  test("invalid NEW secret, NEW = JWT_SECRET and identical secrets are refused without writes", async () => {
    await fixture();
    const before = await allRows();
    for (const mode of ["dry-run", "execute"]) {
      await rejectsCode(run(mode, { newSecretText: undefined }), "NEW_SECRET_INVALID");
      await rejectsCode(run(mode, { newSecretText: "A".repeat(64) }), "NEW_SECRET_INVALID");
      await rejectsCode(run(mode, { newSecretText: JWT }), "NEW_SECRET_INVALID");
      await rejectsCode(run(mode, { newSecretText: OLD }), "SECRETS_IDENTICAL");
      await rejectsCode(run(mode, { newSecretText: ` ${OLD}\n` }), "SECRETS_IDENTICAL");
      // Same key bytes in another encoding (base64url) is the same secret.
      const sameKeyOtherEncoding = Buffer.from(OLD, "base64").toString("base64url");
      await rejectsCode(run(mode, { newSecretText: sameKeyOtherEncoding }), "SECRETS_IDENTICAL");
    }
    assert.deepEqual(await allRows(), before);
  });

  // ------------------------------------------------------------ execute

  test("execute: every active token replaced, SYSTEM_REISSUE audit, history kept, old QRs invalid", async () => {
    const { students, withoutQr } = await fixture();
    const before = await allRows();
    const oldActive = before.filter((r) => r.revokedAt === null);
    const oldPayloads = [];
    for (const s of students) oldPayloads.push((await svc.getActiveToken(s, asStudent(s))).payload);
    const statusBefore = await svc.getQrStatus(students[0]);
    const started = Date.now();

    const report = await run("execute");
    assert.equal(report.mode, "execute");
    assert.equal(report.activeTokens, 4);
    assert.equal(report.eligible, 4);
    assert.equal(report.reissued, 4);
    assert.equal(report.unverifiable, 0);
    assert.ok(report.lockedStudents >= 5);

    const after = await allRows();
    assert.equal(after.length, before.length + 4, "one replacement per active token, nothing else");
    const newActive = after.filter((r) => r.revokedAt === null);
    assert.equal(newActive.length, 4);
    assert.deepEqual(newActive.map((r) => r.studentId).sort(), [...students].sort(), "one active per student; none for the student without a QR");
    assert.ok(!newActive.some((r) => r.studentId === withoutQr));

    for (const old of oldActive) {
      const row = after.find((r) => r.id === old.id);
      assert.ok(row.revokedAt instanceof Date && row.revokedAt.getTime() >= started - 1000);
      assert.equal(row.revokedByRole, "SYSTEM");
      assert.equal(row.revokedById, null);
      assert.equal(row.revokedReason, "SYSTEM_REISSUE");
      assert.equal(row.nonce, old.nonce, "revoked rows keep their data");
      assert.equal(row.tokenHash, old.tokenHash);
    }
    for (const row of newActive) {
      assert.equal(row.reason, "SYSTEM_REISSUE");
      assert.equal(row.createdByRole, "SYSTEM");
      assert.equal(row.createdById, null);
      assert.ok(!oldActive.some((o) => o.id === row.id || o.nonce === row.nonce || o.tokenHash === row.tokenHash));
      assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    // Real UTC digits, same instant for revocation and replacement.
    const [{ digits }] = await prisma.$queryRaw`
      SELECT to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS digits FROM "StudentQrToken" WHERE "id" = ${newActive[0].id}`;
    assert.equal(`${digits}Z`, newActive[0].createdAt.toISOString());
    assert.equal(after.find((r) => r.id === oldActive[0].id).revokedAt.getTime(), newActive[0].createdAt.getTime());

    // Regeneration history untouched; SYSTEM_REISSUE does not count.
    const regenerateRows = (rows) => rows.filter((r) => r.reason === "REGENERATE").map(({ id, createdByRole, createdById, createdAt }) => ({ id, createdByRole, createdById, createdAt }));
    assert.deepEqual(regenerateRows(after), regenerateRows(before));
    const historyRevoked = after.filter((r) => r.revokedReason === "REGENERATE");
    assert.equal(historyRevoked.length, 2, "earlier REGENERATE revocations keep their audit");
    const statusAfter = await svc.getQrStatus(students[0]);
    assert.equal(statusAfter.regenerationsUsed, statusBefore.regenerationsUsed);

    // Until the app switches: the current (old) secret cannot render the new QRs — never reissued.
    await assert.rejects(svc.getActiveToken(students[1], asStudent(students[1])), (e) => e.code === "QR_TOKEN_UNVERIFIABLE");

    // After switching the app to the new secret: new QRs render and resolve; old ones are invalid.
    process.env.STUDENT_QR_SECRET = NEW;
    for (let i = 0; i < students.length; i += 1) {
      const current = await svc.getActiveToken(students[i], asStudent(students[i]));
      assert.notEqual(current.payload, oldPayloads[i]);
      assert.equal(current.reason, "SYSTEM_REISSUE");
      assert.equal((await svc.resolveQrPayload(current.payload)).studentId, students[i]);
      await assert.rejects(svc.resolveQrPayload(oldPayloads[i]), (e) => e.code === "INVALID_QR_PAYLOAD");
    }
    // Normal operations continue under the new secret.
    const regenerated = await svc.regenerateToken(students[1], asStudent(students[1]));
    assert.equal((await svc.resolveQrPayload(regenerated.payload)).studentId, students[1]);
  });

  test("re-running after a completed rotation changes nothing (no duplicate replacements)", async () => {
    await fixture();
    await run("execute");
    const afterFirst = await allRows();
    const dry = await run("dry-run");
    assert.equal(dry.eligible, 0);
    assert.equal(dry.alreadyReissued, 4);
    const second = await run("execute");
    assert.equal(second.reissued, 0);
    assert.equal(second.alreadyReissued, 4);
    assert.deepEqual(await allRows(), afterFirst);
  });

  test("failure rolls back completely: no token revoked, no replacement kept, no row detail in the error", async () => {
    const { students } = await fixture();
    const before = await allRows();
    // Fail the replacement insert of one student, after others in the same chunk.
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION qrrot_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."reason" = 'SYSTEM_REISSUE' AND NEW."studentId" = '${students[2]}' THEN
          RAISE EXCEPTION 'qrrot: simulated insert failure';
        END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER qrrot_fail BEFORE INSERT ON "StudentQrToken" FOR EACH ROW EXECUTE FUNCTION qrrot_fail()`);
    try {
      await assert.rejects(run("execute"), (error) => {
        assert.equal(error.code, "REISSUE_DATABASE_ERROR");
        assert.match(error.message, /rolled back completely/);
        assert.doesNotMatch(error.message, /simulated|Failing row|[0-9a-f]{64}/);
        return true;
      });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qrrot_fail ON "StudentQrToken"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS qrrot_fail()`);
    }
    assert.deepEqual(await allRows(), before, "everything rolled back");
    // The application keeps working with the old secret; a later run succeeds.
    assert.equal((await svc.getActiveToken(students[0], asStudent(students[0]))).reason, "REGENERATE");
    assert.equal((await run("execute")).reissued, 4);
  });

  // ------------------------------------------------------------ concurrency

  test("concurrent issuance / regeneration wait for the rotation and are caught up, never missed", async () => {
    const { students, withoutQr } = await fixture();
    let pending;
    let settledDuringLock = null;
    const report = await reissue.reissueStudentQrTokens({
      mode: "execute",
      oldSecretText: OLD,
      newSecretText: NEW,
      jwtSecret: JWT,
      afterLockForTests: async () => {
        // The application (still on the OLD secret) acts while the rotation holds its locks.
        let settled = 0;
        pending = Promise.all([
          svc.getOrCreateActiveToken(withoutQr, asStudent(withoutQr)).finally(() => (settled += 1)),
          svc.regenerateToken(students[3], { role: "TEACHER", id: T1 }).finally(() => (settled += 1)),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 800));
        settledDuringLock = settled;
      },
    });
    assert.equal(settledDuringLock, 0, "both QR operations were blocked by the rotation's locks");
    assert.equal(report.reissued, 4, "the snapshot after locking contains the 4 tokens");
    const [issued, regenerated] = await pending;
    assert.equal(issued.reason, "ISSUE");
    assert.equal(regenerated.reason, "REGENERATE");

    // They ran after the commit with the OLD secret: a catch-up run sees exactly them.
    let dry = await run("dry-run");
    assert.equal(dry.unverifiable, 0, "nothing missed or unverifiable");
    assert.equal(dry.eligible, 2);
    assert.equal(dry.alreadyReissued, 3);
    const catchUp = await run("execute");
    assert.equal(catchUp.reissued, 2);

    dry = await run("dry-run");
    assert.equal(dry.eligible, 0);
    assert.equal(dry.unverifiable, 0);
    assert.equal(dry.alreadyReissued, 5);
    const active = await activeRows();
    assert.equal(active.length, 5);
    assert.equal(new Set(active.map((r) => r.studentId)).size, 5, "one active token per student");
    assert.ok(active.every((r) => r.reason === "SYSTEM_REISSUE"));
  });

  // ------------------------------------------------------------ CLI

  test("CLI: env-only secrets, explicit confirmation, database check, counts only (no secret in output)", async () => {
    await fixture();
    const cli = (args, env = {}) => {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "--conditions=react-server", path.join(root, "scripts", "student-qr-reissue.ts"), ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: url, STUDENT_QR_SECRET_OLD: OLD, STUDENT_QR_SECRET_NEW: NEW, JWT_SECRET: JWT, ...env },
        }
      );
      const output = `${result.stdout}\n${result.stderr}`;
      for (const secret of [OLD, NEW, JWT]) assert.ok(!output.includes(secret), "no secret in the output");
      assert.doesNotMatch(output, /[0-9a-f]{64}/, "no hash in the output");
      return { status: result.status, output };
    };
    const dbName = new URL(url).pathname.slice(1);
    const before = await allRows();

    const pasted = cli([OLD]);
    assert.equal(pasted.status, 2);
    assert.match(pasted.output, /Unknown argument \(value not shown\)/);

    const dry = cli([]);
    assert.equal(dry.status, 0, dry.output);
    assert.match(dry.output, /DRY RUN \(no writes\)/);
    assert.match(dry.output, /verify with the OLD secret:\s+4 \(would be reissued\)/);
    assert.match(dry.output, /target database: 127\.0\.0\.1:\d+\//);
    assert.doesNotMatch(dry.output, /qrtest@|password/i, "no credentials");

    assert.equal(cli(["--execute"]).status, 2, "confirmation flag required");
    assert.equal(cli(["--execute", "--confirm-reissue-all-student-qr"]).status, 2, "database confirmation required");
    assert.equal(cli(["--execute", "--confirm-reissue-all-student-qr", "--confirm-database=some_other_db"]).status, 2);
    assert.equal(cli(["--execute", "--confirm-reissue-all-student-qr", `--confirm-database=${dbName}`], { STUDENT_QR_SECRET_NEW: OLD }).status, 1, "identical secrets");
    assert.deepEqual(await allRows(), before, "no refused invocation wrote anything");

    const done = cli(["--execute", "--confirm-reissue-all-student-qr", `--confirm-database=${dbName}`]);
    assert.equal(done.status, 0, done.output);
    assert.match(done.output, /reissued in this run:\s+4/);
    assert.match(done.output, /switch the application to the new secret and run this again/);
    const again = cli(["--execute", "--confirm-reissue-all-student-qr", `--confirm-database=${dbName}`]);
    assert.equal(again.status, 0);
    assert.match(again.output, /Nothing to reissue/);
  });
});
