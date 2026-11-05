/*
 * Regression tests: the teacher's screen-sharing frame rate (deploy/jitsi/custom.js,
 * "Screen-Share Frame Rate"): SL_SCREENSHARE_FPS is applied with Jitsi build
 * 9442's own SET_SCREENSHARE_CAPTURE_FRAME_RATE action, only while no screen
 * share is running (a change during a share waits for the next one), never
 * twice for the same value, never on the webcam, never for a student.
 *
 *   npm run test:jitsi
 *
 * Jitsi's screen-share reducer and middleware are MOCKED here the way the
 * deployed 9442 bundle behaves (the action stores captureFrameRate in
 * "features/screen-share" and calls conference.setDesktopSharingFrameRate).
 * What a real browser then captures needs a real screen share.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createHarness } = require("./harness.cjs");

const ACTION = "SET_SCREENSHARE_CAPTURE_FRAME_RATE";
const plain = value => JSON.parse(JSON.stringify(value));

// A MediaStreamTrack that fails the test if anything constrains it.
function spyTrack(kind, fps) {
    const track = {
        kind: "video",
        id: kind + "-track",
        readyState: "live",
        applied: [],
        getSettings: () => ({ frameRate: fps }),
        getConstraints: () => ({}),
        applyConstraints(constraints) {
            track.applied.push(constraints);

            return Promise.resolve();
        }
    };

    return track;
}

function localTrack(h, videoType, mediaTrack, { muted = false } = {}) {
    return {
        local: true,
        mediaType: "video",
        videoType,
        muted,
        isReceivingData: true,
        participantId: h.participants.local.id,
        jitsiTrack: {
            getTrack: () => mediaTrack,
            isMuted: () => muted,
            getSourceName: () => h.participants.local.id + (videoType === "desktop" ? "-v1" : "-v0"),
            attach: () => Promise.resolve(),
            detach() {},
            on() {},
            off() {}
        }
    };
}

async function settle(h) {
    for (let i = 0; i < 4; i += 1) {
        await h.flush();
    }
}

// Joined, custom.js attached to the store; Jitsi's screen-share reducer +
// middleware mocked on the store (role: the local Jitsi role).
async function setup({ role = "moderator" } = {}) {
    const h = createHarness();
    const dispatched = [];
    const conferenceCalls = [];
    const original = h.store.dispatch;

    h.participants.local.role = role;
    h.state["features/screen-share"] = {};
    h.conference().setDesktopSharingFrameRate = fps => conferenceCalls.push(fps);
    h.store.dispatch = action => {
        if (action.type === ACTION) {
            dispatched.push(plain(action));
            h.state["features/screen-share"] = { ...h.state["features/screen-share"], captureFrameRate: action.captureFrameRate };
            h.conference()?.setDesktopSharingFrameRate?.(action.captureFrameRate);
        }

        return original(action);
    };

    const camera = spyTrack("camera", 30);

    h.state["features/base/tracks"].push(localTrack(h, "camera", camera));
    h.timers.advance(600);
    h.change();
    await settle(h);

    return { h, dispatched, conferenceCalls, camera };
}

let nextEpoch = 0;

async function sendFps(h, fps, epoch = (nextEpoch += 1), extra = {}) {
    h.postFromParent({ type: "SL_SCREENSHARE_FPS", v: 1, epoch, fps, ...extra });
    await settle(h);

    return epoch;
}

async function startShare(h, fps) {
    const screen = spyTrack("screen", fps);

    h.state["features/base/tracks"].push(localTrack(h, "desktop", screen));
    h.change();
    await settle(h);

    return screen;
}

async function stopShare(h) {
    h.state["features/base/tracks"] = h.state["features/base/tracks"].filter(track => track.videoType !== "desktop");
    h.change();
    await settle(h);
}

const statuses = h => h.posted.filter(message => message.type === "SL_SCREENSHARE_FPS_STATUS").map(plain);
const lastStatus = h => statuses(h).at(-1) || null;

/* ------------------------------- before / defaults ------------------------------- */

test("nothing happens before the page sends a frame rate: no dispatch, no status", async () => {
    const { h, dispatched } = await setup();

    h.change();
    h.timers.advance(60000);
    await settle(h);

    assert.deepEqual(dispatched, []);
    assert.deepEqual(statuses(h), []);
});

test("the page's frame rate (here 5) is set through Jitsi's own action and reaches the conference", async () => {
    const { h, dispatched, conferenceCalls } = await setup();

    await sendFps(h, 5);

    assert.deepEqual(dispatched, [{ type: ACTION, captureFrameRate: 5 }]);
    assert.deepEqual(conferenceCalls, [5]);
    assert.equal(h.state["features/screen-share"].captureFrameRate, 5);
    assert.deepEqual(lastStatus(h), {
        type: "SL_SCREENSHARE_FPS_STATUS", v: 1, fps: 5, applied: 5, sharing: false, pending: false, shareFps: null, trackFps: null
    });
});

/* ----------------------------- no repeated work ----------------------------- */

test("never dispatched twice for the same value: store changes, resends and time do nothing", async () => {
    const { h, dispatched } = await setup();
    const epoch = await sendFps(h, 15);
    const posted = statuses(h).length;

    for (let i = 0; i < 20; i += 1) {
        h.change();
    }

    h.timers.advance(120000);
    await settle(h);

    assert.equal(dispatched.length, 1);
    assert.equal(statuses(h).length, posted, "no status without a change");

    // The page's resend after SL_RECEIVE_READY (same epoch): one status, no dispatch.
    await sendFps(h, 15, epoch);
    assert.equal(dispatched.length, 1);
    assert.equal(statuses(h).length, posted + 1);
});

test("no polling: the section's only timer is the store wait, and it is cleared", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "jitsi", "custom.js"), "utf8");
    const start = source.indexOf("SL Classroom - Screen-Share Frame Rate");
    const section = source.slice(start, source.indexOf("SL Classroom - Video Quality Telemetry", start));

    assert.equal(section.match(/setInterval\(/g)?.length, 1);
    assert.match(section, /clearInterval\(waitForStore\)/);
    assert.doesNotMatch(section, /setTimeout\(|applyConstraints|getUserMedia|getDisplayMedia\(|new MediaStream|captureStream/);
});

/* ----------------------------- epochs / validation ----------------------------- */

test("an older epoch never overwrites a newer one; malformed or foreign messages are ignored", async () => {
    const { h, dispatched } = await setup();

    await sendFps(h, 30, 100);
    await sendFps(h, 5, 99);
    await sendFps(h, 24, 101);
    await sendFps(h, 15, 102, { v: 2 });
    h.postFromParent({ type: "SL_SCREENSHARE_FPS", v: 1, epoch: 103, fps: 15 }, { origin: "https://evil.example" });
    h.postFromParent({ type: "SL_SCREENSHARE_FPS", v: 1, epoch: 104, fps: 15 }, { source: {} });
    await settle(h);

    assert.deepEqual(dispatched, [{ type: ACTION, captureFrameRate: 30 }]);
    assert.equal(h.state["features/screen-share"].captureFrameRate, 30);
});

/* -------------------------------- permissions -------------------------------- */

test("a student (not a moderator) never changes Jitsi's screen-share frame rate, nor gets a status", async () => {
    const { h, dispatched } = await setup({ role: "participant" });

    await sendFps(h, 30);
    h.change();
    await settle(h);

    assert.deepEqual(dispatched, []);
    assert.equal(h.state["features/screen-share"].captureFrameRate, undefined);
    assert.deepEqual(statuses(h), []);
});

test("a teacher whose moderator role arrives later gets it applied then", async () => {
    const { h, dispatched } = await setup({ role: "participant" });

    await sendFps(h, 15);
    assert.deepEqual(dispatched, []);

    h.participants.local.role = "moderator";
    h.change();
    await settle(h);

    assert.deepEqual(dispatched, [{ type: ACTION, captureFrameRate: 15 }]);
});

/* ------------------------- active share / next share ------------------------- */

test("a change while sharing waits for the next share: the live share is never touched", async () => {
    const { h, dispatched } = await setup();

    await sendFps(h, 5);
    const screen = await startShare(h, 5);

    assert.deepEqual(lastStatus(h), {
        type: "SL_SCREENSHARE_FPS_STATUS", v: 1, fps: 5, applied: 5, sharing: true, pending: false, shareFps: 5, trackFps: 5
    });

    await sendFps(h, 30);

    assert.equal(dispatched.length, 1, "held while sharing");
    assert.equal(h.state["features/screen-share"].captureFrameRate, 5);
    assert.deepEqual(screen.applied, [], "the live share is never re-constrained");
    assert.deepEqual(lastStatus(h), {
        type: "SL_SCREENSHARE_FPS_STATUS", v: 1, fps: 30, applied: 5, sharing: true, pending: true, shareFps: 5, trackFps: 5
    });

    // Store changes during the share still change nothing.
    h.change();
    h.change();
    await settle(h);
    assert.equal(dispatched.length, 1);

    // The share ends: applied once, for the next share.
    await stopShare(h);
    assert.deepEqual(dispatched.at(-1), { type: ACTION, captureFrameRate: 30 });
    assert.equal(dispatched.length, 2);
    assert.deepEqual(lastStatus(h), {
        type: "SL_SCREENSHARE_FPS_STATUS", v: 1, fps: 30, applied: 30, sharing: false, pending: false, shareFps: null, trackFps: null
    });

    // The next share is captured with the new rate.
    await startShare(h, 30);
    assert.deepEqual(lastStatus(h), {
        type: "SL_SCREENSHARE_FPS_STATUS", v: 1, fps: 30, applied: 30, sharing: true, pending: false, shareFps: 30, trackFps: 30
    });
    assert.equal(dispatched.length, 2);
});

test("a muted (stopped) screen track counts as not sharing", async () => {
    const { h, dispatched } = await setup();

    await sendFps(h, 5);
    h.state["features/base/tracks"].push(localTrack(h, "desktop", spyTrack("screen", 5), { muted: true }));
    h.change();
    await settle(h);
    await sendFps(h, 15);

    assert.deepEqual(dispatched.at(-1), { type: ACTION, captureFrameRate: 15 });
    assert.equal(lastStatus(h).sharing, false);
});

test("changing the value back during a share leaves nothing pending and nothing to dispatch", async () => {
    const { h, dispatched } = await setup();

    await sendFps(h, 15);
    await startShare(h, 15);
    await sendFps(h, 30);
    await sendFps(h, 15);

    assert.equal(lastStatus(h).pending, false);
    await stopShare(h);
    assert.equal(dispatched.length, 1);
});

/* ------------------------------ reconnect / reload ------------------------------ */

test("reconnect: Jitsi keeps the stored rate (its own middleware re-applies it), so nothing is re-dispatched", async () => {
    const { h, dispatched } = await setup();

    await sendFps(h, 15);
    h.setConference(h.newConference());
    h.change();
    await settle(h);

    assert.equal(dispatched.length, 1);
    assert.equal(h.state["features/screen-share"].captureFrameRate, 15);
});

test("a reloaded iframe (fresh Jitsi store) gets the page's resend and applies it once", async () => {
    const first = await setup();
    const epoch = await sendFps(first.h, 30);

    const second = await setup();

    await sendFps(second.h, 30, epoch);
    assert.deepEqual(second.dispatched, [{ type: ACTION, captureFrameRate: 30 }]);
});

/* ------------------------------- track isolation ------------------------------- */

test("the webcam is never constrained by the screen-share frame rate; Teaching Mode still owns it", async () => {
    const { h, dispatched, camera } = await setup();

    await sendFps(h, 30);
    await startShare(h, 30);
    await sendFps(h, 5);
    await stopShare(h);

    assert.deepEqual(camera.applied, [], "no constraint on the camera");
    assert.ok(dispatched.every(action => action.type === ACTION));

    // Teaching Mode's camera cap is applied independently of the screen rate.
    h.postFromParent({ type: "SL_TEACHING_MODE", v: 1, epoch: 1, enabled: true, maxFps: 24, detailHint: false });
    await settle(h);

    assert.equal(camera.applied.length, 1);
    assert.deepEqual(plain(camera.applied[0].frameRate), { max: 24 });
    assert.equal(h.state["features/screen-share"].captureFrameRate, 5);
});
