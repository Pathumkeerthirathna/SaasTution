/**
 * Phase 2: the meeting floats over a STUDENT's maximized whiteboard
 * (components/Jitsi/JitsiMeeting.tsx, JitsiClassroom.tsx, RightSidebar.tsx,
 * app/globals.css). The floating rule and the wrapper class are run
 * directly; the wiring, the layering and the untouched Jitsi connection are
 * checked from source.
 *
 * What a real browser shows (the iframe resizing without reloading, the
 * teacher's video / profile card in the window, phone layouts) remains a
 * manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { meetingWrapperClassName, shouldFloatMeeting } from "../../components/Jitsi/JitsiMeeting";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
// Active code only: JitsiMeeting.tsx keeps an older, commented-out copy of the component.
const activeSource = (...parts: string[]) => source(...parts).replace(/^\s*\/\/.*$/gm, "");

const studentMaximized = {
  role: "student" as const,
  whiteboardMaximized: true,
  isPhone: false,
  isShort: false,
  isFullscreen: false,
};

/* ------------------------------ floating rule ------------------------------ */

test("a student's maximized whiteboard floats the meeting", () => {
  assert.equal(shouldFloatMeeting(studentMaximized), true);
  assert.equal(shouldFloatMeeting({ ...studentMaximized, whiteboardMaximized: false }), false, "restored / closed");
});

test("a teacher's maximized whiteboard never floats the meeting", () => {
  assert.equal(shouldFloatMeeting({ ...studentMaximized, role: "teacher" }), false);
});

test("no floating window on phone layouts: portrait or short landscape", () => {
  assert.equal(shouldFloatMeeting({ ...studentMaximized, isPhone: true }), false, "portrait phone");
  assert.equal(shouldFloatMeeting({ ...studentMaximized, isShort: true }), false, "short landscape");
});

test("no floating while Jitsi is fullscreen (real or CSS fallback)", () => {
  assert.equal(shouldFloatMeeting({ ...studentMaximized, isFullscreen: true }), false);
});

/* ------------------------------ wrapper class ------------------------------ */

test("wrapper: normal, floating, fullscreen; fullscreen always wins", () => {
  assert.equal(meetingWrapperClassName({ isFullscreen: false, isFloating: false }), "relative h-full min-h-0 w-full");
  assert.equal(meetingWrapperClassName({ isFullscreen: false, isFloating: true }), "sl-meeting--float");
  const fullscreen = "fixed inset-0 z-[100] h-screen h-dvh w-screen bg-black";
  assert.equal(meetingWrapperClassName({ isFullscreen: true, isFloating: false }), fullscreen);
  assert.equal(meetingWrapperClassName({ isFullscreen: true, isFloating: true }), fullscreen);
});

test("layers: maximized whiteboard 90 < floating meeting 95 < Jitsi fullscreen 100", () => {
  const css = source("app", "globals.css");
  const panel = /\.sl-panel\.sl-panel--max \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const float = /\.sl-meeting--float \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  assert.match(panel, /z-index: 90;/);
  assert.match(float, /position: fixed;/);
  assert.match(float, /z-index: 95;/);
  assert.match(float, /width: clamp\(320px, 26vw, 420px\);/);
  assert.match(float, /aspect-ratio: 16 \/ 9;/);
  assert.match(float, /right: calc\(16px \+ env\(safe-area-inset-right\)\);/, "bottom-right");
  assert.match(meetingWrapperClassName({ isFullscreen: true, isFloating: true }), /z-\[100\]/);
});

/* ------------------------- wiring (local state only) ------------------------- */

test("RightSidebar reports its maximized state (restore / close / switch / fullscreen report false)", () => {
  const code = source("components", "Jitsi", "classroom", "sidebar", "RightSidebar.tsx");

  assert.match(code, /const isWhiteboardMaximized = whiteboardMaximized && isWhiteboardPanel;/, "closed or switched away: false");
  assert.match(code, /if \(!isWhiteboardPanel \|\| isFullscreenActive\) \{\s*setWhiteboardMaximized\(false\);/, "reset on close / switch / fullscreen");
  assert.match(code, /useEffect\(\(\) => \{\s*onWhiteboardMaximizedChange\?\.\(isWhiteboardMaximized\);\s*\}, \[isWhiteboardMaximized, onWhiteboardMaximizedChange\]\);/);
});

test("JitsiClassroom keeps the state locally and floats only via shouldFloatMeeting", () => {
  const code = source("components", "Jitsi", "JitsiClassroom.tsx");

  assert.match(code, /const \[whiteboardMaximized, setWhiteboardMaximized\] = useState\(false\);/);
  assert.match(code, /const floatMeeting = shouldFloatMeeting\(\{\s*role,\s*whiteboardMaximized,\s*isPhone: viewport\.isPhone,\s*isShort: viewport\.isShort,\s*isFullscreen: isFullscreenActive,\s*\}\);/);
  assert.match(code, /onWhiteboardMaximizedChange=\{setWhiteboardMaximized\}/);
  assert.match(code, /isFullscreen=\{isFullscreenActive\}\s*onExitFullscreen=\{handleExitFullscreen\}\s*isFloating=\{floatMeeting\}/);
});

/* ---------------------- the Jitsi connection is untouched ---------------------- */

test("floating only changes the existing wrapper's class; the iframe container stays where it is", () => {
  const code = activeSource("components", "Jitsi", "JitsiMeeting.tsx");

  assert.match(code, /ref=\{fullscreenWrapperRef\}\s*className=\{meetingWrapperClassName\(\{ isFullscreen, isFloating \}\)\}\s*>\s*<div\s*ref=\{containerRef\}\s*className="h-full min-h-0 w-full"\s*\/>/);
  assert.equal((code.match(/ref=\{containerRef\}/g) || []).length, 1, "one iframe container, never duplicated");
});

test("floating never reaches useJitsi, and the connection effect's dependencies are unchanged", () => {
  const meeting = activeSource("components", "Jitsi", "JitsiMeeting.tsx");
  const useJitsiCall = /\n  useJitsi\(\{([\s\S]*?)\n  \}\);/.exec(meeting)?.[1] ?? "";

  assert.ok(useJitsiCall.includes("isFullscreen"), "useJitsi call found");
  assert.doesNotMatch(useJitsiCall, /isFloating/);

  const hook = source("components", "Jitsi", "hooks", "useJitsi.ts");
  assert.doesNotMatch(hook, /isFloating|floatMeeting|whiteboardMaximized/);
  // The effect that creates JitsiMeetExternalAPI (connect / join / dispose).
  assert.match(
    hook,
    /\}, \[\s*containerRef,\s*isJitsiReady,\s*joinInfo,\s*role,\s*teacherName,\s*markJoined,\s*markLeft,\s*onParticipantsChanged,\s*\]\);/
  );
});
