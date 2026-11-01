/*
 * Screen Share Audio Echo Guard (deploy/jitsi/custom.js).
 *
 * Cause under test: lib-jitsi-meet asks getDisplayMedia for audio with
 * systemAudio "include"; whole-screen system audio contains the meeting's
 * own playback, which Jitsi mixes into the sharer's microphone and sends,
 * so every voice comes back to the room. The guard only rewrites the
 * getDisplayMedia constraints. The fake mediaDevices records what reached
 * the browser; real capture behaviour still needs a real browser.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./harness.cjs");

function fakeNavigator({ restrictOwnAudio = false } = {}) {
    const calls = [];
    const mediaDevices = {
        getDisplayMedia(constraints) {
            assert.equal(this, mediaDevices, "called on mediaDevices (no Illegal invocation)");
            calls.push(constraints);

            return Promise.resolve({ id: "display-stream" });
        },
        getSupportedConstraints() {
            return restrictOwnAudio ? { echoCancellation: true, restrictOwnAudio: true } : { echoCancellation: true };
        }
    };

    return { navigator: { mediaDevices }, calls };
}

// lib-jitsi-meet's constraints on Chrome without the upstream fix.
function jitsiConstraints(audio) {
    return {
        audio,
        video: { frameRate: { max: 5 } },
        systemAudio: "include",
        surfaceSwitching: "include",
        selfBrowserSurface: "exclude",
        cursor: "always"
    };
}

test("no restrictOwnAudio: whole-screen system audio (the meeting's own playback) is not offered", async () => {
    const { navigator, calls } = fakeNavigator();

    createHarness({ navigator });

    const stream = await navigator.mediaDevices.getDisplayMedia(jitsiConstraints(true));

    assert.equal(stream.id, "display-stream", "Jitsi still gets the stream");
    assert.equal(calls.length, 1, "one capture, no duplicate");
    assert.equal(calls[0].systemAudio, "exclude");
    assert.equal(calls[0].audio, true, "tab audio is still requested");
    assert.deepEqual({ ...calls[0].video }, { frameRate: { max: 5 } }, "video constraints unchanged");
    assert.equal(calls[0].selfBrowserSurface, "exclude", "Jitsi's own choice kept");
    assert.equal(calls[0].surfaceSwitching, "include");
});

test("restrictOwnAudio supported: shared audio kept (system too), this page's own playback excluded", async () => {
    const { navigator, calls } = fakeNavigator({ restrictOwnAudio: true });

    createHarness({ navigator });

    await navigator.mediaDevices.getDisplayMedia(jitsiConstraints(true));
    await navigator.mediaDevices.getDisplayMedia(jitsiConstraints({ channelCount: 2, echoCancellation: false }));

    assert.deepEqual({ ...calls[0].audio }, { restrictOwnAudio: true }, "made in the custom.js realm: compared as a plain copy");
    assert.equal(calls[0].systemAudio, "include", "system audio still offered");
    assert.deepEqual({ ...calls[1].audio }, { channelCount: 2, echoCancellation: false, restrictOwnAudio: true },
        "Jitsi's audio constraints merged, not replaced");
});

test("video-only screen share: constraints passed through untouched", async () => {
    for (const restrictOwnAudio of [false, true]) {
        const { navigator, calls } = fakeNavigator({ restrictOwnAudio });

        createHarness({ navigator });

        const constraints = jitsiConstraints(false);

        await navigator.mediaDevices.getDisplayMedia(constraints);
        await navigator.mediaDevices.getDisplayMedia();

        assert.equal(calls[0], constraints, "the same object, unchanged");
        assert.equal(calls[0].systemAudio, "include");
        assert.equal(calls[1], undefined);
    }
});

test("caller's constraints are not mutated, and the guard wraps only once", async () => {
    const { navigator, calls } = fakeNavigator({ restrictOwnAudio: true });
    const audio = { echoCancellation: true };
    const constraints = jitsiConstraints(audio);

    createHarness({ navigator });
    const wrapped = navigator.mediaDevices.getDisplayMedia;

    createHarness({ navigator });
    assert.equal(navigator.mediaDevices.getDisplayMedia, wrapped, "custom.js loaded twice: no second wrapper");

    await navigator.mediaDevices.getDisplayMedia(constraints);

    assert.equal(calls.length, 1);
    assert.deepEqual(audio, { echoCancellation: true }, "original audio object untouched");
    assert.equal(constraints.audio, audio);
});

test("only getDisplayMedia is wrapped: microphone capture is untouched", () => {
    const { navigator } = fakeNavigator();
    const getUserMedia = () => Promise.resolve({ id: "mic" });

    navigator.mediaDevices.getUserMedia = getUserMedia;
    createHarness({ navigator });

    assert.equal(navigator.mediaDevices.getUserMedia, getUserMedia);
});

test("no navigator / no getDisplayMedia: nothing breaks", () => {
    assert.doesNotThrow(() => createHarness());
    assert.doesNotThrow(() => createHarness({ navigator: { mediaDevices: {} } }));
});
