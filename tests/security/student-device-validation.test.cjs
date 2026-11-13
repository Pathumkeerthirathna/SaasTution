/*
 * Student Profile SP-6B: student device approval (services/student-device.service.ts,
 * validateStudentDevice). Approval is reached only through an exact identity
 * match (visitor id, or the full fingerprint blob); the guessable browser /
 * OS / platform / model attributes never inherit an APPROVED device and never
 * rebind a device's identity. The client address comes from the trusted proxy
 * chain only (clientKey).
 *
 *   npm run test:security
 *
 * No database: lib/prisma.ts and lib/mailer.ts are fakes.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

// ---- Fake database ------------------------------------------------------------------------------

const state = { devices: [], emails: [], failEmail: false, seq: 0, students: new Map(), decisionEmails: [], failDeviceUpdate: false, failVersionBump: false, transactions: [], writes: [], beforeDeviceWrite: null };

function matches(row, where) {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "student" && expected && typeof expected === "object") {
      // SP-6F: the teacher-ownership relation filter { student: { teacherId } }.
      if (state.students.get(row.studentId)?.teacherId !== expected.teacherId) return false;
      continue;
    }
    if (key === "id" && expected && typeof expected === "object" && "not" in expected) {
      if (row.id === expected.not) return false;
      continue;
    }
    if (expected && typeof expected === "object" && "not" in expected) {
      if (row[key] === expected.not) return false;
      continue;
    }
    if ((row[key] ?? null) !== (expected ?? null)) return false;
  }
  return true;
}
const time = (value) => (value instanceof Date ? value.getTime() : -Infinity);

const prisma = {
  studentDevice: {
    findUnique: async ({ where }) => {
      if (where.id !== undefined) {
        const byId = state.devices.find((d) => d.id === where.id);
        return byId ? { ...byId } : null;
      }
      const { studentId, deviceId } = where.studentId_deviceId;
      const row = state.devices.find((d) => d.studentId === studentId && d.deviceId === deviceId);
      return row ? { ...row } : null;
    },
    findFirst: async ({ where, orderBy }) => {
      let rows = state.devices.filter((d) => matches(d, where));
      const order = Array.isArray(orderBy) ? orderBy[0] : orderBy;
      if (order) {
        const [field] = Object.keys(order);
        rows = [...rows].sort((a, b) => time(b[field]) - time(a[field]));
      }
      return rows[0] ? { ...rows[0] } : null;
    },
    findMany: async ({ where }) => state.devices.filter((d) => matches(d, where)).map((d) => ({ ...d })),
    create: async ({ data }) => {
      const row = { id: `row-${++state.seq}`, approvalRequestedAt: new Date(), lastLoginAt: null, rejectedReason: null, rejectedAt: null, approvalRequestMessage: null, ...data };
      state.devices.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = state.devices.find((d) => d.id === where.id);
      Object.assign(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data, viaTx = false }) => {
      state.writes.push({ op: "device.updateMany", viaTx });
      if (state.beforeDeviceWrite) {
        const hook = state.beforeDeviceWrite;
        state.beforeDeviceWrite = null;
        hook();
      }
      if (state.failDeviceUpdate) throw new Error("device update failed");
      const rows = state.devices.filter((d) => matches(d, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
    deleteMany: async ({ where, viaTx = false }) => {
      state.writes.push({ op: "device.deleteMany", viaTx });
      if (state.beforeDeviceWrite) {
        const hook = state.beforeDeviceWrite;
        state.beforeDeviceWrite = null;
        hook();
      }
      const before = state.devices.length;
      state.devices = state.devices.filter((d) => !matches(d, where));
      return { count: before - state.devices.length };
    },
  },
  student: {
    findUnique: async ({ where } = {}) => {
      const row = where && state.students.get(where.id);
      // Seeded students (SP-6F) answer with their row; otherwise the notification data as before.
      return { name: "Stu One", teacher: { name: "Teacher", email: "teacher@example.test" }, classes: [{ class: { name: "Grade 6" } }], ...(row ?? {}) };
    },
    updateMany: async ({ where, data, viaTx = false }) => {
      state.writes.push({ op: "student.updateMany", viaTx });
      if (state.failVersionBump) throw new Error("version update failed");
      const row = state.students.get(where.id);
      if (!row) return { count: 0 };
      row.sessionVersion += data.sessionVersion.increment;
      return { count: 1 };
    },
  },
};

prisma.$transaction = async (fn, options) => {
  state.transactions.push(options);
  const snap = { devices: state.devices.map((d) => ({ ...d })), students: new Map([...state.students].map(([k, v]) => [k, { ...v }])) };
  // A distinct client whose writes are tagged, so a write that bypasses `tx` is visible.
  const tag = (method) => (args) => method({ ...args, viaTx: true });
  const tx = {
    studentDevice: {
      ...prisma.studentDevice,
      updateMany: tag(prisma.studentDevice.updateMany),
      deleteMany: tag(prisma.studentDevice.deleteMany),
    },
    student: { ...prisma.student, updateMany: tag(prisma.student.updateMany) },
  };
  try {
    return await fn(tx);
  } catch (error) {
    state.devices = snap.devices;
    state.students = snap.students;
    throw error;
  }
};

fake("lib/prisma.ts", { prisma });
fake("lib/mailer.ts", {
  buildDeviceApprovalReviewLink: (studentId) => `https://app.test/review/${studentId}`,
  buildTeacherLoginLink: () => "https://app.test/login",
  sendDeviceApprovalRequestEmail: async (input) => {
    if (state.failEmail) throw new Error("mail down");
    state.emails.push(input);
  },
  sendDeviceDecisionEmail: async (input) => {
    state.decisionEmails.push(input);
  },
});

const service = require(path.join(root, "services", "student-device.service.ts"));
const { validateStudentDevice, MIN_FINGERPRINT_MATCH_LENGTH } = service;

// ---- Helpers ------------------------------------------------------------------------------------------

const STUDENT = "stu-1";
const LONG_FP = (tag) => JSON.stringify({ canvas: `hash-${tag}`, fonts: ["Arial", "Calibri", "Segoe UI"], screen: [1920, 1080], audio: 124.04, tag });
const WINDOWS = { browser: "Chrome", os: "Windows", platform: "Win32" };

function reset() {
  state.devices = [];
  state.emails = [];
  state.failEmail = false;
  state.seq = 0;
  state.students = new Map();
  state.decisionEmails = [];
  state.failDeviceUpdate = false;
  state.failVersionBump = false;
  state.transactions = [];
  state.writes = [];
  state.beforeDeviceWrite = null;
  delete process.env.TRUSTED_PROXY_COUNT;
}
function seed(row) {
  const full = {
    id: `seed-${++state.seq}`,
    studentId: STUDENT,
    deviceId: `visitor-${state.seq}`,
    fingerprint: LONG_FP(state.seq),
    browser: "Chrome",
    browserVersion: "150",
    os: "Windows",
    osVersion: "11",
    deviceModel: null,
    deviceName: "Chrome on Windows",
    platform: "Win32",
    userAgent: "Mozilla/5.0",
    lastIpAddress: "198.51.100.1",
    lastLoginAt: new Date("2026-11-01T08:00:00Z"),
    approvalRequestedAt: new Date("2026-10-01T08:00:00Z"),
    status: "APPROVED",
    rejectedReason: null,
    rejectedAt: null,
    approvalRequestMessage: null,
    ...row,
  };
  state.devices.push(full);
  return full;
}
const request = (headers = {}) => new Request("http://localhost:3000/api/auth/login", { method: "POST", headers });

async function login(device, headers) {
  try {
    await validateStudentDevice({ studentId: STUDENT, device, request: request(headers) });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code, statusCode: error.statusCode, data: error.data };
  }
}
const snapshot = (row) => JSON.parse(JSON.stringify(state.devices.find((d) => d.id === row.id)));

// ---- Exact matches ----------------------------------------------------------------------------------------

test("an exact approved visitor id logs in (no new row, no email), updating only the last login", async () => {
  reset();
  const approved = seed({ deviceId: "visitor-real" });
  const before = snapshot(approved);
  assert.deepEqual(await login({ deviceId: "visitor-real", ...WINDOWS }), { ok: true });
  assert.equal(state.devices.length, 1);
  assert.equal(state.emails.length, 0);
  const after = snapshot(approved);
  assert.notEqual(after.lastLoginAt, before.lastLoginAt);
  for (const key of ["deviceId", "fingerprint", "status", "browser", "os", "platform"]) assert.deepEqual(after[key], before[key], key);
});

test("device information is required", async () => {
  reset();
  const result = await login(undefined);
  assert.deepEqual([result.code, result.statusCode], ["DEVICE_REQUIRED", 400]);
  assert.deepEqual([(await login({ deviceId: "" })).code], ["DEVICE_REQUIRED"]);
});

test("an exact, substantial fingerprint keeps the existing behaviour: approved device logs in and its drifted visitor id is refreshed", async () => {
  reset();
  const fp = LONG_FP("stable");
  assert.ok(fp.length >= MIN_FINGERPRINT_MATCH_LENGTH);
  const approved = seed({ deviceId: "visitor-old", fingerprint: fp });
  const stalePending = seed({ deviceId: "visitor-stale", fingerprint: LONG_FP("stale"), status: "PENDING" });
  assert.deepEqual(await login({ deviceId: "visitor-new", fingerprint: fp, ...WINDOWS }), { ok: true });
  const after = snapshot(approved);
  assert.equal(after.deviceId, "visitor-new", "drifted visitor id refreshed (exact fingerprint only)");
  assert.equal(after.status, "APPROVED");
  assert.equal(state.devices.some((d) => d.id === stalePending.id), false, "stale pending duplicate cleaned up as before");
});

test("a short or trivial fingerprint never identifies a device, even if a stored one is equal", async () => {
  reset();
  const approved = seed({ deviceId: "visitor-real", fingerprint: "{}" });
  const before = snapshot(approved);
  const result = await login({ deviceId: "attacker", fingerprint: "{}", ...WINDOWS });
  assert.equal(result.code, "DEVICE_PENDING");
  assert.deepEqual(snapshot(approved), before, "the approved record is untouched");
  assert.equal(service.MIN_FINGERPRINT_MATCH_LENGTH, 64);
});

// ---- Attribute spoofing -------------------------------------------------------------------------------------

test("spoofed Chrome / Windows / Win32 does not inherit an APPROVED device: a new PENDING device, the approved record untouched", async () => {
  reset();
  const approved = seed({ deviceId: "visitor-real" });
  const before = snapshot(approved);
  const result = await login({ deviceId: "attacker-visitor", fingerprint: LONG_FP("attacker"), ...WINDOWS, browserVersion: "151" });
  assert.equal(result.ok, false);
  assert.deepEqual([result.code, result.statusCode], ["DEVICE_PENDING", 403]);
  assert.deepEqual(snapshot(approved), before, "deviceId, fingerprint and every other field of the approved device unchanged");
  const created = state.devices.find((d) => d.deviceId === "attacker-visitor");
  assert.equal(created.status, "PENDING");
  assert.notEqual(created.id, approved.id);
  assert.equal(result.data.currentDevice.id, created.id);
  assert.equal(state.emails.length, 1, "the teacher is asked, as for any new device");
  // And it keeps failing: the next attempt is an exact match on the new PENDING row.
  assert.equal((await login({ deviceId: "attacker-visitor", ...WINDOWS })).code, "DEVICE_PENDING");
  assert.equal(state.devices.length, 2);
});

test("spoofing a phone by omitting the model does not inherit an approved phone", async () => {
  reset();
  const phone = seed({ deviceId: "visitor-phone", browser: "Chrome", os: "Android", platform: "Linux armv81", deviceModel: "SM-A515F" });
  const before = snapshot(phone);
  const result = await login({ deviceId: "attacker", browser: "Chrome", os: "Android", platform: "Linux armv81" });
  assert.equal(result.code, "DEVICE_PENDING");
  assert.deepEqual(snapshot(phone), before);
  const withModel = await login({ deviceId: "attacker-2", browser: "Chrome", os: "Android", platform: "Linux armv81", deviceModel: "SM-A515F" });
  assert.equal(withModel.code, "DEVICE_PENDING", "even the exact model is only an attribute");
  assert.deepEqual(snapshot(phone), before);
});

test("two devices with the same browser / OS / platform cannot share approval", async () => {
  reset();
  const a = seed({ deviceId: "visitor-a" });
  assert.equal((await login({ deviceId: "visitor-b", ...WINDOWS })).code, "DEVICE_PENDING");
  const b = state.devices.find((d) => d.deviceId === "visitor-b");
  assert.equal((await login({ deviceId: "visitor-b", ...WINDOWS })).code, "DEVICE_PENDING", "b waits for its own approval");
  assert.equal(state.emails.length, 1, "b's repeat login is no new request");

  b.status = "APPROVED"; // the teacher approves b itself
  assert.deepEqual(await login({ deviceId: "visitor-b", ...WINDOWS }), { ok: true });
  assert.deepEqual(await login({ deviceId: "visitor-a", ...WINDOWS }), { ok: true });
  assert.equal((await login({ deviceId: "visitor-c", ...WINDOWS })).code, "DEVICE_PENDING", "a third one still needs approval");
  assert.deepEqual([snapshot(a).deviceId, snapshot(b).deviceId], ["visitor-a", "visitor-b"]);
});

test("attribute match to a PENDING request: deduplicated (no new row, no new email) and never rebound to the newcomer", async () => {
  reset();
  const pending = seed({ deviceId: "visitor-student", status: "PENDING" });
  const before = snapshot(pending);
  const result = await login({ deviceId: "visitor-other", fingerprint: LONG_FP("other"), ...WINDOWS });
  assert.equal(result.code, "DEVICE_PENDING");
  assert.equal(result.data.currentDevice.id, pending.id, "the same pending request");
  assert.equal(result.data.allowRequestAgain, true);
  assert.equal(state.devices.length, 1, "no duplicate request");
  assert.equal(state.emails.length, 0);
  assert.deepEqual(snapshot(pending), before, "the pending request keeps its own identity, so approving it approves that device only");

  pending.status = "APPROVED"; // the teacher approves the original request
  assert.equal((await login({ deviceId: "visitor-other", ...WINDOWS })).code, "DEVICE_PENDING", "the newcomer did not inherit the approval");
  assert.deepEqual(await login({ deviceId: "visitor-student", ...WINDOWS }), { ok: true });
});

// ---- Blocked -------------------------------------------------------------------------------------------------

test("BLOCKED devices stay blocked: exact id, exact fingerprint and attribute matches are rejected; nothing is rebound", async () => {
  reset();
  const blocked = seed({ deviceId: "visitor-blocked", status: "BLOCKED", rejectedReason: "Not yours", rejectedAt: new Date() });
  const before = snapshot(blocked);
  for (const device of [
    { deviceId: "visitor-blocked", ...WINDOWS },
    { deviceId: "other-1", fingerprint: before.fingerprint, ...WINDOWS },
    { deviceId: "other-2", ...WINDOWS },
  ]) {
    const result = await login(device);
    assert.deepEqual([result.code, result.statusCode], ["DEVICE_REJECTED", 403], JSON.stringify(device));
  }
  const after = snapshot(blocked);
  assert.equal(after.status, "BLOCKED");
  assert.equal(after.deviceId === "visitor-blocked" || after.deviceId === "other-1", true, "only the exact-fingerprint refresh may change it, as before");
  assert.equal(state.devices.length, 1, "no new rows");
});

test("an approved and a blocked device of the same kind: the attribute match sees only the blocked one", async () => {
  reset();
  const approved = seed({ deviceId: "visitor-good" });
  seed({ deviceId: "visitor-bad", status: "BLOCKED", approvalRequestedAt: new Date("2026-09-01T00:00:00Z") });
  const before = snapshot(approved);
  assert.equal((await login({ deviceId: "attacker", ...WINDOWS })).code, "DEVICE_REJECTED");
  assert.deepEqual(snapshot(approved), before);
});

// ---- New devices, notification, IP -------------------------------------------------------------------------------

test("a genuinely new device becomes PENDING and the teacher is emailed (as before); a mail failure does not change the answer", async () => {
  reset();
  const result = await login({ deviceId: "brand-new", fingerprint: LONG_FP("new"), ...WINDOWS, deviceName: "Chrome on Windows", browserVersion: "150", osVersion: "11" });
  assert.equal(result.code, "DEVICE_PENDING");
  assert.equal(result.data.allowRequestAgain, false);
  assert.equal(state.devices[0].status, "PENDING");
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].to, "teacher@example.test");
  assert.equal(state.emails[0].studentName, "Stu One");
  assert.equal(state.emails[0].browser, "Chrome 150");
  assert.equal(state.emails[0].reviewLink, `https://app.test/review/${STUDENT}`);

  state.failEmail = true;
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await login({ deviceId: "another-new", ...WINDOWS, browser: "Firefox" })).code, "DEVICE_PENDING");
  } finally {
    console.error = original;
  }
});

test("IP: only the trusted proxy's address is recorded; a client-supplied first X-Forwarded-For entry or X-Real-IP never is", async () => {
  reset();
  const spoofed = { "x-forwarded-for": "6.6.6.6, 203.0.113.9", "x-real-ip": "7.7.7.7" };
  await login({ deviceId: "d1", ...WINDOWS }, spoofed);
  assert.equal(state.devices[0].lastIpAddress, null, "no trusted proxy configured: unknown, not the spoofed value");
  assert.equal(state.emails[0].ipAddress, "Unknown");

  process.env.TRUSTED_PROXY_COUNT = "1";
  await login({ deviceId: "d2", ...WINDOWS, browser: "Edge" }, spoofed);
  assert.equal(state.devices.find((d) => d.deviceId === "d2").lastIpAddress, "203.0.113.9", "the address nginx appended");

  const approved = seed({ deviceId: "d3", browser: "Safari" });
  await login({ deviceId: "d3", browser: "Safari", os: "Windows", platform: "Win32" }, spoofed);
  assert.equal(snapshot(approved).lastIpAddress, "203.0.113.9");
  delete process.env.TRUSTED_PROXY_COUNT;
});

// ---- Other roles ----------------------------------------------------------------------------------------------

test("teacher, guardian and admin logins never run the student device check", () => {
  const login = fs.readFileSync(path.join(root, "app", "api", "auth", "login", "route.ts"), "utf8").replace(/\r\n/g, "\n");
  const adminBranch = login.slice(login.indexOf("if (normalizedLoginId === ADMIN_LOGIN_ID"), login.indexOf("const loginResult"));
  assert.doesNotMatch(adminBranch, /validateStudentDevice/, "admin returns before the device check");
  const studentBranch = login.slice(login.indexOf('if (loginResult.role === "STUDENT") {'), login.indexOf("let redirectTo"));
  assert.match(studentBranch, /await validateStudentDevice\(\{/);
  assert.equal((login.match(/validateStudentDevice\(/g) ?? []).length, 1, "called only in the student branch");
  const guardian = fs.readFileSync(path.join(root, "app", "api", "guardian-auth", "login", "route.ts"), "utf8");
  assert.doesNotMatch(guardian, /student-device|validateStudentDevice/);
});

// ---- SP-6F: blocking or removing a device ends the student's sessions ------------------------------

process.env.JWT_SECRET = process.env.JWT_SECRET || "sp-6-f-test-secret-not-a-real-one-0123456789";
const authLib = require(path.join(root, "lib", "auth.ts"));
const studentSession = require(path.join(root, "lib", "student-session.ts"));

const TEACHER = "t-1";
function seedStudents() {
  state.students.set(STUDENT, { id: STUDENT, teacherId: TEACHER, name: "Stu One", email: "stu1@example.test", status: 0, sessionVersion: 0 });
  state.students.set("stu-2", { id: "stu-2", teacherId: TEACHER, name: "Stu Two", email: "stu2@example.test", status: 0, sessionVersion: 4 });
  state.students.set("stu-other", { id: "stu-other", teacherId: "t-other", name: "Other", email: "o@example.test", status: 0, sessionVersion: 0 });
}
async function sessionOf(studentId, sv) {
  return authLib.verifyAuthToken(await authLib.signAuthToken({ sub: studentId, email: "x@example.test", role: "STUDENT", name: "X", sessionVersion: sv }));
}
const versionOf = (id) => state.students.get(id).sessionVersion;
const statusOf = (id) => state.devices.find((d) => d.id === id)?.status;

test("blocking an APPROVED device increments that student's version only, in one transaction; all their existing sessions end", async () => {
  reset();
  seedStudents();
  const device = seed({ deviceId: "phone" });
  seed({ studentId: "stu-2", deviceId: "other-phone" });
  const sessionA = await sessionOf(STUDENT, 0);
  const sessionB = await sessionOf(STUDENT, 0); // a second device's session (JWTs are not bound to devices)
  assert.equal(await studentSession.checkStudentSessionAccess(sessionA), "ACTIVE");

  const result = await service.rejectStudentDevice(device.id, TEACHER, "Not your device");
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.rejectedReason, "Not your device");
  assert.equal(result.approvedByTeacherId, TEACHER);
  assert.equal(result.approvedAt, null);
  assert.ok(result.rejectedAt instanceof Date);
  assert.deepEqual([versionOf(STUDENT), versionOf("stu-2"), versionOf("stu-other")], [1, 4, 0], "only the device owner's version");
  assert.deepEqual(state.transactions, [{ maxWait: 5_000, timeout: 15_000 }]);
  assert.equal(await studentSession.checkStudentSessionAccess(sessionA), "INVALID");
  assert.equal(await studentSession.checkStudentSessionAccess(sessionB), "INVALID");
  assert.equal(await studentSession.checkStudentSessionAccess(await sessionOf(STUDENT, 1)), "ACTIVE", "signing in again works");
  assert.equal(state.decisionEmails.length, 1, "the decision email is sent as before");
  assert.equal(state.decisionEmails[0].decision, "rejected");
});

test("rollback: a failed device update or a failed version increment leaves both unchanged (and sends no email)", async () => {
  reset();
  seedStudents();
  const device = seed({ deviceId: "phone" });
  state.failDeviceUpdate = true;
  await assert.rejects(service.rejectStudentDevice(device.id, TEACHER), /device update failed/);
  assert.deepEqual([statusOf(device.id), versionOf(STUDENT)], ["APPROVED", 0]);

  state.failDeviceUpdate = false;
  state.failVersionBump = true;
  await assert.rejects(service.rejectStudentDevice(device.id, TEACHER), /version update failed/);
  assert.deepEqual([statusOf(device.id), versionOf(STUDENT)], ["APPROVED", 0], "the device change was rolled back");
  assert.equal(state.decisionEmails.length, 0);
});

test("the version increment must hit exactly the owner's row, or the device change is rolled back (409)", async () => {
  reset();
  seedStudents();
  const device = seed({ deviceId: "phone" });
  const owner = state.students.get(STUDENT);
  // The ownership check passes, but the increment then matches no row (owner removed in between).
  const realUpdateMany = prisma.student.updateMany;
  prisma.student.updateMany = async () => ({ count: 0 });
  try {
    await assert.rejects(service.rejectStudentDevice(device.id, TEACHER), (e) => e.statusCode === 409 && e.code === "DEVICE_DECISION_CONFLICT");
  } finally {
    prisma.student.updateMany = realUpdateMany;
  }
  assert.deepEqual([statusOf(device.id), owner.sessionVersion], ["APPROVED", 0]);
  assert.equal(state.decisionEmails.length, 0);
});

test("missing, or another teacher's, device: 404 and nothing changes", async () => {
  reset();
  seedStudents();
  const foreign = seed({ studentId: "stu-other", deviceId: "theirs" });
  await assert.rejects(service.rejectStudentDevice("no-such-device", TEACHER), (e) => e.statusCode === 404 && e.code === "DEVICE_NOT_FOUND");
  await assert.rejects(service.rejectStudentDevice(foreign.id, TEACHER), (e) => e.statusCode === 404);
  assert.deepEqual([statusOf(foreign.id), versionOf("stu-other")], ["APPROVED", 0]);
  assert.deepEqual(await service.deleteStudentDeviceForTeacher(foreign.id, TEACHER), { deleted: false });
  assert.deepEqual(await service.deleteStudentDeviceForTeacher("no-such-device", TEACHER), { deleted: false });
  assert.equal(versionOf("stu-other"), 0);
  assert.ok(state.devices.some((d) => d.id === foreign.id));
});

test("only an APPROVED device can carry a session: rejecting a PENDING request or re-rejecting a BLOCKED device signs nobody out", async () => {
  reset();
  seedStudents();
  const pending = seed({ deviceId: "new-phone", status: "PENDING" });
  await service.rejectStudentDevice(pending.id, TEACHER, "No");
  assert.deepEqual([statusOf(pending.id), versionOf(STUDENT)], ["BLOCKED", 0]);
  assert.equal(state.decisionEmails.length, 1, "the student is still told");

  const approved = seed({ deviceId: "phone" });
  await service.rejectStudentDevice(approved.id, TEACHER, "first");
  assert.equal(versionOf(STUDENT), 1);
  const again = await service.rejectStudentDevice(approved.id, TEACHER, "second");
  assert.equal(versionOf(STUDENT), 1, "re-rejecting does not sign the student out again");
  assert.equal(again.rejectedReason, "second", "the details update as before");
  assert.equal(state.decisionEmails.length, 2, "no second email for an unchanged status (as before)");
});

test("concurrent rejections of one approved device: one status change, one increment, one email", async () => {
  reset();
  seedStudents();
  const device = seed({ deviceId: "phone" });
  const results = await Promise.all([service.rejectStudentDevice(device.id, TEACHER, "a"), service.rejectStudentDevice(device.id, TEACHER, "b")]);
  assert.deepEqual(results.map((r) => r.status), ["BLOCKED", "BLOCKED"]);
  assert.equal(versionOf(STUDENT), 1);
  assert.equal(state.decisionEmails.length, 1);
});

test("approving is unchanged: no session ends, the email is sent", async () => {
  reset();
  seedStudents();
  const pending = seed({ deviceId: "new-phone", status: "PENDING" });
  const approved = await service.approveStudentDevice(pending.id, TEACHER, "ok");
  assert.equal(approved.status, "APPROVED");
  assert.equal(versionOf(STUDENT), 0);
  assert.equal(state.decisionEmails.at(-1).decision, "approved");
  assert.equal(state.transactions.length, 0, "approval does not use the new transaction");
});

test("removing an APPROVED device ends the sessions atomically; removing PENDING / BLOCKED does not; a failure removes nothing", async () => {
  reset();
  seedStudents();
  const approved = seed({ deviceId: "phone" });
  const session = await sessionOf(STUDENT, 0);
  assert.deepEqual(await service.deleteStudentDeviceForTeacher(approved.id, TEACHER), { deleted: true });
  assert.equal(state.devices.some((d) => d.id === approved.id), false);
  assert.equal(versionOf(STUDENT), 1);
  assert.equal(await studentSession.checkStudentSessionAccess(session), "INVALID");

  const pending = seed({ deviceId: "p", status: "PENDING" });
  const blocked = seed({ deviceId: "b", status: "BLOCKED" });
  assert.deepEqual(await service.deleteStudentDeviceForTeacher(pending.id, TEACHER), { deleted: true });
  assert.deepEqual(await service.deleteStudentDeviceForTeacher(blocked.id, TEACHER), { deleted: true });
  assert.equal(versionOf(STUDENT), 1);

  const another = seed({ deviceId: "tablet" });
  state.failVersionBump = true;
  await assert.rejects(service.deleteStudentDeviceForTeacher(another.id, TEACHER), /version update failed/);
  assert.equal(statusOf(another.id), "APPROVED", "the removal was rolled back");
  assert.equal(versionOf(STUDENT), 1);
  state.failVersionBump = false;

  const [first, second] = await Promise.all([
    service.deleteStudentDeviceForTeacher(another.id, TEACHER),
    service.deleteStudentDeviceForTeacher(another.id, TEACHER),
  ]);
  assert.deepEqual([first.deleted, second.deleted].sort(), [false, true], "a double removal removes once");
  assert.equal(versionOf(STUDENT), 2, "and increments once");
});

test("a blocked device stays blocked at login after the change (device matching unchanged)", async () => {
  reset();
  seedStudents();
  const device = seed({ deviceId: "phone" });
  await service.rejectStudentDevice(device.id, TEACHER);
  assert.equal((await login({ deviceId: "phone", ...WINDOWS })).code, "DEVICE_REJECTED");
  assert.equal((await login({ deviceId: "spoof", ...WINDOWS })).code, "DEVICE_REJECTED", "attribute match to the blocked device");
});

test("SP-6F: every write of a block / removal goes through the transaction client", async () => {
  reset();
  seedStudents();
  const device = seed({ deviceId: "phone" });
  await service.rejectStudentDevice(device.id, TEACHER);
  const tablet = seed({ deviceId: "tablet" });
  await service.deleteStudentDeviceForTeacher(tablet.id, TEACHER);
  assert.deepEqual(
    state.writes.map((w) => `${w.op}:${w.viaTx}`),
    ["device.updateMany:true", "student.updateMany:true", "device.deleteMany:true", "student.updateMany:true"]
  );
});

test("SP-6F: a device approved concurrently is never removed or blocked without ending its sessions", async () => {
  reset();
  seedStudents();
  // Removal: read PENDING, then another request approves it before the delete runs.
  const pending = seed({ deviceId: "phone", status: "PENDING" });
  state.beforeDeviceWrite = () => {
    state.devices.find((d) => d.id === pending.id).status = "APPROVED";
  };
  assert.deepEqual(await service.deleteStudentDeviceForTeacher(pending.id, TEACHER), { deleted: false }, "nothing removed: it changed meanwhile");
  assert.deepEqual([statusOf(pending.id), versionOf(STUDENT)], ["APPROVED", 0]);

  // Rejection: read PENDING, approved meanwhile -> the retry sees APPROVED and ends the sessions.
  const other = seed({ deviceId: "tablet", status: "PENDING" });
  state.beforeDeviceWrite = () => {
    state.devices.find((d) => d.id === other.id).status = "APPROVED";
  };
  const blocked = await service.rejectStudentDevice(other.id, TEACHER);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(versionOf(STUDENT), 1, "the approval that slipped in is covered");
});
