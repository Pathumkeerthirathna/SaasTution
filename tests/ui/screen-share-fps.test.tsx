/**
 * The teacher's screen-sharing frame rate on the page side
 * (components/Jitsi/teacher-camera-preferences.mjs, useJitsi.ts,
 * JitsiClassroom.tsx, SidebarNav.tsx, constants/toolbar.ts,
 * services/session-service.ts). The preference helpers run directly; the
 * section is rendered with react-dom/server; the wiring is checked from
 * source. custom.js's side is tests/jitsi/screenshare-fps.test.cjs. What a
 * real browser captures needs a real screen share.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildScreenShareFrameRateMessage,
  DEFAULT_SCREEN_SHARE_FRAME_RATE,
  describeScreenShareFrameRateStatus,
  isScreenShareFrameRate,
  parseScreenShareFrameRateStatus,
  parseStoredScreenShareFrameRate,
  SCREEN_SHARE_FRAME_RATES,
  screenShareFrameRateStorageKey,
  TEACHING_FRAME_RATE_STORAGE_KEY,
} from "../../components/Jitsi/teacher-camera-preferences.mjs";
import { ScreenShareFpsSection } from "../../components/Jitsi/classroom/sidebar/SidebarNav";
import { studentToolbar, teacherToolbar } from "../../components/Jitsi/constants/toolbar";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const jitsiSource = (...parts: string[]) => source("components", "Jitsi", ...parts);

const status = (overrides: Record<string, unknown> = {}) => ({
  type: "SL_SCREENSHARE_FPS_STATUS", v: 1, fps: 15, applied: 15, sharing: false, pending: false,
  shareFps: null, trackFps: null, ...overrides,
});

/* ------------------------------ values / defaults ------------------------------ */

test("5 / 15 / 30 fps, teacher default 15", () => {
  assert.deepEqual([...SCREEN_SHARE_FRAME_RATES], [5, 15, 30]);
  assert.equal(DEFAULT_SCREEN_SHARE_FRAME_RATE, 15);
  assert.ok(isScreenShareFrameRate(30));
  assert.ok(!isScreenShareFrameRate(24));
  assert.ok(!isScreenShareFrameRate("15"));
});

test("saved 5 and 30 fps preferences are kept; nothing saved (or invalid) falls back to 15", () => {
  assert.equal(parseStoredScreenShareFrameRate("5"), 5);
  assert.equal(parseStoredScreenShareFrameRate("30"), 30);
  assert.equal(parseStoredScreenShareFrameRate("15"), 15);
  assert.equal(parseStoredScreenShareFrameRate(null), 15);
  assert.equal(parseStoredScreenShareFrameRate("24"), 15);
  assert.equal(parseStoredScreenShareFrameRate("5fps"), 15);
});

test("JitsiClassroom starts at the default and replaces it with the teacher's saved value", () => {
  const classroom = jitsiSource("JitsiClassroom.tsx");

  assert.match(classroom, /useState<number>\(DEFAULT_SCREEN_SHARE_FRAME_RATE\)/);
  assert.match(classroom, /const saved = parseStoredScreenShareFrameRate\(readStorage\(screenShareFpsStorageKey\)\);/);
});

test("the comment on the default separates the encoder mode from the capture constraint", () => {
  const prefs = jitsiSource("teacher-camera-preferences.mjs");
  const comment = prefs.slice(prefs.indexOf("The teacher's default until they pick one"), prefs.indexOf("export const DEFAULT_SCREEN_SHARE_FRAME_RATE"));

  assert.match(comment, /low-fps ENCODER mode but puts\s+\* NO frame-rate constraint on the capture/);
  assert.doesNotMatch(comment, /unset = 5 fps/);
});

/* ------------------------------- persistence ------------------------------- */

test("saved per teacher: different teachers get different keys; no teacher ID, no key", () => {
  const a = screenShareFrameRateStorageKey("teacher-a");
  const b = screenShareFrameRateStorageKey("teacher-b");

  assert.equal(a, "sl-classroom-teacher-screenshare-fps:teacher-a");
  assert.notEqual(a, b);
  assert.notEqual(a, TEACHING_FRAME_RATE_STORAGE_KEY, "separate from the webcam frame rate");
  assert.equal(screenShareFrameRateStorageKey(undefined), null);
  assert.equal(screenShareFrameRateStorageKey("  "), null);
});

test("JitsiClassroom: key only for the teacher (class's teacher ID); read on init, written only on a change", () => {
  const classroom = jitsiSource("JitsiClassroom.tsx");

  assert.match(classroom, /role === "teacher" \? screenShareFrameRateStorageKey\(joinInfo\?\.class\.teacherId\) : null/);
  assert.match(classroom, /readStorage\(screenShareFpsStorageKey\)\);[\s\S]{0,200}\}, \[screenShareFpsStorageKey\]\);/);
  assert.equal(classroom.match(/writeStorage\(screenShareFpsStorageKey/g)?.length, 1);
  assert.match(classroom, /if \(!isScreenShareFrameRate\(fps\) \|\| fps === screenShareFpsRef\.current\) \{\n\s*return;/);
  // Sent on each conference join (rejoin / recreated meeting), teacher only.
  assert.match(classroom, /setTeacherBitrate\(teacherBitrateRef\.current\);[\s\S]{0,250}setScreenShareFrameRate\(screenShareFpsRef\.current\);/);
  assert.match(classroom, /screenShareFps=\{role === "teacher"\n\s*\? \{ value: screenShareFps/);
  assert.match(classroom, /onScreenShareFrameRateStatus=\{role === "teacher" \? setScreenShareFpsStatus : undefined\}/);
});

test("teacher join info carries the class's teacher ID (student join info does not)", () => {
  const service = source("services", "session-service.ts");
  const teacherJoin = service.slice(service.indexOf("export async function getSessionJoinInfoForTeacher"));
  const studentJoin = service.slice(service.indexOf("export async function getSessionJoinInfo("), service.indexOf("// ---- Student Class Register"));

  assert.match(teacherJoin.slice(0, 800), /teacherId: true,/);
  assert.doesNotMatch(studentJoin, /teacherId: true/);
});

/* ------------------------------ messaging ------------------------------ */

test("the message for custom.js; an invalid value becomes the default", () => {
  assert.deepEqual(buildScreenShareFrameRateMessage(3, 30), { type: "SL_SCREENSHARE_FPS", v: 1, epoch: 3, fps: 30 });
  assert.deepEqual(buildScreenShareFrameRateMessage(4, 5), { type: "SL_SCREENSHARE_FPS", v: 1, epoch: 4, fps: 5 });
  assert.equal(buildScreenShareFrameRateMessage(5, 24).fps, 15);
});

test("useJitsi: teacher only, unchanged value not resent, resent on SL_RECEIVE_READY", () => {
  const jitsi = jitsiSource("hooks", "useJitsi.ts");
  const control = jitsi.slice(jitsi.indexOf("setScreenShareFrameRate: (fps) => {"), jitsi.indexOf("setVideoTelemetry: (enabled) => {", jitsi.indexOf("setScreenShareFrameRate: (fps) => {")));

  assert.match(control, /roleRef\.current !== "teacher" \|\| !isScreenShareFrameRate\(fps\)/);
  assert.match(control, /if \(screenShareFpsRef\.current\?\.fps === fps\) \{\n\s*return;/);
  assert.match(control, /screenShareFpsEpochRef\.current \+= 1;/);

  const ready = jitsi.slice(jitsi.indexOf('if (event.data?.type === "SL_RECEIVE_READY") {'));

  assert.match(ready.slice(0, 600), /postTeacherBitrate\(\);\n\s*postScreenShareFps\(\);/);
  assert.match(jitsi, /if \(screenShareFpsStatus\) \{\n\s*if \(roleRef\.current === "teacher"\) \{/);
});

test("desktopSharingFrameRate is never set in configOverwrite (it would override the runtime value)", () => {
  assert.doesNotMatch(jitsiSource("hooks", "useJitsi.ts"), /desktopSharingFrameRate/);
});

test("custom.js's status is validated", () => {
  assert.deepEqual(parseScreenShareFrameRateStatus(status({ sharing: true, pending: true, applied: 5, shareFps: 5, trackFps: 5 })), {
    fps: 15, applied: 5, sharing: true, pending: true, shareFps: 5, trackFps: 5,
  });
  assert.equal(parseScreenShareFrameRateStatus(status({ applied: null }))?.applied, null);
  assert.equal(parseScreenShareFrameRateStatus(status({ fps: 24 })), null);
  assert.equal(parseScreenShareFrameRateStatus(status({ v: 2 })), null);
  assert.equal(parseScreenShareFrameRateStatus(status({ pending: "yes" })), null);
  assert.equal(parseScreenShareFrameRateStatus(status({ trackFps: -1 })), null);
  assert.equal(parseScreenShareFrameRateStatus(null), null);
});

/* ------------------------------- status text ------------------------------- */

test("status lines: next share, sharing now, and a change during a share", () => {
  const parse = (overrides: Record<string, unknown>) => parseScreenShareFrameRateStatus(status(overrides));

  assert.equal(describeScreenShareFrameRateStatus(null, 5), "Not confirmed by the meeting yet.");
  assert.equal(describeScreenShareFrameRateStatus(parse({}), 15), "Your next screen share uses up to 15 fps.");
  assert.equal(
    describeScreenShareFrameRateStatus(parse({ fps: 30, applied: 15, sharing: true, pending: true, shareFps: 15, trackFps: 15 }), 30),
    "You are sharing now: 30 fps applies the next time you start screen sharing. Your current share is not interrupted.",
  );
  assert.equal(
    describeScreenShareFrameRateStatus(parse({ sharing: true, shareFps: 15, trackFps: 14.8 }), 15),
    "Sharing at up to 15 fps (browser reports 15 fps).",
  );
  // The page's newer choice not confirmed yet.
  assert.equal(describeScreenShareFrameRateStatus(parse({ fps: 5 }), 30), "Not confirmed by the meeting yet.");
});

/* ---------------------------------- section ---------------------------------- */

test("the section: 5 / 15 / 30 buttons, the selected one pressed, says it is screen sharing only", () => {
  const html = renderToStaticMarkup(
    <ScreenShareFpsSection screenShare={{ value: 15, status: null, onChange: () => {} }} />,
  );

  assert.match(html, /Screen sharing/);
  assert.match(html, /aria-label="Screen-sharing frame rate"/);
  assert.equal(html.match(/data-screenshare-fps="\d+"/g)?.length, 3);
  assert.match(html, /aria-pressed="true" data-screenshare-fps="15"/);
  assert.match(html, /aria-pressed="false" data-screenshare-fps="5"/);
  assert.match(html, /Controls screen sharing only, not your webcam\./);
  assert.match(html, /15 fps \(default\)/);
  assert.match(html, /A change applies the next time you start sharing\./);
});

test("SidebarNav renders it below the Camera section; RightSidebar passes it to teachers only", () => {
  const nav = jitsiSource("classroom", "sidebar", "SidebarNav.tsx");
  const sidebar = jitsiSource("classroom", "sidebar", "RightSidebar.tsx");

  assert.ok(nav.indexOf("<ScreenShareFpsSection screenShare={screenShareFps} />") > nav.indexOf("<TeacherBitrateSection bitrate={teacherBitrate} />"));
  assert.match(sidebar, /screenShareFps=\{isTeacher \? props\.screenShareFps : undefined\}/);
});

test("students: no screen-sharing control, preference or message (Jitsi's own behaviour stays)", () => {
  const classroom = jitsiSource("JitsiClassroom.tsx");
  const jitsi = jitsiSource("hooks", "useJitsi.ts");

  assert.match(classroom, /screenShareFpsStorageKey =\n\s*role === "teacher" \?/);
  assert.match(jitsi, /postScreenShareFps = \(\) => \{\n\s*const message = screenShareFpsRef\.current;\n\n\s*if \(!message \|\| roleRef\.current !== "teacher"\)/);
});

test("webcam FPS and screen-sharing FPS stay separate (own values, own keys, own messages)", () => {
  assert.notDeepEqual([...SCREEN_SHARE_FRAME_RATES], [15, 24, 30]);
  assert.notEqual(screenShareFrameRateStorageKey("t1"), TEACHING_FRAME_RATE_STORAGE_KEY);
  assert.equal(buildScreenShareFrameRateMessage(1, 30).type, "SL_SCREENSHARE_FPS");

  const classroom = jitsiSource("JitsiClassroom.tsx");
  const handler = classroom.slice(classroom.indexOf("const handleSetScreenShareFps"), classroom.indexOf("}, [screenShareFpsStorageKey]);", classroom.indexOf("const handleSetScreenShareFps")));

  assert.doesNotMatch(handler, /setTeachingMode|applyTeachingSettings|TEACHING_FRAME_RATE|setTeacherBitrate|setVideoQuality/);
});
