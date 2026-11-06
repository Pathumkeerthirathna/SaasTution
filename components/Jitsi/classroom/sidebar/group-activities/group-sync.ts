"use client";

// Group Activities change pings inside the classroom page. The classroom's
// existing live-updates EventSource (JitsiClassroom.tsx) receives the
// server's "breakout-group" event and hands it here; the Group Activities
// panels listen and refetch. No second EventSource: the panels never open
// a connection of their own (they also refetch on focus and on a slow
// timer, for when the stream is interrupted).

export const GROUP_SYNC_EVENT = "slc:breakout-group";

export type GroupSyncDetail = {
  kind: "members" | "assignment" | "quiz";
  activityId: string | null;
  roomId: string | null;
  revision: number;
};

/** Called by the live-updates listener with the raw SSE data (ignored when malformed). */
export function dispatchGroupSync(raw: string): void {
  if (typeof window === "undefined") return;
  try {
    const data = JSON.parse(raw) as Partial<GroupSyncDetail>;
    if (data.kind !== "members" && data.kind !== "assignment" && data.kind !== "quiz") return;
    const detail: GroupSyncDetail = {
      kind: data.kind,
      activityId: typeof data.activityId === "string" ? data.activityId : null,
      roomId: typeof data.roomId === "string" ? data.roomId : null,
      revision: typeof data.revision === "number" ? data.revision : 0,
    };
    window.dispatchEvent(new CustomEvent<GroupSyncDetail>(GROUP_SYNC_EVENT, { detail }));
  } catch {
    /* ignore malformed payloads */
  }
}

/** Subscribes to the pings; returns the unsubscribe function. */
export function onGroupSync(listener: (detail: GroupSyncDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => listener((event as CustomEvent<GroupSyncDetail>).detail);
  window.addEventListener(GROUP_SYNC_EVENT, handler);
  return () => window.removeEventListener(GROUP_SYNC_EVENT, handler);
}
