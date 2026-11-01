/**
 * The returning teacher's notices about the teacher-departure stop
 * (components/Jitsi/teacher-departure-notice.ts) and their wiring in
 * JitsiClassroom.tsx. Wording is run directly; the wiring is checked from
 * source. What a real browser shows (the toasts, Jitsi's events on rejoin)
 * remains a manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  canStopOrphanStream,
  describePendingNotice,
  describeStoppedNotice,
  parseDepartureNotices,
  type DepartureNotices,
} from "../../components/Jitsi/teacher-departure-notice";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const at = (iso: string) => iso;
const clock = (date: Date) => date.toISOString().slice(11, 16);

const stoppedLive = { feature: "live" as const, id: "live-1", endedAt: at("2026-10-29T10:42:00.000Z"), youtubeUrl: "https://youtu.be/l" };
const stoppedRecording = { feature: "recording" as const, id: "rec-1", endedAt: at("2026-10-29T10:41:30.000Z"), youtubeUrl: "https://youtu.be/r" };

const notices = (overrides: Partial<DepartureNotices> = {}): DepartureNotices => ({
  sessionId: "session-1",
  sessionActive: true,
  stopped: [],
  pending: [],
  activeFeatures: [],
  hadDepartureStop: false,
  ...overrides,
});

/* ------------------------------ confirmed stops ------------------------------ */

test("Live only: names only Live", () => {
  const notice = describeStoppedNotice([stoppedLive], clock);

  assert.equal(notice?.message, "Your YouTube Live was stopped because you closed the classroom (at 10:42).");
  assert.deepEqual(notice?.features, ["live"]);
  assert.deepEqual(notice?.liveIds, ["live-1"]);
  assert.deepEqual(notice?.recordingIds, []);
});

test("Recording only: names only Recording", () => {
  const notice = describeStoppedNotice([stoppedRecording], clock);

  assert.equal(notice?.message, "Your YouTube Recording was stopped because you closed the classroom (at 10:41).");
  assert.deepEqual(notice?.recordingIds, ["rec-1"]);
  assert.deepEqual(notice?.liveIds, []);
});

test("both: one message naming both, at the later stop time; every ID to acknowledge", () => {
  const notice = describeStoppedNotice([stoppedRecording, stoppedLive], clock);

  assert.equal(notice?.message, "Your YouTube Live and Recording were stopped because you closed the classroom (at 10:42).");
  assert.deepEqual(notice?.liveIds, ["live-1"]);
  assert.deepEqual(notice?.recordingIds, ["rec-1"]);
});

test("nothing stopped: no notice", () => {
  assert.equal(describeStoppedNotice([], clock), null);
  assert.equal(describePendingNotice([]), null);
});

/* ------------------------------ pending stops ------------------------------ */

test("pending: never says stopped; says it may still be running and which Stop to use", () => {
  const notice = describePendingNotice([{ feature: "live", id: "live-1", attemptedAt: null, reason: "youtube" }]);

  assert.equal(
    notice?.message,
    "We tried to stop your YouTube Live after you closed the classroom, but YouTube has not confirmed it. It may still be running: use Stop Live to end it."
  );
  assert.doesNotMatch(notice?.message ?? "", /was stopped|were stopped/);
  assert.equal(notice?.reauthRequired, false);
});

test("pending with expired authorization: reconnect first; both features named", () => {
  const notice = describePendingNotice([
    { feature: "recording", id: "rec-1", attemptedAt: null, reason: "youtube" },
    { feature: "live", id: "live-1", attemptedAt: null, reason: "reauth-required" },
  ]);

  assert.equal(
    notice?.message,
    "We tried to stop your YouTube Live and Recording after you closed the classroom, but YouTube has not confirmed it. Reconnect YouTube, then use Stop Live and Stop Recording."
  );
  assert.equal(notice?.reauthRequired, true);
});

test("unresolved: automatic attempts stopped; never says stopped; points to Stop and YouTube Studio", () => {
  const notice = describePendingNotice([{ feature: "live", id: "live-1", attemptedAt: null, reason: "unresolved" }]);

  assert.equal(
    notice?.message,
    "We tried to stop your YouTube Live after you closed the classroom, but YouTube has not confirmed it. Automatic attempts have stopped. Use Stop Live, or end it in YouTube Studio."
  );
  assert.doesNotMatch(notice?.message ?? "", /was stopped|were stopped/);
});

/* ------------------------------ response and orphan rule ------------------------------ */

test("parse: the API's data, or null for anything malformed", () => {
  const data = notices({ stopped: [stoppedLive], hadDepartureStop: true });

  assert.deepEqual(parseDepartureNotices(data), data);
  assert.equal(parseDepartureNotices(null), null);
  assert.equal(parseDepartureNotices({ ...data, activeFeatures: ["file"] }), null);
  assert.equal(parseDepartureNotices({ ...data, stopped: [{ ...stoppedLive, endedAt: "soon" }] }), null);
  assert.equal(parseDepartureNotices({ ...data, sessionActive: "yes" }), null);
});

test("orphaned stream: only after a departure stop, with nothing active or pending, in an active session", () => {
  assert.equal(canStopOrphanStream(notices({ hadDepartureStop: true })), true);
  assert.equal(canStopOrphanStream(notices({ hadDepartureStop: false })), false, "no departure stop");
  assert.equal(canStopOrphanStream(notices({ hadDepartureStop: true, activeFeatures: ["recording"] })), false, "a feature is active");
  assert.equal(
    canStopOrphanStream(notices({ hadDepartureStop: true, pending: [{ feature: "live", id: "l", attemptedAt: null, reason: "youtube" }] })),
    false,
    "a stop is pending"
  );
  assert.equal(canStopOrphanStream(notices({ hadDepartureStop: true, sessionActive: false })), false, "session ended");
});

/* ------------------------------ wiring ------------------------------ */

test("JitsiClassroom: teacher only, this session's endpoint; durable acknowledgement; arms only via canStopOrphanStream", () => {
  const code = source("components", "Jitsi", "JitsiClassroom.tsx");
  const effect = /\/\/ Teacher-departure stop \(lib\/teacher-departure-notices\.ts\)[\s\S]*?\}, \[joinInfo, role\]\);/.exec(code)?.[0] ?? "";

  assert.ok(effect, "effect found");
  assert.match(effect, /if \(!joinInfo \|\| role !== "teacher" \|\| !sessionId\) \{\s*return;/);
  assert.match(effect, /const url = `\/api\/sessions\/\$\{sessionId\}\/teacher-departure`;/);
  assert.match(effect, /method: "POST"[\s\S]*?JSON\.stringify\(\{ recordingIds: stopped\.recordingIds, liveIds: stopped\.liveIds \}\)/);
  assert.match(effect, /if \(canStopOrphanStream\(notices\)\) \{\s*youtubeStreamRef\.current\?\.armOrphanStreamStop\(async \(\) => \{\s*const fresh = await loadNotices\(\);\s*return Boolean\(fresh && canStopOrphanStream\(fresh\)\);/);

  // Persistent toasts with fixed IDs (no duplicates on a re-render).
  assert.match(code, /\{ id: "teacher-departure-stopped", duration: Infinity \}/);
  assert.match(code, /\{ id: "teacher-departure-pending", duration: Infinity \}/);
  // A failed save is said, not hidden.
  assert.match(code, /if \(!saved\) \{\s*toast\.error\("Couldn't save that you've seen this\. It will show again next time\."\);/);
  // A failed or malformed notices response is logged, not silently ignored.
  assert.match(effect, /console\.error\("Teacher-departure notices request failed:"/);
  assert.match(effect, /console\.error\("Teacher-departure notices response had an unexpected shape:"/);
});

test("JitsiClassroom: tab-close signal for the teacher only, with this page's ID; the YouTube reconnect is not a close", () => {
  const code = source("components", "Jitsi", "JitsiClassroom.tsx");
  const effect = /\/\/ Tab-close signal \(teacher-departure-signal\.ts\)[\s\S]*?\}, \[joinInfo, role\]\);/.exec(code)?.[0] ?? "";

  assert.ok(effect, "effect found");
  assert.match(effect, /if \(!joinInfo \|\| role !== "teacher" \|\| !sessionId\) \{\s*return;/);
  assert.match(effect, /return installTeacherDepartureSignal\(\{ sessionId, pageId: pageIdRef\.current \}\);/, "removed on unmount");

  // The live-updates connection carries the same page ID (teacher only).
  assert.match(code, /\(role === "teacher" \? `&pageId=\$\{encodeURIComponent\(pageIdRef\.current\)\}` : ""\)/);

  // Away to Google and back to this classroom: no closing signal.
  const reconnect = /function goToYouTubeOAuthConnect\(\) \{[\s\S]*?\n\}/.exec(code)?.[0] ?? "";

  assert.ok(reconnect.indexOf("suppressNextDepartureSignal();") >= 0);
  assert.ok(reconnect.indexOf("suppressNextDepartureSignal();") < reconnect.indexOf("window.location.href"));

  // Nothing reacts to visibility: hidden is never a close.
  const signal = source("components", "Jitsi", "teacher-departure-signal.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  assert.doesNotMatch(signal, /visibilitychange|visibilityState|"freeze"|"blur"/);

  // Closing signals: desktop browsers only (lib/browser-form-factor.ts).
  assert.match(signal, /options\.isDesktop \?\? isDesktopBrowser\(/);
  assert.match(signal, /if \(!isDesktop \|\| closingSent\) return;/);

  // The notices request identifies this page (its activity on return).
  assert.match(code, /fetch\(`\$\{url\}\?pageId=\$\{encodeURIComponent\(pageIdRef\.current\)\}`, \{ cache: "no-store" \}\)/);
});

test("signal endpoint: teacher only, ownership checked, same-origin only", () => {
  const route = source("app", "api", "sessions", "[id]", "teacher-departure", "signal", "route.ts");

  assert.match(route, /if \(!isSameOrigin\(request\)\) \{\s*throw new AppError\("Cross-site request refused\.", 403, "FORBIDDEN"\);/);
  assert.match(route, /const teacherSession = await requireTeacherSession\(\);\s*\/\/[^\n]*\n\s*await ensureSessionAccessForTeacher\(teacherSession\.teacherId, sessionId\);/);
});

test("endpoint: teachers only; GET and POST use the session in the URL", () => {
  const route = source("app", "api", "sessions", "[id]", "teacher-departure", "route.ts");

  assert.equal((route.match(/await requireTeacherSession\(\)/g) || []).length, 2);
  assert.match(route, /getTeacherDepartureNotices\(\s*session\.teacherId,\s*sessionIdOf\(context\),\s*isValidPageId\(pageId\) \? pageId : null\s*\)/);
  assert.match(route, /acknowledgeTeacherDepartureNotices\(session\.teacherId, sessionId, \{ recordingIds, liveIds \}\)/);
});
