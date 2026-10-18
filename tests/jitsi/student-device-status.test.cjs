/*
 * Regression tests: the student's own camera / microphone status indicator
 * (deploy/jitsi/custom.js, "Student Device Status", SL_DEVICE_STATUS_VIEW).
 *
 *   npm run test:jitsi
 *
 * - Read only from the LOCAL tracks and Jitsi's media state (the store
 *   fields checked against jitsi-meet tag jitsi-meet_9268): camera and
 *   microphone each on their own; a screen share is never the camera; a
 *   remote participant's tracks never count.
 * - States never claim transmission: on / off / starting / nodata /
 *   unavailable / notStarted; nothing at all while unknown (no conference,
 *   no media slice, a moderator, not enabled).
 * - Placed top-right of the large video, left of the page's "Exit
 *   fullscreen" button in fullscreen; the teacher-camera PiP moves below it.
 * - Parent messages: origin, shape and stale epochs checked like the others.
 *
 * Runs against the fake DOM / Jitsi model in harness.cjs, not a real
 * browser: it checks state, DOM structure and the injected CSS, not the
 * painted result (sizes are given to elements by hand). Fake timers only;
 * renders are coalesced into a microtask, flushed with h.flush().
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

const ID = "sl-device-status";
const PARENT_ORIGIN = "http://localhost:3000";
const VIEW = { type: "SL_DEVICE_STATUS_VIEW", v: 1, epoch: 1, enabled: true, fullscreen: false };

// Jitsi's media state as this classroom starts it (startWithAudioMuted /
// startWithVideoMuted): both muted, no tracks yet. video.muted is Jitsi's
// bitmask (4 = muted by the user).
function startMedia() {
    return {
        audio: { available: true, muted: true, gumPending: 2, unmuteBlocked: false },
        video: { available: true, muted: 4, gumPending: 2, unmuteBlocked: false }
    };
}

function element(h, id) {
    const el = h.document.createElement("div");

    el.id = id;

    return el;
}

// A student's iframe with Jitsi's page, large video and toolbar, after the
// store poll. view: the parent's message (null: none sent).
async function setup({ role = "participant", view = VIEW } = {}) {
    const h = createHarness();

    h.participants.local = { id: "me000001", role, name: "Me" };
    h.state["features/base/media"] = startMedia();

    const page = element(h, "videoconference_page");
    const large = element(h, "largeVideoContainer");
    const toolbar = element(h, "new-toolbox");

    page.appendChild(large);
    page.appendChild(toolbar);
    h.document.body.appendChild(page);

    h.timers.advance(600);

    if (view) {
        h.postFromParent(view);
    }

    await h.flush();

    return { h, page, large, toolbar };
}

const indicator = h => h.document.getElementById(ID);

function chip(h, device) {
    const root = indicator(h);
    const el = root && root.children.find(child => child.dataset.device === device);

    return el
        ? {
            el,
            state: el.dataset.state,
            tone: el.dataset.tone,
            icon: el.children[0].dataset.icon,
            long: el.children[1].textContent,
            short: el.children[2].textContent,
            spoken: el.children[3].textContent
        }
        : null;
}

// A local track entry as Jitsi's trackAdded() builds it, or (stub) the one
// TRACK_WILL_CREATE adds while the device starts.
function localTrack(h, mediaType, { muted = false, videoType, isReceivingData = true, stub = false } = {}) {
    const entry = stub
        ? { local: true, mediaType, gumProcess: { cancel() {} } }
        : {
            local: true,
            mediaType,
            videoType: videoType !== undefined ? videoType : (mediaType === "video" ? "camera" : undefined),
            muted,
            isReceivingData,
            participantId: "me000001",
            jitsiTrack: { isMuted: () => entry.muted }
        };

    h.state["features/base/tracks"].push(entry);

    return entry;
}

function removeTrack(h, entry) {
    h.state["features/base/tracks"] = h.state["features/base/tracks"].filter(track => track !== entry);
}

async function changed(h) {
    h.change();
    await h.flush();
}

function sizeIndicator(h, width, height) {
    indicator(h).getBoundingClientRect = () => ({ top: 12, left: 0, right: width, bottom: 12 + height, width, height, x: 0, y: 12 });
    h.ctx.dispatchEvent({ type: "resize" });
}

const bodyVar = (h, name) => h.document.body.style.getPropertyValue(name);
const activeClass = h => h.document.body.classList.contains("sl-device-status-active");

test("nothing until the page enables it; a moderator never gets it", async () => {
    const off = await setup({ view: null });

    off.h.change();
    await off.h.flush();
    assert.equal(indicator(off.h), null);

    const teacher = await setup({ role: "moderator" });

    await changed(teacher.h);
    assert.equal(indicator(teacher.h), null);
    assert.equal(activeClass(teacher.h), false);
    assert.equal(teacher.h.document.getElementById("sl-device-status-style"), null);
});

test("joined with both devices off: 'Camera is off' and 'Microphone is muted', read out too", async () => {
    const { h } = await setup();

    assert.ok(indicator(h));
    assert.equal(indicator(h).getAttribute("role"), "status");
    assert.equal(activeClass(h), true);

    const camera = chip(h, "video");
    const mic = chip(h, "audio");

    assert.deepEqual([camera.state, camera.tone, camera.icon, camera.long, camera.short, camera.spoken],
        ["off", "off", "videoOff", "Camera is off", "Camera off", "Camera is off"]);
    assert.deepEqual([mic.state, mic.tone, mic.icon, mic.long, mic.short, mic.spoken],
        ["off", "off", "audioOff", "Microphone is muted", "Mic muted", "Microphone is muted"]);
});

test("camera and microphone change independently, from the local tracks", async () => {
    const { h } = await setup();

    const camera = localTrack(h, "video");

    h.state["features/base/media"].video.muted = 0;
    await changed(h);
    assert.equal(chip(h, "video").state, "on");
    assert.equal(chip(h, "video").long, "Camera is on");
    assert.equal(chip(h, "video").icon, "video");
    assert.equal(chip(h, "audio").state, "off");

    const mic = localTrack(h, "audio");

    await changed(h);
    assert.equal(chip(h, "audio").state, "on");
    assert.equal(chip(h, "audio").long, "Microphone is on");

    camera.muted = true;
    await changed(h);
    assert.equal(chip(h, "video").state, "off");
    assert.equal(chip(h, "audio").state, "on");

    mic.muted = true;
    camera.muted = false;
    await changed(h);
    assert.equal(chip(h, "video").state, "on");
    assert.equal(chip(h, "audio").state, "off");
});

test("starting, then failed: 'starting' only while Jitsi's stub exists, then 'not started' or 'unavailable'", async () => {
    const { h } = await setup();
    const stub = localTrack(h, "video", { stub: true });

    h.state["features/base/media"].video.muted = 0;
    // Jitsi's own leftover after a failed start (gumPending stays 1).
    h.state["features/base/media"].video.gumPending = 1;
    await changed(h);
    assert.equal(chip(h, "video").state, "starting");
    assert.equal(chip(h, "video").tone, "pending");
    assert.equal(chip(h, "video").long, "Starting camera…");

    // TRACK_CREATE_ERROR removes the stub; still wanted on: not started.
    removeTrack(h, stub);
    await changed(h);
    assert.equal(chip(h, "video").state, "notStarted");
    assert.equal(chip(h, "video").tone, "warn");
    assert.equal(chip(h, "video").long, "Camera not started");

    // Marked unavailable by Jitsi.
    h.state["features/base/media"].video.available = false;
    await changed(h);
    assert.equal(chip(h, "video").state, "unavailable");
    assert.equal(chip(h, "video").long, "Camera unavailable");

    // The microphone is untouched by all of it.
    assert.equal(chip(h, "audio").state, "off");
});

test("several dispatches in one go show only the final state (no in-between 'not started')", async () => {
    const { h } = await setup();

    // Unmute request first (muted 0, nothing starting yet), then the stub:
    // two store changes in the same task, as in Jitsi.
    h.state["features/base/media"].video.muted = 0;
    h.change();
    localTrack(h, "video", { stub: true });
    h.change();

    // Not rendered yet: still the previous state.
    assert.equal(chip(h, "video").state, "off");

    await h.flush();
    assert.equal(chip(h, "video").state, "starting");
});

test("no data from the device: 'on, no picture' / 'on, no input' (a warning, not a transmission claim)", async () => {
    const { h } = await setup();

    localTrack(h, "video", { isReceivingData: false });
    localTrack(h, "audio", { isReceivingData: false });
    await changed(h);

    assert.equal(chip(h, "video").state, "nodata");
    assert.equal(chip(h, "video").tone, "warn");
    assert.equal(chip(h, "video").long, "Camera on, no picture");
    assert.equal(chip(h, "audio").long, "Microphone on, no input");
});

test("the student's own screen share is never the camera", async () => {
    const { h } = await setup();

    localTrack(h, "video", { videoType: "desktop" });
    await changed(h);
    assert.equal(chip(h, "video").state, "off");

    localTrack(h, "video", { muted: true });
    await changed(h);
    assert.equal(chip(h, "video").state, "off");
});

test("remote tracks never count as the student's own (teacher and other students on)", async () => {
    const { h } = await setup();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");
    ["teach001", "stud0001"].forEach(id => h.state["features/base/tracks"].push({
        participantId: id, mediaType: "audio", muted: false, local: false, jitsiTrack: {}
    }));
    await changed(h);

    assert.equal(chip(h, "video").state, "off");
    assert.equal(chip(h, "audio").state, "off");
});

test("no conference (loading / reconnecting) or no media slice: nothing shown, nothing left on <body>", async () => {
    const { h } = await setup();

    sizeIndicator(h, 200, 34);
    assert.equal(bodyVar(h, "--sl-ds-h"), "34px");

    const conference = h.conference();

    // No conference: Jitsi computes no receiver constraints either.
    h.setConference(null);
    h.change({ recompute: false });
    await h.flush();
    assert.equal(indicator(h), null);
    assert.equal(activeClass(h), false);
    assert.equal(bodyVar(h, "--sl-ds-h"), "");
    assert.equal(bodyVar(h, "--sl-ds-reserve"), "");

    // Back (a new conference object): the same local state again.
    h.setConference(h.newConference());
    await changed(h);
    assert.equal(chip(h, "video").state, "off");
    assert.notEqual(h.conference(), conference);

    delete h.state["features/base/media"];
    await changed(h);
    assert.equal(indicator(h), null);
});

test("the local student promoted to moderator: the indicator goes", async () => {
    const { h } = await setup();

    assert.ok(indicator(h));

    h.participants.local = { ...h.participants.local, role: "moderator" };
    await changed(h);

    assert.equal(indicator(h), null);
    assert.equal(activeClass(h), false);
});

test("messages: wrong origin, malformed and older epochs are ignored; the same epoch is accepted", async () => {
    const { h } = await setup({ view: null });
    const send = (data, origin = PARENT_ORIGIN) =>
        h.ctx.dispatchEvent({ type: "message", source: h.ctx.parent, origin, data });

    send(VIEW, "https://evil.example");
    await changed(h);
    assert.equal(indicator(h), null);

    send({ ...VIEW, fullscreen: "no" });
    send({ ...VIEW, v: 2 });
    send({ ...VIEW, enabled: 1 });
    await changed(h);
    assert.equal(indicator(h), null);
    assert.ok(h.warnings.some(args => /malformed device status view/.test(String(args[0]))));

    send({ ...VIEW, epoch: 5 });
    await h.flush();
    assert.ok(indicator(h));

    send({ ...VIEW, epoch: 4, enabled: false });
    await h.flush();
    assert.ok(indicator(h), "an older message never wins");

    send({ ...VIEW, epoch: 5, enabled: false });
    await h.flush();
    assert.equal(indicator(h), null, "the same epoch is accepted (resend)");
});

test("placement: before Jitsi's toolbar, top-right of the large video; left of the exit button in fullscreen", async () => {
    const { h, page, toolbar } = await setup();
    const root = indicator(h);

    assert.equal(root.parentNode, page);
    assert.equal(root.nextSibling, toolbar);
    assert.equal(root.style.top, "12px");
    assert.equal(root.style.right, "12px");

    h.postFromParent({ ...VIEW, epoch: 2, fullscreen: true });
    await h.flush();
    assert.equal(indicator(h).style.right, "56px");

    h.postFromParent({ ...VIEW, epoch: 3, fullscreen: false });
    await h.flush();
    assert.equal(indicator(h).style.right, "12px");
});

test("room it takes is published for the PiP and the stage chip; the teacher-camera PiP moves below it", async () => {
    const { h } = await setup();

    // The teacher shares: the PiP shows the teacher's camera.
    h.addParticipant("teach001", { role: "moderator" });
    h.addScreenShare("teach001");
    await changed(h);

    const pip = h.document.getElementById("sl-share-pip");

    assert.ok(pip, "PiP shown");

    sizeIndicator(h, 220, 34);
    assert.equal(bodyVar(h, "--sl-ds-h"), "34px");
    assert.equal(bodyVar(h, "--sl-ds-reserve"), "240px");
    assert.equal(pip.style.top, (12 + 34 + 8) + "px");

    // Indicator off: the PiP goes back to the corner.
    h.postFromParent({ ...VIEW, epoch: 2, enabled: false });
    await h.flush();
    assert.equal(indicator(h), null);
    assert.equal(pip.style.top, "12px");
});

test("custom stage: the centred chip and the camera-off card keep clear of the indicator", async () => {
    const { h } = await setup();

    h.ctx.__slStageViewTest.on();
    await changed(h);

    const css = h.document.getElementById("sl-custom-stage-style").textContent;

    assert.ok(css.includes("body.sl-device-status-active #sl-custom-stage .sl-stage-status { max-width: calc(100% - 2 * var(--sl-ds-reserve, 16px)); }"));
    assert.ok(css.includes("body.sl-device-status-active #sl-custom-stage .sl-stage-teacher { padding-top: calc(var(--sl-ds-h, 0px) + 24px); }"));
});

test("responsive CSS: full labels, short labels below 860px, icons only below 700px or 460px tall", async () => {
    const { h } = await setup();
    const css = h.document.getElementById("sl-device-status-style").textContent;

    assert.ok(css.includes("@media (max-width: 859px) { #sl-device-status .sl-ds-long { display: none; } #sl-device-status .sl-ds-short { display: inline; } }"));
    assert.ok(css.includes("@media (max-width: 699px), (max-height: 460px) {"));
    assert.ok(css.includes("pointer-events: none"));
    assert.ok(css.includes("@media (prefers-reduced-motion: reduce)"));

    // Every size keeps the full label for screen readers.
    assert.equal(chip(h, "video").spoken, "Camera is off");
    assert.equal(chip(h, "video").el.children[1].getAttribute("aria-hidden"), "true");
    assert.equal(chip(h, "video").el.children[2].getAttribute("aria-hidden"), "true");
});

test("unchanged store updates touch nothing; one style element; one indicator", async () => {
    const { h } = await setup();
    const root = indicator(h);
    const bodyStyle = h.document.body.style;
    const originalSet = bodyStyle.setProperty;
    let writes = 0;

    bodyStyle.setProperty = function (name, value) {
        if (String(name).startsWith("--sl-ds-")) {
            writes += 1;
        }

        return originalSet.call(this, name, value);
    };

    for (let i = 0; i < 20; i++) {
        h.change();
    }

    await h.flush();

    assert.equal(writes, 0);
    assert.equal(indicator(h), root);
    assert.equal(h.document.head.children.filter(el => el.id === "sl-device-status-style").length, 1);
    assert.equal(h.document.body.children.concat(...h.document.body.children.map(el => el.children))
        .filter(el => el.id === ID).length, 1);
});

test("page teardown: the indicator and everything on <body> go", async () => {
    const { h } = await setup();

    sizeIndicator(h, 200, 34);
    h.ctx.dispatchEvent({ type: "pagehide" });

    assert.equal(indicator(h), null);
    assert.equal(activeClass(h), false);
    assert.equal(bodyVar(h, "--sl-ds-h"), "");
});
