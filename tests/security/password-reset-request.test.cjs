/*
 * Student Profile SP-7C: password-reset request security
 * (POST /api/auth/password-reset/request -> lib/password-reset-request-http.ts
 * -> services/auth-service.ts requestPasswordReset, with
 * lib/password-reset-request-rate-limit.ts).
 *
 *   npm run test:security
 *
 * No database: lib/prisma.ts is a stateful fake (its $transaction snapshots
 * and restores on failure and tags writes made through `tx`). The mailer is a
 * fake that records each reset email and can fail or be held open. The
 * limiter is the real one (fresh per test, often with small limits and an
 * injected clock). APP_URL / TRUSTED_PROXY_COUNT / JWT_SECRET are throwaway
 * in-process values; no .env file is read.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

process.env.JWT_SECRET = "sp-7c-test-secret-not-a-real-one-0123456789";
process.env.APP_URL = "http://localhost:3000";
process.env.TRUSTED_PROXY_COUNT = "1";
const APP = "http://localhost:3000";

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

// ---- State --------------------------------------------------------------------------------------

const OLD_HASH = realBcrypt.hashSync("old-password-1", 4);
const state = {};
function resetState() {
  Object.assign(state, {
    teachers: [],
    guardians: [],
    students: [],
    tokens: [],
    log: [],
    mails: [],
    links: [],
    mailMode: "ok", // "ok" | "fail" | "hold"
    held: [],
    failTokenCreate: false,
  });
}
resetState();
const log = (entry) => state.log.push(entry);
const ops = (name) => state.log.filter((e) => e.op === name);
const lookups = () => state.log.filter((e) => ["teacher.findUnique", "guardian.findFirst", "student.findMany"].includes(e.op)).map((e) => e.op);

fakeAt(require.resolve("bcryptjs", { paths: [root] }), { ...realBcrypt, hash: async (p) => realBcrypt.hash(p, 4) });

// ---- Fake Prisma --------------------------------------------------------------------------------

const pick = (row, select) => Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));

function matches(row, where) {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
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

const snapshot = () => ({ tokens: state.tokens.map((t) => ({ ...t })), teachers: state.teachers.map((t) => ({ ...t })) });
const restore = (snap) => Object.assign(state, snap);

const prisma = {
  teacher: {
    findUnique: async ({ where, select }) => {
      log({ op: "teacher.findUnique", where });
      const row = state.teachers.find((t) => t.email === where.email);
      return row ? pick(row, select) : null;
    },
    update: async ({ where, data, viaTx = false }) => {
      log({ op: "teacher.update", viaTx });
      const row = state.teachers.find((t) => t.id === where.id);
      if (!row) throw new Error("Record to update not found.");
      row.password = data.password;
      return { id: row.id };
    },
  },
  guardian: {
    findFirst: async ({ where, select }) => {
      log({ op: "guardian.findFirst", where });
      const row = state.guardians.find((g) => g.email === where.email);
      return row ? pick(row, select) : null;
    },
    update: async ({ where, data }) => {
      const row = state.guardians.find((g) => g.id === where.id);
      row.password = data.password;
      return { id: row.id };
    },
  },
  student: {
    findMany: async ({ where, select, take }) => {
      log({ op: "student.findMany", where, take });
      return state.students.filter((s) => matches(s, where)).slice(0, take).map((s) => pick(s, select));
    },
  },
  passwordResetToken: {
    findFirst: async ({ where, select }) => {
      const row = state.tokens.find((t) => matches(t, where));
      return row ? pick(row, select) : null;
    },
    updateMany: async ({ where, data, viaTx = false }) => {
      log({ op: "token.updateMany", viaTx, where });
      const hit = state.tokens.filter((t) => matches(t, where));
      hit.forEach((t) => Object.assign(t, data));
      return { count: hit.length };
    },
    create: async ({ data, viaTx = false }) => {
      log({ op: "token.create", viaTx });
      if (state.failTokenCreate) throw new Error("token insert failed");
      const row = { id: `tok-${state.tokens.length + 1}-${crypto.randomUUID()}`, usedAt: null, createdAt: new Date(), ...data };
      state.tokens.push(row);
      return row;
    },
  },
  $transaction: async (fn) => {
    log({ op: "tx.begin" });
    const snap = snapshot();
    const tx = {
      passwordResetToken: {
        updateMany: (args) => prisma.passwordResetToken.updateMany({ ...args, viaTx: true }),
        create: (args) => prisma.passwordResetToken.create({ ...args, viaTx: true }),
      },
      teacher: { update: (args) => prisma.teacher.update({ ...args, viaTx: true }) },
      guardian: { update: (args) => prisma.guardian.update({ ...args, viaTx: true }) },
    };
    try {
      const result = await fn(tx);
      log({ op: "tx.commit" });
      return result;
    } catch (error) {
      restore(snap);
      log({ op: "tx.rollback" });
      throw error;
    }
  },
};

fake("lib/prisma.ts", { prisma });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
fake("lib/mailer.ts", {
  buildPasswordResetLink: (token, base) => {
    state.links.push(token);
    const url = new URL("/reset-password/confirm", base || APP);
    url.searchParams.set("token", token);
    return url.toString();
  },
  sendPasswordResetEmail: async (input) => {
    log({ op: "mail", to: input.to });
    state.mails.push(input);
    if (state.mailMode === "fail") throw new Error("smtp down");
    if (state.mailMode === "hold") await new Promise((resolve) => state.held.push(resolve));
  },
  sendPasswordChangedEmail: async () => {},
  sendEmailVerificationCodeEmail: async () => {},
});
fake("lib/email-verification.ts", { createEmailVerificationCode: async () => "000000", verifyEmailConfirmationCode: async () => {} });
fake("lib/email-uniqueness.ts", { assertEmailAvailable: async () => {} });
fake("services/teacher-profile-section-service.ts", { defaultProfileSectionsCreateInput: () => ({}) });

const service = require(path.join(root, "services", "auth-service.ts"));
const limits = require(path.join(root, "lib", "password-reset-request-rate-limit.ts"));
const http = require(path.join(root, "lib", "password-reset-request-http.ts"));
const route = require(path.join(root, "app", "api", "auth", "password-reset", "request", "route.ts"));

// ---- Helpers ------------------------------------------------------------------------------------

function setup() {
  resetState();
  state.teachers.push({ id: "t-1", email: "teacher@example.test", password: OLD_HASH });
  state.guardians.push({ id: "g-1", email: "guardian@example.test", password: OLD_HASH });
  state.students.push(
    { id: "s-active", teacherId: "t-1", registrationNumber: "PK-2026-1", email: "active@example.test", status: 0 },
    { id: "s-inactive", teacherId: "t-1", registrationNumber: "PK-2026-2", email: "inactive@example.test", status: 1 },
    { id: "s-deleted", teacherId: "t-1", registrationNumber: "PK-2026-3", email: "deleted@example.test", status: 2 },
    { id: "s-noemail", teacherId: "t-1", registrationNumber: "PK-2026-4", email: null, status: 0 },
    // The same email at two teachers (allowed: student emails are unique per teacher).
    { id: "s-shared-a", teacherId: "t-1", registrationNumber: "PK-2026-5", email: "shared@example.test", status: 0 },
    { id: "s-shared-b", teacherId: "t-2", registrationNumber: "OT-2026-1", email: "shared@example.test", status: 0 }
  );
  limits.setPasswordResetRequestRateLimiterForTests(limits.createPasswordResetRequestRateLimiter());
}

const SAME_ORIGIN = { Origin: APP, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };

/** POST through the real route (default process limiter) unless a limiter is given. */
async function post(body, { headers = {}, origin = true, limiter, raw = false } = {}) {
  const request = new Request(`${APP}/api/auth/password-reset/request`, {
    method: "POST",
    headers: { ...(origin ? SAME_ORIGIN : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const response = limiter ? await http.handlePasswordResetRequest(request, { limiter }) : await route.POST(request);
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null, headers: response.headers };
}

const settle = () => service.settlePasswordResetEmailsForTests();
const activeTokens = (userId) => state.tokens.filter((t) => t.userId === userId && t.usedAt === null);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const GENERIC = { success: true, data: { requested: true }, message: http.PASSWORD_RESET_REQUESTED_MESSAGE };

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

function assertNoStore(response, label) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0", label);
  assert.equal(response.headers.get("pragma"), "no-cache", label);
  assert.equal(response.headers.get("expires"), "0", label);
}

// ---- Student identification -------------------------------------------------------------------------

test("student: the registration number (as at login: trimmed, any case) resolves exactly that student", async () => {
  setup();
  for (const id of ["PK-2026-1", "pk-2026-1", "  Pk-2026-1  "]) {
    const response = await post({ loginId: id });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, GENERIC);
  }
  await settle();
  assert.deepEqual(new Set(state.tokens.map((t) => t.userId)), new Set(["s-active"]));
  assert.ok(state.tokens.every((t) => t.role === "STUDENT" && t.email === "active@example.test"));
  assert.deepEqual(state.mails.map((m) => m.to), ["active@example.test", "active@example.test", "active@example.test"]);
  const [lookup] = ops("student.findMany");
  assert.deepEqual(lookup.where, { registrationNumber: "PK-2026-1", status: { not: 2 } });
  assert.equal(lookup.take, 2, "at most two rows: enough to detect an ambiguous match");
});

test("student: a student's email is not a reset identifier (even an unambiguous one)", async () => {
  setup();
  const response = await post({ loginId: "active@example.test" });
  await settle();
  assert.deepEqual(response.body, GENERIC);
  assert.equal(state.tokens.length, 0);
  assert.equal(state.mails.length, 0);
  assert.ok(ops("student.findMany").every((e) => !("email" in e.where) && !("OR" in e.where)), "students are never queried by email");
});

test("student: an email shared by students of different teachers selects nobody", async () => {
  setup();
  const response = await post({ loginId: "shared@example.test" });
  await settle();
  assert.deepEqual(response.body, GENERIC);
  assert.equal(state.tokens.length, 0);
  assert.equal(state.mails.length, 0);
});

test("student: more than one current holder of a number (legacy data) issues nothing — no arbitrary pick", async () => {
  setup();
  state.students.push({ id: "s-dup", teacherId: "t-2", registrationNumber: "PK-2026-1", email: "dup@example.test", status: 0 });
  const response = await post({ loginId: "PK-2026-1" });
  await settle();
  assert.deepEqual(response.body, GENERIC);
  assert.equal(state.tokens.length, 0);
  assert.equal(state.mails.length, 0);
});

test("student: a deleted holder plus a current holder of the number -> the current one", async () => {
  setup();
  state.students.push({ id: "s-new", teacherId: "t-1", registrationNumber: "PK-2026-3", email: "new-holder@example.test", status: 0 });
  await post({ loginId: "PK-2026-3" });
  await settle();
  assert.deepEqual(state.tokens.map((t) => t.userId), ["s-new"]);
  assert.deepEqual(state.mails.map((m) => m.to), ["new-holder@example.test"]);
});

test("student: unknown, deleted, no-email and inactive students all get the identical response", async () => {
  setup();
  const answers = {};
  for (const id of ["PK-2026-1", "PK-9999-9", "PK-2026-3", "PK-2026-4", "PK-2026-2"]) {
    const { status, text } = await post({ loginId: id });
    answers[id] = `${status} ${text}`;
  }
  await settle();
  assert.equal(new Set(Object.values(answers)).size, 1, JSON.stringify(answers));
  // Behind the identical answer: active and inactive (allowed to reset, as before) got a link; the others nothing.
  assert.deepEqual(state.tokens.map((t) => t.userId).sort(), ["s-active", "s-inactive"]);
});

test("student: a registration number longer than 64 characters is never looked up; same answer", async () => {
  setup();
  const long = "A".repeat(65);
  const response = await post({ loginId: long });
  assert.deepEqual(response.body, GENERIC);
  assert.equal(ops("student.findMany").length, 0, "no student query");
  assert.deepEqual(lookups(), ["teacher.findUnique", "guardian.findFirst"]);
  state.log = [];
  await post({ loginId: "A".repeat(64) });
  assert.equal(ops("student.findMany").length, 1, "64 characters is still a registration number");
});

test("an identifier longer than 254 characters is a 400 before any lookup (format only)", async () => {
  setup();
  const response = await post({ loginId: "a".repeat(255) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
  assert.equal(lookups().length, 0);
});

// ---- Teacher and guardian compatibility --------------------------------------------------------------

test("teacher / guardian: email-based requests work as before (any case), same answer as everyone", async () => {
  setup();
  const teacher = await post({ loginId: "  Teacher@Example.TEST " });
  const guardian = await post({ loginId: "GUARDIAN@example.test" });
  const nobody = await post({ loginId: "nobody@example.test" });
  await settle();
  for (const answer of [teacher, guardian, nobody]) {
    assert.equal(answer.status, 200);
    assert.equal(answer.text, nobody.text);
  }
  assert.deepEqual(
    state.tokens.map((t) => [t.role, t.userId, t.email]),
    [
      ["TEACHER", "t-1", "teacher@example.test"],
      ["GUARDIAN", "g-1", "guardian@example.test"],
    ]
  );
  assert.deepEqual(state.mails.map((m) => m.to), ["teacher@example.test", "guardian@example.test"]);
  assert.deepEqual(ops("teacher.findUnique")[0].where, { email: "teacher@example.test" });
  assert.deepEqual(ops("guardian.findFirst")[0].where, { email: "teacher@example.test" });
});

test("teacher: the emailed link (same format) still resets the password through the SP-7B confirmation", async () => {
  setup();
  await post({ loginId: "teacher@example.test" });
  await settle();
  const link = new URL(state.mails[0].resetLink);
  assert.equal(link.pathname, "/reset-password/confirm");
  const token = link.searchParams.get("token");
  await service.confirmPasswordReset(token, "Teacher-New-Pass1");
  assert.ok(realBcrypt.compareSync("Teacher-New-Pass1", state.teachers[0].password));
  await assert.rejects(service.confirmPasswordReset(token, "Again-New-Pass1"), (e) => e.code === "INVALID_RESET_TOKEN");
});

// ---- Account enumeration -----------------------------------------------------------------------

test("existing and nonexistent identifiers: identical status, body and headers; identical queries", async () => {
  setup();
  const results = [];
  for (const id of ["teacher@example.test", "guardian@example.test", "PK-2026-1", "nobody@example.test", "PK-0000-0"]) {
    state.log = [];
    const response = await post({ loginId: id });
    results.push({
      id,
      answer: `${response.status} ${response.text}`,
      headers: [...response.headers.entries()].filter(([name]) => name !== "date").sort().join("|"),
      lookups: lookups().sort().join(","),
    });
  }
  await settle();
  assert.equal(new Set(results.map((r) => r.answer)).size, 1);
  assert.equal(new Set(results.map((r) => r.headers)).size, 1);
  assert.equal(new Set(results.map((r) => r.lookups)).size, 1, "every request runs the same three lookups");
  assert.equal(results[0].lookups, "guardian.findFirst,student.findMany,teacher.findUnique");
  for (const r of results) {
    for (const leak of ["t-1", "g-1", "s-active", "TEACHER", "STUDENT", "GUARDIAN", "@example.test"]) {
      assert.equal(r.answer.includes(leak), false, `${r.id}: response mentions ${leak}`);
    }
  }
});

test("email delivery failure: same answer, the link was issued, nothing sensitive logged", async () => {
  setup();
  state.mailMode = "fail";
  const { result, lines } = await quietErrors(async () => {
    const response = await post({ loginId: "PK-2026-1" });
    await settle();
    return response;
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, GENERIC);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[password-reset\] Reset request email step failed \(Error\)\.$/);
  for (const secret of ["PK-2026-1", "active@example.test", state.links[0], state.tokens[0].tokenHash]) {
    assert.equal(lines[0].includes(secret), false);
  }
});

test("the response does not wait for the email (its duration cannot reveal the account)", async () => {
  setup();
  state.mailMode = "hold";
  const response = await post({ loginId: "PK-2026-1" });
  assert.equal(response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.mails.length, 1, "sending started");
  assert.equal(state.held.length, 1, "still in flight after the response");
  state.held.forEach((release) => release());
  await settle();
});

test("token storage failure: same answer, no email, generic log", async () => {
  setup();
  state.failTokenCreate = true;
  const { result, lines } = await quietErrors(async () => {
    const response = await post({ loginId: "teacher@example.test" });
    await settle();
    return response;
  });
  assert.deepEqual(result.body, GENERIC);
  assert.equal(state.mails.length, 0);
  assert.equal(state.tokens.length, 0);
  assert.deepEqual(lines, ["[password-reset] Reset request token step failed (Error)."]);
});

test("exactly one email per request", async () => {
  setup();
  await post({ loginId: "PK-2026-1" });
  await post({ loginId: "teacher@example.test" });
  await settle();
  assert.equal(state.mails.length, 2);
});

// ---- Rate limiting (through the route) ------------------------------------------------------------

test("per identifier: 3 requests per 15 minutes (normalized), then 429 with Retry-After; other identifiers unaffected", async () => {
  setup();
  for (const id of ["PK-2026-1", "pk-2026-1", " PK-2026-1"]) assert.equal((await post({ loginId: id }, { headers: { "X-Forwarded-For": `198.51.100.${Math.random() * 200 | 0}` } })).status, 200);
  state.log = [];
  const refused = await post({ loginId: "Pk-2026-1" });
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.body, { success: false, error: { message: "Too many password reset requests. Please wait and try again.", code: "PASSWORD_RESET_RATE_LIMITED" } });
  const retry = Number(refused.headers.get("retry-after"));
  assert.ok(retry > 0 && retry <= 900, String(retry));
  assertNoStore(refused, "429");
  assert.equal(lookups().length, 0, "refused before any lookup");
  assert.equal((await post({ loginId: "teacher@example.test" })).status, 200);
  await settle();
  assert.equal(state.mails.filter((m) => m.to === "active@example.test").length, 3, "no more than 3 emails to one account");
});

test("a rate-limited answer is the same for existing and nonexistent identifiers", async () => {
  setup();
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 10, globalRequests: 100, maxKeys: 100 });
  await post({ loginId: "PK-2026-1" }, { limiter });
  await post({ loginId: "PK-NOPE-1" }, { limiter });
  const a = await post({ loginId: "PK-2026-1" }, { limiter });
  const b = await post({ loginId: "PK-NOPE-1" }, { limiter });
  assert.equal(a.status, 429);
  assert.equal(`${a.status} ${a.text} ${a.headers.get("retry-after")}`, `${b.status} ${b.text} ${b.headers.get("retry-after")}`);
  await settle();
});

test("per address: the trusted client address (right-most hop) is limited; spoofed left hops and X-Real-IP do not help", async () => {
  setup();
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 3, globalRequests: 100, maxKeys: 100 });
  const from = (spoof) => ({ "X-Forwarded-For": `${spoof}, 203.0.113.9`, "X-Real-IP": spoof });
  for (let i = 0; i < 3; i += 1) assert.equal((await post({ loginId: `PK-X-${i}` }, { limiter, headers: from(`10.0.0.${i}`) })).status, 200);
  const refused = await post({ loginId: "PK-X-new" }, { limiter, headers: from("10.0.0.99") });
  assert.equal(refused.status, 429, "a new spoofed left-most hop does not reset the address budget");
  assert.deepEqual(limiter.keysForTests().addresses, ["203.0.113.9"]);
  assert.equal((await post({ loginId: "PK-X-new" }, { limiter, headers: { "X-Forwarded-For": "203.0.113.10" } })).status, 200, "another address is unaffected");
  await settle();
});

test("no trusted proxy configured: client headers are ignored and no address budget is kept", async () => {
  setup();
  const saved = process.env.TRUSTED_PROXY_COUNT;
  delete process.env.TRUSTED_PROXY_COUNT;
  try {
    const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 1, globalRequests: 100, maxKeys: 100 });
    for (let i = 0; i < 3; i += 1) assert.equal((await post({ loginId: `PK-Y-${i}` }, { limiter, headers: { "X-Forwarded-For": "203.0.113.9" } })).status, 200);
    assert.deepEqual(limiter.keysForTests().addresses, []);
  } finally {
    process.env.TRUSTED_PROXY_COUNT = saved;
  }
  await settle();
});

test("global: all requests together are capped", async () => {
  setup();
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 1, globalRequests: 3, maxKeys: 10 });
  for (let i = 0; i < 3; i += 1) assert.equal((await post({ loginId: `PK-G-${i}` }, { limiter, headers: { "X-Forwarded-For": `203.0.113.${i}` } })).status, 200);
  const refused = await post({ loginId: "PK-G-9" }, { limiter, headers: { "X-Forwarded-For": "203.0.113.50" } });
  assert.equal(refused.status, 429);
  await settle();
});

// ---- Rate limiter (unit) ------------------------------------------------------------------------

test("limiter: Retry-After comes from the limiter state; the window slides", () => {
  let now = 1_000_000;
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 2, requestsPerIp: 10, globalRequests: 10, maxKeys: 10, now: () => now });
  assert.equal(limiter.attempt("ID", null).allowed, true);
  now += 5 * 60_000;
  assert.equal(limiter.attempt("ID", null).allowed, true);
  now += 60_000;
  assert.deepEqual(limiter.attempt("ID", null), { allowed: false, retryAfterSeconds: 9 * 60 }, "the first request frees its slot 9 minutes from now");
  now += 9 * 60_000;
  assert.equal(limiter.attempt("ID", null).allowed, true);
  // Two budgets refusing with different waits: the longer one is reported.
  let t = 0;
  const two = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 1, globalRequests: 10, maxKeys: 10, now: () => t });
  two.attempt("A", "ip-1");
  t = 60_000;
  two.attempt("B", "ip-2");
  // "B" frees in 15 minutes, "ip-1" in 14: the longer wait is reported.
  assert.deepEqual(two.attempt("B", "ip-1"), { allowed: false, retryAfterSeconds: 15 * 60 });
});

test("limiter: refused requests record nothing", () => {
  let now = 0;
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 5, globalRequests: 5, maxKeys: 10, now: () => now });
  limiter.attempt("A", "ip");
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.attempt("A", "ip").allowed, false);
  for (let i = 0; i < 4; i += 1) assert.equal(limiter.attempt(`B${i}`, "ip").allowed, true, "the refusals took no address or global slots");
});

test("limiter: keys are SHA-256 hashes of the normalized identifier, never the raw value", () => {
  const limiter = limits.createPasswordResetRequestRateLimiter();
  limiter.attempt("  Teacher@Example.test ", null);
  limiter.attempt("pk-2026-1", null);
  limiter.attempt("x".repeat(254), null);
  const keys = limiter.keysForTests().identifiers;
  assert.equal(keys.length, 3);
  for (const key of keys) assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual(keys.slice(0, 2), [sha256("TEACHER@EXAMPLE.TEST"), sha256("PK-2026-1")]);
  assert.equal(limits.passwordResetIdentifierKey("teacher@example.test"), keys[0], "case and spaces share one budget");
  assert.ok(keys.every((k) => !k.toLowerCase().includes("teacher") && !k.includes("PK-2026")));
});

test("limiter: expired entries are cleaned up by the bounded sweep (and on each request)", () => {
  let now = 0;
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 50, globalRequests: 50, maxKeys: 100, now: () => now });
  for (let i = 0; i < 20; i += 1) limiter.attempt(`ID-${i}`, `ip-${i}`);
  assert.deepEqual(limiter.trackedKeys(), { identifiers: 20, addresses: 20 });
  now += 15 * 60_000;
  assert.equal(limiter.sweep(5), 10, "at most the budget per map");
  assert.deepEqual(limiter.trackedKeys(), { identifiers: 15, addresses: 15 });
  limiter.sweep(1_000);
  assert.deepEqual(limiter.trackedKeys(), { identifiers: 0, addresses: 0 });
  // A live entry is never dropped by a sweep.
  limiter.attempt("LIVE", "ip-live");
  assert.ok(limiter.sweep(1_000) <= 4, "a sweep stops after one wrap-around, it does not spend its whole budget");
  assert.deepEqual(limiter.trackedKeys(), { identifiers: 1, addresses: 1 });
  assert.equal(limiter.attempt("LIVE", "ip-live").allowed, false);
});

test("limiter: a budget full of live keys fails closed (429), never evicting; room returns as keys expire", () => {
  let now = 0;
  const roomy = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 1, globalRequests: 3, maxKeys: 3, now: () => now });
  roomy.attempt("A", null);
  now += 10 * 60_000;
  roomy.attempt("B", null);
  roomy.attempt("C", null);
  now += 5 * 60_000 + 1; // A expired, B and C live; global has 2 live entries
  assert.equal(roomy.attempt("D", null).allowed, true, "an expired key is swept to make room");
  assert.deepEqual(roomy.attempt("E", null), { allowed: false, retryAfterSeconds: 600 }, "full of live keys: refused, B frees in 10 minutes");
  assert.deepEqual(roomy.keysForTests().identifiers.length, 3, "no live key was evicted");
  // Capacity alone: identifiers map full of live keys while global still has room.
  let t = 0;
  const capped = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 2, globalRequests: 2, maxKeys: 2, now: () => t });
  capped.attempt("P", null);
  capped.attempt("Q", null);
  const refused = capped.attempt("R", null);
  assert.equal(refused.allowed, false);
  assert.equal(capped.keysForTests().identifiers.length, 2, "no live key was evicted");
});

test("limiter: capacity exhaustion with the global budget not exhausted is refused with the full window", () => {
  // Reach the capacity path directly: identifiers map at maxKeys with live keys, global still allowing.
  let now = 0;
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 1, globalRequests: 2, maxKeys: 2, now: () => now });
  limiter.attempt("A", null);
  now += 14 * 60_000;
  limiter.attempt("B", null);
  now += 60_000 + 1; // A's global entry expired (global has room), but A's identifier key is swept only when examined
  const decision = limiter.attempt("C", null);
  assert.equal(decision.allowed, true, "the bounded capacity sweep found the expired key");
  assert.deepEqual(limiter.attempt("D", null), { allowed: false, retryAfterSeconds: 14 * 60 });
});

test("limiter: a full map whose expired keys the small per-request sweep misses still makes room (capacity sweep)", () => {
  for (const oldKeys of [1, 3, 7]) {
    let now = 0;
    const size = 400;
    const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 1, globalRequests: size, maxKeys: size, now: () => now });
    for (let i = 0; i < oldKeys; i += 1) assert.equal(limiter.attempt(`OLD-${i}`, null).allowed, true);
    now = 60_000;
    for (let i = oldKeys; i < size; i += 1) assert.equal(limiter.attempt(`LIVE-${i}`, null).allowed, true);
    now = 15 * 60_000 + 1; // only the OLD keys expired; the map is full, global has room
    assert.equal(limiter.trackedKeys().identifiers, size);
    for (let i = 0; i < oldKeys; i += 1) assert.equal(limiter.attempt(`NEW-${i}`, null).allowed, true, `room for NEW-${i} (${oldKeys} old)`);
    assert.equal(limiter.trackedKeys().identifiers, size, "never above capacity");
    assert.equal(limiter.attempt("ONE-MORE", null).allowed, false, "and then full of live keys: refused");
  }
});

test("limiter: invalid configuration is rejected at creation", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3"]) {
    for (const key of ["requestsPerIdentifier", "requestsPerIp", "globalRequests", "windowMs", "maxKeys"]) {
      assert.throws(() => limits.createPasswordResetRequestRateLimiter({ [key]: bad }), /must be a positive integer/, `${key}=${bad}`);
    }
  }
  assert.throws(() => limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 30, requestsPerIp: 20 }), /must not exceed/);
  assert.throws(() => limits.createPasswordResetRequestRateLimiter({ requestsPerIp: 600, globalRequests: 500 }), /must not exceed/);
  assert.throws(() => limits.createPasswordResetRequestRateLimiter({ globalRequests: 30_000, maxKeys: 20_000 }), /must not exceed/);
  assert.doesNotThrow(() => limits.createPasswordResetRequestRateLimiter());
  assert.deepEqual({ ...limits.PASSWORD_RESET_REQUEST_RATE_LIMIT }, { requestsPerIdentifier: 3, requestsPerIp: 20, globalRequests: 500, windowMs: 900_000, maxKeys: 20_000 });
});

// ---- HTTP protections ---------------------------------------------------------------------------

test("cross-origin requests are refused before any lookup or rate-limit slot", async () => {
  setup();
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 1, globalRequests: 1, maxKeys: 1 });
  const cases = [
    { origin: false, headers: {} },
    { origin: false, headers: { Origin: "https://evil.example" } },
    { origin: true, headers: { "Sec-Fetch-Site": "cross-site" } },
    { origin: true, headers: { "Sec-Fetch-Site": "same-site" } },
    { origin: false, headers: { Origin: "null" } },
  ];
  for (const c of cases) {
    const response = await post({ loginId: "PK-2026-1" }, { ...c, limiter });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
    assertNoStore(response, "403");
  }
  assert.equal(lookups().length, 0);
  assert.equal(state.tokens.length, 0);
  assert.equal((await post({ loginId: "PK-2026-1" }, { limiter })).status, 200, "no slot was used");
  await settle();
});

test("oversized bodies are refused (declared or actual > 1 KiB)", async () => {
  setup();
  const big = await post({ loginId: "x", pad: "y".repeat(2000) });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, "REQUEST_TOO_LARGE");
  const lying = await post({ loginId: "PK-2026-1" }, { headers: { "Content-Length": "5000" } }).catch((e) => e);
  // Some runtimes refuse a mismatched Content-Length themselves; when the request is built, the declared size is refused.
  if (!(lying instanceof Error)) assert.equal(lying.status, 413);
  const exactLimit = JSON.stringify({ loginId: "a".repeat(1024 - 14) });
  assert.equal(Buffer.byteLength(exactLimit), 1024);
  assert.equal((await post(exactLimit, { raw: true })).status, 400, "1 KiB is read (then the 254-character rule applies)");
  assert.equal(lookups().length, 0);
});

test("malformed JSON, empty bodies, missing / invalid / extra fields: 400, no lookups", async () => {
  setup();
  const cases = [
    ["{not json", "INVALID_JSON"],
    ["", "INVALID_JSON"],
    [JSON.stringify({}), "VALIDATION_ERROR"],
    [JSON.stringify({ loginId: "" }), "VALIDATION_ERROR"],
    [JSON.stringify({ loginId: "   " }), "VALIDATION_ERROR"],
    [JSON.stringify({ loginId: 12345 }), "VALIDATION_ERROR"],
    [JSON.stringify({ loginId: ["PK-2026-1"] }), "VALIDATION_ERROR"],
    [JSON.stringify({ loginId: "PK-2026-1", email: "x@example.test" }), "VALIDATION_ERROR"],
    [JSON.stringify(["PK-2026-1"]), "VALIDATION_ERROR"],
    ["null", "VALIDATION_ERROR"],
  ];
  for (const [body, code] of cases) {
    const response = await post(body, { raw: true });
    assert.equal(response.status, 400, body);
    assert.equal(response.body.error.code, code, body);
    assertNoStore(response, body);
  }
  assert.equal(lookups().length, 0);
});

test("every response path is no-store", async () => {
  setup();
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 1, requestsPerIp: 5, globalRequests: 5, maxKeys: 5 });
  const responses = [
    await post({ loginId: "PK-2026-1" }, { limiter }), // 200
    await post({ loginId: "PK-2026-1" }, { limiter }), // 429
    await post({ loginId: "PK-2026-1" }, { origin: false, limiter }), // 403
    await post("{", { raw: true, limiter }), // 400 JSON
    await post({ nope: 1 }, { limiter }), // 400 validation
    await post({ loginId: "x".repeat(2000) }, { limiter }), // 413
  ];
  // 500: a database failure during the lookups (any account, same answer).
  const original = prisma.teacher.findUnique;
  prisma.teacher.findUnique = async () => {
    throw new Error("db down");
  };
  try {
    const { result } = await quietErrors(() => post({ loginId: "PK-2026-9" }, { limiter }));
    responses.push(result);
  } finally {
    prisma.teacher.findUnique = original;
  }
  assert.deepEqual(responses.map((r) => r.status), [200, 429, 403, 400, 400, 413, 500]);
  for (const response of responses) assertNoStore(response, String(response.status));
  await settle();
});

// ---- Token and email ----------------------------------------------------------------------------

test("tokens: 32 random bytes (64 hex), unique; only the SHA-256 is stored; 30-minute expiry", async () => {
  setup();
  const before = Date.now();
  for (const id of ["PK-2026-1", "teacher@example.test", "guardian@example.test", "PK-2026-2"]) await post({ loginId: id });
  await settle();
  assert.equal(state.links.length, 4);
  assert.equal(new Set(state.links).size, 4);
  for (const raw of state.links) assert.match(raw, /^[0-9a-f]{64}$/);
  state.tokens.forEach((row, i) => {
    assert.equal(row.tokenHash, sha256(state.links[i]));
    assert.equal(JSON.stringify(row).includes(state.links[i]), false, "the raw token is stored nowhere");
    const ttl = row.expiresAt.getTime() - before;
    assert.ok(ttl >= 30 * 60_000 && ttl < 30 * 60_000 + 5_000, String(ttl));
  });
});

test("one active link per account: a new request retires the earlier ones (in one transaction), never the new one", async () => {
  setup();
  const limiter = limits.createPasswordResetRequestRateLimiter({ requestsPerIdentifier: 10, requestsPerIp: 20, globalRequests: 20, maxKeys: 20 });
  for (let i = 0; i < 5; i += 1) await post({ loginId: "PK-2026-1" }, { limiter });
  await post({ loginId: "teacher@example.test" }, { limiter });
  await settle();
  assert.equal(state.tokens.filter((t) => t.userId === "s-active").length, 5);
  assert.equal(activeTokens("s-active").length, 1);
  assert.equal(activeTokens("s-active")[0].tokenHash, sha256(state.links[4]), "the latest link is the active one");
  assert.equal(activeTokens("t-1").length, 1, "other accounts untouched");
  const retire = ops("token.updateMany")[0];
  assert.equal(retire.viaTx, true);
  assert.deepEqual(retire.where, { role: "STUDENT", userId: "s-active", usedAt: null });
  const order = state.log.filter((e) => ["tx.begin", "token.updateMany", "token.create", "tx.commit"].includes(e.op)).slice(0, 4).map((e) => e.op);
  assert.deepEqual(order, ["tx.begin", "token.updateMany", "token.create", "tx.commit"]);
  assert.ok(ops("token.create").every((e) => e.viaTx));
  // The earlier links no longer work; the latest does (SP-7B confirmation).
  await assert.rejects(service.confirmPasswordReset(state.links[0], "x-new-pass-1"), (e) => e.code === "INVALID_RESET_TOKEN");
});

test("a failed token insert rolls back the retirement of the earlier link", async () => {
  setup();
  await post({ loginId: "teacher@example.test" });
  state.failTokenCreate = true;
  await quietErrors(() => post({ loginId: "teacher@example.test" }));
  await settle();
  assert.equal(activeTokens("t-1").length, 1, "the earlier link still works");
  assert.equal(state.mails.length, 1);
});

test("the reset email goes to the account's current email", async () => {
  setup();
  state.students.find((s) => s.id === "s-active").email = "changed@example.test";
  await post({ loginId: "PK-2026-1" });
  await settle();
  assert.deepEqual(state.mails.map((m) => m.to), ["changed@example.test"]);
  assert.equal(state.tokens[0].email, "changed@example.test");
});
