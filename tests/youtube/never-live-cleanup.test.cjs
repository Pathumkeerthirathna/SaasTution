/*
 * Never-live YouTube broadcasts are removed, not left bound to the teacher's
 * reusable stream (where an auto-start one would go live with a later class).
 *
 *   npm run test:youtube
 *
 * - Guarded deletion: when YouTube refuses to complete a ready / created
 *   broadcast (403 invalidTransition), it is looked up again and deleted only
 *   while still ready / created; its row closes only once YouTube no longer
 *   has it. Stop, failed-start cleanup, End Session (approved) and the
 *   teacher-departure stop (a delete is never a transition).
 * - Pre-start cleanup: before a start creates / binds a broadcast, leftover
 *   never-started SLClassroom broadcasts on THIS teacher's stream that no
 *   active row uses are deleted; anything else is left alone; failures refuse
 *   the start.
 *
 * Real routes, lifecycle, locks and request limits against youtube-fakes.cjs
 * (yt.refuseNeverLiveComplete: YouTube refuses `complete` for a broadcast
 * that never went live). Nothing contacts YouTube or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");

const {
    TEACHER, LECTURE, LECTURE_2, STREAM, db, yt, routes, reset, post, quiet, active, completions, youtubeRequest, locks
} = fakes;

const root = path.resolve(__dirname, "..", "..");
const lifecycle = require(path.join(root, "lib/youtube-feature-lifecycle.ts"));
const sweep = require(path.join(root, "lib/teacher-departure-sweep.ts"));
const presence = require(path.join(root, "lib/teacher-presence.ts"));
// The fake lib/youtube-live.ts module object (the lifecycle calls through it).
const youtubeLive = require(path.join(root, "lib/youtube-live.ts"));

// ---- Helpers --------------------------------------------------------------

const PREFIX = "SLClassroom - ";
const liveRow = () => db.lives[db.lives.length - 1];
const recordingRow = () => db.recordings[db.recordings.length - 1];
const sessionOf = () => db.sessions.find(s => s.lectureId === LECTURE && s.isActive);
const deletes = id => yt.calls.filter(c => (id ? c === "delete:" + id : c.startsWith("delete:")));
const lookups = id => yt.calls.filter(c => c === "get:" + id);
const transitions = () => yt.calls.filter(c => c.startsWith("transition:"));

// YouTube refuses `complete` for never-live broadcasts (as on the real platform).
function resetNeverLive() {
    reset();
    yt.refuseNeverLiveComplete = true;
}

const startLive = (privacy = "unlisted", lectureId = LECTURE) =>
    quiet(() => post(routes.liveStart, { lectureId, privacy }));
const startRecording = (lectureId = LECTURE) => quiet(() => post(routes.recordingStart, { lectureId, privacy: "unlisted" }));
const stopLive = () => quiet(() => post(routes.liveStop, { lectureId: LECTURE }));
const stopRecording = () => quiet(() => post(routes.recordingStop, { lectureId: LECTURE }));
const abort = (feature, row) => quiet(() => post(routes.startAbort, {
    lectureId: LECTURE, feature, rowId: row.id, rowVersion: row.version
}));

// A start whose Jibri never streamed: the broadcast stays ready (auto-start on).
async function neverLiveRecording() {
    const start = await startRecording();

    assert.equal(start.status, 200, JSON.stringify(start.data));

    const row = recordingRow();
    const b = yt.broadcasts.get(row.broadcastId);

    assert.equal(b.lifecycle, "ready");
    assert.equal(b.autoStart, true, "created while the stream was idle: auto-start");
    assert.equal(b.stream, STREAM);
    return row;
}

// Wraps a function of the fake YouTube module for one test.
function around(name, wrapper) {
    const original = youtubeLive[name];

    youtubeLive[name] = (...args) => wrapper(original, ...args);
    return () => { youtubeLive[name] = original; };
}

// After the refused `complete`, YouTube reports `lifecycle` (it started meanwhile).
function startsAfterRefusal(lifecycleStatus) {
    return around("transitionYouTubeLiveBroadcast", async (original, token, id, to) => {
        try {
            return await original(token, id, to);
        } catch (error) {
            if (to === "complete") yt.broadcasts.get(id).lifecycle = lifecycleStatus;
            throw error;
        }
    });
}

// A broadcast on the channel that no start of this test made.
function channelBroadcast(id, fields) {
    yt.broadcasts.set(id, { privacy: "unlisted", lifecycle: "ready", stream: STREAM, description: PREFIX + "Old class", autoStart: true, ...fields });
}

// The tab closed `agoMs` ago (confirmed), after the features started.
async function departedAgo(agoMs) {
    const closedAt = new Date(Date.now() - agoMs);

    for (const row of [...db.lives, ...db.recordings]) row.createdAt = row.generationStartedAt = new Date(closedAt.getTime() - 60_000);
    sessionOf().teacherCurrentPageId = "page-closed-1";
    await presence.recordTeacherDepartureSignal(sessionOf().id, "page-closed-1", closedAt);
    await presence.registerTeacherPage(sessionOf().id, "page-back-1", new Date());
}

// The departure's next check and resend are due.
function departureTimePassed() {
    for (const row of [...db.lives, ...db.recordings]) {
        if (row.autoStopAttemptedAt) row.autoStopAttemptedAt = new Date(row.autoStopAttemptedAt.getTime() - 61_000);
        if (row.autoStopCheckedAt) row.autoStopCheckedAt = new Date(row.autoStopCheckedAt.getTime() - 61_000);
    }
}

const departure = async () => (await quiet(() => sweep.sweepDepartedTeachers(new Date())))[0].result;

// ---- Guarded deletion: failed-start cleanup ---------------------------------------

test("0. the hazard itself: a leftover ready auto-start broadcast bound to the stream starts with the next stream", () => {
    resetNeverLive();
    channelBroadcast("bc-old", {});
    channelBroadcast("bc-new", {});

    assert.deepEqual(yt.startStreaming().sort(), ["bc-new", "bc-old"], "both bound auto-start broadcasts go live");
});

test("1. failed start, never-live: YouTube refuses `complete`; looked up again, deleted ONCE, and the row closes only after the delete", async () => {
    resetNeverLive();
    const row = await neverLiveRecording();
    const id = row.broadcastId;
    let statusAtDelete;
    const restore = around("deleteYouTubeLiveBroadcast", async (original, token, broadcastId) => {
        statusAtDelete = recordingRow().status;
        return original(token, broadcastId);
    });

    let result;

    try {
        result = await abort("recording", row);
    } finally {
        restore();
    }

    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.aborted, true);
    assert.equal(result.data.broadcastCompleted, false, "never went live: not reported as completed");
    assert.equal(statusAtDelete, "READY", "still active while YouTube is asked to delete");
    assert.equal(deletes(id).length, 1, "deleted exactly once");
    assert.ok(!yt.broadcasts.has(id), "gone from the channel");
    assert.equal(row.status, "REVOKED", "closed as before for a failed start");
    assert.ok(lookups(id).length >= 2, "looked up again after the refusal");
    assert.equal(row.completeRequestedAt, null, "deletion confirmed: protection cleared");
    assert.deepEqual(yt.startStreaming(), [], "nothing left to start with a later class");
});

test("2. delete answered 404: already gone; the row closes", async () => {
    resetNeverLive();
    const row = await neverLiveRecording();

    yt.deleteErrors.set(row.broadcastId, yt.apiError(404, "liveBroadcastNotFound"));
    const result = await abort("recording", row);

    assert.equal(result.data.aborted, true, JSON.stringify(result.data));
    assert.equal(row.status, "REVOKED");
    assert.equal(row.completeRequestedAt, null);
});

test("3. delete refused 403 liveBroadcastDeletionNotAllowed: nothing closes (503); the retry looks it up afresh and deletes it", async () => {
    resetNeverLive();
    const row = await neverLiveRecording();
    const id = row.broadcastId;

    yt.deleteErrors.set(id, yt.apiError(403, "liveBroadcastDeletionNotAllowed"));
    const first = await abort("recording", row);

    assert.equal(first.status, 503, JSON.stringify(first.data));
    assert.equal(first.data.code, "YOUTUBE_BROADCAST_CLEANUP_PENDING");
    assert.equal(active([row]).length, 1, "still active (pending)");
    assert.ok(row.completeRequestedAt instanceof Date, "protection kept");
    assert.ok(yt.broadcasts.has(id));

    yt.deleteErrors.clear();
    const lookupsBefore = lookups(id).length;
    const retry = await abort("recording", row);

    assert.equal(retry.data.aborted, true, JSON.stringify(retry.data));
    assert.ok(lookups(id).length > lookupsBefore, "fresh lookups on the retry");
    assert.ok(!yt.broadcasts.has(id));
    assert.equal(row.status, "REVOKED");
});

test("4. delete timed out (applied or not, unknown): nothing closes and the protection stays; the retry resolves it (404 / delete)", async () => {
    for (const applied of [true, false]) {
        resetNeverLive();
        Object.assign(youtubeRequest.youtubeTimeouts, { requestMs: 40 });
        const row = await neverLiveRecording();
        const id = row.broadcastId;

        yt.stall.add("delete");
        yt.deleteAppliedBeforeTimeout = applied;
        const first = await abort("recording", row);

        assert.equal(first.status, 503, JSON.stringify(first.data));
        assert.equal(first.data.code, "YOUTUBE_TIMEOUT");
        assert.equal(active([row]).length, 1, `applied=${applied}: not closed on an unknown outcome`);
        assert.ok(row.completeRequestedAt instanceof Date, "protection kept");

        yt.stall.delete("delete");
        const retry = await abort("recording", row);

        assert.equal(retry.data.aborted, true, JSON.stringify(retry.data));
        assert.equal(row.status, "REVOKED");
        assert.ok(!yt.broadcasts.has(id));
        assert.equal(deletes(id).length, applied ? 1 : 2, applied ? "retry: the fresh lookup finds it gone" : "retry: deleted");
    }
});

for (const lifecycleStatus of ["live", "liveStarting", "testing"]) {
    test(`5-7. the fresh lookup reports "${lifecycleStatus}" (it started meanwhile): NOT deleted, nothing closes, as a Stop YouTube did not complete`, async () => {
        resetNeverLive();
        const row = await neverLiveRecording();
        const restore = startsAfterRefusal(lifecycleStatus);
        let stop;

        try {
            stop = await stopRecording();
        } finally {
            restore();
        }

        assert.equal(stop.status, 503, JSON.stringify(stop.data));
        assert.equal(stop.data.code, "YOUTUBE_BROADCAST_STOP_FAILED", "the existing active-broadcast Stop answer");
        assert.equal(deletes().length, 0, "never deleted");
        assert.equal(active([row]).length, 1);
        assert.ok(yt.broadcasts.has(row.broadcastId));

        // The failed-start cleanup path: the same.
        const restoreAgain = startsAfterRefusal(lifecycleStatus);

        yt.broadcasts.get(row.broadcastId).lifecycle = "ready";
        try {
            assert.equal((await abort("recording", row)).status, 503);
        } finally {
            restoreAgain();
        }
        assert.equal(deletes().length, 0);
        assert.equal(active([row]).length, 1);
    });
}

test("5b. a fresh lookup reporting complete: closed as already ended (no delete)", async () => {
    resetNeverLive();
    const row = await neverLiveRecording();
    const restore = startsAfterRefusal("complete");
    let stop;

    try {
        stop = await stopRecording();
    } finally {
        restore();
    }

    assert.equal(stop.status, 200, JSON.stringify(stop.data));
    assert.equal(deletes().length, 0);
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.completeRequestedAt, null);
});

test("8. a shared broadcast is never deleted: stopping one feature leaves it to the other; only the LAST feature's never-live broadcast is removed", async () => {
    resetNeverLive();
    await neverLiveRecording();
    assert.equal((await startLive("unlisted")).status, 200);

    const id = recordingRow().broadcastId;

    assert.equal(liveRow().broadcastId, id, "shared");

    const stop = await stopLive();

    assert.equal(stop.status, 200, JSON.stringify(stop.data));
    assert.equal(stop.data.sharedWithRecording, true);
    assert.equal(deletes().length, 0, "the Recording still uses it");
    assert.equal(transitions().length, 0);
    assert.ok(yt.broadcasts.has(id));

    // Recording (now the only user) stops: removed.
    assert.equal((await stopRecording()).status, 200);
    assert.equal(deletes(id).length, 1);
    assert.equal(recordingRow().status, "COMPLETE", "Stop closes COMPLETE as before");
});

// ---- Teacher departure ---------------------------------------------------------------

test("9. departure, never-live: the refused `complete` counts once; the delete is NOT a transition; closed with NO stop reason (no 'you left' notice)", async () => {
    resetNeverLive();
    const row = await neverLiveRecording();

    await departedAgo(20_000);
    const result = await departure();

    assert.equal(result.status, "done", JSON.stringify(result));
    assert.equal(transitions().length, 1, "one transition (the refused complete)");
    assert.equal(row.autoStopSendCount, 1, "the delete is not counted");
    assert.equal(deletes(row.broadcastId).length, 1);
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.stopReason ?? null, null, "never went live: not TEACHER_LEFT");
    assert.equal(row.completeRequestedAt, null);

    // After the transition cap, a ready one is still removed (no transition sent).
    resetNeverLive();
    const capped = await neverLiveRecording();

    await departedAgo(20_000);
    capped.autoStopSendCount = lifecycle.DEPARTURE_MAX_TRANSITIONS;
    capped.autoStopAttemptedAt = new Date(Date.now() - 10 * 60_000);
    capped.autoStopCheckedAt = new Date(Date.now() - 10 * 60_000);

    const capResult = await departure();

    assert.equal(capResult.status, "done", JSON.stringify(capResult));
    assert.equal(transitions().length, 0, "no transition beyond the cap");
    assert.equal(deletes(capped.broadcastId).length, 1, "the cap does not apply to the delete");
    assert.equal(capped.autoStopSendCount, lifecycle.DEPARTURE_MAX_TRANSITIONS);
    assert.equal(capped.stopReason ?? null, null);
});

test("10. departure: a failed delete stays pending (not 'timeout', not counted) and is retried by the schedule; an uncertain one resolves via 404", async () => {
    resetNeverLive();
    const row = await neverLiveRecording();
    const id = row.broadcastId;

    await departedAgo(20_000);
    yt.deleteErrors.set(id, yt.apiError(403, "liveBroadcastDeletionNotAllowed"));
    const first = await departure();

    assert.deepEqual(first.pending, [{ feature: "recording", reason: "youtube" }]);
    assert.equal(active([row]).length, 1);
    assert.equal(row.autoStopError, "youtube", "an answer: never the ambiguous 'timeout'");
    assert.match(row.autoStopLastError, /^delete: HTTP 403 liveBroadcastDeletionNotAllowed$/);
    assert.equal(row.autoStopSendCount, 1, "only the transition counted");
    assert.ok(row.completeRequestedAt instanceof Date);

    yt.deleteErrors.clear();
    departureTimePassed();
    const second = await departure();

    assert.equal(second.status, "done", JSON.stringify(second));
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.autoStopSendCount, 2, "the retry's transition counted; its delete not");
    assert.ok(!yt.broadcasts.has(id));

    // Uncertain (timed out, applied): the next check finds it gone.
    resetNeverLive();
    Object.assign(youtubeRequest.youtubeTimeouts, { requestMs: 40 });
    const again = await neverLiveRecording();

    await departedAgo(20_000);
    yt.stall.add("delete");
    yt.deleteAppliedBeforeTimeout = true;
    await departure();
    yt.stall.delete("delete");
    assert.equal(active([again]).length, 1, "not closed on an unknown outcome");
    assert.equal(again.autoStopError, "youtube");

    departureTimePassed();
    await departure();
    assert.equal(again.status, "REVOKED", "not found on the next check: closed");
});

// ---- End Session ---------------------------------------------------------------------

test("11. End Session: a live broadcast is completed exactly as before; a never-live one is deleted; both rows close; the result is unchanged", async () => {
    resetNeverLive();
    await neverLiveRecording();
    assert.equal((await startLive("public")).status, 200);

    const recording = recordingRow();
    const live = liveRow();

    assert.notEqual(live.broadcastId, recording.broadcastId);
    yt.broadcasts.get(live.broadcastId).lifecycle = "live";

    const result = await quiet(() => lifecycle.endYouTubeFeaturesForLecture(TEACHER, LECTURE));

    assert.deepEqual(result, { status: "done", closed: 2 });
    assert.equal(completions(live.broadcastId).length, 1, "the live broadcast: completed");
    assert.equal(deletes(live.broadcastId).length, 0, "a live broadcast is never deleted");
    assert.equal(deletes(recording.broadcastId).length, 1, "the never-live broadcast: deleted");
    assert.equal(live.status, "COMPLETE");
    assert.equal(recording.status, "COMPLETE", "End Session closes COMPLETE as before");
});

test("12. End Session: an uncertain or refused delete does NOT close the row; reported pending (as any unconfirmed broadcast)", async () => {
    resetNeverLive();
    Object.assign(youtubeRequest.youtubeTimeouts, { requestMs: 40 });
    const row = await neverLiveRecording();

    yt.stall.add("delete");
    const timedOut = await quiet(() => lifecycle.endYouTubeFeaturesForLecture(TEACHER, LECTURE));

    assert.equal(timedOut.status, "pending");
    assert.equal(timedOut.reason, "timeout");
    assert.deepEqual(timedOut.pendingBroadcastIds, [row.broadcastId]);
    assert.equal(active([row]).length, 1);

    yt.stall.delete("delete");
    yt.deleteErrors.set(row.broadcastId, yt.apiError(403, "liveBroadcastDeletionNotAllowed"));
    const refused = await quiet(() => lifecycle.endYouTubeFeaturesForLecture(TEACHER, LECTURE));

    assert.equal(refused.status, "pending");
    assert.equal(refused.reason, "youtube");
    assert.equal(active([row]).length, 1);
});

// ---- Pre-start cleanup -------------------------------------------------------------

test("13-15. pre-start cleanup deletes ONLY never-started SLClassroom broadcasts on this teacher's stream that no active row uses", async () => {
    resetNeverLive();
    // An earlier Recording of this lecture, still active (its broadcast ready).
    const kept = await neverLiveRecording();

    channelBroadcast("bc-leftover-ready", {});
    channelBroadcast("bc-leftover-created", { lifecycle: "created" });
    channelBroadcast("bc-other-stream", { stream: "stream-of-someone-else" });
    channelBroadcast("bc-manual", { description: "My own scheduled event" });
    channelBroadcast("bc-no-description", { description: undefined });
    channelBroadcast("bc-testing", { lifecycle: "testing" });
    channelBroadcast("bc-live", { lifecycle: "live" });
    channelBroadcast("bc-almost-prefix", { description: "SLClassroom-Old class" });

    const start = await startLive("public");

    assert.equal(start.status, 200, JSON.stringify(start.data));
    assert.deepEqual(deletes().sort(), ["delete:bc-leftover-created", "delete:bc-leftover-ready"]);

    for (const id of ["bc-other-stream", "bc-manual", "bc-no-description", "bc-testing", "bc-live", "bc-almost-prefix", kept.broadcastId]) {
        assert.ok(yt.broadcasts.has(id), `${id} is left alone`);
    }

    const calls = yt.calls;

    assert.ok(calls.indexOf("list") < calls.findIndex(c => c.startsWith("create:")), "cleaned up before the new broadcast is created");

    // The next stream starts the active Recording's and the new Live's broadcasts, and
    // none of the removed leftovers. (Broadcasts the cleanup deliberately leaves alone,
    // e.g. the teacher's own on this stream, still follow their own auto-start setting.)
    const started = yt.startStreaming();

    assert.ok(started.includes(kept.broadcastId) && started.includes(liveRow().broadcastId));
    assert.ok(!started.includes("bc-leftover-ready") && !started.includes("bc-leftover-created"));
});

test("17. pre-start cleanup failure (list error, list timeout, delete failure) refuses the start: nothing is created or bound", async () => {
    // List refused.
    resetNeverLive();
    yt.listError = yt.apiError(500, "backendError");
    let start = await startLive("public");

    assert.equal(start.status, 503, JSON.stringify(start.data));
    assert.equal(start.data.code, "YOUTUBE_PRESTART_CLEANUP_FAILED");
    assert.equal(fakes.created().length, 0);
    assert.equal(db.lives.length, 0);

    // List timed out.
    resetNeverLive();
    Object.assign(youtubeRequest.youtubeTimeouts, { requestMs: 40 });
    yt.stall.add("list");
    start = await startLive("public");
    assert.equal(start.status, 503);
    assert.equal(start.data.code, "YOUTUBE_TIMEOUT");
    assert.equal(fakes.created().length, 0);

    // A candidate's delete refused: stops there, refuses the start.
    resetNeverLive();
    channelBroadcast("bc-a", {});
    channelBroadcast("bc-b", {});
    yt.deleteErrors.set("bc-a", yt.apiError(403, "liveBroadcastDeletionNotAllowed"));
    start = await startLive("public");
    assert.equal(start.status, 503);
    assert.equal(start.data.code, "YOUTUBE_PRESTART_CLEANUP_FAILED");
    assert.equal(fakes.created().length, 0);
    assert.ok(yt.broadcasts.has("bc-a"));

    // A candidate already gone (404): fine, the start goes ahead.
    resetNeverLive();
    channelBroadcast("bc-gone", {});
    yt.deleteErrors.set("bc-gone", yt.apiError(404, "liveBroadcastNotFound"));
    assert.equal((await startLive("public")).status, 200);
});

test("18. concurrent starts cannot delete each other's new broadcasts: the cleanup runs under the teacher lock; a finished start's broadcast is protected by its row", async () => {
    resetNeverLive();
    let concurrent;

    // While the first start's cleanup lists, another start of the same teacher (other lecture) is refused.
    yt.listHook = async () => {
        yt.listHook = null;
        concurrent = await post(routes.recordingStart, { lectureId: LECTURE_2, privacy: "unlisted" });
    };

    const first = await startLive("public");

    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.data.code, "YOUTUBE_OPERATION_IN_PROGRESS");

    // A later start (Recording, its own broadcast) never deletes the Live's broadcast (ready, active row).
    const liveBroadcast = liveRow().broadcastId;

    assert.equal(yt.broadcasts.get(liveBroadcast).lifecycle, "ready");
    assert.equal((await startRecording()).status, 200);
    assert.equal(deletes(liveBroadcast).length, 0);
    assert.ok(yt.broadcasts.has(liveBroadcast));
    assert.equal(locks.size, 0);
});

// ---- Guards and recovery -----------------------------------------------------------

test("19. generation / version guards: a reused row is never cleaned up by an older start's cleanup, and its broadcast never deleted", async () => {
    resetNeverLive();
    const row = await neverLiveRecording();
    const staleVersion = row.version;

    // Another tab's start reuses the row (a new version).
    assert.equal((await startRecording()).status, 200);
    assert.equal(row.version, staleVersion + 1);

    const result = await quiet(() => post(routes.startAbort, {
        lectureId: LECTURE, feature: "recording", rowId: row.id, rowVersion: staleVersion
    }));

    assert.equal(result.data.reused, true, JSON.stringify(result.data));
    assert.equal(transitions().length, 0);
    assert.equal(deletes().length, 0);
    assert.equal(active([row]).length, 1);
});

test("20. database failure after a successful delete: the row stays; the retry finds the broadcast gone and closes it", async () => {
    resetNeverLive();
    const row = await neverLiveRecording();
    const id = row.broadcastId;
    const table = fakes.prisma.youTubeRecording;
    const updateMany = table.updateMany;

    table.updateMany = async args => {
        if (args?.data?.status === "REVOKED") {
            table.updateMany = updateMany;
            throw new Error("database unavailable");
        }
        return updateMany(args);
    };

    let first;

    try {
        first = await abort("recording", row);
    } finally {
        table.updateMany = updateMany;
    }

    assert.equal(first.status, 500, JSON.stringify(first.data));
    assert.ok(!yt.broadcasts.has(id), "YouTube deleted it");
    assert.equal(active([row]).length, 1, "the close failed");
    assert.ok(row.completeRequestedAt instanceof Date, "not cleared before the row closed");

    const retry = await abort("recording", row);

    assert.equal(retry.data.aborted, true, JSON.stringify(retry.data));
    assert.equal(row.status, "REVOKED");
    assert.equal(deletes(id).length, 1, "not deleted twice");
});

test("21. completeRequestedAt: set before the refused `complete`, kept while the delete is unconfirmed (a start does not reuse it), cleared once deleted", async () => {
    resetNeverLive();
    const row = await neverLiveRecording();

    yt.deleteErrors.set(row.broadcastId, yt.apiError(403, "liveBroadcastDeletionNotAllowed"));
    assert.equal((await stopRecording()).data.code, "YOUTUBE_BROADCAST_CLEANUP_PENDING");
    assert.ok(row.completeRequestedAt instanceof Date);

    // A restart would reuse the still-active row's broadcast: refused while protected.
    const restart = await startRecording();

    assert.equal(restart.status, 409, JSON.stringify(restart.data));
    assert.equal(restart.data.code, "YOUTUBE_COMPLETE_PENDING");

    yt.deleteErrors.clear();
    assert.equal((await stopRecording()).status, 200);
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.completeRequestedAt, null);
    assert.ok(!yt.broadcasts.has(row.broadcastId));
});

// ---- 403 errorStreamInactive: the never-live refusal when the stream never received data -----
//
// When Jibri refuses a start (e.g. all streamers busy), nothing is ever sent to
// the teacher's reusable stream, and YouTube may refuse `complete` for the
// ready broadcast with 403 errorStreamInactive instead of invalidTransition.
// It is the same never-live refusal: the guarded removal applies, with every
// safeguard unchanged (ready / created at the first lookup, a fresh lookup,
// delete only while ready / created).

// YouTube refuses `complete` with 403 `reason` while the broadcast is in one of
// `when`; then (optionally) reports `after` (it started meanwhile).
function refusesCompleteWith(reason, { when = ["ready", "created"], after } = {}) {
    return around("transitionYouTubeLiveBroadcast", async (original, token, id, to) => {
        if (to === "complete" && when.includes(yt.broadcasts.get(id)?.lifecycle)) {
            if (after) yt.broadcasts.get(id).lifecycle = after;
            throw yt.apiError(403, reason);
        }
        return original(token, id, to);
    });
}

test("22. failed start, errorStreamInactive on a ready broadcast: looked up again, deleted ONCE, the row closes (cleanup confirmed)", async () => {
    reset();
    const row = await neverLiveRecording();
    const id = row.broadcastId;
    const restore = refusesCompleteWith("errorStreamInactive");
    let result;

    try {
        result = await abort("recording", row);
    } finally {
        restore();
    }

    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.success, true);
    assert.equal(result.data.aborted, true);
    assert.equal(result.data.broadcastCompleted, false, "never went live: not reported as completed");
    assert.equal(deletes(id).length, 1, "deleted exactly once");
    assert.ok(!yt.broadcasts.has(id), "gone from the channel");
    assert.equal(row.status, "REVOKED", "closed as for any failed start");
    assert.ok(lookups(id).length >= 2, "looked up again after the refusal");
    assert.equal(row.completeRequestedAt, null, "deletion confirmed: protection cleared");
});

for (const lifecycleStatus of ["live", "liveStarting", "testing", "testStarting"]) {
    test(`23. errorStreamInactive, then the fresh lookup reports "${lifecycleStatus}" (it started meanwhile): NOT deleted, nothing closes`, async () => {
        reset();
        const row = await neverLiveRecording();
        const restore = refusesCompleteWith("errorStreamInactive", { after: lifecycleStatus });
        let result;

        try {
            result = await abort("recording", row);
        } finally {
            restore();
        }

        assert.equal(result.status, 503, JSON.stringify(result.data));
        assert.equal(result.data.code, "YOUTUBE_BROADCAST_STOP_FAILED");
        assert.equal(deletes().length, 0, "never deleted");
        assert.equal(active([row]).length, 1, "the row stays active");
        assert.ok(yt.broadcasts.has(row.broadcastId));
    });
}

test("24. errorStreamInactive while the first lookup already reports live: NOT deleted (503), nothing closes", async () => {
    reset();
    const row = await neverLiveRecording();

    yt.broadcasts.get(row.broadcastId).lifecycle = "live";
    const restore = refusesCompleteWith("errorStreamInactive", { when: ["live"] });
    let result;

    try {
        result = await abort("recording", row);
    } finally {
        restore();
    }

    assert.equal(result.status, 503, JSON.stringify(result.data));
    assert.equal(result.data.code, "YOUTUBE_BROADCAST_STOP_FAILED");
    assert.equal(deletes().length, 0, "a started broadcast is never deleted");
    assert.equal(active([row]).length, 1);
    assert.equal(yt.broadcasts.get(row.broadcastId).lifecycle, "live");
});

test("25. any other 403 reason on a ready broadcast is still refused: NOT deleted (503), nothing closes", async () => {
    reset();
    const row = await neverLiveRecording();
    const restore = refusesCompleteWith("errorExecutingTransition");
    let result;

    try {
        result = await abort("recording", row);
    } finally {
        restore();
    }

    assert.equal(result.status, 503, JSON.stringify(result.data));
    assert.equal(result.data.code, "YOUTUBE_BROADCAST_STOP_FAILED");
    assert.equal(deletes().length, 0);
    assert.equal(active([row]).length, 1);
    assert.ok(yt.broadcasts.has(row.broadcastId));
});

test("26. departure, errorStreamInactive on a never-live broadcast: deleted, closed with NO stop reason", async () => {
    reset();
    const row = await neverLiveRecording();
    const restore = refusesCompleteWith("errorStreamInactive");
    let result;

    try {
        await departedAgo(20_000);
        result = await departure();
    } finally {
        restore();
    }

    assert.equal(result.status, "done", JSON.stringify(result));
    assert.equal(deletes(row.broadcastId).length, 1);
    assert.equal(row.status, "COMPLETE");
    assert.equal(row.stopReason ?? null, null, "never went live: not TEACHER_LEFT");
    assert.equal(row.completeRequestedAt, null);
});
