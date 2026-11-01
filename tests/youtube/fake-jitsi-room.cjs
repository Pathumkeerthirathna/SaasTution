/*
 * A scripted fake of one Jitsi classroom as seen over XMPP (tests only): an
 * XmppTransport for lib/jibri-control.ts. Prosody's MUC (occupant
 * presences, our own presence with status 110 and a role), Jicofo's focus
 * (jibri-recording-status, the room-scoped STOP answer, a Jingle invite) and
 * the Jibri recorder occupant (leaving after a STOP, or not). Records every
 * stanza the client sends. Opens no socket.
 */

"use strict";

const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { xml, NS_JIBRI, NS_MUC_USER, NS_JINGLE, NS_DISCO_INFO } = require(path.join(root, "lib/jibri-control.ts"));

const DOMAIN = "meet.example.test";

const CONFIG = {
    jitsiDomain: DOMAIN,
    websocketUrl: "wss://" + DOMAIN + "/xmpp-websocket",
    mucDomain: "conference." + DOMAIN,
    recorderDomain: "recorder." + DOMAIN,
    focusJid: "focus@auth." + DOMAIN
};

// How the recorder's unavailable presence looks, by departure kind (XEP-0045
// status codes / <destroy/>; Prosody's "Disconnected: ..." for an ended session).
function departurePresence(from, kind) {
    const status = code => xml("status", { code });
    const item = xml("item", { role: "none", affiliation: "none" });
    switch (kind) {
        case "left": return xml("presence", { from, type: "unavailable" }, xml("x", { xmlns: NS_MUC_USER }, item));
        case "kicked": return xml("presence", { from, type: "unavailable" }, xml("x", { xmlns: NS_MUC_USER }, item, status("307")));
        case "banned": return xml("presence", { from, type: "unavailable" }, xml("x", { xmlns: NS_MUC_USER }, item, status("301")));
        case "nick-changed": return xml("presence", { from, type: "unavailable" },
            xml("x", { xmlns: NS_MUC_USER }, xml("item", { role: "participant", nick: "renamed" }), status("303")));
        case "removed": return xml("presence", { from, type: "unavailable" }, xml("x", { xmlns: NS_MUC_USER }, item, status("321")));
        case "system-shutdown": return xml("presence", { from, type: "unavailable" }, xml("x", { xmlns: NS_MUC_USER }, item, status("332")));
        case "room-destroyed": return xml("presence", { from, type: "unavailable" }, xml("x", { xmlns: NS_MUC_USER }, item, xml("destroy", {})));
        case "session-ended": return xml("presence", { from, type: "unavailable" },
            xml("status", {}, "Disconnected: connection closed"), xml("x", { xmlns: NS_MUC_USER }, item));
        default: throw new Error("unknown departure " + kind);
    }
}

// Student data the backend must never log or keep.
const STUDENT_NAME = "Alice Student";
const STUDENT_JID = "7f3e9b2c-student@" + DOMAIN + "/web-1234";

function defaultOccupants() {
    return [
        { nick: "focus", jid: "focus@auth." + DOMAIN + "/focus", role: "moderator", focus: { status: "on", session_id: "jibri-session-1", recording_mode: "stream" } },
        { nick: "a1b2c3d4", jid: "recorder-x1@recorder." + DOMAIN + "/rec", role: "participant", mode: "stream", sessionId: "jibri-session-1", recorder: true },
        { nick: "e5f6a7b8", jid: STUDENT_JID, role: "participant", name: STUDENT_NAME }
    ];
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function createFakeJitsi(overrides = {}) {
    const room = {
        // Script
        occupants: defaultOccupants(),
        selfRole: "moderator",
        // A condition name: the join is refused with this error presence.
        joinError: null,
        // A different nick assigned by the room (status 110 tells it).
        assignedNick: null,
        connectError: false,
        connectHang: false,
        // "result" | { error: "<condition>" } | "hang" | "drop"
        stopAnswer: "result",
        // After an accepted STOP: the focus says off at once (as Jicofo does).
        focusOffOnStop: true,
        // After an accepted STOP: the recorder leaves after recorderLeaveMs (null: never).
        recorderLeaveMs: 5,
        // How the recorder leaves (see departurePresence).
        recorderLeave: "left",
        // Jicofo invites the occupant to a Jingle (media) session after it joins.
        jingleInvite: true,
        hideJids: false,
        // "after-join": the server drops the connection right after the join.
        dropAt: null,
        // The domain of the JID the server binds after login (another Jitsi
        // server: another domain; null: the server does not say).
        serverDomain: DOMAIN,
        ...overrides,
        // Records
        opens: [],
        sent: [],
        iqs: [],
        replies: [],
        closes: 0,
        openSessions: 0,
        sessions: []
    };

    const roomJidOf = name => name + "@" + CONFIG.mucDomain;

    function presenceOf(roomJid, o) {
        const item = { role: o.role, affiliation: o.role === "moderator" ? "owner" : "none" };
        if (!room.hideJids && !o.hideJid) item.jid = o.jid;

        const children = [xml("x", { xmlns: NS_MUC_USER }, xml("item", item))];
        if (o.name) children.push(xml("nick", { xmlns: "http://jabber.org/protocol/nick" }, o.name));
        if (o.mode) children.push(xml("mode", {}, o.mode));
        if (o.sessionId) children.push(xml("session_id", {}, o.sessionId));
        if (o.focus) children.push(xml("jibri-recording-status", { xmlns: NS_JIBRI, ...o.focus }));

        return xml("presence", { from: roomJid + "/" + o.nick }, ...children);
    }

    const transport = {
        async open(options) {
            room.opens.push({
                websocketUrl: options.websocketUrl, domain: options.domain, room: options.room,
                token: options.token, timeoutMs: options.timeoutMs
            });

            if (room.connectError) throw new Error("connect refused");
            if (room.connectHang) await new Promise(() => {});

            const listeners = { stanza: [], close: [] };
            let iqHandler = null;
            let closed = false;
            const roomJid = roomJidOf(options.room);

            const deliver = stanza => {
                if (!closed) listeners.stanza.forEach(listener => listener(stanza));
            };
            const markClosed = () => {
                if (closed) return;
                closed = true;
                room.openSessions -= 1;
                listeners.close.forEach(listener => listener());
            };
            const ask = iq => {
                const reply = iqHandler ? iqHandler(iq) : { type: "error", condition: "service-unavailable" };
                room.replies.push({ iq, reply });
                return reply;
            };

            async function join(requestedOccupantJid) {
                await wait(1);
                if (room.joinError) {
                    deliver(xml("presence", { from: requestedOccupantJid, type: "error" },
                        xml("error", { type: "auth" }, xml(room.joinError, { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }))));
                    return;
                }
                for (const o of room.occupants) deliver(presenceOf(roomJid, o));
                const own = room.assignedNick ? roomJid + "/" + room.assignedNick : requestedOccupantJid;
                deliver(xml("presence", { from: own },
                    xml("x", { xmlns: NS_MUC_USER },
                        xml("item", { role: room.selfRole, affiliation: room.selfRole === "moderator" ? "owner" : "none", jid: "own@" + DOMAIN + "/x" }),
                        xml("status", { code: "110" }))));
                if (room.dropAt === "after-join") {
                    await wait(1);
                    markClosed();
                    return;
                }
                if (room.jingleInvite) {
                    await wait(1);
                    ask(xml("iq", { type: "get", from: roomJid + "/focus", id: "disco1" }, xml("query", { xmlns: NS_DISCO_INFO })));
                    ask(xml("iq", { type: "set", from: roomJid + "/focus", id: "jingle1" },
                        xml("jingle", { xmlns: NS_JINGLE, action: "session-initiate", sid: "s1" })));
                }
            }

            const session = {
                boundJid: room.serverDomain === null ? null : "system-" + room.opens.length + "@" + room.serverDomain + "/fake",
                async send(stanza) {
                    if (closed) throw new Error("closed");
                    room.sent.push(stanza);
                    if (stanza.name === "presence" && (stanza.attrs.to || "").startsWith(roomJid + "/") && !stanza.attrs.type) {
                        join(stanza.attrs.to);
                    }
                },
                async sendIq(iq, timeoutMs) {
                    if (closed) throw new Error("closed");
                    room.sent.push(iq);
                    room.iqs.push(iq);
                    const answer = room.stopAnswer;
                    if (answer === "hang") {
                        await wait(timeoutMs);
                        throw new Error("timeout");
                    }
                    if (answer === "drop") {
                        markClosed();
                        throw new Error("closed");
                    }
                    if (answer && answer.error) return { type: "error", condition: answer.error };

                    const focus = room.occupants.find(o => o.focus);
                    if (room.focusOffOnStop && focus) {
                        focus.focus = { ...focus.focus, status: "off" };
                        setTimeout(() => deliver(presenceOf(roomJid, focus)), 0);
                    }
                    if (room.recorderLeaveMs !== null) {
                        setTimeout(() => {
                            for (const o of room.occupants.filter(o => o.recorder)) {
                                room.occupants = room.occupants.filter(x => x !== o);
                                deliver(departurePresence(roomJid + "/" + o.nick, room.recorderLeave));
                            }
                        }, room.recorderLeaveMs);
                    }
                    return { type: "result" };
                },
                onStanza(listener) { listeners.stanza.push(listener); },
                onIqRequest(handler) { iqHandler = handler; },
                onClose(listener) { listeners.close.push(listener); },
                async close() {
                    if (!closed) room.closes += 1;
                    markClosed();
                },
                // Test hook: deliver a presence from the room.
                deliver,
                drop: markClosed
            };

            room.openSessions += 1;
            room.sessions.push(session);
            return session;
        }
    };

    return { room, transport };
}

/** Every element (recursively) of the stanzas the client sent. */
function sentElements(room) {
    const all = [];
    const walk = node => {
        all.push(node);
        node.children.forEach(c => typeof c !== "string" && walk(c));
    };
    room.sent.forEach(walk);
    return all;
}

function decodeJwt(token) {
    const [header, payload] = token.split(".");
    const decode = part => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return { header: decode(header), payload: decode(payload) };
}

module.exports = { createFakeJitsi, sentElements, decodeJwt, departurePresence, CONFIG, DOMAIN, STUDENT_NAME, STUDENT_JID, defaultOccupants };
