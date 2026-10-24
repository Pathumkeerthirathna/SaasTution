/*
 * Codec test arms, room names and meeting links (scripts/codec-test/arms.ts).
 *
 *   npm run test:codec
 *
 * Pure functions only: no token is created and nothing is opened.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ARMS,
  ARM_C_AV1_HIGH_BITRATE,
  buildConfigFragment,
  buildConfigOverrides,
  buildMeetingUrl,
  buildRoomName,
  parseArmList,
  redactJwt,
  type ArmId,
  type Role,
} from "../../scripts/codec-test/arms";

const toMap = (overrides: Array<[string, unknown]>) => new Map(overrides);

// Parses "#config.a=<json>&config.b=<json>" back into { "a": value, ... }.
function parseFragment(fragment: string): Record<string, unknown> {
  return Object.fromEntries(fragment.replace(/^#/, "").split("&").map((part) => {
    const index = part.indexOf("=");

    assert.ok(part.startsWith("config."), `"${part}" is not a config override`);

    return [part.slice("config.".length, index), JSON.parse(decodeURIComponent(part.slice(index + 1)))];
  }));
}

// ---- Arms -------------------------------------------------------------------------

test("parseArmList: all, single, list, case and duplicates", () => {
  assert.deepEqual(parseArmList(undefined), ["A", "B", "C"]);
  assert.deepEqual(parseArmList("all"), ["A", "B", "C"]);
  assert.deepEqual(parseArmList("b"), ["B"]);
  assert.deepEqual(parseArmList(" A , c "), ["A", "C"]);
  assert.deepEqual(parseArmList("A,A"), ["A"]);
});

test("parseArmList: unknown or empty arms are refused", () => {
  for (const bad of ["D", "A,D", "", ",", "AV1"]) {
    assert.throws(() => parseArmList(bad), /Unknown test arm/, bad);
  }
});

test("arms: A and C prefer AV1, B prefers VP8; only C raises a cap (AV1 high, 1.5 Mbps)", () => {
  assert.equal(ARMS.A.codecPreferenceOrder[0], "AV1");
  assert.equal(ARMS.B.codecPreferenceOrder[0], "VP8");
  assert.equal(ARMS.C.codecPreferenceOrder[0], "AV1");
  assert.equal(ARMS.A.expectedCodec, "AV1");
  assert.equal(ARMS.B.expectedCodec, "VP8");
  assert.equal(ARMS.C.expectedCodec, "AV1");
  assert.equal(ARMS.A.highBitrateOverride, null);
  assert.equal(ARMS.B.highBitrateOverride, null);
  assert.deepEqual(ARMS.C.highBitrateOverride, { codec: "AV1", bitsPerSecond: 1_500_000 });
  assert.equal(ARM_C_AV1_HIGH_BITRATE, 1_500_000);
});

test("every arm and role: production camera settings, simulcast on, P2P off", () => {
  for (const armId of ["A", "B", "C"] as ArmId[]) {
    for (const role of ["teacher", "student"] as Role[]) {
      const config = toMap(buildConfigOverrides(ARMS[armId], role));

      assert.equal(config.get("resolution"), 720);
      assert.deepEqual(config.get("constraints.video.height"), { ideal: 720, max: 1080, min: 240 });
      assert.deepEqual(config.get("constraints.video.frameRate"), { max: 15 });
      assert.equal(config.get("disableSimulcast"), false);
      assert.equal(config.get("p2p.enabled"), false);
      assert.equal(config.get("channelLastN"), 5);
      assert.deepEqual(config.get("videoQuality.codecPreferenceOrder"), ARMS[armId].codecPreferenceOrder);
      assert.deepEqual(config.get("videoQuality.mobileCodecPreferenceOrder"), ARMS[armId].codecPreferenceOrder);
    }
  }
});

test("roles: the teacher starts with the camera on, the student with camera and mic off", () => {
  const teacher = toMap(buildConfigOverrides(ARMS.A, "teacher"));
  const student = toMap(buildConfigOverrides(ARMS.A, "student"));

  assert.equal(teacher.get("startWithVideoMuted"), false);
  assert.equal(student.get("startWithVideoMuted"), true);
  assert.equal(teacher.get("startWithAudioMuted"), true);
  assert.equal(student.get("startWithAudioMuted"), true);
});

test("arms differ only in the documented settings", () => {
  const keysWithValue = (armId: ArmId) =>
    new Map(buildConfigOverrides(ARMS[armId], "teacher").map(([key, value]) => [key, JSON.stringify(value)]));
  const differences = (x: ArmId, y: ArmId) => {
    const a = keysWithValue(x);
    const b = keysWithValue(y);

    return Array.from(new Set([...a.keys(), ...b.keys()])).filter((key) => a.get(key) !== b.get(key)).sort();
  };

  assert.deepEqual(differences("A", "B"), ["videoQuality.codecPreferenceOrder", "videoQuality.mobileCodecPreferenceOrder"]);
  assert.deepEqual(differences("A", "C"), ["videoQuality.av1.maxBitratesVideo.high"]);
  assert.equal(toMap(buildConfigOverrides(ARMS.C, "student")).get("videoQuality.av1.maxBitratesVideo.high"), 1_500_000);
});

// ---- Rooms ------------------------------------------------------------------------

test("room names: isolated prefix, arm, time and random part; lowercase only", () => {
  const room = buildRoomName("B", 1_760_000_000_000, "a1b2c3d4");

  assert.match(room, /^sl-codec-test-b-[0-9a-z]+-a1b2c3d4$/);
  assert.ok(!room.startsWith("saastution-"), "never a classroom room name");
});

test("room names: unique per arm, time and random part", () => {
  const rooms = new Set([
    buildRoomName("A", 1000, "aaaaaa"),
    buildRoomName("B", 1000, "aaaaaa"),
    buildRoomName("A", 1001, "aaaaaa"),
    buildRoomName("A", 1000, "aaaaab"),
  ]);

  assert.equal(rooms.size, 4);
});

test("room names: a malformed random part is refused", () => {
  for (const bad of ["", "abc", "ABCDEF", "zzzzzz", "12 456"]) {
    assert.throws(() => buildRoomName("A", 1, bad), /randomHex/, bad);
  }
});

// ---- Links ------------------------------------------------------------------------

test("fragment: each override is config.<path>=<URI-encoded JSON>, round-trips exactly", () => {
  const overrides = buildConfigOverrides(ARMS.C, "teacher");
  const fragment = buildConfigFragment(overrides);

  assert.doesNotMatch(fragment, /[\s"{}[\],]/, "JSON punctuation and spaces are encoded");
  assert.deepEqual(parseFragment(fragment), Object.fromEntries(overrides));
});

test("fragment: a config path with unexpected characters is refused", () => {
  assert.throws(() => buildConfigFragment([["p2p.enabled&x", false]]), /Invalid config path/);
  assert.throws(() => buildConfigFragment([["a=b", 1]]), /Invalid config path/);
});

test("meeting URL: https, domain, room path, token in the query, config in the fragment", () => {
  const jwt = "header.pay+load/x=.sig";
  const url = buildMeetingUrl({ domain: "meet.example.test", room: "sl-codec-test-a-1-abcdef", jwt, arm: ARMS.A, role: "student" });
  const parsed = new URL(url);

  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.host, "meet.example.test");
  assert.equal(parsed.pathname, "/sl-codec-test-a-1-abcdef");
  assert.equal(parsed.searchParams.get("jwt"), jwt);
  assert.deepEqual(parseFragment(parsed.hash), Object.fromEntries(buildConfigOverrides(ARMS.A, "student")));
});

test("meeting URL: malformed domain or room is refused", () => {
  const base = { domain: "meet.example.test", room: "sl-codec-test-a-1-abcdef", jwt: "x", arm: ARMS.A, role: "teacher" as Role };

  assert.throws(() => buildMeetingUrl({ ...base, domain: "evil.test/path" }), /Invalid Jitsi domain/);
  assert.throws(() => buildMeetingUrl({ ...base, room: "Room With Spaces" }), /Invalid room name/);
  assert.throws(() => buildMeetingUrl({ ...base, room: "../x" }), /Invalid room name/);
});

test("redactJwt: the token never appears; the rest of the link is kept", () => {
  const jwt = "aaa.bbb.ccc";
  const url = buildMeetingUrl({ domain: "meet.example.test", room: "sl-codec-test-b-1-abcdef", jwt, arm: ARMS.B, role: "teacher" });
  const redacted = redactJwt(url);

  assert.ok(!redacted.includes(jwt));
  assert.match(redacted, /\?jwt=<redacted>#config\./);
  assert.equal(redacted.split("#")[1], url.split("#")[1]);
});
