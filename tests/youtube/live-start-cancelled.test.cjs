/*
 * Stage 5.7b-2a: a cancelled lecture is never turned LIVE by a YouTube live
 * start (lib/youtube-lecture.ts: assertTeacherCanStartYouTube refuses it
 * before any lock or YouTube call; startYouTubeLectureInternal marks LIVE with
 * a conditional UPDATE that never overwrites a cancellation).
 *
 *   npm run test:youtube
 *
 * Fakes only (tests/youtube/youtube-fakes.cjs): the fake lecture's
 * conditional updateMany applies the WHERE to the row as it is at that moment,
 * as PostgreSQL re-checks it on the newest row version. Not a real-PostgreSQL
 * validation.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fakes = require("./youtube-fakes.cjs");
const { LECTURE, db, yt, prisma, lockAttempts, routes, reset, post, quiet, created } = fakes;

const startLive = () => quiet(() => post(routes.liveStart, { lectureId: LECTURE, privacy: "unlisted" }));

test("live start on a CANCELLED lecture: 409 LECTURE_CANCELLED before any lock or YouTube call; the lecture stays CANCELLED", async () => {
    reset();
    db.lectureClassStatus[LECTURE] = "CANCELLED";
    lockAttempts.length = 0;
    const callsBefore = yt.calls.length;

    const result = await startLive();

    assert.equal(result.status, 409);
    assert.deepEqual([result.data.success, result.data.code], [false, "LECTURE_CANCELLED"]);
    assert.match(result.data.error, /cancelled/i);
    assert.equal(db.lectureClassStatus[LECTURE], "CANCELLED", "never turned LIVE");
    assert.deepEqual(lockAttempts, [], "refused before the YouTube operation locks");
    assert.equal(yt.calls.length, callsBefore, "no YouTube call at all");
    assert.equal(db.lives.length, 0, "no Live row");
});

test("live start on an eligible lecture still works (SCHEDULED, COMPLETED, LIVE → LIVE)", async () => {
    for (const before of [undefined, "COMPLETED", "LIVE"]) {
        reset();
        if (before) db.lectureClassStatus[LECTURE] = before;
        const result = await startLive();
        assert.equal(result.status, 200, `${before ?? "SCHEDULED"}: ${JSON.stringify(result.data)}`);
        assert.equal(result.data.success, true);
        assert.equal(db.lectureClassStatus[LECTURE], "LIVE");
        assert.equal(created().length, 1, "one broadcast created");
    }
});

test("race: a cancellation committed after the pre-checks is not overwritten (the conditional UPDATE refuses; 409, nothing created on YouTube)", async () => {
    reset();
    const original = prisma.lecture.findFirst;
    let reads = 0;
    // The start's second lecture read (startYouTubeLectureInternal) still sees SCHEDULED;
    // the teacher's cancellation commits right after it, before the LIVE write.
    prisma.lecture.findFirst = async (args) => {
        const row = await original(args);
        reads += 1;
        if (reads === 2) db.lectureClassStatus[LECTURE] = "CANCELLED";
        return row;
    };
    let result;
    try {
        result = await startLive();
    } finally {
        prisma.lecture.findFirst = original;
    }

    assert.ok(reads >= 2, "the race point was reached");
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "LECTURE_CANCELLED");
    assert.equal(db.lectureClassStatus[LECTURE], "CANCELLED", "the cancellation wins: never LIVE");
    assert.equal(created().length, 0, "no broadcast created");
    assert.equal(db.lives.length, 0);
});

test("race, other order: a start that marked LIVE first is followed by the cancellation; the lecture ends CANCELLED", async () => {
    reset();
    const result = await startLive();
    assert.equal(result.status, 200);
    assert.equal(db.lectureClassStatus[LECTURE], "LIVE");
    // The cancellation (lecture-service, its own locked transaction) commits afterwards.
    db.lectureClassStatus[LECTURE] = "CANCELLED";
    // A later live start can never revive it.
    const again = await startLive();
    assert.equal(again.status, 409);
    assert.equal(db.lectureClassStatus[LECTURE], "CANCELLED");
});

test("the conditional UPDATE itself: LIVE only while not CANCELLED (and not removed)", async () => {
    reset();
    assert.deepEqual(await prisma.lecture.updateMany({ where: { id: LECTURE, status: 0, classStatus: { not: "CANCELLED" } }, data: { classStatus: "LIVE" } }), { count: 1 });
    db.lectureClassStatus[LECTURE] = "CANCELLED";
    assert.deepEqual(await prisma.lecture.updateMany({ where: { id: LECTURE, status: 0, classStatus: { not: "CANCELLED" } }, data: { classStatus: "LIVE" } }), { count: 0 });
    assert.equal(db.lectureClassStatus[LECTURE], "CANCELLED");

    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "lib", "youtube-lecture.ts"), "utf8");
    assert.match(source, /prisma\.lecture\.updateMany\(\{\s*where: \{ id: lecture\.id, status: 0, classStatus: \{ not: "CANCELLED" \} \},\s*data: \{ classStatus: "LIVE" \},/);
    assert.doesNotMatch(source, /prisma\.lecture\.update\(\{\s*where: \{ id: lecture\.id \},\s*data: \{ classStatus: "LIVE" \}/, "no unconditional LIVE write is left");
});
