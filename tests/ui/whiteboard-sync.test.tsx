/**
 * Whiteboard late join / rejoin (components/whiteboard):
 *  - student: a scene that arrives while Excalidraw is still initializing is
 *    kept and applied once it is ready (Excalidraw's initialization would
 *    otherwise replace it with its empty initialData); readiness is polled,
 *    so React Strict Mode clearing Excalidraw's onChange listeners on its
 *    development unmount cannot leave the viewer waiting forever;
 *  - teacher: on (re)opening, the latest live scene is read once from the
 *    teacher stream before anything is broadcast, and the empty start is
 *    never broadcast over a live board; an intentional Clear still is.
 *
 * The helpers run with fake Excalidraw APIs / streams and mocked timers; how
 * the components use them is checked from source. A real browser run (the
 * classroom, the network) remains a manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { READY_POLL_MS, whenExcalidrawReady } from "../../components/whiteboard/LiveWhiteboardViewer";
import {
  LIVE_RESTORE_TIMING,
  readLatestLiveScene,
  type LiveSceneSource,
} from "../../components/whiteboard/WhiteboardEditor";
import type { WhiteboardScene } from "../../types/whiteboard";

const WHITEBOARD = path.join(__dirname, "..", "..", "components", "whiteboard");
const source = (file: string) => readFileSync(path.join(WHITEBOARD, file), "utf8").replace(/\r\n/g, "\n");

/* ------------------------------ fakes ------------------------------ */

// Excalidraw's API: isLoading until initialization is over, plus onChange
// listeners that its componentWillUnmount clears (onChangeEmitter.clear()).
function fakeExcalidraw(isLoading: boolean) {
  const listeners = new Set<() => void>();
  const api = {
    getAppState: () => ({ isLoading }) as ReturnType<Parameters<typeof whenExcalidrawReady>[0]["getAppState"]>,
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Parameters<typeof whenExcalidrawReady>[0];

  return {
    api,
    listeners,
    /** Strict Mode (development): mount, unmount (listeners cleared), mount again. */
    strictModeRemount() {
      listeners.clear();
    },
    finishLoading() {
      isLoading = false;
      [...listeners].forEach((listener) => listener());
    },
  };
}

function fakeStream() {
  const listeners: Record<string, ((event: MessageEvent<string>) => void)[]> = {};
  let closed = false;
  const stream = {
    addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => {
      (listeners[type] ||= []).push(listener);
    },
    close: () => {
      closed = true;
    },
  } as unknown as LiveSceneSource;

  return {
    stream,
    get closed() {
      return closed;
    },
    emit(type: "connected" | "scene", scene?: WhiteboardScene) {
      const data = JSON.stringify(type === "scene" ? { sessionId: "s1", seq: 1, scene, occurredAt: "" } : { sessionId: "s1" });
      (listeners[type] || []).forEach((listener) => listener({ data } as MessageEvent<string>));
    },
  };
}

const scene = (ids: string[]): WhiteboardScene => ({
  elements: ids.map((id) => ({ id, type: "rectangle", version: 1 }) as unknown as WhiteboardScene["elements"][number]),
});

/* ----------------------- student: early delivery ----------------------- */

test("student: nothing is applied while Excalidraw initializes; ready fires once, at the first poll after loading", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeExcalidraw(true);
  let ready = 0;

  whenExcalidrawReady(fake.api, () => ready++);
  assert.equal(ready, 0, "API handed out while loading: not ready yet");

  t.mock.timers.tick(READY_POLL_MS * 4);
  assert.equal(ready, 0, "still loading: keeps polling");

  fake.finishLoading();
  assert.equal(ready, 0, "readiness comes from polling isLoading, not from onChange");
  assert.equal(fake.listeners.size, 0, "no onChange listener is used");

  t.mock.timers.tick(READY_POLL_MS);
  assert.equal(ready, 1);

  t.mock.timers.tick(READY_POLL_MS * 10);
  assert.equal(ready, 1, "never twice; polling stopped");
});

test("student: an API that has already loaded is ready at once; cancel (unmount) stops the polling", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ready = 0;

  whenExcalidrawReady(fakeExcalidraw(false).api, () => ready++);
  assert.equal(ready, 1);

  const loading = fakeExcalidraw(true);
  const cancel = whenExcalidrawReady(loading.api, () => ready++);

  t.mock.timers.tick(READY_POLL_MS);
  cancel();
  loading.finishLoading();
  t.mock.timers.tick(READY_POLL_MS * 10);
  assert.equal(ready, 1, "cancelled before loading finished: no stale callback");
});

test("student (Strict Mode regression): readiness completes although the unmount cleared every onChange listener", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeExcalidraw(true);
  let ready = 0;

  // The API is handed out from Excalidraw's constructor, before any mount.
  whenExcalidrawReady(fake.api, () => ready++);

  // Development: mount -> componentWillUnmount (onChangeEmitter.clear()) -> mount.
  fake.strictModeRemount();
  t.mock.timers.tick(READY_POLL_MS);
  fake.finishLoading();
  t.mock.timers.tick(READY_POLL_MS);

  assert.equal(ready, 1, "the viewer gets its API, so pending and later scenes are applied");
});

test("student: a newer API instance replaces the older wait; only the newer one becomes ready", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Strict Mode constructs the class twice: onReady runs for each instance.
  const discarded = fakeExcalidraw(true);
  const kept = fakeExcalidraw(true);
  const readyFor: string[] = [];

  const cancelDiscarded = whenExcalidrawReady(discarded.api, () => readyFor.push("discarded"));
  cancelDiscarded(); // what the viewer's onReady does before waiting on the newer API
  whenExcalidrawReady(kept.api, () => readyFor.push("kept"));

  discarded.finishLoading();
  kept.finishLoading();
  t.mock.timers.tick(READY_POLL_MS * 3);

  assert.deepEqual(readyFor, ["kept"]);
});

test("student (late join): the viewer keeps early scenes pending and applies the newest once ready", () => {
  const code = source("LiveWhiteboardViewer.tsx");

  // applyScene parks a scene while there is no ready API (newest wins).
  assert.match(code, /if \(!api\) \{\s*pendingSceneRef\.current = scene;\s*return;\s*\}/);
  // onReady no longer sets apiRef directly: only once Excalidraw is ready.
  const onReady = /onReady=\{\(api: ExcalidrawImperativeAPI\) => \{([\s\S]*?)\n          \}\}/.exec(code)?.[1] ?? "";
  assert.match(onReady, /cancelReadyRef\.current = whenExcalidrawReady\(api, \(\) => \{\s*cancelReadyRef\.current = null;\s*apiRef\.current = api;\s*setApiReady\(true\);\s*if \(pendingSceneRef\.current\) \{/);
  assert.equal((onReady.match(/apiRef\.current = api/g) || []).length, 1, "apiRef is set only inside the ready callback");
  assert.match(onReady, /cancelReadyRef\.current\?\.\(\);\s*cancelReadyRef\.current = whenExcalidrawReady\(/, "a newer API cancels the older wait first");
  assert.match(code, /cancelReadyRef\.current\?\.\(\);\s*\},\s*\[\]\s*\);/, "a pending wait is cancelled on unmount");
  // The one-time fit keeps its cap; incoming scenes still touch only elements and background.
  assert.match(code, /api\.scrollToContent\(elements, FIT_OPTIONS\);/);
});

/* --------------------- teacher: read the live scene --------------------- */

test("teacher refresh: an existing live scene is read once, then the stream is closed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeStream();
  const results: (WhiteboardScene | null)[] = [];

  readLatestLiveScene(fake.stream, (live) => results.push(live));
  fake.emit("connected");
  fake.emit("scene", scene(["a", "b"]));
  assert.equal(results.length, 0, "waits briefly for the rest of the burst");

  t.mock.timers.tick(LIVE_RESTORE_TIMING.settleMs);
  assert.deepEqual(results.map((live) => live?.elements.map((element) => element.id)), [["a", "b"]]);
  assert.equal(fake.closed, true, "temporary stream closed");

  fake.emit("scene", scene(["late"]));
  assert.equal(results.length, 1, "nothing after it finished");
});

test("teacher refresh: the newest scene of the burst wins (a newer one is never replaced by an older)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeStream();
  let live: WhiteboardScene | null | undefined;

  readLatestLiveScene(fake.stream, (value) => (live = value));
  fake.emit("connected");
  fake.emit("scene", scene(["old"]));
  fake.emit("scene", scene(["old", "new"]));
  t.mock.timers.tick(LIVE_RESTORE_TIMING.settleMs);

  assert.deepEqual(live?.elements.map((element) => element.id), ["old", "new"]);
});

test("teacher, new session: no live scene after 'connected' means none (null); a dead stream times out", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const empty = fakeStream();
  const emptyResults: (WhiteboardScene | null)[] = [];
  readLatestLiveScene(empty.stream, (live) => emptyResults.push(live));
  empty.emit("connected");
  t.mock.timers.tick(LIVE_RESTORE_TIMING.graceMs);
  assert.deepEqual(emptyResults, [null]);
  assert.equal(empty.closed, true);

  const dead = fakeStream();
  const deadResults: (WhiteboardScene | null)[] = [];
  readLatestLiveScene(dead.stream, (live) => deadResults.push(live));
  t.mock.timers.tick(LIVE_RESTORE_TIMING.timeoutMs - 1);
  assert.deepEqual(deadResults, []);
  t.mock.timers.tick(1);
  assert.deepEqual(deadResults, [null]);
  assert.equal(dead.closed, true);
});

test("teacher: closing the editor while reading cancels it (stream closed, no callback)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeStream();
  let called = false;

  const cancel = readLatestLiveScene(fake.stream, () => (called = true));
  cancel();
  fake.emit("scene", scene(["a"]));
  t.mock.timers.tick(LIVE_RESTORE_TIMING.timeoutMs);

  assert.equal(fake.closed, true);
  assert.equal(called, false);
});

/* ------------------ teacher: what is (not) broadcast ------------------ */

test("teacher: no empty startup broadcast; nothing is sent until the live scene is read", () => {
  const code = source("WhiteboardEditor.tsx");

  assert.doesNotMatch(code, /Let students see the board as soon as the teacher opens it/);
  assert.match(code, /if \(!sessionId \|\| restorePendingRef\.current\) \{\s*return;\s*\}/, "flushBroadcast waits for the read");
  assert.match(code, /new EventSource\(`\/api\/sessions\/\$\{sessionId\}\/whiteboard\?role=teacher`\)/, "existing teacher-authorized stream");
  assert.match(code, /return readLatestLiveScene\(source, \(live\) => \{/, "the effect returns the cancel (closes the stream on unmount)");
});

test("teacher: restored board shown without re-broadcast; a change made meanwhile wins; empty start never sent", () => {
  const code = source("WhiteboardEditor.tsx");
  const decide = /return readLatestLiveScene\(source, \(live\) => \{([\s\S]*?)\n    \}\);/.exec(code)?.[1] ?? "";

  assert.match(decide, /restorePendingRef\.current = false;\s*if \(localChangeRef\.current\) \{[\s\S]*?void flushBroadcast\(\);\s*\} else if \(live && live\.elements\.length > 0\) \{\s*restoreLiveScene\(live\);\s*\} else if \(sceneRef\.current\.elements\.length > 0\) \{[\s\S]*?void flushBroadcast\(\);\s*\}/);

  const restore = /const restoreLiveScene = useCallback\(\(scene: WhiteboardScene\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(code)?.[1] ?? "";
  assert.match(restore, /loadedSignatureRef\.current = sceneSignature\(scene\);/);
  assert.doesNotMatch(restore, /Broadcast/, "the server already has it");

  // The canvas echo of what was loaded (empty start or restored board) is not a change.
  assert.match(code, /if \(loadedSignatureRef\.current !== null\) \{\s*if \(signature === loadedSignatureRef\.current\) \{\s*return;\s*\}\s*loadedSignatureRef\.current = null;\s*\}\s*localChangeRef\.current = true;\s*scheduleBroadcast\(\);/);
});

test("teacher: an intentional Clear, New board or opened saved board is always broadcast", () => {
  const code = source("WhiteboardEditor.tsx");

  assert.match(code, /loadedSignatureRef\.current = null;\s*apiRef\.current\?\.resetScene\(\);/, "Clear is never mistaken for the empty start");
  const loadBoard = /const loadBoard = useCallback\(([\s\S]*?)\n  \);/.exec(code)?.[1] ?? "";
  assert.match(loadBoard, /loadedSignatureRef\.current = null;\s*localChangeRef\.current = true;/);
  assert.match(loadBoard, /scheduleBroadcast\(\);/);
});
