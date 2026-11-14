/*
 * Recorded Lectures RL-1: MP4 / H.264 / AAC validation
 * (lib/recorded-lectures/mp4-inspect.ts, mp4-inspect-node.ts).
 *
 *   npm run test:recorded-lectures
 *
 * Synthetic files from helpers/mp4-fixtures.cjs; one test also inspects a
 * file through the real LocalFileStorage in a temporary folder.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { inspectMp4, bytesByteSource, blobByteSource, MP4_REJECTION_MESSAGES } = require(path.join(root, "lib", "recorded-lectures", "mp4-inspect.ts"));
const { inspectStoredMp4 } = require(path.join(root, "lib", "recorded-lectures", "mp4-inspect-node.ts"));
const { LocalFileStorage } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));
const F = require("./helpers/mp4-fixtures.cjs");

const OPTIONS = { maxMoovBytes: 64 * 1024 * 1024 };
const inspect = (bytes, options = OPTIONS) => inspectMp4(bytesByteSource(new Uint8Array(bytes)), options);

async function rejected(bytes, code, options) {
  const result = await inspect(bytes, options);
  assert.equal(result.ok, false, `expected ${code}, got ok`);
  assert.equal(result.code, code);
  assert.ok(MP4_REJECTION_MESSAGES[code], "every code has a message");
  return result;
}

// ---- Accepted files -----------------------------------------------------------------------------------

test("valid: H.264 High + AAC-LC, moov first: codecs, size, duration, brands", async () => {
  const result = await inspect(F.mp4());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.info, {
    majorBrand: "isom",
    compatibleBrands: ["isom", "iso2", "avc1", "mp41"],
    fragmented: false,
    durationSeconds: 3600,
    videoCodec: "avc1.64001F",
    audioCodec: "mp4a.40.2",
    width: 1280,
    height: 720,
    videoTrackCount: 1,
    audioTrackCount: 1,
  });
});

test("valid: moov at the END of the file (not fast-start) is found without reading the media", async () => {
  const bytes = F.mp4({ moovFirst: false, media: F.mdat(200_000) });
  const reads = [];
  const source = bytesByteSource(new Uint8Array(bytes));
  const result = await inspectMp4({ size: source.size, read: (o, l) => (reads.push([o, l]), source.read(o, l)) }, OPTIONS);
  assert.equal(result.ok, true);
  assert.ok(reads.every(([, length]) => length <= 16 || length < 10_000), "only headers and the moov were read");
});

test("valid: Baseline (66) and Main (77) profiles; avc3 entries; codec strings", async () => {
  for (const [profile, expected] of [[66, "avc1.42C01E"], [77, "avc1.4D401F"]]) {
    const compatibility = profile === 66 ? 0xc0 : 0x40;
    const level = profile === 66 ? 30 : 31;
    const video = F.track("vide", [F.videoEntry({ children: [F.avcC({ profile, compatibility, level })] })]);
    const result = await inspect(F.mp4({ moovBox: F.moov({ tracks: [video, F.audioTrack()] }) }));
    assert.equal(result.ok, true, `profile ${profile}`);
    assert.equal(result.info.videoCodec, expected);
  }
  const avc3 = F.track("vide", [F.videoEntry({ type: "avc3" })]);
  const result = await inspect(F.mp4({ moovBox: F.moov({ tracks: [avc3, F.audioTrack()] }) }));
  assert.equal(result.info.videoCodec, "avc3.64001F");
});

test("valid: HE-AAC (5) and HE-AACv2 (29); escaped object type; esds optional fields; QuickTime sound v1/v2 and 'wave'", async () => {
  for (const audioObjectType of [5, 29]) {
    const audio = F.track("soun", [F.audioEntry({ children: [F.esds({ audioObjectType })] })]);
    const result = await inspect(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack(), audio] }) }));
    assert.equal(result.ok, true);
    assert.equal(result.info.audioCodec, `mp4a.40.${audioObjectType}`);
  }
  for (const entry of [
    F.audioEntry({ children: [F.esds({ esFlags: 0x80 | 0x40 | 0x20 })] }),
    F.audioEntry({ soundVersion: 1 }),
    F.audioEntry({ soundVersion: 2 }),
    F.audioEntry({ soundVersion: 1, wrapInWave: true }),
  ]) {
    const result = await inspect(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack(), F.track("soun", [entry])] }) }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.info.audioCodec, "mp4a.40.2");
  }
});

test("valid: brands mp42 / M4V major; compatible-only ISO brand; 64-bit box sizes; fragmented (mvex/mehd) duration", async () => {
  for (const ftypBox of [F.ftyp({ major: "mp42", compatible: ["isom"] }), F.ftyp({ major: "M4V ", compatible: [] }), F.ftyp({ major: "XAVC", compatible: ["iso4"] })]) {
    assert.equal((await inspect(F.mp4({ ftypBox }))).ok, true);
  }

  const large = Buffer.concat([F.ftyp(), F.moov(), F.largeBox("mdat", Buffer.alloc(1000))]);
  assert.equal((await inspect(large)).ok, true, "64-bit mdat size");

  const fragmented = F.moov({
    header: F.mvhd({ duration: 0 }),
    extra: [F.box("mvex", F.fullBox("mehd", 0, 0, F.u32(90_000)))],
  });
  const result = await inspect(Buffer.concat([F.ftyp(), fragmented, F.box("moof", Buffer.alloc(8)), F.mdat()]));
  assert.equal(result.ok, true);
  assert.equal(result.info.fragmented, true);
  assert.equal(result.info.durationSeconds, 90);
});

test("valid: mvhd version 1 duration; unknown duration is null; size-0 final mdat; ignored non-media tracks", async () => {
  const v1 = await inspect(F.mp4({ moovBox: F.moov({ header: F.mvhd({ version: 1, timescale: 600, duration: 600 * 125 }) }) }));
  assert.equal(v1.info.durationSeconds, 125);

  const unknown = await inspect(F.mp4({ moovBox: F.moov({ header: F.mvhd({ duration: 0xffffffff }) }) }));
  assert.equal(unknown.info.durationSeconds, null);

  const toEnd = Buffer.concat([F.ftyp(), F.moov(), F.u32(0), F.ascii("mdat"), Buffer.alloc(500)]);
  assert.equal((await inspect(toEnd)).ok, true);

  const text = F.track("text", [F.box("tx3g", Buffer.alloc(16))]);
  const withText = await inspect(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack(), F.audioTrack(), text] }) }));
  assert.equal(withText.ok, true);
});

test("valid: an SPS containing emulation-prevention bytes parses", async () => {
  const spsNal = F.sps({ forceEmulation: true });
  assert.ok(spsNal.includes(Buffer.from([0, 0, 3])), "fixture really contains 00 00 03");
  const video = F.track("vide", [F.videoEntry({ children: [F.avcC({ spsNal })] })]);
  assert.equal((await inspect(F.mp4({ moovBox: F.moov({ tracks: [video, F.audioTrack()] }) }))).ok, true);
});

// ---- Required tracks and codecs -----------------------------------------------------------------------

test("refused: video only (no audio track) -> AUDIO_TRACK_REQUIRED; audio only -> VIDEO_TRACK_REQUIRED", async () => {
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack()] }) }), "AUDIO_TRACK_REQUIRED");
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [F.audioTrack()] }) }), "VIDEO_TRACK_REQUIRED");
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [] }) }), "VIDEO_TRACK_REQUIRED");
});

test("refused: non-H.264 video (HEVC hvc1/hev1, VP9, AV1) even next to an H.264 track", async () => {
  for (const type of ["hvc1", "hev1", "vp09", "av01", "mp4v"]) {
    const other = F.track("vide", [F.videoEntry({ type, children: [] })]);
    const result = await rejected(F.mp4({ moovBox: F.moov({ tracks: [other, F.audioTrack()] }) }), "VIDEO_CODEC_NOT_SUPPORTED");
    assert.equal(result.detail, type);
    await rejected(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack(), other, F.audioTrack()] }) }), "VIDEO_CODEC_NOT_SUPPORTED");
  }
});

test("refused: H.264 High 10 / High 4:2:2 / High 4:4:4 / Extended profiles; 4:2:2 or 10-bit High", async () => {
  for (const profile of [110, 122, 244, 88]) {
    const video = F.track("vide", [F.videoEntry({ children: [F.avcC({ profile })] })]);
    await rejected(F.mp4({ moovBox: F.moov({ tracks: [video, F.audioTrack()] }) }), "H264_PROFILE_NOT_SUPPORTED");
  }
  const chroma422 = F.track("vide", [F.videoEntry({ children: [F.avcC({ spsNal: F.sps({ chroma: 2 }) })] })]);
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [chroma422, F.audioTrack()] }) }), "H264_CHROMA_NOT_SUPPORTED");
  const tenBit = F.track("vide", [F.videoEntry({ children: [F.avcC({ spsNal: F.sps({ lumaDepth: 10, chromaDepth: 10 }) })] })]);
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [tenBit, F.audioTrack()] }) }), "H264_BIT_DEPTH_NOT_SUPPORTED");
});

test("refused: avcC missing or inconsistent with its SPS", async () => {
  const noAvcC = F.track("vide", [F.videoEntry({ children: [] })]);
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [noAvcC, F.audioTrack()] }) }), "MALFORMED");
  const mismatch = F.track("vide", [F.videoEntry({ children: [F.avcC({ profile: 77, spsNal: F.sps({ profile: 100 }) })] })]);
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [mismatch, F.audioTrack()] }) }), "MALFORMED");
});

test("refused: non-AAC audio (MP3 in mp4a, AC-3, E-AC-3, Opus, ALAC) and non-LC/HE AAC object types", async () => {
  const mp3 = F.track("soun", [F.audioEntry({ children: [F.esds({ objectTypeIndication: 0x6b })] })]);
  const r = await rejected(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack(), mp3] }) }), "AUDIO_CODEC_NOT_SUPPORTED");
  assert.equal(r.detail, "0x6B");
  for (const type of ["ac-3", "ec-3", "Opus", "alac", ".mp3"]) {
    const other = F.track("soun", [F.audioEntry({ type, children: [] })]);
    await rejected(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack(), other] }) }), "AUDIO_CODEC_NOT_SUPPORTED");
  }
  for (const audioObjectType of [1, 23, 42]) {
    const audio = F.track("soun", [F.audioEntry({ children: [F.esds({ audioObjectType })] })]);
    await rejected(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack(), audio] }) }), "AAC_PROFILE_NOT_SUPPORTED");
  }
  const twoAudio = F.moov({ tracks: [F.videoTrack(), F.audioTrack(), F.audioTrack()] });
  assert.equal((await inspect(F.mp4({ moovBox: twoAudio }))).info.audioTrackCount, 2, "two AAC tracks are fine");
});

test("refused: encrypted entries (encv / enca)", async () => {
  const encv = F.track("vide", [F.videoEntry({ type: "encv", children: [] })]);
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [encv, F.audioTrack()] }) }), "ENCRYPTED");
  const enca = F.track("soun", [F.audioEntry({ type: "enca", children: [] })]);
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack(), enca] }) }), "ENCRYPTED");
});

// ---- Container structure ------------------------------------------------------------------------------

test("refused: not an MP4 (no ftyp first, garbage, empty, WebM / Matroska signature)", async () => {
  await rejected(Buffer.concat([F.moov(), F.ftyp(), F.mdat()]), "NOT_MP4");
  await rejected(Buffer.from("not a video at all, just text"), "NOT_MP4");
  await rejected(Buffer.alloc(0), "NOT_MP4");
  await rejected(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)]), "NOT_MP4");
});

test("refused: QuickTime brand; unknown brands only", async () => {
  await rejected(F.mp4({ ftypBox: F.ftyp({ major: "qt  ", compatible: ["qt  "] }) }), "QUICKTIME_NOT_SUPPORTED");
  await rejected(F.mp4({ ftypBox: F.ftyp({ major: "qt  ", compatible: ["isom"] }) }), "QUICKTIME_NOT_SUPPORTED");
  await rejected(F.mp4({ ftypBox: F.ftyp({ major: "3gp4", compatible: ["3gp4"] }) }), "BRAND_NOT_SUPPORTED");
});

test("refused: no moov, two moovs, moov over the limit", async () => {
  await rejected(Buffer.concat([F.ftyp(), F.mdat()]), "NO_MOOV");
  await rejected(Buffer.concat([F.ftyp(), F.moov(), F.moov(), F.mdat()]), "MULTIPLE_MOOV");
  const big = F.mp4();
  await rejected(big, "MOOV_TOO_LARGE", { maxMoovBytes: 100 });
});

test("refused: truncated or overlapping boxes, bad sizes, a second ftyp, size 0 before the end", async () => {
  const whole = F.mp4();
  await rejected(whole.subarray(0, whole.length - 10), "TRUNCATED");

  const badMoov = Buffer.from(F.moov());
  badMoov.writeUInt32BE(badMoov.length + 50, 0);
  await rejected(Buffer.concat([F.ftyp(), badMoov]), "TRUNCATED");

  const tooSmall = Buffer.concat([F.ftyp(), F.moov(), F.u32(4), F.ascii("free")]);
  await rejected(tooSmall, "MALFORMED");

  await rejected(Buffer.concat([F.ftyp(), F.moov(), F.ftyp(), F.mdat()]), "MALFORMED");
  await rejected(Buffer.concat([F.ftyp(), F.u32(0), F.ascii("moov"), F.moov().subarray(8)]), "MALFORMED");

  const huge = Buffer.concat([F.ftyp(), F.moov(), F.u32(1), F.ascii("mdat"), F.u32(0x00400000), F.u32(0)]);
  await rejected(huge, "MALFORMED", undefined); // 64-bit size >= 2^53
});

test("refused: a child box overflowing its parent inside moov; a non-printable box type", async () => {
  const header = Buffer.from(F.mvhd());
  header.writeUInt32BE(header.length + 1000, 0);
  await rejected(F.mp4({ moovBox: F.box("moov", header, F.videoTrack(), F.audioTrack()) }), "TRUNCATED");

  const garbage = Buffer.concat([F.u32(16), Buffer.from([0x01, 0x02, 0x03, 0x04]), Buffer.alloc(8)]);
  await rejected(F.mp4({ moovBox: F.box("moov", F.mvhd(), garbage, F.videoTrack(), F.audioTrack()) }), "MALFORMED");
});

test("refused: stsd entry count mismatch; missing hdlr / stsd / mvhd", async () => {
  const mismatch = F.track("vide", [F.videoEntry()], { entryCount: 2 });
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [mismatch, F.audioTrack()] }) }), "MALFORMED");
  const noMvhd = F.box("moov", F.videoTrack(), F.audioTrack());
  await rejected(F.mp4({ moovBox: noMvhd }), "MALFORMED");
  const noStsd = F.box("trak", F.box("mdia", F.hdlr("vide"), F.box("minf", F.box("stbl"))));
  await rejected(F.mp4({ moovBox: F.moov({ tracks: [noStsd, F.audioTrack()] }) }), "MALFORMED");
});

test("limits: too many top-level boxes, too many boxes in moov, nesting too deep", async () => {
  const many = Buffer.concat([F.ftyp(), F.moov(), ...Array.from({ length: 50 }, () => F.box("free")), F.mdat()]);
  await rejected(many, "TOO_COMPLEX", { ...OPTIONS, maxTopLevelBoxes: 20 });
  await rejected(F.mp4(), "TOO_COMPLEX", { ...OPTIONS, maxBoxesInMoov: 5 });
  await rejected(F.mp4(), "TOO_COMPLEX", { ...OPTIONS, maxDepth: 3 });
});

test("never throws on hostile input: random bytes after a valid ftyp", async () => {
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 300; i += 1) {
    const length = Math.floor(random() * 400);
    const junk = Buffer.from(Array.from({ length }, () => Math.floor(random() * 256)));
    const result = await inspect(Buffer.concat([F.ftyp(), junk]));
    assert.equal(result.ok, false);
  }
  // Random corruption inside a valid moov.
  const base = F.mp4();
  for (let i = 0; i < 300; i += 1) {
    const copy = Buffer.from(base);
    for (let j = 0; j < 4; j += 1) copy[40 + Math.floor(random() * (copy.length - 40))] = Math.floor(random() * 256);
    const result = await inspect(copy);
    assert.ok(result.ok === true || typeof result.code === "string");
  }
});

// ---- RL-1.1 regressions (review findings M-1, L-3, L-4) --------------------------------------------------

const { DEFAULT_MAX_TOP_LEVEL_BOXES } = require(path.join(root, "lib", "recorded-lectures", "mp4-inspect.ts"));

function fragmentedFile(fragments, boxesPerFragment = 2, fragmentMs = 1000) {
  const parts = [F.ftyp(), F.moov({ header: F.mvhd({ duration: 0 }), extra: [F.box("mvex", F.fullBox("mehd", 0, 0, F.u32(fragments * fragmentMs)))] })];
  const fragment = boxesPerFragment === 4
    ? [F.box("styp", F.ascii("msdh")), F.box("sidx", Buffer.alloc(24)), F.box("moof", Buffer.alloc(8)), F.box("mdat", Buffer.alloc(8))]
    : [F.box("moof", Buffer.alloc(8)), F.box("mdat", Buffer.alloc(8))];
  const one = Buffer.concat(fragment);
  for (let i = 0; i < fragments; i += 1) parts.push(one);
  return Buffer.concat(parts);
}

test("M-1: a 2-hour fragmented recording with 14,400 one-second fragments is accepted (28,800+ top-level boxes)", async () => {
  // 7,200 s at 1 s per fragment, plus the review's 14,400-fragment figure: both well within the cap.
  for (const fragments of [7_200, 14_400]) {
    const result = await inspect(fragmentedFile(fragments));
    assert.equal(result.ok, true, `${fragments} fragments: ${JSON.stringify(result)}`);
    assert.equal(result.info.fragmented, true);
    assert.equal(result.info.durationSeconds, fragments);
  }
});

test("M-1: an 8-hour recording with 1-second fragments of 4 boxes each (~115,000 boxes) is accepted", async () => {
  const result = await inspect(fragmentedFile(28_800, 4));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.info.durationSeconds, 28_800);
});

test("M-1: the top-level cap still protects against resource exhaustion", async () => {
  assert.equal(DEFAULT_MAX_TOP_LEVEL_BOXES, 250_000);
  await rejected(fragmentedFile(300), "TOO_COMPLEX", { ...OPTIONS, maxTopLevelBoxes: 500 });
  const result = await inspect(fragmentedFile(300), { ...OPTIONS, maxTopLevelBoxes: 700 });
  assert.equal(result.ok, true, "just under the cap is fine");
  // Above the default: 125,001 fragments x 2 boxes + ftyp + moov.
  await rejected(fragmentedFile(125_001), "TOO_COMPLEX");
});

const TERMINATOR = Buffer.concat([F.u32(8), Buffer.alloc(4)]);
const waveTrack = (...waveChildren) =>
  F.track("soun", [F.audioEntry({ soundVersion: 1, children: [F.box("wave", F.box("frma", F.ascii("mp4a")), ...waveChildren)] })]);
const withAudio = (audio) => F.mp4({ moovBox: F.moov({ tracks: [F.videoTrack(), audio] }) });

test("L-3: a QuickTime 'wave' box ending with the zero-type terminator is accepted", async () => {
  const result = await inspect(withAudio(waveTrack(F.esds(), TERMINATOR)));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.info.audioCodec, "mp4a.40.2");
  // Terminator followed by fewer than 8 zero bytes of padding.
  assert.equal((await inspect(withAudio(waveTrack(F.esds(), TERMINATOR, Buffer.alloc(3))))).ok, true);
});

test("L-3: the terminator must be last, and is accepted only inside 'wave'", async () => {
  await rejected(withAudio(waveTrack(F.esds(), TERMINATOR, F.box("free", Buffer.alloc(4)))), "MALFORMED");
  await rejected(withAudio(waveTrack(TERMINATOR, F.esds())), "MALFORMED");
  await rejected(withAudio(waveTrack(F.esds(), TERMINATOR, Buffer.from([0, 1]))), "MALFORMED");
  // Outside 'wave' (directly in the mp4a entry) a zero-type box is still invalid.
  const entry = F.audioEntry({ children: [F.esds(), TERMINATOR] });
  await rejected(withAudio(F.track("soun", [entry])), "MALFORMED");
});

const paddedVideo = (padding) => F.track("vide", [F.videoEntry({ children: [F.avcC(), padding] })]);
const withVideo = (video) => F.mp4({ moovBox: F.moov({ tracks: [video, F.audioTrack()] }) });

test("L-4: fewer than 8 trailing zero bytes inside a container are accepted (sample entry, moov, wave)", async () => {
  for (const n of [1, 4, 7]) {
    const result = await inspect(withVideo(paddedVideo(Buffer.alloc(n))));
    assert.equal(result.ok, true, `${n} zero bytes: ${JSON.stringify(result)}`);
  }
  const moovPadded = F.box("moov", F.mvhd(), F.videoTrack(), F.audioTrack(), Buffer.alloc(5));
  assert.equal((await inspect(F.mp4({ moovBox: moovPadded }))).ok, true);
  assert.equal((await inspect(withAudio(waveTrack(F.esds(), Buffer.alloc(6))))).ok, true);
});

test("L-4: non-zero trailing data, or 8+ trailing bytes that are not a valid box, are still refused", async () => {
  for (const padding of [Buffer.from([0, 0, 0, 1]), Buffer.from([0xff]), Buffer.from([0, 0, 0, 0, 0, 0, 7])]) {
    await rejected(withVideo(paddedVideo(padding)), "TRUNCATED");
  }
  await rejected(withVideo(paddedVideo(Buffer.alloc(8))), "MALFORMED");
  // Top-level trailing bytes at the end of the file are not padding-tolerant.
  await rejected(Buffer.concat([F.mp4(), Buffer.alloc(4)]), "TRUNCATED");
});

// ---- Sources -------------------------------------------------------------------------------------------

test("blobByteSource (browser path) gives the same result", async () => {
  const result = await inspectMp4(blobByteSource(new Blob([F.mp4()])), OPTIONS);
  assert.equal(result.ok, true);
  assert.equal(result.info.videoCodec, "avc1.64001F");
});

test("inspectStoredMp4 reads a stored file through LocalFileStorage and closes it", async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rl1-mp4-root-"));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl1-mp4-app-"));
  try {
    const storage = await LocalFileStorage.open({ root: storageRoot, appDir });
    const bytes = new Uint8Array(F.mp4({ moovFirst: false }));
    await storage.writeNewFile("System/TemporaryUploads/a.part", (async function* () { yield bytes; })(), { maxBytes: 10_000_000 });
    const result = await inspectStoredMp4(storage, "System/TemporaryUploads/a.part", { maxMoovBytes: 1_000_000 });
    assert.equal(result.ok, true);
    assert.equal(result.info.audioCodec, "mp4a.40.2");
    assert.equal(await storage.remove("System/TemporaryUploads/a.part"), true, "handle closed (removable on Windows too)");
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("mp4-inspect.ts stays browser-safe: no Node imports", () => {
  const src = fs.readFileSync(path.join(root, "lib", "recorded-lectures", "mp4-inspect.ts"), "utf8");
  assert.doesNotMatch(src, /^import /m);
  assert.doesNotMatch(src, /require\(|node:/);
});
