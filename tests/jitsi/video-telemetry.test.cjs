/*
 * Regression tests: video diagnostics (Phase 1, read-only) in
 * deploy/jitsi/custom.js and components/Jitsi/video-telemetry.mjs.
 *
 *   npm run test:jitsi
 *
 * The WebRTC stats here are MOCK RTCStatsReport entries shaped like
 * Chrome's (outbound-rtp, media-source, remote-inbound-rtp, inbound-rtp,
 * candidate-pair, codec), and the bridge data channel is a mock
 * sendEndpointMessage / endpoint event. These tests check custom.js's
 * parsing, delta maths and lifecycle; they do not show what a real browser
 * reports (field support varies by browser and version).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const { createHarness } = require("./harness.cjs");

const ENDPOINT_EVENT = "conference.endpoint_message_received";
const REQUEST = { type: "sl-video-telemetry-request", v: 1 };

let telemetryModule = null;

async function loadTelemetry() {
    if (!telemetryModule) {
        telemetryModule = await import(pathToFileURL(
            path.join(__dirname, "..", "..", "components", "Jitsi", "video-telemetry.mjs")).href);
    }

    return telemetryModule;
}

// Plain objects of this realm (the vm context has its own Object.prototype).
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---- Mock stats ----------------------------------------------------------

// The teacher's camera as Chrome reports it after `seconds` of sending at
// `fps` encoded / `captureFps` captured / `kbps`, one AV1 SVC encoding.
function sendStats(seconds, {
    fps = 21,
    captureFps = 30,
    kbps = 1000,
    height = 720,
    width = 1280,
    limitation = "bandwidth",
    bandwidthShare = 0.4,
    lostPerSecond = 0.2,
    encodeMs = 18,
    trackId = "cam-track-1",
    scalabilityMode = "L1T3",
    extra = []
} = {}) {
    const t = 1000000 + seconds * 1000;

    return [
        { id: "MS1", type: "media-source", kind: "video", timestamp: t, trackIdentifier: trackId,
            width: 1280, height: 720, frames: captureFps * seconds, framesPerSecond: captureFps },
        { id: "OT1", type: "outbound-rtp", kind: "video", timestamp: t, ssrc: 111, mediaSourceId: "MS1",
            codecId: "C1", active: true, frameWidth: width, frameHeight: height,
            framesEncoded: fps * seconds, framesPerSecond: fps, bytesSent: kbps * 1000 / 8 * seconds,
            retransmittedBytesSent: 0, packetsSent: 100 * seconds, totalEncodeTime: fps * seconds * encodeMs / 1000,
            targetBitrate: 1000000, keyFramesEncoded: 2, qualityLimitationReason: limitation,
            qualityLimitationDurations: { none: seconds * (1 - bandwidthShare), cpu: 0, bandwidth: seconds * bandwidthShare, other: 0 },
            encoderImplementation: "libaom", powerEfficientEncoder: false, scalabilityMode,
            nackCount: seconds, pliCount: 0 },
        { id: "RI1", type: "remote-inbound-rtp", kind: "video", timestamp: t, localId: "OT1",
            packetsLost: lostPerSecond * seconds, fractionLost: 0.004, roundTripTime: 0.045 },
        { id: "C1", type: "codec", timestamp: t, mimeType: "video/AV1" },
        { id: "T1", type: "transport", timestamp: t, selectedCandidatePairId: "CP1" },
        { id: "CP1", type: "candidate-pair", timestamp: t, nominated: true, state: "succeeded",
            currentRoundTripTime: 0.05, availableOutgoingBitrate: 1450000,
            bytesSent: 140000 * seconds, bytesReceived: 20000 * seconds },
        ...extra
    ];
}

// What a student receives after `seconds`: the teacher's camera.
function receiveStats(seconds, { fps = 20, kbps = 950, height = 720, lostPerSecond = 0.1, trackId = "rx-teacher" } = {}) {
    const t = 2000000 + seconds * 1000;

    return [
        { id: "IT1", type: "inbound-rtp", kind: "video", timestamp: t, ssrc: 222, trackIdentifier: trackId,
            codecId: "C2", frameWidth: height * 16 / 9, frameHeight: height, framesDecoded: fps * seconds,
            framesPerSecond: fps, bytesReceived: kbps * 1000 / 8 * seconds, packetsReceived: 99.9 * seconds,
            packetsLost: lostPerSecond * seconds, framesDropped: 3, freezeCount: 1, jitter: 0.012,
            jitterBufferDelay: 0.06 * fps * seconds, jitterBufferEmittedCount: fps * seconds,
            decoderImplementation: "libdav1d" },
        { id: "IT9", type: "inbound-rtp", kind: "video", timestamp: t, ssrc: 999, trackIdentifier: "unknown",
            bytesReceived: 5000, framesDecoded: 10 },
        { id: "C2", type: "codec", timestamp: t, mimeType: "video/AV1" },
        { id: "CP2", type: "candidate-pair", timestamp: t, nominated: true, state: "succeeded",
            currentRoundTripTime: 0.04, bytesSent: 37500 * seconds, bytesReceived: 125000 * seconds }
    ];
}

const asMap = list => new Map(list.map(stat => [stat.id, stat]));

// A peer connection whose getStats() returns the next queued report (the
// last one repeats).
function fakePeerConnection() {
    const pc = {
        calls: 0,
        queue: [],
        failNext: false,
        getStats() {
            pc.calls += 1;

            if (pc.failNext) {
                pc.failNext = false;

                return Promise.reject(new Error("closed"));
            }

            const next = pc.queue.length > 1 ? pc.queue.shift() : pc.queue[0] || [];

            return Promise.resolve(asMap(next));
        }
    };

    return pc;
}

// The harness's conference plus a bridge peer connection and a data channel.
function equip(conference, pc) {
    const handlers = new Map();

    conference.jvbJingleSession = { peerconnection: { peerconnection: pc } };
    conference.endpointMessages = [];
    conference.handlers = handlers;
    conference.on = (event, fn) => {
        (handlers.get(event) || handlers.set(event, new Set()).get(event)).add(fn);
    };
    conference.off = (event, fn) => handlers.get(event)?.delete(fn);
    conference.sendEndpointMessage = (to, payload) => conference.endpointMessages.push({ to, payload: plain(payload) });
    conference.emitEndpoint = (fromId, payload) =>
        Array.from(handlers.get(ENDPOINT_EVENT) || []).forEach(fn => fn({ getId: () => fromId }, payload));

    return conference;
}

function addLocalCamera(h, trackId = "cam-track-1", settings = { width: 1280, height: 720, frameRate: 30 }) {
    const camera = { id: trackId, kind: "video", readyState: "live", getSettings: () => ({ ...settings }) };
    const entry = {
        local: true,
        mediaType: "video",
        videoType: "camera",
        muted: false,
        participantId: h.participants.local.id,
        jitsiTrack: { getTrack: () => camera }
    };

    h.state["features/base/tracks"].push(entry);

    return entry;
}

async function settle(h) {
    for (let i = 0; i < 4; i++) {
        await h.flush();
    }
}

async function tick(h, ms = 5000) {
    h.timers.advance(ms);
    await settle(h);
}

function statuses(h) {
    return h.posted.filter(message => message && message.type === "SL_VIDEO_TELEMETRY_STATUS").map(plain);
}

function lastStatus(h) {
    const list = statuses(h);

    return list[list.length - 1] || null;
}

async function teacherWithTelemetry({ enable = true, camera = true } = {}) {
    const h = createHarness();
    const pc = fakePeerConnection();

    equip(h.conference(), pc);

    if (camera) {
        addLocalCamera(h);
    }

    h.timers.advance(600);
    h.change();

    if (enable) {
        pc.queue = [sendStats(0), sendStats(5), sendStats(10), sendStats(15)];
        h.postFromParent({ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 1, enabled: true });
        await settle(h);
    }

    return { h, pc, conference: h.conference() };
}

// ---- Parsing ---------------------------------------------------------------

test("send: encoded FPS, capture FPS and kbps are deltas, not getSettings()", () => {
    const h = createHarness();
    const api = h.ctx.__slVideoTelemetryTest;
    const before = api.indexStats(asMap(sendStats(10)));
    const now = api.indexStats(asMap(sendStats(15)));
    // The camera CLAIMS 30 fps; only the deltas count.
    const sample = plain(api.sendSample(now, before, { trackId: "cam-track-1", settings: { width: 1280, height: 720, frameRate: 30 } }, null));

    assert.equal(sample.camera, true);
    // No spatial SVC (L1T3): the framesEncoded delta is the picture rate.
    assert.deepEqual(sample.encoded, {
        width: 1280, height: 720, fps: 21, fpsSource: "delta", browserFps: 21,
        layerFrameRate: 21, activeSpatialLayers: 1, encodeMsPerFrame: 18
    });
    assert.deepEqual(sample.capture, { width: 1280, height: 720, fps: 30 });
    assert.deepEqual(sample.configured, { width: 1280, height: 720, frameRate: 30, resizeMode: null });
    assert.equal(sample.kbps, 1000);
    assert.equal(sample.targetKbps, 1000);
    assert.equal(sample.limitation, "bandwidth");
    assert.deepEqual(sample.limitationShares, { none: 60, cpu: 0, bandwidth: 40, other: 0 });
    assert.equal(sample.codec, "AV1");
    assert.equal(sample.encoder, "libaom");
    assert.equal(sample.scalabilityMode, "L1T3");
    assert.equal(sample.lossPct, 0.2);
    assert.equal(sample.rttMs, 45);
    assert.equal(sample.streams[0].nacks, 5);
    assert.deepEqual(
        { rtt: sample.network.rttMs, available: sample.network.availableOutgoingKbps, send: sample.network.sendKbps },
        { rtt: 50, available: 1450, send: 1120 }
    );
});

test("send: a first sample has no rates (N/A), only what one sample can show", () => {
    const api = createHarness().ctx.__slVideoTelemetryTest;
    const sample = plain(api.sendSample(api.indexStats(asMap(sendStats(5))), new Map(), { trackId: "cam-track-1" }, null));

    assert.equal(sample.encoded.height, 720);
    assert.equal(sample.encoded.fps, null);
    assert.equal(sample.encoded.encodeMsPerFrame, null);
    assert.equal(sample.kbps, null);
    assert.equal(sample.limitationShares, null);
    assert.equal(sample.capture.fps, 30, "the browser's own capture fps is the only one there is");
    assert.equal(sample.limitation, "bandwidth");
    assert.equal(sample.configured.frameRate, null);
});

test("send: a counter that went back, or a too-short interval, is never a rate", () => {
    const api = createHarness().ctx.__slVideoTelemetryTest;
    const camera = { trackId: "cam-track-1" };
    const reset = api.sendSample(api.indexStats(asMap(sendStats(2))), api.indexStats(asMap(sendStats(10))), camera, null);

    assert.equal(reset.encoded.fps, null);
    assert.equal(reset.kbps, null);

    const now = sendStats(10);
    const soon = sendStats(10).map(stat => ({ ...stat, timestamp: stat.timestamp + 200, framesEncoded: (stat.framesEncoded || 0) + 4 }));
    const quick = api.sendSample(api.indexStats(asMap(soon)), api.indexStats(asMap(now)), camera, null);

    assert.equal(quick.encoded.fps, null);
});

test("send: simulcast picks the highest ACTIVE layer and sums all layers' bitrate", () => {
    const api = createHarness().ctx.__slVideoTelemetryTest;
    const layers = seconds => {
        const base = sendStats(seconds).filter(stat => stat.type !== "outbound-rtp" && stat.type !== "remote-inbound-rtp");
        const layer = (id, rid, height, fps, kbps, active) => ({
            id, type: "outbound-rtp", kind: "video", timestamp: 1000000 + seconds * 1000, rid, ssrc: id.length,
            mediaSourceId: "MS1", codecId: "C1", active, frameHeight: height, frameWidth: height * 16 / 9,
            framesEncoded: fps * seconds, bytesSent: kbps * 125 * seconds, qualityLimitationReason: "none"
        });

        return base.concat([
            layer("q", "q", 180, 30, 150, true),
            layer("h", "h", 360, 30, 450, true),
            layer("f", "f", 720, 0, 0, false)
        ]);
    };
    const sample = api.sendSample(api.indexStats(asMap(layers(10))), api.indexStats(asMap(layers(5))), { trackId: "cam-track-1" }, null);

    assert.equal(sample.encoded.height, 360, "the 720 layer is not active");
    assert.equal(sample.encoded.fps, 30);
    assert.equal(sample.kbps, 600);
    assert.equal(sample.streams.length, 3);
});

test("send: the teacher's screen share is never counted as the camera; camera off is said so", () => {
    const api = createHarness().ctx.__slVideoTelemetryTest;
    const share = seconds => [
        { id: "MS2", type: "media-source", kind: "video", timestamp: 1000000 + seconds * 1000, trackIdentifier: "desk-1", frames: 5 * seconds },
        { id: "OT2", type: "outbound-rtp", kind: "video", timestamp: 1000000 + seconds * 1000, mediaSourceId: "MS2",
            frameHeight: 1080, frameWidth: 1920, framesEncoded: 5 * seconds, bytesSent: 250000 * seconds, active: true }
    ];
    const sample = api.sendSample(
        api.indexStats(asMap(sendStats(10, { extra: share(10) }))),
        api.indexStats(asMap(sendStats(5, { extra: share(5) }))),
        { trackId: "cam-track-1" }, "desk-1");

    assert.equal(sample.encoded.height, 720);
    assert.equal(sample.kbps, 1000);

    const off = plain(api.sendSample(api.indexStats(asMap(sendStats(10))), new Map(), null, null));

    assert.equal(off.camera, false);
    assert.ok(off.network, "the connection itself is still reported");
});

test("send: a browser without the newer fields (no media-source, no limitation) gives nulls, never throws", () => {
    const api = createHarness().ctx.__slVideoTelemetryTest;
    const bare = seconds => [
        { id: "OT1", type: "outbound-rtp", mediaType: "video", timestamp: 1000000 + seconds * 1000,
            frameHeight: 480, framesEncoded: 24 * seconds, bytesSent: 62500 * seconds }
    ];
    const sample = plain(api.sendSample(api.indexStats(asMap(bare(10))), api.indexStats(asMap(bare(5))), { trackId: "x" }, null));

    assert.equal(sample.capture, null);
    assert.equal(sample.encoded.height, 480);
    assert.equal(sample.encoded.fps, 24);
    assert.equal(sample.kbps, 500);
    assert.equal(sample.limitation, null);
    assert.equal(sample.limitationShares, null);
    assert.equal(sample.codec, null);
    assert.equal(sample.encoder, null);
    assert.equal(sample.lossPct, null);
    assert.equal(sample.network, null);
    assert.equal(api.indexStats(null).size, 0);
});

test("receive: decoded FPS, kbps, loss and jitter buffer per source; unmapped sources left out", () => {
    const api = createHarness().ctx.__slVideoTelemetryTest;
    const owners = stat => stat.trackIdentifier === "rx-teacher"
        ? { participantId: "teach01", role: "moderator", videoType: "camera", requestedHeight: 720, streamingStatus: "active" }
        : null;
    const sample = plain(api.receiveSample(
        api.indexStats(asMap(receiveStats(10))), api.indexStats(asMap(receiveStats(5))), owners));

    assert.equal(sample.sources.length, 1);

    const source = sample.sources[0];

    assert.equal(source.participantId, "teach01");
    assert.equal(source.height, 720);
    assert.equal(source.fps, 20);
    assert.equal(source.kbps, 950);
    assert.equal(source.lossPct, 0.1);
    assert.equal(source.jitterBufferMs, 60);
    assert.equal(source.jitterMs, 12);
    assert.equal(source.codec, "AV1");
    assert.equal(source.decoder, "libdav1d");
    assert.equal(source.requestedHeight, 720);
    assert.equal(source.streamingStatus, "active");
    assert.equal(source.bytesReceived, 950 * 125 * 10);
    assert.equal(sample.network.receiveKbps, 1000);
    assert.equal(sample.network.sendKbps, 300);
    assert.equal(sample.network.bytesReceived, 1250000);
});

// ---- Teacher lifecycle -----------------------------------------------------

test("off by default: no getStats, no request, no status", async () => {
    const { h, pc, conference } = await teacherWithTelemetry({ enable: false });

    await tick(h, 30000);

    assert.equal(pc.calls, 0);
    assert.equal(conference.endpointMessages.length, 0);
    assert.equal(statuses(h).length, 0);
    assert.deepEqual(h.intervals("teacherTick"), []);
});

test("on: one 5 s poll, one getStats per poll, students asked at once and every 15 s", async () => {
    const { h, pc, conference } = await teacherWithTelemetry();

    assert.deepEqual(h.intervals("teacherTick"), [5000]);
    assert.equal(pc.calls, 1, "a baseline sample at once");
    assert.equal(conference.endpointMessages.length, 1);
    assert.deepEqual(conference.endpointMessages[0], { to: "", payload: REQUEST });

    await tick(h);

    const status = lastStatus(h);

    assert.equal(pc.calls, 2);
    assert.equal(status.active, true);
    assert.equal(status.intervalMs, 5000);
    assert.equal(status.send.encoded.fps, 21);
    assert.equal(status.send.kbps, 1000);
    assert.equal(status.send.capture.fps, 30);

    await tick(h);
    await tick(h);

    assert.equal(pc.calls, 4);
    assert.equal(conference.endpointMessages.length, 2, "a new request on the 3rd poll");

    // A poll while the previous getStats() is still pending is skipped,
    // never stacked.
    h.timers.advance(10000);
    await settle(h);

    assert.equal(pc.calls, 5);

    // The parent resends the same message after SL_RECEIVE_READY: still one poll.
    h.postFromParent({ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 1, enabled: true });
    await settle(h);

    assert.deepEqual(h.intervals("teacherTick"), [5000]);
});

test("off: the poll stops, the parent is told once, nothing more is measured", async () => {
    const { h, pc } = await teacherWithTelemetry();

    await tick(h);
    h.postFromParent({ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 2, enabled: false });
    await settle(h);

    const calls = pc.calls;
    const last = lastStatus(h);

    assert.equal(last.active, false);
    assert.equal(last.send, null);
    assert.deepEqual(h.intervals("teacherTick"), []);

    await tick(h, 20000);

    assert.equal(pc.calls, calls);

    // An older epoch cannot turn it back on.
    h.postFromParent({ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 1, enabled: true });
    await settle(h);

    assert.deepEqual(h.intervals("teacherTick"), []);
});

test("camera off / on and track replacement: reported as off, then rates restart from the new track", async () => {
    const { h, pc } = await teacherWithTelemetry({ camera: false });

    await tick(h);

    assert.equal(lastStatus(h).send.camera, false);

    addLocalCamera(h, "cam-track-2");
    pc.queue = [sendStats(20, { trackId: "cam-track-2" }).map(stat => ({ ...stat, id: stat.id + "b",
        mediaSourceId: stat.mediaSourceId && stat.mediaSourceId + "b", localId: stat.localId && stat.localId + "b",
        codecId: stat.codecId && stat.codecId + "b", selectedCandidatePairId: stat.selectedCandidatePairId && stat.selectedCandidatePairId + "b" })),
    sendStats(25, { trackId: "cam-track-2" }).map(stat => ({ ...stat, id: stat.id + "b",
        mediaSourceId: stat.mediaSourceId && stat.mediaSourceId + "b", localId: stat.localId && stat.localId + "b",
        codecId: stat.codecId && stat.codecId + "b", selectedCandidatePairId: stat.selectedCandidatePairId && stat.selectedCandidatePairId + "b" }))];
    await tick(h);

    assert.equal(lastStatus(h).send.camera, true);
    assert.equal(lastStatus(h).send.encoded.fps, null, "new stat objects: no rate on their first sample");

    await tick(h);

    assert.equal(lastStatus(h).send.encoded.fps, 21);
    assert.equal(lastStatus(h).send.codec, "AV1");
});

test("reconnect: a new conference gets a new request, old reports and deltas are dropped", async () => {
    const { h, pc, conference } = await teacherWithTelemetry();

    conference.emitEndpoint("stud001", { type: "sl-video-telemetry-report", v: 1, seq: 1, sources: [] });
    h.addParticipant("stud001");
    conference.emitEndpoint("stud001", { type: "sl-video-telemetry-report", v: 1, seq: 1, sources: [] });
    await tick(h);

    assert.equal(lastStatus(h).students.length, 1);

    const next = equip(h.newConference(), fakePeerConnection());

    next.jvbJingleSession.peerconnection.peerconnection.queue = [sendStats(100), sendStats(105)];
    h.setConference(next);
    h.change();
    await settle(h);

    assert.deepEqual(next.endpointMessages, [{ to: "", payload: REQUEST }]);
    assert.equal(conference.handlers.get(ENDPOINT_EVENT).size, 0, "the old conference is no longer followed");
    assert.equal(next.handlers.get(ENDPOINT_EVENT).size, 1);

    await tick(h);

    assert.equal(lastStatus(h).students.length, 0);
    assert.equal(lastStatus(h).send.encoded.fps, 21, "the new connection's baseline was taken at the change");
    assert.ok(pc.calls >= 2);
    assert.deepEqual(h.intervals("teacherTick"), [5000]);
});

test("getStats failing or no peer connection: an error, never invented numbers", async () => {
    const { h, pc, conference } = await teacherWithTelemetry();

    pc.failNext = true;
    await tick(h);

    assert.equal(lastStatus(h).error, "getstats-failed");
    assert.equal(lastStatus(h).send, null);

    delete conference.jvbJingleSession;
    await tick(h);

    assert.equal(lastStatus(h).error, "no-peer-connection");
    assert.equal(lastStatus(h).send, null);
});

test("a student (not a moderator) never polls as a teacher; pagehide stops everything", async () => {
    const h = createHarness();
    const pc = fakePeerConnection();

    equip(h.conference(), pc);
    h.participants.local = { id: "stud001", role: "participant", name: "S" };
    h.timers.advance(600);
    h.change();
    h.postFromParent({ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 1, enabled: true });
    await tick(h, 20000);

    assert.equal(pc.calls, 0);
    assert.deepEqual(h.intervals("teacherTick"), []);
    assert.equal(lastStatus(h).active, false);

    const teacher = await teacherWithTelemetry();

    teacher.h.ctx.dispatchEvent({ type: "pagehide" });

    assert.deepEqual(teacher.h.intervals("teacherTick"), []);
});

// ---- Students: on request only, and reports to the teacher ---------------

function remoteTrack(h, participantId, mediaTrackId, videoType = "camera") {
    h.state["features/base/tracks"].push({
        local: false,
        mediaType: "video",
        videoType,
        muted: false,
        participantId,
        jitsiTrack: {
            getTrack: () => ({ id: mediaTrackId }),
            getSSRC: () => 222,
            getSourceName: () => participantId + "-v0",
            getTrackStreamingStatus: () => "active"
        }
    });
}

async function student() {
    const h = createHarness();
    const pc = fakePeerConnection();
    const conference = equip(h.conference(), pc);

    h.participants.local = { id: "stud001", role: "participant", name: "S" };
    h.addParticipant("teach01", { role: "moderator" });
    h.addParticipant("stud002");
    // What the receive policy last asked the bridge for.
    conference.__slLastApplied = { constraints: { "teach01-v0": { maxHeight: 720 } }, defaultConstraints: { maxHeight: 0 } };
    h.state["features/base/tracks"] = [];
    remoteTrack(h, "teach01", "rx-teacher");
    pc.queue = [receiveStats(0), receiveStats(5), receiveStats(10)];
    h.timers.advance(600);
    h.change();
    await settle(h);

    return { h, pc, conference };
}

test("student: idle until a moderator asks; then reports to that moderator only, every 5 s", async () => {
    const { h, pc, conference } = await student();

    await tick(h, 20000);

    assert.equal(pc.calls, 0);

    // A student cannot start it.
    conference.emitEndpoint("stud002", REQUEST);
    await tick(h);

    assert.equal(pc.calls, 0);

    conference.emitEndpoint("teach01", REQUEST);
    await settle(h);

    assert.equal(pc.calls, 1, "baseline at once");
    assert.deepEqual(h.intervals("studentTick"), [5000]);

    await tick(h);

    const sent = conference.endpointMessages;

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "teach01");
    assert.equal(sent[0].payload.type, "sl-video-telemetry-report");

    const source = sent[0].payload.sources[0];

    assert.equal(source.participantId, "teach01");
    assert.equal(source.role, "moderator");
    assert.equal(source.fps, 20);
    assert.equal(source.kbps, 950);
    assert.equal(source.requestedHeight, 720);
    assert.equal(JSON.stringify(sent[0].payload).includes("\"name\""), false, "no names in a report");
});

test("student: stops by itself when no request comes for 40 s, or the requester leaves", async () => {
    const { h, pc, conference } = await student();

    conference.emitEndpoint("teach01", REQUEST);
    await settle(h);
    await tick(h, 40000);

    assert.deepEqual(h.intervals("studentTick"), []);

    const calls = pc.calls;

    await tick(h, 20000);

    assert.equal(pc.calls, calls);

    conference.emitEndpoint("teach01", REQUEST);
    await settle(h);
    h.removeParticipant("teach01");
    await tick(h);

    assert.deepEqual(h.intervals("studentTick"), []);
});

test("teacher: student reports are sanitised, shown per participant, aged and dropped", async () => {
    const { h, conference } = await teacherWithTelemetry();

    h.addParticipant("stud001");
    h.addParticipant("cot01", { role: "moderator" });
    conference.emitEndpoint("stud001", {
        type: "sl-video-telemetry-report", v: 1, seq: 7,
        sources: [{ participantId: "teacher01", role: "moderator", videoType: "camera", height: 720, fps: 20,
            kbps: 950, lossPct: 0.1, codec: "AV1<script>", bytesReceived: -5, name: "Alice" }],
        network: { rttMs: 40, bytesReceived: 112300000 }
    });
    // A moderator's "report" and a non-participant's are ignored.
    conference.emitEndpoint("cot01", { type: "sl-video-telemetry-report", v: 1, sources: [] });
    conference.emitEndpoint("ghost99", { type: "sl-video-telemetry-report", v: 1, sources: [] });
    await tick(h);

    const rows = lastStatus(h).students;

    assert.equal(rows.length, 1);
    assert.equal(rows[0].participantId, "stud001");
    assert.equal(rows[0].stale, false);
    assert.equal(rows[0].sources[0].fps, 20);
    assert.equal(rows[0].sources[0].codec, null, "unexpected text is dropped");
    assert.equal(rows[0].sources[0].bytesReceived, null, "out of range is dropped");
    assert.equal("name" in rows[0].sources[0], false);
    assert.equal(rows[0].network.bytesReceived, 112300000);

    await tick(h, 20000);

    assert.equal(lastStatus(h).students[0].stale, true);

    h.removeParticipant("stud001");
    await tick(h);

    assert.equal(lastStatus(h).students.length, 0, "a student who left is dropped");
});

// ---- Teacher page module (video-telemetry.mjs) -----------------------------

test("summary lines: measured values, and N/A for anything not measured", async () => {
    const t = await loadTelemetry();
    const send = {
        camera: true,
        encoded: { height: 720, fps: 21, encodeMsPerFrame: 18 },
        capture: { width: 1280, height: 720, fps: 30 },
        configured: { width: 1280, height: 720, frameRate: 30 },
        kbps: 1000,
        limitation: "bandwidth"
    };

    assert.equal(t.formatSendSummary(send), "Teacher sending (encoded): 720p · 21 FPS · 1,000 kbps · limitation: bandwidth");
    assert.equal(t.formatCaptureLine(send), "Camera capture (measured): 1280×720 · 30 FPS — configured 1280×720 @ 30 FPS");
    assert.equal(t.formatSendSummary({ camera: true }), "Teacher sending (encoded): N/A · N/A FPS · N/A kbps · limitation: N/A");
    assert.equal(t.formatSendSummary({ camera: false }), "Teacher sending: camera off");
    assert.equal(t.formatSendSummary(null), "Teacher sending: N/A");
    assert.match(t.formatSendDetails({ camera: true }), /codec N\/A · encoder N\/A/);

    const row = { participantId: "stud001", stale: false, sources: [
        { role: "participant", videoType: "desktop", height: 1080, fps: 5 },
        { role: "moderator", videoType: "camera", height: 720, fps: 20, kbps: 950, lossPct: 0.1, requestedHeight: 720 }
    ], network: { bytesReceived: 112300000 } };

    assert.equal(t.formatReceiveSummary("Student A", row),
        "Student A receiving teacher camera (decoded): 720p · 20 FPS · 950 kbps · loss 0.1%");
    assert.match(t.formatReceiveDetails(row), /asked 720p · forwarding N\/A/);
    assert.match(t.formatReceiveDetails(row), /received 112\.3 MB/);
    assert.equal(t.formatReceiveSummary("B", { sources: [], stale: true, ageSeconds: 20 }), "B receiving: no video (no report for 20 s)");
});

test("labels come only from the authenticated participant map", async () => {
    const t = await loadTelemetry();
    const students = [{ studentId: "s-1", displayName: "Amal Perera" }];

    assert.deepEqual(t.resolveStudentLabel("p-1", { "s-1": "p-1" }, students), { label: "Amal Perera", studentId: "s-1" });
    assert.deepEqual(t.resolveStudentLabel("p-9", { "s-1": "p-1" }, students), { label: "Unregistered participant p-9", studentId: null });
});

test("status validation, message builder and the bounded history", async () => {
    const t = await loadTelemetry();

    assert.deepEqual(t.buildVideoTelemetryMessage(3, true), { type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 3, enabled: true });
    assert.equal(t.parseVideoTelemetryStatus({ type: "SL_VIDEO_TELEMETRY_STATUS", v: 2, enabled: true, active: true, send: null, students: [] }), null);
    assert.equal(t.parseVideoTelemetryStatus({ type: "SL_VIDEO_TELEMETRY_STATUS", v: 1, enabled: true, active: true, send: 5, students: [] }), null);

    const parsed = t.parseVideoTelemetryStatus({
        type: "SL_VIDEO_TELEMETRY_STATUS", v: 1, enabled: true, active: true, intervalMs: 5000,
        send: null, students: [{ participantId: "p-1" }, { nope: true }, null]
    });

    assert.equal(parsed.students.length, 1);

    const history = t.createTelemetryHistory(3);

    for (let i = 0; i < 5; i++) {
        history.push({ n: i }, new Date(Date.UTC(2026, 9, 23, 0, 0, i)));
    }

    assert.equal(history.size, 3);
    assert.deepEqual(history.entries().map(entry => entry.status.n), [2, 3, 4]);

    const exported = JSON.parse(t.buildDiagnosticsExport(
        [{ at: "x", status: { active: true, students: [{ participantId: "p-1" }] } }],
        id => "Label " + id));

    assert.equal(exported.kind, "sl-classroom-video-diagnostics");
    assert.equal(exported.samples[0].students[0].label, "Label p-1");
});

// ---- Phase 1 follow-up: SVC frame rate, camera track, messaging -----------

// The real exports (Chrome, AV1 libaom L3T3_KEY): framesEncoded rose ~60/s
// at 720p, ~40/s at 360p, ~20/s at 180p while framesPerSecond stayed ~20.
function svcStats(seconds, { height = 720, layerRate = 60, pictureRate = 20 } = {}) {
    return sendStats(seconds, { scalabilityMode: "L3T3_KEY", height, width: height * 16 / 9 }).map(stat =>
        stat.type === "outbound-rtp"
            ? { ...stat, framesEncoded: layerRate * seconds, framesPerSecond: pictureRate }
            : stat);
}

const withoutBrowserFps = list =>
    list.map(stat => (stat.type === "outbound-rtp" ? { ...stat, framesPerSecond: undefined } : stat));

test("AV1 SVC: framesEncoded counts layer frames; the picture rate and the active layers are reported apart", () => {
    const api = createHarness().ctx.__slVideoTelemetryTest;
    const camera = { trackId: "cam-track-1" };
    const sample = (height, layerRate) => plain(api.sendSample(
        api.indexStats(asMap(svcStats(10, { height, layerRate }))),
        api.indexStats(asMap(svcStats(5, { height, layerRate }))), camera, null)).encoded;

    assert.deepEqual(
        [sample(720, 60), sample(360, 40), sample(180, 20)]
            .map(e => [e.height, e.fps, e.layerFrameRate, e.activeSpatialLayers, e.fpsSource]),
        [[720, 20, 60, 3, "browser"], [360, 20, 40, 2, "browser"], [180, 20, 20, 1, "browser"]]
    );

    // Without the browser's own value there is no honest picture rate.
    const noBrowser = plain(api.sendSample(
        api.indexStats(asMap(withoutBrowserFps(svcStats(10)))),
        api.indexStats(asMap(withoutBrowserFps(svcStats(5)))), camera, null)).encoded;

    assert.equal(noBrowser.fps, null);
    assert.equal(noBrowser.layerFrameRate, 60);
    assert.equal(noBrowser.activeSpatialLayers, null);
});

test("SVC targets: the encoder's target is the sum over all encodings, active or not", () => {
    const api = createHarness().ctx.__slVideoTelemetryTest;
    const withTargets = seconds => sendStats(seconds).concat([
        { id: "OT2", type: "outbound-rtp", kind: "video", timestamp: 1000000 + seconds * 1000, mediaSourceId: "MS1",
            active: false, targetBitrate: 643000, bytesSent: 0, framesEncoded: 0 },
        { id: "OT3", type: "outbound-rtp", kind: "video", timestamp: 1000000 + seconds * 1000, mediaSourceId: "MS1",
            active: false, targetBitrate: 276000, bytesSent: 0, framesEncoded: 0 }
    ]).map(stat => (stat.id === "OT1" ? { ...stat, targetBitrate: 77000 } : stat));
    const sample = plain(api.sendSample(api.indexStats(asMap(withTargets(10))), api.indexStats(asMap(withTargets(5))),
        { trackId: "cam-track-1" }, null));

    assert.equal(sample.targetKbps, 77);
    assert.equal(sample.targetKbpsTotal, 996);
    assert.equal(sample.encoded.height, 720, "inactive encodings are never the top layer");
});

test("camera track: produced vs delivered vs discarded tells the camera from Chrome's pipeline", () => {
    const api = createHarness().ctx.__slVideoTelemetryTest;
    const index = api.indexStats(asMap(sendStats(10)));
    const before = api.indexStats(asMap(sendStats(5)));
    const track = stats => plain(api.sendSample(index, before, {
        trackId: "cam-track-1",
        label: "Integrated Webcam",
        settings: { width: 1280, height: 720, frameRate: 30, resizeMode: "crop-and-scale" },
        capabilities: { frameRate: { min: 1, max: 30 }, height: { max: 1080 } },
        constraints: { height: { ideal: 720 }, frameRate: { max: 30 } },
        ...stats
    }, null).track);

    // The camera itself makes 20 a second.
    const camera = track({
        stats: { at: 10000, totalFrames: 200, deliveredFrames: 200, discardedFrames: 0 },
        statsBefore: { at: 5000, totalFrames: 100, deliveredFrames: 100, discardedFrames: 0 }
    });

    assert.deepEqual([camera.producedFps, camera.deliveredFps, camera.discardedFps], [20, 20, 0]);
    assert.equal(camera.capabilityMaxFps, 30);
    assert.equal(camera.capabilityMaxHeight, 1080);
    assert.equal(camera.frameRateConstraint, JSON.stringify({ max: 30 }));
    assert.equal(camera.label, "Integrated Webcam");

    // The camera makes 30, the track hands on 20 (decimation in Chrome).
    const pipeline = track({
        stats: { at: 10000, totalFrames: 300, deliveredFrames: 200, discardedFrames: 100 },
        statsBefore: { at: 5000, totalFrames: 150, deliveredFrames: 100, discardedFrames: 50 }
    });

    assert.deepEqual([pipeline.producedFps, pipeline.deliveredFps, pipeline.discardedFps], [30, 20, 10]);

    // A browser without MediaStreamTrack.stats: said so, never guessed.
    const none = track({ stats: null, statsBefore: null });

    assert.equal(none.statsSupported, false);
    assert.equal(none.producedFps, null);
});

test("camera track stats are read from the live track, from the second reading on", async () => {
    const { h, pc } = await teacherWithTelemetry({ camera: false });
    const camera = {
        id: "cam-track-1", kind: "video", readyState: "live", label: "Cam",
        stats: { totalFrames: 0, deliveredFrames: 0, discardedFrames: 0 },
        getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
        getCapabilities: () => ({ frameRate: { max: 30 } }),
        getConstraints: () => ({ frameRate: { max: 30 } })
    };

    h.state["features/base/tracks"].push({
        local: true, mediaType: "video", videoType: "camera", muted: false,
        participantId: "teacher01", jitsiTrack: { getTrack: () => camera }
    });
    pc.queue = [sendStats(20), sendStats(25), sendStats(30)];
    await tick(h);

    assert.equal(lastStatus(h).send.track.statsSupported, true);
    assert.equal(lastStatus(h).send.track.producedFps, null, "first reading: no rate yet");
    assert.equal(lastStatus(h).send.track.capabilityMaxFps, 30);
    assert.equal(lastStatus(h).send.track.frameRateConstraint, JSON.stringify({ max: 30 }));
});

// Two custom.js instances (teacher, student) joined by a mock bridge data
// channel: messages go to one endpoint ("to") or to everyone ("").
function linkThroughBridge(teacher, student, { studentAnswers = true } = {}) {
    const deliver = (target, fromId, payload) => target.emitEndpoint(fromId, plain(payload));

    teacher.conference().sendEndpointMessage = (to, payload) => {
        teacher.conference().endpointMessages.push({ to, payload: plain(payload) });

        if ((to === "" || to === "stud001") && studentAnswers) {
            deliver(student.conference(), "teacher01", payload);
        }
    };
    student.conference().sendEndpointMessage = (to, payload) => {
        student.conference().endpointMessages.push({ to, payload: plain(payload) });

        if (to === "teacher01") {
            deliver(teacher.conference(), "stud001", payload);
        }
    };
}

async function studentHarness() {
    const s = createHarness();
    const pc = fakePeerConnection();

    equip(s.conference(), pc);
    s.participants.local = { id: "stud001", role: "participant", name: "S" };
    s.addParticipant("teacher01", { role: "moderator" });
    s.state["features/base/tracks"] = [];
    remoteTrack(s, "teacher01", "rx-teacher");
    pc.queue = [receiveStats(0), receiveStats(5), receiveStats(10), receiveStats(15), receiveStats(20)];
    s.timers.advance(600);
    s.change();
    await settle(s);

    return s;
}

async function tickBoth(a, b, ms = 5000) {
    a.timers.advance(ms);
    b.timers.advance(ms);
    await settle(a);
    await settle(b);
}

test("end to end: the teacher's request reaches the student, the report comes back, mapped and versioned", async () => {
    const student = await studentHarness();
    const { h: teacher } = await teacherWithTelemetry({ enable: false });

    teacher.addParticipant("stud001");
    linkThroughBridge(teacher, student);
    teacher.postFromParent({ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 1, enabled: true });
    await settle(teacher);
    await settle(student);

    assert.equal(student.ctx.__slVideoTelemetryTest.state().messaging.requestsReceived, 1);

    await tickBoth(teacher, student);
    await tickBoth(teacher, student);

    const status = lastStatus(teacher);
    const row = status.students.find(entry => entry.participantId === "stud001");

    assert.ok(row, "the student's report arrived");
    assert.equal(row.customJsVersion, 1014);
    assert.equal(row.sources[0].participantId, "teacher01");
    assert.equal(row.sources[0].fps, 20);
    assert.deepEqual(status.silent, []);
    assert.equal(status.messaging.studentsPresent, 1);
    assert.ok(status.messaging.requestsSent >= 1);
    assert.ok(status.messaging.reportsAccepted >= 1);
    assert.ok(student.ctx.__slVideoTelemetryTest.state().messaging.reportsSent >= 1);
});

test("a student whose iframe does not answer (older custom.js) is listed as silent, not hidden", async () => {
    const student = await studentHarness();
    const { h: teacher } = await teacherWithTelemetry({ enable: false });

    teacher.addParticipant("stud001");
    linkThroughBridge(teacher, student, { studentAnswers: false });
    teacher.postFromParent({ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 1, enabled: true });
    await tickBoth(teacher, student);
    await tickBoth(teacher, student);

    const status = lastStatus(teacher);

    assert.deepEqual(status.students, []);
    assert.deepEqual(status.silent, ["stud001"]);
    assert.equal(status.messaging.studentsPresent, 1);
    assert.equal(status.messaging.reportsAccepted, 0);
});

test("a bridge channel that refuses to send is counted with its reason", async () => {
    const { h, conference } = await teacherWithTelemetry({ enable: false });

    conference.sendEndpointMessage = () => {
        throw new Error("Channel support is disabled");
    };
    h.postFromParent({ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 1, enabled: true });
    await tick(h);

    const messaging = lastStatus(h).messaging;

    assert.equal(messaging.requestsSent, 0);
    assert.equal(messaging.requestErrors, 1);
    assert.equal(messaging.lastSendError, "Channel support is disabled");
});

test("summary lines for the new fields", async () => {
    const t = await loadTelemetry();
    const send = {
        camera: true,
        codec: "AV1", encoder: "libaom", scalabilityMode: "L3T3_KEY", targetKbpsTotal: 996,
        encoded: { height: 720, fps: 20, fpsSource: "browser", layerFrameRate: 60, activeSpatialLayers: 3, encodeMsPerFrame: 12.5 },
        configured: { resizeMode: "crop-and-scale" },
        track: { statsSupported: true, producedFps: 20, deliveredFps: 20, discardedFps: 0, capabilityMaxFps: 30, frameRateConstraint: null, label: "Cam" }
    };

    assert.match(t.formatSendSummary(send), /720p · 20 FPS/);
    assert.match(t.formatSendDetails(send),
        /layers L3T3_KEY \(3 spatial active\) · layer frames 60\/s · encode 12\.5 ms\/layer frame · encoder target 996 kbps/);
    assert.equal(t.formatTrackLine(send),
        "Camera track: produced 20 FPS, delivered 20 FPS, discarded 0 FPS · camera max 30 FPS · frame-rate constraint N/A · resize crop-and-scale · device Cam");
    assert.match(t.formatMessagingLine({ students: [], messaging: {
        studentsPresent: 2, requestsSent: 4, requestErrors: 0, reportsAccepted: 0,
        reportsIgnoredNotInMeeting: 0, reportsIgnoredFromModerator: 0
    } }), /^Students in meeting 2, reporting 0 · requests sent 4/);
    assert.match(t.formatReceiveDetails({ customJsVersion: 1014, sources: [{ role: "moderator", videoType: "camera" }] }),
        /^custom\.js 1014/);
    assert.deepEqual(t.parseVideoTelemetryStatus({
        type: "SL_VIDEO_TELEMETRY_STATUS", v: 1, enabled: true, active: true, send: null, students: [], silent: ["p", 5]
    }).silent, ["p"]);
});

test("turned off (e.g. settings closed): no further student requests are sent; students then stop on their own", async () => {
    const { h, conference } = await teacherWithTelemetry();
    const requests = () => conference.endpointMessages.filter(message => message.payload.type === REQUEST.type).length;

    await tick(h, 15000);
    const before = requests();

    assert.ok(before >= 2, "asked at once and again every 15 s while on");

    h.postFromParent({ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: 2, enabled: false });
    await settle(h);
    await tick(h, 60000);

    assert.equal(requests(), before, "no request after off");
    assert.deepEqual(h.intervals("teacherTick"), []);
    // Students: with no request for 40 s they stop by themselves (see "student: stops by itself").
});
