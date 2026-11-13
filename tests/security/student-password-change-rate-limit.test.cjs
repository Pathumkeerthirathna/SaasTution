/*
 * Student Profile SP-5.6: the student password-change rate limiter
 * (lib/student-password-change-rate-limit.ts). Sliding windows, separate
 * check / record, injected clock.
 *
 *   npm run test:security
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createStudentPasswordChangeRateLimiter, STUDENT_PASSWORD_CHANGE_RATE_LIMIT } = require(path.join(root, "lib", "student-password-change-rate-limit.ts"));

const MIN = 60_000;
function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms), set: (ms) => (time = ms) };
}

test("the approved limits", () => {
  assert.deepEqual({ ...STUDENT_PASSWORD_CHANGE_RATE_LIMIT }, { attemptsPerStudent: 10, failuresPerStudent: 5, globalAttempts: 600, windowMs: 15 * MIN, maxStudents: 10_000 });
});

test("attempts: 10 per student; the 11th is refused with an exact Retry-After; check never counts", () => {
  const c = clock();
  const limiter = createStudentPasswordChangeRateLimiter({ now: c.now });
  for (let i = 0; i < 100; i += 1) assert.deepEqual(limiter.checkAttempt("s1"), { allowed: true }, "checks alone never count");
  for (let i = 0; i < 10; i += 1) {
    assert.deepEqual(limiter.checkAttempt("s1"), { allowed: true }, `attempt ${i + 1}`);
    limiter.recordAttempt("s1");
  }
  assert.deepEqual(limiter.checkAttempt("s1"), { allowed: false, retryAfterSeconds: 900 });
  c.advance(1_000);
  assert.deepEqual(limiter.checkAttempt("s1"), { allowed: false, retryAfterSeconds: 899 });
  assert.deepEqual(limiter.checkAttempt("s2"), { allowed: true }, "another student has their own budget");
});

test("attempts slide: each slot frees exactly 15 minutes after it was used", () => {
  const c = clock(0);
  const limiter = createStudentPasswordChangeRateLimiter({ now: c.now });
  for (let i = 0; i < 10; i += 1) {
    limiter.recordAttempt("s1");
    c.advance(MIN); // attempts at 0, 1, ..., 9 minutes
  }
  c.set(15 * MIN - 1);
  assert.deepEqual(limiter.checkAttempt("s1"), { allowed: false, retryAfterSeconds: 1 }, "1 ms before the first expires (rounded up)");
  c.set(15 * MIN);
  assert.deepEqual(limiter.checkAttempt("s1"), { allowed: true }, "the 0-minute attempt has expired");
  limiter.recordAttempt("s1");
  assert.deepEqual(limiter.checkAttempt("s1"), { allowed: false, retryAfterSeconds: 60 }, "next slot frees at 16 minutes");
  c.set(30 * MIN);
  assert.deepEqual(limiter.checkAttempt("s1"), { allowed: true });
});

test("failures: 5 per student, separate from attempts, never cleared", () => {
  const c = clock();
  const limiter = createStudentPasswordChangeRateLimiter({ now: c.now });
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(limiter.checkFailure("s1"), { allowed: true });
    limiter.recordFailure("s1");
  }
  assert.deepEqual(limiter.checkFailure("s1"), { allowed: false, retryAfterSeconds: 900 });
  assert.deepEqual(limiter.checkAttempt("s1"), { allowed: true }, "failures do not use the attempt budget");
  for (let i = 0; i < 10; i += 1) limiter.recordAttempt("s1");
  assert.deepEqual(limiter.checkFailure("s1"), { allowed: false, retryAfterSeconds: 900 }, "attempts do not touch failures");
  assert.equal("reset" in limiter || "clearFailures" in limiter, false, "there is no way to clear failures");
  c.advance(15 * MIN);
  assert.deepEqual(limiter.checkFailure("s1"), { allowed: true }, "they expire with the window");
});

test("global safety cap across students, with its own Retry-After", () => {
  const c = clock();
  const limiter = createStudentPasswordChangeRateLimiter({ now: c.now, globalAttempts: 3 });
  for (const id of ["a", "b", "c"]) {
    assert.equal(limiter.checkAttempt(id).allowed, true);
    limiter.recordAttempt(id);
  }
  c.advance(2_000);
  assert.deepEqual(limiter.checkAttempt("d"), { allowed: false, retryAfterSeconds: 898 });
  c.advance(898_000);
  assert.equal(limiter.checkAttempt("d").allowed, true);
});

test("configuration: globalAttempts above maxStudents (or a non-positive / non-integer setting) is refused at creation", () => {
  assert.throws(
    () => createStudentPasswordChangeRateLimiter({ globalAttempts: 11, maxStudents: 10 }),
    /globalAttempts \(11\) must not exceed maxStudents \(10\), or live entries could be evicted/
  );
  assert.throws(() => createStudentPasswordChangeRateLimiter({ maxStudents: 3 }), /globalAttempts \(600\) must not exceed maxStudents \(3\)/, "the old cap-of-3 setup is now invalid");
  for (const [key, value] of [["attemptsPerStudent", 0], ["failuresPerStudent", -1], ["globalAttempts", 1.5], ["windowMs", Number.NaN], ["maxStudents", Infinity]]) {
    assert.throws(() => createStudentPasswordChangeRateLimiter({ [key]: value }), new RegExp(`${key} must be a positive integer`), key);
  }
  // Valid: the production defaults, and an equal cap.
  assert.doesNotThrow(() => createStudentPasswordChangeRateLimiter());
  assert.doesNotThrow(() => createStudentPasswordChangeRateLimiter({ globalAttempts: 4, maxStudents: 4 }));
});

test("valid configuration: live entries are never evicted, under constant pressure from new students", () => {
  const c = clock();
  const config = { now: c.now, attemptsPerStudent: 1, failuresPerStudent: 1, globalAttempts: 4, maxStudents: 4 };
  const limiter = createStudentPasswordChangeRateLimiter(config);
  const recordedAt = new Map();

  for (let i = 0; i < 200; i += 1) {
    const id = `s${i}`;
    // The handler's order: check, record, then (on a wrong password) the failure.
    if (limiter.checkAttempt(id).allowed) {
      limiter.recordAttempt(id);
      if (limiter.checkFailure(id).allowed) limiter.recordFailure(id);
      recordedAt.set(id, c.now());
    }
    for (const [student, at] of recordedAt) {
      if (c.now() - at < 15 * MIN) {
        assert.equal(limiter.checkAttempt(student).allowed, false, `${student}'s live attempt survived (step ${i})`);
        assert.equal(limiter.checkFailure(student).allowed, false, `${student}'s live failure survived (step ${i})`);
      }
    }
    const tracked = limiter.trackedStudents();
    assert.ok(tracked.attempts <= 4 && tracked.failures <= 4, JSON.stringify(tracked));
    c.advance(MIN);
  }
  assert.ok(recordedAt.size > 4, "students kept coming in as their windows slid");
});

test("expired entries are cleaned: when full, expired students make room; nothing live is lost", () => {
  const c = clock();
  const limiter = createStudentPasswordChangeRateLimiter({ now: c.now, globalAttempts: 4, maxStudents: 4 });
  for (const id of ["a", "b", "c", "d"]) {
    limiter.recordAttempt(id);
    limiter.recordFailure(id);
  }
  assert.deepEqual(limiter.trackedStudents(), { attempts: 4, failures: 4 });

  c.advance(15 * MIN);
  limiter.recordAttempt("e");
  limiter.recordFailure("e");
  assert.deepEqual(limiter.trackedStudents(), { attempts: 1, failures: 1 }, "the four expired students were swept, not live ones");
  assert.equal(limiter.checkFailure("a").allowed, true);
  assert.equal(limiter.checkAttempt("e").allowed, true, "e has 1 of 10 attempts");

  // Full with a mix: three expired students and one live one -> all three expired go, the live one stays.
  const mixed = createStudentPasswordChangeRateLimiter({ now: c.now, attemptsPerStudent: 1, globalAttempts: 4, maxStudents: 4 });
  for (const id of ["x1", "x2", "x3"]) mixed.recordAttempt(id);
  c.advance(10 * MIN);
  mixed.recordAttempt("live");
  c.advance(5 * MIN); // x1..x3 now expired, "live" is 5 minutes old
  mixed.recordAttempt("newcomer");
  assert.equal(mixed.trackedStudents().attempts, 2, "every expired student was swept (not just the oldest one)");
  assert.equal(mixed.checkAttempt("live").allowed, false, "the live student kept its entry");

  // A student whose entries have all expired is dropped as soon as it is looked at.
  c.advance(15 * MIN);
  limiter.checkAttempt("e");
  limiter.checkFailure("e");
  assert.deepEqual(limiter.trackedStudents(), { attempts: 0, failures: 0 });
});

test("timestamps per student stay bounded by the limit", () => {
  const c = clock();
  const many = createStudentPasswordChangeRateLimiter({ now: c.now });
  for (let i = 0; i < 50; i += 1) many.recordFailure("x");
  c.advance(1);
  // Only the newest 5 are kept, so the refusal ends when the 46th..50th entries expire.
  assert.deepEqual(many.checkFailure("x"), { allowed: false, retryAfterSeconds: 900 });
});
