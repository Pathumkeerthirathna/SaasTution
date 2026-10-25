/*
 * UI tests: the Teacher Video Bitrate selector in the teacher's settings menu
 * (SidebarNav, Camera section), rendered to static HTML (react-dom/server).
 *
 *   npm run test:ui
 *
 * The settings menu itself opens on a click, so the selector section is
 * rendered on its own and its place in the menu and the teacher-only wiring
 * are checked in the source. Clicks and the live camera are covered by
 * tests/jitsi/teacher-bitrate.test.cjs (custom.js) and the preference tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import CameraMonitoringPanel from "../../components/Jitsi/classroom/sidebar/CameraMonitoringPanel";
import {
  TeacherBitrateSection,
  type TeacherBitrateControl,
} from "../../components/Jitsi/classroom/sidebar/SidebarNav";
import type { CameraMonitoringController } from "../../components/Jitsi/hooks/useCameraMonitoring";

const HIGH_WARNING = "Uses more mobile data. Choose this option if your connection and data allowance can support it.";
const JITSI = path.join(__dirname, "..", "..", "components", "Jitsi");
const source = (...parts: string[]) => readFileSync(path.join(JITSI, ...parts), "utf8").replace(/\r\n/g, "\n");

function control(extra: Partial<TeacherBitrateControl> = {}): TeacherBitrateControl {
  return { value: 1500000, status: null, onChange() {}, ...extra };
}

function monitoring(): CameraMonitoringController {
  return {
    mode: "normal",
    setMode() {},
    pageSize: 10,
    pageSizeOptions: [10, 20],
    setPageSize() {},
    page: 0,
    pageCount: 0,
    canGoPrevious: false,
    canGoNext: false,
    goToPreviousPage() {},
    goToNextPage() {},
    presentStudents: [],
    pageStudents: [],
    pageRangeStart: 0,
    pageRangeEnd: 0,
    activeStudentIds: [],
    activeParticipantIds: [],
  };
}

// The text of each option button, in order.
function options(html: string): string[] {
  return Array.from(html.matchAll(/<button[^>]*role="radio"[^>]*>([\s\S]*?)<\/button>/g))
    .map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

test("all four options with their caps; Standard+ marked Recommended", () => {
  const html = renderToStaticMarkup(<TeacherBitrateSection bitrate={control()} />);

  assert.match(html, /Teacher Video Bitrate/);
  assert.deepEqual(options(html), [
    "Low 500 kbps Lower data usage",
    "Standard 1 Mbps Balanced option for saving data",
    "Standard+ — Recommended 1.5 Mbps Good video detail for teaching",
    `High 2.5 Mbps Higher potential video quality ${HIGH_WARNING}`,
  ]);
});

test("Standard+ (1.5 Mbps) is the selected option by default; exactly one is checked", () => {
  const html = renderToStaticMarkup(<TeacherBitrateSection bitrate={control()} />);
  const checked = Array.from(html.matchAll(/aria-checked="true"[^>]*data-bitrate="(\d+)"/g)).map((match) => match[1]);

  assert.deepEqual(checked, ["1500000"]);
});

test("the High data-usage warning is shown (whichever option is selected)", () => {
  for (const value of [500000, 1500000, 2500000]) {
    const html = renderToStaticMarkup(<TeacherBitrateSection bitrate={control({ value })} />);

    assert.ok(html.includes(HIGH_WARNING), String(value));
  }
});

test("explains caps vs actual use, and the live status line", () => {
  const pending = renderToStaticMarkup(<TeacherBitrateSection bitrate={control()} />);
  const applied = renderToStaticMarkup(
    <TeacherBitrateSection
      bitrate={control({ status: { maxBitrate: 1500000, state: "applied", topMaxBitrate: 1500000, codec: "av1" } })}
    />
  );

  assert.match(pending, /maximum caps for your camera&#x27;s main video layer/);
  assert.match(pending, /Actual quality and data\s+use depend on your network/);
  assert.match(pending, /role="status"[^>]*>1\.5 Mbps cap is used from the next time you join\./);
  assert.match(applied, /role="status"[^>]*>Applied to your camera \(AV1\): up to 1\.5 Mbps\./);
});

test("settings menu: the selector sits in the teacher-only Camera section, below Teaching Mode and its frame rate", () => {
  const nav = source("classroom", "sidebar", "SidebarNav.tsx");
  const camera = nav.indexOf(">\n                  Camera\n");
  const teachingMode = nav.indexOf('<span className="block text-[#F8FAFC]">Teaching Mode</span>');
  const frameRate = nav.indexOf(">Teaching Mode frame rate</p>");
  const detailHint = nav.indexOf(">Detail hint</span>");
  const selector = nav.indexOf("{teacherBitrate ? <TeacherBitrateSection bitrate={teacherBitrate} /> : null}");
  const audio = nav.indexOf(">\n              Audio\n");

  for (const [name, index] of Object.entries({ camera, teachingMode, frameRate, detailHint, selector, audio })) {
    assert.ok(index > 0, `${name} not found`);
  }

  assert.ok(camera < teachingMode && teachingMode < frameRate && frameRate < detailHint && detailHint < selector,
    "after Teaching Mode, its frame rate and detail hint");
  assert.ok(selector < audio, "still inside the Camera section, before Audio");
  // The Camera section is only rendered for the teacher (onSetTeachingMode is teacher-only).
  assert.match(nav.slice(camera - 400, camera), /\{onSetTeachingMode \? \(/);
});

test("teacher-only wiring: the selector reaches SidebarNav only for the teacher role", () => {
  const classroom = source("JitsiClassroom.tsx");
  const sidebar = source("classroom", "sidebar", "RightSidebar.tsx");

  assert.match(classroom, /teacherBitrate=\{role === "teacher"\s*\?/);
  assert.match(classroom, /onTeacherBitrateStatus=\{role === "teacher" \? setTeacherBitrateStatus : undefined\}/);
  assert.match(sidebar, /teacherBitrate=\{isTeacher \? props\.teacherBitrate : undefined\}/);
  assert.match(sidebar, /onSetTeachingMode=\{isTeacher \? props\.onSetTeachingMode : undefined\}/);
});

test("not duplicated: the Camera Monitoring panel no longer has the selector", () => {
  const html = renderToStaticMarkup(<CameraMonitoringPanel monitoring={monitoring()} />);
  const panel = source("classroom", "sidebar", "CameraMonitoringPanel.tsx");
  const sidebar = source("classroom", "sidebar", "RightSidebar.tsx");

  assert.ok(!html.includes("Teacher Video Bitrate"));
  assert.ok(!/bitrate/i.test(panel));
  assert.match(sidebar, /<CameraMonitoringPanel monitoring=\{props\.cameraMonitoring\} \/>/);
  // The rest of the panel is unchanged.
  assert.match(html, /Exam Mode/);
  assert.match(html, /Students per page/);
  assert.match(html, /Receiving/);
});

test("the bitrate change leaves codec choice, capture, FPS and simulcast settings in useJitsi as they were", () => {
  const jitsi = source("hooks", "useJitsi.ts");

  assert.match(jitsi, /resolution: 720,/);
  // Capture constraints: height only (no frame-rate or width constraint added).
  assert.match(jitsi, /constraints: \{\s*video: \{\s*height: \{\s*ideal: 720,\s*max: 1080,\s*min: 240,\s*\},\s*\},\s*\},/);
  assert.match(jitsi, /disableSimulcast: false,/);
  assert.match(jitsi, /p2p: \{\s*enabled: false,\s*\}/);
  assert.doesNotMatch(jitsi, /codecPreferenceOrder|preferredCodec|disabledCodec/);
  // Only the dotted per-codec keys come from the bitrate helper.
  assert.match(jitsi, /\.\.\.buildTeacherBitrateConfig\(\s*role,\s*parseStoredTeacherBitrate\(readStorage\(TEACHER_BITRATE_STORAGE_KEY\)\)\s*\)/);
});

test("camera quality: the settings menu offers only the shared list (720p highest), no hard-coded 1080p", () => {
  const nav = source("classroom", "sidebar", "SidebarNav.tsx");

  assert.match(nav, /TEACHER_VIDEO_QUALITY_HEIGHTS\.map\(\(height\) => \(\{ label: `\$\{height\}p`, height \}\)\)/);
  assert.match(nav, /readStoredVideoQuality\(\) \?\? DEFAULT_TEACHER_VIDEO_QUALITY/);
  assert.doesNotMatch(nav, /1080/);
});

test("landing page: video quality is described as up to 720p", () => {
  const landing = readFileSync(path.join(__dirname, "..", "..", "components", "LandingPage", "live-classroom.tsx"), "utf8");

  assert.doesNotMatch(landing, /1080p/);
  assert.equal((landing.match(/up to 720p/g) || []).length, 2);
});
