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
    assert.equal(quality.setDesired(1080), false);
    quality.conferenceJoined();
    quality.conferenceJoined();

    assert.deepEqual(sender.sent, [480, 1080, 1080], "each join sends it once");
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

    for (const bad of [0, 360, 2160, "720", null, undefined, NaN, 720.5]) {
        assert.equal(quality.setDesired(bad), false, String(bad));
    }

    quality.conferenceJoined();
    assert.deepEqual(sender.sent, [720]);
});

// ---- Stored preferences -----------------------------------------------------------

test("stored quality: only the picker's heights", async () => {
    const { parseStoredVideoQuality, TEACHER_VIDEO_QUALITY_HEIGHTS } = await load();

    assert.deepEqual(Array.from(TEACHER_VIDEO_QUALITY_HEIGHTS), [1080, 720, 480, 320, 180]);

    for (const height of TEACHER_VIDEO_QUALITY_HEIGHTS) {
        assert.equal(parseStoredVideoQuality(String(height)), height);
    }

    for (const bad of [null, undefined, "", "999", "720p", " 720", "0", "-720", "1e3"]) {
        assert.equal(parseStoredVideoQuality(bad), null, String(bad));
    }
});

test("stored frame rate: 15 / 24 / 30, else the default 15", async () => {
    const { parseStoredFrameRate, TEACHING_FRAME_RATES, DEFAULT_TEACHING_FRAME_RATE } = await load();

    assert.deepEqual(Array.from(TEACHING_FRAME_RATES), [15, 24, 30]);
    assert.equal(DEFAULT_TEACHING_FRAME_RATE, 15);

    assert.equal(parseStoredFrameRate("15"), 15);
    assert.equal(parseStoredFrameRate("24"), 24);
    assert.equal(parseStoredFrameRate("30"), 30);

    for (const bad of [null, undefined, "", "20", "60", "24fps", "abc"]) {
        assert.equal(parseStoredFrameRate(bad), 15, String(bad));
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
        type: "SL_TEACHING_MODE", v: 1, epoch: 4, enabled: false, maxFps: 15, detailHint: true
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
