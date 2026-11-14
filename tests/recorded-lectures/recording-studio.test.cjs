/*
 * Recorded Lectures, Recording Studio: the state machine
 * (studio-controller.ts) with fake media devices / recorder / storage, and
 * the pure helpers (format choice, browser support, permission messages,
 * the pause-aware clock, recovery trimming, file fingerprints).
 *
 * Real camera, microphone, screen sharing and MediaRecorder output are NOT
 * exercised here: they need the pending real-browser testing.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const C = require(path.join(root, "components", "recorded-lectures", "studio-controller.ts"));
const S = require(path.join(root, "components", "recorded-lectures", "studio-helpers.ts"));
const Store = require(path.join(root, "components", "recorded-lectures", "recording-store.ts"));
const { fragmentedRecording } = require("./helpers/fragmented-mp4.cjs");

const MP4 = "video/mp4;codecs=avc1.42E01F,mp4a.40.2";

// ---- Fakes ---------------------------------------------------------------------------------------------

function track(kind) {
  return { kind, stopped: false, onended: null, stop() { this.stopped = true; } };
}
function stream(tracks) {
  return {
    tracks,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  };
}
const domError = (name) => Object.assign(new Error(name), { name });

/** A fake MediaRecorder that emits the given bytes as timeslices on stop (and one slice on demand). */
function fakeRecorderFactory(bytes, { sliceSize = 64 * 1024 } = {}) {
  const made = [];
  const create = (s, mimeType) => {
    const rec = {
      mimeType,
      state: "inactive",
      calls: [],
      ondataavailable: null,
      onstop: null,
      onerror: null,
      start(timeslice) { this.state = "recording"; this.calls.push(["start", timeslice]); },
      pause() { this.state = "paused"; this.calls.push(["pause"]); },
      resume() { this.state = "recording"; this.calls.push(["resume"]); },
      stop() {
        this.calls.push(["stop"]);
        this.state = "inactive";
        for (let at = 0; at < bytes.length; at += sliceSize) this.ondataavailable?.({ data: new Blob([bytes.subarray(at, Math.min(bytes.length, at + sliceSize))]) });
        setImmediate(() => this.onstop?.());
      },
    };
    made.push(rec);
    return rec;
  };
  return { create, made };
}

function controller(options = {}) {
  let clock = 1_000;
  const states = [];
  const store = options.store ?? Store.createMemoryStore();
  const recorder = fakeRecorderFactory(options.bytes ?? fragmentedRecording({ fragments: 30, mediaBytes: 4096 }));
  const sources = { camera: null, screen: null, mic: null };
  const deps = {
    teacherId: "t1",
    lectureId: "l1",
    mimeType: MP4,
    store,
    getUserMedia: async (constraints) => {
      if (options.userMediaError) {
        const error = options.userMediaError(constraints);
        if (error) throw error;
      }
      const tracks = [];
      if (constraints.video) tracks.push(track("video"));
      if (constraints.audio) tracks.push(track("audio"));
      const s = stream(tracks);
      if (constraints.video) sources.camera = s;
      else sources.mic = s;
      return s;
    },
    getDisplayMedia: options.noDisplayMedia
      ? undefined
      : async () => {
          if (options.displayError) throw options.displayError;
          sources.screen = stream([track("video")]);
          return sources.screen;
        },
    createSilentAudioTrack: () => (options.noSilent ? null : { track: track("audio"), close() { sources.silentClosed = true; } }),
    combine: (tracks) => stream(tracks),
    createRecorder: (s, mime) => {
      if (options.recorderError) throw options.recorderError;
      return recorder.create(s, mime);
    },
    now: () => clock,
    newId: () => "rec-1",
    maxMoovBytes: 64 * 1024 * 1024,
    onChange: (s) => states.push(s.kind),
  };
  const c = new C.StudioController(deps);
  return { c, states, store, recorder, sources, advance: (ms) => (clock += ms) };
}

// ---- Devices and permissions ------------------------------------------------------------------------------

test("camera + microphone: one getUserMedia, a video and an audio track, ready for preview", async () => {
  const { c, states, sources } = controller();
  await c.prepare({ mode: "camera-mic" });
  assert.equal(c.state.kind, "ready");
  assert.deepEqual(states, ["requesting", "ready"]);
  assert.deepEqual(c.liveStream.getTracks().map((t) => t.kind).sort(), ["audio", "video"]);
  assert.ok(sources.camera);
});

test("camera permission denied: a clear, retryable error; nothing left running", async () => {
  const { c } = controller({ userMediaError: () => domError("NotAllowedError") });
  await c.prepare({ mode: "camera-mic" });
  assert.equal(c.state.kind, "error");
  assert.equal(c.state.failure.code, "PERMISSION_DENIED");
  assert.match(c.state.failure.message, /denied/);
  assert.equal(c.liveStream, null);
});

test("microphone permission denied in screen mode: the screen share is stopped again", async () => {
  const { c, sources } = controller({ userMediaError: (k) => (k.audio ? domError("NotAllowedError") : null) });
  await c.prepare({ mode: "screen-mic" });
  assert.equal(c.state.kind, "error");
  assert.equal(c.state.failure.code, "PERMISSION_DENIED");
  assert.match(c.state.failure.message, /microphone/);
  assert.ok(sources.screen.getTracks().every((t) => t.stopped), "screen track released");
});

test("screen sharing cancelled by the teacher: its own message", async () => {
  const { c } = controller({ displayError: domError("NotAllowedError") });
  await c.prepare({ mode: "screen-mic" });
  assert.equal(c.state.failure.code, "SCREEN_SHARE_CANCELLED");
  assert.match(c.state.failure.message, /cancelled/);
});

test("screen mode without getDisplayMedia (phones): not supported, no device asked", async () => {
  const { c, sources } = controller({ noDisplayMedia: true });
  await c.prepare({ mode: "screen-mic" });
  assert.equal(c.state.failure.code, "NOT_SUPPORTED");
  assert.equal(sources.mic, null);
});

test("device errors: missing and busy devices", async () => {
  for (const [name, code] of [["NotFoundError", "DEVICE_NOT_FOUND"], ["NotReadableError", "DEVICE_BUSY"], ["OverconstrainedError", "DEVICE_NOT_FOUND"], ["Weird", "MEDIA_ERROR"]]) {
    const { c } = controller({ userMediaError: () => domError(name) });
    await c.prepare({ mode: "camera-mic" });
    assert.equal(c.state.failure.code, code, name);
  }
});

test("camera only: a silent audio track is added (the server requires AAC audio)", async () => {
  const { c } = controller();
  await c.prepare({ mode: "camera-only" });
  assert.equal(c.state.kind, "ready");
  assert.deepEqual(c.liveStream.getTracks().map((t) => t.kind).sort(), ["audio", "video"]);
  const { c: noSilent } = controller({ noSilent: true });
  await noSilent.prepare({ mode: "camera-only" });
  assert.equal(noSilent.state.failure.code, "NOT_SUPPORTED");
});

test("selected camera and microphone are requested exactly", async () => {
  const seen = [];
  const { c } = controller({ userMediaError: (constraints) => { seen.push(constraints); return null; } });
  await c.prepare({ mode: "camera-mic", cameraId: "cam-2", microphoneId: "mic-3" });
  assert.equal(c.state.kind, "ready");
  assert.deepEqual(seen[0], { video: { deviceId: { exact: "cam-2" } }, audio: { deviceId: { exact: "mic-3" } } });
});

// ---- Recording ------------------------------------------------------------------------------------------

test("start / pause / resume / stop: the recorder follows, the clock excludes paused time, chunks are stored", async () => {
  const { c, recorder, store, advance } = controller();
  await c.prepare({ mode: "camera-mic" });
  await c.start();
  assert.equal(c.state.kind, "recording");
  assert.deepEqual(recorder.made[0].calls[0], ["start", C.RECORDER_TIMESLICE_MS]);
  assert.equal(recorder.made[0].mimeType, MP4);
  assert.equal((await store.getRecording("rec-1")).status, "recording", "stored before any data");
  advance(10_000);
  c.pause();
  assert.equal(c.state.kind, "paused");
  advance(60_000); // paused time does not count
  assert.equal(c.elapsedMs(), 10_000);
  c.resume();
  assert.equal(c.state.kind, "recording");
  advance(5_000);
  assert.equal(c.elapsedMs(), 15_000);
  await c.stop();
  assert.equal(c.state.kind, "review");
  assert.equal(c.state.durationMs, 15_000);
  assert.equal(c.state.check.ok, true, JSON.stringify(c.state.check));
  assert.equal(c.state.check.durationSeconds, 30);
  assert.equal(c.state.notice, null);
  const local = await store.getRecording("rec-1");
  assert.equal(local.status, "stopped");
  assert.deepEqual(recorder.made[0].calls.map((x) => x[0]), ["start", "pause", "resume", "stop"]);
  assert.equal(c.liveStream, null, "camera and microphone released after stopping");
});

test("nothing is uploaded by the studio: it only stores and reviews (the page uploads after confirmation)", async () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(root, "components", "recorded-lectures", "studio-controller.ts"), "utf8");
  assert.doesNotMatch(src, /fetch\(|RecordingUploader|uploadLocalRecording/);
});

test("preview check: a recording the server would reject (no audio / unknown duration) is flagged before upload", async () => {
  const F = require("./helpers/mp4-fixtures.cjs");
  const noAudio = Buffer.from(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack()] }) }));
  const { c } = controller({ bytes: noAudio });
  await c.prepare({ mode: "camera-mic" });
  await c.start();
  await c.stop();
  assert.equal(c.state.check.ok, false);
  assert.match(c.state.check.message, /MP4 with H\.264 video and AAC audio/);
  const unknown = fragmentedRecording({ fragments: 5, omitTfdt: true });
  const { c: c2 } = controller({ bytes: unknown });
  await c2.prepare({ mode: "camera-mic" });
  await c2.start();
  await c2.stop();
  assert.equal(c2.state.check.ok, false);
  assert.match(c2.state.check.message, /length could not be read/);
});

test("stop waits for every chunk to be stored before the review (slow storage)", async () => {
  const store = Store.createMemoryStore();
  const realAppend = store.appendChunk;
  store.appendChunk = async (...args) => {
    await new Promise((r) => setTimeout(r, 5));
    return realAppend(...args);
  };
  const bytes = fragmentedRecording({ fragments: 40, mediaBytes: 8192 });
  const { c } = controller({ store, bytes });
  await c.prepare({ mode: "camera-mic" });
  await c.start();
  await c.stop();
  assert.equal(c.state.kind, "review");
  assert.equal(c.state.blob.size, bytes.length, "the whole recording, not just the chunks written so far");
  assert.equal(c.state.check.durationSeconds, 40);
});

test("retake: the reviewed recording is deleted from the browser and the studio starts over", async () => {
  const { c, store } = controller();
  await c.prepare({ mode: "camera-mic" });
  await c.start();
  await c.stop();
  assert.equal(c.state.kind, "review");
  await c.retake();
  assert.equal(c.state.kind, "idle");
  assert.equal(await store.getRecording("rec-1"), null);
  assert.equal((await store.assemble("rec-1", "video/mp4")).size, 0);
});

test("the screen share ending (browser 'Stop sharing') stops the recording and keeps it for review", async () => {
  const { c } = controller();
  await c.prepare({ mode: "screen-mic" });
  await c.start();
  const videoTrack = c.liveStream.getVideoTracks()[0];
  videoTrack.onended();
  for (let i = 0; i < 50 && c.state.kind !== "review"; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(c.state.kind, "review");
});

test("storage failure while recording stops it with a notice; what was stored is still reviewed", async () => {
  const store = Store.createMemoryStore();
  const realAppend = store.appendChunk;
  let n = 0;
  store.appendChunk = async (...args) => {
    n += 1;
    if (n > 1) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    return realAppend(...args);
  };
  const { c } = controller({ store, bytes: fragmentedRecording({ fragments: 60, mediaBytes: 8192 }) }); // several slices
  await c.prepare({ mode: "camera-mic" });
  await c.start();
  await c.stop();
  for (let i = 0; i < 50 && c.state.kind !== "review"; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(c.state.kind, "review");
  assert.ok(n > 1, "a write failed");
  assert.match(c.state.notice, /ran out of space/);
  // Only the first slice was stored: it is trimmed to its complete fragments, a valid but SHORTER recording.
  assert.equal(c.state.check.ok, true);
  assert.ok(c.state.check.durationSeconds >= 1 && c.state.check.durationSeconds < 60, String(c.state.check.durationSeconds));
});

test("a recorder that cannot be created is an error, not a silent failure", async () => {
  const { c } = controller({ recorderError: domError("NotSupportedError") });
  await c.prepare({ mode: "camera-mic" });
  await c.start();
  assert.equal(c.state.kind, "error");
  assert.equal(c.state.failure.code, "NOT_SUPPORTED");
});

test("recovery: a recording interrupted mid-session (status 'recording') is trimmed and reviewed", async () => {
  const store = Store.createMemoryStore();
  const full = fragmentedRecording({ fragments: 20, mediaBytes: 4096 });
  const cut = full.subarray(0, full.length - 1000);
  await store.putRecording({ id: "old", teacherId: "t1", lectureId: "l1", mimeType: "video/mp4", startedAt: 1, updatedAt: 1, status: "recording", durationMs: 0, uploadId: null, title: null, partNumber: null, uploadBytes: null });
  await store.appendChunk("old", 0, new Blob([cut]));
  const { c } = controller({ store });
  await c.review("old");
  assert.equal(c.state.kind, "review");
  assert.equal(c.state.check.ok, true);
  assert.equal(c.state.check.durationSeconds, 19);
  assert.ok(c.state.blob.size < cut.length);
});

// ---- Pure helpers ---------------------------------------------------------------------------------------

test("format: only H.264 + AAC MP4 is used; Firefox-like browsers (WebM only) are unsupported", () => {
  assert.equal(S.pickRecorderMimeType((t) => t === S.RECORDER_MIME_CANDIDATES[2]), S.RECORDER_MIME_CANDIDATES[2]);
  assert.equal(S.pickRecorderMimeType((t) => t.startsWith("video/webm")), null);
  assert.equal(S.pickRecorderMimeType(() => { throw new Error("x"); }), null);
  assert.equal(S.pickRecorderMimeType(undefined), null);
  for (const type of S.RECORDER_MIME_CANDIDATES) {
    assert.match(type, /^video\/mp4;codecs=/);
    assert.match(type, /avc1/);
    assert.match(type, /mp4a\.40\.2/);
  }
});

test("support: modes depend on the browser's abilities; reasons are explained", () => {
  const full = { isSecureContext: true, hasGetUserMedia: true, hasGetDisplayMedia: true, hasMediaRecorder: true, isTypeSupported: () => true, hasAudioContext: true };
  assert.deepEqual(S.studioSupport(full).modes, { "camera-mic": true, "screen-mic": true, "camera-only": true });
  const phone = S.studioSupport({ ...full, hasGetDisplayMedia: false });
  assert.equal(phone.supported, true);
  assert.equal(phone.modes["screen-mic"], false);
  assert.ok(phone.reasons.some((r) => /Screen recording/.test(r)));
  const firefox = S.studioSupport({ ...full, isTypeSupported: (t) => t.startsWith("video/webm") });
  assert.equal(firefox.supported, false);
  assert.ok(firefox.reasons.some((r) => /MP4/.test(r)));
  const insecure = S.studioSupport({ ...full, isSecureContext: false });
  assert.equal(insecure.supported, false);
  const old = S.studioSupport({ ...full, hasMediaRecorder: false });
  assert.equal(old.supported, false);
  assert.match(S.SUPPORTED_BROWSERS_TEXT, /Firefox/);
});

test("clock: pause / resume accounting and display", () => {
  let c = S.clockStart(0);
  c = S.clockPause(c, 1000);
  c = S.clockPause(c, 5000); // double pause ignored
  assert.equal(S.clockElapsed(c, 9000), 1000);
  c = S.clockResume(c, 9000);
  c = S.clockResume(c, 9500); // double resume ignored
  assert.equal(S.clockElapsed(c, 10_000), 2000);
  assert.equal(S.clockElapsed(S.newClock(), 10), 0);
  assert.equal(S.formatClock(65_000), "01:05");
  assert.equal(S.formatClock(3_725_000), "1:02:05");
});

test("titles and file names", () => {
  assert.equal(S.suggestedRecordingTitle("Algebra", 1), "Algebra");
  assert.equal(S.suggestedRecordingTitle("Algebra", 3), "Algebra (part 3)");
  assert.equal(Array.from(S.suggestedRecordingTitle("x".repeat(300), 2)).length, 200);
  assert.match(S.studioFileName("Algebra / ../etc", Date.UTC(2026, 10, 14)), /^Algebra etc 2026-11-14\.mp4$/);
});

test("store: memory store keeps chunks in order and per teacher / lecture", async () => {
  const store = Store.createMemoryStore();
  const base = { teacherId: "t1", lectureId: "l1", mimeType: "video/mp4", startedAt: 1, updatedAt: 1, status: "stopped", durationMs: 0, uploadId: null, title: null, partNumber: null, uploadBytes: null };
  await store.putRecording({ ...base, id: "a" });
  await store.putRecording({ ...base, id: "b", teacherId: "t2" });
  await store.appendChunk("a", 1, new Blob(["world"]));
  await store.appendChunk("a", 0, new Blob(["hello "]));
  assert.equal(await (await store.assemble("a", "video/mp4")).text(), "hello world");
  assert.deepEqual((await store.listRecordings("t1", "l1")).map((r) => r.id), ["a"]);
  await store.deleteRecording("a");
  assert.equal(await store.getRecording("a"), null);
  assert.equal(store.persistent, false);
  assert.equal(await Store.openIndexedDbStore(undefined), null, "no IndexedDB: null (the page falls back and says so)");
});

test("fingerprint: same file matches, a different file of the same size does not", async () => {
  const digest = async (data) => crypto.createHash("sha256").update(Buffer.from(data)).digest().buffer;
  const make = (bytes, name = "a.mp4") => {
    const blob = new Blob([bytes]);
    return { name, size: blob.size, lastModified: 1, slice: (s, e) => blob.slice(s, e) };
  };
  const one = Buffer.alloc(3 * 1024 * 1024, 7);
  const other = Buffer.from(one);
  other[other.length - 5] = 9; // differs near the end
  const a = await Store.fingerprintFile(make(one), digest);
  const b = await Store.fingerprintFile(make(Buffer.from(one)), digest);
  const c = await Store.fingerprintFile(make(other), digest);
  assert.equal(Store.sameFingerprint(a, b), true);
  assert.equal(Store.sameFingerprint(a, c), false);
  assert.equal(Store.sameFingerprint(a, { ...b, name: "b.mp4" }), false);
});
