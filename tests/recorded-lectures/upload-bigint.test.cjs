/*
 * Recorded Lectures RL-3.1: safe BigInt <-> number conversion
 * (lib/recorded-lectures/bigint.ts). Pure; no database.
 *
 *   node --test tests/recorded-lectures/upload-bigint.test.cjs
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const B = require(path.join(root, "lib", "recorded-lectures", "bigint.ts"));

const MAX = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const big = (value) => BigInt(value);
const TWO_53 = big(2) ** big(53);

function throwsProblem(fn, problem) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, "RecordedLectureIntegerError");
    assert.ok(B.isRecordedLectureIntegerError(error));
    assert.equal(error.problem, problem);
    return true;
  });
}

test("bigint -> number: exact for every safe value, including the edges around 2^53", () => {
  assert.equal(B.bigintToSafeNumber(big(0)), 0);
  assert.equal(B.bigintToSafeNumber(big(4_000_000_000)), 4_000_000_000);
  assert.equal(B.bigintToSafeNumber(big(64_000_000_000)), 64_000_000_000);
  assert.equal(B.bigintToSafeNumber(TWO_53 - big(1)), MAX);
  assert.equal(B.bigintToSafeNumber(big(-MAX)), -MAX);
});

test("bigint -> number: 2^53 and beyond fail closed (never a rounded number)", () => {
  // Number(2^53 + 1) would silently round to 2^53: refused before converting.
  for (const value of [TWO_53, TWO_53 + big(1), TWO_53 * big(4), -TWO_53, -(TWO_53 + big(1))]) {
    throwsProblem(() => B.bigintToSafeNumber(value), "OUT_OF_SAFE_RANGE");
  }
});

test("bigint -> number: only a bigint is accepted", () => {
  for (const value of [0, 1.5, "12", null, undefined, {}, [], true, Number.NaN]) {
    throwsProblem(() => B.bigintToSafeNumber(value), "NOT_A_BIGINT");
  }
});

test("number -> bigint: Number.isSafeInteger is checked before converting", () => {
  assert.equal(B.safeNumberToBigint(0), big(0));
  assert.equal(B.safeNumberToBigint(MAX), TWO_53 - big(1));
  assert.equal(B.safeNumberToBigint(-MAX), -(TWO_53 - big(1)));
  for (const value of [MAX + 1, 2 ** 53, 1.5, -0.5, Number.NaN, Infinity, -Infinity, "1", big(1), null, undefined]) {
    throwsProblem(() => B.safeNumberToBigint(value), "NOT_A_SAFE_INTEGER");
  }
});

test("byte counts: never negative, in both directions", () => {
  assert.equal(B.byteCountToNumber(big(8_388_608)), 8_388_608);
  assert.equal(B.byteCountToBigint(8_388_608), big(8_388_608));
  assert.equal(B.byteCountToBigint(0), big(0));
  throwsProblem(() => B.byteCountToNumber(big(-1)), "NEGATIVE");
  throwsProblem(() => B.byteCountToBigint(-1), "NEGATIVE");
  throwsProblem(() => B.byteCountToNumber(TWO_53), "OUT_OF_SAFE_RANGE");
  throwsProblem(() => B.byteCountToBigint(2 ** 53), "NOT_A_SAFE_INTEGER");
  throwsProblem(() => B.byteCountToNumber(5), "NOT_A_BIGINT");
  throwsProblem(() => B.byteCountToBigint("5"), "NOT_A_SAFE_INTEGER");
});

test("round trip is exact for representative byte counts", () => {
  for (const n of [0, 1, 8_388_608, 67_108_864, 134_217_728, 4_000_000_000, 64_000_000_000, MAX]) {
    assert.equal(B.byteCountToNumber(B.byteCountToBigint(n)), n);
  }
});

test("the error names the field and the problem, never the value", () => {
  const value = TWO_53 + big(12345);
  assert.throws(
    () => B.byteCountToNumber(value, "receivedBytes"),
    (error) => {
      assert.equal(error.field, "receivedBytes");
      assert.ok(!error.message.includes(String(value)));
      assert.ok(!error.message.includes("12345"));
      return true;
    }
  );
});
