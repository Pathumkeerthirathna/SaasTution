/*
 * Teacher audio preferences (components/Jitsi/teacher-audio-preferences.mjs):
 * Jitsi's model-based noise suppression (RNNoise) on the teacher's microphone,
 * ON by default, an explicitly saved OFF kept, and the controller that sends
 * "setNoiseSuppressionEnabled" once per conference join, never dropping a
 * choice made before Jitsi is ready.
 *
 *   npm run test:jitsi
 *
 * The controller is tested with a fake `send`. Whether Jitsi actually starts
 * RNNoise (it gives no read-back) needs a real browser.
 */

"use strict";

const path = require("path");
const { pathToFileURL } = require("url");
const test = require("node:test");
const assert = require("node:assert/strict");

let modulePromise = null;

function load() {
    modulePromise = modulePromise || import(pathToFileURL(
        path.join(__dirname, "..", "..", "components", "Jitsi", "teacher-audio-preferences.mjs")).href);

    return modulePromise;
}

// A fake Jitsi command sender: records values, can be "not ready" (no API).
function fakeSender() {
    const sent = [];
    const sender = {
        ready: true,
        sent,
        send(enabled) {
            if (!sender.ready) {
                return false;
            }

            sent.push(enabled);

            return true;
        }
    };

    return sender;
}

// ---- Stored preference -----------------------------------------------------------

test("RNNoise is ON by default for teachers; only an explicit 'false' turns it off", async () => {
    const { DEFAULT_TEACHER_NOISE_SUPPRESSION, NOISE_SUPPRESSION_STORAGE_KEY, parseStoredNoiseSuppression } = await load();

    assert.equal(DEFAULT_TEACHER_NOISE_SUPPRESSION, true);
    assert.equal(NOISE_SUPPRESSION_STORAGE_KEY, "sl-classroom-teacher-noise-suppression", "same key as before");
    assert.equal(parseStoredNoiseSuppression("false"), false, "an explicitly saved OFF is respected");
    assert.equal(parseStoredNoiseSuppression("true"), true);

    for (const raw of [null, undefined, "", "1", "0", "yes", "False", " false"]) {
        assert.equal(parseStoredNoiseSuppression(raw), true, String(raw));
    }
});

test("readStoredNoiseSuppression: no storage (server render, private mode) means the default", async () => {
    const { readStoredNoiseSuppression } = await load();
    const original = globalThis.localStorage;

    try {
        delete globalThis.localStorage;
        assert.equal(readStoredNoiseSuppression(), true);

        globalThis.localStorage = { getItem: () => { throw new Error("blocked"); } };
        assert.equal(readStoredNoiseSuppression(), true);

        globalThis.localStorage = { getItem: key => (key === "sl-classroom-teacher-noise-suppression" ? "false" : null) };
        assert.equal(readStoredNoiseSuppression(), false);
    } finally {
        if (original === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = original;
        }
    }
});

// ---- Controller -------------------------------------------------------------------

test("a choice made before Jitsi joins is queued, then sent on the first join, once", async () => {
    const { createNoiseSuppressionController } = await load();
    const sender = fakeSender();
    const control = createNoiseSuppressionController(sender.send);

    assert.equal(control.setDesired(true), false, "not joined: kept, not sent");
    assert.deepEqual(sender.sent, []);

    assert.equal(control.conferenceJoined(), true);
    assert.deepEqual(sender.sent, [true]);

    // The page hands over the same choice again at join: no repeat.
    assert.equal(control.setDesired(true), false);
    assert.deepEqual(sender.sent, [true]);
});

test("no Jitsi API yet: the choice is not lost; the next join sends it", async () => {
    const { createNoiseSuppressionController } = await load();
    const sender = fakeSender();
    const control = createNoiseSuppressionController(sender.send);

    sender.ready = false;
    control.conferenceJoined();
    control.setDesired(true);

    assert.deepEqual(sender.sent, []);
    assert.deepEqual(control.state(), { desired: true, applied: null, joined: true });

    sender.ready = true;
    control.conferenceJoined();

    assert.deepEqual(sender.sent, [true]);
});

test("rejoin (reconnect, breakout switch, recreated meeting): sent again, once per join", async () => {
    const { createNoiseSuppressionController } = await load();
    const sender = fakeSender();
    const control = createNoiseSuppressionController(sender.send);

    control.setDesired(false);
    control.conferenceJoined();
    control.conferenceLeft();
    control.conferenceJoined();
    control.conferenceJoined();

    assert.deepEqual(sender.sent, [false, false, false], "each join sends the choice once");
});

test("a change while joined is sent at once; the same value is not sent twice", async () => {
    const { createNoiseSuppressionController } = await load();
    const sender = fakeSender();
    const control = createNoiseSuppressionController(sender.send);

    control.conferenceJoined();
    assert.deepEqual(sender.sent, [], "nothing chosen yet: nothing sent");

    control.setDesired(true);
    control.setDesired(true);
    control.setDesired(false);
    control.setDesired(false);
    control.setDesired(true);

    assert.deepEqual(sender.sent, [true, false, true]);
});

test("left: nothing is sent until the next join", async () => {
    const { createNoiseSuppressionController } = await load();
    const sender = fakeSender();
    const control = createNoiseSuppressionController(sender.send);

    control.setDesired(true);
    control.conferenceJoined();
    control.conferenceLeft();
    control.setDesired(false);

    assert.deepEqual(sender.sent, [true]);

    control.conferenceJoined();
    assert.deepEqual(sender.sent, [true, false]);
});

test("only booleans are accepted; a bad value never replaces a valid choice", async () => {
    const { createNoiseSuppressionController } = await load();
    const sender = fakeSender();
    const control = createNoiseSuppressionController(sender.send);

    control.setDesired(false);

    for (const bad of ["true", 1, 0, null, undefined, {}]) {
        assert.equal(control.setDesired(bad), false, String(bad));
    }

    control.conferenceJoined();
    assert.deepEqual(sender.sent, [false]);
});
