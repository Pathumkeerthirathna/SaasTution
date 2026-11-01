/*
 * Teacher tab-close detection, end to end:
 *
 * - components/Jitsi/teacher-departure-signal.ts (the classroom page): register
 *   once on load, a heartbeat every 10 s while alive (stopped at pagehide), a
 *   closing signal on pagehide (not persisted) from DESKTOP browsers only, a
 *   resume on pageshow (persisted); nothing on visibility changes, network
 *   loss or a frozen / backgrounded page.
 * - lib/browser-form-factor.ts: desktop vs mobile detection.
 * - POST /api/sessions/[id]/teacher-departure/signal: the class's own teacher
 *   only, same-origin only, active session only; a closing signal only from
 *   the current (newest registered) page; mobile requests, duplicates and
 *   stale pages change nothing.
 * - The 15 s reload-confirmation window, through the real live-updates route
 *   and the sweep.
 *
 * What is tested is what the implementation guarantees: IF the browser
 * delivers the current page's closing signal, the features stop once no live
 * classroom page shows up within 15 s; WITHOUT a delivered signal nothing is
 * ever stopped. Browsers do not guarantee pagehide / sendBeacon delivery
 * (crashes, mobile tab kills): no test assumes they do.
 *
 *   npm run test:youtube
 *
 * Real routes, presence, lifecycle and sweep against youtube-fakes.cjs.
 * Nothing here contacts YouTube, Jibri or a database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fakes = require("./youtube-fakes.cjs");

const { TEACHER, LECTURE, CLASS, db, session, reset, teacherPage, quiet, active } = fakes;

const root = path.resolve(__dirname, "..", "..");
const signalRoute = require(path.join(root, "app/api/sessions/[id]/teacher-departure/signal/route.ts"));
const liveUpdates = require(path.join(root, "app/api/sessions/[id]/live-updates/route.ts"));
const sweep = require(path.join(root, "lib/teacher-departure-sweep.ts"));
const presence = require(path.join(root, "lib/teacher-presence.ts"));
const formFactor = require(path.join(root, "lib/browser-form-factor.ts"));
const browser = require(path.join(root, "components/Jitsi/teacher-departure-signal.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const CONFIRM_MS = 15_000;

// ---- Helpers --------------------------------------------------------------

const currentSession = () => db.sessions.find(s => s.lectureId === LECTURE && s.isActive);

const SAME_ORIGIN = { origin: "http://localhost", host: "localhost" };

const UA = {
    windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ipadOld: "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1"
};

// POSTs a signal to the real route (text/plain JSON, as the page sends it).
async function postSignal(body, { sessionId = currentSession().id, headers = SAME_ORIGIN } = {}) {
    const response = await signalRoute.POST(
        new Request("http://localhost/api/sessions/" + sessionId + "/teacher-departure/signal", {
            method: "POST",
            headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body)
        }),
        { params: { id: sessionId } }
    );

    return { status: response.status, body: await response.json() };
}

const register = pageId => postSignal({ kind: "register", pageId });

// The features were started a while before anything else in the test.
function startedEarlier() {
    for (const row of [...db.lives, ...db.recordings]) row.createdAt = row.generationStartedAt = new Date(Date.now() - 10 * 60_000);
}

// \`ms\` pass: the recorded signal / activity move into the past.
function elapse(ms) {
    const s = currentSession();

    for (const key of ["teacherDepartureAt", "teacherActiveAfterDepartureAt"]) {
        if (s[key]) s[key] = new Date(s[key].getTime() - ms);
    }
}

const sweepNow = () => quiet(() => sweep.sweepDepartedTeachers(new Date()));

// A fake window: lifecycle events, as the browser dispatches them.
function fakeWindow() {
    const target = new EventTarget();

    return {
        target,
        pagehide: persisted => target.dispatchEvent(Object.assign(new Event("pagehide"), { persisted })),
        pageshow: persisted => target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted })),
        fire: type => target.dispatchEvent(new Event(type))
    };
}

// A classroom page: the real browser module, its signals delivered to the
// real route in-process. deliverClosing: false = the beacon never arrives.
// tick() = the heartbeat timer firing (if it is still running).
function classroomPage({ isDesktop = true, deliverClosing = true } = {}) {
    const win = fakeWindow();
    const pageId = browser.createPageId();
    const sent = [];
    const deliveries = [];
    const timers = new Map();
    let nextTimer = 1;
    const deliver = body => deliveries.push(postSignal(body));
    const uninstall = browser.installTeacherDepartureSignal({
        sessionId: currentSession().id,
        pageId,
        target: win.target,
        isDesktop,
        send: (url, body) => {
            sent.push({ url, ...body });
            if (deliverClosing) deliver(body);
            return true;
        },
        post: (url, body) => {
            sent.push({ url, ...body });
            deliver(body);
        },
        setInterval: (fn, ms) => {
            assert.equal(ms, 10_000, "heartbeat every 10 s");
            timers.set(nextTimer, fn);
            return nextTimer++;
        },
        clearInterval: id => timers.delete(id)
    });

    return {
        ...win,
        pageId,
        sent,
        kinds: () => sent.map(s => s.kind),
        tick: () => timers.forEach(fn => fn()),
        heartbeatRunning: () => timers.size > 0,
        settled: () => Promise.all(deliveries),
        uninstall
    };
}

// The page's live-updates connection (real route); close() drops it.
async function connectLiveUpdates(pageId) {
    const abort = new AbortController();
    const url = "http://localhost/api/sessions/" + currentSession().id + "/live-updates?role=teacher" + (pageId ? "&pageId=" + pageId : "");
    const response = await liveUpdates.GET(new Request(url, { signal: abort.signal }), { params: { id: currentSession().id } });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response.status, 200);

    return { close: async () => { abort.abort(); await new Promise(resolve => setImmediate(resolve)); } };
}

function asStudent(fn) {
    const auth = require.cache[path.join(root, "lib/auth-session.ts")].exports;
    const saved = auth.requireTeacherSession;

    auth.requireTeacherSession = async () => {
        throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    };

    return Promise.resolve().then(fn).finally(() => {
        auth.requireTeacherSession = saved;
    });
}

function withNavigator(value, fn) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");

    Object.defineProperty(globalThis, "navigator", { configurable: true, value });

    try {
        return fn();
    } finally {
        if (saved) Object.defineProperty(globalThis, "navigator", saved);
        else delete globalThis.navigator;
    }
}

// ---- Desktop / mobile detection ----------------------------------------------------------

test("detection: desktop browsers are desktop; phones, tablets and iPadOS desktop mode are not; unknown is not", () => {
    const desktop = nav => formFactor.isDesktopBrowser(nav);

    assert.equal(desktop({ userAgent: UA.windowsChrome, platform: "Win32", maxTouchPoints: 0, userAgentData: { mobile: false } }), true);
    assert.equal(desktop({ userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 0 }), true);
    assert.equal(desktop({ userAgent: UA.linuxFirefox, platform: "Linux x86_64", maxTouchPoints: 0 }), true);
    assert.equal(desktop({ userAgent: UA.windowsChrome, platform: "Win32", maxTouchPoints: 10 }), true, "touch-screen laptop");
    assert.equal(desktop({ userAgent: UA.chromebook, platform: "Linux x86_64", maxTouchPoints: 10 }), true, "Chromebook");

    assert.equal(desktop({ userAgent: UA.androidChrome, platform: "Linux armv8l", maxTouchPoints: 5, userAgentData: { mobile: true } }), false);
    assert.equal(desktop({ userAgent: UA.androidTablet, platform: "Linux armv8l", maxTouchPoints: 5 }), false, "Android tablet");
    assert.equal(desktop({ userAgent: UA.iphoneSafari, platform: "iPhone", maxTouchPoints: 5 }), false);
    assert.equal(desktop({ userAgent: UA.ipadOld, platform: "iPad", maxTouchPoints: 5 }), false);
    assert.equal(desktop({ userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 5 }), false, "iPadOS reports a Mac");
    assert.equal(desktop({ userAgent: UA.windowsChrome, platform: "Win32", userAgentData: { mobile: true } }), false, "Client Hint wins");
    assert.equal(desktop(null), false);
    assert.equal(desktop({ userAgent: "" }), false);

    const headers = h => new Headers(h);

    assert.equal(formFactor.isMobileRequest(headers({ "sec-ch-ua-mobile": "?1", "user-agent": UA.windowsChrome })), true);
    assert.equal(formFactor.isMobileRequest(headers({ "user-agent": UA.iphoneSafari })), true);
    assert.equal(formFactor.isMobileRequest(headers({ "sec-ch-ua-mobile": "?0", "user-agent": UA.windowsChrome })), false);
});

test("page on a mobile browser: registers and sends heartbeats, never a closing signal (detected from navigator by default)", () => {
    reset();

    // isDesktop not given: the module reads navigator itself.
    for (const nav of [
        { userAgent: UA.iphoneSafari, platform: "iPhone", maxTouchPoints: 5 },
        { userAgent: UA.androidChrome, platform: "Linux armv8l", maxTouchPoints: 5, userAgentData: { mobile: true } },
        { userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 5 }
    ]) {
        const win = fakeWindow();
        const sent = [];

        withNavigator(nav, () => browser.installTeacherDepartureSignal({
            sessionId: "s-1", pageId: "page-12345678", target: win.target,
            send: (_url, body) => { sent.push(body.kind); return true; },
            post: (_url, body) => sent.push(body.kind),
            setInterval: () => 1, clearInterval: () => {}
        }));

        win.pagehide(false);
        win.pagehide(false);
        assert.deepEqual(sent, ["register"], nav.userAgent);
    }

    const win = fakeWindow();
    const sent = [];

    withNavigator({ userAgent: UA.windowsChrome, platform: "Win32", maxTouchPoints: 0 }, () => browser.installTeacherDepartureSignal({
        sessionId: "s-1", pageId: "page-12345678", target: win.target,
        send: (_url, body) => { sent.push(body.kind); return true; },
        post: (_url, body) => sent.push(body.kind),
        setInterval: () => 1, clearInterval: () => {}
    }));
    win.pagehide(false);
    assert.deepEqual(sent, ["register", "closing"], "desktop: closing");
});

test("server: a closing signal from a mobile browser is ignored even if one arrives", async () => {
    reset();
    await register("page-aaaaaaaa");

    for (const headers of [
        { ...SAME_ORIGIN, "sec-ch-ua-mobile": "?1" },
        { ...SAME_ORIGIN, "user-agent": UA.iphoneSafari },
        { ...SAME_ORIGIN, "user-agent": UA.androidChrome }
    ]) {
        const { status, body } = await postSignal({ kind: "closing", pageId: "page-aaaaaaaa" }, { headers });

        assert.equal(status, 200);
        assert.deepEqual(body.data, { accepted: false, reason: "mobile-browser" });
    }

    assert.equal(currentSession().teacherDepartureAt ?? null, null);
});

// ---- The classroom page (browser module) ---------------------------------------------

test("page: registers once, a heartbeat every 10 s while alive, none after pagehide; closing once (desktop)", () => {
    reset();
    const page = classroomPage();

    assert.deepEqual(page.kinds(), ["register"]);
    page.tick();
    page.tick();
    assert.deepEqual(page.kinds(), ["register", "heartbeat", "heartbeat"]);

    page.pagehide(false);
    page.pagehide(false);
    page.tick();

    assert.deepEqual(page.kinds(), ["register", "heartbeat", "heartbeat", "closing"]);
    assert.equal(page.heartbeatRunning(), false, "a page going away never cancels anything");
    assert.equal(page.sent[3].url, "/api/sessions/" + currentSession().id + "/teacher-departure/signal");
});

test("page: nothing on bfcache entry, visibility changes, freezing, blur or going offline (app switching, Wi-Fi)", () => {
    reset();
    const page = classroomPage();

    for (const type of ["visibilitychange", "freeze", "blur", "offline", "online", "resume"]) page.fire(type);
    page.pagehide(true);
    page.pageshow(false);

    assert.deepEqual(page.kinds(), ["register"]);
});

test("page: bfcache return restarts the heartbeat and sends resume after a closing signal; the YouTube reconnect sends nothing", () => {
    reset();
    const page = classroomPage();

    page.pagehide(true);
    assert.equal(page.heartbeatRunning(), false);
    page.pageshow(true);
    assert.equal(page.heartbeatRunning(), true);
    assert.deepEqual(page.kinds(), ["register", "heartbeat"], "back from the cache: activity, nothing to withdraw");

    page.pagehide(false);
    page.pageshow(true);
    assert.deepEqual(page.kinds().slice(2), ["closing", "resume"]);

    browser.suppressNextDepartureSignal();
    page.pagehide(false);
    assert.equal(page.kinds().length, 4, "away to Google and back: suppressed once");
    page.pagehide(false);
    assert.equal(page.kinds()[4], "closing");

    page.uninstall();
    page.pageshow(true);
    page.pagehide(false);
    page.tick();
    assert.equal(page.kinds().length, 5, "nothing after leaving the classroom in-app");
});

test("page: a closing signal the browser refused is tried again on the next pagehide", () => {
    const win = fakeWindow();
    const sent = [];
    let accept = false;

    browser.installTeacherDepartureSignal({
        sessionId: "s-1", pageId: "page-12345678", target: win.target, isDesktop: true,
        send: (_url, body) => { sent.push(body.kind); return accept; },
        post: () => {}, setInterval: () => 1, clearInterval: () => {}
    });

    win.pagehide(false);
    accept = true;
    win.pagehide(false);
    win.pagehide(false);
    assert.deepEqual(sent, ["closing", "closing"]);
});

test("page: sendBeacon with a text/plain JSON body; fetch keepalive when sendBeacon is missing or refuses", async () => {
    const savedFetch = globalThis.fetch;
    const beacons = [];
    const fetches = [];
    let beaconAccepts = true;

    globalThis.fetch = (url, init) => { fetches.push({ url, init }); return Promise.resolve(new Response("{}")); };

    try {
        await withNavigator({ sendBeacon: (url, blob) => { beacons.push({ url, blob }); return beaconAccepts; } }, async () => {
            assert.equal(browser.sendDepartureSignal("/x", { kind: "closing", pageId: "page-12345678" }), true);
            assert.equal(beacons.length, 1);
            assert.equal(beacons[0].blob.type, "text/plain;charset=utf-8");
            assert.deepEqual(JSON.parse(await beacons[0].blob.text()), { kind: "closing", pageId: "page-12345678" });
            assert.equal(fetches.length, 0);

            beaconAccepts = false;
            assert.equal(browser.sendDepartureSignal("/x", { kind: "closing", pageId: "page-12345678" }), true);
            assert.equal(fetches.length, 1);
            assert.equal(fetches[0].init.keepalive, true);
            assert.equal(fetches[0].init.credentials, "same-origin");
        });
    } finally {
        globalThis.fetch = savedFetch;
    }
});

test("page: page IDs are random and accepted by the server; heartbeat interval matches the server's", () => {
    const ids = new Set(Array.from({ length: 50 }, () => browser.createPageId()));

    assert.equal(ids.size, 50);
    for (const id of ids) assert.equal(presence.isValidPageId(id), true, id);
    assert.equal(presence.isValidPageId("short"), false);
    assert.equal(presence.isValidPageId("bad id with spaces"), false);
    assert.equal(browser.TEACHER_HEARTBEAT_MS, presence.TEACHER_PRESENCE_REFRESH_MS);
});

// ---- The signal endpoint ------------------------------------------------------------------

test("endpoint: a registered page's closing signal is recorded as pending only; nothing stops during the window", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    startedEarlier();

    assert.deepEqual((await register("page-aaaaaaaa")).body.data, { registered: true });
    assert.equal(currentSession().teacherCurrentPageId, "page-aaaaaaaa");

    const { status, body } = await postSignal({ kind: "closing", pageId: "page-aaaaaaaa" });

    assert.equal(status, 200);
    assert.deepEqual(body.data, { accepted: true });
    assert.equal(currentSession().teacherDeparturePageId, "page-aaaaaaaa");

    assert.deepEqual((await sweepNow())[0].result, { status: "skipped", reason: "departure-pending" });
    assert.equal(active(db.lives).length, 1);
    assert.equal(currentSession().isActive, true);
});

test("endpoint: a page that never registered cannot start a departure", async () => {
    reset();

    const { body } = await postSignal({ kind: "closing", pageId: "page-unknown" });

    assert.deepEqual(body.data, { accepted: false, reason: "stale-page" });
    assert.equal(currentSession().teacherDepartureAt ?? null, null);
});

test("stale page: an old page's beacon arriving after a newer page registered changes nothing", async () => {
    reset();
    await register("page-old-11");
    await register("page-new-22");

    const late = await postSignal({ kind: "closing", pageId: "page-old-11" });

    assert.deepEqual(late.body.data, { accepted: false, reason: "stale-page" });
    assert.equal(currentSession().teacherDepartureAt ?? null, null, "no departure window started");
    assert.equal(currentSession().teacherCurrentPageId, "page-new-22", "the current page is untouched");

    // The same old page's heartbeat or resume cannot make it current either.
    await postSignal({ kind: "heartbeat", pageId: "page-old-11" });
    await postSignal({ kind: "resume", pageId: "page-old-11" });
    assert.equal(currentSession().teacherCurrentPageId, "page-new-22");
    assert.deepEqual((await postSignal({ kind: "closing", pageId: "page-old-11" })).body.data, { accepted: false, reason: "stale-page" });

    // The current page's own close is accepted.
    assert.deepEqual((await postSignal({ kind: "closing", pageId: "page-new-22" })).body.data, { accepted: true });
});

test("stale page: a refreshed page's late duplicate beacon cannot re-open its cancelled signal", async () => {
    reset();
    await register("page-aaaaaaaa");
    await postSignal({ kind: "closing", pageId: "page-aaaaaaaa" });

    const firstAt = currentSession().teacherDepartureAt.getTime();

    elapse(2_000);
    assert.deepEqual((await postSignal({ kind: "closing", pageId: "page-aaaaaaaa" })).body.data, { accepted: false, reason: "duplicate" });
    assert.equal(currentSession().teacherDepartureAt.getTime(), firstAt - 2_000, "the window is not restarted");

    await register("page-bbbbbbbb");
    assert.ok(currentSession().teacherActiveAfterDepartureAt, "cancelled by the new page");
    assert.deepEqual((await postSignal({ kind: "closing", pageId: "page-aaaaaaaa" })).body.data, { accepted: false, reason: "stale-page" });
    assert.ok(currentSession().teacherActiveAfterDepartureAt, "still cancelled");
});

test("endpoint: a stale session (ended, replaced, unknown) is refused and never touched", async () => {
    reset();
    const old = currentSession();

    old.teacherCurrentPageId = "page-aaaaaaaa";
    old.isActive = false;
    old.endedAt = new Date();
    db.sessions.push({
        id: "session-new", classId: CLASS, lectureId: LECTURE, isActive: true,
        startedAt: new Date(), endedAt: null, teacherId: TEACHER
    });

    for (const kind of ["closing", "register"]) {
        const ended = await quiet(() => postSignal({ kind, pageId: "page-aaaaaaaa" }, { sessionId: old.id }));

        assert.equal(ended.status, 409, kind);
        assert.equal(ended.body.error.code, "SESSION_NOT_ACTIVE");
    }

    assert.equal(old.teacherDepartureAt ?? null, null);
    assert.equal(old.teacherCurrentPageId, "page-aaaaaaaa");
    assert.equal(db.sessions.find(s => s.id === "session-new").teacherDepartureAt ?? null, null, "the new session is unaffected");
    assert.equal((await quiet(() => postSignal({ kind: "closing", pageId: "page-aaaaaaaa" }, { sessionId: "nope" }))).status, 404);
});

test("endpoint: students and other teachers (no assistant role exists) are refused for every kind; nothing changes", async () => {
    reset();
    await register("page-aaaaaaaa");

    for (const kind of ["register", "heartbeat", "closing", "resume"]) {
        await asStudent(async () => {
            assert.equal((await quiet(() => postSignal({ kind, pageId: "page-zzzzzzzz" }))).status, 401, kind);
        });

        session.teacherId = "teacher-2";
        assert.equal((await quiet(() => postSignal({ kind, pageId: "page-zzzzzzzz" }))).status, 404, kind);
        session.teacherId = TEACHER;
    }

    assert.equal(currentSession().teacherCurrentPageId, "page-aaaaaaaa");
    assert.equal(currentSession().teacherDepartureAt ?? null, null);
});

test("endpoint: cross-site requests and bad bodies are refused", async () => {
    reset();
    await register("page-aaaaaaaa");
    const body = { kind: "closing", pageId: "page-aaaaaaaa" };

    assert.equal((await quiet(() => postSignal(body, { headers: { origin: "https://evil.example", host: "localhost" } }))).status, 403);
    assert.equal((await quiet(() => postSignal(body, { headers: { host: "localhost" } }))).status, 403, "no Origin, no Sec-Fetch-Site");
    assert.equal((await quiet(() => postSignal(body, { headers: { origin: "null", host: "localhost" } }))).status, 403);
    assert.equal(currentSession().teacherDepartureAt ?? null, null);

    for (const bad of ["not json", { kind: "closing" }, { kind: "closing", pageId: "x" }, { kind: "leave", pageId: "page-aaaaaaaa" }]) {
        assert.equal((await quiet(() => postSignal(bad))).status, 400, JSON.stringify(bad));
    }

    // Same-origin without an Origin header (Sec-Fetch-Site), and behind a proxy.
    assert.equal((await postSignal(body, { headers: { host: "localhost", "sec-fetch-site": "same-origin" } })).status, 200);
    reset();
    currentSession().teacherCurrentPageId = "page-aaaaaaaa";
    assert.equal((await postSignal(body, {
        headers: { origin: "https://slclassroom.example", host: "internal:3000", "x-forwarded-host": "slclassroom.example" }
    })).status, 200);
});

test("endpoint: resume within the window withdraws the signal; after it, it is the teacher's return", async () => {
    reset();
    await register("page-aaaaaaaa");

    await postSignal({ kind: "closing", pageId: "page-aaaaaaaa" });
    elapse(5_000);
    assert.deepEqual((await postSignal({ kind: "resume", pageId: "page-aaaaaaaa" })).body.data, { cancelled: true, returned: false });
    assert.equal(currentSession().teacherDepartureAt, null);
    assert.equal(currentSession().teacherCurrentPageId, "page-aaaaaaaa", "still the current page");
    assert.deepEqual((await postSignal({ kind: "closing", pageId: "page-aaaaaaaa" })).body.data, { accepted: true });

    elapse(CONFIRM_MS + 5_000);
    assert.deepEqual((await postSignal({ kind: "resume", pageId: "page-aaaaaaaa" })).body.data, { cancelled: false, returned: true });
    assert.equal(presence.departureState(currentSession(), new Date()), "confirmed", "a late return never undoes it");
});

// ---- End to end: page, signal, window, sweep ----------------------------------------------------

test("tab closed: the current page's signal arrives, no page shows up for 15 s, Live and Recording stop; class untouched", async () => {
    reset();
    const teacher = teacherPage();

    await quiet(() => teacher.record());
    await quiet(() => teacher.goLive("unlisted"));
    startedEarlier();

    const page = classroomPage();
    const connection = await connectLiveUpdates(page.pageId);

    await page.settled();
    page.tick();
    page.pagehide(false);
    await connection.close();
    await page.settled();

    assert.deepEqual((await sweepNow())[0].result, { status: "skipped", reason: "departure-pending" });

    elapse(CONFIRM_MS + 1_000);

    const [{ result }] = await sweepNow();

    assert.deepEqual(result.stopped.sort(), ["live", "recording"]);
    assert.equal(db.lives[0].stopReason, "TEACHER_LEFT");
    assert.equal(db.recordings[0].stopReason, "TEACHER_LEFT");
    assert.equal(currentSession().isActive, true, "the class session keeps running");
    assert.deepEqual(db.attendanceCloses, [], "students stay connected");
});

test("refresh within 15 s: the reloaded page registers and cancels the signal; nothing ever stops", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    startedEarlier();

    const before = classroomPage();

    await before.settled();
    before.pagehide(false);
    await before.settled();

    elapse(2_000);
    const after = classroomPage();
    const connection = await connectLiveUpdates(after.pageId);

    await after.settled();
    assert.equal(currentSession().teacherCurrentPageId, after.pageId);

    elapse(10 * 60_000);
    assert.deepEqual((await sweepNow())[0].result, { status: "skipped", reason: "departure-cancelled" });
    assert.equal(active(db.lives).length, 1);

    await connection.close();
});

test("multiple tabs: closing an older tab does nothing; closing the newest is cancelled by the open one, which can then close", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    startedEarlier();

    const tabA = classroomPage();

    await tabA.settled();
    const tabB = classroomPage();

    await tabB.settled();
    assert.equal(currentSession().teacherCurrentPageId, tabB.pageId, "the newest page is current");

    // Close A (older): refused, nothing pending; B is still open.
    tabA.pagehide(false);
    await tabA.settled();
    assert.equal(currentSession().teacherDepartureAt ?? null, null);

    // Two more tabs: C (briefly in the bfcache), then D, the newest. D closes:
    // pending, until an open tab's heartbeat (C's) cancels it.
    const tabC = classroomPage();

    await tabC.settled();
    tabC.pagehide(true); // C goes into the bfcache briefly: no heartbeats, nothing sent.
    tabC.pageshow(true);
    await tabC.settled();
    const tabD = classroomPage();

    await tabD.settled();
    tabD.pagehide(false);
    await tabD.settled();
    assert.ok(currentSession().teacherDepartureAt, "the current tab's close is pending");

    tabC.tick();
    await tabC.settled();
    assert.equal(presence.departureState(currentSession(), new Date()), "cancelled", "an open tab's heartbeat cancels it");
    assert.equal(currentSession().teacherCurrentPageId, tabC.pageId, "and that tab becomes current");

    // B is still open too; closing C now: B's heartbeat cancels again.
    tabC.pagehide(false);
    await tabC.settled();
    tabB.tick();
    await tabB.settled();
    assert.equal(presence.departureState(currentSession(), new Date()), "cancelled");

    // Finally the last open tab (B) closes: confirmed after the window.
    tabB.pagehide(false);
    await tabB.settled();
    elapse(CONFIRM_MS + 1_000);
    assert.equal((await sweepNow())[0].result.status, "done");
    assert.equal(db.lives[0].stopReason, "TEACHER_LEFT");
});

test("old page heartbeat never cancels a newer departure: a closed page sends none, its lingering connection does not count", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    startedEarlier();

    // Page A is refreshed into page B.
    const pageA = classroomPage();

    await pageA.settled();
    const lingering = await connectLiveUpdates(pageA.pageId);

    pageA.pagehide(false);
    await pageA.settled();

    const pageB = classroomPage();

    await pageB.settled();

    // B closes; A's timer (stopped at pagehide) and A's server connection, which
    // the server has not noticed is gone, both keep quiet.
    pageB.pagehide(false);
    await pageB.settled();
    pageA.tick();
    await pageA.settled();
    await presence.recordTeacherPresence(currentSession().id, new Date());

    assert.deepEqual(pageA.kinds(), ["register", "closing"], "no heartbeat from a page that went away");
    assert.equal(currentSession().teacherActiveAfterDepartureAt, null);
    assert.equal(currentSession().teacherCurrentPageId, pageB.pageId);

    elapse(CONFIRM_MS + 1_000);
    assert.equal((await sweepNow())[0].result.status, "done");
    assert.equal(db.lives[0].stopReason, "TEACHER_LEFT");

    await lingering.close();
});

test("no signal delivered (crash, lost beacon) or none sent (mobile, backgrounding, network loss): nothing ever stops", async () => {
    reset();
    await quiet(() => teacherPage().goLive("unlisted"));
    startedEarlier();

    // The beacon is lost.
    const lost = classroomPage({ deliverClosing: false });

    await lost.settled();
    lost.pagehide(false);
    assert.ok(lost.kinds().includes("closing"));

    // A phone: registered (newest), backgrounded, frozen, its tab closed from the switcher.
    const phone = classroomPage({ isDesktop: false });
    let phoneConnection = await connectLiveUpdates(phone.pageId);

    await phone.settled();
    phone.fire("visibilitychange");
    phone.fire("freeze");
    await phoneConnection.close();
    currentSession().teacherLastSeenAt = new Date(Date.now() - 60 * 60_000);
    phone.fire("resume");
    phoneConnection = await connectLiveUpdates(phone.pageId);
    await phoneConnection.close();
    phone.pagehide(false);
    await phone.settled();

    assert.equal(phone.kinds().includes("closing"), false);
    assert.deepEqual(await sweepNow(), [], "no session has a signal: nothing is even checked");
    assert.equal(active(db.lives).length, 1);
    assert.equal(currentSession().teacherDepartureAt ?? null, null);
});
