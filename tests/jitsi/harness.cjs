/*
 * Test harness for deploy/jitsi/custom.js.
 *
 * Loads the REAL custom.js into a Node vm context with:
 *   - a minimal fake DOM (enough for the teacher view's elements),
 *   - fake timers (advanced by hand),
 *   - a fake Jitsi store / conference / receive controller (APP),
 *   - a MOCK bridge that "forwards" the selected sources and sets each
 *     track's streaming status accordingly, and a mock decoder that puts the
 *     current owner's "frame" into every playing <video>.
 *
 * Everything Jitsi- or bridge-side here is a model written for these tests.
 * Passing tests do NOT verify the production Jitsi / lib-jitsi-meet /
 * JVB behaviour, only custom.js's logic against this model.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

// SL_CUSTOM_JS: run the tests against another copy (e.g. an older version).
const CUSTOM_JS = process.env.SL_CUSTOM_JS
    || path.join(__dirname, "..", "..", "deploy", "jitsi", "custom.js");
const PARENT_ORIGIN = "http://localhost:3000";
const STATUS_EVENT = "track.streaming_status_changed";

// ---- Timers --------------------------------------------------------------

class FakeTimers {
    constructor() {
        this.now = 0;
        this.nextId = 1;
        this.tasks = new Map();
    }

    setTimeout(fn, ms) {
        const id = this.nextId++;

        this.tasks.set(id, { fn, at: this.now + Math.max(0, ms || 0), every: null });

        return id;
    }

    setInterval(fn, ms) {
        const id = this.nextId++;
        const every = Math.max(1, ms || 0);

        this.tasks.set(id, { fn, at: this.now + every, every });

        return id;
    }

    clear(id) {
        this.tasks.delete(id);
    }

    // Runs every task due within ms, in time order.
    advance(ms) {
        const end = this.now + ms;

        for (;;) {
            let nextId = null;
            let next = null;

            for (const [id, task] of this.tasks) {
                if (task.at <= end && (!next || task.at < next.at || (task.at === next.at && id < nextId))) {
                    next = task;
                    nextId = id;
                }
            }

            if (!next) {
                break;
            }

            this.now = next.at;

            if (next.every) {
                next.at += next.every;
            } else {
                this.tasks.delete(nextId);
            }

            next.fn();
        }

        this.now = end;
    }

    intervalsNamed(name) {
        return Array.from(this.tasks.values()).filter(task => task.every && task.fn.name === name).length;
    }
}

// ---- DOM -----------------------------------------------------------------

class FakeClassList {
    constructor(el) {
        this.el = el;
        this.set = new Set();
    }

    add(...names) {
        names.forEach(name => this.set.add(name));
        this.el._changed("class");
    }

    remove(...names) {
        names.forEach(name => this.set.delete(name));
        this.el._changed("class");
    }

    toggle(name, force) {
        const on = force === undefined ? !this.set.has(name) : Boolean(force);
        const had = this.set.has(name);

        if (on) {
            this.set.add(name);
        } else {
            this.set.delete(name);
        }

        if (had !== on) {
            this.el._changed("class");
        }

        return on;
    }

    contains(name) {
        return this.set.has(name);
    }
}

class FakeElement {
    constructor(doc, tagName) {
        this.ownerDocument = doc;
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.listeners = {};
        this.attributes = {};
        this.dataset = {};
        this.style = {
            setProperty(name, value) { this[name] = String(value); },
            removeProperty(name) { delete this[name]; },
            getPropertyValue(name) { return name in this ? this[name] : ""; }
        };
        this.classList = new FakeClassList(this);
        this.textContent = "";
        this.innerHTML = "";
        this.id = "";
        this.title = "";
    }

    _changed(attribute) {
        this.ownerDocument._notifyMutation(this, attribute);
    }

    get className() {
        return Array.from(this.classList.set).join(" ");
    }

    set className(value) {
        this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
    }

    get firstChild() {
        return this.children[0] || null;
    }

    get lastChild() {
        return this.children[this.children.length - 1] || null;
    }

    get nextSibling() {
        if (!this.parentNode) {
            return null;
        }

        const siblings = this.parentNode.children;

        return siblings[siblings.indexOf(this) + 1] || null;
    }

    appendChild(child) {
        if (child.parentNode) {
            child.parentNode.removeChild(child);
        }

        this.children.push(child);
        child.parentNode = this;
        this.ownerDocument._notifyChildList(this, [child], []);

        return child;
    }

    insertBefore(child, ref) {
        if (!ref) {
            return this.appendChild(child);
        }

        if (child.parentNode) {
            child.parentNode.removeChild(child);
        }

        this.children.splice(this.children.indexOf(ref), 0, child);
        child.parentNode = this;
        this.ownerDocument._notifyChildList(this, [child], []);

        return child;
    }

    removeChild(child) {
        const index = this.children.indexOf(child);

        if (index >= 0) {
            this.children.splice(index, 1);
            child.parentNode = null;
            this.ownerDocument._notifyChildList(this, [], [child]);
        }

        return child;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }

    addEventListener(type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
    }

    removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] || []).filter(other => other !== fn);
    }

    dispatchEvent(event) {
        (this.listeners[event.type] || []).slice().forEach(fn => fn(event));

        return true;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return name in this.attributes ? this.attributes[name] : null;
    }

    removeAttribute(name) {
        delete this.attributes[name];
    }

    hasAttribute(name) {
        return name in this.attributes;
    }

    // Layout model: a tile inside the Tiles grid sits where CSS grid would
    // put it (DOM order, the grid's column variable); anything else fills
    // the window.
    getBoundingClientRect() {
        const parent = this.parentNode;

        if (this.dataset && this.dataset.tileId && parent && parent.classList.contains("sl-tv-grid")) {
            const columns = parseInt(parent.style["--sl-tv-grid-cols"], 10) || 5;
            const tileEls = parent.children.filter(child => child.dataset && child.dataset.tileId);
            const index = tileEls.indexOf(this);
            const width = 120;
            const height = 68;
            const left = (index % columns) * (width + 8);
            const top = Math.floor(index / columns) * (height + 8);

            return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
        }

        return { top: 0, left: 0, right: 1280, bottom: 800, width: 1280, height: 800, x: 0, y: 0 };
    }

    get clientWidth() { return this.classList.contains("sl-tv-grid") ? this.ownerDocument._gridSize.width : 1280; }
    get clientHeight() { return this.classList.contains("sl-tv-grid") ? this.ownerDocument._gridSize.height : 800; }
    get offsetWidth() { return 1280; }
    get offsetHeight() { return 800; }

    // One compound selector ("video", ".a.b", "[x]", "[x=y]", '[x="y"]',
    // combined), matched against real descendants built with createElement.
    _matches(selector) {
        const tag = (selector.match(/^[a-z][\w-]*/i) || [null])[0];
        const classes = selector.match(/\.[\w-]+/g) || [];
        const attributes = [...selector.matchAll(/\[([\w-]+)(?:=("?)([^"\]]*)\2)?\]/g)];

        if (!tag && !classes.length && !attributes.length) {
            return false;
        }

        return (!tag || this.tagName === tag.toUpperCase())
            && classes.every(name => this.classList.contains(name.slice(1)))
            && attributes.every(([, name, , value]) => {
                const actual = name.startsWith("data-")
                    ? this.dataset[name.slice(5).replace(/-([a-z])/g, (all, c) => c.toUpperCase())]
                    : name in this.attributes ? this.attributes[name] : this[name];

                return value === undefined ? actual !== undefined && actual !== null : String(actual) === value;
            });
    }

    querySelectorAll(selector) {
        return [...this.walk()].filter(el => el !== this && el._matches(selector));
    }

    // A real descendant when one matches; otherwise markup set through
    // innerHTML (not parsed) gets a stub element (one per selector), enough
    // for code that labels it.
    querySelector(selector) {
        const found = this.querySelectorAll(selector)[0];

        if (found) {
            return found;
        }

        this._stubs = this._stubs || new Map();

        if (!this._stubs.has(selector)) {
            this._stubs.set(selector, new FakeElement(this.ownerDocument, "span"));
        }

        return this._stubs.get(selector);
    }
    closest() { return null; }
    focus() {}
    blur() {}

    contains(node) {
        for (let current = node; current; current = current.parentNode) {
            if (current === this) {
                return true;
            }
        }

        return false;
    }

    *walk() {
        yield this;

        for (const child of this.children) {
            yield* child.walk();
        }
    }
}

// A <video>: "shows" the frame of a participant (shownOwner), like pixels.
// A paused element keeps what it shows; srcObject = null clears it.
class FakeVideo extends FakeElement {
    constructor(doc) {
        super(doc, "video");
        this.paused = true;
        this.autoplay = false;
        this._srcObject = null;
        this.shownOwner = null;
        doc._videos.add(this);
    }

    get srcObject() {
        return this._srcObject;
    }

    set srcObject(stream) {
        this._srcObject = stream;

        if (!stream) {
            this.shownOwner = null;
        } else if (this.autoplay) {
            // A muted autoplay element starts playing when given a stream.
            this.paused = false;
        }
    }

    play() {
        this.paused = false;

        return Promise.resolve();
    }

    pause() {
        this.paused = true;
    }

    get videoWidth() {
        return this.shownOwner ? 320 : 0;
    }

    get readyState() {
        return this.shownOwner ? 4 : 0;
    }
}

class FakeDocument {
    constructor() {
        this._videos = new Set();
        this._observers = [];
        this._resizeObservers = [];
        // The Tiles grid's size (clientWidth / clientHeight).
        this._gridSize = { width: 1280, height: 800 };
        this.listeners = {};
        this.documentElement = new FakeElement(this, "html");
        this.head = new FakeElement(this, "head");
        this.body = new FakeElement(this, "body");
        this.documentElement.appendChild(this.head);
        this.documentElement.appendChild(this.body);
        this.activeElement = this.body;
    }

    createElement(tagName) {
        return String(tagName).toLowerCase() === "video"
            ? new FakeVideo(this)
            : new FakeElement(this, tagName);
    }

    getElementById(id) {
        for (const el of this.documentElement.walk()) {
            if (el.id === id) {
                return el;
            }
        }

        return null;
    }

    querySelector() { return null; }

    // Compound selectors joined by descendant combinators (".filmstrip video").
    querySelectorAll(selector) {
        const parts = String(selector).trim().split(/\s+/);
        const last = parts.pop();

        return [...this.documentElement.walk()].filter(el => {
            if (!el._matches(last)) {
                return false;
            }

            let pending = parts.length - 1;

            for (let node = el.parentNode; node && pending >= 0; node = node.parentNode) {
                if (node._matches(parts[pending])) {
                    pending -= 1;
                }
            }

            return pending < 0;
        });
    }

    // childList records, for observers with { childList } (and subtree).
    _notifyChildList(target, addedNodes, removedNodes) {
        this._observers.forEach(observer => observer._maybeQueueChildList({
            type: "childList", target, addedNodes, removedNodes
        }));
    }

    addEventListener(type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
    }

    removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] || []).filter(other => other !== fn);
    }

    _notifyMutation(target, attribute) {
        this._observers.forEach(observer => observer._maybeQueue(target, attribute));
    }
}

function makeResizeObserverClass(doc) {
    return class ResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.targets = new Set();
            doc._resizeObservers.push(this);
        }

        observe(target) { this.targets.add(target); }
        unobserve(target) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); }
    };
}

function makeMutationObserverClass(doc) {
    return class MutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.targets = [];
            this.queued = false;
            doc._observers.push(this);
        }

        observe(target, options) {
            this.targets.push({
                target,
                filter: options?.attributeFilter || null,
                attributes: Boolean(options?.attributes || options?.attributeFilter),
                childList: Boolean(options?.childList),
                subtree: Boolean(options?.subtree)
            });
        }

        disconnect() {
            this.targets = [];
            this.records = [];
        }

        // Observed with childList (not disconnected).
        get watchesChildList() {
            return this.targets.some(entry => entry.childList);
        }

        _queue(record) {
            if (record) {
                (this.records = this.records || []).push(record);
            }

            if (!this.queued) {
                this.queued = true;
                queueMicrotask(() => {
                    const records = this.records || [];

                    this.queued = false;
                    this.records = [];
                    this.callback(records);
                });
            }
        }

        _maybeQueue(target, attribute) {
            const hit = this.targets.some(entry => entry.attributes
                && entry.target === target && (!entry.filter || entry.filter.includes(attribute)));

            if (hit) {
                this._queue(null);
            }
        }

        _maybeQueueChildList(record) {
            const hit = this.targets.some(entry => entry.childList
                && (entry.target === record.target || (entry.subtree && entry.target.contains(record.target))));

            if (hit) {
                this._queue(record);
            }
        }
    };
}

// ---- Jitsi model -----------------------------------------------------------

function makeJitsiTrack(owner, sourceName, harness) {
    const listeners = new Map();
    const track = {
        owner,
        sourceName,
        status: "inactive",
        stream: null,
        attach(element) {
            element.srcObject = track.stream;

            return Promise.resolve();
        },
        detach(element) {
            if (element && element.srcObject === track.stream) {
                element.srcObject = null;
            }
        },
        getTrackStreamingStatus() {
            return track.status;
        },
        getSourceName() {
            return track.sourceName;
        },
        on(event, fn) {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }

            listeners.get(event).add(fn);
        },
        off(event, fn) {
            listeners.get(event)?.delete(fn);
        },
        listenerCount(event = STATUS_EVENT) {
            return listeners.get(event)?.size || 0;
        },
        setStatus(status) {
            if (track.status !== status) {
                track.status = status;
                Array.from(listeners.get(STATUS_EVENT) || []).forEach(fn => fn(track, status));
            }
        }
    };

    track.stream = { track };

    if (!harness.streamingStatusApi) {
        delete track.getTrackStreamingStatus;
    }

    return track;
}

function createHarness(options = {}) {
    const timers = new FakeTimers();
    const doc = new FakeDocument();
    const warnings = [];
    const posted = [];
    const parent = { postMessage(message) { posted.push(message); } };

    const harness = {
        timers,
        document: doc,
        warnings,
        posted,
        // false: a Jitsi build without track streaming status.
        streamingStatusApi: options.streamingStatusApi !== false,
        // Constraints as the receive policy handed them to lib-jitsi-meet.
        sent: [],
        // Times Jitsi itself computed and sent constraints.
        jitsiRecomputes: 0,
        // Checks run at the moment constraints reach lib-jitsi-meet.
        onSend: [],
        // The height Jitsi itself asks for its stage (its large video size,
        // capped by the teacher's video-quality setting in real Jitsi).
        stageMaxHeight: 720
    };

    const quietConsole = {
        log() {},
        info() {},
        debug() {},
        warn(...args) { warnings.push(args); },
        error(...args) { warnings.push(args); }
    };

    const windowListeners = {};
    const ctx = {
        console: quietConsole,
        document: doc,
        parent,
        location: { ancestorOrigins: [PARENT_ORIGIN] },
        innerWidth: 1280,
        innerHeight: 800,
        setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
        clearTimeout: id => timers.clear(id),
        setInterval: (fn, ms) => timers.setInterval(fn, ms),
        clearInterval: id => timers.clear(id),
        requestAnimationFrame: fn => timers.setTimeout(fn, 16),
        cancelAnimationFrame: id => timers.clear(id),
        queueMicrotask,
        URL,
        Blob,
        MutationObserver: makeMutationObserverClass(doc),
        ResizeObserver: makeResizeObserverClass(doc),
        MouseEvent: class { constructor(type) { this.type = type; } },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        getComputedStyle: () => ({ visibility: "visible", bottom: "0px" }),
        addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            windowListeners[type] = (windowListeners[type] || []).filter(other => other !== fn);
        },
        dispatchEvent(event) {
            (windowListeners[event.type] || []).slice().forEach(fn => fn(event));

            return true;
        }
    };

    ctx.window = ctx;
    ctx.self = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(CUSTOM_JS, "utf8"), ctx, { filename: "custom.js" });

    // ---- Store / conference / limiter -----------------------------------

    const controller = {
        limited: false,
        limitedLastN: 0,
        sentLastN: -1,
        getLastN() { return controller.limited ? controller.limitedLastN : controller.sentLastN; },
        isLastNLimitedByCpu() { return controller.limited; }
    };

    function makeConference() {
        const conference = {
            options: { config: { channelLastN: 5 } },
            qualityController: { receiveVideoController: controller },
            setReceiverConstraints(constraints) {
                harness.sent.push(constraints);
                controller.sentLastN = constraints?.lastN ?? -1;
                harness.onSend.forEach(check => check(constraints));
            }
        };

        return conference;
    }

    const participants = {
        local: { id: "teacher01", role: "moderator", name: "Teacher" },
        remote: new Map(),
        pinnedParticipant: null
    };
    const state = {
        "features/base/participants": participants,
        "features/base/tracks": [],
        "features/large-video": { participantId: null },
        "features/video-layout": { remoteScreenShares: [] },
        "features/base/conference": { conference: makeConference() }
    };
    const subscribers = [];

    function notify() {
        subscribers.slice().forEach(fn => fn());
    }

    // Jitsi's own receiver constraints: its stage at full height, its lastN.
    function jitsiConstraints(overrides = {}) {
        const stageId = state["features/large-video"].participantId;
        const stageSource = stageId && stageId !== participants.local.id
            ? (cameraSourceOf(stageId) || stageId)
            : null;

        return {
            lastN: 5,
            onStageSources: stageSource ? [stageSource] : [],
            selectedSources: [],
            constraints: stageSource ? { [stageSource]: { maxHeight: harness.stageMaxHeight } } : {},
            defaultConstraints: { maxHeight: 180 },
            ...overrides
        };
    }

    function jitsiRecompute(overrides) {
        harness.jitsiRecomputes += 1;
        conference().setReceiverConstraints(jitsiConstraints(overrides));
    }

    const store = {
        getState: () => state,
        subscribe(fn) {
            subscribers.push(fn);

            return () => subscribers.splice(subscribers.indexOf(fn), 1);
        },
        dispatch(action) {
            if (action.type === "PIN_PARTICIPANT") {
                participants.pinnedParticipant = action.participant?.id ?? null;
                state["features/large-video"].participantId = participants.pinnedParticipant;
            } else if (action.type === "SELECT_LARGE_VIDEO_PARTICIPANT") {
                state["features/large-video"].participantId = action.participantId;
            }

            // options.jitsiRecomputesFirst: Jitsi's own constraint update runs
            // before the other store subscribers (custom.js's view), the
            // other possible order in real Jitsi.
            if (options.jitsiRecomputesFirst) {
                jitsiRecompute();
                notify();
            } else {
                notify();
                jitsiRecompute();
            }

            return action;
        }
    };

    ctx.APP = {
        store,
        conference: { getMyUserId: () => participants.local.id },
        UI: { getLargeVideoID: () => state["features/large-video"].participantId, updateLargeVideo() {} }
    };

    function conference() {
        return state["features/base/conference"].conference;
    }

    function cameraSourceOf(participantId) {
        const video = participants.remote.get(participantId)?.sources?.get("video");

        if (!video) {
            return null;
        }

        for (const [sourceName, info] of video) {
            if (info.videoType === "camera") {
                return sourceName;
            }
        }

        return null;
    }

    // ---- Harness API ------------------------------------------------------

    Object.assign(harness, {
        ctx,
        state,
        store,
        controller,
        participants,
        conference,
        jitsiRecompute,
        cameraSourceOf,

        // Meeting left / ended (null), or a new conference object (rejoin).
        setConference(next) {
            state["features/base/conference"] = { conference: next };
        },
        newConference: () => makeConference(),

        rotation: () => vm.runInContext("slTeacherRotation", ctx),
        teacherTest: () => ctx.__slTeacherViewTest,
        receiveTest: () => ctx.__slTeacherReceiveTest,

        // A store change: subscribers run, then Jitsi recomputes its
        // constraints (as its middleware does on most changes).
        change({ recompute = true } = {}) {
            notify();

            if (recompute) {
                jitsiRecompute();
            }
        },

        postFromParent(data) {
            (windowListeners.message || []).slice().forEach(fn =>
                fn({ source: parent, origin: PARENT_ORIGIN, data }));
        },

        addParticipant(id, { role = "participant", camera = true, name } = {}) {
            const sourceName = id + "-v0";

            participants.remote.set(id, {
                id,
                name: name || id,
                role,
                sources: new Map([["video", new Map([[sourceName, { videoType: "camera", muted: !camera }]])]])
            });
            state["features/base/tracks"].push({
                participantId: id,
                videoType: "camera",
                muted: !camera,
                local: false,
                jitsiTrack: makeJitsiTrack(id, sourceName, harness)
            });
        },

        removeParticipant(id) {
            participants.remote.delete(id);
            state["features/base/tracks"] = state["features/base/tracks"].filter(track => track.participantId !== id);
        },

        setCamera(id, on) {
            const info = participants.remote.get(id).sources.get("video").get(id + "-v0");

            info.muted = !on;
            harness.trackOf(id).muted = !on;
        },

        // { staged: true }: also the share's virtual participant and Jitsi's
        // remoteScreenShares list, so the stage policy pins it as in Jitsi.
        addScreenShare(ownerId, { staged = false } = {}) {
            const sourceName = ownerId + "-v1";

            participants.remote.get(ownerId).sources.get("video").set(sourceName, { videoType: "desktop", muted: false });

            if (staged) {
                participants.remote.set(sourceName, {
                    id: sourceName,
                    name: ownerId + " (screen)",
                    fakeParticipant: true
                });
                state["features/video-layout"].remoteScreenShares.push(sourceName);
            }

            return sourceName;
        },

        trackOf(id) {
            return state["features/base/tracks"].find(track => track.participantId === id && track.videoType === "camera");
        },

        // SSRC rewriting: a track (and its stream) is re-mapped to another
        // participant, as lib-jitsi-meet does when the bridge re-uses an SSRC.
        remapTrack(fromId, toId) {
            const track = harness.trackOf(fromId);
            const old = harness.trackOf(toId);

            state["features/base/tracks"] = state["features/base/tracks"].filter(other => other !== old);
            track.participantId = toId;
            track.jitsiTrack.owner = toId;
            track.jitsiTrack.sourceName = toId + "-v0";
            track.muted = false;
        },

        // MOCK bridge + decoder: forwards the first lastN selected sources
        // (lib-jitsi-meet's limited lastN while it limits), sets every
        // camera track's streaming status, and gives each PLAYING video the
        // current owner's frame. Paused videos keep what they show.
        deliver() {
            const last = harness.sent[harness.sent.length - 1];
            let forwarded = [];

            if (last && Array.isArray(last.selectedSources) && last.lastN !== 0) {
                const lastN = controller.limited
                    ? Math.min(controller.limitedLastN, last.lastN)
                    : last.lastN;

                forwarded = last.selectedSources.slice(0, lastN < 0 ? undefined : lastN);
            }

            state["features/base/tracks"].forEach(track => {
                if (track.videoType === "camera" && !track.local) {
                    track.jitsiTrack.setStatus(!track.muted && forwarded.includes(track.jitsiTrack.sourceName)
                        ? "active"
                        : "inactive");
                }
            });

            doc._videos.forEach(video => {
                const stream = video.srcObject;
                const track = stream?.track;

                if (!video.paused && track && track.status === "active") {
                    const first = !video.shownOwner;

                    video.shownOwner = track.owner;

                    if (first) {
                        video.dispatchEvent({ type: "loadeddata" });
                    }
                }
            });
        },

        tile(id) {
            for (const el of doc.documentElement.walk()) {
                if (el.dataset && el.dataset.tileId === id) {
                    return {
                        el,
                        video: el.children[0],
                        chip: el.children.find(child => child.classList.contains("sl-tv-frozen-chip")) || null
                    };
                }
            }

            return null;
        },

        tileModes: () => ctx.__slTeacherViewTest.tileModes(),

        // ---- Tiles view --------------------------------------------------

        tilesState: () => ctx.__slTeacherViewTest.tiles(),

        // Sends the Tiles view as the parent page does, paged by the app's
        // own paging module (components/Jitsi/teacher-tiles-paging.mjs).
        async sendTiles({ layout = "tiles", ids = [], pageSize = 20, pageIndex = 0 } = {}) {
            const paging = await loadPaging();
            const page = paging.computeTilesPage({ ids, pageSize, requestedPageIndex: pageIndex });

            harness.tilesEpoch = (harness.tilesEpoch || 0) + 1;
            harness.postFromParent({
                type: "SL_TEACHER_TILES",
                v: 1,
                epoch: harness.tilesEpoch,
                layout,
                participantIds: page.pageIds,
                page: page.page,
                pageCount: page.pageCount,
                rangeStart: page.rangeStart,
                rangeEnd: page.rangeEnd,
                total: page.total,
                pageSize: paging.isTeacherTilesPageSize(pageSize) ? pageSize : paging.DEFAULT_TEACHER_TILES_PAGE_SIZE
            });
            await harness.flush();
            await harness.flush();

            return page;
        },

        // The Tiles grid changes size (window, panel, chat): its ResizeObserver
        // fires, as in a browser.
        async resizeGrid(width, height) {
            doc._gridSize = { width, height };
            doc._resizeObservers.forEach(observer => {
                observer.targets.forEach(target => {
                    if (target.classList && target.classList.contains("sl-tv-grid")) {
                        observer.callback([]);
                    }
                });
            });
            await harness.flush();
            await harness.flush();
        },

        // Intervals currently scheduled for a function name, with their period.
        intervals: name => Array.from(timers.tasks.values())
            .filter(task => task.every && task.fn.name === name)
            .map(task => task.every),

        lastSent: () => harness.sent[harness.sent.length - 1] || null,

        // Microtasks (renders scheduled with Promise.then) run.
        flush: () => new Promise(resolve => setImmediate(resolve)),

        // Joins as the teacher with the teacher view on (Normal mode).
        async startTeacher({ enabled = true } = {}) {
            timers.advance(600);
            harness.change();
            harness.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 1, enabled });
            harness.change();
            timers.advance(0);
            await harness.flush();
            harness.deliver();
            await harness.flush();
        },

        // Advances time in steps, letting the mock bridge deliver each step.
        async run(ms, step = 1000) {
            for (let elapsed = 0; elapsed < ms; elapsed += step) {
                timers.advance(step);
                await harness.flush();
                harness.deliver();
                await harness.flush();
            }
        }
    });

    return harness;
}

let pagingModule = null;

// The app's paging module (ES module), loaded once.
async function loadPaging() {
    if (!pagingModule) {
        pagingModule = await import(pathToFileURL(
            path.join(__dirname, "..", "..", "components", "Jitsi", "teacher-tiles-paging.mjs")).href);
    }

    return pagingModule;
}

// ---- Direct scheduler access (no DOM) --------------------------------------

// The real slTeacherRotation from custom.js, driven with plain store states.
function createScheduler() {
    const harness = createHarness();
    const rotation = harness.rotation();
    const conference = {};

    // No Jitsi store: setCpuCameraBudget's deferred update must not run
    // against the harness's own (empty) store.
    harness.ctx.APP = undefined;

    rotation.setAutoTick(false);
    rotation.setActive(true);

    // Fake store state: ids in join order; options.off (camera off),
    // options.moderators (co-teachers).
    function stateFor(ids, opts = {}) {
        const remote = new Map();

        ids.forEach(id => remote.set(id, {
            role: (opts.moderators || []).includes(id) ? "moderator" : "participant",
            sources: new Map([["video", new Map([[id + "-v0", {
                videoType: "camera",
                muted: (opts.off || []).includes(id)
            }]])]])
        }));

        return {
            "features/base/participants": { local: { id: "teacher01" }, remote },
            "features/base/conference": { conference }
        };
    }

    return {
        rotation,
        stateFor,
        // Sets the CPU budget and applies it (setCpuCameraBudget defers its
        // update to a timer; the update is run here directly).
        setBudget(budget, state) {
            rotation.setCpuCameraBudget(budget);
            harness.timers.advance(0);
            rotation.update(state);
        }
    };
}

const ids = (count, prefix = "stud") =>
    Array.from({ length: count }, (_, index) => prefix + String(index).padStart(3, "0"));

module.exports = { createHarness, createScheduler, ids, loadPaging, STATUS_EVENT };
