/*
 * Student email delivery outbox against a REAL, DISPOSABLE, LOCAL PostgreSQL
 * with every migration up to 20261119120000_add_email_delivery_tracking
 * applied.
 *
 *   STUDENT_EMAIL_TEST_DATABASE_URL=postgresql://<user>@127.0.0.1:<port>/slc_email_test \
 *     npm run test:students-db
 *
 * SKIPPED unless STUDENT_EMAIL_TEST_DATABASE_URL is set. The URL must pass the
 * loopback / test-name check (lib/storage-migration/inventory-database.ts);
 * DATABASE_URL and .env are never used. Rows are COMMITTED (the services run
 * their own transactions) under unique ids and removed at the end: use a
 * disposable database. The mailer is faked (no email leaves the machine).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const Module = require("node:module");
const bcrypt = require("bcryptjs");

process.env.EMAIL_PAYLOAD_ENCRYPTION_KEY = "f6".repeat(32);
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const DB = require(path.join(root, "lib", "storage-migration", "inventory-database.ts"));

const raw = process.env.STUDENT_EMAIL_TEST_DATABASE_URL;
let skip = "set STUDENT_EMAIL_TEST_DATABASE_URL to a disposable LOCAL database to run these tests";
let target = null;
if (raw) {
  target = DB.checkInventoryDatabaseUrl(raw);
  if (!target.ok) throw new Error(`Refusing to run: ${DB.DATABASE_URL_PROBLEM_MESSAGES[target.problem]}`);
  skip = false;
}

const RUN = crypto.randomBytes(4).toString("hex");
const T1 = `email-db-t1-${RUN}`;
const T2 = `email-db-t2-${RUN}`;
const PASSWORD = "DbTest7Passw";
const HASH = bcrypt.hashSync(PASSWORD, 4);

const sent = [];
const failures = [];
let duringSend = null;
let prisma;
let OUTBOX;
let RESEND;
let service;
let clock = new Date();
const now = () => clock;

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

test.before(async () => {
  if (skip) return;
  const { PrismaClient } = require("@prisma/client");
  prisma = DB.createIsolatedPrismaClient(PrismaClient, target.url).client;
  fake("lib/prisma.ts", { prisma });
  fake("lib/mailer.ts", {
    buildStudentLoginLink: () => "https://slclassroom.live/login",
    buildPasswordResetLink: () => "",
    sendEmail: async () => {},
    sendPasswordResetEmail: async () => {},
    sendPasswordChangedEmail: async () => {},
    sendEmailVerificationCodeEmail: async () => {},
    sendStudentRegistrationEmail: async () => {},
    sendStudentWelcomeCredentialsEmail: async (input) => {
      if (duringSend) await duringSend();
      const failure = failures.shift();
      if (failure) throw failure;
      sent.push(input);
      return { messageId: `<db-${sent.length}@test>` };
    },
  });
  fake("lib/auth-session.ts", { requireTeacherSession: async () => ({ teacherId: T1, name: "DB Teacher", email: "x", role: "TEACHER" }) });
  OUTBOX = require(path.join(root, "services", "student-email-delivery-service.ts"));
  RESEND = require(path.join(root, "services", "student-registration-email-resend-service.ts"));
  service = require(path.join(root, "services", "student-service.ts"));

  await prisma.grade.upsert({ where: { id: 6 }, create: { id: 6, GradeDesc: "Grade 6" }, update: {} });
  await prisma.teacher.createMany({
    data: [
      { id: T1, name: `Db Teacher ${RUN}`, email: `t1-${RUN}@test.local`, password: "x" },
      { id: T2, name: `Other Teacher ${RUN}`, email: `t2-${RUN}@test.local`, password: "x" },
    ],
  });
});

test.after(async () => {
  if (!prisma) return;
  const students = await prisma.student.findMany({ where: { teacherId: { in: [T1, T2] } }, select: { id: true } });
  const ids = students.map((s) => s.id);
  await prisma.emailDelivery.deleteMany({ where: { teacherId: { in: [T1, T2] } } });
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.teacher.deleteMany({ where: { id: { in: [T1, T2] } } });
  await prisma.$disconnect();
});

let seq = 0;
async function makeStudent(overrides = {}) {
  seq += 1;
  return prisma.student.create({
    data: {
      id: `email-db-s${seq}-${RUN}`,
      name: `Db Student ${seq}`,
      teacherId: T1,
      contact: "077",
      registrationNumber: `DB${RUN}-${seq}`.toUpperCase(),
      email: `s${seq}-${RUN}@test.local`,
      password: HASH,
      gradeId: 6,
      confirmationStatus: "APPROVED",
      ...overrides,
    },
  });
}
const queueWelcome = (student, db = prisma) =>
  OUTBOX.queueStudentWelcomeEmails(db, [{ studentId: student.id, teacherId: student.teacherId, recipientEmail: student.email, temporaryPassword: PASSWORD, passwordHash: HASH, initiatedBy: "TEACHER_ADD" }], { now: clock });
const reset = () => {
  sent.length = 0;
  failures.length = 0;
  duringSend = null;
  clock = new Date();
};
const quiet = async (fn) => {
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, error });
  }
};
const work = () => quiet(() => OUTBOX.processEmailDeliveries({ now, batchSize: 50, concurrency: 4 }));

test("schema: the table, enums, unique keys, foreign keys and CHECKs exist", { skip }, async () => {
  const columns = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'EmailDelivery'`);
  assert.ok(columns.length >= 30);
  const constraints = (await prisma.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE conrelid = '"EmailDelivery"'::regclass`)).map((r) => r.conname);
  for (const name of ["EmailDelivery_pkey", "EmailDelivery_studentId_fkey", "EmailDelivery_teacherId_fkey", "EmailDelivery_attempts_valid", "EmailDelivery_sent_has_time"]) {
    assert.ok(constraints.includes(name), name);
  }
  const indexes = (await prisma.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE tablename = 'EmailDelivery'`)).map((r) => r.indexname);
  for (const name of ["EmailDelivery_idempotencyKey_key", "EmailDelivery_activeOperationKey_key", "EmailDelivery_status_nextRetryAt_idx", "EmailDelivery_status_processingLeaseExpiresAt_idx"]) {
    assert.ok(indexes.includes(name), name);
  }
});

test("persistence: a queued row is stored with the password only encrypted; teacher Add creates exactly one row in the same transaction", { skip }, async () => {
  reset();
  const created = await quiet(() => service.createStudent(T1, { registrationNumber: `DBADD${RUN}`.toUpperCase(), name: `Added ${RUN}`, gradeId: 6, contact01: "0771234567", email: `added-${RUN}@test.local` }));
  const rows = await prisma.emailDelivery.findMany({ where: { studentId: created.id } });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.status, "PENDING");
  assert.equal(row.emailType, "STUDENT_WELCOME");
  assert.equal(row.idempotencyKey, `student-welcome:${created.id}`);
  const stored = await prisma.$queryRawUnsafe(`SELECT row_to_json(e)::text AS j FROM "EmailDelivery" e WHERE id = $1`, row.id);
  clock = new Date(Date.now() + 1000); // createStudent queued at the real time
  await quiet(() => OUTBOX.processEmailDeliveries({ now, batchSize: 50 }));
  const password = sent.find((m) => m.registrationNumber === `DBADD${RUN}`.toUpperCase()).temporaryPassword;
  assert.ok(!stored[0].j.includes(password), "no plaintext password anywhere in the row");
  const after = await prisma.emailDelivery.findUnique({ where: { id: row.id } });
  assert.equal(after.status, "SENT");
  assert.equal(after.encryptedPayload, null);
});

test("transaction: a registration that rolls back leaves no email row (real PostgreSQL rollback)", { skip }, async () => {
  const id = `email-db-rb-${RUN}`;
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const student = await tx.student.create({ data: { id, name: "Rolled back", teacherId: T1, contact: "077", registrationNumber: `RB${RUN}`.toUpperCase(), email: `rb-${RUN}@test.local`, password: HASH } });
      await queueWelcome(student, tx);
      throw new Error("registration failed after queueing");
    })
  );
  assert.equal(await prisma.student.count({ where: { id } }), 0);
  assert.equal(await prisma.emailDelivery.count({ where: { studentId: id } }), 0);
});

test("uniqueness: one welcome per student (idempotencyKey); one unresolved resend per student (activeOperationKey)", { skip }, async () => {
  reset();
  const s = await makeStudent();
  await queueWelcome(s);
  await assert.rejects(queueWelcome(s), (e) => e.code === "P2002");

  await quiet(() => RESEND.resendStudentRegistrationEmails(T1, s.id, { now }));
  clock = new Date(clock.getTime() + 120_000);
  await assert.rejects(quiet(() => RESEND.resendStudentRegistrationEmails(T1, s.id, { now })), (e) => e.code === "RESEND_IN_PROGRESS");
  assert.equal(await prisma.emailDelivery.count({ where: { studentId: s.id, emailType: "STUDENT_CREDENTIAL_RESEND" } }), 1);
});

test("foreign keys: unknown student refused; deleting a student removes its email history (cascade)", { skip }, async () => {
  await assert.rejects(
    prisma.emailDelivery.create({ data: { emailType: "STUDENT_WELCOME", studentId: `missing-${RUN}`, teacherId: T1, initiatedBy: "TEACHER_ADD", recipientEmail: "x@test.local", idempotencyKey: `fk-${RUN}`, maxAttempts: 5 } }),
    (e) => e.code === "P2003"
  );
  const s = await makeStudent();
  await queueWelcome(s);
  await prisma.student.delete({ where: { id: s.id } });
  assert.equal(await prisma.emailDelivery.count({ where: { studentId: s.id } }), 0);
});

test("CHECK constraints: SENT requires sentAt; attempt counters are valid", { skip }, async () => {
  const s = await makeStudent();
  await queueWelcome(s);
  const row = await prisma.emailDelivery.findFirst({ where: { studentId: s.id } });
  await assert.rejects(prisma.emailDelivery.update({ where: { id: row.id }, data: { status: "SENT" } }));
  await assert.rejects(prisma.emailDelivery.update({ where: { id: row.id }, data: { attemptCount: -1 } }));
  await assert.rejects(prisma.emailDelivery.update({ where: { id: row.id }, data: { maxAttempts: 0 } }));
});

test("concurrent claims on real PostgreSQL: parallel passes never claim or send the same row twice", { skip }, async () => {
  reset();
  const students = [];
  for (let i = 0; i < 12; i += 1) students.push(await makeStudent());
  for (const s of students) await queueWelcome(s);
  const config = OUTBOX.emailDeliveryConfig();
  const results = await Promise.all(Array.from({ length: 6 }, () => OUTBOX.claimDueEmailDeliveries(12, clock, config)));
  const ids = results.flat().map((c) => c.id);
  const ours = new Set((await prisma.emailDelivery.findMany({ where: { studentId: { in: students.map((s) => s.id) } }, select: { id: true } })).map((r) => r.id));
  const claimedOurs = ids.filter((id) => ours.has(id));
  assert.equal(new Set(claimedOurs).size, claimedOurs.length, "no row claimed twice");
  assert.equal(claimedOurs.length, 12, "every row claimed exactly once");
  const processing = await prisma.emailDelivery.count({ where: { id: { in: [...ours] }, status: "PROCESSING", attemptCount: 1 } });
  assert.equal(processing, 12);
});

test("lease recovery on real PostgreSQL: an abandoned PROCESSING row is reclaimed after expiry and sent once", { skip }, async () => {
  reset();
  const s = await makeStudent();
  await queueWelcome(s);
  const config = OUTBOX.emailDeliveryConfig();
  await OUTBOX.claimDueEmailDeliveries(50, clock, config);
  assert.equal((await prisma.emailDelivery.findFirst({ where: { studentId: s.id } })).status, "PROCESSING");
  // The worker "crashes". Before expiry nothing happens; after it, the row is recovered.
  await work();
  clock = new Date(clock.getTime() + config.leaseMs + 1000);
  await work();
  const row = await prisma.emailDelivery.findFirst({ where: { studentId: s.id } });
  assert.equal(row.status, "SENT");
  assert.equal(row.attemptCount, 2);
  assert.equal(sent.filter((m) => m.to === s.email).length, 1);
});

test("retries on real PostgreSQL: transient failure, backoff, maximum attempts, manual retry with the same payload", { skip }, async () => {
  reset();
  const s = await makeStudent();
  await queueWelcome(s);
  for (let i = 0; i < 5; i += 1) failures.push(Object.assign(new Error("421 try later"), { code: "EENVELOPE", responseCode: 421 }));
  for (let i = 0; i < 5; i += 1) {
    await work();
    clock = new Date(clock.getTime() + 7 * 3600_000);
  }
  let row = await prisma.emailDelivery.findFirst({ where: { studentId: s.id } });
  assert.equal(row.status, "FAILED");
  assert.equal(row.attemptCount, 5);
  assert.equal(row.lastErrorCode, "SMTP_421");
  const payload = row.encryptedPayload;

  const [a, b] = await Promise.allSettled([
    OUTBOX.retryEmailDeliveryByTeacher({ teacherId: T1, deliveryId: row.id, now: clock }),
    OUTBOX.retryEmailDeliveryByTeacher({ teacherId: T1, deliveryId: row.id, now: clock }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ["fulfilled", "rejected"], "duplicate retry prevented");
  await assert.rejects(OUTBOX.retryEmailDeliveryByTeacher({ teacherId: T2, deliveryId: row.id, now: clock }), (e) => e.code === "EMAIL_DELIVERY_NOT_FOUND");
  await work();
  row = await prisma.emailDelivery.findFirst({ where: { studentId: s.id } });
  assert.equal(row.status, "SENT");
  assert.equal(row.attemptCount, 6);
  assert.notEqual(payload, null);
  assert.equal(sent.filter((m) => m.to === s.email)[0].temporaryPassword, PASSWORD);
});

test("resend on real PostgreSQL: old password valid until acceptance; activation in one transaction; devices untouched; conflict recorded", { skip }, async () => {
  reset();
  const s = await makeStudent({ sessionVersion: 2, passwordSetupPending: true });
  await quiet(() => RESEND.resendStudentRegistrationEmails(T1, s.id, { now }));
  let student = await prisma.student.findUnique({ where: { id: s.id } });
  assert.equal(student.password, HASH, "unchanged before acceptance");

  failures.push(Object.assign(new Error("Sender.net request timed out"), { code: "SENDER_TIMEOUT" }));
  await work();
  student = await prisma.student.findUnique({ where: { id: s.id } });
  assert.equal(student.password, HASH, "unchanged after a failed (unknown-outcome) attempt");

  clock = new Date(clock.getTime() + 61_000);
  await work();
  student = await prisma.student.findUnique({ where: { id: s.id } });
  const mail = sent.find((m) => m.to === s.email);
  assert.ok(await bcrypt.compare(mail.temporaryPassword, student.password), "the emailed password is active");
  assert.equal(await bcrypt.compare(PASSWORD, student.password), false, "the old one is not");
  assert.equal(student.sessionVersion, 3);
  assert.equal(student.passwordSetupPending, true);
  const row = await prisma.emailDelivery.findFirst({ where: { studentId: s.id, emailType: "STUDENT_CREDENTIAL_RESEND" } });
  assert.ok(row.activatedAt);
  assert.equal(row.pendingPasswordHash, null);
  assert.equal(row.activeOperationKey, null);

  // Conflict: the account changes while the email is being sent.
  const t = await makeStudent();
  await quiet(() => RESEND.resendStudentRegistrationEmails(T1, t.id, { now }));
  duringSend = () => prisma.student.update({ where: { id: t.id }, data: { sessionVersion: { increment: 1 } } });
  await work();
  duringSend = null;
  const conflict = await prisma.emailDelivery.findFirst({ where: { studentId: t.id, emailType: "STUDENT_CREDENTIAL_RESEND" } });
  assert.equal(conflict.status, "SENT");
  assert.equal(conflict.activationErrorCode, "ACCOUNT_CHANGED");
  assert.equal((await prisma.student.findUnique({ where: { id: t.id } })).password, HASH, "old password kept");
});

test("history query on real PostgreSQL: only the teacher's own records; filters and summary", { skip }, async () => {
  reset();
  const mine = await makeStudent();
  const theirs = await makeStudent({ teacherId: T2 });
  await queueWelcome(mine);
  await queueWelcome(theirs);
  const view = await OUTBOX.listEmailDeliveriesForTeacher({ teacherId: T1, skip: 0, take: 100, studentId: theirs.id });
  assert.equal(view.items.length, 0);
  const own = await OUTBOX.listEmailDeliveriesForTeacher({ teacherId: T1, skip: 0, take: 100, studentId: mine.id });
  assert.equal(own.items.length, 1);
  assert.equal(own.items[0].student.name, mine.name);
  assert.equal(own.summary.queued, 1);
  assert.ok(!JSON.stringify(own).includes("v1."));
});
