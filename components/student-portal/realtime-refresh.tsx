"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { useStudentLiveEvent } from "@/components/student-portal/use-student-live-events";

type LiveEventName = "counts-stale" | "sessions" | "broadcasts";

const NOOP = () => {};

/**
 * Drop-in realtime refresher for server-rendered student pages.
 *
 * Calls `router.refresh()` — which re-runs the page's server component and
 * refetches its data — whenever the shared student SSE stream emits one of the
 * requested events. Debounced so a burst of changes triggers a single refresh.
 *
 * Purely additive: the page's normal server render is untouched; this only adds
 * an extra, silent refresh trigger. Renders nothing.
 */
export function RealtimeRefresh({
  events = ["counts-stale"],
  debounceMs = 300,
}: {
  events?: LiveEventName[];
  debounceMs?: number;
}) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bump = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => router.refresh(), debounceMs);
  };

  // Hooks must run unconditionally; subscribe to all three and no-op the
  // events this instance did not ask for.
  useStudentLiveEvent("counts-stale", events.includes("counts-stale") ? bump : NOOP);
  useStudentLiveEvent("sessions", events.includes("sessions") ? bump : NOOP);
  useStudentLiveEvent("broadcasts", events.includes("broadcasts") ? bump : NOOP);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  return null;
}
