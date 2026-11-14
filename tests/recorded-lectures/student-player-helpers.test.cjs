/*
 * Recorded Lectures RL-5.1: pure helpers of the student player pages
 * (components/student-portal/recorded-lectures/*.ts): grouping and paging,
 * part navigation, formatting, resume storage, and playback error mapping.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const dir = path.join(root, "components", "student-portal", "recorded-lectures");
const H = require(path.join(dir, "recording-helpers.ts"));
const S = require(path.join(dir, "resume-store.ts"));
const E = require(path.join(dir, "player-errors.ts"));

const rec = (id, lectureId, partNumber, extra = {}) => ({
  id,
  title: `T${id}`,
  partNumber,
  sizeBytes: "1000",
  durationSeconds: 60,
  width: null,
  height: null,
  readyAt: null,
  lecture: { id: lectureId, title: `L${lectureId}`, date: "2026-11-14T04:30:00.000Z", endDate: null },
  class: { id: "c", name: "C" },
  dashboard: { visible: false, visibleFrom: "x", visibleUntil: "y" },
  streamUrl: `/api/student/recorded-lectures/${id}/stream`,
  ...extra,
});

// ---- Grouping and paging -------------------------------------------------------------------------

test("grouping: parts of one lecture split across two pages end up in one group, order kept", () => {
  const page1 = [rec("a1", "A", 1), rec("a2", "A", 2), rec("b1", "B", 1), rec("b2", "B", 2)];
  const page2 = [rec("b3", "B", 3), rec("c1", "C", 1)];
  const merged = H.mergeRecordings(page1, page2);
  const groups = H.groupByLecture(merged);
  assert.deepEqual(groups.map((g) => [g.lecture.id, g.parts.map((p) => p.id)]), [
    ["A", ["a1", "a2"]],
    ["B", ["b1", "b2", "b3"]],
    ["C", ["c1"]],
  ]);
});

test("merging: a row already shown is not duplicated (overlapping or repeated page)", () => {
  const first = [rec("a1", "A", 1), rec("a2", "A", 2)];
  const merged = H.mergeRecordings(first, [rec("a2", "A", 2), rec("a3", "A", 3)]);
  assert.deepEqual(merged.map((r) => r.id), ["a1", "a2", "a3"]);
  assert.deepEqual(H.mergeRecordings([], []), []);
});

// ---- Part navigation -----------------------------------------------------------------------------

test("navigation: previous / next follow the list order, also with gaps in part numbers", () => {
  const parts = [rec("p1", "L", 1), rec("p3", "L", 3), rec("p7", "L", 7)];
  const middle = H.partPosition(parts, "p3");
  assert.equal(middle.index, 1);
  assert.equal(middle.previous.id, "p1");
  assert.equal(middle.next.id, "p7");
  assert.equal(H.partPosition(parts, "p1").previous, null);
  assert.equal(H.partPosition(parts, "p7").next, null);
  assert.equal(H.partPosition(parts, "nope"), null);
  assert.equal(H.partPosition([], null), null);
  assert.equal(H.partLabel(parts[2]), "Part 7");
});

test("navigation: open the requested part, else the last watched, else the first", () => {
  const parts = [rec("p1", "L", 1), rec("p2", "L", 2)];
  assert.equal(H.initialPartId(parts, "p2", "p1"), "p2");
  assert.equal(H.initialPartId(parts, "gone", "p2"), "p2");
  assert.equal(H.initialPartId(parts, null, "gone"), "p1");
  assert.equal(H.initialPartId(parts, null, null), "p1");
  assert.equal(H.initialPartId([], "p1", "p2"), null);
});

test("links: player, class page and list API URLs (encoded, explicit page size)", () => {
  assert.equal(H.playerHref("L1"), "/student/recorded-lectures/L1");
  assert.equal(H.playerHref("L1", "R1"), "/student/recorded-lectures/L1?recording=R1");
  assert.equal(H.classRecordingsHref("C1"), "/student/recorded-lectures?classId=C1");
  assert.equal(H.listApiUrl({ classId: "C1" }, "abc", 50), "/api/student/recorded-lectures?classId=C1&cursor=abc&limit=50");
  assert.equal(H.listApiUrl({ lectureId: "L1" }, null, 50), "/api/student/recorded-lectures?lectureId=L1&limit=50");
  assert.equal(H.listApiUrl({ scope: "dashboard" }, null, 6), "/api/student/recorded-lectures?scope=dashboard&limit=6");
  assert.equal(H.playerHref("a b", "c&d"), "/student/recorded-lectures/a%20b?recording=c%26d");
});

// ---- Formatting ----------------------------------------------------------------------------------

test("dates are shown in Sri Lankan time whatever the browser / server timezone", () => {
  const saved = process.env.TZ;
  const results = new Set();
  try {
    for (const tz of ["UTC", "Asia/Colombo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      results.add(H.formatLectureDateTime("2026-11-13T18:30:00.000Z")); // 14 Nov 00:00 in Sri Lanka
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
  assert.equal(results.size, 1);
  const [text] = [...results];
  assert.match(text, /14 Nov 2026/);
  assert.match(text, /12:00\s?am/i);
  assert.equal(H.formatLectureDateTime(null), "—");
  assert.equal(H.formatLectureDateTime("not a date"), "—");
});

test("durations and sizes", () => {
  assert.equal(H.formatDuration(65), "1:05");
  assert.equal(H.formatDuration(3725), "1:02:05");
  assert.equal(H.formatDuration(0), "0:00");
  for (const bad of [null, undefined, -1, Number.NaN, Infinity]) assert.equal(H.formatDuration(bad), "—");
  assert.equal(H.formatSize("1500000000"), "1.5 GB");
  assert.equal(H.formatSize("999"), "999 B");
  assert.equal(H.formatSize("250000000"), "250 MB");
  for (const bad of [null, "", "-1", "1e9", 5]) assert.equal(H.formatSize(bad), "—");
});

test("playback speed: only the offered rates are accepted (anything else is 1x)", () => {
  assert.deepEqual(H.PLAYBACK_RATES, [0.75, 1, 1.25, 1.5, 1.75, 2]);
  assert.equal(H.normalizePlaybackRate("1.5"), 1.5);
  assert.equal(H.normalizePlaybackRate(2), 2);
  for (const bad of ["16", "0", "-1", "abc", null, undefined, 3]) assert.equal(H.normalizePlaybackRate(bad), 1);
});

// ---- Resume storage ------------------------------------------------------------------------------

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function throwingStorage() {
  const fail = () => {
    throw new Error("SecurityError");
  };
  return { get length() { return fail(); }, key: fail, getItem: fail, setItem: fail, removeItem: fail };
}

test("resume: positions are kept per student AND per recording", () => {
  const storage = memoryStorage();
  assert.equal(S.saveResumePosition(storage, "student-a", "rec-1", 120, 3600), "saved");
  assert.equal(S.saveResumePosition(storage, "student-b", "rec-1", 900, 3600), "saved");
  assert.equal(S.readResumePosition(storage, "student-a", "rec-1"), 120);
  assert.equal(S.readResumePosition(storage, "student-b", "rec-1"), 900);
  assert.equal(S.readResumePosition(storage, "student-a", "rec-2"), null);
  assert.equal(S.readResumePosition(storage, "student-c", "rec-1"), null, "another student on the same browser sees nothing");
  assert.ok(S.positionKey("student-a", "rec-1").includes("student-a"));
});

test("resume: nothing before 10 s; cleared at 95 % (finished); resumeStartFor ignores finished positions", () => {
  const storage = memoryStorage();
  assert.equal(S.saveResumePosition(storage, "s", "r", 9.9, 100), "skipped");
  assert.equal(S.readResumePosition(storage, "s", "r"), null);
  assert.equal(S.saveResumePosition(storage, "s", "r", 50.7, 100), "saved");
  assert.equal(S.readResumePosition(storage, "s", "r"), 50);
  assert.equal(S.saveResumePosition(storage, "s", "r", 95, 100), "cleared");
  assert.equal(S.readResumePosition(storage, "s", "r"), null);
  assert.equal(S.resumeStartFor(50, 100), 50);
  assert.equal(S.resumeStartFor(96, 100), null);
  assert.equal(S.resumeStartFor(50, Number.NaN), 50, "unknown duration: resume anyway");
  assert.equal(S.resumeStartFor(null, 100), null);
  S.saveResumePosition(storage, "s", "r", 30, 100);
  S.clearResumePosition(storage, "s", "r");
  assert.equal(S.readResumePosition(storage, "s", "r"), null);
});

test("resume: at most 100 positions per student; the least recently saved go first; other students untouched", () => {
  const storage = memoryStorage();
  S.saveResumePosition(storage, "other", "keep", 60, 1000, 1);
  for (let i = 0; i < 105; i += 1) S.saveResumePosition(storage, "s", `r${i}`, 60, 1000, 1000 + i);
  const mine = [...storage.map.keys()].filter((k) => k.startsWith("sl:rl:pos:s:"));
  assert.equal(mine.length, 100);
  for (let i = 0; i < 5; i += 1) assert.equal(S.readResumePosition(storage, "s", `r${i}`), null, `r${i} evicted`);
  assert.equal(S.readResumePosition(storage, "s", "r104"), 60);
  assert.equal(S.readResumePosition(storage, "other", "keep"), 60);
});

test("resume: missing, throwing or corrupt storage never breaks anything", () => {
  for (const storage of [null, throwingStorage()]) {
    assert.equal(S.saveResumePosition(storage, "s", "r", 60, 100), "skipped");
    assert.equal(S.readResumePosition(storage, "s", "r"), null);
    assert.doesNotThrow(() => S.clearResumePosition(storage, "s", "r"));
    assert.doesNotThrow(() => S.saveLastPart(storage, "s", "L", "r"));
    assert.equal(S.readLastPart(storage, "s", "L"), null);
    assert.equal(S.readPreferredRate(storage), null);
    assert.doesNotThrow(() => S.savePreferredRate(storage, 1.5));
  }
  const corrupt = memoryStorage();
  corrupt.setItem(S.positionKey("s", "r"), "{not json");
  corrupt.setItem(S.lastPartKey("s", "L"), "42");
  assert.equal(S.readResumePosition(corrupt, "s", "r"), null);
  assert.equal(S.readLastPart(corrupt, "s", "L"), null);
  // A full storage (setItem throws) only skips.
  const full = memoryStorage();
  full.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.equal(S.saveResumePosition(full, "s", "r", 60, 100), "skipped");
  assert.equal(S.browserStorage(), null, "no window in node: no storage, no throw");
});

test("resume: a browser whose localStorage getter throws (blocked site data) gives null, never an exception", () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const saved = globalThis.window;
  const blocked = {};
  Object.defineProperty(blocked, "localStorage", {
    get() {
      throw new Error("SecurityError: access denied");
    },
  });
  globalThis.window = blocked;
  try {
    assert.equal(S.browserStorage(), null);
    assert.equal(S.readResumePosition(S.browserStorage(), "s", "r"), null);
    const working = memoryStorage();
    globalThis.window = { localStorage: working };
    assert.equal(S.browserStorage(), working);
  } finally {
    if (hadWindow) globalThis.window = saved;
    else delete globalThis.window;
  }
});

test("resume: last watched part per student and lecture; preferred speed", () => {
  const storage = memoryStorage();
  S.saveLastPart(storage, "s", "L1", "p2");
  S.saveLastPart(storage, "t", "L1", "p9");
  assert.equal(S.readLastPart(storage, "s", "L1"), "p2");
  assert.equal(S.readLastPart(storage, "t", "L1"), "p9");
  assert.equal(S.readLastPart(storage, "s", "L2"), null);
  S.savePreferredRate(storage, 1.25);
  assert.equal(H.normalizePlaybackRate(S.readPreferredRate(storage)), 1.25);
});

// ---- Playback errors -----------------------------------------------------------------------------

test("errors: HEAD statuses for session, account, availability and file problems", () => {
  assert.deepEqual(
    [401, 403, 404, 500, 503, 502].map((s) => E.diagnosePlaybackFailure(s).kind),
    ["SESSION_EXPIRED", "ACCOUNT_INACTIVE", "NOT_AVAILABLE", "FILE_UNAVAILABLE", "TEMPORARILY_UNAVAILABLE", "TEMPORARILY_UNAVAILABLE"]
  );
  const expired = E.diagnosePlaybackFailure(401);
  assert.equal(expired.signIn, true);
  assert.equal(expired.retryable, false);
  assert.equal(E.diagnosePlaybackFailure(404).retryable, false);
  assert.equal(E.diagnosePlaybackFailure(500).retryable, false);
  assert.equal(E.diagnosePlaybackFailure(503).retryable, true);
});

test("errors: a HEAD that succeeds or fails on the network is a generic, retryable interruption (never assumed to be 429)", () => {
  for (const status of [200, 206, 416, null, 429]) {
    const failure = E.diagnosePlaybackFailure(status);
    assert.equal(failure.kind, "PLAYBACK_INTERRUPTED", String(status));
    assert.equal(failure.retryable, true);
    assert.equal(failure.signIn, false);
  }
  const text = JSON.stringify(E.playbackFailure("PLAYBACK_INTERRUPTED"));
  assert.match(text, /other tabs/);
  assert.doesNotMatch(text, /429|limit reached/i);
});

test("errors: list / load-more failures", () => {
  assert.equal(E.listFailureMessage(401).signIn, true);
  assert.match(E.listFailureMessage(403).message, /inactive/);
  assert.match(E.listFailureMessage(503).message, /temporarily/);
  assert.match(E.listFailureMessage(0).message, /try again/);
});
