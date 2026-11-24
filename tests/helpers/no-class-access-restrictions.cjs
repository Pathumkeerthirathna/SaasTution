/*
 * For suites whose in-memory database does not model class fees: registers a
 * stand-in for services/class-access-service.ts that reports "no payment-due
 * restrictions" (the default of every class: restrictUnpaidStudentAccess is
 * false), so their existing assertions run exactly as before. The real
 * access control is tested in tests/class-access/.
 *
 * Also stands in for services/resource-access-service.ts (monthly resource
 * access): every resource month is open, so listings carry an unlocked
 * resourceAccess and the delivery checks pass. Tested for real in
 * tests/class-access/resource-access.test.cjs.
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

// Monthly resource access: everything open (no class models fees here).
const resourceFilename = path.resolve(__dirname, "..", "..", "services", "resource-access-service.ts");
const resourceMod = new Module(resourceFilename);
resourceMod.filename = resourceFilename;
resourceMod.loaded = true;
// Asia/Colombo is UTC+05:30 with no daylight saving (as lib/time.ts).
const billingMonthOf = (instant) => {
  const wall = new Date(instant.getTime() + 330 * 60 * 1000);
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1 };
};
const openResolver = (studentId) => ({ studentId, decide: () => null, noticeItems: () => [] });
resourceMod.exports = {
  RESOURCE_MONTH_LOCKED: "RESOURCE_MONTH_LOCKED",
  billingMonthOf,
  noteBillingMonth: (note) => billingMonthOf(note.uploadedAt ?? note.lecture.date),
  monthKey: (m) => `${m.year}-${String(m.month).padStart(2, "0")}`,
  loadStudentResourceAccess: async (studentId) => openResolver(studentId),
  resourceLockFor: (_access, _classId, month) => ({ locked: false, year: month.year, month: month.month }),
  assertResourceAccessForStudent: async () => {},
  lockedResourceMessage: () => "",
};
require.cache[resourceFilename] = resourceMod;
