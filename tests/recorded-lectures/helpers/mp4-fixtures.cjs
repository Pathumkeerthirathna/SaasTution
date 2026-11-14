/*
 * Synthetic MP4 files for the Recorded Lectures validator tests (RL-1).
 * Built box by box (no media tools needed): ftyp, moov (mvhd, trak ->
 * mdia -> hdlr / minf -> stbl -> stsd with avc1/avcC or mp4a/esds), mdat.
 * Only the structure the validator reads is real; media bytes are filler.
 */

"use strict";

const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
};
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(v));
  return b;
};
const ascii = (s) => Buffer.from(s, "latin1");

function box(type, ...parts) {
  const payload = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([u32(payload.length + 8), ascii(type), payload]);
}

/** A box with a 64-bit "largesize" header. */
function largeBox(type, ...parts) {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(1), ascii(type), u64(payload.length + 16), payload]);
}

const fullBox = (type, version, flags, ...parts) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...parts);

// ---- H.264 SPS ------------------------------------------------------------------------------------

class BitWriter {
  constructor() {
    this.bits = [];
  }
  bit(v) {
    this.bits.push(v ? 1 : 0);
  }
  bitsOf(value, count) {
    for (let i = count - 1; i >= 0; i -= 1) this.bit((value >> i) & 1);
  }
  ue(value) {
    const v = value + 1;
    const length = Math.floor(Math.log2(v));
    for (let i = 0; i < length; i += 1) this.bit(0);
    this.bitsOf(v, length + 1);
  }
  bytes() {
    const out = [];
    this.bit(1); // rbsp stop bit
    while (this.bits.length % 8 !== 0) this.bit(0);
    for (let i = 0; i < this.bits.length; i += 8) out.push(parseInt(this.bits.slice(i, i + 8).join(""), 2));
    return out;
  }
}

/** Adds emulation-prevention bytes (00 00 0x -> 00 00 03 0x for x <= 3). */
function escapeRbsp(bytes) {
  const out = [];
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out;
}

/**
 * An SPS NAL unit. For the High profile family the chroma format and bit
 * depths are written; `padZeros` inserts zero-valued syntax (sps id 0 via
 * long ue codes is not possible, so extra zero bytes are added after the
 * fields) to exercise emulation prevention.
 */
function sps({ profile = 100, constraints = 0, level = 31, chroma = 1, lumaDepth = 8, chromaDepth = 8, forceEmulation = false } = {}) {
  const w = new BitWriter();
  w.bitsOf(profile, 8);
  w.bitsOf(constraints, 8);
  w.bitsOf(level, 8);
  w.ue(0); // seq_parameter_set_id
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    w.ue(chroma);
    if (chroma === 3) w.bit(0);
    w.ue(lumaDepth - 8);
    w.ue(chromaDepth - 8);
    w.bit(0); // qpprime_y_zero_transform_bypass_flag
    w.bit(0); // seq_scaling_matrix_present_flag
  }
  w.ue(0); // log2_max_frame_num_minus4
  w.ue(2); // pic_order_cnt_type
  const rbsp = w.bytes();
  // Later SPS data with a 00 00 01 run, which escaping turns into 00 00 03 01.
  if (forceEmulation) rbsp.push(0, 0, 1, 0x80);
  return Buffer.from([0x67, ...escapeRbsp(rbsp)]);
}

function avcC({ profile = 100, compatibility = 0, level = 31, spsNal } = {}) {
  const nal = spsNal ?? sps({ profile, level });
  const pps = Buffer.from([0x68, 0xee, 0x3c, 0x80]);
  return box("avcC", u8(1), u8(profile), u8(compatibility), u8(level), u8(0xff), u8(0xe1), u16(nal.length), nal, u8(1), u16(pps.length), pps);
}

function videoEntry({ type = "avc1", width = 1280, height = 720, children } = {}) {
  const fields = Buffer.concat([
    Buffer.alloc(6), u16(1), // SampleEntry
    u16(0), u16(0), Buffer.alloc(12), // pre_defined / reserved
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1),
    Buffer.alloc(32), u16(0x0018), u16(0xffff),
  ]);
  return box(type, fields, ...(children ?? [avcC()]));
}

// ---- AAC esds -------------------------------------------------------------------------------------

function descriptor(tag, body) {
  return Buffer.concat([u8(tag), u8(0x80), u8(0x80), u8(0x80), u8(body.length), body]);
}

function audioSpecificConfig(objectType) {
  // 5 bits object type (31 escape for >= 32), 4 bits sampling index (44.1 kHz = 4), 4 bits channels (2).
  const w = new BitWriter();
  if (objectType >= 32) {
    w.bitsOf(31, 5);
    w.bitsOf(objectType - 32, 6);
  } else {
    w.bitsOf(objectType, 5);
  }
  w.bitsOf(4, 4);
  w.bitsOf(2, 4);
  const bits = w.bits;
  while (bits.length % 8 !== 0) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  return Buffer.from(out);
}

function esds({ objectTypeIndication = 0x40, audioObjectType = 2, esFlags = 0 } = {}) {
  const specific = descriptor(0x05, audioSpecificConfig(audioObjectType));
  const decoderConfig = descriptor(
    0x04,
    Buffer.concat([u8(objectTypeIndication), u8(0x15), Buffer.from([0, 0x18, 0]), u32(128000), u32(128000), specific])
  );
  const extra = [];
  if (esFlags & 0x80) extra.push(u16(2));
  if (esFlags & 0x40) extra.push(u8(3), ascii("abc"));
  if (esFlags & 0x20) extra.push(u16(3));
  const es = descriptor(0x03, Buffer.concat([u16(1), u8(esFlags), ...extra, decoderConfig, descriptor(0x06, u8(2))]));
  return fullBox("esds", 0, 0, es);
}

function audioEntry({ type = "mp4a", soundVersion = 0, children, wrapInWave = false } = {}) {
  const extra = soundVersion === 1 ? Buffer.alloc(16) : soundVersion === 2 ? Buffer.alloc(36) : Buffer.alloc(0);
  const fields = Buffer.concat([Buffer.alloc(6), u16(1), u16(soundVersion), Buffer.alloc(6), u16(2), u16(16), u16(0), u16(0), u32(44100 * 65536), extra]);
  const kids = children ?? [wrapInWave ? box("wave", esds()) : esds()];
  return box(type, fields, ...kids);
}

// ---- Tracks, movie, file --------------------------------------------------------------------------

function hdlr(handler) {
  return fullBox("hdlr", 0, 0, u32(0), ascii(handler), Buffer.alloc(12), ascii("handler\0"));
}

function stsd(entries) {
  return fullBox("stsd", 0, 0, u32(entries.length), ...entries);
}

function track(handler, entries, { entryCount } = {}) {
  const sampleDescription = entryCount === undefined ? stsd(entries) : fullBox("stsd", 0, 0, u32(entryCount), ...entries);
  const stbl = box("stbl", sampleDescription, fullBox("stts", 0, 0, u32(0)));
  const minf = box("minf", stbl);
  return box("trak", fullBox("tkhd", 0, 3, Buffer.alloc(80)), box("mdia", fullBox("mdhd", 0, 0, Buffer.alloc(20)), hdlr(handler), minf));
}

const videoTrack = (entryOptions) => track("vide", [videoEntry(entryOptions)]);
const audioTrack = (entryOptions) => track("soun", [audioEntry(entryOptions)]);

function mvhd({ version = 0, timescale = 1000, duration = 3_600_000 } = {}) {
  if (version === 1) return fullBox("mvhd", 1, 0, u64(0), u64(0), u32(timescale), u64(duration), Buffer.alloc(80));
  return fullBox("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80));
}

function moov({ tracks = [videoTrack(), audioTrack()], header = mvhd(), extra = [] } = {}) {
  return box("moov", header, ...tracks, ...extra);
}

function ftyp({ major = "isom", compatible = ["isom", "iso2", "avc1", "mp41"] } = {}) {
  return box("ftyp", ascii(major), u32(512), ...compatible.map(ascii));
}

const mdat = (bytes = 4096) => box("mdat", Buffer.alloc(bytes, 0xab));

/** A complete file: ftyp, then moov first (fast start) or after the media. */
function mp4({ ftypBox = ftyp(), moovBox = moov(), moovFirst = true, media = mdat(), extraTop = [] } = {}) {
  return moovFirst ? Buffer.concat([ftypBox, moovBox, ...extraTop, media]) : Buffer.concat([ftypBox, ...extraTop, media, moovBox]);
}

module.exports = {
  u8, u16, u32, u64, ascii, box, largeBox, fullBox,
  sps, avcC, videoEntry, esds, audioEntry, descriptor,
  hdlr, stsd, track, videoTrack, audioTrack, mvhd, moov, ftyp, mdat, mp4,
};
