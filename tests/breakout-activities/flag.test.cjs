/*
 * Breakout Activities feature flag (lib/breakout-activities/flag.ts): off
 * unless BREAKOUT_ACTIVITIES_ENABLED is explicitly "true" or "1"; while off,
 * breakout routes answer 404 NOT_FOUND.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const flag = require(path.join(root, "lib/breakout-activities/flag.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const env = (value) => (value === undefined ? {} : { BREAKOUT_ACTIVITIES_ENABLED: value });

test("off when unset or empty", () => {
  assert.equal(flag.BREAKOUT_ACTIVITIES_FLAG, "BREAKOUT_ACTIVITIES_ENABLED");
  assert.equal(flag.isBreakoutActivitiesEnabled(env(undefined)), false);
  assert.equal(flag.isBreakoutActivitiesEnabled(env("")), false);
  assert.equal(flag.isBreakoutActivitiesEnabled(env("   ")), false);
});

test("on only for true / 1 (trimmed, case-insensitive)", () => {
  for (const value of ["true", "TRUE", " True ", "1", " 1\n"]) {
    assert.equal(flag.isBreakoutActivitiesEnabled(env(value)), true, JSON.stringify(value));
  }
});

test("every other value is off", () => {
  for (const value of ["false", "0", "yes", "on", "enabled", "2", "truee", "t", "1.0"]) {
    assert.equal(flag.isBreakoutActivitiesEnabled(env(value)), false, JSON.stringify(value));
  }
});

test("reads process.env by default", () => {
  const saved = process.env.BREAKOUT_ACTIVITIES_ENABLED;
  try {
    delete process.env.BREAKOUT_ACTIVITIES_ENABLED;
    assert.equal(flag.isBreakoutActivitiesEnabled(), false);
    process.env.BREAKOUT_ACTIVITIES_ENABLED = "true";
    assert.equal(flag.isBreakoutActivitiesEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.BREAKOUT_ACTIVITIES_ENABLED;
    else process.env.BREAKOUT_ACTIVITIES_ENABLED = saved;
  }
});

test("assert: 404 NOT_FOUND while off, no hint that the feature exists", () => {
  assert.throws(
    () => flag.assertBreakoutActivitiesEnabled(env(undefined)),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "NOT_FOUND");
      assert.doesNotMatch(error.message, /breakout|disabled|flag/i);
      return true;
    }
  );
  assert.doesNotThrow(() => flag.assertBreakoutActivitiesEnabled(env("1")));
});
