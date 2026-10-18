/*
 * Regression tests: the teacher view pauses Jitsi's own (hidden) filmstrip
 * <video> elements while it shows, and gives them back to Jitsi when it goes
 * (deploy/jitsi/custom.js, teacher normal view, suppressFilmstripVideos /
 * releaseFilmstripVideos). #largeVideo stays with its own (v1005) code.
 *
 *   npm run test:jitsi
 *
 * Jitsi's filmstrip here is a fake .filmstrip with autoplay <video>s like
 * Jitsi's (remoteVideo_remote-video-N), showing the same stream objects our
 * tiles show. Jitsi's restarts are simulated with play() + a "play" event.
 * Runs against the fake DOM / Jitsi model in harness.cjs: it checks paused
 * states, streams and listeners, not real decoding, rendering or CPU/GPU use.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness, ids } = require("./harness.cjs");

// A MediaStreamTrack stand-in on a stream: enabled, live, stop() counted.
function withMediaTrack(stream) {
    if (!stream.mediaTrack) {
        stream.mediaTrack = {
            kind: "video",
            enabled: true,
            readyState: "live",
            stops: 0,
            stop() { this.stops += 1; this.readyState = "ended"; }
        };
        stream.getTracks = () => [stream.mediaTrack];
        stream.getVideoTracks = () => [stream.mediaTrack];
    }

    return stream;
}

// Jitsi's filmstrip container (hidden by the view's CSS while it shows).
function addFilmstrip(h) {
    const strip = h.document.createElement("div");

    strip.classList.add("filmstrip");
    h.document.body.appendChild(strip);

    return strip;
}

// One of Jitsi's filmstrip thumbnails: container + autoplay video.
function addThumb(h, strip, n, stream) {
    const container = h.document.createElement("span");
    const el = h.document.createElement("video");

    container.id = "remote-video-" + n;
    el.id = "remoteVideo_remote-video-" + n;
    el.autoplay = true;
    container.appendChild(el);
    strip.appendChild(container);
    el.srcObject = stream;

    return el;
}

function addLargeVideo(h, stream = { id: "stream-large" }) {
    const el = h.document.createElement("video");

    el.id = "largeVideo";
    el.autoplay = true;
    h.document.body.appendChild(el);
    el.srcObject = stream;

    return el;
}

// Counts play() calls (Jitsi's or this code's) on an element.
function countPlays(el) {
    const play = el.play.bind(el);

    el.plays = 0;
    el.play = () => { el.plays += 1; return play(); };

    return el;
}

async function jitsiRestarts(h, el) {
    el.play();
    await h.flush();
    el.dispatchEvent({ type: "play" });
}

const playListeners = el => (el.listeners.play || []).length;
const childListObservers = h => h.document._observers.filter(observer => observer.watchesChildList).length;
const stats = h => h.teacherTest().defaultVideos();

async function setView(h, enabled, epoch) {
    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch, enabled });
    await h.flush();
}

// Two students with cameras on, each in Jitsi's filmstrip with the stream
// our tiles also play.
async function classroom({ start = true } = {}) {
    const h = createHarness();
    const all = ids(2);

    all.forEach(id => h.addParticipant(id));

    const strip = addFilmstrip(h);
    const streams = all.map(id => withMediaTrack(h.trackOf(id).jitsiTrack.stream));
    const thumbs = streams.map((stream, index) => addThumb(h, strip, index + 1, stream));

    if (start) {
        await h.startTeacher();
        await h.run(2000);
    }

    return { h, all, strip, streams, thumbs };
}

test("activation: hidden filmstrip videos paused; custom tiles keep playing the same streams", async () => {
    const { h, all, streams, thumbs } = await classroom({ start: false });

    thumbs.forEach(el => assert.equal(el.paused, false, "Jitsi plays them before the view shows"));

    await h.startTeacher();
    await h.run(2000);

    assert.equal(h.document.body.classList.contains("sl-teacher-view-active"), true);
    thumbs.forEach(el => assert.equal(el.paused, true, el.id + " paused"));

    all.forEach((id, index) => {
        const tile = h.tile(id);

        assert.ok(tile, "tile for " + id);
        assert.equal(tile.video.srcObject, streams[index], "tile shows the shared stream");
        assert.equal(tile.video.paused, false, "custom tile still playing");
        assert.equal(thumbs[index].srcObject, streams[index], "stream kept on Jitsi's element (not detached)");
    });

    assert.deepEqual({ ...stats(h), largeVideoSuppressed: undefined },
        { suppressed: true, observing: true, guarded: 2, paused: 2, yielded: 0, largeVideoSuppressed: undefined });
});

test("shared media tracks stay enabled and live; nothing is stopped or muted", async () => {
    const { h, all, streams } = await classroom();

    await setView(h, false, 2);
    await setView(h, true, 3);
    h.change();

    streams.forEach(stream => {
        assert.equal(stream.mediaTrack.enabled, true);
        assert.equal(stream.mediaTrack.readyState, "live");
        assert.equal(stream.mediaTrack.stops, 0);
    });
    all.forEach(id => assert.equal(h.trackOf(id).muted, false));
});

test("custom tiles and the stage are never paused or guarded by the helper", async () => {
    const { h, all } = await classroom();

    const ours = [];

    for (const el of h.document.documentElement.walk()) {
        if (el.tagName === "VIDEO" && el.id !== "largeVideo" && !el.id.startsWith("remoteVideo_")) {
            ours.push(el);
        }
    }

    assert.ok(ours.length >= 3, "stage + tiles");
    ours.forEach(el => assert.equal(playListeners(el), 0, "no play listener on our own videos"));

    // Our video restarts, the store changes, Jitsi's DOM changes: still playing.
    const tile = h.tile(all[0]).video;

    await jitsiRestarts(h, tile);
    h.change();
    addThumb(h, addFilmstrip(h), 9, { id: "other" });
    await h.flush();

    assert.equal(tile.paused, false);
    assert.equal(stats(h).guarded, 3, "only Jitsi's filmstrip videos");
});

test("#largeVideo stays with the v1005 code: paused once, one listener, released by it", async () => {
    const { h, thumbs } = await classroom({ start: false });
    const large = addLargeVideo(h);

    await h.startTeacher();
    h.change();
    h.change();

    assert.equal(large.paused, true);
    assert.equal(playListeners(large), 1, "a single play listener (no duplicate handler)");
    assert.equal(stats(h).guarded, 2, "#largeVideo not in the filmstrip helper");
    assert.equal(stats(h).largeVideoSuppressed, true);

    await setView(h, false, 2);

    assert.equal(large.paused, false, "released by its own code");
    assert.equal(playListeners(large), 0);
    thumbs.forEach(el => assert.equal(el.paused, false));
});

test("a filmstrip video inserted after activation is paused (no store change needed)", async () => {
    const { h, strip } = await classroom();
    const late = addThumb(h, strip, 3, withMediaTrack({ id: "stream-late" }));

    assert.equal(late.paused, false, "autoplay started it");
    await h.flush();

    assert.equal(late.paused, true, "observer caught it");
    assert.equal(playListeners(late), 1);
});

test("a replaced filmstrip video: the new one is paused, the removed one let go", async () => {
    const { h, strip, streams, thumbs } = await classroom();
    const old = countPlays(thumbs[0]);

    old.parentNode.remove();

    const fresh = countPlays(addThumb(h, strip, 1, streams[0]));

    await h.flush();

    assert.equal(fresh.paused, true, "replacement paused");
    assert.equal(playListeners(old), 0, "listener removed from the old element");
    assert.equal(stats(h).guarded, 2);

    await setView(h, false, 2);

    assert.equal(fresh.paused, false, "current element resumed");
    assert.equal(old.paused, true, "removed element left as it was");
    assert.equal(old.plays, 0);
});

test("the same element removed in one tick and put back in a later one is still restored", async () => {
    const { h, strip, streams, thumbs } = await classroom();
    const container = thumbs[0].parentNode;

    container.remove();
    await h.flush();
    assert.equal(playListeners(thumbs[0]), 0, "unguarded while out of the filmstrip");

    strip.appendChild(container);
    await h.flush();
    assert.equal(playListeners(thumbs[0]), 1, "guarded again");
    assert.equal(stats(h).paused, 2, "still counted as paused by this view");
    assert.equal(thumbs[0].srcObject, streams[0]);

    await setView(h, false, 2);

    assert.equal(thumbs[0].paused, false, "resumed on release");
    assert.equal(thumbs[1].paused, false);
});

test("a removed element is not resumed while out of the filmstrip, or with a new stream once back", async () => {
    const { h, strip, thumbs } = await classroom();
    const [gone, rebound] = thumbs.map(countPlays);

    gone.parentNode.remove();
    rebound.parentNode.remove();
    await h.flush();

    // Jitsi gives one a different stream while it is out (not started).
    rebound.autoplay = false;
    rebound.srcObject = { id: "stream-other-participant" };
    strip.appendChild(rebound.parentNode);
    await h.flush();

    await setView(h, false, 2);

    assert.equal(gone.plays, 0, "still out of the filmstrip: left alone");
    assert.equal(gone.paused, true);
    assert.equal(rebound.plays, 0, "stream changed: left to Jitsi");
    assert.equal(rebound.paused, true);
});

test("a pause record never reaches the next activation", async () => {
    const { h, strip, thumbs } = await classroom();
    const el = countPlays(thumbs[0]);

    // Out of the filmstrip across a release: not resumed (still out).
    el.parentNode.remove();
    await h.flush();
    await setView(h, false, 2);
    assert.equal(el.plays, 0);

    // Back after the release, still paused; the view comes back.
    strip.appendChild(el.parentNode);
    await setView(h, true, 3);
    h.change();
    assert.equal(stats(h).guarded, 2);
    assert.equal(stats(h).paused, 1, "only the element this activation paused");

    await setView(h, false, 4);
    assert.equal(el.plays, 0, "never paused by this activation: not resumed");
    assert.equal(thumbs[1].paused, false);
});

test("a video rebound to another stream (still paused) is not restored as the original", async () => {
    const { h, thumbs } = await classroom();
    const el = countPlays(thumbs[0]);

    // Jitsi attaches a different stream without starting it.
    el.autoplay = false;
    el.srcObject = { id: "stream-other-participant" };

    await setView(h, false, 2);

    assert.equal(el.plays, 0, "not resumed: the paused stream is gone");
    assert.equal(el.paused, true, "left to Jitsi");
    assert.equal(thumbs[1].paused, false, "the untouched one resumed");
});

test("a rebound video that Jitsi starts is re-paused, and restored with its new stream", async () => {
    const { h, thumbs } = await classroom();
    const el = thumbs[0];
    const next = { id: "stream-rebound" };

    el.srcObject = next;
    await h.flush();
    el.dispatchEvent({ type: "play" });

    assert.equal(el.paused, true, "re-paused");
    assert.equal(el.srcObject, next);

    await setView(h, false, 2);
    assert.equal(el.paused, false, "Jitsi's current stream plays again");
});

test("Jitsi's play() on a hidden video is re-paused while the view shows", async () => {
    const { h, thumbs } = await classroom();

    await jitsiRestarts(h, thumbs[0]);
    assert.equal(thumbs[0].paused, true);

    // Playing without a play event: caught by the next render.
    thumbs[1].play();
    h.change();
    assert.equal(thumbs[1].paused, true);
});

test("disabling the view restores playback; a queued play event after it is ignored", async () => {
    const { h, thumbs } = await classroom();

    await setView(h, false, 2);

    thumbs.forEach(el => {
        assert.equal(el.paused, false, el.id + " playing again");
        assert.equal(playListeners(el), 0);
    });
    assert.deepEqual({ ...stats(h), largeVideoSuppressed: undefined },
        { suppressed: false, observing: false, guarded: 0, paused: 0, yielded: 0, largeVideoSuppressed: undefined });
    assert.equal(childListObservers(h), 0, "observer disconnected");

    thumbs[0].dispatchEvent({ type: "play" });
    assert.equal(thumbs[0].paused, false);

    // Re-enabled: suppressed again.
    await setView(h, true, 3);
    h.change();
    thumbs.forEach(el => assert.equal(el.paused, true));
});

test("an element Jitsi had paused itself, or without a stream, is never resumed", async () => {
    const { h, strip, thumbs } = await classroom({ start: false });

    thumbs[0].pause();
    countPlays(thumbs[0]);

    await h.startTeacher();

    const empty = countPlays(addThumb(h, strip, 3, { id: "stream-gone" }));

    await h.flush();
    assert.equal(empty.paused, true);
    empty.srcObject = null;

    await setView(h, false, 2);

    assert.equal(thumbs[0].paused, true, "left paused, as Jitsi had it");
    assert.equal(thumbs[0].plays, 0);
    assert.equal(empty.plays, 0, "no stream: not resumed");
});

test("List <-> Tiles switches keep the videos paused (no restore in between)", async () => {
    const { h, all, thumbs } = await classroom();

    thumbs.forEach(countPlays);

    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 20 });
    assert.equal(h.tilesState().layout, "tiles");
    thumbs.forEach(el => assert.equal(el.paused, true));

    await h.sendTiles({ layout: "list", ids: all, pageSize: 20 });
    await h.sendTiles({ layout: "tiles", ids: all, pageSize: 10 });
    await h.run(2000);

    thumbs.forEach(el => {
        assert.equal(el.paused, true);
        assert.equal(el.plays, 0, "never resumed by a layout switch");
        assert.equal(playListeners(el), 1);
    });
    assert.equal(childListObservers(h), 1);
});

test("Exam Mode hides the view: videos play; back to Normal: paused again", async () => {
    const { h, thumbs } = await classroom();

    h.document.body.classList.add("sl-monitor-active");
    await h.flush();
    await h.flush();

    thumbs.forEach(el => assert.equal(el.paused, false));

    h.document.body.classList.remove("sl-monitor-active");
    await h.flush();
    await h.flush();

    thumbs.forEach(el => assert.equal(el.paused, true));
});

test("participant leaves and joins, camera toggles: still consistent", async () => {
    const { h, all, strip, thumbs } = await classroom();

    // Leaves: Jitsi removes the thumbnail.
    h.removeParticipant(all[1]);
    thumbs[1].parentNode.remove();
    h.change();
    await h.flush();
    assert.equal(stats(h).guarded, 1);

    // Joins: a new thumbnail with a new stream.
    h.addParticipant("stud900");
    const joined = addThumb(h, strip, 5, withMediaTrack(h.trackOf("stud900").jitsiTrack.stream));

    h.change();
    await h.flush();
    assert.equal(joined.paused, true);

    // Camera off / on: Jitsi detaches and re-attaches (autoplay starts it).
    h.setCamera(all[0], false);
    thumbs[0].srcObject = null;
    h.change();
    h.setCamera(all[0], true);
    thumbs[0].srcObject = h.trackOf(all[0]).jitsiTrack.stream;
    await h.flush();
    thumbs[0].dispatchEvent({ type: "play" });
    assert.equal(thumbs[0].paused, true);

    await setView(h, false, 2);
    assert.equal(thumbs[0].paused, false);
    assert.equal(joined.paused, false);
});

test("repeated renders and enable/disable cycles never add observers or listeners", async () => {
    const { h, thumbs } = await classroom();

    for (let index = 0; index < 10; index++) {
        h.change();
    }

    assert.equal(childListObservers(h), 1);
    thumbs.forEach(el => assert.equal(playListeners(el), 1));

    for (let round = 0; round < 5; round++) {
        await setView(h, false, 2 + round * 2);
        assert.equal(childListObservers(h), 0);
        thumbs.forEach(el => {
            assert.equal(playListeners(el), 0);
            assert.equal(el.paused, false);
        });

        // Disabled: every store change calls hide() again; nothing happens.
        h.change();
        h.change();

        await setView(h, true, 3 + round * 2);
        h.change();
        assert.equal(childListObservers(h), 1);
        thumbs.forEach(el => {
            assert.equal(playListeners(el), 1);
            assert.equal(el.paused, true);
        });
    }
});

test("Jitsi fighting the pause: the element is left playing after a few re-pauses (no loop)", async () => {
    const { h, thumbs } = await classroom();
    const el = thumbs[0];
    let rounds = 0;

    for (; rounds < 50 && el.paused; rounds++) {
        el.play();
        el.dispatchEvent({ type: "play" });
    }

    assert.ok(rounds < 10, "gave up after a few rounds, not " + rounds);
    assert.equal(el.paused, false);
    assert.equal(playListeners(el), 0, "listener removed");
    assert.equal(stats(h).yielded, 1);

    h.change();
    assert.equal(el.paused, false, "renders leave it playing too");
    assert.equal(thumbs[1].paused, true, "the other one still paused");

    countPlays(el);
    await setView(h, false, 2);
    assert.equal(el.plays, 0, "playing element not touched on release");
});

test("a rejected play() on release is swallowed (no unhandled rejection, no console noise)", async () => {
    const { h, thumbs } = await classroom();
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);

    process.on("unhandledRejection", onUnhandled);

    try {
        thumbs.forEach(el => {
            el.play = () => {
                const error = new Error("play() failed because the user didn't interact with the document first.");

                error.name = "NotAllowedError";

                return Promise.reject(error);
            };
        });

        await setView(h, false, 2);
        await h.flush();
        await h.flush();

        assert.deepEqual(unhandled, []);
        assert.deepEqual(h.warnings, []);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("students (not moderators) and a never-enabled view never touch filmstrip videos", async () => {
    const student = createHarness();

    student.participants.local = { id: "stud001", role: "participant", name: "Student" };

    const studentThumb = addThumb(student, addFilmstrip(student), 1, { id: "s" });

    student.timers.advance(600);
    student.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 1, enabled: true });
    student.change();
    await student.flush();

    assert.equal(studentThumb.paused, false);
    assert.equal(playListeners(studentThumb), 0);
    assert.equal(childListObservers(student), 0);

    const { h, thumbs } = await classroom({ start: false });

    h.timers.advance(600);
    h.change();
    await h.flush();

    thumbs.forEach(el => {
        assert.equal(el.paused, false);
        assert.equal(playListeners(el), 0);
    });
});
