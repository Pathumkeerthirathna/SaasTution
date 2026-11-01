/*
 * Room-scoped Jibri stop protocol (lib/jibri-control.ts) against a scripted
 * fake classroom (fake-jitsi-room.cjs): moderator join first, the exact
 * STOP request to the room's focus, confirmation ONLY by the stream
 * recorder leaving, no media, and the connection always closed.
 *
 *   npm run test:youtube
 *
 * No real XMPP connection is made.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createFakeJitsi, sentElements, CONFIG, STUDENT_NAME, STUDENT_JID } = require("./fake-jitsi-room.cjs");

const root = path.resolve(__dirname, "..", "..");
const { createJibriController, xml, NS_JIBRI, NS_DISCO_INFO } = require(path.join(root, "lib/jibri-control.ts"));

const ROOM = "saastution-class001-k9x2ab";
const ROOM_JID = ROOM + "@" + CONFIG.mucDomain;
const NICK = "0a1b2c3d";

function setup(script = {}, limits = {}) {
    const fake = createFakeJitsi(script);
    const controller = createJibriController({
        transport: fake.transport,
        connectTimeoutMs: 200,
        joinTimeoutMs: 200,
        iqTimeoutMs: 100,
        notFoundRecheckMs: 30,
        leaveReserveMs: 20,
        nick: () => NICK,
        ...limits
    });
    return { ...fake, controller };
}

function request(overrides = {}) {
    return {
        websocketUrl: CONFIG.websocketUrl,
        xmppDomain: CONFIG.jitsiDomain,
        mucDomain: CONFIG.mucDomain,
        recorderDomain: CONFIG.recorderDomain,
        focusJid: CONFIG.focusJid,
        roomName: ROOM,
        token: "header.payload.signature",
        deadlineAt: Date.now() + 1_000,
        shouldAbort: async () => false,
        ...overrides
    };
}

const stopIqs = room => room.iqs.filter(iq => iq.children.some(c => c.name === "jibri" && c.attrs.action === "stop"));

function assertCleanedUp(room) {
    assert.equal(room.openSessions, 0, "no connection left open");
    assert.ok(room.closes >= 1, "closed");
}

function assertLeftRoom(room) {
    const leave = room.sent.find(s => s.name === "presence" && s.attrs.type === "unavailable");
    assert.ok(leave, "left the room");
    assert.equal(leave.attrs.to, ROOM_JID + "/" + NICK);
}

// ---- Protocol ---------------------------------------------------------------------

test("STOP is the exact room-scoped request: to <room>@<muc>/focus, jibri action=stop recording_mode=stream; confirmed only when the recorder LEFT", async () => {
    const { room, controller } = setup();
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "recorder-left", JSON.stringify(report));
    assert.equal(report.stopSent, true);

    const stops = stopIqs(room);
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0], {
        name: "iq",
        attrs: { type: "set", to: ROOM_JID + "/focus" },
        children: [{ name: "jibri", attrs: { xmlns: NS_JIBRI, action: "stop", recording_mode: "stream" }, children: [] }]
    });
    assert.equal(room.iqs.length, 1, "no other request of any kind (no generic / global stop)");
    assertLeftRoom(room);
    assertCleanedUp(room);
});

test("targeting: the connection's room, the MUC join and the STOP all name the same classroom (lowercase)", async () => {
    const { room, controller } = setup();
    await controller.stopStreamInRoom(request());

    assert.equal(room.opens.length, 1);
    assert.equal(room.opens[0].room, ROOM);
    assert.equal(room.opens[0].domain, CONFIG.jitsiDomain);
    assert.equal(room.opens[0].websocketUrl, CONFIG.websocketUrl);

    const join = room.sent.find(s => s.name === "presence" && !s.attrs.type);
    assert.equal(join.attrs.to, ROOM_JID + "/" + NICK);
    assert.equal(stopIqs(room)[0].attrs.to, ROOM_JID + "/focus");
    assert.ok(!JSON.stringify(room.sent).includes("breakout."), "never a breakout room");
    for (const s of room.sent) {
        if (s.attrs.to) assert.ok(s.attrs.to.startsWith(ROOM_JID + "/"), "addressed inside the classroom only: " + s.attrs.to);
    }
});

test("join presence: MUC join with NO chat history and the system display name; nothing else", async () => {
    const { room, controller } = setup();
    await controller.stopStreamInRoom(request());

    const join = room.sent.find(s => s.name === "presence" && !s.attrs.type);
    assert.deepEqual(join.children.map(c => c.name).sort(), ["nick", "x"]);
    const x = join.children.find(c => c.name === "x");
    assert.deepEqual(x.children[0], { name: "history", attrs: { maxstanzas: "0" }, children: [] });
    assert.deepEqual(join.children.find(c => c.name === "nick").children, ["SL Classroom System"]);
});

test("no STOP before our own presence confirms the moderator role: joined as participant -> not-moderator, nothing sent", async () => {
    const { room, controller } = setup({ selfRole: "participant" });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "not-moderator");
    assert.equal(report.stopSent, false);
    assert.equal(room.iqs.length, 0);
    assertLeftRoom(room);
    assertCleanedUp(room);
});

test("join refused (error presence) -> join-failed, no STOP", async () => {
    const { room, controller } = setup({ joinError: "not-authorized" });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "join-failed");
    assert.equal(report.detail, "not-authorized");
    assert.equal(room.iqs.length, 0);
    assertCleanedUp(room);
});

test("a nick assigned by the room (status 110) is recognised as our own presence", async () => {
    const { room, controller } = setup({ assignedNick: "server-nick" });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "recorder-left");
    const leave = room.sent.find(s => s.name === "presence" && s.attrs.type === "unavailable");
    assert.equal(leave.attrs.to, ROOM_JID + "/server-nick");
});

test("Jicofo's IQ result alone is NOT confirmation: the recorder never leaves -> unconfirmed (even with focus OFF)", async () => {
    const { room, controller } = setup({ recorderLeaveMs: null, focusOffOnStop: true });
    const report = await controller.stopStreamInRoom(request({ deadlineAt: Date.now() + 200 }));

    assert.equal(report.outcome, "unconfirmed");
    assert.equal(report.stopSent, true);
    assertCleanedUp(room);
});

test("Jicofo's room OFF alone is NOT 'not running': status off but the recorder still in the room -> STOP is sent; confirmed when it leaves", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants();
    occupants[0].focus.status = "off";
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(stopIqs(room).length, 1);
    assert.equal(report.outcome, "recorder-left");
});

test("not running: no stream recorder and no stream session at the focus -> no STOP", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants().filter(o => !o.recorder);
    occupants[0].focus.status = "off";
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "not-running");
    assert.equal(report.stopSent, false);
    assert.equal(room.iqs.length, 0);
    assertCleanedUp(room);
});

test("a FILE recorder (mode file) is not the stream: with no stream session it is never stopped", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants();
    occupants[0].focus = { status: "on", session_id: "file-1", recording_mode: "file" };
    occupants[1].mode = "file";
    occupants[1].sessionId = "file-1";
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "not-running");
    assert.equal(room.iqs.length, 0);
});

test("item-not-found with the recorder still in the room -> stop-error (not 'not running')", async () => {
    const { room, controller } = setup({ stopAnswer: { error: "item-not-found" } });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "stop-error");
    assert.equal(report.detail, "item-not-found");
    assertCleanedUp(room);
});

test("item-not-found: 'not running' only after a FRESH look at the room shows no recorder and no stream session", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants().filter(o => !o.recorder);
    occupants[0].focus.status = "pending"; // a session starting: STOP is sent
    const { room, controller } = setup({ occupants, stopAnswer: { error: "item-not-found" } });

    const run = controller.stopStreamInRoom(request());
    // During the re-check window Jicofo publishes off.
    await new Promise(resolve => setTimeout(resolve, 10));
    const focus = room.occupants[0];
    focus.focus = { ...focus.focus, status: "off" };
    room.sessions[0].deliver(xml("presence", { from: ROOM_JID + "/focus" },
        xml("x", { xmlns: "http://jabber.org/protocol/muc#user" }, xml("item", { jid: focus.jid, role: "moderator" })),
        xml("jibri-recording-status", { xmlns: NS_JIBRI, ...focus.focus })));

    const report = await run;
    assert.equal(stopIqs(room).length, 1);
    assert.equal(report.outcome, "not-running");
});

test("item-not-found while the focus still reports the stream on -> stop-error", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants().filter(o => !o.recorder);
    const { controller } = setup({ occupants, stopAnswer: { error: "item-not-found" } });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "stop-error");
});

test("forbidden and not-allowed -> refused (a configuration problem, backed off by the lifecycle)", async () => {
    for (const condition of ["forbidden", "not-allowed"]) {
        const { room, controller } = setup({ stopAnswer: { error: condition } });
        const report = await controller.stopStreamInRoom(request());

        assert.equal(report.outcome, "refused");
        assert.equal(report.detail, condition);
        assertCleanedUp(room);
    }
});

test("timeouts and disconnects never produce a confirmation", async () => {
    const cases = [
        [{ stopAnswer: "hang" }, "timeout"],
        [{ stopAnswer: "drop" }, "disconnected"],
        [{ dropAt: "after-join" }, "disconnected"],
        [{ connectError: true }, "connect-failed"],
        [{ connectHang: true }, "connect-failed"]
    ];

    for (const [script, expected] of cases) {
        const { room, controller } = setup(script);
        const report = await controller.stopStreamInRoom(request());

        assert.equal(report.outcome, expected, JSON.stringify(script));
        assert.notEqual(report.outcome, "recorder-left");
        assert.equal(room.openSessions, 0, "nothing left open: " + JSON.stringify(script));
    }
});

test("the recorder leaving after the deadline: unconfirmed, connection closed", async () => {
    const { room, controller } = setup({ recorderLeaveMs: 500 });
    const report = await controller.stopStreamInRoom(request({ deadlineAt: Date.now() + 150 }));

    assert.equal(report.outcome, "unconfirmed");
    assertCleanedUp(room);
});

test("hidden real JIDs: neither the focus nor the recorder can be identified -> no STOP", async () => {
    const { room, controller } = setup({ hideJids: true });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "no-focus");
    assert.equal(room.iqs.length, 0);
    assertCleanedUp(room);
});

test("one occupant's real JID hidden (the focus visible): it could be the recorder -> no STOP", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants();
    occupants[2].hideJid = true;
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "recorder-unidentifiable");
    assert.equal(room.iqs.length, 0);
    assertCleanedUp(room);
});

test("no focus occupant -> no STOP", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants().filter(o => !o.focus);
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "no-focus");
    assert.equal(room.iqs.length, 0);
});

test("teacher returns (shouldAbort) before connecting / after joining / just before STOP: no STOP, disconnected", async () => {
    for (const abortOnCall of [1, 2, 3, 4]) {
        let calls = 0;
        const { room, controller } = setup();
        const report = await controller.stopStreamInRoom(request({ shouldAbort: async () => ++calls >= abortOnCall }));

        assert.equal(report.outcome, "aborted", "abort on check " + abortOnCall);
        assert.equal(room.iqs.length, 0);
        assert.equal(room.openSessions, 0);
        if (abortOnCall === 1) assert.equal(room.opens.length, 0, "no connection at all");
    }
});

test("a failing database check counts as abort", async () => {
    const { room, controller } = setup();
    const report = await controller.stopStreamInRoom(request({ shouldAbort: async () => { throw new Error("db down"); } }));

    assert.equal(report.outcome, "aborted");
    assert.equal(room.iqs.length, 0);
});

// ---- No media -----------------------------------------------------------------------

test("no media: no Jingle, source-add, SourceInfo or media description is ever sent; Jicofo's Jingle invite is declined", async () => {
    const { room, controller } = setup({ jingleInvite: true });
    const report = await controller.stopStreamInRoom(request());

    const names = sentElements(room).map(e => e.name);
    for (const forbidden of ["jingle", "source-add", "SourceInfo", "description", "content", "transport", "audiomuted", "videomuted"]) {
        assert.ok(!names.includes(forbidden), "never sends " + forbidden);
    }
    const invite = room.replies.find(r => r.iq.children[0].name === "jingle");
    assert.deepEqual(invite.reply, { type: "error", errorType: "cancel", condition: "feature-not-implemented" });
    assert.equal(report.mediaInvitesDeclined, 1);

    const disco = room.replies.find(r => r.iq.children[0].attrs.xmlns === NS_DISCO_INFO).reply;
    const features = disco.payload.children.filter(c => c.name === "feature").map(c => c.attrs.var);
    assert.deepEqual(features, [NS_DISCO_INFO], "no Jingle / audio / video features advertised");
});

// ---- Privacy --------------------------------------------------------------------------

test("the report carries codes only: no token, student name or JID", async () => {
    const { controller } = setup();
    const token = "secret-token-value";
    const report = await controller.stopStreamInRoom(request({ token }));
    const text = JSON.stringify(report);

    assert.ok(!text.includes(token));
    assert.ok(!text.includes(STUDENT_NAME));
    assert.ok(!text.includes(STUDENT_JID));
});

// ---- Real transport helpers (no connection) ---------------------------------------------

test("real transport: stream management is removed from the stream features; the URL is wss: only with the room and token", () => {
    const transport = require(path.join(root, "lib/jibri-xmpp-transport.ts"));
    const element = (name, attrs, children = []) => ({
        name, attrs, children,
        is(n, ns) { return this.name === n && (ns === undefined || this.attrs.xmlns === ns); }
    });
    const features = element("features", { xmlns: "http://etherx.jabber.org/streams" }, [
        element("mechanisms", { xmlns: "urn:ietf:params:xml:ns:xmpp-sasl" }),
        element("sm", { xmlns: "urn:xmpp:sm:3" }),
        element("bind", { xmlns: "urn:ietf:params:xml:ns:xmpp-bind" })
    ]);

    transport.stripStreamManagement(features);
    assert.deepEqual(features.children.map(c => c.name), ["mechanisms", "bind"]);

    const url = new URL(transport.buildWebSocketUrl(CONFIG.websocketUrl, ROOM, "a.b.c"));
    assert.equal(url.protocol, "wss:");
    assert.equal(url.searchParams.get("room"), ROOM);
    assert.equal(url.searchParams.get("token"), "a.b.c");
    assert.throws(() => transport.buildWebSocketUrl("ws://" + CONFIG.jitsiDomain + "/xmpp-websocket", ROOM, "t"), /wss:/);
    assert.equal(typeof transport.createXmppWebSocketTransport().open, "function");
});

// ---- J4: only a voluntary recorder leave confirms ----------------------------------------

test("classifyOccupantDeparture: XEP-0045 status codes, <destroy/> and Prosody's session-end status", () => {
    const { classifyOccupantDeparture } = require(path.join(root, "lib/jibri-control.ts"));
    const { departurePresence } = require("./fake-jitsi-room.cjs");
    const from = ROOM_JID + "/rec";

    assert.equal(classifyOccupantDeparture(departurePresence(from, "left")), "left");
    assert.equal(classifyOccupantDeparture(xml("presence", { from, type: "unavailable" })), "left", "a bare leave");
    assert.equal(classifyOccupantDeparture(departurePresence(from, "kicked")), "kicked");
    assert.equal(classifyOccupantDeparture(departurePresence(from, "banned")), "banned");
    assert.equal(classifyOccupantDeparture(departurePresence(from, "nick-changed")), "nick-changed");
    assert.equal(classifyOccupantDeparture(departurePresence(from, "removed")), "removed");
    assert.equal(classifyOccupantDeparture(departurePresence(from, "system-shutdown")), "removed");
    assert.equal(classifyOccupantDeparture(departurePresence(from, "room-destroyed")), "room-destroyed");
    assert.equal(classifyOccupantDeparture(departurePresence(from, "session-ended")), "session-ended");
    // Any other / unknown status code is never a voluntary leave.
    assert.equal(classifyOccupantDeparture(xml("presence", { from, type: "unavailable" },
        xml("x", { xmlns: "http://jabber.org/protocol/muc#user" }, xml("status", { code: "999" })))), "removed");
});

test("the recorder leaving voluntarily confirms; every abnormal departure after STOP is unconfirmed", async () => {
    const { room: okRoom, controller: ok } = setup({ recorderLeave: "left" });
    assert.equal((await ok.stopStreamInRoom(request())).outcome, "recorder-left");
    assertCleanedUp(okRoom);

    for (const kind of ["kicked", "banned", "nick-changed", "removed", "system-shutdown", "room-destroyed", "session-ended"]) {
        const { room, controller } = setup({ recorderLeave: kind });
        const report = await controller.stopStreamInRoom(request());

        assert.equal(report.outcome, "unconfirmed", kind);
        assert.equal(report.stopSent, true);
        assert.match(report.detail, /^recorder-/, kind);
        assertCleanedUp(room);
    }
});

// ---- X6: Jicofo identified by its exact real JID -------------------------------------------

test("focus: the occupant with EXACTLY the configured JID (case-insensitive) is targeted", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants();
    occupants[0].nick = "jicofo-nick";
    occupants[0].jid = "FOCUS@auth." + CONFIG.jitsiDomain + "/focus";
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "recorder-left");
    assert.equal(stopIqs(room)[0].attrs.to, ROOM_JID + "/jicofo-nick");
});

test("focus: nick 'focus', a focus@ prefix on another host, focus as a resource or a sub-domain never qualify -> no STOP", async () => {
    for (const impostor of [
        { nick: "focus", jid: "student-9@" + CONFIG.jitsiDomain + "/web" },
        { nick: "x1", jid: "focus@evil.example/focus" },
        { nick: "x2", jid: "focus@auth." + CONFIG.jitsiDomain + ".evil.example/focus" },
        { nick: "x3", jid: "student@" + CONFIG.jitsiDomain + "/focus" },
        { nick: "x4", jid: "focus2@auth." + CONFIG.jitsiDomain + "/focus" }
    ]) {
        const occupants = require("./fake-jitsi-room.cjs").defaultOccupants().filter(o => !o.focus);
        occupants.push({ ...impostor, role: "moderator", focus: { status: "off", recording_mode: "stream" } });
        const { room, controller } = setup({ occupants });
        const report = await controller.stopStreamInRoom(request());

        assert.equal(report.outcome, "no-focus", JSON.stringify(impostor));
        assert.equal(room.iqs.length, 0);
    }
});

test("focus: two occupants with the focus JID -> ambiguous, no STOP", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants();
    occupants.push({ ...occupants[0], nick: "focus-2" });
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request());

    assert.deepEqual([report.outcome, report.detail], ["no-focus", "ambiguous-focus"]);
    assert.equal(room.iqs.length, 0);
});

test("a fake jibri-recording-status from a non-focus occupant is ignored", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants().filter(o => !o.recorder);
    occupants[0].focus.status = "off";
    occupants[1].focus = { status: "on", recording_mode: "stream" }; // a student claiming a running stream
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request());

    assert.equal(report.outcome, "not-running");
    assert.equal(room.iqs.length, 0);
});

// ---- X10 / L4: bounded checks, durable record before STOP -------------------------------------

test("a hung database re-check fails closed (aborted, no STOP) within the check timeout", async () => {
    const { room, controller } = setup({}, { checkTimeoutMs: 40 });
    let calls = 0;
    const started = Date.now();
    const report = await controller.stopStreamInRoom(request({
        shouldAbort: () => (++calls === 3 ? new Promise(() => {}) : Promise.resolve(false))
    }));

    assert.equal(report.outcome, "aborted");
    assert.ok(Date.now() - started < 500);
    assert.equal(room.iqs.length, 0);
    assertCleanedUp(room);
});

test("beforeStop: the STOP is sent only after the shutdown record was written; false / throwing / hung -> no STOP", async () => {
    const order = [];
    const { room, controller } = setup();
    const ok = await controller.stopStreamInRoom(request({ beforeStop: async () => { order.push("recorded:" + room.iqs.length); return true; } }));
    assert.equal(ok.outcome, "recorder-left");
    assert.deepEqual(order, ["recorded:0"], "recorded before any STOP");

    for (const beforeStop of [async () => false, async () => { throw new Error("db"); }, () => new Promise(() => {})]) {
        const { room: r, controller: c } = setup({}, { checkTimeoutMs: 40 });
        const report = await c.stopStreamInRoom(request({ beforeStop }));

        assert.deepEqual([report.outcome, report.detail, report.stopSent], ["aborted", "stop-not-recorded", false]);
        assert.equal(r.iqs.length, 0);
        assertCleanedUp(r);
    }
});

// ---- X9: transport cleanup (fake @xmpp/client) ------------------------------------------------

function fakeXmppModule(script = {}) {
    const state = { stops: 0, forcedWebSocketClose: 0, wrapperEnd: 0, started: false };
    const element = (name, attrs = {}, ...children) => ({
        name, attrs, children,
        is(n, ns) { return this.name === n && (ns === undefined || this.attrs.xmlns === ns); }
    });
    const module = {
        xml: element,
        client() {
            const c = {
                reconnect: { stop() {} },
                middleware: { use() {} },
                iqCaller: { request: async () => ({}) },
                socket: { end() { state.wrapperEnd += 1; }, socket: { close() { state.forcedWebSocketClose += 1; } } },
                on() { return c; },
                prependListener() { return c; },
                async start() {
                    if (script.startDelayMs) await new Promise(r => setTimeout(r, script.startDelayMs));
                    if (script.startFails) throw new Error("wss://x?token=a.b.SECRET failed");
                    state.started = true;
                },
                stop() {
                    state.stops += 1;
                    return script.stopHangs ? new Promise(() => {}) : Promise.resolve();
                },
                async send() {}
            };
            return c;
        }
    };
    return { module, state };
}

const openArgs = timeoutMs => ({ websocketUrl: CONFIG.websocketUrl, domain: CONFIG.jitsiDomain, room: ROOM, token: "a.b.SECRET", timeoutMs });

test("transport close: the library's stop hanging -> the WebSocket is force-closed within the bound", async () => {
    const { createXmppWebSocketTransport } = require(path.join(root, "lib/jibri-xmpp-transport.ts"));
    const { module, state } = fakeXmppModule({ stopHangs: true });
    const transport = createXmppWebSocketTransport({ loadClient: async () => module, stopTimeoutMs: 30 });
    const session = await transport.open(openArgs(200));
    let closedEvents = 0;
    session.onClose(() => { closedEvents += 1; });

    const started = Date.now();
    await session.close();

    assert.ok(Date.now() - started < 300, "bounded");
    assert.equal(state.stops, 1);
    assert.equal(state.forcedWebSocketClose, 1);
    assert.equal(state.wrapperEnd, 1);
    assert.equal(closedEvents, 1);
    await assert.rejects(session.send({ name: "presence", attrs: {}, children: [] }), /closed/);
});

test("transport close: a stop that completes is not forced", async () => {
    const { createXmppWebSocketTransport } = require(path.join(root, "lib/jibri-xmpp-transport.ts"));
    const { module, state } = fakeXmppModule();
    const transport = createXmppWebSocketTransport({ loadClient: async () => module, stopTimeoutMs: 30 });
    const session = await transport.open(openArgs(200));

    await session.close();
    assert.equal(state.stops, 1);
    assert.equal(state.forcedWebSocketClose, 0);
});

test("transport open: a connection completing AFTER its timeout is shut down once it is up; the error carries no token", async () => {
    const { createXmppWebSocketTransport } = require(path.join(root, "lib/jibri-xmpp-transport.ts"));
    const { module, state } = fakeXmppModule({ startDelayMs: 60, stopHangs: true });
    const transport = createXmppWebSocketTransport({ loadClient: async () => module, stopTimeoutMs: 20 });

    await assert.rejects(transport.open(openArgs(20)), error => {
        assert.ok(!String(error.message).includes("SECRET"));
        return /XMPP connection failed/.test(error.message);
    });
    const stopsAtTimeout = state.stops;

    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(state.started, true);
    assert.ok(state.stops > stopsAtTimeout, "stopped again once it came up");
    assert.ok(state.forcedWebSocketClose >= 1, "forced when the stop hung");
});

test("transport open: a failing start is shut down and reported without detail", async () => {
    const { createXmppWebSocketTransport } = require(path.join(root, "lib/jibri-xmpp-transport.ts"));
    const { module, state } = fakeXmppModule({ startFails: true });
    const transport = createXmppWebSocketTransport({ loadClient: async () => module, stopTimeoutMs: 20 });

    await assert.rejects(transport.open(openArgs(200)), error => !String(error.message).includes("SECRET") && /failed/.test(error.message));
    assert.equal(state.stops, 1);
});

// ---- Observation only -----------------------------------------------------------------------

test("observe mode: a stream recorder still in the room -> recorder-present; NO STOP and no shutdown record", async () => {
    const { room, controller } = setup();
    let recorded = 0;
    const report = await controller.stopStreamInRoom(request({ mode: "observe", beforeStop: async () => { recorded += 1; return true; } }));

    assert.equal(report.outcome, "recorder-present");
    assert.equal(report.stopSent, false);
    assert.equal(room.iqs.length, 0, "no request of any kind");
    assert.equal(recorded, 0);
    assertLeftRoom(room);
    assertCleanedUp(room);
});

test("observe mode: a clear room (no recorder, no stream session) -> not-running; NO STOP", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants().filter(o => !o.recorder);
    occupants[0].focus.status = "off";
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request({ mode: "observe" }));

    assert.equal(report.outcome, "not-running");
    assert.equal(room.iqs.length, 0);
});

test("observe mode: a stream session at the focus without a visible recorder -> recorder-present (never clear)", async () => {
    const occupants = require("./fake-jitsi-room.cjs").defaultOccupants().filter(o => !o.recorder);
    const { room, controller } = setup({ occupants });
    const report = await controller.stopStreamInRoom(request({ mode: "observe" }));

    assert.equal(report.outcome, "recorder-present");
    assert.equal(room.iqs.length, 0);
});
