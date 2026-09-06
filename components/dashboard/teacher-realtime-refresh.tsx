"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { useTeacherLiveEvent } from "@/components/dashboard/use-teacher-live-events";

type LiveEventName = "counts-stale" | "sessions" | "broadcasts";

const NOOP = () => {};

/**
 * Drop-in realtime refresher for the server-rendered teacher dashboard page.
 *
 * Calls `router.refresh()` — which re-runs the page's server component and
 * refetches its data — whenever the shared teacher SSE stream emits one of
 * the requested events. Debounced so a burst of changes triggers a single
 * refresh. Mirrors components/student-portal/realtime-refresh.tsx.
 *
 * Purely additive: the page's normal server render is untouched; this only
 * adds an extra, silent refresh trigger. Renders nothing.
 */
export function TeacherRealtimeRefresh({
  events = ["counts-stale"],
  debounceMs = 1000,
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
  useTeacherLiveEvent("counts-stale", events.includes("counts-stale") ? bump : NOOP);
  useTeacherLiveEvent("sessions", events.includes("sessions") ? bump : NOOP);
  useTeacherLiveEvent("broadcasts", events.includes("broadcasts") ? bump : NOOP);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  return null;
}
