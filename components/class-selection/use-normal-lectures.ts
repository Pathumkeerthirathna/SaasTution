"use client";

/*
 * A class's NORMAL lectures for a lecture selector (GET /api/lectures?classId=,
 * which never returns a class's default lecture), newest first, one page at a
 * time. Changing the class starts again from page 1; an older response (a
 * previous class or page) never replaces the current one (its request is
 * aborted and its answer ignored).
 */

import { useCallback, useEffect, useState } from "react";

export type NormalLecture = { id: string; title: string; date: string };

export type NormalLecturesLoad =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; items: NormalLecture[]; hasNextPage: boolean };

export const NORMAL_LECTURES_PAGE_SIZE = 100;

/** One page of a class's normal lectures, newest first (the existing lecture API). */
export function normalLecturesUrl(classId: string, page: number): string {
  const query = new URLSearchParams({ classId, page: String(page), pageSize: String(NORMAL_LECTURES_PAGE_SIZE), sortOrder: "desc" });
  return `/api/lectures?${query.toString()}`;
}

const LECTURE_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Colombo" });

/** "Title · 24 Nov 2026" (Sri Lankan date). */
export function normalLectureLabel(lecture: NormalLecture): string {
  const ms = Date.parse(lecture.date);
  return Number.isNaN(ms) ? lecture.title : `${lecture.title} · ${LECTURE_DATE.format(new Date(ms))}`;
}

/** The lectures of `classId` (null: none selected), with "load older" and "try again". */
export function useNormalLectures(classId: string | null) {
  const [lectures, setLectures] = useState<NormalLecturesLoad | null>(classId ? { state: "loading" } : null);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [loadedClassId, setLoadedClassId] = useState(classId);

  // A new class: start again from its first page (during render, so no stale page is requested).
  if (loadedClassId !== classId) {
    setLoadedClassId(classId);
    setPage(1);
    setLectures(classId ? { state: "loading" } : null);
  }

  useEffect(() => {
    if (!classId) {
      setLectures(null);
      return;
    }
    const controller = new AbortController();
    if (page === 1) setLectures({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(normalLecturesUrl(classId, page), { cache: "no-store", signal: controller.signal });
        const payload = (await response.json().catch(() => null)) as {
          success?: boolean;
          data?: NormalLecture[];
          error?: { message?: string };
          pagination?: { hasNextPage?: boolean };
        } | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !payload?.success) {
          setLectures({
            state: "error",
            message: response.status === 401 ? "Your session has ended. Please sign in again." : payload?.error?.message ?? "Could not load the lectures of this class.",
          });
          return;
        }
        const items = (payload.data ?? []).map((l) => ({ id: l.id, title: l.title, date: l.date }));
        setLectures((previous) => ({
          state: "ready",
          items: page > 1 && previous?.state === "ready" ? [...previous.items, ...items] : items,
          hasNextPage: Boolean(payload.pagination?.hasNextPage),
        }));
      } catch {
        if (!controller.signal.aborted) setLectures({ state: "error", message: "Could not load the lectures of this class." });
      }
    })();
    return () => controller.abort();
  }, [classId, page, attempt]);

  const loadOlder = useCallback(() => setPage((p) => p + 1), []);
  const retry = useCallback(() => {
    setPage(1);
    setAttempt((n) => n + 1);
  }, []);

  return { lectures: classId ? lectures : null, loadOlder, retry };
}
