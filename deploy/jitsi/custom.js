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

            // A teacher's (moderator's) own stage is never locked here: with a
            // co-teacher in the room this loop would otherwise force that
            // co-teacher on stage every second, over the teacher's own
            // choice. The teacher view's stage policy decides it instead.
            // Students: unchanged.
            if (!isLocalStudent) {
                return;
            }

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



/* ==========================================================
   SL Classroom - Custom Large Stage (Phase 4)

   Display only. SL Classroom's own main-stage <video> for
   students, laid over Jitsi's large video area. Jitsi's own
   large video stays underneath, untouched, as the fallback.

   What it shows is the Stage Lock's own choice
   (slPickStudentStage): a teacher's screen share, else a
   student's screen share, else the teacher's camera. The
   teacher-camera PiP above (z-index 200) sits on top of it.

   Nothing new is connected, subscribed, copied or re-encoded:
   the stage attaches the ALREADY RECEIVED JitsiTrack of that
   source to one more <video> element (JitsiTrack.attach sets
   video.srcObject to the track's existing MediaStream), like the
   Phase 2 grid and the PiP. What is received is still decided by
   the receiver constraints (Phase 3 onStageSources = this same
   source, and the Stage Lock's stage selection underneath).

   Runs ONLY when the local participant is not a moderator, and
   only while the parent page enables it:
     { type: "SL_STAGE_VIEW", v: 1, epoch, enabled }
   (resent by the parent after SL_RECEIVE_READY). Off by default.
========================================================== */

(function () {

    const SL_STAGE_ID = "sl-custom-stage";
    const SL_STREAMING_STATUS_EVENT = "track.streaming_status_changed";

    // Jitsi track streaming status (lib-jitsi-meet TrackStreamingStatus)
    // -> what the stage tells the viewer. "active" (or not tracked yet) shows
    // nothing.
    const SL_STATUS_MESSAGES = {
        inactive: "Video paused to save bandwidth",
        interrupted: "Video interrupted - reconnecting…",
        restoring: "Video interrupted - reconnecting…"
    };

    let stageView = { epoch: 0, enabled: false };

    let root = null;
    let video = null;
    let messageEl = null;
    let statusEl = null;

    // The JitsiTrack attached to OUR <video>, and the one we listen to for
    // streaming status changes (always the same track, or none).
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

    // The received track of exactly the picked source: same owner, same video
    // type (camera / desktop), and the same source name when the track knows it.
    function findStageTrack(state, stage) {
        const tracks = state?.["features/base/tracks"];

        if (!Array.isArray(tracks)) {
            return null;
        }

        return tracks.find(track => {
            if (!track || track.local || !track.jitsiTrack
                || track.participantId !== stage.participantId
                || track.videoType !== stage.videoType) {
                return false;
            }

            const sourceName = typeof track.jitsiTrack.getSourceName === "function"
                ? track.jitsiTrack.getSourceName()
                : null;

            return !sourceName || sourceName === stage.sourceName;
        }) || null;
    }

    // Lib-jitsi-meet's real streaming status for the attached track ("active",
    // "inactive", "interrupted", "restoring"); null when it is not tracked.
    function getStreamingStatus(jitsiTrack) {
        try {
            return typeof jitsiTrack?.getTrackStreamingStatus === "function"
                ? jitsiTrack.getTrackStreamingStatus() || null
                : null;
        } catch (error) {
            return null;
        }
    }

    function injectStyles() {
        if (document.getElementById("sl-custom-stage-style")) {
            return;
        }

        const style = document.createElement("style");

        style.id = "sl-custom-stage-style";

        // z-index 199: above Jitsi's large video (1), below the teacher PiP
        // (200), the filmstrip (251), the toolbar (252), chat (300), dialogs
        // (301), drawers (351) and notifications (600/901). It covers only the
        // large video's own rectangle, and clicks pass through to Jitsi.
        style.textContent = [
            "#" + SL_STAGE_ID + " { position: fixed; z-index: 199; display: none; box-sizing: border-box; overflow: hidden; background: #000000; pointer-events: none; }",
            "#" + SL_STAGE_ID + ".sl-visible { display: block; }",
            "#" + SL_STAGE_ID + " video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000000; }",
            "#" + SL_STAGE_ID + " .sl-stage-message { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; padding: 16px; color: #CBD5E1; font: 500 15px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; text-align: center; }",
            "#" + SL_STAGE_ID + ".sl-stage-empty video { visibility: hidden; }",
            "#" + SL_STAGE_ID + ".sl-stage-empty .sl-stage-message { display: flex; }",
            "#" + SL_STAGE_ID + " .sl-stage-status { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); display: none; max-width: calc(100% - 32px); padding: 6px 12px; border-radius: 999px; background: rgba(15, 23, 42, 0.85); color: #F8FAFC; font: 500 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
            "#" + SL_STAGE_ID + ".sl-stage-weak .sl-stage-status { display: block; }",
            "@media (max-width: 640px) { #" + SL_STAGE_ID + " .sl-stage-message { font-size: 14px; } #" + SL_STAGE_ID + " .sl-stage-status { top: 8px; font-size: 12px; } }"
        ].join("\n");

        document.head.appendChild(style);
    }

    // Exactly over Jitsi's large video area, which Jitsi resizes itself (chat,
    // filmstrip, window), so it is measured, not assumed.
    function position() {
        if (!root) {
            return;
        }

        const container = document.getElementById("largeVideoContainer");
        const rect = container ? container.getBoundingClientRect() : null;

        if (rect && rect.width > 0 && rect.height > 0) {
            root.style.top = Math.round(rect.top) + "px";
            root.style.left = Math.round(rect.left) + "px";
            root.style.width = Math.round(rect.width) + "px";
            root.style.height = Math.round(rect.height) + "px";
        } else {
            root.style.top = "0px";
            root.style.left = "0px";
            root.style.width = "100%";
            root.style.height = "100%";
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
        root.id = SL_STAGE_ID;

        video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("muted", "");
        video.setAttribute("playsinline", "");

        messageEl = document.createElement("div");
        messageEl.className = "sl-stage-message";

        statusEl = document.createElement("div");
        statusEl.className = "sl-stage-status";

        root.appendChild(video);
        root.appendChild(messageEl);
        root.appendChild(statusEl);
        document.body.appendChild(root);
    }

    function onStreamingStatusChanged() {
        lastSignature = "";
        render();
    }

    // Always detach OUR element only: lib-jitsi-meet's detach() without an
    // argument would also detach Jitsi's own video elements.
    function detachTrack() {
        if (attachedTrack) {
            try {
                if (typeof attachedTrack.off === "function") {
                    attachedTrack.off(SL_STREAMING_STATUS_EVENT, onStreamingStatusChanged);
                }
            } catch (error) {
                /* track already disposed */
            }

            if (video) {
                try {
                    attachedTrack.detach(video);
                } catch (error) {
                    /* track already disposed */
                }
            }
        }

        attachedTrack = null;

        if (video) {
            video.srcObject = null;
        }
    }

    function attachTrack(jitsiTrack) {
        try {
            // Same received track, one more element showing it.
            Promise.resolve(jitsiTrack.attach(video))
                .catch(error => console.warn("[SL Classroom] Stage attach failed:", error));
            attachedTrack = jitsiTrack;
        } catch (error) {
            console.warn("[SL Classroom] Stage attach failed:", error);
            return;
        }

        // Real streaming status from lib-jitsi-meet (listening also makes it
        // track the status if Jitsi itself is not).
        try {
            if (typeof jitsiTrack.on === "function") {
                jitsiTrack.on(SL_STREAMING_STATUS_EVENT, onStreamingStatusChanged);
            }
        } catch (error) {
            /* status stays unknown: nothing is shown for it */
        }
    }

    // Removes the stage completely: detached, out of the DOM, not observed.
    // Jitsi's own large video underneath is then visible again.
    function hide() {
        lastSignature = "";

        if (!root) {
            return;
        }

        detachTrack();
        root.remove();
        root = null;
        video = null;
        messageEl = null;
        statusEl = null;

        if (resizeObserver) {
            resizeObserver.disconnect();
        }

        observedContainer = null;
    }

    function render() {
        const state = getState();

        // Students only, and only while the parent page enables it.
        if (!state || !stageView.enabled || isLocalModerator(state)) {
            hide();
            return;
        }

        const stage = slPickStudentStage(slCollectStudentViewSources(state));

        let jitsiTrack = null;
        let emptyMessage = "";

        if (!stage) {
            emptyMessage = "Waiting for the teacher's video…";
        } else if (stage.videoType === "camera" && stage.muted) {
            emptyMessage = "The teacher's camera is off";
        } else {
            const track = findStageTrack(state, stage);

            if (!track) {
                emptyMessage = "Connecting video…";
            } else if (track.muted) {
                emptyMessage = stage.videoType === "camera"
                    ? "The teacher's camera is off"
                    : "Screen share paused";
            } else {
                jitsiTrack = track.jitsiTrack;
            }
        }

        const status = jitsiTrack ? getStreamingStatus(jitsiTrack) : null;
        const statusMessage = (status && SL_STATUS_MESSAGES[status]) || "";

        // The store changes constantly; only touch the DOM when what the
        // stage shows actually changed.
        const signature = JSON.stringify([
            stage ? stage.sourceName : null,
            trackKey(jitsiTrack),
            emptyMessage,
            statusMessage
        ]);

        if (signature === lastSignature && root) {
            return;
        }

        lastSignature = signature;
        ensureRoot();

        if (attachedTrack !== jitsiTrack) {
            detachTrack();

            if (jitsiTrack) {
                attachTrack(jitsiTrack);
            }
        }

        root.classList.toggle("sl-stage-empty", Boolean(emptyMessage));
        messageEl.textContent = emptyMessage;

        root.classList.toggle("sl-stage-weak", Boolean(statusMessage));
        statusEl.textContent = statusMessage;

        root.classList.add("sl-visible");
        position();

        if (jitsiTrack && video.paused) {
            const playing = video.play();

            if (playing && typeof playing.catch === "function") {
                playing.catch(() => {});
            }
        }
    }

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_STAGE_VIEW") {
            return;
        }

        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || typeof data.enabled !== "boolean") {
            console.warn("[SL Classroom] Ignored malformed stage view", data);

            return;
        }

        // An older message must never overwrite a newer one. The same epoch
        // is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < stageView.epoch) {
            return;
        }

        // Kept even before the local role is known: the stage itself only
        // ever shows while the local participant is not a moderator.
        stageView = {
            epoch: data.epoch,
            enabled: data.enabled
        };

        console.log("[SL Classroom] Stage view", stageView);

        lastSignature = "";
        render();
    });

    // ---------------------------------------------------------------------
    // PHASE 4 TESTING ONLY - lets a tester switch the stage on/off from the
    // Jitsi iframe's DevTools console (e.g. with a Local Override of this
    // file against a page that does not send SL_STAGE_VIEW):
    //   __slStageViewTest.on()   __slStageViewTest.off()
    // Affects only this browser's own display. The next SL_STAGE_VIEW from
    // the parent page replaces it.
    // ---------------------------------------------------------------------
    window.__slStageViewTest = {
        on: () => {
            stageView = { epoch: stageView.epoch, enabled: true };
            lastSignature = "";
            render();
        },
        off: () => {
            stageView = { epoch: stageView.epoch, enabled: false };
            render();
        }
    };

    window.addEventListener("resize", position);

    // Page teardown: detach the stage's own element.
    window.addEventListener("pagehide", hide);

    // Follow every store change: shares starting/stopping, cameras muting or
    // being replaced, tracks re-created after a reconnect, participants
    // leaving, the local role.
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function") {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(render);
        render();
    }, 500);

    console.log(
        "======== SL CLASSROOM CUSTOM STAGE (PHASE 4) LOADED ========"
    );

})();



/* ==========================================================
   SL Classroom - Teacher Normal View (custom filmstrip, Phase A)

   Display only. For the TEACHER in NORMAL mode: SL Classroom's
   own main stage plus a vertical filmstrip on the right, over
   Jitsi's own layout. Jitsi's own filmstrip is only hidden with
   CSS (like the Phase 2 grid does); its participants, tracks and
   large video keep running underneath.

   - Tiles: the teacher's own camera, every remote participant's
     camera (moderators first), and active remote screen shares.
   - Clicking a tile selects that participant (Phase C); clicking
     the selected tile again goes back to the teacher's own camera.
   - The stage shows whatever Jitsi itself has selected:
     features/large-video.participantId. Phase C steers it only
     through Jitsi's own PIN_PARTICIPANT (so Jitsi's receiver
     constraints request exactly what is shown), by priority:
     a co-teacher's screen share > a student's screen share > the
     teacher's selection > the teacher's own camera. The selection
     is never persisted and is cleared by Exam Mode; a participant
     who leaves is forgotten.

   Nothing new is connected, subscribed, copied or re-encoded:
   every tile and the stage attach an ALREADY RECEIVED (or the
   local) JitsiTrack to one more <video> element, like Jitsi's
   own thumbnails. What is received is unchanged: Jitsi's own
   receiver constraints still apply in normal mode.

   Phase B: the filmstrip sits right (default), left, top or bottom,
   vertical at the sides and horizontal at the top/bottom; a narrow
   portrait screen always gets it at the bottom (the choice itself is
   kept). The teacher picks the position with a small layout button
   on the filmstrip; the choice applies at once and is reported to
   the parent page, which remembers it (localStorage) and sends it
   back with SL_TEACHER_VIEW on the next join:
     iframe -> parent: { type: "SL_TEACHER_LAYOUT", v: 1, position, autoHide }
   Optional auto-hide (a switch in the same menu, default off): ~4s
   after the pointer leaves the filmstrip it slides out (CSS only, its
   size kept, tiles still attached) and a small restore handle stays on
   that edge. The hidden state is never kept: a reload, rejoin or Exam
   Mode -> Normal shows it again. With the filmstrip at the bottom,
   Jitsi's toolbar floats 8px above it (no band is reserved).
   The boundary can be dragged to resize the filmstrip (pointer
   events; keyboard arrows on the handle). All of it is CSS on our
   own elements: flex direction / order and CSS variables. No
   participant or video element is moved, and Jitsi's own filmstrip
   and receiver constraints are never touched.

   Shown ONLY while all of these hold:
     - the parent page enabled it:
         { type: "SL_TEACHER_VIEW", v: 1, epoch, enabled, position?, autoHide? }
       (position: "right" | "left" | "top" | "bottom"; autoHide:
       boolean; absent keeps the current value)
       (resent by the parent after SL_RECEIVE_READY)
     - the local participant is a moderator (JWT role)
     - the Exam Mode monitoring grid is not showing
       (body.sl-monitor-active, set by the Phase 2 grid)
========================================================== */

(function () {

    const SL_TV_ID = "sl-teacher-view";
    const SL_TV_ACTIVE_CLASS = "sl-teacher-view-active";
    const SL_MONITOR_ACTIVE_CLASS = "sl-monitor-active";
    const SL_STREAMING_STATUS_EVENT = "track.streaming_status_changed";

    // Where the view is mounted. #videoconference_page has a transform, so it
    // is its own stacking context: Jitsi's toolbar (.new-toolbox z-index 252),
    // header and notifications only stack INSIDE it. A body-level overlay is
    // compared with the whole page (level 0) and covers the toolbar; mounted
    // inside the page, z-index 199 sits above the large video (1) and below
    // the toolbar. Chat, side panels and dialogs are outside the page and stay
    // above it. Falls back to <body> if Jitsi's page element is missing.
    const SL_TV_MOUNT_ID = "videoconference_page";

    // Camera-off placeholders: static inline line icons (no media of any
    // kind). Stroke-based for a clean, consistent look at every size.
    const SL_ICONS = {
        // Person beside a board.
        teacher: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="10.5" y="3.5" width="10.5" height="7.5" rx="1.4"/><path d="M13.5 7.25h4.5"/><circle cx="6.5" cy="8.25" r="2.6"/><path d="M2.75 20v-1.25a3.75 3.75 0 0 1 3.75-3.75 3.75 3.75 0 0 1 3.75 3.75V20"/><path d="M9.25 14.25l3.25-3.25"/></svg>',
        // Person.
        student: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.25" r="3.75"/><path d="M4.75 20v-.75A5.75 5.75 0 0 1 10.5 13.5h3a5.75 5.75 0 0 1 5.75 5.75V20"/></svg>',
        // Monitor.
        screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.75" y="4" width="18.5" height="12.5" rx="1.75"/><path d="M8.5 20h7M12 16.5V20"/></svg>'
    };

    const SL_STATUS_MESSAGES = {
        inactive: "Video paused to save bandwidth",
        interrupted: "Video interrupted - reconnecting…",
        restoring: "Video interrupted - reconnecting…"
    };

    // Phase B layout: where the filmstrip sits and how big it is. Display only
    // (CSS on our own elements); nothing here touches Jitsi's own filmstrip,
    // tracks or receiver constraints.
    const SL_TV_POSITIONS = ["right", "left", "top", "bottom"];
    // Classes / CSS variables on <body>: Jitsi's toolbar is outside our view,
    // and the toolbar rules below need the effective position and size too.
    const SL_TV_POS_CLASS_PREFIX = "sl-tv-pos-";
    const SL_TV_VAR_STRIP_V = "--sl-tv-strip-v";
    const SL_TV_VAR_STRIP_H = "--sl-tv-strip-h";
    // How far the toolbar's own restore pill (toolbar polish, hidden state)
    // sits above the page bottom: a bottom filmstrip's height, else 0.
    const SL_TV_VAR_PILL_OFFSET = "--sl-tv-pill-offset";
    // On <body> while the filmstrip is auto-hidden / collapsed (toolbar rules).
    const SL_TV_STRIP_HIDDEN_CLASS = "sl-tv-strip-hidden";
    // Tells the toolbar polish that the toolbar moved (bottom filmstrip).
    const SL_TV_LAYOUT_EVENT = "sl-teacher-layout";
    // Smallest stage left beside / above the filmstrip.
    const SL_TV_MIN_STAGE_WIDTH = 320;
    const SL_TV_MIN_STAGE_HEIGHT = 240;
    // Smallest usable strip: a 16:9 tile ~80px tall (after the strip's
    // padding and scrollbar) still fits the placeholder's icon and name.
    const SL_TV_MIN_STRIP_V = 168;
    const SL_TV_MIN_STRIP_H = 108;
    const SL_TV_DEFAULT_STRIP_H = 140;
    // Auto-hide: this long after the pointer leaves the filmstrip.
    const SL_TV_AUTO_HIDE_MS = 4000;
    // Portrait screens narrower than this show the filmstrip at the bottom
    // (the teacher's chosen position is kept and comes back when wider).
    const SL_TV_NARROW_WIDTH = 600;
    const SL_TV_KEY_STEP = 16;

    // Filmstrip layout control: the teacher picks the position on the
    // filmstrip itself. The choice is reported to the parent page, which
    // remembers it (localStorage) and sends it back with SL_TEACHER_VIEW.
    const SL_TV_POSITION_LABELS = { right: "Right", left: "Left", top: "Top", bottom: "Bottom" };
    // Static inline icons: a frame with the filmstrip's side filled in.
    const SL_TV_LAYOUT_ICONS = {
        button: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.25"/><path d="M14.5 4.5v15"/><path d="M16.75 8.25h1.5M16.75 11.25h1.5"/></svg>',
        right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.25"/><rect x="14.75" y="6.5" width="4" height="11" rx="1" fill="currentColor" stroke="none"/></svg>',
        left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.25"/><rect x="5.25" y="6.5" width="4" height="11" rx="1" fill="currentColor" stroke="none"/></svg>',
        top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.25"/><rect x="5.5" y="6.25" width="13" height="3.75" rx="1" fill="currentColor" stroke="none"/></svg>',
        bottom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.25"/><rect x="5.5" y="14" width="13" height="3.75" rx="1" fill="currentColor" stroke="none"/></svg>'
    };

    // Edge handle (collapse / restore): a chevron pointing the way the
    // filmstrip will move. Same strokes as the toolbar's restore control.
    const SL_TV_CHEVRONS = {
        left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>',
        right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>',
        down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>',
        up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14.5l6-6 6 6"/></svg>'
    };
    // Per position: [shown -> collapse direction, hidden -> restore direction].
    const SL_TV_HANDLE_DIRECTIONS = {
        right: ["right", "left"],
        left: ["left", "right"],
        top: ["up", "down"],
        bottom: ["down", "up"]
    };

    let teacherView = { epoch: 0, enabled: false };

    // Kept outside the view's DOM: the view is removed and rebuilt (Exam Mode,
    // disable), and the layout must survive that.
    let preferredPosition = "right";
    // The teacher's dragged sizes in px, one per orientation; null = default
    // (vertical: Phase A's min(240px, 38vw)).
    const stripSizes = { vertical: null, horizontal: null };
    let appliedPosition = null;

    // Auto-hide: the teacher's preference (from the parent page / the layout
    // menu; default off) and the current hidden state (never persisted: a
    // reload, a rejoin or Exam Mode -> Normal shows the filmstrip again).
    let autoHideEnabled = false;
    let stripHidden = false;
    let stripHideTimer = null;
    let pointerInStrip = false;
    // Last input: the keyboard (true) or a pointer (false).
    let keyboardInUse = false;

    // Phase C: the teacher's stage choice (intent only; the stage itself is
    // Jitsi's large-video participant). null = none (teacher's own camera),
    // "self" = the teacher chose their own camera, or a Jitsi participant
    // ID. Never persisted; cleared when the view goes (Exam Mode, disable).
    let manualSelection = null;
    let lastPinAttempt = { id: null, at: 0 };
    // Stage changes: a short "Loading video…" while the newly staged source
    // starts arriving (instead of "paused to save bandwidth").
    const SL_TV_STAGE_LOADING_MS = 2500;
    let lastStageId = null;
    let stageChangedAt = 0;
    let stageLoadingTimer = null;
    let lastToolbarKey = "";
    let drag = null;
    let dragFrame = 0;
    let layoutObserver = null;

    let root = null;
    let stageEl = null;
    let stageVideo = null;
    let stageMessageEl = null;
    let stageStatusEl = null;
    let stagePlaceholder = null;
    let filmstripEl = null;
    // Inside the filmstrip: the scrolling tiles, and a footer with the
    // filmstrip settings (layout button + menu).
    let tilesEl = null;
    let footerEl = null;
    let resizerEl = null;
    let layoutButtonEl = null;
    let layoutMenuEl = null;
    let autoHideSwitchEl = null;
    let restoreEl = null;

    let stageTrack = null;
    let lastSignature = "";
    let rendering = false;

    // tile id (participant id, or a screen share's source name) ->
    // { el, video, nameEl, stateEl, jitsiTrack }
    const tiles = new Map();

    // Stable keys for track objects, so a replaced track is noticed.
    const trackKeys = new WeakMap();
    let nextTrackKey = 1;

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    function isLocalModerator(state) {
        return state?.["features/base/participants"]?.local?.role === "moderator";
    }

    function isExamGridShowing() {
        return Boolean(document.body?.classList.contains(SL_MONITOR_ACTIVE_CLASS));
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

    function getTracks(state) {
        const tracks = state?.["features/base/tracks"];

        return Array.isArray(tracks) ? tracks : [];
    }

    // A camera track: the local one, or a remote participant's (by video
    // type, never by source-name suffix).
    function findCameraTrack(state, participantId, local) {
        return getTracks(state).find(track =>
            track
            && track.jitsiTrack
            && Boolean(track.local) === local
            && (local || track.participantId === participantId)
            && track.videoType === "camera"
        ) || null;
    }

    // A remote screen-share track, by its exact source name (a screen
    // share's virtual participant ID is its source name).
    function findDesktopTrack(state, sourceName, ownerId) {
        const tracks = getTracks(state);

        return tracks.find(track =>
            track
            && !track.local
            && track.jitsiTrack
            && typeof track.jitsiTrack.getSourceName === "function"
            && track.jitsiTrack.getSourceName() === sourceName
        ) || tracks.find(track =>
            track
            && !track.local
            && track.jitsiTrack
            && track.participantId === ownerId
            && track.videoType === "desktop"
        ) || null;
    }

    // The tiles to show, in order: the teacher's own camera, then remote
    // participants (moderators first, otherwise join order), each followed
    // by their active screen share.
    function collectTiles(state) {
        const participants = state?.["features/base/participants"];
        const local = participants?.local;
        const remote = participants?.remote;
        const stageId = state?.["features/large-video"]?.participantId ?? null;
        // The teacher's own choice (Phase C), shown on its tile. Jitsi's pin
        // itself is not shown: the stage policy pins the teacher by default.
        const selectedId = manualSelection === "self" ? local?.id : manualSelection;
        const items = [];

        const pushItem = item => {
            items.push({
                ...item,
                muted: item.track ? Boolean(item.track.muted) : true,
                pinned: Boolean(selectedId) && selectedId === item.id,
                onStage: stageId === item.id
            });
        };

        if (local?.id) {
            pushItem({
                id: local.id,
                name: (local.name || "You") + " (You)",
                kind: "camera",
                role: roleOf(local),
                local: true,
                track: findCameraTrack(state, local.id, true)
            });
        }

        const people = [];

        if (remote && typeof remote.entries === "function") {
            for (const [participantId, participant] of remote.entries()) {
                if (participant && !participant.fakeParticipant && participantId !== local?.id) {
                    people.push([participantId, participant]);
                }
            }
        }

        // Stable sort: moderators first, join order otherwise.
        people.sort((a, b) =>
            (b[1].role === "moderator") - (a[1].role === "moderator"));

        people.forEach(([participantId, participant]) => {
            const name = participant.name || "Participant";

            pushItem({
                id: participantId,
                name,
                kind: "camera",
                role: roleOf(participant),
                local: false,
                track: findCameraTrack(state, participantId, false)
            });

            const videoSources = participant.sources?.get?.("video");

            if (videoSources && typeof videoSources.entries === "function") {
                for (const [sourceName, info] of videoSources.entries()) {
                    if (info?.videoType === "desktop" && !info.muted) {
                        pushItem({
                            id: sourceName,
                            name: name + " - screen",
                            kind: "desktop",
                            role: roleOf(participant),
                            local: false,
                            track: findDesktopTrack(state, sourceName, participantId)
                        });
                    }
                }
            }
        });

        return items;
    }

    // "teacher" for a Jitsi moderator (role from the JWT), otherwise
    // "student". Never derived from the display name.
    function roleOf(participant) {
        return participant?.role === "moderator" ? "teacher" : "student";
    }

    // Whether a remote participant's camera is signalled as ON (SourceInfo,
    // videoType "camera", not muted), whether or not its track exists yet.
    function isCameraSourceOn(participant) {
        const videoSources = participant?.sources?.get?.("video");

        if (!videoSources || typeof videoSources.entries !== "function") {
            return false;
        }

        for (const [, info] of videoSources.entries()) {
            if (info?.videoType === "camera" && !info.muted) {
                return true;
            }
        }

        return false;
    }

    // What the stage shows: Jitsi's own large-video selection. A camera that
    // is off gives a placeholder (name + role icon) instead of a message.
    function resolveStage(state) {
        const stageId = state?.["features/large-video"]?.participantId ?? null;
        const participants = state?.["features/base/participants"];
        const local = participants?.local;

        const result = (track, isLocal, empty, placeholder) => ({
            id: stageId,
            track: track ? track.jitsiTrack : null,
            local: isLocal,
            empty: empty || "",
            placeholder: placeholder || null
        });

        if (!stageId) {
            return result(null, false, "No one is on stage yet");
        }

        if (local?.id === stageId) {
            const track = findCameraTrack(state, stageId, true);
            const placeholder = { name: (local.name || "You") + " (You)", role: roleOf(local) };

            return track && !track.muted
                ? result(track, true)
                : result(null, true, "", placeholder);
        }

        const participant = participants?.remote?.get?.(stageId);

        if (!participant) {
            return result(null, false, "Waiting for video…");
        }

        // A screen share's virtual participant: its desktop track.
        if (participant.fakeParticipant) {
            const track = findDesktopTrack(state, stageId, String(stageId).split("-")[0]);

            if (!track) {
                return result(null, false, "Connecting video…");
            }

            return track.muted
                ? result(null, false, "Screen share paused")
                : result(track, false);
        }

        const track = findCameraTrack(state, stageId, false);
        const placeholder = { name: participant.name || "Participant", role: roleOf(participant) };

        if (track && !track.muted) {
            return result(track, false);
        }

        // Camera signalled ON but its track not here yet: still connecting.
        // Otherwise the camera is off (or was never turned on).
        return !track && isCameraSourceOn(participant)
            ? result(null, false, "Connecting video…")
            : result(null, false, "", placeholder);
    }

    function getStreamingStatus(jitsiTrack) {
        try {
            return typeof jitsiTrack?.getTrackStreamingStatus === "function"
                ? jitsiTrack.getTrackStreamingStatus() || null
                : null;
        } catch (error) {
            return null;
        }
    }

    // ---- Phase B layout ---------------------------------------------------

    function isVerticalPosition(position) {
        return position === "left" || position === "right";
    }

    // The area the view covers: Jitsi's conference page (our root fills it).
    function getLayoutBox() {
        const box = (root || getMountParent()).getBoundingClientRect();

        return { width: box.width || window.innerWidth || 0, height: box.height || window.innerHeight || 0 };
    }

    // The teacher's position, except on a narrow portrait screen, which gets
    // the filmstrip at the bottom. The preference itself is never changed.
    function getEffectivePosition(box) {
        return box.width > 0 && box.width < SL_TV_NARROW_WIDTH && box.height > box.width
            ? "bottom"
            : preferredPosition;
    }

    function clamp(value, bounds) {
        return Math.round(Math.min(Math.max(value, bounds.min), bounds.max));
    }

    // Filmstrip width (left/right): at least a usable tile, at most 45% of
    // the page and never leaving the stage narrower than 320px.
    function getVerticalBounds(box) {
        const min = Math.min(SL_TV_MIN_STRIP_V, box.width * 0.45);

        return { min, max: Math.max(min, Math.min(box.width * 0.45, box.width - SL_TV_MIN_STAGE_WIDTH)) };
    }

    // Filmstrip height (top/bottom): at least a usable tile row, at most 40%
    // of the page and never leaving the stage shorter than 240px. (The
    // toolbar floats over the stage, above a bottom filmstrip.)
    function getHorizontalBounds(box) {
        const min = Math.min(SL_TV_MIN_STRIP_H, box.height * 0.4);

        return {
            min,
            max: Math.max(min, Math.min(box.height * 0.4, box.height - SL_TV_MIN_STAGE_HEIGHT))
        };
    }

    // Applies position, size and the hidden state: a data attribute and a
    // class on our root, classes and CSS variables on <body>. CSS does the
    // layout (flex direction / order / margins); no participant or video
    // element is ever moved or detached.
    function applyLayout() {
        if (!root || !document.body) {
            return;
        }

        const box = getLayoutBox();
        const position = getEffectivePosition(box);
        const bodyStyle = document.body.style;

        if (position !== appliedPosition) {
            SL_TV_POSITIONS.forEach(name =>
                document.body.classList.toggle(SL_TV_POS_CLASS_PREFIX + name, name === position));
            appliedPosition = position;
        }

        root.dataset.pos = position;
        root.classList.toggle(SL_TV_STRIP_HIDDEN_CLASS, stripHidden);

        if (document.body.classList.contains(SL_TV_STRIP_HIDDEN_CLASS) !== stripHidden) {
            document.body.classList.toggle(SL_TV_STRIP_HIDDEN_CLASS, stripHidden);
        }

        // Vertical: unset until the teacher drags, so the default is exactly
        // Phase A's min(240px, 38vw).
        if (stripSizes.vertical === null) {
            bodyStyle.removeProperty(SL_TV_VAR_STRIP_V);
        } else {
            bodyStyle.setProperty(SL_TV_VAR_STRIP_V, clamp(stripSizes.vertical, getVerticalBounds(box)) + "px");
        }

        const stripH = clamp(stripSizes.horizontal ?? SL_TV_DEFAULT_STRIP_H, getHorizontalBounds(box));

        bodyStyle.setProperty(SL_TV_VAR_STRIP_H, stripH + "px");

        // The toolbar's restore pill (hidden toolbar) sits above a shown
        // bottom filmstrip, like the toolbar itself.
        const pillOffset = position === "bottom" && !stripHidden ? stripH : 0;

        bodyStyle.setProperty(SL_TV_VAR_PILL_OFFSET, pillOffset + "px");

        if (resizerEl) {
            const vertical = isVerticalPosition(position);
            const bounds = vertical ? getVerticalBounds(box) : getHorizontalBounds(box);

            resizerEl.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
            resizerEl.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
            resizerEl.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
            resizerEl.setAttribute("aria-valuenow", String(Math.round(getStripSize(position))));
        }

        // Edge handle: collapse while shown, restore while hidden.
        const restorePill = restoreEl?.firstChild;
        const direction = (SL_TV_HANDLE_DIRECTIONS[position] || SL_TV_HANDLE_DIRECTIONS.right)[stripHidden ? 1 : 0];

        if (restorePill && restorePill.dataset.dir !== direction) {
            restorePill.dataset.dir = direction;
            restorePill.innerHTML = SL_TV_CHEVRONS[direction];
        }

        if (restoreEl) {
            const label = stripHidden ? "Show participant filmstrip" : "Hide participant filmstrip";

            restoreEl.setAttribute("aria-label", label);
            restoreEl.setAttribute("aria-expanded", stripHidden ? "false" : "true");
            restoreEl.title = stripHidden ? "Show participants" : "Hide participants";
        }

        // An open position menu follows the effective position (CSS places it).
        if (isLayoutMenuOpen()) {
            updateLayoutMenu();
            liftLayoutMenu();
        }

        // The toolbar moves with a bottom filmstrip (CSS); its hide/show
        // control is placed by script, so tell it when that can change.
        const toolbarKey = position + ":" + stripH + ":" + stripHidden;

        if (toolbarKey !== lastToolbarKey) {
            lastToolbarKey = toolbarKey;
            window.dispatchEvent(new CustomEvent(SL_TV_LAYOUT_EVENT));
        }
    }

    // Everything applyLayout put on <body>, removed.
    function clearLayout() {
        if (!document.body) {
            return;
        }

        SL_TV_POSITIONS.forEach(name =>
            document.body.classList.remove(SL_TV_POS_CLASS_PREFIX + name));
        document.body.classList.remove(SL_TV_STRIP_HIDDEN_CLASS);
        document.body.style.removeProperty(SL_TV_VAR_STRIP_V);
        document.body.style.removeProperty(SL_TV_VAR_STRIP_H);
        document.body.style.removeProperty(SL_TV_VAR_PILL_OFFSET);
        appliedPosition = null;
        lastToolbarKey = "";
        window.dispatchEvent(new CustomEvent(SL_TV_LAYOUT_EVENT));
    }

    // The filmstrip's current rendered size along the resizable axis.
    function getStripSize(position) {
        if (!filmstripEl) {
            return 0;
        }

        const rect = filmstripEl.getBoundingClientRect();

        return isVerticalPosition(position) ? rect.width : rect.height;
    }

    // Sets the size for the current orientation (clamped when applied).
    function setStripSize(position, size) {
        const box = getLayoutBox();

        if (isVerticalPosition(position)) {
            stripSizes.vertical = clamp(size, getVerticalBounds(box));
        } else {
            stripSizes.horizontal = clamp(size, getHorizontalBounds(box));
        }

        applyLayout();
    }

    // How far the boundary moved towards the stage (= the filmstrip grows).
    function dragDelta(position, event) {
        switch (position) {
            case "right": return drag.startX - event.clientX;
            case "left": return event.clientX - drag.startX;
            case "top": return event.clientY - drag.startY;
            default: return drag.startY - event.clientY;
        }
    }

    function onResizerPointerDown(event) {
        if (drag || (event.pointerType === "mouse" && event.button !== 0)) {
            return;
        }

        const position = root?.dataset.pos || "right";

        event.preventDefault();

        try {
            resizerEl.setPointerCapture(event.pointerId);
        } catch (error) {
            return;
        }

        drag = {
            pointerId: event.pointerId,
            position,
            startX: event.clientX,
            startY: event.clientY,
            startSize: getStripSize(position),
            lastEvent: null
        };

        root.classList.add("sl-tv-dragging");
    }

    function onResizerPointerMove(event) {
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }

        drag.lastEvent = { clientX: event.clientX, clientY: event.clientY };

        // At most one layout update per frame.
        if (!dragFrame) {
            dragFrame = requestAnimationFrame(() => {
                dragFrame = 0;

                if (drag && drag.lastEvent) {
                    setStripSize(drag.position, drag.startSize + dragDelta(drag.position, drag.lastEvent));
                }
            });
        }
    }

    function endDrag(event) {
        if (!drag || (event && event.pointerId !== drag.pointerId)) {
            return;
        }

        try {
            if (resizerEl && resizerEl.hasPointerCapture(drag.pointerId)) {
                resizerEl.releasePointerCapture(drag.pointerId);
            }
        } catch (error) {
            /* already released */
        }

        drag = null;
        root?.classList.remove("sl-tv-dragging");

        // Auto-hide waits for the drag; it counts once the pointer is out.
        armStripHide();
    }

    // Keyboard: the arrow pointing at the stage grows the filmstrip.
    function onResizerKeyDown(event) {
        const position = root?.dataset.pos || "right";
        const grow = { right: "ArrowLeft", left: "ArrowRight", top: "ArrowDown", bottom: "ArrowUp" }[position];
        const shrink = { right: "ArrowRight", left: "ArrowLeft", top: "ArrowUp", bottom: "ArrowDown" }[position];

        if (event.key !== grow && event.key !== shrink) {
            return;
        }

        event.preventDefault();
        setStripSize(position, getStripSize(position) + (event.key === grow ? SL_TV_KEY_STEP : -SL_TV_KEY_STEP));
    }

    // Horizontal filmstrip: a plain mouse wheel scrolls it sideways.
    function onFilmstripWheel(event) {
        if (!tilesEl || isVerticalPosition(root?.dataset.pos || "right")
            || Math.abs(event.deltaY) <= Math.abs(event.deltaX)
            || tilesEl.scrollWidth <= tilesEl.clientWidth) {
            return;
        }

        event.preventDefault();
        tilesEl.scrollLeft += event.deltaY;
    }

    function createResizer() {
        const el = document.createElement("div");

        el.className = "sl-tv-resizer";
        el.setAttribute("role", "separator");
        el.setAttribute("tabindex", "0");
        el.setAttribute("aria-label", "Resize participant filmstrip");
        el.title = "Drag to resize";

        el.addEventListener("pointerdown", onResizerPointerDown);
        el.addEventListener("pointermove", onResizerPointerMove);
        el.addEventListener("pointerup", endDrag);
        el.addEventListener("pointercancel", endDrag);
        el.addEventListener("lostpointercapture", endDrag);
        el.addEventListener("keydown", onResizerKeyDown);

        return el;
    }

    // Changes the teacher's preferred position (from the parent page or the
    // test hook). Takes effect at once if the view is showing.
    function setPreferredPosition(position) {
        if (!SL_TV_POSITIONS.includes(position) || position === preferredPosition) {
            return;
        }

        preferredPosition = position;
        applyLayout();
    }

    // ---- Filmstrip layout control (button + menu on the filmstrip) --------

    function isLayoutMenuOpen() {
        return Boolean(layoutMenuEl && !layoutMenuEl.hidden);
    }

    function createLayoutControl() {
        layoutButtonEl = document.createElement("button");
        layoutButtonEl.type = "button";
        layoutButtonEl.className = "sl-tv-layout-btn";
        layoutButtonEl.title = "Filmstrip position";
        layoutButtonEl.setAttribute("aria-label", "Filmstrip position");
        layoutButtonEl.setAttribute("aria-haspopup", "menu");
        layoutButtonEl.setAttribute("aria-expanded", "false");
        layoutButtonEl.innerHTML = SL_TV_LAYOUT_ICONS.button + '<span class="sl-tv-layout-label">Filmstrip</span>';
        layoutButtonEl.addEventListener("click", () => {
            if (isLayoutMenuOpen()) {
                closeLayoutMenu();
            } else {
                openLayoutMenu();
            }
        });

        layoutMenuEl = document.createElement("div");
        layoutMenuEl.className = "sl-tv-layout-menu";
        layoutMenuEl.setAttribute("role", "menu");
        layoutMenuEl.setAttribute("aria-label", "Filmstrip position");
        layoutMenuEl.hidden = true;

        const title = document.createElement("div");
        title.className = "sl-tv-layout-title";
        title.textContent = "Filmstrip position";
        layoutMenuEl.appendChild(title);

        SL_TV_POSITIONS.forEach(position => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "sl-tv-layout-item";
            item.dataset.position = position;
            item.setAttribute("role", "menuitemradio");
            // Static icon markup; the label is set as text.
            item.innerHTML = SL_TV_LAYOUT_ICONS[position] + "<span></span>";
            item.querySelector("span").textContent = SL_TV_POSITION_LABELS[position];
            item.addEventListener("click", () => chooseLayoutPosition(position));
            layoutMenuEl.appendChild(item);
        });

        const note = document.createElement("div");
        note.className = "sl-tv-layout-note";
        layoutMenuEl.appendChild(note);

        const divider = document.createElement("div");
        divider.className = "sl-tv-layout-divider";
        layoutMenuEl.appendChild(divider);

        // Auto-hide: a switch row (static markup; the label is set as text).
        autoHideSwitchEl = document.createElement("button");
        autoHideSwitchEl.type = "button";
        autoHideSwitchEl.className = "sl-tv-layout-switch";
        autoHideSwitchEl.setAttribute("role", "menuitemcheckbox");
        autoHideSwitchEl.innerHTML = '<span class="sl-tv-switch-label"></span><span class="sl-tv-switch-track" aria-hidden="true"><span class="sl-tv-switch-thumb"></span></span>';
        autoHideSwitchEl.querySelector(".sl-tv-switch-label").textContent = "Auto-hide filmstrip";
        autoHideSwitchEl.addEventListener("click", () => chooseAutoHide(!autoHideEnabled));
        layoutMenuEl.appendChild(autoHideSwitchEl);
    }

    // Checked = the teacher's choice. A note explains when the screen shows
    // it elsewhere (narrow portrait screen: bottom).
    function updateLayoutMenu() {
        if (!layoutMenuEl) {
            return;
        }

        layoutMenuEl.querySelectorAll(".sl-tv-layout-item").forEach(item => {
            item.setAttribute("aria-checked", item.dataset.position === preferredPosition ? "true" : "false");
        });

        const effective = root?.dataset.pos || preferredPosition;
        const note = layoutMenuEl.querySelector(".sl-tv-layout-note");

        note.textContent = effective !== preferredPosition
            ? "Shown at the bottom while the screen is narrow and upright."
            : "";

        autoHideSwitchEl?.setAttribute("aria-checked", autoHideEnabled ? "true" : "false");
    }

    // Bottom filmstrip: the menu opens upward, where Jitsi's toolbar floats
    // (it is drawn above our whole view, and on narrow screens spans the
    // width). If they overlap, the menu is lifted just above the toolbar and
    // its hide/show control. Otherwise CSS alone places the menu.
    function liftLayoutMenu() {
        if (!layoutMenuEl) {
            return;
        }

        layoutMenuEl.style.bottom = "";

        if (!isLayoutMenuOpen() || root?.dataset.pos !== "bottom") {
            return;
        }

        const menu = layoutMenuEl.getBoundingClientRect();
        const covers = [
            document.querySelector("#new-toolbox .toolbox-content-items"),
            document.getElementById("sl-toolbar-toggle")
        ]
            .map(el => el && getComputedStyle(el).visibility !== "hidden" ? el.getBoundingClientRect() : null)
            .filter(r => r && r.width > 0 && r.height > 0
                && r.left < menu.right && r.right > menu.left && r.top < menu.bottom && r.bottom > menu.top);

        if (covers.length === 0) {
            return;
        }

        const clearTop = Math.min(...covers.map(r => r.top)) - 6;
        const lift = Math.min(menu.bottom - clearTop, Math.max(menu.top - 4, 0));
        const current = parseFloat(getComputedStyle(layoutMenuEl).bottom) || 0;

        layoutMenuEl.style.bottom = Math.round(current + lift) + "px";
    }

    function openLayoutMenu() {
        if (!layoutMenuEl) {
            return;
        }

        updateLayoutMenu();
        layoutMenuEl.hidden = false;
        layoutButtonEl.setAttribute("aria-expanded", "true");
        liftLayoutMenu();

        document.addEventListener("pointerdown", onLayoutOutsidePointerDown, true);
        document.addEventListener("keydown", onLayoutKeyDown, true);
        window.addEventListener("blur", closeLayoutMenu);

        layoutMenuEl.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
    }

    function closeLayoutMenu() {
        document.removeEventListener("pointerdown", onLayoutOutsidePointerDown, true);
        document.removeEventListener("keydown", onLayoutKeyDown, true);
        window.removeEventListener("blur", closeLayoutMenu);

        if (layoutMenuEl) {
            layoutMenuEl.hidden = true;
        }

        layoutButtonEl?.setAttribute("aria-expanded", "false");
    }

    function onLayoutOutsidePointerDown(event) {
        if (layoutMenuEl?.contains(event.target) || layoutButtonEl?.contains(event.target)) {
            return;
        }

        closeLayoutMenu();
    }

    function onLayoutKeyDown(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            closeLayoutMenu();
            layoutButtonEl?.focus({ preventScroll: true });
        }
    }

    // The teacher's choice: applied here at once, and reported to the parent
    // page, which remembers it for the next reload / join.
    function chooseLayoutPosition(position) {
        if (!SL_TV_POSITIONS.includes(position)) {
            return;
        }

        setPreferredPosition(position);
        closeLayoutMenu();
        layoutButtonEl?.focus({ preventScroll: true });

        reportLayout();
    }

    // The teacher's auto-hide choice, from the switch in the layout menu. The
    // menu stays open so the change is visible.
    function chooseAutoHide(enabled) {
        setAutoHide(enabled);
        updateLayoutMenu();
        reportLayout();
    }

    // The parent page remembers both preferences for the next reload / join.
    function reportLayout() {
        slPostToParent({
            type: "SL_TEACHER_LAYOUT",
            v: 1,
            position: preferredPosition,
            autoHide: autoHideEnabled
        });
    }

    // ---- Filmstrip auto-hide ----------------------------------------------
    //
    // Inactivity is measured on the filmstrip, not the whole page: the timer
    // starts when the pointer leaves the filmstrip area (filmstrip, resize
    // handle, layout button and menu, edge handle) and is cancelled when it
    // comes back. The edge handle also collapses / restores it by hand,
    // whatever the auto-hide preference (never persisted either).
    // Hiding is CSS only (the filmstrip slides out with a negative margin and
    // keeps its size; its tiles and their video elements stay attached).
    // Jitsi's own filmstrip and receiver constraints are never touched.

    function isStripZone(target) {
        return Boolean(target && (
            filmstripEl?.contains(target)
            || resizerEl?.contains(target)
            || layoutButtonEl?.contains(target)
            || layoutMenuEl?.contains(target)
            || restoreEl?.contains(target)
        ));
    }

    function clearStripHideTimer() {
        if (stripHideTimer) {
            clearTimeout(stripHideTimer);
            stripHideTimer = null;
        }
    }

    function armStripHide() {
        clearStripHideTimer();

        if (!root || !autoHideEnabled || stripHidden || pointerInStrip || drag) {
            return;
        }

        stripHideTimer = setTimeout(onStripHideTimer, SL_TV_AUTO_HIDE_MS);
    }

    // Keyboard focus in the filmstrip area, while the keyboard is in use. A
    // mouse click's leftover focus does not count (like the toolbar's
    // auto-hide), and neither does focus left behind once the pointer is
    // used again (e.g. Escape on the menu returns focus to the button).
    function hasKeyboardFocusInStrip() {
        const active = document.activeElement;

        if (!keyboardInUse || !isStripZone(active)) {
            return false;
        }

        try {
            return active.matches(":focus-visible");
        } catch (error) {
            return false;
        }
    }

    // Why the filmstrip may not hide right now (empty: it may).
    function getStripBusyReasons() {
        const reasons = [];

        if (isLayoutMenuOpen()) reasons.push("layout menu");
        if (drag) reasons.push("resizing");
        if (pointerInStrip) reasons.push("pointer over filmstrip");
        if (hasKeyboardFocusInStrip()) reasons.push("keyboard focus");

        return reasons;
    }

    function onStripHideTimer() {
        stripHideTimer = null;

        if (!root || !autoHideEnabled || stripHidden) {
            return;
        }

        // Busy (e.g. a keyboard user inside it): try again later.
        if (getStripBusyReasons().length > 0) {
            armStripHide();
            return;
        }

        setStripHidden(true);
    }

    function setStripHidden(hidden) {
        if (stripHidden === hidden || (hidden && !root)) {
            return;
        }

        stripHidden = hidden;
        clearStripHideTimer();

        if (hidden) {
            closeLayoutMenu();
            endDrag();
            pointerInStrip = false;

            // Keyboard focus must not stay on a hidden (invisible) element.
            if (isStripZone(document.activeElement) && document.activeElement !== restoreEl && restoreEl) {
                restoreEl.focus({ preventScroll: true });
            }
        }

        applyLayout();

        // Shown again: hides again once the pointer has left it for a while.
        if (!hidden) {
            armStripHide();
        }
    }

    function setAutoHide(enabled) {
        autoHideEnabled = Boolean(enabled);

        if (!autoHideEnabled) {
            clearStripHideTimer();
            setStripHidden(false);
        } else {
            armStripHide();
        }
    }

    // Pointer entering / leaving the filmstrip area (any pointer type: a tap
    // on a tile enters it and, after the tap, leaves it).
    function onRootPointerOver(event) {
        const inside = isStripZone(event.target);

        if (inside === pointerInStrip) {
            return;
        }

        pointerInStrip = inside;

        if (inside) {
            clearStripHideTimer();
        } else {
            armStripHide();
        }
    }

    function onRootPointerLeave() {
        if (pointerInStrip) {
            pointerInStrip = false;
            armStripHide();
        }
    }

    // Activity inside the filmstrip area (clicks, taps, keys, scrolling)
    // restarts the wait; the timer itself only runs once the pointer is out.
    function onStripActivity(event) {
        if (isStripZone(event.target)) {
            armStripHide();
        }
    }

    function createRestoreHandle() {
        const el = document.createElement("button");

        el.type = "button";
        el.className = "sl-tv-restore";
        el.title = "Hide participants";
        el.setAttribute("aria-label", "Hide participant filmstrip");
        el.innerHTML = '<span class="sl-tv-restore-pill"></span>';
        // Shown: collapse it by hand; hidden: bring it back.
        el.addEventListener("click", () => setStripHidden(!stripHidden));

        return el;
    }

    function injectStyles() {
        if (document.getElementById("sl-teacher-view-style")) {
            return;
        }

        const style = document.createElement("style");

        style.id = "sl-teacher-view-style";

        // z-index 199 INSIDE #videoconference_page's stacking context (see
        // SL_TV_MOUNT_ID): above Jitsi's large video (1), below the toolbar
        // (.new-toolbox 252), the header (252) and the notifications in the
        // same page. Chat, side panels and dialogs are outside the page and
        // above it. Jitsi's own filmstrip (251) is hidden with visibility only
        // while this view shows, exactly like the Phase 2 grid does it.
        style.textContent = [
            "body." + SL_TV_ACTIVE_CLASS + " .filmstrip, body." + SL_TV_ACTIVE_CLASS + " .filmstrip * { visibility: hidden !important; }",
            "#" + SL_TV_ID + " { position: fixed; inset: 0; z-index: 199; display: none; box-sizing: border-box; overflow: hidden; background: #000000; }",
            "#" + SL_TV_ID + ".sl-visible { display: flex; flex-direction: row; }",
            "#" + SL_TV_ID + " .sl-tv-stage { position: relative; order: 0; flex: 1 1 auto; min-width: 0; height: 100%; overflow: hidden; background: #000000; pointer-events: none; }",
            "#" + SL_TV_ID + " .sl-tv-stage video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000000; }",
            "#" + SL_TV_ID + " .sl-tv-stage.sl-empty video { visibility: hidden; }",
            "#" + SL_TV_ID + " .sl-tv-stage-message { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; padding: 16px; color: #CBD5E1; font: 500 15px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; text-align: center; }",
            "#" + SL_TV_ID + " .sl-tv-stage.sl-empty .sl-tv-stage-message { display: flex; }",
            "#" + SL_TV_ID + " .sl-tv-stage-status { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); display: none; max-width: calc(100% - 32px); padding: 6px 12px; border-radius: 999px; background: rgba(15, 23, 42, 0.85); color: #F8FAFC; font: 500 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
            "#" + SL_TV_ID + " .sl-tv-stage.sl-weak .sl-tv-stage-status { display: block; }",
            "#" + SL_TV_ID + " .sl-mirror video { transform: scaleX(-1); }",
            "#" + SL_TV_ID + " .sl-tv-filmstrip { order: 2; position: relative; flex: 0 0 auto; width: var(" + SL_TV_VAR_STRIP_V + ", min(240px, 38vw)); height: 100%; box-sizing: border-box; display: flex; flex-direction: column; background: #0B1220; border-left: 1px solid rgba(148, 163, 184, 0.2); }",
            // The scrolling tiles (Phase A's filmstrip box).
            "#" + SL_TV_ID + " .sl-tv-tiles { flex: 1 1 auto; min-width: 0; min-height: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 8px; overflow-x: hidden; overflow-y: auto; }",

            // ---- Phase B: filmstrip position (data-pos on the root). Only
            // flex direction / order change: participant and video elements
            // stay where they are in the DOM. "right" (or no data-pos) is
            // exactly Phase A.
            "#" + SL_TV_ID + "[data-pos=left] .sl-tv-filmstrip { order: 0; border-left: 0; border-right: 1px solid rgba(148, 163, 184, 0.2); }",
            "#" + SL_TV_ID + "[data-pos=left] .sl-tv-stage { order: 2; }",
            "#" + SL_TV_ID + ".sl-visible[data-pos=top], #" + SL_TV_ID + ".sl-visible[data-pos=bottom] { flex-direction: column; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-stage, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-stage { width: 100%; height: auto; min-height: 0; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-filmstrip { order: 0; border-left: 0; border-top: 0; border-bottom: 1px solid rgba(148, 163, 184, 0.2); }",
            "#" + SL_TV_ID + "[data-pos=bottom] .sl-tv-filmstrip { border-left: 0; border-top: 1px solid rgba(148, 163, 184, 0.2); }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-stage { order: 2; }",
            // Horizontal filmstrip: one row, scrolling sideways; tiles take
            // the row's height and keep 16:9.
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-filmstrip, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-filmstrip { flex-direction: row; width: 100%; height: var(" + SL_TV_VAR_STRIP_H + ", 140px); }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-tiles, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-tiles { flex-direction: row; overflow-x: auto; overflow-y: hidden; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-tile, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-tile { width: auto; height: 100%; }",

            // ---- Phase B: resize handle on the stage/filmstrip boundary. It
            // takes no layout space; its hit area overlaps the boundary and
            // is its own element, so tile clicks are never affected.
            "#" + SL_TV_ID + " .sl-tv-resizer { position: relative; order: 1; flex: 0 0 0; z-index: 2; touch-action: none; outline: none; cursor: col-resize; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-resizer, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-resizer { cursor: row-resize; }",
            "#" + SL_TV_ID + " .sl-tv-resizer::before { content: ''; position: absolute; top: 0; bottom: 0; left: -6px; width: 12px; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-resizer::before, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-resizer::before { top: -6px; bottom: auto; left: 0; right: 0; width: auto; height: 12px; }",
            "@media (pointer: coarse) { #" + SL_TV_ID + " .sl-tv-resizer::before { left: -12px; width: 24px; } #" + SL_TV_ID + "[data-pos=top] .sl-tv-resizer::before, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-resizer::before { left: 0; top: -12px; width: auto; height: 24px; } }",
            // Subtle line, clearer on hover / focus / while dragging.
            "#" + SL_TV_ID + " .sl-tv-resizer::after { content: ''; position: absolute; top: 0; bottom: 0; left: -1px; width: 2px; border-radius: 2px; background: rgba(96, 165, 250, 0.75); opacity: 0; transition: opacity .15s ease; pointer-events: none; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-resizer::after, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-resizer::after { top: -1px; bottom: auto; left: 0; right: 0; width: auto; height: 2px; }",
            "#" + SL_TV_ID + " .sl-tv-resizer:hover::after, #" + SL_TV_ID + " .sl-tv-resizer:focus-visible::after, #" + SL_TV_ID + ".sl-tv-dragging .sl-tv-resizer::after { opacity: 1; }",
            "#" + SL_TV_ID + ".sl-tv-dragging { user-select: none; -webkit-user-select: none; }",
            "#" + SL_TV_ID + ".sl-tv-dragging, #" + SL_TV_ID + ".sl-tv-dragging * { cursor: inherit; }",
            "#" + SL_TV_ID + ".sl-tv-dragging[data-pos=left], #" + SL_TV_ID + ".sl-tv-dragging[data-pos=right] { cursor: col-resize; }",
            "#" + SL_TV_ID + ".sl-tv-dragging[data-pos=top], #" + SL_TV_ID + ".sl-tv-dragging[data-pos=bottom] { cursor: row-resize; }",

            // ---- Filmstrip settings: a footer inside the filmstrip (its own
            // DOM), holding the layout button; the menu opens from it.
            // Side filmstrips: a bar at the bottom (button with a label).
            // Top / bottom: a narrow column at the right end (icon only).
            // Clear of the page header, the toolbar and fullscreen controls.
            "#" + SL_TV_ID + " .sl-tv-strip-footer { position: relative; flex: 0 0 auto; display: flex; align-items: center; box-sizing: border-box; height: 44px; padding: 0 8px; border-top: 1px solid rgba(148, 163, 184, 0.14); }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-strip-footer, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-strip-footer { width: 40px; height: auto; flex-direction: column; justify-content: flex-start; padding: 6px 0; border-top: 0; border-left: 1px solid rgba(148, 163, 184, 0.14); }",
            "#" + SL_TV_ID + " .sl-tv-layout-btn { position: relative; display: flex; align-items: center; justify-content: flex-start; gap: 8px; box-sizing: border-box; width: 100%; height: 30px; padding: 0 8px; margin: 0; border-radius: 8px; border: 1px solid rgba(148, 163, 184, 0.2); background: rgba(15, 23, 42, 0.72); color: #94A3B8; font: 500 12px/1 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: color .15s ease, border-color .15s ease, background-color .15s ease; }",
            "#" + SL_TV_ID + " .sl-tv-layout-btn svg { flex: 0 0 auto; width: 16px; height: 16px; }",
            "#" + SL_TV_ID + " .sl-tv-layout-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-layout-btn, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-layout-btn { width: 28px; height: 28px; padding: 0; justify-content: center; }",
            // Top: the button at the column's bottom end, away from the top
            // edge (the page's fullscreen exit control sits at the top-right).
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-strip-footer { justify-content: flex-end; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-layout-label, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-layout-label { display: none; }",
            "#" + SL_TV_ID + " .sl-tv-layout-btn::before { content: ''; position: absolute; inset: -4px; }",
            "@media (hover: hover) and (pointer: fine) { #" + SL_TV_ID + " .sl-tv-layout-btn:hover { color: #E2E8F0; border-color: rgba(96, 165, 250, 0.5); background: rgba(30, 41, 59, 0.9); } }",
            "#" + SL_TV_ID + " .sl-tv-layout-btn[aria-expanded=true] { color: #BFDBFE; border-color: rgba(96, 165, 250, 0.6); background: rgba(30, 58, 138, 0.45); }",
            "#" + SL_TV_ID + " .sl-tv-layout-btn:focus-visible { outline: 2px solid #93C5FD; outline-offset: 1px; }",
            "@media (pointer: coarse) { #" + SL_TV_ID + " .sl-tv-strip-footer { height: 48px; } #" + SL_TV_ID + " .sl-tv-layout-btn { height: 36px; } #" + SL_TV_ID + "[data-pos=top] .sl-tv-layout-btn, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-layout-btn { width: 32px; height: 32px; } }",
            // The menu, relative to the footer (z-index within our view only):
            // above the footer of a side filmstrip, aligned to its outer edge;
            // below a top filmstrip / above a bottom one, at the right end.
            "#" + SL_TV_ID + " .sl-tv-layout-menu { bottom: calc(100% + 6px); right: 8px; }",
            "#" + SL_TV_ID + "[data-pos=left] .sl-tv-layout-menu { right: auto; left: 8px; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-layout-menu { bottom: auto; top: calc(100% + 6px); right: 4px; }",
            "#" + SL_TV_ID + "[data-pos=bottom] .sl-tv-layout-menu { bottom: calc(100% + 6px); right: 4px; }",
            "#" + SL_TV_ID + " .sl-tv-layout-menu { position: absolute; z-index: 4; box-sizing: border-box; width: 184px; padding: 6px; border-radius: 12px; border: 1px solid rgba(148, 163, 184, 0.2); background: rgba(15, 23, 42, 0.94); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 12px 32px rgba(2, 6, 23, 0.55); font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }",
            "#" + SL_TV_ID + " .sl-tv-layout-menu[hidden] { display: none; }",
            "#" + SL_TV_ID + " .sl-tv-layout-title { padding: 4px 8px 6px; color: #94A3B8; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }",
            "#" + SL_TV_ID + " .sl-tv-layout-item { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; min-height: 34px; padding: 6px 8px; margin: 0; border: 0; border-radius: 8px; background: transparent; color: #CBD5E1; font: 500 13px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; text-align: left; cursor: pointer; }",
            "#" + SL_TV_ID + " .sl-tv-layout-item svg { flex: 0 0 auto; width: 18px; height: 18px; color: #64748B; }",
            "@media (hover: hover) and (pointer: fine) { #" + SL_TV_ID + " .sl-tv-layout-item:hover { background: rgba(148, 163, 184, 0.1); color: #F1F5F9; } }",
            "#" + SL_TV_ID + " .sl-tv-layout-item:focus-visible { outline: 2px solid #93C5FD; outline-offset: -2px; }",
            "#" + SL_TV_ID + " .sl-tv-layout-item[aria-checked=true] { background: rgba(59, 130, 246, 0.16); color: #F8FAFC; }",
            "#" + SL_TV_ID + " .sl-tv-layout-item[aria-checked=true] svg { color: #60A5FA; }",
            "@media (pointer: coarse) { #" + SL_TV_ID + " .sl-tv-layout-item { min-height: 40px; } }",
            "#" + SL_TV_ID + " .sl-tv-layout-note { padding: 6px 8px 2px; color: #64748B; font-size: 11px; line-height: 1.35; }",
            "#" + SL_TV_ID + " .sl-tv-layout-note:empty { display: none; }",
            "#" + SL_TV_ID + " .sl-tv-layout-divider { height: 1px; margin: 6px 4px; background: rgba(148, 163, 184, 0.16); }",
            "#" + SL_TV_ID + " .sl-tv-layout-switch { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; box-sizing: border-box; min-height: 34px; padding: 6px 8px; margin: 0; border: 0; border-radius: 8px; background: transparent; color: #CBD5E1; font: 500 13px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; text-align: left; cursor: pointer; }",
            "@media (hover: hover) and (pointer: fine) { #" + SL_TV_ID + " .sl-tv-layout-switch:hover { background: rgba(148, 163, 184, 0.1); color: #F1F5F9; } }",
            "#" + SL_TV_ID + " .sl-tv-layout-switch:focus-visible { outline: 2px solid #93C5FD; outline-offset: -2px; }",
            "@media (pointer: coarse) { #" + SL_TV_ID + " .sl-tv-layout-switch { min-height: 40px; } }",
            "#" + SL_TV_ID + " .sl-tv-switch-track { position: relative; flex: 0 0 auto; width: 32px; height: 18px; border-radius: 999px; background: #334155; transition: background-color .15s ease; }",
            "#" + SL_TV_ID + " .sl-tv-switch-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #FFFFFF; transition: transform .15s ease; }",
            "#" + SL_TV_ID + " .sl-tv-layout-switch[aria-checked=true] .sl-tv-switch-track { background: #3B82F6; }",
            "#" + SL_TV_ID + " .sl-tv-layout-switch[aria-checked=true] .sl-tv-switch-thumb { transform: translateX(14px); }",

            // ---- Auto-hide: the filmstrip slides out of the view with a
            // negative margin equal to its own size, so the stage grows into
            // its place and the size is kept for the restore. visibility
            // makes the hidden tiles neither clickable nor focusable; their
            // video elements stay attached.
            "#" + SL_TV_ID + " .sl-tv-filmstrip { transition: margin .25s ease, visibility 0s linear 0s; }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden .sl-tv-filmstrip { visibility: hidden; transition: margin .25s ease, visibility 0s linear .25s; }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden[data-pos=right] .sl-tv-filmstrip { margin-right: calc(-1 * var(" + SL_TV_VAR_STRIP_V + ", min(240px, 38vw))); }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden[data-pos=left] .sl-tv-filmstrip { margin-left: calc(-1 * var(" + SL_TV_VAR_STRIP_V + ", min(240px, 38vw))); }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden[data-pos=top] .sl-tv-filmstrip { margin-top: calc(-1 * var(" + SL_TV_VAR_STRIP_H + ", 140px)); }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden[data-pos=bottom] .sl-tv-filmstrip { margin-bottom: calc(-1 * var(" + SL_TV_VAR_STRIP_H + ", 140px)); }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden .sl-tv-resizer, #" + SL_TV_ID + ".sl-tv-strip-hidden .sl-tv-layout-btn, #" + SL_TV_ID + ".sl-tv-strip-hidden .sl-tv-layout-menu { display: none; }",

            // ---- Edge handle, in the toolbar restore control's design
            // language: a small translucent pill inside a 44px+ touch target.
            // Shown filmstrip: a tab on its inner edge (collapses it). Hidden:
            // on the page edge (restores it). It moves with the filmstrip's
            // slide. Bottom / top: at the right end, away from the toolbar's
            // bottom-centre control and Jitsi's header.
            "#" + SL_TV_ID + " .sl-tv-restore { position: absolute; z-index: 3; display: none; box-sizing: border-box; width: 44px; height: 64px; padding: 0; margin: 0; border: 0; background: transparent; color: #CBD5E1; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; transition: right .25s ease, left .25s ease, top .25s ease, bottom .25s ease; }",
            "#" + SL_TV_ID + ".sl-visible .sl-tv-restore { display: flex; }",
            "#" + SL_TV_ID + " .sl-tv-restore-pill { display: flex; align-items: center; justify-content: center; box-sizing: border-box; border: 1px solid rgba(148, 163, 184, 0.16); background: rgba(17, 24, 39, 0.82); box-shadow: 0 6px 16px rgba(2, 6, 23, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.04); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); transition: background-color .15s ease, color .15s ease; }",
            "#" + SL_TV_ID + " .sl-tv-restore svg { width: 16px; height: 16px; }",
            "@media (hover: hover) and (pointer: fine) { #" + SL_TV_ID + " .sl-tv-restore:hover .sl-tv-restore-pill { background: rgba(31, 41, 55, 0.92); color: #F8FAFC; } }",
            "#" + SL_TV_ID + " .sl-tv-restore:focus-visible { outline: none; }",
            "#" + SL_TV_ID + " .sl-tv-restore:focus-visible .sl-tv-restore-pill { box-shadow: 0 0 0 2px #93C5FD; }",
            // Side positions: a vertical pill flush with the edge, centred.
            "#" + SL_TV_ID + "[data-pos=right] .sl-tv-restore, #" + SL_TV_ID + "[data-pos=left] .sl-tv-restore { top: 50%; transform: translateY(-50%); align-items: center; }",
            "#" + SL_TV_ID + "[data-pos=right] .sl-tv-restore { right: var(" + SL_TV_VAR_STRIP_V + ", min(240px, 38vw)); justify-content: flex-end; }",
            "#" + SL_TV_ID + "[data-pos=left] .sl-tv-restore { left: var(" + SL_TV_VAR_STRIP_V + ", min(240px, 38vw)); justify-content: flex-start; }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden[data-pos=right] .sl-tv-restore { right: 0; }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden[data-pos=left] .sl-tv-restore { left: 0; }",
            "#" + SL_TV_ID + "[data-pos=right] .sl-tv-restore-pill, #" + SL_TV_ID + "[data-pos=left] .sl-tv-restore-pill { width: 24px; height: 52px; }",
            "#" + SL_TV_ID + "[data-pos=right] .sl-tv-restore-pill { border-right: 0; border-radius: 12px 0 0 12px; }",
            "#" + SL_TV_ID + "[data-pos=left] .sl-tv-restore-pill { border-left: 0; border-radius: 0 12px 12px 0; }",
            // Top / bottom: a horizontal pill flush with the edge, at the right.
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-restore, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-restore { right: 24px; width: 64px; height: 44px; justify-content: center; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-restore { top: var(" + SL_TV_VAR_STRIP_H + ", 140px); align-items: flex-start; }",
            "#" + SL_TV_ID + "[data-pos=bottom] .sl-tv-restore { bottom: var(" + SL_TV_VAR_STRIP_H + ", 140px); align-items: flex-end; }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden[data-pos=top] .sl-tv-restore { top: 0; }",
            "#" + SL_TV_ID + ".sl-tv-strip-hidden[data-pos=bottom] .sl-tv-restore { bottom: 0; }",
            // A shown bottom filmstrip has the toolbar floating just above
            // it, which on narrow screens spans the width: its collapse handle
            // sits inside the filmstrip's own right gutter instead (below the
            // layout button), so the toolbar never covers it.
            "#" + SL_TV_ID + "[data-pos=bottom]:not(.sl-tv-strip-hidden) .sl-tv-restore { bottom: 4px; right: 0; width: 40px; height: 44px; align-items: center; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-restore-pill, #" + SL_TV_ID + "[data-pos=bottom] .sl-tv-restore-pill { width: 52px; height: 24px; }",
            "#" + SL_TV_ID + "[data-pos=top] .sl-tv-restore-pill { border-top: 0; border-radius: 0 0 12px 12px; }",
            "#" + SL_TV_ID + "[data-pos=bottom] .sl-tv-restore-pill { border-bottom: 0; border-radius: 12px 12px 0 0; }",
            "#" + SL_TV_ID + "[data-pos=bottom]:not(.sl-tv-strip-hidden) .sl-tv-restore-pill { width: 28px; height: 24px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); border-radius: 8px; }",

            // ---- Toolbar over a bottom filmstrip (position only; its design
            // is untouched): Jitsi's toolbar floats over the stage with its
            // bar 8px above the filmstrip, instead of the filmstrip leaving a
            // band free under the toolbar. Beats the server custom.css
            // "bottom: 28px !important". Not while the filmstrip is hidden.
            "body." + SL_TV_ACTIVE_CLASS + ".sl-tv-pos-bottom:not(." + SL_TV_STRIP_HIDDEN_CLASS + ") .new-toolbox { bottom: calc(var(" + SL_TV_VAR_STRIP_H + ", 140px) + 8px) !important; }",
            "body." + SL_TV_ACTIVE_CLASS + ".sl-tv-pos-bottom:not(." + SL_TV_STRIP_HIDDEN_CLASS + ") .new-toolbox .toolbox-content { margin-bottom: 0; }",
            "#" + SL_TV_ID + " .sl-tv-tile { position: relative; flex: 0 0 auto; width: 100%; aspect-ratio: 16 / 9; box-sizing: border-box; overflow: hidden; border-radius: 8px; border: 2px solid transparent; background: #111827; cursor: pointer; }",
            "#" + SL_TV_ID + " .sl-tv-tile:focus-visible { outline: 2px solid #93C5FD; outline-offset: 1px; }",
            // On stage: subtle blue border + "On stage" chip. Selected (the
            // teacher's own choice, Phase C): amber border + "Selected"
            // badge. Both can differ while a screen share has the stage.
            "#" + SL_TV_ID + " .sl-tv-tile.sl-on-stage { border-color: rgba(96, 165, 250, 0.85); }",
            "#" + SL_TV_ID + " .sl-tv-tile.sl-pinned { border-color: #F59E0B; box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.25); }",
            "#" + SL_TV_ID + " .sl-tv-tile video { display: block; width: 100%; height: 100%; object-fit: cover; background: #000000; }",
            "#" + SL_TV_ID + " .sl-tv-tile.sl-desktop video { object-fit: contain; }",
            "#" + SL_TV_ID + " .sl-tv-tile.sl-no-video video { visibility: hidden; }",
            "#" + SL_TV_ID + " .sl-tv-tile.sl-no-video .sl-tv-name { display: none; }",
            // Camera-off placeholder (tile and stage): role icon + name.
            "#" + SL_TV_ID + " .sl-tv-placeholder { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 6px; box-sizing: border-box; background: radial-gradient(120% 90% at 50% 35%, #172036 0%, #0F172A 55%, #0B1220 100%); color: #E2E8F0; text-align: center; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }",
            "#" + SL_TV_ID + " .sl-tv-tile.sl-no-video .sl-tv-placeholder { display: flex; }",
            // Icon badge per role: student = neutral slate with a hint of
            // blue, teacher = indigo/blue, screen share = teal.
            "#" + SL_TV_ID + " .sl-tv-icon { display: flex; align-items: center; justify-content: center; flex: 0 0 auto; box-sizing: border-box; width: 38px; height: 38px; border-radius: 50%; border: 1px solid rgba(147, 197, 253, 0.22); background: linear-gradient(150deg, rgba(148, 163, 184, 0.24) 0%, rgba(71, 85, 105, 0.16) 100%); color: #CBD5E1; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 2px 6px rgba(2, 6, 23, 0.35); }",
            "#" + SL_TV_ID + " .sl-tv-placeholder[data-variant=teacher] .sl-tv-icon { border-color: rgba(129, 140, 248, 0.5); background: linear-gradient(150deg, rgba(99, 102, 241, 0.32) 0%, rgba(59, 130, 246, 0.16) 100%); color: #C7D2FE; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 14px rgba(99, 102, 241, 0.18); }",
            "#" + SL_TV_ID + " .sl-tv-placeholder[data-variant=screen] .sl-tv-icon { border-color: rgba(45, 212, 191, 0.45); background: linear-gradient(150deg, rgba(20, 184, 166, 0.26) 0%, rgba(8, 145, 178, 0.14) 100%); color: #99F6E4; }",
            "#" + SL_TV_ID + " .sl-tv-icon svg { width: 56%; height: 56%; }",
            "#" + SL_TV_ID + " .sl-tv-ph-name { max-width: 100%; font-size: 12px; font-weight: 600; line-height: 1.3; letter-spacing: 0.01em; color: #F1F5F9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
            "#" + SL_TV_ID + " .sl-tv-ph-role { font-size: 11px; font-weight: 500; line-height: 1.3; color: #A5B4FC; }",
            "#" + SL_TV_ID + " .sl-tv-ph-role:empty { display: none; }",
            "#" + SL_TV_ID + " .sl-tv-stage.sl-placeholder video { visibility: hidden; }",
            "#" + SL_TV_ID + " .sl-tv-stage .sl-tv-placeholder { gap: 12px; padding: 24px; }",
            "#" + SL_TV_ID + " .sl-tv-stage.sl-placeholder .sl-tv-placeholder { display: flex; }",
            "#" + SL_TV_ID + " .sl-tv-stage .sl-tv-icon { width: 104px; height: 104px; border-width: 1.5px; }",
            "#" + SL_TV_ID + " .sl-tv-stage .sl-tv-ph-name { font-size: 20px; }",
            "#" + SL_TV_ID + " .sl-tv-stage .sl-tv-ph-role { font-size: 15px; }",
            "#" + SL_TV_ID + " .sl-tv-name { position: absolute; left: 6px; bottom: 6px; max-width: calc(100% - 12px); padding: 2px 6px; border-radius: 6px; background: rgba(15, 23, 42, 0.78); color: #F8FAFC; font: 500 11px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
            "#" + SL_TV_ID + " .sl-tv-pin { position: absolute; top: 6px; right: 6px; display: none; padding: 1px 7px; border-radius: 999px; border: 1px solid rgba(252, 211, 77, 0.5); background: rgba(120, 53, 15, 0.82); color: #FDE68A; font: 600 10px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; letter-spacing: 0.02em; }",
            "#" + SL_TV_ID + " .sl-tv-tile.sl-pinned .sl-tv-pin { display: block; }",
            "#" + SL_TV_ID + " .sl-tv-stage-chip { position: absolute; top: 6px; left: 6px; display: none; align-items: center; gap: 5px; padding: 1px 7px 1px 6px; border-radius: 999px; border: 1px solid rgba(96, 165, 250, 0.45); background: rgba(23, 37, 84, 0.82); color: #BFDBFE; font: 600 10px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; letter-spacing: 0.02em; }",
            "#" + SL_TV_ID + " .sl-tv-stage-chip::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #60A5FA; box-shadow: 0 0 6px rgba(96, 165, 250, 0.8); }",
            "#" + SL_TV_ID + " .sl-tv-tile.sl-on-stage .sl-tv-stage-chip { display: inline-flex; }"
        ].join("\n");

        document.head.appendChild(style);
    }

    // Jitsi's conference page (its own stacking context), or <body>.
    function getMountParent() {
        return document.getElementById(SL_TV_MOUNT_ID) || document.body;
    }

    function ensureRoot() {
        if (root) {
            // Jitsi (React) can replace its page element, e.g. after a
            // reconnect: move the view into the current one. Moving keeps
            // every attached track; playback is resumed by the render.
            const parent = getMountParent();

            if (root.parentNode !== parent) {
                parent.appendChild(root);
            }

            return;
        }

        injectStyles();

        root = document.createElement("div");
        root.id = SL_TV_ID;

        stageEl = document.createElement("div");
        stageEl.className = "sl-tv-stage";

        stageVideo = createVideo();

        stageMessageEl = document.createElement("div");
        stageMessageEl.className = "sl-tv-stage-message";

        stageStatusEl = document.createElement("div");
        stageStatusEl.className = "sl-tv-stage-status";

        stagePlaceholder = createPlaceholder();

        stageEl.appendChild(stageVideo);
        stageEl.appendChild(stageMessageEl);
        stageEl.appendChild(stageStatusEl);
        stageEl.appendChild(stagePlaceholder.el);

        filmstripEl = document.createElement("div");
        filmstripEl.className = "sl-tv-filmstrip";
        filmstripEl.setAttribute("aria-label", "Participants");

        tilesEl = document.createElement("div");
        tilesEl.className = "sl-tv-tiles";
        tilesEl.addEventListener("wheel", onFilmstripWheel, { passive: false });

        resizerEl = createResizer();
        createLayoutControl();
        restoreEl = createRestoreHandle();

        // The filmstrip settings belong to the filmstrip itself: a footer at
        // the bottom of a side filmstrip (a column at the end of a top /
        // bottom one), clear of the page header, Jitsi's toolbar and the
        // page's fullscreen controls. The menu opens from it.
        footerEl = document.createElement("div");
        footerEl.className = "sl-tv-strip-footer";
        footerEl.appendChild(layoutButtonEl);
        footerEl.appendChild(layoutMenuEl);

        filmstripEl.appendChild(tilesEl);
        filmstripEl.appendChild(footerEl);

        root.appendChild(stageEl);
        root.appendChild(resizerEl);
        root.appendChild(filmstripEl);
        root.appendChild(restoreEl);

        // Auto-hide: where the pointer is, relative to the filmstrip area.
        root.addEventListener("pointerover", onRootPointerOver);
        root.addEventListener("pointerleave", onRootPointerLeave);
        ["pointerdown", "keydown", "wheel"].forEach(type =>
            root.addEventListener(type, onStripActivity, { passive: true }));

        getMountParent().appendChild(root);

        // The page changes size with the window, chat, rotation: re-check the
        // effective position and clamp the sizes.
        if (typeof ResizeObserver === "function") {
            layoutObserver = layoutObserver || new ResizeObserver(applyLayout);
            layoutObserver.disconnect();
            layoutObserver.observe(root);
        }

        applyLayout();
    }

    // Camera-off placeholder: a role icon, the name and, for a teacher,
    // "(Teacher)". Static markup only; names are set as text, never as HTML.
    function createPlaceholder() {
        const el = document.createElement("div");
        el.className = "sl-tv-placeholder";

        const iconEl = document.createElement("div");
        iconEl.className = "sl-tv-icon";

        const nameEl = document.createElement("div");
        nameEl.className = "sl-tv-ph-name";

        const roleEl = document.createElement("div");
        roleEl.className = "sl-tv-ph-role";

        el.appendChild(iconEl);
        el.appendChild(nameEl);
        el.appendChild(roleEl);

        return { el, iconEl, nameEl, roleEl };
    }

    // variant: "teacher" | "student" | "screen"
    function setPlaceholder(placeholder, name, variant) {
        if (placeholder.el.dataset.variant !== variant) {
            placeholder.el.dataset.variant = variant;
            placeholder.iconEl.innerHTML = SL_ICONS[variant] || SL_ICONS.student;
        }

        placeholder.nameEl.textContent = name;
        placeholder.roleEl.textContent = variant === "teacher" ? "(Teacher)" : "";
    }

    function createVideo() {
        const video = document.createElement("video");

        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("muted", "");
        video.setAttribute("playsinline", "");

        return video;
    }

    function playVideo(video) {
        if (video && video.paused) {
            const playing = video.play();

            if (playing && typeof playing.catch === "function") {
                playing.catch(() => {});
            }
        }
    }

    // Always detach OUR element only: lib-jitsi-meet's detach() without an
    // argument would also detach Jitsi's own video elements.
    function detachFrom(jitsiTrack, video) {
        if (jitsiTrack && video) {
            try {
                jitsiTrack.detach(video);
            } catch (error) {
                /* track already disposed */
            }
        }

        if (video) {
            video.srcObject = null;
        }
    }

    function attachTo(jitsiTrack, video) {
        try {
            // Same existing track, one more element showing it.
            Promise.resolve(jitsiTrack.attach(video))
                .catch(error => console.warn("[SL Classroom] Teacher view attach failed:", error));

            return true;
        } catch (error) {
            console.warn("[SL Classroom] Teacher view attach failed:", error);

            return false;
        }
    }

    // ---- Phase C: stage selection ------------------------------------------
    //
    // Jitsi stays the source of truth for the stage: the custom stage keeps
    // mirroring features/large-video.participantId (resolveStage). This only
    // decides what Jitsi should PIN, with Jitsi's own PIN_PARTICIPANT, so its
    // receiver constraints request exactly what is shown (onStageSources).
    // Priority:
    //   1. a remote moderator's (co-teacher's) screen share
    //   2. a remote student's screen share
    //   3. the teacher's manual selection (a tile click)
    //   4. the teacher's own camera
    // Teacher (JWT moderator) only, Normal mode only (the view is showing).

    // Tile click: select that participant. Clicking the selected tile again
    // goes back to the teacher's own camera (never to Jitsi's dominant
    // speaker). The policy below does the pinning.
    function pinTile(tileId) {
        const state = getState();

        if (!state || !isLocalModerator(state) || !teacherView.enabled) {
            return;
        }

        const localId = state["features/base/participants"]?.local?.id ?? null;
        const selectedId = manualSelection === "self" ? localId : manualSelection;

        manualSelection = tileId === localId || tileId === selectedId ? "self" : tileId;

        applyStagePolicy(state);

        // The tile's "Selected" state changes even when the stage does not
        // (e.g. a screen share keeps the stage): redraw.
        lastSignature = "";
        render();
    }

    // The active remote screen shares, as the IDs Jitsi stages them by (a
    // share's virtual participant ID is its desktop source name), latest last
    // (Jitsi's own order), split by the sharer's JWT role.
    function getActiveRemoteShares(state) {
        const participants = state?.["features/base/participants"];
        const remote = participants?.remote;
        const order = state?.["features/video-layout"]?.remoteScreenShares;
        const shares = { moderator: [], student: [] };

        if (!remote || typeof remote.get !== "function" || !Array.isArray(order)) {
            return shares;
        }

        order.forEach(shareId => {
            // Jitsi stages a share only through its virtual participant.
            if (!remote.get(shareId)?.fakeParticipant) {
                return;
            }

            for (const [participantId, participant] of remote.entries()) {
                const info = participant && !participant.fakeParticipant
                    ? participant.sources?.get?.("video")?.get?.(shareId)
                    : null;

                if (info && info.videoType === "desktop") {
                    if (!info.muted && participantId !== participants.local?.id) {
                        (participant.role === "moderator" ? shares.moderator : shares.student).push(shareId);
                    }

                    return;
                }
            }
        });

        return shares;
    }

    // Who should be on the teacher's stage now (a Jitsi participant ID).
    function getDesiredStage(state) {
        const participants = state?.["features/base/participants"];
        const localId = participants?.local?.id ?? null;

        if (!localId) {
            return null;
        }

        const shares = getActiveRemoteShares(state);

        // A selected participant who left is forgotten (never kept as a
        // stale ID, never replaced by another student).
        if (manualSelection && manualSelection !== "self") {
            const selected = participants.remote?.get?.(manualSelection);

            if (!selected) {
                manualSelection = null;
            }
        }

        if (shares.moderator.length) {
            return shares.moderator[shares.moderator.length - 1];
        }

        if (shares.student.length) {
            return shares.student[shares.student.length - 1];
        }

        if (manualSelection && manualSelection !== "self") {
            return manualSelection;
        }

        return localId;
    }

    // Idempotent: pins only when Jitsi's pin is not already the desired one,
    // so it can run on every store change without fighting Jitsi. Should
    // Jitsi ignore a pin (its pin still unchanged since the attempt), the
    // same pin is not retried for a moment, so nothing loops.
    function applyStagePolicy(state) {
        if (!state || !teacherView.enabled || !isLocalModerator(state) || isExamGridShowing()) {
            return;
        }

        const desired = getDesiredStage(state);
        const pinned = state["features/base/participants"]?.pinnedParticipant ?? null;

        if (!desired || pinned === desired) {
            return;
        }

        const now = Date.now();

        if (lastPinAttempt.id === desired && lastPinAttempt.pinnedBefore === pinned
            && now - lastPinAttempt.at < 1500) {
            return;
        }

        lastPinAttempt = { id: desired, pinnedBefore: pinned, at: now };

        APP.store.dispatch({
            type: "PIN_PARTICIPANT",
            participant: { id: desired }
        });
    }

    function createTile(tileId) {
        const el = document.createElement("div");
        el.className = "sl-tv-tile";
        el.dataset.tileId = tileId;
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");

        const video = createVideo();

        const placeholder = createPlaceholder();

        const nameEl = document.createElement("div");
        nameEl.className = "sl-tv-name";

        const pinEl = document.createElement("div");
        pinEl.className = "sl-tv-pin";
        pinEl.textContent = "Selected";

        const stageChipEl = document.createElement("div");
        stageChipEl.className = "sl-tv-stage-chip";
        stageChipEl.textContent = "On stage";

        el.appendChild(video);
        el.appendChild(placeholder.el);
        el.appendChild(nameEl);
        el.appendChild(pinEl);
        el.appendChild(stageChipEl);

        el.addEventListener("click", () => pinTile(tileId));
        el.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                pinTile(tileId);
            }
        });

        const tile = { el, video, nameEl, placeholder, jitsiTrack: null };

        tiles.set(tileId, tile);

        return tile;
    }

    function removeTile(tileId) {
        const tile = tiles.get(tileId);

        if (!tile) {
            return;
        }

        detachFrom(tile.jitsiTrack, tile.video);
        tile.jitsiTrack = null;
        tile.el.remove();
        tiles.delete(tileId);
    }

    function onStageStatusChanged() {
        lastSignature = "";
        render();
    }

    function setStageTrack(jitsiTrack) {
        if (stageTrack === jitsiTrack) {
            return;
        }

        if (stageTrack) {
            try {
                if (typeof stageTrack.off === "function") {
                    stageTrack.off(SL_STREAMING_STATUS_EVENT, onStageStatusChanged);
                }
            } catch (error) {
                /* track already disposed */
            }

            detachFrom(stageTrack, stageVideo);
        }

        stageTrack = null;

        if (jitsiTrack && attachTo(jitsiTrack, stageVideo)) {
            stageTrack = jitsiTrack;

            try {
                if (typeof jitsiTrack.on === "function") {
                    jitsiTrack.on(SL_STREAMING_STATUS_EVENT, onStageStatusChanged);
                }
            } catch (error) {
                /* status stays unknown: nothing is shown for it */
            }
        }
    }

    // Removes the whole view: every tile and the stage detached, out of the
    // DOM, and Jitsi's own filmstrip visible again.
    function hide() {
        lastSignature = "";

        document.body?.classList.toggle(SL_TV_ACTIVE_CLASS, false);

        if (!root) {
            return;
        }

        Array.from(tiles.keys()).forEach(removeTile);
        setStageTrack(null);

        // Layout: the preference and sizes stay (module state); only what is
        // on the page goes.
        closeLayoutMenu();
        endDrag();

        if (dragFrame) {
            cancelAnimationFrame(dragFrame);
            dragFrame = 0;
        }

        if (layoutObserver) {
            layoutObserver.disconnect();
        }

        // The hidden state is not kept: back in Normal mode (or re-enabled)
        // the filmstrip is shown. The auto-hide preference stays.
        clearStripHideTimer();
        stripHidden = false;
        pointerInStrip = false;

        // Phase C: a selection does not outlive the view (Exam Mode ->
        // Normal starts from the teacher's own camera again).
        manualSelection = null;
        lastPinAttempt = { id: null, at: 0 };
        lastStageId = null;
        clearTimeout(stageLoadingTimer);
        stageLoadingTimer = null;

        clearLayout();

        root.remove();
        root = null;
        stageEl = null;
        stageVideo = null;
        stageMessageEl = null;
        stageStatusEl = null;
        stagePlaceholder = null;
        filmstripEl = null;
        tilesEl = null;
        footerEl = null;
        resizerEl = null;
        layoutButtonEl = null;
        layoutMenuEl = null;
        autoHideSwitchEl = null;
        restoreEl = null;
    }

    function render() {
        // A render can change the body class, which re-triggers render.
        if (rendering) {
            return;
        }

        rendering = true;

        try {
            renderNow();
        } finally {
            rendering = false;
        }
    }

    function renderNow() {
        // Teacher (JWT moderator) + enabled by the parent page + not Exam.
        if (!getState() || !teacherView.enabled || !isLocalModerator(getState()) || isExamGridShowing()) {
            hide();
            return;
        }

        // Phase C: steer Jitsi's pin first (it may dispatch), then render
        // from the store as it is afterwards.
        applyStagePolicy(getState());

        const state = getState();
        const items = collectTiles(state);
        const stage = resolveStage(state);
        const status = stage.track ? getStreamingStatus(stage.track) : null;

        // A newly staged source takes a moment to start arriving (the bridge
        // starts forwarding, then a keyframe): "Loading video…" instead of
        // "paused to save bandwidth" for that moment only.
        if (stage.id !== lastStageId) {
            lastStageId = stage.id;
            stageChangedAt = Date.now();
            clearTimeout(stageLoadingTimer);
            stageLoadingTimer = setTimeout(() => {
                stageLoadingTimer = null;
                lastSignature = "";
                render();
            }, SL_TV_STAGE_LOADING_MS);
        }

        const stageLoading = Date.now() - stageChangedAt < SL_TV_STAGE_LOADING_MS;
        const statusMessage = stage.local
            ? ""
            : stageLoading && status === "inactive"
                ? "Loading video…"
                : (status && SL_STATUS_MESSAGES[status]) || "";

        // The store changes constantly; only touch the DOM when what the view
        // shows actually changed.
        const signature = JSON.stringify([
            items.map(item => [
                item.id, item.name, item.kind, item.role, item.local,
                trackKey(item.track && item.track.jitsiTrack),
                item.muted, item.pinned, item.onStage
            ]),
            [stage.id, trackKey(stage.track), stage.empty, statusMessage, stage.local,
                stage.placeholder ? [stage.placeholder.name, stage.placeholder.role] : null]
        ]);

        // Unchanged, and still mounted in Jitsi's current page element.
        if (signature === lastSignature && root && root.parentNode === getMountParent()) {
            return;
        }

        lastSignature = signature;
        ensureRoot();
        applyLayout();

        // Tiles.
        const wanted = new Set(items.map(item => item.id));

        Array.from(tiles.keys())
            .filter(tileId => !wanted.has(tileId))
            .forEach(removeTile);

        items.forEach(item => {
            const tile = tiles.get(item.id) || createTile(item.id);
            const jitsiTrack = item.track && !item.muted ? item.track.jitsiTrack : null;

            if (tile.jitsiTrack !== jitsiTrack) {
                detachFrom(tile.jitsiTrack, tile.video);
                tile.jitsiTrack = null;

                if (jitsiTrack && attachTo(jitsiTrack, tile.video)) {
                    tile.jitsiTrack = jitsiTrack;
                }
            }

            tile.nameEl.textContent = item.name;
            tile.el.title = item.name;
            tile.el.setAttribute("aria-pressed", item.pinned ? "true" : "false");
            setPlaceholder(
                tile.placeholder,
                item.name,
                item.kind === "desktop" ? "screen" : item.role
            );
            tile.el.classList.toggle("sl-no-video", !tile.jitsiTrack);
            tile.el.classList.toggle("sl-mirror", item.local && item.kind === "camera");
            tile.el.classList.toggle("sl-desktop", item.kind === "desktop");
            tile.el.classList.toggle("sl-pinned", item.pinned);
            tile.el.classList.toggle("sl-on-stage", item.onStage);

            if (tile.jitsiTrack) {
                playVideo(tile.video);
            }

            // Appending moves the tile into list order.
            tilesEl.appendChild(tile.el);
        });

        // Stage.
        setStageTrack(stage.track);

        stageEl.classList.toggle("sl-empty", Boolean(stage.empty));
        stageEl.classList.toggle("sl-placeholder", Boolean(stage.placeholder));
        stageEl.classList.toggle("sl-mirror", stage.local);
        stageMessageEl.textContent = stage.empty;

        if (stage.placeholder) {
            setPlaceholder(stagePlaceholder, stage.placeholder.name, stage.placeholder.role);
        }
        stageEl.classList.toggle("sl-weak", Boolean(statusMessage));
        stageStatusEl.textContent = statusMessage;

        if (stageTrack) {
            playVideo(stageVideo);
        }

        root.classList.add("sl-visible");
        document.body.classList.toggle(SL_TV_ACTIVE_CLASS, true);
    }

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_TEACHER_VIEW") {
            return;
        }

        // position and autoHide (Phase B) are optional: absent keeps the
        // current value.
        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || typeof data.enabled !== "boolean"
            || (data.position !== undefined && !SL_TV_POSITIONS.includes(data.position))
            || (data.autoHide !== undefined && typeof data.autoHide !== "boolean")) {
            console.warn("[SL Classroom] Ignored malformed teacher view", data);

            return;
        }

        // An older message must never overwrite a newer one. The same epoch
        // is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < teacherView.epoch) {
            return;
        }

        // Kept even before the local role is known: the view itself only
        // ever shows while the local participant is a moderator.
        teacherView = {
            epoch: data.epoch,
            enabled: data.enabled
        };

        if (data.position !== undefined) {
            setPreferredPosition(data.position);
        }

        if (data.autoHide !== undefined && data.autoHide !== autoHideEnabled) {
            setAutoHide(data.autoHide);
        }

        console.log("[SL Classroom] Teacher view", teacherView,
            "filmstrip:", preferredPosition, "auto-hide:", autoHideEnabled);

        lastSignature = "";
        render();
    });

    // ---------------------------------------------------------------------
    // PHASE A TESTING ONLY - lets a tester switch the view on/off from the
    // Jitsi iframe's DevTools console (e.g. with a Local Override of this
    // file against a page that does not send SL_TEACHER_VIEW):
    //   __slTeacherViewTest.on()   __slTeacherViewTest.off()
    //   __slTeacherViewTest.position("left")   (right | left | top | bottom)
    //   __slTeacherViewTest.autoHide(true)      filmstrip auto-hide on/off
    //   __slTeacherViewTest.hide() / .show()    hide / restore it now
    //   __slTeacherViewTest.layout()            current layout state
    //   __slTeacherViewTest.state()             position, auto-hide, hidden,
    //                                           timer, why it waits
    // Local only (nothing is reported to the parent page). Still teacher-only
    // and hidden during Exam Mode. The next SL_TEACHER_VIEW from the parent
    // page replaces it.
    // ---------------------------------------------------------------------
    window.__slTeacherViewTest = {
        on: () => {
            teacherView = { epoch: teacherView.epoch, enabled: true };
            lastSignature = "";
            render();
        },
        off: () => {
            teacherView = { epoch: teacherView.epoch, enabled: false };
            render();
        },
        position: position => setPreferredPosition(position),
        autoHide: enabled => {
            setAutoHide(enabled);
            updateLayoutMenu();
        },
        hide: () => setStripHidden(true),
        show: () => setStripHidden(false),
        layout: () => ({
            preferred: preferredPosition,
            effective: root ? root.dataset.pos : null,
            sizes: { ...stripSizes },
            rendered: root ? Math.round(getStripSize(root.dataset.pos)) : null
        }),
        state: () => ({
            showing: Boolean(root),
            position: preferredPosition,
            effectivePosition: root ? root.dataset.pos : null,
            autoHide: autoHideEnabled,
            hidden: stripHidden,
            timerActive: Boolean(stripHideTimer),
            pointerInStrip,
            busy: getStripBusyReasons()
        })
    };

    // Which input is in use (auto-hide: keyboard focus holds the filmstrip
    // only while the keyboard is used). Passive and read-only.
    document.addEventListener("keydown", () => { keyboardInUse = true; }, { capture: true, passive: true });
    ["pointermove", "pointerdown"].forEach(type =>
        document.addEventListener(type, () => { keyboardInUse = false; }, { capture: true, passive: true }));

    // Page teardown: detach every element of ours.
    window.addEventListener("pagehide", hide);

    // Follow every store change (participants, tracks, mute, pin, large
    // video, local role) and the Exam grid appearing/disappearing (Phase 2's
    // body class), so Normal -> Exam hides this view at once.
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function" || !document.body) {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(render);

        if (typeof MutationObserver === "function") {
            new MutationObserver(render)
                .observe(document.body, { attributes: true, attributeFilter: ["class"] });
        }

        render();
    }, 500);

    console.log(
        "======== SL CLASSROOM TEACHER NORMAL VIEW (PHASE A) LOADED ========"
    );

})();



/* ==========================================================
   SL Classroom - Toolbar Polish (compact look + hide/show)

   Presentation only, for any participant whose page enables it.
   Jitsi's own toolbar (#new-toolbox, build 9268) is restyled and
   can be slid out of view with CSS; its React state, buttons and
   actions are never touched, so every control works exactly as
   before once it is shown again.

   - Compact pill-shaped bar, 40x40 buttons with small 15px icons,
     each icon in a muted accent colour (mic indigo, camera blue,
     screen share teal, ...); a muted mic/camera is neutral; hangup
     stays red. The mic/camera device arrow shows on hover.
   - Hide/show: one small control of ours. While the toolbar is
     shown it sits just above the bar's right end ("hide"); while
     hidden it is a small pill at the bottom centre ("show").
   - Optional auto-hide after a few seconds without activity;
     pointer, touch or key activity shows the toolbar again. Never
     hides while a toolbar menu, a dialog, a settings popup or a
     notification waiting for the user is open, or while the
     toolbar is hovered or keyboard-focused.

   Jitsi's own toolbox hiding (features/toolbox.visible) is not
   used: it refuses to hide while toolbarConfig.alwaysVisible is
   set (as SL Classroom does), and re-shows on every mouse move.

   Off by default. Parent page -> iframe (resent after
   SL_RECEIVE_READY):
     { type: "SL_TOOLBAR_VIEW", v: 1, epoch, enabled, autoHide }
========================================================== */

(function () {

    const SL_TB_POLISH_CLASS = "sl-toolbar-polish";
    const SL_TB_HIDDEN_CLASS = "sl-toolbar-hidden";
    const SL_TB_TOGGLE_ID = "sl-toolbar-toggle";
    // Same stacking context as Jitsi's toolbar (see the teacher view above):
    // the control (z-index 253) sits just above the toolbar (252) and below
    // Jitsi's drawers (351) and notifications (600). Dialogs are outside the
    // page and above it.
    const SL_TB_MOUNT_ID = "videoconference_page";
    const SL_TB_AUTO_HIDE_MS = 4000;
    const SL_TB_ACTIVITY_EVENTS = ["pointermove", "pointerdown", "touchstart", "keydown", "wheel"];

    const SL_TB_CHEVRON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>';
    const SL_TB_CHEVRON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14.5l6-6 6 6"/></svg>';

    // The view in effect: the console test view while one is set (see
    // __slToolbarTest), otherwise the parent page's. The parent resends its
    // view (same epoch) after every SL_RECEIVE_READY; kept apart, that resend
    // cannot silently undo a test.
    let toolbarView = { epoch: 0, enabled: false, autoHide: false };
    let parentView = { epoch: 0, enabled: false, autoHide: false };
    let testView = null;

    // Hidden by the user (stays hidden until restored) or by auto-hide
    // (any activity shows it again).
    let manualHidden = false;
    let autoHidden = false;

    let autoHideTimer = null;
    let lastActivityAt = 0;
    let lastToolbarShown = false;
    let toggleEl = null;
    let resizeObserver = null;
    let observedBar = null;

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    function isHidden() {
        return manualHidden || autoHidden;
    }

    function getToolbar() {
        return document.getElementById("new-toolbox");
    }

    function getBar() {
        return getToolbar()?.querySelector?.(".toolbox-content-items") || null;
    }

    // A notification that waits for the user: sticky (Jitsi stores no
    // timeout for those) or with action buttons. Ordinary ones close by
    // themselves and do not hold the toolbar.
    function isInteractiveNotification(notification) {
        const actions = notification?.props?.customActionNameKey;

        return Boolean(notification)
            && (!notification.timeout || (Array.isArray(actions) && actions.length > 0));
    }

    // Keyboard focus inside the toolbar. A mouse click leaves DOM focus on
    // the clicked button (Jitsi's buttons are tabindex=0 divs), which must
    // not count: otherwise one click on the mic stops auto-hide for good.
    function hasKeyboardFocusInToolbar() {
        const toolbar = getToolbar();
        const active = document.activeElement;

        if (!toolbar || !active || active === document.body || !toolbar.contains(active)) {
            return false;
        }

        try {
            return active.matches(":focus-visible");
        } catch (error) {
            return false;
        }
    }

    // What the user is in the middle of: a toolbar menu, a dialog, a device
    // settings popup, a notification waiting for them, the toolbar hovered
    // or keyboard-focused. Empty when nothing is.
    function getBusyReasons(state) {
        const toolbox = state?.["features/toolbox"] || {};
        const settings = state?.["features/settings"] || {};
        const notifications = state?.["features/notifications"]?.notifications;
        const reasons = [];

        if (toolbox.overflowMenuVisible) reasons.push("overflow menu");
        if (toolbox.hangupMenuVisible) reasons.push("hangup menu");
        if (toolbox.hovered) reasons.push("toolbar hovered");
        if (state?.["features/base/dialog"]?.component) reasons.push("dialog");
        if (settings.audioSettingsVisible) reasons.push("audio device menu");
        if (settings.videoSettingsVisible) reasons.push("video device menu");
        if (Array.isArray(notifications) && notifications.some(isInteractiveNotification)) {
            reasons.push("notification");
        }
        if (hasKeyboardFocusInToolbar()) reasons.push("keyboard focus");

        return reasons;
    }

    function isBusy(state) {
        return getBusyReasons(state).length > 0;
    }

    function injectStyles() {
        if (document.getElementById("sl-toolbar-style")) {
            return;
        }

        const style = document.createElement("style");

        style.id = "sl-toolbar-style";

        const P = "body." + SL_TB_POLISH_CLASS + " .new-toolbox";

        // Icon accent per button, matched on Jitsi's own aria-label (build
        // 9268 English labels; a label that does not match keeps the neutral
        // default). Only CSS custom properties are set here, inherited by
        // the button's .toolbox-icon: rest / strong icon colour and the RGB
        // of the matching background tint.
        const accent = (labels, rest, strong, rgb) =>
            labels.map(label => P + ' [aria-label*="' + label + '" i]').join(", ")
            + " { --sl-ic: " + rest + "; --sl-ic-hi: " + strong + "; --sl-rgb: " + rgb
            + "; --sl-on-ic: " + strong + "; --sl-on-rgb: " + rgb + "; }";

        // Mic / camera: Jitsi marks a MUTED device as .toggled, so "on" is
        // a not-toggled, not-disabled icon.
        const DEVICE = ['[aria-label*="microphone" i]', '[aria-label*="camera" i]'];
        const device = suffix => DEVICE.map(sel => P + " " + sel + " .toolbox-icon" + suffix).join(", ");

        // All rules are scoped to the body class, so removing it restores
        // Jitsi's own look exactly. Jitsi's own styles are global JSS rules
        // (.toolbox-content-items, .toolbox-icon) that these out-rank.
        style.textContent = [
            // Slide out with CSS only. visibility makes the hidden buttons
            // neither clickable nor focusable; Jitsi's own state stays as is.
            P + " { transition: bottom .3s ease-in, transform .25s ease, opacity .2s ease, visibility 0s linear 0s; }",
            "body." + SL_TB_POLISH_CLASS + "." + SL_TB_HIDDEN_CLASS + " .new-toolbox { transform: translateY(calc(100% + 24px)); opacity: 0; visibility: hidden; transition: bottom .3s ease-in, transform .25s ease, opacity .2s ease, visibility 0s linear .25s; }",

            // ---- Bar: one compact, translucent, rounded container. ----
            P + " .toolbox-content { margin-bottom: 12px; }",
            P + " .toolbox-content-items { display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 16px; border: 1px solid rgba(148, 163, 184, 0.16); background: rgba(17, 24, 39, 0.82); box-shadow: 0 10px 28px rgba(2, 6, 23, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.04); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }",
            // Jitsi adds a 16px right margin to every child; the gap above
            // replaces it.
            P + " .toolbox-content-items > * { margin: 0; flex: 0 0 auto; }",
            // Jitsi's button wrappers are inline-blocks with a 3rem (48px)
            // line-height around the icon, which skews heights and spacing.
            P + " .toolbox-button, " + P + " .toolbox-button-wth-dialog { display: flex; align-items: center; justify-content: center; line-height: 0; }",

            // ---- The server's custom.css (meet.slclassroom.live/custom.css)
            // paints the button WRAPPER blue on hover and when aria-pressed
            // (which Jitsi sets on a MUTED mic/camera), with !important. That
            // square sits behind our icon and hides its accent / state, so
            // while the polish is on it is made transparent. Its size and
            // lift are left as they are.
            P + " .toolbox-button:hover, " + P + " .toolbox-button[aria-pressed=\"true\"] { background: transparent !important; }",

            // ---- Icon accents (Tailwind 400 tones: clearly coloured on the
            // dark bar, still muted; 300 on hover / when on). ----
            // Neutral default; toggled buttons without an accent of their own
            // (e.g. raise hand) keep the teal "on" look they had before.
            P + " { --sl-ic: #CBD5E1; --sl-ic-hi: #F1F5F9; --sl-rgb: 148, 163, 184; --sl-on-ic: #5EEAD4; --sl-on-rgb: 45, 212, 191; }",
            accent(["microphone"], "#818CF8", "#A5B4FC", "129, 140, 248"),
            accent(["camera"], "#60A5FA", "#93C5FD", "96, 165, 250"),
            accent(["your screen"], "#2DD4BF", "#5EEAD4", "45, 212, 191"),
            accent(["statistics", "video quality"], "#FBBF24", "#FCD34D", "245, 158, 11"),
            accent(["full screen"], "#A78BFA", "#C4B5FD", "139, 92, 246"),
            accent(["security"], "#34D399", "#6EE7B7", "16, 185, 129"),
            accent(["audio only", "share audio", "sound device"], "#C084FC", "#D8B4FE", "168, 85, 247"),
            accent(["background"], "#94A3B8", "#CBD5E1", "100, 116, 139"),
            accent(["more actions"], "#CBD5E1", "#F1F5F9", "148, 163, 184"),

            // ---- Every button: the same 40x40 footprint and look, with a
            // small 15px icon. The size needs !important: the server's
            // custom.css forces ".toolbox-icon svg { 22px !important }". ----
            P + " .toolbox-icon { box-sizing: border-box; width: 40px; height: 40px; align-items: center; justify-content: center; border-radius: 12px; background-color: rgba(255, 255, 255, 0.04); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06); transition: background-color .15s ease, box-shadow .15s ease; }",
            P + " .toolbox-icon svg { width: 15px !important; height: 15px !important; fill: var(--sl-ic); transition: fill .15s ease; }",
            "@media (hover: hover) and (pointer: fine) { "
                + P + " .toolbox-icon:not(.disabled):not(.hangup-button):hover { background-color: rgba(var(--sl-rgb), 0.12); box-shadow: inset 0 0 0 1px rgba(var(--sl-rgb), 0.24); } "
                + P + " .toolbox-icon:not(.disabled):not(.hangup-button):hover svg { fill: var(--sl-ic-hi); } }",

            // Toggled (e.g. screen share on, full screen, hand raised).
            P + " .toolbox-icon.toggled:not(.disabled) { background-color: rgba(var(--sl-on-rgb), 0.14); box-shadow: inset 0 0 0 1px rgba(var(--sl-on-rgb), 0.38); }",
            P + " .toolbox-icon.toggled:not(.disabled) svg { fill: var(--sl-on-ic); }",

            // ---- Mic / camera ----
            // ON: dark button, accent icon, faint accent edge. MUTED
            // (.toggled): neutral, never the accent.
            device(":not(.toggled):not(.disabled)") + " { background-color: rgba(var(--sl-rgb), 0.08); box-shadow: inset 0 0 0 1px rgba(var(--sl-rgb), 0.3); }",
            device(":not(.toggled):not(.disabled) svg") + " { fill: var(--sl-ic); }",
            device(".toggled:not(.disabled)") + " { background-color: rgba(255, 255, 255, 0.04); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06); }",
            device(".toggled:not(.disabled) svg") + " { fill: #94A3B8; }",
            "@media (hover: hover) and (pointer: fine) { "
                + device(":not(.toggled):not(.disabled):hover") + " { background-color: rgba(var(--sl-rgb), 0.16); box-shadow: inset 0 0 0 1px rgba(var(--sl-rgb), 0.45); } "
                + device(":not(.toggled):not(.disabled):hover svg") + " { fill: var(--sl-ic-hi); } "
                + device(".toggled:not(.disabled):hover") + " { background-color: rgba(255, 255, 255, 0.08); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); } "
                + device(".toggled:not(.disabled):hover svg") + " { fill: #CBD5E1; } }",

            // Unavailable (no permission, GUM pending): dim, never accented.
            P + " .toolbox-icon.disabled svg { fill: #64748B; }",

            // Device-menu arrow. Jitsi 9268 markup:
            //   .settings-button-container          (position: relative)
            //     .toolbox-button > .toolbox-icon    (the mute button)
            //     div > .settings-button-small-icon  (tooltip wrapper; Jitsi
            //                                         places it absolutely)
            //           > .jitsi-icon#audio|video-settings-button[role=button]
            //             (the REAL trigger: click + keyboard) > svg
            // Only position / size / colour / opacity change: the wrapper
            // becomes a 16px corner hit area INSIDE the 40px control's
            // top-right corner, the trigger fills it (so the whole area
            // clicks), and the visible chevron is 8px with no box behind it.
            P + " .settings-button-container { position: relative; display: flex; align-items: center; width: 40px; height: 40px; border-radius: 12px; background: none; box-shadow: none; }",
            P + " .settings-button-small-icon, " + P + " .settings-button-small-icon:hover { position: absolute; top: 0; right: 0; z-index: 1; display: block; box-sizing: border-box; width: 16px; height: 16px; padding: 0; border-radius: 0 12px 0 6px; background: transparent; box-shadow: none; }",
            P + " .settings-button-small-icon > .jitsi-icon { display: flex; align-items: flex-start; justify-content: flex-end; box-sizing: border-box; width: 100%; height: 100%; padding: 4px 4px 0 0; border-radius: inherit; cursor: pointer; }",
            P + " .settings-button-small-icon svg { width: 8px !important; height: 8px !important; fill: #94A3B8; transition: fill .15s ease, opacity .15s ease; }",
            // Mouse / trackpad: the chevron fades in only while the control is
            // hovered, keyboard-focused, or its device menu is open. The
            // trigger itself stays in place (opacity only), so it is always
            // clickable. Touch screens (no hover) keep it visible, so device
            // selection never depends on hover there.
            "@media (hover: hover) and (pointer: fine) { "
                + P + " .settings-button-small-icon svg { opacity: 0; } "
                + P + " .settings-button-container:hover .settings-button-small-icon svg, "
                + P + " .settings-button-container:has(:focus-visible) .settings-button-small-icon svg, "
                + P + " .settings-button-small-icon > .jitsi-icon[aria-expanded=\"true\"] svg { opacity: 1; } "
                + P + " .settings-button-small-icon:not(.settings-button-small-icon--disabled):hover svg { fill: #F1F5F9; } }",
            P + " .settings-button-small-icon > .jitsi-icon:focus-visible { outline: 2px solid #93C5FD; outline-offset: -2px; }",
            P + " .settings-button-small-icon--disabled > .jitsi-icon { cursor: default; }",
            P + " .settings-button-small-icon--disabled svg { fill: #475569; }",

            // ---- Hangup: same footprint, clearly destructive. ----
            P + " div.hangup-button { width: 40px; height: 40px; border-radius: 12px; background-color: rgba(220, 38, 38, 0.92); box-shadow: inset 0 0 0 1px rgba(248, 113, 113, 0.45); }",
            P + " div.hangup-button svg { width: 16px !important; height: 16px !important; fill: #FFFFFF; }",
            "@media (hover: hover) and (pointer: fine) { " + P + " div.hangup-button:hover { background-color: #EF4444; box-shadow: inset 0 0 0 1px rgba(254, 202, 202, 0.5); } }",
            P + " div.hangup-button:active { background-color: #B91C1C; }",
            // A little breathing room before the last (hangup) control.
            P + " .toolbox-content-items > :last-child { margin-left: 4px; }",

            // ---- Teacher view: centre the bar over the stage, clear of the
            // custom filmstrip. Its effective position and width come from the
            // teacher view (body class + CSS variable, same default as there).
            // Top / bottom filmstrips span the width: the bar spans it too. ----
            "body." + SL_TB_POLISH_CLASS + ".sl-teacher-view-active .new-toolbox { right: var(--sl-tv-strip-v, min(240px, 38vw)); width: auto; }",
            "body." + SL_TB_POLISH_CLASS + ".sl-teacher-view-active.sl-tv-pos-left .new-toolbox { left: var(--sl-tv-strip-v, min(240px, 38vw)); right: 0; }",
            "body." + SL_TB_POLISH_CLASS + ".sl-teacher-view-active.sl-tv-pos-top .new-toolbox, body." + SL_TB_POLISH_CLASS + ".sl-teacher-view-active.sl-tv-pos-bottom .new-toolbox { left: 0; right: 0; }",
            // Filmstrip auto-hidden: the stage is the whole width again.
            "body." + SL_TB_POLISH_CLASS + ".sl-teacher-view-active.sl-tv-strip-hidden .new-toolbox { left: 0; right: 0; }",

            // ---- Phones / touch: tighter, still ~40px targets, no overflow. ----
            "@media (max-width: 640px) { "
                + P + " .toolbox-content { margin-bottom: 8px; } "
                + P + " .toolbox-content-items { gap: 2px; padding: 3px; border-radius: 14px; max-width: calc(100vw - 12px); overflow-x: auto; scrollbar-width: none; } "
                + P + " .toolbox-content-items::-webkit-scrollbar { display: none; } "
                + P + " .toolbox-content-items > :last-child { margin-left: 2px; } "
                + "body." + SL_TB_POLISH_CLASS + " .toolbox-content-mobile .toolbox-content-items { width: auto; margin: 0 auto; justify-content: center; } }",

            // ---- Our hide/show control, same design language. ----
            // Hit area 44x36 (44x40 on touch screens) around a small pill.
            "#" + SL_TB_TOGGLE_ID + " { position: fixed; z-index: 253; display: none; align-items: center; justify-content: center; box-sizing: border-box; width: 44px; height: 36px; padding: 0; margin: 0; border: 0; background: transparent; color: #CBD5E1; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }",
            "@media (pointer: coarse) { #" + SL_TB_TOGGLE_ID + " { height: 40px; } }",
            "#" + SL_TB_TOGGLE_ID + ".sl-visible { display: flex; }",
            "#" + SL_TB_TOGGLE_ID + " .sl-tb-pill { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 36px; height: 22px; border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.16); background: rgba(17, 24, 39, 0.82); box-shadow: 0 6px 16px rgba(2, 6, 23, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.04); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); transition: background-color .15s ease, color .15s ease; }",
            "#" + SL_TB_TOGGLE_ID + " .sl-tb-pill svg { width: 16px; height: 16px; }",
            "@media (hover: hover) and (pointer: fine) { #" + SL_TB_TOGGLE_ID + ":hover .sl-tb-pill { background: rgba(31, 41, 55, 0.92); color: #F8FAFC; } }",
            "#" + SL_TB_TOGGLE_ID + ":focus-visible { outline: none; }",
            "#" + SL_TB_TOGGLE_ID + ":focus-visible .sl-tb-pill { box-shadow: 0 0 0 2px #93C5FD; }",
            "#" + SL_TB_TOGGLE_ID + ".sl-collapsed .sl-tb-pill { width: 48px; height: 28px; border-radius: 12px; }"
        ].join("\n");

        document.head.appendChild(style);
    }

    function getMountParent() {
        return document.getElementById(SL_TB_MOUNT_ID) || document.body;
    }

    function ensureToggle() {
        if (!toggleEl) {
            injectStyles();

            toggleEl = document.createElement("button");
            toggleEl.id = SL_TB_TOGGLE_ID;
            toggleEl.type = "button";
            toggleEl.setAttribute("aria-controls", "new-toolbox");

            const pill = document.createElement("span");
            pill.className = "sl-tb-pill";
            toggleEl.appendChild(pill);

            toggleEl.addEventListener("click", onToggleClick);
        }

        // Jitsi (React) can replace its page element: follow it.
        const parent = getMountParent();

        if (toggleEl.parentNode !== parent) {
            parent.appendChild(toggleEl);
        }
    }

    function removeToggle() {
        if (toggleEl) {
            toggleEl.remove();
            toggleEl = null;
        }

        if (resizeObserver) {
            resizeObserver.disconnect();
        }

        observedBar = null;
    }

    // Shown: just above the bar's right end. Hidden: bottom centre.
    function position() {
        if (!toggleEl) {
            return;
        }

        const style = toggleEl.style;

        if (isHidden()) {
            // Above a bottom filmstrip of the teacher view, if any (the view
            // sets the offset; 0 otherwise).
            style.top = "auto";
            style.left = "50%";
            style.bottom = "calc(var(--sl-tv-pill-offset, 0px) + max(8px, env(safe-area-inset-bottom, 0px)))";
            style.transform = "translateX(-50%)";

            return;
        }

        const bar = getBar();
        const rect = bar ? bar.getBoundingClientRect() : null;
        const viewportWidth = window.innerWidth || 0;

        style.transform = "none";
        style.bottom = "auto";

        if (rect && rect.width > 0 && rect.height > 0) {
            const left = Math.min(Math.max(rect.right - 44, 4), Math.max(viewportWidth - 48, 4));

            style.top = Math.max(Math.round(rect.top - 34), 4) + "px";
            style.left = Math.round(left) + "px";
        } else {
            style.top = "auto";
            style.left = "50%";
            style.bottom = "84px";
            style.transform = "translateX(-50%)";
        }

        // Re-position when Jitsi resizes its bar (buttons added/removed).
        if (bar !== observedBar && typeof ResizeObserver === "function") {
            resizeObserver = resizeObserver || new ResizeObserver(position);
            resizeObserver.disconnect();

            if (bar) {
                resizeObserver.observe(bar);
            }

            observedBar = bar;
        }
    }

    function clearAutoHide() {
        if (autoHideTimer) {
            clearTimeout(autoHideTimer);
            autoHideTimer = null;
        }
    }

    function armAutoHide() {
        clearAutoHide();

        if (!toolbarView.enabled || !toolbarView.autoHide || manualHidden || autoHidden) {
            return;
        }

        autoHideTimer = setTimeout(onAutoHideTimer, SL_TB_AUTO_HIDE_MS);
    }

    function onAutoHideTimer() {
        autoHideTimer = null;

        if (!toolbarView.enabled || !toolbarView.autoHide || manualHidden || autoHidden) {
            return;
        }

        // In the middle of something: try again later.
        if (isBusy(getState())) {
            armAutoHide();
            return;
        }

        autoHidden = true;
        render();
    }

    // Pointer / touch / key activity anywhere in the meeting: shows an
    // auto-hidden toolbar and restarts the auto-hide timer. Not a manually
    // hidden one, and not for activity on our own control (its click
    // handles that).
    function onActivity(event) {
        if (!toolbarView.enabled || !toolbarView.autoHide) {
            return;
        }

        if (toggleEl && event && event.target
            && typeof toggleEl.contains === "function" && toggleEl.contains(event.target)) {
            return;
        }

        const now = Date.now();

        if (autoHidden) {
            autoHidden = false;
            render();
        } else if (event && event.type === "pointermove" && now - lastActivityAt < 250) {
            return;
        }

        lastActivityAt = now;
        armAutoHide();
    }

    function onToggleClick(event) {
        if (event && typeof event.stopPropagation === "function") {
            event.stopPropagation();
        }

        if (isHidden()) {
            manualHidden = false;
            autoHidden = false;
        } else {
            manualHidden = true;
        }

        render();
        armAutoHide();
    }

    // Everything back to Jitsi's own toolbar, exactly as it was.
    function teardown() {
        clearAutoHide();
        manualHidden = false;
        autoHidden = false;
        document.body?.classList.toggle(SL_TB_HIDDEN_CLASS, false);
        document.body?.classList.toggle(SL_TB_POLISH_CLASS, false);
        removeToggle();
    }

    function render() {
        if (!toolbarView.enabled || !document.body) {
            teardown();
            return;
        }

        // An open menu / dialog / popup shows an auto-hidden toolbar again.
        if (autoHidden && isBusy(getState())) {
            autoHidden = false;
        }

        ensureToggle();

        const hidden = isHidden();
        const toolbar = getToolbar();

        // Nothing to hide/show while Jitsi itself shows no toolbar (e.g.
        // prejoin, or Jitsi hiding it on its own).
        const toolbarShown = Boolean(toolbar && toolbar.classList.contains("visible"));

        lastToolbarShown = toolbarShown;

        document.body.classList.toggle(SL_TB_POLISH_CLASS, true);
        document.body.classList.toggle(SL_TB_HIDDEN_CLASS, hidden);

        toggleEl.classList.toggle("sl-visible", toolbarShown || hidden);
        toggleEl.classList.toggle("sl-collapsed", hidden);
        toggleEl.setAttribute("aria-expanded", hidden ? "false" : "true");
        toggleEl.setAttribute("aria-label", hidden ? "Show meeting controls" : "Hide meeting controls");
        toggleEl.title = hidden ? "Show meeting controls" : "Hide meeting controls";

        const pill = toggleEl.firstChild;
        const icon = hidden ? "up" : "down";

        if (pill && pill.dataset.icon !== icon) {
            pill.dataset.icon = icon;
            pill.innerHTML = hidden ? SL_TB_CHEVRON_UP : SL_TB_CHEVRON_DOWN;
        }

        position();
    }

    // Store changes are frequent: only the cheap checks run on them (menus
    // and dialogs opening, Jitsi replacing its page element).
    function onStoreChange() {
        if (!toolbarView.enabled) {
            return;
        }

        const busyShow = autoHidden && isBusy(getState());
        const moved = toggleEl && toggleEl.parentNode !== getMountParent();
        const toolbar = getToolbar();
        const shownChanged =
            Boolean(toolbar && toolbar.classList.contains("visible")) !== lastToolbarShown;

        if (busyShow || moved || shownChanged) {
            render();
        }

        // Shown again for a menu/dialog: hide again later, once it is closed
        // (the timer itself waits while anything is still open).
        if (busyShow) {
            armAutoHide();
        }
    }

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_TOOLBAR_VIEW") {
            return;
        }

        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || typeof data.enabled !== "boolean"
            || typeof data.autoHide !== "boolean") {
            console.warn("[SL Classroom] Ignored malformed toolbar view", data);

            return;
        }

        // An older message must never overwrite a newer one. The same epoch
        // is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < parentView.epoch) {
            return;
        }

        parentView = {
            epoch: data.epoch,
            enabled: data.enabled,
            autoHide: data.autoHide
        };

        // A console test view, while set, stays in effect.
        if (!testView) {
            applyToolbarView(parentView);
        }
    });

    function applyToolbarView(next) {
        const wasEnabled = toolbarView.enabled;

        toolbarView = next;

        console.log("[SL Classroom] Toolbar view", toolbarView);

        if (!toolbarView.autoHide) {
            autoHidden = false;
            clearAutoHide();
        }

        render();

        if (toolbarView.enabled && (!wasEnabled || toolbarView.autoHide)) {
            armAutoHide();
        }
    }

    // ---------------------------------------------------------------------
    // TESTING ONLY - from the Jitsi iframe's DevTools console (select the
    // Jitsi iframe as the console context first):
    //   __slToolbarTest.on()                  compact toolbar + hide/show
    //   __slToolbarTest.on({ autoHide: true }) ... with auto-hide
    //   __slToolbarTest.off()                 Jitsi's own toolbar again
    //   __slToolbarTest.reset()               back to the parent page's view
    //   __slToolbarTest.state()               what is in effect, and why
    // A test view stays in effect over the parent page's SL_TOOLBAR_VIEW
    // resends until reset(). Affects only this browser's own display.
    // ---------------------------------------------------------------------
    function setTestView(view) {
        testView = view;
        applyToolbarView(testView || parentView);
    }

    window.__slToolbarTest = {
        on: options => setTestView({
            epoch: parentView.epoch,
            enabled: true,
            autoHide: Boolean(options && options.autoHide)
        }),
        off: () => setTestView({
            epoch: parentView.epoch,
            enabled: false,
            autoHide: false
        }),
        reset: () => setTestView(null),
        state: () => ({
            source: testView ? "test" : "parent",
            enabled: toolbarView.enabled,
            autoHide: toolbarView.autoHide,
            hidden: isHidden(),
            manualHidden,
            autoHidden,
            timerActive: Boolean(autoHideTimer),
            busy: getBusyReasons(getState()),
            parentView: { ...parentView }
        })
    };

    SL_TB_ACTIVITY_EVENTS.forEach(type => {
        document.addEventListener(type, onActivity, { capture: true, passive: true });
    });

    window.addEventListener("resize", position);

    // The teacher view moved the toolbar (bottom filmstrip shown / hidden /
    // resized / switched): follow it now and once Jitsi's 0.3s "bottom"
    // transition has finished.
    window.addEventListener("sl-teacher-layout", () => {
        position();
        setTimeout(position, 350);
    });
    document.addEventListener("transitionend", event => {
        if (event.target && event.target.id === "new-toolbox" && event.propertyName === "bottom") {
            position();
        }
    }, true);

    window.addEventListener("pagehide", () => {
        clearAutoHide();
        removeToggle();
    });

    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function" || !document.body) {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(onStoreChange);
        render();
    }, 500);

})();
 