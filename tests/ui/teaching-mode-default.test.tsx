/*
 * UI tests: Teaching Mode is ON by default for the teacher, and its on / off
 * switch is hidden while its settings stay in the settings menu.
 *
 *   npm run test:ui
 *
 * The settings menu opens on a click (no DOM test library here), so the
 * Camera section is checked in the source, and the message the page sends is
 * built with the real buildTeachingModeMessage. What custom.js does with
 * enabled: true is covered by tests/jitsi/teacher-teaching-mode.test.cjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildTeachingModeMessage,
  DEFAULT_TEACHING_FRAME_RATE,
  parseStoredBoolean,
  parseStoredFrameRate,
  TEACHING_FRAME_RATES,
} from "../../components/Jitsi/teacher-camera-preferences.mjs";

const JITSI = path.join(__dirname, "..", "..", "components", "Jitsi");
const source = (...parts: string[]) => readFileSync(path.join(JITSI, ...parts), "utf8").replace(/\r\n/g, "\n");

const classroom = () => source("JitsiClassroom.tsx");
const nav = () => source("classroom", "sidebar", "SidebarNav.tsx");

test("Teaching Mode starts ON: the React state and the settings ref both start enabled", () => {
  const code = classroom();

  assert.match(code, /const \[teachingMode, setTeachingMode\] = useState\(true\);/);
  assert.match(code, /const teachingSettingsRef = useRef<TeachingModeSettings>\(\{\s*enabled: true,\s*maxFps: teachingFps,\s*detailHint: teachingDetailHint,\s*\}\);/);
  assert.doesNotMatch(code, /useState\(false\);\s*const \[teachingFps/);
});

test("the saved frame rate and detail hint are still read from storage (unchanged)", () => {
  const code = classroom();

  assert.match(code, /useState<number>\(\(\) =>\s*parseStoredFrameRate\(readStorage\(TEACHING_FRAME_RATE_STORAGE_KEY\)\)\s*\)/);
  assert.match(code, /useState<boolean>\(\(\) =>\s*parseStoredBoolean\(readStorage\(TEACHING_DETAIL_HINT_STORAGE_KEY\), true\)\s*\)/);
});

test("the default settings sent on join are an enabled Teaching Mode message", () => {
  // What the page sends on a fresh load with nothing saved.
  const settings = { enabled: true, maxFps: parseStoredFrameRate(null), detailHint: parseStoredBoolean(null, true) };

  assert.deepEqual({ ...buildTeachingModeMessage(1, settings) }, {
    type: "SL_TEACHING_MODE", v: 1, epoch: 1, enabled: true, maxFps: DEFAULT_TEACHING_FRAME_RATE, detailHint: true,
  });
  assert.equal(DEFAULT_TEACHING_FRAME_RATE, 24);
});

test("the current settings still go out on every join and again when the iframe is ready", () => {
  const code = classroom();
  const jitsi = source("hooks", "useJitsi.ts");

  // Join: the teacher's current settings (the ref), every join.
  assert.match(code, /if \(role === "teacher"\) \{\s*jitsiMeetingRef\.current\?\.setTeachingMode\(teachingSettingsRef\.current\);/);
  // Changes: applyTeachingSettings / handleSetTeachingMode unchanged.
  assert.match(code, /const applyTeachingSettings = useCallback\(\(change: Partial<TeachingModeSettings>\) => \{[\s\S]*?jitsiMeetingRef\.current\?\.setTeachingMode\(next\);/);
  assert.match(code, /const handleSetTeachingMode = useCallback\(\(enabled: boolean\) => \{\s*applyTeachingSettings\(\{ enabled \}\);/);
  // Iframe ready: the kept message is resent (teacher only).
  assert.match(jitsi, /if \(event\.data\?\.type === "SL_RECEIVE_READY"\) \{[\s\S]*?postTeachingMode\(\);[\s\S]*?return;/);
  assert.match(jitsi, /const postTeachingMode = \(\) => \{\s*const message = teachingModeRef\.current;\s*if \(!message \|\| roleRef\.current !== "teacher"\) \{/);
});

test("the Teaching Mode on / off switch is hidden behind SHOW_TEACHING_MODE_TOGGLE = false", () => {
  const code = nav();
  const flag = code.indexOf("{SHOW_TEACHING_MODE_TOGGLE ? (");
  const switchButton = code.indexOf("onClick={() => onSetTeachingMode(!teachingMode)}");
  const hiddenEnd = code.indexOf(") : (\n                  // Toggle hidden: a plain label");

  assert.match(code, /const SHOW_TEACHING_MODE_TOGGLE = false;/);
  assert.ok(flag > 0 && switchButton > flag && hiddenEnd > switchButton, "the switch is only in the flagged branch");
  assert.equal(code.split("onSetTeachingMode(!teachingMode)").length - 1, 1, "no other switch");
  // In its place: a plain label, not a control.
  assert.match(code, /<div className="px-3 py-2 text-sm">\s*<span className="block text-\[#F8FAFC\]">Teaching Mode<\/span>\s*<span className="block text-\[10px\] text-\[#64748B\]">\s*On by default · Sharper handwriting and whiteboards/);
});

test("the Camera section stays: status, 15 / 24 / 30 fps, detail hint and bitrate, in order", () => {
  const code = nav();
  const at = (marker: string) => code.indexOf(marker);
  const positions = {
    section: at("{onSetTeachingMode ? ("),
    camera: at(">\n                  Camera\n"),
    label: at("On by default · Sharper handwriting and whiteboards"),
    status: at("{describeTeachingMode(teachingModeStatus)}"),
    frameRate: at(">Teaching Mode frame rate</p>"),
    fpsButtons: at("{TEACHING_FRAME_RATES.map((fps) => ("),
    fpsStatus: at("{describeFrameRateStatus(teachingModeStatus, teachingFps)}"),
    detailHint: at("onClick={() => onSetTeachingDetailHint(!teachingDetailHint)}"),
    bitrate: at("{teacherBitrate ? <TeacherBitrateSection bitrate={teacherBitrate} /> : null}"),
    audio: at(">\n              Audio\n"),
  };

  for (const [name, index] of Object.entries(positions)) {
    assert.ok(index > 0, `${name} not found`);
  }

  const order = Object.values(positions);

  assert.deepEqual([...order].sort((a, b) => a - b), order, "in this order, all inside the Camera section");
  assert.deepEqual(Array.from(TEACHING_FRAME_RATES), [15, 24, 30]);
  // The status lines show while Teaching Mode is on, which is now always.
  assert.match(code, /\{teachingMode \? \(\s*<p\s*role="status"[\s\S]*?\{describeTeachingMode\(teachingModeStatus\)\}/);
  assert.match(code, /\{teachingMode \? \(\s*<p role="status"[^>]*>\s*\{describeFrameRateStatus\(teachingModeStatus, teachingFps\)\}/);
  assert.match(code, /Applies to your camera in Teaching Mode \(on by default\)/);
  assert.doesNotMatch(code, /Applies while Teaching Mode is on/);
});

test("teacher only, and unrelated wiring unchanged", () => {
  const code = classroom();
  const sidebar = source("classroom", "sidebar", "RightSidebar.tsx");

  // The Camera section's gate stays teacher-only end to end.
  assert.match(code, /onSetTeachingMode=\{role === "teacher" \? handleSetTeachingMode : undefined\}/);
  assert.match(code, /onSetTeachingFps=\{role === "teacher" \? handleSetTeachingFps : undefined\}/);
  assert.match(code, /onSetTeachingDetailHint=\{role === "teacher" \? handleSetTeachingDetailHint : undefined\}/);
  assert.match(sidebar, /onSetTeachingMode=\{isTeacher \? props\.onSetTeachingMode : undefined\}/);
  assert.match(sidebar, /showSettings=\{isTeacher\}/);
  // Untouched: Camera Monitoring tab flag, bitrate wiring, diagnostics wiring.
  assert.match(sidebar, /const SHOW_CAMERA_MONITORING_TAB = false;/);
  assert.match(sidebar, /teacherBitrate=\{isTeacher \? props\.teacherBitrate : undefined\}/);
  assert.match(code, /onSetVideoDiagnostics=\{role === "teacher" \? handleSetVideoDiagnostics : undefined\}/);
});
