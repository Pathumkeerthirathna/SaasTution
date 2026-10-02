"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ClassroomStudent, JitsiParticipant } from "../types";

/**
 * "normal": Jitsi picks which student cameras the teacher receives (no override).
 * "exam":   the teacher receives only the cameras of the students on the current page.
 */
export type ReceiveMode = "normal" | "exam";

export const MONITORING_PAGE_SIZES = [5, 10, 20] as const;

const DEFAULT_PAGE_SIZE: number = MONITORING_PAGE_SIZES[0];

export type CameraMonitoringController = {
  mode: ReceiveMode;
  setMode: (mode: ReceiveMode) => void;

  pageSize: number;
  pageSizeOptions: readonly number[];
  setPageSize: (pageSize: number) => void;

  /** Human-readable page number (1-based); 0 when nobody is present. */
  page: number;
  pageCount: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  goToPreviousPage: () => void;
  goToNextPage: () => void;

  /** Class students live in this conference right now, in roster order. */
  presentStudents: ClassroomStudent[];
  /** The students on the current page. */
  pageStudents: ClassroomStudent[];
  /** 1-based roster position of the first / last student on the current page (0 when empty). */
  pageRangeStart: number;
  pageRangeEnd: number;
  activeStudentIds: string[];
  activeParticipantIds: string[];
};

type Options = {
  /** Teacher only; for anyone else the hook never sends a receive set. */
  enabled: boolean;
  /**
   * Increases every time the teacher's Jitsi conference is joined (first join,
   * rejoin, or a remounted Jitsi iframe). 0 = not joined yet: nothing is sent
   * then, since the Jitsi controls are not mounted and the set would be lost.
   */
  conferenceGeneration: number;
  /** Class roster, already in roster order. */
  classStudents: ClassroomStudent[];
  /** studentId -> Jitsi participantId (Phase 1 participant-map SSE). */
  participantMap: Record<string, string>;
  /** Who is live in the teacher's conference right now. */
  participants: JitsiParticipant[];
  /** Phase 1 receive-set control: participant IDs, or null for no override. */
  setReceiveSet: (participantIds: string[] | null) => void;
  /** Monitoring grid (display only): participant IDs to show, or null to hide it. */
  setMonitorView: (participantIds: string[] | null) => void;
};

/**
 * Teacher-side camera monitoring: pages through the present students and, in
 * exam mode, tells the teacher's Jitsi iframe to receive only the cameras of
 * the current page. Receive-side only — students are never muted or changed.
 */
export default function useCameraMonitoring({
  enabled,
  conferenceGeneration,
  classStudents,
  participantMap,
  participants,
  setReceiveSet,
  setMonitorView,
}: Options): CameraMonitoringController {
  const [mode, setMode] = useState<ReceiveMode>("normal");
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  // Zero-based; may point past the end after students leave, so it is always
  // read through `pageIndex` below, which is clamped to the valid range.
  const [requestedPageIndex, setRequestedPageIndex] = useState(0);

  // Present = class student -> mapped participant ID -> that ID is live in the
  // conference right now. The map keeps students who already left (and IDs from
  // other rooms), so the live intersection is what makes someone present.
  // Display names are never used for this.
  const presentStudents = useMemo(() => {
    const liveIds = new Set(participants.map((participant) => participant.participantId));

    return classStudents.filter((student) => {
      const participantId = participantMap[student.studentId];

      return Boolean(participantId) && liveIds.has(participantId);
    });
  }, [classStudents, participantMap, participants]);

  const pageCount = Math.ceil(presentStudents.length / pageSize);
  const pageIndex = Math.min(requestedPageIndex, Math.max(pageCount - 1, 0));

  const pageStudents = useMemo(
    () => presentStudents.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [presentStudents, pageIndex, pageSize]
  );

  const activeStudentIds = useMemo(
    () => pageStudents.map((student) => student.studentId),
    [pageStudents]
  );

  const activeParticipantIds = useMemo(
    () => pageStudents.map((student) => participantMap[student.studentId]),
    [pageStudents, participantMap]
  );

  // Keep the stored page in range once students leave, so going back to a
  // larger class later does not jump to a stale page.
  useEffect(() => {
    if (requestedPageIndex !== pageIndex) {
      setRequestedPageIndex(pageIndex);
    }
  }, [requestedPageIndex, pageIndex]);

  const setPageSize = useCallback(
    (nextPageSize: number) => {
      if (!Number.isInteger(nextPageSize) || nextPageSize <= 0) {
        return;
      }

      // Stay on the page that contains the first student currently shown.
      setRequestedPageIndex(Math.floor((pageIndex * pageSize) / nextPageSize));
      setPageSizeState(nextPageSize);
    },
    [pageIndex, pageSize]
  );

  const goToPreviousPage = useCallback(() => {
    setRequestedPageIndex(Math.max(pageIndex - 1, 0));
  }, [pageIndex]);

  const goToNextPage = useCallback(() => {
    setRequestedPageIndex(Math.min(pageIndex + 1, Math.max(pageCount - 1, 0)));
  }, [pageIndex, pageCount]);

  // ---------------------------------------------------------------------------
  // Receive-set sync. Phase 1 bumps its epoch on every setReceiveSet call, so
  // it is only called when the effective receive set actually changes, not on
  // every render. Custom.js starts with no override, which is what "normal"
  // means, so nothing is sent until the teacher switches to exam mode.
  //
  // A new conference generation means a (possibly new) Jitsi instance that may
  // not have the current set, e.g. after JitsiMeeting remounted while this
  // hook stayed mounted. In exam mode the current set is then sent once even
  // though the key is unchanged; in normal mode nothing is needed, because a
  // new Jitsi instance already starts with no override.
  //
  // The monitoring grid always shows exactly the received set, so it is sent
  // right after it, with the same key and the same duplicate protection
  // (null = grid hidden, which is also how a new Jitsi instance starts).
  // ---------------------------------------------------------------------------
  const lastSentKeyRef = useRef("normal");
  const syncedGenerationRef = useRef(0);
  const setReceiveSetRef = useRef(setReceiveSet);
  setReceiveSetRef.current = setReceiveSet;
  const setMonitorViewRef = useRef(setMonitorView);
  setMonitorViewRef.current = setMonitorView;

  const receiveKey =
    mode === "exam" ? `exam:${activeParticipantIds.join(",")}` : "normal";

  useEffect(() => {
    if (!enabled || conferenceGeneration === 0) {
      return;
    }

    const isNewConference = conferenceGeneration !== syncedGenerationRef.current;
    syncedGenerationRef.current = conferenceGeneration;

    const mustResend = isNewConference && mode === "exam";

    if (!mustResend && receiveKey === lastSentKeyRef.current) {
      return;
    }

    lastSentKeyRef.current = receiveKey;

    const participantIds = mode === "exam" ? activeParticipantIds : null;
    setReceiveSetRef.current(participantIds);
    setMonitorViewRef.current(participantIds);
  },[enabled, conferenceGeneration, receiveKey, mode, activeParticipantIds]);

  return {
    mode,
    setMode,
    pageSize,
    pageSizeOptions: MONITORING_PAGE_SIZES,
    setPageSize,
    page: pageCount === 0 ? 0 : pageIndex + 1,
    pageCount,
    canGoPrevious: pageIndex > 0,
    canGoNext: pageIndex < pageCount - 1,
    goToPreviousPage,
    goToNextPage,
    presentStudents,
    pageStudents,
    pageRangeStart: pageStudents.length === 0 ? 0 : pageIndex * pageSize + 1,
    pageRangeEnd: pageIndex * pageSize + pageStudents.length,
    activeStudentIds,
    activeParticipantIds,
  };
}
