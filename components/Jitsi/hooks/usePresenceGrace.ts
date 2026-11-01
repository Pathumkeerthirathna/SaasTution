"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { applyPresenceGrace, type StudentLocation } from "../participant-identity.mjs";

type GraceMemory = Map<string, { location: StudentLocation; lastSeenAt: number }>;

/**
 * Display only (the registers and the attendance panel): a student who just
 * vanished keeps their last location for `graceMs`, so a reconnect or a
 * breakout-room switch (new participant ID, not registered yet) does not
 * flicker them to "absent". Never used for actions or for camera monitoring.
 */
export default function usePresenceGrace(
  locations: Map<string, StudentLocation>,
  graceMs: number
): Map<string, StudentLocation> {
  const memoryRef = useRef<GraceMemory>(new Map());
  // Bumped when a grace period ends, to recompute without new input.
  const [clock, setClock] = useState(0);

  const result = useMemo(() => {
    void clock;

    return applyPresenceGrace(memoryRef.current, locations, Date.now(), graceMs);
  }, [locations, graceMs, clock]);

  useEffect(() => {
    memoryRef.current = result.memory;

    if (result.nextExpiryAt === null) {
      return;
    }

    const timer = setTimeout(
      () => setClock((value) => value + 1),
      Math.max(0, result.nextExpiryAt - Date.now()) + 50
    );

    return () => clearTimeout(timer);
  }, [result]);

  return result.display;
}
