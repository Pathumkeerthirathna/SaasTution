/*
 * MP4 validation for recorded lectures (RL-1): MP4 container, H.264 video
 * and AAC audio. Pure TypeScript with no Node imports, so the same code runs
 * on the server (a stored file) and later in the teacher's browser (a
 * selected File, via blobByteSource) for early feedback.
 *
 * A signature is not enough, so the box structure is parsed:
 *
 *  1. "ftyp" must be the first box. A QuickTime brand ("qt  ") is refused;
 *     the major or a compatible brand must be an ISO/MP4 brand.
 *  2. The top-level boxes are walked by their headers only (never reading
 *     media data): exactly one "moov" (start or end of the file), every box
 *     inside the file, size 0 ("to end of file") only for a final "mdat".
 *  3. "moov" (at most maxMoovBytes) is read and parsed:
 *     - every video track ("vide" handler): every sample entry must be
 *       avc1/avc3 (encv = encrypted, refused); its avcC record and first
 *       SPS must show profile Baseline (66), Main (77) or High (100), 4:2:0
 *       chroma and 8-bit samples (High 10, 4:2:2, 4:4:4 are refused);
 *     - every audio track ("soun" handler): every sample entry must be mp4a
 *       (enca refused) whose esds says MPEG-4 Audio (0x40) with audio object
 *       type AAC-LC (2), HE-AAC (5) or HE-AACv2 (29); MP3, AC-3, E-AC-3 and
 *       others are refused;
 *     - other tracks (text, timecode, hint) are ignored.
 *  4. At least one H.264 video track AND at least one AAC audio track.
 *  5. The duration comes from "mvhd" (or "mehd" for fragmented files).
 *
 * Limits keep hostile files cheap: a cap on top-level boxes, on boxes
 * inside moov, on nesting depth and on the moov size; 64-bit sizes must be
 * below 2^53; every box must lie inside its parent.
 *
 * Limitation: this validates the container and codec configuration (what
 * browsers use to decide playback); it does not decode media samples, so a
 * file damaged inside its media data can still fail while playing.
 */

export type Mp4ByteSource = {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
};

export type Mp4RejectionCode =
  | "NOT_MP4"
  | "QUICKTIME_NOT_SUPPORTED"
  | "BRAND_NOT_SUPPORTED"
  | "MALFORMED"
  | "TRUNCATED"
  | "TOO_COMPLEX"
  | "NO_MOOV"
  | "MULTIPLE_MOOV"
  | "MOOV_TOO_LARGE"
  | "ENCRYPTED"
  | "VIDEO_TRACK_REQUIRED"
  | "AUDIO_TRACK_REQUIRED"
  | "VIDEO_CODEC_NOT_SUPPORTED"
  | "H264_PROFILE_NOT_SUPPORTED"
  | "H264_CHROMA_NOT_SUPPORTED"
  | "H264_BIT_DEPTH_NOT_SUPPORTED"
  | "AUDIO_CODEC_NOT_SUPPORTED"
  | "AAC_PROFILE_NOT_SUPPORTED";

export const MP4_REJECTION_MESSAGES: Record<Mp4RejectionCode, string> = {
  NOT_MP4: "The file is not an MP4 video.",
  QUICKTIME_NOT_SUPPORTED: "QuickTime (.mov) files are not supported. Please export the video as MP4.",
  BRAND_NOT_SUPPORTED: "This kind of MP4 file is not supported.",
  MALFORMED: "The MP4 file is damaged or not valid.",
  TRUNCATED: "The MP4 file is incomplete.",
  TOO_COMPLEX: "The MP4 file has an unsupported structure.",
  NO_MOOV: "The MP4 file has no video information (it may be incomplete).",
  MULTIPLE_MOOV: "The MP4 file has an unsupported structure.",
  MOOV_TOO_LARGE: "The MP4 file's video information is too large.",
  ENCRYPTED: "Encrypted (DRM-protected) videos are not supported.",
  VIDEO_TRACK_REQUIRED: "The file has no video track.",
  AUDIO_TRACK_REQUIRED: "The video must include an AAC audio track.",
  VIDEO_CODEC_NOT_SUPPORTED: "Video must be H.264 (AVC).",
  H264_PROFILE_NOT_SUPPORTED: "H.264 video must use the Baseline, Main or High profile.",
  H264_CHROMA_NOT_SUPPORTED: "H.264 video must use 4:2:0 colour.",
  H264_BIT_DEPTH_NOT_SUPPORTED: "H.264 video must be 8-bit.",
  AUDIO_CODEC_NOT_SUPPORTED: "Audio must be AAC.",
  AAC_PROFILE_NOT_SUPPORTED: "AAC audio must be AAC-LC or HE-AAC.",
};

export type Mp4Info = {
  majorBrand: string;
  compatibleBrands: string[];
  fragmented: boolean;
  durationSeconds: number | null;
  /** e.g. "avc1.64001F" (first video track). */
  videoCodec: string;
  /** e.g. "mp4a.40.2" (first audio track). */
  audioCodec: string;
  width: number | null;
  height: number | null;
  videoTrackCount: number;
  audioTrackCount: number;
};

export type Mp4InspectionResult = { ok: true; info: Mp4Info } | { ok: false; code: Mp4RejectionCode; detail?: string };

export type Mp4InspectOptions = {
  maxMoovBytes: number;
  maxTopLevelBoxes?: number;
  maxBoxesInMoov?: number;
  maxDepth?: number;
};

const ALLOWED_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V "]);
const ALLOWED_H264_PROFILES = new Set([66, 77, 100]);
const HIGH_PROFILE_FAMILY = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
const ALLOWED_AAC_OBJECT_TYPES = new Set([2, 5, 29]);
const MPEG4_AUDIO_OTI = 0x40;
/**
 * Top-level boxes walked (header reads only, 16 bytes each, nothing kept per
 * box). Fragmented recordings have several boxes per fragment (styp / sidx /
 * moof / mdat): an 8-hour recording with 1-second fragments is about 115,000.
 * Every box is at least 8 bytes, so the walk is also bounded by the file size.
 */
export const DEFAULT_MAX_TOP_LEVEL_BOXES = 250_000;
const MAX_FTYP_BYTES = 4096;
const TWO_POW_32 = 4294967296;

class Reject extends Error {
  constructor(readonly code: Mp4RejectionCode, readonly detail?: string) {
    super(code);
  }
}

// ---- Byte helpers ---------------------------------------------------------------------------------

function u8(b: Uint8Array, at: number): number {
  if (at < 0 || at >= b.length) throw new Reject("MALFORMED");
  return b[at];
}
function u16(b: Uint8Array, at: number): number {
  return (u8(b, at) << 8) | u8(b, at + 1);
}
function u32(b: Uint8Array, at: number): number {
  return u8(b, at) * 0x1000000 + ((u8(b, at + 1) << 16) | (u8(b, at + 2) << 8) | u8(b, at + 3));
}
function u64(b: Uint8Array, at: number): number {
  const high = u32(b, at);
  const low = u32(b, at + 4);
  if (high >= 0x200000) throw new Reject("MALFORMED"); // >= 2^53
  return high * TWO_POW_32 + low;
}
function fourcc(b: Uint8Array, at: number): string {
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    const c = u8(b, at + i);
    if (c < 0x20 || c > 0x7e) throw new Reject("MALFORMED");
    out += String.fromCharCode(c);
  }
  return out;
}
function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

type Box = { type: string; start: number; end: number; payload: number };

/** Box header at `offset` inside [offset, limit). */
function parseHeader(b: Uint8Array, offset: number, limit: number, allowToEnd: (type: string) => boolean): Box {
  if (limit - offset < 8) throw new Reject("TRUNCATED");
  const size32 = u32(b, offset);
  const type = fourcc(b, offset + 4);
  let size: number;
  let header = 8;
  if (size32 === 1) {
    if (limit - offset < 16) throw new Reject("TRUNCATED");
    size = u64(b, offset + 8);
    header = 16;
  } else if (size32 === 0) {
    if (!allowToEnd(type)) throw new Reject("MALFORMED");
    size = limit - offset;
  } else {
    size = size32;
  }
  if (size < header) throw new Reject("MALFORMED");
  if (offset + size > limit) throw new Reject("TRUNCATED");
  return { type, start: offset, end: offset + size, payload: offset + header };
}

// ---- In-memory walking (inside moov) ---------------------------------------------------------------

type Walk = { boxes: number; maxBoxes: number; maxDepth: number };

type ChildOptions = {
  /** QuickTime "wave" boxes end with a terminator atom: size 8, type 00 00 00 00. */
  quickTimeTerminator?: boolean;
};

function isAllZero(b: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) if (b[i] !== 0) return false;
  return true;
}

function children(b: Uint8Array, start: number, end: number, walk: Walk, depth: number, options: ChildOptions = {}): Box[] {
  if (depth > walk.maxDepth) throw new Reject("TOO_COMPLEX");
  const out: Box[] = [];
  let offset = start;
  while (offset < end) {
    // Fewer than 8 bytes cannot hold a box: accepted only as zero padding
    // (some encoders pad a container); any non-zero byte is an error.
    if (end - offset < 8) {
      if (isAllZero(b, offset, end)) break;
      throw new Reject("TRUNCATED");
    }
    if (options.quickTimeTerminator && u32(b, offset) === 8 && isAllZero(b, offset + 4, offset + 8)) {
      // The terminator must be last (optionally followed by zero padding).
      const rest = offset + 8;
      if (end - rest < 8 && isAllZero(b, rest, end)) break;
      throw new Reject("MALFORMED");
    }
    walk.boxes += 1;
    if (walk.boxes > walk.maxBoxes) throw new Reject("TOO_COMPLEX");
    const box = parseHeader(b, offset, end, () => true);
    out.push(box);
    offset = box.end;
  }
  return out;
}

function child(boxes: Box[], type: string): Box | undefined {
  return boxes.find((box) => box.type === type);
}

// ---- H.264 ---------------------------------------------------------------------------------------

class BitReader {
  private bit = 0;
  constructor(private readonly bytes: Uint8Array) {}
  readBit(): number {
    const byte = this.bit >> 3;
    if (byte >= this.bytes.length) throw new Reject("MALFORMED");
    const value = (this.bytes[byte] >> (7 - (this.bit & 7))) & 1;
    this.bit += 1;
    return value;
  }
  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = value * 2 + this.readBit();
    return value;
  }
  readUe(): number {
    let zeros = 0;
    while (this.readBit() === 0) {
      zeros += 1;
      if (zeros > 31) throw new Reject("MALFORMED");
    }
    return 2 ** zeros - 1 + this.readBits(zeros);
  }
}

/** NAL payload without emulation-prevention bytes (00 00 03 -> 00 00). */
function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

type H264Config = { profile: number; compatibility: number; level: number };

function parseAvcC(b: Uint8Array, start: number, end: number): H264Config {
  if (end - start < 7) throw new Reject("MALFORMED");
  if (u8(b, start) !== 1) throw new Reject("MALFORMED");
  const profile = u8(b, start + 1);
  const compatibility = u8(b, start + 2);
  const level = u8(b, start + 3);
  const spsCount = u8(b, start + 5) & 0x1f;
  if (spsCount < 1) throw new Reject("MALFORMED");
  const spsLength = u16(b, start + 6);
  const spsStart = start + 8;
  if (spsLength < 4 || spsStart + spsLength > end) throw new Reject("MALFORMED");

  const nal = b.subarray(spsStart, spsStart + spsLength);
  if ((nal[0] & 0x1f) !== 7) throw new Reject("MALFORMED");
  const bits = new BitReader(unescapeRbsp(nal.subarray(1)));
  const spsProfile = bits.readBits(8);
  bits.readBits(8); // constraint flags
  bits.readBits(8); // level
  const spsId = bits.readUe();
  if (spsId > 31) throw new Reject("MALFORMED");
  if (spsProfile !== profile) throw new Reject("MALFORMED");

  let chroma = 1;
  let lumaDepthMinus8 = 0;
  let chromaDepthMinus8 = 0;
  if (HIGH_PROFILE_FAMILY.has(spsProfile)) {
    chroma = bits.readUe();
    if (chroma === 3) bits.readBit(); // separate_colour_plane_flag
    lumaDepthMinus8 = bits.readUe();
    chromaDepthMinus8 = bits.readUe();
  }

  if (!ALLOWED_H264_PROFILES.has(spsProfile)) throw new Reject("H264_PROFILE_NOT_SUPPORTED", String(spsProfile));
  if (chroma !== 1) throw new Reject("H264_CHROMA_NOT_SUPPORTED", String(chroma));
  if (lumaDepthMinus8 !== 0 || chromaDepthMinus8 !== 0) throw new Reject("H264_BIT_DEPTH_NOT_SUPPORTED");
  return { profile, compatibility, level };
}

type VideoTrack = { codec: string; width: number; height: number };

function parseVideoEntry(b: Uint8Array, entry: Box, walk: Walk, depth: number): VideoTrack {
  if (entry.type === "encv") throw new Reject("ENCRYPTED");
  if (entry.type !== "avc1" && entry.type !== "avc3") throw new Reject("VIDEO_CODEC_NOT_SUPPORTED", entry.type);
  // SampleEntry (8) + VisualSampleEntry fields (70) precede the child boxes.
  const childStart = entry.payload + 78;
  if (childStart > entry.end) throw new Reject("MALFORMED");
  const width = u16(b, entry.payload + 24);
  const height = u16(b, entry.payload + 26);
  const avcC = child(children(b, childStart, entry.end, walk, depth + 1), "avcC");
  if (!avcC) throw new Reject("MALFORMED");
  const config = parseAvcC(b, avcC.payload, avcC.end);
  return {
    codec: `${entry.type}.${hex2(config.profile)}${hex2(config.compatibility)}${hex2(config.level)}`,
    width,
    height,
  };
}

// ---- AAC -----------------------------------------------------------------------------------------

function readDescriptor(b: Uint8Array, at: number, end: number): { tag: number; start: number; end: number } {
  const tag = u8(b, at);
  let length = 0;
  let cursor = at + 1;
  for (let i = 0; i < 4; i += 1) {
    const byte = u8(b, cursor);
    cursor += 1;
    length = length * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
    if (i === 3) throw new Reject("MALFORMED");
  }
  if (cursor + length > end) throw new Reject("MALFORMED");
  return { tag, start: cursor, end: cursor + length };
}

function parseEsds(b: Uint8Array, start: number, end: number): number {
  // FullBox version/flags, then ES_Descriptor (tag 3).
  const es = readDescriptor(b, start + 4, end);
  if (es.tag !== 0x03) throw new Reject("MALFORMED");
  let cursor = es.start + 2; // ES_ID
  const flags = u8(b, cursor);
  cursor += 1;
  if (flags & 0x80) cursor += 2; // dependsOn_ES_ID
  if (flags & 0x40) cursor += 1 + u8(b, cursor); // URL
  if (flags & 0x20) cursor += 2; // OCR_ES_Id

  const decoderConfig = readDescriptor(b, cursor, es.end);
  if (decoderConfig.tag !== 0x04) throw new Reject("MALFORMED");
  const objectType = u8(b, decoderConfig.start);
  if (objectType !== MPEG4_AUDIO_OTI) throw new Reject("AUDIO_CODEC_NOT_SUPPORTED", `0x${hex2(objectType)}`);

  const specific = readDescriptor(b, decoderConfig.start + 13, decoderConfig.end);
  if (specific.tag !== 0x05 || specific.end - specific.start < 2) throw new Reject("MALFORMED");
  const bits = new BitReader(b.subarray(specific.start, specific.end));
  let audioObjectType = bits.readBits(5);
  if (audioObjectType === 31) audioObjectType = 32 + bits.readBits(6);
  if (!ALLOWED_AAC_OBJECT_TYPES.has(audioObjectType)) throw new Reject("AAC_PROFILE_NOT_SUPPORTED", String(audioObjectType));
  return audioObjectType;
}

function parseAudioEntry(b: Uint8Array, entry: Box, walk: Walk, depth: number): string {
  if (entry.type === "enca") throw new Reject("ENCRYPTED");
  if (entry.type !== "mp4a") throw new Reject("AUDIO_CODEC_NOT_SUPPORTED", entry.type);
  // SampleEntry (8) + AudioSampleEntry (20); QuickTime sound description v1 / v2 add 16 / 36 bytes.
  const version = u16(b, entry.payload + 8);
  const fields = version === 0 ? 28 : version === 1 ? 44 : version === 2 ? 64 : -1;
  if (fields < 0) throw new Reject("MALFORMED");
  const childStart = entry.payload + fields;
  if (childStart > entry.end) throw new Reject("MALFORMED");

  const boxes = children(b, childStart, entry.end, walk, depth + 1);
  let esds = child(boxes, "esds");
  if (!esds) {
    const wave = child(boxes, "wave");
    if (wave) esds = child(children(b, wave.payload, wave.end, walk, depth + 2, { quickTimeTerminator: true }), "esds");
  }
  if (!esds) throw new Reject("MALFORMED");
  return `mp4a.40.${parseEsds(b, esds.payload, esds.end)}`;
}

// ---- Tracks and movie ----------------------------------------------------------------------------

type TrackResult = { kind: "video"; track: VideoTrack } | { kind: "audio"; codec: string } | { kind: "other" };

function parseTrack(b: Uint8Array, trak: Box, walk: Walk, depth: number): TrackResult {
  const mdia = child(children(b, trak.payload, trak.end, walk, depth + 1), "mdia");
  if (!mdia) throw new Reject("MALFORMED");
  const mdiaBoxes = children(b, mdia.payload, mdia.end, walk, depth + 2);
  const hdlr = child(mdiaBoxes, "hdlr");
  if (!hdlr) throw new Reject("MALFORMED");
  const handler = fourcc(b, hdlr.payload + 8);
  if (handler !== "vide" && handler !== "soun") return { kind: "other" };

  const minf = child(mdiaBoxes, "minf");
  const stbl = minf && child(children(b, minf.payload, minf.end, walk, depth + 3), "stbl");
  const stsd = stbl && child(children(b, stbl.payload, stbl.end, walk, depth + 4), "stsd");
  if (!stsd) throw new Reject("MALFORMED");

  const entryCount = u32(b, stsd.payload + 4);
  const entries = children(b, stsd.payload + 8, stsd.end, walk, depth + 5);
  if (entryCount < 1 || entries.length !== entryCount) throw new Reject("MALFORMED");

  if (handler === "vide") {
    const tracks = entries.map((entry) => parseVideoEntry(b, entry, walk, depth + 6));
    return { kind: "video", track: tracks[0] };
  }
  const codecs = entries.map((entry) => parseAudioEntry(b, entry, walk, depth + 6));
  return { kind: "audio", codec: codecs[0] };
}

function durationFrom(duration: number, timescale: number): number | null {
  if (timescale === 0 || duration === 0) return null;
  return Math.round(duration / timescale);
}

function parseMovieHeader(b: Uint8Array, mvhd: Box): { timescale: number; durationSeconds: number | null } {
  const version = u8(b, mvhd.payload);
  if (version === 0) {
    const timescale = u32(b, mvhd.payload + 12);
    const duration = u32(b, mvhd.payload + 16);
    return { timescale, durationSeconds: duration === 0xffffffff ? null : durationFrom(duration, timescale) };
  }
  if (version === 1) {
    const timescale = u32(b, mvhd.payload + 20);
    const high = u32(b, mvhd.payload + 24);
    if (high === 0xffffffff) return { timescale, durationSeconds: null };
    return { timescale, durationSeconds: durationFrom(u64(b, mvhd.payload + 24), timescale) };
  }
  throw new Reject("MALFORMED");
}

function parseMoov(b: Uint8Array, options: Required<Pick<Mp4InspectOptions, "maxBoxesInMoov" | "maxDepth">>) {
  const walk: Walk = { boxes: 0, maxBoxes: options.maxBoxesInMoov, maxDepth: options.maxDepth };
  const top = children(b, 0, b.length, walk, 0);

  const mvhd = child(top, "mvhd");
  if (!mvhd) throw new Reject("MALFORMED");
  const movie = parseMovieHeader(b, mvhd);
  let durationSeconds = movie.durationSeconds;

  const mvex = child(top, "mvex");
  if (mvex && durationSeconds === null) {
    const mehd = child(children(b, mvex.payload, mvex.end, walk, 1), "mehd");
    if (mehd) {
      const version = u8(b, mehd.payload);
      const fragmentDuration = version === 1 ? u64(b, mehd.payload + 4) : u32(b, mehd.payload + 4);
      durationSeconds = durationFrom(fragmentDuration, movie.timescale);
    }
  }

  const video: VideoTrack[] = [];
  const audio: string[] = [];
  for (const trak of top.filter((box) => box.type === "trak")) {
    const result = parseTrack(b, trak, walk, 1);
    if (result.kind === "video") video.push(result.track);
    else if (result.kind === "audio") audio.push(result.codec);
  }

  if (video.length === 0) throw new Reject("VIDEO_TRACK_REQUIRED");
  if (audio.length === 0) throw new Reject("AUDIO_TRACK_REQUIRED");
  return { durationSeconds, fragmented: Boolean(mvex), video, audio };
}

// ---- Entry point ---------------------------------------------------------------------------------

async function readExactly(source: Mp4ByteSource, offset: number, length: number): Promise<Uint8Array> {
  const bytes = await source.read(offset, length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Reject("TRUNCATED");
  return bytes;
}

type TopBox = Box & { toEnd: boolean };

/** A top-level box header read from the source; its size is checked against the file size. */
async function readTopHeader(source: Mp4ByteSource, offset: number): Promise<TopBox> {
  const available = Math.min(16, source.size - offset);
  if (available < 8) throw new Reject("TRUNCATED");
  const bytes = await readExactly(source, offset, available);
  const size32 = u32(bytes, 0);
  const type = fourcc(bytes, 4);
  let size: number;
  let header = 8;
  if (size32 === 1) {
    if (bytes.length < 16) throw new Reject("TRUNCATED");
    size = u64(bytes, 8);
    header = 16;
  } else if (size32 === 0) {
    size = source.size - offset;
  } else {
    size = size32;
  }
  if (size < header) throw new Reject("MALFORMED");
  if (offset + size > source.size) throw new Reject("TRUNCATED");
  return { type, start: offset, end: offset + size, payload: offset + header, toEnd: size32 === 0 };
}

export async function inspectMp4(source: Mp4ByteSource, options: Mp4InspectOptions): Promise<Mp4InspectionResult> {
  const maxTopLevelBoxes = options.maxTopLevelBoxes ?? DEFAULT_MAX_TOP_LEVEL_BOXES;
  const maxBoxesInMoov = options.maxBoxesInMoov ?? 100_000;
  const maxDepth = options.maxDepth ?? 16;

  try {
    if (!Number.isSafeInteger(source.size) || source.size < 8) throw new Reject("NOT_MP4");

    // 1. ftyp first.
    let ftyp: TopBox;
    try {
      ftyp = await readTopHeader(source, 0);
    } catch (error) {
      if (error instanceof Reject && (error.code === "MALFORMED" || error.code === "TRUNCATED")) throw new Reject("NOT_MP4");
      throw error;
    }
    if (ftyp.type !== "ftyp" || ftyp.toEnd || ftyp.end - ftyp.start > MAX_FTYP_BYTES || ftyp.end - ftyp.payload < 8) {
      throw new Reject("NOT_MP4");
    }
    const ftypBytes = await readExactly(source, ftyp.payload, ftyp.end - ftyp.payload);
    const majorBrand = fourcc(ftypBytes, 0);
    const compatibleBrands: string[] = [];
    for (let at = 8; at + 4 <= ftypBytes.length; at += 4) compatibleBrands.push(fourcc(ftypBytes, at));
    if (majorBrand === "qt  ") throw new Reject("QUICKTIME_NOT_SUPPORTED");
    if (!ALLOWED_BRANDS.has(majorBrand) && !compatibleBrands.some((brand) => ALLOWED_BRANDS.has(brand))) {
      throw new Reject("BRAND_NOT_SUPPORTED", majorBrand);
    }

    // 2. Top-level boxes by header only.
    const moovs: Box[] = [];
    let offset = ftyp.end;
    let count = 0;
    while (offset < source.size) {
      count += 1;
      if (count > maxTopLevelBoxes) throw new Reject("TOO_COMPLEX");
      const box = await readTopHeader(source, offset);
      if (box.toEnd && box.type !== "mdat") throw new Reject("MALFORMED");
      if (box.type === "ftyp") throw new Reject("MALFORMED");
      if (box.type === "moov") moovs.push(box);
      offset = box.end;
    }
    if (moovs.length === 0) throw new Reject("NO_MOOV");
    if (moovs.length > 1) throw new Reject("MULTIPLE_MOOV");

    // 3. moov, bounded.
    const moov = moovs[0];
    const moovLength = moov.end - moov.payload;
    if (moovLength > options.maxMoovBytes) throw new Reject("MOOV_TOO_LARGE");
    const moovBytes = await readExactly(source, moov.payload, moovLength);
    const parsed = parseMoov(moovBytes, { maxBoxesInMoov, maxDepth });

    return {
      ok: true,
      info: {
        majorBrand,
        compatibleBrands,
        fragmented: parsed.fragmented,
        durationSeconds: parsed.durationSeconds,
        videoCodec: parsed.video[0].codec,
        audioCodec: parsed.audio[0],
        width: parsed.video[0].width || null,
        height: parsed.video[0].height || null,
        videoTrackCount: parsed.video.length,
        audioTrackCount: parsed.audio.length,
      },
    };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, code: error.code, ...(error.detail ? { detail: error.detail } : {}) };
    throw error;
  }
}

/** A byte source over a Blob / File (browser or Node), reading only the requested slices. */
export function blobByteSource(blob: Blob): Mp4ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

/** A byte source over bytes already in memory (tests, small files). */
export function bytesByteSource(bytes: Uint8Array): Mp4ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.slice(offset, offset + length),
  };
}
