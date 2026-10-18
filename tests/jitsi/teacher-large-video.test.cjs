/*
 * Regression tests: the teacher view pauses Jitsi's own (covered) large video
 * element #largeVideo while it shows, and gives it back to Jitsi when it
 * goes (deploy/jitsi/custom.js, teacher normal view).
 *
 *   npm run test:jitsi
 *
 * #largeVideo here is a fake <video> with autoplay, like Jitsi's: assigning a
 * stream starts it, and Jitsi's restarts are simulated with play() + a
 * "play" event. Runs against the fake DOM / Jitsi model in harness.cjs: it
 * checks the element's paused state and listeners, not real decoding,
 * rendering or CPU use.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness, ids } = require("./harness.cjs");

// Jitsi's large video: in the page, autoplay, showing a stream.
function addLargeVideo(h, stream = { id: "stream-large" }) {
    const el = h.document.createElement("video");

    el.id = "largeVideo";
    el.autoplay = true;
    h.document.body.appendChild(el);
    el.srcObject = stream;

    return el;
}

// Jitsi restarts the element: autoplay on a (new) stream, or its own play().
// The "play" event is queued, so it arrives after the call.
async function jitsiRestarts(h, el, stream) {
    if (stream) {
        el.srcObject = stream;
    } else {
        el.play();
    }

    await h.flush();
    el.dispatchEvent({ type: "play" });
}

const playListeners = el => (el.listeners.play || []).length;

function stageVideo(h) {
    for (const el of h.document.documentElement.walk()) {
        if (el.classList.contains("sl-tv-stage")) {
            return el.children[0];
        }
    }

    return null;
}

async function teacher({ count = 4 } = {}) {
    const h = createHarness();
    const all = ids(count);

    all.forEach(id => h.addParticipant(id));

    return { h, all };
}

async function setView(h, enabled, epoch) {
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch, enabled });
    await h.flush();
}

test("Normal mode: the covered #largeVideo is paused; the custom stage keeps playing the same stream", async () => {
    const { h, all } = await teacher();
    const large = addLargeVideo(h);

    assert.equal(large.paused, false, "Jitsi plays it before the view shows");

    await h.startTeacher();
    await h.run(1000);

    // The teacher selects a student: Jitsi's large video and our stage share
    // that student's stream.
    const track = h.trackOf(all[1]);

    h.teacherTest().tileClick(all[1]);
    await h.flush();
    large.srcObject = track.jitsiTrack.stream;
    await h.flush();
    h.change();
    await h.flush();

    const stage = stageVideo(h);

    assert.equal(large.paused, true, "#largeVideo paused");
    assert.equal(stage.srcObject, track.jitsiTrack.stream, "stage shows the same stream");
    assert.equal(stage.paused, false, "custom stage still playing");
    assert.equal(large.srcObject, track.jitsiTrack.stream, "stream kept on #largeVideo (not detached)");
    assert.equal(track.muted, false, "track untouched");
    assert.ok(h.document.getElementById("largeVideo"), "#largeVideo stays in the page");
});

test("Tiles mode: #largeVideo paused although the custom stage has no video", async () => {
    const { h, all } = await teacher();
    const large = addLargeVideo(h);

    await h.startTeacher();
    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });

    assert.equal(h.tilesState().layout, "tiles");
    assert.equal(stageVideo(h).srcObject, null, "no stage video in Tiles");
    assert.equal(large.paused, true);
});

test("re-paused when Jitsi restarts playback (its play(), or autoplay on a new stream)", async () => {
    const { h } = await teacher();
    const large = addLargeVideo(h);

    await h.startTeacher();
    assert.equal(large.paused, true);

    await jitsiRestarts(h, large);
    assert.equal(large.paused, true, "after Jitsi's play()");

    await jitsiRestarts(h, large, { id: "stream-other-participant" });
    assert.equal(large.paused, true, "after a stream reassignment");
    assert.equal(large.srcObject.id, "stream-other-participant", "Jitsi's new stream kept");
});

test("playback that started without a play event is caught by the next render", async () => {
    const { h } = await teacher();
    const large = addLargeVideo(h);

    await h.startTeacher();

    large.play();
    assert.equal(large.paused, false);

    h.change();
    assert.equal(large.paused, true);
});

test("Jitsi replaces #largeVideo: the new element is paused and guarded, the old one let go", async () => {
    const { h } = await teacher();
    const first = addLargeVideo(h);

    await h.startTeacher();
    assert.equal(playListeners(first), 1);

    first.remove();
    first.id = "";

    const second = addLargeVideo(h, { id: "stream-after-remount" });

    assert.equal(second.paused, false);
    h.change();

    assert.equal(second.paused, true, "replacement paused");
    assert.equal(playListeners(first), 0, "listener moved off the old element");
    assert.equal(playListeners(second), 1);

    // Released: the CURRENT element plays again; the removed one is not touched.
    await setView(h, false, 2);
    assert.equal(second.paused, false);
    assert.equal(first.paused, true, "old, removed element left as it was");
});

test("view disabled: Jitsi's large video plays again, listener removed", async () => {
    const { h } = await teacher();
    const large = addLargeVideo(h);

    await h.startTeacher();
    assert.equal(large.paused, true);

    await setView(h, false, 2);

    assert.equal(large.paused, false, "playing again");
    assert.equal(playListeners(large), 0);

    // A play event Jitsi queued before the release is handled after it: ignored.
    large.dispatchEvent({ type: "play" });
    assert.equal(large.paused, false);
});

test("Exam Mode: the view hides and Jitsi's large video plays; back to Normal: paused again", async () => {
    const { h } = await teacher();
    const large = addLargeVideo(h);

    await h.startTeacher();
    assert.equal(large.paused, true);

    // The Exam grid shows (its body class); the view hides itself.
    h.document.body.classList.add("sl-monitor-active");
    await h.flush();
    await h.flush();

    assert.equal(h.document.body.classList.contains("sl-teacher-view-active"), false);
    assert.equal(large.paused, false, "plays during Exam Mode");

    h.document.body.classList.remove("sl-monitor-active");
    await h.flush();
    await h.flush();

    assert.equal(h.document.body.classList.contains("sl-teacher-view-active"), true);
    assert.equal(large.paused, true, "paused again in Normal mode");
});

test("an element this code did not pause is never resumed or altered", async () => {
    const { h } = await teacher();
    const large = addLargeVideo(h);

    // Paused by Jitsi itself before the view shows.
    large.pause();

    let plays = 0;
    const play = large.play.bind(large);

    large.play = () => { plays += 1; return play(); };

    await h.startTeacher();
    assert.equal(large.paused, true);

    await setView(h, false, 2);

    assert.equal(large.paused, true, "left paused, as Jitsi had it");
    assert.equal(plays, 0, "play() never called on it");
});

test("an element without a stream is not resumed", async () => {
    const { h } = await teacher();
    const large = addLargeVideo(h);

    await h.startTeacher();
    large.srcObject = null;
    await setView(h, false, 2);

    assert.equal(large.paused, true);
});

test("repeated activation / deactivation never accumulates listeners", async () => {
    const { h } = await teacher();
    const large = addLargeVideo(h);

    await h.startTeacher();

    for (let round = 0; round < 5; round++) {
        await setView(h, false, 2 + round * 2);
        assert.equal(playListeners(large), 0);
        assert.equal(large.paused, false);

        await setView(h, true, 3 + round * 2);
        h.change();
        assert.equal(playListeners(large), 1);
        assert.equal(large.paused, true);
    }
});

test("a rejected play() on release (AbortError / autoplay refused) is swallowed quietly", async () => {
    const { h } = await teacher();
    const large = addLargeVideo(h);
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);

    process.on("unhandledRejection", onUnhandled);

    try {
        await h.startTeacher();

        large.play = () => {
            const error = new Error("The play() request was interrupted by a call to pause().");

            error.name = "AbortError";

            return Promise.reject(error);
        };

        await setView(h, false, 2);
        await h.flush();
        await h.flush();

        assert.deepEqual(unhandled, []);
        assert.deepEqual(h.warnings, [], "no console noise");
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("students (not moderators) never touch #largeVideo", async () => {
    const h = createHarness();

    h.participants.local = { id: "stud001", role: "participant", name: "Student" };

    const large = addLargeVideo(h);

    h.timers.advance(600);
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 1, enabled: true });
    h.change();
    await h.flush();

    assert.equal(large.paused, false);
    assert.equal(playListeners(large), 0);
});

test("view never enabled: #largeVideo untouched", async () => {
    const { h } = await teacher();
    const large = addLargeVideo(h);

    h.timers.advance(600);
    h.change();
    await h.flush();

    assert.equal(large.paused, false);
    assert.equal(playListeners(large), 0);
});
