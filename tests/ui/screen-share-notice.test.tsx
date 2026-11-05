/**
 * Screen-sharing availability notice
 * (components/Jitsi/classroom/meeting/ScreenShareNotice.tsx, MeetingCard.tsx,
 * JitsiClassroom.tsx).
 *
 * Capability detection runs against fake navigators shaped like each browser;
 * the notice markup is rendered with react-dom/server; the dismissal and
 * per-session reset wiring is checked from source. What real phones, tablets
 * and desktop browsers show remains a manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import ScreenShareNotice, {
  canShareScreen,
  ScreenShareNoticeView,
  SCREEN_SHARE_NOTICE_MESSAGE,
} from "../../components/Jitsi/classroom/meeting/ScreenShareNotice";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const withApi = { mediaDevices: { getDisplayMedia: () => Promise.resolve() } };
const withoutApi = { mediaDevices: { getDisplayMedia: undefined, getUserMedia: () => Promise.resolve() } };

/* ----------------------------- capability detection ----------------------------- */

test("browsers with getDisplayMedia (desktop Chrome/Edge, capable tablets/phones): no notice", () => {
  assert.equal(canShareScreen(withApi), true);
});

test("browsers without getDisplayMedia (iPhone, iPad, most Android phones/tablets): notice", () => {
  assert.equal(canShareScreen(withoutApi), false);
  assert.equal(canShareScreen({ mediaDevices: {} }), false);
  assert.equal(canShareScreen({ mediaDevices: { getDisplayMedia: true } }), false);
});

test("no mediaDevices at all (insecure context, very old browser): notice", () => {
  assert.equal(canShareScreen({}), false);
  assert.equal(canShareScreen({ mediaDevices: null }), false);
  assert.equal(canShareScreen(null), false);
  assert.equal(canShareScreen(undefined), false);
});

test("detection uses only the API, never width, user agent or isMobile", () => {
  const notice = source("components", "Jitsi", "classroom", "meeting", "ScreenShareNotice.tsx");
  assert.match(notice, /typeof nav\?\.mediaDevices\?\.getDisplayMedia === "function"/);
  assert.doesNotMatch(notice, /userAgent|innerWidth|matchMedia|isMobile|isTouchLayout|isPhone/);
});

/* ----------------------------------- markup ----------------------------------- */

test("the notice: info icon, the message and a labelled close button", () => {
  const html = renderToStaticMarkup(<ScreenShareNoticeView onDismiss={() => {}} />);

  assert.ok(html.includes(SCREEN_SHARE_NOTICE_MESSAGE));
  assert.match(html, /lucide-info/);
  assert.match(html, /<button[^>]*aria-label="Dismiss screen sharing notice"/);
  assert.match(html, /role="note"/);
});

test("server render (capability not yet known) shows nothing, so supported browsers never flash it", () => {
  assert.equal(renderToStaticMarkup(<ScreenShareNotice />), "");
});

/* ------------------------------ dismissal and wiring ------------------------------ */

test("closing hides it via component state only (no storage)", () => {
  const notice = source("components", "Jitsi", "classroom", "meeting", "ScreenShareNotice.tsx");
  assert.match(notice, /onDismiss=\{\(\) => setDismissed\(true\)\}/);
  assert.match(notice, /if \(supported !== false \|\| dismissed\) \{\n\s*return null;/);
  assert.doesNotMatch(notice, /localStorage|sessionStorage|fetch\(/);
});

test("JitsiClassroom passes it to both roles, keyed by session so a new session resets it", () => {
  const classroom = source("components", "Jitsi", "JitsiClassroom.tsx");
  assert.match(classroom, /screenShareNotice=\{<ScreenShareNotice key=\{joinInfo\.session\.id\} \/>\}/);

  const line = classroom.split("\n").find((l) => l.includes("screenShareNotice="))!;
  assert.doesNotMatch(line, /role/);
});

test("MeetingCard renders it inline just before Fullscreen, outside the teacher-only block", () => {
  const card = source("components", "Jitsi", "classroom", "meeting", "MeetingCard.tsx");
  const notice = card.indexOf("{screenShareNotice}");
  const fullscreen = card.indexOf("{isMobile && (");
  const teacherBlockEnd = card.indexOf("{/* FULLSCREEN");

  assert.ok(notice > teacherBlockEnd, "after the teacher-only controls");
  assert.ok(notice < fullscreen, "immediately before the Fullscreen button");
  // Exactly one Fullscreen button and no Share Screen button of our own.
  assert.equal(card.match(/Fullscreen\n\s*<\/button>/g)?.length, 1);
  assert.doesNotMatch(card, /getDisplayMedia|Share Screen/i);
});
