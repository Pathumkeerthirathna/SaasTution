/*
 * UI tests: the teacher's noise-suppression (RNNoise) toggle is owned by
 * JitsiClassroom, shown only for teachers, sent through useJitsi's
 * once-per-join controller, and the native Jitsi button is gone.
 *
 *   npm run test:ui
 *
 * The settings menu opens on a click (no DOM test library here), so the
 * wiring is checked in the source; the controller itself is unit-tested in
 * tests/jitsi/teacher-audio-preferences.test.cjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const JITSI = path.join(__dirname, "..", "..", "components", "Jitsi");
const source = (...parts: string[]) => readFileSync(path.join(JITSI, ...parts), "utf8").replace(/\r\n/g, "\n");

// The active (not commented-out) buttons of baseTeacherToolbar, from source
// (toolbar.ts picks a layout from the browser at import time).
function baseTeacherToolbarForTests(): string[] {
  const code = source("constants", "toolbar.ts");
  const list = /const baseTeacherToolbar = \[([\s\S]*?)\];/.exec(code)?.[1] ?? "";

  return list
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .flatMap((line) => Array.from(line.matchAll(/"([^"]+)"/g)).map((match) => match[1]));
}

test("JitsiClassroom owns the choice: read from storage (default ON), saved on change, sent through Jitsi", () => {
  const code = source("JitsiClassroom.tsx");

  assert.match(code, /const \[noiseSuppression, setNoiseSuppressionState\] = useState<boolean>\(\(\) =>\s*readStoredNoiseSuppression\(\)\s*\);/);
  assert.match(code, /const handleSetNoiseSuppression = useCallback\(\(enabled: boolean\) => \{\s*noiseSuppressionRef\.current = enabled;\s*setNoiseSuppressionState\(enabled\);\s*writeStorage\(NOISE_SUPPRESSION_STORAGE_KEY, String\(enabled\)\);\s*jitsiMeetingRef\.current\?\.setNoiseSuppression\(enabled\);/);
});

test("teacher only: the toggle callback reaches the sidebar only for teachers; students never send", () => {
  const code = source("JitsiClassroom.tsx");
  const sidebar = source("classroom", "sidebar", "RightSidebar.tsx");
  const jitsi = source("hooks", "useJitsi.ts");

  assert.match(code, /onSetNoiseSuppression=\{role === "teacher" \? handleSetNoiseSuppression : undefined\}/);
  assert.match(sidebar, /onSetNoiseSuppression=\{isTeacher \? props\.onSetNoiseSuppression : undefined\}/);
  // useJitsi drops it for anyone but the teacher.
  assert.match(jitsi, /setNoiseSuppression: \(enabled\) => \{\s*\/\/ Teacher only: a student's page never sends it\.\s*if \(roleRef\.current !== "teacher"\) \{\s*return;\s*\}/);
});

test("reapplied on every join: the page hands the choice over at join, useJitsi sends it once per conference", () => {
  const code = source("JitsiClassroom.tsx");
  const jitsi = source("hooks", "useJitsi.ts");

  assert.match(code, /if \(role === "teacher"\) \{\s*jitsiMeetingRef\.current\?\.setTeachingMode\(teachingSettingsRef\.current\);[\s\S]{0,200}?jitsiMeetingRef\.current\?\.setNoiseSuppression\(noiseSuppressionRef\.current\);/);
  assert.match(jitsi, /getVideoQualityController\(\)\.conferenceJoined\(\);\s*\/\/[^\n]*\n\s*getNoiseSuppressionController\(\)\.conferenceJoined\(\);/);
  assert.equal(jitsi.split("getNoiseSuppressionController().conferenceLeft();").length - 1, 2, "left and teardown");
  // Queued, never dropped: the command is only sent through the controller,
  // whose send reports "not sent" while there is no API.
  assert.equal(jitsi.split('executeCommand("setNoiseSuppressionEnabled"').length - 1, 1);
  assert.match(jitsi, /createNoiseSuppressionController\(\(enabled\) => \{\s*if \(!apiRef\.current\) \{\s*return false;\s*\}\s*apiRef\.current\.executeCommand\("setNoiseSuppressionEnabled", \{ enabled \}\);\s*return true;/);
  assert.match(jitsi, /const sent = getNoiseSuppressionController\(\)\.setDesired\(enabled\);/);
});

test("the sidebar toggle is controlled by the parent: no own state, storage or apply-once effect", () => {
  const nav = source("classroom", "sidebar", "SidebarNav.tsx");

  assert.doesNotMatch(nav, /appliedStoredNoiseSuppressionRef|readStoredNoiseSuppression|NOISE_SUPPRESSION_STORAGE_KEY|setNoiseSuppression\(/);
  assert.match(nav, /noiseSuppression = false,\s*onSetNoiseSuppression,/);
  assert.match(nav, /\{onSetNoiseSuppression \? \(/);
  assert.match(nav, /role="switch"\s*aria-checked=\{noiseSuppression\}\s*onClick=\{\(\) => onSetNoiseSuppression\(!noiseSuppression\)\}/);
});

test("honest help text: on by default, robotic / cut words, stereo and desktop-audio limits, no read-back", () => {
  const nav = source("classroom", "sidebar", "SidebarNav.tsx").replace(/\s+/g, " ");

  assert.match(nav, /Reduces background noise on your mic \(on by default\)\. Turn off if your voice sounds robotic or words get cut\./);
  assert.match(nav, /It may not be available with a stereo microphone or while you share desktop audio; Jitsi then shows a notice in the meeting\./);
  assert.match(nav, /This switch shows your choice: SLClassroom cannot read back whether Jitsi applied it\./);
  assert.doesNotMatch(nav, /noise suppression is (active|on now)|applied to your mic/i);
});

test("the native Jitsi noise-suppression button is gone from the teacher toolbar; nothing else removed", () => {
  const toolbar = baseTeacherToolbarForTests();

  assert.ok(!toolbar.includes("noisesuppression"));

  for (const button of ["microphone", "camera", "desktop", "hangup", "fullscreen", "settings", "videoquality",
    "select-background", "videobackgroundblur", "mute-everyone", "security", "whiteboard", "breakoutrooms",
    "livestreaming", "etherpad", "calendar", "closedcaptions", "profile", "feedback", "help", "speakerstats",
    "stats", "shortcuts", "download"]) {
    assert.ok(toolbar.includes(button), button);
  }
});

test("browser echo cancellation / noise suppression / AGC are left to Jitsi's defaults (no audio constraints)", () => {
  const jitsi = source("hooks", "useJitsi.ts");

  assert.doesNotMatch(jitsi, /disableAP|disableAEC|disableAGC|disableNS|disableHPF|echoCancellation|autoGainControl|audioQuality|krisp/i);
  assert.match(jitsi, /startWithAudioMuted: true,/);
});
