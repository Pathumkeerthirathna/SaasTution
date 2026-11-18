/*
 * For suites whose in-memory database does not model class fees: registers a
 * stand-in for services/class-access-service.ts that reports "no payment-due
 * restrictions" (the default of every class: restrictUnpaidStudentAccess is
 * false), so their existing assertions run exactly as before. The real
 * access control is tested in tests/class-access/.
 *
 * Require it at the top of a test file, before the code under test loads.
 */

"use strict";

const path = require("node:path");
const Module = require("node:module");

const filename = path.resolve(__dirname, "..", "..", "services", "class-access-service.ts");
const mod = new Module(filename);
mod.filename = filename;
mod.loaded = true;
mod.exports = {
  CLASS_ACCESS_RESTRICTED: "CLASS_ACCESS_RESTRICTED",
  MIN_PAYMENT_GRACE_DAYS: 0,
  MAX_PAYMENT_GRACE_DAYS: 30,
  DEFAULT_PAYMENT_GRACE_DAYS: 5,
  getClassAccessRestrictions: async () => [],
  assertClassAccessForStudent: async () => {},
  assertContentAccessForStudent: async () => {},
  filterAccessibleClassIds: async (_studentId, classIds) => new Set(classIds),
};
require.cache[filename] = mod;
