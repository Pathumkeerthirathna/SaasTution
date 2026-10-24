/*
 * Codec test: token expiry display (scripts/codec-test/time.ts).
 *
 *   npm run test:codec
 *
 * Fixed instants only: no token is created.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DISPLAY_TIME_ZONE, formatExpiry, formatLocalTime, minutesRemaining } from "../../scripts/codec-test/time";

// 00:48:56 in Colombo on the 21st is still the 20th in UTC.
const NOW = new Date("2026-10-20T19:18:56.012Z");
const EXPIRES = new Date("2026-10-20T20:18:56.012Z");

test("expiry: UTC and Asia/Colombo time with the minutes remaining", () => {
  assert.equal(DISPLAY_TIME_ZONE, "Asia/Colombo");
  assert.equal(formatExpiry(EXPIRES, NOW), "2026-10-20T20:18:56Z (2026-10-21 01:48 Asia/Colombo, in 60 min)");
});

test("local time follows the zone's rules across midnight and date changes", () => {
  assert.equal(formatLocalTime(new Date("2026-10-20T18:30:00Z")), "2026-10-21 00:00");
  assert.equal(formatLocalTime(new Date("2026-10-20T18:29:00Z")), "2026-10-20 23:59");
  assert.equal(formatLocalTime(new Date("2026-12-31T20:00:00Z")), "2027-01-01 01:30");
  // Another zone through the same formatter (proves no fixed offset is used).
  assert.equal(formatLocalTime(new Date("2026-07-01T12:00:00Z"), "Europe/London"), "2026-07-01 13:00");
  assert.equal(formatLocalTime(new Date("2026-12-01T12:00:00Z"), "Europe/London"), "2026-12-01 12:00");
});

test("remaining time: whole minutes, positive while valid", () => {
  assert.equal(minutesRemaining(EXPIRES, NOW), 60);
  assert.equal(minutesRemaining(EXPIRES, new Date(EXPIRES.getTime() - 59.5 * 60_000)), 59);
  assert.equal(minutesRemaining(EXPIRES, new Date(EXPIRES.getTime() - 30_000)), 0);
  assert.match(formatExpiry(EXPIRES, new Date(EXPIRES.getTime() - 30_000)), /, in 0 min\)$/);
});

test("an expiry that has passed is shown as EXPIRED, never as a positive time", () => {
  assert.match(formatExpiry(EXPIRES, EXPIRES), /, EXPIRED\)$/);
  assert.match(formatExpiry(EXPIRES, new Date(EXPIRES.getTime() + 5 * 60_000)), /, EXPIRED\)$/);
});

test("an unknown time zone falls back to UTC only, without throwing", () => {
  assert.equal(formatLocalTime(EXPIRES, "Not/AZone"), null);
  assert.equal(formatExpiry(EXPIRES, NOW, "Not/AZone"), "2026-10-20T20:18:56Z (local time unavailable for Not/AZone, in 60 min)");
});
