/*
 * Codec test: chrome://webrtc-internals dump summaries and arm validity
 * (scripts/codec-test/stats.ts).
 *
 *   npm run test:codec
 *
 * The dumps here are small synthetic files in Chrome's dump format; they
 * check the parser, not real browser behaviour.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DumpError, evaluateArm, formatSummary, formatVerdict, summariseDump } from "../../scripts/codec-test/stats";

type Entry = { statsType: string; startTime: number | string; endTime: number | string; values: string | unknown[] };
type Stats = Record<string, Entry>;

const ROOM = {
  A: "sl-codec-test-a-1-aaaaaa",
  B: "sl-codec-test-b-1-bbbbbb",
  C: "sl-codec-test-c-1-cccccc",
} as const;

// One statistic object as Chrome writes it: "<id>-<prop>" entries, values
// JSON-encoded, samples evenly spaced from startTime to endTime.
function stat(id: string, type: string, props: Record<string, unknown[]>, options: { start?: number | string; end?: number | string; rawArrays?: boolean } = {}): Stats {
  const entries: Stats = {};

  for (const [prop, values] of Object.entries(props)) {
    entries[`${id}-${prop}`] = {
      statsType: type,
      startTime: options.start ?? 0,
      endTime: options.end ?? 9000,
      values: options.rawArrays ? values : JSON.stringify(values),
    };
  }

  return entries;
}

// room null: a connection without a recorded page URL.
function dumpOf(connections: Array<{ key: string; room: string | null; stats: Stats }>) {
  return JSON.stringify({
    getUserMedia: [],
    PeerConnections: Object.fromEntries(connections.map(({ key, room, stats }) => [
      key,
      room === null ? { stats } : { url: `https://meet.example.test/${room}?jwt=SHOULD-NOT-PRINT#config.x=1`, stats },
    ])),
    UserAgent: "test",
  });
}

const dump = (stats: Stats, room: string | null = ROOM.B, key = "1-1") => dumpOf([{ key, room, stats }]);
const fill = <T,>(value: T) => Array(10).fill(value) as T[];
const tenSamples = (last: number) => Array.from({ length: 10 }, (_, index) => (last / 9) * index);

type TeacherOptions = {
  maxTarget?: number;
  available?: number;
  fps?: number[] | null;
  heights?: number[] | null;
  codecIds?: string[];
  key?: string;
};

// Teacher sending one video stream (statistic ids unique per key).
function teacherStats(codec: string, options: TeacherOptions = {}): Stats {
  const target = options.maxTarget ?? 1_000_000;
  const p = (options.key ?? "1-1").replace(/\W/g, "");
  const codecIds = options.codecIds ?? fill(`COT${p}`);
  const props: Record<string, unknown[]> = {
    kind: fill("video"),
    codecId: codecIds,
    frameWidth: fill(960),
    framesEncoded: tenSamples(135),
    targetBitrate: [800_000, target, 900_000, 900_000, 900_000, 900_000, 900_000, 900_000, 900_000, 950_000],
    // 125 000 bytes per 1 s interval = 1 000 000 bit/s.
    bytesSent: tenSamples(1_125_000),
    qualityLimitationReason: fill("bandwidth"),
    scalabilityMode: fill("L3T3_KEY"),
    encoderImplementation: fill("libaom"),
    active: fill(true),
  };

  if (options.heights !== null) {
    props.frameHeight = options.heights ?? fill(540);
  }

  if (options.fps !== null) {
    props.framesPerSecond = options.fps ?? fill(15);
  }

  return {
    ...stat(`OT${p}`, "outbound-rtp", props),
    ...(options.codecIds ? {} : stat(`COT${p}`, "codec", { mimeType: [`video/${codec}`], payloadType: [45] })),
    ...stat(`T${p}`, "transport", { selectedCandidatePairId: fill(`CP${p}-x`) }),
    // A candidate pair id containing "-": split at the LAST "-".
    ...stat(`CP${p}-x`, "candidate-pair", {
      // Given: the link's rate throughout; default: up to 3 Mbps, 1.8 Mbps at the end.
      availableOutgoingBitrate: options.available !== undefined
        ? fill(options.available)
        : [1_200_000, 3_000_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000],
      currentRoundTripTime: fill(0.045),
      nominated: fill(true),
    }),
  };
}

function studentStats(codec: string, key = "7-1"): Stats {
  const p = key.replace(/\W/g, "");

  return {
    ...stat(`IT${p}`, "inbound-rtp", {
      kind: fill("video"),
      ssrc: fill(9),
      codecId: fill(`CIT${p}`),
      frameWidth: fill(960),
      frameHeight: fill(540),
      framesPerSecond: fill(15),
      framesReceived: tenSamples(135),
      framesDecoded: tenSamples(134),
      framesDropped: fill(1),
      packetsReceived: tenSamples(900),
      packetsLost: fill(3),
      freezeCount: fill(2),
      totalFreezesDuration: fill(0.8),
      bytesReceived: tenSamples(1_125_000),
    }),
    ...stat(`CIT${p}`, "codec", { mimeType: [`video/${codec}`], payloadType: [45] }),
  };
}

const teacherDump = (codec: string, room: string, options: TeacherOptions = {}) => summariseDump(dump(teacherStats(codec, options), room));
const studentDump = (codec: string, room: string) => summariseDump(dump(studentStats(codec), room, "7-1"));
const checkOf = (verdict: ReturnType<typeof evaluateArm>, name: string) => verdict.checks.find((check) => check.name === name);

// ---- Parsing ----------------------------------------------------------------------

test("outbound video: codec, resolution, fps, bitrates, limitation, scalability", () => {
  const summary = teacherDump("AV1", ROOM.A);
  const [pc] = summary.peerConnections;
  const [stream] = pc.outbound;

  assert.equal(summary.warnings.length, 0);
  assert.equal(pc.room, ROOM.A);
  assert.deepEqual(stream.codec, { codecId: "COT11", mimeType: "video/AV1", payloadType: 45, sdpFmtpLine: null });
  assert.deepEqual(stream.codecHistory, ["video/AV1"]);
  assert.equal(stream.frameWidth, 960);
  assert.equal(stream.frameHeight, 540);
  assert.equal(stream.maxFrameHeight, 540);
  assert.equal(stream.framesPerSecond, 15);
  assert.equal(stream.framesPerSecondMedian, 15);
  assert.equal(stream.targetBitrate, 950_000);
  assert.equal(stream.maxTargetBitrate, 1_000_000);
  assert.equal(stream.sendBitrateRecent, 1_000_000);
  assert.equal(stream.sendBitrateAverage, 1_000_000);
  assert.equal(stream.qualityLimitationReason, "bandwidth");
  assert.equal(stream.scalabilityMode, "L3T3_KEY");
  assert.equal(stream.encoderImplementation, "libaom");
  assert.equal(stream.active, true);
});

test("connection: the selected candidate pair (hyphenated id), outgoing bitrate and RTT", () => {
  const connection = teacherDump("AV1", ROOM.A).peerConnections[0].connection;

  assert.deepEqual(connection, {
    candidatePairId: "CP11-x",
    availableOutgoingBitrate: 1_800_000,
    maxAvailableOutgoingBitrate: 3_000_000,
    availableIncomingBitrate: null,
    currentRoundTripTimeMs: 45,
  });
});

test("connection: without a selected pair, the nominated pair that carried most data", () => {
  const text = dump({
    ...stat("OT1", "outbound-rtp", { kind: ["video"] }),
    ...stat("CP-small", "candidate-pair", { nominated: [true], bytesSent: [10], currentRoundTripTime: [0.5] }),
    ...stat("CP-big", "candidate-pair", { nominated: [true], bytesSent: [9999], currentRoundTripTime: [0.02] }),
    ...stat("CP-failed", "candidate-pair", { nominated: [false], bytesSent: [99999] }),
  });

  assert.equal(summariseDump(text).peerConnections[0].connection?.candidatePairId, "CP-big");
  assert.equal(summariseDump(text).peerConnections[0].connection?.currentRoundTripTimeMs, 20);
});

test("inbound video: codec, resolution, fps, frames, packets, freezes", () => {
  const [stream] = studentDump("VP8", ROOM.B).peerConnections[0].inbound;

  assert.equal(stream.codec?.mimeType, "video/VP8");
  assert.equal(stream.frameHeight, 540);
  assert.equal(stream.framesPerSecond, 15);
  assert.equal(stream.framesReceived, 135);
  assert.equal(stream.framesDecoded, 134);
  assert.equal(stream.framesDropped, 1);
  assert.equal(stream.packetsLost, 3);
  assert.equal(stream.freezeCount, 2);
  assert.equal(stream.totalFreezesDuration, 0.8);
  assert.equal(stream.receiveBitrateRecent, 1_000_000);
});

test("format variants: real arrays, ISO times, legacy mediaType, a single non-array value", () => {
  const text = dump({
    ...stat("OT1", "outbound-rtp", { kind: ["video", "video"], frameHeight: [720, 720], bytesSent: [0, 250_000] }, {
      rawArrays: true,
      start: "2026-10-21T10:00:00.000Z",
      end: "2026-10-21T10:00:02.000Z",
    }),
    ...stat("OT2", "outbound-rtp", { mediaType: ["video"], frameHeight: [360] }),
    // values as a JSON scalar instead of an array.
    "OT3-kind": { statsType: "outbound-rtp", startTime: 0, endTime: 1, values: "\"video\"" },
    "OT3-frameHeight": { statsType: "outbound-rtp", startTime: 0, endTime: 1, values: "180" },
  });
  const streams = summariseDump(text).peerConnections[0].outbound;

  assert.deepEqual(streams.map((stream) => stream.frameHeight), [720, 360, 180]);
  assert.equal(streams[0].sendBitrateAverage, 1_000_000);
});

test("missing metrics stay null and print as 'unavailable' (never NaN / undefined)", () => {
  const summary = summariseDump(dump(stat("OT1", "outbound-rtp", { kind: ["video"] })));
  const [stream] = summary.peerConnections[0].outbound;

  assert.equal(stream.codec, null);
  assert.deepEqual(stream.codecHistory, [null]);
  assert.equal(stream.frameHeight, null);
  assert.equal(stream.framesPerSecondMedian, null);
  assert.equal(stream.sendBitrateRecent, null);
  assert.equal(summary.peerConnections[0].connection, null);

  const report = formatSummary("Teacher", summary);

  assert.match(report, /codec: +unavailable/);
  assert.match(report, /resolution \/ fps: unavailable @ unavailable/);
  assert.doesNotMatch(report, /NaN|undefined/);
});

test("the page URL's token is dropped at parse time (report and JSON output)", () => {
  const summary = teacherDump("AV1", ROOM.A);

  assert.equal(summary.peerConnections[0].url, `https://meet.example.test/${ROOM.A}`);
  assert.doesNotMatch(formatSummary("Teacher", summary), /SHOULD-NOT-PRINT|jwt=/);
  assert.doesNotMatch(JSON.stringify(summary), /SHOULD-NOT-PRINT|jwt=/);
});

test("a counter that went backwards gives no bitrate rather than a wrong one", () => {
  const text = dump(stat("OT1", "outbound-rtp", { kind: ["video", "video"], bytesSent: [500, 100] }));

  assert.equal(summariseDump(text).peerConnections[0].outbound[0].sendBitrateRecent, null);
});

test("audio streams are left out", () => {
  const text = dump(stat("OT1", "outbound-rtp", { kind: ["audio"], bytesSent: [0, 10] }));

  assert.deepEqual(summariseDump(text).peerConnections[0].outbound, []);
});

test("invalid input: not JSON, or not a webrtc-internals dump", () => {
  assert.throws(() => summariseDump("not json"), DumpError);
  assert.throws(() => summariseDump("{}"), /PeerConnections/);
  assert.throws(() => summariseDump("[]"), /PeerConnections/);
});

test("an empty or legacy dump gives a warning, not an error", () => {
  assert.match(summariseDump(dumpOf([])).warnings.join(" "), /no peer connections/);

  const legacy = dump(stat("ssrc_123_send", "ssrc", { googFrameHeightSent: [540] }));

  assert.match(summariseDump(legacy).warnings.join(" "), /legacy or unsupported/);
});

// ---- Rooms: several runs / arms in one dump ----------------------------------------

test("a teacher dump with arms A and B: each arm is judged on its own room only", () => {
  const teacher = summariseDump(dumpOf([
    { key: "1-1", room: ROOM.A, stats: teacherStats("AV1", { key: "1-1" }) },
    { key: "1-2", room: ROOM.B, stats: teacherStats("VP8", { key: "1-2" }) },
  ]));
  const studentB = studentDump("VP8", ROOM.B);

  assert.match(teacher.warnings.join(" "), /2 peer connections sent video/);

  const b = evaluateArm("B", teacher, studentB);

  assert.equal(b.room, ROOM.B);
  assert.equal(b.valid, true, formatVerdict(b));

  // Arm A's AV1 stream is not mixed into B, nor B's VP8 into A.
  const a = evaluateArm("A", teacher, studentB);

  assert.equal(checkOf(a, "Teacher sends")?.status, "pass");
  assert.equal(checkOf(a, "Student receives")?.status, "unknown");
  assert.match(checkOf(a, "Student receives")?.detail ?? "", /no connection in/);
  assert.equal(a.valid, null);
});

test("two runs of the same arm in one dump: unconfirmed until --room picks one", () => {
  const second = "sl-codec-test-b-2-dddddd";
  const teacher = summariseDump(dumpOf([
    { key: "1-1", room: ROOM.B, stats: teacherStats("VP8", { key: "1-1" }) },
    { key: "1-2", room: second, stats: teacherStats("AV1", { key: "1-2" }) },
  ]));

  const ambiguous = evaluateArm("B", teacher, studentDump("VP8", ROOM.B));

  assert.equal(ambiguous.valid, null);
  assert.equal(ambiguous.room, null);
  assert.match(formatVerdict(ambiguous), /2 arm B rooms[\s\S]*--room/);

  assert.equal(evaluateArm("B", teacher, studentDump("VP8", ROOM.B), { room: ROOM.B }).valid, true);
  assert.equal(evaluateArm("B", teacher, studentDump("AV1", second), { room: second }).valid, false);
});

test("--room naming another arm's room, or a room not in the dump, is unconfirmed", () => {
  const teacher = teacherDump("VP8", ROOM.B);

  assert.match(checkOf(evaluateArm("B", teacher, null, { room: ROOM.A }), "Test room")?.detail ?? "", /not an arm B test room/);
  assert.match(checkOf(evaluateArm("B", teacher, null, { room: "sl-codec-test-b-9-eeeeee" }), "Test room")?.detail ?? "", /no video connection/);
});

test("no room recorded for the connections: unconfirmed, no codec verdict", () => {
  const verdict = evaluateArm("B", summariseDump(dump(teacherStats("AV1"), null)), studentDump("VP8", ROOM.B));

  assert.equal(verdict.valid, null);
  assert.match(formatVerdict(verdict), /no test room recorded[\s\S]*not checked/);
  assert.equal(checkOf(verdict, "Teacher sends"), undefined);
});

test("only other arms' rooms in the dump: unconfirmed", () => {
  const verdict = evaluateArm("C", teacherDump("AV1", ROOM.A), null);

  assert.equal(verdict.valid, null);
  assert.match(checkOf(verdict, "Test room")?.detail ?? "", /no arm C room/);
});

test("a student dump from another room is not used", () => {
  const verdict = evaluateArm("B", teacherDump("VP8", ROOM.B), studentDump("VP8", "sl-codec-test-b-5-ffffff"));

  assert.equal(verdict.valid, null);
  assert.match(checkOf(verdict, "Student receives")?.detail ?? "", /no connection in/);
});

// ---- Codec ---------------------------------------------------------------------------

test("arm B is valid when teacher sends and student receives VP8 at 15 fps", () => {
  const verdict = evaluateArm("B", teacherDump("VP8", ROOM.B), studentDump("VP8", ROOM.B));

  assert.equal(verdict.valid, true, formatVerdict(verdict));
  assert.match(formatVerdict(verdict), /VALID/);
});

test("arm B is invalid when AV1 is still sent: the preference was ignored", () => {
  const verdict = evaluateArm("B", teacherDump("AV1", ROOM.B), studentDump("AV1", ROOM.B));

  assert.equal(verdict.valid, false);
  assert.match(formatVerdict(verdict), /INVALID[\s\S]*not honoured[\s\S]*Do not use this run/);
});

test("codec changed during the call: unconfirmed if it ended on the requested codec, invalid if not", () => {
  const codecIds = [...Array(5).fill("C-av1"), ...Array(5).fill("C-vp8")];
  const changing = (room: string) => summariseDump(dump({
    ...teacherStats("unused", { codecIds }),
    ...stat("C-av1", "codec", { mimeType: ["video/AV1"] }),
    ...stat("C-vp8", "codec", { mimeType: ["video/VP8"] }),
  }, room));

  const b = evaluateArm("B", changing(ROOM.B), studentDump("VP8", ROOM.B));

  assert.equal(b.valid, null);
  assert.match(checkOf(b, "Teacher sends")?.detail ?? "", /changed during the call \(AV1 -> VP8\)/);
  assert.match(formatSummary("Teacher", changing(ROOM.B)), /changed during the call: video\/AV1 -> video\/VP8/);

  assert.equal(evaluateArm("A", changing(ROOM.A), studentDump("AV1", ROOM.A)).valid, false);
});

test("a codecId whose codec statistic is missing: unconfirmed", () => {
  const verdict = evaluateArm("B", summariseDump(dump(teacherStats("x", { codecIds: fill("C-gone") }))), studentDump("VP8", ROOM.B));

  assert.equal(checkOf(verdict, "Teacher sends")?.status, "unknown");
  assert.equal(verdict.valid, null);
});

test("without the student dump an arm cannot be confirmed", () => {
  assert.equal(evaluateArm("A", teacherDump("AV1", ROOM.A), null).valid, null);
});

test("inactive simulcast layers do not count towards the codec check", () => {
  const text = dump({
    ...stat("OTa", "outbound-rtp", { kind: ["video", "video"], codecId: ["C1", "C1"], bytesSent: [0, 100], active: [true, true], framesPerSecond: [15, 15] }),
    ...stat("OTb", "outbound-rtp", { kind: ["video", "video"], codecId: ["C2", "C2"], bytesSent: [0, 100], active: [false, false] }),
    ...stat("C1", "codec", { mimeType: ["video/VP8"] }),
    ...stat("C2", "codec", { mimeType: ["video/AV1"] }),
  });

  assert.equal(evaluateArm("B", summariseDump(text), studentDump("VP8", ROOM.B)).valid, true);
});

// ---- 15 fps condition ----------------------------------------------------------------

test("fps at the cap passes; a start-up dip or a single spike does not change the median", () => {
  const verdict = evaluateArm("B", teacherDump("VP8", ROOM.B, { fps: [3, 15, 15, 15, 15, 15, 15, 15, 15, 40] }), studentDump("VP8", ROOM.B));

  assert.equal(checkOf(verdict, "15 fps cap")?.status, "pass");
  assert.equal(verdict.valid, true);
});

test("fps clearly above the cap (30): unconfirmed, not comparable with the 15 fps condition", () => {
  const verdict = evaluateArm("B", teacherDump("VP8", ROOM.B, { fps: fill(30) }), studentDump("VP8", ROOM.B));

  assert.equal(checkOf(verdict, "15 fps cap")?.status, "unknown");
  assert.match(checkOf(verdict, "15 fps cap")?.detail ?? "", /about 30 fps sent although 15 fps was requested/);
  assert.equal(verdict.valid, null);
});

test("fps not recorded: unconfirmed", () => {
  const verdict = evaluateArm("B", teacherDump("VP8", ROOM.B, { fps: null }), studentDump("VP8", ROOM.B));

  assert.match(checkOf(verdict, "15 fps cap")?.detail ?? "", /frame rate not recorded/);
  assert.equal(verdict.valid, null);
});

// ---- Arm C: sustained send rate, not targetBitrate --------------------------------

type ArmCOptions = {
  seconds?: number;
  /** Retransmission-free send rate (bit/s), and retransmissions on top. */
  netRate?: number;
  retransRate?: number;
  /** A burst replacing the net rate for some seconds: [startSecond, seconds, bit/s]. */
  spike?: [number, number, number];
  target?: number;
  height?: number;
  codec?: string;
  active?: boolean | null;
  retransmissions?: "aligned" | "missing" | "misaligned" | "larger";
  start?: number | string | null;
  end?: number | string | null;
  id?: string;
};

// Removes every entry's startTime (stat() defaults a missing one to 0).
function withoutStartTime(stats: Stats): Stats {
  return Object.fromEntries(Object.entries(stats).map(([key, entry]) => {
    const copy: Partial<Entry> = { ...entry };

    delete copy.startTime;

    return [key, copy as Entry];
  }));
}

// One outbound AV1 SVC stream sampled once a second (Chrome's spacing).
function svcStream(options: ArmCOptions = {}): Stats {
  const seconds = options.seconds ?? 90;
  const netRate = options.netRate ?? 1_460_000;
  const retransRate = options.retransRate ?? 20_000;
  const id = options.id ?? "OTc";
  const net = [0];
  const retrans = [0];

  for (let second = 1; second <= seconds; second += 1) {
    const [from, length, burst] = options.spike ?? [-1, 0, 0];
    const rate = second > from && second <= from + length ? burst : netRate;

    net.push(net[second - 1] + rate / 8);
    retrans.push(retrans[second - 1] + retransRate / 8);
  }

  const count = seconds + 1;
  const timing = {
    start: options.start === null ? undefined : options.start ?? 0,
    end: options.end === null ? undefined : options.end ?? seconds * 1000,
  };
  const all = <T,>(value: T) => Array(count).fill(value) as T[];
  const props: Record<string, unknown[]> = {
    kind: all("video"),
    codecId: all(`${id}-codec`),
    frameWidth: all((options.height ?? 720) * 16 / 9),
    frameHeight: all(options.height ?? 720),
    framesPerSecond: all(15),
    targetBitrate: all(options.target ?? 142_000),
    bytesSent: net.map((value, index) => Math.round(value + retrans[index])),
    scalabilityMode: all("L3T3_KEY"),
    qualityLimitationReason: all("none"),
  };

  if (options.active !== null) {
    props.active = all(options.active ?? true);
  }

  if (options.retransmissions === "misaligned") {
    props.retransmittedBytesSent = retrans.slice(0, -5).map(Math.round);
  } else if (options.retransmissions === "larger") {
    props.retransmittedBytesSent = net.map((value) => Math.round(value * 3));
  } else if (options.retransmissions !== "missing") {
    props.retransmittedBytesSent = retrans.map(Math.round);
  }

  const timed = stat(id, "outbound-rtp", props, timing);
  const entries = options.start === null ? withoutStartTime(timed) : timed;

  // A misaligned series also has its own (shorter) time span.
  if (options.retransmissions === "misaligned") {
    entries[`${id}-retransmittedBytesSent`].endTime = (seconds - 5) * 1000;
  }

  return { ...entries, ...stat(`${id}-codec`, "codec", { mimeType: [`video/${options.codec ?? "AV1"}`] }) };
}

const armC = (options: ArmCOptions = {}) => summariseDump(dump(svcStream(options), ROOM.C));
const capCheck = (teacher: ReturnType<typeof summariseDump>) =>
  checkOf(evaluateArm("C", teacher, studentDump("AV1", ROOM.C)), "Raised AV1 cap");

test("arm C: AV1 L3T3 with a 142 kbps target but a sustained 1.46 Mbps send rate is evidence of the raised cap", () => {
  const teacher = armC();
  const [stream] = teacher.peerConnections[0].outbound;

  assert.equal(stream.maxTargetBitrate, 142_000);
  assert.equal(stream.sendRate.issue, null);
  assert.equal(stream.sendRate.netAverage, 1_460_000);
  assert.equal(stream.sendRate.sustainedWindowSeconds, 30);
  assert.equal(stream.sendRate.sustainedNetMedian, 1_460_000);
  assert.ok(Math.abs((stream.sendRate.retransmissionShare ?? 0) - 0.014) < 0.001);

  const verdict = evaluateArm("C", teacher, studentDump("AV1", ROOM.C));
  const check = checkOf(verdict, "Raised AV1 cap");

  assert.equal(check?.status, "pass", check?.detail);
  assert.equal(verdict.valid, true, formatVerdict(verdict));
  // Observed rate, not proof of the exact configured value.
  assert.match(check?.detail ?? "", /does not prove the exact 1\.5 Mbps maxBitrate/);
  assert.match(check?.detail ?? "", /targetBitrate peaked at 142000 bit\/s \(informational/);
});

test("arm C: an arm A-like rate (977 kbps) is unconfirmed, never a raised-cap claim", () => {
  const check = capCheck(armC({ netRate: 977_000 }));

  assert.equal(check?.status, "unknown");
  assert.match(check?.detail ?? "", /did not hold above 1050000 bit\/s for 30 s/);
});

test("arm C: a high total rate made up largely of retransmissions is unconfirmed", () => {
  const teacher = armC({ netRate: 900_000, retransRate: 600_000 });
  const [stream] = teacher.peerConnections[0].outbound;
  const check = capCheck(teacher);

  assert.equal(stream.sendRate.grossAverage, 1_500_000);
  assert.equal(stream.sendRate.netAverage, 900_000);
  assert.equal(check?.status, "unknown");
  assert.match(check?.detail ?? "", /retransmissions 40% of bytes/);
});

test("arm C: unreliable retransmission data is unconfirmed (missing, misaligned, larger than bytesSent)", () => {
  assert.match(capCheck(armC({ retransmissions: "missing" }))?.detail ?? "", /retransmission data unavailable \(retransmittedBytesSent not recorded\)[\s\S]*Gross average/);
  assert.match(capCheck(armC({ retransmissions: "misaligned" }))?.detail ?? "", /not aligned with bytesSent/);
  assert.match(capCheck(armC({ retransmissions: "larger" }))?.detail ?? "", /larger than bytesSent/);

  for (const retransmissions of ["missing", "misaligned", "larger"] as const) {
    assert.equal(capCheck(armC({ retransmissions }))?.status, "unknown", retransmissions);
  }
});

test("arm C: several encodings without an 'active' field are unconfirmed (missing is not taken as active)", () => {
  const teacher = summariseDump(dump({
    ...svcStream({ id: "OT0", active: null }),
    ...svcStream({ id: "OT1", active: null, netRate: 300_000 }),
    ...svcStream({ id: "OT2", active: null, netRate: 100_000 }),
  }, ROOM.C));
  const check = capCheck(teacher);

  assert.equal(check?.status, "unknown");
  assert.match(check?.detail ?? "", /does not record which encoding is active \(no "active" field on 3 stream\(s\)\)/);
  assert.match(formatSummary("Teacher", teacher), /\(active: not recorded\)/);

  // A single stream without the field is not assumed active either.
  assert.match(capCheck(armC({ active: null }))?.detail ?? "", /does not record which encoding is active/);
});

test("arm C: inactive encodings are left out; two active encodings are ambiguous", () => {
  const oneActive = summariseDump(dump({
    ...svcStream({ id: "OT0" }),
    ...svcStream({ id: "OT1", active: false, netRate: 5_000_000 }),
  }, ROOM.C));

  assert.equal(capCheck(oneActive)?.status, "pass");

  const twoActive = summariseDump(dump({ ...svcStream({ id: "OT0" }), ...svcStream({ id: "OT1" }) }, ROOM.C));

  assert.match(capCheck(twoActive)?.detail ?? "", /2 encodings are active/);
});

test("arm C: a brief spike lifts a window's average but not its median: unconfirmed", () => {
  const teacher = armC({ netRate: 900_000, spike: [40, 5, 7_000_000] });
  const [stream] = teacher.peerConnections[0].outbound;

  // A 30 s window holding the 5 s burst averages (25 * 0.9 + 5 * 7) / 30 =
  // 1.92 Mbps, above the threshold; its median stays at 0.9 Mbps.
  assert.ok((stream.sendRate.grossAverage ?? 0) > 900_000, "the burst is in the data");
  assert.equal(stream.sendRate.sustainedNetMedian, 900_000);
  assert.equal(capCheck(teacher)?.status, "unknown");
  assert.match(capCheck(teacher)?.detail ?? "", /did not hold above/);
});

test("arm C: missing or invalid duration data is unconfirmed", () => {
  const cases: Array<[ArmCOptions, RegExp]> = [
    [{ start: null }, /bytesSent has no valid timestamps/],
    [{ end: 0 }, /bytesSent has no valid timestamps/],
    [{ end: "not a time" }, /bytesSent has no valid timestamps/],
    // 91 samples over 15 minutes: 10 s spacing is the limit; 20 s is not plausible.
    [{ end: 1_800_000 }, /sample spacing of 20000 ms is implausible/],
    [{ seconds: 20 }, /observed for 20 s, shorter than the 30 s window/],
  ];

  for (const [options, pattern] of cases) {
    const check = capCheck(armC(options));

    assert.equal(check?.status, "unknown", JSON.stringify(options));
    assert.match(check?.detail ?? "", pattern, JSON.stringify(options));
  }
});

test("arm C: not AV1 throughout, or above 720p, is unconfirmed", () => {
  assert.match(capCheck(armC({ codec: "VP9" }))?.detail ?? "", /not AV1 throughout the call \(VP9\)/);
  assert.match(capCheck(armC({ height: 1080 }))?.detail ?? "", /1080p/);
});

test("arms A and B have no bitrate-cap check", () => {
  assert.equal(checkOf(evaluateArm("A", teacherDump("AV1", ROOM.A), studentDump("AV1", ROOM.A)), "Raised AV1 cap"), undefined);
  assert.equal(checkOf(evaluateArm("B", teacherDump("VP8", ROOM.B), studentDump("VP8", ROOM.B)), "Raised AV1 cap"), undefined);
});

// ---- Diagnostics ----------------------------------------------------------------

test("missing retransmission and keyframe statistics stay unavailable, never 0", () => {
  const teacher = armC({ retransmissions: "missing" });
  const [stream] = teacher.peerConnections[0].outbound;
  const report = formatSummary("Teacher", teacher);

  assert.equal(stream.retransmittedBytesSent, null);
  assert.equal(stream.keyFramesEncoded, null);
  assert.equal(stream.pliCount, null);
  assert.equal(stream.qualityLimitationDurations, null);
  assert.equal(stream.sendRate.netAverage, null);
  assert.match(report, /retransmissions: +unavailable bytes, unavailable of unavailable packets/);
  assert.match(report, /NACK unavailable, PLI unavailable, FIR unavailable; keyframes encoded unavailable/);
  assert.match(report, /without retrans\.: unavailable \(retransmission data unavailable/);
  assert.match(report, /targetBitrate|target bitrate: .*informational, may not be the whole stream's rate for SVC/);
});

test("freezes and dropped frames per minute: only over a reliable window of 30 s or more", () => {
  const inbound = (seconds: number, options: { start?: number | null } = {}) => {
    const stats = stat("IT1", "inbound-rtp", {
      kind: Array(seconds + 1).fill("video"),
      freezeCount: Array.from({ length: seconds + 1 }, (_, index) => 2 + Math.floor((index / seconds) * 12)),
      totalFreezesDuration: Array.from({ length: seconds + 1 }, (_, index) => (index / seconds) * 6),
      framesDropped: Array.from({ length: seconds + 1 }, (_, index) => Math.floor((index / seconds) * 40)),
    }, { start: 0, end: seconds * 1000 });

    return summariseDump(dump(options.start === null ? withoutStartTime(stats) : stats, ROOM.C)).peerConnections[0].inbound[0];
  };

  // 120 s: freezes 2 -> 14 (12 in 2 minutes), 6 s frozen, 40 dropped.
  assert.deepEqual(inbound(120).perMinute, { windowSeconds: 120, freezes: 6, frozenSeconds: 3, framesDropped: 20 });
  // The raw counters stay as recorded (since the stream started).
  assert.equal(inbound(120).freezeCount, 14);

  assert.equal(inbound(20).perMinute, null, "shorter than 30 s");
  assert.equal(inbound(120, { start: null }).perMinute, null, "no timestamps");

  const report = formatSummary("Student", summariseDump(dump(stat("IT1", "inbound-rtp", { kind: ["video"], freezeCount: [3] }), ROOM.C)));

  assert.match(report, /per minute: +unavailable \(no reliable observation window/);
  assert.match(report, /keyframes decoded unavailable/);
});

test("quality limitation durations: as an object or a JSON string; numbers only", () => {
  const durations = (value: unknown) => summariseDump(dump(stat("OT1", "outbound-rtp", { kind: ["video"], qualityLimitationDurations: [value] }), ROOM.C))
    .peerConnections[0].outbound[0].qualityLimitationDurations;

  assert.deepEqual(durations({ none: 80.5, bandwidth: 9.5, cpu: 0, other: 0 }), { none: 80.5, bandwidth: 9.5, cpu: 0, other: 0 });
  assert.deepEqual(durations("{\"none\":12,\"bandwidth\":\"x\"}"), { none: 12 });
  assert.equal(durations("not json"), null);
  assert.equal(durations({ bandwidth: "x" }), null);
});

// ---- A representative Chrome dump ---------------------------------------------------
//
// Hand-built in Chrome's webrtc-internals dump layout (not captured from a
// real meeting, so it holds no real URL, token, address or name): the
// sections and statistic types a Jitsi teacher dump contains, Chrome-style
// statistic ids (codec ids embed the fmtp line, with "-", "=" and ";"),
// record values as JSON strings, three AV1 encodings of which Jitsi keeps
// only one active with L3T3_KEY, plus audio and unrelated statistics.

function representativeDump(): string {
  const seconds = 120;
  const n = seconds + 1;
  const all = <T,>(value: T) => Array(n).fill(value) as T[];
  const counter = (perSecond: number, start = 0) => Array.from({ length: n }, (_, index) => Math.round(start + perSecond * index));
  const entries = (id: string, type: string, props: Record<string, unknown[]>) => stat(id, type, props, {
    start: "2026-10-21T04:00:00.000Z",
    end: "2026-10-21T04:02:00.000Z",
  });
  const av1 = "COT01_45_level-idx=5;profile=0;tier=0";

  return JSON.stringify({
    getUserMedia: [{ origin: "https://meet.example.test", audio: "", video: "width: {max: 1280}" }],
    PeerConnections: {
      "4120-5": {
        pid: 4120,
        rtcConfiguration: "{ iceServers: [], sdpSemantics: \"unified-plan\" }",
        constraints: "",
        url: `https://meet.example.test/${ROOM.C}?jwt=SANITISED#config.p2p.enabled=false`,
        updateLog: [{ time: "10/21/2026, 9:30:00 AM", type: "setRemoteDescription", value: "type: offer" }],
        stats: {
          ...entries("OT01V2000000001", "outbound-rtp", {
            kind: all("video"),
            ssrc: all(2000000001),
            mid: all("1"),
            rid: all("0"),
            active: all(true),
            codecId: all(av1),
            mediaSourceId: all("SV2"),
            frameWidth: all(1280),
            frameHeight: all(720),
            framesPerSecond: all(15),
            framesEncoded: counter(15),
            keyFramesEncoded: counter(0.05, 1),
            targetBitrate: all(142_000),
            bytesSent: counter(185_000),
            retransmittedBytesSent: counter(2_500),
            packetsSent: counter(160),
            retransmittedPacketsSent: counter(2),
            nackCount: counter(0.4),
            pliCount: counter(0.02),
            firCount: all(0),
            qualityLimitationReason: all("none"),
            qualityLimitationDurations: all(JSON.stringify({ bandwidth: 2.1, cpu: 0, none: 117.9, other: 0 })),
            qualityLimitationResolutionChanges: all(1),
            scalabilityMode: all("L3T3_KEY"),
            encoderImplementation: all("libaom"),
            powerEfficientEncoder: all(false),
          }),
          // Jitsi's other two encodings: inactive, nothing sent.
          ...entries("OT01V2000000002", "outbound-rtp", { kind: all("video"), rid: all("1"), active: all(false), codecId: all(av1), bytesSent: all(0) }),
          ...entries("OT01V2000000003", "outbound-rtp", { kind: all("video"), rid: all("2"), active: all(false), codecId: all(av1), bytesSent: all(0) }),
          ...entries(av1, "codec", { mimeType: all("video/AV1"), payloadType: all(45), clockRate: all(90000), sdpFmtpLine: all("level-idx=5;profile=0;tier=0") }),
          // Audio and unrelated statistics the parser must ignore.
          ...entries("OT01A1000000001", "outbound-rtp", { kind: all("audio"), bytesSent: counter(4_000) }),
          ...entries("SV2", "media-source", { kind: all("video"), width: all(1920), height: all(1080), framesPerSecond: all(15) }),
          ...entries("RI01V2000000001", "remote-inbound-rtp", { kind: all("video"), roundTripTime: all(0.052), fractionLost: all(0.004) }),
          ...entries("I1a2b3c4d", "local-candidate", { candidateType: all("srflx"), protocol: all("udp") }),
          ...entries("T01", "transport", { selectedCandidatePairId: all("CP1a2b3c4d_5e6f7a8b"), dtlsState: all("connected") }),
          ...entries("CP1a2b3c4d_5e6f7a8b", "candidate-pair", {
            nominated: all(true),
            state: all("succeeded"),
            availableOutgoingBitrate: all(3_160_000),
            currentRoundTripTime: all(0.051),
            bytesSent: counter(190_000),
          }),
        },
      },
    },
    UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0",
  });
}

test("representative Chrome dump: three AV1 encodings, one active SVC stream; parsed and judged correctly", () => {
  const teacher = summariseDump(representativeDump());
  const [pc] = teacher.peerConnections;
  const active = pc.outbound.find((stream) => stream.active === true);

  assert.equal(pc.room, ROOM.C);
  assert.equal(pc.outbound.length, 3, "audio left out");
  assert.equal(active?.codec?.mimeType, "video/AV1");
  assert.equal(active?.codec?.sdpFmtpLine, "level-idx=5;profile=0;tier=0");
  assert.equal(active?.sendRate.netAverage, 1_460_000);
  assert.equal(active?.sendRate.measurementSeconds, 120);
  assert.deepEqual(active?.qualityLimitationDurations, { bandwidth: 2.1, cpu: 0, none: 117.9, other: 0 });
  assert.equal(active?.keyFramesEncoded, 7);
  assert.equal(pc.connection?.maxAvailableOutgoingBitrate, 3_160_000);
  assert.doesNotMatch(JSON.stringify(teacher), /SANITISED|jwt=/);

  const verdict = evaluateArm("C", teacher, studentDump("AV1", ROOM.C));

  assert.equal(checkOf(verdict, "Raised AV1 cap")?.status, "pass", formatVerdict(verdict));
  assert.equal(checkOf(verdict, "Teacher sends")?.status, "pass");
  assert.equal(verdict.valid, true);
});
