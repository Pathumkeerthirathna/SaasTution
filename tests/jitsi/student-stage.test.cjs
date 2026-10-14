/*
 * Regression tests: the student's custom stage in the Jitsi view
 * (deploy/jitsi/custom.js, SL_STAGE_VIEW) and the toolbar it must not cover.
 *
 *   npm run test:jitsi
 *
 * - The stage is mounted in the element that holds Jitsi's toolbar
 *   (#new-toolbox, inside #videoconference_page), BEFORE the toolbar, so the
 *   toolbar paints above it. At <body> level it covered the student's toolbar.
 * - While the teacher's camera is off the stage shows the teacher's profile
 *   card (photo or initials, name, designation, camera-off chip, wording from
 *   the real state), never while the teacher shares the screen, and the live
 *   video again once the camera is back on (after its first frame).
 *
 * Runs against the fake DOM / Jitsi model in harness.cjs, not a real browser:
 * it checks the DOM structure and logic, not the painted result.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const { createHarness } = require("./harness.cjs");

const TEACHER_ID = "teach01";
const TEACHER_JITSI_NAME = "Mr. Pathum Kumara (Teacher)";
const PROFILE = {
    name: "Mr. Pathum Kumara",
    designation: "Combined Maths Instructor",
    photoUrl: "http://localhost:3000/uploads/teachers/t1.jpg",
    jitsiName: TEACHER_JITSI_NAME
};

function find(root, className) {
    for (const el of root.walk()) {
        if (el.classList.contains(className)) {
            return el;
        }
    }

    return null;
}

// Joins as a student; `page: false` leaves out Jitsi's conference page and
// toolbar elements.
function student({ page = true } = {}) {
    const h = createHarness();

    h.participants.local = { id: "stud001", role: "participant", name: "Student" };

    let pageEl = null;
    let toolbarEl = null;

    // Jitsi's DOM: the conference page holds the toolbar (#new-toolbox).
    if (page) {
        pageEl = h.document.createElement("div");
        pageEl.id = "videoconference_page";
        h.document.body.appendChild(pageEl);

        toolbarEl = h.document.createElement("div");
        toolbarEl.id = "new-toolbox";
        toolbarEl.className = "new-toolbox visible";
        pageEl.appendChild(toolbarEl);
    }

    h.timers.advance(600);

    return {
        h,
        pageEl,
        toolbarEl,
        stage: () => h.document.getElementById("sl-custom-stage"),
        video: () => h.document.getElementById("sl-custom-stage").children[0],
        sendStage(teacher = PROFILE) {
            h.postFromParent({ type: "SL_STAGE_VIEW", v: 1, epoch: 1, enabled: true, ...(teacher ? { teacher } : {}) });
        },
        addTeacher({ camera = false, name = TEACHER_JITSI_NAME, id = TEACHER_ID } = {}) {
            h.addParticipant(id, { role: "moderator", camera, name });
            h.change({ recompute: false });
        },
        setTeacherMic(on, id = TEACHER_ID) {
            h.state["features/base/tracks"] = h.state["features/base/tracks"]
                .filter(track => !(track.participantId === id && track.mediaType === "audio"));
            h.state["features/base/tracks"].push({ participantId: id, mediaType: "audio", muted: !on, local: false });
            h.change({ recompute: false });
        },
        setCamera(on, id = TEACHER_ID) {
            h.setCamera(id, on);
            h.change({ recompute: false });
        }
    };
}

function card(stage) {
    return {
        shown: stage.classList.contains("sl-stage-teacher-off"),
        videoHidden: stage.classList.contains("sl-stage-empty"),
        name: find(stage, "sl-stage-teacher-name").textContent,
        role: find(stage, "sl-stage-teacher-role").textContent,
        initials: find(stage, "sl-stage-initials").textContent,
        photo: find(stage, "sl-stage-photo").getAttribute("src"),
        photoLoaded: find(stage, "sl-stage-photo").dataset.loaded,
        chip: find(stage, "sl-stage-chip").children.at(-1).textContent,
        title: find(stage, "sl-stage-teacher-title").textContent,
        text: find(stage, "sl-stage-teacher-text").textContent,
        message: find(stage, "sl-stage-message").textContent
    };
}

// ---- Issue 1: toolbar above the stage ------------------------------------

test("toolbar: the stage is mounted next to Jitsi's toolbar, just BEFORE it", () => {
    const s = student();

    s.addTeacher({ camera: true });
    s.sendStage();

    const siblings = s.pageEl.children;

    assert.equal(s.stage().parentNode, s.toolbarEl.parentNode, "same parent (stacking context) as the toolbar");
    assert.ok(siblings.indexOf(s.stage()) < siblings.indexOf(s.toolbarEl), "before the toolbar in paint order");
    assert.notEqual(s.stage().parentNode, s.h.document.body, "never on <body>");
});

test("toolbar: the student-only body class (toolbar z-index rule) is set and cleared", () => {
    const s = student();

    s.addTeacher({ camera: true });
    s.sendStage();
    assert.ok(s.h.document.body.classList.contains("sl-student-stage-active"));

    s.h.postFromParent({ type: "SL_STAGE_VIEW", v: 1, epoch: 2, enabled: false });
    assert.ok(!s.h.document.body.classList.contains("sl-student-stage-active"));
    assert.equal(s.stage(), null);
});

test("toolbar: the CSS keeps Jitsi's toolbar above the stage for students only", () => {
    const s = student();

    s.addTeacher({ camera: true });
    s.sendStage();

    const css = s.h.document.getElementById("sl-custom-stage-style").textContent;
    const stageZ = Number(/#sl-custom-stage \{[^}]*z-index: (\d+)/.exec(css)[1]);
    const toolbarZ = Number(/body\.sl-student-stage-active #new-toolbox\.new-toolbox \{ z-index: (\d+)/.exec(css)[1]);

    assert.ok(toolbarZ > stageZ, `toolbar ${toolbarZ} above stage ${stageZ}`);
});

test("toolbar: layers() reports the running version and the stage/toolbar order", () => {
    const s = student();

    s.addTeacher({ camera: true });
    s.sendStage();

    const layers = s.h.ctx.__slStageViewTest.layers();

    assert.equal(typeof layers.customJsVersion, "number");
    assert.equal(layers.stageParent, "#videoconference_page");
    assert.equal(layers.toolbarParent, "#videoconference_page");
    assert.equal(layers.sameParent, true);
    assert.equal(layers.stageBeforeToolbar, true);
});

test("toolbar: the stage moves with the toolbar when Jitsi re-renders its page (reconnect)", () => {
    const s = student();

    s.addTeacher({ camera: true });
    s.sendStage();

    s.pageEl.remove();

    const nextPage = s.h.document.createElement("div");
    const nextToolbar = s.h.document.createElement("div");

    nextPage.id = "videoconference_page";
    nextToolbar.id = "new-toolbox";
    nextPage.appendChild(nextToolbar);
    s.h.document.body.appendChild(nextPage);
    s.h.change({ recompute: false });

    assert.equal(s.stage().parentNode, nextPage);
    assert.ok(nextPage.children.indexOf(s.stage()) < nextPage.children.indexOf(nextToolbar));
});

test("toolbar: before Jitsi renders its toolbar the stage waits in the page, then moves before it", () => {
    const s = student();

    s.toolbarEl.remove();
    s.addTeacher({ camera: true });
    s.sendStage();
    assert.equal(s.stage().parentNode, s.pageEl);

    s.pageEl.appendChild(s.toolbarEl);
    s.h.change({ recompute: false });

    assert.ok(s.pageEl.children.indexOf(s.stage()) < s.pageEl.children.indexOf(s.toolbarEl));
});

test("toolbar: without Jitsi's page element the stage still works on <body>", () => {
    const s = student({ page: false });

    s.addTeacher({ camera: true });
    s.sendStage();

    assert.equal(s.stage().parentNode, s.h.document.body);
});

test("toolbar polish for a student: enabled; its control shares the toolbar's parent", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage();
    s.h.postFromParent({ type: "SL_TOOLBAR_VIEW", v: 1, epoch: 1, enabled: true, autoHide: true });

    assert.ok(s.h.document.body.classList.contains("sl-toolbar-polish"));
    assert.ok(!s.h.document.body.classList.contains("sl-toolbar-hidden"), "starts shown");
    assert.equal(s.h.document.getElementById("sl-toolbar-toggle").parentNode, s.toolbarEl.parentNode);
    assert.equal(s.stage().parentNode, s.toolbarEl.parentNode);
});

test("teachers (moderators) never get the student stage or its body class", () => {
    const h = createHarness();

    h.timers.advance(600);
    h.postFromParent({ type: "SL_STAGE_VIEW", v: 1, epoch: 1, enabled: true, teacher: PROFILE });

    assert.equal(h.document.getElementById("sl-custom-stage"), null);
    assert.ok(!h.document.body.classList.contains("sl-student-stage-active"));
});

// ---- Issue 2: camera-off profile card -------------------------------------

test("camera off before class: profile card, 'class will begin shortly'", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage();

    const c = card(s.stage());

    assert.equal(c.shown, true);
    assert.equal(c.videoHidden, true);
    assert.equal(c.name, "Mr. Pathum Kumara");
    assert.equal(c.role, "Combined Maths Instructor");
    assert.equal(c.initials, "PK", "title skipped");
    assert.equal(c.photo, PROFILE.photoUrl);
    assert.equal(c.chip, "Camera off");
    assert.equal(c.title, "Your class will begin shortly");
    assert.equal(c.text, "Please wait while your teacher gets ready.");
    assert.equal(c.message, "", "no plain black-screen message");
});

test("camera off while the teacher's mic is live: says the camera is off, not 'begin shortly'", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.setTeacherMic(true);
    s.sendStage();

    let c = card(s.stage());

    assert.equal(c.title, "Your teacher's camera is off");
    assert.match(c.text, /You can still hear your teacher/);

    s.setTeacherMic(false);
    c = card(s.stage());
    assert.equal(c.title, "Your class will begin shortly");
});

test("camera on -> off: the card says the camera is off (a pause), not 'begin shortly'", () => {
    const s = student();

    s.addTeacher({ camera: true });
    s.sendStage();
    assert.equal(card(s.stage()).shown, false);

    s.setCamera(false);

    const c = card(s.stage());

    assert.equal(c.shown, true);
    assert.equal(c.title, "Your teacher's camera is off");
    assert.match(c.text, /return here automatically/);
});

test("camera back on: the card stays until the first video frame, then the live video", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage();
    assert.equal(card(s.stage()).shown, true);

    s.setCamera(true);

    let c = card(s.stage());

    assert.ok(s.video().srcObject, "teacher camera attached to the stage video");
    assert.equal(c.videoHidden, false, "video uncovered underneath");
    assert.equal(c.shown, true, "card kept until the first frame (no black flash)");

    s.video().dispatchEvent({ type: "loadeddata" });
    c = card(s.stage());
    assert.equal(c.shown, false, "live video");

    s.setCamera(false);
    assert.equal(card(s.stage()).shown, true, "off again: card again");
});

test("camera back on without a first-frame event: the card goes after the wait anyway", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage();
    s.setCamera(true);
    assert.equal(card(s.stage()).shown, true);

    s.h.timers.advance(2000);
    assert.equal(card(s.stage()).shown, false);
});

test("camera turned off again during the first-frame wait: the card stays", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage();
    s.setCamera(true);
    s.setCamera(false);
    s.h.timers.advance(2500);

    assert.equal(card(s.stage()).shown, true);
});

test("screen share: shown instead of the card at once, no first-frame hold", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage();
    assert.equal(card(s.stage()).shown, true);

    s.h.addScreenShare(TEACHER_ID);
    s.h.state["features/base/tracks"].push({
        participantId: TEACHER_ID,
        videoType: "desktop",
        muted: false,
        local: false,
        jitsiTrack: { attach() { return Promise.resolve(); }, detach() {}, getSourceName: () => TEACHER_ID + "-v1" }
    });
    s.h.change({ recompute: false });

    assert.equal(card(s.stage()).shown, false);
});

// ---- Before the teacher joins / after the teacher leaves ------------------

test("student joins before the teacher: profile card with photo, 'Your class will begin shortly'", () => {
    const s = student();

    // No teacher participant, no track: only the profile from the page.
    s.sendStage({ ...PROFILE, photo: new Blob([new Uint8Array(512)], { type: "image/jpeg" }) });

    const c = card(s.stage());

    assert.equal(c.shown, true, "card, not a black screen");
    assert.equal(c.message, "", "no 'Waiting for the teacher's video…'");
    assert.equal(c.name, "Mr. Pathum Kumara");
    assert.equal(c.role, "Combined Maths Instructor");
    assert.match(c.photo, /^blob:/, "the posted photo");
    assert.equal(c.chip, "Camera off");
    assert.equal(c.title, "Your class will begin shortly");
    assert.equal(c.text, "Please wait while your teacher gets ready.");
});

test("before the teacher joins, a missing photo falls back to initials; no profile at all: generic card", () => {
    let s = student();

    s.sendStage({ ...PROFILE, photoUrl: null });
    assert.equal(card(s.stage()).photo, null);
    assert.equal(card(s.stage()).initials, "PK");

    s = student();
    s.sendStage(null);

    const c = card(s.stage());

    assert.equal(c.shown, true);
    assert.equal(c.name, "Your teacher");
    assert.equal(c.initials, "", "teacher icon instead");
    assert.equal(c.title, "Your class will begin shortly");
});

test("teacher joins with the camera off: same card, then camera on -> live video (first frame)", () => {
    const s = student();

    s.sendStage();
    assert.equal(card(s.stage()).title, "Your class will begin shortly");

    // Joined, no camera source yet.
    s.h.participants.remote.set(TEACHER_ID, { id: TEACHER_ID, name: TEACHER_JITSI_NAME, role: "moderator", sources: new Map() });
    s.h.change({ recompute: false });

    let c = card(s.stage());

    assert.equal(c.shown, true);
    assert.equal(c.name, "Mr. Pathum Kumara");

    // Camera source + mic live: the camera-off wording.
    s.h.removeParticipant(TEACHER_ID);
    s.addTeacher({ camera: false });
    s.setTeacherMic(true);
    c = card(s.stage());
    assert.equal(c.title, "Your teacher's camera is off");

    s.setCamera(true);
    assert.ok(s.video().srcObject, "camera attached");
    s.video().dispatchEvent({ type: "loadeddata" });
    assert.equal(card(s.stage()).shown, false, "live video");
});

test("teacher disconnects after joining: profile card with 'stepped away', never a black screen", () => {
    const s = student();

    s.addTeacher({ camera: true });
    s.sendStage();
    assert.equal(card(s.stage()).shown, false, "live");

    s.h.removeParticipant(TEACHER_ID);
    s.h.change({ recompute: false });

    let c = card(s.stage());

    assert.equal(c.shown, true);
    assert.equal(c.message, "");
    assert.equal(c.name, "Mr. Pathum Kumara");
    assert.equal(c.title, "Your teacher has stepped away", "not 'begin shortly' after the class began");
    assert.equal(s.video().srcObject, null, "the gone teacher's video detached");

    // Back with the camera on: live again.
    s.addTeacher({ camera: true });
    s.video().dispatchEvent({ type: "loadeddata" });
    c = card(s.stage());
    assert.equal(c.shown, false);
});

test("teacher who left without ever turning the camera on: 'stepped away' too", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage();
    s.h.removeParticipant(TEACHER_ID);
    s.h.change({ recompute: false });

    assert.equal(card(s.stage()).title, "Your teacher has stepped away");
});

test("screen share keeps precedence: a student's share shows even before the teacher joins", () => {
    const s = student();

    s.h.addParticipant("stud002", { camera: false, name: "Amal" });
    s.sendStage();
    assert.equal(card(s.stage()).shown, true, "card while nobody shares");

    s.h.addScreenShare("stud002");
    s.h.state["features/base/tracks"].push({
        participantId: "stud002",
        videoType: "desktop",
        muted: false,
        local: false,
        jitsiTrack: { attach() { return Promise.resolve(); }, detach() {}, getSourceName: () => "stud002-v1" }
    });
    s.h.change({ recompute: false });

    assert.equal(card(s.stage()).shown, false, "the share, not the card");
});

test("the teacher stage (moderator) is not affected: no student stage, no card", () => {
    const h = createHarness();

    h.timers.advance(600);
    h.postFromParent({ type: "SL_STAGE_VIEW", v: 1, epoch: 1, enabled: true, teacher: PROFILE });

    assert.equal(h.document.getElementById("sl-custom-stage"), null);
});

test("a co-teacher (other Jitsi name) never gets the class teacher's photo or designation", () => {
    const s = student();

    s.addTeacher({ camera: false, id: "co01", name: "Ms. Nimali Perera (Teacher)" });
    s.sendStage();

    const c = card(s.stage());

    assert.equal(c.shown, true);
    assert.equal(c.name, "Ms. Nimali Perera");
    assert.equal(c.role, "Teacher");
    assert.equal(c.initials, "NP");
    assert.equal(c.photo, null);
});

test("a profile without a Jitsi name is never applied to a teacher (no guessing)", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage({ ...PROFILE, jitsiName: "" });

    const c = card(s.stage());

    assert.equal(c.name, "Mr. Pathum Kumara", "from the Jitsi name");
    assert.equal(c.role, "Teacher");
    assert.equal(c.photo, null);
});

test("no profile from the page (older app): initials from the Jitsi name", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage(null);

    const c = card(s.stage());

    assert.equal(c.shown, true);
    assert.equal(c.name, "Mr. Pathum Kumara");
    assert.equal(c.role, "Teacher");
    assert.equal(c.photo, null);
});

test("no usable name: no initials (the teacher icon shows instead)", () => {
    const s = student();

    s.addTeacher({ camera: false, name: "(Teacher)" });
    s.sendStage(null);

    const c = card(s.stage());

    assert.equal(c.initials, "");
    assert.equal(c.name, "Teacher");
});

test("photo: shown only after it loads; foreign origin refused; a broken photo leaves initials", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage({ ...PROFILE, photoUrl: "https://evil.example/x.jpg" });
    assert.equal(card(s.stage()).photo, null);

    s.sendStage(PROFILE);

    const photoEl = find(s.stage(), "sl-stage-photo");

    assert.equal(photoEl.getAttribute("src"), PROFILE.photoUrl);
    assert.equal(photoEl.dataset.loaded, "false", "hidden until loaded");

    photoEl.dispatchEvent({ type: "load" });
    assert.equal(photoEl.dataset.loaded, "true");

    photoEl.dispatchEvent({ type: "error" });
    assert.equal(photoEl.getAttribute("src"), null);
    assert.equal(card(s.stage()).initials, "PK");

    // A later render does not put the broken photo back.
    s.setTeacherMic(true);
    assert.equal(photoEl.getAttribute("src"), null);
});

test("stage-teacher.mjs: builds the SL_STAGE_VIEW teacher field from the join info", async () => {
    const { toStageTeacher, resolveStagePhotoUrl } = await import(pathToFileURL(
        path.join(__dirname, "..", "..", "components", "Jitsi", "stage-teacher.mjs")).href);

    assert.deepEqual(
        toStageTeacher({
            teacherDisplayName: TEACHER_JITSI_NAME,
            teacherProfile: { name: " Mr. Pathum Kumara ", designation: null, photoUrl: "/uploads/teachers/t1.jpg" }
        }, "http://localhost:3000"),
        { name: "Mr. Pathum Kumara", designation: "", photoUrl: PROFILE.photoUrl, jitsiName: TEACHER_JITSI_NAME }
    );

    assert.equal(toStageTeacher({ teacherDisplayName: TEACHER_JITSI_NAME }, "http://localhost:3000"), null);
    assert.equal(resolveStagePhotoUrl(null, "http://localhost:3000"), null);
    assert.equal(resolveStagePhotoUrl("javascript:alert(1)", "http://localhost:3000"), null);
});

// ---- Teacher photo: posted by the page (no cross-origin load) ------------

const photoBlob = (type = "image/jpeg", size = 2048) => new Blob([new Uint8Array(size)], { type });

test("photo posted by the page: shown from an object URL, not loaded across origins", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage({ ...PROFILE, photo: photoBlob() });

    const photoEl = find(s.stage(), "sl-stage-photo");

    assert.match(photoEl.getAttribute("src"), /^blob:/, "object URL, not the http URL");
    assert.equal(photoEl.dataset.loaded, "false", "hidden until it loads");
    assert.equal(s.h.ctx.__slStageViewTest.layers().photoSource, "blob");

    photoEl.dispatchEvent({ type: "load" });
    assert.equal(photoEl.dataset.loaded, "true");
    assert.equal(s.h.ctx.__slStageViewTest.layers().photoState, "loaded");
    assert.equal(card(s.stage()).name, "Mr. Pathum Kumara", "name kept");
    assert.equal(card(s.stage()).role, "Combined Maths Instructor", "designation kept");
});

test("photo arriving after the first stage view (async fetch) replaces the URL attempt", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage(PROFILE);
    assert.equal(find(s.stage(), "sl-stage-photo").getAttribute("src"), PROFILE.photoUrl);

    s.sendStage({ ...PROFILE, photo: photoBlob() });
    assert.match(find(s.stage(), "sl-stage-photo").getAttribute("src"), /^blob:/);
});

test("the same photo resent (SL_RECEIVE_READY) keeps its object URL", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage({ ...PROFILE, photo: photoBlob() });

    const first = find(s.stage(), "sl-stage-photo").getAttribute("src");

    s.sendStage({ ...PROFILE, photo: photoBlob() });
    assert.equal(find(s.stage(), "sl-stage-photo").getAttribute("src"), first);
});

test("a posted non-image or oversized blob is ignored: the photo URL is used instead", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage({ ...PROFILE, photo: photoBlob("text/html") });
    assert.equal(find(s.stage(), "sl-stage-photo").getAttribute("src"), PROFILE.photoUrl);

    s.sendStage({ ...PROFILE, photo: photoBlob("image/png", 6 * 1024 * 1024) });
    assert.equal(find(s.stage(), "sl-stage-photo").getAttribute("src"), PROFILE.photoUrl);
    assert.equal(s.h.ctx.__slStageViewTest.layers().photoSource, "url");
});

test("a posted photo that fails to decode falls back to initials, with a console warning", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage({ ...PROFILE, photo: photoBlob() });

    const photoEl = find(s.stage(), "sl-stage-photo");

    photoEl.dispatchEvent({ type: "error" });
    assert.equal(photoEl.getAttribute("src"), null);
    assert.equal(card(s.stage()).initials, "PK");
    assert.ok(s.h.warnings.some(args => /Teacher photo could not be loaded/.test(String(args[0]))));
});

test("no photo at all: initials, photoSource none", () => {
    const s = student();

    s.addTeacher({ camera: false });
    s.sendStage({ ...PROFILE, photoUrl: null });

    assert.equal(card(s.stage()).photo, null);
    assert.equal(card(s.stage()).initials, "PK");
    assert.equal(s.h.ctx.__slStageViewTest.layers().photoSource, "none");
});

test("a co-teacher never gets the class teacher's posted photo", () => {
    const s = student();

    s.addTeacher({ camera: false, id: "co01", name: "Ms. Nimali Perera (Teacher)" });
    s.sendStage({ ...PROFILE, photo: photoBlob() });

    assert.equal(card(s.stage()).photo, null);
    assert.equal(card(s.stage()).initials, "NP");
});

test("stage-teacher.mjs fetchStagePhoto: same-origin image -> Blob; anything else -> null", async () => {
    const { fetchStagePhoto, STAGE_PHOTO_MAX_BYTES } = await import(pathToFileURL(
        path.join(__dirname, "..", "..", "components", "Jitsi", "stage-teacher.mjs")).href);
    const respond = (blob, ok = true) => async () => ({ ok, blob: async () => blob });
    const calls = [];
    const recording = async (url, init) => {
        calls.push({ url, init });

        return { ok: true, blob: async () => photoBlob() };
    };

    const blob = await fetchStagePhoto("/uploads/teachers/t1.jpg", { fetchImpl: recording });

    assert.ok(blob instanceof Blob);
    assert.equal(calls[0].url, "/uploads/teachers/t1.jpg");
    assert.equal(calls[0].init.credentials, "same-origin", "never sends cookies cross-origin");

    assert.equal(await fetchStagePhoto(null, { fetchImpl: recording }), null);
    assert.equal(await fetchStagePhoto("/x", { fetchImpl: respond(photoBlob(), false) }), null, "404");
    assert.equal(await fetchStagePhoto("/x", { fetchImpl: respond(photoBlob("text/html")) }), null, "not an image");
    assert.equal(await fetchStagePhoto("/x", { fetchImpl: respond(photoBlob("image/jpeg", 0)) }), null, "empty");
    assert.equal(await fetchStagePhoto("/x", { fetchImpl: respond(photoBlob("image/jpeg", STAGE_PHOTO_MAX_BYTES + 1)) }), null, "too big");
    assert.equal(await fetchStagePhoto("/x", { fetchImpl: async () => { throw new Error("offline"); } }), null, "network error");
});
