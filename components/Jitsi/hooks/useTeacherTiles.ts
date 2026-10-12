"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ClassroomStudent } from "../types";
import {
  DEFAULT_TEACHER_TILES_PAGE_SIZE,
  TEACHER_TILES_PAGE_SIZES,
  computeTilesPage,
  isTeacherTilesPageSize,
  pageIndexAfterPageSizeChange,
  stepPageIndex,
} from "../teacher-tiles-paging.mjs";

/**
 * How the teacher's Normal mode view shows the class (custom.js):
 * "list":  the stage plus the participant filmstrip (as before).
 * "tiles": the students of the current page in a grid, with an enlarged-video
 *          panel; the camera rotation then covers only that page.
 */
export type TeacherViewLayout = "list" | "tiles";

/** What the teacher's Jitsi iframe needs for the Tiles view (SL_TEACHER_TILES). */
export type TeacherTilesState = {
  layout: TeacherViewLayout;
  /** The current page's Jitsi participant IDs, in roster order. */
  participantIds: string[];
  /** 1-based; 0 when nobody is present. */
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  /** The selected Tiles page size (shown in the iframe's settings menu). */
  pageSize: number;
};

export type TeacherTilesController = TeacherTilesState & {
  setLayout: (layout: TeacherViewLayout) => void;
  pageSizeOptions: readonly number[];
  setPageSize: (pageSize: number) => void;
  canGoPrevious: boolean;
  canGoNext: boolean;
  goToPreviousPage: () => void;
  goToNextPage: () => void;
};

type Options = {
  /** Teacher only. */
  enabled: boolean;
  /** Class students live in the conference, in roster order (useCameraMonitoring). */
  presentStudents: ClassroomStudent[];
  /** studentId -> Jitsi participantId (participant-map SSE). */
  participantMap: Record<string, string>;
};

const LAYOUT_STORAGE_KEY = "sl-classroom-teacher-view-layout";
const PAGE_SIZE_STORAGE_KEY = "sl-classroom-teacher-tiles-page-size";

/**
 * Teacher Tiles view: layout (List / Tiles), page size and paging over the
 * present students in roster order. A reconnecting student keeps their roster
 * place (the participant map gives their new participant ID). Exam Mode keeps
 * its own paging in useCameraMonitoring; this does not change it.
 */
export default function useTeacherTiles({
  enabled,
  presentStudents,
  participantMap,
}: Options): TeacherTilesController {
  const [layout, setLayoutState] = useState<TeacherViewLayout>("list");
  const [pageSize, setPageSizeState] = useState<number>(DEFAULT_TEACHER_TILES_PAGE_SIZE);
  // Zero-based; may point past the end after students leave, so it is always
  // read through the clamped page below.
  const [requestedPageIndex, setRequestedPageIndex] = useState(0);

  // The teacher's last choices, read once on mount.
  useEffect(() => {
    try {
      const storedLayout = localStorage.getItem(LAYOUT_STORAGE_KEY);
      const storedPageSize = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));

      if (storedLayout === "list" || storedLayout === "tiles") {
        setLayoutState(storedLayout);
      }

      if (isTeacherTilesPageSize(storedPageSize)) {
        setPageSizeState(storedPageSize);
      }
    } catch {
      /* storage unavailable: defaults */
    }
  }, []);

  const ids = useMemo(
    () =>
      presentStudents
        .map((student) => participantMap[student.studentId])
        .filter((participantId): participantId is string => Boolean(participantId)),
    [presentStudents, participantMap]
  );

  const current = useMemo(
    () => computeTilesPage({ ids, pageSize, requestedPageIndex }),
    [ids, pageSize, requestedPageIndex]
  );

  // The latest values for the paging actions below, which update state from
  // the previous state (never a rendered snapshot): two quick presses, from
  // the sidebar or the grid, move two pages.
  const totalRef = useRef(ids.length);
  totalRef.current = ids.length;
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  // Keep the stored page in range once students leave.
  useEffect(() => {
    if (requestedPageIndex !== current.pageIndex) {
      setRequestedPageIndex(current.pageIndex);
    }
  }, [requestedPageIndex, current.pageIndex]);

  const setLayout = useCallback(
    (next: TeacherViewLayout) => {
      if (!enabled || (next !== "list" && next !== "tiles")) {
        return;
      }

      setLayoutState(next);

      try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, next);
      } catch {
        /* private mode: the choice just won't persist */
      }
    },
    [enabled]
  );

  const setPageSize = useCallback(
    (next: number) => {
      if (!enabled || !isTeacherTilesPageSize(next)) {
        return;
      }

      const previousSize = pageSizeRef.current;
      const previousLast = Math.max(Math.ceil(totalRef.current / previousSize) - 1, 0);

      pageSizeRef.current = next;

      // Stay on the page that holds the first student currently shown.
      setRequestedPageIndex((requested) =>
        pageIndexAfterPageSizeChange(Math.min(requested, previousLast), previousSize, next)
      );
      setPageSizeState(next);

      try {
        localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next));
      } catch {
        /* private mode */
      }
    },
    [enabled]
  );

  const step = useCallback((action: "previous" | "next") => {
    const pageCount = Math.ceil(totalRef.current / pageSizeRef.current);

    setRequestedPageIndex((requested) => stepPageIndex(requested, pageCount, action));
  }, []);

  const goToPreviousPage = useCallback(() => step("previous"), [step]);

  const goToNextPage = useCallback(() => step("next"), [step]);

  return {
    layout,
    setLayout,
    pageSize,
    pageSizeOptions: TEACHER_TILES_PAGE_SIZES,
    setPageSize,
    participantIds: current.pageIds,
    page: current.page,
    pageCount: current.pageCount,
    rangeStart: current.rangeStart,
    rangeEnd: current.rangeEnd,
    total: current.total,
    canGoPrevious: current.pageIndex > 0,
    canGoNext: current.pageIndex < current.pageCount - 1,
    goToPreviousPage,
    goToNextPage,
  };
}
