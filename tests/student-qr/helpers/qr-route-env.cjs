/*
 * Shared in-process environment for the QR route tests: a fake session
 * (lib/auth-session.ts, mirroring its 401 rules) and a small in-memory Prisma
 * with just what lib/teacher-student-access.ts and
 * services/student-qr-service.ts use. Must be required BEFORE any route.
 */

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("../../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..", "..");
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const state = {
  session: null, // { role: "STUDENT" | "TEACHER" | "ADMIN", userId }
  calls: { session: 0 },
  students: new Map(),
  tokens: [],
};

const unauthorized = () => new AppError("Authentication required.", 401, "UNAUTHORIZED");
const invalid = () => new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");

fake("lib/auth-session.ts", {
  requireStudentSession: async () => {
    state.calls.session += 1;
    if (!state.session) throw unauthorized();
    if (state.session.role !== "STUDENT") throw invalid();
    return { studentId: state.session.userId, email: "s@example.test", name: "S", role: "STUDENT" };
  },
  requireTeacherSession: async () => {
    state.calls.session += 1;
    if (!state.session) throw unauthorized();
    if (state.session.role !== "TEACHER") throw invalid();
    return { teacherId: state.session.userId, email: "t@example.test", name: "T", role: "TEACHER" };
  },
  requireAppSession: async () => {
    throw new Error("not used");
  },
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const pick = (row, select) => {
  if (!select) return { ...row };
  const out = {};
  for (const [key, value] of Object.entries(select)) {
    if (!value) continue;
    if (key === "student") out.student = pick(state.students.get(row.studentId), value.select);
    else out[key] = row[key];
  }
  return out;
};

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("gt" in cond) return row[key] > cond.gt;
      if ("not" in cond) return row[key] !== cond.not;
      throw new Error(`fake prisma: unsupported condition on ${key}`);
    }
    return row[key] === cond;
  });

const client = {
  student: {
    findFirst: async ({ where, select }) => {
      const row = [...state.students.values()].find((s) => matches(s, where));
      return row ? pick(row, select) : null;
    },
  },
  studentQrToken: {
    findFirst: async ({ where, select }) => {
      const row = state.tokens.find((t) => matches(t, where));
      return row ? pick(row, select) : null;
    },
    findMany: async ({ where, select }) =>
      state.tokens
        .filter((t) => matches(t, where))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((t) => pick(t, select)),
    findUnique: async ({ where, select }) => {
      const row = state.tokens.find((t) => t.tokenHash === where.tokenHash);
      return row ? pick(row, select) : null;
    },
    updateMany: async ({ where, data }) => {
      const rows = state.tokens.filter((t) => matches(t, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
    create: async ({ data, select }) => {
      if (state.tokens.some((t) => t.studentId === data.studentId && t.revokedAt === null)) {
        throw new Error("fake prisma: second active token");
      }
      const row = { revokedAt: null, revokedByRole: null, revokedById: null, revokedReason: null, createdById: null, ...data };
      state.tokens.push(row);
      return pick(row, select);
    },
  },
  $queryRaw: async (strings, ...values) => {
    assert.match(strings.join("?"), /FROM "Student" WHERE "id" = \? FOR NO KEY UPDATE/);
    const s = state.students.get(values[0]);
    return s ? [{ id: s.id, teacherId: s.teacherId, status: s.status }] : [];
  },
  $transaction: async (fn) => fn(client),
};

fake("lib/prisma.ts", { prisma: client });

function seedStudents(rows) {
  state.students = new Map(rows.map((row) => [row.id, { status: 0, registrationNumber: null, ...row }]));
  state.tokens = [];
}

module.exports = { root, state, seedStudents };
