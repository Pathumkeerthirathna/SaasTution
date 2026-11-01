"use client";

import { useEffect, useRef, useState } from "react";

import { createVisitHistorySync, type VisitHistory, type VisitHistorySync } from "../session-visit-history";

/**
 * Teacher only: the current session's visits per student (see
 * session-visit-history.ts), kept current from the existing attendance
 * endpoint and the existing teacher event stream (/api/sessions/[id]/events).
 *
 * Runs only while `enabled` (the teacher view shows: the only place the
 * history is displayed), so the teacher's page holds this third event stream
 * (beside live-updates and participant-map) only while it is used: browsers
 * allow few HTTP/1.1 connections per site. `generation` changes (a new Jitsi
 * conference) fetch again. Everything is closed on unmount / disable.
 */
export default function useSessionVisitHistory({
  sessionId,
  enabled,
  generation,
}: {
  sessionId: string | undefined;
  enabled: boolean;
  generation: number;
}): VisitHistory {
  const [history, setHistory] = useState<VisitHistory>(() => new Map());
  const syncRef = useRef<VisitHistorySync | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      return;
    }

    const sync = createVisitHistorySync({
      fetchHistory: async (signal) => {
        const response = await fetch(`/api/sessions/${sessionId}/attendance`, { cache: "no-store", signal });

        if (!response.ok) {
          throw new Error(`attendance ${response.status}`);
        }

        return ((await response.json()) as { data?: unknown }).data;
      },
      openEvents: ({ onOpen, onUpdate, onError }) => {
        const source = new EventSource(`/api/sessions/${sessionId}/events`);

        source.addEventListener("open", onOpen);
        source.addEventListener("attendance-update", onUpdate);
        source.addEventListener("error", onError);

        return () => {
          source.removeEventListener("open", onOpen);
          source.removeEventListener("attendance-update", onUpdate);
          source.removeEventListener("error", onError);
          source.close();
        };
      },
      onHistory: setHistory,
    });

    syncRef.current = sync;
    sync.start();

    return () => {
      sync.stop();

      if (syncRef.current === sync) {
        syncRef.current = null;
      }
    };
  }, [enabled, sessionId]);

  // A new conference (reconnect, rejoin): fetch again. Not for the value the
  // sync started with (start() has just fetched).
  const lastGenerationRef = useRef(generation);

  useEffect(() => {
    if (generation !== lastGenerationRef.current) {
      lastGenerationRef.current = generation;
      syncRef.current?.refresh(true);
    }
  }, [generation]);

  return history;
}
