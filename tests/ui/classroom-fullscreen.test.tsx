/**
 * Classroom fullscreen on phones (components/Jitsi/fullscreen.mjs,
 * JitsiClassroom.tsx, JitsiMeeting.tsx, MeetingCard.tsx, app/globals.css).
 *
 * The mobile header button used to set only the CSS fallback, so even
 * browsers with real element fullscreen (Android Chrome) kept their address
 * and navigation bars. Both buttons now request real fullscreen on the
 * meeting wrapper (navigationUI "hide") and fall back to the CSS mode only
 * where the API is unavailable (iPhone Safari) or the request is refused.
 *
 * The helpers run against fake documents / elements; the wiring, layout and
 * messages to the Jitsi iframe are checked from source. What a real phone
 * shows (which browser bars disappear) remains a manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  enterClassroomFullscreen,
  exitElementFullscreen,
  FULLSCREEN_CHANGE_EVENTS,
  getFullscreenElement,
  isFullscreenApiEnabled,
  requestElementFullscreen,
} from "../../components/Jitsi/fullscreen.mjs";
import { meetingWrapperClassName } from "../../components/Jitsi/JitsiMeeting";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
// Active code only: JitsiMeeting.tsx keeps an older, commented-out copy of the component.
const activeSource = (...parts: string[]) => source(...parts).replace(/^\s*\/\/.*$/gm, "");

type Listener = () => void;

// A document with the standard API (Android Chrome / desktop), the prefixed
// one (older Safari) or none (iPhone Safari: fullscreenEnabled false).
function fakeDocument(kind: "standard" | "webkit" | "none", { refuse = false } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const emit = (type: string) => (listeners.get(type) ?? new Set()).forEach((fn) => fn());
  const doc: Record<string, unknown> = {
    fullscreenElement: null,
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  };
  const requests: unknown[] = [];
  const element: Record<string, unknown> = { ownerDocument: doc };

  if (kind === "standard") {
    doc.fullscreenEnabled = true;
    element.requestFullscreen = (options: unknown) => {
      requests.push(options);

      if (refuse) {
        return Promise.reject(new TypeError("Permissions check failed"));
      }

      doc.fullscreenElement = element;
      emit("fullscreenchange");

      return Promise.resolve();
    };
    doc.exitFullscreen = () => {
      doc.fullscreenElement = null;
      emit("fullscreenchange");

      return Promise.resolve();
    };
  } else if (kind === "webkit") {
    doc.fullscreenEnabled = undefined;
    doc.fullscreenElement = undefined;
    doc.webkitFullscreenEnabled = true;
    doc.webkitFullscreenElement = null;
    element.webkitRequestFullscreen = () => {
      requests.push("webkit");
      // Answered later, with an event, like Safari.
      queueMicrotask(() => {
        if (refuse) {
          emit("webkitfullscreenerror");
        } else {
          doc.webkitFullscreenElement = element;
          emit("webkitfullscreenchange");
        }
      });
    };
    doc.webkitExitFullscreen = () => {
      doc.webkitFullscreenElement = null;
      emit("webkitfullscreenchange");
    };
  } else {
    doc.fullscreenEnabled = false;
  }

  return { doc: doc as unknown as Document, element: element as unknown as Element, requests, raw: doc };
}

const quiet = <T,>(fn: () => Promise<T>) => {
  const warn = console.warn;
  console.warn = () => {};

  return fn().finally(() => {
    console.warn = warn;
  });
};

/* ------------------------------ entering / exiting ------------------------------ */

test("Android Chrome / desktop: real fullscreen on the wrapper, navigation UI hidden, then exit", async () => {
  const { doc, element, requests } = fakeDocument("standard");

  assert.equal(isFullscreenApiEnabled(doc), true);
  assert.equal(await enterClassroomFullscreen(doc, () => requestElementFullscreen(element)), "native");
  assert.deepEqual(requests, [{ navigationUI: "hide" }]);
  assert.equal(getFullscreenElement(doc), element);

  await exitElementFullscreen(doc);
  assert.equal(getFullscreenElement(doc), null);
});

test("iPhone Safari (API unavailable): the CSS fallback, and nothing is requested", async () => {
  const { doc, element, requests } = fakeDocument("none");
  let called = false;

  assert.equal(isFullscreenApiEnabled(doc), false);
  assert.equal(await enterClassroomFullscreen(doc, () => {
    called = true;

    return requestElementFullscreen(element);
  }), "fallback");
  assert.equal(called, false);
  assert.deepEqual(requests, []);
  assert.equal(isFullscreenApiEnabled(undefined), false, "no document (server render)");
});

test("request refused or throwing, or no meeting yet: the CSS fallback, never an error", async () => {
  const refused = fakeDocument("standard", { refuse: true });

  assert.equal(await quiet(() => enterClassroomFullscreen(refused.doc, () => requestElementFullscreen(refused.element))), "fallback");
  assert.equal(getFullscreenElement(refused.doc), null);

  const { doc } = fakeDocument("standard");

  assert.equal(await enterClassroomFullscreen(doc, () => { throw new Error("boom"); }), "fallback");
  assert.equal(await enterClassroomFullscreen(doc, () => undefined), "fallback", "meeting not mounted");
  await assert.rejects(requestElementFullscreen(null), /not available/);
  await assert.rejects(requestElementFullscreen({} as Element), /not available/);
});

test("older Safari (prefixed API): request answered by event; refusal falls back; listeners cleaned up", async () => {
  const ok = fakeDocument("webkit");

  assert.equal(isFullscreenApiEnabled(ok.doc), true);
  assert.equal(await enterClassroomFullscreen(ok.doc, () => requestElementFullscreen(ok.element)), "native");
  assert.equal(getFullscreenElement(ok.doc), ok.element);
  assert.equal((ok.raw.listenerCount as (t: string) => number)("webkitfullscreenchange"), 0);
  await exitElementFullscreen(ok.doc);
  assert.equal(getFullscreenElement(ok.doc), null);

  const refused = fakeDocument("webkit", { refuse: true });

  assert.equal(await quiet(() => enterClassroomFullscreen(refused.doc, () => requestElementFullscreen(refused.element))), "fallback");
  assert.equal((refused.raw.listenerCount as (t: string) => number)("webkitfullscreenerror"), 0);
});

test("exit with nothing in fullscreen (the CSS fallback) is a no-op", async () => {
  const { doc } = fakeDocument("standard");
  let exited = false;

  (doc as unknown as Record<string, unknown>).exitFullscreen = () => {
    exited = true;

    return Promise.resolve();
  };
  await exitElementFullscreen(doc);
  assert.equal(exited, false);
});

test("both standard and prefixed change events are followed", () => {
  assert.deepEqual([...FULLSCREEN_CHANGE_EVENTS], ["fullscreenchange", "webkitfullscreenchange"]);
});

/* ------------------------------ classroom wiring ------------------------------ */

test("the mobile header button runs the same real-fullscreen handler as desktop (no CSS-only path)", () => {
  const code = source("components", "Jitsi", "JitsiClassroom.tsx");

  assert.match(code, /isMobile=\{viewport\.isTouchLayout\}\s*onEnterFullscreen=\{\(\) => void handleEnterFullscreen\(\)\}/);
  assert.doesNotMatch(code, /handleEnterCssFullscreen/);
  assert.match(code, /onClick=\{\(\) => void handleEnterFullscreen\(\)\}\s*aria-label="Enter fullscreen"/, "desktop button unchanged");
  assert.match(code, /const mode = await enterClassroomFullscreen\(\s*typeof document === "undefined" \? undefined : document,\s*\(\) => jitsiMeetingRef\.current\?\.requestFullscreen\(\)\s*\);\s*if \(mode === "fallback"\) \{\s*setIsCssFullscreenFallback\(true\);/);
});

test("fullscreen state: real changes (standard + prefixed) tracked; exit leaves both modes; Escape leaves the fallback", () => {
  const code = source("components", "Jitsi", "JitsiClassroom.tsx");

  assert.match(code, /const syncFullscreen = \(\) => setIsFullscreen\(Boolean\(getFullscreenElement\(document\)\)\);/);
  assert.match(code, /FULLSCREEN_CHANGE_EVENTS\.forEach\(\(type\) => document\.addEventListener\(type, syncFullscreen\)\);/);
  assert.match(code, /FULLSCREEN_CHANGE_EVENTS\.forEach\(\(type\) => document\.removeEventListener\(type, syncFullscreen\)\);/);
  assert.match(code, /const handleExitFullscreen = \(\) => \{\s*exitElementFullscreen\(document\)\.catch\([\s\S]*?\);\s*setIsCssFullscreenFallback\(false\);/);
  assert.match(code, /if \(!isCssFullscreenFallback\) \{\s*return;\s*\}[\s\S]{0,200}?if \(event\.key === "Escape"\) \{\s*setIsCssFullscreenFallback\(false\);[\s\S]{0,200}?document\.removeEventListener\("keydown", onKeyDown\);/, "listener only while the fallback is on, removed after");
  assert.match(code, /const isFullscreenActive = isFullscreen \|\| isCssFullscreenFallback;/);
});

test("the wrapper (not the iframe, not the whole page) is what goes fullscreen", () => {
  const meeting = activeSource("components", "Jitsi", "JitsiMeeting.tsx");

  assert.match(meeting, /requestFullscreen: \(\) =>\s*requestElementFullscreen\(fullscreenWrapperRef\.current\),/);
  assert.match(meeting, /ref=\{fullscreenWrapperRef\}\s*className=\{meetingWrapperClassName\(\{ isFullscreen, isFloating \}\)\}/);
  assert.doesNotMatch(meeting, /documentElement\.requestFullscreen/);
});

/* ------------------------------ layout ------------------------------ */

test("fullscreen wrapper: edge to edge, 100dvh with a 100vh fallback, safe-area padding, above everything", () => {
  const wrapper = meetingWrapperClassName({ isFullscreen: true, isFloating: false });

  assert.match(wrapper, /\bsl-meeting--fullscreen\b/);
  assert.match(wrapper, /\bfixed inset-0 z-\[100\]/);

  const css = source("app", "globals.css");
  const rule = /\n\.sl-meeting--fullscreen \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  assert.match(rule, /height: 100vh;\s*height: 100dvh;/, "dvh wins where supported");
  assert.match(rule, /padding: env\(safe-area-inset-top\) env\(safe-area-inset-right\) env\(safe-area-inset-bottom\) env\(safe-area-inset-left\);/);
  assert.ok(css.indexOf(".sl-meeting--fullscreen {") > css.indexOf("@tailwind utilities;"), "unlayered, after the utilities: wins over h-screen / h-dvh");
  assert.match(source("app", "session", "join", "page.tsx"), /viewportFit: "cover"/, "insets are only non-zero with viewport-fit=cover");
});

test("Exit fullscreen: always rendered while fullscreen, 12px inside the safe area (where custom.js keeps clear)", () => {
  const meeting = activeSource("components", "Jitsi", "JitsiMeeting.tsx");

  assert.match(meeting, /\{isFullscreen && \(\s*<button\s*type="button"\s*onClick=\{\(\) => onExitFullscreen\?\.\(\)\}\s*aria-label="Exit fullscreen"\s*className="absolute right-\[calc\(0\.75rem\+env\(safe-area-inset-right\)\)\] top-\[calc\(0\.75rem\+env\(safe-area-inset-top\)\)\] z-50 /);

  // custom.js positions the device status and the student self PiP clear of a
  // 36px button 12px from the iframe's top-right corner.
  const custom = source("deploy", "jitsi", "custom.js");

  assert.match(custom, /const SL_DS_FULLSCREEN_RIGHT = 12 \+ 36 \+ SL_DEVICE_STATUS_GAP;/);
  assert.match(custom, /const SL_SP_FULLSCREEN_TOP = 12 \+ 36 \+ SL_DEVICE_STATUS_GAP;/);
  assert.match(meeting, /h-9 w-9/, "36px button");
});

/* ------------------------------ Jitsi iframe messages ------------------------------ */

test("the iframe hears fullscreen (real or fallback) through SL_DEVICE_STATUS_VIEW, with a new epoch", () => {
  const classroom = source("components", "Jitsi", "JitsiClassroom.tsx");
  const meeting = activeSource("components", "Jitsi", "JitsiMeeting.tsx");
  const useJitsi = source("components", "Jitsi", "hooks", "useJitsi.ts");
  const useJitsiCall = /\n  useJitsi\(\{([\s\S]*?)\n  \}\);/.exec(meeting)?.[1] ?? "";

  assert.match(classroom, /isFullscreen=\{isFullscreenActive\}/, "both modes reach JitsiMeeting");
  assert.ok(useJitsiCall.includes("isFullscreen"));
  assert.match(useJitsi, /deviceStatusViewRef\.current = \{\s*\.\.\.current,\s*epoch: current\.epoch \+ 1,\s*fullscreen: isFullscreen,\s*\};\s*postDeviceStatusView\(\);/);
});

test("Jitsi's own fullscreen button stays off on mobile (one entry point per device class)", () => {
  const toolbar = source("components", "Jitsi", "constants", "toolbar.ts");

  assert.match(toolbar, /export const teacherToolbar = isMobile/);
});
