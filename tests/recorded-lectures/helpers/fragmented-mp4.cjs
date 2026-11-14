/*
 * Builds fragmented MP4 files shaped like a browser MediaRecorder recording
 * (Recorded Lectures, browser recording support): ftyp, a moov whose mvhd
 * duration is 0 (unknown while recording) with mvex/trex and NO mehd, then
 * moof + mdat fragments. Each track has a real tkhd track_ID and an mdhd
 * timescale, so the fragment duration fallback of mp4-inspect.ts can work.
 *
 * Synthetic: the media bytes are filler. It validates container handling
 * only; real MediaRecorder output still needs real-browser testing.
 */

"use strict";

const F = require("./mp4-fixtures.cjs");

const { u16, u32, u64, box, fullBox, videoEntry, audioEntry, hdlr, stsd } = F;

function timedTrack({ handler, entry, trackId, timescale }) {
  const tkhd = fullBox("tkhd", 0, 3, u32(0), u32(0), u32(trackId), u32(0), u32(0), Buffer.alloc(60));
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  const stbl = box("stbl", stsd([entry]), fullBox("stts", 0, 0, u32(0)));
  return box("trak", tkhd, box("mdia", mdhd, hdlr(handler), box("minf", stbl)));
}

/**
 * options:
 *   fragments       number of fragments (default 10)
 *   videoSamples    video samples per fragment (default 30)
 *   audioSamples    audio samples per fragment (default 47)
 *   videoTimescale  (default 30000), videoSampleDuration (default 1000)  -> 1 s per fragment at 30 fps
 *   audioTimescale  (default 48000), audioSampleDuration (default 1024)
 *   mode            "per-sample" (trun durations, default) | "tfhd-default" | "trex-default"
 *   tfdtVersion     0 | 1 (default 1)
 *   omitTfdt        no tfdt boxes (duration then unknown)
 *   omitAudioFragments  only the video track has fragments
 *   mvhdDuration    (default 0: unknown)
 *   mediaBytes      mdat payload size per fragment (default 2048)
 */
function fragmentedRecording(options = {}) {
  const {
    fragments = 10,
    videoSamples = 30,
    audioSamples = 47,
    videoTimescale = 30000,
    videoSampleDuration = 1000,
    audioTimescale = 48000,
    audioSampleDuration = 1024,
    mode = "per-sample",
    tfdtVersion = 1,
    omitTfdt = false,
    omitAudioFragments = false,
    mvhdDuration = 0,
    mediaBytes = 2048,
  } = options;

  const VIDEO = 1;
  const AUDIO = 2;
  const ftyp = F.ftyp({ major: "isom", compatible: ["isom", "iso6", "avc1", "mp41"] });
  const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(mvhdDuration), Buffer.alloc(80));
  const trexDuration = (trackId, d) => fullBox("trex", 0, 0, u32(trackId), u32(1), u32(mode === "trex-default" ? d : 0), u32(0), u32(0));
  const mvex = box("mvex", trexDuration(VIDEO, videoSampleDuration), trexDuration(AUDIO, audioSampleDuration));
  const moov = box(
    "moov",
    mvhd,
    timedTrack({ handler: "vide", entry: videoEntry(), trackId: VIDEO, timescale: videoTimescale }),
    timedTrack({ handler: "soun", entry: audioEntry(), trackId: AUDIO, timescale: audioTimescale }),
    mvex
  );

  function traf(trackId, index, samples, sampleDuration) {
    const base = index * samples * sampleDuration;
    const tfhdFlags = mode === "tfhd-default" ? 0x08 : 0;
    const tfhd = fullBox("tfhd", 0, tfhdFlags, u32(trackId), ...(mode === "tfhd-default" ? [u32(sampleDuration)] : []));
    const tfdt = tfdtVersion === 1 ? fullBox("tfdt", 1, 0, u64(base)) : fullBox("tfdt", 0, 0, u32(base));
    // data_offset (0x001) + sample sizes (0x200) always; durations (0x100) only in per-sample mode.
    const trunFlags = 0x001 | 0x200 | (mode === "per-sample" ? 0x100 : 0);
    const sampleRecords = [];
    for (let i = 0; i < samples; i += 1) {
      if (mode === "per-sample") sampleRecords.push(u32(sampleDuration));
      sampleRecords.push(u32(10));
    }
    const trun = fullBox("trun", 0, trunFlags, u32(samples), u32(0), ...sampleRecords);
    return box("traf", tfhd, ...(omitTfdt ? [] : [tfdt]), trun);
  }

  const parts = [ftyp, moov];
  for (let i = 0; i < fragments; i += 1) {
    const trafs = [traf(VIDEO, i, videoSamples, videoSampleDuration)];
    if (!omitAudioFragments) trafs.push(traf(AUDIO, i, audioSamples, audioSampleDuration));
    parts.push(box("moof", fullBox("mfhd", 0, 0, u32(i + 1)), ...trafs));
    parts.push(box("mdat", Buffer.alloc(mediaBytes, 0xcd)));
  }
  return Buffer.concat(parts);
}

module.exports = { fragmentedRecording, timedTrack };
