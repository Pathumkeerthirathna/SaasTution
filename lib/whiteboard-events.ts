import { EventEmitter } from "node:events";

import type { WhiteboardLiveUpdate, WhiteboardScene } from "@/types/whiteboard";

/**
 * Live whiteboard fan-out: teacher -> students inside one class session.
 *
 * This is deliberately separate from `lib/session-events.ts` and from the
 * database. Drawing changes are only ever held in memory and pushed over SSE;
 * a whiteboard is written to PostgreSQL only when the teacher saves it.
 *
 * NOTE: like the other session event buses this is an in-process EventEmitter,
 * so it only fans out within a single Node process. A multi-instance deployment
 * would need Redis pub/sub (or similar) as the transport behind the same API.
 */

const LIVE_EVENT = "whiteboard-live";
const RETAIN_MS = 12 * 60 * 60 * 1000;

type LiveState = { seq: number; scene: WhiteboardScene; updatedAt: number };

const globalForWhiteboard = globalThis as unknown as {
  whiteboardEventBus?: EventEmitter;
  whiteboardLiveState?: Map<string, LiveState>;
};

const bus =
  globalForWhiteboard.whiteboardEventBus ??
  new EventEmitter({ captureRejections: false });

bus.setMaxListeners(500);

const liveState = globalForWhiteboard.whiteboardLiveState ?? new Map<string, LiveState>();

if (!globalForWhiteboard.whiteboardEventBus) {
  globalForWhiteboard.whiteboardEventBus = bus;
}

if (!globalForWhiteboard.whiteboardLiveState) {
  globalForWhiteboard.whiteboardLiveState = liveState;
}

function pruneOldSessions(now: number) {
  liveState.forEach((state, sessionId) => {
    if (now - state.updatedAt > RETAIN_MS) {
      liveState.delete(sessionId);
    }
  });
}

/** Stores the latest scene for the session and pushes it to every subscriber. */
export function publishWhiteboardScene(sessionId: string, scene: WhiteboardScene) {
  const now = Date.now();
  pruneOldSessions(now);

  const seq = (liveState.get(sessionId)?.seq ?? 0) + 1;
  liveState.set(sessionId, { seq, scene, updatedAt: now });

  const payload: WhiteboardLiveUpdate = {
    sessionId,
    seq,
    scene,
    occurredAt: new Date(now).toISOString(),
  };

  bus.emit(LIVE_EVENT, payload);
}

/** Latest scene for a session (so students who join late see the current board). */
export function getLatestWhiteboardScene(sessionId: string): WhiteboardLiveUpdate | null {
  const state = liveState.get(sessionId);

  if (!state) {
    return null;
  }

  return {
    sessionId,
    seq: state.seq,
    scene: state.scene,
    occurredAt: new Date(state.updatedAt).toISOString(),
  };
}

export function subscribeWhiteboardScene(
  sessionId: string,
  listener: (payload: WhiteboardLiveUpdate) => void
) {
  const wrapped = (payload: WhiteboardLiveUpdate) => {
    if (payload.sessionId !== sessionId) {
      return;
    }

    // One broken SSE stream must never break the emit for the others.
    try {
      listener(payload);
    } catch {
      /* ignore a failing subscriber */
    }
  };

  bus.on(LIVE_EVENT, wrapped);

  return () => {
    bus.off(LIVE_EVENT, wrapped);
  };
}
