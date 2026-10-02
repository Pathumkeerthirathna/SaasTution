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
