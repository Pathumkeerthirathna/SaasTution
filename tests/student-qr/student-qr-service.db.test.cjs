/*
 * services/student-qr-service.ts against a REAL, THROWAWAY PostgreSQL
 * (row locks, the partial unique index and the CHECK constraints only exist
 * there).
 *
 *   STUDENT_QR_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55433/qr_t4 npm run test:student-qr-db
 *
 * The database must already contain the schema including migration
 * 20261108150000_add_student_qr_tokens. Safety: the whole file is SKIPPED
 * unless STUDENT_QR_TEST_DATABASE_URL is set, and refuses any host other than
 * localhost / 127.0.0.1 and any database whose name does not start with
 * "qr_" or contain "test". DATABASE_URL is overwritten before Prisma loads,
 * so the project's .env database is never used. Every row it creates belongs
 * to teachers / students with the "qrtest-" id prefix and is deleted after.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

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
  process.env.DATABASE_URL = url; // before Prisma loads: .env never overrides it
}

const SECRET_A = crypto.createHash("sha512").update("qr service test secret A").digest("base64");
const SECRET_B = crypto.createHash("sha512").update("qr service test secret B").digest("base64");
process.env.STUDENT_QR_SECRET = SECRET_A;

let svc;
let prisma;
if (!skip) {
  require("../helpers/server-only.cjs");
  require("tsx/cjs/api").register();
  const root = path.resolve(__dirname, "..", "..");
  ({ prisma } = require(path.join(root, "lib", "prisma.ts")));
  svc = require(path.join(root, "services", "student-qr-service.ts"));
}

const PREFIX = "qrtest-";
const T1 = `${PREFIX}teacher-1`;
const T2 = `${PREFIX}teacher-2`;
let counter = 0;

async function newStudent({ teacherId = T1, status = 0 } = {}) {
  counter += 1;
  const id = `${PREFIX}student-${process.pid}-${counter}`;
  await prisma.$executeRaw`
    INSERT INTO "Student" ("id", "name", "teacherId", "contact", "registrationNumber", "status", "gradeId")
    VALUES (${id}, ${"Test Student " + counter}, ${teacherId}, '0700000000', ${"REG-" + counter}, ${status}, NULL)`;
  return id;
}

const tokens = (studentId) =>
  prisma.studentQrToken.findMany({ where: { studentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

const asStudent = (id) => ({ role: "STUDENT", id });
const asTeacher = (id) => ({ role: "TEACHER", id });

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "StudentQrServiceError", error.stack);
    assert.equal(error.code, code);
    return true;
  });
}

/** Inserts a consistent, already revoked REGENERATE row `hoursAgo` in the past. */
async function seedPastRegeneration(studentId, hoursAgo, role = "STUDENT", by = studentId) {
  const createdAt = new Date(Date.now() - hoursAgo * 3600 * 1000);
  await prisma.studentQrToken.create({
    data: {
      id: crypto.randomUUID(),
      studentId,
      nonce: crypto.randomBytes(32).toString("base64url"),
      tokenHash: crypto.randomBytes(32).toString("hex"),
      reason: "REGENERATE",
      createdAt,
      createdByRole: role,
      createdById: by,
      revokedAt: createdAt,
      revokedByRole: role,
      revokedById: by,
      revokedReason: "REGENERATE",
    },
  });
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qrtest_fail_regenerate ON "StudentQrToken"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS qrtest_fail_regenerate()`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qrtest_slow_regenerate ON "StudentQrToken"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS qrtest_slow_regenerate()`);
  await prisma.$executeRaw`DELETE FROM "StudentLoginHistory" WHERE "studentId" LIKE ${PREFIX + "%"}`;
  await prisma.$executeRaw`DELETE FROM "StudentQrToken" WHERE "studentId" LIKE ${PREFIX + "%"}`;
  await prisma.$executeRaw`DELETE FROM "Student" WHERE "id" LIKE ${PREFIX + "%"}`;
  await prisma.$executeRaw`DELETE FROM "Teacher" WHERE "id" LIKE ${PREFIX + "%"}`;
}

test.describe("student QR service (throwaway PostgreSQL)", { skip }, () => {
  test.before(async () => {
    await cleanup();
    for (const id of [T1, T2]) {
      await prisma.$executeRaw`
        INSERT INTO "Teacher" ("id", "name", "email", "password") VALUES (${id}, ${id}, ${id + "@example.test"}, 'x')`;
    }
  });
  test.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  test.beforeEach(() => {
    process.env.STUDENT_QR_SECRET = SECRET_A;
  });

  // ------------------------------------------------------------ issuance

  test("first view issues one ISSUE token (real UTC, creator recorded); later views are idempotent", async () => {
    const s = await newStudent();
    const before = Date.now();
    const first = await svc.getOrCreateActiveToken(s, asStudent(s));
    const after = Date.now();

    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.payload, `SLCQR1:${first.token}`);
    assert.equal(first.reason, "ISSUE");
    assert.ok(first.createdAt.getTime() >= before - 1 && first.createdAt.getTime() <= after + 1);

    const again = await svc.getOrCreateActiveToken(s, asTeacher(T1));
    assert.equal(again.token, first.token);

    const rows = await tokens(s);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.reason, "ISSUE");
    assert.equal(row.createdByRole, "STUDENT");
    assert.equal(row.createdById, s);
    assert.equal(row.revokedAt, null);
    assert.match(row.id, /^[0-9a-f-]{36}$/);
    assert.match(row.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(row.tokenHash, crypto.createHash("sha256").update(first.token).digest("hex"));

    // Stored digits are UTC even though the server session runs Europe/Berlin.
    const [{ digits, tz }] = await prisma.$queryRaw`
      SELECT to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS digits, current_setting('TimeZone') AS tz
      FROM "StudentQrToken" WHERE "id" = ${row.id}`;
    assert.equal(`${digits}Z`, row.createdAt.toISOString(), `session TimeZone ${tz}`);

    // The raw token is stored nowhere.
    const [{ hits }] = await prisma.$queryRaw`
      SELECT count(*)::int AS hits FROM "StudentQrToken" t WHERE t::text LIKE ${"%" + first.token + "%"}`;
    assert.equal(hits, 0);

    // Issuance does not count towards the regeneration limit.
    const status = await svc.getQrStatus(s);
    assert.equal(status.regenerationsUsed, 0);
    assert.equal(status.hasActiveToken, true);
  });

  test("getActiveToken is read-only: QR_TOKEN_NOT_FOUND before issuance, never writes, same rules", async () => {
    const s = await newStudent();
    await rejectsWith(svc.getActiveToken(s, asStudent(s)), "QR_TOKEN_NOT_FOUND");
    await rejectsWith(svc.getActiveToken(s, asTeacher(T1)), "QR_TOKEN_NOT_FOUND");
    await rejectsWith(svc.getActiveToken(s, asTeacher(T2)), "STUDENT_NOT_FOUND");
    await rejectsWith(svc.getActiveToken(s, { role: "ADMIN", id: "x" }), "INVALID_QR_ACTOR");
    assert.equal((await tokens(s)).length, 0, "nothing was issued");

    const issued = await svc.getOrCreateActiveToken(s, asStudent(s));
    const read = await svc.getActiveToken(s, asTeacher(T1));
    assert.equal(read.token, issued.token);
    await rejectsWith(svc.getActiveToken(s, asTeacher(T2)), "STUDENT_NOT_FOUND");

    process.env.STUDENT_QR_SECRET = SECRET_B;
    const before = await tokens(s);
    await rejectsWith(svc.getActiveToken(s, asStudent(s)), "QR_TOKEN_UNVERIFIABLE");
    assert.deepEqual(await tokens(s), before, "a mismatch is never reissued");
  });

  test("concurrent first views issue exactly one token", async () => {
    const s = await newStudent();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => svc.getOrCreateActiveToken(s, i % 2 ? asStudent(s) : asTeacher(T1)))
    );
    assert.equal(new Set(results.map((r) => r.token)).size, 1);
    const rows = await tokens(s);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "ISSUE");
  });

  test("the partial unique index rejects a second active token (the backstop)", async () => {
    const s = await newStudent();
    await svc.getOrCreateActiveToken(s, asStudent(s));
    await assert.rejects(
      prisma.studentQrToken.create({
        data: {
          id: crypto.randomUUID(),
          studentId: s,
          nonce: crypto.randomBytes(32).toString("base64url"),
          tokenHash: crypto.randomBytes(32).toString("hex"),
          reason: "ISSUE",
          createdAt: new Date(),
          createdByRole: "SYSTEM",
        },
      }),
      (error) => error.code === "P2002"
    );
  });

  // ------------------------------------------------------------ regeneration

  test("regeneration revokes with all four audit fields and inserts a REGENERATE replacement", async () => {
    const s = await newStudent();
    const original = await svc.getOrCreateActiveToken(s, asStudent(s));
    const replaced = await svc.regenerateToken(s, asTeacher(T1));

    assert.notEqual(replaced.token, original.token);
    assert.equal(replaced.reason, "REGENERATE");
    assert.equal((await svc.getOrCreateActiveToken(s, asStudent(s))).token, replaced.token);

    const [old, current] = await tokens(s);
    assert.ok(old.revokedAt instanceof Date);
    assert.ok(old.revokedAt.getTime() >= old.createdAt.getTime());
    assert.equal(old.revokedByRole, "TEACHER");
    assert.equal(old.revokedById, T1);
    assert.equal(old.revokedReason, "REGENERATE");

    assert.equal(current.reason, "REGENERATE");
    assert.equal(current.createdByRole, "TEACHER");
    assert.equal(current.createdById, T1);
    assert.equal(current.revokedAt, null);
    assert.equal(current.revokedByRole, null);
    assert.equal(current.revokedById, null);
    assert.equal(current.revokedReason, null);
    assert.equal(current.createdAt.getTime(), old.revokedAt.getTime());

    // The old QR no longer resolves; the new one does.
    await rejectsWith(svc.resolveQrPayload(original.payload), "INVALID_QR_PAYLOAD");
    assert.equal((await svc.resolveQrPayload(replaced.payload)).studentId, s);
  });

  test("regenerating before any token exists fails with QR_TOKEN_NOT_FOUND (and counts nothing)", async () => {
    const s = await newStudent();
    await rejectsWith(svc.regenerateToken(s, asStudent(s)), "QR_TOKEN_NOT_FOUND");
    assert.equal((await tokens(s)).length, 0);
  });

  test("limit: 5 successful regenerations per rolling 24h, student and teacher combined", async () => {
    const s = await newStudent();
    await svc.getOrCreateActiveToken(s, asStudent(s));
    for (const actor of [asStudent(s), asTeacher(T1), asStudent(s), asTeacher(T1), asStudent(s)]) {
      await svc.regenerateToken(s, actor);
    }
    const activeBefore = await prisma.studentQrToken.findFirst({ where: { studentId: s, revokedAt: null } });

    for (const actor of [asStudent(s), asTeacher(T1)]) {
      await assert.rejects(svc.regenerateToken(s, actor), (error) => {
        assert.equal(error.code, "QR_REGENERATION_LIMIT");
        assert.equal(error.statusCode, 429);
        assert.equal(error.details.limit, 5);
        assert.ok(error.details.retryAfterSeconds > 23 * 3600 && error.details.retryAfterSeconds <= 24 * 3600);
        assert.ok(!Number.isNaN(Date.parse(error.details.retryAt)));
        return true;
      });
    }
    // A refused regeneration changes nothing.
    const activeAfter = await prisma.studentQrToken.findFirst({ where: { studentId: s, revokedAt: null } });
    assert.equal(activeAfter.id, activeBefore.id);
    assert.equal((await tokens(s)).length, 6);

    const status = await svc.getQrStatus(s);
    assert.equal(status.regenerationsUsed, 5);
    assert.equal(status.regenerationsRemaining, 0);
    assert.ok(status.nextRegenerationAt instanceof Date);
  });

  test("limit window is rolling: regenerations older than 24h no longer count", async () => {
    const s = await newStudent();
    await seedPastRegeneration(s, 30);
    await seedPastRegeneration(s, 25);
    await seedPastRegeneration(s, 23, "TEACHER", T1);
    await seedPastRegeneration(s, 2);
    await svc.getOrCreateActiveToken(s, asStudent(s));

    let status = await svc.getQrStatus(s);
    assert.equal(status.regenerationsUsed, 2);

    await svc.regenerateToken(s, asStudent(s));
    await svc.regenerateToken(s, asTeacher(T1));
    await svc.regenerateToken(s, asStudent(s));
    await assert.rejects(svc.regenerateToken(s, asStudent(s)), (error) => {
      assert.equal(error.code, "QR_REGENERATION_LIMIT");
      // Oldest counted one is 23h old: retry in about 1 hour.
      assert.ok(error.details.retryAfterSeconds > 3500 && error.details.retryAfterSeconds <= 3600, String(error.details.retryAfterSeconds));
      return true;
    });
    status = await svc.getQrStatus(s);
    assert.equal(status.regenerationsUsed, 5);
  });

  test("concurrent regenerations are serialised: exactly 5 succeed, one active token remains", async () => {
    const s = await newStudent();
    await svc.getOrCreateActiveToken(s, asStudent(s));
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, (_, i) => svc.regenerateToken(s, i % 2 ? asStudent(s) : asTeacher(T1)))
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 5);
    assert.ok(refused.every((r) => r.reason.code === "QR_REGENERATION_LIMIT"), refused.map((r) => r.reason.message).join(" | "));

    const rows = await tokens(s);
    assert.equal(rows.length, 6);
    assert.equal(rows.filter((r) => r.revokedAt === null).length, 1);
    assert.equal(rows.filter((r) => r.reason === "REGENERATE").length, 5);
    for (const r of rows.filter((x) => x.revokedAt !== null)) {
      assert.equal(r.revokedReason, "REGENERATE");
      assert.ok(["STUDENT", "TEACHER"].includes(r.revokedByRole));
      assert.ok(r.revokedById);
    }
  });

  test("rollback: if inserting the replacement fails, the revocation is undone", async () => {
    const s = await newStudent();
    const original = await svc.getOrCreateActiveToken(s, asStudent(s));
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION qrtest_fail_regenerate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."reason" = 'REGENERATE' AND NEW."studentId" LIKE 'qrtest-%' THEN
          RAISE EXCEPTION 'qrtest: simulated insert failure';
        END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER qrtest_fail_regenerate BEFORE INSERT ON "StudentQrToken"
      FOR EACH ROW EXECUTE FUNCTION qrtest_fail_regenerate()`);
    try {
      await assert.rejects(svc.regenerateToken(s, asStudent(s)), (error) => {
        // Sanitized: no PostgreSQL row detail (nonce / tokenHash) in the message.
        assert.match(error.message, /^Student QR database write failed \(.+\)\.$/);
        assert.ok(!/simulated|Failing row|[0-9a-f]{64}/.test(error.message + String(error.stack)));
        return true;
      });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qrtest_fail_regenerate ON "StudentQrToken"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS qrtest_fail_regenerate()`);
    }
    const rows = await tokens(s);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].revokedAt, null);
    assert.equal(rows[0].revokedByRole, null);
    assert.equal(rows[0].revokedReason, null);
    assert.equal((await svc.resolveQrPayload(original.payload)).studentId, s);
    assert.equal((await svc.getQrStatus(s)).regenerationsUsed, 0);
  });

  // ------------------------------------------------------------ actors

  test("invalid actors are rejected before any database write", async () => {
    const s = await newStudent();
    for (const actor of [
      undefined,
      null,
      {},
      { role: "ADMIN", id: "x" },
      { role: "STUDENT" },
      { role: "STUDENT", id: "" },
      { role: "TEACHER", id: "   " },
      { role: "TEACHER", id: 42 },
      { role: "SYSTEM", id: "someone" },
      "STUDENT",
    ]) {
      await rejectsWith(svc.getOrCreateActiveToken(s, actor), "INVALID_QR_ACTOR");
      await rejectsWith(svc.regenerateToken(s, actor), "INVALID_QR_ACTOR");
    }
    await svc.getOrCreateActiveToken(s, asStudent(s));
    await rejectsWith(svc.regenerateToken(s, { role: "SYSTEM" }), "INVALID_QR_ACTOR");
    assert.equal((await tokens(s)).length, 1);
  });

  test("a teacher only acts for owned students and a student only for itself (looks like not found)", async () => {
    const s = await newStudent({ teacherId: T1 });
    const other = await newStudent({ teacherId: T1 });
    await rejectsWith(svc.getOrCreateActiveToken(s, asTeacher(T2)), "STUDENT_NOT_FOUND");
    await rejectsWith(svc.getOrCreateActiveToken(s, asStudent(other)), "STUDENT_NOT_FOUND");
    assert.equal((await tokens(s)).length, 0);

    await svc.getOrCreateActiveToken(s, asStudent(s));
    await rejectsWith(svc.regenerateToken(s, asTeacher(T2)), "STUDENT_NOT_FOUND");
    await rejectsWith(svc.regenerateToken(s, asStudent(other)), "STUDENT_NOT_FOUND");
    assert.equal((await tokens(s)).length, 1);
  });

  test("unknown and deleted students are not found; a SYSTEM actor may issue", async () => {
    await rejectsWith(svc.getOrCreateActiveToken(`${PREFIX}missing`, { role: "SYSTEM" }), "STUDENT_NOT_FOUND");
    await rejectsWith(svc.getQrStatus(`${PREFIX}missing`), "STUDENT_NOT_FOUND");
    const deleted = await newStudent({ status: 2 });
    await rejectsWith(svc.getOrCreateActiveToken(deleted, asStudent(deleted)), "STUDENT_NOT_FOUND");

    const s = await newStudent();
    const issued = await svc.getOrCreateActiveToken(s, { role: "SYSTEM" });
    const [row] = await tokens(s);
    assert.equal(row.createdByRole, "SYSTEM");
    assert.equal(row.createdById, null);
    assert.equal((await svc.resolveQrPayload(issued.payload)).studentId, s);
  });

  // ------------------------------------------------------------ resolution

  test("a valid payload resolves to the minimum student identity only", async () => {
    const s = await newStudent();
    const issued = await svc.getOrCreateActiveToken(s, asStudent(s));
    const resolved = await svc.resolveQrPayload(issued.payload);
    assert.deepEqual(Object.keys(resolved).sort(), ["isActive", "name", "registrationNumber", "studentId", "teacherId"]);
    assert.equal(resolved.studentId, s);
    assert.equal(resolved.teacherId, T1);
    assert.equal(resolved.isActive, true);
    const text = JSON.stringify(resolved);
    const [row] = await tokens(s);
    for (const secretish of [issued.token, row.nonce, row.tokenHash, SECRET_A]) assert.ok(!text.includes(secretish));

    // Inactive (status 1) students still resolve, flagged; deleted ones do not.
    await prisma.student.update({ where: { id: s }, data: { status: 1 } });
    assert.equal((await svc.resolveQrPayload(issued.payload)).isActive, false);
    await prisma.student.update({ where: { id: s }, data: { status: 2 } });
    await rejectsWith(svc.resolveQrPayload(issued.payload), "INVALID_QR_PAYLOAD");
  });

  test("invalid payloads fail safely without touching the database", async () => {
    const valid = `SLCQR1:${crypto.randomBytes(32).toString("base64url")}`;
    for (const payload of [undefined, null, 42, "", "SLCQR1:", `slcqr1:${valid.slice(7)}`, `${valid} `, `${valid}x`, valid.slice(0, 49) + "+"]) {
      await rejectsWith(svc.resolveQrPayload(payload), "INVALID_QR_PAYLOAD");
    }
    // Well-formed but unknown.
    await rejectsWith(svc.resolveQrPayload(valid), "INVALID_QR_PAYLOAD");
  });

  test("revoked tokens are rejected", async () => {
    const s = await newStudent();
    const first = await svc.getOrCreateActiveToken(s, asStudent(s));
    await svc.regenerateToken(s, asStudent(s));
    await assert.rejects(svc.resolveQrPayload(first.payload), (error) => {
      assert.equal(error.code, "INVALID_QR_PAYLOAD");
      assert.equal(error.internalReason, "revoked");
      assert.ok(!error.message.includes(first.token));
      return true;
    });
  });

  test("secret rotation: tokens fail as unverifiable and are NEVER silently reissued", async () => {
    const s = await newStudent();
    const issued = await svc.getOrCreateActiveToken(s, asStudent(s));
    const rowsBefore = await tokens(s);

    process.env.STUDENT_QR_SECRET = SECRET_B;
    await rejectsWith(svc.getOrCreateActiveToken(s, asStudent(s)), "QR_TOKEN_UNVERIFIABLE");
    await rejectsWith(svc.resolveQrPayload(issued.payload), "QR_TOKEN_UNVERIFIABLE");
    assert.deepEqual(await tokens(s), rowsBefore, "no row was created, revoked or changed");

    process.env.STUDENT_QR_SECRET = SECRET_A;
    assert.equal((await svc.getOrCreateActiveToken(s, asStudent(s))).token, issued.token);
  });

  test("missing secret: QR_SECRET errors, no writes, status still readable", async () => {
    const s = await newStudent();
    delete process.env.STUDENT_QR_SECRET;
    try {
      await assert.rejects(svc.getOrCreateActiveToken(s, asStudent(s)), (error) => {
        assert.equal(error.code, "STUDENT_QR_NOT_CONFIGURED");
        assert.equal(error.statusCode, 503);
        assert.match(error.internalReason, /STUDENT_QR_SECRET is not set/);
        return true;
      });
      await rejectsWith(svc.regenerateToken(s, asStudent(s)), "STUDENT_QR_NOT_CONFIGURED");
      await rejectsWith(svc.resolveQrPayload(`SLCQR1:${crypto.randomBytes(32).toString("base64url")}`), "STUDENT_QR_NOT_CONFIGURED");
      const status = await svc.getQrStatus(s);
      assert.equal(status.configured, false);
      assert.equal(status.hasActiveToken, false);
      assert.equal((await tokens(s)).length, 0);
    } finally {
      process.env.STUDENT_QR_SECRET = SECRET_A;
    }
  });

  test("lock: FOR NO KEY UPDATE serialises QR operations but does not block foreign-key inserts", async () => {
    const s = await newStudent();
    await svc.getOrCreateActiveToken(s, asStudent(s));
    // Make the regeneration hold its Student lock for ~2 s (sleep inside the insert).
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION qrtest_slow_regenerate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."reason" = 'REGENERATE' AND NEW."studentId" LIKE 'qrtest-%' THEN PERFORM pg_sleep(2); END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER qrtest_slow_regenerate BEFORE INSERT ON "StudentQrToken"
      FOR EACH ROW EXECUTE FUNCTION qrtest_slow_regenerate()`);
    try {
      let settled = false;
      const regeneration = svc.regenerateToken(s, asStudent(s)).finally(() => {
        settled = true;
      });

      // Wait until the regeneration is inside its insert (lock held, sleeping).
      for (let i = 0; i < 100; i += 1) {
        const [{ n }] = await prisma.$queryRaw`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND datname = current_database()`;
        if (n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // 1. A foreign-key insert referencing the same Student (FOR KEY SHARE)
      //    succeeds immediately: it must not wait for the QR transaction.
      const started = Date.now();
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '500ms'`);
        await tx.$executeRaw`
          INSERT INTO "StudentLoginHistory" ("id", "studentId", "result") VALUES (${crypto.randomUUID()}, ${s}, 'SUCCESS')`;
      });
      assert.ok(Date.now() - started < 1000, "foreign-key insert was not blocked");
      assert.equal(settled, false, "the regeneration still held its lock during the insert");

      // 2. A second QR lock on the same Student waits (serialisation kept).
      await assert.rejects(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '300ms'`);
          await tx.$queryRaw`SELECT "id" FROM "Student" WHERE "id" = ${s} FOR NO KEY UPDATE`;
        }),
        /lock timeout|55P03/i
      );
      assert.equal(settled, false);

      const replaced = await regeneration;
      assert.equal(replaced.reason, "REGENERATE");
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qrtest_slow_regenerate ON "StudentQrToken"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS qrtest_slow_regenerate()`);
      await prisma.$executeRaw`DELETE FROM "StudentLoginHistory" WHERE "studentId" = ${s}`;
    }
    const rows = await tokens(s);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.revokedAt === null).length, 1);
  });

  test("Prisma's own error log prints only a sanitized line (no nonce, hash or row)", async () => {
    const s = await newStudent();
    const nonce = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.randomBytes(32).toString("hex");
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.map(String).join(" "));
    try {
      await assert.rejects(
        prisma.studentQrToken.create({
          data: {
            id: crypto.randomUUID(),
            studentId: s,
            nonce,
            tokenHash,
            reason: "ISSUE",
            createdAt: new Date(),
            createdByRole: "STUDENT",
            createdById: s,
            revokedByRole: "STUDENT", // inconsistent: audit fields without revokedAt
          },
        })
      );
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = original;
    }
    const prismaLines = lines.filter((line) => line.startsWith("prisma:"));
    assert.equal(prismaLines.length, 1, lines.join("\n"));
    assert.equal(
      prismaLines[0],
      'prisma:error studentQrToken.create: Database error 23514: new row for relation "StudentQrToken" violates check constraint "StudentQrToken_revocation_audit_check"'
    );
    for (const line of lines) {
      assert.ok(!line.includes(nonce) && !line.includes(tokenHash) && !line.includes(s), line);
      assert.ok(!/Failing row/.test(line), line);
    }
  });

  test("database CHECKs refuse inconsistent revocation audit rows", async () => {
    const s = await newStudent();
    const base = () => ({
      id: crypto.randomUUID(),
      studentId: s,
      nonce: crypto.randomBytes(32).toString("base64url"),
      tokenHash: crypto.randomBytes(32).toString("hex"),
      reason: "REGENERATE",
      createdAt: new Date(Date.now() - 1000),
      createdByRole: "STUDENT",
      createdById: s,
    });
    const now = new Date();
    for (const bad of [
      { revokedByRole: "STUDENT", revokedById: s, revokedReason: "REGENERATE" }, // audit without revokedAt
      { revokedAt: now, revokedByRole: "STUDENT", revokedById: s }, // no reason
      { revokedAt: now, revokedReason: "REGENERATE" }, // no role
      { revokedAt: now, revokedByRole: "TEACHER", revokedReason: "REGENERATE" }, // no id
      { revokedAt: now, revokedByRole: "TEACHER", revokedById: T1, revokedReason: "SYSTEM_REISSUE" },
      { revokedAt: now, revokedByRole: "SYSTEM", revokedReason: "REGENERATE" },
      { revokedAt: now, revokedByRole: "ADMIN", revokedById: "a", revokedReason: "REGENERATE" },
      { revokedAt: new Date(Date.now() - 60_000), revokedByRole: "STUDENT", revokedById: s, revokedReason: "REGENERATE" },
    ]) {
      await assert.rejects(prisma.studentQrToken.create({ data: { ...base(), ...bad } }), JSON.stringify(bad));
    }
    await prisma.studentQrToken.create({
      data: { ...base(), revokedAt: now, revokedByRole: "SYSTEM", revokedReason: "SYSTEM_REISSUE" },
    });
  });
});
