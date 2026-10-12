/*
 * Regression tests (Stage 3): broadcast reuse correctness and edge cases for
 * YouTube Recording / Live. Complements shared-broadcast.test.cjs (Stage 2:
 * shared lifecycle) and live-status-privacy.test.cjs (Stage 1).
 *
 *   npm run test:youtube
 *
 * Fakes only (tests/youtube/youtube-fakes.cjs): no YouTube, Jibri or database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    LECTURE, db, yt, jibri, routes, lectureLib, getLiveSnapshot,
    YouTubeReauthorizationRequiredError,
    reset, post, teacherPage, quiet, created, privacyChanges, completions, active
} = require("./youtube-fakes.cjs");

const transient = () => new Error("YouTube API request failed: 503 backendError");

// ---- 1-4: eligible reuse and separate broadcasts -------------------------------

test("1. Recording then Unlisted Live, and 2. Unlisted Live then Recording: one broadcast each way", async () => {
    for (const order of [["record", "unlisted"], ["unlisted", "record"]]) {
        reset();

        await quiet(async () => {
            const page = teacherPage();

            for (const step of order) {
                const { data } = step === "record" ? await page.record() : await page.goLive(step);
                assert.equal(data.success, true, order.join(" -> "));
            }
        });

        assert.deepEqual(created(), ["create:unlisted"], order.join(" -> "));
        assert.equal(db.recordings[0].broadcastId, db.lives[0].broadcastId);
        assert.equal(jibri.starts, 1);
    }
});

test("3./4. PUBLIC or PRIVATE Live then Recording: a separate Unlisted recording broadcast", async () => {
    for (const privacy of ["public", "private"]) {
        reset();

        await quiet(async () => {
            const page = teacherPage();
            await page.goLive(privacy);
            await page.record();
        });

        assert.deepEqual(created(), ["create:" + privacy, "create:unlisted"], privacy);
        assert.notEqual(db.recordings[0].broadcastId, db.lives[0].broadcastId);
        assert.equal(yt.broadcasts.get(db.lives[0].broadcastId).privacy, privacy);
        assert.deepEqual(privacyChanges(), []);
    }
});

// ---- 5: a shared broadcast keeps its privacy -------------------------------------

test("5. a shared broadcast cannot become PUBLIC / PRIVATE via Start Live or the privacy endpoint", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        await page.record();
        await page.goLive("unlisted");

        for (const privacy of ["public", "private"]) {
            const { status, data } = await page.goLive(privacy);

            assert.equal(status, 409, privacy);
            assert.equal(data.code, "YOUTUBE_SHARED_BROADCAST_PRIVACY");
        }

        // The direct API route (PUT /api/lectures/[id]/lives/[liveId]/privacy).
        const response = await routes.livePrivacy.PUT(
            new Request("http://localhost/api", { method: "PUT", body: JSON.stringify({ privacy: "public" }) }),
            { params: { id: LECTURE, liveId: db.lives[0].id } }
        );
        const body = await response.json();

        assert.equal(response.status, 409);
        assert.equal(body.error.code, "YOUTUBE_SHARED_BROADCAST_PRIVACY");
    });

    assert.deepEqual(privacyChanges(), [], "YouTube privacy never touched");
    assert.equal(yt.broadcasts.get(db.lives[0].broadcastId).privacy, "unlisted");
    assert.deepEqual(created(), ["create:unlisted"], "no extra broadcast created instead");
    assert.equal(active(db.lives).length, 1);
});

test("5b. a separate (not shared) Live may still change privacy through the endpoint", async () => {
    reset();

    await quiet(async () => {
        await teacherPage().goLive("unlisted");

        const response = await routes.livePrivacy.PUT(
            new Request("http://localhost/api", { method: "PUT", body: JSON.stringify({ privacy: "public" }) }),
            { params: { id: LECTURE, liveId: db.lives[0].id } }
        );

        assert.equal(response.status, 200);
    });

    assert.equal(yt.broadcasts.get(db.lives[0].broadcastId).privacy, "public");
});

// ---- 6: stale / ineligible broadcasts are never reused --------------------------------

test("6a. a Live row whose broadcast ended (complete / revoked) is not reused, and is closed", async () => {
    for (const lifecycle of ["complete", "revoked"]) {
        reset();

        await quiet(async () => {
            const page = teacherPage();
            await page.goLive("unlisted");
            const old = db.lives[0].broadcastId;

            yt.broadcasts.get(old).lifecycle = lifecycle;

            const { data } = await page.goLive("unlisted");

            assert.notEqual(data.broadcastId, old, lifecycle);
        });

        assert.equal(created().length, 2, lifecycle);
        assert.equal(active(db.lives).length, 1, lifecycle + ": the stale row is closed, not left active");
        assert.equal(db.lives[0].endedAt instanceof Date, true, lifecycle);
    }
});

test("6b. a Recording row whose broadcast ended is not reused (by Recording or by Live) and is closed", async () => {
    for (const next of ["record", "unlisted"]) {
        reset();

        await quiet(async () => {
            const page = teacherPage();
            await page.record();
            yt.broadcasts.get(db.recordings[0].broadcastId).lifecycle = "complete";

            const { data } = next === "record" ? await page.record() : await page.goLive(next);

            assert.equal(data.success, true, next);
            assert.notEqual(data.broadcastId, db.recordings[0].broadcastId, next);
        });

        assert.equal(db.recordings[0].status, "COMPLETE", next + ": stale recording row closed");
    }
});

test("6c. a Live row whose broadcast ended is not reused for Recording, and is closed", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        await page.goLive("unlisted");
        yt.broadcasts.get(db.lives[0].broadcastId).lifecycle = "complete";

        const { data } = await page.record();

        assert.notEqual(data.broadcastId, db.lives[0].broadcastId);
    });

    assert.equal(db.lives[0].status, "COMPLETE");
    assert.equal(db.recordings[0].broadcastId === db.lives[0].broadcastId, false);
});

test("6d. an Unlisted row that is no longer unlisted on YouTube is not shared", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        await page.goLive("unlisted");
        // Changed on YouTube itself (e.g. YouTube Studio).
        yt.broadcasts.get(db.lives[0].broadcastId).privacy = "public";

        const { data } = await page.record();

        assert.notEqual(data.broadcastId, db.lives[0].broadcastId);
    });

    assert.deepEqual(privacyChanges(), []);
});

test("6e. ended rows in the database are never candidates (no YouTube lookup, no reuse)", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        await page.goLive("unlisted");
        await page.stopLive();

        const before = yt.calls.length;
        const { data } = await page.record();

        assert.notEqual(data.broadcastId, db.lives[0].broadcastId);
        assert.equal(yt.calls.slice(before).some(c => c === "get:" + db.lives[0].broadcastId), false);
    });
});

test("6f. a broadcast still changing state (e.g. liveStarting) is neither reused nor duplicated", async () => {
    reset();

    let result;

    await quiet(async () => {
        const page = teacherPage();
        await page.goLive("unlisted");
        yt.broadcasts.get(db.lives[0].broadcastId).lifecycle = "liveStarting";

        result = await page.goLive("unlisted");
    });

    assert.equal(result.status, 409);
    assert.equal(result.data.code, "YOUTUBE_BROADCAST_BUSY");
    assert.equal(created().length, 1, "no duplicate broadcast");
    assert.equal(active(db.lives).length, 1);
});

// ---- 7: YouTube lookup failures --------------------------------------------------

test("7a. a failed lookup of the existing Live does not create a duplicate or change privacy", async () => {
    for (const privacy of ["unlisted", "public"]) {
        reset();

        let result;

        await quiet(async () => {
            const page = teacherPage();
            await page.goLive("unlisted");
            yt.getErrors.set(db.lives[0].broadcastId, transient());

            result = await page.goLive(privacy);
        });

        assert.equal(result.status, 503, privacy);
        assert.equal(result.data.code, "YOUTUBE_BROADCAST_CHECK_FAILED");
        assert.equal(created().length, 1, privacy + ": no duplicate");
        assert.deepEqual(privacyChanges(), [], privacy + ": privacy untouched");
        assert.equal(db.lives.length, 1);
        assert.equal(active(db.lives).length, 1, "the existing Live row is left as it is");
    }
});

test("7b. a failed privacy update of the existing Live does not create a new broadcast instead", async () => {
    reset();

    let result;

    await quiet(async () => {
        const page = teacherPage();
        await page.goLive("unlisted");
        yt.privacyError = transient();

        result = await page.goLive("public");
    });

    assert.equal(result.data.success, false);
    assert.equal(created().length, 1, "no new PUBLIC broadcast created behind the failure");
    assert.equal(db.lives.length, 1);
    assert.equal(db.lives[0].privacy, "UNLISTED", "the row still says what YouTube has");
});

test("7c. a failed lookup of the existing Recording does not create a duplicate recording", async () => {
    reset();

    let result;

    await quiet(async () => {
        const page = teacherPage();
        await page.record();
        yt.getErrors.set(db.recordings[0].broadcastId, transient());

        result = await page.record();
    });

    assert.equal(result.status, 503);
    assert.equal(result.data.code, "YOUTUBE_BROADCAST_CHECK_FAILED");
    assert.equal(created().length, 1);
    assert.equal(db.recordings.length, 1);
});

test("7d. a failed lookup when sharing (either order) does not create a separate broadcast", async () => {
    for (const order of [["record", "unlisted"], ["unlisted", "record"]]) {
        reset();

        let result;

        await quiet(async () => {
            const page = teacherPage();
            order[0] === "record" ? await page.record() : await page.goLive("unlisted");

            const first = (order[0] === "record" ? db.recordings : db.lives)[0].broadcastId;

            yt.getErrors.set(first, transient());
            result = order[1] === "record" ? await page.record() : await page.goLive("unlisted");
        });

        assert.equal(result.status, 503, order.join(" -> "));
        assert.equal(created().length, 1, order.join(" -> ") + ": no separate broadcast");
    }
});

test("7e. a broadcast YouTube no longer knows (not found) is closed and replaced", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        await page.goLive("unlisted");
        yt.broadcasts.delete(db.lives[0].broadcastId);

        const { data } = await page.goLive("unlisted");

        assert.equal(data.success, true);
    });

    assert.equal(created().length, 2);
    assert.equal(db.lives[0].status, "REVOKED");
    assert.equal(active(db.lives).length, 1);
});

test("7f. a YouTube authorization failure during the check still asks the teacher to reconnect", async () => {
    reset();

    let result;

    await quiet(async () => {
        const page = teacherPage();
        await page.goLive("unlisted");
        yt.getErrors.set(db.lives[0].broadcastId, new YouTubeReauthorizationRequiredError("token revoked"));

        result = await page.goLive("unlisted");
    });

    assert.equal(result.status, 401);
    assert.equal(result.data.code, "YOUTUBE_REAUTH_REQUIRED");
    assert.equal(created().length, 1);
});

// ---- 8: repeated starts ----------------------------------------------------------

test("8. repeated starts (each alone and shared) create no duplicates and complete nothing", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();

        for (let i = 0; i < 3; i++) await page.record();
        for (let i = 0; i < 3; i++) await page.goLive("unlisted");
        for (let i = 0; i < 2; i++) await page.record();
    });

    assert.deepEqual(created(), ["create:unlisted"]);
    assert.equal(db.recordings.length, 1);
    assert.equal(db.lives.length, 1);
    assert.deepEqual(completions(db.recordings[0].broadcastId), []);
    assert.equal(jibri.starts, 1);
    assert.equal(active(db.recordings).length + active(db.lives).length, 2);
});

// ---- 9 / 10: Stage 1 and Stage 2 still hold -------------------------------------------

test("9. students: a PRIVATE Live next to a recording is never shown; the shared Unlisted Live is, once live", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        await page.goLive("private");
        await page.record();
    });

    yt.broadcasts.forEach(b => { b.lifecycle = "live"; });
    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), { isLive: false, youtubeUrl: null });

    reset();

    await quiet(async () => {
        const page = teacherPage();
        await page.record();
        await page.goLive("unlisted");
    });

    assert.deepEqual(await getLiveSnapshot(LECTURE, "student"), { isLive: false, youtubeUrl: null }, "ready: not yet");
    yt.broadcasts.forEach(b => { b.lifecycle = "live"; });
    assert.equal((await getLiveSnapshot(LECTURE, "student")).isLive, true);
});

test("10. shared stop semantics unchanged after the new checks", async () => {
    reset();

    await quiet(async () => {
        const page = teacherPage();
        const { data } = await page.record();
        await page.goLive("unlisted");

        const first = await page.stopLive();

        assert.equal(first.broadcastCompleted, false);
        assert.equal(jibri.running, true);

        const last = await page.stopRecording();

        assert.equal(last.broadcastCompleted, true);
        assert.equal(completions(data.broadcastId).length, 1);
        assert.equal(jibri.stops, 1);
    });

    // Lookup helpers still report the relationship from rows.
    const state = await lectureLib.getYouTubeFeatureState(LECTURE);

    assert.equal(state.recording, null);
    assert.equal(state.live, null);
});

// ---- Teacher-facing messages ---------------------------------------------------------

test("refusals are explained to the teacher, not shown as a generic failure", () => {
    const path = require("node:path");
    const { getYoutubeFriendlyErrorMessage } = require(path.join(__dirname, "..", "..", "lib/youtube-error-messages.ts"));
    const generic = getYoutubeFriendlyErrorMessage("some broadcast error", "live", null);

    for (const code of ["YOUTUBE_SHARED_BROADCAST_PRIVACY", "YOUTUBE_BROADCAST_BUSY", "YOUTUBE_BROADCAST_CHECK_FAILED"]) {
        const message = getYoutubeFriendlyErrorMessage("This live stream ...", "live", code);

        assert.notEqual(message, generic, code);
    }

    assert.match(getYoutubeFriendlyErrorMessage("", "live", "YOUTUBE_SHARED_BROADCAST_PRIVACY"), /stays Unlisted/);
});
