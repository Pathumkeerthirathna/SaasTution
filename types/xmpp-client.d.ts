/*
 * Minimal types for @xmpp/client (it ships none): only what
 * lib/jibri-xmpp-transport.ts uses.
 */

declare module "@xmpp/client" {
  type XmlElement = {
    name: string;
    attrs: Record<string, string>;
    children: (XmlElement | string)[];
    is(name: string, xmlns?: string): boolean;
  };

  type Middleware = (ctx: { stanza: XmlElement }, next: () => Promise<unknown>) => unknown;

  interface XmppClient {
    reconnect: { stop(): void };
    middleware: { use(handler: Middleware): void };
    iqCaller: { request(stanza: XmlElement, timeoutMs?: number): Promise<XmlElement> };
    /** Resolves with the bound JID once online. */
    start(): Promise<unknown>;
    /** The bound JID once online. */
    jid?: unknown;
    stop(): Promise<unknown>;
    send(stanza: XmlElement): Promise<void>;
    on(event: string, listener: (...args: never[]) => void): this;
    prependListener(event: string, listener: (element: XmlElement) => void): this;
  }

  export function client(options: { service: string; domain: string }): XmppClient;

  export function xml(
    name: string,
    attrs?: Record<string, string>,
    ...children: (XmlElement | string)[]
  ): XmlElement;
}
