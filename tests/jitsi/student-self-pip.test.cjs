/*
 * Student Self-Camera PiP (deploy/jitsi/custom.js, "Student Self-Camera
 * PiP"): a student sees their OWN camera in a small top-right tile while it
 * is on.
 *
 *   npm run test:jitsi
 *
 * - Only in a student's iframe (filmstrip disabled by the page, not a
 *   moderator, not the recorder); only the LOCAL camera track, never a
 *   remote one, never a screen share.
 * - Shown only while that track is on, has data and has not ended; removed
 *   at once otherwise (camera off, track removed, permission denied, the
 *   device failing).
 * - Muted <video>, the local video JitsiTrack attached once, no audio track.
 *
 * Runs against the fake DOM / Jitsi model in harness.cjs, not a real
 * browser or camera: it checks state, DOM structure and what is attached.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

const ID = "sl-self-pip";
const ME = "me000001";

// A student's iframe after the store poll: Jitsi's media state as the
// classroom starts it (camera and microphone muted, no tracks yet).
function setup({ role = "participant", filmstripDisabled = true, recorder = false } = {}) {
    const h = createHarness();

    h.participants.local = { id: ME, role, name: "Me" };
    h.state["features/base/config"] = { filmstrip: { disabled: filmstripDisabled }, ...(recorder ? { iAmRecorder: true } : {}) };
    h.state["features/base/media"] = {
        audio: { available: true, muted: true },
        video: { available: true, muted: 4 }
    };

    const large = h.document.createElement("div");

    large.id = "largeVideoContainer";
    h.document.body.appendChild(large);
    h.timers.advance(600);
    h.change();

    return h;
}

// The browser's MediaStreamTrack under a local JitsiTrack.
function mediaTrack(kind) {
    const listeners = {};

    return {
        kind,
        readyState: "live",
        addEventListener(type, fn) { (listeners[type] = listeners[type] || new Set()).add(fn); },
        removeEventListener(type, fn) { listeners[type]?.delete(fn); },
        listenerCount: type => listeners[type]?.size || 0,
        end() {
            this.readyState = "ended";
            (listeners.ended || new Set()).forEach(fn => fn());
        }
    };
}

// A local track entry as Jitsi's trackAdded() builds it, with a JitsiTrack
// that records where it is attached.
function localTrack(h, mediaType, { muted = false, videoType, isReceivingData = true, facing = "user" } = {}) {
    const media = mediaTrack(mediaType);
    const jitsiTrack = {
        stream: { id: "local-" + mediaType + "-" + (videoType || "camera"), tracks: [media] },
        attached: [],
        attach(el) {
            jitsiTrack.attached.push(el);
            el.srcObject = jitsiTrack.stream;

            return Promise.resolve();
        },
        detach(el) {
            jitsiTrack.attached = jitsiTrack.attached.filter(other => other !== el);

            if (el && el.srcObject === jitsiTrack.stream) {
                el.srcObject = null;
            }
        },
        getTrack: () => media,
        getCameraFacingMode: () => facing
    };
    const entry = {
        local: true,
        mediaType,
        videoType: mediaType === "video" ? (videoType || "camera") : undefined,
        muted,
        isReceivingData,
        participantId: ME,
        jitsiTrack
    };

    h.state["features/base/tracks"].push(entry);

    return { entry, jitsiTrack, media };
}

function removeTrack(h, entry) {
    h.state["features/base/tracks"] = h.state["features/base/tracks"].filter(track => track !== entry);
}

const pip = h => h.document.getElementById(ID);
const pipVideo = h => pip(h) && pip(h).children[0];

test("student joins with the camera off: no PiP (also while the camera is starting)", () => {
    const h = setup();

    assert.equal(pip(h), null);

    // Jitsi's stub while the device starts (no jitsiTrack yet).
    h.state["features/base/tracks"].push({ local: true, mediaType: "video", gumProcess: { cancel() {} } });
    h.change();
    assert.equal(pip(h), null);

    // Camera track present but muted.
    localTrack(h, "video", { muted: true });
    h.change();
    assert.equal(pip(h), null);
});

test("camera on: the tile shows the student's OWN local camera, never a remote one", () => {
    const h = setup();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0002");
    h.change();
    assert.equal(pip(h), null, "remote cameras never fill the tile");

    const own = localTrack(h, "video");

    h.change();

    assert.ok(pip(h), "tile shown");
    assert.equal(pipVideo(h).srcObject, own.jitsiTrack.stream, "own local stream");
    assert.equal(pipVideo(h).paused, false, "playing");
    assert.deepEqual(own.jitsiTrack.attached, [pipVideo(h)], "attached once");
    h.state["features/base/tracks"].filter(track => !track.local).forEach(track => {
        assert.notEqual(pipVideo(h).srcObject, track.jitsiTrack.stream);
    });

    // Further store changes: nothing re-attached.
    h.change();
    h.change();
    assert.equal(own.jitsiTrack.attached.length, 1);
});

test("camera off again: the tile goes at once, detached; on again: back", () => {
    const h = setup();
    const own = localTrack(h, "video");

    h.change();
    const video = pipVideo(h);

    own.entry.muted = true;
    h.change();

    assert.equal(pip(h), null, "tile removed");
    assert.equal(video.srcObject, null, "our element detached");
    assert.deepEqual(own.jitsiTrack.attached, []);
    assert.equal(own.media.listenerCount("ended"), 0, "ended listener removed");

    own.entry.muted = false;
    h.change();
    assert.ok(pip(h));
    assert.equal(pipVideo(h).srcObject, own.jitsiTrack.stream);
});

test("track removed, replaced, no data, ended, or permission denied: hidden gracefully", () => {
    const h = setup();
    let own = localTrack(h, "video");

    h.change();
    assert.ok(pip(h));

    // Removed (camera failed / turned off by Jitsi).
    removeTrack(h, own.entry);
    h.change();
    assert.equal(pip(h), null);
    assert.deepEqual(own.jitsiTrack.attached, []);

    // Replaced by a new track (camera switch): the new one is shown.
    own = localTrack(h, "video");
    h.change();
    const next = localTrack(h, "video");

    removeTrack(h, own.entry);
    h.change();
    assert.equal(pipVideo(h).srcObject, next.jitsiTrack.stream, "new track shown");
    assert.deepEqual(own.jitsiTrack.attached, [], "old track detached");

    // No data from the device.
    next.entry.isReceivingData = false;
    h.change();
    assert.equal(pip(h), null);
    next.entry.isReceivingData = true;
    h.change();
    assert.ok(pip(h));

    // The device ends WITHOUT a store change (unplugged): its own event.
    next.media.end();
    assert.equal(pip(h), null, "hidden on the track's ended event");
    h.change();
    assert.equal(pip(h), null, "an ended track is never shown again");

    // Permission denied: no track at all, the camera unavailable.
    removeTrack(h, next.entry);
    h.state["features/base/media"].video = { available: false, muted: 4 };
    h.change();
    assert.equal(pip(h), null);
    assert.equal(h.warnings.length, 0, "nothing thrown or warned");
});

test("never a screen share: own desktop track alone shows nothing; with the camera, the camera", () => {
    const h = setup();
    const desktop = localTrack(h, "video", { videoType: "desktop" });

    h.change();
    assert.equal(pip(h), null);

    const camera = localTrack(h, "video");

    h.change();
    assert.equal(pipVideo(h).srcObject, camera.jitsiTrack.stream);
    assert.deepEqual(desktop.jitsiTrack.attached, []);
});

test("muted, no duplicate audio: only the video track is attached to a muted element", () => {
    const h = setup();
    const mic = localTrack(h, "audio");
    const camera = localTrack(h, "video");

    h.change();

    const video = pipVideo(h);

    assert.equal(video.tagName, "VIDEO");
    assert.equal(video.muted, true);
    assert.equal(video.hasAttribute("muted"), true);
    assert.equal(video.hasAttribute("playsinline"), true);
    assert.deepEqual(mic.jitsiTrack.attached, [], "the microphone is never attached");
    assert.equal(camera.jitsiTrack.attached.length, 1);
    assert.equal(h.document.body.children.filter(el => el.tagName === "AUDIO").length, 0, "no <audio> added");
    assert.equal(pip(h).children.length, 1, "one element in the tile");
});

test("mirrored like Jitsi's self-view, except a rear camera", () => {
    const h = setup();
    const own = localTrack(h, "video", { facing: "environment" });

    h.change();
    assert.equal(pip(h).classList.contains("sl-rear"), true);

    const style = h.document.getElementById("sl-self-pip-style").textContent;

    assert.match(style, /#sl-self-pip video \{[^}]*transform: scaleX\(-1\)/);
    assert.match(style, /#sl-self-pip\.sl-rear video \{ transform: none; \}/);
    assert.match(style, /pointer-events: none/, "clicks pass through to classroom controls");
    assert.match(style, /@media \(max-width: 640px\)/, "smaller on phones");
    own.entry.muted = true;
    h.change();
});

test("teacher, teacher's iframe before the role arrives, and the recorder: never a tile", () => {
    for (const options of [{ role: "moderator" }, { role: undefined, filmstripDisabled: false }, { recorder: true }]) {
        const h = setup(options);

        localTrack(h, "video");
        h.change();

        assert.equal(pip(h), null, JSON.stringify(options));
        assert.equal(h.document.getElementById("sl-self-pip-style"), null);
    }
});

test("student promoted to moderator: the tile goes", () => {
    const h = setup();

    localTrack(h, "video");
    h.change();
    assert.ok(pip(h));

    h.participants.local.role = "moderator";
    h.change();
    assert.equal(pip(h), null);
});

test("Jitsi's filmstrip stays hidden for the student while the tile shows", () => {
    const h = setup();

    localTrack(h, "video");
    h.change();

    assert.ok(pip(h));
    assert.equal(h.document.body.classList.contains("sl-student-no-filmstrip"), true);
    assert.match(h.document.getElementById("sl-student-filmstrip-style").textContent,
        /body\.sl-student-no-filmstrip \.filmstrip \{ display: none !important; \}/);
});

test("placed top-right of the large video; under the page's Exit fullscreen button in fullscreen", () => {
    const h = setup();

    h.document._rects.largeVideoContainer = { top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600 };
    localTrack(h, "video");
    h.change();

    assert.equal(pip(h).style.top, "12px");
    assert.equal(pip(h).style.right, "292px", "1280 - 1000 + 12");

    h.postFromParent({ type: "SL_DEVICE_STATUS_VIEW", v: 1, epoch: 2, enabled: false, fullscreen: true });
    assert.equal(pip(h).style.top, "56px", "below the 36px button at 12px, plus a gap");

    // A stale message never overrides a newer one.
    h.postFromParent({ type: "SL_DEVICE_STATUS_VIEW", v: 1, epoch: 1, enabled: false, fullscreen: false });
    assert.equal(pip(h).style.top, "56px");

    h.postFromParent({ type: "SL_DEVICE_STATUS_VIEW", v: 1, epoch: 3, enabled: false, fullscreen: false });
    assert.equal(pip(h).style.top, "12px");
});

test("beside the teacher-camera PiP while a screen share is on the stage", () => {
    const h = setup();
    const share = h.document.createElement("div");

    share.id = "sl-share-pip";
    share.classList.add("sl-visible");
    h.document._rects["sl-share-pip"] = { top: 12, left: 1028, right: 1268, bottom: 147, width: 240, height: 135 };
    h.document.body.appendChild(share);

    localTrack(h, "video");
    h.change();

    assert.equal(pip(h).style.top, "12px", "same row");
    assert.equal(pip(h).style.right, "260px", "1280 - 1028 + 8: left of it, never on top");
});
