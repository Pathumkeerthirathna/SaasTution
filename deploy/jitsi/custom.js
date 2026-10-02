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


    function enforceModeratorStage() {

        try {

            if (!window.APP || !APP.store || !APP.UI || !APP.conference) {
                return;
            }

            // Do not control the moderator's own screen.
            const localId = APP.conference.getMyUserId();

            const moderator = getRemoteModerator();

            if (!moderator || moderator.id === localId) {
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
             * Moderator screen share:
             * make the moderator's desktop stream large.
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
   SL Classroom - Teacher Receive Set (Phase 1)

   Lets the SL Classroom teacher page choose which students'
   CAMERA video this teacher's browser receives, by Jitsi
   participant ID. Receive-side only: students are never muted
   and their cameras are never touched.

   Runs ONLY when the local participant is a moderator (the
   teacher). Students never install the override, so what they
   receive (including the moderator stage lock above) is
   unchanged.

   Parent page -> iframe:
     { type: "SL_RECEIVE_SET", v: 1, epoch, enabled, participantIds }
   iframe -> parent page (asks the parent to send it again):
     { type: "SL_RECEIVE_READY" }

   Jitsi recomputes its receiver constraints on almost every
   state change and sends them with
   conference.setReceiverConstraints(), so a one-off call would
   be overwritten. Instead that method is wrapped once per
   conference object and every call is rewritten while a receive
   set is enabled.
========================================================== */

(function () {

    const SL_PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
    const SL_MAX_RECEIVE_SET = 100;
    const SL_CAMERA_MAX_HEIGHT = 360;
    const SL_WRAP_MARKER = "__slReceiveSetWrapped";

    let receiveSet = { epoch: 0, enabled: false, participantIds: [] };

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

    function rewriteConstraints(original) {
        const state = getState();

        if (!receiveSet.enabled || !state || !isLocalModerator(state)) {
            return original;
        }

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

    // Wraps the CURRENT conference's setReceiverConstraints once. Called on
    // every store change, so a new conference object (reconnect, breakout
    // room switch) gets wrapped too, and a teacher who becomes moderator
    // after joining is picked up.
    function installReceiveSetWrapper() {
        const state = getState();

        if (!state || !isLocalModerator(state)) {
            return;
        }

        const conference = getConference(state);

        if (!conference
            || typeof conference.setReceiverConstraints !== "function"
            || conference[SL_WRAP_MARKER]) {
            return;
        }

        const originalSetReceiverConstraints =
            conference.setReceiverConstraints.bind(conference);

        conference.setReceiverConstraints = function (constraints) {
            conference[SL_LAST_CONSTRAINTS] = constraints;

            return originalSetReceiverConstraints(
                rewriteConstraints(constraints)
            );
        };

        conference[SL_WRAP_MARKER] = true;

        console.log("[SL Classroom] Teacher receive-set wrapper installed");

        reapplyReceiveSet();
        announceReady();
    }

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
