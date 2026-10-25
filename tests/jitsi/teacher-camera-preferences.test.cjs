/*
 * Teacher camera preferences (components/Jitsi/teacher-camera-preferences.mjs):
 * the maximum-send-quality controller that re-applies the teacher's choice on
 * every conference join, stored-preference parsing, the Teaching Mode message,
 * and the contract with deploy/jitsi/custom.js (the frame rates it accepts).
 *
 *   npm run test:jitsi
 *
 * The controller is tested with a fake `send`; the custom.js contract runs
 * against the harness (a MOCK Jitsi store), not a real browser.
 */

"use strict";

const path = require("path");
const { pathToFileURL } = require("url");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

let modulePromise = null;

function load() {
    modulePromise = modulePromise || import(pathToFileURL(
        path.join(__dirname, "..", "..", "components", "Jitsi", "teacher-camera-preferences.mjs")).href);

    return modulePromise;
}

// A fake Jitsi command sender: records heights, can be "not ready".
function fakeSender() {
    const sent = [];
    const sender = {
        ready: true,
        sent,
        send(height) {
            if (!sender.ready) {
                return false;
            }

            sent.push(height);

            return true;
        }
    };

    return sender;
}

// ---- Quality re-application -----------------------------------------------------

test("quality chosen before Jitsi joins is kept and sent on the first join, once", async () => {
    const { createVideoQualityController } = await load();
    const sender = fakeSender();
    const quality = createVideoQualityController(sender.send);

    assert.equal(quality.setDesired(720), false, "not sent before a join");
    assert.deepEqual(sender.sent, []);

    assert.equal(quality.conferenceJoined(), true);
    assert.deepEqual(sender.sent, [720]);

    // The same choice again in the same conference: no repeated command.
    assert.equal(quality.setDesired(720), false);
    assert.deepEqual(sender.sent, [720]);
});

test("reconnect / breakout switch: left then joined sends the choice again, once per join", async () => {
    const { createVideoQualityController } = await load();
    const sender = fakeSender();
    const quality = createVideoQualityController(sender.send);

    quality.setDesired(480);
    quality.conferenceJoined();
    quality.conferenceLeft();

    // A choice made while between conferences waits for the join.
    assert.equal(quality.setDesired(320), false);
    quality.conferenceJoined();
    quality.conferenceJoined();

    assert.deepEqual(sender.sent, [480, 320, 320], "each join sends it once");
});

test("a new choice while joined is sent at once; nothing chosen means nothing sent", async () => {
    const { createVideoQualityController } = await load();
    const sender = fakeSender();
    const quality = createVideoQualityController(sender.send);

    quality.conferenceJoined();
    assert.deepEqual(sender.sent, [], "no choice: Jitsi's own default stays");

    quality.setDesired(720);
    quality.setDesired(320);

    assert.deepEqual(sender.sent, [720, 320]);
});

test("Jitsi not created yet: the choice is not marked as applied, so the next join sends it", async () => {
    const { createVideoQualityController } = await load();
    const sender = fakeSender();
    const quality = createVideoQualityController(sender.send);

    sender.ready = false;
    quality.conferenceJoined();
    quality.setDesired(720);

    assert.deepEqual(quality.state(), { desired: 720, applied: null, joined: true });

    sender.ready = true;
    quality.conferenceJoined();

    assert.deepEqual(sender.sent, [720]);
});

test("invalid heights are ignored and do not replace a valid choice", async () => {
    const { createVideoQualityController } = await load();
    const sender = fakeSender();
    const quality = createVideoQualityController(sender.send);

    quality.setDesired(720);

    for (const bad of [0, 360, 1080, 2160, "720", null, undefined, NaN, 720.5]) {
        assert.equal(quality.setDesired(bad), false, String(bad));
    }

    quality.conferenceJoined();
    assert.deepEqual(sender.sent, [720]);
});

// ---- Stored preferences -----------------------------------------------------------

test("stored quality: only the picker's heights", async () => {
    const { parseStoredVideoQuality, TEACHER_VIDEO_QUALITY_HEIGHTS } = await load();

    assert.deepEqual(Array.from(TEACHER_VIDEO_QUALITY_HEIGHTS), [720, 480, 320, 180]);

    for (const height of TEACHER_VIDEO_QUALITY_HEIGHTS) {
        assert.equal(parseStoredVideoQuality(String(height)), height);
    }

    for (const bad of [null, undefined, "", "999", "720p", " 720", "0", "-720", "1e3", "1080"]) {
        assert.equal(parseStoredVideoQuality(bad), null, String(bad));
    }
});

test("no 1080p: 720p is the highest option and the default; 1080 is rejected everywhere", async () => {
    const {
        TEACHER_VIDEO_QUALITY_HEIGHTS, DEFAULT_TEACHER_VIDEO_QUALITY, isTeacherVideoQualityHeight, createVideoQualityController
    } = await load();

    assert.equal(Math.max(...TEACHER_VIDEO_QUALITY_HEIGHTS), 720);
    assert.equal(DEFAULT_TEACHER_VIDEO_QUALITY, 720);
    assert.ok(TEACHER_VIDEO_QUALITY_HEIGHTS.includes(720));
    assert.ok(!TEACHER_VIDEO_QUALITY_HEIGHTS.includes(1080));
    assert.equal(isTeacherVideoQualityHeight(1080), false);
    assert.equal(isTeacherVideoQualityHeight(720), true);

    // Never sent to Jitsi, before or after a join.
    const sent = [];
    const quality = createVideoQualityController(height => { sent.push(height); return true; });

    assert.equal(quality.setDesired(1080), false);
    quality.conferenceJoined();
    assert.equal(quality.setDesired(1080), false);
    assert.deepEqual(sent, []);
});

test("a saved 1080 preference falls back to the 720 default (as SidebarNav starts) and 720 is sent on join", async () => {
    const { parseStoredVideoQuality, DEFAULT_TEACHER_VIDEO_QUALITY, createVideoQualityController } = await load();
    // SidebarNav: readStoredVideoQuality() ?? DEFAULT_TEACHER_VIDEO_QUALITY
    const initial = parseStoredVideoQuality("1080") ?? DEFAULT_TEACHER_VIDEO_QUALITY;
    const sent = [];
    const quality = createVideoQualityController(height => { sent.push(height); return true; });

    assert.equal(initial, 720);
    quality.setDesired(initial);
    quality.conferenceJoined();
    assert.deepEqual(sent, [720]);
});

test("removing 1080p leaves the bitrate presets unchanged", async () => {
    const { TEACHER_BITRATE_PRESETS, DEFAULT_TEACHER_BITRATE_BPS } = await load();

    assert.deepEqual(TEACHER_BITRATE_PRESETS.map(p => p.bps), [500000, 1000000, 1500000, 2500000]);
    assert.equal(DEFAULT_TEACHER_BITRATE_BPS, 1500000);
});

test("default quality: 720p, one of the picker's heights, and sent to Jitsi on join like a choice", async () => {
    const { DEFAULT_TEACHER_VIDEO_QUALITY, TEACHER_VIDEO_QUALITY_HEIGHTS, createVideoQualityController, parseStoredVideoQuality } = await load();

    assert.equal(DEFAULT_TEACHER_VIDEO_QUALITY, 720);
    assert.ok(TEACHER_VIDEO_QUALITY_HEIGHTS.includes(DEFAULT_TEACHER_VIDEO_QUALITY));

    // What SidebarNav starts with: the saved choice, else the default.
    const sent = [];
    const controller = createVideoQualityController(height => {
        sent.push(height);
        return true;
    });

    controller.setDesired(parseStoredVideoQuality(null) ?? DEFAULT_TEACHER_VIDEO_QUALITY);
    controller.conferenceJoined();

    assert.deepEqual(sent, [720]);
    assert.equal(parseStoredVideoQuality("480") ?? DEFAULT_TEACHER_VIDEO_QUALITY, 480, "a saved choice wins");
});

test("stored frame rate: 15 / 24 / 30, else the default 24", async () => {
    const { parseStoredFrameRate, TEACHING_FRAME_RATES, DEFAULT_TEACHING_FRAME_RATE } = await load();

    assert.deepEqual(Array.from(TEACHING_FRAME_RATES), [15, 24, 30]);
    assert.equal(DEFAULT_TEACHING_FRAME_RATE, 24);

    assert.equal(parseStoredFrameRate("15"), 15);
    assert.equal(parseStoredFrameRate("24"), 24);
    assert.equal(parseStoredFrameRate("30"), 30);

    for (const bad of [null, undefined, "", "20", "60", "24fps", "abc"]) {
        assert.equal(parseStoredFrameRate(bad), 24, String(bad));
    }
});

test("stored detail hint: 'true' / 'false', else the fallback", async () => {
    const { parseStoredBoolean } = await load();

    assert.equal(parseStoredBoolean("true", false), true);
    assert.equal(parseStoredBoolean("false", true), false);
    assert.equal(parseStoredBoolean(null, true), true);
    assert.equal(parseStoredBoolean("yes", false), false);
});

test("storage helpers never throw (no localStorage, or one that throws)", async () => {
    const { readStorage, writeStorage } = await load();

    assert.equal(readStorage("x"), null);
    assert.doesNotThrow(() => writeStorage("x", "1"));

    const saved = globalThis.localStorage;

    globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

    try {
        assert.equal(readStorage("x"), null);
        assert.doesNotThrow(() => writeStorage("x", "1"));
    } finally {
        if (saved === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = saved;
        }
    }
});

// ---- Teaching Mode message --------------------------------------------------------

test("Teaching Mode message: explicit maxFps and detailHint; bad values fall back to the defaults", async () => {
    const { buildTeachingModeMessage } = await load();

    assert.deepEqual(buildTeachingModeMessage(3, { enabled: true, maxFps: 24, detailHint: false }), {
        type: "SL_TEACHING_MODE", v: 1, epoch: 3, enabled: true, maxFps: 24, detailHint: false
    });
    assert.deepEqual(buildTeachingModeMessage(4, { enabled: false, maxFps: 20, detailHint: "no" }), {
        type: "SL_TEACHING_MODE", v: 1, epoch: 4, enabled: false, maxFps: 24, detailHint: true
    });
});

// ---- Contract with custom.js ------------------------------------------------------

async function sendToCustomJs(h, message) {
    h.postFromParent(message);

    for (let i = 0; i < 4; i += 1) {
        await h.flush();
    }

    const statuses = h.posted.filter(posted => posted.type === "SL_TEACHING_MODE_STATUS");

    return statuses.length ? JSON.parse(JSON.stringify(statuses[statuses.length - 1])) : null;
}

test("custom.js accepts every frame rate the app offers, from the app's own message builder", async () => {
    const { buildTeachingModeMessage, TEACHING_FRAME_RATES } = await load();

    for (const maxFps of TEACHING_FRAME_RATES) {
        for (const detailHint of [true, false]) {
            const h = createHarness();

            h.timers.advance(600);
            h.change();

            const status = await sendToCustomJs(h, buildTeachingModeMessage(1, { enabled: false, maxFps, detailHint }));

            assert.equal(status?.maxFps, maxFps, `maxFps ${maxFps}`);
            assert.equal(status?.detailHint, detailHint);
        }
    }
});

test("custom.js refuses frame rates the app does not offer", async () => {
    for (const maxFps of [10, 20, 25, 60, "15"]) {
        const h = createHarness();

        h.timers.advance(600);
        h.change();

        const status = await sendToCustomJs(h, { type: "SL_TEACHING_MODE", v: 1, epoch: 1, enabled: true, maxFps });

        assert.equal(status, null, `maxFps ${maxFps} must be ignored`);
    }
});

// ---- Frame-rate status line ---------------------------------------------------------

test("frame-rate status line: what the camera track reports, never what is sent", async () => {
    const { describeFrameRateStatus } = await load();
    const base = { camera: true, frameRate: "applied", fps: 24, maxFps: 24 };

    assert.equal(describeFrameRateStatus(null, 24), "Not confirmed by the meeting yet.");
    assert.equal(describeFrameRateStatus({ ...base, maxFps: null }, 24), "Not confirmed by this meeting server.");
    assert.equal(describeFrameRateStatus({ ...base, maxFps: 15 }, 24), "Applying…", "an earlier choice still reported");
    assert.equal(describeFrameRateStatus({ ...base, frameRate: "pending" }, 24), "Applying…");
    assert.equal(describeFrameRateStatus({ ...base, camera: false, frameRate: null, fps: null }, 24), "Not applied to a camera yet.");
    assert.equal(describeFrameRateStatus(base, 24), "Camera capped at 24 fps (camera reports 24 fps).");
    assert.equal(describeFrameRateStatus({ ...base, fps: null }, 24), "Camera capped at 24 fps.");
    assert.equal(describeFrameRateStatus({ ...base, frameRate: "kept", fps: 15 }, 24), "Camera already at or below 24 fps (camera reports 15 fps).");
    assert.equal(describeFrameRateStatus({ ...base, frameRate: "unsupported" }, 24), "This camera does not accept a 24 fps cap.");
    assert.equal(describeFrameRateStatus({ ...base, frameRate: "failed" }, 24), "The 24 fps cap could not be applied.");

    // A reported track rate above the cap is shown as reported, not hidden.
    assert.equal(describeFrameRateStatus({ ...base, fps: 30 }, 24), "Camera capped at 24 fps (camera reports 30 fps).");

    for (const message of [
        describeFrameRateStatus(base, 24),
        describeFrameRateStatus({ ...base, frameRate: "kept" }, 24)
    ]) {
        assert.doesNotMatch(message, /send|sent|students/i);
    }
});

// ---- Teacher bitrate cap (configOverwrite) -----------------------------------------

test("teacher bitrate cap: exactly the three dotted high-level keys at 1.5 Mbps; H.264 left out", async () => {
    const { buildTeacherBitrateConfig, TEACHER_MAX_VIDEO_BITRATE_BPS, TEACHER_BITRATE_CODECS } = await load();

    assert.equal(TEACHER_MAX_VIDEO_BITRATE_BPS, 1_500_000);
    assert.deepEqual(Array.from(TEACHER_BITRATE_CODECS), ["av1", "vp8", "vp9"]);
    assert.deepEqual({ ...buildTeacherBitrateConfig("teacher") }, {
        "videoQuality.av1.maxBitratesVideo.high": 1_500_000,
        "videoQuality.vp8.maxBitratesVideo.high": 1_500_000,
        "videoQuality.vp9.maxBitratesVideo.high": 1_500_000
    });
});

test("teacher bitrate cap: never a whole videoQuality object, codec order, other levels or H.264", async () => {
    const { buildTeacherBitrateConfig } = await load();
    const keys = Object.keys(buildTeacherBitrateConfig("teacher"));

    assert.ok(!keys.includes("videoQuality"), "no whole videoQuality object (it could replace server settings)");
    assert.ok(keys.every(key => /^videoQuality\.(av1|vp8|vp9)\.maxBitratesVideo\.high$/.test(key)), keys.join(", "));
    assert.ok(!keys.some(key => /h264|codecPreferenceOrder|preferredCodec|disabledCodec|low|standard|fullHd|ultraHd/i.test(key)));
    assert.ok(Object.values(buildTeacherBitrateConfig("teacher")).every(value => typeof value === "number"));
});

test("teacher bitrate cap: students (and anything but the teacher role) get nothing", async () => {
    const { buildTeacherBitrateConfig } = await load();

    for (const role of ["student", "", undefined, "Teacher", "moderator"]) {
        assert.deepEqual({ ...buildTeacherBitrateConfig(role) }, {}, String(role));
    }
});

test("teacher bitrate cap: the External API's URL encoding gives the same parameters arm C used", async () => {
    const { buildTeacherBitrateConfig } = await load();
    // The deployed external_api.js turns each configOverwrite key into
    // `config.${key}=${encodeURIComponent(JSON.stringify(value))}` (the key is not encoded).
    const params = Object.entries(buildTeacherBitrateConfig("teacher"))
        .map(([key, value]) => `config.${key}=${encodeURIComponent(JSON.stringify(value))}`);

    assert.deepEqual(params, [
        "config.videoQuality.av1.maxBitratesVideo.high=1500000",
        "config.videoQuality.vp8.maxBitratesVideo.high=1500000",
        "config.videoQuality.vp9.maxBitratesVideo.high=1500000"
    ]);
});

// ---- Teacher Video Bitrate selector ------------------------------------------------

test("bitrate presets: Low / Standard / Standard+ / High with their exact caps and texts", async () => {
    const { TEACHER_BITRATE_PRESETS } = await load();

    assert.deepEqual(TEACHER_BITRATE_PRESETS.map(p => [p.id, p.label, p.bps, p.description]), [
        ["low", "Low", 500000, "Lower data usage"],
        ["standard", "Standard", 1000000, "Balanced option for saving data"],
        ["standard-plus", "Standard+", 1500000, "Good video detail for teaching"],
        ["high", "High", 2500000, "Higher potential video quality"]
    ]);
    assert.deepEqual(TEACHER_BITRATE_PRESETS.filter(p => p.recommended).map(p => p.id), ["standard-plus"]);
    assert.deepEqual(TEACHER_BITRATE_PRESETS.filter(p => p.warning).map(p => [p.id, p.warning]), [
        ["high", "Uses more mobile data. Choose this option if your connection and data allowance can support it."]
    ]);
});

test("bitrate default: Standard+ 1.5 Mbps (current behaviour); stored values only from the presets", async () => {
    const { DEFAULT_TEACHER_BITRATE_BPS, TEACHER_MAX_VIDEO_BITRATE_BPS, parseStoredTeacherBitrate, isTeacherBitrate } = await load();

    assert.equal(DEFAULT_TEACHER_BITRATE_BPS, 1500000);
    assert.equal(TEACHER_MAX_VIDEO_BITRATE_BPS, 1500000);

    for (const bps of [500000, 1000000, 1500000, 2500000]) {
        assert.equal(parseStoredTeacherBitrate(String(bps)), bps);
        assert.equal(isTeacherBitrate(bps), true);
    }

    for (const bad of [null, undefined, "", "2000000", "1.5e6", "abc", "-500000", "1500000 "]) {
        assert.equal(parseStoredTeacherBitrate(bad), 1500000, String(bad));
    }

    assert.equal(isTeacherBitrate(2000000), false);
    assert.equal(isTeacherBitrate("1500000"), false);
});

test("bitrate at join: the chosen preset as the three dotted keys; students and invalid values handled", async () => {
    const { buildTeacherBitrateConfig } = await load();

    for (const bps of [500000, 1000000, 1500000, 2500000]) {
        assert.deepEqual({ ...buildTeacherBitrateConfig("teacher", bps) }, {
            "videoQuality.av1.maxBitratesVideo.high": bps,
            "videoQuality.vp8.maxBitratesVideo.high": bps,
            "videoQuality.vp9.maxBitratesVideo.high": bps
        });
    }

    assert.deepEqual({ ...buildTeacherBitrateConfig("teacher", 1234567) }, { ...buildTeacherBitrateConfig("teacher") });
    assert.deepEqual({ ...buildTeacherBitrateConfig("student", 2500000) }, {});
});

test("bitrate live message: SL_TEACHER_BITRATE with the cap; a bad value falls back to the default", async () => {
    const { buildTeacherBitrateMessage } = await load();

    assert.deepEqual({ ...buildTeacherBitrateMessage(3, 2500000) }, { type: "SL_TEACHER_BITRATE", v: 1, epoch: 3, maxBitrate: 2500000 });
    assert.equal(buildTeacherBitrateMessage(4, 42).maxBitrate, 1500000);
});

test("bitrate status: custom.js's report is parsed strictly", async () => {
    const { parseTeacherBitrateStatus } = await load();
    const ok = { type: "SL_TEACHER_BITRATE_STATUS", v: 1, maxBitrate: 1500000, state: "applied", topMaxBitrate: 1500000, codec: "av1" };

    assert.deepEqual({ ...parseTeacherBitrateStatus(ok) }, { maxBitrate: 1500000, state: "applied", topMaxBitrate: 1500000, codec: "av1" });
    assert.ok(parseTeacherBitrateStatus({ ...ok, topMaxBitrate: null, codec: null }));

    for (const bad of [null, {}, { ...ok, v: 2 }, { ...ok, type: "X" }, { ...ok, maxBitrate: 2000000 }, { ...ok, state: "done" },
        { ...ok, topMaxBitrate: -1 }, { ...ok, topMaxBitrate: "1" }, { ...ok, codec: "<b>" }]) {
        assert.equal(parseTeacherBitrateStatus(bad), null, JSON.stringify(bad));
    }
});

test("bitrate status line: honest about live vs next join, smaller sizes and H.264", async () => {
    const { describeTeacherBitrateStatus } = await load();
    const status = (extra) => ({ maxBitrate: 1500000, state: "applied", topMaxBitrate: 1500000, codec: "av1", ...extra });

    assert.equal(describeTeacherBitrateStatus(null, 1500000), "1.5 Mbps cap is used from the next time you join.");
    assert.equal(describeTeacherBitrateStatus(status(), 1500000), "Applied to your camera (AV1): up to 1.5 Mbps.");
    assert.equal(describeTeacherBitrateStatus(status({ maxBitrate: 2500000, topMaxBitrate: 2500000 }), 2500000),
        "Applied to your camera (AV1): up to 2.5 Mbps.");
    assert.equal(describeTeacherBitrateStatus(status({ maxBitrate: 500000, topMaxBitrate: 500000, codec: "vp8" }), 500000),
        "Applied to your camera (VP8): up to 500 kbps.");
    assert.match(describeTeacherBitrateStatus(status({ topMaxBitrate: 300000 }), 1500000),
        /smaller size \(limit 300 kbps\) because of what students request/);
    assert.equal(describeTeacherBitrateStatus(status(), 2500000), "Applying…", "an earlier choice still reported");
    assert.equal(describeTeacherBitrateStatus(status({ state: "pending" }), 1500000), "Applying…");
    assert.match(describeTeacherBitrateStatus(status({ state: "unsupported" }), 1500000), /next time you join/);
    assert.match(describeTeacherBitrateStatus(status({ state: "failed" }), 1500000), /next time you join/);
    assert.match(describeTeacherBitrateStatus(status({ codec: "h264" }), 1500000), /H264, which keeps Jitsi's own cap/);
});
