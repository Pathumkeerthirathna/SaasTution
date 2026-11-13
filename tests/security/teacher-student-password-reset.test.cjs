/*
 * Student Profile SP-7D: teacher-initiated student password reset
 * (POST /api/students/[id]/resetpassword -> lib/teacher-student-password-reset-http.ts,
 * lib/teacher-student-password-reset-rate-limit.ts,
 * services/teacher-student-password-reset-service.ts).
 *
 *   npm run test:security
 *
 * No database: lib/prisma.ts is a stateful fake. Its $transaction snapshots
 * every table and restores it when the callback throws, hands the callback a
 * distinct client whose writes are tagged, and runs transactions one at a
 * time (as row locks serialize conflicting writers). bcryptjs is wrapped to
 * record each call (it really hashes at cost 4; the requested cost is
 * recorded). next/headers (the teacher cookie) and the mailer are fakes; the
 * teacher token is signed with a throwaway in-process JWT_SECRET.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Module = require("node:module");

process.env.JWT_SECRET = "sp-7d-test-secret-not-a-real-one-0123456789";
process.env.APP_URL = "http://localhost:3000";
process.env.TRUSTED_PROXY_COUNT = "1";
const APP = "http://localhost:3000";

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

const OLD = "Old-password-1";
const OLD_HASH = realBcrypt.hashSync(OLD, 4);
const NEW = "Brand-New-Pass1";

const state = {};
function resetState() {
  Object.assign(state, {
    cookie: null,
    students: new Map(),
    tokens: [],
    log: [],
    transactions: [],
    inTransaction: false,
    beforeStudentUpdate: null,
    failTokenInvalidation: false,
    mailMode: "ok",
    mails: [],
    committedElsewhere: [],
  });
}
resetState();

/** A change committed by ANOTHER request while ours runs: applied now and kept even if our transaction rolls back. */
function concurrently(change) {
  change();
  state.committedElsewhere.push(change);
}
const log = (entry) => state.log.push(entry);
const ops = (name) => state.log.filter((e) => e.op === name);

fakeAt(require.resolve("bcryptjs", { paths: [root] }), {
  ...realBcrypt,
  hash: async (password, rounds) => {
    log({ op: "hash", rounds, inTransaction: state.inTransaction });
    return realBcrypt.hash(password, 4);
  },
  compare: async (password, hash) => {
    log({ op: "compare" });
    return realBcrypt.compare(password, hash);
  },
});

fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (name === "teacher_session" && state.cookie ? { name, value: state.cookie } : undefined) }),
});

// ---- Fake Prisma --------------------------------------------------------------------------------

const pick = (row, select) => Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));

function matches(row, where) {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
    } else if (typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !cond.in.includes(value)) return false;
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
  tokens: state.tokens.map((t) => ({ ...t })),
});
const restore = (snap) => Object.assign(state, snap);

const prisma = {
  student: {
    findFirst: async ({ where, select }) => {
      log({ op: "student.findFirst", where });
      const row = [...state.students.values()].find((s) => matches(s, where));
      return row ? pick(row, select) : null;
    },
    findUnique: async ({ where, select, viaTx = false }) => {
      log({ op: "student.findUnique", viaTx, select: Object.keys(select).join(",") });
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
      const row = [...state.students.values()].find((s) => matches(s, where));
      if (!row) return { count: 0 };
      row.password = data.password;
      row.sessionVersion += data.sessionVersion.increment;
      return { count: 1 };
    },
  },
  passwordResetToken: {
    findFirst: async ({ where, select }) => {
      const row = state.tokens.find((t) => matches(t, where));
      return row ? pick(row, select) : null;
    },
    updateMany: async ({ where, data, viaTx = false }) => {
      log({ op: "token.updateMany", viaTx, where });
      if (state.failTokenInvalidation && !("expiresAt" in where)) throw new Error("token update failed");
      const hit = state.tokens.filter((t) => matches(t, where));
      hit.forEach((t) => Object.assign(t, data));
      return { count: hit.length };
    },
  },
};

let txChain = Promise.resolve();
prisma.$transaction = (fn, options) => {
  const run = async () => {
    state.transactions.push(options);
    log({ op: "tx.begin" });
    state.committedElsewhere = [];
    const snap = snapshot();
    const tx = {
      student: {
        findUnique: (args) => prisma.student.findUnique({ ...args, viaTx: true }),
        updateMany: (args) => prisma.student.updateMany({ ...args, viaTx: true }),
      },
      passwordResetToken: { updateMany: (args) => prisma.passwordResetToken.updateMany({ ...args, viaTx: true }) },
    };
    state.inTransaction = true;
    try {
      const result = await fn(tx);
      state.committedElsewhere = [];
      log({ op: "tx.commit" });
      return result;
    } catch (error) {
      restore(snap);
      for (const change of state.committedElsewhere) change();
      log({ op: "tx.rollback" });
      throw error;
    } finally {
      state.inTransaction = false;
    }
  };
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
  sendPasswordChangedEmail: async ({ to, by }) => {
    log({ op: "mail", to, by, inTransaction: state.inTransaction });
    state.mails.push({ to, by });
    if (state.mailMode === "fail") throw new Error("smtp down");
  },
});
fake("lib/email-verification.ts", { createEmailVerificationCode: async () => "000000", verifyEmailConfirmationCode: async () => {} });
fake("lib/email-uniqueness.ts", { assertEmailAvailable: async () => {} });
fake("services/teacher-profile-section-service.ts", { defaultProfileSectionsCreateInput: () => ({}) });

const auth = require(path.join(root, "lib", "auth.ts"));
const { checkStudentSessionAccess } = require(path.join(root, "lib", "student-session.ts"));
const limits = require(path.join(root, "lib", "teacher-student-password-reset-rate-limit.ts"));
const http = require(path.join(root, "lib", "teacher-student-password-reset-http.ts"));
const validation = require(path.join(root, "lib", "student-password-validation.ts"));
const { confirmPasswordReset } = require(path.join(root, "services", "auth-service.ts"));
const route = require(path.join(root, "app", "api", "students", "[id]", "resetpassword", "route.ts"));

// ---- Helpers ------------------------------------------------------------------------------------

let seq = 0;

async function signInTeacher(teacherId = "t-1") {
  state.cookie = await auth.signAuthToken({ sub: teacherId, email: `${teacherId}@example.test`, role: "TEACHER", name: "Teacher" });
}

async function setup({ limiter } = {}) {
  resetState();
  limits.setTeacherStudentPasswordResetRateLimiterForTests(limiter ?? limits.createTeacherStudentPasswordResetRateLimiter());
  await signInTeacher("t-1");
}

function addStudent(patch = {}) {
  const id = `stu-${++seq}`;
  state.students.set(id, {
    id,
    teacherId: "t-1",
    email: `${id}@example.test`,
    registrationNumber: `REG-${seq}`,
    password: OLD_HASH,
    status: 0,
    sessionVersion: 0,
    ...patch,
  });
  return id;
}
const student = (id) => state.students.get(id);

function addToken({ userId, role = "STUDENT", usedAt = null, email = "x@example.test" }) {
  const raw = crypto.randomBytes(32).toString("hex");
  const id = `tok-${++seq}`;
  state.tokens.push({ id, tokenHash: crypto.createHash("sha256").update(raw).digest("hex"), role, userId, email, expiresAt: new Date(Date.now() + 30 * 60_000), usedAt });
  return { raw, id };
}
const tokenRow = (id) => state.tokens.find((t) => t.id === id);

const SAME_ORIGIN = { Origin: APP, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };

async function reset(studentId, body = { password: NEW }, { headers = {}, origin = true, raw = false, query = "" } = {}) {
  const response = await route.POST(
    new Request(`${APP}/api/students/${encodeURIComponent(studentId)}/resetpassword${query}`, {
      method: "POST",
      headers: { ...(origin ? SAME_ORIGIN : { "Content-Type": "application/json" }), ...headers },
      body: raw ? body : JSON.stringify(body),
    }),
    { params: { id: studentId } }
  );
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
}

const passwordIs = (row, password) => realBcrypt.compareSync(password, row.password);
const SUCCESS = { success: true, message: "Password reset successfully. The student has been signed out on all devices." };
const NOT_FOUND = { success: false, message: "Student not found.", code: "STUDENT_NOT_FOUND" };

function assertNoStore(response, label) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0", label);
  assert.equal(response.headers.get("pragma"), "no-cache", label);
}

async function quiet(fn) {
  const errors = [];
  const warnings = [];
  const [e, w] = [console.error, console.warn];
  console.error = (...a) => errors.push(a.map(String).join(" "));
  console.warn = (...a) => warnings.push(a.map(String).join(" "));
  try {
    return { result: await fn(), errors, warnings };
  } finally {
    console.error = e;
    console.warn = w;
  }
}

// ---- Authorization ------------------------------------------------------------------------------

test("a teacher resets their own student", async () => {
  await setup();
  const id = addStudent();
  const response = await reset(id);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, SUCCESS);
  assert.ok(passwordIs(student(id), NEW));
  assert.deepEqual(ops("student.findFirst")[0].where, { id, teacherId: "t-1", status: { in: [0, 1] } });
});

test("another teacher's student, a missing student and a deleted student: the same 404, nothing written", async () => {
  await setup();
  const other = addStudent({ teacherId: "t-2" });
  const deleted = addStudent({ status: 2 });
  const answers = [await reset(other), await reset("stu-missing"), await reset(deleted)];
  for (const answer of answers) {
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.body, NOT_FOUND);
  }
  assert.ok(passwordIs(student(other), OLD));
  assert.ok(passwordIs(student(deleted), OLD));
  assert.equal(ops("hash").length + ops("student.updateMany").length + state.mails.length, 0);
});

test("the teacher id cannot be spoofed: only the session decides (body fields refused, query ignored)", async () => {
  await setup();
  const other = addStudent({ teacherId: "t-2" });
  const spoofBody = await reset(other, { password: NEW, teacherId: "t-2" });
  assert.equal(spoofBody.status, 400);
  assert.equal(spoofBody.body.code, "VALIDATION_ERROR");
  const spoofQuery = await reset(other, { password: NEW }, { query: "?teacherId=t-2" });
  assert.equal(spoofQuery.status, 404);
  assert.ok(ops("student.findFirst").every((e) => e.where.teacherId === "t-1"));
  assert.ok(passwordIs(student(other), OLD));
  // Signed in as t-2, the same student is theirs.
  await signInTeacher("t-2");
  assert.equal((await reset(other)).status, 200);
});

test("not signed in, or signed in as a student: 401, nothing read", async () => {
  await setup();
  const id = addStudent();
  state.cookie = null;
  const anonymous = await reset(id);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.success, false);
  state.cookie = await auth.signAuthToken({ sub: id, email: "s@example.test", role: "STUDENT", name: "S", sessionVersion: 0 });
  assert.equal((await reset(id)).status, 401);
  assert.equal(ops("student.findFirst").length, 0);
});

test("an inactive student (status 1) can still be reset; the status is unchanged", async () => {
  await setup();
  const id = addStudent({ status: 1 });
  assert.equal((await reset(id)).status, 200);
  assert.equal(student(id).status, 1);
  assert.equal(student(id).sessionVersion, 1);
});

test("a concurrent transfer / deletion between the check and the update cannot bypass ownership", async () => {
  await setup();
  const moved = addStudent();
  state.beforeStudentUpdate = () => concurrently(() => {
    student(moved).teacherId = "t-2";
  });
  const a = await reset(moved);
  assert.equal(a.status, 404);
  assert.deepEqual(a.body, NOT_FOUND);
  assert.ok(passwordIs(student(moved), OLD));
  assert.equal(student(moved).sessionVersion, 0);

  const deleted = addStudent();
  state.beforeStudentUpdate = () => concurrently(() => {
    student(deleted).status = 2;
  });
  assert.equal((await reset(deleted)).status, 404);
  assert.ok(passwordIs(student(deleted), OLD));

  const update = ops("student.updateMany").at(-1);
  assert.deepEqual(Object.keys(update.where).sort(), ["id", "sessionVersion", "status", "teacherId"]);
  assert.equal(state.mails.length, 0);
});

// ---- Password validation ------------------------------------------------------------------------

test("password rules: required, 8–64 characters, upper + lower + digit, <= 72 UTF-8 bytes", async () => {
  await setup();
  const id = addStudent();
  const cases = [
    ["", http.PASSWORD_REQUIRED_MESSAGE],
    ["        ", http.PASSWORD_REQUIRED_MESSAGE],
    ["Short1a", http.TEACHER_PASSWORD_COMPLEXITY_MESSAGE],
    [`Aa1${"x".repeat(62)}`, validation.PASSWORD_MESSAGES.tooLong],
    ["alllower1", http.TEACHER_PASSWORD_COMPLEXITY_MESSAGE],
    ["ALLUPPER1", http.TEACHER_PASSWORD_COMPLEXITY_MESSAGE],
    ["NoDigitsHere", http.TEACHER_PASSWORD_COMPLEXITY_MESSAGE],
    [`Aa1${"අ".repeat(24)}`, validation.PASSWORD_MESSAGES.tooManyBytes], // 27 characters, 75 bytes
  ];
  for (const [password, message] of cases) {
    const response = await reset(id, { password });
    assert.equal(response.status, 400, password);
    assert.deepEqual(response.body, { success: false, message, code: "VALIDATION_ERROR" }, password);
  }
  const notString = await reset(id, { password: 12345678 });
  assert.equal(notString.status, 400);
  assert.equal(ops("hash").length, 0, "nothing hashed for an invalid password");
  assert.ok(passwordIs(student(id), OLD));

  for (const ok of ["Abcdefg1", `Aa1${"x".repeat(61)}`, `Aa1${"අ".repeat(23)}`]) {
    assert.equal((await reset(id, { password: ok })).status, 200, ok);
    assert.ok(passwordIs(student(id), ok));
  }
});

test("the student's own registration number is refused (case / spaces ignored), before bcrypt", async () => {
  await setup();
  const id = addStudent({ registrationNumber: "AB-2026-1" });
  for (const password of ["Ab-2026-1", "aB-2026-1 ", "AB-2026-1x".slice(0, 9)]) {
    // "AB-2026-1" itself has no lower-case letter, so the complexity rule refuses it first.
    const response = await reset(id, { password });
    assert.equal(response.status, 400, password);
  }
  const response = await reset(id, { password: "Ab-2026-1" });
  assert.deepEqual(response.body, { success: false, message: validation.PASSWORD_MESSAGES.registrationNumber, code: "VALIDATION_ERROR" });
  assert.equal(ops("hash").length, 0);
  assert.ok(passwordIs(student(id), OLD));
  assert.equal((await reset(id, { password: "Ab-2026-1-more" })).status, 200, "containing the number is fine");
});

test("bcrypt cost 12, hashed once BEFORE the transaction; nothing compared", async () => {
  await setup();
  const id = addStudent();
  await reset(id);
  assert.deepEqual(ops("hash").map((e) => [e.rounds, e.inTransaction]), [[12, false]]);
  assert.equal(ops("compare").length, 0);
  assert.ok(state.log.findIndex((e) => e.op === "hash") < state.log.findIndex((e) => e.op === "tx.begin"));
  assert.deepEqual(state.transactions, [{ maxWait: 5000, timeout: 15000 }]);
});

// ---- Transaction and sessions -------------------------------------------------------------------

test("one conditional UPDATE in the transaction: password + sessionVersion + 1, exactly once", async () => {
  await setup();
  const id = addStudent({ sessionVersion: 6 });
  await reset(id);
  assert.equal(student(id).sessionVersion, 7);
  const updates = ops("student.updateMany");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    op: "student.updateMany",
    viaTx: true,
    where: { id, teacherId: "t-1", status: 0, sessionVersion: 6 },
    data: { password: "<hash>", sessionVersion: { increment: 1 } },
  });
});

test("every existing student session ends; no student session is issued", async () => {
  await setup();
  const id = addStudent({ sessionVersion: 2 });
  const session = { role: "STUDENT", sub: id, email: "s@example.test", name: "S", sessionVersion: 2 };
  assert.equal(await checkStudentSessionAccess(session), "ACTIVE");
  const response = await reset(id);
  assert.equal(await checkStudentSessionAccess(session), "INVALID");
  assert.equal(response.headers.get("set-cookie"), null, "no cookie of any kind");
  assert.equal(JSON.stringify(response.body).includes("token"), false);
});

test("every unused reset link of the student is retired in the same transaction", async () => {
  await setup();
  const id = addStudent();
  const a = addToken({ userId: id });
  const b = addToken({ userId: id });
  const usedAt = new Date(Date.now() - 60_000);
  const used = addToken({ userId: id, usedAt });
  const other = addToken({ userId: addStudent() });
  const teacherToken = addToken({ userId: id, role: "TEACHER" });
  await reset(id);
  assert.ok(tokenRow(a.id).usedAt instanceof Date);
  assert.ok(tokenRow(b.id).usedAt instanceof Date);
  assert.equal(tokenRow(used.id).usedAt, usedAt);
  assert.equal(tokenRow(other.id).usedAt, null);
  assert.equal(tokenRow(teacherToken.id).usedAt, null);
  const [retire] = ops("token.updateMany");
  assert.deepEqual(retire, { op: "token.updateMany", viaTx: true, where: { role: "STUDENT", userId: id, usedAt: null } });
  // The emailed link no longer works (SP-7B confirmation).
  await assert.rejects(confirmPasswordReset(a.raw, "student-new-pass"), (e) => e.code === "INVALID_RESET_TOKEN");
});

test("a failed link retirement rolls back the password and version (500, generic, reported)", async () => {
  await setup();
  const id = addStudent();
  const link = addToken({ userId: id });
  state.failTokenInvalidation = true;
  const { result, errors } = await quiet(() => reset(id));
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { success: false, message: "Failed to reset password." });
  assertNoStore(result, "500");
  assert.ok(passwordIs(student(id), OLD));
  assert.equal(student(id).sessionVersion, 0);
  assert.equal(tokenRow(link.id).usedAt, null);
  assert.equal(state.mails.length, 0);
  assert.ok(errors.length >= 1, "unexpected errors are reported");
});

test("a failed password update (row changed) leaves the reset links untouched", async () => {
  await setup();
  const id = addStudent();
  const link = addToken({ userId: id });
  state.beforeStudentUpdate = () => concurrently(() => {
    student(id).sessionVersion += 1; // e.g. the student changed their password meanwhile
  });
  const response = await reset(id);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "PASSWORD_RESET_CONFLICT");
  assert.equal(tokenRow(link.id).usedAt, null);
  assert.equal(ops("token.updateMany").length, 0, "the transaction stopped at the student update");
  assert.ok(passwordIs(student(id), OLD));
});

test("two concurrent teacher resets: one succeeds, the other is a 409 — no silent overwrite", async () => {
  await setup();
  const id = addStudent();
  const [a, b] = await Promise.all([reset(id, { password: "First-pass-1" }), reset(id, { password: "Second-pass-2" })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const winner = a.status === 200 ? "First-pass-1" : "Second-pass-2";
  assert.ok(passwordIs(student(id), winner));
  assert.equal(student(id).sessionVersion, 1, "incremented once");
  assert.equal(state.mails.length, 1);
});

test("concurrent email reset (SP-7B) and teacher reset: exactly one commits, never half of either", async () => {
  for (const emailFirst of [true, false]) {
    await setup();
    const id = addStudent({ email: "kid@example.test" });
    const link = addToken({ userId: id, email: "kid@example.test" });
    const emailReset = () => confirmPasswordReset(link.raw, "student-chosen-1");
    const teacherReset = () => reset(id, { password: "Teacher-Set-1" });
    const results = emailFirst
      ? await Promise.allSettled([emailReset(), teacherReset()])
      : (await Promise.allSettled([teacherReset(), emailReset()])).reverse();
    const [emailResult, teacherResult] = results;
    const emailOk = emailResult.status === "fulfilled";
    const teacherOk = teacherResult.status === "fulfilled" && teacherResult.value.status === 200;
    assert.equal(Number(emailOk) + Number(teacherOk), 1, `exactly one wins (email first: ${emailFirst})`);
    assert.equal(student(id).sessionVersion, 1);
    assert.ok(tokenRow(link.id).usedAt instanceof Date, "the link is consumed or retired either way");
    assert.ok(passwordIs(student(id), emailOk ? "student-chosen-1" : "Teacher-Set-1"));
    if (!teacherOk) assert.equal(teacherResult.value.status, 409);
    if (!emailOk) assert.equal(emailResult.reason.code, "INVALID_RESET_TOKEN");
  }
});

test("a database write conflict / deadlock (P2034) is a rolled-back 409", async () => {
  await setup();
  const id = addStudent();
  const link = addToken({ userId: id });
  state.beforeStudentUpdate = () => {
    throw new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock.", { code: "P2034", clientVersion: "5.22.0" });
  };
  const response = await reset(id);
  assert.equal(response.status, 409);
  assert.ok(passwordIs(student(id), OLD));
  assert.equal(tokenRow(link.id).usedAt, null);
  assert.equal(state.mails.length, 0);
});

// ---- Notification ---------------------------------------------------------------------------------

test("the notification goes to the student's current email, after the commit, worded for a teacher reset", async () => {
  await setup();
  const id = addStudent({ email: "old@example.test" });
  student(id).email = "current@example.test";
  await reset(id);
  assert.deepEqual(state.mails, [{ to: "current@example.test", by: "teacher" }]);
  const mail = ops("mail")[0];
  assert.equal(mail.inTransaction, false);
  assert.ok(state.log.findIndex((e) => e.op === "tx.commit") < state.log.indexOf(mail));
  assert.deepEqual(ops("student.findUnique").filter((e) => e.viaTx).map((e) => e.select), ["email"], "the email is read inside the transaction");
});

test("a notification failure does not undo the reset or change the answer; nothing sensitive logged", async () => {
  await setup();
  const id = addStudent({ email: "kid@example.test" });
  state.mailMode = "fail";
  const { result, errors } = await quiet(() => reset(id));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, SUCCESS);
  assert.ok(passwordIs(student(id), NEW));
  assert.deepEqual(errors, ["[teacher-password-reset] Password-changed notification failed (Error)."]);
});

test("no email on file: no notification, same success answer, a generic warning", async () => {
  await setup();
  const id = addStudent({ email: null });
  addToken({ userId: id, email: "stale@example.test" });
  const { result, warnings } = await quiet(() => reset(id));
  assert.deepEqual(result.body, SUCCESS);
  assert.equal(state.mails.length, 0, "never the stale token address");
  assert.deepEqual(warnings, ["[teacher-password-reset] Password reset; no email on file, so no notification was sent."]);
});

test("failed resets send no notification", async () => {
  await setup();
  const id = addStudent();
  await reset(id, { password: "weak" });
  await reset(addStudent({ teacherId: "t-2" }));
  state.beforeStudentUpdate = () => {
    student(id).sessionVersion += 1;
  };
  await reset(id);
  assert.equal(state.mails.length, 0);
});

// ---- SP-7D.1: login failure counter ------------------------------------------------------------------

const loginLimit = require(path.join(root, "lib", "student-login-rate-limit.ts"));

/** A fresh real login limiter in which `registrationNumber` is locked out (5 failures). */
function lockedOutLimiter(registrationNumber) {
  const limiter = loginLimit.createStudentLoginRateLimiter();
  loginLimit.setStudentLoginRateLimiterForTests(limiter);
  for (let i = 0; i < loginLimit.STUDENT_LOGIN_RATE_LIMIT.failuresPerRegistration; i += 1) {
    const gate = limiter.begin(registrationNumber, null);
    assert.equal(gate.allowed, true);
    gate.ticket.fail();
  }
  assert.equal(limiter.begin(registrationNumber, null).allowed, false, "locked out before the reset");
  return limiter;
}
const failureKeys = (limiter) => limiter.registrationKeysForTests().registrationFailures;

test("SP-7D.1: a committed teacher reset clears the number's login failures — after the commit, not before", async () => {
  await setup();
  const id = addStudent({ registrationNumber: "PK-2026-70" });
  const limiter = lockedOutLimiter("PK-2026-70");
  const key = loginLimit.registrationLimitKey("PK-2026-70");
  let heldDuringTransaction = null;
  state.beforeStudentUpdate = () => {
    heldDuringTransaction = failureKeys(limiter).includes(key);
  };
  const response = await reset(id);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, SUCCESS);
  assert.equal(heldDuringTransaction, true, "not cleared before the commit");
  assert.equal(failureKeys(limiter).includes(key), false);
  assert.equal(limiter.begin("pk-2026-70", null).allowed, true, "the student can sign in again");
});

test("SP-7D.1: only that student's counter is cleared", async () => {
  await setup();
  const id = addStudent({ registrationNumber: "PK-2026-71" });
  const limiter = lockedOutLimiter("PK-2026-71");
  for (let i = 0; i < 5; i += 1) limiter.begin("PK-OTHER-1", null).ticket.fail();
  await reset(id);
  assert.deepEqual(failureKeys(limiter), [loginLimit.registrationLimitKey("PK-OTHER-1")]);
  assert.equal(limiter.begin("PK-OTHER-1", null).allowed, false);
});

test("SP-7D.1: failed, rolled-back, unauthorized and refused resets do not clear the counter", async () => {
  await setup({ limiter: limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 4, requestsPerIp: 10, globalRequests: 10, maxKeys: 10 }) });
  const id = addStudent({ registrationNumber: "PK-2026-72" });
  const limiter = lockedOutLimiter("PK-2026-72");
  const key = loginLimit.registrationLimitKey("PK-2026-72");
  const stillLocked = (label) => assert.ok(failureKeys(limiter).includes(key), label);

  assert.equal((await reset(id, { password: "weak" })).status, 400);
  stillLocked("invalid password");
  assert.equal((await reset(id, { password: "Pk-2026-72" })).status, 400);
  stillLocked("registration number as password");

  state.beforeStudentUpdate = () => concurrently(() => {
    student(id).sessionVersion += 1;
  });
  assert.equal((await reset(id)).status, 409);
  stillLocked("conflict (rolled back)");

  state.failTokenInvalidation = true;
  assert.equal((await quiet(() => reset(id))).result.status, 500);
  stillLocked("failed link retirement (rolled back)");
  state.failTokenInvalidation = false;

  await signInTeacher("t-2");
  assert.equal((await reset(id)).status, 404);
  stillLocked("another teacher");
  state.cookie = null;
  assert.equal((await reset(id)).status, 401);
  stillLocked("not signed in");
  assert.equal((await reset(id, { password: NEW }, { origin: false })).status, 403);
  stillLocked("cross-origin");

  await signInTeacher("t-1");
  assert.equal((await reset(id)).status, 200, "t-1's 4th counted request (registration-number 400, 409, 500, this)");
  assert.equal(failureKeys(limiter).includes(key), false);
  lockedOutLimiter("PK-2026-72");
  const refused = await reset(id);
  assert.equal(refused.status, 429);
  assert.ok(failureKeys(loginLimit.studentLoginRateLimiter()).includes(key), "a rate-limited request clears nothing");
});

test("SP-7D.1: a failure while clearing never changes the committed reset or its answer, and logs nothing", async () => {
  await setup();
  const id = addStudent({ registrationNumber: "PK-2026-73", email: "kid@example.test" });
  const real = loginLimit.createStudentLoginRateLimiter();
  let calledWith = null;
  loginLimit.setStudentLoginRateLimiterForTests({
    ...real,
    clearRegistrationFailures(number) {
      calledWith = number;
      throw new Error("limiter exploded PK-2026-73");
    },
  });
  const { result, errors, warnings } = await quiet(() => reset(id));
  assert.equal(calledWith, "PK-2026-73");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, SUCCESS);
  assert.ok(passwordIs(student(id), NEW));
  assert.equal(student(id).sessionVersion, 1);
  assert.deepEqual(state.mails, [{ to: "kid@example.test", by: "teacher" }], "the notification still follows");
  assert.deepEqual([...errors, ...warnings], []);
});

test("SP-7D.1: a student without a registration number is reset normally (nothing to clear)", async () => {
  await setup();
  const id = addStudent({ registrationNumber: null });
  const limiter = loginLimit.createStudentLoginRateLimiter();
  loginLimit.setStudentLoginRateLimiterForTests(limiter);
  assert.equal((await reset(id)).status, 200);
  assert.deepEqual(failureKeys(limiter), []);
});

test("the real template: teacher wording for a teacher reset; the SP-7B reset-link wording is unchanged by default", () => {
  const template = require(path.join(root, "emails", "PasswordChangedEmail.ts"));
  const teacherHtml = template.getPasswordChangedEmail("teacher");
  const teacherText = template.passwordChangedText("teacher");
  for (const out of [teacherHtml, teacherText]) {
    assert.match(out, /was just reset by your teacher/);
    assert.match(out, /If you did not ask your teacher for a new password, contact your teacher immediately/);
    assert.doesNotMatch(out, /reset link/);
  }
  for (const out of [template.getPasswordChangedEmail(), template.passwordChangedText(), template.getPasswordChangedEmail("reset-link")]) {
    assert.match(out, /was just changed using a password reset link/);
    assert.match(out, /If you did not reset your password, contact your teacher immediately/);
  }
  assert.equal(
    template.passwordChangedText(),
    "The password for your SLClassroom account was just changed using a password reset link. You have been signed out on every device; sign in again with your new password.\n\nIf you did not reset your password, contact your teacher immediately."
  );
});

// ---- Rate limiting and HTTP ------------------------------------------------------------------------

test("per teacher: refused with 429 + Retry-After + no-store, before any lookup; other teachers unaffected", async () => {
  await setup({ limiter: limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 2, requestsPerIp: 10, globalRequests: 20, maxKeys: 20 }) });
  const id = addStudent();
  for (let i = 0; i < 2; i += 1) assert.equal((await reset(id, { password: `Pass-word-${i}a` }, { headers: { "X-Forwarded-For": `203.0.113.${i}` } })).status, 200);
  state.log = [];
  const refused = await reset(id, { password: "Pass-word-9a" }, { headers: { "X-Forwarded-For": "203.0.113.99" } });
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.body, { success: false, message: "Too many password resets. Please wait and try again.", code: "PASSWORD_RESET_RATE_LIMITED" });
  const retry = Number(refused.headers.get("retry-after"));
  assert.ok(retry > 0 && retry <= 900);
  assertNoStore(refused, "429");
  assert.equal(ops("student.findFirst").length + ops("hash").length, 0);
  await signInTeacher("t-2");
  assert.equal((await reset(addStudent({ teacherId: "t-2" }), { password: NEW }, { headers: { "X-Forwarded-For": "203.0.113.50" } })).status, 200);
});

test("per trusted address: the right-most hop counts; spoofed left hops / X-Real-IP do not help", async () => {
  const limiter = limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 1, requestsPerIp: 2, globalRequests: 20, maxKeys: 20 });
  await setup({ limiter });
  const from = (spoof) => ({ "X-Forwarded-For": `${spoof}, 198.51.100.7`, "X-Real-IP": spoof });
  for (const teacher of ["t-a", "t-b"]) {
    await signInTeacher(teacher);
    assert.equal((await reset(addStudent({ teacherId: teacher }), { password: NEW }, { headers: from(`10.0.0.${teacher}`) })).status, 200);
  }
  await signInTeacher("t-c");
  const refused = await reset(addStudent({ teacherId: "t-c" }), { password: NEW }, { headers: from("10.9.9.9") });
  assert.equal(refused.status, 429);
  assert.deepEqual(limiter.keysForTests().addresses, ["198.51.100.7"]);
});

test("global cap across teachers and addresses", async () => {
  const limiter = limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 1, requestsPerIp: 1, globalRequests: 2, maxKeys: 5 });
  await setup({ limiter });
  for (const [i, teacher] of ["t-a", "t-b", "t-c"].entries()) {
    await signInTeacher(teacher);
    const response = await reset(addStudent({ teacherId: teacher }), { password: NEW }, { headers: { "X-Forwarded-For": `192.0.2.${i}` } });
    assert.equal(response.status, i < 2 ? 200 : 429);
  }
});

test("limiter keys hold no raw teacher id", async () => {
  const limiter = limits.createTeacherStudentPasswordResetRateLimiter();
  await setup({ limiter });
  await signInTeacher("teacher-uuid-1234");
  await reset(addStudent({ teacherId: "teacher-uuid-1234" }));
  const keys = limiter.keysForTests().teachers;
  assert.deepEqual(keys, [crypto.createHash("sha256").update("teacher-uuid-1234").digest("hex")]);
  assert.ok(keys.every((k) => /^[0-9a-f]{64}$/.test(k) && !k.includes("teacher")));
});

test("limiter: sliding window, longest Retry-After, refused requests record nothing", () => {
  let now = 0;
  const limiter = limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 1, requestsPerIp: 2, globalRequests: 10, maxKeys: 10, now: () => now });
  assert.equal(limiter.attempt("t", "ip-1").allowed, true);
  now = 60_000;
  assert.equal(limiter.attempt("u", "ip-1").allowed, true);
  // teacher "t" frees in 14 minutes, ip-1 in 14 minutes too; "u" in 15: the longest wins.
  assert.deepEqual(limiter.attempt("u", "ip-1"), { allowed: false, retryAfterSeconds: 15 * 60 });
  for (let i = 0; i < 5; i += 1) limiter.attempt("t", "ip-2");
  assert.deepEqual(limiter.trackedKeys(), { teachers: 2, addresses: 1 }, "refusals recorded nothing");
  now = 15 * 60_000;
  assert.equal(limiter.attempt("t", "ip-1").allowed, true);
});

test("limiter: bounded sweep cleans expired keys and never drops live ones", () => {
  let now = 0;
  const limiter = limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 1, requestsPerIp: 50, globalRequests: 50, maxKeys: 100, now: () => now });
  for (let i = 0; i < 20; i += 1) limiter.attempt(`T-${i}`, `ip-${i}`);
  now += 15 * 60_000;
  assert.equal(limiter.sweep(5), 10);
  assert.deepEqual(limiter.trackedKeys(), { teachers: 15, addresses: 15 });
  limiter.sweep(1_000);
  assert.deepEqual(limiter.trackedKeys(), { teachers: 0, addresses: 0 });
  limiter.attempt("LIVE", "ip-live");
  assert.ok(limiter.sweep(1_000) <= 4, "one wrap-around per sweep");
  assert.deepEqual(limiter.trackedKeys(), { teachers: 1, addresses: 1 });
});

test("limiter: a full map makes room only from expired keys; full of live keys -> refused (fail closed)", () => {
  for (const [size, oldKeys] of [[300, 1], [300, 3], [400, 1], [400, 3], [400, 7], [517, 2], [517, 5]]) {
    let now = 0;
    const limiter = limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 1, requestsPerIp: 1, globalRequests: size, maxKeys: size, now: () => now });
    for (let i = 0; i < oldKeys; i += 1) limiter.attempt(`OLD-${i}`, null);
    now = 60_000;
    for (let i = oldKeys; i < size; i += 1) limiter.attempt(`LIVE-${i}`, null);
    now = 15 * 60_000 + 1;
    for (let i = 0; i < oldKeys; i += 1) assert.equal(limiter.attempt(`NEW-${i}`, null).allowed, true);
    assert.equal(limiter.trackedKeys().teachers, size);
    assert.equal(limiter.attempt("ONE-MORE", null).allowed, false);
    assert.equal(limiter.trackedKeys().teachers, size, "no live key evicted");
  }
});

test("limiter: invalid configuration is rejected at creation; defaults", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3"]) {
    for (const key of ["requestsPerTeacher", "requestsPerIp", "globalRequests", "windowMs", "maxKeys"]) {
      assert.throws(() => limits.createTeacherStudentPasswordResetRateLimiter({ [key]: bad }), /must be a positive integer/, `${key}=${bad}`);
    }
  }
  assert.throws(() => limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 50, requestsPerIp: 40 }), /must not exceed/);
  assert.throws(() => limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerIp: 400, globalRequests: 300 }), /must not exceed/);
  assert.throws(() => limits.createTeacherStudentPasswordResetRateLimiter({ globalRequests: 20_000, maxKeys: 10_000 }), /must not exceed/);
  assert.deepEqual({ ...limits.TEACHER_STUDENT_PASSWORD_RESET_RATE_LIMIT }, { requestsPerTeacher: 20, requestsPerIp: 40, globalRequests: 300, windowMs: 900_000, maxKeys: 10_000 });
});

test("cross-origin requests are refused first (403, no-store), even without a session", async () => {
  await setup();
  const id = addStudent();
  for (const c of [
    { origin: false, headers: {} },
    { origin: false, headers: { Origin: "https://evil.example" } },
    { origin: true, headers: { "Sec-Fetch-Site": "cross-site" } },
  ]) {
    const response = await reset(id, { password: NEW }, c);
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { success: false, message: "This request must come from the application itself.", code: "CROSS_ORIGIN_REQUEST_REJECTED" });
    assertNoStore(response, "403");
  }
  state.cookie = null;
  assert.equal((await reset(id, { password: NEW }, { origin: false })).status, 403);
  assert.ok(passwordIs(student(id), OLD));
  assert.equal(ops("student.findFirst").length, 0);
});

test("body cap 1 KiB, malformed JSON and strict schema; every answer no-store and { success, message }", async () => {
  await setup();
  const id = addStudent();
  const responses = [
    [await reset(id, { password: NEW, pad: "x".repeat(2000) }), 413, "REQUEST_TOO_LARGE"],
    [await reset(id, "{oops", { raw: true }), 400, "INVALID_JSON"],
    [await reset(id, "", { raw: true }), 400, "INVALID_JSON"],
    [await reset(id, {}), 400, "VALIDATION_ERROR"],
    [await reset(id, { password: NEW, confirmPassword: NEW }), 400, "VALIDATION_ERROR"],
    [await reset(id, [NEW]), 400, "VALIDATION_ERROR"],
  ];
  for (const [response, status, code] of responses) {
    assert.equal(response.status, status, code);
    assert.equal(response.body.success, false);
    assert.equal(typeof response.body.message, "string");
    assert.equal(response.body.code, code);
    assertNoStore(response, code);
  }
  assertNoStore(await reset(id), "200");
  assert.ok(passwordIs(student(id), NEW));
});

// ---- Teacher UI compatibility ---------------------------------------------------------------------

test("UI contract: the profile header still posts { password } and reads success / message", () => {
  const source = fs.readFileSync(path.join(root, "app", "student", "Components", "StudentProfileHeader.tsx"), "utf8");
  assert.match(source, /`\/api\/students\/\$\{student\.id\}\/resetpassword`/);
  assert.match(source, /body: JSON\.stringify\(\{\s*password,\s*\}\)/);
  assert.match(source, /if \(!response\.ok \|\| !result\.success\) \{\s*toast\.error\(result\.message \?\? "Failed to reset password\."\);/);
});

test("UI contract: every answer the UI can receive has a boolean success and a message string", async () => {
  await setup({ limiter: limits.createTeacherStudentPasswordResetRateLimiter({ requestsPerTeacher: 2, requestsPerIp: 10, globalRequests: 10, maxKeys: 10 }) });
  const id = addStudent();
  const answers = [await reset(id), await reset(id, { password: "weak" }), await reset("nobody"), await reset(id)];
  assert.deepEqual(answers.map((a) => a.status), [200, 400, 404, 429]);
  for (const answer of answers) {
    assert.equal(typeof answer.body.success, "boolean");
    assert.equal(typeof answer.body.message, "string");
    assert.ok(answer.body.message.length > 0);
    for (const leak of ["t-1", "@example.test", "REG-", "$2"]) assert.equal(answer.text.includes(leak), false, `${answer.status} leaks ${leak}`);
  }
});
