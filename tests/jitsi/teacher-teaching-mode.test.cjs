/*
 * Regression tests: Teaching Mode, the teacher's own camera tuned for
 * handwriting (deploy/jitsi/custom.js): contentHint "detail" plus a
 * frameRate { max: 15 } cap merged into the camera's existing constraints,
 * restored when turned off, re-applied when Jitsi replaces the track.
 *
 *   npm run test:jitsi
 *
 * The camera here is a MOCK MediaStreamTrack (getConstraints / getSettings /
 * applyConstraints / contentHint) inside a mock local Jitsi track entry.
 * These tests check what custom.js asks of the track; they do not show what
 * a real browser's camera or encoder does with it, nor simulcast or the
 * bitrate that reaches the students. That needs a real browser and bridge.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

// What Jitsi's configOverwrite asks of the camera (useJitsi.ts), plus the
// device Jitsi opened.
const JITSI_CONSTRAINTS = {
    height: { ideal: 720, max: 1080, min: 240 },
    deviceId: { exact: "camera-1" }
};

// Plain objects of this realm (the vm context has its own Object.prototype).
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/*
 * A camera MediaStreamTrack model. applyConstraints replaces the whole
 * constraint set, as browsers do, and reports the capped frame rate.
 *   failWith: error name the next applyConstraints rejects with
 *   hold:     the next applyConstraints settles only on track.release()
 */
function fakeCamera({
    constraints = JITSI_CONSTRAINTS,
    settings = { width: 1280, height: 720, frameRate: 30 },
    contentHint = true,
    applyConstraints = true,
    getConstraints = true
} = {}) {
    const track = {
        kind: "video",
        readyState: "live",
        calls: [],
        failWith: null,
        hold: false,
        release: null,
        constraints: plain(constraints),
        settings: { ...settings },
        getSettings: () => ({ ...track.settings }),
        stop() {
            track.readyState = "ended";
        }
    };

    function accept(next) {
        track.constraints = next;

        const max = next.frameRate && next.frameRate.max;

        track.settings.frameRate = typeof max === "number" ? Math.min(max, 30) : 30;
    }

    if (getConstraints) {
        track.getConstraints = () => plain(track.constraints);
    }

    if (applyConstraints) {
        track.applyConstraints = requested => {
            const next = plain(requested);

            track.calls.push(next);

            if (track.failWith) {
                const name = track.failWith;

                track.failWith = null;

                return Promise.reject(Object.assign(new Error(name), { name }));
            }

            if (track.hold) {
                track.hold = false;

                return new Promise(resolve => {
                    track.release = () => {
                        accept(next);
                        resolve();
                    };
                });
            }

            accept(next);

            return Promise.resolve();
        };
    }

    if (contentHint) {
        track.contentHint = "";
    }

    return track;
}

// A local track entry as Jitsi's store holds it; jitsiTrack.getTrack()
// returns whatever camera is current (Jitsi may swap it inside the entry).
function addLocalCamera(h, camera, { videoType = "camera" } = {}) {
    const entry = {
        local: true,
        mediaType: "video",
        videoType,
        muted: false,
        isReceivingData: true,
        participantId: h.participants.local.id,
        jitsiTrack: {
            camera,
            getTrack: () => entry.jitsiTrack.camera,
            isMuted: () => entry.muted,
            getSourceName: () => h.participants.local.id + (videoType === "desktop" ? "-v1" : "-v0"),
            attach: () => Promise.resolve(),
            detach() {},
            on() {},
            off() {}
        }
    };

    h.state["features/base/tracks"].push(entry);

    return entry;
}

function removeEntry(h, entry) {
    h.state["features/base/tracks"] = h.state["features/base/tracks"].filter(track => track !== entry);
}

async function settle(h) {
    for (let i = 0; i < 4; i += 1) {
        await h.flush();
    }
}

async function changed(h) {
    h.change();
    await settle(h);
}

// Joined; custom.js has found the store. role: the local Jitsi role.
async function setup({ role = "moderator" } = {}) {
    const h = createHarness();

    h.participants.local.role = role;
    h.timers.advance(600);
    await changed(h);

    return h;
}

let nextEpoch = 0;

// extra: the optional maxFps / detailHint (absent: an older parent page).
async function sendMode(h, enabled, epoch = (nextEpoch += 1), extra = {}) {
    h.postFromParent({ type: "SL_TEACHING_MODE", v: 1, epoch, enabled, ...extra });
    await settle(h);
}

const sendProfile = (h, enabled, extra) => sendMode(h, enabled, (nextEpoch += 1), extra);

const statuses = h => h.posted.filter(message => message.type === "SL_TEACHING_MODE_STATUS").map(plain);
const lastStatus = h => statuses(h).at(-1) || null;
const pollIntervals = h => h.intervals("pollTeachingMode");

const OFF_STATUS = {
    type: "SL_TEACHING_MODE_STATUS",
    v: 1,
    enabled: false,
    active: false,
    camera: false,
    contentHint: null,
    frameRate: null,
    fps: null,
    // The requested settings (defaults: an older parent page's behaviour).
    maxFps: 15,
    detailHint: true
};

// ---- Default -----------------------------------------------------------------------

test("off by default: the camera is never touched and no status is posted", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    h.timers.advance(10000);
    await settle(h);

    assert.equal(camera.contentHint, "");
    assert.equal(camera.calls.length, 0);
    assert.deepEqual(statuses(h), []);
    assert.deepEqual(pollIntervals(h), []);
});

// ---- Enable / disable -----------------------------------------------------------------

test("enable: contentHint 'detail' and frameRate max 15 merged in; size and device kept", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.equal(camera.contentHint, "detail");
    assert.deepEqual(camera.calls, [{ ...JITSI_CONSTRAINTS, frameRate: { max: 15 } }]);
    assert.deepEqual(lastStatus(h), {
        type: "SL_TEACHING_MODE_STATUS",
        v: 1,
        enabled: true,
        active: true,
        camera: true,
        contentHint: "applied",
        frameRate: "applied",
        fps: 15,
        maxFps: 15,
        detailHint: true
    });
});

test("disable: the original hint and frame rate come back; size and device kept", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);
    await sendMode(h, false);

    assert.equal(camera.contentHint, "");
    assert.equal(camera.calls.length, 2);
    assert.deepEqual(camera.constraints, JITSI_CONSTRAINTS);
    assert.equal(camera.settings.frameRate, 30);
    assert.deepEqual(lastStatus(h), OFF_STATUS);
});

test("an existing frameRate constraint and contentHint are put back as they were", async () => {
    const h = await setup();
    const camera = fakeCamera({ constraints: { ...JITSI_CONSTRAINTS, frameRate: { ideal: 30 } } });

    camera.contentHint = "motion";
    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.equal(camera.contentHint, "detail");
    assert.deepEqual(camera.constraints.frameRate, { max: 15 });

    await sendMode(h, false);

    assert.equal(camera.contentHint, "motion");
    assert.deepEqual(camera.constraints, { ...JITSI_CONSTRAINTS, frameRate: { ideal: 30 } });
});

test("already capped at or below 15: the frame rate is left alone, the hint still applies", async () => {
    const h = await setup();
    const camera = fakeCamera({ constraints: { ...JITSI_CONSTRAINTS, frameRate: { max: 10 } } });

    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.equal(camera.contentHint, "detail");
    assert.equal(camera.calls.length, 0);
    assert.equal(lastStatus(h).frameRate, "kept");

    await sendMode(h, false);

    assert.equal(camera.contentHint, "");
    assert.equal(camera.calls.length, 0);
});

test("no size constraint at all: the current size is kept as the ideal", async () => {
    const h = await setup();
    const camera = fakeCamera({ constraints: { deviceId: { exact: "camera-1" } } });

    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.deepEqual(camera.calls, [{
        deviceId: { exact: "camera-1" },
        frameRate: { max: 15 },
        width: { ideal: 1280 },
        height: { ideal: 720 }
    }]);
});

test("restore leaves newer constraints from Jitsi alone (only the hint is put back)", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    // Jitsi re-applied its own constraints meanwhile: our cap is gone.
    camera.constraints = plain(JITSI_CONSTRAINTS);
    await sendMode(h, false);

    assert.equal(camera.calls.length, 1);
    assert.deepEqual(camera.constraints, JITSI_CONSTRAINTS);
    assert.equal(camera.contentHint, "");
});

// ---- Camera lifecycle ----------------------------------------------------------------

test("enabled before the camera exists (joins with camera off): applied when it starts", async () => {
    const h = await setup();

    await sendMode(h, true);

    assert.deepEqual(lastStatus(h), { ...OFF_STATUS, enabled: true, active: true });

    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);

    assert.equal(camera.contentHint, "detail");
    assert.equal(camera.calls.length, 1);
    assert.equal(lastStatus(h).camera, true);
    assert.equal(lastStatus(h).frameRate, "applied");
});

test("camera off / on: a new track inside the same Jitsi track, no store change, is re-applied by the poll", async () => {
    const h = await setup();
    const first = fakeCamera();
    const entry = addLocalCamera(h, first);

    await changed(h);
    await sendMode(h, true);

    // Jitsi stops the camera on mute and opens a new one on unmute.
    first.stop();

    const second = fakeCamera();

    entry.jitsiTrack.camera = second;
    h.timers.advance(2000);
    await settle(h);

    assert.equal(second.contentHint, "detail");
    assert.deepEqual(second.calls, [{ ...JITSI_CONSTRAINTS, frameRate: { max: 15 } }]);
    // Nothing is restored on a stopped track.
    assert.equal(first.calls.length, 1);

    await sendMode(h, false);

    assert.equal(second.contentHint, "");
    assert.deepEqual(second.constraints, JITSI_CONSTRAINTS);
    assert.equal(first.calls.length, 1);
});

test("camera muted with the track gone from the store, then back: applied again", async () => {
    const h = await setup();
    const first = fakeCamera();
    const entry = addLocalCamera(h, first);

    await changed(h);
    await sendMode(h, true);

    removeEntry(h, entry);
    first.stop();
    await changed(h);

    assert.equal(lastStatus(h).camera, false);

    const second = fakeCamera();

    addLocalCamera(h, second);
    await changed(h);

    assert.equal(second.contentHint, "detail");
    assert.equal(second.calls.length, 1);
    assert.equal(lastStatus(h).frameRate, "applied");
});

test("camera switch: the new device's track is changed; the old stopped one never again", async () => {
    const h = await setup();
    const first = fakeCamera();
    const entry = addLocalCamera(h, first);

    await changed(h);
    await sendMode(h, true);

    removeEntry(h, entry);
    first.stop();

    const second = fakeCamera({ constraints: { height: { ideal: 720, max: 1080, min: 240 }, deviceId: { exact: "camera-2" } } });

    addLocalCamera(h, second);
    await changed(h);

    assert.deepEqual(second.calls, [{
        height: { ideal: 720, max: 1080, min: 240 },
        deviceId: { exact: "camera-2" },
        frameRate: { max: 15 }
    }]);

    await sendMode(h, false);

    assert.equal(first.calls.length, 1);
    assert.equal(second.calls.length, 2);
    assert.deepEqual(second.constraints.deviceId, { exact: "camera-2" });
});

test("track replaced while the old one is still live: the old one is restored, the new one changed", async () => {
    const h = await setup();
    const first = fakeCamera();
    const entry = addLocalCamera(h, first);

    await changed(h);
    await sendMode(h, true);

    const second = fakeCamera();

    entry.jitsiTrack.camera = second;
    await changed(h);

    assert.equal(first.contentHint, "");
    assert.deepEqual(first.constraints, JITSI_CONSTRAINTS);
    assert.equal(second.contentHint, "detail");
    assert.equal(second.calls.length, 1);
});

test("the poll runs only while the mode is on, and stops at page teardown", async () => {
    const h = await setup();

    assert.deepEqual(pollIntervals(h), []);

    await sendMode(h, true);
    assert.deepEqual(pollIntervals(h), [2000]);

    await sendMode(h, false);
    assert.deepEqual(pollIntervals(h), []);

    await sendMode(h, true);
    h.ctx.dispatchEvent({ type: "pagehide" });
    assert.deepEqual(pollIntervals(h), []);
});

// ---- Unsupported / errors ------------------------------------------------------------

test("frame rate refused (OverconstrainedError): reported unsupported, hint kept, nothing thrown", async () => {
    const h = await setup();
    const camera = fakeCamera();

    camera.failWith = "OverconstrainedError";
    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.equal(camera.contentHint, "detail");
    assert.equal(lastStatus(h).frameRate, "unsupported");
    assert.equal(lastStatus(h).contentHint, "applied");
    assert.ok(h.warnings.some(args => String(args[0]).includes("frame-rate cap not applied")));
    assert.deepEqual(camera.constraints, JITSI_CONSTRAINTS);

    // Off: only the hint is put back (no constraint was changed).
    await sendMode(h, false);

    assert.equal(camera.contentHint, "");
    assert.equal(camera.calls.length, 1);
});

test("an unexpected applyConstraints error is reported as failed", async () => {
    const h = await setup();
    const camera = fakeCamera();

    camera.failWith = "AbortError";
    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.equal(lastStatus(h).frameRate, "failed");
    assert.equal(camera.contentHint, "detail");
});

test("browser without contentHint: frame-rate cap only, no property added", async () => {
    const h = await setup();
    const camera = fakeCamera({ contentHint: false });

    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.equal("contentHint" in camera, false);
    assert.equal(lastStatus(h).contentHint, "unsupported");
    assert.equal(lastStatus(h).frameRate, "applied");
});

test("constraints that cannot be read: no frame-rate change (it could drop the size or device)", async () => {
    const h = await setup();
    const camera = fakeCamera({ getConstraints: false });

    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.equal(camera.calls.length, 0);
    assert.equal(lastStatus(h).frameRate, "unsupported");
    assert.equal(camera.contentHint, "detail");
});

test("applyConstraints that never settles: failed after the timeout; a late success is undone once off", async () => {
    const h = await setup();
    const camera = fakeCamera();

    camera.hold = true;
    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.equal(lastStatus(h).frameRate, "pending");

    h.timers.advance(5000);
    await settle(h);

    assert.equal(lastStatus(h).frameRate, "failed");

    // Later changes are not held up behind it.
    await sendMode(h, false);

    assert.equal(camera.contentHint, "");

    // The browser applies the cap late after all: it is undone.
    camera.release();
    await settle(h);

    assert.equal(camera.calls.length, 2);
    assert.deepEqual(camera.constraints, JITSI_CONSTRAINTS);
    assert.equal(camera.settings.frameRate, 30);
});

// ---- Who / which tracks ------------------------------------------------------------------

test("a student (not a moderator) ignores it; a moderator role arriving later applies it", async () => {
    const h = await setup({ role: "participant" });
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true);

    assert.equal(camera.contentHint, "");
    assert.equal(camera.calls.length, 0);
    assert.deepEqual(lastStatus(h), { ...OFF_STATUS, enabled: true });
    assert.deepEqual(pollIntervals(h), []);

    h.participants.local.role = "moderator";
    await changed(h);

    assert.equal(camera.contentHint, "detail");
    assert.equal(camera.calls.length, 1);

    // Role lost again: restored.
    h.participants.local.role = "participant";
    await changed(h);

    assert.equal(camera.contentHint, "");
    assert.deepEqual(camera.constraints, JITSI_CONSTRAINTS);
});

test("older epochs are ignored; the same message again changes nothing but re-reports", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    await sendMode(h, true, 50);

    const reported = statuses(h).length;

    await sendMode(h, true, 50);

    assert.equal(camera.calls.length, 1);
    assert.equal(statuses(h).length, reported + 1);

    await sendMode(h, false, 49);

    assert.equal(camera.contentHint, "detail");
    assert.equal(lastStatus(h).enabled, true);
});

test("malformed messages are ignored", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);

    h.postFromParent({ type: "SL_TEACHING_MODE", v: 2, epoch: 1, enabled: true });
    h.postFromParent({ type: "SL_TEACHING_MODE", v: 1, epoch: "1", enabled: true });
    h.postFromParent({ type: "SL_TEACHING_MODE", v: 1, epoch: 1, enabled: "yes" });
    await settle(h);

    assert.equal(camera.contentHint, "");
    assert.equal(camera.calls.length, 0);
    assert.deepEqual(statuses(h), []);
});

test("screen shares and remote cameras are never touched", async () => {
    const h = await setup();
    const share = fakeCamera();
    const remote = fakeCamera();

    addLocalCamera(h, share, { videoType: "desktop" });
    h.addParticipant("stud0001");
    h.trackOf("stud0001").jitsiTrack.getTrack = () => remote;
    await changed(h);
    await sendMode(h, true);

    assert.equal(share.contentHint, "");
    assert.equal(share.calls.length, 0);
    assert.equal(remote.contentHint, "");
    assert.equal(remote.calls.length, 0);
    assert.equal(lastStatus(h).camera, false);
});

// ---- Selectable frame rate (maxFps) and optional detail hint ---------------------------

for (const maxFps of [15, 24, 30]) {
    test(`maxFps ${maxFps}: that cap merged in, reported, and the original restored when off`, async () => {
        const h = await setup();
        const camera = fakeCamera();

        addLocalCamera(h, camera);
        await changed(h);
        await sendProfile(h, true, { maxFps });

        assert.deepEqual(camera.calls, [{ ...JITSI_CONSTRAINTS, frameRate: { max: maxFps } }]);
        assert.equal(camera.contentHint, "detail");
        assert.equal(lastStatus(h).maxFps, maxFps);
        assert.equal(lastStatus(h).fps, maxFps);
        assert.equal(lastStatus(h).frameRate, "applied");

        await sendProfile(h, false, { maxFps });

        assert.deepEqual(camera.constraints, JITSI_CONSTRAINTS);
        assert.equal(camera.contentHint, "");
    });
}

test("changing maxFps while on restores the original first, then applies the new cap (never stacked)", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    await sendProfile(h, true, { maxFps: 15 });
    await sendProfile(h, true, { maxFps: 30 });

    assert.deepEqual(camera.calls, [
        { ...JITSI_CONSTRAINTS, frameRate: { max: 15 } },
        JITSI_CONSTRAINTS,
        { ...JITSI_CONSTRAINTS, frameRate: { max: 30 } }
    ]);
    assert.equal(lastStatus(h).maxFps, 30);
    assert.equal(lastStatus(h).fps, 30);

    await sendProfile(h, false, { maxFps: 30 });

    assert.deepEqual(camera.constraints, JITSI_CONSTRAINTS);
    assert.equal(camera.contentHint, "");
});

test("an original frameRate constraint survives cap changes and comes back when off", async () => {
    const h = await setup();
    const camera = fakeCamera({ constraints: { ...JITSI_CONSTRAINTS, frameRate: { ideal: 30 } } });

    addLocalCamera(h, camera);
    await changed(h);
    await sendProfile(h, true, { maxFps: 15 });
    await sendProfile(h, true, { maxFps: 24 });

    assert.deepEqual(camera.constraints.frameRate, { max: 24 });
    assert.deepEqual(camera.calls[1].frameRate, { ideal: 30 }, "original put back before the new cap");

    await sendProfile(h, false, { maxFps: 24 });

    assert.deepEqual(camera.constraints, { ...JITSI_CONSTRAINTS, frameRate: { ideal: 30 } });
});

test("a cap is never raised: an existing max 24 is kept for 30, replaced for 15, restored when off", async () => {
    const h = await setup();
    const camera = fakeCamera({ constraints: { ...JITSI_CONSTRAINTS, frameRate: { max: 24 } } });

    addLocalCamera(h, camera);
    await changed(h);
    await sendProfile(h, true, { maxFps: 30 });

    assert.equal(camera.calls.length, 0);
    assert.equal(lastStatus(h).frameRate, "kept");

    await sendProfile(h, true, { maxFps: 15 });

    assert.deepEqual(camera.constraints.frameRate, { max: 15 });

    await sendProfile(h, false, { maxFps: 15 });

    assert.deepEqual(camera.constraints, { ...JITSI_CONSTRAINTS, frameRate: { max: 24 } });
});

test("detailHint false: the hint is left alone (reported 'disabled'), the frame-rate cap still applies", async () => {
    const h = await setup();
    const camera = fakeCamera();

    camera.contentHint = "motion";
    addLocalCamera(h, camera);
    await changed(h);
    await sendProfile(h, true, { maxFps: 24, detailHint: false });

    assert.equal(camera.contentHint, "motion");
    assert.deepEqual(camera.constraints.frameRate, { max: 24 });
    assert.equal(lastStatus(h).contentHint, "disabled");
    assert.equal(lastStatus(h).detailHint, false);

    // Switching the hint on while on: applied, the cap re-applied once.
    await sendProfile(h, true, { maxFps: 24, detailHint: true });

    assert.equal(camera.contentHint, "detail");
    assert.deepEqual(camera.constraints.frameRate, { max: 24 });

    await sendProfile(h, false, { maxFps: 24, detailHint: true });

    assert.equal(camera.contentHint, "motion");
    assert.deepEqual(camera.constraints, JITSI_CONSTRAINTS);
});

test("invalid maxFps / detailHint values make the message malformed: ignored, current mode kept", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    await sendProfile(h, true, { maxFps: 24 });

    const callsBefore = camera.calls.length;

    for (const extra of [{ maxFps: 20 }, { maxFps: "30" }, { maxFps: 0 }, { maxFps: null }, { maxFps: 60 }, { detailHint: "yes" }, { detailHint: 1 }]) {
        await sendProfile(h, false, extra);
    }

    assert.equal(camera.calls.length, callsBefore, "nothing changed on the track");
    assert.deepEqual(camera.constraints.frameRate, { max: 24 });
    assert.equal(lastStatus(h).enabled, true);
    assert.ok(h.warnings.filter(args => String(args[0]).includes("malformed teaching mode")).length >= 7);
});

test("an older parent page's message (no maxFps / detailHint) means 15 fps with the detail hint", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    await sendProfile(h, true, { maxFps: 30, detailHint: false });
    await sendMode(h, true);

    assert.deepEqual(camera.constraints.frameRate, { max: 15 });
    assert.equal(camera.contentHint, "detail");
    assert.equal(lastStatus(h).maxFps, 15);
    assert.equal(lastStatus(h).detailHint, true);
});

test("track replacement at 24 fps: the new track gets 24; the old stopped one is never touched again", async () => {
    const h = await setup();
    const first = fakeCamera();
    const entry = addLocalCamera(h, first);

    await changed(h);
    await sendProfile(h, true, { maxFps: 24 });

    first.stop();

    const second = fakeCamera();

    entry.jitsiTrack.camera = second;
    h.timers.advance(2000);
    await settle(h);

    assert.deepEqual(second.calls, [{ ...JITSI_CONSTRAINTS, frameRate: { max: 24 } }]);
    assert.equal(first.calls.length, 1);
});

test("a settings change while off changes nothing on the camera; it applies when turned on", async () => {
    const h = await setup();
    const camera = fakeCamera();

    addLocalCamera(h, camera);
    await changed(h);
    await sendProfile(h, false, { maxFps: 30 });

    assert.equal(camera.calls.length, 0);
    assert.equal(lastStatus(h).maxFps, 30);

    await sendProfile(h, true, { maxFps: 30 });

    assert.deepEqual(camera.calls, [{ ...JITSI_CONSTRAINTS, frameRate: { max: 30 } }]);
});
