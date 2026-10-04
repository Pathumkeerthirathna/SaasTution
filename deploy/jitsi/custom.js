console.log("======== CUSTOM JS VERSION 1000 ========");


/*
 * SL Classroom pages allowed to embed / talk to this Jitsi iframe.
 * Messages to the parent page are only ever posted to these origins
 * (never "*"), and messages from the parent are only accepted from them.
 */
const SL_ALLOWED_PARENT_ORIGINS = [
    "https://slclassroom.live",
    "https://www.slclassroom.live",
    "http://localhost:3000"
];

function slPostToParent(message) {

    if (!window.parent || window.parent === window) {
        return;
    }

    // Chrome/Safari report the embedding origin; use it when it is allowed.
    const ancestor = window.location.ancestorOrigins?.[0];

    const targets = ancestor
        ? SL_ALLOWED_PARENT_ORIGINS.filter(origin => origin === ancestor)
        : SL_ALLOWED_PARENT_ORIGINS;

    // Without ancestorOrigins (Firefox) each allowed origin is tried; the
    // browser delivers only to the one that matches the parent page.
    targets.forEach(origin => {
        try {
            window.parent.postMessage(message, origin);
        } catch (error) {
            /* not the parent's origin: ignored */
        }
    });
}


/*
 * Student view (Phase 3): the remote video sources a student needs, read
 * from each remote participant's SourceInfo (participant.sources), which
 * comes from presence and is there before any video is received.
 *
 * Sources are told apart by videoType, never by the "-v0"/"-v1" suffix, and
 * the teacher by the Jitsi moderator role (granted from the server-signed
 * JWT), never by display name. Every moderator counts as a teacher. Nothing
 * is cached: source names and participant IDs change on reconnect.
 */
function slCollectStudentViewSources(state) {

    const sources = {
        teacherCameras: [],
        teacherDesktops: [],
        studentDesktops: []
    };

    const participants = state?.["features/base/participants"];
    const remote = participants?.remote;

    if (!remote || typeof remote.entries !== "function") {
        return sources;
    }

    const localId = participants?.local?.id;

    for (const [participantId, participant] of remote.entries()) {

        // Virtual screen-share participants only mirror their owner's source.
        if (!participant || participant.fakeParticipant || participantId === localId) {
            continue;
        }

        const videoSources = participant.sources?.get?.("video");

        if (!videoSources || typeof videoSources.entries !== "function") {
            continue;
        }

        const isModerator = participant.role === "moderator";

        for (const [sourceName, info] of videoSources.entries()) {

            if (typeof sourceName !== "string" || !info) {
                continue;
            }

            const entry = {
                participantId,
                sourceName,
                muted: Boolean(info.muted)
            };

            if (info.videoType === "desktop") {
                (isModerator ? sources.teacherDesktops : sources.studentDesktops).push(entry);
            } else if (info.videoType === "camera" && isModerator) {
                sources.teacherCameras.push(entry);
            }
        }
    }

    return sources;
}

// What a student's stage shows: a teacher screen share, else a student
// screen share, else a teacher camera. Within each group the first one in
// participant order wins, so the choice does not flap between updates.
function slPickStudentStage(sources) {

    const teacherDesktop = sources.teacherDesktops.find(entry => !entry.muted);

    if (teacherDesktop) {
        return { ...teacherDesktop, videoType: "desktop" };
    }

    const studentDesktop = sources.studentDesktops.find(entry => !entry.muted);

    if (studentDesktop) {
        return { ...studentDesktop, videoType: "desktop" };
    }

    const teacherCamera =
        sources.teacherCameras.find(entry => !entry.muted) || sources.teacherCameras[0];

    return teacherCamera ? { ...teacherCamera, videoType: "camera" } : null;
}

window.addEventListener("load", () => {

    const interval = setInterval(() => {

        const header = document.querySelector(".header-container");

        if (!header) {
            return;
        }

        clearInterval(interval);

        // Prevent duplicate button
        if (document.querySelector(".sl-dashboard-btn")) {
            return;
        }

        const button = document.createElement("a");

        button.href = "https://slclassroom.live";

        button.className = "sl-dashboard-btn";

        button.innerText = "Go to Dashboard";

        header.appendChild(button);

    }, 100);

});



setInterval(() => {

    if (!window.APP || !APP.conference)
        return;

    console.log(APP);

}, 3000);


// STEP 1 - Find Jitsi menu items
document.addEventListener(
    "click",
    function (e) {

        const item = e.target.closest('[aria-label="View full screen"]');

        if (!item)
            return;

        console.log("Clicked Full Screen");

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        console.log("Sending Message");

        slPostToParent({
            type: "SL_CLASSROOM_MODE"
        });

        console.log("Message Sent");

    },
    true
);



/* ==========================================================
   Classroom Mode
========================================================== */



/* ==========================================================
   SL Classroom - Moderator Stage Lock
   Keeps the moderator as the main video for remote clients.
   Moderator screen share temporarily becomes the main video.
========================================================== */

(function () {

    const SL_STAGE_LOCK_INTERVAL = 1000;

    function getRemoteModerator() {

        if (!window.APP || !APP.store || !APP.conference) {
            return null;
        }

        const state = APP.store.getState();

        const participants =
            state?.["features/base/participants"]?.remote;

        if (!participants || typeof participants.values !== "function") {
            return null;
        }

        for (const participant of participants.values()) {

            if (participant?.role === "moderator") {
                return participant;
            }

        }

        return null;
    }


    /*
     * Student view (Phase 3): puts a screen share that the moderator check
     * below does not cover (another moderator's, or a student's) on the
     * stage. Returns true when it did, so the moderator camera is not forced
     * back over it. Only ever called for non-moderators (students).
     */
    function enforceDesktopStage(state) {

        const stage = slPickStudentStage(slCollectStudentViewSources(state));

        if (!stage || stage.videoType !== "desktop") {
            return false;
        }

        // In multi-stream Jitsi a screen share is shown through a virtual
        // participant whose ID is the desktop source name; selecting it is
        // what Jitsi's own screen-share auto-pin does.
        const virtualParticipant =
            state?.["features/base/participants"]?.remote?.get?.(stage.sourceName);

        if (virtualParticipant?.fakeParticipant) {

            if (state?.["features/large-video"]?.participantId !== stage.sourceName) {

                console.log(
                    "[SL Classroom] Selecting screen share as Jitsi stage participant:",
                    stage.sourceName
                );

                APP.store.dispatch({
                    type: "SELECT_LARGE_VIDEO_PARTICIPANT",
                    participantId: stage.sourceName
                });
            }

            if (APP.UI.getLargeVideoID() !== stage.sourceName) {
                APP.UI.updateLargeVideo(stage.sourceName);
            }

            return true;
        }

        // No virtual participant (older Jitsi): same call as the moderator
        // screen-share branch below.
        if (APP.UI.getLargeVideoID() !== stage.participantId) {
            APP.UI.updateLargeVideo(stage.participantId, undefined, "desktop");
        }

        return true;
    }


    function enforceModeratorStage() {

        try {

            if (!window.APP || !APP.store || !APP.UI || !APP.conference) {
                return;
            }

            // Do not control the moderator's own screen.
            const localId = APP.conference.getMyUserId();

            const moderator = getRemoteModerator();

            const isLocalStudent =
                APP.store.getState()?.["features/base/participants"]?.local?.role !== "moderator";

            if (!moderator) {

                // No teacher in the room: a student's screen share still
                // takes the stage for the other students.
                if (isLocalStudent) {
                    enforceDesktopStage(APP.store.getState());
                }

                return;
            }

            if (moderator.id === localId) {
                return;
            }

            const moderatorId = moderator.id;

            const state = APP.store.getState();

            /*
             * Check whether the moderator currently has
             * a desktop/screen-share track.
             */
            const tracks = state?.["features/base/tracks"];

            let moderatorScreenSharing = false;

            if (Array.isArray(tracks)) {

                moderatorScreenSharing = tracks.some(track =>
                    track &&
                    track.participantId === moderatorId &&
                    track.videoType === "desktop" &&
                    !track.muted
                );

            }


            const currentLargeVideo = APP.UI.getLargeVideoID();


            /*
             * Students: any active screen share comes before the moderator
             * camera - the moderator's own first, then a student's.
             * enforceDesktopStage selects the screen share's virtual
             * participant, whose large video is the desktop track. The
             * branch below cannot do that: APP.UI.updateLargeVideo() drops
             * its "desktop" argument, so the moderator's ID shows the
             * camera. The moderator's own client never gets here with a
             * change: isLocalStudent is false for it.
             */
            if (isLocalStudent && enforceDesktopStage(state)) {
                return;
            }


            /*
             * Moderator screen share:
             * make the moderator's desktop stream large.
             * (Moderator clients, or a student before the share's
             * SourceInfo has arrived.)
             */
            if (moderatorScreenSharing) {

                if (currentLargeVideo !== moderatorId) {

                    APP.UI.updateLargeVideo(
                        moderatorId,
                        undefined,
                        "desktop"
                    );

                }

                return;
            }


            /*
             * Normal classroom:
             * make the moderator Jitsi's REAL stage participant.
             *
             * APP.UI.updateLargeVideo() below only redraws the large
             * video element; Jitsi builds the receiver constraints
             * (onStageSources / maxHeight) from the redux
             * "features/large-video" participantId instead. Without
             * this, the moderator's camera was requested at the 180p
             * thumbnail height while being displayed large.
             *
             * This is the same action Jitsi's own
             * selectParticipantInLargeVideo() dispatches.
             */
            const stageParticipantId =
                state?.["features/large-video"]?.participantId;

            if (stageParticipantId !== moderatorId) {

                console.log(
                    "[SL Classroom] Selecting moderator as Jitsi stage participant:",
                    moderatorId,
                    "(was:", stageParticipantId, ")"
                );

                APP.store.dispatch({
                    type: "SELECT_LARGE_VIDEO_PARTICIPANT",
                    participantId: moderatorId
                });

            }


            /*
             * Keep moderator camera large.
             */
            if (currentLargeVideo !== moderatorId) {

                APP.UI.updateLargeVideo(
                    moderatorId,
                    undefined,
                    "camera"
                );

            }

        } catch (error) {

            console.warn(
                "[SL Classroom] Moderator stage lock error:",
                error
            );

        }

    }


    /*
     * Start one reusable enforcement loop.
     *
     * This handles participant changes, speaking,
     * chat activity, joins/leaves and other UI changes
     * without needing separate fixes for each event.
     */
    setInterval(
        enforceModeratorStage,
        SL_STAGE_LOCK_INTERVAL
    );


    /*
     * Also try shortly after Jitsi initializes.
     */
    setTimeout(enforceModeratorStage, 1500);
    setTimeout(enforceModeratorStage, 3000);
    setTimeout(enforceModeratorStage, 5000);


    console.log(
        "======== SL CLASSROOM MODERATOR STAGE LOCK ENABLED ========"
    );

})();



/* ==========================================================
   SL Classroom - Receive Policy
   (Phase 1 teacher receive set + Phase 3 student view)

   ONE wrapper around conference.setReceiverConstraints decides
   what this browser receives, by the local Jitsi role:

   Moderator (teacher) - Phase 1 receive set:
     Lets the SL Classroom teacher page choose which students'
     CAMERA video this teacher's browser receives, by Jitsi
     participant ID. Receive-side only: students are never muted
     and their cameras are never touched.

   Student (not a moderator) - Phase 3 student view:
     Receives only the moderators' cameras and the active screen
     shares; every other remote camera is not forwarded by the
     bridge. Receive-side only: the student's own camera is still
     sent to the bridge (the teacher monitors it), and audio is
     not affected (receiver constraints are video only).

   Otherwise (no override enabled): Jitsi's own constraints,
   unchanged.

   Parent page -> iframe:
     { type: "SL_RECEIVE_SET", v: 1, epoch, enabled, participantIds }  (teacher)
     { type: "SL_STUDENT_VIEW", v: 1, epoch, enabled }                 (student)
   iframe -> parent page (asks the parent to send them again):
     { type: "SL_RECEIVE_READY" }

   Jitsi recomputes its receiver constraints on almost every
   state change and sends them with
   conference.setReceiverConstraints(), so a one-off call would
   be overwritten. Instead that method is wrapped once per
   conference object and every call is rewritten while an
   override applies.
========================================================== */

(function () {

    const SL_PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
    const SL_MAX_RECEIVE_SET = 100;
    const SL_CAMERA_MAX_HEIGHT = 360;
    const SL_WRAP_MARKER = "__slReceiveSetWrapped";

    // Student view: the stage source's height when Jitsi's own request gives
    // none, and the height of the other selected sources (not on the stage,
    // so not shown; kept cheap and ready for a quick stage switch).
    const SL_STUDENT_STAGE_FALLBACK_HEIGHT = 720;
    const SL_STUDENT_SECONDARY_MAX_HEIGHT = 180;

    // Per conference object: the local role the parent was last told about,
    // and the last student-view signature applied.
    const SL_ANNOUNCED_ROLE = "__slAnnouncedRole";
    const SL_STUDENT_SIGNATURE = "__slStudentViewSignature";

    let receiveSet = { epoch: 0, enabled: false, participantIds: [] };

    let studentView = { epoch: 0, enabled: false };

    // The last constraints Jitsi itself asked for, kept per conference object
    // so they can be re-run through the wrapper when the receive set changes
    // (and restored as-is when it is turned off). A replaced conference never
    // gets the old conference's constraints.
    const SL_LAST_CONSTRAINTS = "__slLastAppConstraints";

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    function isLocalModerator(state) {
        const local = state?.["features/base/participants"]?.local;

        return local?.role === "moderator";
    }

    function getConference(state) {
        return state?.["features/base/conference"]?.conference ?? null;
    }

    // Camera source of a remote participant, looked up by video type.
    // "-v0" is NOT assumed to be the camera: a student who shares their
    // screen before turning the camera on gets the desktop as "-v0".
    function getCameraSourceName(state, participantId) {
        const remote = state?.["features/base/participants"]?.remote;
        const participant = remote?.get?.(participantId);
        const videoSources = participant?.sources?.get?.("video");

        if (!videoSources) {
            return null;
        }

        for (const [sourceName, info] of videoSources) {
            if (info?.videoType === "camera") {
                return sourceName;
            }
        }

        return null;
    }

    // The single entry point of the wrapper: picks the policy for the local
    // role on every call (the role can arrive after the wrapper is installed).
    function rewriteConstraints(original) {
        const state = getState();

        if (!state) {
            return original;
        }

        if (isLocalModerator(state)) {
            return receiveSet.enabled
                ? rewriteTeacherConstraints(original, state)
                : original;
        }

        return studentView.enabled
            ? rewriteStudentConstraints(original, state)
            : original;
    }

    // Phase 1, unchanged: only the receive set's student cameras.
    function rewriteTeacherConstraints(original, state) {
        const cameraSources = [];

        for (const participantId of receiveSet.participantIds) {
            const sourceName = getCameraSourceName(state, participantId);

            // No camera source yet (camera never turned on): skipped for now.
            // Jitsi recomputes its constraints when the track appears, and
            // that call comes back through here and picks it up.
            if (sourceName && !cameraSources.includes(sourceName)) {
                cameraSources.push(sourceName);
            }
        }

        const constraints = {};

        cameraSources.forEach(sourceName => {
            constraints[sourceName] = { maxHeight: SL_CAMERA_MAX_HEIGHT };
        });

        return {
            ...(original || {}),
            lastN: cameraSources.length,
            defaultConstraints: { maxHeight: 0 },
            constraints,
            selectedSources: cameraSources,
            onStageSources: []
        };
    }

    // The highest maxHeight Jitsi itself asked for: its large-video request,
    // which already honours the student's own video-quality setting.
    function getRequestedStageHeight(original) {
        let height = 0;

        const constraints = original?.constraints;

        if (constraints && typeof constraints === "object") {
            Object.values(constraints).forEach(constraint => {
                const maxHeight = constraint?.maxHeight;

                if (typeof maxHeight === "number" && maxHeight > height) {
                    height = maxHeight;
                }
            });
        }

        return height > 0 ? height : SL_STUDENT_STAGE_FALLBACK_HEIGHT;
    }

    // Phase 3: moderator cameras + active screen shares, nothing else.
    function rewriteStudentConstraints(original, state) {

        if (!original) {
            return original;
        }

        // lastN 0 is Jitsi's audio-only / low-bandwidth mode: no video at
        // all, which is already less than this policy. Left as it is.
        if (original.lastN === 0) {
            return original;
        }

        const sources = slCollectStudentViewSources(state);
        const stage = slPickStudentStage(sources);

        // Moderator cameras are kept even while muted (nothing is sent then),
        // so turning one on needs no new constraints. Screen shares only
        // while active.
        const selectedSources = [];

        const addSource = sourceName => {
            if (!selectedSources.includes(sourceName)) {
                selectedSources.push(sourceName);
            }
        };

        sources.teacherCameras.forEach(entry => addSource(entry.sourceName));
        sources.teacherDesktops.filter(entry => !entry.muted).forEach(entry => addSource(entry.sourceName));
        sources.studentDesktops.filter(entry => !entry.muted).forEach(entry => addSource(entry.sourceName));

        const stageHeight = getRequestedStageHeight(original);
        const secondaryHeight = Math.min(SL_STUDENT_SECONDARY_MAX_HEIGHT, stageHeight);

        const constraints = {};

        selectedSources.forEach(sourceName => {
            constraints[sourceName] = {
                maxHeight: stage && stage.sourceName === sourceName
                    ? stageHeight
                    : secondaryHeight
            };
        });

        // Never more than Jitsi itself allows (its lastN can be lowered for
        // bad connections); -1 / missing means no limit of its own.
        const lastN = typeof original.lastN === "number" && original.lastN > 0
            ? Math.min(original.lastN, selectedSources.length)
            : selectedSources.length;

        // Anything not listed (every student camera) gets maxHeight 0 and is
        // not forwarded by the bridge.
        return {
            ...original,
            lastN,
            defaultConstraints: { maxHeight: 0 },
            constraints,
            selectedSources,
            onStageSources: stage && selectedSources.includes(stage.sourceName)
                ? [stage.sourceName]
                : []
        };
    }

    // What the student policy currently depends on. A change re-applies the
    // constraints, covering changes Jitsi does not recompute on by itself
    // (a moderator role arriving, late SourceInfo, a share being muted).
    function getStudentViewSignature(state) {
        if (!studentView.enabled || isLocalModerator(state)) {
            return "";
        }

        const sources = slCollectStudentViewSources(state);
        const stage = slPickStudentStage(sources);

        return JSON.stringify([
            sources.teacherCameras.map(entry => entry.sourceName),
            sources.teacherDesktops.filter(entry => !entry.muted).map(entry => entry.sourceName),
            sources.studentDesktops.filter(entry => !entry.muted).map(entry => entry.sourceName),
            stage ? stage.sourceName : null
        ]);
    }

    function reapplyReceiveSet() {
        const conference = getConference(getState());

        if (!conference || !conference[SL_WRAP_MARKER] || !conference[SL_LAST_CONSTRAINTS]) {
            return;
        }

        try {
            // Goes through the wrapper below, which applies the receive set.
            conference.setReceiverConstraints(conference[SL_LAST_CONSTRAINTS]);
        } catch (error) {
            console.warn("[SL Classroom] Receive set reapply failed:", error);
        }
    }

    // Asks the SL Classroom page to send its current receive set.
    function announceReady() {
        slPostToParent({ type: "SL_RECEIVE_READY" });
    }

    // Wraps the CURRENT conference's setReceiverConstraints once, for every
    // role: with no override enabled the wrapper passes Jitsi's constraints
    // through untouched. Called on every store change, so a new conference
    // object (reconnect, breakout room switch) gets wrapped too.
    function installReceiveSetWrapper() {
        const state = getState();

        if (!state) {
            return;
        }

        const conference = getConference(state);

        if (!conference || typeof conference.setReceiverConstraints !== "function") {
            return;
        }

        if (!conference[SL_WRAP_MARKER]) {
            const originalSetReceiverConstraints =
                conference.setReceiverConstraints.bind(conference);

            conference.setReceiverConstraints = function (constraints) {
                conference[SL_LAST_CONSTRAINTS] = constraints;

                return originalSetReceiverConstraints(
                    rewriteConstraints(constraints)
                );
            };

            conference[SL_WRAP_MARKER] = true;

            console.log("[SL Classroom] Receive-policy wrapper installed");
        }

        // The parent is asked again whenever the local role changes on this
        // conference (first wrap included): a teacher's moderator role can
        // arrive after joining, and custom.js drops a receive set until then.
        const role = isLocalModerator(state) ? "moderator" : "participant";

        if (conference[SL_ANNOUNCED_ROLE] !== role) {
            conference[SL_ANNOUNCED_ROLE] = role;
            conference[SL_STUDENT_SIGNATURE] = getStudentViewSignature(state);

            reapplyReceiveSet();
            announceReady();

            return;
        }

        // Student view: re-apply when what it selects has changed.
        const signature = getStudentViewSignature(state);

        if (conference[SL_STUDENT_SIGNATURE] !== signature) {
            conference[SL_STUDENT_SIGNATURE] = signature;
            reapplyReceiveSet();
        }
    }

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_STUDENT_VIEW") {
            return;
        }

        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || typeof data.enabled !== "boolean") {
            console.warn("[SL Classroom] Ignored malformed student view", data);

            return;
        }

        // An older message must never overwrite a newer one. The same epoch
        // is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < studentView.epoch) {
            return;
        }

        // Kept even before the local role is known: the policy itself only
        // ever applies while the local participant is not a moderator.
        studentView = {
            epoch: data.epoch,
            enabled: data.enabled
        };

        console.log("[SL Classroom] Student view", studentView);

        installReceiveSetWrapper();
        reapplyReceiveSet();
    });

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_RECEIVE_SET") {
            return;
        }

        const state = getState();

        // Students never take a receive set.
        if (!state || !isLocalModerator(state)) {
            return;
        }

        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || typeof data.enabled !== "boolean"
            || !Array.isArray(data.participantIds)
            || data.participantIds.length > SL_MAX_RECEIVE_SET
            || !data.participantIds.every(id =>
                typeof id === "string" && SL_PARTICIPANT_ID_PATTERN.test(id))) {
            console.warn("[SL Classroom] Ignored malformed receive set", data);

            return;
        }

        // An older message must never overwrite a newer receive set. The
        // same epoch is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < receiveSet.epoch) {
            return;
        }

        receiveSet = {
            epoch: data.epoch,
            enabled: data.enabled,
            participantIds: data.participantIds.slice()
        };

        console.log("[SL Classroom] Receive set", receiveSet);

        installReceiveSetWrapper();
        reapplyReceiveSet();
    });

    // Jitsi's store does not exist yet when this file loads; wait for it,
    // then follow every change to catch the conference being (re)created.
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function") {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(installReceiveSetWrapper);
        installReceiveSetWrapper();
    }, 500);

})();



/* ==========================================================
   SL Classroom - Teacher Monitoring Grid (Phase 2)

   Display only. Shows the student camera tracks this teacher's
   browser is ALREADY receiving (chosen by the Teacher Receive Set
   above) in a responsive grid over the meeting. Nothing new is
   connected, subscribed, copied or re-encoded: each tile attaches
   the existing received JitsiTrack to one more <video> element.

   Runs ONLY when the local participant is a moderator (the
   teacher). Students never get the grid.

   Parent page -> iframe (resent by the parent after
   SL_RECEIVE_READY):
     { type: "SL_MONITOR_VIEW", v: 1, epoch, enabled, participantIds }
========================================================== */

(function () {

    const SL_PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
    const SL_MAX_MONITOR_TILES = 100;
    const SL_TILE_ASPECT = 16 / 9;
    const SL_TILE_GAP = 8;
    // On <body> exactly while the grid is visible; hides Jitsi's filmstrip.
    const SL_MONITOR_ACTIVE_CLASS = "sl-monitor-active";

    let monitorView = { epoch: 0, enabled: false, participantIds: [] };

    let root = null;
    let gridEl = null;
    let labelEl = null;

    // participantId -> { el, video, nameEl, stateEl, jitsiTrack }
    const tiles = new Map();

    // Stable keys for track objects, so a replaced track is noticed.
    const trackKeys = new WeakMap();
    let nextTrackKey = 1;
    let lastSignature = "";

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    function isLocalModerator(state) {
        return state?.["features/base/participants"]?.local?.role === "moderator";
    }

    function trackKey(jitsiTrack) {
        if (!jitsiTrack) {
            return 0;
        }

        if (!trackKeys.has(jitsiTrack)) {
            trackKeys.set(jitsiTrack, nextTrackKey++);
        }

        return trackKeys.get(jitsiTrack);
    }

    // The participant's received CAMERA track (never a screen share), found
    // by video type like the receive set does.
    function findCameraTrack(state, participantId) {
        const tracks = state?.["features/base/tracks"];

        if (!Array.isArray(tracks)) {
            return null;
        }

        return tracks.find(track =>
            track
            && !track.local
            && track.participantId === participantId
            && track.videoType === "camera"
            && track.jitsiTrack
        ) || null;
    }

    function injectStyles() {
        if (document.getElementById("sl-monitor-style")) {
            return;
        }

        const style = document.createElement("style");

        style.id = "sl-monitor-style";

        // z-index 200 (Jitsi 9268 all.css / app bundle): above the large video
        // (1), below the toolbar (.new-toolbox 252), chat (300), dialogs (301),
        // drawers (351) and notifications (600/901), so Jitsi's controls stay
        // usable. Jitsi's filmstrip is fixed at 251 (above the grid), so while
        // the grid is visible it is hidden with visibility only: Jitsi's own
        // layout and filmstrip/self-view settings are untouched, and removing
        // the body class brings it back exactly as it was. Bottom padding
        // keeps tiles clear of the toolbar.
        style.textContent = [
            "body." + SL_MONITOR_ACTIVE_CLASS + " .filmstrip, body." + SL_MONITOR_ACTIVE_CLASS + " .filmstrip * { visibility: hidden !important; }",
            "#sl-monitor-root { position: fixed; inset: 0; z-index: 200; display: none; box-sizing: border-box; padding: 44px 12px 96px; background: #0B1220; }",
            "#sl-monitor-root.sl-visible { display: block; }",
            "#sl-monitor-root .sl-monitor-label { position: absolute; top: 10px; left: 12px; padding: 4px 10px; border-radius: 999px; background: rgba(77, 108, 144, 0.92); color: #FFFFFF; font-size: 12px; font-weight: 600; }",
            "#sl-monitor-root .sl-monitor-grid { width: 100%; height: 100%; display: flex; flex-wrap: wrap; align-content: center; justify-content: center; gap: " + SL_TILE_GAP + "px; }",
            "#sl-monitor-root .sl-monitor-tile { position: relative; flex: 0 0 auto; box-sizing: border-box; overflow: hidden; border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.25); background: #111827; }",
            "#sl-monitor-root .sl-monitor-tile video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000000; }",
            "#sl-monitor-root .sl-monitor-name { position: absolute; left: 8px; bottom: 8px; max-width: calc(100% - 16px); padding: 3px 8px; border-radius: 6px; background: rgba(15, 23, 42, 0.78); color: #F8FAFC; font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
            "#sl-monitor-root .sl-monitor-state { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; padding: 8px; color: #94A3B8; font-size: 13px; text-align: center; }",
            "#sl-monitor-root .sl-monitor-tile.sl-no-video video { visibility: hidden; }",
            "#sl-monitor-root .sl-monitor-tile.sl-no-video .sl-monitor-state { display: flex; }",
            "#sl-monitor-root .sl-monitor-empty { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; padding: 16px; color: #94A3B8; font-size: 14px; text-align: center; }",
            "#sl-monitor-root.sl-empty .sl-monitor-empty { display: flex; }",
            "@media (max-width: 640px) { #sl-monitor-root { padding: 40px 8px 84px; } }"
        ].join("\n");

        document.head.appendChild(style);
    }

    function ensureRoot() {
        if (root) {
            return;
        }

        injectStyles();

        root = document.createElement("div");
        root.id = "sl-monitor-root";

        labelEl = document.createElement("div");
        labelEl.className = "sl-monitor-label";

        gridEl = document.createElement("div");
        gridEl.className = "sl-monitor-grid";

        const emptyEl = document.createElement("div");
        emptyEl.className = "sl-monitor-empty";
        emptyEl.textContent = "No students on this page.";

        root.appendChild(labelEl);
        root.appendChild(gridEl);
        root.appendChild(emptyEl);
        document.body.appendChild(root);
    }

    function createTile(participantId) {
        const el = document.createElement("div");
        el.className = "sl-monitor-tile";
        el.dataset.participantId = participantId;

        const video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("muted", "");
        video.setAttribute("playsinline", "");

        const stateEl = document.createElement("div");
        stateEl.className = "sl-monitor-state";

        const nameEl = document.createElement("div");
        nameEl.className = "sl-monitor-name";

        el.appendChild(video);
        el.appendChild(stateEl);
        el.appendChild(nameEl);

        const tile = { el, video, nameEl, stateEl, jitsiTrack: null };

        tiles.set(participantId, tile);

        return tile;
    }

    // Always detach OUR element only: lib-jitsi-meet's detach() without an
    // argument would also detach Jitsi's own video elements.
    function detachTile(tile) {
        if (tile.jitsiTrack) {
            try {
                tile.jitsiTrack.detach(tile.video);
            } catch (error) {
                /* track already disposed */
            }
        }

        tile.jitsiTrack = null;
        tile.video.srcObject = null;
    }

    function removeTile(participantId) {
        const tile = tiles.get(participantId);

        if (!tile) {
            return;
        }

        detachTile(tile);
        tile.el.remove();
        tiles.delete(participantId);
    }

    // Largest 16:9 tile size that fits all tiles in the grid area.
    function layout() {
        if (!root || !root.classList.contains("sl-visible") || tiles.size === 0) {
            return;
        }

        const width = gridEl.clientWidth;
        const height = gridEl.clientHeight;

        if (width <= 0 || height <= 0) {
            return;
        }

        const count = tiles.size;
        let bestWidth = 0;

        for (let cols = 1; cols <= count; cols++) {
            const rows = Math.ceil(count / cols);
            const maxWidth = (width - SL_TILE_GAP * (cols - 1)) / cols;
            const maxHeight = (height - SL_TILE_GAP * (rows - 1)) / rows;
            const tileWidth = Math.min(maxWidth, maxHeight * SL_TILE_ASPECT);

            if (tileWidth > bestWidth) {
                bestWidth = tileWidth;
            }
        }

        const tileWidth = Math.max(Math.floor(bestWidth), 1);
        const tileHeight = Math.max(Math.floor(bestWidth / SL_TILE_ASPECT), 1);

        tiles.forEach(tile => {
            tile.el.style.width = tileWidth + "px";
            tile.el.style.height = tileHeight + "px";
        });
    }

    // The only place the grid's visibility changes, so the body class (which
    // hides Jitsi's filmstrip) can never disagree with what is on screen.
    function setGridVisible(visible) {
        if (root) {
            root.classList.toggle("sl-visible", visible);
        }

        document.body?.classList.toggle(SL_MONITOR_ACTIVE_CLASS, visible);
    }

    function hide() {
        setGridVisible(false);

        if (!root) {
            return;
        }

        Array.from(tiles.keys()).forEach(removeTile);
        lastSignature = "";
    }

    function render() {
        const state = getState();

        if (!state || !isLocalModerator(state) || !monitorView.enabled) {
            hide();
            return;
        }

        const remote = state["features/base/participants"]?.remote;

        const items = monitorView.participantIds.map(participantId => {
            const participant = remote?.get?.(participantId) ?? null;
            const track = findCameraTrack(state, participantId);

            return {
                participantId,
                name: participant?.name || "Student",
                present: Boolean(participant),
                jitsiTrack: track ? track.jitsiTrack : null,
                muted: track ? Boolean(track.muted) : true
            };
        });

        // The store changes constantly; only touch the DOM when what the grid
        // shows actually changed.
        const signature = JSON.stringify(items.map(item => [
            item.participantId,
            item.name,
            item.present,
            item.muted,
            trackKey(item.jitsiTrack)
        ]));

        if (signature === lastSignature && root?.classList.contains("sl-visible")) {
            return;
        }

        lastSignature = signature;
        ensureRoot();

        const wanted = new Set(items.map(item => item.participantId));

        Array.from(tiles.keys())
            .filter(participantId => !wanted.has(participantId))
            .forEach(removeTile);

        items.forEach(item => {
            const tile = tiles.get(item.participantId) || createTile(item.participantId);

            tile.nameEl.textContent = item.name;
            tile.nameEl.title = item.name;

            if (tile.jitsiTrack !== item.jitsiTrack) {
                detachTile(tile);

                if (item.jitsiTrack) {
                    try {
                        // Same received track, one more element showing it.
                        Promise.resolve(item.jitsiTrack.attach(tile.video))
                            .catch(error => console.warn("[SL Classroom] Monitor tile attach failed:", error));
                        tile.jitsiTrack = item.jitsiTrack;
                    } catch (error) {
                        console.warn("[SL Classroom] Monitor tile attach failed:", error);
                    }
                }
            }

            const hasVideo = Boolean(tile.jitsiTrack) && !item.muted;

            tile.el.classList.toggle("sl-no-video", !hasVideo);
            tile.stateEl.textContent = !item.present ? "Not in the meeting" : hasVideo ? "" : "Camera off";

            if (hasVideo && tile.video.paused) {
                const playing = tile.video.play();

                if (playing && typeof playing.catch === "function") {
                    playing.catch(() => {});
                }
            }

            // Appending moves the tile into page order.
            gridEl.appendChild(tile.el);
        });

        labelEl.textContent =
            "Exam Mode · " + items.length + (items.length === 1 ? " student" : " students");

        root.classList.toggle("sl-empty", items.length === 0);
        setGridVisible(true);

        layout();
    }

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_MONITOR_VIEW") {
            return;
        }

        const state = getState();

        // Students never show the grid.
        if (!state || !isLocalModerator(state)) {
            return;
        }

        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || typeof data.enabled !== "boolean"
            || !Array.isArray(data.participantIds)
            || data.participantIds.length > SL_MAX_MONITOR_TILES
            || !data.participantIds.every(id =>
                typeof id === "string" && SL_PARTICIPANT_ID_PATTERN.test(id))) {
            console.warn("[SL Classroom] Ignored malformed monitor view", data);

            return;
        }

        // An older message must never overwrite a newer view. The same epoch
        // is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < monitorView.epoch) {
            return;
        }

        monitorView = {
            epoch: data.epoch,
            enabled: data.enabled,
            participantIds: data.participantIds.slice()
        };

        console.log("[SL Classroom] Monitor view", monitorView);

        lastSignature = "";
        render();
    });

    window.addEventListener("resize", layout);

    // Page teardown: detach the grid's own elements and drop the body class.
    window.addEventListener("pagehide", hide);

    // Follow every store change: tracks appearing, muting, being replaced,
    // participants leaving, and the local moderator role.
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function") {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(render);
        render();
    }, 500);

})();



/* ==========================================================
   SL Classroom - Student Teacher-Camera PiP

   Display only. While a screen share is the student's stage
   (chosen by the Stage Lock through slPickStudentStage: a
   teacher's share first, then a student's), shows the TEACHER'S
   camera (a remote moderator's) as a small floating tile over
   the top-right of the large video. The sharer only decides
   whether the tile is shown, never whose camera it is.

   Nothing new is connected, subscribed, copied or re-encoded:
   the tile attaches the teacher's ALREADY RECEIVED camera
   JitsiTrack to one more <video> element, like the Phase 2 grid.
   Whether that camera is received is unchanged (Jitsi's own /
   the receive policy's constraints).

   Runs ONLY when the local participant is not a moderator.
   Teachers never get the tile. The local camera is never shown:
   only remote tracks are looked up, and the local participant's
   own share is never the staged share.
========================================================== */

(function () {

    const SL_PIP_ID = "sl-share-pip";
    const SL_PIP_MARGIN = 12;

    let root = null;
    let video = null;
    let attachedTrack = null;
    let lastSignature = "";
    let resizeObserver = null;
    let observedContainer = null;

    // Stable keys for track objects, so a replaced track is noticed.
    const trackKeys = new WeakMap();
    let nextTrackKey = 1;

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    function isLocalModerator(state) {
        return state?.["features/base/participants"]?.local?.role === "moderator";
    }

    function trackKey(jitsiTrack) {
        if (!jitsiTrack) {
            return 0;
        }

        if (!trackKeys.has(jitsiTrack)) {
            trackKeys.set(jitsiTrack, nextTrackKey++);
        }

        return trackKeys.get(jitsiTrack);
    }

    // The participant's received CAMERA track (never a screen share), found
    // by video type like the Phase 2 grid does.
    function findCameraTrack(state, participantId) {
        const tracks = state?.["features/base/tracks"];

        if (!Array.isArray(tracks)) {
            return null;
        }

        return tracks.find(track =>
            track
            && !track.local
            && track.participantId === participantId
            && track.videoType === "camera"
            && track.jitsiTrack
        ) || null;
    }

    // The teacher whose camera the tile shows, or null for no tile.
    //
    // A screen share on the stage (the Stage Lock's own choice: a teacher's
    // share first, then a student's) only decides THAT there is a tile. The
    // camera is always a remote moderator's (participant.role "moderator",
    // from the JWT), never the sharing student's: the moderator whose share
    // is staged if a moderator is sharing, otherwise the first moderator
    // whose camera is on.
    function getPipTeacher(state) {
        const sources = slCollectStudentViewSources(state);
        const stage = slPickStudentStage(sources);

        if (!stage || stage.videoType !== "desktop") {
            return null;
        }

        const cameras = sources.teacherCameras.filter(entry => !entry.muted);
        const camera =
            cameras.find(entry => entry.participantId === stage.participantId)
            || cameras[0];

        return camera ? camera.participantId : null;
    }

    function injectStyles() {
        if (document.getElementById("sl-share-pip-style")) {
            return;
        }

        const style = document.createElement("style");

        style.id = "sl-share-pip-style";

        // z-index 200, like the Phase 2 grid: above the large video, below
        // the toolbar (252), filmstrip (251), chat, dialogs and
        // notifications. Placed inside the large video's own rectangle, so
        // it never covers the filmstrip. Clicks pass through to Jitsi.
        style.textContent = [
            "#" + SL_PIP_ID + " { position: fixed; z-index: 200; display: none; box-sizing: border-box; width: 240px; max-width: 30vw; min-width: 112px; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.25); background: #000000; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45); pointer-events: none; }",
            "#" + SL_PIP_ID + ".sl-visible { display: block; }",
            "#" + SL_PIP_ID + " video { display: block; width: 100%; height: 100%; object-fit: cover; background: #000000; }",
            "@media (max-width: 640px) { #" + SL_PIP_ID + " { width: 32vw; min-width: 96px; border-radius: 8px; } }"
        ].join("\n");

        document.head.appendChild(style);
    }

    // Top-right corner of the large video. Jitsi resizes that area itself
    // (chat, filmstrip, window), so it is measured, not assumed.
    function position() {
        if (!root) {
            return;
        }

        const container = document.getElementById("largeVideoContainer");
        const rect = container ? container.getBoundingClientRect() : null;

        if (rect && rect.width > 0 && rect.height > 0) {
            root.style.top = Math.round(rect.top + SL_PIP_MARGIN) + "px";
            root.style.right = Math.round(window.innerWidth - rect.right + SL_PIP_MARGIN) + "px";
        } else {
            root.style.top = SL_PIP_MARGIN + "px";
            root.style.right = SL_PIP_MARGIN + "px";
        }

        // Follow the large video's own size changes, not only the window's.
        if (container !== observedContainer && typeof ResizeObserver === "function") {
            resizeObserver = resizeObserver || new ResizeObserver(position);
            resizeObserver.disconnect();

            if (container) {
                resizeObserver.observe(container);
            }

            observedContainer = container;
        }
    }

    function ensureRoot() {
        if (root) {
            return;
        }

        injectStyles();

        root = document.createElement("div");
        root.id = SL_PIP_ID;

        video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("muted", "");
        video.setAttribute("playsinline", "");

        root.appendChild(video);
        document.body.appendChild(root);
    }

    // Always detach OUR element only: lib-jitsi-meet's detach() without an
    // argument would also detach Jitsi's own video elements.
    function detach() {
        if (attachedTrack && video) {
            try {
                attachedTrack.detach(video);
            } catch (error) {
                /* track already disposed */
            }
        }

        attachedTrack = null;

        if (video) {
            video.srcObject = null;
        }
    }

    // Removes the tile completely: detached, out of the DOM, not observed.
    function hide() {
        lastSignature = "";

        if (!root) {
            return;
        }

        detach();
        root.remove();
        root = null;
        video = null;

        if (resizeObserver) {
            resizeObserver.disconnect();
        }

        observedContainer = null;
    }

    function render() {
        const state = getState();

        // Teachers never get the tile.
        if (!state || isLocalModerator(state)) {
            hide();
            return;
        }

        const teacherId = getPipTeacher(state);
        const track = teacherId ? findCameraTrack(state, teacherId) : null;

        // No share on the stage, or no teacher camera on.
        if (!teacherId || !track || track.muted) {
            hide();
            return;
        }

        // The store changes constantly; only touch the DOM when what the tile
        // shows actually changed.
        const signature = teacherId + ":" + trackKey(track.jitsiTrack);

        if (signature === lastSignature && root) {
            return;
        }

        lastSignature = signature;
        ensureRoot();

        if (attachedTrack !== track.jitsiTrack) {
            detach();

            try {
                // Same received track, one more element showing it.
                Promise.resolve(track.jitsiTrack.attach(video))
                    .catch(error => console.warn("[SL Classroom] Share PiP attach failed:", error));
                attachedTrack = track.jitsiTrack;
            } catch (error) {
                console.warn("[SL Classroom] Share PiP attach failed:", error);
            }
        }

        root.classList.add("sl-visible");
        position();

        if (video.paused) {
            const playing = video.play();

            if (playing && typeof playing.catch === "function") {
                playing.catch(() => {});
            }
        }
    }

    window.addEventListener("resize", position);

    // Page teardown: detach the tile's own element.
    window.addEventListener("pagehide", hide);

    // Follow every store change: shares starting/stopping, the teacher's
    // camera muting or being replaced, participants leaving, the local role.
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function") {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(render);
        render();
    }, 500);

    console.log(
        "======== SL CLASSROOM STUDENT SHARE PIP ENABLED ========"
    );

})();
