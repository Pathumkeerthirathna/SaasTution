/**
 * Student whiteboard zoom (components/whiteboard/LiveWhiteboardViewer.tsx):
 * the one-time fit never zooms in past 100%, and the student's own zoom
 * controls (shown while Excalidraw 0.18.1 hides its built-in ones) follow
 * Excalidraw's own rules. Helpers are run directly; the controls are
 * rendered to static HTML (react-dom/server); what the viewer does with
 * incoming scenes is checked from source.
 *
 * These do not run Excalidraw itself: what a real browser shows (the mobile
 * layout switch, pinch, pointer positions) is a manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FIT_OPTIONS,
  MAX_ZOOM,
  MIN_ZOOM,
  StudentZoomControls,
  ZOOM_STEP,
  isExcalidrawMobileLayout,
  normalizeZoom,
  zoomAroundCenter,
} from "../../components/whiteboard/LiveWhiteboardViewer";

const VIEWER = path.join(__dirname, "..", "..", "components", "whiteboard", "LiveWhiteboardViewer.tsx");
const source = () => readFileSync(VIEWER, "utf8").replace(/\r\n/g, "\n");

const noop = () => {};

test("the fit (first drawing and the Fit button) never zooms in past 100%", () => {
  assert.deepEqual(FIT_OPTIONS, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1 });
  assert.match(source(), /api\.scrollToContent\(elements, FIT_OPTIONS\);/);
});

test("own controls show exactly where Excalidraw hides its zoom buttons (isMobileBreakpoint)", () => {
  assert.equal(isExcalidrawMobileLayout(729, 900), true);
  assert.equal(isExcalidrawMobileLayout(730, 900), false);
  assert.equal(isExcalidrawMobileLayout(999, 499), true, "short and below 1000 wide");
  assert.equal(isExcalidrawMobileLayout(1000, 499), false);
  assert.equal(isExcalidrawMobileLayout(882, 608), false, "the desktop panel keeps Excalidraw's own controls");
});

test("zoom steps and limits match Excalidraw (0.1 step, 10% to 3000%, 6 decimals)", () => {
  assert.equal(ZOOM_STEP, 0.1);
  assert.equal(normalizeZoom(1.1 + ZOOM_STEP), 1.2);
  assert.equal(normalizeZoom(0.05), MIN_ZOOM);
  assert.equal(normalizeZoom(31), MAX_ZOOM);
});

test("zooming keeps the canvas centre on the same point of the drawing", () => {
  const view = { zoom: 1.1, scrollX: 51, scrollY: 126, width: 882, height: 608 };
  const next = zoomAroundCenter(view, 1.2);
  // Scene point under the centre: viewport / zoom - scroll.
  const before = { x: view.width / 2 / view.zoom - view.scrollX, y: view.height / 2 / view.zoom - view.scrollY };
  const after = { x: view.width / 2 / next.zoom - next.scrollX, y: view.height / 2 / next.zoom - next.scrollY };

  assert.equal(next.zoom, 1.2);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomAroundCenter(view, 0).zoom, MIN_ZOOM, "clamped like Excalidraw");
});

test("controls: labelled buttons, current percentage, limits disable the matching button", () => {
  const html = renderToStaticMarkup(
    <StudentZoomControls zoom={1.1} canFit onZoomOut={noop} onReset={noop} onZoomIn={noop} onFit={noop} />
  );

  assert.match(html, /role="group" aria-label="Whiteboard zoom"/);
  assert.match(html, /aria-label="Zoom out"/);
  assert.match(html, /aria-label="Reset zoom to 100% \(now 110%\)"/);
  assert.match(html, />110%</);
  assert.match(html, /aria-label="Zoom in"/);
  assert.match(html, /aria-label="Fit drawing to screen"/);
  assert.doesNotMatch(html, /disabled=""/);

  const atMin = renderToStaticMarkup(
    <StudentZoomControls zoom={MIN_ZOOM} canFit={false} onZoomOut={noop} onReset={noop} onZoomIn={noop} onFit={noop} />
  );

  assert.match(atMin, /<button type="button" disabled="" aria-label="Zoom out"/);
  assert.match(atMin, /<button type="button" disabled="" aria-label="Fit drawing to screen"/);
  assert.doesNotMatch(atMin, /disabled="" aria-label="Zoom in"/);
});

test("incoming teacher scenes never touch the student's zoom or scroll; nothing is sent back", () => {
  const code = source();
  const applyScene = (/const applyScene = useCallback\(\(scene: WhiteboardScene\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(code)?.[1] ?? "")
    .replace(/\/\/.*$/gm, "");

  assert.ok(applyScene.includes("api.updateScene("), "applyScene found");

  assert.match(applyScene, /api\.updateScene\(\{\s*elements,\s*appState: \{ viewBackgroundColor: scene\.viewBackgroundColor \?\? "#ffffff" \},\s*\}\);/);
  assert.doesNotMatch(applyScene, /zoom|scrollX|scrollY/);
  // The viewer only reads: the live stream (GET) and the saved list (GET).
  assert.doesNotMatch(code, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
});
