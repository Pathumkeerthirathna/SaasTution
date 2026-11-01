/*
 * Late `complete` protection (completeRequestedAt): a YouTube `complete`
 * transition whose outcome is unknown (no answer in time) may still be
 * applied by YouTube at any later time. Its broadcast is protected BEFORE the
 * request is sent (teacher-departure stop, Stop, failed-start cleanup), on
 * every row of either feature using it; no start reuses or shares it while
 * protected; only a fresh YouTube answer that it is complete / revoked clears
 * the protection, after which a restart gets a NEW broadcast (an old request
 * names the old broadcast ID only). No time limit. End Session unchanged.
 *
 *   npm run test:youtube
 *
 * Real lifecycle, routes, status syncs, lock and request limits against
 * youtube-fakes.cjs; an unanswered request is a "stalled" YouTube call aborted
 * by the real (shortened) limits. Nothing contacts YouTube or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const fakes = require("./youtube-fakes.cjs");

const {
    TEACHER, LECTURE, db, yt, routes, reset, post, teacherPage, quiet, active, completions, getLiveSnapshot, lectureLib, youtubeRequest
} = fakes;

const root = path.resolve(__dirname, "..", "..");
const lifecycle = require(path.join(root, "lib/youtube-feature-lifecycle.ts"));
const sweep = require(path.join(root, "lib/teacher-departure-sweep.ts"));
const presence = require(path.join(root, "lib/teacher-presence.ts"));
const featureStatePath = path.join(root, "lib/youtube-feature-state.ts");
const featureState = require(featureStatePath);
const { getActiveYouTubeLives } = require(path.join(root, "lib/youtube-live-status.ts"));

// ---- Helpers --------------------------------------------------------------

const liveRow = () => db.lives[db.lives.length - 1];
const recordingRow = () => db.recordings[db.recordings.length - 1];
const sessionOf = () => db.sessions.find(s => s.lectureId === LECTURE && s.isActive);

function resetShort() {
    reset();
    // Unanswered requests fail fast (the real limits, shortened).
    Object.assign(youtubeRequest.youtubeTimeouts, { requestMs: 40, transitionMs: 40 });
}

// YouTube does not answer `complete` (it may still apply it later).
const unanswered = () => yt.stall.add("transition");
const answered = () => yt.stall.delete("transition");

// YouTube applies an earlier `complete` (late) to this broadcast.
const applyLate = id => yt.autoStop(id, new Date());

const startLive = () => quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" }));
const startRecording = () => quiet(() => post(routes.recordingStart, { lectureId: LECTURE, privacy: "unlisted" }));
const stopLive = () => quiet(() => post(routes.liveStop, { lectureId: LECTURE }));
const stopRecording = () => quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));

function assertRefused(result) {
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.equal(result.data.code, "YOUTUBE_COMPLETE_PENDING");
}

const protectedIds = () => [...db.lives, ...db.recordings].filter(r => r.completeRequestedAt).map(r => r.broadcastId);

// The tab closed `agoMs` ago (confirmed), after the features started.
async function departedAgo(agoMs) {
    const closedAt = new Date(Date.now() - agoMs);

    for (const row of [...db.lives, ...db.recordings]) row.createdAt = row.generationStartedAt = new Date(closedAt.getTime() - 60_000);
    sessionOf().teacherCurrentPageId = "page-closed-1";
    await presence.recordTeacherDepartureSignal(sessionOf().id, "page-closed-1", closedAt);
    await presence.registerTeacherPage(sessionOf().id, "page-back-1", new Date());
}

// The departure's next check and its resend cooldown have passed.
function departureTimePassed() {
    for (const row of [...db.lives, ...db.recordings]) {
        if (row.autoStopAttemptedAt) row.autoStopAttemptedAt = new Date(row.autoStopAttemptedAt.getTime() - 61_000);
        if (row.autoStopCheckedAt) row.autoStopCheckedAt = new Date(row.autoStopCheckedAt.getTime() - 61_000);
    }
}

// ---- 1. Departure timeout, late apply, restart -----------------------------------------

test("1. departure `complete` unanswered: protected before sending; a restart after the cooldown is refused; once YouTube shows it ended, a NEW broadcast", async () => {
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));

    const old = liveRow();
    const id = old.broadcastId;

    await departedAgo(20_000);
    unanswered();
    assert.equal((await quiet(() => sweep.sweepDepartedTeachers(new Date())))[0].result.status, "pending");
    assert.ok(old.completeRequestedAt instanceof Date);
    assert.equal(old.autoStopError, "timeout");

    departureTimePassed();
    assertRefused(await startLive());
    assertRefused(await startRecording());
    assert.equal(old.version, 0, "never reused");

    // YouTube applies the old request late; the next start's own lookup sees it.
    answered();
    applyLate(id);

    const restart = await startLive();

    assert.equal(restart.status, 200, JSON.stringify(restart.data));
    assert.notEqual(liveRow().broadcastId, id, "a new broadcast");
    assert.equal(old.status, "COMPLETE");
    assert.equal(old.completeRequestedAt, null, "cleared by the confirmed end");
});

// ---- 2. Manual Stop timeout --------------------------------------------------------------

test("2. Stop's `complete` unanswered, then an immediate Start: refused, the row stays active, the broadcast protected", async () => {
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));

    const row = liveRow();

    unanswered();
    const stop = await stopLive();

    assert.equal(stop.status, 503);
    assert.equal(stop.data.code, "YOUTUBE_TIMEOUT");
    assert.equal(active([row]).length, 1, "not claimed as stopped");
    assert.ok(row.completeRequestedAt instanceof Date, "protected before the request");

    answered();
    assertRefused(await startLive());
    assert.equal(row.version, 0);
});

// ---- 3. Failed-start cleanup timeout -------------------------------------------------------

test("3. failed-start cleanup's `complete` unanswered, then a start: refused", async () => {
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));

    const row = liveRow();

    unanswered();
    const abort = await quiet(() => post(routes.startAbort, { lectureId: LECTURE, feature: "live", rowId: row.id, rowVersion: row.version }));

    assert.equal(abort.status, 503, JSON.stringify(abort.data));
    assert.equal(active([row]).length, 1);
    assert.ok(row.completeRequestedAt instanceof Date);

    answered();
    assertRefused(await startLive());
});

// ---- 4. Shared broadcasts -----------------------------------------------------------------

test("4. the shared paths: a Live never rides a protected Recording broadcast, a Recording never a protected Live one", async () => {
    // Recording protected -> Live (Unlisted) would share it.
    resetShort();
    await quiet(() => teacherPage().record());
    unanswered();
    assert.equal((await stopRecording()).status, 503);
    answered();

    assertRefused(await startLive());
    assert.equal(db.lives.length, 0, "no Live row on the protected broadcast");

    // Live (Unlisted) protected -> Recording would share it.
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    unanswered();
    assert.equal((await stopLive()).status, 503);
    answered();

    assertRefused(await startRecording());
    assert.equal(db.recordings.length, 0);
});

test("4b. both rows of a shared broadcast are protected, and a closed row's protection still counts", async () => {
    resetShort();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));
    assert.equal(recordingRow().broadcastId, liveRow().broadcastId);

    // Live stopped (shared: only its row closes), then the Recording's Stop times out.
    await quiet(() => page.stopLive());
    unanswered();
    assert.equal((await stopRecording()).status, 503);
    answered();

    assert.ok(recordingRow().completeRequestedAt instanceof Date);
    assert.ok(liveRow().completeRequestedAt instanceof Date, "the closed Live row on the broadcast too");

    // A Live start would reactivate the closed Live row on that broadcast: refused.
    assertRefused(await startLive());
    assert.equal(liveRow().status, "COMPLETE");
});

// ---- 5. A new broadcast is immune to the old request ----------------------------------------

test("5. after a confirmed end the restart gets a new broadcast; the old request (old ID) cannot touch it", async () => {
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));

    const oldId = liveRow().broadcastId;

    unanswered();
    await stopLive();
    answered();
    applyLate(oldId);

    assert.equal((await startLive()).status, 200);

    const newId = liveRow().broadcastId;

    assert.notEqual(newId, oldId);

    // The old `complete` arrives again (late) for the OLD id only.
    applyLate(oldId);
    assert.notEqual(yt.broadcasts.get(newId).lifecycle, "complete", "the new broadcast is untouched");
    assert.equal(completions(newId).length, 0);
    assert.equal(active([liveRow()]).length, 1);
    assert.deepEqual(protectedIds(), []);
});

// ---- 6. No time limit; ready / live never clears ---------------------------------------------

test("6. YouTube reporting live much later never clears the protection: no polling path, no start, no time limit", async () => {
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));

    const row = liveRow();

    unanswered();
    await stopLive();
    answered();
    yt.broadcasts.get(row.broadcastId).lifecycle = "live";

    // Days later on the database's own clock: the marker carries no expiry.
    row.completeRequestedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000);

    await quiet(() => getLiveSnapshot(LECTURE, "student"));
    await quiet(() => getLiveSnapshot(LECTURE, "teacher"));
    await quiet(() => getActiveYouTubeLives({ teacherId: TEACHER }));

    assert.ok(row.completeRequestedAt instanceof Date, "a live answer never clears it");
    assertRefused(await startLive());
    assertRefused(await startLive());
});

// ---- 7. A dropped request: recovery ----------------------------------------------------------

test("7. a request YouTube dropped (stays live forever): refused until the teacher's Stop is answered, or YouTube Studio ends it", async () => {
    // The teacher's Stop, answered this time.
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));

    const id = liveRow().broadcastId;

    unanswered();
    await stopLive();
    answered();
    assertRefused(await startLive());

    const stop = await stopLive();

    assert.equal(stop.status, 200, JSON.stringify(stop.data));
    assert.deepEqual(protectedIds(), [], "YouTube's answer confirms the end");
    assert.equal((await startLive()).status, 200);
    assert.notEqual(liveRow().broadcastId, id);

    // Ended in YouTube Studio: a status poll sees it complete and clears it.
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    unanswered();
    await stopLive();
    answered();
    yt.autoStop(liveRow().broadcastId, new Date());
    await quiet(() => getLiveSnapshot(LECTURE, "teacher"));
    assert.deepEqual(protectedIds(), []);
    assert.equal((await startLive()).status, 200);
});

// ---- 8. Concurrent start and stop -------------------------------------------------------------

test("8. a start racing a Stop whose `complete` goes unanswered never reuses the broadcast", async () => {
    for (let round = 0; round < 5; round++) {
        resetShort();
        await quiet(() => teacherPage().goLive("unlisted"));

        const id = liveRow().broadcastId;

        unanswered();
        const [stop, start] = await Promise.all([stopLive(), startLive()]);

        answered();
        assert.ok(stop.status === 503 || stop.status === 409, String(stop.status));
        assert.ok([200, 409].includes(start.status), String(start.status));

        // Whatever ran first: once the request was sent, no start reuses the broadcast.
        if (yt.calls.some(c => c === "stalled:transition")) {
            const again = await startLive();

            assertRefused(again);
        }

        assert.ok(db.lives.filter(r => r.broadcastId === id).every(r => r.version <= 1),
            "the protected broadcast was never taken over after the request");
    }
});

// ---- 9. Durable: generations and process restarts ----------------------------------------------

test("9. the protection survives a new generation's reset and a process restart; only a confirmed end clears it", async () => {
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));

    const row = liveRow();

    assert.equal("completeRequestedAt" in featureState.newFeatureGeneration(new Date()), false, "a new generation never resets it");

    unanswered();
    await stopLive();
    answered();

    // "Restart": fresh modules, the same database.
    delete require.cache[featureStatePath];
    const fresh = require(featureStatePath);

    assert.equal(await fresh.isCompleteRequested(row.broadcastId), true);

    // An ambiguous answer again (another timeout) keeps it.
    unanswered();
    await stopLive();
    answered();
    assert.ok(row.completeRequestedAt instanceof Date);

    // Only YouTube saying it ended clears it.
    yt.autoStop(row.broadcastId, new Date());
    await quiet(() => lectureLib.checkExistingBroadcast("live", row, "enc"));
    assert.equal(await fresh.isCompleteRequested(row.broadcastId), false);
});

// ---- 10. End Session unchanged -----------------------------------------------------------------

test("10. End Session is unchanged: no protection written by its cleanup, and its code is identical to before", async () => {
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    unanswered();

    const result = await quiet(() => lifecycle.endYouTubeFeaturesForLecture(TEACHER, LECTURE));

    answered();
    assert.equal(result.status, "pending");
    assert.equal(liveRow().completeRequestedAt ?? null, null, "End Session does not mark");

    // endFeatureRows / endYouTubeFeaturesForLecture: byte-identical to HEAD's.
    let head;

    try {
        head = require("node:child_process").execSync("git show HEAD:lib/youtube-feature-lifecycle.ts", { cwd: root, encoding: "utf8" });
    } catch {
        return; // not a git checkout: the behavioural check above stands
    }

    const now = fs.readFileSync(path.join(root, "lib/youtube-feature-lifecycle.ts"), "utf8");
    const grab = (text, name) => {
        const i = text.indexOf(name);
        return text.slice(i, text.indexOf("\n}\n", i) + 2).replace(/\r/g, "");
    };

    for (const name of ["async function endFeatureRows", "export async function endYouTubeFeaturesForLecture"]) {
        assert.equal(grab(now, name), grab(head, name), name);
    }
});

// ======================================================================================
// Hardening: only YouTube's own terminal answer about THIS broadcast clears the marker,
// and only after the rows closed.
// ======================================================================================

// YouTube answers `complete` with HTTP success, reporting `lifecycle` (null: no status).
function answerWith(lifecycle) {
    yt.transitionAnswer = id => (lifecycle === null ? { id } : { id, status: { lifeCycleStatus: lifecycle } });
}

const ANSWERS = [
    { lifecycle: "live", confirmed: false },
    { lifecycle: "ready", confirmed: false },
    { lifecycle: null, confirmed: false },
    { lifecycle: "liveStarting", confirmed: false }, // unknown to us as an end
    { lifecycle: "complete", confirmed: true },
    { lifecycle: "revoked", confirmed: true }
];

const label = lifecycle => (lifecycle === null ? "no status" : lifecycle);

for (const [index, { lifecycle, confirmed }] of ANSWERS.entries()) {
    test(`R${index + 1}. HTTP success answering "${label(lifecycle)}": ${confirmed ? "closed and the marker cleared" : "NOT closed, the marker kept, the teacher told it is unconfirmed"} (Stop, failed-start cleanup, departure)`, async () => {
        // Stop.
        resetShort();
        await quiet(() => teacherPage().goLive("unlisted"));
        answerWith(lifecycle);

        const stop = await stopLive();

        if (confirmed) {
            assert.equal(stop.status, 200);
            assert.equal(liveRow().status, "COMPLETE");
        } else {
            assert.equal(stop.status, 503, JSON.stringify(stop.data));
            assert.equal(stop.data.code, "YOUTUBE_STOP_UNCONFIRMED");
            assert.match(stop.data.error, /has not confirmed that the live stream ended/);
            assert.equal(active([liveRow()]).length, 1, "Stop: still active, never reported stopped");
        }
        assert.equal(protectedIds().length === 0, confirmed, "Stop marker");

        // Failed-start cleanup.
        resetShort();
        await quiet(() => teacherPage().goLive("unlisted"));
        answerWith(lifecycle);
        const row = liveRow();
        const abort = await quiet(() => post(routes.startAbort, { lectureId: LECTURE, feature: "live", rowId: row.id, rowVersion: row.version }));

        if (confirmed) {
            assert.equal(abort.data.aborted, true, JSON.stringify(abort.data));
        } else {
            assert.equal(abort.status, 503, JSON.stringify(abort.data));
            assert.equal(abort.data.code, "YOUTUBE_STOP_UNCONFIRMED");
            assert.equal(active([row]).length, 1, "cleanup: still active");
        }
        assert.equal(protectedIds().length === 0, confirmed, "cleanup marker");

        // Departure.
        resetShort();
        await quiet(() => teacherPage().goLive("unlisted"));
        await departedAgo(20_000);
        answerWith(lifecycle);

        const [{ result }] = await quiet(() => sweep.sweepDepartedTeachers(new Date()));

        if (confirmed) {
            assert.equal(result.status, "done");
            assert.equal(liveRow().status, "COMPLETE");
        } else {
            assert.deepEqual(result.pending, [{ feature: "live", reason: "timeout" }], "unconfirmed: pending");
            assert.equal(active([liveRow()]).length, 1, "departure: still active");
            assert.equal(liveRow().stopReason ?? null, null, "never reported stopped");
            assert.match(liveRow().autoStopLastError, /answered without confirming the end/);
        }
        assert.equal(protectedIds().length === 0, confirmed, "departure marker");
    });
}

test("H8. a later fresh lookup confirming complete ends it: the departure closes the row, then clears the marker; a live lookup never does", async () => {
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    await departedAgo(20_000);
    answerWith("live");
    await quiet(() => sweep.sweepDepartedTeachers(new Date()));

    const row = liveRow();

    assert.deepEqual(protectedIds(), [row.broadcastId]);

    // Still live on the next check: kept, nothing resent within the cooldown.
    yt.transitionAnswer = null;
    yt.broadcasts.get(row.broadcastId).lifecycle = "live";
    for (const r of [...db.lives]) r.autoStopCheckedAt = new Date(Date.now() - 20_000);
    await quiet(() => sweep.sweepDepartedTeachers(new Date()));
    assert.deepEqual(protectedIds(), [row.broadcastId], "live: kept");
    assert.equal(active([row]).length, 1);

    // YouTube now reports it complete: closed (as the departure's), then cleared.
    yt.autoStop(row.broadcastId, new Date());
    for (const r of [...db.lives]) r.autoStopCheckedAt = new Date(Date.now() - 60_000);
    await quiet(() => sweep.sweepDepartedTeachers(new Date()));
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.stopReason, "TEACHER_LEFT", "the unconfirmed request was ours (within its window)");
    assert.deepEqual(protectedIds(), []);

    // The same for the teacher's Stop: a later Stop whose lookup sees complete closes and clears.
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    answerWith("live");
    assert.equal((await stopLive()).status, 503);
    yt.transitionAnswer = null;
    yt.autoStop(liveRow().broadcastId, new Date());
    assert.equal((await stopLive()).status, 200);
    assert.equal(liveRow().status, "COMPLETE");
    assert.deepEqual(protectedIds(), []);
});

// Makes the next close of an active Live row fail (a database error).
function failNextClose() {
    const table = fakes.prisma.youTubeLiveBroadcast;
    const saved = table.updateMany;

    table.updateMany = async args => {
        if (args.data?.status === "COMPLETE" || args.data?.status === "REVOKED") {
            table.updateMany = saved;
            throw new Error("database unavailable");
        }
        return saved(args);
    };

    return () => { table.updateMany = saved; };
}

test("H6 + H10. departure lookup path: YouTube reports complete but the row close fails: the marker stays; with the broadcast still live, no start reuses the row", async () => {
    // The lookup path: complete on YouTube, the close fails.
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    await departedAgo(20_000);
    liveRow().completeRequestedAt = new Date(Date.now() - 30_000); // an earlier unconfirmed request
    yt.autoStop(liveRow().broadcastId, new Date());

    let restore = failNextClose();

    try {
        assert.equal((await quiet(() => sweep.sweepDepartedTeachers(new Date())))[0].result.status, "error");
    } finally {
        restore();
    }

    assert.deepEqual(protectedIds(), [liveRow().broadcastId], "not cleared before every row closed");
    assert.equal(active([liveRow()]).length, 1);

    // Still live and unconfirmed (answered "live"), the close never attempted: no start reuses it.
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    await departedAgo(20_000);
    answerWith("live");
    restore = failNextClose();

    try {
        await quiet(() => sweep.sweepDepartedTeachers(new Date()));
    } finally {
        restore();
    }

    yt.transitionAnswer = null;
    departureTimePassed();
    assertRefused(await startLive());
    assert.equal(liveRow().version, 0, "never reused");
});

test("H12. a mismatched transition answer (another broadcast's ID, even one reporting complete) is never a completion: row and marker kept", async () => {
    for (const path of ["stop", "departure"]) {
        resetShort();
        await quiet(() => teacherPage().goLive("unlisted"));
        if (path === "departure") await departedAgo(20_000);
        yt.transitionAnswer = () => ({ id: "bc-someone-else", status: { lifeCycleStatus: "complete" } });

        if (path === "stop") {
            const stop = await stopLive();

            assert.equal(stop.status, 503);
            assert.equal(stop.data.code, "YOUTUBE_STOP_UNCONFIRMED");
        } else {
            await quiet(() => sweep.sweepDepartedTeachers(new Date()));
            assert.match(liveRow().autoStopLastError, /answered about another broadcast/);
        }

        assert.equal(active([liveRow()]).length, 1, path);
        assert.deepEqual(protectedIds(), [liveRow().broadcastId], path);
    }

    // No body at all (null): the same.
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    yt.transitionAnswer = () => null;
    assert.equal((await stopLive()).data.code, "YOUTUBE_STOP_UNCONFIRMED");
    assert.equal(active([liveRow()]).length, 1);
});

test("H13. shared Live / Recording: stopping one feature never calls YouTube; an unconfirmed end of the last one keeps BOTH rows' broadcast protected", async () => {
    resetShort();
    const page = teacherPage();

    await quiet(() => page.record());
    await quiet(() => page.goLive("unlisted"));

    const id = recordingRow().broadcastId;

    assert.equal(liveRow().broadcastId, id);

    // Live stops: shared, only its row closes, no transition.
    await quiet(() => page.stopLive());
    assert.equal(liveRow().status, "COMPLETE");
    assert.equal(completions(id).length, 0);
    assert.deepEqual(protectedIds(), []);

    // Recording (the last) stops: YouTube answers "live": nothing closes, both rows protected.
    answerWith("live");
    assert.equal((await stopRecording()).data.code, "YOUTUBE_STOP_UNCONFIRMED");
    assert.equal(active([recordingRow()]).length, 1);
    assert.deepEqual(protectedIds().sort(), [id, id]);

    // A Live start would share (reactivate the Live row on) the protected broadcast: refused.
    yt.transitionAnswer = null;
    assertRefused(await startLive());
});

test("H6b. departure: even a terminal answer clears nothing when the row close fails (cleared later, after a confirmed close)", async () => {
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    await departedAgo(20_000);
    answerWith("complete");

    const restore = failNextClose();

    try {
        await quiet(() => sweep.sweepDepartedTeachers(new Date()));
    } finally {
        restore();
    }

    assert.deepEqual(protectedIds(), [liveRow().broadcastId]);
    assert.equal(active([liveRow()]).length, 1);
});

test("H7. failed-start cleanup: the close fails (database error, or the row was reused meanwhile): the marker stays", async () => {
    // A database error on the close.
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    answerWith("complete");

    let row = liveRow();
    const restore = failNextClose();

    try {
        const abort = await quiet(() => post(routes.startAbort, { lectureId: LECTURE, feature: "live", rowId: row.id, rowVersion: row.version }));

        assert.notEqual(abort.status, 200);
    } finally {
        restore();
    }
    assert.deepEqual(protectedIds(), [row.broadcastId]);
    assert.equal(active([row]).length, 1);

    // The row is reused while the cleanup asks YouTube: not closed, protection kept.
    resetShort();
    await quiet(() => teacherPage().goLive("unlisted"));
    answerWith("complete");
    row = liveRow();
    yt.getGate = () => {
        yt.getGate = null;
        row.version += 1;
        return null;
    };

    const reused = await quiet(() => post(routes.startAbort, { lectureId: LECTURE, feature: "live", rowId: row.id, rowVersion: row.version }));

    assert.equal(reused.data.reused, true, JSON.stringify(reused.data));
    assert.deepEqual(protectedIds(), [row.broadcastId]);
});

test("H11. End Session keeps its behaviour with the transition's real answer: its rows close as before, no marker written or cleared", async () => {
    for (const answer of ["complete", "live", null]) {
        resetShort();
        await quiet(() => teacherPage().goLive("unlisted"));
        answerWith(answer);

        const result = await quiet(() => lifecycle.endYouTubeFeaturesForLecture(TEACHER, LECTURE));

        assert.equal(result.status, "done", String(answer));
        assert.equal(liveRow().status, "COMPLETE");
        assert.equal(liveRow().completeRequestedAt ?? null, null);
    }
});
