/*
 * Regression tests (version counter, Step 2): the integer row `version` that
 * failed-start cleanup compares instead of `updatedAt`.
 *   - creates start at 0; every reuse / reactivation by a start increments it;
 *   - status syncs (snapshot, dashboard, recording status check), privacy
 *     changes, recording visibility/access changes and the TESTING write never
 *     change it;
 *   - a reuse write never reopens a row closed after it was read (409);
 *   - cleanup closes only the version its start reported; a reused row is
 *     left alone (reused, stopJibri false);
 *   - the Recording visibility/access change during a pending start no longer
 *     looks like a reuse (the regression found in review);
 *   - legacy ISO tokens (pages loaded before the counter) keep the old
 *     updatedAt comparison for one release; unusable tokens are refused (400).
 *
 *   npm run test:youtube
 *
 * Fakes only (tests/youtube/youtube-fakes.cjs). Nothing contacts YouTube,
 * Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");
const {
    TEACHER, LECTURE, db, yt, locks, routes, prisma, lectureLib, getLiveSnapshot,
    reset, post, quiet, created, completions, active
} = fakes;

const root = path.resolve(__dirname, "..", "..");
const lifecycle = require(path.join(root, "lib/youtube-feature-lifecycle.ts"));
const { getActiveYouTubeLives } = require(path.join(root, "lib/youtube-live-status.ts"));
const lectureService = require(path.join(root, "services/lecture-service.ts"));

const liveStart = (privacy = "public") => quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy }));
const recordingStart = () => quiet(() => post(routes.recordingStart, { lectureId: LECTURE }));
const abort = (feature, rowId, rowVersion) =>
    quiet(() => post(routes.startAbort, { lectureId: LECTURE, feature, rowId, ...(rowVersion !== undefined ? { rowVersion } : {}) }));
const liveRow = id => db.lives.find(r => r.id === id);
const recordingRow = id => db.recordings.find(r => r.id === id);

// ===================================================================================
// Increments: creation and every reuse / reactivation by a start
// ===================================================================================

test("a created Live / Recording row starts at version 0 and the start reports it as an integer", async () => {
    reset();

    const live = await liveStart();
    assert.equal(live.status, 200);
    assert.equal(live.data.rowVersion, 0);
    assert.equal(liveRow(live.data.rowId).version, 0);

    reset();
    const recording = await recordingStart();
    assert.equal(recording.data.rowVersion, 0);
    assert.equal(recordingRow(recording.data.rowId).version, 0);
});

test("Live reuse increments the version (also with a privacy change on the reused broadcast)", async () => {
    reset();

    const first = await liveStart("public");
    const reused = await liveStart("public");

    assert.equal(reused.data.ownsRow, false);
    assert.equal(reused.data.rowId, first.data.rowId);
    assert.equal(liveRow(first.data.rowId).version, 1);

    const withPrivacy = await liveStart("unlisted");
    assert.equal(withPrivacy.status, 200);
    assert.equal(liveRow(first.data.rowId).privacy, "UNLISTED");
    assert.ok(liveRow(first.data.rowId).version > 1, "privacy reuse also gets a new version");
});

test("Recording reuse increments the version", async () => {
    reset();

    const first = await recordingStart();
    const reused = await recordingStart();

    assert.equal(reused.data.ownsRow, false);
    assert.equal(recordingRow(first.data.rowId).version, 1);
});

test("shared-broadcast reactivation (upsert) increments the version and reports it", async () => {
    // Live on the recording's broadcast: stopped, then started again.
    reset();
    await recordingStart();
    const live = await liveStart("unlisted");
    assert.equal(live.data.rowVersion, 0);

    await quiet(() => post(routes.liveStop, { lectureId: LECTURE }));
    const again = await liveStart("unlisted");

    assert.equal(again.data.rowId, live.data.rowId, "the same row, reactivated");
    assert.equal(again.data.rowVersion, 1);
    assert.equal(liveRow(live.data.rowId).version, 1);

    // Recording on the Live's broadcast: stopped, then started again.
    reset();
    await liveStart("unlisted");
    const rec = await recordingStart();
    await quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));
    const recAgain = await recordingStart();

    assert.equal(recAgain.data.rowId, rec.data.rowId);
    assert.equal(recAgain.data.rowVersion, 1);
});

// ===================================================================================
// Writes that never change the version
// ===================================================================================

test("status syncs (snapshot, dashboard, recording status check) never change the version", async () => {
    reset();
    const live = await liveStart("public");
    yt.broadcasts.get(live.data.broadcastId).lifecycle = "live";

    await quiet(() => getLiveSnapshot(LECTURE, "student"));
    assert.equal(liveRow(live.data.rowId).status, "LIVE");
    assert.equal(liveRow(live.data.rowId).version, 0);

    reset();
    const live2 = await liveStart("public");
    yt.broadcasts.get(live2.data.broadcastId).lifecycle = "live";
    await quiet(() => getActiveYouTubeLives({ teacherId: TEACHER }));
    assert.equal(liveRow(live2.data.rowId).status, "LIVE");
    assert.equal(liveRow(live2.data.rowId).version, 0);

    reset();
    const rec = await recordingStart();
    yt.broadcasts.get(rec.data.broadcastId).lifecycle = "live";
    await quiet(() => lectureLib.checkYouTubeRecordingStatus(TEACHER, LECTURE));
    assert.equal(recordingRow(rec.data.rowId).status, "LIVE");
    assert.equal(recordingRow(rec.data.rowId).version, 0);
});

test("privacy changes, recording visibility/access changes and the TESTING write never change the version", async () => {
    reset();
    const live = await liveStart("public");
    await quiet(() => lectureLib.updateYouTubeLiveBroadcastPrivacyForTeacher(TEACHER, live.data.rowId, "private", LECTURE));
    assert.equal(liveRow(live.data.rowId).privacy, "PRIVATE");
    assert.equal(liveRow(live.data.rowId).version, 0);

    reset();
    const rec = await recordingStart();
    await lectureService.updateRecordingAccessForTeacher(TEACHER, rec.data.rowId, { visibility: "PUBLIC", access: "FREE" });
    assert.equal(recordingRow(rec.data.rowId).visibility, "PUBLIC");
    assert.equal(recordingRow(rec.data.rowId).version, 0);

    reset();
    db.lives.push({
        id: "live-created", lectureId: LECTURE, broadcastId: "bc-created", videoId: "v", youtubeUrl: "u",
        privacy: "PUBLIC", status: "CREATED", createdAt: fakes.now(), updatedAt: fakes.now(), version: 0,
        startedAt: null, endedAt: null
    });
    yt.broadcasts.set("bc-created", { privacy: "public", lifecycle: "testing", stream: "stream-1" });
    await quiet(() => getActiveYouTubeLives({ teacherId: TEACHER }));
    assert.equal(liveRow("live-created").status, "TESTING");
    assert.equal(liveRow("live-created").version, 0);
});

// ===================================================================================
// Cleanup compares the integer version
// ===================================================================================

test("cleanup with the start's version closes the row; after a reuse it closes nothing and allows no Jibri stop", async () => {
    reset();
    const live = await liveStart("public");
    await liveStart("public");                         // another tab reuses it: version 1

    const stale = await abort("live", live.data.rowId, live.data.rowVersion);
    assert.equal(stale.status, 200);
    assert.deepEqual(
        { aborted: stale.data.aborted, reused: stale.data.reused, stopJibri: stale.data.stopJibri },
        { aborted: false, reused: true, stopJibri: false }
    );
    assert.equal(active(db.lives).length, 1, "the reused row stays active");
    assert.deepEqual(completions(live.data.broadcastId), [], "its broadcast is not completed");

    const current = await abort("live", live.data.rowId, 1);
    assert.equal(current.data.aborted, true);
    assert.equal(liveRow(live.data.rowId).status, "REVOKED");
});

test("REGRESSION: a Recording visibility/access change during a pending start no longer looks like a reuse", async () => {
    reset();
    const rec = await recordingStart();

    // While the start waits for Jibri, the teacher edits the recording's access (lecture panel).
    await lectureService.updateRecordingAccessForTeacher(TEACHER, rec.data.rowId, { access: "FREE" });

    const cleanup = await abort("recording", rec.data.rowId, rec.data.rowVersion);

    assert.equal(cleanup.data.aborted, true, "closed: before the counter this answered reused / stopJibri false");
    assert.notEqual(cleanup.data.reused, true);
    assert.equal(cleanup.data.stopJibri, true);
    assert.equal(recordingRow(rec.data.rowId).status, "REVOKED");
});

// ===================================================================================
// A reuse write never reopens a row closed after it was read
// ===================================================================================

for (const [feature, model, start] of [
    ["live", "youTubeLiveBroadcast", () => liveStart("public")],
    ["recording", "youTubeRecording", () => recordingStart()]
]) {
    test(`a ${feature} reuse whose row was closed after it was read is refused (409) and does not reopen it`, async () => {
        reset();
        const first = await start();
        const rows = feature === "live" ? db.lives : db.recordings;

        // The row is closed between the reuse's read and its write (only possible
        // if the lecture lock were ever bypassed).
        const original = prisma[model].update;
        prisma[model].update = async args => {
            prisma[model].update = original;
            rows.find(r => r.id === first.data.rowId).status = "COMPLETE";
            return original(args);
        };

        try {
            const reuse = await start();

            assert.equal(reuse.status, 409);
            assert.equal(reuse.data.code, "YOUTUBE_FEATURE_CHANGED");
            assert.equal(rows.find(r => r.id === first.data.rowId).status, "COMPLETE", "not reopened");
            assert.equal(rows.find(r => r.id === first.data.rowId).version, 0, "no version written");
            assert.equal(locks.size, 0);
        } finally {
            prisma[model].update = original;
        }
    });
}

// ===================================================================================
// Legacy ISO tokens (one release) and token parsing
// ===================================================================================

test("a legacy ISO token keeps the old updatedAt comparison: unchanged row closed; reused row left alone", async () => {
    reset();
    const live = await liveStart("public");
    const legacy = liveRow(live.data.rowId).updatedAt.toISOString();

    const closed = await abort("live", live.data.rowId, legacy);
    assert.equal(closed.data.aborted, true);

    reset();
    const live2 = await liveStart("public");
    const legacy2 = liveRow(live2.data.rowId).updatedAt.toISOString();
    await liveStart("public");                         // reused: updatedAt changes too

    const stale = await abort("live", live2.data.rowId, legacy2);
    assert.equal(stale.data.reused, true);
    assert.equal(active(db.lives).length, 1);
    assert.deepEqual(completions(live2.data.broadcastId), [], "the reused broadcast is not completed on YouTube");
});

test("defence in depth: the close itself is conditional on the version (a reuse during the cleanup, e.g. a lock overlap, is not closed)", async () => {
    reset();
    const live = await liveStart("public");

    // While the cleanup asks YouTube about the broadcast, another start reuses
    // the row (only possible if the lecture lock were bypassed): version + 1.
    yt.getGate = () => {
        yt.getGate = null;
        const row = liveRow(live.data.rowId);
        row.version += 1;
        return null;
    };

    const cleanup = await abort("live", live.data.rowId, live.data.rowVersion);

    assert.equal(cleanup.data.aborted, false);
    assert.equal(cleanup.data.reused, true);
    assert.equal(cleanup.data.stopJibri, false);
    assert.equal(liveRow(live.data.rowId).status, "READY", "the reused row stays active");
});

test("rowVersion parsing: integers, legacy ISO strings, absent, and unusable values (400)", async () => {
    const parse = lifecycle.parseRowVersionToken;

    assert.deepEqual(parse(0), { kind: "version", value: 0 });
    assert.deepEqual(parse(7), { kind: "version", value: 7 });
    assert.equal(parse(undefined), undefined);
    assert.equal(parse(null), undefined);
    assert.equal(parse(-1), "invalid");
    assert.equal(parse(1.5), "invalid");
    assert.equal(parse("12"), "invalid");
    assert.equal(parse("abc"), "invalid");
    assert.equal(parse({}), "invalid");
    const legacy = parse("2026-10-11T10:00:00.000Z");
    assert.equal(legacy.kind, "legacy-updatedAt");
    assert.equal(legacy.value.toISOString(), "2026-10-11T10:00:00.000Z");

    reset();
    const live = await liveStart("public");
    for (const bad of ["abc", -1, 2.5, "7"]) {
        const response = await abort("live", live.data.rowId, bad);
        assert.equal(response.status, 400, `rowVersion ${JSON.stringify(bad)}`);
    }
    assert.equal(active(db.lives).length, 1, "nothing closed by a refused request");

    // Absent token (pages from before row versions): the earlier behaviour.
    const legacyPage = await abort("live", live.data.rowId);
    assert.equal(legacyPage.data.aborted, true);
    assert.equal(created().length, 1);
});
