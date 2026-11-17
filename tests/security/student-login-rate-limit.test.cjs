/*
 * Student Profile SP-6D: student login rate limits (lib/student-login-rate-limit.ts)
 * and generic credential errors with timing protection (loginStudent in
 * services/auth-service.ts, POST /api/auth/login). Teacher, guardian and
 * admin logins never touch the student limiter.
 *
 *   npm run test:security
 *
 * No database: lib/prisma.ts is a fake; bcryptjs is wrapped to record every
 * comparison (comparisons against the cost-12 dummy hash are answered without
 * the real work, for speed); the device service and other edges are fakes.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "sp-6-d-test-secret-not-a-real-one-0123456789";
const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const realBcrypt = require("bcryptjs");

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

const DUMMY = fs.readFileSync(path.join(root, "services", "auth-service.ts"), "utf8").match(/const DUMMY_PASSWORD_HASH = "([^"]+)";/)[1];

// ---- Fakes ---------------------------------------------------------------------------------------

const PASSWORD = "correct-horse-1";
const HASH = realBcrypt.hashSync(PASSWORD, 4);
const state = { students: new Map(), teachers: new Map(), guardians: new Map(), compares: [], deviceCalls: [], failReads: false, studentLookups: 0 };

fakeAt(require.resolve("bcryptjs", { paths: [root] }), {
  ...realBcrypt,
  compare: async (password, hash) => {
    state.compares.push(hash);
    if (hash === DUMMY) return false; // what the real comparison answers (nothing matches), without ~250 ms
    return realBcrypt.compare(password, hash);
  },
});

const prisma = {
  student: {
    findFirst: async ({ where }) => {
      state.studentLookups += 1;
      if (state.failReads) throw new Error("db down");
      const row = [...state.students.values()].find((s) => s.registrationNumber === where.registrationNumber && s.status !== 2);
      return row ? { ...row } : null;
    },
  },
  teacher: {
    findUnique: async ({ where }) => {
      const row = [...state.teachers.values()].find((t) => t.email === where.email);
      return row ? { ...row } : null;
    },
  },
  teacherProfile: { findUnique: async () => null },
  guardian: {
    findUnique: async ({ where, select }) => {
      const row = [...state.guardians.values()].find((g) => g.email === where.email);
      return row ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : null;
    },
  },
};

fake("lib/prisma.ts", { prisma });
fake("lib/mailer.ts", { buildPasswordResetLink: () => "", sendPasswordResetEmail: async () => {}, sendEmailVerificationCodeEmail: async () => {}, buildGuardianLoginLink: () => "", sendGuardianRegistrationEmail: async () => {} });
fake("lib/email-verification.ts", { createEmailVerificationCode: async () => "000000", verifyEmailConfirmationCode: async () => {} });
fake("lib/email-uniqueness.ts", { assertEmailAvailable: async () => {} });
fake("services/teacher-profile-section-service.ts", { defaultProfileSectionsCreateInput: () => ({}) });
fake("services/student-device.service.ts", {
  validateStudentDevice: async (input) => {
    state.deviceCalls.push(input.studentId);
    const student = state.students.get(input.studentId);
    if (student?.devicePending) {
      const { DeviceApprovalException } = require(path.join(root, "app", "exceptions", "DeviceApprovalException.ts"));
      throw new DeviceApprovalException("DEVICE_PENDING", "Waiting for approval.", 403, {});
    }
  },
});
fake("lib/login-tracker.ts", { markTeacherLoggedIn: () => {} });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });

const limits = require(path.join(root, "lib", "student-login-rate-limit.ts"));
const { createStudentLoginRateLimiter, setStudentLoginRateLimiterForTests, normalizeLoginRegistrationNumber, STUDENT_LOGIN_RATE_LIMIT } = limits;
const loginRoute = require(path.join(root, "app", "api", "auth", "login", "route.ts"));
const guardianLoginRoute = require(path.join(root, "app", "api", "guardian-auth", "login", "route.ts"));

const MIN = 60_000;
function clock(start = 10_000_000) {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

function reset(limiterOptions) {
  state.students = new Map();
  state.teachers = new Map([["t-1", { id: "t-1", name: "Teacher", email: "teacher@example.test", password: HASH, emailConfirmed: true, isBlocked: false, isRejected: false, createdAt: new Date() }]]);
  state.guardians = new Map([["g-1", { id: "g-1", fullName: "Guardian", email: "guardian@example.test", phone: "077", password: HASH }]]);
  state.compares = [];
  state.deviceCalls = [];
  state.failReads = false;
  state.studentLookups = 0;
  delete process.env.TRUSTED_PROXY_COUNT;
  const limiter = createStudentLoginRateLimiter(limiterOptions);
  setStudentLoginRateLimiterForTests(limiter);
  return limiter;
}
function student(id, patch = {}) {
  state.students.set(id, { id, teacherId: "t-1", name: `Name ${id}`, registrationNumber: `REG-${id.toUpperCase()}`, email: `${id}@example.test`, emailConfirmed: true, password: HASH, status: 0, confirmationStatus: "APPROVED", createdAt: new Date(), sessionVersion: 0, ...patch });
}

async function login(body, headers = {}) {
  const response = await loginRoute.POST(
    new Request("http://localhost:3000/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ device: { deviceId: "dev" }, ...body }) })
  );
  return { status: response.status, body: await response.json(), retryAfter: response.headers.get("retry-after"), cookie: response.headers.get("set-cookie") };
}
const wrong = (reg, headers) => login({ loginId: reg, password: "wrong-password-x" }, headers);
const right = (reg, headers) => login({ loginId: reg, password: PASSWORD }, headers);

const GENERIC_401 = { success: false, error: { message: "Invalid registration number or password.", code: "INVALID_CREDENTIALS" } };
const GENERIC_429 = { success: false, error: { message: "Too many login attempts. Please wait before trying again.", code: "LOGIN_RATE_LIMITED" } };

// ---- The limiter on its own ------------------------------------------------------------------------

test("defaults and configuration validation", () => {
  assert.deepEqual({ ...STUDENT_LOGIN_RATE_LIMIT }, { attemptsPerRegistration: 10, failuresPerRegistration: 5, failuresPerIp: 100, globalFailures: 1_000, windowMs: 15 * MIN, maxKeys: 50_000 });
  assert.doesNotThrow(() => createStudentLoginRateLimiter());
  for (const [key, value] of [["attemptsPerRegistration", 0], ["failuresPerRegistration", -1], ["failuresPerIp", 1.5], ["globalFailures", Number.NaN], ["windowMs", 0], ["maxKeys", Infinity]]) {
    assert.throws(() => createStudentLoginRateLimiter({ [key]: value }), new RegExp(`${key} must be a positive integer`), key);
  }
  assert.throws(() => createStudentLoginRateLimiter({ failuresPerRegistration: 11 }), /failuresPerRegistration \(11\) must not exceed attemptsPerRegistration \(10\)/);
  assert.throws(() => createStudentLoginRateLimiter({ failuresPerIp: 4 }), /failuresPerRegistration \(5\) must not exceed failuresPerIp \(4\)/);
  assert.throws(() => createStudentLoginRateLimiter({ globalFailures: 99 }), /failuresPerIp \(100\) must not exceed globalFailures \(99\)/);
  assert.throws(() => createStudentLoginRateLimiter({ maxKeys: 999 }), /globalFailures \(1000\) must not exceed maxKeys \(999\)/);
});

test("normalization: trimmed and case-insensitive, one key for every counter", () => {
  assert.equal(normalizeLoginRegistrationNumber("  pks-2026-001\t"), "PKS-2026-001");
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now });
  for (const variant of ["pks-2026-001", " PKS-2026-001 ", "Pks-2026-001", "PKS-2026-001", "pKs-2026-001"]) {
    limiter.begin(normalizeLoginRegistrationNumber(variant), null).ticket.fail();
  }
  assert.equal(limiter.begin(normalizeLoginRegistrationNumber("pks-2026-001 "), null).allowed, false, "five failures under every spelling");
});

test("attempts: 10 per number (successful ones too), the 11th refused with Retry-After; the window slides", () => {
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now });
  for (let i = 0; i < 10; i += 1) {
    const gate = limiter.begin("REG-1", null);
    assert.equal(gate.allowed, true, `attempt ${i + 1}`);
    gate.ticket.succeed();
    c.advance(MIN);
  }
  assert.deepEqual(limiter.begin("REG-1", null), { allowed: false, retryAfterSeconds: 300 }, "the first attempt frees at 15 minutes");
  c.advance(5 * MIN);
  assert.equal(limiter.begin("REG-1", null).allowed, true);
  assert.equal(limiter.begin("REG-2", null).allowed, true, "another number has its own budget");
});

test("failures: 5 per number; success clears them; attempts stay counted (independent)", () => {
  const c = clock();
  // 4 failures, a success (clears them), 4 more failures: 9 attempts, 4 live failures.
  const fresh = createStudentLoginRateLimiter({ now: c.now });
  for (let i = 0; i < 4; i += 1) fresh.begin("A", null).ticket.fail();
  fresh.begin("A", null).ticket.succeed();
  for (let i = 0; i < 4; i += 1) fresh.begin("A", null).ticket.fail();
  assert.equal(fresh.begin("A", null).allowed, true, "only 4 failures since the success");
  const limited = fresh.begin("A", null);
  assert.equal(limited.allowed, false, "10 attempts used");
  assert.equal(limited.retryAfterSeconds, 900);

  const failing = createStudentLoginRateLimiter({ now: c.now });
  for (let i = 0; i < 5; i += 1) failing.begin("B", null).ticket.fail();
  assert.deepEqual(failing.begin("B", null), { allowed: false, retryAfterSeconds: 900 }, "five failures lock before the attempt budget");
});

test("concurrency: requests in flight hold their slots, so a burst can never exceed a limit", () => {
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now });
  const gates = Array.from({ length: 20 }, () => limiter.begin("REG-1", "198.51.100.1"));
  assert.equal(gates.filter((g) => g.allowed).length, 5, "at most 5 unsettled (provisional failures) per number");
  for (const gate of gates.filter((g) => g.allowed)) gate.ticket.succeed();
  assert.equal(limiter.begin("REG-1", null).allowed, true, "settled successes free the failure slots (attempts remain)");

  const global = createStudentLoginRateLimiter({ now: c.now, failuresPerIp: 5, globalFailures: 7 });
  const burst = Array.from({ length: 30 }, (_, i) => global.begin(`R-${i}`, `10.0.0.${i}`));
  assert.equal(burst.filter((g) => g.allowed).length, 7, "the global budget holds under a burst over different numbers and addresses");
});

test("release (unexpected error): the provisional failure is withdrawn, the attempt is kept; a ticket settles once", () => {
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now, attemptsPerRegistration: 6 });
  for (let i = 0; i < 5; i += 1) limiter.begin("R", null).ticket.release();
  assert.equal(limiter.begin("R", null).allowed, true, "no failures counted");
  assert.equal(limiter.begin("R", null).allowed, false, "but the 6 attempts are");

  const once = createStudentLoginRateLimiter({ now: c.now });
  const gate = once.begin("S", null);
  gate.ticket.fail();
  gate.ticket.release(); // ignored: already settled
  gate.ticket.succeed(); // ignored
  for (let i = 0; i < 4; i += 1) once.begin("S", null).ticket.fail();
  assert.equal(once.begin("S", null).allowed, false, "the first failure still counts");
});

test("IP and global failures: shared across numbers, null address skips the IP budget, successes never count; windows expire", () => {
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now, failuresPerIp: 6, globalFailures: 10 });
  for (let i = 0; i < 6; i += 1) limiter.begin(`R-${i}`, "203.0.113.7").ticket.fail();
  assert.equal(limiter.begin("R-new", "203.0.113.7").allowed, false, "different students behind one address share its budget");
  assert.equal(limiter.begin("R-new", "203.0.113.8").allowed, true, "another address is not affected");
  assert.equal(limiter.begin("R-null", null).allowed, true, "no trusted address: only the number and global budgets apply");

  const successes = createStudentLoginRateLimiter({ now: c.now, failuresPerIp: 6, globalFailures: 10 });
  for (let i = 0; i < 50; i += 1) successes.begin(`OK-${i}`, "203.0.113.9").ticket.succeed();
  for (let i = 0; i < 6; i += 1) assert.equal(successes.begin(`BAD-${i}`, "203.0.113.9").allowed, true, "successes used no failure budget");

  const global = createStudentLoginRateLimiter({ now: c.now, failuresPerIp: 5, globalFailures: 10 });
  for (let i = 0; i < 10; i += 1) global.begin(`G-${i}`, `10.1.0.${i}`).ticket.fail();
  assert.equal(global.begin("G-new", "10.9.9.9").allowed, false, "global budget spent across numbers and addresses");
  c.advance(15 * MIN);
  assert.equal(global.begin("G-new", "10.9.9.9").allowed, true, "expired failures leave the window");
});

// ---- SP-6F: memory protection ------------------------------------------------------------------------

const crypto = require("node:crypto");
const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

test("per-number keys are fixed-length SHA-256 hashes of the normalized number; no raw number is stored", () => {
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now });
  for (const variant of ["pks-2026-001", "  PKS-2026-001 ", "Pks-2026-001"]) limiter.begin(variant, null).ticket.fail();
  const keys = limiter.registrationKeysForTests();
  assert.deepEqual(keys.attempts, [sha256("PKS-2026-001")], "every spelling maps to one key");
  assert.deepEqual(keys.registrationFailures, [sha256("PKS-2026-001")]);
  assert.equal(limits.registrationLimitKey(" pks-2026-001 "), sha256("PKS-2026-001"));

  limiter.begin("x".repeat(100_000), null).ticket.fail(); // even if a caller passed something huge
  for (const key of limiter.registrationKeysForTests().attempts) assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(limiter.registrationKeysForTests().attempts.every((key) => !key.includes("PKS") && key.length === 64));
});

test("an over-long number: the generic 401, no per-number key, no student lookup or bcrypt work", async () => {
  const limiter = reset();
  assert.equal(limits.MAX_LOGIN_REGISTRATION_NUMBER_LENGTH, 64);
  const tooLong = await login({ loginId: `REG-${"9".repeat(61)}`, password: PASSWORD }); // 65 characters
  assert.deepEqual([tooLong.status, tooLong.body, tooLong.cookie], [401, GENERIC_401, null]);
  assert.deepEqual(limiter.trackedKeys(), { attempts: 0, registrationFailures: 0, ipFailures: 0 });
  assert.deepEqual([state.studentLookups, state.compares.length], [0, 0]);

  const huge = await login({ loginId: "A".repeat(200_000), password: PASSWORD });
  assert.deepEqual([huge.status, huge.body], [401, GENERIC_401], "indistinguishable answer");
  assert.equal(limiter.trackedKeys().attempts, 0, "nothing keyed by it");

  // Exactly 64 characters (after trimming) is still a normal attempt.
  const longest = await login({ loginId: `  REG-${"9".repeat(60)}  `, password: PASSWORD });
  assert.deepEqual([longest.status, longest.body], [401, GENERIC_401]);
  assert.deepEqual([limiter.trackedKeys().attempts, state.studentLookups, state.compares.length], [1, 1, 1]);
});

test("over-long numbers use the global failure budget (and are refused with the same 429 once it is spent)", async () => {
  reset({ failuresPerIp: 6, globalFailures: 6 });
  for (let i = 0; i < 6; i += 1) assert.equal((await login({ loginId: "Z".repeat(100 + i), password: "x" })).status, 401);
  student("ok");
  const blocked = await right("REG-OK");
  assert.deepEqual([blocked.status, blocked.body], [429, GENERIC_429], "the global budget is spent for everyone");
  const again = await login({ loginId: "Z".repeat(300), password: "x" });
  assert.deepEqual([again.status, again.body], [429, GENERIC_429]);
});

test("over-long numbers use the trusted address's failure budget, never an untrusted header", async () => {
  const limiter = reset({ failuresPerIp: 6, globalFailures: 1_000 });
  process.env.TRUSTED_PROXY_COUNT = "1";
  for (let i = 0; i < 6; i += 1) await login({ loginId: "Y".repeat(80), password: "x" }, { "x-forwarded-for": `6.6.6.${i}, 203.0.113.7` });
  assert.deepEqual(limiter.trackedKeys(), { attempts: 0, registrationFailures: 0, ipFailures: 1 }, "one address key, no number keys");
  student("ok");
  assert.equal((await right("REG-OK", { "x-forwarded-for": "203.0.113.7" })).status, 429, "that address's budget is spent");
  assert.equal((await right("REG-OK", { "x-forwarded-for": "203.0.113.8" })).status, 200, "another address is not affected");
});

test("idle cleanup: a bounded sweep removes expired keys, continuing where it stopped; live keys stay", () => {
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now });
  for (let i = 0; i < 100; i += 1) limiter.begin(`OLD-${i}`, `10.0.0.${i % 50}`).ticket.fail();
  c.advance(10 * MIN);
  limiter.begin("LIVE", "10.9.9.9").ticket.fail();
  c.advance(6 * MIN); // the 100 old ones expired; LIVE is 6 minutes old
  const before = limiter.trackedKeys().attempts;
  const examined = limiter.sweep(10);
  assert.ok(examined <= 30, `at most 10 keys per budget (${examined})`);
  assert.ok(limiter.trackedKeys().attempts >= before - 10, "bounded work per call");
  for (let i = 0; i < 20; i += 1) limiter.sweep(10);
  assert.deepEqual(limiter.trackedKeys(), { attempts: 1, registrationFailures: 1, ipFailures: 1 }, "only the live entries remain");
  assert.equal(limiter.begin("LIVE", null).allowed, true);
  assert.deepEqual(limiter.registrationKeysForTests().registrationFailures, [sha256("LIVE")], "the live failure was not evicted");
});

test("cleanup also runs a little on every request (bounded), so a busy limiter does not accumulate expired keys", () => {
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now });
  for (let i = 0; i < 64; i += 1) limiter.begin(`OLD-${i}`, null).ticket.succeed();
  c.advance(15 * MIN);
  limiter.begin("NEW-0", null).ticket.succeed();
  const afterOne = limiter.trackedKeys().attempts;
  assert.ok(afterOne >= 64 + 1 - 8 && afterOne < 65, `one request examined at most 8 old keys (${afterOne})`);
  for (let i = 1; i < 10; i += 1) limiter.begin(`NEW-${i}`, null).ticket.succeed();
  assert.equal(limiter.trackedKeys().attempts, 10, "the 64 expired keys are gone after a few requests");
});

test("active entries are never evicted: a budget full of live keys refuses new ones (429) instead", () => {
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now, failuresPerIp: 5, globalFailures: 5, maxKeys: 5 });
  for (let i = 0; i < 10; i += 1) limiter.begin("A", null).ticket.succeed(); // A at its attempt limit
  for (const id of ["B", "C", "D", "E"]) limiter.begin(id, null).ticket.succeed();
  assert.equal(limiter.trackedKeys().attempts, 5);
  assert.deepEqual(limiter.begin("F", null), { allowed: false, retryAfterSeconds: 900 }, "no room: refused, nothing evicted");
  assert.equal(limiter.begin("A", null).allowed, false, "A's live attempts were kept");
  c.advance(15 * MIN);
  assert.equal(limiter.begin("F", null).allowed, true, "expired keys make room");
});

test("the idle sweeper is one unref'd timer per process, replaced (not duplicated) when the module reloads", () => {
  const first = globalThis.__studentLoginLimiterSweeper;
  assert.ok(first, "a sweeper exists");
  assert.equal(first.hasRef(), false, "it never keeps the process alive");
  const file = require.resolve(path.join(root, "lib", "student-login-rate-limit.ts"));
  const cached = require.cache[file];
  delete require.cache[file];
  try {
    require(file);
    const second = globalThis.__studentLoginLimiterSweeper;
    assert.notEqual(second, first);
    assert.equal(first._destroyed, true, "the previous timer was cleared");
    assert.equal(second.hasRef(), false);
  } finally {
    clearInterval(globalThis.__studentLoginLimiterSweeper);
    require.cache[file] = cached;
  }
});


// ---- Generic credential errors and timing ------------------------------------------------------------

test("every invalid credential is the same 401: unknown, deleted, no password, wrong password, registration number as password", async () => {
  reset();
  student("w");
  student("np", { password: null });
  student("del", { status: 2 });
  student("dflt", { password: realBcrypt.hashSync("REG-DFLT", 4) });
  const answers = [
    await wrong("REG-W"),
    await login({ loginId: "REG-UNKNOWN", password: PASSWORD }),
    await login({ loginId: "REG-NP", password: PASSWORD }),
    await login({ loginId: "REG-DEL", password: PASSWORD }),
    await login({ loginId: "REG-DFLT", password: "REG-DFLT" }),
  ];
  for (const answer of answers) {
    assert.equal(answer.status, 401);
    assert.deepEqual(answer.body, GENERIC_401);
    assert.equal(answer.cookie, null);
  }
  assert.deepEqual(state.deviceCalls, []);
});

test("exactly one bcrypt comparison per attempt; unknown and password-less accounts use the fixed cost-12 dummy hash", async () => {
  reset();
  assert.equal(realBcrypt.getRounds(DUMMY), 12, "the same cost as stored passwords");
  assert.equal(DUMMY.length, 60);
  assert.notEqual(DUMMY, PASSWORD);
  student("np", { password: null });
  student("w");
  await login({ loginId: "REG-UNKNOWN", password: PASSWORD });
  await login({ loginId: "REG-NP", password: PASSWORD });
  await wrong("REG-W");
  assert.deepEqual(state.compares, [DUMMY, DUMMY, HASH]);
  const source = fs.readFileSync(path.join(root, "services", "auth-service.ts"), "utf8");
  const body = source.slice(source.indexOf("export async function loginStudent"), source.indexOf("export async function loginByLoginId"));
  assert.match(body, /bcrypt\.compare\(password, storedHash \?\? DUMMY_PASSWORD_HASH\)/);
  assert.doesNotMatch(body, /bcrypt\.hash\(|genSalt/, "no hash is generated per request");
});

test("a wrong password never reveals the account's state; a correct one keeps the existing answers (not counted as failures)", async () => {
  reset();
  student("unconf", { emailConfirmed: false });
  student("pend", { confirmationStatus: "PENDING" });
  student("off", { status: 1 });
  student("noemail", { email: null });
  student("dev", { devicePending: true });
  for (const id of ["unconf", "pend", "off", "noemail", "dev"]) {
    assert.deepEqual((await wrong(`REG-${id.toUpperCase()}`)).body, GENERIC_401, id);
  }
  const expected = { pend: "STUDENT_PENDING_APPROVAL", off: "STUDENT_DEACTIVATED", noemail: "STUDENT_EMAIL_MISSING", dev: "DEVICE_PENDING" };
  for (const [id, code] of Object.entries(expected)) {
    const answer = await right(`REG-${id.toUpperCase()}`);
    assert.deepEqual([answer.status, answer.body.error.code], [403, code], id);
  }
  // Simplified registration: students no longer confirm their email before signing in.
  assert.equal((await right("REG-UNCONF")).status, 200, "an unconfirmed email no longer blocks a student");
  // Six more correct-password logins answered 403: still not locked by failures (only the attempt cap applies).
  for (let i = 0; i < 6; i += 1) assert.equal((await right("REG-DEV")).body.error.code, "DEVICE_PENDING");
});

// ---- Rate limits through the route ------------------------------------------------------------------------

test("5 failures lock the number: even the right password is 429 LOGIN_RATE_LIMITED with Retry-After, before any bcrypt work", async () => {
  reset();
  student("s1");
  for (let i = 0; i < 5; i += 1) assert.equal((await wrong(i % 2 ? "reg-s1" : "  REG-S1 ")).status, 401);
  state.compares = [];
  const limited = await right("REG-S1");
  assert.deepEqual([limited.status, limited.body], [429, GENERIC_429]);
  assert.ok(Number(limited.retryAfter) > 890 && Number(limited.retryAfter) <= 900);
  assert.deepEqual(state.compares, [], "no bcrypt once a limit is reached");
  assert.equal(limited.cookie, null);

  for (let i = 0; i < 5; i += 1) await wrong("REG-NOBODY");
  const unknown = await wrong("REG-NOBODY");
  assert.deepEqual([unknown.status, unknown.body], [429, GENERIC_429], "unknown numbers are limited identically: existence is not revealed");
});

test("a successful login clears the number's failures; the attempt budget (10) still applies to successes", async () => {
  reset();
  student("s1");
  for (let i = 0; i < 4; i += 1) await wrong("REG-S1");
  assert.equal((await right("REG-S1")).status, 200);
  for (let i = 0; i < 4; i += 1) assert.equal((await wrong("REG-S1")).status, 401, "failures were cleared");
  assert.equal((await right("REG-S1")).status, 200, "10th attempt");
  assert.deepEqual((await right("REG-S1")).body, GENERIC_429, "11th attempt");

  reset();
  student("s2");
  for (let i = 0; i < 10; i += 1) assert.equal((await right("REG-S2")).status, 200);
  assert.equal((await right("REG-S2")).status, 429);
});

test("concurrent wrong logins for one number: exactly 5 are checked, the rest are 429 without bcrypt", async () => {
  reset();
  student("s1");
  const answers = await Promise.all(Array.from({ length: 20 }, () => wrong("REG-S1")));
  assert.equal(answers.filter((a) => a.status === 401).length, 5);
  assert.equal(answers.filter((a) => a.status === 429).length, 15);
  assert.equal(state.compares.length, 5);
});

test("IP: only the trusted proxy's address counts; spoofed X-Forwarded-For / X-Real-IP do not change the key; no trusted address skips it", async () => {
  reset({ failuresPerIp: 6, globalFailures: 1_000 });
  process.env.TRUSTED_PROXY_COUNT = "1";
  for (let i = 0; i < 6; i += 1) {
    student(`u${i}`);
    // Each attempt claims a different first hop and X-Real-IP; nginx's appended address is the same.
    await wrong(`REG-U${i}`, { "x-forwarded-for": `6.6.6.${i}, 203.0.113.7`, "x-real-ip": `7.7.7.${i}` });
  }
  const blocked = await wrong("REG-U9", { "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
  assert.deepEqual([blocked.status, blocked.body], [429, GENERIC_429], "students behind one address share its failure budget");
  assert.equal((await wrong("REG-U9", { "x-forwarded-for": "203.0.113.7, 203.0.113.8" })).status, 401, "another trusted address is unaffected");

  reset({ failuresPerIp: 6, globalFailures: 1_000 }); // no TRUSTED_PROXY_COUNT: clientKey is null
  for (let i = 0; i < 12; i += 1) await wrong(`REG-V${i}`, { "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7" });
  assert.equal((await wrong("REG-V99", { "x-forwarded-for": "203.0.113.7" })).status, 401, "untrusted headers never create an IP limit");
});

test("IP: successful classroom logins never use the address's failure budget", async () => {
  reset({ failuresPerIp: 6, globalFailures: 1_000 });
  process.env.TRUSTED_PROXY_COUNT = "1";
  const school = { "x-forwarded-for": "203.0.113.50" };
  for (let i = 0; i < 40; i += 1) {
    student(`c${i}`);
    assert.equal((await right(`REG-C${i}`, school)).status, 200);
  }
  for (let i = 0; i < 6; i += 1) assert.equal((await wrong(`REG-C${i}`, school)).status, 401, "all six failures still available");
  assert.equal((await wrong("REG-C10", school)).status, 429);
});

test("global failures: shared by every number and address, same 429; successes do not count; the window expires", async () => {
  const c = clock();
  reset({ now: c.now, failuresPerIp: 5, globalFailures: 8 });
  process.env.TRUSTED_PROXY_COUNT = "1";
  student("ok");
  assert.equal((await right("REG-OK", { "x-forwarded-for": "10.0.0.1" })).status, 200);
  for (let i = 0; i < 8; i += 1) assert.equal((await wrong(`REG-G${i}`, { "x-forwarded-for": `10.0.1.${i}` })).status, 401);
  const blocked = await right("REG-OK", { "x-forwarded-for": "10.9.9.9" });
  assert.deepEqual([blocked.status, blocked.body], [429, GENERIC_429], "even a correct password from a fresh address");
  c.advance(15 * MIN);
  assert.equal((await right("REG-OK", { "x-forwarded-for": "10.9.9.9" })).status, 200);
});

test("a database error during the check is a 500, not a counted failure", async () => {
  reset();
  student("s1");
  state.failReads = true;
  for (let i = 0; i < 6; i += 1) assert.equal((await right("REG-S1")).status, 500);
  state.failReads = false;
  assert.equal((await right("REG-S1")).status, 200, "six errors locked nothing (7th attempt of 10)");
});

// ---- Role isolation ----------------------------------------------------------------------------------------

test("teacher and guardian logins never use the student limiter; admin returns before it", async () => {
  const limiter = reset();
  for (let i = 0; i < 12; i += 1) {
    assert.equal((await login({ loginId: "teacher@example.test", password: "wrong-teacher-pw" })).status, 401);
  }
  assert.equal((await login({ loginId: "teacher@example.test", password: PASSWORD })).status, 200, "no lock for teachers (unchanged)");
  for (let i = 0; i < 12; i += 1) {
    const response = await guardianLoginRoute.POST(new Request("http://localhost:3000/api/guardian-auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "guardian@example.test", password: "wrong-guardian-pw" }) }));
    assert.equal(response.status, 401);
  }
  assert.deepEqual(limiter.trackedKeys(), { attempts: 0, registrationFailures: 0, ipFailures: 0 }, "the student limiter saw nothing");

  const route = fs.readFileSync(path.join(root, "app", "api", "auth", "login", "route.ts"), "utf8").replace(/\r\n/g, "\n");
  const adminBranch = route.slice(route.indexOf("if (normalizedLoginId === ADMIN_LOGIN_ID"), route.indexOf("const loginResult"));
  assert.doesNotMatch(adminBranch, /loginByLoginId|clientKey|RateLimit/, "the admin shortcut returns before any student logic");
  const service = fs.readFileSync(path.join(root, "services", "auth-service.ts"), "utf8").replace(/\r\n/g, "\n");
  const teacherLogin = service.slice(service.indexOf("export async function loginTeacher"), service.indexOf("/** The one answer for every invalid student credential"));
  assert.doesNotMatch(teacherLogin, /RateLimit|studentLoginRateLimiter|DUMMY/);
  for (const file of ["app/api/guardian-auth/login/route.ts", "services/guardian-service.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, ...file.split("/")), "utf8"), /student-login-rate-limit/, file);
  }
});

// ---- Login UI ------------------------------------------------------------------------------------------------

test("login form: a 429 / LOGIN_RATE_LIMITED shows the fixed message (nothing about the account); other errors as before", () => {
  const form = fs.readFileSync(path.join(root, "components", "login-form.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.match(
    form,
    /if \(response\.status === 429 \|\| err\.code === "LOGIN_RATE_LIMITED"\) \{\s*message = "Too many login attempts\. Please wait before trying again\.";\s*\}/
  );
  assert.ok(form.indexOf('err.code === "LOGIN_RATE_LIMITED"') < form.indexOf("setErrorMessage(message);"), "set before it is shown");
  assert.match(form, /err\.code === "EMAIL_NOT_CONFIRMED"/, "existing branches untouched");
  assert.match(form, /err\.code === "DEVICE_PENDING"/);
});

test("Retry-After is the longest wait among the budgets that refuse (never too early)", () => {
  const c = clock(0);
  const limiter = createStudentLoginRateLimiter({ now: c.now, failuresPerRegistration: 5, failuresPerIp: 6, globalFailures: 6 });
  limiter.begin("OTHER", null).ticket.fail(); // global failure at 0 min
  c.advance(5 * MIN);
  for (let i = 0; i < 5; i += 1) limiter.begin("TARGET", null).ticket.fail(); // number + global at 5 min
  c.advance(MIN);
  // At 6 min: global (6 used; oldest frees at 15 min -> 540 s) and the number (frees at 20 min -> 840 s) both refuse.
  assert.deepEqual(limiter.begin("TARGET", null), { allowed: false, retryAfterSeconds: 840 });
  assert.deepEqual(limiter.begin("ELSEWHERE", null), { allowed: false, retryAfterSeconds: 540 }, "only the global budget refuses here");
});

test("SP-6F: the bounded sweep moves on past live keys (a cursor), so expired keys behind them are cleaned", () => {
  const c = clock();
  const limiter = createStudentLoginRateLimiter({ now: c.now });
  for (let i = 0; i < 10; i += 1) limiter.begin(`LIVE-${i}`, null).ticket.succeed(); // first in the map
  for (let i = 0; i < 40; i += 1) limiter.begin(`OLD-${i}`, null).ticket.succeed();
  c.advance(10 * MIN);
  for (let i = 0; i < 10; i += 1) limiter.begin(`LIVE-${i}`, null).ticket.succeed(); // still live, still first
  c.advance(6 * MIN); // OLD-* expired; LIVE-* are 6 minutes old
  for (let i = 0; i < 6; i += 1) limiter.sweep(10);
  assert.equal(limiter.trackedKeys().attempts, 10, "all 40 expired keys behind the 10 live ones were reached");
});
