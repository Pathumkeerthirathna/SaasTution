/*
 * Codec test: summarises "chrome://webrtc-internals" dumps (the "Create
 * dump" / "Download the PeerConnection updates and stats data" file) from
 * the teacher and the student, and checks whether an arm actually ran as
 * requested.
 *
 * Dump format (Chrome): { PeerConnections: { <pc>: { url, stats: {
 *   "<statId>-<property>": { statsType, startTime, endTime, values } } } } }
 * where `values` is a JSON-encoded array (sometimes a real array) of the
 * samples, evenly spaced between startTime and endTime. Statistic ids can
 * contain "-", properties cannot, so a key is split at its LAST "-".
 *
 * Anything missing is reported as null ("unavailable"), never estimated.
 * Local only: nothing here reads the network or sends data anywhere.
 *
 * Verdicts (evaluateArm) judge ONE test room: connections are matched by
 * the room in their recorded page URL, so a dump holding several arms or
 * runs never mixes them; no single identifiable room means UNCONFIRMED.
 * The codec is the negotiated one over the whole call (codecId samples ->
 * codec mimeType). The 15 fps condition is checked on the measured frame
 * rate: a constraint in the meeting URL is only a request that Jitsi, the
 * browser or the camera may not honour. Arm C's raised cap is evidenced
 * only by what was SENT: the single active AV1 encoding's retransmission-
 * free rate held above 1.05 Mbps for 30 s at up to 720p (targetBitrate is
 * informational: for SVC it can be one layer's target). That shows an
 * effective cap above the default; the configured maxBitrate itself is not
 * in WebRTC stats.
 */

import { ARMS, DEFAULT_AV1_HIGH_BITRATE, type Arm } from "./arms";

type Series = {
  values: unknown[];
  startTime: number | null;
  endTime: number | null;
};

type StatObject = {
  id: string;
  type: string;
  props: Map<string, Series>;
};

export type CodecInfo = {
  codecId: string;
  mimeType: string | null;
  payloadType: number | null;
  sdpFmtpLine: string | null;
};

export type OutboundVideo = {
  statId: string;
  rid: string | null;
  ssrc: number | null;
  active: boolean | null;
  codec: CodecInfo | null;
  /** Every codec the stream used, in order (null: codec not recorded). */
  codecHistory: Array<string | null>;
  frameWidth: number | null;
  frameHeight: number | null;
  /** Highest frameHeight sample in the dump. */
  maxFrameHeight: number | null;
  framesPerSecond: number | null;
  /** Median of the framesPerSecond samples (robust to start-up dips). */
  framesPerSecondMedian: number | null;
  framesEncoded: number | null;
  /**
   * Informational only: for SVC (AV1 / VP9 "L3T3..."), Chrome's
   * targetBitrate may not be the whole stream's rate (it can be far below
   * what is actually sent), so it is never used as cap evidence.
   */
  targetBitrate: number | null;
  /** Highest targetBitrate sample in the dump (informational, see above). */
  maxTargetBitrate: number | null;
  bytesSent: number | null;
  /**
   * From bytesSent, retransmissions included (gross): the last ~10 samples,
   * and the whole dump.
   */
  sendBitrateRecent: number | null;
  sendBitrateAverage: number | null;
  /** Sustained send rate without retransmissions (see analyseSendRate). */
  sendRate: SendRateAnalysis;
  retransmittedBytesSent: number | null;
  retransmittedPacketsSent: number | null;
  packetsSent: number | null;
  nackCount: number | null;
  pliCount: number | null;
  firCount: number | null;
  keyFramesEncoded: number | null;
  qualityLimitationReason: string | null;
  /** Seconds spent per limitation reason ("none", "bandwidth", "cpu", "other"). */
  qualityLimitationDurations: Record<string, number> | null;
  qualityLimitationResolutionChanges: number | null;
  scalabilityMode: string | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
};

export type SendRateAnalysis = {
  /** Length of the bytesSent series with valid timestamps (seconds). */
  measurementSeconds: number | null;
  sampleIntervalSeconds: number | null;
  /** Whole observation, retransmissions included (bits/s). */
  grossAverage: number | null;
  /** Whole observation, retransmissions removed (bits/s). */
  netAverage: number | null;
  /** Share of the sent bytes that were retransmissions (0..1). */
  retransmissionShare: number | null;
  /**
   * The best SUSTAINED_WINDOW_SECONDS window of the retransmission-free rate:
   * its average and the median of its per-sample rates (bits/s). The window
   * whose lower of the two is highest; a short spike lifts the average but
   * not the median.
   */
  sustainedWindowSeconds: number | null;
  sustainedNetAverage: number | null;
  sustainedNetMedian: number | null;
  /** Why the net / sustained figures are unavailable (null: computed). */
  issue: string | null;
};

export type InboundVideo = {
  statId: string;
  ssrc: number | null;
  codec: CodecInfo | null;
  codecHistory: Array<string | null>;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
  packetsReceived: number | null;
  packetsLost: number | null;
  freezeCount: number | null;
  totalFreezesDuration: number | null;
  receiveBitrateRecent: number | null;
  nackCount: number | null;
  pliCount: number | null;
  firCount: number | null;
  keyFramesDecoded: number | null;
  /**
   * Per minute over the dump's window (counter increase / window length),
   * null unless the window is at least MIN_NORMALISE_SECONDS long with valid
   * timestamps. The counters themselves (above) count since the stream
   * started, which can be before the dump's window.
   */
  perMinute: {
    windowSeconds: number;
    freezes: number | null;
    frozenSeconds: number | null;
    framesDropped: number | null;
  } | null;
  decoderImplementation: string | null;
};

export type ConnectionInfo = {
  candidatePairId: string;
  availableOutgoingBitrate: number | null;
  maxAvailableOutgoingBitrate: number | null;
  availableIncomingBitrate: number | null;
  /** Milliseconds. */
  currentRoundTripTimeMs: number | null;
};

export type PeerConnectionSummary = {
  key: string;
  url: string | null;
  /** The meeting room, from the page URL's path (null: not recorded). */
  room: string | null;
  outbound: OutboundVideo[];
  inbound: InboundVideo[];
  connection: ConnectionInfo | null;
};

export type DumpSummary = {
  peerConnections: PeerConnectionSummary[];
  warnings: string[];
};

export class DumpError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toSamples(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);

      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  return value === undefined || value === null ? [] : [value];
}

function readStats(stats: Record<string, unknown>): Map<string, StatObject> {
  const objects = new Map<string, StatObject>();

  for (const [key, raw] of Object.entries(stats)) {
    const entry = asRecord(raw);
    const split = key.lastIndexOf("-");

    if (!entry || split <= 0 || split === key.length - 1) {
      continue;
    }

    const id = key.slice(0, split);
    const prop = key.slice(split + 1);
    const object = objects.get(id) ?? { id, type: "", props: new Map<string, Series>() };

    if (typeof entry.statsType === "string" && entry.statsType) {
      object.type = entry.statsType;
    }

    object.props.set(prop, {
      values: toSamples(entry.values),
      startTime: toTime(entry.startTime),
      endTime: toTime(entry.endTime),
    });
    objects.set(id, object);
  }

  return objects;
}

function lastValue(object: StatObject | undefined, prop: string): unknown {
  const values = object?.props.get(prop)?.values;

  return values && values.length ? values[values.length - 1] : undefined;
}

function num(object: StatObject | undefined, prop: string): number | null {
  const value = lastValue(object, prop);
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function str(object: StatObject | undefined, prop: string): string | null {
  const value = lastValue(object, prop);

  return typeof value === "string" && value !== "" ? value : null;
}

function bool(object: StatObject | undefined, prop: string): boolean | null {
  const value = lastValue(object, prop);

  if (typeof value === "boolean") {
    return value;
  }

  return value === "true" ? true : value === "false" ? false : null;
}

function numericSamples(object: StatObject | undefined, prop: string): number[] {
  return (object?.props.get(prop)?.values ?? [])
    .map((value) => (typeof value === "string" ? Number(value) : value))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function maxSample(object: StatObject | undefined, prop: string): number | null {
  const samples = numericSamples(object, prop);

  return samples.length ? Math.max(...samples) : null;
}

function medianSample(object: StatObject | undefined, prop: string): number | null {
  const samples = numericSamples(object, prop).sort((a, b) => a - b);

  if (!samples.length) {
    return null;
  }

  const middle = Math.floor(samples.length / 2);

  return samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
}

/**
 * Every codec a stream used during the dump, in order (consecutive repeats
 * merged): its codecId samples, each looked up to its mimeType. A codecId
 * whose codec statistic is missing gives null. No codecId at all: [null].
 */
function codecHistoryOf(objects: Map<string, StatObject>, object: StatObject): Array<string | null> {
  const ids = (object.props.get("codecId")?.values ?? [])
    .filter((value): value is string => typeof value === "string" && value !== "");
  const history: Array<string | null> = [];
  let previous: string | undefined;

  for (const id of ids) {
    if (id !== previous) {
      history.push(str(objects.get(id), "mimeType"));
      previous = id;
    }
  }

  return history.length ? history : [null];
}

/** "https://host/sl-codec-test-b-...?jwt=..." -> "sl-codec-test-b-...". */
function roomFromUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }

  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const last = segments.length ? decodeURIComponent(segments[segments.length - 1]).toLowerCase() : "";

    return last || null;
  } catch {
    return null;
  }
}

/**
 * Bits per second from a byte counter: over the last `window` sample
 * intervals, or the whole series (window null). null when the timing is not
 * in the dump.
 */
function bitrate(object: StatObject | undefined, prop: string, window: number | null): number | null {
  const series = object?.props.get(prop);

  if (!series || series.startTime === null || series.endTime === null) {
    return null;
  }

  const samples = series.values.map((value) => (typeof value === "string" ? Number(value) : value));

  if (samples.length < 2 || !samples.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }

  const values = samples as number[];
  const span = series.endTime - series.startTime;
  const intervals = values.length - 1;

  if (span <= 0) {
    return null;
  }

  const used = window === null ? intervals : Math.min(window, intervals);
  const delta = values[values.length - 1] - values[values.length - 1 - used];
  const seconds = (span / intervals) * used / 1000;

  return delta >= 0 && seconds > 0 ? Math.round((delta * 8) / seconds) : null;
}

// ---- Timed series, sustained send rate, per-minute rates ----------------------

/** Chrome samples about once a second; spacing outside this is not trusted. */
const MIN_SAMPLE_INTERVAL_MS = 200;
const MAX_SAMPLE_INTERVAL_MS = 10_000;
/** Length of the window a send rate must hold for ("sustained"). */
export const SUSTAINED_WINDOW_SECONDS = 30;
/** Shortest window per-minute rates are calculated over. */
export const MIN_NORMALISE_SECONDS = 30;

type TimedSeries = { values: number[]; startTime: number; endTime: number; intervalMs: number };

/**
 * A counter's samples with usable timing: every sample numeric, at least two,
 * end after start, plausible spacing. Otherwise the reason it is unusable.
 */
function timedSeries(object: StatObject | undefined, prop: string): { series: TimedSeries | null; issue: string | null } {
  const raw = object?.props.get(prop);

  if (!raw) {
    return { series: null, issue: `${prop} not recorded` };
  }

  const values = raw.values.map((value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value));

  if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) {
    return { series: null, issue: `${prop} has non-numeric samples` };
  }

  if (values.length < 2) {
    return { series: null, issue: `${prop} has fewer than 2 samples` };
  }

  if (raw.startTime === null || raw.endTime === null || raw.endTime <= raw.startTime) {
    return { series: null, issue: `${prop} has no valid timestamps` };
  }

  const intervalMs = (raw.endTime - raw.startTime) / (values.length - 1);

  if (intervalMs < MIN_SAMPLE_INTERVAL_MS || intervalMs > MAX_SAMPLE_INTERVAL_MS) {
    return { series: null, issue: `${prop} sample spacing of ${Math.round(intervalMs)} ms is implausible` };
  }

  return { series: { values, startTime: raw.startTime, endTime: raw.endTime, intervalMs }, issue: null };
}

function isNonDecreasing(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value >= values[index - 1]);
}

function median(values: number[]): number | null {
  if (!values.length) {
    return null;
  }

  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The send rate as bytes actually show it. bytesSent (payload, no headers
 * or padding, retransmissions included) minus retransmittedBytesSent, both
 * aligned sample by sample with valid timestamps; then the best
 * SUSTAINED_WINDOW_SECONDS window. Anything unreliable gives `issue` and no
 * net / sustained figures (the gross average is kept, labelled as such).
 */
function analyseSendRate(object: StatObject): SendRateAnalysis {
  const empty: SendRateAnalysis = {
    measurementSeconds: null,
    sampleIntervalSeconds: null,
    grossAverage: null,
    netAverage: null,
    retransmissionShare: null,
    sustainedWindowSeconds: null,
    sustainedNetAverage: null,
    sustainedNetMedian: null,
    issue: null,
  };
  const { series: bytes, issue: bytesIssue } = timedSeries(object, "bytesSent");

  if (!bytes) {
    return { ...empty, issue: bytesIssue };
  }

  if (!isNonDecreasing(bytes.values)) {
    return { ...empty, issue: "bytesSent went backwards (counter reset)" };
  }

  const spanSeconds = (bytes.endTime - bytes.startTime) / 1000;
  const intervalSeconds = bytes.intervalMs / 1000;
  const first = bytes.values[0];
  const last = bytes.values[bytes.values.length - 1];
  const result: SendRateAnalysis = {
    ...empty,
    measurementSeconds: Math.round(spanSeconds * 10) / 10,
    sampleIntervalSeconds: Math.round(intervalSeconds * 1000) / 1000,
    grossAverage: Math.round(((last - first) * 8) / spanSeconds),
  };

  const { series: retransmitted, issue: retransmittedIssue } = timedSeries(object, "retransmittedBytesSent");

  if (!retransmitted) {
    return { ...result, issue: `retransmission data unavailable (${retransmittedIssue})` };
  }

  if (retransmitted.values.length !== bytes.values.length
    || Math.abs(retransmitted.startTime - bytes.startTime) > 1
    || Math.abs(retransmitted.endTime - bytes.endTime) > 1) {
    return { ...result, issue: "retransmission data unreliable (not aligned with bytesSent)" };
  }

  if (!isNonDecreasing(retransmitted.values)
    || retransmitted.values.some((value, index) => value > bytes.values[index])) {
    return { ...result, issue: "retransmission data unreliable (decreasing, or larger than bytesSent)" };
  }

  const net = bytes.values.map((value, index) => value - retransmitted.values[index]);

  if (!isNonDecreasing(net)) {
    return { ...result, issue: "retransmission data unreliable (net bytes went backwards)" };
  }

  const sentDelta = last - first;
  const retransmittedDelta = retransmitted.values[retransmitted.values.length - 1] - retransmitted.values[0];

  result.netAverage = Math.round(((net[net.length - 1] - net[0]) * 8) / spanSeconds);
  result.retransmissionShare = sentDelta > 0 ? Math.round((retransmittedDelta / sentDelta) * 1000) / 1000 : null;

  const intervals = net.length - 1;
  const windowIntervals = Math.ceil(SUSTAINED_WINDOW_SECONDS / intervalSeconds);

  if (windowIntervals > intervals) {
    return {
      ...result,
      issue: `observed for ${result.measurementSeconds} s, shorter than the ${SUSTAINED_WINDOW_SECONDS} s window a sustained rate needs`,
    };
  }

  const perSample = net.slice(1).map((value, index) => ((value - net[index]) * 8) / intervalSeconds);
  let best: { average: number; median: number } | null = null;

  for (let end = windowIntervals; end <= intervals; end += 1) {
    const average = ((net[end] - net[end - windowIntervals]) * 8) / (windowIntervals * intervalSeconds);
    const middle = median(perSample.slice(end - windowIntervals, end)) as number;

    if (!best || Math.min(average, middle) > Math.min(best.average, best.median)) {
      best = { average, median: middle };
    }
  }

  return {
    ...result,
    sustainedWindowSeconds: Math.round(windowIntervals * intervalSeconds * 10) / 10,
    sustainedNetAverage: best ? Math.round(best.average) : null,
    sustainedNetMedian: best ? Math.round(best.median) : null,
  };
}

/**
 * Counter increase per minute over the dump's window, or null without a
 * reliable window (timestamps, at least MIN_NORMALISE_SECONDS, never
 * decreasing). A missing counter stays null, never 0.
 */
function ratePerMinute(object: StatObject, prop: string): { value: number; windowSeconds: number } | null {
  const { series } = timedSeries(object, prop);

  if (!series || !isNonDecreasing(series.values)) {
    return null;
  }

  const windowSeconds = (series.endTime - series.startTime) / 1000;

  if (windowSeconds < MIN_NORMALISE_SECONDS) {
    return null;
  }

  const delta = series.values[series.values.length - 1] - series.values[0];

  return { value: Math.round((delta / (windowSeconds / 60)) * 100) / 100, windowSeconds };
}

function perMinuteOf(object: StatObject): InboundVideo["perMinute"] {
  const freezes = ratePerMinute(object, "freezeCount");
  const frozen = ratePerMinute(object, "totalFreezesDuration");
  const dropped = ratePerMinute(object, "framesDropped");
  const windows = [freezes, frozen, dropped].filter((rate): rate is { value: number; windowSeconds: number } => rate !== null);

  if (!windows.length) {
    return null;
  }

  return {
    windowSeconds: Math.round(Math.min(...windows.map((rate) => rate.windowSeconds)) * 10) / 10,
    freezes: freezes?.value ?? null,
    frozenSeconds: frozen?.value ?? null,
    framesDropped: dropped?.value ?? null,
  };
}

/** A record-valued statistic (e.g. qualityLimitationDurations), numbers only. */
function recordOf(object: StatObject, prop: string): Record<string, number> | null {
  let value = lastValue(object, prop);

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const numbers = Object.fromEntries(Object.entries(record)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));

  return Object.keys(numbers).length ? numbers : null;
}

function codecOf(objects: Map<string, StatObject>, codecId: string | null): CodecInfo | null {
  if (!codecId) {
    return null;
  }

  const codec = objects.get(codecId);

  return {
    codecId,
    mimeType: str(codec, "mimeType"),
    payloadType: num(codec, "payloadType"),
    sdpFmtpLine: str(codec, "sdpFmtpLine"),
  };
}

function isVideo(object: StatObject): boolean {
  return (str(object, "kind") ?? str(object, "mediaType")) === "video";
}

function summariseConnection(objects: Map<string, StatObject>): ConnectionInfo | null {
  const all = Array.from(objects.values());
  const transport = all.find((object) => object.type === "transport" && str(object, "selectedCandidatePairId"));
  let pair = transport ? objects.get(str(transport, "selectedCandidatePairId") as string) : undefined;

  // No selected pair recorded: the nominated pair that carried the most data.
  if (!pair) {
    pair = all
      .filter((object) => object.type === "candidate-pair" && bool(object, "nominated") !== false)
      .sort((a, b) => (num(b, "bytesSent") ?? -1) - (num(a, "bytesSent") ?? -1))[0];
  }

  if (!pair) {
    return null;
  }

  const rtt = num(pair, "currentRoundTripTime");

  return {
    candidatePairId: pair.id,
    availableOutgoingBitrate: num(pair, "availableOutgoingBitrate"),
    maxAvailableOutgoingBitrate: maxSample(pair, "availableOutgoingBitrate"),
    availableIncomingBitrate: num(pair, "availableIncomingBitrate"),
    currentRoundTripTimeMs: rtt === null ? null : Math.round(rtt * 1000),
  };
}

function summarisePeerConnection(key: string, pc: Record<string, unknown>): PeerConnectionSummary {
  const objects = readStats(asRecord(pc.stats) ?? {});
  const all = Array.from(objects.values());

  const outbound = all
    .filter((object) => object.type === "outbound-rtp" && isVideo(object))
    .map((object): OutboundVideo => ({
      statId: object.id,
      rid: str(object, "rid"),
      ssrc: num(object, "ssrc"),
      active: bool(object, "active"),
      codec: codecOf(objects, str(object, "codecId")),
      codecHistory: codecHistoryOf(objects, object),
      frameWidth: num(object, "frameWidth"),
      frameHeight: num(object, "frameHeight"),
      maxFrameHeight: maxSample(object, "frameHeight"),
      framesPerSecond: num(object, "framesPerSecond"),
      framesPerSecondMedian: medianSample(object, "framesPerSecond"),
      framesEncoded: num(object, "framesEncoded"),
      targetBitrate: num(object, "targetBitrate"),
      maxTargetBitrate: maxSample(object, "targetBitrate"),
      bytesSent: num(object, "bytesSent"),
      sendBitrateRecent: bitrate(object, "bytesSent", 10),
      sendBitrateAverage: bitrate(object, "bytesSent", null),
      sendRate: analyseSendRate(object),
      retransmittedBytesSent: num(object, "retransmittedBytesSent"),
      retransmittedPacketsSent: num(object, "retransmittedPacketsSent"),
      packetsSent: num(object, "packetsSent"),
      nackCount: num(object, "nackCount"),
      pliCount: num(object, "pliCount"),
      firCount: num(object, "firCount"),
      keyFramesEncoded: num(object, "keyFramesEncoded"),
      qualityLimitationReason: str(object, "qualityLimitationReason"),
      qualityLimitationDurations: recordOf(object, "qualityLimitationDurations"),
      qualityLimitationResolutionChanges: num(object, "qualityLimitationResolutionChanges"),
      scalabilityMode: str(object, "scalabilityMode"),
      encoderImplementation: str(object, "encoderImplementation"),
      powerEfficientEncoder: bool(object, "powerEfficientEncoder"),
    }))
    .sort((a, b) => (b.frameHeight ?? -1) - (a.frameHeight ?? -1));

  const inbound = all
    .filter((object) => object.type === "inbound-rtp" && isVideo(object))
    .map((object): InboundVideo => ({
      statId: object.id,
      ssrc: num(object, "ssrc"),
      codec: codecOf(objects, str(object, "codecId")),
      codecHistory: codecHistoryOf(objects, object),
      frameWidth: num(object, "frameWidth"),
      frameHeight: num(object, "frameHeight"),
      framesPerSecond: num(object, "framesPerSecond"),
      framesReceived: num(object, "framesReceived"),
      framesDecoded: num(object, "framesDecoded"),
      framesDropped: num(object, "framesDropped"),
      packetsReceived: num(object, "packetsReceived"),
      packetsLost: num(object, "packetsLost"),
      freezeCount: num(object, "freezeCount"),
      totalFreezesDuration: num(object, "totalFreezesDuration"),
      receiveBitrateRecent: bitrate(object, "bytesReceived", 10),
      nackCount: num(object, "nackCount"),
      pliCount: num(object, "pliCount"),
      firCount: num(object, "firCount"),
      keyFramesDecoded: num(object, "keyFramesDecoded"),
      perMinute: perMinuteOf(object),
      decoderImplementation: str(object, "decoderImplementation"),
    }))
    .sort((a, b) => (b.framesDecoded ?? -1) - (a.framesDecoded ?? -1));

  // The page URL of a test link carries its token (?jwt=...): never kept.
  const url = typeof pc.url === "string" ? pc.url.replace(/[?#].*$/, "") : null;

  return {
    key,
    url,
    room: roomFromUrl(url),
    outbound,
    inbound,
    connection: summariseConnection(objects),
  };
}

/** Parses a webrtc-internals dump (file text). Throws DumpError if unusable. */
export function summariseDump(text: string): DumpSummary {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DumpError("Not a JSON file. Export it from chrome://webrtc-internals with \"Create dump\".");
  }

  const peerConnections = asRecord(asRecord(parsed)?.PeerConnections);

  if (!peerConnections) {
    throw new DumpError("No \"PeerConnections\" section: not a chrome://webrtc-internals dump.");
  }

  const summaries = Object.entries(peerConnections)
    .map(([key, pc]) => summarisePeerConnection(key, asRecord(pc) ?? {}));
  const warnings: string[] = [];

  if (summaries.length === 0) {
    warnings.push("The dump has no peer connections (was the meeting still open when it was exported?).");
  } else if (!summaries.some((pc) => pc.outbound.length || pc.inbound.length)) {
    warnings.push("No standard outbound-rtp / inbound-rtp video statistics found (empty, legacy or unsupported dump format).");
  }

  const sending = summaries.filter((pc) => pc.outbound.some((stream) => (stream.bytesSent ?? 0) > 0));

  if (sending.length > 1) {
    warnings.push(`${sending.length} peer connections sent video (P2P may have been used, or the dump spans several meetings).`);
  }

  return { peerConnections: summaries, warnings };
}

// ---- Arm validity -------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "unknown";

export type ArmCheck = { name: string; status: CheckStatus; detail: string };

export type ArmVerdict = {
  arm: Arm;
  /** The test room the verdict is about (null: could not be identified). */
  room: string | null;
  /** true: ran as requested; false: invalid; null: could not be confirmed. */
  valid: boolean | null;
  checks: ArmCheck[];
};

/** Room names made by buildRoomName; group 1 is the arm. */
export const TEST_ROOM_PATTERN = /^sl-codec-test-([abc])-[0-9a-z]+-[0-9a-f]{6,8}$/;

/** The frame-rate cap every arm requests (arms.ts) ... */
export const REQUESTED_MAX_FPS = 15;
/** ... and the median above which the cap was clearly not applied. */
export const FPS_CAP_TOLERANCE = 18;

/** A sustained, retransmission-free send rate above this needs a cap above
 * Jitsi's 1 Mbps AV1 default. */
const RAISED_CAP_EVIDENCE = DEFAULT_AV1_HIGH_BITRATE * 1.05;
/** Above 720p Jitsi applies its higher "fullHd" tier, not the high layer. */
const HIGH_LAYER_MAX_HEIGHT = 720;

function codecName(mimeType: string | null): string | null {
  return mimeType ? mimeType.replace(/^video\//i, "").toUpperCase() : null;
}

/**
 * The codec actually negotiated, over the whole call: fail when a stream
 * ENDS on another codec; unknown when it changed during the call (the
 * stats then mix codecs) or a codec is not recorded.
 */
function codecCheck(name: string, expected: string, streams: Array<{ codecHistory: Array<string | null> }>): ArmCheck {
  if (streams.length === 0) {
    return { name, status: "unknown", detail: "no active video stream in this room" };
  }

  const histories = streams.map((stream) => stream.codecHistory.map(codecName));

  if (histories.some((history) => history.includes(null))) {
    return { name, status: "unknown", detail: "codec not recorded for every stream" };
  }

  const finals = Array.from(new Set(histories.map((history) => history[history.length - 1])));

  if (finals.some((codec) => codec !== expected)) {
    return { name, status: "fail", detail: `${finals.join(", ")} instead of ${expected}: the codec preference was not honoured` };
  }

  const changed = histories.find((history) => history.length > 1);

  if (changed) {
    return {
      name,
      status: "unknown",
      detail: `codec changed during the call (${changed.join(" -> ")}): the statistics mix codecs`,
    };
  }

  return { name, status: "pass", detail: `${expected} (as requested)` };
}

/**
 * Which room's connections to judge: the given one, else the single room
 * of this arm in the teacher dump. Several runs of the arm, or no room
 * recorded, cannot be told apart reliably: no room, with the reason.
 */
function selectRoom(arm: Arm, teacher: DumpSummary, requested: string | undefined): { room: string | null; check: ArmCheck } {
  const name = "Test room";
  const withVideo = teacher.peerConnections.filter((pc) => pc.outbound.length || pc.inbound.length);
  const rooms = Array.from(new Set(withVideo.map((pc) => pc.room).filter((room): room is string => Boolean(room))));
  const armOf = (room: string) => TEST_ROOM_PATTERN.exec(room)?.[1]?.toUpperCase() ?? null;

  if (requested) {
    const room = requested.trim().toLowerCase();

    if (armOf(room) !== arm.id) {
      return { room: null, check: { name, status: "unknown", detail: `"${room}" is not an arm ${arm.id} test room` } };
    }

    return rooms.includes(room)
      ? { room, check: { name, status: "pass", detail: room } }
      : { room: null, check: { name, status: "unknown", detail: `the teacher dump has no video connection in "${room}"` } };
  }

  const armRooms = rooms.filter((room) => armOf(room) === arm.id);

  if (armRooms.length === 1) {
    return { room: armRooms[0], check: { name, status: "pass", detail: armRooms[0] } };
  }

  if (armRooms.length > 1) {
    return {
      room: null,
      check: { name, status: "unknown", detail: `${armRooms.length} arm ${arm.id} rooms in this dump (${armRooms.join(", ")}): choose one with --room` },
    };
  }

  const others = rooms.filter((room) => armOf(room));

  return {
    room: null,
    check: {
      name,
      status: "unknown",
      detail: others.length
        ? `no arm ${arm.id} room in the teacher dump (found ${others.join(", ")})`
        : "no test room recorded for the connections: cannot tell which arm the statistics belong to",
    },
  };
}

function fpsCheck(sent: OutboundVideo[]): ArmCheck {
  const name = "15 fps cap";
  const medians = sent.map((stream) => stream.framesPerSecondMedian).filter((fps): fps is number => fps !== null);

  if (!medians.length) {
    return { name, status: "unknown", detail: "frame rate not recorded: cannot tell whether the run matches the 15 fps condition" };
  }

  const fps = Math.max(...medians);

  return fps > FPS_CAP_TOLERANCE
    ? {
      name,
      status: "unknown",
      detail: `about ${fps} fps sent although ${REQUESTED_MAX_FPS} fps was requested: the camera, browser or Jitsi did not apply the cap, so this run is not comparable with the 15 fps condition`,
    }
    : { name, status: "pass", detail: `about ${fps} fps (cap ${REQUESTED_MAX_FPS} fps)` };
}

/**
 * Arm C: evidence that the effective AV1 cap was above Jitsi's 1 Mbps
 * default, from what was actually SENT, never from targetBitrate (for SVC
 * it can be a single layer's target, far below the stream's rate).
 *
 * PASS needs all of: exactly one encoding recorded as active (active ===
 * true; a missing "active" field is not taken as active), AV1 for the whole
 * call, at most 720p (above that Jitsi's own higher tier could explain a
 * higher rate), and a retransmission-free send rate above 1.05 Mbps held
 * for SUSTAINED_WINDOW_SECONDS (window average AND median, so a short spike
 * does not count). Anything less is UNCONFIRMED, never a failure.
 *
 * Even a PASS shows only that the effective cap was above the default: the
 * configured maxBitrate (1.5 Mbps) is not in WebRTC stats, and a rate below
 * a cap does not reveal the cap.
 */
function raisedCapCheck(streams: OutboundVideo[], headroom: number | null): ArmCheck {
  const name = "Raised AV1 cap";
  const notExact = `This shows an effective cap above the ${DEFAULT_AV1_HIGH_BITRATE} bit/s default; ` +
    "it does not prove the exact 1.5 Mbps maxBitrate, which WebRTC stats do not contain";
  const unknown = (detail: string): ArmCheck => ({ name, status: "unknown", detail });
  const withData = streams.filter((stream) => (stream.bytesSent ?? 0) > 0);

  if (!withData.length) {
    return unknown("no outbound video with data in this room");
  }

  const active = withData.filter((stream) => stream.active === true);

  if (!active.length) {
    return unknown(withData.some((stream) => stream.active === null)
      ? `the dump does not record which encoding is active (no "active" field on ${withData.length} stream(s)): the sending stream cannot be identified reliably`
      : "no outbound video encoding is recorded as active");
  }

  if (active.length > 1) {
    return unknown(`${active.length} encodings are active; arm C expects a single AV1 SVC encoding, so the qualifying stream is ambiguous`);
  }

  const stream = active[0];
  const codecs = stream.codecHistory.map(codecName);

  if (codecs.includes(null) || codecs.some((codec) => codec !== "AV1")) {
    return unknown(`the active encoding is not AV1 throughout the call (${codecs.map((codec) => codec ?? "unknown").join(" -> ")})`);
  }

  if (stream.maxFrameHeight === null) {
    return unknown("the sent resolution is not recorded: Jitsi's higher-resolution tier cannot be ruled out");
  }

  if (stream.maxFrameHeight > HIGH_LAYER_MAX_HEIGHT) {
    return unknown(`sent up to ${stream.maxFrameHeight}p: Jitsi's higher-resolution tier, not the override, may explain a higher rate`);
  }

  const rate = stream.sendRate;
  const target = stream.maxTargetBitrate === null
    ? "targetBitrate not recorded"
    : `targetBitrate peaked at ${stream.maxTargetBitrate} bit/s (informational: for SVC it may be one layer's target)`;
  const gross = rate.grossAverage === null ? "" : ` Gross average ${rate.grossAverage} bit/s (includes retransmissions, not evidence).`;

  if (rate.issue || rate.sustainedNetAverage === null || rate.sustainedNetMedian === null) {
    return unknown(`${rate.issue ?? "sustained send rate not computable"}.${gross} ${target}.`);
  }

  const sustained = Math.min(rate.sustainedNetAverage, rate.sustainedNetMedian);
  const window = `best ${rate.sustainedWindowSeconds} s window: average ${rate.sustainedNetAverage} bit/s, median ${rate.sustainedNetMedian} bit/s`;
  const share = rate.retransmissionShare === null ? "" : `, retransmissions ${Math.round(rate.retransmissionShare * 1000) / 10}% of bytes`;

  if (sustained > RAISED_CAP_EVIDENCE) {
    return {
      name,
      status: "pass",
      detail: `retransmission-free send rate held above ${RAISED_CAP_EVIDENCE} bit/s (${window}${share}) on the active AV1 encoding at up to ${stream.maxFrameHeight}p. ` +
        `${notExact}. ${target}.`,
    };
  }

  return unknown(
    `retransmission-free send rate did not hold above ${RAISED_CAP_EVIDENCE} bit/s for ${SUSTAINED_WINDOW_SECONDS} s (${window}${share}; ` +
    `link offered up to ${headroom === null ? "an unknown rate" : `${headroom} bit/s`}). ` +
    `That fits the default cap as well as a raised cap the encoder did not need. ${target}.`
  );
}

export function evaluateArm(
  armId: keyof typeof ARMS,
  teacher: DumpSummary,
  student: DumpSummary | null,
  options: { room?: string } = {}
): ArmVerdict {
  const arm = ARMS[armId];
  const { room, check: roomCheck } = selectRoom(arm, teacher, options.room);
  const checks: ArmCheck[] = [roomCheck];

  if (!room) {
    checks.push({ name: "Codec, frame rate and bitrate", status: "unknown", detail: "not checked: no single test room identified" });

    return { arm, room, valid: null, checks };
  }

  const teacherPcs = teacher.peerConnections.filter((pc) => pc.room === room);
  const sent = teacherPcs.flatMap((pc) => pc.outbound)
    .filter((stream) => (stream.bytesSent ?? 0) > 0 && stream.active !== false);
  const sendingPcs = teacherPcs.filter((pc) => pc.outbound.some((stream) => (stream.bytesSent ?? 0) > 0));

  if (sendingPcs.length > 1) {
    checks.push({ name: "Single bridge connection", status: "unknown", detail: `${sendingPcs.length} connections sent video in this room (P2P or a rejoin)` });
  }

  checks.push(codecCheck("Teacher sends", arm.expectedCodec, sent));
  checks.push(fpsCheck(sent));

  if (!student) {
    checks.push({ name: "Student receives", status: "unknown", detail: "no student dump given" });
  } else {
    const studentPcs = student.peerConnections.filter((pc) => pc.room === room);
    const received = studentPcs.flatMap((pc) => pc.inbound).filter((stream) => (stream.framesDecoded ?? 0) > 0);

    checks.push(studentPcs.length
      ? codecCheck("Student receives", arm.expectedCodec, received)
      : { name: "Student receives", status: "unknown", detail: `the student dump has no connection in "${room}" (another run, or the room was not recorded)` });
  }

  if (arm.highBitrateOverride) {
    const headrooms = teacherPcs
      .map((pc) => pc.connection?.maxAvailableOutgoingBitrate ?? null)
      .filter((value): value is number => value !== null);

    // Every outbound video stream in the room: the check picks the active
    // one itself (never assuming a missing "active" field means active).
    checks.push(raisedCapCheck(teacherPcs.flatMap((pc) => pc.outbound), headrooms.length ? Math.max(...headrooms) : null));
  }

  const valid = checks.some((check) => check.status === "fail")
    ? false
    : checks.every((check) => check.status === "pass")
      ? true
      : null;

  return { arm, room, valid, checks };
}

// ---- Text report ----------------------------------------------------------------

function show(value: number | string | boolean | null, unit = ""): string {
  if (value === null) {
    return "unavailable";
  }

  return typeof value === "number" ? `${value}${unit}` : String(value);
}

function resolution(width: number | null, height: number | null, fps: number | null): string {
  const size = width === null && height === null ? "unavailable" : `${show(width)}x${show(height)}`;

  return `${size} @ ${show(fps, " fps")}`;
}

function durationsText(durations: Record<string, number> | null): string {
  return durations
    ? Object.entries(durations).map(([reason, seconds]) => `${reason} ${Math.round(seconds * 10) / 10} s`).join(", ")
    : "unavailable";
}

function kbps(value: number | null): string {
  return value === null ? "unavailable" : `${Math.round(value / 1000)} kbps`;
}

function codecText(codec: CodecInfo | null, history: Array<string | null>): string {
  if (!codec) {
    return "unavailable";
  }

  const text = `${codec.mimeType ?? "unknown"} (codecId ${codec.codecId}${codec.payloadType === null ? "" : `, pt ${codec.payloadType}`})`;

  return history.length > 1
    ? `${text}; changed during the call: ${history.map((mime) => mime ?? "unknown").join(" -> ")}`
    : text;
}

export function formatSummary(title: string, summary: DumpSummary): string {
  const lines: string[] = [`== ${title} ==`];

  summary.warnings.forEach((warning) => lines.push(`  ! ${warning}`));

  summary.peerConnections.forEach((pc) => {
    if (!pc.outbound.length && !pc.inbound.length && !pc.connection) {
      return;
    }

    lines.push(`  Peer connection ${pc.key}${pc.room ? `, room ${pc.room}` : ", room not recorded"}`);

    pc.outbound.forEach((stream) => {
      const rate = stream.sendRate;
      const activeText = stream.active === true ? "active" : stream.active === false ? "inactive" : "active: not recorded";

      lines.push(`    Outbound video ${stream.rid ? `rid ${stream.rid}` : stream.statId} (${activeText})`);
      lines.push(`      codec:            ${codecText(stream.codec, stream.codecHistory)}`);
      lines.push(`      resolution / fps: ${resolution(stream.frameWidth, stream.frameHeight, stream.framesPerSecond)} (median ${show(stream.framesPerSecondMedian, " fps")}, max height ${show(stream.maxFrameHeight)})`);
      lines.push(`      target bitrate:   ${kbps(stream.targetBitrate)} (max seen ${kbps(stream.maxTargetBitrate)}); informational, may not be the whole stream's rate for SVC`);
      lines.push(`      sending bitrate:  ${kbps(stream.sendBitrateRecent)} recent, ${kbps(stream.sendBitrateAverage)} average (gross, incl. retransmissions); bytesSent ${show(stream.bytesSent)}`);
      lines.push(rate.issue === null
        ? `      without retrans.: ${kbps(rate.netAverage)} average; best ${show(rate.sustainedWindowSeconds, " s")} window ${kbps(rate.sustainedNetAverage)} average / ${kbps(rate.sustainedNetMedian)} median`
        : `      without retrans.: ${rate.netAverage === null ? "unavailable" : `${kbps(rate.netAverage)} average`} (${rate.issue})`);
      lines.push(`      retransmissions:  ${show(stream.retransmittedBytesSent)} bytes${rate.retransmissionShare === null ? "" : ` (${Math.round(rate.retransmissionShare * 1000) / 10}% of bytes in the window)`}, ${show(stream.retransmittedPacketsSent)} of ${show(stream.packetsSent)} packets`);
      lines.push(`      feedback:         NACK ${show(stream.nackCount)}, PLI ${show(stream.pliCount)}, FIR ${show(stream.firCount)}; keyframes encoded ${show(stream.keyFramesEncoded)}`);
      lines.push(`      limitation:       ${show(stream.qualityLimitationReason)}; durations ${durationsText(stream.qualityLimitationDurations)}; resolution changes ${show(stream.qualityLimitationResolutionChanges)}`);
      lines.push(`      scalability:      ${show(stream.scalabilityMode)}; encoder ${show(stream.encoderImplementation)}; power-efficient ${show(stream.powerEfficientEncoder)}`);
      lines.push(`      observed for:     ${show(rate.measurementSeconds, " s")}`);
    });

    pc.inbound.forEach((stream) => {
      lines.push(`    Inbound video ${stream.ssrc === null ? stream.statId : `ssrc ${stream.ssrc}`}`);
      lines.push(`      codec:            ${codecText(stream.codec, stream.codecHistory)}`);
      lines.push(`      resolution / fps: ${resolution(stream.frameWidth, stream.frameHeight, stream.framesPerSecond)}`);
      lines.push(`      receive bitrate:  ${kbps(stream.receiveBitrateRecent)} recent`);
      lines.push(`      frames:           received ${show(stream.framesReceived)}, decoded ${show(stream.framesDecoded)}, dropped ${show(stream.framesDropped)}`);
      lines.push(`      packets:          received ${show(stream.packetsReceived)}, lost ${show(stream.packetsLost)}`);
      lines.push(`      freezes:          ${show(stream.freezeCount)} totalling ${show(stream.totalFreezesDuration, " s")}`);
      lines.push(`      feedback:         NACK ${show(stream.nackCount)}, PLI ${show(stream.pliCount)}, FIR ${show(stream.firCount)}; keyframes decoded ${show(stream.keyFramesDecoded)}`);
      lines.push(stream.perMinute
        ? `      per minute:       freezes ${show(stream.perMinute.freezes)}, frozen ${show(stream.perMinute.frozenSeconds, " s")}, dropped frames ${show(stream.perMinute.framesDropped)} (over ${stream.perMinute.windowSeconds} s)`
        : `      per minute:       unavailable (no reliable observation window of ${MIN_NORMALISE_SECONDS} s or more)`);
    });

    if (pc.connection) {
      lines.push(`    Connection (candidate pair ${pc.connection.candidatePairId})`);
      lines.push(`      available outgoing: ${kbps(pc.connection.availableOutgoingBitrate)} (max seen ${kbps(pc.connection.maxAvailableOutgoingBitrate)})`);
      lines.push(`      available incoming: ${kbps(pc.connection.availableIncomingBitrate)}`);
      lines.push(`      RTT:                ${show(pc.connection.currentRoundTripTimeMs, " ms")}`);
    }
  });

  return lines.join("\n");
}

export function formatVerdict(verdict: ArmVerdict): string {
  const state = verdict.valid === true ? "VALID" : verdict.valid === false ? "INVALID" : "UNCONFIRMED";
  const lines = [`== Arm ${verdict.arm.id}: ${verdict.arm.label} -> ${state} ==`];

  verdict.checks.forEach((check) => lines.push(`  [${check.status.toUpperCase()}] ${check.name}: ${check.detail}`));

  if (verdict.valid === false) {
    lines.push("  Do not use this run as a comparison result.");
  } else if (verdict.valid === null) {
    lines.push("  Not a confirmed comparison result: see the UNKNOWN checks above.");
  }

  return lines.join("\n");
}
