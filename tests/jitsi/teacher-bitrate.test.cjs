/*
 * Regression tests: the teacher's live video bitrate cap (deploy/jitsi/custom.js,
 * "Teacher Video Bitrate"): SL_TEACHER_BITRATE sets the AV1 / VP8 / VP9 "high"
 * cap in lib-jitsi-meet's codec settings on the bridge connection, then asks
 * lib-jitsi-meet to re-apply the camera's encodings, and reports back.
 *
 *   npm run test:jitsi
 *
 * The bridge connection here is a MOCK of lib-jitsi-meet's
 * TraceablePeerConnection (tpcUtils.codecSettings, configureVideoSenderEncodings,
 * the camera RTCRtpSender). These tests check what custom.js changes and calls;
 * they do not show what a real browser encoder sends. That needs a real meeting.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

const plain = value => JSON.parse(JSON.stringify(value));

// lib-jitsi-meet's defaults (the deployed build's per-codec maxBitratesVideo).
function defaultCodecSettings() {
    return {
        av1: { maxBitratesVideo: { fullHd: 2e6, high: 1e6, low: 1e5, none: 0, ssHigh: 25e5, standard: 3e5, ultraHd: 4e6 } },
        h264: { maxBitratesVideo: { fullHd: 4e6, high: 2e6, low: 4e5, none: 0, ssHigh: 25e5, standard: 8e5, ultraHd: 8e6 } },
        vp8: { maxBitratesVideo: { fullHd: 3e6, high: 15e5, low: 2e5, none: 0, ssHigh: 25e5, standard: 5e5, ultraHd: 6e6 } },
        vp9: { maxBitratesVideo: { fullHd: 25e5, high: 12e5, low: 1e5, none: 0, ssHigh: 25e5, standard: 3e5, ultraHd: 1e7 } }
    };
}

/*
 * A bridge connection model. configureVideoSenderEncodings re-computes the
 * camera's top encoding from the codec settings, as lib-jitsi-meet does.
 *   codec: the negotiated codec; utils / configure: false = missing API;
 *   failWith: error name the next re-apply rejects with.
 */
function fakeConnection({ codec = "av1", utils = true, configure = true } = {}) {
    const settings = defaultCodecSettings();
    const camera = { kind: "video", id: "cam-track-1", readyState: "live" };
    const sender = {
        track: camera,
        encodings: [
            { active: true, maxBitrate: settings[codec].maxBitratesVideo.high, scaleResolutionDownBy: 1, scalabilityMode: "L3T3_KEY" },
            { active: false, maxBitrate: 0, scaleResolutionDownBy: 2 },
            { active: false, maxBitrate: 0, scaleResolutionDownBy: 4 }
        ],
        getParameters: () => ({ codecs: [{ mimeType: "video/" + codec.toUpperCase() }], encodings: sender.encodings.map(e => ({ ...e })) })
    };
    const tpc = {
        reapplied: 0,
        failWith: null,
        // The TPC's own codec list (codec choice): never touched by the cap.
        codecSettings: { codecList: ["av1", "vp9", "vp8", "h264"] },
        peerconnection: { getSenders: () => [sender] }
    };

    if (utils) {
        tpc.tpcUtils = { codecSettings: settings };
    }

    if (configure) {
        tpc.configureVideoSenderEncodings = () => {
            tpc.reapplied += 1;

            if (tpc.failWith) {
                const name = tpc.failWith;

                tpc.failWith = null;

                return Promise.reject(Object.assign(new Error(name), { name }));
            }

            sender.encodings[0].maxBitrate = settings[codec].maxBitratesVideo.high;

            return Promise.resolve();
        };
    }

    return { tpc, settings, sender, camera };
}

function addLocalCamera(h, camera) {
    h.state["features/base/tracks"].push({
        local: true,
        mediaType: "video",
        videoType: "camera",
        muted: false,
        isReceivingData: true,
        participantId: h.participants.local.id,
        jitsiTrack: {
            getTrack: () => camera,
            isMuted: () => false,
            getSourceName: () => h.participants.local.id + "-v0",
            attach: () => Promise.resolve(),
            detach() {},
            on() {},
            off() {}
        }
    });
}

async function settle(h) {
    for (let i = 0; i < 4; i += 1) {
        await h.flush();
    }
}

// Joined, custom.js attached to the store; role: the local Jitsi role.
async function setup({ role = "moderator", connection = fakeConnection() } = {}) {
    const h = createHarness();

    h.participants.local.role = role;
    h.conference().jvbJingleSession = { peerconnection: connection.tpc };
    addLocalCamera(h, connection.camera);
    h.timers.advance(600);
    h.change();
    await settle(h);

    return { h, ...connection };
}

let nextEpoch = 0;

async function sendCap(h, maxBitrate, epoch = (nextEpoch += 1)) {
    h.postFromParent({ type: "SL_TEACHER_BITRATE", v: 1, epoch, maxBitrate });
    await settle(h);
}

const statuses = h => h.posted.filter(message => message.type === "SL_TEACHER_BITRATE_STATUS").map(plain);
const lastStatus = h => statuses(h).at(-1) || null;
const highs = settings => Object.fromEntries(Object.entries(settings).map(([codec, s]) => [codec, s.maxBitratesVideo.high]));

test("nothing happens before the page sends a cap: settings untouched, no status", async () => {
    const { h, tpc, settings } = await setup();

    h.timers.advance(5000);
    await settle(h);

    assert.deepEqual(highs(settings), { av1: 1e6, h264: 2e6, vp8: 15e5, vp9: 12e5 });
    assert.equal(tpc.reapplied, 0);
    assert.equal(statuses(h).length, 0);
});

test("Standard+ (default 1.5 Mbps): AV1 / VP8 / VP9 high set, H.264 and every other level unchanged", async () => {
    const { h, tpc, settings, sender } = await setup();
    const before = plain(settings);

    await sendCap(h, 1500000);

    assert.deepEqual(highs(settings), { av1: 1500000, h264: 2e6, vp8: 1500000, vp9: 1500000 });

    for (const codec of Object.keys(settings)) {
        for (const level of ["low", "standard", "fullHd", "ultraHd", "ssHigh", "none"]) {
            assert.equal(settings[codec].maxBitratesVideo[level], before[codec].maxBitratesVideo[level], `${codec}.${level}`);
        }
    }

    assert.equal(tpc.reapplied, 1, "lib-jitsi-meet asked once to re-apply the encodings");
    assert.equal(sender.encodings[0].maxBitrate, 1500000, "the live top encoding carries the cap");
    assert.deepEqual(lastStatus(h), {
        type: "SL_TEACHER_BITRATE_STATUS", v: 1, maxBitrate: 1500000, state: "applied", topMaxBitrate: 1500000, codec: "av1"
    });
});

test("changing the selection updates the live cap each time; never stacked", async () => {
    const { h, tpc, settings, sender } = await setup();

    for (const bps of [2500000, 500000, 1000000, 1500000]) {
        await sendCap(h, bps);

        assert.deepEqual(highs(settings), { av1: bps, h264: 2e6, vp8: bps, vp9: bps });
        assert.equal(sender.encodings[0].maxBitrate, bps);
        assert.equal(lastStatus(h).state, "applied");
        assert.equal(lastStatus(h).maxBitrate, bps);
    }

    assert.equal(tpc.reapplied, 4);
});

test("the same cap again (page resend after SL_RECEIVE_READY): not re-applied, status reported again", async () => {
    const { h, tpc } = await setup();

    await sendCap(h, 1500000, 50);
    const before = statuses(h).length;

    await sendCap(h, 1500000, 50);

    assert.equal(tpc.reapplied, 1);
    assert.equal(statuses(h).length, before + 1);
    assert.equal(lastStatus(h).state, "applied");
});

test("codec choice is never touched: the connection's codec list and the negotiated codec stay", async () => {
    const { h, tpc } = await setup({ connection: fakeConnection({ codec: "vp8" }) });

    await sendCap(h, 2500000);

    assert.deepEqual(tpc.codecSettings.codecList, ["av1", "vp9", "vp8", "h264"]);
    assert.equal(lastStatus(h).codec, "vp8");
    assert.equal(lastStatus(h).topMaxBitrate, 2500000);
});

test("H.264 negotiated: its own cap stays 2 Mbps; reported as H.264", async () => {
    const { h, settings, sender } = await setup({ connection: fakeConnection({ codec: "h264" }) });

    await sendCap(h, 500000);

    assert.equal(settings.h264.maxBitratesVideo.high, 2e6);
    assert.equal(sender.encodings[0].maxBitrate, 2e6);
    assert.equal(lastStatus(h).codec, "h264");
});

test("a student (not a moderator) is never changed and never reports", async () => {
    const { h, tpc, settings } = await setup({ role: "participant" });

    await sendCap(h, 2500000);
    h.timers.advance(5000);
    await settle(h);

    assert.deepEqual(highs(settings), { av1: 1e6, h264: 2e6, vp8: 15e5, vp9: 12e5 });
    assert.equal(tpc.reapplied, 0);
    assert.equal(statuses(h).length, 0);
});

test("missing lib-jitsi-meet internals: reported unsupported, nothing changed", async () => {
    for (const options of [{ utils: false }, { configure: false }]) {
        const { h, tpc, settings } = await setup({ connection: fakeConnection(options) });

        await sendCap(h, 2500000);

        assert.equal(lastStatus(h).state, "unsupported", JSON.stringify(options));
        assert.equal(tpc.reapplied, 0);

        if (options.configure === false) {
            assert.deepEqual(highs(settings), { av1: 1e6, h264: 2e6, vp8: 15e5, vp9: 12e5 }, "nothing half-applied");
        }
    }
});

test("no bridge connection yet: pending; applied once it exists", async () => {
    const connection = fakeConnection();
    const h = createHarness();

    h.participants.local.role = "moderator";
    addLocalCamera(h, connection.camera);
    h.timers.advance(600);
    h.change();
    await sendCap(h, 1000000);

    assert.equal(lastStatus(h).state, "pending");

    h.conference().jvbJingleSession = { peerconnection: connection.tpc };
    h.change();
    await settle(h);

    assert.equal(connection.settings.av1.maxBitratesVideo.high, 1000000);
    assert.equal(lastStatus(h).state, "applied");
});

test("a re-apply that fails is reported failed and tried again on the next poll", async () => {
    const { h, tpc, sender } = await setup();

    tpc.failWith = "InvalidModificationError";
    await sendCap(h, 2500000);

    assert.equal(lastStatus(h).state, "failed");
    assert.ok(h.warnings.some(args => String(args[0]).includes("Teacher bitrate")));

    h.timers.advance(2000);
    await settle(h);

    assert.equal(tpc.reapplied, 2);
    assert.equal(sender.encodings[0].maxBitrate, 2500000);
    assert.equal(lastStatus(h).state, "applied");
});

test("reconnect: a new bridge connection gets the latest cap again (store change or poll)", async () => {
    const { h } = await setup();

    await sendCap(h, 2500000);

    // A new connection without a store change: the poll catches it.
    const next = fakeConnection();

    h.conference().jvbJingleSession = { peerconnection: next.tpc };
    addLocalCamera(h, next.camera);
    h.timers.advance(2000);
    await settle(h);

    assert.deepEqual(highs(next.settings), { av1: 2500000, h264: 2e6, vp8: 2500000, vp9: 2500000 });
    assert.equal(next.tpc.reapplied, 1);
});

test("camera track replaced on the same connection: the cap stays in the codec settings, not re-applied", async () => {
    const { h, tpc, settings, sender } = await setup();

    await sendCap(h, 500000);

    const replacement = { kind: "video", id: "cam-track-2", readyState: "live" };

    sender.track = replacement;
    h.state["features/base/tracks"][0].jitsiTrack.getTrack = () => replacement;
    h.change();
    h.timers.advance(2000);
    await settle(h);

    assert.equal(tpc.reapplied, 1);
    assert.equal(settings.av1.maxBitratesVideo.high, 500000, "lib-jitsi-meet's next recompute keeps using it");
    assert.equal(lastStatus(h).topMaxBitrate, 500000);
});

test("students requesting a smaller size: the smaller live encoding limit is reported, the cap kept", async () => {
    const { h, sender } = await setup();

    await sendCap(h, 1500000);

    // lib-jitsi-meet moved the camera to its "standard" level (students at 360p).
    sender.encodings[0].maxBitrate = 300000;
    sender.encodings[0].scaleResolutionDownBy = 2;
    h.timers.advance(2000);
    await settle(h);

    assert.equal(lastStatus(h).maxBitrate, 1500000);
    assert.equal(lastStatus(h).topMaxBitrate, 300000);
});

test("malformed messages and older epochs are ignored", async () => {
    const { h, settings } = await setup();

    await sendCap(h, 1000000, 100);

    for (const message of [
        { type: "SL_TEACHER_BITRATE", v: 1, epoch: 101, maxBitrate: 2000000 },
        { type: "SL_TEACHER_BITRATE", v: 1, epoch: 102, maxBitrate: "2500000" },
        { type: "SL_TEACHER_BITRATE", v: 2, epoch: 103, maxBitrate: 2500000 },
        { type: "SL_TEACHER_BITRATE", v: 1, epoch: "104", maxBitrate: 2500000 }
    ]) {
        h.postFromParent(message);
    }

    await settle(h);
    await sendCap(h, 2500000, 99);

    assert.equal(settings.av1.maxBitratesVideo.high, 1000000);
    assert.ok(h.warnings.filter(args => String(args[0]).includes("malformed teacher bitrate")).length >= 4);
});
