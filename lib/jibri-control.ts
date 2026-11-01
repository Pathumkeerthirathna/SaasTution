/*
 * Room-scoped Jibri stop through Jicofo (the backend's half of
 * lib/jibri-stop-for-departure.ts). Transport-agnostic: the XMPP connection
 * is an XmppTransport (lib/jibri-xmpp-transport.ts in the worker, a scripted
 * fake in tests), so nothing here opens a socket by itself.
 *
 * What it does, in one short-lived connection:
 * 1. Joins the exact classroom MUC (<room>@<muc domain>) as a system
 *    occupant (the token's identity, a random nick, no chat history).
 * 2. Waits for its own presence (status 110) and requires role "moderator":
 *    Jicofo accepts Jibri requests only from moderator occupants of the room
 *    (BaseJibri: enableModeratorChecks).
 * 3. Identifies the room's focus (Jicofo): the ONE occupant whose real JID is
 *    exactly the configured focus JID (focus@auth.<domain>); none, several,
 *    or hidden JIDs: no STOP. Then the STREAM recorder: the occupant whose
 *    real JID is on the recorder (hidden) domain and whose presence says
 *    <mode>stream</mode>, matched to the focus's jibri-recording-status
 *    session_id when there is one.
 * 4. Sends the same room-scoped request the browser's stopRecording sends:
 *    <iq type="set" to="<room>@<muc>/<focus nick>">
 *      <jibri xmlns="http://jitsi.org/protocol/jibri" action="stop" recording_mode="stream"/>
 *    </iq>
 *    Jicofo resolves the room's ONE Jibri session itself and forwards the
 *    stop (with its session ID) to the Jibri worker it assigned; no generic
 *    Jibri control, HTTP API or service command is ever used.
 * 5. Confirms only when the stream recorder occupant LEAVES the room
 *    voluntarily (classifyOccupantDeparture: no kick, ban, nick change,
 *    room destruction or ended session).
 *    Jicofo answers the IQ and publishes status "off" right after
 *    dispatching (JibriSession.stop: fire-and-forget), so neither proves the
 *    stream stopped. Jibri 8.0-205's StreamingJibriService.stop() stops the
 *    capturer (ffmpeg: graceful stop, 10 s, then a forcible destroy, 10 s)
 *    BEFORE its browser leaves the call (CallPage.leave, then quit), so the
 *    recorder leaving the room follows the media shutdown.
 * 6. Leaves (unavailable presence) and closes the connection on every path.
 *
 * Never publishes media: no Jingle, no sources, no SourceInfo. A Jingle
 * invitation from Jicofo is answered with an error (declined). Unknown
 * requests get service-unavailable. Messages are ignored. Nothing is logged
 * here; the result carries outcome codes only (never a JID, a name or the
 * token).
 *
 * Observation only (mode "observe"): the same join and look, never a STOP.
 *
 * Uncertain is never "recorder-left": a timeout, a disconnect, a stop Jicofo
 * accepted without a recorder to watch, or occupants whose real JIDs are
 * hidden are all reported as not confirmed.
 */

export type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
};

/** How an incoming IQ request (get / set) is answered. */
export type IqReply =
  | { type: "result"; payload?: XmlNode }
  | { type: "error"; errorType: "cancel" | "modify"; condition: string };

/** The answer to an IQ we sent. */
export type IqAnswer = { type: "result" } | { type: "error"; condition: string };

export interface XmppSession {
  /** Sends a presence / message stanza. */
  send(stanza: XmlNode): Promise<void>;
  /** Sends an IQ (the session sets its id). Rejects on timeout or disconnect. */
  sendIq(iq: XmlNode, timeoutMs: number): Promise<IqAnswer>;
  /** Presence and message stanzas. */
  onStanza(listener: (stanza: XmlNode) => void): void;
  /** Incoming IQ requests (get / set); the returned reply is sent. */
  onIqRequest(handler: (iq: XmlNode) => IqReply): void;
  /** The connection closed (by either side). */
  onClose(listener: () => void): void;
  /** Closes the connection (idempotent, never throws). */
  close(): Promise<void>;
  /**
   * The JID the server bound after authentication (its domain is the
   * server's XMPP domain). Missing: the server cannot be identified, and
   * the connection is treated as a wrong server.
   */
  boundJid?: string | null;
}

export interface XmppTransport {
  /** Connects and authenticates; the token never leaves the transport. */
  open(options: {
    websocketUrl: string;
    domain: string;
    room: string;
    token: string;
    timeoutMs: number;
  }): Promise<XmppSession>;
}

/**
 * Room evidence only: the lifecycle (lib/jibri-stop-for-departure.ts) also
 * needs YouTube's view of the stream before it treats a shutdown as done.
 */
export type JibriStopOutcome =
  /** STOP accepted by Jicofo and the stream recorder then left the room voluntarily. */
  | "recorder-left"
  /** No stream recorder in the room and Jicofo reports no stream session (room clear). */
  | "not-running"
  /** Observation only: a stream recorder (or a stream session) is still in the room. */
  | "recorder-present"
  /** shouldAbort said so (teacher back, feature active, session over, check failed). */
  | "aborted"
  | "connect-failed"
  /** Authenticated, but the server bound a JID of another domain (or none): another Jitsi server. */
  | "wrong-server"
  | "join-failed"
  /** Joined, but not as a moderator: no STOP. */
  | "not-moderator"
  /** No focus (Jicofo) occupant seen: no STOP. */
  | "no-focus"
  /** Some occupants' real JIDs are hidden: the recorder cannot be identified, no STOP. */
  | "recorder-unidentifiable"
  /** Jicofo refused (forbidden / not-allowed). */
  | "refused"
  /** Jicofo answered another error (incl. item-not-found with a recorder still there). */
  | "stop-error"
  /** STOP accepted, but the recorder was not seen leaving (or there was none to watch). */
  | "unconfirmed"
  | "timeout"
  | "disconnected";

export type JibriStopReport = {
  outcome: JibriStopOutcome;
  /** Whether the STOP request was sent to Jicofo. */
  stopSent: boolean;
  /** An error condition code (e.g. "item-not-found"), never free text. */
  detail?: string;
  /** Jingle (media) invitations declined during the connection. */
  mediaInvitesDeclined: number;
  /**
   * What this connection proved (lib/jibri-fence-control.ts connection
   * proof): a connection was tried, the login reached the EXPECTED server,
   * the room was joined, and as a moderator.
   */
  connection: JibriConnectionProof;
};

export type JibriConnectionProof = {
  attempted: boolean;
  authenticated: boolean;
  joined: boolean;
  moderator: boolean;
};

/** A login check only (no room is joined): the expected server, our token accepted. */
export type JibriProbeRequest = {
  websocketUrl: string;
  xmppDomain: string;
  /** A classroom-shaped room name for the token's claim and the URL; never joined. */
  roomName: string;
  token: string;
  deadlineAt: number;
};

export type JibriProbeReport =
  | { ok: true }
  | { ok: false; error: "connect-failed" | "connect-timeout" | "wrong-server" };

export type RoomStopRequest = {
  websocketUrl: string;
  /** The XMPP domain (the Jitsi domain). */
  xmppDomain: string;
  mucDomain: string;
  recorderDomain: string;
  /**
   * Jicofo's real bare JID (e.g. focus@auth.<domain>): the focus is the ONE
   * occupant whose real JID is exactly this. None (or several): no STOP.
   */
  focusJid: string;
  /** The exact classroom room name, lowercase (validated by the caller). */
  roomName: string;
  token: string;
  /** Epoch ms (Date.now clock) by which everything, including leaving, ends. */
  deadlineAt: number;
  /**
   * Re-checks the database; true: do not go on (nothing more is sent but the
   * leave). Called before connecting, after connecting, after joining and
   * right before STOP. A throwing or timed-out check counts as true.
   */
  shouldAbort: () => Promise<boolean>;
  /**
   * Records durably that a STOP is about to be sent (the shutdown is in
   * progress); called right before it. False, throwing or timed out: no STOP.
   */
  beforeStop?: () => Promise<boolean>;
  /**
   * "stop": may send the one STOP. "observe": join, look, leave; never a
   * STOP (reports not-running / recorder-present). Default "stop".
   */
  mode?: "stop" | "observe";
};

export type JibriControllerOptions = {
  transport: XmppTransport;
  /** Upper bounds per step (each also capped by the request's deadline). */
  connectTimeoutMs?: number;
  joinTimeoutMs?: number;
  iqTimeoutMs?: number;
  /** Bound on each shouldAbort / beforeStop call. */
  checkTimeoutMs?: number;
  /** After item-not-found: how long to watch the room before looking again. */
  notFoundRecheckMs?: number;
  /** Reserved at the end of the deadline for leaving and closing. */
  leaveReserveMs?: number;
  /** A random MUC nick (tests pass a fixed one). */
  nick?: () => string;
};

export interface JibriController {
  stopStreamInRoom(request: RoomStopRequest): Promise<JibriStopReport>;
  /** Logs in and out (no room): proof that the worker reaches the expected Jitsi server. */
  probeConnection?(request: JibriProbeRequest): Promise<JibriProbeReport>;
}

/** The server identified itself as `xmppDomain` (its bound JID's domain). */
export function boundToDomain(session: Pick<XmppSession, "boundJid">, xmppDomain: string): boolean {
  const bound = session.boundJid ?? "";
  const bare = bound.split("/")[0];
  const domain = bare.includes("@") ? bare.slice(bare.indexOf("@") + 1) : bare;

  return bound !== "" && domain.toLowerCase() === xmppDomain.toLowerCase();
}

export const NS_JIBRI = "http://jitsi.org/protocol/jibri";
export const NS_MUC = "http://jabber.org/protocol/muc";
export const NS_MUC_USER = "http://jabber.org/protocol/muc#user";
export const NS_NICK = "http://jabber.org/protocol/nick";
export const NS_DISCO_INFO = "http://jabber.org/protocol/disco#info";
export const NS_PING = "urn:xmpp:ping";
export const NS_JINGLE = "urn:xmpp:jingle:1";

export const SYSTEM_OCCUPANT_DISPLAY_NAME = "SL Classroom System";

const DEFAULTS = {
  connectTimeoutMs: 10_000,
  joinTimeoutMs: 10_000,
  iqTimeoutMs: 10_000,
  notFoundRecheckMs: 3_000,
  leaveReserveMs: 2_000,
  checkTimeoutMs: 3_000,
};

export function xml(name: string, attrs: Record<string, string | undefined> = {}, ...children: (XmlNode | string)[]): XmlNode {
  const clean: Record<string, string> = {};

  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) clean[key] = value;
  }

  return { name, attrs: clean, children };
}

const childElements = (node: XmlNode) => node.children.filter((c): c is XmlNode => typeof c !== "string");

function child(node: XmlNode, name: string, xmlns?: string): XmlNode | undefined {
  return childElements(node).find(c => c.name === name && (xmlns === undefined || c.attrs.xmlns === xmlns));
}

function text(node: XmlNode | undefined): string | null {
  if (!node) return null;

  const value = node.children.filter((c): c is string => typeof c === "string").join("").trim();

  return value || null;
}

const bareJid = (jid: string) => jid.split("/")[0];
const resourceOf = (jid: string) => (jid.includes("/") ? jid.slice(jid.indexOf("/") + 1) : "");
const domainOf = (jid: string) => {
  const bare = bareJid(jid);
  return bare.includes("@") ? bare.slice(bare.indexOf("@") + 1) : bare;
};
/**
 * Why an occupant's unavailable presence was sent (XEP-0045 muc#user status
 * codes, <destroy/>, and the free-text <status/> Prosody adds when a
 * session ENDS rather than leaves: mod_presence's resource-unbind sends
 * "Disconnected: <error>"). Only "left" is a voluntary leave: what
 * lib-jitsi-meet's room.leave() sends (no reason given, as Jibri's
 * CallPage.leave() calls it: no <status/> at all) and what the MUC relays
 * for it (no status code). Everything else is abnormal and never confirms
 * a Jibri shutdown:
 * - "kicked" (307), "banned" (301), "nick-changed" (303, not even gone),
 * - "removed" (321 affiliation change, 322 members-only, 332 service
 *   shutdown, 333 technical problem, or any other code),
 * - "room-destroyed" (<destroy/>),
 * - "session-ended" (a <status/> text, e.g. Disconnected: connection closed,
 *   or a stream-management resumption timeout).
 */
export type OccupantDeparture =
  | "left"
  | "kicked"
  | "banned"
  | "nick-changed"
  | "removed"
  | "room-destroyed"
  | "session-ended";

export function classifyOccupantDeparture(presence: XmlNode): OccupantDeparture {
  const mucUser = child(presence, "x", NS_MUC_USER);
  const codes = mucUser ? childElements(mucUser).filter(c => c.name === "status").map(c => c.attrs.code) : [];

  if (mucUser && child(mucUser, "destroy")) return "room-destroyed";
  if (codes.includes("307")) return "kicked";
  if (codes.includes("301")) return "banned";
  if (codes.includes("303")) return "nick-changed";
  if (codes.length > 0) return "removed";
  // jabber:client <status/> (free text): only an ended session carries one here.
  if (childElements(presence).some(c => c.name === "status" && (c.attrs.xmlns === undefined || c.attrs.xmlns === "jabber:client"))) {
    return "session-ended";
  }

  return "left";
}

/** The room-scoped STOP request (exported for tests). */
export function buildStopIq(focusOccupantJid: string): XmlNode {
  return xml("iq", { type: "set", to: focusOccupantJid },
    xml("jibri", { xmlns: NS_JIBRI, action: "stop", recording_mode: "stream" }));
}

function randomNick(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/** What the room tells us, kept only for this one connection: no names, no JIDs. */
type Occupant = {
  /** Its real JID was visible (muc#user item jid). */
  jidVisible: boolean;
  focus: boolean;
  recorder: boolean;
  /** Recorder presence fields (Jibri addToPresence "mode" / "session_id"). */
  mode: string | null;
  sessionId: string | null;
};

type FocusStatus = { status: string; sessionId: string | null };

export function createJibriController(options: JibriControllerOptions): JibriController {
  const limits = { ...DEFAULTS, ...options };
  const makeNick = options.nick ?? randomNick;

  async function stopStreamInRoom(request: RoomStopRequest): Promise<JibriStopReport> {
    const roomJid = `${request.roomName}@${request.mucDomain}`;
    const nick = makeNick();
    // Ours as requested; the room may assign another (status 110 says which).
    let ownOccupantJid = `${roomJid}/${nick}`;
    // The deadline for everything but leaving / closing.
    const workDeadline = request.deadlineAt - limits.leaveReserveMs;
    const remaining = () => workDeadline - Date.now();

    let mediaInvitesDeclined = 0;
    let stopSent = false;
    const connection: JibriConnectionProof = { attempted: false, authenticated: false, joined: false, moderator: false };
    const report = (outcome: JibriStopOutcome, detail?: string): JibriStopReport =>
      ({ outcome, stopSent, mediaInvitesDeclined, connection: { ...connection }, ...(detail ? { detail } : {}) });

    if (remaining() <= 0) return report("timeout");

    // Database checks: bounded; a timeout or an error means abort / no STOP.
    const aborted = async () => {
      try {
        return await withTimeout(Promise.resolve().then(request.shouldAbort), Math.min(limits.checkTimeoutMs, remaining()));
      } catch {
        return true;
      }
    };
    const stopRecorded = async () => {
      if (!request.beforeStop) return true;

      try {
        return (await withTimeout(Promise.resolve().then(request.beforeStop), Math.min(limits.checkTimeoutMs, remaining()))) === true;
      } catch {
        return false;
      }
    };

    if (await aborted()) return report("aborted");

    let session: XmppSession;
    connection.attempted = true;
    const opening = request.websocketUrl && request.token
      ? Promise.resolve().then(() => options.transport.open({
        websocketUrl: request.websocketUrl,
        domain: request.xmppDomain,
        room: request.roomName,
        token: request.token,
        timeoutMs: Math.max(0, Math.min(limits.connectTimeoutMs, remaining())),
      }))
      : Promise.reject(new Error("missing connection parameters"));

    try {
      session = await withTimeout(opening, Math.min(limits.connectTimeoutMs, remaining()));
    } catch {
      // A connection that completes after we gave up is closed at once.
      opening.then(late => late.close()).catch(() => {});
      return report("connect-failed");
    }

    // Logged in, but to which server? Its bound JID must be of the expected
    // domain; another Jitsi server (or one that does not say) gets nothing.
    if (!boundToDomain(session, request.xmppDomain)) {
      await session.close().catch(() => {});
      return report("wrong-server");
    }

    connection.authenticated = true;

    // ---- Room state (this connection only) ----
    const occupants = new Map<string, Occupant>();
    // How each occupant that left did so (only "left" can confirm).
    const departures = new Map<string, OccupantDeparture>();
    let focusStatus: FocusStatus | null = null;
    let joined = false;
    let selfRole: string | null = null;
    let joinError: string | null = null;
    let closed = false;
    let kicked = false;
    const waiters = new Set<() => void>();
    const changed = () => waiters.forEach(wake => wake());

    session.onClose(() => {
      closed = true;
      changed();
    });

    session.onIqRequest(iq => {
      const [payload] = childElements(iq);

      if (iq.attrs.type === "get" && payload?.name === "ping" && payload.attrs.xmlns === NS_PING) {
        return { type: "result" };
      }

      if (iq.attrs.type === "get" && payload?.name === "query" && payload.attrs.xmlns === NS_DISCO_INFO) {
        // A system occupant: no Jingle, audio or video features.
        return {
          type: "result",
          payload: xml("query", { xmlns: NS_DISCO_INFO },
            xml("identity", { category: "client", type: "bot", name: SYSTEM_OCCUPANT_DISPLAY_NAME }),
            xml("feature", { var: NS_DISCO_INFO })),
        };
      }

      if (payload?.name === "jingle" && payload.attrs.xmlns === NS_JINGLE) {
        // A media invitation (session-initiate) or any other Jingle action:
        // declined; no session is ever accepted.
        mediaInvitesDeclined += 1;
        return { type: "error", errorType: "cancel", condition: "feature-not-implemented" };
      }

      return { type: "error", errorType: "cancel", condition: "service-unavailable" };
    });

    session.onStanza(stanza => {
      if (stanza.name !== "presence") return;

      const from = stanza.attrs.from ?? "";

      if (bareJid(from) !== roomJid) return;

      const occupantNick = resourceOf(from);
      const self = from === ownOccupantJid;

      if (stanza.attrs.type === "error") {
        if (self) {
          const error = child(stanza, "error");
          joinError = error ? (childElements(error)[0]?.name ?? "error") : "error";
          changed();
        }
        return;
      }

      if (stanza.attrs.type === "unavailable") {
        if (self) {
          kicked = true;
        } else {
          departures.set(occupantNick, classifyOccupantDeparture(stanza));
          occupants.delete(occupantNick);
        }
        changed();
        return;
      }

      if (stanza.attrs.type) return;

      const mucUser = child(stanza, "x", NS_MUC_USER);
      const item = mucUser ? child(mucUser, "item") : undefined;
      const codes = mucUser ? childElements(mucUser).filter(c => c.name === "status").map(c => c.attrs.code) : [];

      if (self || codes.includes("110")) {
        ownOccupantJid = from;
        joined = true;
        selfRole = item?.attrs.role ?? null;
        connection.joined = true;
        connection.moderator = selfRole === "moderator";
        changed();
        return;
      }

      const realJid = item?.attrs.jid ?? "";
      const recordingStatus = child(stanza, "jibri-recording-status", NS_JIBRI);
      // Jicofo: exactly the configured real JID (never a nick, which any
      // occupant chooses, nor a JID prefix).
      const focus = realJid !== "" && bareJid(realJid).toLowerCase() === request.focusJid;

      occupants.set(occupantNick, {
        jidVisible: realJid !== "",
        focus,
        recorder: realJid !== "" && domainOf(realJid) === request.recorderDomain,
        mode: text(child(stanza, "mode")),
        sessionId: text(child(stanza, "session_id")),
      });

      if (focus && recordingStatus) {
        const mode = recordingStatus.attrs.recording_mode;

        // Only the stream (live) session; a file recording is not ours.
        if (!mode || mode === "stream") {
          focusStatus = {
            status: recordingStatus.attrs.status ?? "",
            sessionId: recordingStatus.attrs.session_id || null,
          };
        }
      }

      changed();
    });

    function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
      if (condition()) return Promise.resolve(true);
      if (ms <= 0) return Promise.resolve(false);

      return new Promise(resolve => {
        const check = () => {
          if (condition()) finish(true);
        };
        const timer = setTimeout(() => finish(false), ms);
        const finish = (value: boolean) => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(value);
        };

        waiters.add(check);
      });
    }

    const gone = () => closed || kicked;

    // The stream recorder(s): on the recorder domain, in stream mode (or not
    // saying), matching the focus's session when both say.
    const streamRecorders = () => new Set(
      Array.from(occupants.entries())
        .filter(([, o]) => o.recorder)
        .filter(([, o]) => o.mode === null || o.mode === "stream")
        .filter(([, o]) => !(focusStatus?.sessionId && o.sessionId && o.sessionId !== focusStatus.sessionId))
        .map(([occupantNick]) => occupantNick)
    );
    const focusRunning = () => {
      const status = focusStatus?.status;
      return status === "on" || status === "pending";
    };

    try {
      if (await aborted()) return report("aborted");
      if (gone()) return report("disconnected");

      await session.send(xml("presence", { to: ownOccupantJid },
        xml("x", { xmlns: NS_MUC }, xml("history", { maxstanzas: "0" })),
        xml("nick", { xmlns: NS_NICK }, SYSTEM_OCCUPANT_DISPLAY_NAME)));

      await waitFor(() => joined || joinError !== null || gone(), Math.min(limits.joinTimeoutMs, remaining()));

      if (joinError !== null) return report("join-failed", joinError);
      if (gone()) return report("disconnected");
      if (!joined) return report("timeout");
      if (selfRole !== "moderator") return report("not-moderator");

      if (await aborted()) return report("aborted");

      const focusEntries = Array.from(occupants.entries()).filter(([, o]) => o.focus);

      if (focusEntries.length === 0) return report("no-focus");
      if (focusEntries.length > 1) return report("no-focus", "ambiguous-focus");

      const focusEntry = focusEntries[0];

      // Any occupant without a visible real JID could be the recorder.
      if (Array.from(occupants.values()).some(o => !o.jidVisible)) {
        return report("recorder-unidentifiable");
      }

      const targets = streamRecorders();

      if (targets.size === 0 && !focusRunning()) return report("not-running");

      // Observation only (a STOP was already sent for this fence, the
      // teacher came back, or the session ended): never a STOP.
      if (request.mode === "observe") return report("recorder-present");

      // The last database check, immediately before STOP; then the durable
      // "shutdown in progress" record (not written: no STOP).
      if (await aborted()) return report("aborted");
      if (!(await stopRecorded())) return report("aborted", "stop-not-recorded");
      if (gone()) return report("disconnected");
      if (remaining() <= 0) return report("timeout");

      let answer: IqAnswer;

      stopSent = true;

      try {
        answer = await session.sendIq(buildStopIq(`${roomJid}/${focusEntry[0]}`), Math.min(limits.iqTimeoutMs, remaining()));
      } catch {
        return report(gone() ? "disconnected" : "timeout");
      }

      if (answer.type === "error") {
        if (answer.condition === "forbidden" || answer.condition === "not-allowed") {
          return report("refused", answer.condition);
        }

        if (answer.condition === "item-not-found") {
          // Jicofo has no stream session: only "not running" once a fresh
          // look at the room shows no stream recorder and no stream status.
          await waitFor(gone, Math.min(limits.notFoundRecheckMs, remaining()));

          if (gone()) return report("disconnected");

          return streamRecorders().size === 0 && !focusRunning()
            ? report("not-running")
            : report("stop-error", answer.condition);
        }

        return report("stop-error", answer.condition);
      }

      // Accepted. Only the recorder LEAVING proves the stream stopped.
      if (targets.size === 0) return report("unconfirmed");

      // Each target's own unavailable presence, seen on this connection.
      const allGone = () => Array.from(targets).every(occupantNick => !occupants.has(occupantNick));

      await waitFor(() => allGone() || gone(), remaining());

      if (allGone()) {
        // A kick, ban, nick change, room destruction or ended session is not
        // Jibri finishing its stop: never confirmed.
        const abnormal = Array.from(targets).map(t => departures.get(t)).find(kind => kind !== "left");

        return abnormal ? report("unconfirmed", "recorder-" + abnormal) : report("recorder-left");
      }
      if (gone()) return report("disconnected");

      return report("unconfirmed");
    } finally {
      if (!closed) {
        try {
          await withTimeout(session.send(xml("presence", { to: ownOccupantJid, type: "unavailable" })), 1_000);
        } catch {
          /* closing anyway */
        }
      }

      await session.close().catch(() => {});
      waiters.clear();
    }
  }

  /** Logs in, checks the server's identity, logs out. Never joins a room, never throws. */
  async function probeConnection(request: JibriProbeRequest): Promise<JibriProbeReport> {
    const budget = Math.min(limits.connectTimeoutMs, request.deadlineAt - Date.now());

    if (budget <= 0) return { ok: false, error: "connect-timeout" };

    const opening = Promise.resolve().then(() => options.transport.open({
      websocketUrl: request.websocketUrl,
      domain: request.xmppDomain,
      room: request.roomName,
      token: request.token,
      timeoutMs: budget,
    }));
    let session: XmppSession;

    try {
      session = await withTimeout(opening, budget);
    } catch (error) {
      opening.then(late => late.close()).catch(() => {});
      return { ok: false, error: error instanceof Error && error.message === "timeout" ? "connect-timeout" : "connect-failed" };
    }

    const expected = boundToDomain(session, request.xmppDomain);

    await session.close().catch(() => {});

    return expected ? { ok: true } : { ok: false, error: "wrong-server" };
  }

  return { stopStreamInRoom, probeConnection };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    promise.catch(() => {});
    return Promise.reject(new Error("timeout"));
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);

    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
