/*
 * Regression tests: what a STUDENT's browser asks the bridge to forward
 * (deploy/jitsi/custom.js, receive policy, rewriteStudentConstraints).
 *
 *   npm run test:jitsi
 *
 * - A non-moderator receives no camera of another non-moderator: student
 *   cameras are never listed, and everything unlisted gets
 *   defaultConstraints maxHeight 0 (the bridge allocates nothing to a source
 *   whose constraints are disabled).
 * - Moderator cameras (teacher, co-teachers) and every unmuted screen share
 *   (any role) stay listed.
 * - Sources are told apart by SourceInfo videoType and the owner's JWT role;
 *   a source with no SourceInfo is not listed (fails closed).
 * - The last test documents the start-up window: Jitsi's constraints sent
 *   before custom.js wrapped the conference are not rewritten until Jitsi
 *   recomputes them.
 *
 * Runs against the fake Jitsi model in harness.cjs: it checks the receiver
 * constraints handed to lib-jitsi-meet, not what a real bridge forwards.
 * Timers are the harness's fake timers, advanced by hand (no real waiting),
 * and never past the Stage Lock's first run (1 s), so it does not change
 * Jitsi's stage under these tests.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

const STUDENT_VIEW = { type: "SL_STUDENT_VIEW", v: 1, epoch: 1, enabled: true };
const LAST_CONSTRAINTS = "__slLastAppConstraints";

// A student's iframe (local participant not a moderator), before the store
// poll: nothing of custom.js is attached to the store or conference yet.
function studentHarness() {
    const h = createHarness();

    h.participants.local = { id: "me000001", role: "participant", name: "Me" };

    return h;
}

// Store poll (wrapper installed), the page's SL_STUDENT_VIEW, then Jitsi's
// own recompute through the wrapper.
function activate(h) {
    h.timers.advance(600);
    h.change();
    h.postFromParent(STUDENT_VIEW);
    h.change();
}

const selected = h => Array.from(h.lastSent().selectedSources).sort();
const constrained = h => Object.keys(h.lastSent().constraints).sort();

function setShareMuted(h, ownerId, muted) {
    h.participants.remote.get(ownerId).sources.get("video").get(ownerId + "-v1").muted = muted;
}

// Every message sent since `from` lists none of these camera sources and
// forwards nothing unlisted.
function assertNeverReceived(h, from, cameraSources) {
    h.sent.slice(from).forEach((sent, index) => {
        cameraSources.forEach(source => {
            assert.ok(!Array.from(sent.selectedSources).includes(source), "message " + index + " selects " + source);
            assert.ok(!(source in sent.constraints), "message " + index + " constrains " + source);
        });
        assert.equal(sent.defaultConstraints.maxHeight, 0, "message " + index + " forwards unlisted sources");
    });
}

test("mixed room: teacher camera + student share only; no student camera is ever requested", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    ["stud0001", "stud0002", "stud0003"].forEach(id => h.addParticipant(id));
    h.addScreenShare("stud0002");

    activate(h);

    const from = h.sent.indexOf(h.lastSent());

    assert.deepEqual(selected(h), ["stud0002-v1", "teach001-v0"]);
    assert.deepEqual(constrained(h), ["stud0002-v1", "teach001-v0"]);
    assert.equal(h.lastSent().defaultConstraints.maxHeight, 0);
    assert.equal(h.lastSent().lastN, 2);
    // The share has the stage (a student's share comes before the teacher's
    // camera); the teacher's camera is kept at the secondary height.
    assert.deepEqual(Array.from(h.lastSent().onStageSources), ["stud0002-v1"]);
    assert.equal(h.lastSent().constraints["teach001-v0"].maxHeight, 180);

    // More store changes and Jitsi recomputes: still never a student camera.
    h.setCamera("stud0001", false);
    h.change();
    h.setCamera("stud0001", true);
    h.change();
    assertNeverReceived(h, from, ["stud0001-v0", "stud0002-v0", "stud0003-v0"]);
});

test("teacher share and student share: both received, the teacher's share has the stage", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");
    h.addParticipant("stud0002");
    h.addScreenShare("teach001");
    h.addScreenShare("stud0001");

    activate(h);

    assert.deepEqual(selected(h), ["stud0001-v1", "teach001-v0", "teach001-v1"]);
    assert.deepEqual(Array.from(h.lastSent().onStageSources), ["teach001-v1"]);
    assert.equal(h.lastSent().lastN, 3);
    assert.equal(h.lastSent().constraints["stud0001-v1"].maxHeight, 180);
    assert.ok(!("stud0001-v0" in h.lastSent().constraints));
    assert.ok(!("stud0002-v0" in h.lastSent().constraints));
});

test("co-teacher: every moderator's camera is received", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("teach002", { role: "moderator" });
    h.addParticipant("stud0001");

    activate(h);

    assert.deepEqual(selected(h), ["teach001-v0", "teach002-v0"]);
    assert.ok(!("stud0001-v0" in h.lastSent().constraints));
});

test("muted share is not requested; unmuted again it is (custom.js re-applies on its own)", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");
    h.addScreenShare("stud0001");

    activate(h);
    assert.deepEqual(selected(h), ["stud0001-v1", "teach001-v0"]);

    const sentBefore = h.sent.length;

    // No Jitsi recompute: the student-view signature change re-applies.
    setShareMuted(h, "stud0001", true);
    h.change({ recompute: false });
    assert.equal(h.sent.length, sentBefore + 1);
    assert.deepEqual(selected(h), ["teach001-v0"]);
    assert.ok(!("stud0001-v1" in h.lastSent().constraints));

    setShareMuted(h, "stud0001", false);
    h.change({ recompute: false });
    assert.equal(h.sent.length, sentBefore + 2);
    assert.deepEqual(selected(h), ["stud0001-v1", "teach001-v0"]);
});

test("teacher role arriving late: camera blocked until the moderator role, then received", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "participant" });
    h.addParticipant("stud0001");

    activate(h);

    // Not a moderator yet: treated as a student, so not received.
    assert.deepEqual(selected(h), []);
    assert.equal(h.lastSent().defaultConstraints.maxHeight, 0);
    assert.ok(!("teach001-v0" in h.lastSent().constraints));

    h.participants.remote.get("teach001").role = "moderator";
    h.change({ recompute: false });

    assert.deepEqual(selected(h), ["teach001-v0"]);
    assert.ok(!("stud0001-v0" in h.lastSent().constraints));
});

test("a student promoted to moderator: their camera is then received (documents current behaviour)", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");
    h.addParticipant("stud0002");

    activate(h);
    assert.deepEqual(selected(h), ["teach001-v0"]);

    h.participants.remote.get("stud0001").role = "moderator";
    h.change({ recompute: false });

    assert.deepEqual(selected(h), ["stud0001-v0", "teach001-v0"]);
    assert.ok(!("stud0002-v0" in h.lastSent().constraints));
});

test("the local student promoted to moderator: Jitsi's own constraints pass through unchanged", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");

    activate(h);
    assert.equal(h.lastSent().defaultConstraints.maxHeight, 0);

    h.participants.local = { ...h.participants.local, role: "moderator" };
    h.change();

    // Exactly what Jitsi asked for (same object): the student policy is off.
    assert.equal(h.lastSent(), h.conference()[LAST_CONSTRAINTS]);
    assert.equal(h.lastSent().lastN, 5);
    assert.equal(h.lastSent().defaultConstraints.maxHeight, 180);
});

test("a camera without a SourceInfo entry is never requested (fails closed)", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");

    // Tracks exist, presence has no source entry for them (yet).
    h.participants.remote.get("teach001").sources.get("video").delete("teach001-v0");
    h.participants.remote.get("stud0001").sources.get("video").delete("stud0001-v0");

    activate(h);

    assert.deepEqual(selected(h), []);
    assert.deepEqual(constrained(h), []);
    assert.equal(h.lastSent().defaultConstraints.maxHeight, 0);

    // The teacher's SourceInfo arrives: re-applied, received.
    h.participants.remote.get("teach001").sources.get("video")
        .set("teach001-v0", { videoType: "camera", muted: false });
    h.change({ recompute: false });

    assert.deepEqual(selected(h), ["teach001-v0"]);
    assert.ok(!("stud0001-v0" in h.lastSent().constraints));
});

test("audio-only (Jitsi lastN 0): passed through unchanged", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");

    activate(h);
    h.jitsiRecompute({ lastN: 0 });

    assert.equal(h.lastSent(), h.conference()[LAST_CONSTRAINTS]);
    assert.equal(h.lastSent().lastN, 0);
});

// Start-up window (harness model only, see the report): Jitsi's first
// constraints for the conference go out before custom.js's store poll has
// wrapped setReceiverConstraints. Nothing re-sends them through the policy
// until Jitsi recomputes on its own: reapplyReceiveSet needs constraints
// recorded by the wrapper, and there are none yet.
test("start-up window: constraints sent before the wrapper stay in force until Jitsi recomputes", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");
    h.addParticipant("stud0002");

    // Jitsi's own first constraints, before the store poll (unwrapped).
    h.jitsiRecompute();
    assert.equal(h.sent.length, 1);

    // Store poll: wrapper installed, role announced, page asked to resend.
    h.timers.advance(600);
    assert.equal(h.conference()[LAST_CONSTRAINTS], undefined, "nothing recorded by the wrapper yet");
    assert.ok(h.posted.some(message => message && message.type === "SL_RECEIVE_READY"));

    // The page's student view: accepted, but nothing to re-apply.
    h.postFromParent(STUDENT_VIEW);

    // A store change without a Jitsi recompute changes nothing either.
    h.change({ recompute: false });

    assert.equal(h.sent.length, 1, "no constraints sent by custom.js before Jitsi recomputes");
    assert.equal(h.lastSent().lastN, 5);
    assert.equal(h.lastSent().defaultConstraints.maxHeight, 180, "unlisted sources (student cameras) not disabled");

    // Jitsi's next own recompute goes through the wrapper: policy applied.
    h.change();

    assert.equal(h.sent.length, 2);
    assert.deepEqual(selected(h), ["teach001-v0"]);
    assert.equal(h.lastSent().defaultConstraints.maxHeight, 0);
});

// ---- Teacher camera on the student's stage: at least 720p ----------------------------

// Jitsi's own request for one source (its large-video height for the stage).
const jitsiAsks = (h, source, maxHeight) => h.jitsiRecompute({ constraints: { [source]: { maxHeight } } });
const requestedHeight = (h, source) => h.lastSent().constraints[source]?.maxHeight;

function teacherOnStage() {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");
    activate(h);

    return h;
}

test("teacher camera on the stage: Jitsi's 360 (small screen) is raised to 720", () => {
    const h = teacherOnStage();

    jitsiAsks(h, "teach001-v0", 360);

    assert.deepEqual(Array.from(h.lastSent().onStageSources), ["teach001-v0"]);
    assert.equal(requestedHeight(h, "teach001-v0"), 720);
    assert.equal(h.lastSent().defaultConstraints.maxHeight, 0, "student cameras still not forwarded");
    assert.ok(!("stud0001-v0" in h.lastSent().constraints));
});

test("teacher camera on the stage: a larger Jitsi request (1080) is kept, never lowered", () => {
    const h = teacherOnStage();

    jitsiAsks(h, "teach001-v0", 1080);

    assert.equal(requestedHeight(h, "teach001-v0"), 1080);
});

test("teacher camera on the stage: no Jitsi request still gives 720 (unchanged fallback)", () => {
    const h = teacherOnStage();

    h.jitsiRecompute({ constraints: {} });

    assert.equal(requestedHeight(h, "teach001-v0"), 720);
});

test("teacher's screen share on the stage stays adaptive; the teacher camera corner tile stays 180", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addScreenShare("teach001");
    activate(h);
    jitsiAsks(h, "teach001-v1", 360);

    assert.deepEqual(Array.from(h.lastSent().onStageSources), ["teach001-v1"]);
    assert.equal(requestedHeight(h, "teach001-v1"), 360, "share keeps Jitsi's own height");
    assert.equal(requestedHeight(h, "teach001-v0"), 180, "corner tile not raised");
});

test("student's screen share on the stage stays adaptive; the teacher camera corner tile stays 180", () => {
    const h = studentHarness();

    h.addParticipant("teach001", { role: "moderator" });
    h.addParticipant("stud0001");
    h.addScreenShare("stud0001");
    activate(h);
    jitsiAsks(h, "stud0001-v1", 360);

    assert.deepEqual(Array.from(h.lastSent().onStageSources), ["stud0001-v1"]);
    assert.equal(requestedHeight(h, "stud0001-v1"), 360);
    assert.equal(requestedHeight(h, "teach001-v0"), 180);
});

test("the student's own lower video-quality choice in Jitsi is respected", () => {
    const h = teacherOnStage();

    h.state["features/video-quality"] = { preferredVideoQuality: 360 };
    jitsiAsks(h, "teach001-v0", 360);
    assert.equal(requestedHeight(h, "teach001-v0"), 360);

    h.state["features/video-quality"] = { preferredVideoQuality: 180 };
    jitsiAsks(h, "teach001-v0", 180);
    assert.equal(requestedHeight(h, "teach001-v0"), 180);

    // Jitsi's default (no lower choice) and the app's own 720: raised to 720.
    for (const preferredVideoQuality of [2160, 720]) {
        h.state["features/video-quality"] = { preferredVideoQuality };
        jitsiAsks(h, "teach001-v0", 360);
        assert.equal(requestedHeight(h, "teach001-v0"), 720, String(preferredVideoQuality));
    }
});

test("audio-only (lastN 0) with the teacher on the stage: passed through, nothing raised", () => {
    const h = teacherOnStage();

    h.jitsiRecompute({ lastN: 0, constraints: { "teach001-v0": { maxHeight: 360 } } });

    assert.equal(h.lastSent(), h.conference()[LAST_CONSTRAINTS]);
    assert.equal(h.lastSent().lastN, 0);
    assert.equal(requestedHeight(h, "teach001-v0"), 360);
});

test("a teacher (moderator) iframe is not affected: Jitsi's own request passes through", () => {
    const h = createHarness();

    h.participants.local = { id: "teach009", role: "moderator", name: "Teacher" };
    h.addParticipant("teach001", { role: "moderator" });
    activate(h);
    jitsiAsks(h, "teach001-v0", 360);

    assert.equal(requestedHeight(h, "teach001-v0"), 360);
    assert.equal(h.lastSent(), h.conference()[LAST_CONSTRAINTS]);
});
