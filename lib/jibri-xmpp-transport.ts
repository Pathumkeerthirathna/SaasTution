/*
 * The real XmppTransport for lib/jibri-control.ts: XMPP over WebSocket
 * (RFC 7395, subprotocol "xmpp") with @xmpp/client, authenticated the way
 * the Jitsi web client is with token auth: SASL ANONYMOUS, the JWT and the
 * room in the WebSocket URL's query (?room=...&token=...), verified by
 * Prosody's token modules.
 *
 * Imported ONLY by the standalone worker (scripts/jibri-stop-worker.ts),
 * never by the Next.js app; tests pass a fake client (loadClient).
 *
 * - No reconnect: the reconnect plugin is stopped at once.
 * - No stream management (XEP-0198): the <sm/> stream feature is removed
 *   before negotiation, so Prosody never keeps a hibernating session (with
 *   a lingering "moderator" occupant) after the socket closes.
 * - Bounded cleanup: close() waits for the library's stop (closing the XMPP
 *   stream, then the socket) at most stopTimeoutMs; if that hangs, the
 *   WebSocket itself is closed (forceClose). A connection that completes
 *   after its open timed out is closed the same way as soon as it is up.
 * - Errors are replaced by fixed messages: @xmpp/websocket's errors can
 *   include the URL, which carries the token.
 */

import type { IqAnswer, IqReply, XmlNode, XmppSession, XmppTransport } from "@/lib/jibri-control";

const NS_STREAMS = "http://etherx.jabber.org/streams";
const NS_SM = "urn:xmpp:sm:3";
const NS_STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";

/** The structural subset of an @xmpp/xml (ltx) element used here. */
type LtxElement = {
  name: string;
  attrs: Record<string, string>;
  children: (LtxElement | string)[];
  is(name: string, xmlns?: string): boolean;
};

/** The subset of an @xmpp/client instance used here (a fake in tests). */
export type XmppClientLike = {
  reconnect: { stop(): void };
  middleware: { use(handler: (ctx: { stanza: LtxElement }, next: () => Promise<unknown>) => unknown): void };
  iqCaller: { request(stanza: LtxElement, timeoutMs?: number): Promise<unknown> };
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  send(stanza: LtxElement): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  prependListener(event: string, listener: (element: LtxElement) => void): unknown;
  /** The JID the server bound once online (@xmpp/client sets it; start() also resolves with it). */
  jid?: unknown;
  /** @xmpp/websocket's socket wrapper (its `socket`: the WebSocket). */
  socket?: { end(): void; socket?: { close(code?: number): void } | null } | null;
};

export type XmppClientModule = {
  client(options: { service: string; domain: string }): XmppClientLike;
  xml(name: string, attrs?: Record<string, string>, ...children: (LtxElement | string)[]): LtxElement;
};

export type XmppTransportOptions = {
  /** Loads @xmpp/client (tests: a fake). */
  loadClient?: () => Promise<XmppClientModule>;
  /** How long close() waits for the library's stop before forcing the socket closed. */
  stopTimeoutMs?: number;
};

export function toXmlNode(element: LtxElement): XmlNode {
  return {
    name: element.name,
    attrs: { ...element.attrs },
    children: element.children.map(c => (typeof c === "string" ? c : toXmlNode(c))),
  };
}

/** Removes the stream-management feature from a <stream:features/> element (in place). */
export function stripStreamManagement(element: LtxElement): void {
  if (!element.is("features", NS_STREAMS)) return;

  element.children = element.children.filter(c => typeof c === "string" || !c.is("sm", NS_SM));
}

/** Builds the WebSocket URL with the room and the token (never logged). */
export function buildWebSocketUrl(websocketUrl: string, room: string, token: string): string {
  const url = new URL(websocketUrl);

  if (url.protocol !== "wss:") throw new Error("XMPP WebSocket URL must use wss:");

  url.searchParams.set("room", room);
  url.searchParams.set("token", token);

  return url.toString();
}

/** Closes the WebSocket directly (never throws): the library's stop did not finish. */
export function forceClose(xmpp: XmppClientLike): void {
  const wrapper = xmpp.socket;

  try {
    wrapper?.socket?.close(1000);
  } catch {
    /* already closing */
  }

  try {
    wrapper?.end();
  } catch {
    /* already detached */
  }
}

/** Whether `promise` settled (either way) within `ms`. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms));

    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      }
    );
  });
}

/** Stops the client within `ms`; past that the socket is forced closed. Never throws. */
async function shutdown(xmpp: XmppClientLike, ms: number): Promise<void> {
  let stopping: Promise<unknown>;

  try {
    stopping = Promise.resolve(xmpp.stop());
  } catch {
    stopping = Promise.resolve();
  }

  stopping.catch(() => {});

  if (!(await settlesWithin(stopping, ms))) forceClose(xmpp);
}

export function createXmppWebSocketTransport(options: XmppTransportOptions = {}): XmppTransport {
  const loadClient = options.loadClient ?? (() => import("@xmpp/client") as unknown as Promise<XmppClientModule>);
  const stopTimeoutMs = options.stopTimeoutMs ?? 3_000;

  return {
    async open({ websocketUrl, domain, room, token, timeoutMs }): Promise<XmppSession> {
      const { client, xml } = await loadClient();

      const service = buildWebSocketUrl(websocketUrl, room, token);
      const xmpp = client({ service, domain });

      xmpp.reconnect.stop();
      xmpp.prependListener("element", stripStreamManagement);
      // Errors carry no detail out of here (the URL holds the token).
      xmpp.on("error", () => {});

      const fromNode = (node: XmlNode): LtxElement =>
        xml(node.name, node.attrs, ...node.children.map(c => (typeof c === "string" ? c : fromNode(c))));

      const stanzaListeners: ((stanza: XmlNode) => void)[] = [];
      const closeListeners: (() => void)[] = [];
      let iqHandler: ((iq: XmlNode) => IqReply) | null = null;
      let closed = false;

      const markClosed = () => {
        if (closed) return;
        closed = true;
        closeListeners.forEach(listener => listener());
      };

      xmpp.on("offline", markClosed);
      xmpp.on("disconnect", markClosed);

      xmpp.on("stanza", (stanza: LtxElement) => {
        if (stanza.name === "presence" || stanza.name === "message") {
          const node = toXmlNode(stanza);
          stanzaListeners.forEach(listener => listener(node));
        }
      });

      // IQ requests: @xmpp/iq's callee answers what this returns (an error
      // element becomes an error reply; nothing: service-unavailable).
      xmpp.middleware.use(async (ctx, next) => {
        const { stanza } = ctx;

        if (stanza.name !== "iq" || (stanza.attrs.type !== "get" && stanza.attrs.type !== "set") || !iqHandler) {
          return next();
        }

        const reply = iqHandler(toXmlNode(stanza));

        if (reply.type === "error") {
          return xml("error", { type: reply.errorType }, xml(reply.condition, { xmlns: NS_STANZAS }));
        }

        return reply.payload ? fromNode(reply.payload) : true;
      });

      let starting: Promise<unknown>;

      try {
        starting = Promise.resolve(xmpp.start());
      } catch {
        starting = Promise.reject(new Error("XMPP connection failed"));
      }

      starting.catch(() => {});

      if (!(await settlesWithin(starting, timeoutMs))) {
        // Timed out: stop it now, and again if it still comes up later.
        markClosed();
        starting.then(() => shutdown(xmpp, stopTimeoutMs), () => {});
        await shutdown(xmpp, stopTimeoutMs);
        throw new Error("XMPP connection failed");
      }

      let address: unknown;

      try {
        address = await starting;
      } catch {
        await shutdown(xmpp, stopTimeoutMs);
        throw new Error("XMPP connection failed");
      }

      // The server's own statement of who we are (its domain identifies the server).
      const bound = address ?? xmpp.jid;
      const boundJid = bound === undefined || bound === null ? null : String(bound);

      return {
        boundJid,
        async send(stanza) {
          if (closed) throw new Error("XMPP connection closed");
          await xmpp.send(fromNode(stanza)).catch(() => {
            throw new Error("XMPP send failed");
          });
        },
        async sendIq(iq, ms): Promise<IqAnswer> {
          if (closed) throw new Error("XMPP connection closed");

          try {
            await xmpp.iqCaller.request(fromNode(iq), ms);
            return { type: "result" };
          } catch (error) {
            const condition = (error as { condition?: unknown })?.condition;

            if ((error as { name?: string })?.name === "StanzaError" && typeof condition === "string") {
              return { type: "error", condition };
            }

            throw new Error("XMPP request failed");
          }
        },
        onStanza(listener) {
          stanzaListeners.push(listener);
        },
        onIqRequest(handler) {
          iqHandler = handler;
        },
        onClose(listener) {
          if (closed) listener();
          else closeListeners.push(listener);
        },
        async close() {
          await shutdown(xmpp, stopTimeoutMs);
          markClosed();
        },
      };
    },
  };
}
