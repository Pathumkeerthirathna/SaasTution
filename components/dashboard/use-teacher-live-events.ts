"use client";

import { useEffect, useRef } from "react";

// One shared EventSource to `/api/teacher/live/stream` for the whole teacher
// dashboard — several widgets subscribe, and a connection each would blow past
// the browser's per-origin limit on the HTTP/1.1 dev server. Components
// subscribe to a named SSE event through this hook and the singleton fans it
// out. Mirrors components/student-portal/use-student-live-events.ts exactly,
// just pointed at the teacher-scoped stream.

type LiveEventHandler = (event: MessageEvent) => void;

let source: EventSource | null = null;
let refCount = 0;
const subscribers = new Map<string, Set<LiveEventHandler>>();
const domListeners = new Map<string, EventListener>();

function attach(eventName: string) {
  if (!source || domListeners.has(eventName)) return;
  const listener: EventListener = (event) => {
    subscribers.get(eventName)?.forEach((handler) => handler(event as MessageEvent));
  };
  domListeners.set(eventName, listener);
  source.addEventListener(eventName, listener);
}

function connect() {
  if (source || typeof window === "undefined") return;
  source = new EventSource("/api/teacher/live/stream");
  for (const eventName of subscribers.keys()) attach(eventName);
}

function disconnect() {
  source?.close();
  source = null;
  domListeners.clear();
}

/**
 * Run `handler` whenever the shared teacher SSE stream emits `eventName`
 * (e.g. `"counts-stale"`, `"sessions"`, `"broadcasts"`). The handler may
 * change every render — only `eventName` re-subscribes.
 */
export function useTeacherLiveEvent(eventName: string, handler: LiveEventHandler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const trampoline: LiveEventHandler = (event) => handlerRef.current(event);

    let set = subscribers.get(eventName);
    if (!set) {
      set = new Set();
      subscribers.set(eventName, set);
    }
    set.add(trampoline);
    refCount += 1;

    connect();
    attach(eventName);

    return () => {
      set.delete(trampoline);
      if (set.size === 0) subscribers.delete(eventName);
      refCount -= 1;
      if (refCount <= 0) disconnect();
    };
  }, [eventName]);
}

/**
 * Re-run `refetch` whenever the server signals that this teacher's dashboard
 * data changed (`"counts-stale"`). Calls are debounced so a burst of changes
 * (e.g. several students submitting at once) triggers a single refetch.
 * `refetch` may change every render; the latest one is always used.
 */
export function useTeacherLiveRefetch(refetch: () => void, debounceMs = 300) {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useTeacherLiveEvent("counts-stale", () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => refetchRef.current(), debounceMs);
  });

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );
}
