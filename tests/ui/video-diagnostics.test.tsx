/*
 * UI tests: Video Diagnostics needs a confirmation before it starts, and
 * closing the teacher settings menu (gear, Escape, a click outside it)
 * turns it OFF.
 *
 *   npm run test:ui
 *
 * There is no DOM test library in this repository: the decisions live in
 * video-diagnostics-controls.mjs and are run here against a model of the
 * teacher page (JitsiClassroom's state and its Jitsi controls); the dialog and
 * switch are rendered to static HTML; the component wiring is checked in the
 * source. What custom.js does once diagnostics is off is covered by
 * tests/jitsi/video-telemetry.test.cjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import VideoDiagnosticsSection, {
  DiagnosticsConfirm,
} from "../../components/Jitsi/classroom/sidebar/VideoDiagnosticsSection";
import {
  closeSettings,
  diagnosticsSwitchStep,
  settingsKeyDown,
  toggleSettings,
  VIDEO_DIAGNOSTICS_CONFIRM,
} from "../../components/Jitsi/video-diagnostics-controls.mjs";

const JITSI = path.join(__dirname, "..", "..", "components", "Jitsi");
const source = (...parts: string[]) => readFileSync(path.join(JITSI, ...parts), "utf8").replace(/\r\n/g, "\n");

/*
 * The teacher page as the components wire it: JitsiClassroom owns
 * `diagnostics` (handleSetVideoDiagnostics -> Jitsi setVideoTelemetry);
 * SidebarNav owns `settingsOpen`; VideoDiagnosticsSection owns `confirming`
 * (reset when the menu closes, as the section unmounts).
 */
function teacherPage() {
  const page = {
    diagnostics: false,
    settingsOpen: false,
    confirming: false,
    // Every SL_VIDEO_TELEMETRY the page would send to the Jitsi iframe.
    telemetryMessages: [] as boolean[],
  };

  const setDiagnostics = (enabled: boolean) => {
    page.diagnostics = enabled;
    page.telemetryMessages.push(enabled);
  };
  const setSettingsOpen = (open: boolean) => {
    page.settingsOpen = open;

    if (!open) {
      page.confirming = false;
    }
  };
  const control = () => ({ diagnosticsOn: page.diagnostics, setSettingsOpen, setDiagnostics });
  const step = (action: "switch" | "confirm" | "cancel") => {
    const next = diagnosticsSwitchStep({ enabled: page.diagnostics, confirming: page.confirming }, action);

    page.confirming = next.confirming;

    if (next.toggle !== null) {
      setDiagnostics(next.toggle);
    }
  };

  return {
    page,
    gear: () => toggleSettings({ isOpen: page.settingsOpen, ...control() }),
    key: (key: string) => settingsKeyDown(key, control()),
    clickOutside: () => closeSettings(control()),
    switchDiagnostics: () => step("switch"),
    confirm: () => step("confirm"),
    cancel: () => step("cancel"),
    // The switch as the reopened menu renders it.
    renderedSwitch: () =>
      renderToStaticMarkup(
        <VideoDiagnosticsSection enabled={page.diagnostics} status={null} labelOf={(id) => id} onToggle={() => {}} />
      ),
  };
}

const switchState = (html: string) => /role="switch" aria-checked="(true|false)"/.exec(html)?.[1];

test("diagnostics starts OFF: the switch is off, no dialog, nothing measured or sent", () => {
  const t = teacherPage();

  t.gear();
  const html = t.renderedSwitch();

  assert.equal(t.page.diagnostics, false);
  assert.equal(switchState(html), "false");
  assert.ok(!html.includes('role="alertdialog"'));
  assert.ok(!html.includes('role="status"'), "no diagnostics block while off");
  assert.deepEqual(t.page.telemetryMessages, []);
  assert.match(source("JitsiClassroom.tsx"), /const \[videoDiagnostics, setVideoDiagnostics\] = useState\(false\);/);
});

test("turning it on asks first: only the confirmation opens, nothing is sent", () => {
  const t = teacherPage();

  t.gear();
  t.switchDiagnostics();

  assert.equal(t.page.confirming, true);
  assert.equal(t.page.diagnostics, false);
  assert.deepEqual(t.page.telemetryMessages, []);
});

test("Enable Diagnostics starts the existing flow, once", () => {
  const t = teacherPage();

  t.gear();
  t.switchDiagnostics();
  t.confirm();

  assert.equal(t.page.diagnostics, true);
  assert.equal(t.page.confirming, false);
  assert.deepEqual(t.page.telemetryMessages, [true]);

  // A stray second confirm does nothing.
  t.confirm();
  assert.deepEqual(t.page.telemetryMessages, [true]);
});

test("Cancel keeps diagnostics OFF and sends nothing (no request, no polling)", () => {
  const t = teacherPage();

  t.gear();
  t.switchDiagnostics();
  t.cancel();

  assert.equal(t.page.diagnostics, false);
  assert.equal(t.page.confirming, false);
  assert.deepEqual(t.page.telemetryMessages, []);
  assert.equal(switchState(t.renderedSwitch()), "false");
});

test("turning it off from the switch applies at once, without a dialog", () => {
  const t = teacherPage();

  t.gear();
  t.switchDiagnostics();
  t.confirm();
  t.switchDiagnostics();

  assert.equal(t.page.diagnostics, false);
  assert.equal(t.page.confirming, false);
  assert.deepEqual(t.page.telemetryMessages, [true, false]);
});

for (const [how, close] of [
  ["the gear button", (t: ReturnType<typeof teacherPage>) => t.gear()],
  ["Escape", (t: ReturnType<typeof teacherPage>) => assert.equal(t.key("Escape"), true)],
  ["a click outside the menu", (t: ReturnType<typeof teacherPage>) => t.clickOutside()],
] as const) {
  test(`closing settings with ${how} turns diagnostics OFF; reopening shows it OFF`, () => {
    const t = teacherPage();

    t.gear();
    t.switchDiagnostics();
    t.confirm();
    close(t);

    assert.equal(t.page.settingsOpen, false);
    assert.equal(t.page.diagnostics, false);
    assert.deepEqual(t.page.telemetryMessages, [true, false], "the existing stop message, once");

    t.gear();
    assert.equal(t.page.settingsOpen, true);
    assert.equal(switchState(t.renderedSwitch()), "false");
  });
}

test("closing while diagnostics is already off sends nothing (no duplicate stop message)", () => {
  const t = teacherPage();

  t.gear();
  t.gear();
  t.gear();
  t.key("Escape");
  t.gear();
  t.clickOutside();

  assert.deepEqual(t.page.telemetryMessages, []);
});

test("closing while the confirmation is open: it is dropped, diagnostics stays OFF", () => {
  const t = teacherPage();

  t.gear();
  t.switchDiagnostics();
  t.key("Escape");

  assert.equal(t.page.confirming, false);
  assert.equal(t.page.diagnostics, false);
  assert.deepEqual(t.page.telemetryMessages, []);
});

test("other keys do not close the menu or change diagnostics", () => {
  const t = teacherPage();

  t.gear();
  t.switchDiagnostics();
  t.confirm();

  for (const key of ["Enter", " ", "Tab", "e"]) {
    assert.equal(t.key(key), false);
  }

  assert.equal(t.page.settingsOpen, true);
  assert.equal(t.page.diagnostics, true);
  assert.deepEqual(t.page.telemetryMessages, [true]);
});

test("the confirmation: exact title, message and buttons; no claim that OFF uses no data", () => {
  const html = renderToStaticMarkup(<DiagnosticsConfirm onConfirm={() => {}} onCancel={() => {}} />);
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");

  assert.equal(VIDEO_DIAGNOSTICS_CONFIRM.title, "Enable Video Diagnostics?");
  assert.equal(
    VIDEO_DIAGNOSTICS_CONFIRM.message,
    "Video Diagnostics collects video connection statistics and exchanges small diagnostic reports with participants. " +
      "This uses a small amount of additional internet data. It does not enable extra video streams or increase video quality."
  );
  assert.match(html, /role="alertdialog"/);
  assert.ok(text.includes(VIDEO_DIAGNOSTICS_CONFIRM.title));
  assert.ok(text.includes(VIDEO_DIAGNOSTICS_CONFIRM.message));
  assert.deepEqual(Array.from(html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)).map((m) => m[1]), ["Cancel", "Enable Diagnostics"]);
  assert.doesNotMatch(text, /no (additional |extra )?data|zero data|uses no data/i);
});

test("wiring: every way of closing the menu goes through the shared close logic", () => {
  const nav = source("classroom", "sidebar", "SidebarNav.tsx");
  const section = source("classroom", "sidebar", "VideoDiagnosticsSection.tsx");

  // Gear, Escape and the click-catcher outside the menu.
  assert.match(nav, /onClick=\{\(\) => toggleSettings\(\{ isOpen: settingsOpenRef\.current, \.\.\.settingsControl\(\) \}\)\}/);
  assert.match(nav, /function onKeyDown\(event: KeyboardEvent\) \{\s*settingsKeyDown\(event\.key, settingsControl\(\)\);\s*\}/);
  assert.match(nav, /aria-label="Close"\s*onClick=\{closeSettingsMenu\}/);
  // No other path closes it directly, and the menu going away turns it off too.
  assert.doesNotMatch(nav, /setIsSettingsOpen\((false|\(prev\))/);
  assert.match(nav, /useEffect\(\(\) => \(\) => \{\s*if \(settingsOpenRef\.current && diagnosticsRef\.current\.on\) \{\s*diagnosticsRef\.current\.set\?\.\(false\);/);
  // The switch only starts diagnostics through the confirmation step.
  assert.match(section, /onClick=\{\(\) => step\("switch"\)\}/);
  assert.doesNotMatch(section, /onToggle\(!enabled\)/);
});

test("wiring: the existing on / off path to the Jitsi iframe is unchanged; no new network use", () => {
  const classroom = source("JitsiClassroom.tsx");
  const controls = source("video-diagnostics-controls.mjs");

  assert.match(classroom, /const handleSetVideoDiagnostics = useCallback\(\(enabled: boolean\) => \{[\s\S]*?jitsiMeetingRef\.current\?\.setVideoTelemetry\(enabled\);/);
  assert.match(classroom, /onSetVideoDiagnostics=\{role === "teacher" \? handleSetVideoDiagnostics : undefined\}/);
  assert.doesNotMatch(controls, /fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|setInterval|setTimeout|postMessage/);
});

test("unrelated settings are still in the menu (camera quality, Teaching Mode, bitrate, audio)", () => {
  const nav = source("classroom", "sidebar", "SidebarNav.tsx");

  for (const marker of [
    "VIDEO_QUALITY_OPTIONS.map",
    '<span className="block text-[#F8FAFC]">Teaching Mode</span>',
    ">Teaching Mode frame rate</p>",
    "{teacherBitrate ? <TeacherBitrateSection bitrate={teacherBitrate} /> : null}",
    "Noise Suppression",
  ]) {
    assert.ok(nav.includes(marker), marker);
  }
});
