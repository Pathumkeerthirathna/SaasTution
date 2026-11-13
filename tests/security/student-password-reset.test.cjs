/*
 * Student Profile SP-7B: secure password-reset confirmation
 * (POST /api/auth/password-reset/confirm -> services/auth-service.ts
 * confirmPasswordReset).
 *
 *   npm run test:security
 *
 * No database: lib/prisma.ts is a stateful fake. Its $transaction snapshots
 * every table and restores it when the callback throws, hands the callback a
 * distinct client whose writes are tagged (a write that bypasses `tx` is
 * visible), and runs transactions one at a time, as row locks serialize two
 * claims of the same token in PostgreSQL. bcryptjs is wrapped to record each
 * call (it really hashes at cost 4; the requested cost is recorded). The
 * mailer is a fake that records when it is called. The login rate limiter is
 * the real one (a fresh instance per test). JWT_SECRET is a throwaway value.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

process.env.JWT_SECRET = "sp-7b-test-secret-not-a-real-one-0123456789";
process.env.APP_URL = "http://localhost:3000";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const realBcrypt = require("bcryptjs");
const { Prisma } = require("@prisma/client");

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

// ---- State --------------------------------------------------------------------------------------

const OLD_HASH = realBcrypt.hashSync("old-password-1", 4);
const MINUTE = 60_000;

const state = {};
function resetState() {
  Object.assign(state, {
    students: new Map(),
    teachers: new Map(),
    guardians: new Map(),
    tokens: [],
    log: [],
    transactions: [],
    inTransaction: false,
    beforeTransaction: null, // runs (once) after the pre-read, before the transaction: another request's committed change
    beforeStudentUpdate: null, // runs (once) inside the transaction, just before the student UPDATE
    failTokenInvalidation: false,
    failTeacherUpdate: false,
    mailFails: false,
    mails: [],
  });
}
resetState();
const log = (entry) => state.log.push(entry);
const ops = (name) => state.log.filter((e) => e.op === name);

fakeAt(require.resolve("bcryptjs", { paths: [root] }), {
  ...realBcrypt,
  hash: async (password, rounds) => {
    log({ op: "hash", rounds, inTransaction: state.inTransaction });
    return realBcrypt.hash(password, 4);
  },
  compare: async (password, hash) => {
    log({ op: "compare", inTransaction: state.inTransaction });
    return realBcrypt.compare(password, hash);
  },
});

// ---- Fake Prisma --------------------------------------------------------------------------------

const pick = (row, select) => Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));

/** Prisma-like where matching for the token table: equality, null (= never set), { not }, { gt }. */
function tokenMatches(token, where) {
  for (const [key, cond] of Object.entries(where)) {
    const value = token[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
    } else if (typeof cond === "object" && !(cond instanceof Date)) {
      if ("not" in cond && value === cond.not) return false;
      if ("gt" in cond && !(value > cond.gt)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

const snapshot = () => ({
  students: new Map([...state.students].map(([k, v]) => [k, { ...v }])),
  teachers: new Map([...state.teachers].map(([k, v]) => [k, { ...v }])),
  guardians: new Map([...state.guardians].map(([k, v]) => [k, { ...v }])),
  tokens: state.tokens.map((t) => ({ ...t })),
});
const restore = (snap) => Object.assign(state, snap);

const prisma = {
  passwordResetToken: {
    findFirst: async ({ where, select }) => {
      log({ op: "token.findFirst", inTransaction: state.inTransaction });
      const row = state.tokens.find((t) => tokenMatches(t, where));
      return row ? pick(row, select) : null;
    },
    updateMany: async ({ where, data, viaTx = false }) => {
      const kind = "expiresAt" in where ? "claim" : "invalidate";
      log({ op: `token.${kind}`, viaTx, where });
      if (kind === "invalidate" && state.failTokenInvalidation) throw new Error("token update failed");
      const hit = state.tokens.filter((t) => tokenMatches(t, where));
      hit.forEach((t) => Object.assign(t, data));
      return { count: hit.length };
    },
  },
  student: {
    findUnique: async ({ where, select, viaTx = false }) => {
      log({ op: "student.findUnique", viaTx });
      const row = state.students.get(where.id);
      return row ? pick(row, select) : null;
    },
    updateMany: async ({ where, data, viaTx = false }) => {
      if (state.beforeStudentUpdate) {
        const hook = state.beforeStudentUpdate;
        state.beforeStudentUpdate = null;
        await hook();
      }
      log({ op: "student.updateMany", viaTx, where, data: { ...data, password: typeof data.password === "string" ? "<hash>" : data.password } });
      const row = state.students.get(where.id);
      if (!row || row.status !== where.status || row.sessionVersion !== where.sessionVersion) return { count: 0 };
      row.password = data.password;
      row.sessionVersion += data.sessionVersion.increment;
      return { count: 1 };
    },
  },
  teacher: {
    update: async ({ where, data, viaTx = false }) => {
      log({ op: "teacher.update", viaTx, keys: Object.keys(data) });
      if (state.failTeacherUpdate) throw new Error("teacher update failed");
      const row = state.teachers.get(where.id);
      if (!row) throw new Error("Record to update not found.");
      row.password = data.password;
      return { id: row.id };
    },
  },
  guardian: {
    update: async ({ where, data, viaTx = false }) => {
      log({ op: "guardian.update", viaTx, keys: Object.keys(data) });
      const row = state.guardians.get(where.id);
      if (!row) throw new Error("Record to update not found.");
      row.password = data.password;
      return { id: row.id };
    },
  },
};

let txChain = Promise.resolve();
prisma.$transaction = (fn, options) => {
  const run = async () => {
    state.transactions.push(options);
    if (state.beforeTransaction) {
      const hook = state.beforeTransaction;
      state.beforeTransaction = null;
      await hook();
    }
    log({ op: "tx.begin" });
    const snap = snapshot();
    const tx = {
      passwordResetToken: { updateMany: (args) => prisma.passwordResetToken.updateMany({ ...args, viaTx: true }) },
      student: {
        findUnique: (args) => prisma.student.findUnique({ ...args, viaTx: true }),
        updateMany: (args) => prisma.student.updateMany({ ...args, viaTx: true }),
      },
      teacher: { update: (args) => prisma.teacher.update({ ...args, viaTx: true }) },
      guardian: { update: (args) => prisma.guardian.update({ ...args, viaTx: true }) },
    };
    state.inTransaction = true;
    try {
      const result = await fn(tx);
      log({ op: "tx.commit" });
      return result;
    } catch (error) {
      restore(snap);
      log({ op: "tx.rollback" });
      throw error;
    } finally {
      state.inTransaction = false;
    }
  };
  // One at a time: a second claim of the same token waits for the first (row lock).
  const result = txChain.then(run, run);
  txChain = result.catch(() => {});
  return result;
};

fake("lib/prisma.ts", { prisma });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
fake("lib/mailer.ts", {
  buildPasswordResetLink: () => "",
  sendPasswordResetEmail: async () => {},
  sendEmailVerificationCodeEmail: async () => {},
  sendPasswordChangedEmail: async ({ to }) => {
    const student = [...state.students.values()].find((s) => s.email === to);
    log({ op: "mail", to, inTransaction: state.inTransaction });
    state.mails.push({ to, sessionVersionAtSend: student?.sessionVersion });
    if (state.mailFails) throw new Error("smtp down");
  },
});
fake("lib/email-verification.ts", { createEmailVerificationCode: async () => "000000", verifyEmailConfirmationCode: async () => {} });
fake("lib/email-uniqueness.ts", { assertEmailAvailable: async () => {} });
fake("services/teacher-profile-section-service.ts", { defaultProfileSectionsCreateInput: () => ({}) });

const { confirmPasswordReset } = require(path.join(root, "services", "auth-service.ts"));
const { checkStudentSessionAccess } = require(path.join(root, "lib", "student-session.ts"));
const loginLimit = require(path.join(root, "lib", "student-login-rate-limit.ts"));
const validation = require(path.join(root, "lib", "student-password-validation.ts"));
const route = require(path.join(root, "app", "api", "auth", "password-reset", "confirm", "route.ts"));

// ---- Helpers ------------------------------------------------------------------------------------

let seq = 0;
let limiter;

function setup() {
  resetState();
  limiter = loginLimit.createStudentLoginRateLimiter();
  loginLimit.setStudentLoginRateLimiterForTests(limiter);
}

function addStudent(patch = {}) {
  const id = `stu-${++seq}`;
  state.students.set(id, { id, email: `${id}@example.test`, registrationNumber: `REG-${id.toUpperCase()}`, password: OLD_HASH, status: 0, sessionVersion: 0, ...patch });
  return id;
}

/** A stored token (hash only, as in the database); returns the raw token. */
function addToken({ role = "STUDENT", userId, email, expiresInMs = 30 * MINUTE, usedAt = null }) {
  const raw = crypto.randomBytes(32).toString("hex");
  const id = `tok-${++seq}`;
  state.tokens.push({
    id,
    tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
    role,
    userId,
    email,
    expiresAt: new Date(Date.now() + expiresInMs),
    usedAt,
  });
  return { raw, id };
}
const tokenRow = (id) => state.tokens.find((t) => t.id === id);

/** A student with one fresh reset token sent to their current email. */
function studentWithToken(patch = {}) {
  const studentId = addStudent(patch);
  const student = state.students.get(studentId);
  const token = addToken({ userId: studentId, email: student.email });
  state.log = [];
  return { studentId, student: () => state.students.get(studentId), ...token };
}

const invalidToken = (e) => e.statusCode === 400 && e.code === "INVALID_RESET_TOKEN" && e.message === "Reset link is invalid or expired.";
const conflict = (e) => e.statusCode === 409 && e.code === "PASSWORD_RESET_CONFLICT";
const validationError = (message) => (e) => e.statusCode === 400 && e.code === "VALIDATION_ERROR" && e.message === message;
const passwordIs = (row, password) => realBcrypt.compareSync(password, row.password);

async function quietErrors(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

function lockOut(registrationNumber) {
  for (let i = 0; i < loginLimit.STUDENT_LOGIN_RATE_LIMIT.failuresPerRegistration; i += 1) {
    const gate = limiter.begin(registrationNumber, null);
    assert.equal(gate.allowed, true);
    gate.ticket.fail();
  }
  assert.equal(limiter.begin(registrationNumber, null).allowed, false, "locked out before the reset");
}

const NEW = "brand-new-pass";
/** Valid for every role, teachers included (SP-7E.1). */
const STRONG = "Brand-New-Pass1";

// ---- Atomic token consumption (every role) ---------------------------------------------------------

test("student: a valid token succeeds exactly once; the second use is refused", async () => {
  setup();
  const { raw, id, student } = studentWithToken();
  await confirmPasswordReset(raw, NEW);
  assert.ok(passwordIs(student(), NEW));
  assert.ok(tokenRow(id).usedAt instanceof Date);

  await assert.rejects(confirmPasswordReset(raw, "another-pass-2"), invalidToken);
  assert.ok(passwordIs(student(), NEW), "second use changed nothing");
  assert.equal(student().sessionVersion, 1);
});

test("the claim is one conditional update inside the transaction: { id, usedAt: null, expiresAt > now }, exactly one row", async () => {
  setup();
  const { raw, id } = studentWithToken();
  const before = Date.now();
  await confirmPasswordReset(raw, NEW);
  const [claim] = ops("token.claim");
  assert.equal(claim.viaTx, true);
  assert.deepEqual(Object.keys(claim.where).sort(), ["expiresAt", "id", "usedAt"]);
  assert.equal(claim.where.id, id);
  assert.equal(claim.where.usedAt, null);
  assert.ok(claim.where.expiresAt.gt instanceof Date && claim.where.expiresAt.gt.getTime() >= before);
  assert.equal(state.log.findIndex((e) => e.op === "token.claim") > state.log.findIndex((e) => e.op === "tx.begin"), true);
});

for (const role of ["STUDENT", "TEACHER", "GUARDIAN"]) {
  const account = () => {
    if (role === "STUDENT") {
      const id = addStudent();
      return { id, email: state.students.get(id).email, row: () => state.students.get(id) };
    }
    const table = role === "TEACHER" ? state.teachers : state.guardians;
    const id = `${role.toLowerCase()}-${++seq}`;
    table.set(id, { id, email: `${id}@example.test`, password: OLD_HASH });
    return { id, email: `${id}@example.test`, row: () => (role === "TEACHER" ? state.teachers : state.guardians).get(id) };
  };

  test(`${role}: an expired token is refused and nothing changes`, async () => {
    setup();
    const acc = account();
    const { raw } = addToken({ role, userId: acc.id, email: acc.email, expiresInMs: -1 });
    await assert.rejects(confirmPasswordReset(raw, STRONG), invalidToken);
    assert.ok(passwordIs(acc.row(), "old-password-1"));
    assert.equal(ops("hash").length + state.transactions.length, 0, "no bcrypt work, no transaction");
  });

  test(`${role}: an already-used token is refused`, async () => {
    setup();
    const acc = account();
    const { raw } = addToken({ role, userId: acc.id, email: acc.email, usedAt: new Date(Date.now() - MINUTE) });
    await assert.rejects(confirmPasswordReset(raw, STRONG), invalidToken);
    assert.ok(passwordIs(acc.row(), "old-password-1"));
  });

  test(`${role}: two concurrent confirmations with the same token -> exactly one succeeds`, async () => {
    setup();
    const acc = account();
    const { raw, id } = addToken({ role, userId: acc.id, email: acc.email });
    const results = await Promise.allSettled([confirmPasswordReset(raw, "First-Pass-1"), confirmPasswordReset(raw, "Second-Pass-2")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1);
    assert.equal(refused.length, 1);
    assert.ok(invalidToken(refused[0].reason), String(refused[0].reason));
    // Both passed the pre-read and hashed; only the claim decided.
    assert.equal(ops("token.findFirst").length, 2);
    assert.equal(ops("token.claim").length, 2);
    // Exactly one of the two passwords: the winner's, never overwritten by the loser.
    assert.equal([passwordIs(acc.row(), "First-Pass-1"), passwordIs(acc.row(), "Second-Pass-2")].filter(Boolean).length, 1);
    assert.equal(ops("tx.commit").length, 1);
    assert.equal(ops("tx.rollback").length, 1);
    assert.ok(tokenRow(id).usedAt instanceof Date);
    if (role === "STUDENT") assert.equal(acc.row().sessionVersion, 1, "incremented once");
  });

  test(`${role}: a token used or expired after the pre-read is refused by the claim itself`, async () => {
    setup();
    const acc = account();
    const { raw, id } = addToken({ role, userId: acc.id, email: acc.email });
    state.beforeTransaction = () => {
      tokenRow(id).usedAt = new Date(); // another request committed first
    };
    await assert.rejects(confirmPasswordReset(raw, STRONG), invalidToken);
    assert.ok(passwordIs(acc.row(), "old-password-1"));
    assert.equal(ops(`${role.toLowerCase()}.update`).length + ops("student.updateMany").length, 0, "no password write after a failed claim");
  });
}

test("TEACHER: a failed password update rolls back the token claim", async () => {
  setup();
  state.teachers.set("t-1", { id: "t-1", email: "t1@example.test", password: OLD_HASH });
  const { raw, id } = addToken({ role: "TEACHER", userId: "t-1", email: "t1@example.test" });
  state.failTeacherUpdate = true;
  await assert.rejects(confirmPasswordReset(raw, STRONG), /teacher update failed/);
  assert.equal(tokenRow(id).usedAt, null, "claim rolled back");
  assert.ok(passwordIs(state.teachers.get("t-1"), "old-password-1"));
  assert.deepEqual(ops("token.claim").map((e) => e.viaTx), [true]);
  // The link still works once the failure is gone.
  state.failTeacherUpdate = false;
  await confirmPasswordReset(raw, STRONG);
  assert.ok(passwordIs(state.teachers.get("t-1"), STRONG));
});

test("STUDENT: a failed student update (row changed) rolls back the token claim", async () => {
  setup();
  const { raw, id, student, studentId } = studentWithToken();
  state.beforeStudentUpdate = () => {
    state.students.get(studentId).sessionVersion += 1; // e.g. a device block committed meanwhile
  };
  await assert.rejects(confirmPasswordReset(raw, NEW), conflict);
  assert.equal(tokenRow(id).usedAt, null, "claim rolled back");
  assert.ok(passwordIs(student(), "old-password-1"));
  assert.equal(state.mails.length, 0);
});

test("STUDENT: a database write conflict / deadlock (P2034) is a rolled-back 409", async () => {
  setup();
  const { raw, id, student } = studentWithToken();
  state.beforeStudentUpdate = () => {
    throw new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock.", { code: "P2034", clientVersion: "5.22.0" });
  };
  await assert.rejects(confirmPasswordReset(raw, NEW), conflict);
  assert.equal(tokenRow(id).usedAt, null);
  assert.ok(passwordIs(student(), "old-password-1"));
});

test("STUDENT: a failure invalidating the other tokens rolls back the password, version and claim", async () => {
  setup();
  const { raw, id, student, studentId } = studentWithToken();
  const other = addToken({ userId: studentId, email: student().email });
  state.failTokenInvalidation = true;
  await assert.rejects(confirmPasswordReset(raw, NEW), /token update failed/);
  assert.ok(passwordIs(student(), "old-password-1"));
  assert.equal(student().sessionVersion, 0);
  assert.equal(tokenRow(id).usedAt, null);
  assert.equal(tokenRow(other.id).usedAt, null);
  assert.equal(state.mails.length, 0);
});

// ---- Student reset --------------------------------------------------------------------------------

test("student: success updates the password and increments sessionVersion exactly once, in one conditional UPDATE", async () => {
  setup();
  const { raw, student, studentId } = studentWithToken({ sessionVersion: 4 });
  await confirmPasswordReset(raw, NEW);
  assert.ok(passwordIs(student(), NEW));
  assert.equal(student().sessionVersion, 5);
  const updates = ops("student.updateMany");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].viaTx, true);
  assert.deepEqual(updates[0].where, { id: studentId, status: 0, sessionVersion: 4 });
  assert.deepEqual(updates[0].data, { password: "<hash>", sessionVersion: { increment: 1 } });
  assert.equal(ops("tx.commit").length, 1);
});

test("student: existing sessions (the old version) become invalid; no new session is issued", async () => {
  setup();
  const { raw, studentId, student } = studentWithToken({ sessionVersion: 2 });
  const oldSession = { role: "STUDENT", sub: studentId, email: student().email, name: "S", sessionVersion: 2 };
  assert.equal(await checkStudentSessionAccess(oldSession), "ACTIVE");
  const result = await confirmPasswordReset(raw, NEW);
  assert.equal(result, undefined, "nothing returned to sign the student in");
  assert.equal(await checkStudentSessionAccess(oldSession), "INVALID");
  assert.equal(await checkStudentSessionAccess({ ...oldSession, sessionVersion: 3 }), "ACTIVE", "only a new sign-in gets the new version");
});

test("student: bcrypt cost 12, hashed once BEFORE the transaction; nothing hashed or compared inside it", async () => {
  setup();
  const { raw } = studentWithToken();
  await confirmPasswordReset(raw, NEW);
  assert.deepEqual(ops("hash").map((e) => [e.rounds, e.inTransaction]), [[12, false]]);
  assert.equal(ops("compare").length, 0);
  assert.ok(state.log.findIndex((e) => e.op === "hash") < state.log.findIndex((e) => e.op === "tx.begin"));
  assert.deepEqual(state.transactions, [{ maxWait: 5000, timeout: 15000 }]);
});

test("student: missing or deleted student -> generic invalid token, claim rolled back", async () => {
  setup();
  const { raw, id } = addToken({ userId: "stu-missing", email: "gone@example.test" });
  await assert.rejects(confirmPasswordReset(raw, NEW), invalidToken);
  assert.equal(tokenRow(id).usedAt, null);

  const deleted = studentWithToken({ status: 2 });
  await assert.rejects(confirmPasswordReset(deleted.raw, NEW), invalidToken);
  assert.equal(tokenRow(deleted.id).usedAt, null);
  assert.ok(passwordIs(deleted.student(), "old-password-1"));
  assert.equal(deleted.student().sessionVersion, 0);
  assert.equal(ops("student.updateMany").length, 0);
});

test("student: an inactive student (status 1) may reset, as before; status is unchanged", async () => {
  setup();
  const { raw, student, studentId } = studentWithToken({ status: 1 });
  await confirmPasswordReset(raw, NEW);
  assert.ok(passwordIs(student(), NEW));
  assert.equal(student().status, 1);
  assert.equal(student().sessionVersion, 1);
  assert.deepEqual(ops("student.updateMany")[0].where, { id: studentId, status: 1, sessionVersion: 0 });
});

test("student: a token issued to an old email cannot reset the account (current-email binding)", async () => {
  setup();
  const { raw, id, student, studentId } = studentWithToken({ email: "old@example.test" });
  state.students.get(studentId).email = "new@example.test"; // the teacher changed the email after the link was sent
  await assert.rejects(confirmPasswordReset(raw, NEW), invalidToken);
  assert.ok(passwordIs(student(), "old-password-1"));
  assert.equal(tokenRow(id).usedAt, null);
  assert.equal(state.mails.length, 0);
});

test("student: token email mismatch, a removed email, and a case-only difference", async () => {
  setup();
  const mismatch = addStudent({ email: "a@example.test" });
  const t1 = addToken({ userId: mismatch, email: "someone-else@example.test" });
  await assert.rejects(confirmPasswordReset(t1.raw, NEW), invalidToken);

  const noEmail = addStudent({ email: null });
  const t2 = addToken({ userId: noEmail, email: "was@example.test" });
  await assert.rejects(confirmPasswordReset(t2.raw, NEW), invalidToken);

  // Same mailbox, different letter case / spaces: still the current address.
  const cased = addStudent({ email: "Mixed.Case@Example.test" });
  const t3 = addToken({ userId: cased, email: " mixed.case@example.test " });
  await confirmPasswordReset(t3.raw, NEW);
  assert.ok(passwordIs(state.students.get(cased), NEW));
  // The notice goes to the address stored on the student now, not the token's copy.
  assert.deepEqual(state.mails.map((m) => m.to), ["Mixed.Case@Example.test"]);
});

test("student: all other unused reset tokens of that student are invalidated in the same transaction", async () => {
  setup();
  const { raw, id, studentId, student } = studentWithToken();
  const older = addToken({ userId: studentId, email: student().email });
  const newer = addToken({ userId: studentId, email: student().email });
  const alreadyUsedAt = new Date(Date.now() - 5 * MINUTE);
  const used = addToken({ userId: studentId, email: student().email, usedAt: alreadyUsedAt });
  const otherStudent = addToken({ userId: addStudent(), email: "x@example.test" });
  const sameIdOtherRole = addToken({ role: "TEACHER", userId: studentId, email: "t@example.test" });
  state.log = [];

  await confirmPasswordReset(raw, NEW);
  assert.ok(tokenRow(id).usedAt instanceof Date);
  assert.ok(tokenRow(older.id).usedAt instanceof Date);
  assert.ok(tokenRow(newer.id).usedAt instanceof Date);
  assert.equal(tokenRow(used.id).usedAt, alreadyUsedAt, "an already-used token keeps its time");
  assert.equal(tokenRow(otherStudent.id).usedAt, null, "another student's token is untouched");
  assert.equal(tokenRow(sameIdOtherRole.id).usedAt, null, "a non-student token is untouched");

  const [invalidate] = ops("token.invalidate");
  assert.equal(invalidate.viaTx, true);
  assert.deepEqual(invalidate.where, { role: "STUDENT", userId: studentId, usedAt: null, id: { not: id } });
  await assert.rejects(confirmPasswordReset(older.raw, "another-pass-2"), invalidToken);
});

test("student: the registration number as password is refused (any case / spaces); claim rolled back", async () => {
  setup();
  const { raw, id, student } = studentWithToken({ registrationNumber: "PK-2026-77" });
  for (const attempt of ["PK-2026-77", "pk-2026-77", "  Pk-2026-77 "]) {
    await assert.rejects(confirmPasswordReset(raw, attempt), validationError(validation.PASSWORD_MESSAGES.registrationNumber));
  }
  assert.equal(tokenRow(id).usedAt, null);
  assert.ok(passwordIs(student(), "old-password-1"));
  assert.equal(student().sessionVersion, 0);
  // A password that merely contains the number is allowed.
  await confirmPasswordReset(raw, "PK-2026-77-extra");
  assert.ok(passwordIs(student(), "PK-2026-77-extra"));
});

test("student: 8-character minimum, 64-character maximum, 72 UTF-8 bytes (checked before any bcrypt work)", async () => {
  setup();
  const { raw, student } = studentWithToken();
  await assert.rejects(confirmPasswordReset(raw, "seven77"), validationError(validation.PASSWORD_MESSAGES.tooShort));
  await assert.rejects(confirmPasswordReset(raw, "a".repeat(65)), validationError(validation.PASSWORD_MESSAGES.tooLong));
  await assert.rejects(confirmPasswordReset(raw, "අ".repeat(25)), validationError(validation.PASSWORD_MESSAGES.tooManyBytes)); // 25 chars, 75 bytes
  assert.equal(ops("hash").length + state.transactions.length, 0);
  assert.ok(passwordIs(student(), "old-password-1"));

  await confirmPasswordReset(raw, "අ".repeat(24)); // exactly 72 bytes
  assert.ok(passwordIs(student(), "අ".repeat(24)));
  const second = studentWithToken();
  await confirmPasswordReset(second.raw, "b".repeat(64));
  const third = studentWithToken();
  await confirmPasswordReset(third.raw, "c".repeat(8));
  assert.ok(passwordIs(third.student(), "c".repeat(8)));
});

test("student: no character-class rules (lower-case letters only is accepted)", async () => {
  setup();
  const { raw, student } = studentWithToken();
  await confirmPasswordReset(raw, "onlylowercase");
  assert.ok(passwordIs(student(), "onlylowercase"));
});

// ---- Teacher / guardian compatibility --------------------------------------------------------------

// ---- SP-7E.1: password rules by the role stored in the token --------------------------------------

const TEACHER_COMPLEXITY = "Password must include an uppercase letter, a lowercase letter and a number.";

/** Every claim / update / hash attempt so far (an invalid password must cause none). */
const writesAndHashes = () => ops("hash").length + state.transactions.length + ops("token.claim").length;

function teacherWithToken() {
  state.teachers.set("t-1", { id: "t-1", password: OLD_HASH });
  return addToken({ role: "TEACHER", userId: "t-1", email: "t@example.test" });
}
function guardianWithToken() {
  state.guardians.set("g-1", { id: "g-1", password: OLD_HASH });
  return addToken({ role: "GUARDIAN", userId: "g-1", email: "g@example.test" });
}

test("SP-7E.1 teacher: upper-case, lower-case and digit are each required; nothing hashed or claimed", async () => {
  setup();
  const { raw, id } = teacherWithToken();
  for (const password of ["no-upper-case-1", "NO-LOWER-CASE-1", "No-Digits-Here", "alllowercase", "12345678"]) {
    await assert.rejects(confirmPasswordReset(raw, password), validationError(TEACHER_COMPLEXITY), password);
  }
  assert.equal(writesAndHashes(), 0);
  assert.equal(tokenRow(id).usedAt, null, "the link is not consumed");
  assert.ok(passwordIs(state.teachers.get("t-1"), "old-password-1"));
  await confirmPasswordReset(raw, "Abcdefg1");
  assert.ok(passwordIs(state.teachers.get("t-1"), "Abcdefg1"), "the same link still works with a valid password");
});

test("SP-7E.1 teacher: 8–64 characters and at most 72 UTF-8 bytes", async () => {
  setup();
  const { raw } = teacherWithToken();
  await assert.rejects(confirmPasswordReset(raw, "Abcde1x"), validationError(validation.PASSWORD_MESSAGES.tooShort));
  await assert.rejects(confirmPasswordReset(raw, `Aa1${"x".repeat(62)}`), validationError(validation.PASSWORD_MESSAGES.tooLong));
  await assert.rejects(confirmPasswordReset(raw, `Aa1${"අ".repeat(24)}`), validationError(validation.PASSWORD_MESSAGES.tooManyBytes)); // 27 characters, 75 bytes
  assert.equal(writesAndHashes(), 0);
  await confirmPasswordReset(raw, `Aa1${"අ".repeat(23)}`); // exactly 72 bytes
  assert.ok(passwordIs(state.teachers.get("t-1"), `Aa1${"අ".repeat(23)}`));
  const second = teacherWithToken();
  await confirmPasswordReset(second.raw, `Aa1${"x".repeat(61)}`); // 64 characters
  assert.ok(passwordIs(state.teachers.get("t-1"), `Aa1${"x".repeat(61)}`));
});

test("SP-7E.1 guardian: 8–64 characters and 72 bytes; no complexity, no registration-number rule", async () => {
  setup();
  const { raw, id } = guardianWithToken();
  await assert.rejects(confirmPasswordReset(raw, "short1"), validationError(validation.PASSWORD_MESSAGES.tooShort));
  await assert.rejects(confirmPasswordReset(raw, "g".repeat(65)), validationError(validation.PASSWORD_MESSAGES.tooLong));
  await assert.rejects(confirmPasswordReset(raw, "අ".repeat(30)), validationError(validation.PASSWORD_MESSAGES.tooManyBytes)); // 30 characters, 90 bytes: no silent truncation
  assert.equal(writesAndHashes(), 0);
  assert.equal(tokenRow(id).usedAt, null);
  await confirmPasswordReset(raw, "onlylowercase"); // no character-class rule for guardians
  assert.ok(passwordIs(state.guardians.get("g-1"), "onlylowercase"));
  for (const password of ["REG-LIKE-0001", "අ".repeat(24), "g".repeat(64), "12345678"]) {
    const next = guardianWithToken();
    await confirmPasswordReset(next.raw, password);
    assert.ok(passwordIs(state.guardians.get("g-1"), password), password);
  }
  assert.deepEqual(ops("guardian.update").map((e) => e.keys), Array(5).fill(["password"]), "no session version for guardians");
  assert.equal(state.mails.length, 0);
});

test("SP-7E.1 student: rules unchanged — length and bytes only, no complexity; registration number refused", async () => {
  setup();
  for (const password of ["onlylowercase", "12345678", "plain words here", "අ".repeat(24)]) {
    const { raw, student } = studentWithToken();
    await confirmPasswordReset(raw, password);
    assert.ok(passwordIs(student(), password), password);
  }
  const tooMany = studentWithToken();
  await assert.rejects(confirmPasswordReset(tooMany.raw, "අ".repeat(25)), validationError(validation.PASSWORD_MESSAGES.tooManyBytes));
  const reg = studentWithToken({ registrationNumber: "PK-2026-99" });
  await assert.rejects(confirmPasswordReset(reg.raw, "pk-2026-99"), validationError(validation.PASSWORD_MESSAGES.registrationNumber));
  assert.equal(tokenRow(reg.id).usedAt, null);
});

test("SP-7E.1: the rule comes from the role stored in the token — the same password, three answers", async () => {
  setup();
  const lower = "onlylowercase1";
  const studentToken = studentWithToken();
  await confirmPasswordReset(studentToken.raw, lower);
  const guardian = guardianWithToken();
  await confirmPasswordReset(guardian.raw, lower);
  const teacher = teacherWithToken();
  await assert.rejects(confirmPasswordReset(teacher.raw, lower), validationError(TEACHER_COMPLEXITY));
  assert.equal(tokenRow(teacher.id).usedAt, null);

  // The stored role decides: the same user id under a TEACHER token gets the teacher rule.
  state.teachers.set(studentToken.studentId, { id: studentToken.studentId, password: OLD_HASH });
  const relabelled = addToken({ role: "TEACHER", userId: studentToken.studentId, email: "x@example.test" });
  await assert.rejects(confirmPasswordReset(relabelled.raw, lower), validationError(TEACHER_COMPLEXITY));
  // A 90-byte password: refused for the teacher token, as for students and guardians (no silent truncation).
  await assert.rejects(confirmPasswordReset(relabelled.raw, `Aa1${"අ".repeat(29)}`), validationError(validation.PASSWORD_MESSAGES.tooManyBytes));
});

test("SP-7E.1: an invalid password is refused after the token check (an invalid link still answers 'invalid link' first)", async () => {
  setup();
  state.teachers.set("t-1", { id: "t-1", password: OLD_HASH });
  const expired = addToken({ role: "TEACHER", userId: "t-1", email: "t@example.test" });
  tokenRow(expired.id).expiresAt = new Date(Date.now() - 1);
  await assert.rejects(confirmPasswordReset(expired.raw, "weakpassword"), invalidToken);
  await assert.rejects(confirmPasswordReset("not-a-real-token", "weakpassword"), invalidToken);
});

test("SP-7E.1 route: role rules reach the client as the existing 400 VALIDATION_ERROR shape", async () => {
  setup();
  const { raw } = teacherWithToken();
  const response = await route.POST(
    new Request("http://localhost:3000/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: raw, newPassword: "no-upper-case-1" }),
    })
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    success: false,
    error: { message: TEACHER_COMPLEXITY, code: "VALIDATION_ERROR", details: { field: "newPassword" } },
  });
});

test("teacher / guardian: no student-only checks (registration number, email binding), no session version, no notification", async () => {
  setup();
  const t = teacherWithToken();
  const g = guardianWithToken();
  await confirmPasswordReset(t.raw, STRONG);
  await confirmPasswordReset(g.raw, "REG-LIKE-0001");
  assert.ok(passwordIs(state.teachers.get("t-1"), STRONG));
  assert.ok(passwordIs(state.guardians.get("g-1"), "REG-LIKE-0001"));
  assert.deepEqual(ops("teacher.update").map((e) => [e.viaTx, e.keys]), [[true, ["password"]]]);
  assert.deepEqual(ops("guardian.update").map((e) => [e.viaTx, e.keys]), [[true, ["password"]]]);
  assert.deepEqual(ops("hash").map((e) => e.rounds), [12, 12]);
  assert.equal(ops("student.findUnique").length + ops("student.updateMany").length + ops("token.invalidate").length, 0);
  assert.equal(state.mails.length, 0, "no student notification for other roles");
});

test("teacher / guardian: the token's email is not compared (behaviour unchanged)", async () => {
  setup();
  state.teachers.set("t-1", { id: "t-1", password: OLD_HASH });
  const t = addToken({ role: "TEACHER", userId: "t-1", email: "an-old-address@example.test" });
  await confirmPasswordReset(t.raw, STRONG);
  assert.ok(passwordIs(state.teachers.get("t-1"), STRONG));
});

test("an unsupported role (ADMIN) is refused before any bcrypt work and the token is not consumed", async () => {
  setup();
  const { raw, id } = addToken({ role: "ADMIN", userId: "admin-1", email: "a@example.test" });
  await assert.rejects(confirmPasswordReset(raw, NEW), (e) => e.statusCode === 400 && e.code === "ROLE_NOT_SUPPORTED");
  assert.equal(tokenRow(id).usedAt, null);
  assert.equal(ops("hash").length + state.transactions.length, 0);
});

// ---- After the commit: login failures and notification ---------------------------------------------

test("student: the number's login failures are cleared only after the committed reset", async () => {
  setup();
  const { raw, student } = studentWithToken({ registrationNumber: "PK-2026-50" });
  lockOut("PK-2026-50");
  const key = loginLimit.registrationLimitKey("PK-2026-50");
  let heldDuringTransaction = null;
  state.beforeStudentUpdate = () => {
    heldDuringTransaction = limiter.registrationKeysForTests().registrationFailures.includes(key);
  };
  await confirmPasswordReset(raw, NEW);
  assert.equal(heldDuringTransaction, true, "not cleared before the commit");
  assert.equal(limiter.registrationKeysForTests().registrationFailures.includes(key), false);
  assert.equal(limiter.begin("pk-2026-50", null).allowed, true, "the student can sign in again");
  assert.ok(passwordIs(student(), NEW));
});

test("student: a failed reset does not clear the login failures and sends no email", async () => {
  setup();
  const { raw, studentId } = studentWithToken({ registrationNumber: "PK-2026-51", email: "old@example.test" });
  state.students.get(studentId).email = "new@example.test";
  lockOut("PK-2026-51");
  await assert.rejects(confirmPasswordReset(raw, NEW), invalidToken);
  assert.equal(limiter.begin("PK-2026-51", null).allowed, false, "still locked");
  assert.equal(state.mails.length, 0);

  const expired = studentWithToken({ registrationNumber: "PK-2026-52" });
  tokenRow(expired.id).expiresAt = new Date(Date.now() - 1);
  await assert.rejects(confirmPasswordReset(expired.raw, NEW), invalidToken);
  const regNumber = studentWithToken({ registrationNumber: "PK-2026-53" });
  await assert.rejects(confirmPasswordReset(regNumber.raw, "PK-2026-53"), validationError(validation.PASSWORD_MESSAGES.registrationNumber));
  assert.equal(state.mails.length, 0, "no notification for any failed reset");
});

test("student: the notification goes to the current email, only after the commit", async () => {
  setup();
  const { raw, studentId } = studentWithToken({ email: "current@example.test" });
  await confirmPasswordReset(raw, NEW);
  assert.deepEqual(state.mails, [{ to: "current@example.test", sessionVersionAtSend: 1 }]);
  const mail = ops("mail")[0];
  assert.equal(mail.inTransaction, false);
  assert.ok(state.log.findIndex((e) => e.op === "tx.commit") < state.log.indexOf(mail), "after the commit");
  assert.equal(state.students.get(studentId).sessionVersion, 1);
});

test("student: a notification failure does not undo the reset or change the result; nothing sensitive is logged", async () => {
  setup();
  const { raw, id, student } = studentWithToken({ email: "current@example.test" });
  state.mailFails = true;
  const { result, lines } = await quietErrors(() => confirmPasswordReset(raw, NEW));
  assert.equal(result, undefined);
  assert.ok(passwordIs(student(), NEW));
  assert.equal(student().sessionVersion, 1);
  assert.ok(tokenRow(id).usedAt instanceof Date);
  assert.equal(lines.length, 1);
  const logged = lines.join("\n");
  for (const secret of [raw, tokenRow(id).tokenHash, NEW, "current@example.test", student().password]) {
    assert.equal(logged.includes(secret), false, "no token, hash, password or address in the log");
  }
});

// ---- Route: response compatibility ----------------------------------------------------------------

async function post(body) {
  const response = await route.POST(
    new Request("http://localhost:3000/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, body: await response.json() };
}

test("route: success shape unchanged; the notification failure is invisible to the caller", async () => {
  setup();
  const { raw } = studentWithToken();
  state.mailFails = true;
  const { result } = await quietErrors(() => post({ token: raw, newPassword: NEW }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { success: true, data: { updated: true }, message: "Password reset successfully." });
  assert.equal(result.body.data.sessionVersion, undefined);
});

test("route: invalid, used, deleted and mismatched links all get the same generic answer", async () => {
  setup();
  const answers = [];
  answers.push(await post({ token: "not-a-real-token", newPassword: NEW }));
  const used = studentWithToken();
  await confirmPasswordReset(used.raw, NEW);
  answers.push(await post({ token: used.raw, newPassword: "another-pass-2" }));
  const deleted = studentWithToken({ status: 2 });
  answers.push(await post({ token: deleted.raw, newPassword: NEW }));
  const moved = studentWithToken({ email: "old@example.test" });
  state.students.get(moved.studentId).email = "new@example.test";
  answers.push(await post({ token: moved.raw, newPassword: NEW }));
  for (const answer of answers) {
    assert.equal(answer.status, 400);
    assert.deepEqual(answer.body, { success: false, error: { message: "Reset link is invalid or expired.", code: "INVALID_RESET_TOKEN" } });
  }
});

test("route: student byte limit and registration-number rule are 400 VALIDATION_ERROR", async () => {
  setup();
  const { raw } = studentWithToken({ registrationNumber: "PK-2026-90" });
  const bytes = await post({ token: raw, newPassword: "අ".repeat(25) });
  assert.equal(bytes.status, 400);
  assert.equal(bytes.body.error.code, "VALIDATION_ERROR");
  assert.equal(bytes.body.error.message, validation.PASSWORD_MESSAGES.tooManyBytes);
  const reg = await post({ token: raw, newPassword: "pk-2026-90" });
  assert.equal(reg.status, 400);
  assert.equal(reg.body.error.message, validation.PASSWORD_MESSAGES.registrationNumber);
});
