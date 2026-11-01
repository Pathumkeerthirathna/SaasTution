/**
 * The teacher's classroom page reports its own lifecycle to
 * POST /api/sessions/[id]/teacher-departure/signal, so the server can stop
 * the YouTube Recording / Live once the teacher has really closed the tab
 * (lib/teacher-presence.ts has the server's rules).
 *
 * Every page (desktop or mobile):
 * - register, once when it loads: it becomes the teacher's current page (a
 *   refresh: the new page replaces the old one, cancelling its signal).
 * - heartbeat, every TEACHER_HEARTBEAT_MS while it lives: another open tab
 *   cancels the current page's pending signal. Stopped at pagehide, so a page
 *   that is going away never cancels anything.
 *
 * Desktop browsers only (lib/browser-form-factor.ts):
 * - pagehide with persisted === false: the page is being discarded. The
 *   browser cannot tell a closed tab from a refresh or a navigation away at
 *   that moment, so this is only a CLOSING signal: the server waits for its
 *   15 s reload-confirmation window, and a newly loaded classroom page (or
 *   another open tab) cancels it.
 * - pageshow with persisted === true after a closing signal: the page came
 *   back from the back/forward cache: RESUME withdraws the signal.
 *
 * Never a closing signal: mobile browsers (they do not fire pagehide
 * reliably when a tab is closed, and suspend / discard pages in ways it
 * cannot describe), pagehide into the back/forward cache, visibilitychange
 * (hidden), freezing, blur, losing the network, a navigation the classroom
 * starts and returns from (suppressNextDepartureSignal). A page that never
 * fires pagehide (a crash, a killed browser) sends nothing either: then
 * nothing is stopped. Delivery is best effort (sendBeacon, else fetch with
 * keepalive): a signal that never arrives stops nothing.
 *
 * Plain TypeScript (no React); JitsiClassroom installs it, tests drive it.
 */

import { isDesktopBrowser } from "@/lib/browser-form-factor";

export type DepartureSignalKind = "register" | "heartbeat" | "closing" | "resume";

type SignalBody = { kind: DepartureSignalKind; pageId: string };

type LifecycleTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/** Heartbeat interval; equals the server's TEACHER_PRESENCE_REFRESH_MS (lib/teacher-presence.ts). */
export const TEACHER_HEARTBEAT_MS = 10_000;

/** A random id for one classroom page instance (matches the server's format). */
export function createPageId(random: () => string = defaultRandomId): string {
  return random().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

function defaultRandomId() {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;

  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);

  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Sends a signal while the page is being torn down; true when the browser accepted it for delivery. */
export function sendDepartureSignal(url: string, body: SignalBody): boolean {
  const payload = JSON.stringify(body);

  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // text/plain: a "simple" request, sent with the login cookie, no preflight.
      if (navigator.sendBeacon(url, new Blob([payload], { type: "text/plain;charset=UTF-8" }))) {
        return true;
      }
    }

    if (typeof fetch === "function") {
      void fetch(url, {
        method: "POST",
        body: payload,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        credentials: "same-origin",
        keepalive: true,
      }).catch(() => {});

      return true;
    }
  } catch {
    // A page being torn down: nothing else to do.
  }

  return false;
}

/** Register / heartbeat from a live page: a normal request, failures retried by the next heartbeat. */
export function postPageSignal(url: string, body: SignalBody): void {
  if (typeof fetch !== "function") return;

  void fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    credentials: "same-origin",
  }).catch(() => {});
}

// Navigations the classroom itself starts and comes back from (the YouTube
// reconnect): the next pagehide is not a departure. Per page (window).
const suppression = globalThis as unknown as { slDepartureSignalSuppressed?: boolean };

/** The next pagehide of this page is a navigation that returns to the classroom: send no closing signal. */
export function suppressNextDepartureSignal() {
  suppression.slDepartureSignalSuppressed = true;
}

export function installTeacherDepartureSignal(options: {
  sessionId: string;
  pageId: string;
  target?: LifecycleTarget;
  /** Closing / resume, while the page is torn down or restored. */
  send?: (url: string, body: SignalBody) => boolean;
  /** Register / heartbeat, from the live page. */
  post?: (url: string, body: SignalBody) => void;
  /** Whether closing signals may be sent (default: a desktop browser). */
  isDesktop?: boolean;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}): () => void {
  const { sessionId, pageId } = options;
  const target = options.target ?? window;
  const send = options.send ?? sendDepartureSignal;
  const post = options.post ?? postPageSignal;
  const isDesktop = options.isDesktop ?? isDesktopBrowser(typeof navigator === "undefined" ? null : navigator);
  const startTimer = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const stopTimer = options.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/teacher-departure/signal`;

  // One closing signal per page lifetime (pagehide can fire more than once).
  let closingSent = false;
  let heartbeat: unknown = null;

  const startHeartbeat = () => {
    if (heartbeat === null) {
      heartbeat = startTimer(() => post(url, { kind: "heartbeat", pageId }), TEACHER_HEARTBEAT_MS);
    }
  };

  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      stopTimer(heartbeat);
      heartbeat = null;
    }
  };

  const onPageHide = (event: Event) => {
    // Going away (or into the back/forward cache): no more heartbeats.
    stopHeartbeat();

    if ((event as PageTransitionEvent).persisted) return;

    if (suppression.slDepartureSignalSuppressed) {
      suppression.slDepartureSignalSuppressed = false;
      return;
    }

    if (!isDesktop || closingSent) return;

    closingSent = send(url, { kind: "closing", pageId });
  };

  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;

    suppression.slDepartureSignalSuppressed = false;
    startHeartbeat();

    if (closingSent) {
      closingSent = false;
      send(url, { kind: "resume", pageId });
    } else {
      post(url, { kind: "heartbeat", pageId });
    }
  };

  post(url, { kind: "register", pageId });
  startHeartbeat();
  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("pageshow", onPageShow);

  return () => {
    stopHeartbeat();
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("pageshow", onPageShow);
  };
}
