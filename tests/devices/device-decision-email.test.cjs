/*
 * Student email on a teacher's device approve / reject decision.
 *
 *   npm run test:devices
 *
 * Runs the real services/student-device.service.ts (approveStudentDevice,
 * rejectStudentDevice) and the real emails/DeviceDecisionEmail.ts template
 * through tsx. Only the edges are faked: Prisma (an in-memory StudentDevice /
 * Student table) and the mailer (records sends, can be made to fail). No
 * database or SMTP server is contacted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

const TEACHER = "teacher-1";
const OTHER_TEACHER = "teacher-2";
const STUDENT = "student-1";
const DEVICE = "device-1";
const LOGIN_LINK = "https://slclassroom.live/login";

// ---- Fake database --------------------------------------------------------

const db = { devices: [], students: [] };
let failUpdate = false;
const log = [];

function resetDb({ status = "PENDING", email = "student@example.com" } = {}) {
  failUpdate = false;
  log.length = 0;
  db.students = [{ id: STUDENT, name: "Nimal Perera", email, teacherId: TEACHER }];
  db.devices = [
    {
      id: DEVICE,
      studentId: STUDENT,
      deviceName: null,
      deviceModel: "Pixel 8",
      browser: "Chrome",
      browserVersion: "150",
      os: "Android",
      osVersion: "15",
      status,
      approvedAt: null,
      approvedReason: null,
      rejectedAt: null,
      rejectedReason: null,
      approvedByTeacherId: null,
    },
  ];
}

const fakePrisma = {
  studentDevice: {
    async findFirst({ where, select }) {
      const device = db.devices.find((d) => d.id === where.id);
      if (!device) return null;
      const student = db.students.find((s) => s.id === device.studentId);
      if (where.student?.teacherId && student?.teacherId !== where.student.teacherId) return null;
      return select ? Object.fromEntries(Object.keys(select).map((k) => [k, device[k]])) : { ...device };
    },
    async update({ where, data }) {
      if (failUpdate) throw new Error("db down");
      const device = db.devices.find((d) => d.id === where.id);
      if (!device) throw new Error("not found");
      Object.assign(device, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      log.push(`update:${device.status}`);
      return { ...device };
    },
  },
  student: {
    async findUnique({ where, select }) {
      const student = db.students.find((s) => s.id === where.id);
      if (!student) return null;
      return Object.fromEntries(Object.keys(select).map((k) => [k, student[k]]));
    },
  },
};

// ---- Fake mailer ----------------------------------------------------------

const sent = [];
let failSend = false;

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/mailer.ts", {
  buildDeviceApprovalReviewLink: () => "",
  buildTeacherLoginLink: () => LOGIN_LINK,
  sendDeviceApprovalRequestEmail: async () => {},
  sendDeviceDecisionEmail: async (input) => {
    log.push(`email:${input.decision}`);
    if (failSend) throw new Error("SMTP unavailable");
    sent.push(input);
  },
});

const { approveStudentDevice, rejectStudentDevice } = require(path.join(root, "services", "student-device.service.ts"));
const { getDeviceDecisionEmail } = require(path.join(root, "emails", "DeviceDecisionEmail.ts"));

function setup(options) {
  resetDb(options);
  sent.length = 0;
  failSend = false;
}

function quietConsoleError() {
  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  return { calls, restore: () => (console.error = original) };
}

// ---- Service ----------------------------------------------------------------

test("approving a PENDING device updates it, then sends one 'approved' email", async () => {
  setup();
  const device = await approveStudentDevice(DEVICE, TEACHER, "Welcome back");
  assert.equal(device.status, "APPROVED");
  assert.deepEqual(log, ["update:APPROVED", "email:approved"], "email only after the update");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    to: "student@example.com",
    decision: "approved",
    studentName: "Nimal Perera",
    deviceName: "Pixel 8",
    browser: "Chrome 150",
    os: "Android 15",
    reason: "Welcome back",
    loginLink: LOGIN_LINK,
  });
});

test("rejecting a PENDING device sends one 'rejected' email with the reason", async () => {
  setup();
  const device = await rejectStudentDevice(DEVICE, TEACHER, "Unknown phone");
  assert.equal(device.status, "BLOCKED");
  assert.deepEqual(log, ["update:BLOCKED", "email:rejected"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].decision, "rejected");
  assert.equal(sent[0].reason, "Unknown phone");
});

test("no status change: approving APPROVED / rejecting BLOCKED still updates but sends nothing", async () => {
  setup({ status: "APPROVED" });
  const approved = await approveStudentDevice(DEVICE, TEACHER, "again");
  assert.equal(approved.approvedReason, "again", "existing update behaviour kept");
  assert.deepEqual(log, ["update:APPROVED"]);
  assert.equal(sent.length, 0);

  setup({ status: "BLOCKED" });
  const rejected = await rejectStudentDevice(DEVICE, TEACHER, "still no");
  assert.equal(rejected.rejectedReason, "still no");
  assert.deepEqual(log, ["update:BLOCKED"]);
  assert.equal(sent.length, 0);
});

test("BLOCKED -> APPROVED and APPROVED -> BLOCKED each send one email", async () => {
  setup({ status: "BLOCKED" });
  await approveStudentDevice(DEVICE, TEACHER);
  assert.deepEqual(sent.map((s) => s.decision), ["approved"]);

  setup({ status: "APPROVED" });
  await rejectStudentDevice(DEVICE, TEACHER);
  assert.deepEqual(sent.map((s) => s.decision), ["rejected"]);
});

test("an email failure is logged and does not fail or undo the decision", async () => {
  for (const [run, status] of [[approveStudentDevice, "APPROVED"], [rejectStudentDevice, "BLOCKED"]]) {
    setup();
    failSend = true;
    const errors = quietConsoleError();
    try {
      const device = await run(DEVICE, TEACHER);
      assert.equal(device.status, status);
      assert.equal(db.devices[0].status, status, "status stays committed");
      assert.equal(errors.calls.length, 1);
      assert.match(String(errors.calls[0][0]), /Failed to email student/);
    } finally {
      errors.restore();
    }
  }
});

test("a failed status update sends no email and the error reaches the caller", async () => {
  for (const run of [approveStudentDevice, rejectStudentDevice]) {
    setup();
    failUpdate = true;
    await assert.rejects(run(DEVICE, TEACHER), /db down/);
    assert.equal(sent.length, 0);
    assert.deepEqual(log, []);
  }
});

test("a student without an email: the decision succeeds and no email is sent", async () => {
  setup({ email: null });
  const device = await approveStudentDevice(DEVICE, TEACHER);
  assert.equal(device.status, "APPROVED");
  assert.deepEqual(log, ["update:APPROVED"]);
  assert.equal(sent.length, 0);
});

test("another teacher's device: 404, no update and no email", async () => {
  for (const run of [approveStudentDevice, rejectStudentDevice]) {
    setup();
    await assert.rejects(run(DEVICE, OTHER_TEACHER), (error) => error.statusCode === 404 || error.status === 404);
    assert.equal(db.devices[0].status, "PENDING");
    assert.deepEqual(log, []);
  }
});

// ---- Template ---------------------------------------------------------------

const BASE = {
  studentName: "Nimal Perera",
  deviceName: "Pixel 8",
  browser: "Chrome 150",
  os: "Android 15",
  loginLink: LOGIN_LINK,
};

test("approved template: device details and the login link", () => {
  const html = getDeviceDecisionEmail({ ...BASE, decision: "approved" });
  assert.match(html, /Device Approved/);
  assert.match(html, /Nimal Perera/);
  assert.match(html, /Pixel 8/);
  assert.match(html, /Chrome 150/);
  assert.match(html, /Android 15/);
  assert.match(html, /href="https:\/\/slclassroom\.live\/login"/);
  assert.doesNotMatch(html, /Reason/);
});

test("rejected template: reason shown (escaped), no login button; reason row omitted when absent", () => {
  const html = getDeviceDecisionEmail({ ...BASE, decision: "rejected", reason: "Use <your> school laptop" });
  assert.match(html, /Device Not Approved/);
  assert.match(html, /Reason/);
  assert.match(html, /Use &lt;your&gt; school laptop/);
  assert.doesNotMatch(html, /Sign in to SLClassroom/);
  assert.doesNotMatch(html, /slclassroom\.live\/login/);

  const noReason = getDeviceDecisionEmail({ ...BASE, decision: "rejected", reason: "   " });
  assert.doesNotMatch(noReason, /Reason/);
  assert.match(noReason, /Pixel 8/);
});
