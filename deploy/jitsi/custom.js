const SL_CUSTOM_JS_VERSION = 1014;

console.log("======== CUSTOM JS VERSION " + SL_CUSTOM_JS_VERSION + " ========");


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


/* ==========================================================
   SL Classroom - Phase D configuration (teacher camera rotation)

   The only place these values live. MAX is a CEILING: lib-jitsi-
   meet's own CPU limiter may still lower it (see the receive
   policy below).
========================================================== */

// Student camera streams the teacher receives at once in Normal mode,
// including a selected (priority) student. Co-teacher cameras and screen
// shares are not student cameras and are not counted.
const SL_TEACHER_MAX_LIVE_CAMERAS = 18;
// How long a rotating student camera stays live (dwell).
const SL_TEACHER_CAMERA_ROTATION_SECONDS = 10;
// How often a few rotating cameras are replaced (rolling window).
const SL_TEACHER_CAMERA_ROTATION_SUBTICK_SECONDS = 2;
// Requested heights: filmstrip tiles; screen shares not on the stage.
const SL_TEACHER_ROTATION_CAMERA_MAX_HEIGHT = 180;
const SL_TEACHER_ROTATION_SHARE_MAX_HEIGHT = 360;
// Tiles view: the student enlarged in the side panel. Requested explicitly,
// whatever Jitsi's own stage height (its pin, the teacher's video-quality
// setting) or a screen share on the stage. 360 is a real simulcast layer of
// a 720p camera (layers ~180 / 360 / 720); it is a REQUESTED maximum, what
// actually arrives depends on the sender's layers and the bandwidth.
const SL_TEACHER_ENLARGED_CAMERA_MAX_HEIGHT = 360;
// Tiles view (nearby groups): how often a few groups pass their live slot
// on, and how long a camera stays live at least before it is passed on
// (several times a camera's start-up time, so swaps stay calm).
const SL_TEACHER_TILES_ROTATION_SUBTICK_SECONDS = 5;
const SL_TEACHER_TILES_MIN_LIVE_SECONDS = 15;


/*
 * Tiles view: the reading order of the rendered tiles, from their measured
 * positions (never from participant IDs). Tiles whose centres are within
 * half a tile height form a row; rows go top to bottom. Each row is walked
 * in the direction that starts nearest to where the previous row ended
 * (chosen over all rows at once: smallest largest jump, then smallest total,
 * then plain alternation starting left to right), so neighbours in the order
 * are neighbours on screen, also into a short last row. Unmeasured tiles (no
 * size) keep their given order at the end.
 *
 * entries: [{ id, left, top, width, height }] in rendered (DOM) order.
 * Returns { order: ids, rows: count, columns: widest row,
 *           positions: { id: { row, x } } } (x in tile widths).
 */
function slSpatialOrder(entries) {
    const measured = [];
    const unmeasured = [];

    (Array.isArray(entries) ? entries : []).forEach(entry => {
        if (entry && entry.width > 0 && entry.height > 0) {
            measured.push({
                id: entry.id,
                x: entry.left + entry.width / 2,
                y: entry.top + entry.height / 2,
                w: entry.width,
                h: entry.height
            });
        } else if (entry) {
            unmeasured.push(entry.id);
        }
    });

    measured.sort((a, b) => a.y - b.y || a.x - b.x);

    const rows = [];

    measured.forEach(tile => {
        const row = rows[rows.length - 1];

        if (row && Math.abs(tile.y - row[0].y) < Math.min(tile.h, row[0].h) / 2) {
            row.push(tile);
        } else {
            rows.push([tile]);
        }
    });

    rows.forEach((row, index) => {
        row.sort((a, b) => a.x - b.x);
        row.forEach(tile => { tile.row = index; });
    });

    const unit = measured.length
        ? measured.reduce((sum, tile) => sum + tile.w, 0) / measured.length
        : 1;
    const jump = (a, b) => Math.round(Math.max(Math.abs(a.row - b.row), Math.abs(a.x - b.x) / unit) * 1e6) / 1e6;
    // Direction 0: left to right; 1: right to left.
    const first = (row, dir) => (dir ? row[row.length - 1] : row[0]);
    const last = (row, dir) => (dir ? row[0] : row[row.length - 1]);
    const better = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

    // best[r][dir] = [largest jump, total jump, rows off the plain
    // alternation] for rows 0..r with row r walked in dir; from[r][dir]:
    // the previous row's direction.
    const best = [];
    const from = [];

    rows.forEach((row, index) => {
        best[index] = [];
        from[index] = [];

        [0, 1].forEach(dir => {
            const off = dir !== index % 2 ? 1 : 0;

            if (index === 0) {
                best[index][dir] = [0, 0, off];
                return;
            }

            [0, 1].forEach(previous => {
                const before = best[index - 1][previous];
                const step = jump(last(rows[index - 1], previous), first(row, dir));
                const cost = [Math.max(before[0], step), before[1] + step, before[2] + off];

                if (!best[index][dir] || better(cost, best[index][dir]) < 0) {
                    best[index][dir] = cost;
                    from[index][dir] = previous;
                }
            });
        });
    });

    const directions = [];

    if (rows.length) {
        let dir = better(best[rows.length - 1][0], best[rows.length - 1][1]) <= 0 ? 0 : 1;

        for (let index = rows.length - 1; index >= 0; index--) {
            directions[index] = dir;
            dir = index > 0 ? from[index][dir] : dir;
        }
    }

    const order = [];
    const positions = {};

    rows.forEach((row, index) => {
        (directions[index] ? row.slice().reverse() : row).forEach(tile => {
            order.push(tile.id);
            positions[tile.id] = { row: tile.row, x: tile.x / unit };
        });
    });

    return {
        order: order.concat(unmeasured),
        rows: rows.length,
        columns: rows.reduce((widest, row) => Math.max(widest, row.length), 0),
        positions
    };
}

// Splits an ordered list into `count` contiguous groups whose sizes differ
// by at most one. count >= ids.length: one each.
//
// Without positions: the larger groups first. With positions ({ id: { row,
// x } } or a Map, from slSpatialOrder): the same sizes, arranged so that the
// widest group (largest distance between two of its members, in tiles) is
// as narrow as possible, so group boundaries fall where the order jumps
// (e.g. into a short last row, or across camera-off tiles). Ties keep the
// plain arrangement.
function slPartitionGroups(ids, count, positions) {
    const list = Array.isArray(ids) ? ids : [];
    const groups = Math.max(0, Math.min(Math.floor(count) || 0, list.length));
    const plain = () => {
        const result = [];
        let start = 0;

        for (let group = 0; group < groups; group++) {
            const size = Math.floor(list.length / groups) + (group < list.length % groups ? 1 : 0);

            result.push(list.slice(start, start + size));
            start += size;
        }

        return result;
    };

    if (!positions || !groups) {
        return plain();
    }

    const at = id => (positions instanceof Map ? positions.get(id) : positions[id]);
    const distance = (a, b) => {
        const p = at(a);
        const q = at(b);

        return p && q ? Math.round(Math.max(Math.abs(p.row - q.row), Math.abs(p.x - q.x)) * 1e6) / 1e6 : 0;
    };
    const width = (from, to) => {
        let widest = 0;

        for (let i = from; i < to; i++) {
            for (let j = i + 1; j < to; j++) {
                widest = Math.max(widest, distance(list[i], list[j]));
            }
        }

        return widest;
    };

    const small = Math.floor(list.length / groups);
    const sizes = [small, small + 1];
    // best[g][i]: narrowest possible widest group for the first i ids in g
    // groups; size[g][i]: the last group's size there (the smaller one wins
    // ties, so the larger groups end up first, as without positions).
    const best = [[0]];
    const size = [[]];

    for (let group = 1; group <= groups; group++) {
        best[group] = [];
        size[group] = [];

        for (let end = 1; end <= list.length; end++) {
            sizes.forEach(length => {
                const start = end - length;

                if (start < 0 || best[group - 1][start] === undefined) {
                    return;
                }

                const cost = Math.max(best[group - 1][start], width(start, end));

                if (best[group][end] === undefined || cost < best[group][end]) {
                    best[group][end] = cost;
                    size[group][end] = length;
                }
            });
        }
    }

    if (best[groups][list.length] === undefined) {
        return plain();
    }

    const result = [];
    let end = list.length;

    for (let group = groups; group > 0; group--) {
        const length = size[group][end];

        result.unshift(list.slice(end - length, end));
        end -= length;
    }

    return result;
}


/*
 * Phase D: which STUDENT CAMERAS the teacher receives in Normal mode.
 *
 * Only students whose camera SourceInfo (presence) exists and is not muted
 * take part; camera-OFF students use no slot. A selected student (Phase C)
 * is a priority camera and uses one slot; co-teacher cameras are always
 * received and use none. While all fit, all are received and nothing
 * rotates. Otherwise the rest share the remaining slots in a ROLLING
 * window: every sub-tick the k longest-live cameras are replaced by the k
 * students who have WAITED longest, so only a few sources (keyframes)
 * change at a time, never a whole group.
 *
 * Fairness: each student carries a waiting credit (when they last stopped
 * being received, or first became eligible). It is never reset by a change
 * of the CPU budget, the selection or the class size, so nobody can be
 * starved by such changes: a student only ever moves to the back of the
 * queue by having just been live. The stride groups (filmstrip index mod
 * G = ceil(N / slots)) only break ties between equal credit, which spreads
 * the first live cameras over the whole filmstrip.
 *
 * Tiles view (setLayout): only the students on the teacher's current page
 * take part (the selected student stays a priority camera wherever they
 * are). When they do not all fit, they are cut, in the grid's measured
 * reading order (slSpatialOrder), into one contiguous group of nearby
 * tiles per live slot (slPartitionGroups): exactly one student per group
 * is live, and every 5 s a few groups (those live longest, at least 15 s)
 * pass their slot on to the member who has waited longest. A student who
 * has waited far too long has their group moved first, so changing
 * budgets, pages or selections cannot starve anyone. Waiting credit is the
 * same as above and survives page and layout changes.
 *
 * It decides only WHICH cameras; the receive policy turns that into
 * receiver constraints (the one setReceiverConstraints wrapper), and the
 * teacher view pauses a tile (keeps its last frame) BEFORE its camera is
 * dropped. Display only: nothing here touches media or tracks.
 */
const slTeacherRotation = (function () {

    const DWELL_MS = SL_TEACHER_CAMERA_ROTATION_SECONDS * 1000;
    const SUBTICK_MS = SL_TEACHER_CAMERA_ROTATION_SUBTICK_SECONDS * 1000;
    const TILES_SUBTICK_MS = SL_TEACHER_TILES_ROTATION_SUBTICK_SECONDS * 1000;
    const TILES_MIN_LIVE_TICKS = Math.max(1,
        Math.ceil(SL_TEACHER_TILES_MIN_LIVE_SECONDS / SL_TEACHER_TILES_ROTATION_SUBTICK_SECONDS));

    let active = false;
    // Tiles view: the participant enlarged in the side panel (its camera is
    // requested at SL_TEACHER_ENLARGED_CAMERA_MAX_HEIGHT), or null.
    let enlargedId = null;
    // Tiles view: { key, scope: Set of page IDs, index: ID -> reading-order
    // position }, or null (List view: every camera-ON student).
    let layout = null;
    // Tiles view: the current nearby groups (one live slot each).
    let groups = [];
    let priorityIds = [];
    // Student-camera budget while lib-jitsi-meet limits lastN for CPU; null
    // = not limited.
    let cpuCameraBudget = null;

    let pool = [];
    let slots = 0;
    let poolKey = "";
    let groupCount = 0;
    const groupOf = new Map();
    let sequence = [];
    // Rotating live cameras: participant ID -> sub-tick it went live.
    const live = new Map();
    // Waiting credit: participant ID -> stamp of when they started waiting
    // (lower = waiting longer). Kept while a student is selected or has the
    // camera off, so neither costs them their place.
    const waitingSince = new Map();
    // Deadline guard: the sub-tick each student started waiting IN THE
    // CURRENT POOL (this page / this view). Unlike the waiting credit it
    // restarts when a student enters the pool (page change, List -> Tiles,
    // camera on, deselected), so time spent off the page never makes a
    // group overdue.
    const waitingTick = new Map();
    let lastPoolMode = null;
    let stampClock = 0;
    let tickNo = 0;
    let timer = null;
    let timerMs = 0;
    // TESTING ONLY switch (via __slTeacherViewTest): sub-ticks by hand.
    let autoTick = true;
    let lastConference = null;
    let coTeacherIds = [];
    let priorityLive = [];

    // Callbacks: the teacher view freezes tiles; the receive policy re-applies.
    let onWillDrop = null;
    let onChange = null;

    function cameraOn(participant) {
        const videoSources = participant?.sources?.get?.("video");

        if (!videoSources || typeof videoSources.values !== "function") {
            return false;
        }

        for (const info of videoSources.values()) {
            if (info?.videoType === "camera" && !info.muted) {
                return true;
            }
        }

        return false;
    }

    // Camera-ON students (filmstrip order: join order), co-teachers, and every
    // student present (camera on or off).
    function collect(state) {
        const participants = state?.["features/base/participants"];
        const remote = participants?.remote;
        const students = [];
        const coTeachers = [];
        const present = new Set();

        if (remote && typeof remote.entries === "function") {
            for (const [participantId, participant] of remote.entries()) {
                if (!participant || participant.fakeParticipant
                    || participantId === participants.local?.id) {
                    continue;
                }

                if (participant.role !== "moderator") {
                    present.add(participantId);
                }

                if (!cameraOn(participant)) {
                    continue;
                }

                (participant.role === "moderator" ? coTeachers : students).push(participantId);
            }
        }

        return { students, coTeachers, present };
    }

    // A new stamp: later stamps wait behind earlier ones.
    function nextStamp() {
        stampClock += 1;

        return stampClock;
    }

    function stopTimer() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    // One timer at most, at the current view's pace (List / Tiles).
    function startTimer() {
        const ms = layout ? TILES_SUBTICK_MS : SUBTICK_MS;

        if (timer && timerMs !== ms) {
            stopTimer();
        }

        if (!timer && autoTick) {
            timer = setInterval(subtick, ms);
            timerMs = ms;
        }
    }

    // The sub-tick a camera started now counts from. In the Tiles view a
    // camera started between sub-ticks (page / budget / selection change,
    // camera on) counts from the NEXT sub-tick, so its minimum live time is
    // never shortened by the part of an interval already gone; one started
    // by a sub-tick itself counts from that sub-tick. List view: unchanged.
    function admissionTick() {
        return layout ? tickNo + 1 : tickNo;
    }

    function setWaiting(id, stamp) {
        waitingSince.set(id, stamp);
        waitingTick.set(id, tickNo);
    }

    function notify() {
        if (typeof onChange === "function") {
            onChange();
        }
    }

    // Live -> not live while the camera stays ON: the teacher view pauses
    // these tiles first (their last frame stays), then they are dropped.
    // They have just been live, so they wait behind everyone already waiting.
    function drop(ids) {
        if (!ids.length) {
            return;
        }

        if (typeof onWillDrop === "function") {
            onWillDrop(ids.slice());
        }

        const stamp = nextStamp();

        ids.forEach(id => {
            live.delete(id);
            setWaiting(id, stamp);
        });
    }

    function sequenceOrder() {
        return new Map(sequence.map((id, index) => [id, index]));
    }

    function dropOldest(count) {
        if (count <= 0) {
            return [];
        }

        const order = sequenceOrder();
        const oldest = Array.from(live.entries())
            .sort((a, b) => a[1] - b[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
            .slice(0, count)
            .map(([id]) => id);

        drop(oldest);

        return oldest;
    }

    // The students not live now, longest waiting first (ties: rotation order).
    function waitingOrder() {
        const order = sequenceOrder();

        return pool
            .filter(id => !live.has(id))
            .sort((a, b) => (waitingSince.get(a) ?? 0) - (waitingSince.get(b) ?? 0)
                || (order.get(a) ?? 0) - (order.get(b) ?? 0));
    }

    // Fills free slots with the students who have waited longest.
    function fill(exclude) {
        const target = Math.min(slots, pool.length);

        for (const id of waitingOrder()) {
            if (live.size >= target) {
                break;
            }

            if (!(exclude && exclude.has(id))) {
                live.set(id, tickNo);
            }
        }
    }

    // Stable groups: re-striped only when the group count changes; a join
    // goes to the least-loaded group, a leave just disappears. They only
    // order students with equal waiting credit.
    function regroup() {
        const count = Math.ceil(pool.length / slots);

        if (count !== groupCount) {
            groupCount = count;
            groupOf.clear();
            pool.forEach((id, index) => groupOf.set(id, index % count));
        } else {
            // A selected (priority) student keeps its group, so it returns
            // to the same place in the rotation when deselected.
            const keep = new Set([...pool, ...priorityLive]);

            Array.from(groupOf.keys()).forEach(id => {
                if (!keep.has(id)) {
                    groupOf.delete(id);
                }
            });

            pool.forEach(id => {
                if (!groupOf.has(id)) {
                    const sizes = new Array(count).fill(0);

                    groupOf.forEach(group => { sizes[group] += 1; });
                    groupOf.set(id, sizes.indexOf(Math.min(...sizes)));
                }
            });
        }

        sequence = [];

        for (let group = 0; group < groupCount; group++) {
            pool.forEach(id => {
                if (groupOf.get(id) === group) {
                    sequence.push(id);
                }
            });
        }
    }

    // ---- Tiles view: nearby groups ---------------------------------------

    // The member of `members` who has waited longest (not live, not
    // `besideId`); ties: the one nearest to besideId in reading order, then
    // reading order.
    function longestWaiting(members, besideId) {
        const order = sequenceOrder();
        const near = besideId ? order.get(besideId) : undefined;
        const distance = id => (near === undefined ? 0 : Math.abs((order.get(id) ?? 0) - near));

        return members
            .filter(id => id !== besideId && !live.has(id))
            .sort((a, b) => (waitingSince.get(a) ?? 0) - (waitingSince.get(b) ?? 0)
                || distance(a) - distance(b)
                || (order.get(a) ?? 0) - (order.get(b) ?? 0))[0] || null;
    }

    // Groups passing their slot on per sub-tick: enough for each group to
    // move about once per minimum live time, never all of them at once.
    function groupAdvancesPerTick(multiCount) {
        return Math.max(1, Math.ceil(multiCount / TILES_MIN_LIVE_TICKS));
    }

    // Sub-ticks a student may wait before their group is moved first: twice
    // the normal worst case of the largest group.
    function groupDeadlineTicks(multiCount, largest) {
        const perGroup = Math.max(TILES_MIN_LIVE_TICKS, Math.ceil(multiCount / groupAdvancesPerTick(multiCount)));

        return 2 * Math.max(1, largest - 1) * perGroup + 1;
    }

    // The pool (camera-ON page students, reading order) cut into one
    // contiguous group per live slot; exactly one live member per group.
    function rebalanceGroups() {
        sequence = pool.slice();
        groups = slPartitionGroups(pool, slots, layout ? layout.positions : null);
        groupCount = groups.length;
        groupOf.clear();
        groups.forEach((members, index) => members.forEach(id => groupOf.set(id, index)));

        // A re-cut (page, budget, selection, layout) can leave a group with
        // two live members: the one live longest goes (frozen first).
        const extra = [];

        groups.forEach(members => {
            members
                .filter(id => live.has(id))
                .sort((a, b) => live.get(b) - live.get(a))
                .slice(1)
                .forEach(id => extra.push(id));
        });

        drop(extra);

        // A group without a live member gets its longest-waiting one.
        groups.forEach(members => {
            if (!members.some(id => live.has(id))) {
                const next = longestWaiting(members, null);

                if (next) {
                    live.set(next, admissionTick());
                }
            }
        });

        startTimer();
    }

    // A few groups pass their live slot on: at most groupAdvancesPerTick
    // (a hard cap), and only groups whose live camera has had the minimum
    // live time. Among those: overdue ones first (a member waited past the
    // deadline on this page), then those live longest. The leaving cameras
    // are frozen first, in one batch, then the next members go live.
    function subtickGroups() {
        tickNo += 1;

        const multi = groups.filter(members => members.length > 1);

        if (!multi.length) {
            return;
        }

        const largest = multi.reduce((size, members) => Math.max(size, members.length), 0);
        const deadline = groupDeadlineTicks(multi.length, largest);
        const candidates = multi
            .map(members => {
                const current = members.find(id => live.has(id)) || null;

                return {
                    members,
                    current,
                    since: current ? live.get(current) : -Infinity,
                    index: groups.indexOf(members),
                    urgent: members.some(id => !live.has(id)
                        && tickNo - (waitingTick.get(id) ?? tickNo) >= deadline)
                };
            })
            .filter(group => !group.current || tickNo - group.since >= TILES_MIN_LIVE_TICKS)
            .sort((a, b) => (b.urgent - a.urgent) || (a.since - b.since) || (a.index - b.index));

        const chosen = candidates.slice(0, groupAdvancesPerTick(multi.length));

        if (!chosen.length) {
            return;
        }

        const next = chosen.map(group => longestWaiting(group.members, group.current));

        drop(chosen.map(group => group.current).filter(Boolean));
        next.forEach(id => {
            if (id) {
                live.set(id, tickNo);
            }
        });

        notify();
    }

    function rebalance(nextPool, nextSlots) {
        pool = nextPool;
        slots = nextSlots;
        groups = [];

        // Camera off / left / now a priority camera: no longer rotating
        // (no freeze: off and left tiles detach; priority stays live).
        const inPool = new Set(pool);

        Array.from(live.keys()).forEach(id => {
            if (!inPool.has(id)) {
                live.delete(id);
            }
        });

        if (slots <= 0) {
            drop(Array.from(live.keys()));
            groupCount = 0;
            groupOf.clear();
            sequence = [];
            stopTimer();
            return;
        }

        if (pool.length <= slots) {
            // Everyone fits: all live, no rotation.
            groupCount = pool.length ? 1 : 0;
            groupOf.clear();
            sequence = pool.slice();
            pool.forEach(id => {
                if (!live.has(id)) {
                    live.set(id, admissionTick());
                }
            });
            stopTimer();
            return;
        }

        if (layout) {
            rebalanceGroups();
            return;
        }

        regroup();
        dropOldest(live.size - slots);
        fill();
        startTimer();
    }

    function subtick() {
        if (!active || slots <= 0 || pool.length <= slots) {
            stopTimer();
            return;
        }

        if (layout) {
            subtickGroups();
            return;
        }

        tickNo += 1;

        const replace = Math.min(
            Math.ceil(slots * SUBTICK_MS / DWELL_MS),
            pool.length - slots
        );
        const dropped = new Set(dropOldest(replace));

        fill(dropped);
        notify();
    }

    function reset() {
        stopTimer();
        pool = [];
        slots = 0;
        poolKey = "";
        groupCount = 0;
        groupOf.clear();
        groups = [];
        sequence = [];
        live.clear();
        waitingSince.clear();
        waitingTick.clear();
        lastPoolMode = null;
        coTeacherIds = [];
        priorityLive = [];
    }

    // Tiles view: page students in reading order (unknown ones last, in
    // join order); List view: every camera-ON student, join order.
    function eligibleStudents(students) {
        if (!layout) {
            return students;
        }

        const onPage = students.filter(id => layout.scope.has(id));
        const position = id => (layout.index.has(id) ? layout.index.get(id) : Infinity);

        return onPage
            .map((id, joinIndex) => ({ id, joinIndex }))
            .sort((a, b) => (position(a.id) - position(b.id)) || (a.joinIndex - b.joinIndex))
            .map(entry => entry.id);
    }

    // Recomputes membership from the current store. Cheap when nothing that
    // matters changed (same camera-ON students, same slots).
    function update(state) {
        if (!active || !state) {
            return;
        }

        const conference = state["features/base/conference"]?.conference ?? null;

        // A new conference (reconnect): nothing carries over.
        if (conference !== lastConference) {
            lastConference = conference;
            reset();
        }

        const { students, coTeachers, present } = collect(state);
        const cameraOnIds = new Set(students);
        const priority = priorityIds.filter(id => cameraOnIds.has(id));
        const budget = Math.max(0, Math.min(SL_TEACHER_MAX_LIVE_CAMERAS, cpuCameraBudget ?? SL_TEACHER_MAX_LIVE_CAMERAS));
        const nextSlots = Math.max(0, budget - priority.length);
        // The selected student stays a priority camera even off the page.
        const nextPool = eligibleStudents(students).filter(id => !priority.includes(id));
        const key = [
            layout ? "tiles" : "list", nextPool.join(","), nextSlots, priority.join(","), coTeachers.join(",")
        ].join("|");

        if (key === poolKey) {
            return;
        }

        // Planned live before this change (to freeze anyone who loses it).
        const before = new Set(publicReceiveIds());
        const wasPriority = new Set(priorityLive);
        const wasLive = new Set(live.keys());

        // Waiting credit. Students who left are forgotten. A rotating
        // student who stops being live by leaving the pool (camera off,
        // selected) has just been live: back of the queue. So has a student
        // who was a priority camera until now (deselected). A student new to
        // the pool keeps the credit they already had (camera turned back
        // on), else starts waiting now.
        // Tiles view: students off the current page keep their credit too.
        Array.from(waitingSince.keys()).forEach(id => {
            if (!present.has(id)) {
                waitingSince.delete(id);
                waitingTick.delete(id);
            }
        });

        const stamp = nextStamp();
        const inNextPool = new Set(nextPool);

        wasLive.forEach(id => {
            if (!inNextPool.has(id)) {
                setWaiting(id, stamp);
            }
        });

        nextPool.forEach(id => {
            if (wasPriority.has(id) || !waitingSince.has(id)) {
                setWaiting(id, stamp);
            }
        });

        // Deadline clock (not the credit): restarts for every student who
        // enters the pool, and for all of them when the view changes (List
        // <-> Tiles), so waiting elsewhere never makes a group overdue here.
        const previousPool = new Set(pool);
        const poolMode = layout ? "tiles" : "list";
        const modeChanged = poolMode !== lastPoolMode;

        lastPoolMode = poolMode;
        nextPool.forEach(id => {
            if (modeChanged || !previousPool.has(id)) {
                waitingTick.set(id, tickNo);
            }
        });

        poolKey = key;
        coTeacherIds = coTeachers;
        priorityLive = priority;
        rebalance(nextPool, nextSlots);

        // Still camera-ON but no longer received (e.g. a deselected student
        // who does not fit the window right now): freeze before re-applying.
        const after = new Set(publicReceiveIds());
        const lost = Array.from(before).filter(id => !after.has(id) && cameraOnIds.has(id));

        if (lost.length && typeof onWillDrop === "function") {
            onWillDrop(lost);
        }

        notify();
    }

    function publicReceiveIds() {
        return [...priorityLive, ...coTeacherIds, ...sequence.filter(id => live.has(id))];
    }

    return {
        setActive(next) {
            if (active === next) {
                return;
            }

            active = next;
            enlargedId = null;
            lastConference = null;
            reset();
            notify();
        },
        isActive: () => active,
        // Tiles view: who is enlarged (null: nobody). A change re-applies the
        // receive policy at once (onChange), also when Jitsi's own
        // constraints do not change (e.g. a screen share keeps the stage).
        setEnlarged(id) {
            const next = typeof id === "string" && id ? id : null;

            if (next !== enlargedId) {
                enlargedId = next;
                notify();
            }
        },
        getEnlarged: () => enlargedId,
        setPriority(ids) {
            priorityIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
        },
        // Tiles view: { scope: page participant IDs, order: their reading
        // order on screen (slSpatialOrder; default: scope order), positions:
        // slSpatialOrder's measured positions (optional) }. null:
        // List view. Waiting credit is kept; the plan is redone on the next
        // update.
        setLayout(next) {
            const scope = next && Array.isArray(next.scope) ? next.scope.filter(Boolean) : null;

            if (!scope) {
                if (layout) {
                    layout = null;
                    poolKey = "";
                }

                return;
            }

            const order = Array.isArray(next.order) && next.order.length ? next.order : scope;
            // Measured grid positions ({ id: { row, x } }): groups are cut
            // where the order jumps. Absent: plain contiguous groups.
            const positions = next.positions && typeof next.positions === "object" ? next.positions : null;
            const place = id => {
                const position = positions ? positions[id] : null;

                return position ? position.row + ":" + Math.round(position.x * 10) : "";
            };
            const key = scope.join(",") + "|" + order.map(id => id + "@" + place(id)).join(",");

            if (layout && layout.key === key) {
                return;
            }

            layout = {
                key,
                scope: new Set(scope),
                index: new Map(order.map((id, index) => [id, index])),
                positions
            };
            poolKey = "";
        },
        getLayoutMode: () => (layout ? "tiles" : "list"),
        // From the receive policy, while lib-jitsi-meet limits lastN.
        setCpuCameraBudget(budget) {
            const next = typeof budget === "number" && budget >= 0 ? Math.floor(budget) : null;

            if (next !== cpuCameraBudget) {
                cpuCameraBudget = next;
                // Applied on the next update (never inside a constraint call).
                setTimeout(() => {
                    if (active && window.APP && APP.store) {
                        update(APP.store.getState());
                    }
                }, 0);
            }
        },
        getCpuCameraBudget: () => cpuCameraBudget,
        update,
        // Whether the teacher should be receiving this participant's camera.
        isPlannedLive: id => priorityLive.includes(id) || coTeacherIds.includes(id) || live.has(id),
        // Cameras to receive: priority, co-teachers, then the rotating window.
        receiveIds: () => publicReceiveIds(),
        onWillDrop(callback) { onWillDrop = callback; },
        onChange(callback) { onChange = callback; },
        subtick,
        // TESTING ONLY: stop / restart the automatic sub-ticks.
        setAutoTick(on) {
            autoTick = Boolean(on);

            if (!autoTick) {
                stopTimer();
            } else if (active && slots > 0 && pool.length > slots) {
                startTimer();
            }
        },
        stats: () => ({
            active,
            cameraStudents: pool.length + priorityLive.length,
            priority: priorityLive.slice(),
            coTeachers: coTeacherIds.slice(),
            slots,
            rotating: slots > 0 && pool.length > slots,
            groups: groupCount,
            perSubtick: slots > 0 ? Math.min(Math.ceil(slots * SUBTICK_MS / DWELL_MS), Math.max(pool.length - slots, 0)) : 0,
            live: sequence.filter(id => live.has(id)),
            // Not live now, longest waiting first.
            waiting: waitingOrder(),
            cpuCameraBudget,
            timerActive: Boolean(timer),
            timerMs: timer ? timerMs : 0,
            tick: tickNo,
            // Tiles view.
            mode: layout ? "tiles" : "list",
            groupMembers: groups.map(members => members.slice()),
            groupAdvancesPerTick: layout && groups.length
                ? groupAdvancesPerTick(groups.filter(members => members.length > 1).length)
                : 0
        })
    };
})();

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



// setInterval(() => {

//     if (!window.APP || !APP.conference)
//         return;

//     console.log(APP);

// }, 3000);


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

   Moderator (teacher), Normal mode, Phase D (while the teacher
   view runs the camera rotation, slTeacherRotation above):
     Jitsi's own stage (onStageSources, the Phase C pin) and every
     active screen share exactly as Jitsi asks, plus the student
     cameras the rotation selects (priority + co-teachers + rolling
     window, at tile height); nothing else is forwarded. Respects
     lib-jitsi-meet's CPU limiter (see setCpuLimiterCeiling).

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
    // Student view: the teacher's CAMERA on the stage is requested at least at
    // this height, whatever Jitsi asks for its (small, e.g. phone) stage area:
    // 720 is the lowest height that gets Jitsi's "high" bitrate budget, so the
    // teacher's handwriting stays readable. A lower video quality the student
    // chose in Jitsi still wins. A REQUESTED maximum: the bridge still forwards
    // a lower layer when the student's network cannot carry it.
    const SL_STUDENT_TEACHER_CAMERA_MIN_HEIGHT = 720;

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

    // Phase D: the last rotation signature applied (per conference object),
    // and whether a rewrite is running (no nested re-apply from it).
    const SL_ROTATION_SIGNATURE = "__slRotationSignature";
    let rewriting = false;

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
    // Whether a source is a remote STUDENT's camera (not a moderator's, not a
    // screen share, not a virtual participant), from presence.
    function isStudentCameraSource(state, sourceName) {
        const participants = state?.["features/base/participants"];
        const remote = participants?.remote;

        if (!remote || typeof remote.entries !== "function" || typeof sourceName !== "string") {
            return false;
        }

        for (const [participantId, participant] of remote.entries()) {
            if (!participant || participant.fakeParticipant || participantId === participants.local?.id) {
                continue;
            }

            const info = participant.sources?.get?.("video")?.get?.(sourceName);

            if (info) {
                return info.videoType === "camera" && participant.role !== "moderator";
            }
        }

        return false;
    }

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

        // Exam Mode (receive set) first and unchanged; then Phase D in
        // Normal mode while the teacher view runs its rotation.
        if (rotationPolicyApplies(state)) {
            return rewriteTeacherRotationConstraints(original, state);
        }

        // Every other policy (Exam Mode, view off, a teacher demoted to a
        // student) gets lib-jitsi-meet's own CPU-limiter level back.
        restoreCpuLimiterCeiling(state);

        if (isLocalModerator(state)) {
            return receiveSet.enabled
                ? rewriteTeacherConstraints(original, state)
                : original;
        }

        return studentView.enabled
            ? rewriteStudentConstraints(original, state)
            : original;
    }

    // ---- Phase D: teacher Normal mode, rotating student cameras ----------

    // The active remote screen shares, from presence (any sharer).
    function getActiveShareSources(state) {
        const participants = state?.["features/base/participants"];
        const remote = participants?.remote;
        const shares = [];

        if (!remote || typeof remote.entries !== "function") {
            return shares;
        }

        for (const [participantId, participant] of remote.entries()) {
            if (!participant || participant.fakeParticipant || participantId === participants.local?.id) {
                continue;
            }

            const videoSources = participant.sources?.get?.("video");

            if (videoSources && typeof videoSources.entries === "function") {
                for (const [sourceName, info] of videoSources.entries()) {
                    if (info?.videoType === "desktop" && !info.muted) {
                        shares.push(sourceName);
                    }
                }
            }
        }

        return shares;
    }

    // lib-jitsi-meet's receive controller (its CPU limiter lives there).
    function getReceiveController(state) {
        const controller = getConference(state)?.qualityController?.receiveVideoController;

        return controller && typeof controller.getLastN === "function" ? controller : null;
    }

    /*
     * CPU limiter: lib-jitsi-meet lowers lastN when the teacher's own camera
     * encoder is CPU-limited, and ramps it back up later. It treats
     * config.channelLastN (5 here) as the normal level: only below it does it
     * mark itself "limited" and keep its lower value against new receiver
     * constraints. With Phase D's ceiling above 5, a cut (e.g. 18 -> 9) would
     * not count as limited and our next constraints would undo it at once.
     * So, while Phase D is active, its normal level is set to Phase D's own
     * lastN on lib-jitsi-meet's private copy of the config (the only value it
     * reads there at run time; Jitsi's redux config is a separate object):
     * its own limiter then works as designed. The original value is put back
     * whenever Phase D is not active (Exam Mode, view off).
     */
    const SL_LIMITER_SAVED = "__slSavedChannelLastN";

    function setCpuLimiterCeiling(state, lastN) {
        const conference = getConference(state);
        const config = conference?.options?.config;

        if (!config || typeof config !== "object") {
            return;
        }

        if (!(SL_LIMITER_SAVED in conference)) {
            conference[SL_LIMITER_SAVED] = config.channelLastN;
        }

        config.channelLastN = lastN;
    }

    function restoreCpuLimiterCeiling(state) {
        const conference = getConference(state);
        const config = conference?.options?.config;

        if (!conference || !(SL_LIMITER_SAVED in conference)) {
            return;
        }

        if (config && typeof config === "object") {
            config.channelLastN = conference[SL_LIMITER_SAVED];
        }

        delete conference[SL_LIMITER_SAVED];
    }

    // Whether Phase D decides this browser's receiver constraints now:
    // teacher (moderator), Normal mode (no Exam receive set), view showing.
    function rotationPolicyApplies(state) {
        return Boolean(state) && isLocalModerator(state)
            && !receiveSet.enabled && slTeacherRotation.isActive();
    }

    // How many sources the last Phase D constraints selected that are not
    // student or co-teacher cameras (stage, screen shares), per conference.
    const SL_ROTATION_NON_CAMERA = "__slRotationNonCamera";

    // The student-camera budget lib-jitsi-meet's CPU limiter leaves: its
    // limited lastN minus the stage, shares and co-teachers; null while it
    // is not limiting (or this build has no limiter API).
    function readCpuCameraBudget(state, nonCamera) {
        const controller = getReceiveController(state);
        const limited = Boolean(controller && typeof controller.isLastNLimitedByCpu === "function"
            && controller.isLastNLimitedByCpu());

        if (!limited) {
            return null;
        }

        const lastN = controller.getLastN();

        if (typeof lastN !== "number" || !Number.isFinite(lastN) || lastN < 0) {
            return null;
        }

        return Math.max(0, lastN - nonCamera - slTeacherRotation.stats().coTeachers.length);
    }

    /*
     * The limiter changes lastN inside lib-jitsi-meet without going through
     * setReceiverConstraints, so a change is not seen by the rewrite until
     * Jitsi next recomputes its constraints. While Phase D applies, its state
     * is read once a second (no constraints are sent from here: a changed
     * budget re-plans the rotation, which re-applies only if the selected
     * cameras change). This covers all cameras fitting (no rotation timer)
     * and a budget of zero (timer stopped).
     */
    const SL_LIMITER_POLL_MS = 1000;
    let limiterPollTimer = null;

    function pollCpuLimiter() {
        const state = getState();
        const conference = getConference(state);

        if (!conference || !rotationPolicyApplies(state)) {
            syncLimiterPoll(state);
            return;
        }

        // Nothing applied on this conference yet: the first rewrite reads it.
        if (!(SL_ROTATION_NON_CAMERA in conference)) {
            return;
        }

        slTeacherRotation.setCpuCameraBudget(readCpuCameraBudget(state, conference[SL_ROTATION_NON_CAMERA]));
    }

    // One poll at most, only while Phase D applies to an active conference
    // (meeting left / ended: stopped; it starts again from the store change
    // that brings the next conference).
    function syncLimiterPoll(state) {
        const wanted = Boolean(getConference(state)) && rotationPolicyApplies(state);

        if (wanted && !limiterPollTimer) {
            limiterPollTimer = setInterval(pollCpuLimiter, SL_LIMITER_POLL_MS);
        } else if (!wanted && limiterPollTimer) {
            clearInterval(limiterPollTimer);
            limiterPollTimer = null;
        }
    }

    // Phase D: Jitsi's own stage (onStageSources, Phase C pin) and every
    // active screen share stay exactly as Jitsi requests them; the student
    // cameras are the scheduler's: priority (selected) + co-teachers + the
    // rotating window, at tile height. Nothing else is forwarded.
    function rewriteTeacherRotationConstraints(original, state) {
        // lastN 0 is Jitsi's audio-only / low-bandwidth mode: left as it is,
        // with lib-jitsi-meet's own limiter level (Phase D sends no lastN).
        if (!original || original.lastN === 0) {
            restoreCpuLimiterCeiling(state);
            return original;
        }

        slTeacherRotation.update(state);

        // Jitsi's own stage list, as it asked (the 360 hold below reads it).
        const jitsiOnStage = Array.isArray(original.onStageSources) ? original.onStageSources.slice() : [];
        const shares = getActiveShareSources(state);
        const cameras = [];

        slTeacherRotation.receiveIds().forEach(participantId => {
            const sourceName = getCameraSourceName(state, participantId);

            if (sourceName && !cameras.includes(sourceName)) {
                cameras.push(sourceName);
            }
        });

        // A STUDENT camera keeps its stage place only when it is one of the
        // planned cameras (the selected / staged student is a priority
        // camera, so it is). An old stage entry (the pin just moved, Jitsi has
        // not recomputed yet) or any other unplanned student camera is not
        // received: it can never take the camera count over the budget.
        // Screen shares, co-teachers and anything else keep Jitsi's stage.
        const onStage = jitsiOnStage.filter(sourceName =>
            !isStudentCameraSource(state, sourceName) || cameras.includes(sourceName));

        const selectedSources = [];
        const add = sourceName => {
            if (sourceName && !selectedSources.includes(sourceName)) {
                selectedSources.push(sourceName);
            }
        };

        onStage.forEach(add);
        shares.forEach(add);
        cameras.forEach(add);

        const constraints = {};

        selectedSources.forEach(sourceName => {
            if (onStage.includes(sourceName) && original.constraints?.[sourceName]) {
                constraints[sourceName] = original.constraints[sourceName];
            } else {
                constraints[sourceName] = {
                    maxHeight: shares.includes(sourceName)
                        ? SL_TEACHER_ROTATION_SHARE_MAX_HEIGHT
                        : SL_TEACHER_ROTATION_CAMERA_MAX_HEIGHT
                };
            }
        });

        // Tiles view: the enlarged student's camera at its explicit height,
        // replacing Jitsi's stage height (its pin; the teacher's video-quality
        // setting) and the tile height (a screen share on the stage). Only a
        // camera already selected above (a priority camera, or Jitsi's stage):
        // a missing or disconnected student gets nothing. Screen shares keep
        // their own constraints.
        //
        // A camera enlarged until just now stays at that height while Jitsi's
        // latest request still has it on the stage (the pin moved, Jitsi has
        // not recomputed yet): Jitsi's stage height never reaches it on close
        // or on a switch to another student.
        const enlargedSource = getEnlargedCameraSource(state);
        const heldOn = getConference(state);
        const held = heldOn
            ? (heldOn[SL_ENLARGED_HELD] = heldOn[SL_ENLARGED_HELD] || new Set())
            : new Set();

        Array.from(held).forEach(sourceName => {
            if (sourceName !== enlargedSource && !jitsiOnStage.includes(sourceName)) {
                held.delete(sourceName);
            }
        });

        if (enlargedSource) {
            held.add(enlargedSource);
        }

        held.forEach(sourceName => {
            if (constraints[sourceName] && !shares.includes(sourceName)) {
                constraints[sourceName] = { maxHeight: SL_TEACHER_ENLARGED_CAMERA_MAX_HEIGHT };
            }
        });

        // At least 1: lastN 0 is Jitsi's "audio only" meaning (nothing is
        // forwarded anyway: everything not selected has maxHeight 0).
        const lastN = Math.max(1, selectedSources.length);
        const stats = slTeacherRotation.stats();
        const nonCamera = selectedSources.filter(sourceName => !cameras.includes(sourceName)).length;

        // The limiter's normal level: what Phase D would request without any
        // CPU limit (so its ramp-up can go all the way back up).
        setCpuLimiterCeiling(
            state,
            Math.max(1, nonCamera + stats.coTeachers.length + Math.min(SL_TEACHER_MAX_LIVE_CAMERAS, stats.cameraStudents))
        );

        // While lib-jitsi-meet limits lastN, the rotation shrinks to what is
        // left of it after the stage, shares and co-teachers (only what will
        // be forwarded is planned live). Its own lastN wins meanwhile,
        // whatever we send. Changes between rewrites: pollCpuLimiter.
        const conference = getConference(state);

        if (conference) {
            conference[SL_ROTATION_NON_CAMERA] = nonCamera;
        }

        slTeacherRotation.setCpuCameraBudget(readCpuCameraBudget(state, nonCamera));

        return {
            ...original,
            lastN,
            defaultConstraints: { maxHeight: 0 },
            constraints,
            selectedSources,
            onStageSources: onStage
        };
    }

    // Per conference object: enlarged cameras whose 360 request is held
    // while Jitsi's stage list still names them (see the rewrite above).
    const SL_ENLARGED_HELD = "__slEnlargedHeld";

    // The enlarged participant's camera source (Tiles view), or null.
    function getEnlargedCameraSource(state) {
        const enlargedId = slTeacherRotation.getEnlarged();

        return enlargedId ? getCameraSourceName(state, enlargedId) : null;
    }

    // What the Phase D policy currently depends on (a change re-applies it).
    function getRotationSignature(state) {
        if (!rotationPolicyApplies(state)) {
            return "";
        }

        return JSON.stringify([
            slTeacherRotation.receiveIds().map(id => getCameraSourceName(state, id)),
            getActiveShareSources(state),
            getEnlargedCameraSource(state)
        ]);
    }

    // Exposed for tests (read-only view of the last applied policy).
    window.__slTeacherReceiveTest = {
        lastApplied: () => {
            const conference = getConference(getState());

            return conference ? conference.__slLastApplied || null : null;
        },
        limiterCeiling: () => getConference(getState())?.options?.config?.channelLastN
    };

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

    // The least height for the teacher's camera on a student's stage: 720,
    // or the student's own lower video-quality choice in Jitsi
    // (features/video-quality preferredVideoQuality), which is kept.
    function getTeacherCameraMinHeight(state) {
        const preferred = state?.["features/video-quality"]?.preferredVideoQuality;

        return typeof preferred === "number" && Number.isFinite(preferred) && preferred > 0
            ? Math.min(SL_STUDENT_TEACHER_CAMERA_MIN_HEIGHT, preferred)
            : SL_STUDENT_TEACHER_CAMERA_MIN_HEIGHT;
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
        // From Jitsi's own height (not the raised one below): the teacher's
        // corner tile and other sources off the stage stay small.
        const secondaryHeight = Math.min(SL_STUDENT_SECONDARY_MAX_HEIGHT, stageHeight);
        // Only the teacher's camera on the stage is raised (never lowered);
        // a screen share on the stage keeps Jitsi's own height.
        const cameraStageHeight = Math.max(stageHeight, getTeacherCameraMinHeight(state));

        const constraints = {};

        selectedSources.forEach(sourceName => {
            constraints[sourceName] = {
                maxHeight: stage && stage.sourceName === sourceName
                    ? (stage.videoType === "camera" ? cameraStageHeight : stageHeight)
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

        // Phase D's CPU-limiter poll follows the role / Exam Mode / view.
        syncLimiterPoll(state);

        const conference = getConference(state);

        if (!conference || typeof conference.setReceiverConstraints !== "function") {
            return;
        }

        if (!conference[SL_WRAP_MARKER]) {
            const originalSetReceiverConstraints =
                conference.setReceiverConstraints.bind(conference);

            conference.setReceiverConstraints = function (constraints) {
                conference[SL_LAST_CONSTRAINTS] = constraints;

                rewriting = true;

                let rewritten;

                try {
                    rewritten = rewriteConstraints(constraints);
                } finally {
                    rewriting = false;
                }

                conference.__slLastApplied = rewritten;

                return originalSetReceiverConstraints(rewritten);
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

        // Phase D (teacher, Normal): keep the rotation in step with the
        // store, and re-apply only when the cameras / shares it selects change.
        if (slTeacherRotation.isActive()) {
            slTeacherRotation.update(state);
        }

        reapplyRotationIfChanged();
    }

    // Re-applies the receive policy only when Phase D's selection actually
    // changed (identical constraints are never re-sent from here; lib-jitsi-
    // meet also drops identical ones). Skipped inside a rewrite: that rewrite
    // already uses the current selection.
    function reapplyRotationIfChanged() {
        const state = getState();

        // Rotation started / stopped (also from inside a rewrite).
        syncLimiterPoll(state);

        if (rewriting) {
            return;
        }

        const conference = getConference(state);

        if (!conference || !conference[SL_WRAP_MARKER]) {
            return;
        }

        const signature = getRotationSignature(state);

        if (conference[SL_ROTATION_SIGNATURE] !== signature) {
            conference[SL_ROTATION_SIGNATURE] = signature;
            reapplyReceiveSet();
        }
    }

    // Rotation sub-ticks, membership changes and activation / deactivation.
    slTeacherRotation.onChange(reapplyRotationIfChanged);

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



/*
 * Student device status (camera / microphone indicator, further below):
 * what it shares with the teacher-camera PiP and the custom stage, which
 * make room for it. Declared here, before both, because they use these as
 * they load. All of it exists only while the indicator shows (students).
 */
// On <body> while the indicator shows.
const SL_DEVICE_STATUS_ACTIVE_CLASS = "sl-device-status-active";
// On <body>: the indicator's height, and the room it takes from the right of
// the large video (its width, its right inset and a gap).
const SL_DEVICE_STATUS_VAR_H = "--sl-ds-h";
const SL_DEVICE_STATUS_VAR_RESERVE = "--sl-ds-reserve";
// Fired on window when its size or place changes (the PiP follows it).
const SL_DEVICE_STATUS_LAYOUT_EVENT = "sl-device-status-layout";
// Space kept between the indicator and anything stacked under it.
const SL_DEVICE_STATUS_GAP = 8;



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

    // How far the tile moves down for the student device status indicator,
    // which keeps the very corner (its height and a gap; 0 while it is off).
    function deviceStatusOffset() {
        const body = document.body;

        if (!body || !body.classList.contains(SL_DEVICE_STATUS_ACTIVE_CLASS)) {
            return 0;
        }

        const height = parseFloat(body.style.getPropertyValue(SL_DEVICE_STATUS_VAR_H));

        return height > 0 ? height + SL_DEVICE_STATUS_GAP : 0;
    }

    // Top-right corner of the large video. Jitsi resizes that area itself
    // (chat, filmstrip, window), so it is measured, not assumed.
    function position() {
        if (!root) {
            return;
        }

        const container = document.getElementById("largeVideoContainer");
        const rect = container ? container.getBoundingClientRect() : null;
        const below = deviceStatusOffset();

        if (rect && rect.width > 0 && rect.height > 0) {
            root.style.top = Math.round(rect.top + SL_PIP_MARGIN + below) + "px";
            root.style.right = Math.round(window.innerWidth - rect.right + SL_PIP_MARGIN) + "px";
        } else {
            root.style.top = (SL_PIP_MARGIN + below) + "px";
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

    // The device status indicator appeared, went or changed size.
    window.addEventListener(SL_DEVICE_STATUS_LAYOUT_EVENT, position);

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

   While the teacher's camera is off (muted, or the teacher is in
   the room without any camera source yet) the stage shows the
   teacher's profile instead: photo (or initials), name and
   designation on a blue gradient, with a camera-off status. So it
   does while no teacher is in the room at all (not joined yet:
   "Your class will begin shortly"; left after joining: "stepped
   away"), from the profile the parent page sent, with no Jitsi
   participant or track needed. A screen share always wins over the
   camera (slPickStudentStage), so it is never shown while the
   teacher shares.

   Runs ONLY when the local participant is not a moderator, and
   only while the parent page enables it:
     { type: "SL_STAGE_VIEW", v: 1, epoch, enabled, teacher? }
     teacher: { name, designation, photoUrl, jitsiName } (optional;
     shown only on the participant whose display name is jitsiName)
   (resent by the parent after SL_RECEIVE_READY). Off by default.
========================================================== */

(function () {

    const SL_STAGE_ID = "sl-custom-stage";
    const SL_STREAMING_STATUS_EVENT = "track.streaming_status_changed";

    // Where the stage is mounted: the element that holds Jitsi's toolbar
    // (#new-toolbox, normally #videoconference_page), so the stage and the
    // toolbar are compared in the SAME stacking context: z-index 199 under
    // the toolbar's 252. #videoconference_page has a transform (its own
    // stacking context); a <body>-level stage is compared with the whole page
    // instead and covers the toolbar and the toolbar polish's hide/show
    // control (the bug in the original version). Falls back to the page
    // element, then <body>. The teacher view (SL_TV_MOUNT_ID) is not changed.
    const SL_STAGE_MOUNT_ID = "videoconference_page";
    const SL_STAGE_TOOLBAR_ID = "new-toolbox";
    // On <body> while this (student-only) stage shows; see the toolbar rule.
    const SL_STAGE_ACTIVE_CLASS = "sl-student-stage-active";
    // A card already showing waits this long at most for the camera's first
    // frame before uncovering the video (no black flash in between).
    const SL_STAGE_FIRST_FRAME_WAIT_MS = 2000;

    const SL_STAGE_TEXT_MAX = 200;
    // Largest posted teacher photo accepted (same cap as the parent page).
    const SL_STAGE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
    const SL_STAGE_CAMERA_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.5 5.5H14a2 2 0 0 1 2 2v3.5l4.2-2.6a.5.5 0 0 1 .8.4v6.4"/><path d="M16 16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1"/></svg>';
    // Avatar fallback when there is no photo and no usable name: a teacher.
    const SL_STAGE_TEACHER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.75"/><path d="M4.75 20v-.5a6 6 0 0 1 6-6h2.5a6 6 0 0 1 6 6v.5"/></svg>';

    // What the card says (see cardCopy).
    const SL_STAGE_COPY = {
        waiting: {
            title: "Your class will begin shortly",
            text: "Please wait while your teacher gets ready."
        },
        voiceOnly: {
            title: "Your teacher's camera is off",
            text: "You can still hear your teacher. The video will appear here when the camera is turned on."
        },
        paused: {
            title: "Your teacher's camera is off",
            text: "The video will return here automatically when the camera is turned back on."
        },
        // The teacher was in the room this session and is not any more
        // (left or disconnected): not "begin shortly", the class has begun.
        away: {
            title: "Your teacher has stepped away",
            text: "The class will continue here as soon as your teacher is back."
        }
    };

    // Jitsi track streaming status (lib-jitsi-meet TrackStreamingStatus)
    // -> what the stage tells the viewer. "active" (or not tracked yet) shows
    // nothing.
    const SL_STATUS_MESSAGES = {
        inactive: "Video paused to save bandwidth",
        interrupted: "Video interrupted - reconnecting…",
        restoring: "Video interrupted - reconnecting…"
    };

    let stageView = { epoch: 0, enabled: false, teacher: null };

    let root = null;
    let video = null;
    let messageEl = null;
    let statusEl = null;
    // Camera-off placeholder: { el, photoEl, initialsEl, nameEl, roleEl,
    // titleEl, textEl }.
    let teacherEl = null;
    // Photo URLs that failed to load (initials are shown instead).
    const failedPhotos = new Set();
    // The object URL made for the photo the parent page posted, and its key.
    let photoObject = { key: "", url: "" };
    // Teachers (by Jitsi display name) whose camera this student has seen
    // on: their camera being off now is a pause, not "class not started".
    const camerasSeenOn = new Set();
    // Whether a teacher (moderator) has been in the room since this page
    // loaded: with none there now, the card says "stepped away", not
    // "begin shortly".
    let teacherHasJoined = false;
    // Whether the card should show (the latest render's answer), and the
    // first-frame wait while it still covers a camera that just came on.
    let cardWanted = false;
    let firstFrameTimer = null;

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
            // While the device status indicator holds the top-right corner,
            // the centred status chip keeps clear of it on both sides.
            "body." + SL_DEVICE_STATUS_ACTIVE_CLASS + " #" + SL_STAGE_ID + " .sl-stage-status { max-width: calc(100% - 2 * var(" + SL_DEVICE_STATUS_VAR_RESERVE + ", 16px)); }",
            "@media (max-width: 640px) { #" + SL_STAGE_ID + " .sl-stage-message { font-size: 14px; } #" + SL_STAGE_ID + " .sl-stage-status { top: 8px; font-size: 12px; } }",

            // ---- Toolbar above the stage (students only: this class is set
            // only while this student stage shows). The stage shares the
            // toolbar's parent (see getMountParent), so this comparison is
            // local; it is restated here so a server stylesheet lowering the
            // toolbar cannot put it under the stage. Jitsi's own value. ----
            "body." + SL_STAGE_ACTIVE_CLASS + " #new-toolbox.new-toolbox { z-index: 252; }",

            // ---- Teacher camera off: profile card on a deep-blue gradient.
            // Sized from the viewport (vmin) so it scales from phones to
            // fullscreen; text wraps, never cut. The bottom padding keeps the
            // card clear of Jitsi's toolbar. Only a short fade, no animation. ----
            "#" + SL_STAGE_ID + " .sl-stage-teacher { position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 20px 16px 76px; overflow: hidden; opacity: 0; visibility: hidden; transition: opacity .3s ease, visibility 0s linear .3s; background: radial-gradient(60% 50% at 50% 32%, rgba(59, 130, 246, 0.24), rgba(59, 130, 246, 0) 70%), radial-gradient(45% 40% at 88% 92%, rgba(14, 165, 233, 0.12), rgba(14, 165, 233, 0) 70%), linear-gradient(155deg, #12336B 0%, #0C2350 45%, #061430 100%); color: #F8FAFC; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; text-align: center; }",
            // Subtle dot grid, fading out towards the edges.
            "#" + SL_STAGE_ID + " .sl-stage-teacher::before { content: ''; position: absolute; inset: 0; pointer-events: none; background-image: radial-gradient(rgba(191, 219, 254, 0.16) 1px, transparent 1.4px); background-size: 26px 26px; -webkit-mask-image: radial-gradient(ellipse 60% 55% at 50% 45%, #000 20%, transparent 80%); mask-image: radial-gradient(ellipse 60% 55% at 50% 45%, #000 20%, transparent 80%); }",
            "#" + SL_STAGE_ID + ".sl-stage-teacher-off .sl-stage-teacher { opacity: 1; visibility: visible; transition: opacity .3s ease; }",
            // ... and the profile card starts below it (all screen sizes).
            "body." + SL_DEVICE_STATUS_ACTIVE_CLASS + " #" + SL_STAGE_ID + " .sl-stage-teacher { padding-top: calc(var(" + SL_DEVICE_STATUS_VAR_H + ", 0px) + 24px); }",
            "#" + SL_STAGE_ID + ".sl-stage-teacher-off .sl-stage-message { display: none; }",
            "#" + SL_STAGE_ID + " .sl-stage-teacher-card { position: relative; display: flex; flex-direction: column; align-items: center; box-sizing: border-box; width: min(440px, 100%); padding: clamp(20px, 4.5vmin, 40px) clamp(18px, 4.5vmin, 44px); border-radius: clamp(18px, 3vmin, 28px); border: 1px solid rgba(191, 219, 254, 0.14); background: linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.025)); box-shadow: 0 24px 64px rgba(2, 6, 23, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.07); }",
            "#" + SL_STAGE_ID + " .sl-stage-teacher-info { display: flex; flex-direction: column; align-items: center; min-width: 0; max-width: 100%; }",
            "#" + SL_STAGE_ID + " .sl-stage-avatar { position: relative; flex: 0 0 auto; box-sizing: border-box; width: clamp(80px, 20vmin, 148px); height: clamp(80px, 20vmin, 148px); padding: 3px; border-radius: 50%; background: linear-gradient(145deg, rgba(147, 197, 253, 0.85), rgba(37, 99, 235, 0.25)); box-shadow: 0 14px 36px rgba(2, 6, 23, 0.5), 0 0 0 8px rgba(147, 197, 253, 0.06); }",
            "#" + SL_STAGE_ID + " .sl-stage-avatar-inner { position: relative; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; overflow: hidden; border-radius: 50%; background: linear-gradient(145deg, #2563EB, #1E3A8A); }",
            "#" + SL_STAGE_ID + " .sl-stage-initials { font-size: clamp(26px, 7vmin, 52px); font-weight: 600; letter-spacing: 0.03em; color: #EFF6FF; }",
            "#" + SL_STAGE_ID + " .sl-stage-avatar-icon { display: none; width: 46%; height: 46%; color: #DBEAFE; }",
            "#" + SL_STAGE_ID + " .sl-stage-avatar-icon svg { display: block; width: 100%; height: 100%; }",
            "#" + SL_STAGE_ID + " .sl-stage-initials:empty { display: none; }",
            "#" + SL_STAGE_ID + " .sl-stage-initials:empty + .sl-stage-avatar-icon { display: block; }",
            // The photo shows only once it has loaded: never a broken image.
            "#" + SL_STAGE_ID + " .sl-stage-photo { position: absolute; inset: 0; display: none; width: 100%; height: 100%; object-fit: cover; }",
            "#" + SL_STAGE_ID + " .sl-stage-photo[data-loaded=\"true\"][src] { display: block; }",
            "#" + SL_STAGE_ID + " .sl-stage-cam-badge { position: absolute; right: 2%; bottom: 2%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: clamp(24px, 5.5vmin, 36px); height: clamp(24px, 5.5vmin, 36px); border-radius: 50%; background: #0B1F45; color: #FCA5A5; box-shadow: 0 0 0 3px #0E2758, 0 4px 12px rgba(2, 6, 23, 0.4); }",
            "#" + SL_STAGE_ID + " .sl-stage-cam-badge svg { width: 52%; height: 52%; }",
            "#" + SL_STAGE_ID + " .sl-stage-teacher-name { margin-top: clamp(14px, 2.6vmin, 22px); max-width: 100%; font-size: clamp(18px, 3.4vmin, 28px); font-weight: 650; line-height: 1.25; letter-spacing: -0.01em; color: #F8FAFC; overflow-wrap: anywhere; }",
            "#" + SL_STAGE_ID + " .sl-stage-teacher-role { margin-top: 4px; max-width: 100%; font-size: clamp(13px, 2vmin, 16px); font-weight: 500; line-height: 1.4; color: #93C5FD; overflow-wrap: anywhere; }",
            "#" + SL_STAGE_ID + " .sl-stage-teacher-role:empty { display: none; }",
            "#" + SL_STAGE_ID + " .sl-stage-divider { width: 40px; height: 1px; margin: clamp(14px, 2.6vmin, 22px) 0 clamp(12px, 2.2vmin, 18px); background: rgba(191, 219, 254, 0.22); }",
            "#" + SL_STAGE_ID + " .sl-stage-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px 4px 8px; border-radius: 999px; border: 1px solid rgba(248, 113, 113, 0.28); background: rgba(248, 113, 113, 0.1); color: #FECACA; font-size: 12px; font-weight: 600; line-height: 1.4; letter-spacing: 0.02em; }",
            "#" + SL_STAGE_ID + " .sl-stage-chip svg { flex: 0 0 auto; width: 14px; height: 14px; }",
            "#" + SL_STAGE_ID + " .sl-stage-teacher-title { margin-top: clamp(10px, 1.8vmin, 14px); font-size: clamp(15px, 2.4vmin, 19px); font-weight: 600; line-height: 1.35; color: #E2E8F0; text-wrap: balance; }",
            "#" + SL_STAGE_ID + " .sl-stage-teacher-text { margin-top: 4px; max-width: 36ch; font-size: clamp(12px, 1.8vmin, 14px); line-height: 1.5; color: #AFC2DE; text-wrap: balance; }",
            "@media (prefers-reduced-motion: reduce) { #" + SL_STAGE_ID + " .sl-stage-teacher, #" + SL_STAGE_ID + ".sl-stage-teacher-off .sl-stage-teacher { transition: none; } }",
            // Short landscape screens (phones, small tablets): avatar beside
            // the text, everything still shown.
            "@media (max-height: 460px) and (min-width: 520px) { "
                + "#" + SL_STAGE_ID + " .sl-stage-teacher { padding: 12px 20px 64px; } "
                + "#" + SL_STAGE_ID + " .sl-stage-teacher-card { flex-direction: row; align-items: center; gap: 20px; width: min(560px, 100%); padding: 16px 22px; text-align: left; } "
                + "#" + SL_STAGE_ID + " .sl-stage-teacher-info { align-items: flex-start; } "
                + "#" + SL_STAGE_ID + " .sl-stage-teacher-name { margin-top: 0; } "
                + "#" + SL_STAGE_ID + " .sl-stage-divider { margin: 10px 0; } }"
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

        // Inside the (transformed) conference page, position: fixed is
        // relative to the page, not the viewport: measure from the page.
        const mount = root.parentNode;
        const origin = mount && mount !== document.body && typeof mount.getBoundingClientRect === "function"
            ? mount.getBoundingClientRect()
            : null;
        const offsetTop = origin ? origin.top : 0;
        const offsetLeft = origin ? origin.left : 0;

        if (rect && rect.width > 0 && rect.height > 0) {
            root.style.top = Math.round(rect.top - offsetTop) + "px";
            root.style.left = Math.round(rect.left - offsetLeft) + "px";
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

    // The element holding Jitsi's toolbar (same stacking context as the
    // toolbar), else Jitsi's conference page, else <body>.
    function getMountParent() {
        const toolbar = document.getElementById(SL_STAGE_TOOLBAR_ID);

        return (toolbar && toolbar.parentNode)
            || document.getElementById(SL_STAGE_MOUNT_ID)
            || document.body;
    }

    // Into the mount parent, just BEFORE the toolbar when it is there: even
    // at an equal z-index the toolbar then paints above the stage.
    function mountRoot() {
        const parent = getMountParent();
        const toolbar = document.getElementById(SL_STAGE_TOOLBAR_ID);
        const before = toolbar && toolbar.parentNode === parent ? toolbar : null;

        if (root.parentNode !== parent || (before && root.nextSibling !== before)) {
            parent.insertBefore(root, before);
        }
    }

    function createTeacherPlaceholder() {
        const el = document.createElement("div");
        el.className = "sl-stage-teacher";

        const card = document.createElement("div");
        card.className = "sl-stage-teacher-card";

        const avatarEl = document.createElement("div");
        avatarEl.className = "sl-stage-avatar";

        const avatarInner = document.createElement("div");
        avatarInner.className = "sl-stage-avatar-inner";

        // Initials (or the icon, without a usable name) underneath; the
        // photo covers them only once it has actually loaded.
        const initialsEl = document.createElement("span");
        initialsEl.className = "sl-stage-initials";
        initialsEl.setAttribute("aria-hidden", "true");

        const iconEl = document.createElement("span");
        iconEl.className = "sl-stage-avatar-icon";
        iconEl.innerHTML = SL_STAGE_TEACHER_ICON;

        const photoEl = document.createElement("img");
        photoEl.className = "sl-stage-photo";
        photoEl.alt = "";
        photoEl.decoding = "async";
        photoEl.addEventListener("load", () => {
            photoEl.dataset.loaded = "true";
        });
        photoEl.addEventListener("error", () => {
            const failed = photoEl.getAttribute("src");

            photoEl.dataset.loaded = "false";

            if (failed) {
                failedPhotos.add(failed);
                photoEl.removeAttribute("src");
                console.warn("[SL Classroom] Teacher photo could not be loaded ("
                    + (/^blob:/.test(failed) ? "posted photo" : "photo URL") + "); showing initials.");
            }
        });

        const badgeEl = document.createElement("span");
        badgeEl.className = "sl-stage-cam-badge";
        badgeEl.innerHTML = SL_STAGE_CAMERA_OFF_ICON;

        avatarInner.appendChild(initialsEl);
        avatarInner.appendChild(iconEl);
        avatarInner.appendChild(photoEl);
        avatarEl.appendChild(avatarInner);
        avatarEl.appendChild(badgeEl);

        const infoEl = document.createElement("div");
        infoEl.className = "sl-stage-teacher-info";

        const nameEl = document.createElement("div");
        nameEl.className = "sl-stage-teacher-name";

        const roleEl = document.createElement("div");
        roleEl.className = "sl-stage-teacher-role";

        const dividerEl = document.createElement("div");
        dividerEl.className = "sl-stage-divider";
        dividerEl.setAttribute("aria-hidden", "true");

        const chipEl = document.createElement("div");
        chipEl.className = "sl-stage-chip";
        chipEl.innerHTML = SL_STAGE_CAMERA_OFF_ICON;

        const chipTextEl = document.createElement("span");
        chipTextEl.textContent = "Camera off";
        chipEl.appendChild(chipTextEl);

        const titleEl = document.createElement("div");
        titleEl.className = "sl-stage-teacher-title";
        titleEl.setAttribute("role", "status");

        const textEl = document.createElement("div");
        textEl.className = "sl-stage-teacher-text";

        infoEl.appendChild(nameEl);
        infoEl.appendChild(roleEl);
        infoEl.appendChild(dividerEl);
        infoEl.appendChild(chipEl);
        infoEl.appendChild(titleEl);
        infoEl.appendChild(textEl);

        card.appendChild(avatarEl);
        card.appendChild(infoEl);
        el.appendChild(card);

        return { el, photoEl, initialsEl, nameEl, roleEl, titleEl, textEl };
    }

    function clearFirstFrameWait() {
        if (firstFrameTimer) {
            clearTimeout(firstFrameTimer);
            firstFrameTimer = null;
        }
    }

    // The camera's first frame arrived (or the wait ran out): uncover the
    // video, unless the card is wanted again by now.
    function releaseCard() {
        clearFirstFrameWait();

        if (root && !cardWanted) {
            root.classList.remove("sl-stage-teacher-off");
        }
    }

    function ensureRoot() {
        if (root) {
            // Jitsi (React) can replace its page element, e.g. after a
            // reconnect: move the stage into the current one. Moving keeps
            // the attached track; playback is resumed by the render.
            mountRoot();

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

        teacherEl = createTeacherPlaceholder();

        video.addEventListener("loadeddata", releaseCard);
        video.addEventListener("playing", releaseCard);

        root.appendChild(video);
        root.appendChild(messageEl);
        root.appendChild(statusEl);
        root.appendChild(teacherEl.el);
        mountRoot();
    }

    // "Mr. Pathum Kumara (Teacher)" -> "Mr. Pathum Kumara".
    function stripTeacherSuffix(name) {
        return String(name || "").replace(/\s*\(teacher\)\s*$/i, "").trim();
    }

    // "Mr. Pathum Kumara" -> "PK" (the title is skipped).
    function teacherInitials(name) {
        const words = stripTeacherSuffix(name)
            .split(/\s+/)
            .filter(word => word && !/^(mr|mrs|ms|miss|dr|prof|rev)\.?$/i.test(word));

        if (words.length === 0) {
            return "";
        }

        const first = Array.from(words[0])[0] || "";
        const last = words.length > 1 ? Array.from(words[words.length - 1])[0] || "" : "";

        return (first + last).toUpperCase();
    }

    // The teacher participant to describe: the staged camera's owner, or
    // (no camera source yet) the first remote moderator in the room. null
    // when no teacher is in the room.
    function findTeacherParticipant(state, participantId) {
        const participants = state?.["features/base/participants"];
        const remote = participants?.remote;

        if (!remote || typeof remote.get !== "function") {
            return participantId ? { id: participantId, name: "" } : null;
        }

        if (participantId) {
            const participant = remote.get(participantId);

            return { id: participantId, name: participant?.name || "" };
        }

        const localId = participants?.local?.id;

        for (const [id, participant] of remote.entries()) {
            if (participant && !participant.fakeParticipant && id !== localId
                && participant.role === "moderator") {
                return { id, name: participant.name || "" };
            }
        }

        return null;
    }

    // What the camera-off placeholder shows for this participant: the class
    // teacher's profile from the parent page ONLY when it is that teacher
    // (exactly the same Jitsi display name), otherwise just the
    // participant's own name, so a co-teacher never gets another teacher's
    // photo or designation.
    function describeTeacher(participant) {
        const profile = stageView.teacher;

        if (profile && profile.jitsiName && profile.jitsiName === participant.name) {
            return {
                name: profile.name,
                initialsOf: profile.name,
                designation: profile.designation || "Teacher",
                photoUrl: profile.photoSrc
            };
        }

        const ownName = stripTeacherSuffix(participant.name);

        // No usable name: "Teacher" is shown, with the icon (no "T").
        return {
            name: ownName || "Teacher",
            initialsOf: ownName,
            designation: "Teacher",
            photoUrl: null
        };
    }

    // No teacher in the room (not joined yet, or left): the class teacher's
    // profile from the parent page, needing no Jitsi participant or track.
    // Without a profile (an older parent page): a generic teacher card with
    // the teacher icon.
    function describeAbsentTeacher() {
        const profile = stageView.teacher;

        if (profile) {
            return {
                name: profile.name,
                initialsOf: profile.name,
                designation: profile.designation || "Teacher",
                photoUrl: profile.photoSrc
            };
        }

        return { name: "Your teacher", initialsOf: "", designation: "Teacher", photoUrl: null };
    }

    // Stable per teacher across reconnects (participant IDs change).
    function teacherKey(participant) {
        return participant.name || participant.id;
    }

    function isTeacherMicOn(state, participantId) {
        const tracks = state?.["features/base/tracks"];

        return Array.isArray(tracks) && tracks.some(track =>
            track && !track.local && track.participantId === participantId
            && track.mediaType === "audio" && !track.muted);
    }

    // The card's wording, from the real state: the teacher's mic is live
    // (class going on by voice), the camera was on earlier (a pause), or
    // neither yet (class about to begin).
    function cardCopy(state, participant) {
        if (isTeacherMicOn(state, participant.id)) {
            return "voiceOnly";
        }

        return camerasSeenOn.has(teacherKey(participant)) ? "paused" : "waiting";
    }

    function renderTeacherPlaceholder(info, copyKey) {
        const photo = info.photoUrl && !failedPhotos.has(info.photoUrl) ? info.photoUrl : "";
        const copy = SL_STAGE_COPY[copyKey] || SL_STAGE_COPY.paused;

        teacherEl.nameEl.textContent = info.name;
        teacherEl.roleEl.textContent = info.designation;
        // Empty without a usable name: the teacher icon shows instead (CSS).
        teacherEl.initialsEl.textContent = teacherInitials(info.initialsOf);
        teacherEl.titleEl.textContent = copy.title;
        teacherEl.textEl.textContent = copy.text;

        if ((teacherEl.photoEl.getAttribute("src") || "") !== photo) {
            // Shown only after this photo's own load event (CSS).
            teacherEl.photoEl.dataset.loaded = "false";

            if (photo) {
                teacherEl.photoEl.setAttribute("src", photo);
            } else {
                teacherEl.photoEl.removeAttribute("src");
            }
        }
    }

    // The parent page's optional teacher profile. Text only (shown with
    // textContent); the photo must come from an SL Classroom origin.
    function readStageTeacher(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        const text = field => typeof field === "string" ? field.trim().slice(0, SL_STAGE_TEXT_MAX) : "";
        const name = text(value.name);

        if (!name) {
            return null;
        }

        let photoUrl = null;

        if (typeof value.photoUrl === "string" && typeof URL === "function") {
            try {
                const url = new URL(value.photoUrl);

                if (SL_ALLOWED_PARENT_ORIGINS.includes(url.origin)) {
                    photoUrl = url.href;
                }
            } catch (error) {
                /* not a URL: initials are shown */
            }
        }

        // What the <img> shows: the photo the parent page fetched and posted
        // (an object URL here, no cross-origin load at all), else the URL.
        const photoBlob = readPhotoBlob(value.photo);
        const photoSrc = photoBlob
            ? photoObjectUrl(photoBlob, (photoUrl || "") + "|" + photoBlob.type + "|" + photoBlob.size)
            : photoUrl;

        return {
            name,
            designation: text(value.designation),
            photoUrl,
            photoSrc,
            photoSource: photoBlob ? "blob" : photoUrl ? "url" : "none",
            jitsiName: text(value.jitsiName)
        };
    }

    // The posted photo: an image Blob of a sane size, else null.
    function readPhotoBlob(value) {
        return typeof Blob === "function" && value instanceof Blob
            && /^image\//i.test(value.type) && value.size > 0 && value.size <= SL_STAGE_PHOTO_MAX_BYTES
            ? value
            : null;
    }

    // One object URL per photo: the parent resends the same photo after every
    // SL_RECEIVE_READY, which reuses it (same key) instead of making another.
    function photoObjectUrl(blob, key) {
        if (photoObject.url && photoObject.key === key) {
            return photoObject.url;
        }

        if (typeof URL !== "function" || typeof URL.createObjectURL !== "function") {
            return null;
        }

        revokePhotoObject();

        try {
            photoObject = { key, url: URL.createObjectURL(blob) };
        } catch (error) {
            return null;
        }

        return photoObject.url;
    }

    function revokePhotoObject() {
        if (photoObject.url) {
            try {
                URL.revokeObjectURL(photoObject.url);
            } catch (error) {
                /* already gone */
            }
        }

        photoObject = { key: "", url: "" };
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
        cardWanted = false;
        clearFirstFrameWait();

        if (!root) {
            return;
        }

        document.body?.classList.remove(SL_STAGE_ACTIVE_CLASS);
        detachTrack();
        root.remove();
        root = null;
        video = null;
        messageEl = null;
        statusEl = null;
        teacherEl = null;

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
        // The teacher whose camera is off (the profile placeholder), or null.
        let cameraOffTeacher = null;
        // No teacher in the room at all: the card from the profile alone.
        let teacherAbsent = false;

        // Any teacher in the room now (also behind a share or a camera).
        if (findTeacherParticipant(state, null)) {
            teacherHasJoined = true;
        }

        if (!stage) {
            // In the room without any camera source yet (joined with the
            // camera off) is "camera off" too.
            cameraOffTeacher = findTeacherParticipant(state, null);

            // Nobody there: not joined yet (or left). The teacher's profile
            // card still shows; it never depends on a participant or track.
            teacherAbsent = !cameraOffTeacher;
        } else if (stage.videoType === "camera" && stage.muted) {
            cameraOffTeacher = findTeacherParticipant(state, stage.participantId);
        } else {
            const track = findStageTrack(state, stage);

            if (!track) {
                emptyMessage = "Connecting video…";
            } else if (track.muted) {
                if (stage.videoType === "camera") {
                    cameraOffTeacher = findTeacherParticipant(state, stage.participantId);
                } else {
                    emptyMessage = "Screen share paused";
                }
            } else {
                jitsiTrack = track.jitsiTrack;

                // This teacher's camera has been live: off later is a pause.
                if (stage.videoType === "camera") {
                    camerasSeenOn.add(teacherKey(findTeacherParticipant(state, stage.participantId)));
                }
            }
        }

        const teacherInfo = cameraOffTeacher
            ? describeTeacher(cameraOffTeacher)
            : teacherAbsent ? describeAbsentTeacher() : null;
        const copyKey = cameraOffTeacher
            ? cardCopy(state, cameraOffTeacher)
            : teacherAbsent ? (teacherHasJoined ? "away" : "waiting") : "";
        const status = jitsiTrack ? getStreamingStatus(jitsiTrack) : null;
        const statusMessage = (status && SL_STATUS_MESSAGES[status]) || "";

        // The store changes constantly; only touch the DOM when what the
        // stage shows actually changed.
        const signature = JSON.stringify([
            stage ? stage.sourceName : null,
            trackKey(jitsiTrack),
            emptyMessage,
            statusMessage,
            teacherInfo,
            copyKey
        ]);

        if (signature === lastSignature && root) {
            // Jitsi may have replaced its page element or re-rendered its
            // toolbar elsewhere: follow it.
            const parentBefore = root.parentNode;

            mountRoot();

            if (root.parentNode !== parentBefore) {
                position();
            }

            return;
        }

        lastSignature = signature;
        ensureRoot();
        document.body.classList.add(SL_STAGE_ACTIVE_CLASS);

        if (attachedTrack !== jitsiTrack) {
            detachTrack();

            if (jitsiTrack) {
                attachTrack(jitsiTrack);
            }
        }

        if (teacherInfo) {
            renderTeacherPlaceholder(teacherInfo, copyKey);
        }

        // The card: shown at once; when the camera comes back on it stays
        // over the video until the first frame is there (or the wait runs
        // out), so the change is card -> live video without a black frame.
        cardWanted = Boolean(teacherInfo);

        if (cardWanted) {
            clearFirstFrameWait();
            root.classList.add("sl-stage-teacher-off");
        } else if (root.classList.contains("sl-stage-teacher-off") && jitsiTrack
            && stage.videoType === "camera" && !(video.readyState >= 2)) {
            if (!firstFrameTimer) {
                firstFrameTimer = setTimeout(releaseCard, SL_STAGE_FIRST_FRAME_WAIT_MS);
            }
        } else {
            releaseCard();
        }

        root.classList.toggle("sl-stage-empty", Boolean(emptyMessage) || Boolean(teacherInfo));
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
        // ever shows while the local participant is not a moderator. A
        // malformed teacher profile is dropped on its own (the placeholder
        // then uses the Jitsi display name); it never blocks the stage.
        stageView = {
            epoch: data.epoch,
            enabled: data.enabled,
            teacher: readStageTeacher(data.teacher)
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
    //   __slStageViewTest.layers()   which custom.js runs, and whether the
    //                                toolbar paints above the stage
    // Affects only this browser's own display. The next SL_STAGE_VIEW from
    // the parent page replaces it.
    // ---------------------------------------------------------------------
    function describeNode(node) {
        if (!node) {
            return null;
        }

        return node.id ? "#" + node.id : String(node.tagName || "").toLowerCase();
    }

    function zIndexOf(node) {
        try {
            const value = parseInt(window.getComputedStyle(node).zIndex, 10);

            return Number.isFinite(value) ? value : null;
        } catch (error) {
            return null;
        }
    }

    window.__slStageViewTest = {
        on: () => {
            stageView = { ...stageView, enabled: true };
            lastSignature = "";
            render();
        },
        off: () => {
            stageView = { ...stageView, enabled: false };
            render();
        },
        layers: () => {
            const toolbar = document.getElementById(SL_STAGE_TOOLBAR_ID);
            const toggle = document.getElementById("sl-toolbar-toggle");
            const sameParent = Boolean(root && toolbar && root.parentNode === toolbar.parentNode);
            const siblings = sameParent ? Array.from(root.parentNode.children) : [];
            const stageZ = root ? zIndexOf(root) : null;
            const toolbarZ = toolbar ? zIndexOf(toolbar) : null;
            const stageBeforeToolbar = sameParent && siblings.indexOf(root) < siblings.indexOf(toolbar);

            return {
                customJsVersion: typeof SL_CUSTOM_JS_VERSION === "number" ? SL_CUSTOM_JS_VERSION : null,
                stageShown: Boolean(root),
                stageParent: describeNode(root && root.parentNode),
                toolbarParent: describeNode(toolbar && toolbar.parentNode),
                toggleParent: describeNode(toggle && toggle.parentNode),
                sameParent,
                stageBeforeToolbar,
                stageZ,
                toolbarZ,
                cardShown: Boolean(root && root.classList.contains("sl-stage-teacher-off")),
                // The teacher photo: where it came from ("blob" = posted by
                // the page, "url" = loaded directly, "none") and its state.
                photoSource: stageView.teacher ? stageView.teacher.photoSource : "none",
                photoState: !teacherEl ? null
                    : !teacherEl.photoEl.getAttribute("src") ? "none"
                        : teacherEl.photoEl.dataset.loaded === "true" ? "loaded" : "loading",
                toolbarAboveStage: sameParent && stageZ !== null && toolbarZ !== null
                    && (toolbarZ > stageZ || (toolbarZ === stageZ && stageBeforeToolbar))
            };
        }
    };

    window.addEventListener("resize", position);

    // Page teardown: detach the stage's own element and free the photo.
    window.addEventListener("pagehide", hide);
    window.addEventListener("pagehide", revokePhotoObject);

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
   SL Classroom - Student Filmstrip Hide

   Display only. Jitsi's own filmstrip is hidden completely for
   students. The page creates a student's iframe with
   config.filmstrip.disabled = true (a teacher's with false), but
   Jitsi still renders the filmstrip then: it only adds its
   "hidden" class and moves it off-screen with an inline "right".
   ".hidden { display: none }" (0,1,0) loses to Jitsi's
   ".vertical-filmstrip span:not(.tile-view) .filmstrip
   { display: flex }" (0,3,1), hence !important below.

   A body class is set only while the config says the filmstrip
   is disabled AND the local participant is not a moderator, so a
   teacher never gets it, before or after the role arrives. Jitsi's
   own class, inline styles and React state are never touched;
   what is received is unchanged (receive policy above).
========================================================== */

(function () {

    const SL_SF_CLASS = "sl-student-no-filmstrip";
    const SL_SF_STYLE_ID = "sl-student-filmstrip-style";

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    // The iframe was created for a student (filmstrip disabled by the page)
    // and the local participant is not a moderator.
    function shouldHide(state) {
        const filmstrip = state?.["features/base/config"]?.filmstrip;
        const local = state?.["features/base/participants"]?.local;

        return filmstrip?.disabled === true && local?.role !== "moderator";
    }

    function injectStyles() {
        if (document.getElementById(SL_SF_STYLE_ID) || !document.head) {
            return;
        }

        const style = document.createElement("style");

        style.id = SL_SF_STYLE_ID;
        style.textContent = "body." + SL_SF_CLASS + " .filmstrip { display: none !important; }";

        document.head.appendChild(style);
    }

    // Touches <body> only when the answer changes: other blocks observe its
    // class attribute.
    function render() {
        const body = document.body;

        if (!body) {
            return;
        }

        const hide = shouldHide(getState());

        if (hide) {
            injectStyles();
        }

        if (body.classList.contains(SL_SF_CLASS) !== hide) {
            body.classList.toggle(SL_SF_CLASS, hide);
        }
    }

    // Follow every store change: the local role arriving or changing, and
    // the config (Jitsi can overwrite it).
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function" || !document.body) {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(render);
        render();
    }, 500);

})();



/* ==========================================================
   SL Classroom - Student Device Status (camera / microphone)

   Display only. A small indicator in the top-right corner of the
   large video showing the STUDENT's OWN camera and microphone
   state, each on its own. It only reads Jitsi's store: nothing is
   muted, unmuted, created, sent or received here.

   The state is the local track's, never a claim that media
   reaches anyone: "Camera is on" means the local camera track
   exists and is not muted. From Jitsi's store (checked against
   jitsi-meet tag jitsi-meet_9268):
     features/base/tracks  local entries by mediaType ("video" with
       videoType "camera" - a screen share is never the camera -
       or "audio"): with a jitsiTrack it is the real track (muted,
       isReceivingData); without one it is the stub Jitsi adds
       while the device is starting (removed again if that fails).
     features/base/media.{video,audio}  muted (video: a bitmask,
       0 = not muted; audio: boolean) and available, for when
       there is no track at all.
   States: on, off (muted), starting, nodata (on, but the browser
   reports no data from the device), unavailable (available is
   false), notStarted (wanted on, no track and none starting, e.g.
   the device could not be started). Unknown (no conference yet,
   reconnecting, or a build without these slices): nothing shown.

   Runs ONLY when the local participant is not a moderator, and
   only while the parent page enables it:
     { type: "SL_DEVICE_STATUS_VIEW", v: 1, epoch, enabled, fullscreen }
     fullscreen: the page's own "Exit fullscreen" button covers
     the iframe's top-right corner, so the indicator moves left
   (resent by the parent after SL_RECEIVE_READY). Off by default.
========================================================== */

(function () {

    const SL_DS_ID = "sl-device-status";
    const SL_DS_STYLE_ID = "sl-device-status-style";
    // Mounted like the custom stage: in the element that holds Jitsi's
    // toolbar, just before it (same stacking context: z-index 200 above the
    // stage's 199, below the toolbar's 252).
    const SL_DS_MOUNT_ID = "videoconference_page";
    const SL_DS_TOOLBAR_ID = "new-toolbox";
    const SL_DS_MARGIN = 12;
    // The parent page's "Exit fullscreen" button (JitsiMeeting.tsx): 36px,
    // 12px from the top and right. Kept clear of it with a gap.
    const SL_DS_FULLSCREEN_RIGHT = 12 + 36 + SL_DEVICE_STATUS_GAP;

    // Static inline icons (Lucide shapes, ISC licence, as on the device setup
    // screen): camera, camera off, microphone, microphone off.
    const SL_DS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
    const SL_DS_ICONS = {
        video: SL_DS_SVG + '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
        videoOff: SL_DS_SVG + '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="m2 2 20 20"/></svg>',
        audio: SL_DS_SVG + '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>',
        audioOff: SL_DS_SVG + '<path d="m2 2 20 20"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M12 19v3"/></svg>'
    };

    // Per device and state: [full label, short label, tone, icon shape].
    // Tones: on (green), off (red), warn (amber, with a dot), pending (grey).
    const SL_DS_COPY = {
        video: {
            on: ["Camera is on", "Camera on", "on", "on"],
            off: ["Camera is off", "Camera off", "off", "off"],
            starting: ["Starting camera…", "Cam starting…", "pending", "on"],
            nodata: ["Camera on, no picture", "No picture", "warn", "on"],
            unavailable: ["Camera unavailable", "Cam unavailable", "warn", "off"],
            notStarted: ["Camera not started", "Cam not started", "warn", "off"]
        },
        audio: {
            on: ["Microphone is on", "Mic on", "on", "on"],
            off: ["Microphone is muted", "Mic muted", "off", "off"],
            starting: ["Starting microphone…", "Mic starting…", "pending", "on"],
            nodata: ["Microphone on, no input", "No mic input", "warn", "on"],
            unavailable: ["Microphone unavailable", "Mic unavailable", "warn", "off"],
            notStarted: ["Microphone not started", "Mic not started", "warn", "off"]
        }
    };

    let view = { epoch: 0, enabled: false, fullscreen: false };

    let root = null;
    // device ("video" | "audio") -> { el, iconEl, longEl, shortEl, srEl }
    const chips = {};
    let lastSignature = "";
    let lastLayout = "";
    let resizeObserver = null;
    // undefined: nothing observed yet (the first position() observes, even
    // when Jitsi has no large video container at that moment).
    let observedContainer;
    let renderQueued = false;

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    function isLocalModerator(state) {
        return state?.["features/base/participants"]?.local?.role === "moderator";
    }

    // One device's state from the store (see the header), never another
    // participant's: only local entries are read.
    function readDevice(state, mediaType) {
        const tracks = state?.["features/base/tracks"];
        const own = (Array.isArray(tracks) ? tracks : []).filter(track =>
            track && track.local && track.mediaType === mediaType
            && !(mediaType === "video" && track.videoType === "desktop"));
        const track = own.find(entry => entry.jitsiTrack);

        if (track) {
            if (track.muted) {
                return "off";
            }

            return track.isReceivingData === false ? "nodata" : "on";
        }

        // Jitsi's stub while the device starts (no jitsiTrack yet).
        if (own.length) {
            return "starting";
        }

        const media = state?.["features/base/media"]?.[mediaType];

        if (media.available === false) {
            return "unavailable";
        }

        return media.muted ? "off" : "notStarted";
    }

    // Both devices, or null when nothing should show (not enabled, a
    // moderator, no conference yet / reconnecting, or a build without the
    // media slice: unknown is never shown as a state).
    function readStatus(state) {
        if (!state || !view.enabled || isLocalModerator(state)
            || !state["features/base/conference"]?.conference) {
            return null;
        }

        const media = state["features/base/media"];

        if (!media || typeof media !== "object" || !media.video || !media.audio) {
            return null;
        }

        return { video: readDevice(state, "video"), audio: readDevice(state, "audio") };
    }

    function injectStyles() {
        if (document.getElementById(SL_DS_STYLE_ID)) {
            return;
        }

        const style = document.createElement("style");
        const R = "#" + SL_DS_ID;

        style.id = SL_DS_STYLE_ID;

        // Sizes follow the iframe (= the classroom area; the student's large
        // video fills it with the filmstrip hidden), so CSS pixels also follow
        // browser zoom:
        //   >= 860px  full labels (the centred stage chip, up to ~260px, stays
        //             clear of a ~280px indicator from 845px)
        //   700-859px short labels (~200px; clear from 685px)
        //   < 700px, or height <= 460px (phones, short landscape, narrow
        //             windows; the stage / PiP / toolbar switch at 640px and
        //             460px): icons only, the full label kept for screen
        //             readers. Clicks always pass through.
        style.textContent = [
            R + " { position: fixed; z-index: 200; display: none; align-items: center; gap: 6px; box-sizing: border-box; max-width: calc(100% - " + (2 * SL_DS_MARGIN) + "px); padding: 4px; border-radius: 999px; border: 1px solid rgba(148, 163, 184, 0.16); background: rgba(17, 24, 39, 0.82); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 6px 16px rgba(2, 6, 23, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.04); color: #F1F5F9; font: 500 12px/1 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; white-space: nowrap; pointer-events: none; }",
            R + ".sl-visible { display: inline-flex; }",
            R + " .sl-ds-chip { display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; min-width: 0; height: 26px; padding: 0 10px 0 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.04); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06); transition: background-color .15s ease, box-shadow .15s ease, color .15s ease; }",
            R + " .sl-ds-icon { position: relative; display: inline-flex; flex: 0 0 auto; width: 14px; height: 14px; color: #94A3B8; }",
            R + " .sl-ds-icon svg { display: block; width: 100%; height: 100%; }",
            R + " .sl-ds-long, " + R + " .sl-ds-short { overflow: hidden; text-overflow: ellipsis; }",
            R + " .sl-ds-short { display: none; }",
            // Visually hidden, read by screen readers in every size.
            R + " .sl-ds-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }",

            // Tones (Tailwind 300 tones on the dark pill, as on the device
            // setup screen; contrast above 4.5:1).
            R + " .sl-ds-chip[data-tone=on] { background: rgba(16, 185, 129, 0.12); box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.28); }",
            R + " .sl-ds-chip[data-tone=on] .sl-ds-icon { color: #6EE7B7; }",
            R + " .sl-ds-chip[data-tone=off] { background: rgba(239, 68, 68, 0.15); box-shadow: inset 0 0 0 1px rgba(239, 68, 68, 0.35); color: #FECACA; }",
            R + " .sl-ds-chip[data-tone=off] .sl-ds-icon { color: #FCA5A5; }",
            R + " .sl-ds-chip[data-tone=warn] { background: rgba(245, 158, 11, 0.14); box-shadow: inset 0 0 0 1px rgba(251, 191, 36, 0.35); color: #FDE68A; }",
            R + " .sl-ds-chip[data-tone=warn] .sl-ds-icon { color: #FCD34D; }",
            // A warning is never told by colour alone: a small dot on the icon.
            R + " .sl-ds-chip[data-tone=warn] .sl-ds-icon::after { content: ''; position: absolute; top: -2px; right: -3px; width: 6px; height: 6px; border-radius: 50%; background: #FBBF24; box-shadow: 0 0 0 1.5px #111827; }",
            R + " .sl-ds-chip[data-tone=pending] { color: #CBD5E1; }",

            "@media (max-width: 859px) { " + R + " .sl-ds-long { display: none; } " + R + " .sl-ds-short { display: inline; } }",
            "@media (max-width: 699px), (max-height: 460px) { "
                + R + " { gap: 4px; padding: 3px; } "
                + R + " .sl-ds-chip { justify-content: center; width: 28px; height: 28px; padding: 0; } "
                + R + " .sl-ds-long, " + R + " .sl-ds-short { display: none; } }",
            "@media (prefers-reduced-motion: reduce) { " + R + " .sl-ds-chip { transition: none; } }"
        ].join("\n");

        document.head.appendChild(style);
    }

    function getMountParent() {
        const toolbar = document.getElementById(SL_DS_TOOLBAR_ID);

        return (toolbar && toolbar.parentNode)
            || document.getElementById(SL_DS_MOUNT_ID)
            || document.body;
    }

    function mountRoot() {
        const parent = getMountParent();
        const toolbar = document.getElementById(SL_DS_TOOLBAR_ID);
        const before = toolbar && toolbar.parentNode === parent ? toolbar : null;

        if (root.parentNode !== parent || (before && root.nextSibling !== before)) {
            parent.insertBefore(root, before);
        }
    }

    function createChip(device) {
        const el = document.createElement("span");
        el.className = "sl-ds-chip";
        el.dataset.device = device;

        const iconEl = document.createElement("span");
        iconEl.className = "sl-ds-icon";

        // The visible labels are for sight only; the hidden one is read out.
        const longEl = document.createElement("span");
        longEl.className = "sl-ds-long";
        longEl.setAttribute("aria-hidden", "true");

        const shortEl = document.createElement("span");
        shortEl.className = "sl-ds-short";
        shortEl.setAttribute("aria-hidden", "true");

        const srEl = document.createElement("span");
        srEl.className = "sl-ds-sr";

        el.appendChild(iconEl);
        el.appendChild(longEl);
        el.appendChild(shortEl);
        el.appendChild(srEl);

        return { el, iconEl, longEl, shortEl, srEl };
    }

    function ensureRoot() {
        if (root) {
            mountRoot();

            return;
        }

        injectStyles();

        root = document.createElement("div");
        root.id = SL_DS_ID;
        // Announces a change once, politely; the same state is never re-read.
        root.setAttribute("role", "status");
        root.setAttribute("aria-label", "Your camera and microphone");

        ["video", "audio"].forEach(device => {
            chips[device] = createChip(device);
            root.appendChild(chips[device].el);
        });

        mountRoot();
    }

    function renderChip(device, state) {
        const chip = chips[device];
        const [full, short, tone, shape] = SL_DS_COPY[device][state];
        const icon = shape === "off" ? device + "Off" : device;

        chip.el.dataset.state = state;
        chip.el.dataset.tone = tone;

        if (chip.iconEl.dataset.icon !== icon) {
            chip.iconEl.dataset.icon = icon;
            chip.iconEl.innerHTML = SL_DS_ICONS[icon];
        }

        chip.longEl.textContent = full;
        chip.shortEl.textContent = short;
        chip.srEl.textContent = full;
    }

    // Top-right corner of the large video (Jitsi resizes it: window, chat,
    // rotation), measured like the custom stage does. In the page's
    // fullscreen it moves left of the page's "Exit fullscreen" button. Then
    // the room it takes is published for the PiP and the stage chip.
    function position() {
        if (!root) {
            return;
        }

        const container = document.getElementById("largeVideoContainer");
        const rect = container ? container.getBoundingClientRect() : null;

        // Inside the (transformed) conference page, position: fixed is
        // relative to the page, not the viewport: measure from the page.
        const mount = root.parentNode;
        const origin = mount && mount !== document.body && typeof mount.getBoundingClientRect === "function"
            ? mount.getBoundingClientRect()
            : null;
        const originTop = origin ? origin.top : 0;
        const originRight = origin ? origin.right : (window.innerWidth || 0);
        const hasRect = Boolean(rect && rect.width > 0 && rect.height > 0);
        // From the large video's right edge to the iframe's.
        const fromEdge = hasRect ? Math.max(0, originRight - rect.right) : 0;
        const inset = Math.max(SL_DS_MARGIN, view.fullscreen ? SL_DS_FULLSCREEN_RIGHT - fromEdge : 0);

        root.style.top = Math.round((hasRect ? rect.top - originTop : 0) + SL_DS_MARGIN) + "px";
        root.style.right = Math.round(fromEdge + inset) + "px";

        // Follow the large video's size and the indicator's own (its labels
        // change with the width).
        if (container !== observedContainer && typeof ResizeObserver === "function") {
            resizeObserver = resizeObserver || new ResizeObserver(position);
            resizeObserver.disconnect();
            resizeObserver.observe(root);

            if (container) {
                resizeObserver.observe(container);
            }

            observedContainer = container;
        }

        const own = root.getBoundingClientRect();
        const height = Math.round(own.height || 0);
        const reserve = Math.round((own.width || 0) + inset + SL_DEVICE_STATUS_GAP);
        const layout = height + ":" + reserve;

        if (layout !== lastLayout && document.body) {
            lastLayout = layout;
            document.body.style.setProperty(SL_DEVICE_STATUS_VAR_H, height + "px");
            document.body.style.setProperty(SL_DEVICE_STATUS_VAR_RESERVE, reserve + "px");
            window.dispatchEvent(new CustomEvent(SL_DEVICE_STATUS_LAYOUT_EVENT));
        }
    }

    // Removes the indicator completely: out of the DOM, not observed, and
    // nothing of it left on <body> (the PiP and stage chip move back).
    function hide() {
        lastSignature = "";

        if (!root) {
            return;
        }

        if (resizeObserver) {
            resizeObserver.disconnect();
        }

        observedContainer = undefined;
        root.remove();
        root = null;
        lastLayout = "";

        if (document.body) {
            document.body.classList.remove(SL_DEVICE_STATUS_ACTIVE_CLASS);
            document.body.style.removeProperty(SL_DEVICE_STATUS_VAR_H);
            document.body.style.removeProperty(SL_DEVICE_STATUS_VAR_RESERVE);
        }

        window.dispatchEvent(new CustomEvent(SL_DEVICE_STATUS_LAYOUT_EVENT));
    }

    function renderNow() {
        const status = readStatus(getState());

        if (!status || !document.body) {
            hide();
            return;
        }

        const signature = status.video + "|" + status.audio + "|" + view.fullscreen;

        if (signature === lastSignature && root) {
            // Jitsi may have replaced its page element: follow it.
            const parentBefore = root.parentNode;

            mountRoot();

            if (root.parentNode !== parentBefore) {
                position();
            }

            return;
        }

        lastSignature = signature;
        ensureRoot();
        renderChip("video", status.video);
        renderChip("audio", status.audio);
        root.classList.add("sl-visible");

        if (!document.body.classList.contains(SL_DEVICE_STATUS_ACTIVE_CLASS)) {
            document.body.classList.add(SL_DEVICE_STATUS_ACTIVE_CLASS);
        }

        position();
    }

    // Once per task: Jitsi changes a device in several dispatches (e.g. the
    // unmute request, then the starting stub), and an in-between state must
    // never be shown.
    function render() {
        if (renderQueued) {
            return;
        }

        renderQueued = true;
        Promise.resolve().then(() => {
            renderQueued = false;
            renderNow();
        });
    }

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_DEVICE_STATUS_VIEW") {
            return;
        }

        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || typeof data.enabled !== "boolean"
            || typeof data.fullscreen !== "boolean") {
            console.warn("[SL Classroom] Ignored malformed device status view", data);

            return;
        }

        // An older message must never overwrite a newer one. The same epoch
        // is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < view.epoch) {
            return;
        }

        // Kept even before the local role is known: the indicator itself
        // only ever shows while the local participant is not a moderator.
        view = { epoch: data.epoch, enabled: data.enabled, fullscreen: data.fullscreen };

        console.log("[SL Classroom] Device status view", view);

        lastSignature = "";
        render();
    });

    // ---------------------------------------------------------------------
    // TESTING ONLY - from the Jitsi iframe's DevTools console:
    //   __slDeviceStatusTest.on()   __slDeviceStatusTest.off()
    //   __slDeviceStatusTest.state()   what is read and shown
    // Affects only this browser's own display. The next
    // SL_DEVICE_STATUS_VIEW from the parent page replaces it.
    // ---------------------------------------------------------------------
    window.__slDeviceStatusTest = {
        on: () => {
            view = { ...view, enabled: true };
            lastSignature = "";
            render();
        },
        off: () => {
            view = { ...view, enabled: false };
            render();
        },
        state: () => {
            const status = readStatus(getState());

            return {
                customJsVersion: typeof SL_CUSTOM_JS_VERSION === "number" ? SL_CUSTOM_JS_VERSION : null,
                enabled: view.enabled,
                fullscreen: view.fullscreen,
                shown: Boolean(root),
                camera: status ? status.video : null,
                microphone: status ? status.audio : null,
                parent: root && root.parentNode ? (root.parentNode.id ? "#" + root.parentNode.id : root.parentNode.tagName) : null
            };
        }
    };

    window.addEventListener("resize", position);

    // Page teardown: our element and everything on <body> goes.
    window.addEventListener("pagehide", hide);

    // Follow every store change: the local tracks, mute state, the
    // conference (reconnect) and the local role.
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function" || !document.body) {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(render);
        render();
    }, 500);

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
   screen or an upright touch tablet gets it at the bottom (the choice
   itself is kept), unless the teacher picks a position there that fits
   (kept for the page session; positions that do not fit are disabled). The teacher picks the position with a small layout button
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

    // Phase D: placeholder status of a rotating student tile, by its mode
    // (modes with a frame or live video show none).
    const SL_TV_TILE_PLACEHOLDER_STATUS = {
        waiting: "Camera on",
        connecting: "Connecting…",
        off: "Camera off",
        disconnected: "Disconnected"
    };

    // Tiles view (SL_TEACHER_TILES from the parent page): the page's
    // students in a grid, an enlarged-video panel, page navigation that asks
    // the parent page (which owns the roster and the paging) to move.
    const SL_TV_TILES_MODE_CLASS = "sl-tv-tiles-mode";
    const SL_TV_VAR_GRID_COLS = "--sl-tv-grid-cols";
    // The tile width the columns were chosen for (layoutTilesGrid).
    const SL_TV_VAR_TILE_W = "--sl-tv-tile-w";
    const SL_TV_GRID_GAP = 8;
    // Narrowest grid tile: a page that fits only with smaller tiles keeps
    // this width and the grid scrolls (phones). Larger screens always fit.
    const SL_TV_MIN_TILE_W = 96;
    // Below this tile width the placeholder shows only a small icon + name.
    const SL_TV_COMPACT_TILE_W = 112;
    const SL_TV_GRID_COMPACT_CLASS = "sl-tv-grid-compact";
    // Space kept free under the grid for Jitsi's toolbar (CSS padding-bottom):
    // the default, a short screen's, and none when the toolbar floats over a
    // stacked enlarged panel instead.
    const SL_TV_VAR_GRID_PAD_B = "--sl-tv-grid-pad-b";
    const SL_TV_GRID_RESERVE = 96;
    const SL_TV_GRID_RESERVE_SHORT = 64;
    const SL_TV_GRID_RESERVE_STACKED = 8;
    const SL_TV_SHORT_HEIGHT = 500;
    // The enlarged panel stacks under the grid at this width and below (CSS).
    const SL_TV_PANEL_STACK_WIDTH = 640;
    const SL_TV_TILES_MAX_PAGE = 50;
    const SL_TV_PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
    const SL_TV_CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    // The settings menu's View section (static icons) and the Tiles view's
    // page sizes. The choice itself belongs to the parent page
    // (SL_TEACHER_TILES_SETTINGS); this view shows what it sends back.
    const SL_TV_VIEW_LABELS = { list: "List", tiles: "Tiles" };
    const SL_TV_VIEW_ICONS = {
        list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.25"/><rect x="5.5" y="6.5" width="8.5" height="11" rx="1" fill="currentColor" stroke="none" opacity=".35"/><path d="M16.5 8h2M16.5 12h2M16.5 16h2"/></svg>',
        tiles: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3.5" y="4.5" width="7.5" height="6.5" rx="1.25"/><rect x="13" y="4.5" width="7.5" height="6.5" rx="1.25"/><rect x="3.5" y="13" width="7.5" height="6.5" rx="1.25"/><rect x="13" y="13" width="7.5" height="6.5" rx="1.25"/></svg>'
    };
    const SL_TV_TILES_PAGE_SIZES = [10, 20, 30, 40, 50];

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
    // Screens narrower than this show the filmstrip at the bottom, whatever
    // their shape (a phone's page chrome can leave a portrait phone's view
    // wider than tall); so do upright touch screens narrower than the tablet
    // width. The teacher's chosen position is kept and comes back when the
    // screen allows it.
    const SL_TV_NARROW_WIDTH = 600;
    const SL_TV_TABLET_MAX_WIDTH = 1100;
    // Settings menu on a short screen: kept this far from the view's edge,
    // and lifted over the toolbar only if at least this much height is left.
    const SL_TV_MENU_EDGE = 8;
    const SL_TV_MENU_MIN_HEIGHT = 120;
    const SL_TV_KEY_STEP = 16;

    // Filmstrip layout control: the teacher picks the position on the
    // filmstrip itself. The choice is reported to the parent page, which
    // remembers it (localStorage) and sends it back with SL_TEACHER_VIEW.
    const SL_TV_POSITION_LABELS = { right: "Right", left: "Left", top: "Top", bottom: "Bottom" };
    // The menu's note (also describes positions that do not fit the screen).
    const SL_TV_LAYOUT_NOTE_ID = "sl-tv-layout-note";
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
    // The teacher chose a position while the screen was placing the filmstrip
    // at the bottom by itself: that choice then wins wherever it fits. This
    // page session only (never persisted or reported); survives Exam Mode.
    let positionChosenHere = false;
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

    // Tiles view: layout and the current page, as the parent page sent them.
    let tilesView = {
        epoch: 0, layout: "list", participantIds: [], page: 0, pageCount: 0, rangeStart: 0, rangeEnd: 0, total: 0,
        // The selected Tiles page size (0: not sent by this parent page).
        pageSize: 0
    };
    // Names of page students seen, for a tile / panel after they left.
    const knownNames = new Map();
    // The enlarged-video panel: { id, name } or null (closed).
    let enlarged = null;
    // The grid's measured reading order (slSpatialOrder), for the scheduler's
    // nearby groups; re-measured when the tiles or the grid size change.
    let gridOrder = null;
    // ... and where each tile is ({ id: { row, x } }), for compact groups.
    let gridPositions = null;
    let gridOrderKey = "";
    let gridColumns = 0;
    let gridObserver = null;
    let gridViewEl = null;
    let gridLabelEl = null;
    let gridPrevEl = null;
    let gridNextEl = null;
    let gridEl = null;
    let gridEmptyEl = null;
    // Tiles view: the grid bar's settings button (opens the same settings
    // menu as the filmstrip's button, which is hidden in the Tiles view).
    let gridSettingsWrapEl = null;
    let gridSettingsEl = null;
    let panelEl = null;
    let panelBodyEl = null;
    let panelVideo = null;
    let panelNameEl = null;
    let panelStateEl = null;
    let panelPlaceholder = null;
    let panelTrack = null;
    // The panel follows its track's streaming status like a tile does.
    const panelWatch = { statusTrack: null };
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
    // Settings menu: the View items and the Tiles-per-page row.
    let viewSectionEl = null;
    let pageSizeSectionEl = null;
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

    // ---- Jitsi's own large video while this view shows ----------------------
    //
    // #largeVideo is covered (CSS visibility: hidden, above) while this view
    // shows, yet Jitsi keeps it PLAYING the same stream our stage shows. Only
    // that element is paused here: never its stream or tracks (our stage and
    // tiles keep playing them), never detached, never display: none (Jitsi
    // sizes its stage request from the large video area). Nothing Jitsi-side
    // (pin, receiver constraints) changes, so the bridge forwards exactly the
    // same.
    //
    // Lifecycle: suppressLargeVideo() on every render while the view shows
    // (Normal and Tiles), releaseLargeVideo() from hide() (Exam Mode, view
    // disabled, not a moderator, page teardown).
    //
    // Jitsi can restart the element (autoplay on a new stream, its own play())
    // or replace it (React remount: rejoin, breakout room). Covered by:
    //   - a "play" listener on the current element, re-pausing it while
    //     suppressed (a "play" event queued before the release and handled
    //     after it is ignored: it checks the flag when it runs);
    //   - the check on every render (store changes come with stream / large
    //     video changes): catches playback that started before the listener
    //     was attached, and moves the listener to a replaced element.
    // Release resumes only elements this code paused and that are still in
    // the page with a stream (Jitsi's own intent for that element: autoplay).
    // An element this code never paused is left alone.
    const SL_TV_LARGE_VIDEO_ID = "largeVideo";

    let largeVideoSuppressed = false;
    // The element carrying our "play" listener (at most one).
    let guardedLargeVideo = null;
    // Elements this code paused (resumed on release, then forgotten).
    const pausedLargeVideos = new WeakSet();

    function getLargeVideo() {
        const el = document.getElementById(SL_TV_LARGE_VIDEO_ID);

        return el && typeof el.pause === "function" && typeof el.play === "function" ? el : null;
    }

    function pauseLargeVideo(el) {
        if (!el.paused) {
            el.pause();
            pausedLargeVideos.add(el);
        }
    }

    function onLargeVideoPlay() {
        if (largeVideoSuppressed && guardedLargeVideo && !guardedLargeVideo.paused) {
            pauseLargeVideo(guardedLargeVideo);
        }
    }

    function guardLargeVideo(el) {
        if (guardedLargeVideo === el) {
            return;
        }

        if (guardedLargeVideo) {
            guardedLargeVideo.removeEventListener("play", onLargeVideoPlay);
        }

        guardedLargeVideo = el;

        if (el) {
            el.addEventListener("play", onLargeVideoPlay);
        }
    }

    function suppressLargeVideo() {
        largeVideoSuppressed = true;

        const el = getLargeVideo();

        guardLargeVideo(el);

        if (el) {
            pauseLargeVideo(el);
        }
    }

    function releaseLargeVideo() {
        if (!largeVideoSuppressed && !guardedLargeVideo) {
            return;
        }

        largeVideoSuppressed = false;
        guardLargeVideo(null);

        // The current element (the paused one may have been replaced since).
        const el = getLargeVideo();

        if (!el || !pausedLargeVideos.has(el)) {
            return;
        }

        pausedLargeVideos.delete(el);

        if (el.paused && el.srcObject && el.isConnected !== false) {
            resumeJitsiVideo(el);
        }
    }

    // Gives a Jitsi element this code paused back to playback.
    function resumeJitsiVideo(el) {
        try {
            const playing = el.play();

            // Rejected when Jitsi swaps the stream or the view comes back
            // (AbortError), or autoplay is refused: Jitsi's own autoplay
            // still applies, nothing to report.
            if (playing && typeof playing.catch === "function") {
                playing.catch(() => {});
            }
        } catch (error) {
            /* element gone */
        }
    }

    // ---- Jitsi's own filmstrip videos while this view shows -----------------
    //
    // Jitsi's filmstrip is hidden (CSS visibility, above) while this view
    // shows, yet each of its <video> elements keeps PLAYING (the same remote
    // streams our tiles play). Same approach as #largeVideo above: only the
    // elements are paused, never a stream or track, nothing detached, nothing
    // Jitsi-side changed. #largeVideo is left to the code above (one owner),
    // and nothing inside this view (#sl-teacher-view) is ever touched.
    //
    // Lifecycle: suppressFilmstripVideos() beside suppressLargeVideo() on
    // every render while the view shows (Normal and Tiles: a List <-> Tiles
    // switch keeps it), releaseFilmstripVideos() from hide().
    //
    // While suppressed:
    //   - each filmstrip <video> has a "play" listener re-pausing it (Jitsi's
    //     play(), autoplay on a newly attached stream);
    //   - one MutationObserver (childList) notices videos Jitsi adds, removes
    //     or replaces after the view showed; disconnected on release;
    //   - every render re-checks too (store changes come with track changes).
    // A pause records the stream the element had. Release resumes only
    // elements this code paused that still sit in Jitsi's filmstrip, paused,
    // with that same stream; a removed, moved or rebound element is left to
    // Jitsi. If Jitsi restarts an element over and over (it fights the
    // pause), that element is left playing until the release.
    const SL_TV_FILMSTRIP_VIDEO_SELECTOR = ".filmstrip video";
    const SL_TV_FILMSTRIP_CLASS = "filmstrip";
    const SL_TV_REPAUSE_LIMIT = 5;
    const SL_TV_REPAUSE_WINDOW_MS = 2000;

    let filmstripSuppressed = false;
    let filmstripObserver = null;
    // element -> { onPlay, paused (by this code), stream (when paused),
    // pausedAt (recent pause times), yielded (left playing) }
    const guardedFilmstripVideos = new Map();
    // element -> the stream it had when this code paused it. Outlives the
    // element's guard, so an element Jitsi takes out of the filmstrip and
    // puts back later (another tick) is still known as paused by this code.
    // A new map on every release: no record reaches the next activation.
    let filmstripPauseRecords = new WeakMap();

    // A <video> in the page, inside Jitsi's filmstrip, outside this view.
    function isJitsiFilmstripVideo(el) {
        if (!el || el.id === SL_TV_LARGE_VIDEO_ID || typeof el.pause !== "function" || typeof el.play !== "function") {
            return false;
        }

        let inFilmstrip = false;

        for (let node = el.parentNode; node; node = node.parentNode) {
            if (node.id === SL_TV_ID) {
                return false;
            }

            if (node.classList && node.classList.contains(SL_TV_FILMSTRIP_CLASS)) {
                inFilmstrip = true;
            }

            if (node === document.documentElement) {
                return inFilmstrip;
            }
        }

        // Not in the page (removed by Jitsi).
        return false;
    }

    function pauseFilmstripVideo(el, entry) {
        if (entry.yielded || el.paused) {
            return;
        }

        const now = Date.now();

        entry.pausedAt = entry.pausedAt.filter(at => now - at < SL_TV_REPAUSE_WINDOW_MS);

        if (entry.pausedAt.length >= SL_TV_REPAUSE_LIMIT) {
            // Jitsi keeps restarting it: no play/pause fight, it plays.
            entry.yielded = true;
            entry.paused = false;
            filmstripPauseRecords.delete(el);
            el.removeEventListener("play", entry.onPlay);
            return;
        }

        entry.pausedAt.push(now);
        el.pause();
        entry.paused = true;
        entry.stream = el.srcObject || null;
        filmstripPauseRecords.set(el, entry.stream);
    }

    function guardFilmstripVideo(el) {
        let entry = guardedFilmstripVideos.get(el);

        if (!entry) {
            entry = { onPlay: null, paused: false, stream: null, pausedAt: [], yielded: false };

            // Back in the filmstrip after a removal: still paused by this
            // code, with the stream it had then (release compares it).
            if (filmstripPauseRecords.has(el)) {
                entry.paused = true;
                entry.stream = filmstripPauseRecords.get(el);
            }

            entry.onPlay = () => {
                // A "play" queued before the release and handled after it,
                // or an element moved out of the filmstrip: left alone.
                if (filmstripSuppressed && guardedFilmstripVideos.get(el) === entry && isJitsiFilmstripVideo(el)) {
                    pauseFilmstripVideo(el, entry);
                }
            };
            guardedFilmstripVideos.set(el, entry);
            el.addEventListener("play", entry.onPlay);
        }

        return entry;
    }

    function unguardFilmstripVideo(el, entry) {
        el.removeEventListener("play", entry.onPlay);
        guardedFilmstripVideos.delete(el);
    }

    function sweepFilmstripVideos() {
        // Elements Jitsi removed or moved: unguarded, never resumed from
        // outside the filmstrip (their pause record stays, see above).
        guardedFilmstripVideos.forEach((entry, el) => {
            if (!isJitsiFilmstripVideo(el)) {
                unguardFilmstripVideo(el, entry);
            }
        });

        Array.from(document.querySelectorAll(SL_TV_FILMSTRIP_VIDEO_SELECTOR)).forEach(el => {
            if (isJitsiFilmstripVideo(el)) {
                pauseFilmstripVideo(el, guardFilmstripVideo(el));
            }
        });
    }

    // Is (or contains) a <video> - text nodes and our own view excluded.
    function hasVideo(node) {
        return Boolean(node && node.id !== SL_TV_ID && (node.tagName === "VIDEO"
            || (typeof node.querySelectorAll === "function" && node.querySelectorAll("video").length)));
    }

    function onFilmstripMutations(records) {
        if (!filmstripSuppressed) {
            return;
        }

        // Only additions / removals of videos outside this view matter (this
        // view's own tiles move on every render). Pausing is not a childList
        // change, so the sweep never re-triggers this observer.
        const relevant = (records || []).some(record =>
            !(root && root.contains(record.target))
            && (Array.from(record.addedNodes || []).some(hasVideo)
                || Array.from(record.removedNodes || []).some(hasVideo)));

        if (relevant) {
            sweepFilmstripVideos();
        }
    }

    function suppressFilmstripVideos() {
        filmstripSuppressed = true;

        // One observer however often this runs.
        if (!filmstripObserver && typeof MutationObserver === "function" && document.body) {
            filmstripObserver = new MutationObserver(onFilmstripMutations);
            filmstripObserver.observe(document.body, { childList: true, subtree: true });
        }

        sweepFilmstripVideos();
    }

    function releaseFilmstripVideos() {
        if (!filmstripSuppressed && !filmstripObserver && !guardedFilmstripVideos.size) {
            return;
        }

        filmstripSuppressed = false;

        if (filmstripObserver) {
            filmstripObserver.disconnect();
            filmstripObserver = null;
        }

        const entries = Array.from(guardedFilmstripVideos);

        guardedFilmstripVideos.clear();
        filmstripPauseRecords = new WeakMap();

        entries.forEach(([el, entry]) => {
            el.removeEventListener("play", entry.onPlay);

            if (entry.paused && el.paused && el.srcObject && el.srcObject === entry.stream
                && isJitsiFilmstripVideo(el)) {
                resumeJitsiVideo(el);
            }
        });
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
                // Phase D: camera ON from presence (SourceInfo), whether or
                // not it is being received right now.
                cameraOn: isCameraSourceOn(participant),
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

    // A touch screen (no fine pointer): tablets and phones.
    function isCoarsePointer() {
        try {
            return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
        } catch (error) {
            return false;
        }
    }

    // Whether the screen places the filmstrip at the bottom by itself: a
    // narrow screen (any shape), or an upright touch screen up to tablet
    // width. Only when the height still fits the smallest stage above the
    // smallest strip.
    function isAutoBottom(box) {
        if (box.width <= 0 || box.height < SL_TV_MIN_STAGE_HEIGHT + SL_TV_MIN_STRIP_H) {
            return false;
        }

        const narrow = box.width < SL_TV_NARROW_WIDTH;
        const uprightTablet = box.height > box.width && box.width < SL_TV_TABLET_MAX_WIDTH && isCoarsePointer();

        return narrow || uprightTablet;
    }

    // The smallest strip beside / above the smallest stage fits.
    function positionFits(position, box) {
        return isVerticalPosition(position)
            ? box.width >= SL_TV_MIN_STRIP_V + SL_TV_MIN_STAGE_WIDTH
            : box.height >= SL_TV_MIN_STAGE_HEIGHT + SL_TV_MIN_STRIP_H;
    }

    // Whether the teacher can choose this position now: always, except
    // while the screen places the filmstrip itself, where it must fit.
    function isPositionAvailable(position, box) {
        return !isAutoBottom(box) || positionFits(position, box);
    }

    // The teacher's position, except where the screen places the filmstrip
    // at the bottom by itself; there a position the teacher chose there
    // (positionChosenHere) still wins while it fits. The preference itself
    // is never changed and nothing is reported to the parent page.
    function getEffectivePosition(box) {
        if (!isAutoBottom(box)) {
            return preferredPosition;
        }

        return positionChosenHere && positionFits(preferredPosition, box) ? preferredPosition : "bottom";
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
        root.classList.toggle(SL_TV_TILES_MODE_CLASS, isTilesMode());

        // Tiles view has no filmstrip: Jitsi's toolbar is laid out as for a
        // hidden one (full width, no bottom-filmstrip offset).
        const stripGone = stripHidden || isTilesMode();

        if (document.body.classList.contains(SL_TV_STRIP_HIDDEN_CLASS) !== stripGone) {
            document.body.classList.toggle(SL_TV_STRIP_HIDDEN_CLASS, stripGone);
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
        const pillOffset = position === "bottom" && !stripGone ? stripH : 0;

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
        layoutMenuEl.setAttribute("aria-label", "View and filmstrip settings");
        layoutMenuEl.hidden = true;

        // View: List / Tiles, and the Tiles view's page size. The parent page
        // owns both (it pages the roster); a choice is sent there and shown
        // here once it comes back (SL_TEACHER_TILES).
        viewSectionEl = document.createElement("div");
        viewSectionEl.className = "sl-tv-view-section";

        const viewTitle = document.createElement("div");
        viewTitle.className = "sl-tv-layout-title";
        viewTitle.textContent = "View";
        viewSectionEl.appendChild(viewTitle);

        const viewRow = document.createElement("div");
        viewRow.className = "sl-tv-view-row";
        viewRow.setAttribute("role", "group");
        viewRow.setAttribute("aria-label", "View");

        ["list", "tiles"].forEach(layout => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "sl-tv-layout-item sl-tv-view-item";
            item.dataset.view = layout;
            item.setAttribute("role", "menuitemradio");
            item.innerHTML = SL_TV_VIEW_ICONS[layout] + "<span></span>";
            item.querySelector("span").textContent = SL_TV_VIEW_LABELS[layout];
            item.addEventListener("click", () => chooseTeacherView(layout));
            viewRow.appendChild(item);
        });

        viewSectionEl.appendChild(viewRow);

        pageSizeSectionEl = document.createElement("div");
        pageSizeSectionEl.className = "sl-tv-pagesize-section";

        const pageSizeTitle = document.createElement("div");
        pageSizeTitle.className = "sl-tv-pagesize-title";
        pageSizeTitle.textContent = "Tiles per page";
        pageSizeSectionEl.appendChild(pageSizeTitle);

        const pageSizeRow = document.createElement("div");
        pageSizeRow.className = "sl-tv-pagesize-row";
        pageSizeRow.setAttribute("role", "group");
        pageSizeRow.setAttribute("aria-label", "Tiles per page");

        SL_TV_TILES_PAGE_SIZES.forEach(size => {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "sl-tv-pagesize";
            option.dataset.pageSize = String(size);
            option.textContent = String(size);
            option.setAttribute("aria-label", size + " tiles per page");
            option.addEventListener("click", () => chooseTilesPageSize(size));
            pageSizeRow.appendChild(option);
        });

        pageSizeSectionEl.appendChild(pageSizeRow);
        viewSectionEl.appendChild(pageSizeSectionEl);
        layoutMenuEl.appendChild(viewSectionEl);

        const viewDivider = document.createElement("div");
        viewDivider.className = "sl-tv-layout-divider";
        layoutMenuEl.appendChild(viewDivider);

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
        note.id = SL_TV_LAYOUT_NOTE_ID;
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
    // it elsewhere (bottom), and which positions do not fit this screen
    // (marked aria-disabled; choosing one changes nothing).
    function updateLayoutMenu() {
        if (!layoutMenuEl) {
            return;
        }

        const box = getLayoutBox();
        const unavailable = [];

        layoutMenuEl.querySelectorAll(".sl-tv-layout-item[data-position]").forEach(item => {
            const position = item.dataset.position;

            item.setAttribute("aria-checked", position === preferredPosition ? "true" : "false");

            if (isPositionAvailable(position, box)) {
                item.removeAttribute("aria-disabled");
                item.removeAttribute("aria-describedby");
                item.removeAttribute("title");
            } else {
                unavailable.push(SL_TV_POSITION_LABELS[position]);
                item.setAttribute("aria-disabled", "true");
                item.setAttribute("aria-describedby", SL_TV_LAYOUT_NOTE_ID);
                item.setAttribute("title", "Needs a wider screen");
            }
        });

        // View: what the parent page last sent; page sizes only for Tiles.
        layoutMenuEl.querySelectorAll(".sl-tv-view-item").forEach(item => {
            item.setAttribute("aria-checked", item.dataset.view === tilesView.layout ? "true" : "false");
        });

        if (pageSizeSectionEl) {
            pageSizeSectionEl.hidden = !isTilesMode();
            pageSizeSectionEl.querySelectorAll(".sl-tv-pagesize").forEach(option => {
                option.setAttribute("aria-pressed", Number(option.dataset.pageSize) === tilesView.pageSize ? "true" : "false");
            });
        }

        const effective = root?.dataset.pos || preferredPosition;
        const note = layoutMenuEl.querySelector(".sl-tv-layout-note");

        note.textContent = [
            effective !== preferredPosition ? "Shown at the bottom on this screen size." : "",
            unavailable.length
                ? unavailable.join(" and ") + (unavailable.length > 1 ? " need" : " needs") + " a wider screen."
                : ""
        ].filter(Boolean).join(" ");

        autoHideSwitchEl?.setAttribute("aria-checked", autoHideEnabled ? "true" : "false");
    }

    // Bottom filmstrip: the menu opens upward, where Jitsi's toolbar floats
    // (it is drawn above our whole view, and on narrow screens spans the
    // width). If they overlap, the menu is lifted just above the toolbar and
    // its hide/show control. Otherwise CSS alone places the menu. Then the
    // menu's height is fitted to the view (fitLayoutMenu).
    function liftLayoutMenu() {
        if (!layoutMenuEl) {
            return;
        }

        layoutMenuEl.style.bottom = "";
        layoutMenuEl.style.maxHeight = "";

        raiseLayoutMenu();
        fitLayoutMenu();
    }

    function raiseLayoutMenu() {
        if (!isLayoutMenuOpen() || root?.dataset.pos !== "bottom" || isTilesMode()) {
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
        // A menu taller than the room above it (short screens) is still
        // lifted clear of the toolbar when enough room is left there for
        // fitLayoutMenu to make it a usable scrolling menu; otherwise it is
        // lifted only as far as the view's top allows, as before.
        const viewTop = root.getBoundingClientRect().top;
        const roomAbove = clearTop - viewTop - SL_TV_MENU_EDGE;
        const lift = menu.top - 4 < menu.bottom - clearTop && roomAbove >= SL_TV_MENU_MIN_HEIGHT
            ? menu.bottom - clearTop
            : Math.min(menu.bottom - clearTop, Math.max(menu.top - 4, 0));
        const current = parseFloat(getComputedStyle(layoutMenuEl).bottom) || 0;

        layoutMenuEl.style.bottom = Math.round(current + lift) + "px";
    }

    // List view: a menu taller than the room between its anchor and the
    // view's far edge (landscape phones) is capped there and scrolls inside
    // (CSS overflow-y), so every option stays reachable. A menu that fits is
    // left as it is. The Tiles view's grid-bar menu has its own CSS cap.
    function fitLayoutMenu() {
        if (!isLayoutMenuOpen() || !root || isTilesMode()) {
            return;
        }

        const view = root.getBoundingClientRect();
        const menu = layoutMenuEl.getBoundingClientRect();
        const room = root.dataset.pos === "top"
            ? view.bottom - menu.top - SL_TV_MENU_EDGE
            : menu.bottom - view.top - SL_TV_MENU_EDGE;

        if (room > 0 && room < menu.height) {
            layoutMenuEl.style.maxHeight = Math.floor(room) + "px";
        }
    }

    function openLayoutMenu() {
        if (!layoutMenuEl) {
            return;
        }

        placeLayoutMenu();
        updateLayoutMenu();
        layoutMenuEl.hidden = false;
        activeLayoutButton()?.setAttribute("aria-expanded", "true");
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
        gridSettingsEl?.setAttribute("aria-expanded", "false");
    }

    function onLayoutOutsidePointerDown(event) {
        if (layoutMenuEl?.contains(event.target) || layoutButtonEl?.contains(event.target)
            || gridSettingsEl?.contains(event.target)) {
            return;
        }

        closeLayoutMenu();
    }

    function onLayoutKeyDown(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            closeLayoutMenu();
            activeLayoutButton()?.focus({ preventScroll: true });
        }
    }

    // The button that opens the settings menu in the current view: the
    // filmstrip footer button (List) or the grid bar button (Tiles).
    function activeLayoutButton() {
        return isTilesMode() ? gridSettingsEl : layoutButtonEl;
    }

    // The menu lives beside the button that opens it: the filmstrip footer
    // (List) or the grid bar (Tiles). Switching view with the menu open
    // moves it (still open) instead of hiding it with the filmstrip.
    function placeLayoutMenu() {
        if (!layoutMenuEl) {
            return;
        }

        const target = isTilesMode() ? gridSettingsWrapEl : footerEl;

        if (target && layoutMenuEl.parentNode !== target) {
            target.appendChild(layoutMenuEl);
            layoutMenuEl.style.bottom = "";
            layoutMenuEl.style.maxHeight = "";

            if (isLayoutMenuOpen()) {
                layoutButtonEl?.setAttribute("aria-expanded", isTilesMode() ? "false" : "true");
                gridSettingsEl?.setAttribute("aria-expanded", isTilesMode() ? "true" : "false");
                // Fitted again where it now opens.
                liftLayoutMenu();
            }
        }
    }

    // View and page size belong to the parent page: ask it; the menu shows
    // the result when the parent sends the view back. The menu stays open.
    function chooseTeacherView(layout) {
        if ((layout === "list" || layout === "tiles") && layout !== tilesView.layout) {
            slPostToParent({ type: "SL_TEACHER_TILES_SETTINGS", v: 1, layout });
        }
    }

    function chooseTilesPageSize(pageSize) {
        if (SL_TV_TILES_PAGE_SIZES.includes(pageSize) && pageSize !== tilesView.pageSize) {
            slPostToParent({ type: "SL_TEACHER_TILES_SETTINGS", v: 1, pageSize });
        }
    }

    // The teacher's choice: applied here at once, and reported to the parent
    // page, which remembers it for the next reload / join. While the screen
    // places the filmstrip itself, the choice wins over it (wherever it
    // fits); a position that does not fit cannot be chosen: the menu stays
    // open and its note says why.
    function chooseLayoutPosition(position) {
        if (!SL_TV_POSITIONS.includes(position)) {
            return;
        }

        const box = getLayoutBox();

        if (!isPositionAvailable(position, box)) {
            updateLayoutMenu();
            return;
        }

        if (isAutoBottom(box)) {
            positionChosenHere = true;
        }

        // The same position again still applies (it may now win over the
        // screen's own position).
        if (position === preferredPosition) {
            applyLayout();
        } else {
            setPreferredPosition(position);
        }

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
             "body." + SL_TV_ACTIVE_CLASS + " #largeVideo { visibility: hidden !important; }",
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
            "#" + SL_TV_ID + " .sl-tv-layout-menu { position: absolute; z-index: 4; box-sizing: border-box; width: 200px; max-width: calc(100vw - 24px); padding: 6px; border-radius: 12px; border: 1px solid rgba(148, 163, 184, 0.2); background: rgba(15, 23, 42, 0.94); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 12px 32px rgba(2, 6, 23, 0.55); font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; overflow-y: auto; overscroll-behavior: contain; }",
            "#" + SL_TV_ID + " .sl-tv-layout-menu[hidden] { display: none; }",
            "#" + SL_TV_ID + " .sl-tv-layout-title { padding: 4px 8px 6px; color: #94A3B8; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }",
            "#" + SL_TV_ID + " .sl-tv-layout-item { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; min-height: 34px; padding: 6px 8px; margin: 0; border: 0; border-radius: 8px; background: transparent; color: #CBD5E1; font: 500 13px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; text-align: left; cursor: pointer; }",
            "#" + SL_TV_ID + " .sl-tv-layout-item svg { flex: 0 0 auto; width: 18px; height: 18px; color: #64748B; }",
            "@media (hover: hover) and (pointer: fine) { #" + SL_TV_ID + " .sl-tv-layout-item:hover { background: rgba(148, 163, 184, 0.1); color: #F1F5F9; } }",
            "#" + SL_TV_ID + " .sl-tv-layout-item:focus-visible { outline: 2px solid #93C5FD; outline-offset: -2px; }",
            "#" + SL_TV_ID + " .sl-tv-layout-item[aria-checked=true] { background: rgba(59, 130, 246, 0.16); color: #F8FAFC; }",
            "#" + SL_TV_ID + " .sl-tv-layout-item[aria-checked=true] svg { color: #60A5FA; }",
            // A position that does not fit this screen (see updateLayoutMenu).
            "#" + SL_TV_ID + " .sl-tv-layout-item[aria-disabled=true] { opacity: 0.45; cursor: not-allowed; }",
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
            "#" + SL_TV_ID + " .sl-tv-tile.sl-on-stage .sl-tv-stage-chip { display: inline-flex; }",

            // ---- Phase D: camera states of rotating student tiles. ----
            // Off-screen tiles are not rendered (their elements and streams
            // stay as they are); the tile box keeps its own size.
            "#" + SL_TV_ID + " .sl-tv-tile { content-visibility: auto; }",
            // "Camera on" (waiting to be received) / "Camera off".
            "#" + SL_TV_ID + " .sl-tv-ph-status { font-size: 10px; font-weight: 500; line-height: 1.3; color: #64748B; }",
            "#" + SL_TV_ID + " .sl-tv-ph-status:empty { display: none; }",
            "#" + SL_TV_ID + " .sl-tv-placeholder[data-status=on] .sl-tv-ph-status { color: #5EEAD4; }",
            // Frozen: the last frame, with a small quiet pause marker.
            "#" + SL_TV_ID + " .sl-tv-frozen-chip { position: absolute; right: 6px; bottom: 6px; display: none; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 6px; background: rgba(15, 23, 42, 0.7); color: #94A3B8; }",
            "#" + SL_TV_ID + " .sl-tv-frozen-chip svg { width: 10px; height: 10px; }",
            "#" + SL_TV_ID + " .sl-tv-tile.sl-frozen .sl-tv-frozen-chip { display: flex; }",

            // ---- Tiles view: the page's students in a grid, and the
            // enlarged-video panel. List view's stage / filmstrip are hidden
            // (CSS only); the grid and panel are hidden in List view.
            "#" + SL_TV_ID + " .sl-tv-gridview, #" + SL_TV_ID + " .sl-tv-panel { display: none; }",
            "#" + SL_TV_ID + "." + SL_TV_TILES_MODE_CLASS + " .sl-tv-stage, #" + SL_TV_ID + "." + SL_TV_TILES_MODE_CLASS + " .sl-tv-filmstrip, #" + SL_TV_ID + "." + SL_TV_TILES_MODE_CLASS + " .sl-tv-resizer, #" + SL_TV_ID + "." + SL_TV_TILES_MODE_CLASS + " .sl-tv-restore { display: none !important; }",
            "#" + SL_TV_ID + ".sl-visible." + SL_TV_TILES_MODE_CLASS + " { flex-direction: row; }",
            "#" + SL_TV_ID + "." + SL_TV_TILES_MODE_CLASS + " .sl-tv-gridview { order: 0; flex: 1 1 auto; min-width: 0; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; background: #0B1220; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; box-sizing: border-box; padding: 8px 10px; border-bottom: 1px solid rgba(148, 163, 184, 0.14); color: #E2E8F0; font: 500 12px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar-nav { display: flex; flex: 0 0 auto; gap: 6px; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar-nav > button { padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(148, 163, 184, 0.35); background: rgba(30, 41, 59, 0.9); color: #F8FAFC; font: 500 12px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; cursor: pointer; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar-nav > button:disabled { opacity: 0.45; cursor: not-allowed; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar-nav > button:focus-visible, #" + SL_TV_ID + " .sl-tv-gridbar-settings-btn:focus-visible { outline: 2px solid #93C5FD; outline-offset: 1px; }",
            // Grid bar settings button + the settings menu dropping below it.
            "#" + SL_TV_ID + " .sl-tv-gridbar { position: relative; z-index: 5; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar-settings { position: relative; flex: 0 0 auto; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar-settings-btn { padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(148, 163, 184, 0.35); background: rgba(30, 41, 59, 0.9); color: #F8FAFC; font: 500 12px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; cursor: pointer; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar .sl-tv-gridbar-settings-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar-settings-btn svg { width: 14px; height: 14px; }",
            "#" + SL_TV_ID + " .sl-tv-gridbar .sl-tv-gridbar-settings-btn[aria-expanded=true] { color: #BFDBFE; border-color: rgba(96, 165, 250, 0.6); background: rgba(30, 58, 138, 0.45); }",
            "#" + SL_TV_ID + " .sl-tv-gridbar-settings .sl-tv-layout-menu { top: calc(100% + 6px); bottom: auto; right: 0; left: auto; max-height: calc(100vh - 140px); overflow-y: auto; }",
            "@media (max-width: 480px) { #" + SL_TV_ID + " .sl-tv-gridbar-settings-label { display: none; } #" + SL_TV_ID + " .sl-tv-gridbar .sl-tv-gridbar-settings-btn { padding: 4px 8px; } }",

            // Settings menu: View (two items side by side) and Tiles per page.
            "#" + SL_TV_ID + " .sl-tv-view-row { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }",
            "#" + SL_TV_ID + " .sl-tv-view-row .sl-tv-layout-item { gap: 8px; }",
            "#" + SL_TV_ID + " .sl-tv-pagesize-section { padding: 6px 4px 2px; }",
            "#" + SL_TV_ID + " .sl-tv-pagesize-section[hidden] { display: none; }",
            "#" + SL_TV_ID + " .sl-tv-pagesize-title { padding: 0 4px 6px; color: #94A3B8; font: 600 11px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }",
            "#" + SL_TV_ID + " .sl-tv-pagesize-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }",
            "#" + SL_TV_ID + " .sl-tv-pagesize { min-width: 0; height: 28px; padding: 0; border-radius: 8px; border: 1px solid rgba(148, 163, 184, 0.2); background: transparent; color: #CBD5E1; font: 600 12px/1 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; cursor: pointer; }",
            "@media (hover: hover) and (pointer: fine) { #" + SL_TV_ID + " .sl-tv-pagesize:hover { background: rgba(148, 163, 184, 0.1); color: #F1F5F9; } }",
            "#" + SL_TV_ID + " .sl-tv-pagesize:focus-visible { outline: 2px solid #93C5FD; outline-offset: -2px; }",
            "#" + SL_TV_ID + " .sl-tv-pagesize[aria-pressed=true] { border-color: rgba(96, 165, 250, 0.6); background: rgba(59, 130, 246, 0.22); color: #F8FAFC; }",
            "@media (pointer: coarse) { #" + SL_TV_ID + " .sl-tv-pagesize { height: 34px; } }",
            // Columns and the tile width are set by the view
            // (SL_TV_VAR_GRID_COLS, SL_TV_VAR_TILE_W) to fit the page: each
            // tile is capped at that width and centred in its column, so the
            // rows fit the grid's height. "safe center": should content still
            // overflow, it is never cut off at the top (unsupported browsers
            // keep the plain "center" before it).
            "#" + SL_TV_ID + " .sl-tv-grid { flex: 1 1 auto; min-height: 0; box-sizing: border-box; display: grid; grid-template-columns: repeat(var(" + SL_TV_VAR_GRID_COLS + ", 5), minmax(0, 1fr)); align-content: center; align-content: safe center; gap: 8px; padding: 8px 8px var(" + SL_TV_VAR_GRID_PAD_B + ", 96px); overflow-y: auto; overscroll-behavior: contain; }",
            "#" + SL_TV_ID + " .sl-tv-grid .sl-tv-tile { width: 100%; max-width: var(" + SL_TV_VAR_TILE_W + ", none); justify-self: center; }",
            // Small tiles (phones, see SL_TV_COMPACT_TILE_W): a smaller icon and
            // the name only, so neither is cut off.
            "#" + SL_TV_ID + " ." + SL_TV_GRID_COMPACT_CLASS + " .sl-tv-placeholder { gap: 3px; padding: 4px; }",
            "#" + SL_TV_ID + " ." + SL_TV_GRID_COMPACT_CLASS + " .sl-tv-icon { width: 26px; height: 26px; }",
            "#" + SL_TV_ID + " ." + SL_TV_GRID_COMPACT_CLASS + " .sl-tv-ph-name { font-size: 10px; }",
            "#" + SL_TV_ID + " ." + SL_TV_GRID_COMPACT_CLASS + " .sl-tv-ph-role, #" + SL_TV_ID + " ." + SL_TV_GRID_COMPACT_CLASS + " .sl-tv-ph-status { display: none; }",
            "#" + SL_TV_ID + " ." + SL_TV_GRID_COMPACT_CLASS + " .sl-tv-name { left: 4px; bottom: 4px; max-width: calc(100% - 8px); padding: 1px 4px; font-size: 10px; }",
            "#" + SL_TV_ID + " .sl-tv-grid-empty { grid-column: 1 / -1; padding: 24px; color: #94A3B8; text-align: center; font: 500 14px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }",
            // Enlarged-video panel (right side; full width on a narrow screen).
            "#" + SL_TV_ID + "." + SL_TV_TILES_MODE_CLASS + ".sl-tv-panel-open .sl-tv-panel { order: 1; flex: 0 0 min(46%, 640px); min-width: 0; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; background: #000000; border-left: 1px solid rgba(148, 163, 184, 0.2); }",
            "#" + SL_TV_ID + " .sl-tv-panel-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #0B1220; color: #F8FAFC; font: 600 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }",
            "#" + SL_TV_ID + " .sl-tv-panel-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
            "#" + SL_TV_ID + " .sl-tv-panel-state { flex: 0 0 auto; color: #94A3B8; font-weight: 500; font-size: 12px; }",
            "#" + SL_TV_ID + " .sl-tv-panel-close { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; border: 1px solid rgba(148, 163, 184, 0.35); background: rgba(30, 41, 59, 0.9); color: #F8FAFC; cursor: pointer; }",
            "#" + SL_TV_ID + " .sl-tv-panel-close svg { width: 16px; height: 16px; }",
            "#" + SL_TV_ID + " .sl-tv-panel-close:focus-visible { outline: 2px solid #93C5FD; outline-offset: 1px; }",
            "#" + SL_TV_ID + " .sl-tv-panel-body { position: relative; flex: 1 1 auto; min-height: 0; }",
            "#" + SL_TV_ID + " .sl-tv-panel-body video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000000; }",
            "#" + SL_TV_ID + " .sl-tv-panel-body.sl-no-video video { visibility: hidden; }",
            "#" + SL_TV_ID + " .sl-tv-panel-body.sl-no-video .sl-tv-placeholder { display: flex; gap: 12px; padding: 24px; }",
            "@media (max-width: 640px) { #" + SL_TV_ID + ".sl-visible." + SL_TV_TILES_MODE_CLASS + ".sl-tv-panel-open { flex-direction: column; } #" + SL_TV_ID + "." + SL_TV_TILES_MODE_CLASS + ".sl-tv-panel-open .sl-tv-panel { flex: 0 0 45%; width: 100%; border-left: 0; border-top: 1px solid rgba(148, 163, 184, 0.2); } #" + SL_TV_ID + "." + SL_TV_TILES_MODE_CLASS + ".sl-tv-panel-open .sl-tv-panel-body { margin-bottom: " + SL_TV_GRID_RESERVE_SHORT + "px; } }"
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

        // Tiles view (hidden in List view by CSS).
        createTilesView();
        root.appendChild(gridViewEl);
        root.appendChild(panelEl);

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

    // ---- Tiles view: DOM ------------------------------------------------------

    function createTilesView() {
        gridViewEl = document.createElement("div");
        gridViewEl.className = "sl-tv-gridview";

        const bar = document.createElement("div");
        bar.className = "sl-tv-gridbar";

        gridLabelEl = document.createElement("div");
        gridLabelEl.className = "sl-tv-gridbar-label";
        gridLabelEl.setAttribute("aria-live", "polite");

        const nav = document.createElement("div");
        nav.className = "sl-tv-gridbar-nav";

        gridPrevEl = document.createElement("button");
        gridPrevEl.type = "button";
        gridPrevEl.textContent = "Previous";
        gridPrevEl.setAttribute("aria-label", "Previous page of students");
        gridPrevEl.addEventListener("click", () => requestTilesPage("previous"));

        gridNextEl = document.createElement("button");
        gridNextEl.type = "button";
        gridNextEl.textContent = "Next";
        gridNextEl.setAttribute("aria-label", "Next page of students");
        gridNextEl.addEventListener("click", () => requestTilesPage("next"));

        nav.appendChild(gridPrevEl);
        nav.appendChild(gridNextEl);

        // The same View / filmstrip settings menu as the filmstrip's button
        // (that button is hidden with the filmstrip in the Tiles view).
        gridSettingsWrapEl = document.createElement("div");
        gridSettingsWrapEl.className = "sl-tv-gridbar-settings";

        gridSettingsEl = document.createElement("button");
        gridSettingsEl.type = "button";
        gridSettingsEl.className = "sl-tv-gridbar-settings-btn";
        gridSettingsEl.title = "View and filmstrip settings";
        gridSettingsEl.setAttribute("aria-label", "View and filmstrip settings");
        gridSettingsEl.setAttribute("aria-haspopup", "menu");
        gridSettingsEl.setAttribute("aria-expanded", "false");
        gridSettingsEl.innerHTML = SL_TV_VIEW_ICONS.tiles + '<span class="sl-tv-gridbar-settings-label">View</span>';
        gridSettingsEl.addEventListener("click", () => {
            if (isLayoutMenuOpen()) {
                closeLayoutMenu();
            } else {
                openLayoutMenu();
            }
        });
        gridSettingsWrapEl.appendChild(gridSettingsEl);
        nav.appendChild(gridSettingsWrapEl);

        bar.appendChild(gridLabelEl);
        bar.appendChild(nav);

        gridEl = document.createElement("div");
        gridEl.className = "sl-tv-grid";
        gridEl.setAttribute("aria-label", "Students");

        gridEmptyEl = document.createElement("div");
        gridEmptyEl.className = "sl-tv-grid-empty";
        gridEmptyEl.textContent = "No students on this page.";

        gridViewEl.appendChild(bar);
        gridViewEl.appendChild(gridEl);

        panelEl = document.createElement("div");
        panelEl.className = "sl-tv-panel";
        panelEl.setAttribute("role", "region");
        panelEl.setAttribute("aria-label", "Enlarged student video");

        const head = document.createElement("div");
        head.className = "sl-tv-panel-head";

        panelNameEl = document.createElement("div");
        panelNameEl.className = "sl-tv-panel-name";

        panelStateEl = document.createElement("div");
        panelStateEl.className = "sl-tv-panel-state";

        const close = document.createElement("button");
        close.type = "button";
        close.className = "sl-tv-panel-close";
        close.setAttribute("aria-label", "Close enlarged video");
        close.title = "Close";
        close.innerHTML = SL_TV_CLOSE_ICON;
        close.addEventListener("click", closeEnlarged);

        head.appendChild(panelNameEl);
        head.appendChild(panelStateEl);
        head.appendChild(close);

        panelBodyEl = document.createElement("div");
        panelBodyEl.className = "sl-tv-panel-body";
        panelVideo = createVideo();
        panelPlaceholder = createPlaceholder();
        panelVideo.addEventListener("loadeddata", onTileFrame);
        panelBodyEl.appendChild(panelVideo);
        panelBodyEl.appendChild(panelPlaceholder.el);

        panelEl.appendChild(head);
        panelEl.appendChild(panelBodyEl);

        // The grid's size changes (window, panel, chat): new columns, and
        // the nearby groups follow what is on screen.
        if (typeof ResizeObserver === "function") {
            gridObserver = gridObserver || new ResizeObserver(() => {
                if (isTilesMode()) {
                    layoutTilesGrid();
                }
            });
            gridObserver.disconnect();
            gridObserver.observe(gridEl);
        }
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

        // Phase D: "Camera on" (waiting to be received) / "Camera off".
        const statusEl = document.createElement("div");
        statusEl.className = "sl-tv-ph-status";

        el.appendChild(iconEl);
        el.appendChild(nameEl);
        el.appendChild(roleEl);
        el.appendChild(statusEl);

        return { el, iconEl, nameEl, roleEl, statusEl };
    }

    // variant: "teacher" | "student" | "screen"; status: Phase D camera
    // state text for a student tile ("" = none).
    function setPlaceholder(placeholder, name, variant, status) {
        if (placeholder.el.dataset.variant !== variant) {
            placeholder.el.dataset.variant = variant;
            placeholder.iconEl.innerHTML = SL_ICONS[variant] || SL_ICONS.student;
        }

        placeholder.nameEl.textContent = name;
        placeholder.roleEl.textContent = variant === "teacher" ? "(Teacher)" : "";
        placeholder.statusEl.textContent = status || "";
        placeholder.el.dataset.status = status === "Camera on" || status === SL_TV_TILE_PLACEHOLDER_STATUS.connecting
            ? "on"
            : status ? "off" : "";
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

        // Tiles view: a tile click selects the student and enlarges them
        // (the panel's close button deselects).
        if (isTilesMode()) {
            openEnlarged(tileId);
            return;
        }

        const localId = state["features/base/participants"]?.local?.id ?? null;
        const selectedId = manualSelection === "self" ? localId : manualSelection;

        manualSelection = tileId === localId || tileId === selectedId ? "self" : tileId;

        // The newly selected student is a planned (priority) camera BEFORE
        // the pin: Jitsi recomputes its constraints on it, and an unplanned
        // student camera on the stage is not received.
        slTeacherRotation.setPriority(getPriorityStudents(state));

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

        // Phase D: a frozen tile (last frame kept while the camera is not
        // received right now) gets a small, quiet marker.
        const frozenEl = document.createElement("div");
        frozenEl.className = "sl-tv-frozen-chip";
        frozenEl.title = "Live view resumes shortly";
        frozenEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="6" width="3.5" height="12" rx="1"/><rect x="13.5" y="6" width="3.5" height="12" rx="1"/></svg>';
        el.appendChild(frozenEl);

        el.addEventListener("click", () => pinTile(tileId));
        el.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                pinTile(tileId);
            }
        });

        // A first frame changes a "connecting" tile's state outside a store
        // update (builds without streaming status): redraw.
        video.addEventListener("loadeddata", onTileFrame);

        // frozen: paused on its last frame (never played, never detached while
        // the camera stays ON). statusTrack: the track whose streaming status
        // this tile follows (Phase D), or null.
        const tile = {
            el, video, nameEl, placeholder, frozenEl, jitsiTrack: null, frozen: false, mode: "", statusTrack: null
        };

        tiles.set(tileId, tile);

        return tile;
    }

    function removeTile(tileId) {
        const tile = tiles.get(tileId);

        if (!tile) {
            return;
        }

        watchTileStatus(tile, null);
        tile.video.removeEventListener("loadeddata", onTileFrame);
        detachFrom(tile.jitsiTrack, tile.video);
        tile.jitsiTrack = null;
        tile.frozen = false;
        tile.el.remove();
        tiles.delete(tileId);
    }

    // ---- Phase D: rotating student camera tiles -----------------------------

    // A remote student's camera tile is governed by the rotation (the
    // teacher's own, co-teachers' and screen-share tiles are not).
    function isRotatingCameraTile(item) {
        return item.kind === "camera" && !item.local && item.role === "student"
            && slTeacherRotation.isActive();
    }

    // Priority cameras: the teacher's selected student, and the student on
    // Jitsi's stage (the same one, unless a share has the stage).
    function getPriorityStudents(state) {
        const participants = state?.["features/base/participants"];
        const remote = participants?.remote;
        const isStudent = id => {
            const participant = id ? remote?.get?.(id) : null;

            return Boolean(participant && !participant.fakeParticipant && participant.role !== "moderator");
        };
        const ids = [];

        if (manualSelection && manualSelection !== "self" && isStudent(manualSelection)) {
            ids.push(manualSelection);
        }

        const staged = state?.["features/large-video"]?.participantId;

        if (isStudent(staged) && !ids.includes(staged)) {
            ids.push(staged);
        }

        return ids;
    }

    function hasFrame(video) {
        return Boolean(video && video.videoWidth > 0 && video.readyState >= 2);
    }

    // Keeps the tile's last frame: paused in place, nothing detached. A paused
    // element shows the frame it has, whatever its stream carries next (with
    // SSRC rewriting a pooled stream can be re-mapped to another student).
    function freezeTile(tile) {
        if (!tile.frozen) {
            tile.video.pause();
            tile.frozen = true;
        }
    }

    // The scheduler is about to stop receiving these cameras: freeze their
    // tiles FIRST (before the receiver constraints change). A tile that has
    // no frame yet simply lets go of its stream (it shows "Camera on").
    function freezeTiles(participantIds) {
        participantIds.forEach(participantId => {
            const tile = tiles.get(participantId);

            if (!tile || !tile.jitsiTrack) {
                return;
            }

            if (hasFrame(tile.video)) {
                freezeTile(tile);
            } else {
                detachFrom(tile.jitsiTrack, tile.video);
                tile.jitsiTrack = null;
            }
        });

        // The tiles' state changed outside a store update: redraw soon.
        lastSignature = "";
        Promise.resolve().then(render);
    }

    function onTileStatusChanged() {
        lastSignature = "";
        render();
    }

    function onTileFrame() {
        lastSignature = "";
        Promise.resolve().then(render);
    }

    // Follows one track's streaming status for a tile (null: none). Never
    // more than one listener per tile; removed with the tile. The enlarged
    // panel uses it too, with its own handler (a tile and the panel can
    // follow the same track).
    function watchTileStatus(tile, jitsiTrack, handler = onTileStatusChanged) {
        if (tile.statusTrack === jitsiTrack) {
            return;
        }

        if (tile.statusTrack) {
            try {
                if (typeof tile.statusTrack.off === "function") {
                    tile.statusTrack.off(SL_STREAMING_STATUS_EVENT, tile.statusHandler || handler);
                }
            } catch (error) {
                /* track already disposed */
            }
        }

        tile.statusTrack = null;
        tile.statusHandler = null;

        if (jitsiTrack) {
            try {
                if (typeof jitsiTrack.on === "function") {
                    jitsiTrack.on(SL_STREAMING_STATUS_EVENT, handler);
                    tile.statusTrack = jitsiTrack;
                    tile.statusHandler = handler;
                }
            } catch (error) {
                /* status stays unknown */
            }
        }
    }

    // ---- Tiles view ------------------------------------------------------------

    function isTilesMode() {
        return tilesView.layout === "tiles";
    }

    // Page navigation belongs to the parent page (it owns the roster and the
    // paging); it answers with a new SL_TEACHER_TILES.
    function requestTilesPage(action) {
        slPostToParent({ type: "SL_TEACHER_TILES_NAV", v: 1, action });
    }

    // The page's tiles, in the parent page's (roster) order. A student on the
    // page who is not in the meeting (left / reconnecting) keeps a tile.
    function collectPageTiles(state) {
        const participants = state?.["features/base/participants"];
        const remote = participants?.remote;
        const stageId = state?.["features/large-video"]?.participantId ?? null;

        return tilesView.participantIds.map(id => {
            const participant = remote?.get?.(id);
            const present = Boolean(participant && !participant.fakeParticipant);

            if (present && participant.name) {
                knownNames.set(id, participant.name);
            }

            const track = present ? findCameraTrack(state, id, false) : null;

            return {
                id,
                name: (present && participant.name) || knownNames.get(id) || "Student",
                kind: "camera",
                role: present ? roleOf(participant) : "student",
                local: false,
                absent: !present,
                cameraOn: present && isCameraSourceOn(participant),
                track,
                muted: track ? Boolean(track.muted) : true,
                pinned: manualSelection === id,
                onStage: stageId === id
            };
        });
    }

    // The columns that give the largest 16:9 tiles for this page in the
    // grid's content box, and that tile width (px, whole pixels): limited by
    // the column width or, when rows run out of height first, by the row
    // height. So cols * width and rows * height (with the gaps) always fit.
    function bestGridLayout(count, width, height) {
        let best = { cols: 1, tileWidth: 0 };

        for (let cols = 1; cols <= Math.max(1, count); cols++) {
            const rows = Math.ceil(count / cols);
            const tileWidth = Math.min(
                (width - SL_TV_GRID_GAP * (cols - 1)) / cols,
                ((height - SL_TV_GRID_GAP * (rows - 1)) / rows) * 16 / 9
            );

            if (tileWidth > best.tileWidth) {
                best = { cols, tileWidth };
            }
        }

        if (best.tileWidth >= SL_TV_MIN_TILE_W) {
            return { cols: best.cols, tileWidth: Math.max(1, Math.floor(best.tileWidth)) };
        }

        // Too small to use (phones): as many columns of at least the minimum
        // width as fit, each tile the full column; the rows that do not fit
        // scroll (the grid's overflow-y).
        const cols = Math.max(1, Math.min(Math.max(1, count),
            Math.floor((width + SL_TV_GRID_GAP) / (SL_TV_MIN_TILE_W + SL_TV_GRID_GAP))));

        return { cols, tileWidth: Math.max(1, Math.floor((width - SL_TV_GRID_GAP * (cols - 1)) / cols)) };
    }

    // Space under the grid kept free for Jitsi's toolbar, which floats over
    // the bottom of the view: less on a short screen, and none to speak of
    // while the enlarged panel is stacked under the grid (the toolbar is over
    // the panel then).
    function gridBottomReserve() {
        const box = getLayoutBox();

        if (root?.classList.contains("sl-tv-panel-open") && box.width > 0 && box.width <= SL_TV_PANEL_STACK_WIDTH) {
            return SL_TV_GRID_RESERVE_STACKED;
        }

        return box.height > 0 && box.height <= SL_TV_SHORT_HEIGHT
            ? SL_TV_GRID_RESERVE_SHORT
            : SL_TV_GRID_RESERVE;
    }

    function setGridStyle(name, value) {
        const current = gridEl.style.getPropertyValue
            ? gridEl.style.getPropertyValue(name)
            : gridEl.style[name];

        if (current !== value) {
            gridEl.style.setProperty(name, value);
        }
    }

    // Sets the grid's columns AND the tile width they were chosen for (the
    // CSS caps each tile at it, centred in its column): a height-limited
    // layout (e.g. one student on a wide screen) then fits the grid instead
    // of a column-wide 16:9 tile overflowing it. Then measures where the
    // tiles actually are and gives the scheduler their reading order (nearby
    // groups follow the screen, whatever the column count). A changed order
    // re-renders once.
    function layoutTilesGrid() {
        if (!gridEl) {
            return;
        }

        const tileEls = Array.from(gridEl.children).filter(el => el.dataset && el.dataset.tileId);
        const reserve = gridBottomReserve();

        // The same value is the grid's CSS padding-bottom.
        setGridStyle(SL_TV_VAR_GRID_PAD_B, reserve + "px");

        const width = Math.max(0, gridEl.clientWidth - 2 * SL_TV_GRID_GAP);
        const height = Math.max(0, gridEl.clientHeight - SL_TV_GRID_GAP - reserve);

        if (tileEls.length && width > 0 && height > 0) {
            const layout = bestGridLayout(tileEls.length, width, height);

            setGridStyle(SL_TV_VAR_GRID_COLS, String(layout.cols));
            setGridStyle(SL_TV_VAR_TILE_W, layout.tileWidth + "px");
            gridEl.classList.toggle(SL_TV_GRID_COMPACT_CLASS, layout.tileWidth < SL_TV_COMPACT_TILE_W);
        }

        const measured = slSpatialOrder(tileEls.map(el => {
            const rect = el.getBoundingClientRect();

            return { id: el.dataset.tileId, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }));
        // Order and rows / columns: a new column count re-plans the groups
        // even when the reading order happens to stay the same.
        const key = measured.order
            .map(id => {
                const position = measured.positions[id];

                return id + "@" + (position ? position.row + ":" + Math.round(position.x * 10) : "");
            })
            .join(",");

        gridColumns = measured.columns;

        if (key !== gridOrderKey) {
            gridOrderKey = key;
            gridOrder = measured.order;
            gridPositions = measured.positions;
            lastSignature = "";
            Promise.resolve().then(render);
        }
    }

    // Whether the measured grid covers this page (else: not measured yet).
    function gridCoversPage() {
        const ids = tilesView.participantIds;

        return Boolean(gridOrder && ids.length && ids.every(id => gridOrder.includes(id)));
    }

    // The measured order when it covers this page, else the page order.
    function getTilesOrder() {
        const ids = tilesView.participantIds;

        return gridCoversPage() ? gridOrder.filter(id => ids.includes(id)) : ids.slice();
    }

    function renderGridBar() {
        const { page, pageCount, rangeStart, rangeEnd, total } = tilesView;

        gridLabelEl.textContent = total > 0
            ? "Page " + page + " of " + pageCount + " · Students " + rangeStart + "–" + rangeEnd + " of " + total
            : "No students in the meeting yet";
        gridPrevEl.disabled = !(page > 1);
        gridNextEl.disabled = !(page < pageCount);
    }

    // Opens the enlarged panel for a tile and selects that student (Phase C
    // pin: Jitsi then asks for their camera at stage quality; the scheduler
    // makes them a priority camera).
    function openEnlarged(tileId) {
        const state = getState();

        if (!state || !isLocalModerator(state) || !teacherView.enabled) {
            return;
        }

        const participant = state["features/base/participants"]?.remote?.get?.(tileId);
        const present = Boolean(participant && !participant.fakeParticipant);

        enlarged = { id: tileId, name: (present && participant.name) || knownNames.get(tileId) || "Student" };

        if (present) {
            manualSelection = tileId;
        }

        // A planned (priority) camera before the pin, as in pinTile. (Sent
        // with the enlarged height by setEnlarged's re-apply just below.)
        slTeacherRotation.setPriority(getPriorityStudents(state));

        // Before the pin: Jitsi recomputes its constraints on it, and its own
        // stage height must never reach the bridge for the enlarged camera.
        slTeacherRotation.setEnlarged(present ? tileId : null);
        applyStagePolicy(state);
        lastSignature = "";
        render();
    }

    // Closes the panel: only our own element lets go of the track; the
    // student stays connected and goes back into their group's rotation.
    function closeEnlarged() {
        if (!enlarged) {
            return;
        }

        if (manualSelection === enlarged.id) {
            manualSelection = null;
        }

        enlarged = null;

        const state = getState();

        // The pin moves away first (Jitsi's stage height then no longer
        // applies to this camera), THEN the 360 request ends: the camera goes
        // from 360 straight to its tile height (or 0).
        if (state) {
            applyStagePolicy(state);
        }

        slTeacherRotation.setEnlarged(null);

        lastSignature = "";
        render();
    }

    // Tiles view: the panel follows the selection made in List view too.
    function syncEnlarged(state) {
        if (!isTilesMode()) {
            enlarged = null;
            return;
        }

        if (!enlarged && manualSelection && manualSelection !== "self") {
            const participant = state?.["features/base/participants"]?.remote?.get?.(manualSelection);

            if (participant && !participant.fakeParticipant) {
                enlarged = { id: manualSelection, name: participant.name || "Participant" };
            }
        }
    }

    // What the panel shows for the enlarged student, looked up by
    // participant every time (never a stale stream).
    function resolvePanel(state) {
        if (!enlarged || !isTilesMode()) {
            return null;
        }

        const participant = state?.["features/base/participants"]?.remote?.get?.(enlarged.id);

        if (!participant || participant.fakeParticipant) {
            return { id: enlarged.id, name: enlarged.name, role: "student", state: "disconnected", track: null, status: null };
        }

        enlarged.name = participant.name || enlarged.name;

        const base = { id: enlarged.id, name: enlarged.name, role: roleOf(participant) };

        if (!isCameraSourceOn(participant)) {
            return { ...base, state: "off", track: null, status: null };
        }

        const track = findCameraTrack(state, enlarged.id, false);
        const jitsiTrack = track && !track.muted ? track.jitsiTrack : null;

        if (!jitsiTrack) {
            return { ...base, state: "connecting", track: null, status: null };
        }

        const status = getStreamingStatus(jitsiTrack);
        const planned = base.role !== "student" || slTeacherRotation.isPlannedLive(enlarged.id);

        return {
            ...base,
            track: jitsiTrack,
            status,
            state: !planned ? "frozen" : status === null ? "unknown" : status === "active" ? "live" : "stalled"
        };
    }

    function onPanelStatusChanged() {
        lastSignature = "";
        render();
    }

    // The panel's own <video> shows the student's existing track (attached
    // to one more element; never a new connection).
    function setPanelTrack(jitsiTrack) {
        if (panelTrack !== jitsiTrack) {
            if (panelTrack) {
                detachFrom(panelTrack, panelVideo);
            }

            panelTrack = null;

            if (jitsiTrack && panelVideo && attachTo(jitsiTrack, panelVideo)) {
                panelTrack = jitsiTrack;
            }
        }

        watchTileStatus(panelWatch, panelTrack, onPanelStatusChanged);
    }

    function renderPanel(panel) {
        root.classList.toggle("sl-tv-panel-open", Boolean(panel));

        if (!panel) {
            setPanelTrack(null);
            panelEl.dataset.state = "";
            return;
        }

        panelNameEl.textContent = panel.name;
        panelNameEl.title = panel.name;
        setPanelTrack(panel.track);

        let mode = panel.state;

        // No streaming status in this build: live once a frame is here.
        if (mode === "unknown") {
            mode = hasFrame(panelVideo) ? "live" : "connecting";
        }

        // Not arriving / rotated out: hold this student's own frame.
        if (mode === "stalled" || mode === "frozen") {
            panelVideo.pause();

            if (!hasFrame(panelVideo)) {
                mode = "connecting";
            }
        }

        const messages = {
            live: "Live",
            stalled: SL_STATUS_MESSAGES[panel.status] || "Waiting for live video…",
            frozen: "Paused",
            connecting: "Connecting…",
            off: "Camera off",
            disconnected: "Disconnected"
        };

        panelBodyEl.classList.toggle("sl-no-video", mode === "connecting" || mode === "off" || mode === "disconnected");
        setPlaceholder(panelPlaceholder, panel.name, panel.role || "student", SL_TV_TILE_PLACEHOLDER_STATUS[mode] || "");
        panelStateEl.textContent = messages[mode] || "";
        panelEl.dataset.state = mode;

        if (panelTrack && (mode === "live" || (panel.state === "unknown" && mode === "connecting"))) {
            playVideo(panelVideo);
        }
    }

    // A remote student's camera tile while Phase D runs. Returns its mode:
    //   "live"       Jitsi reports the camera as actually arriving ("active")
    //   "stalled"    planned, but not arriving (not forwarded yet / any more,
    //                or interrupted): its last frame held, never played
    //   "connecting" planned, not arriving, no frame yet
    //   "frozen"     not planned (rotated out): its last frame held
    //   "waiting"    camera on, not planned, no frame
    //   "off"        camera off
    // Being planned by the scheduler never makes a tile "live" on its own.
    function updateRotatingTile(tile, item) {
        tile.playForFrame = false;

        if (!item.cameraOn) {
            watchTileStatus(tile, null);
            detachFrom(tile.jitsiTrack, tile.video);
            tile.jitsiTrack = null;
            tile.frozen = false;

            return "off";
        }

        // The track this participant owns NOW (looked up again every time;
        // a pooled stream may have been re-mapped since).
        const track = item.track && !item.muted ? item.track.jitsiTrack : null;

        if (track && slTeacherRotation.isPlannedLive(item.id)) {
            if (tile.jitsiTrack !== track) {
                detachFrom(tile.jitsiTrack, tile.video);
                tile.jitsiTrack = null;

                if (attachTo(track, tile.video)) {
                    tile.jitsiTrack = track;
                }
            }

            tile.frozen = false;
            watchTileStatus(tile, tile.jitsiTrack);

            if (!tile.jitsiTrack) {
                return "waiting";
            }

            const status = getStreamingStatus(tile.jitsiTrack);

            // No streaming status in this build: live once a frame is here
            // (until then the stream must play to deliver one).
            if (status === null) {
                tile.playForFrame = !hasFrame(tile.video);

                return tile.playForFrame ? "connecting" : "live";
            }

            if (status === "active") {
                return "live";
            }

            // Not arriving: hold whatever frame the tile has, so it never
            // plays what the stream carries next.
            tile.video.pause();

            return hasFrame(tile.video) ? "stalled" : "connecting";
        }

        watchTileStatus(tile, null);

        // Camera ON but not received now (or not owned any more): never let
        // this tile play what its old stream carries next.
        if (tile.frozen) {
            return "frozen";
        }

        if (tile.jitsiTrack && hasFrame(tile.video)) {
            freezeTile(tile);

            return "frozen";
        }

        if (tile.jitsiTrack) {
            detachFrom(tile.jitsiTrack, tile.video);
            tile.jitsiTrack = null;
        }

        return "waiting";
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

        // Jitsi's own large video and filmstrip videos play again (only those
        // this view paused).
        releaseLargeVideo();
        releaseFilmstripVideos();

        document.body?.classList.toggle(SL_TV_ACTIVE_CLASS, false);

        // Phase D stops with the view (Exam Mode, disabled): the receive
        // policy goes back to Exam's / Jitsi's own at once (nobody enlarged).
        slTeacherRotation.setActive(false);
        slTeacherRotation.setEnlarged(null);

        if (!root) {
            return;
        }

        Array.from(tiles.keys()).forEach(removeTile);
        setStageTrack(null);

        // Tiles view: the panel lets go of its track; the page and layout
        // (from the parent page) stay, the measured grid order does not.
        setPanelTrack(null);
        enlarged = null;
        gridOrder = null;
        gridPositions = null;
        gridOrderKey = "";
        gridColumns = 0;

        if (gridObserver) {
            gridObserver.disconnect();
        }

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
        viewSectionEl = null;
        pageSizeSectionEl = null;
        restoreEl = null;
        gridViewEl = null;
        gridLabelEl = null;
        gridPrevEl = null;
        gridNextEl = null;
        gridEl = null;
        gridEmptyEl = null;
        gridSettingsWrapEl = null;
        gridSettingsEl = null;
        panelEl = null;
        panelBodyEl = null;
        panelVideo = null;
        panelNameEl = null;
        panelStateEl = null;
        panelPlaceholder = null;
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

        // The view shows (Normal or Tiles): Jitsi's covered large video is
        // paused. On every render, before the unchanged-view early return
        // below, so a restarted or replaced element is caught. The same for
        // Jitsi's hidden filmstrip videos.
        suppressLargeVideo();
        suppressFilmstripVideos();

        // Phase C: steer Jitsi's pin first (it may dispatch), then render
        // from the store as it is afterwards.
        applyStagePolicy(getState());

        const state = getState();
        const tilesMode = isTilesMode();

        syncEnlarged(state);

        // Phase D: the rotation runs while this view shows (teacher, Normal).
        // The selected student (and the staged one) are priority cameras.
        // Tiles view: only the current page, in nearby groups of the grid.
        slTeacherRotation.setActive(true);
        slTeacherRotation.setPriority(getPriorityStudents(state));
        slTeacherRotation.setLayout(tilesMode
            ? { scope: tilesView.participantIds, order: getTilesOrder(), positions: gridCoversPage() ? gridPositions : null }
            : null);
        slTeacherRotation.update(state);

        const items = tilesMode ? collectPageTiles(state) : collectTiles(state);
        const panel = resolvePanel(state);

        // Tiles view: the enlarged camera gets its explicit height in the
        // receive policy while that participant is here (disconnected /
        // panel closed: nobody). With the camera off nothing is sent; the
        // request stays 360, so it is 360 again the moment it comes back.
        slTeacherRotation.setEnlarged(panel && panel.state !== "disconnected" ? panel.id : null);
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
                item.muted, item.pinned, item.onStage,
                // Phase D: camera ON / planned live / streaming status change
                // a rotating tile's state.
                Boolean(item.cameraOn), isRotatingCameraTile(item) && slTeacherRotation.isPlannedLive(item.id),
                isRotatingCameraTile(item) && item.track ? getStreamingStatus(item.track.jitsiTrack) : null,
                Boolean(item.absent)
            ]),
            [stage.id, trackKey(stage.track), stage.empty, statusMessage, stage.local,
                stage.placeholder ? [stage.placeholder.name, stage.placeholder.role] : null],
            // Tiles view: page, and the enlarged panel's student and state.
            [tilesMode, tilesView.epoch, tilesView.page, tilesView.pageCount, tilesView.total, tilesView.pageSize,
                panel ? [panel.id, panel.name, panel.state, panel.status, trackKey(panel.track)] : null]
        ]);

        // Unchanged, and still mounted in Jitsi's current page element.
        if (signature === lastSignature && root && root.parentNode === getMountParent()) {
            return;
        }

        lastSignature = signature;
        ensureRoot();
        applyLayout();

        // The settings menu follows the view (filmstrip / grid bar), open or
        // not, and shows the current View and page size.
        placeLayoutMenu();

        if (isLayoutMenuOpen()) {
            updateLayoutMenu();
        }

        // Tiles.
        const wanted = new Set(items.map(item => item.id));

        Array.from(tiles.keys())
            .filter(tileId => !wanted.has(tileId))
            .forEach(removeTile);

        // List view: the filmstrip; Tiles view: the grid (a tile moves
        // between them with its element, track and frame).
        const container = tilesMode ? gridEl : tilesEl;

        if (tilesMode && !items.length) {
            gridEl.appendChild(gridEmptyEl);
        } else {
            gridEmptyEl.remove();
        }

        // Walks the tiles in list order; a tile is moved only when it is out
        // of place (no re-append of every tile on every render).
        let nextInPlace = container.firstChild;

        items.forEach(item => {
            const tile = tiles.get(item.id) || createTile(item.id);
            let mode;

            if (item.absent) {
                // Tiles view: on the page but not in the meeting (left or
                // reconnecting): nothing is shown from any stream.
                watchTileStatus(tile, null);
                detachFrom(tile.jitsiTrack, tile.video);
                tile.jitsiTrack = null;
                tile.frozen = false;
                tile.playForFrame = false;
                mode = "disconnected";
            } else if (isRotatingCameraTile(item)) {
                mode = updateRotatingTile(tile, item);
            } else {
                const jitsiTrack = item.track && !item.muted ? item.track.jitsiTrack : null;

                if (tile.jitsiTrack !== jitsiTrack) {
                    detachFrom(tile.jitsiTrack, tile.video);
                    tile.jitsiTrack = null;

                    if (jitsiTrack && attachTo(jitsiTrack, tile.video)) {
                        tile.jitsiTrack = jitsiTrack;
                    }
                }

                tile.frozen = false;
                tile.playForFrame = false;
                watchTileStatus(tile, null);
                mode = tile.jitsiTrack ? "live" : "off";
            }

            tile.mode = mode;
            tile.nameEl.textContent = item.name;
            tile.el.title = item.name;
            tile.el.setAttribute("aria-pressed", item.pinned ? "true" : "false");
            setPlaceholder(
                tile.placeholder,
                item.name,
                item.kind === "desktop" ? "screen" : item.role,
                isRotatingCameraTile(item) ? (SL_TV_TILE_PLACEHOLDER_STATUS[mode] || "") : ""
            );
            tile.el.classList.toggle("sl-no-video",
                mode === "off" || mode === "waiting" || mode === "connecting" || mode === "disconnected");
            // Frozen (rotated out) and stalled (not arriving) both show the
            // held frame with the quiet pause marker; its tooltip says which.
            // A frozen tile whose student is planned live again but has no
            // stream of their own yet (e.g. re-mapped away) is connecting.
            tile.el.classList.toggle("sl-frozen", mode === "frozen" || mode === "stalled");
            tile.frozenEl.title = mode === "stalled"
                ? (SL_STATUS_MESSAGES[getStreamingStatus(tile.jitsiTrack)] || "Waiting for live video…")
                : isRotatingCameraTile(item) && slTeacherRotation.isPlannedLive(item.id)
                    ? SL_TV_TILE_PLACEHOLDER_STATUS.connecting
                    : "Live view resumes shortly";
            tile.el.classList.toggle("sl-mirror", item.local && item.kind === "camera");
            tile.el.classList.toggle("sl-desktop", item.kind === "desktop");
            tile.el.classList.toggle("sl-pinned", item.pinned);
            tile.el.classList.toggle("sl-on-stage", item.onStage);

            // Only a live tile plays (a frozen / stalled one must keep its
            // frame), and a connecting one in a build without streaming
            // status, which has no frame to keep yet.
            if ((mode === "live" || tile.playForFrame) && tile.jitsiTrack) {
                playVideo(tile.video);
            }

            if (tile.el === nextInPlace) {
                nextInPlace = nextInPlace.nextSibling;
            } else {
                container.insertBefore(tile.el, nextInPlace);
            }
        });

        if (tilesMode) {
            // No stage in Tiles view (its element lets go of its track); the
            // enlarged panel shows the selected student instead.
            setStageTrack(null);
            renderGridBar();
            renderPanel(panel);
            root.classList.add("sl-visible");
            document.body.classList.toggle(SL_TV_ACTIVE_CLASS, true);
            layoutTilesGrid();
            return;
        }

        renderPanel(null);

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

    // Tiles view from the parent page (which owns the roster order and the
    // paging, and resends it after SL_RECEIVE_READY):
    //   { type: "SL_TEACHER_TILES", v: 1, epoch, layout: "list" | "tiles",
    //     participantIds (the page, roster order, at most 50), page,
    //     pageCount, rangeStart, rangeEnd, total, pageSize? (10-50) }
    // The settings menu asks the parent page to change View / page size:
    //   iframe -> parent: { type: "SL_TEACHER_TILES_SETTINGS", v: 1,
    //                       layout?: "list" | "tiles", pageSize?: 10-50 }
    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_TEACHER_TILES") {
            return;
        }

        const count = value => typeof value === "number" && Number.isInteger(value) && value >= 0;

        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || (data.layout !== "list" && data.layout !== "tiles")
            || !Array.isArray(data.participantIds)
            || data.participantIds.length > SL_TV_TILES_MAX_PAGE
            || !data.participantIds.every(id => typeof id === "string" && SL_TV_PARTICIPANT_ID_PATTERN.test(id))
            || new Set(data.participantIds).size !== data.participantIds.length
            || ![data.page, data.pageCount, data.rangeStart, data.rangeEnd, data.total].every(count)
            || (data.pageSize !== undefined && !SL_TV_TILES_PAGE_SIZES.includes(data.pageSize))) {
            console.warn("[SL Classroom] Ignored malformed teacher tiles", data);

            return;
        }

        // An older message must never overwrite a newer one. The same epoch
        // is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < tilesView.epoch) {
            return;
        }

        tilesView = {
            epoch: data.epoch,
            layout: data.layout,
            participantIds: data.participantIds.slice(),
            page: data.page,
            pageCount: data.pageCount,
            rangeStart: data.rangeStart,
            rangeEnd: data.rangeEnd,
            total: data.total,
            pageSize: data.pageSize ?? 0
        };

        console.log("[SL Classroom] Teacher tiles", tilesView.layout, "page", tilesView.page,
            "of", tilesView.pageCount, "(" + tilesView.participantIds.length + " students)");

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
        // Phase D: scheduler state, a forced sub-tick, and each tile's mode.
        rotation: () => slTeacherRotation.stats(),
        rotationTick: () => slTeacherRotation.subtick(),
        rotationAutoTick: on => slTeacherRotation.setAutoTick(on),
        // Jitsi's hidden filmstrip videos: what this view holds paused.
        defaultVideos: () => {
            let paused = 0;
            let yielded = 0;

            guardedFilmstripVideos.forEach(entry => {
                paused += entry.paused ? 1 : 0;
                yielded += entry.yielded ? 1 : 0;
            });

            return {
                suppressed: filmstripSuppressed,
                observing: Boolean(filmstripObserver),
                guarded: guardedFilmstripVideos.size,
                paused,
                yielded,
                largeVideoSuppressed
            };
        },
        tileModes: () => {
            const modes = {};

            tiles.forEach((tile, id) => { modes[id] = tile.mode || ""; });

            return modes;
        },
        // Tiles view: layout, page, grid and the enlarged panel.
        tiles: () => ({
            layout: tilesView.layout,
            page: tilesView.page,
            pageCount: tilesView.pageCount,
            participantIds: tilesView.participantIds.slice(),
            rendered: gridEl
                ? Array.from(gridEl.children).filter(el => el.dataset && el.dataset.tileId).map(el => el.dataset.tileId)
                : [],
            columns: gridColumns,
            // The tile width applied with the columns ("" before the first
            // measurement).
            tileWidth: gridEl
                ? (gridEl.style.getPropertyValue
                    ? gridEl.style.getPropertyValue(SL_TV_VAR_TILE_W)
                    : gridEl.style[SL_TV_VAR_TILE_W]) || ""
                : null,
            order: gridOrder ? gridOrder.slice() : null,
            label: gridLabelEl ? gridLabelEl.textContent : "",
            previousDisabled: gridPrevEl ? Boolean(gridPrevEl.disabled) : null,
            nextDisabled: gridNextEl ? Boolean(gridNextEl.disabled) : null,
            panel: enlarged
                ? { open: true, id: enlarged.id, name: enlarged.name, state: panelEl ? panelEl.dataset.state : "" }
                : { open: false }
        }),
        // The View / filmstrip settings menu: where it is, what it shows.
        settingsMenu: () => {
            const checked = selector => Array.from(layoutMenuEl?.querySelectorAll(selector) || [])
                .find(el => el.getAttribute("aria-checked") === "true");
            const pressed = Array.from(pageSizeSectionEl?.querySelectorAll(".sl-tv-pagesize") || [])
                .find(el => el.getAttribute("aria-pressed") === "true");

            return {
                open: isLayoutMenuOpen(),
                place: !layoutMenuEl ? null
                    : layoutMenuEl.parentNode === gridSettingsWrapEl ? "grid"
                        : layoutMenuEl.parentNode === footerEl ? "filmstrip" : "other",
                view: checked(".sl-tv-view-item")?.dataset.view ?? null,
                pageSizesShown: Boolean(pageSizeSectionEl && !pageSizeSectionEl.hidden),
                pageSize: pressed ? Number(pressed.dataset.pageSize) : null,
                position: checked(".sl-tv-layout-item[data-position]")?.dataset.position ?? null,
                autoHide: autoHideSwitchEl?.getAttribute("aria-checked") === "true",
                expanded: {
                    filmstrip: layoutButtonEl?.getAttribute("aria-expanded") ?? null,
                    grid: gridSettingsEl?.getAttribute("aria-expanded") ?? null
                }
            };
        },
        openSettings: () => activeLayoutButton()?.dispatchEvent(new MouseEvent("click")),
        chooseView: layout => Array.from(layoutMenuEl?.querySelectorAll(".sl-tv-view-item") || [])
            .find(el => el.dataset.view === layout)?.dispatchEvent(new MouseEvent("click")),
        choosePageSize: size => Array.from(pageSizeSectionEl?.querySelectorAll(".sl-tv-pagesize") || [])
            .find(el => Number(el.dataset.pageSize) === size)?.dispatchEvent(new MouseEvent("click")),
        choosePosition: position => Array.from(layoutMenuEl?.querySelectorAll(".sl-tv-layout-item[data-position]") || [])
            .find(el => el.dataset.position === position)?.dispatchEvent(new MouseEvent("click")),
        toggleAutoHide: () => autoHideSwitchEl?.dispatchEvent(new MouseEvent("click")),
        tilesPrevious: () => gridPrevEl && gridPrevEl.dispatchEvent(new MouseEvent("click")),
        tilesNext: () => gridNextEl && gridNextEl.dispatchEvent(new MouseEvent("click")),
        tileClick: id => tiles.get(id)?.el.dispatchEvent(new MouseEvent("click")),
        closePanel: () => closeEnlarged(),
        autoHide: enabled => {
            setAutoHide(enabled);
            updateLayoutMenu();
        },
        hide: () => setStripHidden(true),
        show: () => setStripHidden(false),
        layout: () => ({
            preferred: preferredPosition,
            effective: root ? root.dataset.pos : null,
            // A choice made while the screen placed the filmstrip itself.
            chosenHere: positionChosenHere,
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

    // Phase D: tiles are frozen before their camera is dropped.
    slTeacherRotation.onWillDrop(freezeTiles);

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



/* ==========================================================
   SL Classroom - Teaching Mode (the teacher's own camera, send side)

   Optional, teacher only, off by default. While on, the teacher's
   OWN camera track is tuned for handwriting and whiteboards:
     - MediaStreamTrack.contentHint = "detail" (when the browser
       supports it): the encoder keeps fine detail and, under
       pressure, lowers the frame rate before the resolution;
     - frameRate { max: 15 } MERGED into the track's existing
       constraints (the resolution, the device and every other
       constraint Jitsi asked for are kept), so each frame gets
       more of the bitrate.
   The frame-rate cap (maxFps) is also the teacher's camera frame rate
   setting on its own: when the parent page sends maxFps it applies
   whether the mode is on or off, and turning the mode on / off only
   adds / removes the content hint (the frame rate is never touched).
   Nothing else changes: simulcast, Jitsi's and the bridge's adaptive
   quality, the receive policy and every student's view stay as they
   are. The resolution is never raised (no 1080p / 4K).

   Turning it off puts back, on the same track, the original hint and
   the original frame-rate constraint (only where ours is still in
   place; the other constraints are left as they are). A track this
   section never changed is never touched.

   The camera track belongs to Jitsi and is often replaced: camera
   off / on (Jitsi may stop the camera and open a new one, sometimes
   inside the same JitsiLocalTrack), a camera switch, a reconnect.
   The live track is looked up again on every store change and,
   while the mode is on, every SL_TM_POLL_MS (a replacement is not
   always a store change); a new track gets the settings again.
   Stopped tracks are forgotten (nothing to restore on them). With a
   background effect (blur / virtual background) Jitsi sends a
   generated track: the hint still applies, the frame-rate cap may
   be refused there.

   Every step is best effort: an unsupported hint, a refused or
   unsupported constraint (OverconstrainedError, TypeError) or a
   call that never settles is reported and skipped, never thrown.
   Meeting teardown (pagehide) ends the tracks themselves.

   Runs ONLY for the local moderator (teacher), only while the parent
   page enables it:
     { type: "SL_TEACHING_MODE", v: 1, epoch, enabled, maxFps?, detailHint? }
     maxFps      15 | 24 | 30, the frame-rate cap, applied on or off
                 (absent: 15, and only while on)
     detailHint  boolean, whether contentHint "detail" is set (absent:
                 true). Optional because Jitsi sets the sender's
                 degradationPreference to "maintain-framerate", which can
                 override what the hint would change.
   An older parent page sends neither field and gets exactly the earlier
   behaviour (15 fps + "detail"). Any other value makes the message
   malformed: it is ignored and the current mode stays.
   Changing maxFps (or detailHint while on) first restores that part's
   ORIGINAL setting on the track, then applies the new one (never
   stacking caps); the other part is left as it is.
   (Resent by the parent after SL_RECEIVE_READY.) Reports back, once
   the parent has sent one, whenever it changes:
     { type: "SL_TEACHING_MODE_STATUS", v: 1, enabled, active, camera,
       contentHint, frameRate, fps, maxFps, detailHint }
     active       the mode is on here (enabled, local moderator)
     camera       a live local camera track exists (looked up while the
                  mode is on or the frame rate applies)
     contentHint  "applied" | "disabled" | "unsupported" | "failed" | null
                  (null while the mode is off)
     frameRate    "applied" | "kept" (already at or below the cap) |
                  "pending" | "unsupported" | "failed" | null
     fps          the track's reported frame rate (getSettings) or null
     maxFps, detailHint  the requested settings
========================================================== */

(function () {

    const SL_TM_CONTENT_HINT = "detail";
    // The frame-rate caps the parent page may ask for, and the default
    // (also an older parent page's, which sends none).
    const SL_TM_FRAME_RATES = [15, 24, 30];
    const SL_TM_DEFAULT_FRAME_RATE = 15;
    // Safety net while on: a replaced camera track is not always a store
    // change (a new stream inside the same JitsiLocalTrack).
    const SL_TM_POLL_MS = 2000;
    // A constraint change that has not settled by then is reported as
    // failed, so later changes are not held up behind it.
    const SL_TM_APPLY_TIMEOUT_MS = 5000;
    // Constraint errors that mean "not possible here" rather than a fault.
    const SL_TM_UNSUPPORTED_ERRORS = ["OverconstrainedError", "NotSupportedError", "TypeError"];

    let mode = { epoch: 0, enabled: false, maxFps: SL_TM_DEFAULT_FRAME_RATE, detailHint: true, frameRateAlways: false };
    // A status is only ever posted once the parent page has sent the mode
    // (a teacher's page): students' pages never hear about it.
    let heard = false;

    // MediaStreamTrack -> { hint, frameRate }: what this section changed on
    // it and the original values (newHintPart / newFrameRatePart, null when
    // that part is not applied). Normally one entry; stopped tracks are
    // dropped.
    const changed = new Map();

    // Track changes (apply / restore) run one at a time, in order.
    let queue = Promise.resolve();
    let pollTimer = null;
    let lastStatus = "";

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    function isLocalModerator(state) {
        return state?.["features/base/participants"]?.local?.role === "moderator";
    }

    function isActive(state) {
        return Boolean(state && mode.enabled && isLocalModerator(state));
    }

    function errorName(error) {
        return (error && (error.name || error.message)) || String(error);
    }

    // The local camera's MediaStreamTrack (never a screen share, never a
    // remote track), or null while there is none or it has stopped.
    function getLocalCameraTrack(state) {
        const tracks = state?.["features/base/tracks"];
        const entry = (Array.isArray(tracks) ? tracks : []).find(track =>
            track && track.local && track.videoType === "camera" && track.jitsiTrack);

        if (!entry || typeof entry.jitsiTrack.getTrack !== "function") {
            return null;
        }

        let mediaTrack = null;

        try {
            mediaTrack = entry.jitsiTrack.getTrack();
        } catch (error) {
            return null;
        }

        return mediaTrack && mediaTrack.readyState !== "ended" ? mediaTrack : null;
    }

    // Whether the frame-rate cap applies now: while the mode is on, and
    // also while it is off when the parent page sent maxFps (the camera
    // frame rate is a setting of its own there). Local moderator only.
    function isFrameRateActive(state) {
        return Boolean(state && (mode.enabled || mode.frameRateAlways) && isLocalModerator(state));
    }

    // The two independent parts of what this section changes on a track.
    // Each keeps its requested setting fixed for its lifetime: a change
    // gets a new part after the old one is restored. Turning the mode on /
    // off only adds / removes the hint part; the frame-rate part stays.
    function newHintPart() {
        return {
            detailHint: mode.detailHint,
            // contentHint before the change; changed: ours is set.
            hint: "",
            changed: false,
            status: null
        };
    }

    function newFrameRatePart() {
        return {
            maxFps: mode.maxFps,
            // The frameRate constraint before the change (hadFrameRate:
            // there was one); changed: our cap is in place.
            frameRate: undefined,
            hadFrameRate: false,
            changed: false,
            status: null
        };
    }

    // The track's current constraints (a copy), or null when they cannot be
    // read: then nothing is applied, since a constraint set without them
    // could drop the resolution or the chosen device.
    function readConstraints(track) {
        if (typeof track.getConstraints !== "function") {
            return null;
        }

        try {
            const current = track.getConstraints();

            return current && typeof current === "object" ? { ...current } : null;
        } catch (error) {
            return null;
        }
    }

    function readSettings(track) {
        try {
            const settings = typeof track.getSettings === "function" ? track.getSettings() : null;

            return settings && typeof settings === "object" ? settings : {};
        } catch (error) {
            return {};
        }
    }

    // The upper frame-rate limit a constraint value already sets, or null.
    function frameRateLimit(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }

        if (value && typeof value === "object") {
            for (const key of ["exact", "max"]) {
                if (typeof value[key] === "number" && Number.isFinite(value[key])) {
                    return value[key];
                }
            }
        }

        return null;
    }

    // applyConstraints that fails after SL_TM_APPLY_TIMEOUT_MS, so the queue
    // moves on. onLate(succeeded) runs if it settles after that.
    function applyWithTimeout(track, constraints, onLate) {
        return new Promise((resolve, reject) => {
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                reject(Object.assign(new Error("applyConstraints timed out"), { name: "TimeoutError" }));
            }, SL_TM_APPLY_TIMEOUT_MS);

            Promise.resolve()
                .then(() => track.applyConstraints(constraints))
                .then(() => {
                    clearTimeout(timer);

                    if (timedOut) {
                        onLate(true);
                    } else {
                        resolve();
                    }
                }, error => {
                    clearTimeout(timer);

                    if (timedOut) {
                        onLate(false);
                    } else {
                        reject(error);
                    }
                });
        });
    }

    function enqueue(task) {
        queue = queue
            .then(task)
            .catch(error => {
                console.warn("[SL Classroom] Teaching mode step failed:", errorName(error));
            })
            .then(reportStatus);
    }

    // Whether this part is still the one wanted on this track.
    function isCurrent(track, key, part) {
        const record = changed.get(track);

        return Boolean(record && record[key] === part);
    }

    // The content hint (only when asked for).
    async function applyHint(track, part) {
        // Turned off, or the track replaced, before this step ran.
        if (!isCurrent(track, "hint", part) || track.readyState === "ended") {
            return;
        }

        if (!part.detailHint) {
            part.status = "disabled";
        } else if ("contentHint" in track) {
            try {
                part.hint = track.contentHint || "";
                track.contentHint = SL_TM_CONTENT_HINT;
                part.changed = track.contentHint === SL_TM_CONTENT_HINT;
                part.status = part.changed ? "applied" : "unsupported";
            } catch (error) {
                part.status = "failed";
                console.warn("[SL Classroom] Teaching mode: contentHint not applied:", errorName(error));
            }
        } else {
            part.status = "unsupported";
        }
    }

    // The frame-rate cap, merged into the existing constraints.
    async function applyFrameRate(track, part) {
        if (!isCurrent(track, "frameRate", part) || track.readyState === "ended") {
            return;
        }

        const current = typeof track.applyConstraints === "function" ? readConstraints(track) : null;

        if (!current) {
            part.status = "unsupported";

            return;
        }

        const limit = frameRateLimit(current.frameRate);

        // Already capped at or below the requested cap: left exactly as it
        // is (a cap is never raised).
        if (limit !== null && limit <= part.maxFps) {
            part.status = "kept";

            return;
        }

        const next = { ...current, frameRate: { max: part.maxFps } };

        // No size constraint at all (Jitsi always sets one): the current size
        // is kept as the ideal, since a set without any may fall back to the
        // camera's default size.
        if (!("width" in current) && !("height" in current)) {
            const settings = readSettings(track);

            if (settings.width > 0) {
                next.width = { ideal: settings.width };
            }

            if (settings.height > 0) {
                next.height = { ideal: settings.height };
            }
        }

        part.hadFrameRate = Object.prototype.hasOwnProperty.call(current, "frameRate");
        part.frameRate = current.frameRate;
        part.status = "pending";
        reportStatus();

        try {
            await applyWithTimeout(track, next, succeeded => {
                if (!succeeded) {
                    return;
                }

                // Settled after the timeout: the cap is in place after all.
                part.changed = true;
                part.status = "applied";

                if (!isCurrent(track, "frameRate", part)) {
                    enqueue(() => restoreFrameRate(track, part));
                } else {
                    reportStatus();
                }
            });

            part.changed = true;
            part.status = "applied";
        } catch (error) {
            const name = errorName(error);

            part.status = SL_TM_UNSUPPORTED_ERRORS.includes(name) ? "unsupported" : "failed";
            console.warn("[SL Classroom] Teaching mode: frame-rate cap not applied:", name);
        }
    }

    // Put back what applyHint / applyFrameRate changed on this track (safe
    // to run again: each part is undone once).
    async function restoreHint(track, part) {
        if (track.readyState === "ended" || !part.changed) {
            return;
        }

        part.changed = false;

        try {
            // Only our own value is replaced, never a later change by others.
            if (track.contentHint === SL_TM_CONTENT_HINT) {
                track.contentHint = part.hint;
            }
        } catch (error) {
            console.warn("[SL Classroom] Teaching mode: contentHint not restored:", errorName(error));
        }
    }

    async function restoreFrameRate(track, part) {
        if (track.readyState === "ended" || !part.changed) {
            return;
        }

        part.changed = false;

        const current = readConstraints(track);

        // Our cap is no longer there (Jitsi set new constraints): nothing
        // of ours is left to undo.
        if (!current || frameRateLimit(current.frameRate) !== part.maxFps) {
            return;
        }

        delete current.frameRate;

        if (part.hadFrameRate) {
            current.frameRate = part.frameRate;
        }

        try {
            await applyWithTimeout(track, current, () => {});
        } catch (error) {
            console.warn("[SL Classroom] Teaching mode: frame rate not restored:", errorName(error));
        }
    }

    function currentStatus() {
        const state = getState();
        const active = isActive(state);
        const track = active || isFrameRateActive(state) ? getLocalCameraTrack(state) : null;
        const record = track ? changed.get(track) : null;
        const fps = track ? readSettings(track).frameRate : null;

        return {
            type: "SL_TEACHING_MODE_STATUS",
            v: 1,
            enabled: mode.enabled,
            active,
            camera: Boolean(track),
            contentHint: record && record.hint ? record.hint.status : null,
            frameRate: record && record.frameRate ? record.frameRate.status : null,
            fps: typeof fps === "number" && Number.isFinite(fps) ? Math.round(fps * 10) / 10 : null,
            maxFps: mode.maxFps,
            detailHint: mode.detailHint
        };
    }

    function reportStatus() {
        if (!heard) {
            return;
        }

        const status = currentStatus();
        const signature = JSON.stringify(status);

        if (signature === lastStatus) {
            return;
        }

        lastStatus = signature;
        slPostToParent(status);
    }

    function pollTeachingMode() {
        sync();
    }

    function syncPoll(active) {
        if (active && !pollTimer) {
            pollTimer = setInterval(pollTeachingMode, SL_TM_POLL_MS);
        } else if (!active && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // Cheap; runs on every store change. Restores every changed track that
    // is no longer the one to change (mode off and no frame-rate setting,
    // role lost, track replaced). On the current camera track the hint and
    // the frame-rate cap are kept in step separately: a part whose setting
    // changed (or is no longer wanted) is restored to the ORIGINAL value
    // first (the queue runs that before the new apply), and the other part
    // is left alone. So turning the mode on / off never touches the frame
    // rate, and a new frame rate never touches the hint.
    function sync() {
        const state = getState();
        const hintActive = isActive(state);
        const frameRateActive = isFrameRateActive(state);
        const wanted = hintActive || frameRateActive ? getLocalCameraTrack(state) : null;

        changed.forEach((record, track) => {
            if (track.readyState === "ended") {
                changed.delete(track);
            } else if (track !== wanted) {
                changed.delete(track);

                if (record.hint) {
                    const part = record.hint;

                    enqueue(() => restoreHint(track, part));
                }

                if (record.frameRate) {
                    const part = record.frameRate;

                    enqueue(() => restoreFrameRate(track, part));
                }
            }
        });

        if (wanted) {
            const record = changed.get(wanted) || { hint: null, frameRate: null };

            changed.set(wanted, record);

            if (record.hint && (!hintActive || record.hint.detailHint !== mode.detailHint)) {
                const part = record.hint;

                record.hint = null;
                enqueue(() => restoreHint(wanted, part));
            }

            if (hintActive && !record.hint) {
                const part = newHintPart();

                record.hint = part;
                enqueue(() => applyHint(wanted, part));
            }

            if (record.frameRate && (!frameRateActive || record.frameRate.maxFps !== mode.maxFps)) {
                const part = record.frameRate;

                record.frameRate = null;
                enqueue(() => restoreFrameRate(wanted, part));
            }

            if (frameRateActive && !record.frameRate) {
                const part = newFrameRatePart();

                record.frameRate = part;
                enqueue(() => applyFrameRate(wanted, part));
            }
        }

        syncPoll(hintActive || frameRateActive);
        reportStatus();
    }

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_TEACHING_MODE") {
            return;
        }

        // maxFps / detailHint are optional (an older parent page sends
        // neither); present, they must be one of the allowed values.
        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || typeof data.enabled !== "boolean"
            || (data.maxFps !== undefined && !SL_TM_FRAME_RATES.includes(data.maxFps))
            || (data.detailHint !== undefined && typeof data.detailHint !== "boolean")) {
            console.warn("[SL Classroom] Ignored malformed teaching mode", data);

            return;
        }

        // An older message must never overwrite a newer one. The same epoch
        // is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < mode.epoch) {
            return;
        }

        // Kept even before the local role is known: it only ever applies
        // while the local participant is a moderator.
        mode = {
            epoch: data.epoch,
            enabled: data.enabled,
            maxFps: data.maxFps === undefined ? SL_TM_DEFAULT_FRAME_RATE : data.maxFps,
            detailHint: data.detailHint === undefined ? true : data.detailHint,
            // An explicit maxFps is the camera frame rate, applied whether
            // the mode is on or off; an older parent page (no maxFps) gets
            // its cap only while on, as before.
            frameRateAlways: data.maxFps !== undefined
        };
        heard = true;
        // The parent gets the current status for every message it sends.
        lastStatus = "";

        console.log("[SL Classroom] Teaching mode", mode);

        sync();
    });

    // ---------------------------------------------------------------------
    // TESTING ONLY - from the Jitsi iframe's DevTools console:
    //   __slTeachingModeTest.on()   __slTeachingModeTest.off()
    //   __slTeachingModeTest.state()   what is applied
    // Affects only this browser's own camera. The next SL_TEACHING_MODE
    // from the parent page replaces it.
    // ---------------------------------------------------------------------
    window.__slTeachingModeTest = {
        on: () => {
            mode = { ...mode, enabled: true };
            sync();
        },
        off: () => {
            mode = { ...mode, enabled: false };
            sync();
        },
        state: () => {
            const status = currentStatus();
            const track = getLocalCameraTrack(getState());

            return {
                customJsVersion: typeof SL_CUSTOM_JS_VERSION === "number" ? SL_CUSTOM_JS_VERSION : null,
                ...status,
                trackContentHint: track && "contentHint" in track ? track.contentHint : null,
                trackConstraints: track ? readConstraints(track) : null,
                trackSettings: track ? readSettings(track) : null,
                polling: Boolean(pollTimer)
            };
        }
    };

    // Page teardown: the tracks end with the page; only the poll is stopped.
    window.addEventListener("pagehide", () => syncPoll(false));

    // Follow every store change: the local tracks (camera on / off, switch,
    // reconnect) and the local role.
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function") {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(sync);
        sync();
    }, 500);

})();
 



/* ==========================================================
   SL Classroom - Teacher Video Bitrate (live cap, send side)

   Teacher only. The teacher's page sets the AV1 / VP8 / VP9 "high"
   (720p, top layer) bitrate cap when it creates this iframe
   (configOverwrite videoQuality.<codec>.maxBitratesVideo.high). This
   section lets the page change that cap DURING the meeting, on the
   active bridge connection, without a rejoin:
     - lib-jitsi-meet keeps the per-codec caps it read at connection
       set-up in its TraceablePeerConnection (tpcUtils.codecSettings)
       and reads them every time it computes the camera's encodings;
     - the "high" value is set there for AV1, VP8 and VP9 only (H.264,
       the other levels, screen sharing's own cap and the codec order
       are left as they are), then lib-jitsi-meet's own
       configureVideoSenderEncodings() re-applies the encodings through
       its own queue, exactly as it does after a codec change.
   Its later recomputes (receiver requests, codec change, camera track
   replaced, camera off / on) keep using the new value. A new bridge
   connection (reconnect) is built from the page's configOverwrite and
   gets the latest cap again here (store change / poll).

   A MAXIMUM, not a rate: the browser and Jitsi still adapt to the
   network, the CPU and the size students request (below 720p Jitsi
   uses its "standard" / "low" caps, which are not changed).

   These are lib-jitsi-meet internals, not the public API: anything
   missing (no tpcUtils, no codecSettings, no
   configureVideoSenderEncodings) is reported "unsupported" and nothing
   is changed; the cap then applies from the next join only.

   Runs ONLY for the local moderator (teacher), only once the page sends:
     { type: "SL_TEACHER_BITRATE", v: 1, epoch, maxBitrate }
     maxBitrate  500000 | 1000000 | 1500000 | 2500000
   (resent by the page after SL_RECEIVE_READY). Reports, whenever it
   changes:
     { type: "SL_TEACHER_BITRATE_STATUS", v: 1, maxBitrate, state,
       topMaxBitrate, codec }
     state          "applied" | "pending" | "unsupported" | "failed"
     topMaxBitrate  the camera sender's active top encoding maxBitrate
                    as the browser holds it, or null
     codec          the camera sender's codec ("av1", "vp8", ...) or null
========================================================== */

(function () {

    const SL_TBR_CODECS = ["av1", "vp8", "vp9"];
    const SL_TBR_ALLOWED = [500000, 1000000, 1500000, 2500000];
    // Safety net: a replaced bridge connection is not always a store change.
    const SL_TBR_POLL_MS = 2000;

    let wanted = { epoch: 0, maxBitrate: null };
    // Nothing is done or posted before the teacher's page has sent a cap.
    let heard = false;
    // TraceablePeerConnection -> the cap set on it.
    const appliedOn = new WeakMap();
    let state = null;
    let pollTimer = null;
    let lastStatus = "";

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    function isLocalModerator(store) {
        return store?.["features/base/participants"]?.local?.role === "moderator";
    }

    // The bridge connection's TraceablePeerConnection (P2P is off).
    function getBridgeConnection(store) {
        const conference = store?.["features/base/conference"]?.conference;

        return conference?.jvbJingleSession?.peerconnection || null;
    }

    function getCodecSettings(tpc) {
        const settings = tpc?.tpcUtils?.codecSettings;

        return settings && typeof settings === "object" ? settings : null;
    }

    // The local camera's MediaStreamTrack (never a screen share).
    function getLocalCameraTrack(store) {
        const tracks = store?.["features/base/tracks"];
        const entry = (Array.isArray(tracks) ? tracks : []).find(track =>
            track && track.local && track.videoType === "camera" && track.jitsiTrack);

        try {
            return entry && typeof entry.jitsiTrack.getTrack === "function" ? entry.jitsiTrack.getTrack() : null;
        } catch (error) {
            return null;
        }
    }

    // What the browser holds for the camera sender: its codec and the
    // maxBitrate of its largest active encoding.
    function readCameraSender(store, tpc) {
        const result = { codec: null, topMaxBitrate: null };
        const cameraTrack = getLocalCameraTrack(store);
        let sender = null;

        try {
            const senders = tpc?.peerconnection?.getSenders?.() || [];

            sender = senders.find(candidate => candidate.track && candidate.track === cameraTrack) || null;
        } catch (error) {
            sender = null;
        }

        if (!sender || typeof sender.getParameters !== "function") {
            return result;
        }

        try {
            const parameters = sender.getParameters() || {};
            const mimeType = parameters.codecs?.[0]?.mimeType;
            const active = (Array.isArray(parameters.encodings) ? parameters.encodings : [])
                .filter(encoding => encoding && encoding.active !== false)
                .sort((a, b) => (a.scaleResolutionDownBy || 1) - (b.scaleResolutionDownBy || 1));

            result.codec = typeof mimeType === "string" ? mimeType.replace(/^video\//i, "").toLowerCase() : null;
            result.topMaxBitrate = active.length && typeof active[0].maxBitrate === "number" ? active[0].maxBitrate : null;
        } catch (error) {
            /* left unknown */
        }

        return result;
    }

    function currentStatus() {
        const store = getState();
        const sender = state === "applied" ? readCameraSender(store, getBridgeConnection(store)) : { codec: null, topMaxBitrate: null };

        return {
            type: "SL_TEACHER_BITRATE_STATUS",
            v: 1,
            maxBitrate: wanted.maxBitrate,
            state,
            topMaxBitrate: sender.topMaxBitrate,
            codec: sender.codec
        };
    }

    function reportStatus() {
        if (!heard || state === null) {
            return;
        }

        const status = currentStatus();
        const signature = JSON.stringify(status);

        if (signature !== lastStatus) {
            lastStatus = signature;
            slPostToParent(status);
        }
    }

    function syncPoll(active) {
        if (active && !pollTimer) {
            pollTimer = setInterval(() => sync(true), SL_TBR_POLL_MS);
        } else if (!active && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // Cheap; runs on every store change and on the poll. Sets the wanted cap
    // on the current bridge connection once (again for a new connection or
    // a new cap), then reports. Once applied, the sender's current state is
    // re-read on the poll only (fromPoll), not on every store change.
    function sync(fromPoll) {
        const store = getState();
        const active = Boolean(heard && wanted.maxBitrate !== null && isLocalModerator(store));

        syncPoll(active);

        if (!active) {
            return;
        }

        const tpc = getBridgeConnection(store);

        if (!tpc) {
            state = "pending";
            reportStatus();

            return;
        }

        if (appliedOn.get(tpc) === wanted.maxBitrate) {
            if (fromPoll === true) {
                reportStatus();
            }

            return;
        }

        const settings = getCodecSettings(tpc);

        if (!settings || typeof tpc.configureVideoSenderEncodings !== "function") {
            state = "unsupported";
            reportStatus();

            return;
        }

        const cap = wanted.maxBitrate;

        SL_TBR_CODECS.forEach(codec => {
            const levels = settings[codec]?.maxBitratesVideo;

            if (levels && typeof levels === "object") {
                levels.high = cap;
            }
        });

        appliedOn.set(tpc, cap);
        state = "pending";
        reportStatus();

        Promise.resolve()
            .then(() => tpc.configureVideoSenderEncodings())
            .then(() => {
                if (getBridgeConnection(getState()) === tpc && wanted.maxBitrate === cap) {
                    state = "applied";
                    reportStatus();
                }
            }, error => {
                console.warn("[SL Classroom] Teacher bitrate: encodings not re-applied:",
                    (error && (error.name || error.message)) || String(error));

                if (wanted.maxBitrate === cap) {
                    // The value stays in codecSettings (used by the next
                    // recompute); the next sync tries the re-apply again.
                    appliedOn.delete(tpc);
                    state = "failed";
                    reportStatus();
                }
            });
    }

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_TEACHER_BITRATE") {
            return;
        }

        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || !SL_TBR_ALLOWED.includes(data.maxBitrate)) {
            console.warn("[SL Classroom] Ignored malformed teacher bitrate", data);

            return;
        }

        // An older message must never overwrite a newer one. The same epoch
        // is accepted: the page resends it after SL_RECEIVE_READY.
        if (data.epoch < wanted.epoch) {
            return;
        }

        wanted = { epoch: data.epoch, maxBitrate: data.maxBitrate };
        heard = true;
        // The page gets the current status for every message it sends.
        lastStatus = "";

        console.log("[SL Classroom] Teacher bitrate", wanted);

        sync(true);
    });

    // ---------------------------------------------------------------------
    // TESTING ONLY - from the Jitsi iframe's DevTools console:
    //   __slTeacherBitrateTest.state()   what is wanted / applied
    // ---------------------------------------------------------------------
    window.__slTeacherBitrateTest = {
        state: () => {
            const store = getState();
            const tpc = getBridgeConnection(store);
            const settings = getCodecSettings(tpc);

            return {
                customJsVersion: typeof SL_CUSTOM_JS_VERSION === "number" ? SL_CUSTOM_JS_VERSION : null,
                ...currentStatus(),
                appliedOnConnection: tpc ? appliedOn.get(tpc) ?? null : null,
                codecHigh: settings
                    ? Object.fromEntries(Object.keys(settings)
                        .filter(codec => settings[codec]?.maxBitratesVideo)
                        .map(codec => [codec, settings[codec].maxBitratesVideo.high]))
                    : null,
                polling: Boolean(pollTimer)
            };
        }
    };

    window.addEventListener("pagehide", () => syncPoll(false));

    // Follow every store change: the conference / bridge connection
    // (reconnect), the local camera, the local role.
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function") {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(sync);
        sync();
    }, 500);

})();



/* ==========================================================
   SL Classroom - Video Quality Telemetry (diagnosis only)

   Read-only. Measures what the teacher's camera is really sent at
   and what each student really receives, from WebRTC getStats() on
   the bridge connection, so quality drops can be told apart:
   bandwidth, CPU / encoder, the camera itself, or Jitsi / the bridge
   choosing a lower layer. Nothing here changes a codec, bitrate,
   sender parameter, constraint, receiver constraint or track.

   Rates (fps, kbps, loss) are DELTAS between two getStats() samples
   of the same stat object (SL_VT_POLL_MS apart), never one cumulative
   value, and never MediaStreamTrack.getSettings().frameRate (that is
   only what the camera was configured for; it is reported apart, as
   "configured"). A first sample, a new stat object (track replaced,
   reconnect: a new peer connection) or a counter that went back gives
   null ("N/A"), never a guess.

   Teacher (local moderator), only while the parent page enables it:
     parent -> iframe: { type: "SL_VIDEO_TELEMETRY", v: 1, epoch, enabled }
     iframe -> parent, every SL_VT_POLL_MS while enabled (and once
     when it stops):
       { type: "SL_VIDEO_TELEMETRY_STATUS", v: 1, intervalMs, enabled,
         active, error, send, students }
   Students: no parent message. While a moderator asks (a small
   request over Jitsi's bridge data channel, repeated every
   SL_VT_REQUEST_TICKS polls), a student measures what it receives
   and sends a compact report to the asking moderator(s) only. With
   no request for SL_VT_STUDENT_TTL_TICKS polls it stops by itself:
   nothing runs while no teacher looks. Reports carry no names; the
   teacher's page maps the sender's Jitsi participant ID to a student
   through its own authenticated participant map.
========================================================== */

(function () {

    const SL_VT_POLL_MS = 5000;
    // Teacher: a request every 3 polls (15 s): late joiners and
    // reconnected students start reporting within one cycle.
    const SL_VT_REQUEST_TICKS = 3;
    // Student: reports for 8 polls (40 s) after the last request.
    const SL_VT_STUDENT_TTL_TICKS = 8;
    // Teacher: a report older than 3 polls is stale, older than 12 dropped.
    const SL_VT_STALE_TICKS = 3;
    const SL_VT_DROP_TICKS = 12;
    const SL_VT_MAX_STUDENTS = 200;
    const SL_VT_MAX_SOURCES = 6;
    const SL_VT_REQUEST = "sl-video-telemetry-request";
    const SL_VT_REPORT = "sl-video-telemetry-report";
    // lib-jitsi-meet JitsiConferenceEvents.ENDPOINT_MESSAGE_RECEIVED.
    const SL_VT_ENDPOINT_EVENT = "conference.endpoint_message_received";
    // A delta over less than this (ms) is too short to be a rate.
    const SL_VT_MIN_DELTA_MS = 500;
    const SL_VT_TEXT_PATTERN = /^[A-Za-z0-9 ._:/+()-]{1,64}$/;
    const SL_VT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
    const SL_VT_LIMITATIONS = ["none", "cpu", "bandwidth", "other"];

    let view = { epoch: 0, enabled: false };
    // A status is only posted once the parent page has asked (teachers).
    let heard = false;

    let teacherTimer = null;
    let studentTimer = null;
    let tickNo = 0;
    let studentTicksLeft = 0;
    // One getStats() at a time.
    let sampling = false;
    let lastError = null;

    // The conference whose endpoint messages are followed.
    let listenedConference = null;
    // The peer connection the previous sample came from (deltas restart
    // when it changes), and that sample's stats by id.
    let sampledConnection = null;
    let previous = new Map();
    let reportSeq = 0;

    // Teacher: participant ID -> { report, tick }.
    const studentReports = new Map();
    // Student: moderator ID -> tick of their last request.
    const requesters = new Map();

    // Bridge-channel messaging, counted on both sides (reset with the
    // conference): what reached whom, and what was turned away and why.
    function newMessaging() {
        return {
            requestsSent: 0,
            requestErrors: 0,
            reportsAccepted: 0,
            reportsIgnoredNotInMeeting: 0,
            reportsIgnoredFromModerator: 0,
            requestsReceived: 0,
            requestsIgnoredNotModerator: 0,
            reportsSent: 0,
            reportErrors: 0,
            lastSendError: null
        };
    }

    let messaging = newMessaging();

    function getState() {
        return window.APP && APP.store ? APP.store.getState() : null;
    }

    function isLocalModerator(state) {
        return state?.["features/base/participants"]?.local?.role === "moderator";
    }

    function getConference(state) {
        return state?.["features/base/conference"]?.conference ?? null;
    }

    function teacherActive(state) {
        return Boolean(state && view.enabled && isLocalModerator(state) && getConference(state));
    }

    // ---- Stats parsing (pure; exposed for tests) ---------------------------

    function isNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    function round(value, digits) {
        if (!isNumber(value)) {
            return null;
        }

        const scale = Math.pow(10, digits || 0);

        return Math.round(value * scale) / scale;
    }

    function text(value) {
        return typeof value === "string" && value ? value.slice(0, 64) : null;
    }

    // RTCStatsReport (or a Map / array of stats) -> Map id -> stat.
    function indexStats(report) {
        const index = new Map();

        const add = stat => {
            if (stat && typeof stat === "object" && typeof stat.id === "string" && typeof stat.type === "string") {
                index.set(stat.id, stat);
            }
        };

        if (report && typeof report.forEach === "function") {
            report.forEach(add);
        }

        return index;
    }

    function statsOfType(index, type) {
        return Array.from(index.values()).filter(stat => stat.type === type);
    }

    function isVideo(stat) {
        return (stat.kind || stat.mediaType) === "video";
    }

    // Seconds between two samples of the same stat object, or null.
    function deltaSeconds(current, before) {
        if (!before || !isNumber(current.timestamp) || !isNumber(before.timestamp)) {
            return null;
        }

        const ms = current.timestamp - before.timestamp;

        return ms >= SL_VT_MIN_DELTA_MS ? ms / 1000 : null;
    }

    // A counter's increase between two samples, or null (missing, or it
    // went back: a reset is never a rate).
    function counterDelta(current, before, field) {
        if (!current || !before || !isNumber(current[field]) || !isNumber(before[field])) {
            return null;
        }

        const delta = current[field] - before[field];

        return delta >= 0 ? delta : null;
    }

    function perSecond(current, before, field) {
        const seconds = deltaSeconds(current, before);
        const delta = counterDelta(current, before, field);

        return seconds !== null && delta !== null ? delta / seconds : null;
    }

    function kbps(current, before, field) {
        const bytes = perSecond(current, before, field);

        return bytes === null ? null : round(bytes * 8 / 1000, 0);
    }

    function codecOf(index, stat) {
        const codec = stat && stat.codecId ? index.get(stat.codecId) : null;
        const mimeType = codec && typeof codec.mimeType === "string" ? codec.mimeType : null;

        return mimeType ? mimeType.replace(/^video\//i, "") : null;
    }

    // The active ICE candidate pair: the transport's selected one, else a
    // nominated succeeded one (Firefox: "selected").
    function selectedPair(index) {
        const transport = statsOfType(index, "transport").find(stat => stat.selectedCandidatePairId);
        const byTransport = transport ? index.get(transport.selectedCandidatePairId) : null;

        return byTransport || statsOfType(index, "candidate-pair").find(pair =>
            pair.selected === true || (pair.nominated && pair.state === "succeeded")) || null;
    }

    // Connection-wide: RTT, the available bitrate estimate, all bytes
    // (audio and video, both ways: what a data budget counts).
    function networkSample(index, before) {
        const pair = selectedPair(index);

        if (!pair) {
            return null;
        }

        const prior = before ? before.get(pair.id) : null;

        return {
            rttMs: isNumber(pair.currentRoundTripTime) ? round(pair.currentRoundTripTime * 1000, 0) : null,
            availableOutgoingKbps: isNumber(pair.availableOutgoingBitrate) ? round(pair.availableOutgoingBitrate / 1000, 0) : null,
            availableIncomingKbps: isNumber(pair.availableIncomingBitrate) ? round(pair.availableIncomingBitrate / 1000, 0) : null,
            receiveKbps: kbps(pair, prior, "bytesReceived"),
            sendKbps: kbps(pair, prior, "bytesSent"),
            bytesReceived: isNumber(pair.bytesReceived) ? pair.bytesReceived : null,
            bytesSent: isNumber(pair.bytesSent) ? pair.bytesSent : null
        };
    }

    // Share (0-100) of the interval spent in each limitation reason, from
    // qualityLimitationDurations deltas (seconds).
    function limitationShares(current, before) {
        const now = current.qualityLimitationDurations;
        const then = before && before.qualityLimitationDurations;

        if (!now || !then || typeof now !== "object" || typeof then !== "object") {
            return null;
        }

        const deltas = {};
        let total = 0;

        SL_VT_LIMITATIONS.forEach(reason => {
            const delta = counterDelta(now, then, reason);

            deltas[reason] = delta === null ? 0 : delta;
            total += deltas[reason];
        });

        if (!(total > 0)) {
            return null;
        }

        const shares = {};

        SL_VT_LIMITATIONS.forEach(reason => {
            shares[reason] = round(deltas[reason] / total * 100, 0);
        });

        return shares;
    }

    // "L3T3_KEY" -> { spatial: 3, temporal: 3 }; null when not an SVC mode.
    function scalabilityLayers(mode) {
        const match = typeof mode === "string" ? /^[LS](\d)T(\d)/.exec(mode) : null;

        return match ? { spatial: Number(match[1]), temporal: Number(match[2]) } : null;
    }

    function outboundStream(index, before, stat) {
        const prior = before ? before.get(stat.id) : null;
        const frames = counterDelta(stat, prior, "framesEncoded");
        const encodeSeconds = counterDelta(stat, prior, "totalEncodeTime");
        const remote = statsOfType(index, "remote-inbound-rtp").find(entry => entry.localId === stat.id) || null;
        const remotePrior = remote && before ? before.get(remote.id) : null;
        const sent = counterDelta(stat, prior, "packetsSent");
        const lost = counterDelta(remote, remotePrior, "packetsLost");
        // With spatial SVC (AV1 / VP9 "L3T3..."), Chrome counts every spatial
        // layer's frame in framesEncoded: 720p with 3 layers is 3 per picture
        // (seen as ~60/s at ~20 fps). That delta is kept as the LAYER frame
        // rate; the picture rate is then the browser's own framesPerSecond,
        // and their ratio is how many spatial layers are being encoded.
        const layerFrameRate = perSecond(stat, prior, "framesEncoded");
        const browserFps = isNumber(stat.framesPerSecond) ? stat.framesPerSecond : null;
        const layers = scalabilityLayers(stat.scalabilityMode);
        const spatialSvc = Boolean(layers && layers.spatial > 1);
        const activeSpatialLayers = spatialSvc && layerFrameRate !== null && browserFps > 0
            ? Math.min(layers.spatial, Math.max(1, Math.round(layerFrameRate / browserFps)))
            : spatialSvc ? null : 1;

        return {
            id: stat.id,
            rid: text(stat.rid),
            ssrc: isNumber(stat.ssrc) ? stat.ssrc : null,
            active: typeof stat.active === "boolean" ? stat.active : null,
            width: isNumber(stat.frameWidth) ? stat.frameWidth : null,
            height: isNumber(stat.frameHeight) ? stat.frameHeight : null,
            // Pictures per second: the framesEncoded delta, except with
            // spatial SVC (see above), where only the browser's own value is.
            encodedFps: round(spatialSvc ? browserFps : layerFrameRate, 1),
            encodedFpsSource: spatialSvc ? (browserFps !== null ? "browser" : null) : "delta",
            layerFrameRate: round(layerFrameRate, 1),
            activeSpatialLayers,
            sentFrameRate: round(perSecond(stat, prior, "framesSent"), 1),
            // The browser's own estimate, kept apart from the delta above.
            browserFps: round(browserFps, 1),
            kbps: kbps(stat, prior, "bytesSent"),
            retransmitKbps: kbps(stat, prior, "retransmittedBytesSent"),
            targetKbps: isNumber(stat.targetBitrate) ? round(stat.targetBitrate / 1000, 0) : null,
            // Per frame as framesEncoded counts it: per LAYER frame with
            // spatial SVC (how layer times add up is not specified).
            encodeMsPerFrame: frames && encodeSeconds !== null ? round(encodeSeconds / frames * 1000, 1) : null,
            framesEncoded: isNumber(stat.framesEncoded) ? stat.framesEncoded : null,
            keyFramesEncoded: isNumber(stat.keyFramesEncoded) ? stat.keyFramesEncoded : null,
            limitation: SL_VT_LIMITATIONS.includes(stat.qualityLimitationReason) ? stat.qualityLimitationReason : null,
            limitationShares: limitationShares(stat, prior),
            resolutionChanges: isNumber(stat.qualityLimitationResolutionChanges) ? stat.qualityLimitationResolutionChanges : null,
            codec: codecOf(index, stat),
            encoder: text(stat.encoderImplementation),
            powerEfficientEncoder: typeof stat.powerEfficientEncoder === "boolean" ? stat.powerEfficientEncoder : null,
            scalabilityMode: text(stat.scalabilityMode),
            nacks: counterDelta(stat, prior, "nackCount"),
            plis: counterDelta(stat, prior, "pliCount"),
            // As the bridge reports it back (RTCP) for this stream.
            lossPct: sent !== null && lost !== null && sent + lost > 0 ? round(lost / (sent + lost) * 100, 1)
                : remote && isNumber(remote.fractionLost) ? round(remote.fractionLost * 100, 1) : null,
            packetsLost: remote && isNumber(remote.packetsLost) ? remote.packetsLost : null,
            rttMs: remote && isNumber(remote.roundTripTime) ? round(remote.roundTripTime * 1000, 0) : null
        };
    }

    /*
     * The camera track before WebRTC, to tell the camera apart from
     * Chrome's capture pipeline: MediaStreamTrack.stats (Chrome 120+)
     * counts frames the camera PRODUCED (totalFrames) and those the track
     * delivered or discarded (e.g. frame-rate decimation); with the
     * camera's capabilities and the frame-rate constraint in force.
     * camera.stats / camera.statsBefore: { at (ms), deliveredFrames,
     * discardedFrames, totalFrames } or null.
     */
    function trackSample(camera) {
        const now = camera.stats || null;
        const then = camera.statsBefore || null;
        const seconds = now && then && isNumber(now.at) && isNumber(then.at) && now.at - then.at >= SL_VT_MIN_DELTA_MS
            ? (now.at - then.at) / 1000
            : null;
        const rate = field => {
            const delta = seconds !== null ? counterDelta(now, then, field) : null;

            return delta === null ? null : round(delta / seconds, 1);
        };
        const capabilities = camera.capabilities || {};
        const constraint = camera.constraints ? camera.constraints.frameRate : undefined;

        return {
            label: text(camera.label),
            producedFps: rate("totalFrames"),
            deliveredFps: rate("deliveredFrames"),
            discardedFps: rate("discardedFrames"),
            statsSupported: Boolean(now),
            capabilityMaxFps: isNumber(capabilities.frameRate?.max) ? round(capabilities.frameRate.max, 1) : null,
            capabilityMaxHeight: isNumber(capabilities.height?.max) ? capabilities.height.max : null,
            // The frame-rate constraint as set on the track (e.g. Teaching
            // Mode's cap), as JSON text; null when there is none.
            frameRateConstraint: constraint === undefined ? null : text(JSON.stringify(constraint))
        };
    }

    /*
     * The teacher's camera as sent. camera: { trackId, settings, ... } of
     * the live local camera track (see trackSample), or null (camera off).
     * desktopTrackId: the local screen share's track, never counted as the
     * camera.
     */
    function sendSample(index, before, camera, desktopTrackId) {
        if (!camera) {
            return { camera: false, network: networkSample(index, before) };
        }

        const sources = statsOfType(index, "media-source").filter(isVideo);
        const isDesktop = source => Boolean(desktopTrackId) && source.trackIdentifier === desktopTrackId;
        const others = sources.filter(source => !isDesktop(source));
        const cameraSource = sources.find(source => source.trackIdentifier === camera.trackId)
            || (others.length === 1 ? others[0] : null);
        const desktopIds = new Set(sources.filter(isDesktop).map(source => source.id));
        const outbound = statsOfType(index, "outbound-rtp").filter(isVideo).filter(stat =>
            cameraSource && stat.mediaSourceId ? stat.mediaSourceId === cameraSource.id : !desktopIds.has(stat.mediaSourceId));
        const streams = outbound.map(stat => outboundStream(index, before, stat));
        // The best layer receivers can get: the highest active one.
        const top = streams
            .filter(stream => stream.active !== false && stream.height !== null)
            .sort((a, b) => b.height - a.height || (b.kbps || 0) - (a.kbps || 0))[0] || null;
        const rates = streams.map(stream => stream.kbps).filter(isNumber);
        const targets = streams.map(stream => stream.targetKbps).filter(isNumber);
        const sourceBefore = cameraSource && before ? before.get(cameraSource.id) : null;
        const settings = camera.settings || {};
        const deliveredFps = cameraSource ? perSecond(cameraSource, sourceBefore, "frames") : null;

        return {
            camera: true,
            // What the camera delivered (media-source).
            capture: cameraSource ? {
                width: isNumber(cameraSource.width) ? cameraSource.width : null,
                height: isNumber(cameraSource.height) ? cameraSource.height : null,
                fps: round(deliveredFps !== null ? deliveredFps : cameraSource.framesPerSecond, 1)
            } : null,
            // What the camera was configured for (getSettings): not a rate.
            configured: {
                width: isNumber(settings.width) ? settings.width : null,
                height: isNumber(settings.height) ? settings.height : null,
                frameRate: round(settings.frameRate, 1),
                resizeMode: text(settings.resizeMode)
            },
            // The camera track itself, before WebRTC (see trackSample).
            track: trackSample(camera),
            encoded: top ? {
                width: top.width,
                height: top.height,
                fps: top.encodedFps,
                fpsSource: top.encodedFpsSource,
                browserFps: top.browserFps,
                layerFrameRate: top.layerFrameRate,
                activeSpatialLayers: top.activeSpatialLayers,
                encodeMsPerFrame: top.encodeMsPerFrame
            } : null,
            kbps: rates.length ? rates.reduce((sum, rate) => sum + rate, 0) : null,
            // One layer's target with SVC (Chrome spreads the layer targets
            // over the encodings, active or not); the sum is the encoder's.
            targetKbps: top ? top.targetKbps : null,
            targetKbpsTotal: targets.length ? targets.reduce((sum, rate) => sum + rate, 0) : null,
            limitation: top ? top.limitation : null,
            limitationShares: top ? top.limitationShares : null,
            codec: top ? top.codec : null,
            encoder: top ? top.encoder : null,
            powerEfficientEncoder: top ? top.powerEfficientEncoder : null,
            scalabilityMode: top ? top.scalabilityMode : null,
            lossPct: top ? top.lossPct : null,
            rttMs: top ? top.rttMs : null,
            streams: streams.slice(0, SL_VT_MAX_SOURCES),
            network: networkSample(index, before)
        };
    }

    /*
     * What this browser receives, per remote video source. ownerOf maps an
     * inbound stat to { participantId, role, videoType, requestedHeight,
     * streamingStatus } from Jitsi's store at the time of the sample, or
     * null: unmapped sources are left out.
     */
    function receiveSample(index, before, ownerOf) {
        const sources = [];

        statsOfType(index, "inbound-rtp").filter(isVideo).forEach(stat => {
            const owner = ownerOf(stat);

            if (!owner || !(stat.bytesReceived > 0)) {
                return;
            }

            const prior = before ? before.get(stat.id) : null;
            const received = counterDelta(stat, prior, "packetsReceived");
            const lost = counterDelta(stat, prior, "packetsLost");
            const emitted = counterDelta(stat, prior, "jitterBufferEmittedCount");
            const buffered = counterDelta(stat, prior, "jitterBufferDelay");

            sources.push({
                participantId: owner.participantId,
                role: owner.role,
                videoType: owner.videoType,
                width: isNumber(stat.frameWidth) ? stat.frameWidth : null,
                height: isNumber(stat.frameHeight) ? stat.frameHeight : null,
                fps: round(perSecond(stat, prior, "framesDecoded"), 1),
                browserFps: round(stat.framesPerSecond, 1),
                kbps: kbps(stat, prior, "bytesReceived"),
                lossPct: received !== null && lost !== null && received + lost > 0
                    ? round(lost / (received + lost) * 100, 1) : null,
                packetsLost: isNumber(stat.packetsLost) ? stat.packetsLost : null,
                framesDecoded: isNumber(stat.framesDecoded) ? stat.framesDecoded : null,
                framesDropped: isNumber(stat.framesDropped) ? stat.framesDropped : null,
                freezeCount: isNumber(stat.freezeCount) ? stat.freezeCount : null,
                bytesReceived: stat.bytesReceived,
                jitterMs: isNumber(stat.jitter) ? round(stat.jitter * 1000, 0) : null,
                jitterBufferMs: emitted && buffered !== null ? round(buffered / emitted * 1000, 0) : null,
                codec: codecOf(index, stat),
                decoder: text(stat.decoderImplementation),
                // What this browser asked the bridge for (receive policy),
                // and whether Jitsi sees it as forwarded.
                requestedHeight: isNumber(owner.requestedHeight) ? owner.requestedHeight : null,
                streamingStatus: text(owner.streamingStatus)
            });
        });

        const rank = source => (source.role === "moderator" ? 0 : 2) + (source.videoType === "camera" ? 0 : 1);

        return {
            sources: sources.sort((a, b) => rank(a) - rank(b)).slice(0, SL_VT_MAX_SOURCES),
            network: networkSample(index, before)
        };
    }

    // ---- Jitsi access ------------------------------------------------------

    // The bridge connection's RTCPeerConnection (P2P is off).
    function getPeerConnection(conference) {
        let active = null;

        try {
            active = typeof conference?.getActivePeerConnection === "function"
                ? conference.getActivePeerConnection()
                : null;
        } catch (error) {
            active = null;
        }

        for (const tpc of [conference?.jvbJingleSession?.peerconnection, active]) {
            const pc = tpc?.peerconnection || null;

            if (pc && typeof pc.getStats === "function") {
                return pc;
            }
        }

        return null;
    }

    function mediaTrackOf(entry) {
        try {
            return typeof entry?.jitsiTrack?.getTrack === "function" ? entry.jitsiTrack.getTrack() : null;
        } catch (error) {
            return null;
        }
    }

    // The live, unmuted local track of this video type, or null.
    function localVideo(state, videoType) {
        const tracks = state?.["features/base/tracks"];
        const entry = (Array.isArray(tracks) ? tracks : []).find(track =>
            track && track.local && track.videoType === videoType && track.jitsiTrack);
        const mediaTrack = mediaTrackOf(entry);

        return mediaTrack && mediaTrack.readyState !== "ended" && !entry.muted ? mediaTrack : null;
    }

    function readSettings(track) {
        try {
            return typeof track.getSettings === "function" ? track.getSettings() || {} : {};
        } catch (error) {
            return {};
        }
    }

    function readTrackCall(track, name) {
        try {
            return typeof track[name] === "function" ? track[name]() || null : null;
        } catch (error) {
            return null;
        }
    }

    // The camera track's frame counters now (MediaStreamTrack.stats, a live
    // object in Chrome 120+), copied with the time; null without support.
    function readTrackStats(track) {
        let stats = null;

        try {
            stats = track.stats || null;
        } catch (error) {
            stats = null;
        }

        if (!stats || !isNumber(stats.totalFrames)) {
            return null;
        }

        const clock = typeof performance === "object" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();

        return {
            at: clock,
            deliveredFrames: stats.deliveredFrames,
            discardedFrames: stats.discardedFrames,
            totalFrames: stats.totalFrames
        };
    }

    // The previous frame counters, for the same camera track only.
    let previousTrackStats = { track: null, stats: null };

    // Everything sendSample needs about the live camera track.
    function describeCamera(track) {
        const stats = readTrackStats(track);
        const statsBefore = previousTrackStats.track === track ? previousTrackStats.stats : null;

        previousTrackStats = { track, stats };

        return {
            trackId: track.id,
            label: track.label,
            settings: readSettings(track),
            capabilities: readTrackCall(track, "getCapabilities"),
            constraints: readTrackCall(track, "getConstraints"),
            stats,
            statsBefore
        };
    }

    // Maps an inbound stat to the remote track Jitsi's store has for it now
    // (by receiver track id, else SSRC). With SSRC rewriting a stream can
    // move to another sender; the store's current owner is what counts.
    function makeOwnerLookup(state, conference) {
        const participants = state?.["features/base/participants"];
        const tracks = state?.["features/base/tracks"];
        const byTrack = new Map();
        const bySsrc = new Map();
        const applied = conference ? conference.__slLastApplied : null;

        (Array.isArray(tracks) ? tracks : []).forEach(entry => {
            if (!entry || entry.local || entry.mediaType === "audio" || !entry.jitsiTrack) {
                return;
            }

            const mediaTrack = mediaTrackOf(entry);
            let ssrc = null;

            try {
                ssrc = typeof entry.jitsiTrack.getSSRC === "function" ? entry.jitsiTrack.getSSRC() : null;
            } catch (error) {
                ssrc = null;
            }

            if (mediaTrack && mediaTrack.id) {
                byTrack.set(mediaTrack.id, entry);
            }

            if (isNumber(ssrc)) {
                bySsrc.set(ssrc, entry);
            }
        });

        return stat => {
            const entry = (stat.trackIdentifier && byTrack.get(stat.trackIdentifier)) || bySsrc.get(stat.ssrc);

            if (!entry || !entry.participantId) {
                return null;
            }

            const participant = participants?.remote?.get?.(entry.participantId);
            let sourceName = null;
            let streamingStatus = null;

            try {
                sourceName = typeof entry.jitsiTrack.getSourceName === "function" ? entry.jitsiTrack.getSourceName() : null;
                streamingStatus = typeof entry.jitsiTrack.getTrackStreamingStatus === "function"
                    ? entry.jitsiTrack.getTrackStreamingStatus()
                    : null;
            } catch (error) {
                /* left unknown */
            }

            const constraint = sourceName ? applied?.constraints?.[sourceName] : null;
            const fallback = applied?.defaultConstraints?.maxHeight;

            return {
                participantId: entry.participantId,
                role: participant?.role === "moderator" ? "moderator" : "participant",
                videoType: entry.videoType === "desktop" ? "desktop" : "camera",
                requestedHeight: constraint && isNumber(constraint.maxHeight)
                    ? constraint.maxHeight
                    : isNumber(fallback) ? fallback : null,
                streamingStatus
            };
        };
    }

    // One getStats() at a time (null while one runs, or none possible);
    // deltas are against the previous sample of the same peer connection.
    async function measure(conference) {
        if (sampling) {
            return null;
        }

        const pc = getPeerConnection(conference);

        if (!pc) {
            lastError = "no-peer-connection";
            previous = new Map();
            sampledConnection = null;

            return null;
        }

        if (pc !== sampledConnection) {
            previous = new Map();
            sampledConnection = pc;
        }

        sampling = true;

        let index;

        try {
            index = indexStats(await pc.getStats());
        } catch (error) {
            lastError = "getstats-failed";

            return null;
        } finally {
            sampling = false;
        }

        // A reset (conference change, stop) while getStats ran.
        if (sampledConnection !== pc) {
            return null;
        }

        lastError = null;

        const before = previous;

        previous = index;

        return { index, before };
    }

    function resetSamples() {
        previous = new Map();
        sampledConnection = null;
        previousTrackStats = { track: null, stats: null };
    }

    // ---- Endpoint messages ---------------------------------------------------

    // false (and the reason kept) when it could not be sent, e.g. the
    // bridge channel is not open yet: the next cycle tries again.
    function sendEndpoint(conference, to, payload) {
        try {
            if (conference && typeof conference.sendEndpointMessage === "function") {
                conference.sendEndpointMessage(to, payload);

                return true;
            }

            messaging.lastSendError = "no-sendEndpointMessage";
        } catch (error) {
            messaging.lastSendError = text(String((error && (error.message || error.name)) || error));
        }

        return false;
    }

    // Students in the meeting now (non-moderators, no virtual participants).
    function presentStudents(state) {
        const participants = state?.["features/base/participants"];
        const remote = participants?.remote;
        const ids = [];

        if (remote && typeof remote.entries === "function") {
            for (const [participantId, participant] of remote.entries()) {
                if (participant && !participant.fakeParticipant && participant.role !== "moderator"
                    && participantId !== participants.local?.id) {
                    ids.push(participantId);
                }
            }
        }

        return ids;
    }

    function participantIdOf(participant) {
        try {
            return typeof participant?.getId === "function" ? participant.getId() : participant?.id ?? null;
        } catch (error) {
            return null;
        }
    }

    function onEndpointMessage(participant, payload) {
        if (!payload || typeof payload !== "object" || payload.v !== 1) {
            return;
        }

        const state = getState();
        const fromId = participantIdOf(participant);
        const sender = fromId ? state?.["features/base/participants"]?.remote?.get?.(fromId) : null;

        if (!sender || sender.fakeParticipant) {
            onUnknownSender(payload);

            return;
        }

        if (payload.type === SL_VT_REQUEST) {
            // Only a moderator may ask, and only a student answers.
            if (sender.role === "moderator" && !isLocalModerator(state)) {
                messaging.requestsReceived += 1;
                onStudentRequested(fromId);
            } else {
                messaging.requestsIgnoredNotModerator += 1;
            }

            return;
        }

        // Only students report, and only to a teacher who is listening.
        if (payload.type === SL_VT_REPORT && teacherActive(state)) {
            if (sender.role === "moderator") {
                messaging.reportsIgnoredFromModerator += 1;

                return;
            }

            const report = readStudentReport(payload);

            if (studentReports.has(fromId) || studentReports.size < SL_VT_MAX_STUDENTS) {
                studentReports.set(fromId, { report, tick: tickNo });
                messaging.reportsAccepted += 1;
            }
        }
    }

    // A report from someone not (or no longer) in this meeting.
    function onUnknownSender(payload) {
        if (payload && payload.type === SL_VT_REPORT && payload.v === 1) {
            messaging.reportsIgnoredNotInMeeting += 1;
        }
    }

    // Follows the current conference's endpoint messages (every role: a
    // student must hear requests). Returns true when the conference changed;
    // nothing carries over to another one.
    function syncListener(state) {
        const conference = getConference(state);

        if (conference === listenedConference) {
            return false;
        }

        if (listenedConference) {
            try {
                const off = listenedConference.off || listenedConference.removeEventListener;

                if (typeof off === "function") {
                    off.call(listenedConference, SL_VT_ENDPOINT_EVENT, onEndpointMessage);
                }
            } catch (error) {
                /* old conference gone */
            }
        }

        listenedConference = null;

        const on = conference && (conference.on || conference.addEventListener);

        if (typeof on === "function") {
            try {
                on.call(conference, SL_VT_ENDPOINT_EVENT, onEndpointMessage);
                listenedConference = conference;
            } catch (error) {
                listenedConference = null;
            }
        }

        studentReports.clear();
        requesters.clear();
        resetSamples();
        messaging = newMessaging();

        return true;
    }

    // ---- Student side --------------------------------------------------------

    // A sanitised copy of a student's report: anything unexpected is null.
    function readStudentReport(payload) {
        const num = (value, min, max, digits) =>
            isNumber(value) && value >= min && value <= max ? round(value, digits || 0) : null;
        const label = value => (typeof value === "string" && SL_VT_TEXT_PATTERN.test(value) ? value : null);
        const sources = Array.isArray(payload.sources) ? payload.sources.slice(0, SL_VT_MAX_SOURCES) : [];
        const network = payload.network && typeof payload.network === "object" ? payload.network : null;

        return {
            seq: num(payload.seq, 0, 1e9),
            // The student iframe's SL_CUSTOM_JS_VERSION (null: not sent).
            customJsVersion: num(payload.customJsVersion, 0, 1e6),
            sources: sources.filter(source => source && typeof source === "object").map(source => ({
                participantId: typeof source.participantId === "string" && SL_VT_ID_PATTERN.test(source.participantId)
                    ? source.participantId
                    : null,
                role: source.role === "moderator" ? "moderator" : "participant",
                videoType: source.videoType === "desktop" ? "desktop" : "camera",
                width: num(source.width, 0, 8192),
                height: num(source.height, 0, 8192),
                fps: num(source.fps, 0, 240, 1),
                browserFps: num(source.browserFps, 0, 240, 1),
                kbps: num(source.kbps, 0, 1e6),
                lossPct: num(source.lossPct, 0, 100, 1),
                packetsLost: num(source.packetsLost, -1e9, 1e12),
                framesDecoded: num(source.framesDecoded, 0, 1e12),
                framesDropped: num(source.framesDropped, 0, 1e12),
                freezeCount: num(source.freezeCount, 0, 1e9),
                bytesReceived: num(source.bytesReceived, 0, 1e15),
                jitterMs: num(source.jitterMs, 0, 1e6),
                jitterBufferMs: num(source.jitterBufferMs, 0, 1e6),
                codec: label(source.codec),
                decoder: label(source.decoder),
                requestedHeight: num(source.requestedHeight, 0, 8192),
                streamingStatus: label(source.streamingStatus)
            })),
            network: network ? {
                rttMs: num(network.rttMs, 0, 1e6),
                availableOutgoingKbps: num(network.availableOutgoingKbps, 0, 1e7),
                availableIncomingKbps: num(network.availableIncomingKbps, 0, 1e7),
                receiveKbps: num(network.receiveKbps, 0, 1e7),
                sendKbps: num(network.sendKbps, 0, 1e7),
                bytesReceived: num(network.bytesReceived, 0, 1e15),
                bytesSent: num(network.bytesSent, 0, 1e15)
            } : null
        };
    }

    function onStudentRequested(moderatorId) {
        requesters.set(moderatorId, tickNo);
        studentTicksLeft = SL_VT_STUDENT_TTL_TICKS;

        if (!studentTimer) {
            studentTimer = setInterval(studentTick, SL_VT_POLL_MS);
            // A baseline now, so the first report already has rates.
            measure(getConference(getState()));
        }
    }

    function stopStudent() {
        if (studentTimer) {
            clearInterval(studentTimer);
            studentTimer = null;
        }

        studentTicksLeft = 0;
        requesters.clear();
        resetSamples();
    }

    async function studentReport(conference) {
        const measured = await measure(conference);
        const state = getState();

        if (!measured || !studentTimer || getConference(state) !== conference) {
            return;
        }

        const result = receiveSample(measured.index, measured.before, makeOwnerLookup(state, conference));

        reportSeq += 1;

        const payload = {
            type: SL_VT_REPORT,
            v: 1,
            seq: reportSeq,
            customJsVersion: typeof SL_CUSTOM_JS_VERSION === "number" ? SL_CUSTOM_JS_VERSION : null,
            sources: result.sources,
            network: result.network
        };

        requesters.forEach((tick, moderatorId) => {
            if (sendEndpoint(conference, moderatorId, payload)) {
                messaging.reportsSent += 1;
            } else {
                messaging.reportErrors += 1;
            }
        });
    }

    function studentTick() {
        tickNo += 1;
        studentTicksLeft -= 1;

        const state = getState();
        const remote = state?.["features/base/participants"]?.remote;

        // Requesters who left, or stopped asking, are forgotten.
        requesters.forEach((tick, moderatorId) => {
            if (!remote?.get?.(moderatorId) || tickNo - tick > SL_VT_STUDENT_TTL_TICKS) {
                requesters.delete(moderatorId);
            }
        });

        if (studentTicksLeft <= 0 || !requesters.size || !getConference(state) || isLocalModerator(state)) {
            stopStudent();

            return;
        }

        studentReport(getConference(state));
    }

    // ---- Teacher side --------------------------------------------------------

    function broadcastRequest(conference) {
        if (sendEndpoint(conference, "", { type: SL_VT_REQUEST, v: 1 })) {
            messaging.requestsSent += 1;
        } else {
            messaging.requestErrors += 1;
        }
    }

    function studentRows(state) {
        const remote = state?.["features/base/participants"]?.remote;
        const rows = [];

        Array.from(studentReports.entries()).forEach(([participantId, entry]) => {
            const participant = remote?.get?.(participantId);
            const age = tickNo - entry.tick;

            // Left, now a moderator, or silent for too long: dropped.
            if (!participant || participant.role === "moderator" || age > SL_VT_DROP_TICKS) {
                studentReports.delete(participantId);

                return;
            }

            rows.push({
                participantId,
                ageSeconds: age * SL_VT_POLL_MS / 1000,
                stale: age > SL_VT_STALE_TICKS,
                ...entry.report
            });
        });

        return rows;
    }

    function postStatus(payload) {
        if (heard) {
            slPostToParent({ type: "SL_VIDEO_TELEMETRY_STATUS", v: 1, intervalMs: SL_VT_POLL_MS, ...payload });
        }
    }

    function postStopped() {
        postStatus({ enabled: view.enabled, active: false, error: null, send: null, students: [] });
    }

    async function teacherTick() {
        const state = getState();

        if (!teacherActive(state)) {
            syncTeacher();

            return;
        }

        tickNo += 1;

        const conference = getConference(state);

        if (tickNo % SL_VT_REQUEST_TICKS === 0) {
            broadcastRequest(conference);
        }

        const measured = await measure(conference);
        const now = getState();

        // Turned off, or the conference changed, while getStats ran.
        if (!teacherTimer || !teacherActive(now) || getConference(now) !== conference) {
            return;
        }

        let send = null;

        if (measured) {
            const camera = localVideo(now, "camera");
            const desktop = localVideo(now, "desktop");

            send = sendSample(measured.index, measured.before,
                camera ? describeCamera(camera) : null,
                desktop ? desktop.id : null);
        }

        const students = studentRows(now);
        const reporting = new Set(students.map(row => row.participantId));
        // Students in the meeting who sent no report (an older custom.js in
        // their iframe, or the bridge channel not delivering).
        const silent = presentStudents(now).filter(id => !reporting.has(id)).slice(0, SL_VT_MAX_STUDENTS);

        postStatus({
            enabled: true,
            active: true,
            error: lastError,
            send,
            students,
            silent,
            messaging: { ...messaging, studentsPresent: reporting.size + silent.length }
        });
    }

    function stopTeacher() {
        if (teacherTimer) {
            clearInterval(teacherTimer);
            teacherTimer = null;
        }

        studentReports.clear();
        resetSamples();
    }

    // Starts / stops the teacher's single poll with the mode, the role and
    // the conference. Cheap: runs on every store change.
    function syncTeacher() {
        const state = getState();
        const changed = syncListener(state);
        const active = teacherActive(state);

        if (active && !teacherTimer) {
            teacherTimer = setInterval(teacherTick, SL_VT_POLL_MS);
            broadcastRequest(getConference(state));
            // A baseline now, so the first status already has rates.
            measure(getConference(state));
        } else if (active && changed) {
            // Reconnect: the new conference's students are asked at once.
            broadcastRequest(getConference(state));
            measure(getConference(state));
        } else if (!active && teacherTimer) {
            stopTeacher();
            postStopped();
        }

        // A student promoted to moderator stops answering.
        if (studentTimer && isLocalModerator(state)) {
            stopStudent();
        }
    }

    window.addEventListener("message", function (event) {

        // Only the SL Classroom page that embeds this iframe may control it.
        if (event.source !== window.parent
            || !SL_ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
            return;
        }

        const data = event.data;

        if (!data || data.type !== "SL_VIDEO_TELEMETRY") {
            return;
        }

        if (data.v !== 1
            || typeof data.epoch !== "number"
            || !Number.isFinite(data.epoch)
            || typeof data.enabled !== "boolean") {
            console.warn("[SL Classroom] Ignored malformed video telemetry", data);

            return;
        }

        // An older message must never overwrite a newer one. The same epoch
        // is accepted: the parent resends it after SL_RECEIVE_READY.
        if (data.epoch < view.epoch) {
            return;
        }

        view = { epoch: data.epoch, enabled: data.enabled };
        heard = true;

        console.log("[SL Classroom] Video telemetry", view);

        const wasPolling = Boolean(teacherTimer);

        syncTeacher();

        // Off (or not a moderator yet): the parent hears it at once.
        if (!teacherTimer && !wasPolling) {
            postStopped();
        }
    });

    // ---------------------------------------------------------------------
    // TESTING ONLY - from the Jitsi iframe's DevTools console:
    //   __slVideoTelemetryTest.on()   __slVideoTelemetryTest.off()
    //   __slVideoTelemetryTest.state()
    // Read-only measurements; the parsers are exposed for unit tests.
    // ---------------------------------------------------------------------
    window.__slVideoTelemetryTest = {
        on: () => {
            view = { ...view, enabled: true };
            syncTeacher();
        },
        off: () => {
            view = { ...view, enabled: false };
            syncTeacher();
        },
        state: () => ({
            customJsVersion: typeof SL_CUSTOM_JS_VERSION === "number" ? SL_CUSTOM_JS_VERSION : null,
            enabled: view.enabled,
            teacherPolling: Boolean(teacherTimer),
            studentPolling: Boolean(studentTimer),
            studentTicksLeft,
            requesters: Array.from(requesters.keys()),
            reports: studentReports.size,
            listening: Boolean(listenedConference),
            lastError,
            messaging: { ...messaging }
        }),
        indexStats,
        sendSample,
        receiveSample
    };

    // Page teardown: both polls stop.
    window.addEventListener("pagehide", () => {
        stopTeacher();
        stopStudent();
    });

    // Follow every store change: the conference (reconnect), the local role.
    const waitForStore = setInterval(() => {
        if (!window.APP || !APP.store || typeof APP.store.subscribe !== "function") {
            return;
        }

        clearInterval(waitForStore);

        APP.store.subscribe(syncTeacher);
        syncTeacher();
    }, 500);

})();
