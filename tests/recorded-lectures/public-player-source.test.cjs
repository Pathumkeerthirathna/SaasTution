/*
 * Public recorded-lecture player (components/teacherProfile/classLanding/
 * UploadedRecordings.tsx, UploadedRecordingPlayer): source checks of the
 * media element's lifecycle (the repository has no DOM renderer; the
 * behaviour is verified for real in the browser).
 *
 *   node --test tests/recorded-lectures/public-player-source.test.cjs
 *
 * React Strict Mode (development, next.config.mjs reactStrictMode) runs an
 * effect, its cleanup and the effect again on mount. The cleanup empties the
 * <video> (to stop the download and release the stream slot), so the effect
 * must give the element back its source, as the student player does
 * (recording-player.tsx); otherwise the player stays black at 0:00 and makes
 * no request.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

const source = stripComments(fs.readFileSync(path.join(root, "components", "teacherProfile", "classLanding", "UploadedRecordings.tsx"), "utf8"));
const player = source.slice(source.indexOf("export function UploadedRecordingPlayer"), source.indexOf("export function LockedRecordingPrompt"));

// The player's one media-lifecycle effect: its setup (before `return () =>`) and its cleanup.
const effectStart = player.indexOf("useEffect(() => {\n    const video = videoRef.current;");
const effect = player.slice(effectStart, player.indexOf("}, [", effectStart));
const returnAt = effect.indexOf("return () => {");
const setup = effect.slice(0, returnAt);
const cleanup = effect.slice(returnAt);

/** Asserts the patterns occur in this order in `text`. */
function inOrder(text, patterns, label) {
  let from = 0;
  for (const pattern of patterns) {
    const at = text.indexOf(pattern, from);
    assert.ok(at >= 0, `${label}: "${pattern}" (in order)`);
    from = at + pattern.length;
  }
}

test("the player and its media effect are found (one <video>, streaming the recording's public streamUrl)", () => {
  assert.ok(player.length > 0, "UploadedRecordingPlayer");
  assert.ok(effectStart >= 0 && returnAt > 0, "the effect with a cleanup");
  assert.equal((player.match(/<video\b/g) ?? []).length, 1);
  assert.match(player, /src=\{recording\.streamUrl\}/);
});

test("Strict Mode: the effect restores a missing source from recording.streamUrl, then calls load()", () => {
  inOrder(setup, ['video && !video.getAttribute("src")', 'video.setAttribute("src", recording.streamUrl)', "video.load()"], "effect setup");
  assert.doesNotMatch(setup, /removeAttribute|\.pause\(\)/, "the setup never empties the element");
});

test("closing: the cleanup still pauses, removes the src and calls load() (download stopped, stream slot released)", () => {
  inOrder(cleanup, ["video.pause()", 'video.removeAttribute("src")', "video.load()"], "effect cleanup");
  assert.doesNotMatch(cleanup, /setAttribute\("src"/, "the cleanup never restores the source");
});
