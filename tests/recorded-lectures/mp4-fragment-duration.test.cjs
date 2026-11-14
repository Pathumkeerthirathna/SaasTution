/*
 * MP4 inspection: duration of fragmented recordings without mvhd / mehd
 * duration (browser MediaRecorder output), computed from the last fragments.
 * Synthetic files (helpers/fragmented-mp4.cjs); real MediaRecorder output
 * still needs real-browser testing.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const M = require(path.join(root, "lib", "recorded-lectures", "mp4-inspect.ts"));
const F = require("./helpers/mp4-fixtures.cjs");
const { fragmentedRecording } = require("./helpers/fragmented-mp4.cjs");

const inspect = (bytes) => M.inspectMp4(M.bytesByteSource(new Uint8Array(bytes)), { maxMoovBytes: 64 * 1024 * 1024 });

test("fragmented, no mvhd / mehd duration: computed from per-sample trun durations", async () => {
  const result = await inspect(fragmentedRecording({ fragments: 125 })); // 125 s of video, audio ~125.33 s
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.info.fragmented, true);
  assert.equal(result.info.durationSeconds, 125);
});

test("fragmented: the longest track wins (audio slightly longer than video)", async () => {
  // video 60 x 1 s = 60 s; audio 60 x 47 x 1024 / 48000 = 60.16 s -> rounds to 60; make audio clearly longer:
  const result = await inspect(fragmentedRecording({ fragments: 60, audioSamples: 60 })); // audio 60*60*1024/48000 = 76.8 s
  assert.equal(result.info.durationSeconds, 77);
});

test("fragmented: tfhd default and trex default sample durations are used", async () => {
  for (const mode of ["tfhd-default", "trex-default"]) {
    const result = await inspect(fragmentedRecording({ fragments: 42, mode, audioSamples: 40 })); // audio 42*40*1024/48000 = 35.8
    assert.equal(result.ok, true, mode);
    assert.equal(result.info.durationSeconds, 42, mode);
  }
});

test("fragmented: tfdt version 0 works too", async () => {
  const result = await inspect(fragmentedRecording({ fragments: 20, tfdtVersion: 0 }));
  assert.equal(result.info.durationSeconds, 20);
});

test("fragmented: only one track with fragments still gives a duration", async () => {
  const result = await inspect(fragmentedRecording({ fragments: 15, omitAudioFragments: true }));
  assert.equal(result.info.durationSeconds, 15);
});

test("fragmented: without tfdt the duration stays unknown (null), the file is not rejected", async () => {
  const result = await inspect(fragmentedRecording({ fragments: 5, omitTfdt: true }));
  assert.equal(result.ok, true);
  assert.equal(result.info.durationSeconds, null);
});

test("an explicit mvhd duration is still preferred over the fragments", async () => {
  const result = await inspect(fragmentedRecording({ fragments: 10, mvhdDuration: 99_000 })); // 99 s at timescale 1000
  assert.equal(result.info.durationSeconds, 99);
});

test("non-fragmented files are unchanged (mvhd), and the old fixtures (no track ids) keep their behaviour", async () => {
  const plain = await inspect(F.mp4());
  assert.equal(plain.info.fragmented, false);
  assert.equal(plain.info.durationSeconds, 3600);
  const zero = await inspect(F.mp4({ moovBox: F.moov({ header: F.mvhd({ duration: 0 }) }) }));
  assert.equal(zero.info.durationSeconds, null);
});

test("a damaged trun in the last fragment leaves the duration unknown without rejecting the file", async () => {
  const bytes = fragmentedRecording({ fragments: 3 });
  // Find the last "trun" and claim a huge sample count.
  const at = bytes.lastIndexOf(Buffer.from("trun"));
  bytes.writeUInt32BE(0x7fffffff, at + 8);
  const result = await inspect(bytes);
  assert.equal(result.ok, true);
  assert.equal(result.info.durationSeconds, null);
});

test("only the last MAX_TAIL_FRAGMENTS moof boxes are read (bounded work on long recordings)", async () => {
  const bytes = fragmentedRecording({ fragments: 400, mediaBytes: 16, audioSamples: 46 }); // audio 392.5 s < video 400 s
  let reads = 0;
  const source = M.bytesByteSource(new Uint8Array(bytes));
  const counting = { size: source.size, read: (o, l) => { reads += 1; return source.read(o, l); } };
  const result = await M.inspectMp4(counting, { maxMoovBytes: 64 * 1024 * 1024 });
  assert.equal(result.info.durationSeconds, 400);
  // header reads (2 per fragment + a few) and at most one read per tail fragment needed.
  assert.ok(reads <= 2 * 400 + 10 + M.MAX_TAIL_FRAGMENTS, String(reads));
});
