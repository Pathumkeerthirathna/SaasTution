"use client";

import { useEffect, useRef } from "react";

// One shared EventSource to `/api/student/live/stream` for the whole student
// portal. The header bell is always mounted, and the dashboard adds several
// listeners on top — a connection each would blow past the browser's per-origin
// limit on the HTTP/1.1 dev server. Components subscribe to a named SSE event
// through this hook and the singleton fans it out.

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
  source = new EventSource("/api/student/live/stream");
  for (const eventName of subscribers.keys()) attach(eventName);
}

function disconnect() {
  source?.close();
  source = null;
  domListeners.clear();
}

/**
 * Run `handler` whenever the shared student SSE stream emits `eventName`
 * (e.g. `"counts-stale"`). The handler may change every render — only
 * `eventName` re-subscribes.
 */
export function useStudentLiveEvent(eventName: string, handler: LiveEventHandler) {
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
 * Re-run `refetch` whenever the server signals that this student's data changed
 * (`"counts-stale"`). Calls are debounced so a burst of changes (e.g. a teacher
 * bulk-adding quizzes) triggers a single refetch. `refetch` may change every
 * render; the latest one is always used. Additive only — pages keep their
 * existing initial load and filter-driven refetch untouched.
 */
export function useStudentLiveRefetch(refetch: () => void, debounceMs = 300) {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useStudentLiveEvent("counts-stale", () => {
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
