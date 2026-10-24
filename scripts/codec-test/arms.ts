/*
 * Isolated Jitsi codec test: the three test arms and the meeting links.
 *
 * Every arm uses its own fresh room and Jitsi's documented client-side
 * config overrides (URL fragment "#config.<path>=<JSON>"), so nothing on the
 * Jitsi server and nothing in the SL Classroom app changes. Whether the
 * deployed Jitsi honours an override must still be checked in the WebRTC
 * stats (see stats.ts): an ignored override makes that arm invalid.
 *
 * The camera settings below copy the production embed (useJitsi.ts
 * configOverwrite) so the arms differ only where documented.
 */

export type ArmId = "A" | "B" | "C";

export type Role = "teacher" | "student";

export type Codec = "AV1" | "VP9" | "VP8" | "H264";

export type Arm = {
  id: ArmId;
  label: string;
  /** The codec the teacher's camera should be sent with. */
  expectedCodec: Codec;
  codecPreferenceOrder: Codec[];
  /**
   * Overrides of Jitsi's per-codec high-layer cap (bits/s), or null to keep
   * the deployment's default for that codec.
   */
  highBitrateOverride: { codec: Codec; bitsPerSecond: number } | null;
};

/** Jitsi's default AV1 high-layer cap, as seen in the production stats. */
export const DEFAULT_AV1_HIGH_BITRATE = 1_000_000;
/** Arm C's raised AV1 high-layer cap. */
export const ARM_C_AV1_HIGH_BITRATE = 1_500_000;

export const ARMS: Record<ArmId, Arm> = {
  A: {
    id: "A",
    label: "AV1 baseline (default AV1 bitrate cap)",
    expectedCodec: "AV1",
    // The deployment's own order, made explicit.
    codecPreferenceOrder: ["AV1", "VP9", "VP8", "H264"],
    highBitrateOverride: null,
  },
  B: {
    id: "B",
    label: "VP8 comparison (default VP8 bitrate cap)",
    expectedCodec: "VP8",
    codecPreferenceOrder: ["VP8", "VP9", "AV1", "H264"],
    highBitrateOverride: null,
  },
  C: {
    id: "C",
    label: "AV1 with the high-layer cap raised to 1.5 Mbps",
    expectedCodec: "AV1",
    codecPreferenceOrder: ["AV1", "VP9", "VP8", "H264"],
    highBitrateOverride: { codec: "AV1", bitsPerSecond: ARM_C_AV1_HIGH_BITRATE },
  },
};

export function parseArmList(value: string | undefined): ArmId[] {
  const raw = (value ?? "all").trim().toUpperCase();

  if (raw === "ALL") {
    return ["A", "B", "C"];
  }

  const ids = raw.split(",").map((part) => part.trim()).filter(Boolean);

  if (ids.length === 0 || !ids.every((id): id is ArmId => id === "A" || id === "B" || id === "C")) {
    throw new Error(`Unknown test arm "${value}". Use A, B, C, a comma-separated list, or "all".`);
  }

  return Array.from(new Set(ids));
}

/**
 * A fresh, unique room per arm and run: never a classroom's room (those are
 * "saastution-..."), lowercase letters, digits and dashes only.
 */
export function buildRoomName(armId: ArmId, now: number, randomHex: string): string {
  if (!/^[0-9a-f]{6,}$/.test(randomHex)) {
    throw new Error("randomHex must be at least 6 lowercase hex characters.");
  }

  return `sl-codec-test-${armId.toLowerCase()}-${now.toString(36)}-${randomHex.slice(0, 8)}`;
}

/**
 * Jitsi config overrides for one participant of one arm, as dotted config
 * paths (so a nested key changes only itself, not its whole object).
 *
 * Shared by every arm and both roles (copied from the production embed):
 * resolution 720, camera height ideal 720 / max 1080 / min 240, simulcast
 * on, P2P off (a two-person call must still go through the bridge),
 * channelLastN 5, no prejoin screen.
 *
 * Differs on purpose:
 * - camera capped at 15 fps (Teaching Mode's cap, where 540p was seen);
 * - teacher starts with the camera ON (production: off until clicked; the
 *   encoder is the same either way); the student starts with camera and
 *   mic OFF, so the student's own upload never competes in the test;
 * - per arm: codec preference order, and arm C's AV1 high-layer cap.
 */
export function buildConfigOverrides(arm: Arm, role: Role): Array<[string, unknown]> {
  const overrides: Array<[string, unknown]> = [
    ["prejoinConfig.enabled", false],
    ["prejoinPageEnabled", false],
    ["startWithAudioMuted", true],
    ["startWithVideoMuted", role === "student"],
    ["resolution", 720],
    ["constraints.video.height", { ideal: 720, max: 1080, min: 240 }],
    // Teaching Mode's frame-rate cap, under which 540p was observed. The
    // production embed has none; these direct links run no SL page, so
    // Teaching Mode (and its contentHint "detail") is not active here.
    ["constraints.video.frameRate", { max: 15 }],
    ["disableSimulcast", false],
    ["p2p.enabled", false],
    ["channelLastN", 5],
    ["videoQuality.codecPreferenceOrder", arm.codecPreferenceOrder],
    ["videoQuality.mobileCodecPreferenceOrder", arm.codecPreferenceOrder],
  ];

  if (arm.highBitrateOverride) {
    overrides.push([
      `videoQuality.${arm.highBitrateOverride.codec.toLowerCase()}.maxBitratesVideo.high`,
      arm.highBitrateOverride.bitsPerSecond,
    ]);
  }

  return overrides;
}

/** "#config.a.b=<URI-encoded JSON>&..." as Jitsi parses it. */
export function buildConfigFragment(overrides: Array<[string, unknown]>): string {
  return overrides
    .map(([path, value]) => {
      if (!/^[A-Za-z0-9_.]+$/.test(path)) {
        throw new Error(`Invalid config path "${path}".`);
      }

      return `config.${path}=${encodeURIComponent(JSON.stringify(value))}`;
    })
    .join("&");
}

export function buildMeetingUrl(options: {
  domain: string;
  room: string;
  jwt: string;
  arm: Arm;
  role: Role;
}): string {
  const { domain, room, jwt, arm, role } = options;

  if (!/^[a-z0-9.-]+$/i.test(domain)) {
    throw new Error(`Invalid Jitsi domain "${domain}".`);
  }

  if (!/^[a-z0-9-]+$/.test(room)) {
    throw new Error(`Invalid room name "${room}".`);
  }

  const query = `jwt=${encodeURIComponent(jwt)}`;
  const fragment = buildConfigFragment(buildConfigOverrides(arm, role));

  return `https://${domain}/${room}?${query}#${fragment}`;
}

/** The same URL with the token replaced, safe for logs and the console. */
export function redactJwt(url: string): string {
  return url.replace(/([?&]jwt=)[^&#]*/, "$1<redacted>");
}
